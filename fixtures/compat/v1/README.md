# Compatibility fixtures, format v1

Generated once with `TYPSTRY_WRITE_COMPAT=1 cargo test -p typstry-cli --test compat`
when these formats were frozen. Don't regenerate or edit anything in here.
Every later typstry has to keep reading it, which the `compat` tests of
typstry-wire, typstry-doc and typstry-cli and `apps/web/src/compat.test.ts`
check against the current code.

When a format version goes up (see `versions.json` and
`docs/compatibility.md`), add a new `v<N>` directory with the generator
instead of touching this one.

The v1 set was written for the MLS format. An earlier draft of v1 (one
project key, no groups) was dropped before any release, so nothing in the
wild uses it. v1 was re-frozen once more before release when device keys,
the person graph and person-bound ownership replaced the shared person key
and the owner keys; the sets are regenerated, not migrated.

- `versions.json`: the format versions in force when this was written,
  including `mlsState` (the saved group state) and `ds` (the delivery
  service messages).
- `doc.loro`, `doc.json`: a project snapshot (text files, an asset, peers,
  named versions, a deleted version) and what it has to read as.
- `crypto.json`: the edit and view secrets and share links; the signed,
  sealed keyring with its key id and generation 1 doc key; a fixed device
  key with the editor attestation made for it; a delta and a snapshot
  record signed by that device (the snapshot's plaintext is `doc.loro`); a
  generation-tagged blob (the asset in the doc); a sealed profile; and a
  presence update, with the raw presence key, epoch and leaf it was sealed
  under (MLS derives that key per epoch, so it is stored here as is). All
  with their plaintexts.
- `cli/`: the CLI's `.typstry/` files (`config.json`, `base.json`,
  `doc.bin`, `doc.log` with its header, `mls.bin` the saved group state),
  `cli.json` what they hold. `mls.bin` comes from a real group, so its
  keys are random and only its public facts are recorded.
