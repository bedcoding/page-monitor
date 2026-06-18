import cron, { type ScheduledTask } from 'node-cron';
import { listPages, recordChecks, recordApiCalls, pruneHistory, getSettings } from './db';
import { checkAllPages } from './checker';
import { broadcast } from './events';
import { evaluateAndNotify } from './slack';
import { getConfig } from './config';
import type { SchedulerStatus } from '../shared/types';

// 자동 주기 점검(2단계). 측정 주기/켜짐/보관기간은 DB settings(설정 탭에서 편집)에서 읽고,
// 설정 변경 시 reconfigure() 로 타이머를 즉시 재시작한다.
let task: ScheduledTask | null = null;
let enabled = false;
let cronExpr = '';
let running = false; // 점검 진입 락 — 수동/자동이 공유해 겹침 방지
let lastRun: number | null = null;
let lastPrune = 0;
const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** 측정 주기(분) → cron 식. 60 미만은 N분마다, 60은 매시 정각, 초과는 N시간마다(근사). */
export function minutesToCron(min: number): string {
  const m = clamp(Math.round(Number(min) || 5), 1, 1440);
  if (m < 60) return `*/${m} * * * *`;
  if (m === 60) return '0 * * * *';
  return `0 */${clamp(Math.round(m / 60), 1, 24)} * * *`;
}

/**
 * 점검 진입 락. 수동(POST /api/check)·자동(cron) 양쪽이 같은 플래그를 공유해
 * 두 점검이 동시에 헤드리스 브라우저를 띄우는 것을 막는다. 잡으면 true.
 * 반드시 finally 에서 releaseCheck() 로 풀 것.
 */
export function tryAcquireCheck(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function releaseCheck(): void {
  running = false;
}

/** running 이 풀릴 때까지(또는 타임아웃까지) 대기 — 그레이스풀 종료용. */
export async function awaitIdle(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (running && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
}

/** 전체 페이지 1회 자동 점검(cron 콜백) — 락을 내부에서 잡고, 결과/이력 + 수집 API 저장. */
export async function runScheduledCheck(): Promise<void> {
  if (!tryAcquireCheck()) {
    console.log('[scheduler] 다른 점검이 진행 중 — 이번 회차 건너뜀');
    return;
  }
  const startedAt = Date.now();
  lastRun = startedAt;
  try {
    const pages = listPages();
    if (pages.length === 0) {
      console.log('[scheduler] 등록된 페이지 없음 — 건너뜀');
      return;
    }
    const cfg = getConfig();
    const outcomes = await checkAllPages(pages, cfg.loginPattern);
    recordChecks(outcomes.map(o => o.result));
    // 세션 만료/실패 점검의 API 는 그 페이지의 것이 아니므로 제외(수동 점검과 동일 규칙).
    for (const o of outcomes) {
      if (o.result.sessionExpired || !o.result.ok) continue;
      recordApiCalls(o.result.pageId, o.apis);
    }
    const okN = outcomes.filter(o => o.result.ok).length;
    console.log(
      `[scheduler] 자동 점검 완료 ${okN}/${outcomes.length} OK · ${Date.now() - startedAt}ms`,
    );
    // 구독 중인 대시보드에 "방금 점검 끝남" 푸시 → 화면 자동 갱신
    broadcast({ type: 'checked', source: 'scheduled', at: new Date().toISOString() });
    // 슬랙 알람 평가/발송(꺼져 있으면 즉시 반환)
    await evaluateAndNotify().catch(e => console.error('[slack] notify failed:', e));
    // 하루 1회 오래된 이력 정리(무한 성장 방지)
    maybePrune(getSettings().retentionDays);
  } catch (e) {
    console.error('[scheduler] 점검 중 오류:', e);
  } finally {
    releaseCheck();
  }
}

/** 마지막 정리 후 하루 지났으면 보존기간 밖 이력을 정리. retentionDays<=0 이면 비활성. */
function maybePrune(retentionDays: number): void {
  if (!(retentionDays > 0)) return;
  if (Date.now() - lastPrune < DAY_MS) return;
  lastPrune = Date.now();
  try {
    const r = pruneHistory(retentionDays);
    if (r.checks || r.apis) {
      console.log(`[scheduler] 이력 정리(보존 ${retentionDays}일): checks -${r.checks}, api -${r.apis}`);
    }
  } catch (e) {
    console.error('[scheduler] 이력 정리 오류:', e);
  }
}

/** 서버 기동 시 1회 호출. settings(enabled/주기) + env(SCHEDULER=off)로 켜고 끈다. */
export function startScheduler(): void {
  const settings = getSettings();
  cronExpr = minutesToCron(settings.checkIntervalMin);
  if (process.env.SCHEDULER === 'off' || !settings.enabled) {
    enabled = false;
    console.log('[scheduler] 비활성 — 수동 점검만 동작 (SCHEDULER=off 또는 설정에서 자동 점검 끔)');
    return;
  }
  if (!cron.validate(cronExpr)) {
    enabled = false;
    console.error(`[scheduler] cron 변환 실패 "${cronExpr}" — 스케줄러 미작동`);
    return;
  }
  task = cron.schedule(cronExpr, runScheduledCheck);
  enabled = true;
  console.log(`[scheduler] 활성 — "${cronExpr}" (${settings.checkIntervalMin}분 주기)`);
}

/** 설정 변경 즉시 반영 — 다음 발화를 막고 새 주기로 재시작(진행 중 회차는 안 건드림). */
export function reconfigure(): void {
  stopScheduler();
  startScheduler();
  console.log('[scheduler] 설정 변경 반영(reconfigure)');
}

/** 그레이스풀 종료용 — 예약된 cron 중지(진행 중 회차 완료 대기는 awaitIdle 로). */
export function stopScheduler(): void {
  task?.stop();
  task = null;
}

export function schedulerStatus(): SchedulerStatus {
  return { enabled, cron: cronExpr, running, lastRun };
}
