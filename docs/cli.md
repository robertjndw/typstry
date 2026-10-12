# The typstry CLI

The `typstry` CLI links a folder to a project. It encrypts and decrypts on your machine like the browser does, so the server still only sees ciphertext.

[Devices and accounts](devices-and-accounts.md) explains pairing, the project list and recovery keys, and [Members and owners](members-and-owners.md) explains removing members.

The CLI isn't part of the Docker image. Install it from a checkout with [Rust](https://rustup.rs) 1.94 or newer:

```sh
cargo install --path crates/typstry-cli
```

typstry moves the current state of the files between people, live. Git keeps the snapshots you decide to commit. The CLI never commits for you (except the first commit of `clone --git`), so branches, rebase, hooks and remotes work as usual.

Pick one way to get edits from your co-authors. If they use typstry, don't also `git pull` the same edits from a shared remote, or they arrive twice. Your git history can be your own, or one person can keep the shared repository for the group.

## A normal day

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

## Commands

| Command                                      | What it does                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clone <link> [dir] [--git]`                 | Copy a project into a new folder. `--git` also creates a repository and commits it. Instead of a link, you can give a number or title from `typstry list` |
| `init [dir]`                                 | Turn a folder (for example an existing git repository) into a new project                                                                                 |
| `list`                                       | List your projects, including the ones your other devices have, and show which have no folder here                                                        |
| `sync`                                       | Keep the folder and the project in sync until Ctrl+C                                                                                                      |
| `status`, `pull`, `push`                     | One-shot sync: show, receive or publish changes. While `sync` runs, it answers them                                                                       |
| `link`, `open`                               | Print the edit and view links, or open the project in the browser                                                                                         |
| `info`                                       | Project, permission, tracked branch and pending changes                                                                                                   |
| `version list`, `version save`               | Named versions (tags in the browser's history panel). Also work while `sync` runs                                                                         |
| `export [--at <version>] <dir>`              | Write the project, now or at a named version, to a plain folder                                                                                           |
| `track <branch>`                             | Change the git branch typstry syncs on (stop `sync` first)                                                                                                |
| `members [remove <member>]`                  | List the people and devices in the project, or remove one and replace the links (owner only)                                                              |
| `share reset`                                | Replace the links, for example after one leaked (owner only)                                                                                              |
| `pair [code]`                                | Add a device: without a code, show one to enter on the other device; with one, pair with the device showing it                                            |
| `devices [revoke <device>]`                  | List the devices that are you, or revoke a lost one and remove it from the projects you own                                                               |
| `devices recovery`, `devices recover <link>` | Create a recovery key, or use one to make this machine you again after losing every device                                                                |
| `devices profile`                            | Show your name and color, or set them for all your devices with `--name` and `--color`                                                                    |

Every command takes `-C <dir>` to run as if started in another folder, and `--name <name>` to set the author name shown in the project history (defaults to `git config user.name`). `typstry <command> --help` shows all options.

## Environment variables

| Variable             | Used for                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPSTRY_LINK`       | The share link for `clone` when the argument is left out                                                                              |
| `TYPSTRY_SERVER`     | The server for `init` when `--server` is left out                                                                                     |
| `TYPSTRY_BROWSER`    | The program `open` starts instead of the system default browser                                                                       |
| `TYPSTRY_LOG`        | Log filter in `RUST_LOG` syntax, `warn` by default                                                                                    |
| `TYPSTRY_CONFIG_DIR` | Where the device key, the person graph, the owner keys and the list of project folders live, instead of the platform config directory |

## Things to know

- **The tracked branch.** typstry syncs on one git branch, the one checked out when the folder was first linked. On any other branch, or while git is merging or rebasing, `sync` pauses and `pull`/`push` refuse unless you pass `--force`.
- **Coming back from a branch.** If the files differ from the last sync when you return to the tracked branch, `sync` keeps receiving but holds back your outgoing changes. Otherwise a co-author edit that you only committed on the other branch would look like a deletion. Files changed on both sides wait too. The same applies after `git reset`, and when you switched branches while `sync` was not running. Check with `typstry status`, then publish by typing `push` in the sync terminal, running `typstry push --force`, or starting `sync` with `--publish`. Committing on the tracked branch before switching avoids this.
- **Commands next to `sync`.** While `sync` runs, `status`, `info`, `version list`, `version save` and `push` in the same folder ask it instead of failing. `version save` and `push` publish what is on disk right away, so a version saved just after a save includes it. Both refuse while `sync` is paused, and need `--force` while it holds back changes after a branch switch, like the one-shot versions. `pull` only says that `sync` already pulls. `track` and `export` refuse to start until `sync` is stopped.
- **The key lives in `.typstry/`.** That folder holds the link, the owner keys of a project you own and a local cache. It ignores itself with its own `.gitignore` and is also added to `.git/info/exclude`. Never commit it. To keep the link out of your shell history, pass it on standard input (`pbpaste | typstry clone - thesis`) or in `TYPSTRY_LINK`.
- **Ignored files.** `.gitignore` and an optional `.typstryignore` decide which files are synced, so build output such as PDFs stays local. git's own files (`.gitignore`, `.gitattributes`, `.gitmodules`, `.github/`) and `.typstryignore` itself are not synced either; re-include one with a negated pattern in `.typstryignore`, such as `!.gitignore`. An ignored file is never written to the folder, and removing or editing it locally never changes the project. A file the project gets from someone else never replaces a local file that is not synced, or one whose name only differs in case on macOS and Windows.
- **Editors.** Files can change on disk while you edit them. Let your editor reload changed files automatically (VS Code does this for files without unsaved changes).
