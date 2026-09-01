import { el } from './core.js';

/* ------------------------------------------------------- PAR rozetleri ----
   PAR sonucu metin olarak yazılıyordu:

     age: Adult · gender: Male · hair: Short · upper: Black · lower: Grey

   Okunması taramaya göre yavaş. Rozetler aynı bilgiyi ikonla veriyor.

   YAŞ İÇİN EMOJİ KULLANILMIYOR. 🧒/🧑/🧓 küçük boyutta neredeyse aynı görünüyor
   ve platformlar arası değişiyor — bu üçünü ayırt etmek asıl istenen şeydi.
   Yerine boyu farklı üç figür çiziliyor: çocuk kısa ve büyük başlı, yetişkin
   tam boy, yaşlı bastonlu ve hafif öne eğik. Renk de ayrı (amber / mavi /
   mor) ki gri tonlu bir ekranda bile ayrılsın.

   Giysi rengi de ikon: tişört ve pantolon şekli PAR'ın verdiği renkle
   doluyor. "upper: Black" yazısını okumaktan hızlı.                        */

const AGE_TINT = { child: '#f59e0b', adult: '#38bdf8', senior: '#a855f7' };

/** Yaşa göre insan figürü — ayırt edici olan BOY ve baş oranı. */
export function ageIcon(v) {
  const k = String(v).toLowerCase();
  const c = AGE_TINT[k] || 'currentColor';
  const svg = (inner) => `<svg viewBox="0 0 20 24" width="15" height="18"
      fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  if (k === 'child') {
    // büyük baş, kısa gövde, kısa bacaklar — silüet çocuk oranında
    return svg('<circle cx="10" cy="9" r="4"/><path d="M10 13v4"/>'
             + '<path d="M6.5 15h7"/><path d="M8 21l2-4 2 4"/>');
  }
  if (k === 'senior') {
    // öne eğik gövde + baston: tek bakışta yetişkinden ayrılıyor
    return svg('<circle cx="8.5" cy="4" r="2.6"/><path d="M8.5 6.6 7 13"/>'
             + '<path d="M7 13 5.5 21"/><path d="M7 13l3 3"/>'
             + '<path d="M4.5 9 7 11"/><path d="M14 10v11"/>');
  }
  // adult — tam boy, normal oranlar
  return svg('<circle cx="10" cy="4" r="2.8"/><path d="M10 7v7"/>'
           + '<path d="M5.5 9.5h9"/><path d="M10 14l-2.5 7"/>'
           + '<path d="M10 14l2.5 7"/>');
}

/** Cinsiyet — Mars/Venüs sembolü, renkli. Emoji'den çok daha okunur. */
export function genderIcon(v) {
  const male = String(v).toLowerCase().startsWith('m');
  const c = male ? '#60a5fa' : '#f472b6';
  const inner = male
    ? '<circle cx="8" cy="14" r="5"/><path d="M12 10 19 3"/><path d="M14 3h5v5"/>'
    : '<circle cx="10" cy="8" r="5"/><path d="M10 13v7"/><path d="M6.5 17h7"/>';
  return `<svg viewBox="0 0 22 22" width="15" height="15" fill="none"
      stroke="${c}" stroke-width="1.8" stroke-linecap="round"
      aria-hidden="true">${inner}</svg>`;
}

/** Saç — uzunluk siluetten okunuyor. */
function hairIcon(v) {
  const k = String(v).toLowerCase();
  const cap = k.startsWith('bald')
    ? '<path d="M4 11a6 6 0 0 1 12 0"/>'
    : k.startsWith('long')
      ? '<path d="M4 11a6 6 0 0 1 12 0"/><path d="M4 11v7"/><path d="M16 11v7"/>'
      : '<path d="M4 11a6 6 0 0 1 12 0"/><path d="M4 11v2"/><path d="M16 11v2"/>';
  return `<svg viewBox="0 0 20 20" width="15" height="15" fill="none"
      stroke="#cbd5e1" stroke-width="1.7" stroke-linecap="round"
      aria-hidden="true">${cap}<circle cx="10" cy="13" r="3.4"/></svg>`;
}

/* PAR renk adları → hex. Uçtan gelen adlar sabit değil ("Grey"/"Gray",
   "SkyBlue"/"Sky Blue"), o yüzden normalleştirip bakıyoruz. */
const PAR_HEX = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  skyblue: '#38bdf8', blue: '#3b82f6', navy: '#1e3a8a', purple: '#a855f7',
  pink: '#f472b6', brown: '#92400e', white: '#f8fafc', gray: '#94a3b8',
  grey: '#94a3b8', silver: '#cbd5e1', beige: '#d6c7a1', black: '#1e293b',
};
const parHex = (v) => PAR_HEX[String(v).toLowerCase().replace(/[\s_-]/g, '')];

/* PAR bir parça için birden çok renk döndürebiliyor ve backend bunları
   "Blue, Purple" diye tek dizgede birleştiriyor. Böyle bir anahtar renk
   tablosunda yok, dolayısıyla eskiden yedek koyu tona düşüyor ve ekranda
   siyahtan ayırt edilemiyordu. Çoklu değerde İLK tanınan rengi seçiyoruz;
   tamamı rozetin ipucu metninde duruyor.                                 */
function pickColor(v) {
  for (const part of String(v).split(/[,/|]+/)) {
    const name = part.trim();
    const hex = parHex(name);
    if (hex) return { hex, name };
  }
  return null;
}

/* Koyu zeminde siyah/lacivert dolgu kayboluyor, açık zeminde beyaz/bej
   kayboluyor. Kontur rengini dolgunun parlaklığına göre seçiyoruz ki ikon
   her iki temada da bir siluet olarak dursun. */
function outlineFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587
             + (n & 255) * 0.114) / 255;
  return lum > 0.6 ? 'rgba(15,23,42,.55)' : 'rgba(255,255,255,.55)';
}

/** Renk baklası — ikonun yanında, rengi tek başına okunur kılıyor. */
function colorDot(hex) {
  const d = el('span.pardot');
  d.style.background = hex;
  return d;
}

/* Giysi silüetleri. Pantolon eskiden tek eğri bir şeritti ve etek gibi
   duruyordu; artık paça arası gerçek bir kertik olarak kesiliyor. */
const CLOTH_PATH = {
  upper: 'M7.5 2.6 3.8 4.9 5.5 8.6 7 7.9V17.4h6V7.9l1.5.7 1.7-3.7'
       + '-3.7-2.3L10 4.4Z',
  lower: 'M5.2 2.6H14.8L14.1 17.4H11.1L10 8.6 8.9 17.4H5.9Z',
};

/**
 * Giysi — tişört (üst) ve pantolon (alt).
 * @param {string|null} hex tanınan renk; null ise ikon BOŞ çiziliyor.
 *   Tanınmayan rengi koyu bir dolguyla göstermek "siyah" demek oluyordu —
 *   bilmediğimizi bilmiyormuş gibi göstermektense içi boş bırakıyoruz.
 */
function clothIcon(part, hex) {
  const fill = hex || 'none';
  const line = hex ? outlineFor(hex) : 'var(--tx-3, #64748b)';
  // Bel/omuz çizgisi: dolgu ile aynı renkteki iki parçayı ayırıyor.
  const seam = part === 'upper'
    ? '<path d="M7 7.9h6" />'
    : '<path d="M5.4 5.4h9.2" />';
  return `<svg viewBox="0 0 20 20" width="15" height="15"
      stroke="${line}" stroke-width="${hex ? '.9' : '1.3'}"
      stroke-linejoin="round"
      aria-hidden="true"><path d="${CLOTH_PATH[part]}" fill="${fill}"/>
      <g fill="none" opacity=".7">${seam}</g></svg>`;
}

/* Boolean aksesuarlar — burada emoji yeterli, ikisi birbirine benzemiyor. */
const EXTRA_ICON = {
  hat: '🧢', backpack: '🎒', bag: '👜', handbag: '👜', glasses: '👓',
  mask: '😷', umbrella: '☂', boots: '🥾', holdobjects: '📦',
};

/**
 * Tek bir PAR özniteliği → rozet.
 * @returns {HTMLElement|null} tanınmayan/boş değerde null (satırı kirletme)
 */
export function parChip(key, value) {
  const k = String(key).toLowerCase();
  const v = String(value);
  if (!v || /^(any|unknown|n\/a)$/i.test(v)) return null;

  const chip = (iconNode, label, dot) =>
    el('span.parchip', { title: `${key}: ${v}` }, iconNode,
      dot || null, el('span', {}, label));

  /* Emoji doğrudan metin düğümü; SVG'ler yukarıdaki sabit şablonlardan
     geliyor, dışarıdan gelen değer yalnızca renk aramasında kullanılıyor. */
  const svgBox = (markup) => {
    const box = el('span.parico');
    box.innerHTML = markup;
    return box;
  };

  if (k === 'age') return chip(svgBox(ageIcon(v)), v);
  if (k === 'gender' || k === 'sex') return chip(svgBox(genderIcon(v)), v);
  if (k === 'hair') return chip(svgBox(hairIcon(v)), `${v} hair`);
  if (k === 'upper' || k === 'lower') {
    /* Çoklu değerde tek renk gösteriliyor: iki bakla yan yana durunca
       hangisinin gerçekten baskın olduğu belli olmuyor, üstelik satır
       taşıyordu. Seçilmeyen değerler `title` içinde duruyor. */
    const c = pickColor(v);
    const part = k === 'upper' ? 'top' : 'bottom';
    return chip(svgBox(clothIcon(k, c && c.hex)),
      c ? `${c.name} ${part}` : `${v} ${part}`,
      c ? colorDot(c.hex) : null);
  }

  // Boolean aksesuarlar: anahtarın kendisi etiket ("Hat: Hat")
  const e = EXTRA_ICON[k.replace(/[\s_-]/g, '')];
  if (!e) return null;
  return chip(el('span.parico', {}, e), k[0].toUpperCase() + k.slice(1));
}

/** Nesnenin bütün PAR öznitelikleri → rozet listesi (boşsa uyarı satırı). */
export function parChips(o) {
  if (!o.par_exists) {
    return [el('span', { class: 'tiny muted' }, 'PAR did not run')];
  }
  const out = [];
  for (const [k, v] of Object.entries(o.attrs)) {
    const c = parChip(k, v);
    if (c) out.push(c);
  }
  return out.length ? out
    : [el('span', { class: 'tiny muted' }, 'no usable attribute')];
}
