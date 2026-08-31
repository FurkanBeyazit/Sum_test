/* ==========================================================================
   Ekran: 시스템 (GPU + 로그)
   ========================================================================== */

import { el, mount, api, clockOf } from '../core.js';
import { ROOT, onLeave, topbar } from '../ui.js';

export async function screenSystem() {
  const gpuBox = el('div', { style: { padding: '12px', display: 'grid', gap: '14px' } });
  const logBody = el('div.panel-b');
  mount(ROOT(), topbar('system'),
    el('div.main', {},
      el('div.stage', { style: { padding: '10px' } },
        el('div.panel', { style: { flex: '0 0 auto' } },
          el('div.panel-h', {}, 'GPU 및 시스템 상태', el('span.grow'),
            el('span', { class: 'tiny muted' }, '2초마다 갱신')),
          gpuBox),
        el('div.panel', {},
          el('div.panel-h', {}, '로그', el('span.grow'),
            el('div.seg', {}, ['', 'INFO', 'WARN', 'ERROR'].map(L =>
              el('button', {
                class: L === '' ? 'on' : '',
                onclick: (e) => {
                  [...e.target.parentElement.children].forEach(b => b.classList.remove('on'));
                  e.target.classList.add('on'); loadLogs(L);
                },
              }, L || 'ALL')))),
          logBody))));

  function gauge(label, val, max, unit, color) {
    const p = Math.min(100, val / max * 100);
    return el('div.gauge', {},
      el('div', { class: 'gtop' }, el('span', {}, label),
        el('b', {}, `${val}${unit}`,
          el('span', { class: 'muted', style: { fontWeight: 400 } }, ` / ${max}${unit}`))),
      el('div.gbar', {}, el('i', {
        style: {
          width: p + '%',
          background: p > 85 ? 'var(--crit)' : p > 65 ? 'var(--warn)' : (color || 'var(--ac)'),
        },
      })));
  }

  async function tick() {
    const g = await api.gpu();
    const d = g.devices[0];
    mount(gpuBox,
      el('div.row', {},
        el('span', { style: { fontWeight: 700 } }, d.name),
        el('span', { class: 'tiny muted mono' },
          `driver ${d.driver} · CUDA ${d.cuda}`),
        el('span.grow'),
        el('span', { class: 'tiny muted' },
          `queue: running ${g.queue.running} · queued ${g.queue.queued} · workers ${g.queue.workers}`)),
      el('div', {
        style: {
          display: 'grid', gap: '12px',
          gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))',
        },
      },
        gauge('GPU 사용률', d.utilization_pct, 100, '%'),
        gauge('VRAM', d.memory_used_mb, d.memory_total_mb, 'MB'),
        gauge('온도', d.temperature_c, 95, '°C'),
        gauge('전력', d.power_w, 250, 'W'),
        gauge('팬', d.fan_pct, 100, '%'),
        gauge('CPU', g.host.cpu_pct, 100, '%'),
        gauge('RAM', g.host.ram_used_gb, g.host.ram_total_gb, 'GB'),
        gauge('디스크', g.host.disk_used_tb, g.host.disk_total_tb, 'TB')));
  }
  await tick();
  const iv = setInterval(tick, 2000);
  onLeave(() => clearInterval(iv));

  async function loadLogs(level) {
    const r = await api.logs(level ? { level } : {});
    mount(logBody, r.items.map(l => el('div.logline', {},
      el('span', { class: 'ts' }, clockOf(l.ts)),
      el('span', { class: 'lv ' + l.level }, l.level),
      el('span', { class: 'cp' }, l.component),
      el('span', { style: { flex: 1, color: l.level === 'ERROR' ? '#fca5a5' : 'var(--tx-1)' } },
        l.message))));
  }
  loadLogs('');
}
