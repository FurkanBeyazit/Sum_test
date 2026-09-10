/* ============================================================================
   ui.js — ekranlar arasi paylasilan kabuk
   ----------------------------------------------------------------------------
   Ust cubuk, sol agac, filtre paneli ve ekran omru (onLeave/runCleanup).
   Hicbir ekrani import etmez — gezinme location.hash uzerinden oldugu icin
   bagimlilik grafigi tek yonlu kalir: app.js -> screens/* -> ui.js -> core.js
   ========================================================================= */

import {
  FEATURES, el, clear, store, api, t, toast, modal, hms, roughDur
} from './core.js';
import { GroupClock } from './groupclock.js';

export const ROOT = () => document.getElementById('app');

/* ==========================================================================
   Son bakılan video
   --------------------------------------------------------------------------
   Object ile Analysis aynı kaydın iki görünümü; sekmeye basınca kullanıcı
   "aynı video, öteki ekran" bekliyor. Sekme bağlantıları katalogdaki İLK
   videoya gidiyordu, yani her geçişte en son yüklenen kayda düşülüyordu.
   Ekranlar açılırken hangi videoya baktığını buraya yazıyor, üst çubuk da
   bağlantıları oradan kuruyor. sessionStorage: sekme kapanınca unutulsun.
   ========================================================================== */
export function rememberVideo(id) {
  try { sessionStorage.setItem('lastVideo', String(id)); } catch {}
}
function lastVideo() {
  try { return sessionStorage.getItem('lastVideo'); } catch { return null; }
}
let CLEANUP = [];
export function onLeave(fn) { CLEANUP.push(fn); }
export function runCleanup() { CLEANUP.forEach(f => { try { f(); } catch {} }); CLEANUP = []; }

/**
 * Ekranların ortak yoklama döngüsü.
 *
 * Dört ekran bunu ayrı ayrı yazıyordu ve hepsi aynı iki şeyi kaçırıyordu:
 *
 *   1. SEKME ARKA PLANDAYKEN DE İSTEK ATIYORLARDI. Açık bırakılmış bir
 *      sekme gece boyunca backend'i yokluyor, log dosyası şişiyordu.
 *      Burada `document.hidden` iken istek atlanıyor, sekmeye dönülünce
 *      hemen bir tur koşuluyor — kullanıcı bayat veri görmüyor.
 *   2. Bir tur bitmeden bir sonraki başlayabiliyordu (`setInterval`).
 *      Zincirleme `setTimeout` ile her tur bir öncekinin BİTİŞİNDEN sonra
 *      planlanıyor; backend yavaşlarsa istekler üst üste binmiyor.
 *
 * @param {() => any} fn          her turda çağrılır (async olabilir)
 * @param {number|() => number} every  bekleme (ms) — son turun sonucuna göre
 *                                     değişebilsin diye fonksiyon da olabilir
 */
export function startPolling(fn, every) {
  let alive = true;
  let timer = null;
  const wait = () => (typeof every === 'function' ? every() : every);

  const tick = async () => {
    if (!alive) return;
    if (document.hidden) {           // görünmüyorsa istek yok, sadece bekle
      timer = setTimeout(tick, 5000);
      return;
    }
    try { await fn(); } catch { /* ekran kendi hatasını gösterir */ }
    if (alive) timer = setTimeout(tick, wait());
  };

  const onVisible = () => {
    if (!alive || document.hidden) return;
    clearTimeout(timer);
    tick();                          // sekmeye dönüldü — hemen tazele
  };
  document.addEventListener('visibilitychange', onVisible);

  tick();
  onLeave(() => {
    alive = false;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  });
}

/* ==========================================================================
   Canlı iş rozeti + katalog tazeleme
   --------------------------------------------------------------------------
   İki ayrı şikâyetin tek kaynağı var: analizin ne durumda olduğunu YALNIZCA
   Manage ekranı biliyordu.

     1. Başka bir ekrandayken işin bittiğini görmüyorsun.
     2. Yükleyip analize verdikten sonra sol ağaç kendini hiç güncellemiyor;
        kayıt "analyzing" olarak kalıyor ve ancak F5 ile yeşile dönüyordu.

   Buradaki yoklayıcı UYGULAMA ÖMRÜ boyunca yaşıyor — ekranla değil. Ekran
   değişince duran bir yoklayıcı tam da aradığımız şeyi kaçırırdı: iş sen
   Object'e geçtikten sonra bitiyor.

   Sıklık işe göre: çalışan iş varken 5 sn, boştayken 30 sn. Sekme arka
   plandaysa istek atılmıyor (bkz. startPolling'deki aynı gerekçe).

   Bir iş "running/queued"tan "completed"a geçtiğinde:
     · katalog yeniden çekiliyor (`api.invalidate` + `api.groups`)
     · `catalog:changed` olayı atılıyor — ağaç kendini yerinde yeniliyor
     · ekranda bir kart çıkıyor: doğrudan Object ya da Analysis
   ========================================================================== */

/* Son bilinen kuyruk durumu. `topbar()` her yönlendirmede yeniden kuruluyor;
   rozet buradan çiziliyor ki yeni çubuk da doğru sayıyla açılsın. */
const JOBS = { busy: 0 };
let jobWatchOn = false;

/** Üst çubuktaki rozet düğümü — içeriğini `paintJobPill` yazıyor. */
function jobPill() {
  const n = el('a.jobpill.off', { id: 'jobpill', href: '#/manage' });
  paintJobPill(n);
  return n;
}

function paintJobPill(node) {
  const n = node || document.getElementById('jobpill');
  if (!n) return;
  clear(n);
  n.classList.toggle('off', !JOBS.busy);
  if (!JOBS.busy) { n.title = 'No analysis running'; return; }
  n.title = `${JOBS.busy} analysis job(s) in the queue — open Manage`;
  n.append(el('i'), el('span', {}, `${JOBS.busy} analyzing`));
}

/** Katalog yeniden çekilir ve ağaca haber verilir. */
async function refreshCatalog() {
  try {
    api.invalidate();
    const g = await api.groups();
    store.set({ groups: g.groups });
    window.dispatchEvent(new CustomEvent('catalog:changed'));
  } catch { /* geçici hata — bir sonraki turda yeniden denenecek */ }
}

/**
 * Biten iş kartı.
 *
 * Sıradan `toast` yetmiyor: kullanıcının buradan gideceği bir yer var ve
 * kaybolan bir bildirim o yeri götürüyor. Kart kendiliğinden kapanmıyor.
 */
function doneCard(name, videoId) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div#toasts'); document.body.append(host); }
  const card = el('div.toast.ok', { style: { minWidth: '300px' } },
    el('div', { style: { flex: 1 } },
      el('div', { style: { fontWeight: 700, marginBottom: '6px' } },
        '✓ Analysis complete'),
      el('div', { class: 'tiny muted', style: { marginBottom: '8px' } }, name),
      el('div.row', { style: { gap: '6px' } },
        el('a.btn.sm.pri', { href: `#/objects/${videoId}` }, 'Objects'),
        el('a.btn.sm.ghost', { href: `#/single/${videoId}` }, 'Analysis'))),
    el('button.iconbtn', { title: 'Dismiss', onclick: () => card.remove() }, '✕'));
  host.append(card);
}

/**
 * Kuyruk yoklayıcısını başlatır. app.js açılışta BİR KEZ çağırıyor.
 */
export function startJobWatch() {
  if (jobWatchOn) return;
  jobWatchOn = true;

  /* video_id → son görülen durum. İlk turda bildirim YOK: açılışta zaten
     bitmiş işleri "az önce bitti" diye duyurmak gürültüden ibaret. */
  let seen = null;
  /* Tek zamanlayıcı. Sekmeye dönüşte elle bir tur koşuyoruz; beklemedeki
     turu iptal etmezsek iki döngü paralel gider ve sıklık ikiye katlanır. */
  let timer = null;
  const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };

  const tick = async () => {
    clearTimeout(timer);
    if (document.hidden) { schedule(15000); return; }

    let rows = [];
    try { rows = (await api.jobs()).items || []; }
    catch { schedule(30000); return; }

    const busy = rows.filter(
      (j) => j.status === 'running' || j.status === 'queued');
    JOBS.busy = busy.length;
    paintJobPill();

    if (seen) {
      const vids = store.get('groups').flatMap((g) => g.cameras || []);
      const nameOf = (id) => (vids.find((v) => String(v.id) === String(id))
        || {}).name || `video ${id}`;
      const fresh = rows.filter((j) => {
        const was = seen.get(String(j.video_id));
        return (was === 'running' || was === 'queued')
          && (j.status === 'completed' || j.status === 'failed');
      });
      if (fresh.length) {
        await refreshCatalog();
        for (const j of fresh) {
          if (j.status === 'failed') {
            toast(`${nameOf(j.video_id)} · analysis failed`
              + (j.error ? ': ' + j.error : ''), 'err', 8000);
          } else {
            doneCard(nameOf(j.video_id), j.video_id);
          }
        }
        /* Yükleme ekranında oturuyorsan ve kuyrukta bekleyen kalmadıysa
           doğrudan sonuca geçiyoruz: o ekranda bekleyecek başka işin yok.
           Başka ekranda YÖNLENDİRME YOK — video izlerken ekranın altından
           kayması, kazandırdığı tıktan çok daha rahatsız edici. */
        const last = fresh.filter((j) => j.status === 'completed').pop();
        if (last && !busy.length && location.hash.startsWith('#/upload')) {
          location.hash = `#/objects/${last.video_id}`;
        }
      }
    }
    seen = new Map(rows.map((j) => [String(j.video_id), j.status]));
    schedule(busy.length ? 5000 : 30000);
  };

  tick();
  /* Sekmeye dönünce bekleme dolmasını bekleme — kullanıcı tam da o an
     "ne oldu" diye bakıyor. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

const STATUS_LABEL = {
  registered: 'Registered', uploading: 'Uploading', ready: 'Ready',
  analyzing: 'Analyzing', completed: 'Completed', failed: 'Failed',
  deleted: 'Deleted',
};
export const statusLabel = s => STATUS_LABEL[s] || s;

/* ==========================================================================
   Tek durum skalası
   --------------------------------------------------------------------------
   Aynı durum üç ekranda üç ayrı görünüyordu: Analysis başlığında `.badge`,
   Manage kuyruğunda `.mg-pill`, ağaçta yalnız bir nokta. Renkler de
   tutmuyordu — "analyzing" bir yerde sarı, bir yerde maviydi. Aşağıdaki
   eşleme TEK kaynak: hem video_status hem job_status buradan geçiyor.

   Beş ton var, daha fazlası ayırt edilemiyor:
     ok   bitti · run  sürüyor · warn dikkat · err hata · idle henüz değil
   ========================================================================= */
const STATUS_TONE = {
  completed: 'ok', analyzing: 'run', uploading: 'run', running: 'run',
  ready: 'idle', registered: 'idle', queued: 'idle', canceled: 'idle',
  deleted: 'idle', failed: 'err',
};
const statusTone = (s) => STATUS_TONE[s] || 'idle';

/**
 * Durum rozeti. Renk tek başına bilgi taşımıyor: nokta + metin + ton
 * birlikte, böylece renk ayrımı yapamayan bir operatör de okuyabiliyor.
 * @param {string} status  video_status ya da job_status
 * @param {string} [label] gösterilecek metin (varsayılan: İngilizce etiket)
 */
export function statusChip(status, label) {
  return el('span', { class: 'st ' + statusTone(status), title: status },
    el('i'), label || statusLabel(status));
}

/* ------------------------------------------------------------ iskelet ----
   Veri gelene kadar konulan yer tutucu. Boş bir panel "bozuk", parıldayan
   bir panel "geliyor" demek — tek eklemede en çok fark yaratan şey buydu.
   Sayı gerçek sonuç sayısı olmak zorunda değil; ızgaranın dolu görünmesi
   yeterli. */
export function skeletonCards(n = 12) {
  return Array.from({ length: n }, () => el('div.sk.card'));
}
export function skeletonRows(n = 4) {
  return el('div', { style: { padding: '10px 12px' } },
    Array.from({ length: n }, (_, i) => el('div.sk.row', {
      // Satırlar birebir aynı uzunlukta olunca desen görünüyor, veri değil.
      style: { width: [92, 78, 85, 70, 88][i % 5] + '%' },
    })));
}
/* ==========================================================================
   Oynatıcı çubuğu
   ==========================================================================
   TEK KAYNAK. Analiz ve Object ekranları aynı videoyu aynı biçimde
   oynatıyor; iki ayrı çubuk tutmanın tek sonucu ikisinin zamanla birbirinden
   ayrılmasıydı — Object tarafında hız seçici ve bindirme anahtarları hiç
   yoktu. Ekrana özel düğmeler `extra` ile ekleniyor.

   Bindirme anahtarları (kutu / iz / etiket) `FEATURES.bbox` kapalıyken hiç
   çizilmiyor: kapatınca iki ekrandan birden kalkarlar.
*/
export function playerControls(o) {
  const { duration = 0, seek, cur, overlay, videoEl,
          fullscreenOf, onSnapshot, extra = [] } = o;

  const scrub = el('div.scrub', {},
    el('div.track', {}, el('div.buf'), el('div.fill')),
    el('div.knob'));
  const tcode = el('span.tcode', {},
    el('b', {}, hms(0)), ' / ' + hms(duration));
  const btnPlay = el('button.iconbtn', { title: 'Play / pause' }, '▶');

  /* Üç bindirme anahtarı da aynı şey: overlay.opts'ta bir bayrağı çevir ve
     yeniden çiz. Video duraklamışken çizim döngüsü ilerlemediği için
     redraw() şart — yoksa düğme çalışır ama ekran değişmez. */
  const toggle = (title, glyph, key, id) => el('button.iconbtn', {
    title, class: 'on', id,
    onclick: (e) => {
      const on = e.currentTarget.classList.toggle('on');
      const ov = overlay && overlay();
      if (ov) { ov.opts[key] = on; ov.redraw(); }
    },
  }, glyph);

  const node = el('div.vctl', {},
    btnPlay,
    el('button.iconbtn', { title: 'Back 10s', onclick: () => seek(cur() - 10) }, '⟲'),
    el('button.iconbtn', { title: 'Forward 10s', onclick: () => seek(cur() + 10) }, '⟳'),
    tcode,
    scrub,
    el('select.select', {
      style: { width: '68px', padding: '4px 6px' },
      onchange: (e) => {
        const v = videoEl && videoEl();
        if (v) v.playbackRate = +e.target.value;
      },
    }, [0.25, 0.5, 1, 2, 4].map((v) =>
      el('option', { value: v, selected: v === 1 }, v + '×'))),
    FEATURES.bbox ? toggle('BBox', '▭', 'boxes', 'btnbox') : null,
    FEATURES.bbox ? toggle('Tracks', '⌇', 'trails') : null,
    FEATURES.bbox ? toggle('Labels', 'A', 'labels') : null,
    FEATURES.snapshot && onSnapshot
      ? el('button.iconbtn', { title: 'Snapshot', onclick: onSnapshot }, '📷')
      : null,
    ...extra,
    el('button.iconbtn', {
      title: 'Fullscreen',
      onclick: () => fullscreenOf && fullscreenOf().requestFullscreen?.(),
    }, '⛶'));

  return { node, btnPlay, scrub, tcode };
}

/**
 * İlerleme çubuğuna kayıt boşluklarını ve parça sınırlarını işler.
 *
 * Çubuk DUVAR EKSENİNDE (boşluklar yer kaplıyor), oynatıcı ise boşlukları
 * atlıyor. İşaretlenmezse kullanıcı çubuğun ortasında oynatmanın neden
 * birden 08:00'dan 12:00'a sıçradığını göremiyor — üstelik boşluğun içine
 * tıklayıp "video takıldı" sanıyor.
 *
 * Üç işaret var:
 *   .gapseg   boşluğun kendisi, taralı; dolgunun ÜSTÜNE çiziliyor ki
 *             oynatma oradan geçtikten sonra da boşluk olduğu okunsun
 *   .gapmark  boşluğun süresi (yalnızca sığdığında)
 *   .partsep  her parçanın başlangıcı; ipucunda tam saat aralığı
 *
 * @param {HTMLElement} scrub  playerControls()'un döndürdüğü çubuk
 * @param {object} clock       GroupClock — tek parçalıysa hiçbir şey yapmaz
 * @param {number} axis        eksenin toplam saniyesi (duvar)
 */
export function scrubSpans(scrub, clock, axis) {
  if (!scrub || !clock || !clock.multi || !(axis > 0)) return;
  const track = scrub.querySelector('.track');
  if (!track) return;
  const pc = (t) => (t / axis * 100) + '%';
  const hhmm = (t) => clock.clock(t).slice(0, 5);

  for (const g of clock.gaps) {
    const len = g.t1 - g.t0;
    const tip = `No recording · ${roughDur(len)} · ${hhmm(g.t0)} → ${hhmm(g.t1)}`;
    track.append(el('div.gapseg', {
      style: { left: pc(g.t0), width: pc(len) }, title: tip,
    }));
    // Rozet dar boşlukta okunmuyor, komşu parça etiketlerinin de üstüne biner.
    if (len / axis > 0.05) {
      scrub.append(el('div.gapmark', {
        style: { left: pc((g.t0 + g.t1) / 2) }, title: tip,
      }, roughDur(len)));
    }
  }

  clock.spans.forEach((s, i) => {
    scrub.append(el('div.partsep', {
      style: { left: pc(s.t0) },
      title: `${s.part.name} · ${hhmm(s.t0)}–${hhmm(s.t1)}`
        + ` (part ${i + 1}/${clock.spans.length})`,
    }));
  });
}

const SRC_ICON = { file: '▤', rtsp: '⦿', uploaded: '↑', archive: '▣' };

/* ==========================================================================
   Kabuk
   ========================================================================== */

export function topbar(active) {
  /* Tek veri kaynağı var, tek sekme listesi var. Analysis ve Object ekranları
     bir video id'si ister; katalog boşsa (hiç video yüklenmemişse) adresi boş
     bırakıyoruz, yönlendirici Home'a düşürüyor. */
  const cams = store.get('groups').flatMap((g) => g.cameras || []);
  /* Son bakılan kayıt hâlâ katalogdaysa sekmeler onu açsın; yoksa ilk kayıt. */
  const seen = lastVideo();
  const first = (cams.find((c) => String(c.id) === String(seen)) || cams[0]
                 || {}).id;
  /* Sıra: Object, Analysis'ten ÖNCE. Kullanıcı önce "kim vardı" diye bakıp
     sonra o kişinin olaylarına iniyor; ekranların sırası bu akışı izlesin.

     Manage ve System sekme çubuğundan çıktı — ikisi de günlük iş değil,
     ayar. Manage sağdaki dişliye taşındı; System'in zaten karşılığı yok. */
  const tabs = [
    ['home', 'Home', '#/home'],
    ['upload', 'Upload & Analysis', '#/upload'],
    ...(FEATURES.objects ? [['objects', 'Object', `#/objects/${first || ''}`]] : []),
    ['single', 'Analysis', `#/single/${first || ''}`],
  ];
  return el('div.topbar',
    // Logo veya program adına tıklayınca ana sayfaya dönülür
    el('a.brand', {
      href: '#/home', style: { textDecoration: 'none', color: 'inherit' },
    }, el('span.logo', {}, '▣'), el('span', {}, 'Logo')),
    el('nav.navtabs', {}, tabs.map(([k, label, href]) =>
      el('a', { href, class: active === k ? 'on' : '' }, label))),
    el('div.grow'),
    /* Kuyrukta iş varken görünüyor, yoksa hiç yer kaplamıyor. Manage'e
       gidiyor: sayı "bir şey oluyor" der, ayrıntı orada. */
    jobPill(),
    el('div.row', { class: 'tiny muted' },
      el('span', { id: 'srvstat' }, '● Connected')),
    /* Manage: sekme değil, sağ köşede dişli. Grup/video düzenlemek günde bir
       kez yapılan bir iş; sekme çubuğunda her zaman görünmesi çalışma
       ekranlarıyla aynı ağırlıkta olduğu izlenimi veriyordu. */
    el('a.iconbtn.gear', {
      href: '#/manage', title: 'Manage — groups, videos, analysis queue',
      class: active === 'manage' ? 'iconbtn gear on' : 'iconbtn gear',
    }, '⚙'),
    el('div.row', { style: { gap: '6px', marginLeft: '4px' } },
      el('span', { class: 'tiny' }, '👤'),
      el('span', { class: 'tiny' }, (store.get('user') || {}).username || 'admin'),
      el('button.btn.sm.ghost', {
        onclick: () => { localStorage.removeItem('tok'); location.hash = '#/login'; },
      }, t('logout'))));
}

/** modal() üzerine ince bir onay sarmalayıcı — true/false ile çözülür. */
export function confirmModal(title, text, okLabel = '계속') {
  return new Promise((resolve) => {
    let close = () => {};
    const answer = (v) => { close(); resolve(v); };
    close = modal({
      title,
      body: el('div', { style: { lineHeight: 1.7 } }, text),
      footer: [
        el('button.btn.ghost', { onclick: () => answer(false) }, '취소'),
        el('button.btn.pri', { onclick: () => answer(true) }, okLabel),
      ],
    });
  });
}

/* --------------------------------------------------------------- ağaç ---- */

/* ==========================================================================
   Zincir tek satır
   --------------------------------------------------------------------------
   Bir gruba aynı kameranın farklı saatlerdeki kayıtları yükleniyor:
   07:00-08:00, 12:00-13:00, 19:00-20:00. Oynatıcı bunları zaten TEK kayıt
   gibi gösteriyor (bkz. groupclock.js) — zaman çizgisi üçünü de, aradaki
   boşluklarla birlikte çiziyor. Ağaçta üç ayrı satır durunca kullanıcı üç
   ayrı video sanıyor, hangisine tıklarsa tıklasın aynı ekseni görüyordu.

   Artık zincir tek satır: adı, parça sayısı ve kapladığı gerçek saat
   aralığı. Tıklayınca zincirin BAŞINDAN açılıyor. Parçalara tek tek erişmek
   gerekirse Manage ekranı hepsini ayrı ayrı listelemeye devam ediyor.
   ========================================================================== */
function chainOf(cams) {
  const parts = cams
    .filter((c) => c.start_time && c.duration > 0)
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  if (parts.length < 2) return null;
  const clock = new GroupClock(parts.map((p) => ({
    id: p.id, name: p.name, startMs: Date.parse(p.start_time), dur: p.duration,
  })));
  if (!clock.multi) return null;
  /* Zincirin durumu en zayıf halkası: biri hâlâ analiz ediliyorsa zincir
     "analyzing", hepsi bittiyse "completed". Tek bir parça bitmişken satırı
     yeşil göstermek, olmayan olayları vaat etmek olurdu. */
  const st = parts.every((p) => p.status === 'completed') ? 'completed'
    : parts.find((p) => p.status === 'analyzing') ? 'analyzing'
      : parts.find((p) => p.status === 'failed') ? 'failed'
        : parts[0].status;
  return { parts, clock, status: st, head: parts[0], rest: cams.filter(
    (c) => !parts.includes(c)) };
}

export function treePanel(activeVideoId, onPick) {
  const body = el('div.panel-b');
  const p = el('div.panel', {},
    el('div.panel-h', {}, t('videoList')),
    el('div', { style: { padding: '8px 9px' } },
      el('div.search-wrap', {},
        el('input.input', {
          placeholder: 'Search groups', oninput: (e) => filter(e.target.value),
        }),
        el('span.ico', {}, '⌕'))),
    body);

  const open = JSON.parse(localStorage.getItem('treeopen') || '["G1"]');
  let groups = store.get('groups');
  let lastQ = '';

  function filter(q) { render(q.toLowerCase()); }

  /* Analiz bitince ağaç kendini YERİNDE yeniliyor: yeniden yönlendirme yok,
     yani oynayan video duruyor, açık paneller açık kalıyor. Olayı kuyruk
     yoklayıcısı atıyor (bkz. startJobWatch). Arama kutusuna yazılmış metin
     de korunuyor — tazeleme kullanıcının yazdığını silmemeli. */
  const onCatalog = () => { groups = store.get('groups'); render(lastQ); };
  window.addEventListener('catalog:changed', onCatalog);
  onLeave(() => window.removeEventListener('catalog:changed', onCatalog));

  /** Tek kayıt satırı — zincirin parçası olmayanlar için. */
  function camRow(c, on) {
    const usable = c.status === 'completed';
    const row = el('div.tree-cam', {
      class: [on ? 'on' : '', usable ? '' : 'disabled'].join(' '),
      title: `${c.name} · ${c.place_ko}\n${statusLabel(c.status)}`
        + (c.error ? '\n⚠ ' + c.error : '')
        + `\nsource: ${c.source_type}`
        + (c.has_proxy ? ' · proxy ✓' : ' · proxy ✗'),
    },
      el('span', { class: 'dot ' + c.status }),
      el('span.srcicon', {}, SRC_ICON[c.source_type] || '·'),
      el('span.nm', {}, c.name),
      c.real_data ? el('span.badge.real', { class: 'tiny' }, 'REAL') : null,
      el('span.pl', {}, c.place_ko || ''));
    row.onclick = () => {
      if (!usable) {
        toast(c.error ? c.error
          : `${c.name}: ${statusLabel(c.status)} — no analysis result yet.`,
          c.status === 'failed' ? 'err' : 'warn', 4200);
        return;
      }
      onPick(c);
    };
    return row;
  }

  /** Zincir satırı — birden çok parça, tek kayıt gibi. */
  function chainRow(ch, on) {
    const usable = ch.parts.some((x) => x.status === 'completed');
    const row = el('div.tree-cam.chain', {
      class: [on ? 'on' : '', usable ? '' : 'disabled'].join(' '),
      title: `${ch.clock.summary()}\n`
        + ch.parts.map((x, i) => `${i + 1}. ${x.name} · `
          + `${ch.clock.clock(ch.clock.wallSec(x.id))} · `
          + statusLabel(x.status)).join('\n'),
    },
      el('span', { class: 'dot ' + ch.status }),
      el('span.srcicon', {}, '⛓'),
      el('span.nm', {}, ch.head.name),
      el('span.badge.parts', { class: 'tiny' }, `${ch.parts.length}p`),
      el('span.pl', {}, ch.clock.range()));
    row.onclick = () => {
      if (!usable) {
        toast(`${ch.parts.length} parts — no analysis result yet.`,
          'warn', 4200);
        return;
      }
      /* Zincirin başından açılıyor: eksen zaten tamamını kapsıyor, ilk
         parçadan başlamak "kaydın başı" demek. */
      onPick(ch.head);
    };
    return row;
  }

  /**
   * Gruplari koleksiyonlarina gore bolumler.
   *
   * Koleksiyon YENI ve istege bagli: bir grup hicbir koleksiyonda olmayabilir.
   * Bu yuzden basliklar ancak gercekten koleksiyon varsa ciziliyor — hicbiri
   * yoksa agac eskisi gibi duz bir grup listesi olarak kaliyor ve
   * kullanicinin alistigi gorunum degismiyor.
   */
  function sections(list) {
    const cols = store.get('collections') || [];
    if (!cols.length) return [{ col: null, groups: list }];
    const byCol = new Map(cols.map((c) => [String(c.id), []]));
    const loose = [];
    for (const g of list) {
      const k = g.collection_id == null ? null : String(g.collection_id);
      if (k != null && byCol.has(k)) byCol.get(k).push(g);
      else loose.push(g);
    }
    const out = cols
      .filter((c) => byCol.get(String(c.id)).length)
      .map((c) => ({ col: c, groups: byCol.get(String(c.id)) }));
    /* Koleksiyonsuz gruplar EN ALTTA ve basliksiz degil: "Ungrouped" diye
       yaziyor, yoksa koleksiyon basliklarindan sonra gelen gruplar son
       koleksiyona aitmis gibi okunuyor. */
    if (loose.length) out.push({ col: { id: '_', name: 'Ungrouped' }, groups: loose });
    return out;
  }

  function render(q = '') {
    lastQ = q;
    clear(body);
    const tree = el('div.tree');
    for (const sec of sections(groups)) {
      if (sec.col) {
        const real = sec.col.id !== '_';
        /* Başlık artık tıklanabilir: koleksiyon ekranına girmenin yolu
           burası. Sekme çubuğuna koymadık — koleksiyon her zaman var olan
           bir şey değil, ağaçta ise ancak gerçekten varsa görünüyor. */
        tree.append(el('div.tree-col', {
          class: real ? 'click' : '',
          title: real
            ? `Collection #${sec.col.id}`
              + (sec.col.desc ? ` — ${sec.col.desc}` : '')
              + '\nOpen all of its groups on one timeline'
            : 'Groups that are not in any collection',
          onclick: real
            ? () => { location.hash = `#/collection/${sec.col.id}`; }
            : null,
        },
          el('span', {}, real ? '🗂' : '·'),
          el('span.grow', {}, sec.col.name),
          real ? el('span.gsub', {}, `${sec.groups.length} ▸`)
            : el('span.gsub', {}, String(sec.groups.length))));
      }
      for (const g of sec.groups) {
        const cams = g.cameras.filter(c =>
          !q || c.name.toLowerCase().includes(q) ||
          (c.place_ko || '').includes(q) || g.name.toLowerCase().includes(q));
        if (q && !cams.length) continue;
        const ch = chainOf(cams);
        const shown = ch ? 1 + ch.rest.length : cams.length;
        const isOpen = open.includes(g.id) || !!q;
        const gh = el('div.tree-group', { class: isOpen ? 'open' : '' },
          el('span.caret', {}, '▶'),
          el('span', {}, '📁'),
          el('span.grow', {}, g.name),
          el('span.gsub', {}, `${shown}`));
        gh.onclick = () => {
          const i = open.indexOf(g.id);
          i >= 0 ? open.splice(i, 1) : open.push(g.id);
          localStorage.setItem('treeopen', JSON.stringify(open));
          render(q);
        };
        tree.append(gh);
        if (g.name_ko) {
          gh.title = `${g.name} · ${g.name_ko}\n${g.desc || ''}`;
        }
        if (!isOpen) continue;

        const same = (c) => String(activeVideoId) === String(c.id);
        /* İlerleme çubuğu satırın hemen ALTINDA kalmalı — hangi kaydın
           analiz edildiği ancak öyle okunuyor. */
        const prog = (c) => (c.status === 'analyzing'
          ? tree.append(el('div.mini-prog', {},
            el('i', { style: { width: (c.progress || 0) + '%' } })))
          : null);
        const putCam = (c) => { tree.append(camRow(c, same(c))); prog(c); };

        if (ch) {
          /* Hangi parçadaysa zincir satırı vurgulu — kullanıcı üçüncü parçayı
             izlerken de listede kendini bulabilsin. */
          tree.append(chainRow(ch, ch.parts.some(same)));
          for (const c of ch.parts) prog(c);
          for (const c of ch.rest) putCam(c);
        } else {
          for (const c of cams) putCam(c);
        }
      }
    }
    body.append(tree);
  }
  render();
  return p;
}

/**
 * Zaten analiz edilmiş videoyu yeniden analiz etmek isteyip istemediğini
 * sorar. Backend `succeeded` kaydını da çakışma sayıp 409 döndüğü için
 * önce kuyruk kaydını silmek gerekiyor — bu, sonuç dosyasını silmez ama
 * mevcut sonuçların yerini yenisi alır.
 */
export function askReanalyze(videoIds, names, body, watch) {
  let close = () => {};
  close = modal({
    title: 'Already analyzed',
    body: el('div', { style: { display: 'grid', gap: '8px' } },
      el('div', {}, `${names.length} video(s) already have an analysis job:`),
      el('div', { class: 'tiny muted' }, names.join(', ')),
      el('div', { class: 'tiny muted' },
        'Re-running removes the queue record and starts over. '
        + 'Existing results stay on disk until the new run overwrites them.')),
    footer: [
      el('button.btn.ghost', { onclick: () => close() }, 'Keep results'),
      el('button.btn', {
        onclick: async () => {
          close();
          let n = 0;
          for (const id of videoIds) {
            try {
              /* body'yi AYNEN geçiriyoruz: 재요약 kutusuna yazılan prompt
                 buradan devam etmezse yeniden analiz eski prompt'la koşar
                 ve sonuç birebir aynı çıkar — kullanıcı "hiçbir şey olmadı"
                 diye görür. */
              const r = await api.analyze(id, body || {}, { force: true });
              n++;
              if (watch) watch(r, id);
            } catch (e) {
              toast(`video ${id}: ${e.message}`, 'err', 6000);
            }
          }
          if (n && !watch) toast(`${n} job(s) re-queued`, 'ok');
        },
      }, 'Re-analyze'),
    ],
  });
}

export function findCam(id) {
  for (const g of store.get('groups'))
    for (const c of g.cameras) if (c.id === id) return { ...c, group_name: g.name };
  return null;
}
