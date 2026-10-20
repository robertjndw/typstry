# Self-hosting

typstry is one server program that also serves the web app. Because everything is encrypted in the browser, the server never holds your keys and cannot read the projects it stores.

Docker is the supported way to run it. The image contains the server and the built web app.

## Running with Docker

The published image is `ghcr.io/robertjndw/typstry`. `:latest` is the newest release, `:nightly` follows the main branch.

With Docker Compose, from a checkout of this repository (or just a copy of its `compose.yaml`):

```sh
docker compose up -d
```

Or with plain Docker:

```sh
docker run -d -p 8787:8787 -v typstry-data:/data ghcr.io/robertjndw/typstry:latest
```

Then open <http://localhost:8787>. Data is stored in the `typstry-data` volume. Outside of `localhost` the app only works over HTTPS: for an instance on the internet, use [Production with Traefik](#production-with-traefik) instead.

The container exposes `GET /healthz` for health checks, and the image's `HEALTHCHECK` uses it.

The `typstry` CLI is not part of the image. See [the CLI guide](cli.md) to install it.

### Building the image yourself

To build from source instead, uncomment `build: .` in `compose.yaml` and run `docker compose up -d --build`, or:

```sh
docker build -t typstry .
docker run -d -p 8787:8787 -v typstry-data:/data typstry
```

The first build compiles tinymist and the Typst compiler to wasm, so expect it to take several minutes.

### Running the binary directly

This works, but is not the supported setup. Build the server with `cargo build --release -p typstry-server` and the web app with `pnpm --filter web build` (which needs the wasm the Dockerfile builds first), then point the server at the result:

```sh
TYPSTRY_WEB_DIST=/path/to/apps/web/dist TYPSTRY_DATA_DIR=/var/lib/typstry ./typstry-server
```

Without a built frontend at `TYPSTRY_WEB_DIST` the server only serves the API.

### Stopping

On `SIGTERM` (what `docker stop` sends) the server stops accepting connections, gives running requests up to 10 seconds to finish, asks open WebSockets to close and gives them 5 more seconds, then lets each project finish the changes already queued for it. Nothing needs to be compacted or saved on the way out: every change is in the database before the client is told it arrived. The Compose file allows 30 seconds for this (`stop_grace_period`); do the same if you run it another way.

## Who can use your instance

typstry has no accounts. **Anyone who can reach the server can create projects and upload files to them.** Limits keep one visitor from using up the instance, but they are not access control. If the instance is only for you or your team, put it on a private network or behind a reverse proxy that requires a login.

The limits come from two places:

- **The server** enforces what only it can: a storage quota per project, the size of one upload, a ceiling on open connections across everyone, and rate limits per connection (see [Configuration](#configuration)).
- **The reverse proxy** limits each client address: how often it may create projects, upload files and open pairing channels, and how many WebSockets it may hold open. The server has no per-address limits, since only the proxy at the edge knows who a request really comes from. The [Traefik setup](#production-with-traefik) does all of this out of the box; with any other proxy, you have to add them yourself.

## Production with Traefik

`compose.prod.yaml` runs typstry behind [Traefik](https://traefik.io/traefik/), which gets a certificate from Let's Encrypt, redirects HTTP to HTTPS and applies the per-address limits. typstry is not published on a host port; only Traefik can reach it.

1. Point your domain's DNS (`A` and/or `AAAA` record) at the server. Ports 80 and 443 must be reachable from the internet and not used by anything else.
2. Copy `compose.prod.yaml` and `.env.example` from this repository to the server, and rename `.env.example` to `.env` next to the compose file.
3. In `.env`, set `TYPSTRY_DOMAIN` to the host name (e.g. `typst.example.com`) and `ACME_EMAIL` to an address for Let's Encrypt's notices. To try the setup first without running into Let's Encrypt's rate limits, uncomment `ACME_CA_SERVER` to use their staging CA (its certificates are not trusted by browsers; remove the line and the `traefik-acme` volume to switch to real ones).
4. Start it:

   ```sh
   docker compose -f compose.prod.yaml up -d
   ```

   The certificate is fetched on the first request, which can take a few seconds. `docker compose -f compose.prod.yaml logs traefik` shows what went wrong if it does not arrive.

For production, pin a release tag of the typstry image (like `ghcr.io/robertjndw/typstry:0.1`) instead of `:latest`. Server settings from [Configuration](#configuration) go under `environment:` of the `typstry` service. The commands under [Backups](#backups) and [Upgrading](#upgrading) work the same with `-f compose.prod.yaml` added.

### The limits

Each limit is a Traefik middleware in the `labels:` of the `typstry` service, with its own router so it only applies to its route:

| Route                         | Middleware              | Default                       | Over the limit       |
| ----------------------------- | ----------------------- | ----------------------------- | -------------------- |
| `POST /api/spaces`            | `typstry-spaces-limit`  | 2 a minute, bursts up to 20   | 429 with Retry-After |
| `POST /api/s/<token>/assets`  | `typstry-uploads-limit` | 60 a minute, bursts up to 200 | 429 with Retry-After |
| `POST /api/relay`             | `typstry-relay-limit`   | 10 a minute, bursts up to 10  | 429 with Retry-After |
| `/ws`, `/ws/mls`, `/ws/relay` | `typstry-ws-limit`      | 200 open WebSockets           | 429, clients retry   |

They count per client address, with IPv6 clients counted per /64 network. The rate limits are token buckets: `burst` requests may go through at once, then `average` per `period` (Traefik's `ratelimit` middleware). The WebSocket cap uses `inflightreq`, which counts a WebSocket for as long as it is open. The web app and the CLI retry a 429 a few times on their own.

To tune a limit, change its label and run `docker compose -f compose.prod.yaml up -d` again. For example, to let each address create 10 projects a minute:

```yaml
- traefik.http.middlewares.typstry-spaces-limit.ratelimit.average=10
```

Everything else (the app, assets, share lookups) has no rate limit, as opening a project makes many requests at once. If you add one, keep it generous.

If another proxy or a CDN sits in front of Traefik, every request seems to come from it. Then add `sourcecriterion.ipstrategy.depth=1` (one per proxy in front) to each limit so Traefik takes the client's address from `X-Forwarded-For` instead, and make sure only that proxy can reach Traefik.

Traefik sets no limit on request bodies, so typstry's own `TYPSTRY_MAX_UPLOAD_BYTES` applies. Its read timeout is raised to 15 minutes so large uploads on slow links finish; raise it too if you raise the upload size. WebSockets need no extra configuration. Traefik's access log stays off, and its dashboard is not enabled.

## Behind another reverse proxy (HTTPS)

Whenever typstry is reachable from anywhere but `localhost`, it needs a reverse proxy that terminates TLS. If you bring your own instead of the Traefik setup above, it has to handle the following:

- **HTTPS is required.** The web app encrypts with the browser's `crypto.subtle`, which browsers only offer in a secure context: HTTPS, or `http://localhost`.
- **WebSockets** are used on `/ws`, `/ws/mls` and `/ws/relay`; the proxy must pass the upgrade through. Connections stay open for as long as a project is open.
- **Request bodies** up to `TYPSTRY_MAX_UPLOAD_BYTES` (25 MiB by default) must be allowed. nginx refuses anything over 1 MiB unless told otherwise.
- **Access logs contain secrets.** Share links travel in URL paths (`/api/s/<token>/...`, `/api/share/<token>`) and pairing claims in query strings, and whoever has a link can open the project. Turn the proxy's access log off for typstry or strip paths and queries from it. The server itself never logs them.
- **Per-address limits are yours to add.** The server does not limit clients by address. Configure the proxy to rate limit `POST /api/spaces`, `POST /api/s/<token>/assets` and `POST /api/relay` per client and to cap open WebSockets per client, as [the Traefik setup](#the-limits) does, or one visitor can use up the instance.

Caddy:

```caddyfile
typstry.example.com {
	reverse_proxy localhost:8787
	# Caddy logs no requests unless a `log` directive asks for it.
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name typstry.example.com;
    # ssl_certificate and ssl_certificate_key as usual.

    access_log off;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 1h;
    }
}

# In the http block:
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Neither example limits anything per address yet. With nginx, `limit_req_zone`/`limit_req` and `limit_conn_zone`/`limit_conn` keyed on `$binary_remote_addr` do it, in their own `location` blocks for the routes above. Caddy needs a plugin such as [caddy-ratelimit](https://github.com/mholt/caddy-ratelimit).

## What the browser loads from elsewhere

The web app is served by your instance, but the Typst compiler in the browser fetches its fonts from `cdn.jsdelivr.net` and Typst packages (`#import "@preview/..."`) from `packages.typst.org`. Neither request carries project content.

To serve the fonts from somewhere else, build the image with the `VITE_TYPST_FONT_BASE` and `VITE_TYPST_DEV_FONT_BASE` build arguments pointing at your mirror (`docker build --build-arg VITE_TYPST_FONT_BASE=https://fonts.example.com/fonts/ ...`), and set `TYPSTRY_FONT_ORIGINS` to the mirror's origin so the server's Content Security Policy allows it. Fonts hosted by the typstry server itself need no extra origin: set `TYPSTRY_FONT_ORIGINS` to an empty value. The published images use the jsDelivr default.

## Configuration

The server is configured through environment variables.

### Basics

| Variable                   | Default                    | Description                                                                                                                       |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `TYPSTRY_ADDR`             | `127.0.0.1:8787`           | Address to listen on (the Docker image uses `0.0.0.0:8787`).                                                                      |
| `TYPSTRY_DATA_DIR`         | `data`                     | Directory for the SQLite database and uploaded blobs (the Docker image uses `/data`).                                             |
| `TYPSTRY_WEB_DIST`         | `apps/web/dist`            | Built frontend to serve (the Docker image has it at `/app/web`). Static serving is off if missing.                                |
| `TYPSTRY_FONT_ORIGINS`     | `https://cdn.jsdelivr.net` | Space-separated origins the browser may fetch Typst fonts from. Empty means fonts come from this server only. See above.          |
| `TYPSTRY_MAX_UPLOAD_BYTES` | `26214400` (25 MiB)        | Largest asset upload.                                                                                                             |
| `RUST_LOG`                 | `info`                     | Log filter, see [`tracing-subscriber`][env-filter]. Request logs (at `debug`) name the route, never the URL with its share token. |

### Abuse limits

What the server limits itself. Limits per client address belong in the reverse proxy, see [Who can use your instance](#who-can-use-your-instance).

| Variable                    | Default              | Description                                                                                                                                                        |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TYPSTRY_SPACE_QUOTA_BYTES` | `1073741824` (1 GiB) | Total size of the assets of one project. A file shared by several projects counts for each, and deleting a file does not free its share. Past it, uploads get 507. |
| `TYPSTRY_MAX_CONNECTIONS`   | `10000`              | Open WebSockets across all clients. Past it, new ones get 503 and retry.                                                                                           |

### Connections and rooms

| Variable                        | Default             | Description                                                                                                                                              |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPSTRY_ROOM_UNLOAD_SECS`      | `60`                | How long a project stays loaded after its last client left.                                                                                              |
| `TYPSTRY_PRESENCE_TIMEOUT_SECS` | `30`                | How long a client's cursor stays visible without a refresh.                                                                                              |
| `TYPSTRY_UPDATE_BURST`          | `200`               | Document records (and presence updates) one connection may send in a burst. Also the burst of member group requests (see below) one connection may make. |
| `TYPSTRY_UPDATES_PER_SEC`       | `50`                | Sustained records per second per connection, after the burst. Also the sustained rate of member group requests per connection.                           |
| `TYPSTRY_MAX_ROOMS_PER_CONN`    | `8`                 | Rooms one connection may join; a project takes two.                                                                                                      |
| `TYPSTRY_OUTBOX_BYTES`          | `16777216` (16 MiB) | Live updates queued for a slow client before it is dropped (it reconnects and catches up). Does not limit the doc size.                                  |

A client that stops reading altogether is dropped once a single message has been stuck for a minute, so it cannot hold on to what is queued for it.

### Member groups

These settings control the log of group changes (joins, removals, new links) that the server keeps for each project. See [Members and owners](members-and-owners.md). A member who was offline longer than this log reaches back needs a new link from someone.

| Variable                        | Default             | Description                                                                                        |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `TYPSTRY_COMMIT_RETENTION_SECS` | `7776000` (90 days) | Group changes older than this are dropped. The newest one is always kept.                          |
| `TYPSTRY_KEEP_LAST_COMMITS`     | `1000`              | At most this many of the newest group changes are kept per project, whatever their age.            |
| `TYPSTRY_MAX_LOG_BYTES`         | `16777216` (16 MiB) | At most this many bytes of group changes are kept per project.                                     |
| `TYPSTRY_MAX_COMMIT_BYTES`      | `65536` (64 KiB)    | Largest single group change. At most `2097152` (2 MiB), the largest message the server accepts.    |
| `TYPSTRY_MAX_GROUP_INFO_BYTES`  | `262144` (256 KiB)  | Largest group description, keyring or link rotation a client may store. At most `2097152` (2 MiB). |

### Pairing relay

| Variable                 | Default | Description                                                                 |
| ------------------------ | ------- | --------------------------------------------------------------------------- |
| `TYPSTRY_RELAY_TTL_SECS` | `300`   | How long a pairing channel lives. This is how long a pairing code is valid. |

[env-filter]: https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html

## Backups

The data directory contains `typstry.db` and a `blobs/` directory. Back up in this order:

1. Take a consistent copy of the database. This is safe while the server runs.
2. Then copy `blobs/`. A file is always written before the database mentions it, so copying it second guarantees every file the database copy refers to is there.

With Docker Compose (the image has no shell, so files are copied out with `docker compose cp`):

```sh
docker compose exec typstry typstry-server backup /data/backup-2026-10-13.db
docker compose cp typstry:/data/backup-2026-10-13.db ./typstry.db
docker compose cp typstry:/data/blobs ./blobs
```

The database copy stays in the volume afterwards; the `backup` command refuses to overwrite one, so use a new name each time. To remove old ones: `docker run --rm -v typstry-data:/data busybox rm /data/backup-2026-10-13.db` (prefix the volume name with the Compose project name, e.g. `typstry_typstry-data`, if Compose created it).

Running the binary directly, it is `typstry-server backup /path/to/backup.db` followed by a plain copy (`cp -R` or `rsync`) of `<data dir>/blobs`.

To restore, stop the server, put the database copy in place as `typstry.db` and the `blobs/` directory next to it, and start the server again.

A backup holds only encrypted data. Restoring it brings back the projects, but nobody can open them without their share links.

## Upgrading

Pull the new image and recreate the container:

```sh
docker compose pull
docker compose up -d
```

The server updates the database on start, so take a backup first. Browser tabs and CLI clients that are too old for the new server are told to update instead of failing in odd ways.
