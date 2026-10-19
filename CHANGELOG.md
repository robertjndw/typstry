# Changelog

Notable changes to typstry are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and typstry uses [Semantic Versioning](https://semver.org). Before 1.0, a minor version may contain breaking changes.

## [Unreleased]

<!-- On release, rename this section to: ## [0.1.0] - YYYY-MM-DD -->

The first release.

### Added

- Real-time collaboration on Typst projects, merged conflict-free through Loro CRDTs, with live cursors and presence.
- End-to-end encryption of documents, uploads, profiles and presence. The key lives only in the share link's fragment and on the devices that opened it.
- Typst compilation in the browser with a live SVG preview, inline diagnostics and Typst Universe packages.
- Autocompletion, hover docs and signature help through tinymist, including completion of project file paths.
- Offline-first editing: projects are kept in IndexedDB, open without the server and sync once the connection comes back.
- Multi-file projects with a file tree, tabs that reopen where you left off, and uploads for images, fonts and data files, including paste and drop into the editor.
- History: browse edits, tag versions, preview, diff and restore.
- Separate edit and view links, an MLS member group per project, and an owner who can remove members and reset the links.
- Devices without accounts: pairing with a short code, a synced project list, revoking lost devices and 17-word recovery keys.
- Import from a ZIP or a folder, export of the compiled PDF or the whole project as a ZIP.
- Local folders in Chromium browsers: open a folder as a project, or link a project to a folder, and keep the two in sync live with merging of edits made on both sides.
- The `typstry` CLI, which syncs a project with a local folder so it can be edited in any editor and kept in git.
- A self-hostable server with Docker images on `ghcr.io/robertjndw/typstry`, and prebuilt CLI binaries for Linux and macOS with build provenance attestations.

### Notes

- CLI: `members remove`, `devices revoke` and `share reset` ask for confirmation. Without a terminal they refuse to run unless you pass `--yes`, and answering no exits with status 1.
- CLI: `devices revoke` and `devices recovery` exit with status 1 when a project could not be reached, so scripts notice the cleanup is incomplete.
- CLI: git's global excludes (`core.excludesFile`) decide which files are synced, along with `.gitignore`, `.git/info/exclude` and `.typstryignore`.
- CLI: Ctrl+Z suspends `sync` and the interactive views, and `fg` resumes them. A suspended `sync` does not sync.
- Web: a notice shows when the browser cannot save projects locally (private mode, full storage, or a failing database).
- Server: a storage quota per project and a ceiling on open connections are on by default. Limits per client address (creating projects, uploading, pairing, open connections) belong in the reverse proxy; `compose.prod.yaml` runs typstry behind Traefik with them set up. See [Self-hosting](docs/self-hosting.md#production-with-traefik).

[Unreleased]: https://github.com/robertjndw/typstry/commits/main
