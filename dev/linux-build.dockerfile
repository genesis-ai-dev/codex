# syntax=docker/dockerfile:1
#
# Linux build image for Codex.
#
# Used by dev/build_linux_docker.sh. The wrapper builds this for the host's
# native architecture so the resulting container runs without qemu-user
# emulation (which causes Go runtime segfaults during the gulp compile phase
# under the VSCodium cross-build images, which are amd64-only and force
# emulation on an arm64 host).
#
# Packages are derived from the union of:
#   - .github/workflows/stable-linux.yml compile job setup steps
#   - build/linux/deps.sh
#   - the libraries needed to rebuild vscode's native node modules and run
#     the Rust CLI build in build_cli.sh

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22.21.1
ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip xz-utils \
      build-essential gcc-10 g++-10 \
      python3 python3-pip python-is-python3 pkg-config \
      libkrb5-dev \
      libx11-dev libxkbfile-dev libsecret-1-dev \
      libnss3 libgtk-3-dev libgbm-dev libasound2 \
      fakeroot rpm \
 && rm -rf /var/lib/apt/lists/*

# CI pins GCC 10; match it to avoid native-module build surprises.
RUN update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-10 100 \
 && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-10 100

# Install Node.js from the official tarball so the version matches .nvmrc
# exactly across architectures.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) nodeArch="x64" ;; \
      arm64) nodeArch="arm64" ;; \
      armhf) nodeArch="armv7l" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${nodeArch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    node --version; \
    npm --version

# Rust toolchain for build_cli.sh (Codex CLI pinning feature).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
      sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path \
 && chmod -R a+w "$RUSTUP_HOME" "$CARGO_HOME" \
 && rustc --version

WORKDIR /work
