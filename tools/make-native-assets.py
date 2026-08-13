#!/usr/bin/env python3
"""Generate the Android launcher-icon + splash resources in `android-res/`.

Why this exists
---------------
The Codemagic build used to call `npx @capacitor/assets generate --android` to
produce these files. Two things went wrong with that:

1. It reads its sources from an `assets/` folder that was never committed, and
   the step ended in `|| echo "skipped icon generation"` — so it failed on every
   build, silently, and the app shipped Capacitor's DEFAULT blue launcher icon.
   Google Play rejected it (Misleading Claims -> "App store listing mismatch").
2. `@capacitor/assets` depends on `sharp` 0.32.6, which compiles native code at
   install time. On 13 Aug 2026 that download flaked on Codemagic's macOS
   builder and `npm install` itself died, so the build never even reached the
   icon step.

So the resizing now happens HERE, on a machine where the result can actually be
looked at, and the committed output is copied straight into the generated
Android project. No image library in CI, nothing to download, nothing to compile
— and `@capacitor/assets` is gone from package.json entirely.

Everything is derived from the icons the project already ships, so the launcher
icon is the same mark as the Play Store listing icon (`icons/icon-512.png` is
byte-identical to `play-store-assets/app-icon-512.png`):

  icons/icon-512.png           -> mipmap-*/ic_launcher.png        (legacy square)
                               -> mipmap-*/ic_launcher_round.png  (legacy round)
  icons/icon-maskable-512.png  -> mipmap-*/ic_launcher_foreground.png (adaptive)
  brand brown                  -> values/ic_launcher_background.xml  (adaptive bg)
  brand parchment              -> drawable*/splash.png

Sizes and file layout mirror Capacitor 8.5.0's android-template exactly (they
were read off the template's own files, not guessed).

The splash is deliberately a FLAT parchment fill: Android stretches
`@drawable/splash` to fill the window, which would visibly distort a centred
logo, and the app draws its own receipt mark in HTML the moment it loads. A
plain parchment window hands off to that boot animation seamlessly.

Run from the `resit/` folder:  python tools/make-native-assets.py
Re-run it whenever `icons/` changes, and commit `android-res/`.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
OUT = ROOT / "android-res"

# Brand colours, sampled from icons/icon-512.png and styles.css.
BROWN = "#4A2E1B"  # icon background -> adaptive-icon background colour
PARCHMENT = (0xF4, 0xED, 0xDE)  # --paper -> splash window background

# (ic_launcher / ic_launcher_round px, ic_launcher_foreground px) per density.
# The foreground is the 108dp adaptive canvas, hence the larger number.
MIPMAP = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

# Every splash slot the template ships, at the template's own dimensions.
SPLASH = {
    "drawable": (480, 320),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
}

LAUNCHER_BACKGROUND_XML = f"""<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">{BROWN}</color>
</resources>
"""


def square_icon():
    """The app icon exactly as the Play listing shows it."""
    return Image.open(ICONS / "icon-512.png").convert("RGB")


def round_icon(src):
    """Legacy round icon (API 25 and below ask for this one separately)."""
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    mask = Image.new("L", src.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, src.size[0] - 1, src.size[1] - 1], fill=255)
    out.paste(src, (0, 0), mask)
    return out


def adaptive_foreground():
    """Adaptive-icon foreground: the maskable mark, background knocked out.

    Flood-filling inwards from the corners only clears the CONTIGUOUS outer
    background, so the dark lines printed on the cream receipt survive (a plain
    colour-key would punch holes through them). Whatever antialiased fringe
    remains is the same brown as the background colour layer behind it, so it
    cannot show.
    """
    src = Image.open(ICONS / "icon-maskable-512.png").convert("RGB")
    key = (255, 0, 255)  # sentinel; nothing in the artwork is magenta
    w, h = src.size
    for corner in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(src, corner, key, thresh=40)

    bands = ImageChops.difference(src, Image.new("RGB", src.size, key)).split()
    delta = ImageChops.lighter(ImageChops.lighter(bands[0], bands[1]), bands[2])
    out = src.convert("RGBA")
    out.putalpha(delta.point(lambda v: 0 if v == 0 else 255))
    return out


def main():
    square = square_icon()
    rounded = round_icon(square)
    foreground = adaptive_foreground()

    print(f"Writing Android resources to {OUT}")
    written = 0

    for density, (icon_px, fg_px) in MIPMAP.items():
        folder = OUT / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        square.resize((icon_px, icon_px), Image.LANCZOS).save(folder / "ic_launcher.png")
        rounded.resize((icon_px, icon_px), Image.LANCZOS).save(folder / "ic_launcher_round.png")
        foreground.resize((fg_px, fg_px), Image.LANCZOS).save(folder / "ic_launcher_foreground.png")
        written += 3
        print(f"  mipmap-{density:<8} icon {icon_px}px, foreground {fg_px}px")

    values = OUT / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(LAUNCHER_BACKGROUND_XML, encoding="utf-8")
    written += 1
    print(f"  values/ic_launcher_background.xml  {BROWN}")

    for folder_name, size in SPLASH.items():
        folder = OUT / folder_name
        folder.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", size, PARCHMENT).save(folder / "splash.png")
        written += 1
    print(f"  {len(SPLASH)} x splash.png  (flat parchment, {PARCHMENT})")

    print(f"Done — {written} files. Commit android-res/; the Codemagic build copies it in.")


if __name__ == "__main__":
    main()
