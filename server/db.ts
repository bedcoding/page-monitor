import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PageTarget,
  CheckResult,
  CapturedApi,
  PageApiRow,
  ApiCallRow,
  ApiPageRow,
  HistoryPoint,
  Settings,
  SettingsPatch,
  DailyStat,
  SlackSettings,
  SlackSettingsPatch,
  SlackStatus,
  AlarmEvent,
} from '../shared/types';
import { DATA_DIR } from './paths';

const DB_PATH = path.join(DATA_DIR, 'page-monitor.db');

let db: Database.Database;

export function initDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      label TEXT NOT NULL,
      group_name TEXT,
      login_required INTEGER NOT NULL DEFAULT 1,
      UNIQUE(url)
    );
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      session_expired INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_checks_page_ts ON checks(page_id, ts DESC);

    -- 점검 중 수집한 API 호출(같은 method+url 은 1행, hit_count 로 누적)
    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      path TEXT NOT NULL,
      last_status INTEGER,
      last_duration_ms INTEGER,
      hit_count INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      UNIQUE(method, url)
    );
    -- 페이지 ↔ API 다대다 매핑 (양방향 조회: 페이지→API, API→페이지)
    CREATE TABLE IF NOT EXISTS page_api_calls (
      page_id INTEGER NOT NULL,
      api_call_id INTEGER NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_status INTEGER,
      last_duration_ms INTEGER,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (page_id, api_call_id),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (api_call_id) REFERENCES api_calls(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pac_page ON page_api_calls(page_id);
    CREATE INDEX IF NOT EXISTS idx_pac_api ON page_api_calls(api_call_id);

    -- 런타임 편집 설정(단일 행 id=1). 측정 주기/임계값/보관기간.
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      check_interval_min INTEGER NOT NULL DEFAULT 5,
      warning_ms INTEGER NOT NULL DEFAULT 1500,
      critical_ms INTEGER NOT NULL DEFAULT 3000,
      retention_days INTEGER NOT NULL DEFAULT 90
    );
    INSERT OR IGNORE INTO settings (id) VALUES (1);

    -- 슬랙 알람 설정(단일 행 id=1). 발송방식·자격증명·알람조건(쿨다운/윈도우/임계).
    CREATE TABLE IF NOT EXISTS slack_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'webhook',
      webhook_url TEXT NOT NULL DEFAULT '',
      bot_token TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      cooldown_min INTEGER NOT NULL DEFAULT 10,
      window_size INTEGER NOT NULL DEFAULT 10,
      threshold INTEGER NOT NULL DEFAULT 2
    );
    INSERT OR IGNORE INTO slack_settings (id) VALUES (1);

    -- 알람 발송 내역(발동/복구 + 슬랙 전송 결과). page 삭제돼도 이력으로 남게 page_label 스냅샷.
    CREATE TABLE IF NOT EXISTS alarm_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      page_id INTEGER,
      page_label TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      slack_status TEXT NOT NULL,
      slack_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alarm_page ON alarm_events(page_id, ts);
  `);

  // 마이그레이션: page_api_calls.source — 'auto'(page.on('response') 자동 감지) / 'manual'(사람이 수동 등록).
  // Next.js SSR 등 브라우저에 안 잡히는 API 를 손으로 기록하기 위함. 기존 행은 모두 'auto'.
  const pacCols = db.prepare('PRAGMA table_info(page_api_calls)').all() as { name: string }[];
  if (!pacCols.some(c => c.name === 'source')) {
    db.exec("ALTER TABLE page_api_calls ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'");
  }
  // 마이그레이션: alarm_events.bad_count — 그 발사 시점의 '실패/심각 횟수'.
  // 직전 발사보다 늘었을 때만 재발사(같은 수준 반복 알림 방지)하려고 기록. 기존 행은 0.
  const aeCols = db.prepare('PRAGMA table_info(alarm_events)').all() as { name: string }[];
  if (!aeCols.some(c => c.name === 'bad_count')) {
    db.exec('ALTER TABLE alarm_events ADD COLUMN bad_count INTEGER NOT NULL DEFAULT 0');
  }
  // 마이그레이션: alarm_events.last_check_id — 그 발사가 '카운트한 마지막 점검 id'.
  // 다음 회차엔 이 id 이후의 '새 실패'만 발사 트리거로 센다(이미 알린 실패의 반복 발사 방지). 기존 행은 0.
  if (!aeCols.some(c => c.name === 'last_check_id')) {
    db.exec('ALTER TABLE alarm_events ADD COLUMN last_check_id INTEGER NOT NULL DEFAULT 0');
  }
  // 마이그레이션: 복구 알람 설정 — recover_enabled(받을지) + recover_streak(최근 N회 연속 정상이면 복구).
  const ssCols = db.prepare('PRAGMA table_info(slack_settings)').all() as { name: string }[];
  if (!ssCols.some(c => c.name === 'recover_enabled')) {
    db.exec('ALTER TABLE slack_settings ADD COLUMN recover_enabled INTEGER NOT NULL DEFAULT 1');
  }
  if (!ssCols.some(c => c.name === 'recover_streak')) {
    db.exec('ALTER TABLE slack_settings ADD COLUMN recover_streak INTEGER NOT NULL DEFAULT 2');
  }
  return db;
}

interface SettingsRow {
  enabled: number;
  check_interval_min: number;
  warning_ms: number;
  critical_ms: number;
  retention_days: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 현재 설정(단일 행). */
export function getSettings(): Settings {
  const r = db
    .prepare(
      'SELECT enabled, check_interval_min, warning_ms, critical_ms, retention_days FROM settings WHERE id = 1',
    )
    .get() as SettingsRow;
  return {
    enabled: !!r.enabled,
    checkIntervalMin: r.check_interval_min,
    warningMs: r.warning_ms,
    criticalMs: r.critical_ms,
    retentionDays: r.retention_days,
  };
}

/** 설정 부분 수정 + 값 검증/클램프. 갱신된 전체 설정을 반환. */
export function updateSettings(patch: SettingsPatch): Settings {
  const cur = getSettings();
  const next: Settings = { ...cur, ...patch };
  // 방어적 검증 — 잘못된 값으로 스케줄러/판정이 깨지지 않게.
  next.checkIntervalMin = clamp(Math.round(Number(next.checkIntervalMin) || 5), 1, 1440); // 1분~1일
  next.warningMs = clamp(Math.round(Number(next.warningMs) || 0), 0, 600_000);
  next.criticalMs = clamp(Math.round(Number(next.criticalMs) || 0), 0, 600_000);
  // 심각 임계값은 주의 이상이어야 의미가 있다 — 역전되면 주의값으로 맞춤.
  if (next.criticalMs < next.warningMs) next.criticalMs = next.warningMs;
  next.retentionDays = clamp(Math.round(Number(next.retentionDays) || 0), 0, 3650);
  db.prepare(
    'UPDATE settings SET enabled = ?, check_interval_min = ?, warning_ms = ?, critical_ms = ?, retention_days = ? WHERE id = 1',
  ).run(
    next.enabled ? 1 : 0,
    next.checkIntervalMin,
    next.warningMs,
    next.criticalMs,
    next.retentionDays,
  );
  return getSettings();
}

interface PageRow {
  id: number;
  url: string;
  label: string;
  group_name: string | null;
  login_required: number;
}

export function listPages(): PageTarget[] {
  const rows = db
    .prepare('SELECT id, url, label, group_name, login_required FROM pages ORDER BY id')
    .all() as PageRow[];
  return rows.map(r => ({
    id: r.id,
    url: r.url,
    label: r.label,
    group: r.group_name,
    login_required: r.login_required,
  }));
}

export function addPage(p: {
  url: string;
  label: string;
  group: string | null;
  login_required: number;
}): number {
  const r = db
    .prepare(
      'INSERT OR IGNORE INTO pages (url, label, group_name, login_required) VALUES (?, ?, ?, ?)',
    )
    .run(p.url, p.label, p.group, p.login_required);
  if (r.changes === 0) {
    // url UNIQUE 충돌 → lastInsertRowid 는 갱신 안 됨(직전 insert 값). 실제 id 재조회.
    const row = db.prepare('SELECT id FROM pages WHERE url = ?').get(p.url) as
      | { id: number }
      | undefined;
    return row ? row.id : 0;
  }
  return Number(r.lastInsertRowid);
}

/**
 * 페이지 메타(이름/그룹/로그인필요)를 부분 수정. 주어진 키만 덮어쓰고 나머지는 보존한다.
 * url 은 페이지의 정체성이자 이력의 기준이라 여기서 바꾸지 않는다(바꾸려면 삭제 후 재등록).
 * @returns 해당 id 가 있으면 true (없으면 false)
 */
export function updatePage(
  id: number,
  patch: { label?: string; group?: string | null; login_required?: number },
): boolean {
  const cur = db
    .prepare('SELECT label, group_name, login_required FROM pages WHERE id = ?')
    .get(id) as { label: string; group_name: string | null; login_required: number } | undefined;
  if (!cur) return false;
  const label = patch.label !== undefined ? patch.label : cur.label;
  const group = patch.group !== undefined ? patch.group : cur.group_name;
  const login_required =
    patch.login_required !== undefined ? patch.login_required : cur.login_required;
  db.prepare('UPDATE pages SET label = ?, group_name = ?, login_required = ? WHERE id = ?').run(
    label,
    group,
    login_required,
    id,
  );
  return true;
}

/**
 * 페이지 1건 삭제. FK CASCADE 로 checks·page_api_calls 링크도 함께 지워진다.
 * 링크가 끊겨 어느 페이지와도 연결 안 된 api_calls(고아)는 뒤이어 청소한다.
 * @returns 실제로 지워졌으면 true (없는 id 면 false)
 */
export function deletePage(id: number): boolean {
  const tx = db.transaction((pageId: number): boolean => {
    const r = db.prepare('DELETE FROM pages WHERE id = ?').run(pageId);
    if (r.changes === 0) return false;
    // page_api_calls 는 CASCADE 로 이미 정리됨 → 아무 페이지도 안 쓰는 API 본체 제거
    db.prepare('DELETE FROM api_calls WHERE id NOT IN (SELECT api_call_id FROM page_api_calls)').run();
    return true;
  });
  return tx(id);
}

/**
 * 여러 페이지를 JSON 으로 일괄 추가(추가 전용 — 기존 것 덮어쓰지 않음).
 * 각 항목에서 url/label/group/loginRequired 만 취한다(내보내기 JSON 의 pages 도 그대로 먹힌다).
 * @returns { added: 새로 추가, skipped: 중복 url 또는 빈 url }
 */
export function importPages(items: unknown[]): { added: number; skipped: number } {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO pages (url, label, group_name, login_required) VALUES (?, ?, ?, ?)',
  );
  let added = 0;
  let skipped = 0;
  const tx = db.transaction((list: unknown[]) => {
    for (const raw of list) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const url = typeof p.url === 'string' ? p.url.trim() : '';
      if (!url) {
        skipped++;
        continue;
      }
      const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : url;
      const group = typeof p.group === 'string' ? p.group.trim() || null : null;
      const loginRequired = p.loginRequired === false ? 0 : 1;
      const r = stmt.run(url, label, group, loginRequired);
      if (r.changes > 0) added++;
      else skipped++; // url UNIQUE 충돌 = 이미 등록됨
    }
  });
  tx(items);
  return { added, skipped };
}

export function recordChecks(results: CheckResult[]): void {
  const stmt = db.prepare(
    'INSERT INTO checks (page_id, ts, status, duration_ms, ok, error, session_expired) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const tx = db.transaction((rows: CheckResult[]) => {
    for (const r of rows) {
      stmt.run(r.pageId, r.ts, r.status, r.durationMs, r.ok ? 1 : 0, r.error, r.sessionExpired ? 1 : 0);
    }
  });
  tx(results);
}

interface LatestRow {
  page_id: number;
  url: string;
  label: string;
  ts: number;
  status: number;
  duration_ms: number;
  ok: number;
  error: string | null;
  session_expired: number;
}

/** 각 page 의 가장 최근 점검 결과 1건씩. */
export function latestResults(): CheckResult[] {
  const rows = db
    .prepare(
      `SELECT c.page_id, p.url, p.label, c.ts, c.status, c.duration_ms, c.ok, c.error, c.session_expired
       FROM checks c
       JOIN pages p ON p.id = c.page_id
       WHERE c.id IN (SELECT MAX(id) FROM checks GROUP BY page_id)
       ORDER BY c.page_id`,
    )
    .all() as LatestRow[];
  return rows.map(r => ({
    pageId: r.page_id,
    url: r.url,
    label: r.label,
    ts: r.ts,
    status: r.status,
    durationMs: r.duration_ms,
    ok: !!r.ok,
    error: r.error,
    sessionExpired: !!r.session_expired,
  }));
}

interface HistoryQueryRow {
  ts: number;
  status: number;
  duration_ms: number;
  ok: number;
  session_expired: number;
  error?: string | null;
}

/** 한 페이지의 최근 점검 이력(추이용). 오래된→최신 순으로 반환(스파크라인 왼→오). */
export function pageHistory(pageId: number, limit = 30): HistoryPoint[] {
  // 최근 limit 건을 ts DESC 로 뽑은 뒤 뒤집어 시간순으로.
  // 동일 ts(자동/수동 동시 점검) 는 id DESC 로 tie-break 해 순서를 결정적으로.
  const rows = db
    .prepare(
      `SELECT ts, status, duration_ms, ok, session_expired
       FROM checks WHERE page_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(pageId, limit) as HistoryQueryRow[];
  return rows
    .reverse()
    .map(r => ({
      ts: r.ts,
      status: r.status,
      durationMs: r.duration_ms,
      ok: !!r.ok,
      sessionExpired: !!r.session_expired,
    }));
}

/**
 * 보존기간(maxAgeDays) 밖의 오래된 이력 정리 — 장기 무중단 가동 시 무한 성장 방지.
 * checks 는 ts 기준, API 매핑은 page_api_calls.last_seen 기준으로 끊고, 고아 api_calls 청소.
 * @returns 삭제된 행 수 { checks, apis }
 */
export function pruneHistory(maxAgeDays: number): { checks: number; apis: number } {
  if (!(maxAgeDays > 0)) return { checks: 0, apis: 0 };
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const tx = db.transaction((): { checks: number; apis: number } => {
    const checks = db.prepare('DELETE FROM checks WHERE ts < ?').run(cutoff).changes;
    // 오래 안 보인 페이지↔API 링크 제거 → 아무 페이지와도 안 엮인 api_calls(고아) 청소
    db.prepare('DELETE FROM page_api_calls WHERE last_seen < ?').run(cutoff);
    const apis = db
      .prepare('DELETE FROM api_calls WHERE id NOT IN (SELECT api_call_id FROM page_api_calls)')
      .run().changes;
    return { checks, apis };
  });
  return tx();
}

/** 그레이스풀 종료용 — DB 닫아 WAL 체크포인트 유발. */
export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* 이미 닫혔거나 미초기화 — 무시 */
  }
}

interface DailyRow {
  date: string;
  total: number;
  ok: number;
  warn: number;
  crit: number;
  fail: number;
  expired: number;
  avgMs: number;
  maxMs: number;
}

/** 로그 탭 — 최근 N일 일별 점검 집계(막대용). 주의/심각 분류는 현재 settings 임계값 기준. */
export function dailyStats(pageId: number, days: number): DailyStat[] {
  const s = getSettings();
  const since = Date.now() - clamp(Math.round(days) || 30, 1, 90) * 86_400_000;
  return db
    .prepare(
      `SELECT date(ts/1000, 'unixepoch', 'localtime') AS date,
              COUNT(*) AS total,
              SUM(CASE WHEN session_expired=0 AND ok=1 AND duration_ms <  @warn THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN session_expired=0 AND ok=1 AND duration_ms >= @warn AND duration_ms < @crit THEN 1 ELSE 0 END) AS warn,
              SUM(CASE WHEN session_expired=0 AND ok=1 AND duration_ms >= @crit THEN 1 ELSE 0 END) AS crit,
              SUM(CASE WHEN session_expired=0 AND ok=0 THEN 1 ELSE 0 END) AS fail,
              SUM(CASE WHEN session_expired=1 THEN 1 ELSE 0 END) AS expired,
              CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avgMs,
              COALESCE(MAX(duration_ms), 0) AS maxMs
       FROM checks
       WHERE page_id = @id AND ts >= @since
       GROUP BY date ORDER BY date`,
    )
    .all({ id: pageId, since, warn: s.warningMs, crit: s.criticalMs }) as DailyRow[];
}

/** 로그 탭 드릴다운 — 특정 날짜(YYYY-MM-DD, 로컬)의 개별 점검들(동그라미용). */
export function checksByDate(pageId: number, date: string): HistoryPoint[] {
  const rows = db
    .prepare(
      `SELECT ts, status, duration_ms, ok, session_expired, error
       FROM checks
       WHERE page_id = ? AND date(ts/1000, 'unixepoch', 'localtime') = ?
       ORDER BY ts, id`,
    )
    .all(pageId, date) as HistoryQueryRow[];
  return rows.map(r => ({
    ts: r.ts,
    status: r.status,
    durationMs: r.duration_ms,
    ok: !!r.ok,
    sessionExpired: !!r.session_expired,
    error: r.error ?? null,
  }));
}

// ── 페이지 ↔ API 매핑 (checker 가 page.on('response') 로 수집한 결과) ──

/** 한 페이지 점검에서 캡처된 API 호출들을 api_calls + page_api_calls 에 upsert. */
export function recordApiCalls(pageId: number, apis: CapturedApi[]): void {
  if (apis.length === 0) return;
  const now = Date.now();
  const upsertApi = db.prepare(
    `INSERT INTO api_calls (origin, method, url, path, last_status, last_duration_ms, hit_count, first_seen, last_seen)
     VALUES (@origin, @method, @url, @path, @status, @dur, 1, @now, @now)
     ON CONFLICT(method, url) DO UPDATE SET
       last_status = @status, last_duration_ms = @dur, hit_count = hit_count + 1, last_seen = @now`,
  );
  const getApiId = db.prepare('SELECT id FROM api_calls WHERE method = ? AND url = ?');
  const upsertLink = db.prepare(
    // 자동 감지는 source='auto'. 수동 등록했던 API 가 실제로 자동 감지되면 'auto' 로 승격.
    `INSERT INTO page_api_calls (page_id, api_call_id, hit_count, last_status, last_duration_ms, last_seen, source)
     VALUES (@pageId, @apiId, 1, @status, @dur, @now, 'auto')
     ON CONFLICT(page_id, api_call_id) DO UPDATE SET
       hit_count = hit_count + 1, last_status = @status, last_duration_ms = @dur, last_seen = @now, source = 'auto'`,
  );
  const tx = db.transaction((rows: CapturedApi[]) => {
    for (const a of rows) {
      let origin = '';
      try {
        origin = new URL(a.url).origin;
      } catch {
        /* keep '' */
      }
      upsertApi.run({ origin, method: a.method, url: a.url, path: a.path, status: a.status, dur: a.durationMs, now });
      const row = getApiId.get(a.method, a.url) as { id: number };
      upsertLink.run({ pageId, apiId: row.id, status: a.status, dur: a.durationMs, now });
    }
  });
  tx(apis);
}

interface PageApiQueryRow {
  method: string;
  url: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  hitCount: number;
  source: string;
}

/** 특정 페이지가 호출한 API 목록 (페이지 → API). */
export function apisByPage(pageId: number): PageApiRow[] {
  const rows = db
    .prepare(
      `SELECT a.method, a.url, a.path,
              pac.last_status AS status, pac.last_duration_ms AS durationMs, pac.hit_count AS hitCount,
              pac.source AS source
       FROM page_api_calls pac
       JOIN api_calls a ON a.id = pac.api_call_id
       WHERE pac.page_id = ?
       ORDER BY pac.source DESC, a.path, a.url`,
    )
    .all(pageId) as PageApiQueryRow[];
  return rows.map(r => ({
    method: r.method,
    url: r.url,
    path: r.path,
    status: r.status ?? 0,
    durationMs: r.durationMs,
    hitCount: r.hitCount,
    source: r.source === 'manual' ? 'manual' : 'auto',
  }));
}

/**
 * 수동 API 등록 — Next.js SSR 등 브라우저에 안 잡히는 API 를 사람이 기록.
 * 경로는 페이지 origin 으로 절대화해 저장 → 자동 감지(풀 URL)와 같은 키(method+url)가 되어,
 * 이미 자동 감지된 API 는 중복으로 걸러진다(added:false). 점검은 안 함(status/ms/hit_count 없음).
 * @returns 새로 추가됐으면 true (이미 자동/수동으로 있으면 false)
 */
export function addManualApi(pageId: number, method: string, path: string): boolean {
  const now = Date.now();
  const m = method.trim().toUpperCase();
  const raw = path.trim();
  // 상대경로면 페이지 origin 으로 절대화 → 자동 감지(풀 URL)와 키 일치. 이미 절대 URL(교차 사이트 등)이면 그대로.
  // 단 동적 파라미터(<id> 등)는 절대화하면 <>가 %3C%3E 로 인코딩돼 보기 흉하고 동적 판정(<>)도 깨진다.
  // placeholder 는 자동 감지(실제 값)와 겹칠 일이 없어 절대화(중복 제거) 자체가 불필요 → 상대경로 그대로 둔다.
  let url = raw;
  if (!/^https?:\/\//i.test(raw) && !/[<>]/.test(raw)) {
    const page = db.prepare('SELECT url FROM pages WHERE id = ?').get(pageId) as
      | { url: string }
      | undefined;
    if (page) {
      try {
        url = new URL(raw, page.url).href;
      } catch {
        /* 절대화 실패 — 입력값 유지 */
      }
    }
  }
  // path/origin 은 자동 감지(recordApiCalls)와 동일 규약 — path=pathname(쿼리 제외), origin=URL origin.
  let origin = '';
  let pathDisplay = raw;
  try {
    const u = new URL(url);
    origin = u.origin;
    pathDisplay = u.pathname;
  } catch {
    /* 절대 URL 이 아님 — 입력값 유지 */
  }
  const tx = db.transaction((): boolean => {
    db.prepare(
      `INSERT INTO api_calls (origin, method, url, path, hit_count, first_seen, last_seen)
       VALUES (@origin, @m, @url, @path, 0, @now, @now)
       ON CONFLICT(method, url) DO NOTHING`,
    ).run({ origin, m, url, path: pathDisplay, now });
    const row = db.prepare('SELECT id FROM api_calls WHERE method = ? AND url = ?').get(m, url) as
      | { id: number }
      | undefined;
    if (!row) return false;
    const r = db
      .prepare(
        `INSERT INTO page_api_calls (page_id, api_call_id, hit_count, last_seen, source)
         VALUES (@pageId, @apiId, 0, @now, 'manual')
         ON CONFLICT(page_id, api_call_id) DO NOTHING`,
      )
      .run({ pageId, apiId: row.id, now });
    return r.changes > 0; // 이미 연결돼 있던(자동 감지 등) API 면 false
  });
  return tx();
}

/**
 * 수동 등록 API 삭제 — source='manual' 인 링크만 지운다(자동 감지된 건 다음 점검에 다시 생기므로 제외).
 * @returns 실제로 지웠으면 true
 */
export function deleteManualApi(pageId: number, method: string, url: string): boolean {
  const tx = db.transaction((): boolean => {
    const api = db.prepare('SELECT id FROM api_calls WHERE method = ? AND url = ?').get(method, url) as
      | { id: number }
      | undefined;
    if (!api) return false;
    const r = db
      .prepare("DELETE FROM page_api_calls WHERE page_id = ? AND api_call_id = ? AND source = 'manual'")
      .run(pageId, api.id);
    if (r.changes === 0) return false;
    // 어느 페이지와도 연결 안 된 api_calls(고아) 청소
    db.prepare('DELETE FROM api_calls WHERE id NOT IN (SELECT api_call_id FROM page_api_calls)').run();
    return true;
  });
  return tx();
}

interface ApiCallQueryRow {
  id: number;
  method: string;
  url: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  hitCount: number;
  pageCount: number;
}

/** 수집된 전체 API 목록 (API → 페이지 보기의 상단 목록). pageCount = 이 API 를 쓰는 페이지 수. */
export function listApiCalls(): ApiCallRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.method, a.url, a.path,
              a.last_status AS status, a.last_duration_ms AS durationMs, a.hit_count AS hitCount,
              (SELECT COUNT(*) FROM page_api_calls pac WHERE pac.api_call_id = a.id) AS pageCount
       FROM api_calls a
       ORDER BY pageCount DESC, a.path, a.url`,
    )
    .all() as ApiCallQueryRow[];
  return rows.map(r => ({
    id: r.id,
    method: r.method,
    url: r.url,
    path: r.path,
    status: r.status ?? 0,
    durationMs: r.durationMs,
    hitCount: r.hitCount,
    pageCount: r.pageCount,
  }));
}

interface ApiPageQueryRow {
  pageId: number;
  label: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  hitCount: number;
}

/** 특정 API 를 호출한 페이지 목록 (API → 페이지 역매핑). */
export function pagesByApi(apiCallId: number): ApiPageRow[] {
  const rows = db
    .prepare(
      `SELECT p.id AS pageId, p.label, p.url,
              pac.last_status AS status, pac.last_duration_ms AS durationMs, pac.hit_count AS hitCount
       FROM page_api_calls pac
       JOIN pages p ON p.id = pac.page_id
       WHERE pac.api_call_id = ?
       ORDER BY p.id`,
    )
    .all(apiCallId) as ApiPageQueryRow[];
  return rows.map(r => ({
    pageId: r.pageId,
    label: r.label,
    url: r.url,
    status: r.status ?? 0,
    durationMs: r.durationMs,
    hitCount: r.hitCount,
  }));
}

// ── 슬랙 알람 ──

interface SlackRow {
  enabled: number;
  mode: string;
  webhook_url: string;
  bot_token: string;
  channel: string;
  cooldown_min: number;
  window_size: number;
  threshold: number;
  recover_enabled: number;
  recover_streak: number;
}

export function getSlackSettings(): SlackSettings {
  const r = db.prepare('SELECT * FROM slack_settings WHERE id = 1').get() as SlackRow;
  return {
    enabled: !!r.enabled,
    mode: r.mode === 'bot' ? 'bot' : 'webhook',
    webhookUrl: r.webhook_url,
    botToken: r.bot_token,
    channel: r.channel,
    cooldownMin: r.cooldown_min,
    windowSize: r.window_size,
    threshold: r.threshold,
    recoverEnabled: !!r.recover_enabled,
    recoverStreak: r.recover_streak,
  };
}

export function updateSlackSettings(patch: SlackSettingsPatch): SlackSettings {
  const next = { ...getSlackSettings(), ...patch };
  next.mode = next.mode === 'bot' ? 'bot' : 'webhook';
  next.cooldownMin = clamp(Math.round(Number(next.cooldownMin) || 0), 0, 1440);
  next.windowSize = clamp(Math.round(Number(next.windowSize) || 1), 1, 100);
  // 임계 M 은 1..windowSize (윈도우보다 클 수 없음)
  next.threshold = clamp(Math.round(Number(next.threshold) || 1), 1, next.windowSize);
  // 복구 조건 — 연속 정상 N회는 1..windowSize (윈도우 안에서 판정하므로 윈도우보다 클 수 없음)
  next.recoverStreak = clamp(Math.round(Number(next.recoverStreak) || 1), 1, next.windowSize);
  db.prepare(
    `UPDATE slack_settings SET enabled=?, mode=?, webhook_url=?, bot_token=?, channel=?,
       cooldown_min=?, window_size=?, threshold=?, recover_enabled=?, recover_streak=? WHERE id=1`,
  ).run(
    next.enabled ? 1 : 0,
    next.mode,
    next.webhookUrl ?? '',
    next.botToken ?? '',
    next.channel ?? '',
    next.cooldownMin,
    next.windowSize,
    next.threshold,
    next.recoverEnabled ? 1 : 0,
    next.recoverStreak,
  );
  return getSlackSettings();
}

export function recordAlarmEvent(e: {
  ts: number;
  pageId: number | null;
  pageLabel: string | null;
  kind: 'alarm' | 'recovery';
  title: string;
  detail: string;
  badCount: number; // 이 발사 시점의 누적 실패/심각 횟수(복구는 0) — 메시지 표시·이력용
  lastCheckId: number; // 이 발사가 카운트한 마지막 점검 id — 다음 회차 '새 실패' 기준선(복구는 0)
  slackStatus: SlackStatus;
  slackError: string | null;
}): void {
  db.prepare(
    `INSERT INTO alarm_events (ts, page_id, page_label, kind, title, detail, bad_count, last_check_id, slack_status, slack_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.ts,
    e.pageId,
    e.pageLabel,
    e.kind,
    e.title,
    e.detail,
    e.badCount,
    e.lastCheckId,
    e.slackStatus,
    e.slackError,
  );
}

interface AlarmRow {
  id: number;
  ts: number;
  page_id: number | null;
  page_label: string | null;
  kind: string;
  title: string;
  detail: string;
  slack_status: string;
  slack_error: string | null;
}

export function listAlarmEvents(limit = 200): AlarmEvent[] {
  const lim = clamp(Math.round(Number(limit) || 200), 1, 1000);
  const rows = db
    .prepare('SELECT * FROM alarm_events ORDER BY ts DESC, id DESC LIMIT ?')
    .all(lim) as AlarmRow[];
  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    pageId: r.page_id,
    pageLabel: r.page_label,
    kind: r.kind === 'recovery' ? 'recovery' : 'alarm',
    title: r.title,
    detail: r.detail,
    slackStatus: (['sent', 'failed', 'skipped'].includes(r.slack_status)
      ? r.slack_status
      : 'skipped') as SlackStatus,
    slackError: r.slack_error,
  }));
}

// 알람 평가용 — 페이지별 최근 N회 점검(최신순). 윈도우 충족 여부와 실패/심각 카운트 계산에 쓴다.
export function recentChecksForPage(
  pageId: number,
  n: number,
): Array<{ id: number; ok: number; durationMs: number; sessionExpired: number }> {
  const lim = clamp(Math.round(Number(n) || 1), 1, 100);
  return db
    .prepare(
      `SELECT id, ok, duration_ms AS durationMs, session_expired AS sessionExpired
       FROM checks WHERE page_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(pageId, lim) as Array<{
    id: number;
    ok: number;
    durationMs: number;
    sessionExpired: number;
  }>;
}

// 페이지의 최신 알람 이벤트(쿨다운 경과·복구 발송·'새 실패' 기준선 판정용). 재시작해도 DB 기준이라 안전.
export function lastAlarmEvent(
  pageId: number,
): { kind: string; ts: number; badCount: number; lastCheckId: number } | undefined {
  const r = db
    .prepare(
      `SELECT kind, ts, bad_count AS badCount, last_check_id AS lastCheckId
       FROM alarm_events WHERE page_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(pageId) as
    | { kind: string; ts: number; badCount: number; lastCheckId: number }
    | undefined;
  return r;
}
