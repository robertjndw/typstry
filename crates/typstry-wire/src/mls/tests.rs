//! Several clients against a tiny in-memory delivery service: the first
//! commit per epoch wins, everything else is stored as opaque bytes.

use super::*;
use crate::crypto::{Attestation, RecordSigner, SIGNATURE_LEN};

struct Ds {
    log: Vec<(u64, Vec<u8>, Option<Vec<u8>>)>,
    group_id: Vec<u8>,
    group_info: Vec<u8>,
    keyring: Vec<u8>,
    edit_token: Option<String>,
    view_token: Option<String>,
    retired: Vec<String>,
}

impl Ds {
    fn init(payload: InitPayload) -> Self {
        Self {
            log: Vec::new(),
            group_id: payload.group_id,
            group_info: payload.group_info,
            keyring: payload.keyring,
            edit_token: None,
            view_token: None,
            retired: Vec::new(),
        }
    }

    fn head(&self) -> u64 {
        self.log.len() as u64
    }

    /// `Err(head)` is a Conflict.
    fn submit(&mut self, payload: SubmitPayload) -> Result<(), u64> {
        if payload.epoch != self.head() {
            return Err(self.head());
        }
        self.log
            .push((payload.epoch, payload.commit, payload.envelope));
        self.group_info = payload.group_info;
        if let Some(keyring) = payload.keyring {
            self.keyring = keyring;
        }
        if let Some(rotate) = payload.rotate {
            self.retired
                .extend(self.edit_token.replace(rotate.edit_token));
            self.retired
                .extend(self.view_token.replace(rotate.view_token));
        }
        Ok(())
    }
}

struct Client {
    name: &'static str,
    g: ProjectGroup,
}

impl Client {
    /// Applies everything new in the log. Stops at the first commit that is
    /// not merged.
    fn sync(&mut self, ds: &Ds) -> Vec<Outcome> {
        let mut outcomes = Vec::new();
        while self.g.is_active() {
            let Some((epoch, commit, envelope)) = ds.log.get(self.g.epoch() as usize) else {
                break;
            };
            let outcome = self
                .g
                .process_commit(*epoch, commit, envelope.as_deref())
                .unwrap();
            let stop = matches!(outcome, Outcome::Invalid(_) | Outcome::Removed);
            outcomes.push(outcome);
            if stop {
                break;
            }
        }
        if self.g.is_active() && self.g.needs_keyring() {
            self.g.set_keyring(&ds.keyring).unwrap();
        }
        outcomes
    }

    fn roster(&self) -> Vec<(String, Role, bool)> {
        let mut roster: Vec<_> = self
            .g
            .members()
            .unwrap()
            .into_iter()
            .map(|m| {
                let name = String::from_utf8(m.profile.expect("readable profile")).unwrap();
                (name, m.role, m.is_self)
            })
            .collect();
        roster.sort_by(|a, b| a.0.cmp(&b.0));
        roster
    }

    fn leaf_of(&self, name: &str) -> u32 {
        self.g
            .members()
            .unwrap()
            .into_iter()
            .find(|m| m.profile.as_deref() == Some(name.as_bytes()))
            .unwrap()
            .leaf
    }
}

fn join(ds: &mut Ds, link: &LinkSecret, name: &'static str) -> Client {
    let (mut g, payload) =
        ProjectGroup::join_external(link, &ds.group_info, &ds.keyring, name.as_bytes()).unwrap();
    ds.submit(payload).expect("accepted");
    g.confirm_pending().unwrap();
    Client { name, g }
}

/// Alice alone, as the creator of a project.
fn project() -> (Ds, Client, LinkSecret) {
    let link = LinkSecret::generate_edit();
    let (g, payload) = ProjectGroup::create(&link, b"alice").unwrap();
    (Ds::init(payload), Client { name: "alice", g }, link)
}

fn view_of(link: &LinkSecret) -> LinkSecret {
    LinkSecret::from_base64url(&link.view_secret()).unwrap()
}

/// Alice and bob edit, carol and dave only view; everyone is caught up.
fn team() -> (Ds, [Client; 4], LinkSecret) {
    let (mut ds, mut alice, link) = project();
    let mut bob = join(&mut ds, &link, "bob");
    let mut carol = join(&mut ds, &view_of(&link), "carol");
    let mut dave = join(&mut ds, &view_of(&link), "dave");
    for client in [&mut alice, &mut bob, &mut carol] {
        client.sync(&ds);
    }
    dave.sync(&ds);
    (ds, [alice, bob, carol, dave], link)
}

#[test]
fn joins_build_one_roster() {
    let (ds, [alice, bob, carol, dave], _) = team();
    assert_eq!(ds.head(), 3);
    for client in [&alice, &bob, &carol, &dave] {
        assert_eq!(client.g.epoch(), 3, "{}", client.name);
        assert_eq!(client.g.group_id(), ds.group_id);
        let roster = client.roster();
        let names: Vec<_> = roster.iter().map(|(n, ..)| n.as_str()).collect();
        assert_eq!(names, ["alice", "bob", "carol", "dave"]);
        let roles: Vec<_> = roster.iter().map(|(_, r, _)| *r).collect();
        assert_eq!(
            roles,
            [Role::Editor, Role::Editor, Role::Viewer, Role::Viewer]
        );
        let own: Vec<_> = roster.iter().filter(|(_, _, me)| *me).collect();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].0, client.name);
    }
    // Members are told apart by their device key, and it is the key their
    // records verify under.
    let key = alice.g.doc_keys();
    let record = key
        .encrypt_delta(&alice.g.signer(), 1, 0, 2, b"ops")
        .unwrap();
    let out = dave.g.doc_keys().decrypt_record(&record).unwrap();
    let alice_sig = alice
        .g
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.is_self)
        .unwrap()
        .sig_pub;
    assert_eq!(out.signer_pub, alice_sig);
    assert_eq!(
        dave.g
            .members()
            .unwrap()
            .iter()
            .filter(|m| m.sig_pub == alice_sig)
            .count(),
        1
    );
}

#[test]
fn presence_follows_the_epoch() {
    let (mut ds, [mut alice, mut bob, mut carol, mut dave], _) = team();
    let key = alice.g.presence_key().unwrap();
    let sealed = key.seal(&alice.g.signer(), alice.g.own_leaf(), b"cursor");
    for client in [&bob, &carol, &dave] {
        let (leaf, plain) = client
            .g
            .presence_key()
            .unwrap()
            .open(&sealed, |leaf| client.g.signer_of(leaf))
            .unwrap();
        assert_eq!(leaf, alice.g.own_leaf());
        assert_eq!(plain, b"cursor");
    }

    // A self-update starts a new epoch with a new key.
    let payload = alice.g.self_update(b"alice").unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    for client in [&mut bob, &mut carol, &mut dave] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    let next = bob.g.presence_key().unwrap();
    assert_eq!(next.epoch(), key.epoch() + 1);
    assert!(matches!(
        next.open(&sealed, |leaf| bob.g.signer_of(leaf)),
        Err(CryptoError::WrongEpoch(e)) if e == key.epoch()
    ));
    let fresh =
        alice
            .g
            .presence_key()
            .unwrap()
            .seal(&alice.g.signer(), alice.g.own_leaf(), b"moved");
    assert_eq!(
        next.open(&fresh, |leaf| bob.g.signer_of(leaf)).unwrap().1,
        b"moved"
    );
}

#[test]
fn concurrent_joins_conflict_and_retry() {
    let (mut ds, mut alice, link) = project();
    let (mut bob, bob_join) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"bob").unwrap();
    let (mut carol, carol_join) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"carol").unwrap();

    ds.submit(bob_join).unwrap();
    bob.confirm_pending().unwrap();
    let head = ds.submit(carol_join).unwrap_err();
    assert_eq!(head, 1);
    carol.discard_pending().unwrap();
    assert!(!carol.is_active());
    assert!(matches!(
        carol.process_commit(0, &ds.log[0].1, None),
        Err(MlsError::NotActive)
    ));

    // Carol starts over from the new GroupInfo.
    let mut carol = join(&mut ds, &link, "carol");
    let mut bob = Client {
        name: "bob",
        g: bob,
    };
    for client in [&mut alice, &mut bob, &mut carol] {
        client.sync(&ds);
        assert_eq!(client.g.epoch(), 2);
        assert_eq!(client.roster().len(), 3);
    }
}

#[test]
fn concurrent_member_commits_conflict_and_the_loser_catches_up() {
    let (mut ds, [mut alice, mut bob, ..]) = {
        let (ds, clients, _) = team();
        (ds, clients)
    };
    let a = alice.g.self_update(b"alice").unwrap();
    let b = bob.g.self_update(b"bob").unwrap();
    ds.submit(a).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(ds.submit(b).is_err());

    // Bob sees the winner arrive before he heard about the conflict: his
    // own commit is dropped and the winner applied.
    assert!(bob.g.has_pending());
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert!(!bob.g.has_pending());
    assert_eq!(bob.g.epoch(), alice.g.epoch());

    let b = bob.g.self_update(b"bob").unwrap();
    ds.submit(b).unwrap();
    bob.g.confirm_pending().unwrap();
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(alice.g.epoch(), bob.g.epoch());
    assert!(matches!(
        alice.g.confirm_pending(),
        Err(MlsError::NoPending)
    ));
}

#[test]
fn removing_a_viewer_rotates_the_links() {
    let (mut ds, [mut alice, mut bob, mut carol, mut dave], old) = team();
    let old_epoch = alice.g.epoch();
    let old_presence = alice.g.presence_key().unwrap();
    let sealed = old_presence.seal(&alice.g.signer(), alice.g.own_leaf(), b"cursor");
    let record = alice
        .g
        .doc_keys()
        .encrypt_delta(&alice.g.signer(), 1, 0, 2, b"gen 1")
        .unwrap();

    let dave_leaf = alice.leaf_of("dave");
    let payload = alice.g.remove_and_rotate(&[dave_leaf]).unwrap();
    assert!(payload.envelope.is_some() && payload.keyring.is_some());
    let rotate = payload.rotate.clone().unwrap();
    for token in [&rotate.edit_token, &rotate.view_token] {
        assert_eq!(token.len(), 22);
        assert!(token.bytes().all(|b| b.is_ascii_alphanumeric()));
    }
    ds.submit(payload).unwrap();
    // Nothing changes for the committer until the server accepts.
    assert_eq!(alice.g.epoch(), old_epoch);
    assert_eq!(alice.g.link().to_base64url(), old.to_base64url());
    alice.g.confirm_pending().unwrap();
    let new_link = alice.g.link().clone();
    assert_ne!(new_link.fingerprint(), old.fingerprint());
    assert_eq!(alice.g.generation().unwrap(), 2);
    assert_eq!(alice.g.doc_keys().generation(), 2);
    assert_eq!(alice.g.epoch(), old_epoch + 1);

    // The remaining editor gets the edit link and both tokens.
    let outcomes = bob.sync(&ds);
    let [Outcome::Rotated(rotation)] = &outcomes[..] else {
        panic!("{outcomes:?}");
    };
    let Rotation { link, tokens } = &**rotation;
    assert!(link.can_attest());
    assert_eq!(link.to_base64url(), new_link.to_base64url());
    assert_eq!(tokens.edit.as_deref(), Some(rotate.edit_token.as_str()));
    assert_eq!(tokens.view, rotate.view_token);
    assert_eq!(bob.g.doc_keys().generation(), 2);

    // The remaining viewer gets the view link and no edit token.
    let outcomes = carol.sync(&ds);
    let [Outcome::Rotated(rotation)] = &outcomes[..] else {
        panic!("{outcomes:?}");
    };
    let Rotation { link, tokens } = &**rotation;
    assert!(!link.can_attest());
    assert_eq!(*link.view_secret(), *new_link.view_secret());
    assert_eq!(tokens.edit, None);
    assert_eq!(tokens.view, rotate.view_token);
    assert!(!carol.g.link().can_attest());
    assert_eq!(carol.g.doc_keys().generation(), 2);

    // The removed one is told so and is locked out of everything new.
    assert!(matches!(dave.sync(&ds)[..], [Outcome::Removed]));
    assert!(!dave.g.is_active());
    assert!(matches!(
        Keyring::open_verified(dave.g.link(), &ds.keyring),
        Err(CryptoError::BadSignature)
    ));
    assert!(dave.g.presence_key().is_err());
    assert!(matches!(
        ProjectGroup::join_external(&old, &ds.group_info, &ds.keyring, b"dave"),
        Err(MlsError::Crypto(_))
    ));

    // Roster, profiles and records carry over to generation 2.
    for client in [&alice, &bob, &carol] {
        assert_eq!(
            client
                .roster()
                .iter()
                .map(|(n, ..)| n.as_str())
                .collect::<Vec<_>>(),
            ["alice", "bob", "carol"]
        );
    }
    let fresh = bob
        .g
        .doc_keys()
        .encrypt_delta(&bob.g.signer(), 2, 0, 1, b"gen 2")
        .unwrap();
    for client in [&alice, &carol] {
        let out = client.g.doc_keys().decrypt_record(&fresh).unwrap();
        assert_eq!(out.plaintext, b"gen 2");
        assert_eq!(
            client
                .g
                .doc_keys()
                .decrypt_record(&record)
                .unwrap()
                .plaintext,
            b"gen 1"
        );
    }
    assert!(matches!(
        dave.g.doc_keys().decrypt_record(&fresh),
        Err(CryptoError::UnknownGeneration(2))
    ));
    assert!(matches!(
        carol
            .g
            .doc_keys()
            .encrypt_delta(&carol.g.signer(), 3, 0, 1, b"x"),
        Err(CryptoError::ReadOnly)
    ));

    // The presence key moved on with the epoch.
    let key = carol.g.presence_key().unwrap();
    assert!(matches!(
        key.open(&sealed, |leaf| carol.g.signer_of(leaf)),
        Err(CryptoError::WrongEpoch(_))
    ));

    // New joiners need the new links; the old edit link no longer works.
    assert!(ProjectGroup::join_external(&old, &ds.group_info, &ds.keyring, b"x").is_err());
    let erin = join(&mut ds, &view_of(&new_link), "erin");
    assert_eq!(erin.roster().len(), 4);
    assert_eq!(ds.retired.len(), 0, "the fake server had no earlier tokens");
}

#[test]
fn resetting_links_keeps_everyone() {
    let (mut ds, [mut alice, mut bob, mut carol, mut dave], _) = team();
    let payload = alice.g.reset_links().unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    for (client, can_edit) in [(&mut bob, true), (&mut carol, false), (&mut dave, false)] {
        let outcomes = client.sync(&ds);
        let [Outcome::Rotated(rotation)] = &outcomes[..] else {
            panic!("{}: {outcomes:?}", client.name);
        };
        let link = &rotation.link;
        assert_eq!(link.can_attest(), can_edit, "{}", client.name);
        assert_eq!(client.roster().len(), 4);
        assert_eq!(
            *client.g.link().view_secret(),
            *alice.g.link().view_secret()
        );
    }
}

#[test]
fn rotations_stack_and_late_members_follow() {
    let (mut ds, [mut alice, mut bob, mut carol, _], _) = team();
    for _ in 0..2 {
        let payload = alice.g.reset_links().unwrap();
        ds.submit(payload).unwrap();
        alice.g.confirm_pending().unwrap();
    }
    // Bob and carol were away for both rotations. The first envelope gives
    // the link of generation 2, the second the one of generation 3.
    let outcomes = bob.sync(&ds);
    assert!(matches!(
        &outcomes[..],
        [Outcome::Rotated(_), Outcome::Rotated(_)]
    ));
    assert_eq!(bob.g.link().to_base64url(), alice.g.link().to_base64url());
    assert_eq!(bob.g.doc_keys().generation(), 3);
    carol.sync(&ds);
    assert_eq!(*carol.g.link().view_secret(), *alice.g.link().view_secret());
    assert_eq!(carol.g.generation().unwrap(), 3);
}

#[test]
fn viewers_commits_are_rejected_by_everyone() {
    let (mut ds, [mut alice, mut bob, mut carol, mut dave], _) = team();
    let epoch = alice.g.epoch();
    assert!(matches!(
        carol.g.self_update(b"carol"),
        Err(MlsError::NotEditor)
    ));
    assert!(matches!(carol.g.reset_links(), Err(MlsError::NotEditor)));

    // What a modified client would send.
    let payload = carol.g.commit_leaf(None, b"carol").unwrap();
    ds.submit(payload).unwrap();
    for client in [&mut alice, &mut bob, &mut dave] {
        let outcomes = client.sync(&ds);
        let [Outcome::Invalid(why)] = &outcomes[..] else {
            panic!("{}: {outcomes:?}", client.name);
        };
        assert!(why.contains("viewer"), "{why}");
        assert_eq!(client.g.epoch(), epoch);
    }
    // They all stall at the same point, and the roster did not change.
    let names = |c: &Client| -> Vec<_> { c.roster().into_iter().map(|(n, r, _)| (n, r)).collect() };
    assert_eq!(names(&alice), names(&bob));
    assert_eq!(names(&alice).len(), 4);
}

#[test]
fn forged_editor_leaves_are_rejected() {
    let (ds, [mut alice, bob, ..], link) = team();
    let epoch = alice.g.epoch();
    let view = view_of(&link);

    // Claiming to be an editor with an invented attestation.
    let forged = EditorInfo {
        generation: 1,
        attestation: [1; 64],
        hpke_pub: vec![1, 2, 3],
    };
    // Or with bob's, replayed under a key of the forger's own.
    let replayed = read_leaf(bob.g.group.own_leaf_node().unwrap())
        .editor
        .unwrap()
        .unwrap();
    for editor in [forged, replayed] {
        let (_g, payload) = ProjectGroup::join_with(
            Device::generate(),
            &view,
            &ds.group_info,
            Keyring::open_verified(&view, &ds.keyring).unwrap(),
            b"mallory",
            Some(editor),
        )
        .unwrap();
        let mut scratch = Ds {
            log: ds.log.clone(),
            group_id: Vec::new(),
            group_info: Vec::new(),
            keyring: Vec::new(),
            edit_token: None,
            view_token: None,
            retired: Vec::new(),
        };
        scratch.submit(payload).unwrap();
        let outcomes = alice.sync(&scratch);
        let [Outcome::Invalid(why)] = &outcomes[..] else {
            panic!("{outcomes:?}");
        };
        assert!(why.contains("without proof"), "{why}");
        assert_eq!(alice.g.epoch(), epoch);
    }
}

#[test]
fn records_without_an_editors_attestation_are_refused() {
    let (_, [alice, bob, carol, _], _) = team();
    // A viewer encrypts correctly with the keys it holds and signs with its
    // own device key, attaching an attestation it cannot make.
    struct Liar<'a>(&'a LocalSigner);
    impl RecordSigner for Liar<'_> {
        fn public_key(&self) -> PublicKey {
            self.0.public_key()
        }
        fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN] {
            self.0.sign(message)
        }
        fn attestation(&self, _: u32) -> Option<Attestation> {
            Some([7; SIGNATURE_LEN])
        }
    }
    let carol_signer = carol.g.signer();
    let record = carol
        .g
        .doc_keys()
        .encrypt_delta(&Liar(&carol_signer), 9, 0, 1, b"x")
        .unwrap();
    for client in [&alice, &bob] {
        assert!(matches!(
            client.g.doc_keys().decrypt_record(&record),
            Err(CryptoError::NotEditor)
        ));
    }
}

#[test]
fn rotations_need_their_envelope() {
    let (mut ds, [mut alice, bob, ..]) = {
        let (ds, clients, _) = team();
        (ds, clients)
    };
    let epoch = bob.g.epoch();
    let saved = bob.g.export_state();
    let payload = alice.g.reset_links().unwrap();
    let (commit, envelope) = (payload.commit.clone(), payload.envelope.clone().unwrap());
    ds.submit(payload).unwrap();

    // MLS spends the message key on the first attempt, so each case starts
    // from the saved state. A refused commit is final for its epoch.
    let attempt = |envelope: Option<&[u8]>| {
        let mut bob = ProjectGroup::import_state(&saved).unwrap();
        let outcome = bob.process_commit(epoch, &commit, envelope).unwrap();
        (outcome, bob.epoch())
    };
    let (outcome, after) = attempt(None);
    assert!(
        matches!(&outcome, Outcome::Invalid(why) if why.contains("envelope")),
        "{outcome:?}"
    );
    assert_eq!(after, epoch);
    // The shared part comes first. Damage to a member's own edit entry only
    // costs that member the edit link, see `rotation`.
    let mut broken = envelope.clone();
    broken[10] ^= 1;
    let (outcome, after) = attempt(Some(&broken));
    assert!(matches!(outcome, Outcome::Invalid(_)), "{outcome:?}");
    assert_eq!(after, epoch);
    let mut downgraded = envelope.clone();
    let last = downgraded.len() - 1;
    downgraded[last] ^= 1;
    let (outcome, after) = attempt(Some(&downgraded));
    assert!(
        matches!(&outcome, Outcome::Rotated(r) if !r.link.can_attest()),
        "{outcome:?}"
    );
    assert_eq!(after, epoch + 1);

    let (outcome, after) = attempt(Some(&envelope));
    assert!(matches!(outcome, Outcome::Rotated(_)), "{outcome:?}");
    assert_eq!(after, epoch + 1);
}

#[test]
fn editors_cannot_remove_themselves_or_strangers() {
    let (_, [mut alice, ..], _) = team();
    let own = alice.g.own_leaf();
    assert!(matches!(
        alice.g.remove_and_rotate(&[own]),
        Err(MlsError::BadLeaf(l)) if l == own
    ));
    assert!(matches!(
        alice.g.remove_and_rotate(&[99]),
        Err(MlsError::BadLeaf(99))
    ));
    // A failed attempt stages nothing.
    assert!(!alice.g.has_pending());
    assert!(matches!(
        alice.g.confirm_pending(),
        Err(MlsError::NoPending)
    ));
}

#[test]
fn resync_replaces_the_old_leaf() {
    let (mut ds, [mut alice, bob, mut carol, _], link) = team();
    let members = alice.roster().len();
    let saved = bob.g.export_state();
    let device = bob.g.device().duplicate();
    drop(bob);

    // The group moves on while bob is away.
    let payload = alice.g.self_update(b"alice").unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(matches!(carol.sync(&ds)[..], [Outcome::Advanced]));

    // Loading the saved state and catching up is the cheap way back.
    let mut bob = Client {
        name: "bob",
        g: ProjectGroup::import_state(&saved).unwrap(),
    };
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(bob.g.epoch(), alice.g.epoch());
    assert_eq!(bob.roster().len(), members);

    // Without usable state the same device joins again and replaces its leaf.
    let mut rejoined = {
        let (mut g, payload) = ProjectGroup::join_external_as(
            device.duplicate(),
            &link,
            &ds.group_info,
            &ds.keyring,
            b"bob",
        )
        .unwrap();
        ds.submit(payload).unwrap();
        g.confirm_pending().unwrap();
        Client { name: "bob", g }
    };
    for client in [&mut alice, &mut carol] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
        assert_eq!(client.roster().len(), members, "{}", client.name);
    }
    assert!(matches!(rejoined.sync(&ds).len(), 0));
    assert_eq!(rejoined.roster().len(), members);
    // The abandoned state learns it is gone.
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Removed]));

    // A different device key is a new member, and the old leaf stays.
    let ghost = join(&mut ds, &link, "bob");
    for client in [&mut alice, &mut carol] {
        client.sync(&ds);
    }
    assert_eq!(alice.roster().len(), members + 1);
    drop(ghost);
}

#[test]
fn state_round_trips() {
    let (mut ds, [mut alice, mut bob, mut carol, _], _) = team();
    let payload = alice.g.reset_links().unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    bob.sync(&ds);
    carol.sync(&ds);

    for client in [&alice, &bob, &carol] {
        let saved = client.g.export_state();
        let loaded = ProjectGroup::import_state(&saved).unwrap();
        assert_eq!(loaded.epoch(), client.g.epoch());
        assert_eq!(loaded.group_id(), client.g.group_id());
        assert_eq!(loaded.members().unwrap(), client.g.members().unwrap());
        assert_eq!(loaded.link().to_base64url(), client.g.link().to_base64url());
        assert_eq!(loaded.doc_keys().key_id(), client.g.doc_keys().key_id());
        assert_eq!(loaded.device().signer_pub(), client.g.device().signer_pub());
        assert_eq!(loaded.export_state(), saved, "{}", client.name);
    }

    // The loaded copy is a working member.
    let mut loaded = Client {
        name: "alice",
        g: ProjectGroup::import_state(&alice.g.export_state()).unwrap(),
    };
    let payload = loaded.g.self_update(b"alice").unwrap();
    ds.submit(payload).unwrap();
    loaded.g.confirm_pending().unwrap();
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert!(matches!(carol.sync(&ds)[..], [Outcome::Advanced]));

    // A commit still waiting for the server is part of saved state: the
    // reply may be the thing that was lost.
    let staged = loaded.g.self_update(b"alice").unwrap();
    let mut reloaded = ProjectGroup::import_state(&loaded.g.export_state()).unwrap();
    assert!(reloaded.has_pending());
    assert_eq!(reloaded.pending_submit(), Some(&staged));
    assert_eq!(reloaded.epoch(), loaded.g.epoch());
    assert_eq!(reloaded.export_state(), loaded.g.export_state());
    reloaded.confirm_pending().unwrap();
    assert_eq!(reloaded.epoch(), loaded.g.epoch() + 1);
}

#[test]
fn saved_state_is_versioned_and_checked() {
    let (_, [alice, ..], _) = team();
    let saved = alice.g.export_state();
    assert_eq!(saved[0], MLS_STATE_VERSION);
    let mut newer = saved.to_vec();
    newer[0] = MLS_STATE_VERSION + 1;
    assert!(matches!(
        ProjectGroup::import_state(&newer),
        Err(MlsError::NewerState(v)) if v == MLS_STATE_VERSION + 1
    ));
    for len in (0..200).chain([saved.len() - 1]) {
        assert!(ProjectGroup::import_state(&saved[..len]).is_err(), "{len}");
    }
    let mut trailing = saved.to_vec();
    trailing.push(0);
    assert!(ProjectGroup::import_state(&trailing).is_err());

    // A join the server never confirmed has no group to come back to.
    let (ds, _, link) = project();
    let (g, _payload) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"bob").unwrap();
    assert!(matches!(
        ProjectGroup::import_state(&g.export_state()),
        Err(MlsError::Unconfirmed)
    ));
}

#[test]
fn a_stuck_group_restarts_under_a_new_incarnation() {
    let (ds, [alice, bob, carol, _], link) = team();
    assert_eq!(alice.g.incarnation(), 0);
    assert!(matches!(carol.g.reset(b"carol"), Err(MlsError::NotEditor)));

    let (fresh, payload) = alice.g.reset(b"alice").unwrap();
    assert_eq!(payload.incarnation, 0);
    assert_eq!(fresh.incarnation(), 1);
    assert_ne!(payload.group_id, ds.group_id);
    assert_eq!(payload.group_id[..16], ds.group_id[..16]);
    assert_eq!(fresh.members().unwrap().len(), 1);
    assert_eq!(fresh.link().to_base64url(), link.to_base64url());

    // Everyone rejoins with the same link and keys.
    let (mut joined, payload) = ProjectGroup::join_external_as(
        bob.g.device().duplicate(),
        &link,
        &payload.group_info,
        &payload.keyring,
        b"bob",
    )
    .unwrap();
    joined.confirm_pending().unwrap();
    assert_eq!(payload.epoch, 0);
    assert_eq!(joined.members().unwrap().len(), 2);
    assert_eq!(
        joined.doc_keys().key_id(),
        bob.g.doc_keys().key_id(),
        "same generation, same keys"
    );
}

#[test]
fn groups_with_another_generation_than_their_keyring_are_refused() {
    let (mut ds, [mut alice, ..], _) = team();
    let stale_keyring = ds.keyring.clone();
    let payload = alice.g.reset_links().unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    // New group info but the old keyring: a server mixing generations.
    let view = view_of(alice.g.link());
    assert!(ProjectGroup::join_external(&view, &ds.group_info, &stale_keyring, b"x").is_err());
}

#[test]
fn a_removed_editor_cannot_rejoin_as_an_editor_with_an_old_attestation() {
    let (mut ds, mut alice, link1) = project();
    let mut bob = join(&mut ds, &link1, "bob");
    alice.sync(&ds);
    let bob_device = bob.g.device().duplicate();
    let old_editor = editor_info(&bob_device, &link1, 1).unwrap();

    let leaf = alice.leaf_of("bob");
    let payload = alice.g.remove_and_rotate(&[leaf]).unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(matches!(bob.sync(&ds).last(), Some(Outcome::Removed)));

    // Bob can still get the new view link, e.g. from a viewer, and pairs it
    // with the attestation of the generation he was an editor in.
    let view2 = view_of(alice.g.link());
    let (_g, payload) = ProjectGroup::join_with(
        bob_device,
        &view2,
        &ds.group_info,
        Keyring::open_verified(&view2, &ds.keyring).unwrap(),
        b"bob",
        Some(old_editor),
    )
    .unwrap();
    ds.submit(payload).unwrap();
    let outcomes = alice.sync(&ds);
    let [Outcome::Invalid(why)] = &outcomes[..] else {
        panic!("{outcomes:?}");
    };
    assert!(why.contains("without proof"), "{why}");
}

#[test]
fn existing_editors_keep_their_old_attestation_through_rotations() {
    let (mut ds, [mut alice, mut bob, ..], _) = team();
    let payload = alice.g.reset_links().unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    bob.sync(&ds);
    // Bob's leaf still carries the generation 1 attestation.
    let roles: Vec<_> = alice
        .g
        .members()
        .unwrap()
        .into_iter()
        .map(|m| m.role)
        .collect();
    assert_eq!(roles.iter().filter(|r| **r == Role::Editor).count(), 2);
    // And he refreshes it with the new link on his next commit.
    let payload = bob.g.self_update(b"bob").unwrap();
    ds.submit(payload).unwrap();
    bob.g.confirm_pending().unwrap();
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
}

#[test]
fn a_rotation_whose_accept_was_lost_is_confirmed_by_the_log() {
    let (mut ds, [mut alice, mut bob, ..], old) = team();
    let leaf = alice.leaf_of("carol");
    let payload = alice.g.remove_and_rotate(&[leaf]).unwrap();
    let rotate = payload.rotate.clone().unwrap();
    ds.submit(payload).unwrap();
    // The Accepted reply never arrives. The commit survives a restart.
    assert!(alice.g.has_pending());
    let mut alice = Client {
        name: "alice",
        g: ProjectGroup::import_state(&alice.g.export_state()).unwrap(),
    };
    assert!(alice.g.has_pending());
    assert_eq!(alice.g.link().to_base64url(), old.to_base64url());

    let outcomes = alice.sync(&ds);
    let [Outcome::Rotated(rotation)] = &outcomes[..] else {
        panic!("{outcomes:?}");
    };
    assert!(rotation.link.can_attest());
    assert_eq!(
        rotation.tokens.edit.as_deref(),
        Some(rotate.edit_token.as_str())
    );
    assert_eq!(rotation.tokens.view, rotate.view_token);
    assert!(!alice.g.has_pending());
    assert_eq!(alice.g.link().to_base64url(), rotation.link.to_base64url());
    assert_eq!(alice.g.doc_keys().generation(), 2);
    assert!(!alice.g.needs_keyring());

    // Bob reads the same link from the envelope.
    let outcomes = bob.sync(&ds);
    let [Outcome::Rotated(theirs)] = &outcomes[..] else {
        panic!("{outcomes:?}");
    };
    assert_eq!(theirs.link.to_base64url(), rotation.link.to_base64url());
}

#[test]
fn a_lost_commit_that_lost_the_epoch_is_dropped_by_the_log() {
    let (mut ds, [mut alice, mut bob, ..], old) = team();
    let ours = alice.g.reset_links().unwrap();
    let theirs = bob.g.self_update(b"bob").unwrap();
    ds.submit(theirs).unwrap();
    bob.g.confirm_pending().unwrap();
    assert!(ds.submit(ours).is_err());
    // Alice never heard the Conflict. The log tells her.
    let mut alice = Client {
        name: "alice",
        g: ProjectGroup::import_state(&alice.g.export_state()).unwrap(),
    };
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
    assert!(!alice.g.has_pending());
    assert_eq!(alice.g.link().to_base64url(), old.to_base64url());
}

#[test]
fn a_pending_commit_does_not_confirm_on_a_later_epoch() {
    let (mut ds, [mut alice, mut bob, ..], _) = team();
    let ours = alice.g.self_update(b"alice").unwrap();
    let theirs = bob.g.self_update(b"bob").unwrap();
    ds.submit(theirs).unwrap();
    bob.g.confirm_pending().unwrap();
    let again = bob.g.self_update(b"bob").unwrap();
    ds.submit(again).unwrap();
    assert!(ds.submit(ours).is_err());
    // Only the commit after the lost epoch arrives: alice cannot tell that
    // hers was not the one at the epoch before.
    let (epoch, commit, envelope) = ds.log[alice.g.epoch() as usize + 1].clone();
    assert!(matches!(
        alice.g.process_commit(epoch, &commit, envelope.as_deref()),
        Err(MlsError::Epoch { .. })
    ));
    assert!(alice.g.has_pending());
}

#[test]
fn a_join_whose_accept_was_lost_is_confirmed_by_the_log() {
    let (mut ds, mut alice, link) = project();
    let (bob, payload) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"bob").unwrap();
    assert_eq!(bob.pending_submit(), Some(&payload));
    ds.submit(payload).unwrap();
    // No Accepted reply. A later commit extending the join proves it landed.
    alice.sync(&ds);
    let next = alice.g.self_update(b"alice").unwrap();
    ds.submit(next).unwrap();
    alice.g.confirm_pending().unwrap();

    let mut bob = Client {
        name: "bob",
        g: bob,
    };
    let outcomes = bob.sync(&ds);
    assert!(matches!(outcomes[..], [Outcome::Advanced]), "{outcomes:?}");
    assert!(!bob.g.has_pending());
    assert_eq!(bob.g.epoch(), alice.g.epoch());
}

#[test]
fn a_join_that_lost_the_epoch_is_spent() {
    let (mut ds, _alice, link) = project();
    let (mut bob, bob_join) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"bob").unwrap();
    let (_carol, carol_join) =
        ProjectGroup::join_external(&link, &ds.group_info, &ds.keyring, b"carol").unwrap();
    ds.submit(carol_join).unwrap();
    assert!(ds.submit(bob_join).is_err());
    let (epoch, commit, envelope) = ds.log[0].clone();
    assert!(matches!(
        bob.process_commit(epoch, &commit, envelope.as_deref()),
        Err(MlsError::NotActive)
    ));
    assert!(!bob.has_pending() && !bob.is_active());
}

#[test]
fn editors_with_unusable_hpke_keys_are_rejected_at_the_join() {
    let (ds, [mut alice, ..], link) = team();
    let device = Device::generate();
    for hpke_pub in [vec![], vec![1; 31], vec![1; 33]] {
        let mut editor = editor_info(&device, &link, 1).unwrap();
        editor.hpke_pub = hpke_pub;
        let (_g, payload) = ProjectGroup::join_with(
            device.duplicate(),
            &link,
            &ds.group_info,
            Keyring::open_verified(&link, &ds.keyring).unwrap(),
            b"mallory",
            Some(editor),
        )
        .unwrap();
        let mut scratch = Ds::init(InitPayload {
            group_id: Vec::new(),
            group_info: Vec::new(),
            keyring: Vec::new(),
        });
        scratch.log = ds.log.clone();
        scratch.submit(payload).unwrap();
        let outcomes = alice.sync(&scratch);
        assert!(
            matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("without proof")),
            "{outcomes:?}"
        );
    }
}

#[test]
fn group_ids_must_have_the_expected_shape() {
    let link = LinkSecret::generate_edit();
    let short = b"short".to_vec();
    let (g, payload) = ProjectGroup::start(
        Device::generate(),
        &link,
        Keyring::new(&link),
        Policy::new(link.attest_pub()),
        short,
        b"mallory",
    )
    .map(|(g, info, keyring)| {
        let payload = InitPayload {
            group_id: g.group_id.clone(),
            group_info: info,
            keyring,
        };
        (g, payload)
    })
    .unwrap();
    assert!(matches!(
        ProjectGroup::join_external(&link, &payload.group_info, &payload.keyring, b"bob"),
        Err(MlsError::Mismatch(_))
    ));
    assert!(matches!(
        ProjectGroup::import_state(&g.export_state()),
        Err(MlsError::Mismatch(_))
    ));
}
