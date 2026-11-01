#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=11"]
# ///
"""The Lilac Moon desk mat: the wallpaper's night lake, sized for print, with the palette
and the name in the bottom right corner.

    uv run deskmat.py --mm 900x400 --out ~/Pictures/Wallpapers/lilac-moon-deskmat-900x400mm.png

The default 6000 pixels across 900 mm is about 170 dpi, what deskmat.io asks for.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from frames import FRAMES
from render import Scene

# Where the moon sits on the mat that was printed (October 2026), as (fraction of the width,
# points down from the top). The wallpaper's night moon has since moved with the real sun.
MOON = (0.80, 205)

# Love, gold, rose, pine, foam, iris: Rosé Pine Moon's accents, as on the dotfiles page.
DOTS = ["#eb6f92", "#f6c177", "#ea9a97", "#3e8fb0", "#9ccfd8", "#c4a7e7"]
SUBTLE = "#908caa"


def font(size_px: int) -> ImageFont.FreeTypeFont:
    path = subprocess.run(
        ["fc-match", "--format=%{file}", "Maple Mono NF:style=Regular"], capture_output=True, text=True, check=True
    ).stdout
    return ImageFont.truetype(path, size_px)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mm", default="900x400", help="the mat's size in millimeters, WxH")
    ap.add_argument("--px-per-mm", type=float, default=6000 / 900)
    ap.add_argument("--ss", type=int, default=2)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    w_mm, h_mm = (float(v) for v in args.mm.lower().split("x"))
    k = args.px_per_mm
    W, H = round(w_mm * k), round(h_mm * k)

    night = next(f for f in FRAMES if f["name"] == "Night")
    night = {**night, "moon": (*MOON, night["moon"][2])}
    img = Image.fromarray(Scene(W, H, args.ss, moons=(MOON,)).render(night)).convert("RGBA")

    # The label, in millimeters from the bottom right corner: six dots over "lilac moon".
    layer = Image.new("RGBA", img.size)
    d = ImageDraw.Draw(layer)
    r, gap = 2.7 * k, 8.1 * k
    right, dots_y, text_y = W - 50 * k, H - 57 * k, H - 47 * k
    for i, c in enumerate(reversed(DOTS)):
        x = right - r - i * gap
        d.ellipse((x - r, dots_y - r, x + r, dots_y + r), fill=c + "e6")
    d.text((right, text_y), "lilac moon", font=font(round(5.4 * k)), fill=SUBTLE + "d9", anchor="rm")
    img = Image.alpha_composite(img, layer).convert("RGB")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out, dpi=(k * 25.4, k * 25.4))
    print(args.out, f"{W}x{H}")


if __name__ == "__main__":
    main()
