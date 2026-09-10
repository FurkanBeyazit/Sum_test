/* ============================================================================
   objsearch.js — nesne arama paneli (sınıf + PAR süzgeçleri)
   ----------------------------------------------------------------------------
   NEDEN AYRI DOSYA

   Bu panel önce Object ekranının içinde duruyordu. Koleksiyon ekranında da
   aynısı istendi ve "aynısı" kopyalayarak sağlanmıyor: iki kopya ilk
   değişiklikte ayrışır, sonra kullanıcı iki ekranda iki farklı süzgeç
   görür. Panel buraya taşındı, iki ekran da BURADAN çağırıyor.

   Panel kendi başına hiçbir şey yüklemiyor: seçimi tutuyor ve `Search`e
   basılınca `onSearch(sel)` çağırıyor. Veriyi kimin nereden çekeceği
   ekranın işi — Object tek kaydı, Koleksiyon bütün grupları soruyor.

   `sel` şekli:
     { cls: 'person', par: { gender:'Female', color:'Black', … } }
   `par` sözlüğünün anahtarları PANEL SATIRLARI, backend alan adları değil;
   çeviriyi `parQuery()` yapıyor.
   ========================================================================= */

import { el } from './core.js';
import { ageIcon, genderIcon } from './parchip.js';

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
export const CLASSES = [
  { v: 'person', icon: '🚶', label: 'Person' },
  { v: 'car', icon: '🚗', label: 'Car' },
  { v: 'bicycle', icon: '🚲', label: 'Bicycle' },
];

/* Cinsiyet ve yaş satırlarında EMOJİ YOK: 🧒/🧑/🧓 küçük boyutta neredeyse
   aynı görünüyor ve platforma göre değişiyor. Info rozetlerindeki çizimlerin
   aynısı kullanılıyor — süzgeçte ve sonuçta aynı simge. */
export const GENDERS = [
  { key: 'gender', v: 'Male', svg: genderIcon('Male'), label: 'Male' },
  { key: 'gender', v: 'Female', svg: genderIcon('Female'), label: 'Female' },
];

export const AGES = [
  { key: 'age', v: 'Child', svg: ageIcon('Child'), label: 'Child' },
  { key: 'age', v: 'Adult', svg: ageIcon('Adult'), label: 'Adult' },
  { key: 'age', v: 'Senior', svg: ageIcon('Senior'), label: 'Senior' },
];

export const EXTRAS = [
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
export const COLORS = ['Black', 'Gray', 'White', 'Navy', 'Blue', 'SkyBlue',
  'Green', 'Yellow', 'Orange', 'Red', 'Purple'];
export const COLOR_SWATCH = {
  Red: '#ef4444', Orange: '#f97316', Yellow: '#eab308', Green: '#22c55e',
  SkyBlue: '#38bdf8', Blue: '#3b82f6', Navy: '#1e3a8a', Purple: '#a855f7',
  White: '#f8fafc', Gray: '#94a3b8', Black: '#1e293b',
};

/**
 * Panel seçimleri → backend'in beklediği `par` listesi.
 *
 *   gender/age → kendi PAR anahtarında aranır
 *   color      → ANAHTARSIZ, yani upper VEYA lower alanında
 *   extra      → Hat / Backpack, boolean alanlar
 */
export function parQuery(sel) {
  const par = [];
  for (const [group, value] of Object.entries(sel.par || {})) {
    if (group === 'color') par.push({ key: null, value });
    else if (group === 'extra') par.push({ key: value, value });
    else par.push({ key: group, value });
  }
  return par;
}

/**
 * Paneli kurar.
 *
 * @param {(sel:object)=>void} onSearch `Search`e basılınca çağrılıyor.
 * @returns {{node: HTMLElement, sel: object, reset: Function}}
 */
export function buildSearch(onSearch) {
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
    onclick: () => onSearch(sel),
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
