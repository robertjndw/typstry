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
- Only the project's owner, the person who created it, can remove members or reset the links. The group state names the owner by a tag derived from the person and the project's first document key, so it differs between projects. Every member checks owner rights against the devices that person's graph lists as valid, so an editor or the server cannot grant them to itself. The one exception: an editor may remove devices of its own person that its graph shows as revoked, together with a rotation.
- Removing a member (or resetting the links) switches the project to a new key generation, and the members who stay get the new links automatically. The removed device cannot read what is written afterwards.
- Presence is sealed under a key of the current group epoch, so a removed member stops seeing cursors with the next epoch.
- Each device has its own key, and a person is a graph of signed entries that add and revoke devices. No secret is shared between a person's devices. A device is shown as that person only if its leaf key is signed by a device the graph lists as valid, and a commit can never swap a leaf's identity for another one. Only an external join with the link replaces the leaf, which is how a device that switched persons moves its leaf over. Members merge every copy of a person's graph they see, so a revoke that reaches any one of the person's leaves applies to all of them. Removing a person removes all of their devices in one commit.
- A revoked device loses its owner rights as soon as a leaf in the group carries the revoke, and the person's other devices remove it from every project they can edit and replace the links there.
- A recovery key is a device key spelled as 17 words. It can only add and revoke devices. It is never accepted as a member of a project and never counts as the owner.

## Known limits

These are not vulnerabilities:

- A link grants access until it is reset or its holder is removed. Anyone holding a share link can read the project, and anyone holding an edit link can change it.
- A person's graph and the device keys are sealed under a key derived from the project's first document key, so that every member checks them the same way even while its keyring lags behind a rotation. Anyone who once held a link to the project, a removed member included, can read the person ids of later members together with the server, and can test a guessed person against the owner tag.
- Revoking a device only reaches the projects where another device of the same person can edit and is opened afterwards. In projects where the person only has a view link, or that no other device of theirs has opened, the revoked device keeps its access until the owner removes it. `typstry devices revoke` and the browser's devices dialog list the projects they could not reach.
- Between losing a device and revoking it, the device can do anything its person can, including acting as the owner.
- Two devices that revoke each other at the same time are both revoked, since nobody can tell which of them was stolen. If that happens to the owner's only devices, the project has no owner until the recovery key adds a new device. A thief can also make all of a person's devices show as unverified by writing more entries into the graph than fit, since members refuse to guess which copy is right.
- A graph holds at most 48 entries. Every device added, every revoke and every change of name or color uses one, so a person who reaches the limit cannot add devices anymore.
- After a group reset, a revoked owner device that rejoins before any up-to-date device of the owner is judged against its own outdated graph and counts as the owner until a device that knows the revoke rejoins.
- Members cannot tell whether a person is the one they expect. The fingerprint shown next to each person and device is there to compare out of band, and nothing pins it yet.
- Recovering with the recovery key needs a link to at least one project the person is in, since the graph is only stored on devices and in the projects. Its last word is a checksum that catches most but not all typos. A wrong key only fails to find the person.
- A device that opens a link before it is paired joins as a person of its own, and members see that person and its fingerprint until the device pairs and joins again as the person it joined. The prompt that offers this switch trusts the user's answer about which device already belongs to them.
- Device names are local labels. Pairing tells both devices each other's name, and they never reach other people.
- Pairing uses SPAKE2 from the `spake2` crate, which has not had an independent audit. A short code gives an attacker on the relay one guess per attempt (1 in 65,536 for two words), and the device that shows or enters the code for the person gives up after one failed attempt. Anyone who guesses a channel number can make a pairing attempt fail, but cannot learn or change what is exchanged.
- Every device that opens a link, view links included, joins the group and stays a member until it is removed. Removing anyone rotates the links for everyone who stays.
- A removed member keeps everything they already had. Document content has no forward secrecy: a link holder can derive the keys of every earlier generation, and the full history is in the document anyway.
- If every device of the owner is lost and there is no recovery key, nobody can remove members or reset the links anymore. Editing keeps working. Create a recovery key, pair a second device, or back up the CLI config directory to avoid this.
- Any editor can still reset a stalled group. The reset carries the owner tag over, and a member refuses a group that does not name the owner it saw first. A device joining for the first time after a malicious reset trusts whichever owner that group names.
- A removed editor working with the server could inject updates backdated to the old generation. They would still be signed by, and so attributed to, that editor.
- A compromised server can withhold or roll back updates, and it can stall the group (stop commits from being delivered). Editing keeps working, but removals and new links cannot reach other members until it behaves.
- Any link holder can stall the group with a commit the others reject, until an editor resets the group. Documents keep syncing meanwhile. A commit from an editor that tries to remove someone other than its own revoked devices counts as such a commit.
- A join can be crafted so that only some members reject it. That splits the group: those members stop following while the rest carry on, until an editor resets the group. Without the server validating commits, MLS cannot prevent this.
- A group reset, or the server pruning the commit log (by age, by count or by size, and retired links expire with it), drops the messages that carry new links. A member who was offline across a rotation then cannot catch up and needs a new link out of band.
- The group's cryptography runs as wasm on the browser's main thread, so a large group can briefly stall the UI.
- The server sees project and share-link tokens, record headers, blob sizes, connection metadata, and the group's metadata: how many members it has, when commits happen, their epochs and sizes.
- The server serves the app's JavaScript, so it could serve a modified client.
