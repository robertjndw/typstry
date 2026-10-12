# Devices and accounts

typstry has no sign-up, no password and no email address, but it still knows which of your browsers and computers belong together. It shows your projects on all of them and lets you cut off a lost laptop. It helps to read [Members and owners](members-and-owners.md) first.

## Devices

A **device** is one browser profile or one CLI installation. Every device makes its own **device key** the first time it runs. The device key never leaves the device. It is never copied to another device or sent to the server.

In each project, the device signs its project-specific member key with its device key. This links the member to the device without showing the device key itself to the server, so the server cannot tell that the same device is in two projects.

## Persons

A **person** is a set of devices that belong to one human. You can think of it as an account.

The devices of a person are written down in a **person graph**. The graph is a list of signed entries, such as:

- "add this device",
- "revoke that device",
- "set name and color".

Each entry is signed by a device that was valid at that time, and points to the entries it builds on, like commits in git. Two devices can add entries at the same time, and the copies merge. A revoke always wins, and whatever a device added before it was revoked stays.

The person is identified by the first entry of the graph. There is no shared "person key" that could be stolen. The only secrets a person's devices share are:

- the link to their personal space (see [below](#your-project-list)),
- the owner key of each project the person owns.

In every project, each member carries its person graph, encrypted so that only members can read it. That is how other members see that your laptop and your phone are both you, with one name and color.

A graph holds at most 48 entries. Adding a device, revoking one and changing your name or color each use one.

## Adding a device (pairing)

To add a device to your person, you **pair** it with a device you already have.

1. One device shows a short code, such as `42-ivory-galaxy`, as text, as a QR code or as a link. In the browser this is in the account menu under **Devices**. In the CLI it is `typstry pair`.
2. You enter the code on the other device (`typstry pair 42-ivory-galaxy` in the CLI).
3. Both devices connect through a one-off channel on the server. The number in the code picks the channel. The two words are a shared secret that never reaches the server.
4. The devices run SPAKE2, a protocol that turns a short shared secret into a strong key. Someone watching the channel cannot try guesses offline.
5. Both devices show the new device's key fingerprint. Check that they match.
6. You confirm on the device that already belongs to you. It adds the new device to the graph, and sends it the graph and the link to your personal space, encrypted with the key from step 4. The new device finds your projects and owner keys in the personal space.

A code allows exactly one attempt. If anything goes wrong, start again with a new code.

### A device that opened a link before pairing

If you open a project link on a new device before pairing it, that device becomes a person of its own. When you later enter a pairing code on it, typstry offers to switch it to your other device's person (`--replace` in the CLI). Its projects then join again as you.

## Your project list

Every person has a **personal space** on each server. It works like a project, but:

- only your own devices are members,
- its document is your list of projects, with their links,
- it also stores the owner key of each project you own.

All your devices keep this list in sync. A project you create or open on one device shows up on the others: on the home page in the browser, and with `typstry list` in the CLI (`typstry clone <number>` copies one into a folder).

Because the owner keys are in the list too, a newly paired device can remove members and reset links in your projects as soon as it has synced.

## Losing a device (revoking)

If a device is lost or stolen, revoke it from any other device you have: in the browser under **Devices**, or with `typstry devices revoke <device>`.

Revoking does this:

1. The device is removed from your personal space first, so it does not see projects you add later.
2. The revoke is added to your person graph and spreads to every project you are in. From that moment, the device has no owner rights.
3. Your devices reset the links of every project you own, and remove the revoked device from them.

In projects that **someone else** owns, the revoked device stays a member until one of the owner's devices opens that project and removes it. The devices dialog and `typstry devices revoke` list the projects they could not clean up.

Revoke quickly. Until it is revoked, a stolen device can do everything you can, including resetting the links of your projects.

## Recovery key

A **recovery key** is 17 words: 16 words of secret and one checksum word that catches most typos. Create one in the browser under **Devices**, or with `typstry devices recovery`. Write the words down and keep them offline. Anyone who has them can take over your person.

A recovery key is a device key that lives on paper instead of on a device. It can only add and revoke devices. It is never a member of a project. Its revokes outrank those of devices added after it was created, so it wins against a stolen device.

If you lose every device:

1. Open any link of a project you were in, on a new device.
2. Enter the recovery words: in the browser on the recovery page, or with `typstry devices recover <link>` in the CLI.
3. The new device becomes yours again, and your other devices are revoked.

Each of your devices also stores the link to your personal space inside every project, encrypted so that only your recovery keys can open it. So recovering through one project brings back your whole project list and the owner keys of the projects you own.

Without a recovery key, losing every device means losing the owner key of your projects. Editing keeps working, but nobody can remove members or reset the links anymore. Pair a second device or create a recovery key to avoid this.

## Limits

- Pairing uses SPAKE2 from the `spake2` crate, which has not had an independent audit. A two-word code gives an attacker one guess in 65,536 per attempt.
- Device names are labels on your own devices. Other people see your person's name and color, not the device names.
- Members cannot check that a person is who they claim to be. Compare the fingerprint shown next to each person through another channel if it matters.

[SECURITY.md](../SECURITY.md) lists every known limit.

## Where the code lives

- `crates/typstry-wire/src/identity/`: device keys, the person graph and recovery keys.
- `crates/typstry-wire/src/pairing/` and `crates/typstry-server/src/relay.rs`: pairing and the relay.
- `crates/typstry-doc/src/directory.rs` and `apps/web/src/directory/`: the project list.
