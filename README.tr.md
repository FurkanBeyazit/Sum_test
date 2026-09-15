# 지능형 영상 요약 플랫폼 — Arayüz

> Son güncelleme: 2026-09-15
> Korece sürüm: [README.ko.md](README.ko.md) · Ayrıntılı rehberler: `docs/` (depoda değil, yerel diskte)

CCTV kayıtlarını yükleyen, analiz kuyruğuna alan, sonuçları zaman çizgisinde gösteren ve birden çok kamerayı tek eksende karşılaştıran web arayüzü. Veri kaynağı tek: **DVSummary backend**'i (`172.20.14.161:8001`).

```bash
python server.py                                  # http://127.0.0.1:8000
DVSUMMARY_API=http://host:port python server.py   # backend başka makinedeyse
python server.py --port 9000 --host 0.0.0.0       # başka port / dışarıya aç
```

Bağımlılık yok — Python stdlib yeter. Video birleştirme için `ffmpeg` PATH'te olmalı. HLS oynatıcı için `web/vendor/hls.min.js` (yoksa ekran eski oynatıcıya düşer). `docs/start.bat`: tarayıcıyı açıp `server.py`'yi başlatır.

---

## 1. Mimarî

```
tarayıcı ──fetch('/live/…')──► server.py ──HTTP──► DVSummary API (8001)
   ▲                              │
   └────────── JSON ──────────────┘
                                  └── /api/merge/*  (ffmpeg concat → backend'e tek MP4)
```

`server.py` üç iş yapar:

1. `web/` altındaki statik arayüzü sunar (HTTP Range dahil — video seek için).
2. `/live/*` isteklerini backend'e iletir (tarayıcı doğrudan gidemez: farklı origin, backend'de CORS yok).
3. `/api/merge/*` — yüklenen parçaları ffmpeg ile tek MP4'e birleştirip backend'e yükler. Bu iş bize ait.
   ```
   POST   /api/merge                 → {merge_id}
   PUT    /api/merge/{id}/part/{i}   → ham gövde = dosya
   POST   /api/merge/{id}/build      → ffmpeg concat, meta döner
   POST   /api/merge/{id}/upload     → backend'e tek video olarak gider
   DELETE /api/merge/{id}            → geçici dosyaları siler
   GET    /api/health
   ```

Mock veri katmanı 2026-08-27'de kaldırıldı; tam hâli `archive/mock/` altında.


## 2. Ekranlar (rotalar)

| Rota | Dosya | Ne yapıyor |
|---|---|---|
| `#/home` | `screens/home.js` | Başlangıç + "How to Use" + sunucu sağlığı (`/status/health`, 5 sn) |
| `#/upload` | `screens/upload.js` | Parçaları duvar saatine göre sıralar, ffmpeg ile birleştirir, backend'e yükler, analiz başlatır. Aynı adlı grup varsa onu kullanır; koleksiyona atar |
| `#/single/:id` | `screens/single.js` | **Analysis** — oynatıcı + VLM olay zaman çizgisi + bbox katmanı. `?hls=1` HLS'i açar |
| `#/objects/:id` | `screens/objects.js` | **Object** — track şeritleri, PAR araması, kırpımlar, kullanıcı renk ataması, Re-ID kipi (`?reid=<track_id>`) |
| `#/collection/:id` | `screens/collection.js` | **Collection** — bir koleksiyondaki tüm grupları tek gerçek-saat ekseninde; tek oynatıcı, hover ile grup değişir; `events` / `objects` kipi (`?mode=objects`); gruplar arası kişi bağlama |
| `#/summary/:id` | `screens/summary.js` | **Summary** — koleksiyonun sonuç ekranı, salt okunur: sütun = grup, altında olaylar; bağlanmış kişiler ve bağlantı çizgileri. (`#/wall` eski ad, yönlendirilir) |
| `#/manage` | `screens/manage.js` | Koleksiyon/grup/video CRUD + analiz kuyruğu (3 sn yoklama). (`#/jobs` buraya yönlendirilir) |
| `#/system` | `screens/system.js` | GPU + log |
| `#/login` | `screens/login.js` | Giriş formu (backend doğrulama istemiyor) |

Ekranlar birbirini **asla** import etmez; yeni ekran = `screens/` altına dosya + `app.js`'te bir `case`.

### Collection ekranı — son eklenenler (2026-09)

- **Oynatıcı yüksekliği sabit** — zaman çizgisi ne kadar uzarsa uzasın videoyu sıkıştıramaz; uzun liste panelin içinde kayar.
- **Renk oynatma şeridi** — ▶ ⟲ ⟳ düğmelerinin yanında, koleksiyonda *kullanılmış* her renk için bir düğme. Basınca o rengin (= o kişinin) bütün kameralardaki şeritleri baştan sona sırayla oynar, aradaki boşluklar atlanır; aynı bandda üst üste binen/bitişik şeritler tek parça sayılır. Liste bitince durur. Kullanıcının elle araması (seek) listeyi iptal eder. Bir şeride tıklamak tek parça oynatır.
- **Hepsini aç / kapat** düğmesi — hover ile tek band açmanın kalıcı hâli; iki bandı yan yana karşılaştırmak için. Tekerlek zaman eksenini yakınlaştırır, Ctrl+tekerlek listeyi kaydırır.
- **Sürükleme ön izlemesi** — renkli bir şeridi renksiz bir şeridin üstüne sürüklerken hedef kutu ve kırpım çerçevesi kaynağın rengini alır (bağlanınca ne olacağını gösterir).

---

## 3. Dosya düzeni

```
├── server.py                köprü + statik + birleştirme
├── tools/proxy_cache.py     tarayıcıda oynatılabilir yerel proxy üretir (HLS yoksa)
├── web/
│   ├── index.html           tek <script type="module">, build yok
│   ├── css/app.css          tasarım sistemi
│   ├── vendor/hls.min.js    HLS için (Chrome)
│   └── js/
│       ├── core.js          el(), mount(), store, biçimleme, TimeMapper, FEATURES, api
│       ├── backend.js       DVSummary adaptörü — TEK veri kaynağı, tüm uç adresleri burada
│       ├── app.js           yönlendirici (hash → ekran)
│       ├── ui.js            üst çubuk, sol ağaç, oynatıcı kontrolleri, onLeave/runCleanup
│       ├── timeline.js      canvas zaman ekseni (zoom/pan, şeritler, bands)
│       ├── overlay.js       video üstü bbox katmanı (letterbox, rVFC, DPI)
│       ├── bboxfeed.js      bbox verisi için kayan pencere (playhead ±20 sn)
│       ├── hlsplayer.js     grup HLS akışını <video>'ya bağlar
│       ├── groupclock.js    parçalı kayıt: duvar saati ↔ oynatma zamanı
│       ├── collectionclock.js  birden çok grubu tek eksene hizalar (zero / wall)
│       ├── identity.js      "bu ikisi aynı insan" — linkage + renk'in tek sahibi
│       ├── objsearch.js     sınıf + PAR arama paneli (Object ve Collection ortak)
│       ├── parchip.js       PAR rozetleri (yaş/cinsiyet/renk ikonları)
│       ├── fx/aurora.js     login arka planı (WebGL)
│       └── screens/         ekran başına bir dosya
└── docs/ (gitignore)        AKIS-SENARYOSU, ARAYUZ-REHBERI, SISTEM-REHBERI, TEST-ADIMLARI,
                             PROJE-NOTLARI, Postman koleksiyonu, playback_test.html, start.bat
```

Bağımlılık yönü tek yönlü: `app.js → screens/* → ui.js / timeline.js / overlay.js → core.js → backend.js`.

---

## 4. Üç temel mekanizma

**`el()` — DOM kurucu** (`core.js`): template string / innerHTML yok. `el('div.panel', {}, çocuklar…)`; `null`/`false` çocuk atlanır → koşullu render `cond ? el(…) : null`.

**`store` — paylaşılan durum**: oturum, katalog (`groups`, `collections`), dil, süzgeçler. Ekrana özel durum store'a girmez, ekran fonksiyonunun kapanışında yaşar.

**`onLeave()` — ekran ömrü** (`ui.js`): timer / `ResizeObserver` / `EventSource` açan ekran kapanışta bunları `onLeave(() => …)` ile bırakır; `app.js` bir sonraki gezinmede `runCleanup()` çağırır. Uzun `await`'lerden sonra `if (!document.body.contains(node)) return;` kontrolü var.

---

## 5. FEATURES bayrakları (`core.js`)

| Bayrak | Durum | Not |
|---|---|---|
| `objects` | **açık** | `/analysis/result/{id}/tracks`, `/tracks/par/stats`, `/track/{id}/crop` |
| `bbox` | **açık** | `GET /playback/groups/{gid}/bboxes?start_at=&end_at=&format=json` — grup kapsamlı, duvar saatiyle; `bboxfeed.js` üç pencere tutar |
| `merge` | **açık** | Parçalar her zaman ffmpeg ile birleştirilip MP4 olarak yüklenir (AVI tarayıcıda oynamaz) |
| `mergeToggle` | kapalı | Onay kutusu gizli; kip hep açık |
| `hls` | **kapalı (varsayılan)** | `GET /playback/groups/{gid}/hls/media.m3u8`. Sahada parça geçişleri yavaş kaldı → varsayılan eski yol. Ekrandan Stream/HLS anahtarı veya `?hls=1` |
| `reid` | **açık** | `GET /analysis/result/groups/{gid}/video/{vid}/track/{tid}/reid/stream` (SSE) |
| `map`, `candidateScore`, `eventSearch`, `eventStatus`, `snapshot` | kapalı | Karşılığı olan uç yok; kod duruyor |

Konsoldan geçici açma: `localStorage.setItem('ff.reid','1'); location.reload()`.

---

## 6. Kişi kimliği (identity.js) — nasıl saklanıyor

Backend "kişi" kavramı tutmuyor; iki ayrı şey var:

- `/video/object-linkages` → yalnızca **çift**: `(g,v,t) ↔ (g,v,t)`
- `/settings/custom/…` → yalnızca **renk** (serbest JSON)

Kişi = çiftlerin oluşturduğu grafiğin **bağlı bileşeni** (A-B ve B-C yazılmışsa {A,B,C} tek kişi). İsimler (`Person 1, 2…`) kanonik üyeye göre türetilir, saklanmaz. Renk üye başına yazılır ki bileşenler birleşince kaybolmasın. Collection ekranında sürükleyerek gruplar arası bağlama yapılır; Summary ekranı bu bilgiyi yalnızca okur.

---

## 7. backend.js — backend tuhaflıkları burada kapalı

- **Zaman birimi** — `timestamp` bir dönem saniye, bir dönem 1/30000 zaman tabanıydı; `tsToSec()` ikisini de tanır. `frame_index` zaman için kullanılmaz.
- **Sınıf adı** — uç `class_name` vermiyor, yalnızca `class_id`; ad tablosu burada.
- **Sınıf / PAR süzgeci** — uçta yok, süzme istemcide (`par.attributes` sözlüğü üstünde).
- **Lifecycle** — liste ucu giriş/çıkış vermiyorsa ayrıntı ucundan sekizerli havuzla tamamlanır, önbelleğe alınır.
- **Proxy tazeliği** — proxy kaydında kaynağın `guid_id` imzası var; backend sıfırlanıp id'ler yeniden kullanılırsa eski proxy reddedilir.

Kullanılan backend uçları (özet): `/status/health`, `/video`, `/video/groups`, `/video/collections`, `/video/{id}/stream`, `/video/object-linkages`, `/analysis`, `/analysis/result/{id}/…`, `/playback/groups/{gid}/bboxes|hls`, `/settings/custom/…`. Tam liste `docs/DVSummary-Backend.postman_collection.json`.

---

## 8. Oynatma

VMS kayıtları AVI + MPEG-4 Part 2 — tarayıcı açamaz. Üç yol:

1. **Merge (varsayılan)** — yüklerken ffmpeg MP4 üretir, backend'de MP4 durur → `/video/{id}/stream` doğrudan oynar.
2. **HLS** — backend'in grup çalma listesi (`hls` bayrağı / `?hls=1`).
3. **Yerel proxy** — eski kayıtlar için `python tools/proxy_cache.py --list | --all` (`web/assets/proxy/`, depoda yok).

---

## 9. Hata ayıklama

```bash
python server.py --live-only /analysis --live-body -1   # terminali daralt, gövdeyi tam yaz
python server.py --log-file live.log                    # süzgeçsiz, tam trafik dosyaya
grep -A30 'POST .*/analysis' live.log                   # analiz isteğinin tam cevabı
grep '✗' live.log                                       # yalnızca hatalar
```

Terminal süzülür (kırpım ve stream istekleri yazılmaz, gövde 800 karakter); dosya süzgeçsizdir. Tekrarlayan aynı cevaplar bastırılır, iki dakikada bir özet düşer.

---

## 10. Depoya girmeyenler

| Yol | Neden |
|---|---|
| `docs/` | rehberler, notlar, Postman koleksiyonu, `start.bat` |
| `archive/mock/` | 2026-08'de kaldırılan mock katmanı — referans |
| `web/assets/` | üretilen proxy MP4'ler ve küçük resimler (200 MB+) |
| `*.avi`, `*.mp4`, `*.bat`, `live.log` | örnek videolar, kişiye özel başlatma betiği, log |

Arayüzü öğrenmeye `docs/ARAYUZ-REHBERI.md` ile başla; akış senaryoları için `docs/AKIS-SENARYOSU.md`, test adımları için `docs/TEST-ADIMLARI.md`.
