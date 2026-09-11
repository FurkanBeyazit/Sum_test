/* ==========================================================================
   Ekran: Summary  (#/summary/:collectionId)
   --------------------------------------------------------------------------
   KOLEKSİYON ÖZETİ — yapılan işin son çıktısı.

   Zaman çizgisi ekranı (#/collection/:id) bir ÇALIŞMA ekranı: orada kişi
   bağlanıyor, renk veriliyor, Re-ID koşuluyor. Bu ekran o çalışmanın
   SONUCU: hiçbir şey yazmıyor, yalnızca okuyor.

   ADI NEDEN "SUMMARY", SEKMESİ NEDEN KOLEKSİYONA BAĞLI
   -----------------------------------------------------
   Ekran doğası gereği koleksiyon kapsamlı: "hangi koleksiyon" sorusunun
   cevabı olmadan gösterecek bir şeyi yok. Bu yüzden asıl kapı koleksiyon
   ekranının başlığındaki `Summary →` düğmesi — oradan girildiğinde hangi
   koleksiyonun özeti olduğu zaten belli.

   Üst çubukta da bir sekme var, ama koşullu: koleksiyon yoksa hiç
   çizilmiyor, varsa EN SON BAKILAN koleksiyona gidiyor (yoksa listedeki
   ilk). Bu, Object ve Analysis sekmelerinin "son bakılan video" kuralının
   bir katman yukarısı — yeni bir karar mekanizması değil, var olanın aynısı
   (bkz. ui.js `rememberCollection`).

   DÜZEN
   -----
   Sütunlar = video grupları, soldan sağa başlangıç saatine göre. Sağa
   kaydırınca koleksiyondaki bütün gruplar. Her sütunun altında o grubun
   olayları alt alta. Bu, elle çizilmiş taslağın birebir karşılığı.

   OBJECT ANALİZİ NEREYE GİRİYOR — ÜÇ KADEME
   ------------------------------------------
   Bir videoda 15–50 track var; iyi bağlandığında 5–10 kişiye iniyor. Bu
   kırpımları olay kartlarının arasına serpmek duvarı okunmaz yapıyordu,
   hiç göstermemek de ekranın yarısını eksik bırakıyordu. Bu yüzden:

     1) KAPALI     sütun başlığında yalnızca sayı: "👤 5"
     2) ŞERİT      başlığa gelince kişiler açılıyor (P1, P2 … kırpımlarıyla)
     3) ÇİZGİ      bir kişiye gelince o kişinin bulunduğu BÜTÜN sütunlar
                   açılıyor ve aralarına bağlantı çizgisi çekiliyor;
                   aynı anda o kişinin olayları yanıp gerisi sönüyor.

   Şerit olay listesini İTMİYOR, üstüne biniyor: duvar kıpırdamasın diye.
   Çizgiler de hep şerit hizasında kaldığı için kısa ve neredeyse yatay —
   otuz bağlantıda bile birbirini kesmiyorlar.

   "×2" YOK — PARÇALAR BİRLEŞTİRİLİYOR
   ------------------------------------
   Model, on saniye düz yürüyen bir insana çoğu zaman tek track vermiyor;
   birkaç saniyede bir yeni track_id açıyor. Kullanıcı bunları elle
   bağlıyor ("bunlar aynı kişi"). Eğer ekran her track için bir kutu
   gösterseydi, tek bir yürüyüş "aynı kişi 5 kez görüldü" diye okunurdu ve
   bu YANLIŞ olurdu.

   Bu yüzden burada gösterilen birim track değil, GÖRÜLME:
     · bir kişinin aynı videodaki track'leri zamana göre diziliyor,
     · aralarındaki boşluk `STITCH_GAP`ten küçükse tek görülme sayılıyor,
     · büyükse gerçekten çıkıp geri gelmiş demektir, ayrı görülme oluyor.

   KAPSAMA KURALI — "ilk ve son görüntüyü bağlamak yetsin"
   -------------------------------------------------------
   On parçayı tek tek birbirine bağlamak anlamsız bir iş. Kullanıcı yalnızca
   İLKİ ile SONU bağlasa, aradaki sekiz parça teknik olarak bağsız kalırdı
   ve "tekil" sayısını şişirirdi. Bu ekran onları arıyor: aynı videoda, aynı
   sınıfta, bağlı bir görülmenin zaman aralığının TAMAMEN İÇİNE düşen bağsız
   track'ler o görülmenin parçası sayılıyor.

   Bu bir ÇIKARIM ve sunucuya yazılmıyor — yalnızca gösterimde. İpucunda
   kaç parçanın böyle katıldığı yazıyor, yani kullanıcı çıkarımı görüyor.

   OLAY ↔ KİŞİ BAĞI ZAMANLA KURULUYOR
   -----------------------------------
   Backend olayın içindeki track'leri vermiyor (`track_ids` boş geliyor).
   Dolayısıyla "bu olayda bu kişi var" diyemiyoruz; diyebildiğimiz şey "bu
   kişi o sırada bu kameradaydı". Vurgulama bu örtüşmeye dayanıyor ve
   ipucunda da böyle yazıyor. Backend track bağını verdiği gün burada tek
   fonksiyon değişiyor (`tagEvents`).
   ========================================================================== */

import { el, mount, clear, api, dur } from '../core.js';
import { CollectionClock } from '../collectionclock.js';
import { loadIdentities, idKey } from '../identity.js';
import {
  ROOT, onLeave, topbar, treePanel, skeletonRows, rememberCollection,
} from '../ui.js';

/* Kamera kimliği HARFLE — koleksiyon ekranıyla aynı kural, aynı sıra.
   Renk yalnızca KİŞİ demek; kamera zaten sütun konumunda kodlu. */
const BAND_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/* İki track arasındaki boşluk bundan küçükse aynı görülme sayılıyor.
   30 saniye: kadrajda kalmaya devam eden birinin track'i bu kadar uzun
   kopmuyor; bu kadar uzun bir boşluk varsa kişi gerçekten çıkmış demektir. */
const STITCH_GAP = 30;

/* Rengi olmayan kişinin bağlantı çizgisi — taslaktaki kırmızı. */
const WIRE = '#ef4444';
const SVGNS = 'http://www.w3.org/2000/svg';

/* Şeritte en fazla kaç bağsız track gösterilsin. Gerisi sayıyla özetleniyor:
   bağsız track sayısı yüzleri bulabiliyor ve hiçbiri tıklanacak bir şey
   değil — orada olduklarını bilmek yetiyor. */
const LOOSE_SHOWN = 24;

export async function screenSummary(collectionId) {
  /* Üst çubuktaki Summary sekmesi "en son bakılan koleksiyon"a gidiyor;
     burası o hafızayı yazan iki yerden biri (öteki koleksiyon ekranı). */
  rememberCollection(collectionId);

  const stage = el('div.stage');
  const sidebar = el('div.sidebar', {},
    treePanel(null, (c) => { location.hash = `#/objects/${c.id}`; }));
  mount(ROOT(), topbar('summary'), el('div.main', {}, sidebar, stage));

  /* ------------------------------------------------------------ veri ---- */
  const cols = await api.collections();
  const col = cols.find((c) => String(c.id) === String(collectionId));
  if (!col) {
    mount(stage, el('div.empty', {}, `Collection ${collectionId} not found.`));
    return;
  }

  /* HİZALAMA HER ZAMAN GERÇEK SAAT.
     Zaman çizgisi ekranında 'wall' hizalaması sorunluydu: gruplar farklı
     saatlerde başlıyorsa ORTAK eksenin çoğu boş tarama oluyordu. Burada
     ortak eksen yok — her sütun kendi listesi. Dolayısıyla gerçek saatin
     bedeli yok, kazancı var: iki sütundaki iki olayın saatini yan yana
     okumak ancak böyle mümkün. */
  const clock = new CollectionClock(col.groups, { align: 'wall' });
  if (clock.empty) {
    mount(stage, el('div.empty', {},
      el('div', {}, `"${col.name}" has no analysed recording yet.`),
      el('div', { class: 'tiny muted' },
        'Add video groups to this collection in Manage, and make sure the '
        + 'videos have finished analysing.')));
    return;
  }
  clock.bands.forEach((b, i) => {
    b.letter = BAND_LETTERS[i % BAND_LETTERS.length];
  });

  const groupIds = (col.groups || []).map((g) => String(g.id));
  let ids = null;
  try {
    ids = await loadIdentities({
      kind: 'collection', id: String(col.id), groupIds,
    });
  } catch (e) {
    console.warn('[wall] kimlikler yüklenemedi:', e.message);
    ids = await loadIdentities({ kind: 'none' });
  }
  /* Bu ekran renk YAZMIYOR; flush yine de çağrılıyor ki bir gün yazan bir
     şey eklenirse kapanışta kaybolmasın. */
  onLeave(() => ids && ids.flush());

  const keyOf = (o) => idKey(o.group_id, o.video_id, o.track_id);

  /* ----------------------------------------------------------- durum ---- */
  /* Sessiz olaylar ("특이사항 없음") VARSAYILAN GİZLİ. VLM her segment için
     bir satır üretiyor ve çoğu "bir şey olmadı" diyor; hepsini göstermek
     duvarı boş satırlarla dolduruyor. Anahtar başlıkta duruyor çünkü
     "hiç olay yok mu, yoksa gizli mi" sorusu cevapsız kalmamalı. */
  let showQuiet = false;
  let focusN = null;                 // odaktaki Person numarası
  const data = new Map();            // bandId → { events, apps, loose }

  /* ---------------------------------------------------------- iskelet --- */
  const wires = document.createElementNS(SVGNS, 'svg');
  wires.setAttribute('class', 'su-wires');
  const track = el('div.su-track', {}, wires);
  const scroller = el('div.panel-b.su-scroll', {}, track);

  const sumLbl = el('span', { class: 'tiny muted' }, 'loading…');

  /* DÜĞMENİN ÜSTÜNDE SAYI VAR.
     Önce "Quiet events" yazıyordu ve ne açtığı, ne kapattığı, hatta bir
     anahtar mı yoksa bir bağlantı mı olduğu okunmuyordu. VLM her segment
     için bir satır yazıyor ve çoğu "bir şey olmadı" diyor; o satırlar
     gizli. Sayı görününce düğme kendini anlatıyor: "18 tane daha var,
     hepsi boş — istersen göster". Sayı ancak veri gelince biliniyor, bu
     yüzden `renderSummary` tazeliyor. */
  const quietBtn = el('button.btn.sm.ghost', {
    title: 'The analysis writes one line per segment and most of them say '
      + '"nothing happened" (특이사항 없음). Those are hidden so the wall '
      + 'shows only real observations. Turn this on to see every segment.',
    onclick: () => {
      showQuiet = !showQuiet;
      quietBtn.className = showQuiet ? 'btn sm pri' : 'btn sm ghost';
      for (const c of colEls) renderEvents(c);
      renderSummary();
    },
  }, '0 quiet');

  const panel = el('div.panel.su-panel', {},
    el('div.panel-h', {}, 'People across cameras',
      el('span', { class: 'tiny muted' },
        'hover a column to open its people · hover a person to trace them'),
      el('span.grow'),
      sumLbl,
      quietBtn,
      /* "Timeline" diyordu ve bu ekranda da bir zaman ekseni olduğu için
         neyin nereye gittiği belirsizdi. Kırıntı çubuğu zaten
         "Collection › ad" diyor; geri dönüş de aynı kelimeyi kullanınca
         soru kalmıyor. */
      el('a.btn.sm.ghost', {
        href: `#/collection/${col.id}`,
        title: 'Back to the collection timeline — the working screen, where '
          + 'people are linked, coloured and played.',
      }, '← Collection')),
    scroller);

  mount(stage,
    el('div.hdr', {},
      el('div.hdr-top', {},
        el('div.crumb', {},
          el('span.par', {}, 'Collection'),
          el('span.sep', {}, '›'),
          el('span.par', {}, col.name),
          el('span.sep', {}, '›'),
          el('span.cur', {}, 'Summary')),
        el('div.grow'),
        el('span', { class: 'tiny muted' }, clock.summary()))),
    panel);

  /* ------------------------------------------------------- sütun kabuğu -- */
  const colEls = clock.bands.map(buildColumn);
  track.append(...colEls.map((c) => c.node));

  function buildColumn(b) {
    const chips = el('div.su-chips');
    const count = el('span.su-count', {}, '…');
    const mini = el('div.su-mini');
    const strip = el('div.su-strip', {},
      el('span.su-pico', {}, '👤'), count, el('span.grow'), mini);
    const head = el('div.su-head', {},
      el('div.su-h', {},
        el('span.su-cam', { title: b.name }, b.letter),
        el('span.su-nm', { title: b.name }, b.name),
        el('span.su-tm', {}, clock.realStart(b) || '—')),
      strip, chips);
    const events = el('div.su-events', {}, skeletonRows(4));
    const node = el('div.su-col', { 'data-band': b.id }, head, events);

    /* Şerit hover ile açılıyor. Odak varken kapanmıyor: odak zaten hangi
       sütunların açık kalacağını söylüyor ve fare çizgiyi takip ederken
       araya giren sütunlar kapanıp açılsaydı ekran titrerdi. */
    head.addEventListener('mouseenter', () => {
      if (!focusN) node.classList.add('open');
    });
    node.addEventListener('mouseleave', () => {
      if (!focusN) node.classList.remove('open');
    });
    return { b, node, chips, count, mini, events };
  }

  /* -------------------------------------------------------- veri yükleme --
     Grup grup, SIRAYLA. Her grup bitince kendi sütunu doluyor — kullanıcı
     ikinci grubu beklemeden birincisini görüyor. Hepsini birden istemek
     backend'i de tarayıcıyı da tıkıyordu (bkz. collection.js loadBand). */
  (async () => {
    for (const c of colEls) {
      try {
        await loadBand(c.b);
      } catch (e) {
        console.warn(`[wall] ${c.b.name} okunamadı:`, e.message);
        data.set(c.b.id, { events: [], apps: [], loose: [] });
      }
      renderColumn(c);
      renderSummary();
    }
  })();

  async function loadBand(b) {
    const events = [];
    const objects = [];
    for (const p of b.clock.parts) {
      const [ev, ob] = await Promise.all([
        api.events(p.id, { limit: 400 }).catch(() => ({ items: [] })),
        /* YALNIZCA `person`. Bu ekranın kişi katmanı insan hakkında; araç ve
           bisiklet track'lerini de çekmek istek sayısını ve şeridi iki
           katına çıkarıp hiçbir soruya cevap vermezdi. Olaylar tarafında
           böyle bir süzgeç yok — orada her şey görünüyor. */
        api.objects(p.id, { limit: 400, cls: 'person' })
          .catch(() => ({ items: [] })),
      ]);
      for (const e of ev.items || []) {
        e.group_id = b.id;
        e._t0 = b.axisOf(p.id, e.t_start);
        e._t1 = b.axisOf(p.id, e.t_end);
        events.push(e);
      }
      for (const o of ob.items || []) {
        o.group_id = b.id;
        o._t0 = b.axisOf(p.id, o.t_first);
        o._t1 = b.axisOf(p.id, o.has_range ? o.t_last : o.t_first);
        objects.push(o);
      }
    }
    events.sort((x, y) => x._t0 - y._t0);
    objects.sort((x, y) => x._t0 - y._t0);
    const { apps, loose } = stitch(objects);
    tagEvents(events, apps);
    data.set(b.id, { events, apps, loose });
  }

  /* ============================================================ GÖRÜLME ===
     Track listesi → görülme listesi. Dosya başlığındaki iki kural burada:
     boşluğa göre bölme ve kapsama kuralı.

     @returns {{apps: Array, loose: Array}}
       `apps`  → `{ person, tracks, absorbed, t0, t1, videoIds, color, rep }`
       `loose` → hiçbir kişiye bağlanamamış track'ler
  */
  function stitch(objects) {
    const linked = [];
    const free = [];
    for (const o of objects) {
      const p = ids && ids.personOf(keyOf(o));
      if (p) { o._person = p; linked.push(o); } else free.push(o);
    }

    /* Kişi başına topla, sonra zaman boşluğuna göre böl. */
    const byPerson = new Map();
    for (const o of linked) {
      const n = o._person.n;
      if (!byPerson.has(n)) byPerson.set(n, []);
      byPerson.get(n).push(o);
    }
    const apps = [];
    for (const list of byPerson.values()) {
      list.sort((a, b) => a._t0 - b._t0);
      let cur = null;
      for (const o of list) {
        if (cur && o._t0 - cur.t1 <= STITCH_GAP) {
          cur.tracks.push(o);
          cur.t1 = Math.max(cur.t1, o._t1);
          cur.videoIds.add(String(o.video_id));
        } else {
          cur = {
            person: o._person,
            tracks: [o],
            absorbed: [],
            t0: o._t0,
            t1: o._t1,
            videoIds: new Set([String(o.video_id)]),
          };
          apps.push(cur);
        }
      }
    }

    /* KAPSAMA KURALI — bkz. dosya başlığı. Aralığın tamamen içine düşen
       bağsız track, o görülmenin parçası sayılıyor. Aralığı GENİŞLETMİYOR:
       çıkarım yalnızca "bu da aynı kişi" demek, "kişi daha uzun kaldı"
       demek değil. */
    const loose = [];
    for (const o of free) {
      const a = apps.find((x) =>
        x.videoIds.has(String(o.video_id))
        && x.tracks[0].class_name === o.class_name
        && o._t0 >= x.t0 - 0.25 && o._t1 <= x.t1 + 0.25);
      if (a) a.absorbed.push(o); else loose.push(o);
    }

    for (const a of apps) {
      a.color = ids ? ids.colorOf(keyOf(a.tracks[0])) : null;
      a.rep = guessRep(a);
    }
    /* Sıra: önce Person numarası, sonra zaman. Kullanıcının akılda tuttuğu
       "P3" her sütunda aynı sırada okunuyor. */
    apps.sort((a, b) => a.person.n - b.person.n || a.t0 - b.t0);
    loose.sort((a, b) => a._t0 - b._t0);
    return { apps, loose };
  }

  /**
   * Bir görülmeyi hangi track temsil edecek — ÖN TAHMİN.
   *
   * Gerçek ölçüt kırpımın BÜYÜKLÜĞÜ (bkz. `measureRep`), ama onu bilmek
   * için resmi indirmek gerekiyor. Bu yüzden önce ucuz bir tahmin
   * yapılıyor: en yüksek güven, eşitlikte en uzun süren track. Resim
   * ölçüsü gelince kutu kendiliğinden güncelleniyor.
   */
  function guessRep(a) {
    return [...a.tracks, ...a.absorbed]
      .slice()
      .sort((x, y) => (y.conf || 0) - (x.conf || 0)
        || (y._t1 - y._t0) - (x._t1 - x._t0))[0];
  }

  /**
   * Kırpımları ölçer ve EN BÜYÜĞÜNÜ seçer.
   *
   * BestShot her track için ayrı seçiliyor; bir görülmenin beş parçası
   * varsa beş ayrı kırpım var ve hepsi aynı insan. Aralarında en büyük
   * olan kameraya en yakın ve en net olandır — küçük kırpım genelde
   * uzaktaki ya da yarısı kadraj dışında kalmış kareden geliyor.
   *
   * Yalnızca ilk dört aday ölçülüyor: bir görülmede on parça olabiliyor ve
   * hepsini indirmek şerit açılır açılmaz onlarca istek demek. İlk dördü
   * zaten tahmine göre en iyiler.
   */
  function measureRep(a, imgEl) {
    const cands = [...a.tracks, ...a.absorbed]
      .sort((x, y) => (y.conf || 0) - (x.conf || 0))
      .slice(0, 4);
    if (cands.length < 2) return;
    let best = null;
    let bestArea = -1;
    let left = cands.length;
    const done = () => {
      if (--left) return;
      if (!best || best === a.rep) return;
      a.rep = best;
      if (imgEl.isConnected) imgEl.src = best.crop;
    };
    for (const o of cands) {
      const im = new Image();
      im.onload = () => {
        const area = im.naturalWidth * im.naturalHeight;
        if (area > bestArea) { bestArea = area; best = o; }
        done();
      };
      im.onerror = done;
      im.src = o.crop;
    }
  }

  /**
   * Olaylara kişi etiketi basar — ZAMAN ÖRTÜŞMESİYLE.
   * Backend olayın track'lerini vermiyor; elimizdeki tek bağ bu
   * (bkz. dosya başlığı).
   */
  function tagEvents(events, apps) {
    for (const ev of events) {
      const hit = [];
      for (const a of apps) {
        if (!a.videoIds.has(String(ev.video_id))) continue;
        if (a.t0 <= ev._t1 && a.t1 >= ev._t0) hit.push(a.person.n);
      }
      ev._p = [...new Set(hit)];
    }
  }

  /* ============================================================== ÇİZİM === */

  function renderColumn(c) {
    const d = data.get(c.b.id) || { events: [], apps: [], loose: [] };

    /* Sayı satırı: bağlı KİŞİ sayısı öne, bağsız track sayısı arkaya.
       Tek bir "42 kişi" yazmak yanıltıcı olurdu — o 42'nin çoğu aynı
       insanın parçaları. */
    const people = countPeople(d.apps);
    c.count.textContent = String(people);
    c.count.title = `${people} linked people in this group`
      + (d.loose.length
        ? `\n${d.loose.length} tracks not linked to anyone` : '');

    clear(c.mini);
    if (d.loose.length) {
      c.mini.append(el('span.su-loose', {
        title: `${d.loose.length} tracks are not linked to any person yet. `
          + 'Link them on the timeline screen.',
      }, `+${d.loose.length}`));
    }
    for (const a of d.apps.slice(0, 8)) {
      c.mini.append(el('i', {
        style: { background: a.color || '#33415a' },
        title: `Person ${a.person.n}`,
      }));
    }

    clear(c.chips);
    if (!d.apps.length && !d.loose.length) {
      c.chips.append(el('span', { class: 'tiny muted' },
        'No person track in this group.'));
    }
    for (const a of d.apps) c.chips.append(personChip(a));
    for (const o of d.loose.slice(0, LOOSE_SHOWN)) {
      c.chips.append(looseChip(o));
    }
    if (d.loose.length > LOOSE_SHOWN) {
      c.chips.append(el('div.su-chip.more', {
        title: `${d.loose.length - LOOSE_SHOWN} more unlinked tracks`,
      }, `+${d.loose.length - LOOSE_SHOWN}`));
    }
    renderEvents(c);
  }

  /** Aynı kişi bir sütunda iki kez görünmüş olabilir; KİŞİ sayılıyor. */
  function countPeople(apps) {
    return new Set(apps.map((a) => a.person.n)).size;
  }

  /* ---------------------------------------------------- "orayı oynat" ---
     Summary okunan ekran, oynatıcı orada değil. Bir kırpıma ya da olaya
     tıklamanın tek anlamlı karşılığı var: koleksiyon zaman çizgisini O AN
     ile açmak ve oynatmaya başlamak.

     Adreste VİDEO İÇİ saniye taşınıyor, eksen saniyesi değil: eksen
     hizalamaya (`zero`/`wall`) göre kayıyor ve orada verilen bağlantı,
     kullanıcı hizalamayı değiştirir değiştirmez yanlış ana giderdi.
     Çeviriyi koleksiyon ekranı kendi hizalamasıyla yapıyor. */
  function playLink(o, opts = {}) {
    const q = [
      `mode=${opts.mode || 'objects'}`,
      `g=${encodeURIComponent(o.group_id)}`,
      `v=${encodeURIComponent(o.video_id)}`,
      `t=${Math.max(0, Math.floor(opts.t || 0))}`,
      opts.track ? `track=${encodeURIComponent(opts.track)}` : '',
    ].filter(Boolean).join('&');
    return `#/collection/${col.id}?${q}`;
  }

  function personChip(a) {
    const seen = a.tracks.length + a.absorbed.length;
    const span = Math.max(0, a.t1 - a.t0);
    const img = el('img.su-crop', {
      src: a.rep.crop, loading: 'lazy',
      style: { borderColor: a.color || '#3b4a63' },
      onerror: (e) => { e.target.style.visibility = 'hidden'; },
    });
    measureRep(a, img);
    const node = el('div.su-chip', {
      'data-p': String(a.person.n),
      title: `Person ${a.person.n}\n`
        + `${clock.clock(a.t0)} – ${clock.clock(a.t1)}`
        + (span > 0.5 ? ` · ${dur(span)}` : '')
        + `\n${seen} track${seen === 1 ? '' : 's'} stitched into one sighting`
        + (a.absorbed.length
          ? `\n${a.absorbed.length} of them inferred from the time span`
          : '')
        + '\nClick to play this sighting on the collection timeline.',
    }, img, el('span.su-lb', {}, `P${a.person.n}`));
    node.addEventListener('mouseenter', () => focus(a.person.n));
    node.addEventListener('mouseleave', blur);
    /* GÖRÜLMENİN BAŞINDAN oynuyor, temsili kırpımın anından değil: temsili
       kırpım en büyük olan, yani çoğu zaman kişinin kameraya en yakın
       olduğu an — ortası. Kullanıcı "bu kişiyi izleyeyim" diyorsa girişten
       başlamalı. */
    const head = a.tracks[0];
    node.onclick = () => {
      location.hash = playLink(head, { t: head.t_first, track: head.track_id });
    };
    return node;
  }

  /* Bağsız track: RENKSİZ. Renk "bu kişi başka kamerada da var" demek;
     buradaki track hakkında böyle bir şey bilinmiyor. */
  function looseChip(o) {
    const node = el('div.su-chip.loose', {
      title: `#${o.track_id} · ${clock.clock(o._t0)}\n`
        + 'Not linked to any person yet.\n'
        + 'Click to play this track on the collection timeline.',
    },
      el('img.su-crop', {
        src: o.crop, loading: 'lazy',
        onerror: (e) => { e.target.style.visibility = 'hidden'; },
      }),
      el('span.su-lb', {}, `#${o.track_id}`));
    node.onclick = () => {
      location.hash = playLink(o, { t: o.t_first, track: o.track_id });
    };
    return node;
  }

  function renderEvents(c) {
    const d = data.get(c.b.id);
    if (!d) return;
    const list = d.events.filter((e) => showQuiet || !e.quiet);
    clear(c.events);
    if (!list.length) {
      c.events.append(el('div.empty', {},
        el('span', { class: 'big' }, '·'),
        el('div', { class: 'ttl' }, 'No event'),
        el('div', { class: 'why' }, d.events.length
          ? `${d.events.length} segments, all of them quiet. Turn on `
            + '"Quiet events" to see them.'
          : 'The analysis produced no event for this group.')));
      return;
    }
    for (const ev of list) c.events.append(eventCard(ev, c.b));
  }

  function eventCard(ev, b) {
    const dots = el('div.su-evdots', {});
    for (const n of ev._p || []) {
      const a = findApp(b.id, n);
      dots.append(el('i', {
        style: { background: (a && a.color) || '#4a5a70' },
        title: `Person ${n} was on this camera at the same time`,
      }));
    }
    const node = el('div.su-ev', {
      class: ev.quiet ? 'quiet' : '',
      'data-p': (ev._p || []).join(' '),
      title: `${clock.clock(ev._t0)} – ${clock.clock(ev._t1)}\n`
        + `${ev.description || ev.title}\n\n`
        + 'Click to play this moment on the collection timeline.',
    },
      el('div.su-evr', {},
        el('span.su-evt', {}, clock.clock(ev._t0)),
        el('span.su-evk', {}, ev.type_tr || ev.type),
        el('span.grow'),
        dots),
      el('div.su-evx', {}, ev.title));
    /* Olay da kişi gibi KOLEKSİYON ekranında açılıyor, tek video ekranında
       değil. İki kart tipinin iki ayrı ekrana gitmesi, aynı duvarda aynı
       hareketin iki farklı sonuç vermesi olurdu; ayrıca olayın komşusu
       öteki kameradaki olay — o da orada. */
    node.onclick = () => {
      location.hash = playLink(ev, { mode: 'events', t: ev.t_start });
    };
    return node;
  }

  function findApp(bandId, n) {
    const d = data.get(bandId);
    return d ? d.apps.find((a) => a.person.n === n) : null;
  }

  function renderSummary() {
    const people = new Set();
    let evn = 0;
    let loose = 0;
    for (const d of data.values()) {
      for (const a of d.apps) people.add(a.person.n);
      evn += d.events.filter((e) => showQuiet || !e.quiet).length;
      loose += d.loose.length;
    }
    const done = data.size === clock.bands.length;
    sumLbl.textContent = `${people.size} linked · ${loose} unlinked · `
      + `${evn} events${done ? '' : ' …'}`;

    /* Sessiz segment sayısı düğmenin üstünde yazıyor — bkz. quietBtn. */
    let q = 0;
    for (const d of data.values()) q += d.events.filter((e) => e.quiet).length;
    quietBtn.textContent = `${q} quiet`;
    quietBtn.style.display = q ? '' : 'none';
  }

  /* =============================================================== ODAK ===
     Bir kişinin üstüne gelmek: o kişinin bulunduğu bütün sütunları aç,
     kutularını yak, aralarına çizgiyi çek, olaylarını vurgula, gerisini
     söndür. Tek hareket, dört sonuç — ve hepsi geri alınabilir. */

  function focus(n) {
    focusN = n;
    track.classList.add('focus');
    const perCol = [];
    for (const c of colEls) {
      const d = data.get(c.b.id);
      if (!d || !d.apps.some((a) => a.person.n === n)) continue;
      c.node.classList.add('open');
      const lit = c.chips.querySelectorAll(`.su-chip[data-p="${n}"]`);
      lit.forEach((x) => x.classList.add('lit'));
      /* Çizgi SÜTUNDAN SÜTUNA gidiyor, kutudan kutuya değil: aynı sütunda
         iki görülme varsa ikisi de yanıyor ama çizgi birincisine bağlanıyor.
         İkisine birden bağlamak aynı sütunun içinde bir çizgi çizmek olurdu
         ve o çizgi hiçbir şey anlatmazdı. */
      if (lit.length) perCol.push(lit[0]);
    }
    for (const c of colEls) {
      for (const ev of c.events.querySelectorAll('.su-ev')) {
        const has = (ev.dataset.p || '').split(' ').includes(String(n));
        ev.classList.toggle('hot', has);
      }
    }
    const a = firstApp(n);
    drawWires(perCol, (a && a.color) || WIRE);
  }

  function firstApp(n) {
    for (const d of data.values()) {
      const a = d.apps.find((x) => x.person.n === n);
      if (a) return a;
    }
    return null;
  }

  function blur() {
    focusN = null;
    track.classList.remove('focus');
    for (const x of track.querySelectorAll('.lit')) x.classList.remove('lit');
    for (const x of track.querySelectorAll('.hot')) x.classList.remove('hot');
    /* FARENİN ALTINDAKİ SÜTUN AÇIK KALIYOR.
       Hepsini birden kapatmak, kullanıcı bir kutudan yan kutuya geçerken
       şeridi imlecin altından çekip alıyordu: kapanan şerit artık imlecin
       altında olmadığı için `mouseenter` bir daha gelmiyor ve sütun kapalı
       kalıyordu. `:hover` sorusu bunu tek satırda çözüyor. */
    for (const c of colEls) {
      c.node.classList.toggle('open', c.node.matches(':hover'));
    }
    clear(wires);
  }

  /**
   * Sütunlar arası bağlantı çizgileri.
   *
   * Koordinatlar `.su-track`e GÖRE alınıyor ve SVG de onun içinde duruyor;
   * bu yüzden yatay kaydırmada çizgi içerikle birlikte kayıyor, yeniden
   * hesap gerekmiyor. Dikey kaydırma ayrı: sütun başlıkları yapışkan
   * (sticky), yani ekranda kalırken içeriğe göre yer değiştiriyorlar —
   * `scroller` dinleyicisi o durumda yeniden çiziyor.
   */
  function drawWires(chips, color) {
    clear(wires);
    if (chips.length < 2) return;
    const tr = track.getBoundingClientRect();
    const pts = chips.map((ch) => {
      const r = ch.getBoundingClientRect();
      return {
        l: r.left - tr.left,
        r: r.right - tr.left,
        y: r.top - tr.top + r.height * 0.45,
      };
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mid = (a.r + b.l) / 2;
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d',
        `M ${a.r} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.l} ${b.y}`);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      wires.appendChild(p);
    }
    /* Uç noktalar: çizginin hangi kutuya değdiği, kutunun kenarındaki iki
       piksellik farktan değil bu noktadan okunuyor. */
    pts.forEach((pt, i) => {
      const xs = [];
      if (i > 0) xs.push(pt.l);
      if (i < pts.length - 1) xs.push(pt.r);
      for (const x of xs) {
        const cc = document.createElementNS(SVGNS, 'circle');
        cc.setAttribute('cx', String(x));
        cc.setAttribute('cy', String(pt.y));
        cc.setAttribute('r', '3');
        cc.setAttribute('fill', color);
        wires.appendChild(cc);
      }
    });
  }

  /* Yapışkan başlıklar kaydırırken yer değiştiriyor; odak açıkken çizgiyi
     tazele. rAF ile: kaydırma olayı saniyede onlarca kez geliyor. */
  let raf = null;
  const onScroll = () => {
    if (!focusN || raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      if (focusN) focus(focusN);
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onLeave(() => {
    window.removeEventListener('resize', onScroll);
    if (raf) cancelAnimationFrame(raf);
  });
}
