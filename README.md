# 지능형 영상 요약 플랫폼 — Frontend Mockup

Uçtan uca çalışan bir prototip: **gerçek HTTP API**, **gerçek video oynatma
(Range + seek)**, kural tabanlı **후보 구간 선정**, ve tüm ekranlar.

> **Kapsam (güncel):** video + timeline + özet.
> Görsel arama (CLIP) **yok** — boru hattı Plan 1.
> Re-ID kodda çalışıyor ama arayüzde **gizli**; backend'de ~1 ay sonra gelecek.

Ayrıca sıfırdan öğrenmek için 12 derslik bir laboratuvar var:
[`/lab/`](http://127.0.0.1:8000/lab/) — test adımları
[`TEST-ADIMLARI.md`](TEST-ADIMLARI.md)'de.

Tasarım kararlarının gerekçeleri ve backend'e sorulacak sorular için
[`PROJE-NOTLARI.md`](PROJE-NOTLARI.md) dosyasına bakın. Bu README nasıl
çalıştırılacağını ve neyin gerçek, neyin simülasyon olduğunu anlatır.

---

## Hızlı başlangıç

```bat
start.bat
```

Ya da elle:

```bash
pip install numpy pillow          # ffmpeg PATH'te olmalı
python tools/gen_mock.py          # ~5 sn   — veri seti
python tools/gen_video.py         # ~90 sn  — sentetik CCTV videoları
python server.py                  # http://127.0.0.1:8000/
```

Doğrulama:

```bash
python tools/smoke_test.py        # 132 kontrol — UI'ın yaptığı her çağrı
```

Giriş ekranında herhangi bir kullanıcı adı/parola kabul edilir.

---

## Ne gerçek, ne simülasyon?

Bu ayrım önemli — mockup'ı değerlendirirken neye güvenebileceğinizi belirler.

### Gerçek (production'da da aynı çalışacak)

| | Detay |
|---|---|
| **HTTP API** | 34 endpoint, gerçek istek/cevap, gerçek gecikme, sayfalama, filtreleme |
| **Video oynatma** | H.264 + faststart + 1 sn GOP, HTTP **Range** ile gerçek seek |
| **BBox overlay** | Normalize koordinat, letterbox hesabı, `requestVideoFrameCallback`, DPI ölçekleme, tıklama algılama, track yolu |
| **Re-ID benzerliği** | `fur/human/db_datas` içindeki **165 adet gerçek SOLIDER (1024-d) vektörü** üzerinde gerçek kosinüs hesabı + gerçek kırpma görüntüleri |
| **Uzun iş akışı** | SSE ile ilerleme, aşama aşama, iptal edilebilir |
| **Timeline** | Canvas, zoom/pan, swimlane, aday skoru ısı şeridi, 4000+ pencerede akıcı |
| **Zaman dönüşümü** | Medya zamanı ↔ duvar saati ↔ özet video zamanı, tek `TimeMapper` modülünde |

### Simülasyon (gerçek modelin yerini tutan mantık)

| | Nasıl simüle edildi | Gerçekte ne olacak |
|---|---|---|
| **후보 구간 선정** | Track verisinden 7 metrik (hız, mesafe, duruş, çırpınma…) | Optical flow + Kalman durumları üzerinden aynı büyüklükler |
| **VLM** | Aday pencere için hazır Korece açıklama | InternVL2-8B / Qwen2-VL, pencere başına 1–3 sn |
| **이벤트 검색** | Eşanlam sözlüğüyle metin eşleştirme | Aynı — SQL `ILIKE` veya metin embedding'i |
| **Object Detection / PAR** | Senaryo yörüngeleri ve elle yazılmış öznitelikler | YOLOv11 + PAR-Swin |
| **Video içeriği** | PIL ile çizilmiş sentetik CCTV sahnesi | Gerçek VMS kaydı |

**Görsel arama (CLIP) YOK.** Boru hattı Plan 1:

```
Detection + Tracking + PAR
  → event_candidate_score (7 kural tabanlı metrik, göreli eşik)
  → eşiği aşan pencereler VLM'e
  → vlm_event.description → TIMELINE
```

Arama, VLM'in yazdığı açıklamalarda metin filtresidir (~3 ms).
`탑승` → Camera2 @106s, `쓰러` → Camera4 @158s. Türkçe `araca binen adam`
küçük bir eşanlam sözlüğüyle çalışır. Aday skorları timeline'ın üst şeridinde
ısı çubuğu olarak görünür; `◍ 후보 점수` butonu hangi metriğin eşiği aştığını
tablo hâlinde gösterir.

---

## Veri seti

### Senaryo — Area1 (2025-05-20 08:30:00 – 08:33:00)

Dört kamera, tek bir hikâye. Sentetik videolar bu yörüngelerden üretildiği
için **bbox metadata'sı görüntüyle birebir hizalı** — overlay matematiğindeki
en ufak hata gözle görülür.

| Kamera | Yer | Olaylar |
|---|---|---|
| **Camera1** | 정문 (ana kapı) | P1 (beyaz gömlek + sırt çantası) girer → telefonla konuşur → sağa gider. Kırmızı montlu kadın geçer. |
| **Camera2** | 주차장 (otopark) | Siyah sedan girer → **P1 buraya geçer** → araca biner → araç çıkar |
| **Camera3** | 후문 (arka kapı) | Gri montlu adam sürekli gidip gelir (배회 / başıboş dolaşma) |
| **Camera4** | 로비 | Kalabalık akış + 150. saniyede yaşlı biri **yere düşer** |

**Re-ID — şu an gizli.** Backend'de yaklaşık bir ay sonra gelecek; sorgu
fotoğraftan yapılacak. Kod çalışır hâlde duruyor (`Camera1/P1` ↔ `Camera2/P1`
benzerliği **0.9751**, diğerleri **< 0.08**) ama arayüzde kapalı.
Açmak için tarayıcı konsoluna:

```js
localStorage.setItem('ff.reid', '1'); location.reload()
```

### Ölçek ve kenar durumlar

| Grup | Ne gösteriyor |
|---|---|
| **Area2** — 물류창고 | 3 kamera × **24 saat**, ~110 olay, 1439 pencere, **proxy video yok** → büyük ölçekli timeline ve zarif bozulma |
| **Area3** — 근린공원 | `ready` (analiz edilmemiş) + `failed` (CUDA OOM hata mesajıyla) |
| **Area4** — 시내 | `analyzing` (%43, ETA gösterir) + `registered` RTSP kaynağı |
| **Area5** — 실증 데이터셋 | **165 gerçek SOLIDER embedding'i** + gerçek kırpma görüntüleri, `node_id 20003` |

Böylece `video_status` enum'unun her değeri UI'da bir karşılık buluyor.

---

## Ekranlar

| Rota | Ekran | Öne çıkanlar |
|---|---|---|
| `#/single/CAM01` | 단일 영상 요약 | Oynatıcı + bbox overlay + timeline + olay akışı + 이벤트 검색 + 후보 점수 |
| `#/multi/G1` | 복합 상황 요약 | Kamera başına satır (swimlane), `event_group_id` ile aynı sahne |
| `#/objects/CAM01` | 객체 목록 + Re-ID | ⏸ **gizli** — `ff.reid` bayrağıyla açılır |
| `#/jobs` | 작업 관리 | İş geçmişi, ilerleme çubukları, iptal, hata detayı |
| `#/system` | 시스템 | GPU/RAM/disk göstergeleri (2 sn'de bir), log görüntüleyici |
| `#/settings` | 설정 | Özet, aday eşiği, model seçimi, oynatma, dil |
| `#/api` | API 계약 | 34 endpoint + veri formatı — **backend'e verilecek liste** |

Sağ üstteki **KO / TR** düğmesi arayüz dilini değiştirir.

### Denemeye değer akışlar

**1. 이벤트 검색 + 후보 구간 점수**
`#/single/CAM02` → arama kutusuna `탑승` yazın; sonuç anında gelir.
Sonra `◍ 후보 점수` butonuna basın: hangi pencerenin hangi metrik yüzünden
VLM'e gönderildiği tablo hâlinde. Timeline'ın üst şeridi bu skorların
görselleştirmesi, kesik kırmızı çizgi eşik.

**2. Olay onaylama (`event_status`)**
Olay listesinde `확정` / `오탐` butonları. AI önerir, operatör onaylar.
`dismissed` olaylar soluklaşır ama silinmez — denetim izi kalır.

**3. Gerçek SOLIDER verisi** (Re-ID açıksa)
`#/objects/CAM20` → 165 gerçek kırpma görüntüsü → gerçek 1024-d vektörler
üzerinde gerçek kosinüs araması.

**4. Overlay doğruluğu**
Oynatıcıda `b` tuşu bbox'ları açıp kapatır. Pencereyi yeniden boyutlandırın,
tam ekrana geçin — kutular kaymamalı (letterbox hesabı). Bir kutuya tıklayın
→ nesne detayı açılır.

**5. Kenar durumlar**
`#/single/CAM09` (failed) → hata mesajı. `#/single/CAM05` (proxy yok) →
neden oynatılamadığı, kodek/faststart/GOP tanısıyla birlikte açıklanır ama
timeline çalışmaya devam eder.

**Klavye:** `boşluk` oynat/duraklat · `←/→` 5 sn (Shift ile 1 sn) ·
`n/p` sonraki/önceki olay · `b` bbox

---

## Kendi videonu ekle

```bash
python tools/add_video.py "D:\kayit.mp4" --motion --name Camera99 \
       --start "2025-05-20T09:00:00"
```

Yaptıkları:

1. `ffprobe` ile gerçek metadata okur (kaynak HEVC/MJPEG ise uyarır)
2. **Önce remux dener** — kaynak H.264 + yuv420p ise yeniden kodlama yok,
   sadece MP4'e sarma + `-movflags +faststart`. 30 dakikalık video için
   90 saniye yerine ~2 saniye, kalite kaybı sıfır. Koşullar sağlanmazsa
   `libx264` ile yeniden kodlar (1 sn GOP → hassas seek).
   `--force-encode` ile remux'u atlayabilirsin.
   Ayrıntı: [`PROJE-NOTLARI.md` §9.5](PROJE-NOTLARI.md)
3. `--motion` ile hareket tabanlı sözde-tespit üretir: kare farkı → kaba
   ızgara → bağlı bileşen → IoU eşlemeli takip. **Bu bir Object Detection
   değildir**, ama kutular gerçekten hareket eden bölgeleri izler, yani
   overlay/timeline/nesne listesi kendi videonuzda uçtan uca çalışır.
   (Doğruluk kontrolü: sentetik CAM03'e uygulandığında kutular gerçek
   yörüngeyle x ekseninde ~0.02 sapmayla örtüşüyor.)
4. Katalogu günceller → sol ağaçta yeni kamera belirir

```bash
python tools/add_video.py --list        # kayıtlı videolar
python tools/add_video.py --remove CAM95
```

Sunucuyu yeniden başlatın (katalog açılışta okunuyor).

---

## Dosya haritası

```
vid/
├── PROJE-NOTLARI.md        Tasarım kararları, gerekçeler, backend'e sorular
├── README.md               Bu dosya
├── start.bat               Tek tıkla çalıştır
├── server.py               Mock API sunucusu (stdlib + numpy, bağımlılık yok)
│                             · Range destekli statik servis
│                             · 36 endpoint
│                             · SSE ile iş ilerlemesi ve Re-ID akışı
│                             · gerçek kosinüs Re-ID
├── tools/
│   ├── gen_mock.py         Veri seti üretici (senaryo, PAR, aday skorları)
│   ├── gen_video.py        Sentetik CCTV videosu (PIL → ffmpeg)
│   ├── add_video.py        Kendi videonu ekle (+ hareket tabanlı bbox)
│   └── smoke_test.py       132 uçtan uca kontrol
└── mock/
    ├── index.html
    ├── css/app.css         Tasarım sistemi (Tailwind token'larına birebir çevrilir)
    ├── lab/                12 derslik öğrenme laboratuvarı (beyaz sayfa)
    ├── js/
    │   ├── core.js         DOM yardımcıları, store, i18n, TimeMapper, API, FEATURES
    │   ├── overlay.js      Canvas bbox katmanı (letterbox, rVFC, DPI, hit test)
    │   ├── timeline.js     Canvas zaman ekseni (zoom/pan, swimlane, ısı haritası)
    │   └── app.js          Yönlendirici + 7 ekran
    ├── data/               Üretilen JSON + embeddings.f32 (181 × 1024 float32)
    │   └── catalog_user.json   add_video.py ile eklenenler — gen_mock.py bunu ezmez
    └── assets/
        ├── cam0X.mp4       Sentetik CCTV (H.264, faststart, 1 sn GOP)
        ├── crops/          128px nesne kırpmaları (165'i gerçek SOLIDER verisi)
        ├── thumbs/         Olay küçük görselleri
        └── poster/         Video poster kareleri
```

---

## Bu mockup'ın kanıtladığı mimari kararlar

Bunlar tartışma konusu değil artık — çalışan kod var:

1. **Aday seçimi kara kutu olmamalı.** `event_candidate_score` verisi UI'ya
   açıldığında operatör "bu neden seçildi" sorusunu kendisi cevaplayabiliyor.
   Güven buradan geliyor.
2. **BBox ekranda overlay, export'ta burn-in.** Filtreleme, aç/kapa,
   tıklanabilirlik, yeniden analiz sonrası tutarlılık — hepsi overlay
   sayesinde.

2b. **Normalize `xywh`.** DB şemasıyla birebir (`bbox_x/y/width/height`,
   `numeric(10,7)`, `0~1 정규화`). Frontend tek bir yerde `xyxy`'ye çevirir.
3. **Koordinatlar normalize (0–1).** Pencere boyutundan, tam ekrandan,
   DPI'dan bağımsız çalışıyor.
4. **Detection satır dizisi olarak, zaman aralığına göre sayfalı.**
   Nesne dizisi yerine satır dizisi JSON'u ~⅓'e indiriyor.
5. **Uzun işler için SSE yeterli.** Analiz ilerlemesi SSE ile çalışıyor.
   Backend alarm/bildirim tarafını WebSocket ile yapacak — mesaj gövdeleri
   aynı kaldığı için değişecek tek yer `core.js → listen()`.
6. **Özellikler bayrakla kapatılabilmeli.** Re-ID kodda duruyor ama
   `FEATURES.reid = false`. Backend hazır olunca tek satır değişiyor —
   kod silinip yeniden yazılmıyor.
7. **`video_status` UI'ın omurgası.** Ağaç ikonu, tıklanabilirlik, hata
   mesajı, ilerleme çubuğu — hepsi tek enum'dan türüyor.

---

## Backend'e ne verilecek

`#/api` ekranını açın (veya `curl http://127.0.0.1:8000/api/openapi`).
36 endpoint, istek/cevap şekilleri ve veri formatı kuralları orada.

Backend FastAPI ile bunları yazdığında `/docs` (Swagger UI) otomatik oluşur ve
frontend'in `core.js` içindeki `BASE = '/api'` sabiti dışında hiçbir şey
değişmez.

Cevaplanması gereken sorular `PROJE-NOTLARI.md` bölüm 19'da, her biri
"neden soruyorum" gerekçesiyle ve 🔴🟡🟢 önceliklendirmesiyle listeli.

---

## Bilinen sınırlar

- Sentetik CCTV sahneleri stilize (basit geometrik figürler) — amaç görsel
  gerçekçilik değil, metadata ile birebir hizalı bir doğrulama zemini.
- VLM açıklamaları önceden yazılmış; yeni bir durumu tarif etmez.
- Arama yalnızca VLM'in yazdığını bulur. Görsel arama yok — bu bir eksiklik
  değil, verilen mimari karar.
- `deleted` durumu ve mantıksal silme akışı UI'da yok (backend zaten
  filtreliyor varsayıldı — bu `PROJE-NOTLARI.md` Soru 17).
- Sanallaştırılmış liste yerine `loading="lazy"` kullanıldı; 165 crop için
  yeterli, on binlerce crop'ta windowing gerekir.
- Kimlik doğrulama sahte: token üretiliyor ama doğrulanmıyor.
