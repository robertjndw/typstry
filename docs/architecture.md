# Architecture

typstry has three parts:

- **The web app** runs in your browser. It holds the editor, compiles Typst, and does all encryption.
- **The `typstry` CLI** does the same work as the web app, but for a folder on your computer. See [the CLI guide](cli.md).
- **The server** stores and forwards encrypted data. It never has the keys, so it cannot read your documents.

```
┌──────────────── browser ────────────────┐          ┌──────── typstry-server ────────┐
│ CodeMirror ◄─► LoroDoc ◄─► IndexedDB    │  /ws     │ rooms (relay + compaction)     │
│                  │                      │ ◄──────► │ SQLite: encrypted doc records  │
│                  ├─► encrypt + sign     │  /ws/mls │ blobs/: encrypted uploads      │
│                  ├─► MLS group (wasm)   │ ◄──────► │ delivery service: MLS commits  │
│                  ├─► Typst worker ─► SVG│  /api    │ pairing relay                  │
│                  └─► tinymist worker    │ ◄──────► │ static frontend                │
└─────────────────────────────────────────┘          └────────────────────────────────┘
```

## The document

Each project is one [Loro](https://loro.dev) document. Loro is a CRDT: a data structure that many people can change at the same time, even offline, and that always merges to the same result. The document holds:

- the file tree and the content of every text file,
- references to uploaded files such as images and fonts (the files themselves are stored separately as encrypted blobs),
- the list of tagged versions.

The browser keeps a copy of every project in IndexedDB. This is why projects open without a connection: you edit the local copy, and the changes are sent when the connection comes back.

The document layout is defined twice, in `crates/typstry-doc` (Rust, used by the CLI) and in `apps/web/src/doc/schema.ts` (TypeScript, used by the web app). The two must always match.

## In the browser

- **CodeMirror** is the text editor. It is bound to the Loro document, so every keystroke becomes a small document change.
- **The Typst worker** compiles the project with [typst.ts](https://github.com/Myriad-Dreamin/typst.ts) in a background thread and draws the result as SVG. Packages from Typst Universe are downloaded from `packages.typst.org` when a document imports them, and Typst's default fonts from `cdn.jsdelivr.net`. A build can point the fonts at a mirror with `VITE_TYPST_FONT_BASE` (and `VITE_TYPST_DEV_FONT_BASE` for the CJK and emoji fonts), set when the web app is built. See [Self-hosting](self-hosting.md). A build with `VITE_TYPSTRY_LOCAL_ONLY=1` leaves out everything that needs the server and keeps projects in the browser, see [Static hosting](static-hosting.md).
- **The tinymist worker** runs the [tinymist](https://github.com/Myriad-Dreamin/tinymist) language server for autocompletion, hover docs and signature help.
- **The wasm module** (`crates/typstry-wasm`) holds the encryption and group code. It is the same Rust code the CLI uses, compiled to WebAssembly, so both sides encrypt in exactly the same way.

## What happens when you type

1. CodeMirror changes the local Loro document.
2. The change is saved to IndexedDB.
3. The change is encrypted, signed with your member key for this project (which your device key vouches for), and sent to the server over the `/ws` WebSocket.
4. The server stores the encrypted record and forwards it to everyone else who has the project open.
5. The other browsers check the signature, decrypt the record and merge it into their copy.

Cursors and names of the people currently in the project ("presence") travel the same way, but they are not stored.

The server cannot merge records, because it cannot read them. Its log of records would grow forever, so from time to time a client uploads an encrypted snapshot of the whole document, and the server drops the records the snapshot already contains.

## The server

The server is a single Rust program (`crates/typstry-server`) with a SQLite database and a folder for uploaded files. It does five jobs:

| Job              | Connection  | What it does                                                                                                                                                          |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document rooms   | `/ws`       | Stores encrypted document records and forwards them to everyone in the project. Forwards presence without storing it.                                                 |
| Uploads          | `/api`      | Stores and serves encrypted files (images, fonts, data files).                                                                                                        |
| Delivery service | `/ws/mls`   | Stores and forwards the messages that change who is in a project. It decides the order of these messages, but cannot read them. See [members](members-and-owners.md). |
| Pairing relay    | `/ws/relay` | Connects two of your devices for a moment while you pair them. See [devices](devices-and-accounts.md).                                                                |
| Static files     | `/`         | Serves the web app itself.                                                                                                                                            |

## What the server can see

The server sees:

- space ids (one per project, and one per person for their personal project list),
- share-link tokens (the part of the link before `#`),
- the unencrypted headers of records, the size of uploads, and when things happen,
- how many members a group has and when it changes,
- each project's owner public key.

The server does not see document content, file names, uploaded files, names of people, cursors or the keys. The [encryption page](encryption.md) explains why.

Those two other hosts, `cdn.jsdelivr.net` and `packages.typst.org`, see your IP address, that typstry is in use, and which packages your documents import. They never see document content.

## Code layout

```
apps/web/              React + Vite frontend (editor, sync, encryption, Typst and tinymist workers)
crates/typstry-cli/    The typstry CLI: clone, sync, push and pull a project with a local folder
crates/typstry-doc/    Shared Loro document schema, mirrored in apps/web/src/doc/schema.ts
crates/typstry-server/ Axum server: WebSocket rooms, REST API, SQLite and blob storage
crates/typstry-wasm/   The encryption, MLS and pairing code of typstry-wire, built to wasm for the web app
crates/typstry-wire/   Record format, encryption, MLS groups, devices and pairing, shared by everything above
```
