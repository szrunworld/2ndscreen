#!/bin/bash
# Build the menu bar app and wrap it in build/2ndscreen.app; also builds the
# 2ndscreen and vdisplay command-line tools in .build/release. adb and
# scrcpy-server, for mirroring Android phones, are downloaded on first run
# (scripts/fetch-android-tools.sh) and put in Contents/Resources/android.
# The task runtime behind `2ndscreen task` — its own pinned Node, the built
# runtime and the skills — goes in Contents/Resources/task-runtime
# (scripts/install-task-runtime.sh).
#
# The bundle gives the app a stable identity, so macOS attributes the Screen
# Recording grant (needed for the preview) to 2ndscreen instead of whichever
# terminal launched it.
#
# It is signed with a self-signed certificate kept in a dedicated keychain
# (~/Library/Keychains/2ndscreen-signing.keychain-db, created on first run).
# macOS ties permission grants to the signing certificate, so they survive
# rebuilds; an ad-hoc signature would change with every build and lose them.
# The keychain holds nothing else and is on the search list only while signing.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/build/2ndscreen.app"
BUNDLE_ID="io.github.szrunworld.2ndscreen"
VERSION="0.1.0"

cd "$ROOT"
# Build every product so the 2ndscreen CLI always matches the app.
swift build -c release
BIN="$(swift build -c release --show-bin-path)/SecondScreen"
CLI="$(swift build -c release --show-bin-path)/2ndscreen"

"$ROOT/scripts/fetch-android-tools.sh"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/android" "$APP/Contents/Resources/bin"
cp "$BIN" "$APP/Contents/MacOS/2ndscreen"
# The command line tool of this very build, which the task runtime drives;
# link it into the PATH (ln -s .../Contents/Resources/bin/2ndscreen) to use it.
cp "$CLI" "$APP/Contents/Resources/bin/2ndscreen"
cp "$ROOT/build/android-tools/adb" "$ROOT/build/android-tools/scrcpy-server" "$APP/Contents/Resources/android/"
"$ROOT/scripts/install-task-runtime.sh" "$APP/Contents/Resources/task-runtime"
# The bundled node keeps the Node.js project's own signature, which the app's seal accepts as is.
codesign --verify --strict "$APP/Contents/Resources/task-runtime/bin/node"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleName</key><string>2ndscreen</string>
    <key>CFBundleDisplayName</key><string>2ndscreen</string>
    <key>CFBundleExecutable</key><string>2ndscreen</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSLocalNetworkUsageDescription</key><string>2ndscreen connects to Android phones on your Wi-Fi to show and control them.</string>
</dict>
</plist>
PLIST

KEYCHAIN="$HOME/Library/Keychains/2ndscreen-signing.keychain-db"
KEYCHAIN_PASSWORD="2ndscreen-local-signing"  # guards only this throwaway signing key
CERT_NAME="2ndscreen Local Signing"

find_identity() {
    security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null \
        | awk -v cn="$CERT_NAME" 'index($0, "\"" cn "\"") { print $2; exit }'
}

if [[ ! -f "$KEYCHAIN" ]]; then
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
    security set-keychain-settings "$KEYCHAIN"  # no auto-lock
fi
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

IDENTITY="$(find_identity)"
if [[ -z "$IDENTITY" ]]; then
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    cat > "$TMP/req.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$CERT_NAME
[ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
    # The system LibreSSL writes a PKCS#12 that `security import` accepts.
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/req.cnf" 2>/dev/null
    /usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
        -out "$TMP/id.p12" -passout "pass:$KEYCHAIN_PASSWORD" -name "$CERT_NAME"
    security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASSWORD" -T /usr/bin/codesign >/dev/null
    # Let codesign use the key without a GUI prompt.
    security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
    IDENTITY="$(find_identity)"
fi
[[ -n "$IDENTITY" ]] || { echo "error: could not create the local signing identity" >&2; exit 1; }

# codesign only finds identities in keychains on the search list, so add the
# signing keychain for the duration of the signature and then restore the list.
ORIGINAL_KEYCHAINS=()
while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    ORIGINAL_KEYCHAINS+=("$(eval "printf '%s' $line")")
done < <(security list-keychains -d user)
restore_keychains() { security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}"; }
security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}" "$KEYCHAIN"
# Nested code is signed before the bundle that seals it.
if ! codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP/Contents/Resources/android/adb" \
    || ! codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --identifier "$BUNDLE_ID.cli" "$APP/Contents/Resources/bin/2ndscreen" \
    || ! codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --identifier "$BUNDLE_ID" "$APP"; then
    restore_keychains
    exit 1
fi
restore_keychains
codesign --verify --strict "$APP"
echo "built $APP"
