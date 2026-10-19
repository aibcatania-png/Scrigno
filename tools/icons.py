#!/usr/bin/env python3
"""Genera le icone PNG di Scrigno per tutte le piattaforme (richiede Pillow)."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEAL, WHITE = (15, 118, 110, 255), (255, 255, 255, 255)


def icon(size, pad=0.0, rounded=True, bg=True):
    s = size * 4
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bg:
        if rounded and pad == 0:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=TEAL)
        else:
            d.rectangle([0, 0, s, s], fill=TEAL)
    u = s * (1 - 2 * pad) / 32
    o = s * pad
    P = lambda x, y: (o + x * u, o + y * u)
    w = int(2.6 * u)
    fg = WHITE if bg else TEAL
    d.arc([*P(11, 6.5), *P(21, 16.5)], 180, 360, fill=fg, width=w)
    d.line([P(11, 11.5), P(11, 15)], fill=fg, width=w)
    d.line([P(21, 11.5), P(21, 15)], fill=fg, width=w)
    d.rounded_rectangle([*P(8.5, 14.5), *P(23.5, 25)], radius=int(2.5 * u), fill=fg)
    hole = TEAL if bg else WHITE
    d.ellipse([*P(14.2, 17.2), *P(17.8, 20.8)], fill=hole)
    d.rounded_rectangle([*P(15.2, 19.6), *P(16.8, 22.6)], radius=int(.8 * u), fill=hole)
    return im.resize((size, size), Image.LANCZOS)


def save(im, *path):
    p = os.path.join(ROOT, *path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p)


if __name__ == '__main__':
    for n in (16, 32, 48, 128):
        save(icon(n), 'extension', 'src', 'icons', f'icon-{n}.png')
    save(icon(1024), 'desktop', 'build', 'icon.png')
    save(icon(32), 'desktop', 'build', 'tray.png')
    for name, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        save(icon(px), 'android', 'app', 'src', 'main', 'res', f'mipmap-{name}', 'ic_launcher.png')
        # primo piano dell'icona adattiva (108dp con zona sicura di 72dp)
        fg = icon(int(px * 108 / 48), pad=0.18, bg=True)
        save(fg, 'android', 'app', 'src', 'main', 'res', f'mipmap-{name}', 'ic_launcher_foreground.png')
    save(icon(84), 'android', 'app', 'src', 'main', 'res', 'drawable-xxhdpi', 'ic_scrigno.png')
    save(icon(1024, pad=0.0, rounded=False).convert('RGB'), 'ios', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')
    print('icone generate')
