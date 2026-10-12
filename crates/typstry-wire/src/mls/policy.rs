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
//! - a commit by an editor that removes members together with a rotation
//!   (policy generation plus one), only rotates, or only refreshes the
//!   editor's own leaf.
//!
//! Everything else is refused: adds (nobody is invited, everybody joins),
//! any commit from a viewer, and any other proposal.

use super::extensions::Policy;

/// What a leaf's extensions make its holder, judged against the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeafRole {
    Viewer,
    Editor,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeafFacts {
    /// The signature key of the leaf.
    pub signer: Vec<u8>,
    pub role: LeafRole,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removal {
    pub leaf: u32,
    pub signer: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct CommitFacts<'a> {
    pub sender: Sender,
    /// The sender's signature key before the commit, for members.
    pub sender_signer: Option<Vec<u8>>,
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
    #[error("a member's commit may not change its signature key or demote it")]
    LeafChanged,
    #[error("removing members requires rotating the keys")]
    RemovalWithoutRotation,
    #[error("a commit cannot remove its own sender")]
    SelfRemoval,
}

/// Whether `after` is `before` with one more generation: all earlier
/// attestation keys kept in order and a key not seen before.
pub fn is_rotation(before: &Policy, after: &Policy) -> bool {
    let n = before.attest_pubs.len();
    after.attest_pubs.len() == n + 1
        && after.attest_pubs[..n] == before.attest_pubs[..]
        && !before.attest_pubs.contains(&after.attest_pubs[n])
}

/// Checks a staged commit against the policy. `Ok(true)` means it rotates
/// the keys.
pub fn check(facts: &CommitFacts<'_>) -> Result<bool, Violation> {
    let after = facts.after.ok_or(Violation::PolicyMissing)?;
    let rotates = after != facts.before;
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
            // "Exactly the leaves with the joiner's key": none of anybody
            // else's, and all of its own, since openmls adds that Remove.
            if facts.removals.iter().any(|r| r.signer != leaf.signer)
                || facts.removals.len() != facts.same_key_leaves
            {
                return Err(Violation::ForeignRemoval);
            }
        }
        Sender::Member { leaf, role } => {
            if *role != LeafRole::Editor {
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
                    || new.role != LeafRole::Editor)
            {
                return Err(Violation::LeafChanged);
            }
        }
    }
    Ok(rotates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(n: u8) -> Policy {
        (2..=n).fold(Policy::new([1; 32]), |p, i| p.next([i; 32]))
    }

    fn editor() -> Sender {
        Sender::Member {
            leaf: 0,
            role: LeafRole::Editor,
        }
    }

    fn leaf(signer: u8, role: LeafRole) -> LeafFacts {
        LeafFacts {
            signer: vec![signer],
            role,
        }
    }

    fn facts<'a>(sender: Sender, before: &'a Policy, after: &'a Policy) -> CommitFacts<'a> {
        CommitFacts {
            sender,
            sender_signer: Some(vec![9]),
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

    #[test]
    fn removals_come_with_a_rotation() {
        let p = policy(1);
        let next = policy(2);
        let mut f = facts(editor(), &p, &next);
        f.removals = vec![removal(2, 7)];
        f.group_context_proposals = 1;
        f.path_leaf = Some(leaf(9, LeafRole::Editor));
        assert_eq!(check(&f), Ok(true));

        // A reset with nobody removed is the same commit.
        f.removals.clear();
        assert_eq!(check(&f), Ok(true));

        let mut f = facts(editor(), &p, &p);
        f.removals = vec![removal(2, 7)];
        assert_eq!(check(&f), Err(Violation::RemovalWithoutRotation));

        let mut f = facts(editor(), &p, &next);
        f.removals = vec![removal(0, 9)];
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::SelfRemoval));
    }

    #[test]
    fn rotations_must_be_exactly_one_generation() {
        let p = policy(2);
        let mut f = facts(editor(), &p, &p);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::EmptyPolicyChange));

        let skip = policy(4);
        let mut f = facts(editor(), &p, &skip);
        f.group_context_proposals = 1;
        assert_eq!(check(&f), Err(Violation::BadPolicyChange));

        // Dropping or swapping an earlier key would orphan its history.
        let mut swapped = policy(3);
        swapped.attest_pubs[0] = [9; 32];
        assert!(!is_rotation(&p, &swapped));
        let mut reused = p.next(p.attest_pubs[0]);
        assert!(!is_rotation(&p, &reused));
        reused.attest_pubs[2] = [8; 32];
        assert!(is_rotation(&p, &reused));

        let mut f = facts(editor(), &p, &p);
        f.after = None;
        assert_eq!(check(&f), Err(Violation::PolicyMissing));
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
