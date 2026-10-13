# Members and owners

A share link lets someone into a project. Below is how typstry keeps track of who is in, how the owner removes someone, and why the server cannot cheat. Read [Encryption](encryption.md) first.

## Every device that opens a link becomes a member

Each project has a **member group**. It uses MLS (Messaging Layer Security, [RFC 9420](https://www.rfc-editor.org/rfc/rfc9420), through the [openmls](https://github.com/openmls/openmls) library), a standard for groups of devices that share keys.

When a device opens a project link for the first time, it joins the project's group. A browser profile is one member, and so is each CLI folder linked to the project. Each member has:

- its own signing key for this project (its "leaf" in MLS terms), signed by the device key,
- a profile with a name and a color, which only other members can read.

You see the members in the share dialog in the browser, or with `typstry members` in the CLI. Devices of the same person are shown together. See [Devices and accounts](devices-and-accounts.md) for what a person is.

### Joining without anyone online

Usually a group needs an existing member to let a newcomer in. typstry avoids that: the server keeps a description of the group (the "GroupInfo"), encrypted with a key from the link. A newcomer with the link downloads it and adds itself with an MLS "external commit". Nobody has to be online.

## The server only delivers group messages

Changes to the group, such as a join or a removal, are called **commits**. The server acts as the group's **delivery service**:

- It stores commits and forwards them as bytes it cannot read.
- It decides the order. If two commits are made for the same group state, the first one to arrive wins and the other is refused.
- It never holds a group key, so it cannot read the group or add members.

Editing does not depend on the group. If the group gets stuck, documents keep syncing.

## The owner

The person who creates a project is its **owner**. Only the owner can:

- remove members,
- reset the links (for example after a link leaked).

The owner is a person, not a single device. Any valid device of the owner's person counts as the owner.

There are two checks, one by the members and one by the server.

**Members check the owner tag.** The group state names the owner by a tag. The tag is computed from the owner's person and a key derived from the project's first document key, and it is different in every project, so the server alone cannot tell that two projects have the same owner. When a device tries to remove someone, every member checks that it belongs to the owner's person.

The tag hides the owner from the server, not from link holders. Everyone who ever held a link to the project has the first document key, including removed members and people who had a link but never joined. Together with the server they can test a guessed person against the tag.

**The server checks the owner key.** The server cannot read the group, so it cannot use the tag. Instead every project has an **owner key**: an Ed25519 key made from a random secret that only the owner's devices have. The server keeps the public half. It replaces a project's links only when the request is signed with the owner key, and every rotation replaces the owner key with a new one.

The owner's devices pass the owner key to each other inside the group, and they also keep all their owner keys in their [personal space](devices-and-accounts.md#your-project-list), so a newly paired device can act as owner once it has synced.

## Removing a member

When the owner removes a member (or resets the links), their device does all of this in one step:

1. It makes a new **generation**: a new edit secret, a new document key, a new keyring and new tokens for the server.
2. It sends one group commit that removes the member and carries the new links, encrypted for the members who stay.
3. The server swaps the tokens, signed with the owner key, and closes connections that use the old ones.

The members who stay read the commit and switch to the new links automatically. The removed device cannot follow the group anymore, so it never learns the new links and cannot read anything written afterwards.

The server keeps the old tokens for a while, so members who were offline during the removal can still fetch the commit log and catch up. How long is set with the server's [commit settings](self-hosting.md#configuration).

## Limits

- A removed member keeps everything they already downloaded, and they still hold the old link. They cannot read anything written after the removal.
- A hostile server can hold back or delay group messages. Editing keeps working, but removals cannot reach other members until it behaves.
- Any link holder can send a commit that the others refuse, which stalls the group. Any editor can then reset the group. The reset keeps the links and the owner.

[SECURITY.md](../SECURITY.md) lists every known limit.

## Where the code lives

- `crates/typstry-wire/src/mls/`: the group, the owner policy and link rotation.
- `crates/typstry-wire/src/owner.rs`: the owner key and signed rotations.
- `crates/typstry-server/src/ws/mls.rs` and `crates/typstry-wire/src/ds.rs`: the delivery service.
