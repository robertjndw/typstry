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
- Code execution or file access outside the project through the CLI, the server, or a compiled Typst document.

These are known limits, not vulnerabilities:

- Anyone holding a share link can read the project, and anyone holding an edit link can change it.
- A compromised server can withhold or roll back updates, and it serves the app's JavaScript, so it could serve a modified client.
- The server sees project and share-link tokens, record headers, blob sizes and connection metadata.
