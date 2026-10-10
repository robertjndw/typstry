# typstry

[![CI](https://github.com/robertjndw/typstry/actions/workflows/ci.yml/badge.svg)](https://github.com/robertjndw/typstry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

A self-hostable, real-time collaborative editor for [Typst](https://typst.app), built on CRDTs and end-to-end encrypted.

![typstry editor with a two-file project, an autocompletion popover listing table parameters, and the live preview on the right](docs/screenshot.png)

## Features

- **Real-time collaboration** - edits merge conflict-free through [Loro](https://loro.dev) CRDTs, with live cursors and presence for everyone in the project.
- **End-to-end encryption** - the project key lives only in the URL fragment and the browser, so the server stores ciphertext for documents and uploads alike.
- **In-browser compilation** - Typst compiles in a Web Worker via [typst.ts](https://github.com/Myriad-Dreamin/typst.ts), with a live SVG preview and inline diagnostics. Typst Universe packages are fetched on demand.
- **Autocompletion and docs** - [tinymist](https://github.com/Myriad-Dreamin/tinymist) runs in a second Web Worker for completions, hover docs and signature help, including your own functions and labels. File paths in `#include`, `#image` and similar calls complete from the project's files.
- **Offline-first** - projects are kept in IndexedDB, open without the server, and sync once the connection comes back.
- **Multi-file projects** - file tree, tabs, and uploads for images, fonts and data files. Images can also be pasted or dropped into the editor.
- **History** - save named versions, browse the edit history, diff and restore.
- **Sharing** - separate edit and view-only links, no accounts required.
- **Export** - download the compiled PDF or the whole project as a ZIP.

## Quick start

The easiest way to run typstry is Docker Compose:

```sh
docker compose up -d
```

Then open <http://localhost:8787>. Data is stored in the `typstry-data` volume. The first build compiles tinymist to wasm, so expect it to take several minutes.

Or build and run the image directly:

```sh
docker build -t typstry .
docker run -d -p 8787:8787 -v typstry-data:/data typstry
```

## How it works

```
┌──────────────── browser ────────────────┐          ┌──────── typstry-server ────────┐
│ CodeMirror ◄─► LoroDoc ◄─► IndexedDB    │  /ws     │ rooms (relay + compaction)     │
│                  │                      │ ◄──────► │ SQLite: encrypted doc records  │
│                  ├─► AES-GCM encrypt    │  /api    │ blobs/: encrypted uploads      │
│                  ├─► Typst worker ─► SVG│ ◄──────► │ static frontend                │
│                  └─► tinymist worker    │          │                                │
└─────────────────────────────────────────┘          └────────────────────────────────┘
```

Each project is a single Loro document holding the file tree, file contents and version list. Clients encrypt every update before it leaves the browser and send it over WebSocket, and the server relays and persists those records without being able to read them. The server only sees project and share-link tokens, record headers and blob sizes.

Because the key is part of the share link, anyone with the link can read the project. Treat edit links like passwords.

## Configuration

The server is configured through environment variables:

| Variable           | Default          | Description                                                  |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `TYPSTRY_ADDR`     | `127.0.0.1:8787` | Address to listen on (the Docker image uses `0.0.0.0:8787`). |
| `TYPSTRY_DATA_DIR` | `data`           | Directory for the SQLite database and uploaded blobs.        |
| `TYPSTRY_WEB_DIST` | `apps/web/dist`  | Built frontend to serve. Static serving is off if missing.   |
| `RUST_LOG`         | `info`           | Log filter, see [`tracing-subscriber`][env-filter].          |

Uploads are limited to 25 MB each. The container exposes `GET /healthz` for health checks.

[env-filter]: https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html

### Backups

The data directory contains `typstry.db` and a `blobs/` directory. Take a consistent copy of the database while the server is running with:

```sh
typstry-server backup /path/to/backup.db
# or, with Docker Compose:
docker compose exec typstry typstry-server backup /data/backup.db
```

Copy `blobs/` separately. Every record is written to the database as it arrives, so stopping the server does not lose edits.

## Development

### Prerequisites

- [Rust](https://rustup.rs) (stable, see `rust-toolchain.toml`; MSRV 1.94)
- [Node.js](https://nodejs.org) 26 or newer
- [pnpm](https://pnpm.io) 12 (`corepack enable` picks up the pinned version)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/), to build tinymist for the browser

### Getting started

```sh
pnpm install
apps/web/scripts/build-tinymist.sh
pnpm dev
```

The tinymist script builds the language server to wasm from a pinned commit into `apps/web/vendor/` (the npm package is only a stub). The first build takes a few minutes. Rerun it after the pinned commit changes.

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

CI runs on every push to `main` and on pull requests: everything in the table except `pnpm format:check` and the release server build, plus a Docker build with a smoke test.

The end-to-end tests drive the production build in Chromium through [Playwright](https://playwright.dev). They start the server on port 4787 with a throwaway data directory, or reuse one already running there. Install the browser once with `pnpm --filter web exec playwright install chromium`.

### Project layout

```
apps/web/              React + Vite frontend (editor, sync, encryption, Typst and tinymist workers)
crates/typstry-doc/    Shared Loro document schema, mirrored in apps/web/src/doc/schema.ts
crates/typstry-server/ Axum server: WebSocket rooms, REST API, SQLite and blob storage
```

The document schema exists on both sides. Changes to one must be reflected in the other, and incompatible layout changes bump `SCHEMA_VERSION`.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure formatting, linting and tests pass locally (see [Common tasks](#common-tasks)). Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

## License

Licensed under the [MIT License](https://opensource.org/licenses/MIT).
