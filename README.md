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
│                  ├─► encrypt + sign     │  /ws/mls │ blobs/: encrypted uploads      │
│                  ├─► MLS group (wasm)   │ ◄──────► │ delivery service: MLS commits  │
│                  ├─► Typst worker ─► SVG│  /api    │ static frontend                │
│                  └─► tinymist worker    │ ◄──────► │                                │
└─────────────────────────────────────────┘          └────────────────────────────────┘
```

Each project is a single Loro document holding the file tree, file contents and version list. The browser and the `typstry` CLI encrypt every update before it leaves your machine and send it over WebSocket, and the server relays and persists those records without being able to read them. The server only sees project and share-link tokens, record headers, blob sizes and the size and timing of group messages.

Anyone with a share link can read the project, so treat edit links like passwords. An edit link carries a 32-byte secret, from which HKDF-SHA256 derives a read key and an Ed25519 attestation key. A view link carries only the read key and the public attestation key.

Documents are not encrypted under the link secret itself but under per-generation document keys. The server stores a keyring holding the keys of every generation so far, sealed under the link and signed with the attestation key, so a viewer can open it but cannot forge one. A generation changes only when the owner removes a member or resets the links. Every update, blob and profile is encrypted with AES-256-GCM under a key derived from the generation's document key and a fresh random salt, and says which generation it belongs to.

Each device that opens a project joins the project's MLS group (RFC 9420, via [openmls](https://github.com/openmls/openmls)) with its own signing key and a profile (name and color) that only members can read. A browser profile and a CLI folder are separate devices. Every update is signed with the device key and carries an editor's attestation of that key. Other clients refuse updates without a valid attestation, so a view link stays read-only even if the server is compromised, and the authors shown in the UI are authenticated. Presence is sealed under a key of the current group epoch and signed per device.

The server acts as the group's delivery service. A newcomer with the link fetches the group's GroupInfo from it, encrypted under the link, and joins with an MLS external commit, so nobody has to be online to let them in. The server orders commits (the first one for an epoch wins) and stores and relays them as opaque bytes. It never holds a key and cannot read or add members. Editing does not wait on the group: if it stalls, documents keep syncing.

Only the project's owner can remove members or reset the links. The owner is a person rather than a key: the group state names the creator's person by a tag that only members can compute and that differs between projects, and any valid device of that person counts as the owner. To remove a member, the owner commits the removal together with a new generation: a new edit secret, document key, keyring and server tokens. The commit's rotation message carries the new links to the members who stay, so they switch automatically. The server swaps the tokens in one step, closes stale connections and keeps the old tokens only to let members who were offline catch up. The removed device can no longer follow the group or read new data. It keeps whatever it already had, and it still holds the old link, so see [SECURITY.md](SECURITY.md) for what removal does and does not cover.

A person is a set of devices. Each browser and CLI has its own device key, which never leaves it. The devices that belong together are listed in a person graph: entries such as "add this device", "revoke that one" or "set name and color", each signed by a device that was valid at the time and linked to the entries it builds on, like commits in git. Two devices can write to it at the same time and the copies merge: a revoke always wins, and whatever a revoked device added before it was revoked stays. The person is identified by the graph's first entry, so no secret is shared between devices. In each project a device signs its per-project leaf key with its device key, and the leaf carries the graph, sealed so that only members can read it and the server cannot link a person across projects.

To add a device, one device shows a short code (`42-ivory-galaxy`) as text, QR code or link, and the other enters it. The two run SPAKE2 over a one-off relay channel on the server, and after a confirmation on the device that already belongs to the person, it adds the new device to the graph and hands over the graph and the project links. The server only relays and never sees the code. A lost device is revoked from any other one: the revoke spreads with the graph, the device loses its owner rights at once, and each device of the person that can edit a project removes the revoked device from it and replaces the links. A recovery key, 17 words to keep offline, can add a new device and revoke the others when every device is gone.

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
# Once, on a new device after `typstry pair`: see your projects, copy one by number
typstry list
typstry clone 2
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

| Command                                      | What it does                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `clone <link> [dir] [--git]`                 | Copy a project into a new folder. `--git` also creates a repository and commits it                             |
| `init [dir]`                                 | Turn a folder (for example an existing git repository) into a new project                                      |
| `sync`                                       | Keep the folder and the project in sync until Ctrl+C                                                           |
| `status`, `pull`, `push`                     | One-shot sync: show, receive or publish changes. While `sync` runs, it answers them                            |
| `link`, `open`                               | Print the edit and view links, or open the project in the browser                                              |
| `info`                                       | Project, permission, tracked branch and pending changes                                                        |
| `version list`, `version save`               | Named versions (tags in the browser's history panel). Also work while `sync` runs                              |
| `export [--at <version>] <dir>`              | Write the project, now or at a named version, to a plain folder                                                |
| `track <branch>`                             | Change the git branch typstry syncs on (stop `sync` first)                                                     |
| `pair [code]`                                | Add a device: without a code, show one to enter on the other device; with one, pair with the device showing it |
| `devices [revoke <device>]`                  | List the devices that are you, or revoke a lost one and remove it from your projects                           |
| `devices recovery`, `devices recover <link>` | Create a recovery key, or use one to make this machine you again after losing every device                     |
| `devices profile`                            | Show your name and color, or set them for all your devices with `--name` and `--color`                         |

Every command takes `-C <dir>` to run as if started in another folder, and `--name <name>` to set the author name shown in the project history (defaults to `git config user.name`). `typstry <command> --help` shows all options.

| Variable             | Used for                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `TYPSTRY_LINK`       | The share link for `clone` when the argument is left out                                                              |
| `TYPSTRY_SERVER`     | The server for `init` when `--server` is left out                                                                     |
| `TYPSTRY_BROWSER`    | The program `open` starts instead of the system default browser                                                       |
| `TYPSTRY_LOG`        | Log filter in `RUST_LOG` syntax, `warn` by default                                                                    |
| `TYPSTRY_CONFIG_DIR` | Where the device key, the person graph and the list of project folders live, instead of the platform config directory |

### Things to know

- **The tracked branch.** typstry syncs on one git branch, the one checked out when the folder was first linked. On any other branch, or while git is merging or rebasing, `sync` pauses and `pull`/`push` refuse unless you pass `--force`.
- **Coming back from a branch.** If the files differ from the last sync when you return to the tracked branch, `sync` keeps receiving but holds back your outgoing changes. Otherwise a co-author edit that you only committed on the other branch would look like a deletion. Files changed on both sides wait too. The same applies after `git reset`, and when you switched branches while `sync` was not running. Check with `typstry status`, then publish by typing `push` in the sync terminal, running `typstry push --force`, or starting `sync` with `--publish`. Committing on the tracked branch before switching avoids this.
- **Commands next to `sync`.** While `sync` runs, `status`, `info`, `version list`, `version save` and `push` in the same folder ask it instead of failing. `version save` and `push` publish what is on disk right away, so a version saved just after a save includes it. Both refuse while `sync` is paused, and need `--force` while it holds back changes after a branch switch, like the one-shot versions. `pull` only says that `sync` already pulls. `track` and `export` refuse to start until `sync` is stopped.
- **The key lives in `.typstry/`.** That folder holds the link and a local cache. It ignores itself with its own `.gitignore` and is also added to `.git/info/exclude`. Never commit it. To keep the link out of your shell history, pass it on standard input (`pbpaste | typstry clone - thesis`) or in `TYPSTRY_LINK`.
- **Ignored files.** `.gitignore` and an optional `.typstryignore` decide which files are synced, so build output such as PDFs stays local. git's own files (`.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`) and `.typstryignore` itself are not synced either; re-include one with a negated pattern in `.typstryignore`, such as `!.gitignore`. An ignored file is never written to the folder, and removing or editing it locally never changes the project. A file the project gets from someone else never replaces a local file that is not synced, or one whose name only differs in case on macOS and Windows.
- **Editors.** Files can change on disk while you edit them. Let your editor reload changed files automatically (VS Code does this for files without unsaved changes).

## Configuration

The server is configured through environment variables:

| Variable                        | Default             | Description                                                                              |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `TYPSTRY_ADDR`                  | `127.0.0.1:8787`    | Address to listen on (the Docker image uses `0.0.0.0:8787`).                             |
| `TYPSTRY_DATA_DIR`              | `data`              | Directory for the SQLite database and uploaded blobs.                                    |
| `TYPSTRY_WEB_DIST`              | `apps/web/dist`     | Built frontend to serve. Static serving is off if missing.                               |
| `TYPSTRY_MAX_UPLOAD_BYTES`      | `26214400` (25 MiB) | Largest asset upload.                                                                    |
| `TYPSTRY_ROOM_UNLOAD_SECS`      | `60`                | How long a project stays loaded after its last client left.                              |
| `TYPSTRY_PRESENCE_TIMEOUT_SECS` | `30`                | How long a client's cursor stays visible without a refresh.                              |
| `TYPSTRY_UPDATE_BURST`          | `200`               | Document records (and presence updates) one connection may send in a burst.              |
| `TYPSTRY_UPDATES_PER_SEC`       | `50`                | Sustained records per second per connection, after the burst.                            |
| `TYPSTRY_MAX_ROOMS_PER_CONN`    | `8`                 | Rooms one connection may join; a project takes two.                                      |
| `TYPSTRY_OUTBOX_BYTES`          | `67108864` (64 MiB) | Live updates queued for a slow client before it is dropped. Does not limit the doc size. |
| `RUST_LOG`                      | `info`              | Log filter, see [`tracing-subscriber`][env-filter].                                      |

The container exposes `GET /healthz` for health checks.

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

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Licensed under the [MIT License](LICENSE).
