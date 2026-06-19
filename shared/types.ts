// server(백엔드)와 src(React 대시보드)가 공유하는 타입 — 단일 출처.

export interface PageTarget {
  id: number;
  url: string;
  label: string;
  group: string | null;
  login_required: number; // 0/1 (SQLite boolean 관례)
}

export interface CheckResult {
  pageId: number;
  url: string;
  label: string;
  ts: number; // 점검 시각(epoch ms)
  status: number; // 메인 응답 HTTP 상태 (0 = 로드 실패/네트워크 오류)
  durationMs: number; // 진입 소요시간
  ok: boolean; // 정상 진입 여부
  error: string | null; // 실패/특이사항 단서
  sessionExpired: boolean; // 로그인 페이지로 튕김 = 세션 만료 (장애 아님)
  apiFailCount: number; // 점검 중 같은 사이트 API(xhr/fetch)가 5xx/연결실패한 건수 (0 = 없음)
  body?: string | null; // 실패 시 진단 스냅샷(응답 본문 앞부분 또는 실패 API 요약). 정상/세션만료는 null
}

export interface SessionStatus {
  exists: boolean; // storageState.json 존재 여부
  savedAt: number | null; // 세션 저장 시각(epoch ms)
}

export interface NewPage {
  url: string;
  label?: string;
  group?: string | null;
  loginRequired?: boolean;
}

// ── 페이지↔API 매핑 (점검 중 page.on('response') 로 수집) ──

// 한 페이지 방문에서 캡처한 same-site API 호출 1건.
export interface CapturedApi {
  method: string;
  url: string; // 전체 URL (쿼리 포함)
  path: string; // pathname
  status: number;
  durationMs: number | null;
}

// checkOne 의 산출물 = 점검 결과 + 그 페이지가 호출한 API 목록.
export interface PageCheckOutcome {
  result: CheckResult;
  apis: CapturedApi[];
}

// 페이지 → API 조회 1행 (대시보드 페이지별 그룹 표시용).
export interface PageApiRow {
  method: string;
  url: string;
  path: string;
  status: number;
  durationMs: number | null;
  hitCount: number;
  source: 'auto' | 'manual'; // auto=자동 감지(page.on('response')) / manual=수동 등록
}

// API 단건 테스트 결과 — '테스트' 버튼으로 그 API 를 GET 으로 1회 직접 호출(읽기 전용·부작용 없음).
// storageState(로그인 세션)를 실어 쏘므로 백오피스 API 도 로그인 상태로 확인된다.
export interface ApiTestResult {
  ok: boolean; // 2xx/3xx 정상 응답
  status: number; // HTTP 상태 (0 = 네트워크 실패/타임아웃)
  durationMs: number; // 응답까지 소요시간
  sessionExpired: boolean; // 401/403 또는 로그인 페이지로 리다이렉트 = 인증 필요
  error: string | null; // 실패 사유
  contentType: string; // 응답 Content-Type(앞부분, 예: application/json)
  body: string | null; // 응답 본문 앞부분(최대 4KB) — '응답 보기' 모달용. 못 읽으면 null
  bodyTruncated: boolean; // 본문이 4KB 초과로 잘렸는지
}

// API별 목록 1행 (API → 페이지 보기의 상단 목록).
export interface ApiCallRow {
  id: number;
  method: string;
  url: string;
  path: string;
  status: number;
  durationMs: number | null;
  hitCount: number;
  pageCount: number; // 이 API 를 호출하는 페이지 수
}

// API → 페이지 역매핑 1행 (이 API 를 어느 페이지가 호출하나).
export interface ApiPageRow {
  pageId: number;
  label: string;
  url: string;
  status: number;
  durationMs: number | null;
  hitCount: number;
}

// ── 측정 이력/추이 (checks 테이블 누적 → 스파크라인) ──

// 한 페이지의 과거 점검 1건 (추이 그리기용 경량 포인트).
export interface HistoryPoint {
  ts: number; // 점검 시각(epoch ms)
  status: number;
  durationMs: number;
  ok: boolean;
  sessionExpired: boolean;
  error?: string | null; // 실패 사유(모달 상세용). checksByDate 만 채움(추이엔 불필요)
  apiFailCount?: number; // 같은 사이트 API 실패 건수(모달 상세용). checksByDate 만 채움
  body?: string | null; // 실패 시 응답 본문/요약 스냅샷(모달 상세용). checksByDate 만 채움
}

// 로그 탭 — 하루치 점검 집계(일별 막대용). 분류는 settings 임계값 기준.
export interface DailyStat {
  date: string; // 'YYYY-MM-DD' (로컬)
  total: number;
  ok: number; // 정상(빠름)
  warn: number; // 주의(warningMs↑)
  crit: number; // 심각(criticalMs↑, 느리지만 응답 옴)
  fail: number; // 실패(응답 자체 실패)
  expired: number; // 세션 만료
  avgMs: number;
  maxMs: number;
}

// 스케줄러(자동 주기 점검) 상태 — 상단 배지/디버깅용.
export interface SchedulerStatus {
  enabled: boolean; // 자동 점검 켜짐 여부
  cron: string; // cron 식 (예: */5 * * * *)
  running: boolean; // 지금 한 회차가 점검 중인지
  lastRun: number | null; // 마지막 자동 점검 시작 시각(epoch ms)
}

// ── 런타임 편집 가능한 설정(설정 탭에서 수정 → 즉시 반영) ──
export interface Settings {
  enabled: boolean; // 자동 주기 점검 켜짐
  checkIntervalMin: number; // 측정 주기(분) — 내부에서 cron 으로 변환
  warningMs: number; // 주의 임계값(ms) — 이 이상이면 🟡
  criticalMs: number; // 심각 임계값(ms) — 이 이상이면 🟠(느림 심각)
  retentionDays: number; // 이력 보관기간(일) — 0 이하면 정리 안 함
  failOnApiError: boolean; // 켜면 페이지가 호출한 같은 사이트 API 가 5xx/실패면 그 페이지를 실패(❌)로 본다
}

// 설정 부분 수정용(설정 탭 카드별 저장).
export type SettingsPatch = Partial<Settings>;

// ── JSON 내보내기(export) — 데이터를 JSON 으로 추출 ──

// 내보내기 1행 = 페이지 + 그 페이지의 최신 점검 결과 + 호출 API 매핑.
export interface ExportPage {
  id: number;
  url: string;
  label: string;
  group: string | null;
  loginRequired: boolean;
  latestResult: CheckResult | null; // 미점검이면 null
  apis: PageApiRow[]; // 이 페이지가 호출한 API (페이지 → API)
}

// 내보내기 전체 묶음.
export interface ExportData {
  exportedAt: string; // ISO8601 추출 시각
  pageCount: number;
  pages: ExportPage[];
  apiSummary: ApiCallRow[]; // API별 요약(쓰는 페이지 수 포함) — "API별 보기"와 동일
}

// ── 슬랙 알람 (페이지가 최근 N회 중 M회 실패/심각이면 슬랙 발송) ──
// 원본 맥북앱(mac-api-monitor)의 API/서버 단위 → 이 프로젝트는 '페이지' 단위로 매핑.

export type SlackMode = 'webhook' | 'bot';
export type SlackStatus = 'sent' | 'failed' | 'skipped';

export interface SlackSettings {
  enabled: boolean;
  mode: SlackMode; // 'webhook' | 'bot'
  webhookUrl: string;
  botToken: string;
  channel: string; // bot 모드 채널 (#alerts 또는 C0XXXXXXX)
  cooldownMin: number; // 같은 페이지 알람 재발송까지 최소 분
  windowSize: number; // 최근 N회 점검을 본다
  threshold: number; // 그 N회 중 M회 이상 '실패/심각'이면 발동
  recoverEnabled: boolean; // 복구 알람(✅)을 받을지 — 끄면 발동 알람만 오고 복구 알림은 안 옴
  recoverStreak: number; // 복구 조건: 최근 N회 연속 정상이면 복구 발송 (1 이상)
}

export type SlackSettingsPatch = Partial<SlackSettings>;

export interface SlackTestResult {
  ok: boolean;
  message: string;
}

// 알람 발송 1건(내역 모달용).
export interface AlarmEvent {
  id: number;
  ts: number;
  pageId: number | null;
  pageLabel: string | null; // 발송 시점 페이지 이름(페이지 삭제돼도 내역에 남게 스냅샷)
  kind: 'alarm' | 'recovery'; // 발동 / 복구
  title: string;
  detail: string;
  slackStatus: SlackStatus; // sent | failed | skipped(미설정)
  slackError: string | null;
}
