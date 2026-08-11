#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kendi videonu mockup'a ekle
===========================

Elindeki herhangi bir videoyu platforma kaydeder:

  1. ffprobe ile gerçek metadata okunur (çözünürlük, fps, kodek, süre)
  2. ffmpeg ile tarayıcı dostu proxy üretilir:
        H.264 + yuv420p + AAC + `-movflags +faststart` + 1 saniyelik GOP
     (PROJE-NOTLARI.md bölüm 9.4'teki dört maddenin uygulaması)
  3. `--motion` verilirse hareket tabanlı sözde-tespit üretilir:
        kare farkı → kaba ızgara → bağlı bileşen → IoU eşleme ile track_id
     Bu bir Object Detection DEĞİLDİR; ama kutular gerçekten hareket eden
     bölgeleri takip eder, yani overlay/timeline/nesne listesi uçtan uca
     çalışır ve koordinat matematiğini gerçek videoda doğrulayabilirsin.
  4. Katalog güncellenir → sol ağaçta yeni kamera görünür

Kullanım:
    python tools/add_video.py "D:\\kayit.mp4" --name Camera99 --place "테스트"
    python tools/add_video.py "D:\\kayit.mp4" --motion
    python tools/add_video.py "D:\\kayit.mp4" --motion --start "2025-05-20T09:00:00"
    python tools/add_video.py --list
    python tools/add_video.py --remove CAM99
"""

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MOCK = ROOT / "mock"
DATA = MOCK / "data"
ASSETS = MOCK / "assets"

for st in (sys.stdout, sys.stderr):
    try:
        st.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

CONCEPTS = ["person", "vehicle", "crowd", "walk", "run", "stand",
            "phone", "board_vehicle", "enter", "exit", "loiter",
            "fall", "fight", "fire_smoke", "night", "bag", "bicycle", "abandon"]


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def probe(path):
    r = sh(["ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", str(path)])
    if r.returncode != 0:
        raise SystemExit(f"ffprobe hatasi:\n{r.stderr}")
    j = json.loads(r.stdout)
    vs = next((s for s in j["streams"] if s["codec_type"] == "video"), None)
    if not vs:
        raise SystemExit("Video akisi bulunamadi.")
    num, den = (vs.get("r_frame_rate") or "25/1").split("/")
    fps = float(num) / float(den or 1)
    dur = float(j["format"].get("duration") or vs.get("duration") or 0)
    return {
        "width": int(vs["width"]), "height": int(vs["height"]),
        "fps": round(fps, 3), "duration": round(dur, 2),
        "codec": vs.get("codec_name", "?"),
        "pix_fmt": vs.get("pix_fmt", "?"),
        "bitrate_kbps": int(int(j["format"].get("bit_rate") or 0) / 1000),
        "size_mb": round(int(j["format"].get("size") or 0) / 1048576, 1),
        "has_audio": any(s["codec_type"] == "audio" for s in j["streams"]),
    }


def can_copy(info, max_w, target_fps):
    """Yeniden kodlamaya gerek var mi?

    VMS kaynaklari cogunlukla H.264. Eger profil ve piksel formati tarayici
    dostuysa, videoyu YENIDEN KODLAMADAN sadece MP4'e sarabiliriz (remux).
    Fark cok buyuk: 30 dakikalik video icin ~90 saniye yerine ~2 saniye,
    ve kalite kaybi sifir.

    Engeller:
      * kodek H.264 degil (HEVC/MJPEG/VP9) -> Chrome guvenilir oynatmaz
      * pix_fmt yuv420p degil (yuv422p/444p, 10-bit) -> Chrome desteklemez
      * olcek veya fps degistirilecek -> zorunlu yeniden kodlama
    """
    reasons = []
    if info["codec"] not in ("h264", "avc1"):
        reasons.append(f"kodek {info['codec']} (H.264 degil)")
    if info["pix_fmt"] not in ("yuv420p", "yuvj420p"):
        reasons.append(f"pix_fmt {info['pix_fmt']} (yuv420p degil)")
    if info["width"] > max_w:
        reasons.append(f"genislik {info['width']} > {max_w}")
    if target_fps and abs(info["fps"] - target_fps) > 0.01:
        reasons.append("fps degistirilecek")
    return (not reasons), reasons


def make_proxy(src, dst, info, max_w=1280, target_fps=None, force_encode=False):
    """Tarayici dostu proxy uretir.

    Once REMUX dener (kodlama yok), olmuyorsa yeniden kodlar.
    Her iki yolda da su uc sey garanti edilir:
      -movflags +faststart   -> moov atom basa gelir, aninda oynar
      yuv420p                -> Chrome'un destekledigi tek yaygin format
      MP4 konteyner          -> Range destegi ile seek
    """
    ok, why = can_copy(info, max_w, target_fps)
    if ok and not force_encode:
        print("  REMUX (yeniden kodlama YOK) ...", end="", flush=True)
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
               "-c", "copy", "-movflags", "+faststart", str(dst)]
        r = sh(cmd)
        if r.returncode == 0:
            print(f" ok ({dst.stat().st_size/1048576:.1f} MB)")
            gop = probe_gop(dst)
            if gop and gop > 2.5:
                print(f"  ! GOP ~{gop:.1f}s — seek dogrulugu +-{gop:.1f}s olacak.")
                print(f"    Hassas seek istiyorsan: --force-encode")
            return info["fps"], "remux"
        print(f" basarisiz, yeniden kodlamaya dusuluyor")
    elif why:
        print("  yeniden kodlama gerekli: " + "; ".join(why))

    fps = target_fps or min(info["fps"], 15)
    g = max(1, int(round(fps)))          # 1 saniyelik GOP -> hassas seek
    vf = []
    if info["width"] > max_w:
        vf.append(f"scale={max_w}:-2")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)]
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd += [
        "-r", str(fps),
        "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast",
        "-crf", "24", "-pix_fmt", "yuv420p",
        "-g", str(g), "-keyint_min", str(g), "-sc_threshold", "0",
        "-movflags", "+faststart",
    ]
    cmd += (["-c:a", "aac", "-b:a", "96k"] if info["has_audio"] else ["-an"])
    cmd += [str(dst)]
    print("  YENIDEN KODLAMA (libx264) ...", end="", flush=True)
    r = sh(cmd)
    if r.returncode != 0:
        raise SystemExit("ffmpeg hatasi: " + r.stderr[-2000:])
    print(f" ok ({dst.stat().st_size/1048576:.1f} MB)")
    return fps, "encode"


def probe_gop(path, sample_sec=30):
    """Ortalama keyframe araligi — seek dogrulugunun ust siniri."""
    r = sh(["ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "frame=key_frame,best_effort_timestamp_time",
            "-read_intervals", f"%+{sample_sec}", "-of", "csv=p=0", str(path)])
    if r.returncode != 0:
        return None
    ts = []
    for line in r.stdout.strip().splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and parts[0] == "1":
            try:
                ts.append(float(parts[1]))
            except ValueError:
                pass
    if len(ts) < 2:
        return None
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    return sum(gaps) / len(gaps)


def extract_gray(path, w, h, fps):
    """Videoyu küçük gri karelere indirger — hareket analizi için."""
    cmd = ["ffmpeg", "-v", "error", "-i", str(path),
           "-vf", f"scale={w}:{h},format=gray", "-r", str(fps),
           "-f", "rawvideo", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0:
        raise SystemExit(p.stderr.decode("utf-8", "replace")[-1500:])
    buf = np.frombuffer(p.stdout, dtype=np.uint8)
    n = buf.size // (w * h)
    return buf[:n * w * h].reshape(n, h, w).astype(np.float32)


def components(mask):
    """Basit bağlı bileşen etiketleme (4 komşuluk, yığın tabanlı flood fill)."""
    H, W = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for y in range(H):
        for x in range(W):
            if not mask[y, x] or seen[y, x]:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            cells = []
            while stack:
                cy, cx = stack.pop()
                cells.append((cy, cx))
                for ny, nx in ((cy-1, cx), (cy+1, cx), (cy, cx-1), (cy, cx+1)):
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            ys = [c[0] for c in cells]
            xs = [c[1] for c in cells]
            out.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(cells)))
    return out


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix = max(0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    ua = (ax2-ax1)*(ay2-ay1) + (bx2-bx1)*(by2-by1) - inter
    return inter / ua if ua > 0 else 0


def motion_detect(proxy_path, fps, min_cells=4, grid_w=64):
    """Kare farkı → ızgara → bileşen → IoU takip. Gerçek detector değil."""
    grid_h = max(8, int(grid_w * 9 / 16))
    print(f"  hareket analizi ({grid_w}x{grid_h} izgara) ...", end="", flush=True)
    frames = extract_gray(proxy_path, grid_w, grid_h, fps)
    if frames.shape[0] < 3:
        print(" yetersiz kare")
        return [], []
    # arka plan: hareketli medyan yerine basit uzun ortalama
    bg = np.median(frames[::max(1, len(frames) // 60)], axis=0)
    rows, tracks, next_id = [], {}, 1
    for i in range(len(frames)):
        t = round(i / fps, 3)
        diff = np.abs(frames[i] - bg)
        thr = max(14.0, float(np.percentile(diff, 97)))
        mask = diff > thr
        boxes = [b for b in components(mask) if b[4] >= min_cells]
        boxes.sort(key=lambda b: -b[4])
        boxes = boxes[:12]
        # takip eşlemesi
        used, cur = set(), {}
        for (x1, y1, x2, y2, area) in boxes:
            nb = (x1 / grid_w, y1 / grid_h, x2 / grid_w, y2 / grid_h)
            best, bi = 0.0, None
            for tid, prev in tracks.items():
                if tid in used or t - prev["t"] > 1.2:
                    continue
                s = iou(nb, prev["box"])
                if s > best:
                    best, bi = s, tid
            if best > 0.18:
                tid = bi
            else:
                tid = next_id
                next_id += 1
            used.add(tid)
            cur[tid] = {"box": nb, "t": t}
            # kaba ızgara → yumuşatma için önceki kutuyla harmanla
            if tid in tracks:
                p = tracks[tid]["box"]
                nb = tuple(0.55 * a + 0.45 * b for a, b in zip(nb, p))
            ratio = (nb[3] - nb[1]) / max(1e-6, nb[2] - nb[0])
            cls = 0 if ratio > 1.15 else 1        # dikey → kişi, yatay → araç
            # DB semasiyla ayni: bbox_x, bbox_y, bbox_width, bbox_height (0-1)
            rows.append([t, tid, cls, round(min(.99, .55 + area / 220), 3),
                         round(nb[0], 4), round(nb[1], 4),
                         round(nb[2] - nb[0], 4), round(nb[3] - nb[1], 4)])
        for tid, v in cur.items():
            tracks[tid] = v
    # çok kısa track'leri ele (gürültü)
    span = {}
    for r in rows:
        s = span.setdefault(r[1], [r[0], r[0]])
        s[0] = min(s[0], r[0]); s[1] = max(s[1], r[0])
    keep = {tid for tid, (a, b) in span.items() if b - a >= 0.8}
    rows = [r for r in rows if r[1] in keep]
    print(f" ok ({len(rows)} kutu, {len(keep)} track)")
    return rows, [(tid, span[tid][0], span[tid][1]) for tid in sorted(keep)]


def motion_events(rows, duration, fps, start_dt):
    """Hareket yoğunluğundan aday olay aralıkları — Plan-1'in basit hali."""
    if not rows:
        return []
    bins = max(1, int(math.ceil(duration)))
    energy = np.zeros(bins)
    for r in rows:
        b = min(bins - 1, int(r[0]))
        energy[b] += r[6] * r[7]
    if energy.max() <= 0:
        return []
    norm = energy / energy.max()
    thr = max(0.22, float(np.percentile(norm, 78)))
    evs, i, n = [], 0, 0
    while i < bins:
        if norm[i] >= thr:
            j = i
            while j + 1 < bins and norm[j + 1] >= thr * 0.6:
                j += 1
            if j - i >= 1:
                n += 1
                score = round(float(norm[i:j+1].max()), 2)
                evs.append({
                    "id": f"MO-E{n}", "video_id": None,
                    "t_start": float(i), "t_end": float(j + 1),
                    "wall_start": (start_dt + timedelta(seconds=i)).strftime(
                        "%Y-%m-%dT%H:%M:%S+09:00"),
                    "wall_end": (start_dt + timedelta(seconds=j + 1)).strftime(
                        "%Y-%m-%dT%H:%M:%S+09:00"),
                    "type": "walk", "type_ko": "움직임", "type_tr": "Hareket",
                    "severity": "critical" if score > .85 else
                                ("warn" if score > .55 else "info"),
                    "color": "#f97316" if score > .85 else
                             ("#fbbf24" if score > .55 else "#64748b"),
                    "description": f"움직임 감지 구간 (강도 {int(score*100)}%) — "
                                   f"모션 기반 후보. VLM 서술 아님.",
                    "description_en": f"Motion candidate (intensity {int(score*100)}%)",
                    "score": score, "track_ids": [], "thumbnail": None,
                    "vlm_model": None, "vlm_latency_ms": 0,
                })
            i = j + 1
        else:
            i += 1
    return evs


# Kullanıcı videoları AYRI dosyada tutulur: gen_mock.py catalog.json'u her
# çalıştığında sıfırdan yazar, buraya dokunmaz.
USER_CATALOG = DATA / "catalog_user.json"


def load_catalog():
    return json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))


def load_user():
    if USER_CATALOG.exists():
        return json.loads(USER_CATALOG.read_text(encoding="utf-8"))
    return {"groups": []}


def save_user(u):
    # boş grupları at
    u["groups"] = [g for g in u["groups"] if g["cameras"]]
    USER_CATALOG.write_text(json.dumps(u, ensure_ascii=False, indent=1),
                            encoding="utf-8")


def cmd_list():
    rows = []
    for src, cat in (("mock", load_catalog()), ("user", load_user())):
        for g in cat["groups"]:
            for c in g["cameras"]:
                rows.append((c, g, src))
    print(f"{'ID':<8} {'GRUP':<7} {'AD':<12} {'DURUM':<11} {'SÜRE':>9}  KAYNAK")
    print("-" * 72)
    for c, g, src in rows:
        tag = "  ← eklendi" if src == "user" else ""
        print(f"{c['id']:<8} {g['name']:<7} {c['name']:<12} "
              f"{c['status']:<11} {c['duration']:>8}s  "
              f"{c['source_type']}{' proxy✓' if c.get('has_proxy') else ''}{tag}")


def cmd_remove(vid):
    u = load_user()
    found = False
    for g in u["groups"]:
        n = len(g["cameras"])
        g["cameras"] = [c for c in g["cameras"] if c["id"] != vid]
        found = found or len(g["cameras"]) != n
    if not found:
        print(f"{vid} kullanici katalogunda yok "
              f"(yerlesik mock videolari silinemez).")
        return
    save_user(u)
    for p in (DATA / f"video_{vid}.json",
              ASSETS / f"{vid.lower()}.mp4",
              ASSETS / "poster" / f"{vid}.jpg"):
        if p.exists():
            p.unlink()
    print(f"{vid} kaldirildi.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", nargs="?", help="video dosyasi")
    ap.add_argument("--id", help="video id (varsayilan CAM90+)")
    ap.add_argument("--name", help="kamera adi")
    ap.add_argument("--place", default="사용자 업로드", help="konum etiketi")
    ap.add_argument("--group", default="G9", help="grup id")
    ap.add_argument("--group-name", default="Area9")
    ap.add_argument("--start", help="gercek baslangic zamani ISO "
                                    "(orn 2025-05-20T09:00:00)")
    ap.add_argument("--motion", action="store_true",
                    help="hareket tabanli sozde-tespit uret")
    ap.add_argument("--max-width", type=int, default=1280)
    ap.add_argument("--force-encode", action="store_true",
                    help="remux mumkun olsa bile yeniden kodla "
                         "(1 sn GOP ve hassas seek icin)")
    ap.add_argument("--fps", type=float, help="proxy fps (varsayilan min(kaynak,15))")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--remove")
    a = ap.parse_args()

    if a.list:
        return cmd_list()
    if a.remove:
        return cmd_remove(a.remove)
    if not a.source:
        ap.error("kaynak video gerekli (veya --list / --remove)")

    src = Path(a.source)
    if not src.exists():
        raise SystemExit(f"Dosya yok: {src}")

    cat = load_catalog()
    user = load_user()
    existing = {c["id"] for src in (cat, user)
                for g in src["groups"] for c in g["cameras"]}
    vid = a.id
    if not vid:
        k = 90
        while f"CAM{k}" in existing:
            k += 1
        vid = f"CAM{k}"
    name = a.name or vid

    print(f"== {src.name} → {vid} ==")
    info = probe(src)
    print(f"  kaynak: {info['width']}x{info['height']} @{info['fps']}fps "
          f"{info['codec']} {info['pix_fmt']} · {info['duration']}s "
          f"· {info['size_mb']} MB")
    if info["codec"] in ("hevc", "h265", "vp9", "av1"):
        print(f"  ! kaynak kodek {info['codec']} — Chrome'da guvenilir degil, "
              f"proxy zorunlu")

    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / "poster").mkdir(exist_ok=True)
    proxy = ASSETS / f"{vid.lower()}.mp4"
    fps, mode = make_proxy(src, proxy, info, a.max_width, a.fps,
                           a.force_encode)
    pinfo = probe(proxy)

    sh(["ffmpeg", "-y", "-loglevel", "error", "-ss",
        str(max(0.1, pinfo["duration"] * .3)), "-i", str(proxy),
        "-frames:v", "1", "-q:v", "3", str(ASSETS / "poster" / f"{vid}.jpg")])

    start_iso = (a.start or datetime.now().replace(microsecond=0).isoformat())
    if not start_iso.endswith("+09:00"):
        start_iso = start_iso.split("+")[0] + "+09:00"
    start_dt = datetime.fromisoformat(start_iso.replace("+09:00", ""))
    end_iso = (start_dt + timedelta(seconds=pinfo["duration"])).strftime(
        "%Y-%m-%dT%H:%M:%S+09:00")

    rows, spans, events = [], [], []
    if a.motion:
        rows, spans = motion_detect(proxy, fps)
        events = motion_events(rows, pinfo["duration"], fps, start_dt)
        for e in events:
            e["video_id"] = vid

    objects = []
    for tid, t0, t1 in spans:
        objects.append({
            "id": f"{vid}-O{tid}", "kind": "motion", "video_id": vid,
            "camera": name, "camera_place": a.place, "group": a.group_name,
            "track_id": tid, "cls": "person",
            "crop": f"assets/poster/{vid}.jpg",
            "node_id": 90000 + tid, "ch": 0,
            "wall_time": (start_dt + timedelta(seconds=(t0 + t1) / 2)).strftime(
                "%Y-%m-%dT%H:%M:%S+09:00"),
            "t_first": round(t0, 2), "t_last": round(t1, 2),
            "conf": 0.6, "attrs": {},
            "label": f"모션 트랙 #{tid}",
        })

    cam = {
        "id": vid, "name": name, "place_ko": a.place,
        "node_id": 90000, "ch": 0,
        "status": "completed", "source_type": "uploaded",
        "has_proxy": True,
        "start_time": start_iso, "end_time": end_iso,
        "duration": pinfo["duration"], "fps": pinfo["fps"],
        "width": pinfo["width"], "height": pinfo["height"],
        "codec": "h264", "src_codec": info["codec"],
        "bitrate_kbps": pinfo["bitrate_kbps"],
        "file_size_mb": round(proxy.stat().st_size / 1048576, 1),
        "gop_sec": round(probe_gop(proxy) or 1.0, 2), "faststart": True,
        "proxy_mode": mode,
        "group_id": a.group, "group_name": a.group_name,
        "user_upload": True,
        "original_path": str(src),
    }

    payload = {
        "video": cam,
        "summary": {
            "video_id": vid, "duration": pinfo["duration"],
            "summary_duration": round(sum(e["t_end"] - e["t_start"] for e in events), 1),
            "ratio": round(sum(e["t_end"] - e["t_start"] for e in events)
                           / max(1, pinfo["duration"]) * 100, 1),
            "main_objects": [{"cls": "person", "ko": "모션 트랙",
                              "count": len(spans)}],
            "event_count": len(events),
            "generated_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+09:00"),
            "engine_version": "motion-fallback 0.1 (AI 엔진 아님)",
            "models": {"detector": "frame-difference (pseudo)",
                       "tracker": "greedy IoU (pseudo)"},
            "segments": [], "prompt_used": None,
        },
        "events": events, "objects": objects,
        "detections": {
            "fps": fps, "coord": "normalized_xywh",
            "keys": ["t", "track_id", "cls", "conf",
                     "bbox_x", "bbox_y", "bbox_width", "bbox_height"],
            "cls_map": {"0": "person", "1": "vehicle"}, "rows": rows,
        },
        "segments": {"seg_len": 2.4, "count": 0,
                     "concepts": CONCEPTS, "vectors": []},
    }
    (DATA / f"video_{vid}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    grp = next((g for g in user["groups"] if g["id"] == a.group), None)
    if not grp:
        grp = {"id": a.group, "name": a.group_name,
               "name_ko": "사용자 업로드", "desc": "add_video.py ile eklenen 영상",
               "user_group": True, "cameras": []}
        user["groups"].append(grp)
    grp["cameras"] = [c for c in grp["cameras"] if c["id"] != vid]
    grp["cameras"].append(cam)
    save_user(user)

    print(f"\n  eklendi: {a.group_name} › {name}  ({vid})")
    gop = probe_gop(proxy)
    print(f"  proxy  : {proxy}")
    print(f"           {mode} · h264 · faststart ✓ · "
          f"GOP ~{gop:.1f}s" if gop else f"           {mode} · h264")
    if a.motion:
        print(f"  hareket: {len(rows)} kutu · {len(spans)} track · "
              f"{len(events)} aday olay")
        print(f"  ! Bunlar Object Detection degil, kare farki. Sinif tahmini "
              f"(kisi/arac) sadece en-boy oranindan.")
    else:
        print("  ipucu  : --motion ile hizali bbox overlay'i de gorebilirsin")
    print(f"\n  Sunucuyu yeniden baslat, sonra ac:")
    print(f"    http://127.0.0.1:8000/#/single/{vid}")


if __name__ == "__main__":
    main()
