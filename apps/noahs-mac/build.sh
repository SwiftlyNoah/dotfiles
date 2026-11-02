#!/bin/zsh
# Builds "Noah's Mac.app" with swiftc alone and installs it to ~/Applications. Skips the
# build when nothing it is made from changed, and restarts the running app when it did.
# home.nix runs this on every rebuild; `--force` builds anyway.
set -euo pipefail
export PATH="/etc/profiles/per-user/$USER/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

here=${0:A:h}
frames_py=$here/../../wallpaper/frames.py
app="$HOME/Applications/Noah's Mac.app"
stamp="$HOME/Library/Application Support/Noah's Mac/build-hash"
agent=org.nix-community.home.noahs-mac

hash=$(cat "$here/build.sh" "$here"/Sources/*.swift "$frames_py" | shasum -a 256 | cut -d' ' -f1)
if [[ ${1:-} != --force && -d $app && -f $stamp && $(<$stamp) == $hash ]]; then
  exit 0
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/noahs-mac.XXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Noah's Mac.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"

swiftc -O -parse-as-library -swift-version 6 \
  -target "$(uname -m)-apple-macos15.0" \
  -o "$bundle/Contents/MacOS/NoahsMac" \
  "$here"/Sources/*.swift

# The wallpaper's frame names and times, from the one place they are written.
(cd "${frames_py:h}" && uv run --quiet python -c '
import json
from frames import FRAMES
print(json.dumps([{"name": f["name"], "time": f["time"]} for f in FRAMES]))
') > "$bundle/Contents/Resources/frames.json"

cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Noah's Mac</string>
  <key>CFBundleDisplayName</key><string>Noah's Mac</string>
  <key>CFBundleExecutable</key><string>NoahsMac</string>
  <key>CFBundleIdentifier</key><string>com.noahbrauner.noahs-mac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

codesign --force --sign - "$bundle" >/dev/null
mkdir -p "$HOME/Applications" "${stamp:h}"
rm -rf "$app"
mv "$bundle" "$app"
print -r -- "$hash" > "$stamp"

# Restart the running copy so the new build takes over (launchd starts it again).
if launchctl print "gui/$(id -u)/$agent" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$agent" || true
fi
print -r -- "$app"
