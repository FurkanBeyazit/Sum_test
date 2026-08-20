/* ============================================================================
   app.js — Yönlendirici ve ekranlar
   ========================================================================= */

import {
  FEATURES, API_MODE,
  el, $, mount, clear, store, api, t, loc, hms, ms, dur, bytes, pad,
  clockOf, dateOf, TimeMapper, toast, modal, listen, COLOR_HEX,
  trackColor, simClass, simColor, attrText,
} from './core.js';
import { VideoOverlay } from './overlay.js';
import { Timeline } from './timeline.js';

const ROOT = () => document.getElementById('app');
let CLEANUP = [];
function onLeave(fn) { CLEANUP.push(fn); }
function runCleanup() { CLEANUP.forEach(f => { try { f(); } catch {} }); CLEANUP = []; }

const STATUS_LABEL = {
  registered: 'Registered', uploading: 'Uploading', ready: 'Ready',
  analyzing: 'Analyzing', completed: 'Completed', failed: 'Failed',
  deleted: 'Deleted',
};
const statusLabel = s => STATUS_LABEL[s] || s;
const SRC_ICON = { file: '▤', rtsp: '⦿', uploaded: '↑', archive: '▣' };

/* ==========================================================================
   Kabuk
   ========================================================================== */

function topbar(active) {
  /* Canlı modda arayüz üç ekrana indirildi: Home → Upload & Analysis →
     Analysis. İş yönetimi ayrı bir sekme değil, Upload ekranının içinde
     canlı güncellenen bir şerit. Mock modunda eski ekranlar duruyor —
     bbox/Re-ID/aday skoru gibi henüz veri gelmeyen özellikleri orada
     göstermeye devam ediyoruz. */
  const first = (store.get('groups').flatMap((g) => g.cameras || [])[0] || {}).id;
  const tabs = API_MODE === 'live' ? [
    ['home', 'Home', '#/home'],
    ['upload', 'Upload & Analysis', '#/upload'],
    ['single', 'Analysis', `#/single/${first || ''}`],
  ] : [
    ['home', 'Home', '#/home'],
    ['single', t('single'), '#/single/CAM01'],
    ['multi', t('multi'), '#/multi/G1'],
    ...(FEATURES.reid ? [['objects', t('objects'), '#/objects/CAM01']] : []),
    ['upload', 'Upload & Analysis', '#/upload'],
    ['jobs', t('jobs'), '#/jobs'],
    ['system', t('system'), '#/system'],
    ['settings', t('settings'), '#/settings'],
    ['api', t('api'), '#/api'],
  ];
  return el('div.topbar',
    // Logo veya program adına tıklayınca ana sayfaya dönülür
    el('a.brand', {
      href: '#/home', style: { textDecoration: 'none', color: 'inherit' },
    }, el('span.logo', {}, '▣'), el('span', {}, 'Logo')),
    el('nav.navtabs', {}, tabs.map(([k, label, href]) =>
      el('a', { href, class: active === k ? 'on' : '' }, label)),
      API_MODE === 'live' ? null : el('a', {
        href: '/lab/', title: 'Hands-on lab',
        style: { borderLeft: '1px solid var(--line)', marginLeft: '4px' },
      }, '🧪 Lab')),
    el('div.grow'),
    // Veri kaynağı anahtarı — tıklayınca mock ↔ canlı API arasında geçer.
    // Hangi moddayız sorusu sürekli kafa karıştırdığı için hep görünür.
    el('div.seg', { style: { marginRight: '8px' } },
      [['mock', 'MOCK'], ['live', 'LIVE']].map(([m, label]) => el('button', {
        class: API_MODE === m ? 'on' : '',
        title: m === 'live'
          ? `Live API: ${'http://172.20.14.161:8001'}`
          : 'Yerel mock veri',
        onclick: () => {
          if (API_MODE === m) return;
          localStorage.setItem('ff.api', m);
          // id'ler iki mod arasında ortak değil — rotayı sıfırla
          location.hash = '#/';
          location.reload();
        },
      }, label))),
    el('div.row', { class: 'tiny muted' },
      el('span', { id: 'srvstat' }, '● Connected')),
    el('button.iconbtn', {
      title: 'Settings', onclick: () => location.hash = '#/settings',
    }, '⚙'),
    el('div.row', { style: { gap: '6px', marginLeft: '4px' } },
      el('span', { class: 'tiny' }, '👤'),
      el('span', { class: 'tiny' }, (store.get('user') || {}).username || 'admin'),
      el('button.btn.sm.ghost', {
        onclick: () => { localStorage.removeItem('tok'); location.hash = '#/login'; },
      }, t('logout'))));
}

/* --------------------------------------------------------------- ağaç ---- */

function treePanel(activeVideoId, onPick) {
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

function filterPanel(onApply) {
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

/* ==========================================================================
   Ekran: LOGIN
   ========================================================================== */

function screenLogin() {
  const u = el('input.input', { value: 'admin', autofocus: true });
  const p = el('input.input', { type: 'password', value: 'admin' });
  const err = el('div', { class: 'tiny', style: { color: 'var(--crit)', minHeight: '16px' } });
  const go = async () => {
    try {
      const r = await api.login(u.value, p.value);
      localStorage.setItem('tok', r.access_token);
      store.set({ user: r.user });
      location.hash = '#/single/CAM01';
    } catch (e) { err.textContent = e.data?.detail || e.message; }
  };
  const card = el('div.logincard', {},
    el('div.brand', { style: { fontSize: '16px' } },
      el('span.logo', {}, '▣'), el('span', {}, '지능형 영상 요약 플랫폼')),
    el('h1', {}, '로그인'),
    el('p', { class: 'sub' }, 'Intelligent Video Summary Platform · mock'),
    el('div.field', {}, el('label', {}, '아이디'), u),
    el('div.field', {}, el('label', {}, '비밀번호'), p),
    err,
    el('button.btn.pri.wide', { onclick: go, style: { marginTop: '8px' } }, '로그인'),
    el('div', {
      class: 'tiny muted',
      style: { marginTop: '16px', textAlign: 'center', lineHeight: 1.7 },
    }, '아무 값이나 입력해도 로그인됩니다 (mock).'));
  card.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  mount(ROOT(), el('div.loginpage', {}, card));
}

/* ==========================================================================
   Ekran: 단일 영상 요약
   ========================================================================== */

async function screenSingle(videoId) {
  const cam = findCam(videoId);
  if (!cam) { toast('Video not found: ' + videoId, 'err'); location.hash = '#/single/CAM01'; return; }

  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(videoId, c => location.hash = `#/single/${c.id}`),
    filterPanel(() => applyFilter()));

  mount(ROOT(), topbar('single'), el('div.main', {}, sidebar, stage, rightbar));

  // -------- veri ---------------------------------------------------------
  const [video, summary, evRes, objRes] = await Promise.all([
    api.video(videoId), api.summary(videoId),
    api.events(videoId, { limit: 400 }), api.objects(videoId, { limit: 400 }),
  ]);
  const events = evRes.items;
  const objects = objRes.items;
  const TM = new TimeMapper(video.start_time, summary.segments);
  store.set({ videoId, video, summary, events, objects, duration: video.duration });

  // -------- üst şerit ----------------------------------------------------
  const hdr = el('div.hdr', {},
    el('div.hdr-top', {},
      el('div.crumb', {},
        el('span.par', {}, cam.group_name || 'Area'),
        el('span.sep', {}, '›'),
        el('span.cur', {}, video.name),
        el('span', { class: 'badge ' + video.status }, statusLabel(video.status))),
      el('div.grow'),
      el('button.btn.ghost.sm', { onclick: () => showVideoInfo(video, summary) }, t('videoInfo')),
      el('button.btn.sm', { onclick: () => reSummarize(video) }, '⟲ ' + t('reSummarize'))),
    el('div.hdr-sub', {},
      el('span', {}, 'Time range'),
      el('b', { class: 'mono' },
        `${dateOf(video.start_time)} ${clockOf(video.start_time)} ~ ${clockOf(video.end_time)}`),
      el('span', { class: 'muted' }, '·'),
      /* Proxy'si olmayan ve backend'in codec/çözünürlük döndürmediği kayıtlar
         var (henüz ffprobe edilmemiş olabilir) — eksik alanları atlıyoruz,
         yoksa tüm ekran açılmıyor. */
      el('span', {}, [
        video.width && video.height ? `${video.width}×${video.height}` : null,
        video.fps ? `${video.fps}fps` : null,
        video.codec ? String(video.codec).toUpperCase() : null,
      ].filter(Boolean).join(' · ') || 'No resolution info'),
      el('span', { class: 'muted' }, '·'),
      el('span', { title: 'node_id / channel — VMS identifier' },
        `node ${video.node_id}/ch${video.ch}`)));

  // -------- video --------------------------------------------------------
  const vstack = el('div.vstack');
  const ovlCanvas = el('canvas', { class: 'ovl hit' });
  let videoEl = null, overlay = null;

  const vwell = el('div.vwell', {}, vstack);
  const hud = el('div.vhud', {},
    el('span.pill', {}, el('b', { id: 'hudclock' }, '--:--:--')),
    el('span.pill', { id: 'hudobj' }, 'obj 0'),
    el('span.pill', { id: 'hudsrc', title: 'Original / summary toggle' }, 'Original'));

  /* `playable`: proxy VAR ya da kaynak zaten tarayıcının açabildiği bir
     MP4/H.264 — o durumda backend stream'i doğrudan oynatılır. Mock verisinde
     alan yok, orada has_proxy'ye düşüyoruz. */
  const canPlay = video.playable ?? video.has_proxy;
  if (canPlay) {
    videoEl = el('video', {
      src: api.streamUrl(videoId),
      poster: api.posterUrl(videoId),
      preload: 'auto', playsinline: true,
    });
    vstack.append(videoEl, ovlCanvas);
  } else {
    vstack.append(el('div.noproxy', {},
      el('div', { class: 'big' }, '⛶'),
      el('div', { class: 't' }, 'No playable proxy for this video'),
      el('div', { class: 'tiny' },
        `This video (${video.duration >= 3600 ? dur(video.duration) : video.duration + 's'}) `
        + 'was analyzed, but no browser-playable H.264 proxy was generated.'),
      el('div', {
        class: 'tiny', style: {
          marginTop: '6px', color: 'var(--tx-3)', textAlign: 'left',
          lineHeight: 1.7,
        },
      },
        el('div', {}, `Source codec: ${(video.src_codec || '').toUpperCase()} `
          + '→ Chrome may not be able to play it'),
        el('div', {}, `faststart: ${video.faststart ? '✓' : '✗ (moov atom at end of file)'}`),
        /* gop_sec yalnızca proxy üretilmişse biliniyor; proxy yoksa null
           gelir ve "GOP: nulls" yazıyordu. */
        video.gop_sec != null
          ? el('div', {}, `GOP: ${video.gop_sec}s → seek accuracy ±${video.gop_sec}s`)
          : el('div', {}, 'GOP: unknown (no proxy)')),
      el('div', { class: 'tiny', style: { marginTop: '10px' } },
        'The timeline and event list still work.')));
  }
  vwell.append(hud);

  // kontroller
  const scrub = el('div.scrub', {},
    el('div.track', {}, el('div.buf'), el('div.fill')),
    el('div.knob'));
  const tcode = el('div.tcode', {}, el('b', {}, '00:00:00'), ' / ', hms(video.duration));
  const btnPlay = el('button.iconbtn', { title: 'Play / pause' }, '▶');
  const vctl = el('div.vctl', {},
    btnPlay,
    el('button.iconbtn', { title: 'Back 10s', onclick: () => seek(cur() - 10) }, '⟲'),
    el('button.iconbtn', { title: 'Forward 10s', onclick: () => seek(cur() + 10) }, '⟳'),
    el('button.iconbtn', { title: 'Previous event', onclick: () => jumpEvent(-1) }, '⏮'),
    el('button.iconbtn', { title: 'Next event', onclick: () => jumpEvent(1) }, '⏭'),
    tcode,
    scrub,
    el('select.select', {
      style: { width: '68px', padding: '4px 6px' },
      onchange: (e) => { if (videoEl) videoEl.playbackRate = +e.target.value; },
    }, [0.25, 0.5, 1, 2, 4].map(v =>
      el('option', { value: v, selected: v === 1 }, v + '×'))),
    /* Bindirme anahtarları detection verisine bağlı; gerçek API o veriyi
       vermediği için canlıda hepsi ölü düğmeydi (FEATURES.bbox). */
    FEATURES.bbox ? el('button.iconbtn', {
      title: 'BBox', class: 'on', id: 'btnbox',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.boxes = on; overlay.draw(cur()); }
      },
    }, '▭') : null,
    FEATURES.bbox ? el('button.iconbtn', {
      title: 'Tracks', class: 'on',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.trails = on; overlay.draw(cur()); }
      },
    }, '⌇') : null,
    FEATURES.bbox ? el('button.iconbtn', {
      title: 'Labels', class: 'on',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.labels = on; overlay.draw(cur()); }
      },
    }, 'A') : null,
    FEATURES.snapshot
      ? el('button.iconbtn', { title: 'Snapshot', onclick: snapshot }, '📷')
      : null,
    el('button.iconbtn', {
      title: 'Fullscreen',
      onclick: () => vwell.requestFullscreen?.(),
    }, '⛶'));

  const videobox = el('div.videobox', {}, vwell, canPlay ? vctl : null);

  // -------- aday구간 skorları (event_candidate_score) --------------------
  // Timeline'ın ısı haritası: kural tabanlı ihlal skoru.
  // "Bu aralık neden VLM'e gönderildi" sorusunun cevabı.
  let candHeat = null, candData = null;
  try {
    candData = await api.candidates(videoId, { from: 0, to: video.duration });
    candHeat = (candData.windows || []).map(w => ({
      t0: w.t_start, t1: w.t_end,
      score: w.integrated_score,
      candidate: w.is_candidate,
      metric: w.top_metric,
    }));
  } catch { /* aday verisi yoksa ısı haritası da olmaz */ }

  // -------- timeline -----------------------------------------------------
  const tlCanvas = el('canvas', { class: 'tlcanvas' });
  const tlPanel = el('div.panel.tlwrap', {},
    el('div.tlbar', {},
      el('span', { class: 'tiny', style: { fontWeight: 700, color: 'var(--tx-1)' } },
        'Event timeline'),
      el('span.grow'),
      el('span', { class: 'tiny muted' },
        'Wheel = zoom · Shift+drag = pan · Double-click = fit'),
      FEATURES.candidateScore ? el('button.btn.sm.ghost', {
        title: 'Why these ranges were sent to the VLM',
        onclick: () => showCandidates(candData, TM),
      }, '◍ Candidate score') : null,
      el('button.btn.sm.ghost', { title: 'Fit', onclick: () => { TL.fit(); } }, '⤢')),
    tlCanvas,
    FEATURES.candidateScore ? el('div.tlhint', {},
      'Blue band = rule-based candidate score. '
      + 'Only ranges above the threshold are analyzed by the VLM.') : null);

  // -------- özet bilgi ---------------------------------------------------
  const statbox = el('div.panel', {},
    el('div.panel-h', {}, t('summaryInfo'),
      el('span.grow'),
      el('span', { class: 'tiny muted' }, summary.engine_version || '')),
    el('div.statgrid', {},
      stat(t('videoLength'), hms(summary.duration)),
      /* Mock'ta burada "özet video süresi + sıkıştırma oranı" vardı, ama
         gerçek pipeline özet videosu üretmiyor — VLM yalnızca metin yazıyor.
         Yerine gerçekten bilgi veren şeyi koyuyoruz: videonun ne kadarına
         bakıldı. VLM sabit aralıkla örnekleme yaptığı için bu oran 1'in
         çok altında ve operatörün bilmesi gereken bir gerçek. */
      summary.sampling
        ? stat('Analyzed ranges',
          `${summary.segments.length} × ${summary.sampling.duration}s`,
          `coverage ${Math.round(
            (summary.segments.length * summary.sampling.duration)
            / (summary.duration || 1) * 100)}%`)
        : stat(t('summaryLength'), hms(summary.summary_duration),
          summary.ratio != null ? `(${summary.ratio}%)` : ''),
      stat(t('mainObject'), (summary.main_objects || [])
        .map(o => `${o.ko} ${o.count}`).join(', ') || '—'),
      stat(t('mainEvent'), String(summary.event_count)),
      stat(t('generatedAt'), clockOf(summary.generated_at),
        dateOf(summary.generated_at))),
    /* start_at girilmemişse olay saatleri hesaplanamaz — uydurmak yerine
       eksikliği söyleyip kullanıcıdan alıyoruz. PUT /video/{id} ile kaydedilir. */
    video.start_at_missing ? el('div.panel-b', {
      style: { borderTop: '1px solid var(--line)', display: 'grid', gap: '6px' },
    },
      el('div', { class: 'tiny', style: { color: '#fbbf24' } },
        '⚠ Recording start time is not set — events show elapsed time only.'),
      el('div.row', { style: { gap: '6px' } },
        el('input.input', {
          type: 'datetime-local', step: '1', id: 'startAtIn',
          style: { maxWidth: '230px' },
        }),
        el('button.btn.sm', {
          onclick: async () => {
            const v = document.getElementById('startAtIn').value;
            if (!v) return toast('Pick a date and time', 'warn');
            try {
              await api.updateVideo(videoId, { start_at: new Date(v).toISOString() });
              toast('Start time saved', 'ok');
              screenSingle(videoId);
            } catch (e) { toast('Failed: ' + e.message, 'err'); }
          },
        }, 'Save'))) : null);

  mount(stage, hdr, videobox, tlPanel, statbox);

  // -------- sağ panel: arama + olaylar -----------------------------------
  const promptInput = el('input.input', {
    placeholder: 'Search events',
    onkeydown: e => { if (e.key === 'Enter') doSearch(); },
  });
  const searchState = el('div.searchstate', { style: { display: 'none' } });
  const evBody = el('div.panel-b');
  const evPanel = el('div.panel', {},
    el('div.panel-h', {}, t('eventFlow'),
      el('span.grow'),
      el('span', { class: 'tiny muted', id: 'evcount' }, `${events.length}`)),
    /* Arama backend'de yok; istemci içi metin eşleşmesi VLM açıklamaları
       kısa olduğu için pratikte hiçbir şey bulmuyordu (FEATURES.eventSearch). */
    FEATURES.eventSearch ? el('div.promptbar', {},
      promptInput,
      el('button.btn.pri.sm', { onclick: () => doSearch() }, '⌕')) : null,
    searchState,
    evBody,
    el('div', { style: { padding: '8px', borderTop: '1px solid var(--line-soft)' } },
      el('button.btn.ghost.wide.sm', { onclick: () => showAllEvents(events, TM) },
        '☰ ' + t('allEvents'))));
  mount(rightbar, evPanel);

  // ======================= davranış =======================================
  let TL;
  const cur = () => videoEl ? videoEl.currentTime : store.get('playhead');

  function stat(k, v, sub) {
    return el('div.stat', {}, el('div', { class: 'k' }, k),
      el('div', { class: 'v' }, v, sub ? el('small', {}, ' ' + sub) : null));
  }

  /** event_status kontrolleri — şemadaki candidate/confirmed/dismissed akışı.
   *  VLM'in ürettiği her olay "candidate"; operatör onaylar ya da oto-tanı
   *  olarak eler. Raporlama yalnızca confirmed olayları alır. */
  function statusRow(e) {
    /* Onay akışı gerçek API'de kalıcı DEĞİL — `eventStatus` sonucu yalnızca
       bellekte duruyor, sayfa yenilenince kayboluyor. Kalıcı olmayan bir
       onay düğmesi göstermek yanıltıcı, o yüzden şimdilik kapalı. */
    if (!FEATURES.eventStatus) return null;
    const st = e.status || 'candidate';
    const LBL = {
      candidate: ['Candidate', 'var(--tx-2)'],
      confirmed: ['✓ Confirmed', 'var(--ok)'],
      dismissed: ['✕ False positive', 'var(--tx-3)'],
    };
    const badge = el('span.evtag', {
      style: { color: LBL[st][1], background: 'rgba(255,255,255,.05)' },
    }, LBL[st][0]);
    const set = async (next, ev) => {
      ev.stopPropagation();
      const upd = await api.eventStatus(e.id, next);
      e.status = upd.status;
      renderEvents(currentList, store.get('activeEventId'));
      toast(next === 'confirmed' ? 'Event confirmed' : 'Marked as false positive',
        next === 'confirmed' ? 'ok' : 'warn', 1800);
    };
    return el('div.evmeta', { style: { marginTop: '5px' } }, badge,
      st !== 'confirmed'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('confirmed', ev),
        }, 'Confirm') : null,
      st !== 'dismissed'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('dismissed', ev),
        }, 'Reject') : null,
      st !== 'candidate'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('candidate', ev),
        }, 'Undo') : null);
  }

  function renderEvents(list, active) {
    clear(evBody);
    const wrap = el('div.evlist');
    /* Boş liste iki farklı şey demek olabilir ve ikisini ayırmak şart:
       (a) VLM baktı, bir şey görmedi  (b) VLM videonun çoğuna hiç bakmadı.
       Sabit aralıklı örneklemede (b) çok yaygın — kapsama oranını söylemezsek
       operatör "videoda olay yok" sanır. */
    if (!list.length) {
      const s = summary.sampling;
      const cov = s
        ? Math.round((summary.segments.length * s.duration)
                     / (summary.duration || 1) * 100)
        : null;
      wrap.append(el('div.empty', {},
        el('span', { class: 'big' }, '⌕'),
        el('div', {}, 'No events'),
        s ? el('div', {
          class: 'tiny muted',
          style: { marginTop: '6px', lineHeight: 1.6, maxWidth: '260px' },
        },
          `The VLM looked at only ${summary.segments.length} range(s) of `
          + `${s.duration}s — ${cov}% of the video.`,
          el('br'),
          `The remaining ${100 - cov}% was never analyzed.`,
          el('br'),
          'To sample more densely, lower vlm_segment_interval_seconds '
          + `(currently ${s.interval}s).`) : null));
    }
    for (const e of list) {
      const item = el('div.evitem', {
        class: e.id === active ? 'on' : '',
        onclick: () => { selectEvent(e); },
        onmouseenter: () => { if (overlay) { overlay.filterTrackIds = e.track_ids?.length ? new Set(e.track_ids) : null; overlay.draw(cur()); } },
        onmouseleave: () => { if (overlay) { overlay.filterTrackIds = null; overlay.draw(cur()); } },
      },
        el('div.rail'),
        el('div.bullet', { style: { background: e.color, color: e.color } }),
        el('div.evbody', {},
          /* Birincil zaman = videodaki konum (oynatıcı ve eksenle aynı dil).
             Duvar saati kayboluyor değil: kayıt saati biliniyorsa hemen
             yanında soluk duruyor, "olay gerçekte saat kaçtaydı" hâlâ
             cevaplanabilsin diye. */
          el('div.evtime', {}, hms(e.t_start),
            el('span', { class: 'muted', style: { fontWeight: 400 } },
              ` +${ms(e.t_end - e.t_start)}`),
            video.start_time
              ? el('span', {
                class: 'muted', style: { fontWeight: 400, marginLeft: '6px' },
                title: 'Wall-clock time of this event',
              }, `· ${TM.wallClock(e.t_start)}`)
              : null),
          el('div.evdesc', {}, e.description),
          el('div.evmeta', {},
            el('span.evtag', { style: { color: e.color } },
              e.type_ko),
            el('span', { class: 'tiny muted mono' }, (e.score * 100).toFixed(0) + '%'),
            e.severity === 'critical'
              ? el('span.evtag', { style: { background: 'rgba(239,68,68,.2)', color: '#fca5a5' } }, '⚠')
              : null,
            e.event_group_code
              ? el('span.evtag', {
                style: { background: 'rgba(99,102,241,.18)', color: '#a5b4fc' },
                title: 'Same incident group: ' + (e.event_group_title || ''),
              }, '⛓ ' + e.event_group_code)
              : null,
            e.vlm_model ? el('span', { class: 'tiny', style: { color: 'var(--tx-3)' } },
              e.vlm_model) : null),
          // event_status — 후보 / 확정 / 오탐 제외
          statusRow(e)),
        e.thumbnail
          ? el('img.evthumb', { src: e.thumbnail, loading: 'lazy', onerror: (ev) => ev.target.remove() })
          : null);
      if (e.status === 'dismissed') item.style.opacity = '.42';
      wrap.append(item);
    }
    evBody.append(wrap);
  }

  function selectEvent(e) {
    store.set({ activeEventId: e.id });
    TL.activeEventId = e.id; TL.draw();
    renderEvents(currentList, e.id);
    seek(e.t_start + .05);
    if (overlay && e.track_ids?.length) {
      overlay.highlightTrackId = e.track_ids[0];
      overlay.draw(e.t_start);
    }
  }

  let currentList = events;

  function jumpEvent(dir) {
    const c = cur();
    const sorted = [...currentList].sort((a, b) => a.t_start - b.t_start);
    const next = dir > 0
      ? sorted.find(e => e.t_start > c + .3)
      : [...sorted].reverse().find(e => e.t_start < c - .3);
    if (next) selectEvent(next);
    else toast(dir > 0 ? 'Last event' : 'First event', 'info', 1600);
  }

  function seek(tSec) {
    const tt = Math.max(0, Math.min(video.duration - .05, tSec));
    if (videoEl) videoEl.currentTime = tt;
    store.set({ playhead: tt });
    if (overlay) overlay.seek(tt);
    TL.playhead = tt; TL.draw();
    syncTime(tt);
  }

  /* Oynatıcı GEÇEN SÜREYİ gösterir (00:00 → süre), duvar saatini değil.
     Bir oynatıcı kaydın 13:54'te çekilmiş olmasından bağımsız olarak sıfırdan
     sayar. Duvar saati bilgisi kaybolmuyor: başlıktaki "Time range" satırında
     ve olay özetlerinde duruyor. */
  function syncTime(tt) {
    tcode.firstChild.textContent = hms(tt);
    const f = tt / video.duration;
    scrub.querySelector('.fill').style.width = (f * 100) + '%';
    scrub.querySelector('.knob').style.left = (f * 100) + '%';
    const hc = document.getElementById('hudclock');
    if (hc) hc.textContent = hms(tt);
    const ho = document.getElementById('hudobj');
    if (ho && overlay) ho.textContent = 'obj ' + overlay.boxesAt(tt).length;
  }

  function snapshot() {
    if (!videoEl) return;
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth; c.height = videoEl.videoHeight;
    const cx = c.getContext('2d');
    cx.drawImage(videoEl, 0, 0);
    if (overlay && overlay.opts.boxes) {
      // overlay'i tam çözünürlükte yeniden çiz (burn-in export mantığı)
      const g = { ox: 0, oy: 0, dw: c.width, dh: c.height };
      for (const r of overlay.boxesAt(cur())) {
        const [, tid, , , x1, y1, x2, y2] = r;
        cx.strokeStyle = trackColor(tid); cx.lineWidth = 2;
        cx.strokeRect(x1 * g.dw, y1 * g.dh, (x2 - x1) * g.dw, (y2 - y1) * g.dh);
      }
    }
    c.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${videoId}_${hms(cur()).replace(/:/g, '')}.png`;
      a.click();
      toast('Snapshot saved (with bounding boxes)', 'ok');
    });
  }

  // ---- timeline kurulumu -------------------------------------------------
  TL = new Timeline(tlCanvas, {
    mode: 'single',
    onSeek: (tt) => seek(tt),
    onPickEvent: (e) => selectEvent(e),
  });
  onLeave(() => TL.destroy());
  TL.setData({
    lanes: [{ id: videoId, label: video.name, events }],
    /* startIso VERİLMİYOR: tek video ekseninde eksen 00:00'dan başlar.
       (Çoklu kamera ekranında duvar saati şart — kameraları hizalamanın
       başka yolu yok — orada startIso hâlâ geçiliyor.) */
    total: video.duration, startIso: null,
    heat: candHeat, heatThreshold: candData ? candData.threshold : null,
  });

  // ---- overlay -----------------------------------------------------------
  if (canPlay) {
    overlay = new VideoOverlay(ovlCanvas, videoEl);
    onLeave(() => overlay.destroy());
    overlay.setTrackMeta(objects);
    overlay.onPick = (tid) => {
      const o = objects.find(x => x.track_id === tid);
      if (o) showObject(o, videoId);
    };
    overlay.onHover = (tid) => {
      store.set({ hoverTrackId: tid });
    };
    const det = await api.detections(videoId, { from: 0, to: video.duration });
    overlay.setDetections(det, { w: video.width, h: video.height });
    overlay.start();
    document.getElementById('hudobj').textContent = 'obj 0';

    videoEl.addEventListener('loadedmetadata', () => { overlay.resize(); syncTime(0); });
    videoEl.addEventListener('timeupdate', () => {
      store.set({ playhead: videoEl.currentTime });
      TL.playhead = videoEl.currentTime;
      TL.draw();
      syncTime(videoEl.currentTime);
    });
    videoEl.addEventListener('progress', () => {
      if (videoEl.buffered.length) {
        const e = videoEl.buffered.end(videoEl.buffered.length - 1);
        scrub.querySelector('.buf').style.width = (e / video.duration * 100) + '%';
      }
    });
    videoEl.addEventListener('play', () => btnPlay.textContent = '❚❚');
    videoEl.addEventListener('pause', () => btnPlay.textContent = '▶');
    btnPlay.onclick = () => videoEl.paused ? videoEl.play() : videoEl.pause();

    // olay işaretleri
    for (const e of events) {
      scrub.append(el('div.evmark', {
        style: { left: (e.t_start / video.duration * 100) + '%', background: e.color },
        title: `${hms(e.t_start)} ${e.description}`,
      }));
    }
    scrub.onclick = (ev) => {
      const r = scrub.getBoundingClientRect();
      seek((ev.clientX - r.left) / r.width * video.duration);
    };
    // klavye
    const keys = (ev) => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
      if (ev.key === ' ') { ev.preventDefault(); btnPlay.onclick(); }
      if (ev.key === 'ArrowLeft') seek(cur() - (ev.shiftKey ? 1 : 5));
      if (ev.key === 'ArrowRight') seek(cur() + (ev.shiftKey ? 1 : 5));
      if (ev.key === 'b') document.getElementById('btnbox').click();
      if (ev.key === 'n') jumpEvent(1);
      if (ev.key === 'p') jumpEvent(-1);
    };
    document.addEventListener('keydown', keys);
    onLeave(() => document.removeEventListener('keydown', keys));
  }

  renderEvents(events, null);
  syncTime(0);

  // ---- filtre ------------------------------------------------------------
  async function applyFilter() {
    const f = store.get('filters');
    const r = await api.objects(videoId, {
      cls: f.cls, gender: f.gender, age: f.age,
      upper_color: f.upper_color, carry: f.carry,
    });
    const ids = new Set(r.items.map(o => o.track_id));
    if (overlay) {
      overlay.filterTrackIds = (f.cls || f.gender || f.age ||
        f.upper_color?.length || f.carry?.length) ? ids : null;
      overlay.draw(cur());
    }
    const filtered = ids.size
      ? events.filter(e => !e.track_ids?.length || e.track_ids.some(x => ids.has(x)))
      : events;
    currentList = filtered;
    renderEvents(filtered, store.get('activeEventId'));
    document.getElementById('evcount').textContent = `${filtered.length}`;
    TL.setData({ lanes: [{ id: videoId, label: video.name, events: filtered }],
                 heat: candHeat });
    toast(`Filter applied: ${r.total} objects · ${filtered.length} events`, 'ok');
  }

  // ---- 이벤트 검색: VLM açıklamalarında metin filtresi --------------------
  // Boru hattı: kural tabanlı aday seçimi → VLM açıklaması → burada o
  // açıklamalarda arama. Görsel arama yok; VLM bahsetmediyse bulunamaz.
  async function doSearch() {
    const query = promptInput.value.trim();
    if (!query) {
      currentList = events;
      searchState.style.display = 'none';
      renderEvents(events, null);
      TL.setData({ lanes: [{ id: videoId, label: video.name, events }], heat: candHeat });
      document.getElementById('evcount').textContent = `${events.length}`;
      return;
    }
    searchState.style.display = '';
    mount(searchState, el('div', { class: 'tiny muted' },
      el('span.spinner'), ' Searching…'));

    let r;
    try {
      r = await api.search({ video_ids: [videoId], query, limit: 60 });
    } catch (e) { toast('Search failed: ' + e.message, 'err'); return; }

    mount(searchState,
      el('div.row', { style: { gap: '6px' } },
        el('span.pstep.done', {}, 'Event search'),
        el('span', { class: 'tiny muted' },
          `${r.events_scanned} scanned · ${r.latency_ms}ms · ${r.total} matched`)),
      el('div.wordchips', {},
        r.expanded_terms.slice(0, 12).map(w => el('span.wordchip', {}, w))),
      el('div', { class: 'tiny', style: { color: 'var(--tx-3)' } },
        'Searches the VLM description text'));

    currentList = r.items;
    renderEvents(r.items, null);
    document.getElementById('evcount').textContent =
      `${r.total} / ${events.length}`;
    TL.setData({
      lanes: [{ id: videoId, label: video.name, events: r.items }],
      heat: candHeat,
    });
    if (!r.total) toast(`No match for "${query}" — the VLM may not have mentioned it`, 'warn', 4200);
  }

  async function reSummarize(v) {
    const promptBox = el('textarea.textarea', {
      placeholder: 'Analysis prompt (optional) — blank means a general summary',
    });
    const ratio = el('input.input', { type: 'number', value: 3, min: 1, max: 30 });
    const s = summary.sampling;
    const cov = s
      ? Math.round((summary.segments.length * s.duration)
                   / (summary.duration || 1) * 100)
      : null;
    const close = modal({
      title: 'Re-analyze — ' + v.name,
      body: el('div.col', { style: { gap: '12px' } },
        el('div', { class: 'tiny muted' },
          'Re-analysis runs on the GPU. Existing results are kept until it finishes.'),
        el('div.field', {}, el('label', {}, 'Analysis prompt'), promptBox),
        /* target_ratio LIVE modda hiçbir yere gitmiyor — live.js analyze()
           yalnızca prompt ve model'i settings'e koyuyor. Mock'ta anlamlı
           olduğu için duruyor, ama gerçek modda olduğu gibi işaretliyoruz. */
        API_MODE === 'live' ? null
          : el('div.field', {}, el('label', {}, 'Target summary ratio (%)'), ratio),
        /* Asıl kaldıraç bu: prompt'u değiştirmek örnekleme aralığını
           değiştirmez. Video büyük ölçüde hiç bakılmadan kalıyorsa yeni
           prompt da aynı "특이사항 없음"u üretir — bunu peşinen söylüyoruz. */
        cov ? el('div', { class: 'tiny', style: { color: '#fbbf24' } },
          `Current VLM coverage is ${cov}% — the answer is based on that `
          + 'much of the video only. Changing the prompt does not make the '
          + 'remaining ranges get analyzed.') : null,
        el('div', { class: 'codeblock' },
          API_MODE === 'live'
            ? `POST /analysis\n{ "video_id": ${v.id}, "settings": { "prompt": "..." } }`
            : `POST /api/videos/${v.id}/analyses\n`
              + `{ "prompt": "...", "options": { "target_ratio": 3 } }\n`
              + `→ 202 { "job_id": "job-xxxxx" }`)),
      footer: [
        el('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
        el('button.btn.pri', {
          onclick: async () => {
            const body = {
              prompt: promptBox.value,
              options: { target_ratio: +ratio.value }, _sim_sec: 16,
            };
            try {
              const r = await api.analyze(v.id, body);
              close();
              watchJob(r.job_id || `Q${v.id}`, v.name, v.id);
            } catch (e) {
              close();
              // Analiz edilmiş video için backend 409 döner — silip yeniden
              // başlatmayı kullanıcıya sor. prompt'u ve iş izlemeyi taşıyoruz.
              if (e.status === 409) {
                askReanalyze([v.id], [v.name], body,
                  (r, id) => watchJob(r.job_id || `Q${id}`, v.name, id));
              }
              else toast('Failed: ' + e.message, 'err', 6000);
            }
          },
        }, 'Start'),
      ],
    });
  }
}

/* ---------------------------------------------------------- iş izleme ---- */

/**
 * `videoId` verilirse iş bitince sonuç önbelleği atılır ve ekran kendiliğinden
 * yeniden çizilir. Eskiden kullanıcıya "F5'e bas" deniyordu; yeniden özetleme
 * bittiği hâlde ekranda eski metin durduğu için "hiçbir şey olmadı" görünüyordu.
 */
function watchJob(jobId, label, videoId) {
  const refresh = () => {
    if (videoId == null) return;
    api.invalidate(videoId);
    route();
  };
  const bar = el('div.progline', {}, el('i', { style: { width: '0%' } }));
  const txt = el('div', { class: 'tiny muted' }, 'Queued…');
  const host = el('div.toast', { class: 'ok', style: { minWidth: '300px' } },
    el('div', { style: { flex: 1 } },
      el('div', { style: { fontWeight: 700, marginBottom: '5px' } },
        '⟲ Re-analyzing ' + label),
      bar, txt),
    el('button.btn.sm.ghost', {
      onclick: async () => { await api.jobCancel(jobId); host.remove(); toast('Job canceled', 'warn'); },
    }, 'Stop'));
  let h = document.getElementById('toasts');
  if (!h) { h = el('div#toasts'); document.body.append(h); }
  h.append(host);

  const done = (msg, kind) => {
    txt.textContent = msg;
    setTimeout(() => { host.remove(); toast(`${label} · ${msg}`, kind); }, 900);
  };

  const url = api.jobStreamUrl(jobId);
  if (url) {
    const stop = listen(url, (m) => {
      bar.firstChild.style.width = (m.progress || 0) + '%';
      txt.textContent = `${m.stage_label || m.stage} · ${(m.progress || 0).toFixed(0)}%`
        + (m.eta_sec ? ` · ${Math.round(m.eta_sec)}s left` : '');
      if (m.status === 'completed') { stop(); done('Re-analysis complete', 'ok'); refresh(); }
      if (m.status === 'canceled') { stop(); host.remove(); }
    }, 'progress');
    return;
  }

  /* SSE yoksa (gerçek backend) kuyruğu yokla. İlerleme yüzdesi API'de
     olmadığı için çubuk belirsiz: çalışırken sağa sola süzülür, yüzde
     iddiasında bulunmaz. */
  bar.firstChild.classList.add('indet');
  let alive = true;
  onLeave(() => { alive = false; });

  (async function poll() {
    while (alive && document.body.contains(host)) {
      await new Promise((r) => setTimeout(r, 2500));
      if (!alive) return;
      let j;
      try { j = await api.job(jobId); } catch { continue; }
      const st = (j.status || '').toLowerCase();
      if (st === 'running') {
        txt.textContent = `${j.worker_id || 'worker'} · analyzing (no progress reported)`;
      } else if (st === 'queued') {
        txt.textContent = 'Queued…';
      } else if (st === 'succeeded') {
        bar.firstChild.classList.remove('indet');
        bar.firstChild.style.width = '100%';
        done('Re-analysis complete', 'ok');
        refresh();
        return;
      } else if (st === 'failed') {
        return done('Analysis failed: ' + (j.last_error || ''), 'err');
      } else if (st === 'cancelled' || st === 'canceled') {
        host.remove(); return;
      }
    }
  }());
}

/* ------------------------------------------------------------- modaller -- */

function showVideoInfo(v, s) {
  const rows = [
    ['video_id', v.id], ['name', `${v.name} · ${v.place_ko}`],
    ['group', v.group_name], ['status', v.status],
    ['source_type', v.source_type],
    ['node_id / ch', `${v.node_id} / ${v.ch}`],
    ['start_time', v.start_time], ['end_time', v.end_time],
    ['duration', `${v.duration}s (${hms(v.duration)})`],
    ['resolution', `${v.width} × ${v.height}`], ['fps', v.fps],
    ['codec (proxy)', v.codec], ['codec (source)', v.src_codec],
    ['bitrate', v.bitrate_kbps + ' kbps'], ['file_size', bytes(v.file_size_mb)],
    ['GOP', v.gop_sec + 's'], ['faststart', v.faststart ? '✓' : '✗'],
    ['proxy playback', v.has_proxy ? '✓ available' : '✗ none'],
  ];
  if (v.rtsp_url) rows.push(['rtsp_url', v.rtsp_url]);
  if (v.error) rows.push(['error', v.error]);
  const models = s?.models || {};
  modal({
    title: 'Video info · ' + v.name,
    body: el('div', {},
      el('dl.kv', {}, rows.flatMap(([k, val]) =>
        [el('dt', {}, k), el('dd', {}, String(val))])),
      Object.keys(models).length ? el('div', {},
        el('div.divider'),
        el('div', { class: 'flabel', style: { marginBottom: '6px' } }, 'Models used'),
        el('dl.kv', {}, Object.entries(models).flatMap(([k, val]) =>
          [el('dt', {}, k), el('dd', {}, val)]))) : null,
      el('div.divider'),
      el('div', { class: 'tiny muted' },
        'Playback note: if the source is HEVC, Chrome may not play it. '
        + 'Without faststart the browser must download the whole file '
        + 'before playback starts.')),
  });
}

/** event_candidate_score görselleştirmesi — "bu aralık neden seçildi".
 *  Şemada `details jsonb` alanı var; motor buraya metrik ayrıntısını yazar. */
function showCandidates(cd, TM) {
  if (!cd || !cd.windows?.length) {
    modal({ title: 'Candidate range scores',
      body: el('div.empty', {}, 'No candidate score data for this video.') });
    return;
  }
  const M = cd.metrics || {};
  const codes = Object.keys(M);
  const rows = cd.windows.map(w => {
    const by = Object.fromEntries(w.scores.map(x => [x.metric_code, x]));
    return el('tr', {
      style: w.is_candidate ? { background: 'rgba(56,189,248,.07)' } : {},
    },
      el('td', { class: 'mono' }, TM ? TM.wallClock(w.t_start) : w.t_start + 's'),
      el('td', { class: 'mono', style: { fontWeight: 700,
        color: w.is_candidate ? 'var(--ac)' : 'var(--tx-2)' } },
        w.integrated_score.toFixed(3)),
      el('td', {}, w.is_candidate
        ? el('span.evtag', { style: { color: 'var(--ac)' } }, 'Candidate ✓')
        : el('span', { class: 'tiny muted' }, '—')),
      ...codes.map(c => {
        const sc = by[c];
        if (!sc) return el('td', {}, '—');
        return el('td', {
          class: 'mono', title: `${M[c].ko} — threshold ${sc.threshold}`,
          style: {
            color: sc.exceeded ? 'var(--warn)' : 'var(--tx-3)',
            fontWeight: sc.exceeded ? 700 : 400,
          },
        }, sc.score.toFixed(2));
      }));
  });
  modal({
    title: `Why these ranges were selected — ${cd.selected}/${cd.count} accepted`,
    wide: true,
    body: el('div', {},
      el('div', { class: 'tiny muted', style: { marginBottom: '10px', lineHeight: 1.7 } },
        `Window ${cd.window_sec}s · combined threshold ${cd.threshold} · `,
        'when the weighted sum of the rule-based metrics exceeds the '
        + 'threshold, that range is sent to the VLM. '
        + '(DB: event_candidate_score)'),
      el('div', { style: { maxHeight: '54vh', overflow: 'auto' } },
        el('table.tbl', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Time'), el('th', {}, 'Score'), el('th', {}, 'Verdict'),
            ...codes.map(c => el('th', { title: M[c].desc }, M[c].ko)))),
          el('tbody', {}, rows))),
      el('div.divider'),
      el('div', { class: 'tiny muted' },
        'Metrics: ',
        codes.map(c => `${M[c].ko} (weight ${M[c].w})`).join(' · '))),
  });
}

function showAllEvents(events, TM) {
  const body = el('div', {}, el('table.tbl', {},
    el('thead', {}, el('tr', {},
      ['Position', 'Wall clock', 'Length', 'Type', 'Description', 'Score', 'VLM']
        .map(h => el('th', {}, h)))),
    el('tbody', {}, events.map(e => el('tr', {},
      el('td', { class: 'mono' }, hms(e.t_start)),
      // kayıt saati bilinmiyorsa wallClock() geçen süreye düşüyor — o zaman
      // sütunu tekrarlamak yerine boş bırakıyoruz
      el('td', { class: 'mono muted' },
        e.wall_start ? TM.wallClock(e.t_start) : '—'),
      el('td', { class: 'mono' }, ms(e.t_end - e.t_start)),
      el('td', {}, el('span.evtag', { style: { color: e.color } }, e.type_ko)),
      el('td', {}, e.description),
      el('td', { class: 'mono' }, (e.score * 100).toFixed(0) + '%'),
      el('td', { class: 'tiny muted' }, `${e.vlm_model || ''} ${e.vlm_latency_ms || ''}ms`))))));
  modal({ title: `All events (${events.length})`, body, wide: true });
}

function showObject(o, videoId) {
  const defs = store.get('attributes');
  modal({
    title: 'Object info · ' + (o.label || o.id),
    body: el('div.row', { style: { alignItems: 'flex-start', gap: '16px' } },
      el('img', {
        src: o.crop, style: {
          width: '124px', borderRadius: '7px',
          boxShadow: '0 0 0 1px var(--line)',
        },
        onerror: (e) => { e.target.style.display = 'none'; },
      }),
      el('div', { style: { flex: 1 } },
        el('dl.kv', {},
          [['object_id', o.id], ['track_id', o.track_id], ['class', o.cls],
          ['camera', `${o.camera} · ${o.camera_place || ''}`],
          ['wall_time', o.wall_time],
          ['range', `${o.t_first}s – ${o.t_last}s`],
          ['conf', o.conf], ['node/ch', `${o.node_id}/${o.ch}`],
          ['attributes', attrText(o.attrs, defs?.attributes, o.cls) || '—']]
            .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),
        el('div.divider'),
        el('div.row', {},
          FEATURES.reid ? el('button.btn.sm', {
            onclick: () => { location.hash = `#/objects/${videoId}?q=${o.id}`; },
          }, '🔍 Track this person (Re-ID)') : el('span', { class: 'tiny muted' },
            'Re-ID not implemented yet'),
          el('button.btn.sm.ghost', {
            onclick: () => { location.hash = `#/single/${o.video_id}`; },
          }, '▶ Play first appearance')))),
  });
}

/* ==========================================================================
   Ekran: 복합 상황 요약 (çoklu kamera)
   ========================================================================== */

async function screenMulti(groupId) {
  const g = store.get('groups').find(x => x.id === groupId) || store.get('groups')[0];
  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(null, c => location.hash = `#/single/${c.id}`));
  mount(ROOT(), topbar('multi'), el('div.main', {}, sidebar, stage, rightbar));

  const cams = g.cameras.filter(c => c.status === 'completed');
  const packs = await Promise.all(cams.map(async c => ({
    cam: c,
    video: await api.video(c.id),
    events: (await api.events(c.id, { limit: 500 })).items,
  })));

  // ortak zaman ekseni: en erken başlangıç
  const starts = packs.map(p => Date.parse(p.video.start_time)).filter(Boolean);
  const base = Math.min(...starts);
  const ends = packs.map(p => Date.parse(p.video.start_time) + p.video.duration * 1000);
  const total = (Math.max(...ends) - base) / 1000;
  const baseIso = new Date(base).toISOString().replace('Z', '+09:00');

  const lanes = packs.map((p, i) => {
    const off = (Date.parse(p.video.start_time) - base) / 1000;
    return {
      id: p.cam.id,
      label: p.cam.name,
      sub: p.cam.place_ko,
      color: ['#38bdf8', '#f472b6', '#4ade80', '#fbbf24', '#a78bfa'][i % 5],
      events: p.events.map(e => ({ ...e, t_start: e.t_start + off, t_end: e.t_end + off })),
      _off: off,
    };
  });

  const hdr = el('div.hdr', {},
    el('div.hdr-top', {},
      el('div.crumb', {},
        el('span.par', {}, g.name),
        el('span.sep', {}, '›'),
        el('span.cur', {}, t('multi')),
        el('span.badge.completed', {}, '요약 완료')),
      el('div.grow'),
      el('button.btn.ghost.sm', {
        onclick: () => modal({
          title: '그룹 정보', body: el('dl.kv', {},
            [['group_id', g.id], ['name', `${g.name} · ${g.name_ko || ''}`],
            ['설명', g.desc || '—'], ['카메라', g.cameras.length],
            ['분석 완료', cams.length],
            ['공통 시간축', `${new Date(base).toLocaleString()} ~ +${dur(total)}`]]
              .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),
        }),
      }, '그룹 정보'),
      el('button.btn.sm', { onclick: () => toast('그룹 재요약은 모든 카메라를 큐에 넣습니다.', 'info') },
        '⟲ ' + t('reSummarize'))),
    el('div.hdr-sub', {},
      el('span', {}, 'Time range'),
      el('b', { class: 'mono' },
        `${new Date(base).toISOString().slice(0, 19).replace('T', ' ')} `
        + `~ +${dur(total)}`),
      el('span', { class: 'muted' }, '·'),
      el('span', {}, `카메라 ${cams.length}대 · 이벤트 ${lanes.reduce((a, l) => a + l.events.length, 0)}건`)));

  const tlCanvas = el('canvas', { class: 'tlcanvas' });
  const tlPanel = el('div.panel', { style: { flex: '0 0 auto' } },
    el('div.tlbar', {},
      el('span', { class: 'tiny', style: { fontWeight: 700, color: 'var(--tx-1)' } },
        '그룹 전체 이벤트 타임라인 (호름도)'),
      el('span.grow'),
      el('span', { class: 'tiny muted' }, '휠=확대 · Shift+드래그=이동'),
      el('button.btn.sm.ghost', { onclick: () => TL.fit() }, '⤢')),
    tlCanvas,
    el('div.tlhint', {},
      '점선 = 동일 인물이 카메라 간 이동 (Re-ID 추적 대상 목록 기준) · '
      + '블록 클릭 = 이벤트 상세'));

  // olay akış listesi (kronolojik, tüm kameralar)
  const allEvents = lanes.flatMap(l =>
    l.events.map(e => ({ ...e, _lane: l }))).sort((a, b) => a.t_start - b.t_start);

  const flowBody = el('div.panel-b');
  const flowPanel = el('div.panel', {},
    el('div.panel-h', {}, '시간순 이벤트 흐름',
      el('span.grow'),
      el('span', { class: 'tiny muted' }, `${allEvents.length}건`)),
    el('div', { style: { padding: '8px 9px' } },
      el('div.search-wrap', {},
        el('input.input', {
          placeholder: '이벤트 검색',
          oninput: e => renderFlow(e.target.value.toLowerCase()),
        }), el('span.ico', {}, '⌕'))),
    flowBody);

  const detailBody = el('div.panel-b', {},
    el('div.empty', {}, el('span', { class: 'big' }, '☰'),
      '타임라인 또는 목록에서 이벤트를 선택하세요'));
  const detailPanel = el('div.panel', { style: { flex: '0 0 46%' } },
    el('div.panel-h', {}, '선택된 이벤트', el('span.grow'),
      el('span', { class: 'tiny muted', id: 'selcam' }, '—')),
    detailBody);

  mount(stage, hdr, tlPanel, flowPanel);
  mount(rightbar, detailPanel, trackPanel());

  let TL = new Timeline(tlCanvas, {
    mode: 'multi',
    onSeek: () => {},
    onPickEvent: (e) => selectEv(e),
  });
  onLeave(() => TL.destroy());

  const tl = store.get('tracklist');
  const trackMarks = (tl.members || []).map(m => {
    const lane = lanes.find(l => l.id === m.video_id);
    if (!lane) return null;
    return {
      laneId: m.video_id, color: '#f472b6',
      t0: (m.t_first || 0) + lane._off, t1: (m.t_last || 0) + lane._off,
    };
  }).filter(Boolean);

  TL.setData({ lanes, total, startIso: baseIso, tracks: trackMarks });

  function selectEv(e) {
    TL.activeEventId = e.id; TL.draw();
    const lane = lanes.find(l => l.events.some(x => x.id === e.id)) || e._lane;
    document.getElementById('selcam').textContent =
      lane ? `${lane.label} (${lane.sub})` : '';
    mount(detailBody,
      el('div', { style: { padding: '11px' } },
        e.thumbnail ? el('img', {
          src: e.thumbnail, style: {
            width: '100%', borderRadius: '7px', marginBottom: '10px',
          }, onerror: (ev) => ev.target.remove(),
        }) : null,
        el('div.row', {},
          el('span.evtag', { style: { color: e.color, fontSize: '11px' } }, e.type_ko),
          el('span', { class: 'mono tiny' },
            new Date(base + e.t_start * 1000).toISOString().slice(11, 19)),
          el('span.grow'),
          el('span', { class: 'mono tiny' }, (e.score * 100).toFixed(0) + '%')),
        el('div', { style: { margin: '9px 0', lineHeight: 1.65 } }, e.description),
        e.description_en ? el('div', { class: 'tiny muted' }, e.description_en) : null,
        el('div.divider'),
        el('dl.kv', {},
          [['event_id', e.id], ['camera', lane?.label],
          ['구간', `${ms(e.t_end - e.t_start)}`],
          ['severity', e.severity], ['track_ids', (e.track_ids || []).join(', ') || '—'],
          ['VLM', `${e.vlm_model || ''} · ${e.vlm_latency_ms || 0}ms`]]
            .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v ?? '—'))])),
        el('div.divider'),
        el('button.btn.sm.pri.wide', {
          onclick: () => {
            const lid = lane?.id;
            const off = lane?._off || 0;
            location.hash = `#/single/${lid}`;
            sessionStorage.setItem('seekTo', String(e.t_start - off));
          },
        }, '▶ 해당 카메라 원본 재생')));
  }

  function renderFlow(q = '') {
    clear(flowBody);
    const wrap = el('div.evlist');
    const list = allEvents.filter(e => !q || e.description.toLowerCase().includes(q));
    for (const e of list.slice(0, 300)) {
      wrap.append(el('div.evitem', { onclick: () => selectEv(e) },
        el('div.rail'),
        el('div.bullet', { style: { background: e.color } }),
        el('div.evbody', {},
          el('div.row', {},
            el('span.evtime', {},
              new Date(base + e.t_start * 1000).toISOString().slice(11, 19)),
            el('span.evtag', {
              style: { color: e._lane.color, background: 'transparent' },
            }, e._lane.label)),
          el('div.evdesc', {}, e.description),
          el('div.evmeta', {},
            el('span.evtag', { style: { color: e.color } }, e.type_ko),
            el('span', { class: 'tiny muted mono' }, (e.score * 100).toFixed(0) + '%'))),
        e.thumbnail ? el('img.evthumb', {
          src: e.thumbnail, loading: 'lazy',
          onerror: ev => ev.target.remove(),
        }) : null));
    }
    if (!list.length) wrap.append(el('div.empty', {}, '결과 없음'));
    flowBody.append(wrap);
  }
  renderFlow();
}

/* --------------------------------------------------------- takip paneli -- */

function trackPanel() {
  const body = el('div.panel-b');
  // Not: document.getElementById yerine yerel referans — panel DOM'a
  // eklenmeden refresh() koşarsa çökmesin.
  const countEl = el('span', { class: 'tiny muted' }, '0');
  const p = el('div.panel', {},
    el('div.panel-h', {}, t('tracking'), el('span.grow'), countEl),
    body,
    el('div', { style: { padding: '8px', borderTop: '1px solid var(--line-soft)' } },
      el('button.btn.sm.ghost.wide', {
        onclick: () => exportTrack(),
      }, '⬇ 결과 내보내기')));

  async function refresh() {
    const tl = await api.tracklist('TL1');
    store.set({ tracklist: tl });
    clear(body);
    countEl.textContent = tl.members.length;
    if (!tl.members.length) {
      body.append(el('div.empty', {},
        el('span', { class: 'big' }, '⌖'),
        el('div', {}, '추적 대상이 없습니다'),
        el('div', { class: 'tiny', style: { marginTop: '6px' } },
          '객체 목록에서 인물을 선택하고 Re-ID 매칭 후 등록하세요')));
      return;
    }
    for (const m of tl.members) {
      body.append(el('div.tlmember', {},
        el('img', { src: m.crop, onerror: e => e.target.style.visibility = 'hidden' }),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { class: 'tiny', style: { fontWeight: 700 } }, m.camera),
          el('div', { class: 'tiny muted mono' }, clockOf(m.wall_time)),
          m.similarity ? el('div', { class: 'tiny', style: { color: simColor(m.similarity) } },
            'sim ' + m.similarity.toFixed(3)) : null),
        el('button.iconbtn', {
          onclick: async () => { await api.trackDel('TL1', m.object_id); refresh(); },
        }, '✕')));
    }
  }
  refresh();
  p._refresh = refresh;
  return p;
}

async function exportTrack() {
  const tl = store.get('tracklist');
  if (!tl.members?.length) { toast('추적 대상이 없습니다', 'warn'); return; }
  const typeSel = el('select.select', {},
    [['video', '요약 영상 (MP4, BBox 번인)'], ['excel', 'Excel 보고서'],
    ['word', 'Word 보고서']].map(([v, l]) => el('option', { value: v }, l)));
  const bar = el('div.progline', {}, el('i', { style: { width: '0%' } }));
  const st = el('div', { class: 'tiny muted' }, '');
  const close = modal({
    title: '결과 내보내기',
    body: el('div.col', { style: { gap: '11px' } },
      el('div', { class: 'tiny muted' },
        `추적 대상 ${tl.members.length}명이 등장한 구간을 모아 내보냅니다.`),
      el('div.field', {}, el('label', {}, '형식'), typeSel),
      el('div', { class: 'codeblock' },
        'POST /api/exports\n{ "type": "video", "tracklist_id": "TL1" }\n'
        + '→ 202 { "export_id": "exp-xxxxx" }\n\n'
        + '※ 화면에서는 BBox를 오버레이로 그리지만, 내보내기에서는\n'
        + '   ffmpeg으로 영상에 번인합니다 (외부 공유용).'),
      bar, st),
    footer: [
      el('button.btn.ghost', { onclick: () => close() }, '닫기'),
      el('button.btn.pri', {
        onclick: async (e) => {
          e.target.disabled = true;
          const r = await api.exportStart({
            type: typeSel.value, tracklist_id: 'TL1',
            member_ids: tl.members.map(m => m.object_id),
          });
          const iv = setInterval(async () => {
            const s = await api.exportGet(r.export_id);
            bar.firstChild.style.width = s.progress + '%';
            st.textContent = `${s.status} · ${s.progress}%`;
            if (s.status === 'completed') {
              clearInterval(iv);
              st.textContent = `완료 · ${s.size_mb} MB`;
              toast('내보내기 완료 (mock — 실제 파일 생성 안 됨)', 'ok');
            }
          }, 300);
        },
      }, '내보내기 시작'),
    ],
  });
}

/* ==========================================================================
   Ekran: 객체 목록 + Re-ID 추적
   ========================================================================== */

async function screenObjects(videoId, queryObjectId) {
  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  const sidebar = el('div.sidebar', {},
    treePanel(videoId, c => location.hash = `#/objects/${c.id}`),
    filterPanel(() => load()));
  mount(ROOT(), topbar('objects'), el('div.main', {}, sidebar, stage, rightbar));

  const video = await api.video(videoId);
  const defs = store.get('attributes');

  const hdr = el('div.hdr', {},
    el('div.hdr-top', {},
      el('div.crumb', {},
        el('span.par', {}, video.group_name),
        el('span.sep', {}, '›'),
        el('span.cur', {}, video.name),
        el('span.sep', {}, '›'),
        el('span.cur', {}, t('objects')),
        video.real_data ? el('span.badge.real', {}, '실제 SOLIDER 데이터') : null),
      el('div.grow'),
      el('span', { class: 'tiny muted', id: 'objtotal' }, '')),
    el('div.hdr-sub', {},
      el('span', {}, 'Object Detection 결과의 크롭 이미지 · PAR 속성으로 필터링 · '),
      el('b', {}, '카드를 클릭하면 Re-ID 매칭이 즉시 시작됩니다')));

  const grid = el('div.objgrid');
  const gridPanel = el('div.panel', {},
    el('div.panel-h', {}, '객체 리스트', el('span.grow'),
      el('span', { class: 'tiny muted' }, 'crop 128px')),
    el('div.panel-b', {}, grid));
  mount(stage, hdr, gridPanel);

  const reidBody = el('div.panel-b', {},
    el('div.empty', {},
      el('span', { class: 'big' }, '⌖'),
      el('div', {}, 'Re-ID 매칭 대기'),
      el('div', { class: 'tiny', style: { marginTop: '8px', lineHeight: 1.7 } },
        '왼쪽 목록에서 인물을 클릭하면 그 즉시 매칭이 시작됩니다.',
        el('br'),
        '사전 매칭은 하지 않습니다 (N² 비용 회피).')));
  const modelEl = el('span', { class: 'tiny muted' }, 'SOLIDER 1024-d');
  const reidPanel = el('div.panel', { style: { flex: '1 1 60%' } },
    el('div.panel-h', {}, 'Re-ID 매칭', el('span.grow'), modelEl),
    reidBody);
  const tp = trackPanel();
  mount(rightbar, reidPanel, tp);

  let objects = [];

  async function load() {
    const f = store.get('filters');
    const r = await api.objects(videoId, {
      limit: 500, cls: f.cls, gender: f.gender, age: f.age,
      upper_color: f.upper_color, carry: f.carry,
    });
    objects = r.items;
    document.getElementById('objtotal').textContent =
      `${r.total}건 표시 (전체 ${r.total})`;
    clear(grid);
    if (!objects.length) {
      grid.append(el('div.empty', { style: { gridColumn: '1/-1' } },
        el('span', { class: 'big' }, '⌕'), '조건에 맞는 객체가 없습니다'));
      return;
    }
    for (const o of objects) {
      const dots = [o.attrs?.upper_color, o.attrs?.lower_color, o.attrs?.vehicle_color]
        .filter(Boolean);
      const card = el('div.objcard', {
        title: `${o.label}\n${attrText(o.attrs, defs?.attributes, o.cls)}`,
        onclick: () => startReid(o),
      },
        el('img', {
          class: 'im', src: o.crop, loading: 'lazy',
          onerror: e => { e.target.src = 'data:image/svg+xml;utf8,'
            + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="136"><rect width="80" height="136" fill="%23111827"/></svg>'); },
        }),
        o.kind === 'real' ? el('div', { class: 'kindtag' }, 'REAL') : null,
        dots.length ? el('div', { class: 'attrdots' },
          dots.map(c => el('i', { style: { background: COLOR_HEX[c] || '#888' } }))) : null,
        el('div', { class: 'cap' },
          el('div', { class: 't' }, clockOf(o.wall_time)),
          el('div', { class: 'nowrap' }, o.cls === 'person' ? '사람' : '차량',
            o.attrs?.gender ? ' · ' + (o.attrs.gender === 'male' ? '남' : '여') : '')),
        el('div', { class: 'objactions' },
          el('button.btn.sm.pri', {
            onclick: (e) => { e.stopPropagation(); startReid(o); },
          }, '추적'),
          el('button.btn.sm.ghost', {
            onclick: (e) => { e.stopPropagation(); showObject(o, videoId); },
          }, 'ℹ')));
      grid.append(card);
    }
    if (queryObjectId) {
      const o = objects.find(x => x.id === queryObjectId);
      if (o) startReid(o);
    }
  }

  /* ---------------------------------------------------- Re-ID akışı ----- */
  async function startReid(qobj) {
    if (qobj.cls !== 'person') { toast('Re-ID는 현재 사람만 지원합니다', 'warn'); return; }
    [...grid.children].forEach(c => c.classList.remove('on'));

    const scope = store.get('groups').flatMap(g => g.cameras)
      .filter(c => c.status === 'completed').map(c => c.id);

    const bar = el('div.progline', {}, el('i', { style: { width: '0%' } }));
    const meta = el('div', { class: 'tiny muted' }, '풀 준비 중…');
    const listHost = el('div');
    const btnMore = el('button.btn.sm.wide', {
      style: { display: 'none' },
      onclick: async () => {
        btnMore.disabled = true;
        btnMore.textContent = '검색 중…';
        await api.reidContinue(sid, 3);
      },
    }, '↻ ' + t('continueSearch'));

    mount(reidBody,
      el('div.reidhead', {},
        el('img', { src: qobj.crop, onerror: e => e.target.style.visibility = 'hidden' }),
        el('div', { style: { flex: 1, minWidth: 0 } },
          el('div', { style: { fontWeight: 700 } }, qobj.label || qobj.id),
          el('div', { class: 'tiny muted mono' },
            `${qobj.camera} · ${clockOf(qobj.wall_time)}`),
          el('div', { class: 'tiny muted' },
            attrText(qobj.attrs, defs?.attributes, qobj.cls) || '속성 없음'),
          el('div', { style: { marginTop: '7px' } }, bar),
          meta)),
      el('div', { style: { padding: '8px 11px' } }, btnMore),
      listHost);

    const r = await api.reidStart({
      object_id: qobj.id, scope_video_ids: scope, exclude_same_video: true,
    });
    const sid = r.session_id;
    modelEl.textContent = r.model;
    meta.textContent = `후보 풀 ${r.pool_size}건 · 임계값 ${r.threshold} · 시간 근접순`;

    const stop = listen(api.reidStreamUrl(sid), (m) => {
      if (m.type === 'batch') {
        bar.firstChild.style.width =
          (m.compared / m.pool_size * 100) + '%';
        meta.textContent = `배치 ${m.batch} · 비교 ${m.compared}/${m.pool_size} `
          + `· 최고 유사도 ${m.best.toFixed(3)}`;
        renderCands(m.candidates);
      }
      if (m.type === 'paused' || m.type === 'done') {
        btnMore.style.display = m.type === 'done' ? 'none' : '';
        btnMore.disabled = false;
        btnMore.textContent = '↻ ' + t('continueSearch')
          + ` (남은 ${r.pool_size - m.compared}건)`;
        meta.textContent += m.reason === 'enough_matches'
          ? ' · 충분한 매칭을 찾아 중단됨'
          : (m.reason === 'pool_exhausted' ? ' · 풀 소진' : ' · 배치 한도');
      }
    }, 'reid');
    onLeave(stop);

    function renderCands(cands) {
      clear(listHost);
      listHost.append(el('div.panel-h', { style: { borderTop: '1px solid var(--line-soft)' } },
        t('candidates'), el('span.grow'),
        el('span', { class: 'tiny muted' }, `${cands.length}`)));
      for (const c of cands) {
        const row = el('div.simrow', {},
          el('img', {
            src: c.crop, onerror: e => e.target.style.visibility = 'hidden',
            onclick: () => location.hash = `#/single/${c.video_id}`,
          }),
          el('div', { style: { flex: 1, minWidth: 0 } },
            el('div.row', {},
              el('span', { class: 'mono', style: { fontWeight: 800, color: simColor(c.similarity) } },
                c.similarity.toFixed(4)),
              el('span', { class: 'tiny muted nowrap' }, c.camera),
              c.kind === 'real' ? el('span.badge.real', { class: 'tiny' }, 'REAL') : null),
            el('div', { class: 'tiny muted mono' }, clockOf(c.wall_time)),
            el('div.simbar', {},
              el('i', {
                style: {
                  width: Math.max(2, c.similarity * 100) + '%',
                  background: simColor(c.similarity),
                },
              }))),
          el('div.col', { style: { gap: '3px' } },
            el('button.btn.sm.pri', {
              onclick: async () => {
                // track_identity_match.status = confirmed
                await api.reidVerdict(sid, c.object_id, 'confirmed');
                await api.trackAdd('TL1', {
                  object_id: c.object_id, similarity: c.similarity,
                });
                tp._refresh();
                toast(`추적 대상에 추가: ${c.camera} ${clockOf(c.wall_time)}`, 'ok');
                row.style.opacity = '.5';
              },
            }, '✓ ' + t('sameperson')),
            el('button.btn.sm.ghost', {
              title: t('notsame') + ' (identity_match_status = rejected)',
              onclick: async () => {
                await api.reidVerdict(sid, c.object_id, 'rejected');
                row.style.opacity = '.35';
              },
            }, '✕')));
        listHost.append(row);
      }
      // sorgu nesnesini de listeye ekle
      listHost.append(el('div', {
        style: { padding: '9px 11px', borderTop: '1px solid var(--line-soft)' },
      },
        el('button.btn.sm.ghost.wide', {
          onclick: async () => {
            await api.trackAdd('TL1', { object_id: qobj.id, similarity: 1.0 });
            tp._refresh(); toast('질의 객체를 추적 대상에 추가', 'ok');
          },
        }, '＋ 질의 객체도 추적 대상에 추가')));
    }
  }

  load();
}

/* ==========================================================================
   Ekran: 작업 관리
   ========================================================================== */

async function screenJobs() {
  const body = el('div.panel-b');
  mount(ROOT(), topbar('jobs'),
    el('div.main', {},
      el('div.stage', { style: { padding: '10px' } },
        el('div.panel', {},
          el('div.panel-h', {}, '분석 작업 관리', el('span.grow'),
            el('button.btn.sm.ghost', { onclick: () => screenJobs() }, '⟲ 새로고침')),
          body))));

  // Şema iki katman ayırıyor:
  //   analysis_job  — kullanıcının istediği bir analiz (çok video olabilir)
  //   analysis_run  — o işin her video için ayrı çalıştırması
  const [aj, loose] = await Promise.all([api.analysisJobs(), api.jobs()]);

  /* Gerçek backend'de SSE yok — kuyruk durumu kendiliğinden gelmiyor.
     Devam eden iş varken sayfayı düzenli aralıkla tazeliyoruz; hepsi bitince
     yoklama kendiliğinden duruyor, boşuna istek atılmıyor. */
  const busy = loose.items.some(
    (j) => j.status === 'running' || j.status === 'queued');
  if (busy) {
    const iv = setTimeout(() => {
      if (location.hash.startsWith('#/jobs')) screenJobs();
    }, 3000);
    onLeave(() => clearTimeout(iv));
  }
  const STAT = {
    completed: ['완료', 'var(--ok)'], running: ['진행 중', 'var(--busy)'],
    failed: ['실패', 'var(--crit)'], canceled: ['취소', 'var(--tx-2)'],
    queued: ['대기', 'var(--tx-2)'],
  };
  const pill = (st) => {
    const [lbl, col] = STAT[st] || [st, 'var(--tx-1)'];
    return el('span', { style: { color: col, fontWeight: 700 } }, lbl);
  };
  const runRow = (j, indent) => {
    const [, col] = STAT[j.status] || ['', 'var(--tx-1)'];
    return el('tr', {},
      el('td', { class: 'mono tiny', style: indent ? { paddingLeft: '30px' } : {} },
        (indent ? '└ ' : '') + j.job_id),
      el('td', {}, j.video_id),
      el('td', {}, pill(j.status)),
      el('td', { style: { width: '130px' } },
        el('div.gbar', {}, el('i', {
          style: { width: (j.progress || 0) + '%', background: col },
        })),
        el('div', { class: 'tiny muted mono' }, (j.progress || 0) + '%')),
      el('td', { class: 'tiny' }, j.stage_label || j.stage || '—'),
      el('td', { class: 'mono tiny' }, clockOf(j.created_at)),
      el('td', { class: 'mono tiny' }, j.duration_sec ? dur(j.duration_sec) : '—'),
      el('td', {}, j.status === 'running'
        ? el('button.btn.sm.danger', {
          onclick: async () => { await api.jobCancel(j.job_id); screenJobs(); },
        }, '중지')
        : (j.error ? el('button.btn.sm.ghost', {
          onclick: () => modal({
            title: '오류 상세 · ' + j.job_id,
            body: el('div.codeblock', {}, j.error),
          }),
        }, '오류') : '')));
  };

  const grouped = new Set(aj.items.flatMap(j => j.run_ids));
  const orphans = loose.items.filter(j => !grouped.has(j.job_id));

  mount(body, el('table.tbl', {},
    el('thead', {}, el('tr', {},
      ['ID', '영상', '상태', '진행', '단계', '생성', '소요', ''].map(h => el('th', {}, h)))),
    el('tbody', {},
      aj.items.flatMap(j => [
        el('tr', { style: { background: 'var(--bg-2)' } },
          el('td', { class: 'mono', style: { fontWeight: 700 } },
            '▣ ' + j.analysis_job_id),
          el('td', { colspan: 1 },
            el('div', { style: { fontWeight: 700 } }, j.name),
            j.prompt ? el('div', { class: 'tiny muted' }, '“' + j.prompt + '”') : null),
          el('td', {}, pill(j.status)),
          el('td', { class: 'tiny muted' }, `run ${j.run_ids.length}건`),
          el('td', { class: 'tiny muted' }, 'analysis_job'),
          el('td', { class: 'mono tiny' }, clockOf(j.requested_at)),
          el('td', { class: 'mono tiny' },
            j.completed_at ? clockOf(j.completed_at) : '—'),
          el('td', {})),
        ...j.runs.map(r => runRow(r, true)),
      ]),
      orphans.length
        ? el('tr', { style: { background: 'var(--bg-2)' } },
          el('td', { colspan: 8, class: 'tiny muted' },
            '▣ 단일 실행 (analysis_job 없이 직접 요청됨)'))
        : null,
      ...orphans.map(r => runRow(r, true)))));
}

/* ==========================================================================
   Ekran: 시스템 (GPU + 로그)
   ========================================================================== */

async function screenSystem() {
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

/* ==========================================================================
   Ekran: 설정
   ========================================================================== */

async function screenSettings() {
  const { settings, choices } = await api.settings();
  const body = el('div', {
    style: {
      padding: '14px', display: 'grid', gap: '14px',
      gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))',
    },
  });
  const draft = JSON.parse(JSON.stringify(settings));

  function section(title, note, fields) {
    return el('div.panel', {},
      el('div.panel-h', {}, title),
      el('div', { style: { padding: '12px', display: 'grid', gap: '10px' } },
        note ? el('div', { class: 'tiny muted' }, note) : null, fields));
  }
  function num(group, key, label, min, max, step) {
    return el('div.field', { style: { margin: 0 } },
      el('label', {}, label),
      el('input.input', {
        type: 'number', value: draft[group][key], min, max, step: step || 1,
        oninput: e => draft[group][key] = +e.target.value,
      }));
  }
  function sel(group, key, label, opts) {
    return el('div.field', { style: { margin: 0 } },
      el('label', {}, label),
      el('select.select', { onchange: e => draft[group][key] = e.target.value },
        opts.map(o => el('option', { value: o, selected: draft[group][key] === o }, o))));
  }

  mount(body,
    section('요약 옵션', '요약 길이 · 세그먼트 · 프롬프트', el('div', { style: { display: 'grid', gap: '9px' } },
      num('summary', 'target_ratio', '목표 요약 비율 (%)', 1, 50),
      num('summary', 'min_segment_sec', '최소 세그먼트 (초)', 1, 60),
      num('summary', 'max_segment_sec', '최대 세그먼트 (초)', 4, 300),
      num('summary', 'context_pad_sec', '전후 컨텍스트 확장 (초)', 0, 30))),
    section('분석 임계값', 'Confidence / IoU / 후보 선정 기준',
      el('div', { style: { display: 'grid', gap: '9px' } },
        num('analysis', 'conf_threshold', 'Detection confidence', 0, 1, 0.05),
        num('analysis', 'iou_threshold', 'Tracking IoU', 0, 1, 0.05),
        num('analysis', 'candidate_threshold', '후보 구간 임계값 (통합 점수)', 0, 1, 0.01),
        num('analysis', 'candidate_window_sec', '후보 판단 윈도우 (초)', 0.5, 30, 0.5),
        num('analysis', 'vlm_score_threshold', 'VLM 채택 임계값', 0, 1, 0.05),
        num('analysis', 'segment_frames', '세그먼트 프레임 수', 8, 96))),
    section('AI 모델', '모델 교체 시 재분석이 필요합니다',
      el('div', { style: { display: 'grid', gap: '9px' } },
        Object.keys(choices).map(k => sel('models', k, k, choices[k])))),
    section('Re-ID', '매칭 임계값과 배치 동작',
      el('div', { style: { display: 'grid', gap: '9px' } },
        num('reid', 'match_threshold', '동일 인물 임계값 (cosine)', 0, 1, 0.01),
        num('reid', 'batch_size', '배치 크기', 5, 200),
        num('reid', 'max_auto_batches', '자동 배치 수 (이후 사용자 확인)', 1, 20))),
    section('재생', '프록시 생성 및 오버레이 기본값',
      el('div', { style: { display: 'grid', gap: '9px' } },
        sel('playback', 'proxy_codec', '프록시 코덱', ['h264', 'hevc', 'vp9']),
        num('playback', 'gop_sec', 'GOP (초) — seek 정확도', 0.5, 10, 0.5),
        el('div', { class: 'tiny muted', style: { lineHeight: 1.7 } },
          '⚠ faststart 미적용 시 브라우저가 재생 전 전체 파일을 다운로드합니다. ',
          'GOP가 크면 이벤트 클릭 시 최대 ±GOP 초 오차가 발생합니다.'))),
    section('언어', 'UI 및 VLM 출력 언어',
      el('div', { style: { display: 'grid', gap: '9px' } },
        sel('locale', 'ui', 'UI 언어', ['ko', 'tr', 'en']),
        sel('locale', 'vlm_output', 'VLM 출력 언어', ['ko', 'en']))));

  mount(ROOT(), topbar('settings'),
    el('div.main', {},
      el('div.stage', { style: { padding: '10px' } },
        el('div.panel', {},
          el('div.panel-h', {}, '설정', el('span.grow'),
            el('button.btn.ghost.sm', { onclick: () => screenSettings() }, '되돌리기'),
            el('button.btn.pri.sm', {
              onclick: async () => {
                await api.saveSettings(draft);
                toast('설정 저장됨 (PUT /api/settings)', 'ok');
              },
            }, '저장')),
          el('div.panel-b', {}, body)))));
}

/* ==========================================================================
   Ekran: Home
   --------------------------------------------------------------------------
   Wireframe'deki yer tutucular (logo, kılavuz bağlantısı, telefon) bilerek
   olduğu gibi bırakıldı — proje sonunda güncellenecek. Gerçek olan tek şey
   sağ üstteki sunucu sağlık paneli: /status/health'ten geliyor.
   ========================================================================== */

async function screenHome() {
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
    if (h.gallery != null) {           // mock
      return mount(box,
        line('API server', true, 'mock'),
        line('database', true, 'mock'),
        line('LLM server', true, 'mock'));
    }
    const workers = (h.analysis && h.analysis.workers) || [];
    mount(box,
      line('API server', h.status === 'ok'),
      line('database', h.database && h.database.status === 'ok'),
      line('cache', h.cachedb && h.cachedb.status === 'ok'),
      ...workers.map((w) => line(w.worker_id,
        w.status !== 'unavailable', w.status)),
      line('LLM server', h.vllm && h.vllm.status === 'ok'));
  }
  tick();
  const iv = setInterval(tick, 5000);
  onLeave(() => clearInterval(iv));
}

/* ==========================================================================
   Ekran: Upload & Analysis
   --------------------------------------------------------------------------
   Amaç: aynı kameranın farklı zaman dilimlerine ait kayıtlarını TEK bir
   kesintisiz zaman çizgisinde birleştirmek.

   Akış (dosya süresi neden upload'dan SONRA biliniyor):
     VMS kayıtları AVI/mpeg4 — tarayıcı bu dosyaları açamadığı için süreyi
     yerel olarak okuyamıyoruz. MP4 ise okuyoruz (anında görünür), değilse
     backend'in ffprobe sonucunu bekliyoruz. Bu yüzden sıra:
        dosya seç → yükle → süre gelir → başlangıç saatlerini ayarla → analiz

   Çakışma (overlap): iki kayıt aynı zaman aralığını kapsıyorsa o aralık
   kırmızı gösterilir ve ikinci kayıtta kırpılmış sayılır — aynı görüntü iki
   kez analiz edilmesin diye.
   ========================================================================== */

/**
 * Sol ağaç ve Analysis ekranı `store.groups`'tan besleniyor ve bu liste
 * yalnızca ilk açılışta dolduruluyordu (`route()`). Yükleme bitince yeni
 * grup ancak sayfa yenilenince görünüyordu — burada zorla tazeliyoruz.
 */
/** modal() üzerine ince bir onay sarmalayıcı — true/false ile çözülür. */
function confirmModal(title, text, okLabel = '계속') {
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

async function refreshGroups() {
  try {
    api.invalidate();
    const g = await api.groups();
    store.set({ groups: g.groups, eventTypes: g.event_types });
    return g.groups;
  } catch (e) {
    toast('Could not refresh the group list: ' + e.message, 'warn');
    return store.get('groups');
  }
}

/**
 * Yükleme bittiği anda backend kaydı hâlâ RESERVED olabiliyor: dosya diske
 * yazılıyor, ffprobe koşuyor, durum ancak ondan sonra `uploaded`a dönüyor.
 * Tek seferlik tazeleme o araya denk gelince ağaçta mavi (registered) kayıt
 * kalıyor ve ancak elle F5 ile düzeliyordu. Burada kısa süre yokluyoruz.
 */
async function waitForVideoReady(videoId, tries = 6, delayMs = 1200) {
  for (let i = 0; i < tries; i++) {
    const groups = await refreshGroups();
    const cam = groups.flatMap((g) => g.cameras || [])
      .find((c) => String(c.id) === String(videoId));
    if (cam && cam.status !== 'registered') return cam;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

const UP = {
  collName: '',
  groupId: null,
  items: [],      // {key,file,name,startAt,durationMs,videoId,state,progress,meta}
  sel: 0,
  /* Birleştirme kipi: parçalar ffmpeg ile TEK bir MP4'e çevrilip backend'e
     tek video olarak gider. Kapalıyken her parça ayrı video_id alır. */
  merge: true,
  mergedId: null, // birleştirme sonrası oluşan video_id
  /* VLM örnekleme penceresi. Backend her `interval` saniyede bir `window`
     saniyelik pencere açıyor (metadata: vlm_segment_interval_seconds /
     vlm_segment_duration_seconds). Kullanıcı önemli anları bu pencerelere
     denk getirmek istiyor, o yüzden değerler arayüzde düzenlenebilir. */
  vlmInterval: +(localStorage.getItem('up.vlmInterval') || 60),
  vlmWindow: +(localStorage.getItem('up.vlmWindow') || 10),
};

/**
 * Birleşik videodaki yerleşim. Boşluklar concat'te DÜŞER: kümülatif konum
 * yalnızca parça sürelerinin toplamıdır, duvar saatindeki aralıklar değil.
 *
 * @returns {{rows:Array, total:number}} rows: {item, at, dur, end}
 */
function mergedLayout(items) {
  /* SIRA: zaman çizgisindeki başlangıç saatine göre — `UP.items` dizisinin
     kendi sırası değil. Kullanıcı çubukları sürükleyip yer değiştirdiğinde
     dizi sırası olduğu gibi kalıyor; buna güvenince alt şerit sürüklemeyi
     hiç görmüyordu. */
  const idx = new Map(items.map((it, i) => [it, i]));
  const list = items.filter((i) => i.startAt).sort((a, b) =>
    a.startAt - b.startAt || idx.get(a) - idx.get(b));

  const rows = [];
  let t = 0;          // birleşik videodaki konum
  let wallEnd = null; // bir öncekinin duvar saatindeki bitişi
  for (const it of list) {
    const full = it.durationMs || EST_DUR_MS;
    const outMs = it.trimOut == null ? full : it.trimOut;
    const wallStart = it.startAt.getTime();

    /* ÇAKIŞMA: iki parça aynı zaman aralığını kapsıyorsa sonrakinin başı o
       kadar atılır — üstteki rayın kırmızı bantla söylediği şey bu. Eskiden
       burada hesaba katılmıyordu ve birleşik uzunluk çakışan görüntüyü iki
       kez sayıyordu. Kalıcı yazmıyoruz (kullanıcının trim'i bozulmasın),
       yalnızca bu yerleşim için hesaplıyoruz. */
    let inMs = it.trimIn || 0;
    let overlapCut = 0;
    if (wallEnd != null && wallStart < wallEnd) {
      overlapCut = Math.min(wallEnd - wallStart, Math.max(0, outMs - inMs - 200));
      inMs += overlapCut;
    }

    const dur = Math.max(200, outMs - inMs);
    rows.push({ item: it, at: t, dur, end: t + dur, inMs, outMs, overlapCut });
    t += dur;
    wallEnd = Math.max(wallEnd == null ? -Infinity : wallEnd,
                       wallStart + effDur(it));
  }
  return { rows, total: t };
}

/** k. örnekleme penceresi [başlangıç, bitiş] — birleşik video saniyesinde. */
function vlmWindows(totalMs, intervalSec, windowSec) {
  const out = [];
  const iv = Math.max(1, intervalSec) * 1000;
  const w = Math.max(1, windowSec) * 1000;
  for (let t = 0; t < Math.max(totalMs, 1); t += iv) {
    out.push({ t0: t, t1: Math.min(t + w, t + iv) });
  }
  return out;
}

/** Bir parçanın ne kadarı örnekleme penceresine düşüyor (ms). */
function coveredMs(row, wins) {
  let n = 0;
  for (const w of wins) {
    n += Math.max(0, Math.min(row.end, w.t1) - Math.max(row.at, w.t0));
  }
  return n;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Zaten analiz edilmiş videoyu yeniden analiz etmek isteyip istemediğini
 * sorar. Backend `succeeded` kaydını da çakışma sayıp 409 döndüğü için
 * önce kuyruk kaydını silmek gerekiyor — bu, sonuç dosyasını silmez ama
 * mevcut sonuçların yerini yenisi alır.
 */
function askReanalyze(videoIds, names, body, watch) {
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

/** Date → <input type="datetime-local"> değeri (yerel saat, saniyeli) */
function toLocalInput(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
       + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/* ---- hover önizleme -------------------------------------------------------
   Dosyalar zaten tarayıcıda duruyor, yani sunucuya hiç gitmeden kare
   alabiliyoruz: gizli bir <video>'yu istenen saniyeye sarıp <canvas>'a
   çiziyoruz. Yalnızca tarayıcının açabildiği kaplarda çalışır (MP4/WebM/MOV);
   AVI'de sessizce devre dışı kalır.

   Her dosya için TEK bir <video> tutuluyor ve kareler önbellekleniyor —
   sürükleme sırasında saniyede onlarca istek gelebiliyor. */
const THUMB_CACHE = new Map();      // `${key}@${saniye}` → dataURL
const THUMB_VIDEOS = new Map();     // item.key → { el, url, ok }

function thumbVideo(it) {
  let v = THUMB_VIDEOS.get(it.key);
  if (v) return v;
  const elv = document.createElement('video');
  elv.preload = 'metadata';
  elv.muted = true;
  const url = URL.createObjectURL(it.file);
  elv.src = url;
  v = { el: elv, url, ok: null };
  THUMB_VIDEOS.set(it.key, v);
  return v;
}

function releaseThumbs() {
  for (const v of THUMB_VIDEOS.values()) {
    try { URL.revokeObjectURL(v.url); } catch { /* zaten serbest */ }
  }
  THUMB_VIDEOS.clear();
  THUMB_CACHE.clear();
}

/** Kaynak dosyanın `sec`. saniyesindeki kareyi dataURL olarak verir. */
function grabFrame(it, sec) {
  const q = Math.max(0, Math.round(sec * 2) / 2);      // 0,5 sn'ye yuvarla
  const ck = `${it.key}@${q}`;
  if (THUMB_CACHE.has(ck)) return Promise.resolve(THUMB_CACHE.get(ck));

  const v = thumbVideo(it);
  if (v.ok === false) return Promise.resolve(null);

  return new Promise((resolve) => {
    const done = (val) => {
      v.el.onseeked = null; v.el.onerror = null;
      clearTimeout(timer);
      if (val) THUMB_CACHE.set(ck, val);
      resolve(val);
    };
    const timer = setTimeout(() => done(null), 2500);
    v.el.onerror = () => { v.ok = false; done(null); };
    v.el.onseeked = () => {
      try {
        const c = document.createElement('canvas');
        const w = 160;
        const h = Math.max(1, Math.round(w * (v.el.videoHeight || 9)
                                          / (v.el.videoWidth || 16)));
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(v.el, 0, 0, w, h);
        v.ok = true;
        done(c.toDataURL('image/jpeg', 0.7));
      } catch { v.ok = false; done(null); }
    };
    const seek = () => { try { v.el.currentTime = q; } catch { done(null); } };
    if (v.el.readyState >= 1) seek();
    else v.el.onloadedmetadata = seek;
  });
}

/** Tarayıcı açabiliyorsa süreyi yerel olarak oku (mp4/webm). AVI'de null. */
function probeDurationMs(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
    v.onloadedmetadata = () => done(
      isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 1000) : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    v.src = url;
  });
}

/* Süresi henüz bilinmeyen parçanın varsayılan uzunluğu (10 dk). Sadece
   çizim içindir — gerçek süre upload sonrası ffprobe'dan gelir. */
const EST_DUR_MS = 10 * 60 * 1000;

/** Kırpma sonrası kullanılacak süre (kırpma yoksa dosyanın tamamı). */
function effDur(it) {
  const full = it.durationMs || EST_DUR_MS;
  const a = it.trimIn || 0;
  const b = it.trimOut == null ? full : it.trimOut;
  return Math.max(200, Math.min(b, full) - a);
}

/** Bu parçada kırpma var mı (kaynağın tamamı kullanılmıyor mu)? */
function isTrimmed(it) {
  if (!it.durationMs) return !!it.trimIn;
  return (it.trimIn || 0) > 0 || (it.trimOut != null && it.trimOut < it.durationMs);
}

/**
 * Zaman çizgisi düzeni: sıralı parçalar, boşluklar ve çakışmalar.
 *
 * Süresi bilinmeyen (AVI, henüz yüklenmemiş) dosyalar da çizilir — yoksa
 * kullanıcı yükleme öncesi hiçbir şey göremez ve sürükleyemez. Bunlar
 * `est:true` ile işaretlenir: tahmini uzunlukla gösterilir, boşluk/çakışma
 * hesabına KATILMAZ (yanlış kırmızı bant çıkmasın diye).
 */
function layoutUpload(items) {
  const usable = items.filter((i) => i.startAt);
  if (!usable.length) return null;
  const parts = usable
    .map((i) => {
      const est = !i.durationMs;
      // Zaman çizgisindeki uzunluk KIRPILMIŞ süredir — birleşik videoya
      // giden de bu. Kırpma yoksa dosyanın tamamı.
      const dur = effDur(i);
      return { item: i, est, dur, trimmed: isTrimmed(i),
               t0: i.startAt.getTime(), t1: i.startAt.getTime() + dur };
    })
    .sort((a, b) => a.t0 - b.t0);

  const t0 = parts[0].t0;
  const t1 = Math.max(...parts.map((p) => p.t1));

  /* Boşluk/çakışma yalnızca süresi kesin olan parçalar arasında anlamlı */
  const solid = parts.filter((p) => !p.est);
  const overlaps = [];
  const gaps = [];
  if (solid.length) {
    let cursor = solid[0].t1;
    for (let i = 1; i < solid.length; i++) {
      const p = solid[i];
      if (p.t0 < cursor) {
        overlaps.push({ t0: p.t0, t1: Math.min(cursor, p.t1),
                        a: solid[i - 1].item, b: p.item });
      } else if (p.t0 > cursor) {
        gaps.push({ t0: cursor, t1: p.t0 });
      }
      cursor = Math.max(cursor, p.t1);
    }
  }
  const overlapMs = overlaps.reduce((s, o) => s + (o.t1 - o.t0), 0);
  const gapMs = gaps.reduce((s, g) => s + (g.t1 - g.t0), 0);
  const solidSpan = solid.length
    ? Math.max(...solid.map((p) => p.t1)) - solid[0].t0 : 0;
  return { parts, t0, t1, span: t1 - t0, overlaps, gaps, overlapMs, gapMs,
           mergedMs: solidSpan - gapMs,
           estCount: parts.length - solid.length };
}

async function screenUpload() {
  const stage = el('div.stage', { style: { padding: '12px', overflow: 'auto' } });
  const side = el('div.rightbar', { style: { padding: '12px' } });
  const sidebar = el('div.sidebar', {},
    treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
  mount(ROOT(), topbar('upload'), el('div.main', {}, sidebar, stage, side));

  const live = API_MODE === 'live';
  const tlBox = el('div.uptl');
  const listBox = el('div', { style: { display: 'grid', gap: '6px' } });
  const infoBox = el('div', { class: 'tiny muted' });
  const sideBox = el('div', { style: { display: 'grid', gap: '12px' } });
  const mergeNote = el('div', { class: 'tiny', style: { flex: 1, lineHeight: 1.6 } });

  /**
   * Birleştirmenin analiz üzerindeki bedelini açıkça yazar.
   *
   * Backend VLM'i sabit aralıkla örnekliyor (vlm_segment_interval_seconds 60,
   * duration 10). Kısa klipler AYRI kalırsa her birine bir pencere düşer ve
   * neredeyse tamamı analiz edilir; tek dosyada birleşince aynı 60 sn'lik
   * aralık tüm kaydı kapsar ve yalnızca ilk 10 saniye görülür.
   */
  function drawMergeNote() {
    const parts = UP.items.length || 0;
    const totalMs = UP.items.reduce((a, i) => a + (i.durationMs || 0), 0);
    if (!UP.merge) {
      mergeNote.style.color = 'var(--tx-2)';
      mergeNote.textContent = parts
        ? `${parts} file(s) will be registered as separate video_ids.`
        : 'Each file is registered as its own video_id.';
      return;
    }
    mergeNote.style.color = '#fbbf24';
    const secs = totalMs / 1000;
    mount(mergeNote,
      el('div', {}, parts
        ? `${parts} file(s) will be merged into one MP4 by ffmpeg and `
          + 'registered as a single video_id.'
        : 'Files are merged into one MP4 and registered as a single video_id.'),
      secs > 10 ? el('div', {},
        'Coverage warning: the VLM looks at only 10s out of every 60s. '
        + `Merged, roughly `
        + `${Math.max(1, Math.round(secs / 60)) * 10}s of ${hms(secs)} `
        + 'would be analyzed — kept separate, nearly all of each file is.') : null);
  }

  /* ---- yeniden çizim ---------------------------------------------------- */

  /** Zaman çizgisinin altındaki özet satırı (sürükleme dışındaki normal hâl) */
  function drawInfo(L) {
    if (!L) { infoBox.textContent = ''; return; }
    mount(infoBox,
      el('span', {}, `Merged length ${hms(L.mergedMs / 1000)}`),
      L.gapMs ? el('span', { style: { color: 'var(--tx-2)' } },
        ` · gaps ${hms(L.gapMs / 1000)}`) : null,
      L.overlapMs ? el('span', { style: { color: '#f87171' } },
        ` · overlap ${hms(L.overlapMs / 1000)} (trimmed from the later clip)`) : null,
      L.estCount ? el('span', { style: { color: '#fbbf24' } },
        ` · ${L.estCount} clip(s) with estimated length`) : null,
      (() => {
        const cut = UP.items.filter(isTrimmed);
        if (!cut.length) return null;
        const cutMs = cut.reduce(
          (s, i) => s + ((i.durationMs || 0) - effDur(i)), 0);
        return el('span', { style: { color: '#38bdf8' } },
          ` · ✂ ${cut.length} trimmed (${hms(cutMs / 1000)} cut)`);
      })(),
      el('span', { class: 'muted' },
        ' · drag a bar to move it, drag its edges to trim'));
  }

  /* ---- hover önizleme kutusu --------------------------------------------- */
  const thumbBox = el('div.upthumb', { style: { display: 'none' } },
    el('img', {}), el('div.t', {}));
  document.body.append(thumbBox);
  onLeave(() => { thumbBox.remove(); releaseThumbs(); });

  let thumbSeq = 0;
  async function showThumb(it, srcSec, x, topY) {
    const my = ++thumbSeq;
    thumbBox.style.display = '';
    thumbBox.style.left = Math.round(x) + 'px';
    thumbBox.style.top = Math.round(topY) + 'px';
    thumbBox.querySelector('.t').textContent =
      `${it.name} · ${hms(srcSec)} of source`;
    const url = await grabFrame(it, srcSec);
    if (my !== thumbSeq) return;              // imleç çoktan başka yere gitti
    const img = thumbBox.querySelector('img');
    if (url) { img.src = url; img.style.display = ''; }
    else {
      img.style.display = 'none';
      thumbBox.querySelector('.t').textContent =
        `${it.name} · ${hms(srcSec)} · no preview (browser cannot decode)`;
    }
  }
  function hideThumb() { thumbSeq++; thumbBox.style.display = 'none'; }

  /** Zaman ekseni için okunur bir adım seç (1sn … 6sa). */
  function niceStep(spanMs, target = 6) {
    const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
                   3600, 7200, 10800, 21600];
    const want = spanMs / 1000 / target;
    return (STEPS.find((s) => s >= want) || 21600) * 1000;
  }

  function drawTimeline() {
    clear(tlBox);
    const L = layoutUpload(UP.items);
    if (!L) {
      tlBox.append(el('div', {
        class: 'tiny muted',
        style: { padding: '22px', textAlign: 'center' },
      }, UP.items.length
        ? 'No start time yet — set it in the Start time field on the right'
        : 'Drop video files here'));
      infoBox.textContent = '';
      return;
    }
    /* Görünür aralığa %4 pay bırakıyoruz: ilk parçayı sola, sonuncuyu sağa
       sürükleyebilmek için kenarda boşluk gerekiyor. */
    const pad = (L.span || 60000) * 0.04;
    const d0 = L.t0 - pad;
    const dSpan = L.span + pad * 2;
    const pctOf = (t) => ((t - d0) / dSpan) * 100;
    const track = el('div.uptrack');

    for (const g of L.gaps) {
      track.append(el('div.upgap', {
        style: { left: pctOf(g.t0) + '%', width: (pctOf(g.t1) - pctOf(g.t0)) + '%' },
        title: `Gap ${hms((g.t1 - g.t0) / 1000)}`,
      }, el('span', {}, hms((g.t1 - g.t0) / 1000))));
    }
    /* Çubuk artık iki satır taşıyor: sıra no + ad, altında süre. Genişlik
       dar kaldığında CSS ikinci satırı gizliyor. */
    L.parts.forEach((p, i) => {
      const cls = [UP.items[UP.sel] === p.item ? 'on' : '', p.est ? 'est' : '']
        .filter(Boolean).join(' ');
      const durTxt = p.est ? '?' : hms(p.dur / 1000);
      const bar = el('div.upbar', {
        class: cls,
        style: { left: pctOf(p.t0) + '%', width: (pctOf(p.t1) - pctOf(p.t0)) + '%' },
        title: `${i + 1}. ${p.item.name}\n`
             + `start  ${new Date(p.t0).toLocaleString()}\n`
             + (p.est
               ? 'length unknown until upload\n'
               : `end    ${new Date(p.t1).toLocaleString()}\n`
                 + `length ${hms(p.dur / 1000)}\n`)
             + 'drag to move · hold Shift to disable snapping',
      },
        el('span.upbar-n', {}, String(i + 1)),
        el('span.upbar-t', {},
          el('b', {}, p.item.name),
          el('i', {}, p.trimmed ? `✂ ${durTxt}` : durTxt)));
      bar.addEventListener('pointerdown', (e) => startDrag(e, p, L, bar, track));
      /* İmleç çubuğun neresindeyse kaynağın o anındaki kareyi gösteriyoruz —
         "hangi kısmı kırpıyorum / neyi çakıştırıyorum" sorusunun tek doğru
         cevabı görüntünün kendisi. */
      if (!p.est) {
        bar.addEventListener('pointermove', (ev) => {
          if (ev.buttons) return;                 // sürükleme sırasında rahat bırak
          const r = bar.getBoundingClientRect();
          const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1)));
          const srcSec = ((p.item.trimIn || 0) + f * p.dur) / 1000;
          showThumb(p.item, srcSec, ev.clientX, r.top);
        });
        bar.addEventListener('pointerleave', hideThumb);
      }
      /* Kenar tutamakları: sol = baştan kırp, sağ = sondan kırp. Süresi
         bilinmeyen parçada kırpma anlamsız (neyi keseceğimizi bilmiyoruz). */
      if (!p.est) {
        for (const side of ['l', 'r']) {
          const h = el('div.uptrim', { class: side });
          h.addEventListener('pointerdown',
            (e) => startTrim(e, p, L, side, track));
          bar.append(h);
        }
      }
      track.append(bar);
    });
    for (const o of L.overlaps) {
      track.append(el('div.upover', {
        style: { left: pctOf(o.t0) + '%',
                 width: Math.max(0.6, pctOf(o.t1) - pctOf(o.t0)) + '%' },
        title: `Overlap ${hms((o.t1 - o.t0) / 1000)} — trimmed from ${o.b.name}`,
      }));
    }

    /* --- VLM pencereleri, DOĞRUDAN çubukların üzerinde --------------------
       Ayrı bir şerit yerine burada gösteriyoruz: parlak yeşil boyanan her
       aralık gerçekten analiz edilecek görüntü, gerisine hiç bakılmayacak.
       Kullanıcı klipleri sürükleyip kırparken önemli anı bu bantların altına
       getirmeye çalışıyor — bakması gereken tek yer burası.

       Eşleme duvar saatinden DEĞİL birleşik konumdan yapılıyor: boşluklar
       concat'te düştüğü için bir klibin birleşik videodaki yeri duvar
       saatiyle aynı olmak zorunda değil. `mergedLayout` her klip için
       birleşik başlangıcı (`at`) ve çakışmadan atılan başı (`overlapCut`)
       veriyor; aradaki dönüşüm doğrusal. */
    const ML = mergedLayout(UP.items);
    const rowOf = new Map(ML.rows.map((r) => [r.item, r]));
    const wins = vlmWindows(ML.total, UP.vlmInterval, UP.vlmWindow);
    let seenMs = 0;
    for (const p of L.parts) {
      const r = rowOf.get(p.item);
      if (!r) continue;
      // birleşik konum m → duvar saati t
      const toWall = (m) => p.t0 + r.overlapCut + (m - r.at);
      for (const w of wins) {
        const a = Math.max(r.at, w.t0);
        const b = Math.min(r.end, w.t1);
        if (b - a <= 0) continue;
        seenMs += b - a;
        track.append(el('div.upseen', {
          style: { left: pctOf(toWall(a)) + '%',
                   width: (pctOf(toWall(b)) - pctOf(toWall(a))) + '%' },
          title: `Analyzed by the VLM\nmerged ${hms(a / 1000)} – ${hms(b / 1000)}`,
        }));
      }
    }
    const blind = ML.rows.filter((r) => coveredMs(r, wins) === 0);

    /* Zaman çizgisinin kendisi de bırakma alanı — dosyayı doğrudan buraya
       sürükleyip bırakabilmek için. */
    track.addEventListener('dragover', (e) => {
      e.preventDefault(); track.classList.add('over');
    });
    track.addEventListener('dragleave', () => track.classList.remove('over'));
    track.addEventListener('drop', (e) => {
      e.preventDefault(); track.classList.remove('over');
      addFiles([...e.dataTransfer.files].filter((f) => f.size > 0));
    });

    /* --- duvar saati cetveli: eşit aralıklı, okunur adımlarla ------------- */
    const ruler = el('div.uprule');
    const step = niceStep(dSpan);
    const first = Math.ceil(d0 / step) * step;
    for (let t = first; t <= d0 + dSpan; t += step) {
      const pc = pctOf(t);
      if (pc < 1 || pc > 99) continue;
      ruler.append(el('div.uptick', { style: { left: pc + '%' } },
        el('span', {}, new Date(t).toLocaleTimeString())));
    }

    tlBox.append(
      el('div.uptime', {},
        el('span', {}, new Date(L.t0).toLocaleString()),
        el('span.grow'),
        el('span', { class: 'muted' },
          `${L.parts.length} clips · ${hms(ML.total / 1000)} merged`),
        el('span.grow'),
        el('span', {}, new Date(L.t1).toLocaleString())),
      ruler, track,
      el('div.uprule-lbl', {},
        el('span.upseen-key', {}),
        ` bright = analyzed by the VLM (${UP.vlmWindow}s every `
        + `${UP.vlmInterval}s of merged video) · everything else is skipped`,
        el('span.grow'),
        el('span', { style: { color: seenMs ? 'var(--ok)' : 'var(--tx-3)' } },
          `${hms(seenMs / 1000)} analyzed`),
        blind.length ? el('span', {
          style: { color: '#f87171', marginLeft: '8px', fontWeight: 700 },
          title: blind.map((r) => r.item.name).join(', '),
        }, `· ${blind.length} clip(s) never analyzed`) : null));

    drawInfo(L);
  }

  /* ---- kenar tutamağıyla kırpma ------------------------------------------
     Sol tutamak parçanın BAŞINI kırpar: hem `trimIn` artar hem `startAt`
     aynı miktarda ilerler — böylece görüntünün duvar saatiyle hizası bozulmaz
     (kırpılan kısım zaten o saatlerde geçen görüntüydü).
     Sağ tutamak yalnızca `trimOut`'u kısar, başlangıç saati değişmez. */
  function startTrim(e, part, L, side, track) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();               // gövde sürüklemesi tetiklenmesin
    const it = part.item;
    UP.sel = UP.items.indexOf(it);
    it.auto = false;                   // elle kırpılan parça çapa olur

    const rect = track.getBoundingClientRect();
    const pad = (L.span || 60000) * 0.04;
    const msPerPx = (L.span + pad * 2) / (rect.width || 1);
    const x0 = e.clientX;
    const full = it.durationMs;
    const in0 = it.trimIn || 0;
    const out0 = it.trimOut == null ? full : it.trimOut;
    const start0 = it.startAt.getTime();
    const MIN = 200;                   // en az 0,2 sn kalsın

    e.currentTarget.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const d = Math.round((ev.clientX - x0) * msPerPx / 100) * 100;
      if (side === 'l') {
        const ni = Math.max(0, Math.min(in0 + d, out0 - MIN));
        it.trimIn = ni;
        it.startAt = new Date(start0 + (ni - in0));
      } else {
        it.trimOut = Math.min(full, Math.max(out0 + d, in0 + MIN));
      }
      drawTimeline();
      mount(infoBox, el('span', { class: 'updrag-info' },
        `${it.name} · using ${hms((it.trimIn || 0) / 1000)}`
        + ` → ${hms((it.trimOut == null ? full : it.trimOut) / 1000)}`
        + ` of ${hms(full / 1000)}  (${hms(effDur(it) / 1000)})`));
      // kesim noktasındaki kareyi göster — kırpmanın nereye denk geldiğini
      // sayıdan değil görüntüden anlamak gerekiyor
      const edgeMs = side === 'l'
        ? (it.trimIn || 0)
        : (it.trimOut == null ? full : it.trimOut);
      showThumb(it, edgeMs / 1000, ev.clientX, rect.top);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (it.trimIn === 0) delete it.trimIn;
      if (it.trimOut === full) it.trimOut = null;
      hideThumb();
      chainAuto();          // uzunluk değişti — sonraki otomatik klipler kaysın
      redraw();
      saveStart(it);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---- çubuğu sürükleyerek başlangıç saatini değiştirme ------------------ */

  /**
   * Sürükleme boyunca ÖLÇEK DONDURULUR: `L` ve piksel/ms oranı pointerdown
   * anında hesaplanıp sabit tutulur. Yoksa parça kaydıkça `layoutUpload()`
   * yeni bir `t0`/`span` üretir, çizim yeniden ölçeklenir ve çubuk imlecin
   * altından kaçar.
   */
  function startDrag(e, part, L, bar, track) {
    if (e.button !== 0) return;
    e.preventDefault();
    const it = part.item;
    const dur = part.dur;              // tahmini olabilir (bkz. layoutUpload)
    UP.sel = UP.items.indexOf(it);
    drawList(); drawSide();

    const rect = track.getBoundingClientRect();
    const pad = (L.span || 60000) * 0.04;
    const msPerPx = (L.span + pad * 2) / (rect.width || 1);
    const x0 = e.clientX;
    const orig = it.startAt.getTime();
    const leftPct = parseFloat(bar.style.left);

    // Yapışma hedefleri: diğer parçaların başı ve sonu (kendisi hariç)
    const snaps = L.parts.filter((p) => p.item !== it)
      .flatMap((p) => [p.t0, p.t1]);
    const snapMs = msPerPx * 8;          // 8 piksellik yakalama alanı

    bar.classList.add('drag');
    bar.setPointerCapture(e.pointerId);

    let next = orig;

    const move = (ev) => {
      let t = orig + (ev.clientX - x0) * msPerPx;
      let snapped = false;
      if (!ev.shiftKey) {                // Shift basılıysa serbest sürükleme
        for (const s of snaps) {
          if (Math.abs(t - s) < snapMs) { t = s; snapped = true; break; }
          const end = t + dur;
          if (Math.abs(end - s) < snapMs) { t = s - dur; snapped = true; break; }
        }
      }
      next = Math.round(t / 1000) * 1000;   // saniyeye yuvarla
      bar.classList.toggle('snap', snapped);
      bar.style.left = (leftPct + (next - orig) / msPerPx / rect.width * 100) + '%';

      const delta = (next - orig) / 1000;
      mount(infoBox, el('span', { class: 'updrag-info' },
        `${it.name} → ${new Date(next).toLocaleString()}`
        + (part.est ? ' … ?'
          : ` … ${new Date(next + dur).toLocaleTimeString()}`)
        + `  (${delta >= 0 ? '+' : '−'}${hms(Math.abs(delta))})`
        + (snapped ? '  ⟵ snapped' : '')));
    };

    const up = async () => {
      bar.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      bar.classList.remove('drag', 'snap');
      if (next === orig) { redraw(); return; }
      it.auto = false;           // elle konumlandırılan parça çapa olur
      it.startAt = new Date(next);
      redraw();
      await saveStart(it);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * Başlangıç saatini backend'e yazar — ama yalnızca dosya yüklenmişse.
   * Henüz yüklenmemiş parçalarda saat sadece bellekte durur ve upload
   * sırasında `start_at` alanı olarak gider (doUpload → api.upload).
   */
  async function saveStart(it) {
    if (!live || !it.videoId || it.state !== 'done') return;
    try {
      await api.updateVideo(it.videoId, { start_at: it.startAt.toISOString() });
      toast(`${it.name} · start time saved`, 'ok', 2200);
    } catch (err) {
      toast(`${it.name}: could not save — ${err.message}`, 'err', 6000);
    }
  }

  function drawList() {
    mount(listBox, UP.items.map((it, i) => {
      const st = { pending: 'Waiting', uploading: 'Uploading', done: 'Done',
                   error: 'Failed' }[it.state] || it.state;
      return el('div.uprow', {
        class: UP.sel === i ? 'on' : '',
        onclick: () => { UP.sel = i; redraw(); },
      },
        el('span', { class: 'mono tiny', style: { width: '22px' } }, String(i + 1)),
        el('span', { style: { flex: 1, overflow: 'hidden',
                              textOverflow: 'ellipsis' } }, it.name),
        el('span', { class: 'tiny muted mono' },
          it.durationMs ? hms(it.durationMs / 1000) : '—'),
        el('span', { class: 'tiny muted' }, bytes(it.file.size / 1048576)),
        it.state === 'uploading'
          ? el('div.progline', { style: { width: '80px' } },
            el('i', { style: { width: Math.round(it.progress * 100) + '%' } }))
          : el('span', {
            class: 'tiny',
            style: { color: it.state === 'done' ? 'var(--ok)'
                   : it.state === 'error' ? '#f87171' : 'var(--tx-2)' },
          }, st),
        el('button.iconbtn', {
          title: 'Remove',
          onclick: (e) => {
            e.stopPropagation();
            UP.items.splice(i, 1);
            UP.sel = Math.max(0, Math.min(UP.sel, UP.items.length - 1));
            redraw();
          },
        }, '×'));
    }));
  }

  function drawSide() {
    const it = UP.items[UP.sel];
    mount(sideBox,
      el('div', { style: { fontWeight: 700, fontSize: '15px' } }, 'Clip settings'),
      !it ? el('div', { class: 'tiny muted' }, 'Select a clip') : el('div', {
        style: { display: 'grid', gap: '10px' },
      },
        el('div', { class: 'tiny muted' }, it.name),

        el('div', {},
          el('div', { class: 'flabel' }, 'Start time'),
          el('input.input', {
            type: 'datetime-local', step: '1',
            value: toLocalInput(it.startAt),
            onchange: (e) => {
              it.auto = false;
              it.startAt = e.target.value ? new Date(e.target.value) : null;
              redraw();
              if (it.startAt) saveStart(it);
            },
          }),
          /* Bir öncekinin bittiği ana yapıştır — VMS kayıtları kesintisizse
             tek tıkla zinciri kurar. */
          UP.sel > 0 ? el('button.btn.sm.ghost', {
            style: { marginTop: '4px' },
            onclick: () => {
              const prev = UP.items[UP.sel - 1];
              if (!prev || !prev.startAt || !prev.durationMs) {
                return toast('Previous clip length is unknown', 'warn');
              }
              it.startAt = new Date(prev.startAt.getTime() + prev.durationMs);
              redraw();
              saveStart(it);
            },
          }, '⇥ Snap to end of previous clip') : null,
          el('div', { class: 'tiny muted', style: { marginTop: '4px' } },
            it.durationMs && it.startAt
              ? `Ends ${new Date(it.startAt.getTime() + it.durationMs)
                  .toLocaleString()}`
              : 'Length is confirmed after upload')),

        /* Kırpma — "kaynağın kaçıncı saniyesinden kaçıncı saniyesine".
           Çakışmayı elle ayarlamanın kesin yolu bu; kenar tutamakları kaba
           ayar, buradaki sayılar hassas ayar. */
        it.durationMs ? el('div', {},
          el('div', { class: 'flabel' }, 'Use range of source (seconds)'),
          el('div.row', { style: { gap: '6px', alignItems: 'center' } },
            el('input.input', {
              type: 'number', min: 0, step: 0.1,
              max: (it.durationMs / 1000).toFixed(1),
              value: ((it.trimIn || 0) / 1000).toFixed(1),
              style: { width: '78px' },
              onchange: (e) => {
                const out = it.trimOut == null ? it.durationMs : it.trimOut;
                const v = Math.max(0, Math.min(+e.target.value * 1000, out - 200));
                it.auto = false;
                // başı kırparken başlangıç saatini de kaydır (bkz. startTrim)
                it.startAt = new Date(it.startAt.getTime() + (v - (it.trimIn || 0)));
                it.trimIn = v || 0;
                redraw(); saveStart(it);
              },
            }),
            el('span', { class: 'tiny muted' }, '→'),
            el('input.input', {
              type: 'number', min: 0, step: 0.1,
              max: (it.durationMs / 1000).toFixed(1),
              value: ((it.trimOut == null ? it.durationMs : it.trimOut) / 1000)
                .toFixed(1),
              style: { width: '78px' },
              onchange: (e) => {
                const v = Math.min(it.durationMs,
                  Math.max(+e.target.value * 1000, (it.trimIn || 0) + 200));
                it.auto = false;
                it.trimOut = v >= it.durationMs ? null : v;
                redraw();
              },
            }),
            isTrimmed(it) ? el('button.btn.sm.ghost', {
              title: 'Use the whole file',
              onclick: () => {
                it.auto = false;
                it.startAt = new Date(it.startAt.getTime() - (it.trimIn || 0));
                delete it.trimIn; it.trimOut = null;
                redraw(); saveStart(it);
              },
            }, '↺') : null),
          el('div', { class: 'tiny muted', style: { marginTop: '4px' } },
            `source ${hms(it.durationMs / 1000)}`
            + (isTrimmed(it) ? ` · using ${hms(effDur(it) / 1000)}` : ' · full'))) : null,

        el('div', {},
          el('div', { class: 'flabel' }, 'Metadata'),
          el('textarea.input', {
            rows: 8, placeholder: 'Free text (description, conditions, notes…)',
            style: { resize: 'vertical', fontFamily: 'inherit' },
            value: it.meta || '',
            oninput: (e) => { it.meta = e.target.value; },
          })),

        it.videoId ? el('div', { class: 'tiny muted mono' },
          `video_id ${it.videoId}`) : null));
  }

  function redraw() { drawTimeline(); drawList(); drawSide(); drawMergeNote(); }

  /* ---- dosya ekleme ----------------------------------------------------- */

  /**
   * Parçaları uç uca dizer: boşluk da çakışma da kalmaz.
   *
   * Sıra MEVCUT başlangıç saatlerine göre belirlenir; yani kullanıcı çubukları
   * sürükleyerek bir sıra kurduysa o sıra korunur, sadece aralar kapatılır.
   * İlk parçanın başlangıcı sabit kalır — kullanıcının girdiği gerçek kayıt
   * saati bu, onu kaydırmak veriyi bozar.
   */
  function arrangeSequential() {
    if (!UP.items.length) return;
    const idx = new Map(UP.items.map((it, i) => [it, i]));
    UP.items.sort((a, b) => {
      const ta = a.startAt ? a.startAt.getTime() : Infinity;
      const tb = b.startAt ? b.startAt.getTime() : Infinity;
      return ta - tb || idx.get(a) - idx.get(b);
    });
    let t = UP.items[0].startAt ? UP.items[0].startAt.getTime() : Date.now();
    for (const it of UP.items) {
      it.startAt = new Date(t);
      it.auto = true;           // hepsi yeniden otomatik yerleşime döndü
      t += effDur(it);          // kırpılmışsa kırpılmış süre kadar ilerle
    }
    UP.sel = Math.min(UP.sel, UP.items.length - 1);
  }

  /**
   * OTOMATİK yerleşimdeki parçaları bir öncekinin bitişine zincirler.
   * Elle konumlandırılmış (`auto === false`) parçalara DOKUNMAZ — onlar
   * çapa görevi görür, sonrakiler onların ardına dizilir.
   *
   * Neden gerekli: dosya süreleri `probeDurationMs()` ile sonradan geliyor.
   * Ekleme anında uzunluk bilinmediği için ilk yerleşim tahminî oluyor;
   * gerçek süre gelince buranın yeniden koşması şart, yoksa parçalar
   * birbirinden 10 dakika uzakta duruyor.
   */
  function chainAuto() {
    for (let i = 1; i < UP.items.length; i++) {
      const prev = UP.items[i - 1];
      const it = UP.items[i];
      if (it.auto === false || !prev.startAt) continue;
      it.startAt = new Date(prev.startAt.getTime() + effDur(prev));
    }
  }

  /**
   * Çakışmaları KIRPARAK çözer: iki parça aynı zaman aralığını kapsıyorsa
   * sonrakinin BAŞI o kadar kırpılır ve başlangıcı öne alınır, böylece uç uca
   * otururlar. Aynı görüntü iki kez analiz edilmemiş olur.
   *
   * Neden sonrakinin başı: öncekinin kuyruğunu kesmek, kullanıcının o parça
   * için girdiği kayıt saatini geçersiz kılardı. Sonrakini kırpınca yalnızca
   * "bu kaydın ilk N saniyesi zaten diğerinde var" demiş oluyoruz.
   */
  function trimOverlaps() {
    const parts = [...UP.items].filter((i) => i.startAt && i.durationMs)
      .sort((a, b) => a.startAt - b.startAt);
    let fixed = 0, dropped = 0;
    let cursor = null;
    for (const it of parts) {
      const t0 = it.startAt.getTime();
      if (cursor != null && t0 < cursor) {
        const over = cursor - t0;
        const avail = effDur(it);
        if (over >= avail) {
          // parça tamamen bir öncekinin içinde kalıyor — kırpacak bir şey yok
          dropped++;
          cursor = Math.max(cursor, t0 + effDur(it));
          continue;
        }
        it.trimIn = (it.trimIn || 0) + over;
        it.startAt = new Date(cursor);
        fixed++;
      }
      cursor = it.startAt.getTime() + effDur(it);
    }
    return { fixed, dropped };
  }

  async function addFiles(files) {
    for (const f of files) {
      const it = {
        key: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file: f, name: f.name.replace(/\.[^.]+$/, ''),
        startAt: null, durationMs: null, videoId: null,
        state: 'pending', progress: 0, meta: '',
      };
      /* HER parçaya mutlaka bir başlangıç ver: son parçanın bittiği ana.
         `layoutUpload` startAt'i olmayanı elediği için, bu atlanınca parça
         zaman çizgisinde hiç görünmüyor. Eskiden yalnızca ilk parça saat
         alıyordu ve bir kez sürükleme yapıldıysa (otomatik dizilim kapanınca)
         2., 3., 4. dosyalar sessizce kayboluyordu — "Clear'dan sonra tek
         video görünüyor" hatası buydu. */
      const last = UP.items[UP.items.length - 1];
      it.auto = true;                    // yeni parça otomatik yerleşimde
      it.startAt = last && last.startAt
        ? new Date(last.startAt.getTime() + effDur(last))
        : new Date();
      UP.items.push(it);
      chainAuto();
      redraw();
      // MP4 ise süreyi hemen okuyabiliriz; AVI/mpeg4'te null döner
      probeDurationMs(f).then((ms) => {
        if (ms && !it.durationMs) {
          it.durationMs = ms;
          // gerçek süre gelince zincir tazelensin — tahminle açılan
          // aralıklar kapanır, elle konumlandırılanlar yerinde kalır
          chainAuto();
          redraw();
        }
      });
    }
  }

  /* ---- yükleme ---------------------------------------------------------- */

  /**
   * Birleştirmeli yükleme: parçalar sunucuya tek tek gider, ffmpeg orada
   * TEK bir MP4 üretir, sonuç doğrudan backend'e akıtılır. Birleşik dosya
   * tarayıcıya hiç dönmez.
   *
   * Sıra zaman çizgisindeki başlangıç saatine göre — kullanıcı çubukları
   * sürükleyerek belirlediği sıra neyse birleşim de o sırayla olur.
   */
  async function doMergeUpload() {
    const todo = UP.items.filter((i) => i.state === 'pending');
    if (!todo.length) return toast('No new files to upload', 'warn');
    if (!UP.collName.trim()) return toast('Enter a collection name', 'warn');
    if (todo.length !== UP.items.length) {
      return toast('Merge processes all files at once — clear the list and '
        + 'add them again', 'warn', 6000);
    }

    /* Sıra ve kesim noktaları TEK KAYNAKTAN: ekranda gördüğün birleşik şerit
       ne diyorsa ffmpeg'e giden de o. Burada ayrıca hesaplamak, iki yerin
       birbirinden ayrı düşmesi demekti (çakışma tam olarak öyle kaçmıştı). */
    const ML = mergedLayout(UP.items);
    const ordered = ML.rows.map((r) => r.item);
    const startAt = ordered[0].startAt || null;

    /* Boşluklar concat'te düşer: 09:00'da biten parçadan sonra 09:05'te
       başlayan parça birleşik videoda hemen ardından gelir. Sessizce
       yapmıyoruz — olay saatleri kayacağı için kullanıcı bilmeli. */
    const L = layoutUpload(UP.items);
    if (L && L.gapMs > 0) {
      const ok = await confirmModal('Merging will drop the gaps',
        `The timeline has ${hms(L.gapMs / 1000)} of gaps. `
        + 'In the merged video those gaps are removed and the clips run '
        + 'back to back, so event wall-clock times will no longer match '
        + 'reality. Continue?');
      if (!ok) return;
    }

    let mid = null;
    try {
      mid = (await api.mergeCreate()).merge_id;

      for (let i = 0; i < ordered.length; i++) {
        const it = ordered[i];
        it.state = 'uploading'; it.progress = 0; drawList();
        await api.mergePart(mid, i, it.file, (p) => {
          it.progress = p; drawList();
        });
        it.state = 'done'; drawList();
      }

      toast('Merging… (ffmpeg — may take a few minutes for large files)',
        'ok', 8000);
      /* Kesim noktaları birleşik yerleşimden — `inMs` çakışma kırpmasını da
         içeriyor, yani üstteki rayda kırmızı görünen aralık gerçekten
         atılıyor. Index'ler yükleme sırasıyla aynı (ordered = ML.rows). */
      const trims = ML.rows.map((r, i) => ({
        index: i,
        in_ms: Math.round(r.inMs),
        out_ms: Math.round(r.outMs),
      })).filter((t, i) => t.in_ms > 0
        || t.out_ms < Math.round(ML.rows[i].item.durationMs || Infinity));
      const meta = await api.mergeBuild(mid, trims);
      for (const w of meta.warnings || []) toast(w, 'warn', 7000);

      if (!UP.groupId) {
        const g = await api.createGroup(UP.collName.trim());
        UP.groupId = g.id;
      }
      const key = `merged-${Date.now()}`;
      const res = await api.reserve(UP.groupId, [key]);
      const videoId = res[0].video_id;

      const v = await api.mergeUpload(mid, {
        video_id: videoId,
        name: UP.collName.trim(),
        description: UP.items.map((i) => i.meta).filter(Boolean).join('\n'),
        start_at: startAt ? startAt.toISOString() : null,
        filename: `${UP.collName.trim() || 'merged'}.mp4`,
      });

      UP.mergedId = videoId;
      for (const it of UP.items) { it.videoId = videoId; it.state = 'done'; }
      const durMs = (v && v.duration_ms) || meta.duration_ms || 0;
      toast(`Merged ${meta.part_count} clips → video ${videoId}`
        + ` · ${hms(durMs / 1000)} · ${meta.mode === 'copy'
          ? 'lossless copy' : 're-encoded'} in ${meta.elapsed_sec}s`,
        'ok', 8000);

      // backend ffprobe'u bitirene kadar bekle, sonra ağacı çiz
      await waitForVideoReady(videoId);
      mount(sidebar, treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
      redraw();
    } catch (e) {
      for (const it of UP.items) if (it.state === 'uploading') it.state = 'error';
      redraw();
      toast('Merge failed: ' + e.message, 'err', 8000);
    } finally {
      if (mid) api.mergeDrop(mid);
    }
  }

  async function doUpload() {
    if (!live) return toast('Upload only works in LIVE mode', 'warn');
    if (UP.merge) return doMergeUpload();
    const todo = UP.items.filter((i) => i.state === 'pending');
    if (!todo.length) return toast('No new files to upload', 'warn');
    if (!UP.collName.trim()) return toast('Enter a collection name', 'warn');

    try {
      if (!UP.groupId) {
        const g = await api.createGroup(UP.collName.trim());
        UP.groupId = g.id;
        toast(`Group created · id ${g.id}`, 'ok');
      }
      const res = await api.reserve(UP.groupId, todo.map((i) => i.key));
      const byKey = new Map(res.map((r) => [r.client_key, r]));

      for (const it of todo) {
        const r = byKey.get(it.key);
        if (!r) { it.state = 'error'; continue; }
        it.videoId = r.video_id;
        it.state = 'uploading'; it.progress = 0; redraw();
        try {
          const v = await api.upload(r.video_id, it.file, {
            name: it.name,
            description: it.meta,
            start_at: it.startAt ? it.startAt.toISOString() : null,
            is_ptz: false,
          }, (p) => { it.progress = p; drawList(); });
          it.state = 'done';
          // Süreyi backend ffprobe ile okudu — AVI dahil her formatta gelir
          if (v && v.duration_ms) it.durationMs = v.duration_ms;
          redraw();
        } catch (e) {
          it.state = 'error'; it.error = e.message; redraw();
          toast(`${it.name}: ${e.message}`, 'err', 6000);
        }
      }
      toast('Upload complete', 'ok');
      // yeni grup sol ağaçta ve Analysis ekranında hemen görünsün
      const lastId = todo[todo.length - 1].videoId;
      if (lastId) await waitForVideoReady(lastId); else await refreshGroups();
      mount(sidebar, treePanel(null, (c) => { location.hash = `#/single/${c.id}`; }));
    } catch (e) {
      toast('Upload failed: ' + e.message, 'err', 6000);
    }
  }

  async function doAnalyze() {
    /* Birleştirilmişse tek bir video_id var — her parça için ayrı ayrı
       analiz kuyruğa almak 409 yağmuru üretirdi. */
    const ready = UP.mergedId
      ? [{ videoId: UP.mergedId, name: UP.collName.trim() || 'merged' }]
      : UP.items.filter((i) => i.state === 'done' && i.videoId);
    if (!ready.length) return toast('Upload the files first', 'warn');
    let queued = 0;
    const clash = [];
    for (const it of ready) {
      try { await api.analyze(it.videoId, {}); queued++; } catch (e) {
        // 409 = bu video için iptal edilmemiş bir kayıt zaten var
        // (succeeded dahil). Sessizce başarı saymak yanıltıcı olur.
        if (e.status === 409) clash.push(it);
        else toast(`${it.name}: ${e.message}`, 'err', 6000);
      }
    }
    if (queued) toast(`${queued} job(s) queued`, 'ok');
    if (clash.length) askReanalyze(clash.map((i) => i.videoId),
      clash.map((i) => i.name));
    queueTick();
  }

  /* ---- iskelet ---------------------------------------------------------- */

  const fileInput = el('input', {
    type: 'file', accept: 'video/*,.avi,.mp4,.mkv,.mov', multiple: true,
    style: { display: 'none' },
    onchange: (e) => { addFiles([...e.target.files]); e.target.value = ''; },
  });

  const drop = el('div.updrop', {
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault(); drop.classList.remove('over');
      addFiles([...e.dataTransfer.files].filter((f) => f.size > 0));
    },
    onclick: () => fileInput.click(),
  },
    el('div', { style: { fontSize: '22px' } }, '⬇'),
    el('div', {}, 'Drop video files here'),
    el('div', { class: 'tiny muted' }, 'or click to browse · multiple files supported'));

  mount(stage,
    el('div.panel', {},
      el('div.panel-h', {}, 'Upload & Analysis', el('span.grow'),
        !live ? el('span', { class: 'tiny', style: { color: '#fbbf24' } },
          'MOCK mode — upload only works in LIVE') : null),
      el('div.panel-b', { style: { display: 'grid', gap: '12px' } },
        el('div.row', { style: { gap: '8px' } },
          el('span', { class: 'tiny muted', style: { width: '110px' } },
            'Collection Name'),
          el('input.input', {
            placeholder: 'e.g. Gwangmyeong Stn · 2026-08-13',
            value: UP.collName,
            oninput: (e) => { UP.collName = e.target.value; },
          }),
          el('button.btn.sm', { onclick: () => fileInput.click() }, '+ Add files'),
          /* Sürükleyerek bozulan sırayı tek tıkla toparlar; otomatik dizilim
             kapandıysa yeniden açar. */
          el('button.btn.sm.ghost', {
            title: 'Lay all clips end to end, removing gaps and overlaps',
            onclick: () => {
              if (!UP.items.length) return toast('No files yet', 'warn');
              arrangeSequential();
              redraw();
              toast('Clips arranged end to end', 'ok', 2000);
            },
          }, '⇥ Auto arrange'),
          el('button.btn.sm.ghost', {
            title: 'Resolve overlaps by trimming the head of the later clip',
            onclick: () => {
              const L = layoutUpload(UP.items);
              if (!L || !L.overlapMs) return toast('No overlaps', 'ok', 1800);
              const { fixed, dropped } = trimOverlaps();
              redraw();
              toast(`Trimmed ${fixed} clip(s)`
                + (dropped ? ` · ${dropped} fully covered, left as is` : ''),
                'ok', 3500);
            },
          }, '✂ Trim overlaps'),
          fileInput),

        /* Örnekleme penceresi BACKEND ayarı — buradan değiştirilemiyor,
           yalnızca zaman çizgisindeki yeşil bantları doğru çizebilmek için
           biliniyor. Backend değeri değişirse buradan güncellenir. */
        el('div.row', { style: { gap: '8px', alignItems: 'center' } },
          el('span', { class: 'tiny muted' },
            'VLM sampling (backend setting)'),
          el('input.input', {
            type: 'number', min: 1, step: 1, value: UP.vlmWindow,
            style: { width: '62px' },
            title: 'Window length the VLM looks at (vlm_segment_duration_seconds)',
            onchange: (e) => {
              UP.vlmWindow = Math.max(1, +e.target.value || 10);
              localStorage.setItem('up.vlmWindow', UP.vlmWindow);
              redraw();
            },
          }),
          el('span', { class: 'tiny muted' }, 's every'),
          el('input.input', {
            type: 'number', min: 1, step: 1, value: UP.vlmInterval,
            style: { width: '62px' },
            title: 'Sampling interval (vlm_segment_interval_seconds)',
            onchange: (e) => {
              UP.vlmInterval = Math.max(1, +e.target.value || 60);
              localStorage.setItem('up.vlmInterval', UP.vlmInterval);
              redraw();
            },
          }),
          el('span', { class: 'tiny muted' }, 's')),

        /* Birleştirme kipi. Varsayılan AÇIK: kullanıcı Upload ekranında
           parçaları tek bir zaman çizgisine dizdiğinde beklentisi tek bir
           kayıt elde etmek. Kapatılırsa her parça ayrı video_id alır. */
        el('div.row', { style: { gap: '8px', alignItems: 'flex-start' } },
          el('label', { class: 'row', style: { gap: '6px', cursor: 'pointer' } },
            el('input', {
              type: 'checkbox', checked: UP.merge,
              onchange: (e) => { UP.merge = e.target.checked; drawMergeNote(); },
            }),
            el('span', {}, 'Merge into a single video')),
          mergeNote),

        tlBox,
        infoBox,
        drop,
        listBox,

        el('div.row', { style: { gap: '8px' } },
          el('button.btn', { onclick: doUpload }, '⬆ Upload'),
          el('button.btn.ghost', { onclick: doAnalyze }, '▶ Run analysis'),
          el('span.grow'),
          el('button.btn.sm.ghost', {
            onclick: () => {
              UP.items = []; UP.groupId = null; UP.sel = 0;
              UP.mergedId = null;
              releaseThumbs();
              redraw();
            },
          }, 'Clear')))),
    // İş yönetimi ayrı bir sekme değil — burada, kendiliğinden tazelenerek
    el('div.panel', { style: { marginTop: '12px' } },
      el('div.panel-h', {}, 'Analysis queue',
        el('span.grow'),
        el('span', { class: 'tiny muted', id: 'qnote' }, '')),
      el('div.panel-b', { id: 'queuebox' },
        el('div', { class: 'tiny muted' }, 'loading…'))));

  /* ---- kuyruk şeridi: devam eden iş varken 3 sn'de bir tazelenir -------- */
  let qAlive = true;
  onLeave(() => { qAlive = false; });

  async function queueTick() {
    if (!qAlive) return;
    const box = document.getElementById('queuebox');
    if (!box) return;
    let rows = [];
    try { rows = (await api.jobs()).items; } catch { /* geçici */ }
    const vids = store.get('groups').flatMap((g) => g.cameras || []);
    const nameOf = (id) => (vids.find((v) => String(v.id) === String(id))
      || {}).name || `video ${id}`;
    const COLOR = { completed: 'var(--ok)', running: 'var(--busy)',
                    failed: '#f87171', queued: 'var(--tx-2)',
                    canceled: 'var(--tx-2)' };

    mount(box, rows.length ? rows.slice(0, 12).map((j) => el('div.row', {
      style: { gap: '10px', padding: '4px 0' },
    },
      el('span', { class: 'mono tiny', style: { width: '46px' } }, j.job_id),
      el('span', { style: { flex: 1 } }, nameOf(j.video_id)),
      j.status === 'running'
        ? el('div.progline', { style: { width: '110px' } },
          el('i', { class: 'indet' }))
        : el('span', { class: 'tiny muted' },
          j.duration_sec ? `${j.duration_sec}s` : ''),
      el('span', {
        class: 'tiny', style: { color: COLOR[j.status] || 'var(--tx-1)',
                                fontWeight: 700, width: '80px' },
      }, j.status),
      j.error ? el('button.btn.sm.ghost', {
        onclick: () => modal({ title: 'Error · ' + j.job_id,
                               body: el('div.codeblock', {}, j.error) }),
      }, 'error') : null))
      : el('div', { class: 'tiny muted' }, 'no analysis jobs yet'));

    const busy = rows.some((j) => j.status === 'running' || j.status === 'queued');
    const note = document.getElementById('qnote');
    if (note) note.textContent = busy ? 'auto-refreshing…' : '';
    if (qAlive) setTimeout(queueTick, busy ? 3000 : 10000);
  }
  queueTick();

  mount(side, sideBox);
  redraw();
}

/* ==========================================================================
   Ekran: API 계약
   ========================================================================== */

async function screenApi() {
  const spec = await api.openapi();
  const rows = Object.entries(spec.paths).map(([k, v]) => {
    const [m, ...rest] = k.split(/\s+/);
    return el('div.apirow', {},
      el('code', {}, el('span', { class: 'm m-' + m.replace('|', '') }, m), ' ',
        rest.join(' ')),
      el('span', { class: 'dim' }, v));
  });
  mount(ROOT(), topbar('api'),
    el('div.main', {},
      el('div.stage', { style: { padding: '10px' } },
        el('div.panel', {},
          el('div.panel-h', {}, 'API 계약 (mock 서버가 실제로 구현한 엔드포인트)',
            el('span.grow'),
            el('a', { href: '/api/openapi', target: '_blank', class: 'tiny' },
              'JSON 보기')),
          el('div.panel-b', {},
            el('div', { style: { padding: '11px' } },
              el('div', { class: 'tiny muted', style: { lineHeight: 1.8 } },
                '이 목록을 백엔드 개발자에게 그대로 전달하십시오. ',
                'FastAPI로 구현하면 /docs (Swagger UI)가 자동 생성됩니다.')),
            rows,
            el('div', { style: { padding: '14px' } },
              el('div.divider'),
              el('div', { class: 'flabel', style: { marginBottom: '8px' } }, '규약'),
              el('dl.kv', {}, Object.entries(spec.notes).flatMap(([k, v]) =>
                [el('dt', {}, k), el('dd', { style: { fontFamily: 'var(--sans)' } }, v)])),
              el('div.divider'),
              el('div', { class: 'flabel', style: { marginBottom: '8px' } },
                'BBox 메타데이터 형식 (실제 응답)'),
              el('div.codeblock', {},
                `GET /api/videos/CAM01/detections?from=10&to=11\n\n`
                + `{\n  "video_id": "CAM01",\n  "fps": 10,\n`
                + `  "coord": "normalized_xyxy",\n`
                + `  "keys": ["t","track_id","cls","conf","x1","y1","x2","y2"],\n`
                + `  "cls_map": { "0": "person", "1": "vehicle" },\n`
                + `  "count": 41,\n`
                + `  "rows": [\n`
                + `    [10.0, 1, 0, 0.897, 0.4586, 0.3037, 0.5309, 0.4759],\n`
                + `    [10.1, 1, 0, 0.876, 0.4576, 0.3033, 0.5308, 0.4776]\n`
                + `  ]\n}\n\n`
                + `※ 객체 배열이 아니라 행 배열 — 24시간 영상에서 JSON 크기가\n`
                + `  1/3로 줄어듭니다. 시간 구간으로 페이지네이션하십시오.`)))))));
}

/* ==========================================================================
   Yönlendirici
   ========================================================================== */

function findCam(id) {
  for (const g of store.get('groups'))
    for (const c of g.cameras) if (c.id === id) return { ...c, group_name: g.name };
  return null;
}

async function route() {
  runCleanup();
  const h = location.hash.slice(1) || '/single/CAM01';
  const [pathPart, queryPart] = h.split('?');
  const q = new URLSearchParams(queryPart || '');
  const p = pathPart.split('/').filter(Boolean);

  if (p[0] === 'login') return screenLogin();
  if (!store.get('user')) {
    try { store.set({ user: await api.me() }); }
    catch { location.hash = '#/login'; return; }
  }
  if (!store.get('groups').length) {
    const g = await api.groups();
    store.set({ groups: g.groups, eventTypes: g.event_types });
    store.set({ attributes: await api.attributes() });
  }

  /* Mod değişince (mock ↔ live) adres çubuğundaki id artık geçersiz olabilir:
     mock'ta CAM05, canlıda 1/2/3. Geçersiz id'de 404 fırlatıp boş ekranda
     kalmak yerine mevcut ilk kayda yönlendiriyoruz. */
  const cams = store.get('groups').flatMap((g) => g.cameras || []);
  if ((p[0] === 'single' || p[0] === 'objects') && cams.length
      && !cams.some((c) => String(c.id) === String(p[1]))) {
    location.hash = `#/${p[0]}/${cams[0].id}`;
    return;
  }
  if (p[0] === 'multi') {
    const gs = store.get('groups');
    if (gs.length && !gs.some((g) => String(g.id) === String(p[1]))) {
      location.hash = `#/multi/${gs[0].id}`;
      return;
    }
  }

  try {
    switch (p[0]) {
      case 'single': await screenSingle(p[1] || 'CAM01'); break;
      case 'multi': await screenMulti(p[1] || 'G1'); break;
      case 'objects': await screenObjects(p[1] || 'CAM01', q.get('q')); break;
      case 'home': await screenHome(); break;
      case 'upload': await screenUpload(); break;
      case 'jobs': await screenJobs(); break;
      case 'system': await screenSystem(); break;
      case 'settings': await screenSettings(); break;
      case 'api': await screenApi(); break;
      default: location.hash = '#/home';
    }
  } catch (e) {
    console.error(e);
    toast('화면 로딩 실패: ' + e.message, 'err', 6000);
    // Hata durumunda başlangıç spinner'ı ekranda kalıyordu ve sanki sonsuza
    // kadar yükleniyormuş gibi görünüyordu. Hatayı görünür kıl.
    mount(ROOT(), topbar(p[0]), el('div.main', {},
      el('div', {
        style: {
          padding: '40px', display: 'grid', placeItems: 'center',
          gap: '10px', textAlign: 'center', width: '100%',
          alignContent: 'center',
        },
      },
        el('div', { style: { fontSize: '28px' } }, '⚠'),
        el('div', { style: { color: '#fca5a5' } },
          `화면 로딩 실패 · ${API_MODE.toUpperCase()}`),
        el('div', { class: 'tiny muted' }, e.message),
        el('div', { class: 'tiny muted' }, `#${h}`))));
  }

  // çoklu kamera ekranından gelen seek isteği
  const st = sessionStorage.getItem('seekTo');
  if (st && p[0] === 'single') {
    sessionStorage.removeItem('seekTo');
    setTimeout(() => {
      const v = document.querySelector('video');
      if (v) v.currentTime = +st;
    }, 700);
  }
}

window.addEventListener('hashchange', route);

async function boot() {
  try {
    const h = await api.health();
    const s = document.getElementById('srvstat');
    if (s) {
      // Hangi veri kaynağındayız? Mock ile canlıyı karıştırmak kolay —
      // ekranda her zaman görünsün.
      s.textContent = API_MODE === 'live'
        ? `● LIVE · ${h.status || '?'}`
        : `● MOCK · ${h.gallery} vec / ${h.videos} video`;
      s.title = API_MODE === 'live'
        ? 'Live DVSummary API (/live)' : 'Local mock data';
      s.style.color = API_MODE === 'live' ? '#4ade80' : '';
    }
  } catch {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#fca5a5">'
      + 'Cannot reach the mock API server.<br><br>'
      + 'Run: <b>python server.py</b><br>'
      + 'Then open: <b>http://127.0.0.1:8000/</b></div>';
    return;
  }
  route();
}

/* core.js canlı modda dinamik import için top-level await kullanıyor; bu
   sırada DOMContentLoaded çoktan tetiklenmiş olabilir. Olay kaçtıysa
   doğrudan başlat — yoksa ekran sonsuza kadar "로딩 중…" kalır. */
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
