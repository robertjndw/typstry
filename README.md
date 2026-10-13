# typstry

[![CI](https://github.com/robertjndw/typstry/actions/workflows/ci.yml/badge.svg)](https://github.com/robertjndw/typstry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hostable, real-time collaborative editor for [Typst](https://typst.app), built on CRDTs and end-to-end encrypted.

![typstry editor with a two-file project, an autocompletion popover listing table parameters, and the live preview on the right](docs/screenshot.png)

## Features

- **Real-time collaboration** - edits merge conflict-free through [Loro](https://loro.dev) CRDTs, with live cursors and presence for everyone in the project.
- **End-to-end encryption** - the project key lives only in the URL fragment and the browser, so the server stores ciphertext for documents and uploads alike.
- **In-browser compilation** - Typst compiles in a Web Worker via [typst.ts](https://github.com/Myriad-Dreamin/typst.ts), with a live SVG preview and inline diagnostics. Typst Universe packages are fetched on demand.
- **Autocompletion and docs** - [tinymist](https://github.com/Myriad-Dreamin/tinymist) runs in a second Web Worker for completions, hover docs and signature help, including your own functions and labels. File paths in `#include`, `#image` and similar calls complete from the project's files.
- **Offline-first** - projects are kept in IndexedDB, open without the server, and sync once the connection comes back.
- **Multi-file projects** - file tree, tabs, and uploads for images, fonts and data files. Images can also be pasted or dropped into the editor.
- **History** - browse the edit history, tag versions to find them again, preview, diff and restore.
- **Sharing and members** - separate edit and view-only links, no accounts required. Every device that opens a project joins its [MLS](https://www.rfc-editor.org/rfc/rfc9420) group, so members can see who is in a project and its owner can remove a member, which also replaces the links.
- **Your devices** - pair a phone, a laptop and the CLI with a short code to use them as one person. Your project list syncs between them, a lost device can be revoked from any other, and a recovery key brings everything back if all are lost.
- **Import and export** - start a project from a ZIP or a folder, and download the compiled PDF or the whole project as a ZIP.
- **Local editing and git** - the `typstry` CLI syncs a project with a local folder, so you can use your own editor and keep the files in your own git repository.

## Quick start

The quickest way to run typstry is the published image:

```sh
docker run -d -p 8787:8787 -v typstry-data:/data ghcr.io/robertjndw/typstry:latest
```

Then open <http://localhost:8787>. Data is stored in the `typstry-data` volume. `latest` is the newest release, `nightly` follows `main`, and every release also has its own version tag.

The repository's `compose.yaml` runs the same image with `docker compose up -d`.

Browsers only give typstry the APIs it needs on `localhost` or over HTTPS, so anywhere else run it behind a reverse proxy that terminates TLS. For an instance on the internet, `compose.prod.yaml` puts it behind Traefik with a Let's Encrypt certificate and per-address rate limits: set your domain in `.env` and run `docker compose -f compose.prod.yaml up -d`, see [Production with Traefik](docs/self-hosting.md#production-with-traefik). Anyone who can reach the server can create projects, see [Who can use your instance](docs/self-hosting.md#who-can-use-your-instance). [Self-hosting](docs/self-hosting.md) also covers configuration, backups and upgrading.

To build the image from a checkout instead (the first build compiles tinymist to wasm, so expect it to take several minutes):

```sh
docker build -t typstry .
docker run -d -p 8787:8787 -v typstry-data:/data typstry
```

## How it works

Each project is a single [Loro](https://loro.dev) document holding the file tree, file contents and version list. Your browser (or the `typstry` CLI) encrypts every change before it leaves your machine. The server stores and forwards the encrypted changes without being able to read them.

The key is in the share link, in the part after `#` that browsers never send to a server. Anyone with a link can read the project, so treat edit links like passwords. Only the person who created a project can remove members or replace the links, and a removed device cannot read anything written afterwards.

There are no accounts. Instead, every browser and CLI has its own device key, and you pair your devices with a short code so they act as one person and share your project list. A recovery key, 17 words to keep offline, gets you back in if you lose every device.

The [documentation](docs/README.md) explains all of this in more detail:

- [Architecture](docs/architecture.md): the parts of typstry and what the server can see.
- [Encryption](docs/encryption.md): share links, keys and generations.
- [Members and owners](docs/members-and-owners.md): who is in a project and how removal works.
- [Devices and accounts](docs/devices-and-accounts.md): pairing, your project list, lost devices and recovery keys.

See [SECURITY.md](SECURITY.md) for what the encryption protects and its known limits.

## Working locally with git

The `typstry` CLI links a folder to a project, so you can write in your own editor and keep the files in your own git repository. It encrypts on your machine like the browser does. Prebuilt binaries for Linux and macOS (x86_64 and arm64) are on the [releases page](https://github.com/robertjndw/typstry/releases). This installs the right one:

```sh
curl -fsSL https://raw.githubusercontent.com/robertjndw/typstry/main/install.sh | sh
```

It puts `typstry` in `~/.local/bin`. To get the latest `main` build, or to pin a release, set `TYPSTRY_VERSION` for `sh` (not for `curl`):

```sh
curl -fsSL https://raw.githubusercontent.com/robertjndw/typstry/main/install.sh | TYPSTRY_VERSION=nightly sh
```

Every release archive comes with a build provenance attestation. To check that a download was built by this repository's workflow, use the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify typstry-x86_64-unknown-linux-gnu.tar.gz --repo robertjndw/typstry
```

The images can be checked the same way with `gh attestation verify oci://ghcr.io/robertjndw/typstry:latest --repo robertjndw/typstry`.

To build from a checkout instead you need [Rust](https://rustup.rs) 1.99 or newer:

```sh
cargo install --path crates/typstry-cli
```

```sh
typstry clone 'https://typstry.example/p/<token>#<key>' thesis --git
cd thesis
typstry sync   # keep running and edit with any editor
```

See [the CLI guide](docs/cli.md) for a typical day with git, all commands and the things to know.

## Configuration

The server is configured through environment variables such as `TYPSTRY_ADDR`, `TYPSTRY_DATA_DIR` and `TYPSTRY_MAX_UPLOAD_BYTES`. [Self-hosting](docs/self-hosting.md#configuration) lists them all, including the [abuse limits](docs/self-hosting.md#abuse-limits), and explains [backups](docs/self-hosting.md#backups). Limits per client address are the reverse proxy's job; `compose.prod.yaml` sets them up in Traefik, see [the limits](docs/self-hosting.md#the-limits).

## Development

### Prerequisites

- [Rust](https://rustup.rs) 1.99, pinned in `rust-toolchain.toml`
- [Node.js](https://nodejs.org) 26 or newer
- [pnpm](https://pnpm.io) 12 (`corepack enable` picks up the pinned version)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/), to build tinymist and the crypto code for the browser

### Getting started

```sh
pnpm install
apps/web/scripts/build-tinymist.sh
pnpm --filter web wasm
pnpm dev
```

The tinymist script builds the language server to wasm from a pinned commit into `apps/web/vendor/` (the npm package is only a stub). The first build takes a few minutes. Rerun it after the pinned commit changes.

`pnpm --filter web wasm` builds `crates/typstry-wasm`, the encryption and MLS code the web app shares with the CLI, into `apps/web/vendor/typstry-wasm`. It takes about a minute. Rerun it after changing `typstry-wire` or `typstry-wasm`. Typecheck, tests and builds of the web app need both vendor directories.

This starts the Vite dev server for the frontend and the Rust server on port 8787, with Vite proxying `/api` and `/ws` to it. Set `TYPSTRY_BACKEND` to point Vite at a server on a different address.

### Common tasks

| Task           | Command                                                 |
| -------------- | ------------------------------------------------------- |
| Web tests      | `pnpm test`                                             |
| End-to-end     | `pnpm build && pnpm test:e2e`                           |
| Web lint/types | `pnpm lint`, `pnpm typecheck`                           |
| Format         | `pnpm format` (Prettier), `cargo fmt --all`             |
| Format check   | `pnpm format:check`, `cargo fmt --all --check`          |
| Rust tests     | `cargo test --workspace`                                |
| Rust lint      | `cargo clippy --workspace --all-targets -- -D warnings` |
| Production web | `pnpm build`                                            |
| Server binary  | `cargo build --release -p typstry-server`               |
| CLI binary     | `cargo build --release -p typstry-cli`                  |

`pnpm format` must leave `fixtures/` alone, so it is in `.prettierignore`: those files are frozen as typstry wrote them (see [Compatibility](docs/compatibility.md#frozen-fixtures)).

CI runs on every push to `main` and on pull requests: everything in the table except the release builds, plus a Docker build with a smoke test.

The end-to-end tests drive the production build in Chromium through [Playwright](https://playwright.dev). They start the server on port 4787 with a throwaway data directory, or reuse one already running there. Install the browser once with `pnpm --filter web exec playwright install chromium`.

### Project layout

```
apps/web/              React + Vite frontend (editor, sync, encryption, Typst and tinymist workers)
crates/typstry-cli/    The typstry CLI: clone, sync, push and pull a project with a local folder
crates/typstry-doc/    Shared Loro document schema, mirrored in apps/web/src/doc/schema.ts
crates/typstry-server/ Axum server: WebSocket rooms, REST API, SQLite and blob storage
crates/typstry-wasm/   typstry-wire built to wasm for the web app
crates/typstry-wire/   Record format, encryption, MLS groups, devices and pairing, shared by all of the above
docs/                  Documentation
```

The document schema exists on both sides. Changes to one must be reflected in the other, and incompatible layout changes bump `SCHEMA_VERSION`. [Compatibility](docs/compatibility.md) lists every versioned format and how to change one.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks to run and the commit message format.

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
