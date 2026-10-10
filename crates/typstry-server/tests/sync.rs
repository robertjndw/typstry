//! End-to-end tests of the sync server over a real WebSocket, speaking the
//! protocol through the `loro-protocol` crate the way the JS client does.
//!
//! The server never decrypts anything, so the records here carry arbitrary
//! bytes as ciphertext; only their plaintext headers matter.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::Path;
use std::slice;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use loro::VersionVector;
use loro_protocol::{
    BatchId, BytesWriter, CrdtType, JoinErrorCode, Permission, ProtocolMessage, UpdateStatusCode,
    decode, decode_elo_container, encode,
};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;
use typstry_server::http::{AppState, router};
use typstry_server::room::RoomConfig;
use typstry_server::store::blobs::BlobStore;
use typstry_server::store::docs;
use typstry_server::ws::ConnLimits;
use typstry_wire::elo::{
    encode_container as container, encode_delta_header, encode_record, encode_snapshot_header,
};
use typstry_wire::fragment::{Reassembler, encode_update};

mod common;

const TIMEOUT: Duration = Duration::from_secs(5);
/// How long a client waits before concluding nothing more is coming.
const QUIET: Duration = Duration::from_millis(200);

struct Server {
    addr: SocketAddr,
    state: AppState,
    task: JoinHandle<()>,
}

impl Server {
    async fn start(data: &Path, config: RoomConfig) -> Self {
        Self::start_with(data, config, ConnLimits::default()).await
    }

    async fn start_with(data: &Path, config: RoomConfig, limits: ConnLimits) -> Self {
        let pool = common::open_db(data).await;
        let mut state = AppState::with_room_config(pool, BlobStore::new(data), config);
        state.limits = limits;
        let app = common::app(state.clone(), data);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { addr, state, task }
    }

    /// Simulates a crash: no clean shutdown, the listener just goes away.
    fn kill(self) {
        self.task.abort();
    }

    async fn create_project(&self) -> (String, String, String) {
        let created =
            common::create_project(router(self.state.clone(), Path::new("no-dist"))).await;
        (created.id, created.edit, created.view)
    }

    async fn connect(&self) -> Client {
        let (ws, _) = connect_async(format!("ws://{}/ws", self.addr))
            .await
            .unwrap();
        Client {
            ws,
            fragments: Reassembler::default(),
            early: VecDeque::new(),
        }
    }

    async fn records(&self, room: &str) -> i64 {
        docs::record_count(&self.state.db, room).await.unwrap()
    }
}

/// What a successful doc join told the client.
#[derive(Debug, PartialEq, Eq)]
struct Joined {
    permission: Permission,
    coverage: HashMap<u64, i32>,
    deltas: u64,
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    fragments: Reassembler,
    /// Updates that arrived while waiting for an ack.
    early: VecDeque<(CrdtType, Vec<u8>)>,
}

impl Client {
    async fn send(&mut self, msg: &ProtocolMessage) {
        self.ws
            .send(Message::Binary(encode(msg).unwrap().into()))
            .await
            .unwrap();
    }

    /// Next protocol message within `wait`, with fragmented updates already
    /// reassembled into a single `DocUpdate`.
    async fn try_recv(&mut self, wait: Duration) -> Option<ProtocolMessage> {
        loop {
            let frame = tokio::time::timeout(wait, self.ws.next())
                .await
                .ok()?
                .expect("socket closed")
                .unwrap();
            let Message::Binary(bytes) = frame else {
                continue;
            };
            match decode(&bytes).unwrap() {
                ProtocolMessage::DocUpdateFragmentHeader {
                    crdt,
                    room_id,
                    batch_id,
                    fragment_count,
                    total_size_bytes,
                } => self
                    .fragments
                    .start(crdt, &room_id, batch_id, fragment_count, total_size_bytes)
                    .unwrap(),
                ProtocolMessage::DocUpdateFragment {
                    crdt,
                    room_id,
                    batch_id,
                    index,
                    fragment,
                } => {
                    if let Some(update) = self
                        .fragments
                        .push(crdt, &room_id, batch_id, index, fragment)
                        .unwrap()
                    {
                        return Some(ProtocolMessage::DocUpdate {
                            crdt,
                            room_id,
                            updates: vec![update],
                            batch_id,
                        });
                    }
                }
                msg => return Some(msg),
            }
        }
    }

    async fn recv(&mut self) -> ProtocolMessage {
        self.try_recv(TIMEOUT)
            .await
            .expect("timed out waiting for a message")
    }

    /// The next update payload of `crdt`.
    async fn recv_update(&mut self, crdt: CrdtType) -> Vec<u8> {
        if let Some(pos) = self.early.iter().position(|(c, _)| *c == crdt) {
            return self.early.remove(pos).unwrap().1;
        }
        loop {
            if let ProtocolMessage::DocUpdate {
                crdt: got, updates, ..
            } = self.recv().await
                && got == crdt
            {
                assert_eq!(updates.len(), 1);
                return updates.into_iter().next().unwrap();
            }
        }
    }

    /// Receives doc updates until `n` records arrived, in order.
    async fn recv_records(&mut self, n: usize) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while out.len() < n {
            let container = self.recv_update(CrdtType::Elo).await;
            out.extend(records_of(&container));
        }
        assert_eq!(out.len(), n, "more records than expected");
        out
    }

    /// Asserts nothing but pings arrive for a short while.
    async fn assert_quiet(&mut self) {
        assert!(self.early.is_empty(), "unexpected {:?}", self.early);
        if let Some(msg) = self.try_recv(QUIET).await {
            panic!("expected silence, got {msg:?}");
        }
    }

    async fn join(
        &mut self,
        crdt: CrdtType,
        room: &str,
        token: &str,
        version: Vec<u8>,
    ) -> ProtocolMessage {
        self.send(&ProtocolMessage::JoinRequest {
            crdt,
            room_id: room.to_owned(),
            auth: token.as_bytes().to_vec(),
            version,
        })
        .await;
        self.recv().await
    }

    async fn join_doc(&mut self, room: &str, token: &str, version: &[(u64, i32)]) -> Joined {
        let msg = self.join(CrdtType::Elo, room, token, vv(version)).await;
        let ProtocolMessage::JoinResponseOk {
            permission,
            version,
            extra,
            ..
        } = msg
        else {
            panic!("join failed: {msg:?}");
        };
        let coverage = VersionVector::decode(&version)
            .unwrap()
            .iter()
            .map(|(&peer, &count)| (peer, count))
            .collect();
        let extra: Value = serde_json::from_slice(&extra.expect("extra")).unwrap();
        Joined {
            permission,
            coverage,
            deltas: extra["deltas"].as_u64().unwrap(),
        }
    }

    async fn join_presence(&mut self, room: &str, token: &str) {
        let msg = self
            .join(CrdtType::LoroEphemeralStore, room, token, Vec::new())
            .await;
        let ProtocolMessage::JoinResponseOk { version, extra, .. } = msg else {
            panic!("presence join failed: {msg:?}");
        };
        assert!(version.is_empty());
        // The wire cannot tell no extra from an empty one.
        assert!(extra.unwrap_or_default().is_empty());
    }

    async fn send_update(
        &mut self,
        crdt: CrdtType,
        room: &str,
        updates: Vec<Vec<u8>>,
        batch: u8,
    ) -> UpdateStatusCode {
        let batch_id = BatchId([batch; 8]);
        self.send(&ProtocolMessage::DocUpdate {
            crdt,
            room_id: room.to_owned(),
            updates,
            batch_id,
        })
        .await;
        self.ack(batch_id).await
    }

    async fn send_records(&mut self, room: &str, records: &[&[u8]], batch: u8) -> UpdateStatusCode {
        self.send_update(CrdtType::Elo, room, vec![container(records)], batch)
            .await
    }

    async fn ack(&mut self, batch_id: BatchId) -> UpdateStatusCode {
        loop {
            match self.recv().await {
                ProtocolMessage::Ack { ref_id, status, .. } => {
                    assert_eq!(ref_id, batch_id);
                    return status;
                }
                ProtocolMessage::DocUpdate { crdt, updates, .. } => {
                    for update in updates {
                        self.early.push_back((crdt, update));
                    }
                }
                _ => {}
            }
        }
    }
}

fn vv(pairs: &[(u64, i32)]) -> Vec<u8> {
    let mut vv = VersionVector::new();
    for &(peer, count) in pairs {
        vv.insert(peer, count);
    }
    vv.encode()
}

fn delta(peer: u64, start: u64, end: u64, ct: &[u8]) -> Vec<u8> {
    encode_record(&encode_delta_header(peer, start, end, "k1", &[7; 12]), ct)
}

/// A delta with a peer id the encoder would never write.
fn delta_raw(peer: &[u8], start: u64, end: u64, ct: &[u8]) -> Vec<u8> {
    let mut w = BytesWriter::new();
    w.push_byte(0x00);
    w.push_var_bytes(peer);
    w.push_uleb128(start);
    w.push_uleb128(end);
    w.push_var_string("k1");
    w.push_var_bytes(&[7; 12]);
    w.push_var_bytes(ct);
    w.finalize()
}

fn snapshot(vv: &[(u64, u64)], ct: &[u8]) -> Vec<u8> {
    encode_record(&encode_snapshot_header(vv, "k1", &[9; 12]), ct)
}

fn records_of(container: &[u8]) -> Vec<Vec<u8>> {
    decode_elo_container(container)
        .unwrap()
        .into_iter()
        .map(<[u8]>::to_vec)
        .collect()
}

fn coverage(pairs: &[(u64, i32)]) -> HashMap<u64, i32> {
    pairs.iter().copied().collect()
}

#[tokio::test]
async fn project_and_share_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (id, edit, view) = server.create_project().await;
    assert_eq!(id.len(), 22);
    assert_ne!(edit, view);

    let app = router(server.state.clone(), Path::new("no-dist"));
    for (token, expected) in [(&edit, "write"), (&view, "read")] {
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/api/share/{token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(res.into_body(), 1024).await.unwrap()).unwrap();
        assert_eq!(body["projectId"], id);
        assert_eq!(body["permission"], expected);
    }

    for bad in ["nope", "0000000000000000000000"] {
        let res = app
            .clone()
            .oneshot(
                Request::get(format!("/api/share/{bad}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn new_project_has_an_empty_doc() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut c = server.connect().await;
    let joined = c.join_doc(&room, &edit, &[]).await;
    assert_eq!(
        joined,
        Joined {
            permission: Permission::Write,
            coverage: HashMap::new(),
            deltas: 0,
        }
    );
    c.assert_quiet().await;

    // A literally empty version is what the JS client sends first.
    let msg = c.join(CrdtType::Elo, &room, &edit, Vec::new()).await;
    assert!(
        matches!(msg, ProtocolMessage::JoinResponseOk { .. }),
        "{msg:?}"
    );
    c.assert_quiet().await;
}

#[tokio::test]
async fn deltas_are_stored_and_relayed() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    b.join_doc(&room, &edit, &[]).await;

    let d1 = delta(1, 0, 3, b"one");
    let d2 = delta(1, 3, 5, b"two");
    assert_eq!(
        a.send_records(&room, &[&d1, &d2], 1).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(2).await, [d1.clone(), d2.clone()]);
    a.assert_quiet().await;
    assert_eq!(server.records(&room).await, 2);

    // B answers; A gets exactly B's span.
    let d3 = delta(2, 0, 4, b"three");
    assert_eq!(b.send_records(&room, &[&d3], 2).await, UpdateStatusCode::Ok);
    assert_eq!(a.recv_records(1).await, slice::from_ref(&d3));

    let mut c = server.connect().await;
    let joined = c.join_doc(&room, &edit, &[]).await;
    assert_eq!(joined.coverage, coverage(&[(1, 5), (2, 4)]));
    assert_eq!(joined.deltas, 3);
    assert_eq!(c.recv_records(3).await, [d1, d2, d3]);
    c.assert_quiet().await;
}

#[tokio::test]
async fn rejoin_with_version_gets_only_missing_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let d1 = delta(1, 0, 3, b"a");
    let d2 = delta(2, 0, 2, b"b");
    let d3 = delta(1, 3, 5, b"c");
    let mut a = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    for (i, d) in [&d1, &d2, &d3].into_iter().enumerate() {
        assert_eq!(
            a.send_records(&room, &[d], i as u8).await,
            UpdateStatusCode::Ok
        );
    }

    let mut b = server.connect().await;
    let joined = b.join_doc(&room, &edit, &[(1, 3)]).await;
    assert_eq!(joined.coverage, coverage(&[(1, 5), (2, 2)]));
    assert_eq!(joined.deltas, 3);
    // Sequence order, not grouped by peer.
    assert_eq!(b.recv_records(2).await, [d2.clone(), d3.clone()]);
    b.assert_quiet().await;

    // A client that is already up to date gets nothing at all.
    let mut c = server.connect().await;
    c.join_doc(&room, &edit, &[(1, 5), (2, 2)]).await;
    c.assert_quiet().await;

    // Garbage in the version is answered like the JS client expects.
    let msg = c.join(CrdtType::Elo, &room, &edit, vec![0xff; 7]).await;
    assert!(
        matches!(
            msg,
            ProtocolMessage::JoinError {
                code: JoinErrorCode::VersionUnknown,
                ..
            }
        ),
        "{msg:?}"
    );
}

#[tokio::test]
async fn coverage_waits_for_gaps_and_duplicates_are_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    b.join_doc(&room, &edit, &[]).await;

    let late = delta(1, 5, 8, b"late");
    assert_eq!(
        a.send_records(&room, &[&late], 1).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(1).await, slice::from_ref(&late));
    let mut c = server.connect().await;
    let joined = c.join_doc(&room, &edit, &[]).await;
    assert_eq!(joined.coverage, HashMap::new(), "a hole at [0, 5)");
    assert_eq!(joined.deltas, 1);
    assert_eq!(c.recv_records(1).await, slice::from_ref(&late));

    let early = delta(1, 0, 5, b"early");
    assert_eq!(
        a.send_records(&room, &[&early], 2).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(1).await, slice::from_ref(&early));
    let mut c = server.connect().await;
    assert_eq!(
        c.join_doc(&room, &edit, &[]).await.coverage,
        coverage(&[(1, 8)])
    );
    assert_eq!(c.recv_records(2).await, [late, early.clone()]);

    // Everything in these is covered already: acked, but neither stored
    // nor relayed.
    let again = delta(1, 2, 8, b"retransmit");
    assert_eq!(
        a.send_records(&room, &[&early, &again], 3).await,
        UpdateStatusCode::Ok
    );
    b.assert_quiet().await;
    assert_eq!(server.records(&room).await, 2);

    // A partly new span is stored and relayed alone, without the duplicate
    // that came along in the same container.
    let overlap = delta(1, 6, 10, b"overlap");
    assert_eq!(
        a.send_records(&room, &[&early, &overlap], 4).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(1).await, [overlap]);
    b.assert_quiet().await;
    assert_eq!(server.records(&room).await, 3);
}

#[tokio::test]
async fn snapshots_replace_covered_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    b.join_doc(&room, &edit, &[]).await;
    let d1 = delta(1, 0, 3, b"a");
    let d2 = delta(1, 3, 5, b"b");
    let d3 = delta(2, 0, 2, b"c");
    assert_eq!(
        a.send_records(&room, &[&d1, &d2, &d3], 1).await,
        UpdateStatusCode::Ok
    );
    b.recv_records(3).await;

    // Misses op 4 of peer 1, so taking it would lose that op.
    let short = snapshot(&[(1, 4), (2, 2)], b"short");
    assert_eq!(
        a.send_records(&room, &[&short], 2).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(server.records(&room).await, 3);

    // Leaves out peer 2 entirely, which is just as lossy.
    let partial = snapshot(&[(1, 5)], b"partial");
    assert_eq!(
        a.send_records(&room, &[&partial], 3).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(server.records(&room).await, 3);
    let full = snapshot(&[(1, 5), (2, 2)], b"full");
    assert_eq!(
        a.send_records(&room, &[&full], 4).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(server.records(&room).await, 1);
    // Peers already hold these ops; snapshots are only for compaction.
    b.assert_quiet().await;

    // The same version again would prune nothing, so it is ignored.
    let same = snapshot(&[(1, 5), (2, 2)], b"same");
    assert_eq!(
        a.send_records(&room, &[&same], 5).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(server.records(&room).await, 1);

    let mut fresh = server.connect().await;
    let joined = fresh.join_doc(&room, &edit, &[]).await;
    assert_eq!(joined.coverage, coverage(&[(1, 5), (2, 2)]));
    assert_eq!(joined.deltas, 0);
    assert_eq!(fresh.recv_records(1).await, slice::from_ref(&full));
    fresh.assert_quiet().await;

    // A snapshot and a new span in one container: only the span is relayed.
    let d4 = delta(1, 5, 6, b"d");
    assert_eq!(
        a.send_records(&room, &[&same, &d4], 6).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(1).await, slice::from_ref(&d4));
    b.assert_quiet().await;

    // Snapshot first, then the newer delta; a client past the snapshot only
    // gets the delta.
    let mut c = server.connect().await;
    assert_eq!(c.join_doc(&room, &edit, &[]).await.deltas, 1);
    assert_eq!(c.recv_records(2).await, [full, d4.clone()]);
    let mut c = server.connect().await;
    c.join_doc(&room, &edit, &[(1, 5), (2, 2)]).await;
    assert_eq!(c.recv_records(1).await, [d4]);
    c.assert_quiet().await;
}

#[tokio::test]
async fn invalid_updates_are_rejected_whole() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    b.join_doc(&room, &edit, &[]).await;
    let valid = delta(1, 0, 1, b"ok");
    let bad_peers: [&[u8]; 4] = [b"01", b"+1", b"x", b"18446744073709551616"];
    for (i, peer) in bad_peers.into_iter().enumerate() {
        let bad = delta_raw(peer, 0, 1, b"x");
        assert_eq!(
            a.send_records(&room, &[&valid, &bad], i as u8).await,
            UpdateStatusCode::InvalidUpdate,
            "{peer:?}"
        );
    }
    for (i, update) in [
        container(&[]),
        container(&[&delta(1, 0, 1 << 31, b"x")]),
        container(&[&snapshot(&[(1, 1 << 31)], b"x")]),
        b"definitely not elo".to_vec(),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            a.send_update(CrdtType::Elo, &room, vec![update], 10 + i as u8)
                .await,
            UpdateStatusCode::InvalidUpdate
        );
    }
    assert_eq!(server.records(&room).await, 0);
    b.assert_quiet().await;

    // The connection stays usable afterwards.
    assert_eq!(
        a.send_records(&room, &[&valid], 20).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_records(1).await, [valid]);
}

#[tokio::test]
async fn view_token_cannot_write_the_doc() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, _, view) = server.create_project().await;

    let mut viewer = server.connect().await;
    assert_eq!(
        viewer.join_doc(&room, &view, &[]).await.permission,
        Permission::Read
    );
    assert_eq!(
        viewer
            .send_records(&room, &[&delta(1, 0, 1, b"sneaky")], 1)
            .await,
        UpdateStatusCode::PermissionDenied
    );
    assert_eq!(server.records(&room).await, 0);

    // Presence is fine.
    viewer.join_presence(&room, &view).await;
    assert_eq!(
        viewer
            .send_update(
                CrdtType::LoroEphemeralStore,
                &room,
                vec![b"here".to_vec()],
                2
            )
            .await,
        UpdateStatusCode::Ok
    );
}

#[tokio::test]
async fn join_rejects_bad_tokens_unknown_rooms_and_plain_loro() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;
    let (other_room, _, _) = server.create_project().await;

    let mut c = server.connect().await;
    for (room, token) in [
        (room.as_str(), "0000000000000000000000"),
        (other_room.as_str(), edit.as_str()),
        ("no-such-room", edit.as_str()),
    ] {
        let msg = c.join(CrdtType::Elo, room, token, Vec::new()).await;
        assert!(
            matches!(
                msg,
                ProtocolMessage::JoinError {
                    code: JoinErrorCode::AuthFailed,
                    ..
                }
            ),
            "{msg:?}"
        );
    }

    // Plaintext Loro would hand the server the content, so it is gone.
    let msg = c.join(CrdtType::Loro, &room, &edit, Vec::new()).await;
    assert!(
        matches!(
            msg,
            ProtocolMessage::JoinError {
                code: JoinErrorCode::Unknown,
                ..
            }
        ),
        "{msg:?}"
    );

    // Updates to a room the connection never joined are refused.
    for crdt in [CrdtType::Elo, CrdtType::Loro] {
        let update = container(&[&delta(1, 0, 1, b"x")]);
        assert_eq!(
            c.send_update(crdt, &room, vec![update], 4).await,
            UpdateStatusCode::PermissionDenied
        );
    }
}

#[tokio::test]
async fn state_survives_restart_and_unload() {
    let dir = tempfile::tempdir().unwrap();
    let config = RoomConfig {
        unload_after: Duration::from_millis(100),
        tick: Duration::from_millis(20),
        ..RoomConfig::default()
    };
    let server = Server::start(dir.path(), config.clone()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    let snap = snapshot(&[(1, 3)], b"snap");
    let d1 = delta(1, 3, 4, b"after");
    let gap = delta(2, 5, 6, b"gap");
    assert_eq!(
        a.send_records(&room, &[&delta(1, 0, 3, b"x"), &snap, &d1, &gap], 1)
            .await,
        UpdateStatusCode::Ok
    );
    let expected = Joined {
        permission: Permission::Write,
        coverage: coverage(&[(1, 4)]),
        deltas: 2,
    };

    server.kill();
    drop(a);
    let server = Server::start(dir.path(), config).await;
    let mut fresh = server.connect().await;
    assert_eq!(fresh.join_doc(&room, &edit, &[]).await, expected);
    assert_eq!(
        fresh.recv_records(3).await,
        [snap.clone(), d1.clone(), gap.clone()]
    );

    // Unloading keeps nothing in memory that is not on disk either.
    fresh.ws.close(None).await.unwrap();
    tokio::time::timeout(TIMEOUT, async {
        while server.state.rooms.loaded_rooms() > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("room did not unload");
    let mut again = server.connect().await;
    assert_eq!(again.join_doc(&room, &edit, &[]).await, expected);
    assert_eq!(again.recv_records(3).await, [snap, d1, gap]);

    // A clean shutdown stops the room the same way.
    server.state.rooms.shutdown().await;
    assert_eq!(server.state.rooms.loaded_rooms(), 0);
}

#[tokio::test]
async fn large_records_are_fragmented_and_packed() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    b.join_doc(&room, &edit, &[]).await;

    let ct: Vec<u8> = (0..400_000u32).map(|i| (i % 251) as u8).collect();
    let big = delta(1, 0, 1, &ct);
    let update = container(&[&big]);
    let frames = encode_update(CrdtType::Elo, &room, &update);
    assert!(frames.len() > 2);
    let ProtocolMessage::DocUpdateFragmentHeader { batch_id, .. } = decode(&frames[0]).unwrap()
    else {
        panic!("expected a fragment header");
    };
    for frame in frames {
        a.ws.send(Message::Binary(frame.into())).await.unwrap();
    }
    assert_eq!(a.ack(batch_id).await, UpdateStatusCode::Ok);
    assert_eq!(b.recv_records(1).await, slice::from_ref(&big));

    // Many small spans are packed into a few containers on backfill.
    let small: Vec<Vec<u8>> = (1..=300u64)
        .map(|i| delta(2, i - 1, i, &[i as u8; 1000]))
        .collect();
    for (i, chunk) in small.chunks(100).enumerate() {
        let refs: Vec<&[u8]> = chunk.iter().map(Vec::as_slice).collect();
        assert_eq!(
            a.send_records(&room, &refs, 10 + i as u8).await,
            UpdateStatusCode::Ok
        );
    }
    let mut c = server.connect().await;
    c.join_doc(&room, &edit, &[]).await;
    let first = c.recv_update(CrdtType::Elo).await;
    assert_eq!(records_of(&first), [big]);
    let mut got = Vec::new();
    let mut containers = 0;
    while got.len() < small.len() {
        let next = c.recv_update(CrdtType::Elo).await;
        assert!(next.len() <= 200 * 1024 + 16);
        got.extend(records_of(&next));
        containers += 1;
    }
    assert_eq!(got, small);
    assert_eq!(containers, 2);
}

#[tokio::test]
async fn presence_is_relayed_replayed_and_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let (room, edit, view) = server.create_project().await;

    let mut a = server.connect().await;
    let mut b = server.connect().await;
    a.join_presence(&room, &edit).await;
    b.join_presence(&room, &view).await;

    // Viewers may publish presence even though they cannot edit. Only the
    // latest blob per connection is kept for late joiners.
    let eph = CrdtType::LoroEphemeralStore;
    for (i, blob) in [&b"old"[..], b"", b"newest"].into_iter().enumerate() {
        assert_eq!(
            b.send_update(eph, &room, vec![blob.to_vec()], i as u8)
                .await,
            UpdateStatusCode::Ok
        );
    }
    assert_eq!(a.recv_update(eph).await, b"old");
    assert_eq!(a.recv_update(eph).await, b"newest");
    a.assert_quiet().await;
    assert_eq!(
        a.send_update(eph, &room, vec![b"from a".to_vec()], 9).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(b.recv_update(eph).await, b"from a");

    let too_big = vec![0u8; 8 * 1024 + 1];
    assert_eq!(
        b.send_update(eph, &room, vec![too_big], 10).await,
        UpdateStatusCode::InvalidUpdate
    );
    a.assert_quiet().await;

    let mut late = server.connect().await;
    late.join_presence(&room, &edit).await;
    let mut replay = vec![late.recv_update(eph).await, late.recv_update(eph).await];
    replay.sort();
    assert_eq!(replay, [b"from a".to_vec(), b"newest".to_vec()]);
    late.assert_quiet().await;

    // B's presence goes with its connection.
    b.ws.close(None).await.unwrap();
    drop(b);
    tokio::time::timeout(TIMEOUT, async {
        loop {
            let mut probe = server.connect().await;
            probe.join_presence(&room, &edit).await;
            let mut seen = Vec::new();
            while let Some(ProtocolMessage::DocUpdate { updates, .. }) = probe.try_recv(QUIET).await
            {
                seen.extend(updates);
            }
            seen.sort();
            if seen == [b"from a".to_vec()] {
                break;
            }
        }
    })
    .await
    .expect("presence of a closed connection lingered");
}

#[tokio::test]
async fn stale_presence_expires() {
    let dir = tempfile::tempdir().unwrap();
    let config = RoomConfig {
        tick: Duration::from_millis(20),
        ephemeral_timeout: Duration::from_millis(100),
        ..RoomConfig::default()
    };
    let server = Server::start(dir.path(), config).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    a.join_presence(&room, &edit).await;
    assert_eq!(
        a.send_update(CrdtType::LoroEphemeralStore, &room, vec![b"hi".to_vec()], 1)
            .await,
        UpdateStatusCode::Ok
    );
    tokio::time::sleep(Duration::from_millis(300)).await;

    // A is still connected but has not refreshed, so it is not replayed.
    let mut b = server.connect().await;
    b.join_presence(&room, &edit).await;
    b.assert_quiet().await;
}

#[tokio::test]
async fn answers_text_ping() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path(), RoomConfig::default()).await;
    let mut c = server.connect().await;
    c.ws.send(Message::text("ping")).await.unwrap();
    let reply = tokio::time::timeout(TIMEOUT, c.ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(reply, Message::text("pong"));
}

#[tokio::test]
async fn doc_updates_are_rate_limited_per_connection() {
    let dir = tempfile::tempdir().unwrap();
    let limits = ConnLimits {
        update_burst: 5,
        // Effectively no refill during the test.
        updates_per_sec: 0.001,
        ..ConnLimits::default()
    };
    let server = Server::start_with(dir.path(), RoomConfig::default(), limits).await;
    let (room, edit, _) = server.create_project().await;

    let mut a = server.connect().await;
    a.join_doc(&room, &edit, &[]).await;
    for i in 0..5u8 {
        let d = delta(1, u64::from(i), u64::from(i) + 1, b"x");
        assert_eq!(a.send_records(&room, &[&d], i).await, UpdateStatusCode::Ok);
    }
    let over = delta(1, 5, 6, b"over the limit");
    assert_eq!(
        a.send_records(&room, &[&over], 5).await,
        UpdateStatusCode::RateLimited
    );
    assert_eq!(server.records(&room).await, 5);

    // Still connected, and presence has its own budget.
    a.join_presence(&room, &edit).await;
    assert_eq!(
        a.send_update(CrdtType::LoroEphemeralStore, &room, vec![b"p".to_vec()], 42)
            .await,
        UpdateStatusCode::Ok
    );

    // A fresh connection has a fresh bucket, and its rejoin tells the
    // client what the server still lacks.
    let mut b = server.connect().await;
    let joined = b.join_doc(&room, &edit, &[(1, 6)]).await;
    assert_eq!(joined.coverage, coverage(&[(1, 5)]));
    assert_eq!(
        b.send_records(&room, &[&over], 1).await,
        UpdateStatusCode::Ok
    );
    assert_eq!(server.records(&room).await, 6);
}

#[tokio::test]
async fn rooms_per_connection_are_capped() {
    let dir = tempfile::tempdir().unwrap();
    let limits = ConnLimits {
        max_rooms: 2,
        ..ConnLimits::default()
    };
    let server = Server::start_with(dir.path(), RoomConfig::default(), limits).await;
    let (room, edit, _) = server.create_project().await;
    let (other, other_edit, _) = server.create_project().await;

    let mut c = server.connect().await;
    c.join_doc(&room, &edit, &[]).await;
    c.join_presence(&room, &edit).await;

    let msg = c.join(CrdtType::Elo, &other, &other_edit, Vec::new()).await;
    assert!(
        matches!(
            msg,
            ProtocolMessage::JoinError {
                code: JoinErrorCode::AppError,
                ..
            }
        ),
        "{msg:?}"
    );
    // Rejoining a room it already holds is not a new room.
    c.join_presence(&room, &edit).await;
}
