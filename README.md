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
- **History** - browse the edit history, tag versions to find them again, preview, diff and restore.
- **Sharing** - separate edit and view-only links, no accounts required.
- **Export** - download the compiled PDF or the whole project as a ZIP.
- **Local editing and git** - the `typstry` CLI syncs a project with a local folder, so you can use your own editor and keep the files in your own git repository.

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
│                  ├─► encrypt + sign     │  /api    │ blobs/: encrypted uploads      │
│                  ├─► Typst worker ─► SVG│ ◄──────► │ static frontend                │
│                  └─► tinymist worker    │          │                                │
└─────────────────────────────────────────┘          └────────────────────────────────┘
```

Each project is a single Loro document holding the file tree, file contents and version list. The browser and the `typstry` CLI encrypt every update before it leaves your machine and send it over WebSocket, and the server relays and persists those records without being able to read them. The server only sees project and share-link tokens, record headers and blob sizes.

Because the key is part of the share link, anyone with the link can read the project. Treat edit links like passwords.

An edit link carries a 32-byte secret. Two keys are derived from it with HKDF-SHA256: a read key and an Ed25519 signing key. A view link carries only the read key and the public key. Every message is encrypted with AES-256-GCM under a key derived from the read key and a fresh random salt, and every doc update is signed. Viewers can decrypt and verify, but other clients refuse updates they did not sign with the edit key, so a view link stays read-only even if the server is compromised. A compromised server can still withhold or roll back updates, and it serves the app's JavaScript.

## Working locally with git

The `typstry` CLI links a folder to a project. It encrypts and decrypts on your machine like the browser does, so the server still only sees ciphertext.

It isn't part of the Docker image. Install it from a checkout with [Rust](https://rustup.rs) 1.94 or newer:

```sh
cargo install --path crates/typstry-cli
```

typstry moves the current state of the files between people, live. Git keeps the snapshots you decide to commit. The CLI never commits for you (except the first commit of `clone --git`), so branches, rebase, hooks and remotes work as usual.

Pick one way to get edits from your co-authors. If they use typstry, don't also `git pull` the same edits from a shared remote, or they arrive twice. Your git history can be your own, or one person can keep the shared repository for the group.

### A normal day

```sh
# Once, joining an existing project
typstry clone 'https://typstry.example/p/<token>#<key>' thesis --git
# Once, starting from a repository you already have
cd thesis && typstry init --server https://typstry.example   # prints the links to share

# Writing: keep sync running and use any editor
typstry sync
#   ↓ chapters/intro.typ
#   ↑ chapters/method.typ

# Checkpoints, in another terminal while sync runs.
# Co-author edits show up as normal changes.
git status
git commit -am "method section draft"

# A private draft: sync pauses while you are off the tracked branch
git commit -am "before rewrite"
git switch -c rewrite-results
git commit -am "restructure results"
git switch main                 # sync resumes and catches up
git merge rewrite-results       # published to everyone as one edit

# Backup and milestones
git push
typstry version save "sent to supervisor"
git tag sent-to-supervisor
```

Without the live mode, the same day is `typstry pull`, edit, then `typstry push`. `pull` leaves files that changed on both sides alone and lists them. `push` merges your changes with anything edited in the meantime and lists files changed on both sides so you can review them with `git diff`.

### Commands

| Command                         | What it does                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `clone <link> [dir] [--git]`    | Copy a project into a new folder. `--git` also creates a repository and commits it  |
| `init [dir]`                    | Turn a folder (for example an existing git repository) into a new project           |
| `sync`                          | Keep the folder and the project in sync until Ctrl+C                                |
| `status`, `pull`, `push`        | One-shot sync: show, receive or publish changes. While `sync` runs, it answers them |
| `link`, `open`                  | Print the edit and view links, or open the project in the browser                   |
| `info`                          | Project, permission, tracked branch and pending changes                             |
| `version list`, `version save`  | Named versions (tags in the browser's history panel). Also work while `sync` runs   |
| `export [--at <version>] <dir>` | Write the project, now or at a named version, to a plain folder                     |
| `track <branch>`                | Change the git branch typstry syncs on (stop `sync` first)                          |

Every command takes `-C <dir>` to run as if started in another folder, and `--name <name>` to set the author name shown in the project history (defaults to `git config user.name`). `typstry <command> --help` shows all options.

| Variable          | Used for                                                        |
| ----------------- | --------------------------------------------------------------- |
| `TYPSTRY_LINK`    | The share link for `clone` when the argument is left out        |
| `TYPSTRY_SERVER`  | The server for `init` when `--server` is left out               |
| `TYPSTRY_BROWSER` | The program `open` starts instead of the system default browser |
| `TYPSTRY_LOG`     | Log filter in `RUST_LOG` syntax, `warn` by default              |

### Things to know

- **The tracked branch.** typstry syncs on one git branch, the one checked out when the folder was first linked. On any other branch, or while git is merging or rebasing, `sync` pauses and `pull`/`push` refuse unless you pass `--force`.
- **Coming back from a branch.** If the files differ from the last sync when you return to the tracked branch, `sync` keeps receiving but holds back your outgoing changes. Otherwise a co-author edit that you only committed on the other branch would look like a deletion. Files changed on both sides wait too. The same applies after `git reset`, and when you switched branches while `sync` was not running. Check with `typstry status`, then publish by typing `push` in the sync terminal, running `typstry push --force`, or starting `sync` with `--publish`. Committing on the tracked branch before switching avoids this.
- **Commands next to `sync`.** While `sync` runs, `status`, `info`, `version list`, `version save` and `push` in the same folder ask it instead of failing. `version save` and `push` publish what is on disk right away, so a version saved just after a save includes it. Both refuse while `sync` is paused, and need `--force` while it holds back changes after a branch switch, like the one-shot versions. `pull` only says that `sync` already pulls. `track` and `export` refuse to start until `sync` is stopped.
- **The key lives in `.typstry/`.** That folder holds the link and a local cache. It ignores itself with its own `.gitignore` and is also added to `.git/info/exclude`. Never commit it. To keep the link out of your shell history, pass it on standard input (`pbpaste | typstry clone - thesis`) or in `TYPSTRY_LINK`.
- **Ignored files.** `.gitignore` and an optional `.typstryignore` decide which files are synced, so build output such as PDFs stays local. git's own files (`.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`) and `.typstryignore` itself are not synced either; re-include one with a negated pattern in `.typstryignore`, such as `!.gitignore`. An ignored file is never written to the folder, and removing or editing it locally never changes the project. A file the project gets from someone else never replaces a local file that is not synced, or one whose name only differs in case on macOS and Windows.
- **Editors.** Files can change on disk while you edit them. Let your editor reload changed files automatically (VS Code does this for files without unsaved changes).

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
| CLI binary     | `cargo build --release -p typstry-cli`                  |

CI runs on every push to `main` and on pull requests: everything in the table except `pnpm format:check` and the release builds, plus a Docker build with a smoke test.

The end-to-end tests drive the production build in Chromium through [Playwright](https://playwright.dev). They start the server on port 4787 with a throwaway data directory, or reuse one already running there. Install the browser once with `pnpm --filter web exec playwright install chromium`.

### Project layout

```
apps/web/              React + Vite frontend (editor, sync, encryption, Typst and tinymist workers)
crates/typstry-cli/    The typstry CLI: clone, sync, push and pull a project with a local folder
crates/typstry-doc/    Shared Loro document schema, mirrored in apps/web/src/doc/schema.ts
crates/typstry-server/ Axum server: WebSocket rooms, REST API, SQLite and blob storage
crates/typstry-wire/   Encrypted record format and fragmentation, shared by the server and the CLI
```

The document schema exists on both sides. Changes to one must be reflected in the other, and incompatible layout changes bump `SCHEMA_VERSION`.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please make sure formatting, linting and tests pass locally (see [Common tasks](#common-tasks)). Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

## License

Licensed under the [MIT License](https://opensource.org/licenses/MIT).
