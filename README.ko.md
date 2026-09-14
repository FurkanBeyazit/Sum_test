# 지능형 영상 요약 플랫폼 — 웹 UI

> 최종 수정: 2026-09-14 · 코드 기준: commit 2026-09-14 (`fix(reid): split dropped counter…`)
> 터키어 버전: [README.md](README.md) · 상세 가이드: `docs/` (저장소 외부, 로컬 디스크)

CCTV 영상을 업로드하고 분석 큐에 넣은 뒤 결과를 타임라인에서 확인하며, 여러 카메라를 하나의 시간축에서 비교하는 웹 화면입니다. 데이터 소스는 하나, **DVSummary 백엔드**(`172.20.14.161:8001`)입니다.

```bash
python server.py                                  # http://127.0.0.1:8000
DVSUMMARY_API=http://host:port python server.py   # 백엔드가 다른 장비일 때
python server.py --port 9000 --host 0.0.0.0       # 포트 변경 / 외부 접속 허용
```

의존성 없음 — Python 표준 라이브러리만 사용합니다. 영상 병합에는 `ffmpeg`가 PATH에 있어야 합니다. HLS 재생에는 `web/vendor/hls.min.js`가 필요합니다(없으면 기존 플레이어로 자동 전환). `docs/start.bat`: 브라우저를 열고 `server.py`를 실행합니다.

---

## 1. 구조

```
브라우저 ──fetch('/live/…')──► server.py ──HTTP──► DVSummary API (8001)
   ▲                              │
   └────────── JSON ──────────────┘
                                  └── /api/merge/*  (ffmpeg concat → 백엔드에 단일 MP4 업로드)
```

`server.py`가 하는 일은 세 가지입니다.

1. `web/` 정적 파일 제공 (HTTP Range 지원 — 영상 탐색에 필요).
2. `/live/*` 요청을 백엔드로 중계 (백엔드에 CORS 헤더가 없어 브라우저가 직접 호출 불가).
3. `/api/merge/*` — 업로드한 조각들을 ffmpeg로 하나의 MP4로 병합해 백엔드에 업로드. 이 기능은 이쪽에서 담당합니다.
   ```
   POST   /api/merge                 → {merge_id}
   PUT    /api/merge/{id}/part/{i}   → 요청 본문 = 파일
   POST   /api/merge/{id}/build      → ffmpeg concat, 메타 반환
   POST   /api/merge/{id}/upload     → 백엔드에 단일 영상으로 전송
   DELETE /api/merge/{id}            → 임시 파일 삭제
   GET    /api/health
   ```

Mock 데이터 계층은 2026-08-27에 제거되었으며 전체 코드는 `archive/mock/`에 남아 있습니다.

---

## 2. 화면 (라우트)

| 라우트 | 파일 | 역할 |
|---|---|---|
| `#/home` | `screens/home.js` | 시작 화면 + "How to Use" + 서버 상태(`/status/health`, 5초) |
| `#/upload` | `screens/upload.js` | 조각을 실제 시각 순으로 정렬, ffmpeg 병합, 백엔드 업로드, 분석 시작. 같은 이름의 그룹이 있으면 재사용; 컬렉션 지정 가능 |
| `#/single/:id` | `screens/single.js` | **Analysis** — 플레이어 + VLM 이벤트 타임라인 + bbox 레이어. `?hls=1`로 HLS 사용 |
| `#/objects/:id` | `screens/objects.js` | **Object** — track 띠, PAR 검색, 크롭, 사용자 색상 지정, Re-ID 모드(`?reid=<track_id>`) |
| `#/collection/:id` | `screens/collection.js` | **Collection** — 컬렉션의 모든 그룹을 하나의 실시각 축에; 단일 플레이어, hover로 그룹 전환; `events` / `objects` 모드(`?mode=objects`); 그룹 간 인물 연결 |
| `#/summary/:id` | `screens/summary.js` | **Summary** — 컬렉션의 결과 화면, 읽기 전용: 열 = 그룹, 아래에 이벤트; 연결된 인물과 연결선. (`#/wall`은 옛 이름, 리다이렉트) |
| `#/manage` | `screens/manage.js` | 컬렉션/그룹/영상 CRUD + 분석 큐(3초 폴링). (`#/jobs`는 여기로 리다이렉트) |
| `#/system` | `screens/system.js` | GPU + 로그 |
| `#/login` | `screens/login.js` | 로그인 폼(백엔드 인증 없음) |

화면끼리는 **절대** 서로 import하지 않습니다. 새 화면 = `screens/`에 파일 하나 + `app.js`에 `case` 하나.

---

## 3. 파일 구성

```
├── server.py                중계 + 정적 파일 + 병합
├── tools/proxy_cache.py     브라우저 재생용 로컬 프록시 생성 (HLS 미사용 시)
├── web/
│   ├── index.html           단일 <script type="module">, 빌드 없음
│   ├── css/app.css          디자인 시스템
│   ├── vendor/hls.min.js    HLS 용 (Chrome)
│   └── js/
│       ├── core.js          el(), mount(), store, 포맷, TimeMapper, FEATURES, api
│       ├── backend.js       DVSummary 어댑터 — 유일한 데이터 소스, 모든 엔드포인트 주소
│       ├── app.js           라우터 (hash → 화면)
│       ├── ui.js            상단 바, 좌측 트리, 플레이어 컨트롤, onLeave/runCleanup
│       ├── timeline.js      canvas 타임라인 (zoom/pan, 띠, bands)
│       ├── overlay.js       영상 위 bbox 레이어 (letterbox, rVFC, DPI)
│       ├── bboxfeed.js      bbox 데이터 슬라이딩 윈도우 (playhead ±20초)
│       ├── hlsplayer.js     그룹 HLS 스트림을 <video>에 연결
│       ├── groupclock.js    조각 영상: 실제 시각 ↔ 재생 시각 변환
│       ├── collectionclock.js  여러 그룹을 하나의 축에 정렬 (zero / wall)
│       ├── identity.js      "이 둘은 같은 사람" — linkage + 색상의 단일 소유자
│       ├── objsearch.js     클래스 + PAR 검색 패널 (Object·Collection 공용)
│       ├── parchip.js       PAR 배지 (나이/성별/색상 아이콘)
│       ├── fx/aurora.js     로그인 배경 (WebGL)
│       └── screens/         화면당 파일 하나
└── docs/ (gitignore)        AKIS-SENARYOSU, ARAYUZ-REHBERI, SISTEM-REHBERI, TEST-ADIMLARI,
                             PROJE-NOTLARI, Postman 컬렉션, playback_test.html, start.bat
```

의존 방향은 한쪽뿐입니다: `app.js → screens/* → ui.js / timeline.js / overlay.js → core.js → backend.js`.

---

## 4. 핵심 메커니즘 세 가지

**`el()` — DOM 생성기** (`core.js`): template string / innerHTML 없음. `el('div.panel', {}, 자식…)`; `null`/`false` 자식은 건너뜀 → 조건부 렌더는 `cond ? el(…) : null`.

**`store` — 공유 상태**: 세션, 카탈로그(`groups`, `collections`), 언어, 필터. 화면 전용 상태는 store에 넣지 않고 화면 함수의 클로저에 둡니다.

**`onLeave()` — 화면 수명** (`ui.js`): 타이머 / `ResizeObserver` / `EventSource`를 여는 화면은 `onLeave(() => …)`로 정리 함수를 등록하고, `app.js`가 다음 이동 시 `runCleanup()`을 호출합니다. 긴 `await` 뒤에는 `if (!document.body.contains(node)) return;` 검사가 있습니다.

---

## 5. FEATURES 플래그 (`core.js`)

| 플래그 | 상태 | 비고 |
|---|---|---|
| `objects` | **켜짐** | `/analysis/result/{id}/tracks`, `/tracks/par/stats`, `/track/{id}/crop` |
| `bbox` | **켜짐** | `GET /playback/groups/{gid}/bboxes?start_at=&end_at=&format=json` — 그룹 단위, 실시각 기준; `bboxfeed.js`가 3개 윈도우 유지 |
| `merge` | **켜짐** | 조각은 항상 ffmpeg로 병합해 MP4로 업로드 (AVI는 브라우저 재생 불가) |
| `mergeToggle` | 꺼짐 | 체크박스 숨김; 모드는 항상 켜짐 |
| `hls` | **꺼짐 (기본)** | `GET /playback/groups/{gid}/hls/media.m3u8`. 현장에서 조각 전환이 느려 기본값은 기존 방식. 화면의 Stream/HLS 스위치 또는 `?hls=1` |
| `reid` | **켜짐** | `GET /analysis/result/groups/{gid}/video/{vid}/track/{tid}/reid/stream` (SSE) |
| `map`, `candidateScore`, `eventSearch`, `eventStatus`, `snapshot` | 꺼짐 | 대응 엔드포인트 없음; 코드는 유지 |

콘솔에서 임시로 켜기: `localStorage.setItem('ff.reid','1'); location.reload()`.

---

## 6. 인물 identity (identity.js) — 저장 방식

백엔드에는 "인물" 개념이 없고 두 가지가 따로 저장됩니다.

- `/video/object-linkages` → **쌍**만: `(g,v,t) ↔ (g,v,t)`
- `/settings/custom/…` → **색상**만 (자유 JSON)

인물 = 쌍들이 만드는 그래프의 **연결 요소**(A-B, B-C가 있으면 {A,B,C}가 한 사람). 이름(`Person 1, 2…`)은 대표 멤버 기준으로 유도되며 저장하지 않습니다. 색상은 멤버별로 기록해 연결 요소가 합쳐져도 사라지지 않게 합니다. Collection 화면에서 드래그로 그룹 간 연결을 만들고, Summary 화면은 이를 읽기만 합니다.

---

## 7. backend.js — 백엔드 특이사항은 여기서 처리

- **시간 단위** — `timestamp`가 초였다가 1/30000 타임베이스로 바뀐 적이 있음; `tsToSec()`이 둘 다 인식. `frame_index`는 시간 계산에 사용하지 않음.
- **클래스 이름** — 엔드포인트가 `class_name`을 주지 않고 `class_id`만 줌; 이름 테이블은 여기에.
- **클래스 / PAR 필터** — 엔드포인트에 없어 클라이언트에서 필터링(`par.attributes` 사전 기준).
- **Lifecycle** — 목록 엔드포인트에 입/퇴장 시각이 없으면 상세 엔드포인트를 8개씩 병렬 호출해 보완, 캐시.
- **프록시 신선도** — 프록시 기록에 원본 `guid_id` 서명이 있어 백엔드 초기화로 id가 재사용되면 옛 프록시를 거부.

사용하는 백엔드 엔드포인트(요약): `/status/health`, `/video`, `/video/groups`, `/video/collections`, `/video/{id}/stream`, `/video/object-linkages`, `/analysis`, `/analysis/result/{id}/…`, `/playback/groups/{gid}/bboxes|hls`, `/settings/custom/…`. 전체 목록은 `docs/DVSummary-Backend.postman_collection.json`.

---

## 8. 재생

VMS 녹화는 AVI + MPEG-4 Part 2 — 브라우저가 열지 못합니다. 세 가지 경로:

1. **Merge (기본)** — 업로드 시 ffmpeg가 MP4를 만들어 백엔드에 MP4가 저장됨 → `/video/{id}/stream`으로 바로 재생.
2. **HLS** — 백엔드의 그룹 재생목록(`hls` 플래그 / `?hls=1`).
3. **로컬 프록시** — 옛 녹화용 `python tools/proxy_cache.py --list | --all` (`web/assets/proxy/`, 저장소 외부).

---

## 9. 디버깅

```bash
python server.py --live-only /analysis --live-body -1   # 터미널 출력을 좁히고 본문 전체 출력
python server.py --log-file live.log                    # 필터 없이 전체 트래픽을 파일로
grep -A30 'POST .*/analysis' live.log                   # 분석 요청의 전체 응답
grep '✗' live.log                                       # 오류만
```

터미널 출력은 필터링됩니다(크롭·스트림 요청 미출력, 본문 800자 제한); 파일은 필터 없음. 동일 응답 반복은 억제되고 2분마다 요약 한 줄이 남습니다.

---

## 10. 저장소에 포함되지 않는 것

| 경로 | 이유 |
|---|---|
| `docs/` | 가이드, 노트, Postman 컬렉션, `start.bat` |
| `archive/mock/` | 2026-08에 제거된 mock 계층 — 참고용 |
| `web/assets/` | 생성된 프록시 MP4와 썸네일 (200 MB+) |
| `*.avi`, `*.mp4`, `*.bat`, `live.log` | 샘플 영상, 개인용 실행 스크립트, 로그 |

UI를 익히려면 `docs/ARAYUZ-REHBERI.md`부터, 흐름 시나리오는 `docs/AKIS-SENARYOSU.md`, 테스트 절차는 `docs/TEST-ADIMLARI.md`를 보세요. (docs 는 터키어입니다.)
