#!/usr/bin/env python3
"""Generate the Capacitor native-asset SOURCES in `assets/`.

Why this exists
---------------
The Codemagic build runs `npx @capacitor/assets generate --android`, which reads
its source images from `assets/` in the repo root. Those files were never
committed, so the command failed on every build and the Android app shipped with
Capacitor's DEFAULT blue launcher icon. Google Play rejected the app for it
(Misleading Claims -> "App store listing mismatch": installed icon differs from
the store listing). These generated files are the fix, and they are committed so
the cloud build always has them.

Everything here is DERIVED from artwork the project already ships, so the
launcher icon is pixel-for-pixel the same mark as the Play Store listing icon
(`play-store-assets/app-icon-512.png`, byte-identical to `icons/icon-512.png`):

  assets/icon-only.png        <- icons/icon-512.png            (legacy square icon)
  assets/icon-foreground.png  <- icons/icon-maskable-512.png   (adaptive fg, safe-zone art)
  assets/icon-background.png  <- flat brand brown               (adaptive bg)
  assets/splash.png           <- the boot-screen receipt mark on parchment
  assets/splash-dark.png      <- the same mark in the app's dark-theme colours

Run from the `resit/` folder:  python tools/make-native-assets.py
Only re-run it when the brand icons or the boot mark change.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
OUT = ROOT / "assets"

# Brand colours, sampled from icons/icon-512.png and styles.css.
BROWN = (0x4A, 0x2E, 0x1B)  # icon background
PARCHMENT = (0xF4, 0xED, 0xDE)  # --paper
PAPER_RAISED = (0xFC, 0xF8, 0xEE)  # --paper-raised
INK = (0x2C, 0x23, 0x18)  # --ink
TERRACOTTA = (0xB4, 0x57, 0x2F)  # --terracotta
DARK_PAPER = (0x22, 0x1B, 0x12)  # --paper       (dark theme)
DARK_PAPER_RAISED = (0x2C, 0x24, 0x18)  # --paper-raised (dark theme)
DARK_INK = (0xF0, 0xE6, 0xD2)  # --ink          (dark theme)
DARK_TERRACOTTA = (0xC9, 0x71, 0x4A)  # --terracotta   (dark theme)

ICON_PX = 1024  # @capacitor/assets minimum for icon sources
SPLASH_PX = 2732  # @capacitor/assets minimum for splash sources

# The boot-screen receipt mark, transcribed from the <svg> in index.html so the
# splash hands off seamlessly to the app's own startup animation. Coordinates
# are that SVG's viewBox units.
MARK_OUTLINE = [
    (31, 19), (65, 19), (65, 64), (59.3, 70), (53.7, 64),
    (48, 70), (42.4, 64), (36.7, 70), (31, 64),
]
MARK_STROKE = 3.4
MARK_LINES = [  # (x1, y1, x2, y2, width, "ink" | "terracotta")
    (39, 31, 57, 31, 2.6, "ink"),
    (39, 39, 57, 39, 2.6, "ink"),
    (39, 47, 50, 47, 2.6, "ink"),
    (39, 55, 53, 55, 3.0, "terracotta"),
]


def render_mark(height_px, paper, ink, terracotta, ss=4):
    """Draw the receipt mark at `height_px` tall on a transparent tile.

    Pillow has no antialiasing, so everything is drawn at `ss`x and scaled back
    down — the same trick the icons themselves were made with.
    """
    min_x, max_x = 31 - MARK_STROKE / 2, 65 + MARK_STROKE / 2
    min_y, max_y = 19 - MARK_STROKE / 2, 70 + MARK_STROKE / 2
    unit = height_px / (max_y - min_y)  # pixels per viewBox unit
    w = round((max_x - min_x) * unit)
    h = round(height_px)

    img = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def pt(x, y):
        return ((x - min_x) * unit * ss, (y - min_y) * unit * ss)

    outline = [pt(x, y) for x, y in MARK_OUTLINE]
    draw.polygon(outline, fill=paper)
    # Closing with the first TWO points makes the top-left corner a real joint
    # (rounded, like the SVG's stroke-linejoin) instead of a butt-capped end.
    draw.line(
        outline + [outline[0], outline[1]],
        fill=ink,
        width=max(1, round(MARK_STROKE * unit * ss)),
        joint="curve",
    )

    for x1, y1, x2, y2, width, colour in MARK_LINES:
        fill = ink if colour == "ink" else terracotta
        px_w = max(1, round(width * unit * ss))
        draw.line([pt(x1, y1), pt(x2, y2)], fill=fill, width=px_w)
        for x, y in ((x1, y1), (x2, y2)):  # emulate stroke-linecap="round"
            cx, cy = pt(x, y)
            r = px_w / 2
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    return img.resize((w, h), Image.LANCZOS)


def make_splash(path, background, paper, ink, terracotta):
    canvas = Image.new("RGB", (SPLASH_PX, SPLASH_PX), background)
    mark = render_mark(round(SPLASH_PX * 0.30), paper, ink, terracotta)
    canvas.paste(
        mark,
        ((SPLASH_PX - mark.width) // 2, (SPLASH_PX - mark.height) // 2),
        mark,
    )
    canvas.save(path)
    print(f"  {path.name}  {canvas.size[0]}x{canvas.size[1]}")


def make_foreground(path):
    """Adaptive-icon foreground: the maskable mark, background knocked out.

    Flood-filling inwards from the corners only clears the CONTIGUOUS outer
    background, so the dark text lines printed on the cream receipt survive
    (a plain colour-key would punch holes through them).
    """
    src = Image.open(ICONS / "icon-maskable-512.png").convert("RGB")
    src = src.resize((ICON_PX, ICON_PX), Image.LANCZOS)

    key = (255, 0, 255)  # sentinel; nothing in the artwork is magenta
    for corner in ((0, 0), (ICON_PX - 1, 0), (0, ICON_PX - 1), (ICON_PX - 1, ICON_PX - 1)):
        # thresh clears most of the antialiased edge ramp without reaching the
        # sienna printer bar; any residue is the same brown as the background
        # layer sitting behind it, so it cannot show.
        ImageDraw.floodfill(src, corner, key, thresh=40)

    # Exact match on the sentinel -> alpha 0, everything else stays opaque.
    bands = ImageChops.difference(src, Image.new("RGB", src.size, key)).split()
    delta = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), bands[2])
    out = src.convert("RGBA")
    out.putalpha(delta.point(lambda v: 0 if v == 0 else 255))
    out.save(path)
    print(f"  {path.name}  {out.size[0]}x{out.size[1]}  (transparent background)")


def main():
    OUT.mkdir(exist_ok=True)
    print(f"Writing native-asset sources to {OUT}")

    icon = Image.open(ICONS / "icon-512.png").convert("RGB")
    icon.resize((ICON_PX, ICON_PX), Image.LANCZOS).save(OUT / "icon-only.png")
    print(f"  icon-only.png  {ICON_PX}x{ICON_PX}")

    Image.new("RGB", (ICON_PX, ICON_PX), BROWN).save(OUT / "icon-background.png")
    print(f"  icon-background.png  {ICON_PX}x{ICON_PX}")

    make_foreground(OUT / "icon-foreground.png")

    make_splash(OUT / "splash.png", PARCHMENT, PAPER_RAISED, INK, TERRACOTTA)
    make_splash(
        OUT / "splash-dark.png",
        DARK_PAPER,
        DARK_PAPER_RAISED,
        DARK_INK,
        DARK_TERRACOTTA,
    )

    print("Done. Commit assets/ — the Codemagic build reads these.")


if __name__ == "__main__":
    main()
