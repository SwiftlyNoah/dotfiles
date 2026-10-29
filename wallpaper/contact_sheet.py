#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11"]
# ///
"""Lay the rendered frames out on one labeled contact sheet.

    uv run contact_sheet.py frames/3024 ~/Pictures/Wallpapers/lilac-moon-dynamic-contact-sheet.png
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from frames import FRAMES

COLS = 4
THUMB_W = 900
GAP = 36
LABEL_H = 76
BG = (31, 29, 48)  # Lilac Moon ground, #1f1d30
TEXT = (224, 222, 244)  # #e0def4
MUTED = (144, 140, 170)  # #908caa


def font(size, bold=False):
    for path, index in (("/System/Library/Fonts/Avenir Next.ttc", 2 if bold else 0),
                        ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0)):
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default(size)


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    files = sorted(src.glob("[0-9][0-9]-*.png"))
    assert len(files) == len(FRAMES), f"expected {len(FRAMES)} frames in {src}, found {len(files)}"
    first = Image.open(files[0])
    thumb_h = round(THUMB_W * first.height / first.width)
    rows = -(-len(files) // COLS)
    W = GAP + COLS * (THUMB_W + GAP)
    H = GAP + rows * (thumb_h + LABEL_H + GAP)
    sheet = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(sheet)
    f_time, f_name = font(34, bold=True), font(30)
    for i, (path, frame) in enumerate(zip(files, FRAMES)):
        r, c = divmod(i, COLS)
        x = GAP + c * (THUMB_W + GAP)
        y = GAP + r * (thumb_h + LABEL_H + GAP)
        sheet.paste(Image.open(path).convert("RGB").resize((THUMB_W, thumb_h), Image.LANCZOS), (x, y))
        ty = y + thumb_h + 18
        draw.text((x + 2, ty), frame["time"], font=f_time, fill=TEXT)
        tw = draw.textlength(frame["time"], font=f_time)
        draw.text((x + 2 + tw + 18, ty + 3), frame["name"], font=f_name, fill=MUTED)
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main()
