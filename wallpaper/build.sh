#!/bin/sh
# Render every frame, pack the dynamic wallpaper into ~/Pictures/Wallpapers, and lay out
# the contact sheet.
#
#   ./build.sh            the 3024 x 1964 built-in display, set as the desktop picture,
#                         plus the contact sheet
#   ./build.sh 6016 3384  another size (for example a 6K external display)
#
# Needs uv (for numpy and Pillow) and swift (Xcode command line tools).
set -eu
export PYTHONDONTWRITEBYTECODE=1
# bootstrap.sh runs this before a new shell has home-manager's packages (uv) on PATH.
export PATH="/etc/profiles/per-user/$USER/bin:$PATH"
cd "$(dirname "$0")"
W=${1:-3024}
H=${2:-1964}
WALLPAPERS="$HOME/Pictures/Wallpapers"
mkdir -p "$WALLPAPERS"
FRAMES_DIR=${FRAMES_DIR:-${TMPDIR:-/tmp}/lilac-moon-dynamic/$W}

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
[ "$W" = 3024 ] && OUT="$WALLPAPERS/lilac-moon-dynamic.heic"
# shellcheck disable=SC2086
swift build_heic.swift "$OUT" "$DARK" "$LIGHT" $PAIRS

if [ "$W" = 3024 ]; then
  uv run contact_sheet.py "$FRAMES_DIR" "$WALLPAPERS/lilac-moon-dynamic-contact-sheet.png"
  # Setting it again also makes macOS reread the file after a rebuild.
  osascript -e "tell application \"System Events\" to set picture of every desktop to POSIX file \"$OUT\""
fi
