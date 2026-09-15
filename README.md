# 지능형 영상 요약 플랫폼 — Web UI

> 🇰🇷 [한국어 문서 (상세)](README.ko.md) · 🇹🇷 [Türkçe dokümantasyon (ayrıntılı)](README.tr.md)
> This page is a short overview. The Korean and Turkish documents cover every screen, feature flag and module in full.

Browser front-end for the **DVSummary** video-analysis backend: upload CCTV recordings, queue them for analysis, browse VLM events and tracked objects on a timeline, and compare several cameras on one clock.

```bash
python server.py                                  # http://127.0.0.1:8000
DVSUMMARY_API=http://host:port python server.py   # backend on another machine
```

No dependencies beyond the Python standard library; `ffmpeg` must be on PATH for uploads.

## How it works

```
browser ──fetch('/live/…')──► server.py ──HTTP──► DVSummary API (8001)
                                 └── /api/merge/*  ffmpeg concat → single MP4 → backend
```

`server.py` serves the static UI (with HTTP Range for seeking), proxies `/live/*` to the backend (no CORS there), and merges uploaded parts into one MP4 before upload — everything else lives in the backend.

The UI is plain ES modules, no framework or build step. Screens never import each other; `backend.js` is the single data adapter where all backend quirks are handled.

## Screens

| Route | Purpose |
|---|---|
| `#/upload` | order recording parts by wall clock, merge, upload, start analysis |
| `#/single/:id` | **Analysis** — player + event timeline + bbox overlay |
| `#/objects/:id` | **Object** — tracks, PAR search, crops, user colours, Re-ID |
| `#/collection/:id` | **Collection** — all cameras of a collection on one real-time axis, cross-camera person linking, per-colour playback of one person across cameras |
| `#/summary/:id` | **Summary** — read-only result view of a collection |
| `#/manage` | catalog CRUD + analysis queue |
| `#/home`, `#/system`, `#/login` | landing / GPU & logs / login form |

Feature flags in `web/js/core.js` (`FEATURES`) switch optional parts (bbox, HLS, Re-ID …) on and off.

## Debugging

```bash
python server.py --log-file live.log      # full proxied traffic to a file
python server.py --live-only /analysis --live-body -1
```

`docs/` (guides, Postman collection, start script) is kept out of the repository.
