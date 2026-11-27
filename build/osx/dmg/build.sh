#!/usr/bin/env bash
set -euo pipefail
app=$1
output=$2
name=$(basename "$app" .app)
scripts=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 -m pip download --disable-pip-version-check --only-binary=:all: --require-hashes \
  -r "$scripts/requirements.txt" -d "$work"
swift "$scripts/background.swift" "$name" "$work"
wheels=("$work"/*.whl)
export PYTHONPATH
PYTHONPATH=$(IFS=:; echo "${wheels[*]}")
python3 -m dmgbuild -s "$scripts/settings.py" -D "app=$app" -D "background=$work/background.png" "$name" "$work/result.dmg"
if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  codesign --sign "$CODESIGN_IDENTITY" "$work/result.dmg"
fi
mv "$work/result.dmg" "$output"
