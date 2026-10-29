#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pillow>=11"]
# ///
"""Lilac Moon dynamic wallpaper renderer.

A still lake under the Lilac Moon: layered mountain ranges, a far pine shoreline,
two stands of tall pines framing the corners, and water that mirrors it all. The
geometry is seeded and fixed; only light, color and sky change from frame to frame.

    uv run render.py --width 3024 --height 1964 --out frames/3024
    uv run render.py --width 1512 --height 982 --out frames/preview --only 0,6

Geometry is laid out in "points" on a 982-point-tall canvas (the height of the
original 1512 x 982 Lilac Moon wallpaper), so any resolution renders the same scene.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image

from frames import FRAMES

REF_H = 982.0
SHORE = 0.80  # shoreline, as a fraction of the height
LAMP = (0.285,)  # the far-shore cabin light, as a fraction of the width


def rgb(h: str) -> np.ndarray:
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], np.float32) / 255.0


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def over(img: np.ndarray, color, cov: np.ndarray) -> None:
    """Paint a flat color (or a per-pixel color field) over img with coverage cov."""
    c = color if isinstance(color, np.ndarray) and color.ndim == 3 else np.asarray(color, np.float32)
    img += (c - img) * cov[..., None]


class Noise:
    """Seeded value noise in one and two dimensions."""

    def __init__(self, seed: int):
        r = np.random.default_rng(seed)
        self.t1 = (r.random(4096) * 2 - 1).astype(np.float32)
        self.t2 = (r.random((512, 512)) * 2 - 1).astype(np.float32)

    def n1(self, x):
        x = np.asarray(x, np.float64)
        i = np.floor(x)
        f = x - i
        i = i.astype(np.int64)
        f = f * f * (3 - 2 * f)
        a = self.t1[i & 4095]
        b = self.t1[(i + 1) & 4095]
        return (a + (b - a) * f).astype(np.float32)

    def f1(self, x, octaves=5, gain=0.5):
        s, amp, norm = 0.0, 1.0, 0.0
        for o in range(octaves):
            s = s + amp * self.n1(np.asarray(x) * (2.0**o) + o * 37.17)
            norm += amp
            amp *= gain
        return s / norm

    def n2(self, x, y):
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        xi, yi = np.floor(x), np.floor(y)
        fx, fy = x - xi, y - yi
        xi, yi = xi.astype(np.int64), yi.astype(np.int64)
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        t = self.t2
        a = t[yi & 511, xi & 511]
        b = t[yi & 511, (xi + 1) & 511]
        c = t[(yi + 1) & 511, xi & 511]
        d = t[(yi + 1) & 511, (xi + 1) & 511]
        return (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy).astype(np.float32)

    def f2(self, x, y, octaves=4, gain=0.5):
        s, amp, norm = 0.0, 1.0, 0.0
        for o in range(octaves):
            k = 2.0**o
            s = s + amp * self.n2(x * k + o * 19.3, y * k + o * 7.1)
            norm += amp
            amp *= gain
        return s / norm


class Scene:
    def __init__(self, W: int, H: int, ss: int = 3):
        self.W, self.H, self.ss = W, H, ss
        self.s = H / REF_H  # pixels per point
        self.Wp = W / self.s  # width in points
        self.y0 = SHORE * H  # shoreline in pixels
        self.noise = Noise(7)
        self.X = (np.arange(W, dtype=np.float32) + 0.5)[None, :].repeat(H, 0)
        self.Y = (np.arange(H, dtype=np.float32) + 0.5)[:, None].repeat(W, 1)
        self._mountains()
        self._shoreline()
        self._foreground()
        self._stars()
        self._clouds()
        self._water()

    # ---------- geometry helpers ----------

    def pt(self, v):
        return v * self.s

    def ridge_cov(self, ridge_px: np.ndarray) -> np.ndarray:
        """Antialiased coverage of everything below a ridge line given per column in px."""
        slope = np.gradient(ridge_px)
        d = (self.Y - ridge_px[None, :]) / np.sqrt(1 + slope**2)[None, :]
        return np.clip(d + 0.5, 0, 1).astype(np.float32)

    def ridge(self, peaks, base_pt, seed, rough=1.0):
        """A mountain ridge line in px per column.

        peaks: (u, height pt, left half-width, right half-width), widths as fractions
        of the width. They set the broad massing; ridged multifractal noise carves
        the crests, shoulders and gullies within it.
        """
        n = Noise(seed)
        xp = (np.arange(self.W) + 0.5) / self.s  # x in points
        u = xp / self.Wp
        env = np.zeros_like(u)
        for pu, ph, wl, wr in peaks:
            d = np.where(u < pu, (pu - u) / wl, (u - pu) / wr)
            dc = np.clip(d, 0, 1)
            prof = ph * (0.72 * (1 - dc) ** 1.35 + 0.28 * (1 - dc**2))  # concave flanks, a fuller summit
            env = np.log(np.exp(env / 10.0) + np.exp(prof / 10.0) - 1.0) * 10.0  # soft max
        rm, amp, norm, w = 0.0, 1.0, 0.0, 1.0
        for o, wl_pt in enumerate((260, 130, 64, 32, 16, 8)):
            v = (1 - np.abs(n.n1(xp / wl_pt + o * 13.7))) ** 2
            rm = rm + amp * v * w
            w = np.clip(v * 1.6, 0.25, 1)  # crests stay rough, valleys smooth
            norm += amp
            amp *= 0.5
        rm = rm / norm
        h = env * (0.78 + 0.5 * rough * (rm - 0.4))
        return self.pt(base_pt - np.maximum(h, 0))

    def pine_cov(self, trees, row_lo: float, row_hi: float) -> np.ndarray:
        """Supersampled coverage of a list of pines over rows [row_lo, row_hi) in px."""
        ss = self.ss
        r_lo, r_hi = int(math.floor(row_lo)), int(math.ceil(row_hi))
        Hs, Ws = (r_hi - r_lo) * ss, self.W * ss
        m = np.zeros((Hs, Ws), bool)
        for cx, by, h, w, seed in trees:
            x0 = max(0, int((cx - w * 1.15) * ss))
            x1 = min(Ws, int((cx + w * 1.15) * ss) + 1)
            r0 = max(0, int((by - h - r_lo) * ss))
            r1 = min(Hs, int((by - r_lo) * ss) + 1)
            if x0 >= x1 or r0 >= r1:
                continue
            ys = (np.arange(r0, r1) + 0.5) / ss + r_lo
            xs = (np.arange(x0, x1) + 0.5) / ss
            t = (by - ys) / h
            hl, hr = self.crown(t, h, seed)
            dx = xs[None, :] - cx
            inside = np.where(dx < 0, -dx < (hl * w)[:, None], dx < (hr * w)[:, None])
            m[r0:r1, x0:x1] |= inside
        cov = m.reshape(Hs // ss, ss, Ws // ss, ss).sum(axis=(1, 3), dtype=np.uint8).astype(np.float32) / (ss * ss)
        full = np.zeros((self.H, self.W), np.float32)
        a, b = max(0, r_lo), min(self.H, r_hi)
        full[a:b] = cov[a - r_lo : b - r_lo]
        return full

    def crown(self, t, h_px, seed):
        """Half-width profile (left, right) of a fir: uneven tiers of drooping branches."""
        r = np.random.default_rng(seed)
        nz = Noise(seed % 100000)
        h_pt = h_px / self.s
        n = int(np.clip(4 + h_pt / 24.0, 4, 22))
        # Tier boundaries: uneven spacing, closer together toward the tip.
        gaps = r.uniform(0.7, 1.3, n) * (1 - 0.45 * np.arange(n) / n)
        bounds = 0.04 + np.concatenate([[0], np.cumsum(gaps)]) / gaps.sum() * 0.96
        tc = np.clip(t, 0, 0.99999)
        k = np.clip(np.searchsorted(bounds, tc, side="right") - 1, 0, n - 1)
        fr = (tc - bounds[k]) / (bounds[k + 1] - bounds[k])
        taper = np.clip(1 - t, 0, 1) ** 0.95
        out = []
        for side in range(2):
            jit = np.clip(1 + 0.14 * r.standard_normal(n), 0.72, 1.3)
            saw = 0.52 + 0.48 * (1 - fr) ** 1.25
            # Ragged branch tips along the edge.
            rag = 1 + 0.07 * nz.f1(t * h_pt / 3.0 + side * 50, 2)
            hw = taper * saw * jit[k] * rag
            trunk = 0.05 + 0.6 / max(h_pt, 10)
            hw = np.where(t < 0.04, trunk, hw)
            hw = np.where((t < 0) | (t > 1), 0, hw)
            out.append(hw)
        return out[0], out[1]

    # ---------- static scene ----------

    def _mountains(self):
        # Three ranges, each nearer one darker. Big shoulders toward both edges,
        # low and quiet in the middle, where the windows sit.
        back = self.ridge(
            [(0.05, 175, 0.10, 0.14), (0.30, 120, 0.10, 0.12), (0.50, 70, 0.14, 0.14),
             (0.68, 150, 0.10, 0.08), (0.88, 215, 0.12, 0.13)],
            SHORE * REF_H - 12, seed=5, rough=1.2)
        far = self.ridge(
            [(0.10, 125, 0.12, 0.07), (0.215, 180, 0.12, 0.15), (0.36, 70, 0.07, 0.10),
             (0.50, 34, 0.10, 0.10), (0.63, 52, 0.08, 0.07), (0.76, 140, 0.12, 0.12),
             (0.865, 175, 0.11, 0.08), (0.985, 125, 0.07, 0.10)],
            SHORE * REF_H - 6, seed=11, rough=1.2)
        mid = self.ridge(
            [(0.0, 105, 0.10, 0.13), (0.12, 70, 0.06, 0.12), (0.30, 38, 0.10, 0.07),
             (0.56, 22, 0.10, 0.12), (0.67, 40, 0.07, 0.10), (0.81, 74, 0.11, 0.06),
             (0.94, 92, 0.07, 0.11)],
            SHORE * REF_H - 2, seed=23, rough=1.2)
        self.back_cov = self.ridge_cov(back)
        self.far_cov = self.ridge_cov(far)
        self.mid_cov = self.ridge_cov(mid)
        self.far_ridge = far

    def _shoreline(self):
        r = np.random.default_rng(31)
        n = self.noise
        trees = []
        x = -4.0
        while x < self.Wp + 4:
            u = x / self.Wp
            edge = smoothstep(0.42, 0.04, u) + smoothstep(0.58, 0.96, u)
            clump = 0.5 + 0.5 * float(n.f1(np.array([x / 60.0]), 3)[0])
            p = 0.18 + 0.75 * edge * (0.5 + 0.5 * clump) + 0.25 * clump
            if r.random() < p:
                hgt = (6 + 15 * edge + 6 * clump) * (0.65 + 0.55 * r.random())
                base = SHORE * REF_H + 0.6 + r.random() * 0.8
                trees.append((self.pt(x), self.pt(base), self.pt(hgt), self.pt(hgt * (0.26 + 0.08 * r.random())), int(r.integers(1 << 30))))
            x += 1.6 + 2.6 * r.random()
        top = self.y0 - self.pt(60)
        cov = self.pine_cov(trees, top, self.y0 + self.pt(3))
        # A thin strip of land under the trees, with a few low hummocks.
        xp = (np.arange(self.W) + 0.5) / self.s
        strip = SHORE * REF_H - 1.2 - 1.6 * np.clip(n.f1(xp / 35.0 + 9, 3), 0, 1)
        land = self.ridge_cov(self.pt(strip))
        land *= (self.Y < self.y0 + 0.5)
        self.shore_cov = np.maximum(cov, land)

    def _foreground(self):
        r = np.random.default_rng(47)
        xp = (np.arange(self.W) + 0.5) / self.s
        Wp = self.Wp
        n = Noise(53)
        # Two low banks in the near corners; open water between them.
        left = 922 + 75 * smoothstep(40, 300, xp) + 4 * n.f1(xp / 30.0, 3)
        right = 934 + 70 * smoothstep(Wp - 40, Wp - 270, xp) + 4 * n.f1(xp / 30.0 + 50, 3)
        bank = np.minimum(left, right)
        self.bank_cov = self.ridge_cov(self.pt(bank))

        def base_at(x, h):
            i = int(np.clip(x * self.s, 0, self.W - 1))
            return bank[i] + 0.05 * h + 2

        stands = [
            # (x in points from the edge, height in points)
            (-14, 470), (30, 395), (70, 300), (104, 215), (138, 150), (166, 104), (192, 70), (214, 46),
        ]
        stands_r = [
            (-6, 440), (40, 350), (80, 255), (118, 175), (150, 118), (178, 76), (200, 50),
        ]
        trees = []
        for x, h in stands:
            x += r.normal(0, 4)
            h *= 0.94 + 0.12 * r.random()
            trees.append((self.pt(x), self.pt(base_at(x, h)), self.pt(h), self.pt(h * 0.24), int(r.integers(1 << 30))))
        for x, h in stands_r:
            x = Wp - x + r.normal(0, 4)
            h *= 0.94 + 0.12 * r.random()
            trees.append((self.pt(x), self.pt(base_at(x, h)), self.pt(h), self.pt(h * 0.24), int(r.integers(1 << 30))))
        top = min(t[1] - t[2] for t in trees) - 2
        self.fg_cov = np.maximum(self.pine_cov(trees, top, self.H), self.bank_cov)

    def _stars(self):
        """Seeded stars, thinner toward the middle where windows sit."""
        r = np.random.default_rng(26)
        W, H = self.W, self.H
        rgbf = np.zeros((H, W, 3), np.float32)
        alpha = np.zeros((H, W), np.float32)
        moons = [(f["moon"][0] * self.Wp, f["moon"][1]) for f in FRAMES if f.get("moon")]
        cols = [rgb("#e0def4"), rgb("#c4a7e7"), rgb("#ea9a97"), rgb("#9ccfd8")]
        count = int(900 * self.Wp / 1512)
        for _ in range(count):
            x, y = r.random() * self.Wp, 20 + r.random() * (SHORE * REF_H - 40)
            edge = min(1.0, math.hypot((x - self.Wp / 2) / (self.Wp / 2), (y - 420) / 420))
            keep = r.random() < 0.12 + 0.88 * edge
            big = r.random() > 0.95
            rad = 1.25 if big else 0.45 + r.random() * 0.5
            op = 0.6 if big else 0.14 + r.random() * 0.34
            col = cols[1 + int(r.integers(0, 3))] if big else cols[0]
            if not keep or any(math.hypot(x - mx, y - my) < 75 for mx, my in moons):
                continue
            # Fade toward the horizon, as the air thickens.
            op *= float(smoothstep(SHORE * REF_H - 30, SHORE * REF_H - 230, y))
            cx, cy = self.pt(x), self.pt(y)
            sig = max(0.55, self.pt(rad) * 0.62)
            k = int(math.ceil(sig * 3))
            x0, x1 = max(0, int(cx) - k), min(W, int(cx) + k + 1)
            y0, y1 = max(0, int(cy) - k), min(H, int(cy) + k + 1)
            gx = (np.arange(x0, x1) + 0.5 - cx)
            gy = (np.arange(y0, y1) + 0.5 - cy)
            g = np.exp(-(gy[:, None] ** 2 + gx[None, :] ** 2) / (2 * sig * sig))
            g = g / g.max() * op
            rgbf[y0:y1, x0:x1] += g[..., None] * col
            alpha[y0:y1, x0:x1] += g
        self.star_rgb, self.star_a = rgbf, np.clip(alpha, 0, 1)

    def _clouds(self):
        """Long, thin lenticular bands of stratus near the top corners and above the far peaks.

        Each band tapers to fine points and has a soft (not blurry) edge; the lower
        edge can catch the light. A cloud is two or three overlapping bands.
        """
        specs = [
            # (center u, y pt, [(dx pt, dy pt, half length pt, half thickness pt, opacity), ...])
            (0.14, 104, [(0, 0, 190, 6.5, 0.85), (-80, -10, 110, 4.5, 0.6), (90, 10, 130, 4.0, 0.7)]),
            (0.89, 74, [(0, 0, 150, 5.5, 0.8), (50, 10, 110, 4.0, 0.65), (-50, -8, 70, 3.0, 0.5)]),
            (0.13, 548, [(0, 0, 130, 4.2, 0.7), (40, 8, 90, 3.2, 0.55)]),
            (0.86, 522, [(0, 0, 150, 4.8, 0.75), (-36, 9, 96, 3.6, 0.6), (64, -8, 60, 2.8, 0.5)]),
        ]
        n = Noise(101)
        a_all = np.zeros((self.H, self.W), np.float32)
        lit_all = np.zeros((self.H, self.W), np.float32)
        for cu, cy, bands in specs:
            cx = cu * self.Wp
            for dx, dy, L, th, op in bands:
                x, y = cx + dx, cy + dy
                x0, x1 = max(0, int(self.pt(x - L - 4))), min(self.W, int(self.pt(x + L + 4)) + 1)
                y0, y1 = max(0, int(self.pt(y - th * 2 - 6))), min(self.H, int(self.pt(y + th * 2 + 6)) + 1)
                if x0 >= x1:
                    continue
                xs = self.X[y0:y1, x0:x1] / self.s
                ys = self.Y[y0:y1, x0:x1] / self.s
                q = np.clip(np.abs(xs - x) / L, 0, 1)
                # Tapered half thickness, a little uneven along the band, flatter on top.
                half = th * (1 - q**2) ** 0.8 * (0.85 + 0.15 * n.f1(xs / 50.0 + dx))
                off = ys - y
                edge = np.where(off < 0, half * 0.8, half) - np.abs(off)
                cov = smoothstep(-1.2, 1.2, edge) * op
                lit = smoothstep(-0.3, 0.9, off / np.maximum(half, 0.5))
                prev = a_all[y0:y1, x0:x1]
                lit_all[y0:y1, x0:x1] = np.where(cov > prev, lit, lit_all[y0:y1, x0:x1])
                a_all[y0:y1, x0:x1] = 1 - (1 - prev) * (1 - cov)
        self.cloud_a = a_all
        self.cloud_lit = lit_all

    def _water(self):
        """Precomputed reflection lookup: rows shift a little, more so near the viewer."""
        n = self.noise
        Y, X = self.Y, self.X
        d = np.clip((Y - self.y0) / (self.H - self.y0), 0, 1)  # 0 at shore, 1 at bottom
        yp = Y[:, :1] / self.s
        rowband = 0.75 * n.f1(yp / 5.0 + 300, 3) + 0.25 * n.f1(yp / 1.6 + 500, 2)  # per-row shift
        dx = self.pt(0.25 + 4.5 * d[:, :1] ** 1.5) * rowband
        sy = 2 * self.y0 - Y
        sx = X + dx
        self.water_mask = smoothstep(self.y0 - 0.5, self.y0 + 0.5, Y)
        self.src_y = np.clip(sy, 0, self.H - 1).astype(np.int32)
        sx = np.clip(sx, 0, self.W - 1.001)
        self.src_x = np.floor(sx).astype(np.int32)
        self.src_fx = (sx - self.src_x)[..., None].astype(np.float32)
        self.water_d = d
        # Long, faint sheen lines across the water.
        self.sheen = n.f2(X / self.s / 320.0, Y / self.s / 3.0 + 40, 3)
        # Dashes for the glitter path.
        g = n.f2(X / self.s / 9.0, Y / self.s / 1.1 + 900, 2)
        self.glint = smoothstep(0.18, 0.55, g)
        # Gentle valley haze texture.
        self.haze_tex = 0.75 + 0.25 * n.f1(X / self.s / 90.0 + 77, 4)

    # ---------- per frame ----------

    def render(self, f: dict) -> np.ndarray:
        W, H, s = self.W, self.H, self.s
        X, Y = self.X, self.Y
        Xp, Yp = X / s, Y / s
        hor = SHORE * REF_H

        # Sky: three stops from the zenith to the horizon.
        top, mid, low = (rgb(c) for c in f["sky"])
        t = np.clip(Yp / hor, 0, 1)[..., None]
        m = f.get("sky_mid", 0.5)
        a = smoothstep(0, m, t)
        b = smoothstep(m, 1.0, t)
        img = top + (mid - top) * a
        img = img + (low - img) * b

        # A broad glow on the horizon, where the light comes from (or will).
        if f.get("glow"):
            gu, gcol, gstr, rx, ry = f["glow"]
            gx = gu * self.Wp
            g = np.exp(-(((Xp - gx) / rx) ** 2) - (((Yp - hor) / ry) ** 2)) * gstr
            over(img, rgb(gcol), g.astype(np.float32))

        # Stars.
        sa = f.get("stars", 0.0)
        if sa > 0:
            img = img * (1 - self.star_a[..., None] * sa) + self.star_rgb * sa

        # The sun.
        light_u = None
        if f.get("sun"):
            su, sy, scol, sa_, hcol, hstr, hrad = f["sun"]
            sx = su * self.Wp
            light_u = su
            dist = np.hypot(Xp - sx, Yp - sy)
            halo = np.exp(-((dist / hrad) ** 2)) * hstr + np.exp(-((dist / (hrad * 0.28)) ** 2)) * hstr * 0.6
            over(img, rgb(hcol), np.clip(halo, 0, 1).astype(np.float32))
            r_ = 21.0
            disc = np.clip((r_ - dist) * s + 0.5, 0, 1) * sa_
            over(img, rgb(scol), disc.astype(np.float32))

        # The moon: the Lilac Moon crescent.
        if f.get("moon"):
            mu, my, ma = f["moon"]
            mx = mu * self.Wp
            light_u = mu if light_u is None else light_u
            dist = np.hypot(Xp - mx, Yp - my)
            hr = 140.0
            halo = (1 - smoothstep(0, hr, dist)) ** 1.6 * 0.20 * ma
            over(img, rgb("#c4a7e7"), halo.astype(np.float32))
            R, r2, ox, oy = 52.0, 46.0, 25.0, -21.0
            disc = np.clip((R - dist) * s + 0.5, 0, 1)
            cut = np.clip((np.hypot(Xp - mx - ox, Yp - my - oy) - r2) * s + 0.5, 0, 1)
            # Gradient from lavender (upper left) to rose (lower right), as in the original.
            gd = ((Xp - (mx - 44)) * 90 + (Yp - (my - 54)) * 105) / (90**2 + 105**2)
            gcol = rgb("#c4a7e7") + (rgb("#ea9a97") - rgb("#c4a7e7")) * np.clip(gd, 0, 1)[..., None]
            over(img, gcol, (disc * cut * ma).astype(np.float32))

        # A single slow meteor, on one late night only.
        if f.get("meteor"):
            u0, y0, u1, y1 = f["meteor"]
            x0, x1 = u0 * self.Wp, u1 * self.Wp
            vx, vy = x1 - x0, y1 - y0
            L2 = vx * vx + vy * vy
            tt = np.clip(((Xp - x0) * vx + (Yp - y0) * vy) / L2, 0, 1)
            dd = np.hypot(Xp - (x0 + tt * vx), Yp - (y0 + tt * vy))
            line = np.clip(0.9 - dd * s * 0.55, 0, 1) * tt**2.2 * 0.75
            over(img, rgb("#e0def4"), line.astype(np.float32))

        # Clouds.
        if f.get("clouds"):
            shade, lit, ca, la = f["clouds"]
            ccol = rgb(shade) + (rgb(lit) - rgb(shade)) * (self.cloud_lit * la)[..., None]
            over(img, ccol, self.cloud_a * ca)

        # Far range, valley haze, near range, shoreline pines.
        haze_col, haze_a = f["haze"]
        back = rgb(f["far"]) + (rgb(f["sky"][2]) - rgb(f["far"])) * f.get("back_fade", 0.55)
        over(img, back, self.back_cov)
        hz0 = smoothstep(hor - 200, hor, Yp) ** 1.4 * haze_a * self.haze_tex
        over(img, rgb(haze_col), hz0 * self.back_cov)
        over(img, rgb(f["far"]), self.far_cov)
        hz = smoothstep(hor - 150, hor, Yp) ** 1.6 * haze_a * self.haze_tex
        over(img, rgb(haze_col), hz * self.far_cov)
        over(img, rgb(f["mid"]), self.mid_cov)
        hz2 = smoothstep(hor - 60, hor, Yp) ** 2 * haze_a * 0.6 * self.haze_tex
        over(img, rgb(haze_col), hz2 * self.mid_cov)
        over(img, rgb(f["shore"]), self.shore_cov)

        # One lit window on the far shore, after dark: someone else is up too.
        lamp = f.get("lamp", 0.0)
        if lamp > 0:
            lx, ly = LAMP[0] * self.Wp, hor - 3.2
            d = np.hypot(Xp - lx, (Yp - ly) * 1.3)
            glow = np.exp(-((d / 12.0) ** 2)) * 0.28 + np.clip(1.1 - d * s * 0.55, 0, 1) * 0.95
            over(img, rgb("#f6c177"), (glow * lamp).astype(np.float32))

        # Water: a mirror of the scene above, a little darker and tinted.
        refl = img[self.src_y, self.src_x] * (1 - self.src_fx) + img[self.src_y, self.src_x + 1] * self.src_fx
        wcol, wamt, wdark = f["water"]
        refl = refl * wdark
        refl = refl + (rgb(wcol) - refl) * (wamt * (0.6 + 0.4 * self.water_d))[..., None]
        refl = refl * (1 + f.get("sheen", 0.03) * self.sheen)[..., None]
        if f.get("glitter") and light_u is not None:
            gcol, gstr = f["glitter"]
            lx = light_u * self.Wp
            width = 6 + 46 * self.water_d**1.2
            col = np.exp(-(((Xp - lx) / width) ** 2))
            fade = 0.55 + 0.45 * smoothstep(0, 0.25, self.water_d)
            over(refl, rgb(gcol), (col * self.glint * gstr * fade).astype(np.float32))
        if lamp > 0:
            lx = LAMP[0] * self.Wp
            below = np.clip((Yp - hor) / 46.0, 0, 1)
            streak = np.exp(-(((Xp - lx) / (1.1 + 2.5 * below)) ** 2)) * (1 - below) ** 1.5 * self.glint
            over(refl, rgb("#f6c177"), (streak * 0.5 * lamp).astype(np.float32))
        wm = self.water_mask[..., None]
        img = img * (1 - wm) + refl * wm

        # Low mist lying on the water along the far shore.
        mcol, ma_ = f["mist"]
        mist = np.exp(-(((Yp - (hor + 2)) / 11.0) ** 2)) * ma_ * self.haze_tex
        over(img, rgb(mcol), mist.astype(np.float32))

        # Near banks and the framing pines.
        over(img, rgb(f["fg"]), self.fg_cov)

        # Dither to 8 bits so the long gradients stay smooth.
        rng = np.random.default_rng(5)
        dither = (rng.random(img.shape[:2], np.float32) - rng.random(img.shape[:2], np.float32))[..., None]
        out = np.clip(img * 255.0 + dither, 0, 255) + 0.5
        return out.astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=3024)
    ap.add_argument("--height", type=int, default=1964)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--only", type=str, default="")
    ap.add_argument("--ss", type=int, default=3)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    scene = Scene(args.width, args.height, args.ss)
    only = {int(i) for i in args.only.split(",") if i != ""}
    for i, f in enumerate(FRAMES):
        if only and i not in only:
            continue
        img = scene.render(f)
        path = args.out / f"{i:02d}-{f['time'].replace(':', '')}-{f['name'].lower().replace(' ', '-')}.png"
        Image.fromarray(img).save(path)
        print(path)


if __name__ == "__main__":
    main()
