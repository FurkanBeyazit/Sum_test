/* ==========================================================================
   Ekran: 단일 영상 요약
   ========================================================================== */

import {
  FEATURES, el, mount, clear, store, api, t, hms, ms, dur,
  bytes, clockOf, dateOf, TimeMapper, toast, modal, listen, trackColor,
  attrText
} from '../core.js';
import { VideoOverlay } from '../overlay.js';
import { Timeline } from '../timeline.js';
import {
  ROOT, onLeave, statusLabel, topbar, treePanel, askReanalyze, findCam,
  statusChip, skeletonRows,
} from '../ui.js';

export async function screenSingle(videoId) {
  const cam = findCam(videoId);
  if (!cam) {
    /* Eskiden sabit '#/single/CAM01'e yonlendiriyordu: canli modda oyle bir
       id yok, sonsuz "bulunamadi" dongusune giriyordu. Katalogdaki ilk
       kayda, o da yoksa Home'a don. */
    const first = store.get('groups').flatMap((g) => g.cameras || [])[0];
    toast('Video not found: ' + videoId, 'err');
    location.hash = first ? `#/single/${first.id}` : '#/home';
    return;
  }

  const stage = el('div.stage');
  const rightbar = el('div.rightbar');
  /* Öznitelik filtresi bu ekrandan kaldırıldı: burada olaylar var, nesneler
     değil — filtre Object Page'e ait ve orada duruyor. */
  const sidebar = el('div.sidebar', {},
    treePanel(videoId, c => location.hash = `#/single/${c.id}`));

  mount(ROOT(), topbar('single'), el('div.main', {}, sidebar, stage, rightbar));

  // -------- veri ---------------------------------------------------------
  const [video, summary, evRes, objRes] = await Promise.all([
    api.video(videoId), api.summary(videoId),
    api.events(videoId, { limit: 400 }), api.objects(videoId, { limit: 400 }),
  ]);
  const events = evRes.items;
  const objects = objRes.items;
  const TM = new TimeMapper(video.start_time, summary.segments);

  // -------- üst şerit ----------------------------------------------------
  const hdr = el('div.hdr', {},
    el('div.hdr-top', {},
      el('div.crumb', {},
        el('span.par', {}, cam.group_name || 'Area'),
        el('span.sep', {}, '›'),
        el('span.cur', {}, video.name),
        /* Manage kuyrugundaki rozetin AYNISI (ui.js statusChip). Iki ekran
           iki ayri rozet cizdigi icin renkler tutmuyordu. */
        statusChip(video.status, statusLabel(video.status))),
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
    // `.fill`: kuyuyu kapla, object-fit ile sığ — bkz. app.css `.vstack.fill`
    vstack.classList.add('fill');
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
  // Olaylar cizilene kadar iskelet: bos panel "bozuk" gorunuyordu.
  const evBody = el('div.panel-b', {}, skeletonRows(6));
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
    /* Ucuncu bir durum: VLM hic sonuc uretmemis. Tespit sayisi dolu ama
       vlm_result_count 0 ise analiz "succeeded" gorunse bile VLM adimi bos
       donmus demektir — bunu ornekleme oranina baglamak yaniltici olur,
       cunku sorun kapsama degil, VLM'in kendisi. */
    if (!list.length && !summary.segments.length
        && summary.detection_result_count) {
      wrap.append(el('div.empty', {},
        el('span', { class: 'big' }, '⚠'),
        el('div', {}, 'VLM produced no output'),
        el('div', {
          class: 'tiny muted',
          style: { marginTop: '6px', lineHeight: 1.7, maxWidth: '260px',
                   textAlign: 'left' },
        },
          `Detection ran: ${summary.detection_result_count} result(s), `
          + `${summary.frame_count || '?'} frame(s).`,
          el('br'),
          'But vlm_result_count = 0 — the VLM step returned nothing, so there '
          + 'are no segments to show.',
          el('br'), el('br'),
          'This is a backend-side issue, not a UI one. Check the vLLM service '
          + 'health and the analysis worker log for this video.')));
      mount(evBody, wrap);
      return;
    }
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
    // Bayrak kapalıyken hiç sorma: kutu çizilmeyecekse veri de gerekmiyor.
    const det = FEATURES.bbox
      ? await api.detections(videoId, { from: 0, to: video.duration })
          .catch(() => null)
      : null;
    /* Bu await sırasında kullanıcı başka bir ekrana geçmiş olabilir; o zaman
       DOM çoktan değişti ve aşağıdaki kurulum yok olmuş düğümlere yazıyor
       ("Cannot set properties of null"). Ekran hâlâ bizimse devam. */
    if (!document.body.contains(vwell)) return;
    overlay.setDetections(det, { w: video.width, h: video.height });
    overlay.start();
    const hud0 = document.getElementById('hudobj');
    if (hud0) hud0.textContent = 'obj 0';

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
      // bbox düğmesi FEATURES.bbox kapalıyken hiç çizilmiyor
      if (ev.key === 'b') document.getElementById('btnbox')?.click();
      if (ev.key === 'n') jumpEvent(1);
      if (ev.key === 'p') jumpEvent(-1);
    };
    document.addEventListener('keydown', keys);
    onLeave(() => document.removeEventListener('keydown', keys));
  }

  renderEvents(events, null);
  syncTime(0);

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
      const ec0 = document.getElementById('evcount');
      if (ec0) ec0.textContent = `${events.length}`;
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
    const ec1 = document.getElementById('evcount');
    if (ec1) ec1.textContent = `${r.total} / ${events.length}`;
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
        /* target_ratio kaldırıldı: backend'in analyze ucu yalnızca prompt ve
           model alıyor, oran hiçbir yere gitmiyordu. */
        /* Asıl kaldıraç bu: prompt'u değiştirmek örnekleme aralığını
           değiştirmez. Video büyük ölçüde hiç bakılmadan kalıyorsa yeni
           prompt da aynı "특이사항 없음"u üretir — bunu peşinen söylüyoruz. */
        cov ? el('div', { class: 'tiny', style: { color: '#fbbf24' } },
          `Current VLM coverage is ${cov}% — the answer is based on that `
          + 'much of the video only. Changing the prompt does not make the '
          + 'remaining ranges get analyzed.') : null,
        el('div', { class: 'codeblock' },
          'POST /analysis\n'
          + `{ "video_id": ${v.id}, "settings": { "prompt": "..." } }`)),
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
