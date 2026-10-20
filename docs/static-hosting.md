# Static hosting

typstry can be built as plain static files that need no server, for example for GitHub Pages. In this local-only mode it is a Typst editor that keeps its projects in the browser.

## What works and what is off

Compiling, the live preview, autocompletion, version history, local folders, and PDF and zip export all run in the browser, so they work as usual. Uploads of folders and zips work too.

Everything that needs a server is left out of the build:

- sharing links and collaboration, including presence
- pairing devices, the device list and recovery keys
- the personal project list on the server (the list is kept in the browser instead)

## Where projects are stored

Projects are stored in this browser's IndexedDB. Clearing site data, or using another browser or device, loses them. Export a project as a zip, or [link a folder](local-folders.md), to keep a backup.

## Building

```sh
TYPSTRY_BASE=/typstry/ pnpm --filter web build:static
```

The result is in `apps/web/dist-static`. Like any web build it needs the wasm builds in `apps/web/vendor/`, see [Getting started](../README.md#getting-started).

| Variable                  | Meaning                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VITE_TYPSTRY_LOCAL_ONLY` | `1` switches off every feature that needs a server. `build:static` sets it.                                            |
| `TYPSTRY_BASE`            | The path the files are served from, with a trailing slash. Defaults to `/`. GitHub Pages project sites use `/<repo>/`. |

Hosts cannot send the security headers the server sends, so the build puts the same content security policy into a `<meta>` tag (without `frame-ancestors`, which a meta tag cannot set). It also writes a `404.html` copy of `index.html`, so a reload of a project link works before the service worker is installed.

## GitHub Pages

`.github/workflows/pages.yml` builds and deploys the site on every push to `main` that touches the web app. Once, in the repository settings, set Pages > Source to GitHub Actions. The site is then at `https://<user>.github.io/<repo>/`.

## Installing and offline use

Both the static build and the server build are installable as a PWA. A service worker caches the app, including the compiler, so it starts offline. When a new version has been downloaded, a toast offers to reload.

Packages you pin to a project in the Fonts & Packages dialog are stored in the project itself, in IndexedDB for a local project, so they compile offline and across sessions. Typst Universe packages you have not pinned are still fetched from `packages.typst.org` while compiling and are not cached across sessions, so they need the network each time.
