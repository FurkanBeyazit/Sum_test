# Uçtan uca senaryo — 5 video yükle, analiz et, zaman çizgili özeti izle

Bu belge tek bir gerçek oturumu adım adım takip eder. Her adımda:

* **hangi fonksiyon** çalıştı (`dosya:satır`),
* **hangi HTTP isteği** gitti (metot, yol, gövde),
* **backend ne döndü** (gerçek alan adlarıyla),
* **veri nereye yazıldı** (tarayıcı belleği / PostgreSQL / disk / SQLite),
* **bir sonraki adımı ne tetikledi**.

Mock tarafı (`/api/*`, `server.py`'nin sahte veri üreten yarısı) bu belgede yok.
Sadece **LIVE** modu anlatılıyor: `?api=live`, gerçek backend
`http://172.20.14.161:8001`.

---

## 0. Sahne

VMS operatör görüntüleyicisinden 5 kayıt indirdik. Hepsi **AVI + MPEG-4 Part 2**
(tarayıcı hiçbirini açamaz — bu ileride önemli olacak).

| # | Dosya | Gerçek başlangıç | Süre | Bitiş |
|---|-------|------------------|------|-------|
| A | `ch01_20260814_090000.avi` | 09:00:00 | 20:00 | 09:20:00 |
| B | `ch01_20260814_092000.avi` | 09:20:00 | 20:00 | 09:40:00 |
| C | `ch01_20260814_093950.avi` | **09:39:50** | 20:00 | 09:59:50 |
| D | `ch01_20260814_095950.avi` | 09:59:50 | 20:00 | 10:19:50 |
| E | `ch01_20260814_102050.avi` | **10:20:50** | 20:00 | 10:40:50 |

İki tuzak bilerek kondu:

* **B ↔ C arasında 10 saniye çakışma** — C, B bitmeden 10 sn önce başlıyor.
* **D ↔ E arasında 60 saniye boşluk** — kayıt kesintisi.

Beklenen sonuç: toplam ham süre 5 × 1200 = **6000 sn**, kapsanan zaman aralığı
09:00:00 → 10:40:50 = **6050 sn**, boşluk **60 sn**, çakışma **10 sn**,
birleştirilmiş uzunluk **5990 sn**.

---

## 1. Kuşbakışı akış

```
 TARAYICI                    BİZİM SUNUCU              GERÇEK BACKEND
 (mock/js/*.js)              (server.py :8000)         (172.20.14.161:8001)
─────────────────────────────────────────────────────────────────────────────
 addFiles()          ── yok, tamamen yerel ──
        │
 probeDurationMs()   ── yok (AVI'de zaten null döner)
        │
 layoutUpload()      ── yok, sadece çizim
 startDrag()         ── yok (yüklenmemiş dosyada saat bellekte kalır)
        │
 [Upload]
 api.createGroup()  ──►  /live/video/groups      ──►  POST /video/groups
 api.reserve()      ──►  /live/video/reservations──►  POST /video/reservations
 api.upload() ×5    ──►  /live/video/{id}/upload ──►  POST /video/{id}/upload
        │                                             (ffprobe + diske yaz)
 saveStart()        ──►  /live/video/{id}        ──►  PUT  /video/{id}
        │                                             (çubuğu sürükleyince)
 [Run analysis]
 api.analyze() ×5   ──►  /live/analysis          ──►  POST /analysis
        │                                             (analysis_queue satırı)
 queueTick() 3sn'de bir ─►/live/analysis?limit=200──► GET /analysis
        │                                             worker: YOLO→ByteTrack→VLM
        │                                             sonuç → SQLite dosyası
 [Analysis ekranı]
 api.video/summary/events ►/live/analysis/result/{id}/all ► GET .../all
 api.streamUrl()    ──►  assets/proxy/{id}.mp4   (yerel H.264 kopya)
```

Ortadaki sütunun tek işi var: **CORS köprüsü**. Tarayıcı `127.0.0.1:8000`
üzerinden `172.20.14.161:8001`'e doğrudan istek atarsa tarayıcı engeller
(FastAPI'de `Access-Control-Allow-Origin` yok). `server.py` isteği sunucu
tarafında iletir; tarayıcı için her şey aynı origin'dedir.
Köprü: `server.py:623 live()`.

---

## 2. Sayfa açılışı — henüz dosya yok

**Ne çalışır**

```
core.js         API_MODE = 'live'   (?api=live veya localStorage['ff.api'])
core.js         const { initLive } = await import('./live.js');  api = await initLive();
live.js:667     initLive() → proxyIndex()
live.js:56      proxyIndex() → fetch('assets/proxy/index.json')
app.js          boot() → router → screenUpload()
```

`proxyIndex()` **backend'e gitmez**. `tools/proxy_cache.py`'nin ürettiği yerel
dosyayı okur: hangi video id'nin oynatılabilir H.264 kopyası var.

```json
// mock/assets/proxy/index.json — henüz boş
{}
```

Sonra ağaç paneli için gruplar çekilir:

```
→ GET http://172.20.14.161:8001/video/groups
← ✓ 200  41 ms  0.1 KB  application/json
  gelen:
    []

→ GET http://172.20.14.161:8001/video
← ✓ 200  38 ms  0.1 KB  application/json
  gelen:
    []
```

Bu iki satırı terminalde göreceksiniz — `server.py:651` isteği, `:666
_live_done()` cevabı basar. Gövdeyi kısaltan yer `:698 _dump()`
(varsayılan 800 karakter; `--live-body -1` tamamını basar).

**Depolama:** hiçbir yerde. Sonuç `live.js:53 cache.videos`'ta RAM'de durur.

---

## 3. Dosyaları sürükle-bırak — hâlâ tek bir ağ isteği yok

Beş dosyayı bırakma alanına sürüklüyorsunuz (`app.js:2465 drop`, `ondrop`).

### 3.1 `addFiles()` — app.js:2249

Her dosya için bellekte bir nesne kurar:

```js
{
  key: 'f1755158400123-x7k2a',   // client_key olacak, rezervasyonda eşleştirici
  file: File,                    // tarayıcının File nesnesi, diskteki dosyaya işaretçi
  name: 'ch01_20260814_090000',  // uzantısı atılmış hâli
  startAt: Date,                 // otomatik tahmin (aşağıda)
  durationMs: null,
  videoId: null,                 // rezervasyondan sonra dolar
  state: 'pending',              // pending → uploading → done | error
  progress: 0,
  meta: ''                       // sağ paneldeki serbest metin
}
```

**Başlangıç saati nereden geliyor?** `app.js:2252`:

```js
const startAt = (last && last.startAt && last.durationMs)
  ? new Date(last.startAt.getTime() + last.durationMs)   // öncekinin bittiği an
  : new Date();                                          // ilk dosya → şu an
```

Yani zincirleme: 1. dosya "şu an", diğerleri bir öncekinin bitişi. **Bu bir
tahmindir.** AVI'lerde süre okunamadığı için (bkz. 3.2) zincir hiç kurulmaz ve
beş dosya da "şu an" ile başlar — bunları sağ panelden elle düzelteceksiniz.

**Depolama:** `UP.items` dizisi, sadece RAM. Sayfayı yenilerseniz gider.

### 3.2 `probeDurationMs()` — app.js:2059

```js
const v = document.createElement('video');
v.src = URL.createObjectURL(file);
v.onloadedmetadata = () => done(Math.round(v.duration * 1000));
v.onerror         = () => done(null);
setTimeout(()      => done(null), 4000);
```

Dosyayı yüklemeden, tarayıcının kendi çözücüsüyle süreyi okumaya çalışır.
**MP4'te çalışır, AVI'de `onerror` tetiklenir → `null`.** Bizim beş dosyamızın
hepsi AVI, dolayısıyla bu adım beş kez `null` döndürür ve zaman çizgisi
çizilemez:

> süre bilgisi bekleniyor — dosyaları yükleyince zaman çizgisi çizilecek

Gerçek süre **backend'in ffprobe'undan** gelecek (adım 4.3). Bu yüzden akış
"önce yükle, sonra zaman çizgisini düzelt" şeklinde ilerler.

### 3.3 Başlangıç saatlerini düzeltmenin üç yolu

Aynı `it.startAt` değerini değiştiren üç ayrı giriş var; hangisini kullanırsanız
kullanın sonuç aynı yere yazılır.

**a) Sağ paneldeki alan** — `app.js`, `drawSide()` içindeki
`<input type="datetime-local" step="1">`. Saniye hassasiyetinde, en kesin yol.

**b) "⇥ önceki videonun sonuna yapıştır" düğmesi** — bir alttaki. VMS kaydı
kesintisizse tek tıkla zinciri kurar:

```js
it.startAt = new Date(prev.startAt.getTime() + prev.durationMs);
```

**c) Çubuğu zaman çizgisinde sürüklemek** — aşağıda.

Üçü de değişiklikten sonra `redraw()` + `saveStart(it)` çağırır.

### 3.4 Çubuğu sürükleyerek kaydırmak — `startDrag()`

Zaman çizgisindeki her mavi çubuk tutulup sağa sola sürüklenebilir
(`.upbar { cursor: grab }`). `pointerdown` → `startDrag(e, part, L, bar, track)`.
Buradaki `L`, çizimi üreten `layoutUpload()`'ın çıktısı — yapısı için bkz. 3.6.

**Piksel → milisaniye dönüşümü** pointerdown anında bir kez hesaplanır:

```js
const rect    = track.getBoundingClientRect();
const pad     = (L.span || 60000) * 0.04;
const msPerPx = (L.span + pad * 2) / rect.width;
const orig    = it.startAt.getTime();
```

> **Ölçek neden donduruluyor?** Parça kaydıkça `layoutUpload()` yeni bir
> `t0`/`span` üretir; her karede yeniden ölçeklersek çizim büyüyüp küçülür ve
> çubuk imlecin altından kaçar. O yüzden sürükleme boyunca `L` ve `msPerPx`
> sabit, sadece çubuğun `style.left`'i değişir. Bırakınca tam `redraw()`.

**Yapışma (snap).** Diğer parçaların baş ve son noktaları hedef olarak toplanır;
sürüklenen parçanın **başı veya sonu** 8 piksel yakınına gelirse tam oturur:

```js
const snaps  = L.parts.filter(p => p.item !== it).flatMap(p => [p.t0, p.t1]);
const snapMs = msPerPx * 8;
…
if (Math.abs(t - s) < snapMs)                 { t = s; snapped = true; }
if (Math.abs(t + it.durationMs - s) < snapMs) { t = s - it.durationMs; snapped = true; }
```

Yapışınca çubuğun kenarı maviye döner (`.upbar.snap`). **Shift basılı tutarsanız
yapışma kapanır** — çakışmayı bilerek bırakmak istediğinizde.

Her hareket saniyeye yuvarlanır (`Math.round(t / 1000) * 1000`) ve alttaki bilgi
satırı canlı güncellenir:

```
ch01_20260814_093950 → 14.08.2026 09:39:50 … 09:59:50  (−00:00:10)  ⟵ yapıştı
```

Bırakınca (`pointerup`) sıra şu:

```
it.startAt = new Date(next)   →  redraw()  →  saveStart(it)
                                    │             │
                    layoutUpload yeniden koşar    backend'e PUT (aşağıda)
                    çakışma/boşluk anında güncellenir
```

Yani C'yi 10 saniye sağa çekip B'nin ucuna yapıştırdığınız anda kırmızı çakışma
şeridi kaybolur ve `병합 길이` 5990 → 6000 saniyeye çıkar.

**Zaman çizgisine dosya bırakma.** Track'in kendisi de bırakma alanıdır
(`track.addEventListener('drop', …)` → `addFiles()`), alttaki kutuya gitmeye
gerek yok.

### 3.5 Elle girilen saatler

Beş dosyaya tablo 0'daki saatleri giriyorsunuz.

> **Dikkat — saat dilimi.** Bu alan **yerel saattir**. Yüklerken
> `it.startAt.toISOString()` ile UTC'ye çevrilip gönderilir
> (`app.js:2420`). Kore'de (UTC+9) girdiğiniz `09:00:00`, backend'e
> `2026-08-14T00:00:00.000Z` olarak gider. Backend geri döndürdüğünde tarayıcı
> tekrar yerele çevirir, yani ekranda yine 09:00 görürsünüz — ama veritabanına
> ham SQL ile bakarsanız 00:00 görmeniz normaldir, hata değil.

### 3.6 `layoutUpload()` — çizimi üreten saf fonksiyon

Çizimi üreten saf fonksiyon. Ağ yok, backend yok.

Tek koşul **`startAt`**: süresi henüz bilinmeyen dosya (AVI, ya da yükleme
öncesi her dosya) da çizilir — yoksa kullanıcı yüklemeden önce hiçbir şey
görmez ve sürükleyecek bir çubuğu olmaz. Bu parçalar `est:true` ile
işaretlenir, `EST_DUR_MS` (10 dk) varsayılan uzunlukla taralı çizilir ve
**boşluk/çakışma hesabına katılmaz** — tahmini uzunluktan uydurma kırmızı
bant üretmemek için.

```js
const parts = usable.map(i => {                 // usable = startAt'i olanlar
  const est = !i.durationMs;
  const dur = i.durationMs || EST_DUR_MS;
  return { item: i, est, dur,
           t0: i.startAt.getTime(), t1: i.startAt.getTime() + dur };
}).sort((a, b) => a.t0 - b.t0);

const solid = parts.filter(p => !p.est);        // yalnız kesin süreliler
let cursor = solid[0].t1;
for (let i = 1; i < solid.length; i++) {
  const p = solid[i];
  if (p.t0 < cursor)      overlaps.push({ t0: p.t0, t1: Math.min(cursor, p.t1), … });
  else if (p.t0 > cursor) gaps.push({ t0: cursor, t1: p.t0 });
  cursor = Math.max(cursor, p.t1);
}
```

Bizim beş dosyayla dönen nesne:

```js
{
  t0: 1755162000000,          // 09:00:00
  t1: 1755168050000,          // 10:40:50
  span:      6050000,         // 6050 sn
  gaps:     [{ t0: 10:19:50, t1: 10:20:50 }],      // 60 sn
  overlaps: [{ t0: 09:39:50, t1: 09:40:00, a: B, b: C }],  // 10 sn
  gapMs:      60000,
  overlapMs:  10000,
  mergedMs: 5990000,          // kesin süreli parçaların kapsamı - gapMs
  estCount: 0                 // süresi tahmini parça sayısı (taralı çizilir)
}
```

Ekranda: mavi çubuklar (parçalar), gri kesikli blok (boşluk), **kırmızı ince
şerit** (çakışma — `app.js:2170`, tooltip'i `중복 00:00:10 — C tarafından
kesilecek`). Altındaki satır (`app.js:2122`):

```
병합 길이 01:39:50 · 공백 00:01:00 · 중복 00:00:10 (뒤 영상에서 잘림)
```

> **Bu satır şu an bir niyet beyanıdır.** Çakışmayı gösterir ama henüz
> kesmez — kesme işi oynatma tarafında yapılacak (bkz. bölüm 11).

---

## 4. [Upload] — `doUpload()` app.js:2396

Backend **iki fazlı** çalışır: önce kimlikleri rezerve et, sonra her kimliğe
dosyayı yükle. Sebebi: `segment_index`, `prev_video_id`, `next_video_id`
alanlarının doğru zincirlenmesi. Tek tek yüklerken sıra karışabilir; rezervasyon
tek bir istekte sırayı sabitler.

### 4.1 Grup oluştur — `api.createGroup()` live.js:390

`UP.groupId` boşsa önce koleksiyon açılır.

```js
createGroup: (name, description) => req('/video/groups', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ name, description: description || '' }),
})
```

> Bu uç **JSON kabul etmez**, form-encoded ister. JSON gönderirseniz 422 alırsınız.

**İstek**

```http
POST /video/groups HTTP/1.1
Content-Type: application/x-www-form-urlencoded

name=%EA%B4%91%EB%AA%85%EC%97%AD+%C2%B7+2026-08-14&description=
```

**Cevap**

```json
{
  "id": 7,
  "name": "광명역 · 2026-08-14",
  "description": null,
  "created_at": "2026-08-14T00:11:02.418Z",
  "updated_at": "2026-08-14T00:11:02.418Z"
}
```

**Depolama:** PostgreSQL `video_group` tablosunda bir satır.
Tarayıcıda `UP.groupId = 7`. Ekranda toast: `그룹 생성됨 · id 7`.

### 4.2 Beş kimlik rezerve et — `api.reserve()` live.js:396

```js
reserve: (groupId, clientKeys) => req('/video/reservations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    group_id: Number(groupId),
    videos: clientKeys.map(k => ({ client_key: k })),
  }),
})
```

**İstek**

```http
POST /video/reservations
Content-Type: application/json

{
  "group_id": 7,
  "videos": [
    { "client_key": "f1755158400123-x7k2a" },
    { "client_key": "f1755158400561-m4p1c" },
    { "client_key": "f1755158400902-q9w3e" },
    { "client_key": "f1755158401244-z2n8b" },
    { "client_key": "f1755158401587-r6t5y" }
  ]
}
```

**Cevap — `201 Created`, bir dizi** (nesne değil, dizi; `res.map` bu yüzden
çalışıyor):

```json
[
  { "client_key": "f1755158400123-x7k2a", "video_id": 11, "guid_id": "8e1c…", "segment_index": 0, "segment_count": 5, "prev_video_id": null, "next_video_id": 12 },
  { "client_key": "f1755158400561-m4p1c", "video_id": 12, "guid_id": "3a77…", "segment_index": 1, "segment_count": 5, "prev_video_id": 11,   "next_video_id": 13 },
  { "client_key": "f1755158400902-q9w3e", "video_id": 13, "guid_id": "b209…", "segment_index": 2, "segment_count": 5, "prev_video_id": 12,   "next_video_id": 14 },
  { "client_key": "f1755158401244-z2n8b", "video_id": 14, "guid_id": "d5f0…", "segment_index": 3, "segment_count": 5, "prev_video_id": 13,   "next_video_id": 15 },
  { "client_key": "f1755158401587-r6t5y", "video_id": 15, "guid_id": "1c94…", "segment_index": 4, "segment_count": 5, "prev_video_id": 14,   "next_video_id": null }
]
```

Bizim koddan **kesin kullandığımız iki alan** `client_key` ve `video_id`
(`app.js:2409`):

```js
const byKey = new Map(res.map(r => [r.client_key, r]));
…
it.videoId = r.video_id;
```

`client_key` neden var? Cevabın sırası garanti değil; hangi kimliğin hangi yerel
dosyaya ait olduğunu bu anahtar söyler.

**Depolama:** PostgreSQL `video` tablosunda **beş satır**, ama henüz dosya yok:

| id | group_id | status | storage_uri | duration_ms | segment_index |
|----|----------|--------|-------------|-------------|---------------|
| 11 | 7 | `RESERVED` | `…/11.pending` | NULL | 0 |
| 12 | 7 | `RESERVED` | `…/12.pending` | NULL | 1 |
| … | | | | | |

Bu yüzden `live.js:72 mapStatus()` en başta şunu yapar:

```js
if (s0 === 'RESERVED' || String(v.storage_uri || '').endsWith('.pending'))
  return 'registered';
```

`registered` = "kayıt var, video yok". Ağaçta soluk görünür, tıklanamaz,
`/video/11/stream` çağrılırsa 404 döner.

### 4.3 Dosyaları sırayla yükle — `api.upload()` live.js:406

`for (const it of todo)` döngüsü, **sırayla** (paralel değil — 5 × yüzlerce MB
aynı anda gitmesin diye).

```js
const fd = new FormData();
fd.append('file', file, file.name);
fd.append('name', fields.name);
if (fields.description) fd.append('description', fields.description);
if (fields.start_at)    fd.append('start_at', fields.start_at);
fd.append('is_ptz', 'false');

const x = new XMLHttpRequest();
x.open('POST', `/live/video/${videoId}/upload`);
x.upload.onprogress = e => onProgress(e.loaded / e.total);
```

`fetch` yerine `XMLHttpRequest` kullanılmasının tek sebebi: **`fetch`'te yükleme
ilerlemesi yok.** Satırdaki yüzde çubuğu `x.upload.onprogress`'ten besleniyor
(`app.js:2422` → `drawList()`).

**İstek (video 11)**

```http
POST /video/11/upload
Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryAbC123

------WebKitFormBoundaryAbC123
Content-Disposition: form-data; name="file"; filename="ch01_20260814_090000.avi"
Content-Type: video/x-msvideo

<~380 MB ikili veri>
------WebKitFormBoundaryAbC123
Content-Disposition: form-data; name="name"

ch01_20260814_090000
------WebKitFormBoundaryAbC123
Content-Disposition: form-data; name="start_at"

2026-08-14T00:00:00.000Z
------WebKitFormBoundaryAbC123
Content-Disposition: form-data; name="is_ptz"

false
------WebKitFormBoundaryAbC123--
```

**Köprü ne yapıyor?** `server.py:641`:

```python
body = self.rfile if n > 4 << 20 else self.rfile.read(n)
```

4 MB'den büyük gövde **belleğe alınmaz**, soket doğrudan akıtılır. 380 MB'lık
dosya için kritik — yoksa `server.py` her yüklemede 380 MB RAM yerdi.

**Cevap — `200 OK`, güncellenmiş `VideoResponse`:**

```json
{
  "id": 11,
  "guid_id": "8e1c…",
  "group_id": 7,
  "name": "ch01_20260814_090000",
  "description": null,
  "status": "UPLOADED",
  "analysis_status": "pending",
  "storage_uri": "/data/videos/7/11.avi",
  "db_file_path": null,
  "start_at": "2026-08-14T00:00:00Z",
  "duration_ms": 1200000,
  "frame_count": 36000,
  "fps": 30.0,
  "width": 1920,
  "height": 1088,
  "codec": "mpeg4",
  "mime_type": "video/x-msvideo",
  "video_file_size": 398458880,
  "is_ptz": false,
  "latitude": null,
  "longitude": null,
  "segment_index": 0,
  "segment_count": 5,
  "prev_video_id": null,
  "next_video_id": 12,
  "created_at": "2026-08-14T00:11:02Z",
  "updated_at": "2026-08-14T00:13:47Z"
}
```

**Backend bu istekte üç şey yaptı:**

1. Dosyayı diske yazdı → `storage_uri` artık `.pending` değil.
2. **ffprobe çalıştırdı** → `duration_ms`, `fps`, `width`, `height`,
   `frame_count`, `codec`, `video_file_size` dolduruldu. AVI'nin süresi işte
   buradan geliyor — tarayıcının okuyamadığı bilgi.
3. `status` → `UPLOADED`, `analysis_status` → `pending`.

**Tarayıcı ne yapıyor?** `app.js:2423`:

```js
it.state = 'done';
if (v && v.duration_ms) it.durationMs = v.duration_ms;   // ← zaman çizgisi artık çizilebilir
redraw();
```

Beşinci dosya bittiğinde `layoutUpload()` artık `null` dönmez ve **çakışma/boşluk
görselleşir**. Toast: `업로드 완료`.

`live.js:427`'de `cache.videos = null` yapılır — bir sonraki `allVideos()`
çağrısı listeyi backend'den tazeler.

**Terminal çıktısı (her dosya için bir çift):**

```
→ POST http://172.20.14.161:8001/video/11/upload
  gönderilen:
    ------WebKitFormBoundary… (ikili veri, okunamadı)
← ✓ 200  18412 ms  1.2 KB  application/json
  gelen:
    {
      "id": 11,
      "status": "UPLOADED",
      "duration_ms": 1200000,
      …
```

### 4.4 Bu adımın sonunda veri nerede?

| Nerede | Ne var |
|--------|--------|
| Backend diski | `/data/videos/7/11.avi` … `15.avi` — 5 orijinal AVI |
| PostgreSQL `video_group` | 1 satır (id 7) |
| PostgreSQL `video` | 5 satır, `status=UPLOADED`, `analysis_status=pending`, ffprobe alanları dolu |
| PostgreSQL `analysis_queue` | **boş** — analiz henüz istenmedi |
| Tarayıcı RAM | `UP.items` (state `done`, `videoId` dolu), `cache.videos = null` |
| Bizim disk | **hiçbir şey** — `server.py` dosyayı saklamaz, sadece geçirir |

---

## 5. `start_at`'in tam yolculuğu

Girdiğiniz saatin nereye gittiği **yükleme öncesi mi sonrası mı** olduğuna göre
iki farklı uca gider. `saveStart()` bu ayrımı yapan yerdir:

```js
async function saveStart(it) {
  if (!live || !it.videoId || it.state !== 'done') return;   // ← henüz yüklenmedi: çık
  await api.updateVideo(it.videoId, { start_at: it.startAt.toISOString() });
}
```

### Durum A — dosya henüz yüklenmemiş (`state: 'pending'`)

Saat **hiçbir yere gitmez**, sadece `UP.items[i].startAt` içinde bellekte durur.
`saveStart()` ilk satırda çıkar. Değer, upload sırasında multipart gövdenin bir
alanı olarak gider (`api.upload`, `live.js`):

```js
if (fields.start_at) fd.append('start_at', fields.start_at);
```

```
POST /video/11/upload
  file      = <AVI ikili>
  name      = ch01_20260814_090000
  start_at  = 2026-08-14T00:00:00.000Z      ← burada
  is_ptz    = false
```

Backend bunu `video.start_at` sütununa yazar ve dönen `VideoResponse`'ta geri
verir.

### Durum B — dosya yüklenmiş (`state: 'done'`, `videoId` dolu)

Artık `video` satırı var, yani güncelleme ayrı bir uca gider —
`api.updateVideo()` (`live.js`):

```js
updateVideo: (id, fields) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined && v !== null && v !== '') p.set(k, v);
  cache.videos = null;                    // liste bayatladı, tazelensin
  return req(`/video/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p,
  });
}
```

**İstek**

```http
PUT /video/13
Content-Type: application/x-www-form-urlencoded

start_at=2026-08-14T00%3A39%3A50.000Z
```

> Bu uç da **form-encoded**, JSON değil — `POST /video/groups` ile aynı kural.

**Cevap — güncellenmiş `VideoResponse`:**

```json
{ "id": 13, "start_at": "2026-08-14T00:39:50Z", "duration_ms": 1200000,
  "status": "UPLOADED", "analysis_status": "pending", … }
```

Ekranda toast: `ch01_20260814_093950 · 시작 시각 저장됨`.

### Özet tablo

| Nerede düzenlersiniz | Fonksiyon | Yüklenmemişse | Yüklenmişse |
|---|---|---|---|
| Sağ paneldeki `datetime-local` | `drawSide()` → `onchange` | bellekte kalır | `PUT /video/{id}` |
| "⇥ önceki videonun sonuna yapıştır" | `onclick` | bellekte kalır | `PUT /video/{id}` |
| Çubuğu sürükleyip bırakmak | `startDrag()` → `pointerup` | bellekte kalır | `PUT /video/{id}` |
| Analysis ekranındaki ⚠ uyarı paneli | `screenSingle()`, `start_at_missing` ise | — | `PUT /video/{id}` + ekran yenilenir |

Upload ekranındaki üçünün ortak son adımı `saveStart(it)`. Yani "nereye gidiyor" sorusunun tek
cümlelik cevabı: **yükleme öncesi multipart gövdesindeki `start_at` alanına,
yükleme sonrası `PUT /video/{id}`'nin form gövdesine.**

### Neden bu kadar önemli?

`toCamera()` (`live.js`) saati **yalnızca `start_at`'ten** alır —

```js
start_time: v.start_at || null,
start_at_missing: !v.start_at,
```

`start_at` boşsa `start_at_missing: true` olur ve Analysis ekranının bilgi
paneline satır içi bir `datetime-local` alanı çıkar; oradan kaydedince yukarıdaki
PUT gider.

> Eskiden burada `created_at`'e düşülüyordu. `created_at` **kaydın veritabanına
> yazıldığı an**, kaydın çekildiği an değil. Sonuç: VLM metni "16:11:15" derken
> arayüz "18:10" gösteriyordu. Yedek düşürme kaldırıldı; saat yoksa artık
> göreli süre gösterilir ve kullanıcıdan istenir.

---

## 6. [Run analysis] — `doAnalyze()` app.js:2438

```js
const ready = UP.items.filter(i => i.state === 'done' && i.videoId);
for (const it of ready) {
  try { await api.analyze(it.videoId, {}); queued++; }
  catch (e) { if (e.status === 409) clash.push(it); else toast(…); }
}
```

### 6.1 `api.analyze()` — live.js:524

```js
const settings = {};
if (body.prompt) settings.prompt = body.prompt;
if (body.model)  settings.model  = body.model;
return req('/analysis', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ video_id: Number(id), settings }),
});
```

Süzgeç bilinçli: mockun analiz diyaloğu `_sim_sec`, `target_ratio` gibi
simülasyon alanları da üretiyor; backend `settings`'i olduğu gibi
`analysis_queue.request` JSONB'sine yazdığı için bunları göndermek veritabanına
çöp biriktirir.

**İstek**

```json
POST /analysis
{ "video_id": 11, "settings": {} }
```

**Cevap — `201 Created`:**

```json
{
  "video_id": 11,
  "status": "queued",
  "queued_at": "2026-08-14T00:20:11.902Z",
  "started_at": null,
  "completed_at": null,
  "worker_id": null,
  "attempt_count": 0,
  "max_attempts": 3,
  "last_error": null,
  "request": {}
}
```

> Kuyruğun kendi `id`'si bilerek gizlenmiş — Postman testi bunu doğruluyor:
> `pm.expect(response).to.not.have.property("id")`. Kuyruğun anahtarı
> **`video_id`**. Bu yüzden `live.js:286` iş kimliğini `job_id: "Q11"` diye
> türetir ve `live.js:575 job()` çağrısında `^Q` önekini söker.

Beş video için beş kez → toast: `5 job(s) queued`.

### 6.2 409 durumu — ikinci kez analiz

Aynı videoyu tekrar analiz etmeye kalkarsanız:

```json
HTTP/1.1 409 Conflict
{ "video_id": 11, "status": "succeeded", "queued_at": "…", "completed_at": "…" }
```

**Kritik ayrıntı:** backend **iptal edilmemiş her kayıt için** 409 döner —
`succeeded` dahil. Yani bir kez başarıyla analiz edilmiş video doğrudan yeniden
analiz edilemez. Önce kuyruk kaydı silinmeli:

```
DELETE /analysis/11   →  200  { "deleted": true, "video_id": 11 }
POST   /analysis      →  201  { "video_id": 11, "status": "queued" }
```

`live.js:536` bu iki adımı `{ force: true }` seçeneğiyle birleştirir:

```js
if (e.status === 409 && opts && opts.force) {
  await req(`/analysis/${id}`, { method: 'DELETE' });
  cache.results.delete(String(id));
  return post();
}
```

Kullanıcı tarafında bunu `askReanalyze()` (`app.js:2023`) sorar: **Keep results**
/ **Re-analyze**. 409'u sessizce başarı saymak yanıltıcı olurdu — o yüzden ayrı
bir onay var.

> `DELETE /analysis/{id}` **sonuç dosyasını silmez**, sadece kuyruk kaydını
> siler ve videoyu `pending`e döndürür. Eski sonuçlar yenisi yazılana kadar
> diskte kalır.

---

## 7. Backend içinde ne oluyor — 5 iş kuyrukta

Bizim kodumuz burada hiçbir şey yapmıyor; sadece izliyor. Worker sırayla:

```
analysis_queue: queued → running → succeeded
                 │        │           │
                 │        │           └─ completed_at yazılır
                 │        └─ started_at + worker_id yazılır
                 └─ queued_at

video: analysis_status  pending → running → succeeded
       db_file_path     NULL    →  …      → /data/results/11.sqlite
```

Worker'ın boru hattı (bunu `metadata`'dan biliyoruz):

```
NVDEC donanım çözücü
   → YOLO26          (nesne tespiti)     → detection_result_count: 7643
   → ByteTrack       (takip)
   → Qwen3-VL-2B-Instruct (VLM)          → vlm_result_count: 20
   GPU: RTX 3090
```

**VLM örnekleme — kapsama neden %100 değil?**

```
vlm_segment_interval_seconds: 60      // her 60 sn'de bir segment BAŞLAR
vlm_segment_duration_seconds: 10      // segment 10 sn sürer
```

Ritim: **10 sn bak → 50 sn atla → 10 sn bak → …** Yani videonun yaklaşık
**%17'sine** bakılıyor (10/60). 1200 sn'lik bir videoda 20 segment, toplam 200 sn
incelenmiş demek. Aradaki 1000 saniyede olan hiçbir şey görülmüyor.

Bu, arayüzdeki `분석 구간 20개 · 10초씩 / 커버리지 17%` satırının kaynağı.

**Depolama:** her video için ayrı bir **SQLite dosyası** —
`video.db_file_path`. İçinde hem VLM segmentleri hem de **7643 tespit** var.
Tespitler HTTP'den çıkmıyor (bkz. bölüm 12).

---

## 8. Kuyruğu canlı izlemek — `queueTick()` app.js:2521

Gerçek API'de **SSE yok**. `live.js:576 jobStreamUrl()` bilerek `null` döner ve
`app.js` yoklamaya (polling) düşer.

```js
async function queueTick() {
  if (!qAlive) return;
  let rows = [];
  try { rows = (await api.jobs()).items; } catch { /* geçici hata, yut */ }
  …
  const busy = rows.some(j => j.status === 'running' || j.status === 'queued');
  if (qAlive) setTimeout(queueTick, busy ? 3000 : 10000);
}
```

İş varken **3 saniyede bir**, boşta **10 saniyede bir**. `onLeave(() => { qAlive
= false; })` sayesinde ekrandan çıkınca durur (yoksa arka planda sonsuza kadar
istek atardı).

`api.jobs()` (`live.js:570`):

```http
GET /analysis?limit=200
```

```json
[
  { "video_id": 11, "status": "running",   "queued_at": "…:20:11Z", "started_at": "…:20:14Z", "completed_at": null,      "worker_id": "worker-1", "attempt_count": 1, "max_attempts": 3, "last_error": null, "request": {} },
  { "video_id": 12, "status": "queued",    "queued_at": "…:20:12Z", "started_at": null,       "completed_at": null,      "worker_id": null,       … },
  { "video_id": 13, "status": "queued",    … },
  { "video_id": 14, "status": "queued",    … },
  { "video_id": 15, "status": "queued",    … }
]
```

`toRun()` (`live.js:279`) bunu arayüzün beklediği şekle çevirir:

| Backend | Bizim alan | Not |
|---------|-----------|-----|
| `status: "succeeded"` | `status: "completed"` | `RUN_STATUS` sözlüğü, `live.js:262` |
| `status: "cancelled"` | `status: "canceled"` | tek `l` — arayüz enum'u böyle |
| — | `job_id: "Q11"` | `video_id`'den türetiliyor |
| `worker_id` | `stage` / `stage_label` | |
| yok | `progress` | **API'de ilerleme yüzdesi yok** |

İlerleme yüzdesi olmadığı için çubuk `running`ken **belirsiz** çizilir
(`app.js:2541`, `<i class="indet">`, CSS'te sağa sola süzülen animasyon).
Çubuğu 0'da bırakmak "hiç ilerlemiyor" izlenimi verirdi.

Backend `request` JSONB'sine `progress` yazarsa tek satırda gerçek olur —
`live.js:283` zaten okuyor:

```js
const prog = (j.request && typeof j.request.progress === 'number') ? … : …;
```

Ekranda şerit şöyle görünür:

```
Q11  ch01_20260814_090000   ▓▒░▒▓  (kayan)   running    auto-refreshing…
Q12  ch01_20260814_092000                    queued
Q13  ch01_20260814_093950                    queued
Q14  ch01_20260814_095950                    queued
Q15  ch01_20260814_102050                    queued
```

Bir iş başarısız olursa satırda **error** düğmesi çıkar; `last_error` metnini
modalda gösterir (`app.js:2549`).

---

## 9. Oynatılabilir kopya üretmek — `tools/proxy_cache.py`

Analiz biterken buna paralel olarak bunu çalıştırmanız gerekir. **Sebep:**
AVI + MPEG-4 Part 2 hiçbir tarayıcıda açılmaz. İki ayrı sorun var:

* **Konteyner:** AVI. Tarayıcılar MP4/WebM açar; H.264 bile AVI içindeyse
  açılmaz.
* **Kodek:** MPEG-4 Part 2 (DivX/Xvid). Tarayıcıların desteklediği H.264 değil.

```bash
python tools/proxy_cache.py 11 12 13 14 15
python tools/proxy_cache.py --list
```

Betiğin yaptığı (`tools/proxy_cache.py`):

```
api_get('/video/11')          → meta veri (codec alanı burada işe yarayacak)
download(11, tmp)             → GET /video/11/stream, diske indir
probe(tmp)                    → ffprobe: gerçek kodek/konteyner ne?
transcode(tmp, dst, info, api_codec)
save_index(ix)                → mock/assets/proxy/index.json
```

**İki yol var:**

| Durum | İşlem | Süre |
|-------|-------|------|
| Kodek zaten H.264, sadece konteyner yanlış | **remux** — `-c copy`, sadece kap değişir | saniyeler |
| Kodek MPEG-4 / HEVC | **transcode** — yeniden kodlama | dakikalar, GPU/CPU yer |

Bizim beş AVI de MPEG-4 olduğu için hepsi transcode edilir:

```
ffmpeg -i 11.avi -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
       -g 30 -keyint_min 30 -sc_threshold 0 -vsync cfr -r 30 \
       -movflags +faststart -an  mock/assets/proxy/11.mp4
```

Neden bu bayraklar:

* `-g 30 -keyint_min 30 -sc_threshold 0` → **saniyede bir anahtar kare**.
  Zaman çizgisinde bir olaya tıklayınca oraya tam atlayabilmek için; GOP uzun
  olsaydı oynatıcı en yakın anahtar kareye kayardı.
* `-movflags +faststart` → `moov` atomunu dosyanın **başına** taşır. Yoksa
  tarayıcı oynatmaya başlamadan önce dosyanın tamamını indirmek zorunda kalır.
* `-an` → ses atılır, gerekmiyor.

**Bir tuzak:** HEVC'nin AVI içinde standart bir FourCC'si yok, ffprobe
`codec none` der ve çözücü bulunamaz. Betik bu yüzden API'nin bildirdiği kodeği
girişe dayatır:

```python
variants = [([], "")]
if api_codec and api_codec not in ("?", "none"):
    forced = (["-vcodec", api_codec], f", decoder={api_codec} dayatıldı")
    variants = [forced, ([], "")] if unknown else [([], ""), forced]
```

**Çıktı — `mock/assets/proxy/index.json`:**

```json
{
  "11": { "url": "assets/proxy/11.mp4", "mode": "encode", "codec": "h264",
          "duration": 1200.0, "fps": 30.0, "width": 1920, "height": 1088,
          "size_mb": 142.3, "src_codec": "mpeg4", "built_at": "2026-08-14T00:41:12Z" },
  "12": { … }, "13": { … }, "14": { … }, "15": { … }
}
```

**Depolama:** proxy MP4'ler **bizim diskimizde** (`mock/assets/proxy/`), backend
onlardan haberdar değil. Arayüz `live.js:507`'de bunu tercih eder:

```js
streamUrl: (id) => {
  const px = cache.proxy && cache.proxy[String(id)];
  return px ? px.url : `/live/video/${id}/stream`;   // proxy yoksa ham AVI (oynamaz)
}
```

Backend `playback_uri` diye bir alan eklerse bu tek fonksiyon değişir ve
`proxy_cache.py` gereksizleşir.

---

## 10. Analysis ekranı — `screenSingle()` app.js:305

Ağaçtan video 11'e tıklıyorsunuz → `#/single/11`.

```js
const [video, summary, evRes, objRes] = await Promise.all([
  api.video(videoId), api.summary(videoId),
  api.events(videoId, { limit: 400 }), api.objects(videoId, { limit: 400 }),
]);
```

Dört çağrı paralel, ama **backend'e sadece bir istek gider**. Sebebi
`live.js:228 resultOf()`:

```js
if (cache.results.has(key)) return cache.results.get(key);
const p = loadResult(id);        // ← sonucu değil, PROMISE'i önbelleğe al
cache.results.set(key, p);
return p;
```

Sonucu önbelleğe alsaydık, üç çağrı önbellek dolmadan aynı anda başlar ve aynı
isteği **üç kez** atardı (bir ara terminalde aynı 404'ü üç kez görmemizin sebebi
buydu).

### 10.1 Sonucu çekmek

```http
GET /analysis/result/11/all
```

```json
{
  "video_id": 11,
  "status": "succeeded",
  "warning": null,
  "metadata": {
    "decoder_type": "NVDEC",
    "object_detection_model_type": "YOLO26",
    "tracking_algorithm_type": "ByteTrack",
    "vllm_model": "Qwen3-VL-2B-Instruct",
    "vllm_prompt": "이 영상에서 특이사항을 설명하세요",
    "vlm_segment_interval_seconds": 60,
    "vlm_segment_duration_seconds": 10,
    "detection_result_count": 7643,
    "vlm_result_count": 20,
    "frame_count": 36000,
    "gpu_name": "NVIDIA GeForce RTX 3090",
    "completed_at": "2026-08-14T00:38:55Z"
  },
  "results": [
    {
      "id": 1,
      "segment_start_seconds": 0.0,
      "segment_end_seconds": 10.0,
      "image_count": 10,
      "response": { "text": "특이사항 없음" }
    },
    {
      "id": 2,
      "segment_start_seconds": 60.0,
      "segment_end_seconds": 70.0,
      "image_count": 10,
      "response": { "text": "**작업자 2명**이 굴착기 옆에서 이동하고 있습니다. 안전모 착용 확인됨." }
    },
    …  // toplam 20 kayıt
  ]
}
```

> `status !== "succeeded"` ise cevapta ayrıca dolu bir `warning` metni gelir
> (Postman testi bunu doğruluyor) — kısmi sonuç bakıyorsunuz demektir.
> `loadResult()` bunu `out.warning`'e taşır.

**404 alırsanız hata değildir**: o video için analiz hiç çalışmamış demektir.
`live.js:250` bunu yutar, boş sonuç döner:

```js
if (e.status !== 404) { cache.results.delete(String(id)); throw e; }
```

### 10.2 Segment → olay dönüşümü — `toEvent()` live.js:172

Her VLM segmenti bir "olay" nesnesine çevrilir:

```js
const text  = r.response.text ?? r.response.content ?? '';
const quiet = NO_EVENT.test(text) && text.length < 200;
const t0    = r.segment_start_seconds ?? 0;
const t1    = r.segment_end_seconds ?? t0;
```

`NO_EVENT` (`live.js:151`) VLM'in "bir şey yok" cevabını tanır:

```js
/특이\s*사항\s*없음|이상\s*없음|no\s+(?:notable|unusual)/i
```

Üretilen nesne — üstteki 2. segment için:

```js
{
  id: 'V11-S2',
  video_id: '11',
  t_start: 60,  t_end: 70,                      // video içi saniye
  start_timestamp_ms: 60000, end_timestamp_ms: 70000,
  wall_start: '2026-08-14T00:01:00.000Z',       // start_at + t_start
  wall_end:   '2026-08-14T00:01:10.000Z',
  title: '작업자 2명이 굴착기 옆에서 이동하고 있습니다. 안전모 착…',   // ilk satır, 90 karakter
  description: '**작업자 2명**이 …',              // tam metin
  type: 'vlm',  severity: 'warn',  color: '#e0a33e',
  quiet: false
}
```

`quiet` olanlar `color: '#5b6470'` ile **soluk** çizilir — çizgide yer kaplar ama
göz onları atlar.

Duvar saati hesabı `isoPlus()` (`live.js:94`): `start_at + t_start`. Videonun
`start_at`'i yoksa `null` döner ve arayüz göreli süre gösterir. Bölüm 5'teki
saat düzeltmesinin buraya yansıması budur.

### 10.3 Özet — `buildSummary()` live.js:625

```js
{
  duration: 1200,
  summary_duration: 200,          // 20 segment × 10 sn
  event_count: 13,                // quiet OLMAYAN segment sayısı
  models: { detector: 'YOLO26', tracker: 'ByteTrack', vlm: 'Qwen3-VL-2B-Instruct',
            par: null, reid: null },
  segments: [ { src_start: 0, src_end: 10, sum_start: 0, sum_end: 10 }, … ],
  sampling: { interval: 60, duration: 10, coverage: 0.1667 },
  detection_result_count: 7643,   // üretildi ama API'den çıkmıyor
  prompt_used: '이 영상에서 특이사항을 설명하세요',
  warning: null
}
```

`segments`, `TimeMapper`'a beslenir (`app.js:324`) — "özet zamanı ↔ kaynak
zamanı" dönüşümünü yapan sınıf.

### 10.4 Ekranın çizilmesi

```js
TL.setData({ lanes: [{ id: videoId, label: video.name, events }], heat: candHeat });
```

* **Video** — `app.js:359`: `video.has_proxy` ise `<video src="assets/proxy/11.mp4">`.
  `has_proxy` false ise oynatıcı yerine "proxy yok" uyarısı çıkar; ham AVI'yi
  denemek anlamsız.
* **Zaman çizgisi** — `timeline.js`, olayları `t_start`/`t_end` ile yerleştirir,
  `wall_start` ile saat etiketi basar.
* **Sağ panel** — olay listesi. Tıklayınca `videoEl.currentTime = e.t_start`.
* **Üst şerit** — `1920×1088 · 30fps · H264` (proxy'nin kodeki). Bilgi modalinde
  hem `codec (proxy)` hem `codec (원본)` ayrı satırlarda (`app.js:966`).

### 10.5 Oynatma isteği

Proxy varsa istek bizim sunucumuza gider, backend'e hiç dokunmaz:

```
GET /assets/proxy/11.mp4    Range: bytes=0-
← 206 Partial Content       Content-Range: bytes 0-1048575/149225472
```

`206` + `Content-Range` olmadan **ileri sarma çalışmaz** — oynatıcı dosyanın
istediği parçasını isteyemez, baştan indirmek zorunda kalır.

Proxy yoksa `/live/video/11/stream`'e düşer; `Range` başlığı köprüden aynen
geçirilir (`server.py:644`) ama gelen AVI zaten oynamaz.

---

## 11. Çakışma ve boşluk — şu an ne oluyor, ne olmuyor

**Oluyor:** Upload ekranındaki zaman çizgisi çakışmayı kırmızı, boşluğu gri
gösteriyor; `병합 길이` satırı çakışma düşülmüş gerçek uzunluğu veriyor
(`layoutUpload()`, `app.js:2074`).

**Olmuyor:** Video 12 ve 13 hâlâ **iki ayrı oynatıcıda** açılıyor. 13'ün ilk 10
saniyesi 12'nin son 10 saniyesiyle aynı görüntü — iki kez izliyorsunuz, VLM
olayları da iki kez listeleniyor.

**Yapılacak iş** (henüz yazılmadı): grup düzeyinde birleşik bir zaman haritası —

```
birleşik t  →  (video_id, o video içindeki offset)
0      –1200 →  (11, t)
1200   –2400 →  (12, t-1200)
2400   –3590 →  (13, t-2400+10)     ← ilk 10 sn atlanır
3590   –4790 →  (14, t-3590)
4790   –5990 →  (15, t-4790)        ← 60 sn boşluk çizgide boş bırakılır
```

Bunun üstüne: bir parça bitince sonrakine kendiliğinden geçen oynatıcı,
çakışma penceresine düşen olayların tekilleştirilmesi, tek bir sürekli çizgi.

Bunu **arayüz tarafında** yapıyoruz — backend'e hâlâ 5 ayrı video gidiyor, 5 ayrı
analiz oluyor. Backend `POST /analysis`'in `settings`'inde kırpma aralığı kabul
ederse (`{"trim_start_seconds": 10}` gibi) çakışan bölüm hiç analiz edilmez ve
GPU süresi de boşa gitmez.

---

## 12. Şu an gerçek API'den gelmeyen şeyler

| İhtiyaç | Durum | Açılırsa ne değişir |
|---------|-------|---------------------|
| **Tespitler / bbox** | `detection_result_count: 7643` üretiliyor ama SQLite dosyasının içinde kilitli, HTTP'den çıkmıyor | `live.js:498 detections()` — tek fonksiyon. `GET /analysis/result/{id}/detections?start_ms=&end_ms=` yeterli; en ucuzu `GET /analysis/result/{id}/db` ile ham SQLite'ı indirmek |
| **`playback_uri`** | yok, biz `proxy_cache.py` ile yerel kopya üretiyoruz | `live.js:507 streamUrl()` — `proxy_cache.py` tamamen gereksizleşir |
| **İlerleme yüzdesi** | kuyrukta yalnızca durum var | `live.js:283` zaten `request.progress` okuyor; backend yazsın yeter, çubuk gerçek olur |
| **Çakışma kırpma** | yok | `POST /analysis` `settings`'inde aralık kabul etsin, çakışan saniyeler analiz edilmesin |

Ayrıca bir tutarsızlık: ffprobe yüksekliği **1088** derken API **1080**
bildiriyor. Bbox koordinatları normalize (0–1) geleceği için, yanlışını
kullanırsak dikeyde **%0,7** kayma olur. Tespit ucu açıldığında hangisine göre
normalize edildiğini teyit etmek gerekiyor.

---

## 13. Aynı akışı elle sürmek

Tarayıcıyı hiç açmadan, PowerShell'de:

```powershell
$B = "http://172.20.14.161:8001"

# 1) grup
$g = Invoke-RestMethod -Method Post -Uri "$B/video/groups" `
     -Body @{ name = "test · 2026-08-14"; description = "" }
$g.id

# 2) rezervasyon
$body = @{ group_id = $g.id
           videos = @(@{client_key="a"},@{client_key="b"},@{client_key="c"},
                      @{client_key="d"},@{client_key="e"}) } | ConvertTo-Json -Depth 4
$r = Invoke-RestMethod -Method Post -Uri "$B/video/reservations" `
     -ContentType "application/json" -Body $body
$r | Format-Table client_key, video_id, segment_index

# 3) yükleme (curl daha kolay — multipart)
curl.exe -X POST "$B/video/$($r[0].video_id)/upload" `
     -F "file=@C:\path\ch01_20260814_090000.avi" `
     -F "name=ch01_20260814_090000" `
     -F "start_at=2026-08-14T00:00:00Z" -F "is_ptz=false"

# 4) analiz
Invoke-RestMethod -Method Post -Uri "$B/analysis" -ContentType "application/json" `
     -Body (@{ video_id = $r[0].video_id; settings = @{} } | ConvertTo-Json)

# 5) kuyruk
Invoke-RestMethod "$B/analysis?limit=200" | Format-Table video_id, status, worker_id

# 6) sonuç
Invoke-RestMethod "$B/analysis/result/$($r[0].video_id)/all" | ConvertTo-Json -Depth 6
```

Arayüzden yaparken aynı istekleri terminalde görmek için `server.py`'yi tam
gövdeyle başlatın:

```
python server.py --live-body -1
```

`--live-body 0` gövdeleri hiç basmaz, `-1` tamamını basar, sayı verirseniz o
kadar karakterde keser (varsayılan 800).
