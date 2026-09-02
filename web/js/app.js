/* ============================================================================
   app.js — yonlendirici
   ----------------------------------------------------------------------------
   Ekran kodu screens/ altinda, her ekran kendi dosyasinda. Buradaki tek is:
   hash adresini ekrana baglamak, oturum/katalog on kosullarini saglamak ve
   ekran degisiminde onceki ekranin temizligini calistirmak.
   ========================================================================= */

import { el, mount, store, api, toast } from './core.js';
import { ROOT, runCleanup, topbar } from './ui.js';
import { mountAurora } from './fx/aurora.js';
import { screenLogin } from './screens/login.js';
import { screenSingle } from './screens/single.js';
import { screenObjects } from './screens/objects.js';
import { screenHome } from './screens/home.js';
import { screenUpload } from './screens/upload.js';
import { screenSystem } from './screens/system.js';
import { screenManage } from './screens/manage.js';

async function route() {
  runCleanup();
  /* Varsayılan Home: video id'si gerektiren bir ekranla açmak, katalog boşsa
     (hiç video yüklenmemişse) doğrudan 404 demekti. */
  const h = location.hash.slice(1) || '/home';
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
    store.set({ groups: g.groups });
    store.set({ attributes: await api.attributes() });
  }

  /* Adres çubuğundaki id silinmiş bir videoya ait olabilir (yer imi, eski
     sekme). 404 fırlatıp boş ekranda kalmak yerine ilk kayda yönlendiriyoruz. */
  const cams = store.get('groups').flatMap((g) => g.cameras || []);
  if ((p[0] === 'single' || p[0] === 'objects') && cams.length
      && !cams.some((c) => String(c.id) === String(p[1]))) {
    location.hash = `#/${p[0]}/${cams[0].id}`;
    return;
  }

  try {
    switch (p[0]) {
      /* Video id'si zorunlu: 'CAM01' varsayilani mock kalintisiydi ve
         canlida her zaman 404 uretiyordu. Katalog bossa Home'a dus. */
      case 'single':
        if (!p[1]) { location.hash = '#/home'; return; }
        await screenSingle(p[1]); break;
      case 'objects':
        if (!p[1]) { location.hash = '#/home'; return; }
        await screenObjects(p[1]); break;
      case 'home': await screenHome(); break;
      case 'upload': await screenUpload(); break;
      // Jobs, Manage ekranina tasindi — eski yer imleri kirilmasin
      case 'jobs': location.hash = '#/manage'; return;
      case 'system': await screenSystem(); break;
      case 'manage': await screenManage(); break;
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
          '화면 로딩 실패'),
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
  /* Arka plan health çağrısından ÖNCE: backend yavaşsa kullanıcı boş siyah
     ekrana değil, boyanmış bir ekrana bakıyor. */
  mountAurora();
  try {
    const h = await api.health();
    const s = document.getElementById('srvstat');
    if (s) {
      // Backend'e ulaşılıyor mu — ekranda her zaman görünsün.
      s.textContent = `● ${h.status || 'connected'}`;
      s.title = 'DVSummary API (/live)';
      s.style.color = '#4ade80';
    }
  } catch {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#fca5a5">'
      + 'Cannot reach the UI server.<br><br>'
      + 'Run: <b>python server.py</b><br>'
      + 'Then open: <b>http://127.0.0.1:8000/</b></div>';
    return;
  }
  route();
}

/* Olay çoktan geçmiş olabilir (modül grafiği bir şeyi beklediyse). Kaçırılan
   `DOMContentLoaded` ekranı sonsuza kadar "로딩 중…" bırakırdı; readyState'e
   bakıp doğrudan başlıyoruz. */
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
