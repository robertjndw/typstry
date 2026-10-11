//! Taking on a person graph that comes from elsewhere: a pairing grant, a
//! recovery, a project's copy of the person's own graph.

use super::{DeviceState, GraphError, PersonGraph, PersonId};
use crate::crypto::PublicKey;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AdoptError {
    /// This device is a working device of `stored`, another person, and
    /// switching was not asked for.
    #[error("this device already belongs to another person")]
    ForeignIdentity { stored: PersonId },
    /// The incoming graph is of another person and does not list this
    /// device, so taking it would leave the device nobody's.
    #[error("the other person's graph does not list this device")]
    NotListed,
    #[error(transparent)]
    Graph(#[from] GraphError),
}

/// The graph to store once `incoming` arrives, given what is `stored`
/// already and `own`, this device's key.
///
/// - Nothing stored: `incoming`.
/// - The same person: the union of both. Entries are never dropped, so a
///   stale copy cannot undo a revoke, whichever side it is on.
/// - Another person: `incoming`, which replaces the stored graph, if
///   `replace` asks for it or `own` is no longer valid in the stored graph
///   (a revoked device has lost that person already and may join another).
///   Either way `incoming` has to list `own` as valid. Otherwise
///   [`AdoptError::ForeignIdentity`].
///
/// Pure: whatever has to hold besides, e.g. that a grant lists this device,
/// or that replacing does not orphan a project, is the caller's to check.
pub fn adopt(
    stored: Option<&PersonGraph>,
    incoming: &PersonGraph,
    own: &PublicKey,
    replace: bool,
) -> Result<PersonGraph, AdoptError> {
    let Some(stored) = stored else {
        return Ok(incoming.clone());
    };
    if stored.id() == incoming.id() {
        let mut merged = stored.clone();
        merged.merge(incoming)?;
        return Ok(merged);
    }
    if !replace && stored.device_state(own) == DeviceState::Valid {
        return Err(AdoptError::ForeignIdentity {
            stored: stored.id(),
        });
    }
    if incoming.device_state(own) != DeviceState::Valid {
        return Err(AdoptError::NotListed);
    }
    Ok(incoming.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DeviceKey, EntryKind};

    fn add(graph: &mut PersonGraph, signer: &DeviceKey, device: &DeviceKey) {
        graph
            .append(
                signer,
                EntryKind::AddDevice {
                    device: device.public(),
                    flags: 0,
                },
            )
            .unwrap();
    }

    fn revoke(graph: &mut PersonGraph, signer: &DeviceKey, device: &DeviceKey) {
        graph
            .append(
                signer,
                EntryKind::RevokeDevice {
                    device: device.public(),
                },
            )
            .unwrap();
    }

    #[test]
    fn nothing_stored_takes_the_incoming_graph() {
        let own = DeviceKey::generate();
        let incoming = PersonGraph::genesis(&own);
        assert_eq!(adopt(None, &incoming, &own.public(), false), Ok(incoming));
    }

    #[test]
    fn the_same_person_merges_and_keeps_a_local_revoke() {
        let (own, other) = (DeviceKey::generate(), DeviceKey::generate());
        let mut base = PersonGraph::genesis(&own);
        add(&mut base, &own, &other);
        let mut stored = base.clone();
        revoke(&mut stored, &own, &other);
        let mut incoming = base;
        let third = DeviceKey::generate();
        add(&mut incoming, &own, &third);

        for replace in [false, true] {
            let out = adopt(Some(&stored), &incoming, &own.public(), replace).unwrap();
            assert!(out.is_superset_of(&stored) && out.is_superset_of(&incoming));
            assert_eq!(out.device_state(&other.public()), DeviceState::Revoked);
        }
    }

    #[test]
    fn another_person_needs_replace_while_this_device_is_valid() {
        let own = DeviceKey::generate();
        let stored = PersonGraph::genesis(&own);
        let holder = DeviceKey::generate();
        let mut incoming = PersonGraph::genesis(&holder);
        add(&mut incoming, &holder, &own);

        assert_eq!(
            adopt(Some(&stored), &incoming, &own.public(), false),
            Err(AdoptError::ForeignIdentity {
                stored: stored.id()
            })
        );
        assert_eq!(
            adopt(Some(&stored), &incoming, &own.public(), true),
            Ok(incoming)
        );
    }

    #[test]
    fn a_revoked_device_may_join_another_person() {
        let (own, other) = (DeviceKey::generate(), DeviceKey::generate());
        let mut stored = PersonGraph::genesis(&other);
        add(&mut stored, &other, &own);
        revoke(&mut stored, &other, &own);
        let holder = DeviceKey::generate();
        let mut incoming = PersonGraph::genesis(&holder);
        add(&mut incoming, &holder, &own);
        assert_eq!(
            adopt(Some(&stored), &incoming, &own.public(), false),
            Ok(incoming)
        );
    }

    #[test]
    fn another_persons_graph_must_list_this_device() {
        let own = DeviceKey::generate();
        let stored = PersonGraph::genesis(&own);
        let incoming = PersonGraph::genesis(&DeviceKey::generate());
        assert_eq!(
            adopt(Some(&stored), &incoming, &own.public(), true),
            Err(AdoptError::NotListed)
        );
    }
}
