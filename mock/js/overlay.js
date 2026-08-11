/* ============================================================================
   overlay.js — Video üstü BBox katmanı
   ----------------------------------------------------------------------------
   Bu dosya, PROJE-NOTLARI.md "10. BBox nerede çizilecek?" bölümündeki dört
   kuralı uygular:

     1. Normalize (0-1) koordinat  → ölçekten bağımsız
     2. Letterbox hesabı           → object-fit:contain kayması giderilir
     3. requestVideoFrameCallback  → timeupdate'in 4 Hz'i yerine kare hassas
     4. devicePixelRatio           → retina ekranda bulanıklık yok

   Ekstra: track yolu (trajectory), tıklama algılama, etiketler.
   ========================================================================= */

import { trackColor, COLOR_HEX } from './core.js';

export class VideoOverlay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLVideoElement}  video    (null olabilir — poster modu)
   */
  constructor(canvas, video) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;

    this.det = null;         // { fps, rows, index: Map<frameIdx, row[]> }
    this.meta = { w: 1920, h: 1080 };
    this.opts = { boxes: true, trails: true, labels: true, conf: false };
    this.filterTrackIds = null;   // null = hepsi
    this.highlightTrackId = null;
    this.attrOf = new Map();      // track_id -> attrs (renk noktası için)
    this.labelOf = new Map();     // track_id -> metin
    this.onPick = null;           // (trackId, box) => void
    this._t = 0;
    this._raf = null;
    this._vfc = null;
    this._boxesNow = [];

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    canvas.addEventListener('click', (e) => this._click(e));
    canvas.addEventListener('mousemove', (e) => this._hover(e));
    canvas.addEventListener('mouseleave', () => {
      if (this.highlightTrackId !== null && this.onHover) this.onHover(null);
    });
    this.resize();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._vfc && this.video && this.video.cancelVideoFrameCallback)
      this.video.cancelVideoFrameCallback(this._vfc);
  }

  /**
   * Sunucudan gelen kompakt satırları kare indeksine göre grupla.
   *
   * KABLO FORMATI (DB şemasıyla birebir):
   *   [t, track_id, cls, conf, bbox_x, bbox_y, bbox_width, bbox_height]
   *   bbox_* alanlarının hepsi 0~1 normalize — şemada numeric(10,7).
   *
   * İÇERİDE xyxy'ye çeviriyoruz, çünkü çizim ve hit-test için köşe
   * koordinatları daha kullanışlı. Dönüşüm TEK yerde yapılsın:
   *   x2 = x + w        y2 = y + h
   */
  setDetections(payload, meta) {
    if (meta) this.meta = meta;
    if (!payload || !payload.rows) { this.det = null; return; }
    const fps = payload.fps || 10;
    const xywh = (payload.coord || 'normalized_xywh').endsWith('xywh');
    const index = new Map();
    for (const r of payload.rows) {
      const row = xywh
        ? [r[0], r[1], r[2], r[3], r[4], r[5], r[4] + r[6], r[5] + r[7]]
        : r;                       // zaten xyxy ise dokunma
      const f = Math.round(row[0] * fps);
      if (!index.has(f)) index.set(f, []);
      index.get(f).push(row);
    }
    this.det = { fps, index, count: payload.rows.length, wire: payload.coord };
  }

  setTrackMeta(objects) {
    this.attrOf.clear(); this.labelOf.clear();
    for (const o of objects || []) {
      this.attrOf.set(o.track_id, o.attrs || {});
      this.labelOf.set(o.track_id, o.label || `#${o.track_id}`);
    }
  }

  /** DPI + boyut ayarı. Canvas CSS boyutu videonun görünen alanına eşitlenir. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cw = r.width; this._ch = r.height;
    this.draw(this._t);
  }

  /**
   * Letterbox geometrisi.
   * <video> object-fit:contain ile render edilir; element oranı videonunkiyle
   * aynı değilse üstte/altta (veya yanlarda) siyah bant oluşur. Kutuları o
   * banda göre kaydırmazsak her şey kayar.
   */
  geom() {
    const ew = this._cw, eh = this._ch;
    const vw = (this.video && this.video.videoWidth) || this.meta.w;
    const vh = (this.video && this.video.videoHeight) || this.meta.h;
    const scale = Math.min(ew / vw, eh / vh);
    const dw = vw * scale, dh = vh * scale;
    return { ox: (ew - dw) / 2, oy: (eh - dh) / 2, dw, dh, vw, vh, scale };
  }

  /** Oynatma döngüsü — kare hassas. */
  start() {
    const v = this.video;
    if (v && v.requestVideoFrameCallback) {
      const step = (now, meta) => {
        this.draw(meta.mediaTime);
        this._vfc = v.requestVideoFrameCallback(step);
      };
      this._vfc = v.requestVideoFrameCallback(step);
    } else {
      const loop = () => {
        this.draw(v ? v.currentTime : this._t);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    }
  }

  seek(t) { this._t = t; this.draw(t); }

  /* -------------------------------------------------------------- çizim -- */

  boxesAt(t) {
    if (!this.det) return [];
    const f = Math.round(t * this.det.fps);
    let rows = this.det.index.get(f);
    if (!rows) {                       // en yakın komşu kare
      for (let d = 1; d <= 3 && !rows; d++)
        rows = this.det.index.get(f - d) || this.det.index.get(f + d);
    }
    if (!rows) return [];
    if (this.filterTrackIds)
      rows = rows.filter(r => this.filterTrackIds.has(r[1]));
    return rows;
  }

  trailFor(tid, t, back = 3.0) {
    if (!this.det) return [];
    const fps = this.det.fps;
    const pts = [];
    for (let s = Math.max(0, t - back); s <= t; s += 1 / fps * 2) {
      const rows = this.det.index.get(Math.round(s * fps));
      if (!rows) continue;
      const r = rows.find(x => x[1] === tid);
      if (r) pts.push([(r[4] + r[6]) / 2, r[7]]);   // ayak noktası
    }
    return pts;
  }

  draw(t) {
    this._t = t;
    const c = this.ctx;
    if (!this._cw) return;
    c.clearRect(0, 0, this._cw, this._ch);
    if (!this.opts.boxes || !this.det) { this._boxesNow = []; return; }

    const g = this.geom();
    const X = (nx) => g.ox + nx * g.dw;
    const Y = (ny) => g.oy + ny * g.dh;
    const rows = this.boxesAt(t);
    this._boxesNow = [];

    // 1) izler (arkada)
    if (this.opts.trails) {
      for (const r of rows) {
        const tid = r[1];
        const pts = this.trailFor(tid, t);
        if (pts.length < 3) continue;
        c.save();
        c.strokeStyle = trackColor(tid);
        c.globalAlpha = .32;
        c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
        c.beginPath();
        pts.forEach((p, i) => i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])));
        c.stroke();
        c.restore();
      }
    }

    // 2) kutular
    for (const r of rows) {
      const [, tid, cls, conf, x1, y1, x2, y2] = r;
      const px = X(x1), py = Y(y1), pw = (x2 - x1) * g.dw, ph = (y2 - y1) * g.dh;
      this._boxesNow.push({ tid, cls, conf, px, py, pw, ph });

      const hot = this.highlightTrackId === tid;
      const col = trackColor(tid);
      c.save();
      c.lineWidth = hot ? 2.5 : 1.6;
      c.strokeStyle = col;
      if (hot) { c.shadowColor = col; c.shadowBlur = 12; }
      c.strokeRect(px, py, pw, ph);
      c.shadowBlur = 0;

      // köşe işaretleri — CCTV analiz görünümü
      const k = Math.min(11, pw * .3, ph * .3);
      c.lineWidth = hot ? 3 : 2;
      c.beginPath();
      c.moveTo(px, py + k); c.lineTo(px, py); c.lineTo(px + k, py);
      c.moveTo(px + pw - k, py); c.lineTo(px + pw, py); c.lineTo(px + pw, py + k);
      c.moveTo(px, py + ph - k); c.lineTo(px, py + ph); c.lineTo(px + k, py + ph);
      c.moveTo(px + pw - k, py + ph); c.lineTo(px + pw, py + ph);
      c.lineTo(px + pw, py + ph - k);
      c.stroke();

      if (hot) { c.globalAlpha = .10; c.fillStyle = col; c.fillRect(px, py, pw, ph); }
      c.restore();

      // 3) etiket
      if (this.opts.labels && ph > 26) {
        const attrs = this.attrOf.get(tid) || {};
        let txt = `#${tid} ${cls === 0 ? 'person' : 'vehicle'}`;
        if (this.opts.conf) txt += ` ${(conf * 100).toFixed(0)}%`;
        c.save();
        c.font = '600 10px ui-monospace, Consolas, monospace';
        const tw = c.measureText(txt).width;
        const lh = 14;
        const ly = py - lh - 1 < 2 ? py + 1 : py - lh - 1;
        c.fillStyle = 'rgba(4,8,13,.86)';
        c.fillRect(px, ly, tw + 16, lh);
        c.fillStyle = col;
        c.fillRect(px, ly, 2.5, lh);
        c.fillStyle = '#e8eef6';
        c.fillText(txt, px + 6, ly + 10);
        // PAR renk noktaları
        const dots = [attrs.upper_color, attrs.lower_color, attrs.vehicle_color]
          .filter(Boolean);
        dots.forEach((cc, i) => {
          c.beginPath();
          c.arc(px + tw + 10 + i * 7, ly + lh / 2, 2.6, 0, 7);
          c.fillStyle = COLOR_HEX[cc] || '#888';
          c.fill();
        });
        c.restore();
      }
    }

    // 4) sol alt: kare bilgisi
    c.save();
    c.font = '600 10px ui-monospace, Consolas, monospace';
    c.fillStyle = 'rgba(4,8,13,.72)';
    const info = `t=${t.toFixed(2)}s  obj=${rows.length}`;
    const w = c.measureText(info).width + 12;
    c.fillRect(g.ox + 6, g.oy + g.dh - 22, w, 16);
    c.fillStyle = '#9fb0c4';
    c.fillText(info, g.ox + 12, g.oy + g.dh - 10);
    c.restore();
  }

  /* ----------------------------------------------------- etkileşim ------- */

  _pt(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  _hitTest(x, y) {
    // en küçük alanlı kutu kazansın (iç içe kutularda doğru seçim)
    let best = null, bestA = Infinity;
    for (const b of this._boxesNow) {
      if (x >= b.px && x <= b.px + b.pw && y >= b.py && y <= b.py + b.ph) {
        const a = b.pw * b.ph;
        if (a < bestA) { bestA = a; best = b; }
      }
    }
    return best;
  }
  _click(e) {
    const [x, y] = this._pt(e);
    const b = this._hitTest(x, y);
    if (b && this.onPick) this.onPick(b.tid, b);
  }
  _hover(e) {
    const [x, y] = this._pt(e);
    const b = this._hitTest(x, y);
    const tid = b ? b.tid : null;
    this.cv.style.cursor = b ? 'pointer' : 'crosshair';
    if (tid !== this.highlightTrackId) {
      this.highlightTrackId = tid;
      if (this.onHover) this.onHover(tid);
      this.draw(this._t);
    }
  }
}
