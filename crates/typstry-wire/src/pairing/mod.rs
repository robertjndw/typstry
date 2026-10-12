//! Pairing two devices of one person over the relay.
//!
//! A device that is already one of the person's shows (or is shown) a short
//! code. The two sides run a symmetric SPAKE2 on it, so a bystander on the
//! relay learns nothing to guess offline, and confirm they derived the same
//! key. Only then does the new device announce itself, the holder's user
//! approves it, and the person graph, extended by the new device, travels
//! sealed under the PAKE key.
//!
//! [`Pairing`] is sans-IO: feed it every frame the relay delivers with
//! [`Pairing::handle`] and send whatever it returns. One code allows one
//! attempt. Any failure kills the machine and every later call errors, so
//! a wrong guess cannot be retried on the same channel.

mod code;

use hkdf::Hkdf;
use loro_protocol::{BytesReader, BytesWriter};
use rand_core::{CryptoRng, Error as RandError, RngCore};
use sha2::Sha256;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use zeroize::Zeroizing;

pub use crate::words::WORDS;
pub use code::{Code, CodeError};

use crate::crypto::{KEY_LEN, LinkSecret, PublicKey, SealKey};
use crate::identity::MAX_GRAPH_BYTES;
use crate::owner::OwnerSecrets;
use crate::relay::MAX_RELAY_MESSAGE;

/// The PAKE identity, so a code cannot be replayed into another protocol.
const IDENTITY: &[u8] = b"typstry:v1:pair";
const CONFIRM_INFO: &[u8] = b"typstry:v1:pair-confirm";
const SEAL_INFO: &[u8] = b"typstry:v1:pair-seal";
const HELLO_CONTEXT: &str = "typstry:v1:pair-hello";
const GRANT_CONTEXT: &str = "typstry:v1:pair-grant";
const REJECT_CONTEXT: &str = "typstry:v1:pair-reject";

const FRAME_VERSION: u8 = 1;
const GRANT_VERSION: u8 = 1;
const HELLO_VERSION: u8 = 1;

const TAG_PAKE: u8 = 1;
const TAG_CONFIRM: u8 = 2;
const TAG_HELLO: u8 = 3;
const TAG_GRANT: u8 = 4;
const TAG_REJECT: u8 = 5;

/// Limits that keep a grant well under [`MAX_RELAY_MESSAGE`].
pub const MAX_LINK_LEN: usize = 400;
pub const MAX_DEVICE_NAME_LEN: usize = 64;
/// An encoded `OwnerSecrets` holds at most `2 * KEEP` secrets, well under this.
pub const MAX_OWNER_SECRETS_LEN: usize = 4096;

const _: () = assert!(
    MAX_GRAPH_BYTES
        + MAX_DEVICE_NAME_LEN
        + crate::token::TOKEN_LEN
        + MAX_LINK_LEN
        + MAX_OWNER_SECRETS_LEN
        + 1024
        < MAX_RELAY_MESSAGE
);

#[derive(Debug, thiserror::Error)]
pub enum PairError {
    /// The confirmation did not match: the other side typed another code, or
    /// someone else answered. The pairing is over either way.
    #[error("the code did not match")]
    WrongCode,
    #[error("both devices claim the same side of the pairing")]
    RoleConflict,
    #[error("unexpected message for this step of the pairing")]
    Unexpected,
    #[error("the pairing is over")]
    Finished,
    #[error("a sealed message could not be opened")]
    Tampered,
    #[error("made by a newer version of typstry (format {0}); update typstry to pair")]
    NewerVersion(u8),
    #[error("malformed pairing message: {0}")]
    Malformed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Is a device of the person already and adds the other one.
    Holder,
    /// Wants to become a device of the person.
    New,
}

impl Role {
    fn byte(self) -> u8 {
        match self {
            Role::Holder => 1,
            Role::New => 2,
        }
    }

    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Role::Holder),
            2 => Some(Role::New),
            _ => None,
        }
    }

    fn other(self) -> Self {
        match self {
            Role::Holder => Role::New,
            Role::New => Role::Holder,
        }
    }
}

/// What the holder hands over: the person graph with the new device in it,
/// the person's personal space (whose directory lists the projects), and
/// the name the holder's user gave the holder, so the new device can label
/// the device that vouched for it.
#[derive(Clone)]
pub struct Grant {
    pub holder_name: String,
    /// An encoded `PersonGraph`.
    pub graph: Vec<u8>,
    /// The person's personal space on the pairing server, so the new device
    /// syncs the same directory.
    pub space: GrantedSpace,
}

/// A personal space handed to the new device: its edit link and the owner
/// secrets the holder keeps for it, which every device of the person needs
/// to act as an owner.
#[derive(Clone, PartialEq, Eq)]
pub struct GrantedSpace {
    pub token: String,
    /// An edit secret in link form (base64url).
    pub secret: Zeroizing<String>,
    /// An encoded `OwnerSecrets`.
    pub owner_secrets: Zeroizing<Vec<u8>>,
}

impl GrantedSpace {
    /// A space fitted to the grant's rules, or `Malformed` when `token` is
    /// not a token, `secret` is not an edit secret, or `owner_secrets` is
    /// empty, too long or not an `OwnerSecrets` encoding.
    pub fn new(token: String, secret: String, owner_secrets: Vec<u8>) -> Result<Self, PairError> {
        let space = Self {
            token,
            secret: Zeroizing::new(secret),
            owner_secrets: Zeroizing::new(owner_secrets),
        };
        space.check()?;
        Ok(space)
    }

    fn check(&self) -> Result<(), PairError> {
        let bad = |what: &str| PairError::Malformed(format!("space {what}"));
        if !crate::token::looks_valid(&self.token) {
            return Err(bad("token is not a token"));
        }
        if self.secret.len() > MAX_LINK_LEN {
            return Err(bad("secret is too long"));
        }
        // Only an edit secret lets the new device write the directory.
        match LinkSecret::from_base64url(&self.secret) {
            Ok(secret) if secret.can_attest() => {}
            _ => return Err(bad("secret is not an edit secret")),
        }
        if self.owner_secrets.is_empty() || self.owner_secrets.len() > MAX_OWNER_SECRETS_LEN {
            return Err(bad("owner secrets have an invalid size"));
        }
        match OwnerSecrets::decode(&self.owner_secrets) {
            Ok(set) if !set.is_empty() => Ok(()),
            _ => Err(bad("owner secrets do not decode")),
        }
    }
}

impl std::fmt::Debug for GrantedSpace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GrantedSpace").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Grant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grant").finish_non_exhaustive()
    }
}

impl Grant {
    pub fn new(holder_name: String, graph: Vec<u8>, space: GrantedSpace) -> Self {
        Self {
            holder_name,
            graph,
            space,
        }
    }

    fn check(&self) -> Result<(), PairError> {
        check_device_name(&self.holder_name)?;
        if self.graph.len() > MAX_GRAPH_BYTES {
            return Err(PairError::Malformed("person graph is too large".into()));
        }
        self.space.check()?;
        Ok(())
    }

    fn encode(&self) -> Result<Zeroizing<Vec<u8>>, PairError> {
        self.check()?;
        let mut w = BytesWriter::new();
        w.push_byte(GRANT_VERSION);
        w.push_var_bytes(&self.graph);
        w.push_var_string(&self.holder_name);
        w.push_var_string(&self.space.token);
        w.push_var_string(&self.space.secret);
        w.push_var_bytes(&self.space.owner_secrets);
        Ok(Zeroizing::new(w.finalize()))
    }

    fn decode(bytes: &[u8]) -> Result<Self, PairError> {
        let mut r = BytesReader::new(bytes);
        version(&mut r, GRANT_VERSION)?;
        let graph = r.read_var_bytes().map_err(PairError::Malformed)?.to_vec();
        let holder_name = r.read_var_string().map_err(PairError::Malformed)?;
        let space = GrantedSpace {
            token: r.read_var_string().map_err(PairError::Malformed)?,
            secret: Zeroizing::new(r.read_var_string().map_err(PairError::Malformed)?),
            owner_secrets: Zeroizing::new(
                r.read_var_bytes().map_err(PairError::Malformed)?.to_vec(),
            ),
        };
        done(&r)?;
        let grant = Self {
            holder_name,
            graph,
            space,
        };
        grant.check()?;
        Ok(grant)
    }
}

fn version(r: &mut BytesReader<'_>, known: u8) -> Result<(), PairError> {
    match r.read_byte().map_err(PairError::Malformed)? {
        v if v == known => Ok(()),
        v => Err(PairError::NewerVersion(v)),
    }
}

fn done(r: &BytesReader<'_>) -> Result<(), PairError> {
    match r.remaining() {
        0 => Ok(()),
        n => Err(PairError::Malformed(format!("{n} trailing bytes"))),
    }
}

/// What a step of the pairing means for the app.
#[derive(Debug)]
pub enum Event {
    /// Both sides proved they know the code. The channel is now private.
    Verified,
    /// Holder only: show "<device_name> wants to join as you" and then call
    /// [`Pairing::approve`] or [`Pairing::reject`]. `device_pub` is the key
    /// to add to the graph.
    AwaitApproval {
        device_name: String,
        device_pub: PublicKey,
    },
    /// New only: the holder approved.
    Granted(Grant),
    /// New only: the holder said no.
    Rejected,
}

/// The outcome of one received frame.
#[derive(Debug, Default)]
pub struct Step {
    /// A frame to send to the peer, if any.
    pub send: Option<Vec<u8>>,
    pub event: Option<Event>,
}

enum State {
    AwaitPake {
        spake: Spake2<Ed25519Group>,
        own_msg: Vec<u8>,
    },
    AwaitConfirm {
        expected: [u8; KEY_LEN],
        seal: SealKey,
    },
    AwaitHello {
        seal: SealKey,
    },
    AwaitApproval {
        seal: SealKey,
    },
    AwaitGrant {
        seal: SealKey,
    },
    Finished,
    Dead,
}

pub struct Pairing {
    role: Role,
    /// What the new side announces; unused by the holder.
    hello: Hello,
    state: State,
}

impl std::fmt::Debug for Pairing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pairing")
            .field("role", &self.role)
            .finish_non_exhaustive()
    }
}

impl Pairing {
    /// The side that is a device of the person already. Send the returned
    /// frame first.
    pub fn start_holder(code: &Code) -> (Self, Vec<u8>) {
        Self::start(code, Role::Holder, Hello::default())
    }

    /// The side that wants to join. `device_name` is what the holder's user
    /// sees when approving, and `device_pub` the key they add to the graph.
    pub fn start_new(
        code: &Code,
        device_name: &str,
        device_pub: &PublicKey,
    ) -> Result<(Self, Vec<u8>), PairError> {
        check_device_name(device_name)?;
        let hello = Hello {
            device_name: device_name.to_string(),
            device_pub: *device_pub,
        };
        Ok(Self::start(code, Role::New, hello))
    }

    fn start(code: &Code, role: Role, hello: Hello) -> (Self, Vec<u8>) {
        let (spake, own_msg) = Spake2::<Ed25519Group>::start_symmetric_with_rng(
            &Password::new(code.password()),
            &Identity::new(IDENTITY),
            GetrandomRng,
        );
        let first = frame(TAG_PAKE, &own_msg);
        (
            Self {
                role,
                hello,
                state: State::AwaitPake { spake, own_msg },
            },
            first,
        )
    }

    pub fn role(&self) -> Role {
        self.role
    }

    /// Whether the pairing ended, one way or the other.
    #[cfg(test)]
    pub fn is_over(&self) -> bool {
        matches!(self.state, State::Finished | State::Dead)
    }

    /// Feeds one frame from the relay. An error ends the pairing for good.
    pub fn handle(&mut self, bytes: &[u8]) -> Result<Step, PairError> {
        let state = std::mem::replace(&mut self.state, State::Dead);
        if matches!(state, State::Dead | State::Finished) {
            self.state = state;
            return Err(PairError::Finished);
        }
        // `state` is dropped on error, which leaves the machine dead.
        let (next, step) = self.advance(state, bytes)?;
        self.state = next;
        Ok(step)
    }

    fn advance(&self, state: State, bytes: &[u8]) -> Result<(State, Step), PairError> {
        let (tag, payload) = split_frame(bytes)?;
        match (state, tag) {
            (State::AwaitPake { spake, own_msg }, TAG_PAKE) => {
                // A reflected message would otherwise look like a peer that
                // typed the same code.
                if payload == own_msg {
                    return Err(PairError::Malformed("own message echoed back".into()));
                }
                let key = Zeroizing::new(
                    spake
                        .finish(payload)
                        .map_err(|e| PairError::Malformed(format!("key exchange: {e}")))?,
                );
                let transcript = transcript(&own_msg, payload);
                let hk = Hkdf::<Sha256>::new(Some(&transcript), &key);
                let mut seal = Zeroizing::new([0; KEY_LEN]);
                hk.expand(SEAL_INFO, seal.as_mut()).expect("32 bytes");
                let own = confirm_tag(&hk, self.role);
                let expected = confirm_tag(&hk, self.role.other());
                let mut body = vec![self.role.byte()];
                body.extend_from_slice(&own);
                Ok((
                    State::AwaitConfirm {
                        expected,
                        seal: SealKey::new(*seal),
                    },
                    Step {
                        send: Some(frame(TAG_CONFIRM, &body)),
                        event: None,
                    },
                ))
            }
            (State::AwaitConfirm { expected, seal }, TAG_CONFIRM) => {
                let (&role, tag) = payload
                    .split_first()
                    .ok_or_else(|| PairError::Malformed("empty confirmation".into()))?;
                let peer = Role::from_byte(role)
                    .ok_or_else(|| PairError::Malformed("unknown role".into()))?;
                if peer == self.role {
                    return Err(PairError::RoleConflict);
                }
                if !constant_time_eq(tag, &expected) {
                    return Err(PairError::WrongCode);
                }
                let event = Some(Event::Verified);
                Ok(match self.role {
                    Role::Holder => (State::AwaitHello { seal }, Step { send: None, event }),
                    // Only now, so nothing about this device goes out before
                    // the holder proved it knows the code.
                    Role::New => {
                        let hello = self.hello.encode();
                        let send = frame(TAG_HELLO, &seal.seal(&hello, HELLO_CONTEXT));
                        (
                            State::AwaitGrant { seal },
                            Step {
                                send: Some(send),
                                event,
                            },
                        )
                    }
                })
            }
            (State::AwaitHello { seal }, TAG_HELLO) => {
                let plain = open(&seal, payload, HELLO_CONTEXT)?;
                let Hello {
                    device_name,
                    device_pub,
                } = Hello::decode(&plain)?;
                Ok((
                    State::AwaitApproval { seal },
                    Step {
                        send: None,
                        event: Some(Event::AwaitApproval {
                            device_name,
                            device_pub,
                        }),
                    },
                ))
            }
            (State::AwaitGrant { seal }, TAG_GRANT) => {
                let plain = open(&seal, payload, GRANT_CONTEXT)?;
                let grant = Grant::decode(&plain)?;
                Ok((
                    State::Finished,
                    Step {
                        send: None,
                        event: Some(Event::Granted(grant)),
                    },
                ))
            }
            (State::AwaitGrant { seal }, TAG_REJECT) => {
                open(&seal, payload, REJECT_CONTEXT)?;
                Ok((
                    State::Finished,
                    Step {
                        send: None,
                        event: Some(Event::Rejected),
                    },
                ))
            }
            _ => Err(PairError::Unexpected),
        }
    }

    /// Holder only, after [`Event::AwaitApproval`]: sends the grant.
    pub fn approve(&mut self, grant: &Grant) -> Result<Vec<u8>, PairError> {
        let plain = grant.encode()?;
        let State::AwaitApproval { seal } = self.take_approval()? else {
            unreachable!("take_approval only returns the approval state");
        };
        Ok(frame(TAG_GRANT, &seal.seal(&plain, GRANT_CONTEXT)))
    }

    /// Holder only, after [`Event::AwaitApproval`]: turns the device away.
    pub fn reject(&mut self) -> Result<Vec<u8>, PairError> {
        let State::AwaitApproval { seal } = self.take_approval()? else {
            unreachable!("take_approval only returns the approval state");
        };
        Ok(frame(TAG_REJECT, &seal.seal(&[], REJECT_CONTEXT)))
    }

    /// Leaves the machine finished on success and dead otherwise.
    fn take_approval(&mut self) -> Result<State, PairError> {
        match std::mem::replace(&mut self.state, State::Dead) {
            state @ State::AwaitApproval { .. } => {
                self.state = State::Finished;
                Ok(state)
            }
            State::Finished => {
                self.state = State::Finished;
                Err(PairError::Finished)
            }
            State::Dead => Err(PairError::Finished),
            _ => Err(PairError::Unexpected),
        }
    }
}

/// Whether the pairing takes `name` as a device name: not empty, at most
/// [`MAX_DEVICE_NAME_LEN`] bytes, and without control characters, since the
/// holder shows it on a terminal or page.
pub fn valid_device_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_DEVICE_NAME_LEN && !name.chars().any(char::is_control)
}

/// `name` made into a [`valid_device_name`]: control characters become
/// spaces, the ends are trimmed and it is cut to [`MAX_DEVICE_NAME_LEN`]
/// bytes on a character boundary. `None` when nothing is left.
pub fn fit_device_name(name: &str) -> Option<String> {
    let clean: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let fitted = truncate(clean.trim(), MAX_DEVICE_NAME_LEN).trim_end();
    (!fitted.is_empty()).then(|| fitted.to_owned())
}

/// At most `max` bytes of `text`, cut on a character boundary: the limits
/// count bytes.
fn truncate(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn check_device_name(name: &str) -> Result<(), PairError> {
    if !valid_device_name(name) {
        return Err(PairError::Malformed("invalid device name".into()));
    }
    Ok(())
}

/// What the new device announces once the code is proven.
#[derive(Default)]
struct Hello {
    device_name: String,
    device_pub: PublicKey,
}

impl Hello {
    fn encode(&self) -> Vec<u8> {
        let mut w = BytesWriter::new();
        w.push_byte(HELLO_VERSION);
        w.push_var_string(&self.device_name);
        w.push_bytes(&self.device_pub);
        w.finalize()
    }

    fn decode(bytes: &[u8]) -> Result<Self, PairError> {
        let mut r = BytesReader::new(bytes);
        version(&mut r, HELLO_VERSION)?;
        let device_name = r.read_var_string().map_err(PairError::Malformed)?;
        let device_pub = r
            .read_bytes(KEY_LEN)
            .map_err(PairError::Malformed)?
            .try_into()
            .expect("read 32 bytes");
        done(&r)?;
        check_device_name(&device_name)?;
        Ok(Self {
            device_name,
            device_pub,
        })
    }
}

fn open(seal: &SealKey, sealed: &[u8], context: &str) -> Result<Zeroizing<Vec<u8>>, PairError> {
    seal.open(sealed, context)
        .map(Zeroizing::new)
        .map_err(|_| PairError::Tampered)
}

fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + payload.len());
    out.push(FRAME_VERSION);
    out.push(tag);
    out.extend_from_slice(payload);
    out
}

fn split_frame(bytes: &[u8]) -> Result<(u8, &[u8]), PairError> {
    match bytes {
        [FRAME_VERSION, tag, payload @ ..] => Ok((*tag, payload)),
        [v, _, ..] if *v != FRAME_VERSION => Err(PairError::NewerVersion(*v)),
        _ => Err(PairError::Malformed("frame too short".into())),
    }
}

/// Both PAKE messages in a fixed order, length-prefixed, so each side binds
/// the same bytes whichever message it sent.
fn transcript(a: &[u8], b: &[u8]) -> Vec<u8> {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut out = Vec::with_capacity(lo.len() + hi.len() + 2);
    for part in [lo, hi] {
        out.push(part.len() as u8);
        out.extend_from_slice(part);
    }
    out
}

fn confirm_tag(hk: &Hkdf<Sha256>, role: Role) -> [u8; KEY_LEN] {
    let mut out = [0; KEY_LEN];
    hk.expand_multi_info(&[CONFIRM_INFO, &[role.byte()]], &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// spake2 0.4 draws from rand_core 0.6. Feeding it from our own getrandom
/// keeps the older getrandom out of the build, which wasm would need a
/// separate `js` feature for.
struct GetrandomRng;

impl RngCore for GetrandomRng {
    fn next_u32(&mut self) -> u32 {
        u32::from_le_bytes(crate::crypto::random())
    }

    fn next_u64(&mut self) -> u64 {
        u64::from_le_bytes(crate::crypto::random())
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        getrandom::fill(dest).expect("OS random source unavailable");
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), RandError> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl CryptoRng for GetrandomRng {}

#[cfg(test)]
mod tests;
