/* ==========================================================================
   Ekran: Object Page  (#/objects/:videoId)
   --------------------------------------------------------------------------
   Müşteri wireframe'i bire bir:

     tek tık   → nesne seçilir, video şeridin BAŞINA atlar ve oynar
     çift tık  → paletten sıradaki rengi alır (hızlı yol)
     köşedeki nokta → renk seçici açılır (elle seçim)
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
  FEATURES, el, mount, clear, api, t, hms, dur, toast,
} from '../core.js';
import { VideoOverlay } from '../overlay.js';
import { bboxFeed } from '../bboxfeed.js';
import { attachHls } from '../hlsplayer.js';
import { Timeline } from '../timeline.js';
import { clockFor } from '../groupclock.js';
import {
  ROOT, onLeave, topbar, treePanel, skeletonCards, playerControls,
  rememberVideo, scrubSpans,
} from '../ui.js';
import { parChips, ageIcon, genderIcon } from '../parchip.js';

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
/* Süzgeçteki sınıflar. Değer artık MODELİN KENDİ ADI (bkz. backend.js
   CLASS_NAME) — kova, takma ad yok.

   Model on üç sınıf çıkarıyor ama burada üçü var: sahada aranan bunlar.
   Ötekilerin (bus, truck, tractor, boar, cat…) kayıtları duruyor; sadece
   tek tıkla süzülemiyorlar. Gerektiğinde bu diziye bir satır eklemek
   yetiyor, başka hiçbir yeri değiştirmeden. */
const CLASSES = [
  { v: 'person', icon: '🚶', label: 'Person' },
  { v: 'car', icon: '🚗', label: 'Car' },
  { v: 'bicycle', icon: '🚲', label: 'Bicycle' },
];

/* Cinsiyet ve yaş satırlarında EMOJİ YOK: 🧒/🧑/🧓 küçük boyutta neredeyse
   aynı görünüyor ve platforma göre değişiyor. Info rozetlerindeki çizimlerin
   aynısı kullanılıyor — süzgeçte ve sonuçta aynı simge. */
const GENDERS = [
  { key: 'gender', v: 'Male', svg: genderIcon('Male'), label: 'Male' },
  { key: 'gender', v: 'Female', svg: genderIcon('Female'), label: 'Female' },
];

const AGES = [
  { key: 'age', v: 'Child', svg: ageIcon('Child'), label: 'Child' },
  { key: 'age', v: 'Adult', svg: ageIcon('Adult'), label: 'Adult' },
  { key: 'age', v: 'Senior', svg: ageIcon('Senior'), label: 'Senior' },
];

const EXTRAS = [
  { key: 'Hat', v: 'Hat', icon: '🧢', label: 'Hat' },
  { key: 'Backpack', v: 'Backpack', icon: '🎒', label: 'Backpack' },
];

/* Wireframe'deki 12 daire: 11 renk + "farketmez". Renk hem üst hem alt
   giysiye bakıyor — model ikisini ayrı veriyor ama kullanıcı "üstü mü altı
   mı" diye düşünmek zorunda kalmasın. */
/* SIRA KULLANIM SIKLIĞINA GÖRE — tayf sırasına göre değil.
   Kıyafet aramasında en çok tıklanan üç renk siyah, gri ve beyaz; onlar
   listenin sonundayken her aramada en alt satıra bakmak gerekiyordu.
   Nötrler başa alındı, renkliler koyudan açığa devam ediyor. */
const COLORS = ['Black', 'Gray', 'White', 'Navy', 'Blue', 'SkyBlue',
  'Green', 'Yellow', 'Orange', 'Red', 'Purple'];
const COLOR_SWATCH = {
  Red: '#ef4444', Orange: '#f97316', Yellow: '#eab308', Green: '#22c55e',
  SkyBlue: '#38bdf8', Blue: '#3b82f6', Navy: '#1e3a8a', Purple: '#a855f7',
  White: '#f8fafc', Gray: '#94a3b8', Black: '#1e293b',
};

export async function screenObjects(videoId, query) {
  /* Sekmeler bu kayda dönebilsin — bkz. ui.js rememberVideo(). */
  rememberVideo(videoId);

  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(videoId, (c) => { location.hash = `#/objects/${c.id}`; }));
  mount(ROOT(), topbar('objects'), el('div.main', {}, sidebar, stage, rightbar));

  const [video, parts] = await Promise.all([
    api.video(videoId), api.groupParts(videoId),
  ]);

  /* ====================================================== iki zaman ekseni
     Kayıt çok parçalıysa (bir kameranın sabah/öğlen/akşam kayıtları) ekran
     DUVAR EKSENİNİ kullanıyor — Analysis ekranıyla aynısı, bkz.
     groupclock.js. Object tarafında bu bir tercih değil zorunluluk: Re-ID
     grup çapında çalışıyor ve başka bir parçadaki adayın yerleşebileceği
     tek eksen gerçek saat.

     Nesnelerin kendi `t_first/t_last` değeri PARÇA İÇİ saniye olarak
     kalıyor (oynatıcı, bbox ve bestshot hep onu kullanıyor); ekrana
     çıkarken `A0/A1` ile duvar eksenine taşınıyorlar. */
  const clock = clockFor(parts);
  const AXIS = clock ? clock.wallTotal : (video.duration || 0);
  const partMeta = new Map(parts.map((p) => [String(p.id), p]));
  let activeId = String(videoId);

  /* HLS — Analysis ekranındakiyle aynı kol, aynı gerekçe (bkz. single.js).
     Grup kapsamlı playlist tek <video> ile bütün parçaları oynatıyor;
     `switchPart` devre dışı kalıyor, geriye yalnızca kutu beslemesini doğru
     parçaya bağlamak kalıyor. */
  const hlsQ = query && query.get('hls');
  const hlsAsked = hlsQ === '1' || (FEATURES.hls && hlsQ !== '0');
  let useHls = hlsAsked && video.group_id != null;
  console.info('[hls] kip (object)', {
    istendi: hlsAsked, açık: useHls, group_id: video.group_id,
    parça: clock ? clock.parts.length : 1,
  });

  /** Nesnenin görünen eksendeki başı / sonu. */
  const A0 = (o) => (clock ? clock.wallSec(o.video_id, o.t_first) : o.t_first);
  const A1 = (o) => {
    const t = o.has_range ? o.t_last : o.t_first;
    return clock ? clock.wallSec(o.video_id, t) : t;
  };
  /** Görünen eksen saniyesi → okunur etiket. */
  const axLabel = (t) => (clock ? clock.clock(t) : hms(t));

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
  /* Kaç track tarandı — boş sonuçta bunu söylemek gerekiyor. "Hiçbir şey
     bulunamadı" ile "318 track tarandı, hiçbiri eşleşmedi" farklı bilgiler:
     ilki arayüzün bozuk olduğunu düşündürüyor. */
  let lastScanned = 0;
  let TL = null, overlay = null, videoEl = null, feed = null;

  /* ============================================================== iki kip ==
     native — bugünkü sistem. Şeride tıkla, renk alsın; renkliden ötekine
              sürükle, ikisi tek renge gelsin. Kimliği İNSAN kuruyor.
     re-id  — hedefi seç, timeline temizlensin, sunucunun eşleşme sıralaması
              SSE ile teker teker düşsün. Kimliği MODEL öneriyor, onayı yine
              insan veriyor: bağlama hareketi ikisinde de aynı.

     Renk = kimlik. Bağlamak, hedefin rengini ötekine vermekten ibaret;
     ayrı bir "link" tablosu tutmuyoruz çünkü ekranda okunan şey zaten renk.
  */
  let mode = 'native';
  let reid = null;   // { target, cands:Map(key→obj|null), stream, status, got }

  /* ------------------------------------------------------------ oynatıcı -- */
  const vstack = el('div.vstack');
  const ovlCanvas = el('canvas', { class: 'ovl hit' });
  /* HLS'te oynatılabilirlik kaynağın kodeğine bağlı değil — segmentler
     H.264, AVI kaynak bile açılıyor. */
  const canPlay = useHls || (video.playable ?? video.has_proxy);

  /** Oynatıcının o anki yeri, GÖRÜNEN eksende. */
  const cur = () => {
    if (!videoEl) return 0;
    if (useHls) {
      return clock ? clock.wallFromPlay(videoEl.currentTime)
        : videoEl.currentTime;
    }
    return clock ? clock.wallSec(activeId, videoEl.currentTime)
      : videoEl.currentTime;
  };

  /** Oynatıcının o anki yeri, PARÇANIN içinde — kutular buna göre. */
  const localT = () => {
    if (!videoEl) return 0;
    if (useHls && clock) {
      const hit = clock.at(clock.wallFromPlay(videoEl.currentTime));
      return hit ? hit.offset : videoEl.currentTime;
    }
    return videoEl.currentTime;
  };

  /** HLS'te parça değişimini yakalar (değiştirmez) ve beslemeyi taşır. */
  function hlsPartSync(wallSec) {
    if (!useHls || !clock) return;
    const hit = clock.at(wallSec);
    if (!hit || String(hit.part.id) === activeId) return;
    activeId = String(hit.part.id);
    const meta = partMeta.get(activeId) || {};
    const dim = { w: meta.width || video.width, h: meta.height || video.height };
    if (feed) { feed.dispose(); feed = null; }
    if (overlay) {
      overlay.setDetections(null, dim);
      overlay.setTrackMeta(partObjects());   // etiketler yeni parçanın
    }
    if (FEATURES.bbox && overlay) {
      feed = bboxFeed(hit.part.id, overlay, dim, hit.part.dur);
    }
    partTag.textContent = `${hit.part.name} · `
      + `${clock.parts.indexOf(hit.part) + 1}/${clock.parts.length}`;
    partTag.style.display = '';
  }

  if (canPlay) {
    videoEl = el('video', {
      // HLS'te kaynağı kütüphane bağlıyor
      src: useHls ? null : api.streamUrl(videoId),
      poster: useHls ? null : api.posterUrl(videoId),
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
  /* Hangi parça oynuyor — grupta şart: Re-ID adayı başka bir kayda atlattığı
     anda kullanıcı hâlâ sabahki görüntüye baktığını sanmasın. */
  const partTag = el('div.parttag', { title: 'Playing part' }, '');
  partTag.style.display = 'none';
  /* Hangi oynatma yolu kullanılıyor — iki yol yan yana yaşadığı sürece
     bakılan şeyin hangisi olduğu bir bakışta okunmalı. */
  const hlsTag = useHls
    ? el('div.parttag.hls', { title: 'Group HLS playlist' }, '⦿ HLS')
    : null;
  const vtags = el('div.vtags', {}, partTag, hlsTag);

  /* ------------------------------------------------- karşılaştırma şeridi --
     Sürüklerken video zaten hedefin anını oynatıyor ama "neyi neye
     bağlıyorum" sorusu ekranda yazmıyordu: kullanıcı hareketin ortasında
     kaynağı unutuyor. İki kırpım yan yana — karar tam olarak bu ikisine
     bakarak veriliyor. Videonun üstünde duruyor çünkü göz zaten orada. */
  const cmpStrip = el('div.op-cmp');
  cmpStrip.style.display = 'none';
  const vwell = el('div.vwell', {}, vstack, segTag, vtags, cmpStrip);

  const btnClear = el('button.btn.sm.ghost', {
    onclick: () => { marks.clear(); marked.clear(); colorSeq = 0; syncAll(); },
  }, 'Clear colours');
  // Ortak çubuk — bkz. ui.js playerControls(). Renk temizleme bu ekrana özel.
  const { node: ctl, btnPlay, scrub, tcode } = playerControls({
    duration: AXIS,
    seek: (tt) => seek(tt),
    cur: () => cur(),
    overlay: () => overlay,
    videoEl: () => videoEl,
    fullscreenOf: () => vwell,
    extra: [btnClear],
  });

  /* ------------------------------------------------------------ timeline -- */
  /* `.tlcanvas`: display:block + width:100%. Bu sınıf olmadan canvas 300px
     doğal genişliğinde kalıyor ve Timeline.resize() clientWidth'i oradan
     okuyup ekseni panelin soluna sıkıştırıyordu. */
  const tlCanvas = el('canvas.tlcanvas');
  const markCount = el('span', { class: 'tiny muted' }, '');

  /* ------------------------------------------------------- kip anahtarı --
     Zaman çizgisinin hemen solunda, çünkü değiştirdiği şey o: aynı şeritler,
     iki farklı çalışma biçimi. Kapalı = native, açık = Re-ID. Anahtar
     tek başına bir açıklama taşıyor (`title`), çünkü "Re-ID" iki kipin
     hangisinin varsayılan olduğunu söylemiyor. */
  const modeSw = el('input', {
    type: 'checkbox', id: 'reidsw',
    onchange: (e) => setMode(e.target.checked ? 'reid' : 'native'),
  });
  const modeBox = el('label.swx', {
    for: 'reidsw',
    title: 'Off — native: colour and link the tracks yourself.\n'
      + 'On — Re-ID: the server ranks matching tracks across the group '
      + 'and streams them in.',
  }, modeSw, el('span.swx-t'), el('span.swx-l', {}, 'Re-ID'));

  /* Akışın durumu: kaç aday geldi, sürüyor mu, hedef kim. Boş bir timeline
     ile "sunucu düşündü ama bir şey bulamadı" ayrımı ancak burada okunuyor. */
  const reidInfo = el('span', { class: 'tiny' }, '');
  const reidExit = el('button.btn.sm.ghost', {
    title: 'Back to all objects (Esc)',
    onclick: () => stopReid(),
  }, '✕');
  const reidBar = el('div.op-reidbar', {}, reidInfo, el('span.grow'), reidExit);
  reidBar.style.display = 'none';

  const tlPanel = el('div.panel.op-tlpanel', {},
    el('div.panel-h', {}, 'Object tracking segment',
      /* Bayrak kapalıysa anahtar hiç çizilmiyor: ekran bugünkü native
         davranışında kalır, kod silinmez. */
      FEATURES.reid ? modeBox : null,
      el('span.grow'), markCount),
    reidBar,
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

  /* Seçimi kaldırmanın görünür yolu. Klavyeden Esc de aynı işi yapıyor;
     ikisi de olmadığı için kullanıcı sayfayı yenilemek zorunda kalıyordu. */
  const infoClear = el('button.btn.sm.ghost', {
    title: 'Clear selection (Esc)',
    onclick: () => clearSelection(),
  }, '✕');
  infoClear.style.display = 'none';

  const infoBody = el('div.panel-b.op-info', {},
    el('div', { class: 'tiny muted' },
      'Click an object to jump the video there. Double-click assigns a '
      + 'colour — give the same person the same colour across tracks.'));
  const infoPanel = el('div.panel.op-infopanel', {},
    el('div.panel-h', {}, 'Info', el('span.grow'), infoClear, infoToggle),
    infoBody);

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

    const iconBtn = (item, group, tint) => {
      const b = el('button.op-ico', {
        title: item.label,
        'data-group': group,
        'data-v': item.v,
        style: tint ? { color: tint } : {},
        onclick: () => {
          if (group === 'cls') { sel.cls = item.v; paintSel(); return; }
          toggle(group, item.v);        // aynısına tekrar basmak kaldırır
        },
      }, item.svg ? null : item.icon);
      // `svg` alanı yalnızca parchip.js'teki sabit şablonlardan geliyor.
      if (item.svg) { b.innerHTML = item.svg; b.classList.add('svg'); }
      return b;
    };

    const iconRow = (label, items, group, tinted) => el('div.op-arow', {},
      el('div.op-alabel', {}, label),
      el('div.op-avals', {},
        items.map((i) => iconBtn(i, group, tinted ? i.tint : null))));

    /* `.swgrid`: 6'şarlı iki satır. Akışa bırakılınca on ikinci daire
       (siyah ya da "farketmez") tek başına üçüncü satıra düşüyordu. */
    const colorRow = el('div.op-arow', {},
      el('div.op-alabel', {}, 'Color'),
      el('div.op-avals.swgrid', {},
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
    /* `reset` boş durumdaki "Clear the filter" düğmesi için: sınıf seçimi
       kalıyor, yalnızca PAR süzgeçleri kalkıyor — kullanıcı "person"
       aramaya devam etmek istiyor, aramayı baştan kurmak değil. */
    return {
      node,
      sel,
      reset() { for (const k of Object.keys(sel.par)) delete sel.par[k]; paintSel(); },
    };
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
    /* Istek uzun surebiliyor (500 track + kirpim yollari). Bos izgara
       "bozuk" gorunuyordu; iskelet "geliyor" diyor. */
    renderSkeleton();
    /* ÇOK PARÇALI KAYITTA HER PARÇA SORULUYOR.
       Eksen grubun tamamını kapsıyor ve `packLanes` başka parçadaki nesneyi
       zaten çizebiliyor — ama istek tek videoya gidiyordu, yani zincirin
       yalnızca ilk kaydının track'leri geliyordu. Ağaçtaki zincir satırı hep
       baştan açtığı için öteki parçaların nesnelerine ulaşmanın hiçbir yolu
       yoktu. Nesnelerin kimliği `V{video}-T{track}` olduğundan birleşik
       liste çakışmıyor. */
    const srcs = clock ? clock.parts.map((p) => p.id) : [videoId];
    const rs = await Promise.all(srcs.map((id) =>
      /* Bir parçanın sonucu yoksa (hâlâ analiz ediliyor, başarısız olmuş)
         bütün liste boş kalmasın — o parça sessizce boş sayılıyor. */
      api.objects(id, { limit: 500, cls: sel.cls, par })
        .catch(() => ({ total: 0, returned: 0, items: [] }))));
    const sum = (k) => rs.reduce((n, r) => n + (r[k] || 0), 0);
    objects = rs.flatMap((r) => r.items || []);
    /* Sıra GÖRÜNEN eksende: parça parça gelen listeler uç uca eklendiği için
       ham hâlinde sabahki kaydın sonu, öğlenkinin başından sonra geliyordu. */
    objects.sort((a, b) => A0(a) - A0(b));
    lastScanned = sum('returned') || sum('total');
    totalLbl.textContent = par.length
      ? `${objects.length} match · ${sum('returned')} tracks scanned`
      : `${objects.length} ${sel.cls} · ${sum('total')} tracks total`;
    if (overlay) overlay.setTrackMeta(partObjects());
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
  /** Veri gelene kadar parildayan yer tutucular. */
  function renderSkeleton() {
    clear(grid);
    grid.append(...skeletonCards(12));
  }

  function renderGrid() {
    clear(grid);
    /* Re-ID sürerken ızgara da akışı gösteriyor: hedef + gelen adaylar,
       sıralarıyla. Arama sonucu yerinde duruyor, kip kapanınca geri geliyor. */
    /* Izgarada sıra ZAMAN değil RÜTBE: sunucunun en iyi bulduğu aday ilk
       kartta olsun. Zaman çizgisi zaten zamana göre diziyor. */
    const list = reid
      ? [...shown()].sort((a, b) => (a.reid_rank || 0) - (b.reid_rank || 0))
      : objects;
    if (!list.length) {
      /* Boş durum üç şeyi söylüyor: ne olduğu, NEDEN olduğu, oradan nasıl
         çıkılacağı. Eskiden tek kelimeydi ("No objects") ve kullanıcı
         süzgecin mi dar olduğunu yoksa analizin mi boş döndüğünü
         bilemiyordu. */
      const filtered = Object.keys(search.sel.par).length > 0;
      if (reid) {
        grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
          el('span', { class: 'big' }, '⋯'),
          el('div', { class: 'ttl' }, 'Waiting for matches'),
          el('div', { class: 'why' },
            'The server is comparing this track with the rest of the group. '
            + 'Candidates appear here and on the timeline as they arrive.')));
        return;
      }
      grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
        el('span', { class: 'big' }, '⌕'),
        el('div', { class: 'ttl' },
          filtered ? 'No match for these attributes' : 'No object in this video'),
        el('div', { class: 'why' }, filtered
          ? `${lastScanned} track scanned. PAR attributes are guesses — `
            + 'narrowing two of them at once usually empties the list.'
          : `The analysis found no ${search.sel.cls} track. Another class `
            + 'may still have results.'),
        filtered
          ? el('button.btn.sm', {
            onclick: () => { search.reset(); loadObjects(search.sel); },
          }, 'Clear the filter')
          : null));
      return;
    }
    for (const o of list) {
      const mark = marks.get(o.id);
      const card = el('div.objcard', {
        /* `hot`: akış sürerken ızgara yeniden çiziliyor; sürüklenen hedefin
           vurgusu o tazelemede kaybolmasın. */
        class: [selected && selected.id === o.id ? 'on' : '',
          hotId === o.id ? 'hot' : ''].join(' ').trim(),
        // sürüklerken bu kartı bulup vurgulayabilmek için — bkz. hotCard()
        'data-oid': o.id,
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
        /* Renk atama BURADAN. Info panelinde sürekli duran bir palet
           istenmiyordu ama özellik gerekli: kullanıcı kırpımlara bakıp
           "bu adam bu renk" diyor. Nokta her kartta duruyor, palet ancak
           tıklayınca açılıyor. */
        el('button.objdot', {
          class: mark ? 'on' : '',
          style: mark ? { background: mark, color: mark } : {},
          title: mark ? `Colour ${mark} — click to change` : 'Assign a colour',
          onclick: (e) => { e.stopPropagation(); openPalette(e.currentTarget, o); },
        }),
        el('div', { class: 'cap' },
          /* Kartta aralığın kendisi: "ne zaman" sorusunun cevabı tek bir an
             değil, girip çıktığı pencere. */
          el('div', { class: 't' }, hms(o.t_first)),
          el('div', { class: 'nowrap' },
            o.reid_rank
              ? `${o.reid_rank}. ${axLabel(A0(o))}`
              : (o.has_range ? `${dur(o.t_last - o.t_first)} · ${o.class_name}`
                : `#${o.track_id} · ${o.class_name}`))));

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
  /** Seçimi kaldır — kutular ve ızgara işaretsiz hâline döner. */
  function clearSelection() {
    selected = null;
    infoToggle.style.display = 'none';
    infoClear.style.display = 'none';
    clear(infoBody);
    infoBody.append(el('div', { class: 'tiny muted' },
      'Click an object to jump the video there. Double-click assigns a '
      + 'colour — give the same person the same colour across tracks.'));
    if (overlay) overlay.highlightTrackId = null;
    syncAll();
    paint(cur());
  }

  function pickObject(o) {
    /* Aynı nesneye ikinci kez tıklamak seçimi kaldırıyor: seçmenin tersi
       de bir tık uzakta olmalı. Esc de aynı işi yapıyor. */
    if (selected && selected.id === o.id) return clearSelection();
    selected = o;
    showInfo(o);
    syncAll();
    /* Şeridin BAŞINA. Bir süre bestshot anına atlıyordu: kırpımın çekildiği
       kare orası olduğu için mantıklı görünmüştü ama playhead şeridin
       ortasına düşüyor ve "çubuk başka yeri gösteriyor" hissi veriyordu.
       Bestshot'a atlamak isteyen Info panelindeki düğmeyi kullanır. */
    seek(A0(o));
    if (videoEl) videoEl.play().catch(() => {});
  }

  /* ------------------------------------------------------ renk seçici ----
     Sürekli görünen palet istenmedi: ızgaradaki noktaya basınca açılan
     küçük bir kutu. Kartın yanına konumlanıyor, dışarı tıklayınca ya da Esc
     ile kapanıyor. Aynı anda tek kutu açık kalır. */
  let pop = null;

  function closePalette() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }
  const onOutside = (e) => { if (pop && !pop.contains(e.target)) closePalette(); };
  const onEsc = (e) => { if (e.key === 'Escape') closePalette(); };
  onLeave(closePalette);

  function openPalette(anchorEl, o) {
    const already = pop && pop.dataset.for === o.id;
    closePalette();
    if (already) return;               // aynı noktaya tekrar basmak kapatır

    const cur = marks.get(o.id);
    pop = el('div.op-pop', { 'data-for': o.id },
      el('div.op-poph', {}, `#${o.track_id}`),
      el('div.op-popsw', {},
        PALETTE.map((c) => el('button.op-sw', {
          class: cur === c ? 'on' : '',
          title: c,
          style: { background: c },
          onclick: () => { setMark(o, c); closePalette(); },
        })),
        el('button.op-sw.none', {
          class: cur ? '' : 'on', title: 'No colour',
          onclick: () => { setMark(o, null); closePalette(); },
        }, '✕')));
    document.body.append(pop);

    /* Konum: noktanın altına, ekranın dışına taşarsa içeri çekilerek. */
    const r = anchorEl.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = r.right - w;
    let top = r.bottom + 6;
    if (left < 8) left = 8;
    if (left + w > innerWidth - 8) left = innerWidth - w - 8;
    if (top + h > innerHeight - 8) top = r.top - h - 6;
    pop.style.left = left + 'px';
    pop.style.top = Math.max(8, top) + 'px';

    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onEsc, true);
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
    infoClear.style.display = '';

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
            ? `${axLabel(A0(o))} – ${axLabel(A1(o))} · `
              + `${dur(o.t_last - o.t_first)}`
            : `${axLabel(A0(o))} · single frame`),
        /* PAR rozetleri. Eskiden burada renk paleti duruyordu; müşteri
           sürekli görünen bir palet istemedi. Renk atama ızgaradaki noktaya
           taşındı, bu satır artık asıl bilgiyi taşıyor: modelin kişi
           hakkında ne dediği. */
        el('div.op-parrow', {}, parChips(o))),
      el('div.col', { style: { gap: '5px' } },
        el('button.btn.sm.ghost', {
          onclick: () => {
            seek(A0(o));
            if (videoEl) videoEl.play().catch(() => {});
          },
        }, '▶ From start'),
        o.bestshot != null && o.has_range
          ? el('button.btn.sm.ghost', {
            title: 'Jump to the frame this crop was taken from',
            onclick: () => {
              seek(clock ? clock.wallSec(o.video_id, o.bestshot) : o.bestshot);
              if (videoEl) videoEl.play().catch(() => {});
            },
          }, '◎ Bestshot')
          : null)));

    // PAR artık şeridin içinde rozet olarak; kapalı hâlde ek satır gerekmiyor.
    if (!infoOpen) return;
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
    /* Re-ID sürerken ekranda YALNIZCA hedef ve adaylar var. İstenen buydu:
       "bir objeye tıklandığında diğer tüm barlar kaybolacak". Kalabalık
       kalsaydı akışla gelen adaylar arasında kaybolurlardı. */
    if (reid) {
      const out = [reid.target];
      for (const o of reid.cands.values()) if (o) out.push(o);
      return out.sort((a, b) => A0(a) - A0(b));
    }
    const byId = new Map(objects.map((o) => [o.id, o]));
    for (const [id, o] of marked) if (!byId.has(id)) byId.set(id, o);
    return [...byId.values()].sort((a, b) => A0(a) - A0(b));
  }

  function packLanes() {
    const minW = Math.max(0.4, (AXIS || 60) * 0.004);
    const rows = [];              // her satır için son bitiş zamanı
    const lanes = [];

    for (const o of shown()) {
      const t0 = A0(o);
      const t1 = o.has_range ? A1(o) : A0(o) + minW;
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

      const mark = marks.get(o.id);
      const color = mark || CLASS_TINT[o.cls] || CLASS_TINT.other;
      /* Adayın sırası bilgi: akış en yakın/en benzer olandan başlıyor. */
      const rank = o.reid_rank ? `${o.reid_rank}. ` : '';
      lanes[r].events.push({
        id: o.id,
        t_start: t0,
        t_end: t1,
        color,
        /* Timeline bu bayraga bakip renklendirilmis seridi parlatiyor,
           otekini soluk birakiyor. Renk vermenin tek amaci kalabalikta o
           kisiyi bulmakti; hepsi ayni agirlikta cizilince amac kayboluyordu. */
        marked: !!mark,
        type: marks.get(o.id) ? `#${o.track_id}` : (o.reid_rank ? rank : ''),
        description: `${rank}${o.label} · ${axLabel(t0)}`
          + (o.has_range ? ` – ${axLabel(A1(o))}` : '')
          + (o.reid_score != null
            ? ` · match ${(o.reid_score * 100).toFixed(0)}%` : '')
          + (clock && String(o.video_id) !== activeId
            ? ` · ${(partMeta.get(String(o.video_id)) || {}).name || ''}` : ''),
      });
    }
    return lanes.length ? lanes : [{ id: 'row0', label: '', events: [] }];
  }

  /**
   * O an OYNAYAN parçanın nesneleri.
   *
   * Bindirme katmanı track_id ile anahtarlıyor ve track numaraları her
   * videoda 1'den başlıyor: grubun tamamını verirsek sabahki #7'nin etiketi
   * öğlenki #7'nin kutusuna yapışır. Zaman çizgisi ve ızgara bütün grubu
   * gösteriyor, kutular yalnızca ekrandaki kaydı.
   */
  const partObjects = () => (clock
    ? objects.filter((o) => String(o.video_id) === activeId)
    : objects);

  function syncAll() {
    if (reid) {
      /* Re-ID'de sayı arama sonucunu değil akışı anlatmalı. */
      markCount.textContent = `${reid.got} candidate`
        + `${reid.got === 1 ? '' : 's'} · ${marks.size} coloured`;
    } else {
      const extra = [...marked.keys()].filter(
        (id) => !objects.some((o) => o.id === id)).length;
      markCount.textContent = objects.length || marks.size
        ? `${objects.length} objects · ${marks.size} coloured`
          + (extra ? ` (+${extra} kept from earlier search)` : '')
        : '';
    }
    TL.activeEventId = selected ? selected.id : null;
    TL.setData({
      lanes: packLanes(), total: AXIS,
      startIso: clock ? clock.startIso : null,
      gaps: clock ? clock.gaps : null,
      spans: clock ? clock.spans : null,
    });
    TL.draw();

    if (overlay) {
      /* KUTU GİZLEMEK YOK. Renklendirme videodaki öbür kutuları da
         siliyordu; şeride tıklamak artık renk verdiği için bu, tek tıkla
         ekranın boşalması demekti. Renk zaten kendi başına ayırıyor:
         işaretlenen track kendi rengiyle, ötekiler nötr çiziliyor
         (bkz. overlay.js). Süzgeç, geri alınamadığı için kaldırıldı. */
      overlay.filterTrackIds = null;
      overlay.colorOf = new Map([...marked.values()]
        .filter((o) => !clock || String(o.video_id) === activeId)
        .map((o) => [o.track_id, marks.get(o.id)]));
      overlay.draw(localT());
    }
    renderGrid();
  }

  /**
   * GÖRÜNEN eksende bir ana git.
   *
   * Tek parçada bu doğrudan `currentTime`. Grupta önce hangi kayda düştüğü
   * çözülüyor; boşluğa denk gelirse bir sonraki kaydın başına yuvarlanıyor —
   * kayıt olmayan bir saatte durup beklemenin anlamı yok.
   */
  function seek(tt) {
    const t = Math.max(0, Math.min((AXIS || 0) - 0.05, tt));
    let local = t;
    if (useHls && clock) {
      const hit = clock.at(t);
      if (!hit) return;
      if (hit.gap) return seek(clock.wallSec(hit.part.id, 0) + 0.01);
      local = hit.offset;
      /* Tek eksen: boşluklar playlist'te yok, duvar saatini oynatma
         eksenine çevirmek yetiyor. Kaynak değişmiyor. */
      hlsPartSync(t);
      if (videoEl) videoEl.currentTime = clock.playFromWall(t);
    } else if (useHls) {
      if (videoEl) videoEl.currentTime = t;      // tek parçalı grup
    } else if (clock) {
      const hit = clock.at(t);
      if (!hit) return;
      if (hit.gap) return seek(clock.wallSec(hit.part.id, 0) + 0.01);
      local = hit.offset;
      switchPart(hit.part, local);
    } else if (videoEl) {
      videoEl.currentTime = local;
    }
    /* Bu ekranda asıl gezinme oynatmak değil, ızgaradan bir nesneye tıklamak.
       Video duraklamışken `timeupdate` gelmiyor, dolayısıyla beslemeyi burada
       elle uyarmazsak o andaki pencere hiç indirilmez. */
    if (feed) feed.at(local);
    if (overlay) overlay.seek(local);
    paint(t);
  }

  /**
   * Grupta parçalar arası geçiş.
   *
   * Analysis ekranındakinin (single.js) küçük kardeşi: burada zincirleme
   * oynatma yok, tek iş bir adayın bulunduğu kayda atlamak. Kutu beslemesi
   * parçaya bağlı olduğu için her geçişte yenileniyor.
   */
  function switchPart(part, offset) {
    if (!videoEl) return;
    const off = Math.max(0, Math.min((part.dur || 0) - 0.05, offset));
    if (String(part.id) === activeId) { videoEl.currentTime = off; return; }
    const meta = partMeta.get(String(part.id)) || {};
    if (meta.playable === false) {
      toast(`${part.name}: no playable copy — timeline still works.`,
        'warn', 4000);
      return;
    }
    const wasPlaying = !videoEl.paused;
    activeId = String(part.id);
    if (feed) { feed.dispose(); feed = null; }
    const dim = { w: meta.width || video.width, h: meta.height || video.height };
    if (overlay) {
      overlay.setDetections(null, dim);
      overlay.setTrackMeta(partObjects());   // etiketler yeni parçanın
    }
    if (FEATURES.bbox && overlay) {
      feed = bboxFeed(part.id, overlay, dim, part.dur);
    }
    const onMeta = () => {
      videoEl.removeEventListener('loadedmetadata', onMeta);
      videoEl.currentTime = off;
      if (overlay) overlay.resize();
      if (feed) feed.at(off);
      if (wasPlaying) videoEl.play().catch(() => {});
    };
    videoEl.addEventListener('loadedmetadata', onMeta);
    videoEl.src = api.streamUrl(part.id);
    videoEl.load();
    partTag.textContent = `${part.name} · `
      + `${clock.parts.indexOf(part) + 1}/${clock.parts.length}`;
    partTag.style.display = '';
  }

  /** Playhead hareket ettikçe: rozet, ilerleme çubuğu, aktif bbox. */
  function paint(tt) {
    TL.playhead = tt; TL.draw();
    tcode.firstChild.textContent = axLabel(tt);
    const pctv = (tt / (AXIS || 1) * 100) + '%';
    scrub.querySelector('.fill').style.width = pctv;
    scrub.querySelector('.knob').style.left = pctv;

    /* Tek kareli track'lerde tam eşitlik hiç tutmaz — küçük bir pencere. */
    const near = Math.max(0.5, (AXIS || 60) * 0.004);
    const inRange = (o) => tt >= A0(o) - near && tt <= A1(o) + near;

    const act = [...marked.values()].filter(inRange);
    if (selected && inRange(selected) && !act.includes(selected)) act.push(selected);

    if (overlay) overlay.highlightTrackId = act.length ? act[0].track_id : null;
    if (act.length) {
      const o = act[0];
      segTag.textContent = `#${o.track_id} ${o.class_name} · ${axLabel(A0(o))}`;
      segTag.style.display = '';
      segTag.style.background = marks.get(o.id) || PREVIEW_COLOR;
    } else {
      segTag.style.display = 'none';
    }
  }

  /* ======================================================= kip yönetimi ====
     Kip değişimi ekranı SIFIRLAMIYOR: renkler, seçim ve arama sonucu yerinde
     kalıyor. Değişen tek şey bir şeride tıklamanın ne anlama geldiği. Re-ID
     kapatılınca akış kesiliyor ve bütün şeritler geri geliyor. */
  function setMode(next) {
    mode = next;
    if (mode === 'native') stopReid();
    modeSw.checked = mode === 'reid';
    tlPanel.classList.toggle('reid', mode === 'reid');
    if (mode === 'reid' && video.group_id == null) {
      toast('This recording has no video group — Re-ID compares tracks '
        + 'inside a group, so there is nothing to compare against.',
        'warn', 6000);
    }
  }

  /** Paletten sıradaki renk. İlk tık kırmızı — wireframe'deki sıra bu. */
  const nextColor = () => PALETTE[colorSeq++ % PALETTE.length];

  /* ---------------------------------------------------------- şerit tıkı --
     native: renksizse renk alsın, sonra normal seçim (video oraya gitsin).
     re-id : hedefi kur, timeline'ı temizle, akışı başlat.
  */
  function onBarClick(ev) {
    const o = shown().find((x) => x.id === ev.id);
    if (!o) return;
    if (mode === 'reid') {
      if (reid && reid.target.id === o.id) return pickObject(o);
      return startReid(o);
    }
    /* Renksizken tıklamak RENK VERİR ve seçer. `pickObject` aynı nesneye
       ikinci tıkta seçimi kaldırıyor; yeni renklenmiş bir şeridi hemen
       kapatmasın diye o yol atlanıyor. */
    if (!marks.has(o.id)) {
      setMark(o, nextColor());
      selected = o;
      showInfo(o);
      syncAll();
      seek(A0(o));
      if (videoEl) videoEl.play().catch(() => {});
      return;
    }
    pickObject(o);
  }

  /* ------------------------------------------------------------ bağlama --
     Sürükleme bitti: iki şerit aynı kişi. Kimliği renk taşıdığı için
     yapılacak tek şey hedefin rengini ötekine vermek — çizgi kayboluyor,
     geriye ikisinin ortak rengi kalıyor. Kaynak renksizse (re-id'de aday
     adaya bağlanabilir) sıradaki renk ikisine birden gidiyor. */
  function onLink(fromEv, toEv) {
    const all = shown();
    const a = all.find((x) => x.id === fromEv.id);
    const b = all.find((x) => x.id === toEv.id);
    if (!a || !b) return;
    const col = marks.get(a.id) || nextColor();
    if (!marks.has(a.id)) { marks.set(a.id, col); marked.set(a.id, a); }
    setMark(b, col);
    toast(`#${a.track_id} ↔ #${b.track_id} — same person`, 'ok', 2400);
  }

  /* Sürüklerken hedefin üstüne gelmek onu OYNATIYOR. Wireframe'in kendi
     cümlesi: "If you hover over an object segment, video at that time will
     be automatically played." Yalnızca sürükleme sırasında — yoksa çubukta
     gezinmek videoyu durmadan zıplatırdı. */
  function onHoverBar(ev, fromEv) {
    if (!ev) return showCompare(null, null);
    const all = shown();
    const o = all.find((x) => x.id === ev.id);
    if (!o) return showCompare(null, null);
    showCompare(fromEv ? all.find((x) => x.id === fromEv.id) : null, o);
    seek(A0(o));
    if (videoEl) videoEl.play().catch(() => {});
  }

  /** Şerit içindeki tek yüz: kırpım + kimlik + saat. */
  function cmpFace(o, tint) {
    return el('div.op-cmpface', {},
      el('img', {
        src: o.crop,
        style: tint ? { boxShadow: `0 0 0 2px ${tint}` } : {},
        onerror: (e) => { e.target.style.visibility = 'hidden'; },
      }),
      el('div', {},
        el('b', {}, `#${o.track_id}`),
        el('div', { class: 'tiny' }, axLabel(A0(o)))));
  }

  /**
   * Sürükleme sırasında "kimden kime" göstergesi.
   * `to` null ise şerit kapanıyor ve ızgaradaki vurgu kalkıyor.
   */
  function showCompare(from, to) {
    if (!to) {
      cmpStrip.style.display = 'none';
      hotCard(null);
      return;
    }
    clear(cmpStrip);
    if (from) {
      cmpStrip.append(cmpFace(from, marks.get(from.id)),
        el('span.op-cmparrow', {}, '→'));
    }
    cmpStrip.append(cmpFace(to, marks.get(to.id)),
      el('span.op-cmphint', {}, 'aynı kişiyse bırak'));
    cmpStrip.style.display = '';
    hotCard(to);
  }

  /** Sağdaki ızgarada karşılık gelen kartı vurgula ve görünür yere kaydır. */
  let hotId = null;
  function hotCard(o) {
    if (hotId === (o && o.id)) return;
    hotId = o ? o.id : null;
    for (const c of grid.querySelectorAll('.objcard.hot')) {
      c.classList.remove('hot');
    }
    if (!o) return;
    const card = grid.querySelector(`[data-oid="${CSS.escape(o.id)}"]`);
    if (!card) return;
    card.classList.add('hot');
    card.scrollIntoView({ block: 'nearest' });
  }

  /* =========================================================== Re-ID akışı ==
     GET …/groups/{gid}/video/{vid}/track/{tid}/reid/stream — sunucu grup
     içindeki track'leri hedefle karşılaştırıp sıralamayı SSE ile gönderiyor
     (bkz. backend.js reidStream). Akış "bitti" demeden de kullanılabilir:
     ilk gelenler zaman olarak en yakın adaylar, yani genelde aranan kişi
     ilk birkaç şeridin içinde.

     Gelen yük yalnızca {video_id, track_id}. Şerit çizmek için aralık ve
     kırpım gerekiyor, onları TEKER TEKER çekiyoruz — hem akışın kendi
     ritmini bozmuyor hem de "sırayla belirsin" isteğini kendiliğinden
     karşılıyor. */
  const rq = [];
  let pumping = false;

  /**
   * Sıralama olayı: LİSTENİN TAMAMI, yeniden dizilmiş.
   *
   * Sunucu her olayda o ana kadarki bütün sıralamayı gönderiyor ve sıra
   * değişiyor (bkz. backend.js). Yani burada yapılacak iki iş var: henüz
   * görmediğimiz adayları çözme kuyruğuna at, görülmüş olanların RÜTBESİNİ
   * tazele. Şeritlerin ekrandaki yeri zamana göre; rütbe etikette duruyor.
   */
  function onRanking(list) {
    if (!reid) return;
    reid.rank = new Map(list.map((m) => [m.key, m]));
    for (const m of list) {
      const key = `V${m.videoId}-T${m.trackId}`;
      const have = reid.cands.get(key);
      if (have === undefined) {
        reid.cands.set(key, null);   // yer tut: aynı aday iki kez sıraya girmesin
        /* Olduğu gibi: `m.key` sıralama tablosunun anahtarı ("vid:tid"),
           `key` ise nesne kimliği ("V…-T…"). İkisini karıştırmamak lazım —
           kuyruktaki kayıt her ikisine de erişebilmeli. */
        rq.push(m);
        continue;
      }
      if (have) { have.reid_rank = m.rank; have.reid_score = m.score; }
    }
    reid.total = list.length;   // ham sıralama; elenenler reid.dropped'ta
    reid.status = 'running';
    reid.got = [...reid.cands.values()].filter(Boolean).length;
    syncAll();
    reidStatus();
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (rq.length && reid) {
      /* Ayrıntı isteği beklerken kullanıcı başka bir hedef seçmiş olabilir.
         O zaman elimizdeki cevap ESKİ akışa ait — yeni tablonun içine
         yazmak, hiç istenmemiş adayları ekrana koymak olurdu. */
      const gen = reid;
      const m = rq.shift();
      const key = `V${m.videoId}-T${m.trackId}`;
      let o = null;
      try { o = await api.trackObject(m.videoId, m.trackId); } catch { /* atla */ }
      if (reid !== gen) break;
      if (!o) { reid.cands.delete(key); continue; }
      /* SINIF ELEMESİ. Sıralama sınıf ayırmıyor: bir kişiyi ararken araç
         track'leri de geliyor. Bir insan bir araba olamaz — bu bir sıralama
         kalitesi sorunu değil, gösterilmemesi gereken bir sonuç. Sınıf zaten
         elimizde (ayrıntıyla birlikte iniyor), burada eliyoruz. Kaç tanesinin
         elendiğini durum satırı söylüyor: sessizce atmak, sunucunun daha az
         aday bulduğu izlenimi verirdi. */
      if (o.class_known && o.cls && reid.target.cls
          && o.cls !== reid.target.cls) {
        reid.cands.delete(key);
        reid.dropped = (reid.dropped || 0) + 1;
        reidStatus();
        continue;
      }
      /* Rütbe kuyruğa girdiği andaki değil, EN SON sıralamadaki olmalı:
         bekleme sırasında sıra değişmiş olabilir. */
      const now = reid.rank.get(m.key);
      o.reid_rank = now ? now.rank : m.rank;
      o.reid_score = (now ? now.score : m.score);
      reid.cands.set(key, o);
      reid.got = [...reid.cands.values()].filter(Boolean).length;
      syncAll();
      reidStatus();
    }
    pumping = false;
  }

  const REID_ST = {
    running: '● streaming…',
    /* Akış "bittim" demiyor, sessizleşiyor. Donmuş bir ekranla dolmuş bir
       sıralamayı ayırt edebilmek gerekiyor. */
    /* Akış kendiliğinden bitmiyor; sıralama sabitlendiğinde biz kapatıyoruz
       (bkz. backend.js). Kullanıcıya bunu söylemek gerekiyor, yoksa "hâlâ
       arıyor mu" belirsiz kalıyor. */
    idle: '✓ ranking settled',
    error: '⚠ stream failed',
    done: '✓ stream ended',
  };

  function reidStatus() {
    if (!reid) return;
    /* Sıralamada olup henüz ayrıntısı inmemiş aday olabilir; ikisini birden
       göstermek "eksik mi geldi" sorusunu ortadan kaldırıyor. */
    const shownN = reid.got;
    const listed = Math.max(0, reid.total - (reid.dropped || 0));
    const n = listed > shownN ? `${shownN}/${listed}` : `${shownN}`;
    clear(reidInfo);
    reidInfo.append(
      el('b', { style: { color: marks.get(reid.target.id) || '#e8eef6' } },
        `#${reid.target.track_id}`),
      ` — ${n} candidate${listed === 1 ? '' : 's'} · `
        + (REID_ST[reid.status] || reid.status)
        + (reid.dropped
          ? ` · ${reid.dropped} other-class dropped` : ''),
      el('span', { class: 'muted' },
        '  ·  drag from the target onto a candidate to confirm'));
  }

  function startReid(o) {
    const gid = video.group_id;
    if (gid == null) {
      return toast('No video group — Re-ID has nothing to compare against.',
        'warn', 5000);
    }
    stopReid(true);
    if (!marks.has(o.id)) { marks.set(o.id, nextColor()); marked.set(o.id, o); }
    reid = { target: o, cands: new Map(), rank: new Map(), status: 'running',
             got: 0, total: 0, dropped: 0, stream: null };
    reidBar.style.display = '';
    reidStatus();
    selected = o;
    showInfo(o);
    syncAll();
    seek(A0(o));

    reid.stream = api.reidStream(gid, o.video_id, o.track_id, {
      /* Üst sınır: sıralama teorik olarak gruptaki BÜTÜN track'leri
         kapsıyor. 60 şeritten sonrası ne ekranda okunuyor ne de işe
         yarıyor — sıralama zaten en iyiden başlıyor. */
      limit: 60,
      onRanking: (list) => onRanking(list),
      onDone: (why) => {
        if (!reid) return;
        reid.status = { error: 'error', idle: 'idle', limit: 'done' }[why]
          || 'done';
        reidStatus();
      },
    });
  }

  /** @param {boolean} [quiet] yeniden başlatma sırasında çizim yapma */
  function stopReid(quiet) {
    rq.length = 0;
    if (!reid) return;
    if (reid.stream) reid.stream.close();
    reid = null;
    reidBar.style.display = 'none';
    if (!quiet) syncAll();
  }
  onLeave(() => stopReid(true));

  TL = new Timeline(tlCanvas, {
    mode: 'single',
    onSeek: (tt) => { seek(tt); },
    onPickEvent: (e) => onBarClick(e),
    onLinkEvent: (a, b) => onLink(a, b),
    onHoverEvent: (e, from) => onHoverBar(e, from),
  });
  onLeave(() => TL.destroy());
  /* Grupta eksen gerçek saat, boşluklar taranıyor — Analysis ekranıyla aynı
     görüntü, aynı gerekçe (bkz. groupclock.js). */
  TL.setData({
    lanes: [], total: AXIS,
    startIso: clock ? clock.startIso : null,
    gaps: clock ? clock.gaps : null,
    spans: clock ? clock.spans : null,
  });
  TL.fit();          // varsayılan pencere 60 sn — açılışta videonun tamamı

  /* Boşluklar ve parça sınırları — bkz. ui.js scrubSpans. */
  scrubSpans(scrub, clock, AXIS);

  scrub.onclick = (e) => {
    const r = scrub.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * (AXIS || 0));
  };

  if (canPlay) {
    overlay = new VideoOverlay(ovlCanvas, videoEl);
    onLeave(() => overlay.destroy());
    overlay.onPick = (tid) => {
      if (tid === null) return selected ? clearSelection() : null;
      /* `shown()` — Re-ID sürerken ekrandaki nesneler arama sonucu değil,
         akışla gelen adaylar. Video üstündeki kutu da onlara denk gelmeli. */
      const o = shown().find((x) => x.track_id === tid
        && String(x.video_id) === activeId);
      if (o) pickObject(o);
    };
    /* Kutular playhead'i takip eden kayan pencereyle geliyor — bkz.
       bboxfeed.js. Bayrak kapalıysa hiç istek atılmıyor. */
    overlay.setDetections(null, { w: video.width, h: video.height });
    if (FEATURES.bbox) {
      feed = bboxFeed(videoId, overlay,
        { w: video.width, h: video.height }, video.duration);
      onLeave(() => feed.dispose());
      feed.at(0);
    }
    overlay.start();

    if (useHls) {
      attachHls(videoEl, api.hlsUrl(video.group_id), {
        onReady: (d, yol) => {
          console.info('[hls] bağlandı (object)', { yol, süre: d });
          toast(`HLS bağlandı (${yol}) — ${hms(d || 0)}`, 'ok', 3000);
          paint(cur());
        },
        onError: (msg) => toast('HLS: ' + msg, 'err', 6000),
      }).then((h) => {
        if (h) {
          onLeave(() => h.destroy());
          hlsTag.title = `Group HLS playlist · ${h.mode}`;
          return;
        }
        if (hlsTag) hlsTag.style.display = 'none';
        useHls = false;
        videoEl.src = api.streamUrl(activeId);
        videoEl.load();
        toast('hls.js bulunamadı — normal oynatıcıya dönüldü', 'warn', 6000);
      });
    }

    videoEl.addEventListener('loadedmetadata', () => overlay.resize());
    videoEl.addEventListener('timeupdate', () => {
      const tt = cur();
      hlsPartSync(tt);           // önce parça, sonra besleme
      if (feed) feed.at(localT());
      paint(tt);
    });
    videoEl.addEventListener('progress', () => {
      if (!videoEl.buffered.length) return;
      const e = videoEl.buffered.end(videoEl.buffered.length - 1);
      /* Tampon PARÇA içinde ölçülüyor; çubuk ise bütün ekseni gösteriyor.
         Grupta parçanın eksendeki yerine kaydırmadan çizmek, sabahki kaydın
         tamponunu akşamki kaydın üstüne boyamak olurdu. */
      const at = useHls
        ? (clock ? clock.wallFromPlay(e) : e)
        : (clock ? clock.wallSec(activeId, e) : e);
      scrub.querySelector('.buf').style.width =
        (at / (AXIS || 1) * 100) + '%';
    });
    videoEl.addEventListener('play', () => { btnPlay.textContent = '❚❚'; });
    videoEl.addEventListener('pause', () => { btnPlay.textContent = '▶'; });
    btnPlay.onclick = () => (videoEl.paused ? videoEl.play() : videoEl.pause());
  } else {
    btnPlay.disabled = true;
  }

  /* Esc: önce açık palet, yoksa seçim. Palet kendi Esc'ini yakalayıp
     kapanıyor; ikisi aynı tuşta olduğu için sıra önemli. */
  const onEscKey = (e) => {
    if (e.key !== 'Escape' || pop) return;
    /* Sıra: palet → Re-ID akışı → seçim. Her Esc bir kademe geri alıyor. */
    if (reid) { e.preventDefault(); return stopReid(); }
    if (selected) { e.preventDefault(); clearSelection(); }
  };
  document.addEventListener('keydown', onEscKey);
  onLeave(() => document.removeEventListener('keydown', onEscKey));

  /* Grupta hangi parçayla açıldığımızı en baştan söyle. */
  if (clock) {
    const p0 = clock.parts.find((x) => String(x.id) === activeId)
      || clock.parts[0];
    partTag.textContent = `${p0.name} · ${clock.parts.indexOf(p0) + 1}`
      + `/${clock.parts.length}`;
    partTag.style.display = '';
  }

  await loadObjects(search.sel);
  paint(cur());

  /* Analysis ekranındaki "Track this person (Re-ID)" düğmesi buraya
     `?reid=<track_id>` ile geliyor: kip açık, hedef seçili, akış başlamış. */
  const wanted = query && query.get('reid');
  if (wanted) {
    const o = objects.find((x) => String(x.track_id) === String(wanted));
    if (o) { setMode('reid'); startReid(o); }
    else toast(`Track #${wanted} is not in this result set`, 'warn');
  }
}
