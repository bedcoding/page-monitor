# page-monitor

웹페이지를 **서버에서 헤드리스 크롬(Playwright)으로 로그인된 사용자처럼 진입**해,
페이지가 정상적으로 뜨는지·얼마나 느린지를 점검하는 모니터링 도구.

- **점검 엔진**: Playwright (헤드리스 Chromium) — 여러 페이지를 동시 방문해 진입 속도/HTTP 상태 측정
- **자동 점검**: `node-cron`으로 기본 **5분마다** 전체 자동 점검 + 측정 이력/추이 (2단계)
- **백엔드**: Fastify (REST API, 기본 포트 **4000** · `PORT` env로 변경) + better-sqlite3 (결과 저장)
- **대시보드**: React + Vite (브라우저로 결과 확인 · "지금 전체 점검" 버튼 · 페이지↔API 양방향 조회)
- **로그인**: `storageState`(저장된 세션) 주입 — 로그인 필요한 페이지도 점검 가능

---

## 사전 요구사항 (제일 중요)

**Node 22 필수.** 기본 셸이 Node 18로 잡혀 있으면 실행이 깨집니다.

```bash
nvm use 22        # .nvmrc = 22. 매 터미널마다 먼저 실행
node -v           # v22.x 확인
```

---

## 설치 (최초 1회)

```bash
nvm use 22
npm install
npx playwright install chromium              # 헤드리스 크롬 다운로드
cp data/pages.example.json data/pages.json   # 점검 설정 파일 생성 → 이후 실제 URL로 채우기
```

---

## 실행

### A. 그냥 결과만 보기 (프로덕션 모드, 단일 포트)

```bash
nvm use 22
npm run build     # React 대시보드를 dist/ 로 빌드 (최초 또는 프론트 수정 후)
npm start         # Fastify가 API + 대시보드를 포트 4000 하나로 서빙
```

→ 브라우저에서 **http://localhost:4000**

### B. 개발 모드 (서버 + 리액트 동시 실행, 코드 고치면 자동 반영)

```bash
nvm use 22
npm run dev       # Fastify(4000) + Vite(5173) 동시 실행
```

→ 브라우저에서 **http://localhost:5173**
(React의 `/api` 호출은 Vite가 4000 서버로 프록시. `npm start`가 4000을 쓰고 있으면 먼저 끄세요.)

### C. 로그인 세션 저장 (로그인 필요한 페이지를 점검할 때)

```bash
nvm use 22
npm run login                      # data/pages.json의 loginUrl 사용
# 또는
npm run login -- https://your-site/login
```

→ **headed(눈에 보이는) 크롬**이 떠서 사람이 직접 1회 로그인 → 터미널에서 **Enter** → `data/storageState.json` 저장.
이후 헤드리스 점검이 이 세션을 재사용합니다.
(공개 페이지만 점검하면 이 단계는 생략 가능 — `pages.json`에서 `"loginRequired": false`)

#### 왜 화면이 아니라 CLI(실제 브라우저)로 로그인하나?

헤드리스 점검은 **점검 대상 사이트의 로그인된 세션**(쿠키/토큰)이 있어야 하는데, 그 세션은 **사람이 실제 브라우저에서 한 번 로그인**해야 만들어집니다.

- **대시보드 화면에선 대신 못 합니다.** 대시보드는 `localhost` 웹앱이라, 브라우저 보안(CORS)상 **다른 도메인(점검 대상)의 로그인을 대신 처리할 수 없습니다.** 점검 대상 사이트를 실제로 열어 입력해야 해요.
- **2FA·SSO·캡차**는 자동화가 안 되니 결국 사람 손이 필요합니다.
- 그래서 `npm run login`이 headed 크롬으로 대상 사이트를 띄우고, 로그인 결과(쿠키/토큰)를 `storageState.json`에 저장 → 이후 헤드리스 점검이 그대로 재사용합니다.
- 서버를 원격 배포해도 이 방식이면 됩니다 — 로컬에서 한 번 로그인해 만든 `storageState.json`을 서버에 올려두면 헤드리스가 씁니다. (세션 만료 시 다시 `npm run login`)

---

## ⚠️ 5173 vs 4000 — 헷갈리지 마세요

**둘 다 똑같은 대시보드 화면을 보여줍니다.** 차이는 "화면"이 아니라 **"그 화면을 만드는 방식"** 입니다.

| | **5173** (Vite) | **4000** (Fastify) |
|---|---|---|
| 보여주는 것 | `src/` 코드를 **실시간 변환** | `npm run build`한 **`dist/` 결과물** |
| 코드 고치면 | **즉시 반영**(자동 새로고침/HMR) | **다시 `npm run build`** 해야 반영 |
| 용도 | 개발 중 | 배포된 실서버 모습 |
| API(`/api/*`) 처리 | 4000으로 **프록시**해 넘김 | **자기가 직접** 처리 |
| 단독 실행 | ❌ 4000도 떠 있어야 함 | ✅ 혼자 가능 |

- **왜 둘 다 똑같아 보이나?** 방금 `npm run build`를 했으면 `dist`(4000이 보여주는 것)와 `src`(5173이 보여주는 것)가 같은 상태라서. **코드를 한 줄 고치면** 5173은 즉시 바뀌고 4000은 안 바뀌어 갈라집니다.
- **비유**: 5173 = 즉석조리(재료 바꾸면 바로 맛 변함), 4000 = 미리 포장한 도시락(다시 포장=`build` 해야 바뀜).
- **그래서**: 코드 고치며 볼 땐 **5173**(`npm run dev`), 배포본 그대로/결과만 볼 땐 **4000**(`npm start`).
- 5173에서 "지금 전체 점검"을 눌러도 **실제 점검은 4000 서버가** 합니다 → `npm run dev`는 항상 둘을 같이 띄워요 (5173 = 화면, 4000 = 엔진).

---

## 점검 대상 설정 — `data/pages.json`

`data/pages.json`은 **`.gitignore` 대상**입니다(실제 URL이 커밋되지 않게). `data/pages.example.json`을 복사해 만드세요:

```bash
cp data/pages.example.json data/pages.json
```

```jsonc
{
  "loginUrl": "https://your-site/login",  // npm run login이 여는 페이지
  "loginPattern": "/login",               // 점검 중 최종 URL이 이 문자열을 포함하면 "세션 만료"로 판정
  "pages": [
    { "url": "https://example.com", "label": "Example 홈", "group": "demo", "loginRequired": false },
    { "url": "https://your-site/admin", "label": "백오피스", "group": "admin", "loginRequired": true }
  ]
}
```

> DB(`data/page-monitor.db`)가 비어 있을 때 이 `pages`로 1회 시드됩니다.
> 이미 시드된 뒤엔 대시보드의 "페이지 추가" 탭이나 `POST /api/pages`로 추가하세요.

---

## API (포트 4000)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/pages` | 점검 대상 목록 |
| POST | `/api/pages` | 점검 대상 추가 (`{ url, label?, group?, loginRequired? }`) |
| POST | `/api/pages/import` | **JSON 일괄 추가** — 최상위 배열 또는 `{ pages: [...] }`(내보내기 JSON 호환). 중복 URL skip |
| PATCH | `/api/pages/:id` | 점검 대상 **메타 수정**(`{ label?, group?, loginRequired? }`) — 준 키만 덮어씀. url은 안 바꿈(이력 기준) |
| DELETE | `/api/pages/:id` | 점검 대상 삭제 (이력·API 매핑도 CASCADE 정리, 고아 API 청소) |
| POST | `/api/check` | **전체 즉시 점검** — 헤드리스 크롬 동시 방문 → 결과 반환 + DB 저장 |
| GET | `/api/results/latest` | 각 페이지의 최근 점검 결과 |
| GET | `/api/session` | 로그인 세션(storageState) 존재/저장시각 |
| GET | `/api/scheduler` | 자동 주기 점검 상태 (`{ enabled, cron, running, lastRun }`) |
| GET | `/api/events` | **SSE 구독** — 점검 회차가 끝날 때마다 `data: {type:'checked'}` push. 대시보드 실시간 갱신용 |
| GET | `/api/settings` | 설정 조회 (`{ enabled, checkIntervalMin, warningMs, criticalMs, retentionDays }`) |
| PATCH | `/api/settings` | 설정 부분 수정 → 저장 + 스케줄러 즉시 재구성 |
| GET | `/api/export` | **전체 데이터 JSON 내보내기** — 페이지+최신결과+API 매핑+API별 요약 |
| GET | `/api/pages/:id/apis` | 그 페이지의 API 목록 (**자동 감지 + 수동 등록**, `source`로 구분) |
| POST | `/api/pages/:id/apis` | **수동 API 등록** (`{ method?, path }`) — SSR 등 자동 감지 안 되는 API 기록. 중복이면 `added:false` |
| POST | `/api/pages/:id/apis/import` | **수동 API JSON 일괄** — 배열/`{apis:[...]}`. 각 항목 `"GET /path"`·`"/path"`·`{method?,path\|url}` (`{added,skipped,total}`) |
| DELETE | `/api/pages/:id/apis?method=&url=` | **수동 API 삭제** (`source='manual'`만 — 자동 감지 건은 다음 점검에 다시 생김) |
| GET | `/api/pages/:id/history` | 그 페이지의 점검 이력 (추이 라인차트용, 오래된→최신) |
| GET | `/api/pages/:id/daily` | 로그 탭 — 일별 집계(`?days=30`, 정상/주의/심각/실패/만료·평균·최대) |
| GET | `/api/pages/:id/checks` | 로그 탭 드릴다운 — 특정 날짜 개별 점검(`?date=YYYY-MM-DD`, 상태·HTTP·`error` 포함 → 동그라미 클릭 모달용) |
| GET | `/api/apis` | 수집된 전체 API 목록 (쓰는 페이지 수 포함) |
| GET | `/api/apis/:id/pages` | 그 API를 호출하는 페이지 목록 (**API → 페이지 역매핑**) |
| GET | `/api/slack/settings` | 슬랙 알람 설정 조회 |
| PATCH | `/api/slack/settings` | 슬랙 설정 부분 수정 (발송방식·자격증명·쿨다운/윈도우/임계, clamp) |
| POST | `/api/slack/test` | 슬랙 테스트 발송 (`{ ok, message }`) |
| GET | `/api/slack/events` | 알람 발송 내역(최신순, `?limit=200`) |

브라우저 없이 빠르게 테스트:

```bash
curl -X POST http://localhost:4000/api/check     # 전체 점검 실행
curl http://localhost:4000/api/results/latest    # 최근 결과 조회
```

---

## 결과 보는 법

- 🟢 정상 · 🟡 주의 · 🔴 심각(느리지만 응답 옴) · ❌ 실패(응답 자체 실패) · 🔁 세션 만료(재로그인 필요, **장애 아님**) · ⚪ 미점검
- 🟡/🔴 기준(주의·심각 ms)은 **설정 탭에서 조정** — 기본 1500ms/3000ms
- **세션 만료는 장애가 아닙니다.** 로그인 페이지로 튕기면 `sessionExpired`로 표시만 하고, 다시 `npm run login` 하면 됩니다.

### JSON 내보내기

상단 **"JSON 내보내기"** 버튼을 누르면 현재 데이터(페이지·최신 점검 결과·API 매핑·API별 요약)를 `page-monitor-<시각>.json` 파일로 내려받습니다. (보고/분석용 추출 — 외부 JSON 불러오기는 지원 안 함, DB가 단일 출처)

---

## 현재 구현 범위

- [x] **1단계** — 전체 페이지 한번에 점검 + 대시보드 + 로그인 세션
- [x] **2단계** — `node-cron` 자동 주기 점검(기본 5분) + 측정 이력 누적 + 추이 스파크라인
- [x] **3단계** — 페이지 → 호출 API 매핑 (점검 중 `page.on('response')`로 same-site xhr/fetch 수집)
- [x] **4단계** — API → 호출 페이지 역매핑 (대시보드 **"API별 보기"** 탭)

> 대시보드 **페이지 현황** 탭의 **"페이지별 API 보기 / API별 페이지 보기"** 서브탭으로 3·4단계를 전환합니다. 페이지 행을 클릭하면 **추이 라인차트 + API 목록**이 펼쳐집니다 — **자동 감지된 API**(점검 중 `page.on('response')`로 수집) + **수동으로 추가한 API**(SSR 등 자동 감지 안 되는 것, 단건 또는 JSON 일괄). 행 오른쪽 **✏️로 이름·그룹·로그인필요 수정**(인라인, Enter 저장·Esc 취소), 🗑로 삭제. (url은 이력 기준이라 수정 불가 — 삭제 후 재등록)

### 자동 주기 점검 (2단계)

- 서버를 켜면 **기본 5분마다** 전체 페이지를 자동 점검하고 이력을 쌓습니다. 상단 **"⏱ 자동 점검"** 배지로 상태 확인.
- **주기·임계값·보관기간은 대시보드 "설정" 탭에서 편집** → 저장 즉시 반영(서버 재시작 불필요):
  - **측정 간격(분)** — 입력 즉시 스케줄러 재구성 (예: 5분 → `*/5 * * * *`)
  - **임계값 주의/심각(ms)** — 응답시간 색 판정(🟡 주의 / 🔴 심각)
  - **보관 기간(일)** — 이 기간 지난 이력 자동 정리 (0 = 정리 안 함)
  - **자동 점검 on/off**
  - (이 값들은 DB `settings` 테이블에 저장 — `pages.json`이 아니라)
- ⚠️ **서버 자동 점검 ≠ 화면 자동 갱신.** 서버가 주기마다 점검해 DB에 결과를 쌓아도, **열어둔 브라우저 화면은 자동으로 다시 불러오지 않습니다**(새로고침/"지금 전체 점검"을 눌러야 갱신). 화면도 자동으로 갱신하려면 ↓
- **자동 갱신(설정 탭, 실시간)** — 켜면 **SSE(`/api/events`)를 구독**해, 서버가 점검을 끝낼 때마다 **그 즉시 push 받아** 화면을 갱신합니다. 폴링 주기를 맞출 필요가 없습니다(결과가 생기는 시점에 서버가 알려줌). **F5 같은 페이지 리로드가 아니라** React 부분 렌더라 깜빡임이 없고, 상태·응답시간은 물론 **펼쳐 둔 추이 그래프**까지 갱신되며 편집 중 입력은 그대로입니다. **이 브라우저에만 적용**(localStorage). 켜지면 상단에 **"⟳ 실시간 갱신"** 배지 표시. (자동/수동 점검 모두 push 발생)
- 잠깐 끄려면 환경변수: `SCHEDULER=off npm run dev` (설정의 on 보다 **env가 우선**, 수동 점검은 그대로 동작)
- 자동/수동 점검은 **락을 공유**해 동시에 겹쳐 돌지 않습니다(겹치면 `409`). 종료 시(`Ctrl-C`)엔 진행 중 점검을 마치고 정리한 뒤 닫힙니다.
- ⚠️ 자동·반복 방문이므로 점검 대상 페이지의 **출석/트래킹 같은 부작용 API도 매 주기 호출**됩니다. 운영 시 전용 점검 계정 사용을 고려하세요.

---

## 슬랙 알람

페이지가 **최근 N회 점검 중 M회 이상 "실패(응답 없음) 또는 심각(느림)"**이면 슬랙으로 알림을 보냅니다. 정상화되면 ✅ 복구 알림.

- 대시보드 **"슬랙 알람" 탭**에서 설정합니다:
  - **발송 방식** — Webhook URL, 또는 Bot Token + 채널 (봇을 채널에 초대 + `chat:write` 권한 필요)
  - **알람 조건** — 쿨다운(분, 같은 페이지 재발송 최소 간격), 윈도우 N(최근 N회), 임계 M(그 중 M회 이상이면 발동)
  - **"Slack 테스트"** 로 발송 확인, **"알람 발송 내역"** 으로 과거 알람 + 전송 결과(✅전송/❌실패/⏭️미설정) 조회
- **실패와 심각(느림)만** 알람 대상입니다 — 세션 만료·주의(약한 느림)는 제외.
- 자동/수동 점검 회차가 끝날 때마다 평가합니다(꺼져 있으면 평가 안 함). 알람 상태는 DB 기준이라 서버를 재시작해도 쿨다운이 유지됩니다.

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `npm start`가 바로 죽음, 플러그인 버전 에러 | Node 버전. `nvm use 22` 먼저. |
| `better-sqlite3` 로드 실패 (ABI mismatch) | node 버전 바꾼 뒤면 `npm rebuild better-sqlite3` |
| 대시보드는 뜨는데 표가 비어 있음 | 아직 점검 안 함. "지금 전체 점검" 클릭 또는 `POST /api/check` |
| 모든 페이지가 🔁(세션 만료) | `npm run login`으로 세션 저장 필요 (또는 `loginRequired: false`) |
| dev(5173)에서 `/api` 404 | 4000 서버가 안 떠 있음. `npm run dev`는 둘 다 띄우지만, 따로 띄울 땐 서버 먼저. |
