# Compatibility fixtures, format v1

Generated once with `TYPSTRY_WRITE_COMPAT=1 cargo test -p typstry-cli --test compat`
when these formats were frozen. Don't regenerate or edit anything in here.
Every later typstry has to keep reading it, which the `compat` tests of
typstry-wire, typstry-doc and typstry-cli and `apps/web/src/compat.test.ts`
check against the current code.

When a format version goes up (see `versions.json` and
`docs/compatibility.md`), add a new `v<N>` directory with the generator
instead of touching this one.

- `versions.json`: the format versions in force when this was written.
- `doc.loro`, `doc.json`: a project snapshot (text files, an asset, peers,
  named versions, a deleted version) and what it has to read as.
- `crypto.json`: edit and view secrets, share links, a delta and a snapshot
  record (the snapshot's plaintext is `doc.loro`), a sealed blob (the asset
  in the doc) and a sealed presence update, with their plaintexts.
- `cli/`: the CLI's `.typstry/` files (`config.json`, `base.json`,
  `doc.bin`, `doc.log` with its header), `cli.json` what they hold.
