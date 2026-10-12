//! The MLS delivery service over a real WebSocket. The server has no MLS
//! library, so the commits here are hand-built RFC 9420 prefixes followed
//! by junk, which is all it ever looks at.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures_util::{SinkExt, StreamExt};
use loro_protocol::{BatchId, CrdtType, JoinErrorCode, ProtocolMessage, decode, encode};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tower::ServiceExt;
use typstry_server::http::AppState;
use typstry_server::room::{DsConfig, Outbox, RoomCmd, RoomConfig};
use typstry_server::store::docs;
use typstry_server::store::mls;
use typstry_server::store::projects::Permission as Access;
use typstry_server::ws::ConnLimits;
use typstry_wire::ds::{ClientMessage, DS_PATH, Permission, RefusalCode, Rotate, ServerMessage};
use typstry_wire::elo::{encode_container, encode_delta_header, encode_record};
use typstry_wire::owner::{OwnerKey, OwnerSecret, RotationClaim};

mod common;

const TIMEOUT: Duration = Duration::from_secs(5);
/// 16 bytes of project id and the incarnation as a big-endian u32.
const GROUP: &[u8] = b"typstry-test-grp\0\0\0\0";
const GROUP_1: &[u8] = b"typstry-test-grp\0\0\0\x01";

struct Server {
    addr: SocketAddr,
    state: AppState,
    data: PathBuf,
    _task: JoinHandle<()>,
}

impl Server {
    async fn start(data: &Path) -> Self {
        Self::start_with(data, DsConfig::default()).await
    }

    async fn start_with(data: &Path, ds: DsConfig) -> Self {
        let rooms = RoomConfig {
            ds,
            ..RoomConfig::default()
        };
        let common::Served { addr, state, task } =
            common::serve(data, rooms, ConnLimits::default()).await;
        Self {
            addr,
            state,
            data: data.to_owned(),
            _task: task,
        }
    }

    fn app(&self) -> axum::Router {
        common::app(self.state.clone(), &self.data)
    }

    async fn project(&self) -> common::Created {
        common::create_project(self.app()).await
    }

    async fn get(&self, path: &str) -> (StatusCode, Value) {
        let res = self
            .app()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        if status != StatusCode::OK {
            return (status, Value::Null);
        }
        (status, common::json(res).await)
    }

    async fn ds(&self) -> Ds {
        let (ws, _) = connect_async(format!("ws://{}{DS_PATH}", self.addr))
            .await
            .unwrap();
        Ds { ws }
    }

    /// A joined client of the given token, caught up from epoch 0.
    async fn session(&self, token: &str) -> Ds {
        let mut ds = self.ds().await;
        let ready = ds.hello(token, 0, 0).await;
        assert!(matches!(ready, ServerMessage::Ready { .. }), "{ready:?}");
        ds
    }

    /// Opens a doc or presence socket and joins `room` with `token`.
    async fn doc(&self, crdt: CrdtType, room: &str, token: &str) -> (Doc, ProtocolMessage) {
        let (mut ws, _) = connect_async(format!("ws://{}/ws", self.addr))
            .await
            .unwrap();
        let join = ProtocolMessage::JoinRequest {
            crdt,
            room_id: room.to_owned(),
            auth: token.as_bytes().to_vec(),
            version: Vec::new(),
        };
        ws.send(Message::Binary(encode(&join).unwrap().into()))
            .await
            .unwrap();
        let reply = match tokio::time::timeout(TIMEOUT, ws.next()).await.unwrap() {
            Some(Ok(Message::Binary(bytes))) => decode(&bytes).unwrap(),
            other => panic!("expected a join answer, got {other:?}"),
        };
        (Doc { ws }, reply)
    }
}

struct Doc {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Doc {
    /// Fails if the server closes the socket within a moment.
    async fn assert_open(&mut self) {
        match tokio::time::timeout(Duration::from_millis(200), self.ws.next()).await {
            Err(_) => {}
            Ok(Some(Ok(Message::Close(frame)))) => panic!("closed: {frame:?}"),
            Ok(other) => panic!("unexpected socket event {other:?}"),
        }
    }

    /// The close code and reason of the next close frame.
    async fn closed(&mut self) -> (u16, String) {
        loop {
            match tokio::time::timeout(TIMEOUT, self.ws.next()).await.unwrap() {
                Some(Ok(Message::Close(Some(frame)))) => {
                    return (u16::from(frame.code), frame.reason.to_string());
                }
                Some(Ok(_)) => {}
                other => panic!("expected a close frame, got {other:?}"),
            }
        }
    }
}

struct Ds {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Ds {
    async fn send(&mut self, msg: ClientMessage) {
        self.ws
            .send(Message::Binary(msg.encode().into()))
            .await
            .unwrap();
    }

    async fn try_recv(&mut self, wait: Duration) -> Option<ServerMessage> {
        loop {
            match tokio::time::timeout(wait, self.ws.next()).await.ok()? {
                Some(Ok(Message::Binary(bytes))) => {
                    return Some(ServerMessage::decode(&bytes).unwrap());
                }
                Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_))) => {}
                other => panic!("unexpected socket event {other:?}"),
            }
        }
    }

    async fn recv(&mut self) -> ServerMessage {
        self.try_recv(TIMEOUT).await.expect("timed out")
    }

    async fn hello(&mut self, token: &str, incarnation: u64, since_epoch: u64) -> ServerMessage {
        self.send(ClientMessage::Hello {
            token: token.to_owned(),
            incarnation,
            since_epoch,
        })
        .await;
        self.recv().await
    }

    /// Sends a request and returns its answer, setting aside the relayed
    /// messages that arrive first.
    async fn request(&mut self, msg: ClientMessage) -> (ServerMessage, Vec<ServerMessage>) {
        self.send(msg).await;
        self.answer().await
    }

    async fn answer(&mut self) -> (ServerMessage, Vec<ServerMessage>) {
        let mut others = Vec::new();
        loop {
            let msg = self.recv().await;
            if matches!(
                msg,
                ServerMessage::Accepted { .. }
                    | ServerMessage::Conflict { .. }
                    | ServerMessage::Refused { .. }
            ) {
                return (msg, others);
            }
            others.push(msg);
        }
    }

    async fn assert_quiet(&mut self) {
        if let Some(msg) = self.try_recv(Duration::from_millis(200)).await {
            panic!("expected silence, got {msg:?}");
        }
    }

    async fn closed(&mut self) -> (u16, String) {
        loop {
            match tokio::time::timeout(TIMEOUT, self.ws.next()).await.unwrap() {
                Some(Ok(Message::Close(Some(frame)))) => {
                    return (u16::from(frame.code), frame.reason.to_string());
                }
                Some(Ok(_)) => {}
                other => panic!("expected a close frame, got {other:?}"),
            }
        }
    }
}

fn vec_header(len: usize) -> Vec<u8> {
    match len {
        0..64 => vec![len as u8],
        _ => (0x4000u16 | len as u16).to_be_bytes().to_vec(),
    }
}

enum From {
    Member,
    NewMember,
}

/// A PublicMessage commit by the given kind of sender, followed by junk.
fn public_commit(group_id: &[u8], epoch: u64, from: From) -> Vec<u8> {
    let mut out = vec![0, 1, 0, 1];
    out.extend(vec_header(group_id.len()));
    out.extend(group_id);
    out.extend(epoch.to_be_bytes());
    match from {
        From::Member => out.extend([1, 0, 0, 0, 7]),
        From::NewMember => out.push(4),
    }
    out.push(0); // authenticated_data
    out.push(3); // commit
    out.extend(b"opaque");
    out
}

fn private_commit(group_id: &[u8], epoch: u64) -> Vec<u8> {
    let mut out = vec![0, 1, 0, 2];
    out.extend(vec_header(group_id.len()));
    out.extend(group_id);
    out.extend(epoch.to_be_bytes());
    out.push(3);
    out.extend(b"opaque");
    out
}

fn submit(req: u64, epoch: u64, commit: Vec<u8>) -> ClientMessage {
    ClientMessage::Submit {
        req,
        epoch,
        commit,
        group_info: b"gi".to_vec(),
        keyring: None,
        envelope: None,
        rotate: None,
    }
}

/// A fixed owner key per `n`, so a test can name the keys of a chain.
fn owner(n: u8) -> OwnerSecret {
    OwnerSecret::import(&[&[1][..], &[n; 32]].concat()).unwrap()
}

fn init(req: u64) -> ClientMessage {
    ClientMessage::Init {
        req,
        group_id: GROUP.to_vec(),
        group_info: b"gi-0".to_vec(),
        keyring: b"keyring-0".to_vec(),
        owner_key: owner(1).public(),
    }
}

/// A rotation from the group's first owner key to the second, as the owner
/// sends it.
fn rotation(req: u64, epoch: u64, edit: &str, view: &str) -> ClientMessage {
    signed_rotation(
        req,
        GROUP,
        epoch,
        (edit, view),
        &owner(1),
        &owner(2).public(),
    )
}

fn signed_rotation(
    req: u64,
    group: &[u8],
    epoch: u64,
    (edit, view): (&str, &str),
    by: &OwnerSecret,
    next: &OwnerKey,
) -> ClientMessage {
    let mut msg = ClientMessage::Submit {
        req,
        epoch,
        commit: private_commit(group, epoch),
        group_info: b"gi-rotated".to_vec(),
        keyring: Some(b"keyring-rotated".to_vec()),
        envelope: Some(b"envelope".to_vec()),
        rotate: Some(Rotate {
            edit_token: edit.to_owned(),
            view_token: view.to_owned(),
            next_owner_key: *next,
            owner_proof: [0; 64],
        }),
    };
    sign(&mut msg, group, by, |_| {});
    msg
}

/// Signs a rotation with `by`, over its claim as `tweak` leaves it, so a
/// test can sign something other than what it sends.
fn sign(
    msg: &mut ClientMessage,
    group: &[u8],
    by: &OwnerSecret,
    tweak: impl for<'c> FnOnce(&mut RotationClaim<'c>),
) {
    let ClientMessage::Submit {
        epoch,
        commit,
        group_info,
        keyring,
        envelope,
        rotate: Some(rotate),
        ..
    } = msg
    else {
        panic!("not a rotation");
    };
    let proof = {
        let mut claim = RotationClaim {
            group_id: group,
            epoch: *epoch,
            commit,
            group_info,
            keyring: keyring.as_deref().unwrap_or_default(),
            envelope: envelope.as_deref().unwrap_or_default(),
            edit_token: &rotate.edit_token,
            view_token: &rotate.view_token,
            next_owner_key: &rotate.next_owner_key,
        };
        tweak(&mut claim);
        by.sign(&claim)
    };
    rotate.owner_proof = proof;
}

fn accepted(req: u64) -> ServerMessage {
    ServerMessage::Accepted { req }
}

fn refused(req: u64, code: RefusalCode) -> ServerMessage {
    ServerMessage::Refused { req, code }
}

async fn inited(server: &Server) -> (common::Created, Ds) {
    let project = server.project().await;
    let mut ds = server.session(&project.edit).await;
    assert_eq!(ds.request(init(1)).await.0, accepted(1));
    (project, ds)
}

#[tokio::test]
async fn a_group_is_created_once() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let project = server.project().await;
    let bootstrap = format!("/api/p/{}/mls", project.edit);
    assert_eq!(server.get(&bootstrap).await.0, StatusCode::NOT_FOUND);

    let mut viewer = server.session(&project.view).await;
    assert_eq!(
        viewer.request(init(1)).await.0,
        refused(1, RefusalCode::Forbidden)
    );
    // Nothing to commit to yet.
    assert_eq!(
        viewer
            .request(submit(2, 0, public_commit(GROUP, 0, From::NewMember)))
            .await
            .0,
        refused(2, RefusalCode::NoGroup)
    );

    let mut editor = server.session(&project.edit).await;
    // Weak owner keys, which some signatures pass for any message.
    let mut identity = [0; 32];
    identity[0] = 1;
    for (req, key) in [(6, identity), (7, [0; 32])] {
        let mut msg = init(req);
        if let ClientMessage::Init { owner_key, .. } = &mut msg {
            *owner_key = key;
        }
        assert_eq!(
            editor.request(msg).await.0,
            refused(req, RefusalCode::Malformed),
            "{key:?}"
        );
    }
    assert_eq!(editor.request(init(1)).await.0, accepted(1));
    assert_eq!(
        editor.request(init(2)).await.0,
        refused(2, RefusalCode::GroupExists)
    );
    let group = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group.owner_key, owner(1).public());

    let (status, body) = server.get(&bootstrap).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["incarnation"], 0);
    assert_eq!(body["epoch"], 0);
    assert_eq!(
        STANDARD
            .decode(body["groupInfo"].as_str().unwrap())
            .unwrap(),
        b"gi-0"
    );
    assert_eq!(
        STANDARD.decode(body["keyring"].as_str().unwrap()).unwrap(),
        b"keyring-0"
    );
    // The owner key from Init, which tells a joiner the current secret.
    assert_eq!(
        STANDARD.decode(body["ownerKey"].as_str().unwrap()).unwrap(),
        owner(1).public()
    );
    // View links bootstrap too, and unknown ones do not.
    let (status, _) = server.get(&format!("/api/p/{}/mls", project.view)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = server.get("/api/p/0000000000000000000000/mls").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_first_commit_per_epoch_wins() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut a) = inited(&server).await;
    let mut b = server.session(&project.edit).await;

    let commit_a = public_commit(GROUP, 0, From::Member);
    let commit_b = private_commit(GROUP, 0);
    let ((reply_a, seen_a), (reply_b, seen_b)) = tokio::join!(
        a.request(submit(10, 0, commit_a.clone())),
        b.request(submit(20, 0, commit_b.clone())),
    );
    let outcomes = [(reply_a, 10), (reply_b, 20)];
    let wins = outcomes
        .iter()
        .filter(|(reply, _)| matches!(reply, ServerMessage::Accepted { .. }))
        .count();
    assert_eq!(wins, 1, "{outcomes:?}");
    let conflicts: Vec<_> = outcomes
        .iter()
        .filter(|(reply, req)| *reply == ServerMessage::Conflict { req: *req, head: 1 })
        .collect();
    assert_eq!(conflicts.len(), 1, "{outcomes:?}");

    // The loser is told what won, either before or after its answer.
    let winner_commit = if outcomes[0].0 == accepted(10) {
        commit_a
    } else {
        commit_b
    };
    let relay = ServerMessage::Commit {
        epoch: 0,
        commit: winner_commit,
        envelope: None,
        owner_key: None,
    };
    let (mut loser, seen) = if outcomes[0].0 == accepted(10) {
        (b, seen_b)
    } else {
        (a, seen_a)
    };
    if !seen.contains(&relay) {
        assert_eq!(loser.recv().await, relay);
    }
    // The stale epoch stays refused and the head moves on one at a time.
    let (reply, _) = loser
        .request(submit(30, 0, public_commit(GROUP, 0, From::Member)))
        .await;
    assert_eq!(reply, ServerMessage::Conflict { req: 30, head: 1 });
    let (reply, _) = loser
        .request(submit(31, 1, public_commit(GROUP, 1, From::Member)))
        .await;
    assert_eq!(reply, accepted(31));
    let (reply, _) = loser
        .request(submit(32, 5, public_commit(GROUP, 5, From::Member)))
        .await;
    assert_eq!(reply, refused(32, RefusalCode::BadCommit));
}

#[tokio::test]
async fn submitted_frames_must_be_commits_for_this_group_and_epoch() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (_, mut editor) = inited(&server).await;

    let mut proposal = public_commit(GROUP, 0, From::Member);
    let content_type = proposal.len() - b"opaque".len() - 1;
    proposal[content_type] = 2;
    for (req, epoch, frame) in [
        (1, 0, b"junk".to_vec()),
        (2, 0, public_commit(b"other", 0, From::Member)),
        (3, 0, public_commit(GROUP, 1, From::Member)),
        (4, 1, public_commit(GROUP, 0, From::Member)),
        (5, 0, private_commit(b"other", 0)),
        (6, 0, proposal),
        (7, 0, vec![0, 1, 0, 3, 0, 0]),
    ] {
        let (reply, _) = editor.request(submit(req, epoch, frame)).await;
        assert_eq!(reply, refused(req, RefusalCode::BadCommit), "{req}");
    }
    let (reply, _) = editor
        .request(submit(8, 0, public_commit(GROUP, 0, From::Member)))
        .await;
    assert_eq!(reply, accepted(8));
}

#[tokio::test]
async fn view_tokens_may_only_join_with_external_commits() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let mut viewer = server.session(&project.view).await;

    let forbidden = |req| refused(req, RefusalCode::Forbidden);
    assert_eq!(
        viewer
            .request(submit(1, 0, private_commit(GROUP, 0)))
            .await
            .0,
        forbidden(1)
    );
    assert_eq!(
        viewer
            .request(submit(2, 0, public_commit(GROUP, 0, From::Member)))
            .await
            .0,
        forbidden(2)
    );
    // Neither keys, links nor an envelope ride along with a join.
    let external = public_commit(GROUP, 0, From::NewMember);
    for (req, mut msg) in [
        (3, submit(3, 0, external.clone())),
        (4, submit(4, 0, external.clone())),
        (5, submit(5, 0, external.clone())),
    ] {
        let ClientMessage::Submit {
            keyring,
            envelope,
            rotate,
            ..
        } = &mut msg
        else {
            unreachable!()
        };
        match req {
            3 => *keyring = Some(b"k".to_vec()),
            4 => *envelope = Some(b"e".to_vec()),
            _ => {
                *rotate = Some(Rotate {
                    edit_token: "a".repeat(22),
                    view_token: "b".repeat(22),
                    next_owner_key: owner(2).public(),
                    owner_proof: [0; 64],
                })
            }
        }
        assert_eq!(viewer.request(msg).await.0, forbidden(req));
    }
    let reset = ClientMessage::Reset {
        req: 7,
        incarnation: 0,
        group_id: GROUP_1.to_vec(),
        group_info: b"x".to_vec(),
        keyring: b"x".to_vec(),
    };
    assert_eq!(viewer.request(reset).await.0, forbidden(7));

    // A join with its GroupInfo is allowed and reaches the editor.
    let mut join = submit(8, 0, external.clone());
    if let ClientMessage::Submit { group_info, .. } = &mut join {
        *group_info = b"gi-1".to_vec();
    }
    assert_eq!(viewer.request(join).await.0, accepted(8));
    assert_eq!(
        editor.recv().await,
        ServerMessage::Commit {
            epoch: 0,
            commit: external,
            envelope: None,
            owner_key: None,
        }
    );
    let (_, body) = server.get(&format!("/api/p/{}/mls", project.view)).await;
    assert_eq!(body["epoch"], 1);
    assert_eq!(
        STANDARD
            .decode(body["groupInfo"].as_str().unwrap())
            .unwrap(),
        b"gi-1"
    );
}

#[tokio::test]
async fn rotation_swaps_the_links_and_retires_the_old_ones() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let mut viewer = server.session(&project.view).await;
    let mut bystander = server.session(&project.edit).await;

    let (mut doc, reply) = server.doc(CrdtType::Elo, &project.id, &project.edit).await;
    assert!(matches!(reply, ProtocolMessage::JoinResponseOk { .. }));
    let (mut presence, _) = server
        .doc(CrdtType::LoroEphemeralStore, &project.id, &project.view)
        .await;

    let (new_edit, new_view) = (common_token('E'), common_token('V'));
    let (reply, _) = editor.request(rotation(1, 0, &new_edit, &new_view)).await;
    assert_eq!(reply, accepted(1));

    // Doc and presence sockets of the old links are closed.
    assert_eq!(doc.closed().await, (4401, "link_rotated".to_owned()));
    assert_eq!(presence.closed().await, (4401, "link_rotated".to_owned()));

    // Delivery sessions are told with the commit and the new status.
    // The commit carries the owner key the rotation moved the server on to.
    let commit = ServerMessage::Commit {
        epoch: 0,
        commit: private_commit(GROUP, 0),
        envelope: Some(b"envelope".to_vec()),
        owner_key: Some(owner(2).public()),
    };
    let retired = ServerMessage::Ready {
        incarnation: 0,
        head: 1,
        permission: Permission::Retired,
        retired: Some(0),
    };
    for ds in [&mut viewer, &mut bystander] {
        assert_eq!(ds.recv().await, commit);
        assert_eq!(ds.recv().await, retired);
    }
    assert_eq!(editor.recv().await, retired);

    // Old tokens fail on the doc socket and the HTTP API.
    for token in [&project.edit, &project.view] {
        let (_, reply) = server.doc(CrdtType::Elo, &project.id, token).await;
        assert!(
            matches!(
                reply,
                ProtocolMessage::JoinError {
                    code: JoinErrorCode::AuthFailed,
                    ..
                }
            ),
            "{reply:?}"
        );
        let (status, _) = server.get(&format!("/api/p/{token}/mls")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (_, reply) = server.doc(CrdtType::Elo, &project.id, &new_edit).await;
    assert!(matches!(reply, ProtocolMessage::JoinResponseOk { .. }));
    let (status, body) = server.get(&format!("/api/p/{new_view}/mls")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["epoch"], 1);
    assert_eq!(
        STANDARD.decode(body["keyring"].as_str().unwrap()).unwrap(),
        b"keyring-rotated"
    );
    assert_eq!(
        STANDARD.decode(body["ownerKey"].as_str().unwrap()).unwrap(),
        owner(2).public()
    );

    let (status, share) = server.get(&format!("/api/share/{}", project.edit)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(share["retired"], true);
    assert_eq!(share["projectId"], project.id);
    assert!(share.get("viewToken").is_none());
    let (_, share) = server.get(&format!("/api/share/{new_edit}")).await;
    assert!(share.get("retired").is_none());
    assert_eq!(share["viewToken"], new_view);

    // A retired token can still read the log, with the envelope, and no more.
    let mut old = server.ds().await;
    assert_eq!(old.hello(&project.edit, 0, 0).await, retired);
    assert_eq!(old.recv().await, commit);
    old.assert_quiet().await;
    for (req, msg) in [
        (1, submit(1, 1, public_commit(GROUP, 1, From::Member))),
        (2, init(2)),
    ] {
        assert_eq!(old.request(msg).await.0, refused(req, RefusalCode::Retired));
    }
    old.send(ClientMessage::Fetch { since: 0 }).await;
    assert_eq!(old.recv().await, commit);

    // A new session on the new token works and sees nothing before epoch 1.
    let mut fresh = server.ds().await;
    let ready = fresh.hello(&new_edit, 0, 1).await;
    assert_eq!(
        ready,
        ServerMessage::Ready {
            incarnation: 0,
            head: 1,
            permission: Permission::Write,
            retired: None
        }
    );
    fresh.assert_quiet().await;
}

fn common_token(fill: char) -> String {
    fill.to_string().repeat(22)
}

#[tokio::test]
async fn a_rotation_that_cannot_swap_tokens_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let other = server.project().await;

    let valid = common_token('V');
    let bad = [
        ("short", valid.as_str()),
        (valid.as_str(), "not-a-token-not-a-token!"),
        // Someone else's live token, and the project's own.
        (other.edit.as_str(), valid.as_str()),
        (valid.as_str(), project.view.as_str()),
        (valid.as_str(), valid.as_str()),
    ];
    for (i, (edit, view)) in bad.into_iter().enumerate() {
        let req = i as u64 + 1;
        let (reply, others) = editor.request(rotation(req, 0, edit, view)).await;
        assert_eq!(reply, refused(req, RefusalCode::Malformed), "{edit} {view}");
        assert!(others.is_empty());
    }

    // The commit was not stored, the GroupInfo and keyring are untouched,
    // the old links still work and the epoch is still open.
    let group = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group.head_epoch, 0);
    assert_eq!(group.group_info, b"gi-0");
    assert_eq!(group.keyring, b"keyring-0");
    assert!(
        mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    let retired: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM retired_tokens")
        .fetch_one(&server.state.db)
        .await
        .unwrap();
    assert_eq!(retired, 0);
    let (_, doc_reply) = server.doc(CrdtType::Elo, &project.id, &project.edit).await;
    assert!(matches!(doc_reply, ProtocolMessage::JoinResponseOk { .. }));

    let (reply, _) = editor
        .request(submit(9, 0, public_commit(GROUP, 0, From::Member)))
        .await;
    assert_eq!(reply, accepted(9));
}

#[tokio::test]
async fn joiners_catch_up_from_the_epoch_they_are_at() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let commits: Vec<Vec<u8>> = (0..4)
        .map(|epoch| public_commit(GROUP, epoch, From::Member))
        .collect();
    for (epoch, commit) in commits.iter().enumerate() {
        let (reply, _) = editor
            .request(submit(epoch as u64, epoch as u64, commit.clone()))
            .await;
        assert_eq!(reply, accepted(epoch as u64));
    }
    let relay = |epoch: usize| ServerMessage::Commit {
        epoch: epoch as u64,
        commit: commits[epoch].clone(),
        envelope: None,
        owner_key: None,
    };

    let mut late = server.ds().await;
    let ready = late.hello(&project.view, 0, 2).await;
    assert_eq!(
        ready,
        ServerMessage::Ready {
            incarnation: 0,
            head: 4,
            permission: Permission::Read,
            retired: None
        }
    );
    assert_eq!(late.recv().await, relay(2));
    assert_eq!(late.recv().await, relay(3));
    late.assert_quiet().await;

    late.send(ClientMessage::Fetch { since: 3 }).await;
    assert_eq!(late.recv().await, relay(3));
    late.assert_quiet().await;
    late.send(ClientMessage::Fetch { since: 4 }).await;
    late.assert_quiet().await;

    // A client of another incarnation is told to start over.
    let mut stale = server.ds().await;
    stale.hello(&project.edit, 7, 0).await;
    assert_eq!(
        stale.recv().await,
        ServerMessage::Reinitialized { incarnation: 0 }
    );
}

async fn append(editor: &mut Ds, epoch: u64) {
    let (reply, _) = editor
        .request(submit(
            epoch,
            epoch,
            public_commit(GROUP, epoch, From::Member),
        ))
        .await;
    assert_eq!(reply, accepted(epoch));
}

fn epochs(commits: Vec<mls::StoredCommit>) -> Vec<u64> {
    commits.into_iter().map(|c| c.epoch).collect()
}

#[tokio::test]
async fn the_log_is_capped_by_count_even_when_young() {
    let dir = tempfile::tempdir().unwrap();
    let ds = DsConfig {
        keep_last_commits: 2,
        ..DsConfig::default()
    };
    let server = Server::start_with(dir.path(), ds).await;
    let (project, mut editor) = inited(&server).await;
    for epoch in 0..5 {
        append(&mut editor, epoch).await;
    }
    let stored = mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX);
    assert_eq!(epochs(stored.await.unwrap()), [3, 4]);

    // A client behind the log is told what it can still get, and the
    // epoch it asked for is gone.
    let mut late = server.ds().await;
    late.hello(&project.view, 0, 0).await;
    assert!(matches!(
        late.recv().await,
        ServerMessage::Commit { epoch: 3, .. }
    ));
}

#[tokio::test]
async fn old_commits_are_pruned_but_the_newest_stays() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    for epoch in 0..4 {
        append(&mut editor, epoch).await;
    }
    let stored = || mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX);
    // Young commits are kept.
    assert_eq!(epochs(stored().await.unwrap()), [0, 1, 2, 3]);

    sqlx::query("UPDATE mls_commits SET created_at = 0")
        .execute(&server.state.db)
        .await
        .unwrap();
    append(&mut editor, 4).await;
    // Everything old is gone; the newest commit is what a member one epoch
    // behind needs.
    assert_eq!(epochs(stored().await.unwrap()), [4]);
}

#[tokio::test]
async fn the_log_is_capped_by_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let probe = public_commit(GROUP, 0, From::Member).len() as u64;
    let ds = DsConfig {
        // Room for two commits and a bit.
        max_log_bytes: probe * 5 / 2,
        ..DsConfig::default()
    };
    let server = Server::start_with(dir.path(), ds).await;
    let (project, mut editor) = inited(&server).await;
    for epoch in 0..6 {
        append(&mut editor, epoch).await;
    }
    let stored = mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX);
    assert_eq!(epochs(stored.await.unwrap()), [4, 5]);

    // Even a cap below one commit keeps the newest.
    sqlx::query("UPDATE mls_commits SET data = zeroblob(10000)")
        .execute(&server.state.db)
        .await
        .unwrap();
    append(&mut editor, 6).await;
    let stored = mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX);
    assert_eq!(epochs(stored.await.unwrap()), [6]);
}

#[tokio::test]
async fn commits_and_blobs_have_size_limits() {
    let dir = tempfile::tempdir().unwrap();
    let probe = public_commit(GROUP, 0, From::Member).len();
    let ds = DsConfig {
        max_commit_bytes: probe,
        max_group_info_bytes: 16,
        ..DsConfig::default()
    };
    let server = Server::start_with(dir.path(), ds).await;
    let project = server.project().await;
    let mut editor = server.session(&project.edit).await;
    assert_eq!(editor.request(init(1)).await.0, accepted(1));

    // One byte over the commit cap.
    let mut big = public_commit(GROUP, 0, From::Member);
    big.push(0);
    assert_eq!(
        editor.request(submit(2, 0, big)).await.0,
        refused(2, RefusalCode::Malformed)
    );
    // Every commit carries the GroupInfo of the epoch it creates.
    for (req, group_info) in [(3, vec![]), (4, vec![0; 17])] {
        let mut msg = submit(req, 0, public_commit(GROUP, 0, From::Member));
        if let ClientMessage::Submit { group_info: g, .. } = &mut msg {
            *g = group_info;
        }
        assert_eq!(
            editor.request(msg).await.0,
            refused(req, RefusalCode::Malformed)
        );
    }
    let head = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(head.head_epoch, 0);

    let mut ok = submit(5, 0, public_commit(GROUP, 0, From::Member));
    if let ClientMessage::Submit { group_info, .. } = &mut ok {
        *group_info = b"gi-new".to_vec();
    }
    assert_eq!(editor.request(ok).await.0, accepted(5));
    let (_, body) = server.get(&format!("/api/p/{}/mls", project.edit)).await;
    assert_eq!(body["epoch"], 1);
    assert_eq!(
        STANDARD
            .decode(body["groupInfo"].as_str().unwrap())
            .unwrap(),
        b"gi-new"
    );
}

#[tokio::test]
async fn keyring_and_envelope_only_come_with_a_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;

    let rotate = || Rotate {
        edit_token: common_token('E'),
        view_token: common_token('V'),
        next_owner_key: owner(2).public(),
        owner_proof: [0; 64],
    };
    let blob = || Some(b"x".to_vec());
    type Parts = (Option<Rotate>, Option<Vec<u8>>, Option<Vec<u8>>);
    let cases: [Parts; 6] = [
        (None, blob(), None),
        (None, None, blob()),
        (None, blob(), blob()),
        (Some(rotate()), None, blob()),
        (Some(rotate()), blob(), None),
        (Some(rotate()), None, None),
    ];
    for (i, (rotate, keyring, envelope)) in cases.into_iter().enumerate() {
        let req = i as u64 + 1;
        let mut msg = submit(req, 0, private_commit(GROUP, 0));
        if let ClientMessage::Submit {
            rotate: r,
            keyring: k,
            envelope: e,
            ..
        } = &mut msg
        {
            (*r, *k, *e) = (rotate, keyring, envelope);
        }
        assert_eq!(
            editor.request(msg).await.0,
            refused(req, RefusalCode::Malformed),
            "case {i}"
        );
    }
    let group = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (group.head_epoch, group.keyring),
        (0, b"keyring-0".to_vec())
    );
}

#[tokio::test]
async fn retired_sessions_read_the_log_only_up_to_their_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let mut old = server.session(&project.view).await;

    let (new_edit, new_view) = (common_token('E'), common_token('V'));
    assert_eq!(
        editor.request(rotation(1, 0, &new_edit, &new_view)).await.0,
        accepted(1)
    );
    // The commit that follows is for the members of the new links.
    let mut current = server.session(&new_edit).await;
    assert_eq!(
        current
            .request(submit(2, 1, public_commit(GROUP, 1, From::Member)))
            .await
            .0,
        accepted(2)
    );

    let commit = |epoch: u64| match epoch {
        // A rotation's owner key comes back with it from the log too.
        0 => ServerMessage::Commit {
            epoch,
            commit: private_commit(GROUP, 0),
            envelope: Some(b"envelope".to_vec()),
            owner_key: Some(owner(2).public()),
        },
        _ => ServerMessage::Commit {
            epoch,
            commit: public_commit(GROUP, epoch, From::Member),
            envelope: None,
            owner_key: None,
        },
    };
    // Already connected: nothing live, and a fetch stops at the rotation.
    while let Some(msg) = old.try_recv(Duration::from_millis(200)).await {
        assert!(
            !matches!(msg, ServerMessage::Commit { epoch: 1, .. }),
            "{msg:?}"
        );
    }
    old.send(ClientMessage::Fetch { since: 0 }).await;
    assert_eq!(old.recv().await, commit(0));
    old.assert_quiet().await;

    // A new session on the retired token is held to the same epoch.
    let mut again = server.ds().await;
    again.hello(&project.view, 0, 0).await;
    assert_eq!(again.recv().await, commit(0));
    again.assert_quiet().await;

    // The current token gets all of it.
    let mut fresh = server.ds().await;
    fresh.hello(&new_edit, 0, 0).await;
    assert_eq!(fresh.recv().await, commit(0));
    assert_eq!(fresh.recv().await, commit(1));
}

#[tokio::test]
async fn retired_tokens_expire_with_the_commit_log() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let (new_edit, new_view) = (common_token('E'), common_token('V'));
    assert_eq!(
        editor.request(rotation(1, 0, &new_edit, &new_view)).await.0,
        accepted(1)
    );
    let mut current = server.session(&new_edit).await;
    let mut old = server.ds().await;
    assert!(matches!(
        old.hello(&project.edit, 0, 0).await,
        ServerMessage::Ready {
            permission: Permission::Retired,
            ..
        }
    ));

    sqlx::query("UPDATE retired_tokens SET retired_at = 0")
        .execute(&server.state.db)
        .await
        .unwrap();
    assert_eq!(
        current
            .request(submit(2, 1, public_commit(GROUP, 1, From::Member)))
            .await
            .0,
        accepted(2)
    );
    let mut gone = server.ds().await;
    assert_eq!(
        gone.hello(&project.edit, 0, 0).await,
        refused(0, RefusalCode::Forbidden)
    );
}

#[tokio::test]
async fn group_ids_must_name_the_expected_incarnation() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let project = server.project().await;
    let mut editor = server.session(&project.edit).await;

    let init_with = |req, group_id: &[u8]| ClientMessage::Init {
        req,
        group_id: group_id.to_vec(),
        group_info: b"gi".to_vec(),
        keyring: b"k".to_vec(),
        owner_key: owner(1).public(),
    };
    for (req, id) in [
        (1, b"project-0".as_slice()),
        (2, GROUP_1),
        (3, b"typstry-test-grp\0\0\0\0\0"),
        (4, b""),
    ] {
        assert_eq!(
            editor.request(init_with(req, id)).await.0,
            refused(req, RefusalCode::Malformed),
            "{id:?}"
        );
    }
    assert_eq!(editor.request(init_with(5, GROUP)).await.0, accepted(5));

    let reset_with = |req, incarnation, group_id: &[u8]| ClientMessage::Reset {
        req,
        incarnation,
        group_id: group_id.to_vec(),
        group_info: b"gi".to_vec(),
        keyring: b"k".to_vec(),
    };
    for (req, incarnation, id) in [
        // The new id must be the next incarnation of the same project.
        (6, 0, GROUP),
        (7, 0, b"typstry-test-grp\0\0\0\x02".as_slice()),
        (8, 0, b"another-project!\0\0\0\x01".as_slice()),
        (9, 0, b"short"),
        (
            10,
            u64::from(u32::MAX),
            b"typstry-test-grp\0\0\0\0".as_slice(),
        ),
        (11, u64::MAX, GROUP_1),
    ] {
        assert_eq!(
            editor.request(reset_with(req, incarnation, id)).await.0,
            refused(req, RefusalCode::Malformed),
            "{id:?}"
        );
    }
    assert_eq!(
        editor.request(reset_with(12, 0, GROUP_1)).await.0,
        accepted(12)
    );
}

#[tokio::test]
async fn a_reset_starts_a_new_incarnation() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let mut viewer = server.session(&project.view).await;
    let (reply, _) = editor
        .request(submit(1, 0, public_commit(GROUP, 0, From::Member)))
        .await;
    assert_eq!(reply, accepted(1));
    assert!(matches!(viewer.recv().await, ServerMessage::Commit { .. }));

    let reset = |req, incarnation| ClientMessage::Reset {
        req,
        incarnation,
        group_id: GROUP_1.to_vec(),
        group_info: b"gi-fresh".to_vec(),
        keyring: b"keyring-fresh".to_vec(),
    };
    let from_five = ClientMessage::Reset {
        req: 2,
        incarnation: 5,
        group_id: b"typstry-test-grp\0\0\0\x06".to_vec(),
        group_info: b"gi-fresh".to_vec(),
        keyring: b"keyring-fresh".to_vec(),
    };
    assert_eq!(
        editor.request(from_five).await.0,
        refused(2, RefusalCode::WrongIncarnation)
    );
    assert_eq!(editor.request(reset(3, 0)).await.0, accepted(3));
    assert_eq!(
        viewer.recv().await,
        ServerMessage::Reinitialized { incarnation: 1 }
    );
    // Of two editors resetting the same incarnation, the second loses.
    assert_eq!(
        editor.request(reset(4, 0)).await.0,
        refused(4, RefusalCode::WrongIncarnation)
    );

    // The old log is gone and the epoch counter starts over.
    let (_, body) = server.get(&format!("/api/p/{}/mls", project.edit)).await;
    assert_eq!(
        (body["incarnation"].as_u64(), body["epoch"].as_u64()),
        (Some(1), Some(0))
    );
    let (reply, _) = editor
        .request(submit(5, 0, public_commit(GROUP, 0, From::Member)))
        .await;
    assert_eq!(reply, refused(5, RefusalCode::BadCommit));
    let (reply, _) = editor
        .request(submit(6, 0, public_commit(GROUP_1, 0, From::Member)))
        .await;
    assert_eq!(reply, accepted(6));
    let mut fresh = server.ds().await;
    fresh.hello(&project.edit, 1, 0).await;
    assert!(matches!(
        fresh.recv().await,
        ServerMessage::Commit { epoch: 0, .. }
    ));
    fresh.assert_quiet().await;
}

#[tokio::test]
async fn bad_handshakes_are_closed() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let project = server.project().await;

    let mut ds = server.ds().await;
    let reply = ds.hello(&common_token('x'), 0, 0).await;
    assert_eq!(reply, refused(0, RefusalCode::Forbidden));
    assert_eq!(ds.closed().await, (1008, "auth_failed".to_owned()));

    // Anything before Hello is a protocol error, and so is a second Hello.
    let mut ds = server.ds().await;
    ds.send(init(1)).await;
    assert_eq!(ds.closed().await.0, 1002);
    let mut ds = server.session(&project.edit).await;
    ds.send(ClientMessage::Hello {
        token: project.edit.clone(),
        incarnation: 0,
        since_epoch: 0,
    })
    .await;
    assert_eq!(ds.closed().await.0, 1002);

    let mut ds = server.ds().await;
    ds.ws
        .send(Message::Binary(vec![0xff, 1, 2].into()))
        .await
        .unwrap();
    assert_eq!(ds.closed().await.0, 1002);
}

/// Joins `conn` to the project's doc room and returns once the room has
/// answered, which also means every command sent before has been handled.
async fn join_room(
    room: &tokio::sync::mpsc::Sender<RoomCmd>,
    conn: u64,
    token: &str,
) -> (bool, Outbox, typstry_server::room::OutboxReceiver) {
    let (outbox, rx) = Outbox::channel(64, 1 << 20, 8);
    let (reply, joined) = oneshot::channel();
    room.send(RoomCmd::Join {
        conn,
        crdt: CrdtType::Elo,
        permission: Access::Write,
        token: token.to_owned(),
        version: Vec::new(),
        outbox: outbox.clone(),
        reply,
    })
    .await
    .unwrap();
    (joined.await.unwrap(), outbox, rx)
}

fn doc_update(conn: u64, peer: u64) -> RoomCmd {
    let record = encode_record(&encode_delta_header(peer, 0, 1, "k1", &[7; 12]), b"ct");
    RoomCmd::Update {
        conn,
        crdt: CrdtType::Elo,
        batch_id: BatchId([1; 8]),
        updates: vec![Bytes::from(encode_container(&[&record]))],
    }
}

#[tokio::test]
async fn doc_updates_from_connections_that_are_not_peers_are_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut editor) = inited(&server).await;
    let room = server.state.rooms.get(&project.id).unwrap();
    let stored = || docs::record_count(&server.state.db, &project.id);

    // A connection that never joined, or already left, has no standing.
    room.send(doc_update(900, 1)).await.unwrap();
    let (joined, _outbox, _rx) = join_room(&room, 901, &project.edit).await;
    assert!(joined);
    room.send(RoomCmd::Leave {
        conn: 901,
        crdt: CrdtType::Elo,
    })
    .await
    .unwrap();
    room.send(doc_update(901, 2)).await.unwrap();

    // Neither does one whose link a rotation just retired, even though its
    // update was queued before the room closed it.
    let (joined, _outbox2, _rx2) = join_room(&room, 902, &project.edit).await;
    assert!(joined);
    let (new_edit, new_view) = (common_token('E'), common_token('V'));
    assert_eq!(
        editor.request(rotation(1, 0, &new_edit, &new_view)).await.0,
        accepted(1)
    );
    room.send(doc_update(902, 3)).await.unwrap();

    // The room has handled everything above once it answers a join.
    let (joined, _outbox3, _rx3) = join_room(&room, 903, &new_edit).await;
    assert!(joined);
    assert_eq!(stored().await.unwrap(), 0);

    // A real peer still writes.
    room.send(doc_update(903, 4)).await.unwrap();
    let (joined, _outbox4, _rx4) = join_room(&room, 904, &new_edit).await;
    assert!(joined);
    assert_eq!(stored().await.unwrap(), 1);
}

/// What a refused rotation must leave alone: the head, the log, the owner
/// key and the tokens.
async fn assert_untouched(server: &Server, project: &common::Created) {
    let group = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group.head_epoch, 0);
    assert_eq!(group.group_info, b"gi-0");
    assert_eq!(group.keyring, b"keyring-0");
    assert_eq!(group.owner_key, owner(1).public());
    assert!(
        mls::commits_since(&server.state.db, &project.id, 0, 0, u64::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    let retired: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM retired_tokens")
        .fetch_one(&server.state.db)
        .await
        .unwrap();
    assert_eq!(retired, 0);
    let (_, share) = server.get(&format!("/api/share/{}", project.edit)).await;
    assert_eq!(share["viewToken"], project.view);
}

#[tokio::test]
async fn an_editor_without_the_owner_key_cannot_swap_the_links() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut owner_ds) = inited(&server).await;
    let mut editor = server.session(&project.edit).await;
    let (mut doc, _) = server.doc(CrdtType::Elo, &project.id, &project.edit).await;
    let (mut presence, _) = server
        .doc(CrdtType::LoroEphemeralStore, &project.id, &project.view)
        .await;

    let (edit, view) = (common_token('E'), common_token('V'));
    // Unsigned, and signed with a key of the editor's own making.
    let mut unsigned = rotation(1, 0, &edit, &view);
    if let ClientMessage::Submit {
        rotate: Some(r), ..
    } = &mut unsigned
    {
        r.owner_proof = [0; 64];
    }
    let own_key = signed_rotation(2, GROUP, 0, (&edit, &view), &owner(9), &owner(2).public());
    for (req, msg) in [(1, unsigned), (2, own_key)] {
        let (reply, others) = editor.request(msg).await;
        assert_eq!(reply, refused(req, RefusalCode::NotOwner));
        assert!(others.is_empty());
    }
    assert_untouched(&server, &project).await;
    // Nobody was told of a commit or a rotation, and nobody was cut off.
    owner_ds.assert_quiet().await;
    doc.assert_open().await;
    presence.assert_open().await;

    // The epoch is still open, for the owner as for anyone.
    let (reply, _) = owner_ds.request(rotation(3, 0, &edit, &view)).await;
    assert_eq!(reply, accepted(3));
    assert_eq!(doc.closed().await, (4401, "link_rotated".to_owned()));
}

#[tokio::test]
async fn an_owner_proof_holds_for_exactly_the_rotation_it_signs() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut ds) = inited(&server).await;
    let (edit, view) = (common_token('E'), common_token('V'));
    let other_key = owner(3).public();
    type Tweak = Box<dyn for<'c> Fn(&mut RotationClaim<'c>)>;
    let tweaks: Vec<Tweak> = vec![
        Box::new(|c| c.group_id = GROUP_1),
        Box::new(|c| c.epoch = 1),
        Box::new(|c| c.commit = b"another commit"),
        Box::new(|c| c.group_info = b"other gi"),
        Box::new(|c| c.keyring = b"other keyring"),
        Box::new(|c| c.envelope = b"other envelope"),
        Box::new(|c| c.edit_token = "someone-elses-edit-tok"),
        Box::new(|c| c.view_token = "someone-elses-view-tok"),
        Box::new(move |c| c.next_owner_key = Box::leak(Box::new(other_key))),
    ];
    for (i, tweak) in tweaks.into_iter().enumerate() {
        let req = i as u64 + 1;
        let mut msg = rotation(req, 0, &edit, &view);
        sign(&mut msg, GROUP, &owner(1), tweak);
        assert_eq!(
            ds.request(msg).await.0,
            refused(req, RefusalCode::NotOwner),
            "case {i}"
        );
    }
    assert_untouched(&server, &project).await;
}

#[tokio::test]
async fn the_owner_key_moves_on_with_every_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (_, mut ds) = inited(&server).await;
    let (e1, v1) = (common_token('a'), common_token('b'));
    assert_eq!(ds.request(rotation(1, 0, &e1, &v1)).await.0, accepted(1));
    let mut ds = server.session(&e1).await;

    // The first key signed its last rotation.
    let (e2, v2) = (common_token('c'), common_token('d'));
    let replay = signed_rotation(2, GROUP, 1, (&e2, &v2), &owner(1), &owner(3).public());
    assert_eq!(
        ds.request(replay).await.0,
        refused(2, RefusalCode::NotOwner)
    );
    // Naming the current key as the next would let a removed holder keep it.
    let same = signed_rotation(3, GROUP, 1, (&e2, &v2), &owner(2), &owner(2).public());
    assert_eq!(ds.request(same).await.0, refused(3, RefusalCode::Malformed));
    let mut identity = [0; 32];
    identity[0] = 1;
    let weak = signed_rotation(4, GROUP, 1, (&e2, &v2), &owner(2), &identity);
    assert_eq!(ds.request(weak).await.0, refused(4, RefusalCode::Malformed));

    let next = signed_rotation(5, GROUP, 1, (&e2, &v2), &owner(2), &owner(3).public());
    assert_eq!(ds.request(next).await.0, accepted(5));
}

#[tokio::test]
async fn of_two_owner_rotations_for_one_epoch_the_second_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (project, mut a) = inited(&server).await;
    let mut b = server.session(&project.edit).await;
    let first = rotation(1, 0, &common_token('a'), &common_token('b'));
    assert_eq!(a.request(first).await.0, accepted(1));
    let tokens = (common_token('c'), common_token('d'));
    let second = signed_rotation(
        2,
        GROUP,
        0,
        (&tokens.0, &tokens.1),
        &owner(1),
        &owner(3).public(),
    );
    // Over the socket the loser's token is retired by then.
    assert_eq!(
        b.request(second.clone()).await.0,
        refused(2, RefusalCode::Retired)
    );
    // Underneath, the epoch is checked before the proof: the key it was
    // signed with was current until the winner's commit, and the loser has
    // to follow that commit to the new one, not hear that it is no owner.
    let ClientMessage::Submit {
        commit,
        group_info,
        keyring,
        envelope,
        rotate: Some(rotate),
        ..
    } = &second
    else {
        unreachable!()
    };
    let args = mls::SubmitArgs {
        incarnation: 0,
        epoch: 0,
        commit,
        group_info,
        keyring: keyring.as_deref(),
        envelope: envelope.as_deref(),
        rotate: Some(rotate),
    };
    let submitted = mls::submit(&server.state.db, &project.id, &args)
        .await
        .unwrap();
    assert_eq!(submitted, mls::Submitted::Conflict { head: 1 });
    let group = mls::load_group(&server.state.db, &project.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(group.owner_key, owner(2).public());
}

#[tokio::test]
async fn a_reset_keeps_the_owner_key_and_the_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start(dir.path()).await;
    let (_, mut ds) = inited(&server).await;
    let (edit, view) = (common_token('a'), common_token('b'));
    assert_eq!(
        ds.request(rotation(1, 0, &edit, &view)).await.0,
        accepted(1)
    );
    let mut ds = server.session(&edit).await;
    let reset = ClientMessage::Reset {
        req: 2,
        incarnation: 0,
        group_id: GROUP_1.to_vec(),
        group_info: b"gi-fresh".to_vec(),
        keyring: b"keyring-fresh".to_vec(),
    };
    assert_eq!(ds.request(reset).await.0, accepted(2));
    let (status, share) = server.get(&format!("/api/share/{edit}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(share["viewToken"], view);
    let project_id = share["projectId"].as_str().unwrap().to_owned();
    let group = mls::load_group(&server.state.db, &project_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((group.incarnation, group.owner_key), (1, owner(2).public()));
    let (_, body) = server.get(&format!("/api/p/{edit}/mls")).await;
    assert_eq!(
        STANDARD.decode(body["ownerKey"].as_str().unwrap()).unwrap(),
        owner(2).public()
    );

    // The new incarnation's first rotation still needs the key the chain
    // arrived at, not the one the project started with.
    let tokens = (common_token('c'), common_token('d'));
    let tokens = (tokens.0.as_str(), tokens.1.as_str());
    let first_key = signed_rotation(3, GROUP_1, 0, tokens, &owner(1), &owner(3).public());
    assert_eq!(
        ds.request(first_key).await.0,
        refused(3, RefusalCode::NotOwner)
    );
    let chained = signed_rotation(4, GROUP_1, 0, tokens, &owner(2), &owner(3).public());
    assert_eq!(ds.request(chained).await.0, accepted(4));
}
