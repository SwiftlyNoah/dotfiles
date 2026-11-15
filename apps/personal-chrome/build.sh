#!/bin/zsh
# Builds "Personal Chrome.app" (Sources/App.swift) with swiftc alone and installs it to
# ~/Applications. Skips the build when nothing it is made from changed. home.nix runs this on
# every rebuild, then makes it the default browser; `--force` builds anyway.
set -euo pipefail
export PATH="/etc/profiles/per-user/$USER/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

here=${0:A:h}
app="$HOME/Applications/Personal Chrome.app"
stamp="$HOME/Library/Application Support/Personal Chrome/build-hash"
chrome="/Applications/Google Chrome.app"

hash=$(cat "$here/build.sh" "$here"/Sources/*.swift | shasum -a 256 | cut -d' ' -f1)
if [[ ${1:-} != --force && -d $app && -f $stamp && $(<$stamp) == $hash ]]; then
  exit 0
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/personal-chrome.XXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/Personal Chrome.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"

swiftc -O -parse-as-library -swift-version 6 \
  -target "$(uname -m)-apple-macos15.0" \
  -o "$bundle/Contents/MacOS/PersonalChrome" \
  "$here"/Sources/*.swift

# Chrome's own icon, so the default browser setting and dialogs show the browser it opens.
[[ -f $chrome/Contents/Resources/app.icns ]] && cp "$chrome/Contents/Resources/app.icns" "$bundle/Contents/Resources/"

cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Personal Chrome</string>
  <key>CFBundleDisplayName</key><string>Personal Chrome</string>
  <key>CFBundleExecutable</key><string>PersonalChrome</string>
  <key>CFBundleIdentifier</key><string>com.noahbrauner.personal-chrome</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Web site URL</string>
      <key>CFBundleURLSchemes</key><array><string>http</string><string>https</string></array>
    </dict>
    <dict>
      <key>CFBundleURLName</key><string>Email address URL</string>
      <key>CFBundleURLSchemes</key><array><string>mailto</string></array>
    </dict>
  </array>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>HTML document</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSItemContentTypes</key><array><string>public.html</string><string>public.xhtml</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

xattr -cr "$bundle"
codesign --force --sign - "$bundle" >/dev/null 2>&1
mkdir -p "$HOME/Applications" "${stamp:h}"
rm -rf "$app"
mv "$bundle" "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
print -r -- "$hash" > "$stamp"
print -r -- "$app"
