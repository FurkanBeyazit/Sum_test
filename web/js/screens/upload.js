/* ==========================================================================
   Ekran: Upload & Analysis
   --------------------------------------------------------------------------
   Amaç: aynı kameranın farklı zaman dilimlerine ait kayıtlarını TEK bir
   kesintisiz zaman çizgisinde birleştirmek.

   Akış (dosya süresi neden upload'dan SONRA biliniyor):
     VMS kayıtları AVI/mpeg4 — tarayıcı bu dosyaları açamadığı için süreyi
     yerel olarak okuyamıyoruz. MP4 ise okuyoruz (anında görünür), değilse
     backend'in ffprobe sonucunu bekliyoruz. Bu yüzden sıra:
        dosya seç → yükle → süre gelir → başlangıç saatlerini ayarla → analiz

   Çakışma (overlap): iki kayıt aynı zaman aralığını kapsıyorsa o aralık
   kırmızı gösterilir ve ikinci kayıtta kırpılmış sayılır — aynı görüntü iki
   kez analiz edilmesin diye.
   ========================================================================== */

import {
  el, mount, clear, store, api, t, hms, ms, dur, bytes, pad,
  toast, modal
} from '../core.js';
import {
  ROOT, onLeave, topbar, treePanel, askReanalyze, confirmModal
} from '../ui.js';

/**
 * Sol ağaç ve Analysis ekranı `store.groups`'tan besleniyor ve bu liste
 * yalnızca ilk açılışta dolduruluyordu (`route()`). Yükleme bitince yeni
 * grup ancak sayfa yenilenince görünüyordu — burada zorla tazeliyoruz.
 */
/**
 * Koleksiyon adına karşılık gelen grubu bulur ya da oluşturur.
 *
 * Backend aynı adda ikinci bir grubu kabul etmiyor (`400 Video group name
 * already exists`). Eskiden bu hata doğrudan yüzeye çıkıyordu ve — merge
 * akışında grup oluşturma birleştirmeden SONRA geldiği için — kullanıcı
 * dakikalarca süren bir ffmpeg işinin ardından "Merge failed" görüyordu.
 * Oysa birleştirme başarılıydı, çakışan tek şey isimdi.
 *
 * Aynı adlı grup varsa onu KULLANIYORUZ. Yeni bir kayıt daha o koleksiyona
 * ekleniyor demektir; kullanıcının kastı da bu (aynı yere aynı adı yazdı).
 * Sessizce yapmıyoruz, bildirim çıkıyor.
 */
async function ensureGroup(name) {
  const want = name.trim().toLowerCase();
  const find = async () => {
    const r = await api.groups();
    return (r.groups || []).find(
      (g) => String(g.name || '').trim().toLowerCase() === want);
  };

  const hit = await find();
  if (hit) {
    toast(`Using existing group "${hit.name}" · id ${hit.id}`, 'ok', 5000);
    return hit.id;
  }
  try {
    const g = await api.createGroup(name.trim());
    toast(`Group created · id ${g.id}`, 'ok');
    return g.id;
  } catch (e) {
    // Yarış: aradan başkası aynı adı yaratmış olabilir. Bir kez daha bak.
    if (/already exists/i.test(e.message || '')) {
      const again = await find();
      if (again) {
        toast(`Using existing group "${again.name}" · id ${again.id}`, 'ok');
        return again.id;
      }
    }
    throw e;
  }
}

async function refreshGroups() {
  try {
    api.invalidate();
    const g = await api.groups();
    store.set({ groups: g.groups, eventTypes: g.event_types });
    return g.groups;
  } catch (e) {
    toast('Could not refresh the group list: ' + e.message, 'warn');
    return store.get('groups');
  }
}

/**
 * Yükleme bittiği anda backend kaydı hâlâ RESERVED olabiliyor: dosya diske
 * yazılıyor, ffprobe koşuyor, durum ancak ondan sonra `uploaded`a dönüyor.
 * Tek seferlik tazeleme o araya denk gelince ağaçta mavi (registered) kayıt
 * kalıyor ve ancak elle F5 ile düzeliyordu. Burada kısa süre yokluyoruz.
 */
async function waitForVideoReady(videoId, tries = 6, delayMs = 1200) {
  for (let i = 0; i < tries; i++) {
    const groups = await refreshGroups();
    const cam = groups.flatMap((g) => g.cameras || [])
      .find((c) => String(c.id) === String(videoId));
    if (cam && cam.status !== 'registered') return cam;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

const UP = {
  collName: '',
  groupId: null,
  items: [],      // {key,file,name,startAt,durationMs,videoId,state,progress,meta}
  sel: 0,
  /* Birleştirme kipi: parçalar ffmpeg ile TEK bir MP4'e çevrilip backend'e
     tek video olarak gider. Kapalıyken her parça ayrı video_id alır. */
  merge: true,
  mergedId: null, // birleştirme sonrası oluşan video_id
  /* VLM örnekleme penceresi. Backend her `interval` saniyede bir `window`
     saniyelik pencere açıyor (metadata: vlm_segment_interval_seconds /
     vlm_segment_duration_seconds). Kullanıcı önemli anları bu pencerelere
     denk getirmek istiyor, o yüzden değerler arayüzde düzenlenebilir. */
  vlmInterval: +(localStorage.getItem('up.vlmInterval') || 60),
  vlmWindow: +(localStorage.getItem('up.vlmWindow') || 10),
};

/**
 * Birleşik videodaki yerleşim. Boşluklar concat'te DÜŞER: kümülatif konum
 * yalnızca parça sürelerinin toplamıdır, duvar saatindeki aralıklar değil.
 *
 * @returns {{rows:Array, total:number}} rows: {item, at, dur, end}
 */
function mergedLayout(items) {
  /* SIRA: zaman çizgisindeki başlangıç saatine göre — `UP.items` dizisinin
     kendi sırası değil. Kullanıcı çubukları sürükleyip yer değiştirdiğinde
     dizi sırası olduğu gibi kalıyor; buna güvenince alt şerit sürüklemeyi
     hiç görmüyordu. */
  const idx = new Map(items.map((it, i) => [it, i]));
  const list = items.filter((i) => i.startAt).sort((a, b) =>
    a.startAt - b.startAt || idx.get(a) - idx.get(b));

  const rows = [];
  let t = 0;          // birleşik videodaki konum
  let wallEnd = null; // bir öncekinin duvar saatindeki bitişi
  for (const it of list) {
    const full = it.durationMs || EST_DUR_MS;
    const outMs = it.trimOut == null ? full : it.trimOut;
    const wallStart = it.startAt.getTime();

    /* ÇAKIŞMA: iki parça aynı zaman aralığını kapsıyorsa sonrakinin başı o
       kadar atılır — üstteki rayın kırmızı bantla söylediği şey bu. Eskiden
       burada hesaba katılmıyordu ve birleşik uzunluk çakışan görüntüyü iki
       kez sayıyordu. Kalıcı yazmıyoruz (kullanıcının trim'i bozulmasın),
       yalnızca bu yerleşim için hesaplıyoruz. */
    let inMs = it.trimIn || 0;
    let overlapCut = 0;
    if (wallEnd != null && wallStart < wallEnd) {
      overlapCut = Math.min(wallEnd - wallStart, Math.max(0, outMs - inMs - 200));
      inMs += overlapCut;
    }

    const dur = Math.max(200, outMs - inMs);
    rows.push({ item: it, at: t, dur, end: t + dur, inMs, outMs, overlapCut });
    t += dur;
    wallEnd = Math.max(wallEnd == null ? -Infinity : wallEnd,
                       wallStart + effDur(it));
  }
  return { rows, total: t };
}

/** k. örnekleme penceresi [başlangıç, bitiş] — birleşik video saniyesinde. */
function vlmWindows(totalMs, intervalSec, windowSec) {
  const out = [];
  const iv = Math.max(1, intervalSec) * 1000;
  const w = Math.max(1, windowSec) * 1000;
  for (let t = 0; t < Math.max(totalMs, 1); t += iv) {
    out.push({ t0: t, t1: Math.min(t + w, t + iv) });
  }
  return out;
}

/** Bir parçanın ne kadarı örnekleme penceresine düşüyor (ms). */
function coveredMs(row, wins) {
  let n = 0;
  for (const w of wins) {
    n += Math.max(0, Math.min(row.end, w.t1) - Math.max(row.at, w.t0));
  }
  return n;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → <input type="datetime-local"> değeri (yerel saat, saniyeli) */
function toLocalInput(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
       + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---- hover önizleme -------------------------------------------------------
   Dosyalar zaten tarayıcıda duruyor, yani sunucuya hiç gitmeden kare
   alabiliyoruz: gizli bir <video>'yu istenen saniyeye sarıp <canvas>'a
   çiziyoruz. Yalnızca tarayıcının açabildiği kaplarda çalışır (MP4/WebM/MOV);
   AVI'de sessizce devre dışı kalır.

   Her dosya için TEK bir <video> tutuluyor ve kareler önbellekleniyor —
   sürükleme sırasında saniyede onlarca istek gelebiliyor. */
const THUMB_CACHE = new Map();      // `${key}@${saniye}` → dataURL
const THUMB_VIDEOS = new Map();     // item.key → { el, url, ok }

function thumbVideo(it) {
  let v = THUMB_VIDEOS.get(it.key);
  if (v) return v;
  const elv = document.createElement('video');
  elv.preload = 'metadata';
  elv.muted = true;
  const url = URL.createObjectURL(it.file);
  elv.src = url;
  v = { el: elv, url, ok: null };
  THUMB_VIDEOS.set(it.key, v);
  return v;
}

function releaseThumbs() {
  for (const v of THUMB_VIDEOS.values()) {
    try { URL.revokeObjectURL(v.url); } catch { /* zaten serbest */ }
  }
  THUMB_VIDEOS.clear();
  THUMB_CACHE.clear();
}

/** Kaynak dosyanın `sec`. saniyesindeki kareyi dataURL olarak verir. */
function grabFrame(it, sec) {
  const q = Math.max(0, Math.round(sec * 2) / 2);      // 0,5 sn'ye yuvarla
  const ck = `${it.key}@${q}`;
  if (THUMB_CACHE.has(ck)) return Promise.resolve(THUMB_CACHE.get(ck));

  const v = thumbVideo(it);
  if (v.ok === false) return Promise.resolve(null);

  return new Promise((resolve) => {
    const done = (val) => {
      v.el.onseeked = null; v.el.onerror = null;
      clearTimeout(timer);
      if (val) THUMB_CACHE.set(ck, val);
      resolve(val);
    };
    const timer = setTimeout(() => done(null), 2500);
    v.el.onerror = () => { v.ok = false; done(null); };
    v.el.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        const w = 160;
        const h = Math.max(1, Math.round(w * (v.el.videoHeight || 9)
                                          / (v.el.videoWidth || 16)));
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v.el, 0, 0, w, h);
        v.ok = true;
        done(c.toDataURL('image/jpeg', 0.7));
      } catch { v.ok = false; done(null); }
    };
    const seek = () => { try { v.el.currentTime = q; } catch { done(null); } };
    if (v.el.readyState >= 1) seek();
    else v.el.onloadedmetadata = seek;
  });
}

/** Tarayıcı açabiliyorsa süreyi yerel olarak oku (mp4/webm). AVI'de null. */
function probeDurationMs(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
    v.onloadedmetadata = () => done(
      isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 1000) : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}

/* Süresi henüz bilinmeyen parçanın varsayılan uzunluğu (10 dk). Sadece
   çizim içindir — gerçek süre upload sonrası ffprobe'dan gelir. */
const EST_DUR_MS = 10 * 60 * 1000;

/** Kırpma sonrası kullanılacak süre (kırpma yoksa dosyanın tamamı). */
function effDur(it) {
  const full = it.durationMs || EST_DUR_MS;
  const a = it.trimIn || 0;
  const b = it.trimOut == null ? full : it.trimOut;
  return Math.max(200, Math.min(b, full) - a);
}

/** Bu parçada kırpma var mı (kaynağın tamamı kullanılmıyor mu)? */
function isTrimmed(it) {
  if (!it.durationMs) return !!it.trimIn;
  return (it.trimIn || 0) > 0 || (it.trimOut != null && it.trimOut < it.durationMs);
}

/**
 * Zaman çizgisi düzeni: sıralı parçalar, boşluklar ve çakışmalar.
 *
 * Süresi bilinmeyen (AVI, henüz yüklenmemiş) dosyalar da çizilir — yoksa
 * kullanıcı yükleme öncesi hiçbir şey göremez ve sürükleyemez. Bunlar
 * `est:true` ile işaretlenir: tahmini uzunlukla gösterilir, boşluk/çakışma
 * hesabına KATILMAZ (yanlış kırmızı bant çıkmasın diye).
 */
function layoutUpload(items) {
  const usable = items.filter((i) => i.startAt);
  if (!usable.length) return null;
  const parts = usable
    .map((i) => {
      const est = !i.durationMs;
      // Zaman çizgisindeki uzunluk KIRPILMIŞ süredir — birleşik videoya
      // giden de bu. Kırpma yoksa dosyanın tamamı.
      const dur = effDur(i);
      return { item: i, est, dur, trimmed: isTrimmed(i),
               t0: i.startAt.getTime(), t1: i.startAt.getTime() + dur };
    })
    .sort((a, b) => a.t0 - b.t0);

  const t0 = parts[0].t0;
  const t1 = Math.max(...parts.map((p) => p.t1));

  /* Boşluk/çakışma yalnızca süresi kesin olan parçalar arasında anlamlı */
  const solid = parts.filter((p) => !p.est);
  const overlaps = [];
  const gaps = [];
  if (solid.length) {
    let cursor = solid[0].t1;
    for (let i = 1; i < solid.length; i++) {
      const p = solid[i];
      if (p.t0 < cursor) {
        overlaps.push({ t0: p.t0, t1: Math.min(cursor, p.t1),
                        a: solid[i - 1].item, b: p.item });
      } else if (p.t0 > cursor) {
        gaps.push({ t0: cursor, t1: p.t0 });
      }
      cursor = Math.max(cursor, p.t1);
    }
  }
  const overlapMs = overlaps.reduce((s, o) => s + (o.t1 - o.t0), 0);
  const gapMs = gaps.reduce((s, g) => s + (g.t1 - g.t0), 0);
  const solidSpan = solid.length
    ? Math.max(...solid.map((p) => p.t1)) - solid[0].t0 : 0;
  return { parts, t0, t1, span: t1 - t0, overlaps, gaps, overlapMs, gapMs,
           mergedMs: solidSpan - gapMs,
           estCount: parts.length - solid.length };
}

export async function screenUpload() {
  const stage = el('div.stage', { style: { padding: '12px', overflow: 'auto' } });
  const side = el('div.rightbar', { style: { padding: '12px' } });
  const sidebar = el('div.sidebar', {},
    treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
  mount(ROOT(), topbar('upload'), el('div.main', {}, sidebar, stage, side));

  const live = true;   // tek veri kaynağı — bayrak geçiş dönemi kalıntısı
  const tlBox = el('div.uptl');
  const listBox = el('div', { style: { display: 'grid', gap: '6px' } });
  const infoBox = el('div', { class: 'tiny muted' });
  const sideBox = el('div', { style: { display: 'grid', gap: '12px' } });
  const mergeNote = el('div', { class: 'tiny', style: { flex: 1, lineHeight: 1.6 } });

  /**
   * Birleştirmenin analiz üzerindeki bedelini açıkça yazar.
   *
   * Backend VLM'i sabit aralıkla örnekliyor (vlm_segment_interval_seconds 60,
   * duration 10). Kısa klipler AYRI kalırsa her birine bir pencere düşer ve
   * neredeyse tamamı analiz edilir; tek dosyada birleşince aynı 60 sn'lik
   * aralık tüm kaydı kapsar ve yalnızca ilk 10 saniye görülür.
   */
  function drawMergeNote() {
    const parts = UP.items.length || 0;
    const totalMs = UP.items.reduce((a, i) => a + (i.durationMs || 0), 0);
    if (!UP.merge) {
      mergeNote.style.color = 'var(--tx-2)';
      mergeNote.textContent = parts
        ? `${parts} file(s) will be registered as separate video_ids.`
        : 'Each file is registered as its own video_id.';
      return;
    }
    mergeNote.style.color = '#fbbf24';
    const secs = totalMs / 1000;
    mount(mergeNote,
      el('div', {}, parts
        ? `${parts} file(s) will be merged into one MP4 by ffmpeg and `
          + 'registered as a single video_id.'
        : 'Files are merged into one MP4 and registered as a single video_id.'),
      secs > 10 ? el('div', {},
        'Coverage warning: the VLM looks at only 10s out of every 60s. '
        + `Merged, roughly `
        + `${Math.max(1, Math.round(secs / 60)) * 10}s of ${hms(secs)} `
        + 'would be analyzed — kept separate, nearly all of each file is.') : null);
  }

  /* ---- yeniden çizim ---------------------------------------------------- */

  /** Zaman çizgisinin altındaki özet satırı (sürükleme dışındaki normal hâl) */
  function drawInfo(L) {
    if (!L) { infoBox.textContent = ''; return; }
    mount(infoBox,
      el('span', {}, `Merged length ${hms(L.mergedMs / 1000)}`),
      L.gapMs ? el('span', { style: { color: 'var(--tx-2)' } },
        ` · gaps ${hms(L.gapMs / 1000)}`) : null,
      L.overlapMs ? el('span', { style: { color: '#f87171' } },
        ` · overlap ${hms(L.overlapMs / 1000)} (trimmed from the later clip)`) : null,
      L.estCount ? el('span', { style: { color: '#fbbf24' } },
        ` · ${L.estCount} clip(s) with estimated length`) : null,
      (() => {
        const cut = UP.items.filter(isTrimmed);
        if (!cut.length) return null;
        const cutMs = cut.reduce(
          (s, i) => s + ((i.durationMs || 0) - effDur(i)), 0);
        return el('span', { style: { color: '#38bdf8' } },
          ` · ✂ ${cut.length} trimmed (${hms(cutMs / 1000)} cut)`);
      })(),
      el('span', { class: 'muted' }, ' · drag a bar to move it'));
  }

  /* ---- hover önizleme kutusu --------------------------------------------- */
  const thumbBox = el('div.upthumb', { style: { display: 'none' } },
    el('img', {}), el('div.t', {}));
  document.body.append(thumbBox);
  onLeave(() => { thumbBox.remove(); releaseThumbs(); });

  let thumbSeq = 0;
  async function showThumb(it, srcSec, x, topY) {
    const my = ++thumbSeq;
    thumbBox.style.display = '';
    thumbBox.style.left = Math.round(x) + 'px';
    thumbBox.style.top = Math.round(topY) + 'px';
    thumbBox.querySelector('.t').textContent =
      `${it.name} · ${hms(srcSec)} of source`;
    const url = await grabFrame(it, srcSec);
    if (my !== thumbSeq) return;              // imleç çoktan başka yere gitti
    const img = thumbBox.querySelector('img');
    if (url) { img.src = url; img.style.display = ''; }
    else {
      img.style.display = 'none';
      thumbBox.querySelector('.t').textContent =
        `${it.name} · ${hms(srcSec)} · no preview (browser cannot decode)`;
    }
  }
  function hideThumb() { thumbSeq++; thumbBox.style.display = 'none'; }

  /** Zaman ekseni için okunur bir adım seç (1sn … 6sa). */
  function niceStep(spanMs, target = 6) {
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
                   3600, 7200, 10800, 21600];
    const want = spanMs / 1000 / target;
    return (STEPS.find((s) => s >= want) || 21600) * 1000;
  }

  function drawTimeline() {
    clear(tlBox);
    const L = layoutUpload(UP.items);
    if (!L) {
      tlBox.append(el('div', {
        class: 'tiny muted',
        style: { padding: '22px', textAlign: 'center' },
      }, UP.items.length
        ? 'No start time yet — set it in the Start time field on the right'
        : 'Drop video files here'));
      infoBox.textContent = '';
      return;
    }
    /* Görünür aralığa %4 pay bırakıyoruz: ilk parçayı sola, sonuncuyu sağa
       sürükleyebilmek için kenarda boşluk gerekiyor. */
    const pad = (L.span || 60000) * 0.04;
    const d0 = L.t0 - pad;
    const dSpan = L.span + pad * 2;
    const pctOf = (t) => ((t - d0) / dSpan) * 100;
    const track = el('div.uptrack');

    for (const g of L.gaps) {
      track.append(el('div.upgap', {
        style: { left: pctOf(g.t0) + '%', width: (pctOf(g.t1) - pctOf(g.t0)) + '%' },
        title: `Gap ${hms((g.t1 - g.t0) / 1000)}`,
      }, el('span', {}, hms((g.t1 - g.t0) / 1000))));
    }
    /* Çubuk artık iki satır taşıyor: sıra no + ad, altında süre. Genişlik
       dar kaldığında CSS ikinci satırı gizliyor. */
    L.parts.forEach((p, i) => {
      const cls = [UP.items[UP.sel] === p.item ? 'on' : '', p.est ? 'est' : '']
        .filter(Boolean).join(' ');
      const durTxt = p.est ? '?' : hms(p.dur / 1000);
      const bar = el('div.upbar', {
        class: cls,
        style: { left: pctOf(p.t0) + '%', width: (pctOf(p.t1) - pctOf(p.t0)) + '%' },
        title: `${i + 1}. ${p.item.name}\n`
             + `start  ${new Date(p.t0).toLocaleString()}\n`
             + (p.est
               ? 'length unknown until upload\n'
               : `end    ${new Date(p.t1).toLocaleString()}\n`
                 + `length ${hms(p.dur / 1000)}\n`)
             + 'drag to move · hold Shift to disable snapping',
      },
        el('span.upbar-n', {}, String(i + 1)),
        el('span.upbar-t', {},
          el('b', {}, p.item.name),
          el('i', {}, p.trimmed ? `✂ ${durTxt}` : durTxt)));
      bar.addEventListener('pointerdown', (e) => startDrag(e, p, L, bar, track));
      /* İmleç çubuğun neresindeyse kaynağın o anındaki kareyi gösteriyoruz —
         "hangi kısmı kırpıyorum / neyi çakıştırıyorum" sorusunun tek doğru
         cevabı görüntünün kendisi. */
      if (!p.est) {
        bar.addEventListener('pointermove', (ev) => {
          if (ev.buttons) return;                 // sürükleme sırasında rahat bırak
          const r = bar.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1)));
          const srcSec = ((p.item.trimIn || 0) + f * p.dur) / 1000;
          showThumb(p.item, srcSec, ev.clientX, r.top);
        });
        bar.addEventListener('pointerleave', hideThumb);
      }
      track.append(bar);
    });
    for (const o of L.overlaps) {
      track.append(el('div.upover', {
        style: { left: pctOf(o.t0) + '%',
                 width: Math.max(0.6, pctOf(o.t1) - pctOf(o.t0)) + '%' },
        title: `Overlap ${hms((o.t1 - o.t0) / 1000)} — trimmed from ${o.b.name}`,
      }));
    }

    /* --- VLM pencereleri, DOĞRUDAN çubukların üzerinde --------------------
       Ayrı bir şerit yerine burada gösteriyoruz: parlak yeşil boyanan her
       aralık gerçekten analiz edilecek görüntü, gerisine hiç bakılmayacak.
       Kullanıcı klipleri sürükleyip kırparken önemli anı bu bantların altına
       getirmeye çalışıyor — bakması gereken tek yer burası.

       Eşleme duvar saatinden DEĞİL birleşik konumdan yapılıyor: boşluklar
       concat'te düştüğü için bir klibin birleşik videodaki yeri duvar
       saatiyle aynı olmak zorunda değil. `mergedLayout` her klip için
       birleşik başlangıcı (`at`) ve çakışmadan atılan başı (`overlapCut`)
       veriyor; aradaki dönüşüm doğrusal. */
    const ML = mergedLayout(UP.items);
    const rowOf = new Map(ML.rows.map((r) => [r.item, r]));
    const wins = vlmWindows(ML.total, UP.vlmInterval, UP.vlmWindow);
    let seenMs = 0;
    for (const p of L.parts) {
      const r = rowOf.get(p.item);
      if (!r) continue;
      // birleşik konum m → duvar saati t
      const toWall = (m) => p.t0 + r.overlapCut + (m - r.at);
      for (const w of wins) {
        const a = Math.max(r.at, w.t0);
        const b = Math.min(r.end, w.t1);
        if (b - a <= 0) continue;
        seenMs += b - a;
        track.append(el('div.upseen', {
          style: { left: pctOf(toWall(a)) + '%',
                   width: (pctOf(toWall(b)) - pctOf(toWall(a))) + '%' },
          title: `Analyzed by the VLM\nmerged ${hms(a / 1000)} – ${hms(b / 1000)}`,
        }));
      }
    }
    const blind = ML.rows.filter((r) => coveredMs(r, wins) === 0);

    /* Zaman çizgisinin kendisi de bırakma alanı — dosyayı doğrudan buraya
       sürükleyip bırakabilmek için. */
    track.addEventListener('dragover', (e) => {
      e.preventDefault(); track.classList.add('over');
    });
    track.addEventListener('dragleave', () => track.classList.remove('over'));
    track.addEventListener('drop', (e) => {
      e.preventDefault(); track.classList.remove('over');
      addFiles([...e.dataTransfer.files].filter((f) => f.size > 0));
    });

    /* --- duvar saati cetveli: eşit aralıklı, okunur adımlarla ------------- */
    const ruler = el('div.uprule');
    const step = niceStep(dSpan);
    const first = Math.ceil(d0 / step) * step;
    for (let t = first; t <= d0 + dSpan; t += step) {
      const pc = pctOf(t);
      if (pc < 1 || pc > 99) continue;
      ruler.append(el('div.uptick', { style: { left: pc + '%' } },
        el('span', {}, new Date(t).toLocaleTimeString())));
    }

    tlBox.append(
      el('div.uptime', {},
        el('span', {}, new Date(L.t0).toLocaleString()),
        el('span.grow'),
        el('span', { class: 'muted' },
          `${L.parts.length} clips · ${hms(ML.total / 1000)} merged`),
        el('span.grow'),
        el('span', {}, new Date(L.t1).toLocaleString())),
      ruler, track,
      el('div.uprule-lbl', {},
        el('span.upseen-key', {}),
        ` bright = analyzed by the VLM (${UP.vlmWindow}s every `
        + `${UP.vlmInterval}s of merged video) · everything else is skipped`,
        el('span.grow'),
        el('span', { style: { color: seenMs ? 'var(--ok)' : 'var(--tx-3)' } },
          `${hms(seenMs / 1000)} analyzed`),
        blind.length ? el('span', {
          style: { color: '#f87171', marginLeft: '8px', fontWeight: 700 },
          title: blind.map((r) => r.item.name).join(', '),
        }, `· ${blind.length} clip(s) never analyzed`) : null));

    drawInfo(L);
  }

  /* ---- çubuğu sürükleyerek başlangıç saatini değiştirme ------------------ */

  /**
   * Sürükleme boyunca ÖLÇEK DONDURULUR: `L` ve piksel/ms oranı pointerdown
   * anında hesaplanıp sabit tutulur. Yoksa parça kaydıkça `layoutUpload()`
   * yeni bir `t0`/`span` üretir, çizim yeniden ölçeklenir ve çubuk imlecin
   * altından kaçar.
   */
  function startDrag(e, part, L, bar, track) {
    if (e.button !== 0) return;
    e.preventDefault();
    const it = part.item;
    const dur = part.dur;              // tahmini olabilir (bkz. layoutUpload)
    UP.sel = UP.items.indexOf(it);
    drawList(); drawSide();

    const rect = track.getBoundingClientRect();
    const pad = (L.span || 60000) * 0.04;
    const msPerPx = (L.span + pad * 2) / (rect.width || 1);
    const x0 = e.clientX;
    const orig = it.startAt.getTime();
    const leftPct = parseFloat(bar.style.left);

    // Yapışma hedefleri: diğer parçaların başı ve sonu (kendisi hariç)
    const snaps = L.parts.filter((p) => p.item !== it)
      .flatMap((p) => [p.t0, p.t1]);
    const snapMs = msPerPx * 8;          // 8 piksellik yakalama alanı

    bar.classList.add('drag');
    bar.setPointerCapture(e.pointerId);

    let next = orig;

    const move = (ev) => {
      let t = orig + (ev.clientX - x0) * msPerPx;
      let snapped = false;
      if (!ev.shiftKey) {                // Shift basılıysa serbest sürükleme
        for (const s of snaps) {
          if (Math.abs(t - s) < snapMs) { t = s; snapped = true; break; }
          const end = t + dur;
          if (Math.abs(end - s) < snapMs) { t = s - dur; snapped = true; break; }
        }
      }
      next = Math.round(t / 1000) * 1000;   // saniyeye yuvarla
      bar.classList.toggle('snap', snapped);
      bar.style.left = (leftPct + (next - orig) / msPerPx / rect.width * 100) + '%';

      const delta = (next - orig) / 1000;
      mount(infoBox, el('span', { class: 'updrag-info' },
        `${it.name} → ${new Date(next).toLocaleString()}`
        + (part.est ? ' … ?'
          : ` … ${new Date(next + dur).toLocaleTimeString()}`)
        + `  (${delta >= 0 ? '+' : '−'}${hms(Math.abs(delta))})`
        + (snapped ? '  ⟵ snapped' : '')));
    };

    const up = async () => {
      bar.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      bar.classList.remove('drag', 'snap');
      if (next === orig) { redraw(); return; }
      it.auto = false;           // elle konumlandırılan parça çapa olur
      it.startAt = new Date(next);
      redraw();
      await saveStart(it);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * Başlangıç saatini backend'e yazar — ama yalnızca dosya yüklenmişse.
   * Henüz yüklenmemiş parçalarda saat sadece bellekte durur ve upload
   * sırasında `start_at` alanı olarak gider (doUpload → api.upload).
   */
  async function saveStart(it) {
    if (!live || !it.videoId || it.state !== 'done') return;
    try {
      await api.updateVideo(it.videoId, { start_at: it.startAt.toISOString() });
      toast(`${it.name} · start time saved`, 'ok', 2200);
    } catch (err) {
      toast(`${it.name}: could not save — ${err.message}`, 'err', 6000);
    }
  }

  function drawList() {
    mount(listBox, UP.items.map((it, i) => {
      const st = { pending: 'Waiting', uploading: 'Uploading', done: 'Done',
                   error: 'Failed' }[it.state] || it.state;
      return el('div.uprow', {
        class: UP.sel === i ? 'on' : '',
        onclick: () => { UP.sel = i; redraw(); },
      },
        el('span', { class: 'mono tiny', style: { width: '22px' } }, String(i + 1)),
        el('span', { style: { flex: 1, overflow: 'hidden',
                              textOverflow: 'ellipsis' } }, it.name),
        el('span', { class: 'tiny muted mono' },
          it.durationMs ? hms(it.durationMs / 1000) : '—'),
        el('span', { class: 'tiny muted' }, bytes(it.file.size / 1048576)),
        it.state === 'uploading'
          ? el('div.progline', { style: { width: '80px' } },
            el('i', { style: { width: Math.round(it.progress * 100) + '%' } }))
          : el('span', {
            class: 'tiny',
            style: { color: it.state === 'done' ? 'var(--ok)'
                   : it.state === 'error' ? '#f87171' : 'var(--tx-2)' },
          }, st),
        el('button.iconbtn', {
          title: 'Remove',
          onclick: (e) => {
            e.stopPropagation();
            UP.items.splice(i, 1);
            UP.sel = Math.max(0, Math.min(UP.sel, UP.items.length - 1));
            redraw();
          },
        }, '×'));
    }));
  }

  function drawSide() {
    const it = UP.items[UP.sel];
    mount(sideBox,
      el('div', { style: { fontWeight: 700, fontSize: '15px' } }, 'Clip settings'),
      !it ? el('div', { class: 'tiny muted' }, 'Select a clip') : el('div', {
        style: { display: 'grid', gap: '10px' },
      },
        el('div', { class: 'tiny muted' }, it.name),

        el('div', {},
          el('div', { class: 'flabel' }, 'Start time'),
          el('input.input', {
            type: 'datetime-local', step: '1',
            value: toLocalInput(it.startAt),
            onchange: (e) => {
              it.auto = false;
              it.startAt = e.target.value ? new Date(e.target.value) : null;
              redraw();
              if (it.startAt) saveStart(it);
            },
          }),
          /* Bir öncekinin bittiği ana yapıştır — VMS kayıtları kesintisizse
             tek tıkla zinciri kurar. */
          UP.sel > 0 ? el('button.btn.sm.ghost', {
            style: { marginTop: '4px' },
            onclick: () => {
              const prev = UP.items[UP.sel - 1];
              if (!prev || !prev.startAt || !prev.durationMs) {
                return toast('Previous clip length is unknown', 'warn');
              }
              it.startAt = new Date(prev.startAt.getTime() + prev.durationMs);
              redraw();
              saveStart(it);
            },
          }, '⇥ Snap to end of previous clip') : null,
          el('div', { class: 'tiny muted', style: { marginTop: '4px' } },
            it.durationMs && it.startAt
              ? `Ends ${new Date(it.startAt.getTime() + it.durationMs)
                  .toLocaleString()}`
              : 'Length is confirmed after upload')),

        /* Elle kırpma kaldırıldı (müşteri isteği: gereksiz görüldü). Geriye
           yalnızca çakışma çözerken otomatik uygulanan kırpma kaldı — o da
           kullanıcı ayarı değil, birleştirmenin doğru çalışması için. */
        it.durationMs ? el('div', {},
          el('div', { class: 'flabel' }, 'Source length'),
          el('div', { class: 'tiny muted' },
            hms(it.durationMs / 1000)
            + (isTrimmed(it)
              ? ` · using ${hms(effDur(it) / 1000)} (overlap trimmed)`
              : ' · full'))) : null,

        el('div', {},
          el('div', { class: 'flabel' }, 'Metadata'),
          el('textarea.input', {
            rows: 8, placeholder: 'Free text (description, conditions, notes…)',
            style: { resize: 'vertical', fontFamily: 'inherit' },
            value: it.meta || '',
            oninput: (e) => { it.meta = e.target.value; },
          })),

        it.videoId ? el('div', { class: 'tiny muted mono' },
          `video_id ${it.videoId}`) : null));
  }

  function redraw() { drawTimeline(); drawList(); drawSide(); drawMergeNote(); }

  /* ---- dosya ekleme ----------------------------------------------------- */

  /**
   * Parçaları uç uca dizer: boşluk da çakışma da kalmaz.
   *
   * Sıra MEVCUT başlangıç saatlerine göre belirlenir; yani kullanıcı çubukları
   * sürükleyerek bir sıra kurduysa o sıra korunur, sadece aralar kapatılır.
   * İlk parçanın başlangıcı sabit kalır — kullanıcının girdiği gerçek kayıt
   * saati bu, onu kaydırmak veriyi bozar.
   */
  function arrangeSequential() {
    if (!UP.items.length) return;
    const idx = new Map(UP.items.map((it, i) => [it, i]));
    UP.items.sort((a, b) => {
      const ta = a.startAt ? a.startAt.getTime() : Infinity;
      const tb = b.startAt ? b.startAt.getTime() : Infinity;
      return ta - tb || idx.get(a) - idx.get(b);
    });
    let t = UP.items[0].startAt ? UP.items[0].startAt.getTime() : Date.now();
    for (const it of UP.items) {
      it.startAt = new Date(t);
      it.auto = true;           // hepsi yeniden otomatik yerleşime döndü
      t += effDur(it);          // kırpılmışsa kırpılmış süre kadar ilerle
    }
    UP.sel = Math.min(UP.sel, UP.items.length - 1);
  }

  /**
   * OTOMATİK yerleşimdeki parçaları bir öncekinin bitişine zincirler.
   * Elle konumlandırılmış (`auto === false`) parçalara DOKUNMAZ — onlar
   * çapa görevi görür, sonrakiler onların ardına dizilir.
   *
   * Neden gerekli: dosya süreleri `probeDurationMs()` ile sonradan geliyor.
   * Ekleme anında uzunluk bilinmediği için ilk yerleşim tahminî oluyor;
   * gerçek süre gelince buranın yeniden koşması şart, yoksa parçalar
   * birbirinden 10 dakika uzakta duruyor.
   */
  function chainAuto() {
    for (let i = 1; i < UP.items.length; i++) {
      const prev = UP.items[i - 1];
      const it = UP.items[i];
      if (it.auto === false || !prev.startAt) continue;
      it.startAt = new Date(prev.startAt.getTime() + effDur(prev));
    }
  }

  /**
   * Çakışmaları KIRPARAK çözer: iki parça aynı zaman aralığını kapsıyorsa
   * sonrakinin BAŞI o kadar kırpılır ve başlangıcı öne alınır, böylece uç uca
   * otururlar. Aynı görüntü iki kez analiz edilmemiş olur.
   *
   * Neden sonrakinin başı: öncekinin kuyruğunu kesmek, kullanıcının o parça
   * için girdiği kayıt saatini geçersiz kılardı. Sonrakini kırpınca yalnızca
   * "bu kaydın ilk N saniyesi zaten diğerinde var" demiş oluyoruz.
   */
  function trimOverlaps() {
    const parts = [...UP.items].filter((i) => i.startAt && i.durationMs)
      .sort((a, b) => a.startAt - b.startAt);
    let fixed = 0, dropped = 0;
    let cursor = null;
    for (const it of parts) {
      const t0 = it.startAt.getTime();
      if (cursor != null && t0 < cursor) {
        const over = cursor - t0;
        const avail = effDur(it);
        if (over >= avail) {
          // parça tamamen bir öncekinin içinde kalıyor — kırpacak bir şey yok
          dropped++;
          cursor = Math.max(cursor, t0 + effDur(it));
          continue;
        }
        it.trimIn = (it.trimIn || 0) + over;
        it.startAt = new Date(cursor);
        fixed++;
      }
      cursor = it.startAt.getTime() + effDur(it);
    }
    return { fixed, dropped };
  }

  async function addFiles(files) {
    for (const f of files) {
      const it = {
        key: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file: f, name: f.name.replace(/\.[^.]+$/, ''),
        startAt: null, durationMs: null, videoId: null,
        state: 'pending', progress: 0, meta: '',
      };
      /* HER parçaya mutlaka bir başlangıç ver: son parçanın bittiği ana.
         `layoutUpload` startAt'i olmayanı elediği için, bu atlanınca parça
         zaman çizgisinde hiç görünmüyor. Eskiden yalnızca ilk parça saat
         alıyordu ve bir kez sürükleme yapıldıysa (otomatik dizilim kapanınca)
         2., 3., 4. dosyalar sessizce kayboluyordu — "Clear'dan sonra tek
         video görünüyor" hatası buydu. */
      const last = UP.items[UP.items.length - 1];
      it.auto = true;                    // yeni parça otomatik yerleşimde
      it.startAt = last && last.startAt
        ? new Date(last.startAt.getTime() + effDur(last))
        : new Date();
      UP.items.push(it);
      chainAuto();
      redraw();
      // MP4 ise süreyi hemen okuyabiliriz; AVI/mpeg4'te null döner
      probeDurationMs(f).then((ms) => {
        if (ms && !it.durationMs) {
          it.durationMs = ms;
          // gerçek süre gelince zincir tazelensin — tahminle açılan
          // aralıklar kapanır, elle konumlandırılanlar yerinde kalır
          chainAuto();
          redraw();
        }
      });
    }
  }

  /* ---- yükleme ---------------------------------------------------------- */

  /**
   * Birleştirmeli yükleme: parçalar sunucuya tek tek gider, ffmpeg orada
   * TEK bir MP4 üretir, sonuç doğrudan backend'e akıtılır. Birleşik dosya
   * tarayıcıya hiç dönmez.
   *
   * Sıra zaman çizgisindeki başlangıç saatine göre — kullanıcı çubukları
   * sürükleyerek belirlediği sıra neyse birleşim de o sırayla olur.
   */
  async function doMergeUpload() {
    const todo = UP.items.filter((i) => i.state === 'pending');
    if (!todo.length) return toast('No new files to upload', 'warn');
    if (!UP.collName.trim()) return toast('Enter a collection name', 'warn');
    if (todo.length !== UP.items.length) {
      return toast('Merge processes all files at once — clear the list and '
        + 'add them again', 'warn', 6000);
    }

    /* Sıra ve kesim noktaları TEK KAYNAKTAN: ekranda gördüğün birleşik şerit
       ne diyorsa ffmpeg'e giden de o. Burada ayrıca hesaplamak, iki yerin
       birbirinden ayrı düşmesi demekti (çakışma tam olarak öyle kaçmıştı). */
    const ML = mergedLayout(UP.items);
    const ordered = ML.rows.map((r) => r.item);
    const startAt = ordered[0].startAt || null;

    /* Boşluklar concat'te düşer: 09:00'da biten parçadan sonra 09:05'te
       başlayan parça birleşik videoda hemen ardından gelir. Sessizce
       yapmıyoruz — olay saatleri kayacağı için kullanıcı bilmeli. */
    const L = layoutUpload(UP.items);
    if (L && L.gapMs > 0) {
      const ok = await confirmModal('Merging will drop the gaps',
        `The timeline has ${hms(L.gapMs / 1000)} of gaps. `
        + 'In the merged video those gaps are removed and the clips run '
        + 'back to back, so event wall-clock times will no longer match '
        + 'reality. Continue?');
      if (!ok) return;
    }

    let mid = null;
    /* Hata mesajı hangi adımda kalındığını söylesin: birleştirme dakikalarca
       sürüyor ve ardından gelen bir hatayı "Merge failed" diye bildirmek
       kullanıcıyı yanlış yere baktırıyordu. */
    let phase = 'merge';
    try {
      mid = (await api.mergeCreate()).merge_id;

      for (let i = 0; i < ordered.length; i++) {
        const it = ordered[i];
        it.state = 'uploading'; it.progress = 0; drawList();
        await api.mergePart(mid, i, it.file, (p) => {
          it.progress = p; drawList();
        });
        it.state = 'done'; drawList();
      }

      toast('Merging… (ffmpeg — may take a few minutes for large files)',
        'ok', 8000);
      /* Kesim noktaları birleşik yerleşimden — `inMs` çakışma kırpmasını da
         içeriyor, yani üstteki rayda kırmızı görünen aralık gerçekten
         atılıyor. Index'ler yükleme sırasıyla aynı (ordered = ML.rows). */
      const trims = ML.rows.map((r, i) => ({
        index: i,
        in_ms: Math.round(r.inMs),
        out_ms: Math.round(r.outMs),
      })).filter((t, i) => t.in_ms > 0
        || t.out_ms < Math.round(ML.rows[i].item.durationMs || Infinity));
      const meta = await api.mergeBuild(mid, trims);
      for (const w of meta.warnings || []) toast(w, 'warn', 7000);

      if (!UP.groupId) UP.groupId = await ensureGroup(UP.collName);
      phase = 'upload';
      const key = `merged-${Date.now()}`;
      const res = await api.reserve(UP.groupId, [key]);
      const videoId = res[0].video_id;

      const v = await api.mergeUpload(mid, {
        video_id: videoId,
        name: UP.collName.trim(),
        description: UP.items.map((i) => i.meta).filter(Boolean).join('\n'),
        start_at: startAt ? startAt.toISOString() : null,
        filename: `${UP.collName.trim() || 'merged'}.mp4`,
      });

      UP.mergedId = videoId;
      for (const it of UP.items) { it.videoId = videoId; it.state = 'done'; }
      const durMs = (v && v.duration_ms) || meta.duration_ms || 0;
      toast(`Merged ${meta.part_count} clips → video ${videoId}`
        + ` · ${hms(durMs / 1000)} · ${meta.mode === 'copy'
          ? 'lossless copy' : 're-encoded'} in ${meta.elapsed_sec}s`,
        'ok', 8000);

      // backend ffprobe'u bitirene kadar bekle, sonra ağacı çiz
      await waitForVideoReady(videoId);
      mount(sidebar, treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
      redraw();
    } catch (e) {
      for (const it of UP.items) if (it.state === 'uploading') it.state = 'error';
      redraw();
      toast((phase === 'merge' ? 'Merge failed: ' : 'Upload failed: ')
        + e.message
        + (phase === 'upload'
          ? ' — the merged file is ready, only the upload step failed' : ''),
        'err', 9000);
    } finally {
      if (mid) api.mergeDrop(mid);
    }
  }

  async function doUpload() {
    if (!live) return toast('Upload only works in LIVE mode', 'warn');
    if (UP.merge) return doMergeUpload();
    const todo = UP.items.filter((i) => i.state === 'pending');
    if (!todo.length) return toast('No new files to upload', 'warn');
    if (!UP.collName.trim()) return toast('Enter a collection name', 'warn');

    try {
      if (!UP.groupId) UP.groupId = await ensureGroup(UP.collName);
      const res = await api.reserve(UP.groupId, todo.map((i) => i.key));
      const byKey = new Map(res.map((r) => [r.client_key, r]));

      for (const it of todo) {
        const r = byKey.get(it.key);
        if (!r) { it.state = 'error'; continue; }
        it.videoId = r.video_id;
        it.state = 'uploading'; it.progress = 0; redraw();
        try {
          const v = await api.upload(r.video_id, it.file, {
            name: it.name,
            description: it.meta,
            start_at: it.startAt ? it.startAt.toISOString() : null,
            is_ptz: false,
          }, (p) => { it.progress = p; drawList(); });
          it.state = 'done';
          // Süreyi backend ffprobe ile okudu — AVI dahil her formatta gelir
          if (v && v.duration_ms) it.durationMs = v.duration_ms;
          redraw();
        } catch (e) {
          it.state = 'error'; it.error = e.message; redraw();
          toast(`${it.name}: ${e.message}`, 'err', 6000);
        }
      }
      toast('Upload complete', 'ok');
      // yeni grup sol ağaçta ve Analysis ekranında hemen görünsün
      const lastId = todo[todo.length - 1].videoId;
      if (lastId) await waitForVideoReady(lastId); else await refreshGroups();
      mount(sidebar, treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
    } catch (e) {
      toast('Upload failed: ' + e.message, 'err', 6000);
    }
  }

  async function doAnalyze() {
    /* Birleştirilmişse tek bir video_id var — her parça için ayrı ayrı
       analiz kuyruğa almak 409 yağmuru üretirdi. */
    const ready = UP.mergedId
      ? [{ videoId: UP.mergedId, name: UP.collName.trim() || 'merged' }]
      : UP.items.filter((i) => i.state === 'done' && i.videoId);
    if (!ready.length) return toast('Upload the files first', 'warn');
    let queued = 0;
    const clash = [];
    for (const it of ready) {
      try { await api.analyze(it.videoId, {}); queued++; } catch (e) {
        // 409 = bu video için iptal edilmemiş bir kayıt zaten var
        // (succeeded dahil). Sessizce başarı saymak yanıltıcı olur.
        if (e.status === 409) clash.push(it);
        else toast(`${it.name}: ${e.message}`, 'err', 6000);
      }
    }
    if (queued) toast(`${queued} job(s) queued`, 'ok');
    if (clash.length) askReanalyze(clash.map((i) => i.videoId),
      clash.map((i) => i.name));
    queueTick();
  }

  /* ---- iskelet ---------------------------------------------------------- */

  const fileInput = el('input', {
    type: 'file', accept: 'video/*,.avi,.mp4,.mkv,.mov', multiple: true,
    style: { display: 'none' },
    onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; },
  });

  const drop = el('div.updrop', {
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault(); drop.classList.remove('over');
      addFiles([...e.dataTransfer.files].filter((f) => f.size > 0));
    },
    onclick: () => fileInput.click(),
  },
    el('div', { style: { fontSize: '22px' } }, '⬇'),
    el('div', {}, 'Drop video files here'),
    el('div', { class: 'tiny muted' }, 'or click to browse · multiple files supported'));

  mount(stage,
    el('div.panel', {},
      el('div.panel-h', {}, 'Upload & Analysis', el('span.grow'),
        !live ? el('span', { class: 'tiny', style: { color: '#fbbf24' } },
          'MOCK mode — upload only works in LIVE') : null),
      el('div.panel-b', { style: { display: 'grid', gap: '12px' } },
        el('div.row', { style: { gap: '8px' } },
          el('span', { class: 'tiny muted', style: { width: '110px' } },
            'Collection Name'),
          el('input.input', {
            placeholder: 'e.g. Gwangmyeong Stn · 2026-08-13',
            value: UP.collName,
            oninput: (e) => { UP.collName = e.target.value; },
          }),
          el('button.btn.sm', { onclick: () => fileInput.click() }, '+ Add files'),
          /* Sürükleyerek bozulan sırayı tek tıkla toparlar; otomatik dizilim
             kapandıysa yeniden açar. */
          el('button.btn.sm.ghost', {
            title: 'Lay all clips end to end, removing gaps and overlaps',
            onclick: () => {
              if (!UP.items.length) return toast('No files yet', 'warn');
              arrangeSequential();
              redraw();
              toast('Clips arranged end to end', 'ok', 2000);
            },
          }, '⇥ Auto arrange'),
          el('button.btn.sm.ghost', {
            title: 'Resolve overlaps by trimming the head of the later clip',
            onclick: () => {
              const L = layoutUpload(UP.items);
              if (!L || !L.overlapMs) return toast('No overlaps', 'ok', 1800);
              const { fixed, dropped } = trimOverlaps();
              redraw();
              toast(`Trimmed ${fixed} clip(s)`
                + (dropped ? ` · ${dropped} fully covered, left as is` : ''),
                'ok', 3500);
            },
          }, '✂ Trim overlaps'),
          fileInput),

        /* Örnekleme penceresi BACKEND ayarı — buradan değiştirilemiyor,
           yalnızca zaman çizgisindeki yeşil bantları doğru çizebilmek için
           biliniyor. Backend değeri değişirse buradan güncellenir. */
        el('div.row', { style: { gap: '8px', alignItems: 'center' } },
          el('span', { class: 'tiny muted' },
            'VLM sampling (backend setting)'),
          el('input.input', {
            type: 'number', min: 1, step: 1, value: UP.vlmWindow,
            style: { width: '62px' },
            title: 'Window length the VLM looks at (vlm_segment_duration_seconds)',
            onchange: (e) => {
              UP.vlmWindow = Math.max(1, +e.target.value || 10);
              localStorage.setItem('up.vlmWindow', UP.vlmWindow);
              redraw();
            },
          }),
          el('span', { class: 'tiny muted' }, 's every'),
          el('input.input', {
            type: 'number', min: 1, step: 1, value: UP.vlmInterval,
            style: { width: '62px' },
            title: 'Sampling interval (vlm_segment_interval_seconds)',
            onchange: (e) => {
              UP.vlmInterval = Math.max(1, +e.target.value || 60);
              localStorage.setItem('up.vlmInterval', UP.vlmInterval);
              redraw();
            },
          }),
          el('span', { class: 'tiny muted' }, 's')),

        /* Birleştirme kipi. Varsayılan AÇIK: kullanıcı Upload ekranında
           parçaları tek bir zaman çizgisine dizdiğinde beklentisi tek bir
           kayıt elde etmek. Kapatılırsa her parça ayrı video_id alır. */
        el('div.row', { style: { gap: '8px', alignItems: 'flex-start' } },
          el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } },
            el('input', {
              type: 'checkbox', checked: UP.merge,
              onchange: (e) => { UP.merge = e.target.checked; drawMergeNote(); },
            }),
            el('span', {}, 'Merge into a single video')),
          mergeNote),

        tlBox,
        infoBox,
        drop,
        listBox,

        el('div.row', { style: { gap: '8px' } },
          el('button.btn', { onclick: doUpload }, '⬆ Upload'),
          el('button.btn.ghost', { onclick: doAnalyze }, '▶ Run analysis'),
          el('span.grow'),
          el('button.btn.sm.ghost', {
            onclick: () => {
              UP.items = []; UP.groupId = null; UP.sel = 0;
              UP.mergedId = null;
              releaseThumbs();
              redraw();
            },
          }, 'Clear')))),
    // İş yönetimi ayrı bir sekme değil — burada, kendiliğinden tazelenerek
    el('div.panel', { style: { marginTop: '12px' } },
      el('div.panel-h', {}, 'Analysis queue',
        el('span.grow'),
        el('span', { class: 'tiny muted', id: 'qnote' }, '')),
      el('div.panel-b', { id: 'queuebox' },
        el('div', { class: 'tiny muted' }, 'loading…'))));

  /* ---- kuyruk şeridi: devam eden iş varken 3 sn'de bir tazelenir -------- */
  let qAlive = true;
  onLeave(() => { qAlive = false; });

  async function queueTick() {
    if (!qAlive) return;
    const box = document.getElementById('queuebox');
    if (!box) return;
    let rows = [];
    try { rows = (await api.jobs()).items; } catch { /* geçici */ }
    const vids = store.get('groups').flatMap((g) => g.cameras || []);
    const nameOf = (id) => (vids.find((v) => String(v.id) === String(id))
      || {}).name || `video ${id}`;
    const COLOR = { completed: 'var(--ok)', running: 'var(--busy)',
                    failed: '#f87171', queued: 'var(--tx-2)',
                    canceled: 'var(--tx-2)' };

    mount(box, rows.length ? rows.slice(0, 12).map((j) => el('div.row', {
      style: { gap: '10px', padding: '4px 0' },
    },
      el('span', { class: 'mono tiny', style: { width: '46px' } }, j.job_id),
      el('span', { style: { flex: 1 } }, nameOf(j.video_id)),
      j.status === 'running'
        ? el('div.progline', { style: { width: '110px' } },
          el('i', { class: 'indet' }))
        : el('span', { class: 'tiny muted' },
          j.duration_sec ? `${j.duration_sec}s` : ''),
      el('span', {
        class: 'tiny', style: { color: COLOR[j.status] || 'var(--tx-1)',
                                fontWeight: 700, width: '80px' },
      }, j.status),
      j.error ? el('button.btn.sm.ghost', {
        onclick: () => modal({ title: 'Error · ' + j.job_id,
                               body: el('div.codeblock', {}, j.error) }),
      }, 'error') : null))
      : el('div', { class: 'tiny muted' }, 'no analysis jobs yet'));

    const busy = rows.some((j) => j.status === 'running' || j.status === 'queued');
    const note = document.getElementById('qnote');
    if (note) note.textContent = busy ? 'auto-refreshing…' : '';
    if (qAlive) setTimeout(queueTick, busy ? 3000 : 10000);
  }
  queueTick();

  mount(side, sideBox);
  redraw();
}
