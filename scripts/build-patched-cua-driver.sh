#!/bin/bash
# Build and install cua-driver with patches/cua-driver-respect-user-app-switch.patch
# as cua-driver-local (/Applications/CuaDriverLocal.app), beside the official
# cua-driver.
#
# Upstream cua-driver keeps an app from stealing the foreground while it acts
# in the background, but cannot tell that from the user's own Cmd-Tab, so it
# drags the user back. The patch treats an activation that follows real
# keyboard or mouse input as the user's choice. 2ndscreen prefers
# cua-driver-local when it is installed.
#
#   scripts/build-patched-cua-driver.sh [cua-driver-rs-vX.Y.Z]
#
# Defaults to the release of the installed official cua-driver. The build
# needs Rust and the Xcode Command Line Tools, and about 2 GB under
# ~/Library/Caches/2ndscreen/cua. The app is ad-hoc signed, so macOS asks to
# grant Accessibility and Screen Recording again after each rebuild:
# run `cua-driver-local permissions grant`.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$ROOT/patches/cua-driver-respect-user-app-switch.patch"
WORK="$HOME/Library/Caches/2ndscreen/cua"

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
    VERSION="$(cua-driver --version 2>/dev/null | awk '{print $2}')"
    [[ -n "$VERSION" ]] || { echo "error: pass a tag, or install the official cua-driver first" >&2; exit 1; }
    TAG="cua-driver-rs-v$VERSION"
fi

if [[ ! -d "$WORK/.git" ]]; then
    mkdir -p "$(dirname "$WORK")"
    git clone --depth 1 --branch "$TAG" https://github.com/trycua/cua.git "$WORK"
else
    git -C "$WORK" fetch --depth 1 origin tag "$TAG"
    git -C "$WORK" checkout --force --quiet "$TAG"
    git -C "$WORK" clean -fdq -- libs/cua-driver/rust/crates
fi

git -C "$WORK" apply --3way "$PATCH" || {
    echo "error: the patch no longer applies to $TAG; update $PATCH" >&2
    exit 1
}

# Use the stable toolchain already installed instead of downloading the
# repository's pinned one, and sign ad hoc rather than adding a signing
# identity to the login keychain.
cd "$WORK/libs/cua-driver"
RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}" CARGO_INCREMENTAL=0 \
    CUA_DRIVER_LOCAL_SIGNING_KEYCHAIN=/nonexistent \
    bash scripts/install-local.sh --release

echo
echo "Installed $(cua-driver-local --version) with the user-switch patch, built from $TAG."
echo "Grant permissions again: cua-driver-local permissions grant"
