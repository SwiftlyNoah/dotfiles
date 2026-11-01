#!/bin/sh
# Render every frame, pack the dynamic wallpaper into ~/Pictures/Wallpapers, and give each
# connected display the one built for its size.
#
#   ./build.sh            the 3024 x 1964 built-in display (and its contact sheet), plus
#                         every display connected now, for example a 3440 x 1440 ultrawide
#   ./build.sh 6016 3384  just this size (for example a 6K display not plugged in yet)
#
# Needs uv (for numpy and Pillow) and swift (Xcode command line tools).
set -eu
export PYTHONDONTWRITEBYTECODE=1
# bootstrap.sh runs this before a new shell has home-manager's packages (uv) on PATH.
export PATH="/etc/profiles/per-user/$USER/bin:$PATH"
cd "$(dirname "$0")"
WALLPAPERS="$HOME/Pictures/Wallpapers"
mkdir -p "$WALLPAPERS"

build() { # build W H
  W=$1 H=$2
  FRAMES_DIR=${TMPDIR:-/tmp}/lilac-moon-dynamic/$W
  rm -rf "$FRAMES_DIR"
  uv run render.py --width "$W" --height "$H" --out "$FRAMES_DIR"

  # Sun positions and the dark (midnight) and light (midday) frames come from frames.py,
  # split into words on purpose.
  # shellcheck disable=SC2046
  set -- $(uv run python -c '
from frames import FRAMES
names = [f["name"] for f in FRAMES]
print(names.index("Midnight"), names.index("Midday"), *["%g,%g" % f["solar"] for f in FRAMES])
')
  DARK=$1 LIGHT=$2
  shift 2
  PAIRS=""
  for f in "$FRAMES_DIR"/[0-9][0-9]-*.png; do
    PAIRS="$PAIRS $1 $f"
    shift
  done

  OUT="$WALLPAPERS/lilac-moon-dynamic-${W}x${H}.heic"
  [ "$W" = 3024 ] && [ "$H" = 1964 ] && OUT="$WALLPAPERS/lilac-moon-dynamic.heic"
  # shellcheck disable=SC2086
  swift build_heic.swift "$OUT" "$DARK" "$LIGHT" $PAIRS

  if [ "$W" = 3024 ] && [ "$H" = 1964 ]; then
    uv run contact_sheet.py "$FRAMES_DIR" "$WALLPAPERS/lilac-moon-dynamic-contact-sheet.png"
  fi
}

if [ $# -ge 2 ]; then
  build "$1" "$2"
else
  build 3024 1964
  swift displays.swift sizes | while read -r W H; do
    [ "$W $H" = "3024 1964" ] || build "$W" "$H"
  done
fi

# Setting it again also makes macOS reread the file after a rebuild.
swift displays.swift set "$WALLPAPERS"
