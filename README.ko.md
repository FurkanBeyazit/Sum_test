# 지능형 영상 요약 플랫폼 — 웹 UI

CCTV 영상을 업로드하고 분석 큐에 넣은 뒤 결과를 타임라인에서 확인하는 웹
화면입니다. 데이터는 전부 DVSummary 백엔드에서 옵니다.

## 실행

```bash
python server.py            # http://127.0.0.1:8000
```

백엔드가 다른 장비에 있을 때:

```bash
DVSUMMARY_API=http://host:port python server.py
```

의존성 없음 — Python 표준 라이브러리만 사용합니다. 영상 병합에는 `ffmpeg`가
PATH에 있어야 합니다.

---

## 서버

```
브라우저 ──fetch('/live/…')──► server.py ──HTTP──► DVSummary API
```

`server.py`가 하는 일은 세 가지뿐입니다.

1. `web/` 정적 파일 제공 (HTTP Range 지원 — 영상 탐색에 필요)
2. `/live/*` 요청을 백엔드로 중계. 백엔드에 CORS 헤더가 없어서 브라우저가
   직접 호출할 수 없습니다
3. `/api/merge/*` — 업로드한 조각들을 ffmpeg로 하나의 MP4로 병합

---

## 파일별 역할

프레임워크도 빌드 단계도 없습니다. 전부 순수 ES 모듈입니다.

| 파일 | 역할 |
|---|---|
| `core.js` | 기반: DOM 생성, 상태(store), 포맷, 기능 플래그 |
| `backend.js` | 번역기: DVSummary JSON ↔ 화면이 기대하는 형태 |
| `ui.js` | 상단 바, 좌측 트리, 필터 패널, 화면 수명 |
| `app.js` | 라우터 |
| `overlay.js` | 영상 위 bbox 레이어 |
| `timeline.js` | canvas 타임라인 |
| `screens/home.js` | Home |
| `screens/upload.js` | Upload & Analysis |
| `screens/single.js` | Analysis (이벤트 타임라인) |
| `screens/objects.js` | Object — track + PAR 검색 |
| `screens/manage.js` | Manage — 그룹·영상 관리 + 분석 큐 |
| `server.py` | 중계 + 정적 파일 + 병합 API |

의존 방향은 한쪽뿐입니다: `app.js → screens/* → ui.js → core.js`.
화면끼리는 서로를 import 하지 않습니다.

---

## backend.js가 하는 일

화면은 `fetch`를 직접 호출하지 않습니다. API 주소, 파라미터, 캐시가 전부
이 파일 한 곳에 있고, 화면은 `api.objects(videoId, …)` 같은 함수만 씁니다.

번역이 필요한 이유는 응답을 그대로 쓸 수 없기 때문입니다. 예를 들어
`timestamp`의 단위가 바뀐 적이 있고, 응답에 `class_name`이 없어서 `class_id`
숫자를 이름으로 바꿔야 하며, 클래스 필터는 엔드포인트에 없어서 화면 쪽에서
걸러냅니다. 이런 예외를 한 파일에 모아 두면 나머지 코드가 깨끗해집니다.
백엔드가 필드를 추가하면 이 파일만 고치면 됩니다.
