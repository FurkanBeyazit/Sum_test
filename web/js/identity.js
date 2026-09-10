/* ============================================================================
   identity.js — "bu ikisi ayni insan" bilgisinin tek sahibi
   ----------------------------------------------------------------------------
   NEDEN AYRI BIR DOSYA

   Backend iki ayri yerde iki ayri seyi sakliyor ve ikisi de tek basina
   "kisi" demiyor:

     /video/object-linkages          -> yalnizca CIFT: (g,v,t) <-> (g,v,t)
     /settings/custom/...            -> yalnizca RENK: serbest JSON

   Kisi kavrami ne birinde ne otekinde var; ciftlerin olusturdugu grafigin
   BAGLI BILESENI olarak burada ortaya cikiyor. A-B ve B-C yazilmissa
   {A,B,C} tek kisidir; kimse bunu boyle kaydetmemistir.

   Bu ayrimin bedeli iki istek, kazanci su: renk kaybolursa kimlik durur.
   Renk yalnizca calisirken karismamak icin; kimlik ise sonucun kendisi.

   ISIMLER TURETILIYOR, SAKLANMIYOR
   Person 1, Person 2 ... bileseni belirleyen "kanonik uye"ye gore siralanip
   uretiliyor. Kaydedilmiyor cunku kaydedilseydi iki bilesen birlestiginde
   hangi ismin kalacagi ayri bir kural olurdu; turetince o soru hic dogmuyor.

   RENK NEDEN UYE BASINA YAZILIYOR
   Bilesen kimligi degisken: iki bilesen birlesince biri kayboluyor. Rengi
   bilesene yazsaydik her birlesmede renk kayardi. Uye basina yazinca renk
   track'e yapisiyor; bilesenin rengi de kanonik uyesinin rengi oluyor.
   ========================================================================= */

import { api, toast } from './core.js';

/** (grup, video, track) -> tek dizgi. Haritalarda anahtar olarak kullaniliyor. */
export function idKey(groupId, videoId, trackId) {
  return `${groupId}/${videoId}/${trackId}`;
}

/** Anahtari geri acar. */
export function idParts(key) {
  const [groupId, videoId, trackId] = String(key).split('/');
  return { groupId, videoId, trackId };
}

/* Anahtarlari SAYISAL siralar: '2/10/9' ile '10/2/9' arasinda dizgi
   karsilastirmasi yanlis sonuc verir ve Person numaralari her yuklemede
   farkli cikardi. */
function cmpKey(a, b) {
  const x = a.split('/').map(Number), y = b.split('/').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#38bdf8',
  '#3b82f6', '#a855f7', '#f472b6', '#2dd4bf', '#f8fafc'];

export class IdentitySet {
  /**
   * @param {object} scope
   *   `{ kind: 'collection'|'group', id, groupIds }`
   *   `groupIds` kapsamdaki grup id'leri (dizgi). Koleksiyon kapsaminda
   *   gerekli: listeleme ucunun suzgeci yok, satirlari biz eliyoruz ve
   *   `collection_id` alani null olan eski satirlar da kapsama girebiliyor.
   */
  constructor(scope) {
    this.scope = scope;
    this.groupIds = new Set((scope.groupIds || []).map(String));
    this.rows = [];            // ham linkage satirlari (kapsam icinde)
    this.parent = new Map();   // union-find
    this.groupsByRoot = new Map();
    this.colors = new Map();   // key -> renk
    this.config = {};          // settings'teki TAM nesne (baskalarini ezmeyelim)
    this._pending = null;      // renk yazma zamanlayicisi
    this._seq = 0;             // otomatik renk sirasi
    /* Renk hangi ayar kapsamina yaziliyor. Normalde kimligin kapsami
       (grup/koleksiyon); backend'in kapsamli ayar tablosu bozuksa
       anahtar kapsamina dusuyor — bkz. `_colorScope`. */
    this._cscope = null;
    this._warned = false;
    /* Yazilacak bir degisiklik var mi. Ekrandan cikarken `flush()` her
       durumda cagriliyor; bayrak olmadan hicbir sey degistirmeden acilip
       kapanan her ekran gereksiz bir PUT atiyor ve yazma bozuksa sebepsiz
       bir hata bildirimi cikariyordu. */
    this._dirty = false;
  }

  /* ---- rengin saklandigi yer -------------------------------------------
     BACKEND HATASI ICIN YEDEK YOL.

     `PUT /settings/custom/groups/{id}` su an 400 donuyor:
       "there is no unique or exclusion constraint matching the ON CONFLICT
        specification"
     Yani kapsamli ayar tablosunda upsert'in dayandigi essiz indeks yok —
     sunucu tarafinda bir sema eksigi, istegimizde bir kusur degil.

     Renk bu yuzden kaybolmasin diye ANAHTAR kapsamina dusuyor:
       PUT /settings/custom   { setting_key: 'identity.group.6', config: {...} }
     Bu ayri bir tablo ve calisiyor. Backend duzelince yeniden asil kapsam
     kullanilir; asagidaki `_probe` her oturumda once onu deniyor. */

  /** Asil kapsam. */
  get _primary() { return [this.scope.kind, this.scope.id]; }

  /** Yedek kapsam — tek bir anahtarin altinda. */
  get _fallback() {
    return ['key', `identity.${this.scope.kind}.${this.scope.id}`];
  }

  /**
   * Koleksiyonun ICINDEKI gruplarin renk kapsamlari — yalnizca OKUMAK icin.
   *
   * Bir kullanici once grup ekraninda calisip iki track'i baglamis ve
   * boyamis olabiliyor. Baglantinin kendisi koleksiyonda gorunuyor (satirin
   * iki ucu da kapsamda), ama rengi `identity.group.6` altinda kaldigi icin
   * koleksiyon ekraninda kisi renksiz cikiyordu: ayni is iki ekranda iki
   * turlu gorunuyordu. Bu yuzden acilista grup kapsamlari da okunup
   * ALTTAN birlestiriliyor — koleksiyonun kendi kaydi ustte kaliyor, yani
   * burada verilen renk grupta verilenden onceliklidir.
   *
   * Yazma yine yalnizca koleksiyon kapsamina gidiyor; grup kaydina geri
   * yazmak, grup ekraninda hic dokunulmamis renkleri buradan degistirmek
   * olurdu.
   */
  _groupScopes() {
    if (this.scope.kind !== 'collection') return [];
    return [...this.groupIds].flatMap((g) =>
      [['group', g], ['key', `identity.group.${g}`]]);
  }

  /* ------------------------------------------------------------- yukleme -- */

  /** Kalici mi, yoksa yalnizca bu oturum mu? */
  get persists() { return this.scope.kind !== 'none'; }

  async load() {
    /* kind:'none' — videonun grubu yok. Linkage semasi grup id'sini ZORUNLU
       istiyor, yani boyle bir kayit icin baglanti YAZILAMAZ. Ekran yine de
       calissin diye grafik bellekte tutuluyor; sayfa kapaninca gidiyor.
       Kullaniciyi uyarmak cagiran ekranin isi (`persists` bayragi). */
    if (!this.persists) { this._rebuild(); return this; }
    /* Iki kapsam da okunuyor: hangisinde veri varsa o kullaniliyor. Asil
       kapsam calisiyorsa oncelik onda; boylece backend duzelince eski
       kayitlar kendiliginden devreye giriyor. */
    const gScopes = this._groupScopes();
    const [rows, prim, fall, ...gcfg] = await Promise.all([
      api.linkages().catch(() => []),
      api.settingGet(...this._primary).catch(() => null),
      api.settingGet(...this._fallback).catch(() => null),
      ...gScopes.map((s) => api.settingGet(...s).catch(() => null)),
    ]);
    this.rows = (rows || []).filter((r) => this._inScope(r));
    /* HANGİ KAPSAM KAZANIR: SON YAZILAN.
       Eskiden "asıl kapsamda renk varsa o kazanır" deniyordu ve bu, renk
       temizlemeyi imkânsız kılıyordu: asıl kapsama bir kez yazılabilmiş eski
       bir kayıt kalıyor, yazma oraya 400 döndüğü için bütün yeni yazmalar
       yedek kapsama gidiyor, okuma ise hep eskiyi seçiyordu. Kullanıcı rengi
       siliyor, sayfayı yeniliyor ve renk geri geliyordu.

       Artık her yazma `savedAt` bırakıyor ve yenisi kazanıyor. Damgası
       olmayan kayıt eski sayılıyor — damgadan önce yazılmış demektir. */
    const at = (c) => (c && Number(c.savedAt)) || 0;
    const useFall = fall && (at(fall) > at(prim) || !prim);
    this.config = (useFall ? fall : (prim || fall)) || {};
    this._cscope = useFall ? this._fallback : this._primary;
    /* Once grup renkleri (varsa), sonra bu kapsamin kendi renkleri: ustteki
       kazaniyor. Anahtarlar zaten grup/video/track oldugu icin cakisma
       ancak ayni track'e iki yerden renk verildiginde olur. */
    const merged = {};
    for (const c of gcfg) Object.assign(merged, (c && c.identityColors) || {});
    Object.assign(merged, this.config.identityColors || {});
    this.colors = new Map(Object.entries(merged));
    this._rebuild();
    return this;
  }

  /**
   * Satir bu kapsama ait mi?
   *
   * Once `collection_id`e bakiliyor; o alan null olan satirlar (koleksiyon
   * kavramindan onceki kayitlar, ya da koleksiyonsuz grup icinde yapilan
   * baglantilar) ancak IKI UCU DA kapsamdaki gruplardaysa sayiliyor. Tek ucu
   * iceride olan bir satiri almak, kapsam disindaki bir track'i ekrana
   * yansitirdi.
   */
  _inScope(r) {
    const g1 = String(r['1st_group_id']), g2 = String(r['2nd_group_id']);
    if (this.scope.kind === 'group') {
      return g1 === String(this.scope.id) && g2 === String(this.scope.id);
    }
    if (r.collection_id != null
        && String(r.collection_id) === String(this.scope.id)) return true;
    return this.groupIds.has(g1) && this.groupIds.has(g2);
  }

  /* ---------------------------------------------------------- union-find -- */

  _rebuild() {
    this.parent = new Map();
    for (const r of this.rows) {
      const a = idKey(r['1st_group_id'], r['1st_video_id'], r['1st_track_id']);
      const b = idKey(r['2nd_group_id'], r['2nd_video_id'], r['2nd_track_id']);
      this._union(a, b);
    }
    /* Bilesenleri kanonik uyeye gore diz, Person numaralarini oradan ver.
       Numaralandirma her yuklemede AYNI cikmali; yoksa kullanicinin akilda
       tuttugu "Person 3" bir sonraki acilista baskasi olur. */
    const comp = new Map();
    for (const k of this.parent.keys()) {
      const root = this._find(k);
      if (!comp.has(root)) comp.set(root, []);
      comp.get(root).push(k);
    }
    for (const list of comp.values()) list.sort(cmpKey);
    this.groupsByRoot = new Map();
    const roots = [...comp.keys()]
      .sort((x, y) => cmpKey(comp.get(x)[0], comp.get(y)[0]));
    roots.forEach((root, i) => {
      const members = comp.get(root);
      this.groupsByRoot.set(root, { n: i + 1, members, canonical: members[0] });
    });
  }

  _find(k) {
    if (!this.parent.has(k)) { this.parent.set(k, k); return k; }
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    // yol sikistirma — ayni track'e yuzlerce kez bakiliyor
    let c = k;
    while (this.parent.get(c) !== r) {
      const nx = this.parent.get(c);
      this.parent.set(c, r);
      c = nx;
    }
    return r;
  }

  _union(a, b) {
    const ra = this._find(a), rb = this._find(b);
    if (ra === rb) return;
    /* Kucuk kanonik kazaniyor: kokun kim oldugu Person numarasini
       etkilemiyor (numarayi uyelerden hesapliyoruz) ama deterministik
       olmasi hata ayiklamayi kolaylastiriyor. */
    if (cmpKey(ra, rb) <= 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /* --------------------------------------------------------------- okuma -- */

  /** Bu track bir kisiye bagli mi? */
  has(key) { return this.parent.has(key); }

  /** Track'in ait oldugu kisi — `{n, members, canonical}` ya da null. */
  personOf(key) {
    if (!this.parent.has(key)) return null;
    return this.groupsByRoot.get(this._find(key)) || null;
  }

  /** "Person 3" — bagli degilse null. */
  labelOf(key) {
    const p = this.personOf(key);
    return p ? `Person ${p.n}` : null;
  }

  /** Ayni kisinin diger track'leri (kendisi haric). */
  siblings(key) {
    const p = this.personOf(key);
    return p ? p.members.filter((m) => m !== key) : [];
  }

  /**
   * Track'in rengi.
   *
   * Once kendi rengi, sonra bileseninin kanonik uyesinin rengi, sonra
   * bilesendeki HERHANGI bir renkli uye. Ucuncu adim birlesmeler icin:
   * renksiz bir track renkli bir kisiye baglandiginda o rengi hemen
   * gostersin, kullanici tekrar boyamak zorunda kalmasin.
   */
  colorOf(key) {
    if (this.colors.has(key)) return this.colors.get(key);
    const p = this.personOf(key);
    if (!p) return null;
    if (this.colors.has(p.canonical)) return this.colors.get(p.canonical);
    for (const m of p.members) if (this.colors.has(m)) return this.colors.get(m);
    return null;
  }

  /** Butun kisiler, Person numarasina gore sirali. */
  people() {
    return [...this.groupsByRoot.values()]
      .sort((a, b) => a.n - b.n)
      .map((p) => ({ ...p, color: this.colorOf(p.canonical) }));
  }

  /** Kullanilmamis bir sonraki palet rengi. */
  nextColor() {
    const used = new Set(this.colors.values());
    for (const c of COLORS) if (!used.has(c)) return c;
    return COLORS[this._seq++ % COLORS.length];
  }

  /* --------------------------------------------------------------- yazma -- */

  /**
   * Iki track'i ayni kisi yapar. Bir POST = bir satir.
   *
   * Ag once yerelde guncelleniyor, sonra istek gidiyor: surukleme birakildigi
   * anda renk yerine oturmali, sunucuyu beklememeli. Istek basarisiz olursa
   * yerel degisiklik geri aliniyor ve hata yukari veriliyor.
   */
  async link(aKey, bKey) {
    if (aKey === bKey) return null;
    const pa = this.personOf(aKey);
    if (pa && pa === this.personOf(bKey)) return null;  // zaten ayni kisi
    const a = idParts(aKey), b = idParts(bKey);
    const snapshot = this.rows.slice();
    /* Iyimser satir: gercek id gelene kadar gecici. `_rebuild` yalnizca uc
       alanlara bakiyor, id'ye bakmiyor — bu yuzden grafik dogru cikiyor.
       id null kaldigi surece o satir SILINEMEZ; asagidaki catch bunu
       onluyor, basarisiz satir listede birakilmiyor. */
    const optimistic = {
      id: null,
      collection_id: this.scope.kind === 'collection' ? this.scope.id : null,
      '1st_group_id': a.groupId,
      '1st_video_id': a.videoId,
      '1st_track_id': a.trackId,
      '2nd_group_id': b.groupId,
      '2nd_video_id': b.videoId,
      '2nd_track_id': b.trackId,
    };
    this.rows.push(optimistic);
    this._rebuild();
    /* Renk devri: taraflardan birinin rengi varsa otekine de gecsin, yoksa
       yeni bir renk alsin. Kullanici baglayinca ekranda hemen tek renk
       gormeli — "ayni kisi" dedigi sey buysa. */
    const col = this.colorOf(aKey) || this.colorOf(bKey) || this.nextColor();
    this.setColor(aKey, col);
    if (!this.persists) return null;
    try {
      const saved = await api.createLinkage(
        { groupId: a.groupId, videoId: a.videoId, trackId: a.trackId },
        { groupId: b.groupId, videoId: b.videoId, trackId: b.trackId },
        this.scope.kind === 'collection' ? this.scope.id : null);
      optimistic.id = saved && saved.id;
      return saved;
    } catch (e) {
      this.rows = snapshot;
      this._rebuild();
      throw e;
    }
  }

  /**
   * Track'i kisisinden tamamen kopariyor: ona DOKUNAN butun satirlar siliniyor.
   *
   * Tek bir cifti silmek yetmez — A-B ve A-C varsa A'yi cikarmak icin ikisi de
   * gitmeli. Kalan B ve C ise birbirine bagli DEGIL; yalnizca A uzerinden
   * baglilardi, o gidince ayriliyorlar. Bu dogru davranis: kullanici
   * "bu A degilmis" diyor, "B ile C ayni" demeyi hic dememisti.
   */
  async unlink(key) {
    const touching = this.rows.filter((r) =>
      idKey(r['1st_group_id'], r['1st_video_id'], r['1st_track_id']) === key
      || idKey(r['2nd_group_id'], r['2nd_video_id'], r['2nd_track_id']) === key);
    if (!touching.length) {
      // Baglantisiz track: yalnizca rengi vardi, o da gitsin.
      if (this.colors.delete(key)) this._queueSave();
      return 0;
    }
    if (this.persists) {
      for (const r of touching) {
        if (r.id != null) await api.deleteLinkage(r.id);
      }
    }
    this.rows = this.rows.filter((r) => !touching.includes(r));
    this.colors.delete(key);
    this._rebuild();
    this._queueSave();
    return touching.length;
  }

  /**
   * BUTUN renkleri siler — kimlige DOKUNMAZ.
   *
   * Ekranlar `colors` haritasini KENDILERI bosaltmamali: harita disaridan
   * degistirilince `_dirty` bayragi kalkmiyor, `flush()` erken donuyor ve
   * hicbir sey sunucuya yazilmiyordu. Ekranda renkler gidiyor, sayfa
   * yenilenince geri geliyordu — silme isleminin sahibi de burasi olmali.
   *
   * @returns {number} silinen renk sayisi
   */
  clearColors() {
    const n = this.colors.size;
    if (!n) return 0;
    this.colors.clear();
    this._queueSave();
    return n;
  }

  /**
   * Kisinin rengini degistirir — kimlige DOKUNMAZ.
   * Renk butun uyelere yaziliyor ki bilesen bolunse bile parcalar rengi
   * korusun.
   */
  setColor(key, color) {
    const p = this.personOf(key);
    const targets = p ? p.members : [key];
    for (const m of targets) {
      if (color) this.colors.set(m, color);
      else this.colors.delete(m);
    }
    this._queueSave();
  }

  /* Renk yazmalari GECIKTIRILIYOR.

     Palet acikken kullanici renkler arasinda geziniyor ve her tiklama bir PUT
     demek olurdu. Ust uste gelen degisiklikler tek istekte birlesiyor;
     `flush()` ekrandan cikarken cagriliyor ki son secim kaybolmasin. */
  _queueSave() {
    this._dirty = true;
    clearTimeout(this._pending);
    this._pending = setTimeout(() => this.flush(), 800);
  }

  async flush() {
    clearTimeout(this._pending);
    this._pending = null;
    if (!this._dirty) return;
    this._dirty = false;
    /* Ayarlarin TAMAMI geri yaziliyor, yalnizca kendi anahtarimiz
       degistirilerek: ayni kapsamda baska bir ekranin sakladigi seyi
       ezmemek icin. */
    const next = {
      ...this.config,
      identityColors: Object.fromEntries(this.colors),
      /* Okuma tarafı iki kapsam arasında bunu karşılaştırıyor — bkz. load(). */
      savedAt: Date.now(),
    };
    this.config = next;
    if (!this.persists) return;
    const scope = this._cscope || this._primary;
    try {
      await api.settingPut(scope[0], scope[1], next);
      this._cscope = scope;
      return;
    } catch (e) {
      console.warn(`[identity] ${scope[0]}/${scope[1]} yazilamadi:`, e.message);
    }
    /* Asil kapsam reddetti — anahtar kapsamina gec ve BIR KEZ dene. */
    if (scope[0] !== 'key') {
      try {
        await api.settingPut(...this._fallback, next);
        this._cscope = this._fallback;
        console.info('[identity] renkler yedek kapsama yaziliyor:',
          this._fallback[1]);
        return;
      } catch (e2) {
        console.warn('[identity] yedek kapsam da yazilamadi:', e2.message);
      }
    }
    /* Ikisi de olmadi. Sessiz kalmak en kotusu: kullanici renk verdigini
       sanip devam ediyor ve sayfayi yenileyince hepsi gitmis oluyor.
       Baglantilar DURUYOR — kaybolan yalnizca renk. */
    if (!this._warned) {
      this._warned = true;
      toast('Colours could not be saved on the server. Person links are '
        + 'still stored; only the colours will be lost when you reload.',
        'err', 8000);
    }
  }
}

/** Kisayol: kur ve yukle. */
export async function loadIdentities(scope) {
  return new IdentitySet(scope).load();
}
