@echo off
REM ===========================================================================
REM  지능형 영상 요약 플랫폼 — Mock UI baslatici
REM  Ilk calistirmada veri + video uretilir (~2 dakika), sonrakiler aninda.
REM ===========================================================================
cd /d "%~dp0"

if not exist "mock\data\catalog.json" (
  echo [1/3] Mock veri uretiliyor...
  python tools\gen_mock.py || goto :err
) else (
  echo [1/3] Mock veri mevcut - atlaniyor.
)

if not exist "mock\assets\cam01.mp4" (
  echo [2/3] Sentetik CCTV videolari uretiliyor ^(1-2 dakika^)...
  python tools\gen_video.py || goto :err
) else (
  echo [2/3] Videolar mevcut - atlaniyor.
)

echo [3/3] Sunucu baslatiliyor...
start "" http://127.0.0.1:8000/
python server.py
goto :eof

:err
echo.
echo HATA: adim basarisiz. Gerekli paketler: numpy, pillow  ve  ffmpeg (PATH'te)
echo   pip install numpy pillow
pause
