/* ==========================================================================
   Ekran: Manage — katalog ve analiz kuyruğu  (#/manage)
   --------------------------------------------------------------------------
   Backend'in katalog uçlarının TAMAMINI arayüze yansıtır. Şimdiye kadar
   yalnızca okuma (GET) ve yükleme (POST) vardı; grup/video düzeltmek ya da
   silmek için Swagger'a gitmek gerekiyordu.

     GET    /video/groups          POST   /video/groups
     GET    /video/groups/{id}     PUT    /video/groups/{id}
     DELETE /video/groups/{id}
     GET    /video                 PUT    /video/{id}
     DELETE /video/{id}
     GET    /analysis              DELETE /analysis/{id}
     POST   /analysis/{id}/cancel

   Analiz kuyruğu ayrı bir sekmeydi; buraya taşındı. Aynı satırdaki videoyu
   silen, düzelten ve yeniden analiz eden ekranın altında kuyruğun durumunu
   görmek doğal — iki sekme arasında gidip gelmek gereksizdi.

   Yıkıcı olan her işlem önce onay ister. Silme geri alınamaz; bu ekranda
   "geri al" yok, çünkü backend'de de yok.
   ========================================================================== */

import {
  el, mount, clear, store, api, hms, dur, bytes, clockOf, toast, modal,
} from '../core.js';
import { ROOT, onLeave, topbar, confirmModal } from '../ui.js';

/* Hem video durumları (mapStatus çıktısı) hem kuyruk durumları aynı rozeti
   kullanıyor — ikisi farklı sözlük ama kullanıcı için aynı şey: yeşil iyi,
   mavi çalışıyor, kırmızı bozuk. */
const STATUS_TONE = {
  completed: 'ok', analyzing: 'run', ready: 'idle',
  registered: 'idle', failed: 'err',
  running: 'run', queued: 'idle', canceled: 'idle',
};

export async function screenManage() {
  const stage = el('div.stage');
  mount(ROOT(), topbar('manage'), el('div.main', {}, stage));

  const groupBody = el('div.panel-b');
  const videoBody = el('div.panel-b');
  const queueBody = el('div.panel-b');
  const groupCount = el('span', { class: 'tiny muted' }, '');
  const videoCount = el('span', { class: 'tiny muted' }, '');
  const queueCount = el('span', { class: 'tiny muted' }, '');

  let sel = null;          // seçili grup id'si (null = hepsi)
  let poll = null;

  mount(stage,
    el('div.hdr', {},
      el('div.hdr-top', {},
        el('div.crumb', {}, el('span.cur', {}, 'Manage')),
        el('div.grow'),
        el('button.btn.sm', { onclick: () => load() }, '⟲ Refresh')),
      el('div.hdr-sub', {},
        el('span', {}, 'Edit, delete and re-analyse groups and videos; '
          + 'watch the queue below. Deletion cannot be undone.'))),
    el('div.panel.mg-groups', {},
      el('div.panel-h', {}, 'Groups', el('span.grow'), groupCount,
        el('button.btn.sm.pri', { onclick: () => newGroup() }, '＋ New group')),
      groupBody),
    el('div.panel.mg-videos', {},
      el('div.panel-h', {}, 'Videos', el('span.grow'), videoCount),
      videoBody),
    el('div.panel.mg-queue', {},
      el('div.panel-h', {}, 'Analysis queue', el('span.grow'), queueCount),
      queueBody));

  /* ------------------------------------------------------------ yükleme -- */
  async function load() {
    const [r] = await Promise.all([api.groups(), drawQueue()]);
    store.set({ groups: r.groups });
    drawGroups(r.groups);
    drawVideos(r.groups);
  }

  /* -------------------------------------------------------- analiz kuyruğu
     Gerçek API'de SSE yok; devam eden iş varken 3 sn'de bir yokluyoruz.
     Hepsi bitince yoklama kendiliğinden duruyor, boşuna istek atılmıyor. */
  async function drawQueue() {
    let rows = [];
    try {
      rows = (await api.jobs()).items || [];
    } catch (e) {
      clear(queueBody);
      queueBody.append(el('div.empty', {}, 'Could not read the queue: ' + e.message));
      return;
    }
    queueCount.textContent = `${rows.length} record(s)`;
    clear(queueBody);

    const trs = rows.map((j) => el('tr', {},
      el('td', { class: 'mono' }, j.video_id),
      el('td', {}, pill(j.status)),
      el('td', { style: { width: '120px' } },
        el('div.gbar', {}, el('i', {
          style: {
            width: (j.progress || 0) + '%',
            background: j.status === 'failed' ? 'var(--crit)' : 'var(--ok)',
          },
        }))),
      el('td', { class: 'tiny' }, j.stage_label || '—'),
      el('td', { class: 'mono tiny' }, j.created_at ? clockOf(j.created_at) : '—'),
      el('td', { class: 'num tiny muted' }, j.duration_sec ? dur(j.duration_sec) : '—'),
      el('td', { class: 'tiny' },
        j.attempt_count != null ? `${j.attempt_count}/${j.max_attempts}` : '—'),
      el('td', { class: 'act' },
        j.status === 'running'
          ? btn('Cancel', async () => {
            try { await api.jobCancel(j.job_id); toast('Cancel requested', 'ok'); load(); }
            catch (e) { toast(e.message, 'err'); }
          }, 'danger')
          : null,
        j.error
          ? btn('Error', () => modal({
            title: 'Analysis error · video ' + j.video_id,
            body: el('div.codeblock', {}, j.error),
          }))
          : null,
        btn('Drop record', async () => {
          const ok = await confirmModal('Drop queue record',
            `The queue record for video ${j.video_id} will be removed. The`
            + ' analysis result stays on disk and the video becomes'
            + ' re-analysable. Continue?',
            'Drop');
          if (!ok) return;
          try { await api.dropAnalysis(j.video_id); toast('Dropped', 'ok'); load(); }
          catch (e) { toast(e.message, 'err'); }
        }, 'danger'))));

    queueBody.append(table(
      ['video', 'status', 'progress', 'worker', 'queued', 'took', 'try', ''],
      trs, 'The queue is empty.'));

    clearTimeout(poll);
    if (rows.some((j) => j.status === 'running' || j.status === 'queued')) {
      poll = setTimeout(() => {
        if (location.hash.startsWith('#/manage')) drawQueue();
      }, 3000);
      onLeave(() => clearTimeout(poll));
    }
  }

  /* ------------------------------------------------------------- gruplar - */
  function drawGroups(groups) {
    groupCount.textContent = `${groups.length} group`;
    clear(groupBody);
    const rows = groups.map((g) => el('tr', {
      class: sel === g.id ? 'on' : '',
      onclick: () => { sel = (sel === g.id ? null : g.id); drawGroups(groups); drawVideos(groups); },
    },
      el('td', { class: 'mono' }, g.id),
      el('td', {}, el('b', {}, g.name)),
      el('td', { class: 'muted' }, g.desc || '—'),
      el('td', { class: 'num' }, String((g.cameras || []).length)),
      el('td', { class: 'act' },
        btn('Rename', () => editGroup(g)),
        /* Grup silinince içindeki videolara ne olduğu backend'e bağlı —
           kullanıcıya sayıyı gösterip kararı ona bırakıyoruz. */
        btn('Delete', () => delGroup(g), 'danger'))));

    groupBody.append(table(
      ['id', 'name', 'description', 'videos', ''],
      rows,
      'No groups yet.'));
  }

  function newGroup() {
    formModal('New group', [
      ['name', 'Name', ''],
      ['description', 'Description', ''],
    ], async (v) => {
      if (!v.name.trim()) return toast('Name is required', 'warn');
      await api.createGroup(v.name.trim(), v.description.trim());
      toast('Group created', 'ok');
      await load();
    });
  }

  function editGroup(g) {
    formModal(`Group ${g.id}`, [
      ['name', 'Name', g.name],
      ['description', 'Description', g.desc || ''],
    ], async (v) => {
      await api.updateGroup(g.id, { name: v.name, description: v.description });
      toast('Group updated', 'ok');
      await load();
    });
  }

  async function delGroup(g) {
    const n = (g.cameras || []).length;
    const ok = await confirmModal('Delete group',
      `"${g.name}" will be deleted.`
      + (n ? ` It holds ${n} video(s) — if the backend deletes those too,`
           + ' they cannot be recovered.' : '')
      + ' Continue?', 'Delete');
    if (!ok) return;
    try {
      await api.deleteGroup(g.id);
      toast(`Group ${g.id} deleted`, 'ok');
      sel = null;
      await load();
    } catch (e) { toast('Delete failed: ' + e.message, 'err', 6000); }
  }

  /* -------------------------------------------------------------- videolar */
  function drawVideos(groups) {
    const all = groups.flatMap((g) =>
      (g.cameras || []).map((c) => ({ ...c, group_name: g.name, group_id: g.id })));
    const list = sel == null ? all : all.filter((v) => v.group_id === sel);
    videoCount.textContent = sel == null
      ? `${list.length} video`
      : `${list.length} video · filtre: ${sel}`;

    clear(videoBody);
    const rows = list.map((v) => el('tr', {},
      el('td', { class: 'mono' }, v.id),
      el('td', {},
        el('b', {}, v.name),
        el('div', { class: 'tiny muted' }, v.place_ko || '—')),
      el('td', {}, pill(v.status)),
      el('td', { class: 'num' }, v.duration ? hms(v.duration) : '—'),
      el('td', { class: 'mono tiny' }, v.start_time
        ? new Date(v.start_time).toLocaleString()
        : el('span', { class: 'warnq' }, 'saat yok')),
      el('td', { class: 'num tiny muted' }, v.file_size_mb ? bytes(v.file_size_mb) : '—'),
      el('td', { class: 'act' },
        btn('Open', () => { location.hash = `#/single/${v.id}`; }),
        btn('Edit', () => editVideo(v)),
        btn('Re-analyze', () => reAnalyze(v)),
        v.status === 'analyzing'
          ? btn('Cancel', () => cancelRun(v))
          : null,
        btn('Delete', () => delVideo(v), 'danger'))));

    videoBody.append(table(
      ['id', 'name', 'status', 'length', 'start_at', 'size', ''],
      rows,
      sel == null ? 'The catalogue is empty.' : 'No video in this group.'));
  }

  function editVideo(v) {
    /* start_at backend'e `datetime-local` biçiminde gidiyor; `updateVideo`
       boş alanları zaten atlıyor, o yüzden dokunulmayan alan bozulmaz. */
    const iso = v.start_time
      ? new Date(v.start_time).toISOString().slice(0, 19)
      : '';
    formModal(`Video ${v.id}`, [
      ['name', 'Name', v.name],
      ['description', 'Description', v.place_ko || ''],
      ['start_at', 'Start (YYYY-MM-DDTHH:MM:SS)', iso],
    ], async (val) => {
      await api.updateVideo(v.id, val);
      api.invalidate(v.id);
      toast('Video updated', 'ok');
      await load();
    });
  }

  async function reAnalyze(v) {
    const ok = await confirmModal('Re-analyze',
      `"${v.name}" will be analysed again. The queue record is dropped and a`
      + ' new one created; the new result replaces the current one.'
      + ' Continue?', 'Re-analyze');
    if (!ok) return;
    try {
      await api.analyze(v.id, {}, { force: true });
      api.invalidate(v.id);
      toast('Queued', 'ok');
      await load();
    } catch (e) { toast('Failed: ' + e.message, 'err', 6000); }
  }

  async function cancelRun(v) {
    try {
      await api.jobCancel(`Q${v.id}`);
      toast('Cancel requested', 'ok');
      await load();
    } catch (e) { toast('Failed: ' + e.message, 'err', 6000); }
  }

  async function delVideo(v) {
    const ok = await confirmModal('Delete video',
      `"${v.name}" (id ${v.id}) will be deleted, and its analysis result`
      + ' becomes meaningless. This cannot be undone. Continue?', 'Delete');
    if (!ok) return;
    try {
      await api.deleteVideo(v.id);
      toast(`Video ${v.id} deleted`, 'ok');
      await load();
    } catch (e) { toast('Delete failed: ' + e.message, 'err', 6000); }
  }

  await load();
}

/* --------------------------------------------------------------- parçalar */

function table(head, rows, emptyText) {
  if (!rows.length) {
    return el('div.empty', {}, el('span', { class: 'big' }, '∅'), emptyText);
  }
  return el('div.mg-scroll', {},
    el('table.mg', {},
      el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows)));
}

function btn(label, onclick, kind) {
  return el(`button.btn.sm.${kind === 'danger' ? 'danger' : 'ghost'}`, {
    onclick: (e) => { e.stopPropagation(); onclick(); },
  }, label);
}

function pill(status) {
  return el('span', { class: `mg-pill ${STATUS_TONE[status] || 'idle'}` }, status);
}

/**
 * Küçük bir alan formu. Girdi adları doğrudan API alan adları — arada eşleme
 * olmasın ki hangi alanın nereye gittiği belirsiz kalmasın.
 */
function formModal(title, fields, onSave) {
  const inputs = new Map();
  const body = el('div', { style: { display: 'grid', gap: '10px' } },
    fields.map(([key, label, value]) => {
      const i = el('input.input', { value: value ?? '' });
      inputs.set(key, i);
      return el('div', {},
        el('div', { class: 'flabel' }, label),
        i,
        el('div', { class: 'tiny muted' }, key));
    }));
  let close = () => {};
  close = modal({
    title,
    body,
    footer: [
      el('button.btn.ghost', { onclick: () => close() }, 'Cancel'),
      el('button.btn.pri', {
        onclick: async () => {
          const v = {};
          for (const [k, i] of inputs) v[k] = i.value;
          close();
          try { await onSave(v); }
          catch (e) { toast('Failed: ' + e.message, 'err', 6000); }
        },
      }, 'Save'),
    ],
  });
}
