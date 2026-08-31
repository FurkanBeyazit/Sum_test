# 지능형 영상 요약 플랫폼 — Arayüz

<sub>[한국어 README](README.ko.md)</sub>

CCTV kayıtlarını yükleyen, analiz kuyruğuna alan ve sonuçları zaman çizgisinde
gösteren web arayüzü. Veri kaynağı tek: gerçek DVSummary backend'i.

```bash
python server.py            # http://127.0.0.1:8000
```

Backend başka bir makinedeyse:

```bash
DVSUMMARY_API=http://host:port python server.py
```

Bağımlılık yok — Python stdlib yeter. Video birleştirme için `ffmpeg` PATH'te
olmalı.

---

## Mimarî

```
tarayıcı ──fetch('/live/…')──► server.py ──HTTP──► DVSummary API
   ▲                              │                (172.20.14.161:8001)
   └────────── JSON ──────────────┘
```

`server.py` üç iş yapar, üçü de küçük:

1. `web/` altındaki statik arayüzü sunar (HTTP Range dahil — seek çalışsın diye)
2. `/live/*` isteklerini backend'e iletir. Tarayıcı oraya doğrudan gidemiyor:
   farklı origin, backend'de CORS başlığı yok
3. `/api/merge/*` — yüklenen parçaları ffmpeg ile tek MP4'e birleştirip
   backend'e akıtır. Bu iş bize ait

---

## Dosya düzeni

```
├── server.py               köprü + statik + birleştirme
├── web/
│   ├── index.html
│   ├── css/app.css         tasarım sistemi
│   ├── js/
│   │   ├── core.js         DOM yardımcıları, store, biçimleme, FEATURES
│   │   ├── backend.js      DVSummary API adaptörü — tek veri kaynağı
│   │   ├── overlay.js      canvas bbox katmanı (letterbox, rVFC, DPI)
│   │   ├── timeline.js     canvas zaman ekseni (zoom/pan, swimlane)
│   │   ├── app.js          yönlendirici (hash → ekran)
│   │   ├── ui.js           üst çubuk, sol ağaç, ekran ömrü
│   │   ├── fx/fibers.js    login arka planı (WebGL2, bağımlılıksız)
│   │   └── screens/        ekran başına bir dosya
│   └── assets/proxy/       yerel oynatma proxy'leri (üretilen, depoda yok)
└── tools/proxy_cache.py    tarayıcıda oynatılabilir proxy üretir
```

---

## Arayüz nasıl çalışıyor

Çatı yok, build adımı yok, bağımlılık yok. Tarayıcı `index.html` içindeki tek
`<script type="module">` etiketini okuyor, gerisi ES modülleri.

### Katmanlar

```
        app.js                yönlendirici
           │
        screens/*.js          ekranlar — birbirini ASLA import etmez
           │
    ┌──────┴──────┬───────────┬────────────┐
  ui.js      timeline.js   overlay.js   fx/fibers.js
    │
  core.js                    her şeyin altı
    │
  backend.js                 tek veri kaynağı
```

Bağımlılık yönü tek yönlü, döngü yok. Bir ekranı silmek başka hiçbir şeyi
bozmuyor; yeni ekran eklemek `screens/` altına bir dosya + `app.js`'te bir
`case` demek.

### Bir ekran açılırken ne oluyor

```
hash değişti  →  app.js route()
                   1. runCleanup()      önceki ekranın timer/observer'ları kapanır
                   2. oturum            store.user yoksa api.me(), yoksa #/login
                   3. katalog           store.groups boşsa api.groups() (bir kez)
                   4. id doğrula        silinmiş video id'si → ilk kayda düş
                   5. screenX(...)      ekran kendi DOM'unu kurar
                        └─ mount(ROOT(), …)   #app tamamen değişir
```

`route()` `hashchange` olayına bağlı. Ekranlar `async`: veriyi kendileri
çekiyor, `app.js` beklemiyor.

### Üç mekanizma

Arayüzün tamamı bu üçünün üstünde duruyor.

**1 · `el()` — DOM kurucu** (`core.js`)

Template string yok, `innerHTML` yok. İç içe çağrı ağacın kendisi:

```js
el('div.panel', {},
  el('div.panel-h', {}, 'Info', el('span.grow'), btn),
  el('div.panel-b', {}, grid));
```

`'div.panel.op-info'` sınıfları ayrıştırıyor, `onclick` doğrudan fonksiyon
alıyor, `style` nesne kabul ediyor, `null`/`false` çocuklar atlanıyor — koşullu
render için `cond ? el(…) : null` yazmak yetiyor.

**2 · `store` — paylaşılan durum** (`core.js`)

Ekranlar arası taşınan tek şey: oturum, katalog, dil, süzgeçler.

```js
store.set({ groups: g.groups });
const gs = store.get('groups');
```

Ekrana özel durum (seçili nesne, atanmış renkler) store'a girmiyor — ekran
fonksiyonunun kapanışında yaşıyor, ekran kapanınca çöp toplayıcıya gidiyor.

> `store` bir yayın/abone mekanizması da taşıyor (`store.on(key, fn)`) ama
> **hiçbir yerde kullanılmıyor**: ekranlar `mount()` ile kendilerini bütün
> olarak yeniden çiziyor. Sınıfta ayrıca hiç okunmayan ~18 anahtar duruyor
> (`playhead`, `showTrails`, `segments`…) — mock döneminden kalma. Temizlenmesi
> gereken bir yer.

**3 · `onLeave()` — ekran ömrü** (`ui.js`)

Ekranlar zamanlayıcı, `ResizeObserver`, `EventSource` açıyor. Kapanışta
kapatılmazlarsa arka planda kalıp yok olmuş DOM'a yazmaya çalışıyorlar:

```js
const t = setInterval(poll, 3000);
onLeave(() => clearInterval(t));
```

`app.js` bir sonraki gezinmede `runCleanup()` ile hepsini çalıştırıyor.

> Bir tuzak: ekran `await api.detections(…)` beklerken kullanıcı gezinebilir.
> Devam eden kod artık ekranda olmayan bir düğüme yazar. Uzun `await`'lerden
> sonra `if (!document.body.contains(vwell)) return;` kontrolü var.

---

## Dosya dosya

### Çekirdek

| Dosya | Satır | Ne yapıyor |
|---|---:|---|
| **`core.js`** | 382 | `el()`, `mount()`, `clear()`; `store`; zaman/boyut biçimleme (`hms`, `dur`, `bytes`); `toast()`, `modal()`; `TimeMapper` (duvar saati ↔ video saniyesi); `FEATURES` bayrakları; `api` nesnesini dışa veriyor |
| **`backend.js`** | 1152 | DVSummary'nin **tek** adaptörü. Ekranlar `fetch` çağırmıyor, hepsi buradan geçiyor. Uç adresleri, sorgu parametreleri, önbellek ve backend tuhaflıklarının tamamı bu dosyada kapalı |
| **`app.js`** | 127 | Yönlendirici. Hash → ekran, oturum/katalog ön koşulu, ekran değişiminde temizlik |
| **`ui.js`** | 294 | Her ekranda tekrar eden parçalar: üst çubuk, sol video ağacı, onay kutusu, yeniden analiz sorusu; `onLeave`/`runCleanup` |

### Canvas katmanları

| Dosya | Satır | Ne yapıyor |
|---|---:|---|
| **`timeline.js`** | 396 | Zaman ekseni. Zoom/pan, şeritler (swimlane), playhead, tıklama→saniye eşlemesi. DPI'a göre ölçekleniyor; `clientWidth`ten genişlik okuyor |
| **`overlay.js`** | 305 | Video üstündeki kutu katmanı. `object-fit: contain` letterbox matematiği: videonun gerçek kare alanı ile `<video>` kutusu farklı, kutular kaymasın diye geometri her yeniden boyutlamada hesaplanıyor. `requestVideoFrameCallback` ile kareye kilitli |
| **`fx/fibers.js`** | 372 | Login arka planı. Ham WebGL2, kütüphane yok. Görünmezken / sekme arka plandayken / `prefers-reduced-motion` açıkken tamamen duruyor |

### Ekranlar

| Dosya | Satır | Rota | Ne yapıyor |
|---|---:|---|---|
| **`upload.js`** | 1252 | `#/upload` | Parçaları duvar saatine göre sıralar, sunucuda ffmpeg ile birleştirir, backend'e yükler, analiz kuyruğuna alır. Grup adı çakışırsa mevcut grubu kullanır |
| **`single.js`** | 915 | `#/single/:id` | Oynatıcı + olay zaman çizgisi + VLM açıklamaları. `timeline.js` ve `overlay.js` burada buluşuyor |
| **`objects.js`** | 632 | `#/objects/:id` | Track listesi, PAR araması, bestshot ızgarası, kullanıcının atadığı renklerle timeline şeritleri |
| **`manage.js`** | 355 | `#/manage` | Grup/video CRUD + analiz kuyruğu (3 sn'de bir yoklama) |
| **`home.js`** | 119 | `#/home` | Sunucu sağlığı, 5 sn'de bir `/status/health` |
| **`system.js`** | 84 | `#/system` | Worker durumları |
| **`login.js`** | 43 | `#/login` | Giriş formu (backend henüz doğrulama istemiyor) |

---

## backend.js — neden bu kadar büyük

Arayüzün geri kalanı temiz kalsın diye backend'in bütün tuhaflıkları tek
dosyada toplanıyor. Ekranlar `api.objects(videoId, {cls, par})` çağırıyor,
altında ne döndüğünü bilmiyor:

- **Zaman birimi** — `timestamp` bir dönem saniye, bir dönem 1/30000 zaman
  tabanıydı (kare başına 1001 birim). `tsToSec()` ikisini de tanıyor.
  `frame_index` zaman için **kullanılmıyor**: analiz hattı 37.2 kare/sn
  sayıyor, video gerçekte 30 fps
- **Sınıf adı** — uç `class_name` vermiyor, yalnızca `class_id`. Ad tablosu
  burada; ilk aramada `[backend] sınıf dağılımı` konsola yazılıyor
- **Sınıf süzgeci** — uçta `class_id` parametresi yok, süzme istemcide
- **PAR süzgeci** — `matched_attribute` hep `null` dönüyor, süzme
  `par.attributes` sözlüğünün üstünde yapılıyor
- **Lifecycle** — liste ucu track'in giriş/çıkış zamanını vermiyorsa ayrıntı
  ucundan sekizerli havuzla tamamlanıyor, sonuç önbelleğe alınıyor
- **Proxy tazeliği** — proxy kaydının içinde kaynağın `guid_id` imzası var;
  backend sıfırlanıp id'ler yeniden kullanılırsa eski proxy reddediliyor

### FEATURES bayrakları

`core.js` başındaki bu nesne, backend'in henüz veremediği yetenekleri kapalı
tutuyor. Kod yazılmış ve duruyor; bayrak `true` olunca çiziliyor.

| Bayrak | Durum | Neyi bekliyor |
|---|---|---|
| `objects` | **açık** | — |
| `bbox` | kapalı | `/playback/groups/{gid}/bboxes` JSON çıktısı (şu an msgpack, grup kapsamlı) |
| `reid` | kapalı | analiz hattında embedding üretimi |
| `map`, `eventSearch`, `eventStatus`, `snapshot` | kapalı | karşılığı olan uç yok |

Konsoldan geçici olarak açmak için:

```js
localStorage.setItem('ff.bbox', '1'); location.reload();
```

---

## Backend'den beklenenler

| İstek | Bugün | Kazanç |
|---|---|---|
| `class_name` alanı | yalnızca `class_id` | çeviri tablosu kalkar |
| `/tracks?class_id=` | uç sınıfa göre süzmüyor | süzme sunucuya geçer, `limit` anlam kazanır |
| Çoklu PAR süzgeci | tek etiket, `matched_attribute` null | süzme sunucuya geçer |
| bbox ucu JSON | msgpack, grup kapsamlı | `FEATURES.bbox` açılır |

---

## Oynatma

VMS kayıtları AVI + MPEG-4 Part 2 — tarayıcı ikisini de açamaz. Backend
`playback_uri` verene kadar yerel proxy üretiyoruz:

```bash
python tools/proxy_cache.py --list     # durum tablosu
python tools/proxy_cache.py --all      # eksik/bayat olanları üret
```

Proxy kaydının içinde kaynağın `guid_id` imzası duruyor; backend sıfırlanıp
video id'leri yeniden kullanılırsa eski proxy otomatik bayat sayılıp yeniden
üretiliyor. Remux sonrası çıktı gerçekten çözülüyor — AVI içindeki bazı H.264
akışları (data partitioning, çift DTS) remux'la kurtarılamıyor, o durumda
otomatik yeniden kodlamaya düşülüyor.

---

## Hata ayıklama

Sunucu `/live` trafiğini iki yere yazabiliyor ve ikisi aynı şey değil.

**Terminal** — okunur kalsın diye süzülüyor: kırpım ve stream istekleri hiç
yazılmıyor, gövdeler 800 karakterde kesiliyor. Aradığın cevabı daralt:

```bash
python server.py --live-only /analysis --live-body -1
```

**Dosya** — süzgeç yok, kırpma yok, her istek zaman damgalı:

```bash
python server.py --log-file live.log
```

Terminalde akıp giden bir şeyi geri saramıyorsun; dosyada `grep` atarsın:

```bash
grep -A30 'POST .*/analysis' live.log      # analiz isteğinin tam cevabı
grep '✗' live.log                          # yalnızca hatalar
```

İkisi birlikte de kullanılabilir: terminal `--live-only` ile dar kalır, dosya
yine her şeyi alır. Dosya `a` kipinde açılıyor, her çalıştırma başına ayırıcı
bir başlık düşüyor.

---

## Depoya girmeyenler

Bu depo yalnızca çalışan arayüzü taşıyor. Aşağıdakiler yerel diskte duruyor
ama `.gitignore` ile dışarıda:

| Yol | Neden |
|---|---|
| `docs/` | rehberler, notlar, Postman koleksiyonu, playback test sayfası |
| `archive/mock/` | 2026-08'de kaldırılan mock katmanı — referans |
| `web/assets/` | üretilen proxy MP4'ler ve küçük resimler (200 MB+) |
| `*.avi`, `*.mp4`, `*.bat` | örnek videolar, kişiye özel başlatma betiği |

`docs/ARAYUZ-REHBERI.md` dosya dosya, blok blok arayüz rehberi — arayüzü
öğrenmenin başlangıç noktası o.
