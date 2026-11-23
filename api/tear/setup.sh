#!/usr/bin/env bash
# Install tear's TypeScript packages (@tear/mbt, @tear/host) into api/tear/node_modules/
# and build the `tear` CLI if it is not already on PATH.
#
# anomalyco/tear is private, so api/package.json stays free of it and CI never fetches it.
# Pass TEAR_DIR=/path/to/tear to reuse an existing checkout without modifying it.
set -euo pipefail

TEAR_REV="97a42a263ccb8902f69daad185b0b558d1316277"
HERE="$(cd "$(dirname "$0")" && pwd)"
TEAR_DIR="${TEAR_DIR:-}"

if [[ -z "$TEAR_DIR" ]]; then
  CACHE="${TEAR_CACHE:-$HOME/.cache/nightmail-tear/tear}"
  if [[ ! -d "$CACHE/.git" ]]; then
    mkdir -p "$(dirname "$CACHE")"
    git clone https://github.com/anomalyco/tear "$CACHE"
  fi
  if ! git -C "$CACHE" cat-file -e "$TEAR_REV^{commit}" 2>/dev/null; then
    git -C "$CACHE" fetch origin
  fi
  git -C "$CACHE" checkout --detach "$TEAR_REV"
  TEAR_DIR="$CACHE"
fi

if [[ ! -d "$TEAR_DIR/mbt/typescript/src" || ! -d "$TEAR_DIR/hosts/typescript/src" ]]; then
  echo "error: TEAR_DIR ($TEAR_DIR) does not look like a reworked tear checkout" >&2
  exit 1
fi

rm -rf "$HERE/node_modules/@tear"
mkdir -p "$HERE/node_modules/@tear/mbt" "$HERE/node_modules/@tear/host"
cp "$TEAR_DIR/mbt/typescript/package.json" "$HERE/node_modules/@tear/mbt/"
cp -R "$TEAR_DIR/mbt/typescript/src" "$HERE/node_modules/@tear/mbt/"
cp "$TEAR_DIR/hosts/typescript/package.json" "$HERE/node_modules/@tear/host/"
cp -R "$TEAR_DIR/hosts/typescript/src" "$HERE/node_modules/@tear/host/"

if ! command -v tear >/dev/null 2>&1; then
  TARGET="${CARGO_TARGET_DIR:-$HOME/.cache/nightmail-tear/target}"
  mkdir -p "$TARGET" "$HOME/.local/bin"
  CARGO_TARGET_DIR="$TARGET" cargo install --locked --path "$TEAR_DIR/crates/tear-cli" --root "$HOME/.local"
fi

echo "tear ready: $(command -v tear) ($(tear --version))"
echo "packages installed in $HERE/node_modules/@tear/{mbt,host}"
