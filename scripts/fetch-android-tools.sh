#!/bin/bash
# Download adb and scrcpy-server from scrcpy's GitHub release into
# build/android-tools, for scripts/bundle-app.sh to put in the app.
#
# Only these two files are kept: 2ndscreen decodes and draws the video and
# sends input itself, so scrcpy's own client (with FFmpeg and SDL) is not
# needed. adb is thinned to this Mac's architecture.
#
# The server must match SCRCPY_VERSION in AndroidMirror.swift, which it is
# started with; the server refuses any other version.
set -euo pipefail

VERSION="4.1"
SERVER_SHA256="deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae"
ARM64_SHA256="20fd47c9014dd5e0fa77091f3cb7adbda8445a360c4584aeaa0150b5b3988ff3"
X86_64_SHA256="ee2a7223bc8dbdc4f482db1134bcf441178dafb833492b71ca4c22090c58ce72"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/android-tools"
BASE="https://github.com/Genymobile/scrcpy/releases/download/v$VERSION"

case "$(uname -m)" in
    arm64) ARCH=arm64; TARBALL="scrcpy-macos-aarch64-v$VERSION.tar.gz"; TARBALL_SHA256="$ARM64_SHA256" ;;
    x86_64) ARCH=x86_64; TARBALL="scrcpy-macos-x86_64-v$VERSION.tar.gz"; TARBALL_SHA256="$X86_64_SHA256" ;;
    *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

if [[ -f "$OUT/VERSION" && "$(cat "$OUT/VERSION")" == "$VERSION-$ARCH" ]]; then
    exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() {  # URL FILE SHA256
    curl -fsSL -o "$2" "$1"
    echo "$3  $2" | shasum -a 256 -c --quiet
}

fetch "$BASE/scrcpy-server-v$VERSION" "$TMP/scrcpy-server" "$SERVER_SHA256"
fetch "$BASE/$TARBALL" "$TMP/scrcpy.tar.gz" "$TARBALL_SHA256"
tar -xzf "$TMP/scrcpy.tar.gz" -C "$TMP"

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$TMP/scrcpy-server" "$OUT/scrcpy-server"
lipo "$TMP"/scrcpy-macos-*/adb -thin "$ARCH" -output "$OUT/adb" 2>/dev/null \
    || cp "$TMP"/scrcpy-macos-*/adb "$OUT/adb"
chmod +x "$OUT/adb"
echo "$VERSION-$ARCH" > "$OUT/VERSION"
echo "fetched adb and scrcpy-server $VERSION into $OUT"
