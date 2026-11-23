#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Fail if Anny's non-commercial SMPL assets (or the excluded warp runtime) reached a bundle.
assert_clean_bundle() {
  local hits
  hits="$(find "$1" -type d \( -name noncommercial -o -name warp \) -print)"
  if [ -n "$hits" ]; then
    echo "ERROR: forbidden directories inside $1:" >&2
    echo "$hits" >&2
    exit 1
  fi
}

uv sync --all-extras
uv run --no-project --with pillow python packaging/generate_icons.py
# Prebuild Anny's model cache so the bundle ships it (spec picks up build/anny-cache).
if [ -f coworker/body/cache.py ]; then
  uv run python -m coworker.body.cache build/anny-cache
else
  echo "WARNING: coworker.body.cache not found — building without a prebuilt Anny cache" >&2
fi
# Install into .venv itself: from a `uv run --with` overlay PyInstaller does not treat .venv's
# site-packages as a package root and collects every torch dylib twice (+~450 MB).
uv pip install pyinstaller
.venv/bin/python -m PyInstaller --noconfirm packaging/openworker-server.spec
assert_clean_bundle dist/openworker-server
uv run python tests/smoke_desktop_privacy.py
mkdir -p surfaces/gui/src-tauri/binaries
python3 - <<'PY'
import shutil
from pathlib import Path
source = Path('dist/openworker-server')
assert source.is_dir()
target = Path('surfaces/gui/src-tauri/binaries/sidecar')
# Replace the generated bundle, never a user workspace.
if target.exists(): shutil.rmtree(target)
shutil.copytree(source, target)
PY
npm --prefix surfaces/gui ci
cd surfaces/gui
npm run tauri build -- --bundles app
APP="${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/macos/Edison.app"
# Tauri dereferences symlinks in resources, duplicating PyInstaller's top-level dylib links
# (torch alone is ~450 MB). Restore them, then re-seal the ad-hoc signature.
(cd "$ROOT/dist/openworker-server" && find . -type l) | while read -r link; do
  dest="$APP/Contents/Resources/sidecar/$link"
  rm -rf "$dest"
  ln -s "$(readlink "$ROOT/dist/openworker-server/$link")" "$dest"
done
codesign --force --sign - --options runtime --entitlements src-tauri/entitlements.plist "$APP"
codesign --verify --strict "$APP"
assert_clean_bundle "$APP"
du -sh "$APP"
if [ "${EDISON_OPEN_APP:-1}" = "1" ]; then
  open "$APP"
fi
