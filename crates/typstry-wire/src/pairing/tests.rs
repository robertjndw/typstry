use std::collections::HashSet;

use super::*;
use crate::crypto::LinkSecret;
use crate::identity::{DeviceKey, EntryKind, PersonGraph};
use crate::owner::OwnerSecrets;
use crate::relay::CHANNEL_MAX;

/// The public key of RFC 8032's first Ed25519 test vector.
const DEVICE_PUB: PublicKey = [
    0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64, 0x07, 0x3a,
    0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
];

fn code() -> Code {
    "42-ivory-galaxy".parse().unwrap()
}

fn grant() -> Grant {
    Grant::new(
        "Desktop".into(),
        PersonGraph::genesis(&DeviceKey::import(&[7; 32]).unwrap()).encode(),
        space(),
    )
}

/// The most owner secrets a person's set can hold.
fn full_owner_secrets() -> Vec<u8> {
    use crate::owner::{Origin, OwnerSecret};
    let mut set = OwnerSecrets::default();
    for _ in 0..OwnerSecrets::KEEP {
        set.add(OwnerSecret::generate(), Origin::Made);
        set.add(OwnerSecret::generate(), Origin::Received);
    }
    set.encode().to_vec()
}

fn space() -> GrantedSpace {
    GrantedSpace::new(
        crate::token::generate(),
        LinkSecret::generate_edit().to_base64url().to_string(),
        full_owner_secrets(),
    )
    .unwrap()
}

/// Runs the exchange up to the holder's approval question.
fn paired() -> (Pairing, Pairing) {
    let (mut holder, h0) = Pairing::start_holder(&code());
    let (mut new, n0) = Pairing::start_new(&code(), "Laptop", &DEVICE_PUB).unwrap();
    let h1 = holder.handle(&n0).unwrap().send.unwrap();
    let n1 = new.handle(&h0).unwrap().send.unwrap();
    let hello = {
        let step = new.handle(&h1).unwrap();
        assert!(matches!(step.event, Some(Event::Verified)));
        step.send.unwrap()
    };
    assert!(holder.handle(&n1).unwrap().send.is_none());
    let step = holder.handle(&hello).unwrap();
    match step.event {
        Some(Event::AwaitApproval {
            device_name,
            device_pub,
        }) => {
            assert_eq!(device_name, "Laptop");
            assert_eq!(device_pub, DEVICE_PUB);
        }
        other => panic!("unexpected {other:?}"),
    }
    (holder, new)
}

#[test]
fn full_exchange_hands_over_the_grant() {
    let (mut holder, mut new) = paired();
    let sent_grant = grant();
    let sent = holder.approve(&sent_grant).unwrap();
    let Some(Event::Granted(got)) = new.handle(&sent).unwrap().event else {
        panic!("expected a grant");
    };
    assert_eq!(got.graph, sent_grant.graph);
    assert_eq!(got.holder_name, "Desktop");
    assert!(PersonGraph::decode(&got.graph).is_ok());
    assert!(got.space == sent_grant.space);
    assert!(holder.is_over() && new.is_over());
    assert!(matches!(new.handle(&sent), Err(PairError::Finished)));
}

#[test]
fn reject_reaches_the_new_device() {
    let (mut holder, mut new) = paired();
    let sent = holder.reject().unwrap();
    assert!(matches!(
        new.handle(&sent).unwrap().event,
        Some(Event::Rejected)
    ));
    assert!(matches!(holder.approve(&grant()), Err(PairError::Finished)));
}

#[test]
fn hello_waits_for_confirmation() {
    let (mut holder, h0) = Pairing::start_holder(&code());
    let (mut new, n0) = Pairing::start_new(&code(), "Laptop", &DEVICE_PUB).unwrap();
    // The new side sends nothing but the PAKE message until it has verified
    // the holder's confirmation.
    let step = new.handle(&h0).unwrap();
    assert!(step.send.as_ref().is_some_and(|f| f[1] == TAG_CONFIRM));
    holder.handle(&n0).unwrap();
    // A forged early hello is out of order for the holder.
    assert!(matches!(
        holder.handle(&frame(TAG_HELLO, &[1; 40])),
        Err(PairError::Unexpected)
    ));
}

#[test]
fn wrong_code_fails_both_sides() {
    let (mut holder, h0) = Pairing::start_holder(&code());
    let other: Code = "42-ivory-zebra".parse().unwrap();
    let (mut new, n0) = Pairing::start_new(&other, "Laptop", &DEVICE_PUB).unwrap();
    let h1 = holder.handle(&n0).unwrap().send.unwrap();
    let n1 = new.handle(&h0).unwrap().send.unwrap();
    assert!(matches!(new.handle(&h1), Err(PairError::WrongCode)));
    assert!(matches!(holder.handle(&n1), Err(PairError::WrongCode)));
    assert!(matches!(holder.handle(&n1), Err(PairError::Finished)));
    assert!(matches!(new.handle(&h1), Err(PairError::Finished)));
}

#[test]
fn role_conflict_is_an_error() {
    let (mut a, a0) = Pairing::start_holder(&code());
    let (mut b, b0) = Pairing::start_holder(&code());
    let a1 = a.handle(&b0).unwrap().send.unwrap();
    let b1 = b.handle(&a0).unwrap().send.unwrap();
    assert!(matches!(a.handle(&b1), Err(PairError::RoleConflict)));
    assert!(matches!(b.handle(&a1), Err(PairError::RoleConflict)));

    let (mut c, c0) = Pairing::start_new(&code(), "A", &DEVICE_PUB).unwrap();
    let (mut d, d0) = Pairing::start_new(&code(), "B", &DEVICE_PUB).unwrap();
    let c1 = c.handle(&d0).unwrap().send.unwrap();
    assert!(matches!(d.handle(&c0).map(|s| s.send), Ok(Some(_))));
    assert!(matches!(d.handle(&c1), Err(PairError::RoleConflict)));
}

#[test]
fn tampered_sealed_frames_fail() {
    let (mut holder, mut new) = paired();
    let mut sent = holder.approve(&grant()).unwrap();
    *sent.last_mut().unwrap() ^= 1;
    assert!(matches!(new.handle(&sent), Err(PairError::Tampered)));
    assert!(matches!(new.handle(&sent), Err(PairError::Finished)));
}

#[test]
fn a_hello_cannot_stand_in_for_a_grant() {
    let (mut holder, h0) = Pairing::start_holder(&code());
    let (mut new, n0) = Pairing::start_new(&code(), "Laptop", &DEVICE_PUB).unwrap();
    let h1 = holder.handle(&n0).unwrap().send.unwrap();
    let n1 = new.handle(&h0).unwrap().send.unwrap();
    let hello = new.handle(&h1).unwrap().send.unwrap();
    holder.handle(&n1).unwrap();
    // Replaying the hello back at the new side is out of order.
    assert!(matches!(new.handle(&hello), Err(PairError::Unexpected)));
}

#[test]
fn echoed_pake_message_is_refused() {
    let (mut p, first) = Pairing::start_holder(&code());
    assert!(matches!(p.handle(&first), Err(PairError::Malformed(_))));
    assert!(matches!(p.handle(&first), Err(PairError::Finished)));
}

#[test]
fn junk_and_newer_frames_error() {
    let (mut p, _) = Pairing::start_holder(&code());
    assert!(matches!(p.handle(&[]), Err(PairError::Malformed(_))));
    let (mut p, _) = Pairing::start_holder(&code());
    assert!(matches!(
        p.handle(&[9, TAG_PAKE, 0]),
        Err(PairError::NewerVersion(9))
    ));
    // Versions start at 1, so 0 is junk rather than newer.
    let (mut p, _) = Pairing::start_holder(&code());
    assert!(matches!(
        p.handle(&[0, TAG_PAKE, 0]),
        Err(PairError::Malformed(_))
    ));
}

#[test]
fn approve_before_hello_is_refused() {
    let (mut holder, _) = Pairing::start_holder(&code());
    assert!(matches!(
        holder.approve(&grant()),
        Err(PairError::Unexpected)
    ));
    assert!(matches!(holder.reject(), Err(PairError::Finished)));
}

#[test]
fn grant_limits_hold() {
    let mut g = grant();
    g.graph = vec![0; MAX_GRAPH_BYTES + 1];
    assert!(g.encode().is_err());
    let mut g = grant();
    g.holder_name = "n".repeat(MAX_DEVICE_NAME_LEN + 1);
    assert!(g.encode().is_err());
    g.holder_name = String::new();
    assert!(g.encode().is_err());

    let full = Grant {
        holder_name: "n".repeat(MAX_DEVICE_NAME_LEN),
        graph: vec![1; MAX_GRAPH_BYTES],
        space: space(),
    };
    assert!(full.space.owner_secrets.len() <= MAX_OWNER_SECRETS_LEN);
    let bytes = full.encode().unwrap();
    assert!(bytes.len() + 64 < MAX_RELAY_MESSAGE);
    let got = Grant::decode(&bytes).unwrap();
    assert!(got.space == full.space);
}

#[test]
fn device_names_are_checked() {
    assert!(Pairing::start_new(&code(), "", &DEVICE_PUB).is_err());
    assert!(Pairing::start_new(&code(), "bad\u{1b}[31m", &DEVICE_PUB).is_err());
    assert!(
        Pairing::start_new(&code(), &"n".repeat(MAX_DEVICE_NAME_LEN + 1), &DEVICE_PUB).is_err()
    );
}

#[test]
fn device_names_are_fitted() {
    assert!(valid_device_name("Laptop"));
    assert!(!valid_device_name(""));
    assert!(!valid_device_name("a\tb"));
    assert_eq!(fit_device_name("  Laptop\n").as_deref(), Some("Laptop"));
    assert_eq!(
        fit_device_name("bad\u{1b}[31m").as_deref(),
        Some("bad [31m")
    );
    assert_eq!(fit_device_name(" \n\t "), None);
    // Four-byte characters, cut on a boundary below the byte limit.
    let long = "\u{1f600}".repeat(MAX_DEVICE_NAME_LEN);
    let fitted = fit_device_name(&long).unwrap();
    assert_eq!(fitted.len(), MAX_DEVICE_NAME_LEN);
    assert!(valid_device_name(&fitted));
    let odd = format!("a{long}");
    let fitted = fit_device_name(&odd).unwrap();
    assert_eq!(fitted.len(), MAX_DEVICE_NAME_LEN - 3);
    assert!(valid_device_name(&fitted));
}

#[test]
fn hello_carries_the_device_key_and_refuses_junk() {
    let hello = Hello {
        device_name: "Laptop".into(),
        device_pub: DEVICE_PUB,
    };
    let bytes = hello.encode();
    let got = Hello::decode(&bytes).unwrap();
    assert_eq!(
        (got.device_name.as_str(), got.device_pub),
        ("Laptop", DEVICE_PUB)
    );
    for len in 0..bytes.len() {
        assert!(Hello::decode(&bytes[..len]).is_err(), "prefix {len}");
    }
    assert!(Hello::decode(&[bytes.clone(), vec![0]].concat()).is_err());
    let mut newer = bytes;
    newer[0] += 1;
    assert!(matches!(
        Hello::decode(&newer),
        Err(PairError::NewerVersion(_))
    ));
    newer[0] = 0;
    assert!(matches!(
        Hello::decode(&newer),
        Err(PairError::Malformed(_))
    ));

    // The identity point is a small-order key every signature verifies under.
    let mut identity = [0; 32];
    identity[0] = 1;
    let weak = Hello {
        device_name: "Laptop".into(),
        device_pub: identity,
    };
    assert!(matches!(
        Hello::decode(&weak.encode()),
        Err(PairError::Malformed(_))
    ));
}

#[test]
fn a_grant_graph_extends_with_the_announced_device() {
    // What the holder does between the hello and the grant.
    let holder = DeviceKey::generate();
    let new = DeviceKey::generate();
    let mut graph = PersonGraph::genesis(&holder);
    graph
        .append(
            &holder,
            EntryKind::AddDevice {
                device: new.public(),
                flags: 0,
            },
        )
        .unwrap();
    let grant = Grant::new("Desktop".into(), graph.encode(), space());
    let got = Grant::decode(&grant.encode().unwrap()).unwrap();
    let got = PersonGraph::decode(&got.graph).unwrap();
    assert_eq!(got, graph);
    assert_eq!(got.valid_devices().len(), 2);
}

#[test]
fn a_space_roundtrips() {
    let g = grant();
    let got = Grant::decode(&g.encode().unwrap()).unwrap();
    assert!(got.space == g.space);

    let (mut holder, mut new) = paired();
    let sent = holder.approve(&g).unwrap();
    let Some(Event::Granted(got)) = new.handle(&sent).unwrap().event else {
        panic!("expected a grant");
    };
    assert!(got.space == g.space);
}

#[test]
fn a_grant_without_a_space_is_refused() {
    // The space is the last field, so every shorter prefix lacks some of it.
    let bytes = grant().encode().unwrap().to_vec();
    for len in 0..bytes.len() {
        assert!(Grant::decode(&bytes[..len]).is_err(), "prefix {len}");
    }
    let mut w = BytesWriter::new();
    w.push_byte(GRANT_VERSION);
    w.push_var_bytes(&grant().graph);
    w.push_var_string("Desktop");
    assert!(Grant::decode(&w.finalize()).is_err());
}

#[test]
fn a_malformed_space_is_refused() {
    let token = crate::token::generate();
    let edit = LinkSecret::generate_edit().to_base64url().to_string();
    let view = LinkSecret::generate_edit().view_secret().to_string();
    let owners = full_owner_secrets();
    let make = |t: &str, s: &str, o: &[u8]| GrantedSpace::new(t.into(), s.into(), o.to_vec());

    assert!(make(&token, &edit, &owners).is_ok());
    assert!(make("short", &edit, &owners).is_err());
    assert!(make(&"!".repeat(crate::token::TOKEN_LEN), &edit, &owners).is_err());
    assert!(make(&token, "", &owners).is_err());
    assert!(make(&token, "not a secret", &owners).is_err());
    assert!(make(&token, &view, &owners).is_err());
    assert!(make(&token, &"A".repeat(MAX_LINK_LEN + 1), &owners).is_err());
    assert!(make(&token, &edit, &[]).is_err());
    assert!(make(&token, &edit, &[1, 0]).is_err());
    assert!(make(&token, &edit, &[0xff; 20]).is_err());
    assert!(make(&token, &edit, &vec![0; MAX_OWNER_SECRETS_LEN + 1]).is_err());

    // The same goes for a grant built around fields set directly.
    let mut g = grant();
    g.space = GrantedSpace {
        token,
        secret: edit.into(),
        owner_secrets: vec![0; MAX_OWNER_SECRETS_LEN + 1].into(),
    };
    assert!(g.encode().is_err());
}

#[test]
fn debug_hides_secrets() {
    let g = grant();
    let secret = g.space.secret.to_string();
    let token = g.space.token.clone();
    let text = format!("{g:?} {:?}", g.space);
    assert!(!text.contains(&secret) && !text.contains(&token), "{text}");
    let text = format!(
        "{:?} {:?} {:?}",
        grant(),
        code(),
        Pairing::start_holder(&code()).0
    );
    for secret in ["secret", "other", "ivory", "galaxy"] {
        assert!(!text.contains(secret), "{text}");
    }
}

#[test]
fn wordlist_is_256_unique_typable_words() {
    let set: HashSet<_> = WORDS.iter().collect();
    assert_eq!(set.len(), 256);
    for w in WORDS {
        assert!((3..=8).contains(&w.len()), "{w}");
        assert!(w.bytes().all(|b| b.is_ascii_lowercase()), "{w}");
    }
}

#[test]
fn code_roundtrips() {
    for _ in 0..50 {
        let c = Code::generate(1 + rand_channel() % CHANNEL_MAX).unwrap();
        assert_eq!(c.to_string().parse::<Code>().unwrap(), c);
    }
    assert_eq!(code().to_string(), "42-ivory-galaxy");
    assert_eq!(code().channel(), 42);
}

fn rand_channel() -> u16 {
    u16::from_le_bytes(crate::crypto::random())
}

#[test]
fn code_parsing_is_forgiving_about_case_and_links() {
    for input in [
        "42-ivory-galaxy",
        "  42-IVORY-Galaxy \n",
        "https://host.example/pair#42-ivory-galaxy",
        " https://host.example/pair#42-Ivory-GALAXY ",
    ] {
        assert_eq!(Code::from_link_or_code(input).unwrap(), code(), "{input}");
    }
}

#[test]
fn bad_codes_are_rejected() {
    for input in [
        "",
        "42",
        "42-ivory",
        "42-ivory-galaxy-extra",
        "0-ivory-galaxy",
        "10000-ivory-galaxy",
        "99999999-ivory-galaxy",
        "-1-ivory-galaxy",
        "+42-ivory-galaxy",
        "42-ivory-notaword",
        "42--galaxy",
        "https://host/pair",
        "https://host/pair#",
    ] {
        assert!(Code::from_link_or_code(input).is_err(), "{input}");
    }
    assert!(Code::generate(0).is_err());
    assert!(Code::generate(CHANNEL_MAX + 1).is_err());
    assert!(Code::generate(CHANNEL_MAX).is_ok());
}
