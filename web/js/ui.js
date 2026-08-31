/* ============================================================================
   ui.js — ekranlar arasi paylasilan kabuk
   ----------------------------------------------------------------------------
   Ust cubuk, sol agac, filtre paneli ve ekran omru (onLeave/runCleanup).
   Hicbir ekrani import etmez — gezinme location.hash uzerinden oldugu icin
   bagimlilik grafigi tek yonlu kalir: app.js -> screens/* -> ui.js -> core.js
   ========================================================================= */

import {
  FEATURES, el, clear, store, api, t, toast, modal
} from './core.js';

export const ROOT = () => document.getElementById('app');
let CLEANUP = [];
export function onLeave(fn) { CLEANUP.push(fn); }
export function runCleanup() { CLEANUP.forEach(f => { try { f(); } catch {} }); CLEANUP = []; }

const STATUS_LABEL = {
  registered: 'Registered', uploading: 'Uploading', ready: 'Ready',
  analyzing: 'Analyzing', completed: 'Completed', failed: 'Failed',
  deleted: 'Deleted',
};
export const statusLabel = s => STATUS_LABEL[s] || s;
const SRC_ICON = { file: '▤', rtsp: '⦿', uploaded: '↑', archive: '▣' };

/* ==========================================================================
   Kabuk
   ========================================================================== */

export function topbar(active) {
  /* Tek veri kaynağı var, tek sekme listesi var. Analysis ve Object ekranları
     bir video id'si ister; katalog boşsa (hiç video yüklenmemişse) adresi boş
     bırakıyoruz, yönlendirici Home'a düşürüyor. */
  const first = (store.get('groups').flatMap((g) => g.cameras || [])[0] || {}).id;
  const tabs = [
    ['home', 'Home', '#/home'],
    ['upload', 'Upload & Analysis', '#/upload'],
    ['single', 'Analysis', `#/single/${first || ''}`],
    ...(FEATURES.objects ? [['objects', 'Object', `#/objects/${first || ''}`]] : []),
    ['manage', 'Manage', '#/manage'],
    ['system', t('system'), '#/system'],
  ];
  return el('div.topbar',
    // Logo veya program adına tıklayınca ana sayfaya dönülür
    el('a.brand', {
      href: '#/home', style: { textDecoration: 'none', color: 'inherit' },
    }, el('span.logo', {}, '▣'), el('span', {}, 'Logo')),
    el('nav.navtabs', {}, tabs.map(([k, label, href]) =>
      el('a', { href, class: active === k ? 'on' : '' }, label))),
    el('div.grow'),
    el('div.row', { class: 'tiny muted' },
      el('span', { id: 'srvstat' }, '● Connected')),
    el('div.row', { style: { gap: '6px', marginLeft: '4px' } },
      el('span', { class: 'tiny' }, '👤'),
      el('span', { class: 'tiny' }, (store.get('user') || {}).username || 'admin'),
      el('button.btn.sm.ghost', {
        onclick: () => { localStorage.removeItem('tok'); location.hash = '#/login'; },
      }, t('logout'))));
}

/** modal() üzerine ince bir onay sarmalayıcı — true/false ile çözülür. */
export function confirmModal(title, text, okLabel = '계속') {
  return new Promise((resolve) => {
    let close = () => {};
    const answer = (v) => { close(); resolve(v); };
    close = modal({
      title,
      body: el('div', { style: { lineHeight: 1.7 } }, text),
      footer: [
        el('button.btn.ghost', { onclick: () => answer(false) }, '취소'),
        el('button.btn.pri', { onclick: () => answer(true) }, okLabel),
      ],
    });
  });
}

/* --------------------------------------------------------------- ağaç ---- */

export function treePanel(activeVideoId, onPick) {
  const body = el('div.panel-b');
  const p = el('div.panel', {},
    el('div.panel-h', {}, t('videoList')),
    el('div', { style: { padding: '8px 9px' } },
      el('div.search-wrap', {},
        el('input.input', {
          placeholder: 'Search groups', oninput: (e) => filter(e.target.value),
        }),
        el('span.ico', {}, '⌕'))),
    body);

  const open = JSON.parse(localStorage.getItem('treeopen') || '["G1"]');
  let groups = store.get('groups');

  function filter(q) { render(q.toLowerCase()); }

  function render(q = '') {
    clear(body);
    const tree = el('div.tree');
    for (const g of groups) {
      const cams = g.cameras.filter(c =>
        !q || c.name.toLowerCase().includes(q) ||
        (c.place_ko || '').includes(q) || g.name.toLowerCase().includes(q));
      if (q && !cams.length) continue;
      const isOpen = open.includes(g.id) || !!q;
      const gh = el('div.tree-group', { class: isOpen ? 'open' : '' },
        el('span.caret', {}, '▶'),
        el('span', {}, '📁'),
        el('span.grow', {}, g.name),
        el('span.gsub', {}, `${g.cameras.length}`));
      gh.onclick = () => {
        const i = open.indexOf(g.id);
        i >= 0 ? open.splice(i, 1) : open.push(g.id);
        localStorage.setItem('treeopen', JSON.stringify(open));
        render(q);
      };
      tree.append(gh);
      if (g.name_ko) {
        gh.title = `${g.name} · ${g.name_ko}\n${g.desc || ''}`;
      }
      if (!isOpen) continue;
      for (const c of cams) {
        const usable = c.status === 'completed';
        const row = el('div.tree-cam', {
          class: [activeVideoId === c.id ? 'on' : '', usable ? '' : 'disabled'].join(' '),
          title: `${c.name} · ${c.place_ko}\n${statusLabel(c.status)}`
            + (c.error ? '\n⚠ ' + c.error : '')
            + `\nsource: ${c.source_type}` + (c.has_proxy ? ' · proxy ✓' : ' · proxy ✗'),
        },
          el('span', { class: 'dot ' + c.status }),
          el('span.srcicon', {}, SRC_ICON[c.source_type] || '·'),
          el('span.nm', {}, c.name),
          c.real_data ? el('span.badge.real', { class: 'tiny' }, 'REAL') : null,
          el('span.pl', {}, c.place_ko || ''));
        row.onclick = () => {
          if (!usable) {
            toast(c.error ? c.error : `${c.name}: ${statusLabel(c.status)} — no analysis result yet.`,
              c.status === 'failed' ? 'err' : 'warn', 4200);
            return;
          }
          onPick(c);
        };
        tree.append(row);
        if (c.status === 'analyzing')
          tree.append(el('div.mini-prog', {},
            el('i', { style: { width: (c.progress || 0) + '%' } })));
      }
    }
    body.append(tree);
  }
  render();
  return p;
}

/* ------------------------------------------------------------ filtre ---- */

export function filterPanel(onApply) {
  const defs = store.get('attributes');
  const f = store.get('filters');
  const body = el('div.filter');

  const clsSeg = el('div.seg', {},
    [['', t('all')], ['person', t('person')], ['vehicle', t('vehicle')]]
      .map(([v, label]) => el('button', {
        class: f.cls === v ? 'on' : '',
        onclick: (e) => {
          f.cls = v;
          [...e.target.parentElement.children].forEach(b => b.classList.remove('on'));
          e.target.classList.add('on');
          renderDyn();
        },
      }, label)));

  const dyn = el('div.col', { style: { gap: '11px' } });

  function renderDyn() {
    clear(dyn);
    if (!defs) return;
    const which = f.cls === 'vehicle' ? 'vehicle' : 'person';
    for (const d of ((defs.attributes || {})[which] || [])) {
      if (which === 'person' && f.cls === '' &&
        ['upper_type', 'lower_color', 'hat'].includes(d.key)) continue;
      const g = el('div.fgroup', {},
        el('div.flabel', {}, d.label_ko));
      if (d.type === 'color') {
        const sel = f[d.key] || (f[d.key] = []);
        g.append(el('div.swatches', {},
          d.values.map(v => el('button.sw', {
            class: sel.includes(v.v) ? 'on' : '',
            style: { background: v.hex },
            title: v.ko,
            onclick: (e) => {
              const i = sel.indexOf(v.v);
              i >= 0 ? sel.splice(i, 1) : sel.push(v.v);
              e.target.classList.toggle('on');
            },
          })),
          el('button.sw.all', {
            onclick: () => { sel.length = 0; renderDyn(); },
          }, t('all'))));
      } else if (d.type === 'multi') {
        const sel = f[d.key] || (f[d.key] = []);
        g.append(el('div.chips', {}, d.values.map(v => el('button.chip', {
          class: sel.includes(v.v) ? 'on' : '',
          onclick: (e) => {
            const i = sel.indexOf(v.v);
            i >= 0 ? sel.splice(i, 1) : sel.push(v.v);
            e.target.classList.toggle('on');
          },
        }, v.ko))));
      } else {
        g.append(el('div.seg', {},
          [{ v: '', ko: t('all'), tr: t('all') }, ...d.values].map(v =>
            el('button', {
              class: (f[d.key] || '') === v.v ? 'on' : '',
              onclick: (e) => {
                f[d.key] = v.v;
                [...e.target.parentElement.children].forEach(b => b.classList.remove('on'));
                e.target.classList.add('on');
              },
            }, v.ko))));
      }
      dyn.append(g);
    }
  }

  body.append(
    el('div.fgroup', {}, el('div.flabel', {}, t('objectKind')), clsSeg),
    dyn,
    el('div.divider'),
    el('button.btn.pri.wide', { onclick: () => onApply(f) }, '▽ ' + t('apply')),
    el('button.btn.ghost.wide', {
      onclick: () => {
        store.set({ filters: { cls: '', gender: '', age: '', upper_color: [], carry: [] } });
        onApply(store.get('filters'));
        route();
      },
    }, t('reset')));
  renderDyn();

  return el('div.panel', {},
    el('div.panel-h', {}, t('objectFilter'),
      el('span.grow'),
      el('span', { class: 'tiny muted', title: 'Based on PAR model output' }, 'PAR')),
    el('div.panel-b', {}, body));
}


/**
 * Zaten analiz edilmiş videoyu yeniden analiz etmek isteyip istemediğini
 * sorar. Backend `succeeded` kaydını da çakışma sayıp 409 döndüğü için
 * önce kuyruk kaydını silmek gerekiyor — bu, sonuç dosyasını silmez ama
 * mevcut sonuçların yerini yenisi alır.
 */
export function askReanalyze(videoIds, names, body, watch) {
  let close = () => {};
  close = modal({
    title: 'Already analyzed',
    body: el('div', { style: { display: 'grid', gap: '8px' } },
      el('div', {}, `${names.length} video(s) already have an analysis job:`),
      el('div', { class: 'tiny muted' }, names.join(', ')),
      el('div', { class: 'tiny muted' },
        'Re-running removes the queue record and starts over. '
        + 'Existing results stay on disk until the new run overwrites them.')),
    footer: [
      el('button.btn.ghost', { onclick: () => close() }, 'Keep results'),
      el('button.btn', {
        onclick: async () => {
          close();
          let n = 0;
          for (const id of videoIds) {
            try {
              /* body'yi AYNEN geçiriyoruz: 재요약 kutusuna yazılan prompt
                 buradan devam etmezse yeniden analiz eski prompt'la koşar
                 ve sonuç birebir aynı çıkar — kullanıcı "hiçbir şey olmadı"
                 diye görür. */
              const r = await api.analyze(id, body || {}, { force: true });
              n++;
              if (watch) watch(r, id);
            } catch (e) {
              toast(`video ${id}: ${e.message}`, 'err', 6000);
            }
          }
          if (n && !watch) toast(`${n} job(s) re-queued`, 'ok');
        },
      }, 'Re-analyze'),
    ],
  });
}

export function findCam(id) {
  for (const g of store.get('groups'))
    for (const c of g.cameras) if (c.id === id) return { ...c, group_name: g.name };
  return null;
}
