#!/bin/sh
# Give every connected display the dynamic wallpaper: build the size of any display that has
# none yet, then set each display's. Hammerspoon runs this whenever a display is plugged in
# or changes resolution (home/.hammerspoon/init.lua), so a new monitor gets Lilac Moon on its
# own. Prints the sizes it built, one "W H" per line; nothing when every size was already there.
set -eu
export PATH="/etc/profiles/per-user/$USER/bin:/usr/bin:/bin:$PATH"
cd "$(dirname "$0")"
WALLPAPERS="$HOME/Pictures/Wallpapers"

# One run at a time: plugging in a display sends several events, and a build takes a minute.
LOCK="${TMPDIR:-/tmp}/lilac-moon-new-displays.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # A lock left by a run that died (a restart mid-build) is cleared after 15 minutes.
  [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ] || exit 0
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
trap 'rm -rf "$LOCK"' EXIT

swift displays.swift sizes | while read -r W H; do
  if [ "$W $H" = "3024 1964" ]; then
    FILE="$WALLPAPERS/lilac-moon-dynamic.heic"
  else
    FILE="$WALLPAPERS/lilac-moon-dynamic-${W}x${H}.heic"
  fi
  if [ ! -f "$FILE" ]; then
    ./build.sh "$W" "$H" >&2
    echo "$W $H"
  fi
done

# Also for a display whose size was built before: macOS starts every new display on its default.
swift displays.swift set "$WALLPAPERS" >&2
