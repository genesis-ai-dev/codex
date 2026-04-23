#!/usr/bin/env bash
# Run a Linux Codex build inside a locally-built Ubuntu container.
#
# Usage:
#   ./dev/build_linux_docker.sh [-a x64|arm64|armhf] [-s] [-i] [-l] [-o] [-p]
#
# Flags:
#   -a ARCH   Target architecture (default: host native, from uname -m)
#   -s        Skip source clone (reuse existing vscode/ in the volume)
#   -i        Build the insider variant
#   -l        Use the latest VS Code version from Microsoft's update API
#   -o        Prep source only, skip compilation
#   -p        Also produce packaged assets (installers, tarballs)
#
# All flags except -a are passed through to dev/build.sh unchanged.
#
# Why a custom image instead of vscodium/vscodium-linux-build-agent:
#   The VSCodium build-agent images (focal-x64, focal-arm64, focal-armhf) are
#   all linux/amd64 images; the -arm64 / -armhf tags are amd64 images with
#   cross-compilers targeting those architectures. Running them on an arm64
#   host therefore requires linux/amd64 qemu-user emulation, which reliably
#   segfaults during the gulp compile phase because Go's runtime (used by
#   esbuild) mistranslates futex/epoll syscalls under qemu.
#
#   Instead this wrapper builds a small Ubuntu 22.04 image from
#   dev/linux-build.dockerfile with the union of packages needed by the CI
#   compile + build jobs, and runs it at the host's native architecture.
#
# How state is isolated from the host mac build:
# - The repo is bind-mounted at /work, so patches/, src/stable/, dev/,
#   bundle-extensions.json, upstream/*.json etc. are shared live.
# - /work/vscode is backed by a per-arch named volume
#   (codex-vscode-linux-<arch>), so the Linux checkout + node_modules live in
#   container storage and do not clobber the host's mac vscode/ tree.
# - /work/patches is overlay-mounted (podman :O) so that apply_patch in
#   utils.sh can rewrite placeholder values (!!APP_NAME!! etc.) in place
#   without touching the host patches/ directory. All writes go to an
#   ephemeral upper layer that is discarded when the container exits.
#   (Docker does not support :O; under docker the host patches/ must be
#   writable by the container user, which is usually fine on Docker Desktop.)
# - The final VSCode-linux-<arch>/ output still lands on the host bind mount,
#   so you can run the binary directly from the repo root.
#
# To nuke the per-arch Linux build state (forces a full reclone + npm ci):
#   podman volume rm codex-vscode-linux-arm64   # or whichever arch
#
# To force a rebuild of the builder image itself (e.g. after bumping Node):
#   podman image rm codex-linux-build:arm64     # or whichever arch
#
# Notes:
# - Works with either `docker` or `podman` (whichever is on PATH).
# - Default arch is the host's native arch so no emulation is involved.

set -euo pipefail

# Default to the host's native architecture so a build on arm64 macOS or
# arm64 Linux runs without qemu emulation (which is slow and has known Go
# runtime segfault issues around futex/epoll translation).
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
  armv7l)        ARCH="armhf" ;;
  *)             ARCH="x64" ;;  # unknown host; x64 is the safest fallback
esac
PASSTHROUGH_FLAGS=()

while getopts ":a:silop" opt; do
  case "$opt" in
    a)
      ARCH="$OPTARG"
      ;;
    s|i|l|o|p)
      PASSTHROUGH_FLAGS+=("-$opt")
      ;;
    \?)
      echo "Unknown flag: -$OPTARG" >&2
      exit 2
      ;;
    :)
      echo "Flag -$OPTARG requires an argument" >&2
      exit 2
      ;;
  esac
done

case "$ARCH" in
  x64)
    PLATFORM="linux/amd64"
    ;;
  arm64)
    # Ubuntu's arm64 manifest entry is tagged linux/arm64/v8; podman's strict
    # variant matching needs the /v8 suffix to resolve it.
    PLATFORM="linux/arm64/v8"
    ;;
  armhf)
    PLATFORM="linux/arm/v7"
    ;;
  *)
    echo "Unsupported arch: $ARCH (want x64, arm64, or armhf)" >&2
    exit 2
    ;;
esac

IMAGE="codex-linux-build:${ARCH}"
VOLUME="codex-vscode-linux-${ARCH}"

if command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
elif command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
else
  echo "Neither docker nor podman found on PATH" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/dev/linux-build.dockerfile"

echo "Runtime:  $RUNTIME"
echo "Image:    $IMAGE"
echo "Platform: $PLATFORM"
echo "Arch:     $ARCH"
echo "Volume:   $VOLUME  -> /work/vscode"
echo "Flags:    ${PASSTHROUGH_FLAGS[*]:-(none)}"
echo "Repo:     $REPO_ROOT"
echo

# Build the builder image if it does not already exist locally.
if ! "$RUNTIME" image exists "$IMAGE" 2>/dev/null && \
   ! "$RUNTIME" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Builder image $IMAGE not found; building from $DOCKERFILE ..."
  "$RUNTIME" build \
    --platform "$PLATFORM" \
    -t "$IMAGE" \
    -f "$DOCKERFILE" \
    "$REPO_ROOT/dev"
  echo
fi

PATCHES_MOUNT=("-v" "$REPO_ROOT/patches:/work/patches")
if [[ "$RUNTIME" == "podman" ]]; then
  PATCHES_MOUNT=("-v" "$REPO_ROOT/patches:/work/patches:O")
fi

exec "$RUNTIME" run --rm -it \
  --platform "$PLATFORM" \
  -v "$REPO_ROOT":/work \
  -v "$VOLUME":/work/vscode \
  "${PATCHES_MOUNT[@]}" \
  -w /work \
  "$IMAGE" \
  bash ./dev/build.sh "${PASSTHROUGH_FLAGS[@]}"
