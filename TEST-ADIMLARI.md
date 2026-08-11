# Test adımları

İki ayrı şey var, sırayla gidilmeli:

| | Ne | Ne zaman |
|---|---|---|
| **Lab** (`/lab/`) | Mekanizmaları tek tek öğrenmek. Beyaz sayfa, 12 ders. | **Önce bu.** ~1.5 saat |
| **Mock** (`/`) | Bütün ürünün çalışan hâli. Ekranlar, akışlar, API. | Lab'dan sonra |

**Sıra neden önemli:** Mock'ta bir şey ters giderse, Lab'ı görmemişsen
"nerede baktım?" diye kaybolursun. Lab'daki 12 mekanizma Mock'un tamamını
oluşturuyor — önce parçaları tanı, sonra bütünü.

---

## Başlatma

```bat
start.bat
```

Ya da elle:
```bash
python server.py
```
→ <http://127.0.0.1:8000/>

**Video bulmana gerek yok.** 4 adet sentetik CCTV videosu (`cam01–cam04.mp4`,
her biri 3 dakika) zaten üretildi ve bbox metadata'sıyla **birebir hizalı**.
Kendi videonu eklemek isteğe bağlı (en altta).

Sağlık kontrolü:
```bash
python tools/smoke_test.py     # 132 kontrol, hepsi ✓ olmalı
```

---

# BÖLÜM 1 — Lab (~1.5 saat)

<http://127.0.0.1:8000/lab/>

Her ders: **canlı demo → kendi kaynak kodu → "Dene" kutusu**. Dene
kutusundakiler kasıtlı olarak bir şeyi *bozmanı* ister; bir şeyin ne işe
yaradığını en hızlı böyle anlarsın.

| Ders | Süre | Sonunda şunu bileceksin |
|---|---|---|
| **01** Video temeli | 5 dk | Kontrolleri neden kendimiz yazıyoruz; hangi kodek tarayıcıda çalışır |
| **02** Range / seek / faststart | 10 dk | Tarayıcı videoyu nasıl parça parça indirir; faststart olmazsa ne olur |
| **03** Letterbox ⭐ | 15 dk | **En kritik ders.** Kutuların neden kaydığı |
| **04** Normalize xywh ⭐ | 15 dk | DB'den gelen 0~1 değerini piksele çevirmek |
| **05** Kare senkronu | 10 dk | `timeupdate` neden yetmez |
| **06** Metadata | 10 dk | Binlerce satırı nasıl indeksleriz |
| **07** track_id | 10 dk | Renk, iz, filtreleme |
| **08** Tıklama | 8 dk | İç içe kutularda doğru olanı seçmek |
| **09** devicePixelRatio | 5 dk | Retina bulanıklığı |
| **10** Zaman dönüşümü ⭐ | 12 dk | Üç zaman ekseni ve `TimeMapper` |
| **11** API + arama + SSE | 12 dk | Olay araması, aday skorları, 8 dakikalık işi nasıl beklersin |
| **12** Hepsi bir arada | 15 dk | ~150 satırda çalışan mini oynatıcı |

⭐ = atlamamalısın.

### Lab için kritik testler

**Ders 03 — kutular neden kayar (mutlaka yap)**
1. "Letterbox düzeltmesi" kutucuğunun **işaretini kaldır**
2. "Kutu yüksekliği" kaydıracını sağa çek
3. Kırmızı işaretlerin videonun köşelerinden kaydığını gör
4. Düzeltmeyi geri aç → tekrar oturuyor

> Gerçek projede bu, kutuların insanların yanında durması demek ve nedenini
> bulmak saatler alır.

**Ders 04 — normalize koordinatın anlamı**
1. "Gerçek veriden oku (track #1)" kutucuğunu işaretle
2. Kutu videodaki adamı takip etmeye başlar
3. "Görüntü boyutu"nu 480 → 880 arasında değiştir
4. Kutu hâlâ adamın üstünde → **normalize koordinatın tüm amacı bu**

**Ders 05 — sayıları oku**
1. Sayfayı aç, 3-4 saniye bekle
2. Tablo dolmalı: `timeupdate ≈ 4 Hz`, `rAF ≈ 60 Hz`, `rVFC ≈ 10 Hz`
3. "Sapma" sütununa bak — `timeupdate` çeyrek saniye geride

**Ders 08 — iç içe kutu tuzağı**
1. Video 130. saniyeden başlar (araç + kişi birlikte)
2. Radyo düğmesini "İlk eşleşen kazanır" yap
3. Aracın kişiyle üst üste geldiği yere tıkla → **yanlış nesne seçilir**
4. "En küçük alan kazanır"a al → doğru seçim

**Ders 11 — uzun iş**
1. "Analiz başlat" → ilerleme çubuğu dolmaya başlar
2. Hemen "İptal"e bas → durur
3. Tekrar başlat, bu sefer **sekmeyi yenile**
4. `/api/jobs`'a bak → iş arkada devam ediyor (doğru davranış: tarayıcı
   kapanınca GPU işi iptal olmamalı)

---

# BÖLÜM 2 — Mock (~1 saat)

<http://127.0.0.1:8000/>

Giriş: herhangi bir kullanıcı adı/parola.

## Senaryo (bilmen gereken hikâye)

**Area1 · 2025-05-20 08:30:00 – 08:33:00**, dört kamera, tek hikâye:

```
Camera1 (정문)     P1 girer → telefonla konuşur → sağa gider
Camera2 (주차장)   siyah sedan girer → P1 buraya geçer → araca biner → çıkar
Camera3 (후문)     gri montlu adam sürekli gidip gelir (배회)
Camera4 (로비)     kalabalık + 150. sn'de yaşlı biri yere düşer
```

**P1** = beyaz gömlekli, sırt çantalı adam. Camera1'de `track_id=1`,
Camera2'de `track_id=12`. Aynı insan, farklı track — `track_id` yalnızca tek
kamera içinde geçerlidir. Kameralar arasını Re-ID bağlar (şu an gizli).

## Test 1 — Tek video özeti (15 dk)

`#/single/CAM01`

| Adım | Beklenen |
|---|---|
| Videoyu oynat | Kutular kişileri takip eder, izler arkalarında çizilir |
| Bir kutuya tıkla | Nesne detay penceresi açılır (PAR öznitelikleri) |
| Sağdaki olay listesinden bir satıra tıkla | Video o ana atlar |
| Bir olayın üstüne gel (hover) | Sadece o olaya ait kişi(ler) vurgulanır |
| `b` tuşuna bas | BBox'lar kapanır/açılır |
| `n` / `p` | Sonraki/önceki olaya atla |
| Pencereyi yeniden boyutlandır | **Kutular kaymamalı** ← Lab 03 |
| Tam ekran (⛶) | Yine kaymamalı |
| Timeline'da tekerlek | Zoom. Shift+sürükle = kaydır. Çift tık = sıfırla |
| Sol alt filtre: 성별 = 남성, 의상 색상 = beyaz → 필터 적용 | Sadece P1 kalır, olay listesi daralır |
| Olay satırında **확정** butonu | Olay `confirmed` olur |
| **오탐** butonu | Olay soluklaşır ama silinmez |
| 📷 snapshot | PNG iner (bbox gömülü) |
| `영상 정보` | Kodek, faststart, GOP bilgileri |
| `재요약` | İlerleme bildirimi sağ altta akar, iptal edilebilir |

**이벤트 검색** (VLM açıklamalarında metin filtresi):
1. Sağ üstteki kutuya `탑승` yaz, Enter → sonuç **anında** gelir (~3 ms)
2. Üstte: kaç olay tarandı, kaç eşleşme, hangi terimlere genişletildi
3. Timeline sadece eşleşen olayları gösterir

Dene: `쓰러` (→ Camera4), `배회` (→ Camera3), Türkçe `yere düşen kişi`,
`araca binen adam`, `kırmızı`. Sonra anlamsız bir şey: `zzzqq` → 0 sonuç.

> Bu arama **VLM'in yazdığı metinde** çalışır. Bulamadığı bir şey sistemde
> yok demek değil — VLM ondan bahsetmemiş demek. Görsel arama (CLIP) yok.

**후보 구간 점수** (bu ekranın en öğretici parçası):
1. Timeline çubuğundaki `◍ 후보 점수` butonuna bas
2. Pencere pencere tablo: hangi metrik kaç puan, eşiği aştı mı
3. Camera4'te 148–150 sn aralığına bak → `posture` metriği eşiği aşmış
   (biri düştü, en/boy oranı değişti)
4. Timeline'ın üst şeridi bu skorların grafiği; kesik kırmızı çizgi eşik

> Bu, "motor neden burayı seçti" sorusunun cevabı. Operatörün sisteme
> güveni buradan gelir.

## Test 2 — Olay onaylama (5 dk)

Şemadaki `event_status` akışı — AI önerir, operatör onaylar.

1. Olay listesinde bir satırdaki **확정** butonuna bas → durum `confirmed`
2. Başka bir satırda **오탐** → soluklaşır ama **silinmez** (denetim izi)
3. **되돌리기** ile `candidate`'a dön
4. Bu, raporlamanın temeli: export yalnızca `confirmed` olayları almalı

> Re-ID varsayılan olarak **gizli** (backend'de ~1 ay sonra gelecek).
> Görmek istersen tarayıcı konsoluna:
> `localStorage.setItem('ff.reid','1'); location.reload()`
> Sonra `#/objects/CAM01` → beyaz gömlekli adama tıkla → Camera2'de
> **0.9751** ile eşleşir. `#/objects/CAM20` ise 165 gerçek SOLIDER vektörü.

## Test 3 — Çoklu kamera (10 dk)

`#/multi/G1`

- Kamera başına satır (swimlane), olaylar renkli bloklar
- Blok üstüne gel → doğal dil açıklaması tooltip
- Tıkla → sağda detay
- Takip listesi doluysa kameralar arası noktalı bağlantı çizgisi
- `⛓ INC-1` rozeti = aynı sahnenin parçası (P1'in hikâyesi 2 kamerayı kapsar)

## Test 4 — Kenar durumlar (10 dk)

Bunlar UI'ın "kötü günde" nasıl davrandığını gösterir:

| Nereye | Ne görmelisin |
|---|---|
| Sol ağaçta **Camera9** (kırmızı) | Tıklayınca CUDA OOM hata mesajı |
| **Camera10** (sarı, yanıp sönen) | %43 ilerleme çubuğu |
| **Camera11** (RTSP, gri) | "분석 가능하지 않음" uyarısı |
| `#/single/CAM05` | 24 saatlik video, **proxy yok** → oynatıcı yerine tanı ekranı (kodek/faststart/GOP), ama timeline ve 39 olay çalışır |
| Timeline'ı 24 saate zoom-out | 1439 pencere akıcı çiziliyor mu |

## Test 5 — Sistem ekranları (10 dk)

| Rota | Ne test edilir |
|---|---|
| `#/jobs` | İki katman: `analysis_job` (▣) → içindeki `analysis_run`'lar (└). Çalışan işi durdur, hatalıda "오류" butonu |
| `#/system` | GPU göstergeleri 2 sn'de bir güncelleniyor mu; log seviye filtresi |
| `#/settings` | `후보 구간 임계값`'ı 0.6 yap → Kaydet. (Gerçek sistemde bu, VLM'e gönderilen pencere sayısını ve maliyeti belirler.) |
| `#/api` | **36 endpoint listesi** — bunu backend'ci arkadaşına göster |

Sağ üstteki **KO / TR** düğmesi arayüz dilini değiştirir.

---

## Kendi videonu eklemek (isteğe bağlı)

```bash
python tools/add_video.py "D:\kayit.mp4" --motion --name Camera99
```

- `ffprobe` ile gerçek metadata okur (kaynak HEVC ise uyarır)
- `ffmpeg` ile H.264 + faststart + 1 sn GOP proxy üretir
- `--motion` ile **hizalı** bbox üretir (kare farkı tabanlı, gerçek detector
  değil ama hareket eden bölgeleri izler)
- Sunucuyu yeniden başlat → sol ağaçta `Area9 › Camera99`

Silmek: `python tools/add_video.py --remove CAM99`

Betik **önce remux dener**: kaynak H.264 + yuv420p ise yeniden kodlama
yapmaz, sadece MP4'e sarıp `faststart` ekler (~2 saniye). Koşullar
sağlanmazsa `libx264` ile yeniden kodlar. Hangisini yaptığını ve ölçtüğü
GOP'u ekrana yazar.

**Ne test edilebilir:** Kendi videonda oynatma, seek, timeline, hareket
kutuları, snapshot, remux/encode kararı. Test **edilemeyecek** olan: gerçek
PAR öznitelikleri, VLM açıklamaları, aday skorları (gerçek model gerektirir).

---

## Bir sorun bulursan

1. `python tools/smoke_test.py` — 122 kontrolden hangisi düştü?
2. Tarayıcı konsolu (F12) — JS hatası var mı?
3. Sunucu terminali — traceback var mı?
4. Network sekmesi — hangi istek hata döndü?

Sunucuyu yeniden başlatmak gereken durumlar: katalog değişikliği
(`add_video.py`), `gen_mock.py` çalıştırma, `server.py` düzenleme.
Frontend değişikliklerinde sadece tarayıcıyı yenilemek yeter.
