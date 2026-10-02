"""Imágenes del instalador (icono y paneles) a partir del logo. Uso: python3 make-assets.py <carpeta de salida>"""
import sys, os
from PIL import Image, ImageDraw

out = sys.argv[1]; os.makedirs(out, exist_ok=True)
img = os.path.join(os.path.dirname(__file__), '..', 'public', 'img')
TEAL, DARK = (55, 194, 185), (15, 118, 110)

def gradient(w, h):
    g = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(TEAL[i] + (DARK[i] - TEAL[i]) * t) for i in range(3)))
    return g

def paste_logo(canvas, name, width, y):
    logo = Image.open(os.path.join(img, name)).convert('RGBA')
    logo = logo.resize((width, round(logo.height * width / logo.width)), Image.LANCZOS)
    canvas.paste(logo, ((canvas.width - width) // 2, y), logo)

# Panel lateral de bienvenida y final (164x314)
side = gradient(164, 314)
paste_logo(side, 'logo-blanco.png', 140, 90)
side.save(os.path.join(out, 'welcome.bmp'))
# Cabecera de las demás pantallas (150x57)
head = Image.new('RGB', (150, 57), 'white')
paste_logo(head, 'logo-tinta.png', 66, 6)
head.save(os.path.join(out, 'header.bmp'))
# Icono multitamaño
fav = Image.open(os.path.join(img, 'favicon.png')).convert('RGBA')
fav.save(os.path.join(out, 'liuvi.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128)])
