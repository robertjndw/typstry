//! Reading the routing prefix of an MLS message (RFC 9420) without any
//! crypto.
//!
//! The server never holds a key, yet it has to decide who may send what:
//! viewers may only submit external commits, and every commit has to name
//! the epoch it extends. All of that sits in the plaintext start of an
//! `MLSMessage`, so this parses just that and stops. Nothing here checks
//! signatures or membership, clients do that when they process the commit.
//!
//! Only `PublicMessage` carries the sender and content type in the clear.
//! A `PrivateMessage` shows its group, epoch and content type but not who
//! sent it, so [`FrameInfo::is_external_commit`] is false for one. Callers
//! that need external commits must therefore insist on a public message.

/// `ProtocolVersion` mls10, the only one RFC 9420 defines.
const MLS10: u16 = 1;

/// Group ids are `space_id || incarnation`, so anything near this size is
/// not ours. The cap is about refusing junk early, not about memory: the
/// result borrows the input.
pub const MAX_GROUP_ID: usize = 1024;

/// Length of the random space id a group id starts with.
pub const SPACE_ID_LEN: usize = 16;

/// Exact length of a group id: the space id, then the incarnation as a
/// big-endian u32.
pub const GROUP_ID_LEN: usize = SPACE_ID_LEN + 4;

/// Builds the group id of a space's `incarnation`.
pub fn group_id_of(space_id: &[u8; SPACE_ID_LEN], incarnation: u32) -> Vec<u8> {
    [&space_id[..], &incarnation.to_be_bytes()].concat()
}

/// Splits a well-formed group id into its space id and incarnation.
pub fn split_group_id(group_id: &[u8]) -> Option<(&[u8], u32)> {
    if group_id.len() != GROUP_ID_LEN {
        return None;
    }
    let (space, incarnation) = group_id.split_at(SPACE_ID_LEN);
    Some((space, u32::from_be_bytes(incarnation.try_into().ok()?)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireFormat {
    PublicMessage,
    PrivateMessage,
    Welcome,
    GroupInfo,
    KeyPackage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
    Application,
    Proposal,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    Member { leaf_index: u32 },
    External { sender_index: u32 },
    NewMemberProposal,
    NewMemberCommit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// The input ended inside a field.
    Truncated,
    /// A length header used more bytes than the value needs, or the 8-byte
    /// form, which RFC 9420 section 2.1.2 does not allow.
    BadLength,
    /// A length larger than what is left of the message, or than we accept.
    TooLong,
    UnsupportedVersion(u16),
    UnknownWireFormat(u16),
    UnknownSender(u8),
    UnknownContentType(u8),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => f.write_str("MLS message is truncated"),
            Self::BadLength => f.write_str("MLS message has an invalid length header"),
            Self::TooLong => f.write_str("MLS message field is too long"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported MLS version {v}"),
            Self::UnknownWireFormat(v) => write!(f, "unknown MLS wire format {v}"),
            Self::UnknownSender(v) => write!(f, "unknown MLS sender type {v}"),
            Self::UnknownContentType(v) => write!(f, "unknown MLS content type {v}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// What the plaintext prefix of an `MLSMessage` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameInfo<'a> {
    pub wire_format: WireFormat,
    /// Only for public and private messages.
    pub group_id: Option<&'a [u8]>,
    pub epoch: Option<u64>,
    /// Only for public messages.
    pub sender: Option<Sender>,
    pub content_type: Option<ContentType>,
}

impl FrameInfo<'_> {
    /// A commit a non-member made to join: the only commit a viewer may send.
    pub fn is_external_commit(&self) -> bool {
        self.wire_format == WireFormat::PublicMessage
            && self.content_type == Some(ContentType::Commit)
            && self.sender == Some(Sender::NewMemberCommit)
    }

    /// A commit by a current member, as a public message.
    #[cfg(test)]
    fn is_member_commit(&self) -> bool {
        self.wire_format == WireFormat::PublicMessage
            && self.content_type == Some(ContentType::Commit)
            && matches!(self.sender, Some(Sender::Member { .. }))
    }
}

struct Cursor<'a> {
    buf: &'a [u8],
}

impl<'a> Cursor<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], FrameError> {
        if len > self.buf.len() {
            return Err(FrameError::Truncated);
        }
        let (head, rest) = self.buf.split_at(len);
        self.buf = rest;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, FrameError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, FrameError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, FrameError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, FrameError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    /// The length header of a `<V>` vector (RFC 9420 section 2.1.2). The two
    /// high bits give the header size, and the shortest form that fits is
    /// the only valid one, so a value never has two encodings.
    fn vec_len(&mut self) -> Result<usize, FrameError> {
        let first = self.u8()?;
        let (extra, min) = match first >> 6 {
            0 => (0, 0),
            1 => (1, 1 << 6),
            2 => (3, 1 << 14),
            _ => return Err(FrameError::BadLength),
        };
        let mut value = u32::from(first & 0x3f);
        for byte in self.take(extra)? {
            value = value << 8 | u32::from(*byte);
        }
        if value < min {
            return Err(FrameError::BadLength);
        }
        Ok(value as usize)
    }

    /// The body of a `<V>` vector. The length is checked against the bytes
    /// left before anything uses it, so a hostile header cannot make a
    /// caller reserve memory for data that is not there.
    fn vec(&mut self) -> Result<&'a [u8], FrameError> {
        let len = self.vec_len()?;
        if len > self.buf.len() {
            return Err(FrameError::TooLong);
        }
        self.take(len)
    }
}

fn content_type(raw: u8) -> Result<ContentType, FrameError> {
    match raw {
        1 => Ok(ContentType::Application),
        2 => Ok(ContentType::Proposal),
        3 => Ok(ContentType::Commit),
        other => Err(FrameError::UnknownContentType(other)),
    }
}

/// Parses the start of an `MLSMessage`. Bytes after the prefix are not
/// looked at, so a truncated tail goes unnoticed here by design.
pub fn inspect(bytes: &[u8]) -> Result<FrameInfo<'_>, FrameError> {
    let mut cur = Cursor { buf: bytes };
    let version = cur.u16()?;
    if version != MLS10 {
        return Err(FrameError::UnsupportedVersion(version));
    }
    let wire_format = match cur.u16()? {
        1 => WireFormat::PublicMessage,
        2 => WireFormat::PrivateMessage,
        3 => WireFormat::Welcome,
        4 => WireFormat::GroupInfo,
        5 => WireFormat::KeyPackage,
        other => return Err(FrameError::UnknownWireFormat(other)),
    };
    match wire_format {
        WireFormat::PublicMessage => {
            let group_id = group_id(&mut cur)?;
            let epoch = cur.u64()?;
            let sender = match cur.u8()? {
                1 => Sender::Member {
                    leaf_index: cur.u32()?,
                },
                2 => Sender::External {
                    sender_index: cur.u32()?,
                },
                3 => Sender::NewMemberProposal,
                4 => Sender::NewMemberCommit,
                other => return Err(FrameError::UnknownSender(other)),
            };
            cur.vec()?; // authenticated_data
            let content_type = content_type(cur.u8()?)?;
            Ok(FrameInfo {
                wire_format,
                group_id: Some(group_id),
                epoch: Some(epoch),
                sender: Some(sender),
                content_type: Some(content_type),
            })
        }
        WireFormat::PrivateMessage => {
            let group_id = group_id(&mut cur)?;
            let epoch = cur.u64()?;
            let content_type = content_type(cur.u8()?)?;
            Ok(FrameInfo {
                wire_format,
                group_id: Some(group_id),
                epoch: Some(epoch),
                sender: None,
                content_type: Some(content_type),
            })
        }
        WireFormat::Welcome | WireFormat::GroupInfo | WireFormat::KeyPackage => Ok(FrameInfo {
            wire_format,
            group_id: None,
            epoch: None,
            sender: None,
            content_type: None,
        }),
    }
}

fn group_id<'a>(cur: &mut Cursor<'a>) -> Result<&'a [u8], FrameError> {
    let id = cur.vec()?;
    if id.len() > MAX_GROUP_ID {
        return Err(FrameError::TooLong);
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_ids_split_into_space_and_incarnation() {
        let id = group_id_of(&[7; SPACE_ID_LEN], 0x0102_0304);
        assert_eq!(id.len(), GROUP_ID_LEN);
        assert_eq!(
            split_group_id(&id),
            Some((&[7u8; SPACE_ID_LEN][..], 0x0102_0304))
        );
        assert_eq!(split_group_id(&id[1..]), None);
        assert_eq!(split_group_id(&[id.clone(), vec![0]].concat()), None);
        assert_eq!(split_group_id(b"space-0"), None);
    }

    fn header(wire_format: u16) -> Vec<u8> {
        let mut out = 1u16.to_be_bytes().to_vec();
        out.extend(wire_format.to_be_bytes());
        out
    }

    fn public(group_id: &[u8], epoch: u64, sender: &[u8], ad: &[u8], content: u8) -> Vec<u8> {
        let mut out = header(1);
        out.push(group_id.len() as u8);
        out.extend(group_id);
        out.extend(epoch.to_be_bytes());
        out.extend(sender);
        out.push(ad.len() as u8);
        out.extend(ad);
        out.push(content);
        out.extend([0xde, 0xad]); // the rest of the message, ignored
        out
    }

    #[test]
    fn parses_a_member_commit() {
        let msg = public(b"gid", 7, &[1, 0, 0, 0, 2], b"ad", 3);
        let info = inspect(&msg).unwrap();
        assert_eq!(info.wire_format, WireFormat::PublicMessage);
        assert_eq!(info.group_id, Some(&b"gid"[..]));
        assert_eq!(info.epoch, Some(7));
        assert_eq!(info.sender, Some(Sender::Member { leaf_index: 2 }));
        assert_eq!(info.content_type, Some(ContentType::Commit));
        assert!(info.is_member_commit());
        assert!(!info.is_external_commit());
    }

    #[test]
    fn recognizes_external_commits() {
        let msg = public(b"g", u64::MAX, &[4], b"", 3);
        let info = inspect(&msg).unwrap();
        assert_eq!(info.epoch, Some(u64::MAX));
        assert!(info.is_external_commit());
        let proposal = public(b"g", 1, &[4], b"", 2);
        assert!(!inspect(&proposal).unwrap().is_external_commit());
        let external = public(b"g", 1, &[2, 0, 0, 0, 9], b"", 2);
        assert_eq!(
            inspect(&external).unwrap().sender,
            Some(Sender::External { sender_index: 9 })
        );
        let new_proposal = public(b"g", 1, &[3], b"", 2);
        assert_eq!(
            inspect(&new_proposal).unwrap().sender,
            Some(Sender::NewMemberProposal)
        );
    }

    #[test]
    fn private_messages_hide_the_sender() {
        let mut msg = header(2);
        msg.extend([2, b'a', b'b']);
        msg.extend(5u64.to_be_bytes());
        msg.push(3);
        msg.extend([0xff; 10]);
        let info = inspect(&msg).unwrap();
        assert_eq!(info.wire_format, WireFormat::PrivateMessage);
        assert_eq!(info.epoch, Some(5));
        assert_eq!(info.sender, None);
        assert_eq!(info.content_type, Some(ContentType::Commit));
        assert!(!info.is_external_commit());
        assert!(!info.is_member_commit());
    }

    #[test]
    fn other_wire_formats_carry_no_routing_data() {
        for (raw, format) in [
            (3, WireFormat::Welcome),
            (4, WireFormat::GroupInfo),
            (5, WireFormat::KeyPackage),
        ] {
            let mut msg = header(raw);
            msg.extend([1, 2, 3]);
            let info = inspect(&msg).unwrap();
            assert_eq!(info.wire_format, format);
            assert_eq!(info.group_id, None);
            assert_eq!(info.epoch, None);
        }
    }

    #[test]
    fn rejects_unknown_values() {
        assert_eq!(
            inspect(&[0, 2, 0, 1]),
            Err(FrameError::UnsupportedVersion(2))
        );
        assert_eq!(
            inspect(&[0, 1, 0, 9]),
            Err(FrameError::UnknownWireFormat(9))
        );
        assert_eq!(
            inspect(&public(b"g", 1, &[0], b"", 3)),
            Err(FrameError::UnknownSender(0))
        );
        assert_eq!(
            inspect(&public(b"g", 1, &[4], b"", 4)),
            Err(FrameError::UnknownContentType(4))
        );
    }

    #[test]
    fn every_truncation_is_an_error() {
        let msg = public(b"group", 3, &[1, 0, 0, 0, 1], b"data", 3);
        // The last two bytes are the ignored tail, so cut inside the prefix.
        for len in 0..msg.len() - 2 {
            assert!(inspect(&msg[..len]).is_err(), "len {len}");
        }
        assert!(inspect(&msg[..msg.len() - 2]).is_ok());
    }

    #[test]
    fn length_headers_follow_the_rfc() {
        let mut cur = Cursor {
            buf: &[0x3f, 0x40, 0x40, 0x7f, 0xff, 0x80, 0x00, 0x40, 0x00],
        };
        assert_eq!(cur.vec_len(), Ok(63));
        assert_eq!(cur.vec_len(), Ok(64));
        assert_eq!(cur.vec_len(), Ok(16383));
        assert_eq!(cur.vec_len(), Ok(16384));
    }

    #[test]
    fn rejects_non_minimal_and_eight_byte_lengths() {
        for bad in [
            &[0x40, 0x3f][..],
            &[0x80, 0x00, 0x3f, 0xff],
            &[0x80, 0x00, 0x00, 0x00],
            &[0xc0, 0, 0, 0, 0, 0, 0, 1],
        ] {
            let mut cur = Cursor { buf: bad };
            assert_eq!(cur.vec_len(), Err(FrameError::BadLength), "{bad:?}");
        }
        let mut short = Cursor { buf: &[0x80, 0, 1] };
        assert_eq!(short.vec_len(), Err(FrameError::Truncated));
    }

    #[test]
    fn oversized_lengths_do_not_over_read() {
        // A 4-byte header claiming a gigabyte of group id.
        let mut msg = header(1);
        msg.extend([0xbf, 0xff, 0xff, 0xff, 1, 2, 3]);
        assert_eq!(inspect(&msg), Err(FrameError::TooLong));
        // Fits the message but not the group id cap.
        let mut msg = header(2);
        let id = vec![0u8; MAX_GROUP_ID + 1];
        msg.extend([0x44, 0x01]);
        msg.extend(&id);
        msg.extend(1u64.to_be_bytes());
        msg.push(3);
        assert_eq!(inspect(&msg), Err(FrameError::TooLong));
        // Authenticated data longer than the rest of the message.
        let mut msg = public(b"g", 1, &[4], b"", 3);
        msg[2 + 2 + 1 + 1 + 8 + 1] = 0x7f;
        assert!(inspect(&msg).is_err());
    }
}
