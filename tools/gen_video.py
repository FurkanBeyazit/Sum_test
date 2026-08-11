#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sentetik CCTV video üretici
===========================

`mock/data/render.json` içindeki track verisinden kare kare bir CCTV sahnesi
çizer ve ffmpeg ile H.264 + faststart MP4 üretir.

Neden sentetik?
  Böylece oynatılan görüntü ile bbox metadata'sı **birebir** aynı kaynaktan
  gelir. Overlay matematiği (letterbox, normalize koordinat, DPI) hatalıysa
  anında görünür — gerçek videoda bu ancak gözle tahmin edilebilir.

Yan çıktılar:
  mock/assets/crops/CAM0X_TY.jpg   nesne listesi kartları (bbox kırpması)
  mock/assets/thumbs/CAM0X_EY.jpg  olay küçük görselleri
  mock/assets/poster/CAM0X.jpg     video poster kareleri

Kullanım:  python tools/gen_video.py [--fast]
  --fast : yarı çözünürlük, daha hızlı üretim
"""

import json
import math
import random
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
MOCK = ROOT / "mock"
DATA = MOCK / "data"
ASSETS = MOCK / "assets"

FAST = "--fast" in sys.argv

PALETTE = {
    "red": (196, 58, 52), "orange": (214, 118, 42), "yellow": (206, 176, 48),
    "green": (62, 148, 84), "blue": (54, 96, 178), "purple": (128, 78, 168),
    "white": (222, 224, 226), "gray": (132, 138, 146), "black": (44, 48, 54),
    "beige": (186, 170, 134), "silver": (176, 182, 190),
}


def font(size):
    for name in ("malgun.ttf", "arial.ttf", "DejaVuSans.ttf", "seguisb.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


F_TS = font(19)
F_LBL = font(15)
F_SM = font(12)


def ease(u):
    return u * u * (3 - 2 * u)


def lerp(a, b, u):
    return a + (b - a) * u


def track_at(wp, t, aspect):
    """gen_mock.Track.at ile AYNI matematik — kutular birebir örtüşmeli."""
    if t < wp[0][0] - 1e-6 or t > wp[-1][0] + 1e-6:
        return None
    cx = cy = h = 0.0
    for i in range(len(wp) - 1):
        ta, xa, ya, ha = wp[i]
        tb, xb, yb, hb = wp[i + 1]
        if ta <= t <= tb:
            u = 0.0 if tb == ta else (t - ta) / (tb - ta)
            u = ease(u)
            cx, cy, h = lerp(xa, xb, u), lerp(ya, yb, u), lerp(ha, hb, u)
            break
    else:
        _, cx, cy, h = wp[-1]
    return cx, cy, h


# ---------------------------------------------------------------------------
# Arka plan sahneleri
# ---------------------------------------------------------------------------

def bg_gate(W, H, tint):
    """정문 — perspektifli yol, kapı direkleri, çit, ağaçlar."""
    im = Image.new("RGB", (W, H), tint)
    d = ImageDraw.Draw(im)
    hz = int(H * 0.26)                                   # ufuk çizgisi
    # gökyüzü
    for y in range(hz):
        u = y / max(1, hz)
        d.line([(0, y), (W, y)], fill=(int(96 + 40 * u), int(112 + 44 * u),
                                       int(128 + 44 * u)))
    # uzak ağaç sırası
    random.seed(7)
    for i in range(26):
        x = int(i * W / 25)
        r = random.randint(26, 52)
        d.ellipse([x - r, hz - r - 12, x + r, hz + 10],
                  fill=(38 + random.randint(0, 14), 62 + random.randint(0, 18), 44))
    # zemin
    for y in range(hz, H):
        u = (y - hz) / max(1, H - hz)
        g = int(58 + 34 * u)
        d.line([(0, y), (W, y)], fill=(g - 6, g, g - 4))
    # perspektifli yol
    d.polygon([(W * 0.42, hz), (W * 0.58, hz), (W * 0.95, H), (W * 0.05, H)],
              fill=(74, 76, 80))
    # orta şerit
    for k in range(9):
        u0, u1 = k / 9, k / 9 + 0.045
        y0, y1 = hz + (H - hz) * u0 ** 1.6, hz + (H - hz) * u1 ** 1.6
        w0 = 2 + 7 * u0 ** 1.6
        d.polygon([(W * 0.5 - w0, y0), (W * 0.5 + w0, y0),
                   (W * 0.5 + w0 * 1.4, y1), (W * 0.5 - w0 * 1.4, y1)],
                  fill=(148, 148, 140))
    # kapı direkleri
    for sx in (0.365, 0.635):
        d.rectangle([W * sx - 9, hz - 44, W * sx + 9, hz + 26], fill=(58, 60, 66))
        d.rectangle([W * sx - 13, hz - 52, W * sx + 13, hz - 42], fill=(76, 78, 84))
    # çit
    for i in range(0, W, 22):
        if W * 0.36 < i < W * 0.64:
            continue
        d.line([(i, hz - 24), (i, hz + 14)], fill=(70, 74, 78), width=3)
    d.line([(0, hz - 20), (W, hz - 20)], fill=(78, 82, 86), width=3)
    # bina (sağ)
    d.rectangle([W * 0.72, hz - 96, W * 0.99, hz + 18], fill=(66, 64, 62))
    for r in range(3):
        for c in range(5):
            d.rectangle([W * 0.74 + c * 22, hz - 88 + r * 28,
                         W * 0.74 + c * 22 + 14, hz - 88 + r * 28 + 18],
                        fill=(96, 104, 112))
    return im


def bg_parking(W, H, tint):
    """주차장 — park çizgileri ve park etmiş araçlar."""
    im = Image.new("RGB", (W, H), tint)
    d = ImageDraw.Draw(im)
    hz = int(H * 0.22)
    for y in range(hz):
        u = y / max(1, hz)
        d.line([(0, y), (W, y)], fill=(int(70 + 26 * u), int(78 + 28 * u),
                                       int(92 + 26 * u)))
    for y in range(hz, H):
        u = (y - hz) / max(1, H - hz)
        g = int(52 + 30 * u)
        d.line([(0, y), (W, y)], fill=(g, g + 2, g + 5))
    # duvar
    d.rectangle([0, hz - 40, W, hz + 8], fill=(60, 60, 66))
    d.line([(0, hz + 8), (W, hz + 8)], fill=(84, 84, 90), width=2)
    # perspektifli park çizgileri
    for k in range(-1, 9):
        xt = W * (0.06 + k * 0.115)
        xb = W * (-0.32 + k * 0.20)
        d.line([(xt, hz + 18), (xb, H)], fill=(176, 172, 150), width=2)
    d.line([(0, hz + 96), (W, hz + 130)], fill=(176, 172, 150), width=2)
    # park etmiş araçlar (arka sıra)
    random.seed(11)
    for k in range(5):
        cx = W * (0.12 + k * 0.19)
        cy = hz + 54
        w, h = 92, 34
        col = random.choice([(70, 74, 82), (150, 152, 158), (56, 58, 62),
                             (110, 116, 124), (78, 88, 104)])
        d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                            radius=8, fill=col)
        d.rounded_rectangle([cx - w * 0.30, cy - h * 0.72, cx + w * 0.30, cy - h * 0.1],
                            radius=6, fill=tuple(min(255, c + 26) for c in col))
    return im


def bg_backgate(W, H, tint):
    """후문 — dar, loş, duvar ve kapı."""
    im = Image.new("RGB", (W, H), tint)
    d = ImageDraw.Draw(im)
    hz = int(H * 0.30)
    for y in range(H):
        u = y / H
        g = int(34 + 40 * u)
        d.line([(0, y), (W, y)], fill=(g, g + 1, g + 4))
    d.rectangle([0, 0, W, hz], fill=(48, 50, 56))
    for i in range(0, W, 46):
        d.line([(i, 0), (i, hz)], fill=(42, 44, 50), width=2)
    for j in range(0, hz, 24):
        d.line([(0, j), (W, j)], fill=(42, 44, 50), width=1)
    # kapı
    d.rectangle([W * 0.40, hz - 108, W * 0.60, hz + 6], fill=(38, 42, 48))
    d.rectangle([W * 0.405, hz - 102, W * 0.595, hz], fill=(58, 64, 72))
    d.ellipse([W * 0.575, hz - 56, W * 0.588, hz - 44], fill=(150, 148, 130))
    # lamba ışığı
    d.ellipse([W * 0.5 - 150, hz - 24, W * 0.5 + 150, hz + 150],
              fill=(58, 58, 62))
    d.line([(0, hz + 6), (W, hz + 6)], fill=(64, 66, 70), width=2)
    return im


def bg_lobby(W, H, tint):
    """로비 — fayans zemin, kolonlar, cam kapı."""
    im = Image.new("RGB", (W, H), tint)
    d = ImageDraw.Draw(im)
    hz = int(H * 0.28)
    d.rectangle([0, 0, W, hz], fill=(62, 60, 58))
    # cam kapı
    d.rectangle([W * 0.30, hz - 120, W * 0.70, hz + 4], fill=(96, 112, 122))
    d.line([(W * 0.50, hz - 120), (W * 0.50, hz + 4)], fill=(52, 54, 58), width=4)
    d.rectangle([W * 0.30, hz - 124, W * 0.70, hz - 116], fill=(52, 54, 58))
    # zemin fayansları (perspektif)
    for y in range(hz, H):
        u = (y - hz) / max(1, H - hz)
        g = int(66 + 40 * u)
        d.line([(0, y), (W, y)], fill=(g + 4, g + 2, g))
    for k in range(-6, 14):
        xt = W * (0.5 + (k - 4) * 0.052)
        xb = W * (0.5 + (k - 4) * 0.26)
        d.line([(xt, hz), (xb, H)], fill=(96, 92, 88), width=1)
    yy = hz
    step = 8
    while yy < H:
        d.line([(0, yy), (W, yy)], fill=(96, 92, 88), width=1)
        step = int(step * 1.28) + 2
        yy += step
    # kolonlar
    for sx in (0.14, 0.86):
        d.rectangle([W * sx - 22, hz - 150, W * sx + 22, H], fill=(80, 78, 76))
        d.rectangle([W * sx - 26, hz - 158, W * sx + 26, hz - 146], fill=(92, 90, 88))
    return im


BG = {"gate": bg_gate, "parking": bg_parking,
      "backgate": bg_backgate, "lobby": bg_lobby}


# ---------------------------------------------------------------------------
# Nesne çizimi
# ---------------------------------------------------------------------------

def draw_person(d, x1, y1, x2, y2, attrs, t, tid, fallen=False):
    w = x2 - x1
    h = y2 - y1
    if h < 6:
        return
    up = PALETTE.get(attrs.get("upper_color", "gray"), (130, 130, 130))
    lo = PALETTE.get(attrs.get("lower_color", "black"), (50, 50, 56))
    skin = (196, 168, 142)

    if fallen:
        # yatay silüet
        d.rounded_rectangle([x1, y1 + h * 0.30, x1 + w * 0.62, y2],
                            radius=max(2, int(h * 0.25)), fill=up)
        d.rounded_rectangle([x1 + w * 0.55, y1 + h * 0.40, x2, y2 - h * 0.08],
                            radius=max(2, int(h * 0.20)), fill=lo)
        r = h * 0.30
        cx = x1 + w * 0.10
        cy = y1 + h * 0.38
        d.ellipse([cx - r / 2, cy - r / 2, cx + r / 2, cy + r / 2], fill=skin)
        return

    head_r = h * 0.115
    cx = (x1 + x2) / 2
    # gölge
    d.ellipse([cx - w * 0.42, y2 - h * 0.035, cx + w * 0.42, y2 + h * 0.035],
              fill=(30, 32, 34))
    # bacaklar — yürüyüş salınımı
    sw = math.sin(t * 6.4 + tid) * w * 0.16
    leg_top = y1 + h * 0.56
    d.line([(cx - w * 0.13, leg_top), (cx - w * 0.13 + sw, y2)],
           fill=lo, width=max(2, int(w * 0.20)))
    d.line([(cx + w * 0.13, leg_top), (cx + w * 0.13 - sw, y2)],
           fill=lo, width=max(2, int(w * 0.20)))
    # gövde
    d.rounded_rectangle([cx - w * 0.30, y1 + h * 0.24, cx + w * 0.30, leg_top + h * 0.02],
                        radius=max(1, int(w * 0.16)), fill=up)
    # kollar
    aw = math.sin(t * 6.4 + tid + math.pi) * w * 0.10
    d.line([(cx - w * 0.28, y1 + h * 0.30), (cx - w * 0.36 + aw, y1 + h * 0.54)],
           fill=up, width=max(2, int(w * 0.13)))
    d.line([(cx + w * 0.28, y1 + h * 0.30), (cx + w * 0.36 - aw, y1 + h * 0.54)],
           fill=up, width=max(2, int(w * 0.13)))
    # sırt çantası
    carry = attrs.get("carry") or []
    if "backpack" in carry:
        d.rounded_rectangle([cx - w * 0.40, y1 + h * 0.28, cx - w * 0.24, y1 + h * 0.52],
                            radius=max(1, int(w * 0.08)), fill=(58, 62, 72))
    if "handbag" in carry:
        d.rounded_rectangle([cx + w * 0.30, y1 + h * 0.46, cx + w * 0.48, y1 + h * 0.62],
                            radius=2, fill=(104, 72, 54))
    if "box" in carry:
        d.rectangle([cx - w * 0.30, y1 + h * 0.36, cx + w * 0.30, y1 + h * 0.56],
                    fill=(168, 142, 96), outline=(120, 98, 64))
    # baş
    d.ellipse([cx - head_r, y1 + h * 0.02, cx + head_r, y1 + h * 0.02 + head_r * 2],
              fill=skin)
    # saç / şapka
    if attrs.get("hat") == "yes":
        d.ellipse([cx - head_r * 1.25, y1, cx + head_r * 1.25, y1 + head_r * 1.3],
                  fill=(50, 54, 62))
    else:
        d.chord([cx - head_r, y1 + h * 0.02, cx + head_r, y1 + h * 0.02 + head_r * 2],
                180, 360, fill=(46, 38, 34))


def draw_vehicle(d, x1, y1, x2, y2, attrs):
    w, h = x2 - x1, y2 - y1
    if h < 5:
        return
    col = PALETTE.get(attrs.get("vehicle_color", "gray"), (120, 120, 128))
    glass = tuple(min(255, c + 46) for c in col)
    d.ellipse([x1 - w * 0.02, y2 - h * 0.12, x2 + w * 0.02, y2 + h * 0.10],
              fill=(30, 32, 34))
    d.rounded_rectangle([x1, y1 + h * 0.34, x2, y2 - h * 0.10],
                        radius=max(2, int(h * 0.18)), fill=col)
    d.rounded_rectangle([x1 + w * 0.20, y1, x2 - w * 0.20, y1 + h * 0.46],
                        radius=max(2, int(h * 0.16)), fill=col)
    d.rounded_rectangle([x1 + w * 0.245, y1 + h * 0.07, x2 - w * 0.245, y1 + h * 0.40],
                        radius=max(1, int(h * 0.10)), fill=glass)
    r = h * 0.20
    for fx in (0.20, 0.80):
        cx = x1 + w * fx
        d.ellipse([cx - r, y2 - r * 1.5, cx + r, y2 + r * 0.5], fill=(28, 28, 32))
    d.rectangle([x2 - w * 0.05, y1 + h * 0.52, x2, y1 + h * 0.66],
                fill=(236, 226, 190))


# ---------------------------------------------------------------------------
# Kare oluşturma
# ---------------------------------------------------------------------------

def render_frame(bg, cfg, t, W, H, start_dt):
    im = bg.copy()
    d = ImageDraw.Draw(im, "RGBA")

    # uzaktakiler önce çizilsin (y'ye göre sırala)
    drawables = []
    for tr in cfg["tracks"]:
        p = track_at([tuple(x) for x in tr["wp"]], t, tr["aspect"])
        if p is None:
            continue
        cx, cy, h = p
        jh = 1.0 + math.sin(t * 6.7 + tr["tid"]) * 0.012
        h *= jh
        w = h * tr["aspect"] * jh
        jx = math.sin(t * 5.1 + tr["tid"]) * 0.0022
        jy = math.cos(t * 4.3 + tr["tid"] * 2) * 0.0018
        x1 = (cx - w / 2 + jx) * W
        y1 = (cy - h / 2 + jy) * H
        x2 = (cx + w / 2 + jx) * W
        y2 = (cy + h / 2 + jy) * H
        if x2 < -20 or x1 > W + 20:
            continue
        drawables.append((y2, tr, x1, y1, x2, y2))
    drawables.sort(key=lambda a: a[0])

    for _, tr, x1, y1, x2, y2 in drawables:
        if tr["cls"] == "person":
            fallen = tr["aspect"] > 0.44 and (y2 - y1) < H * 0.20
            draw_person(d, x1, y1, x2, y2, tr["attrs"], t, tr["tid"], fallen)
        else:
            draw_vehicle(d, x1, y1, x2, y2, tr["attrs"])

    # --- CCTV gerçekçiliği --------------------------------------------------
    # vinyet
    vg = Image.new("L", (W, H), 0)
    ImageDraw.Draw(vg).ellipse([-W * 0.28, -H * 0.34, W * 1.28, H * 1.34], fill=255)
    vg = vg.filter(ImageFilter.GaussianBlur(W // 12))
    im = Image.composite(im, Image.new("RGB", (W, H), (12, 13, 16)), vg)

    d = ImageDraw.Draw(im, "RGBA")
    # tarama çizgileri
    for y in range(0, H, 3):
        d.line([(0, y), (W, y)], fill=(0, 0, 0, 16))

    # yakılmış zaman damgası (gerçek CCTV böyle yapar)
    wall = start_dt + timedelta(seconds=t)
    ts = wall.strftime("%Y-%m-%d %H:%M:%S")
    d.rectangle([10, 8, 10 + 196, 8 + 26], fill=(0, 0, 0, 130))
    d.text((16, 11), ts, font=F_TS, fill=(238, 240, 244))
    lbl = f"{cfg['name']} · {cfg['place']}"
    tw = d.textlength(lbl, font=F_LBL)
    d.rectangle([W - tw - 22, 8, W - 8, 8 + 24], fill=(0, 0, 0, 130))
    d.text((W - tw - 15, 11), lbl, font=F_LBL, fill=(206, 212, 220))
    # REC göstergesi
    if int(t * 2) % 2 == 0:
        d.ellipse([W - 22, H - 24, W - 10, H - 12], fill=(220, 60, 56))
    d.text((10, H - 26), "CH01  1080P  10FPS", font=F_SM, fill=(150, 158, 168, 200))
    return im


def crop_box(im, x1, y1, x2, y2, pad=0.12):
    W, H = im.size
    w, h = x2 - x1, y2 - y1
    px, py = w * pad, h * pad
    box = (max(0, int(x1 - px)), max(0, int(y1 - py)),
           min(W, int(x2 + px)), min(H, int(y2 + py)))
    if box[2] - box[0] < 8 or box[3] - box[1] < 8:
        return None
    c = im.crop(box)
    # nesne listesi kartı için normalize boyut
    c = c.resize((128, int(128 * (box[3] - box[1]) / max(1, box[2] - box[0]))),
                 Image.LANCZOS)
    return c


def main():
    render = json.loads((DATA / "render.json").read_text(encoding="utf-8"))
    (ASSETS / "thumbs").mkdir(parents=True, exist_ok=True)
    (ASSETS / "crops").mkdir(parents=True, exist_ok=True)
    (ASSETS / "poster").mkdir(parents=True, exist_ok=True)

    for cid, cfg in render.items():
        W, H = cfg["w"], cfg["h"]
        if FAST:
            W, H = W // 2, H // 2
        fps = cfg["fps"]
        dur = cfg["duration"]
        nframes = int(dur * fps)
        start_dt = datetime.fromisoformat(cfg["start_time"].replace("+09:00", ""))
        bg = BG[cfg["style"]["kind"]](W, H, tuple(cfg["style"]["tint"]))

        out = ASSETS / f"{cid.lower()}.mp4"
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
            "-an",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
            "-pix_fmt", "yuv420p",
            "-g", str(fps),                # 1 saniyelik GOP → hassas seek
            "-keyint_min", str(fps),
            "-sc_threshold", "0",
            "-movflags", "+faststart",     # index başa alınır
            str(out),
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

        # hangi karelerde crop/thumb alınacak
        crop_at = {}
        for tr in cfg["tracks"]:
            wp = tr["wp"]
            tmid = (wp[0][0] + wp[-1][0]) / 2
            # kişi en büyük göründüğünde kırp — en kaliteli crop
            best_t, best_h = tmid, 0
            for k in range(24):
                tt = wp[0][0] + (wp[-1][0] - wp[0][0]) * k / 23
                p = track_at([tuple(x) for x in wp], tt, tr["aspect"])
                if p and p[2] > best_h and 0.06 < p[0] < 0.94:
                    best_h, best_t = p[2], tt
            crop_at.setdefault(int(best_t * fps), []).append(tr)
        thumb_at = {}
        for e in cfg["events"]:
            tm = (e["t0"] + e["t1"]) / 2
            thumb_at.setdefault(int(min(dur - 0.1, tm) * fps), []).append(e)

        print(f"  {cid}: {nframes} kare @ {W}x{H} ...", end="", flush=True)
        for f in range(nframes):
            t = f / fps
            im = render_frame(bg, cfg, t, W, H, start_dt)
            proc.stdin.write(im.tobytes())

            if f == int(nframes * 0.35):
                im.save(ASSETS / "poster" / f"{cid}.jpg", quality=86)
            for tr in crop_at.get(f, []):
                p = track_at([tuple(x) for x in tr["wp"]], t, tr["aspect"])
                if not p:
                    continue
                cx, cy, h = p
                w = h * tr["aspect"]
                c = crop_box(im, (cx - w / 2) * W, (cy - h / 2) * H,
                             (cx + w / 2) * W, (cy + h / 2) * H)
                if c:
                    c.save(ASSETS / "crops" / f"{cid}_T{tr['tid']}.jpg", quality=88)
            for e in thumb_at.get(f, []):
                im.resize((256, int(256 * H / W)), Image.LANCZOS).save(
                    ASSETS / "thumbs" / f"{e['id']}.jpg", quality=84)

        proc.stdin.close()
        rc = proc.wait()
        size = out.stat().st_size / 1024 if out.exists() else 0
        print(f" ok ({size:.0f} KB, rc={rc})")

    print("== Video uretimi bitti ==")


if __name__ == "__main__":
    main()
