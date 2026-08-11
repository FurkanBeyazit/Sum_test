#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Uçtan uca smoke test
====================

Frontend'in her ekranda yaptığı çağrı zincirini aynı sırayla tekrarlar ve
sonuçları doğrular. Tarayıcı olmadan "gerçekten çalışıyor mu" sorusunun
cevabı budur.

Kullanım:
    python server.py &
    python tools/smoke_test.py
"""

import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"
OK, FAIL = 0, 0
FAILURES = []

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def call(method, path, body=None, raw=False, headers=None):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=headers or {})
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        payload = r.read()
        if raw:
            return r, payload
        return json.loads(payload.decode("utf-8"))


def check(name, cond, detail=""):
    global OK, FAIL
    if cond:
        OK += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name} — {detail}")
        print(f"  ✗ {name}   {detail}")


def section(s):
    print(f"\n\033[1m{s}\033[0m" if sys.stdout.isatty() else f"\n== {s} ==")


# ---------------------------------------------------------------------------
section("1. Sunucu / kimlik")
h = call("GET", "/api/health")
check("health 200", h["status"] == "ok")
check("165 gerçek + 16 sentetik = 181 vektör", h["gallery"] == 181, h["gallery"])
check("embedding 1024-d", h["embedding_dim"] == 1024)

lg = call("POST", "/api/auth/login", {"username": "admin", "password": "x"})
check("login token döner", lg["access_token"].startswith("mock."))
me = call("GET", "/api/auth/me")
check("auth/me rol döner", me["role"] == "admin")

# ---------------------------------------------------------------------------
section("2. Katalog (sol ağaç)")
g = call("GET", "/api/groups")
cams = [c for gr in g["groups"] for c in gr["cameras"]]
check("5 grup", len(g["groups"]) == 5, len(g["groups"]))
statuses = {c["status"] for c in cams}
check("tüm video_status değerleri temsil ediliyor",
      {"completed", "ready", "failed", "analyzing", "registered"} <= statuses,
      statuses)
an = [c for c in cams if c["status"] == "analyzing"]
check("analyzing kamerada progress alanı var",
      an and "progress" in an[0], an[0] if an else "yok")
fa = [c for c in cams if c["status"] == "failed"]
check("failed kamerada error mesajı var", fa and fa[0].get("error"))
rt = [c for c in cams if c["source_type"] == "rtsp"]
check("rtsp kaynağı var", bool(rt))

at = call("GET", "/api/attributes")
pk = {d["key"] for d in at["attributes"]["person"]}
check("PAR sözlüğü person özniteliklerini içeriyor",
      {"gender", "upper_color", "carry"} <= pk, pk)
check("renk değerlerinde hex var",
      all("hex" in v for d in at["attributes"]["person"]
          if d["type"] == "color" for v in d["values"]))

# ---------------------------------------------------------------------------
section("3. Tek video özeti ekranı (CAM01)")
v = call("GET", "/api/videos/CAM01")
check("video meta", v["duration"] == 180 and v["fps"] == 10)
check("faststart ✓", v["faststart"] is True)
check("GOP 1s → hassas seek", v["gop_sec"] == 1.0)
check("proxy h264 / kaynak hevc",
      v["codec"] == "h264" and v["src_codec"] == "hevc")

s = call("GET", "/api/videos/CAM01/summary")
check("özet oranı hesaplı", 0 < s["ratio"] < 100, s["ratio"])
check("segment eşleme tablosu var (özet→orijinal)",
      len(s["segments"]) == s["event_count"], len(s["segments"]))
seg0 = s["segments"][0]
check("segment eşlemesi src_start içeriyor",
      {"sum_start", "sum_end", "src_start", "src_end"} <= set(seg0))

ev = call("GET", "/api/videos/CAM01/events")
check("5 olay", ev["total"] == 5, ev["total"])
e0 = ev["items"][0]
check("olayda Korece VLM açıklaması var", "남성" in e0["description"])
check("olayda thumbnail yolu var", e0["thumbnail"])
check("olayda track_ids var", e0["track_ids"])
check("olayda severity/color var", e0["severity"] and e0["color"])

ev2 = call("GET", "/api/videos/CAM01/events?type=phone")
check("olay tipine göre filtre", ev2["total"] == 1, ev2["total"])

# ---------------------------------------------------------------------------
section("4. BBox metadata (overlay için)")
d = call("GET", "/api/videos/CAM01/detections?from=10&to=11")
check("normalize koordinat (DB semasi: 0~1)",
      d["coord"] == "normalized_xywh", d["coord"])
check("kompakt satır formatı — DB alan adlarıyla",
      d["keys"] == ["t", "track_id", "cls", "conf",
                    "bbox_x", "bbox_y", "bbox_width", "bbox_height"], d["keys"])
check("zaman aralığı sayfalaması çalışıyor",
      all(10 <= r[0] <= 11 for r in d["rows"]), d["count"])
check("bbox_x/y 0-1 aralığında",
      all(0 <= r[4] <= 1 and 0 <= r[5] <= 1 for r in d["rows"]))
check("bbox_width/height pozitif ve <=1",
      all(0 < r[6] <= 1 and 0 < r[7] <= 1 for r in d["rows"]))
check("x + width <= 1 (kare dışına taşmıyor)",
      all(r[4] + r[6] <= 1.0001 and r[5] + r[7] <= 1.0001 for r in d["rows"]))
dfull = call("GET", "/api/videos/CAM01/detections?from=0&to=180")
check("tam video bbox sayısı", dfull["count"] > 3000, dfull["count"])
dtrk = call("GET", "/api/videos/CAM01/detections?from=0&to=180&track_ids=1")
check("track_id filtresi", all(r[1] == 1 for r in dtrk["rows"]), dtrk["count"])

# ---------------------------------------------------------------------------
section("5. Video akışı (HTTP Range — seek'in ön koşulu)")
r, body = call("GET", "/api/videos/CAM01/stream", raw=True,
               headers={"Range": "bytes=0-999"})
check("206 Partial Content", r.status == 206, r.status)
check("Content-Range başlığı", r.headers.get("Content-Range", "").startswith("bytes 0-999/"))
check("tam olarak 1000 bayt", len(body) == 1000, len(body))
check("Accept-Ranges: bytes", r.headers.get("Accept-Ranges") == "bytes")
size = int(r.headers["Content-Range"].split("/")[1])
r2, body2 = call("GET", "/api/videos/CAM01/stream", raw=True,
                 headers={"Range": f"bytes={size-500}-"})
check("dosya sonundan Range (seek sonu)", r2.status == 206 and len(body2) == 500)
check("ftyp/moov başta (faststart)", body[4:8] == b"ftyp")
check("moov ilk 1KB içinde (faststart doğrulaması)",
      b"moov" in body[:1000], body[:64])

# ---------------------------------------------------------------------------
section("6. Nesne listesi + PAR filtresi")
o = call("GET", "/api/videos/CAM01/objects")
check("4 nesne", o["total"] == 4, o["total"])
check("crop yolu var", all(x["crop"] for x in o["items"]))
of = call("GET", "/api/videos/CAM01/objects?cls=person&gender=male")
check("cls+gender filtresi", of["total"] == 2, of["total"])
ow = call("GET", "/api/videos/CAM01/objects?upper_color=white")
check("üst giysi rengi filtresi (beyaz gömlekli hedef)",
      ow["total"] == 1 and ow["items"][0]["track_id"] == 1, ow["total"])
oc = call("GET", "/api/videos/CAM01/objects?carry=backpack")
check("taşınan eşya filtresi (sırt çantası)", oc["total"] == 1, oc["total"])

# ---------------------------------------------------------------------------
section("7. 이벤트 검색 — VLM açıklamalarında metin araması")
for query, expect_vid, expect_t in [
        ("탑승", "CAM02", (100, 130)),
        ("쓰러", "CAM04", (140, 180)),
        ("배회", "CAM03", (0, 180)),
        ("yere düşen kişi", "CAM04", (140, 180)),
        ("araca binen adam", "CAM02", (100, 130)),
        ("kırmızı", "CAM01", (0, 60))]:
    res = call("POST", "/api/search", {
        "video_ids": ["CAM01", "CAM02", "CAM03", "CAM04"], "query": query})
    top = res["items"][0] if res["items"] else None
    ok = top and top["video_id"] == expect_vid and         expect_t[0] <= top["t_start"] <= expect_t[1]
    check(f'"{query}" → {expect_vid} @{expect_t[0]}-{expect_t[1]}s',
          ok, f'{top["video_id"]}@{top["t_start"]}s' if top else "sonuç yok")

res = call("POST", "/api/search", {
    "video_ids": ["CAM01", "CAM02", "CAM03", "CAM04"], "query": "탑승"})
check("arama <60ms (basit metin sorgusu)", res["latency_ms"] < 60, res["latency_ms"])
check("taranan olay sayısı raporlanıyor", res["events_scanned"] == 15,
      res["events_scanned"])
check("Türkçe sorgu eşanlamlıyla genişletiliyor",
      len(call("POST", "/api/search",
               {"video_ids": ["CAM02"], "query": "araca binen"})["expanded_terms"]) > 2)
check("sonuçta VLM açıklaması var", bool(res["items"][0]["description"]))
check("arama motoru metin tabanlı (görsel değil)",
      res["engine"] == "text/vlm_description", res["engine"])

nores = call("POST", "/api/search", {"video_ids": ["CAM01"], "query": "zzzqqq"})
check("anlamsız sorgu → 0 sonuç", nores["total"] == 0)

# ---------------------------------------------------------------------------
section("7b. 이벤트 후보 구간 선정 (event_candidate_score)")
cd = call("GET", "/api/videos/CAM04/candidates")
check("pencere skorları dönüyor", cd["count"] > 50, cd["count"])
check("eşik bildiriliyor", 0 < cd["threshold"] < 1, cd["threshold"])
check("metrik sözlüğü geliyor", len(cd["metrics"]) >= 5, len(cd["metrics"]))
w = max(cd["windows"], key=lambda x: x["integrated_score"])
check("her pencerede metrik kırılımı var",
      len(w["scores"]) == len(cd["metrics"]))
check("metrik satırında threshold + exceeded var",
      "threshold" in w["scores"][0] and "exceeded" in w["scores"][0])
check("baskın metrik işaretli", w["top_metric"] in cd["metrics"], w["top_metric"])
sel = call("GET", "/api/videos/CAM04/candidates?only_candidates=1")
check("sadece aday olanlar filtrelenebiliyor",
      all(x["is_candidate"] for x in sel["windows"]) and
      sel["returned"] < cd["count"], sel["returned"])
rng = call("GET", "/api/videos/CAM04/candidates?from=100&to=120")
check("zaman aralığı filtresi", all(x["t_end"] >= 100 and x["t_start"] <= 120
                                    for x in rng["windows"]))
mt = call("GET", "/api/metrics")
check("metrik sözlüğü ayrı uçtan da alınabiliyor", "metrics" in mt)

section("8. Re-ID — GERÇEK kosinüs benzerliği")
rs = call("POST", "/api/reid", {
    "object_id": "CAM01-O1",
    "scope_video_ids": ["CAM02", "CAM03", "CAM04"],
    "exclude_same_video": True})
sid = rs["session_id"]
check("oturum açıldı, havuz hazır", rs["pool_size"] > 0, rs["pool_size"])
check("model SOLIDER", "SOLIDER" in rs["model"])
time.sleep(3)
rd = call("GET", f"/api/reid/{sid}")
cands = rd["candidates"]
check("adaylar geldi", len(cands) > 0, len(cands))
best = cands[0]
check("P1(Camera1) ↔ P1(Camera2) doğru eşleşti",
      best["object_id"] == "CAM02-O12", best["object_id"])
check("benzerlik > 0.9 (aynı kişi)", best["similarity"] > 0.9, best["similarity"])
check("ikinci aday çok düşük (yanlış pozitif yok)",
      len(cands) > 1 and cands[1]["similarity"] < 0.3,
      cands[1]["similarity"] if len(cands) > 1 else "-")
check("adaylarda kamera + zaman bilgisi var",
      best["camera"] and best["wall_time"])

# gerçek SOLIDER galerisine karşı arama
rs2 = call("POST", "/api/reid", {
    "object_id": "R11829", "scope_video_ids": ["CAM20"],
    "exclude_same_video": False})
time.sleep(2.5)
rd2 = call("GET", f"/api/reid/{rs2['session_id']}")
sims = [c["similarity"] for c in rd2["candidates"]]
check("gerçek SOLIDER vektörlerinde arama çalışıyor",
      len(sims) > 0 and max(sims) < 1.0001, f"n={len(sims)} max={max(sims) if sims else 0:.4f}")
check("gerçek veride benzerlikler makul aralıkta",
      sims and -1 <= min(sims) <= max(sims) <= 1,
      f"{min(sims):.3f}..{max(sims):.3f}" if sims else "-")

# ---------------------------------------------------------------------------
section("9. Takip listesi")
tl = call("POST", "/api/tracklists/TL1/members",
          {"object_id": "CAM01-O1", "similarity": 1.0})
tl = call("POST", "/api/tracklists/TL1/members",
          {"object_id": "CAM02-O12", "similarity": best["similarity"]})
check("2 üye eklendi", len(tl["members"]) == 2, len(tl["members"]))
check("üyeler zamana göre sıralı",
      tl["members"][0]["wall_time"] <= tl["members"][1]["wall_time"])
check("üyede crop + kamera var",
      all(m["crop"] and m["camera"] for m in tl["members"]))
tl = call("DELETE", "/api/tracklists/TL1/members/CAM01-O1")
check("üye silinebiliyor", len(tl["members"]) == 1)

# ---------------------------------------------------------------------------
section("10. Uzun işler")
jb = call("POST", "/api/videos/CAM01/analyses",
          {"prompt": "테스트", "_sim_sec": 3})
check("202 + job_id", jb["job_id"].startswith("job-"))
time.sleep(1.2)
j1 = call("GET", f"/api/jobs/{jb['job_id']}")
check("polling ile ilerleme artıyor", 0 < j1["progress"] < 100, j1["progress"])
check("aşama etiketi Korece", bool(j1.get("stage_label")))
time.sleep(3.2)
j2 = call("GET", f"/api/jobs/{jb['job_id']}")
check("iş tamamlandı", j2["status"] == "completed", j2["status"])
jl = call("GET", "/api/jobs")
check("iş geçmişi var", jl["total"] >= 7, jl["total"])
check("başarısız iş kaydı var",
      any(x["status"] == "failed" for x in jl["items"]))

jb2 = call("POST", "/api/videos/CAM02/analyses", {"_sim_sec": 20})
time.sleep(.6)
cx = call("POST", f"/api/jobs/{jb2['job_id']}/cancel")
check("iş iptal edilebiliyor (enum: canceled, tek L)",
      cx["status"] == "canceled", cx["status"])

# ---------------------------------------------------------------------------
section("11. Sistem / ayarlar / export")
gp = call("GET", "/api/system/gpu")
check("GPU cihaz bilgisi", gp["devices"][0]["memory_total_mb"] == 12288)
check("kuyruk durumu", "queue" in gp)
lo = call("GET", "/api/logs?level=ERROR")
check("log seviye filtresi", lo["total"] >= 1, lo["total"])
st = call("GET", "/api/settings")
check("ayarlar + model seçenekleri", "choices" in st and "vlm" in st["choices"])
st2 = call("PUT", "/api/settings", {"analysis": {"candidate_threshold": 0.55}})
check("ayar kaydedilebiliyor", st2["analysis"]["candidate_threshold"] == 0.55)
ex = call("POST", "/api/exports", {"type": "video", "tracklist_id": "TL1"})
check("export işi başladı", ex["export_id"].startswith("exp-"))
time.sleep(4)
ex2 = call("GET", f"/api/exports/{ex['export_id']}")
check("export tamamlandı", ex2["status"] == "completed", ex2["status"])

# ---------------------------------------------------------------------------
section("12. Çoklu kamera ekranı verisi")
tot = 0
for cid in ["CAM01", "CAM02", "CAM03", "CAM04"]:
    e = call("GET", f"/api/videos/{cid}/events")
    tot += e["total"]
check("Area1 toplam olay sayısı", tot == 15, tot)
big = call("GET", "/api/videos/CAM05/events")
check("24 saatlik kamerada çok sayıda olay", big["total"] > 25, big["total"])
seg = call("GET", "/api/videos/CAM05/candidates")
check("24 saat için pencereler seyreltilmiş",
      seg["count"] < 5000, seg["count"])
npv = call("GET", "/api/videos/CAM05")
check("proxy'siz video işaretli", npv["has_proxy"] is False)

# ---------------------------------------------------------------------------
section("13. Statik kaynaklar")
for path, what in [("/", "index.html"), ("/css/app.css", "CSS"),
                   ("/js/app.js", "app.js"), ("/js/core.js", "core.js"),
                   ("/js/overlay.js", "overlay.js"),
                   ("/js/timeline.js", "timeline.js"),
                   ("/assets/thumbs/CAM01-E1.jpg", "olay thumbnail"),
                   ("/assets/crops/CAM01_T1.jpg", "sentetik crop"),
                   ("/assets/crops/real_11829.jpg", "gerçek SOLIDER crop"),
                   ("/assets/poster/CAM01.jpg", "poster")]:
    try:
        r, b = call("GET", path, raw=True)
        check(f"{what} servis ediliyor", r.status == 200 and len(b) > 40,
              f"{r.status} {len(b)}B")
    except Exception as ex_:
        check(f"{what} servis ediliyor", False, str(ex_))

sp = call("GET", "/api/openapi")
check("API sözleşmesi 30+ uç listeliyor", len(sp["paths"]) >= 30, len(sp["paths"]))

# ---------------------------------------------------------------------------
section("14. DB şeması hizalaması (video_analytics_schema_v2)")
en = sp["enums"]
check("analysis_run_status enum'u şemayla aynı",
      en["analysis_run_status"] == ["queued", "running", "completed",
                                    "failed", "canceled"],
      en["analysis_run_status"])
check("event_status enum'u", en["event_status"] ==
      ["candidate", "confirmed", "dismissed"])
check("identity_match_status enum'u", en["identity_match_status"] ==
      ["candidate", "confirmed", "rejected"])

cam1 = next(c for gr in g["groups"] for c in gr["cameras"] if c["id"] == "CAM01")
vfull = call("GET", "/api/videos/CAM01")
check("camera.public_id (uuid)", len(vfull["public_id"]) == 36, vfull["public_id"])
check("camera.latitude/longitude (harita görünümü için)",
      vfull["latitude"] and vfull["longitude"])
check("camera.timezone (duvar saati dönüşümünün kaynağı)",
      vfull["timezone"] == "Asia/Seoul")
check("video_asset.duration_ms / frame_count",
      vfull["duration_ms"] == 180000 and vfull["frame_count"] == 1800)
check("video_asset.time_base (pts/dts ölçeği)",
      vfull["time_base_den"] == 90000)

e1 = call("GET", "/api/videos/CAM01/events")["items"][0]
check("vlm_event.public_id", len(e1["public_id"]) == 36)
check("vlm_event.start/end_timestamp_ms", e1["start_timestamp_ms"] == 3000)
check("vlm_event.occurred_start_at (gerçek saat)",
      e1["occurred_start_at"].startswith("2025-05-20T08:30:03"))
check("vlm_event.severity (smallint)", isinstance(e1["severity_level"], int))
check("vlm_event.status varsayılan candidate", e1["status"] == "candidate")

up = call("POST", f"/api/events/{e1['id']}/status", {"status": "confirmed"})
check("olay 확정 edilebiliyor", up["status"] == "confirmed")
try:
    call("POST", f"/api/events/{e1['id']}/status", {"status": "gecersiz"})
    check("geçersiz event_status reddediliyor", False, "400 beklendi")
except urllib.error.HTTPError as he:
    check("geçersiz event_status reddediliyor", he.code == 400, he.code)
call("POST", f"/api/events/{e1['id']}/status", {"status": "candidate"})
conf = call("GET", "/api/videos/CAM01/events?status=candidate")
check("event_status'a göre filtre", conf["total"] == 5, conf["total"])

eg = call("GET", "/api/event-groups")
check("event_group_id kameralar arası olayları bağlıyor",
      eg["total"] == 4, eg["total"])
inc1 = next(x for x in eg["items"] if x["code"] == "INC-1")
check("INC-1 iki kamerayı kapsıyor (P1 hikâyesi)",
      set(inc1["cameras"]) == {"CAM01", "CAM02"}, inc1["cameras"])
check("INC-1 olayları zaman sıralı",
      [e["occurred_start_at"] for e in inc1["events"]] ==
      sorted(e["occurred_start_at"] for e in inc1["events"]))

ajs = call("GET", "/api/analysis-jobs")
check("analysis_job katmanı var", ajs["total"] == 4, ajs["total"])
multi = next(x for x in ajs["items"] if len(x["run_ids"]) > 1)
check("bir analysis_job birden çok analysis_run içerebiliyor",
      len(multi["runs"]) == 4, len(multi["runs"]))
check("analysis_job.prompt saklanıyor", multi["prompt"])

rs3 = call("POST", "/api/reid", {"object_id": "CAM01-O1",
                                 "scope_video_ids": ["CAM02"]})
time.sleep(2)
rd3 = call("GET", f"/api/reid/{rs3['session_id']}")
if rd3["candidates"]:
    mv = call("POST", f"/api/reid/{rs3['session_id']}/verdict",
              {"object_id": rd3["candidates"][0]["object_id"],
               "status": "confirmed"})
    check("track_identity_match kaydı üretiliyor",
          mv["status"] == "confirmed" and mv["matched_by"] == "user")
    try:
        call("POST", f"/api/reid/{rs3['session_id']}/verdict",
             {"object_id": rd3["candidates"][0]["object_id"], "status": "same"})
        check("geçersiz identity_match_status reddediliyor", False)
    except urllib.error.HTTPError as he:
        check("geçersiz identity_match_status reddediliyor", he.code == 400)

# ---------------------------------------------------------------------------
print("\n" + "=" * 62)
print(f"  GEÇTİ: {OK}    KALDI: {FAIL}")
if FAILURES:
    print("\n  Başarısızlar:")
    for f in FAILURES:
        print("   - " + f)
print("=" * 62)
sys.exit(1 if FAIL else 0)
