#!/usr/bin/env python3
"""Regenerate public/favicon.svg — the dranker "d" lettermark.

Lowercase Georgia Bold "d" in the wordmark's bronze (#B08040) on a dark
rounded square (#17100A), matching the leading letter of the header lockup.

The glyph is emitted as an outlined <path> rather than as <text>: an SVG
favicon using <text> renders in whatever font the *viewer* has installed, so
on a machine without Georgia the mark would silently change shape. Outlining
pins it, and keeps the file under 1 KB.

Usage:
    pip install fonttools
    python3 scripts/make_favicon.py

Then re-verify legibility at the sizes browsers actually paint (16px and
32px) before committing — the bowl counter is the first thing to close up if
TARGET_H or the font changes.

Requires Georgia Bold, which ships with macOS at the path below. On another
platform, point FONT at a local copy.
"""
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

FONT = Path("/System/Library/Fonts/Supplemental/Georgia Bold.ttf")
OUT = Path(__file__).resolve().parent.parent / "public" / "favicon.svg"

CHAR = "d"
BOX = 64.0          # viewBox is 0 0 64 64
TARGET_H = 42.0     # glyph height in the box (~66% — keeps the counter open at 16px)
RADIUS = 12.0       # corner radius, i.e. 3px once painted at 16px
FG = "#B08040"      # wordmark bronze
BG = "#17100A"      # page background


def main() -> int:
    if not FONT.exists():
        sys.exit(f"font not found: {FONT}\nInstall Georgia Bold or repoint FONT.")

    font = TTFont(FONT)
    glyphset = font.getGlyphSet()
    name = font.getBestCmap()[ord(CHAR)]

    pen = SVGPathPen(glyphset)
    glyphset[name].draw(pen)
    path = pen.getCommands()

    bounds = BoundsPen(glyphset)
    glyphset[name].draw(bounds)
    xmin, ymin, xmax, ymax = bounds.bounds
    gw, gh = xmax - xmin, ymax - ymin

    # Font units are y-up, SVG is y-down. Scale to TARGET_H, flip vertically,
    # and centre the glyph's own ink box (not its advance width) in the square.
    scale = TARGET_H / gh
    tx = (BOX - gw * scale) / 2 - xmin * scale
    ty = (BOX + gh * scale) / 2 + ymin * scale  # +ymin: the flip negates it

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOX:.0f} {BOX:.0f}"'
        f' width="{BOX:.0f}" height="{BOX:.0f}">\n'
        f'  <rect width="{BOX:.0f}" height="{BOX:.0f}" rx="{RADIUS:.0f}" fill="{BG}"/>\n'
        f'  <path transform="translate({tx:.3f} {ty:.3f})'
        f' scale({scale:.6f} {-scale:.6f})" fill="{FG}" d="{path}"/>\n'
        f"</svg>\n"
    )

    OUT.write_text(svg)
    print(f"wrote {OUT} ({len(svg)} bytes)")
    print(f"  glyph {CHAR!r} -> {name}, drawn {gw * scale:.1f} x {gh * scale:.1f} in a {BOX:.0f} box")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
