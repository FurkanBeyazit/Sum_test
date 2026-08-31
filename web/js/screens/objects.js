/* ==========================================================================
   Ekran: Object Page  (#/objects/:videoId)
   --------------------------------------------------------------------------
   Müşteri wireframe'i bire bir:

     tek tık   → nesne seçilir, video şeridin BAŞINA atlar ve oynar
     çift tık  → paletten sıradaki rengi alır
     Info      → renk paletinden elle seçim
     oynarken  → playhead bir şeridin üstündeyse o nesnenin bbox'ı vurgulanır
     sağ panel → Class / Gender / Color / Age / Accessory ile arama

   TIMELINE HER ZAMAN DOLU
   -----------------------
   Videodaki bütün track'lerin şeritleri baştan çiziliyor; hiçbir şeye
   tıklamadan "bu videoda kim ne zaman vardı" görünüyor. Çakışmayan aralıklar
   aynı satırı paylaşıyor (greedy interval packing), yoksa 236 track = 236
   satır olurdu.

   RENGİ KULLANICI VERİYOR
   -----------------------
   `track_id` kişi kimliği DEĞİL: aynı insan kadraja her girişinde yeni bir
   numara alıyor ve backend bunları birbirine bağlamıyor (Re-ID yok). Hangi
   iki kırpımın aynı kişi olduğunu ancak bakan insan biliyor. Bu yüzden renk
   ataması kullanıcıda: aynı rengi verdiği track'ler timeline'da tek bir
   kişinin izi gibi okunuyor.

   Renkler ARAMADAN BAĞIMSIZ. Süzgeç değişince renklendirilmiş nesneler ne
   unutuluyor ne de timeline'dan siliniyor — kullanıcının işaretlediği kişiler
   onun çalışma kümesi. "Female" arayıp birini boyayıp sonra "Male" aramak,
   ikisini aynı eksende karşılaştırmanın tek yolu.

   ŞERİDİN ANLAMI
   --------------
   Şerit gerçek aralık: backend `lifecycle` ile track'in giriş ve çıkış
   zamanını saniye cinsinden veriyor. Tıklamak şeridin başına götürüyor, yani
   çubukta gördüğün yer ile oynatılan yer aynı. Kırpımın çekildiği kareye
   (bestshot) Info panelindeki ayrı düğmeyle gidiliyor.
   ========================================================================== */

import {
  el, mount, clear, api, t, hms, dur, toast,
} from '../core.js';
import { VideoOverlay } from '../overlay.js';
import { Timeline } from '../timeline.js';
import { ROOT, onLeave, topbar, treePanel } from '../ui.js';

/* Kullanıcının kişi işaretlemek için kullandığı palet. Izgara kenarlığı,
   timeline şeridi ve video bbox'ı aynı rengi kullansın diye tek kaynak. */
const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#38bdf8',
  '#3b82f6', '#a855f7', '#f472b6', '#2dd4bf', '#f8fafc'];
const PREVIEW_COLOR = '#94a3b8';

/* Renklendirilmemiş track'ler de görünmeli ama öne çıkmamalı — sınıfına göre
   soluk bir ton. Kullanıcının verdiği renk bunların üstünde parlar. */
const CLASS_TINT = {
  person: '#3f5468', vehicle: '#4a4a5e', bicycle: '#41564a', other: '#3a4250',
};

/* --------------------------------------------------------- arama paneli ---
   Wireframe'deki satırlar, PAR modelinin gerçekten ürettiği değerlerle.
   Gözlenen sözlük (swin_v2_t):

     age: ["Adult"]   gender: ["Female"]   hair: ["Short"]
     upper: ["Any"]   lower: ["Black"]     Hat: false   Backpack: false

   Değerler baş harfi büyük geliyor; eşleştirme yine de büyük/küçük harf
   duyarsız. "Any" modelin kararsız kaldığı yer — süzgeçte yok. */
/* Etiketler dar: grup gerçekten tek sınıf tutuyor (bkz. backend.js
   CLASS_GROUP). "Vehicle" deyip içine otobüs/tren koymak, yanlış yakalamaları
   doğru sonuç gibi gösteriyordu. */
const CLASSES = [
  { v: 'vehicle', icon: '🚗', label: 'Car' },
  { v: 'person', icon: '🚶', label: 'Person' },
  { v: 'bicycle', icon: '🚲', label: 'Bicycle' },
];

const GENDERS = [
  { key: 'gender', v: 'Male', icon: '🚹', label: 'Male', tint: '#3b82f6' },
  { key: 'gender', v: 'Female', icon: '🚺', label: 'Female', tint: '#f472b6' },
];

const AGES = [
  { key: 'age', v: 'Child', icon: '🧒', label: 'Child' },
  { key: 'age', v: 'Adult', icon: '🧑', label: 'Adult' },
  { key: 'age', v: 'Senior', icon: '🧓', label: 'Senior' },
];

const EXTRAS = [
  { key: 'Hat', v: 'Hat', icon: '🧢', label: 'Hat' },
  { key: 'Backpack', v: 'Backpack', icon: '🎒', label: 'Backpack' },
];

/* Wireframe'deki 12 daire: 11 renk + "farketmez". Renk hem üst hem alt
   giysiye bakıyor — model ikisini ayrı veriyor ama kullanıcı "üstü mü altı
   mı" diye düşünmek zorunda kalmasın. */
const COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'SkyBlue', 'Blue',
  'Navy', 'Purple', 'White', 'Gray', 'Black'];
const COLOR_SWATCH = {
  Red: '#ef4444', Orange: '#f97316', Yellow: '#eab308', Green: '#22c55e',
  SkyBlue: '#38bdf8', Blue: '#3b82f6', Navy: '#1e3a8a', Purple: '#a855f7',
  White: '#f8fafc', Gray: '#94a3b8', Black: '#1e293b',
};

export async function screenObjects(videoId) {
  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(videoId, (c) => { location.hash = `#/objects/${c.id}`; }));
  mount(ROOT(), topbar('objects'), el('div.main', {}, sidebar, stage, rightbar));

  const video = await api.video(videoId);

  /* --------------------------------------------------------------- durum -- */
  /* Renk ataması ARAMADAN BAĞIMSIZ yaşıyor. `marks` rengi, `marked` de
     nesnenin kendisini tutuyor — süzgeç değişip nesne listeden düşse bile
     hem rengi hatırlansın hem timeline'daki şeridi kalsın. Kullanıcının
     işaretlediği kişiler onun çalışma kümesi; süzgeç onları saklamamalı. */
  const marks = new Map();     // object_id -> renk
  const marked = new Map();    // object_id -> nesne
  let objects = [];            // son arama sonucu
  let selected = null;         // tıklanan nesne (Info paneli + vurgu)
  let colorSeq = 0;
  let TL = null, overlay = null, videoEl = null;

  /* ------------------------------------------------------------ oynatıcı -- */
  const vstack = el('div.vstack');
  const ovlCanvas = el('canvas', { class: 'ovl hit' });
  const canPlay = video.playable ?? video.has_proxy;

  if (canPlay) {
    videoEl = el('video', {
      src: api.streamUrl(videoId), poster: api.posterUrl(videoId),
      preload: 'auto', playsinline: true,
    });
    // `.fill`: kuyuyu kapla, object-fit ile sığ — bkz. app.css `.vstack.fill`
    vstack.classList.add('fill');
    vstack.append(videoEl, ovlCanvas);
  } else {
    vstack.append(el('div.noproxy', {},
      el('div', { class: 'big' }, '⛶'),
      el('div', { class: 't' }, 'No playable proxy for this video'),
      el('div', { class: 'tiny' },
        video.proxy_stale
          ? 'Local proxy belongs to a different video — run '
            + 'python tools/proxy_cache.py --all'
          : 'Object markers still work on the timeline below.')));
  }

  const segTag = el('div.segtag');
  const vwell = el('div.vwell', {}, vstack, segTag);

  const btnPlay = el('button.iconbtn', { title: 'Play / pause' }, '▶');
  const scrub = el('div.scrub', {},
    el('div.track', {}, el('div.buf'), el('div.fill')), el('div.knob'));
  const tcode = el('span.tcode', {}, el('b', {}, hms(0)), ' / ' + hms(video.duration));
  const btnClear = el('button.btn.sm.ghost', {
    onclick: () => { marks.clear(); marked.clear(); colorSeq = 0; syncAll(); },
  }, 'Clear colours');
  const ctl = el('div.vctl', {}, btnPlay, scrub, tcode, btnClear);

  /* ------------------------------------------------------------ timeline -- */
  /* `.tlcanvas`: display:block + width:100%. Bu sınıf olmadan canvas 300px
     doğal genişliğinde kalıyor ve Timeline.resize() clientWidth'i oradan
     okuyup ekseni panelin soluna sıkıştırıyordu. */
  const tlCanvas = el('canvas.tlcanvas');
  const markCount = el('span', { class: 'tiny muted' }, '');
  const tlPanel = el('div.panel.op-tlpanel', {},
    el('div.panel-h', {}, 'Object tracking segment', el('span.grow'), markCount),
    el('div.panel-b.op-tlbody', {}, tlCanvas));

  /* ---------------------------------------------------------------- info --
     Panel iki kademeli. Kapalıyken tek satır: kırpım, kimlik/aralık, renk
     paleti ve oynatma düğmeleri. Tam tablo (confidence, PAR, olay sayısı)
     başlıktaki oktan açılıyor. Hepsi birden açıkken panel 260 piksel yer
     kaplıyordu ve altındaki videoya bakacak yer kalmıyordu. */
  let infoOpen = false;
  const infoToggle = el('button.btn.sm.ghost.op-more', {
    onclick: () => {
      infoOpen = !infoOpen;
      if (selected) showInfo(selected);
      infoToggle.textContent = infoOpen ? '▴ less' : '▾ details';
    },
  }, '▾ details');
  infoToggle.style.display = 'none';        // seçim yokken anlamsız

  const infoBody = el('div.panel-b.op-info', {},
    el('div', { class: 'tiny muted' },
      'Click an object to jump the video there. Double-click assigns a '
      + 'colour — give the same person the same colour across tracks.'));
  const infoPanel = el('div.panel.op-infopanel', {},
    el('div.panel-h', {}, 'Info', el('span.grow'), infoToggle), infoBody);

  const totalLbl = el('span', { class: 'tiny muted' }, '');
  mount(stage,
    el('div.hdr', {},
      el('div.hdr-top', {},
        el('div.crumb', {},
          el('span.par', {}, video.group_name),
          el('span.sep', {}, '›'),
          el('span.cur', {}, video.name),
          el('span.sep', {}, '›'),
          el('span.cur', {}, t('objects'))),
        el('div.grow'), totalLbl)),
    el('div.panel.op-player', {}, vwell, ctl), tlPanel, infoPanel);

  /* ------------------------------------------------------- sağ: nesneler -- */
  const grid = el('div.objgrid');
  const objPanel = el('div.panel.op-objpanel', {},
    el('div.panel-h', {}, 'Object', el('span.grow'),
      el('span', { class: 'tiny muted' }, 'bestshot')),
    el('div.panel-b', {}, grid));

  const search = buildSearch();
  mount(rightbar, objPanel, search.node);

  /* ========================================================== arama paneli */
  function buildSearch() {
    /* `sel.par` bir sözlük: { gender: 'Female', color: 'Black', … }.
       Renk hem `upper` hem `lower` alanında aranacağı için anahtarsız
       gidiyor; ötekiler kendi PAR anahtarıyla eşleşiyor. */
    const sel = { cls: 'person', par: {} };

    const toggle = (group, value) => {
      if (sel.par[group] === value) delete sel.par[group];
      else sel.par[group] = value;
      paintSel();
    };

    const iconBtn = (item, group, tint) => el('button.op-ico', {
      title: item.label,
      'data-group': group,
      'data-v': item.v,
      style: tint ? { color: tint } : {},
      onclick: () => {
        if (group === 'cls') { sel.cls = item.v; paintSel(); return; }
        toggle(group, item.v);          // aynısına tekrar basmak kaldırır
      },
    }, item.icon);

    const iconRow = (label, items, group, tinted) => el('div.op-arow', {},
      el('div.op-alabel', {}, label),
      el('div.op-avals', {},
        items.map((i) => iconBtn(i, group, tinted ? i.tint : null))));

    const colorRow = el('div.op-arow', {},
      el('div.op-alabel', {}, 'Color'),
      el('div.op-avals', {},
        COLORS.map((c) => el('button.op-sw', {
          title: c,
          'data-group': 'color', 'data-v': c,
          style: { background: COLOR_SWATCH[c] },
          onclick: () => toggle('color', c),
        })),
        el('button.op-sw.none', {
          title: 'Any colour',
          'data-group': 'color', 'data-v': '',
          onclick: () => { delete sel.par.color; paintSel(); },
        }, '✕')));

    /** Seçili olan tam opak, ötekiler soluk — wireframe'deki "darker" kuralı. */
    function paintSel() {
      for (const b of node.querySelectorAll('[data-group]')) {
        const g = b.dataset.group;
        const v = b.dataset.v;
        const on = g === 'cls'
          ? sel.cls === v
          : (v ? sel.par[g] === v : sel.par[g] === undefined);
        b.classList.toggle('on', on);
      }
    }

    const btn = el('button.btn.pri.wide', {
      onclick: () => loadObjects(sel),
    }, 'Search');

    const node = el('div.panel.op-searchpanel', {},
      el('div.panel-h', {}, 'search'),
      el('div.panel-b.op-sbody', {},
        iconRow('Class', CLASSES, 'cls'),
        iconRow('Gender', GENDERS, 'gender', true),
        colorRow,
        iconRow('Age', AGES, 'age'),
        iconRow('Accessory', EXTRAS, 'extra')),
      el('div.op-sfoot', {}, btn));

    paintSel();
    return { node, sel };
  }

  /* ============================================================ veri yükleme
     Backend'e giden tek çağrı. PAR etiketleri `par` dizisiyle gidiyor,
     sınıf süzgeci istemcide (uçta sınıf parametresi yok — bkz. backend.js). */
  async function loadObjects(sel) {
    /* Panel seçimleri → `{ key, value }` listesi.
       - gender/age → kendi PAR anahtarında aranır
       - color      → anahtarsız, yani upper VEYA lower'da
       - extra      → Hat / Backpack, boolean alanlar */
    const par = [];
    for (const [group, value] of Object.entries(sel.par)) {
      if (group === 'color') par.push({ key: null, value });
      else if (group === 'extra') par.push({ key: value, value });
      else par.push({ key: group, value });
    }
    const r = await api.objects(videoId, { limit: 500, cls: sel.cls, par });
    objects = r.items || [];
    totalLbl.textContent = par.length
      ? `${objects.length} match · ${r.returned} tracks scanned`
      : `${objects.length} ${sel.cls} · ${r.total} tracks total`;
    if (overlay) overlay.setTrackMeta(objects);
    /* `marked` renklendirme anındaki KOPYAYI tutuyor. O kopya lifecycle
       doldurulmadan önce alınmışsa aralığı eksik kalıyor ve timeline şeridi
       ile oynatma/vurgu birbirini tutmuyordu. Listede yeniden görünen her
       nesneyi taze hâliyle değiştiriyoruz. */
    for (const o of objects) if (marked.has(o.id)) marked.set(o.id, o);
    if (selected) {
      const fresh = objects.find((o) => o.id === selected.id);
      if (fresh) { selected = fresh; showInfo(fresh); }
    }
    syncAll();          // ızgarayı da timeline'ı da o çiziyor
    if (!objects.length) {
      toast(par.length
        ? 'No object matches these attributes'
        : `No ${sel.cls} track in this video`, 'warn');
    }
  }

  /* ------------------------------------------------------------- ızgara --- */
  function renderGrid() {
    clear(grid);
    if (!objects.length) {
      grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
        el('span', { class: 'big' }, '⌕'), 'No objects'));
      return;
    }
    for (const o of objects) {
      const mark = marks.get(o.id);
      const card = el('div.objcard', {
        class: selected && selected.id === o.id ? 'on' : '',
        title: `${o.label}\n${hms(o.t_first)}`
          + (o.has_range ? ` – ${hms(o.t_last)}` : '')
          + (o.conf != null ? `\nconf ${(o.conf * 100).toFixed(0)}%` : '')
          + (o.par_list.length
            ? '\n' + o.par_list.map((x) => x.value).join(' · ') : ''),
        style: mark ? { boxShadow: `inset 0 0 0 2px ${mark}` } : {},
      },
        el('img', {
          class: 'im', src: o.crop, loading: 'lazy',
          onerror: (e) => { e.target.style.visibility = 'hidden'; },
        }),
        mark ? el('div.pinflag', { style: { background: mark } }) : null,
        el('div', { class: 'cap' },
          /* Kartta aralığın kendisi: "ne zaman" sorusunun cevabı tek bir an
             değil, girip çıktığı pencere. */
          el('div', { class: 't' }, hms(o.t_first)),
          el('div', { class: 'nowrap' },
            o.has_range ? `${dur(o.t_last - o.t_first)} · ${o.class_name}`
              : `#${o.track_id} · ${o.class_name}`)));

      /* Tek tık / çift tık ayrımı: tarayıcı dblclick'ten önce click'i de
         gönderiyor, o yüzden tek tıkı geciktirip iptal edilebilir yapıyoruz. */
      let timer = null;
      card.onclick = () => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; pickObject(o); }, 220);
      };
      /* Çift tık = hızlı renk. Paletten sıradaki rengi verir; aynı kişiyi
         farklı track'lerde aynı renge boyamak isteyen kullanıcı Info
         panelindeki paletten seçer. */
      card.ondblclick = () => {
        clearTimeout(timer); timer = null;
        setMark(o, marks.has(o.id) ? null : PALETTE[colorSeq++ % PALETTE.length]);
      };
      grid.append(card);
    }
  }

  /* ----------------------------------------------------- seçim / renklendirme
     Track kimlikleri kişi kimliği DEĞİL: aynı insan kadraja her girişinde yeni
     bir track_id alıyor ve backend bunları birbirine bağlamıyor (Re-ID yok).
     Hangi iki kırpımın aynı kişi olduğunu ancak kullanıcı görerek biliyor —
     bu yüzden renk atamasını ona bırakıyoruz: aynı rengi verdiği track'ler
     timeline'da tek bir kişinin izi gibi okunuyor. */
  function pickObject(o) {
    selected = o;
    showInfo(o);
    syncAll();
    /* Şeridin BAŞINA. Bir süre bestshot anına atlıyordu: kırpımın çekildiği
       kare orası olduğu için mantıklı görünmüştü ama playhead şeridin
       ortasına düşüyor ve "çubuk başka yeri gösteriyor" hissi veriyordu.
       Bestshot'a atlamak isteyen Info panelindeki düğmeyi kullanır. */
    seek(o.t_first);
    if (videoEl) videoEl.play().catch(() => {});
  }

  function setMark(o, color) {
    if (color) { marks.set(o.id, color); marked.set(o.id, o); }
    else { marks.delete(o.id); marked.delete(o.id); }
    if (selected && selected.id === o.id) showInfo(o);
    syncAll();
  }

  function showInfo(o) {
    const mark = marks.get(o.id);
    const parText = o.par_exists
      ? Object.entries(o.attrs).map(([k, v]) => `${k}: ${v}`).join(' · ')
      : 'PAR did not run';
    clear(infoBody);
    infoToggle.style.display = '';

    /* Daima görünen şerit — kimlik, aralık, renk, oynat. */
    infoBody.append(el('div.op-inforow', {},
      el('img', {
        class: 'op-infoim', src: o.crop,
        style: mark ? { boxShadow: `0 0 0 2px ${mark}` } : {},
        onerror: (e) => { e.target.style.visibility = 'hidden'; },
      }),
      el('div.op-infomain', {},
        el('div.op-infoline', {},
          el('b', {}, `#${o.track_id}`),
          ` ${o.class_name} · `,
          o.has_range
            ? `${hms(o.t_first)} – ${hms(o.t_last)} · ${dur(o.t_last - o.t_first)}`
            : `${hms(o.t_first)} · single frame`),
        /* Kişi rengi — aynı insanı farklı track'lerde aynı renge boyamak
           için. Timeline'daki vurgu bu renkten geliyor. Kapalıyken de
           erişilebilir olmalı: sayfanın asıl işi bu. */
        el('div.op-swrow', {},
          PALETTE.map((c) => el('button.op-sw', {
            class: mark === c ? 'on' : '',
            title: c,
            style: { background: c },
            onclick: () => setMark(o, c),
          })),
          el('button.op-sw.none', {
            class: mark ? '' : 'on', title: 'No colour',
            onclick: () => setMark(o, null),
          }, '✕'))),
      el('div.col', { style: { gap: '5px' } },
        el('button.btn.sm.ghost', {
          onclick: () => {
            seek(o.t_first);
            if (videoEl) videoEl.play().catch(() => {});
          },
        }, '▶ From start'),
        o.bestshot != null && o.has_range
          ? el('button.btn.sm.ghost', {
            title: 'Jump to the frame this crop was taken from',
            onclick: () => {
              seek(o.bestshot);
              if (videoEl) videoEl.play().catch(() => {});
            },
          }, '◎ Bestshot')
          : null)));

    if (!infoOpen) {
      infoBody.append(el('div.op-infopar', { title: parText }, parText));
      return;
    }
    infoBody.append(el('div.op-infomore', {},
      el('dl.kv', {},
        [['class_id', o.class_id],
        ['bestshot', o.bestshot != null ? hms(o.bestshot) : '—'],
        ['confidence', o.conf != null ? (o.conf * 100).toFixed(1) + '%' : '—'],
        ['PAR', parText],
        ['PAR model', o.par_model || '—'],
        ['events', o.event_count]]
          .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))]))));
  }

  /* -------------------------------------------------- timeline + overlay -- */
  /**
   * Bütün nesneler timeline'da. Tıklanmamış olanlar da görünüyor — kullanıcı
   * "bu videoda kim ne zaman vardı" sorusuna bakmadan cevap verebilsin diye.
   *
   * Satır paketleme: çakışmayan aralıklar aynı satırı paylaşıyor (greedy
   * interval packing). Aksi halde 236 track = 236 satır olurdu. Satır sayısı
   * MAX_ROWS ile sınırlı; sığmayan aralık en erken biten satıra konuyor,
   * yani üst üste binebilir ama kaybolmuyor.
   */
  const MAX_ROWS = 4;

  /** Timeline'da görünecek küme: arama sonucu + renklendirilmiş her nesne. */
  function shown() {
    const byId = new Map(objects.map((o) => [o.id, o]));
    for (const [id, o] of marked) if (!byId.has(id)) byId.set(id, o);
    return [...byId.values()].sort((a, b) => a.t_first - b.t_first);
  }

  function packLanes() {
    const minW = Math.max(0.4, (video.duration || 60) * 0.004);
    const rows = [];              // her satır için son bitiş zamanı
    const lanes = [];

    for (const o of shown()) {
      const t0 = o.t_first;
      const t1 = o.has_range ? o.t_last : o.t_first + minW;
      const gap = minW;           // bitişik bloklar birbirine yapışmasın

      let r = rows.findIndex((end) => t0 >= end + gap);
      if (r === -1) {
        if (rows.length < MAX_ROWS) {
          r = rows.length;
          rows.push(0);
          lanes.push({ id: 'row' + r, label: '', events: [] });
        } else {
          // hepsi dolu — en erken biten satıra sıkıştır
          r = rows.indexOf(Math.min(...rows));
        }
      }
      rows[r] = Math.max(rows[r], t1);

      const color = marks.get(o.id) || CLASS_TINT[o.cls] || CLASS_TINT.other;
      lanes[r].events.push({
        id: o.id,
        t_start: t0,
        t_end: t1,
        color,
        type: marks.get(o.id) ? `#${o.track_id}` : '',
        description: `${o.label} · ${hms(t0)}`
          + (o.has_range ? ` – ${hms(o.t_last)}` : ''),
      });
    }
    return lanes.length ? lanes : [{ id: 'row0', label: '', events: [] }];
  }

  function syncAll() {
    const extra = [...marked.keys()].filter(
      (id) => !objects.some((o) => o.id === id)).length;
    markCount.textContent = objects.length || marks.size
      ? `${objects.length} objects · ${marks.size} coloured`
        + (extra ? ` (+${extra} kept from earlier search)` : '')
      : '';
    TL.activeEventId = selected ? selected.id : null;
    TL.setData({ lanes: packLanes(), total: video.duration, startIso: null });
    TL.draw();

    if (overlay) {
      /* Renklendirilmiş nesneler + seçili olan videoda vurgulanıyor;
         hiçbiri yoksa süzgeç kapalı, bütün kutular görünüyor. */
      const ids = new Set();
      for (const o of marked.values()) ids.add(o.track_id);
      if (selected) ids.add(selected.track_id);
      overlay.filterTrackIds = ids.size ? ids : null;
      overlay.colorOf = new Map([...marked.values()]
        .map((o) => [o.track_id, marks.get(o.id)]));
      overlay.draw(videoEl ? videoEl.currentTime : 0);
    }
    renderGrid();
  }

  function seek(tt) {
    const c = Math.max(0, Math.min((video.duration || 0) - 0.05, tt));
    if (videoEl) videoEl.currentTime = c;
    if (overlay) overlay.seek(c);
    paint(c);
  }

  /** Playhead hareket ettikçe: rozet, ilerleme çubuğu, aktif bbox. */
  function paint(tt) {
    TL.playhead = tt; TL.draw();
    tcode.firstChild.textContent = hms(tt);
    const pctv = (tt / (video.duration || 1) * 100) + '%';
    scrub.querySelector('.fill').style.width = pctv;
    scrub.querySelector('.knob').style.left = pctv;

    /* Tek kareli track'lerde tam eşitlik hiç tutmaz — küçük bir pencere. */
    const near = Math.max(0.5, (video.duration || 60) * 0.004);
    const inRange = (o) => tt >= o.t_first - near
      && tt <= (o.has_range ? o.t_last : o.t_first) + near;

    const act = [...marked.values()].filter(inRange);
    if (selected && inRange(selected) && !act.includes(selected)) act.push(selected);

    if (overlay) overlay.highlightTrackId = act.length ? act[0].track_id : null;
    if (act.length) {
      const o = act[0];
      segTag.textContent = `#${o.track_id} ${o.class_name} · ${hms(o.t_first)}`;
      segTag.style.display = '';
      segTag.style.background = marks.get(o.id) || PREVIEW_COLOR;
    } else {
      segTag.style.display = 'none';
    }
  }

  TL = new Timeline(tlCanvas, {
    mode: 'single',
    onSeek: (tt) => { seek(tt); },
    onPickEvent: (e) => {
      const o = shown().find((x) => x.id === e.id);
      if (o) pickObject(o);
    },
  });
  onLeave(() => TL.destroy());
  TL.setData({ lanes: [], total: video.duration, startIso: null });
  TL.fit();          // varsayılan pencere 60 sn — açılışta videonun tamamı

  scrub.onclick = (e) => {
    const r = scrub.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * (video.duration || 0));
  };

  if (canPlay) {
    overlay = new VideoOverlay(ovlCanvas, videoEl);
    onLeave(() => overlay.destroy());
    overlay.onPick = (tid) => {
      const o = objects.find((x) => x.track_id === tid);
      if (o) pickObject(o);
    };
    const det = await api.detections(videoId, { from: 0, to: video.duration });
    // Ekran bu await sırasında değişmiş olabilir — bkz. single.js'teki aynı guard
    if (!document.body.contains(vwell)) return;
    overlay.setDetections(det, { w: video.width, h: video.height });
    overlay.start();

    videoEl.addEventListener('loadedmetadata', () => overlay.resize());
    videoEl.addEventListener('timeupdate', () => paint(videoEl.currentTime));
    videoEl.addEventListener('progress', () => {
      if (!videoEl.buffered.length) return;
      const e = videoEl.buffered.end(videoEl.buffered.length - 1);
      scrub.querySelector('.buf').style.width =
        (e / (video.duration || 1) * 100) + '%';
    });
    videoEl.addEventListener('play', () => { btnPlay.textContent = '❚❚'; });
    videoEl.addEventListener('pause', () => { btnPlay.textContent = '▶'; });
    btnPlay.onclick = () => (videoEl.paused ? videoEl.play() : videoEl.pause());
  } else {
    btnPlay.disabled = true;
  }

  await loadObjects(search.sel);
  paint(0);
}
