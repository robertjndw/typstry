# syntax=docker/dockerfile:1.7

FROM rust:1.98-slim-trixie AS tinymist
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-pack --locked --version 0.15.0
WORKDIR /src
COPY apps/web/scripts/build-tinymist.sh apps/web/scripts/
# The checkout and its build cache live in target/, a cache mount; only the
# wasm output in apps/web/vendor ends up in the layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/root/.cache/.wasm-pack \
    apps/web/scripts/build-tinymist.sh

FROM node:26-slim AS web
WORKDIR /src
RUN npm install -g pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm applies these during install (see patchedDependencies).
COPY patches patches
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
COPY --from=tinymist /src/apps/web/vendor/tinymist apps/web/vendor/tinymist
RUN pnpm --filter web build

FROM rust:1.98-slim-trixie AS server
WORKDIR /src
# rust-toolchain.toml is left out on purpose: it pins "stable", which would make
# rustup download a second toolchain instead of using the one in the image.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# target/ lives in a cache mount, so the binary has to be copied out in the
# same step to survive into the next stage.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p typstry-server \
    && cp target/release/typstry-server /usr/local/bin/typstry-server

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /data typstry \
    && mkdir /data && chown typstry /data
COPY --from=server /usr/local/bin/typstry-server /usr/local/bin/typstry-server
COPY --from=web /src/apps/web/dist /app/web
ENV TYPSTRY_ADDR=0.0.0.0:8787 \
    TYPSTRY_DATA_DIR=/data \
    TYPSTRY_WEB_DIST=/app/web \
    RUST_LOG=info
USER typstry
VOLUME /data
EXPOSE 8787
# The server shuts down gracefully (and compacts) on ctrl-c only, and as PID 1
# it would otherwise ignore Docker's default SIGTERM until the kill timeout.
STOPSIGNAL SIGINT
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1
CMD ["typstry-server"]
