/* ==========================================================================
   Ekran: Collection  (#/collection/:id)
   --------------------------------------------------------------------------
   Bir koleksiyondaki BÜTÜN video gruplarını tek gerçek-saat ekseninde
   gösterir. Amaç tek cümlede: "14:18'de bu kamerada gördüğüm adam o an öbür
   kamerada var mıydı?"

   ÜÇ KARAR, ÜÇ GEREKÇE
   --------------------
   1) EKSEN GERÇEK SAAT (bkz. collectionclock.js). Her grubu kendi 00:00'ından
      başlatmak kolay olurdu ama o zaman aynı dikey çizgi aynı ANA değil aynı
      OFFSET'e denk gelirdi ve yukarıdaki soru cevapsız kalırdı.

   2) TEK OYNATICI, HOVER İLE DEVİR. Üç grup = üç <video> demek üç HLS
      bağlantısı, üç canvas, üç bbox akışı; tarayıcı dört-beş videodan sonra
      kare düşürüyor. Bunun yerine ekranda tek oynatıcı var ve fare hangi
      bandın üstündeyse oynatıcı O gruba geçiyor — playhead'in bulunduğu
      gerçek saatten devam ederek. Diğer bandlarda video yok, yalnızca ortak
      playhead çizgisi kayıyor.

   3) BANDLAR KAPALI DURUYOR. Grup başına altı şerit × üç grup ekranın
      yarısını yerdi. Kapalı band tek satır: arkada yoğunluk şeridi, üstünde
      yalnızca bağlanmış/renklendirilmiş kişiler — yani takip edilen şey her
      zaman görünür, kalabalık ancak istendiğinde geliyor
      (bkz. timeline.js `bands`).

   İKİ KİP
   -------
   events  → gruplardaki VLM olayları, tek eksende alt alta
   objects → track şeritleri; sürükleyerek gruplar ARASI kişi bağlama
             (bkz. identity.js — kapsam burada `collection`)
   ========================================================================== */

import { FEATURES, el, mount, clear, api, dur, toast } from '../core.js';
import { VideoOverlay } from '../overlay.js';
import { bboxFeed } from '../bboxfeed.js';
import { attachHls } from '../hlsplayer.js';
import { Timeline } from '../timeline.js';
import { CollectionClock } from '../collectionclock.js';
import { loadIdentities, idKey } from '../identity.js';
import {
  ROOT, onLeave, topbar, treePanel, playerControls, skeletonRows,
  skeletonCards, rememberCollection,
} from '../ui.js';
/* Sağ paneldeki arama Object ekranıyla AYNI dosyadan geliyor: "aynı olsun"
   ancak tek kaynakla kalıcı oluyor (bkz. objsearch.js). */
import { buildSearch, parQuery } from '../objsearch.js';

/* KAMERA RENKLE ANLATILMIYOR — HARFLE.
   -------------------------------------
   Önce her banda ayrı bir renk verilmişti. İki ayrı renk dili aynı anda
   ekranda duruyordu: band rengi "hangi kamera", kişi rengi "hangi insan".
   Şerit `kişi rengi || band rengi` ile çizildiği için bir şerit sen ona
   dokunana kadar kamera rengiyle duruyor, dokununca kişi rengine atlıyordu;
   sonuç, hangi rengin neyi anlattığının okunamaması oldu.

   Şimdi tek kural var: EKRANDA RENKLİ OLAN ŞEY KİŞİDİR. Kamera zaten
   konumda kodlu — hangi band satırındaysan o kamera — ve renk orada saf
   tekrardı. Ada eşlik eden tek harf (A, B, C…) kartta, ipuçlarında ve
   karşılaştırma şeridinde aynı kamerayı gösteriyor; zaman çizgisinde ise
   satırın kendisi yeterli.

   Band süsü tek bir nötr tonda: bütün bandlarda AYNI olduğu için hiçbir şey
   ayırt etmiyor, yalnızca başlık satırını okunur kılıyor. */
const BAND_TINT = '#7dd3fc';
const BAND_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* Kişiye bağlanmamış şeritlerin rengi — sınıfına göre sönük bir ton.
   Görünürler ama öne çıkmazlar; kullanıcının verdiği renk bunların üstünde
   parlıyor (objects.js CLASS_TINT ile aynı değerler). */
const CLASS_TINT = {
  person: '#3f5468', vehicle: '#4a4a5e', bicycle: '#41564a', other: '#3a4250',
};
const tintOf = (o) => CLASS_TINT[o.class_name] || CLASS_TINT.other;

/* Kapalı bandın özet satırında en fazla kaç şerit paketlensin. Açıkken
   sınır daha yüksek: orada zaten yer açılmış oluyor. */
const ROWS_COLLAPSED = 1;
const ROWS_OPEN = 5;

/* PARÇA OYNATMA ÖLÇÜLERİ.
   Bir track şeridi yarım saniye sürebiliyor; tam o aralığı oynatmak göze
   tek kare gibi geliyor ve "tıkladım, bir şey olmadı" diye okunuyor. Taban
   süre bunu engelliyor; ön yükleme de kişinin kadraja girişini gösteriyor,
   yoksa görüntü adam zaten ortadayken açılıyor. */
const CLIP_MIN = 1.6;   // sn — bir parçanın en az bu kadarı oynuyor
const CLIP_PAD = 0.4;   // sn — parçanın başından önce bu kadar geriden
/* Kaynak değiştikten sonra oynatıcının saati bir süre ESKİ medyaya ait
   kalıyor ve o değerle "parça bitti" kararı vermek listeyi bir anda sonuna
   kadar akıtıyordu. Bu pencere boyunca parça bitişine bakmıyoruz. */
const CLIP_SETTLE = 600;  // ms

/* Kişi paleti — objects.js'teki listenin AYNISI. İki ekranda aynı track
   aynı rengi göstermeli, yoksa "grupta kırmızıydı burada turuncu" olurdu. */
const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#38bdf8',
  '#3b82f6', '#a855f7', '#f472b6', '#2dd4bf', '#f8fafc'];

export async function screenCollection(collectionId, query) {
  /* Üst çubuktaki Summary sekmesi bunu okuyor (bkz. ui.js topbar). */
  rememberCollection(collectionId);

  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(null, (c) => { location.hash = `#/objects/${c.id}`; }));
  mount(ROOT(), topbar('collection'),
    el('div.main', {}, sidebar, stage, rightbar));

  /* ------------------------------------------------------------ veri ---- */
  const cols = await api.collections();
  const col = cols.find((c) => String(c.id) === String(collectionId));
  if (!col) {
    mount(stage, el('div.empty', {},
      `Collection ${collectionId} not found.`));
    return;
  }

  /* Hizalama adreste taşınıyor (`?align=wall`): kip değiştirmek ekranı
     baştan kuruyor — bütün zamanlar, şeritler ve oynatıcı konumu değişiyor,
     yerinde güncellemek her birini ayrı ayrı doğru yapmayı gerektirirdi.
     Yeniden yüklemek hem daha az kod hem yer imi verilebilir bir adres. */
  const align = (query && query.get('align')) === 'wall' ? 'wall' : 'zero';
  const clock = new CollectionClock(col.groups, { align });
  if (clock.empty) {
    mount(stage, el('div.empty', {},
      el('div', {}, `"${col.name}" has no playable recording yet.`),
      el('div', { class: 'tiny muted' },
        'Add video groups to this collection in Manage, and make sure the '
        + 'videos have finished analysing.')));
    return;
  }

  const AXIS = clock.total;
  /* Harf band SIRASINA göre: eksende yukarıdan aşağı okunan sıra ile harf
     sırası aynı olsun — A en üstteki kamera. */
  clock.bands.forEach((b, i) => {
    b.letter = BAND_LETTERS[i % BAND_LETTERS.length];
    b.color = BAND_TINT;
  });

  /* Kimlik kapsamı koleksiyonun BÜTÜN gruplarını sayıyor, yalnızca eksende
     çizilebilenleri değil: oynatılamayan bir video yüzünden bandı düşen bir
     grupta yapılmış bağlantı da bu koleksiyona aittir ve süzülüp atılırsa
     kişi eksik görünür. */
  const groupIds = (col.groups || []).map((g) => String(g.id));
  let ids = null;
  try {
    ids = await loadIdentities({
      kind: 'collection', id: String(col.id), groupIds,
    });
  } catch (e) {
    console.warn('[identity] koleksiyon kimlikleri yüklenemedi:', e.message);
    ids = await loadIdentities({ kind: 'none' });
  }
  onLeave(() => ids && ids.flush());

  /* ----------------------------------------------------------- durum ---- */
  /* Varsayılan kip NESNELER. Koleksiyon ekranının varlık sebebi gruplar
     arası kişi eşleştirmek; olaylar kipi burada ikinci sırada. Eskiden
     olaylarla açılıyordu ve kaydedilmiş kişiler ilk bakışta hiç
     görünmüyordu — olay şeritlerinde kişi kavramı yok. */
  let mode = (query && query.get('mode')) === 'events' ? 'events' : 'objects';
  let axisT = 0;                 // koleksiyon ekseni saniyesi (playhead)
  let active = clock.bands[0];   // oynatıcının bağlı olduğu band
  let activePart = null;         // aktif bandda o an oynayan video
  let selected = null;           // seçili olay/nesne
  /* PARÇA OYNATMA. Doluysa oynatıcı serbest değil, bir listeyi takip
     ediyor: her parça bittiğinde bir sonrakinin başına atlıyor, liste
     bitince duruyor (bkz. playClips). İki yerden doluyor — bir şeride
     tıklamak (tek parça) ve bir renge basmak (o kişinin bütün parçaları). */
  let clip = null;   // { segs:[{b,t0,t1}], i, color, guard }
  /* `seek()` kullanıcıdan mı geliyor yoksa parça oynatmanın kendisinden mi.
     Kullanıcının her elle araması listeyi iptal ediyor; listenin kendi
     atlayışı etmiyor. */
  let clipSeek = false;
  /* SÜRÜKLERKEN HEDEFİN ÖN İZLEME RENGİ.
     Renkli bir şeridi renksiz bir şeridin üstüne sürüklerken ekranda o anın
     görüntüsü oynuyor ve karar tam olarak oradaki kutuya bakarak veriliyor.
     Ama hedef henüz kimseye bağlı olmadığı için kutusu nötr tonda çiziliyor
     ve kalabalık bir karede hangisi olduğu seçilemiyordu. Bırakılırsa ne
     olacağını önceden gösteriyoruz: kutu KAYNAĞIN rengine bürünüyor.
     Kalıcı değil — kimliğe dokunmuyor, fare çıkınca sönüyor. */
  let dragTint = null;   // { id, color }
  /* Süzgeç boş dönerse "kaç track tarandı" cümlesi için — Object
     ekranındaki `lastScanned` ile aynı iş. */
  let lastScanned = 0;
  /* Şerit tıklamasının ne anlama geldiği — Object ekranındaki `mode`
     ('native'|'reid') ile aynı kavram. Buradaki `mode` değişkeni
     Events/Objects için kullanıldığından ayrı bir ad gerekiyordu. */
  /* HLS istendi mi? Varsayılan `FEATURES.hls` (bugün AÇIK); adresteki
     `?hls=0` kapatıyor, `?hls=1` bayrak kapalıyken bile açıyor. `useHls`
     çalışma sırasında düşebiliyor: kütüphane yoksa Stream'e dönüyoruz. */
  const hlsQ = query && query.get('hls');
  const hlsWanted = hlsQ === '1' || (FEATURES.hls && hlsQ !== '0');
  let useHls = hlsWanted;

  let reidMode = 'native';
  let reid = null;   // { target, cands:Map(key→obj|null), stream, status, got }
  /* Band başına yüklenen veri: `{ events, objects }`. Kip değişince yeniden
     çekilmesin diye ikisi de aynı torbada duruyor. */
  const data = new Map();
  let TL = null, overlay = null, videoEl = null, feed = null;

  const bandOf = (id) => clock.byId(id);
  const keyOf = (o) => idKey(o.group_id, o.video_id, o.track_id);

  /* ---------------------------------------------------------- iskelet --- */
  const vwell = el('div.vwell');
  /* `hit` OLMADAN tuval `pointer-events:none` — kutuların üstüne gelmek de
     tıklamak da imkânsız oluyor (bkz. app.css `.vstack canvas.ovl.hit`).
     Object ekranında bu sınıf baştan beri vardı, koleksiyonda atlanmıştı. */
  const ovlCanvas = el('canvas', { class: 'ovl hit' });
  const camTag = el('div.cl-camtag');
  videoEl = el('video', {
    class: 'vid', playsinline: true, preload: 'metadata',
  });
  /* Sürüklerken "neyi neye bağlıyorum" sorusu ekranda yazmalı: iki kırpım
     yan yana. Videonun üstünde duruyor çünkü göz zaten orada — karar tam
     olarak bu iki fotoğrafa bakarak veriliyor (bkz. objects.js op-cmp). */
  const cmpStrip = el('div.op-cmp');
  cmpStrip.style.display = 'none';
  /* `.fill`: kuyuyu kapla, video `object-fit: contain` ile içine sığsın.
     Bu sınıf olmadan `.vstack` yüksekliği içeriğe bağlı kalıyor, tuval de
     onunla birlikte ölçüsüz kalıyordu — kutular ya hiç çizilmiyor ya da
     kaymış çıkıyordu. */
  vwell.append(el('div.vstack.fill', {}, videoEl, ovlCanvas), camTag, cmpStrip);

  const { node: ctl, btnPlay, scrub, tcode } = playerControls({
    duration: AXIS,
    seek: (t) => seek(t),
    cur: () => axisT,
    overlay: () => overlay,
    videoEl: () => videoEl,
    fullscreenOf: () => vwell,
  });

  /* RENK OYNATMA ŞERİDİ — ▶ ⟲ ⟳ üçlüsünün hemen yanında.
     Koleksiyondaki her renk için bir düğme. Basınca yalnızca o rengin
     şeritleri oynuyor, aradaki boşluklar atlanıyor: "bu adamı baştan sona
     göster" isteğinin karşılığı bu. Yeri oynatma düğmelerinin yanında,
     çünkü yaptığı iş oynatmak — panel başlığına ya da sağ bara koymak onu
     bir süzgeç gibi gösterirdi. */
  const reelBar = el('div.cl-reel');
  reelBar.style.display = 'none';
  ctl.insertBefore(reelBar, tcode);

  const tlCanvas = el('canvas.tlcanvas');

  /* ------------------------------------------------------- kip anahtarı --
     Object ekranındakinin AYNISI, aynı sınıflarla. Fark kapsamda: orada
     sunucu tek grubun içini tarıyor, burada KOLEKSİYONUN tamamını
     (bkz. backend.js reidStream — `collectionId`). Zaten koleksiyon
     ekranının istediği soru bu: "bu adam öbür kamerada da var mı". */
  const reidSw = el('input', {
    type: 'checkbox', id: 'clreidsw',
    onchange: (e) => setReidMode(e.target.checked ? 'reid' : 'native'),
  });
  const modeBox = el('label.swx', {
    for: 'clreidsw',
    title: 'Off — native: colour and link the tracks yourself.\n'
      + 'On — Re-ID: the server ranks matching tracks across every group '
      + 'in this collection and streams them in.',
  }, reidSw, el('span.swx-t'), el('span.swx-l', {}, 'Re-ID'));

  /* Akışın durumu: kaç aday geldi, sürüyor mu, hedef kim. Boş bir timeline
     ile "sunucu düşündü ama bir şey bulamadı" ayrımı ancak burada okunuyor. */
  const reidInfo = el('span', { class: 'tiny' }, '');
  const reidExit = el('button.btn.sm.ghost', {
    title: 'Back to all objects (Esc)',
    onclick: () => stopReid(),
  }, '✕');
  const reidBar = el('div.op-reidbar', {}, reidInfo, el('span.grow'), reidExit);
  reidBar.style.display = 'none';

  /* HEPSİNİ AÇ / HEPSİNİ KAPAT.
     Sağ üstte eskiden bir ipucu cümlesi duruyordu ("hover a group to
     expand…"). İki sebeple gitti: ilki, üç kullanımdan sonra kimse okumuyor
     ama yer kaplamaya devam ediyor; ikincisi, orası ekranın tıklanmaya en
     müsait köşesi ve orada tıklanamayan bir metnin durması boşa duruyordu.
     Yerine hover açılımının kalıcı hâli geldi: iki bandı yan yana
     karşılaştırmak için ikisinin birden açık olması gerekiyor ve fare iki
     bandın üstünde birden duramıyor. */
  const expandBtn = el('button.btn.sm.ghost', {
    title: 'Open every group at once, instead of only the one under the '
      + 'cursor. The panel keeps its height — a long list scrolls inside it, '
      + 'so the video never changes size.\n'
      + 'Wheel zooms the time axis · Ctrl + wheel scrolls the list.',
    onclick: () => setExpandAll(!TL.expandAll),
  }, '⌄ Expand all');

  const tlBody = el('div.panel-b', { style: { padding: '6px' } }, tlCanvas);
  const tlPanel = el('div.panel.cl-tl.op-tlpanel', {},
    el('div.panel-h', {}, 'Object tracking segment',
      /* Bayrak kapalıysa anahtar hiç çizilmiyor: ekran bugünkü native
         davranışında kalır, kod silinmez. */
      FEATURES.reid ? modeBox : null,
      el('span.grow'),
      expandBtn),
    reidBar,
    tlBody);

  const modeSw = el('div.cl-modes', {},
    ...[['events', 'Events'], ['objects', 'Objects']].map(([k, label]) =>
      el('button.btn.sm', {
        class: mode === k ? 'pri' : 'ghost',
        onclick: () => setMode(k),
      }, label)));

  /* Hizalama anahtarı. `wallOverlapRatio` düşükse ipucunda ne olacağını
     önceden söylüyor: gerçek saate geçen kullanıcı boş bir eksenle
     karşılaşıp ekranın bozulduğunu sanmasın. */
  const overlap = clock.wallOverlapRatio();

  /* Ekranı baştan kuran anahtarların ortak adres kurucusu: hangi anahtara
     basılırsa basılsın ötekilerin seçimi adreste korunuyor. */
  const link = (o = {}) => {
    const a = o.align !== undefined ? o.align : align;
    const m = o.mode !== undefined ? o.mode : mode;
    const h = o.hls !== undefined ? o.hls : hlsWanted;
    return `#/collection/${col.id}?mode=${m}`
      + (a === 'wall' ? '&align=wall' : '')
      + (h ? '&hls=1' : '&hls=0');
  };

  const alignSw = el('div.cl-modes', {},
    ...[['zero', 'Aligned'], ['wall', 'Real clock']].map(([k, label]) =>
      el('button.btn.sm', {
        class: align === k ? 'pri' : 'ghost',
        title: k === 'zero'
          ? 'Every group starts at 00:00, as if they were recorded at the '
            + 'same time. Easiest to compare, but the clock is not real.'
          : 'Groups sit on the real clock, using their start times.'
            + (overlap < 0.6
              ? `\n⚠ These groups barely overlap (${Math.round(overlap * 100)}%`
                + ' of the axis has a recording) — most of the timeline will '
                + 'be empty.'
              : ''),
        onclick: () => { location.hash = link({ align: k }); },
      }, label)));

  /* Oynatma yolu anahtarı. Kip değiştirmek oynatıcıyı, saat çevirisini ve
     kutu beslemesini birden değiştiriyor; ekranı baştan kurmak her birini
     ayrı ayrı doğru yapmaya çalışmaktan hem kısa hem güvenilir — hizalama
     anahtarıyla aynı gerekçe. */
  const hlsSw = el('div.cl-modes', {},
    ...[[false, 'Stream'], [true, 'HLS']].map(([k, label]) =>
      el('button.btn.sm', {
        class: hlsWanted === k ? 'pri' : 'ghost',
        title: k
          ? 'One playlist per group: the browser plays the parts back to '
            + 'back. Needs web/vendor/hls.min.js.'
          : 'The older path: each recording is loaded as its own video and '
            + 'the screen switches between them.',
        onclick: () => { location.hash = link({ hls: k }); },
      }, label)));

  /* Sonuç sayacı Object ekranındaki `totalLbl` ile aynı yerde: başlığın
     sağında. Izgara başlığına koymak ikisini ayrıştırırdı. */
  const totalLbl = el('span', { class: 'tiny muted' }, '');

  const warn = el('div.op-banner');
  warn.style.display = 'none';
  if (clock.floating.length) {
    warn.append(
      el('span.op-bannerico', {}, '⚠'),
      el('span.grow', {},
        el('b', {}, `${clock.floating.length} group(s) have no start time. `),
        'They are pinned to the beginning of the collection, so their '
        + 'position on the clock is a guess. Set the start time in Manage '
        + 'to place them correctly: ',
        clock.floating.map((b) => b.name).join(', ')));
    warn.style.display = '';
  }

  /* SAĞ PANEL — Object ekranındakinin aynısı.
     Nesne kipinde kırpım ızgarası: "bu ikisi aynı adam mı" sorusu ancak
     fotoğraflara bakarak cevaplanıyor, metin listesi o işi görmüyor. Zaman
     çizgisinde bir şeridin üstüne gelmek buradaki kartı vurgulayıp görünür
     yere kaydırıyor (bkz. hotCard). Olay kipinde ise metin doğru biçim —
     olayın kendisi zaten bir cümle. */
  const grid = el('div.objgrid');
  const objPanel = el('div.panel.op-objpanel', {},
    el('div.panel-h', {}, 'Object', el('span.grow'),
      el('span', { class: 'tiny muted' }, 'bestshot')),
    el('div.panel-b', {}, grid));

  /* Arama paneli Object ekranındakiyle aynı bileşen. Fark yalnızca sonucun
     nereden geldiği: orada tek kayıt, burada koleksiyondaki BÜTÜN grupların
     bütün parçaları. */
  const search = buildSearch((sel) => reloadObjects(sel));

  const listBody = el('div.panel-b', {}, skeletonRows(6));
  const listCount = el('span', { class: 'tiny muted' }, '');
  const listPanel = el('div.panel.cl-list', {},
    el('div.panel-h', {}, 'Events', el('span.grow'), listCount),
    listBody);

  /* INFO — Object ekranındaki panelin aynısı, aynı sınıflarla.
     Seçili şeridin kim olduğu, hangi kameradan geldiği ve YANLIŞ
     BAĞLANDIYSA geri alma düğmesi. Bağlama işi burada yapılıyor, dolayısıyla
     bozma işi de burada olmalı — eskiden koleksiyonda unlink'e ulaşmanın
     hiçbir yolu yoktu. */
  const infoClear = el('button.btn.sm.ghost', {
    title: 'Clear selection (Esc)',
    onclick: () => { selected = null; showInfo(null); syncAll(); },
  }, '✕');
  infoClear.style.display = 'none';
  const infoBody = el('div.panel-b.op-info', {});
  /* `.cl-info`: panel artık videonun altında geniş bir şerit değil, yanında
     dar bir sütun. İçerik de ona göre diziliyor (bkz. showInfo). */
  const infoPanel = el('div.panel.op-infopanel.cl-info', {},
    el('div.panel-h', {}, 'Info', el('span.grow'), infoClear),
    infoBody);

  mount(stage,
    el('div.hdr', {},
      el('div.hdr-top', {},
        el('div.crumb', {},
          el('span.par', {}, 'Collection'),
          el('span.sep', {}, '›'),
          el('span.cur', {}, col.name)),
        el('div.grow'),
        alignSw,
        hlsSw,
        modeSw,
        /* Özete giden kapı. Bu ekran ÇALIŞMA ekranı, özet SONUÇ ekranı;
           sıra da bu — önce bağla, sonra sonuca bak. */
        el('a.btn.sm.ghost', {
          href: `#/summary/${col.id}`,
          style: { marginRight: '10px' },
          title: 'Collection summary — every group side by side, with the '
            + 'people you linked traced across the cameras.',
        }, 'Summary →'),
        totalLbl,
        el('span', { class: 'tiny muted' }, clock.summary())),
      warn),
    /* Üst sıra: dar oynatıcı + yanında Info. Zaman çizgisi en altta, kalan
       dikey alanın tamamı onun (bkz. app.css `.cl-top`). */
    el('div.cl-top', {},
      el('div.panel.cl-player', {}, vwell, ctl),
      infoPanel),
    tlPanel);
  mount(rightbar, objPanel, listPanel, search.node);

  /* ============================================================ oynatma ===
     İKİ OYNATMA YOLU, TEK EKSEN

     HLS (varsayılan): bandın grubu için tek bir çalma listesi bağlanıyor
     (`/playback/groups/{gid}/hls/media.m3u8`). Parçalar uç uca, geçişi
     tarayıcı yapıyor. Oynatıcı grubun ÇALMA ekseninde sayıyor.

     Stream (eski yol): her parça ayrı `<video src>`. Oynatıcı PARÇA
     içinde sayıyor.

     Ekran ise her iki durumda da KOLEKSİYON ekseninde çalışıyor. Çeviri:
       eksen sn  →(Band.fromAxis)→  band duvar sn  →(playFromWall)→  çalma sn
     ve tersi. Bütün dönüşüm `place()` ile `readAxis()` içinde; başka hiçbir
     yer oynatıcının saatine dokunmuyor. */

  /* Metadata gelmeden `currentTime` yazmak sessizce yutuluyor. İstenen anı
     saklayıp hazır olunca uyguluyoruz — yoksa band değiştirince video hep
     baştan başlardı. */
  let wantTime = null;

  function setTime(sec) {
    const v = Math.max(0, sec || 0);
    if (videoEl.readyState >= 1) { videoEl.currentTime = v; wantTime = null; }
    else wantTime = v;
  }
  videoEl.addEventListener('loadedmetadata', () => {
    if (wantTime == null) return;
    videoEl.currentTime = wantTime;
    wantTime = null;
  });

  /**
   * Kutu beslemesini PARÇAYA bağlar.
   * Track numaraları her videoda 1'den başlıyor; önceki parçanın kutularını
   * taşımak yanlış kişiye etiket yapıştırmak olurdu. HLS'te parça değişimini
   * biz YAPMIYORUZ, yalnızca fark edip beslemeyi taşıyoruz.
   */
  function bindFeed(part) {
    if (activePart && String(activePart.id) === String(part.id)) return;
    activePart = part;
    camTag.textContent = `${active.letter} · ${active.name} · ${part.name}`;
    if (!overlay) return;
    if (feed) { feed.dispose(); feed = null; }
    const v = (active.group.cameras || [])
      .find((x) => String(x.id) === String(part.id)) || {};
    overlay.setDetections(null, { w: v.width, h: v.height });
    if (FEATURES.bbox) {
      feed = bboxFeed(part.id, overlay, { w: v.width, h: v.height }, part.dur);
    }
    /* Etiket/renk tablosu da PARÇAYA bağlı — parça değişince o da değişmeli,
       yoksa yeni videodaki track numaraları eski videonun adlarını alır. */
    syncOverlay();
  }

  /* ------------------------------------------------------------- HLS ---- */
  let hlsSess = null;    // bağlı oturum ({destroy, mode}) ya da null
  let hlsGroup = null;   // playlist'i bağlı olan bandın id'si

  /**
   * Aktif bandın playlist'ini bağlar. Band değişmediyse hiçbir şey yapmıyor:
   * yeniden bağlamak yeni bir manifest isteği ve baştan tamponlama demek.
   *
   * `hls.min.js` yoksa ya da manifest açılamazsa Stream yoluna düşüyoruz —
   * sessizce boş bir oynatıcı bırakmak en kötüsü olurdu.
   *
   * @returns {boolean} YENİ bir playlist bağlandı mı. Çağıran bunu bilmek
   *   zorunda: yeni kaynak yüklenirken `currentTime` yazmak ESKİ medyaya
   *   gider ve yeni medya sıfırdan başlar. O durumda istenen an
   *   `wantTime`e bırakılıyor ve metadata gelince uygulanıyor.
   */
  function bindHls(b) {
    if (!useHls || hlsGroup === b.id) return false;
    hlsGroup = b.id;
    if (hlsSess) { hlsSess.destroy(); hlsSess = null; }
    const gen = b.id;
    attachHls(videoEl, api.hlsUrl(b.id), {
      onReady: (d, yol) => {
        console.info('[hls] bağlandı (collection)', { grup: b.name, yol, süre: d });
      },
      onError: (msg) => toast(`HLS (${b.name}): ${msg}`, 'err', 6000),
    }).then((h) => {
      if (hlsGroup !== gen) { if (h) h.destroy(); return; }   // band değişti
      if (h) {
        hlsSess = h;
        /* hls.js kaynağı değiştiriyor — aynı gerekçe. */
        if (overlay) overlay.start();
        return;
      }
      /* Kütüphane yok — bütün ekran eski yola dönüyor. */
      useHls = false;
      hlsGroup = null;
      toast('hls.js bulunamadı — normal oynatıcıya dönüldü', 'warn', 6000);
      place(axisT, true);
    });
    return true;
  }
  onLeave(() => { if (hlsSess) hlsSess.destroy(); });

  /**
   * Oynatıcıyı eksendeki bir ana getirir.
   * @param {boolean} [force] parça aynı olsa bile kaynağı yeniden kur
   */
  function place(t, force) {
    if (useHls) {
      const wall = Math.max(0, active.fromAxis(t));
      const play = Math.max(0, active.clock.playFromWall(wall));
      if (bindHls(active)) wantTime = play;   // yeni kaynak — metadata bekle
      else setTime(play);
      const hit = active.at(t);
      if (hit) bindFeed(hit.part);
      return;
    }
    const hit = active.at(t);
    if (!hit) return;
    const same = !force && activePart
      && String(activePart.id) === String(hit.part.id);
    bindFeed(hit.part);
    if (!same) {
      activePart = hit.part;
      videoEl.src = api.streamUrl(hit.part.id);
      videoEl.load();
      /* `load()` medyayı sıfırlarken bekleyen kare geri çağrısını da
         düşürüyor; döngü yeniden kurulmazsa kutular İKİNCİ videodan
         itibaren hiç çizilmiyor (bkz. overlay.js start). */
      if (overlay) overlay.start();
    }
    setTime(hit.offset);
  }

  /**
   * Ekseninde bir ana git.
   *
   * Aktif band o anda kayıt yapmıyorsa (kendi boşluğunda) `Band.at()` bir
   * sonraki kaydın başına yuvarlıyor — ama playhead OLDUĞU YERDE kalıyor.
   * Sebep: eksen koleksiyonun eksenidir, aktif bandın değil; kullanıcı
   * 14:18'e bakmak istiyorsa öteki bandlar orada kayıt yapıyor olabilir ve
   * playhead'i kaydırmak onların okunmasını bozardı.
   */
  function seek(t) {
    /* Elle arama parça listesini bitiriyor. Listenin kendi atlayışları da
       buradan geçtiği için ayrım `clipSeek` ile yapılıyor — yoksa liste ilk
       atlayışında kendini iptal ederdi. */
    if (clip && !clipSeek) stopClip();
    axisT = Math.max(0, Math.min(AXIS, t || 0));
    place(axisT);
    paint();
  }

  /**
   * Oynatıcıyı başka bir gruba devret — aynı gerçek saatte kalarak.
   * Hover ile çağrılıyor; o grup o anda kayıt yapmıyorsa devir YAPILMIYOR,
   * çünkü gösterilecek görüntü yok ve ekran boşalırdı.
   */
  function handover(bandId) {
    /* Parça listesi oynarken devir YOK. Liste zaten hangi kameranın
       oynayacağını parça parça söylüyor; farenin başka bir bandın üstünde
       durması onu ortasından kesip başka bir görüntüye atlatırdı. */
    if (clip) return;
    const b = bandOf(bandId);
    if (!b || b === active) return;
    if (!b.covers(axisT)) return;
    active = b;
    place(axisT);
    paint();
  }

  /* ====================================================== parça oynatma ====
     Oynatıcıyı bir ARALIK LİSTESİNE bağlar: her aralığın başına gidiyor,
     sonuna gelince bir sonrakine atlıyor, liste bitince duruyor. Aradaki
     boşluklar — o kişinin görünmediği dakikalar — hiç oynatılmıyor.

     İki çağıran var ve ikisi de aynı motoru kullanıyor:
       · bir şeride tıklamak → tek elemanlı liste ("yalnızca bu bbox")
       · bir renge basmak    → o rengin bütün şeritleri, zaman sırasında

     Aralıklar KOLEKSİYON EKSENİNDE ve kendi bandlarını taşıyor: liste
     kameradan kameraya geçebiliyor, çünkü bir kişi zaten kameralar arasında
     dolaşıyor. */

  /** Listeyi kurar ve ilk parçadan başlatır. */
  function playClips(segs, color) {
    if (!segs || !segs.length) return;
    clip = { segs, i: -1, color: color || null, guard: 0 };
    stepClip();
    renderReel();
  }

  /** Sıradaki parçaya geç; liste bittiyse dur. */
  function stepClip() {
    if (!clip) return;
    clip.i += 1;
    if (clip.i >= clip.segs.length) {
      /* Bitişte DURUYOR, başa dönmüyor: liste bir soruya verilen cevap
         ("bu kişi nerede görünmüş"), cevap bitince ekran da bitiyor. */
      stopClip();
      videoEl.pause();
      return;
    }
    const s = clip.segs[clip.i];
    active = s.b;
    /* Kaynak değişimi kısa bir süre eski saati göstermeye devam ediyor;
       bu pencerede bitiş kontrolü yapılmıyor (bkz. CLIP_SETTLE). */
    clip.guard = performance.now() + CLIP_SETTLE;
    clipSeek = true;
    seek(Math.max(0, s.t0 - CLIP_PAD));
    clipSeek = false;
    videoEl.play().catch(() => {});
  }

  /** Listeyi bırak — oynatıcı serbest kalıyor, olduğu yerde devam ediyor. */
  function stopClip() {
    if (!clip) return;
    clip = null;
    renderReel();
  }
  onLeave(stopClip);

  /** Her `timeupdate`da: bu parça bitti mi? */
  function clipTick() {
    if (!clip) return;
    const s = clip.segs[clip.i];
    if (!s || active !== s.b) return;
    if (performance.now() < clip.guard) return;
    if (axisT >= s.t1) stepClip();
  }

  /**
   * Bir rengin bütün şeritleri, tek liste.
   *
   * Renk kişinin kendisi demek (bkz. dosya başındaki BAND_TINT açıklaması):
   * bir kişiye renk verildiğinde o renk kimlik üzerinden bütün kameralardaki
   * eşlerine de gidiyor. Dolayısıyla "kırmızıyı oynat" = "bu adamı bütün
   * kameralarda, baştan sona göster".
   *
   * Aynı bandda üst üste binen ya da burun buruna gelen şeritler
   * birleştiriliyor: model bir yürüyüşü saniyeler içinde birkaç track'e
   * bölebiliyor ve her birini ayrı parça saymak aynı üç saniyeyi beş kez
   * oynatmak olurdu.
   */
  function playColor(color) {
    const segs = [];
    for (const b of clock.bands) {
      const d = data.get(b.id);
      if (!d) continue;
      for (const o of d.objects) {
        if (o._color !== color) continue;
        segs.push({ b, t0: o._t0, t1: Math.max(o._t1, o._t0 + CLIP_MIN) });
      }
    }
    segs.sort((x, y) => x.t0 - y.t0);
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && last.b === s.b && s.t0 <= last.t1 + CLIP_PAD) {
        last.t1 = Math.max(last.t1, s.t1);
      } else merged.push({ b: s.b, t0: s.t0, t1: s.t1 });
    }
    if (!merged.length) return;
    playClips(merged, color);
  }

  /**
   * Renk şeridini kurar — koleksiyonda KULLANILMIŞ renkler, kullanıldıkları
   * sırayla. Palet değil: boyanmamış bir renk için düğme çıkarmak, basınca
   * hiçbir şey oynatmayan bir düğme demek olurdu.
   */
  function renderReel() {
    const seen = new Map();   // renk → { n, person, secs }
    for (const b of clock.bands) {
      const d = data.get(b.id);
      if (!d) continue;
      for (const o of d.objects) {
        if (!o._color) continue;
        const e = seen.get(o._color) || { n: 0, person: null, secs: 0 };
        e.n += 1;
        e.secs += Math.max(o._t1 - o._t0, CLIP_MIN);
        if (!e.person && o._person) e.person = o._person;
        seen.set(o._color, e);
      }
    }
    clear(reelBar);
    reelBar.style.display = seen.size ? '' : 'none';
    if (!seen.size) return;
    for (const [color, info] of seen) {
      const on = !!clip && clip.color === color;
      reelBar.append(el('button.cl-reelbtn', {
        class: on ? 'on' : '',
        style: { background: color },
        title: `${info.person || 'Coloured tracks'} — `
          + `${info.n} segment(s), about ${dur(info.secs)} of video.\n`
          + (on ? 'Playing. Click to stop.'
            : 'Plays only these segments, back to back, skipping everything '
              + 'in between.'),
        onclick: () => {
          if (on) { stopClip(); videoEl.pause(); return; }
          playColor(color);
        },
      }, on ? '❚❚' : '▶'));
    }
  }

  /* ------------------------------------------------------------- çizim -- */
  function paint() {
    TL.playhead = axisT;
    /* Hangi bandın oynadığı band başlığındaki düğmede görünüyor. */
    TL.playingBand = active ? active.id : null;
    TL.paused = videoEl.paused;
    TL.draw();
    tcode.firstChild.textContent = clock.clock(axisT);
    const pct = (axisT / (AXIS || 1) * 100) + '%';
    scrub.querySelector('.fill').style.width = pct;
    scrub.querySelector('.knob').style.left = pct;
  }

  /** Bir bandın şeritleri — kipe göre olaylardan ya da nesnelerden. */
  function lanesOf(b, maxRows) {
    const items = mode === 'events'
      ? ((data.get(b.id) || {}).events || [])
      : objectsOf(b);
    if (!items.length) return [{ id: `${b.id}:0`, label: '', events: [] }];
    const rows = [];       // satır başına son bitiş
    const lanes = [];
    const minW = Math.max(0.5, AXIS * 0.002);

    for (const it of items) {
      const t0 = it._t0;
      const t1 = Math.max(it._t1, t0 + minW);
      let r = rows.findIndex((end) => t0 >= end + minW);
      if (r === -1) {
        if (rows.length < maxRows) {
          r = rows.length;
          rows.push(0);
          lanes.push({ id: `${b.id}:${r}`, label: '', events: [] });
        } else {
          r = rows.indexOf(Math.min(...rows));
        }
      }
      rows[r] = Math.max(rows[r], t1);

      /* Renk yalnızca kişiden geliyor; bağlanmamış şerit sönük sınıf tonunda
         kalıyor (bkz. dosya başındaki BAND_TINT açıklaması). */
      const color = it._color || (mode === 'events' ? it.color : tintOf(it))
        || CLASS_TINT.other;
      lanes[r].events.push({
        id: it.id,
        t_start: t0,
        t_end: t1,
        color,
        marked: !!it._person,
        type: it._person || '',
        description: it._desc,
        severity: it.severity,
      });
    }
    return lanes.length ? lanes : [{ id: `${b.id}:0`, label: '', events: [] }];
  }

  /**
   * Re-ID sürüyorsa ekrandaki KÜME: hedef + gelen adaylar.
   * `null` dönerse Re-ID kapalı, normal liste geçerli.
   *
   * İstenen buydu: "bir objeye tıklandığında diğer tüm barlar kaybolacak".
   * Kalabalık kalsaydı akışla gelen adaylar arasında kaybolurlardı.
   */
  function reidObjects() {
    if (!reid || mode !== 'objects') return null;
    const out = [reid.target];
    for (const o of reid.cands.values()) if (o) out.push(o);
    return out;
  }

  /** Bir bandın o an gösterilecek nesneleri. */
  function objectsOf(b) {
    const all = reidObjects();
    if (!all) return (data.get(b.id) || {}).objects || [];
    return all
      .filter((o) => String(o.group_id) === String(b.id))
      .sort((x, y) => x._t0 - y._t0);
  }

  /* ZAMAN ÇİZGİSİNİN YERİ BAŞTAN AYRILIYOR.
     Panel içeriğine göre büyüyordu: bir bandın üstüne gelmek tuvali
     uzatıyor, panel de onunla birlikte uzayıp yukarıdaki videoyu
     küçültüyordu; fare çıkınca video geri büyüyordu. Bakılan görüntünün
     boyu farenin nerede durduğuna bağlı kalmış oluyordu.

     Şimdi panelin gövdesi EN KÖTÜ DURUMA göre sabitleniyor — bir band
     açıkken gereken yükseklik (bkz. timeline.js reservedHeight). Açılım
     artık paneli değil yalnızca tuvali büyütüyor, ayrılan yerden uzun
     kalırsa da panel kendi içinde kayıyor. Video hiç kıpırdamıyor. */
  function fitReserve() {
    if (!TL) return;
    /* +12: gövdenin kendi iç boşluğu (padding 6px, border-box). */
    tlBody.style.height = (TL.reservedHeight() + 12) + 'px';
  }

  /** Başlıktaki aç/kapa düğmesi. */
  function setExpandAll(on) {
    TL.setExpandAll(on);
    expandBtn.textContent = TL.expandAll ? '⌃ Collapse all' : '⌄ Expand all';
    expandBtn.classList.toggle('pri', TL.expandAll);
    expandBtn.classList.toggle('ghost', !TL.expandAll);
    syncAll();
  }

  function syncAll() {
    /* Kişi etiketi ve rengi her çizimden önce kimlik kümesinden tazeleniyor:
       bağlantı değişince bütün bandlardaki aynı kişi birlikte değişmeli. */
    const touch = (o) => {
      o._person = ids ? ids.labelOf(keyOf(o)) : null;
      o._color = ids ? ids.colorOf(keyOf(o)) : null;
    };
    for (const b of clock.bands) {
      const d = data.get(b.id);
      if (d) d.objects.forEach(touch);
    }
    /* Re-ID adayları `data` içinde değil — akıştan geliyorlar. Onların da
       kişi etiketi tazelenmeli, yoksa bir adayı hedefe bağladıktan sonra
       şeridi hâlâ renksiz kalırdı. */
    (reidObjects() || []).forEach(touch);
    TL.setData({
      bands: clock.bands.map((b) => ({
        id: b.id,
        label: `${b.letter} · ${b.name}`,
        sub: b.anchored ? '' : '⚠ no start time',
        color: b.color,
        spans: b.spans,
        lanes: lanesOf(b, TL && (TL.expandAll || TL.openBand === b.id)
          ? ROWS_OPEN : ROWS_COLLAPSED),
      })),
      total: AXIS,
      startIso: clock.startIso,
    });
    TL.draw();
    fitReserve();
    renderReel();
    renderList();
    /* Seçili şeridin kişisi/rengi değişmiş olabilir — panel her çizimde
       tazeleniyor, yoksa bağladıktan sonra hâlâ "bağlı değil" yazardı. */
    if (selected) showInfo(selected);
    syncOverlay();
  }

  /**
   * Kutuların bildiği şeyler — Object ekranındaki `syncAll`in aynı parçası.
   *
   *   setTrackMeta → kutunun etiketinde SINIF ADI ve PAR bilgisi; kutuda
   *                  yalnızca track numarası geliyor, gerisi listeden.
   *   colorOf      → kişiye bağlanmış track'ler kendi renginde, ötekiler
   *                  nötr. Fare kutunun üstüne gelince vurgulanan da bu.
   *
   * İkisi de AKTİF PARÇAYA göre: track numaraları her videoda 1'den
   * başlıyor, başka parçanın tablosunu vermek yanlış kişiye etiket
   * yapıştırmak olurdu.
   */
  function syncOverlay() {
    if (!overlay || !activePart) return;
    const d = data.get(active.id);
    const here = d
      ? d.objects.filter((o) => String(o.video_id) === String(activePart.id))
      : [];
    overlay.setTrackMeta(here);
    /* Sürükleme ön izlemesi gerçek rengin YERİNE değil, YOKLUĞUNDA geçiyor:
       hedefin kendi rengi varsa o kalıyor (bkz. dragTint). */
    const tintOfObj = (o) => o._color
      || (dragTint && dragTint.id === o.id ? dragTint.color : null);
    overlay.colorOf = new Map(here
      .map((o) => [o.track_id, tintOfObj(o)])
      .filter(([, c]) => !!c));
  }

  /* --------------------------------------------------------- sağ panel -- */
  function renderList() {
    /* Kip hangi paneli göstereceğini belirliyor; ikisi de sağ barda duruyor
       ve yalnızca biri görünüyor. Panelleri kaldırıp yeniden kurmak yerine
       gizlemek, kaydırma konumunu ve vurguyu koruyor. */
    objPanel.style.display = mode === 'objects' ? '' : 'none';
    listPanel.style.display = mode === 'events' ? '' : 'none';
    if (mode === 'objects') return renderGrid();
    const rows = [];
    for (const b of clock.bands) {
      const d = data.get(b.id);
      if (!d) continue;
      for (const it of (mode === 'events' ? d.events : d.objects)) {
        rows.push({ b, it });
      }
    }
    rows.sort((x, y) => x.it._t0 - y.it._t0);
    listCount.textContent = `${rows.length}`;
    clear(listBody);
    if (!rows.length) {
      listBody.append(el('div.empty', {}, 'Nothing loaded yet.'));
      return;
    }
    for (const { b, it } of rows) {
      const row = el('div.cl-row', {
        class: selected && selected.id === it.id ? 'on' : '',
        title: it._desc,
        onclick: () => {
          selected = it;
          /* Listeden tıklamak HEM zamana gider HEM o kameraya geçer:
             satırda yazan kamera ile ekranda görünen kamera farklı olursa
             kullanıcı yanlış görüntüye bakıp olayı yok sanıyor. */
          active = b;
          seek(it._t0);
          syncAll();
          showInfo(it);
          videoEl.play().catch(() => {});
        },
      },
        el('span.cl-dot', {
          style: { background: it._color || it.color || CLASS_TINT.other },
        }),
        el('div.grow', {},
          el('div.cl-rowt', {}, it._title),
          el('div', { class: 'tiny muted' },
            `${b.letter} · ${b.name} · ${clock.clock(it._t0)}`)),
        it._person ? el('span.cl-person', {
          style: { color: it._color || '#e8eef6' },
        }, it._person) : null);
      listBody.append(row);
    }
  }

  /* ------------------------------------------------------------- info ----
     Seçili şerit hakkında bilinen her şey ve onunla yapılabilecek iki iş:
     başına git, kişiden kopar. Nesne kipinde kırpım da geliyor; olay
     kipinde olayın cümlesi. */
  function showInfo(o) {
    clear(infoBody);
    infoClear.style.display = o ? '' : 'none';
    if (!o) {
      infoBody.append(el('div.cl-infohint', { class: 'muted' },
        'Click a segment to jump the video there. Drag from one group’s '
        + 'segment onto another’s to say "same person".'));
      return;
    }
    const b = bandOf(o.group_id);
    const key = o.track_id != null ? keyOf(o) : null;
    const person = key && ids ? ids.labelOf(key) : null;
    const mark = key && ids ? ids.colorOf(key) : null;

    const span = o._t1 > o._t0 + 0.5
      ? `${clock.clock(o._t0)} – ${clock.clock(o._t1)}`
      : clock.clock(o._t0);

    /* DAR SÜTUN DÜZENİ.
       Eskiden hepsi tek satırdaydı ("Person 3 · #12 person · A · Giriş ·
       18:02–18:03") çünkü panel videonun altında boydan boya uzanıyordu.
       Panel artık videonun yanında ve dar; o satırın yarısı üç noktaya
       dönüşürdü. Her bilgi kendi satırında, en önemlisi en üstte. */
    infoBody.append(el('div.cl-inforow', {},
      o.crop
        ? el('img', {
          class: 'cl-infoim', src: o.crop,
          style: mark ? { boxShadow: `0 0 0 2px ${mark}` } : {},
          onerror: (e) => { e.target.style.visibility = 'hidden'; },
        })
        : null,
      el('div.cl-infocol', {},
        /* Kişi adı en başta ve TEK renkli şey: koleksiyonda okunacak ilk
           bilgi bu, ve renk yalnızca kişiyi anlatıyor. */
        person
          ? el('div.cl-infoperson', { style: { color: mark || '#e8eef6' } },
            person)
          : null,
        el('div.cl-infottl', { title: o._title }, o._title),
        /* Hangi kamera — harf + ad. Renk vermiyoruz. */
        b ? el('div.cl-infometa', { title: b.name },
          `${b.letter} · ${b.name}`) : null,
        el('div.cl-infometa', {}, span))),
      /* Açıklama kendi satırında ve üç satırda kesiliyor; tamamı ipucunda. */
      o._desc
        ? el('div.cl-infodesc', { title: o._desc }, o._desc)
        : null,
      el('div.cl-infoacts', {},
        el('button.btn.sm.ghost', {
          title: `Play from ${clock.clock(o._t0)} on `
            + `${b ? `${b.letter} · ${b.name}` : ''}.`,
          onclick: () => {
            if (b) active = b;
            seek(o._t0);
            paint();
            videoEl.play().catch(() => {});
          },
        }, '▶ From start'),
        /* Rengi kaldırmak ile kişiyi çözmek AYRI iki iş — Object
           ekranındaki gibi iki ayrı düğme. */
        mark
          ? el('button.btn.sm.ghost', {
            title: person
              ? `Removes the colour from ${person}. The person link stays — `
                + 'use Unlink for that.'
              : 'Removes the colour from this track.',
            onclick: () => setMark(o, null),
          }, '○ Clear colour')
          : null,
        person
          ? el('button.btn.sm.ghost.op-unlinkbtn', {
            title: `Removes ${o._title} from ${person}. The other tracks `
              + 'stay linked only where they were linked directly to each '
              + 'other.',
            onclick: async () => {
              try {
                await ids.unlink(key);
                toast(`${o._title} unlinked from ${person}`, 'ok', 2600);
              } catch (e) {
                toast('Unlink failed: ' + e.message, 'err', 6000);
              }
              syncAll();
              showInfo(o);
            },
          }, '⊘ Unlink')
          : null));
  }

  /**
   * Rengi değiştirir — KİMLİĞE DOKUNMAZ (bkz. objects.js setMark).
   * Nesne bir kişiye bağlıysa renk o kişinin bütün track'lerine gidiyor,
   * yani koleksiyonda verilen renk öteki kameradaki eşinde de görünüyor.
   */
  function setMark(o, color) {
    if (!ids) return;
    ids.setColor(keyOf(o), color);
    syncAll();
    if (selected && selected.id === o.id) showInfo(o);
  }

  /* ------------------------------------------------------- renk seçici ---
     Object ekranındakiyle aynı kutu, aynı sınıflar. Kartın üstündeki
     noktaya basınca açılıyor; içinde renkler ve — kişi varsa — Unlink.
     Aynı anda tek kutu açık kalıyor. */
  let pop = null;

  function closePalette() {
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onPopEsc, true);
  }
  const onOutside = (e) => { if (pop && !pop.contains(e.target)) closePalette(); };
  const onPopEsc = (e) => { if (e.key === 'Escape') closePalette(); };
  onLeave(closePalette);

  function openPalette(anchorEl, o) {
    const already = pop && pop.dataset.for === o.id;
    closePalette();
    if (already) return;

    const key = keyOf(o);
    const cur = ids ? ids.colorOf(key) : null;
    const person = ids ? ids.labelOf(key) : null;
    const b = bandOf(o.group_id);
    pop = el('div.op-pop', { 'data-for': o.id },
      el('div.op-poph', {},
        (person ? `${person} · ` : '') + `${o._title}`
        + (b ? ` · ${b.letter} ${b.name}` : '')),
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
        }, '✕')),
      person
        ? el('button.btn.sm.ghost.op-unlink', {
          title: 'Removes this track from the person. Other tracks stay '
            + 'linked only where they were linked directly.',
          onclick: async () => {
            closePalette();
            try {
              await ids.unlink(key);
              toast(`${o._title} unlinked from ${person}`, 'ok', 2400);
            } catch (e) { toast('Unlink failed: ' + e.message, 'err', 6000); }
            syncAll();
            if (selected && selected.id === o.id) showInfo(o);
          },
        }, `Unlink from ${person}`)
        : null);
    document.body.append(pop);

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
    document.addEventListener('keydown', onPopEsc, true);
  }

  /* -------------------------------------------------------- kırpım ızgarası
     Bütün grupların nesneleri TEK ızgarada, zamana göre. Grup ayrımı kartın
     üstündeki renkli çubukta: koleksiyonun amacı gruplar ARASI eşleştirme,
     yani kartların gruplara ayrılması değil yan yana durması gerekiyor. */
  let hotId = null;

  function renderGrid() {
    const all = reidObjects();
    const list = [];
    if (all) {
      /* Izgarada sıra ZAMAN değil RÜTBE: sunucunun en iyi bulduğu aday ilk
         kartta olsun. Zaman çizgisi zaten zamana göre diziyor. */
      for (const o of [...all]
        .sort((x, y) => (x.reid_rank || 0) - (y.reid_rank || 0))) {
        const b = bandOf(o.group_id);
        if (b) list.push({ b, o });
      }
    } else {
      for (const b of clock.bands) {
        const d = data.get(b.id);
        if (!d) continue;
        for (const o of d.objects) list.push({ b, o });
      }
      list.sort((x, y) => x.o._t0 - y.o._t0);
    }
    /* Re-ID sürerken sayaç arama sonucunu göstermeye devam ediyor: aday
       sayısı zaten durum şeridinde yazıyor ve ikisi çelişirdi. */
    if (!all) {
      const par = Object.keys(search.sel.par).length;
      totalLbl.textContent = par
        ? `${list.length} match · ${lastScanned} tracks scanned`
        : `${list.length} ${search.sel.cls} · ${lastScanned} tracks total`;
    }
    clear(grid);
    if (!list.length) return renderEmpty();

    for (const { b, o } of list) {
      const mark = o._color;
      const person = o._person;
      const span = o._t1 - o._t0;
      const card = el('div.objcard', {
        /* `hot`: sürüklerken bu kartı bulup vurgulayabilmek için —
           bkz. hotCard(). */
        class: [selected && selected.id === o.id ? 'on' : '',
          hotId === o.id ? 'hot' : ''].join(' ').trim(),
        'data-oid': o.id,
        /* İpucu Object ekranındakinin aynısı, başına KAMERA eklenmiş:
           koleksiyonda aynı kırpım iki farklı kameradan gelmiş olabilir ve
           hangisi olduğu kartın kendisinden okunamıyor. */
        title: `${b.letter} · ${b.name}\n` + (person ? `${person}\n` : '')
          + `${o.label}\n${clock.clock(o._t0)}`
          + (span > 0.5 ? ` – ${clock.clock(o._t1)}` : '')
          + (o.conf != null ? `\nconf ${(o.conf * 100).toFixed(0)}%` : '')
          + ((o.par_list || []).length
            ? '\n' + o.par_list.map((x) => x.value).join(' · ') : ''),
        style: mark ? { boxShadow: `inset 0 0 0 2px ${mark}` } : {},
      },
        /* Hangi kamera — RENKLE DEĞİL HARFLE. Object ekranında böyle bir
           rozet yok çünkü orada tek kamera var; koleksiyonda ise kırpım tek
           başına hangi kameradan geldiğini söylemiyor. Rozet tek renkli,
           böylece kartın kenarındaki kişi rengiyle yarışmıyor. */
        el('div.cl-cam', { title: b.name }, b.letter),
        el('img', {
          class: 'im', src: o.crop, loading: 'lazy',
          onerror: (e) => { e.target.style.visibility = 'hidden'; },
        }),
        /* Renk noktası — Object ekranındakiyle aynı yerde, aynı işi
           yapıyor: tıklayınca palet açılıyor, palette Unlink de var. */
        el('button.objdot', {
          class: mark ? 'on' : '',
          style: mark ? { background: mark, color: mark } : {},
          title: (person ? `${person} · ` : '')
            + (mark ? `colour ${mark} — click to change` : 'assign a colour'),
          onclick: (e) => { e.stopPropagation(); openPalette(e.currentTarget, o); },
        }),
        el('div', { class: 'cap' },
          el('div', { class: 't' }, clock.clock(o._t0)),
          el('div', { class: 'nowrap' },
            o.reid_rank
              ? `${o.reid_rank}. ${b.letter} · ${b.name}`
              : (span > 0.5
                ? `${dur(span)} · ${o.class_name}`
                : `#${o.track_id} · ${o.class_name}`))));

      /* Tek tık / çift tık ayrımı Object ekranındaki ile aynı: tarayıcı
         dblclick'ten önce click'i de gönderiyor. */
      let timer = null;
      card.onclick = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          pickObject(o, b);
        }, 220);
      };
      card.ondblclick = () => {
        clearTimeout(timer); timer = null;
        setMark(o, ids && ids.colorOf(keyOf(o)) ? null : ids.nextColor());
      };
      grid.append(card);
    }
  }

  /* Boş durum Object ekranındaki üç cümleyi söylüyor: ne olduğu, NEDEN
     olduğu, oradan nasıl çıkılacağı. Tek fark kapsam — burada "bu videoda"
     değil "bu koleksiyonda". */
  function renderEmpty() {
    if (reid) {
      grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
        el('span', { class: 'big' }, '⋯'),
        el('div', { class: 'ttl' }, 'Waiting for matches'),
        el('div', { class: 'why' },
          'The server is comparing this track with every group in the '
          + 'collection. Candidates appear here and on the timeline as '
          + 'they arrive.')));
      return;
    }
    const filtered = Object.keys(search.sel.par).length > 0;
    grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
      el('span', { class: 'big' }, '⌕'),
      el('div', { class: 'ttl' },
        filtered ? 'No match for these attributes'
          : 'No object in this collection'),
      el('div', { class: 'why' }, filtered
        ? `${lastScanned} track scanned across ${clock.bands.length} group(s). `
          + 'PAR attributes are guesses — narrowing two of them at once '
          + 'usually empties the list.'
        : `The analysis found no ${search.sel.cls} track in these groups. `
          + 'Another class may still have results.'),
      filtered
        ? el('button.btn.sm', {
          onclick: () => { search.reset(); reloadObjects(search.sel); },
        }, 'Clear the filter')
        : null));
  }

  /** Izgaradaki karşılık gelen kartı vurgula ve görünür yere kaydır. */
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

  function cmpFace(o, tint) {
    const b = bandOf(o.group_id);
    return el('div.op-cmpface', {},
      el('img', {
        src: o.crop,
        style: tint ? { boxShadow: `0 0 0 2px ${tint}` } : {},
        onerror: (e) => { e.target.style.visibility = 'hidden'; },
      }),
      el('div', {},
        el('b', {}, `#${o.track_id}`),
        el('div', { class: 'tiny' },
          `${b ? `${b.letter} · ${b.name}` : ''} · ${clock.clock(o._t0)}`)));
  }

  /**
   * "Kimden kime" göstergesi.
   * `to` null ise şerit kapanıyor. `from` yoksa tek kırpım gösteriliyor —
   * sürüklemeden sadece üstüne gelmek de bu yoldan geçiyor, çünkü asıl
   * istenen "farenin altındaki şerit kimin" bilgisi.
   */
  function showCompare(from, to) {
    if (!to || !to.crop) {
      cmpStrip.style.display = 'none';
      hotCard(null);
      return;
    }
    clear(cmpStrip);
    if (from && from.id !== to.id) {
      cmpStrip.append(cmpFace(from, from._color),
        el('span.op-cmparrow', {}, '→'));
    }
    /* Kırpımın çerçevesi de ön izleme rengini alıyor: video üstündeki kutu
       ile yan yana duran fotoğraf aynı şeyi söylemeli. */
    cmpStrip.append(cmpFace(to, to._color
      || (dragTint && dragTint.id === to.id ? dragTint.color : null)));
    if (from && from.id !== to.id) {
      cmpStrip.append(el('span.op-cmphint', {}, 'aynı kişiyse bırak'));
    }
    cmpStrip.style.display = '';
    hotCard(to);
  }

  /* ------------------------------------------------------- veri yükleme --
     Grup grup, PARALEL AMA SINIRLI. Bir koleksiyonda üç grup × üç video
     olabiliyor ve her video iki istek demek; hepsini birden atmak backend'i
     de tarayıcıyı da tıkıyor. Her band bitince ekran yeniden çiziliyor, yani
     kullanıcı ilk grubu beklemeden görüyor. */
  async function loadBand(b) {
    const events = [];
    const objects = [];
    for (const p of b.clock.parts) {
      const vid = p.id;
      try {
        const [ev, ob] = await Promise.all([
          api.events(vid, { limit: 400 }).catch(() => ({ items: [] })),
          /* Sınıf ve PAR süzgeci sağdaki arama panelinden geliyor —
             Object ekranındaki `loadObjects` ile aynı çağrı, aynı
             parametreler (bkz. objsearch.js). */
          api.objects(vid, {
            limit: 400, cls: search.sel.cls, par: parQuery(search.sel),
          }).catch(() => ({ items: [] })),
        ]);
        for (const e of ev.items || []) {
          /* Grup kimliği olayın ÜSTÜNE yazılıyor: zaman çizgisinden ya da
             listeden tıklanınca oynatıcının hangi kameraya geçeceği ancak
             buradan biliniyor. Backend olayda grup bilgisi vermiyor. */
          e.group_id = b.id;
          e._t0 = b.axisOf(vid, e.t_start);
          e._t1 = b.axisOf(vid, e.t_end);
          e._title = e.title;
          e._desc = e.description || e.title;
          e._color = e.color;
          events.push(e);
        }
        lastScanned += ob.returned || (ob.items || []).length;
        for (const o of ob.items || []) objects.push(decorate(o, b, vid));
      } catch (e) {
        console.warn(`[collection] ${b.name}/${vid} okunamadı:`, e.message);
      }
    }
    events.sort((x, y) => x._t0 - y._t0);
    objects.sort((x, y) => x._t0 - y._t0);
    data.set(b.id, { events, objects });
  }

  /**
   * Ham nesneye ekranın kullandığı alanları yazar.
   * `group_id` kritik: zaman çizgisinden ya da ızgaradan tıklanınca
   * oynatıcının hangi kameraya geçeceği ve kimlik anahtarının hangi grubu
   * göstereceği buradan biliniyor.
   */
  function decorate(o, b, vid) {
    o.group_id = b.id;
    o._t0 = b.axisOf(vid, o.t_first);
    o._t1 = b.axisOf(vid, o.has_range ? o.t_last : o.t_first);
    o._title = `#${o.track_id} ${o.class_name}`;
    o._desc = o.label || o._title;
    return o;
  }

  /**
   * Arama panelindeki `Search` — Object ekranındaki `loadObjects`in
   * koleksiyon karşılığı.
   *
   * Fark tek: orada bir kaydın parçaları soruluyor, burada BÜTÜN grupların
   * bütün parçaları. Olaylar yeniden çekilmiyor — süzgeç nesnelere ait ve
   * olay listesinin değişmesi için bir sebep yok.
   */
  async function reloadObjects(sel) {
    /* İstek uzun sürebiliyor; boş ızgara "bozuk" görünüyordu, iskelet
       "geliyor" diyor (bkz. objects.js renderSkeleton). */
    if (mode === 'objects') { clear(grid); grid.append(...skeletonCards(12)); }
    lastScanned = 0;
    const par = parQuery(sel);
    let n = 0;
    for (const b of clock.bands) {
      const objects = [];
      for (const p of b.clock.parts) {
        const r = await api.objects(p.id, { limit: 400, cls: sel.cls, par })
          .catch(() => ({ returned: 0, items: [] }));
        lastScanned += r.returned || (r.items || []).length;
        for (const o of r.items || []) objects.push(decorate(o, b, p.id));
      }
      objects.sort((x, y) => x._t0 - y._t0);
      const d = data.get(b.id) || { events: [] };
      data.set(b.id, { events: d.events, objects });
      n += objects.length;
    }
    /* Seçili nesne süzgeçten düşmüş olabilir; panelde eski bir kaydın
       durmasındansa seçim kalksın. */
    if (selected && !findItem(selected.id)) { selected = null; showInfo(null); }
    syncAll();
    if (!n) {
      toast(par.length
        ? 'No object matches these attributes'
        : `No ${sel.cls} track in this collection`, 'warn');
    }
  }

  /* ---------------------------------------------------------- etkileşim -- */
  function setMode(next) {
    if (mode === next) return;
    /* Olaylar kipinde Re-ID'nin tıklanacak bir hedefi yok; akışı açık
       bırakmak sunucuyu boşuna meşgul ederdi. */
    if (next === 'events') stopReid(true);
    mode = next;
    for (const btn of modeSw.children) {
      const on = btn.textContent.toLowerCase() === next;
      btn.className = on ? 'btn sm pri' : 'btn sm ghost';
    }
    selected = null;
    syncAll();
  }

  /**
   * Band başlığındaki oynat düğmesi.
   *
   * Hover ile devir GEÇİCİ — fare çıkınca geri dönüyor. Bu düğme kalıcı:
   * "şimdi bu kamerayı izliyorum". Aynı band ikinci kez tıklanınca
   * duraklatıyor, çünkü orada duran şey artık bir oynat/duraklat düğmesi.
   */
  function bandPlay(id) {
    /* "Şimdi bu kamerayı izliyorum" demek, bir listeyi takip etmeyi
       bırakmak demek. */
    stopClip();
    const b = bandOf(id);
    if (!b) return;
    if (active === b && !videoEl.paused) { videoEl.pause(); return; }
    active = b;
    if (!b.covers(axisT)) {
      /* O an kayıt yok: grubun ilk kaydının başına git. Sessizce hiçbir şey
         yapmamak, düğmenin bozuk olduğu izlenimi verirdi. */
      const first = b.spans[0];
      if (first) axisT = first.t0;
    }
    place(axisT);
    paint();
    syncAll();
    videoEl.play().catch(() => {});
  }

  /* Şerit tıklaması kipe göre iki ayrı şey demek — Object ekranındaki
     `onBarClick` ile aynı ayrım:
       native: seç, videoyu oraya götür
       re-id : hedefi kur, timeline'ı temizle, akışı başlat */
  function onPick(ev) {
    const it = findItem(ev.id);
    if (!it) return;
    if (mode === 'objects' && reidMode === 'reid') {
      /* Hedefe ikinci kez tıklamak akışı yeniden başlatmıyor, yalnızca
         seçiyor: kullanıcı hedefi izlemek istiyor olabilir. */
      if (reid && reid.target.id === it.id) {
        return pickObject(it, bandOf(it.group_id));
      }
      return startReid(it);
    }
    pickObject(it, bandOf(it.group_id));
  }

  /* ======================================================= kip yönetimi ====
     Kip değişimi ekranı SIFIRLAMIYOR: renkler, seçim ve arama sonucu yerinde
     kalıyor. Değişen tek şey bir şeride tıklamanın ne anlama geldiği. Re-ID
     kapatılınca akış kesiliyor ve bütün şeritler geri geliyor. */
  function setReidMode(next) {
    reidMode = next;
    if (next === 'native') stopReid();
    reidSw.checked = next === 'reid';
    tlPanel.classList.toggle('reid', next === 'reid');
    /* Re-ID track'leri karşılaştırıyor; olay şeridinde tıklanacak bir track
       yok. Kullanıcıyı uyarıp doğru kipe geçiriyoruz — anahtarı açıp hiçbir
       şeyin olmaması "bozuk" görünürdü. */
    if (next === 'reid' && mode !== 'objects') {
      toast('Re-ID compares object tracks — switching to Objects.',
        'warn', 4000);
      setMode('objects');
    }
  }

  /**
   * Seçim — Object ekranındaki `pickObject` ile aynı kural: aynı şeye
   * ikinci kez tıklamak seçimi kaldırıyor, çünkü seçmenin tersi de bir
   * tık uzakta olmalı (Esc de aynı işi yapıyor).
   */
  function pickObject(it, b) {
    if (selected && selected.id === it.id) {
      selected = null;
      showInfo(null);
      syncAll();
      return;
    }
    selected = it;
    if (b) active = b;
    syncAll();
    showInfo(it);
    /* YALNIZCA O ŞERİT OYNUYOR, SONRA DURUYOR.
       Eskiden şeridin başına gidip oynatmaya devam ediyordu: kullanıcı tek
       bir kutuya bakmak için tıklıyor, iki dakika sonra hâlâ oynayan ve
       artık başka bir şey gösteren bir video buluyordu. Bir şeride tıklamak
       "şunu göster" demek, "buradan itibaren izle" değil — o ikincisi zaten
       band başlığındaki oynat düğmesinin işi. */
    if (b && mode === 'objects') {
      playClips([{ b, t0: it._t0, t1: Math.max(it._t1, it._t0 + CLIP_MIN) }]);
    } else {
      seek(it._t0);
      videoEl.play().catch(() => {});
    }
  }

  function findItem(id) {
    const all = reidObjects();
    if (all) {
      const hit = all.find((x) => x.id === id);
      if (hit) return hit;
    }
    for (const d of data.values()) {
      const hit = (mode === 'events' ? d.events : d.objects)
        .find((x) => x.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * İki şerit aynı kişi. Kipten bağımsız çalışmıyor: olaylar bağlanamaz,
   * yalnızca nesneler — bir VLM olayı kişi değil.
   */
  async function onLink(fromEv, toEv) {
    if (mode !== 'objects') {
      return toast('Switch to Objects to link people.', 'warn', 4000);
    }
    const a = findItem(fromEv.id), b = findItem(toEv.id);
    if (!a || !b || !ids) return;
    try {
      await ids.link(keyOf(a), keyOf(b));
      toast(`${a._title} ↔ ${b._title} — ${ids.labelOf(keyOf(a))}`, 'ok', 2600);
    } catch (e) {
      toast('Could not save the link: ' + e.message, 'err', 6000);
    }
    showCompare(null, null);
    syncAll();
  }

  /* Sürüklerken hedefin üstüne gelmek o anı OYNATIYOR ve oynatıcıyı hedefin
     grubuna devrediyor — "bu ikisi aynı kişi mi" sorusunun cevabı ancak iki
     görüntüyü de görünce veriliyor. */
  function onHoverEvent(ev, fromEv) {
    const it = ev ? findItem(ev.id) : null;
    if (!it) {
      dragTint = null;
      syncOverlay();
      return showCompare(null, null);
    }
    const from = fromEv ? findItem(fromEv.id) : null;
    /* Yalnızca RENKSİZ hedef boyanıyor. Hedefin kendi rengi varsa onu
       kaynağın rengine çevirmek yalan olurdu: o şerit başka birine ait ve
       bırakmak iki kişiyi birleştirmek demek — bunu renk saklamamalı. */
    dragTint = from && from._color && !it._color
      ? { id: it.id, color: from._color }
      : null;
    showCompare(from, it);
    const b = bandOf(it.group_id);
    if (b) active = b;
    seek(it._t0);
    /* Parça değişmediyse `place` beslemeye dokunmuyor; renk tablosu yine de
       tazelenmeli. */
    syncOverlay();
    videoEl.play().catch(() => {});
  }

  /**
   * Sürüklemesiz hover — oynatıcıya DOKUNMUYOR.
   *
   * Yalnızca "farenin altındaki şerit kimin" sorusuna cevap veriyor: kırpım
   * videonun üstünde beliriyor, ızgaradaki kart vurgulanıp görünür yere
   * kaydırılıyor. Videoyu da oynatsaydı çubukta gezinmek görüntüyü durmadan
   * zıplatırdı — o davranış yalnızca bağlama sürüklemesinde doğru.
   */
  function onHoverBar(ev) {
    if (mode !== 'objects') return showCompare(null, null);
    showCompare(null, ev ? findItem(ev.id) : null);
  }


  /* =========================================================== Re-ID akışı ==
     GET …/collections/{cid}groups/{gid}/video/{vid}/track/{tid}/reid/stream
     — sunucu KOLEKSİYONDAKİ track'leri hedefle karşılaştırıp sıralamayı SSE
     ile gönderiyor (bkz. backend.js reidStream; adresteki eksik bölü işareti
     backend şemasının kendisinden geliyor, kasıtlı).

     Object ekranındaki akışın aynısı, tek farkla: gelen aday BAŞKA BİR
     GRUPTA olabiliyor. Yükte yalnızca {video_id, track_id} var, grubu
     videodan buluyoruz (`clock.bandOfVideo`). Koleksiyona ait olmayan bir
     video gelirse aday düşürülüyor — eksende yeri yok. */
  const rq = [];
  let pumping = false;

  /**
   * Sıralama olayı: LİSTENİN TAMAMI, yeniden dizilmiş.
   * Görülmemiş adaylar çözme kuyruğuna giriyor, görülmüşlerin RÜTBESİ
   * tazeleniyor. Şeritlerin eksendeki yeri zamana göre; rütbe etikette.
   */
  function onRanking(list) {
    if (!reid) return;
    reid.rank = new Map(list.map((m) => [m.key, m]));
    for (const m of list) {
      const key = `V${m.videoId}-T${m.trackId}`;
      const have = reid.cands.get(key);
      if (have === undefined) {
        reid.cands.set(key, null);   // yer tut: aynı aday iki kez sıraya girmesin
        rq.push(m);
        continue;
      }
      if (have) { have.reid_rank = m.rank; have.reid_score = m.score; }
    }
    reid.total = list.length;
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
      /* Ayrıntı isteği beklerken kullanıcı başka bir hedef seçmiş olabilir;
         o zaman elimizdeki cevap ESKİ akışa ait. */
      const gen = reid;
      const m = rq.shift();
      const key = `V${m.videoId}-T${m.trackId}`;
      let o = null;
      try { o = await api.trackObject(m.videoId, m.trackId); } catch { /* atla */ }
      if (reid !== gen) break;
      if (!o) { reid.cands.delete(key); continue; }
      /* Aday hangi grupta? Koleksiyonun eksenine oturmayan bir video
         gelirse (silinmiş, başka koleksiyona taşınmış) gösterecek yer yok. */
      const b = clock.bandOfVideo(m.videoId);
      if (!b) {
        reid.cands.delete(key);
        reid.dropped = (reid.dropped || 0) + 1;
        reid.dropOut += 1;
        reidStatus();
        continue;
      }
      /* SINIF ELEMESİ. Sıralama sınıf ayırmıyor: bir kişiyi ararken araç
         track'leri de geliyor. Bir insan bir araba olamaz — kaç tanesinin
         elendiğini durum satırı söylüyor, sessizce atmak sunucunun daha az
         aday bulduğu izlenimi verirdi. */
      if (o.class_known && o.cls && reid.target.cls
          && o.cls !== reid.target.cls) {
        reid.cands.delete(key);
        reid.dropped = (reid.dropped || 0) + 1;
        reid.dropCls.set(o.cls, (reid.dropCls.get(o.cls) || 0) + 1);
        reidStatus();
        continue;
      }
      decorate(o, b, m.videoId);
      /* Rütbe kuyruğa girdiği andaki değil, EN SON sıralamadaki olmalı. */
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
    const tb = bandOf(reid.target.group_id);
    clear(reidInfo);
    reidInfo.append(
      el('b', {
        style: { color: (ids && ids.colorOf(keyOf(reid.target))) || '#e8eef6' },
      }, `#${reid.target.track_id}`),
      el('span', { class: 'muted' }, tb ? ` ${tb.letter} · ${tb.name}` : ''),
      ` — ${n} candidate${listed === 1 ? '' : 's'} · `
        + (REID_ST[reid.status] || reid.status),
      reid.dropped ? dropChip() : null,
      el('span', { class: 'muted' },
        '  ·  drag from the target onto a candidate to confirm'));
  }

  /**
   * "58 dropped" rozetinin dökümü.
   *
   * Sayının kendisi bir soru bırakıyordu: neyi attık? İki ayrı sebep var ve
   * ikisi de sessizce aynı sayıya yazılıyordu:
   *
   *   1) BAŞKA SINIF — sunucunun sıralaması sınıf ayırmıyor, bir kişiyi
   *      ararken araç/bisiklet track'leri de geliyor. Sınıf tahmin değil:
   *      modelin kendi `class_id`si (liste ucundan, bkz. backend.js
   *      classIndex). Sınıfı BİLİNMEYEN aday elenmiyor, listede kalıyor.
   *   2) BU KOLEKSİYONDA DEĞİL — adayın videosu koleksiyonun eksenine
   *      oturmuyor (başka koleksiyona taşınmış, silinmiş, ya da süresi
   *      okunamadığı için bandı hiç kurulamamış). Bunlar İNSAN da olabilir;
   *      "hepsi arabaydı" demek yanlış olurdu.
   *
   * İpucu ikisini ayırıyor ve sınıfları tek tek sayıyor.
   */
  function dropChip() {
    const parts = [...reid.dropCls.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cls, n]) => `${cls} ${n}`);
    const lines = [
      `${reid.dropped} candidate(s) were removed from the list:`,
      parts.length ? `· different class — ${parts.join(' · ')}` : null,
      parts.length
        ? '  (the class comes from the model itself; a track whose class is '
          + 'unknown is never dropped)'
        : null,
      reid.dropOut
        ? `· not on this collection's timeline — ${reid.dropOut}`
        : null,
      reid.dropOut
        ? '  (their video is not in this collection, or it has no readable '
          + 'duration — these may well be people)'
        : null,
    ].filter(Boolean);
    return el('span', {
      class: 'muted', style: { cursor: 'help' }, title: lines.join('\n'),
    }, ` · ${reid.dropped} dropped`
      + (reid.dropOut && parts.length
        ? ` (${reid.dropped - reid.dropOut} other-class, `
          + `${reid.dropOut} off-collection)`
        : (reid.dropOut ? ' (off-collection)' : ' (other class)')));
  }

  function startReid(o) {
    const b = bandOf(o.group_id);
    if (!b) return;
    stopReid(true);
    /* Hedef renksizse renk alsın: akış boyunca ekranda hangisinin hedef
       olduğu tek bakışta okunmalı. */
    if (ids && !ids.colorOf(keyOf(o))) ids.setColor(keyOf(o), ids.nextColor());
    reid = {
      target: o, cands: new Map(), rank: new Map(), status: 'running',
      got: 0, total: 0, dropped: 0, stream: null,
      /* Elenenlerin DÖKÜMÜ. Tek bir "58 dropped" sayısı, sorulduğunda
         cevaplanamayan bir sayı: hangi sınıflar, kaç tanesi eksende yeri
         olmadığı için düştü? İkisi ayrı sebep ve ikisi ayrı anlam taşıyor
         (bkz. reidStatus ipucu). */
      dropCls: new Map(),   // sınıf adı → kaç tane
      dropOut: 0,           // koleksiyon ekseninde karşılığı olmayanlar
    };
    reidBar.style.display = '';
    reidStatus();
    selected = o;
    active = b;
    syncAll();
    showInfo(o);
    seek(o._t0);

    reid.stream = api.reidStream(b.id, o.video_id, o.track_id, {
      /* Üst sınır: sıralama teorik olarak koleksiyondaki BÜTÜN track'leri
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
    }, { collectionId: col.id });
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

  /* ------------------------------------------------------- hover devri ---
     FARE GEÇERKEN DEĞİL, DURUNCA DEVREDİYOR.

     3. bandın üstüne gitmek için 2.'nin üstünden geçmek zorunlu ve her geçiş
     bir devir sayılıyordu: kullanıcı yukarı kayarken video önce 2'ye, sonra
     1'e atlıyor, hedefe varmadan iki kez kaynak değiştiriyordu. Pahalı ve
     okunmaz.

     Açılma/kapanma ANINDA kalıyor — o yalnızca "buradasın" geri bildirimi ve
     gecikmesi ekranı tembel gösterirdi. Devreden yalnızca OYNATICI, ve o da
     fare o bandda kısa bir süre bekleyince. Süre ne kadar kısa olursa geçiş
     kazaları geri gelir, ne kadar uzun olursa kasıtlı devir gecikmiş hisseder;
     260 ms ikisinin arasında. */
  const HOVER_DWELL = 260;
  let dwellT = null;
  let dwellId = null;

  function onBandHover(id) {
    /* Band açılınca o bandın şerit sayısı artıyor — veriyi yeniden
       paketlemek gerekiyor, yoksa açılan band da tek satır kalırdı. */
    syncAll();
    if (id === dwellId) return;
    dwellId = id;
    clearTimeout(dwellT);
    if (id == null) return;
    dwellT = setTimeout(() => { dwellT = null; handover(id); }, HOVER_DWELL);
  }
  onLeave(() => clearTimeout(dwellT));

  /* --------------------------------------------------------- bağlantılar */
  TL = new Timeline(tlCanvas, {
    mode: 'single',
    /* Ayrılacak yerin hesabı bu sayıyı biliyor olmalı: açık bandın en fazla
       kaç şeridi olabileceğini `lanesOf` ile biz belirliyoruz. */
    openRows: ROWS_OPEN,
    onSeek: (t) => { seek(t); },
    onPickEvent: (e) => onPick(e),
    onLinkEvent: (a, b) => onLink(a, b),
    onHoverEvent: (e, from) => onHoverEvent(e, from),
    onHoverBar: (e) => onHoverBar(e),
    onBandHover: (id) => onBandHover(id),
    onBandPlay: (id) => bandPlay(id),
  });
  onLeave(() => TL.destroy());

  scrub.onclick = (e) => {
    const r = scrub.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width * AXIS);
  };

  overlay = new VideoOverlay(ovlCanvas, videoEl);
  onLeave(() => overlay.destroy());
  onLeave(() => { if (feed) feed.dispose(); });
  /* KUTULARIN ÇİZİLDİĞİ YER BURASI. `start()` çağrılmadığında besleme
     çalışıyor, kutular geliyor, ama tuvale hiç kimse çizmiyor — ekranda
     ilk karede kalan görüntü sabit duruyordu. Object ekranında bu satır
     baştan beri vardı, koleksiyonda atlanmıştı. */
  overlay.start();
  /* Video boyutu metadata ile geliyor; tuval o gelmeden ölçeklenirse
     kutular yanlış yere düşüyor. */
  videoEl.addEventListener('loadedmetadata', () => overlay.resize());
  /* Etiket ve renk tablosu, video hazır olduğunda. Veri bandtan sonra
     gelebiliyor; `syncAll` da aynı işi yapıyor, ikisi birbirini tamamlıyor. */
  videoEl.addEventListener('loadeddata', () => syncOverlay());

  /* Kutuya tıklamak o track'i seçiyor — Object ekranındaki davranışın
     aynısı. Kutuda yalnızca track numarası var; hangi nesne olduğunu aktif
     parçadan buluyoruz. */
  overlay.onPick = (tid) => {
    if (!activePart) return;
    const d = data.get(active.id);
    if (!d) return;
    const o = d.objects.find((x) => String(x.video_id) === String(activePart.id)
      && String(x.track_id) === String(tid));
    if (o) pickObject(o, active);
  };

  videoEl.addEventListener('timeupdate', () => {
    /* Oynatıcının saati eksenin saati DEĞİL — çeviri yolu kipe göre ayrı
       (bkz. `place`). Bunu burada yapmak zorundayız, yoksa playhead her
       parça başında sıfıra düşerdi. */
    if (useHls) {
      const wall = active.clock.wallFromPlay(videoEl.currentTime);
      axisT = active.toAxis(wall);
      const hit = active.at(axisT);
      /* Parçayı tarayıcı değiştiriyor; biz yalnızca fark edip kutu
         beslemesini taşıyoruz. */
      if (hit) {
        bindFeed(hit.part);
        if (feed) feed.at(hit.offset);
      }
    } else {
      if (!activePart) return;
      axisT = active.axisOf(activePart.id, videoEl.currentTime);
      /* Kutu penceresi PARÇA saniyesiyle sürülüyor (bkz. bboxfeed.js). */
      if (feed) feed.at(videoEl.currentTime);
    }
    /* Parça listesi varsa bitişi burada yakalanıyor: eksen saniyesi ancak
       bu noktada tazelenmiş oluyor. */
    clipTick();
    paint();
  });
  videoEl.addEventListener('play', () => { btnPlay.textContent = '❚❚'; paint(); });
  videoEl.addEventListener('pause', () => { btnPlay.textContent = '▶'; paint(); });
  /* Parça bitti: aynı bandın sonraki kaydına geç. Band da bittiyse dur —
     başka bir gruba kendiliğinden atlamak kullanıcının izlediği kamerayı
     habersiz değiştirmek olurdu.

     HLS'te bu hiç gerekmiyor: parçalar zaten tek listede, `ended` ancak
     GRUBUN sonunda geliyor ve orada yapılacak bir şey yok. */
  videoEl.addEventListener('ended', () => {
    if (useHls) return;
    const nx = active.clock.next(activePart && activePart.id);
    if (!nx) return;
    seek(active.toAxis(nx.t0));
    videoEl.play().catch(() => {});
  });
  btnPlay.onclick = () => (videoEl.paused ? videoEl.play() : videoEl.pause());

  /* Esc — seçimi kaldırır. Object ekranındaki kısayolun aynısı; iki ekran
     arasında gidip gelen kullanıcı aynı tuşun aynı işi yapmasını bekliyor. */
  const onEsc = (e) => {
    if (e.key !== 'Escape') return;
    /* Esc önce Re-ID'den çıkıyor: akış açıkken ekranda görünen kısıtlama o,
       kullanıcının kaçmak istediği de o. */
    if (reid) { stopReid(); return; }
    if (!selected) return;
    selected = null;
    showInfo(null);
    syncAll();
  };
  document.addEventListener('keydown', onEsc);
  onLeave(() => document.removeEventListener('keydown', onEsc));

  /* ------------------------------------------------------------ açılış -- */
  TL.setData({ bands: [], total: AXIS, startIso: clock.startIso });
  showInfo(null);
  /* Veri gelene kadar parıldayan yer tutucular — Object ekranındaki
     `renderSkeleton` ile aynı. Boş ızgara "sonuç yok" gibi okunuyordu. */
  grid.append(...skeletonCards(12));
  seek(0);

  for (const b of clock.bands) {
    await loadBand(b);
    syncAll();
  }

  /* Kayıtlı kişilerin üyeleri yüklenen nesneler arasında olmayabilir (başka
     sınıf, süzülmüş). Bunlar için ayrıca istek ATMIYORUZ: koleksiyonda
     yüzlerce olabilir. Listede görünmeyen üye "n track(s)" sayısında yine
     de sayılıyor, tıklanınca uyarı çıkıyor. */
  syncAll();

  /* ---------------------------------------------- dışarıdan gelen an ----
     Summary ekranından bir kişiye ya da olaya tıklandığında buraya
     `?g=<grup>&v=<video>&t=<saniye>` ile geliniyor: "o anı aç ve OYNAT".

     Saniye VİDEO İÇİ, eksen saniyesi değil. Eksen `align` seçimine göre
     kayıyor (zero/wall) ve adreste eksen saniyesi taşımak, kullanıcı
     hizalamayı değiştirdiği anda bağlantıyı yanlış ana götürürdü. Video içi
     saniye ise mutlak: çeviriyi burada, o andaki hizalamaya göre yapıyoruz.

     Bu blok BÜTÜN bandlar yüklendikten sonra çalışıyor — nesne seçimi için
     verinin gelmiş olması gerekiyor. */
  const jump = query && query.get('v');
  if (jump) {
    const b = clock.byId(query.get('g')) || clock.bandOfVideo(jump);
    if (b) {
      /* Track verildiyse `pickObject` yeterli: o zaten bandı seçiyor, ana
         atlıyor, Info panelini dolduruyor ve oynatıyor. Kullanıcı Summary'de
         birine tıkladı — burada kimin oynadığını da okumalı. */
      const tid = query.get('track');
      const d = data.get(b.id);
      const o = tid && d && d.objects.find((x) =>
        String(x.video_id) === String(jump)
        && String(x.track_id) === String(tid));
      if (o) {
        pickObject(o, b);
      } else {
        active = b;
        seek(b.axisOf(jump, Number(query.get('t')) || 0));
        /* Otomatik oynatma tarayıcı tarafından reddedilebilir (kullanıcı
           hareketi olmadan). Reddedilirse ekran doğru anda durmuş hâlde
           kalıyor — kaybedilen tek şey oynatmanın kendisi. */
        videoEl.play().catch(() => {});
      }
    }
  }
}
