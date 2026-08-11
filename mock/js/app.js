/* ============================================================================
   app.js — Yönlendirici ve ekranlar
   ========================================================================= */

import {
  FEATURES,
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

const STATUS_KO = {
  registered: '등록됨', uploading: '업로드 중', ready: '분석 가능',
  analyzing: '분석 중', completed: '요약 완료', failed: '실패', deleted: '삭제됨',
};
const STATUS_TR = {
  registered: 'Kayıtlı', uploading: 'Yükleniyor', ready: 'Hazır',
  analyzing: 'Analiz ediliyor', completed: 'Tamamlandı', failed: 'Hata',
  deleted: 'Silindi',
};
const statusLabel = s => (store.get('lang') === 'tr' ? STATUS_TR : STATUS_KO)[s] || s;
const SRC_ICON = { file: '▤', rtsp: '⦿', uploaded: '↑', archive: '▣' };

/* ==========================================================================
   Kabuk
   ========================================================================== */

function topbar(active) {
  const tabs = [
    ['single', t('single'), '#/single/CAM01'],
    ['multi', t('multi'), '#/multi/G1'],
    ...(FEATURES.reid ? [['objects', t('objects'), '#/objects/CAM01']] : []),
    ['jobs', t('jobs'), '#/jobs'],
    ['system', t('system'), '#/system'],
    ['settings', t('settings'), '#/settings'],
    ['api', t('api'), '#/api'],
  ];
  const lang = store.get('lang');
  return el('div.topbar',
    el('div.brand', {}, el('span.logo', {}, '▣'),
      el('span', {}, '지능형 영상 요약 플랫폼')),
    el('nav.navtabs', {}, tabs.map(([k, label, href]) =>
      el('a', { href, class: active === k ? 'on' : '' }, label)),
      el('a', {
        href: '/lab/', title: 'Temelleri sıfırdan öğreten laboratuvar',
        style: { borderLeft: '1px solid var(--line)', marginLeft: '4px' },
      }, '🧪 Lab')),
    el('div.grow'),
    el('div.row', { class: 'tiny muted' },
      el('span', { id: 'srvstat' }, '● 연결됨')),
    el('div.seg', { style: { marginLeft: '8px' } },
      ['ko', 'tr'].map(L => el('button', {
        class: lang === L ? 'on' : '',
        onclick: () => { localStorage.setItem('lang', L); store.set({ lang: L }); route(); },
      }, L.toUpperCase()))),
    el('button.iconbtn', { title: '설정', onclick: () => location.hash = '#/settings' }, '⚙'),
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
          placeholder: '그룹 검색', oninput: (e) => filter(e.target.value),
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
            toast(c.error ? c.error : `${c.name}: ${statusLabel(c.status)} — 요약 결과가 없습니다.`,
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
    for (const d of (defs.attributes[which] || [])) {
      if (which === 'person' && f.cls === '' &&
        ['upper_type', 'lower_color', 'hat'].includes(d.key)) continue;
      const g = el('div.fgroup', {},
        el('div.flabel', {}, store.get('lang') === 'tr' ? d.label_tr : d.label_ko));
      if (d.type === 'color') {
        const sel = f[d.key] || (f[d.key] = []);
        g.append(el('div.swatches', {},
          d.values.map(v => el('button.sw', {
            class: sel.includes(v.v) ? 'on' : '',
            style: { background: v.hex },
            title: store.get('lang') === 'tr' ? v.tr : v.ko,
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
        }, store.get('lang') === 'tr' ? v.tr : v.ko))));
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
            }, store.get('lang') === 'tr' ? (v.tr || v.ko) : v.ko))));
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
      el('span', { class: 'tiny muted', title: 'PAR 모델 출력 기반' }, 'PAR')),
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
  if (!cam) { toast('영상을 찾을 수 없습니다: ' + videoId, 'err'); location.hash = '#/single/CAM01'; return; }

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
      el('span', {}, '요약 시간 범위'),
      el('b', { class: 'mono' },
        `${dateOf(video.start_time)} ${clockOf(video.start_time)} ~ ${clockOf(video.end_time)}`),
      el('span', { class: 'muted' }, '·'),
      el('span', {}, `${video.width}×${video.height} · ${video.fps}fps · ${video.codec.toUpperCase()}`),
      el('span', { class: 'muted' }, '·'),
      el('span', { title: 'node_id / channel — VMS 식별자' },
        `node ${video.node_id}/ch${video.ch}`)));

  // -------- video --------------------------------------------------------
  const vstack = el('div.vstack');
  const ovlCanvas = el('canvas', { class: 'ovl hit' });
  let videoEl = null, overlay = null;

  const vwell = el('div.vwell', {}, vstack);
  const hud = el('div.vhud', {},
    el('span.pill', {}, el('b', { id: 'hudclock' }, '--:--:--')),
    el('span.pill', { id: 'hudobj' }, 'obj 0'),
    el('span.pill', { id: 'hudsrc', title: '오리지널/요약 전환' }, '원본'));

  if (video.has_proxy) {
    videoEl = el('video', {
      src: api.streamUrl(videoId),
      poster: api.posterUrl(videoId),
      preload: 'auto', playsinline: true,
    });
    vstack.append(videoEl, ovlCanvas);
  } else {
    vstack.append(el('div.noproxy', {},
      el('div', { class: 'big' }, '⛶'),
      el('div', { class: 't' }, '재생 가능한 프록시 영상이 없습니다'),
      el('div', { class: 'tiny' },
        `이 영상(${video.duration >= 3600 ? dur(video.duration) : video.duration + 's'})은 `
        + `분석은 완료되었지만 브라우저 재생용 H.264 프록시가 생성되지 않았습니다.`),
      el('div', {
        class: 'tiny', style: {
          marginTop: '6px', color: 'var(--tx-3)', textAlign: 'left',
          lineHeight: 1.7,
        },
      },
        el('div', {}, `원본 코덱: ${(video.src_codec || '').toUpperCase()} `
          + `→ Chrome 재생 불가 가능성 있음`),
        el('div', {}, `faststart: ${video.faststart ? '✓' : '✗ (moov atom 파일 끝)'}`),
        el('div', {}, `GOP: ${video.gop_sec}s → seek 정확도 ±${video.gop_sec}s`)),
      el('div', { class: 'tiny', style: { marginTop: '10px' } },
        '타임라인과 이벤트 목록은 정상 동작합니다.')));
  }
  vwell.append(hud);

  // kontroller
  const scrub = el('div.scrub', {},
    el('div.track', {}, el('div.buf'), el('div.fill')),
    el('div.knob'));
  const tcode = el('div.tcode', {}, el('b', {}, '00:00:00'), ' / ', hms(video.duration));
  const btnPlay = el('button.iconbtn', { title: '재생/일시정지' }, '▶');
  const vctl = el('div.vctl', {},
    btnPlay,
    el('button.iconbtn', { title: '10초 뒤로', onclick: () => seek(cur() - 10) }, '⟲'),
    el('button.iconbtn', { title: '10초 앞으로', onclick: () => seek(cur() + 10) }, '⟳'),
    el('button.iconbtn', { title: '이전 이벤트', onclick: () => jumpEvent(-1) }, '⏮'),
    el('button.iconbtn', { title: '다음 이벤트', onclick: () => jumpEvent(1) }, '⏭'),
    tcode,
    scrub,
    el('select.select', {
      style: { width: '68px', padding: '4px 6px' },
      onchange: (e) => { if (videoEl) videoEl.playbackRate = +e.target.value; },
    }, [0.25, 0.5, 1, 2, 4].map(v =>
      el('option', { value: v, selected: v === 1 }, v + '×'))),
    el('button.iconbtn', {
      title: 'BBox 표시', class: 'on', id: 'btnbox',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.boxes = on; overlay.draw(cur()); }
      },
    }, '▭'),
    el('button.iconbtn', {
      title: '이동 궤적', class: 'on',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.trails = on; overlay.draw(cur()); }
      },
    }, '⌇'),
    el('button.iconbtn', {
      title: '레이블', class: 'on',
      onclick: (e) => {
        const on = e.currentTarget.classList.toggle('on');
        if (overlay) { overlay.opts.labels = on; overlay.draw(cur()); }
      },
    }, 'A'),
    el('button.iconbtn', { title: '스냅샷', onclick: snapshot }, '📷'),
    el('button.iconbtn', {
      title: '전체화면',
      onclick: () => vwell.requestFullscreen?.(),
    }, '⛶'),
    el('button.btn.sm.ghost', {
      onclick: () => toast('원본 영상 재생 — 요약/원본 전환 지점: '
        + TM.wallFull(cur()), 'info'),
    }, t('viewOriginal')));

  const videobox = el('div.videobox', {}, vwell, video.has_proxy ? vctl : null);

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
        '이벤트 타임라인'),
      el('span.grow'),
      el('span', { class: 'tiny muted' }, '휠=확대 · Shift+드래그=이동 · 더블클릭=전체'),
      el('button.btn.sm.ghost', {
        title: '이벤트 후보 구간 선정 근거',
        onclick: () => showCandidates(candData, TM),
      }, '◍ 후보 점수'),
      el('button.btn.sm.ghost', { onclick: () => { TL.fit(); } }, '⤢')),
    tlCanvas,
    el('div.tlhint', {},
      '상단 파란 띠 = 이벤트 후보 점수 (규칙 기반). '
      + '임계값을 넘은 구간만 VLM 분석 대상이 됩니다.'));

  // -------- özet bilgi ---------------------------------------------------
  const statbox = el('div.panel', {},
    el('div.panel-h', {}, t('summaryInfo'),
      el('span.grow'),
      el('span', { class: 'tiny muted' }, summary.engine_version || '')),
    el('div.statgrid', {},
      stat(t('videoLength'), hms(summary.duration)),
      stat(t('summaryLength'), hms(summary.summary_duration),
        `(${summary.ratio}%)`),
      stat(t('mainObject'), (summary.main_objects || [])
        .map(o => `${o.ko} ${o.count}`).join(', ')),
      stat(t('mainEvent'), String(summary.event_count)),
      stat(t('generatedAt'), clockOf(summary.generated_at),
        dateOf(summary.generated_at))));

  mount(stage, hdr, videobox, tlPanel, statbox);

  // -------- sağ panel: arama + olaylar -----------------------------------
  const promptInput = el('input.input', {
    placeholder: '이벤트 검색 (예: 탑승, 쓰러진, 배회, kırmızı)',
    onkeydown: e => { if (e.key === 'Enter') doSearch(); },
  });
  const searchState = el('div.searchstate', { style: { display: 'none' } });
  const evBody = el('div.panel-b');
  const evPanel = el('div.panel', {},
    el('div.panel-h', {}, t('eventFlow'),
      el('span.grow'),
      el('span', { class: 'tiny muted', id: 'evcount' }, `${events.length}건`)),
    el('div.promptbar', {},
      promptInput,
      el('button.btn.pri.sm', { onclick: () => doSearch() }, '⌕')),
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
    const st = e.status || 'candidate';
    const LBL = {
      candidate: ['후보', 'var(--tx-2)'],
      confirmed: ['✓ 확정', 'var(--ok)'],
      dismissed: ['✕ 오탐', 'var(--tx-3)'],
    };
    const badge = el('span.evtag', {
      style: { color: LBL[st][1], background: 'rgba(255,255,255,.05)' },
    }, LBL[st][0]);
    const set = async (next, ev) => {
      ev.stopPropagation();
      const upd = await api.eventStatus(e.id, next);
      e.status = upd.status;
      renderEvents(currentList, store.get('activeEventId'));
      toast(next === 'confirmed' ? '이벤트 확정됨' : '오탐으로 제외됨',
        next === 'confirmed' ? 'ok' : 'warn', 1800);
    };
    return el('div.evmeta', { style: { marginTop: '5px' } }, badge,
      st !== 'confirmed'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('confirmed', ev),
        }, '확정') : null,
      st !== 'dismissed'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('dismissed', ev),
        }, '오탐') : null,
      st !== 'candidate'
        ? el('button.btn.sm.ghost', {
          style: { padding: '1px 7px', fontSize: '10px' },
          onclick: (ev) => set('candidate', ev),
        }, '되돌리기') : null);
  }

  function renderEvents(list, active) {
    clear(evBody);
    const wrap = el('div.evlist');
    if (!list.length) wrap.append(el('div.empty', {},
      el('span', { class: 'big' }, '⌕'), '이벤트가 없습니다'));
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
          el('div.evtime', {}, TM.wallClock(e.t_start),
            el('span', { class: 'muted', style: { fontWeight: 400 } },
              ` +${ms(e.t_end - e.t_start)}`)),
          el('div.evdesc', {},
            store.get('lang') === 'tr' && e.description_en
              ? e.description_en : e.description),
          el('div.evmeta', {},
            el('span.evtag', { style: { color: e.color } },
              store.get('lang') === 'tr' ? e.type_tr : e.type_ko),
            el('span', { class: 'tiny muted mono' }, (e.score * 100).toFixed(0) + '%'),
            e.severity === 'critical'
              ? el('span.evtag', { style: { background: 'rgba(239,68,68,.2)', color: '#fca5a5' } }, '⚠')
              : null,
            e.event_group_code
              ? el('span.evtag', {
                style: { background: 'rgba(99,102,241,.18)', color: '#a5b4fc' },
                title: '동일 사건 그룹: ' + (e.event_group_title || ''),
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
    else toast(dir > 0 ? '마지막 이벤트입니다' : '첫 이벤트입니다', 'info', 1600);
  }

  function seek(tSec) {
    const tt = Math.max(0, Math.min(video.duration - .05, tSec));
    if (videoEl) videoEl.currentTime = tt;
    store.set({ playhead: tt });
    if (overlay) overlay.seek(tt);
    TL.playhead = tt; TL.draw();
    syncTime(tt);
  }

  function syncTime(tt) {
    tcode.firstChild.textContent = TM.wallClock(tt);
    const f = tt / video.duration;
    scrub.querySelector('.fill').style.width = (f * 100) + '%';
    scrub.querySelector('.knob').style.left = (f * 100) + '%';
    const hc = document.getElementById('hudclock');
    if (hc) hc.textContent = TM.wallFull(tt);
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
      a.download = `${videoId}_${TM.wallClock(cur()).replace(/:/g, '')}.png`;
      a.click();
      toast('스냅샷 저장됨 (BBox 포함)', 'ok');
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
    total: video.duration, startIso: video.start_time,
    heat: candHeat, heatThreshold: candData ? candData.threshold : null,
  });

  // ---- overlay -----------------------------------------------------------
  if (video.has_proxy) {
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
        title: `${TM.wallClock(e.t_start)} ${e.description}`,
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
    document.getElementById('evcount').textContent = `${filtered.length}건`;
    TL.setData({ lanes: [{ id: videoId, label: video.name, events: filtered }],
                 heat: candHeat });
    toast(`필터 적용: 객체 ${r.total}건 · 이벤트 ${filtered.length}건`, 'ok');
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
      document.getElementById('evcount').textContent = `${events.length}건`;
      return;
    }
    searchState.style.display = '';
    mount(searchState, el('div', { class: 'tiny muted' },
      el('span.spinner'), ' 검색 중…'));

    let r;
    try {
      r = await api.search({ video_ids: [videoId], query, limit: 60 });
    } catch (e) { toast('검색 실패: ' + e.message, 'err'); return; }

    mount(searchState,
      el('div.row', { style: { gap: '6px' } },
        el('span.pstep.done', {}, '이벤트 검색'),
        el('span', { class: 'tiny muted' },
          `${r.events_scanned}건 스캔 · ${r.latency_ms}ms · ${r.total}건 일치`)),
      el('div.wordchips', {},
        r.expanded_terms.slice(0, 12).map(w => el('span.wordchip', {}, w))),
      el('div', { class: 'tiny', style: { color: 'var(--tx-3)' } },
        'VLM 서술 텍스트 기준 검색'));

    currentList = r.items;
    renderEvents(r.items, null);
    document.getElementById('evcount').textContent =
      `${r.total}건 / 전체 ${events.length}`;
    TL.setData({
      lanes: [{ id: videoId, label: video.name, events: r.items }],
      heat: candHeat,
    });
    if (!r.total) toast(`"${query}" için sonuç yok — VLM bu kelimeden bahsetmemiş olabilir`, 'warn', 4200);
  }

  async function reSummarize(v) {
    const promptBox = el('textarea.textarea', {
      placeholder: '분석 프롬프트 (선택) — 비워두면 일반 요약',
    });
    const ratio = el('input.input', { type: 'number', value: 3, min: 1, max: 30 });
    const close = modal({
      title: '재요약 — ' + v.name,
      body: el('div.col', { style: { gap: '12px' } },
        el('div', { class: 'tiny muted' },
          '재요약은 GPU 작업입니다. 기존 결과는 완료될 때까지 유지됩니다.'),
        el('div.field', {}, el('label', {}, '분석 프롬프트'), promptBox),
        el('div.field', {}, el('label', {}, '목표 요약 비율 (%)'), ratio),
        el('div', { class: 'codeblock' },
          `POST /api/videos/${v.id}/analyses\n`
          + `{ "prompt": "...", "options": { "target_ratio": 3 } }\n`
          + `→ 202 { "job_id": "job-xxxxx" }`)),
      footer: [
        el('button.btn.ghost', { onclick: () => close() }, '취소'),
        el('button.btn.pri', {
          onclick: async () => {
            const r = await api.analyze(v.id, {
              prompt: promptBox.value,
              options: { target_ratio: +ratio.value }, _sim_sec: 16,
            });
            close();
            watchJob(r.job_id, v.name);
          },
        }, '재요약 시작'),
      ],
    });
  }
}

/* ---------------------------------------------------------- iş izleme ---- */

function watchJob(jobId, label) {
  const bar = el('div.progline', {}, el('i', { style: { width: '0%' } }));
  const txt = el('div', { class: 'tiny muted' }, '대기 중…');
  const host = el('div.toast', { class: 'ok', style: { minWidth: '300px' } },
    el('div', { style: { flex: 1 } },
      el('div', { style: { fontWeight: 700, marginBottom: '5px' } },
        '⟲ ' + label + ' 재요약'),
      bar, txt),
    el('button.btn.sm.ghost', {
      onclick: async () => { await api.jobCancel(jobId); host.remove(); toast('작업 취소됨', 'warn'); },
    }, '중지'));
  let h = document.getElementById('toasts');
  if (!h) { h = el('div#toasts'); document.body.append(h); }
  h.append(host);

  const stop = listen(api.jobStreamUrl(jobId), (m) => {
    bar.firstChild.style.width = (m.progress || 0) + '%';
    txt.textContent = `${m.stage_label || m.stage} · ${(m.progress || 0).toFixed(0)}%`
      + (m.eta_sec ? ` · 남은 ${Math.round(m.eta_sec)}s` : '');
    if (m.status === 'completed') {
      txt.textContent = '완료';
      stop();
      setTimeout(() => { host.remove(); toast(label + ' 재요약 완료', 'ok'); }, 900);
    }
    if (m.status === 'canceled') { stop(); host.remove(); }
  }, 'progress');
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
    ['codec (proxy)', v.codec], ['codec (원본)', v.src_codec],
    ['bitrate', v.bitrate_kbps + ' kbps'], ['file_size', bytes(v.file_size_mb)],
    ['GOP', v.gop_sec + 's'], ['faststart', v.faststart ? '✓' : '✗'],
    ['proxy 재생', v.has_proxy ? '✓ 가능' : '✗ 없음'],
  ];
  if (v.rtsp_url) rows.push(['rtsp_url', v.rtsp_url]);
  if (v.error) rows.push(['error', v.error]);
  const models = s?.models || {};
  modal({
    title: '영상 정보 · ' + v.name,
    body: el('div', {},
      el('dl.kv', {}, rows.flatMap(([k, val]) =>
        [el('dt', {}, k), el('dd', {}, String(val))])),
      Object.keys(models).length ? el('div', {},
        el('div.divider'),
        el('div', { class: 'flabel', style: { marginBottom: '6px' } }, '사용 모델'),
        el('dl.kv', {}, Object.entries(models).flatMap(([k, val]) =>
          [el('dt', {}, k), el('dd', {}, val)]))) : null,
      el('div.divider'),
      el('div', { class: 'tiny muted' },
        '⚠ 재생 관련 주의: 원본이 HEVC이면 Chrome에서 재생이 보장되지 않습니다. '
        + 'faststart 미적용 시 브라우저가 전체 파일을 받아야 재생을 시작합니다.')),
  });
}

/** event_candidate_score görselleştirmesi — "bu aralık neden seçildi".
 *  Şemada `details jsonb` alanı var; motor buraya metrik ayrıntısını yazar. */
function showCandidates(cd, TM) {
  if (!cd || !cd.windows?.length) {
    modal({ title: '후보 구간 점수',
      body: el('div.empty', {}, '이 영상에 후보 점수 데이터가 없습니다.') });
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
        ? el('span.evtag', { style: { color: 'var(--ac)' } }, '후보 ✓')
        : el('span', { class: 'tiny muted' }, '—')),
      ...codes.map(c => {
        const sc = by[c];
        if (!sc) return el('td', {}, '—');
        return el('td', {
          class: 'mono', title: `${M[c].ko} — 임계값 ${sc.threshold}`,
          style: {
            color: sc.exceeded ? 'var(--warn)' : 'var(--tx-3)',
            fontWeight: sc.exceeded ? 700 : 400,
          },
        }, sc.score.toFixed(2));
      }));
  });
  modal({
    title: `이벤트 후보 구간 선정 근거 — ${cd.selected}/${cd.count} 구간 채택`,
    wide: true,
    body: el('div', {},
      el('div', { class: 'tiny muted', style: { marginBottom: '10px', lineHeight: 1.7 } },
        `윈도우 ${cd.window_sec}초 · 통합 임계값 ${cd.threshold} · `,
        '규칙 기반 지표들의 가중 합이 임계값을 넘으면 해당 구간이 '
        + 'VLM 분석 대상이 됩니다. (DB: event_candidate_score)'),
      el('div', { style: { maxHeight: '54vh', overflow: 'auto' } },
        el('table.tbl', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '시각'), el('th', {}, '통합'), el('th', {}, '판정'),
            ...codes.map(c => el('th', { title: M[c].desc }, M[c].ko)))),
          el('tbody', {}, rows))),
      el('div.divider'),
      el('div', { class: 'tiny muted' },
        '지표: ',
        codes.map(c => `${M[c].ko}(가중 ${M[c].w})`).join(' · '))),
  });
}

function showAllEvents(events, TM) {
  const body = el('div', {}, el('table.tbl', {},
    el('thead', {}, el('tr', {},
      ['시각', '길이', '유형', '설명', '점수', 'VLM'].map(h => el('th', {}, h)))),
    el('tbody', {}, events.map(e => el('tr', {},
      el('td', { class: 'mono' }, TM.wallClock(e.t_start)),
      el('td', { class: 'mono' }, ms(e.t_end - e.t_start)),
      el('td', {}, el('span.evtag', { style: { color: e.color } }, e.type_ko)),
      el('td', {}, e.description),
      el('td', { class: 'mono' }, (e.score * 100).toFixed(0) + '%'),
      el('td', { class: 'tiny muted' }, `${e.vlm_model || ''} ${e.vlm_latency_ms || ''}ms`))))));
  modal({ title: `모든 이벤트 (${events.length})`, body, wide: true });
}

function showObject(o, videoId) {
  const defs = store.get('attributes');
  modal({
    title: '객체 정보 · ' + (o.label || o.id),
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
          ['구간', `${o.t_first}s – ${o.t_last}s`],
          ['conf', o.conf], ['node/ch', `${o.node_id}/${o.ch}`],
          ['속성', attrText(o.attrs, defs?.attributes, o.cls) || '—']]
            .flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])),
        el('div.divider'),
        el('div.row', {},
          FEATURES.reid ? el('button.btn.sm', {
            onclick: () => { location.hash = `#/objects/${videoId}?q=${o.id}`; },
          }, '🔍 이 인물 추적 (Re-ID)') : el('span', { class: 'tiny muted' },
            'Re-ID 미구현 (다음 단계)'),
          el('button.btn.sm.ghost', {
            onclick: () => { location.hash = `#/single/${o.video_id}`; },
          }, '▶ 등장 시점 재생')))),
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
      el('span', {}, '요약 시간 범위'),
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

  try {
    switch (p[0]) {
      case 'single': await screenSingle(p[1] || 'CAM01'); break;
      case 'multi': await screenMulti(p[1] || 'G1'); break;
      case 'objects': await screenObjects(p[1] || 'CAM01', q.get('q')); break;
      case 'jobs': await screenJobs(); break;
      case 'system': await screenSystem(); break;
      case 'settings': await screenSettings(); break;
      case 'api': await screenApi(); break;
      default: location.hash = '#/single/CAM01';
    }
  } catch (e) {
    console.error(e);
    toast('화면 로딩 실패: ' + e.message, 'err', 6000);
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
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const h = await api.health();
    const s = document.getElementById('srvstat');
    if (s) s.textContent = `● ${h.gallery} vec / ${h.videos} video`;
  } catch {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#fca5a5">'
      + 'Mock API sunucusuna ulaşılamıyor.<br><br>'
      + 'Çalıştırın: <b>python server.py</b><br>'
      + 'Sonra açın: <b>http://127.0.0.1:8000/</b></div>';
    return;
  }
  route();
});
