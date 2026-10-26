#!/usr/bin/env python3
"""Draws the README's images in the terminal's own look: Rosé Pine (Moon for dark, Dawn
for light) and Maple Mono, embedded as a small subset so GitHub shows the real font.

    python=$(nix build --no-link --print-out-paths --impure --expr \\
      '(builtins.getFlake "nixpkgs").legacyPackages.${builtins.currentSystem}.python3.withPackages
        (p: [ p.fonttools p.brotli ])')/bin/python3
    fonts=$(nix build --no-link --print-out-paths nixpkgs#maple-mono.NF)/share/fonts/truetype
    $python .github/readme/make.py "$fonts"

Writes palette.svg, statusline.svg and the two diagrams (each as -dark and -light) next to
this file. hero.webp and sidebar.webp are screenshots of a demo session, made by hand.
"""
import base64
import io
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).parent
FONTS = Path(sys.argv[1])

# Lilac Moon: Rosé Pine Moon with my own ground and softer text, as the terminal has it.
MOON = dict(base="#1f1d30", surface="#2a273f", overlay="#393552", muted="#6e6a86", subtle="#908caa",
            text="#cfcce0", love="#eb6f92", gold="#f6c177", rose="#ea9a97", pine="#3e8fb0",
            foam="#9ccfd8", iris="#c4a7e7", low="#2a283e", med="#44415a", high="#56526e")
DAWN = dict(base="#faf4ed", surface="#fffaf3", overlay="#f2e9e1", muted="#9893a5", subtle="#797593",
            text="#575279", love="#b4637a", gold="#ea9d34", rose="#d7827e", pine="#286983",
            foam="#56949f", iris="#907aa9", low="#f4ede8", med="#dfdad9", high="#cecacd")
ADVANCE = 0.6  # Maple Mono: every glyph is 0.6 em wide


def font_face(texts, weights=(("Regular", 400), ("SemiBold", 600))):
    """@font-face rules with Maple Mono cut down to the characters these texts use."""
    chars = "".join(sorted(set("".join(texts)) | {" "}))
    rules = []
    for style, weight in weights:
        font = TTFont(FONTS / f"MapleMono-NF-{style}.ttf")
        opts = subset.Options()
        opts.flavor = "woff2"
        opts.layout_features = ["kern"]  # no ligatures: the images show text as typed
        sub = subset.Subsetter(opts)
        sub.populate(text=chars)
        sub.subset(font)
        buf = io.BytesIO()
        font.flavor = "woff2"
        font.save(buf)
        data = base64.b64encode(buf.getvalue()).decode()
        rules.append(f"@font-face{{font-family:Maple;font-weight:{weight};"
                     f"src:url(data:font/woff2;base64,{data}) format('woff2')}}")
    return "".join(rules)


class Svg:
    def __init__(self, w, h):
        self.w, self.h, self.parts, self.texts = w, h, [], []

    def rect(self, x, y, w, h, fill, r=14, stroke=None, opacity=1):
        s = f' stroke="{stroke}" stroke-width="1.5"' if stroke else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"'
                          f' fill-opacity="{opacity}"{s}/>')

    def text(self, x, y, s, fill, size=16, weight=400, anchor="start"):
        self.texts.append(s)
        self.parts.append(f'<text x="{x}" y="{y}" fill="{fill}" font-size="{size}" font-weight="{weight}"'
                          f' text-anchor="{anchor}">{escape(s)}</text>')

    def spans(self, x, y, runs, size=16, weight=400):
        """One line of differently colored runs: [(text, color), ...]."""
        self.texts.extend(t for t, _ in runs)
        inner = "".join(f'<tspan fill="{c}">{escape(t)}</tspan>' for t, c in runs)
        self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}"'
                          f' xml:space="preserve">{inner}</text>')

    def path(self, d, stroke, width=1.8, dash=None, marker=True):
        da = f' stroke-dasharray="{dash}"' if dash else ""
        mk = ' marker-end="url(#arrow)"' if marker else ""
        self.parts.append(f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{width}"'
                          f' stroke-linecap="round"{da}{mk}/>')

    def circle(self, cx, cy, r, fill, stroke=None):
        s = f' stroke="{stroke}" stroke-width="1.5"' if stroke else ""
        self.parts.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"{s}/>')

    def write(self, name, arrow_color="#6e6a86", title=""):
        style = font_face(self.texts) + "text{font-family:Maple,ui-monospace,monospace}"
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
               f'viewBox="0 0 {self.w} {self.h}" role="img" aria-label="{escape(title)}">'
               f'<title>{escape(title)}</title><style>{style}</style>'
               f'<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" '
               f'markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" '
               f'stroke="{arrow_color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
               f'</marker></defs>' + "".join(self.parts) + "</svg>")
        (HERE / name).write_text(svg)
        print(f"{name}: {len(svg) // 1024} KB")


def palette():
    """The terminal's colors. Always Lilac Moon: it shows what the terminal looks like."""
    p = MOON
    s = Svg(960, 300)
    s.rect(0, 0, 960, 300, p["base"], r=20)
    s.text(40, 62, "Lilac Moon", p["text"], 26, 600)
    s.text(920, 62, "Maple Mono", p["subtle"], 18, anchor="end")
    accents = ["love", "gold", "rose", "pine", "foam", "iris"]
    w, gap, x0 = 133, 16, 40
    for i, name in enumerate(accents):
        x = x0 + i * (w + gap)
        s.rect(x, 96, w, 74, p[name], r=16)
        s.text(x + 4, 200, name, p["text"], 16, 600)
        s.text(x + 4, 224, p[name], p["muted"], 14)
    tones = ["base", "surface", "overlay", "muted", "subtle", "text"]
    for i, name in enumerate(tones):
        x = x0 + i * (w + gap)
        s.rect(x, 250, 22, 22, p[name], r=6, stroke=p["med"])
        s.text(x + 32, 267, name, p["subtle"], 14)
    s.write("palette.svg", title="The Lilac Moon palette in Maple Mono")


def statusline():
    """The Claude status line in its three moods, on a terminal-dark card."""
    p = MOON
    s = Svg(960, 214)
    s.rect(0, 0, 960, 214, p["base"], r=20)

    def bar(pct, color):
        filled = max(1, pct * 14 // 100)
        return [("━" * filled, color), ("─" * (14 - filled), p["high"])]

    rows = [(18, p["foam"], "a fresh session"), (63, p["gold"], "past half"), (91, p["love"], "nearly full")]
    for i, (pct, color, label) in enumerate(rows):
        y = 64 + i * 52
        s.spans(40, y, [("Opus 5.5", p["subtle"]), (" · ", p["subtle"]), ("noah", p["iris"]),
                        (" · ctx ", p["subtle"]), *bar(pct, color), (f" {pct}%", p["subtle"])], size=19)
        s.text(920, y, label, p["muted"], 15, anchor="end")
    s.write("statusline.svg", title="The Claude status line: model, account, context")


def card(s, p, x, y, w, h, title, lines, accent):
    s.rect(x, y, w, h, p["surface"], r=16, stroke=p["med"])
    s.rect(x, y + 18, 4, 26, p[accent], r=2)
    s.text(x + 22, y + 38, title, p["text"], 17, 600)
    for i, line in enumerate(lines):
        s.text(x + 22, y + 66 + i * 24, line, p["subtle"], 14)


def fits_together(p, suffix):
    s = Svg(960, 420)
    s.rect(0, 0, 960, 420, p["base"], r=20)
    card(s, p, 30, 40, 220, 96, "flake.lock", ["pins every input"], "muted")
    card(s, p, 30, 176, 220, 144, "flake.nix", ["user + platform", "one Mac per line", "lint check, CI"], "iris")
    card(s, p, 330, 40, 290, 150, "configuration.nix", ["nix-darwin", "macOS + security", "Homebrew (zap)"], "pine")
    card(s, p, 330, 230, 290, 150, "home.nix", ["home-manager", "Node, Python, CLI tools", "zsh, git, launchd jobs"], "foam")
    card(s, p, 700, 230, 230, 150, "home/", ["the real files, live:", "WezTerm, herdr,", "Claude, AGENTS.md"], "gold")
    card(s, p, 700, 40, 230, 150, "your Mac", ["settings, apps,", "shell, terminal,", "agents"], "rose")
    s.path("M140 136 L140 172", p["muted"])
    s.path("M250 228 C292 228 290 115 326 115", p["muted"])
    s.path("M250 268 C292 268 290 305 326 305", p["muted"])
    s.path("M620 115 L696 115", p["muted"])
    s.path("M620 305 L696 305", p["muted"])
    s.path("M815 230 L815 194", p["muted"], dash="4 6")
    s.write(f"fits-together-{suffix}.svg", p["muted"], "How the dotfiles fit together")


def new_mac(p, suffix):
    s = Svg(960, 520)
    s.rect(0, 0, 960, 520, p["base"], r=20)
    s.rect(30, 30, 900, 56, p["overlay"], r=14)
    s.spans(54, 65, [("$ ", p["muted"]), ('/bin/bash -c "$(curl -fsSL …/bootstrap.sh)"', p["text"])], size=17)
    steps = [("0", "Command Line Tools, clone"), ("1", "Determinate Nix"), ("2", "your username"),
             ("3", "first switch"), ("4", "Claude Code"), ("5", "GitHub, your settings"),
             ("6", "Claude setup"), ("7", "latest of everything"), ("8", "screen lock")]
    for row in range(3):
        y = 140 + row * 86
        s.path(f"M66 {y} L666 {y}", p["med"], width=2, marker=False)
        for col in range(3):
            n, label = steps[row * 3 + col]
            x = 66 + col * 300
            s.circle(x, y, 15, p["surface"], stroke=p["iris"])
            s.text(x, y + 5, n, p["iris"], 14, 600, anchor="middle")
            s.text(x - 14, y + 42, label, p["subtle"], 14)
    s.rect(30, 404, 900, 90, p["surface"], r=16, stroke=p["med"])
    s.text(54, 436, "then it lists what needs you", p["text"], 16, 600)
    s.text(54, 464, "GitHub sign-in · Xcode · FileVault · Time Machine · App Store apps", p["subtle"], 14)
    s.write(f"new-mac-{suffix}.svg", p["muted"], "Setting up a new Mac in one command")


palette()
statusline()
for pal, suffix in ((MOON, "dark"), (DAWN, "light")):
    fits_together(pal, suffix)
    new_mac(pal, suffix)
