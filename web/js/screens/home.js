/* ==========================================================================
   Ekran: Home
   --------------------------------------------------------------------------
   Wireframe'deki yer tutucular (logo, kılavuz bağlantısı, telefon) bilerek
   olduğu gibi bırakıldı — proje sonunda güncellenecek. Gerçek olan tek şey
   sağ üstteki sunucu sağlık paneli: /status/health'ten geliyor.
   ========================================================================== */

import { el, mount, api, toast } from '../core.js';
import { ROOT, topbar, treePanel, startPolling } from '../ui.js';

export async function screenHome() {
  const sidebar = el('div.sidebar', {},
    treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }),
    el('div', { style: { padding: '10px' } },
      el('button.btn', {
        style: { width: '100%' },
        onclick: () => { location.hash = '#/upload'; },
      }, 'Upload & Analysis')));

  const stage = el('div.stage', { style: { padding: '18px', overflow: 'auto' } });
  mount(ROOT(), topbar('home'), el('div.main', {}, sidebar, stage));

  const guide = el('div.panel', { style: { flex: 1, minWidth: '340px' } },
    el('div.panel-h', {}, 'How to Use'),
    el('div.panel-b', { style: { display: 'grid', gap: '14px' } },
      ...[
        ['1', 'Create a collection',
         'Open Upload & Analysis and name the collection.'],
        ['2', 'Add recordings',
         'Drag video files in. Segments from one camera are chained in order.'],
        ['3', 'Set the start time',
         'Enter when each recording began. Gaps and overlaps appear on the '
         + 'timeline — overlapping ranges are shown in red.'],
        ['4', 'Run the analysis',
         'Detection, tracking and the vision-language model run on the '
         + 'server. Progress is shown while it works.'],
        ['5', 'Review events',
         'Open Analysis. Click an event to jump the player to that moment.'],
      ].map(([n, title, body]) => el('div.row', {
        style: { gap: '12px', alignItems: 'flex-start' },
      },
        el('span', {
          style: {
            width: '24px', height: '24px', borderRadius: '50%', flex: '0 0 auto',
            background: 'var(--bg-3)', display: 'grid', placeItems: 'center',
            fontSize: '12px', fontWeight: 700, color: 'var(--ac)',
          },
        }, n),
        el('div', {},
          el('div', { style: { fontWeight: 700, marginBottom: '2px' } }, title),
          el('div', { class: 'tiny muted' }, body)))),
      el('a', {
        href: '#', class: 'tiny',
        style: { color: 'var(--ac)' },
        onclick: (e) => { e.preventDefault(); toast('Guide not available yet', 'warn'); },
      }, 'Download Guide')));

  const health = el('div.panel', {},
    el('div.panel-h', {}, 'Server health'),
    el('div.panel-b', { id: 'homehealth' },
      el('div', { class: 'tiny muted' }, 'checking…')));

  const brand = el('div', {
    style: {
      display: 'grid', placeItems: 'center', gap: '10px', padding: '10px',
      textAlign: 'center',
    },
  },
    el('div', {
      style: {
        width: '180px', height: '150px', border: '2px solid var(--tx-2)',
        display: 'grid', placeItems: 'center', fontSize: '20px',
        fontWeight: 700, color: 'var(--tx-2)',
        background: 'repeating-linear-gradient(45deg,transparent 0 12px,'
                  + 'rgba(255,255,255,.03) 12px 24px)',
      },
    }, 'Logo'),
    el('div', { style: { fontSize: '19px', fontWeight: 700 } }, 'Help'),
    el('div', { class: 'mono', style: { fontSize: '17px' } }, '010-XXXX-XXXX'),
    el('div', { class: 'tiny muted' }, 'Made by Danusys'));

  mount(stage, el('div.row', {
    style: { gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' },
  },
    guide,
    el('div', { style: { display: 'grid', gap: '14px', width: '300px' } },
      health, brand)));

  async function tick() {
    const box = document.getElementById('homehealth');
    if (!box) return;
    let h;
    try { h = await api.health(); } catch { h = null; }
    const dot = (ok) => el('span', {
      style: {
        width: '10px', height: '10px', borderRadius: '50%', flex: '0 0 auto',
        background: ok ? '#22c55e' : '#ef4444',
      },
    });
    const line = (label, ok, note) => el('div.row', {
      style: { gap: '8px', padding: '3px 0' },
    }, dot(ok), el('span', {}, label),
      note ? el('span', { class: 'tiny muted' }, note) : null);

    if (!h) return mount(box, line('API server', false, 'unreachable'));
    const workers = (h.analysis && h.analysis.workers) || [];
    mount(box,
      line('API server', h.status === 'ok'),
      line('database', h.database && h.database.status === 'ok'),
      line('cache', h.cachedb && h.cachedb.status === 'ok'),
      ...workers.map((w) => line(w.worker_id,
        w.status !== 'unavailable', w.status)),
      line('LLM server', h.vllm && h.vllm.status === 'ok'));
  }
  /* 5 saniyeden 20'ye çıktı: sunucu sağlığı o hızla değişmiyor ve açık
     bırakılan sekme günde binlerce istek üretiyordu. */
  startPolling(tick, 20000);
}
