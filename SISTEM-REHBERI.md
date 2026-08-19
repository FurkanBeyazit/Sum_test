# Sistem Rehberi

Bu belge, projedeki **her parçanın ne olduğunu ve neden orada olduğunu**
anlatır. Amaç şu: sana rastgele bir kod bloğu gösterildiğinde hangi dosyadan
geldiğini, ne işe yaradığını ve kime bağlı olduğunu hemen söyleyebilmen.

Sıfır ön bilgi varsayıyorum. Terimleri geçtikleri yerde açıklıyorum.

---

## 0. Otuz saniyede özet

Elimizde CCTV kayıtları var. Bir operatörün 24 saatlik kaydı baştan sona
izlemesi imkânsız. Sistem şunu yapıyor:

1. Kayıtları bir sunucuya **yüklüyorsun**
2. Sunucu videoyu **analiz ediyor** — insanları/araçları buluyor, takip ediyor,
   sonra bir yapay zekâ modeline "bu 10 saniyede ne oluyor?" diye sorup Korece
   açıklama yazdırıyor
3. **Arayüz** bu açıklamaları zaman çizgisinde gösteriyor; bir olaya tıklayınca
   video o ana atlıyor

Üç ayrı bilgisayar programı var ve sık sık karıştırılıyor:

| Kim | Nerede | Ne yapar |
|---|---|---|
| **Arayüz** (frontend) | Senin tarayıcın | Ekranı çizer, tıklamaları dinler |
| **Bizim sunucu** `server.py` | Senin bilgisayarın, port 8000 | Arayüz dosyalarını servis eder, sahte veri üretir, gerçek API'ye köprü kurar |
| **Gerçek backend** | 172.20.14.161, port 8001 | Videoları saklar, analiz kuyruğunu yönetir, sonuçları döner |

---

## 1. Neden iki sunucu var?

En kafa karıştırıcı nokta bu, o yüzden en başta.

Proje gerçek backend yazılmadan **önce** başladı. Arayüzü geliştirebilmek için
gerçek backend'in **davranışsal ikizi** yazıldı: `server.py`. Aynı adreslere
aynı biçimde cevap veren, ama verileri uydurulmuş bir sunucu.

Şimdi gerçek backend hazır. Ama mock sunucuyu silmedik, çünkü:

- Gerçek backend'de henüz **olmayan** veriler var (bbox koordinatları, nesne
  listesi, Re-ID). Bunların arayüzde çalıştığını göstermenin tek yolu mock.
- Gerçek sunucu paylaşılan; internet yokken veya sunucu kapalıyken de
  çalışabilmek lazım.

Bu yüzden arayüzün **iki modu** var. Sağ üstteki düğmeden geçiliyor:

```
[ MOCK ]  → veriler server.py'nin ürettiği sahte veriler
[ LIVE ]  → veriler gerçek backend'den (172.20.14.161:8001)
```

Seçim `localStorage`'a yazılıyor, sayfa yenilense de kalıyor.

### CORS: /live köprüsü neden var?

Tarayıcılar bir güvenlik kuralı uygular: `127.0.0.1:8000` adresinden açılmış
bir sayfa, `172.20.14.161:8001` adresine doğrudan istek atamaz — farklı
"origin" (köken) sayılır. Karşı taraf açıkça izin vermedikçe tarayıcı isteği
engeller. Buna **CORS** denir.

Gerçek backend bu izni vermiyor. Çözüm: isteği tarayıcı yerine **kendi
sunucumuz** atsın. Sunucular arasında CORS kuralı yoktur.

```
Tarayıcı ──► 127.0.0.1:8000/live/video ──► 172.20.14.161:8001/video
             (aynı origin, sorun yok)      (sunucudan sunucuya, kural yok)
```

`server.py` içindeki `live()` fonksiyonu bunu yapar: gelen isteği aynen iletir,
dönen cevabı aynen geri verir. Ayrıca **her çağrıyı terminale yazar** —
öğrenmek için en değerli araç bu.

---

## 2. Veritabanı — üç tablo

Gerçek backend PostgreSQL kullanıyor (`postgresql://172.20.14.161:5432`,
veritabanı `dvsummary`). Üç tablo var.

### `video_group` — kamera grubu

Aynı kameranın farklı zaman dilimlerine ait kayıtlarını bir arada tutar.
Örnek: "1. Peron kamerası" grubu; içinde 08:00–09:00, 09:00–10:00 kayıtları.

| Sütun | Tip | Anlamı |
|---|---|---|
| `id` | BIGINT | Birincil anahtar |
| `name` | VARCHAR(255) | Grup adı |
| `description` | TEXT | Serbest açıklama |
| `created_at` / `updated_at` | TIMESTAMPTZ | Zaman damgaları |

### `video` — tek bir kayıt dosyası

| Sütun | Anlamı | Dikkat |
|---|---|---|
| `id` | Birincil anahtar | Arayüzde video kimliği olarak kullanılır |
| `guid_id` | UUID | Dış dünyaya açılan kimlik |
| `group_id` | Hangi gruba ait | |
| `prev_video_id` / `next_video_id` | Zincir bağları | Rezervasyon sırasında **otomatik** kurulur |
| `segment_index` / `segment_count` | Kaçıncı parça / toplam kaç parça | Otomatik |
| `name` / `description` | Kullanıcının girdiği | |
| `original_name` | Yüklenen dosyanın adı | |
| `storage_uri` | Video dosyasının sunucudaki yolu | ör. `/mnt/data/videos/1.avi` |
| `db_file_path` | **Analiz sonuçlarının SQLite dosyası** | Video değil! Sık karıştırılıyor |
| `codec` / `width` / `height` / `fps` / `frame_count` / `duration_ms` | Teknik bilgi | Yükleme sırasında `ffprobe` ile **sunucu** okur |
| `start_at` | Kaydın gerçekten başladığı saat | **Kullanıcı girer.** Boşsa olay saatleri hesaplanamaz |
| `is_ptz` | Kamera hareketli mi | PTZ = Pan/Tilt/Zoom |
| `latitude` / `longitude` | Konum | |
| `status` | `RESERVED` → `ACTIVE` | Dosya yüklendi mi |
| `analysis_status` | `pending` / `queued` / `running` / `succeeded` / `failed` | Analiz nerede |

> **`storage_uri` vs `db_file_path`** — ilki videonun kendisi, ikincisi o
> videonun analiz sonuçlarının tutulduğu ayrı bir SQLite dosyası. İsimleri
> benzediği için sürekli karışıyor.

### `analysis_queue` — iş kuyruğu

Analiz hemen yapılmaz; sıraya girer. GPU'lu "worker" programları sırayla alır.

| Sütun | Anlamı |
|---|---|
| `video_id` / `video_guid_id` | Hangi video |
| `status` | `queued` / `running` / `succeeded` / `failed` / `cancelled` |
| `request` | JSONB — analiz ayarları (serbest yapı) |
| `attempt_count` / `max_attempts` | Kaç kez denendi / en fazla kaç |
| `available_at` | Bu andan önce alınmasın |
| `worker_id` | Hangi worker aldı |
| `last_error` | Son hata metni |
| `queued_at` / `started_at` / `completed_at` | Zaman damgaları |

### Dördüncü depo: SQLite sonuç dosyası

Asıl analiz sonuçları PostgreSQL'de **değil**. Her video için ayrı bir SQLite
dosyası üretiliyor: `/mnt/data/video-db/1_20260812T012308496992Z.db`

İçinde iki tür veri var:

- **VLM sonuçları** — 10 saniyelik parçalar için yazılmış Korece açıklamalar.
  Bunlar API'den geliyor. ✅
- **Detection sonuçları** — 7.643 adet kutu koordinatı, takip numarası, sınıf.
  Bunlar **API'den gelmiyor.** ❌ Dosyanın içinde kilitli.

Bu ikinci nokta projenin en büyük eksiği. Bbox çizimi, nesne listesi ve aday
skoru bu veriye bağlı, üçü de bu yüzden kapalı.

---

## 3. Gerçek API'nin uçları

Swagger: `http://172.20.14.161:8001/docs`

### Sağlık

```
GET /status/health              → hepsi tek seferde
GET /status/health/db           → PostgreSQL
GET /status/health/cachedb      → Redis
GET /status/health/vllm         → dil modeli sunucusu
GET /status/health/analysis     → GPU worker'ları
```

`/status/health` cevabı bizim ana sayfadaki yeşil noktaları besler. Bir bileşen
bile bozuksa HTTP 503 döner ve `status: "degraded"` yazar.

### Grup ve video

```
GET    /video/groups            → grup listesi
POST   /video/groups            → grup oluştur   (form-encoded!)
GET    /video/groups/{id}       → grup + içindeki videolar
PUT    /video/groups/{id}       → grup güncelle
DELETE /video/groups/{id}       → grup sil

GET    /video                   → tüm videolar
GET    /video/{id}              → tek video
PUT    /video/{id}              → meta güncelle (start_at buradan girilir)
DELETE /video/{id}              → video sil
GET    /video/{id}/stream       → video baytları (Range destekli)
```

> **form-encoded ne demek?** Çoğu uç JSON alır. Ama grup oluşturma ve video
> güncelleme, HTML formlarının kullandığı `name=deger&baska=deger` biçimini
> ister. Kodda bunu `URLSearchParams` ile yapıyoruz. Yanlış biçim gönderirsen
> 422 alırsın.

### Yükleme — iki fazlı

Bu tasarım ilk bakışta tuhaf gelir ama mantıklı:

```
1) POST /video/reservations
   { "group_id": 1, "videos": [ {"client_key":"a"}, {"client_key":"b"} ] }
   → her biri için id + guid ayrılır
   → prev/next/segment_index SIRAYA GÖRE OTOMATİK hesaplanır

2) POST /video/{id}/upload   (multipart/form-data)
   file, name, description, start_at, is_ptz, latitude, longitude
   → sunucu ffprobe çalıştırır, codec/çözünürlük/fps/süreyi kendisi doldurur
```

Neden iki faz? Çünkü sıralama önce bilinmeli. Dosyalar paralel ve farklı
sürelerde yüklenir; sıra numaralarını yükleme bitişine göre verirsen karışır.

### Analiz

```
POST   /analysis                  { "video_id": 1, "settings": {} }
GET    /analysis                  ?video_id= &status= &limit= &offset=
GET    /analysis/{video_id}       → en son iş
POST   /analysis/{video_id}/cancel
DELETE /analysis/{video_id}       → kuyruk kaydını sil, durumu pending yap
GET    /analysis/result/{video_id}/all   → sonuçlar
```

**En kritik davranış:** `POST /analysis` çağrısı, o video için iptal edilmemiş
bir kayıt varsa **409 Conflict** döner. `succeeded` de buna dahildir. Yani
analiz edilmiş bir videoyu doğrudan yeniden analiz edemezsin — önce `DELETE`
ile kuyruk kaydını silmen gerekir. Arayüzdeki "Re-analyze" düğmesi bu iki adımı
birleştirir.

### Sonuç cevabının şekli

```json
{
  "video_id": 1,
  "status": "succeeded",
  "metadata": {
    "video_path": "/mnt/data/videos/1.avi",
    "sqlite_path": "/mnt/data/video-db/1_....db",
    "decoder_type": "nvdec",
    "object_detection_model_type": "yolo26",
    "tracking_algorithm_type": "bytetrack",
    "vllm_model": "Qwen/Qwen3-VL-2B-Instruct",
    "vlm_segment_interval_seconds": 60,
    "vlm_segment_duration_seconds": 10,
    "frame_count": 5753,
    "detection_result_count": 7643,
    "vlm_result_count": 4,
    "gpu_name": "NVIDIA GeForce RTX 3090"
  },
  "results": [
    {
      "id": 1,
      "segment_start_seconds": 0,
      "segment_end_seconds": 10,
      "image_count": 10,
      "prompt": "당신은 CCTV 관제사입니다…",
      "response": { "text": "특이사항 없음" }
    }
  ]
}
```

`metadata` = analizin nasıl yapıldığı. `results` = VLM'in yazdıkları.

**Örnekleme oranı meselesi:** `interval 60` + `duration 10` demek, "her 60
saniyede bir 10 saniyeye bak" demek. Yani 10 bak → 50 atla → 10 bak. Videonun
yalnızca ~%17'sine bakılıyor. 35. saniyedeki bir olay görülmez. Arayüzde bu
oranı `커버리지 %21` olarak gösteriyoruz ki kimse yanılmasın.

---

## 4. Codec ve proxy meselesi

Bu, projede en çok zaman alan konu oldu. Basitçe:

**Codec** = videoyu sıkıştıran algoritma. Ham video devasa (1080p 30fps için
saniyede ~186 MB); codec bunu 100 kat küçültür.

**Konteyner** = dosya kutusu (`.mp4`, `.avi`). Codec'ten ayrı bir şey.
"MP4 dosyası" demek "oynar" demek değildir; MP4 kutusunun içinde tarayıcının
bilmediği bir codec olabilir.

Tarayıcıların oynatabildiği kombinasyonlar çok dar:

| | Tarayıcı açar mı |
|---|---|
| MP4 + H.264 | ✅ |
| MP4 + MPEG-4 Part 2 (DivX/Xvid) | ❌ |
| **AVI + herhangi bir şey** | ❌ |
| MKV, HEVC (çoğu durumda) | ❌ |

Bizim VMS kayıtları **AVI** konteynerde geliyor; içindeki codec kimi zaman
H.264, kimi zaman HEVC, kimi zaman MPEG-4. Yani **hiçbiri tarayıcıda
oynatılamıyor** — H.264 olanlar bile, çünkü kutu yanlış.

Analiz tarafı etkilenmiyor: sunucudaki ffmpeg/NVDEC bu dosyaları sorunsuz
açıyor. Kırılan tek şey tarayıcıda oynatma.

### Çözüm: proxy

**Proxy** = orijinalin tarayıcı dostu kopyası. `tools/proxy_cache.py` bunu
üretir:

```
GET /video/{id}/stream  →  indir  →  ffmpeg  →  mock/assets/proxy/{id}.mp4
```

Üç garanti verir:

- **MP4 + H.264** → tarayıcı açabilir
- **`-movflags +faststart`** → dosyanın oynatma bilgisi (moov atom) başa alınır.
  Yoksa tarayıcı 80 MB'ın tamamını indirmeden başlayamaz
- **1 saniyelik GOP** → GOP, iki tam kare arasındaki mesafedir. Uzunsa
  timeline'da tıkladığın yere değil, en yakın tam kareye atlar. VMS'te bu 5–10
  saniye olabiliyor; 1 saniyeye çekiyoruz

Kaynak zaten H.264 ise **yeniden kodlama yapılmaz**, sadece kutu değiştirilir
(*remux*): 81 MB video 2 saniyede biter, kalite kaybı sıfır. HEVC/MPEG-4 ise tam
kodlama gerekir, dakikalar sürer.

Bu geçici bir çözüm. Backend proxy üretmeye başlarsa `live.js` içindeki
`streamUrl()` tek satırda değişir ve bu araç gereksizleşir.

---

## 5. Bizim sunucu: `server.py`

1482 satır, tek dosya, sadece Python standart kütüphanesi + numpy. Üç iş yapar.

### İş 1: statik dosya servisi

`mock/` klasöründeki HTML/CSS/JS/video dosyalarını servis eder. **HTTP Range**
destekler — yani tarayıcı "şu videonun 5.000.000. baytından 6.000.000. baytına
kadarını ver" diyebilir. Videoda ileri sarma bu sayede çalışır.

```
Range: bytes=5000000-5999999      ← tarayıcı sorar
206 Partial Content
Content-Range: bytes 5000000-5999999/39962896    ← sunucu cevabı
```

`206` = "isteğin bir kısmını gönderiyorum". `200` olsaydı tüm dosya inecekti.

### İş 2: mock API

`/api/...` ile başlayan istekleri karşılar, sahte veri üretir. Yaklaşık 36 uç.
Gerçek backend'in davranışını taklit eder: sayfalama, filtreleme, gecikme,
uzun işlerin ilerlemesi.

### İş 3: `/live` köprüsü

`/live/...` ile başlayanları gerçek backend'e iletir. Bölüm 1'de anlatılan CORS
çözümü. Ayrıca terminale her isteği ve cevabı yazar.

### Bilinmesi gereken üç ayrıntı

**MIME tipi zorlaması.** Windows'un registry'si `.js` uzantısını bazen
`text/plain` diye kaydeder. Tarayıcı ES modüllerinde MIME'ı katı denetler ve
reddeder. Bu yüzden dosyanın başında MIME tipleri elle bildiriliyor.

**`no-store` önbellek başlığı.** Kod dosyaları için önbellek kapalı; yoksa
"değiştirdim ama hiçbir şey olmuyor" tuzağına düşülüyor.

**Soket hataları yutuluyor.** Tarayıcı video isteğini yarıda kestiğinde Windows
bağlantı hatası fırlatır. Tamamen normaldir; terminale yığın izi basmasın diye
sessizce yakalanıyor.

---

## 6. Arayüz mimarisi

Beş JavaScript dosyası. **Hiçbir kütüphane yok** — React, Vue, jQuery yok. Saf
tarayıcı API'leri. Bu bilinçli bir tercih: her satırın ne yaptığı görünür
olsun, üretimde başka bir çatıya taşınırken engel çıkmasın.

```
mock/js/
├── core.js      494   altyapı: DOM yardımcıları, durum deposu, API istemcisi
├── live.js      670   gerçek API ↔ arayüz arası çevirmen
├── app.js      2614   ekranlar ve yönlendirme
├── overlay.js   302   video üstündeki kutu katmanı
└── timeline.js  388   zaman çizgisi çizimi
```

### `core.js` — altyapı

**`el()`** — HTML üretir. Çatı kullanmadığımız için elle DOM kuruyoruz:

```js
el('div.panel', { onclick: f }, el('span', {}, 'metin'))
```

`div.panel` → `<div class="panel">`. İlk argüman etiket, ikincisi öznitelikler,
gerisi çocuk elemanlar.

**`store`** — uygulamanın hafızası. Bir değer değişince ona abone olan kod
haber alır.

**`API_MODE` ve `FEATURES`** — mock/live seçimi ve özellik anahtarları. Veri
gelmeyen özellikler canlıda kapatılıyor ama **kod silinmiyor**:

```js
bbox: !LIVE,          // detection verisi API'den çıkmıyor
objects: !LIVE,
candidateScore: !LIVE,
```

**`api`** — sunucuya giden bütün çağrılar burada. Canlı modda bu nesne
`live.js`'inkiyle **değiştirilir**; `app.js` bu değişimden habersizdir.

**`TimeMapper`** — üç farklı zaman arasında çevirim yapar: video içi saniye ↔
duvar saati ↔ özet video zamanı.

### `live.js` — çevirmen

Gerçek API'nin cevaplarını arayüzün beklediği şekle sokar. Neden gerekli:
arayüz mock'a göre yazıldı, gerçek API farklı isimler ve yapılar kullanıyor.
Tek tek bütün ekranları değiştirmek yerine tek bir çeviri katmanı koyduk.

Örnek: gerçek API videoyu şöyle döner —

```json
{ "id": 1, "analysis_status": "succeeded", "duration_ms": 192466 }
```

Arayüz şunu bekler —

```js
{ id: "1", status: "completed", duration: 192.466, has_proxy: true }
```

`toCamera()` bu dönüşümü yapar. Benzer şekilde `toEvent()` VLM parçalarını olay
nesnesine, `toRun()` kuyruk satırlarını iş nesnesine çevirir.

Veri kaynağı olmayanlar boş döner ama **doğru şekilde** boş döner — arayüz
çökmesin diye:

```js
detections: async () => ({ fps: 0, coord: 'xywh_norm', keys: [], rows: [] }),
```

### `app.js` — ekranlar

Her ekran bir `async function screenXxx()`. Yönlendirme adres çubuğundaki
`#` kısmına bakar:

```
#/home            → screenHome()
#/upload          → screenUpload()
#/single/1        → screenSingle('1')
```

Canlı modda üç ekran görünür: Home, Upload & Analysis, Analysis. Mock modda
eskiler de durur (çoklu kamera, nesne listesi, sistem, ayarlar).

### `overlay.js` — kutu katmanı

Video dosyasına hiçbir şey basılmaz. Videonun **üstüne şeffaf bir canvas**
konur, kutular oraya çizilir:

```
┌──────────────────┐
│  <canvas>        │  ← şeffaf, kutular burada
├──────────────────┤
│  <video>         │  ← düz video
└──────────────────┘
```

Neden böyle: kutular açılıp kapanabilir, filtrelenebilir, tıklanabilir; yeniden
analiz sonrası video dosyasına dokunmadan güncellenir.

Zor kısmı hizalama. Koordinatlar **0–1 arası normalize** gelir (çözünürlükten
bağımsız olsun diye). Ekrana çevirirken üç şey hesaba katılır:

- **Letterbox** — video 16:9, kutu 4:3 ise üstte altta siyah bant oluşur;
  kutular o bandı hesaba katmalı
- **DPI** — yüksek çözünürlüklü ekranlarda 1 CSS pikseli 2 fiziksel piksel
- **`requestVideoFrameCallback`** — kutular gerçek video karesine senkron
  çizilir, yoksa hızlı sahnelerde kayar

### `timeline.js` — zaman çizgisi

Canvas üzerine çizilen zaman ekseni. Yakınlaştırma, kaydırma, kamera başına
satır (swimlane), aday skoru ısı şeridi. 4000+ pencerede akıcı kalması için
DOM yerine canvas kullanılıyor.

---

## 7. Kod tanıma kılavuzu

**Sana rastgele bir kod bloğu gösterildiğinde nereden geldiğini anlamanın
yolu.**

### Dile bak

| Görürsen | Dil | Nerede olabilir |
|---|---|---|
| `def `, `self.`, `:` ile biten satırlar | Python | `server.py` veya `tools/*.py` |
| `const`, `=>`, `async function` | JavaScript | `mock/js/*.js` |
| `.panel { … }`, `--bg-2` | CSS | `mock/css/app.css` |

### Python ise

| İpucu | Dosya | Ne yapıyor |
|---|---|---|
| `self.send_response(206)`, `Content-Range` | `server.py` | Video parça servisi |
| `def live(self, method, path…` | `server.py` | Gerçek API'ye köprü |
| `LIVE_BASE`, `urllib.request.Request` | `server.py` | Gerçek API'ye giden istek |
| `if p == "groups":`, `self.jsend(` | `server.py` | Mock API ucu |
| `subprocess.run(["ffmpeg"…` | `tools/proxy_cache.py` | Proxy üretimi |
| `"-movflags", "+faststart"` | `tools/proxy_cache.py` | Tarayıcı dostu MP4 |
| `ffprobe`, `codec_name` | `proxy_cache.py` / `add_video.py` | Video bilgisi okuma |
| `np.dot`, `embeddings` | `server.py` | Re-ID benzerlik hesabı (mock) |
| `random`, `datetime(2025, 5, 20` | `tools/gen_mock.py` | Sahte veri üretimi |

### JavaScript ise

| İpucu | Dosya | Ne yapıyor |
|---|---|---|
| `el('div.panel', {}, …)` | `app.js` | Ekran çizimi |
| `async function screenXxx()` | `app.js` | Bir ekranın tamamı |
| `store.set({ … })` | `app.js` / `core.js` | Durum güncelleme |
| `req('/video/…')`, `LIVE = '/live'` | `live.js` | Gerçek API çağrısı |
| `toCamera`, `toEvent`, `toRun` | `live.js` | Veri şekli çevirimi |
| `analysis_status`, `guid_id`, `duration_ms` | `live.js` | Gerçek API alan adları |
| `ctx.fillRect`, `ctx.strokeRect` | `overlay.js` / `timeline.js` | Canvas çizimi |
| `requestVideoFrameCallback` | `overlay.js` | Kare senkronu |
| `letterbox`, `dpr`, `geom()` | `overlay.js` | Kutu hizalama |
| `this.t0`, `this.X(t)`, `zoom` | `timeline.js` | Zaman ↔ piksel çevirimi |
| `API_MODE`, `FEATURES` | `core.js` | Mod ve özellik anahtarları |
| `TimeMapper` | `core.js` | Zaman çevirimi |

### Alan adına bak — hangi tarafın verisi?

En hızlı ayırt etme yöntemi:

| Görürsen | Kimin |
|---|---|
| `analysis_status`, `guid_id`, `duration_ms`, `storage_uri`, `db_file_path` | **Gerçek API** |
| `segment_start_seconds`, `response.text`, `vllm_model` | **Gerçek API** (VLM sonucu) |
| `has_proxy`, `src_codec`, `place_ko`, `node_id`, `gop_sec` | **Bizim arayüz** (mock şeması) |
| `CAM01`, `G1`, `Area1`, `물류창고` | **Mock veri** — gerçekte yok |
| `t_start`, `t_end`, `wall_start`, `severity_level` | **Arayüzün olay nesnesi** |

> `CAM01` gibi bir kimlik görüyorsan bu kesinlikle mock veridir. Gerçek
> videoların kimliği sayıdır: `1`, `2`, `3`.

### Yorumlara bak

Kodda Türkçe yorumlar var ve çoğu **neden** öyle yapıldığını anlatır. Bir
bloğun ne olduğunu anlamanın en hızlı yolu üstündeki yorumu okumaktır.

---

## 8. Akışlar adım adım

### Yükleme

```
Kullanıcı dosyaları sürükler
   │
   ├─ Tarayıcı süreyi okumayı dener        (MP4 ise olur, AVI ise olmaz)
   │
   ▼
"Upload" düğmesi
   │
   ├─ POST /video/groups          → grup yoksa oluştur
   ├─ POST /video/reservations    → id'ler ayrılır, sıra kurulur
   └─ POST /video/{id}/upload     → her dosya için, ilerleme çubuğuyla
        │
        └─ sunucu ffprobe çalıştırır → duration_ms geri döner
             │
             ▼
        zaman çizgisi çizilir, boşluk/çakışma hesaplanır
```

### Analiz

```
"Run analysis"
   │
   ├─ POST /analysis  →  201 queued
   │                     409 ise → "Already analyzed" diyaloğu
   │                                └─ DELETE /analysis/{id} → POST tekrar
   ▼
2.5 saniyede bir  GET /analysis/{video_id}
   queued → running → succeeded
                          │
                          ▼
              GET /analysis/result/{video_id}/all
                          │
                          ▼
              live.js → toEvent() → olay listesi + timeline
```

### Oynatma

```
<video src="assets/proxy/1.mp4">      ← yerel proxy (varsa)
        veya  /live/video/1/stream    ← orijinal (AVI ise oynamaz)
   │
   ├─ tarayıcı Range istekleri atar → ileri sarma çalışır
   │
   └─ olaya tıklanınca video.currentTime = olayın saniyesi
```

---

## 9. Şu an neyin çalıştığı

| Özellik | Durum | Neden |
|---|---|---|
| Video ağacı (grup + video listesi) | ✅ | `/video/groups` + `/video` |
| Oynatma + ileri sarma | ✅ | Yerel proxy üretiliyor |
| VLM olay listesi | ✅ | `/analysis/result/…/all` |
| Zaman çizgisi | ✅ ama seyrek | VLM videonun %17'sine bakıyor |
| Metin araması | ✅ | VLM açıklamaları üzerinde |
| Yükleme + grup oluşturma | ✅ | İki fazlı akış |
| İş kuyruğu (canlı) | ✅ | Kendiliğinden tazeleniyor |
| Sunucu sağlığı | ✅ | `/status/health` |
| **BBox çizimi** | ❌ | Detection verisi API'den çıkmıyor |
| **Nesne listesi** | ❌ | Aynı sebep |
| **Aday skoru** | ❌ | Detection verisine dayanıyor |
| **Re-ID** | ❌ | Pipeline'da SOLIDER yok, vektör üretilmiyor |
| **İlerleme yüzdesi** | ❌ | Kuyrukta `progress` alanı yok |
| **Özet video** | ❌ | Pipeline üretmiyor (VLM sadece metin yazıyor) |

### Backend'den beklenenler

1. **Detection ucu** — en kritik. Üç özelliği birden açar:
   ```
   GET /analysis/result/{id}/detections?start_ms=&end_ms=
   → [{ t_ms, track_id, cls, conf, x, y, w, h }]   // 0~1 normalize
   ```
   Ucuz alternatif: SQLite dosyasını indirten bir uç; ayrıştırmayı biz yaparız.

2. **Proxy / `playback_uri`** — tarayıcıda oynatılabilir kopya. Şu an bunu
   yerel bir araçla biz üretiyoruz.

3. **İlerleme** — worker `request` JSONB'sine yüzde yazarsa gösterilir. Şema
   değişikliği gerekmez.

4. **Çakışma kırpma** — `POST /analysis`'in `settings` alanına "şu aralığı
   atla" yazılabilirse aynı görüntü iki kez analiz edilmez.

---

## 10. Terimler sözlüğü

| Terim | Anlamı |
|---|---|
| **API** | İki program arasındaki konuşma kuralları |
| **Endpoint (uç)** | API'nin tek bir adresi, ör. `GET /video/1` |
| **CORS** | Tarayıcının farklı adreslere istek atmayı engelleyen güvenlik kuralı |
| **Codec** | Video sıkıştırma algoritması (H.264, HEVC, MPEG-4) |
| **Konteyner** | Dosya kutusu (`.mp4`, `.avi`) — codec'ten ayrı |
| **Proxy** | Orijinalin tarayıcı dostu kopyası |
| **Remux** | Yeniden kodlamadan kutu değiştirme (hızlı, kayıpsız) |
| **Transcode** | Yeniden kodlama (yavaş, biraz kalite kaybı) |
| **GOP** | İki tam kare arası mesafe; ileri sarma hassasiyetini belirler |
| **faststart** | Oynatma bilgisinin dosyanın başına alınması |
| **Range** | "Dosyanın şu bayt aralığını ver" isteği; ileri sarmayı sağlar |
| **ffmpeg / ffprobe** | Video dönüştürme / video bilgisi okuma araçları |
| **Detection** | Karedeki nesnenin bulunması (kutu koordinatı) |
| **Tracking** | Aynı nesneyi kareler boyunca takip etme (takip numarası) |
| **BBox** | Bounding box — nesneyi çevreleyen dikdörtgen |
| **VLM** | Vision-Language Model — görüntüye bakıp metin yazan model |
| **PAR** | Pedestrian Attribute Recognition — kişi özellikleri (cinsiyet, kıyafet) |
| **Re-ID** | Farklı kameralarda aynı kişiyi eşleştirme |
| **YOLO** | Nesne bulma modeli |
| **ByteTrack** | Takip algoritması |
| **NVDEC** | GPU üzerinde video çözme birimi |
| **Worker** | Kuyruktan iş alıp analiz yapan program |
| **Kuyruk (queue)** | İşlerin sıraya girdiği liste |
| **Mock** | Sahte/taklit veri |
| **Normalize koordinat** | 0–1 arası; çözünürlükten bağımsız |
| **PTZ** | Pan/Tilt/Zoom — hareketli kamera |
| **SSE** | Sunucunun tarayıcıya sürekli mesaj göndermesi (gerçek API'de yok) |
| **Polling** | Düzenli aralıklarla "bitti mi?" diye sorma |
| **localStorage** | Tarayıcının kalıcı küçük hafızası |
| **ES modül** | `import`/`export` kullanan JavaScript dosyası |

---

## 11. Günlük kullanım

```cmd
:: Proxy üret (bir kez, yeni video eklendikçe tekrar)
python tools/proxy_cache.py --all
python tools/proxy_cache.py --list

:: Sunucuyu başlat
python server.py

:: Tarayıcı
http://127.0.0.1:8000/
```

Kod değiştiyse **Ctrl+Shift+R**. `server.py` değiştiyse sunucuyu yeniden başlat.

Terminaldeki `→` ve `←` satırları gerçek API'ye giden her isteği ve dönen her
cevabı gösterir. Bir şey beklediğin gibi çalışmıyorsa **ilk bakılacak yer
orası**: istek gitmiş mi, ne dönmüş?

```cmd
python server.py --live-body -1    :: cevapların tamamını göster
python server.py --live-body 0     :: sadece tek satırlık özet
```

### Sık karşılaşılanlar

| Belirti | Sebep |
|---|---|
| Sonsuz "loading" | Ekran hata verdi — F12 → Console'a bak |
| Mock veri görünüyor | Sağ üstteki düğme MOCK'ta |
| Terminale hiç istek düşmüyor | Canlı mod açık değil |
| Video oynamıyor | Proxy üretilmemiş — `proxy_cache.py --list` |
| Kod değişti ama etkisi yok | Sert yenileme yapılmadı, ya da iki sunucu birden çalışıyor |
| 404 "Analysis result database not found" | O video hiç analiz edilmemiş — hata değil |
| 409 Conflict | Video zaten analiz edilmiş; yeniden analiz için önce silmek gerekir |
