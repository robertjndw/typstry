//! The rotation envelope: how the new links reach the members who remain
//! after a removal or a reset.
//!
//! The committer cannot send the new link to the server, which would hand
//! it to everyone who can read the commit log, including the member that was
//! just removed. Instead the envelope rides along with the commit:
//!
//! - the new view link and tokens are sealed under an MLS exporter secret of
//!   the epoch the commit creates, which every remaining member has and the
//!   removed one does not;
//! - the new edit link and tokens are HPKE-sealed to each remaining
//!   editor's key from its leaf, so remaining viewers learn nothing more
//!   than a view link. A failure in this part only ever affects the one
//!   member it is for, never whether the commit is valid.
//!
//! Both parts are bound to the commit by its digest, so an envelope cannot
//! be moved onto another commit. The owner role needs nothing here, as it
//! follows the owner's person. The next owner key, which the server checks
//! rotations against, travels in the committer's new leaf instead (see
//! [`super::owner_share`]), where it outlives the commit log.

use loro_protocol::{BytesReader, BytesWriter};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::HpkeCiphertext;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::MlsError;
use super::storage::hpke_config;
use crate::codec::plausible_count;
use crate::crypto::{KEY_LEN, LinkSecret, PublicKey, SealKey};

pub const ENVELOPE_VERSION: u8 = 1;

/// MLS exporter label of the key the view part is sealed under.
pub const ROTATION_LABEL: &str = "typstry rotation";
const ENVELOPE_CONTEXT: &str = "typstry:v1:rotation";

/// The server tokens that go with a pair of links.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    /// Only editors learn it.
    pub edit: Option<String>,
    pub view: String,
}

/// A remaining editor the edit link is sent to.
#[derive(Debug, Clone)]
pub struct Recipient {
    pub signer: PublicKey,
    pub hpke_pub: Vec<u8>,
}

/// What a rotation commit is tied to.
pub struct Binding<'a> {
    pub group_id: &'a [u8],
    /// The epoch the commit creates.
    pub epoch: u64,
    pub commit: &'a [u8],
}

impl Binding<'_> {
    /// Also the context of the exporter secret.
    pub fn digest(&self) -> [u8; 32] {
        Sha256::digest(self.commit).into()
    }

    fn info(&self) -> Vec<u8> {
        [
            ENVELOPE_CONTEXT.as_bytes(),
            &(self.group_id.len() as u32).to_be_bytes(),
            self.group_id,
            &self.epoch.to_be_bytes(),
            &self.digest(),
        ]
        .concat()
    }
}

/// What a member learns from an envelope.
#[derive(Debug)]
pub struct Opened {
    pub link: LinkSecret,
    pub tokens: Tokens,
}

fn push_links(w: &mut BytesWriter, link: &str, tokens: &[&str]) {
    w.push_var_string(link);
    for token in tokens {
        w.push_var_string(token);
    }
}

/// Seals the new links. `exporter` is the exporter secret of the new epoch
/// with [`Binding::digest`] as context.
///
/// A recipient whose key cannot be sealed to is left out and gets the view
/// link, as a member with no entry does, instead of failing the rotation for
/// everyone. Who is left out depends only on the committer's tree, and
/// receivers never decide it, so this cannot fork the group.
pub fn seal(
    crypto: &impl OpenMlsCrypto,
    exporter: &[u8; KEY_LEN],
    binding: &Binding<'_>,
    link: &LinkSecret,
    tokens: &Tokens,
    recipients: &[Recipient],
) -> Result<Vec<u8>, MlsError> {
    let edit_token = tokens
        .edit
        .as_deref()
        .ok_or_else(|| MlsError::Envelope("a rotation needs an edit token".into()))?;

    let mut view = BytesWriter::new();
    push_links(&mut view, &link.view_secret(), &[&tokens.view]);
    let view = SealKey::new(*exporter).seal(&Zeroizing::new(view.finalize()), ENVELOPE_CONTEXT);

    let mut edit = BytesWriter::new();
    push_links(&mut edit, &link.to_base64url(), &[edit_token, &tokens.view]);
    let edit = Zeroizing::new(edit.finalize());
    let mut w = BytesWriter::new();
    w.push_byte(ENVELOPE_VERSION);
    w.push_var_bytes(&view);
    push_entries(&mut w, crypto, binding, recipients, &edit);
    Ok(w.finalize())
}

/// A list of `(signer, HPKE(plain))`, one for each recipient that can be
/// sealed to.
fn push_entries(
    w: &mut BytesWriter,
    crypto: &impl OpenMlsCrypto,
    binding: &Binding<'_>,
    recipients: &[Recipient],
    plain: &[u8],
) {
    let entries: Vec<_> = recipients
        .iter()
        .filter_map(|recipient| {
            let sealed = crypto
                .hpke_seal(
                    hpke_config(),
                    &recipient.hpke_pub,
                    &binding.info(),
                    &recipient.signer,
                    plain,
                )
                .ok()?;
            Some((recipient.signer, sealed))
        })
        .collect();
    w.push_uleb128(entries.len() as u64);
    for (signer, sealed) in entries {
        w.push_bytes(&signer);
        w.push_var_bytes(sealed.kem_output.as_slice());
        w.push_var_bytes(sealed.ciphertext.as_slice());
    }
}

/// The entry for `signer` in a list written by [`push_entries`], after
/// reading the whole list so a framing defect is seen by everyone.
fn read_entries(
    r: &mut BytesReader<'_>,
    signer: &PublicKey,
) -> Result<Option<HpkeCiphertext>, MlsError> {
    let bad = |why: String| MlsError::Envelope(why);
    let count = plausible_count(r, KEY_LEN + 2).map_err(bad)?;
    let mut mine = None;
    for _ in 0..count {
        let who = r.read_bytes(KEY_LEN).map_err(bad)?;
        let kem_output = r.read_var_bytes().map_err(bad)?;
        let ciphertext = r.read_var_bytes().map_err(bad)?;
        if who == signer.as_slice() {
            mine = Some(HpkeCiphertext {
                kem_output: kem_output.to_vec().into(),
                ciphertext: ciphertext.to_vec().into(),
            });
        }
    }
    Ok(mine)
}

/// Opens an envelope as the member holding `signer` and `hpke_private`.
///
/// Two kinds of failure, and the difference is what keeps the group from
/// forking. The shared part (framing, the view link sealed under the epoch's
/// exporter secret) is the same bytes for every member, so a defect there
/// is an error for all of them alike and the commit is refused. A member's
/// own edit entry is private to it, so any defect in it (no entry, an HPKE
/// failure, garbage inside, a link that disagrees with the shared part)
/// only costs that member the edit link: it gets the view link and is still
/// told the group moved on. An editor that lost its entry can be sent the
/// edit link again.
pub fn open(
    crypto: &impl OpenMlsCrypto,
    exporter: &[u8; KEY_LEN],
    binding: &Binding<'_>,
    signer: &PublicKey,
    hpke_private: &[u8],
    envelope: &[u8],
) -> Result<Opened, MlsError> {
    let bad = |why: String| MlsError::Envelope(why);
    let mut r = BytesReader::new(envelope);
    match r.read_byte().map_err(bad)? {
        ENVELOPE_VERSION => {}
        other => {
            return Err(MlsError::Envelope(format!(
                "version {other} is not supported"
            )));
        }
    }
    let view = r.read_var_bytes().map_err(bad)?;
    let mine = read_entries(&mut r, signer)?;
    if r.remaining() != 0 {
        return Err(MlsError::Envelope("trailing bytes".into()));
    }

    let view = Zeroizing::new(
        SealKey::new(*exporter)
            .open(view, ENVELOPE_CONTEXT)
            .map_err(|e| MlsError::Envelope(e.to_string()))?,
    );
    let mut v = BytesReader::new(&view);
    let view_link = Zeroizing::new(v.read_var_string().map_err(bad)?);
    let view_token = v.read_var_string().map_err(bad)?;
    if v.remaining() != 0 {
        return Err(MlsError::Envelope("trailing bytes in the view part".into()));
    }
    // Parsed here, for everyone, so a bad shared link is not a private
    // failure of whoever happens to fall back to it. It has to be a view
    // secret: a rotation never publishes the edit link to the whole group.
    let shared = LinkSecret::from_base64url(&view_link)?;
    if shared.can_attest() {
        return Err(MlsError::Envelope(
            "the shared part carries an edit link".into(),
        ));
    }
    let view_only = |shared: LinkSecret| Opened {
        link: shared,
        tokens: Tokens {
            edit: None,
            view: view_token.clone(),
        },
    };

    let Some(mine) = mine else {
        return Ok(view_only(shared));
    };
    let Ok(edit) = crypto.hpke_open(hpke_config(), &mine, hpke_private, &binding.info(), signer)
    else {
        return Ok(view_only(shared));
    };
    let edit = Zeroizing::new(edit);
    Ok(read_edit_part(&edit, &view_link, &view_token).unwrap_or_else(|| view_only(shared)))
}

/// A member's edit entry, or `None` if it is damaged in any way.
fn read_edit_part(edit: &[u8], view_link: &str, view_token: &str) -> Option<Opened> {
    let mut e = BytesReader::new(edit);
    let link = Zeroizing::new(e.read_var_string().ok()?);
    let edit_token = e.read_var_string().ok()?;
    let token = e.read_var_string().ok()?;
    if e.remaining() != 0 || token != view_token {
        return None;
    }
    let link = LinkSecret::from_base64url(&link).ok()?;
    if !link.can_attest() || *link.view_secret() != view_link {
        return None;
    }
    Some(Opened {
        link,
        tokens: Tokens {
            edit: Some(edit_token),
            view: token,
        },
    })
}

#[cfg(test)]
mod tests {
    use openmls_rust_crypto::RustCrypto;
    use openmls_traits::crypto::OpenMlsCrypto;

    use super::*;
    use crate::mls::LeafKeys;
    use crate::token;

    #[test]
    fn envelopes_are_bound_to_their_commit_and_recipient() {
        let crypto = RustCrypto::default();
        let (editor, other) = (LeafKeys::generate(), LeafKeys::generate());
        let link = LinkSecret::generate_edit();
        let tokens = Tokens {
            edit: Some(token::generate()),
            view: token::generate(),
        };
        let binding = Binding {
            group_id: b"group",
            epoch: 4,
            commit: b"commit",
        };
        let exporter = [3; 32];
        let envelope = seal(
            &crypto,
            &exporter,
            &binding,
            &link,
            &tokens,
            &[Recipient {
                signer: editor.signer_pub(),
                hpke_pub: editor.hpke_pub().to_vec(),
            }],
        )
        .unwrap();
        let open_as = |device: &LeafKeys, binding: &Binding<'_>, exporter: &[u8; 32]| {
            open(
                &crypto,
                exporter,
                binding,
                &device.signer_pub(),
                device.hpke_private(),
                &envelope,
            )
        };

        let opened = open_as(&editor, &binding, &exporter).unwrap();
        assert_eq!(opened.tokens, tokens);
        assert_eq!(opened.link.to_base64url(), link.to_base64url());

        // Not a recipient: the shared part only.
        let opened = open_as(&other, &binding, &exporter).unwrap();
        assert_eq!(opened.tokens.edit, None);
        assert!(!opened.link.can_attest());
        assert_eq!(*opened.link.view_secret(), *link.view_secret());

        // Another commit's binding does not open the edit part.
        let moved = Binding {
            commit: b"another commit",
            ..binding
        };
        assert_eq!(
            open_as(&editor, &moved, &exporter).unwrap().tokens.edit,
            None
        );
        let moved = Binding {
            epoch: 5,
            ..binding
        };
        assert_eq!(
            open_as(&editor, &moved, &exporter).unwrap().tokens.edit,
            None
        );

        // Framing damage is everyone's problem.
        let trailing = [envelope.clone(), vec![0]].concat();
        assert!(
            open(
                &crypto,
                &exporter,
                &binding,
                &editor.signer_pub(),
                editor.hpke_private(),
                &trailing
            )
            .is_err()
        );

        // Nor does anything open without the epoch's exporter secret.
        assert!(open_as(&editor, &binding, &[4; 32]).is_err());
        assert!(
            open(
                &crypto,
                &exporter,
                &binding,
                &editor.signer_pub(),
                editor.hpke_private(),
                &envelope[..10]
            )
            .is_err()
        );
    }

    /// An envelope with a hand-made shared part and one entry for `device`.
    fn crafted(
        crypto: &RustCrypto,
        exporter: &[u8; 32],
        binding: &Binding<'_>,
        device: &LeafKeys,
        shared: &[u8],
        entry: &[u8],
    ) -> Vec<u8> {
        let view = SealKey::new(*exporter).seal(shared, ENVELOPE_CONTEXT);
        let sealed = crypto
            .hpke_seal(
                hpke_config(),
                device.hpke_pub(),
                &binding.info(),
                &device.signer_pub(),
                entry,
            )
            .unwrap();
        let mut w = BytesWriter::new();
        w.push_byte(ENVELOPE_VERSION);
        w.push_var_bytes(&view);
        w.push_uleb128(1);
        w.push_bytes(&device.signer_pub());
        w.push_var_bytes(sealed.kem_output.as_slice());
        w.push_var_bytes(sealed.ciphertext.as_slice());
        w.finalize()
    }

    fn links(link: &str, tokens: &[&str]) -> Vec<u8> {
        let mut w = BytesWriter::new();
        push_links(&mut w, link, tokens);
        w.finalize()
    }

    #[test]
    fn a_damaged_edit_entry_only_costs_its_owner_the_edit_link() {
        let crypto = RustCrypto::default();
        let device = LeafKeys::generate();
        let link = LinkSecret::generate_edit();
        let other = LinkSecret::generate_edit();
        let exporter = [3; 32];
        let binding = Binding {
            group_id: b"group",
            epoch: 4,
            commit: b"commit",
        };
        let shared = links(&link.view_secret(), &["view"]);
        let good = links(&link.to_base64url(), &["edit", "view"]);
        let open_with = |entry: &[u8]| {
            let envelope = crafted(&crypto, &exporter, &binding, &device, &shared, entry);
            open(
                &crypto,
                &exporter,
                &binding,
                &device.signer_pub(),
                device.hpke_private(),
                &envelope,
            )
        };
        assert_eq!(
            open_with(&good).unwrap().tokens.edit.as_deref(),
            Some("edit")
        );

        let wrong_token = links(&link.to_base64url(), &["edit", "other"]);
        let wrong_link = links(&other.to_base64url(), &["edit", "view"]);
        let view_as_edit = links(&link.view_secret(), &["edit", "view"]);
        let trailing = [good.clone(), vec![0]].concat();
        for (name, entry) in [
            ("a token that disagrees", wrong_token),
            ("a link that disagrees", wrong_link),
            ("a view link as the edit link", view_as_edit),
            ("garbage", vec![0xff; 9]),
            ("trailing bytes", trailing),
            ("nothing", vec![]),
        ] {
            let opened = open_with(&entry).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(opened.tokens.edit, None, "{name}");
            assert_eq!(opened.tokens.view, "view", "{name}");
            assert!(!opened.link.can_attest(), "{name}");
            assert_eq!(*opened.link.view_secret(), *link.view_secret(), "{name}");
        }
    }

    #[test]
    fn the_shared_part_decides_for_every_member_alike() {
        let crypto = RustCrypto::default();
        let (editor, viewer) = (LeafKeys::generate(), LeafKeys::generate());
        let link = LinkSecret::generate_edit();
        let exporter = [3; 32];
        let binding = Binding {
            group_id: b"group",
            epoch: 4,
            commit: b"commit",
        };
        let entry = links(&link.to_base64url(), &["edit", "view"]);
        let leaks_edit = links(&link.to_base64url(), &["view"]);
        let trailing = [links(&link.view_secret(), &["view"]), vec![0]].concat();
        let bad_link = links("not a link", &["view"]);
        for (name, shared) in [
            ("the edit link", leaks_edit),
            ("trailing bytes", trailing),
            ("a bad link", bad_link),
        ] {
            let envelope = crafted(&crypto, &exporter, &binding, &editor, &shared, &entry);
            for device in [&editor, &viewer] {
                let opened = open(
                    &crypto,
                    &exporter,
                    &binding,
                    &device.signer_pub(),
                    device.hpke_private(),
                    &envelope,
                );
                assert!(opened.is_err(), "{name}");
            }
        }
    }

    #[test]
    fn recipients_that_cannot_be_sealed_to_are_skipped() {
        let crypto = RustCrypto::default();
        let (good, broken) = (LeafKeys::generate(), LeafKeys::generate());
        let link = LinkSecret::generate_edit();
        let tokens = Tokens {
            edit: Some(token::generate()),
            view: token::generate(),
        };
        let binding = Binding {
            group_id: b"group",
            epoch: 4,
            commit: b"commit",
        };
        let envelope = seal(
            &crypto,
            &[3; 32],
            &binding,
            &link,
            &tokens,
            &[
                Recipient {
                    signer: broken.signer_pub(),
                    hpke_pub: vec![1, 2, 3],
                },
                Recipient {
                    signer: good.signer_pub(),
                    hpke_pub: good.hpke_pub().to_vec(),
                },
            ],
        )
        .unwrap();
        let open_as = |device: &LeafKeys| {
            open(
                &crypto,
                &[3; 32],
                &binding,
                &device.signer_pub(),
                device.hpke_private(),
                &envelope,
            )
            .unwrap()
        };
        assert_eq!(open_as(&good).tokens, tokens);
        let opened = open_as(&broken);
        assert_eq!(opened.tokens.edit, None);
        assert_eq!(opened.tokens.view, tokens.view);
    }
}
