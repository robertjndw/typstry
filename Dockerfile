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

FROM rust:1.98-slim-trixie AS chef
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install cargo-chef --locked --version 0.1.78
WORKDIR /src

# rust-toolchain.toml is left out on purpose here and below: it pins "stable",
# which would make rustup download a second toolchain instead of using the one
# in the image.
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo chef prepare --recipe-path recipe.json

# Dependencies get their own layer so CI's layer cache keeps them across
# changes to our crates. A target/ cache mount doesn't survive between runners.
# Same for the registry, otherwise every crate gets downloaded again.
FROM chef AS server
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --locked -p typstry-server --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release --locked -p typstry-server
# Copied into the runtime image, which has no shell to mkdir with.
RUN mkdir /src/data

# The server only needs glibc and libgcc_s, which the cc variant has. It
# makes no outbound TLS connections, so no CA certificates either.
FROM gcr.io/distroless/cc-debian13
# Not distroless's nonroot user (65532): volumes from the old Debian-based
# image are owned by 10001.
COPY --from=server --chown=10001:10001 /src/data /data
COPY --from=server /src/target/release/typstry-server /usr/local/bin/typstry-server
COPY --from=web /src/apps/web/dist /app/web
ENV TYPSTRY_ADDR=0.0.0.0:8787 \
    TYPSTRY_DATA_DIR=/data \
    TYPSTRY_WEB_DIST=/app/web \
    RUST_LOG=info
USER 10001:10001
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["typstry-server", "healthcheck"]
CMD ["typstry-server"]
