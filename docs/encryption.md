# Encryption

typstry is end-to-end encrypted. Your browser (or the CLI) encrypts everything before it is sent, and only people with the share link can decrypt it. The server stores data it cannot read.

Below are the keys typstry uses, where they come from and what each one protects. If you have not read [Architecture](architecture.md) yet, start there.

## The share link holds the key

A share link looks like this:

```
https://typstry.example/p/AbCd...#xYz...
                          └─┬──┘ └─┬──┘
                          token    secret
```

- The **token** is the part before `#`. The server uses it to find the project. It is not a secret key.
- The **secret** is the part after `#`, called the fragment. Browsers never send the fragment to a server, so the server never sees it.

This is why you should treat an edit link like a password: anyone who has it can read and change the project.

There are two kinds of link:

- An **edit link** holds the full secret: 32 random bytes.
- A **view link** holds only what is needed to read and to check signatures. It cannot be used to make changes that others accept.

## How the keys fit together

```
edit secret (32 random bytes, only in the edit link)
 │
 ├─ HKDF ─► view key ────────────────► opens the keyring
 │          (in the view link too)
 │
 └─ HKDF ─► attestation key (Ed25519)
            private half: only in the edit link, signs the keyring and attests editors
            public half:  in the view link too, to check those signatures

keyring (stored on the server, encrypted with the view key)
 ├─ document key of generation 1
 ├─ document key of generation 2
 └─ ...one random key per generation

document key of a generation
 └─ HKDF with a fresh random salt ─► AES-256-GCM key for one message
    (document records, uploads, profiles)
```

HKDF (with SHA-256) is a standard way to turn one secret into several independent keys. Each purpose gets its own key, so a key made for one job can never be used for another.

### Why there is a keyring

Documents are not encrypted with the link secret itself. They are encrypted with **document keys**, and each document key belongs to one **generation**.

A new generation starts when the project's owner removes a member or resets the links. The new generation has a new link secret and a new document key. The keyring holds the document keys of all generations so far, so anyone with the current link can still read the whole history.

The keyring is stored on the server, encrypted with the view key and signed with the attestation key. A viewer can open it, but cannot make a fake one, because they do not have the private attestation key.

### Encrypting a single message

Nothing is ever encrypted with a document key directly. For every message, typstry:

1. picks 16 random bytes (the salt),
2. derives a one-off key from the document key, the salt and the purpose (record, upload, profile),
3. encrypts the message with AES-256-GCM under that key.

Every message also says which generation it belongs to, so a reader knows which document key to use.

## Who wrote a change

Encryption keeps the content secret, but it doesn't say who wrote it. typstry uses signatures for that.

- Every device has its own **device key**. It never leaves the device. See [Devices and accounts](devices-and-accounts.md).
- Every document record is signed with the author's device key.
- Every record also carries an **attestation**: a signature by the attestation key over the device key and the generation. Only someone with the edit link can make one.

Other clients refuse records without a valid attestation. So a view link stays read-only even if the server is hostile and passes its changes along, and the author names you see in the history are real.

## Presence

Cursors and the names of the people currently online are called presence. Presence is not stored. It is encrypted with a key from the project's current member group (see [Members and owners](members-and-owners.md)), not with the document key, and it is signed by each device. When someone is removed, the group key changes, so they stop seeing cursors.

## What the encryption does not hide

The server still learns some things, because it has to deliver data:

- which project a request is for, from the token and the space id,
- how big records and uploads are, and when they are sent,
- how many members a project has, and when that changes.

## What happens to old data

There is no forward secrecy for document content, and this is on purpose. Anyone with the current link can derive the keys of every earlier generation. The full edit history is in the document anyway, so hiding old keys would not protect anything.

A removed member keeps everything they already downloaded. They cannot read what is written after their removal.

[SECURITY.md](../SECURITY.md) lists every known limit.

## Where the code lives

- `crates/typstry-wire/src/crypto.rs`: link secrets, keyring, records, uploads and presence.
- `crates/typstry-wasm`: the same code built for the browser.
- [Compatibility](compatibility.md): the version bytes at the start of each format.
