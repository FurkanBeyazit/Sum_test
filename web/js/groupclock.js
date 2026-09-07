/* ============================================================================
   groupclock.js — Parçalı kaydın duvar saati ↔ oynatma zamanı çevirisi
   ----------------------------------------------------------------------------
   SORUN
   Bir kameradan aynı güne ait üç ayrı kayıt geliyor: 07:00-08:00, 12:00-13:00,
   19:00-20:00. Kullanıcı bunları tek bir kayıt gibi izlemek istiyor — 08:00
   bitince beklemeden öğlenkine atlamalı — ama zaman çizgisinde GERÇEK saati
   görmek istiyor, aradaki dört saatlik boşluk dahil.

   Bu iki istek aynı anda ancak İKİ AYRI ZAMAN EKSENİ tutulursa karşılanır:

     duvar ekseni   07:00 ─────░░░░░░░░░─────░░░░░░░░─────  13 saat
                    │ kayıt │  boşluk  │ kayıt │ boşluk │ kayıt │
     oynatma ekseni ├───────┼──────────┴───────┼─────────────┤   3 saat
                      parça 1        parça 2        parça 3

   Zaman çizgisi DUVAR eksenini çiziyor (boşluklar yer kaplasın diye),
   oynatıcı OYNATMA eksenini kullanıyor (boşluklarda beklemesin diye).
   Aradaki çeviriyi başka hiçbir yerde elle yapma — `core.js` içindeki
   TimeMapper'ın tek kayıt için söylediği şeyin çok parçalı hâli burası.

   NEDEN BİRLEŞTİRMEK ÇÖZÜM DEĞİL
   Yükleme ekranındaki birleştirme boşlukları SİLİYOR; kodun kendi uyarısı
   da bunu söylüyor ("event wall-clock times will no longer match reality").
   Üç saatlik bir dosya elde ederdik ama 12:40'ta olan bir olayın gerçekte
   ne zaman olduğunu bir daha asla bilemezdik. Bu yüzden parçalar ayrı
   kalıyor, birleşme yalnızca izlerken oluyor.
   ========================================================================= */

import { pad } from './core.js';

export class GroupClock {
  /**
   * @param {Array} parts  [{ id, name, startMs, dur }] — dur saniye.
   *   `startMs` olmayan ya da süresi bilinmeyen parça sessizce düşer:
   *   duvar saati bilinmeyen bir kaydı zaman eksenine koyamayız.
   */
  constructor(parts) {
    this.parts = (parts || [])
      .filter((p) => p.startMs && p.dur > 0)
      .sort((a, b) => a.startMs - b.startMs);

    let play = 0;
    for (const p of this.parts) {
      p.playStart = play;
      p.playEnd = play + p.dur;
      p.wallStart = p.startMs;
      p.wallEnd = p.startMs + p.dur * 1000;
      play += p.dur;
    }
    this.playTotal = play;

    this.startMs = this.parts.length ? this.parts[0].wallStart : 0;
    this.endMs = this.parts.reduce((m, p) => Math.max(m, p.wallEnd), 0);
    this.wallTotal = Math.max(1, (this.endMs - this.startMs) / 1000);

    /* Duvar ekseninde parçaların kapladığı aralıklar (saniye, span başından). */
    this.spans = this.parts.map((p) => ({
      part: p,
      t0: (p.wallStart - this.startMs) / 1000,
      t1: (p.wallEnd - this.startMs) / 1000,
    }));

    /* Boşluklar — zaman çizgisinde gri taranacak alanlar. Bir saniyenin
       altındaki farklar boşluk değil, yuvarlama gürültüsü. */
    this.gaps = [];
    for (let i = 1; i < this.spans.length; i++) {
      const a = this.spans[i - 1], b = this.spans[i];
      if (b.t0 - a.t1 > 1) this.gaps.push({ t0: a.t1, t1: b.t0 });
    }
  }

  /** Tek parçalı bir grup normal videodan farksızdır; çağıranlar buna bakıyor. */
  get multi() { return this.parts.length > 1; }

  get startIso() {
    return this.parts.length ? new Date(this.startMs).toISOString() : null;
  }

  /** Duvar ekseni saniyesi → Date */
  date(wallSec) { return new Date(this.startMs + wallSec * 1000); }

  /** Duvar ekseni saniyesi → "HH:MM:SS" */
  clock(wallSec) {
    const d = this.date(wallSec);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /**
   * Duvar ekseni saniyesi → hangi parça, o parçanın neresi.
   *
   * BOŞLUKTA ATLAMA burada oluyor: istenen an hiçbir kaydın içinde değilse
   * SONRAKİ parçanın başına gidiyoruz. Kullanıcının "08:00 bitince direkt
   * öğlenkine geçsin" isteği tam olarak bu satır; oynatıcı parça bitince de,
   * boş bir saate atlandığında da aynı yoldan geçiyor.
   *
   * @returns {{part:object, offset:number, gap:boolean}|null}
   *   gap=true → istenen ana kayıt yok, ileriye sarıldı.
   */
  at(wallSec) {
    if (!this.spans.length) return null;
    for (const s of this.spans) {
      if (wallSec >= s.t0 && wallSec < s.t1) {
        return { part: s.part, offset: wallSec - s.t0, gap: false };
      }
    }
    const next = this.spans.find((s) => s.t0 >= wallSec);
    if (next) return { part: next.part, offset: 0, gap: true };
    const last = this.spans[this.spans.length - 1];
    return { part: last.part, offset: last.part.dur, gap: true };
  }

  /* ---------------------------------------------------------------- HLS ---
     HLS playlist grubun bütün parçalarını TEK bir çalma listesinde veriyor,
     yani `<video>.currentTime` doğrudan OYNATMA EKSENİ oluyor: parçalar
     arka arkaya, boşluklar yok. Aşağıdaki iki fonksiyon o eksenle duvar
     ekseni arasında gidip geliyor.

     Bugünkü (proxy) yolda bu ikisi kullanılmıyor; orada `<video>` tek bir
     parçayı oynatıyor ve çeviri `at()` / `wallSec()` ile yapılıyor. İkisi
     bir arada yaşasın diye ayrı tutuldular. */

  /** Oynatma ekseni saniyesi → duvar ekseni saniyesi */
  wallFromPlay(playSec) {
    if (!this.parts.length) return playSec;
    const t = Math.max(0, Math.min(this.playTotal, playSec));
    for (const p of this.parts) {
      if (t < p.playEnd || p === this.parts[this.parts.length - 1]) {
        return (p.wallStart - this.startMs) / 1000
          + Math.max(0, Math.min(p.dur, t - p.playStart));
      }
    }
    return this.wallTotal;
  }

  /**
   * Duvar ekseni saniyesi → oynatma ekseni saniyesi.
   * Boşluğa denk gelirse SONRAKİ kaydın başı — `at()` ile aynı kural.
   */
  playFromWall(wallSec) {
    const hit = this.at(wallSec);
    if (!hit) return 0;
    return hit.part.playStart + (hit.gap ? 0 : hit.offset);
  }

  /** Parça kimliği + parça içi saniye → duvar ekseni saniyesi */
  wallSec(partId, offset = 0) {
    const s = this.spans.find((x) => String(x.part.id) === String(partId));
    return s ? s.t0 + offset : offset;
  }

  /** Bir parçadan sonrakine geç — parça bittiğinde çağrılıyor. */
  next(partId) {
    const i = this.spans.findIndex((x) => String(x.part.id) === String(partId));
    return i >= 0 && i + 1 < this.spans.length ? this.spans[i + 1] : null;
  }

  /**
   * Kullanıcının yazdığı saat → duvar ekseni saniyesi.
   *
   * Kabul edilenler: "14:30", "14:30:05", "2026-09-01 14:30", ISO.
   * Saat-dakika biçimi span'in İLK GÜNÜNE göre çözülüyor; kayıt gece yarısını
   * geçiyorsa ve yazılan saat span'in başından önceyse ertesi güne alınıyor,
   * çünkü kullanıcı "01:30" yazarken kaydın başındaki günün 01:30'unu değil
   * ulaşabildiği 01:30'u kastediyor.
   *
   * @returns {number|null} aralık dışıysa null
   */
  parse(text) {
    const s = String(text || '').trim();
    if (!s) return null;

    let ms = null;
    const hm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (hm) {
      const base = new Date(this.startMs);
      base.setHours(+hm[1], +hm[2], +(hm[3] || 0), 0);
      ms = base.getTime();
      if (ms < this.startMs - 1000) ms += 86400000;   // ertesi gün
    } else {
      const d = Date.parse(s.replace(' ', 'T'));
      if (!isNaN(d)) ms = d;
    }
    if (ms == null) return null;

    const sec = (ms - this.startMs) / 1000;
    if (sec < -1 || sec > this.wallTotal + 1) return null;
    return Math.max(0, Math.min(this.wallTotal, sec));
  }

  /** Kaydın kapladığı gerçek saat aralığı: "07:00–20:00". */
  range() {
    if (!this.parts.length) return '';
    const a = this.date(0), b = this.date(this.wallTotal);
    return `${pad(a.getHours())}:${pad(a.getMinutes())}`
      + `–${pad(b.getHours())}:${pad(b.getMinutes())}`;
  }

  /** Span'in insan okunur özeti — başlıkta ve yükleme ekranında kullanılıyor. */
  summary() {
    if (!this.parts.length) return '';
    const gapSec = this.gaps.reduce((n, g) => n + (g.t1 - g.t0), 0);
    /* Arayüz metni İngilizce — bu dize doğrudan ekrana çıkıyor (ağaçtaki
       zincir satırının ipucu, Analysis başlığı). */
    const gapMin = Math.round(gapSec / 60);
    return `${this.range()} · ${this.parts.length} parts`
      + (gapSec > 0 ? ` · ${gapMin} min gap${gapMin === 1 ? '' : 's'}` : '');
  }
}

/**
 * Bir videonun kardeşlerinden saat kurar.
 *
 * Tek parça varsa `null` dönüyor: o zaman ekranın bugünkü davranışı hiç
 * değişmesin istiyoruz — çok parçalı kayıt yeni bir kip, eskisinin yerine
 * geçen bir şey değil.
 */
export function clockFor(videos) {
  const parts = (videos || []).map((v) => ({
    id: v.id,
    name: v.name,
    startMs: v.start_time ? Date.parse(v.start_time) : 0,
    dur: v.duration || 0,
    playable: v.playable ?? v.has_proxy,
  }));
  const clock = new GroupClock(parts);
  return clock.multi ? clock : null;
}
