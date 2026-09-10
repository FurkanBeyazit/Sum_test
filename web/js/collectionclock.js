/* ============================================================================
   collectionclock.js — birden çok video grubunu TEK eksende
   ----------------------------------------------------------------------------
   SORUN
   Bir koleksiyonda birden çok kamera var ve kullanıcı şunu soruyor: "burada
   gördüğüm adam aynı anda öbür kamerada var mıydı?" Bu sorunun cevabı ancak
   bütün gruplar AYNI ZAMAN EKSENİNE oturursa okunuyor.

   AMA HANGİ EKSEN? İKİ HİZALAMA VAR VE İKİSİ DE DURUYOR
   ------------------------------------------------------
     align: 'zero'  (VARSAYILAN) → her grup kendi 00:00'ından başlar, eksen
                     en uzun grubun süresi kadar.
     align: 'wall'  → gerçek saat: gruplar `start_at`e göre yerleşir,
                     aradaki boşluklar eksende yer kaplar.

   'wall' teoride doğru olan: aynı dikey çizgi aynı ANA denk gelir ve yukarıdaki
   soru doğrudan okunur. Pratikte ise ancak kameralar gerçekten örtüşen
   saatlerde kaydettiyse işe yarıyor. Gerçek veride bir grup 11:28'de, öteki
   13:06'da başlıyor; 'wall' hizalamada eksenin çoğu boş tarama oluyor ve iki
   kamerayı yan yana getirmek için açılan ekran onları birbirinden
   uzaklaştırıyor.

   Bu yüzden varsayılan 'zero': "sanki aynı anda çekilmiş" varsayımı. Yanlış
   olabilir ama OKUNABİLİR, ve kameralar eşzamanlı çalışıyorsa zaten doğru.
   'wall' ekrandaki düğmeyle açılıyor — hangisinin doğru olduğu VERİYE bağlı,
   tasarıma değil, o yüzden seçim kullanıcıda.

   SAATİ BİLİNMEYEN GRUP
   `start_at` alanını KULLANICI giriyor (yükleme ekranı dosya adından çıkarıyor
   ya da elle yazılıyor); backend kendi bulmuyor. Girilmemişse o grubu eksene
   koyacak bir bilgi yok. Onu dışarıda bırakmak da yanlış: kullanıcı yüklediği
   kaydı hiç göremez. Bu yüzden koleksiyonun EN ERKEN başlangıcına
   yapıştırılıyor — yani "hepsi aynı anda başladı" varsayımı, ama SADECE o
   grup için ve `anchored:false` bayrağıyla; ekran onu uyarı rozetiyle
   gösteriyor. Saati bilinen grupların ekseni bundan etkilenmiyor.
   ========================================================================= */

import { pad, hms } from './core.js';
import { GroupClock } from './groupclock.js';

/**
 * Bir grubun koleksiyon eksenindeki yeri.
 *
 * `clock` grubun kendi iç saati (parçalar, boşluklar). `offset` o saatin
 * sıfır noktasının koleksiyon ekseninde nereye düştüğü. İkisini toplamak
 * koleksiyon eksenindeki saniyeyi veriyor — çevirinin tamamı bu.
 */
class Band {
  constructor(group, clock, offset, anchored) {
    this.id = String(group.id);
    this.name = group.name;
    this.group = group;
    this.clock = clock;
    this.offset = offset;
    this.anchored = anchored;
  }

  get dur() { return this.clock.wallTotal; }
  get t0() { return this.offset; }
  get t1() { return this.offset + this.dur; }

  /** Grup içi duvar saniyesi → koleksiyon ekseni saniyesi. */
  toAxis(wallSec) { return this.offset + wallSec; }

  /** Koleksiyon ekseni saniyesi → grup içi duvar saniyesi. */
  fromAxis(axisSec) { return axisSec - this.offset; }

  /** Parça kimliği + parça içi saniye → koleksiyon ekseni saniyesi. */
  axisOf(partId, offset = 0) {
    return this.toAxis(this.clock.wallSec(partId, offset));
  }

  /** Koleksiyon ekseninde bu grubun kayıt aralıkları. */
  get spans() {
    return this.clock.spans.map((s) => ({
      t0: this.toAxis(s.t0), t1: this.toAxis(s.t1), part: s.part,
    }));
  }

  /** Koleksiyon ekseninde bu grubun boşlukları. */
  get gaps() {
    return this.clock.gaps.map((g) => ({
      t0: this.toAxis(g.t0), t1: this.toAxis(g.t1),
    }));
  }

  /** Bu grup o anda kayıt yapıyor muydu? */
  covers(axisSec) {
    const w = this.fromAxis(axisSec);
    return this.clock.spans.some((s) => w >= s.t0 && w < s.t1);
  }

  /**
   * Koleksiyon ekseninde bir an → hangi parça, o parçanın neresi.
   * Grup o anda kayıt yapmıyorsa `groupclock.at()` kuralı geçerli:
   * bir sonraki kaydın başına yuvarlanıyor (`gap:true`).
   */
  at(axisSec) { return this.clock.at(this.fromAxis(axisSec)); }
}

/**
 * Saati bilinmeyen grup için sahte parça listesi.
 *
 * `GroupClock` `startMs` olmayan parçayı sessizce düşürüyor — doğru davranış,
 * çünkü tek grup ekranında saatsiz bir kaydı eksene koyamayız. Koleksiyonda
 * ise onu hiç göstermemek daha kötü. Parçaları verilen başlangıçtan itibaren
 * UÇ UCA diziyoruz: aralarındaki gerçek boşluk bilinmiyor, o yüzden yok
 * sayılıyor. Bu bir varsayım ve `anchored:false` ile işaretleniyor.
 */
function stackedParts(videos, originMs) {
  let ms = originMs;
  return (videos || []).map((v) => {
    const dur = v.duration || 0;
    const p = { id: v.id, name: v.name, startMs: ms, dur };
    ms += dur * 1000;
    return p;
  }).filter((p) => p.dur > 0);
}

export class CollectionClock {
  /**
   * @param {Array} groups katalog grupları — `{ id, name, cameras:[video] }`.
   *   `cameras` üzerindeki `start_time` ve `duration` alanları
   *   `backend.js toCamera()` çıktısındaki adlar.
   * @param {object} opts `{ align: 'zero'|'wall' }` — bkz. dosya başlığı.
   */
  constructor(groups, opts = {}) {
    this.align = opts.align === 'wall' ? 'wall' : 'zero';
    const raw = (groups || []).map((g) => {
      const parts = (g.cameras || []).map((v) => ({
        id: v.id,
        name: v.name,
        startMs: v.start_time ? Date.parse(v.start_time) : 0,
        dur: v.duration || 0,
        playable: v.playable ?? v.has_proxy,
      }));
      return { group: g, clock: new GroupClock(parts) };
    }).filter((x) => x.clock.parts.length || (x.group.cameras || []).length);

    /* Eksenin sıfır noktası: SAATİ BİLİNEN grupların en erkeni. Saatsiz
       gruplar bu noktaya yapıştırılacak, dolayısıyla sıfırı onlar
       belirleyemez — belirleselerdi bir saatsiz grup bütün ekseni kaydırırdı. */
    const anchoredMs = raw
      .filter((x) => x.clock.parts.length)
      .map((x) => x.clock.startMs);
    this.originMs = anchoredMs.length ? Math.min(...anchoredMs) : Date.now();

    this.bands = raw.map((x) => {
      if (x.clock.parts.length) {
        /* 'zero' hizalamada her band sıfırdan başlıyor: kaydırma yok, yani
           grubun kendi iç saati doğrudan eksen oluyor. */
        const offset = this.align === 'wall'
          ? (x.clock.startMs - this.originMs) / 1000 : 0;
        return new Band(x.group, x.clock, offset, true);
      }
      /* Saati yok — koleksiyonun başına yapıştır. */
      const clock = new GroupClock(
        stackedParts(x.group.cameras, this.originMs));
      return new Band(x.group, clock, 0, false);
    }).filter((b) => b.clock.parts.length);

    this.bands.sort((a, b) => a.t0 - b.t0 || a.name.localeCompare(b.name));

    /* Eksenin toplam uzunluğu: en geç biten bandın sonu. En az 1 saniye —
       sıfır uzunlukta bir eksende bütün X() hesapları NaN olurdu. */
    this.total = Math.max(1, ...this.bands.map((b) => b.t1));
  }

  get empty() { return !this.bands.length; }

  /** Gerçek saat mi gösteriliyor? Eksen etiketleri buna bakıyor. */
  get isWall() { return this.align === 'wall'; }

  /** Saati girilmemiş, dolayısıyla varsayımla yerleştirilmiş gruplar. */
  get floating() { return this.bands.filter((b) => !b.anchored); }

  byId(groupId) {
    return this.bands.find((b) => b.id === String(groupId)) || null;
  }

  /** Videonun hangi bandda olduğunu bulur. */
  bandOfVideo(videoId) {
    return this.bands.find((b) =>
      b.clock.parts.some((p) => String(p.id) === String(videoId))) || null;
  }

  /** Grup + parça + parça içi saniye → koleksiyon ekseni saniyesi. */
  axisOf(groupId, videoId, offset = 0) {
    const b = this.byId(groupId) || this.bandOfVideo(videoId);
    return b ? b.axisOf(videoId, offset) : offset;
  }

  /** Koleksiyon ekseni saniyesi → Date */
  date(axisSec) { return new Date(this.originMs + axisSec * 1000); }

  /**
   * Koleksiyon ekseni saniyesi → okunur etiket.
   * 'wall' hizalamada gerçek saat, 'zero' hizalamada GEÇEN SÜRE — sıfırdan
   * hizalanmış bir eksende saat yazmak yalan olurdu.
   */
  clock(axisSec) {
    if (!this.isWall) return hms(Math.max(0, axisSec));
    const d = this.date(axisSec);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /* Zaman çizgisi bunu alıyor; `null` verilince eksende geçen süre yazıyor
     (bkz. timeline.js `wallLabel`). */
  get startIso() {
    return this.isWall ? new Date(this.originMs).toISOString() : null;
  }

  /** Bandın gerçek başlangıç saati — hizalamadan bağımsız, başlıkta yazıyor. */
  realStart(band) {
    if (!band.anchored) return null;
    const d = new Date(band.clock.startMs);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /**
   * O anda kayıt yapan bandlar.
   *
   * Oynatıcı devri bunu kullanıyor: kullanıcı bir bandın üstüne geldiğinde
   * o band o anda kayıt yapmıyorsa video değiştirmenin anlamı yok, çünkü
   * gösterilecek görüntü yok.
   */
  liveAt(axisSec) { return this.bands.filter((b) => b.covers(axisSec)); }

  /**
   * Bütün koleksiyonun kapladığı saat aralığı: "13:50–14:45".
   */
  range() {
    if (!this.isWall) return hms(this.total);
    const a = this.date(0), b = this.date(this.total);
    return `${pad(a.getHours())}:${pad(a.getMinutes())}`
      + `–${pad(b.getHours())}:${pad(b.getMinutes())}`;
  }

  summary() {
    const n = this.bands.length;
    const float = this.floating.length;
    return `${this.range()} · ${n} group${n === 1 ? '' : 's'}`
      + (float ? ` · ${float} without a start time` : '');
  }

  /**
   * 'wall' hizalaması bu veri için işe yarar mı?
   *
   * Gruplar birbirinden çok uzak saatlerdeyse eksenin çoğu boş tarama olur.
   * Örtüşme oranı düşükse ekran kullanıcıyı uyarıyor — kip değiştirmeden
   * önce neyle karşılaşacağını bilsin.
   */
  wallOverlapRatio() {
    const spans = this.bands
      .filter((b) => b.anchored)
      .map((b) => {
        const t0 = (b.clock.startMs - this.originMs) / 1000;
        return { t0, t1: t0 + b.clock.wallTotal };
      });
    if (spans.length < 2) return 1;
    const span = Math.max(...spans.map((x) => x.t1));
    const covered = spans.reduce((n, x) => n + (x.t1 - x.t0), 0);
    return span > 0 ? Math.min(1, covered / span) : 1;
  }
}
