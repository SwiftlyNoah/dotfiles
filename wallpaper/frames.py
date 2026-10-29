"""The day, frame by frame: light, color and sky for each time.

Each frame shows when the sun stands nearest solar=(altitude, azimuth), in degrees (azimuth
clockwise from north). macOS works out the sun's real position for this Mac's location
(or its time zone) and picks the frame to match, so the scene follows the actual sunrise
and sunset all year. Every position lies on the sun's path over Boston at an equinox:
macOS matches against that path, and positions the sun never reaches confuse it. The
twilight frames sit at set altitudes: First light at -12 degrees (nautical dawn), Dawn at
-4, Sunrise at 1, then Golden hour 6, Sunset 0.4, Blue hour -4 and Night -12 after dusk.
time is a summer clock time, kept for file names and the contact sheet.

Positions: u is a fraction of the width, y is in points on the 982-point-tall canvas.
  sky      zenith, middle, horizon colors (sky_mid moves the middle stop)
  glow     (u, color, strength, x radius, y radius): light on the horizon
  sun      (u, y, disc color, disc opacity, halo color, halo strength, halo radius)
  moon     (u, y, opacity)
  clouds   (shadow color, lit color, opacity, how much the lit underside shows)
  haze     (color, strength): air in the valleys between the ranges
  mist     (color, strength): a low band lying on the water
  water    (tint color, tint amount, brightness of the reflection)
  glitter  (color, strength): the light's path on the water
  lamp     opacity of one small warm window light on the far shore, after dark
  back_fade  how far the farthest range fades into the horizon sky (default 0.55)
"""

FRAMES = [
    dict(
        time="00:00", name="Midnight", solar=(-47.6, 0),
        sky=("#1d1b2d", "#211f34", "#33304c"), sky_mid=0.6,
        stars=1.0, moon=(0.80, 204, 1.0), lamp=1.0, back_fade=0.35,
        clouds=("#2a2840", "#3e3a5a", 0.6, 0.5),
        far="#2a2740", mid="#221f34", shore="#1b1929", fg="#151321",
        haze=("#36324f", 0.4), mist=("#433e5e", 0.16),
        water=("#221f35", 0.2, 0.95), glitter=("#c4a7e7", 0.6),
    ),
    dict(
        time="03:00", name="Late night", solar=(-31.5, 56),
        sky=("#1b1a2b", "#1f1d31", "#2f2c47"), sky_mid=0.6,
        stars=1.0, moon=(0.88, 300, 1.0), meteor=(0.10, 150, 0.17, 205), lamp=0.8, back_fade=0.35,
        clouds=("#28263d", "#3a3654", 0.55, 0.5),
        far="#28253d", mid="#201e32", shore="#1a1827", fg="#141220",
        haze=("#332f4b", 0.4), mist=("#433e5e", 0.2),
        water=("#201e33", 0.2, 0.95), glitter=("#c4a7e7", 0.5),
    ),
    dict(
        time="05:00", name="First light", solar=(-12.1, 78.8),
        sky=("#1f1d32", "#2b2843", "#4d3f5f"), sky_mid=0.5,
        glow=(0.16, "#7a5876", 0.55, 520, 150),
        stars=0.55, moon=(0.93, 420, 0.75), lamp=0.6,
        clouds=("#322d48", "#6e5470", 0.65, 0.8),
        far="#2f2b46", mid="#26233a", shore="#1d1b2d", fg="#171523",
        haze=("#4d3f5f", 0.35), mist=("#6e6a86", 0.18),
        water=("#2a2741", 0.25, 0.9), glitter=("#c4a7e7", 0.25),
    ),
    dict(
        time="06:00", name="Dawn", solar=(-4.1, 86.3),
        sky=("#3a3556", "#6e5b82", "#e8ad9f"), sky_mid=0.55,
        glow=(0.17, "#f6c177", 0.5, 480, 120),
        stars=0.12,
        clouds=("#4f4469", "#f2b4a0", 0.8, 0.9),
        far="#7b6789", mid="#5b4b6e", shore="#3a3150", fg="#2a2440",
        haze=("#e6b5ad", 0.4), mist=("#f0d0c8", 0.35),
        water=("#6e5b82", 0.2, 0.92), glitter=("#f6c177", 0.0),
    ),
    dict(
        time="07:00", name="Sunrise", solar=(0.9, 90.9),
        sky=("#978dba", "#cbb6cb", "#f7d8bf"), sky_mid=0.55,
        glow=(0.16, "#f6c177", 0.55, 520, 140),
        sun=(0.15, 700, "#fff3df", 1.0, "#f6c177", 0.55, 230),
        clouds=("#ab9ec6", "#fde0b8", 0.8, 0.9),
        far="#a693b5", mid="#8a79a0", shore="#5f5480", fg="#3f3a5c",
        haze=("#f7dcc8", 0.4), mist=("#fbe8dc", 0.45),
        water=("#c8b3c8", 0.2, 0.93), glitter=("#fde3bf", 0.6),
    ),
    dict(
        time="09:00", name="Morning", solar=(31.5, 124),
        sky=("#bab8dc", "#e0d9ea", "#f6eee7"), sky_mid=0.5,
        sun=(0.26, 300, "#fffaf3", 0.9, "#fbe8d0", 0.45, 260),
        clouds=("#ece6f0", "#fffaf3", 0.75, 0.8),
        far="#c2b6d2", mid="#a193b8", shore="#72688f", fg="#575279",
        haze=("#f2e9e1", 0.4), mist=("#faf4ed", 0.3),
        water=("#b9c8d6", 0.2, 0.95), glitter=("#fffaf3", 0.45),
    ),
    dict(
        time="12:00", name="Midday", solar=(47.6, 180),
        sky=("#b8c0e0", "#dfdfec", "#f7f1ea"), sky_mid=0.5,
        sun=(0.50, 105, "#fffaf3", 0.85, "#fffaf3", 0.45, 240),
        clouds=("#eef0f5", "#fffaf3", 0.75, 0.7),
        far="#bdb9d3", mid="#9c98bb", shore="#666e8f", fg="#4f5378",
        haze=("#f2eeea", 0.35), mist=("#faf4ed", 0.2),
        water=("#b4c6d6", 0.2, 0.95), glitter=("#fffaf3", 0.4),
    ),
    dict(
        time="15:30", name="Afternoon", solar=(31.5, 236),
        sky=("#bcb7da", "#e2d8e4", "#f7eadc"), sky_mid=0.5,
        sun=(0.72, 250, "#fffaf3", 0.9, "#fbe6c8", 0.45, 250),
        clouds=("#efe8ef", "#fff3e3", 0.75, 0.8),
        far="#c4b4cf", mid="#a393b6", shore="#706489", fg="#544e74",
        haze=("#f4e8dc", 0.4), mist=("#faf4ed", 0.2),
        water=("#b6c3d4", 0.2, 0.95), glitter=("#fff3e3", 0.45),
    ),
    dict(
        time="17:45", name="Golden hour", solar=(6, 264.5),
        sky=("#a59ac4", "#dab7c2", "#f7c99e"), sky_mid=0.55,
        glow=(0.82, "#f6c177", 0.55, 520, 150),
        sun=(0.82, 520, "#fff0d6", 1.0, "#f6c177", 0.6, 250),
        clouds=("#c3a2c0", "#fbd59a", 0.8, 0.95),
        far="#ad89a6", mid="#8a6d92", shore="#5a4870", fg="#3b3152",
        haze=("#f4c7a6", 0.4), mist=("#f8d9bc", 0.3),
        water=("#c8a2b4", 0.2, 0.93), glitter=("#f8d39a", 0.65),
    ),
    dict(
        time="19:15", name="Sunset", solar=(0.4, 269.6),
        sky=("#433c69", "#94698d", "#ec9283"), sky_mid=0.58,
        glow=(0.81, "#eb6f92", 0.5, 520, 130),
        sun=(0.81, 712, "#fbd2a8", 1.0, "#f29a7f", 0.5, 220),
        clouds=("#5a4878", "#f6a08a", 0.85, 0.95),
        far="#6e4f78", mid="#4e3d63", shore="#33294a", fg="#231f36",
        haze=("#d98a86", 0.35), mist=("#e6a19a", 0.25),
        water=("#5e4a72", 0.2, 0.9), glitter=("#f6b38c", 0.6),
    ),
    dict(
        time="20:15", name="Blue hour", solar=(-4, 273.7),
        sky=("#211f38", "#2d3152", "#55486c"), sky_mid=0.55,
        glow=(0.84, "#8a5a78", 0.45, 520, 120),
        stars=0.5, moon=(0.73, 300, 0.95), lamp=1.0,
        clouds=("#34344f", "#6a5272", 0.65, 0.8),
        far="#302c49", mid="#26233c", shore="#1d1b2e", fg="#161523",
        haze=("#4a4268", 0.35), mist=("#4c4a70", 0.18),
        water=("#262a46", 0.25, 0.9), glitter=("#c4a7e7", 0.4),
    ),
    dict(
        time="21:30", name="Night", solar=(-12, 281.2),
        sky=("#1e1c2f", "#222036", "#34304d"), sky_mid=0.6,
        stars=0.9, moon=(0.76, 250, 1.0), lamp=1.0, back_fade=0.35,
        clouds=("#2a2840", "#3e3a5a", 0.6, 0.5),
        far="#2b2841", mid="#231f35", shore="#1b1929", fg="#151321",
        haze=("#37334f", 0.4), mist=("#433e5e", 0.16),
        water=("#221f35", 0.2, 0.95), glitter=("#c4a7e7", 0.55),
    ),
]
