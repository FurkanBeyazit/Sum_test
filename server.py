#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
지능형 영상 요약 플랫폼 — Mock API sunucusu
==========================================

Bu sunucu, arkadaşının FastAPI ile yazacağı backend'in **davranışsal ikizi**dir.
Amaç: frontend'i gerçek HTTP üzerinden, gerçek gecikmelerle, gerçek uzun-iş
akışlarıyla geliştirebilmek.

Bağımlılık yok — sadece Python stdlib + numpy.

Neler gerçek:
  * HTTP Range desteği  → video seek gerçekten çalışır
  * Re-ID kosinüs benzerliği → 165 adet GERÇEK SOLIDER (1024-d) vektörü üzerinde
  * Sayfalama, filtreleme, gecikme simülasyonu
  * Uzun işlerin ilerleme akışı (polling + SSE)

Neler simülasyon:
  * Aday구간 선정 (event_candidate_score) → track verisinden türetilmiş metrikler
  * VLM → şablon tabanlı Korece açıklama + gecikme

Boru hattı: Detection+Tracking+PAR → 이벤트 후보 구간 선정 (kural tabanlı)
            → VLM 서술 → 타임라인.

Çalıştırma:
    python server.py            # http://127.0.0.1:8000
    python server.py --port 9000 --latency 0
"""

import argparse
import io
import json
import mimetypes
import os
import queue
import random
import re
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
MOCK = ROOT / "mock"
DATA = MOCK / "data"

ARGS = None

# ---------------------------------------------------------------------------
# Veri yükleme
# ---------------------------------------------------------------------------


class Store:
    def __init__(self):
        self.catalog = self._j("catalog.json")
        # add_video.py ile eklenen kullanıcı videoları ayrı dosyada tutulur —
        # gen_mock.py catalog.json'u ezdiğinde kaybolmasınlar.
        uc = DATA / "catalog_user.json"
        if uc.exists():
            try:
                self.catalog["groups"] += json.loads(
                    uc.read_text(encoding="utf-8")).get("groups", [])
            except Exception as e:
                print(f"  [!] catalog_user.json okunamadi: {e}")
        self.attributes = self._j("attributes.json")
        self.metrics = self._j("metrics.json")
        self.logs = self._j("logs.json")["logs"]
        self.videos = {}
        self.cameras = {}
        for g in self.catalog["groups"]:
            for c in g["cameras"]:
                c["group_id"] = g["id"]
                c["group_name"] = g["name"]
                c["group_name_ko"] = g.get("name_ko", g["name"])
                self.cameras[c["id"]] = c
        for f in DATA.glob("video_*.json"):
            vid = f.stem.replace("video_", "")
            self.videos[vid] = json.loads(f.read_text(encoding="utf-8"))

        gal = self._j("gallery.json")
        self.gallery = gal["items"]
        self.dim = gal["dim"]
        raw = np.fromfile(DATA / "embeddings.f32", dtype=np.float32)
        self.emb = raw.reshape(-1, self.dim) if raw.size else np.zeros((0, self.dim), np.float32)
        # L2 normalize — kosinüs = nokta çarpımı
        n = np.linalg.norm(self.emb, axis=1, keepdims=True)
        n[n == 0] = 1
        self.embn = self.emb / n
        self.obj_index = {o["id"]: i for i, o in enumerate(self.gallery)}


        # çalışma zamanı durumu
        self.jobs = {}            # analysis_run
        self.analysis_jobs = {}   # analysis_job (üst katman)
        self.identities = {}      # global_identity
        self.matches = []         # track_identity_match
        self.searches = {}
        self.reid = {}
        self.tracklists = {"TL1": {"id": "TL1", "name": "추적 대상 목록",
                                   "created_at": now_iso(), "members": []}}
        self.exports = {}
        self.settings = default_settings()
        self.lock = threading.Lock()
        self._seed_jobs()

    def _j(self, name):
        return json.loads((DATA / name).read_text(encoding="utf-8"))

    def _seed_jobs(self):
        """Geçmiş kayıtlar.

        Şema iki katman ayırıyor:
          analysis_job — kullanıcının istediği BİR analiz işi (çok video olabilir)
          analysis_run — o işin içindeki HER video için ayrı çalıştırma
        UI'daki 작업 관리 ekranı bu iki katmanı iç içe gösterir.
        """
        base = datetime(2025, 5, 20, 23, 10, 0)
        specs = [
            ("ajob-1001", "Area1 그룹 일괄 요약", "person walking through gate",
             [("run-8841", "CAM01", "completed", 100, 42.6),
              ("run-8842", "CAM02", "completed", 100, 51.3),
              ("run-8843", "CAM03", "completed", 100, 38.9),
              ("run-8844", "CAM04", "completed", 100, 66.2)]),
            ("ajob-1002", "물류창고 야간 분석", None,
             [("run-8845", "CAM05", "completed", 100, 21840.0)]),
            ("ajob-1003", "공원 업로드 분석", None,
             [("run-8850", "CAM09", "failed", 34, 402.1)]),
            ("ajob-1004", "교차로 2시간 분석", "traffic incident",
             [("run-8851", "CAM10", "running", 43, None)]),
        ]
        k = 0
        for ji, (ajid, jname, prompt, runs) in enumerate(specs):
            statuses = [r[2] for r in runs]
            jstatus = ("failed" if "failed" in statuses else
                       "running" if "running" in statuses else "completed")
            self.analysis_jobs[ajid] = {
                "analysis_job_id": ajid,
                "public_id": str(uuid.uuid5(NS, ajid)),
                "name": jname, "prompt": prompt,
                "status": jstatus,                     # analysis_run_status
                "requested_at": iso(base + timedelta(minutes=ji * 21)),
                "started_at": iso(base + timedelta(minutes=ji * 21, seconds=4)),
                "completed_at": (None if jstatus == "running"
                                 else iso(base + timedelta(minutes=ji * 21 + 9))),
                "error_message": ("CAM09 실행 실패 — CUDA out of memory"
                                  if jstatus == "failed" else None),
                "run_ids": [r[0] for r in runs],
            }
            for (rid, vid, st, pg, dur) in runs:
                k += 1
                self.jobs[rid] = {
                    "job_id": rid,                     # = analysis_run
                    "public_id": str(uuid.uuid5(NS, rid)),
                    "analysis_job_id": ajid,
                    "analysis_job_name": jname,
                    "video_id": vid, "type": "analysis",
                    "status": st, "progress": pg,
                    "stage": "done" if st == "completed" else
                             ("candidate" if st == "running" else "reid"),
                    "stage_label": ("완료" if st == "completed" else
                                    "이벤트 후보 구간 선정" if st == "running"
                                    else "Re-ID 임베딩 추출"),
                    "eta_sec": 262 if st == "running" else 0,
                    "created_at": iso(base + timedelta(minutes=ji * 21 + k)),
                    "duration_sec": dur,
                    "error": ("CUDA out of memory (요구 11.4GB / 가용 8.0GB)"
                              if st == "failed" else None),
                    "log": [],
                }


NS = uuid.UUID("6f9b1c2a-4d3e-5a7b-8c9d-0e1f2a3b4c5d")

# DB şemasındaki enum'lar — sunucu bunların dışında bir değer kabul etmez
ENUMS = {
    "video_source_type": ["file", "rtsp", "uploaded", "archive"],
    "video_status": ["registered", "uploading", "ready", "analyzing",
                     "completed", "failed", "deleted"],
    "analysis_run_status": ["queued", "running", "completed", "failed",
                            "canceled"],
    "event_status": ["candidate", "confirmed", "dismissed"],
    "identity_match_status": ["candidate", "confirmed", "rejected"],
}


def now_iso():
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S+09:00")


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S+09:00")


def default_settings():
    return {
        "summary": {"target_ratio": 3, "min_segment_sec": 4,
                    "max_segment_sec": 24, "context_pad_sec": 2,
                    "default_prompt": ""},
        "analysis": {"conf_threshold": 0.35, "iou_threshold": 0.5,
                     "candidate_threshold": 0.42, "candidate_window_sec": 2.0,
                     "vlm_score_threshold": 0.55,
                     "target_classes": ["person", "vehicle"]},
        "models": {"detector": "YOLOv11-x", "tracker": "BoT-SORT",
                   "par": "PAR-Swin-B", "reid": "SOLIDER-swin_base",
                   "vlm": "InternVL2-8B"},
        "reid": {"match_threshold": 0.72, "batch_size": 20,
                 "max_auto_batches": 3, "temporal_first": True},
        "playback": {"proxy_codec": "h264", "faststart": True,
                     "gop_sec": 1.0, "bbox_default_on": True},
        "locale": {"ui": "ko", "vlm_output": "ko"},
    }


MODEL_CHOICES = {
    "detector": ["YOLOv11-x", "YOLOv11-l", "RT-DETR-x", "Co-DINO"],
    "tracker": ["BoT-SORT", "ByteTrack", "OC-SORT"],
    "par": ["PAR-Swin-B", "PAR-ResNet50", "Rethinking-PAR"],
    "reid": ["SOLIDER-swin_base", "SOLIDER-swin_small", "TransReID"],
    "vlm": ["InternVL2-8B", "Qwen2-VL-7B", "LLaVA-OneVision-7B", "MiniCPM-V-2.6"],
}


# ---------------------------------------------------------------------------
# Olay araması — VLM'in ürettiği doğal dil açıklamaları üzerinde
# ---------------------------------------------------------------------------
#
# Boru hattı:
#     Detection + Tracking + PAR
#       -> event_candidate_score (kural tabanlı metrikler)
#       -> eşiği aşan pencereler VLM'e
#       -> vlm_event.description (Korece doğal dil)
#
# Arama bu son adımın çıktısı üzerinde çalışır: görsel arama değil, VLM'in
# yazdığı metinde arama. Sınırı şu: VLM bahsetmediyse bulunamaz.

import unicodedata


def norm_text(x):
    """Arama için kaba normalleştirme: küçük harf + aksan/boşluk toleransı."""
    x = (x or "").lower().strip()
    return unicodedata.normalize("NFKC", x)


# Türkçe/İngilizce sorguyu Korece açıklamalara bağlayan küçük eşanlam sözlüğü.
# Gerçek sistemde bunun yerine ya çok dilli bir metin embedding'i (BGE-M3 gibi)
# ya da VLM çıktısının çok dilli üretilmesi gerekir.
SYNONYMS = {
    "kişi": ["남성", "여성", "사람", "인원"], "insan": ["남성", "여성", "사람", "인원"],
    "adam": ["남성"], "erkek": ["남성"], "kadın": ["여성"],
    "araç": ["차량", "세단", "SUV"], "arac": ["차량"], "araba": ["차량"],
    "yürü": ["이동", "통행", "걸"], "giriş": ["진입", "들어"], "giren": ["진입"],
    "çıkış": ["빠져나", "이탈"], "düş": ["쓰러", "넘어"], "düşen": ["쓰러"],
    "dolaş": ["배회"], "başıboş": ["배회"], "bekle": ["머무", "정차"],
    "telefon": ["통화"], "bin": ["탑승"], "binen": ["탑승"], "park": ["주차"],
    "person": ["남성", "여성", "사람"], "vehicle": ["차량"], "car": ["차량"],
    "walk": ["이동", "통행"], "enter": ["진입"], "exit": ["빠져나", "이탈"],
    "fall": ["쓰러"], "loiter": ["배회"], "phone": ["통화"], "board": ["탑승"],
    "kırmızı": ["빨간", "빨강"], "beyaz": ["흰색", "흰"], "siyah": ["검은", "검정"],
    "mavi": ["파란", "파랑"], "red": ["빨간"], "white": ["흰색"], "black": ["검"],
}


def expand_query(q):
    """Sorguyu kelimelere ayır, eşanlamlılarını ekle."""
    q = norm_text(q)
    words = [w for w in re.split(r"[\s,.;/]+", q) if w]
    terms = []
    for w in words:
        terms.append(w)
        for key, alts in SYNONYMS.items():
            if key in w or w in key:
                terms.extend(alts)
    # tekilleştir, sırayı koru
    seen, out = set(), []
    for t in terms:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return words, out


def search_events(store, video_ids, query, min_score=0.0, statuses=None):
    """VLM açıklamalarında metin araması. Gerçekte ~10 ms süren SQL sorgusu.

    Puanlama basit ve açıklanabilir:
      + eşleşen terim başına puan
      + başlıkta/tipte eşleşme daha değerli
      × olayın kendi güven skoru
    """
    words, terms = expand_query(query)
    hits = []
    scanned = 0
    for vid in video_ids:
        v = store.videos.get(vid)
        if not v:
            continue
        for e in v["events"]:
            scanned += 1
            if statuses and e.get("status", "candidate") not in statuses:
                continue
            hay = norm_text(" ".join([
                e.get("description", ""), e.get("description_en", ""),
                e.get("type", ""), e.get("type_ko", ""), e.get("type_tr", ""),
                e.get("title", ""),
            ]))
            matched = [t for t in terms if t and t in hay]
            if not matched:
                continue
            # kaç FARKLI sorgu kelimesi karşılandı?
            covered = sum(1 for w in words
                          if w in hay or any(a in hay for a in SYNONYMS.get(w, [])))
            rel = (covered / max(1, len(words))) * 0.7 + min(len(matched), 4) / 4 * 0.3
            score = round(rel * (0.55 + 0.45 * e.get("score", 0.5)), 4)
            if score < min_score:
                continue
            hits.append(dict(e, match_score=score, matched_terms=matched[:6]))
    hits.sort(key=lambda h: -h["match_score"])
    return hits, scanned, words, terms


# ---------------------------------------------------------------------------
# Uzun işler
# ---------------------------------------------------------------------------

STAGES = [
    ("decode", "디코딩 및 프레임 추출", 0.08),
    ("detection", "Object Detection + Tracking", 0.34),
    ("par", "PAR 속성 추출", 0.12),
    ("reid", "Re-ID 임베딩 추출", 0.14),
    ("candidate", "이벤트 후보 구간 선정", 0.18),
    ("vlm", "VLM 이벤트 서술", 0.14),
]


def run_analysis_job(store, job):
    """Analiz işini simüle eder — aşama aşama ilerler."""
    total = job["_sim_sec"]
    prog = 0.0
    for key, label, weight in STAGES:
        if job["status"] == "canceled":
            return
        job["stage"] = key
        job["stage_label"] = label
        dur = total * weight
        steps = max(3, int(dur / 0.25))
        for s in range(steps):
            if job["status"] == "canceled":
                return
            time.sleep(dur / steps)
            prog += 100.0 / len(STAGES) / steps
            job["progress"] = round(min(99.5, prog), 1)
            job["eta_sec"] = round(total * (1 - prog / 100), 1)
            job["updated_at"] = now_iso()
        job["log"].append({"ts": now_iso(), "level": "INFO",
                           "message": f"[{key}] {label} 완료"})
        push_job_event(job)
    job["progress"] = 100.0
    job["status"] = "completed"
    job["stage"] = "done"
    job["stage_label"] = "완료"
    job["eta_sec"] = 0
    job["finished_at"] = now_iso()
    push_job_event(job)


JOB_SUBS = {}
JOB_SUBS_LOCK = threading.Lock()


def push_job_event(job):
    with JOB_SUBS_LOCK:
        for q in JOB_SUBS.get(job["job_id"], []):
            try:
                q.put_nowait(dict(job, log=job["log"][-3:]))
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Re-ID
# ---------------------------------------------------------------------------

def start_reid(store, object_id, scope_video_ids, exclude_same_video=True):
    if object_id not in store.obj_index:
        return None
    qi = store.obj_index[object_id]
    qobj = store.gallery[qi]
    qv = store.embn[qi]

    # aday havuzu
    idxs = []
    for i, o in enumerate(store.gallery):
        if i == qi:
            continue
        if o["cls"] != "person":
            continue
        if scope_video_ids and o["video_id"] not in scope_video_ids:
            continue
        if exclude_same_video and o["video_id"] == qobj["video_id"]:
            continue
        idxs.append(i)

    # "가장 시간적으로 가까운 객체부터" — zamansal yakınlığa göre sırala
    def tkey(i):
        try:
            a = datetime.fromisoformat(store.gallery[i]["wall_time"].replace("+09:00", ""))
            b = datetime.fromisoformat(qobj["wall_time"].replace("+09:00", ""))
            return abs((a - b).total_seconds())
        except Exception:
            return 1e12
    idxs.sort(key=tkey)

    sid = "reid-" + uuid.uuid4().hex[:8]
    store.reid[sid] = {
        "session_id": sid, "query_object_id": object_id,
        "query": qobj, "status": "running",
        "pool": idxs, "cursor": 0,
        "batch_size": store.settings["reid"]["batch_size"],
        "max_auto_batches": store.settings["reid"]["max_auto_batches"],
        "batches_done": 0, "candidates": [], "compared": 0,
        "pool_size": len(idxs), "created_at": now_iso(),
        "threshold": store.settings["reid"]["match_threshold"],
        "model": "SOLIDER swin_base (1024-d, cosine)",
    }
    return store.reid[sid]


REID_SUBS = {}
REID_LOCK = threading.Lock()


def push_reid(sess, payload):
    with REID_LOCK:
        for q in REID_SUBS.get(sess["session_id"], []):
            try:
                q.put_nowait(payload)
            except Exception:
                pass


def run_reid_batches(store, sess, n_batches):
    """Kademeli eşleştirme — gerçek kosinüs benzerliği hesaplanır."""
    qi = store.obj_index[sess["query_object_id"]]
    qv = store.embn[qi]
    for _ in range(n_batches):
        if sess["cursor"] >= len(sess["pool"]):
            sess["status"] = "exhausted"
            push_reid(sess, {"type": "done", "reason": "pool_exhausted",
                             "compared": sess["compared"]})
            return
        chunk = sess["pool"][sess["cursor"]:sess["cursor"] + sess["batch_size"]]
        sess["cursor"] += len(chunk)
        # gerçek hesap — 20 vektör × 1024 boyut
        sims = store.embn[chunk] @ qv
        time.sleep(ARGS.latency * 6 + 0.35)      # GPU/IO gecikmesi simülasyonu
        added = []
        for i, s in zip(chunk, sims):
            o = store.gallery[i]
            added.append({
                "object_id": o["id"], "similarity": round(float(s), 4),
                "video_id": o["video_id"], "camera": o["camera"],
                "camera_place": o.get("camera_place", ""),
                "group": o.get("group", ""),
                "crop": o["crop"], "wall_time": o["wall_time"],
                "t_first": o.get("t_first", 0), "t_last": o.get("t_last", 0),
                "attrs": o.get("attrs", {}), "label": o.get("label", o["id"]),
                "kind": o.get("kind", "synthetic"),
                "node_id": o.get("node_id"), "ch": o.get("ch"),
                "verdict": None,
            })
        sess["compared"] += len(chunk)
        sess["candidates"].extend(added)
        sess["candidates"].sort(key=lambda c: -c["similarity"])
        sess["batches_done"] += 1
        push_reid(sess, {
            "type": "batch",
            "batch": sess["batches_done"],
            "compared": sess["compared"],
            "pool_size": sess["pool_size"],
            "added": len(added),
            "candidates": sess["candidates"][:24],
            "best": sess["candidates"][0]["similarity"] if sess["candidates"] else 0,
        })
        # eşik üstü yeterli aday bulunduysa dur (dokümandaki davranış)
        strong = [c for c in sess["candidates"] if c["similarity"] >= sess["threshold"]]
        if len(strong) >= 3:
            sess["status"] = "paused"
            push_reid(sess, {"type": "paused", "reason": "enough_matches",
                             "strong": len(strong), "compared": sess["compared"]})
            return
    sess["status"] = "paused"
    push_reid(sess, {"type": "paused", "reason": "batch_limit",
                     "compared": sess["compared"]})


# ---------------------------------------------------------------------------
# HTTP katmanı
# ---------------------------------------------------------------------------

STORE = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "vsum-mock/0.4"

    def log_message(self, fmt, *a):
        if ARGS.verbose:
            print(f"  {self.address_string()} {fmt % a}")

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
        except (BrokenPipeError, ConnectionAbortedError):
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
        if not path.startswith("/api/"):
            return self.static(path)
        if ARGS.latency:
            time.sleep(ARGS.latency * random.uniform(0.6, 1.5))
        try:
            self.api(method, path[4:].lstrip("/"), q)
        except BrokenPipeError:
            pass
        except Exception as e:
            import traceback
            traceback.print_exc()
            self.err(500, "internal_error", str(e))

    # -- statik dosyalar (Range destekli) -----------------------------------
    def static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        if path.endswith("/"):                 # /lab/ → /lab/index.html
            path += "index.html"
        target = (MOCK / path.lstrip("/")).resolve()
        try:
            target.relative_to(MOCK.resolve())
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
                        except (BrokenPipeError, ConnectionAbortedError):
                            return
                        remaining -= len(chunk)
                return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        self._cors()
        self.end_headers()
        try:
            with open(target, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionAbortedError):
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
    def api(self, method, p, q):
        s = STORE
        seg = [x for x in p.split("/") if x]

        # --- sağlık / meta --------------------------------------------------
        if p == "health":
            return self.jsend({"status": "ok", "server": "vsum-mock 0.4",
                               "time": now_iso(),
                               "videos": len(s.videos),
                               "gallery": len(s.gallery),
                               "embedding_dim": s.dim})

        if p == "openapi":
            return self.jsend(openapi_summary())

        # --- auth -----------------------------------------------------------
        if p == "auth/login" and method == "POST":
            b = self.body_json()
            if b.get("username") and b.get("password"):
                return self.jsend({
                    "access_token": "mock." + uuid.uuid4().hex,
                    "token_type": "bearer", "expires_in": 28800,
                    "user": {"id": "u1", "username": b["username"],
                             "display_name": b["username"],
                             "role": "admin",
                             "permissions": ["view", "analyze", "export", "settings"]}})
            return self.err(401, "invalid_credentials", "아이디 또는 비밀번호를 확인하십시오.")

        if p == "auth/me":
            return self.jsend({"id": "u1", "username": "admin",
                               "display_name": "admin", "role": "admin",
                               "permissions": ["view", "analyze", "export", "settings"]})

        # --- katalog --------------------------------------------------------
        if p == "groups":
            out = []
            for g in s.catalog["groups"]:
                gg = dict(g)
                gg["cameras"] = []
                for c in g["cameras"]:
                    if c["status"] == "deleted":
                        continue
                    cc = {k: c[k] for k in
                          ("id", "name", "place_ko", "status", "source_type",
                           "has_proxy", "node_id", "ch", "duration",
                           "start_time", "end_time")}
                    if c["status"] == "analyzing":
                        cc["progress"] = c.get("progress", 0)
                        cc["stage"] = c.get("stage")
                        cc["eta_sec"] = c.get("eta_sec")
                    if c.get("error"):
                        cc["error"] = c["error"]
                    if c.get("real_data"):
                        cc["real_data"] = True
                    v = s.videos.get(c["id"])
                    cc["event_count"] = len(v["events"]) if v else 0
                    cc["object_count"] = len(v["objects"]) if v else 0
                    gg["cameras"].append(cc)
                out.append(gg)
            return self.jsend({"groups": out,
                               "enums": s.catalog["enums"],
                               "event_types": s.catalog["event_types"]})

        if p == "attributes":
            return self.jsend(s.attributes)

        if p == "metrics":
            # event_candidate_score.metric_code sözlüğü
            return self.jsend(s.metrics)

        # --- videolar --------------------------------------------------------
        if seg[:1] == ["videos"] and len(seg) >= 2:
            vid = seg[1]
            v = s.videos.get(vid)
            cam = s.cameras.get(vid)
            if not cam:
                return self.err(404, "video_not_found", vid)

            if len(seg) == 2:
                out = dict(cam)
                if v:
                    out["summary"] = v["summary"]
                return self.jsend(out)

            sub = seg[2]

            if sub == "summary":
                return self.jsend(v["summary"] if v else {})

            if sub == "events":
                evs = list(v["events"]) if v else []
                if q.get("type"):
                    want = set(q["type"].split(","))
                    evs = [e for e in evs if e["type"] in want]
                if q.get("severity"):
                    want = set(q["severity"].split(","))
                    evs = [e for e in evs if e["severity"] in want]
                if q.get("min_score"):
                    evs = [e for e in evs if e["score"] >= float(q["min_score"])]
                if q.get("qtext"):
                    t = q["qtext"].lower()
                    evs = [e for e in evs if t in e["description"].lower()]
                if q.get("status"):          # event_status enum
                    want = set(q["status"].split(","))
                    evs = [e for e in evs if e.get("status", "candidate") in want]
                if q.get("event_group_id"):
                    evs = [e for e in evs
                           if e.get("event_group_code") == q["event_group_id"]
                           or e.get("event_group_id") == q["event_group_id"]]
                total = len(evs)
                off = int(q.get("offset", 0))
                lim = int(q.get("limit", 50))
                return self.jsend({"total": total, "offset": off, "limit": lim,
                                   "items": evs[off:off + lim]})

            if sub == "detections":
                if not v:
                    return self.jsend({"rows": []})
                det = v["detections"]
                f0 = float(q.get("from", 0))
                f1 = float(q.get("to", 1e12))
                rows = [r for r in det["rows"] if f0 <= r[0] <= f1]
                if q.get("cls"):
                    want = {"person": 0, "vehicle": 1}.get(q["cls"])
                    rows = [r for r in rows if r[2] == want]
                if q.get("track_ids"):
                    want = set(int(x) for x in q["track_ids"].split(","))
                    rows = [r for r in rows if r[1] in want]
                return self.jsend({
                    "video_id": vid, "fps": det["fps"],
                    "coord": det["coord"], "keys": det["keys"],
                    "cls_map": det["cls_map"],
                    "from": f0, "to": None if f1 > 1e11 else f1,
                    "count": len(rows), "rows": rows})

            if sub == "objects":
                objs = list(v["objects"]) if v else []
                if q.get("cls"):
                    objs = [o for o in objs if o["cls"] == q["cls"]]
                for key in ("gender", "age", "upper_color", "upper_type",
                            "lower_color", "hat", "vehicle_type", "vehicle_color"):
                    if q.get(key):
                        want = set(q[key].split(","))
                        objs = [o for o in objs
                                if str(o.get("attrs", {}).get(key)) in want]
                if q.get("carry"):
                    want = set(q["carry"].split(","))
                    objs = [o for o in objs
                            if want & set(o.get("attrs", {}).get("carry") or [])]
                total = len(objs)
                off = int(q.get("offset", 0))
                lim = int(q.get("limit", 200))
                return self.jsend({"total": total, "offset": off, "limit": lim,
                                   "items": objs[off:off + lim]})

            if sub == "candidates":
                # event_candidate_score — "bu olay neden seçildi" verisi
                if not v:
                    return self.jsend({})
                cd = v.get("candidates", {})
                only = q.get("only_candidates") in ("1", "true", "yes")
                f0 = float(q.get("from", 0))
                f1 = float(q.get("to", 1e12))
                wins = [w for w in cd.get("windows", [])
                        if w["t_end"] >= f0 and w["t_start"] <= f1
                        and (w["is_candidate"] if only else True)]
                return self.jsend(dict(cd, windows=wins, returned=len(wins)))

            if sub == "stream":
                return self.static(f"/assets/{vid.lower()}.mp4")

            if sub == "poster":
                return self.static(f"/assets/poster/{vid}.jpg")

            if sub == "analyses" and method == "POST":
                b = self.body_json()
                jid = "job-" + uuid.uuid4().hex[:6]
                sim = float(b.get("_sim_sec", 14))
                job = {"job_id": jid, "video_id": vid, "type": "analysis",
                       "status": "running", "progress": 0.0,
                       "stage": "queued", "stage_label": "대기 중",
                       "eta_sec": sim, "created_at": now_iso(),
                       "prompt": b.get("prompt"), "log": [],
                       "options": b.get("options", {}),
                       "_sim_sec": sim, "error": None}
                s.jobs[jid] = job
                threading.Thread(target=run_analysis_job, args=(s, job),
                                 daemon=True).start()
                return self.jsend({"job_id": jid, "status": "running",
                                   "video_id": vid, "eta_sec": sim}, 202)

            return self.err(404, "unknown_subresource", sub)

        # --- olay araması (VLM açıklamaları üzerinde metin araması) ----------
        if p == "search" and method == "POST":
            bd = self.body_json()
            query = bd.get("query") or bd.get("prompt") or ""
            vids = bd.get("video_ids") or ["CAM01"]
            limit = int(bd.get("limit") or 50)
            statuses = bd.get("status")
            t0 = time.time()
            hits, scanned, words, terms = search_events(
                s, vids, query, float(bd.get("min_score") or 0),
                set(statuses.split(",")) if statuses else None)
            ms = round((time.time() - t0) * 1000 + random.uniform(1, 4), 1)
            sid = "srch-" + uuid.uuid4().hex[:8]
            s.searches[sid] = {
                "search_id": sid, "query": query, "video_ids": vids,
                "created_at": now_iso(), "latency_ms": ms,
                "scanned": scanned, "terms": terms,
                "results": hits[:limit], "total": len(hits),
            }
            return self.jsend({
                "search_id": sid, "query": query,
                "engine": "text/vlm_description",
                "latency_ms": ms,
                "events_scanned": scanned,
                "query_words": words,
                "expanded_terms": terms[:24],
                "total": len(hits),
                "items": hits[:limit],
                "note": "VLM'in ürettiği açıklamalarda metin araması. "
                        "VLM bahsetmediyse bulunamaz.",
            })

        if seg[:1] == ["searches"] and len(seg) >= 2:
            sess = s.searches.get(seg[1])
            if not sess:
                return self.err(404, "search_not_found", seg[1])
            return self.jsend(sess)

        # --- olay durumu (event_status: candidate/confirmed/dismissed) --------
        if seg[:1] == ["events"] and len(seg) >= 2:
            eid = seg[1]
            ev = None
            for v in s.videos.values():
                for e in v["events"]:
                    if e["id"] == eid or e.get("public_id") == eid:
                        ev = e
                        break
                if ev:
                    break
            if not ev:
                return self.err(404, "event_not_found", eid)
            if len(seg) == 2 and method == "GET":
                return self.jsend(ev)
            if len(seg) == 3 and seg[2] == "status" and method == "POST":
                b = self.body_json()
                st = b.get("status")
                if st not in ENUMS["event_status"]:
                    return self.err(400, "invalid_event_status",
                                    f"{st} ∉ {ENUMS['event_status']}")
                ev["status"] = st
                ev["reviewed_by"] = b.get("reviewed_by", "admin")
                ev["reviewed_at"] = now_iso()
                return self.jsend(ev)

        # --- olay grupları (event_group_id — kameralar arası tek sahne) -------
        if p == "event-groups":
            out = []
            meta = s.catalog.get("event_groups", {})
            for gid, m in meta.items():
                items = []
                for v in s.videos.values():
                    for e in v["events"]:
                        if e.get("event_group_code") == gid:
                            items.append(e)
                items.sort(key=lambda e: e["occurred_start_at"])
                out.append({
                    "event_group_id": m["public_id"], "code": gid,
                    "title": m["title"], "event_count": len(items),
                    "cameras": sorted({e["video_id"] for e in items}),
                    "occurred_start_at": items[0]["occurred_start_at"] if items else None,
                    "occurred_end_at": items[-1]["occurred_end_at"] if items else None,
                    "events": items})
            out.sort(key=lambda x: x["occurred_start_at"] or "")
            return self.jsend({"total": len(out), "items": out})

        # --- işler ------------------------------------------------------------
        if p == "analysis-jobs":
            items = []
            for aj in sorted(s.analysis_jobs.values(),
                             key=lambda j: j["requested_at"], reverse=True):
                runs = [{k: v for k, v in s.jobs[r].items()
                         if not k.startswith("_")}
                        for r in aj["run_ids"] if r in s.jobs]
                items.append(dict(aj, runs=runs))
            return self.jsend({"total": len(items), "items": items})

        if p == "jobs":
            items = sorted(s.jobs.values(),
                           key=lambda j: j.get("created_at", ""), reverse=True)
            items = [{k: v for k, v in j.items() if not k.startswith("_")}
                     for j in items]
            return self.jsend({"total": len(items), "items": items})

        if seg[:1] == ["jobs"] and len(seg) >= 2:
            jid = seg[1]
            job = s.jobs.get(jid)
            if not job:
                return self.err(404, "job_not_found", jid)
            if len(seg) == 2:
                return self.jsend({k: v for k, v in job.items()
                                   if not k.startswith("_")})
            if seg[2] == "stream":
                return self.stream_job(job)
            if seg[2] == "cancel" and method == "POST":
                job["status"] = "canceled"
                job["stage_label"] = "취소됨"
                push_job_event(job)
                return self.jsend({"job_id": jid, "status": "canceled"})

        # --- Re-ID -------------------------------------------------------------
        if p == "reid" and method == "POST":
            b = self.body_json()
            sess = start_reid(s, b.get("object_id"),
                              b.get("scope_video_ids"),
                              b.get("exclude_same_video", True))
            if not sess:
                return self.err(404, "object_not_found", b.get("object_id"))
            threading.Thread(
                target=run_reid_batches,
                args=(s, sess, sess["max_auto_batches"]), daemon=True).start()
            return self.jsend({
                "session_id": sess["session_id"],
                "query": sess["query"], "pool_size": sess["pool_size"],
                "batch_size": sess["batch_size"],
                "threshold": sess["threshold"], "model": sess["model"],
                "status": "running"}, 202)

        if seg[:1] == ["reid"] and len(seg) >= 2:
            sid = seg[1]
            sess = s.reid.get(sid)
            if not sess:
                return self.err(404, "reid_session_not_found", sid)
            if len(seg) == 2:
                return self.jsend({k: v for k, v in sess.items() if k != "pool"})
            if seg[2] == "stream":
                return self.stream_reid(sess)
            if seg[2] == "continue" and method == "POST":
                b = self.body_json()
                n = int(b.get("batches", 2))
                sess["status"] = "running"
                threading.Thread(target=run_reid_batches,
                                 args=(s, sess, n), daemon=True).start()
                return self.jsend({"session_id": sid, "status": "running",
                                   "batches": n})
            if seg[2] == "verdict" and method == "POST":
                # şema: track_identity_match.status
                b = self.body_json()
                st = b.get("status") or b.get("verdict")
                if st not in ENUMS["identity_match_status"]:
                    return self.err(400, "invalid_identity_match_status",
                                    f"{st} ∉ {ENUMS['identity_match_status']}")
                hit = None
                for c in sess["candidates"]:
                    if c["object_id"] == b.get("object_id"):
                        c["status"] = st
                        hit = c
                if not hit:
                    return self.err(404, "candidate_not_found", b.get("object_id"))
                rec = {
                    "id": len(s.matches) + 1,
                    "track_id": hit["object_id"],
                    "query_track_id": sess["query_object_id"],
                    "global_identity_id": b.get("global_identity_id"),
                    "similarity": hit["similarity"],
                    "status": st,
                    "matched_by": b.get("matched_by", "user"),
                    "created_at": now_iso(),
                }
                s.matches.append(rec)
                return self.jsend(rec)

        # --- takip listesi ------------------------------------------------------
        if p == "tracklists":
            return self.jsend({"items": list(s.tracklists.values())})

        if seg[:1] == ["tracklists"] and len(seg) >= 2:
            tl = s.tracklists.get(seg[1])
            if not tl:
                return self.err(404, "tracklist_not_found", seg[1])
            if len(seg) == 2 and method == "GET":
                return self.jsend(tl)
            if len(seg) == 3 and seg[2] == "members":
                if method == "POST":
                    b = self.body_json()
                    oid = b.get("object_id")
                    i = s.obj_index.get(oid)
                    if i is None:
                        return self.err(404, "object_not_found", oid)
                    o = s.gallery[i]
                    if any(m["object_id"] == oid for m in tl["members"]):
                        return self.jsend(tl)
                    tl["members"].append({
                        "object_id": oid, "added_at": now_iso(),
                        "similarity": b.get("similarity"),
                        "video_id": o["video_id"], "camera": o["camera"],
                        "camera_place": o.get("camera_place", ""),
                        "wall_time": o["wall_time"], "crop": o["crop"],
                        "t_first": o.get("t_first", 0),
                        "t_last": o.get("t_last", 0),
                        "label": o.get("label", oid),
                        "attrs": o.get("attrs", {}),
                        "kind": o.get("kind")})
                    tl["members"].sort(key=lambda m: m["wall_time"])
                    return self.jsend(tl)
            if len(seg) == 4 and seg[2] == "members" and method == "DELETE":
                tl["members"] = [m for m in tl["members"]
                                 if m["object_id"] != seg[3]]
                return self.jsend(tl)

        # --- sistem --------------------------------------------------------------
        if p == "system/gpu":
            t = time.time()
            return self.jsend({"devices": [{
                "index": 0, "name": "NVIDIA GeForce RTX 5070",
                "driver": "560.94", "cuda": "12.6",
                "memory_total_mb": 12288,
                "memory_used_mb": int(6100 + 1400 * abs(np.sin(t / 9))),
                "utilization_pct": int(52 + 44 * abs(np.sin(t / 5))),
                "temperature_c": int(58 + 12 * abs(np.sin(t / 13))),
                "power_w": int(140 + 70 * abs(np.sin(t / 7))),
                "fan_pct": int(42 + 28 * abs(np.sin(t / 11)))}],
                "host": {"cpu_pct": int(18 + 30 * abs(np.sin(t / 6))),
                         "ram_used_gb": round(14.2 + 3 * abs(np.sin(t / 8)), 1),
                         "ram_total_gb": 64,
                         "disk_used_tb": 3.4, "disk_total_tb": 8.0},
                "queue": {"running": 1, "queued": 2, "workers": 2},
                "time": now_iso()})

        if p == "logs":
            lv = q.get("level")
            items = s.logs
            if lv:
                want = set(lv.split(","))
                items = [l for l in items if l["level"] in want]
            if q.get("qtext"):
                t = q["qtext"].lower()
                items = [l for l in items if t in l["message"].lower()]
            return self.jsend({"total": len(items), "items": items[::-1]})

        if p == "settings":
            if method == "PUT":
                b = self.body_json()
                for k, v in b.items():
                    if k in s.settings and isinstance(v, dict):
                        s.settings[k].update(v)
                return self.jsend(s.settings)
            return self.jsend({"settings": s.settings, "choices": MODEL_CHOICES})

        # --- dışa aktarma ----------------------------------------------------------
        if p == "exports" and method == "POST":
            b = self.body_json()
            eid = "exp-" + uuid.uuid4().hex[:6]
            s.exports[eid] = {"export_id": eid, "status": "running",
                              "progress": 0, "type": b.get("type", "video"),
                              "created_at": now_iso(), "params": b}

            def run():
                for i in range(0, 101, 7):
                    time.sleep(0.22)
                    s.exports[eid]["progress"] = min(100, i)
                s.exports[eid]["status"] = "completed"
                s.exports[eid]["progress"] = 100
                s.exports[eid]["download_url"] = f"/api/exports/{eid}/download"
                s.exports[eid]["size_mb"] = round(random.uniform(12, 240), 1)
            threading.Thread(target=run, daemon=True).start()
            return self.jsend(s.exports[eid], 202)

        if seg[:1] == ["exports"] and len(seg) >= 2:
            ex = s.exports.get(seg[1])
            if not ex:
                return self.err(404, "export_not_found", seg[1])
            return self.jsend(ex)

        return self.err(404, "unknown_endpoint", p)

    # -- SSE uçları ------------------------------------------------------------
    def stream_job(self, job):
        q = queue.Queue(maxsize=64)
        with JOB_SUBS_LOCK:
            JOB_SUBS.setdefault(job["job_id"], []).append(q)
        try:
            self.sse_start()
            self.sse_send({k: v for k, v in job.items()
                           if not k.startswith("_")}, "progress")
            deadline = time.time() + 600
            while time.time() < deadline:
                try:
                    ev = q.get(timeout=1.0)
                    self.sse_send({k: v for k, v in ev.items()
                                   if not k.startswith("_")}, "progress")
                    if ev.get("status") in ("completed", "failed", "canceled"):
                        self.sse_send({"status": ev["status"]}, "end")
                        break
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, OSError):
            pass
        finally:
            with JOB_SUBS_LOCK:
                lst = JOB_SUBS.get(job["job_id"], [])
                if q in lst:
                    lst.remove(q)

    def stream_reid(self, sess):
        q = queue.Queue(maxsize=64)
        with REID_LOCK:
            REID_SUBS.setdefault(sess["session_id"], []).append(q)
        try:
            self.sse_start()
            self.sse_send({"type": "init", "query": sess["query"],
                           "pool_size": sess["pool_size"],
                           "threshold": sess["threshold"],
                           "model": sess["model"]}, "reid")
            deadline = time.time() + 900
            while time.time() < deadline:
                try:
                    ev = q.get(timeout=1.0)
                    self.sse_send(ev, "reid")
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, OSError):
            pass
        finally:
            with REID_LOCK:
                lst = REID_SUBS.get(sess["session_id"], [])
                if q in lst:
                    lst.remove(q)


def openapi_summary():
    """Sözleşmenin özeti — backend geliştiricisine verilecek liste."""
    return {"openapi": "3.1.0",
            "info": {"title": "지능형 영상 요약 플랫폼 API (mock)",
                     "version": "0.4.0"},
            "paths": {
                "GET  /api/health": "sunucu durumu",
                "POST /api/auth/login": "{username,password} → token+user",
                "GET  /api/auth/me": "oturum sahibinin bilgisi",
                "GET  /api/groups": "grup+kamera ağacı (durum, ilerleme dahil)",
                "GET  /api/attributes": "PAR öznitelik sözlüğü (filtre paneli bunu okur)",
                "GET  /api/metrics": "event_candidate_score metrik sözlüğü",
                "GET  /api/videos/{id}": "video meta + özet",
                "GET  /api/videos/{id}/summary": "요약 정보 kutusu",
                "GET  /api/videos/{id}/events": "?limit&offset&type&severity&min_score&qtext",
                "GET  /api/videos/{id}/detections": "?from&to&cls&track_ids — bbox satırları",
                "GET  /api/videos/{id}/objects": "?cls&gender&upper_color&… — crop kartları",
                "GET  /api/videos/{id}/candidates": "?from&to&only_candidates — aday구간 skorları (bu olay neden seçildi)",
                "GET  /api/videos/{id}/stream": "video (HTTP Range destekli)",
                "GET  /api/videos/{id}/poster": "poster karesi",
                "POST /api/videos/{id}/analyses": "analiz/yeniden özetleme başlat → job",
                "GET  /api/events/{id}": "tek olay (id veya public_id)",
                "POST /api/events/{id}/status": "{status: candidate|confirmed|dismissed} "
                                                "— 오탐 제외 / 확정",
                "GET  /api/event-groups": "event_group_id ile kameralar arası "
                                          "aynı sahne (하나의 사건)",
                "GET  /api/analysis-jobs": "analysis_job + içindeki analysis_run'lar",
                "POST /api/search": "{video_ids,query} → VLM açıklamalarında metin araması",
                "GET  /api/searches/{id}": "arama sonucu (tekrar okuma)",
                "GET  /api/jobs": "iş listesi/geçmişi",
                "GET  /api/jobs/{id}": "polling ile ilerleme",
                "GET  /api/jobs/{id}/stream": "SSE ile ilerleme",
                "POST /api/jobs/{id}/cancel": "işi iptal et",
                "POST /api/reid": "{object_id,scope_video_ids} → eşleştirme oturumu",
                "GET  /api/reid/{sid}": "oturum durumu + adaylar",
                "GET  /api/reid/{sid}/stream": "SSE — adaylar kademeli gelir",
                "POST /api/reid/{sid}/continue": "{batches} — aramaya devam et",
                "POST /api/reid/{sid}/verdict": "{object_id,status: candidate|"
                                                "confirmed|rejected} → track_identity_match",
                "GET  /api/tracklists": "takip listeleri",
                "POST /api/tracklists/{id}/members": "takip listesine ekle",
                "DELETE /api/tracklists/{id}/members/{oid}": "listeden çıkar",
                "GET  /api/system/gpu": "GPU + host + kuyruk durumu",
                "GET  /api/logs": "?level&qtext",
                "GET|PUT /api/settings": "ayarlar",
                "POST /api/exports": "{type:video|excel|word} → export işi",
                "GET  /api/exports/{id}": "export durumu",
            },
            "enums": ENUMS,
            "notes": {
                "schema": "Alan adları video_analytics_schema_v2 ile hizalı: "
                          "public_id, event_group_id, event_status, "
                          "identity_match_status, analysis_job/analysis_run.",
                "coords": "bbox_x / bbox_y / bbox_width / bbox_height — hepsi "
                          "0~1 normalize (DB şemasıyla birebir). Frontend "
                          "piksele kendi çevirir: px = bbox_x * görünenGenişlik.",
                "time": "Zaman damgaları ISO-8601 + KST (+09:00). "
                        "Medya zamanı saniye cinsinden float.",
                "range": "Video uçları HTTP Range zorunlu destekler.",
                "sse": "Uzun işler SSE ile akıtılır; üretimde WebSocket'e "
                       "çevrilebilir (mesaj gövdesi aynı kalır).",
            }}


def main():
    global ARGS, STORE
    # Windows konsolu cp949 olabilir — Korece/em-dash yazınca patlar
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--latency", type=float, default=0.05,
                    help="yapay gecikme çarpanı (saniye); 0 = anlık")
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()

    if not (DATA / "catalog.json").exists():
        print("HATA: mock/data bulunamadi. Once calistirin:")
        print("  python tools/gen_mock.py")
        print("  python tools/gen_video.py")
        raise SystemExit(1)

    print("Mock veri yukleniyor ...")
    STORE = Store()
    print(f"  video      : {len(STORE.videos)}")
    print(f"  kamera     : {len(STORE.cameras)}")
    print(f"  galeri     : {STORE.emb.shape[0]} vektor x {STORE.dim} boyut")
    real = sum(1 for o in STORE.gallery if o.get("kind") == "real")
    print(f"  gercek Re-ID: {real} adet (SOLIDER)")

    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    srv.daemon_threads = True
    url = f"http://{ARGS.host}:{ARGS.port}/"
    print("\n" + "=" * 58)
    print(f"  지능형 영상 요약 플랫폼 — Mock")
    print(f"  UI      : {url}")
    print(f"  API     : {url}api/health")
    print(f"  Sozlesme: {url}api/openapi")
    print("=" * 58 + "\nCtrl+C ile durdurun.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nkapatiliyor")


if __name__ == "__main__":
    main()
