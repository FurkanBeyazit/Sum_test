# ============================================================================
# 지능형 영상 요약 플랫폼 — arayüz sunucusu
# ----------------------------------------------------------------------------
# NEDEN BU KADAR KISA
# server.py'nin Python bağımlılığı YOK: yalnızca stdlib kullanıyor. Dolayısıyla
# requirements.txt, pip install, sanal ortam — hiçbiri gerekmiyor. Tek harici
# ihtiyaç ffmpeg ve o da apt'ten geliyor.
#
# İKİ İŞ YAPIYOR (bkz. server.py başlığı)
#   1. web/ altındaki arayüzü sunuyor (HTTP Range ile — video seek çalışsın)
#   2. /live/* isteklerini gerçek DVSummary backend'ine iletiyor
#      (tarayıcı oraya doğrudan gidemiyor: farklı origin, CORS başlığı yok)
#
# Backend adresi ÇALIŞMA ZAMANINDA veriliyor (DVSUMMARY_API), imaja gömülü
# değil: aynı imaj test ve saha makinesinde farklı backend'e bakabilsin.
# ============================================================================
FROM python:3.12-slim

# ffmpeg: yalnızca /api/merge için — birden çok parça tek MP4'e birleşiyor.
# --no-install-recommends olmadan bu satır imaja ~700 MB ekliyor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Kaynak. `web/assets` ve `.merge` BİLEREK yok (bkz. .dockerignore):
# ikisi de üretilen veri, 700 MB ve imajda işi yok.
COPY server.py ./
COPY tools/ ./tools/
COPY web/ ./web/

# Çalışma dizinleri. compose bunların üstüne birer volume bağlıyor; burada
# oluşturulmaları, compose'suz `docker run` durumunda da çalışsın diye.
RUN mkdir -p /app/.merge /app/web/assets

# Tamponsuz çıktı: yoksa `docker logs` sunucu durana kadar boş görünüyor.
ENV PYTHONUNBUFFERED=1
ENV DVSUMMARY_API=http://172.20.14.161:8001

EXPOSE 8000

# Sağlık kontrolü. `curl` slim imajda yok, Python zaten var. Kontrol edilen
# şey arayüzün AYAKTA olması; backend'e ulaşıp ulaşamadığı ayrı bir soru ve
# onu sağlık kontrolüne bağlamak yanlış olurdu (backend geçici düşse
# konteyner sürekli yeniden başlardı).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/', timeout=4)"]

# `--host 0.0.0.0` ZORUNLU. server.py varsayılanı 127.0.0.1 ve o, konteynerin
# KENDİ loopback'i demek — dışarıdan hiçbir istek ulaşmaz, port eşlemesi
# yapılmış olsa bile. Docker'da en sık yapılan hata bu.
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8000"]
