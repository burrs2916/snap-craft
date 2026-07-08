#!/usr/bin/env python3
"""生成所有尺寸的 SnapCraft 图标并替换项目中的所有图标文件"""

from PIL import Image, ImageDraw
import os
import shutil

# 项目根目录
PROJECT_ROOT = "/Users/liwenchao/BiosPherePro/snap-craft"
PUBLIC_DIR = os.path.join(PROJECT_ROOT, "public")
ICONS_DIR = os.path.join(PROJECT_ROOT, "icons")
TAURI_ICONS_DIR = os.path.join(PROJECT_ROOT, "src-tauri", "icons")

def create_icon(size, bg_color, accent_color, save_path):
    """创建 SnapCraft 图标"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 背景圆角矩形
    margin = int(size * 0.05)
    radius = int(size * 0.2)
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=radius,
        fill=bg_color
    )
    
    # 相机快门 - 外圆
    cx, cy = size // 2, size // 2
    outer_r = int(size * 0.30)
    draw.ellipse(
        [cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r],
        outline=accent_color,
        width=max(int(size * 0.04), 2)
    )
    
    # 相机快门 - 内圆
    inner_r = int(size * 0.18)
    draw.ellipse(
        [cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r],
        outline=accent_color,
        width=max(int(size * 0.04), 2)
    )
    
    # 十字准星 - 水平线
    line_len = int(size * 0.38)
    line_width = max(int(size * 0.03), 2)
    draw.line([cx - line_len, cy, cx + line_len, cy], fill=accent_color, width=line_width)
    
    # 十字准星 - 垂直线
    draw.line([cx, cy - line_len, cx, cy + line_len], fill=accent_color, width=line_width)
    
    # 四个角标记（截图框选效果）
    corner_len = int(size * 0.12)
    corner_width = max(int(size * 0.05), 3)
    offset = int(size * 0.22)
    
    # 左上角
    draw.line([cx - offset, cy - offset, cx - offset + corner_len, cy - offset], fill=accent_color, width=corner_width)
    draw.line([cx - offset, cy - offset, cx - offset, cy - offset + corner_len], fill=accent_color, width=corner_width)
    
    # 右上角
    draw.line([cx + offset, cy - offset, cx + offset - corner_len, cy - offset], fill=accent_color, width=corner_width)
    draw.line([cx + offset, cy - offset, cx + offset, cy - offset + corner_len], fill=accent_color, width=corner_width)
    
    # 左下角
    draw.line([cx - offset, cy + offset, cx - offset + corner_len, cy + offset], fill=accent_color, width=corner_width)
    draw.line([cx - offset, cy + offset, cx - offset, cy + offset - corner_len], fill=accent_color, width=corner_width)
    
    # 右下角
    draw.line([cx + offset, cy + offset, cx + offset - corner_len, cy + offset], fill=accent_color, width=corner_width)
    draw.line([cx + offset, cy + offset, cx + offset, cy + offset - corner_len], fill=accent_color, width=corner_width)
    
    # 中心小点
    dot_r = max(int(size * 0.03), 3)
    draw.ellipse(
        [cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r],
        fill=accent_color
    )
    
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    img.save(save_path, 'PNG')
    print(f"  ✓ {save_path}")

def create_icns(png_path, icns_path):
    """从 PNG 创建 ICNS 文件（macOS）"""
    try:
        # 创建 iconset 目录
        iconset_dir = os.path.join(PROJECT_ROOT, "icons.iconset")
        os.makedirs(iconset_dir, exist_ok=True)
        
        # 生成所有必要尺寸
        sizes = [
            (16, "icon_16x16.png"),
            (32, "icon_16x16@2x.png"),
            (32, "icon_32x32.png"),
            (64, "icon_32x32@2x.png"),
            (128, "icon_128x128.png"),
            (256, "icon_128x128@2x.png"),
            (256, "icon_256x256.png"),
            (512, "icon_256x256@2x.png"),
            (512, "icon_512x512.png"),
            (1024, "icon_512x512@2x.png"),
            (1024, "icon_1024x1024.png"),
        ]
        
        img = Image.open(png_path)
        for size, name in sizes:
            resized = img.resize((size, size), Image.LANCZOS)
            resized.save(os.path.join(iconset_dir, name))
        
        # 使用 iconutil 创建 icns
        os.system(f'iconutil -c icns "{iconset_dir}" -o "{icns_path}"')
        print(f"  ✓ {icns_path}")
        return True
    except Exception as e:
        print(f"  ✗ ICNS 创建失败: {e}")
        return False

def create_ico(png_path, ico_path):
    """从 PNG 创建 ICO 文件（Windows）"""
    try:
        img = Image.open(png_path)
        sizes = [16, 32, 48, 64, 128, 256]
        imgs = []
        for s in sizes:
            imgs.append(img.resize((s, s), Image.LANCZOS))
        imgs[0].save(ico_path, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[1:])
        print(f"  ✓ {ico_path}")
        return True
    except Exception as e:
        print(f"  ✗ ICO 创建失败: {e}")
        return False

def main():
    bg_color = (26, 26, 46, 255)       # #1a1a2e
    accent_color = (0, 122, 255, 255)  # #007AFF
    
    print("🎨 生成 SnapCraft 图标...")
    print(f"   背景色: #{bg_color[0]:02x}{bg_color[1]:02x}{bg_color[2]:02x}")
    print(f"   强调色: #{accent_color[0]:02x}{accent_color[1]:02x}{accent_color[2]:02x}")
    print()
    
    # 1. 生成主图标 (1024x1024)
    master_png = os.path.join(ICONS_DIR, "icon.png")
    create_icon(1024, bg_color, accent_color, master_png)
    
    # 2. 生成 public/ 目录的图标
    print("\n📁 替换 public/ 目录图标...")
    create_icon(1024, bg_color, accent_color, os.path.join(PUBLIC_DIR, "logo-1024.png"))
    create_icon(512, bg_color, accent_color, os.path.join(PUBLIC_DIR, "logo-512.png"))
    create_icon(192, bg_color, accent_color, os.path.join(PUBLIC_DIR, "logo-192.png"))
    create_icon(64, bg_color, accent_color, os.path.join(PUBLIC_DIR, "favicon.png"))
    
    # 3. 生成 icons/ 目录的各尺寸图标
    print("\n📁 生成 icons/ 目录各尺寸图标...")
    icon_sizes = [
        (32, "32x32.png"),
        (128, "128x128.png"),
        (256, "256x256.png"),
        (512, "512x512.png"),
        (1024, "1024x1024.png"),
    ]
    for size, fname in icon_sizes:
        create_icon(size, bg_color, accent_color, os.path.join(ICONS_DIR, fname))
    
    # 128x128@2x
    img = Image.open(master_png)
    ret = img.resize((256, 256), Image.LANCZOS)
    ret.save(os.path.join(ICONS_DIR, "128x128@2x.png"))
    print(f"  ✓ {os.path.join(ICONS_DIR, '128x128@2x.png')}")
    
    # 4. 生成 Tauri icons 目录的图标
    print("\n📁 生成 src-tauri/icons/ 目录图标...")
    shutil.copy(master_png, os.path.join(TAURI_ICONS_DIR, "icon.png"))
    print(f"  ✓ {os.path.join(TAURI_ICONS_DIR, 'icon.png')}")
    
    create_icon(32, bg_color, accent_color, os.path.join(TAURI_ICONS_DIR, "32x32.png"))
    create_icon(128, bg_color, accent_color, os.path.join(TAURI_ICONS_DIR, "128x128.png"))
    
    ret = img.resize((256, 256), Image.LANCZOS)
    ret.save(os.path.join(TAURI_ICONS_DIR, "128x128@2x.png"))
    print(f"  ✓ {os.path.join(TAURI_ICONS_DIR, '128x128@2x.png')}")
    
    # 5. 创建 ICNS 和 ICO
    print("\n📁 创建 ICNS 和 ICO 文件...")
    create_icns(master_png, os.path.join(ICONS_DIR, "icon.icns"))
    create_ico(master_png, os.path.join(ICONS_DIR, "icon.ico"))
    create_icns(master_png, os.path.join(TAURI_ICONS_DIR, "icon.icns"))
    create_ico(master_png, os.path.join(TAURI_ICONS_DIR, "icon.ico"))
    
    # 6. 清理 Tauri icons 目录中的旧文件
    print("\n📁 清理 Tauri icons 目录...")
    for f in os.listdir(TAURI_ICONS_DIR):
        if f.startswith("Square") or f.startswith("Store") or f.endswith(".png") and f not in [
            "icon.png", "32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico"
        ]:
            try:
                os.remove(os.path.join(TAURI_ICONS_DIR, f))
                print(f"  🗑️  删除旧文件: {f}")
            except:
                pass
    
    print("\n✅ 所有图标替换完成！")
    print(f"\n主图标位置: {master_png}")

if __name__ == "__main__":
    main()
