/* ============================================================================
   timeline.js — Canvas tabanlı zaman ekseni
   ----------------------------------------------------------------------------
   Neden hazır kütüphane değil:
     * kamera başına satır (swimlane) + zoom/pan + skor ısı haritası +
       takip vurgusu kombinasyonu hiçbir kütüphanede hazır gelmiyor
     * 24 saatte binlerce olay → DOM tabanlı çözümler (vis-timeline) takılıyor

   İki mod:
     mode:'single' → tek video, olay blokları + playhead
     mode:'multi'  → kamera başına satır, kameralar arası bağlantı çizgileri
   ========================================================================= */

import { pad, roughDur } from './core.js';

const ROW_H = 26;
const HEAD_H = 22;          // zaman etiketleri satırı
/* Parça şeridi — YALNIZCA çok parçalı grupta çiziliyor, tek videoda başlık
   yüksekliği eskisi gibi kalıyor. Bu yüzden `HEAD_H` sabit, gerçek başlık
   yüksekliği `this.hh`. */
const SPAN_H = 17;
/* Boşlukların rengi. Ne olay rengi ne playhead mavisi olmalı: "burada veri
   yok" başka bir bilgi türü, kendi rengini hak ediyor. */
const GAP_COL = '#f59e0b';
const LANE_LABEL_W = 96;

export class Timeline {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = opts.mode || 'single';
    this.lanes = [];          // [{ id, label, sub, events:[], color }]
    this.t0 = 0;              // görünen pencere başı (saniye)
    this.t1 = 60;             // görünen pencere sonu — setData tümüne açıyor
    this.total = 60;          // toplam süre
    /* Kullanıcı zoom/pan yaptı mı? `setData` buna bakıyor: yapmadıysa yeni
       veri geldiğinde pencere tüm süreye açılıyor. Eskiden başlangıç değeri
       60 sn olarak kalıyordu ve 5 dakikalık bir video ilk 60 saniyesine
       zoomlanmış açılıyordu — kullanıcı tekerlekle uzaklaşmadan tamamını
       göremiyordu. */
    this._userZoom = false;
    this.playhead = 0;
    this.startIso = null;     // duvar saati gösterimi için
    /* Kayıt olmayan aralıklar — çok parçalı grupta iki kayıt arasındaki
       boşluklar (bkz. groupclock.js). Ekseni GERÇEK saat kapladığı için bu
       aralıklar da yer kaplıyor; boş bırakmak yerine taranıp "kayıt yok"
       diye işaretleniyorlar, yoksa kullanıcı orayı sessiz bir kayıt sanıyor. */
    this.gaps = null;         // [{t0,t1}] saniye
    /* Kayıtların KENDİSİ — boşluğun tersi. Boşluğu taramak "burada yok"
       diyor ama "nerede var" sorusunu cevaplamıyor: hangi parça saat kaçta
       başlayıp kaçta bitiyor, kullanıcı bunu eksende göremiyordu. */
    this.spans = null;        // [{t0,t1,idx}] saniye
    this.heat = null;         // [{t0,t1,score,candidate}] — aday구간 skorları
    this.heatThreshold = null;
    this.tracks = null;       // [{t0,t1,laneId,color,label}] — takip vurgusu
    this.onSeek = opts.onSeek || null;
    this.onPickEvent = opts.onPickEvent || null;
    /* ---------------------------------------------------------- bağlama ---
       İki şeridi "aynı kişi" diye işaretlemenin yolu: renkli şeritten
       basılı tutup ötekine sürüklemek. Sürüklerken imleci bir çizgi takip
       ediyor, altından geçilen şerit vurgulanıyor ve (onHoverEvent ile)
       o an ekranda oynatılıyor — kullanıcı bırakmadan önce aynı kişi mi
       diye bakabiliyor. Bırakınca iki şerit tek renge geliyor ve çizgi
       kayboluyor: kimlik artık renkte, çizgiye gerek yok. */
    this.onLinkEvent = opts.onLinkEvent || null;   // (fromEv, toEv) => void
    /* (hedef|null, kaynak) — kaynağı da veriyoruz: ekranda "kimden kime"
       gösterilebilsin. Sürükleme sırasında asıl soru bu. */
    this.onHoverEvent = opts.onHoverEvent || null;
    this.activeEventId = null;
    this.hover = null;
    this._drag = null;
    this._pending = null;    // basıldı ama henüz tık mı sürükleme mi belli değil
    this.link = null;        // { from, x, y, over }

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    canvas.addEventListener('mousedown', e => this._down(e));
    canvas.addEventListener('mousemove', e => this._move(e));
    this._onUp = () => this._up();
    window.addEventListener('mouseup', this._onUp);
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      /* Sürükleme sürüyorsa iptal etme — imleç geri gelebilir. Sadece
         hedefi düşür ki tuval dışında bırakmak yanlışlıkla bağlamasın;
         karşılaştırma şeridi de kapansın, yoksa ekranda asılı kalıyor. */
      if (this.link && this.link.over) {
        this.link.over = null;
        if (this.onHoverEvent) this.onHoverEvent(null, this.link.from);
      }
      this.draw();
    });
    canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.fit());
    this.resize();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('mouseup', this._onUp);
  }

  setData({ lanes, total, startIso, heat, tracks, heatThreshold, gaps, spans }) {
    if (heatThreshold !== undefined) this.heatThreshold = heatThreshold;
    if (lanes) this.lanes = lanes;
    if (total !== undefined) { this.total = total; }
    if (startIso !== undefined) this.startIso = startIso;
    if (gaps !== undefined) this.gaps = gaps;
    /* GroupClock.spans doğrudan verilebilsin diye burada normalleşiyor:
       zaman çizgisi `part` nesnesinin şeklini bilmek zorunda kalmasın. */
    if (spans !== undefined) {
      this.spans = spans && spans.length
        ? spans.map((s, i) => ({ t0: s.t0, t1: s.t1, idx: i + 1 }))
        : null;
    }
    this.heat = heat || null;
    this.tracks = tracks || null;
    // Kullanıcı kendi penceresini seçmediyse her zaman tümünü göster.
    if (!this._userZoom || this.t1 <= this.t0 || this.t1 > this.total * 1.5) {
      this.fit();
    }
    this.resize();
  }

  fit() {
    this.t0 = 0;
    this.t1 = this.total || 1;
    this._userZoom = false;      // "tümü" hâli, zoom sayılmaz
    this.draw();
  }

  /** Parça şeridi çiziliyor mu? Tek parçalı kayıtta gösterecek bir şey yok. */
  get hasSpans() { return !!(this.spans && this.spans.length > 1); }

  /** Gerçek başlık yüksekliği — parça şeridi varsa o kadar uzuyor. */
  get hh() { return HEAD_H + (this.hasSpans ? SPAN_H : 0); }

  /** Şeritlerin başladığı y. */
  get lanesY() { return this.hh; }

  height() {
    return this.lanesY + Math.max(1, this.lanes.length) * ROW_H + 10;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth || this.cv.parentElement.clientWidth || 600;
    const h = this.height();
    this.cv.style.height = h + 'px';
    this.cv.width = Math.round(w * dpr);
    this.cv.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = w; this._h = h;
    this.draw();
  }

  /* ------------------------------------------------- koordinat dönüşümü -- */
  get plotX() { return this.mode === 'multi' ? LANE_LABEL_W : 0; }
  get plotW() { return Math.max(10, this._w - this.plotX - 4); }
  X(t) { return this.plotX + (t - this.t0) / (this.t1 - this.t0) * this.plotW; }
  T(x) { return this.t0 + (x - this.plotX) / this.plotW * (this.t1 - this.t0); }

  /**
   * Eksen etiketi. `startIso` yoksa GEÇEN SÜRE gösterilir — tek video
   * ekranında istenen bu: oynatıcı 00:00'dan sayıyor, eksen de öyle saymalı.
   * Bir saati aşan kayıtlarda mm:ss yanıltıcı olduğu için saat basamağı da
   * yazılıyor.
   */
  wallLabel(t) {
    if (!this.startIso) {
      const s = Math.max(0, t);
      return s >= 3600
        ? `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`
        : `${pad(s / 60)}:${pad(s % 60)}`;
    }
    const d = new Date(Date.parse(this.startIso) + t * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /* ------------------------------------------------------------- çizim --- */
  draw() {
    const c = this.ctx;
    if (!this._w) return;
    const W = this._w, H = this._h;
    c.clearRect(0, 0, W, H);

    // zemin
    c.fillStyle = '#0a0e14';
    c.fillRect(0, 0, W, H);

    const span = this.t1 - this.t0;
    // --- ızgara + zaman etiketleri ---------------------------------------
    const targetTicks = Math.max(4, Math.floor(this.plotW / 92));
    const raw = span / targetTicks;
    const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
      3600, 7200, 10800, 21600, 43200];
    const step = nice.find(n => n >= raw) || 86400;
    const first = Math.ceil(this.t0 / step) * step;

    c.font = '10px ui-monospace, Consolas, monospace';
    c.textBaseline = 'middle';
    for (let t = first; t <= this.t1; t += step) {
      const x = this.X(t);
      c.strokeStyle = '#18222f';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + .5, this.hh); c.lineTo(x + .5, H); c.stroke();
      c.fillStyle = '#526375';
      c.fillText(this.wallLabel(t), x + 4, HEAD_H / 2);
    }
    c.strokeStyle = '#223046';
    c.beginPath(); c.moveTo(0, this.hh + .5); c.lineTo(W, this.hh + .5); c.stroke();

    // --- parça şeridi ------------------------------------------------------
    if (this.hasSpans) this._drawSpans(c);

    // --- kayıt olmayan aralıklar -----------------------------------------
    /* Çapraz tarama, düz blok değil: düz bir blok "burada bir şey var ama
       boş" gibi okunuyor, tarama "burada veri yok" diyor. Süre TEK BİR
       yerde yazılıyor: burada, dikeyde ortada. Parça şeridinde de yazınca
       aynı sayı iki kez okunuyor ve göz yoruyordu. */
    if (this.gaps && this.gaps.length) {
      const yTop = this.hh + 1;
      for (const g of this.gaps) {
        if (g.t1 <= this.t0 || g.t0 >= this.t1) continue;
        const x0 = Math.max(this.plotX, this.X(g.t0));
        const x1 = Math.min(this.plotX + this.plotW, this.X(g.t1));
        const w = x1 - x0;
        if (w >= 1) {
          c.save();
          c.beginPath(); c.rect(x0, yTop, w, H - yTop); c.clip();
          c.fillStyle = '#0a0d13';
          c.fillRect(x0, yTop, w, H - yTop);
          /* Tarama artık kehribar: eski gri (#1b2735) zeminden neredeyse
             ayrışmıyordu ve boşluk "sessiz bir kayıt" gibi okunuyordu. */
          c.strokeStyle = 'rgba(245,158,11,.22)';
          c.lineWidth = 1.2;
          c.beginPath();
          for (let x = x0 - H; x < x1 + H; x += 8) {
            c.moveTo(x, H); c.lineTo(x + H, yTop);
          }
          c.stroke();
          if (w > 46) {
            /* Tek etiket, dikeyde satırların ortasında: boşluğun ne kadar
               sürdüğü orada okunuyor, başka hiçbir yerde tekrarlanmıyor. */
            const cx = (x0 + x1) / 2, cy = yTop + (H - yTop) / 2;
            const len = roughDur(g.t1 - g.t0);
            c.font = '700 10px ui-monospace, Consolas, monospace';
            c.textAlign = 'center'; c.textBaseline = 'middle';
            const tw = c.measureText(len).width;
            c.fillStyle = 'rgba(8,12,18,.9)';
            c.fillRect(cx - tw / 2 - 5, cy - 8, tw + 10, 16);
            c.fillStyle = GAP_COL;
            c.fillText(len, cx, cy);
            c.textAlign = 'left';
          }
          c.restore();
        }
        /* Kenar çizgileri BLOĞUN DIŞINDA çiziliyor: uzaklaşınca boşluk bir
           piksele düşüyor, tarama görünmez oluyor ama kesikli çizgi hâlâ
           "burada kayıt kesildi" diyor. */
        c.save();
        c.strokeStyle = GAP_COL;
        c.lineWidth = 1.5;
        c.setLineDash([4, 3]);
        for (const gx of [this.X(g.t0), this.X(g.t1)]) {
          if (gx < this.plotX - 1 || gx > this.plotX + this.plotW + 1) continue;
          c.beginPath();
          c.moveTo(gx + .5, HEAD_H); c.lineTo(gx + .5, H);
          c.stroke();
        }
        c.setLineDash([]);
        c.restore();
      }
    }

    // --- aday구간 skoru şeridi (event_candidate_score) --------------------
    // Yükseklik = ihlal skoru, renk = eşiği aştı mı. Kural tabanlı motorun
    // "burayı VLM'e gönderdim çünkü…" cevabının görsel hâli.
    if (this.heat && this.heat.length) {
      const H0 = this.hh + 1, HB = 7;
      c.fillStyle = '#0f1721';
      c.fillRect(this.plotX, H0, this.plotW, HB);
      for (const h of this.heat) {
        if (h.t1 < this.t0 || h.t0 > this.t1) continue;
        const x = this.X(h.t0), w = Math.max(1, this.X(h.t1) - x);
        const bh = Math.max(1, HB * Math.min(1, h.score));
        c.fillStyle = h.candidate
          ? `rgba(56,189,248,${0.45 + 0.5 * h.score})`
          : `rgba(100,116,139,${0.25 + 0.3 * h.score})`;
        c.fillRect(x, H0 + (HB - bh), w, bh);
      }
      // eşik çizgisi
      const thr = this.heatThreshold;
      if (thr) {
        c.strokeStyle = 'rgba(239,68,68,.55)';
        c.lineWidth = 1;
        c.setLineDash([3, 3]);
        const y = H0 + HB - HB * thr + .5;
        c.beginPath(); c.moveTo(this.plotX, y); c.lineTo(this._w, y); c.stroke();
        c.setLineDash([]);
      }
    }

    // --- satırlar ---------------------------------------------------------
    const LY = this.lanesY;
    this.lanes.forEach((lane, i) => {
      const y = LY + i * ROW_H;
      if (i % 2 === 0) { c.fillStyle = '#0d131b'; c.fillRect(0, y, W, ROW_H); }

      if (this.mode === 'multi') {
        c.fillStyle = '#10161f';
        c.fillRect(0, y, LANE_LABEL_W, ROW_H);
        c.strokeStyle = '#18222f';
        c.beginPath(); c.moveTo(LANE_LABEL_W + .5, y);
        c.lineTo(LANE_LABEL_W + .5, y + ROW_H); c.stroke();
        c.fillStyle = lane.color || '#9fb0c4';
        c.fillRect(4, y + 6, 3, ROW_H - 12);
        c.font = '600 11px "Malgun Gothic", sans-serif';
        c.fillStyle = '#c8d4e2';
        c.fillText(lane.label, 13, y + ROW_H / 2 - 4);
        c.font = '9px "Malgun Gothic", sans-serif';
        c.fillStyle = '#526375';
        c.fillText(lane.sub || '', 13, y + ROW_H / 2 + 7);
      }

      // olay blokları
      for (const e of lane.events || []) {
        if (e.t_end < this.t0 || e.t_start > this.t1) continue;
        const x = this.X(e.t_start);
        const w = Math.max(2.5, this.X(e.t_end) - x);
        const active = e.id === this.activeEventId;
        const hov = this.hover && this.hover.id === e.id;
        const h = e.severity === 'critical' ? ROW_H - 8 : ROW_H - 12;
        const by = y + (ROW_H - h) / 2;

        c.save();
        /* ŞERİT HİYERARŞİSİ. Kullanıcının renklendirdiği şerit (`marked`)
           kendi rengiyle hafifçe parlıyor, boyanmamış olan sönük kalıyor.
           200 track dört satıra paketlendiğinde hepsi aynı ağırlıkta
           çizilirse işaretlenen kişi kalabalığın içinde kayboluyordu —
           renk vermenin tek amacı onu bulmaktı. */
        c.globalAlpha = active ? 1 : (hov ? .95 : (e.marked ? .92 : .5));
        c.fillStyle = e.color || '#64748b';
        this._rr(c, x, by, w, h, 2.5);
        c.fill();
        if (e.severity === 'critical') {
          c.globalAlpha = 1;
          c.strokeStyle = '#fff'; c.lineWidth = 1;
          this._rr(c, x, by, w, h, 2.5); c.stroke();
        }
        if (active || e.marked) {
          c.globalAlpha = 1;
          c.shadowColor = e.color; c.shadowBlur = active ? 12 : 7;
          this._rr(c, x, by, w, h, 2.5); c.fill();
        }
        c.restore();

        // yeterince genişse metin yaz
        if (w > 54) {
          c.save();
          c.beginPath(); c.rect(x + 3, by, w - 6, h); c.clip();
          c.font = '600 9.5px "Malgun Gothic", sans-serif';
          c.fillStyle = 'rgba(6,10,14,.85)';
          c.fillText(e.type_ko || e.type || '', x + 5, by + h / 2);
          c.restore();
        }
      }

      // takip vurgusu (Re-ID)
      if (this.tracks) {
        for (const tr of this.tracks) {
          if (tr.laneId !== lane.id) continue;
          if (tr.t1 < this.t0 || tr.t0 > this.t1) continue;
          const x = this.X(tr.t0), w = Math.max(4, this.X(tr.t1) - x);
          c.save();
          c.strokeStyle = tr.color || '#f472b6';
          c.lineWidth = 2.5; c.setLineDash([]);
          c.beginPath();
          c.moveTo(x, y + ROW_H - 3.5); c.lineTo(x + w, y + ROW_H - 3.5);
          c.stroke();
          c.fillStyle = tr.color || '#f472b6';
          c.beginPath(); c.arc(x, y + ROW_H - 3.5, 3, 0, 7); c.fill();
          c.beginPath(); c.arc(x + w, y + ROW_H - 3.5, 3, 0, 7); c.fill();
          c.restore();
        }
        // kameralar arası bağlantı (aynı kişi başka kamerada)
        if (this.mode === 'multi') this._drawLinks(c);
      }
    });

    // --- playhead ----------------------------------------------------------
    if (this.playhead >= this.t0 && this.playhead <= this.t1) {
      const x = this.X(this.playhead);
      c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, HEAD_H); c.lineTo(x, H); c.stroke();
      c.fillStyle = '#38bdf8';
      c.beginPath();
      c.moveTo(x - 5, HEAD_H); c.lineTo(x + 5, HEAD_H); c.lineTo(x, HEAD_H + 6);
      c.closePath(); c.fill();
      const lbl = this.wallLabel(this.playhead);
      c.font = '700 10px ui-monospace, Consolas, monospace';
      const tw = c.measureText(lbl).width;
      const lx = Math.min(W - tw - 10, Math.max(2, x - tw / 2 - 4));
      c.fillStyle = '#38bdf8';
      c.fillRect(lx, 1, tw + 8, HEAD_H - 4);
      c.fillStyle = '#04121b';
      c.fillText(lbl, lx + 4, HEAD_H / 2 - 1);
    }

    // --- bağlama çizgisi ---------------------------------------------------
    if (this.link) this._drawLink(c);

    // --- hover ipucu -------------------------------------------------------
    if (this.hover && !this.link) this._tooltip(c, this.hover);

    // --- zoom göstergesi ---------------------------------------------------
    if (span < this.total * .98) {
      const bw = 60, bx = W - bw - 6, by = 4;
      c.fillStyle = '#18222f'; c.fillRect(bx, by, bw, 5);
      c.fillStyle = '#38bdf8';
      c.fillRect(bx + bw * (this.t0 / this.total), by,
        Math.max(2, bw * (span / this.total)), 5);
    }
  }

  /**
   * Parça şeridi — başlığın altında, eksenin tamamı boyunca.
   *
   * Boşluk taraması "burada kayıt yok" diyor; bu şerit onun tersini söylüyor:
   * kayıt NEREDE var, hangi parça, saat kaçtan kaça. İkisi yan yana olunca
   * "08:00'da bitti, 12:00'de devam etti" bilgisi tek bakışta okunuyor —
   * kullanıcının eksende bulamadığı şey buydu.
   *
   * Kutuların içine sığdığı kadarı yazılıyor: dar kutuda yalnızca sıra
   * numarası, orta genişlikte başlangıç saati, genişte tam aralık.
   */
  _drawSpans(c) {
    const y = HEAD_H + 2, h = SPAN_H - 4;
    const px = this.plotX, pw = this.plotW + 4;

    c.save();
    c.beginPath(); c.rect(px, HEAD_H, pw, SPAN_H); c.clip();
    c.fillStyle = '#080b10';
    c.fillRect(px, HEAD_H, pw, SPAN_H);
    c.textBaseline = 'middle';

    for (const s of this.spans) {
      if (s.t1 < this.t0 || s.t0 > this.t1) continue;
      const x0 = this.X(s.t0);
      const w = Math.max(2, this.X(s.t1) - x0);

      c.fillStyle = '#14324b';
      this._rr(c, x0, y, w, h, 3); c.fill();
      c.strokeStyle = '#2f7fb5'; c.lineWidth = 1;
      this._rr(c, x0 + .5, y + .5, w - 1, h - 1, 3); c.stroke();

      /* Uç işaretleri: kaydın BAŞLADIĞI ve BİTTİĞİ an. Kutunun kenarı
         zaten orada ama iki parça birbirine yakınsa kenarlar birleşiyor. */
      c.fillStyle = '#7dd3fc';
      c.fillRect(x0, y, 2, h);
      c.fillRect(x0 + w - 2, y, 2, h);

      const from = this.wallLabel(s.t0).slice(0, 5);
      const to = this.wallLabel(s.t1).slice(0, 5);
      let txt = '';
      if (w > 118) txt = `${s.idx} · ${from}–${to}`;
      else if (w > 62) txt = `${s.idx} · ${from}`;
      else if (w > 16) txt = String(s.idx);
      if (txt) {
        c.save();
        c.beginPath(); c.rect(x0 + 3, y, w - 6, h); c.clip();
        c.font = '700 9.5px ui-monospace, Consolas, monospace';
        c.fillStyle = '#cfe6f8';
        c.fillText(txt, x0 + 6, y + h / 2);
        c.restore();
      }
    }

    /* Boşluk şeritte yalnızca kesikli bir bağlantı: süre BİR KEZ, satırların
       ortasında yazılıyor (bkz. draw). Aynı sayıyı iki yerde göstermek
       ekranı yoruyordu. */
    if (this.gaps) {
      for (const g of this.gaps) {
        const x0 = this.X(g.t0), x1 = this.X(g.t1);
        if (x1 < px || x0 > px + pw) continue;
        c.strokeStyle = GAP_COL;
        c.lineWidth = 1; c.setLineDash([2, 2]);
        c.beginPath();
        c.moveTo(x0, y + h / 2); c.lineTo(x1, y + h / 2);
        c.stroke();
        c.setLineDash([]);
      }
    }
    c.restore();

    // şeridi eksenden ayıran çizgi
    c.strokeStyle = '#223046';
    c.beginPath();
    c.moveTo(0, HEAD_H + .5); c.lineTo(this._w, HEAD_H + .5);
    c.stroke();
  }

  /**
   * Sürüklenen bağlama çizgisi.
   *
   * Kaynak şeridin ortasından imlece; hedefin üstündeyken imleç yerine
   * hedefin ortasına yapışıyor ve şerit çerçeveleniyor. Yapışma önemli:
   * çizginin nereye ineceği bırakmadan ÖNCE belli olmalı, yoksa kullanıcı
   * yanlış şeride bağlayıp bunu ancak sonradan fark ediyor.
   */
  _drawLink(c) {
    const L = this.link;
    const col = L.from.color || '#ef4444';
    const sx = (this.X(L.from.t_start) + this.X(L.from.t_end)) / 2;
    const sy = L.from._y;
    let ex = L.x, ey = L.y;

    if (L.over) {
      ex = (this.X(L.over.t_start) + this.X(L.over.t_end)) / 2;
      ey = L.over._y;
    }

    c.save();
    c.strokeStyle = col;
    c.lineWidth = 2;
    c.globalAlpha = L.over ? 1 : .75;
    c.shadowColor = col; c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(sx, sy);
    /* Yatay kontrol noktalı bezier: iki şerit aynı satırdaysa bile çizgi
       şeritlerin üstünden geçmiyor, kavis yapıp ayırt ediliyor. */
    const dx = Math.max(24, Math.abs(ex - sx) * .4);
    c.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey);
    c.stroke();
    c.shadowBlur = 0;

    // kaynak ucu
    c.fillStyle = col;
    c.beginPath(); c.arc(sx, sy, 3.5, 0, 7); c.fill();

    if (L.over) {
      // hedef şeridi çerçevele — bırakınca buraya bağlanacak
      const x = this.X(L.over.t_start);
      const w = Math.max(6, this.X(L.over.t_end) - x);
      const h = ROW_H - 8;
      c.globalAlpha = 1;
      c.strokeStyle = col; c.lineWidth = 2;
      c.setLineDash([]);
      this._rr(c, x - 2, ey - h / 2, w + 4, h, 3.5); c.stroke();
      c.fillStyle = col;
      c.beginPath(); c.arc(ex, ey, 4.5, 0, 7); c.fill();
    } else {
      // serbest uç: küçük bir artı, "henüz bir hedef yok"
      c.globalAlpha = .9;
      c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(ex - 5, ey); c.lineTo(ex + 5, ey);
      c.moveTo(ex, ey - 5); c.lineTo(ex, ey + 5);
      c.stroke();
    }
    c.restore();
  }

  _rr(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  _drawLinks(c) {
    const byId = new Map(this.lanes.map((l, i) => [l.id, i]));
    const sorted = [...this.tracks].sort((a, b) => a.t0 - b.t0);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (a.laneId === b.laneId) continue;
      const ia = byId.get(a.laneId), ib = byId.get(b.laneId);
      if (ia === undefined || ib === undefined) continue;
      const x1 = this.X(a.t1), x2 = this.X(b.t0);
      const y1 = this.lanesY + ia * ROW_H + ROW_H - 3.5;
      const y2 = this.lanesY + ib * ROW_H + ROW_H - 3.5;
      c.save();
      c.strokeStyle = a.color || '#f472b6';
      c.globalAlpha = .5; c.lineWidth = 1.4; c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x1, y1);
      c.bezierCurveTo(x1 + 22, y1, x2 - 22, y2, x2, y2);
      c.stroke();
      c.restore();
    }
  }

  _tooltip(c, e) {
    const lines = [
      this.wallLabel(e.t_start) + ' – ' + this.wallLabel(e.t_end),
      e.description || '',
    ];
    c.font = '11px "Malgun Gothic", sans-serif';
    const w = Math.min(300, Math.max(...lines.map(l => c.measureText(l).width)) + 18);
    const lh = 15, h = lines.length * lh + 10;
    let x = Math.min(this._w - w - 6, Math.max(4, this.X(e.t_start) + 8));
    let y = e._y - h - 6;
    if (y < this.hh + 2) y = e._y + 22;
    c.save();
    c.fillStyle = 'rgba(10,16,24,.97)';
    this._rr(c, x, y, w, h, 5); c.fill();
    c.strokeStyle = e.color || '#334155'; c.lineWidth = 1;
    this._rr(c, x, y, w, h, 5); c.stroke();
    c.fillStyle = '#e8eef6';
    lines.forEach((l, i) => {
      c.font = i === 0 ? '700 10px ui-monospace, Consolas, monospace'
        : '11px "Malgun Gothic", sans-serif';
      c.fillStyle = i === 0 ? (e.color || '#9fb0c4') : '#c8d4e2';
      // uzun metni kırp
      let s = l;
      while (c.measureText(s).width > w - 16 && s.length > 4)
        s = s.slice(0, -2);
      if (s !== l) s += '…';
      c.fillText(s, x + 8, y + 8 + i * lh + lh / 2);
    });
    c.restore();
  }

  /* --------------------------------------------------------- etkileşim --- */
  _pt(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  _pick(x, y) {
    if (y < this.lanesY) return null;
    const i = Math.floor((y - this.lanesY) / ROW_H);
    const lane = this.lanes[i];
    if (!lane) return null;
    const t = this.T(x);
    for (const e of lane.events || []) {
      const ex = this.X(e.t_start), ew = Math.max(4, this.X(e.t_end) - ex);
      if (x >= ex - 2 && x <= ex + ew + 2)
        return { ...e, _y: this.lanesY + i * ROW_H + ROW_H / 2, _lane: lane };
    }
    return null;
  }
  _down(e) {
    const [x, y] = this._pt(e);
    if (e.shiftKey || e.button === 1) { this._drag = { x, t0: this.t0, t1: this.t1 }; return; }
    const hit = this._pick(x, y);
    /* Şeride basıldı: tık mı sürükleme mi henüz belli değil. Karar `_move`
       içinde eşiği geçince veriliyor — eskiden basar basmaz `onPickEvent`
       ateşleniyordu ve sürüklemeye yer kalmıyordu. */
    if (hit) { this._pending = { ev: hit, x, y }; return; }
    if (x > this.plotX && this.onSeek) this.onSeek(Math.max(0, Math.min(this.total, this.T(x))));
  }

  /** Fare bırakıldı: sürükleme bağlar, sürüklemeyen tık seçer. */
  _up() {
    this._drag = null;
    if (this.link) {
      const { from, over } = this.link;
      this.link = null;
      this._pending = null;
      this.cv.style.cursor = 'default';
      // sürükleme bitti: karşılaştırma şeridi kalksın
      if (this.onHoverEvent) this.onHoverEvent(null, from);
      if (over && over.id !== from.id && this.onLinkEvent) {
        this.onLinkEvent(from, over);
      } else {
        this.draw();
      }
      return;
    }
    const p = this._pending;
    this._pending = null;
    if (p && this.onPickEvent) this.onPickEvent(p.ev);
  }

  _move(e) {
    const [x, y] = this._pt(e);
    if (this._drag) {
      const span = this._drag.t1 - this._drag.t0;
      const dt = (x - this._drag.x) / this.plotW * span;
      let a = this._drag.t0 - dt, b = this._drag.t1 - dt;
      if (a < 0) { b -= a; a = 0; }
      if (b > this.total) { a -= b - this.total; b = this.total; }
      this.t0 = Math.max(0, a); this.t1 = Math.min(this.total, b);
      this._userZoom = !(this.t0 <= 0 && this.t1 >= this.total);
      this.draw();
      return;
    }
    /* Eşiği geçen hareket = bağlama sürüklemesi. 4 piksel: elin titremesi
       tıkı sürüklemeye çevirmesin, ama niyetli bir hareket hemen anlaşılsın. */
    if (this._pending && !this.link && this.onLinkEvent) {
      const d = Math.hypot(x - this._pending.x, y - this._pending.y);
      if (d > 4) this.link = { from: this._pending.ev, x, y, over: null };
    }
    if (this.link) {
      this.link.x = x; this.link.y = y;
      const t = this._pick(x, y);
      const tgt = t && t.id !== this.link.from.id ? t : null;
      const changed = (tgt && tgt.id) !== (this.link.over && this.link.over.id);
      this.link.over = tgt;
      this.cv.style.cursor = tgt ? 'alias' : 'grabbing';
      /* Hedefin üstüne gelindiği anda o an oynatılıyor — bırakmadan önce
         "aynı kişi mi" sorusunun cevabı ekranda olsun. */
      if (changed && this.onHoverEvent) {
        this.onHoverEvent(tgt, this.link.from);
      }
      this.draw();
      return;
    }
    const hit = this._pick(x, y);
    const changed = (hit && hit.id) !== (this.hover && this.hover.id);
    this.hover = hit;
    this.cv.style.cursor = hit ? 'pointer' : (x > this.plotX ? 'crosshair' : 'default');
    if (changed || hit) this.draw();
  }
  _wheel(e) {
    e.preventDefault();
    const [x] = this._pt(e);
    const t = this.T(x);
    const f = e.deltaY > 0 ? 1.22 : 1 / 1.22;
    let a = t - (t - this.t0) * f;
    let b = t + (this.t1 - t) * f;
    if (b - a > this.total) { a = 0; b = this.total; }
    if (b - a < 0.8) return;
    this.t0 = Math.max(0, a); this.t1 = Math.min(this.total, b);
    if (this.t1 <= this.t0) return this.fit();
    // Kullanicinin kendi secimi: yeni veri gelince ustune yazma.
    this._userZoom = !(this.t0 <= 0 && this.t1 >= this.total);
    this.draw();
  }
}
