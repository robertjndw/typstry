# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, open an issue first so we can agree on the approach.

## Setting up

The [Development](README.md#development) section of the README lists the prerequisites and how to build the wasm parts and start the dev server. [The documentation](docs/README.md) explains how typstry works.

## Before opening a pull request

Run the same checks as CI:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`pnpm format` and `cargo fmt --all` fix formatting. For changes that touch the editor, sync or the CLI, also run the end-to-end tests with `pnpm build && pnpm test:e2e`.

The code has to build with Rust 1.94, the `rust-version` in `Cargo.toml`. CI checks this, so avoid newer standard library APIs or bump the version on purpose.

## Formats and fixtures

Stored data and the wire format are versioned. [Compatibility](docs/compatibility.md) lists every format and how to change one. In short:

- The document schema exists in `crates/typstry-doc` and in `apps/web/src/doc/schema.ts`. Change both together.
- Never edit or regenerate anything under `fixtures/compat/`. A format change adds a new `v<N>` directory instead.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org): `type: subject`, with a lowercase subject and no trailing period. Use `feat`, `fix`, `refactor`, `docs`, `chore`, `test` or `build`.

## Security issues

Please do not open a public issue for a vulnerability. [SECURITY.md](SECURITY.md) describes how to report one privately.
