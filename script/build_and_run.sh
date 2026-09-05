#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Concat"
PROCESS_NAME="concat"
BUNDLE_ID="com.jub0t.concat"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$PROCESS_NAME"
BUILD_BINARY="$ROOT_DIR/engine/target/quick/$PROCESS_NAME"

export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
export RUSTUP_TOOLCHAIN="1.93"

if command -v brew >/dev/null 2>&1 && brew --prefix ffmpeg >/dev/null 2>&1; then
  FFMPEG_PREFIX="$(brew --prefix ffmpeg)"
  export FFMPEG_PKG_CONFIG_PATH="$FFMPEG_PREFIX/lib/pkgconfig"
  export PKG_CONFIG_PATH="$FFMPEG_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
fi

pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true

cargo build \
  --manifest-path "$ROOT_DIR/engine/Cargo.toml" \
  --profile quick \
  -p concat

mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
cp "$ROOT_DIR/assets/concat_logo_512.png" \
  "$APP_RESOURCES/concat_logo_512.png"
chmod +x "$APP_BINARY"

cat >"$APP_CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$PROCESS_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleIconFile</key>
  <string>concat_logo_512.png</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact \
      --predicate "process == \"$PROCESS_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact \
      --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 3
    pgrep -x "$PROCESS_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
