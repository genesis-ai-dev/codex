#!/usr/bin/env bash
# Downloads and unpacks bundled extensions into ./extensions/.
# Sourced from build.sh while CWD is vscode/.

set -euo pipefail

if [[ -n "${SKIP_EXTENSIONS:-}" ]]; then
    exit 0
fi

BUNDLE_JSON="../bundle-extensions.json"
EXTENSIONS_DIR="./extensions"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

install_vsix() {
    local name="$1"
    local zip_file="$2"
    local dest="${EXTENSIONS_DIR}/${name}"

    echo "[get-extensions] Installing ${name}..."
    mkdir -p "${TMP_DIR}/${name}"
    unzip -q "${zip_file}" -d "${TMP_DIR}/${name}"
    rm -rf "${dest}"
    mv "${TMP_DIR}/${name}/extension" "${dest}"
    echo "[get-extensions] Installed ${name}"
}

count=$(jq -r '.bundle | length' "${BUNDLE_JSON}")

if [[ "${count}" -eq 0 ]]; then
    echo "[get-extensions] No bundled extensions to download."
    exit 0
fi

for i in $(seq 0 $((count - 1))); do
    name=$(jq -r ".bundle[$i].name" "${BUNDLE_JSON}")
    repo=$(jq -r ".bundle[$i].github_release" "${BUNDLE_JSON}")
    tag=$(jq -r ".bundle[$i].tag" "${BUNDLE_JSON}")
    zip_file="${TMP_DIR}/${name}.vsix"

    echo "[get-extensions] Downloading ${name} from ${repo}@${tag}..."
    gh release download "${tag}" \
        --repo "${repo}" \
        --pattern "*.vsix" \
        --output "${zip_file}"

    install_vsix "${name}" "${zip_file}"
done
