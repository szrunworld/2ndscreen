#!/bin/bash
# Build the menu bar app and wrap it in build/2ndscreen.app.
#
# The bundle gives the app a stable identity, so macOS attributes the Screen
# Recording grant (needed for the preview) to 2ndscreen instead of whichever
# terminal launched it. It is ad-hoc signed: rebuilding changes the signature,
# and macOS may ask for the grant again.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/build/2ndscreen.app"
BUNDLE_ID="io.github.szrunworld.2ndscreen"
VERSION="0.1.0"

cd "$ROOT"
swift build -c release --product SecondScreen
BIN="$(swift build -c release --show-bin-path)/SecondScreen"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/2ndscreen"

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
</dict>
</plist>
PLIST

codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"
echo "built $APP"
