#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxy_cache.py — gerçek backend'deki videolar için tarayıcı proxy'si üretir
==========================================================================

Sorun
-----
VMS operasyon görüntüleyicisinin kayıtları **AVI konteyner + MPEG-4 Part 2**
kodeğinde. İkisi de tarayıcıda oynatılamaz:

  * AVI            → hiçbir tarayıcının <video> desteği yok
  * MPEG-4 Part 2  → Chrome/Edge/Firefox hiçbir zaman desteklemedi

Analiz tarafı etkilenmiyor (ffmpeg/NVDEC bu dosyaları sorunsuz açıyor,
detection_result_count bunu kanıtlıyor) — kırılan tek şey tarayıcıda oynatma.

Çözüm (geçici)
--------------
Backend proxy üretimini ekleyene kadar bu işi biz yapıyoruz:

    GET /video/{id}/stream  →  indir  →  ffmpeg  →  web/assets/proxy/{id}.mp4

Üretilen dosyanın üç garantisi var, üçü de oynatıcı için şart:

    MP4 + H.264 + yuv420p   → tarayıcı açabilir
    -movflags +faststart    → moov atom başa gelir, indirme bitmeden oynar
    1 saniyelik GOP         → timeline'da tıklanan yere hassas seek

Backend `playback_uri` alanını eklediğinde bu araç gereksiz hale gelir;
frontend tarafında değişecek tek yer `live.js → streamUrl()`.

Kullanım
--------
    python tools/proxy_cache.py --all           # tüm videolar
    python tools/proxy_cache.py 1 2 3           # sadece bu id'ler
    python tools/proxy_cache.py --all --force   # önbelleği yok say
    python tools/proxy_cache.py --list          # durum tablosu

ffmpeg PATH'te olmalı.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROXY_DIR = ROOT / "web" / "assets" / "proxy"
INDEX = PROXY_DIR / "index.json"

API = os.environ.get("DVSUMMARY_API", "http://172.20.14.161:8001")

# Tarayıcının doğrudan oynatabildiği kodekler. Bu listedeyse ve konteyner
# MP4 ise yeniden kodlamaya gerek yok — sadece remux yeterli.
BROWSER_CODECS = ("h264", "avc1", "vp9", "vp8", "av1")


# --------------------------------------------------------------- yardımcı ---

def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", **kw)


def need(tool):
    if not shutil.which(tool):
        sys.exit(f"HATA: '{tool}' PATH'te bulunamadı.")


def api_get(path):
    url = API.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HATA: {url} → HTTP {e.code}")
    except Exception as e:
        sys.exit(f"HATA: {url} → {e}\n"
                 f"      API adresi doğru mu? DVSUMMARY_API ile değiştirebilirsin.")


def load_index():
    if INDEX.is_file():
        try:
            return json.loads(INDEX.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_index(ix):
    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(ix, ensure_ascii=False, indent=2),
                     encoding="utf-8")


def probe(path):
    r = sh(["ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", str(path)])
    if r.returncode != 0:
        return None
    j = json.loads(r.stdout)
    vs = next((s for s in j["streams"] if s["codec_type"] == "video"), None)
    if not vs:
        return None
    num, den = (vs.get("r_frame_rate") or "25/1").split("/")
    fps = float(num) / float(den or 1)
    return {
        "codec": vs.get("codec_name", "?"),
        "pix_fmt": vs.get("pix_fmt", "?"),
        "width": int(vs.get("width") or 0),
        "height": int(vs.get("height") or 0),
        "fps": round(fps, 3),
        "duration": round(float(j["format"].get("duration") or 0), 2),
        "container": (j["format"].get("format_name") or "").split(",")[0],
        "size_mb": round(int(j["format"].get("size") or 0) / 1048576, 1),
    }


# ------------------------------------------------------------------ indir ---

def download(video_id, dst):
    """Orijinali bir kere indirir. Range kullanmıyoruz — tam dosya lazım."""
    url = f"{API.rstrip('/')}/video/{video_id}/stream"
    tmp = dst.with_suffix(dst.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            with open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pctv = done * 100 // total
                        print(f"\r  indiriliyor … %{pctv:3d} "
                              f"({done/1048576:.0f}/{total/1048576:.0f} MB)",
                              end="", flush=True)
        print()
    except urllib.error.HTTPError as e:
        tmp.unlink(missing_ok=True)
        print(f"  ! HTTP {e.code} — atlandı")
        return False
    except Exception as e:
        tmp.unlink(missing_ok=True)
        print(f"  ! indirme hatası: {e}")
        return False
    tmp.replace(dst)
    return True


# -------------------------------------------------------------- transcode ---

def decode_errors(path, seconds=20):
    """Üretilen dosyanın bir penceresini gerçekten çözer.

    ffmpeg remux'a 0 dönebilir ama çıkan dosya tarayıcıda oynamayabilir:
    AVI içindeki H.264 bazen data partitioning (Extended profile) kullanıyor
    ya da çift/geri giden DTS taşıyor. Chrome böyle dosyada seek edince kareyi
    gösteriyor, oynatmaya başlamıyor — yani sessizce bozuk. Bunu ancak
    çözerken görebiliyoruz, konteyner bilgisine bakarak değil.
    """
    r = sh(["ffmpeg", "-v", "error", "-i", str(path), "-t", str(seconds),
            "-f", "null", "-"])
    return (r.stderr or "").strip()


def transcode(src, dst, info, api_codec=None):
    """Tarayıcı dostu MP4 üretir.

    Kaynak zaten H.264 + yuv420p ise yalnızca konteyner değiştirilir (remux),
    yeniden kodlama yapılmaz: kalite kaybı sıfır, süre saniyeler mertebesinde.
    VMS'ten gelen mpeg4 kayıtlarda bu yol devreye girmez, tam kodlama yapılır.

    Bilinmeyen FourCC
    -----------------
    AVI konteynerin kodek etiketi 4 harflik bir FourCC. HEVC'nin AVI içinde
    standart bir FourCC'si YOK (AVI 1992, HEVC 2013), dolayısıyla kaydı üreten
    yazılım ne yazdıysa o duruyor ve ffmpeg çözemiyor:

        Decoder (codec none) not found for input stream #0:0

    Bu durumda decoder'ı `-vcodec` ile dayatıyoruz — kodek adını zaten
    backend'in `video.codec` alanından biliyoruz.
    """
    fps = info["fps"] if info and info["fps"] > 0 else 25
    gop = max(1, int(round(fps)))          # 1 saniyelik GOP → hassas seek

    probed = (info or {}).get("codec")
    unknown = probed in (None, "?", "none")

    remux = (not unknown and probed in ("h264", "avc1")
             and info["pix_fmt"] in ("yuv420p", "yuvj420p"))

    if remux:
        print("  remux (yeniden kodlama YOK) …", end="", flush=True)
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
               "-c", "copy", "-movflags", "+faststart", str(dst)]
        if sh(cmd).returncode == 0:
            err = decode_errors(dst)
            if not err:
                print(f" ok ({dst.stat().st_size/1048576:.1f} MB)")
                return "remux"
            print(" bitstream sorunlu, yeniden kodlanacak")
            print(f"    {err.splitlines()[0][:110]}")
        else:
            print(" başarısız, yeniden kodlamaya düşülüyor")

    # Denenecek girdi seçenekleri: önce olduğu gibi, olmazsa decoder dayatarak.
    variants = [([], "")]
    if api_codec and api_codec not in ("?", "none"):
        forced = (["-vcodec", api_codec], f", decoder={api_codec} dayatıldı")
        variants = [forced, ([], "")] if unknown else [([], ""), forced]

    last_err = ""
    for in_opts, note in variants:
        print(f"  yeniden kodlanıyor (h264, GOP {gop}{note}) …",
              end="", flush=True)
        cmd = (["ffmpeg", "-y", "-loglevel", "error"] + in_opts
               + ["-i", str(src),
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                  "-pix_fmt", "yuv420p",
                  "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
                  "-vsync", "cfr", "-r", str(round(fps, 3)),
                  "-movflags", "+faststart",
                  "-an",                  # CCTV kaydında ses yok/gereksiz
                  str(dst)])
        r = sh(cmd)
        if r.returncode == 0:
            print(f" ok ({dst.stat().st_size/1048576:.1f} MB)")
            return "encode"
        last_err = (r.stderr or "").strip()
        print(" başarısız")

    print("  ! kodlanamadı")
    print("   " + last_err[:400])
    return None


# ------------------------------------------------------------------- akış ---

def src_sig(meta):
    """Kaynağın kimliği. Backend sıfırlanıp id'ler yeniden kullanıldığında
    `1.mp4` hâlâ eski videoyu gösteriyordu — önbellek yalnızca id'ye
    bakıyordu. guid_id kayıt yeniden yaratılınca değişir, bu yüzden asıl
    ölçüt o; yoksa dosya boyutu + süreye düşüyoruz."""
    meta = meta or {}
    g = meta.get("guid_id")
    if g:
        return str(g)
    if meta.get("video_file_size") or meta.get("duration_ms"):
        return f"{meta.get('video_file_size')}:{meta.get('duration_ms')}"
    return None


def stale_reason(rec, meta):
    """Önbellekteki kayıt bu videoya mı ait? Değilse sebebini döndür."""
    sig, old = src_sig(meta), rec.get("src_sig")
    if old is not None:
        return None if old == sig else "kaynak değişmiş (id yeniden kullanılmış)"

    # İmzasız eski kayıt: süreyi karşılaştır. Remux de encode de süreyi
    # korumalı, sapma varsa proxy başka bir videodan kalmış demektir.
    want = (meta or {}).get("duration_ms")
    got = rec.get("duration")
    if want and got:
        if abs(got - want / 1000) > max(2.0, want / 1000 * 0.05):
            return (f"süre tutmuyor (backend {want/1000:.1f}s, "
                    f"proxy {got:.1f}s)")
    return None


def build(video_id, meta, force=False, keep_original=False):
    ix = load_index()
    key = str(video_id)
    out = PROXY_DIR / f"{video_id}.mp4"

    if out.is_file() and not force and key in ix:
        why = stale_reason(ix[key], meta)
        if why:
            print(f"== video {video_id}: {why} → yeniden üretiliyor")
            force = True                    # .orig da yeniden indirilsin
        else:
            print(f"== video {video_id}: önbellekte, atlanıyor "
                  f"({out.stat().st_size/1048576:.1f} MB)")
            return ix[key]

    meta = meta or {}
    name = meta.get("name") or f"video {video_id}"
    print(f"== video {video_id} — {name}")

    # Rezerve edilmiş ama dosyası yüklenmemiş kayıtlar: /video/{id}/stream 404
    # döner. Boşuna indirmeye çalışma.
    uri = meta.get("storage_uri") or ""
    if str(meta.get("status", "")).upper() == "RESERVED" or uri.endswith(".pending"):
        print("  rezerve — dosya henüz yüklenmemiş, atlanıyor")
        return None

    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    orig = PROXY_DIR / f"{video_id}.orig"
    if not orig.is_file() or force:
        if not download(video_id, orig):
            return None

    api_codec = meta.get("codec")
    info = probe(orig)
    if info:
        shown = info["codec"] if info["codec"] not in ("?", "none") \
            else f"? (API: {api_codec or 'bilinmiyor'})"
        print(f"  kaynak: {info['container']} / {shown} "
              f"{info['pix_fmt']} {info['width']}x{info['height']} "
              f"@{info['fps']}fps · {info['duration']}s · {info['size_mb']} MB")
        if info["codec"] in ("?", "none"):
            print("  ! ffprobe kodeği tanıyamadı — AVI'deki FourCC etiketi "
                  "standart dışı")
        elif info["codec"] not in BROWSER_CODECS:
            print(f"  ! {info['codec']} tarayıcıda oynatılamaz → proxy zorunlu")
        if info["container"] not in ("mov", "mp4", "matroska", "webm"):
            print(f"  ! {info['container']} konteyner tarayıcıda açılmaz "
                  f"→ proxy zorunlu")
    else:
        print("  ! ffprobe okuyamadı — yine de kodlamayı deniyorum")

    mode = transcode(orig, out, info, api_codec)
    if not mode:
        return None

    pinfo = probe(out) or {}
    rec = {
        "video_id": video_id,
        "name": name,
        "src_sig": src_sig(meta),
        "url": f"assets/proxy/{video_id}.mp4",
        "mode": mode,
        "src_codec": (info or {}).get("codec"),
        "src_container": (info or {}).get("container"),
        "codec": pinfo.get("codec"),
        "width": pinfo.get("width"),
        "height": pinfo.get("height"),
        "fps": pinfo.get("fps"),
        "duration": pinfo.get("duration"),
        "size_mb": round(out.stat().st_size / 1048576, 1),
    }
    ix[key] = rec
    save_index(ix)

    if not keep_original:
        orig.unlink(missing_ok=True)
    return rec


def cmd_list():
    ix = load_index()
    videos = api_get("/video")
    print(f"{'id':>4}  {'ad':<28} {'orijinal':<18} {'proxy':<10} durum")
    print("-" * 78)
    for v in sorted(videos, key=lambda x: x["id"]):
        rec = ix.get(str(v["id"]))
        src = f"{v.get('codec') or '—'}"
        if rec:
            why = stale_reason(rec, v)
            state = (f"! BAYAT — {why}" if why
                     else f"✓ {rec['size_mb']} MB · {rec['mode']}")
            pc = rec.get("codec") or "?"
        else:
            state = "— yok"
            pc = "—"
        print(f"{v['id']:>4}  {(v.get('name') or '')[:28]:<28} "
              f"{src:<18} {pc:<10} {state}")


def main():
    ap = argparse.ArgumentParser(
        description="Gerçek backend'deki videolar için tarayıcı proxy'si üretir")
    ap.add_argument("ids", nargs="*", type=int, help="video id'leri")
    ap.add_argument("--all", action="store_true", help="tüm videolar")
    ap.add_argument("--list", action="store_true", help="durum tablosu")
    ap.add_argument("--force", action="store_true", help="önbelleği yok say")
    ap.add_argument("--keep-original", action="store_true",
                    help="indirilen orijinali silme (hata ayıklama)")
    a = ap.parse_args()

    if a.list:
        return cmd_list()

    need("ffmpeg")
    need("ffprobe")

    videos = {v["id"]: v for v in api_get("/video")}
    if a.all:
        ids = sorted(videos)
    elif a.ids:
        ids = a.ids
    else:
        return ap.print_help()

    ok = 0
    for vid in ids:
        if vid not in videos:
            print(f"== video {vid}: API'de yok, atlanıyor")
            continue
        if build(vid, videos[vid], a.force, a.keep_original):
            ok += 1

    print(f"\n{ok}/{len(ids)} proxy hazır → {PROXY_DIR}")
    if ok:
        print("Sunucu çalışıyorsa yeniden başlatmaya gerek yok; "
              "arayüzü yenilemen yeterli.")


if __name__ == "__main__":
    main()
