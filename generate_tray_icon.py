#!/usr/bin/env python3
"""Generate SnapCraft macOS menu-bar (tray) TEMPLATE icon.

Design goal: a true macOS template image = solid black pigment on transparent
background. macOS tints it by alpha (white in dark mode, dark in light mode).
Internal detail is expressed as TRANSPARENT CUT-OUTS (negative space) so the
lines stay visible at ~22pt instead of merging into a white blob.

Brand: camera aperture (ring + 6 blade slits) framed by 4 crop-corner brackets.
"""

from PIL import Image, ImageDraw

SRC = "/Users/liwenchao/GithubProSpace/snap-craft/src-tauri/icons"
TMP = "/tmp/snapcraft_tray_preview"
import os
os.makedirs(TMP, exist_ok=True)

S = 1024
C = S // 2  # center 512

# ---- aperture (hero) ----
R_OUT = 240          # outer disk radius
RH = 95             # center aperture hole radius
SLIT_HALF = 11      # slit half-angle (deg) -> 22deg transparent blade gaps
BLADES = 6

# ---- crop corner brackets ----
MARGIN = 60         # distance from canvas edge
L = 200             # bracket arm length
T = 100             # bracket thickness

def build_mask():
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)

    # outer disk (white = pigment)
    d.ellipse([C - R_OUT, C - R_OUT, C + R_OUT, C + R_OUT], fill=255)
    # center hole (black = transparent)
    d.ellipse([C - RH, C - RH, C + RH, C + RH], fill=0)
    # blade slits (transparent radial gaps = the visible internal lines)
    for i in range(BLADES):
        a = i * (360 // BLADES)
        d.pieslice([C - R_OUT, C - R_OUT, C + R_OUT, C + R_OUT],
                   a - SLIT_HALF, a + SLIT_HALF, fill=0)

    # 4 crop-corner brackets (white = pigment)
    corners = [
        # (hx0,hy0,hx1,hy1, vx0,vy0,vx1,vy1)  top-left
        (MARGIN, MARGIN, MARGIN + L, MARGIN + T,  MARGIN, MARGIN, MARGIN + T, MARGIN + L),
        # top-right
        (S - MARGIN - L, MARGIN, S - MARGIN, MARGIN + T,  S - MARGIN - T, MARGIN, S - MARGIN, MARGIN + L),
        # bottom-left
        (MARGIN, S - MARGIN - T, MARGIN + L, S - MARGIN,  MARGIN, S - MARGIN - L, MARGIN + T, S - MARGIN),
        # bottom-right
        (S - MARGIN - L, S - MARGIN - T, S - MARGIN, S - MARGIN,  S - MARGIN - T, S - MARGIN - L, S - MARGIN, S - MARGIN),
    ]
    for hx0, hy0, hx1, hy1, vx0, vy0, vx1, vy1 in corners:
        d.rectangle([hx0, hy0, hx1, hy1], fill=255)
        d.rectangle([vx0, vy0, vx1, vy1], fill=255)

    return mask

def template_rgba(mask):
    """Solid black pigment, alpha = mask."""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.putalpha(mask)
    return img

def simulate(mask, shape_rgb, bg_rgb, scale):
    """Simulate macOS template tinting: shape_rgb on bg_rgb, then downscale."""
    bg = Image.new("RGBA", (S, S), (*bg_rgb, 255))
    shape = Image.new("RGBA", (S, S), (*shape_rgb, 255))
    shape.putalpha(mask)
    out = Image.new("RGBA", (S, S), (*bg_rgb, 255))
    out.alpha_composite(shape)
    return out.resize((scale, scale), Image.LANCZOS)

def main():
    mask = build_mask()

    # 1) the real template icon (black on transparent) -> embedded into binary
    tpl = template_rgba(mask)
    tpl.save(f"{SRC}/tray-icon.png", "PNG")
    print(f"  ✓  {SRC}/tray-icon.png  (template, black-on-transparent)")

    # 2) previews for visual verification (dark + light menubar simulation @44px = 22pt@2x)
    dark = simulate(mask, (255, 255, 255), (30, 30, 32), 44)
    dark.save(f"{TMP}/tray-dark-44.png", "PNG")
    light = simulate(mask, (20, 20, 22), (242, 242, 247), 44)
    light.save(f"{TMP}/tray-light-44.png", "PNG")

    # 3) full-size dark preview so the design shape is inspectable
    big = simulate(mask, (235, 235, 240), (28, 28, 30), S)
    big.save(f"{TMP}/tray-design.png", "PNG")

    print(f"  ✓  previews -> {TMP}/tray-dark-44.png, tray-light-44.png, tray-design.png")

if __name__ == "__main__":
    main()
