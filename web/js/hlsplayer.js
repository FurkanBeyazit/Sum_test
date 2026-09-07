/* ============================================================================
   hlsplayer.js — grup HLS akışını <video>'ya bağlar
   ----------------------------------------------------------------------------
   NE İŞE YARIYOR
   Backend grubun bütün parçalarını tek bir çalma listesinde veriyor:

       GET /playback/groups/{gid}/hls/master.m3u8
       GET /playback/groups/{gid}/hls/media.m3u8
       GET /playback/videos/{vid}/segments/{path}

   Bu, bugün elle yaptığımız şeyin sunucu tarafındaki karşılığı: parçalar arka
   arkaya diziliyor, geçişi tarayıcı yapıyor, `switchPart()` gereksizleşiyor.
   Zaman çizgisi yine duvar ekseninde kalıyor — çeviri groupclock.js'te
   (`wallFromPlay` / `playFromWall`).

   NEDEN AYRI DOSYA
   Bu yol DENEME olarak duruyor: `FEATURES.hls` kapalıyken hiç yüklenmiyor,
   bugünkü proxy yolu aynen çalışıyor. İkisi yan yana yaşasın, çalıştığı
   doğrulanınca varsayılan olsun diye ayrıldı.

   DIŞ BAĞIMLILIK — TEK YER BURASI
   Chrome ve Firefox `.m3u8` açamıyor, `hls.js` gerekiyor ve onu repoya
   koyuyoruz:

       web/vendor/hls.min.js

   Safari playlist'i kendi de açabiliyor ama YİNE DE hls.js tercih ediliyor:
   tek bir davranış, tek bir hata yolu. Yerel destek yalnızca kütüphane
   bulunamazsa devreye giriyor.

   Dosya yoksa buradaki kod sessizce başarısız olmuyor — çağırana `null`
   dönüyor, ekran bugünkü oynatıcıya düşüyor ve kullanıcıya sebebi
   yazılıyor. CDN'den çekmek yok: sayfa hiçbir dış istek atmıyor.
   ========================================================================= */

const VENDOR = 'vendor/hls.min.js';

let loading = null;

/** Tarayıcı playlist'i kendi açabiliyor mu (Safari / iOS)? */
export function nativeHls() {
  const v = document.createElement('video');
  return !!v.canPlayType('application/vnd.apple.mpegurl');
}

/**
 * hls.js'i BİR KEZ yükler.
 *
 * Modül olarak `import()` etmiyoruz: dağıtımı UMD ve `window.Hls` bırakıyor.
 * Script etiketi hem o biçimi hem de tarayıcı önbelleğini olduğu gibi
 * kullanıyor.
 *
 * @returns {Promise<object|null>} Hls sınıfı ya da dosya yoksa null
 */
export function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = VENDOR;
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => {
      console.warn(`[hls] ${VENDOR} yok — HLS kipi kapalı kalacak`);
      resolve(null);
    };
    document.head.append(s);
  });
  return loading;
}

/**
 * Playlist'i bir <video>'ya bağlar.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {string} url                 media.m3u8 adresi (köprü üzerinden)
 * @param {object} [cb]
 * @param {(sec:number, yol:string)=>void} [cb.onReady]  manifest çözüldü
 * @param {(msg:string)=>void} [cb.onError]  kurtarılamayan hata
 * @returns {Promise<{destroy:()=>void, mode:string}|null>}
 *          null = bu tarayıcıda mümkün değil
 */
export async function attachHls(videoEl, url, cb = {}) {
  /* SIRA ÖNEMLİ: önce hls.js, yerel destek YEDEK.
     Ters sırayı denedik ve Chromium'da `canPlayType('…mpegurl')` boş dönmesi
     gerekirken "maybe" dönebiliyor; o zaman playlist doğrudan `src`'ye
     yazılıyor, tarayıcı açamıyor ve ekranda sessiz bir siyah kare kalıyor.
     hls.js her yerde aynı biçimde çalışıyor — Safari dahil. Yerel yol yalnızca
     kütüphane yoksa ya da MSE desteklenmiyorsa devreye giriyor. */
  const Hls = await loadHls();

  if (!Hls || !Hls.isSupported()) {
    if (!nativeHls()) return null;
    console.info('[hls] yol: native (hls.js yok)');
    videoEl.src = url;
    const onMeta = () => {
      videoEl.removeEventListener('loadedmetadata', onMeta);
      if (cb.onReady) cb.onReady(videoEl.duration, 'native');
    };
    videoEl.addEventListener('loadedmetadata', onMeta);
    return {
      mode: 'native',
      destroy() { videoEl.removeAttribute('src'); videoEl.load(); },
    };
  }
  console.info('[hls] yol: hls.js', Hls.version || '');

  const hls = new Hls({
    /* Yayın değil kayıt izliyoruz: baştan sona gezinmek normal, o yüzden
       tampon cömert. Segmentler zaten yerel ağdan geliyor. */
    maxBufferLength: 60,
    maxMaxBufferLength: 180,
    enableWorker: true,
  });

  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
    /* `videoEl.duration` bu anda henüz NaN olabiliyor; playlist'in kendi
       toplamı elimizde, onu tercih ediyoruz. */
    const d = (hls.levels && hls.levels[0] && hls.levels[0].details
      && hls.levels[0].details.totalduration) || videoEl.duration || 0;
    console.info('[hls] manifest', {
      seviye: data && data.levels ? data.levels.length : 0, süre: d,
    });
    if (cb.onReady) cb.onReady(d, 'hls.js');
  });

  /* hls.js hataların çoğunu kendi toparlıyor; yalnızca `fatal` olanlar bize
     geliyor. Ağ ve medya hatalarında bir kez daha deniyoruz — segment
     akışında tek bir aksama bütün oynatmayı bitirmesin. */
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data || !data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
      return;
    }
    hls.destroy();
    if (cb.onError) cb.onError(data.details || 'HLS error');
  });

  hls.loadSource(url);
  hls.attachMedia(videoEl);
  return {
    mode: 'hls.js',
    destroy() { try { hls.destroy(); } catch { /* zaten yıkıldı */ } },
  };
}
