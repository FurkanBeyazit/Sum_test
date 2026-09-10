/**
 * backend.js — gerçek DVSummary backend'i için adaptör
 * =================================================
 *
 * Arayüzün tek veri kaynağı. `core.js` içindeki `api` nesnesi budur; ekran
 * kodu backend'in alan adlarını hiç görmez, çeviri burada yapılır. Backend bir
 * alanın adını değiştirirse dokunulacak tek dosya bu.
 *
 * İstekler `/live/*` üzerinden gider — server.py bunları sunucu tarafında
 * gerçek API'ye iletir. Sebep CORS: tarayıcı 127.0.0.1:8000'den
 * 172.20.14.161:8001'e doğrudan istek atamaz.
 *
 * Karşılığı henüz olmayan tek şey: bbox
 * -------------------------------------
 * Uç var ama grup kapsamlı, duvar saatiyle sorgulanıyor ve msgpack dönüyor:
 *     GET /playback/groups/{gid}/bboxes?start_at=&end_at=&format=msgpack
 * Overlay ise video başına, saniye cinsinden, JSON bekliyor. `format=json`
 * doğrulanınca `detections()` tamamlanır ve `FEATURES.bbox` açılır.
 *
 * Object Page (#/objects) hangi uçlara dayanıyor
 * ----------------------------------------------
 *   objects()     → GET /analysis/result/{id}/tracks   (PAR filtresi sunucuda)
 *   attributes()  → GET /analysis/result/{id}/tracks/par/stats
 *   crop URL'i    → GET /analysis/result/{id}/track/{tid}/crop
 *
 * `t_first/t_last` tek aralık varsayıyor. Backend track'i parçalı veriyorsa
 * (kişi kadraja girip çıkıyorsa) `segments: [{t0,t1}]` göndersin — objects.js
 * içindeki `lanes()` tek olay dizisinden çoklu olaya çıkar, gerisi aynı kalır.
 *
 * Oynatma
 * -------
 * VMS kayıtları AVI + MPEG-4 Part 2 — tarayıcı ikisini de açamaz.
 * `tools/proxy_cache.py` yerel H.264 proxy üretir, index.json'dan okunur.
 * Backend `playback_uri` eklediğinde sadece `streamUrl()` değişecek.
 */

const LIVE = '/live';

/* ------------------------------------------------------------ istekler ---- */

async function req(path, opts = {}) {
  const r = await fetch(LIVE + path, {
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const txt = await r.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) {
    const msg = (data && (data.detail || data.error)) || r.statusText;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

/* ------------------------------------------------------------ önbellek ---- */

const cache = { proxy: null, videos: null, results: new Map(),
                streams: new Map(), par: new Map(),
                tracks: new Map(), bbox: new Map(),
                /* video_id → Map(track_id → class_id). Tek track ayrıntısı
                   sınıf döndürmüyor; liste ucu döndürüyor. Video başına bir
                   kez çekip burada tutuyoruz. */
                classes: new Map(),
                collections: null };

/* BBox penceresi (saniye) — tek istekte cekilebilecek en uzun aralik.
   Iki ayri tavan bunu dusuk tutmayi gerektiriyor:
     - BOYUT: 30 fps'te saniyede ~370 kutu / ~100 KB.
     - SUNUCU: 300 saniyelik pencere denendiginde cevap yaklasik ilk dakikada
       kesiliyor (~1900 kare). Yani genis pencere istemek sadece yavas degil,
       sessizce VERI KAYBETTIRIYOR — kalan sure bos gelir.
   Gercek pencereleme bboxfeed.js'te ve 20 saniye; burasi yalnizca ust sinir. */
const BBOX_WINDOW = 60;

/**
 * /settings/custom adresini kapsama gore kurar.
 *
 * Dort kapsam var ve yalnizca 'key' olani anahtari GOVDEDE tasiyor; digerleri
 * adreste id tasiyor. Bu farki tek yerde tutmak, cagiran koda yansimasin diye.
 */
function settingPath(scope, id) {
  if (scope === 'collection') return `/settings/custom/collections/${id}`;
  if (scope === 'group') return `/settings/custom/groups/${id}`;
  if (scope === 'video') return `/settings/custom/videos/${id}`;
  return `/settings/custom/${encodeURIComponent(id)}`;
}

/**
 * Anahtar kapsaminin YAZMA adresi okuma adresinden FARKLI.
 *
 *   GET/DELETE  /settings/custom/{setting_key}      -> anahtar ADRESTE
 *   PUT         /settings/custom                    -> anahtar GOVDEDE
 *
 * Kapsamli uclarda (collection/group/video) boyle bir ayrim yok, uc de ayni
 * adrese yaziyor. Bu farki gormezden gelmek PUT'u okuma adresine gonderiyor
 * ve o adreste PUT tanimli olmadigi icin istek sessizce reddediliyordu.
 */
function settingWritePath(scope, id) {
  return scope === 'key' ? '/settings/custom' : settingPath(scope, id);
}

/**
 * Ornekleme frekansini VERININ KENDISINDEN cikarir.
 *
 * overlay.js kutulari `Math.round(t * fps)` kovasina koyuyor ve oynatma
 * sirasinda ayni formulle ariyor. fps veriye uymazsa kovalar kaymaya baslar
 * ve kutular yanip soner. Bu yuzden ardisik ornek zamanlari arasindaki
 * ORTANCA farki alip tersini kullaniyoruz — kovalar verinin oz izgarasina
 * oturur.
 */
function sampleFps(times, fallback) {
  const ts = [...times].sort((a, b) => a - b);
  const d = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > 1e-4) d.push(dt);
  }
  if (!d.length) return fallback || 10;
  d.sort((a, b) => a - b);
  const med = d[Math.floor(d.length / 2)];
  return Math.min(60, Math.max(1, 1 / med));
}

/**
 * Bir videodaki track'lerin sınıf tablosu.
 *
 * `GET /analysis/result/{id}/track/{tid}` sınıf DÖNDÜRMÜYOR; yalnızca liste
 * ucu döndürüyor. Re-ID akışı ise sadece `{video_id, track_id}` veriyor, yani
 * "bu aday kişi mi araç mı" sorusunun cevabı hiçbir yerden gelmiyordu ve
 * bütün adaylar sınıfsız kalıyordu.
 *
 * Track başına ayrı istek yerine video başına TEK istek: liste zaten hepsini
 * veriyor ve sonuç önbellekte kalıyor.
 */
async function classIndex(videoId) {
  const key = String(videoId);
  if (cache.classes.has(key)) return cache.classes.get(key);
  const m = new Map();
  try {
    const q = new URLSearchParams({
      limit: '1000', offset: '0',
      par_min_score: '0', par_active_only: 'false',
    });
    const raw = await req(`/analysis/result/${videoId}/tracks?${q}`);
    for (const r of (Array.isArray(raw) ? raw : (raw.items || []))) {
      const cid = r.class_id ?? (Array.isArray(r.class_ids) ? r.class_ids[0]
        : undefined);
      if (cid != null) m.set(String(r.track_id), cid);
    }
  } catch { /* sınıf bilinmiyor kalır — eleme de yapılmaz */ }
  cache.classes.set(key, m);
  return m;
}

/** proxy_cache.py'nin ürettiği index — hangi videonun yerel proxy'si var */
async function proxyIndex() {
  if (cache.proxy) return cache.proxy;
  try {
    const r = await fetch('assets/proxy/index.json', { cache: 'no-cache' });
    cache.proxy = r.ok ? await r.json() : {};
  } catch { cache.proxy = {}; }
  return cache.proxy;
}

/* -------------------------------------------------------------- eşleme ---- */

/**
 * DVSummary durum değerlerini bizim `video_status` enum'una çevirir.
 * UI'ın omurgası bu enum — ağaç ikonu, tıklanabilirlik, hata mesajı
 * hepsi buradan türüyor.
 */
function mapStatus(v) {
  const s0 = (v.status || '').toUpperCase();
  // Rezerve edilmiş ama dosyası yüklenmemiş kayıt: analysis_status ne derse
  // desin ortada video yok. /video/{id}/stream 404 döner.
  if (s0 === 'RESERVED' || String(v.storage_uri || '').endsWith('.pending')) {
    return 'registered';
  }
  const a = (v.analysis_status || '').toLowerCase();
  if (a === 'succeeded' || a === 'completed') return 'completed';
  if (a === 'running') return 'analyzing';
  if (a === 'queued') return 'ready';
  if (a === 'failed') return 'failed';
  if (a === 'cancelled' || a === 'canceled') return 'ready';
  if (a === 'pending') return 'ready';
  const s = (v.status || '').toLowerCase();
  if (s === 'uploaded' || s === 'ready') return 'ready';
  if (s === 'reserved' || s === 'registered') return 'registered';
  return 'ready';
}

const secOf = (msVal) => (msVal == null ? 0 : msVal / 1000);

/* Chrome'un açabildiği kombinasyon: MP4/WebM kabı + H.264/VP9/AV1 video.
   VMS'ten gelen .avi + mpeg4 (Part 2) açılmaz — proxy o yüzden var. */
/* HEVC bilerek dışarıda: Chrome'da yalnızca donanım desteği varsa açılıyor,
   yoksa sessizce siyah ekran veriyor — proxy uyarısını göstermek daha dürüst. */
const PLAYABLE_CODEC = /^(h264|avc1|avc|vp9|vp09|av1|av01)$/i;
const PLAYABLE_EXT = /\.(mp4|m4v|webm|mov)$/i;

function isBrowserPlayable(v) {
  const codec = String(v.codec || '').trim();
  if (!codec || !PLAYABLE_CODEC.test(codec)) return false;
  // Kap bilgisi yalnızca dosya yolundan çıkıyor; yoksa codec'e güveniyoruz.
  const path = String(v.video_path || v.storage_uri || '');
  return path ? PLAYABLE_EXT.test(path) : true;
}

function isoPlus(startIso, sec) {
  if (!startIso) return null;
  const d = new Date(startIso);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + sec * 1000).toISOString();
}

/** DVSummary `VideoResponse` → bizim kamera/video nesnesi */
/**
 * Proxy index'i yalnızca video id'sine göre anahtarlı. Backend sıfırlanıp
 * id'ler yeniden kullanıldığında eski proxy YANLIŞ videoyu oynatıyordu:
 * kullanıcı yeni dosyalar yüklüyor, ekranda hep önceki üç kayıt çıkıyor ve
 * yüklediği şey yok sayılmış gibi görünüyordu. Kaynak imzası (guid) tutmuyorsa
 * proxy'yi yok sayıyoruz — yanlış görüntü göstermektense hiç göstermemek
 * yeğdir. `proxy_cache.py` aynı imzayı yazıyor.
 */
function validProxy(px, v) {
  if (!px) return null;
  if (px.src_sig && v.guid_id && String(px.src_sig) !== String(v.guid_id)) {
    return null;
  }
  return px;
}

async function toCamera(v) {
  const rawPx = (await proxyIndex())[String(v.id)];
  const px = validProxy(rawPx, v);
  cache.streams.set(String(v.id), px ? px.url : null);
  const dur = v.duration_ms ? secOf(v.duration_ms) : (px?.duration || 0);
  return {
    id: String(v.id),
    name: v.name || `video ${v.id}`,
    place_ko: v.description || '',
    node_id: v.id,
    ch: 0,
    status: mapStatus(v),
    source_type: 'uploaded',
    has_proxy: !!px,
    // proxy dosyası var ama başka bir videoya ait — kullanıcıya söyle
    proxy_stale: !!rawPx && !px,
    /* Oynatılabilirlik proxy'ye BAĞLI DEĞİL: yüklenen dosya zaten H.264/MP4
       ise tarayıcı backend stream'ini doğrudan açar. Proxy sadece VMS'ten
       gelen AVI + MPEG-4 Part 2 kayıtları için gerekiyor. Eskiden bu ayrım
       yoktu ve MP4 videolarda bile "프록시 없음" ekranı çıkıyordu. */
    playable: !!px || isBrowserPlayable(v),
    /* SADECE start_at. Daha önce created_at'e düşüyordu — o kaydın veritabanına
       yazıldığı an, kaydın çekildiği an değil. Sonuç: olay saatleri videonun
       içindeki gerçek zamanla hiç tutmuyordu. start_at boşsa saat bilgisi
       yoktur; arayüz göreli süre gösterir ve kullanıcıdan girmesini ister. */
    start_time: v.start_at || null,
    end_time: v.start_at ? isoPlus(v.start_at, dur) : null,
    start_at_missing: !v.start_at,
    duration: dur,
    fps: v.fps || px?.fps || 0,
    width: v.width || px?.width || 0,
    height: v.height || px?.height || 0,
    // codec alanı ffprobe ile ORİJİNALDEN okunuyor (upload endpoint'i öyle diyor)
    codec: px ? px.codec : (v.codec || null),
    src_codec: v.codec || null,
    bitrate_kbps: 0,
    file_size_mb: v.video_file_size
      ? Math.round(v.video_file_size / 1048576 * 10) / 10 : 0,
    gop_sec: px ? 1.0 : null,
    faststart: !!px,
    proxy_mode: px?.mode || null,
    latitude: v.latitude,
    longitude: v.longitude,
    is_ptz: v.is_ptz,
    guid_id: v.guid_id,
    group_id: v.group_id,
    segment_index: v.segment_index,
    segment_count: v.segment_count,
    prev_video_id: v.prev_video_id,
    next_video_id: v.next_video_id,
    frame_count: v.frame_count,
    duration_ms: v.duration_ms,
    mime_type: v.mime_type,
    live: true,
  };
}

/** VLM'in "olay yok" cevabını tanır — bunlar timeline'da soluk görünür */
const NO_EVENT = /특이\s*사항\s*없음|이상\s*없음|no\s+(?:notable|unusual)/i;

function firstLine(text) {
  const clean = String(text || '')
    .replace(/\*\*/g, '')
    .replace(/^[-*•]\s*/gm, '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  if (!clean.length) return '(empty response)';
  const s = clean[0];
  return s.length > 90 ? s.slice(0, 88) + '…' : s;
}

/**
 * VLM segmenti → bizim olay nesnesi.
 *
 * DİKKAT: backend sabit aralıklı örnekleme yapıyor
 * (vlm_segment_interval_seconds 60 / duration 10), yani videonun yalnızca
 * ~%17'sine bakılıyor. Aradaki olaylar hiç görülmüyor. Bizim tasarımdaki
 * "후보 구간 선정" tam da bunu çözmek içindi — detection verisi açılınca
 * aday skorunu kendimiz hesaplayıp bu boşluğu kapatabiliriz.
 */
function toEvent(r, video, idx) {
  const text = (r.response && (r.response.text ?? r.response.content)) ?? '';
  const quiet = NO_EVENT.test(text) && text.length < 200;
  const t0 = r.segment_start_seconds ?? 0;
  const t1 = r.segment_end_seconds ?? t0;
  return {
    id: `V${video.id}-S${r.id ?? idx}`,
    public_id: null,
    video_id: String(video.id),
    camera_id: video.guid_id || null,
    event_group_id: null,
    event_group_code: null,
    event_group_title: null,
    status: 'candidate',
    severity_level: quiet ? 0 : 2,
    start_timestamp_ms: Math.round(t0 * 1000),
    end_timestamp_ms: Math.round(t1 * 1000),
    occurred_start_at: isoPlus(video.start_time, t0),
    occurred_end_at: isoPlus(video.start_time, t1),
    title: quiet ? '특이사항 없음' : firstLine(text),
    t_start: t0,
    t_end: t1,
    wall_start: isoPlus(video.start_time, t0),
    wall_end: isoPlus(video.start_time, t1),
    type: quiet ? 'quiet' : 'vlm',
    type_ko: quiet ? '특이사항 없음' : 'VLM 관측',
    type_tr: quiet ? 'No event' : 'VLM observation',
    severity: quiet ? 'info' : 'warn',
    color: quiet ? '#5b6470' : '#e0a33e',
    description: text,
    description_en: null,
    score: null,
    track_ids: [],
    thumbnail: null,
    vlm_model: null,
    vlm_latency_ms: null,
    image_count: r.image_count,
    quiet,
  };
}

/* ------------------------------------------------------------ yükleyici --- */

async function allVideos(force = false) {
  if (cache.videos && !force) return cache.videos;
  const raw = await req('/video');
  cache.videos = await Promise.all((raw || []).map(toCamera));
  return cache.videos;
}

async function videoById(id) {
  const list = await allVideos();
  return list.find((v) => v.id === String(id));
}

/** `/analysis/result/{id}/all` — sonucu önbellekler, olaylara çevirir */
async function resultOf(id) {
  const key = String(id);
  // Promise'i önbelleğe alıyoruz, sonucu değil: screenSingle video/summary/
  // events çağrılarını Promise.all ile paralel yapıyor, sonuç önbelleği
  // dolmadan üçü birden istek atıp aynı 404'ü üç kez tetikliyordu.
  if (cache.results.has(key)) return cache.results.get(key);
  const p = loadResult(id);
  cache.results.set(key, p);
  return p;
}

async function loadResult(id) {
  const video = await videoById(id);
  let out = { metadata: null, events: [], warning: null };
  try {
    const r = await req(`/analysis/result/${id}/all`);
    out = {
      metadata: r.metadata || null,
      warning: r.warning || null,
      events: (r.results || []).map((x, i) => toEvent(x, video || { id }, i)),
    };
  } catch (e) {
    // 404 = bu video için analiz hiç çalışmamış. Normal durum, hata değil.
    if (e.status !== 404) {
      cache.results.delete(String(id));   // geçici hata → tekrar denenebilsin
      throw e;
    }
  }
  return out;
}

/* ------------------------------------------------------------- kuyruk ----- */

/** DVSummary kuyruk durumları → arayüzün `analysis_run_status` sözlüğü */
const RUN_STATUS = {
  succeeded: 'completed',
  cancelled: 'canceled',
  canceled: 'canceled',
  running: 'running',
  queued: 'queued',
  failed: 'failed',
  pending: 'queued',
};

/**
 * `analysis_queue` satırı → arayüzün beklediği "run" nesnesi.
 *
 * Gerçek API'de ilerleme yüzdesi YOK — kuyrukta yalnızca durum var. Çubuğu
 * çalışırken 0'da bırakmak yerine belirsiz bir değer gösteriyoruz; backend
 * `request` JSONB'sine progress yazarsa burası tek satırda gerçekleşir.
 */
function toRun(j) {
  const st = RUN_STATUS[(j.status || '').toLowerCase()] || j.status;
  const t0 = j.started_at ? Date.parse(j.started_at) : null;
  const t1 = j.completed_at ? Date.parse(j.completed_at) : null;
  const prog = (j.request && typeof j.request.progress === 'number')
    ? Math.round(j.request.progress * (j.request.progress <= 1 ? 100 : 1))
    : (st === 'completed' ? 100 : 0);
  return {
    job_id: `Q${j.video_id}`,
    video_id: String(j.video_id),
    type: 'analysis',
    status: st,
    progress: prog,
    stage: j.worker_id || null,
    stage_label: st === 'running'
      ? `${j.worker_id || 'worker'} · no progress reported`
      : (j.worker_id || '—'),
    created_at: j.queued_at,
    started_at: j.started_at,
    completed_at: j.completed_at,
    duration_sec: (t0 && t1) ? Math.round((t1 - t0) / 1000) : null,
    error: j.last_error,
    attempt_count: j.attempt_count,
    max_attempts: j.max_attempts,
  };
}


/* ------------------------------------------------- Object Page / PAR ------
   Uçlar:
     GET /analysis/result/{id}/tracks?...&limit=&offset=      (liste)
     GET /analysis/result/{id}/track/{track_id}               (ayrıntı)
     GET /analysis/result/{id}/track/{track_id}/crop          (BestShot)
     GET /analysis/result/{id}/tracks/par/stats

   ZAMAN — `lifecycle`
   -------------------
   Backend 2026-08-28'de track'in giriş/çıkış zamanını vermeye başladı:

     "lifecycle": {
       "appearance_timestamp": 0,        "appearance_frame_index": 6,
       "appearance_at":  "…07:23:50.118Z",
       "disappearance_timestamp": 55.40065104166666,
       "disappearance_frame_index": 2067,
       "disappearance_at": "…07:24:45.518651Z"
     }

   `*_timestamp` SANİYE: iki duvar saati arasındaki fark 55.400651 sn, alanla
   birebir aynı. Artık şerit tahmin değil, gerçek aralık.

   `frame_index` ZAMAN İÇİN KULLANILMAZ. Bu videoda 2067. kare 55.4 sn'ye
   denk geliyor (37.2 kare/sn) ama videonun gerçek hızı 30 fps — indeks sunum
   karesi değil, analiz hattının kendi sayacı. Zaman yalnızca `timestamp`ten.

   Eski birim: aynı alan daha önce 1/30000 zaman tabanındaydı (kare başına
   1001 birim). Karışıklık çıkmasın diye dönüştürücü ikisini de tanıyor.     */

/* ==========================================================================
   Modelin sınıf tablosu
   --------------------------------------------------------------------------
   Backend'in `_DEFAULT_NAME_TO_ID` sözlüğünün birebir tersi (2026-09-04'te
   alındı). COCO DEĞİL — yalnızca 0 ve 1 rastlantı eseri örtüşüyor.

   Buraya kadarki tablo COCO varsayılanından kopyalanmıştı ve 2'den sonraki
   HER kimliği yanlış adlandırıyordu. Etkisi göründüğünden büyük: 5/6/7
   "bus / train / truck" sanılıyordu, oysa gerçekte bicycle / motorcycle /
   boar. Ekranda saçma "otobüs" kayıtları çıkınca bunlar hatalı yakalama
   sayılmış ve süzgeç gruplarından ÇIKARILMIŞTI — yani model doğru iş
   yapıyordu, biz yanlış okuyorduk. Gruplar bu yüzden aşağıda yeniden açıldı.

   Uç bir gün `class_name` göndermeye başlarsa bu tablo tamamen kalkabilir.
   ========================================================================== */
export const CLASS_NAME = {
  0: 'person', 1: 'car', 2: 'falldown', 3: 'bus', 4: 'truck',
  5: 'bicycle', 6: 'motorcycle', 7: 'boar', 8: 'tractor', 9: 'scooter',
  10: 'tiller', 11: 'cat', 12: 'dog',
};

/* GRUPLAMA YOK. Bir dönem sınıflar kovalara toplanıyordu (car+bus+truck →
   "vehicle"); tek kazancı süzgeci kısaltmaktı, bedeli ekranda modelin
   söylemediği bir ad görmekti. Artık `cls` sınıf adının ta kendisi:
   "car" olan "car" görünüyor. Süzgeç hangi adları göstereceğine kendi karar
   veriyor (bkz. screens/objects.js CLASSES) — listede olmayan sınıfın kaydı
   yine duruyor, yalnızca o düğmeye basılarak aranamıyor.        */

/**
 * Zaman damgası → saniye.
 *
 * Normalde alan zaten saniye. Videonun süresini fazlasıyla aşıyorsa eski
 * 1/30000 zaman tabanından geldiği varsayılıyor — o dönemin verisi hâlâ
 * duruyorsa ekran yine doğru çizsin.
 */
function tsToSec(v, durSec) {
  if (v == null) return null;
  const s = Number(v);
  if (!isFinite(s) || s < 0) return null;
  if (durSec && s > durSec * 1.5) {
    const alt = s / 30000;
    if (alt <= durSec * 1.5) return alt;
  }
  return s;
}

/**
 * PAR sonucunu düzleştirir.
 *
 * Gelen biçim:
 *   { age: ["Adult"], gender: ["Female"], hair: ["Short"],
 *     upper: ["Any"], lower: ["Black"], Hat: false, Backpack: false }
 *
 * "Any" bilgi taşımıyor — süzmeye sokmuyoruz ama gösterimden de atmıyoruz;
 * modelin "kararsızım" dediği yeri gizlemek yanıltıcı olur.
 */
function flattenPar(attrs) {
  const flat = [];                       // [{ key, value }]
  if (!attrs || typeof attrs !== 'object') return { flat, map: {} };
  for (const [k, v] of Object.entries(attrs)) {
    if (Array.isArray(v)) v.forEach((x) => x && flat.push({ key: k, value: String(x) }));
    else if (v === true) flat.push({ key: k, value: k });
    else if (typeof v === 'string' && v) flat.push({ key: k, value: v });
  }
  const map = {};
  for (const { key, value } of flat) {
    map[key] = map[key] ? `${map[key]}, ${value}` : value;
  }
  return { flat, map };
}

let loggedTrack = false;
let loggedClasses = false;
let warnedShot = false;

/** `/tracks` satırı (ya da `/track/{id}` ayrıntısı) → ekranın nesnesi */
function toTrackObject(r, videoId, durSec) {
  if (!loggedTrack) {
    loggedTrack = true;
    console.info('[backend] ham track kaydı:', r);
  }
  const tid = r.track_id;
  /* SINIF HER CEVAPTA GELMİYOR. Liste ucu `class_id` veriyor, tek track
     ayrıntısı vermiyor — `fillLifecycles` bu yüzden dışarıdan enjekte
     ediyor. `class_ids` dizisi bazı cevaplarda var, ilk elemanı aynı bilgi.
     Hiçbiri yoksa sınıf BİLİNMİYOR demektir; "other" demek yanlış olur,
     çünkü ona bakıp eleme yapan kod var (Re-ID aday süzgeci). */
  const cid = r.class_id ?? (Array.isArray(r.class_ids) ? r.class_ids[0]
    : undefined);
  const known = cid != null;
  const name = known ? (CLASS_NAME[cid] || `class ${cid}`) : 'unknown';
  const snap = r.snapshot || {};
  const par = r.par || {};
  const lc = r.lifecycle || null;
  const { flat, map } = flattenPar(par.attributes);

  let shot = tsToSec(snap.timestamp, durSec);
  const t0 = lc ? tsToSec(lc.appearance_timestamp, durSec) : null;
  const t1 = lc ? tsToSec(lc.disappearance_timestamp, durSec) : null;
  const hasRange = t0 != null && t1 != null && t1 > t0 + 0.05;

  /* BestShot aralığın DIŞINA düşüyorsa o değere güvenilmez: liste ve ayrıntı
     uçları zaman damgasını farklı birimde vermiş olabiliyor (biri saniye,
     öteki 1/30000 zaman tabanı). Böyle bir durumda kırpımın anını
     bilmiyoruz — aralığın kendisi doğru, onu bozmuyoruz. */
  if (hasRange && shot != null && (shot < t0 - 0.5 || shot > t1 + 0.5)) {
    if (!warnedShot) {
      warnedShot = true;
      console.warn('[backend] bestshot aralık dışında, yok sayıldı:',
                   { track: tid, shot, t0, t1 });
    }
    shot = null;
  }

  return {
    id: `V${videoId}-T${tid}`,
    track_id: tid,
    video_id: String(videoId),
    class_id: cid ?? null,
    class_name: name,
    cls: known ? name : null,
    /* Süzgeç yazanlar için: `cls === null` "bilmiyoruz" demek, "other" değil. */
    class_known: known,
    crop: `${LIVE}/analysis/result/${videoId}/track/${tid}/crop`,
    /* Şerit `lifecycle`ten; yoksa bestshot anında tek işaret. */
    t_first: hasRange ? t0 : (shot ?? 0),
    t_last: hasRange ? t1 : (shot ?? 0),
    has_range: hasRange,
    bestshot: shot,
    appearance_at: lc ? lc.appearance_at : null,
    disappearance_at: lc ? lc.disappearance_at : null,
    wall_time: snap.created_at || null,
    conf: (r.detection || {}).latest_confidence ?? null,
    par_exists: !!(par.exists || par.attributes),
    par_model: par.model_name || null,
    par_list: flat,          // [{key, value}] — süzme bunun üstünde
    attrs: map,              // { gender: 'Female', lower: 'Black', … }
    label: known ? `#${tid} ${name}` : `#${tid}`,
    event_count: (r.event || {}).count ?? (r.events || []).length,
  };
}

/** Bir track istenen PAR değerlerini taşıyor mu? (büyük/küçük harf duyarsız) */
function parMatches(o, wanted) {
  return wanted.every((w) => {
    const v = String(w.value).toLowerCase();
    return o.par_list.some((x) =>
      (!w.key || x.key.toLowerCase() === w.key.toLowerCase())
      && x.value.toLowerCase() === v);
  });
}

/**
 * Liste ucu `lifecycle` vermiyorsa ayrıntı ucundan tamamlar.
 *
 * Aralık şeridin tamamı demek, o yüzden tahmine bırakmıyoruz. İstek sayısı
 * track sayısı kadar olabiliyor; sekizerli havuzla gidiyor ve sonuç
 * önbelleğe alınıyor, böylece sonraki aramalar bedava.
 */
async function fillLifecycles(videoId, items, durSec) {
  const missing = items.filter((o) => !o.has_range);
  if (!missing.length) return;

  const POOL = 8;
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const o = missing[i++];
      const key = `${videoId}:${o.track_id}`;
      let d = cache.tracks.get(key);
      if (d === undefined) {
        try {
          d = await req(`/analysis/result/${videoId}/track/${o.track_id}`);
        } catch { d = null; }
        cache.tracks.set(key, d);
      }
      if (!d) continue;
      const full = toTrackObject({ ...d, class_id: o.class_id }, videoId, durSec);
      if (full.has_range) {
        o.t_first = full.t_first;
        o.t_last = full.t_last;
        o.has_range = true;
        o.appearance_at = full.appearance_at;
        o.disappearance_at = full.disappearance_at;
      }
      if (!o.par_exists && full.par_exists) {
        o.par_exists = true;
        o.par_list = full.par_list;
        o.attrs = full.attrs;
        o.par_model = full.par_model;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, missing.length) },
                                worker));
}

/* ---------------------------------------------------------------- API ----- */

export const backendApi = {
  __live: true,

  health: async () => {
    try {
      return await req('/status/health');
    } catch (e) {
      return e.data || { status: 'degraded' };
    }
  },
  openapi: () => req('/openapi.json'),

  login: async (username) => ({ token: 'live', user: { username } }),
  me: async () => ({ username: 'operator' }),

  groups: async () => {
    const [groups, videos] = await Promise.all([
      req('/video/groups'), allVideos(true),
    ]);
    const byGroup = new Map();
    for (const v of videos) {
      const k = v.group_id == null ? '_' : String(v.group_id);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(v);
    }
    const out = (groups || []).map((g, i) => ({
      id: String(g.id),
      /* Grubun bagli oldugu koleksiyon (null olabilir). Koleksiyon ekrani
         gruplari buradan topluyor; agac paneli de bunu kullanip gruplari
         koleksiyon basliklari altina koyuyor. */
      collection_id: g.collection_id == null ? null : String(g.collection_id),
      name: g.name,
      name_ko: g.name,
      desc: g.description || '',
      public_id: null,
      display_order: i,
      cameras: (byGroup.get(String(g.id)) || []).map((v) => ({
        ...v, event_count: 0, object_count: 0,
      })),
    }));
    const orphan = byGroup.get('_') || [];
    if (orphan.length) {
      out.push({
        id: '_', name: '(no group)', name_ko: '(no group)',
        desc: 'Videos with no video_group assigned',
        display_order: out.length,
        cameras: orphan.map((v) => ({ ...v, event_count: 0, object_count: 0 })),
      });
    }
    return {
      groups: out,
      enums: {
        video_status: ['registered', 'uploading', 'ready', 'analyzing',
                       'completed', 'failed', 'deleted'],
        event_status: ['candidate', 'confirmed', 'dismissed'],
        analysis_run_status: ['queued', 'running', 'succeeded', 'failed',
                              'cancelled'],
      },
      event_types: [
        { code: 'vlm', ko: 'VLM 관측', color: '#e0a33e' },
        { code: 'quiet', ko: '특이사항 없음', color: '#5b6470' },
      ],
    };
  },

  // PAR (öznitelik) tanımları: gerçek pipeline'da PAR modeli yok
  // (metadata'da yalnızca YOLO + ByteTrack + Qwen3-VL var). Şekli koruyoruz
  // ki filtre paneli boş ama sağlam çizilsin.
  /* ---- yükleme akışı ---------------------------------------------------
     Backend iki fazlı: önce rezervasyon (id + guid ayrılır, prev/next ve
     segment_index sırayla otomatik hesaplanır), sonra her id'ye dosya. */

  /** Yüklenmiş videonun meta verisini günceller (başlangıç saati dahil). */
  updateVideo: (id, fields) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    }
    cache.videos = null;
    return req(`/video/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p,
    });
  },

  group: (id) => req(`/video/groups/${id}`),

  updateGroup: (id, fields) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields || {})) {
      if (v !== undefined && v !== null) body.set(k, v);
    }
    cache.videos = null;
    return req(`/video/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  },

  /** Grubu siler. Backend icindeki videolari da siliyorsa cagiran yer uyarmali. */
  deleteGroup: async (id) => {
    const r = await req(`/video/groups/${id}`, { method: 'DELETE' });
    cache.videos = null;
    cache.collections = null;
    return r;
  },

  /** Videoyu siler; analiz sonucu ve proxy kaydi da anlamsizlasir. */
  deleteVideo: async (id) => {
    const r = await req(`/video/${id}`, { method: 'DELETE' });
    cache.videos = null;
    cache.results.delete(String(id));
    cache.par.delete(String(id));
    cache.streams.delete(String(id));
    return r;
  },

  createGroup: (name, description, collectionId) => {
    const body = new URLSearchParams({ name, description: description || '' });
    if (collectionId != null && collectionId !== '') {
      body.set('collection_id', String(collectionId));
    }
    cache.collections = null;
    return req('/video/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  },

  /* ==================================================== koleksiyonlar ======
     Koleksiyon, video GRUBUNUN ustundeki katman: bir grup tek kameranin
     farkli saatlerdeki kayitlari, koleksiyon ise BIRLIKTE incelenmek istenen
     gruplarin (yani farkli kameralarin) demeti.

     Backend gruplari koleksiyonla birlikte donduruyor (`collection_id`), ama
     koleksiyonun icindekileri veren bir uc YOK. Bu yuzden birlestirmeyi
     burada yapiyoruz: koleksiyon listesi + grup listesi -> her koleksiyonun
     kendi gruplari. Ekran kodu bu ayrimi hic gormuyor.
  */
  collections: async () => {
    /* Onbellek: koleksiyon listesi neredeyse hic degismiyor ama her ekran
       acilisinda okunuyor ve `groups()` ile birlikte iki istek demek.
       Yazma uclarinin hepsi bunu sifirliyor. */
    if (cache.collections) return cache.collections;
    const [cols, cat] = await Promise.all([
      req('/video/collections'), backendApi.groups(),
    ]);
    const byCol = new Map();
    for (const g of cat.groups) {
      if (g.collection_id == null) continue;
      if (!byCol.has(g.collection_id)) byCol.set(g.collection_id, []);
      byCol.get(g.collection_id).push(g);
    }
    cache.collections = (cols || []).map((c) => ({
      id: String(c.id),
      name: c.name,
      desc: c.description || '',
      created_at: c.created_at,
      groups: byCol.get(String(c.id)) || [],
    }));
    return cache.collections;
  },

  createCollection: async (name, description) => {
    const r = await req('/video/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name, description: description || '' }),
    });
    cache.collections = null;
    return r;
  },

  /** Grubu koleksiyona tasir. Ayni uc tasima ve ilk atama icin kullaniliyor. */
  assignGroup: async (groupId, collectionId) => {
    const r = await req(`/video/groups/${groupId}/collection/${collectionId}`,
      { method: 'PUT' });
    cache.videos = null;
    cache.collections = null;
    return r;
  },

  /* ================================================ nesne baglantilari =====
     POST/GET/DELETE /video/object-linkages

     Uc yalnizca CIFT sakliyor: (grup,video,track) <-> (grup,video,track).
     Ne renk var ne kisi kimligi. "Ayni insan" kavrami bu ciftlerin
     olusturdugu grafigin BAGLI BILESENI olarak istemcide cikiyor
     (bkz. identity.js). Burasi yalnizca satirlari tasiyor.

     Listeleme ucunun suzgeci yok: butun satirlar geliyor, kapsam suzmesi
     identity.js icinde yapiliyor.
  */
  linkages: () => req('/video/object-linkages'),

  /**
   * @param {object} a {groupId, videoId, trackId}
   * @param {object} b ayni sekil
   * @param {?number|string} collectionId ikisinin ortak koleksiyonu (olabilir null)
   */
  createLinkage: (a, b, collectionId) => req('/video/object-linkages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    /* Alan adlari rakamla basliyor ('1st_group_id') — backend'in semasi boyle,
       degistiremeyiz. JS tarafinda tirnak icinde yaziliyor. */
    body: JSON.stringify({
      collection_id: collectionId == null ? null : Number(collectionId),
      '1st_group_id': Number(a.groupId),
      '1st_video_id': Number(a.videoId),
      '1st_track_id': Number(a.trackId),
      '2nd_group_id': Number(b.groupId),
      '2nd_video_id': Number(b.videoId),
      '2nd_track_id': Number(b.trackId),
    }),
  }),

  deleteLinkage: (id) =>
    req(`/video/object-linkages/${id}`, { method: 'DELETE' }),

  /* ==================================================== front ayarlari =====
     /settings/custom — backend'in bize ayirdigi serbest JSON alani.
     Kapsam dort turlu: anahtarla (genel), koleksiyon, grup, video.

     Burada ne saklaniyor: RENK. Kisi kimligi object-linkages'ta duruyor ve
     orasi rengi bilmiyor; renk ise yalnizca calisirken isimize yarayan bir
     isaret. Ikisini ayri tutmanin bedeli iki istek, kazanci ise rengin
     kaybolmasinin kimligi bozmamasi.

     404 = "henuz yazilmadi", hata degil. `settingGet` bu durumda null donuyor
     ki cagiran her yerde try/catch yazmak zorunda kalmasin.
  */
  settingGet: async (scope, id) => {
    try {
      const r = await req(settingPath(scope, id));
      return (r && r.config) || null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },

  settingPut: (scope, id, config) => req(settingWritePath(scope, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    /* Anahtar kapsaminda setting_key GOVDEDE, digerlerinde ADRESTE. */
    body: JSON.stringify(scope === 'key'
      ? { setting_key: String(id), config: config || {} }
      : { config: config || {} }),
  }),

  settingDelete: (scope, id) =>
    req(settingPath(scope, id), { method: 'DELETE' }),

  reserve: (groupId, clientKeys) => req('/video/reservations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      group_id: groupId == null ? null : Number(groupId),
      videos: clientKeys.map((k) => ({ client_key: k })),
    }),
  }),

  /* ---- birleştirme (server.py + ffmpeg, backend'e tek video olarak gider) --
     Bu uçlar KENDİ sunucumuzda (`/api/merge`), DVSummary'de değil. Parçalar
     tek tek ham gövde olarak gidiyor, ffmpeg birleştiriyor, sonuç doğrudan
     sunucudan backend'e akıtılıyor — birleşik dosya tarayıcıya hiç dönmüyor. */

  mergeCreate: async () => {
    const r = await fetch('/api/merge', { method: 'POST' });
    if (!r.ok) throw new Error(`could not start merge session (HTTP ${r.status})`);
    return r.json();
  },

  /** Tek parçayı yükler. onProgress(0..1) ile ilerleme bildirir. */
  mergePart(mergeId, index, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/merge/${mergeId}/part/${index}`
        + `?name=${encodeURIComponent(file.name)}`);
      x.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      x.onload = () => (x.status >= 200 && x.status < 300
        ? resolve(JSON.parse(x.responseText || '{}'))
        : reject(new Error(`part ${index}: HTTP ${x.status}`)));
      x.onerror = () => reject(new Error('network error'));
      x.send(file);
    });
  },

  /** ffmpeg concat — uzun sürebilir, çağıran yerde beklemeli gösterin. */
  /**
   * Birleştirmeyi başlatır.
   *
   * `segments`: ffmpeg'e gidecek SIRA — `[{part, in_ms, out_ms}, …]`.
   * Aynı `part` birden çok kez geçebilir; araya giren bir klip alttakini
   * ikiye böldüğünde böyle oluyor. Yükleme yine dosya başına tek.
   */
  mergeBuild: async (mergeId, segments, pads) => {
    const r = await fetch(`/api/merge/${mergeId}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: segments || [], pads: pads || [] }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`);
    return d;
  },

  /** Birleşik dosyayı rezerve edilmiş video_id'ye yükler. */
  mergeUpload: async (mergeId, body) => {
    const r = await fetch(`/api/merge/${mergeId}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.detail || d.error || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    cache.videos = null;
    return d;
  },

  mergeDrop: (mergeId) =>
    fetch(`/api/merge/${mergeId}`, { method: 'DELETE' }).catch(() => {}),

  /** Tek dosya yükler. onProgress(0..1) ile ilerleme bildirir. */
  upload(videoId, file, fields, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('name', fields.name || file.name);
    if (fields.description) fd.append('description', fields.description);
    if (fields.start_at) fd.append('start_at', fields.start_at);
    fd.append('is_ptz', fields.is_ptz ? 'true' : 'false');
    if (fields.latitude != null) fd.append('latitude', String(fields.latitude));
    if (fields.longitude != null) fd.append('longitude', String(fields.longitude));

    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${LIVE}/video/${videoId}/upload`);
      x.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      };
      x.onload = () => {
        let d = null;
        try { d = JSON.parse(x.responseText); } catch { /* boş */ }
        if (x.status >= 200 && x.status < 300) {
          cache.videos = null;                 // liste tazelensin
          resolve(d);
        } else {
          const err = new Error((d && d.detail) || `HTTP ${x.status}`);
          err.status = x.status;
          reject(err);
        }
      };
      x.onerror = () => reject(new Error('network error'));
      x.send(fd);
    });
  },

  /* Sema videoya BAGLI: PAR istatistigi analiz sonucundan cikiyor. Cagiran
     taraf video id'si veriyor; vermezse bos sema doner (ekran bos ama saglam
     cizilir). Mock'ta bu argüman yok sayılıyor, imza yine aynı. */
  attributes: async (videoId) => {
    if (videoId == null) return { attributes: { person: [], vehicle: [] } };
    const key = String(videoId);
    if (cache.par.has(key)) return cache.par.get(key);
    const p = req(`/analysis/result/${key}/tracks/par/stats`)
      .then((s) => {
        console.info('[live] ham PAR stats:', s);
        return { attributes: parSchema(s) };
      })
      .catch(() => ({ attributes: { person: [], vehicle: [] } }));
    cache.par.set(key, p);
    return p;
  },
  metrics: async () => ({ metrics: [] }),

  video: async (id) => {
    const v = await videoById(id);
    if (!v) { const e = new Error('video_not_found'); e.status = 404; throw e; }
    const r = await resultOf(id);
    return { ...v, summary: buildSummary(v, r) };
  },

  /**
   * Bir videonun AYNI GRUPTAKİ kardeşleri, duvar saatine göre sıralı.
   *
   * Çok parçalı kayıt için: bir kameradan sabah / öğlen / akşam üç ayrı
   * dosya yüklendiğinde üçü de aynı `group_id` altında ayrı birer video
   * olarak duruyor. Zaman çizgisi ve oynatıcı bu listeden `GroupClock`
   * kuruyor (bkz. groupclock.js).
   *
   * Grubu olmayan video kendi başına tek elemanlı bir liste — çağıran taraf
   * "grup var mı" diye ayrı bir kontrol yazmasın diye.
   */
  groupParts: async (id) => {
    const v = await videoById(id);
    if (!v) return [];
    if (v.group_id == null) return [v];
    const all = await allVideos();
    return all
      .filter((x) => x.group_id === v.group_id)
      .sort((a, b) => Date.parse(a.start_time || 0) - Date.parse(b.start_time || 0));
  },

  summary: async (id) => {
    const v = await videoById(id);
    return buildSummary(v, await resultOf(id));
  },

  // Zarf adları mock ile birebir aynı olmalı: { total, offset, limit, items }
  events: async (id, o) => {
    let evs = (await resultOf(id)).events;
    if (o && o.type) {
      const want = new Set(String(o.type).split(','));
      evs = evs.filter((e) => want.has(e.type));
    }
    if (o && o.qtext) {
      const q = String(o.qtext).toLowerCase();
      evs = evs.filter((e) => (e.description || '').toLowerCase().includes(q));
    }
    return { total: evs.length, offset: 0, limit: evs.length, items: evs };
  },

  event: async (id) => {
    const vid = String(id).split('-')[0].replace(/^V/, '');
    return (await resultOf(vid)).events.find((e) => e.id === id) || null;
  },

  // Gerçek API'de olay onaylama yok — yerelde tutulur, kalıcı değil
  eventStatus: async (id, status) => ({ id, status, persisted: false }),
  eventGroups: async () => ({ groups: [] }),

  analysisJobs: async () => {
    const rows = await req('/analysis?limit=200');
    const vids = await allVideos();
    const items = (rows || []).map((j) => {
      const run = toRun(j);
      const v = vids.find((x) => x.id === String(j.video_id));
      return {
        analysis_job_id: `Q${j.video_id}`,
        name: `Analysis of ${v ? v.name : 'video ' + j.video_id}`,
        prompt: (j.request && j.request.prompt) || null,
        status: run.status,
        run_ids: [run.job_id],
        runs: [run],
        requested_at: j.queued_at,
        completed_at: j.completed_at,
      };
    });
    return { total: items.length, items };
  },

  // --- kutu katmani (playback grubu) --------------------------------------
  /**
   * Video üstü kutular — `GET /playback/groups/{gid}/bboxes`.
   *
   * Uç `format=json` destekliyor, o yüzden msgpack çözücüsüne gerek yok.
   *
   *   GET /playback/groups/{gid}/bboxes?start_at=&end_at=&format=json
   *   → { frames: [{ video_id, frame_index, frame_time,
   *                  bboxes: [{ track_id, class_id, confidence,
   *                             x1, y1, x2, y2, time_seconds }] }] }
   *
   * ÜÇ TUHAFLIK — üçü de burada çözülüyor, çağıran taraf hiçbirini bilmiyor:
   *
   * 1. GRUP KAPSAMLI. Cevap grubun BÜTÜN videolarının karelerini taşıyor;
   *    `frame.video_id` ile kendi videomuzu ayıklıyoruz.
   * 2. DUVAR SAATİ — YALNIZCA SORGUDA. Pencereyi ISO damgasıyla istiyoruz
   *    (`start_at = video.start_time + from`), ama cevaptaki `time_seconds`
   *    `start_at`e göreli DEĞİL: videonun kendi başlangıcına göreli, yani
   *    zaten aradığımız video saniyesi. Üstüne `from` eklemek her pencereyi
   *    kendi genişliği kadar ileri kaydırır — 20-40 penceresi 40-60'a düşer,
   *    28. saniyedeki kişi 48'de görünür. Hiçbir şey EKLEME.
   * 3. BÜYÜK. 64 saniyelik pencere ≈ 6.4 MB / 23 500 kutu. Bütün videoyu tek
   *    istekte çekmek onlarca MB eder, o yüzden PENCERE saniyeyle sınırlı ve
   *    sonuç önbelleğe giriyor.
   *
   * Bu işlev TEK pencere getirir ve `BBOX_WINDOW` ile sınırlıdır. Videonun
   * tamamını kapsayan kayan pencere `bboxfeed.js` içinde.
   *
   * @param {string|number} videoId
   * @param {object} o  {from, to} — video saniyesi
   * @returns {{fps:number, coord:string, rows:Array}} overlay.js kablo biçimi:
   *          [t, track_id, class_id, conf, x1, y1, x2, y2] — hepsi normalize
   */
  detections: async (videoId, o = {}) => {
    const empty = { fps: 0, coord: 'xyxy_norm', rows: [] };
    const v = await videoById(videoId);
    /* Grup ya da başlangıç saati yoksa uç sorgulanamaz — sessizce boş dön,
       ekranın geri kalanı kutusuz çalışsın. */
    if (!v || v.group_id == null || !v.start_time) return empty;

    const from = Math.max(0, o.from || 0);
    const to = Math.min(o.to ?? from + BBOX_WINDOW, from + BBOX_WINDOW);
    if (to <= from) return empty;

    const startAt = isoPlus(v.start_time, from);
    const endAt = isoPlus(v.start_time, to);
    if (!startAt || !endAt) return empty;

    const key = `${v.group_id}|${startAt}|${endAt}|${videoId}`;
    if (cache.bbox.has(key)) return cache.bbox.get(key);

    const p = (async () => {
      const q = `start_at=${encodeURIComponent(startAt)}`
        + `&end_at=${encodeURIComponent(endAt)}&format=json`;
      const r = await req(`/playback/groups/${v.group_id}/bboxes?${q}`);

      const rows = [];
      const times = new Set();
      for (const f of (r && r.frames) || []) {
        if (String(f.video_id) !== String(videoId)) continue;   // (1) ayıkla
        for (const b of f.bboxes || []) {
          const t = b.time_seconds;                                 // (2)
          if (t == null) continue;
          times.add(t);
          rows.push([t, b.track_id, b.class_id, b.confidence ?? 1,
                     b.x1, b.y1, b.x2, b.y2]);
        }
      }
      return { fps: sampleFps(times, v.fps), coord: 'xyxy_norm', rows };
    })();

    cache.bbox.set(key, p);
    try { return await p; } catch (e) { cache.bbox.delete(key); throw e; }
  },

  /**
   * Object Page — `/tracks`.
   *
   * Süzme İSTEMCİDE. İki sebep:
   *   - uç sınıfa göre süzmüyor (yalnızca PAR parametreleri var)
   *   - `par_attribute` süzgeci `matched_attribute` alanını dolduruyor ama
   *     gerçek veride o alan hep null geliyor; `par.attributes` sözlüğü ise
   *     dolu. Sözlüğün üstünde süzmek bugün çalışıyor.
   * Uca `class_id` ve çoklu öznitelik parametreleri eklenirse süzme sunucuya
   * taşınır ve `limit` doğru anlam kazanır.
   */
  objects: async (videoId, o = {}) => {
    const v = await videoById(videoId);
    const q = new URLSearchParams();
    q.set('limit', String(o.limit || 500));
    q.set('offset', String(o.offset || 0));
    q.set('par_min_score', '0');
    q.set('par_active_only', 'false');

    let raw;
    try {
      raw = await req(`/analysis/result/${videoId}/tracks?${q}`);
    } catch (e) {
      if (e.status === 404) return { total: 0, items: [], returned: 0 };
      throw e;
    }
    const rows = Array.isArray(raw) ? raw : (raw.items || []);
    const durSec = v ? v.duration : 0;
    let items = rows.map((r) => toTrackObject(r, videoId, durSec));
    const returned = items.length;

    /* Sınıf adları tahmin (bkz. COCO tablosunun başındaki not). Hangi
       kimlikten kaç kayıt geldiğini bir kez yazıyoruz ki eşleşme yine
       şaşarsa kırpımlara bakıp tablodan düzeltilebilsin. */
    if (!loggedClasses) {
      loggedClasses = true;
      const dist = {};
      for (const x of items) {
        const k = `${x.class_id} → ${x.class_name}`;
        dist[k] = (dist[k] || 0) + 1;
      }
      console.info('[backend] sınıf dağılımı:', dist);
    }

    /* Sınıf ve PAR süzgeci ÖNCE: ayrıntı isteklerini yalnızca gösterilecek
       track'ler için atıyoruz, 300 kaydın hepsi için değil. */
    if (o.cls) items = items.filter((x) => x.cls === o.cls);
    const wanted = (o.par || []).filter((w) => w && w.value);
    if (wanted.length) items = items.filter((x) => parMatches(x, wanted));

    await fillLifecycles(videoId, items, durSec);
    items.sort((a, b) => a.t_first - b.t_first);
    return { total: raw.total ?? returned, returned, items };
  },

  /** Tek track'in ayrıntısı — lifecycle, PAR, olaylar. */
  track: async (videoId, trackId) => {
    const key = `${videoId}:${trackId}`;
    if (!cache.tracks.has(key)) {
      try {
        cache.tracks.set(key,
          await req(`/analysis/result/${videoId}/track/${trackId}`));
      } catch { cache.tracks.set(key, null); }
    }
    return cache.tracks.get(key);
  },

  /**
   * Tek track'i tam nesne olarak getirir.
   *
   * Re-ID akışı yalnızca `{group_id, video_id, track_id}` gönderiyor —
   * ekranda bir şerit çizmek için aralık, kırpım ve sınıf gerekiyor. Liste
   * ucunu (500 track) çekmek yerine tek kaydın ayrıntısını alıyoruz;
   * `cache.tracks` sayesinde aynı aday ikinci kez gelirse istek yok.
   */
  trackObject: async (videoId, trackId) => {
    const key = `${videoId}:${trackId}`;
    let d = cache.tracks.get(key);
    if (d === undefined) {
      try { d = await req(`/analysis/result/${videoId}/track/${trackId}`); }
      catch { d = null; }
      cache.tracks.set(key, d);
    }
    if (!d) return null;
    const v = await videoById(videoId);
    /* Sınıf ayrıntıda yok — liste ucundan gelen tablodan tamamlıyoruz. */
    const cid = d.class_id ?? (Array.isArray(d.class_ids) ? d.class_ids[0]
      : (await classIndex(videoId)).get(String(trackId)));
    return toTrackObject(
      cid != null ? { ...d, class_id: cid } : d, videoId, v ? v.duration : 0);
  },

  /* ======================================================== Re-ID akışı ====
     GET /analysis/result/groups/{gid}/video/{vid}/track/{tid}/reid/stream

     Grup içindeki DIĞER track'leri hedefle karşılaştırıp eşleşme sırasını
     SSE ile gönderiyor. Karşılaştırma hedefin merkez zamanına yakınlıktan
     başlıyor, yani ilk gelenler zaman olarak en yakın adaylar.

     NEDEN EventSource DEĞİL
     -----------------------
     Sunucu satır sonlarını GERÇEK yeni satır olarak değil, iki karakterlik
     kaçış dizisi olarak yazıyor. "curl … | cat -A" çıktısında tek bir $ yok;
     bütün gövde tek satır: dolgu yorumu, sonra metin olarak ters bölü + n,
     sonra "event: ranking", yine ters bölü + n, "data: []".

     SSE'de satır sonu protokolün KENDİSİ: tarayıcı böyle bir gövdeyi ":" ile
     başlayan tek bir yorum satırı sayar ve hiçbir olay tetiklenmez.
     EventSource bundan hiçbir şey çıkaramaz, araya girecek yer de bırakmaz.

     Bu yüzden gövdeyi fetch ile kendimiz okuyup çözümlüyoruz. İki yan kazanç:
       (1) sunucu düzeltilince aynı kod değişmeden gerçek satır sonlarıyla da
           çalışıyor — çeviri kendini kapatıyor,
       (2) EventSource'un akış bitince KENDİLİĞİNDEN yeniden bağlanması yok;
           o davranış bütün eşleştirmeyi baştan başlatıyordu.

     YÜKÜN BİÇİMİ
     ------------
     Gözlenen: "event: ranking" + "data: [...]" — düz bir dizi, elemanları
     tam olarak {group_id, video_id, track_id}. SKOR ALANI YOK: elimizdeki
     tek sinyal sıradaki konum. `normMatch` yine de bilinen skor adlarını
     arıyor, sunucu bir gün eklerse kendiliğinden görünür (`onRanking`
     tüketicisi null skoru zaten atlıyor).

     HER OLAY TAM SIRALAMA
     ---------------------
     Gözlem (grup 30 / video 57 / track 9): olaylar artımlı DEĞİL, her biri o
     ana kadarki bütün sıralamanın yeniden dizilmiş hâli. Liste hem büyüyor
     hem SIRA DEĞİŞTİRİYOR — 16 numara en son beliriyor ve doğrudan listenin
     başına geçiyor.

     Bu yüzden "ilk görülen birinci sıradır" varsayımı yanlış: sıra ancak SON
     olayda doğru. Her olayda bütün sıralamayı olduğu gibi yukarı veriyoruz,
     rütbe de o listedeki konumdan geliyor. Çağıran taraf farkı kendisi alıyor
     (yeni gelenleri çözüyor, eskilerin rütbesini güncelliyor).
  */
  /**
   * @param {object} opts `{collectionId}` verilirse arama KOLEKSIYON
   *   kapsaminda yapilir: hedefle ayni koleksiyondaki butun gruplarin
   *   track'leri karsilastirilir. Verilmezse eski davranis (tek grup).
   */
  reidStream(groupId, videoId, trackId, cb = {}, opts = {}) {
    /* DIKKAT — adresteki eksik bolu isareti KASITLI.
       Backend'in OpenAPI semasi bu yolu tam olarak soyle ilan ediyor:
         /analysis/result/collections/{collection_id}groups/{group_id}/...
       Yani `{collection_id}` ile `groups` arasinda bolu YOK. Duzeltip
       yazarsak 404 aliriz. Backend duzeltince buradaki tek satir degisir. */
    const url = opts.collectionId != null
      ? `${LIVE}/analysis/result/collections/${opts.collectionId}`
        + `groups/${groupId}/video/${videoId}/track/${trackId}/reid/stream`
      : `${LIVE}/analysis/result/groups/${groupId}`
        + `/video/${videoId}/track/${trackId}/reid/stream`;
    const ctrl = new AbortController();
    /* NL: gerçek satır sonu (tek karakter). ESC: sunucunun yazdığı
       İKİ karakterlik kaçış dizisi — ters bölü ve n. */
    const NL = '\n';
    const ESC = '\\n';
    let got = 0;
    let closed = false;
    let idleTimer = null;

    const stop = (why) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      try { ctrl.abort(); } catch { /* zaten kapanmış */ }
      if (cb.onDone) cb.onDone(why, got);
    };

    /* AKIŞ HİÇ BİTMİYOR. Sunucu bitiş olayı göndermiyor ve sıralama
       dolduktan sonra da aynı listeyi tekrar tekrar yollamaya devam ediyor —
       bağlantı kendiliğinden kapanmıyor.

       Bu yüzden BİZ kapatıyoruz: sıralama belli bir süre DEĞİŞMEZSE iş
       bitmiştir. Ölçüt "olay gelmedi" değil "sıralama değişmedi"; aynı liste
       saniyede bir tekrar gelirse zamanlayıcı hiç dolmaz ve bağlantı sonsuza
       kadar açık kalırdı. Kullanıcı hedefe yeniden tıklayarak sürdürebilir. */
    const IDLE_MS = 12000;
    let lastSig = null;
    const touch = () => {
      clearTimeout(idleTimer);
      if (closed) return;
      idleTimer = setTimeout(() => stop('idle'), IDLE_MS);
    };

    const pickList = (d) => {
      if (Array.isArray(d)) return d;
      if (!d || typeof d !== 'object') return [];
      for (const k of ['matches', 'items', 'results', 'ranking', 'candidates',
                       'data', 'tracks']) {
        if (Array.isArray(d[k])) return d[k];
      }
      return [];
    };

    const normMatch = (m) => {
      if (!m || typeof m !== 'object') return null;
      const vid = m.video_id ?? m.videoId;
      const tid = m.track_id ?? m.trackId;
      if (vid == null || tid == null) return null;
      const score = m.score ?? m.similarity ?? m.match_score ?? m.sim
        ?? (m.distance != null ? 1 - m.distance : null);
      return {
        videoId: String(vid),
        trackId: Number(tid),
        groupId: m.group_id ?? m.groupId ?? groupId,
        score: typeof score === 'number' ? score : null,
      };
    };

    let logged = false;

    /** Tek bir SSE çerçevesi: "event: x" ve "data: y" satırları. */
    const frame = (text) => {
      let name = 'message';
      const data = [];
      for (const line of text.split(NL)) {
        if (!line || line[0] === ':') continue;      // yorum / dolgu
        const c = line.indexOf(':');
        const k = c < 0 ? line : line.slice(0, c);
        const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (k === 'event') name = v;
        else if (k === 'data') data.push(v);
      }
      const body = data.join(NL);
      if (/^(done|end|complete|close)$/i.test(name)) return stop('done');
      if (!body) return;
      /* Gövdesi OLAN ilk çerçeveyi yaz. Akışın başındaki dolgu yorumu da bir
         çerçeve sayılıyor ama içinde veri yok; onu yazmak "ilk olay boş
         geldi" gibi okunurdu. */
      if (!logged) {
        logged = true;
        console.info('[reid] ilk olay:', { event: name, data: body });
      }

      let d;
      try { d = JSON.parse(body); } catch { return; }

      /* Gövde sonuç listesi değil de durum bildirimiyse akış bitmiştir. */
      const st = d && !Array.isArray(d) && (d.status || d.event || d.state);
      const list = pickList(d);
      if (!list.length && typeof st === 'string'
          && /done|end|complete|finish/i.test(st)) return stop('done');

      /* Sıralamayı OLDUĞU GİBİ aktar: rütbe listedeki konum. Aynı aday iki
         kez geçerse ilk konumu geçerli. */
      const rank = [];
      const dedupe = new Set();
      for (const raw of list) {
        const m = normMatch(raw);
        if (!m) continue;
        /* Hedefin kendisi listede olabilir — kendine eşleşme bilgi değil. */
        if (String(m.videoId) === String(videoId)
            && Number(m.trackId) === Number(trackId)) continue;
        const key = `${m.videoId}:${m.trackId}`;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        m.key = key;
        m.rank = rank.length + 1;
        rank.push(m);
        if (cb.limit && rank.length >= cb.limit) break;
      }
      /* Aynı sıralama tekrar geldiyse haber değil: ne çizim tazelemeye ne de
         zamanlayıcıyı sıfırlamaya değer. */
      const sig = rank.map((m) => m.key).join(',');
      if (sig === lastSig) return;
      lastSig = sig;
      touch();

      got = rank.length;
      if (cb.onRanking) cb.onRanking(rank);
      if (cb.limit && got >= cb.limit) stop('limit');
    };

    (async () => {
      let r;
      try {
        r = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
      } catch { return stop('error'); }
      if (!r.ok || !r.body) return stop('error');
      touch();       // hiç olay gelmese bile sessizlik fark edilsin

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      /* Kaçışlı biçim mi? İlk parçada gerçek satır sonu yoksa ama metin
         olarak kaçış dizisi varsa, bundan sonraki her parçayı çevirerek
         okuyoruz. Karar BİR KEZ veriliyor; sunucu düzeltilirse çeviri hiç
         devreye girmez ve gövde olduğu gibi işlenir. */
      let escaped = null;

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          /* CRLF de olabilir; satır sonu ayrıştırması tek biçim görsün. */
          let chunk = dec.decode(value, { stream: true })
            .split('\r').join('');
          /* Kararı ancak ipucu görünce ver: ilk parça yalnızca dolgudan
             ibaret olabiliyor ve o parçada ne satır sonu ne kaçış var —
             orada "kaçışlı değil" demek, sonraki parçaları bozardı. */
          if (escaped === null && (chunk.includes(NL) || chunk.includes(ESC))) {
            escaped = !chunk.includes(NL);
          }
          if (escaped) chunk = chunk.split(ESC).join(NL);
          buf += chunk;

          /* Çerçeveler boş satırla ayrılıyor; yarım kalan son parça
             tamponda bir sonraki okumayı bekliyor. */
          let k;
          while ((k = buf.indexOf(NL + NL)) >= 0) {
            const text = buf.slice(0, k);
            buf = buf.slice(k + 2);
            if (text.trim()) frame(text);
          }
          if (closed) break;
        }
        if (buf.trim() && !closed) frame(buf);
      } catch {
        /* abort da buraya düşüyor — `closed` zaten işaretli. */
      }
      stop('done');
    })();

    return { close: () => stop('closed') };
  },

  candidates: async () => ({
    window_sec: 0, threshold: 0, metrics: [], count: 0,
    selected: 0, windows: [],
  }),

  /* ============================================================ HLS =========
     Grup kapsamlı oynatma. `streamUrl` video başına tek dosya veriyor; bu
     ikisi grubun TAMAMINI tek çalma listesi olarak veriyor ve parçalar arası
     geçişi tarayıcıya bırakıyor.

     Adresler köprüden geçiyor (`/live`), çünkü playlist içindeki segment
     yolları da orada bizim önekimize göre yeniden yazılıyor — bkz. server.py
     `_rewrite_m3u8`. Doğrudan backend'e gidilirse hem CORS'a çarpılır hem de
     segment adresleri çözülemez. */
  hlsUrl: (groupId, kind = 'media') =>
    `${LIVE}/playback/groups/${groupId}/hls/${kind}.m3u8`,

  /** Grubun sunucu tarafındaki zaman çizelgesi — bizim GroupClock'un eşi. */
  playbackTimeline: (groupId) =>
    req(`/playback/groups/${groupId}/timeline`),

  /**
   * Duvar saati → oynatma offseti, SUNUCUNUN hesabıyla.
   * Kendi hesabımız (`GroupClock.playFromWall`) var; bu, onu doğrulamak ve
   * ileride yerine geçmek için duruyor.
   */
  resolvePlayback: (groupId, iso) =>
    req(`/playback/groups/${groupId}/timeline/resolve`
      + `?at=${encodeURIComponent(iso)}`),

  streamUrl: (id) => {
    // toCamera() imzası doğrulanmış proxy adresini buraya yazıyor; yoksa
    // backend stream'i. Ham index'e bakmıyoruz — bayat kayıt yanlış video oynatır.
    const u = cache.streams.get(String(id));
    return u || `${LIVE}/video/${id}/stream`;
  },
  posterUrl: () => '',

  /* Mock'un analiz diyaloğu kendi simülasyon alanlarını da gönderiyor
     (_sim_sec, target_ratio…). Gerçek backend bunları request JSONB'sine
     aynen yazıyor — anlamsız veri birikmesin diye süzüyoruz. */
  /**
   * Analizi kuyruğa alır.
   *
   * Backend, iptal edilmemiş HER kayıt için 409 döner — `succeeded` dahil.
   * Yani bir kez analiz edilmiş video doğrudan yeniden analiz edilemez;
   * önce kuyruk kaydı silinmeli (DELETE, durumu pending'e döndürür ve
   * SQLite sonucunu silmez). `force: true` bu iki adımı birleştirir.
   */
  analyze: async (id, body, opts) => {
    const settings = {};
    if (body && body.prompt) settings.prompt = body.prompt;
    if (body && body.model) settings.model = body.model;
    const post = () => req('/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: Number(id), settings }),
    });
    try {
      return await post();
    } catch (e) {
      if (e.status === 409 && opts && opts.force) {
        await req(`/analysis/${id}`, { method: 'DELETE' });
        cache.results.delete(String(id));
        return post();
      }
      throw e;
    }
  },

  /** Kuyruk kaydını siler; video 'pending'e döner, sonuç dosyası kalır. */
  dropAnalysis: (id) => {
    cache.results.delete(String(id));
    return req(`/analysis/${id}`, { method: 'DELETE' });
  },

  search: async (body) => {
    const q = (body && body.query || '').trim().toLowerCase();
    const ids = (body && body.video_ids && body.video_ids.length)
      ? body.video_ids : (await allVideos()).map((v) => v.id);
    const hits = [];
    for (const id of ids) {
      let evs;
      try { evs = (await resultOf(id)).events; } catch { continue; }
      for (const e of evs) {
        if (!q || (e.description || '').toLowerCase().includes(q)
               || (e.title || '').toLowerCase().includes(q)) {
          hits.push({ ...e, score: 1 });
        }
      }
    }
    return { total: hits.length, items: hits, took_ms: 0 };
  },
  searchGet: async () => ({ total: 0, items: [] }),

  jobs: async () => {
    const rows = await req('/analysis?limit=200');
    const items = (rows || []).map(toRun);
    return { total: items.length, items };
  },
  /** Yeniden analiz bitince eski sonucu at — yoksa ekran hep eskisini gösterir. */
  invalidate: (id) => {
    if (id == null) {
      cache.results.clear(); cache.par.clear(); cache.tracks.clear();
    }
    else { cache.results.delete(String(id)); cache.par.delete(String(id)); }
    cache.videos = null;
    cache.collections = null;
  },

  job: async (id) => req(`/analysis/${String(id).replace(/^Q/, '')}`),
  jobStreamUrl: () => null,          // SSE yok → app.js polling'e düşer
  jobCancel: (id) =>
    req(`/analysis/${String(id).replace(/^Q/, '')}/cancel`, { method: 'POST' }),

  // --- Re-ID: pipeline'da SOLIDER yok, embedding hiç üretilmiyor -----------
  reidStart: async () => { throw Object.assign(new Error('reid_unavailable'), { status: 501 }); },
  reid: async () => ({ matches: [] }),
  reidStreamUrl: () => null,
  reidContinue: async () => ({ matches: [] }),
  reidVerdict: async () => ({}),

  tracklists: async () => ({ total: 0, items: [] }),
  tracklist: async () => ({ id: 'TL1', name: 'Track list', members: [] }),
  trackAdd: async () => ({}),
  trackDel: async () => ({}),

  /* Gerçek API GPU kullanımı/bellek/sıcaklık vermiyor — sadece worker
     durumları var. Şekli koruyup bilinmeyen alanları null bırakıyoruz;
     ekran "—" gösterir, çökmez. */
  gpu: async () => {
    const h = await backendApi.health();
    const workers = (h.analysis && h.analysis.workers) || [];
    const busy = workers.filter((w) => w.status === 'analyzing').length;
    return {
      devices: [{
        index: 0,
        name: workers.length
          ? `${workers.length} analysis worker(s), ${busy} busy`
          : 'analysis worker yok',
        driver: '—',
        cuda: '—',
        util: null, mem_used: null, mem_total: null, temp: null,
        workers,
      }],
      services: {
        database: h.database && h.database.status,
        cachedb: h.cachedb && h.cachedb.status,
        vllm: h.vllm && h.vllm.status,
      },
    };
  },
  logs: async () => ({ total: 0, items: [] }),
  settings: async () => ({ settings: {}, choices: {} }),
  saveSettings: async (b) => b,
  exportStart: async () => { throw Object.assign(new Error('export_unavailable'), { status: 501 }); },
  exportGet: async () => ({}),
};

/** metadata → bizim özet nesnesi (modeller gerçek pipeline'dan geliyor) */
function buildSummary(video, res) {
  const m = res.metadata || {};
  const real = res.events.filter((e) => !e.quiet);
  return {
    video_id: video ? video.id : null,
    duration: video ? video.duration : 0,
    summary_duration: res.events.reduce(
      (a, e) => a + (e.t_end - e.t_start), 0),
    ratio: null,
    main_objects: [],
    event_count: real.length,
    generated_at: m.completed_at || null,
    engine_version: m.decoder_type
      ? `${m.object_detection_model_type} · ${m.tracking_algorithm_type}` : null,
    models: {
      detector: m.object_detection_model_type || null,
      tracker: m.tracking_algorithm_type || null,
      par: null,
      reid: null,
      vlm: m.vllm_model || null,
    },
    segments: res.events.map((e) => ({
      src_video_id: video ? video.id : null,
      src_start: e.t_start, src_end: e.t_end,
      sum_start: e.t_start, sum_end: e.t_end,
    })),
    prompt_used: m.vllm_prompt || null,
    warning: res.warning,
    // backend'in gerçekten ürettiği ama API'den çıkmayan sayılar
    detection_result_count: m.detection_result_count ?? null,
    vlm_result_count: m.vlm_result_count ?? null,
    frame_count: m.frame_count ?? null,
    gpu_name: m.gpu_name || null,
    sampling: (m.vlm_segment_interval_seconds && m.vlm_segment_duration_seconds)
      ? { interval: m.vlm_segment_interval_seconds,
          duration: m.vlm_segment_duration_seconds,
          coverage: m.vlm_segment_duration_seconds / m.vlm_segment_interval_seconds }
      : null,
  };
}

/* `initBackend()` kaldırıldı (2026-09-01).

   Tek yaptığı `proxyIndex()`i önden ısıtmaktı ve `core.js` bunu modül
   düzeyinde `await` ediyordu. Bedeli ağırdı: `core.js`i import eden HER
   modül o ağ isteğini bekliyordu, yani backend yavaşsa ekranda hiçbir şey
   çizilmiyordu — hata mesajı bile değil, boş sayfa.

   Isıtmaya zaten gerek yoktu: `videoById()` içinde `await proxyIndex()`
   var ve fonksiyon sonucu kendi önbelleğine alıyor. İlk isteyen yüklüyor,
   sonrakiler bedava. */
