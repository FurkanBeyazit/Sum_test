/* ============================================================================
   aurora.js — uygulama geneli ortam arka planı
   ----------------------------------------------------------------------------
   NEDEN LOGIN'DE DEĞİL
   Giriş ekranı bu projede yer tutucu; backend kimlik doğrulaması istemiyor ve
   kullanıcı orada bir saniye durmuyor. Efekt oraya konunca kimse görmüyordu.
   Burada arka plan bütün ekranların altında duruyor: paneller opak, aurora
   panellerin ARASINDAN görünüyor — dekor değil, derinlik.

   MALİYET — bu efekt "pahalı" sınıfında, o yüzden dört fren var:

     1. YARIM ÇÖZÜNÜRLÜK. Canvas ekranın yarısı kadar piksel çiziyor ve
        1280 pikselde tavanlanıyor. Bulanık bir degrade için tam çözünürlük
        israf; CSS ölçekleme farkı görünmüyor.
     2. 30 FPS TAVANI. Aurora saniyede 60 kez değişecek bir şey değil.
        requestAnimationFrame içinde kare atlanıyor.
     3. GÖRÜNMEZKEN DURUYOR. Sekme arka plandayken (document.hidden) döngü
        tamamen kapanıyor — CPU/GPU sıfır.
     4. KAPATILABİLİR. `prefers-reduced-motion` açıksa hiç başlamıyor.
        Ayrıca localStorage'daki `fxbg` anahtarı '0' ise kapalı — üst
        çubukta düğmesi yok (arayüzü kalabalıklaştırıyordu), gerekirse
        konsoldan: localStorage.setItem('fxbg','0') ve sayfa yenile.

   WebGL2 yoksa (uzak masaüstü, eski sürücü) hiç canvas açılmıyor;
   altındaki CSS degradesi zaten tek başına duruyor.
   ========================================================================= */

const KEY = 'fxbg';                 // localStorage: '0' = kapalı

/** Kullanıcı tercihi + sistem tercihi. */
export function fxEnabled() {
  if (localStorage.getItem(KEY) === '0') return false;
  if (window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return false;
  }
  return true;
}

export function setFxEnabled(on) {
  localStorage.setItem(KEY, on ? '1' : '0');
  apply();
}

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

/* Aurora perdeleri: üç dalgalı bant, her biri kendi hızında akıyor ve
   fbm gürültüsüyle kırılıyor. Işık üst kenardan geliyor — kutup ışığı
   fotoğraflarındaki gibi bantlar yukarıda yoğun, aşağıda dağılıyor. */
const FRAG = `#version 300 es
precision mediump float;
out vec4 outColor;
uniform vec2  uRes;
uniform float uT;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i),               hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / max(1.0, uRes.y);
  vec3 col = vec3(0.0);

  // üç perde — vurgu renginden indigoya
  vec3 tint[3];
  tint[0] = vec3(0.055, 0.455, 0.565);   // #0e7490
  tint[1] = vec3(0.220, 0.741, 0.973);   // #38bdf8
  tint[2] = vec3(0.388, 0.400, 0.945);   // #6366f1

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float t  = uT * (0.020 + 0.011 * fi);
    // bandın orta ekseni: ekranın üst yarısında, yavaşça dalgalanıyor
    float y  = 0.74 - 0.09 * fi
             + 0.10 * sin(uv.x * (1.6 + 0.4 * fi) + t * 2.4 + fi * 2.1)
             + 0.07 * fbm(vec2(uv.x * 2.2 * asp + t, fi * 9.0));
    float d  = uv.y - y;
    // asimetrik düşüş: üstte keskin, altta uzun — perde hissi
    float w  = d > 0.0 ? 10.0 : 3.4;
    float band = exp(-d * d * w * (5.0 + fi));
    // dikey lifler
    band *= 0.55 + 0.55 * fbm(vec2(uv.x * (5.0 + 2.0 * fi) * asp - t * 1.7,
                                   uv.y * 1.6 + fi * 4.0));
    col += tint[i] * band * (0.42 - 0.07 * fi);
  }

  // tepe parıltısı + alt karartma: içerik alanı sakin kalsın
  col += vec3(0.055, 0.455, 0.565) * 0.10
       * exp(-pow((uv.y - 1.0) * 1.9, 2.0));
  col *= smoothstep(-0.15, 0.85, uv.y);

  // kenar sönümü — köşelerde bant kesiği görünmesin
  col *= 1.0 - 0.55 * pow(abs(uv.x - 0.5) * 2.0, 3.0);

  outColor = vec4(col, 1.0);
}`;

let handle = null;      // { canvas, destroy }

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[aurora] shader:', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

/** Canvas'ı açar ve döngüyü başlatır. Başarısızsa null döner. */
function start() {
  const canvas = document.createElement('canvas');
  canvas.className = 'fxbg';
  canvas.setAttribute('aria-hidden', 'true');

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power',
    // Kare tutulmuyor: her karede tamamı yeniden çiziliyor.
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[aurora] link:', gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  /* Tam ekran ÜÇGEN (dörtgen değil): tek primitif, kenarda dikiş yok. */
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uT = gl.getUniformLocation(prog, 'uT');

  const MAX_W = 1280;                 // fren 1: çözünürlük tavanı
  let w = 0, h = 0;
  const resize = () => {
    const scale = Math.min(0.5, MAX_W / Math.max(1, window.innerWidth));
    const nw = Math.max(2, Math.round(window.innerWidth * scale));
    const nh = Math.max(2, Math.round(window.innerHeight * scale));
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uRes, w, h);
  };
  resize();
  window.addEventListener('resize', resize);

  const FRAME = 1000 / 30;            // fren 2: 30 fps
  let raf = null;
  let last = 0;
  const t0 = performance.now();

  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < FRAME) return;
    last = now;
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const play = () => { if (raf === null) { last = 0; raf = requestAnimationFrame(loop); } };
  const stop = () => { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } };
  // fren 3: sekme görünmezken döngü tamamen kapalı
  const onVis = () => (document.hidden ? stop() : play());
  document.addEventListener('visibilitychange', onVis);
  play();

  document.body.prepend(canvas);

  return {
    canvas,
    destroy() {
      stop();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
      canvas.remove();
      // Bağlamı elle bırak: sekme sayısı sınırlı, çöp toplayıcıyı bekleme.
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    },
  };
}

/** Tercihe göre canvas'ı açar ya da kapatır. Tekrar çağrılabilir. */
function apply() {
  const want = fxEnabled();
  if (want && !handle) handle = start();
  else if (!want && handle) { handle.destroy(); handle = null; }
  document.documentElement.classList.toggle('fx-on', !!handle);
}

/** app.js açılışta bir kez çağırıyor. */
export function mountAurora() {
  apply();
  // Sistem tercihi oturum ortasında değişebilir (Windows "animasyonları kapat").
  const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
}
