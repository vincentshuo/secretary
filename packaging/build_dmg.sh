#!/usr/bin/env bash
# Build the manual release assets of ADR 0011 on this Mac: the ad-hoc signed Edison.app
# (zipped), a drag-to-Applications DMG and their SHA-256 checksums, under dist/release/<version>/.
# The app itself comes from build_local_macos.sh, so releases and local builds are one pipeline.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
GUI="$ROOT/surfaces/gui"
APP_NAME="$(node -p "require('$GUI/src-tauri/tauri.conf.json').productName")"
VERSION="$(node -p "require('$GUI/src-tauri/tauri.conf.json').version")"
ARCH="$(uname -m)"

EDISON_OPEN_APP=0 bash "$HERE/build_local_macos.sh"

TARGET="${CARGO_TARGET_DIR:-$GUI/src-tauri/target}"
case "$TARGET" in /*) ;; *) TARGET="$GUI/$TARGET" ;; esac
APP="$TARGET/release/bundle/macos/$APP_NAME.app"
OUT="$ROOT/dist/release/$VERSION"
DMG="$OUT/${APP_NAME}_${VERSION}_${ARCH}.dmg"
ZIP="$OUT/${APP_NAME}_${VERSION}_${ARCH}.app.zip"
rm -rf "$OUT"
mkdir -p "$OUT"

# ditto keeps the sidecar's symlinks and the ad-hoc signature intact.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP" "$STAGING/$APP_NAME.app"
ln -s /Applications "$STAGING/Applications"
mkdir "$STAGING/.background"
cp "$HERE/dmg-background.tiff" "$STAGING/.background/bg.tiff"

# A styled install window needs Finder. Two pitfalls once produced silently unstyled images:
# a stale mounted volume makes ours mount as "$APP_NAME 1", and Finder writes .DS_Store
# asynchronously, so detach only after it lands.
style_dmg() {
  [ -d "/Volumes/$APP_NAME" ] && hdiutil detach "/Volumes/$APP_NAME" -force >/dev/null 2>&1 || true
  local rw info dev mnt vol i
  rw="$(mktemp -u).dmg"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -fs HFS+ -format UDRW -ov "$rw" >/dev/null
  info="$(hdiutil attach -readwrite -noverify -noautoopen "$rw")"
  dev="$(echo "$info" | grep -Eo '^/dev/disk[0-9]+' | head -1)"
  mnt="$(echo "$info" | grep -Eo '/Volumes/.*$' | head -1)"
  [ -n "$dev" ] && [ -n "$mnt" ] || return 1
  vol="$(basename "$mnt")"
  sleep 1
  osascript <<OSA || { hdiutil detach "$dev" -force >/dev/null 2>&1 || true; return 1; }
tell application "Finder"
  tell disk "$vol"
    open
    delay 1
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 840, 543}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 96
    set text size of opts to 12
    set background picture of opts to file ".background:bg.tiff"
    set position of item "$APP_NAME.app" of container window to {172, 190}
    set position of item "Applications" of container window to {468, 190}
    close
    open
    update without registering applications
    delay 3
  end tell
end tell
OSA
  for i in $(seq 1 15); do [ -f "$mnt/.DS_Store" ] && break; sleep 1; done
  [ -f "$mnt/.DS_Store" ] || { hdiutil detach "$dev" -force >/dev/null 2>&1 || true; return 1; }
  sync
  hdiutil detach "$dev" -force >/dev/null
  hdiutil convert "$rw" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
  rm -f "$rw"
}

if ! style_dmg; then
  echo "Finder styling unavailable; writing a plain DMG" >&2
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
fi
hdiutil verify "$DMG" >/dev/null

(cd "$OUT" && shasum -a 256 "$(basename "$ZIP")" "$(basename "$DMG")" > SHA256SUMS)
cat "$OUT/SHA256SUMS"
echo "Release assets: $OUT (ad-hoc signed, not notarised; see docs/adr/0011)"
