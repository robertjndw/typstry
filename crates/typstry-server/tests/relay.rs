//! The pairing relay over real WebSockets.

use std::net::SocketAddr;
use std::path::Path;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;
use typstry_server::config::Config;
use typstry_server::http::AppState;
use typstry_server::relay::RelayConfig;
use typstry_wire::relay::{
    CHANNEL_MAX, MAX_RELAY_MESSAGE, RELAY_API_PATH, RELAY_WS_PATH, close_reason,
};

mod common;

const TIMEOUT: Duration = Duration::from_secs(5);
const POLICY: u16 = 1008;
const NORMAL: u16 = 1000;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Chan {
    number: u64,
    claim: String,
}

struct Server {
    addr: SocketAddr,
    state: AppState,
    data: std::path::PathBuf,
    _task: JoinHandle<()>,
}

impl Server {
    async fn start(data: &Path) -> Self {
        Self::start_with(data, RelayConfig::default()).await
    }

    async fn start_with(data: &Path, relay: RelayConfig) -> Self {
        let pool = common::open_db(data).await;
        let config = Config {
            data_dir: data.to_owned(),
            relay,
            ..Config::default()
        };
        let state = AppState::from_config(pool, &config);
        let app = common::app(state.clone(), data);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            addr,
            state,
            data: data.to_owned(),
            _task: task,
        }
    }

    async fn allocate(&self) -> (StatusCode, Value) {
        let res = common::app(self.state.clone(), &self.data)
            .oneshot(Request::post(RELAY_API_PATH).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let body = if status == StatusCode::CREATED {
            common::json(res).await
        } else {
            Value::Null
        };
        (status, body)
    }

    async fn channel(&self) -> Chan {
        let (status, body) = self.allocate().await;
        assert_eq!(status, StatusCode::CREATED);
        Chan {
            number: body["channel"].as_u64().unwrap(),
            claim: body["claim"].as_str().unwrap().to_owned(),
        }
    }

    async fn connect(&self, query: &str) -> Ws {
        let url = format!("ws://{}{RELAY_WS_PATH}?protocol=1&{query}", self.addr);
        connect_async(url).await.unwrap().0
    }

    /// The seat only the allocator can take.
    async fn owner(&self, chan: &Chan) -> Ws {
        self.connect(&format!("channel={}&claim={}", chan.number, chan.claim))
            .await
    }

    async fn guest(&self, chan: &Chan) -> Ws {
        self.connect(&format!("channel={}", chan.number)).await
    }
}

async fn recv(ws: &mut Ws) -> Vec<u8> {
    loop {
        let msg = tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .expect("timed out")
            .expect("closed")
            .expect("error");
        match msg {
            Message::Binary(bytes) => return bytes.to_vec(),
            Message::Close(frame) => panic!("closed: {frame:?}"),
            _ => {}
        }
    }
}

/// The close code the server ends the socket with.
async fn closed_with(ws: &mut Ws) -> u16 {
    closed_because(ws).await.0
}

/// The close code and reason the server ends the socket with.
async fn closed_because(ws: &mut Ws) -> (u16, String) {
    loop {
        let msg = tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .expect("timed out");
        match msg {
            Some(Ok(Message::Close(Some(frame)))) => {
                return (frame.code.into(), frame.reason.to_string());
            }
            Some(Ok(Message::Binary(_))) => panic!("unexpected frame"),
            Some(Ok(_)) => {}
            other => panic!("ended without a close code: {other:?}"),
        }
    }
}

async fn send(ws: &mut Ws, bytes: &[u8]) {
    ws.send(Message::Binary(bytes.to_vec().into()))
        .await
        .unwrap();
}

#[tokio::test]
async fn allocates_a_free_channel() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (status, body) = server.allocate().await;
    assert_eq!(status, StatusCode::CREATED);
    let number = body["channel"].as_u64().unwrap();
    assert!((1..=u64::from(CHANNEL_MAX)).contains(&number));
    assert_eq!(body["expiresIn"], 300);
    assert_eq!(body["claim"].as_str().unwrap().len(), 22);
    let two = server.channel().await;
    assert_ne!(two.number, number);

    // Using up a channel frees it.
    let mut a = server.owner(&two).await;
    let b = server.guest(&two).await;
    drop(b);
    assert_eq!(closed_with(&mut a).await, NORMAL);
    assert_eq!(server.state.relay.open_channels(), 1);
}

#[tokio::test]
async fn relays_both_ways_and_holds_an_early_frame() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;

    let mut first = server.owner(&channel).await;
    send(&mut first, b"early one").await;
    send(&mut first, b"early two").await;
    // Let the frames reach the server before the second peer exists.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut second = server.guest(&channel).await;
    assert_eq!(recv(&mut second).await, b"early one");
    assert_eq!(recv(&mut second).await, b"early two");

    send(&mut second, b"back").await;
    assert_eq!(recv(&mut first).await, b"back");
    send(&mut first, b"forth").await;
    assert_eq!(recv(&mut second).await, b"forth");
}

#[tokio::test]
async fn rejects_a_third_peer_without_disturbing_the_pair() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    let mut second = server.guest(&channel).await;
    send(&mut first, b"hello").await;
    assert_eq!(recv(&mut second).await, b"hello");

    let mut third = server.guest(&channel).await;
    assert_eq!(closed_with(&mut third).await, POLICY);

    send(&mut second, b"still here").await;
    assert_eq!(recv(&mut first).await, b"still here");
}

#[tokio::test]
async fn rejects_unknown_and_malformed_channels() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    for query in ["channel=7", "channel=0", "channel=10000", "channel=x", ""] {
        let mut ws = server.connect(query).await;
        assert_eq!(closed_with(&mut ws).await, POLICY, "{query:?}");
    }
}

#[tokio::test]
async fn a_channel_is_gone_once_a_peer_leaves() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    let mut second = server.guest(&channel).await;
    send(&mut first, b"x").await;
    recv(&mut second).await;

    first.close(None).await.unwrap();
    assert_eq!(closed_with(&mut second).await, NORMAL);

    let mut again = server.guest(&channel).await;
    assert_eq!(closed_with(&mut again).await, POLICY);
    assert_eq!(server.state.relay.open_channels(), 0);
}

#[tokio::test]
async fn a_lone_peer_leaving_frees_the_channel() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    first.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut again = server.guest(&channel).await;
    assert_eq!(closed_with(&mut again).await, POLICY);
}

#[tokio::test]
async fn unjoined_channels_expire() {
    let dir = tempfile::tempdir().unwrap();
    let relay = RelayConfig {
        ttl: Duration::from_millis(300),
    };
    let server = Server::start_with(dir.path(), relay).await;
    let channel = server.channel().await;
    tokio::time::sleep(Duration::from_millis(400)).await;

    let mut late = server.guest(&channel).await;
    assert_eq!(closed_with(&mut late).await, POLICY);
    // The expired channel no longer counts.
    server.channel().await;
    assert_eq!(server.state.relay.open_channels(), 1);
}

#[tokio::test]
async fn a_pair_is_cut_off_at_the_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let relay = RelayConfig {
        ttl: Duration::from_millis(300),
    };
    let server = Server::start_with(dir.path(), relay).await;
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    let mut second = server.guest(&channel).await;
    send(&mut first, b"in time").await;
    assert_eq!(recv(&mut second).await, b"in time");

    tokio::time::sleep(Duration::from_millis(400)).await;
    send(&mut first, b"too late").await;
    assert_eq!(closed_with(&mut first).await, POLICY);
    assert_eq!(closed_with(&mut second).await, POLICY);
}

#[tokio::test]
async fn oversized_frames_end_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    let mut second = server.guest(&channel).await;
    send(&mut first, &vec![0; MAX_RELAY_MESSAGE + 1]).await;
    assert_eq!(closed_with(&mut second).await, NORMAL);
}

#[tokio::test]
async fn a_squatter_cannot_take_the_first_seat() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let channel = server.channel().await;

    // Without the claim, or with a wrong one, only the guest seat is open.
    let mut wrong = server
        .connect(&format!("channel={}&claim=nope", channel.number))
        .await;
    assert_eq!(closed_with(&mut wrong).await, POLICY);

    // The squatter got there first and said something; the owner still
    // gets the owner seat and sees it.
    let mut squatter = server.guest(&channel).await;
    send(&mut squatter, b"from the guest").await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut owner = server.owner(&channel).await;
    assert_eq!(recv(&mut owner).await, b"from the guest");
    send(&mut owner, b"from the owner").await;
    assert_eq!(recv(&mut squatter).await, b"from the owner");

    // A second claimant has no seat left.
    let mut other = server.owner(&channel).await;
    assert_eq!(closed_with(&mut other).await, POLICY);
}

#[tokio::test]
async fn a_lone_peer_cannot_pile_up_frames() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;

    // A key exchange message is a few dozen bytes; a few more frames than
    // that is all the server holds for a peer that is not there yet.
    let channel = server.channel().await;
    let mut chatty = server.owner(&channel).await;
    for _ in 0..5 {
        send(&mut chatty, b"anyone?").await;
    }
    assert_eq!(
        closed_because(&mut chatty).await,
        (POLICY, close_reason::TOO_MANY_FRAMES.to_owned())
    );

    let channel = server.channel().await;
    let mut bulky = server.owner(&channel).await;
    send(&mut bulky, &vec![0; 4 * 1024 + 1]).await;
    assert_eq!(
        closed_because(&mut bulky).await,
        (POLICY, close_reason::TOO_MANY_FRAMES.to_owned())
    );
    assert_eq!(server.state.relay.held_bytes(), 0);

    // Once both are there, the same frames pass.
    let channel = server.channel().await;
    let mut first = server.owner(&channel).await;
    let mut second = server.guest(&channel).await;
    let big = vec![7; 32 * 1024];
    send(&mut first, &big).await;
    assert_eq!(recv(&mut second).await, big);
}

#[tokio::test]
async fn expired_channels_are_swept_without_an_allocation() {
    let dir = tempfile::tempdir().unwrap();
    let relay = RelayConfig {
        ttl: Duration::from_millis(300),
    };
    let server = Server::start_with(dir.path(), relay).await;
    let channel = server.channel().await;
    let mut waiting = server.owner(&channel).await;
    send(&mut waiting, b"first message").await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(server.state.relay.held_bytes() > 0);

    // Nobody allocates or sends; the sweeper alone tells the peer and lets
    // go of what it held.
    assert_eq!(
        closed_because(&mut waiting).await,
        (POLICY, close_reason::EXPIRED.to_owned())
    );
    assert_eq!(server.state.relay.open_channels(), 0);
    assert_eq!(server.state.relay.held_bytes(), 0);
}
