#!/usr/bin/env python3
"""v3 图标：深蓝底 + 琥珀金「潜」字（金币隐喻配债机会）。
选「潜」而非「¥」或「集」：与功能「潜伏配债」直接相关，跨集思录系列插件辨识度。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (11, 27, 52, 255)
GOLD = (245, 182, 74, 255)
GOLD_DEEP = (210, 145, 38, 255)
INK = (11, 27, 52, 255)

FONT_PATHS = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]
def get_font(size):
    for p in FONT_PATHS:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except: pass
    return ImageFont.load_default()

def text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox[0], bbox[1]

def make_icon(size):
    scale = 4
    s = size
    img = Image.new('RGBA', (s*scale, s*scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r = int(s * 0.22) * scale
    draw.rounded_rectangle((0, 0, s*scale - 1, s*scale - 1), radius=r, fill=BG)
    tmp = Image.new('RGBA', (s*scale, s*scale), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    if size >= 48:
        pad = int(s * 0.10) * scale
        coin_box = (pad, pad, s*scale - pad, s*scale - pad)
        # 金币阴影 + 主体
        draw.ellipse((coin_box[0] + 2*scale, coin_box[1] + 2*scale, coin_box[2] + 2*scale, coin_box[3] + 2*scale), fill=GOLD_DEEP)
        draw.ellipse(coin_box, fill=GOLD)
        # 「潜」字（笔画多，字号稍小避免溢出）
        font_size = int(s * 0.50) * scale
        font = get_font(font_size)
        tw, th, _, oy = text_size(td, '潜', font)
        x = (s*scale - tw) / 2 - 0
        y = (s*scale - th) / 2 - oy
        draw.text((x, y), '潜', font=font, fill=INK)
        # 右上角小金条（标识"双列"）
        bar_w = int(s * 0.16) * scale
        bar_h = int(s * 0.07) * scale
        bx = s*scale - bar_w - int(s * 0.10) * scale
        by = int(s * 0.10) * scale
        draw.rounded_rectangle((bx, by, bx + bar_w, by + bar_h), radius=int(bar_h/2), fill=GOLD)
    else:
        # 16px：「潜」字笔画太多必糊，只画金色圆 + 中央深蓝小点（象征"在圆里"= 潜伏）
        pad = int(s * 0.18) * scale
        coin_box = (pad, pad, s*scale - pad, s*scale - pad)
        draw.ellipse((coin_box[0] + 1*scale, coin_box[1] + 1*scale, coin_box[2] + 1*scale, coin_box[3] + 1*scale), fill=GOLD_DEEP)
        draw.ellipse(coin_box, fill=GOLD)
        # 中央深蓝小三角（暗示"潜入"）
        cx = s*scale // 2
        cy = s*scale // 2
        r2 = int(s * 0.10) * scale
        draw.polygon([(cx, cy + r2), (cx - r2, cy - r2//2), (cx + r2, cy - r2//2)], fill=INK)
    return img.resize((s, s), Image.LANCZOS)

for size in (16, 48, 128):
    img = make_icon(size)
    path = os.path.join(OUT, f'icon-{size}.png')
    img.save(path, 'PNG', optimize=True)
    print(f'wrote {path} ({os.path.getsize(path)} bytes)')
print('done')
