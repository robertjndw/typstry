//! The connection to the server.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use loro::{ExportMode, IdSpan, LoroDoc, VersionVector};
use loro_protocol::{BatchId, UpdateStatusCode};
use typstry_wire::crypto::{CryptoError, DocKeys, RecordSigner};
use typstry_wire::elo::{Record, SealedRecord, decode_container, encode_container, pack_ranges};

use crate::api::Permission;
use crate::client::{Client, Event, Joined};
use crate::link::ws_url;

use super::membership::NO_KEYS;
use super::{RemoteEvent, Session, SyncError};

/// Same as the adaptor's `CONTAINER_BUDGET`: one container per send stays
/// well under the server's limit for a reassembled update.
const CONTAINER_BUDGET: usize = 1024 * 1024;

/// Upload a compaction snapshot once the server holds this many deltas.
const COMPACT_AFTER_DELTAS: u64 = 200;

/// Delay before resending what the server refused for a passing reason.
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// How long a one-shot command waits for the server without any progress.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

const NOT_CONNECTED: &str = "not connected";

/// Per-connection sync state, the adaptor's fields.
pub(super) struct Conn {
    client: Client,
    /// Per peer, the end of the op range we believe the server stores.
    server: HashMap<u64, u64>,
    /// The server's coverage at join; caught up means covering it.
    target: VersionVector,
    deltas: u64,
    snapshot_sent: bool,
    /// Sent containers awaiting their ack.
    in_flight: HashMap<BatchId, InFlight>,
    retry_at: Option<Instant>,
    /// Per peer, the end of every op range the server sent us, including
    /// records we could not decrypt.
    seen: HashMap<u64, u64>,
    /// Records that did not decrypt, and the key id of the last one that
    /// was under another key.
    unreadable: u64,
    mismatched_key: Option<String>,
    decrypted_any: bool,
    /// A record came from a key generation newer than ours, so the keyring
    /// has to be fetched again, see [`Session::next_remote`].
    stale_keys: bool,
}

/// What an unacked container carried. A refused one is never resent as is:
/// rewinding `Conn::server` makes the next [`Conn::send_missing`] export
/// its ops again, so the bytes are not kept.
enum InFlight {
    /// Delta records, as the `(peer, start)` of each span.
    Deltas(Vec<(u64, u64)>),
    Snapshot,
}

/// What one container from the server held, besides its plaintexts.
#[derive(Default)]
struct Received {
    /// Per peer, the end of the op ranges that decrypted.
    readable: HashMap<u64, u64>,
    /// Per peer, the end of every op range, readable or not.
    seen: HashMap<u64, u64>,
    unreadable: u64,
    mismatched_key: Option<String>,
    stale_keys: bool,
}

impl Conn {
    fn new(client: Client, joined: Joined) -> Self {
        Self {
            client,
            server: ends(&joined.version).collect(),
            target: joined.version,
            deltas: joined.deltas,
            snapshot_sent: false,
            in_flight: HashMap::new(),
            retry_at: None,
            seen: HashMap::new(),
            unreadable: 0,
            mismatched_key: None,
            decrypted_any: false,
            stale_keys: false,
        }
    }

    /// See [`Session::caught_up`]; `have` is the doc's oplog version.
    fn caught_up(&self, have: &VersionVector) -> bool {
        if covers(have, &self.target) {
            return true;
        }
        self.unreadable > 0
            && self.target.iter().all(|(peer, &end)| {
                let have = end_of(have.get(peer).copied().unwrap_or(0));
                let seen = self.seen.get(peer).copied().unwrap_or(0);
                have.max(seen) >= end_of(end)
            })
    }

    /// The key id the project's records are under, if not one of them
    /// decrypted with ours.
    fn foreign_key(&self) -> Option<&str> {
        self.mismatched_key
            .as_deref()
            .filter(|_| !self.decrypted_any)
    }

    /// Whether every sent container was acked and no resend is due.
    fn settled(&self) -> bool {
        self.in_flight.is_empty() && self.retry_at.is_none()
    }

    /// The next event from the server, or None once a resend is due.
    /// Cancel safe.
    async fn next_event(&mut self) -> Option<Event> {
        match self.retry_at {
            Some(at) => tokio::select! {
                event = self.client.next_event() => Some(event),
                () = tokio::time::sleep_until(at.into()) => None,
            },
            None => Some(self.client.next_event().await),
        }
    }

    /// Takes in what a container from the server covered. `decrypted`:
    /// whether any of its records opened.
    fn received(&mut self, received: Received, decrypted: bool) {
        for (peer, end) in received.seen {
            raise(&mut self.seen, peer, end);
        }
        self.unreadable += received.unreadable;
        self.decrypted_any |= decrypted;
        self.stale_keys |= received.stale_keys;
        if received.mismatched_key.is_some() {
            self.mismatched_key = received.mismatched_key;
        }
    }

    /// Settles the container `batch`. Returns the status when the server
    /// refused a compaction snapshot, which only loses the compaction.
    fn on_ack(
        &mut self,
        batch: BatchId,
        status: UpdateStatusCode,
    ) -> anyhow::Result<Option<UpdateStatusCode>> {
        let Some(sent) = self.in_flight.remove(&batch) else {
            return Ok(None);
        };
        match (status, sent) {
            (UpdateStatusCode::Ok, InFlight::Deltas(spans)) => {
                self.deltas += spans.len() as u64;
                Ok(None)
            }
            (UpdateStatusCode::Ok, InFlight::Snapshot) => Ok(None),
            (
                UpdateStatusCode::RateLimited
                | UpdateStatusCode::FragmentTimeout
                | UpdateStatusCode::Unknown,
                sent,
            ) => {
                // The ops are still in the doc; forget that the server has
                // them so the retry sends them again. A snapshot needs no
                // rewind: maybe_compact only sends one after the deltas it
                // covers were acked.
                if let InFlight::Deltas(spans) = sent {
                    for (peer, start) in spans {
                        let known = self.server.entry(peer).or_default();
                        *known = (*known).min(start);
                    }
                }
                self.retry_at
                    .get_or_insert_with(|| Instant::now() + RETRY_DELAY);
                Ok(None)
            }
            // Not fatal: the server also says this to a connection it no
            // longer counts as joined. Reconnecting joins again and learns
            // the link's permission, which stops sending if it really is
            // view-only now.
            (UpdateStatusCode::PermissionDenied, _) => {
                bail!("the server refused the changes: this link is view-only")
            }
            // Every delta the snapshot would replace is stored, so only the
            // compaction is lost; trying again would hit the same limit.
            (other, InFlight::Snapshot) => Ok(Some(other)),
            // Sending the same ops again would only get the same answer.
            (
                status @ (UpdateStatusCode::InvalidUpdate | UpdateStatusCode::PayloadTooLarge),
                InFlight::Deltas(_),
            ) => Err(SyncError::Refused(status).into()),
            (other, InFlight::Deltas(_)) => bail!("the server refused the changes ({other:?})"),
        }
    }

    /// Sends every op of `doc` the server does not have yet, as delta
    /// records packed into containers of at most [`CONTAINER_BUDGET`].
    async fn send_missing(
        &mut self,
        doc: &LoroDoc,
        keys: &DocKeys,
        signer: &(dyn RecordSigner + Sync),
    ) -> anyhow::Result<()> {
        let vv = doc.oplog_vv();
        let mut spans: Vec<(u64, u64, u64)> = ends(&vv)
            .filter_map(|(peer, end)| {
                let start = self.server.get(&peer).copied().unwrap_or(0);
                (end > start).then_some((peer, start, end))
            })
            .collect();
        spans.sort_unstable();
        let mut records = Vec::new();
        for &(peer, start, end) in &spans {
            encrypt_span(doc, keys, signer, peer, start, end, &mut records)?;
        }
        let bytes: Vec<&[u8]> = records
            .iter()
            .map(|(_, record)| record.as_slice())
            .collect();
        for range in pack_ranges(&bytes, CONTAINER_BUDGET) {
            let container = encode_container(&bytes[range.clone()]);
            let spans = records[range].iter().map(|&(span, _)| span).collect();
            let id = self.client.send_update(container).await?;
            self.in_flight.insert(id, InFlight::Deltas(spans));
        }
        // Only after everything went out: a send that is cancelled halfway
        // must leave these ops looking unsent, or nothing would send them
        // again before the next connect. Resending a container the server
        // already has costs a duplicate it ignores.
        for (peer, _, end) in spans {
            raise(&mut self.server, peer, end);
        }
        Ok(())
    }

    fn compaction_due(&self) -> bool {
        !self.snapshot_sent && self.deltas >= COMPACT_AFTER_DELTAS
    }

    /// Sends `doc` as an encrypted snapshot that replaces the server's
    /// deltas. At most once per connection, also when it fails.
    async fn send_snapshot(
        &mut self,
        doc: &LoroDoc,
        keys: &DocKeys,
        signer: &(dyn RecordSigner + Sync),
    ) -> anyhow::Result<()> {
        self.snapshot_sent = true;
        let vv: Vec<(u64, u64)> = ends(&doc.oplog_vv()).collect();
        let snapshot = doc
            .export(ExportMode::Snapshot)
            .context("exporting a snapshot")?;
        let record = keys.encrypt_snapshot(signer, &vv, &snapshot)?;
        let container = encode_container(&[&record]);
        let id = self.client.send_update(container).await?;
        self.in_flight.insert(id, InFlight::Snapshot);
        self.deltas = 0;
        Ok(())
    }
}

impl Session {
    /// Connects and catches up: resolves the link (refreshing the cached
    /// permission and view token), joins, imports the backfill until the
    /// doc covers what the server had, then sends ops the server lacks,
    /// e.g. from an earlier run that went offline.
    pub async fn connect(&mut self) -> anyhow::Result<()> {
        self.disconnect().await;
        // Before anything else, and with the token we hold even if a
        // rotation retired it: the commit log is how a folder that was
        // offline learns its new links, or that it was removed.
        // Boxed: the group's state machines are large, and a debug build
        // keeps them on the stack of every command that connects.
        if let Err(err) = Box::pin(self.follow_group()).await {
            // Doc sync never waits on the group. Only a folder with no
            // group yet has to fail: without one it holds no doc keys.
            let removed = matches!(err.downcast_ref::<SyncError>(), Some(SyncError::Removed));
            if removed || self.group.is_none() {
                return Err(err);
            }
            self.warnings.push(format!(
                "could not follow the project's member group ({err:#}); syncing the document goes on, but links will not move over for this folder until this works"
            ));
        }
        let removed_devices = Box::pin(self.remove_revoked_devices()).await;
        let share = match self.resolved.take() {
            Some(share) => share,
            None => self.api.resolve_share(&self.config.token).await?,
        };
        if share.retired {
            return Err(SyncError::LinkReplaced.into());
        }
        if share.project_id != self.config.project_id {
            return Err(SyncError::WrongProject {
                now: share.project_id,
                linked: self.config.project_id.clone(),
            }
            .into());
        }
        // Edit links always come back with their view token, so only a
        // different one counts as news worth rewriting the config for.
        let new_view_token =
            share.view_token.is_some() && share.view_token != self.config.view_token;
        if share.permission != self.config.permission || new_view_token {
            self.config.permission = share.permission;
            if new_view_token {
                self.config.view_token = share.view_token;
            }
            self.save_config()?;
        }

        let mut client =
            Client::connect(&ws_url(&self.config.server)?, &self.config.project_id).await?;
        let joined = client
            .join(&self.config.token, &self.doc.oplog_vv())
            .await?;
        let permission = match joined.permission {
            loro_protocol::Permission::Write => Permission::Write,
            loro_protocol::Permission::Read => Permission::Read,
        };
        if permission != self.config.permission {
            self.config.permission = permission;
            self.save_config()?;
        }
        self.conn = Some(Conn::new(client, joined));

        while !self.caught_up() {
            self.next_remote_within(
                "the server stopped sending the project before it was complete",
            )
            .await?;
        }
        // One bad record is skipped, but nothing readable at all means the
        // key in the link is not the project's.
        let conn = self.conn.as_ref().context(NOT_CONNECTED)?;
        if let Some(id) = conn.foreign_key()
            && self.doc.oplog_vv().iter().next().is_none()
        {
            let project = id.to_owned();
            self.disconnect().await;
            return Err(SyncError::KeyMismatch {
                project,
                folder: self.doc_keys()?.key_id().to_owned(),
            }
            .into());
        }
        if self.can_write() {
            // Only from here on does the doc hold the whole project, which
            // migrating needs. The result goes out with the push below.
            typstry_doc::migrate(&self.doc).context("migrating the project")?;
            self.push_local().await?;
            if removed_devices {
                // Same as after any other rotation, so the project does not
                // depend on records under the keys that just retired.
                if let Err(err) = self.push_snapshot().await {
                    self.warnings.push(format!(
                        "could not upload the project under the new keys yet ({err:#}); typstry sync will do it"
                    ));
                }
            }
        }
        Ok(())
    }

    /// Fetches what changed remotely into the cached doc, for commands that
    /// only read the project. The base does not move: nothing was written
    /// to the folder.
    pub async fn refresh(&mut self) -> anyhow::Result<()> {
        self.connect().await?;
        self.disconnect().await;
        self.save_doc()
    }

    pub async fn disconnect(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.client.close().await;
        }
    }

    /// Whether the doc holds everything the server had when we joined.
    /// Once a record failed to decrypt, its ops (and any that build on
    /// them) can never arrive, so having been sent everything counts too.
    pub fn caught_up(&self) -> bool {
        self.conn
            .as_ref()
            .is_some_and(|conn| conn.caught_up(&self.doc.oplog_vv()))
    }

    /// Waits for the next thing from the server and handles it: imports
    /// updates, settles acks, resends refused spans when their retry is
    /// due. Fails when the connection is gone; reconnecting is up to the
    /// caller. Cancel safe.
    pub async fn next_remote(&mut self) -> anyhow::Result<RemoteEvent> {
        let can_write = self.can_write();
        let conn = self.conn.as_mut().context(NOT_CONNECTED)?;
        let Some(event) = conn.next_event().await else {
            if can_write {
                let group = self.group.as_ref().context(NO_KEYS)?;
                conn.send_missing(&self.doc, group.doc_keys(), &group.signer())
                    .await?;
            }
            // Cleared only once the resend went out: the sync loop drops
            // this future whenever something else wakes it, and a retry
            // that stays due simply runs again on the next call.
            conn.retry_at = None;
            return Ok(RemoteEvent::Progress);
        };
        match event {
            Event::Update(container) => {
                let imported = self.import_container(&container)?;
                if self.conn.as_ref().is_some_and(|conn| conn.stale_keys) {
                    self.keys_moved().await?;
                }
                Ok(if imported {
                    RemoteEvent::Imported
                } else {
                    RemoteEvent::Progress
                })
            }
            Event::Ack { batch, status } => {
                if let Some(refused) = conn.on_ack(batch, status)? {
                    self.compaction_refused = true;
                    self.warnings.push(format!(
                        "the server refused to compact the project's log ({refused:?}); it keeps the uncompacted log"
                    ));
                }
                Ok(RemoteEvent::Progress)
            }
            Event::Closed(reason) => {
                self.conn = None;
                Err(SyncError::Disconnected(reason).into())
            }
        }
    }

    /// Decrypts and imports one container. Returns whether the doc gained
    /// ops. A record that does not decrypt (under another key, tampered
    /// with, or with a header the server would have refused) is skipped
    /// like the browser does, so one bad record cannot block the project.
    /// Only a container whose framing is broken fails the import.
    pub fn import_container(&mut self, container: &[u8]) -> anyhow::Result<bool> {
        let records = decode_container(container).map_err(anyhow::Error::msg)?;
        let keys = self.group.as_ref().context(NO_KEYS)?.doc_keys();
        let mut plaintexts = Vec::with_capacity(records.len());
        let mut received = Received::default();
        for bytes in records {
            // A header that does not parse gives nothing to track, so it
            // only counts as unreadable.
            let opened = SealedRecord::parse(bytes)
                .map_err(CryptoError::MalformedRecord)
                .and_then(|sealed| {
                    cover(&sealed.record, &mut received.seen);
                    let (plaintext, _) = keys.open_record(&sealed)?;
                    Ok((sealed.record, plaintext))
                });
            let (record, plaintext) = match opened {
                Ok(opened) => opened,
                Err(err) => {
                    received.unreadable += 1;
                    match &err {
                        CryptoError::KeyMismatch(id) => received.mismatched_key = Some(id.clone()),
                        CryptoError::UnknownGeneration(_) => received.stale_keys = true,
                        _ => {}
                    }
                    if !self.warned_unreadable {
                        self.warned_unreadable = true;
                        self.warnings.push(match err {
                            CryptoError::NewerVersion(_) => format!("skipping changes {err}"),
                            CryptoError::NotEditor => {
                                "skipping changes by an author who is not an editor of this project; the browser skips them too".to_owned()
                            }
                            err => format!(
                                "skipping changes that do not decrypt with this folder's key ({err}); the browser skips them too"
                            ),
                        });
                    }
                    continue;
                }
            };
            cover(&record, &mut received.readable);
            plaintexts.push(plaintext);
        }
        let readable = std::mem::take(&mut received.readable);
        if let Some(conn) = self.conn.as_mut() {
            conn.received(received, !plaintexts.is_empty());
        }
        if plaintexts.is_empty() {
            return Ok(false);
        }
        let before = self.doc.oplog_vv();
        self.doc
            .import_batch(&plaintexts)
            .context("importing remote changes")?;
        if let Some(conn) = self.conn.as_mut() {
            for (peer, end) in readable {
                raise(&mut conn.server, peer, end);
            }
        }
        // A newer client may migrate the project while we sync. Fatal, so
        // a running sync stops instead of writing into the new layout.
        typstry_doc::ensure_supported(&self.doc).map_err(SyncError::from)?;
        Ok(self.doc.oplog_vv() != before)
    }

    /// Sends local ops the server lacks and waits until every batch is
    /// acked, resending refused ones. Then compacts when due.
    pub async fn push_local(&mut self) -> anyhow::Result<()> {
        if !self.can_write() {
            return Ok(());
        }
        let conn = self.conn.as_mut().context(NOT_CONNECTED)?;
        let group = self.group.as_ref().context(NO_KEYS)?;
        conn.send_missing(&self.doc, group.doc_keys(), &group.signer())
            .await?;
        self.wait_for_acks().await?;
        self.maybe_compact().await
    }

    /// Replaces the server's deltas with a snapshot under the current key
    /// generation, which an editor does after a rotation so the project
    /// does not depend on the deltas of keys it just retired.
    pub async fn push_snapshot(&mut self) -> anyhow::Result<()> {
        if !self.can_write() {
            return Ok(());
        }
        self.push_local().await?;
        let conn = self.conn.as_mut().context(NOT_CONNECTED)?;
        let group = self.group.as_ref().context(NO_KEYS)?;
        conn.send_snapshot(&self.doc, group.doc_keys(), &group.signer())
            .await?;
        self.wait_for_acks().await
    }

    /// Records arrived under a newer key generation than the keyring we
    /// hold. Fetches the keyring; with new keys the connection starts over
    /// so everything is read again. If the group has not reached that
    /// generation, only following it can help, and that happens when the
    /// server closes the stale connection or the next one opens.
    async fn keys_moved(&mut self) -> anyhow::Result<()> {
        if let Some(conn) = self.conn.as_mut() {
            conn.stale_keys = false;
        }
        if self.refresh_keyring().await? {
            self.conn = None;
            return Err(
                SyncError::Disconnected(Some("the project's keys were rotated".into())).into(),
            );
        }
        let note = "some changes are under keys this folder does not have yet; they are skipped until it follows the project's group (run `typstry pull`)";
        if !self.warnings.iter().any(|w| w == note) {
            self.warnings.push(note.to_owned());
        }
        Ok(())
    }

    async fn wait_for_acks(&mut self) -> anyhow::Result<()> {
        while !self.conn.as_ref().context(NOT_CONNECTED)?.settled() {
            self.next_remote_within("the server did not confirm the changes in time")
                .await?;
        }
        Ok(())
    }

    /// [`Self::next_remote`], failing with `stalled` when the server goes
    /// quiet for [`STALL_TIMEOUT`].
    async fn next_remote_within(&mut self, stalled: &'static str) -> anyhow::Result<()> {
        match tokio::time::timeout(STALL_TIMEOUT, self.next_remote()).await {
            Ok(result) => result.map(drop),
            Err(_) => bail!(stalled),
        }
    }

    /// The server cannot compact what it cannot read, so writers replace
    /// its deltas with an encrypted snapshot now and then. It only accepts
    /// one that covers everything it holds, hence the push right before.
    async fn maybe_compact(&mut self) -> anyhow::Result<()> {
        let wanted = self.can_write() && !self.compaction_refused;
        let conn = self.conn.as_mut().context(NOT_CONNECTED)?;
        if !wanted || !conn.compaction_due() {
            return Ok(());
        }
        let group = self.group.as_ref().context(NO_KEYS)?;
        conn.send_snapshot(&self.doc, group.doc_keys(), &group.signer())
            .await?;
        self.wait_for_acks().await
    }
}

/// Encrypts ops `[start, end)` of `peer` into delta records, each paired
/// with the `(peer, start)` of its span. A span whose updates exceed the
/// container budget is cut into pieces, so a big initial import never
/// produces one update larger than the server accepts.
fn encrypt_span(
    doc: &LoroDoc,
    keys: &DocKeys,
    signer: &dyn RecordSigner,
    peer: u64,
    start: u64,
    end: u64,
    out: &mut Vec<((u64, u64), Vec<u8>)>,
) -> anyhow::Result<()> {
    let span = IdSpan::new(peer, start as i32, end as i32);
    let plaintext = doc
        .export(ExportMode::updates_in_range(vec![span]))
        .context("exporting local ops")?;
    let ops = end - start;
    if plaintext.len() <= CONTAINER_BUDGET || ops == 1 {
        out.push((
            (peer, start),
            keys.encrypt_delta(signer, peer, start, end, &plaintext)?,
        ));
        return Ok(());
    }
    // Exporting dominates the cost, and halving would export every op once
    // per level. Sizing pieces from the average op instead exports most ops
    // just once more. Aiming at half the budget leaves room for ops that
    // are bigger than average; a piece that still comes out too big is cut
    // again.
    let pieces = (plaintext.len() as u64)
        .div_ceil(CONTAINER_BUDGET as u64 / 2)
        .min(ops);
    let step = ops.div_ceil(pieces);
    let mut at = start;
    while at < end {
        let next = (at + step).min(end);
        encrypt_span(doc, keys, signer, peer, at, next, out)?;
        at = next;
    }
    Ok(())
}

/// Raises `map` to the op ranges a record says it covers.
fn cover(record: &Record, map: &mut HashMap<u64, u64>) {
    match record {
        Record::Delta { peer, end, .. } => raise(map, *peer, *end),
        Record::Snapshot { vv } => {
            for (&peer, &counter) in vv {
                raise(map, peer, counter);
            }
        }
    }
}

fn raise(map: &mut HashMap<u64, u64>, peer: u64, end: u64) {
    let entry = map.entry(peer).or_default();
    *entry = (*entry).max(end);
}

/// Loro counts ops in `i32` but the wire speaks `u64`; a negative counter
/// reads as no ops at all.
fn end_of(counter: i32) -> u64 {
    counter.max(0) as u64
}

/// Each peer of `vv` with how many of its ops it holds.
fn ends(vv: &VersionVector) -> impl Iterator<Item = (u64, u64)> + '_ {
    vv.iter().map(|(&peer, &counter)| (peer, end_of(counter)))
}

fn covers(have: &VersionVector, target: &VersionVector) -> bool {
    target
        .iter()
        .all(|(peer, &end)| have.get(peer).copied().unwrap_or(0) >= end)
}

#[cfg(test)]
mod tests {
    use typstry_wire::crypto::{Keyring, LinkSecret, LocalSigner};

    use super::*;

    #[test]
    fn splits_large_spans() {
        let doc = LoroDoc::new();
        doc.set_peer_id(7).unwrap();
        let text = doc.get_text("t");
        // Random-ish text compresses badly, so the export stays large.
        let body: String = (0..1_100_000u64)
            .map(|i| char::from(b'a' + ((i * 7919 + i / 13) % 26) as u8))
            .collect();
        text.insert(0, &body).unwrap();
        doc.commit();
        let end = *doc.oplog_vv().get(&7).unwrap() as u64;
        let link = LinkSecret::generate_edit();
        let keys = DocKeys::new(Keyring::new(&link));
        let signer = LocalSigner::attested([7; 32], &link, 1);
        let mut records = Vec::new();
        encrypt_span(&doc, &keys, &signer, 7, 0, end, &mut records).unwrap();
        assert!(records.len() > 1);

        let copy = LoroDoc::new();
        let mut next = 0;
        let mut plaintexts = Vec::new();
        for ((peer, start), record) in &records {
            let out = keys.decrypt_record(record).unwrap();
            let Record::Delta {
                peer: p,
                start: s,
                end: e,
            } = out.record
            else {
                panic!("not a delta");
            };
            assert_eq!((p, s), (*peer, *start));
            assert_eq!(s, next, "spans must be contiguous");
            next = e;
            assert!(out.plaintext.len() <= CONTAINER_BUDGET);
            plaintexts.push(out.plaintext);
        }
        assert_eq!(next, end);
        copy.import_batch(&plaintexts).unwrap();
        assert_eq!(copy.get_text("t").to_string(), body);
    }
}
