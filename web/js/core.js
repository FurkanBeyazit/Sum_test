/* ============================================================================
   core.js — DOM yardımcıları, store, biçimleme, TimeMapper
   ----------------------------------------------------------------------------
   Veri kaynağı tek: gerçek DVSummary backend'i (`backend.js`). Mock katmanı
   2026-08-27'de kaldırıldı — gerçek API hazır olduğu için iki kaynağı ayakta
   tutmanın karşılığı kalmamıştı. Çalışır hâli `archive/mock/` altında.
   ========================================================================= */

import { backendApi } from './backend.js';

/* ------------------------------------------------------------ özellikler --
   Backend'in hazır olma durumuna göre arayüzü açıp kapatır.
   Kod silinmez — sadece görünmez olur. Uç geldiğinde true yap. */
export const FEATURES = {
  /* Object Page: backend 2026-08-27'de
     /analysis/result/{id}/tracks + /tracks/par/stats + /track/{id}/crop
     uçlarını verdi — açık. */
  objects: true,

  /* Video üstü kutu katmanı — AÇIK.
       GET /playback/groups/{gid}/bboxes?start_at=&end_at=&format=json
     Uç grup kapsamlı ve duvar saatiyle sorgulanıyor; ikisini de backend.js
     içindeki detections() çeviriyor. Veri tüm videoyu kapsıyor ama tek
     seferde inmiyor: playhead'in çevresinde üç pencere tutuluyor, gerisi
     atılıyor (bkz. bboxfeed.js). Kapatmak için tek satır: `bbox: false`. */
  bbox: true,

  /* BİRLEŞTİRME AÇIK. Bu ekip her zaman birden çok parça yükleyip tek bir
     kayıt elde ediyor; ayrı ayrı yüklemek diye bir kullanım yok. Kip
     kapatılırsa ham dosya backend'e olduğu gibi gider — AVI yüklendiğinde
     backend'de de AVI durur ve hiçbir tarayıcıda oynatılamaz. ffmpeg
     çıktısı her zaman MP4 olduğu için oynatılabilirlik bu hattan geliyor. */
  merge: true,

  /* Onay kutusu GİZLİ — özellik değil, yalnızca anahtarı. Müşteri demoda
     seçenek görmek istemedi; kip zaten hep açık kalacağı için kutunun bir
     işlevi de yoktu. Geri getirmek için: `mergeToggle: true`. */
  mergeToggle: false,

  /* HLS — varsayılan KAPALI, ama artık ekrandan açılabiliyor.
       GET /playback/groups/{gid}/hls/media.m3u8
     Grubun bütün parçaları tek çalma listesinde; parça değiştirme kodu devre
     dışı kalıyor ve yerel proxy'ye gerek kalmıyor.

     BİR SÜRE VARSAYILAN AÇIKTI, GERİ ALINDI: sahada denendiğinde parça
     geçişlerinde Stream yolundan gözle görülür biçimde yavaş kaldı (segment
     tamponlaması, geçişte duraklama). Yol yanlış değil, bugünkü hâliyle
     daha yavaş — o yüzden varsayılan eski yol, HLS bir tık uzakta:
     koleksiyon başlığındaki Stream/HLS anahtarı ya da `?hls=1`.

     Tek videoda anlamı yok: uç grup kapsamlı.
     Chrome için `web/vendor/hls.min.js` gerekiyor; dosya yoksa ekran
     kendiliğinden eski oynatıcıya düşüyor ve sebebini yazıyor. */
  hls: false,

  /* Re-ID AÇIK. Backend uç verdi:
       GET /analysis/result/groups/{gid}/video/{vid}/track/{tid}/reid/stream
     Grup içindeki track'leri hedefle karşılaştırıp eşleşme sıralamasını SSE
     ile gönderiyor. Object ekranındaki kip anahtarı bunu kullanıyor; bayrak
     kapatılırsa anahtar çizilmez ve ekran bugünkü native davranışında kalır. */
  reid: true,
  map: false,              // 지도 보기 — camera.lat/lon hazır, UI yok

  /* --- karşılığı olmayanlar ------------------------------------------------
     Kod duruyor, sadece çizilmiyor; açmak için değeri true yapmak yeterli. */

  // Kural tabanlı aday skoru — analiz hattı üretmiyor, ısı haritası hep boş.
  candidateScore: false,
  // Olay metni araması — backend'de arama ucu yok.
  eventSearch: false,
  // candidate/confirmed/dismissed onay akışı — backend'de kalıcı değil.
  eventStatus: false,
  // Oynatıcı üzerindeki kare yakalama düğmesi
  snapshot: false,
};

// Konsoldan aç:  localStorage.setItem('ff.reid','1'); location.reload()

/* ---------------------------------------------------------------- DOM ---- */

export function el(tag, attrs = {}, ...kids) {
  const parts = tag.split(/([.#])/);
  const node = document.createElement(parts[0] || 'div');
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === '.') node.classList.add(parts[i + 1]);
    else node.id = parts[i + 1];
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'data' && typeof v === 'object')
      for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else node.setAttribute(k, v === true ? '' : v);
  }
  add(node, kids);
  return node;
}

function add(node, kids) {
  for (const k of kids.flat(4)) {
    if (k === null || k === undefined || k === false) continue;
    node.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
export function mount(n, ...kids) { clear(n); add(n, kids); return n; }

/* -------------------------------------------------------------- store ---- */

/* Ekranlar ARASI taşınan durum. Sadece bu.
   -------------------------------------------------------------------------
   Ekrana özel durum (seçili nesne, atanmış renkler, açık panel) buraya
   girmiyor: ekran fonksiyonunun kapanışında yaşıyor ve ekran kapanınca
   kendiliğinden gidiyor.

   YAYIN/ABONE YOK. Sınıfın bir zamanlar `on()/emit()/touch()` metodları
   vardı ve hiçbir yerde kullanılmıyordu — ekranlar `mount()` ile kendini
   bütün olarak yeniden çiziyor, parça parça güncellemiyor. Kullanılmayan bir
   soyutlama, olmayandan kötü: bakan biri reaktif bir sistem arıyor.
   Gerekirse geri eklenir; o gün gelene kadar iki metot yeter.

   Aynı sebeple ~18 ölü anahtar da silindi (`playing`, `showTrails`,
   `segments`, `reid`, `jobs`…). Hepsi mock döneminden kalmıştı; hiçbiri
   okunmuyordu. */
class Store {
  constructor(init) { this.s = init; }
  get(k) { return this.s[k]; }
  set(patch) { Object.assign(this.s, patch); }
}

export const store = new Store({
  user: null,
  /* Tek dil: İngilizce. Alana özgü terimler (durum adları, öznitelik
     değerleri) Korece kalıyor — müşterinin sözlüğü o. Eski 'tr' seçeneği
     kaldırıldı; localStorage'da kalmış olabilir, ona düşmüyoruz. */
  lang: localStorage.getItem('lang') === 'ko' ? 'ko' : 'en',
  groups: [],
  /* Koleksiyonlar — gruplarin ustundeki katman. Agac paneli gruplari bunlarin
     altina diziyor; bos kalirsa eski duz liste gorunumu aynen kaliyor. */
  collections: [],
  attributes: null,

  filters: { cls: '', gender: '', upper_color: [], carry: [], age: '' },
  playhead: 0,          // medya zamanı (saniye) — video yokken okunur
  activeEventId: null,
});

/* ------------------------------------------------------------- i18n ------ */

const T = {
  en: {
    /* 'Video Collection' DEGIL: artik backend'de gercek bir collection
       kavrami var (gruplarin demeti) ve bu panel onu degil, kayitlarin
       agacini gosteriyor. Ayni kelimeyi iki sey icin kullanmak karisiyordu. */
    videoList: 'Recordings', objectFilter: 'Object filter',
    videoInfo: 'Video info', summaryInfo: 'Analysis info',
    eventFlow: 'Event timeline',
    reSummarize: 'Re-analyze', viewOriginal: 'Open original',
    allEvents: 'All events',
    apply: 'Apply', reset: 'Reset', objectKind: 'Object type',
    all: 'All', person: 'Person', vehicle: 'Vehicle', gender: 'Gender',
    male: 'Male', female: 'Female', upperColor: 'Top color',
    videoLength: 'Video length', summaryLength: 'Summary length',
    mainObject: 'Main objects', mainEvent: 'Events',
    generatedAt: 'Analyzed at',
    single: 'Analysis', multi: 'Multi-camera', objects: 'Objects',
    jobs: 'Jobs', settings: 'Settings', system: 'System', api: 'API contract',
    search: 'Search events', prompt: 'Analysis prompt',
    track: 'Track', tracking: 'Track list', candidates: 'Candidates',
    similarity: 'Similarity', continueSearch: 'Continue', sameperson: 'Same person',
    notsame: 'Different', logout: 'Log out', carry: 'Carried item', age: 'Age',
  },
  ko: {
    videoList: '영상 그룹', objectFilter: '객체 필터', videoInfo: '영상 정보',
    summaryInfo: '요약 정보', eventFlow: '시간별 사건 흐름',
    reSummarize: '재요약', viewOriginal: '원본 영상 보기', allEvents: '모든 이벤트 보기',
    apply: '필터 적용', reset: '필터 초기화', objectKind: '객체 종류',
    all: '전체', person: '사람', vehicle: '차량', gender: '성별',
    male: '남성', female: '여성', upperColor: '의상 색상',
    videoLength: '영상 길이', summaryLength: '요약 길이', mainObject: '주요 객체',
    mainEvent: '주요 이벤트', generatedAt: '요약 생성 시간',
    single: '단일 영상 요약', multi: '복합 상황 요약', objects: '객체 목록',
    jobs: '작업 관리', settings: '설정', system: '시스템', api: 'API 계약',
    search: '이벤트 검색', prompt: '분석 프롬프트',
    track: '추적', tracking: '추적 대상 목록', candidates: '후보',
    similarity: '유사도', continueSearch: '계속 검색', sameperson: '동일 인물',
    notsame: '다름', logout: '로그아웃', carry: '소지품', age: '연령대',
  },
};
export function t(k) { return (T[store.get('lang')] || T.en)[k] || k; }

/* --------------------------------------------------------------- fmt ----- */

export const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

/** Saniye → HH:MM:SS */
export function hms(sec) {
  if (!isFinite(sec)) return '--:--:--';
  const s = Math.max(0, sec);
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}
/** Saniye → MM:SS */
export function ms(sec) {
  if (!isFinite(sec)) return '--:--';
  const s = Math.max(0, sec);
  return `${pad(s / 60)}:${pad(s % 60)}`;
}
/** Saniye → 1h 24m 03s */
export function dur(sec) {
  if (!isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
  return (h ? `${h}h ` : '') + (h || m ? `${m}m ` : '') + `${s}s`;
}
/**
 * Saniye → kabaca "45s" / "12 min" / "2h 10m".
 *
 * `dur()` her basamağı yazıyor ("2m 0s"); kayıt boşluklarında istenen o
 * değil, tek bakışta okunan bir büyüklük. Zaman çizgisindeki tarama alanı
 * ile oynatıcı çubuğundaki rozet AYNI metni kullansın diye burada.
 */
export function roughDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
export function bytes(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}
export function clockOf(isoStr) {
  if (!isoStr) return '--:--:--';
  return isoStr.slice(11, 19);
}
export function dateOf(isoStr) {
  if (!isoStr) return '';
  return isoStr.slice(0, 10);
}

/* ------------------------------------------------------- TimeMapper ------ */
/**
 * Medya zamanı ↔ duvar saati ↔ özet video zamanı dönüşümlerinin TEK yeri.
 * Bu dönüşümü hiçbir yerde elle yapma — bug'ların %80'i burada doğar.
 */
export class TimeMapper {
  /**
   * @param {string} startIso  videonun gerçek başlangıç zamanı (ISO+09:00)
   * @param {Array}  segments  özet video segment eşlemesi (opsiyonel)
   */
  constructor(startIso, segments = []) {
    this.startIso = startIso || null;
    this.startMs = startIso ? Date.parse(startIso) : 0;
    this.segments = segments || [];
  }
  /** medya zamanı (s) → Date */
  toWall(mediaSec) { return new Date(this.startMs + mediaSec * 1000); }
  /** medya zamanı (s) → "HH:MM:SS" */
  wallClock(mediaSec) {
    if (!this.startIso) return hms(mediaSec);
    const d = this.toWall(mediaSec);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  /** medya zamanı (s) → "YYYY-MM-DD HH:MM:SS" */
  wallFull(mediaSec) {
    if (!this.startIso) return hms(mediaSec);
    const d = this.toWall(mediaSec);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  /** duvar saati (Date|ms) → medya zamanı (s) */
  toMedia(when) {
    const ms_ = when instanceof Date ? when.getTime()
      : (typeof when === 'string' ? Date.parse(when) : when);
    return (ms_ - this.startMs) / 1000;
  }
  /** özet video zamanı → { videoId, srcTime } */
  summaryToSource(sumSec) {
    for (const s of this.segments) {
      if (sumSec >= s.sum_start && sumSec <= s.sum_end) {
        return {
          videoId: s.src_video_id,
          srcTime: s.src_start + (sumSec - s.sum_start),
          eventId: s.event_id,
        };
      }
    }
    return null;
  }
  /** kaynak zaman → özet video zamanı (varsa) */
  sourceToSummary(srcSec, videoId) {
    for (const s of this.segments) {
      if (s.src_video_id === videoId && srcSec >= s.src_start && srcSec <= s.src_end)
        return s.sum_start + (srcSec - s.src_start);
    }
    return null;
  }
}

/* Tek veri kaynağı. Ekranlar `import { api }` yazıyor, altındaki adaptörü
   bilmiyor.

   MODÜL DÜZEYİNDE `await` YOK. Eskiden burada `await initBackend()` vardı ve
   `core.js`i import eden her modül o ağ isteğini bekliyordu: backend yavaşsa
   ekran boş kalıyordu. Adaptör artık senkron kuruluyor; ağa çıkan ilk iş
   `app.js` içindeki `boot()` — orada hata yakalanıp kullanıcıya gösteriliyor. */
export const api = backendApi;

/* ----------------------------------------------------------- SSE utils --- */
/**
 * Uzun işleri dinler. Üretimde WebSocket'e çevrilecekse sadece bu fonksiyon
 * değişir — çağıran kod aynı kalır.
 */
export function listen(url, onEvent, eventName = 'message') {
  // Gerçek backend'de SSE yok; adaptör null döndürür. Boş URL'e EventSource
  // açmak anlamsız bir istek üretir — sessizce vazgeç.
  if (!url) return () => {};
  const es = new EventSource(url);
  const handler = (e) => {
    try { onEvent(JSON.parse(e.data)); } catch { /* ping */ }
  };
  es.addEventListener(eventName, handler);
  if (eventName !== 'message') es.addEventListener('message', handler);
  es.onerror = () => { /* sunucu kapattı — sessizce bitir */ es.close(); };
  return () => es.close();
}

/* -------------------------------------------------------------- toast ---- */

export function toast(msg, kind = 'ok', ms_ = 3200) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div#toasts'); document.body.append(host); }
  const icons = { ok: '✓', warn: '!', err: '✕', info: 'i' };
  const n = el('div.toast', { class: kind },
    el('span', { style: { fontWeight: 800, opacity: .8 } }, icons[kind] || '·'),
    el('span', {}, msg));
  host.append(n);
  setTimeout(() => {
    n.style.transition = 'opacity .25s, transform .25s';
    n.style.opacity = '0'; n.style.transform = 'translateX(14px)';
    setTimeout(() => n.remove(), 260);
  }, ms_);
}

/* -------------------------------------------------------------- modal ---- */

export function modal({ title, body, footer, wide }) {
  const bd = el('div.backdrop', {
    onclick: (e) => { if (e.target === bd) close(); },
  });
  const close = () => bd.remove();
  const m = el('div.modal',
    wide ? { style: { width: 'min(980px,97vw)' } } : {},
    el('div.modal-h', {}, el('span.grow', {}, title),
      el('button.iconbtn', { onclick: close }, '✕')),
    el('div.modal-b', {}, body),
    footer ? el('div.modal-f', {}, footer) : null);
  bd.append(m);
  document.body.append(bd);
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  return close;
}

/* ------------------------------------------------------------ renkler ---- */

export const COLOR_HEX = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  blue: '#3b82f6', purple: '#a855f7', white: '#f8fafc', gray: '#94a3b8',
  black: '#1e293b', beige: '#d6c7a1', silver: '#cbd5e1',
};

/** track_id → tutarlı renk (overlay ve timeline aynı rengi kullansın) */
export function trackColor(id) {
  const P = ['#38bdf8', '#f472b6', '#4ade80', '#fbbf24', '#a78bfa',
    '#2dd4bf', '#fb923c', '#f87171', '#60a5fa', '#c084fc'];
  return P[Math.abs(id * 7 + 3) % P.length];
}

/** Öznitelik nesnesini insan okur hale getirir. */
export function attrText(attrs, attrDefs, cls) {
  if (!attrs || !attrDefs) return '';
  /* PAR yalnızca iki şema tanıyor: insan ve araç. `cls` artık modelin sınıf
     adı, o yüzden eşleme burada. Hayvanın hiçbir özniteliği yok — araç
     şeması hiçbir anahtarı tutmayacağı için boş dönüyor, doğrusu da bu. */
  const which = (cls === 'person' || cls === 'falldown') ? 'person' : 'vehicle';
  const defs = attrDefs[which] || [];
  const lang = store.get('lang');
  const out = [];
  for (const d of defs) {
    const v = attrs[d.key];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const vv of vals) {
      const found = d.values.find(x => x.v === vv);
      if (found) out.push(found.ko);
    }
  }
  return out.join(' · ');
}
