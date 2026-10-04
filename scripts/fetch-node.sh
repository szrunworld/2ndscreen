#!/bin/bash
# Download the Node.js the task runtime ships with into build/node, checked
# against pinned SHA-256 sums, and print its directory. The runtime runs on
# this Node only (inside 2ndscreen.app), never on a Node from the PATH.
#
# Node 22.13 or later runs node:sqlite without a flag; this is the version
# the runtime's tests run on.
set -euo pipefail

VERSION="22.23.2"
ARM64_SHA256="61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
X64_SHA256="58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
case "${NODE_ARCH:-$(uname -m)}" in
    arm64) ARCH=arm64; SHA256="$ARM64_SHA256" ;;
    x86_64|x64) ARCH=x64; SHA256="$X64_SHA256" ;;
    *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
NAME="node-v$VERSION-darwin-$ARCH"
OUT="$ROOT/build/node/$NAME"

if [[ -x "$OUT/bin/node" && "$(cat "$OUT/.verified" 2>/dev/null)" == "$SHA256" ]]; then
    echo "$OUT"
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$NAME.tar.gz" "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz"
echo "$SHA256  $TMP/$NAME.tar.gz" | shasum -a 256 -c --quiet >&2
tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP"
[[ "$("$TMP/$NAME/bin/node" --version)" == "v$VERSION" ]] || { echo "error: $NAME does not report v$VERSION" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$TMP/$NAME" "$OUT"
echo "$SHA256" > "$OUT/.verified"
echo "$OUT"
