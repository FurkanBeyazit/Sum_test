/* ==========================================================================
   fx/fibers.js — hareketli lif arka planı (WebGL2, bağımlılıksız)
   --------------------------------------------------------------------------
   reactbits.dev'deki "GhostFibers" bileşeninin bu projeye uyarlaması.
   Özgün sürüm React + `ogl` istiyordu; burada ikisi de yok:

     - React yerine düz `mountFibers(container, opts)` → `{ set, destroy }`
     - `ogl` yerine ham WebGL2. Kütüphane zaten tek bir tam ekran üçgen ve tek
       bir program kuruyordu; onu elle yazmak 60 satır ve npm'e, build adımına,
       CDN'e bağımlılık bırakmıyor. Projenin geri kalanı da böyle çalışıyor.

   MALİYET
   -------
   Bu bir parça-gölgelendirici (fragment shader) efekti: her karede her piksel
   için `layers` kez döngü dönüyor. Ekranı kaplayan bir yüzeyde bu, ölçmeden
   "hafif" denebilecek bir iş değil. Bu yüzden:

     - yalnızca LOGIN ekranında kullanılıyor; video çözme, timeline canvas'ı ve
       bbox katmanı ile aynı anda GPU'ya yüklenmiyor
     - `dpr` 1'e sabit (retina'da 4 kat piksel demek)
     - görünür değilken, sekme arka plandayken ve `prefers-reduced-motion`
       açıkken döngü tamamen duruyor — `requestAnimationFrame` bile kurulmuyor
     - WebGL2 yoksa sessizce hiçbir şey yapmıyor; altındaki CSS degradesi
       zaten tek başına ayakta duruyor
   ========================================================================== */

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uRotationSpeed;
uniform float uLayers;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;
uniform float uWaveSpeed;
uniform float uLayerSpeed;
uniform float uTwist;
uniform float uTwistFrequency;
uniform float uTwistSpeed;
uniform float uLineFrequency;
uniform float uLineSpacing;
uniform float uLineSharpness;
uniform float uGlowFalloff;
uniform float uGlowIntensity;
uniform float uBrightness;
uniform float uBlueBoost;
uniform float uVignette;
uniform float uGrain;
uniform vec3  uBackdrop;
uniform vec3  uLineColor;
uniform vec3  uGlowColor;

out vec4 fragColor;

#define MAX_LAYERS 10

mat2 rotate2d(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}

float grainHash(vec2 p) {
  p = floor(p);
  return fract(52.9829189 * fract(dot(p, vec2(0.065, 0.005))));
}

/* Beş oktavlı film graini. Düz gradyanlarda oluşan bantlaşmayı kırıyor —
   koyu bir arka planda asıl görünür kusur o. */
float layeredGrain(vec2 frag) {
  vec2 p = mod(frag + vec2(uTime * 30.0, -uTime * 21.0), 1024.0);
  vec2 r = mat2(0.8, -0.5, 0.5, 0.8) * p;
  float g = 0.0;
  g += 0.40 * grainHash(r);
  g += 0.25 * grainHash(r * 2.0 + 17.0);
  g += 0.20 * grainHash(r * 4.0 + 47.0);
  g += 0.10 * grainHash(r * 8.0 + 113.0);
  g += 0.05 * grainHash(r * 16.0 + 191.0);
  return g;
}

void main() {
  vec2 res = max(uResolution, vec2(1.0));
  vec2 uv = (2.0 * gl_FragCoord.xy - res) / res.y;
  float time = uTime * uSpeed;

  vec3 centerTone = max(uLineColor * 0.85567 - uGlowColor * 0.06186, vec3(0.0));
  vec3 cloudTone  = uLineColor * 0.19588 + uGlowColor * 0.2268;

  vec2 p = uv / max(uScale, 0.05);
  p = rotate2d(radians(uRotation) + time * uRotationSpeed) * p;

  vec3 color = vec3(0.0);

  /* Katmanlar birikimli: her tur bir öncekinin bozduğu düzlemi tekrar
     bozuyor, lifler böyle iç içe geçiyor. Sabit MAX_LAYERS + break, döngü
     sınırının derleme zamanında bilinmesi gerektiği için. */
  for (int i = 0; i < MAX_LAYERS; i++) {
    float fi = float(i) + 1.0;
    if (fi > uLayers) break;

    p += uWaveAmplitude * sin(p.yx * fi * uWaveFrequency
                              + time * (uWaveSpeed + fi * uLayerSpeed));

    float radius = length(p);
    float ang = atan(p.y, p.x)
              + sin(radius * uTwistFrequency - time * uTwistSpeed + fi) * uTwist;
    p = vec2(cos(ang), sin(ang)) * radius;

    float lines = abs(sin(p.x * (uLineFrequency + fi * uLineSpacing)
                          + sin(p.y * 3.0 + time)));
    lines = pow(max(0.0, 1.0 - lines), uLineSharpness);
    color += uLineColor * lines / fi;

    float glow = exp(-uGlowFalloff * abs(sin(p.x * 3.0 + time + fi)));
    color += uGlowColor * glow * uGlowIntensity / (fi * 2.0);
  }

  float center = exp(-2.2 * dot(uv, uv));
  color += centerTone * center;

  float cloud = exp(-1.5 * length(uv + vec2(sin(time * 0.30) * 0.25,
                                            cos(time * 0.25) * 0.18)));
  color += cloudTone * cloud;

  float vig = 1.0 - smoothstep(0.35, 1.45, length(uv));
  color *= mix(1.0 - uVignette, 1.0, vig);
  color = 1.0 - exp(-color * uBrightness);      // ton eşleme
  color.b *= uBlueBoost;

  vec3 outC = uBackdrop + color;
  float noise = (layeredGrain(gl_FragCoord.xy) - 0.5) * uGrain;
  fragColor = vec4(clamp(outC + noise, 0.0, 1.0), 1.0);
}
`;

/** '#38bdf8' → [0.22, 0.74, 0.97] */
function hexToRgb(hex) {
  const v = String(hex).trim().replace(/^#/, '');
  const s = v.length === 3 ? v.replace(/./g, (c) => c + c) : v;
  const m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255,
    parseInt(m[2], 16) / 255,
    parseInt(m[3], 16) / 255];
}

/* Uygulamanın paletine göre varsayılanlar. Özgün bileşen mor/indigo
   geliyordu; buradaki değerler --bg-0 zemini ve --ac vurgusuyla aynı
   ailede kalsın diye seçildi. */
const DEFAULTS = {
  backdrop: '#0a0e14',
  lineColor: '#12263c',
  glowColor: '#0e7490',
  speed: 0.14,
  scale: 2.2,
  rotation: 0,
  rotationSpeed: 0.18,
  layers: 4,
  waveAmplitude: 0.015,
  waveFrequency: 3,
  waveSpeed: 0.15,
  layerSpeed: 0.08,
  twist: 0.1,
  twistFrequency: 5,
  twistSpeed: 1.2,
  lineFrequency: 5,
  lineSpacing: 2,
  lineSharpness: 16,
  glowFalloff: 10,
  glowIntensity: 1.35,
  brightness: 1.7,
  blueBoost: 1.2,
  vignette: 0.85,
  grain: 0.045,
  dpr: 1,
  fps: 45,
};

const COLOR_KEYS = ['backdrop', 'lineColor', 'glowColor'];

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[fibers] shader:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Verilen kabın içine hareketli arka planı kurar.
 *
 * @param {HTMLElement} container  konumlandırılmış bir kap (position: relative)
 * @param {object} opts            DEFAULTS'taki her anahtar geçerli
 * @returns {{set:(o:object)=>void, destroy:()=>void}}
 *          WebGL2 yoksa aynı arayüzü döndüren boş bir nesne — çağıran tarafın
 *          ayrıca kontrol etmesi gerekmiyor.
 */
export function mountFibers(container, opts = {}) {
  const noop = { set() {}, destroy() {} };
  if (!container) return noop;

  const cfg = { ...DEFAULTS, ...opts };
  const canvas = document.createElement('canvas');
  canvas.className = 'fxcanvas';
  canvas.setAttribute('aria-hidden', 'true');

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) return noop;                    // eski tarayıcı / yazılım render

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return noop;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'position');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[fibers] link:', gl.getProgramInfoLog(prog));
    return noop;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  gl.useProgram(prog);

  /* Tek üçgen ekranı kaplıyor. İki üçgenli quad'a göre köşegende ikinci kez
     parça üretilmiyor ve kırpma donanımda bedava. */
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  /* Uniform konumları bir kez toplanıyor; her karede yalnızca uTime gidiyor. */
  const loc = {};
  const nUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nUniforms; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    loc[name] = gl.getUniformLocation(prog, name);
  }

  function pushUniforms() {
    for (const k of COLOR_KEYS) {
      const u = loc['u' + k[0].toUpperCase() + k.slice(1)];
      if (u) gl.uniform3fv(u, hexToRgb(cfg[k]));
    }
    for (const [k, v] of Object.entries(cfg)) {
      if (COLOR_KEYS.includes(k) || k === 'dpr' || k === 'fps') continue;
      const u = loc['u' + k[0].toUpperCase() + k.slice(1)];
      if (u) gl.uniform1f(u, Number(v));
    }
    if (loc.uLayers) {
      gl.uniform1f(loc.uLayers, Math.min(Math.max(Math.round(cfg.layers), 1), 10));
    }
  }

  const dpr = Math.min(Math.max(cfg.dpr, 0.5), 2);
  let w = 1, h = 1;

  function draw() {
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function resize() {
    const r = container.getBoundingClientRect();
    w = Math.max(1, Math.floor(r.width * dpr));
    h = Math.max(1, Math.floor(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (loc.uResolution) gl.uniform2f(loc.uResolution, w, h);
    draw();
  }

  /* --- döngü --------------------------------------------------------------
     Üç bağımsız sebepten duruyor: kap görünür değil, sekme arka planda,
     kullanıcı hareketi azaltmayı açmış. Hepsi tek `canRun()` kapısında. */
  let frame = 0;
  let elapsed = 0;
  let prev = performance.now();
  let lastDraw = 0;
  let visible = true;
  let destroyed = false;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  const canRun = () => visible && !document.hidden && !reduced.matches
                       && !destroyed;

  function loop(now) {
    frame = 0;
    if (!canRun()) return;
    const dt = Math.min((now - prev) / 1000, 0.1);   // sekme dönüşünde sıçrama
    prev = now;                                       // olmasın diye tavan
    elapsed += dt;
    if (now - lastDraw >= 1000 / cfg.fps - 0.5) {
      if (loc.uTime) gl.uniform1f(loc.uTime, elapsed);
      draw();
      lastDraw = now;
    }
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (!canRun() || frame) return;
    prev = performance.now();
    frame = requestAnimationFrame(loop);
  }
  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }
  const gate = () => (canRun() ? start() : (stop(), draw()));

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    gate();
  }, { threshold: 0 });
  io.observe(container);
  document.addEventListener('visibilitychange', gate);
  reduced.addEventListener('change', gate);

  container.prepend(canvas);
  pushUniforms();
  resize();
  start();

  return {
    /** Çalışırken ayar değiştirmek için — renk, hız, katman sayısı… */
    set(o) {
      Object.assign(cfg, o);
      pushUniforms();
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', gate);
      reduced.removeEventListener('change', gate);
      canvas.remove();
      /* Bağlam sayısı tarayıcıda sınırlı (~16). Ekran değiştikçe sızarsa
         bir noktada en eski bağlam zorla kaybediliyor ve o sayfa kararıyor. */
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
