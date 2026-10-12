//! Several clients against a tiny in-memory delivery service: the first
//! commit per epoch wins, everything else is stored as opaque bytes.

use super::*;
use crate::crypto::{Attestation, IDENTITY_SEAL_CONTEXT, RecordSigner, SIGNATURE_LEN};
use crate::identity::EntryKind;
use crate::owner::verify_rotation;

struct Ds {
    log: Vec<(u64, Vec<u8>, Option<Vec<u8>>)>,
    /// The owner key each entry of `log` moved the server on to, as the
    /// real server sends it along with the commit.
    log_keys: Vec<Option<OwnerKey>>,
    group_id: Vec<u8>,
    group_info: Vec<u8>,
    keyring: Vec<u8>,
    owner_key: OwnerKey,
    edit_token: Option<String>,
    view_token: Option<String>,
    retired: Vec<String>,
}

/// Why the fake server turned a submission down.
#[derive(Debug, PartialEq, Eq)]
enum Refused {
    Conflict(u64),
    NotOwner,
}

impl Ds {
    fn init(payload: InitPayload) -> Self {
        Self {
            log: Vec::new(),
            log_keys: Vec::new(),
            group_id: payload.group_id,
            group_info: payload.group_info,
            keyring: payload.keyring,
            owner_key: payload.owner_key,
            edit_token: None,
            view_token: None,
            retired: Vec::new(),
        }
    }

    /// The server after `payload` reset the group: a new log, the same
    /// owner key.
    fn after_reset(&self, payload: &ResetPayload) -> Self {
        Self::init(InitPayload {
            group_id: payload.group_id.clone(),
            group_info: payload.group_info.clone(),
            keyring: payload.keyring.clone(),
            owner_key: self.owner_key,
        })
    }

    fn head(&self) -> u64 {
        self.log.len() as u64
    }

    /// What `GET /api/s/{token}/mls` answers.
    fn boot(&self) -> Bootstrap<'_> {
        Bootstrap {
            group_info: &self.group_info,
            keyring: &self.keyring,
            owner_key: &self.owner_key,
        }
    }

    /// `Err(head)` is a Conflict. Checks a rotation's owner proof like the
    /// real server, and panics on a refusal.
    fn submit(&mut self, payload: SubmitPayload) -> Result<(), u64> {
        match self.submit_checked(payload) {
            Ok(()) => Ok(()),
            Err(Refused::Conflict(head)) => Err(head),
            Err(Refused::NotOwner) => panic!("the server refuses a rotation without the owner key"),
        }
    }

    fn submit_checked(&mut self, payload: SubmitPayload) -> Result<(), Refused> {
        if payload.epoch != self.head() {
            return Err(Refused::Conflict(self.head()));
        }
        if let Some(rotate) = &payload.rotate {
            let claim = RotationClaim {
                group_id: &self.group_id,
                epoch: payload.epoch,
                commit: &payload.commit,
                group_info: &payload.group_info,
                keyring: payload.keyring.as_deref().unwrap_or_default(),
                envelope: payload.envelope.as_deref().unwrap_or_default(),
                edit_token: &rotate.edit_token,
                view_token: &rotate.view_token,
                next_owner_key: &rotate.next_owner_key,
            };
            if !verify_rotation(&self.owner_key, &claim, &rotate.owner_proof) {
                return Err(Refused::NotOwner);
            }
            self.owner_key = rotate.next_owner_key;
        }
        self.submit_unchecked(payload).map_err(Refused::Conflict)
    }

    /// What a server that checks nothing but the epoch would take, to see
    /// that the members refuse what the server should have.
    fn submit_unchecked(&mut self, payload: SubmitPayload) -> Result<(), u64> {
        if payload.epoch != self.head() {
            return Err(self.head());
        }
        self.log
            .push((payload.epoch, payload.commit, payload.envelope));
        self.log_keys
            .push(payload.rotate.as_ref().map(|r| r.next_owner_key));
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
    g: SpaceGroup,
}

impl Client {
    /// Applies everything new in the log. Stops at the first commit that is
    /// not merged.
    fn sync(&mut self, ds: &Ds) -> Vec<Outcome> {
        let mut outcomes = Vec::new();
        while self.g.is_active() {
            let at = self.g.epoch() as usize;
            let Some((epoch, commit, envelope)) = ds.log.get(at) else {
                break;
            };
            let outcome = self
                .g
                .process_commit(
                    *epoch,
                    commit,
                    envelope.as_deref(),
                    ds.log_keys.get(at).copied().flatten().as_ref(),
                )
                .unwrap();
            let stop = matches!(outcome, Outcome::Invalid(_) | Outcome::Removed { .. });
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
        SpaceGroup::join_external(link, ds.boot(), name.as_bytes(), None, None).unwrap();
    ds.submit(payload).expect("accepted");
    g.confirm_pending().unwrap();
    Client { name, g }
}

/// A new person with one device.
fn person() -> LocalIdentity {
    let device = DeviceKey::generate();
    let graph = PersonGraph::genesis(&device);
    LocalIdentity { device, graph }
}

/// Alice alone, as the creator of a space. Her person owns it.
fn space() -> (Ds, Client, LinkSecret) {
    space_with("alice", &person())
}

fn space_with(name: &'static str, identity: &LocalIdentity) -> (Ds, Client, LinkSecret) {
    let link = LinkSecret::generate_edit();
    let (g, payload) = SpaceGroup::create(&link, name.as_bytes(), identity).unwrap();
    (Ds::init(payload), Client { name, g }, link)
}

/// `secrets`, newest first, as copies a device kept.
fn held(secrets: impl IntoIterator<Item = OwnerSecret>) -> OwnerSecrets {
    secrets
        .into_iter()
        .map(|secret| (secret, Origin::Received))
        .collect()
}

fn view_of(link: &LinkSecret) -> LinkSecret {
    LinkSecret::from_base64url(&link.view_secret()).unwrap()
}

/// Alice and bob edit, carol and dave only view; everyone is caught up.
fn team() -> (Ds, [Client; 4], LinkSecret) {
    let (mut ds, mut alice, link) = space();
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
            [Role::Owner, Role::Editor, Role::Viewer, Role::Viewer]
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
    let payload = alice.g.self_update(b"alice", None, None).unwrap();
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
    let (mut ds, mut alice, link) = space();
    let (mut bob, bob_join) =
        SpaceGroup::join_external(&link, ds.boot(), b"bob", None, None).unwrap();
    let (mut carol, carol_join) =
        SpaceGroup::join_external(&link, ds.boot(), b"carol", None, None).unwrap();

    ds.submit(bob_join).unwrap();
    bob.confirm_pending().unwrap();
    let head = ds.submit(carol_join).unwrap_err();
    assert_eq!(head, 1);
    carol.discard_pending().unwrap();
    assert!(!carol.is_active());
    assert!(matches!(
        carol.process_commit(0, &ds.log[0].1, None, None),
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
    let a = alice.g.self_update(b"alice", None, None).unwrap();
    let b = bob.g.self_update(b"bob", None, None).unwrap();
    ds.submit(a).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(ds.submit(b).is_err());

    // Bob sees the winner arrive before he heard about the conflict: his
    // own commit is dropped and the winner applied.
    assert!(bob.g.has_pending());
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert!(!bob.g.has_pending());
    assert_eq!(bob.g.epoch(), alice.g.epoch());

    let b = bob.g.self_update(b"bob", None, None).unwrap();
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
    let Rotation { link, tokens, .. } = &**rotation;
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
    let Rotation { link, tokens, .. } = &**rotation;
    assert!(!link.can_attest());
    assert_eq!(*link.view_secret(), *new_link.view_secret());
    assert_eq!(tokens.edit, None);
    assert_eq!(tokens.view, rotate.view_token);
    assert!(!carol.g.link().can_attest());
    assert_eq!(carol.g.doc_keys().generation(), 2);

    // The removed one is told so and is locked out of everything new.
    assert!(matches!(dave.sync(&ds)[..], [Outcome::Removed { .. }]));
    assert!(!dave.g.is_active());
    assert!(matches!(
        Keyring::open_verified(dave.g.link(), &ds.keyring),
        Err(CryptoError::BadSignature)
    ));
    assert!(dave.g.presence_key().is_err());
    assert!(matches!(
        SpaceGroup::join_external(&old, ds.boot(), b"dave", None, None),
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
    assert!(SpaceGroup::join_external(&old, ds.boot(), b"x", None, None).is_err());
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
        carol.g.self_update(b"carol", None, None),
        Err(MlsError::NotEditor)
    ));
    assert!(matches!(carol.g.reset_links(), Err(MlsError::NotEditor)));

    // What a modified client would send.
    let payload = carol.g.commit_leaf(None, b"carol", None, None).unwrap();
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
        let (_g, payload) = SpaceGroup::join_with(
            LeafKeys::generate(),
            &view,
            ds.boot(),
            Keyring::open_verified(&view, &ds.keyring).unwrap(),
            b"mallory",
            JoinOptions {
                editor: Some(editor),
                ..Default::default()
            },
        )
        .unwrap();
        let scratch = with_commit(&ds, payload);
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
        let mut bob = SpaceGroup::import_state(&saved).unwrap();
        let outcome = bob.process_commit(epoch, &commit, envelope, None).unwrap();
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
    // The edit entry's ciphertext is the last thing in the envelope.
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
    let payload = alice.g.self_update(b"alice", None, None).unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(matches!(carol.sync(&ds)[..], [Outcome::Advanced]));

    // Loading the saved state and catching up is the cheap way back.
    let mut bob = Client {
        name: "bob",
        g: SpaceGroup::import_state(&saved).unwrap(),
    };
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(bob.g.epoch(), alice.g.epoch());
    assert_eq!(bob.roster().len(), members);

    // Without usable state the same device joins again and replaces its leaf.
    let mut rejoined = {
        let (mut g, payload) = SpaceGroup::join_external_as(
            device.duplicate(),
            &link,
            ds.boot(),
            b"bob",
            None,
            None,
            None,
            &OwnerSecrets::default(),
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
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Removed { .. }]));

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
        let loaded = SpaceGroup::import_state(&saved).unwrap();
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
        g: SpaceGroup::import_state(&alice.g.export_state()).unwrap(),
    };
    let payload = loaded.g.self_update(b"alice", None, None).unwrap();
    ds.submit(payload).unwrap();
    loaded.g.confirm_pending().unwrap();
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert!(matches!(carol.sync(&ds)[..], [Outcome::Advanced]));

    // A commit still waiting for the server is part of saved state: the
    // reply may be the thing that was lost.
    let staged = loaded.g.self_update(b"alice", None, None).unwrap();
    let mut reloaded = SpaceGroup::import_state(&loaded.g.export_state()).unwrap();
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
        SpaceGroup::import_state(&newer),
        Err(MlsError::NewerState(v)) if v == MLS_STATE_VERSION + 1
    ));
    for len in (0..200).chain([saved.len() - 1]) {
        assert!(SpaceGroup::import_state(&saved[..len]).is_err(), "{len}");
    }
    let mut trailing = saved.to_vec();
    trailing.push(0);
    assert!(SpaceGroup::import_state(&trailing).is_err());

    // A join the server never confirmed has no group to come back to.
    let (ds, _, link) = space();
    let (g, _payload) = SpaceGroup::join_external(&link, ds.boot(), b"bob", None, None).unwrap();
    assert!(matches!(
        SpaceGroup::import_state(&g.export_state()),
        Err(MlsError::Unconfirmed)
    ));
}

#[test]
fn a_stuck_group_restarts_under_a_new_incarnation() {
    let (ds, [alice, bob, carol, _], link) = team();
    assert_eq!(alice.g.incarnation(), 0);
    assert!(matches!(
        carol.g.reset(b"carol", None),
        Err(MlsError::NotEditor)
    ));

    let (fresh, payload) = alice.g.reset(b"alice", None).unwrap();
    assert_eq!(payload.incarnation, 0);
    assert_eq!(fresh.incarnation(), 1);
    // The server keeps its owner key through a reset, and so does the owner.
    assert!(alice.g.owner_secret().is_some());
    assert_eq!(fresh.owner_secret(), alice.g.owner_secret());
    assert!(fresh.holds_owner_key());
    assert_ne!(payload.group_id, ds.group_id);
    assert_eq!(payload.group_id[..16], ds.group_id[..16]);
    assert_eq!(fresh.members().unwrap().len(), 1);
    assert_eq!(fresh.link().to_base64url(), link.to_base64url());

    // Everyone rejoins with the same link and keys.
    let (mut joined, payload) = SpaceGroup::join_external_as(
        bob.g.device().duplicate(),
        &link,
        ds.after_reset(&payload).boot(),
        b"bob",
        None,
        None,
        Some(&bob.g),
        &OwnerSecrets::default(),
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
    assert!(
        SpaceGroup::join_external(
            &view,
            Bootstrap {
                keyring: &stale_keyring,
                ..ds.boot()
            },
            b"x",
            None,
            None
        )
        .is_err()
    );
}

#[test]
fn a_removed_editor_cannot_rejoin_as_an_editor_with_an_old_attestation() {
    let (mut ds, mut alice, link1) = space();
    let mut bob = join(&mut ds, &link1, "bob");
    alice.sync(&ds);
    let bob_device = bob.g.device().duplicate();
    let old_editor = editor_info(&bob_device, &link1, 1).unwrap();

    let leaf = alice.leaf_of("bob");
    let payload = alice.g.remove_and_rotate(&[leaf]).unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();
    assert!(matches!(
        bob.sync(&ds).last(),
        Some(Outcome::Removed { .. })
    ));

    // Bob can still get the new view link, e.g. from a viewer, and pairs it
    // with the attestation of the generation he was an editor in.
    let view2 = view_of(alice.g.link());
    let (_g, payload) = SpaceGroup::join_with(
        bob_device,
        &view2,
        ds.boot(),
        Keyring::open_verified(&view2, &ds.keyring).unwrap(),
        b"bob",
        JoinOptions {
            editor: Some(old_editor),
            ..Default::default()
        },
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
    assert_eq!(roles.iter().filter(|r| **r == Role::Editor).count(), 1);
    assert_eq!(roles.iter().filter(|r| **r == Role::Owner).count(), 1);
    // And he refreshes it with the new link on his next commit.
    let payload = bob.g.self_update(b"bob", None, None).unwrap();
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
        g: SpaceGroup::import_state(&alice.g.export_state()).unwrap(),
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
    // The next owner key was saved with the commit and is adopted with it.
    assert_eq!(
        alice.g.owner_secret().map(OwnerSecret::public),
        Some(rotate.next_owner_key)
    );
    assert!(alice.g.holds_owner_key());

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
    let theirs = bob.g.self_update(b"bob", None, None).unwrap();
    ds.submit(theirs).unwrap();
    bob.g.confirm_pending().unwrap();
    assert!(ds.submit(ours).is_err());
    // Alice never heard the Conflict. The log tells her.
    let mut alice = Client {
        name: "alice",
        g: SpaceGroup::import_state(&alice.g.export_state()).unwrap(),
    };
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
    assert!(!alice.g.has_pending());
    assert_eq!(alice.g.link().to_base64url(), old.to_base64url());
}

#[test]
fn a_pending_commit_does_not_confirm_on_a_later_epoch() {
    let (mut ds, [mut alice, mut bob, ..], _) = team();
    let ours = alice.g.self_update(b"alice", None, None).unwrap();
    let theirs = bob.g.self_update(b"bob", None, None).unwrap();
    ds.submit(theirs).unwrap();
    bob.g.confirm_pending().unwrap();
    let again = bob.g.self_update(b"bob", None, None).unwrap();
    ds.submit(again).unwrap();
    assert!(ds.submit(ours).is_err());
    // Only the commit after the lost epoch arrives: alice cannot tell that
    // hers was not the one at the epoch before.
    let (epoch, commit, envelope) = ds.log[alice.g.epoch() as usize + 1].clone();
    assert!(matches!(
        alice
            .g
            .process_commit(epoch, &commit, envelope.as_deref(), None),
        Err(MlsError::Epoch { .. })
    ));
    assert!(alice.g.has_pending());
}

#[test]
fn a_join_whose_accept_was_lost_is_confirmed_by_the_log() {
    let (mut ds, mut alice, link) = space();
    let (bob, payload) = SpaceGroup::join_external(&link, ds.boot(), b"bob", None, None).unwrap();
    assert_eq!(bob.pending_submit(), Some(&payload));
    ds.submit(payload).unwrap();
    // No Accepted reply. A later commit extending the join proves it landed.
    alice.sync(&ds);
    let next = alice.g.self_update(b"alice", None, None).unwrap();
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
    let (mut ds, _alice, link) = space();
    let (mut bob, bob_join) =
        SpaceGroup::join_external(&link, ds.boot(), b"bob", None, None).unwrap();
    let (_carol, carol_join) =
        SpaceGroup::join_external(&link, ds.boot(), b"carol", None, None).unwrap();
    ds.submit(carol_join).unwrap();
    assert!(ds.submit(bob_join).is_err());
    let (epoch, commit, envelope) = ds.log[0].clone();
    assert!(matches!(
        bob.process_commit(epoch, &commit, envelope.as_deref(), None),
        Err(MlsError::NotActive)
    ));
    assert!(!bob.has_pending() && !bob.is_active());
}

#[test]
fn editors_with_unusable_hpke_keys_are_rejected_at_the_join() {
    let (ds, [mut alice, ..], link) = team();
    let device = LeafKeys::generate();
    for hpke_pub in [vec![], vec![1; 31], vec![1; 33]] {
        let mut editor = editor_info(&device, &link, 1).unwrap();
        editor.hpke_pub = hpke_pub;
        let (_g, payload) = SpaceGroup::join_with(
            device.duplicate(),
            &link,
            ds.boot(),
            Keyring::open_verified(&link, &ds.keyring).unwrap(),
            b"mallory",
            JoinOptions {
                editor: Some(editor),
                ..Default::default()
            },
        )
        .unwrap();
        let scratch = with_commit(&ds, payload);
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
    let (g, payload) = SpaceGroup::start(
        LeafKeys::generate(),
        &link,
        Keyring::new(&link),
        Policy::new(link.attest_pub(), [7; 32]),
        short,
        b"mallory",
        None,
        (OwnerSecrets::default(), None),
    )
    .map(|(g, info, keyring)| {
        let payload = InitPayload {
            group_id: g.group_id.clone(),
            group_info: info,
            keyring,
            owner_key: [0; 32],
        };
        (g, payload)
    })
    .unwrap();
    assert!(matches!(
        SpaceGroup::join_external(&link, Ds::init(payload.clone()).boot(), b"bob", None, None),
        Err(MlsError::Mismatch(_))
    ));
    assert!(matches!(
        SpaceGroup::import_state(&g.export_state()),
        Err(MlsError::Mismatch(_))
    ));
}

/// One person's device keys and graph, as the tests hold them.
struct Robert {
    laptop: DeviceKey,
    phone: DeviceKey,
    /// Both devices valid.
    graph: PersonGraph,
}

fn add(device: &DeviceKey) -> EntryKind {
    EntryKind::AddDevice {
        device: device.public(),
        flags: 0,
    }
}

fn revoke(device: &DeviceKey) -> EntryKind {
    EntryKind::RevokeDevice {
        device: device.public(),
    }
}

fn local(key: &DeviceKey, graph: &PersonGraph) -> LocalIdentity {
    LocalIdentity {
        device: DeviceKey::import(&key.export()).unwrap(),
        graph: graph.clone(),
    }
}

fn join_as(ds: &mut Ds, link: &LinkSecret, name: &'static str, identity: &LocalIdentity) -> Client {
    let (mut g, payload) =
        SpaceGroup::join_external(link, ds.boot(), name.as_bytes(), Some(identity), None).unwrap();
    ds.submit(payload).expect("accepted");
    g.confirm_pending().unwrap();
    Client { name, g }
}

fn person_of(observer: &Client, name: &str) -> Person {
    observer
        .g
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.profile.as_deref() == Some(name.as_bytes()))
        .unwrap()
        .person
}

fn verified(id: PersonId, device: &DeviceKey, revoked: bool) -> Person {
    Person::Verified {
        id,
        device: device.public(),
        revoked,
    }
}

/// Alice, who owns the space, and two devices of another person, all
/// caught up.
fn two_devices() -> (Ds, [Client; 3], LinkSecret, Robert) {
    let (mut ds, mut alice, link) = space();
    let (laptop_key, phone_key) = (DeviceKey::generate(), DeviceKey::generate());
    let mut graph = PersonGraph::genesis(&laptop_key);
    graph.append(&laptop_key, add(&phone_key)).unwrap();
    let robert = Robert {
        laptop: laptop_key,
        phone: phone_key,
        graph,
    };
    let mut laptop = join_as(
        &mut ds,
        &link,
        "laptop",
        &local(&robert.laptop, &robert.graph),
    );
    let mut phone = join_as(
        &mut ds,
        &link,
        "phone",
        &local(&robert.phone, &robert.graph),
    );
    for client in [&mut alice, &mut laptop] {
        client.sync(&ds);
    }
    phone.sync(&ds);
    (ds, [alice, laptop, phone], link, robert)
}

/// A copy of `client`'s leaf commit with `identity` in place of its own, as
/// a modified client would send it.
fn commit_identity(client: &mut Client, identity: &LeafIdentity) -> SubmitPayload {
    let editor = editor_info(
        client.g.device(),
        client.g.link(),
        client.g.generation().unwrap(),
    )
    .unwrap();
    let sealed = client
        .g
        .doc_keys()
        .keyring()
        .identity_key()
        .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT);
    let name = client.name;
    client
        .g
        .commit_leaf(Some(editor), name.as_bytes(), Some(sealed), None)
        .unwrap()
}

#[test]
fn devices_of_one_person_read_as_that_person() {
    let (ds, [mut alice, laptop, phone], _, robert) = two_devices();
    alice.sync(&ds);
    let id = robert.graph.id();
    assert_eq!(
        person_of(&alice, "laptop"),
        verified(id, &robert.laptop, false)
    );
    assert_eq!(
        person_of(&alice, "phone"),
        verified(id, &robert.phone, false)
    );
    // Alice has a person of her own, bob in `team()` has none.
    assert!(matches!(
        person_of(&alice, "alice"),
        Person::Verified { revoked: false, .. }
    ));
    // Each device sees the other the same way, and its own leaf too.
    assert_eq!(
        person_of(&laptop, "phone"),
        verified(id, &robert.phone, false)
    );
    assert_eq!(
        person_of(&phone, "phone"),
        verified(id, &robert.phone, false)
    );

    let mut expected = vec![laptop.g.own_leaf(), phone.g.own_leaf()];
    expected.sort();
    assert_eq!(alice.g.leaves_of(&id).unwrap(), expected);
    // The own leaf is never offered for removal.
    assert_eq!(laptop.g.leaves_of(&id).unwrap(), vec![phone.g.own_leaf()]);
    assert!(alice.g.leaves_of(&[1; 32]).unwrap().is_empty());
    assert_eq!(alice.g.person_graph(&id), Some(robert.graph.clone()));
    assert_eq!(alice.g.person_graph(&[1; 32]), None);
}

#[test]
fn a_device_the_graph_does_not_list_cannot_join() {
    let (ds, _alice, link) = space();
    let (listed, stranger) = (DeviceKey::generate(), DeviceKey::generate());
    let graph = PersonGraph::genesis(&listed);
    let result = SpaceGroup::join_external(
        &link,
        ds.boot(),
        b"mallory",
        Some(&local(&stranger, &graph)),
        None,
    );
    assert!(matches!(
        result,
        Err(MlsError::Identity(GraphError::NotValid))
    ));
    assert!(ds.log.is_empty());

    // A revoked one neither.
    let mut graph = graph;
    graph.append(&listed, add(&stranger)).unwrap();
    graph.append(&listed, revoke(&stranger)).unwrap();
    assert!(SpaceGroup::create(&link, b"x", &local(&stranger, &graph)).is_err());
}

#[test]
fn a_binding_for_another_leaf_is_unverified() {
    let (mut ds, [mut alice, laptop, _], link, robert) = two_devices();
    let copied = read_leaf(laptop.g.group.own_leaf_node().unwrap())
        .sealed_identity
        .unwrap();
    let view = view_of(&link);
    let mut forge = |ds: &mut Ds, name: &'static str, identity: Vec<u8>| {
        let (mut g, payload) = SpaceGroup::join_with(
            LeafKeys::generate(),
            &view,
            ds.boot(),
            Keyring::open_verified(&view, &ds.keyring).unwrap(),
            name.as_bytes(),
            JoinOptions {
                identity: Some(identity),
                ..Default::default()
            },
        )
        .unwrap();
        ds.submit(payload).unwrap();
        g.confirm_pending().unwrap();
        alice.sync(ds);
        person_of(&alice, name)
    };
    // The laptop's identity, copied onto another leaf key.
    assert_eq!(forge(&mut ds, "mallory", copied), Person::Unverified);
    // Garbage that is not even an identity.
    assert_eq!(forge(&mut ds, "junk", vec![1, 2, 3]), Person::Unverified);

    // A binding by a device the person's graph does not list: the signature
    // is good, but nobody vouches for the device.
    let outsider = DeviceKey::generate();
    let leaf = LeafKeys::generate();
    let identity = LeafIdentity {
        binding: LeafBinding::new(&outsider, &leaf.signer_pub()),
        graph: robert.graph.clone(),
    };
    let keyring = Keyring::open_verified(&view, &ds.keyring).unwrap();
    let sealed = keyring
        .identity_key()
        .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT);
    let (mut g, payload) = SpaceGroup::join_with(
        leaf,
        &view,
        ds.boot(),
        keyring,
        b"outsider",
        JoinOptions {
            identity: Some(sealed),
            ..Default::default()
        },
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    alice.sync(&ds);
    assert_eq!(person_of(&alice, "outsider"), Person::Unverified);
    assert!(
        alice
            .g
            .leaves_of(&robert.graph.id())
            .unwrap()
            .iter()
            .all(|&leaf| leaf != alice.leaf_of("outsider"))
    );
}

#[test]
fn a_member_cannot_swap_its_device_or_person() {
    let (mut ds, [mut alice, mut laptop, mut phone], _, robert) = two_devices();
    let epoch = alice.g.epoch();
    let leaf_pub = laptop.g.device().signer_pub();
    let own = laptop.g.own_identity_open().unwrap();
    assert_eq!(own.binding.device, robert.laptop.public());

    // Another person's identity for the same leaf, and another device of
    // the same person: neither is the leaf the others admitted.
    let other = DeviceKey::generate();
    let swapped = [
        LeafIdentity {
            binding: LeafBinding::new(&other, &leaf_pub),
            graph: PersonGraph::genesis(&other),
        },
        LeafIdentity {
            binding: LeafBinding::new(&robert.phone, &leaf_pub),
            graph: robert.graph.clone(),
        },
    ];
    for identity in &swapped {
        let payload = commit_identity(&mut laptop, identity);
        let scratch = with_commit(&ds, payload);
        for client in [&mut alice, &mut phone] {
            let outcomes = client.sync(&scratch);
            let [Outcome::Invalid(why)] = &outcomes[..] else {
                panic!("{}: {outcomes:?}", client.name);
            };
            assert!(why.contains("device or person"), "{why}");
            assert_eq!(client.g.epoch(), epoch);
        }
        laptop.g.discard_pending().unwrap();
    }
    // Dropping the identity is the same.
    let payload = laptop.g.commit_leaf(None, b"laptop", None, None).unwrap();
    ds.submit(payload).unwrap();
    for client in [&mut alice, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Invalid(_)]));
    }
    assert_eq!(
        person_of(&alice, "laptop"),
        verified(robert.graph.id(), &robert.laptop, false)
    );
}

#[test]
fn a_self_update_extends_the_graph_and_cannot_roll_it_back() {
    let (mut ds, mut alice, link) = space();
    let (laptop_key, phone_key) = (DeviceKey::generate(), DeviceKey::generate());
    let small = PersonGraph::genesis(&laptop_key);
    let mut big = small.clone();
    big.append(&laptop_key, add(&phone_key)).unwrap();
    let id = small.id();

    let mut laptop = join_as(&mut ds, &link, "laptop", &local(&laptop_key, &small));
    alice.sync(&ds);
    laptop.sync(&ds);
    assert_eq!(alice.g.person_graph(&id), Some(small.clone()));
    assert!(!laptop.g.needs_identity_refresh(&small));
    assert!(laptop.g.needs_identity_refresh(&big));
    // A graph of someone else is no reason to refresh.
    assert!(
        !laptop
            .g
            .needs_identity_refresh(&PersonGraph::genesis(&phone_key))
    );

    // Refused before anything is sent.
    let foreign = PersonGraph::genesis(&phone_key);
    assert!(matches!(
        laptop.g.self_update(b"laptop", Some(&foreign), None),
        Err(MlsError::Identity(GraphError::ForeignGraph))
    ));
    assert!(!laptop.g.has_pending());

    let payload = laptop.g.self_update(b"laptop", Some(&big), None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(alice.g.person_graph(&id), Some(big.clone()));
    assert_eq!(laptop.g.person_graph(&id), Some(big.clone()));
    assert!(!laptop.g.needs_identity_refresh(&big));
    assert_eq!(
        person_of(&alice, "laptop"),
        verified(id, &laptop_key, false)
    );

    // Re-sealing the old, smaller graph is a rollback the others refuse.
    let leaf_pub = laptop.g.device().signer_pub();
    let rolled_back = LeafIdentity {
        binding: LeafBinding::new(&laptop_key, &leaf_pub),
        graph: small,
    };
    let payload = commit_identity(&mut laptop, &rolled_back);
    ds.submit(payload).unwrap();
    let outcomes = alice.sync(&ds);
    assert!(
        matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("drop devices")),
        "{outcomes:?}"
    );

    // Nobody can extend an identity they never had.
    let (_, mut anon, _) = {
        let (ds, [_, _, c, ..], l) = team();
        (ds, c, l)
    };
    assert!(matches!(
        anon.g.self_update(b"x", Some(&big), None),
        Err(MlsError::NotEditor)
    ));
    let (_, mut bob, _) = {
        let (ds, [_, b, ..], l) = team();
        (ds, b, l)
    };
    assert!(matches!(
        bob.g.self_update(b"bob", Some(&big), None),
        Err(MlsError::NoIdentity)
    ));
}

#[test]
fn a_revocation_carried_by_one_leaf_marks_the_persons_other_leaf() {
    let (mut ds, [mut alice, mut laptop, mut phone], _, robert) = two_devices();
    let id = robert.graph.id();
    let mut revoked = robert.graph.clone();
    revoked
        .append(&robert.laptop, revoke(&robert.phone))
        .unwrap();

    assert!(laptop.g.revoked_leaves().is_empty());
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut alice, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    // The phone's own leaf still carries the old graph, yet it reads revoked.
    for observer in [&alice, &laptop, &phone] {
        assert_eq!(
            person_of(observer, "phone"),
            verified(id, &robert.phone, true),
            "{}",
            observer.name
        );
        assert_eq!(
            person_of(observer, "laptop"),
            verified(id, &robert.laptop, false),
            "{}",
            observer.name
        );
    }
    // A revoked device still counts as the person's leaf, to be removed.
    assert!(
        alice
            .g
            .leaves_of(&id)
            .unwrap()
            .contains(&phone.g.own_leaf())
    );
    // Everyone sees it, whoever's person they are, and the revoked device
    // itself is not counted for its own sake.
    for observer in [&alice, &laptop] {
        assert_eq!(observer.g.revoked_leaves(), vec![phone.g.own_leaf()]);
    }
    assert!(phone.g.revoked_leaves().is_empty());
    assert_eq!(alice.g.person_graph(&id), Some(revoked));
}

/// Two forks of one person, each as large as a graph may be, so that
/// merging them overflows the cap.
fn forks() -> (DeviceKey, DeviceKey, PersonGraph, PersonGraph, PersonGraph) {
    let (a, b) = (DeviceKey::generate(), DeviceKey::generate());
    let mut graph = PersonGraph::genesis(&a);
    graph.append(&a, add(&b)).unwrap();
    let mut left = graph.clone();
    let mut right = graph.clone();
    while left.len() < crate::identity::MAX_GRAPH_ENTRIES - 1 {
        left.append(&a, add(&DeviceKey::generate())).unwrap();
    }
    while right.len() < crate::identity::MAX_GRAPH_ENTRIES - 1 {
        right.append(&b, add(&DeviceKey::generate())).unwrap();
    }
    assert!(left.clone().merge(&right).is_err());
    (a, b, graph, left, right)
}

#[test]
fn a_graph_that_does_not_merge_leaves_no_leaf_of_the_person_verified() {
    let (mut ds, mut alice, link) = space();
    let (a, b, _, left, right) = forks();
    let mut on_a = join_as(&mut ds, &link, "a", &local(&a, &left));
    alice.sync(&ds);
    on_a.sync(&ds);
    assert!(matches!(person_of(&alice, "a"), Person::Verified { .. }));

    // The second graph cannot be merged with the first. The others refuse
    // the join, so the group does not take it in ...
    let on_b = join_as(&mut ds, &link, "b", &local(&b, &right));
    for client in [&mut alice, &mut on_a] {
        let outcomes = client.sync(&ds);
        assert!(
            matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("does not merge")),
            "{outcomes:?}"
        );
    }
    // ... and the joiner, which merged its own commit, reads neither leaf as
    // the person's, instead of judging each on the graph it brought.
    assert_eq!(person_of(&on_b, "a"), Person::Unverified);
    assert_eq!(person_of(&on_b, "b"), Person::Unverified);
    assert_eq!(on_b.g.person_graph(&left.id()), None);
    assert!(on_b.g.leaves_of(&left.id()).unwrap().is_empty());
}

#[test]
fn removing_a_person_removes_every_device() {
    let (mut ds, [mut alice, mut laptop, mut phone], link, robert) = two_devices();
    let mut carol = join(&mut ds, &view_of(&link), "carol");
    for client in [&mut alice, &mut laptop, &mut phone] {
        client.sync(&ds);
    }

    let id = robert.graph.id();
    let leaves = alice.g.leaves_of(&id).unwrap();
    assert_eq!(leaves.len(), 2);
    let payload = alice.g.remove_and_rotate(&leaves).unwrap();
    ds.submit(payload).unwrap();
    alice.g.confirm_pending().unwrap();

    for client in [&mut laptop, &mut phone] {
        let outcomes = client.sync(&ds);
        assert!(
            matches!(outcomes[..], [Outcome::Removed { .. }]),
            "{outcomes:?}"
        );
    }
    let outcomes = carol.sync(&ds);
    assert!(
        matches!(outcomes[..], [Outcome::Rotated(_)]),
        "{outcomes:?}"
    );
    assert_eq!(alice.g.generation().unwrap(), 2);
    assert!(alice.g.leaves_of(&id).unwrap().is_empty());
    assert_eq!(alice.g.members().unwrap().len(), 2);
}

#[test]
fn commits_keep_the_identity() {
    // Robert owns the space, so his laptop may rotate.
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let identity = laptop.g.own_identity();
    assert!(identity.is_some());

    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    ds.submit(payload).unwrap();
    laptop.g.confirm_pending().unwrap();
    assert_eq!(laptop.g.own_identity(), identity);
    for client in [&mut alice, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    let id = robert.graph.id();
    let laptop_is = verified(id, &robert.laptop, false);
    assert_eq!(person_of(&alice, "laptop"), laptop_is);
    assert_eq!(person_of(&laptop, "laptop"), laptop_is);

    // A rotation re-attests the committer's leaf, which must not drop it.
    let payload = laptop.g.reset_links().unwrap();
    ds.submit(payload).unwrap();
    laptop.g.confirm_pending().unwrap();
    assert_eq!(laptop.g.own_identity(), identity);
    for client in [&mut alice, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Rotated(_)]));
    }
    assert_eq!(person_of(&alice, "laptop"), laptop_is);
    assert_eq!(person_of(&phone, "laptop"), laptop_is);
    assert_eq!(
        person_of(&phone, "phone"),
        verified(id, &robert.phone, false)
    );
}

#[test]
fn a_reset_carries_or_replaces_the_identity() {
    let (_, [_, laptop, _], _, robert) = two_devices();
    let id = robert.graph.id();
    let (fresh, _) = laptop.g.reset(b"laptop", None).unwrap();
    assert_eq!(fresh.own_identity(), laptop.g.own_identity());

    let mut bigger = robert.graph.clone();
    bigger
        .append(&robert.laptop, add(&DeviceKey::generate()))
        .unwrap();
    let (fresh, _) = laptop
        .g
        .reset(b"laptop", Some(&local(&robert.laptop, &bigger)))
        .unwrap();
    assert_eq!(fresh.person_graph(&id), Some(bigger));
}

fn role_of(observer: &Client, name: &str) -> Role {
    observer
        .g
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.profile.as_deref() == Some(name.as_bytes()))
        .unwrap()
        .role
}

fn commit(ds: &mut Ds, client: &mut Client, payload: SubmitPayload) -> Option<Rotation> {
    ds.submit(payload).expect("accepted");
    client.g.confirm_pending().unwrap()
}

/// A copy of the log with `payload` on top, as a server that does not check
/// anything would hold it.
fn with_commit(ds: &Ds, payload: SubmitPayload) -> Ds {
    let mut scratch = Ds::init(InitPayload {
        group_id: Vec::new(),
        group_info: Vec::new(),
        keyring: Vec::new(),
        owner_key: [0; 32],
    });
    scratch.log = ds.log.clone();
    scratch.submit_unchecked(payload).unwrap();
    scratch
}

/// Robert created the space on his laptop; the phone was paired later and
/// joined with the extended graph. Alice and bob are editors without a
/// person. All caught up.
fn robert_owns() -> (Ds, [Client; 4], LinkSecret, Robert) {
    let (laptop_key, phone_key) = (DeviceKey::generate(), DeviceKey::generate());
    let small = PersonGraph::genesis(&laptop_key);
    let mut graph = small.clone();
    graph.append(&laptop_key, add(&phone_key)).unwrap();
    let robert = Robert {
        laptop: laptop_key,
        phone: phone_key,
        graph,
    };
    let (mut ds, mut laptop, link) = space_with("laptop", &local(&robert.laptop, &small));
    let mut phone = join_as(
        &mut ds,
        &link,
        "phone",
        &local(&robert.phone, &robert.graph),
    );
    let mut alice = join(&mut ds, &link, "alice");
    let mut bob = join(&mut ds, &link, "bob");
    for client in [&mut laptop, &mut phone, &mut alice] {
        client.sync(&ds);
    }
    bob.sync(&ds);
    (ds, [laptop, phone, alice, bob], link, robert)
}

/// `robert.graph` with the phone revoked by the laptop.
fn phone_revoked(robert: &Robert) -> PersonGraph {
    let mut graph = robert.graph.clone();
    graph.append(&robert.laptop, revoke(&robert.phone)).unwrap();
    graph
}

#[test]
fn only_the_owner_can_remove_or_reset_links() {
    let (mut ds, [mut alice, mut bob, mut carol, mut dave], _) = team();
    let epoch = alice.g.epoch();
    assert_eq!(role_of(&alice, "alice"), Role::Owner);
    assert_eq!(role_of(&alice, "bob"), Role::Editor);
    let carol_leaf = bob.leaf_of("carol");
    assert!(matches!(
        bob.g.remove_and_rotate(&[carol_leaf]),
        Err(MlsError::NotOwner)
    ));
    assert!(matches!(bob.g.reset_links(), Err(MlsError::NotOwner)));
    assert!(matches!(
        bob.g.remove_revoked().map(|r| r.submit),
        Err(MlsError::NotOwner)
    ));
    assert!(!bob.g.has_pending());
    // Viewers are told they cannot edit at all.
    assert!(matches!(carol.g.reset_links(), Err(MlsError::NotEditor)));

    // What a modified client would send. The server refuses it, as bob has
    // no owner key to sign it with, and so would every member.
    let payload = bob.g.rotate(&[carol_leaf]).unwrap();
    assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
    ds.submit_unchecked(payload).unwrap();
    for client in [&mut alice, &mut carol, &mut dave] {
        let outcomes = client.sync(&ds);
        let [Outcome::Invalid(why)] = &outcomes[..] else {
            panic!("{}: {outcomes:?}", client.name);
        };
        assert!(why.contains("only the owner"), "{why}");
        assert_eq!(client.g.epoch(), epoch);
    }
    assert_eq!(alice.roster().len(), 4);
}

#[test]
fn owner_keys_kept_outside_the_group_are_taken_without_a_commit() {
    let (_, [laptop, mut phone, mut alice, _], _, _) = robert_owns();
    let epoch = phone.g.epoch();
    // Keys of some other group change nothing.
    let (_, [other, ..], _, _) = robert_owns();
    phone.g.keep_owner_secrets(other.g.owner_secrets());
    assert!(!phone.g.holds_owner_key());

    // The copies another device of the owner keeps, say in the directory.
    phone.g.keep_owner_secrets(laptop.g.owner_secrets());
    assert!(phone.g.holds_owner_key());
    assert_eq!(phone.g.owner_secret(), laptop.g.owner_secret());
    assert_eq!(phone.g.epoch(), epoch);

    // Holding the secret makes no owner of an editor.
    alice.g.keep_owner_secrets(laptop.g.owner_secrets());
    assert!(alice.g.owner_secret().is_some() && !alice.g.holds_owner_key());
}

#[test]
fn a_paired_device_of_the_owner_is_the_owner_and_gets_the_key_from_a_holder() {
    let (mut ds, [mut laptop, mut phone, mut alice, mut bob], _, robert) = robert_owns();
    let id = robert.graph.id();
    for observer in [&laptop, &phone, &alice, &bob] {
        assert_eq!(
            role_of(observer, "laptop"),
            Role::Owner,
            "{}",
            observer.name
        );
        assert_eq!(role_of(observer, "phone"), Role::Owner, "{}", observer.name);
        assert_eq!(
            role_of(observer, "alice"),
            Role::Editor,
            "{}",
            observer.name
        );
        assert_eq!(observer.g.owner_person(), Some(id), "{}", observer.name);
    }

    // The phone is an owner, but the owner key is still only the laptop's.
    let bob_leaf = phone.leaf_of("bob");
    assert!(!phone.g.holds_owner_key());
    assert!(matches!(
        phone.g.remove_and_rotate(&[bob_leaf]),
        Err(MlsError::NoOwnerKey)
    ));
    assert!(
        laptop
            .g
            .identity_step(&robert.graph, None)
            .unwrap()
            .share_owner_key
    );
    // Nobody else has a key to hand over.
    for client in [&phone, &alice] {
        assert!(
            !client
                .g
                .identity_step(&robert.graph, None)
                .unwrap()
                .share_owner_key
        );
    }
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice, &mut bob] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    assert!(phone.g.holds_owner_key());
    assert_eq!(phone.g.owner_secret(), laptop.g.owner_secret());
    assert!(!alice.g.holds_owner_key() && alice.g.owner_secret().is_none());
    // Handed over, there is nothing left to share, for either of them.
    for client in [&laptop, &phone] {
        assert!(
            !client
                .g
                .identity_step(&robert.graph, None)
                .unwrap()
                .share_owner_key
        );
    }

    let payload = phone.g.remove_and_rotate(&[bob_leaf]).unwrap();
    commit(&mut ds, &mut phone, payload).unwrap();
    for client in [&mut laptop, &mut alice] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Rotated(_)]));
    }
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Removed { .. }]));
    // Both stay owners through the rotation, with nothing to refresh.
    assert_eq!(role_of(&alice, "laptop"), Role::Owner);
    assert_eq!(role_of(&alice, "phone"), Role::Owner);
    let payload = laptop.g.reset_links().unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
    assert!(matches!(phone.sync(&ds)[..], [Outcome::Rotated(_)]));
}

#[test]
fn the_owner_tag_survives_rotations() {
    let (mut ds, [mut laptop, mut phone, ..], _, robert) = robert_owns();
    let tag = laptop.g.policy().unwrap().owner_tag;
    assert_eq!(
        tag,
        laptop.g.doc_keys().keyring().owner_tag(&robert.graph.id())
    );
    for _ in 0..2 {
        let payload = laptop.g.reset_links().unwrap();
        commit(&mut ds, &mut laptop, payload).unwrap();
    }
    phone.sync(&ds);
    for client in [&laptop, &phone] {
        assert_eq!(client.g.generation().unwrap(), 3);
        assert_eq!(client.g.policy().unwrap().owner_tag, tag);
        assert_eq!(client.g.owner_person(), Some(robert.graph.id()));
    }
    // A device that was away for both rotations is the owner right away.
    assert_eq!(role_of(&laptop, "phone"), Role::Owner);
    let payload = phone.g.reset_links().unwrap();
    commit(&mut ds, &mut phone, payload).unwrap();
}

#[test]
fn the_same_person_gets_another_tag_in_every_space() {
    let id = person();
    let (_, first, _) = space_with("one", &local(&id.device, &id.graph));
    let (_, second, _) = space_with("two", &local(&id.device, &id.graph));
    let (a, b) = (
        first.g.policy().unwrap().owner_tag,
        second.g.policy().unwrap().owner_tag,
    );
    assert_ne!(a, b);
    assert_ne!(a, id.graph.id());
    assert_eq!(first.g.owner_person(), Some(id.graph.id()));
    assert_eq!(second.g.owner_person(), Some(id.graph.id()));
}

#[test]
fn a_revoked_owner_device_loses_the_role_as_soon_as_any_leaf_carries_the_revoke() {
    let (mut ds, [mut laptop, mut phone, mut alice, mut bob], _, robert) = robert_owns();
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice, &mut bob] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    // The phone's own leaf still carries the old graph.
    for observer in [&laptop, &phone, &alice, &bob] {
        assert_eq!(
            role_of(observer, "laptop"),
            Role::Owner,
            "{}",
            observer.name
        );
        assert_eq!(
            role_of(observer, "phone"),
            Role::Editor,
            "{}",
            observer.name
        );
    }
    assert!(matches!(
        phone.g.remove_and_rotate(&[phone.leaf_of("bob")]),
        Err(MlsError::NotOwner)
    ));
    assert!(matches!(phone.g.reset_links(), Err(MlsError::NotOwner)));

    // A modified client in its place is refused by everyone.
    let epoch = alice.g.epoch();
    let payload = phone.g.rotate(&[phone.leaf_of("bob")]).unwrap();
    assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
    ds.submit_unchecked(payload).unwrap();
    for client in [&mut laptop, &mut alice, &mut bob] {
        let outcomes = client.sync(&ds);
        assert!(
            matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("only the owner")),
            "{}: {outcomes:?}",
            client.name
        );
        assert_eq!(client.g.epoch(), epoch);
    }
}

#[test]
fn a_mutual_revoke_leaves_no_owner() {
    let (mut ds, [mut laptop, mut phone, mut alice, mut bob], _, robert) = robert_owns();
    let mut by_laptop = robert.graph.clone();
    by_laptop
        .append(&robert.laptop, revoke(&robert.phone))
        .unwrap();
    let mut by_phone = robert.graph.clone();
    by_phone
        .append(&robert.phone, revoke(&robert.laptop))
        .unwrap();

    let payload = laptop
        .g
        .self_update(b"laptop", Some(&by_laptop), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice, &mut bob] {
        client.sync(&ds);
    }
    // The phone has lost the role by now, but may still refresh its leaf.
    let payload = phone
        .g
        .self_update(b"phone", Some(&by_phone), None)
        .unwrap();
    commit(&mut ds, &mut phone, payload);
    for client in [&mut laptop, &mut alice, &mut bob] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    for observer in [&laptop, &phone, &alice, &bob] {
        assert_eq!(
            role_of(observer, "laptop"),
            Role::Editor,
            "{}",
            observer.name
        );
        assert_eq!(
            role_of(observer, "phone"),
            Role::Editor,
            "{}",
            observer.name
        );
    }
    for client in [&mut laptop, &mut phone, &mut alice] {
        assert!(matches!(
            client.g.remove_and_rotate(&[client.leaf_of("bob")]),
            Err(MlsError::NotOwner)
        ));
        assert!(matches!(client.g.reset_links(), Err(MlsError::NotOwner)));
    }
    // Neither device is valid, so neither can clear out the other either.
    assert!(matches!(
        laptop.g.remove_revoked().map(|r| r.submit),
        Err(MlsError::NotOwner)
    ));
}

#[test]
fn forged_owners_cannot_act_as_owner() {
    // Each case joins a leaf that wants to pass for one of the owner's
    // devices and then tries to remove bob.
    enum Case {
        /// Another person altogether.
        Stranger,
        /// The laptop's identity, copied onto another leaf key.
        CopiedBinding,
        /// A device key that the owner's graph does not list.
        UnlistedDevice,
    }
    for case in [Case::Stranger, Case::CopiedBinding, Case::UnlistedDevice] {
        let (mut ds, [laptop, _, mut alice, _], link, robert) = robert_owns();
        let device = LeafKeys::generate();
        let identity = match case {
            Case::Stranger => {
                let stranger = person();
                let leaf = LeafIdentity {
                    binding: LeafBinding::new(&stranger.device, &device.signer_pub()),
                    graph: stranger.graph,
                };
                Some(leaf)
            }
            Case::CopiedBinding => laptop.g.own_identity_open(),
            Case::UnlistedDevice => Some(LeafIdentity {
                binding: LeafBinding::new(&DeviceKey::generate(), &device.signer_pub()),
                graph: robert.graph.clone(),
            }),
        }
        .unwrap();
        let keyring = Keyring::open_verified(&link, &ds.keyring).unwrap();
        let sealed = keyring
            .identity_key()
            .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT);
        let editor = editor_info(&device, &link, 1).unwrap();
        let (g, payload) = SpaceGroup::join_with(
            device,
            &link,
            ds.boot(),
            keyring,
            b"mallory",
            JoinOptions {
                editor: Some(editor),
                identity: Some(sealed),
                ..Default::default()
            },
        )
        .unwrap();
        ds.submit(payload).unwrap();
        let mut mallory = Client { name: "mallory", g };
        mallory.g.confirm_pending().unwrap();
        alice.sync(&ds);
        assert_eq!(role_of(&alice, "mallory"), Role::Editor);
        assert_eq!(role_of(&mallory, "laptop"), Role::Owner);
        assert!(matches!(
            mallory.g.remove_and_rotate(&[mallory.leaf_of("bob")]),
            Err(MlsError::NotOwner)
        ));

        let epoch = alice.g.epoch();
        let payload = mallory.g.rotate(&[mallory.leaf_of("bob")]).unwrap();
        assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
        ds.submit_unchecked(payload).unwrap();
        let outcomes = alice.sync(&ds);
        assert!(
            matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("only the owner")),
            "{outcomes:?}"
        );
        assert_eq!(alice.g.epoch(), epoch);
    }
}

#[test]
fn a_revoked_device_cannot_pad_its_stale_graph_past_the_caps() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice] {
        client.sync(&ds);
    }

    // Its stale branch, filled up to the cap with entries that do nothing.
    // Alone it is a fine graph; merged with the revoke it is one too many.
    let mut padded = robert.graph.clone();
    while padded.len() < crate::identity::MAX_GRAPH_ENTRIES {
        padded
            .append(&robert.phone, add(&DeviceKey::generate()))
            .unwrap();
    }
    assert!(revoked.clone().merge(&padded).is_err());
    let leaf_pub = phone.g.device().signer_pub();
    let identity = LeafIdentity {
        binding: LeafBinding::new(&robert.phone, &leaf_pub),
        graph: padded,
    };
    let epoch = alice.g.epoch();
    let payload = commit_identity(&mut phone, &identity);
    ds.submit(payload).unwrap();
    for client in [&mut laptop, &mut alice] {
        let outcomes = client.sync(&ds);
        assert!(
            matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("does not merge")),
            "{}: {outcomes:?}",
            client.name
        );
        assert_eq!(client.g.epoch(), epoch);
    }
    // Nothing changed for the others.
    assert_eq!(role_of(&alice, "phone"), Role::Editor);
    assert_eq!(role_of(&alice, "laptop"), Role::Owner);
}

#[test]
fn a_revoked_device_cannot_backdate_revokes_to_take_the_space() {
    let (mut ds, [mut laptop, mut phone, mut alice, mut bob], _, robert) = robert_owns();
    let recovery_key = DeviceKey::generate();
    let mut with_key = robert.graph.clone();
    with_key
        .append(
            &robert.laptop,
            EntryKind::AddDevice {
                device: recovery_key.public(),
                flags: crate::identity::FLAG_RECOVERY,
            },
        )
        .unwrap();
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&with_key), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    let mut revoked = with_key.clone();
    revoked
        .append(&recovery_key, revoke(&robert.phone))
        .unwrap();
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice, &mut bob] {
        client.sync(&ds);
    }

    // The stolen phone signs revokes of everything else on the head it knew
    // before its own revoke and carries them in its leaf.
    let mut backdated = with_key;
    backdated
        .append(&robert.phone, revoke(&robert.laptop))
        .unwrap();
    backdated
        .append(&robert.phone, revoke(&recovery_key))
        .unwrap();
    let leaf_pub = phone.g.device().signer_pub();
    let identity = LeafIdentity {
        binding: LeafBinding::new(&robert.phone, &leaf_pub),
        graph: backdated,
    };
    let payload = commit_identity(&mut phone, &identity);
    if ds.submit(payload).is_ok() {
        for client in [&mut laptop, &mut alice, &mut bob] {
            client.sync(&ds);
        }
    }
    let id = robert.graph.id();
    let tree = alice.g.person_graph(&id).unwrap();
    assert_eq!(
        tree.device_state(&robert.laptop.public()),
        DeviceState::Valid
    );
    assert_eq!(
        tree.device_state(&recovery_key.public()),
        DeviceState::Valid
    );
    assert_eq!(
        tree.device_state(&robert.phone.public()),
        DeviceState::Revoked
    );
    for observer in [&laptop, &alice, &bob] {
        assert_eq!(
            role_of(observer, "laptop"),
            Role::Owner,
            "{}",
            observer.name
        );
    }
    let step = laptop.g.identity_step(&revoked, None).unwrap();
    let stored = step.merged.unwrap_or(revoked);
    assert_eq!(
        stored.device_state(&robert.laptop.public()),
        DeviceState::Valid
    );
    let payload = laptop.g.remove_revoked().map(|r| r.submit).unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Rotated(_)]));
    assert_eq!(role_of(&alice, "laptop"), Role::Owner);
}

#[test]
fn an_unverified_leaf_adds_nothing_to_the_persons_graph() {
    let (mut ds, [mut alice, mut laptop, mut phone], link, robert) = two_devices();
    let id = robert.graph.id();
    // A copy of robert's graph filled up to the cap. An outsider could only
    // pad it with entries signed by keys of its own, which no graph takes,
    // so this signs them with robert's own laptop to get one that decodes.
    let mut padded = robert.graph.clone();
    while padded.len() < crate::identity::MAX_GRAPH_ENTRIES {
        padded
            .append(&robert.laptop, add(&DeviceKey::generate()))
            .unwrap();
    }
    let view = view_of(&link);
    let outsider = DeviceKey::generate();
    let leaf = LeafKeys::generate();
    let identity = LeafIdentity {
        binding: LeafBinding::new(&outsider, &leaf.signer_pub()),
        graph: padded,
    };
    let keyring = Keyring::open_verified(&view, &ds.keyring).unwrap();
    let sealed = keyring
        .identity_key()
        .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT);
    let (mut g, payload) = SpaceGroup::join_with(
        leaf,
        &view,
        ds.boot(),
        keyring,
        b"outsider",
        JoinOptions {
            identity: Some(sealed),
            ..Default::default()
        },
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    for client in [&mut alice, &mut laptop, &mut phone] {
        client.sync(&ds);
    }
    assert_eq!(person_of(&alice, "outsider"), Person::Unverified);
    assert_eq!(alice.g.person_graph(&id), Some(robert.graph.clone()));
    let graphs = graphs_in_group_info(&link, &ds.group_info, &ds.keyring).unwrap();
    assert_eq!(graphs.iter().find(|g| g.id() == id), Some(&robert.graph));

    // Robert's devices store nothing new and can still revoke.
    let step = laptop.g.identity_step(&robert.graph, None).unwrap();
    assert!(step.merged.is_none());
    assert!(!step.needs_refresh);
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(
        person_of(&alice, "phone"),
        verified(id, &robert.phone, true)
    );
}

#[test]
fn an_owner_whose_graphs_do_not_merge_has_no_owner_powers() {
    let (a, b, _, left, right) = forks();
    let (mut ds, mut creator, link) = space_with("a", &local(&a, &left));
    let mut on_b = join_as(&mut ds, &link, "b", &local(&b, &right));
    assert!(matches!(creator.sync(&ds)[..], [Outcome::Invalid(_)]));
    // The joiner has merged its own commit, and fails closed.
    for name in ["a", "b"] {
        assert_eq!(role_of(&on_b, name), Role::Editor, "{name}");
    }
    assert!(matches!(
        on_b.g.remove_and_rotate(&[on_b.leaf_of("a")]),
        Err(MlsError::NotOwner)
    ));
    assert_eq!(on_b.g.owner_person(), Some(left.id()));
}

#[test]
fn an_editor_leaves_its_revoked_device_to_the_owner() {
    let (mut ds, [mut alice, mut laptop, mut phone], _, robert) = two_devices();
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    alice.sync(&ds);
    phone.sync(&ds);
    assert_eq!(role_of(&alice, "laptop"), Role::Editor);

    // The revoke is in the tree, but robert is no owner here.
    let step = laptop.g.identity_step(&revoked, None).unwrap();
    assert!(step.revoked.is_empty() && !step.needs_refresh);
    assert!(matches!(
        laptop.g.remove_revoked().map(|r| r.submit),
        Err(MlsError::NotOwner)
    ));
    // What it would send without asking is no owner's rotation.
    let payload = laptop.g.rotate(&[phone.g.own_leaf()]).unwrap();
    assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
    laptop.g.discard_pending().unwrap();

    // Alice owns the space and removes it, along with any other revoked
    // device she sees. Her own graph has nothing to do with it.
    let step = alice
        .g
        .identity_step(&PersonGraph::genesis(&DeviceKey::generate()), None);
    assert_eq!(step.unwrap().revoked, vec![phone.g.own_leaf()]);
    let removal = alice.g.remove_revoked().unwrap();
    assert_eq!(removal.removed, vec![phone.g.own_leaf()]);
    commit(&mut ds, &mut alice, removal.submit).unwrap();
    assert!(matches!(laptop.sync(&ds)[..], [Outcome::Rotated(_)]));
    // The phone cannot follow the group any more, so this is how it hears
    // that it was revoked.
    assert!(matches!(
        &phone.sync(&ds)[..],
        [Outcome::Removed { person: Some(person) }] if *person == revoked
    ));
    for observer in [&alice, &laptop] {
        assert_eq!(observer.g.generation().unwrap(), 2);
        assert_eq!(observer.roster().len(), 2);
    }
    assert!(matches!(
        alice.g.remove_revoked().map(|r| r.submit),
        Err(MlsError::NothingRevoked)
    ));
}

#[test]
fn an_owner_can_carry_the_revoke_in_the_commit_that_removes() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let revoked = phone_revoked(&robert);
    let identity = laptop.g.extended_identity(&revoked).unwrap();
    let phone_leaf = phone.g.own_leaf();
    let payload = laptop.g.rotate_with(&[phone_leaf], Some(identity)).unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Rotated(_)]));
    assert!(matches!(
        &phone.sync(&ds)[..],
        [Outcome::Removed { person: Some(person) }] if *person == revoked
    ));
    assert_eq!(alice.g.person_graph(&robert.graph.id()), Some(revoked));
}

#[test]
fn an_editor_cannot_remove_what_its_person_has_not_revoked() {
    // Every case is a commit a modified client would make, since the API
    // refuses them before they are sent.
    let refused = |ds: &Ds, observers: &mut [&mut Client]| {
        let epoch = observers[0].g.epoch();
        for client in observers.iter_mut() {
            let outcomes = client.sync(ds);
            assert!(
                matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("only the owner")),
                "{}: {outcomes:?}",
                client.name
            );
            assert_eq!(client.g.epoch(), epoch);
        }
    };

    // Its own device, while the graph still lists it as valid.
    let (mut ds, [mut alice, mut laptop, phone], _, _) = two_devices();
    assert!(matches!(
        laptop.g.remove_and_rotate(&[phone.g.own_leaf()]),
        Err(MlsError::NotOwner)
    ));
    let payload = laptop.g.rotate(&[phone.g.own_leaf()]).unwrap();
    assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
    ds.submit_unchecked(payload).unwrap();
    refused(&ds, &mut [&mut alice]);

    // A revoked device of somebody else.
    let (mut ds, mut alice, link) = space();
    let (robert, sara) = (person_pair(), person_pair());
    let mut laptop = join_as(&mut ds, &link, "laptop", &local(&robert.0, &robert.2));
    let mut s1 = join_as(&mut ds, &link, "s1", &local(&sara.0, &sara.2));
    let s2 = join_as(&mut ds, &link, "s2", &local(&sara.1, &sara.2));
    let mut sara_revoked = sara.2.clone();
    sara_revoked.append(&sara.0, revoke(&sara.1)).unwrap();
    for client in [&mut alice, &mut laptop, &mut s1] {
        client.sync(&ds);
    }
    let payload = s1.g.self_update(b"s1", Some(&sara_revoked), None).unwrap();
    commit(&mut ds, &mut s1, payload);
    for client in [&mut alice, &mut laptop] {
        client.sync(&ds);
    }
    assert_eq!(
        person_of(&laptop, "s2"),
        verified(sara.2.id(), &sara.1, true)
    );
    let payload = laptop.g.rotate(&[s2.g.own_leaf()]).unwrap();
    assert_eq!(ds.submit_checked(payload.clone()), Err(Refused::NotOwner));
    ds.submit_unchecked(payload).unwrap();
    refused(&ds, &mut [&mut alice, &mut s1]);
}

/// Two devices and their graph.
fn person_pair() -> (DeviceKey, DeviceKey, PersonGraph) {
    let (first, second) = (DeviceKey::generate(), DeviceKey::generate());
    let mut graph = PersonGraph::genesis(&first);
    graph.append(&first, add(&second)).unwrap();
    (first, second, graph)
}

#[test]
fn an_editor_cannot_remove_without_rotating() {
    let (mut ds, [mut alice, mut laptop, mut phone], _, robert) = two_devices();
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut alice, &mut phone] {
        client.sync(&ds);
    }

    // The phone is revoked, so the removal is deserved, but a removal that
    // leaves the links as they are lets the removed device keep them.
    let epoch = laptop.g.epoch();
    let signer = laptop.g.device.signature_pair();
    let bundle = laptop
        .g
        .group
        .commit_builder()
        .propose_removals(vec![phone.g.group.own_leaf_index()])
        .load_psks(laptop.g.provider.storage())
        .unwrap()
        .build(
            laptop.g.provider.rand(),
            laptop.g.provider.crypto(),
            &signer,
            |_| true,
        )
        .unwrap()
        .stage_commit(&laptop.g.provider)
        .unwrap();
    let payload = SubmitPayload {
        epoch,
        commit: bundle.commit().tls_serialize_detached().unwrap(),
        group_info: Vec::new(),
        keyring: None,
        envelope: None,
        rotate: None,
    };
    let scratch = with_commit(&ds, payload);
    let outcomes = alice.sync(&scratch);
    assert!(
        matches!(&outcomes[..], [Outcome::Invalid(why)] if why.contains("only the owner")),
        "{outcomes:?}"
    );
}

#[test]
fn an_owner_removes_a_revoked_device_like_anyone_else() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let revoked = phone_revoked(&robert);
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice] {
        client.sync(&ds);
    }
    let payload = laptop.g.remove_revoked().map(|r| r.submit).unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Rotated(_)]));
    assert!(matches!(phone.sync(&ds)[..], [Outcome::Removed { .. }]));
    assert_eq!(role_of(&alice, "laptop"), Role::Owner);
}

#[test]
fn a_reset_keeps_the_owner_tag_and_the_owner_comes_back_as_owner() {
    let owner = person();
    let (mut ds, mut alice, link) = space_with("alice", &local(&owner.device, &owner.graph));
    let mut bob = join(&mut ds, &link, "bob");
    let mut carol = join(&mut ds, &view_of(&link), "carol");
    for client in [&mut alice, &mut bob] {
        client.sync(&ds);
    }
    carol.sync(&ds);
    let pinned = alice.g.owner_person().unwrap();
    assert_eq!(pinned, owner.graph.id());
    let tag = alice.g.policy().unwrap().owner_tag;

    // A viewer's commit stalls everybody.
    let payload = carol.g.commit_leaf(None, b"carol", None, None).unwrap();
    ds.submit(payload).unwrap();
    for client in [&mut alice, &mut bob] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Invalid(_)]));
    }

    let (fresh, payload) = bob.g.reset(b"bob", None).unwrap();
    assert_eq!(fresh.policy().unwrap().owner_tag, tag);
    assert_eq!(fresh.owner_person(), None, "nobody of the owner is in yet");
    assert!(fresh.owner_secret().is_none());
    let mut ds = ds.after_reset(&payload);
    let mut bob = Client {
        name: "bob",
        g: fresh,
    };

    // The owner rejoins with the same device, the pin it made at the start
    // and the owner key it held. Nothing but its identity makes it the
    // owner again, and nothing but the key lets it rotate.
    let (mut joined, join) = SpaceGroup::join_external_as(
        alice.g.device().duplicate(),
        &link,
        ds.boot(),
        b"alice",
        Some(&local(&owner.device, &owner.graph)),
        Some(pinned),
        Some(&alice.g),
        &OwnerSecrets::default(),
    )
    .unwrap();
    ds.submit(join).unwrap();
    joined.confirm_pending().unwrap();
    let mut alice = Client {
        name: "alice",
        g: joined,
    };
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Advanced]));
    assert_eq!(role_of(&bob, "alice"), Role::Owner);
    assert_eq!(role_of(&bob, "bob"), Role::Editor);
    assert_eq!(alice.g.owner_person(), Some(pinned));
    assert!(alice.g.holds_owner_key());

    // And rejoined, it can still remove people and rotate.
    let bob_leaf = alice.leaf_of("bob");
    let payload = alice.g.remove_and_rotate(&[bob_leaf]).unwrap();
    commit(&mut ds, &mut alice, payload).unwrap();
    assert!(matches!(bob.sync(&ds)[..], [Outcome::Removed { .. }]));
}

#[test]
fn groups_of_another_owner_than_the_pinned_one_are_refused() {
    let (ds, alice, link) = space();
    let pinned = alice.g.owner_person().unwrap();
    let mallory = person();
    let keyring = Keyring::new(&link);
    let policy = Policy::new(link.attest_pub(), keyring.owner_tag(&mallory.graph.id()));
    let device = LeafKeys::generate();
    let sealed = seal_identity(&keyring, &device, &mallory).unwrap();
    let (_g, info, keyring) = SpaceGroup::start(
        device,
        &link,
        keyring,
        policy,
        group_id_of(&[7; SPACE_ID_LEN], 1),
        b"mallory",
        Some(sealed),
        (OwnerSecrets::default(), None),
    )
    .unwrap();
    let join = |pinned: Option<PersonId>| {
        SpaceGroup::join_external_as(
            alice.g.device().duplicate(),
            &link,
            Bootstrap {
                group_info: &info,
                keyring: &keyring,
                owner_key: &ds.owner_key,
            },
            b"alice",
            None,
            pinned,
            None,
            &OwnerSecrets::default(),
        )
    };
    // A reset-looking group whose owner is somebody else.
    assert!(matches!(
        join(Some(pinned)),
        Err(MlsError::OwnerChanged(why)) if why.contains("pinned")
    ));
    // Whoever has no pin yet takes the first owner it sees, and the pin of
    // that owner fits.
    assert!(join(None).is_ok());
    assert!(join(Some(mallory.graph.id())).is_ok());

    // The real group takes the real pin.
    assert!(SpaceGroup::join_external(&link, ds.boot(), b"bob", None, Some(pinned)).is_ok());
}

#[test]
fn saved_state_keeps_a_rotation_waiting_for_the_server() {
    let (mut ds, [mut alice, bob, ..], _) = team();
    let loaded = SpaceGroup::import_state(&alice.g.export_state()).unwrap();
    assert_eq!(loaded.owner_person(), alice.g.owner_person());
    assert!(
        SpaceGroup::import_state(&bob.g.export_state())
            .unwrap()
            .owner_person()
            .is_some()
    );

    // The Accepted reply may be lost, and the new link exists nowhere else.
    let leaf = alice.leaf_of("carol");
    let staged = alice.g.remove_and_rotate(&[leaf]).unwrap();
    let mut reloaded = SpaceGroup::import_state(&alice.g.export_state()).unwrap();
    assert_eq!(reloaded.pending_submit(), Some(&staged));
    assert_eq!(reloaded.export_state(), alice.g.export_state());
    assert_eq!(reloaded.owner_secret(), alice.g.owner_secret());
    let next_key = staged.rotate.as_ref().unwrap().next_owner_key;
    ds.submit(staged).unwrap();
    let rotation = reloaded.confirm_pending().unwrap().unwrap();
    assert_eq!(reloaded.link().to_base64url(), rotation.link.to_base64url());
    assert_eq!(reloaded.owner_person(), alice.g.owner_person());
    assert_eq!(
        reloaded.owner_secret().map(OwnerSecret::public),
        Some(next_key)
    );

    let again = SpaceGroup::import_state(&reloaded.export_state()).unwrap();
    assert_eq!(again.generation().unwrap(), 2);
    assert_eq!(again.owner_secret(), reloaded.owner_secret());
    assert!(again.holds_owner_key());
    // A member without the key saves none.
    assert!(
        SpaceGroup::import_state(&bob.g.export_state())
            .unwrap()
            .owner_secret()
            .is_none()
    );
}

/// A person with a laptop and a recovery device, and the profile "Ada".
fn person_with_recovery() -> (LocalIdentity, DeviceKey) {
    let laptop = person();
    let recovery_key = DeviceKey::generate();
    let mut graph = laptop.graph.clone();
    graph
        .append(
            &laptop.device,
            EntryKind::AddDevice {
                device: recovery_key.public(),
                flags: crate::identity::FLAG_RECOVERY,
            },
        )
        .unwrap();
    graph
        .append(
            &laptop.device,
            EntryKind::SetProfile {
                profile: br#"{"name":"Ada"}"#.to_vec(),
            },
        )
        .unwrap();
    (
        LocalIdentity {
            device: laptop.device,
            graph,
        },
        recovery_key,
    )
}

#[test]
fn a_recovery_device_cannot_create_or_join() {
    let (laptop, recovery_key) = person_with_recovery();
    let as_recovery = local(&recovery_key, &laptop.graph);

    let link = LinkSecret::generate_edit();
    assert!(matches!(
        SpaceGroup::create(&link, b"x", &as_recovery),
        Err(MlsError::Identity(GraphError::NotValid))
    ));

    let (ds, alice, link) = space_with("laptop", &laptop);
    assert!(matches!(
        SpaceGroup::join_external(&link, ds.boot(), b"recovery", Some(&as_recovery), None,),
        Err(MlsError::Identity(GraphError::NotValid))
    ));
    assert!(ds.log.is_empty());

    // A reset with it is refused as well.
    assert!(matches!(
        alice.g.reset(b"x", Some(&as_recovery)),
        Err(MlsError::Identity(GraphError::NotValid))
    ));
}

#[test]
fn a_leaf_bound_to_a_recovery_device_is_unverified_and_never_owner() {
    let (laptop, recovery_key) = person_with_recovery();
    let (mut ds, mut alice, link) = space_with("laptop", &laptop);

    // A modified client binds its leaf to the recovery device.
    let device = LeafKeys::generate();
    let identity = LeafIdentity {
        binding: LeafBinding::new(&recovery_key, &device.signer_pub()),
        graph: laptop.graph.clone(),
    };
    let keyring = Keyring::open_verified(&link, &ds.keyring).unwrap();
    let sealed = keyring
        .identity_key()
        .seal(&identity.encode(), IDENTITY_SEAL_CONTEXT);
    let editor = editor_info(&device, &link, 1).unwrap();
    let (g, payload) = SpaceGroup::join_with(
        device,
        &link,
        ds.boot(),
        keyring,
        b"recovery",
        JoinOptions {
            editor: Some(editor),
            identity: Some(sealed),
            ..Default::default()
        },
    )
    .unwrap();
    ds.submit(payload).unwrap();
    let mut forged = Client {
        name: "recovery",
        g,
    };
    forged.g.confirm_pending().unwrap();
    alice.sync(&ds);

    for observer in [&alice, &forged] {
        assert_eq!(person_of(observer, "recovery"), Person::Unverified);
        assert_eq!(role_of(observer, "recovery"), Role::Editor);
        assert_eq!(role_of(observer, "laptop"), Role::Owner);
    }
    assert!(alice.g.leaves_of(&laptop.graph.id()).unwrap().is_empty());
    assert!(matches!(
        forged.g.remove_and_rotate(&[forged.leaf_of("laptop")]),
        Err(MlsError::NotOwner)
    ));
}

#[test]
fn members_carry_the_persons_profile() {
    let (laptop, _) = person_with_recovery();
    let (mut ds, mut alice, link) = space_with("laptop", &laptop);
    join(&mut ds, &link, "bob");
    alice.sync(&ds);
    let members = alice.g.members().unwrap();
    let profile_of = |name: &str| {
        members
            .iter()
            .find(|m| m.profile.as_deref() == Some(name.as_bytes()))
            .unwrap()
            .person_profile
            .clone()
    };
    assert_eq!(profile_of("laptop"), Some(br#"{"name":"Ada"}"#.to_vec()));
    assert_eq!(profile_of("bob"), None);
}

#[test]
fn graphs_are_read_from_a_group_info_without_joining() {
    let (mut ds, [alice, _laptop, _phone], link, robert) = two_devices();
    let mut longer = robert.graph.clone();
    longer
        .append(&robert.laptop, add(&DeviceKey::generate()))
        .unwrap();
    let mut laptop_again = Client {
        name: "laptop",
        g: SpaceGroup::join_external(
            &link,
            ds.boot(),
            b"laptop",
            Some(&local(&robert.laptop, &longer)),
            None,
        )
        .map(|(g, payload)| {
            ds.submit(payload).unwrap();
            g
        })
        .unwrap(),
    };
    laptop_again.g.confirm_pending().unwrap();

    let before = ds.log.len();
    let graphs = graphs_in_group_info(&link, &ds.group_info, &ds.keyring).unwrap();
    assert_eq!(ds.log.len(), before);
    let ids: Vec<_> = graphs.iter().map(PersonGraph::id).collect();
    assert!(ids.contains(&robert.graph.id()));
    assert!(ids.contains(&alice.g.owner_person().unwrap()));
    let merged = graphs.iter().find(|g| g.id() == robert.graph.id()).unwrap();
    assert!(merged.is_superset_of(&longer));

    let other = LinkSecret::generate_edit();
    assert!(graphs_in_group_info(&other, &ds.group_info, &ds.keyring).is_err());
}

#[test]
fn the_identity_step_refreshes_then_removes_the_revoked_leaves() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let id = robert.graph.id();
    let revoked = phone_revoked(&robert);
    let phone_leaf = phone.g.own_leaf();
    // Catch the laptop's leaf up and hand the phone the key first, so only
    // the revoke is left to do.
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&robert.graph), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    phone.sync(&ds);
    alice.sync(&ds);

    let step = laptop.g.identity_step(&robert.graph, None).unwrap();
    assert_eq!(
        step,
        IdentityStep {
            merged: None,
            needs_refresh: false,
            rejoin: false,
            revoked: Vec::new(),
            share_owner_key: false,
        }
    );

    // The revoke is only local: refresh first, nothing to remove yet.
    let step = laptop.g.identity_step(&revoked, None).unwrap();
    assert_eq!(step.merged, None);
    assert!(step.needs_refresh);
    assert!(step.revoked.is_empty());
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut alice, &mut phone] {
        client.sync(&ds);
    }

    let step = laptop.g.identity_step(&revoked, None).unwrap();
    assert!(!step.needs_refresh);
    assert_eq!(step.revoked, vec![phone_leaf]);
    // A revoked device is no owner and gets no share, so there is nothing
    // to hand over.
    assert!(!step.share_owner_key);

    // The phone learns of its own revoke from the tree, and has nobody to
    // remove, being no owner any more, though it still holds the old key.
    let step = phone.g.identity_step(&robert.graph, None).unwrap();
    assert_eq!(step.merged.as_ref(), Some(&revoked));
    assert!(step.needs_refresh);
    assert!(step.revoked.is_empty());
    assert!(phone.g.owner_secret().is_some() && !phone.g.holds_owner_key());
    // An editor sees the revoked leaf too, but leaves it to the owner.
    assert_eq!(alice.g.revoked_leaves(), vec![phone_leaf]);
    let step = alice.g.identity_step(&revoked, None).unwrap();
    assert_eq!(step.merged, None);
    assert!(!step.needs_refresh);
    assert!(step.revoked.is_empty());

    let removal = laptop.g.remove_revoked().unwrap();
    assert_eq!(removal.removed, vec![phone_leaf]);
    commit(&mut ds, &mut laptop, removal.submit);
    assert!(matches!(phone.sync(&ds)[..], [Outcome::Removed { .. }]));
    assert!(
        laptop
            .g
            .identity_step(&revoked, None)
            .unwrap()
            .revoked
            .is_empty()
    );
    assert!(matches!(
        laptop.g.remove_revoked(),
        Err(MlsError::NothingRevoked)
    ));
    assert_eq!(laptop.g.person_graph(&id), Some(revoked));
}

#[test]
fn the_identity_step_merges_what_the_tree_adds() {
    let (_, [_, laptop, _], _, robert) = two_devices();
    let alone = PersonGraph::genesis(&robert.laptop);
    let mut extra = alone.clone();
    let tablet = DeviceKey::generate();
    extra.append(&robert.laptop, add(&tablet)).unwrap();

    // The tree knows the phone, the local graph the tablet: both go in.
    let step = laptop.g.identity_step(&extra, None).unwrap();
    let merged = step.merged.unwrap();
    assert!(merged.is_superset_of(&extra) && merged.is_superset_of(&robert.graph));
    assert!(step.needs_refresh);
}

#[test]
fn the_identity_step_reports_a_graph_that_does_not_merge() {
    let (mut ds, _, link) = space();
    let (a, _, _, left, right) = forks();
    let on_a = join_as(&mut ds, &link, "a", &local(&a, &left));
    assert!(matches!(
        on_a.g.identity_step(&right, None),
        Err(MlsError::Identity(GraphError::TooLarge))
    ));
}

#[test]
fn a_device_that_switched_persons_rejoins_as_the_new_one() {
    let (mut ds, [mut alice, mut laptop, mut phone], link, robert) = two_devices();
    // A third machine of robert's opened the link before it was paired, so
    // it joined as a person of its own.
    let desk_key = DeviceKey::generate();
    let alone = PersonGraph::genesis(&desk_key);
    let mut desk = join_as(&mut ds, &link, "desk", &local(&desk_key, &alone));
    for client in [&mut alice, &mut laptop, &mut phone] {
        client.sync(&ds);
    }
    let members = alice.roster().len();
    assert_eq!(
        person_of(&alice, "desk"),
        verified(alone.id(), &desk_key, false)
    );
    assert!(!desk.g.identity_step(&alone, None).unwrap().rejoin);

    // Pairing makes it one of robert's devices.
    let mut paired = robert.graph.clone();
    paired.append(&robert.laptop, add(&desk_key)).unwrap();
    let step = desk.g.identity_step(&paired, None).unwrap();
    assert!(step.rejoin);
    assert!(!step.needs_refresh);
    assert!(!laptop.g.identity_step(&paired, None).unwrap().rejoin);
    // A graph that does not list the leaf's device is not a reason to move.
    assert!(!desk.g.identity_step(&robert.graph, None).unwrap().rejoin);

    let (mut g, payload) = SpaceGroup::join_external_as(
        desk.g.device().duplicate(),
        &link,
        ds.boot(),
        b"desk",
        Some(&local(&desk_key, &paired)),
        None,
        Some(&desk.g),
        &OwnerSecrets::default(),
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    let rejoined = Client { name: "desk", g };
    for client in [&mut alice, &mut laptop, &mut phone] {
        assert!(
            matches!(client.sync(&ds)[..], [Outcome::Advanced]),
            "{}",
            client.name
        );
        assert_eq!(client.roster().len(), members, "{}", client.name);
        assert_eq!(
            person_of(client, "desk"),
            verified(robert.graph.id(), &desk_key, false),
            "{}",
            client.name
        );
    }
    assert!(!rejoined.g.identity_step(&paired, None).unwrap().rejoin);
    assert!(matches!(desk.sync(&ds)[..], [Outcome::Removed { .. }]));
}

// The owner key: what the server checks rotations against, and how it gets
// from one owner device to the next.

/// Robert owns the space and has three devices in it: the laptop that
/// created it and holds the owner key, and a phone and a tablet paired
/// later, which have been handed the key. Alice edits. All caught up.
fn robert_with_tablet() -> (Ds, [Client; 4], LinkSecret, Robert, DeviceKey) {
    let (mut ds, [mut laptop, mut phone, mut alice, _bob], link, mut robert) = robert_owns();
    let tablet_key = DeviceKey::generate();
    robert
        .graph
        .append(&robert.laptop, add(&tablet_key))
        .unwrap();
    let mut tablet = join_as(&mut ds, &link, "tablet", &local(&tablet_key, &robert.graph));
    for client in [&mut laptop, &mut phone, &mut alice] {
        client.sync(&ds);
    }
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&robert.graph), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut alice, &mut tablet] {
        client.sync(&ds);
    }
    for client in [&laptop, &phone, &tablet] {
        assert!(client.g.holds_owner_key(), "{}", client.name);
    }
    (ds, [laptop, phone, tablet, alice], link, robert, tablet_key)
}

/// The owner key shares in `observer`'s view of `name`'s leaf.
fn shares_of(observer: &Client, name: &str) -> Option<OwnerShares> {
    let leaf = observer.leaf_of(name);
    read_owner_shares(
        observer
            .g
            .group
            .public_group()
            .leaf(LeafNodeIndex::new(leaf))?,
    )
}

#[test]
fn the_creator_holds_the_owner_key_the_server_is_given() {
    let link = LinkSecret::generate_edit();
    let me = person();
    let (g, payload) = SpaceGroup::create(&link, b"me", &me).unwrap();
    let owner = g.owner_secret().unwrap();
    assert_eq!(payload.owner_key, owner.public());
    assert_eq!(g.owner_key(), Some(owner.public()));
    assert!(g.holds_owner_key());
    assert!(matches!(
        payload.into_message(1),
        ClientMessage::Init { owner_key, .. } if owner_key == owner.public()
    ));
    // Both survive a save.
    let loaded = SpaceGroup::import_state(&g.export_state()).unwrap();
    assert_eq!(loaded.owner_key(), g.owner_key());
    assert_eq!(loaded.owner_secret(), g.owner_secret());
    assert!(loaded.holds_owner_key());
}

#[test]
fn rotations_are_signed_with_the_current_key_and_chain() {
    let (mut ds, [mut alice, mut bob, ..], _) = team();
    let first = alice.g.owner_secret().unwrap().clone();
    assert_eq!(bob.g.owner_key(), Some(first.public()));

    // A rotation that loses the epoch keeps the key it would have replaced.
    let payload = alice.g.reset_links().unwrap();
    alice.g.discard_pending().unwrap();
    assert_eq!(alice.g.owner_secret(), Some(&first));
    assert_eq!(alice.g.owner_key(), Some(first.public()));
    assert_eq!(ds.owner_key, first.public());
    let rotate = payload.rotate.unwrap();
    assert_ne!(rotate.next_owner_key, first.public());

    let payload = alice.g.reset_links().unwrap();
    let rotate = payload.rotate.clone().unwrap();
    let claim = RotationClaim {
        group_id: &ds.group_id,
        epoch: payload.epoch,
        commit: &payload.commit,
        group_info: &payload.group_info,
        keyring: payload.keyring.as_deref().unwrap(),
        envelope: payload.envelope.as_deref().unwrap(),
        edit_token: &rotate.edit_token,
        view_token: &rotate.view_token,
        next_owner_key: &rotate.next_owner_key,
    };
    assert!(verify_rotation(
        &first.public(),
        &claim,
        &rotate.owner_proof
    ));
    commit(&mut ds, &mut alice, payload).unwrap();
    let second = alice.g.owner_secret().unwrap().clone();
    assert_eq!(second.public(), rotate.next_owner_key);
    assert_eq!(ds.owner_key, second.public());
    assert_eq!(alice.g.owner_key(), Some(second.public()));
    // A member that follows the log learns the new key from the server.
    bob.sync(&ds);
    assert_eq!(bob.g.owner_key(), Some(second.public()));

    // The next one is signed with the second key, which the fake server,
    // like the real one, now expects.
    let payload = alice.g.reset_links().unwrap();
    commit(&mut ds, &mut alice, payload).unwrap();
    assert_eq!(alice.g.owner_key(), Some(ds.owner_key));
    assert_ne!(ds.owner_key, second.public());

    // A device that kept the first key cannot sign with it any more.
    let mut stale = SpaceGroup::import_state(&alice.g.export_state()).unwrap();
    stale.owner = held([first]);
    assert!(!stale.holds_owner_key());
    assert!(matches!(stale.reset_links(), Err(MlsError::NoOwnerKey)));
    let forged = stale.rotate(&[]).unwrap();
    assert_eq!(ds.submit_checked(forged), Err(Refused::NotOwner));
}

#[test]
fn concurrent_owner_rotations_leave_the_loser_with_the_winners_key() {
    let (mut ds, [mut laptop, mut phone, mut tablet, mut alice], ..) = robert_with_tablet();
    let a = laptop.g.reset_links().unwrap();
    let b = phone.g.reset_links().unwrap();
    commit(&mut ds, &mut laptop, a).unwrap();
    assert_eq!(ds.submit_checked(b), Err(Refused::Conflict(ds.head())));
    // The loser hears of the winner before or instead of the Conflict.
    assert!(matches!(phone.sync(&ds)[..], [Outcome::Rotated(_)]));
    for client in [&mut tablet, &mut alice] {
        client.sync(&ds);
    }
    for client in [&phone, &tablet] {
        assert!(client.g.holds_owner_key(), "{}", client.name);
        assert_eq!(client.g.owner_secret(), laptop.g.owner_secret());
    }
    assert!(alice.g.owner_secret().is_none());
    let payload = phone.g.reset_links().unwrap();
    commit(&mut ds, &mut phone, payload).unwrap();
}

#[test]
fn a_rotation_hands_the_next_key_to_the_remaining_owner_devices_only() {
    let (mut ds, [mut laptop, mut phone, mut tablet, mut alice], _, robert, tablet_key) =
        robert_with_tablet();
    // The tablet is revoked, but its leaf is still in the tree.
    let mut revoked = robert.graph.clone();
    revoked.append(&robert.laptop, revoke(&tablet_key)).unwrap();
    let payload = laptop
        .g
        .self_update(b"laptop", Some(&revoked), None)
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    for client in [&mut phone, &mut tablet, &mut alice] {
        client.sync(&ds);
    }
    let shares = shares_of(&alice, "laptop").unwrap();
    assert!(shares.covers_leaf(&phone.g.device().signer_pub()));
    assert!(!shares.covers_leaf(&tablet.g.device().signer_pub()));

    // A link reset leaves the revoked tablet out of the next key.
    let first = laptop.g.owner_secret().cloned();
    let payload = laptop.g.reset_links().unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
    for client in [&mut phone, &mut tablet, &mut alice] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Rotated(_)]));
    }
    assert!(phone.g.holds_owner_key());
    assert_eq!(phone.g.owner_secret(), laptop.g.owner_secret());
    // The tablet keeps the one it had, which signs nothing any more.
    let first = first.unwrap();
    assert!(tablet.g.owner_secret().is_none());
    assert_eq!(tablet.g.owner_secrets().find(&first.public()), Some(&first));
    assert!(!tablet.g.holds_owner_key());

    // Removing the phone leaves it no share of the key after.
    let second = laptop.g.owner_secret().cloned();
    let payload = laptop.g.remove_and_rotate(&[phone.g.own_leaf()]).unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
    assert!(matches!(phone.sync(&ds)[..], [Outcome::Removed { .. }]));
    alice.sync(&ds);
    let shares = shares_of(&alice, "laptop");
    assert!(shares.is_none_or(|s| !s.covers_leaf(&phone.g.device().signer_pub())));
    let second = second.unwrap();
    assert!(phone.g.owner_secret().is_none());
    assert_eq!(phone.g.owner_secrets().iter().next(), Some(&second));
    assert_ne!(laptop.g.owner_secret(), Some(&second));
}

/// Owner key shares from `client`'s leaf for `to`, of `secret`.
fn forged_shares(client: &Client, secret: &OwnerSecret, to: &Client) -> Vec<u8> {
    let scope = ShareScope {
        group_id: &client.g.group_id,
        sender: &client.g.device().signer_pub(),
    };
    let recipient = Recipient {
        signer: to.g.device().signer_pub(),
        hpke_pub: to.g.device().hpke_pub().to_vec(),
    };
    OwnerShares::seal(
        client.g.provider.crypto(),
        &scope,
        secret,
        std::slice::from_ref(&recipient),
        &[],
    )
    .encode()
}

/// `client` commits its own leaf again, with `shares` in place of the ones
/// it would put there.
fn commit_shares(ds: &mut Ds, client: &mut Client, link: &LinkSecret, shares: Vec<u8>) {
    let generation = client.g.generation().unwrap();
    let editor = editor_info(client.g.device(), link, generation).unwrap();
    let identity = client.g.own_identity();
    let payload = client
        .g
        .commit_leaf_with(
            Some(editor),
            client.name.as_bytes(),
            identity,
            Some(shares),
            None,
        )
        .unwrap();
    commit(ds, client, payload);
}

#[test]
fn shares_of_a_key_the_server_does_not_hold_are_ignored() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], link, _) = robert_owns();

    // Alice is an editor and hands the phone a key of her own making.
    let shares = forged_shares(&alice, &OwnerSecret::generate(), &phone);
    commit_shares(&mut ds, &mut alice, &link, shares);
    for client in [&mut laptop, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    assert!(phone.g.owner_secret().is_none());

    // The laptop is an owner, but what it puts in is not the server's key.
    let shares = forged_shares(&laptop, &OwnerSecret::generate(), &phone);
    commit_shares(&mut ds, &mut laptop, &link, shares);
    for client in [&mut alice, &mut phone] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    assert!(phone.g.owner_secret().is_none());
    // Neither stops the real share from getting through.
    assert!(
        laptop
            .g
            .identity_step(&laptop_graph(&laptop), None)
            .unwrap()
            .share_owner_key
    );
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    phone.sync(&ds);
    assert!(phone.g.holds_owner_key());
}

#[test]
fn a_stolen_owner_device_cannot_plant_a_key_of_its_own() {
    let (mut ds, [mut laptop, mut phone, mut tablet, mut alice], link, mut robert, _) =
        robert_with_tablet();
    // A desk is paired and joins; nobody has handed it the key yet.
    let desk_key = DeviceKey::generate();
    robert.graph.append(&robert.laptop, add(&desk_key)).unwrap();
    let mut desk = join_as(&mut ds, &link, "desk", &local(&desk_key, &robert.graph));
    for client in [&mut laptop, &mut phone, &mut tablet, &mut alice] {
        client.sync(&ds);
    }
    assert_eq!(role_of(&alice, "desk"), Role::Owner);
    assert!(!desk.g.holds_owner_key());

    // The tablet, in a thief's hands but not yet revoked, gets there first
    // with a key of its own making.
    let fake = OwnerSecret::generate();
    let shares = forged_shares(&tablet, &fake, &desk);
    commit_shares(&mut ds, &mut tablet, &link, shares);
    for client in [&mut laptop, &mut phone, &mut desk, &mut alice] {
        assert!(matches!(client.sync(&ds)[..], [Outcome::Advanced]));
    }
    assert!(desk.g.owner_secret().is_none());

    // Even a device that somehow came to hold the fake one takes the real
    // key over it once an owner device hands that over.
    desk.g.owner = held([fake.clone()]);
    assert!(!desk.g.holds_owner_key());
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    desk.sync(&ds);
    assert!(desk.g.holds_owner_key());
    assert_eq!(desk.g.owner_secret(), laptop.g.owner_secret());
    let payload = desk.g.reset_links().unwrap();
    commit(&mut ds, &mut desk, payload).unwrap();
}

/// The graph a client's own leaf carries.
fn laptop_graph(client: &Client) -> PersonGraph {
    client.g.own_identity_open().unwrap().graph
}

#[test]
fn a_rejoining_owner_device_keeps_or_finds_its_key() {
    let (mut ds, [mut laptop, phone, mut tablet, mut alice], link, robert, tablet_key) =
        robert_with_tablet();
    // Without the key, after losing its state: the share the laptop sealed
    // to the same leaf key is still in the tree.
    let (mut g, payload) = SpaceGroup::join_external_as(
        tablet.g.device().duplicate(),
        &link,
        ds.boot(),
        b"tablet",
        Some(&local(&tablet_key, &robert.graph)),
        None,
        None,
        &OwnerSecrets::default(),
    )
    .unwrap();
    assert!(g.holds_owner_key());
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    assert_eq!(g.owner_secret(), phone.g.owner_secret());
    assert!(matches!(tablet.sync(&ds)[..], [Outcome::Removed { .. }]));
    for client in [&mut laptop, &mut alice] {
        client.sync(&ds);
    }

    // With the key it held, as a client passes it on from a copy beside its
    // state. Of the keys it brings, the one the server holds is taken. Its
    // new leaf carries no shares, so a holder that sees the others
    // uncovered hands the key out again.
    let stale = OwnerSecret::generate();
    let (mut g, payload) = SpaceGroup::join_external_as(
        laptop.g.device().duplicate(),
        &link,
        ds.boot(),
        b"laptop",
        Some(&local(&robert.laptop, &robert.graph)),
        None,
        None,
        &held([stale, laptop.g.owner_secret().cloned().unwrap()]),
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    assert!(g.holds_owner_key());
    assert_eq!(g.owner_secret(), laptop.g.owner_secret());
    assert!(matches!(laptop.sync(&ds)[..], [Outcome::Removed { .. }]));
}

#[test]
fn the_recovery_key_opens_its_share_and_throws_the_lost_devices_out() {
    let (laptop_id, recovery_key) = person_with_recovery();
    let (mut ds, mut laptop, link) = space_with("laptop", &laptop_id);
    let mut alice = join(&mut ds, &link, "alice");
    laptop.sync(&ds);
    // Nobody has sealed anything to the recovery key yet.
    assert_eq!(
        owner_share_for_recovery(&link, ds.boot(), &recovery_key).unwrap(),
        None
    );
    let step = laptop.g.identity_step(&laptop_id.graph, None).unwrap();
    assert!(step.share_owner_key);
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    alice.sync(&ds);
    assert!(
        !laptop
            .g
            .identity_step(&laptop_id.graph, None)
            .unwrap()
            .share_owner_key
    );
    // Only the recovery key opens it, and only for the key the server holds.
    assert_eq!(
        owner_share_for_recovery(&link, ds.boot(), &DeviceKey::generate()).unwrap(),
        None
    );
    let elsewhere = OwnerSecret::generate().public();
    assert_eq!(
        owner_share_for_recovery(
            &link,
            Bootstrap {
                owner_key: &elsewhere,
                ..ds.boot()
            },
            &recovery_key
        )
        .unwrap(),
        None
    );

    // The laptop is lost. A new device recovers with the words, which
    // revokes the laptop, and takes the key along into the space.
    let fresh = DeviceKey::generate();
    let graphs = graphs_in_group_info(&link, &ds.group_info, &ds.keyring).unwrap();
    let recovered = crate::identity::recover(
        &graphs,
        &recovery_key,
        &fresh.public(),
        None,
        crate::identity::RecoverOptions::default(),
    )
    .unwrap();
    let owner = owner_share_for_recovery(&link, ds.boot(), &recovery_key)
        .unwrap()
        .unwrap();
    assert_eq!(Some(&owner), laptop.g.owner_secret());
    let (mut g, payload) = SpaceGroup::join_external_as(
        LeafKeys::generate(),
        &link,
        ds.boot(),
        b"fresh",
        Some(&local(&fresh, &recovered.graph)),
        laptop.g.owner_person(),
        None,
        &held([owner]),
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    let mut fresh_client = Client { name: "fresh", g };
    alice.sync(&ds);
    assert_eq!(role_of(&alice, "fresh"), Role::Owner);
    assert_eq!(role_of(&alice, "laptop"), Role::Editor);
    assert!(fresh_client.g.holds_owner_key());
    let step = fresh_client
        .g
        .identity_step(&recovered.graph, None)
        .unwrap();
    let laptop_leaf = fresh_client.leaf_of("laptop");
    assert_eq!(step.revoked, vec![laptop_leaf]);
    let removal = fresh_client.g.remove_revoked().unwrap();
    commit(&mut ds, &mut fresh_client, removal.submit).unwrap();
    assert!(matches!(alice.sync(&ds)[..], [Outcome::Rotated(_)]));
    assert!(matches!(
        laptop.sync(&ds)[..],
        [Outcome::Advanced, Outcome::Removed { .. }]
    ));
    // The lost laptop's key is the old one, which signs nothing now.
    assert_ne!(laptop.g.owner_secret(), fresh_client.g.owner_secret());
}

// What an editor can do with a reset: replace the GroupInfo and keyring
// with any it can seal and sign under the current link.

/// A reset by `resetter` to `keyring` (plain, as `Keyring::export` writes
/// it, and not necessarily one `Keyring` accepts) and a GroupInfo whose
/// policy has its attestation keys and `owner_tag`.
fn forged_reset(
    resetter: &Client,
    link: &LinkSecret,
    plain: &[u8],
    attest_pubs: Vec<PublicKey>,
    owner_tag: [u8; KEY_LEN],
) -> ResetPayload {
    let policy = Policy {
        attest_pubs,
        owner_tag,
    };
    let (fresh, info, _) = SpaceGroup::start(
        resetter.g.device().duplicate(),
        link,
        resetter.g.doc_keys().keyring().clone(),
        policy,
        group_id_of(&resetter.g.space_id(), resetter.g.incarnation() + 1),
        b"mallory",
        None,
        (OwnerSecrets::default(), None),
    )
    .unwrap();
    ResetPayload {
        incarnation: u64::from(resetter.g.incarnation()),
        group_id: fresh.group_id.clone(),
        group_info: info,
        keyring: Keyring::seal_signed_plain(link, plain),
    }
}

/// A plain keyring of `(doc key, attestation key)` generations.
fn plain_keyring(generations: &[([u8; KEY_LEN], PublicKey)]) -> Vec<u8> {
    let mut plain = vec![crate::crypto::KEYRING_VERSION];
    plain.extend_from_slice(&(generations.len() as u32).to_be_bytes());
    for (key, attest_pub) in generations {
        plain.extend_from_slice(key);
        plain.extend_from_slice(attest_pub);
    }
    plain
}

/// The keyring's generations, read back from its export.
fn generations_of(keyring: &Keyring) -> Vec<([u8; KEY_LEN], PublicKey)> {
    keyring.export()[5..]
        .chunks(2 * KEY_LEN)
        .map(|g| {
            (
                g[..KEY_LEN].try_into().unwrap(),
                g[KEY_LEN..].try_into().unwrap(),
            )
        })
        .collect()
}

#[test]
fn an_editor_cannot_reset_the_owner_out_of_rotating() {
    // The newest generation repeated makes a keyring one generation ahead of
    // every owner key secret, which would lock the owner out if the two had
    // to match.
    let (ds, [alice, bob, ..], link) = team();
    let owner = alice.g.owner_person().unwrap();
    let mut generations = generations_of(bob.g.doc_keys().keyring());
    generations.push(*generations.last().unwrap());
    let attest_pubs = generations.iter().map(|(_, a)| *a).collect();
    let tag = bob.g.policy().unwrap().owner_tag;
    let payload = forged_reset(&bob, &link, &plain_keyring(&generations), attest_pubs, tag);
    let ds = ds.after_reset(&payload);
    // Nobody takes it, whether they knew the space or not.
    for previous in [Some(&alice.g), None] {
        let joined = SpaceGroup::join_external_as(
            alice.g.device().duplicate(),
            &link,
            ds.boot(),
            b"alice",
            None,
            Some(owner),
            previous,
            &OwnerSecrets::default(),
        );
        assert!(
            matches!(
                joined,
                Err(MlsError::Crypto(CryptoError::MalformedKeyring(_)))
            ),
            "{joined:?}"
        );
    }
}

#[test]
fn a_reset_that_rewrites_the_keyring_is_refused_by_those_who_knew_it() {
    let (ds, [laptop, _phone, alice, _bob], link, robert) = robert_owns();
    let pinned = laptop.g.owner_person().unwrap();
    // A history of alice's making that still ends in the link's own key,
    // and the owner's tag recomputed under it so the pin still fits.
    let generations = [
        (random(), DeviceKey::generate().public()),
        (random(), link.attest_pub()),
    ];
    let plain = plain_keyring(&generations);
    let tag = Keyring::import(&plain).unwrap().owner_tag(&pinned);
    let attest_pubs = generations.iter().map(|(_, a)| *a).collect();
    let payload = forged_reset(&alice, &link, &plain, attest_pubs, tag);
    let mut ds = ds.after_reset(&payload);
    let identity = local(&robert.laptop, &robert.graph);
    let rejoin = SpaceGroup::join_external_as(
        laptop.g.device().duplicate(),
        &link,
        ds.boot(),
        b"laptop",
        Some(&identity),
        Some(pinned),
        Some(&laptop.g),
        &OwnerSecrets::default(),
    );
    assert!(matches!(&rejoin, Err(MlsError::Rewritten)), "{rejoin:?}");

    // A device that lost its state cannot tell. But the owner key is the
    // server's, which the reset did not touch: brought along, it still
    // signs, whatever generation the group claims to be at.
    let (mut g, payload) = SpaceGroup::join_external_as(
        laptop.g.device().duplicate(),
        &link,
        ds.boot(),
        b"laptop",
        Some(&identity),
        Some(pinned),
        None,
        &held([laptop.g.owner_secret().cloned().unwrap()]),
    )
    .unwrap();
    ds.submit(payload).unwrap();
    g.confirm_pending().unwrap();
    let mut laptop = Client { name: "laptop", g };
    assert!(laptop.g.holds_owner_key());
    let payload = laptop.g.reset_links().unwrap();
    commit(&mut ds, &mut laptop, payload).unwrap();
}

#[test]
fn a_reset_that_changes_the_owner_is_refused_by_those_who_knew_it() {
    let (ds, [alice, bob, ..], link) = team();
    let keyring = bob.g.doc_keys().keyring();
    let mallory = person();
    let generations = generations_of(keyring);
    let attest_pubs = generations.iter().map(|(_, a)| *a).collect();
    let tag = keyring.owner_tag(&mallory.graph.id());
    let payload = forged_reset(&bob, &link, &plain_keyring(&generations), attest_pubs, tag);
    let ds = ds.after_reset(&payload);
    // No pin to go by, as on a device that never pinned, but the state it
    // rejoins from knows the owner.
    let rejoin = SpaceGroup::join_external_as(
        alice.g.device().duplicate(),
        &link,
        ds.boot(),
        b"alice",
        None,
        None,
        Some(&alice.g),
        &OwnerSecrets::default(),
    );
    assert!(
        matches!(rejoin, Err(MlsError::OwnerChanged(_))),
        "{rejoin:?}"
    );
}

/// What the log holds at `epoch`.
fn logged(ds: &Ds, epoch: u64) -> (u64, Vec<u8>, Option<Vec<u8>>) {
    ds.log[epoch as usize].clone()
}

#[test]
fn a_forged_owner_key_with_the_echo_of_a_rotation_costs_no_secret() {
    let me = person();
    let (mut ds, mut alice, _) = space_with("alice", &me);
    // The server takes the rotation, but the reply is lost and the echo
    // names a key of the server's making.
    let payload = alice.g.reset_links().unwrap();
    let epoch = payload.epoch;
    ds.submit(payload).unwrap();
    let real = ds.owner_key;
    let forged = OwnerSecret::generate().public();
    let (_, commit, envelope) = logged(&ds, epoch);
    let outcome = alice
        .g
        .process_commit(epoch, &commit, envelope.as_deref(), Some(&forged))
        .unwrap();
    assert!(matches!(outcome, Outcome::Rotated(_)));
    // The key is the one the device signed for.
    assert_eq!(alice.g.owner_key(), Some(real));
    assert!(alice.g.holds_owner_key());

    // A rejoin from a bootstrap that names the forged key still takes the
    // real secret along, though it cannot use it.
    let link = alice.g.link().clone();
    let lying = Bootstrap {
        owner_key: &forged,
        ..ds.boot()
    };
    let (mut lied_to, join) = SpaceGroup::join_external_as(
        alice.g.device().duplicate(),
        &link,
        lying,
        b"alice",
        Some(&me),
        alice.g.owner_person(),
        Some(&alice.g),
        &OwnerSecrets::default(),
    )
    .unwrap();
    assert!(!lied_to.holds_owner_key());
    assert!(lied_to.owner_secrets().find(&real).is_some());
    ds.submit(join).unwrap();
    lied_to.confirm_pending().unwrap();
    let saved = SpaceGroup::import_state(&lied_to.export_state()).unwrap();
    assert!(saved.owner_secrets().find(&real).is_some());

    // Once the server tells the truth again, the device rotates with it.
    let (mut honest, join) = SpaceGroup::join_external_as(
        saved.device().duplicate(),
        &link,
        ds.boot(),
        b"alice",
        Some(&me),
        saved.owner_person(),
        Some(&saved),
        &OwnerSecrets::default(),
    )
    .unwrap();
    ds.submit(join).unwrap();
    honest.confirm_pending().unwrap();
    assert!(honest.holds_owner_key());
    let payload = honest.reset_links().unwrap();
    assert_eq!(ds.submit_checked(payload), Ok(()));
}

#[test]
fn a_stale_owner_key_named_by_the_server_does_not_replace_the_current_one() {
    let (mut ds, [mut laptop, mut phone, mut alice, _], _, robert) = robert_owns();
    let first = laptop.g.owner_secret().unwrap().clone();
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    phone.sync(&ds);
    assert!(phone.g.holds_owner_key());

    // The phone rotates. The laptop is not told where the key moved.
    let payload = phone.g.reset_links().unwrap();
    commit(&mut ds, &mut phone, payload).unwrap();
    let second = phone.g.owner_secret().unwrap().clone();
    let (epoch, commit_bytes, envelope) = logged(&ds, laptop.g.epoch());
    laptop
        .g
        .process_commit(epoch, &commit_bytes, envelope.as_deref(), None)
        .unwrap();
    assert!(!laptop.g.holds_owner_key());
    alice.sync(&ds);

    // The laptop's leaf carries a share of the first key, which it holds
    // for real, and the server names that key along with the commit.
    let shares = forged_shares(&laptop, &first, &phone);
    let at = ds.head();
    let rotated = laptop.g.link().clone();
    commit_shares(&mut ds, &mut laptop, &rotated, shares);
    let (epoch, commit_bytes, envelope) = logged(&ds, at);
    let outcome = phone
        .g
        .process_commit(
            epoch,
            &commit_bytes,
            envelope.as_deref(),
            Some(&first.public()),
        )
        .unwrap();
    assert!(matches!(outcome, Outcome::Advanced));
    // A commit that rotates nothing moves no key on.
    assert_eq!(phone.g.owner_secret(), Some(&second));
    assert!(phone.g.holds_owner_key());

    // Even a device that took the stale key for the current one, and opened
    // its share, keeps the newer one beside it.
    phone.g.owner_key = Some(first.public());
    phone.g.absorb_owner_share();
    assert_eq!(phone.g.owner_secret(), Some(&first));
    let saved = SpaceGroup::import_state(&phone.g.export_state()).unwrap();
    assert_eq!(saved.owner_secrets().find(&second.public()), Some(&second));
    // A self-update seals only what it takes for the current key, and the
    // real one is still there once the server says so again.
    let payload = phone.g.self_update(b"phone", None, None).unwrap();
    commit(&mut ds, &mut phone, payload);
    assert_eq!(
        shares_of(&alice, "phone").map(|s| s.owner_key),
        Some(second.public())
    );
    alice.sync(&ds);
    assert_eq!(
        shares_of(&alice, "phone").map(|s| s.owner_key),
        Some(first.public())
    );
    let (mut rejoined, join) = SpaceGroup::join_external_as(
        phone.g.device().duplicate(),
        &rotated,
        ds.boot(),
        b"phone",
        Some(&local(&robert.phone, &robert.graph)),
        phone.g.owner_person(),
        Some(&phone.g),
        &OwnerSecrets::default(),
    )
    .unwrap();
    ds.submit(join).unwrap();
    rejoined.confirm_pending().unwrap();
    assert_eq!(rejoined.owner_secret(), Some(&second));
    let payload = rejoined.reset_links().unwrap();
    assert_eq!(ds.submit_checked(payload), Ok(()));
}

#[test]
fn an_owner_key_sent_with_a_commit_that_rotates_nothing_is_ignored() {
    let (mut ds, [mut alice, mut bob, ..], _) = team();
    let real = alice.g.owner_key();
    let forged = OwnerSecret::generate().public();

    // Someone else's commit.
    let payload = bob.g.self_update(b"bob", None, None).unwrap();
    commit(&mut ds, &mut bob, payload);
    let (epoch, commit_bytes, envelope) = logged(&ds, alice.g.epoch());
    alice
        .g
        .process_commit(epoch, &commit_bytes, envelope.as_deref(), Some(&forged))
        .unwrap();
    assert_eq!(alice.g.owner_key(), real);
    assert!(alice.g.holds_owner_key());

    // The echo of this device's own.
    let payload = alice.g.self_update(b"alice", None, None).unwrap();
    let epoch = payload.epoch;
    ds.submit(payload).unwrap();
    let (_, commit_bytes, envelope) = logged(&ds, epoch);
    alice
        .g
        .process_commit(epoch, &commit_bytes, envelope.as_deref(), Some(&forged))
        .unwrap();
    assert_eq!(alice.g.owner_key(), real);
    assert!(alice.g.holds_owner_key());
    let payload = alice.g.reset_links().unwrap();
    assert_eq!(ds.submit_checked(payload), Ok(()));
}

fn binding() -> PersonSpace {
    PersonSpace::new(
        &crate::token::generate(),
        "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8g",
    )
    .unwrap()
}

#[test]
fn the_recovery_key_finds_the_personal_space_in_the_tree() {
    let (laptop_id, recovery_key) = person_with_recovery();
    let (mut ds, mut laptop, link) = space_with("laptop", &laptop_id);
    let mut alice = join(&mut ds, &link, "alice");
    laptop.sync(&ds);
    let space = binding();
    let find = |ds: &Ds, link: &LinkSecret, key: &DeviceKey| {
        person_spaces_for_recovery(link, &ds.group_info, &ds.keyring, key).unwrap()
    };
    assert!(find(&ds, &link, &recovery_key).is_empty());

    // Without a binding the step has nothing to say about it.
    assert!(
        !laptop
            .g
            .identity_step(&laptop_id.graph, None)
            .unwrap()
            .needs_refresh
    );
    let step = laptop
        .g
        .identity_step(&laptop_id.graph, Some(&space))
        .unwrap();
    assert!(step.needs_refresh);
    let payload = laptop.g.self_update(b"laptop", None, Some(&space)).unwrap();
    commit(&mut ds, &mut laptop, payload);
    alice.sync(&ds);
    let step = |laptop: &Client, space| laptop.g.identity_step(&laptop_id.graph, space).unwrap();
    assert!(!step(&laptop, Some(&space)).needs_refresh);
    assert_eq!(
        find(&ds, &link, &recovery_key),
        std::slice::from_ref(&space)
    );
    // Not for another key, and a viewer's tree read says the same.
    assert!(find(&ds, &link, &DeviceKey::generate()).is_empty());

    // A new binding makes the leaf stale until it is sealed again.
    let rotated = binding();
    assert!(step(&laptop, Some(&rotated)).needs_refresh);
    // A refresh that is told nothing keeps the pointer, as does a rotation
    // of the links.
    let payload = laptop.g.self_update(b"laptop", None, None).unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert_eq!(
        find(&ds, &link, &recovery_key),
        std::slice::from_ref(&space)
    );
    assert!(!step(&laptop, Some(&space)).needs_refresh);
    let payload = laptop.g.remove_and_rotate(&[alice.g.own_leaf()]).unwrap();
    let rotation = commit(&mut ds, &mut laptop, payload).unwrap();
    assert_eq!(
        find(&ds, &rotation.link, &recovery_key),
        std::slice::from_ref(&space)
    );
    let payload = laptop
        .g
        .self_update(b"laptop", None, Some(&rotated))
        .unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert_eq!(find(&ds, &rotation.link, &recovery_key), [rotated]);
}

#[test]
fn a_person_without_a_recovery_key_seals_nothing() {
    let (mut ds, mut laptop, link) = space();
    let space = binding();
    let id = laptop.g.own_identity_open().unwrap().graph;
    assert!(
        !laptop
            .g
            .identity_step(&id, Some(&space))
            .unwrap()
            .needs_refresh
    );
    let payload = laptop.g.self_update(b"alice", None, Some(&space)).unwrap();
    commit(&mut ds, &mut laptop, payload);
    assert!(read_person_shares(laptop.g.group.own_leaf_node().unwrap()).is_none());
    let _ = link;
}

#[test]
fn only_leaves_of_the_keys_person_are_believed() {
    let (laptop_id, recovery_key) = person_with_recovery();
    let (mut ds, mut laptop, link) = space_with("laptop", &laptop_id);
    // Someone else's device and an anonymous one both seal a pointer to
    // the recovery key from their own leaves.
    let other = person();
    let mut bob = join_as(&mut ds, &link, "bob", &other);
    let mut anon = join(&mut ds, &link, "anon");
    for client in [&mut laptop, &mut bob, &mut anon] {
        client.sync(&ds);
    }
    let space = binding();
    for index in 0..2 {
        let client = if index == 0 { &mut bob } else { &mut anon };
        client.sync(&ds);
        let scope = ShareScope {
            group_id: &client.g.group_id,
            sender: &client.g.device().signer_pub(),
        };
        let bytes = PersonShares::seal(
            client.g.provider.crypto(),
            &scope,
            &space,
            &[recovery_key.public()],
        )
        .encode();
        let editor = editor_info(client.g.device(), &link, client.g.generation().unwrap()).unwrap();
        let identity = client.g.own_identity();
        let payload = client
            .g
            .commit_leaf_with(
                Some(editor),
                client.name.as_bytes(),
                identity,
                None,
                Some(bytes),
            )
            .unwrap();
        commit(&mut ds, client, payload);
    }
    laptop.sync(&ds);
    assert!(
        person_spaces_for_recovery(&link, &ds.group_info, &ds.keyring, &recovery_key)
            .unwrap()
            .is_empty()
    );

    // The laptop's own pointer, copied byte for byte into a leaf of the
    // same person but another key, does not open there.
    let payload = laptop.g.self_update(b"laptop", None, Some(&space)).unwrap();
    commit(&mut ds, &mut laptop, payload);
    let copied = laptop
        .g
        .group
        .own_leaf_node()
        .and_then(read_person_shares)
        .unwrap()
        .encode();
    let phone_key = DeviceKey::generate();
    let mut graph = laptop_id.graph.clone();
    graph
        .append(
            &laptop_id.device,
            EntryKind::AddDevice {
                device: phone_key.public(),
                flags: 0,
            },
        )
        .unwrap();
    let mut phone = join_as(&mut ds, &link, "phone", &local(&phone_key, &graph));
    phone.sync(&ds);
    let editor = editor_info(phone.g.device(), &link, phone.g.generation().unwrap()).unwrap();
    let identity = phone.g.own_identity();
    let payload = phone
        .g
        .commit_leaf_with(Some(editor), b"phone", identity, None, Some(copied))
        .unwrap();
    commit(&mut ds, &mut phone, payload);
    let leaves: Vec<_> = member_leaves(&phone.g.group)
        .filter_map(|(_, leaf)| read_person_shares(leaf))
        .collect();
    assert_eq!(leaves.len(), 4);
    assert_eq!(
        person_spaces_for_recovery(&link, &ds.group_info, &ds.keyring, &recovery_key).unwrap(),
        [space]
    );
}

#[test]
fn candidates_are_ordered_by_leaves_then_rightmost() {
    let (laptop_id, recovery_key) = person_with_recovery();
    let (mut ds, mut laptop, link) = space_with("laptop", &laptop_id);
    let mut graph = laptop_id.graph.clone();
    let mut phone_ids = Vec::new();
    for _ in 0..2 {
        let key = DeviceKey::generate();
        graph
            .append(
                &laptop_id.device,
                EntryKind::AddDevice {
                    device: key.public(),
                    flags: 0,
                },
            )
            .unwrap();
        phone_ids.push(key);
    }
    let mut phone = join_as(&mut ds, &link, "phone", &local(&phone_ids[0], &graph));
    let mut tablet = join_as(&mut ds, &link, "tablet", &local(&phone_ids[1], &graph));
    laptop.sync(&ds);
    phone.sync(&ds);
    tablet.sync(&ds);
    let (first, second) = (binding(), binding());
    let seal = |ds: &mut Ds, client: &mut Client, space: &PersonSpace| {
        client.sync(ds);
        let payload = client
            .g
            .self_update(client.name.as_bytes(), None, Some(space))
            .unwrap();
        commit(ds, client, payload);
    };
    let find = |ds: &Ds| {
        person_spaces_for_recovery(&link, &ds.group_info, &ds.keyring, &recovery_key).unwrap()
    };

    // One leaf each: the rightmost leaf comes first.
    seal(&mut ds, &mut laptop, &first);
    seal(&mut ds, &mut phone, &second);
    assert_eq!(find(&ds), [second.clone(), first.clone()]);

    // Two leaves carrying one pointer beat a single rightmost one.
    seal(&mut ds, &mut laptop, &first);
    seal(&mut ds, &mut tablet, &first);
    assert_eq!(find(&ds), [first, second]);
}
