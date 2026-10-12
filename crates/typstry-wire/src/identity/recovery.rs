//! A recovery key: a device key that is written down instead of kept on a
//! device, so losing every device does not mean losing the person.
//!
//! The key is spelled as 16 words of the pairing word list (one byte each,
//! 128 bits) and one checksum word. The words are the secret; the Ed25519
//! seed is derived from them, so the same words always give the same key.
//! The key is added to the graph with [`FLAG_RECOVERY`](super::FLAG_RECOVERY)
//! and then only ever signs adds and revokes.

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::adopt::{AdoptError, adopt};
use super::{DeviceKey, DeviceState, EntryKind, GraphError, PersonGraph};
use crate::crypto::{PublicKey, hkdf, random};
use crate::words::{WORDS, word_index};

const RECOVERY_INFO: &[u8] = b"typstry:v1:recovery-key";
const CHECKSUM_CONTEXT: &[u8] = b"typstry:v1:recovery-check";
const SECRET_LEN: usize = 16;
// Secret words plus the checksum word, as the error message says.
const _: () = assert!(SECRET_LEN + 1 == 17);

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum RecoveryError {
    #[error("a recovery key is 17 words, not {0}")]
    WordCount(usize),
    #[error("\"{0}\" is not a word of the recovery key")]
    Word(String),
    #[error("the words do not add up; check for a typo or a swapped word")]
    Checksum,
}

pub struct RecoveryKey;

impl RecoveryKey {
    /// A fresh key and the words that spell it. Show the words once; they
    /// are not stored anywhere.
    pub fn generate() -> (DeviceKey, String) {
        let secret = Zeroizing::new(random::<SECRET_LEN>());
        let words = secret
            .iter()
            .copied()
            .chain([checksum(&secret)])
            .map(|byte| WORDS[usize::from(byte)])
            .collect::<Vec<_>>()
            .join(" ");
        (derive(&secret), words)
    }

    /// The key for `words`, in any case and with any mix of whitespace,
    /// hyphens and commas between them, as people copy them down.
    pub fn from_words(words: &str) -> Result<DeviceKey, RecoveryError> {
        let lower = words.to_ascii_lowercase();
        let parts: Vec<&str> = lower
            .split(|c: char| c.is_whitespace() || c == '-' || c == ',')
            .filter(|part| !part.is_empty())
            .collect();
        if parts.len() != SECRET_LEN + 1 {
            return Err(RecoveryError::WordCount(parts.len()));
        }
        let mut bytes = Zeroizing::new([0u8; SECRET_LEN + 1]);
        for (slot, part) in bytes.iter_mut().zip(&parts) {
            *slot = word_index(part).ok_or_else(|| RecoveryError::Word((*part).into()))?;
        }
        let (secret, check) = bytes.split_at(SECRET_LEN);
        let secret = Zeroizing::new(<[u8; SECRET_LEN]>::try_from(secret).expect("split at 16"));
        if check[0] != checksum(&secret) {
            return Err(RecoveryError::Checksum);
        }
        Ok(derive(&secret))
    }
}

/// Why [`recover`] refused.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum RecoverError {
    #[error("this recovery key does not belong to anyone there")]
    UnknownKey,
    /// The stored copy of the person's graph revokes the recovery key,
    /// which the graph it was found in did not know yet.
    #[error("this recovery key was revoked")]
    KeyRevoked,
    /// A revoke is final, so this device key can never be the person's
    /// again; recovering needs a new one.
    #[error("this device's key was revoked from that person")]
    OwnRevoked,
    #[error(transparent)]
    Adopt(#[from] AdoptError),
    #[error(transparent)]
    Graph(#[from] GraphError),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecoverOptions {
    /// Leave the person's other devices valid instead of revoking them.
    pub keep_others: bool,
    /// Switch away from another person this device is a working device of.
    pub replace: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovered {
    /// The graph to store, with this device valid in it.
    pub graph: PersonGraph,
    /// The devices the recovery revoked, sorted.
    pub revoked: Vec<PublicKey>,
}

/// Makes `own` a device of the person the `recovery` key belongs to, signed
/// by that key, and unless [`RecoverOptions::keep_others`] revokes every
/// other ordinary device of the person: after a loss those are presumed in
/// the wrong hands. Recovery devices stay, since they are not on a device.
///
/// `graphs` are the candidates, e.g. what `mls::graphs_in_group_info` read
/// from a project; the first in which the key is a valid recovery
/// device is the person. `stored` is the graph this device holds, if any.
/// Of the same person it is merged in before anything is decided, so a
/// revoke only this device had heard of still counts: a project's copy can
/// be behind. Of another person, [`adopt`]'s rules decide whether it may be
/// left behind.
///
/// The result is what [`adopt`] gives for `stored`, so a caller just stores
/// it. Pure: the caller makes the device key and writes the graph.
pub fn recover(
    graphs: &[PersonGraph],
    recovery: &DeviceKey,
    own: &PublicKey,
    stored: Option<&PersonGraph>,
    opts: RecoverOptions,
) -> Result<Recovered, RecoverError> {
    let key = recovery.public();
    let mut graph = graphs
        .iter()
        .find(|g| g.is_recovery(&key) && g.device_state(&key) == DeviceState::Valid)
        .ok_or(RecoverError::UnknownKey)?
        .clone();
    if let Some(stored) = stored.filter(|s| s.id() == graph.id()) {
        graph.merge(stored)?;
        if graph.device_state(&key) != DeviceState::Valid {
            return Err(RecoverError::KeyRevoked);
        }
    }
    match graph.device_state(own) {
        DeviceState::Revoked => return Err(RecoverError::OwnRevoked),
        DeviceState::Valid => {}
        DeviceState::Unknown => {
            graph.append(
                recovery,
                EntryKind::AddDevice {
                    device: *own,
                    flags: 0,
                },
            )?;
        }
    }
    let mut revoked = Vec::new();
    if !opts.keep_others {
        let lost: Vec<PublicKey> = graph
            .devices()
            .into_iter()
            .filter(|d| d.state == DeviceState::Valid && !d.recovery && d.device != *own)
            .map(|d| d.device)
            .collect();
        for device in lost {
            graph.append(recovery, EntryKind::RevokeDevice { device })?;
            revoked.push(device);
        }
    }
    let graph = adopt(stored, &graph, own, opts.replace)?;
    Ok(Recovered { graph, revoked })
}

fn checksum(secret: &[u8; SECRET_LEN]) -> u8 {
    Sha256::digest([CHECKSUM_CONTEXT, secret].concat())[0]
}

fn derive(secret: &[u8; SECRET_LEN]) -> DeviceKey {
    let seed = hkdf(secret, &[], &[RECOVERY_INFO]);
    DeviceKey::import(seed.as_ref()).expect("an HKDF output is a 32-byte seed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_roundtrip_to_the_same_key() {
        let (key, words) = RecoveryKey::generate();
        assert_eq!(words.split(' ').count(), SECRET_LEN + 1);
        let again = RecoveryKey::from_words(&words).unwrap();
        assert_eq!(key.public(), again.public());
        let (other, _) = RecoveryKey::generate();
        assert_ne!(key.public(), other.public());
    }

    #[test]
    fn spelling_is_forgiving() {
        let (key, words) = RecoveryKey::generate();
        let messy = format!("  {}\n", words.to_uppercase().replace(' ', " \t- "));
        assert_eq!(
            RecoveryKey::from_words(&messy).unwrap().public(),
            key.public()
        );
        let hyphens = words.replace(' ', "-");
        assert_eq!(
            RecoveryKey::from_words(&hyphens).unwrap().public(),
            key.public()
        );
    }

    #[test]
    fn rejects_typos_and_bad_shapes() {
        let (_, words) = RecoveryKey::generate();
        let parts: Vec<&str> = words.split(' ').collect();

        let mut wrong_check = parts.clone();
        let other = WORDS[usize::from(word_index(parts[16]).unwrap().wrapping_add(1))];
        wrong_check[16] = other;
        assert_eq!(
            RecoveryKey::from_words(&wrong_check.join(" ")).err(),
            Some(RecoveryError::Checksum)
        );

        let mut unknown = parts.clone();
        unknown[3] = "notaword";
        assert_eq!(
            RecoveryKey::from_words(&unknown.join(" ")).err(),
            Some(RecoveryError::Word("notaword".into()))
        );

        assert_eq!(
            RecoveryKey::from_words(&parts[..16].join(" ")).err(),
            Some(RecoveryError::WordCount(16))
        );
        assert_eq!(
            RecoveryKey::from_words("").err(),
            Some(RecoveryError::WordCount(0))
        );
    }

    #[test]
    fn key_derivation_is_pinned() {
        // The words are the only backup, so the derivation can never change.
        let words = format!("{} anvil", ["acorn"; SECRET_LEN].join(" "));
        let key = RecoveryKey::from_words(&words).unwrap();
        let public: String = key.public().iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            public,
            "206a858377b2c234c4705e7e1d6a0e02820e50d0caf92b40d308b34eee8cc0c4"
        );
    }

    /// A person whose laptop and phone are valid, with a recovery key.
    struct Person {
        laptop: DeviceKey,
        phone: DeviceKey,
        recovery: DeviceKey,
        graph: PersonGraph,
    }

    fn person() -> Person {
        let (laptop, phone) = (DeviceKey::generate(), DeviceKey::generate());
        let (recovery, _) = RecoveryKey::generate();
        let mut graph = PersonGraph::genesis(&laptop);
        for (device, flags) in [(&phone, 0), (&recovery, super::super::FLAG_RECOVERY)] {
            graph
                .append(
                    &laptop,
                    EntryKind::AddDevice {
                        device: device.public(),
                        flags,
                    },
                )
                .unwrap();
        }
        Person {
            laptop,
            phone,
            recovery,
            graph,
        }
    }

    fn state(graph: &PersonGraph, device: &DeviceKey) -> DeviceState {
        graph.device_state(&device.public())
    }

    #[test]
    fn recovery_adds_this_device_and_revokes_the_others() {
        let p = person();
        let stranger = PersonGraph::genesis(&DeviceKey::generate());
        let fresh = DeviceKey::generate();
        let out = recover(
            &[stranger, p.graph.clone()],
            &p.recovery,
            &fresh.public(),
            None,
            RecoverOptions::default(),
        )
        .unwrap();
        assert_eq!(out.graph.id(), p.graph.id());
        assert_eq!(state(&out.graph, &fresh), DeviceState::Valid);
        assert_eq!(state(&out.graph, &p.recovery), DeviceState::Valid);
        for lost in [&p.laptop, &p.phone] {
            assert_eq!(state(&out.graph, lost), DeviceState::Revoked);
        }
        let mut want = vec![p.laptop.public(), p.phone.public()];
        want.sort();
        assert_eq!(out.revoked, want);
    }

    #[test]
    fn keep_others_only_adds() {
        let p = person();
        let fresh = DeviceKey::generate();
        let opts = RecoverOptions {
            keep_others: true,
            ..Default::default()
        };
        let out = recover(
            std::slice::from_ref(&p.graph),
            &p.recovery,
            &fresh.public(),
            None,
            opts,
        )
        .unwrap();
        assert!(out.revoked.is_empty());
        assert_eq!(out.graph.valid_devices().len(), 4);
        // A device that is valid already is not added twice.
        let again = recover(
            std::slice::from_ref(&out.graph),
            &p.recovery,
            &fresh.public(),
            None,
            opts,
        )
        .unwrap();
        assert_eq!(again.graph, out.graph);
    }

    #[test]
    fn a_key_nobody_has_or_that_is_no_recovery_key_is_refused() {
        let p = person();
        let (other, _) = RecoveryKey::generate();
        let own = DeviceKey::generate().public();
        let opts = RecoverOptions::default();
        let graphs = [p.graph.clone()];
        assert_eq!(
            recover(&graphs, &other, &own, None, opts),
            Err(RecoverError::UnknownKey)
        );
        // An ordinary device key is not a recovery key.
        assert_eq!(
            recover(&graphs, &p.phone, &own, None, opts),
            Err(RecoverError::UnknownKey)
        );
    }

    #[test]
    fn a_revoked_device_cannot_recover_even_if_only_its_own_copy_knows() {
        let p = person();
        let opts = RecoverOptions::default();
        let mut revoked = p.graph.clone();
        revoked
            .append(
                &p.laptop,
                EntryKind::RevokeDevice {
                    device: p.phone.public(),
                },
            )
            .unwrap();
        assert_eq!(
            recover(
                &[revoked.clone()],
                &p.recovery,
                &p.phone.public(),
                None,
                opts
            ),
            Err(RecoverError::OwnRevoked)
        );
        // The project's copy is behind; the stored one has the revoke.
        assert_eq!(
            recover(
                std::slice::from_ref(&p.graph),
                &p.recovery,
                &p.phone.public(),
                Some(&revoked),
                opts
            ),
            Err(RecoverError::OwnRevoked)
        );
    }

    #[test]
    fn a_stored_revoke_of_the_recovery_key_counts() {
        let p = person();
        let mut stored = p.graph.clone();
        stored
            .append(
                &p.laptop,
                EntryKind::RevokeDevice {
                    device: p.recovery.public(),
                },
            )
            .unwrap();
        assert_eq!(
            recover(
                std::slice::from_ref(&p.graph),
                &p.recovery,
                &p.phone.public(),
                Some(&stored),
                RecoverOptions::default()
            ),
            Err(RecoverError::KeyRevoked)
        );
    }

    #[test]
    fn a_still_valid_device_recovers_and_keeps_its_stored_entries() {
        let p = person();
        let mut stored = p.graph.clone();
        let extra = DeviceKey::generate();
        stored
            .append(
                &p.phone,
                EntryKind::AddDevice {
                    device: extra.public(),
                    flags: 0,
                },
            )
            .unwrap();
        let out = recover(
            std::slice::from_ref(&p.graph),
            &p.recovery,
            &p.phone.public(),
            Some(&stored),
            RecoverOptions::default(),
        )
        .unwrap();
        assert!(out.graph.is_superset_of(&stored));
        assert_eq!(state(&out.graph, &p.phone), DeviceState::Valid);
        assert_eq!(state(&out.graph, &extra), DeviceState::Revoked);
        assert!(out.revoked.contains(&extra.public()));
    }

    #[test]
    fn another_identity_is_only_left_with_replace_or_once_revoked() {
        let p = person();
        let own = DeviceKey::generate();
        let mine = PersonGraph::genesis(&own);
        let opts = RecoverOptions::default();
        assert_eq!(
            recover(
                std::slice::from_ref(&p.graph),
                &p.recovery,
                &own.public(),
                Some(&mine),
                opts
            ),
            Err(RecoverError::Adopt(AdoptError::ForeignIdentity {
                stored: mine.id()
            }))
        );
        let replace = RecoverOptions {
            replace: true,
            ..opts
        };
        let out = recover(
            std::slice::from_ref(&p.graph),
            &p.recovery,
            &own.public(),
            Some(&mine),
            replace,
        )
        .unwrap();
        assert_eq!(out.graph.id(), p.graph.id());

        // Revoked from its old person, it needs no replace.
        let other = DeviceKey::generate();
        let mut lost = PersonGraph::genesis(&other);
        lost.append(
            &other,
            EntryKind::AddDevice {
                device: own.public(),
                flags: 0,
            },
        )
        .unwrap();
        lost.append(
            &other,
            EntryKind::RevokeDevice {
                device: own.public(),
            },
        )
        .unwrap();
        let out = recover(
            std::slice::from_ref(&p.graph),
            &p.recovery,
            &own.public(),
            Some(&lost),
            opts,
        )
        .unwrap();
        assert_eq!(out.graph.id(), p.graph.id());
    }
}
