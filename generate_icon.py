#!/usr/bin/env python3
"""Generate SnapCraft app icon - camera shutter + crop marks design."""

from PIL import Image, ImageDraw
import math, os

OUT = "/Users/liwenchao/BiosPherePro/snap-craft/icons"
os.makedirs(OUT, exist_ok=True)

# Colors
BG        = (26, 26, 46)       # #1a1a2e
BG_ROUND = (35, 35, 58)      # slightly lighter for depth
ACCENT    = (0, 122, 255)      # #007AFF
ACCENT2  = (88, 86, 214)     # #5856D6  (purple complement)
WHITE     = (245, 245, 247)
GLOW      = (0, 122, 255, 60) # soft glow

def draw_icon(size):
    """Draw the SnapCraft icon at given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d   = ImageDraw.Draw(img)

    pad   = int(size * 0.12)
    cx, cy = size // 2, size // 2
    r     = (size - 2 * pad) // 2

    # --- rounded square background ---
    d.rounded_rectangle(
        [pad, pad, size-pad, size-pad],
        radius=int(size * 0.22),
        fill=BG
    )

    # --- subtle inner glow ring ---
    glow_r = r - int(size * 0.03)
    d.rounded_rectangle(
        [size//2 - glow_r, size//2 - glow_r, size//2 + glow_r, size//2 + glow_r],
        radius=int(size * 0.18),
        outline=ACCENT,
        width=max(1, int(size * 0.008))
    )

    # --- camera shutter blades (6 blades, partial arc) ---
    shutter_r   = int(r * 0.42)
    blade_count = 6
    for i in range(blade_count):
        angle_deg = i * (360 / blade_count) - 90
        angle_rad = math.radians(angle_deg)
        # each blade is a small triangle-ish shape
        # draw as a line from center going outward, then arc
        x1 = cx + int(math.cos(angle_rad) * shutter_r * 0.3)
        y1 = cy + int(math.sin(angle_rad) * shutter_r * 0.3)
        x2 = cx + int(math.cos(angle_rad) * shutter_r)
        y2 = cy + int(math.sin(angle_rad) * shutter_r)
        lw = max(1, int(size * 0.025))
        d.line([(cx, cy), (x2, y2)], fill=ACCENT, width=lw)

    # --- shutter aperture circle (center) ---
    apt_r = int(shutter_r * 0.28)
    d.ellipse(
        [cx-apt_r, cy-apt_r, cx+apt_r, cy+apt_r],
        outline=ACCENT,
        width=max(1, int(size * 0.02))
    )
    # filled small center dot
    dot_r = max(1, int(size * 0.035))
    d.ellipse(
        [cx-dot_r, cy-dot_r, cx+dot_r, cy+dot_r],
        fill=ACCENT
    )

    # --- crop-corner marks (4 corners inside the rounded rect) ---
    cm = int(size * 0.04)   # corner mark length
    ct = max(1, int(size * 0.018))  # thickness
    # margin from edge of icon rounded rect
    m = pad + int(size * 0.10)

    # top-left
    d.line([(m, m+cm), (m, m), (m+cm, m)], fill=WHITE, width=ct)
    # top-right
    d.line([(size-m-cm, m), (size-m, m), (size-m, m+cm)], fill=WHITE, width=ct)
    # bottom-left
    d.line([(m, size-m-cm), (m, size-m), (m+cm, size-m)], fill=WHITE, width=ct)
    # bottom-right
    d.line([(size-m-cm, size-m), (size-m, size-m), (size-m, size-m-cm)], fill=WHITE, width=ct)

    # --- crosshair lines (center, subtle) ---
    ch_len = int(shutter_r * 0.7)
    ch_t   = max(1, int(size * 0.01))
    # horizontal
    d.line([(cx - ch_len, cy), (cx + ch_len, cy)], fill=(*ACCENT2, 180), width=ch_t)
    # vertical
    d.line([(cx, cy - ch_len), (cx, cy + ch_len)], fill=(*ACCENT2, 180), width=ch_t)

    return img

# --- Generate all required sizes ---
sizes = {
    "icon.png":       1024,   # master
    "32x32.png":      32,
    "128x128.png":    128,
    "128x128@2x.png": 256,   # 2x version = 256px
    "512x512.png":    512,
}

for name, sz in sizes.items():
    icon = draw_icon(sz)
    path = os.path.join(OUT, name)
    icon.save(path, "PNG")
    print(f"  ✓  {path}  ({sz}x{sz})")

# Also save the master as logo for UI use
master = draw_icon(1024)
master.save(os.path.join(OUT, "../public/logo-1024.png"), "PNG")
print(f"  ✓  public/logo-1024.png")

# Generate .icns for macOS (Tauri needs this)
# Create iconset directory
iconset = os.path.join(OUT, "..", "icons.iconset")
os.makedirs(iconset, exist_ok=True)

icon_sizes = [16, 32, 64, 128, 256, 512, 1024]
for sz in icon_sizes:
    icon = draw_icon(sz)
    icon.save(os.path.join(iconset, f"icon_{sz}x{sz}.png"), "PNG")
    if sz <= 512:
        icon2 = draw_icon(sz * 2)
        icon2.save(os.path.join(iconset, f"icon_{sz}x{sz}@2x.png"), "PNG")

print(f"  ✓  iconset generated ({len(icon_sizes)} files)")

# Try to build .icns (requires macOS iconutil)
import subprocess
try:
    result = subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "icon.icns")],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"  ✓  icon.icns generated")
    else:
        print(f"  ⚠️  iconutil failed: {result.stderr.strip()}")
        # fallback: just copy the 1024 master as icon.png
        import shutil
        shutil.copy(os.path.join(OUT, "icon.png"), os.path.join(OUT, "icon.icns"))
        print(f"  ⚠️  Using PNG fallback for icon.icns")
except FileNotFoundError:
    print(f"  ⚠️  iconutil not found (not on macOS?), skipping .icns")

# Generate .ico for Windows
try:
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_imgs = [draw_icon(s) for s in ico_sizes]
    ico_imgs[0].save(
        os.path.join(OUT, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in ico_sizes]
    )
    print(f"  ✓  icon.ico generated")
except Exception as e:
    print(f"  ⚠️  ICO generation failed: {e}")

print("\nDone! All icons generated in:", OUT)
