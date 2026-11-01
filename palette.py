#!/usr/bin/env python3
"""Holds the configs that can't read palette.json to it.

    python3 palette.py --check

WezTerm's Lua, herdr's TOML and the status line's shell write their colors out. Every color
there must be one of Lilac Moon's (moon in palette.json), and the status line's RGB triples
must match the hex beside them. The Python that paints with the palette reads the file itself.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MOON = json.loads((ROOT / "palette.json").read_text())["moon"]
NAMES = {hex_: name for name, hex_ in MOON.items()}
HEX = re.compile(r"#[0-9a-fA-F]{6}\b")
FILES = ["home/.config/wezterm/wezterm.lua", "home/.config/herdr/config.toml", "home/.claude/statusline.sh"]
RGB = re.compile(r"rgb (\d+) (\d+) (\d+)\)\s*#\s*(#[0-9a-fA-F]{6})")


def check() -> list[str]:
    errors = []
    for rel in FILES:
        for n, line in enumerate((ROOT / rel).read_text().splitlines(), 1):
            for hex_ in HEX.findall(line):
                if hex_.lower() not in NAMES:
                    errors.append(f"{rel}:{n}: {hex_} is not a Lilac Moon color (palette.json)")
            if m := RGB.search(line):
                r, g, b, hex_ = m.groups()
                if "#%02x%02x%02x" % (int(r), int(g), int(b)) != hex_.lower():
                    errors.append(f"{rel}:{n}: rgb {r} {g} {b} is not {hex_}")
    return errors


if __name__ == "__main__":
    if sys.argv[1:] != ["--check"]:
        sys.exit(__doc__)
    problems = check()
    print("\n".join(problems) or "palette: every color is Lilac Moon's")
    sys.exit(1 if problems else 0)
