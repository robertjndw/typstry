//! The binary messages of the MLS delivery service on [`DS_PATH`].
//!
//! The delivery service is a dumb sequencer. It orders commits per epoch,
//! stores the latest sealed GroupInfo and keyring, and relays commits to
//! the other members. Every MLS and crypto payload below is opaque bytes to
//! it, which is why this module needs no crypto.
//!
//! Loro's `CrdtType` is a closed enum, so these messages cannot ride the
//! doc socket and get a socket of their own. The layout is a leading tag
//! byte, then the fields in the order they are declared, with integers as
//! uleb128 and byte strings length-prefixed, like `%ELO` containers.
//!
//! [`DS_VERSION`] travels in the two handshake messages, [`ClientMessage::Hello`]
//! and [`ServerMessage::Ready`], so the first message of a connection
//! already tells either side to upgrade. It is part of the v1 format and
//! covered by `docs/compatibility.md`, not by `PROTOCOL_VERSION`.

use loro_protocol::{BytesReader, BytesWriter};

use crate::codec::{CodecError, push_opt, read_array, read_flag, read_opt};
use crate::mls_frame::MAX_GROUP_ID;

/// Where the server serves the delivery service socket.
pub const DS_PATH: &str = "/ws/mls";

/// Upper bound for one message in either direction. A GroupInfo with the
/// ratchet tree is the big one, and it grows with the member count.
pub const MAX_DS_MESSAGE: usize = 2 * 1024 * 1024;

/// Version of this codec, checked in the handshake. Readers handle every
/// version from 1 up and refuse newer ones.
pub const DS_VERSION: u8 = 1;

/// Longest link token the server hands out is far shorter than this.
pub const MAX_TOKEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DsError {
    /// The peer speaks a newer codec than this build.
    UnsupportedVersion(u8),
    UnknownTag(u8),
    UnknownValue(&'static str, u8),
    TooLarge(&'static str),
    TrailingBytes(usize),
    Malformed(String),
}

impl std::fmt::Display for DsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedVersion(v) => {
                write!(f, "delivery service version {v} is newer than this build")
            }
            Self::UnknownTag(tag) => write!(f, "unknown delivery service message tag {tag}"),
            Self::UnknownValue(what, v) => write!(f, "unknown {what} {v}"),
            Self::TooLarge(what) => write!(f, "{what} is too large"),
            Self::TrailingBytes(n) => write!(f, "{n} trailing bytes after the message"),
            Self::Malformed(why) => write!(f, "malformed delivery service message: {why}"),
        }
    }
}

impl std::error::Error for DsError {}

impl From<String> for DsError {
    fn from(why: String) -> Self {
        Self::Malformed(why)
    }
}

impl From<CodecError> for DsError {
    fn from(err: CodecError) -> Self {
        match err {
            CodecError::Read(why) => Self::Malformed(why),
            CodecError::Flag(v) => Self::UnknownValue("option flag", v),
        }
    }
}

/// Length of the owner keys and proofs below, see [`crate::owner`]. Kept as
/// plain numbers here so the codec builds without the `owner-proof` feature.
pub const OWNER_KEY_LEN: usize = 32;
pub const OWNER_PROOF_LEN: usize = 64;

/// The new links of a rotation, as the server needs them: it swaps the
/// space's tokens in the same transaction as the commit. The rotating
/// client picks the new tokens at random; the matching secrets travel only
/// inside the sealed envelope, never to the server.
///
/// Only the owner rotates, which the server checks with `owner_proof`, the
/// signature of the space's current owner key over the whole submission.
/// `next_owner_key` replaces that key once the rotation is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rotate {
    pub edit_token: String,
    pub view_token: String,
    pub next_owner_key: [u8; OWNER_KEY_LEN],
    pub owner_proof: [u8; OWNER_PROOF_LEN],
}

/// What a connection may do, decided by the token it presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// An edit token: may commit and reset.
    Write,
    /// A view token: may only join with an external commit.
    Read,
    /// A token from before a rotation: may only read the commit log, to
    /// catch up and find the new links.
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalCode {
    /// The message could not be parsed or broke a size limit.
    Malformed,
    /// The token's permission does not allow this.
    Forbidden,
    /// The group has not been initialized yet.
    NoGroup,
    /// The group already exists, so `Init` cannot run again.
    GroupExists,
    /// The message names an incarnation other than the current one.
    WrongIncarnation,
    /// The commit is not an MLS message the server can route.
    BadCommit,
    /// The token was retired by a rotation.
    Retired,
    Internal,
    /// The connection sent messages faster than the server accepts them.
    RateLimited,
    /// A rotation that is not signed with the space's owner key. Nothing
    /// was stored.
    NotOwner,
}

impl RefusalCode {
    fn to_byte(self) -> u8 {
        match self {
            Self::Malformed => 1,
            Self::Forbidden => 2,
            Self::NoGroup => 3,
            Self::GroupExists => 4,
            Self::WrongIncarnation => 5,
            Self::BadCommit => 6,
            Self::Retired => 7,
            Self::Internal => 8,
            Self::RateLimited => 9,
            Self::NotOwner => 10,
        }
    }

    fn from_byte(byte: u8) -> Result<Self, DsError> {
        Ok(match byte {
            1 => Self::Malformed,
            2 => Self::Forbidden,
            3 => Self::NoGroup,
            4 => Self::GroupExists,
            5 => Self::WrongIncarnation,
            6 => Self::BadCommit,
            7 => Self::Retired,
            8 => Self::Internal,
            9 => Self::RateLimited,
            10 => Self::NotOwner,
            other => return Err(DsError::UnknownValue("refusal code", other)),
        })
    }
}

impl Permission {
    fn to_byte(self) -> u8 {
        match self {
            Self::Write => 1,
            Self::Read => 2,
            Self::Retired => 3,
        }
    }

    fn from_byte(byte: u8) -> Result<Self, DsError> {
        Ok(match byte {
            1 => Self::Write,
            2 => Self::Read,
            3 => Self::Retired,
            other => return Err(DsError::UnknownValue("permission", other)),
        })
    }
}

/// Client to server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    /// Opens the session and asks for every commit after `since_epoch`.
    Hello {
        token: String,
        incarnation: u64,
        since_epoch: u64,
    },
    /// A commit extending `epoch`. The first one the server sees for an
    /// epoch wins. The rest is applied in the same transaction, so a
    /// rotation lands whole or not at all.
    ///
    /// Every commit comes with the sealed GroupInfo of the epoch it
    /// creates, which is what a newcomer joins from. `keyring`, `envelope`
    /// and `rotate` belong together: a rotation has all three and any other
    /// commit none.
    Submit {
        req: u64,
        epoch: u64,
        commit: Vec<u8>,
        group_info: Vec<u8>,
        keyring: Option<Vec<u8>>,
        envelope: Option<Vec<u8>>,
        rotate: Option<Rotate>,
    },
    /// Creates the group of a new space. `owner_key` is the public owner
    /// key the first rotation has to be signed with.
    Init {
        req: u64,
        group_id: Vec<u8>,
        group_info: Vec<u8>,
        keyring: Vec<u8>,
        owner_key: [u8; OWNER_KEY_LEN],
    },
    /// Starts over with a new group when the old one is stuck. It carries
    /// no owner key: any editor may reset, and a reset leaves the owner key
    /// and the tokens as they are.
    Reset {
        req: u64,
        incarnation: u64,
        group_id: Vec<u8>,
        group_info: Vec<u8>,
        keyring: Vec<u8>,
    },
    /// Asks for the commits after `since` again, e.g. after a gap.
    Fetch { since: u64 },
}

/// Server to client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMessage {
    /// Answers `Hello`. The missed commits follow as `Commit` messages.
    Ready {
        incarnation: u64,
        head: u64,
        permission: Permission,
        /// For a retired token, the epoch of the rotation that retired it.
        retired: Option<u64>,
    },
    /// `owner_key` is the owner key a rotation moved the server on to, and
    /// is absent for any other commit. It is how a member that follows the
    /// log knows which owner key is current: the group cannot say, see
    /// [`crate::owner`].
    Commit {
        epoch: u64,
        commit: Vec<u8>,
        envelope: Option<Vec<u8>>,
        owner_key: Option<[u8; OWNER_KEY_LEN]>,
    },
    Accepted {
        req: u64,
    },
    /// Another commit won the epoch. `head` is where the group is now.
    Conflict {
        req: u64,
        head: u64,
    },
    Refused {
        req: u64,
        code: RefusalCode,
    },
    /// The group was reset. The client must rejoin under the new incarnation.
    Reinitialized {
        incarnation: u64,
    },
}

mod tag {
    // 3 and 0x83 are unassigned.
    pub const HELLO: u8 = 1;
    pub const SUBMIT: u8 = 2;
    pub const INIT: u8 = 4;
    pub const RESET: u8 = 5;
    pub const FETCH: u8 = 6;

    pub const READY: u8 = 0x81;
    pub const COMMIT: u8 = 0x82;
    pub const ACCEPTED: u8 = 0x84;
    pub const CONFLICT: u8 = 0x85;
    pub const REFUSED: u8 = 0x86;
    pub const REINITIALIZED: u8 = 0x87;
}

fn read_token(reader: &mut BytesReader<'_>) -> Result<String, DsError> {
    let bytes = reader.read_var_bytes()?;
    if bytes.len() > MAX_TOKEN {
        return Err(DsError::TooLarge("token"));
    }
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| DsError::Malformed("token is not UTF-8".into()))
}

/// Shared with the saved MLS state, which keeps a pending rotation as sent.
pub(crate) fn push_rotate(w: &mut BytesWriter, rotate: &Rotate) {
    w.push_var_string(&rotate.edit_token);
    w.push_var_string(&rotate.view_token);
    w.push_bytes(&rotate.next_owner_key);
    w.push_bytes(&rotate.owner_proof);
}

pub(crate) fn read_rotate(r: &mut BytesReader<'_>) -> Result<Rotate, DsError> {
    Ok(Rotate {
        edit_token: read_token(r)?,
        view_token: read_token(r)?,
        next_owner_key: read_array(r)?,
        owner_proof: read_array(r)?,
    })
}

fn read_group_id(reader: &mut BytesReader<'_>) -> Result<Vec<u8>, DsError> {
    let bytes = reader.read_var_bytes()?;
    if bytes.len() > MAX_GROUP_ID {
        return Err(DsError::TooLarge("group id"));
    }
    Ok(bytes.to_vec())
}

/// Starts a reader over `bytes`. The whole-message cap comes first, so
/// every length read afterwards is already bounded by it. The reader only
/// hands out slices of the input, so nothing allocates ahead of the data.
fn open(bytes: &[u8]) -> Result<(BytesReader<'_>, u8), DsError> {
    if bytes.len() > MAX_DS_MESSAGE {
        return Err(DsError::TooLarge("message"));
    }
    let mut reader = BytesReader::new(bytes);
    let tag = reader.read_byte()?;
    Ok((reader, tag))
}

fn finish(reader: &BytesReader<'_>) -> Result<(), DsError> {
    match reader.remaining() {
        0 => Ok(()),
        n => Err(DsError::TrailingBytes(n)),
    }
}

fn check_version(reader: &mut BytesReader<'_>) -> Result<(), DsError> {
    match reader.read_byte()? {
        0 => Err(DsError::UnknownValue("version", 0)),
        v if v > DS_VERSION => Err(DsError::UnsupportedVersion(v)),
        _ => Ok(()),
    }
}

impl ClientMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        match self {
            Self::Hello {
                token,
                incarnation,
                since_epoch,
            } => {
                w.push_byte(tag::HELLO);
                w.push_byte(DS_VERSION);
                w.push_var_string(token);
                w.push_uleb128(*incarnation);
                w.push_uleb128(*since_epoch);
            }
            Self::Submit {
                req,
                epoch,
                commit,
                group_info,
                keyring,
                envelope,
                rotate,
            } => {
                w.push_byte(tag::SUBMIT);
                w.push_uleb128(*req);
                w.push_uleb128(*epoch);
                w.push_var_bytes(commit);
                w.push_var_bytes(group_info);
                push_opt(&mut w, keyring.as_deref());
                push_opt(&mut w, envelope.as_deref());
                match rotate {
                    Some(rotate) => {
                        w.push_byte(1);
                        push_rotate(&mut w, rotate);
                    }
                    None => w.push_byte(0),
                }
            }
            Self::Init {
                req,
                group_id,
                group_info,
                keyring,
                owner_key,
            } => {
                w.push_byte(tag::INIT);
                w.push_uleb128(*req);
                w.push_var_bytes(group_id);
                w.push_var_bytes(group_info);
                w.push_var_bytes(keyring);
                w.push_bytes(owner_key);
            }
            Self::Reset {
                req,
                incarnation,
                group_id,
                group_info,
                keyring,
            } => {
                w.push_byte(tag::RESET);
                w.push_uleb128(*req);
                w.push_uleb128(*incarnation);
                w.push_var_bytes(group_id);
                w.push_var_bytes(group_info);
                w.push_var_bytes(keyring);
            }
            Self::Fetch { since } => {
                w.push_byte(tag::FETCH);
                w.push_uleb128(*since);
            }
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DsError> {
        let (mut r, tag) = open(bytes)?;
        let msg = match tag {
            tag::HELLO => {
                check_version(&mut r)?;
                Self::Hello {
                    token: read_token(&mut r)?,
                    incarnation: r.read_uleb128()?,
                    since_epoch: r.read_uleb128()?,
                }
            }
            tag::SUBMIT => Self::Submit {
                req: r.read_uleb128()?,
                epoch: r.read_uleb128()?,
                commit: r.read_var_bytes()?.to_vec(),
                group_info: r.read_var_bytes()?.to_vec(),
                keyring: read_opt(&mut r)?,
                envelope: read_opt(&mut r)?,
                rotate: if read_flag(&mut r)? {
                    Some(read_rotate(&mut r)?)
                } else {
                    None
                },
            },
            tag::INIT => Self::Init {
                req: r.read_uleb128()?,
                group_id: read_group_id(&mut r)?,
                group_info: r.read_var_bytes()?.to_vec(),
                keyring: r.read_var_bytes()?.to_vec(),
                owner_key: read_array(&mut r)?,
            },
            tag::RESET => Self::Reset {
                req: r.read_uleb128()?,
                incarnation: r.read_uleb128()?,
                group_id: read_group_id(&mut r)?,
                group_info: r.read_var_bytes()?.to_vec(),
                keyring: r.read_var_bytes()?.to_vec(),
            },
            tag::FETCH => Self::Fetch {
                since: r.read_uleb128()?,
            },
            other => return Err(DsError::UnknownTag(other)),
        };
        finish(&r)?;
        Ok(msg)
    }
}

impl ServerMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        match self {
            Self::Ready {
                incarnation,
                head,
                permission,
                retired,
            } => {
                w.push_byte(tag::READY);
                w.push_byte(DS_VERSION);
                w.push_uleb128(*incarnation);
                w.push_uleb128(*head);
                w.push_byte(permission.to_byte());
                match retired {
                    Some(epoch) => {
                        w.push_byte(1);
                        w.push_uleb128(*epoch);
                    }
                    None => w.push_byte(0),
                }
            }
            Self::Commit {
                epoch,
                commit,
                envelope,
                owner_key,
            } => {
                w.push_byte(tag::COMMIT);
                w.push_uleb128(*epoch);
                w.push_var_bytes(commit);
                push_opt(&mut w, envelope.as_deref());
                match owner_key {
                    Some(key) => {
                        w.push_byte(1);
                        w.push_bytes(key);
                    }
                    None => w.push_byte(0),
                }
            }
            Self::Accepted { req } => {
                w.push_byte(tag::ACCEPTED);
                w.push_uleb128(*req);
            }
            Self::Conflict { req, head } => {
                w.push_byte(tag::CONFLICT);
                w.push_uleb128(*req);
                w.push_uleb128(*head);
            }
            Self::Refused { req, code } => {
                w.push_byte(tag::REFUSED);
                w.push_uleb128(*req);
                w.push_byte(code.to_byte());
            }
            Self::Reinitialized { incarnation } => {
                w.push_byte(tag::REINITIALIZED);
                w.push_uleb128(*incarnation);
            }
        }
        w.finalize()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, DsError> {
        let (mut r, tag) = open(bytes)?;
        let msg = match tag {
            tag::READY => {
                check_version(&mut r)?;
                Self::Ready {
                    incarnation: r.read_uleb128()?,
                    head: r.read_uleb128()?,
                    permission: Permission::from_byte(r.read_byte()?)?,
                    retired: if read_flag(&mut r)? {
                        Some(r.read_uleb128()?)
                    } else {
                        None
                    },
                }
            }
            tag::COMMIT => Self::Commit {
                epoch: r.read_uleb128()?,
                commit: r.read_var_bytes()?.to_vec(),
                envelope: read_opt(&mut r)?,
                owner_key: if read_flag(&mut r)? {
                    Some(read_array(&mut r)?)
                } else {
                    None
                },
            },
            tag::ACCEPTED => Self::Accepted {
                req: r.read_uleb128()?,
            },
            tag::CONFLICT => Self::Conflict {
                req: r.read_uleb128()?,
                head: r.read_uleb128()?,
            },
            tag::REFUSED => Self::Refused {
                req: r.read_uleb128()?,
                code: RefusalCode::from_byte(r.read_byte()?)?,
            },
            tag::REINITIALIZED => Self::Reinitialized {
                incarnation: r.read_uleb128()?,
            },
            other => return Err(DsError::UnknownTag(other)),
        };
        finish(&r)?;
        Ok(msg)
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn client_samples() -> Vec<ClientMessage> {
        vec![
            ClientMessage::Hello {
                token: "tok".into(),
                incarnation: 3,
                since_epoch: 0,
            },
            ClientMessage::Submit {
                req: 1,
                epoch: 9,
                commit: vec![1, 2, 3],
                group_info: vec![4],
                keyring: None,
                envelope: Some(vec![]),
                rotate: Some(Rotate {
                    edit_token: "e".into(),
                    view_token: "v".into(),
                    next_owner_key: [3; 32],
                    owner_proof: [4; 64],
                }),
            },
            ClientMessage::Submit {
                req: u64::MAX,
                epoch: u64::MAX,
                commit: vec![],
                group_info: vec![],
                keyring: None,
                envelope: None,
                rotate: None,
            },
            ClientMessage::Init {
                req: 3,
                group_id: b"gid".to_vec(),
                group_info: vec![1],
                keyring: vec![2],
                owner_key: [5; 32],
            },
            ClientMessage::Reset {
                req: 4,
                incarnation: 2,
                group_id: b"gid2".to_vec(),
                group_info: vec![1],
                keyring: vec![2],
            },
            ClientMessage::Fetch { since: 12 },
        ]
    }

    fn server_samples() -> Vec<ServerMessage> {
        vec![
            ServerMessage::Ready {
                incarnation: 1,
                head: 5,
                permission: Permission::Write,
                retired: None,
            },
            ServerMessage::Ready {
                incarnation: 1,
                head: 5,
                permission: Permission::Retired,
                retired: Some(4),
            },
            ServerMessage::Commit {
                epoch: 6,
                commit: vec![9; 10],
                envelope: Some(vec![1]),
                owner_key: Some([3; 32]),
            },
            ServerMessage::Commit {
                epoch: 7,
                commit: vec![9; 10],
                envelope: None,
                owner_key: None,
            },
            ServerMessage::Accepted { req: 1 },
            ServerMessage::Conflict { req: 2, head: 7 },
            ServerMessage::Refused {
                req: 3,
                code: RefusalCode::Forbidden,
            },
            ServerMessage::Refused {
                req: 4,
                code: RefusalCode::NotOwner,
            },
            ServerMessage::Reinitialized { incarnation: 8 },
        ]
    }

    #[test]
    fn messages_round_trip() {
        for msg in client_samples() {
            assert_eq!(ClientMessage::decode(&msg.encode()), Ok(msg));
        }
        for msg in server_samples() {
            assert_eq!(ServerMessage::decode(&msg.encode()), Ok(msg));
        }
    }

    #[test]
    fn wire_layout_is_stable() {
        let hello = ClientMessage::Hello {
            token: "ab".into(),
            incarnation: 1,
            since_epoch: 300,
        };
        assert_eq!(hello.encode(), [1, 1, 2, b'a', b'b', 1, 0xac, 0x02]);
        let refused = ServerMessage::Refused {
            req: 5,
            code: RefusalCode::NoGroup,
        };
        assert_eq!(refused.encode(), [0x86, 5, 3]);
        let not_owner = ServerMessage::Refused {
            req: 1,
            code: RefusalCode::NotOwner,
        };
        assert_eq!(not_owner.encode(), [0x86, 1, 10]);
        assert_eq!(
            ServerMessage::decode(&[0x86, 1, 11]),
            Err(DsError::UnknownValue("refusal code", 11))
        );

        // The owner key and proof are fixed-length, with no length prefix.
        let init = ClientMessage::Init {
            req: 1,
            group_id: vec![7],
            group_info: vec![8],
            keyring: vec![9],
            owner_key: [5; 32],
        };
        let mut want = vec![4, 1, 1, 7, 1, 8, 1, 9];
        want.extend([5; 32]);
        assert_eq!(init.encode(), want);
        let rotation = ClientMessage::Submit {
            req: 1,
            epoch: 2,
            commit: vec![],
            group_info: vec![],
            keyring: None,
            envelope: None,
            rotate: Some(Rotate {
                edit_token: "e".into(),
                view_token: "v".into(),
                next_owner_key: [3; 32],
                owner_proof: [4; 64],
            }),
        };
        let mut want = vec![2, 1, 2, 0, 0, 0, 0, 1, 1, b'e', 1, b'v'];
        want.extend([3; 32]);
        want.extend([4; 64]);
        assert_eq!(rotation.encode(), want);
        let commit = ServerMessage::Commit {
            epoch: 2,
            commit: vec![6],
            envelope: None,
            owner_key: Some([3; 32]),
        };
        let mut want = vec![0x82, 2, 1, 6, 0, 1];
        want.extend([3; 32]);
        assert_eq!(commit.encode(), want);
    }

    #[test]
    fn rejects_trailing_bytes() {
        for msg in client_samples() {
            let mut bytes = msg.encode();
            bytes.push(0);
            assert!(matches!(
                ClientMessage::decode(&bytes),
                Err(DsError::TrailingBytes(1))
            ));
        }
        for msg in server_samples() {
            let mut bytes = msg.encode();
            bytes.push(0);
            assert!(matches!(
                ServerMessage::decode(&bytes),
                Err(DsError::TrailingBytes(1))
            ));
        }
    }

    #[test]
    fn rejects_every_truncation() {
        for msg in client_samples() {
            let bytes = msg.encode();
            for len in 0..bytes.len() {
                assert!(ClientMessage::decode(&bytes[..len]).is_err(), "{msg:?}");
            }
        }
        for msg in server_samples() {
            let bytes = msg.encode();
            for len in 0..bytes.len() {
                assert!(ServerMessage::decode(&bytes[..len]).is_err(), "{msg:?}");
            }
        }
    }

    #[test]
    fn checks_the_codec_version() {
        let mut hello = client_samples()[0].encode();
        hello[1] = DS_VERSION + 1;
        assert_eq!(
            ClientMessage::decode(&hello),
            Err(DsError::UnsupportedVersion(DS_VERSION + 1))
        );
        hello[1] = 0;
        assert!(ClientMessage::decode(&hello).is_err());
        let mut ready = server_samples()[0].encode();
        ready[1] = DS_VERSION + 1;
        assert_eq!(
            ServerMessage::decode(&ready),
            Err(DsError::UnsupportedVersion(DS_VERSION + 1))
        );
    }

    #[test]
    fn rejects_unknown_tags_and_values() {
        assert_eq!(
            ClientMessage::decode(&[0x7f]),
            Err(DsError::UnknownTag(0x7f))
        );
        assert_eq!(ServerMessage::decode(&[1]), Err(DsError::UnknownTag(1)));
        assert!(ClientMessage::decode(&[]).is_err());
        assert!(ServerMessage::decode(&[0x86, 1, 0]).is_err());
        // An option flag of 2 would give `None` a second spelling.
        assert!(ClientMessage::decode(&[2, 0, 0, 0, 0, 2]).is_err());
        // Gaps in the tag range are unknown too.
        assert_eq!(ClientMessage::decode(&[3]), Err(DsError::UnknownTag(3)));
        assert_eq!(
            ServerMessage::decode(&[0x83]),
            Err(DsError::UnknownTag(0x83))
        );
    }

    #[test]
    fn rejects_oversized_fields() {
        // A commit claiming 2^60 bytes in a few bytes of message.
        let mut hostile = vec![tag::SUBMIT, 1, 1];
        hostile.extend([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10]);
        assert!(ClientMessage::decode(&hostile).is_err());

        let big = ClientMessage::Submit {
            req: 1,
            epoch: 1,
            commit: vec![],
            group_info: vec![0; MAX_DS_MESSAGE],
            keyring: None,
            envelope: None,
            rotate: None,
        }
        .encode();
        assert_eq!(
            ClientMessage::decode(&big),
            Err(DsError::TooLarge("message"))
        );

        let long_token = ClientMessage::Hello {
            token: "t".repeat(MAX_TOKEN + 1),
            incarnation: 1,
            since_epoch: 0,
        };
        assert_eq!(
            ClientMessage::decode(&long_token.encode()),
            Err(DsError::TooLarge("token"))
        );
        let long_group = ClientMessage::Init {
            req: 1,
            group_id: vec![0; MAX_GROUP_ID + 1],
            group_info: vec![],
            keyring: vec![],
            owner_key: [0; 32],
        };
        assert_eq!(
            ClientMessage::decode(&long_group.encode()),
            Err(DsError::TooLarge("group id"))
        );
    }

    fn bytes() -> impl Strategy<Value = Vec<u8>> {
        prop::collection::vec(any::<u8>(), 0..64)
    }

    fn token() -> impl Strategy<Value = String> {
        "[a-zA-Z0-9_-]{0,40}"
    }

    fn client_message() -> impl Strategy<Value = ClientMessage> {
        prop_oneof![
            (token(), any::<u64>(), any::<u64>()).prop_map(|(token, incarnation, since_epoch)| {
                ClientMessage::Hello {
                    token,
                    incarnation,
                    since_epoch,
                }
            }),
            (
                any::<u64>(),
                any::<u64>(),
                bytes(),
                bytes(),
                prop::option::of(bytes()),
                prop::option::of(bytes()),
                prop::option::of((token(), token(), any::<[u8; 32]>(), any::<u8>())),
            )
                .prop_map(
                    |(req, epoch, commit, group_info, keyring, envelope, rotate)| {
                        ClientMessage::Submit {
                            req,
                            epoch,
                            commit,
                            group_info,
                            keyring,
                            envelope,
                            rotate: rotate.map(|(edit_token, view_token, next, proof)| Rotate {
                                edit_token,
                                view_token,
                                next_owner_key: next,
                                owner_proof: [proof; 64],
                            }),
                        }
                    }
                ),
            (any::<u64>(), bytes(), bytes(), bytes(), any::<[u8; 32]>()).prop_map(
                |(req, group_id, group_info, keyring, owner_key)| ClientMessage::Init {
                    req,
                    group_id,
                    group_info,
                    keyring,
                    owner_key,
                }
            ),
            (any::<u64>(), any::<u64>(), bytes(), bytes(), bytes()).prop_map(
                |(req, incarnation, group_id, group_info, keyring)| ClientMessage::Reset {
                    req,
                    incarnation,
                    group_id,
                    group_info,
                    keyring
                }
            ),
            any::<u64>().prop_map(|since| ClientMessage::Fetch { since }),
        ]
    }

    fn server_message() -> impl Strategy<Value = ServerMessage> {
        prop_oneof![
            (
                any::<u64>(),
                any::<u64>(),
                prop_oneof![
                    Just(Permission::Write),
                    Just(Permission::Read),
                    Just(Permission::Retired)
                ],
                prop::option::of(any::<u64>()),
            )
                .prop_map(|(incarnation, head, permission, retired)| {
                    ServerMessage::Ready {
                        incarnation,
                        head,
                        permission,
                        retired,
                    }
                }),
            (
                any::<u64>(),
                bytes(),
                prop::option::of(bytes()),
                prop::option::of(any::<[u8; OWNER_KEY_LEN]>())
            )
                .prop_map(|(epoch, commit, envelope, owner_key)| {
                    ServerMessage::Commit {
                        epoch,
                        commit,
                        envelope,
                        owner_key,
                    }
                }),
            any::<u64>().prop_map(|req| ServerMessage::Accepted { req }),
            (any::<u64>(), any::<u64>())
                .prop_map(|(req, head)| ServerMessage::Conflict { req, head }),
            (any::<u64>(), 1u8..=10).prop_map(|(req, code)| ServerMessage::Refused {
                req,
                code: RefusalCode::from_byte(code).unwrap()
            }),
            any::<u64>().prop_map(|incarnation| ServerMessage::Reinitialized { incarnation }),
        ]
    }

    proptest! {
        #[test]
        fn client_messages_round_trip(msg in client_message()) {
            prop_assert_eq!(ClientMessage::decode(&msg.encode()), Ok(msg));
        }

        #[test]
        fn server_messages_round_trip(msg in server_message()) {
            prop_assert_eq!(ServerMessage::decode(&msg.encode()), Ok(msg));
        }

        #[test]
        fn garbage_never_panics(input in prop::collection::vec(any::<u8>(), 0..256)) {
            let _ = ClientMessage::decode(&input);
            let _ = ServerMessage::decode(&input);
        }
    }
}
