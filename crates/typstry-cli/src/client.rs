//! The WebSocket transport: Loro Protocol messages for the `%ELO` room of
//! one project, with fragmentation and the text keepalive the JS client
//! uses (`apps/web/src/sync/connection.ts` via `loro-websocket`).
//!
//! This layer knows nothing about the doc or encryption; [`crate::engine`]
//! decides what to send and what an update means.

use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use loro::VersionVector;
use loro_protocol::{
    BatchId, CrdtType, JoinErrorCode, Permission, ProtocolMessage, UpdateStatusCode, decode, encode,
};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use typstry_wire::fragment::{Reassembler, encode_batch, random_batch_id};

use crate::api::install_crypto_provider;

/// Same interval as the JS client. The server drops connections that stay
/// silent for 90 s.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// What a successful join told us.
#[derive(Debug, Clone)]
pub struct Joined {
    pub permission: Permission,
    /// The server's coverage when it answered; its backfill follows.
    pub version: VersionVector,
    /// Delta records stored on the server, from the join's `extra`.
    pub deltas: u64,
}

#[derive(Debug)]
pub enum Event {
    /// One `%ELO` container, reassembled if it came in fragments.
    Update(Vec<u8>),
    Ack {
        batch: BatchId,
        status: UpdateStatusCode,
    },
    /// The server closed the connection or the socket failed.
    Closed(Option<String>),
}

pub struct Client {
    ws: Socket,
    room: String,
    fragments: Reassembler,
    last_sent: Instant,
}

impl Client {
    pub async fn connect(url: &str, room: &str) -> anyhow::Result<Self> {
        install_crypto_provider();
        let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(url))
            .await
            .with_context(|| format!("connecting to {url} timed out"))?
            .with_context(|| format!("cannot connect to {url}"))?;
        Ok(Self {
            ws,
            room: room.to_owned(),
            fragments: Reassembler::default(),
            last_sent: Instant::now(),
        })
    }

    async fn send_frame(&mut self, msg: Message) -> anyhow::Result<()> {
        self.ws
            .send(msg)
            .await
            .context("the connection to the server broke")?;
        self.last_sent = Instant::now();
        Ok(())
    }

    async fn send_message(&mut self, msg: &ProtocolMessage) -> anyhow::Result<()> {
        let bytes = encode(msg).map_err(anyhow::Error::msg)?;
        self.send_frame(Message::Binary(bytes.into())).await
    }

    /// Joins the doc room with our oplog version, so the backfill only
    /// carries what we lack. A version the server cannot read gets a
    /// retry with an empty one, which means "send everything".
    pub async fn join(&mut self, token: &str, version: &VersionVector) -> anyhow::Result<Joined> {
        let mut version = version.encode();
        loop {
            self.send_message(&ProtocolMessage::JoinRequest {
                crdt: CrdtType::Elo,
                room_id: self.room.clone(),
                auth: token.as_bytes().to_vec(),
                version: version.clone(),
            })
            .await?;
            match self.recv_control().await? {
                ProtocolMessage::JoinResponseOk {
                    permission,
                    version,
                    extra,
                    ..
                } => {
                    let version = if version.is_empty() {
                        VersionVector::new()
                    } else {
                        VersionVector::decode(&version)
                            .context("the server sent an unreadable version")?
                    };
                    return Ok(Joined {
                        permission,
                        version,
                        deltas: stored_deltas(extra.as_deref()),
                    });
                }
                ProtocolMessage::JoinError {
                    code: JoinErrorCode::VersionUnknown,
                    ..
                } if !version.is_empty() => version.clear(),
                ProtocolMessage::JoinError {
                    code: JoinErrorCode::AuthFailed,
                    ..
                } => bail!("the server refused this link; it may have been revoked"),
                ProtocolMessage::JoinError { code, message, .. } => {
                    bail!("joining the project failed ({code:?}): {message}")
                }
                other => bail!("unexpected answer to the join: {other:?}"),
            }
        }
    }

    /// The join answer. Nothing else can arrive before it, since we are in
    /// no room yet.
    async fn recv_control(&mut self) -> anyhow::Result<ProtocolMessage> {
        loop {
            match self.next_event_inner(true).await? {
                Inner::Control(msg) => return Ok(msg),
                Inner::Event(Event::Closed(reason)) => {
                    bail!(
                        "the server closed the connection{}",
                        reason.map(|r| format!(": {r}")).unwrap_or_default()
                    )
                }
                Inner::Event(_) => {}
            }
        }
    }

    /// Sends one container, split into fragments when needed. The server
    /// answers with an [`Event::Ack`] carrying the returned batch id.
    pub async fn send_update(&mut self, container: &[u8]) -> anyhow::Result<BatchId> {
        let batch = random_batch_id();
        for frame in encode_batch(CrdtType::Elo, &self.room, batch, container) {
            self.send_frame(Message::Binary(frame.into())).await?;
        }
        Ok(batch)
    }

    /// The next update or ack. Keeps the connection alive while waiting,
    /// so callers can sit in here for as long as they like. Cancel safe:
    /// a frame is either fully handled or still in the socket.
    pub async fn next_event(&mut self) -> anyhow::Result<Event> {
        loop {
            if let Inner::Event(event) = self.next_event_inner(false).await? {
                return Ok(event);
            }
        }
    }

    async fn next_event_inner(&mut self, want_control: bool) -> anyhow::Result<Inner> {
        loop {
            let ping_at = self.last_sent + PING_INTERVAL;
            let frame = tokio::select! {
                frame = self.ws.next() => frame,
                () = tokio::time::sleep_until(ping_at.into()) => {
                    self.send_frame(Message::Text("ping".into())).await?;
                    for (crdt, room_id, batch_id) in self.fragments.expire(Instant::now()) {
                        tracing::debug!(?crdt, %room_id, batch = %batch_id.to_hex(), "fragments timed out");
                    }
                    continue;
                }
            };
            let bytes = match frame {
                None => return Ok(Inner::Event(Event::Closed(None))),
                Some(Err(err)) => return Ok(Inner::Event(Event::Closed(Some(err.to_string())))),
                Some(Ok(Message::Binary(bytes))) => bytes,
                Some(Ok(Message::Close(frame))) => {
                    return Ok(Inner::Event(Event::Closed(
                        frame.map(|f| format!("{} {}", u16::from(f.code), f.reason)),
                    )));
                }
                // Pongs to our pings, and websocket-level control frames
                // tungstenite already answered.
                Some(Ok(_)) => continue,
            };
            let msg = match decode(&bytes) {
                Ok(msg) => msg,
                Err(err) => {
                    tracing::warn!(%err, "ignoring an undecodable message");
                    continue;
                }
            };
            match msg {
                ProtocolMessage::DocUpdate {
                    crdt: CrdtType::Elo,
                    updates,
                    ..
                } => {
                    // The server sends one container per message; should
                    // several ever arrive together, they are merged in order.
                    let update = match <[Vec<u8>; 1]>::try_from(updates) {
                        Ok([one]) => one,
                        Err(many) if many.is_empty() => continue,
                        Err(many) => join_containers(many)?,
                    };
                    return Ok(Inner::Event(Event::Update(update)));
                }
                ProtocolMessage::DocUpdateFragmentHeader {
                    crdt,
                    room_id,
                    batch_id,
                    fragment_count,
                    total_size_bytes,
                } => {
                    if let Err(status) = self.fragments.start(
                        crdt,
                        &room_id,
                        batch_id,
                        fragment_count,
                        total_size_bytes,
                    ) {
                        tracing::warn!(?status, "dropping a fragmented update");
                    }
                }
                ProtocolMessage::DocUpdateFragment {
                    crdt,
                    room_id,
                    batch_id,
                    index,
                    fragment,
                } => match self
                    .fragments
                    .push(crdt, &room_id, batch_id, index, fragment)
                {
                    Ok(Some(update)) if crdt == CrdtType::Elo => {
                        return Ok(Inner::Event(Event::Update(update)));
                    }
                    Ok(_) => {}
                    Err(status) => tracing::warn!(?status, "dropping a fragmented update"),
                },
                ProtocolMessage::Ack {
                    crdt: CrdtType::Elo,
                    ref_id,
                    status,
                    ..
                } => {
                    return Ok(Inner::Event(Event::Ack {
                        batch: ref_id,
                        status,
                    }));
                }
                ProtocolMessage::RoomError { code, message, .. } => {
                    return Ok(Inner::Event(Event::Closed(Some(format!(
                        "room error {code:?}: {message}"
                    )))));
                }
                msg @ (ProtocolMessage::JoinResponseOk { .. }
                | ProtocolMessage::JoinError { .. })
                    if want_control =>
                {
                    return Ok(Inner::Control(msg));
                }
                _ => {}
            }
        }
    }

    pub async fn close(mut self) {
        let _ = self.ws.close(None).await;
    }
}

enum Inner {
    Control(ProtocolMessage),
    Event(Event),
}

/// Merges several containers into one, preserving record order.
fn join_containers(containers: Vec<Vec<u8>>) -> anyhow::Result<Vec<u8>> {
    let mut records = Vec::new();
    for container in &containers {
        records.extend(loro_protocol::decode_elo_container(container).map_err(anyhow::Error::msg)?);
    }
    Ok(typstry_wire::elo::encode_container(&records))
}

/// Server-provided `{"deltas": n}`; anything unexpected reads as 0, like
/// `storedDeltas` in the adaptor.
fn stored_deltas(extra: Option<&[u8]>) -> u64 {
    extra
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
        .and_then(|v| v.get("deltas")?.as_u64())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_delta_count() {
        assert_eq!(stored_deltas(Some(br#"{"deltas":250}"#)), 250);
        assert_eq!(stored_deltas(Some(b"nope")), 0);
        assert_eq!(stored_deltas(None), 0);
    }
}
