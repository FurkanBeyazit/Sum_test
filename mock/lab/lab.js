/* Laboratuvar ortak yardımcıları.
   Ders dosyaları bunu <script src="lab.js"> ile yükler. */

/** Sayfanın kendi kaynağını çekip <!--LAB:START--> … <!--LAB:END--> arasını
 *  ekranda gösterir. Böylece okuduğun kod, çalışan kodun ta kendisi olur. */
async function showSource(sel = '#src') {
  const host = document.querySelector(sel);
  if (!host) return;
  const txt = await (await fetch(location.pathname)).text();
  const m = txt.match(/<!--LAB:START-->([\s\S]*?)<!--LAB:END-->/);
  if (!m) { host.textContent = '(kaynak işareti bulunamadı)'; return; }
  // Ortak girintiyi kırp
  const lines = m[1].replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const ind = Math.min(...lines.filter(l => l.trim())
    .map(l => l.match(/^ */)[0].length));
  host.textContent = lines.map(l => l.slice(ind)).join('\n');
}

/** Küçük konsol paneli. */
function makeLog(sel) {
  const el = document.querySelector(sel);
  return {
    write(...a) {
      el.textContent += a.join(' ') + '\n';
      el.scrollTop = el.scrollHeight;
    },
    set(...a) { el.textContent = a.join(' '); },
    clear() { el.textContent = ''; },
  };
}

/** Ders gezinme çubuğu. */
const LESSONS = [
  ['01-video.html', 'Video oynatmanın temeli'],
  ['02-range-seek.html', 'HTTP Range, seek, faststart'],
  ['03-letterbox.html', 'Canvas\'ı videonun üstüne koymak'],
  ['04-bbox.html', 'Normalize xywh → piksel'],
  ['05-frame-sync.html', 'timeupdate vs requestVideoFrameCallback'],
  ['06-metadata.html', 'Gerçek metadata ile tüm kutular'],
  ['07-track.html', 'track_id: renk, iz, etiket'],
  ['08-hittest.html', 'Kutuya tıklamak'],
  ['09-dpr.html', 'devicePixelRatio ve bulanıklık'],
  ['10-time.html', 'Medya zamanı ↔ duvar saati'],
  ['11-api.html', 'API, olay araması ve uzun işler'],
  ['12-mini.html', 'Hepsi bir arada — 120 satır'],
];

function navBar() {
  const cur = location.pathname.split('/').pop();
  const i = LESSONS.findIndex(l => l[0] === cur);
  const prev = i > 0 ? LESSONS[i - 1] : null;
  const next = i >= 0 && i < LESSONS.length - 1 ? LESSONS[i + 1] : null;
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML =
    (prev ? `<a href="${prev[0]}">← ${prev[1]}</a>` : '<span></span>') +
    `<a href="index.html">◈ Ders listesi</a>` +
    (next ? `<a href="${next[0]}">${next[1]} →</a>` : '<span></span>');
  document.body.append(nav);
}

/** Ders başlığı + breadcrumb. */
function header(title, lead) {
  const cur = location.pathname.split('/').pop();
  const i = LESSONS.findIndex(l => l[0] === cur);
  const c = document.createElement('div');
  c.innerHTML =
    `<div class="crumb"><a href="index.html">Laboratuvar</a> › ders `
    + `${String(i + 1).padStart(2, '0')} / ${LESSONS.length}</div>`
    + `<h1>${title}</h1><p class="lead">${lead}</p>`;
  document.body.prepend(c);
  document.title = `${i + 1}. ${title} · Lab`;
}

window.addEventListener('DOMContentLoaded', () => {
  showSource();
  navBar();
});

/* --- ortak sabitler -------------------------------------------------- */
const VIDEO_URL = '/api/videos/CAM01/stream';
const DET_URL = '/api/videos/CAM01/detections';
const META_URL = '/api/videos/CAM01';

/** track_id → sabit renk (uygulamadakiyle aynı mantık) */
function trackColor(id) {
  const P = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#008080', '#f032e6', '#9a6324', '#000075', '#808000'];
  return P[Math.abs(id * 7 + 3) % P.length];
}
