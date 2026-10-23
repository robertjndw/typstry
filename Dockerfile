# syntax=docker/dockerfile:1.7

FROM rust:1.99-slim-trixie AS wasm-tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install wasm-pack --locked --version 0.15.0
WORKDIR /src

FROM wasm-tools AS tinymist
COPY apps/web/scripts/build-tinymist.sh apps/web/scripts/
# The checkout and its build cache live in target/, a cache mount; only the
# wasm output in apps/web/vendor ends up in the layer.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/root/.cache/.wasm-pack \
    apps/web/scripts/build-tinymist.sh

FROM wasm-tools AS typst-compiler
# Node runs typst.ts's wasm-debundle step. The script installs the Rust
# version typst.ts pins (1.92), which differs from this image's.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
COPY apps/web/scripts/build-typst-compiler.sh apps/web/scripts/
COPY apps/web/patches/typst-ts-jump.patch apps/web/patches/
# Its own registry cache: this stage runs in parallel with the tinymist one,
# and two cargos unpacking into one registry race on the .cargo-ok marker
# ("File exists (os error 17)").
RUN --mount=type=cache,id=cargo-registry-typst-compiler,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/root/.cache/.wasm-pack \
    apps/web/scripts/build-typst-compiler.sh

FROM wasm-tools AS typstry-wasm
# Only what the wasm build reads, so server or CLI edits keep this stage
# cached. The workspace globs crates/*, so it does not mind the other crates
# being absent. rust-toolchain.toml is left out, like in the server stage.
COPY Cargo.toml Cargo.lock ./
COPY crates/typstry-wire crates/typstry-wire
COPY crates/typstry-wasm crates/typstry-wasm
COPY apps/web/scripts/build-wasm.sh apps/web/scripts/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/root/.cache/.wasm-pack \
    apps/web/scripts/build-wasm.sh

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
COPY --from=typst-compiler /src/apps/web/vendor/typst-ts-web-compiler apps/web/vendor/typst-ts-web-compiler
COPY --from=typstry-wasm /src/apps/web/vendor/typstry-wasm apps/web/vendor/typstry-wasm
# Optional font mirrors (see docs/self-hosting.md). Left unset, the app
# loads the fonts from jsDelivr.
ARG VITE_TYPST_FONT_BASE
ARG VITE_TYPST_DEV_FONT_BASE
RUN pnpm --filter web build

FROM rust:1.99-slim-trixie AS chef
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install cargo-chef --locked --version 0.1.78
WORKDIR /src

# rust-toolchain.toml is left out on purpose here and below: the image already
# has that Rust version, and with the file rustup would download it a second
# time. Keep the image tags in sync with it.
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
# trusts the CA roots compiled into it (webpki-roots) for the Git relay's
# outbound TLS, so it needs no CA bundle in the image.
FROM gcr.io/distroless/cc-debian13
LABEL org.opencontainers.image.title="typstry" \
      org.opencontainers.image.description="Self-hostable, end-to-end encrypted collaborative Typst editor" \
      org.opencontainers.image.source="https://github.com/robertjndw/typstry" \
      org.opencontainers.image.licenses="MIT"
# A fixed uid that stays the same across image updates, so a host directory
# bind-mounted to /data can be chowned to 10001 once and keeps working.
COPY --from=server --chown=10001:10001 /src/data /data
COPY --from=server /src/target/release/typstry-server /usr/local/bin/typstry-server
COPY --from=web /src/apps/web/dist /app/web
COPY LICENSE /usr/share/doc/typstry/LICENSE
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
