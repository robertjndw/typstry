//! Which commits a typstry group accepts.
//!
//! The delivery service orders commits but cannot read them, so every
//! member decides for itself, and the decision has to be the same for all of
//! them or the group forks. That is why this is a pure function of facts
//! read from the staged commit and the group before it, and why a refused
//! commit is not skipped: the server already made it the winner of its
//! epoch, so everyone stalls at the same point, and an editor recovers with
//! a group reset instead of the members disagreeing about the roster.
//!
//! What is allowed:
//! - an external commit, to join or to resync. It may remove only the
//!   leaves that hold the joiner's own signature key, which is what openmls
//!   adds on its own to replace a device's earlier leaf.
//! - a commit by the owner that removes members together with a rotation
//!   (policy generation plus one, same owner tag), or only rotates. Nobody
//!   else can remove anyone or rotate, which also means an owner cannot be
//!   removed by anyone but an owner. The one exception is an editor that
//!   removes leaves of its own person with a rotation, when each of them is
//!   a device that person's merged graph shows as revoked and the editor's
//!   own device is still valid in it.
//! - a commit by an editor or owner that only refreshes its own leaf. Its
//!   leaf keeps the device and person its identity names and may only extend
//!   the person graph, and the graph has to merge with what the tree's other
//!   leaves of that person carry (see [`Violation::GraphConflict`]). Owner
//!   is not something a leaf claims, it follows from the identity, so a
//!   refresh can change an editor into an owner and back.
//!
//! Everything else is refused: adds (nobody is invited, everybody joins),
//! any commit from a viewer, and any other proposal.

use super::extensions::Policy;
use crate::identity::{LeafIdentity, PersonId};

/// What a leaf's extensions make its holder, judged against the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeafRole {
    Viewer,
    Editor,
    /// An editor that is a valid device of the owner's person.
    Owner,
    /// Claims to be an editor but the attestation does not hold up. Never
    /// treated as a viewer, or a forged leaf would look harmless.
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sender {
    /// A current member, with the role its leaf had before the commit.
    Member { leaf: u32, role: LeafRole },
    /// Someone joining with an external commit.
    External,
}

/// A leaf's identity extension: the sealed bytes, and what they open to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityFacts {
    pub sealed: Vec<u8>,
    /// `None` when it does not open or decode. The identity key comes from
    /// generation 1, so every member opens the same leaves, however far its
    /// keyring lags.
    pub open: Option<LeafIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafFacts {
    /// The signature key of the leaf.
    pub signer: Vec<u8>,
    pub role: LeafRole,
    pub identity: Option<IdentityFacts>,
    /// Whether the leaf's person graph merges with the other graphs of that
    /// person in the tree. `true` for a leaf without an identity that opens.
    pub mergeable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub leaf: u32,
    pub signer: Vec<u8>,
    /// The person whose revoked device the leaf is, in the merged graphs
    /// with the commit's new leaf: `None` when it is no verified device or
    /// not revoked.
    pub revoked_person: Option<PersonId>,
}

#[derive(Debug, Clone)]
pub struct CommitFacts<'a> {
    pub sender: Sender,
    /// The sender's signature key before the commit, for members.
    pub sender_signer: Option<Vec<u8>>,
    /// The sender's identity before the commit, for members.
    pub sender_identity: Option<IdentityFacts>,
    /// The person the sender is a valid, not revoked device of, in the
    /// merged graphs with the commit's new leaf. The new leaf is included so
    /// that a commit may carry the revoke that justifies its removals.
    pub sender_person: Option<PersonId>,
    pub before: &'a Policy,
    /// The policy in the commit's GroupContext, `None` when it is missing or
    /// unreadable.
    pub after: Option<&'a Policy>,
    pub adds: usize,
    pub updates: usize,
    pub group_context_proposals: usize,
    /// Proposals that are none of the above, apart from the ExternalInit an
    /// external commit carries by definition.
    pub other_proposals: usize,
    pub removals: Vec<Removal>,
    /// How many leaves already hold the joiner's signature key.
    pub same_key_leaves: usize,
    /// The sender's new leaf from the commit's path.
    pub path_leaf: Option<LeafFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Violation {
    /// The commit's content could not be read into facts at all.
    #[error("{0}")]
    Unreadable(String),
    #[error("the commit has no readable policy")]
    PolicyMissing,
    #[error("the commit changes the policy in a way that is not a rotation")]
    BadPolicyChange,
    #[error("the commit proposes a group context change that changes nothing")]
    EmptyPolicyChange,
    #[error("the commit adds members")]
    Adds,
    #[error("the commit carries proposals typstry does not use")]
    OtherProposals,
    #[error("the commit has no new leaf")]
    NoPathLeaf,
    #[error("the new leaf claims to be an editor without proof")]
    InvalidLeaf,
    #[error("a joiner may only remove its own earlier leaves")]
    ForeignRemoval,
    #[error("a viewer cannot commit")]
    ViewerCommit,
    #[error("only the owner can remove members or rotate the keys")]
    NotOwner,
    #[error("the new leaf's person graph does not merge with the others of that person")]
    GraphConflict,
    #[error("a member's commit may not change its signature key or demote it")]
    LeafChanged,
    #[error("a member cannot change its device or person, or drop devices from its graph")]
    IdentityChanged,
    #[error("removing members requires rotating the keys")]
    RemovalWithoutRotation,
    #[error("a commit cannot remove its own sender")]
    SelfRemoval,
}

/// Whether `after` is `before` with one more generation: all earlier
/// attestation keys kept in order, a key not seen before, and the same owner.
pub fn is_rotation(before: &Policy, after: &Policy) -> bool {
    let n = before.attest_pubs.len();
    after.attest_pubs.len() == n + 1
        && after.attest_pubs[..n] == before.attest_pubs[..]
        && !before.attest_pubs.contains(&after.attest_pubs[n])
        && after.owner_tag == before.owner_tag
}

/// Whether a member's own leaf may go from `old` to `new`: unchanged, or the
/// same device of the same person with a graph that only grew. Judged on
/// graphs rather than on validity, so no member needs a view of the
/// others' leaves for it.
fn identity_kept(old: Option<&IdentityFacts>, new: Option<&IdentityFacts>) -> bool {
    match (old, new) {
        (None, None) => true,
        (Some(old), Some(new)) if old.sealed == new.sealed => true,
        (Some(old), Some(new)) => match (&old.open, &new.open) {
            (Some(old), Some(new)) => {
                old.binding.device == new.binding.device
                    && old.graph.id() == new.graph.id()
                    && new.graph.is_superset_of(&old.graph)
            }
            _ => false,
        },
        _ => false,
    }
}

/// The editor exception: a rotation that removes leaves, every one of which
/// is a revoked device of the sender's own person, while the sender's device
/// is itself still valid. Nothing is removed that the person has not
/// disowned, and a commit that only rotates stays the owner's.
fn removes_only_own_revoked(facts: &CommitFacts<'_>) -> bool {
    let Some(person) = facts.sender_person else {
        return false;
    };
    facts
        .after
        .is_some_and(|after| is_rotation(facts.before, after))
        && !facts.removals.is_empty()
        && facts
            .removals
            .iter()
            .all(|r| r.revoked_person == Some(person))
}

/// Checks a staged commit against the policy. `Ok(true)` means it rotates
/// the keys.
pub fn check(facts: &CommitFacts<'_>) -> Result<bool, Violation> {
    let after = facts.after.ok_or(Violation::PolicyMissing)?;
    let rotates = after != facts.before;
    // Judged before the policy change itself: an editor that rotates is
    // refused for what it is, whatever it put in the new policy.
    if let Sender::Member {
        role: LeafRole::Editor,
        ..
    } = &facts.sender
        && (rotates || !facts.removals.is_empty())
        && !removes_only_own_revoked(facts)
    {
        return Err(Violation::NotOwner);
    }
    if rotates && !is_rotation(facts.before, after) {
        return Err(Violation::BadPolicyChange);
    }
    if facts.group_context_proposals > 0 && !rotates {
        return Err(Violation::EmptyPolicyChange);
    }
    if facts.adds > 0 {
        return Err(Violation::Adds);
    }
    if facts.other_proposals > 0 || facts.updates > 0 {
        return Err(Violation::OtherProposals);
    }
    match &facts.sender {
        Sender::External => {
            if rotates {
                return Err(Violation::BadPolicyChange);
            }
            let leaf = facts.path_leaf.as_ref().ok_or(Violation::NoPathLeaf)?;
            if leaf.role == LeafRole::Invalid {
                return Err(Violation::InvalidLeaf);
            }
            if !leaf.mergeable {
                return Err(Violation::GraphConflict);
            }
            // "Exactly the leaves with the joiner's key": none of anybody
            // else's, and all of its own, since openmls adds that Remove.
            if facts.removals.iter().any(|r| r.signer != leaf.signer)
                || facts.removals.len() != facts.same_key_leaves
            {
                return Err(Violation::ForeignRemoval);
            }
        }
        Sender::Member { leaf, role } => {
            if !matches!(role, LeafRole::Editor | LeafRole::Owner) {
                return Err(Violation::ViewerCommit);
            }
            if facts.removals.iter().any(|r| r.leaf == *leaf) {
                return Err(Violation::SelfRemoval);
            }
            if !facts.removals.is_empty() && !rotates {
                return Err(Violation::RemovalWithoutRotation);
            }
            if let Some(new) = &facts.path_leaf
                && (Some(&new.signer) != facts.sender_signer.as_ref()
                    || !matches!(new.role, LeafRole::Editor | LeafRole::Owner))
            {
                return Err(Violation::LeafChanged);
            }
            if let Some(new) = &facts.path_leaf
                && !identity_kept(facts.sender_identity.as_ref(), new.identity.as_ref())
            {
                return Err(Violation::IdentityChanged);
            }
            if facts.path_leaf.as_ref().is_some_and(|new| !new.mergeable) {
                return Err(Violation::GraphConflict);
            }
        }
    }
    Ok(rotates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{DeviceKey, EntryKind, LeafBinding, PersonGraph};

    /// `n` generations of one owner.
    fn policy(n: u8) -> Policy {
        (2..=n).fold(Policy::new([1; 32], [9; 32]), |p, i| p.next([i; 32]))
    }

    fn editor() -> Sender {
        Sender::Member {
            leaf: 0,
            role: LeafRole::Editor,
        }
    }

    fn owner() -> Sender {
        Sender::Member {
            leaf: 0,
            role: LeafRole::Owner,
        }
    }

    fn leaf(signer: u8, role: LeafRole) -> LeafFacts {
        LeafFacts {
            signer: vec![signer],
            role,
            identity: None,
            mergeable: true,
        }
    }

    fn facts<'a>(sender: Sender, before: &'a Policy, after: &'a Policy) -> CommitFacts<'a> {
        CommitFacts {
            sender,
            sender_signer: Some(vec![9]),
            sender_identity: None,
            sender_person: None,
            before,
            after: Some(after),
            adds: 0,
            updates: 0,
            group_context_proposals: 0,
            other_proposals: 0,
            removals: Vec::new(),
            same_key_leaves: 0,
            path_leaf: None,
        }
    }

    fn removal(leaf: u32, signer: u8) -> Removal {
        Removal {
            leaf,
            signer: vec![signer],
            revoked_person: None,
        }
    }

    #[test]
    fn external_joins_and_resyncs_pass() {
        let p = policy(1);
        let mut f = facts(Sender::External, &p, &p);
        f.path_leaf = Some(leaf(5, LeafRole::Viewer));
        assert_eq!(check(&f), Ok(false));
        f.path_leaf = Some(leaf(5, LeafRole::Editor));
        assert_eq!(check(&f), Ok(false));
        // A paired owner device joins as the owner.
        f.path_leaf = Some(leaf(5, LeafRole::Owner));
        assert_eq!(check(&f), Ok(false));

        // Resync: the Remove of the joiner's earlier leaf.
        f.removals = vec![removal(3, 5)];
        f.same_key_leaves = 1;
        assert_eq!(check(&f), Ok(false));
    }

    #[test]
    fn external_commits_cannot_remove_anyone_else() {
        let p = policy(1);
        let mut f = facts(Sender::External, &p, &p);
        f.path_leaf = Some(leaf(5, LeafRole::Editor));
        f.removals = vec![removal(3, 6)];
        f.same_key_leaves = 0;
        assert_eq!(check(&f), Err(Violation::ForeignRemoval));
        // Own leaf plus somebody else's.
        f.removals = vec![removal(3, 5), removal(4, 6)];
        f.same_key_leaves = 1;
        assert_eq!(check(&f), Err(Violation::ForeignRemoval));
        // A joiner whose key is already in the tree must replace it, not
        // sit next to it.
        f.removals = Vec::new();
        assert_eq!(check(&f), Err(Violation::ForeignRemoval));
    }

    #[test]
    fn external_commits_cannot_change_the_group() {
        let p = policy(1);
        let mut f = facts(Sender::External, &p, &p);
        f.path_leaf = Some(leaf(5, LeafRole::Editor));
        f.adds = 1;
        assert_eq!(check(&f), Err(Violation::Adds));

        let mut f = facts(Sender::External, &p, &p);
        f.path_leaf = Some(leaf(5, LeafRole::Editor));
        f.other_proposals = 1;
        assert_eq!(check(&f), Err(Violation::OtherProposals));

        let mut f = facts(Sender::External, &p, &p);
        f.path_leaf = Some(leaf(5, LeafRole::Invalid));
        assert_eq!(check(&f), Err(Violation::InvalidLeaf));

        let mut f = facts(Sender::External, &p, &p);
        assert_eq!(check(&f), Err(Violation::NoPathLeaf));

        // Rotating the keys is for editors who hold the edit link.
        let next = policy(2);
        f = facts(Sender::External, &p, &next);
        f.path_leaf = Some(leaf(5, LeafRole::Editor));
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::BadPolicyChange));
    }

    #[test]
    fn viewers_cannot_commit() {
        let p = policy(1);
        let viewer = Sender::Member {
            leaf: 1,
            role: LeafRole::Viewer,
        };
        let mut f = facts(viewer, &p, &p);
        f.path_leaf = Some(leaf(9, LeafRole::Viewer));
        assert_eq!(check(&f), Err(Violation::ViewerCommit));
        let invalid = Sender::Member {
            leaf: 1,
            role: LeafRole::Invalid,
        };
        assert_eq!(check(&facts(invalid, &p, &p)), Err(Violation::ViewerCommit));
    }

    #[test]
    fn editors_refresh_their_own_leaf() {
        let p = policy(1);
        let mut f = facts(editor(), &p, &p);
        f.path_leaf = Some(leaf(9, LeafRole::Editor));
        assert_eq!(check(&f), Ok(false));

        // A new signature key, or giving up editor rights, is not a refresh.
        f.path_leaf = Some(leaf(8, LeafRole::Editor));
        assert_eq!(check(&f), Err(Violation::LeafChanged));
        f.path_leaf = Some(leaf(9, LeafRole::Viewer));
        assert_eq!(check(&f), Err(Violation::LeafChanged));
    }

    fn identity(device: &DeviceKey, graph: &PersonGraph, leaf: u8, salt: u8) -> IdentityFacts {
        IdentityFacts {
            sealed: vec![salt],
            open: Some(LeafIdentity {
                binding: LeafBinding::new(device, &[leaf; 32]),
                graph: graph.clone(),
            }),
        }
    }

    #[test]
    fn a_leaf_keeps_its_identity() {
        let p = policy(1);
        let device = DeviceKey::generate();
        let graph = PersonGraph::genesis(&device);
        let mut f = facts(editor(), &p, &p);
        f.sender_identity = Some(identity(&device, &graph, 9, 1));
        let mut same = leaf(9, LeafRole::Editor);
        same.identity = f.sender_identity.clone();
        f.path_leaf = Some(same);
        assert_eq!(check(&f), Ok(false));

        // Even bytes this member cannot open pass if they did not change.
        let blind = IdentityFacts {
            sealed: vec![7],
            open: None,
        };
        f.sender_identity = Some(blind.clone());
        f.path_leaf.as_mut().unwrap().identity = Some(blind);
        assert_eq!(check(&f), Ok(false));

        // Dropping the identity, gaining one later or swapping the person
        // all rebind the leaf.
        let other = DeviceKey::generate();
        let other_graph = PersonGraph::genesis(&other);
        f.sender_identity = Some(identity(&device, &graph, 9, 1));
        for changed in [None, Some(identity(&other, &other_graph, 9, 2))] {
            f.path_leaf.as_mut().unwrap().identity = changed;
            assert_eq!(check(&f), Err(Violation::IdentityChanged));
        }
        f.sender_identity = None;
        f.path_leaf.as_mut().unwrap().identity = Some(identity(&device, &graph, 9, 1));
        assert_eq!(check(&f), Err(Violation::IdentityChanged));
    }

    #[test]
    fn a_leaf_may_only_extend_its_graph() {
        let p = policy(1);
        let device = DeviceKey::generate();
        let second = DeviceKey::generate();
        let small = PersonGraph::genesis(&device);
        let mut big = small.clone();
        big.append(
            &device,
            EntryKind::AddDevice {
                device: second.public(),
                flags: 0,
            },
        )
        .unwrap();

        let run = |old: IdentityFacts, new: IdentityFacts| {
            let mut f = facts(editor(), &p, &p);
            f.sender_identity = Some(old);
            let mut path = leaf(9, LeafRole::Editor);
            path.identity = Some(new);
            f.path_leaf = Some(path);
            check(&f)
        };
        // Growing is fine, with a fresh seal.
        assert_eq!(
            run(
                identity(&device, &small, 9, 1),
                identity(&device, &big, 9, 2)
            ),
            Ok(false)
        );
        // Rolling back is not.
        assert_eq!(
            run(
                identity(&device, &big, 9, 1),
                identity(&device, &small, 9, 2)
            ),
            Err(Violation::IdentityChanged)
        );
        // Neither is another device of the same person.
        assert_eq!(
            run(identity(&device, &big, 9, 1), identity(&second, &big, 9, 2)),
            Err(Violation::IdentityChanged)
        );
        // Nor an identity this member cannot read.
        let blind = IdentityFacts {
            sealed: vec![3],
            open: None,
        };
        assert_eq!(
            run(identity(&device, &small, 9, 1), blind),
            Err(Violation::IdentityChanged)
        );
    }

    #[test]
    fn rejoining_may_carry_a_new_identity() {
        let p = policy(1);
        let mut f = facts(Sender::External, &p, &p);
        let mut fresh = leaf(5, LeafRole::Editor);
        fresh.identity = Some(IdentityFacts {
            sealed: vec![3],
            open: None,
        });
        f.path_leaf = Some(fresh);
        assert_eq!(check(&f), Ok(false));
    }

    #[test]
    fn removals_come_with_a_rotation() {
        let p = policy(1);
        let next = policy(2);
        let mut f = facts(owner(), &p, &next);
        f.removals = vec![removal(2, 7)];
        f.group_context_proposals = 1;
        f.path_leaf = Some(leaf(9, LeafRole::Owner));
        assert_eq!(check(&f), Ok(true));

        // A link reset with nobody removed is the same commit.
        f.removals.clear();
        assert_eq!(check(&f), Ok(true));

        let mut f = facts(owner(), &p, &p);
        f.removals = vec![removal(2, 7)];
        assert_eq!(check(&f), Err(Violation::RemovalWithoutRotation));

        let mut f = facts(owner(), &p, &next);
        f.removals = vec![removal(0, 9)];
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::SelfRemoval));
    }

    #[test]
    fn only_the_owner_removes_or_rotates() {
        let p = policy(1);
        let next = policy(2);
        // An editor loses on both counts, whatever the policy it presents.
        let mut f = facts(editor(), &p, &next);
        f.removals = vec![removal(2, 7)];
        f.group_context_proposals = 1;
        f.path_leaf = Some(leaf(9, LeafRole::Editor));
        assert_eq!(check(&f), Err(Violation::NotOwner));
        f.removals.clear();
        assert_eq!(check(&f), Err(Violation::NotOwner));

        let mut f = facts(editor(), &p, &p);
        f.removals = vec![removal(2, 7)];
        assert_eq!(check(&f), Err(Violation::NotOwner));
    }

    #[test]
    fn owners_and_editors_refresh_their_own_leaf() {
        let p = policy(1);
        let mut f = facts(owner(), &p, &p);
        f.path_leaf = Some(leaf(9, LeafRole::Owner));
        assert_eq!(check(&f), Ok(false));
        f.path_leaf = Some(leaf(9, LeafRole::Editor));
        assert_eq!(check(&f), Ok(false));
        f.path_leaf = Some(leaf(9, LeafRole::Invalid));
        assert_eq!(check(&f), Err(Violation::LeafChanged));

        // An editor whose device the owner's person has just paired is an
        // owner from its leaf on.
        let mut f = facts(editor(), &p, &p);
        f.path_leaf = Some(leaf(9, LeafRole::Owner));
        assert_eq!(check(&f), Ok(false));
        f.path_leaf = Some(leaf(9, LeafRole::Invalid));
        assert_eq!(check(&f), Err(Violation::LeafChanged));
        f.path_leaf = Some(leaf(8, LeafRole::Owner));
        assert_eq!(check(&f), Err(Violation::LeafChanged));

        let viewer = Sender::Member {
            leaf: 1,
            role: LeafRole::Viewer,
        };
        let mut f = facts(viewer, &p, &p);
        f.path_leaf = Some(leaf(9, LeafRole::Owner));
        assert_eq!(check(&f), Err(Violation::ViewerCommit));
    }

    #[test]
    fn rotations_must_be_exactly_one_generation() {
        let p = policy(2);
        let mut f = facts(owner(), &p, &p);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::EmptyPolicyChange));

        let skip = policy(4);
        let mut f = facts(owner(), &p, &skip);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::BadPolicyChange));

        // Dropping or swapping an earlier key would orphan its history.
        let mut swapped = policy(3);
        swapped.attest_pubs[0] = [9; 32];
        assert!(!is_rotation(&p, &swapped));
        let reused = p.next(p.attest_pubs[0]);
        assert!(!is_rotation(&p, &reused));

        let mut f = facts(owner(), &p, &p);
        f.after = None;
        assert_eq!(check(&f), Err(Violation::PolicyMissing));
    }

    #[test]
    fn rotations_keep_the_owner_tag() {
        let p = policy(2);
        let next = policy(3);
        assert!(is_rotation(&p, &next));

        let mut taken = next.clone();
        taken.owner_tag = [8; 32];
        assert!(!is_rotation(&p, &taken));
        let mut f = facts(owner(), &p, &taken);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::BadPolicyChange));
        // Not even for a tag change alone.
        let retagged = Policy {
            owner_tag: [8; 32],
            ..p.clone()
        };
        let mut f = facts(owner(), &p, &retagged);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::BadPolicyChange));
    }

    /// An editor that revokes and removes its own device.
    fn own_revocation(p: &Policy, next: &Policy) -> CommitFacts<'static> {
        // The facts borrow their policies, so leak the two for the test.
        let (p, next) = (
            Box::leak(Box::new(p.clone())),
            Box::leak(Box::new(next.clone())),
        );
        let mut f = facts(editor(), p, next);
        f.sender_person = Some([4; 32]);
        f.removals = vec![Removal {
            revoked_person: Some([4; 32]),
            ..removal(2, 7)
        }];
        f.group_context_proposals = 1;
        f.path_leaf = Some(leaf(9, LeafRole::Editor));
        f
    }

    #[test]
    fn an_editor_removes_its_own_revoked_devices_with_a_rotation() {
        let (p, next) = (policy(1), policy(2));
        let f = own_revocation(&p, &next);
        assert_eq!(check(&f), Ok(true));

        let mut two = own_revocation(&p, &next);
        two.removals.push(Removal {
            revoked_person: Some([4; 32]),
            ..removal(3, 8)
        });
        assert_eq!(check(&two), Ok(true));

        // One leaf that is not revoked, or is another person's, spoils it.
        for other in [None, Some([5; 32])] {
            let mut f = own_revocation(&p, &next);
            f.removals.push(Removal {
                revoked_person: other,
                ..removal(3, 8)
            });
            assert_eq!(check(&f), Err(Violation::NotOwner));
        }
        let mut f = own_revocation(&p, &next);
        f.removals[0].revoked_person = None;
        assert_eq!(check(&f), Err(Violation::NotOwner));

        // The sender has to be a valid device itself.
        let mut f = own_revocation(&p, &next);
        f.sender_person = None;
        assert_eq!(check(&f), Err(Violation::NotOwner));
        let mut f = own_revocation(&p, &next);
        f.sender_person = Some([5; 32]);
        assert_eq!(check(&f), Err(Violation::NotOwner));

        // No rotation, or a rotation that is none, or nothing removed.
        let mut f = own_revocation(&p, &p);
        f.group_context_proposals = 0;
        assert_eq!(check(&f), Err(Violation::NotOwner));
        let bad = Policy {
            owner_tag: [1; 32],
            ..next.clone()
        };
        let f = own_revocation(&p, &bad);
        assert_eq!(check(&f), Err(Violation::NotOwner));
        let mut f = own_revocation(&p, &next);
        f.removals.clear();
        assert_eq!(check(&f), Err(Violation::NotOwner));
    }

    #[test]
    fn a_new_leaf_whose_graph_does_not_merge_is_refused() {
        let p = policy(1);
        let mut f = facts(editor(), &p, &p);
        let mut path = leaf(9, LeafRole::Editor);
        path.mergeable = false;
        f.path_leaf = Some(path.clone());
        assert_eq!(check(&f), Err(Violation::GraphConflict));
        let mut f = facts(Sender::External, &p, &p);
        path.signer = vec![5];
        f.path_leaf = Some(path);
        assert_eq!(check(&f), Err(Violation::GraphConflict));
    }

    #[test]
    fn nobody_adds_or_updates() {
        let p = policy(1);
        let mut f = facts(editor(), &p, &p);
        f.adds = 1;
        assert_eq!(check(&f), Err(Violation::Adds));
        let mut f = facts(editor(), &p, &p);
        f.updates = 1;
        assert_eq!(check(&f), Err(Violation::OtherProposals));
        let mut f = facts(editor(), &p, &p);
        f.other_proposals = 1;
        assert_eq!(check(&f), Err(Violation::OtherProposals));
    }
}
