# Compatibility

Everything typstry stores or sends carries a version. They all started at
1 (secret kinds at 1 and 2), and every build has to keep reading what
earlier builds wrote. Old data is upgraded on read, never rewritten
wholesale.

## Versions

| What                           | Constant                                        | Where                                                                                    | Bump when                                                                                                                             |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Doc layout (`meta.schema`)     | `SCHEMA_VERSION`                                | `crates/typstry-doc/src/lib.rs`, `apps/web/src/doc/schema.ts`                            | An older client writing into the doc would corrupt it. Additive data older clients can ignore (like `deletedVersions`) needs no bump. |
| Sealed blob / presence         | `SEAL_VERSION`                                  | `crates/typstry-wire/src/crypto.rs`, `apps/web/src/crypto/project-key.ts`                | The sealed layout or key derivation changes.                                                                                          |
| Doc record ciphertext          | `RECORD_VERSION`                                | same                                                                                     | The record body, signature or key derivation changes.                                                                                 |
| Secrets in links               | `SECRET_EDIT_V1`, `SECRET_VIEW_V1` (kind bytes) | same                                                                                     | Never bumped: a new secret format gets a new kind byte, and the old ones stay readable.                                               |
| Client/server protocol         | `PROTOCOL_VERSION`                              | `crates/typstry-wire/src/lib.rs`, `apps/web/src/sync/protocol.ts`, served at `/api/info` | The HTTP or WebSocket contract changes (new endpoint or field clients rely on, changed response or message).                          |
| Oldest client served           | `MIN_PROTOCOL_VERSION`                          | `crates/typstry-wire/src/lib.rs`                                                         | Only when older clients can no longer work correctly; everyone below it is told to upgrade or reload.                                 |
| CLI mailbox                    | `mailbox::PROTOCOL`                             | `crates/typstry-cli/src/mailbox.rs`                                                      | An existing request or response changes meaning or shape. New requests need no bump.                                                  |
| CLI `config.json`, `base.json` | `CONFIG_VERSION`, `BASE_VERSION`                | `crates/typstry-cli/src/state.rs`                                                        | An older typstry would misread the file. Add the step to `CONFIG_MIGRATIONS` / `BASE_MIGRATIONS`.                                     |
| CLI `doc.log`                  | `LOG_FORMAT` (after the `TYPSTRYL` magic)       | `crates/typstry-cli/src/state.rs`                                                        | Entries are framed differently. An older build drops a newer log, since it is only a cache.                                           |
| Browser IndexedDB              | `DB_VERSION`                                    | `apps/web/src/persist/local-doc-store.ts`                                                | The object stores or indexes change. Append an `oldVersion < n` step; never edit an earlier one.                                      |
| Browser caches                 | `BLOB_CACHE`, `FONT_CACHE` suffixes             | `apps/web/src/typst/cache-names.ts`                                                      | The cached payload changes. Old caches are pruned on boot.                                                                            |
| Server database                | sqlx migrations                                 | `crates/typstry-server/migrations/`                                                      | Any schema change.                                                                                                                    |

Keep the Rust and TypeScript copies of a constant equal.

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

`fixtures/compat/v<N>/` holds data as typstry wrote it at format version N:
a project doc, encrypted records, blob and presence, secrets and share
links, and the CLI's `.typstry/` files. Each directory is generated once
and then never regenerated or edited. The `compat` tests in typstry-wire,
typstry-doc, typstry-cli and `apps/web/src/compat.test.ts` read every
`v<N>` with the current code.

To bump a format version:

1. Add the reader for the new format and keep the old one working
   (migration step, new kind byte, and so on).
2. Write the next fixture set with
   `TYPSTRY_WRITE_COMPAT=<N> cargo test -p typstry-cli --test compat`,
   where N is one above the newest directory. It won't overwrite an
   existing directory.
3. Commit the new directory with the change. The guard tests fail until it
   exists, since otherwise nothing would read the new format.

`TYPSTRY_WRITE_FIXTURES=1` and `pnpm --filter web fixtures` rewrite the
cross-language fixtures under `crates/*/tests/fixtures/`, which follow the
current code. They never touch `fixtures/compat/`.
