# vendor/

Dışarıdan gelen tek dosya buraya konuyor. Sayfa hiçbir zaman CDN'e istek
atmıyor — bu klasörün var olma sebebi de bu.

## hls.min.js

`FEATURES.hls` (ya da adres çubuğunda `?hls=1`) açıkken gerekiyor. Chrome ve
Firefox `.m3u8` açamıyor; Safari açıyor ve orada bu dosyaya gerek yok.

Dosya yoksa hiçbir şey bozulmuyor: ekran bugünkü oynatıcıya düşüyor ve
bunu söyleyen bir uyarı çıkıyor (bkz. `web/js/hlsplayer.js`).

İndirmek için:

    curl.exe -L -o web/vendor/hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js

Yaklaşık 400 KB. Sürüm sabitlemek istersen `hls.js@1` yerine tam sürüm yaz
(ör. `hls.js@1.5.17`).
