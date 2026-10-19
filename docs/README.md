# typstry documentation

The [main README](../README.md) covers what typstry is and how to start it. These pages go into the details.

## Using typstry

- [Local folders in the browser](local-folders.md): keep a project in sync with a folder on your computer from Chromium.
- [The command line tool](cli.md): work on a project in a local folder, with your own editor and git.
- [Static hosting](static-hosting.md): build typstry without a server, for example for GitHub Pages.
- [Self-hosting](self-hosting.md): run your own server, configure it and back it up.

## How it works

If you are new to the project, read them in order, since each one assumes you know the one before.

1. [Architecture](architecture.md): the parts of typstry and how they talk to each other.
2. [Encryption](encryption.md): share links, the keys inside them, and what the server can and cannot see.
3. [Members and owners](members-and-owners.md): who is in a project, who may remove people, and what happens when someone is removed.
4. [Devices and accounts](devices-and-accounts.md): how your browsers and computers belong together, pairing, your project list, lost devices and recovery keys.

[SECURITY.md](../SECURITY.md) lists what the design protects against, and the known limits.

## For contributors

- [Compatibility](compatibility.md): the version numbers in stored data and how to change a format without breaking older data.

## Words used in these pages

| Word           | Meaning                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | A set of Typst files you write together. One project is one shared document on the server.                                                               |
| Space          | What the server stores for a project: its id, its encrypted data and its member group. Your personal project list is a space too.                        |
| Share link     | The link you send to people. There is an edit link and a view link. The part after `#` holds the key and never reaches the server.                       |
| Generation     | A period in the life of a project's links. A new generation starts when the owner removes someone or resets the links. Each generation has its own keys. |
| Device         | One browser profile, or one CLI installation. Each device has its own secret key that never leaves it.                                                   |
| Person         | A group of devices that belong to the same human. You can think of it as an account without a password or email address.                                 |
| Member         | A device that has joined a project.                                                                                                                      |
| Owner          | The person who created a project. Only the owner can remove members or reset the links.                                                                  |
| Personal space | A private space that only your own devices can open. It holds your list of projects.                                                                     |
| Pairing        | Adding a new device to your person by entering a short code.                                                                                             |
| Recovery key   | 17 words you write down. They let you get your person back when every device is lost.                                                                    |
| MLS            | Messaging Layer Security ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420)), a standard for groups that share keys. typstry uses it for members.       |
| CRDT           | A data structure that lets several people edit at once and always merges to the same result. typstry uses [Loro](https://loro.dev).                      |
