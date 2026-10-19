# Compatibility

Everything typstry stores or sends carries a version. They all started at
1 (secret kinds at 1 and 2), and every build has to keep reading what
earlier builds wrote. Old data is upgraded on read, never rewritten
wholesale.

## Versions

| What                                                       | Constant                                             | Where                                                                                                                                                                   | Bump when                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doc layout (`meta.schema`)                                 | `SCHEMA_VERSION`                                     | `crates/typstry-doc/src/lib.rs`, `apps/web/src/doc/schema.ts`                                                                                                           | An older client writing into the doc would corrupt it. Additive data older clients can ignore (like `deletedVersions`) needs no bump.                                           |
| Sealed blob / presence                                     | `SEAL_VERSION`                                       | `crates/typstry-wire/src/crypto.rs` (the web app runs the same code as wasm)                                                                                            | The sealed layout or key derivation changes.                                                                                                                                    |
| Doc record ciphertext                                      | `RECORD_VERSION`                                     | same                                                                                                                                                                    | The record body, signature or key derivation changes.                                                                                                                           |
| Keyring                                                    | `KEYRING_VERSION`                                    | same                                                                                                                                                                    | The keyring's plain layout changes. Readers refuse a newer one.                                                                                                                 |
| Secrets in links                                           | `SECRET_EDIT_V1`, `SECRET_VIEW_V1` (kind bytes)      | same                                                                                                                                                                    | Never bumped: a new secret format gets a new kind byte, and the old ones stay readable.                                                                                         |
| Saved MLS group state                                      | `MLS_STATE_VERSION` (first byte)                     | `crates/typstry-wire/src/mls/storage.rs`; stored in `.typstry/mls.bin` and IndexedDB                                                                                    | The saved layout changes, or the openmls pin below moves to a release that reads or writes group state differently.                                                             |
| Directory layout (`meta.schema` of the personal space doc) | `DIRECTORY_SCHEMA_VERSION`                           | `crates/typstry-doc/src/directory.rs`, `apps/web/src/directory/schema.ts`; stored in the browser's directory doc, the CLI's per-server directory and the personal space | An older client writing into the directory would corrupt it. Same rules as the doc layout.                                                                                      |
| Person graph                                               | `GRAPH_VERSION` (first byte)                         | `crates/typstry-wire/src/identity/graph.rs`; stored in the CLI's `person.graph` and the browser's person store, carried in leaf identities and pairing grants           | The graph's framing changes.                                                                                                                                                    |
| Person graph entry                                         | `ENTRY_VERSION` (first byte)                         | `crates/typstry-wire/src/identity/entry.rs`; inside every graph                                                                                                         | An entry's signed layout changes.                                                                                                                                               |
| Leaf identity (extension `0xff02`)                         | `IDENTITY_VERSION` (first byte)                      | `crates/typstry-wire/src/identity/binding.rs`; in every MLS leaf                                                                                                        | The device binding or the graph it carries is framed differently.                                                                                                               |
| Editor attestation leaf extension (`0xff00`)               | `EDITOR_VERSION` (first byte)                        | `crates/typstry-wire/src/mls/extensions.rs`; in every editor's leaf                                                                                                     | The attestation or the rotation HPKE key is framed differently.                                                                                                                 |
| Group policy (`0xff10`)                                    | `POLICY_VERSION` (first byte)                        | same; in the GroupContext                                                                                                                                               | The per-generation attestation keys or the owner tag are framed differently. Every member checks commits against it, so a bump needs every client to read the new layout first. |
| Owner key shares (`0xff03`)                                | `SHARES_VERSION`                                     | `crates/typstry-wire/src/mls/owner_share.rs`; in owners' leaves                                                                                                         | The share list or its HPKE sealing changes.                                                                                                                                     |
| Personal space pointer (`0xff04`)                          | `SHARES_VERSION`, `SPACE_VERSION` (sealed plaintext) | `crates/typstry-wire/src/mls/person_share.rs`; in every device's leaf, sealed to recovery keys                                                                          | The entry list, the tag or the sealed token and secret change.                                                                                                                  |
| Rotation envelope                                          | `ENVELOPE_VERSION` (first byte)                      | `crates/typstry-wire/src/mls/rotation.rs`; sent with every removal or reset commit through the delivery service                                                         | The view or edit part, or how they are bound to the commit, changes.                                                                                                            |
| Held owner key secrets                                     | `SET_VERSION` (first byte)                           | `crates/typstry-wire/src/owner.rs` (`OwnerSecrets::encode`); stored in the CLI's `.typstry/owner.bin` and with the browser's project in IndexedDB                       | The set's layout changes. A newer set is refused, never written over, since it may hold keys only a newer build reads.                                                          |
| Exported owner key secret                                  | `EXPORT_VERSION` (first byte)                        | same (`OwnerSecret::export`)                                                                                                                                            | The single-secret export changes. The directory keeps owner secrets bare, without this byte.                                                                                    |
| Pairing frames                                             | `FRAME_VERSION`, `HELLO_VERSION`, `GRANT_VERSION`    | `crates/typstry-wire/src/pairing/mod.rs`; sent between two devices over the relay while pairing                                                                         | A frame, the new device's hello or the sealed grant changes. Both devices run the same build in practice, but an old CLI paired with a new browser must fail cleanly.           |
| MLS delivery service messages                              | `DS_VERSION` (in `hello` / `ready`)                  | `crates/typstry-wire/src/ds.rs`                                                                                                                                         | The `/ws/mls` message layout changes. Peers on a newer version are refused, not guessed at.                                                                                     |
| Client/server protocol                                     | `PROTOCOL_VERSION`                                   | `crates/typstry-wire/src/lib.rs`, `apps/web/src/sync/protocol.ts`, served at `/api/info`                                                                                | The HTTP or WebSocket contract changes (new endpoint or field clients rely on, changed response or message).                                                                    |
| Oldest client served                                       | `MIN_PROTOCOL_VERSION`                               | `crates/typstry-wire/src/lib.rs`                                                                                                                                        | Only when older clients can no longer work correctly; everyone below it is told to upgrade or reload.                                                                           |
| CLI mailbox                                                | `mailbox::PROTOCOL`                                  | `crates/typstry-cli/src/mailbox.rs`                                                                                                                                     | An existing request or response changes meaning or shape. New requests need no bump.                                                                                            |
| CLI `config.json`, `base.json`                             | `CONFIG_VERSION`, `BASE_VERSION`                     | `crates/typstry-cli/src/state.rs`                                                                                                                                       | An older typstry would misread the file. Add the step to `CONFIG_MIGRATIONS` / `BASE_MIGRATIONS`.                                                                               |
| CLI `doc.log`                                              | `LOG_FORMAT` (after the `TYPSTRYL` magic)            | `crates/typstry-cli/src/state.rs`                                                                                                                                       | Entries are framed differently. An older build drops a newer log, since it is only a cache.                                                                                     |
| Browser IndexedDB                                          | `DB_VERSION`                                         | `apps/web/src/persist/local-doc-store.ts`                                                                                                                               | The object stores or indexes change. Append an `oldVersion < n` step; never edit an earlier one.                                                                                |
| Folder link (`FolderLink.v`)                               | `FolderLink.v`                                       | `apps/web/src/folder/base.ts`; stored in the `folders` store of the browser's IndexedDB, with the linked folder's handle and the sync base                              | The stored link or base is shaped differently. Readers drop a base they can't trust, which makes the next sync start from a fresh comparison.                                   |
| Browser caches                                             | `BLOB_CACHE`, `FONT_CACHE` suffixes                  | `apps/web/src/typst/cache-names.ts`                                                                                                                                     | The cached payload changes. Old caches are pruned on boot.                                                                                                                      |
| Server database                                            | sqlx migrations                                      | `crates/typstry-server/migrations/`                                                                                                                                     | Any schema change.                                                                                                                                                              |

Versions start at 1, so a version byte of 0 is damaged data, not a newer
format. The keyring, person graph, graph entry, leaf identity, pairing
frames and hello, and saved MLS state report it as malformed instead of
asking for an update. Held owner key secrets of a newer version are kept
as they are: the web app and the CLI refuse to save over them.

Keep the Rust and TypeScript copies of a constant equal. The crypto,
identity, pairing and MLS constants live in Rust only; the web app reads
them from the wasm.

## The openmls pin

`openmls` is `=0.9.1` (with `openmls_basic_credential` and
`openmls_rust_crypto` `=0.6.0`, `openmls_traits` `=0.6.0`) in the workspace
`Cargo.toml`. It is 0.x and its group state is not a stable format, so the
whole set is pinned exactly. Our saved state (`MLS_STATE_VERSION`) embeds
what openmls stores, so a new openmls release needs one of two things in
the same change as the bump:

- an import step that reads state written by the old pin, bumping
  `MLS_STATE_VERSION` if the saved layout changes, or
- a fallback that drops state it cannot read, so the device joins its
  groups again with an external commit (what `load_mls` does for a damaged
  file). Rejoining loses the device's old leaf, so it shows up as a new
  member.

Also check that the wire format of commits and GroupInfo stayed
compatible, since devices on the old and new pin share a group.

## Rules

- Readers handle every version from 1 up. Anything newer than the build
  knows is refused with an "upgrade typstry" error, not guessed at, since
  writing into a newer doc would corrupt it for everyone.
- Doc migrations are deterministic and idempotent. Two peers can migrate
  the same doc at once and the CRDT keeps both sets of ops, so every peer
  has to write the same thing, and rerunning a step on a (partly) migrated
  doc must change nothing. No random ids, timestamps or anything from the
  peer. `MIGRATIONS` in `lib.rs` and `schema.ts` must agree step by step.
- sqlx migrations are append-only. Add `0002_*.sql` and so on, and never
  edit one that has shipped: sqlx checks their checksums against databases
  that already ran them.

## Frozen fixtures

Nothing was released before MLS, so v1 was regenerated for it (a single
project key became link secret, keyring and group) rather than adding a
v2. The directory is frozen from the first release on.

`fixtures/compat/v<N>/` holds data as typstry wrote it at format version N:
a project doc, the signed keyring, encrypted records, blob, profile and
presence, secrets and share links, the CLI's `.typstry/` files
(including the saved group state), and a person's directory
(`directory.loro`, with what it must list in `directory.json`). Each
directory is generated once
and then never regenerated or edited. The `compat` tests in typstry-wire,
typstry-doc, typstry-cli and `apps/web/src/compat.test.ts` read every
`v<N>` with the current code.

To bump a format version:

1. Add the reader for the new format and keep the old one working
   (migration step, new kind byte, and so on).
2. Write the next fixture set with
   `TYPSTRY_WRITE_COMPAT=<N> cargo test -p typstry-cli --test compat`,
   where N is one above the newest directory, then add the directory to
   it with
   `TYPSTRY_WRITE_COMPAT_DIRECTORY=<N> cargo test -p typstry-doc --test compat`.
   Neither overwrites what exists.
3. Commit the new directory with the change. The guard tests fail until it
   exists, since otherwise nothing would read the new format.

`TYPSTRY_WRITE_FIXTURES=1` and `pnpm --filter web fixtures` rewrite the
cross-language fixtures under `crates/*/tests/fixtures/`, which follow the
current code. They never touch `fixtures/compat/`.
