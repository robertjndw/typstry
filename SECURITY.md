# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/robertjndw/typstry/security/advisories/new), not in a public issue or pull request.

Include what an attacker can do, the steps to reproduce it, and the commit or version you tested. You should get a first reply within a week.

## Supported versions

typstry is pre-1.0. Fixes land on `main` only, so please check that the issue still exists there.

## Scope

The README's [How it works](README.md#how-it-works) section describes what the encryption protects. In particular, these are in scope:

- A server, or anyone who can read its data directory, learning the contents of documents or uploads.
- A view link being used to make edits that other clients accept.
- Getting at a project's content or key without its share link.
- A removed member reading data written after their removal, or following the group to learn the new links.
- A client, or the server, passing itself off as another member, or adding a member without an external commit made with the link.
- Code execution or file access outside the project through the CLI, the server, or a compiled Typst document.

## What membership gives you

- The roster is authenticated. Every device has its own key, every update is signed with it, and the names shown for authors and cursors are the members' own profiles, which only members can read.
- Removing a member (or resetting the links) switches the project to a new key generation, and the members who stay get the new links automatically. The removed device cannot read what is written afterwards.
- Presence is sealed under a key of the current group epoch, so a removed member stops seeing cursors with the next epoch.

## Known limits

These are not vulnerabilities:

- A link grants access until it is reset or its holder is removed. Anyone holding a share link can read the project, and anyone holding an edit link can change it.
- Membership is per device, not per person. Every browser profile and CLI folder is its own member, so cutting someone off means removing each of their devices.
- Every device that opens a link, view links included, joins the group and stays a member until it is removed. Removing anyone rotates the links for everyone who stays.
- A removed member keeps everything they already had. Document content has no forward secrecy: a link holder can derive the keys of every earlier generation, and the full history is in the document anyway.
- A removed editor working with the server could inject updates backdated to the old generation. They would still be signed by, and so attributed to, that editor.
- A compromised server can withhold or roll back updates, and it can stall the group (stop commits from being delivered). Editing keeps working, but removals and new links cannot reach other members until it behaves.
- Any link holder can stall the group with a commit the others reject, until an editor resets the group. Documents keep syncing meanwhile.
- A join can be crafted so that only some members reject it. That splits the group: those members stop following while the rest carry on, until an editor resets the group. Without the server validating commits, MLS cannot prevent this.
- A group reset, or the server pruning the commit log (by age, by count or by size, and retired links expire with it), drops the messages that carry new links. A member who was offline across a rotation then cannot catch up and needs a new link out of band.
- The group's cryptography runs as wasm on the browser's main thread, so a large group can briefly stall the UI.
- The server sees project and share-link tokens, record headers, blob sizes, connection metadata, and the group's metadata: how many members it has, when commits happen, their epochs and sizes.
- The server serves the app's JavaScript, so it could serve a modified client.
