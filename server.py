#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
지능형 영상 요약 플랫폼 — arayüz sunucusu
========================================

Üç iş yapar, üçü de küçük:

  1. `web/` altındaki statik arayüzü sunar (HTTP Range dahil — video seek
     gerçekten çalışsın diye).
  2. `/live/*` isteklerini gerçek DVSummary backend'ine iletir. Tarayıcı
     oraya doğrudan gidemiyor: farklı origin, backend'de CORS başlığı yok.
  3. `/api/merge/*` — yüklenen parçaları ffmpeg ile TEK bir MP4'e birleştirir
     ve backend'e tek video olarak akıtır. Bu iş bize ait, backend'de yok.

Bağımlılık yok — yalnızca Python stdlib (+ birleştirme için ffmpeg).

Mock veri katmanı KALDIRILDI (2026-08-27). Eskiden bu dosya backend'in
davranışsal ikizini de barındırıyordu; gerçek API hazır olduğu için gereksiz
kaldı. Tam çalışır hâli `archive/mock/` altında duruyor.

Çalıştırma:
    python server.py                    # http://127.0.0.1:8000
    python server.py --port 9000
    python server.py --live-body -1     # backend cevaplarının tamamını yaz
    python server.py --log-file live.log  # tam trafiği dosyaya yaz
    DVSUMMARY_API=http://host:port python server.py
"""

import argparse
import io
import json
import mimetypes
import os
import re
import sys
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"

SERVER_NAME = "vsum-ui/1.0"
ARGS = None

# --log-file ile açılan dosya tanıtıcısı. Terminalden farkı: süzgeç
# uygulanmıyor ve gövdeler kırpılmıyor — akıp giden bir hatayı sonradan
# aramanın tek yolu bu.
LOG = None

# Gerçek DVSummary backend'i. Tarayıcı buraya DOĞRUDAN istek atamaz (CORS),
# bu yüzden /live/* isteklerini sunucu tarafında iletiyoruz.
LIVE_BASE = os.environ.get("DVSUMMARY_API", "http://172.20.14.161:8001")

# Windows registry .js uzantısını "text/plain" diye kaydedebiliyor ve
# mimetypes bunu okuyor. Tarayıcı ES modüllerinde katı MIME kontrolü yapar:
#   "Expected a JavaScript-or-Wasm module script but the server responded
#    with a MIME type of text/plain"
# Tahmine bırakmayıp açıkça bildiriyoruz.
for _ext, _mime in (
    (".js", "text/javascript"),
    (".mjs", "text/javascript"),
    (".css", "text/css"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
    (".mp4", "video/mp4"),
    (".wasm", "application/wasm"),
):
    mimetypes.add_type(_mime, _ext)

# ---------------------------------------------------------------------------
# Veri yükleme
# ---------------------------------------------------------------------------


def now_iso():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S+09:00")


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S+09:00")


MERGE_ROOT = ROOT / ".merge"
MERGES = {}
MERGE_LOCK = threading.Lock()


def run_ff(cmd, timeout=1800):
    """ffmpeg/ffprobe çalıştırır; (returncode, stdout, stderr) döner."""
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r.returncode, r.stdout, r.stderr


def probe_video(path):
    """Tek videonun akış özellikleri. Okunamazsa None."""
    code, out, _ = run_ff([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_streams", "-show_format", str(path)], timeout=60)
    if code != 0:
        return None
    try:
        d = json.loads(out)
    except Exception:
        return None
    vs = next((x for x in d.get("streams", [])
               if x.get("codec_type") == "video"), None)
    if not vs:
        return None
    fmt = d.get("format", {})
    dur = fmt.get("duration")
    return {
        "codec": vs.get("codec_name"),
        # `avi`, `mov,mp4,m4a,...` gibi. Kopyalama yolunun uygun olup
        # olmadığına bununla karar veriyoruz.
        "container": (fmt.get("format_name") or "").split(",")[0],
        # AVI'nin 4 harflik kodek etiketi. HEVC'nin AVI içinde standart bir
        # FourCC'si YOK (AVI 1992, HEVC 2013), o yüzden kaydı üreten yazılım
        # ne yazdıysa o duruyor ve ffprobe `codec_name`i "none" bırakıyor.
        # Çözücüyü bu etiketten tahmin ediyoruz.
        "tag": (vs.get("codec_tag_string") or "").strip(),
        "width": vs.get("width"),
        "height": vs.get("height"),
        "pix_fmt": vs.get("pix_fmt"),
        "fps": vs.get("r_frame_rate"),
        "has_audio": any(x.get("codec_type") == "audio"
                         for x in d.get("streams", [])),
        "duration": float(dur) if dur else None,
    }


FOURCC_DECODER = {
    "HEVC": "hevc", "H265": "hevc", "hvc1": "hevc", "hev1": "hevc",
    "HM10": "hevc", "HM91": "hevc",
    "H264": "h264", "h264": "h264", "X264": "h264", "x264": "h264",
    "avc1": "h264", "AVC1": "h264", "DAVC": "h264",
    "XVID": "mpeg4", "DIVX": "mpeg4", "DX50": "mpeg4", "MP4V": "mpeg4",
    "MJPG": "mjpeg", "mjpa": "mjpeg",
}

# Etiket de tanınmazsa sırayla denenecek çözücüler. VMS kayıtlarında en sık
# HEVC çıkıyor, o yüzden başta.
DECODER_GUESSES = ("hevc", "h264", "mpeg4", "mjpeg")


def unknown_codec(pr):
    return (pr or {}).get("codec") in (None, "", "?", "none")


def decoder_candidates(pr):
    """Bilinmeyen kodek için denenecek çözücü listesi."""
    tag = (pr or {}).get("tag") or ""
    first = FOURCC_DECODER.get(tag) or FOURCC_DECODER.get(tag.upper())
    out = [first] if first else []
    out += [d for d in DECODER_GUESSES if d != first]
    return out


def decode_errors(path, seconds=20):
    """Üretilen dosyayı gerçekten çözer.

    ffmpeg 0 dönüp de oynatılamayan dosya üretebiliyor (VMS kayıtlarındaki
    H.264 bazen çift DTS ya da eksik parametre seti taşıyor). Konteyner
    bilgisine bakarak anlaşılmıyor; çözmek gerekiyor.
    """
    r = run_ff(["ffmpeg", "-v", "error", "-i", str(path),
                "-t", str(seconds), "-f", "null", "-"])
    return (r[2] or "").strip()


def normalize_part(src, dst, w, h, trim, probe=None):
    """Bir parçayı temiz, tek biçimli bir MP4'e çevirir.

    `-ss` GİRDİDEN SONRA. Girdi tarafındaki `-ss` çözücüyü akışın ortasından
    başlatıyor ve VMS kayıtlarında parametre setleri yalnızca başta olduğu
    için şu hatayı veriyordu:

        non-existing PPS 0 referenced
        decode_slice_header error
        no frame!

    Çıktı tarafındaki `-ss` baştan çözüp istenen aralığı yazıyor: daha yavaş
    ama doğru. Kırpma zaten kısa atlamalar olduğu için fark önemsiz.
    """
    def attempt(force):
        cmd = ["ffmpeg", "-y", "-loglevel", "error"]
        if force:
            cmd += ["-vcodec", force]
        cmd += ["-i", str(src)]
        if trim:
            cmd += ["-ss", f"{trim[0]:.3f}", "-t", f"{trim[1] - trim[0]:.3f}"]
        cmd += ["-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                       f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
                "-an", str(dst)]
        return run_ff(cmd)

    if not unknown_codec(probe):
        return attempt(None)

    # Kodek tanınmadı: `Decoder (codec none) not found for input stream #0:0`.
    # Çözücüyü FourCC'den tahmin edip dayatıyoruz, tutmazsa sırayla
    # denenenlere geçiyoruz. Aynı yöntem proxy_cache.py'de de var.
    tried = decoder_candidates(probe)
    last = (1, "", "")
    for dec in tried:
        last = attempt(dec)
        if last[0] == 0:
            return last
    tag = (probe or {}).get("tag") or "?"
    detail = ("kodek tanınamadı (FourCC '%s'); denenen çözücüler: %s\n%s"
              % (tag, ", ".join(tried), last[2] or ""))
    return (last[0], last[1], detail)


def black_part(dst, w, h, seconds):
    """Siyah dolgu — normalize edilmiş parçalarla aynı parametrelerde."""
    return run_ff(["ffmpeg", "-y", "-loglevel", "error",
                   "-f", "lavfi", "-t", f"{seconds:.3f}",
                   "-i", f"color=c=black:s={w}x{h}:r=30",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                   "-pix_fmt", "yuv420p",
                   "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
                   "-an", str(dst)])


def concat_copy(files, out_path):
    """Aynı parametrelere sahip parçaları kayıpsız birleştirir."""
    lst = out_path.parent / "concat.txt"
    lst.write_text("".join("file '%s'\n" % f.as_posix() for f in files),
                   encoding="utf-8")
    return run_ff(["ffmpeg", "-y", "-loglevel", "error",
                   "-f", "concat", "-safe", "0", "-i", str(lst),
                   "-c", "copy", "-movflags", "+faststart", str(out_path)])


def merge_videos(parts, out_path, trims=None, pads=None):
    """parts: [Path] sırayla. (mode, warnings) döner, hata olursa RuntimeError.

    `trims`: parça başına (in_sec, out_sec) ya da None. Çakışan kayıtlarda
    kullanıcının timeline'da belirlediği kırpma noktaları buradan geliyor —
    yoksa concat dosyaları tam boyuyla birleştirir ve arayüzdeki "çakışma
    kırpıldı" uyarısı gerçeği yansıtmaz.

    Kırpma varken stream copy hâlâ mümkün (concat demuxer'ın inpoint/outpoint
    yönergeleri) ama kesim ANAHTAR KAREYE yuvarlanır; kare hassasiyeti
    gerekiyorsa yeniden kodlama yolu kullanılır.
    """
    probes = [probe_video(p) for p in parts]
    bad = [parts[i].name for i, pr in enumerate(probes) if pr is None]
    if bad:
        raise RuntimeError("ffprobe okuyamadı: " + ", ".join(bad))

    if trims is None:
        trims = [None] * len(parts)
    # Kırpmayı dosyanın gerçek süresine sıkıştır — arayüz tahminî süreyle
    # çalışmış olabilir.
    norm = []
    for pr, tr in zip(probes, trims):
        dur = pr.get("duration") or 0
        if not tr:
            norm.append(None)
            continue
        a = max(0.0, float(tr[0] or 0))
        b = float(tr[1]) if tr[1] is not None else dur
        if dur:
            b = min(b, dur)
        if b - a <= 0.04:            # bir karelik pencereden küçükse yok say
            norm.append(None)
            continue
        norm.append(None if (a <= 0.001 and (not dur or b >= dur - 0.001))
                    else (a, b))
    trims = norm
    trimmed = any(t is not None for t in trims)

    # Siyah dolgu: bir parçayı VLM örnekleme penceresine oturtmak için
    # ÖNÜNE eklenen boş süre. Gerçek kare üretmek gerekiyor — concat boşluk
    # kavramı bilmiyor, sadece arka arkaya ekler.
    pads = [max(0.0, float(x or 0)) for x in (pads or [0] * len(parts))]
    padded = any(p > 0.01 for p in pads)

    warnings = []
    first = probes[0]
    same = all(
        pr["codec"] == first["codec"]
        and pr["width"] == first["width"]
        and pr["height"] == first["height"]
        and pr["pix_fmt"] == first["pix_fmt"]
        for pr in probes)
    # Parçaların biri sessiz biri sesliyse stream copy'de ses akışı kayar.
    audio = [pr["has_audio"] for pr in probes]
    if same and len(set(audio)) > 1:
        same = False
        warnings.append("Audio layout differs between parts — re-encoding")

    if not same:
        sizes = {(pr["width"], pr["height"]) for pr in probes}
        if len(sizes) > 1:
            warnings.append(
                f"Resolutions differ {sorted(sizes)} — scaling all to "
                f"{first['width']}x{first['height']}")

    if same and any(unknown_codec(pr) for pr in probes):
        # Kodek tanınmıyorsa stream copy MP4'e tanımsız bir FourCC yazar ve
        # dosya hiçbir oynatıcıda açılmaz. Doğrudan yeniden kodlamaya.
        same = False
        warnings.append("Codec not recognised by ffprobe — re-encoding")

    if same and any(pr.get("container") == "avi" for pr in probes):
        # AVI'den MP4'e stream copy pratikte HER ZAMAN bozuk çıkıyor: AVI,
        # H.264 parametre setlerini (SPS/PPS) akış içinde taşımıyor ve
        # kopyalarken kayboluyorlar; çıkan dosya "non-existing PPS 0" verip
        # çözülemiyor. Denemek 86 MB'lık dosyada birkaç saniye kopyalama +
        # 20 saniye doğrulama demekti; sonuç zaten hep yeniden kodlama.
        # Baştan doğru yola gidiyoruz.
        same = False
        warnings.append("AVI source — stream copy is not reliable, "
                        "re-encoding")

    if padded and same:
        # Dolgu karelerinin kodlama parametreleri kaynakla birebir tutmadığı
        # sürece stream copy bozuk çıkar; bu yolu denemek yerine doğrudan
        # yeniden kodlamaya geçiyoruz.
        same = False
        warnings.append("Black padding requires re-encoding")

    if same:
        # concat demuxer + stream copy: en hızlı ve kayıpsız yol
        lst = out_path.parent / "concat.txt"
        body = ""
        for p, tr in zip(parts, trims):
            body += f"file '{p.as_posix()}'\n"
            if tr:
                body += f"inpoint {tr[0]:.3f}\noutpoint {tr[1]:.3f}\n"
        lst.write_text(body, encoding="utf-8")
        if trimmed:
            warnings.append(
                "Trimmed with stream copy — cuts snap to the nearest keyframe")
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-f", "concat", "-safe", "0", "-i", str(lst),
               "-c", "copy", "-movflags", "+faststart", str(out_path)]
        code, _, errtxt = run_ff(cmd)
        if code == 0:
            err = decode_errors(out_path)
            if not err:
                return "copy", warnings
            # ffmpeg 0 döndü ama çıkan dosya çözülemiyor: AVI içindeki H.264
            # parametre setleri kopyalanınca kaybolabiliyor. Sessizce bozuk
            # dosya vermektense yeniden kodlamaya düşüyoruz.
            warnings.append("Stream copy produced an undecodable file "
                            "— re-encoding")
        else:
            warnings.append("Stream copy failed — falling back to re-encoding")

    # --- İKİ AŞAMALI YENİDEN KODLAMA ---------------------------------------
    # Önceki hâli tek bir `filter_complex` ile bütün parçaları aynı anda
    # okuyordu ve kırpma GİRDİ tarafında (`-ss` … `-i`) yapılıyordu. VMS
    # kayıtlarında bu şu hatayı veriyor:
    #
    #     non-existing PPS 0 referenced
    #     decode_slice_header error / no frame!
    #
    # Sebep: girdi tarafındaki `-ss` çözücüyü akışın ortasından başlatıyor,
    # parametre setleri ise yalnızca dosyanın başında. Büyük dosyalarda
    # çakışma kırpması daha sık devreye girdiği için hata orada görünüyordu.
    #
    # Şimdi her parça TEK BAŞINA, baştan çözülerek normalize ediliyor
    # (kırpma çıktı tarafında), sonra hepsi kayıpsız birleştiriliyor. Ek
    # maliyet yalnızca atlanan kısmın da çözülmesi; zaten yeniden
    # kodlanacaktı.
    # Kodek tanınmayan dosyada ffprobe boyutu da veremeyebiliyor; boyutu
    # bilinen ilk parçaya, o da yoksa 1280x720'ye düşüyoruz. Aksi hâlde
    # `scale=None:None` ile ffmpeg anlamsız bir hata veriyor.
    sized = next((pr for pr in probes if pr.get("width") and pr.get("height")),
                 None)
    w = (sized or {}).get("width") or 1280
    h = (sized or {}).get("height") or 720
    work = out_path.parent / "norm"
    work.mkdir(parents=True, exist_ok=True)
    normed = []
    for i, (src, tr, pd, pr) in enumerate(zip(parts, trims, pads, probes)):
        if pd > 0.01:
            blk = work / f"pad{i}.mp4"
            code, _, errtxt = black_part(blk, w, h, pd)
            if code != 0:
                raise RuntimeError("black padding: "
                                   + (errtxt or "ffmpeg hatası").strip()[:300])
            normed.append(blk)
        dst = work / f"part{i}.mp4"
        code, _, errtxt = normalize_part(src, dst, w, h, tr, pr)
        if code != 0:
            raise RuntimeError(f"{src.name}: "
                               + (errtxt or "ffmpeg hatası").strip()[:300])
        normed.append(dst)

    code, _, errtxt = concat_copy(normed, out_path)
    if code != 0:
        raise RuntimeError((errtxt or "concat hatası").strip()[:400])
    err = decode_errors(out_path)
    if err:
        raise RuntimeError("Birleşik dosya çözülemiyor: " + err.splitlines()[0][:200])
    shutil.rmtree(work, ignore_errors=True)
    warnings.append("Audio was dropped from the merge")
    return "reencode", warnings


class BoundedReader:
    """İstek gövdesini tam `remaining` bayt okuyup EOF veren sarmalayıcı.

    Ham `self.rfile`'ı urllib'e vermek olmuyor: http.client dosya benzeri
    gövdeyi boş chunk gelene kadar okur, ama keep-alive soketi gövde bitince
    EOF vermez — sonraki `read()` bir sonraki isteği bekleyerek bloke olur.
    Burada sayacı biz tutuyoruz ve gövde bitince b"" dönüyoruz.
    """

    def __init__(self, fp, length):
        self.fp = fp
        self.remaining = length

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        want = self.remaining if size is None or size < 0 \
            else min(size, self.remaining)
        chunk = self.fp.read(want)
        self.remaining -= len(chunk)
        return chunk


class Handler(BaseHTTPRequestHandler):
    # `live()` her istekte kendi değerini koyuyor; buradaki yalnızca
    # `_emit` o çağrıdan önce kullanılırsa diye güvenli varsayılan.
    _tty = True

    protocol_version = "HTTP/1.1"
    server_version = SERVER_NAME

    def log_message(self, fmt, *a):
        if ARGS.verbose:
            print(f"  {self.address_string()} {fmt % a}")

    def handle_one_request(self):
        """Tarayıcı video isteğini yarıda kesince socket hatası fırlıyor.

        Chrome seek yapınca veya sekmeyi kapatınca açık Range isteğini iptal
        eder; bu tamamen normaldir ama socketserver her seferinde ekrana
        yığın izi basıyor ve gerçek hataları görünmez kılıyor.
        """
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    # -- yardımcılar --------------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")

    def jsend(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def err(self, code, msg, detail=None):
        self.jsend({"error": msg, "detail": detail, "status": code}, code)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def do_GET(self):
        self.route("GET")

    # -- yönlendirme --------------------------------------------------------
    def route(self, method):
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if path.startswith("/live/") or path == "/live":
            return self.live(method, path[5:] or "/", u.query)
        if not path.startswith("/api/"):
            return self.static(path)
        try:
            self.api(method, path[4:].lstrip("/"), q)
        except BrokenPipeError:
            pass
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.err(500, "internal_error", str(e))

    # -- gerçek backend'e iletim (CORS köprüsü) -----------------------------
    def _emit(self, term, filed=None):
        """Bir satırı iki hedefe yazar: terminal ve --log-file.

        İkisi AYNI ŞEY DEĞİL. Terminal okunabilir kalsın diye süzülüyor ve
        gövdeler kırpılıyor; dosya her şeyi tam alıyor. Bir hatayı canlı
        yakalayamadığında dosyaya dönüp bakabilesin diye — terminalde akıp
        giden bir şeyi geri saramıyorsun.
        """
        if self._tty:
            print(term)
        if LOG:
            LOG.write((filed if filed is not None else term) + "\n")

    def _logged(self, rel):
        """Bu istek terminale yazılsın mı?

        Arayüz tek ekranda onlarca istek atıyor (her kırpım ayrı bir GET).
        Aradığın tek cevap — mesela `POST /analysis` — bunların arasında
        kayboluyordu. `--live-only` ile yalnızca eşleşenler yazılır:

            python server.py --live-only /analysis --live-body -1

        Görüntü/video gövdeleri hiçbir zaman yazılmaz; okunacak bir şey yok
        ve ekranı dolduruyorlar.
        """
        if rel.startswith("/analysis/result/"):
            # Kırpım görüntüleri ve track ayrıntıları: ekran başına yüzlerce
            # istek, hiçbiri okunmuyor. Terminali doldurmasınlar.
            if rel.endswith("/crop") or "/track/" in rel:
                return False
        if "/segments/" in rel or rel.endswith("/stream"):
            return False
        only = getattr(ARGS, "live_only", None)
        return (only in rel) if only else True

    def live(self, method, path, query):
        """`/live/*` → gerçek DVSummary backend'i.

        Tarayıcı 127.0.0.1:8000'den 172.20.14.161:8001'e doğrudan istek atarsa
        CORS'a takılır (FastAPI tarafında Access-Control-Allow-Origin yok).
        Burada isteği sunucu tarafında iletiyoruz — aynı origin gibi görünüyor.

        Range başlığı olduğu gibi geçirilir, yani /video/{id}/stream üzerinde
        seek çalışmaya devam eder.
        """
        rel = path + (("?" + query) if query else "")
        url = LIVE_BASE.rstrip("/") + rel
        body = None
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            # Video yüklemesi yüzlerce MB olabilir — belleğe almadan akıt.
            # urllib, data dosya benzeri bir nesneyse Content-Length'i kendisi
            # üretemez; başlığı elle geçirdiğimiz için sorun olmuyor.
            body = BoundedReader(self.rfile, n) if n > 4 << 20 \
                else self.rfile.read(n)

        req = urllib.request.Request(url, data=body, method=method)
        for h in ("Content-Type", "Range", "Accept"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        if n:
            req.add_header("Content-Length", str(n))

        rng = self.headers.get("Range")
        # Terminale yazilacak mi? Dosyaya HER ISTEK yaziliyor; suzgec yalnizca
        # ekrani okunur tutmak icin. Hicbir hedef yoksa bicimlendirme isine
        # hic girmiyoruz - ekran basina yuzlerce kirpim istegi geliyor.
        self._tty = self._logged(rel)
        if not self._tty and not LOG:
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return self._relay(r, r.status)
            except urllib.error.HTTPError as e:
                return self._relay(e, e.code)
            except Exception as e:
                return self.err(502, "live_unreachable", f"{LIVE_BASE} - {e}")

        stamp = time.strftime("%H:%M:%S")
        line = (f"→ {method} {LIVE_BASE}{rel}"
                + (f"   [Range: {rng}]" if rng else ""))
        self._emit("\n" + line, f"\n[{stamp}] {line}")
        if body is not None:
            ctype = self.headers.get("Content-Type", "")
            if not isinstance(body, (bytes, bytearray)):
                # >4 MB: gövde akıtılıyor, elimizde bytes yok — okumak akışı
                # tüketir ve upload'ı bozar. Sadece boyutu bildiriyoruz.
                self._emit(f"  gönderilen:\n    <{n/1048576:.1f} MB akış, "
                           f"{ctype or 'ikili veri'}>")
            elif ctype.startswith("multipart/"):
                # dosya içeriği — terminale basmanın anlamı yok
                self._emit(f"  gönderilen:\n    <multipart, {n/1024:.1f} KB>")
            else:
                self._dump("  gönderilen", body)

        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                self._live_done(method, rel, r, r.status, t0)
        except urllib.error.HTTPError as e:
            self._live_done(method, rel, e, e.code, t0)
        except Exception as e:
            self._emit(f"← BAĞLANTI HATASI  ({(time.time()-t0)*1000:.0f} ms)  {e}")
            self.err(502, "live_unreachable", f"{LIVE_BASE} — {e}")

    def _live_done(self, method, rel, r, code, t0):
        """Cevabı hem terminale yazar hem tarayıcıya aktarır.

        JSON ise belleğe alıp gösteriyoruz. Video gibi büyük gövdeler
        buffer'lanmaz — sadece boyutu raporlanır, akış aynen geçer.
        """
        el = (time.time() - t0) * 1000
        ctype = r.headers.get("Content-Type", "")
        mark = "✓" if code < 400 else "✗"

        if "json" in ctype or "text" in ctype:
            data = r.read()
            self._emit(f"← {mark} {code}  {el:.0f} ms  "
                       f"{len(data)/1024:.1f} KB  {ctype}")
            self._dump("  gelen", data)
            self.send_response(code)
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass
            return

        cr = r.headers.get("Content-Range")
        cl = r.headers.get("Content-Length")
        size = f"{int(cl)/1024:.0f} KB" if cl else "?"
        self._emit(f"← {mark} {code}  {el:.0f} ms  {size}  "
                   f"{ctype or 'ikili veri'}" + (f"  [{cr}]" if cr else ""))
        self._relay(r, code)

    def _dump(self, label, raw):
        """Gövdeyi okunur biçimde yazar.

        Terminal ile dosya burada ayrışıyor: `--live-body` yalnızca TERMİNALİ
        kırpıyor, dosyaya her zaman tamamı gidiyor. Sebebi basit — ekranda
        2000 satırlık bir cevap işe yaramıyor, ama sonradan `grep` atacağın
        dosyada kırpılmış cevap da işe yaramıyor.
        """
        limit = ARGS.live_body if ARGS else 800
        if limit == 0 and not LOG:
            return
        if not isinstance(raw, (bytes, bytearray)):
            # akış nesnesi — okumak gövdeyi tüketirdi
            self._emit(f"{label}:\n    <akış>")
            return
        try:
            txt = json.dumps(json.loads(raw.decode("utf-8")),
                             ensure_ascii=False, indent=2)
        except Exception:
            txt = raw.decode("utf-8", "replace")

        pad = "\n    "
        full = f"{label}:{pad}" + txt.replace("\n", pad)

        short = txt
        if limit > 0 and len(short) > limit:
            short = short[:limit] + f"\n  … (+{len(txt)-limit} karakter; " \
                                    f"tamamı için --live-body -1)"
        term = "" if limit == 0 else f"{label}:{pad}" + short.replace("\n", pad)

        if term:
            self._emit(term, full)
        elif LOG:
            LOG.write(full + "\n")

    def _relay(self, r, code):
        """Yukarı akıştan gelen cevabı olduğu gibi aktarır (chunk chunk)."""
        self.send_response(code)
        for h in ("Content-Type", "Content-Length", "Content-Range",
                  "Accept-Ranges", "Content-Disposition"):
            v = r.headers.get(h)
            if v:
                self.send_header(h, v)
        if not r.headers.get("Content-Length"):
            # uzunluk bilinmiyor → keep-alive yapamayız, bağlantıyı kapatarak bitir
            self.send_header("Connection", "close")
            self.close_connection = True
        self._cors()
        self.end_headers()
        try:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    # -- statik dosyalar (Range destekli) -----------------------------------
    def static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        if path.endswith("/"):                 # /lab/ → /lab/index.html
            path += "index.html"
        target = (WEB / path.lstrip("/")).resolve()
        try:
            target.relative_to(WEB.resolve())
        except ValueError:
            return self.err(403, "forbidden")
        if not target.is_file():
            return self.err(404, "not_found", path)

        size = target.stat().st_size
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".f32":
            ctype = "application/octet-stream"
        rng = self.headers.get("Range")

        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                s = int(m.group(1)) if m.group(1) else 0
                e = int(m.group(2)) if m.group(2) else size - 1
                e = min(e, size - 1)
                if s > e or s >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                length = e - s + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {s}-{e}/{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                self.send_header("Cache-Control", "no-cache")
                self._cors()
                self.end_headers()
                with open(target, "rb") as f:
                    f.seek(s)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                            return
                        remaining -= len(chunk)
                return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        # Geliştirme sunucusu: kod dosyaları asla önbelleğe alınmasın, yoksa
        # "değiştirdim ama hiçbir şey olmuyor" tuzağına düşülüyor.
        self.send_header(
            "Cache-Control",
            "no-store" if target.suffix in (".js", ".mjs", ".css", ".html",
                                            ".json") else "no-cache")
        self._cors()
        self.end_headers()
        try:
            with open(target, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    # -- SSE ----------------------------------------------------------------
    def sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self._cors()
        self.end_headers()

    def sse_send(self, data, event=None):
        buf = ""
        if event:
            buf += f"event: {event}\n"
        buf += "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"
        self.wfile.write(buf.encode("utf-8"))
        self.wfile.flush()

    # =======================================================================
    # API
    # =======================================================================
    # -- birleştirme uçları -------------------------------------------------
    def merge_api(self, method, seg, q):
        """`/api/merge/*` — parçaları toplar, ffmpeg ile birleştirir, yükler.

        Akış (tarayıcı sırayla çağırır):
            POST /api/merge                  → {merge_id}
            PUT  /api/merge/{id}/part/{i}    → ham gövde = dosya (ikili)
            POST /api/merge/{id}/build       → ffmpeg concat, meta döner
            POST /api/merge/{id}/upload      → backend'e tek video olarak gider
            DELETE /api/merge/{id}           → geçici dosyaları siler

        Multipart AYRIŞTIRMIYORUZ: parçalar ham gövde olarak tek tek geliyor,
        böylece hem ilerleme çubuğu doğal çalışıyor hem de yüzlerce MB'lık
        dosyalar için gövde ayrıştırıcısına ihtiyaç kalmıyor.
        """
        # POST /api/merge → yeni oturum
        if not seg and method == "POST":
            mid = uuid.uuid4().hex[:12]
            d = MERGE_ROOT / mid
            (d / "parts").mkdir(parents=True, exist_ok=True)
            with MERGE_LOCK:
                MERGES[mid] = {"id": mid, "dir": d, "parts": {},
                               "out": None, "meta": None,
                               "created": time.time()}
            return self.jsend({"merge_id": mid}, 201)

        if not seg:
            return self.err(405, "method_not_allowed", method)

        mid = seg[0]
        with MERGE_LOCK:
            m = MERGES.get(mid)
        if not m:
            return self.err(404, "merge_not_found", mid)

        # DELETE /api/merge/{id}
        if len(seg) == 1 and method == "DELETE":
            shutil.rmtree(m["dir"], ignore_errors=True)
            with MERGE_LOCK:
                MERGES.pop(mid, None)
            return self.jsend({"deleted": mid})

        # PUT /api/merge/{id}/part/{index}
        if len(seg) == 3 and seg[1] == "part" and method == "PUT":
            try:
                idx = int(seg[2])
            except ValueError:
                return self.err(400, "bad_index", seg[2])
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                return self.err(400, "empty_body", "parça boş")
            # Uzantıyı koruyoruz: ffmpeg kabı uzantıdan da tahmin ediyor.
            ext = os.path.splitext(q.get("name", ""))[1][:8] or ".mp4"
            dst = m["dir"] / "parts" / f"{idx:03d}{ext}"
            remaining = n
            with open(dst, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            if remaining > 0:
                dst.unlink(missing_ok=True)
                return self.err(400, "short_body",
                                f"{remaining} bayt eksik geldi")
            m["parts"][idx] = {"path": dst, "name": q.get("name", dst.name),
                               "size": n}
            print(f"  merge {mid}: parça {idx} alındı "
                  f"({n/1048576:.1f} MB) {q.get('name','')}")
            return self.jsend({"index": idx, "size": n})

        # POST /api/merge/{id}/build
        if len(seg) == 2 and seg[1] == "build" and method == "POST":
            if not m["parts"]:
                return self.err(400, "no_parts", "önce parça yükleyin")
            order = sorted(m["parts"])
            paths = [m["parts"][i]["path"] for i in order]
            # Gövde isteğe bağlı: {"trims": [{"index":0,"in_ms":0,"out_ms":8200}, …]}
            b = self.body_json()
            by_idx = {}
            for t in (b.get("trims") or []):
                try:
                    by_idx[int(t.get("index"))] = (
                        (t.get("in_ms") or 0) / 1000.0,
                        None if t.get("out_ms") is None else t["out_ms"] / 1000.0)
                except (TypeError, ValueError):
                    continue
            trims = [by_idx.get(i) for i in order]
            pad_idx = {}
            for t in (b.get("pads") or []):
                try:
                    pad_idx[int(t.get("index"))] = (t.get("pad_ms") or 0) / 1000.0
                except (TypeError, ValueError):
                    continue
            pads = [pad_idx.get(i, 0.0) for i in order]
            out = m["dir"] / "merged.mp4"
            print(f"  merge {mid}: {len(paths)} parça birleştiriliyor…")
            t0 = time.time()
            try:
                mode, warnings = merge_videos(paths, out, trims, pads)
            except subprocess.TimeoutExpired:
                return self.err(504, "ffmpeg_timeout",
                                "birleştirme 30 dakikayı aştı")
            except FileNotFoundError:
                return self.err(500, "ffmpeg_missing",
                                "ffmpeg PATH'te bulunamadı")
            except RuntimeError as e:
                return self.err(500, "ffmpeg_failed", str(e))
            pr = probe_video(out) or {}
            m["out"] = out
            m["meta"] = {
                "merge_id": mid, "mode": mode, "warnings": warnings,
                "part_count": len(paths),
                "size_bytes": out.stat().st_size,
                "duration_ms": int((pr.get("duration") or 0) * 1000),
                "width": pr.get("width"), "height": pr.get("height"),
                "codec": pr.get("codec"),
                "elapsed_sec": round(time.time() - t0, 1),
            }
            print(f"  merge {mid}: bitti ({mode}, "
                  f"{m['meta']['elapsed_sec']}s, "
                  f"{m['meta']['size_bytes']/1048576:.1f} MB)")
            return self.jsend(m["meta"])

        # POST /api/merge/{id}/upload → backend'e tek video olarak gönder
        if len(seg) == 2 and seg[1] == "upload" and method == "POST":
            if not m.get("out") or not m["out"].exists():
                return self.err(409, "not_built", "önce /build çağırın")
            b = self.body_json()
            vid = b.get("video_id")
            if vid is None:
                return self.err(400, "missing_video_id", None)
            fields = {"name": b.get("name") or "merged",
                      "is_ptz": "true" if b.get("is_ptz") else "false"}
            if b.get("description"):
                fields["description"] = b["description"]
            if b.get("start_at"):
                fields["start_at"] = b["start_at"]
            try:
                code, data = self.post_multipart(
                    f"{LIVE_BASE.rstrip('/')}/video/{vid}/upload",
                    fields, m["out"], b.get("filename") or "merged.mp4")
            except Exception as e:
                return self.err(502, "live_unreachable", str(e))
            return self.jsend(data, code)

        return self.err(404, "not_found", "/".join(seg))

    def post_multipart(self, url, fields, file_path, filename):
        """Diskteki dosyayı multipart/form-data olarak yükler.

        Gövdeyi belleğe almıyoruz: başlık ve kuyruk baytları hesaplanıp
        Content-Length elle veriliyor, dosya arada akıtılıyor. Birleşik kayıt
        gigabaytlara çıkabildiği için bu şart.
        """
        boundary = "----vsum" + uuid.uuid4().hex
        pre = b""
        for k, v in fields.items():
            pre += (f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{k}"\r\n\r\n'
                    f"{v}\r\n").encode("utf-8")
        pre += (f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; '
                f'filename="{filename}"\r\n'
                f"Content-Type: video/mp4\r\n\r\n").encode("utf-8")
        post = f"\r\n--{boundary}--\r\n".encode("utf-8")
        size = file_path.stat().st_size
        total = len(pre) + size + len(post)

        class Body:
            """pre + dosya + post akışını tek okuyucu gibi sunar."""

            def __init__(self):
                self.stage = 0
                self.buf = io.BytesIO(pre)
                self.fp = None

            def read(self, n=-1):
                if n is None or n < 0:
                    n = 1 << 20
                while True:
                    if self.stage == 0:
                        chunk = self.buf.read(n)
                        if chunk:
                            return chunk
                        self.stage = 1
                        self.fp = open(file_path, "rb")
                    elif self.stage == 1:
                        chunk = self.fp.read(n)
                        if chunk:
                            return chunk
                        self.fp.close()
                        self.stage = 2
                        self.buf = io.BytesIO(post)
                    elif self.stage == 2:
                        chunk = self.buf.read(n)
                        if chunk:
                            return chunk
                        self.stage = 3
                    else:
                        return b""

        req = urllib.request.Request(url, data=Body(), method="POST")
        req.add_header("Content-Type",
                       f"multipart/form-data; boundary={boundary}")
        req.add_header("Content-Length", str(total))
        print(f"\n→ POST {url}  [birleşik dosya {size/1048576:.1f} MB]")
        try:
            with urllib.request.urlopen(req, timeout=1800) as r:
                raw = r.read()
                code = r.status
        except urllib.error.HTTPError as e:
            raw = e.read()
            code = e.code
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            data = {"detail": raw.decode("utf-8", "replace")[:400]}
        print(f"← {'✓' if code < 400 else '✗'} {code}")
        return code, data

    def api(self, method, p, q):
        """`/api/*` — kendi sunucumuzun kendi uclari.

        Mock veri katmani kaldirildi (bkz. archive/mock/). Geriye yalnizca
        gercekten bu sunucuya ait olan is kaldi: parcalari ffmpeg ile
        birlestirip backend'e tek video olarak yollamak. Katalog, analiz,
        olay — hepsi DVSummary'de, tarayici onlara /live/* uzerinden gidiyor.
        """
        seg = [x for x in p.split("/") if x]

        if p == "health":
            return self.jsend({"status": "ok", "server": SERVER_NAME,
                               "time": now_iso(), "upstream": LIVE_BASE})

        if seg[:1] == ["merge"]:
            return self.merge_api(method, seg[1:], q)

        return self.err(404, "unknown_endpoint", p)


def main():
    global ARGS, LOG
    # Windows konsolu cp949 olabilir — Korece/em-dash yazınca patlar
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--live-body", type=int, default=800, metavar="N",
                    help="/live isteklerinde gösterilecek JSON uzunluğu "
                         "(0 = hiç, -1 = tamamı). Varsayılan 800")
    ap.add_argument("--live-only", metavar="PARCA",
                    help="yalnızca yolu bu parçayı içeren istekleri yaz "
                         "(örn: --live-only /analysis). Aradığın cevabı "
                         "kırpım/stream trafiğinin arasında kaybetmemek için")
    ap.add_argument("--log-file", metavar="DOSYA", nargs="?", const="live.log",
                    help="tüm /live trafiğini dosyaya yaz: süzgeçsiz ve "
                         "gövdeler kırpılmadan. Terminal yine kısa kalır. "
                         "Değer verilmezse live.log")
    ARGS = ap.parse_args()

    if ARGS.log_file:
        # satır tamponlu: sunucu çökse bile son istek dosyada olsun
        LOG = open(ARGS.log_file, "a", encoding="utf-8", buffering=1)
        LOG.write(f"\n{'=' * 70}\n"
                  f"# {time.strftime('%Y-%m-%d %H:%M:%S')} "
                  f"— {LIVE_BASE}\n{'=' * 70}\n")

    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    srv.daemon_threads = True
    url = f"http://{ARGS.host}:{ARGS.port}/"
    print("\n" + "=" * 58)
    print(f"  지능형 영상 요약 플랫폼")
    print(f"  UI       : {url}")
    print(f"  Backend  : {LIVE_BASE}   (tarayici /live/* uzerinden gider)")
    print(f"  Birlestir: {url}api/merge")
    if LOG:
        print(f"  Log      : {ARGS.log_file}   (suzgecsiz, tam govde)")
    print("=" * 58 + "\nCtrl+C ile durdurun.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nkapatiliyor")
    finally:
        if LOG:
            LOG.close()


if __name__ == "__main__":
    main()
