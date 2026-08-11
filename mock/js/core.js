/* ============================================================================
   core.js — DOM yardımcıları, store, API istemcisi, TimeMapper
   ----------------------------------------------------------------------------
   Üretimde: store → Alpine.store(), el() → x-html/şablonlar,
   API katmanı olduğu gibi kalır.
   ========================================================================= */

/* ------------------------------------------------------------ özellikler --
   Backend'in hazır olma durumuna göre arayüzü açıp kapatır.
   Kod silinmez — sadece görünmez olur. Backend hazır olunca true yap. */
export const FEATURES = {
  reid: localStorage.getItem('ff.reid') === '1',   // Re-ID: fotoğraftan sorgu
  multiCamera: true,
  eventSearch: true,       // VLM açıklamalarında metin filtresi
  map: false,              // 지도 보기 — camera.lat/lon hazır, UI yok
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

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
export function mount(n, ...kids) { clear(n); add(n, kids); return n; }

/* -------------------------------------------------------------- store ---- */

class Store {
  constructor(init) { this.s = init; this.subs = new Map(); this.n = 0; }
  get(k) { return this.s[k]; }
  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (this.s[k] !== v) { this.s[k] = v; changed.push(k); }
      else this.s[k] = v;
    }
    for (const k of Object.keys(patch)) this.emit(k);
    this.emit('*');
  }
  /** Nesne içeriği değişmişse bile bildirim gönder (dizi mutasyonları için). */
  touch(...keys) { keys.forEach(k => this.emit(k)); this.emit('*'); }
  on(key, fn) {
    if (!this.subs.has(key)) this.subs.set(key, new Set());
    this.subs.get(key).add(fn);
    return () => this.subs.get(key).delete(fn);
  }
  emit(key) { (this.subs.get(key) || []).forEach(f => { try { f(this.s); } catch (e) { console.error(e); } }); }
}

export const store = new Store({
  user: null,
  lang: localStorage.getItem('lang') || 'ko',
  groups: [],
  eventTypes: {},
  attributes: null,

  videoId: null,
  video: null,
  summary: null,
  events: [],
  objects: [],
  detections: null,     // { fps, rows, byTime: Map }
  segments: null,

  playhead: 0,          // medya zamanı (saniye)
  duration: 0,
  playing: false,
  showBoxes: true,
  showTrails: true,
  showLabels: true,

  filters: { cls: '', gender: '', upper_color: [], carry: [], age: '' },
  activeEventId: null,
  hoverTrackId: null,
  selectedTrackIds: [],

  search: null,         // { query, items, total, latency_ms }
  candidates: null,     // event_candidate_score pencereleri
  reid: null,           // { session, query, candidates, status }
  tracklist: { id: 'TL1', members: [] },
  jobs: [],
  gpu: null,
});

/* ------------------------------------------------------------- i18n ------ */

const T = {
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
  tr: {
    videoList: 'Video grupları', objectFilter: 'Nesne filtresi', videoInfo: 'Video bilgisi',
    summaryInfo: 'Özet bilgisi', eventFlow: 'Zaman akışı',
    reSummarize: 'Yeniden özetle', viewOriginal: 'Orijinali aç', allEvents: 'Tüm olaylar',
    apply: 'Uygula', reset: 'Sıfırla', objectKind: 'Nesne tipi',
    all: 'Hepsi', person: 'Kişi', vehicle: 'Araç', gender: 'Cinsiyet',
    male: 'Erkek', female: 'Kadın', upperColor: 'Üst giysi rengi',
    videoLength: 'Video süresi', summaryLength: 'Özet süresi', mainObject: 'Ana nesneler',
    mainEvent: 'Olay sayısı', generatedAt: 'Üretim zamanı',
    single: 'Tek video özeti', multi: 'Çoklu kamera', objects: 'Nesne listesi',
    jobs: 'İş yönetimi', settings: 'Ayarlar', system: 'Sistem', api: 'API sözleşmesi',
    search: 'Olay araması', prompt: 'Analiz prompt\'u',
    track: 'Takip et', tracking: 'Takip listesi', candidates: 'Aday',
    similarity: 'Benzerlik', continueSearch: 'Aramaya devam', sameperson: 'Aynı kişi',
    notsame: 'Farklı', logout: 'Çıkış', carry: 'Taşınan eşya', age: 'Yaş',
  },
};
export function t(k) { return (T[store.get('lang')] || T.ko)[k] || k; }
export function loc(obj, base) {
  const l = store.get('lang');
  return obj[`${base}_${l}`] ?? obj[`${base}_ko`] ?? obj[base] ?? '';
}

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
export function pct(x) { return (x * 100).toFixed(0) + '%'; }

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

/* ---------------------------------------------------------------- API ---- */

const BASE = '/api';

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const txt = await r.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!r.ok) {
    const msg = (data && data.error) || r.statusText;
    const e = new Error(msg); e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) {
    if (v === undefined || v === null || v === '' ||
        (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
};

export const api = {
  health: () => req('/health'),
  openapi: () => req('/openapi'),

  login: (username, password) =>
    req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  me: () => req('/auth/me'),

  groups: () => req('/groups'),
  attributes: () => req('/attributes'),
  metrics: () => req('/metrics'),        // event_candidate_score sözlüğü

  video: (id) => req(`/videos/${id}`),
  summary: (id) => req(`/videos/${id}/summary`),
  events: (id, o) => req(`/videos/${id}/events${qs(o)}`),
  event: (id) => req(`/events/${id}`),
  // event_status: candidate | confirmed | dismissed
  eventStatus: (id, status) =>
    req(`/events/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  eventGroups: () => req('/event-groups'),
  analysisJobs: () => req('/analysis-jobs'),
  detections: (id, o) => req(`/videos/${id}/detections${qs(o)}`),
  objects: (id, o) => req(`/videos/${id}/objects${qs(o)}`),
  candidates: (id, o) => req(`/videos/${id}/candidates${qs(o)}`),
  streamUrl: (id) => `${BASE}/videos/${id}/stream`,
  posterUrl: (id) => `${BASE}/videos/${id}/poster`,
  analyze: (id, body) =>
    req(`/videos/${id}/analyses`, { method: 'POST', body: JSON.stringify(body || {}) }),

  search: (body) => req('/search', { method: 'POST', body: JSON.stringify(body) }),
  searchGet: (id) => req(`/searches/${id}`),

  jobs: () => req('/jobs'),
  job: (id) => req(`/jobs/${id}`),
  jobStreamUrl: (id) => `${BASE}/jobs/${id}/stream`,
  jobCancel: (id) => req(`/jobs/${id}/cancel`, { method: 'POST' }),

  reidStart: (body) => req('/reid', { method: 'POST', body: JSON.stringify(body) }),
  reid: (sid) => req(`/reid/${sid}`),
  reidStreamUrl: (sid) => `${BASE}/reid/${sid}/stream`,
  reidContinue: (sid, batches = 2) =>
    req(`/reid/${sid}/continue`, { method: 'POST', body: JSON.stringify({ batches }) }),
  // identity_match_status: candidate | confirmed | rejected
  reidVerdict: (sid, object_id, status) =>
    req(`/reid/${sid}/verdict`, { method: 'POST', body: JSON.stringify({ object_id, status }) }),

  tracklists: () => req('/tracklists'),
  tracklist: (id) => req(`/tracklists/${id}`),
  trackAdd: (id, body) =>
    req(`/tracklists/${id}/members`, { method: 'POST', body: JSON.stringify(body) }),
  trackDel: (id, oid) => req(`/tracklists/${id}/members/${oid}`, { method: 'DELETE' }),

  gpu: () => req('/system/gpu'),
  logs: (o) => req(`/logs${qs(o)}`),
  settings: () => req('/settings'),
  saveSettings: (b) => req('/settings', { method: 'PUT', body: JSON.stringify(b) }),
  exportStart: (b) => req('/exports', { method: 'POST', body: JSON.stringify(b) }),
  exportGet: (id) => req(`/exports/${id}`),
};

/* ----------------------------------------------------------- SSE utils --- */
/**
 * Uzun işleri dinler. Üretimde WebSocket'e çevrilecekse sadece bu fonksiyon
 * değişir — çağıran kod aynı kalır.
 */
export function listen(url, onEvent, eventName = 'message') {
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

export function simClass(s) { return s >= 0.72 ? 'hi' : s >= 0.45 ? 'mid' : 'lo'; }
export function simColor(s) {
  return s >= 0.72 ? '#22c55e' : s >= 0.45 ? '#eab308' : '#64748b';
}

/** Öznitelik nesnesini insan okur hale getirir. */
export function attrText(attrs, attrDefs, cls) {
  if (!attrs || !attrDefs) return '';
  const defs = attrDefs[cls === 'vehicle' ? 'vehicle' : 'person'] || [];
  const lang = store.get('lang');
  const out = [];
  for (const d of defs) {
    const v = attrs[d.key];
    if (!v || (Array.isArray(v) && !v.length)) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const vv of vals) {
      const found = d.values.find(x => x.v === vv);
      if (found) out.push(lang === 'tr' ? found.tr : found.ko);
    }
  }
  return out.join(' · ');
}
