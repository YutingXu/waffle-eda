# syntax=docker/dockerfile:1
# Waffle Linux CI images (arm64 or x64). Built by scripts/ci-linux.sh from this folder only.
#   ubuntu   Ubuntu 24.04: Node (pinned, SHA-256 checked), Python, WebKitGTK 4.1 and its
#            JavaScriptCore, Xvfb. Runs the Node suites, MCP tests, native checks and the .deb.
#   browser  Debian trixie: Chromium (Ubuntu 24.04 ships Chromium only as a snap, which does not
#            run in a container), zsh and playwright-core (lockfile). Runs click-through, perf-canvas,
#            integration-browser and the folder Git test.
#   Both stages hold the npm test dependencies from package-lock.json in /opt/ci-node.
# Base images are pinned by multi-arch index digest. Bump a digest with:
#   docker buildx imagetools inspect ubuntu:24.04 | sed -n 3p
# apt packages come from the distribution's current archive and are not version-pinned.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8
ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
# The Rust toolchain of engine/rust-toolchain.toml (bump both together).
ARG RUST_IMAGE=rust:1.91.1-slim-trixie@sha256:f75071363e7f4771769d4cf81b1b7b290e607f4d4459e8731f6abdcee9982dc8

# rust: the Rust/WebAssembly kernels (engine/). cargo test and scripts/build-engine.py --check run
# here with no network: the crate has no dependencies and the wasm32 target is in the image.
FROM ${RUST_IMAGE} AS rust
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* \
    && rustup target add wasm32-unknown-unknown && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME"

FROM ${UBUNTU_IMAGE} AS ubuntu
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git binutils zsh perl \
      python3 python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 libjavascriptcoregtk-4.1-0 \
      gir1.2-poppler-0.18 heif-gdk-pixbuf libheif-plugin-libde265 webp-pixbuf-loader \
      shared-mime-info hicolor-icon-theme desktop-file-utils python3-gi-cairo xvfb xauth xdotool dbus-x11 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY install-node.sh /tmp/install-node.sh
RUN sh /tmp/install-node.sh && rm /tmp/install-node.sh
# Test-only npm packages (linkedom for the DOM suites), installed from the lockfile with integrity
# checks and no install scripts. linux-steps.sh links them into the work copy as node_modules.
COPY package.json package-lock.json /opt/ci-node/
RUN cd /opt/ci-node && npm ci --ignore-scripts --no-audit --no-fund

FROM ${DEBIAN_IMAGE} AS browser
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils zsh python3 git chromium fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY install-node.sh /tmp/install-node.sh
RUN sh /tmp/install-node.sh && rm /tmp/install-node.sh
COPY package.json package-lock.json /opt/ci-node/
RUN cd /opt/ci-node && npm ci --ignore-scripts --no-audit --no-fund
# Chromium's own sandbox needs privileges a container does not grant; the container is the sandbox.
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"\n' > /usr/local/bin/chromium-ci \
    && chmod 755 /usr/local/bin/chromium-ci
