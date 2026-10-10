//! The WebSocket transport: Loro Protocol messages for the `%ELO` room of
//! one project, with fragmentation and the text keepalive the JS client
//! uses (`apps/web/src/sync/connection.ts` via `loro-websocket`).
//!
//! The socket lives in a task of its own, which keeps it alive (pings,
//! fragment expiry) no matter what the caller is busy with: a full rescan
//! or a big upload can take longer than the server waits for a silent
//! client. [`Client`] talks to that task through channels.
//!
//! This layer knows nothing about the doc or encryption; [`crate::engine`]
//! decides what to send and what an update means.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use loro::VersionVector;
use loro_protocol::{
    BatchId, CrdtType, JoinErrorCode, Permission, ProtocolMessage, UpdateStatusCode, decode, encode,
};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use typstry_wire::fragment::{Reassembler, encode_batch, random_batch_id};

use crate::api::install_crypto_provider;

/// Same interval as the JS client. The server drops connections that stay
/// silent for 90 s.
pub const PING_INTERVAL: Duration = Duration::from_secs(30);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long one frame may take to go out. A dead connection with a full
/// send buffer would otherwise hold the socket task in a write until the
/// OS gives up, which can take many minutes. Generous, since fragments are
/// small and only a hopeless link needs this long.
const SEND_TIMEOUT: Duration = Duration::from_secs(60);

/// How long saying goodbye may take, so disconnecting stays quick even
/// when the socket task is stuck or the server never answers.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Events the socket task may get ahead of the caller. Past that it stops
/// reading the socket, so a server cannot fill our memory while the caller
/// is busy, but it keeps pinging.
const EVENT_BUFFER: usize = 16;

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
    /// One `%ELO` container, reassembled if it came in fragments. Not
    /// looked into here: the bytes come from the server, so splitting
    /// them into records is left to the code that validates them.
    Update(Vec<u8>),
    Ack {
        batch: BatchId,
        status: UpdateStatusCode,
    },
    /// The server closed the connection or the socket failed.
    Closed(Option<String>),
}

enum Command {
    /// Sends a join request; the next join answer goes to `reply`.
    Join {
        request: Vec<u8>,
        reply: oneshot::Sender<Result<ProtocolMessage, Option<String>>>,
    },
    Send {
        container: Vec<u8>,
        reply: oneshot::Sender<anyhow::Result<BatchId>>,
    },
    Close(oneshot::Sender<()>),
}

pub struct Client {
    commands: mpsc::UnboundedSender<Command>,
    events: mpsc::Receiver<Event>,
    room: String,
}

impl Client {
    pub async fn connect(url: &str, room: &str) -> anyhow::Result<Self> {
        install_crypto_provider();
        let (ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(url))
            .await
            .with_context(|| format!("connecting to {url} timed out"))?
            .with_context(|| format!("cannot connect to {url}"))?;
        Ok(Self::spawn(ws, room))
    }

    fn spawn(ws: Socket, room: &str) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (event_tx, events) = mpsc::channel(EVENT_BUFFER);
        let actor = Actor {
            ws,
            room: room.to_owned(),
            fragments: Reassembler::default(),
            last_sent: Instant::now(),
            events: event_tx,
            queued: VecDeque::new(),
            join: None,
        };
        tokio::spawn(actor.run(command_rx));
        Self {
            commands,
            events,
            room: room.to_owned(),
        }
    }

    /// Joins the doc room with our oplog version, so the backfill only
    /// carries what we lack. A version the server cannot read gets a
    /// retry with an empty one, which means "send everything".
    pub async fn join(&mut self, token: &str, version: &VersionVector) -> anyhow::Result<Joined> {
        let mut version = version.encode();
        loop {
            let request = encode(&ProtocolMessage::JoinRequest {
                crdt: CrdtType::Elo,
                room_id: self.room.clone(),
                auth: token.as_bytes().to_vec(),
                version: version.clone(),
            })
            .map_err(anyhow::Error::msg)?;
            let (reply, answer) = oneshot::channel();
            self.command(Command::Join { request, reply })?;
            let answer = match answer.await {
                Ok(Ok(msg)) => msg,
                Ok(Err(reason)) => {
                    bail!("the server closed the connection{}", reason_suffix(reason))
                }
                Err(_) => bail!("the server closed the connection"),
            };
            match answer {
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
                } => return Err(crate::engine::SyncError::LinkRefused.into()),
                ProtocolMessage::JoinError { code, message, .. } => {
                    bail!("joining the project failed ({code:?}): {message}")
                }
                other => bail!("unexpected answer to the join: {other:?}"),
            }
        }
    }

    fn command(&self, command: Command) -> anyhow::Result<()> {
        self.commands
            .send(command)
            .map_err(|_| anyhow::anyhow!("the connection to the server broke"))
    }

    /// Sends one container, split into fragments when needed. The server
    /// answers with an [`Event::Ack`] carrying the returned batch id.
    pub async fn send_update(&mut self, container: &[u8]) -> anyhow::Result<BatchId> {
        let (reply, sent) = oneshot::channel();
        self.command(Command::Send {
            container: container.to_vec(),
            reply,
        })?;
        sent.await
            .map_err(|_| anyhow::anyhow!("the connection to the server broke"))?
    }

    /// The next update or ack. The socket task keeps the connection alive
    /// whether or not anyone waits here. Cancel safe.
    pub async fn next_event(&mut self) -> Event {
        self.events.recv().await.unwrap_or(Event::Closed(None))
    }

    /// Sends a close frame, so the server sees a goodbye rather than a
    /// dropped socket. Gives up after [`CLOSE_TIMEOUT`]; a socket task
    /// stuck in a send then ends on its own once [`SEND_TIMEOUT`] passes.
    pub async fn close(self) {
        let (reply, done) = oneshot::channel();
        if self.commands.send(Command::Close(reply)).is_ok() {
            let _ = tokio::time::timeout(CLOSE_TIMEOUT, done).await;
        }
    }
}

fn reason_suffix(reason: Option<String>) -> String {
    reason.map(|r| format!(": {r}")).unwrap_or_default()
}

enum Wake {
    Command(Option<Command>),
    Permit(Option<mpsc::OwnedPermit<Event>>),
    Ping,
    Frame(Option<Result<Message, tokio_tungstenite::tungstenite::Error>>),
}

/// The task that owns the socket.
struct Actor {
    ws: Socket,
    room: String,
    fragments: Reassembler,
    last_sent: Instant,
    events: mpsc::Sender<Event>,
    /// Events from the last frame that did not fit the channel yet. The
    /// socket is only read once they are out.
    queued: VecDeque<Event>,
    /// Waiting for the answer to a join.
    join: Option<oneshot::Sender<Result<ProtocolMessage, Option<String>>>>,
}

impl Actor {
    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        let reason = loop {
            let ping_at = self.last_sent + PING_INTERVAL;
            let reading = self.queued.is_empty();
            let wake = tokio::select! {
                // Commands first, so a close is never stuck behind a busy
                // socket.
                biased;
                command = commands.recv() => Wake::Command(command),
                permit = self.events.clone().reserve_owned(), if !reading => Wake::Permit(permit.ok()),
                () = tokio::time::sleep_until(ping_at.into()) => Wake::Ping,
                frame = self.ws.next(), if reading => Wake::Frame(frame),
            };
            let result = match wake {
                Wake::Command(Some(Command::Join { request, reply })) => {
                    self.join = Some(reply);
                    self.send_frame(Message::Binary(request.into())).await
                }
                Wake::Command(Some(Command::Send { container, reply })) => {
                    let result = self.send_update(&container).await;
                    let failed = result.as_ref().err().map(|err| anyhow::anyhow!("{err:#}"));
                    let _ = reply.send(result);
                    failed.map_or(Ok(()), Err)
                }
                Wake::Command(Some(Command::Close(done))) => {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, self.ws.close(None)).await;
                    let _ = done.send(());
                    return;
                }
                // The client was dropped without closing.
                Wake::Command(None) => {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, self.ws.close(None)).await;
                    return;
                }
                Wake::Permit(Some(permit)) => {
                    permit.send(self.queued.pop_front().expect("not reading"));
                    Ok(())
                }
                // Nobody listens anymore; a close or a dropped client
                // follows as a command.
                Wake::Permit(None) => {
                    self.queued.clear();
                    Ok(())
                }
                Wake::Ping => {
                    for (crdt, room_id, batch_id) in self.fragments.expire(Instant::now()) {
                        tracing::debug!(?crdt, %room_id, batch = %batch_id.to_hex(), "fragments timed out");
                    }
                    self.send_frame(Message::Text("ping".into())).await
                }
                Wake::Frame(None) => break None,
                Wake::Frame(Some(Err(err))) => break Some(err.to_string()),
                Wake::Frame(Some(Ok(Message::Binary(bytes)))) => match self.on_message(&bytes) {
                    Ok(()) => Ok(()),
                    Err(reason) => break Some(reason),
                },
                Wake::Frame(Some(Ok(Message::Close(frame)))) => {
                    break frame.map(|f| format!("{} {}", u16::from(f.code), f.reason));
                }
                // Pongs to our pings, and websocket-level control frames
                // tungstenite already answered.
                Wake::Frame(Some(Ok(_))) => Ok(()),
            };
            if let Err(err) = result {
                break Some(format!("{err:#}"));
            }
        };
        self.closed(reason, commands).await;
    }

    /// The socket is gone. What was received still reaches the caller,
    /// then [`Event::Closed`]; commands from then on fail.
    async fn closed(
        mut self,
        reason: Option<String>,
        mut commands: mpsc::UnboundedReceiver<Command>,
    ) {
        if let Some(join) = self.join.take() {
            let _ = join.send(Err(reason.clone()));
        }
        self.queued.push_back(Event::Closed(reason));
        loop {
            tokio::select! {
                biased;
                command = commands.recv() => match command {
                    Some(Command::Close(done)) => {
                        let _ = done.send(());
                        return;
                    }
                    Some(Command::Join { reply, .. }) => {
                        let _ = reply.send(Err(None));
                    }
                    // Dropping the reply tells the sender the connection
                    // broke.
                    Some(Command::Send { .. }) => {}
                    None => return,
                },
                permit = self.events.clone().reserve_owned(), if !self.queued.is_empty() => match permit {
                    Ok(permit) => {
                        permit.send(self.queued.pop_front().expect("checked"));
                    }
                    Err(_) => self.queued.clear(),
                },
            }
        }
    }

    async fn send_frame(&mut self, msg: Message) -> anyhow::Result<()> {
        tokio::time::timeout(SEND_TIMEOUT, self.ws.send(msg))
            .await
            .map_err(|_| anyhow::anyhow!("the server stopped taking data"))?
            .context("the connection to the server broke")?;
        self.last_sent = Instant::now();
        Ok(())
    }

    async fn send_update(&mut self, container: &[u8]) -> anyhow::Result<BatchId> {
        let batch = random_batch_id();
        for frame in encode_batch(CrdtType::Elo, &self.room, batch, container) {
            self.send_frame(Message::Binary(frame.into())).await?;
        }
        Ok(batch)
    }

    /// Queues what one protocol message means for the caller. Fails with
    /// the reason when the server ends our membership in the room.
    fn on_message(&mut self, bytes: &[u8]) -> Result<(), String> {
        let msg = match decode(bytes) {
            Ok(msg) => msg,
            Err(err) => {
                tracing::warn!(%err, "ignoring an undecodable message");
                return Ok(());
            }
        };
        match msg {
            ProtocolMessage::DocUpdate {
                crdt: CrdtType::Elo,
                updates,
                ..
            } => {
                // The server sends one container per message. Should
                // several ever arrive together, each is imported on its
                // own, in order.
                self.queued.extend(updates.into_iter().map(Event::Update));
            }
            ProtocolMessage::DocUpdateFragmentHeader {
                crdt,
                room_id,
                batch_id,
                fragment_count,
                total_size_bytes,
            } => {
                if let Err(status) =
                    self.fragments
                        .start(crdt, &room_id, batch_id, fragment_count, total_size_bytes)
                {
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
                    self.queued.push_back(Event::Update(update));
                }
                Ok(_) => {}
                Err(status) => tracing::warn!(?status, "dropping a fragmented update"),
            },
            ProtocolMessage::Ack {
                crdt: CrdtType::Elo,
                ref_id,
                status,
                ..
            } => self.queued.push_back(Event::Ack {
                batch: ref_id,
                status,
            }),
            ProtocolMessage::RoomError { code, message, .. } => {
                return Err(format!("room error {code:?}: {message}"));
            }
            msg @ (ProtocolMessage::JoinResponseOk { .. } | ProtocolMessage::JoinError { .. }) => {
                // Only a join waits for these; nothing else can arrive
                // before its answer, since we are in no room yet.
                if let Some(join) = self.join.take() {
                    let _ = join.send(Ok(msg));
                }
            }
            _ => {}
        }
        Ok(())
    }
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

    /// A container claiming 2^60 records must not make the client reserve
    /// memory for all of them. Containers are passed on as they came, and
    /// the parser that checks them refuses this one.
    #[tokio::test]
    async fn passes_containers_through_unparsed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let mut hostile = loro_protocol::BytesWriter::new();
        hostile.push_uleb128(1 << 60);
        let hostile = hostile.finalize();
        let good = typstry_wire::elo::encode_container(&[b"record"]);
        let updates = vec![hostile.clone(), good.clone()];
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let msg = encode(&ProtocolMessage::DocUpdate {
                crdt: CrdtType::Elo,
                room_id: "room".into(),
                updates,
                batch_id: random_batch_id(),
            })
            .unwrap();
            ws.send(Message::Binary(msg.into())).await.unwrap();
            // Keeps the socket open until the client is done.
            while ws.next().await.is_some() {}
        });
        let mut client = Client::connect(&url, "room").await.unwrap();
        for expected in [&hostile, &good] {
            match client.next_event().await {
                Event::Update(bytes) => assert_eq!(&bytes, expected),
                other => panic!("expected an update, got {other:?}"),
            }
        }
        assert!(typstry_wire::elo::decode_container(&hostile).is_err());
        client.close().await;
    }

    /// A server that never reads fills the send buffer, which leaves the
    /// socket task blocked in a send. Closing must not wait on that.
    #[tokio::test]
    async fn close_is_bounded_when_the_socket_is_stuck() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (accepted, held) = oneshot::channel();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            let _ = accepted.send(());
            // Holds the socket open without ever reading it.
            tokio::time::sleep(Duration::from_secs(600)).await;
            drop(ws);
        });
        let mut client = Client::connect(&url, "room").await.unwrap();
        held.await.unwrap();
        let update = vec![7u8; 1 << 20];
        let mut stuck = false;
        for _ in 0..512 {
            let sent = client.send_update(&update);
            if tokio::time::timeout(Duration::from_millis(500), sent)
                .await
                .is_err()
            {
                stuck = true;
                break;
            }
        }
        assert!(stuck, "the send buffer never filled up");
        let started = Instant::now();
        client.close().await;
        assert!(started.elapsed() < CLOSE_TIMEOUT + Duration::from_secs(2));
    }

    #[test]
    fn reads_the_delta_count() {
        assert_eq!(stored_deltas(Some(br#"{"deltas":250}"#)), 250);
        assert_eq!(stored_deltas(Some(b"nope")), 0);
        assert_eq!(stored_deltas(None), 0);
    }
}
