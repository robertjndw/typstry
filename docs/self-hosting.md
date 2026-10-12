# Self-hosting

typstry is one server program that also serves the web app. Because everything is encrypted in the browser, the server never holds your keys and cannot read the projects it stores.

## Running with Docker

The easiest way is Docker Compose, from a checkout of this repository:

```sh
docker compose up -d
```

Then open <http://localhost:8787>. Data is stored in the `typstry-data` volume. The first build compiles tinymist to wasm, so expect it to take several minutes.

Or build and run the image directly:

```sh
docker build -t typstry .
docker run -d -p 8787:8787 -v typstry-data:/data typstry
```

The server tidies up the stored projects when it shuts down. The Compose file gives it 30 seconds for that (`stop_grace_period`). Do the same if you run it another way.

The container exposes `GET /healthz` for health checks.

The `typstry` CLI is not part of the image. See [the CLI guide](cli.md) to install it.

## Configuration

The server is configured through environment variables.

### Basics

| Variable                   | Default             | Description                                                  |
| -------------------------- | ------------------- | ------------------------------------------------------------ |
| `TYPSTRY_ADDR`             | `127.0.0.1:8787`    | Address to listen on (the Docker image uses `0.0.0.0:8787`). |
| `TYPSTRY_DATA_DIR`         | `data`              | Directory for the SQLite database and uploaded blobs.        |
| `TYPSTRY_WEB_DIST`         | `apps/web/dist`     | Built frontend to serve. Static serving is off if missing.   |
| `TYPSTRY_MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Largest asset upload.                                        |
| `RUST_LOG`                 | `info`              | Log filter, see [`tracing-subscriber`][env-filter].          |

### Connections and rooms

| Variable                        | Default             | Description                                                                              |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `TYPSTRY_ROOM_UNLOAD_SECS`      | `60`                | How long a project stays loaded after its last client left.                              |
| `TYPSTRY_PRESENCE_TIMEOUT_SECS` | `30`                | How long a client's cursor stays visible without a refresh.                              |
| `TYPSTRY_UPDATE_BURST`          | `200`               | Document records (and presence updates) one connection may send in a burst.              |
| `TYPSTRY_UPDATES_PER_SEC`       | `50`                | Sustained records per second per connection, after the burst.                            |
| `TYPSTRY_MAX_ROOMS_PER_CONN`    | `8`                 | Rooms one connection may join; a project takes two.                                      |
| `TYPSTRY_OUTBOX_BYTES`          | `67108864` (64 MiB) | Live updates queued for a slow client before it is dropped. Does not limit the doc size. |

### Member groups

These settings control the log of group changes (joins, removals, new links) that the server keeps for each project. See [Members and owners](members-and-owners.md). A member who was offline longer than this log reaches back needs a new link from someone.

| Variable                        | Default             | Description                                                                             |
| ------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `TYPSTRY_COMMIT_RETENTION_SECS` | `7776000` (90 days) | Group changes older than this are dropped. The newest one is always kept.               |
| `TYPSTRY_KEEP_LAST_COMMITS`     | `1000`              | At most this many of the newest group changes are kept per project, whatever their age. |
| `TYPSTRY_MAX_LOG_BYTES`         | `16777216` (16 MiB) | At most this many bytes of group changes are kept per project.                          |
| `TYPSTRY_MAX_COMMIT_BYTES`      | `65536` (64 KiB)    | Largest single group change.                                                            |
| `TYPSTRY_MAX_GROUP_INFO_BYTES`  | `262144` (256 KiB)  | Largest group description, keyring or link rotation a client may store.                 |

### Pairing relay

| Variable                     | Default | Description                                                                 |
| ---------------------------- | ------- | --------------------------------------------------------------------------- |
| `TYPSTRY_RELAY_TTL_SECS`     | `300`   | How long a pairing channel lives. This is how long a pairing code is valid. |
| `TYPSTRY_RELAY_MAX_CHANNELS` | `1000`  | Pairing channels open at the same time, across all users.                   |

[env-filter]: https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html

## Backups

The data directory contains `typstry.db` and a `blobs/` directory. Take a consistent copy of the database while the server is running with:

```sh
typstry-server backup /path/to/backup.db
# or, with Docker Compose:
docker compose exec typstry typstry-server backup /data/backup.db
```

Copy `blobs/` separately. Every record is written to the database as it arrives, so stopping the server does not lose edits.

A backup holds only encrypted data. Restoring it brings back the projects, but nobody can open them without their share links.
