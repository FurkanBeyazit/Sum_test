/* ============================================================================
   bboxfeed.js — Kutu verisi için kayan pencere
   ----------------------------------------------------------------------------
   NEDEN VAR
   Kutu ucu kare kare veri döndürüyor ve ölçtüğümüz gerçek yoğunluk 30 fps'te
   saniyede ~370 kutu / ~100 KB. On dakikalık bir kayıt tek istekte 60 MB eder;
   tarayıcı indirir ama JSON'u çözerken donar ve tamamı bellekte kalır.

   Oysa kullanıcı her an tek bir yirmi saniyeyi izliyor. Bu modül playhead'in
   çevresinde üç pencere tutuyor (önceki / şimdiki / sonraki), gerisini atıyor.
   Böylece bellek sabit kalıyor, ileri sarma anında hazır oluyor ve toplam veri
   yalnızca gerçekten izlenen bölüm kadar iniyor.

   Sunucu `stride`/`fps` parametresi eklerse burada tek satır değişir ve
   indirilen miktar bir kat daha düşer — 30 fps kutu zaten gereksiz.

   KULLANIM
     const feed = bboxFeed(videoId, overlay, meta, duration);
     videoEl.addEventListener('timeupdate', () => feed.at(videoEl.currentTime));
     onLeave(() => feed.dispose());
   ========================================================================= */

import { api } from './core.js';

/* Pencere boyu (saniye). 20 sn ≈ 2 MB; üçü birden ≈ 6 MB. */
const WIN = 20;

export function bboxFeed(videoId, overlay, meta, duration) {
  const rows = new Map();        // pencere indeksi -> satır dizisi
  const busy = new Set();        // indirilmekte olan pencereler
  let fps = 0;
  let center = -1;
  let alive = true;

  const last = duration > 0 ? Math.floor((duration - 0.001) / WIN) : 0;

  /** Tutulan pencereleri tek yığın hâlinde overlay'e verir. */
  function paint() {
    const all = [];
    for (const i of [center - 1, center, center + 1]) {
      const r = rows.get(i);
      if (r) all.push(...r);
    }
    /* setDetections tamamını yeniden indeksliyor ama bu yalnızca pencere
       değiştiğinde, yani yirmi saniyede bir oluyor — 20 bin satır için
       birkaç milisaniye. Overlay'e birleştirme mantığı eklemekten iyi. */
    overlay.setDetections({ fps: fps || 30, coord: 'xyxy_norm', rows: all }, meta);
    overlay.redraw();
  }

  async function load(i) {
    if (i < 0 || i > last || rows.has(i) || busy.has(i)) return;
    busy.add(i);
    try {
      const d = await api.detections(videoId, {
        from: i * WIN, to: Math.min((i + 1) * WIN, duration),
      });
      if (!alive) return;
      if (d.fps > fps) fps = d.fps;
      rows.set(i, d.rows);
      // Bu arada playhead uzaklaşmış olabilir; sadece hâlâ işe yarıyorsa çiz.
      if (Math.abs(i - center) <= 1) paint();
    } catch {
      /* Tek pencerenin düşmesi ekranı bozmasın: o aralıkta kutu çizilmez,
         sonraki pencerede kaldığı yerden devam eder. */
    } finally {
      busy.delete(i);
    }
  }

  return {
    /** Playhead değiştikçe çağrılır. Aynı pencere içindeyse hiçbir şey yapmaz. */
    at(t) {
      if (!alive) return;
      const i = Math.max(0, Math.floor(t / WIN));
      if (i === center) return;
      center = i;
      for (const k of [...rows.keys()]) {
        if (Math.abs(k - i) > 1) rows.delete(k);      // pencereyi boşalt
      }
      paint();
      load(i);
      load(i + 1);       // ileriye doğru önden çek
      load(i - 1);
    },
    dispose() { alive = false; rows.clear(); },
  };
}
