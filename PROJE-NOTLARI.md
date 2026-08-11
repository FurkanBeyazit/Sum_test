# 지능형 영상 요약 플랫폼 — Frontend Tarafı Teknik Notlar

> Bu doküman, elimizdeki üç planlama dokümanı, iki ekran görüntüsü ve DB şeması
> parçalarından yola çıkarak sistemin nasıl çalıştığını, frontend'in sorumluluk
> sınırını, verilmesi gereken teknik kararları ve backend'e sorulması gereken
> soruları toplar.
>
> Durum: **v2 — DB şeması alındıktan sonra güncellendi.**
> `video_analytics_schema_v2` birçok soruyu kapattı, birkaç yenisini açtı;
> özeti [Bölüm 13](#13-db-şeması--neyi-cevapladı-neyi-açtı)'te.
> Backend geliştiricisiyle konuşulması gereken maddeler
> [Bölüm 19](#19-backende-sorulacak-sorular--gerekçeleriyle)'da 🔴🟡🟢
> öncelikleriyle listeli.
>
> Buradaki kararların çalışan karşılığı `mock/` altında; nasıl çalıştırılacağı
> [`README.md`](README.md)'de.

---

## İçindekiler

1. [Sözlük — önce terimleri oturtalım](#1-sözlük--önce-terimleri-oturtalım)
2. [Sistem üç ayrı evrimden oluşuyor](#2-sistem-üç-ayrı-evrimden-oluşuyor)
3. [Kritik: arama kapsamı ve ölçek gerçeği](#3-kritik-arama-kapsamı-ve-ölçek-gerçeği)
4. [이벤트 후보 구간 선정 — motorun kalbi](#4-이벤트-후보-구간-선정--motorun-kalbi)
5. [PAR ve "kırmızı montlu adam" sorusunun cevabı](#5-par-ve-kırmızı-montlu-adam-sorusunun-cevabı)
6. [Re-ID — fotoğraftan kişi arama](#6-re-id--fotoğraftan-kişi-arama)
6b. [Detection → Track → Global Identity: BBox nasıl hareket ediyor?](#6b-detection--track--global-identity-bbox-nasıl-hareket-ediyor)
7. [Sistemdeki arama yolları](#7-sistemdeki-arama-yolları)
8. [API sözleşmesi: OpenAPI, Swagger, FastAPI](#8-api-sözleşmesi-openapi-swagger-fastapi)
9. [Video taşıma: RTSP / WebRTC / WebSocket / HTTP](#9-video-taşıma-rtsp--webrtc--websocket--http)
10. [BBox nerede çizilecek?](#10-bbox-nerede-çizilecek)
11. [Uzun süren işler: polling mi WebSocket mi?](#11-uzun-süren-işler-polling-mi-websocket-mi)
12. [Ekran analizi — tek video özeti](#12-ekran-analizi--tek-video-özeti)
12b. [Ekran analizi — 복합 상황 요약 (çoklu kamera)](#12b-ekran-analizi--복합-상황-요약-çoklu-kamera)
13. [DB şeması — neyi cevapladı, neyi açtı](#13-db-şeması--neyi-cevapladı-neyi-açtı)
14. [Ekran → Endpoint eşleme tablosu](#14-ekran--endpoint-eşleme-tablosu)
15. [Frontend mimarisi](#15-frontend-mimarisi)
16. [Frontend'in kendi problemleri](#16-frontendin-kendi-problemleri)
17. [Öğrenme haritası — hangi kavram hangi dosyada](#17-öğrenme-haritası--hangi-kavram-hangi-dosyada)
18. [Yol haritası](#18-yol-haritası)
19. [Backend'e sorulacak sorular — gerekçeleriyle](#19-backende-sorulacak-sorular--gerekçeleriyle)
20. [Dokümanlar arası çelişkiler](#20-dokümanlar-arası-çelişkiler)

---

## 1. Sözlük — önce terimleri oturtalım

Bu terimler dokümanlarda dağınık geçiyor ve karıştırılması kolay. Hepsi farklı
şeyler yapar.

| Terim | Açılım | Ne yapar | Ne YAPMAZ |
|---|---|---|---|
| **Object Detection** | — | Karede nesne bulur: `person, 0.91, [x,y,w,h]` | Rengini, cinsiyetini, kim olduğunu bilmez |
| **Object Tracking** | — | Ardışık karelerdeki aynı nesneye `track_id` verir | Kamera değişince takip kopar |
| **PAR** | Pedestrian Attribute Recognition | Kişi kırpıntısından öznitelik çıkarır: cinsiyet, üst giysi rengi, çanta… | Kimlik bilmez, iki kişiyi eşleştirmez |
| **Re-ID** | Re-Identification | Kişiden ~512 boyutlu kimlik vektörü çıkarır; iki vektör karşılaştırılınca "aynı kişi mi" sorusuna sayı döner | İsim/kimlik bilmez, tek başına arama yapmaz |
| **VLM / LVLM** | (Large) Vision-Language Model | Görüntüye soru sorulabilir, doğal dil cevap üretir | Yavaş ve pahalı — her kareye uygulanamaz |
| **VAD** | Video Anomaly Detection | Videoda "olağandışı" durum tespiti | — |
| **VMS** | Video Management System (Athena) | Kameraları yöneten, kaydı tutan dış sistem | Bizim ürünümüz değil |
| **RTSP** | Real Time Streaming Protocol | Kamera/VMS yayın protokolü | **Tarayıcı oynatamaz** |
| **Segment** | — | Videonun sabit uzunlukta parçası (24 frame ≈ 0.8 sn) | — |
| **Temsilci frame** | representative frame | Bir segmenti temsil eden tek kare | — |

**Zihinsel model:**
- Detection = "orada bir insan var"
- Tracking = "bu, 3 saniyedir gördüğüm aynı insan"
- PAR = "bu insan kırmızı üstlü bir erkek"
- Re-ID = "bu insan, Camera3'te gördüğüm insanla aynı"
- VLM = "bu karede sağ üstte bir çöp kutusundan duman çıkıyor"

---

## 2. Sistem üç ayrı evrimden oluşuyor

Elimizdeki dokümanlar aynı ürünün üç farklı aşamasını anlatıyor. Hangisinin
geçerli olduğunu bilmek UI'ın şeklini belirliyor.

### Plan 1 — Klasik CV + VLM (ilk kurgu)

```
Video
  → Object Detection + Tracking + Re-ID + PAR + klasik görüntü işleme
  → kural tabanlı "aday zaman aralığı" seçimi
     (nesne sayısı değişimi, mesafe değişimi, yoğunluk, uzun süreli bekleme,
      duruş değişimi, track kararsızlığı, sınıf kombinasyonu)
  → aday aralıkların videosu kesilir
  → VLM ile prompt bazlı analiz
  → doğal dil özet
```

**Kendi dokümanında itiraf edilen zayıflıkları:**
- Aday seçimi kural tabanlı → her yeni olay tipi için ayrı algoritma
- Tracking koparsa olay kaçıyor
- BBox tabanlı yöntemlerde 2023'ten beri performans artışı yok
- **En önemlisi:** Kullanıcının aradığı **belirli** durumu bulamıyor, sadece
  videoyu genel olarak tarif ediyor

### Plan 2 — Prompt-driven retrieval (AnyAnomaly) — **UYGULANMIYOR**

> **Bu plan hayata geçmedi.** Backend geliştiricisi CLIP kullanılmayacağını
> teyit etti; DB şemasında da CLIP embedding tablosu yok. Bölüm burada
> tarihsel kayıt olarak duruyor — hangi yolun neden seçilmediğini bilmek,
> ileride tartışma tekrar açılırsa zaman kazandırır.

Referans: [arXiv:2503.04504 — AnyAnomaly: Zero-Shot Customizable Video Anomaly Detection with LVLM](https://arxiv.org/abs/2503.04504)

```
Video → sabit uzunlukta segmentlere böl (24 frame)
      → her segment için temsilci frame seç
      → CLIP görüntü embedding'i hesapla ve SAKLA        [analiz zamanı]
      ------------------------------------------------
      → kullanıcı prompt yazar                            [arama zamanı]
      → CLIP metin embedding'i hesapla
      → tüm segment embedding'leriyle benzerlik hesapla
      → en yüksek skorlu K segmenti LVLM'e sor
      → skorları topla → anomali timeline'ı
```

**Kazandırdıkları:**
- Zero-shot: yeni olay tipi için yeniden eğitim yok
- Kullanıcı ne yazarsa onu arıyor
- Farklı CCTV ortamlarına uyum
- Doğal dil ile video arama

**Uygulanmadığı için kaybedilen:** kullanıcının serbest metinle yazdığı
durumu videoda arama. Bunun yerine gelen: VLM'in yazdığı açıklamalarda metin
araması (Bölüm 4.7) — daha zayıf ama sıfır ek maliyet.

### Plan 3 — Çoklu kamera + Re-ID — **ERTELENDİ** takip

> **Durum:** Backend geliştiricisi Re-ID'nin bu aşamada olmadığını,
> yaklaşık **bir ay sonra** yazılacağını bildirdi. Sorgu **fotoğraftan**
> yapılacak (görsel benzerlik). Mockup'ta çalışır hâlde ama arayüzde
> varsayılan olarak **gizli** (`FEATURES.reid`).
> Şu anki odak: **video + timeline + özet.**

Ayrı bir mod:

1. Tüm kameralarda detection/tracking/PAR çalışır. Her nesnenin **crop
   görüntüsü** ve **Re-ID feature vektörü** DB'ye yazılır.
   **Eşleştirme yapılmaz** (`매칭하지는 않는다`) — maliyetli olduğu için ertelenir.
2. Kullanıcı bir kameranın **nesne listesi**ni açar → kırpılmış kişi
   fotoğraflarının grid'i. PAR sonuçlarıyla filtrelenir.
3. Kullanıcı bir kişiye tıklar → **o anda** Re-ID eşleştirmesi başlar.
   - Zamansal olarak en yakın nesneden başlar
   - Skor sırasıyla aday listesi döner
   - Belli bir miktar eşleştirmeden sonra durur
   - Kullanıcı "bunlar değil" derse devam eder
4. Kullanıcı "evet aynı kişi" derse nesne **takip listesine** eklenir.
5. Yeni eklenen nesneden zincirleme devam edilebilir.
6. Takip listesindeki kişinin göründüğü tüm klipler tek videoya birleştirilip
   dışa aktarılır + Excel/Word rapor.

**Neden eşleştirme önceden yapılmıyor?** N nesne için N² karşılaştırma gerekir.
10.000 tespit → 50 milyon karşılaştırma. Kullanıcı tek kişiyi merak ediyorsa
10.000 karşılaştırma yeter. Akıllı bir tercih.

**UI açısından:** Bu, klasik CRUD değil — **insan-döngüde, interaktif bir arama
oturumu**. Projenin en zor ve en özgün frontend parçası.

---

## 3. Kritik: arama kapsamı ve ölçek gerçeği

> Bu bölüm dokümanlarda açıkça yazılmamış ama sistemin çalışıp çalışmayacağını
> belirleyen şey.

### Hesap

Hedef performans dokümanda yazıyor: *30분 영상 평균 요약 시간 8분 이하*
→ 30 dakika video 8 dakikada → **3.75× gerçek zaman hızı** (RTX 5070 başına).

```
100 kamera × 24 saat        = 2.400 saat video
2.400 / 3.75                = 640 saat GPU işlemi
640 saat                    = tek GPU ile 26 GÜN
```

**Sonuç: "100 kamerada canlı arama" fiziksel olarak mümkün değil.**

### Doğru akış

```
1. KAPSAM SEÇİMİ        [kullanıcı yapar, bedava]
   "Area1 grubu, Camera1-4, 2025-05-20 08:00 ~ 12:00"
            ↓
2. VERİ ÇEKME           [VMS'den indirme, dakikalar]
            ↓
3. ÖN ANALİZ            [PAHALI — GPU, dakikalar/saatler, BİR KEZ]
   Detection + Tracking + PAR (+ Re-ID feature, sonraki faz)
   + 이벤트 후보 구간 선정 (event_candidate_score)
   → hepsi DB'ye yazılır
            ↓
4. ARAMA                [UCUZ — saniyeler, SINIRSIZ TEKRAR]
   "kırmızı montlu adam" → hazır veri üzerinde arama
```

**Kritik ayrım: 3. adım pahalı ve bir kez, 4. adım ucuz ve tekrarlanabilir.**

Ekran görüntüsündeki `요약 시간 범위 2025-05-20 00:00:00 ~ 2025-05-20 23:59:59`
alanı tam olarak bu kapsamı gösteriyor. Sistem zaten "bir kamera + bir zaman
aralığı" üzerinde çalışıyor.

### UI'a etkisi

- Ana ekranın üstünde **her zaman** aktif kapsam görünmeli: hangi kamera(lar),
  hangi zaman aralığı, analiz durumu ne.
- Arama kutusu bu kapsamın **içinde** arar. Kullanıcıya bunu görsel olarak
  hissettir — yoksa "neden Camera7'de bulmadı" şikayeti gelir.
- Kapsam seçim ekranında kullanıcıyı uyar: *"Seçtiğiniz aralık yaklaşık 6 saat
  analiz süresi gerektiriyor."*
- Analiz edilmemiş kamerada arama yapılamayacağını UI engellemeli
  (`video_status` enum'u zaten bunu söylüyor).

---

## 4. 이벤트 후보 구간 선정 — motorun kalbi

> **Karar (backend geliştiricisi, teyitli): CLIP kullanılmayacak.**
> Boru hattı Plan 1'dir. Bu bölüm eskiden AnyAnomaly/CLIP anlatıyordu;
> tamamen değiştirildi. Kararın gerekçesi ve kaybedilenler
> [Bölüm 20](#20-dokümanlar-arası-çelişkiler)'de.

### 4.1 Boru hattı

```
Video
  → Object Detection + Tracking + PAR        (her kare)
  → pencere başına metrik skorları           (event_candidate_score)
  → ağırlıklı toplam ≥ eşik  →  ADAY구간
  → yalnızca aday pencereler VLM'e
  → vlm_event.description (doğal dil)  →  TIMELINE
```

Kritik ekonomi burada: **VLM pahalı, kural tabanlı metrikler bedava.**

| Yaklaşım | 30 dakikalık video | Süre |
|---|---|---|
| Her pencereyi VLM'e ver | 900 pencere × 2 sn | **30 dakika** — kabul edilemez |
| Kuralla ele, sonra VLM | ~40 pencere × 2 sn | **80 saniye** |

Aday seçiminin tek görevi budur: **VLM'e ne göndereceğine karar vermek.**
(Plan 2 bu görevi CLIP'e vermek istiyordu; artık kurallar yapıyor.)

### 4.2 Metrikler

Plan 1'in `후보 구간 판단 조건` tablosu ve akış şemasındaki analiz kolları.
Her metrik bir zaman penceresi için 0~1 arası bir "ihlal skoru" üretir.

| `metric_code` | Korece | Neyi ölçer | Yakaladığı durum | Ağırlık |
|---|---|---|---|---|
| `pixel_change` | 픽셀 변화량 | Kare farkı + optical flow | Ani sahne değişimi | 0.10 |
| `motion_change` | 객체 움직임 변화 | BBox hız / yön / ivme | Koşma, ani duruş, kaçış | 0.18 |
| `object_count` | 객체 수 변화 | Sınıf başına nesne sayısı | Kalabalık oluşumu/dağılması | 0.12 |
| `track_churn` | 등장·소멸 | Yeni/biten track oranı | Toplu giriş-çıkış | 0.15 |
| `interaction` | 객체 간 상호작용 | Merkezler arası mesafe ve yaklaşma hızı | Çarpışma, kavga, takip | 0.20 |
| `dwell` | 장시간 체류 | Aynı konumda kalma süresi | Başıboş dolaşma, park, terk | 0.13 |
| `posture` | 상태 변화 | BBox en/boy oranı değişimi | **Düşme**, çömelme | 0.12 |

**Neden ağırlık?** Hepsi eşit önemde değil. `interaction` en yüksek ağırlığa
sahip çünkü çarpışma/kavga en kritik olaylar. `pixel_change` en düşük çünkü
tek başına gürültülü (bulut geçse bile tetiklenir).

### 4.3 Göreli eşik — asıl püf noktası

Metrikler **mutlak** değil **göreli** eşiklerle çalışır. Plan 1'in akış
şemasındaki soru şudur: *"평상시보다 변화량이 큰가?"* — "normalden fazla mı?"

Neden önemli: bir otoyol kamerasında sürekli hareket vardır, bir depo
kamerasında hiç yoktur. Mutlak eşik kullanırsan otoyolda her pencere aday
olur, depoda hiçbiri olmaz.

Uygulama (`gen_mock.py → build_candidates`):

```python
lo = percentile(values, 30)    # bu videonun "normali"
hi = percentile(values, 97)    # bu videonun "aşırısı"
normalized = clip((value - lo) / (hi - lo), 0, 1)
```

Yani her video **kendi tabanına** göre ölçülür. Bu, Plan 1'deki
"영상 유형별 이벤트 추출 방법" tablosunun (정적 환경 / 고밀도 환경 / …)
tek satırlık karşılığıdır.

### 4.4 Veri şekli

DB'deki `event_candidate_score` tablosuyla birebir:

```json
{
  "t_start": 148.0, "t_end": 150.0,
  "start_timestamp_ms": 148000,
  "integrated_score": 0.78,
  "threshold": 0.42,
  "is_candidate": true,
  "top_metric": "posture",
  "scores": [
    { "metric_code": "posture",     "score": 0.94, "threshold": 0.55,
      "exceeded": true,  "details": { "raw": 1.82, "weight": 0.12 } },
    { "metric_code": "interaction", "score": 0.31, "threshold": 0.55,
      "exceeded": false, "details": { "raw": 0.44, "weight": 0.20 } }
  ]
}
```

`details jsonb` alanı şemada var ve serbest — motor buraya ham değerleri
yazar.

### 4.5 UI'daki karşılığı — "bu olay neden seçildi"

Bu veri iki yerde görünür:

**1. Timeline'ın üst şeridi.** Pencere başına bir çubuk; yükseklik = ihlal
skoru, renk = eşiği aştı mı. Kesik kırmızı çizgi eşiği gösterir. Kullanıcı
tek bakışta "motor neresine dikkat etti" görür.

**2. `◍ 후보 점수` butonu.** Metrik kırılımı tablosu: hangi pencerede hangi
metrik eşiği aşmış. Bu, mockup'ın en çok değer katan ekranlarından biri —
operatörün sisteme güveni buradan gelir.

> Örnek: Camera4'te 148–150. saniye aralığında `posture 0.94` (eşik 0.55).
> Yani "biri düştü" tespiti bir kara kutudan çıkmadı; en/boy oranının
> ani değişiminden çıktı ve kullanıcı bunu görebiliyor.

### 4.6 Bu yaklaşımın dürüst sınırları

Plan 2 dokümanı bunları haklı olarak eleştiriyordu — kabul etmek gerekir:

| Sınır | Anlamı |
|---|---|
| **Her olay tipi için ayrı kural** | Yeni bir durum (örn. "duvara grafiti yapma") istenirse yeni metrik yazılmalı |
| **Kural ne kaçırdıysa VLM göremez** | Aday seçilmeyen pencere hiç incelenmez |
| **Kullanıcının aradığını arayamaz** | Serbest metinle "şunu bul" diyemezsin; ancak VLM'in yazdığında arayabilirsin |
| **Sessiz olaylar kaçar** | Hareketsiz bir tehdit (bırakılmış çanta ilk saniyeler) düşük skor alır |

Bu sınırları azaltmanın yolu eşiği düşürmek — ama o zaman VLM maliyeti artar.
`analysis.candidate_threshold` ayarı tam olarak bu dengeyi kullanıcıya bırakır.

### 4.7 Arama ne oldu?

Görsel arama olmadığı için arama **piksellerde değil, VLM'in yazdığı
metinde** yapılır:

```
POST /api/search  { "video_ids": ["CAM01"], "query": "탑승" }
  → vlm_event.description içinde metin araması
  → ~3 ms, sonuç anında
```

Türkçe/İngilizce sorgular küçük bir eşanlam sözlüğüyle Korece açıklamalara
bağlanır (`araca binen` → `탑승`). Gerçek sistemde bunun yerine ya çok dilli
bir metin embedding'i (BGE-M3 gibi) ya da VLM çıktısının çok dilli üretilmesi
gerekir.

**Bu aramanın tek sınırı net:** VLM bahsetmediyse bulunamaz. Kullanıcıya bunu
söylemek gerekir — "sonuç yok" ile "sistem bundan bahsetmedi" farklı şeylerdir.

Nitelik araması (kırmızı mont, erkek, sırt çantası) bundan **bağımsız** çalışır
ve daha güvenilirdir: PAR çıktısı üzerinde doğrudan SQL. Bkz.
[Bölüm 5](#5-par-ve-kırmızı-montlu-adam-sorusunun-cevabı).


## 5. PAR ve "kırmızı montlu adam" sorusunun cevabı

### 5.1 Tespit doğruydu

*"Detection'da kırmızı mont bilgisi hiçbir zaman gitmeyecek"* — **doğru.**
Object detection sadece `person, 0.91, [x,y,w,h]` der. Renk bilmez.

Rengi **PAR** söyler.

### 5.2 PAR ne üretir?

Detection ile kesilmiş kişi görüntüsünü alıp öznitelik sınıflandırması yapar:

| Öznitelik | Tipik değerler |
|---|---|
| Cinsiyet | erkek / kadın |
| Yaş grubu | çocuk / yetişkin / yaşlı |
| Üst giysi rengi | kırmızı, turuncu, sarı, yeşil, mavi, mor, beyaz, siyah… |
| Üst giysi tipi | kısa kol / uzun kol / ceket |
| Alt giysi | pantolon / etek / şort + renk |
| Taşınan eşya | sırt çantası, el çantası, şemsiye |
| Aksesuar | şapka, gözlük, maske |
| Yön | öne / arkaya / yana dönük |

Araçlar için benzer bir model: tip (sedan, SUV, kamyon, otobüs) + renk.

### 5.3 Filtre paneli tamamen PAR üzerinde çalışıyor

Ekran görüntüsündeki sol alt `객체 필터` paneli — cinsiyet butonları, renk
noktaları — **VLM değil, arama motoru değil.** Bu düz bir veritabanı sorgusu:

```sql
SELECT * FROM detected_objects
WHERE class = 'person'
  AND gender = 'male'
  AND upper_color = 'red'
  AND video_id = ?
```

Milisaniyeler sürer, kesin sonuç verir, sayfalanabilir.

### 5.4 UI için kritik detay

Filtre panelindeki renk noktaları ve cinsiyet butonları **PAR modelinin çıktı
sınıflarıyla birebir eşleşmeli.** 9 renk çizip model 5 renk destekliyorsa 4 buton
hiç sonuç dönmez ve kullanıcı sistemin bozuk olduğunu düşünür.

**SORU:** PAR'ın öznitelik ve değer listesi nedir? Sabit mi, yoksa
`GET /attributes` gibi bir endpoint'ten mi gelecek? (Endpoint'ten gelmesi daha
iyi — model değişince UI'ı elle güncellemek istemiyoruz.)

---

## 6. Re-ID — fotoğraftan kişi arama

### 6.1 Re-ID feature nedir?

Bir kişinin görüntüsünden çıkarılan ~512 boyutlu vektör. Kıyafet, vücut oranı,
duruş gibi şeyleri kodlar.

**İsim/kimlik bilmez.** Sadece "bu iki görüntü aynı kişi mi" sorusuna sayısal
cevap verir (kosinüs benzerliği).

### 6.2 Akış

```
[Ön analiz]
  Her tespit edilen kişi için:
    - crop görüntüsü kaydedilir
    - Re-ID vektörü hesaplanır ve kaydedilir
    - EŞLEŞTİRME YAPILMAZ

[Kullanıcı etkileşimi]
  1. Nesne listesinde bir kişiye tıkla
       → o kişinin vektörü "referans" olur
  2. Sistem diğer vektörlerle karşılaştırır
       → zamansal olarak EN YAKIN nesneden başlar
       → skora göre sıralar
       → belli bir miktardan sonra DURUR
  3. Kullanıcıya aday listesi:
       crop görüntüsü + kamera + zaman + benzerlik skoru
  4a. "Evet aynı kişi"  → takip listesine ekle → timeline'da işaretle
  4b. "Hayır, hiçbiri"  → aramaya devam et
  5. Yeni eklenen kişiden zincirleme devam edilebilir
```

Bu, senin tarif ettiğin şeyle birebir aynı: *"bu fotoğrafa benzer hangi
frame'ler, hangi videoda, hangi kamerada, ne zaman."*

### 6.3 UI'a etkisi — kademeli sonuç

Doküman açıkça diyor:
- `가장 시간적으로 가까운 객체부터 수행한다` — en yakın zamandan başla
- `일정 이상 매칭을 수행하였다면 매칭을 중단한다` — belli noktada dur
- `사용자가 리스트중에 맞는 객체가 없다고 하면 매칭을 재개할 수 있다` — kullanıcı isterse devam

**Bu, sonuçların tek seferde gelmediği anlamına gelir.** UI'da:
- Büyüyen bir aday listesi
- "Daha fazla ara" butonu
- Arama devam ederken ilerleme göstergesi
- Her adayda "aynı kişi" / "değil" işaretleme

**SORU:** Sonuçlar akarak mı geliyor (WebSocket) yoksa her "devam" isteği ayrı
bir HTTP çağrısı mı? İkisi farklı UI kurar.

### 6.4 Takip listesi ve timeline

Takip listesine eklenen kişiler timeline'da vurgulanır. Çoklu kamera görünümünde
bu, kamera başına bir satır (swimlane) üzerinde "bu kişi burada 08:31–08:34
arasında göründü" şeklinde çizilir. Kişinin kameralar arası hareketi görsel
olarak izlenebilir hale gelir.

---

## 6b. Detection → Track → Global Identity: BBox nasıl hareket ediyor?

> Bu bölüm şu soruya cevap veriyor: *"Videoda bbox'u biz mi hareket ettireceğiz?
> track_id tamam ama sonraki karede o track_id'nin nerede olduğunu nereden
> bilecek?"* — Sistemin en çok karıştırılan yeri burası.

### 6b.1 Frontend hiçbir şey hesaplamıyor

Kutu **hareket etmiyor.** Her karede sıfırdan çiziliyor. Backend her kare için
ayrı bir satır gönderiyor:

```
t=12.0  track_id=1  x1=0.310  y1=0.220  x2=0.380  y2=0.550
t=12.1  track_id=1  x1=0.312  y1=0.221  x2=0.382  y2=0.552   ← biraz sağda
t=12.2  track_id=1  x1=0.314  y1=0.223  x2=0.384  y2=0.554   ← biraz daha
```

Frontend'in tek işi: *"şu an t=12.1, bu zamana ait satırları bul, canvas'ı
temizle, kutuları çiz."* Saniyede 10–30 kez. Hareket illüzyonu buradan geliyor
— tıpkı videonun kendisi gibi, ardışık duruk karelerden.

`mock/js/overlay.js` içindeki `boxesAt()` fonksiyonunun tamamı bu:

```js
const f = Math.round(t * this.det.fps);   // zaman → kare numarası
let rows = this.det.index.get(f);          // o karenin satırları
```

Ve `draw()` her çağrıda `clearRect` yapıp yeniden çiziyor. Hiçbir yerde
"kutuyu kaydır" diye bir kod yok.

**track_id'nin frontend'deki üç işi var, konum hesabı bunların hiçbiri değil:**

| İş | Nasıl kullanılıyor | Kod |
|---|---|---|
| Renk tutarlılığı | Aynı kişi hep aynı renkte görünsün | `trackColor(id)` — `core.js` |
| İz (trajectory) | Geçmiş 3 saniyenin ayak noktalarını çizgiyle bağla | `trailFor()` — `overlay.js` |
| Filtreleme / vurgulama | "Sadece bu kişiyi göster", olaya tıklayınca ilgili kişiyi parlat | `filterTrackIds`, `highlightTrackId` |

### 6b.2 Backend "sonraki karede bu kişi nerede" sorusunu nasıl çözüyor?

İşte **Object Tracking** budur. İki ayrı adım, karıştırılmamalı:

**Adım 1 — Detection: her kare bağımsız, hafızasız.**
YOLO t=12.1 karesine bakar, *"burada üç kişi var"* der. Ama hangisinin önceki
karedeki hangi kişi olduğunu **bilmez**. Detector'ın geçmişi yoktur.

**Adım 2 — Tracking: eşleme (data association).**
Tracker (BoT-SORT, ByteTrack, OC-SORT) önceki karedeki track'lerle yeni
tespitleri eşleştirir. Üç ipucu kullanır:

| İpucu | Ne yapar | Ne zaman yeterli |
|---|---|---|
| **Hareket tahmini** | Kalman filtresi: "önceki hızıyla devam ederse şurada olmalı" | Çoğu normal durumda |
| **IoU örtüşmesi** | Tahmin kutusu ile tespit kutusu ne kadar üst üste biniyor | Nesneler birbirinden ayrıksa |
| **Görünüm benzerliği** | Küçük bir ReID vektörü — kıyafet/renk imzası | Kalabalıkta, yollar kesiştiğinde |

Sonra bir **atama problemi** çözülür (Macar algoritması / Hungarian):
"hangi tespit hangi track'e gitsin ki toplam maliyet en düşük olsun".

```
Kare 12.0:  track#1 son konum (0.310, 0.220), hız (+0.02/s, +0.01/s)
              ↓ Kalman tahmini: "0.312 civarında olmalı"
Kare 12.1:  tespitler →  A(0.312)   B(0.700)   C(0.150)
              ↓ IoU:      A ile %94   B ile %0   C ile %0
            A = track#1 ✓        B, C → yeni track (#4, #5)
```

**Eşleşme bulunamazsa:** track "kayıp" (lost) işaretlenir, N kare beklenir
(occlusion — kişi bir direğin arkasına geçmiş olabilir). Geri dönerse aynı
`track_id` ile devam eder; dönmezse track kapanır.

Plan 1'deki *"Tracking koparsa olay kaçıyor"* uyarısı tam olarak bunu anlatıyor:
kişi bir engelin arkasından çıktığında **yeni bir `track_id` alabilir** ve
sistem onu yeni bir insan sanar.

### 6b.3 Üç katmanlı kimlik hiyerarşisi

DB şeması bu üç katmanı ayrı tablolarda tutuyor — ve bu doğru tasarım:

```
detection        bir karedeki bir kutu
                 şema: detection (frame_id, bbox_x/y/w/h, confidence, track_id)
     ↓ tracker aynı nesnenin karelerini birleştirir
track            BİR kameradaki bir nesnenin ömrü
                 şema: track (local_track_no, first/last_frame_id, camera_id)
     ↓ Re-ID farklı kameralardaki track'leri birleştirir
global_identity  TÜM kameralardaki aynı kişi
                 şema: global_identity ← track_identity_match → track
```

**Kritik sınır: `track_id` yalnızca tek kamera içinde geçerlidir.**
Camera1'deki `track#1` ile Camera2'deki `track#12` aynı insan olsa bile
farklı ID'lerdir. Şemadaki `track.local_track_no` alan adı bunu açıkça söylüyor
— *local*, yani yerel.

Kameralar arasını bağlayan zincir:

```
track  →  reid_embedding (pgvector, 1024-d)
       →  track_identity_match (similarity, status)
       →  global_identity
```

Mockup'ta bunu canlı görebilirsin: senaryodaki P1, Camera1'de `track_id=1`,
Camera2'de `track_id=12`. Aynı insan, farklı track. Re-ID onları **0.9751**
benzerlikle birleştiriyor. Benim "takip listesi" dediğim şey aslında şemadaki
`global_identity` — üyeleri de `track_identity_match` kayıtları.

### 6b.4 Frontend'e pratik sonuçları

1. **Kutu enterpolasyonu gerekebilir.** Backend 30 fps videoda detection'ı
   5 fps'te örneklerse, aradaki karelerde kutu ya donar ya titrer. İki komşu
   kayıt arasında doğrusal enterpolasyon yapman gerekir. **Soru 4** bunu
   soruyor.
2. **`track_id` yeniden kullanılabilir.** Uzun videolarda tracker ID'leri
   döngüsel olarak yeniden kullanabilir. Renk seçiminde sorun olmaz ama
   "bu track'i takip et" özelliğinde yanlış nesneyi izleyebilirsin. Backend'e
   ID'lerin video içinde benzersiz olup olmadığını sor.
3. **Aynı kişi kamera değiştirince renk değişir** — çünkü renk `track_id`'den
   türüyor ve ID farklı. Takip listesindekiler için `global_identity_id`
   bazlı sabit bir renk kullanmak gerekir. Mockup'ta çoklu kamera
   timeline'ında takip çizgileri bu yüzden ayrı renkte (pembe).
4. **Kayıp/yeniden bulunan track'ler** iz çiziminde sıçramaya yol açar.
   `trailFor()` 3 saniyelik pencere kullanıyor; boşluk varsa çizgi kopuk
   görünmeli, düz bir çizgiyle birleştirilmemeli.

---

## 7. Sistemdeki arama yolları

Şu an **iki** yol var. Üçüncüsü (Re-ID) kodda duruyor ama arayüzde kapalı.
UI'da bunlar ayrı ayrı sunulmalı — tek kutuya hepsini tıkarsak kullanıcı
hangisinin ne yaptığını anlamaz.

| | **1. Öznitelik filtresi** | **2. 이벤트 검색** | ~~3. Görsel benzerlik~~ |
|---|---|---|---|
| **Durum** | ✅ aktif | ✅ aktif | ⏸ ertelendi (~1 ay) |
| **Girdi** | Açılır menü, renk butonu | Serbest metin | Bir kişi fotoğrafı |
| **Motor** | PAR + SQL | VLM açıklamalarında metin | Re-ID vektör |
| **Hız** | Anlık (ms) | Anlık (ms) | Saniyeler, kademeli |
| **Ne arar** | **Nitelik** — ne giyiyor | **Olay** — VLM ne yazmış | **Kimlik** — bu kişi kim |
| **Örnek** | "kırmızı üstlü erkekler" | "탑승", "쓰러", "배회" | "bu kişi başka nerede?" |
| **Kesinlik** | Kesin (DB sorgusu) | VLM ne yazdıysa o kadar | Olasılıksal, kullanıcı onaylı |
| **UI konumu** | Sol panel `객체 필터` | Olay listesi üstü | (gizli) |

**"Kırmızı montlu adam" için doğru araç Yol 1'dir.** Yol 2 ancak VLM
"빨간 재킷" yazdıysa bulur.

Kritik fark: **Yol 1 veriyi arar, Yol 2 veri hakkında yazılmış metni arar.**
Yol 2'nin bulamadığı bir şey sistemde olmadığı anlamına gelmez — sadece VLM'in
ondan bahsetmediği anlamına gelir. UI bu farkı kullanıcıya hissettirmeli.

---

## 8. API sözleşmesi: OpenAPI, Swagger, FastAPI

### 8.1 Kısa cevap: öğrenilecek özel bir şey yok

**OpenAPI** = REST API'yi makine okuyabilir şekilde tarif eden şema formatı
(YAML/JSON dosyası). "Şu endpoint var, şu parametreleri alır, şunu döner."

**Swagger UI** = O şemayı okuyup tarayıcıda gezilebilir doküman üreten araç.
Butona basıp gerçek istek atabilirsin.

**FastAPI bunları otomatik üretir.** Ekstra iş yok:

| URL | Ne | Kullanımı |
|---|---|---|
| `/docs` | Swagger UI — tıklanabilir, test edilebilir | **Günlük kullanımın bu** |
| `/redoc` | Aynı bilgi, daha okunaklı doküman | Referans okumak için |
| `/openapi.json` | Ham şema (makine için) | Araçlara yedirmek için |

Arkadaş kod yazdıkça üçü de otomatik güncellenir. "OpenAPI ile yapalım" demesi
pratikte "FastAPI kullanacağım" demekten fazlası değil.

**Evet — `/docs`'a girip API'leri görüp test edeceksin. Kurs izlemene gerek yok.**

### 8.2 `openapi.json`'un ekstra kazandırdıkları (opsiyonel)

| Araç | Ne yapar | Değer |
|---|---|---|
| `openapi-typescript` | Şemadan TypeScript tipleri üretir | Alan adı yanlış yazınca editör uyarır |
| `Prism` (`prism mock openapi.yaml`) | Şemadan sahte sunucu kaldırır | Backend yokken gerçek veriyle geliştirirsin |
| `openapi-generator` | İstemci kodu üretir | Bu ölçekte gereksiz |

Alpine + vanilla JS ile gidiyorsak bunlar zorunlu değil. Ama var olduklarını bil.

**Uyarı:** OpenAPI sadece REST'i tarif eder. WebSocket kanallarını tarif etmez.
Realtime kısmı için ayrı bir "mesaj tipleri" tablosu (basit Markdown) yazılmalı.

### 8.3 "Sonradan bağlama" endişesi — haklı

Endişe: *"Backend önce API'leri yazacak, ama UI'ın ihtiyaçları farklı olabilir,
benim müdahalem olacak mı?"*

**Çözüm — API sözleşmesi bir dosya değil, bir sohbet.** İki şeyi kur:

**A) Ekran → endpoint eşleme tablosu.**
Her ekran için hangi endpoint'in hangi alanları döneceğini yaz. Bu tabloyu sen
çıkarıp arkadaşına verirsen onun işi kolaylaşır ve sonradan "bu alan yok"
sürprizi yaşamazsın. (Bkz. [Bölüm 14](#14-ekran--endpoint-eşleme-tablosu))

**B) Erken ve boş bir API.**
Ondan iste: *"her endpoint'i önce sabit örnek veri dönecek şekilde yaz, gerçek
mantığı sonra doldur."* FastAPI'da bu 10 dakikalık iş. Sen 1. günden gerçek
HTTP'ye bağlanırsın, o motoru geliştirirken sen UI'ı geliştirirsin.

### 8.4 "Kendim UI için endpoint yazsam sorun olur mu?"

Bu bir kalıp: **BFF (Backend For Frontend)**. Meşru ama **bu projede önerilmiyor:**

| Sorun | Açıklama |
|---|---|
| İki sunucu | Dağıtım, CORS, kimlik doğrulama, loglama iki katına çıkar |
| Docker dağıtımı | Dokümanda Docker ile dağıtım yazıyor; ikinci konteyner müşteri kurulumunu zorlaştırır |
| İki kişilik ekip | İki backend, tartışmayı "kim neyi yazacak"a çevirir |

**Daha iyisi:** İhtiyacın olan şeyi arkadaşına söyle, FastAPI'ye eklesin. Genelde
5 satırlık iş. O "bu benim işim değil" derse veya cevap veremeyecek kadar
meşgulse, o zaman BFF konuşulur — ama başlangıç pozisyonu bu olmasın.

**İstisna:** Tamamen istemcide çözülebilecek şeyleri backend'e sorma.
Filtreleme, sıralama, gruplama, zaman dönüşümleri — veri elindeyse JavaScript'te
yap. Bu, "kendi API'm" ihtiyacının yarısını ortadan kaldırır.

---

## 9. Video taşıma: RTSP / WebRTC / WebSocket / HTTP

### 9.1 Kavramları ayıralım

| Protokol | Ne için | Tarayıcıda? |
|---|---|---|
| **RTSP** | IP kamera / VMS yayın protokolü | **Hayır. Hiçbir tarayıcı oynatamaz.** Sadece backend ↔ kamera arasında yaşar |
| **RTCP** | RTP'nin kontrol alt protokolü | İlgilenmeyeceğin bir katman. Muhtemelen "WebRTC" kastedildi |
| **WebRTC** | Gerçekten düşük gecikmeli (<500 ms) canlı yayın | Evet ama ağır: signaling sunucusu, ICE/STUN/TURN, transcoding |
| **WebSocket** | İki yönlü mesajlaşma | Video için tasarlanmadı. Yapılabilir ama decode/buffer/seek'i kendin yazarsın — kötü fikir |
| **HTTP Range (progressive MP4)** | `<video src="...">` | Evet. Tarayıcı gerekli baytı ister, seek eder. **Sıfır efor** |
| **HLS / DASH** | Videoyu segmentlere bölüp manifest ile sunma | Evet (hls.js ile). Uzun videolar ve çoklu kalite için standart |

Dokümanda `RTSP 스트림 등록` yazması **backend'in RTSP'den çekip analiz edeceği**
anlamına gelir — tarayıcıda RTSP göreceğimiz anlamına gelmez.

### 9.2 Belirleyici soru: canlı izleme var mı?

Dokümanın cevabı net:

> *현 시점 실시간 영상 확인 기능은 기획안에 존재하지 않음. 실시간 관제는 Athena
> 운영뷰어 등의 타 플랫폼을 사용하는 것으로 개발 방향을 잡음.*

**Gerçek zamanlı izleme kapsam dışı.** Onun için Athena'nın kendi viewer'ı
kullanılacak.

### 9.3 Karar

| İhtiyaç | Çözüm | Neden |
|---|---|---|
| Kayıtlı video oynatma (%95 kullanım) | **HTTP Range + MP4 (H.264/AAC)**, `<video>` | Bedava seek, buffer, kodek desteği |
| 30 dk+ videolar, hızlı seek | **HLS (fMP4)** + hls.js | Uzun dosyada baştan indirme derdi yok |
| Analiz ilerlemesi, iş durumu, Re-ID sonuçları | **Polling → sonra WebSocket** | Sunucu → istemci push |
| Canlı kamera | **Şimdilik yapma** | Kapsam dışı; istenirse sonra WHEP/WebRTC |

**Doğru cümle: "Video HTTP üzerinden, WebSocket sadece bildirim için."**
Bunlar rakip değil, farklı işler.

### 9.4 Video kodek tuzağı — backend'e sorulacak

VMS'den inen video büyük ihtimalle **H.265/HEVC** olacak. Chrome'da HEVC desteği
donanıma bağlı ve güvenilmez.

**Arkadaşına soracağın hali (kopyala-yapıştır):**

> VMS'ten inen videoyu tarayıcıda `<video>` etiketiyle oynatacağım. Dört şeyi
> netleştirelim:
>
> 1. **Kodek ne olacak?** H.265/HEVC gelirse Chrome'da güvenilir oynamıyor.
>    Oynatma kopyasını **H.264 (baseline/main) + AAC** olarak çıkarabilir misin?
> 2. **`-movflags +faststart` uygulanacak mı?** Bu bayrak yoksa MP4'ün index'i
>    (moov atom) dosyanın **sonunda** kalıyor; tarayıcı oynatmaya başlamadan önce
>    **tüm dosyayı** indirmek zorunda kalıyor. 24 saatlik videoda bu
>    "kullanılamaz" demek.
> 3. **Sunucu HTTP Range request destekliyor mu?** Desteklemezse seek (zaman
>    çubuğunda atlama) çalışmaz — ki bu uygulamanın temel işlevi.
> 4. **GOP (keyframe aralığı) ne olacak?** Uzun GOP'ta seek en yakın keyframe'e
>    yuvarlanır, "şu saniyeye git" dediğimde 2–3 saniye sapabilirim. Olay
>    listesinden tıklayınca yanlış ana gitmek kötü görünür. **1–2 saniyelik GOP**
>    istiyorum.

**Neden şimdi soruyorsun:** Dördü de backend tarafında tek satırlık ayar. Ama
sonradan fark edilirse tüm depolanmış videoların yeniden işlenmesi gerekir —
2.400 saatlik arşivde bu haftalar demek. Şimdi 5 dakikalık konuşma, sonra 2 hafta.

---


### 9.5 H.264 mi, MJPEG mi — kaynak kodek kararı

Backend geliştiricisi VMS kayıtlarının **H.264 olma ihtimalinin yüksek**
olduğunu söyledi. Bu iyi haber. İki adayın karşılaştırması:

| | **H.264 / AVC** | **MJPEG** |
|---|---|---|
| Sıkıştırma | Kareler arası (I/P/B) | Yok — her kare bağımsız JPEG |
| Dosya boyutu | 1× (referans) | **10–20×** |
| 24 saat @1080p | ~40 GB | ~500 GB – 1 TB |
| Tarayıcıda `<video>` | ✅ evrensel | ❌ **desteklenmez** |
| Seek doğruluğu | GOP'a bağlı (±1–4 sn) | ✅ **her kare keyframe**, tam hassas |
| Kare çıkarma (analiz) | Çözme gerekir | ✅ doğrudan JPEG |
| Bozuk kare etkisi | Sonraki kareler bozulur | Tek kare bozulur |
| CPU (kodlama) | Yüksek | Çok düşük |
| Tipik kullanım | Modern IP kamera, NVR | Eski kameralar, endüstriyel, düşük gecikme |

**Frontend açısından karar nettir: her iki durumda da H.264 proxy gerekir.**
MJPEG'i tarayıcıda `<video>` ile oynatamazsın — `video/x-motion-jpeg`
Chrome'da desteklenmiyor. (MJPEG'in tarayıcıda çalıştığı tek yer canlı akış:
`<img src="…">` + `multipart/x-mixed-replace`. Bu, kaydedilmiş ve seek
edilebilir bir dosya için işe yaramaz.)

#### Kaynak H.264 ise: remux, yeniden kodlama değil

Bu ayrım büyük bir kazanç:

| | Remux (`-c copy`) | Yeniden kodlama (`libx264`) |
|---|---|---|
| Ne yapar | Baytları yeni konteynere taşır | Her kareyi çözer ve yeniden kodlar |
| 30 dk video | **~2 saniye** | ~90 saniye |
| Kalite | Birebir aynı | Bir nesil kayıp |
| CPU/GPU | Neredeyse sıfır | Yoğun |
| GOP değiştirilebilir mi | ❌ hayır | ✅ evet |
| Ölçek/fps değiştirilebilir mi | ❌ hayır | ✅ evet |

```bash
# Remux — kaynak zaten tarayıcı dostuysa
ffmpeg -i kaynak.mp4 -c copy -movflags +faststart proxy.mp4
```

**Remux'un mümkün olma koşulları** (üçü de sağlanmalı):
1. Kodek `h264`
2. `pix_fmt` = `yuv420p` — 422/444 veya 10-bit ise Chrome oynatmaz
3. Ölçek ve fps değiştirilmeyecek

`tools/add_video.py` bu kontrolü yapıp otomatik karar veriyor: önce remux
dener, koşullar sağlanmıyorsa yeniden kodlamaya düşer. Hangisini yaptığını
ekrana yazar ve GOP'u ölçüp uyarır.

#### Karar tablosu

| Kaynak | Ne yapmalı | Maliyet |
|---|---|---|
| H.264 + yuv420p + kısa GOP | **Remux** | ~saniyeler |
| H.264 + yuv420p + uzun GOP | Remux (seek ±GOP) veya hassas seek için yeniden kodla | seçime bağlı |
| H.264 + yuv422p/10-bit | Yeniden kodla | ~1× gerçek zaman |
| H.265 / HEVC | Yeniden kodla (Chrome güvenilmez) | ~1× gerçek zaman |
| **MJPEG** | Yeniden kodla — başka yolu yok | ~1× gerçek zaman, ama depolama 10× azalır |

**MJPEG'in tek avantajı analiz tarafında:** her kare bağımsız JPEG olduğu için
motor kare çıkarmayı çok ucuz yapar. Ama bu backend'in avantajı, frontend'in
değil — ve depolama maliyeti bunu çoğu zaman götürür.

## 10. BBox nerede çizilecek?

### 10.1 Karar: UI'da overlay olarak. Net.

`<video>` elementinin üstüne mutlak konumlu bir `<canvas>` koyulur. Backend
metadata JSON'u gönderir, frontend çizer.

```json
{
  "video_id": "cam01-20250520",
  "source_width": 1920,
  "source_height": 1080,
  "fps": 30,
  "frames": [
    {
      "t": 12.400,
      "boxes": [
        {
          "track_id": 41,
          "cls": "person",
          "conf": 0.91,
          "xyxy": [0.31, 0.22, 0.38, 0.55],
          "attrs": { "gender": "male", "upper_color": "red" }
        }
      ]
    }
  ]
}
```

### 10.2 Neden gömme (burn-in) değil

| | **UI overlay** | **Videoya gömme** |
|---|---|---|
| Aç/kapa | Anında | İki ayrı video dosyası gerekir |
| Filtreleme ("sadece kırmızı montlular") | Anında, istemcide | İmkânsız — yeniden encode |
| BBox'a tıklayıp nesne detayı | Doğal | İmkânsız |
| Sunucu maliyeti | Sıfır | Her video için tam yeniden encode (GPU zaten meşgul) |
| Depolama | JSON birkaç MB | İkinci bir video kopyası |
| Görsel kalite | Keskin vektör | Video sıkıştırmasıyla bulanıklaşır |
| Yeniden analiz sonrası | JSON değişir, video aynı | Video yeniden üretilir |
| Track yolu, ısı haritası, vurgu | Kolay | İmkânsız |

Bu projede **filtreleme ve tıklanabilirlik zorunlu gereksinim** (nesne filtresi,
nesne listesinden tıklayıp o ana gitme, takip listesi vurgulama). Gömme bunları
baştan öldürür.

### 10.3 Tek istisna: dışa aktarma

Fonksiyon listesi madde 15/17: `요약 결과 내보내기`. Kullanıcı raporu dışarıya,
sistemi bilmeyen birine verecek. O dosyada kutular gömülü olmalı.

> **Ekranda overlay, export'ta burn-in.**
> Burn-in'i backend ffmpeg ile sadece export anında yapar.

### 10.4 Overlay yaparken 5 dikkat noktası

**1. Normalize koordinat iste (0–1 aralığı).**
Piksel alırsan her ölçek değişiminde bölme yapman ve kaynak çözünürlüğü bilmen
gerekir. Bunu API sözleşmesine yaz.

**2. Letterbox hesabı.**
`<video>` `object-fit: contain` ile render edilir; element videonun en-boy
oranında değilse üstte/altta siyah bant olur. Canvas'ı elementin tamamına
yayarsan kutular kayar.

*Kolay çözüm:* container'ı `aspect-ratio: var(--video-ar)` ile videonun oranına
sabitle. O zaman siyah bant hiç oluşmaz ve `canvas.width = element.clientWidth`
yeterli olur.

*Genel çözüm:*
```js
const scale = Math.min(elW / videoW, elH / videoH);
const dispW = videoW * scale, dispH = videoH * scale;
const offX = (elW - dispW) / 2, offY = (elH - dispH) / 2;
// çizim: offX + box.x1 * dispW,  offY + box.y1 * dispH
```

**3. `requestVideoFrameCallback` kullan, `timeupdate` değil.**
`timeupdate` saniyede ~4 kez tetiklenir. 30 fps videoda kutular takılarak akar.

```js
function onFrame(now, meta) {
  drawBoxes(meta.mediaTime);
  video.requestVideoFrameCallback(onFrame);
}
video.requestVideoFrameCallback(onFrame);
```

**4. `devicePixelRatio` ölçeklemesi.**
Unutursan retina ekranda kutular bulanık çıkar.
```js
const dpr = window.devicePixelRatio || 1;
canvas.width  = cssW * dpr;
canvas.height = cssH * dpr;
ctx.scale(dpr, dpr);
```

**5. Kalabalık sahne.**
50+ kutuda DOM elemanı (SVG/div) kullanma, canvas'a çiz. Tıklama algılamayı
canvas üzerinde koordinat testiyle yap.

### 10.5 Bonus: track yolu (trajectory)

Kutu çizmenin ötesinde asıl değerli şey, bir nesnenin geçmiş konumlarını soluk
bir çizgi olarak çizmek. "Bu adam nereden geldi" sorusunu tek bakışta cevaplar.
Metadata'da zaten `track_id` var, ekstra veri gerektirmez.

---

## 11. Uzun süren işler: polling mi WebSocket mi?

### 11.1 Sorun istek sayısı değil, istek süresi

| İşlem | Süre |
|---|---|
| 30 dk video analizi | **8 dakika** (hedef) |
| 24 saatlik video analizi | **6+ saat** |
| VLM ile 30 segment doğrulama | ~1 dakika |
| Re-ID eşleştirme | 10–60 saniye, kademeli |

8 dakika boyunca açık bekleyen bir HTTP isteği kuramazsın — proxy'ler, yük
dengeleyiciler ve tarayıcı 30–60 saniyede bağlantıyı keser. Ayrıca kullanıcı bu
sürede ekranda dönen çarkı izleyemez.

### 11.2 Doğru desen

```
POST /analyses              → { "job_id": "abc123" }        (anında döner)

sonra ya polling:
GET  /jobs/abc123           → { "progress": 45, "stage": "clip_embedding",
                                "eta_sec": 260 }

ya da WebSocket:
WS   /ws/jobs/abc123        → sunucu ilerleme mesajları yollar
```

Bu zaten gereksinim olarak yazılı: **22번 `분석 진행 상태 조회` —
"분석 진행률 및 예상 완료 시간 표시"** (ilerleme yüzdesi ve tahmini bitiş süresi).

### 11.3 Karşılaştırma

| | **Polling** | **WebSocket** |
|---|---|---|
| Kurulum | 5 satır (`setInterval` + `fetch`) | ~50 satır (yeniden bağlanma, backoff, mesaj ayrıştırma) |
| Gecikme | 2–5 saniye | Anlık |
| 10 iş aynı anda | 10 istek × her 2 sn | 1 bağlantı |
| Çift yönlü (Re-ID "devam et") | Ayrı endpoint gerekir | Doğal |
| Hata ayıklama | Kolay (Network sekmesi) | Zor |
| Proxy/firewall | Sorunsuz | Bazen sorun çıkarır |

### 11.4 Öneri

**İlk fazda polling ile başla.** Çok daha basit, hata ayıklaması kolay. Sistem
oturduktan sonra, Re-ID'nin kademeli sonuç akışına geldiğinde WebSocket'e geç.
Erken WebSocket, gereksiz karmaşıklık.

Backend'e söylenmesi gereken: *"İlerleme durumu için bir endpoint lazım, ileride
WebSocket'e çevirebilir miyiz?"*

### 11.5 SSE alternatifi

Akış tek yönlüyse (sunucu → tarayıcı) **SSE (Server-Sent Events)** daha basit:
`EventSource` API'si tek satır, otomatik yeniden bağlanır, proxy dostu.

Ama Re-ID akışında kullanıcı "bu doğru değil, aramaya devam et" diyecek — çift
yönlü. İki farklı kanal yönetmemek için **WebSocket'te karar kılmak** daha
temiz. (Alternatif: SSE + normal POST ile "devam" komutu. Bu da çalışır ve daha
basittir.)

---

## 12. Ekran analizi — tek video özeti

> Ekran görüntüsü #1 (`단일 영상 요약 화면`) referans alınmıştır.
> Ekran görüntüsü #2 (`복합 상황 요약 화면`) bozuk geldiği için analiz edilemedi —
> tekrar alınması gerekiyor.

### ① Sol üst — `영상 그룹` ağacı

```
Area1
 ├── Camera1  ← seçili
 ├── Camera2
 ├── Camera3
 └── Camera4
Area2
Area3
Area4
```

- Grup arama kutusu var → istemci tarafında filtreleme yeter
- Doküman: *"아이콘 색상을 통해 분석 여부와 분석 가능 여부를 확인할 수 있음"*
  → ikon rengi `video_status` enum'una bağlanacak (Bkz. Bölüm 13)
- `video_source_type` (file/rtsp/uploaded/archive) da farklı ikon gerektirir —
  RTSP kaynağı ile yüklenmiş dosya kullanıcı için farklı şeyler

### ② Sol alt — `객체 필터`

```
객체 종류   : [전체 ▾]  [사람] [차량]
성별        : [전체] [남성] [여성]
의상 색상   : ● ● ● ● ● ● ● ●  [전체]
              [필터 적용]
              [필터 초기화]
```

- Tamamen PAR çıktısı üzerinde çalışıyor (Bkz. Bölüm 5)
- `필터 적용` butonu var → **filtre otomatik değil, uygulanınca çalışıyor.**
  İyi tercih: her tıklamada istek atmıyoruz
- Renk noktaları PAR sınıf listesiyle birebir eşleşmeli
- Nesne tipine göre alanlar değişmeli: 차량 seçilince cinsiyet gizlenip
  araç tipi görünmeli

### ③ Üst şerit — `영상 정보`

```
Area1 > Camera1  [요약 완료]              [영상 정보] [재요약]
요약 시간 범위  2025-05-20 00:00:00 ~ 2025-05-20 23:59:59
```

- Breadcrumb + durum rozeti + kapsam + aksiyon butonları
- `재요약` (yeniden özetle) → uzun süren iş → ilerleme akışı devreye girer
- `영상 정보` → modal: çözünürlük, FPS, süre, kodek (fonksiyon listesi madde 4)
- Bu şerit sürekli görünmeli — [Bölüm 3](#3-kritik-arama-kapsamı-ve-ölçek-gerçeği)'teki
  "kapsam görünürlüğü" ihtiyacını karşılıyor

### ④ Oynatıcı

```
[video]
  sol üst yer paylaşımı: 2025-05-20 08:34:15
  alt bar: ▶  ⟲10  🔊  08:34:15 / 23:59:59  ━━━●━━━  📷  ⛶  [원본 영상 보기]
```

**Önemli gözlemler:**

- **Özel kontroller var** → tarayıcının varsayılan `controls` özniteliği
  kullanılmayacak, kendi kontrol çubuğumuzu yazacağız
- `08:34:15 / 23:59:59` → bu **medya zamanı değil, duvar saati**.
  `video.currentTime + video_start_time` dönüşümü sürekli yapılacak
- `📷` → ekran görüntüsü alma. Canvas'a çizip indirme (bbox dahil mi hariç mi?
  seçenek sunulabilir)
- `원본 영상 보기` → **demek ki varsayılan oynatılan şey özet video.**
  Bu çok önemli, Bölüm 12.6'ya bak
- **Eksik gördüğüm:** İlerleme çubuğunun üstünde olay yoğunluğunu gösteren
  renkli işaretler yok. 24 saatlik videoda kullanıcının nerede bir şey olduğunu
  tek bakışta görmesi için bu eklenmeli. **Öneri olarak sun.**

### ⑤ Alt — `요약 정보`

```
영상 길이   요약 길이         주요 객체       주요 이벤트   요약 생성 시간
23:59:59    00:05:38 (3%)    사람 2, 차량 1   5            2025-05-20 23:45:10
```

24 saatlik video 5.5 dakikaya özetlenmiş — %3. Yani **özet video ayrı bir
çıktı.** Bu, aşağıdaki kritik soruyu doğuruyor.

### ⑥ Sağ — `시간별 사건 흐름`

```
● 08:31:12  흰색 셔츠를 입은 남성이 출입문으로 들어오는 모습   [thumb]
○ 08:33:47  정문 밖에서 통화를 하며 주변을 살피는 모습          [thumb]
○ 08:35:29  검은색 차량(세단)이 주차장으로 진입                 [thumb]
○ 08:37:05  남성이 차량 조수석에 탑승                           [thumb]
○ 08:42:18  차량이 주차장을 빠져나감                            [thumb]
              [☰ 모든 이벤트 보기]
```

- VLM çıktısı: zaman + doğal dil açıklaması + temsilci frame thumbnail'ı
- Dikey timeline, aktif olan vurgulu
- Tıklayınca oynatıcı o ana atlar
- `모든 이벤트 보기` → sayfalama var:
  `GET /videos/{id}/events?limit=&offset=`
- Açıklama metinleri Korece geliyor → **SORU:** dil ayarı var mı, prompt dili
  çıktı dilini mi belirliyor?

### ⑥b Anlatı akışı gözlemi

Yukarıdaki 5 olay aslında **tek bir hikâye**: adam giriyor → telefonla konuşuyor
→ araba geliyor → adam biniyor → araba gidiyor. Yani sistem bağımsız olayları
değil, **bağlantılı bir anlatı** üretmeyi hedefliyor.

**SORU:** Olaylar arasında ilişki bilgisi (aynı `track_id`, aynı olay zinciri)
dönüyor mu? Dönüyorsa UI'da bunları gruplayıp "senaryo" olarak gösterebiliriz —
büyük değer katar.

### 12.6 Kritik: hangi video oynuyor?

`원본 영상 보기` butonunun varlığı, varsayılanın **özet video** olduğunu
gösteriyor. Bu, bbox metadata'sı için ciddi bir sorun yaratıyor:

```
Orijinal zaman ekseni:  00:00 ──── 08:31 ─── 08:33 ─── 08:35 ──── 23:59
                                     ▓▓        ▓▓        ▓▓
                                     olaylar

Özet video ekseni:      00:00 ▓▓▓▓▓▓▓▓▓▓▓▓▓ 05:38
                              olaylar arka arkaya
```

Özet videonun 12. saniyesi orijinalin 08:33:47'sine karşılık gelir. BBox'ları
çizerken **hangi zaman eksenini kullanacağımı bilmem gerekiyor.**

**Gerekli veri (backend'den istenecek):**

```json
{
  "summary_video_id": "sum-001",
  "segments": [
    { "sum_start": 0.0,  "sum_end": 18.5,
      "src_video_id": "cam01", "src_start": 30672.0, "src_end": 30690.5 },
    { "sum_start": 18.5, "sum_end": 42.0,
      "src_video_id": "cam01", "src_start": 30827.0, "src_end": 30850.5 }
  ]
}
```

Bu tablo olmadan özet video üzerinde bbox çizmek, olay listesiyle senkronize
etmek ve "orijinale git" butonu yapmak imkânsız.

---

## 12b. Ekran analizi — 복합 상황 요약 (çoklu kamera)

> İkinci ekran görüntüsü geldi. Tasarım "kesin böyle olacak" değil, başlangıç
> noktası — ama birkaç kritik karar içeriyor ve bunlar mockup'takinden farklı.

### En büyük fark: timeline DİKEY

```
Ekran görüntüsü                        Mockup'ta yaptığım
─────────────────────────────          ────────────────────────
시간 │ Cam1 │ Cam2 │ Cam3 │ Cam4       Cam1 ├──▮──▮────────────
08:30│      │      │      │            Cam2 ├────▮───▮─────────
08:31│  ▮   │      │      │            Cam3 ├──▮────────▮──────
08:32│      │  ▮   │      │            Cam4 ├───────▮──────────
08:33│  ▮   │      │      │                 08:30  08:32  08:34
      ↓ zaman aşağı akar                    → zaman sağa akar
```

| | Dikey (ekran görüntüsü) | Yatay (mockup) |
|---|---|---|
| Kamera sayısı | Sütun — 4-6 kamera sığar, fazlası yatay kaydırma | Satır — 20+ kamera dikey kaydırmayla rahat |
| Olay metni | **Kart içinde okunabilir** (thumbnail + 2 satır açıklama) | Sadece renkli blok, metin tooltip'te |
| Zaman aralığı | Dikey kaydırma doğal, ama 24 saat çok uzun sayfa | Zoom ile 24 saat tek ekranda |
| Kameralar arası akış | Eğri çizgiler görsel olarak güçlü | Bézier eğrisi, daha sıkışık |
| Alışkanlık | Kakao/Line sohbet akışı gibi — Kore'de tanıdık | Video düzenleme yazılımı gibi |

**Değerlendirmem:** Dikey tasarım **az kamera + kısa zaman aralığı** için
belirgin şekilde daha iyi — olay kartları okunabiliyor, hikâye akışı
sohbet gibi takip ediliyor. Ama Area2 senaryosunda (3 kamera × 24 saat,
100+ olay) dikey liste kilometrelerce uzar.

**Öneri: ikisi de olsun, kullanıcı seçsin.** Zaten sekme yapısı var
(`호름도` / `지도 보기`) — üçüncü bir görünüm modu eklemek doğal.
Varsayılan dikey (tasarımdaki gibi), "yoğun mod" yatay.

### Ekran görüntüsünden çıkan diğer kararlar

| Gözlem | Sonuç |
|---|---|
| Üstte sekmeler: `호름도` / `지도 보기` | Harita görünümü gerçekten planlanmış → `camera.latitude/longitude` kullanılacak |
| Filtre çipleri: `사람 / 차량 / 이벤트 / 기타` | Timeline'ın kendi filtresi var, sol paneldeki PAR filtresinden **ayrı** |
| `시간 정렬` açılır menüsü | Sıralama seçenekleri var — zamana göre / önem derecesine göre? |
| `이벤트 검색` kutusu | Timeline üstünde ayrı arama — prompt araması mı, metin filtresi mi? **Soru** |
| Bazı olaylarda ⚠ ikonu | `severity` görsel olarak ayrışıyor (şemadaki `severity smallint`) |
| Sağ panelde **video oynatıcı** var | Sadece thumbnail değil — olay seçilince o klip oynuyor. Bu, olay başına ayrı bir klip dosyası mı, yoksa ana videoda seek mi? **Soru** |
| Sekmeler: `이벤트 정보` / `연관 이벤트 (6)` | **`event_group_id`'nin UI karşılığı** — aynı sahnenin diğer 6 olayı |
| `연관 객체 ID: P_20250520_0001` | **`global_identity`'nin UI karşılığı.** Formatı anlamlı: P (person) + tarih + sıra |
| `객체 정보: 성별 남성 / 상의 흰색 / 하의 검정` | PAR çıktısı olay detayında da gösteriliyor |
| Alt köşede zoom: `🔍- ——— 🔍+ 맞춤` | Timeline zoom'u buton + kaydıraç ile, tekerlekle değil |
| `원본 영상 전체 보기` / `스냅샷 저장` | İki eylem: orijinale git, ekran görüntüsü al |

### Mockup'la uyum durumu

| Özellik | Mockup'ta | Durum |
|---|---|---|
| Kameralar arası bağlantı çizgisi | ✅ var (Bézier) | Yön farklı |
| Olay kartı + thumbnail | ⚠️ sadece sağ panelde | Timeline'a taşınmalı (dikey tasarımda) |
| `연관 이벤트` sekmesi | ✅ veri var (`event_group_id`), UI yok | Eklenebilir |
| `연관 객체 ID` | ✅ veri var (takip listesi) | Etiket formatı eklenmeli |
| Sağ panelde oynatıcı | ❌ yok | Eklenmeli |
| `지도 보기` | ❌ yok | `latitude/longitude` hazır |
| Timeline filtre çipleri | ⚠️ sol panelde var | Timeline'a da eklenmeli |

---

## 13. DB şeması — neyi cevapladı, neyi açtı

`video_analytics_schema_v2` elimize geçti. Bu bölüm şemanın frontend'e ne
söylediğini, hangi açık soruları kapattığını ve hangi yeni soruları doğurduğunu
toplar.

### 13.1 Enum'lar — UI durum makinelerinin kaynağı

Şemadaki her enum, UI'da bir görsel karşılığa dönüşür. **Yazım farkı bile
entegrasyonda hata demek** — örneğin `canceled` tek L ile yazılmış; mockup'ta
başta `cancelled` kullanmıştım, şemayı görünce düzelttim.

#### `video_source_type`

| Değer | Anlam | UI karşılığı |
|---|---|---|
| `file` | Sunucu veya yerel dosya | ▤ dosya ikonu |
| `rtsp` | RTSP canlı akış | ⦿ anten ikonu — canlı kaynak belli olmalı |
| `uploaded` | Web üzerinden yüklenmiş | ↑ yükleme ikonu |
| `archive` | Dış depodan getirilmiş | ▣ arşiv ikonu |

#### `video_status`

| Değer | UI karşılığı | Tıklanabilir? |
|---|---|---|
| `registered` | Gri nokta | Hayır |
| `uploading` | Gri + ilerleme çubuğu | Hayır |
| `ready` | Mavi nokta + "분석" butonu | Analiz başlat |
| `analyzing` | Sarı, yanıp sönen + yüzde + ETA | İptal et |
| `completed` | Yeşil nokta | **Evet — sonuç aç** |
| `failed` | Kırmızı + tooltip'te hata | Yeniden dene |
| `deleted` | **Listede gösterme** | — |

#### `analysis_run_status` — `queued / running / completed / failed / canceled`

İş kuyruğunun durumu. `video_status`'tan **ayrı** olması önemli: bir video
`completed` olabilir ama yeni bir analiz koşusu `running` olabilir (재요약).
UI'da bu iki durumu karıştırmamak gerekiyor.

#### `event_status` — `candidate / confirmed / dismissed`

**Bu enum bende hiç yoktu ve eksik bir UI özelliğini ortaya çıkardı.**

VLM'in ürettiği her olay `candidate`'tır — yani makine tahmini. Operatör
`confirmed` (확정) ya da `dismissed` (오탐, yanlış pozitif) işaretler.

Sonuçları:
- Olay listesindeki her satıra **확정 / 오탐** butonları eklendi
- `dismissed` olaylar soluk gösteriliyor, silinmiyor (denetim izi kalsın)
- Rapor/export yalnızca `confirmed` olayları almalı — **Soru 21**
- Olay listesi `?status=` ile filtrelenebiliyor

Bu, ürünün "AI önerir, insan onaylar" felsefesinin veritabanına yazılmış hâli.
Kontrol odası yazılımında bu şart: operatör yanlış alarmı eleyebilmeli.

#### `identity_match_status` — `candidate / confirmed / rejected`

Re-ID eşleşmesinin kullanıcı kararı. Benim ad-hoc `same/different`
değerlerimin yerini aldı. `track_identity_match.matched_by` alanı da var:
eşleşmeyi **kim** yaptı — `user` mı `system` mi? Denetim ve model
değerlendirmesi için kritik.

### 13.2 Şema hangi sorularımı cevapladı

| Eski soru | Cevap | Kaynak |
|---|---|---|
| **Zaman damgaları hangi zaman diliminde?** | `camera.timezone` var — kamera bazında. Ayrıca tüm zaman alanları `timestamptz`. | `camera.timezone` |
| **Olaylar arasında ilişki bilgisi var mı?** | **Evet.** `vlm_event.event_group_id` — *"여러 카메라의 동일 사건을 묶는 ID"*. Yani olaylar bağımsız değil, bir hikâyenin parçası. | `vlm_event.event_group_id` |
| **Harita görünümü için kamera koordinatı var mı?** | **Evet.** `camera.latitude`, `camera.longitude`. `지도 보기` sekmesi gerçekten kameraları haritada gösterecek. | `camera` |
| **İş kuyruğu modeli nedir?** | İki katman: `analysis_job` (kullanıcının isteği, çok video olabilir) → `analysis_run` (her video için ayrı). Prompt **job** seviyesinde saklanıyor. | `analysis_job`, `analysis_run` |
| **Aday aralık seçimi kalıcı mı?** | **Evet.** `event_candidate_score` tablosu var: `metric_code`, `score`, `threshold`, `details jsonb`. Yani Plan 1'in skorları DB'ye yazılıyor ve UI'da gösterilebilir. | `event_candidate_score` |
| **VLM ham cevabı saklanıyor mu?** | **Evet.** `vlm_event.raw_response jsonb` + `prompt`. Hata ayıklama ve yeniden değerlendirme mümkün. | `vlm_event` |
| **Re-ID vektörleri nerede?** | `reid_embedding`, PostgreSQL **pgvector**. Ayrıca `representative_frame_id` (kırpma görüntüsünün geldiği kare) ve `quality_score`. | `reid_embedding` |
| **Model versiyonu izleniyor mu?** | **Evet.** `ai_model` tablosu + `analysis_run_model` (rol + parametreler). "Bu sonuç hangi modelle üretildi" cevaplanabilir. | `ai_model` |
| **Olay tipleri sabit mi?** | `event_type` bir tablo, enum değil → çalışma zamanında eklenebilir. UI tipleri **API'den** çekmeli, sabit kodlamamalı. | `event_type` |

### 13.3 Şemanın en önemli tablosu: `frame_index`

Şema açıklamasında *"영상과 모든 AI 분석 결과의 동기화를 담당하는 핵심
테이블"* deniyor — ve bu doğru. Frontend açısından altın değerinde:

| Alan | Ne işe yarıyor |
|---|---|
| `frame_number` | Video içindeki kare numarası |
| `pts` / `dts` | FFmpeg sunum/çözme zaman damgaları (`time_base` ölçeğinde) |
| `timestamp_ms` | **Video başlangıcına göre göreli zaman** → `video.currentTime * 1000` |
| `captured_at` | **Gerçek çekim zamanı (timestamptz)** → duvar saati |
| `is_keyframe` | **Keyframe mi** → seek doğruluğu |

Bu üç alan benim Bölüm 16.1'de anlattığım "üç zaman ekseni" probleminin
çözümü:

```
video.currentTime  ←→  frame_index.timestamp_ms   (÷1000)
frame_index.timestamp_ms  ←→  frame_index.captured_at   (duvar saati)
```

`is_keyframe` ise şunu mümkün kılıyor: **"olaya tıklayınca en yakın keyframe'e
git"**. GOP büyükse tarayıcı zaten oraya yuvarlıyor; keyframe listesi elimizde
olursa UI kullanıcıya doğru zamanı gösterebilir, "istediğim yer burası değil"
hissi oluşmaz.

**Ama bir uyarı:** 24 saatlik 30 fps video = **2.6 milyon frame_index satırı**
kamera başına. Bu tablo çok hızlı büyür. Backend'in bu satırları gerçekten her
kare için mi yazacağını, yoksa yalnızca keyframe + detection olan kareler için
mi yazacağını sorman gerekiyor — **Soru 22**.

### 13.4 Şemanın açtığı yeni sorular

| # | Soru | Neden önemli |
|---|---|---|
| **A** | `detection.bbox_x/y/width/height` **numeric** — birim belirtilmemiş. Piksel mi, normalize (0–1) mi? | Overlay çiziminin tamamı buna bağlı. Ayrıca format `xywh`, benim beklediğim `xyxy` değil — dönüşüm gerekli. |
| **B** | `detection` tablosunda `frame_id` var, yani **her detection bir frame_index satırına bağlı**. Frontend zaman aralığı ile sorgu atacak; bu JOIN indekslenmiş mi? | 24 saatlik videoda `WHERE timestamp_ms BETWEEN ...` yavaşsa oynatma takılır. |
| **C** | `vlm_event.related_track_ids bigint[]` — dizi. Frontend'e `track.id` (iç) mı `local_track_no` (tracker'ın verdiği) mi dönecek? | Overlay `local_track_no` ile eşleştiriyor; iç ID gelirse eşleşmez. |
| **D** | `global_identity.label` var ama Re-ID **ilk fazda yapılmayacak**. Takip listesi UI'ı hangi fazda devreye girecek? | Yol haritasını belirler. |
| **E** | `camera_group_member.display_order` var — grup içi sıra kullanıcı tarafından değiştirilebilir mi (sürükle-bırak)? | UI'da sıralama özelliği gerekir mi? |
| **F** | `video_asset.checksum_sha256` — aynı dosya iki kez yüklenirse UI ne yapmalı? Uyarı mı, sessiz birleştirme mi? | Yükleme akışının davranışı. |
| **G** | `event_candidate_score.details jsonb` içinde ne var? UI'da "bu olay neden seçildi" gösterebilir miyiz? | Güven ve hata ayıklama için çok değerli bir özellik olabilir. |

### 13.5 Mockup'ta yapılan hizalama

Şemayı gördükten sonra mockup şu değişikliklerle güncellendi:

- `cancelled` → **`canceled`** (enum yazımı)
- Tüm varlıklara **`public_id` (UUID)** eklendi — API'de `id` yerine bu kullanılır
- **`event_status`** eklendi + olay listesine 확정/오탐 butonları
- **`identity_match_status`** eklendi; Re-ID kararı artık
  `track_identity_match` kaydı üretiyor (`matched_by: user`)
- **`event_group_id`** eklendi — senaryodaki 4 olay grubu (`INC-1`…`INC-4`);
  P1'in hikâyesi Camera1 + Camera2'yi kapsıyor ve UI'da ⛓ rozetiyle görünüyor
- **`analysis_job` / `analysis_run` ayrımı** — iş ekranı artık iki katmanlı
- `camera`: `latitude`, `longitude`, `timezone`, `is_active`, `source_uri`
- `video_asset`: `duration_ms`, `frame_count`, `time_base_num/den`,
  `container_format`, `checksum_sha256`
- `vlm_event`: `start/end_timestamp_ms`, `occurred_start_at/end_at`,
  `severity` (smallint), `title`
- Yeni uçlar: `GET /api/events/{id}`, `POST /api/events/{id}/status`,
  `GET /api/event-groups`, `GET /api/analysis-jobs`
- Sunucu geçersiz enum değerini **400 ile reddediyor** (smoke test bunu
  doğruluyor) — üretimde de böyle olmalı


## 14. Ekran → Endpoint eşleme tablosu

> Bu tabloyu backend geliştiricisine götür. Eksikler burada ortaya çıkar.
> Endpoint isimleri öneri — asıl önemli olan **hangi ekranın hangi alanlara
> ihtiyacı olduğu.**

### 14.1 Kimlik doğrulama

| Ekran öğesi | Endpoint | Dönmesi gereken |
|---|---|---|
| Login | `POST /auth/login` | token, kullanıcı adı, rol |
| Oturum kontrolü | `GET /auth/me` | kullanıcı bilgisi |
| Çıkış | `POST /auth/logout` | — |

### 14.2 Sol panel — grup ve video ağacı

| Ekran öğesi | Endpoint | Dönmesi gereken |
|---|---|---|
| Ağaç | `GET /groups` | `[{ id, name, videos: [{ id, name, status, source_type, analyzing_progress? }] }]` |
| Grup arama | (istemci tarafı) | — |
| Grup CRUD | `POST/PUT/DELETE /groups` | Fonksiyon listesi madde 3 |

**Not:** Ağaç sık yenilenecek (analiz durumu değişiyor). Hafif tutulmalı —
her video için sadece id, ad, durum, tip.

### 14.3 Üst şerit — video bilgisi

| Ekran öğesi | Endpoint | Dönmesi gereken |
|---|---|---|
| Breadcrumb + durum | `GET /videos/{id}` | `{ id, name, group, status, source_type, start_time, end_time, duration }` |
| `영상 정보` modal | aynı endpoint | + `{ width, height, fps, codec, bitrate, file_size }` |
| `재요약` | `POST /videos/{id}/analyses` | `{ job_id }` |

### 14.4 Oynatıcı

| Ekran öğesi | Endpoint | Not |
|---|---|---|
| Video akışı | `GET /videos/{id}/stream` | HTTP Range destekli, H.264+faststart |
| Özet video | `GET /summaries/{id}/stream` | Aynı gereksinimler |
| Segment eşlemesi | `GET /summaries/{id}/segments` | Bölüm 12.6'daki tablo |
| BBox metadata | `GET /videos/{id}/detections?from=&to=` | **Zaman aralığına göre sayfalı** |

**BBox metadata için gereken alanlar:**
```
t (saniye), track_id, class, confidence,
xyxy (0-1 normalize), attrs { PAR çıktıları }
```

### 14.5 Alt — özet bilgisi

| Ekran öğesi | Endpoint | Dönmesi gereken |
|---|---|---|
| `요약 정보` kutusu | `GET /videos/{id}/summary` | `{ duration, summary_duration, ratio, main_objects: [{cls, count}], event_count, generated_at }` |

### 14.6 Sağ — olay listesi

| Ekran öğesi | Endpoint | Dönmesi gereken |
|---|---|---|
| Olay listesi | `GET /videos/{id}/events?limit=&offset=` | `[{ id, t_start, t_end, wall_time, description, thumbnail_url, score, related_track_ids? }]` |
| Olay detayı | `GET /events/{id}` | + tam açıklama, ilgili nesneler, hangi kamera |
| `모든 이벤트 보기` | aynı endpoint, sayfalama | toplam sayı da dönmeli |

### 14.7 Nesne filtresi ve listesi

| Ekran öğesi | Endpoint | Not |
|---|---|---|
| Filtre seçenekleri | `GET /attributes` | PAR sınıf listesi — sabit kodlamamak için |
| Nesne listesi | `GET /videos/{id}/objects?class=&gender=&upper_color=&limit=&offset=` | crop URL'leri ile |
| Nesne detayı | `GET /objects/{id}` | tüm öznitelikler, göründüğü zaman aralığı |

**Nesne listesi dönüşü:**
```json
{
  "total": 1247,
  "items": [
    { "id": "o-991", "track_id": 41, "class": "person",
      "crop_url": "/crops/o-991.jpg",
      "first_seen": 30672.0, "last_seen": 30698.5,
      "video_id": "cam01", "camera_name": "Camera1",
      "attrs": { "gender": "male", "upper_color": "white", ... } }
  ]
}
```

### 14.8 Prompt araması

| Ekran öğesi | Endpoint | Not |
|---|---|---|
| Arama | `POST /videos/{id}/search` body: `{ "prompt": "..." }` | Cevap: `{ job_id }` veya doğrudan sonuç — **Soru 1'e bağlı** |
| Sonuç | `GET /searches/{id}` | timeline segmentleri + skorlar + VLM açıklamaları |
| Geçmiş aramalar | `GET /videos/{id}/searches` | Kullanıcı önceki aramaya dönebilsin |

### 14.9 Re-ID takip

| Ekran öğesi | Endpoint | Not |
|---|---|---|
| Eşleştirme başlat | `POST /objects/{id}/reid` | `{ session_id }` |
| Aday listesi | `GET /reid/{session_id}/candidates` veya WS | Kademeli |
| Devam et | `POST /reid/{session_id}/continue` | Kullanıcı "bunlar değil" dediğinde |
| Onayla | `POST /tracklists/{id}/members` | Takip listesine ekle |
| Takip listesi | `GET /tracklists/{id}` | Timeline vurgulaması için |

### 14.10 İş yönetimi ve sistem

| Ekran öğesi | Endpoint | Fonksiyon no |
|---|---|---|
| İş durumu | `GET /jobs/{id}` veya `WS /ws/jobs/{id}` | 22 |
| İş listesi/geçmişi | `GET /jobs` | 23 |
| İş iptali | `POST /jobs/{id}/cancel` | 23 |
| Log | `GET /logs?level=&from=&to=` | 24 |
| GPU durumu | `GET /system/gpu` | 25 |
| Ayarlar | `GET/PUT /settings` | 17–19 |
| Model listesi | `GET /models` | 18/20 |

### 14.11 Dışa aktarma

| Ekran öğesi | Endpoint | Fonksiyon no |
|---|---|---|
| Export başlat | `POST /exports` body: `{ type: "video"\|"excel"\|"word", ... }` | 15/17/26 |
| Export durumu | `GET /exports/{id}` | uzun sürer → job deseni |
| İndirme | `GET /exports/{id}/download` | — |

---

## 15. Frontend mimarisi

### 15.1 Teknoloji: Tailwind + Alpine.js

Daha önceki projelerde kullanılan yığın bu proje için de uygun — **sınırını
bilerek.**

**Alpine'ın iyi olduğu yerler (ekranın ~%70'i):**
paneller, ağaç görünümü, listeler, filtre formları, modal'lar, sekmeler,
ayar ekranları, durum rozetleri.

**Alpine'ın yetmeyeceği yerler:**
- Video overlay canvas'ı (her karede çizim)
- Timeline (zoom/pan yapılabilen zaman ekseni)
- Nesne grid'inin sanallaştırılmış kaydırması (binlerce crop)

Bunlar **vanilla JS sınıfı** olarak yazılmalı, Alpine store üzerinden haberleşmeli.

### 15.2 Önerilen yapı

```
Alpine store  (tek gerçek kaynak)
├─ scope          { groupId, videoIds[], timeRange }
├─ currentVideo   { id, startTime, duration, fps, w, h, status }
├─ playhead       { mediaTime, wallClockTime, isSummary }
├─ metadata       { detections[], events[], tracks[] }
├─ filters        { classes[], attrs{}, confMin }
├─ searchResult   { prompt, segments[], scores[] }
├─ trackList      [ takip edilen nesneler ]
└─ jobs           { id → { progress, stage, eta } }

Vanilla modüller  (store'u okur, store'a yazar)
├─ VideoOverlay   canvas, bbox çizimi, tıklama algılama
├─ Timeline       canvas, zoom/pan, olay çubukları, swimlane
├─ ObjectGrid     sanallaştırılmış crop listesi
└─ TimeMapper     medya zamanı ↔ duvar saati ↔ özet zamanı dönüşümü
```

### 15.3 Altın kural: playhead tek yerde

Video oynatıcı, timeline, olay listesi ve overlay — **hepsi aynı playhead
değerini okusun.** Üç ayrı yerde zaman tutulursa senkronizasyon hatası
kaçınılmazdır.

### 15.4 Timeline bileşeni

Projenin kalbi bu ve hazır kütüphaneler genelde uymaz.

**Gereksinimler:**
- Yatay eksen = gerçek saat (duvar saati)
- Çoklu kamera modunda **kamera başına bir satır** (swimlane)
- Olaylar renkli bloklar, hover'da doğal dil özeti tooltip
- Tıklayınca oynatıcı o ana atlar
- Zoom (24 saati de, 10 saniyeyi de görebilmeli) ve pan
- Takip listesindeki kişinin göründüğü aralıklar ayrı vurgulu
- Prompt araması sonrası skor yoğunluğu ısı haritası olarak gösterilebilir

**Öneri: canvas'ta kendin yaz.** Yaklaşık 400 satır iş. `vis-timeline` gibi DOM
tabanlı kütüphaneler binlerce olayda yavaşlar ve swimlane + zoom + özel çizim
kombinasyonunu zorlar.

### 15.5 Nesne grid'i

Binlerce crop görüntüsü olacak. Gerekenler:
- Sanallaştırma (sadece görünen satırları render et) veya
- `IntersectionObserver` ile lazy load
- `loading="lazy"` en azından
- Sabit boyutlu hücreler (layout shift olmasın)

**SORU:** Crop'lar nasıl servis ediliyor? Binlerce ayrı HTTP isteği tarayıcıyı
boğar. Sprite sheet mi, HTTP/2 var mı?

---

## 16. Frontend'in kendi problemleri

Bunlar backend'in düşünmediği, tamamen bizim çözmemiz gereken şeyler.

### 16.1 Zaman senkronizasyonu — en sinsi problem

Üç ayrı zaman ekseni var:

| Eksen | Örnek | Nerede kullanılır |
|---|---|---|
| **Medya zamanı** | `12.4` (saniye, 0'dan başlar) | `video.currentTime`, bbox metadata |
| **Duvar saati** | `2025-05-20 08:34:15` | Kullanıcıya gösterilen her şey |
| **Özet video zamanı** | `12.4` ama farklı içerik | Özet video oynarken |

Dönüşümler:
```
duvar saati    = video.start_time + medya_zamanı
özet → orijinal = segment eşleme tablosundan aranır
```

**Kural: Bu dönüşümleri tek bir `TimeMapper` modülüne koy. Hiçbir yerde
elle `+` yapma.** Bu, projede en çok bug üretecek alan.

Ayrıca: **zaman dilimi.** VMS'ten gelen zaman damgaları UTC mi, yerel mi?
**SORU.** Yanlış varsayım 9 saatlik kayma demek (KST = UTC+9).

### 16.2 Koordinat dönüşümü

Bölüm 10.4'te ayrıntılı. Özet: normalize koordinat iste, letterbox hesapla,
`devicePixelRatio` uygula.

### 16.3 Frame doğruluğu

- `timeupdate` yetmez → `requestVideoFrameCallback`
- Seek keyframe'e yuvarlanabilir → GOP ayarı istenmeli (Bölüm 9.4)
- Metadata her frame'de yoksa interpolasyon gerekebilir → **SORU:** bbox
  örnekleme oranı ne?

### 16.4 Büyük veri

| Veri | Miktar | Strateji |
|---|---|---|
| BBox metadata | 24s × 30fps × 20 nesne = 50M kayıt | Zaman aralığına göre sayfalı istek + istemci önbelleği |
| Crop görüntüleri | Binlerce | Sanallaştırma + lazy load |
| Olaylar | Yüzlerce | Sayfalama |
| Aday구간 skorları | Pencere başına 1 satır | Timeline ısı şeridi; 24 saatte seyreltilir |

**Önbellek stratejisi:** Oynatma sırasında bbox'ları önden yükle (örn. mevcut
konumdan +30 saniye), geride kalanları at.

### 16.5 Yeniden analiz sırasında tutarlılık

Kullanıcı `재요약`'a bastı, analiz 8 dakika sürecek. Bu sürede:
- Eski sonuç görünür kalsın mı?
- Kullanıcı başka videoya geçip dönebilir mi?
- İş bitince otomatik yenilensin mi, "yeni sonuç hazır" bildirimi mi?

**Karar gerekiyor.** Öneri: eski sonuç görünür kalsın, üstte bir şerit
"yeniden analiz sürüyor — %45" göstersin, bitince "yenile" butonu çıksın.

---

## 17. Öğrenme haritası — hangi kavram hangi dosyada

> Bu bölüm bir ödev listesi değil. Mockup'ta bu kavramların hepsi **çalışan
> kod olarak** var. Öğrenmenin yolu kursa gitmek değil; ilgili dosyayı açıp
> tek bir şeyi bozup ne olduğunu görmek. Her satırda "nasıl kırılır" var —
> en hızlı öğrenme yöntemi budur.

### Yüksek öncelik — bunlar olmadan ekran çalışmaz

| Kavram | Kod | Ne yapıyor | Nasıl kırılır (dene) |
|---|---|---|---|
| **HTML5 Video API** | `app.js` → `screenSingle`, `seek()`, `syncTime()` | Özel kontrol çubuğu, `currentTime`, `buffered`, `playbackRate` | `seek()` içinde `Math.min(video.duration - .05, …)` sınırını kaldır → son saniyede takılır |
| **`requestVideoFrameCallback`** | `overlay.js` → `start()` | Kare hassas çizim | `rVFC` dalını silip sadece `timeupdate` kullan → kutular saniyede 4 kez güncellenir, tırtıklı akar |
| **Letterbox geometrisi** | `overlay.js` → `geom()` | `object-fit: contain` kaymasını düzeltir | `ox`/`oy` offsetlerini 0 yap, pencereyi dar/geniş yap → kutular videodan kayar |
| **Normalize koordinat** | `overlay.js` → `draw()`, `X()`/`Y()` | 0–1 → piksel | `g.dw` yerine `this._cw` kullan → tam ekranda hepsi bozulur |
| **`devicePixelRatio`** | `overlay.js` → `resize()` | Retina keskinliği | `dpr = 1` yap → yüksek DPI ekranda bulanıklaşır |
| **Canvas hit testing** | `overlay.js` → `_hitTest()` | Kutuya tıklama | "en küçük alan kazanır" kuralını kaldır → iç içe kutularda hep dıştaki seçilir |
| **Zaman dönüşümü** | `core.js` → `TimeMapper` | Medya ↔ duvar saati ↔ özet | `startMs`'i 0 yap → tüm saatler 1970'e döner |

### Orta öncelik — ölçek ve akış

| Kavram | Kod | Ne yapıyor |
|---|---|---|
| **Canvas timeline, zoom/pan** | `timeline.js` → `X()`, `T()`, `_wheel()`, `_down()` | Ekran ↔ zaman dönüşümü, tekerlek zoom'u imlecin altındaki noktayı sabit tutar |
| **Swimlane + kameralar arası bağlantı** | `timeline.js` → `draw()`, `_drawLinks()` | Kamera başına satır, Bézier eğrisiyle Re-ID geçişi |
| **Uzun iş / SSE** | `core.js` → `listen()`; `app.js` → `watchJob()` | Tek fonksiyon; WebSocket'e geçiş = sadece burayı değiştirmek |
| **Akan sonuç UI'ı** | `app.js` → `doSearch()` | VLM cevapları geldikçe listeye ekleniyor, sayaç güncelleniyor |
| **Kademeli Re-ID** | `app.js` → `startReid()`; `server.py` → `run_reid_batches()` | Batch, eşik, "devam et", kullanıcı kararı |
| **Kompakt metadata** | `server.py` → `/detections`; `overlay.js` → `setDetections()` | Satır dizisi + kare indeksine gruplama |
| **Durum makinesi UI'ı** | `app.js` → `treePanel()`, `statusRow()` | `video_status` ve `event_status` enum'larının görsel karşılığı |

### Kavramsal — kod okumakla anlaşılmaz, açıklama gerekir

Bunlar için bu dokümanın ilgili bölümlerini oku:

| Konu | Bölüm |
|---|---|
| Detection / Track / Global Identity farkı, bbox nasıl "hareket ediyor" | [6b](#6b-detection--track--global-identity-bbox-nasıl-hareket-ediyor) |
| VLM'e neden her kare gönderilmiyor, aday seçimi nasıl çalışıyor | [4](#4-이벤트-후보-구간-선정--motorun-kalbi) |
| PAR ile olay araması ile Re-ID'nin farkı | [7](#7-sistemdeki-arama-yolları) |
| Neden 100 kamerada canlı arama yapılamaz | [3](#3-kritik-arama-kapsamı-ve-ölçek-gerçeği) |
| Overlay mı burn-in mi | [10](#10-bbox-nerede-çizilecek) |
| RTSP / WebRTC / WebSocket / HTTP karmaşası | [9](#9-video-taşıma-rtsp--webrtc--websocket--http) |

### Somut alıştırmalar

Mockup çalışırken bunları dene — her biri bir kavramı yerine oturtur:

1. `overlay.js` içinde `this.opts.trails` varsayılanını `false` yap, izlerin
   kaybolmasıyla "bu adam nereden geldi" sorusunun ne kadar zorlaştığını gör.
2. `server.py` içinde `/detections` uç noktasının `from`/`to` filtresini
   kaldır, CAM05 (24 saat) açıp tarayıcının ne yaptığını izle.
3. `gen_video.py` içinde `-movflags +faststart` bayrağını sil, videoyu yeniden
   üret, seek etmeyi dene.
4. `-g` (GOP) değerini `str(fps)` yerine `str(fps*10)` yap, olay listesinden
   tıklayınca kaç saniye kaydığını ölç.
5. `timeline.js` içindeki `_wheel()` fonksiyonunda `t` (imleç altındaki zaman)
   yerine sabit `this.t0` kullan — zoom'un neden "yanlış" hissettirdiğini gör.
6. `core.js` içindeki `TimeMapper.wallClock()`'ı `hms()` ile değiştir — saat
   `08:31:12` yerine `00:01:12` olur; kullanıcı için ne kaybettiğini düşün.

---

## 18. Yol haritası

Şirketin **개발 계획** dokümanıyla hizalı. Oradaki dört aşama:

```
1. frontend + 요약 엔진 (단일 영상 요약)   ← ikisi PARALEL, ayrı ayrı
2. backend api 서버 + 연동
3. 다중 영상 요약 엔진 + 연동
4. QA 및 테스트
```

Kritik nokta: **1. aşamada frontend ve motor ayrı ayrı geliştiriliyor.**
Bu mockup tam olarak bunun için var — backend hazır olmadan frontend'i
gerçek HTTP üzerinde geliştirebilmek. Mock sunucu, 2. aşamada gerçek FastAPI
ile değiştirilecek; frontend'de değişecek tek şey `core.js` içindeki
`BASE = '/api'`.

**Re-ID ilk fazda yok** (backend geliştiricisinin teyidi). Mockup'ta çalışır
hâlde ama yol haritasında Faz 4'e alındı.

### Faz 0 — Sözleşme (1 hafta, birlikte)

- [ ] Bölüm 19'daki 🔴 sorular cevaplansın
- [ ] Bölüm 13.4'teki şema soruları (A–G) netleşsin
- [ ] Ekran → endpoint tablosu (Bölüm 14) birlikte gözden geçirilsin
- [ ] BBox formatı dondurulsun: **`xywh` mi `xyxy` mi, piksel mi normalize mi**
- [ ] Video kodek / faststart / Range / GOP kararı
- [ ] Backend sabit veri dönen boş endpoint'leri yazsın

**Çıktı:** Çalışan `/docs`, sabit veri dönüyor.
**Mockup karşılığı:** `#/api` ekranı + `python server.py` zaten bu sözleşmenin
çalışan hâli — toplantıya bunu götür.

### Faz 1 — Tek video özeti (개발 계획 1. adım)

- [ ] Layout: ağaç / filtre / üst şerit / oynatıcı / olay listesi
- [ ] Tasarım sistemi (renkler, durum renkleri, tipografi)
- [ ] Video oynatıcı + özel kontroller
- [ ] `TimeMapper`
- [ ] BBox overlay canvas'ı
- [ ] Olay listesi + tıklayınca seek + `event_status` (확정/오탐)
- [ ] Yatay timeline
- [ ] Nesne filtresi paneli (PAR)

**Mockup'ta:** tamamı hazır, `#/single/CAM01`.

### Faz 2 — Backend entegrasyonu (개발 계획 2. adım)

- [ ] Login
- [ ] Grup/video ağacı, `video_status` ikonları
- [ ] Video yükleme + ilerleme
- [ ] `analysis_job` başlatma + `analysis_run` ilerlemesi (polling)
- [ ] Gerçek metadata ile bbox, gerçek olaylar

### Faz 3 — Olay araması + çoklu kamera (개발 계획 3. adım)

- [ ] 이벤트 검색 kutusu (VLM açıklamalarında metin filtresi)
- [ ] Swimlane / dikey timeline (Bkz. Bölüm 12b)
- [ ] `event_group_id` ile "tek sahne" gruplaması + `연관 이벤트` sekmesi
- [ ] Sağ panelde olay oynatıcısı
- [ ] `지도 보기` — `camera.latitude/longitude` ile harita görünümü

### Faz 4 — Re-ID (~1 ay sonra)

> Backend geliştiricisi: Re-ID bu aşamada yok, yaklaşık bir ay sonra
> yazılacak. Sorgu **fotoğraftan** yapılacak. Mockup'ta çalışır hâlde ama
> `FEATURES.reid = false` ile gizli.

- [ ] Sanallaştırılmış crop grid'i
- [ ] Fotoğraftan sorgu → aday listesi → `identity_match_status`
- [ ] `global_identity` (takip listesi) yönetimi
- [ ] Timeline'da takip vurgulaması, kameralar arası bağlantı

### Faz 5 — Export, ayarlar, sistem (개발 계획 4. adım öncesi)

- [ ] Video / Excel / Word dışa aktarma (**yalnızca `confirmed` olaylar**)
- [ ] Ayar ekranları
- [ ] GPU durumu, log görüntüleyici
- [ ] Rapor otomatik üretimi (fonksiyon 26)

---

## 19. Backend'e sorulacak sorular — gerekçeleriyle

> ✅ işaretli maddeler cevaplandı — kayıt için duruyorlar, silinmedi.
> Şema ile cevaplananların tam listesi
> [Bölüm 13.2](#132-şema-hangi-sorularımı-cevapladı)'de.

### ✅ (kapandı) CLIP / görsel arama

**Cevap:** CLIP kullanılmayacak. Boru hattı Plan 1: kural tabanlı aday seçimi
(`event_candidate_score`) → VLM 서술. Arama, VLM'in yazdığı açıklamalarda
metin araması olarak yapılıyor.

**Sonucu:** "Sonradan sınırsız prompt araması" senaryosu kapsam dışı. UI'daki
arama kutusu bir **filtre**, bir keşif aracı değil. Bu farkı kullanıcıya
hissettirmek gerekiyor — bulunamayan bir şey "yok" demek değil, "VLM ondan
bahsetmedi" demek.

### ✅ (kapandı) Prompt ne zaman giriliyor

**Cevap:** `analysis_job.prompt` — iş başlatılırken. Görsel arama olmadığı
için sonradan yeniden arama zaten motoru çalıştırmaz; sonradan yapılan şey
mevcut olay metinlerinde filtrelemedir.

### ✅ (kapandı) BBox birimi ve formatı

**Cevap — şemadan, kesin:**

```
bbox_x      numeric(10,7)  [not null, note: '0~1 정규화 좌표']
bbox_y      numeric(10,7)  [not null, note: '0~1 정규화 좌표']
bbox_width  numeric(10,7)  [not null, note: '0~1 정규화 크기']
bbox_height numeric(10,7)  [not null, note: '0~1 정규화 크기']
```

**Normalize (0~1), `xywh` formatında.** Mockup'ın tamamı buna göre
güncellendi: kablo formatı `xywh`, frontend içeride tek bir yerde
(`overlay.js → setDetections`) `xyxy`'ye çeviriyor.

### 🔴 4. Detection her karede mi var, örneklenmiş mi?

**Neden soruyorum:** Şemada her `detection` bir `frame_id`'ye bağlı. Eğer
detection 30 fps'te değil de 5 fps'te örnekleniyorsa, aradaki karelerde
kutu ya donar ya titrer → **enterpolasyon** yazmam gerekir.

Buna bağlı ikinci soru: `frame_index` tablosuna **her kare** mi yazılıyor?
24 saat × 30 fps = 2.6 milyon satır/kamera. Yoksa yalnızca keyframe +
detection olan kareler mi?

### 🔴 5. Metadata nasıl sayfalanıyor? Zaman aralığı sorgusu indeksli mi?

**Neden soruyorum:** `GET /videos/{id}/detections?from=&to=` şeklinde
isteyeceğim. Bu `detection → frame_index → timestamp_ms` JOIN'i demek.
24 saatlik videoda bu sorgu yavaşsa oynatma takılır.

Öneri: `frame_index(video_asset_id, timestamp_ms)` üzerinde indeks +
`detection(frame_id)` üzerinde indeks.

### ✅ (kısmen kapandı) Video kodek — H.264 çıktı

**Cevap:** VMS kayıtlarının **H.264 olma ihtimali yüksek**. Bu en iyi senaryo.
Ayrıntılı karşılaştırma [Bölüm 9.5](#95-h264-mi-mjpeg-mi--kaynak-kodek-kararı)'te.

Özet: H.264 kaynak → çoğu durumda **yeniden kodlamaya gerek yok**, sadece
MP4'e remux (`-c copy -movflags +faststart`). 30 dakikalık video için
90 saniye yerine 2 saniye, kalite kaybı sıfır.

**Hâlâ sorulacaklar:**
- `pix_fmt` **yuv420p** mi? (yuv422p/444p veya 10-bit → Chrome oynatmaz,
  yeniden kodlama şart)
- **GOP** kaç saniye? Remux'ta GOP değiştirilemez; büyükse seek doğruluğu
  ±GOP saniye olur. Olay listesinden tıklayınca yanlış ana gitmek kötü görünür.
- Bazı kameralar **MJPEG** olabilir mi? (eski/düşük bant genişliği modelleri)
  MJPEG tarayıcıda `<video>` ile oynamaz — zorunlu yeniden kodlama.
- `-movflags +faststart` uygulanacak mı, HTTP **Range** destekleniyor mu?

### 🟡 7. Aynı anda kaç video analiz edilebilir? Kuyruk davranışı ne?

**Neden soruyorum:** `analysis_job` birden çok `analysis_run` içerebiliyor.
Kullanıcı 20 kamera seçerse hepsi kuyruğa mı girer? UI'da "sıranız 7."
göstermem gerekir mi? Kapsam seçim ekranında süre uyarısı vermem lazım.

### 🟡 8. `vlm_event.related_track_ids` hangi ID'yi içeriyor?

**Neden soruyorum:** `track.id` (iç bigint) mi, `track.local_track_no`
(tracker'ın verdiği) mi? Overlay `local_track_no` ile eşleştiriyor; iç ID
gelirse "olaya tıklayınca ilgili kişiyi vurgula" özelliği çalışmaz.

Aynı soru `related_identity_ids` için de geçerli.

### 🟡 9. `event_candidate_score.details` içinde ne var?

**Neden soruyorum:** UI'da **"bu olay neden seçildi"** gösterebilirsem
operatörün sisteme güveni artar ve hata ayıklama kolaylaşır. Örneğin:
"객체 밀집도 0.82 (임계값 0.6), 급격한 방향 전환 0.71". `metric_code` ve
`threshold` zaten var; `details` içeriği standart mı yoksa modele göre
değişken mi?

### 🟡 10. Nesne crop görüntüleri nasıl servis ediliyor?

**Neden soruyorum:** `reid_embedding.representative_frame_id` var — yani
temsilci kare biliniyor. Ama **kırpılmış görüntü dosyası** nerede? Anlık mı
üretiliyor (kareyi çöz + kes), yoksa önceden mi kaydediliyor?

Nesne listesinde binlerce küçük görsel olacak. Her biri ayrı HTTP isteği
olursa tarayıcı boğulur. Ayrıca iki boyut gerekebilir: grid için 128px,
Re-ID onay ekranı için daha büyük.

### 🟡 11. Kimlik doğrulama: JWT mi, cookie mi? Rol var mı?

**Neden soruyorum:** Şemada kullanıcı tablosu **yok** — kimlik doğrulama
düşünülmüş mü? UI akış şemasında login ekranı var.

Özel sorun: `<video src="...">` custom header gönderemez. Video URL'lerine
kimlik nasıl geçecek — imzalı URL mi, cookie mi? Bu madde çoğu projede geç
fark edilir.

`vlm_event` ve `track_identity_match` içinde "kim onayladı" bilgisi gerekiyor
(`matched_by` var ama serbest metin). Denetim izi isteniyorsa kullanıcı
tablosu şart.

### 🟢 12. Frontend nasıl dağıtılacak — FastAPI mı servis edecek?

Tek Docker konteyneri çok daha iyi: CORS yok, kurulum basit. Build çıktısını
nereye koyacağım?

### 🟢 13. `analyzing` durumunda ilerleme yüzdesi hangi tabloda?

`analysis_run`'da progress alanı görmedim. Ağaçta her video için yüzde
göstereceksem `GET /groups` bunu dönmeli; ayrı sorgu gerekirse ağacı sık
yenilemek pahalılaşır.

### 🟢 14. `video_status = deleted` kayıtları API'de dönüyor mu?

Mantıksal silme var. Backend zaten filtreliyorsa iyi; filtrelemiyorsa her
listede ben elemem gerekir ve unutulursa silinmiş videolar görünür.

### 🟢 15. RTSP kaynaklı videolarda davranış farkı ne?

RTSP sürekli büyüyen bir kayıt. `video_asset.end_at` ne olur — NULL mı?
"Zaman aralığı seç" davranışı dosyadan farklı. Silme akışı yayını da durdurur mu?

### 🟢 16. Yeniden özetleme (`재요약`) sırasında eski sonuca ne olur?

Aynı video için ikinci bir `analysis_run` açılıyor. Eski `vlm_event` kayıtları
siliniyor mu, yoksa `analysis_run_id` ile ayrılıp ikisi de mi duruyor?

Sürüm geçmişi tutuluyorsa UI'da "önceki sonuca dön" yapabilirim. Tutulmuyorsa
yeniden özetleme yıkıcı bir işlem — kullanıcıyı uyarmam gerekir.

Ayrıca: operatörün `confirmed` işaretlediği olaylar yeniden analizde kaybolur
mu? Kaybolursa insan emeği çöpe gider.

### 🟢 17. Çıktı dili ayarlanabiliyor mu?

VLM açıklamaları Korece. `vlm_event.description` tek dil mi tutuyor? UI çoklu
dil destekleyecekse çeviri nerede yapılacak?

### 🟢 18. `event_type` tablosu çalışma zamanında değişebilir mi?

Enum değil, tablo. Yani yeni olay tipi eklenebilir. UI tipleri `GET /event-types`
ile çekmeli, sabit kodlamamalı. Renk/ikon eşlemesi nerede tutulacak — DB'de mi,
frontend'de mi?

### 🟢 19. `camera_group_member.display_order` kullanıcı tarafından değiştirilebilir mi?

Sürükle-bırak ile sıralama özelliği gerekiyor mu?

### 🟢 20. `video_asset.checksum_sha256` — aynı dosya iki kez yüklenirse?

UI uyarı mı göstermeli, sessizce mevcut kaydı mı açmalı?

### 🟢 21. Export yalnızca `confirmed` olayları mı alacak?

`event_status` eklendiğine göre rapor bunu dikkate almalı. Varsayılan davranış
ne — hepsi mi, sadece onaylananlar mı, kullanıcı seçimli mi?

### 🟢 22. `frame_index` gerçekten her kare için mi yazılıyor?

24 saat × 30 fps × 100 kamera = **260 milyon satır**. Bu tablo veritabanının
en büyük parçası olacak. Partition planı var mı? Yoksa yalnızca keyframe +
detection olan kareler mi yazılacak?


## 20. Dokümanlar arası çelişkiler

Bunlar ekip içinde netleştirilmeli — hangisi geçerli?

| # | Çelişki | Doküman A | Doküman B | Etkisi |
|---|---|---|---|---|
| 1 | **Prompt ne zaman girilir** | Plan 1: analizden önce (`분석 프롬프트 입력` → `분석 시작`) | Plan 2: analizden sonra, sınırsız kez | Farklı ekran tasarımı |
| 2 | **OS desteği** | Plan 1: Cross-Platform (Windows + Linux) | Plan 2: sadece Linux | Dağıtım, WinPython gerekli mi |
| 3 | **Dağıtım** | Plan 1: Docker + WinPython | Plan 2: sadece Docker | Kurulum karmaşıklığı |
| 4 | **Aday aralık seçimi** | Plan 1: kural tabanlı algoritma | Plan 2: CLIP benzerliği | **ÇÖZÜLDÜ → Plan 1** |
| 5 | **Object Detection'ın rolü** | Plan 1: ana motor | Plan 2: bahsedilmiyor ama ayar ekranında hâlâ var (madde 18: "Object Detection, Tracking, Re-ID, VLM 모델 선택") | Detection çalışıyor mu? Plan 3'e göre evet |
| 6 | **Nesne arama** | Plan 1: madde 7 `객체 검색` (PAR tabanlı) | Plan 2: madde 7 `프롬프트 검색` (birleştirilmiş) | İki ayrı arama yolu mu, tek mi? Bkz. Bölüm 7 |
| 7 | **Re-ID'nin yeri** | Plan 1: madde 10 `객체 이동 추적` | Plan 2: listeden çıkarılmış | Plan 3 geri getiriyor — hangi fazda? |

### Şema ve 개발 계획 ile çözülenler

| # | Durum | Nasıl çözüldü |
|---|---|---|
| 1 | **Çözüldü** | Prompt `analysis_job.prompt`'ta, iş başlarken veriliyor. Görsel arama olmadığı için "sonradan sınırsız arama" zaten mümkün değil; sonradan yapılan şey VLM metninde filtreleme. |
| 4 | **Çözüldü — Plan 1** | Backend teyit etti: CLIP yok. Şemadaki `event_candidate_score` + `vlm_event` ikilisi boru hattının tamamı. |
| 5 | **Detection çalışıyor** | `detection`, `track`, `object_class` tabloları var. Plan 2 bahsetmese de motor bunları üretiyor. |
| 6 | **İki ayrı yol** | `detection`+PAR (öznitelik) ile `vlm_event` (olay) ayrı tablolar → Bölüm 7'deki üç yol ayrımı doğrulandı. |
| 7 | **İlk fazda yok** | 개발 계획: 1) tek video özeti, 2) backend API, 3) çoklu video, 4) QA. Re-ID bu dört adımda geçmiyor; backend geliştiricisi de teyit etti. Şema hazır (`global_identity`, `reid_embedding`, `track_identity_match`) ama uygulama sonraya. **Yol haritasında Faz 4.** |

### Hâlâ açık

| # | Neden önemli |
|---|---|
| 2 | Windows desteği gerekiyorsa WinPython paketleme işi var; sadece Linux+Docker ise çok daha basit. Frontend'i etkilemez ama kurulum dokümanını etkiler. |
| 3 | Aynı konu — dağıtım hedefi netleşmeli. |

**Öneri:** Bu tablonun üstünden birlikte geçilip "geçerli olan sürüm" tek bir
dokümanda dondurulmalı. Aksi halde her ekran tasarımında bu tartışma tekrar
açılır.

---

## Ek A — Hızlı karar özeti

| Konu | Karar |
|---|---|
| API dokümantasyonu | FastAPI `/docs` (Swagger UI) — otomatik, ekstra iş yok |
| API sözleşmesi | Ekran→endpoint tablosu + erken sabit-veri endpoint'leri |
| Kendi BFF sunucum | **Hayır** — ihtiyaçları backend'e söyle |
| Video taşıma | **HTTP Range + H.264 MP4 + faststart** |
| Uzun video | HLS'e geçilebilir (Faz 2+) |
| Kaynak kodek | **H.264 bekleniyor** → çoğu durumda remux yeter, yeniden kodlama gerekmez |
| MJPEG gelirse | Zorunlu yeniden kodlama — tarayıcı `<video>` ile MJPEG oynatmaz |
| Görsel arama (CLIP) | **Yok.** Arama = VLM açıklamalarında metin filtresi |
| Aday seçimi | Kural tabanlı, 7 metrik, göreli eşik (`event_candidate_score`) |
| Canlı yayın | **Kapsam dışı** — WebRTC yok |
| İlerleme bildirimi | **SSE.** Alarm/bildirim tarafını backend WebSocket ile yapacak — `core.js → listen()` tek değişim noktası |
| BBox | **Ekranda canvas overlay, export'ta backend burn-in** |
| BBox koordinatı | **Normalize (0–1)** iste — şema `xywh` numeric, birim belirsiz (Soru 3) |
| Olay onayı | `event_status`: candidate → confirmed / dismissed; export sadece confirmed |
| Re-ID kararı | `identity_match_status`: candidate → confirmed / rejected |
| Enum yazımı | Şemayla birebir — `canceled` tek L |
| Kimlik alanı | API'de `id` değil **`public_id` (UUID)** |
| İş modeli | `analysis_job` (çok video) → `analysis_run` (video başına) |
| Re-ID fazı | **Faz 4, ~1 ay sonra.** Fotoğraftan sorgu. Kodda var, `FEATURES.reid` ile gizli |
| Şimdiki odak | **Video + timeline + özet** |
| Frame senkronu | `requestVideoFrameCallback` |
| UI yığını | Tailwind + Alpine + vanilla JS modülleri (canvas işleri) |
| Timeline | Canvas'ta kendimiz yazacağız |
| Zaman yönetimi | Tek `TimeMapper` modülü |

## Ek B — İlk hafta yapılacaklar

1. [ ] `python server.py` çalıştır, mockup'ı backend geliştiricisiyle
       **birlikte aç** — tartışmak yerine göstermek çok daha hızlı
2. [ ] Bölüm 19'daki kalan 🔴 soruları cevapla
3. [ ] Bölüm 13.4'teki şema soruları A–G'yi geç
4. [ ] Bölüm 20'de hâlâ açık olan 2 ve 3'ü (OS / dağıtım) netleştir
5. [ ] `#/api` ekranındaki endpoint listesini birlikte gözden geçir ve dondur
6. [ ] Backend sabit-veri dönen boş endpoint'leri yazsın → mock sunucu emekli olur
7. [ ] Ekran görüntüsü #2'yi (çoklu kamera) tekrar al — ilk gönderim bozuktu
8. [ ] `video_analytics_schema_v2.dbml` dosyasının kendisini al (şu ana kadar
       yalnızca tablo açıklamaları elimizde; indeksler ve FK'ler görülmedi)

---

## Ek C — Tek cümlelik özetler

Toplantıda hızlı hatırlaman gerekirse:

- **BBox hareket etmiyor**, her karede yeniden çiziliyor; hareketi üreten
  tracker'ın kare kare eşlemesi.
- **`track_id` tek kamera içinde geçerli**; kameralar arasını `global_identity`
  bağlıyor.
- **VLM pahalı, kurallar bedava**; aday seçiminin tek görevi VLM'e ne
  göndereceğine karar vermek.
- **PAR nitelik arar, olay araması VLM metnini arar** — ikisi farklı yol.
- **Aday skoru kara kutu değil**; hangi metriğin eşiği aştığı UI'da görünür.
- **100 kamerada canlı arama yok**; kullanıcı önce kapsam seçer, analiz bir kez
  koşar, arama sonsuz kez ucuza yapılır.
- **RTSP tarayıcıda oynamaz**; video HTTP Range ile, bildirim SSE/WebSocket ile.
- **Ekranda overlay, export'ta burn-in.**
- **AI önerir, insan onaylar** — `event_status` bunun veritabanına yazılmış hâli.
- **H.264 kaynak = remux yeter**; MJPEG gelirse yeniden kodlama zorunlu.
- **Şimdiki odak: video + timeline + özet.** Re-ID ~1 ay sonra, CLIP hiç yok.
8. [ ] Frontend iskeleti + tasarım sistemi kurulsun
