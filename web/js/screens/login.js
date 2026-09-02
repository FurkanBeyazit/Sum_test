/* ==========================================================================
   Ekran: LOGIN
   ========================================================================== */

import { el, mount, store, api } from '../core.js';
import { ROOT } from '../ui.js';

export function screenLogin() {
  const u = el('input.input', { value: 'admin', autofocus: true });
  const p = el('input.input', { type: 'password', value: 'admin' });
  const err = el('div', { class: 'tiny', style: { color: 'var(--crit)', minHeight: '16px' } });
  const go = async () => {
    try {
      const r = await api.login(u.value, p.value);
      localStorage.setItem('tok', r.access_token);
      store.set({ user: r.user });
      location.hash = '#/home';
    } catch (e) { err.textContent = e.data?.detail || e.message; }
  };
  const card = el('div.logincard', {},
    el('div.brand', { style: { fontSize: '16px' } },
      el('span.logo', {}, '▣'), el('span', {}, '지능형 영상 요약 플랫폼')),
    el('h1', {}, '로그인'),
    el('p', { class: 'sub' }, 'Intelligent Video Summary Platform'),
    el('div.field', {}, el('label', {}, '아이디'), u),
    el('div.field', {}, el('label', {}, '비밀번호'), p),
    err,
    el('button.btn.pri.wide', { onclick: go, style: { marginTop: '8px' } }, '로그인'),
    el('div', {
      class: 'tiny muted',
      style: { marginTop: '16px', textAlign: 'center', lineHeight: 1.7 },
    }, 'Backend henüz kimlik doğrulaması istemiyor — herhangi bir değer geçer.'));
  card.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

  /* Arka plan efekti artik burada degil: aurora uygulamanin tamaminin
     altinda duruyor (fx/aurora.js, app.js'te bir kez baglaniyor). Giris
     ekrani bu projede yer tutucu — efekti yalniz buraya koymak, kimsenin
     gormedigi bir yere koymakti. */
  mount(ROOT(), el('div.loginpage', {}, card));
}
