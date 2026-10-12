//! The project's MLS group from the CLI's side: a client for the delivery
//! service socket, and the two ways a folder gets into a group (creating a
//! project, joining one).
//!
//! The delivery service is a dumb sequencer, so everything here is
//! request and answer on a socket that lives for one operation. Following
//! the group after that (catching up, rotations) is [`crate::engine`]'s
//! business, since it touches the config and the folder's state.

use std::time::Duration;

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;
use typstry_wire::crypto::LinkSecret;
use typstry_wire::ds::{ClientMessage, Permission, RefusalCode, ServerMessage};
use typstry_wire::mls::{Device, MlsError, ProjectGroup};

use crate::api::Api;
use crate::client::{Socket, open_socket};
use crate::engine::{Identity, SyncError};
use crate::link::{ShareLink, ds_url};

/// How long the server may stay silent while an operation waits for it.
/// The sockets are short lived, so there is no keepalive to speak of.
const REPLY_TIMEOUT: Duration = Duration::from_secs(20);

/// Tries at an external join before giving up. Each lost one means another
/// member's commit won the same epoch.
const JOIN_ATTEMPTS: u32 = 5;

/// What the server said when a connection opened.
#[derive(Debug, Clone, Copy)]
pub struct Ready {
    pub incarnation: u64,
    /// The epoch the group is at.
    pub head: u64,
    pub permission: Permission,
}

/// The answer to a request.
#[derive(Debug)]
pub enum Reply {
    Accepted,
    /// Another commit took the epoch first.
    Conflict,
    Refused(RefusalCode),
}

pub struct Ds {
    ws: Socket,
    pub ready: Ready,
}

impl Ds {
    /// Opens the socket and says hello with `token`. The commits from
    /// `since_epoch` on follow as [`ServerMessage::Commit`]s.
    pub async fn connect(
        origin: &str,
        token: &str,
        incarnation: u64,
        since_epoch: u64,
    ) -> anyhow::Result<Self> {
        // Errors name the origin: the URL holds no token, but the error is
        // plainer without the query.
        let ws = open_socket(&ds_url(origin)?, origin).await?;
        let mut ds = Self {
            ws,
            ready: Ready {
                incarnation: 0,
                head: 0,
                permission: Permission::Read,
            },
        };
        ds.send(&ClientMessage::Hello {
            token: token.to_owned(),
            incarnation,
            since_epoch,
        })
        .await?;
        ds.ready = match ds.next().await? {
            ServerMessage::Ready {
                incarnation,
                head,
                permission,
                ..
            } => Ready {
                incarnation,
                head,
                permission,
            },
            ServerMessage::Refused { .. } => return Err(SyncError::LinkRefused.into()),
            other => bail!("unexpected answer to the group hello: {other:?}"),
        };
        Ok(ds)
    }

    pub async fn send(&mut self, msg: &ClientMessage) -> anyhow::Result<()> {
        self.ws
            .send(Message::Binary(msg.encode().into()))
            .await
            .map_err(|err| SyncError::Disconnected(Some(err.to_string())).into())
    }

    /// The next message from the server.
    pub async fn next(&mut self) -> anyhow::Result<ServerMessage> {
        loop {
            let next = tokio::time::timeout(REPLY_TIMEOUT, self.ws.next())
                .await
                .map_err(|_| anyhow::anyhow!("the server stopped answering the group request"))?;
            match next {
                Some(Ok(Message::Binary(bytes))) => {
                    return ServerMessage::decode(&bytes).map_err(anyhow::Error::from);
                }
                Some(Ok(Message::Close(frame))) => {
                    let reason = frame.map(|f| f.reason.to_string());
                    return Err(SyncError::Disconnected(reason).into());
                }
                // Text keepalives and pings carry nothing for us.
                Some(Ok(_)) => {}
                Some(Err(err)) => return Err(SyncError::Disconnected(Some(err.to_string())).into()),
                None => return Err(SyncError::Disconnected(None).into()),
            }
        }
    }

    /// Sends `msg` (which carries request number `req`) and waits for the
    /// server's answer to it. Commits others made meanwhile are not needed
    /// for that: a lost race comes back as a conflict.
    pub async fn request(&mut self, req: u64, msg: &ClientMessage) -> anyhow::Result<Reply> {
        self.send(msg).await?;
        loop {
            match self.next().await? {
                ServerMessage::Accepted { req: r } if r == req => return Ok(Reply::Accepted),
                ServerMessage::Conflict { req: r, .. } if r == req => return Ok(Reply::Conflict),
                ServerMessage::Refused { req: r, code } if r == req => {
                    return Ok(Reply::Refused(code));
                }
                _ => {}
            }
        }
    }

    pub async fn close(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.ws.close(None)).await;
    }
}

/// What the server's refusal means for the person at the terminal.
pub fn refusal_text(code: RefusalCode) -> &'static str {
    match code {
        RefusalCode::Forbidden => "this link may not do that",
        RefusalCode::Retired => "this link was replaced; run `typstry pull` to find the new one",
        RefusalCode::NoGroup => "the project has no member group yet",
        RefusalCode::GroupExists => "the project already has a member group",
        RefusalCode::WrongIncarnation => "the member group was reset meanwhile; try again",
        RefusalCode::RateLimited => "the server is rate limiting this connection; try again soon",
        RefusalCode::Malformed | RefusalCode::BadCommit | RefusalCode::Internal => {
            "the server could not take the request"
        }
    }
}

/// A member's profile, sealed into its leaf. Other clients show it in the
/// member list.
#[derive(Serialize, Deserialize)]
struct Profile {
    name: String,
    color: String,
}

pub fn profile_bytes(identity: &Identity) -> Vec<u8> {
    serde_json::to_vec(&Profile {
        name: identity.name.clone(),
        color: identity.color.clone(),
    })
    .expect("a profile is plain strings")
}

/// The name in a leaf's profile, if it holds one this build can read.
pub fn profile_name(profile: &[u8]) -> Option<String> {
    serde_json::from_slice::<Profile>(profile)
        .ok()
        .map(|p| p.name)
}

/// Creates the group of a new project and registers it with the server.
/// `link` is the project's edit link, whose token is not yet in use.
pub async fn create_group(link: &ShareLink, identity: &Identity) -> anyhow::Result<ProjectGroup> {
    let secret = LinkSecret::from_base64url(&link.key).context("reading the new link")?;
    let (group, init) = ProjectGroup::create(&secret, &profile_bytes(identity))?;
    let mut ds = Ds::connect(&link.origin, &link.token, 0, 0).await?;
    let reply = ds.request(1, &init.into_message(1)).await;
    ds.close().await;
    match reply? {
        Reply::Accepted => Ok(group),
        Reply::Conflict => bail!("creating the project's group conflicted with another"),
        Reply::Refused(code) => bail!("creating the project's group: {}", refusal_text(code)),
    }
}

/// Joins the group with an external commit as `device`, which replaces its
/// old leaf if it had one. Retries when another member's commit wins the
/// epoch.
pub async fn join_group(
    api: &Api,
    link: &ShareLink,
    device: Device,
    identity: &Identity,
) -> anyhow::Result<ProjectGroup> {
    let secret = LinkSecret::from_base64url(&link.key).context("reading the link")?;
    let profile = profile_bytes(identity);
    for attempt in 1..=JOIN_ATTEMPTS {
        let boot = api.mls_bootstrap(&link.token).await?;
        // The same device every time: a lost race joined nothing, so no
        // leaf is left behind.
        let (mut group, payload) = ProjectGroup::join_external_as(
            device.duplicate(),
            &secret,
            &boot.group_info,
            &boot.keyring,
            &profile,
        )
        // The sealed parts only open with the project's keys, so this is
        // where a truncated or wrong link shows.
        .map_err(|err| match err {
            MlsError::Crypto(_) | MlsError::Mismatch(_) => anyhow::Error::from(SyncError::WrongKey),
            err => err.into(),
        })?;
        let mut ds =
            Ds::connect(&link.origin, &link.token, boot.incarnation, payload.epoch).await?;
        let reply = ds.request(1, &payload.into_message(1)).await;
        ds.close().await;
        match reply? {
            Reply::Accepted => {
                group.confirm_pending()?;
                return Ok(group);
            }
            Reply::Conflict => {
                group.discard_pending()?;
                if attempt < JOIN_ATTEMPTS {
                    tokio::time::sleep(jitter(attempt)).await;
                }
            }
            Reply::Refused(code) => bail!("joining the project's group: {}", refusal_text(code)),
        }
    }
    bail!("could not join the project's group: other members kept changing it; try again")
}

/// A random wait that grows with the number of lost races, so members who
/// collide do not collide again.
pub fn jitter(attempt: u32) -> Duration {
    let mut byte = [0u8; 1];
    getrandom::fill(&mut byte).expect("OS random source unavailable");
    Duration::from_millis(50 * u64::from(attempt) + u64::from(byte[0]))
}
