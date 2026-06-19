import {
  getSlackSettings,
  getSettings,
  listPages,
  recentChecksForPage,
  lastAlarmEvent,
  recordAlarmEvent,
} from './db';
import type { SlackSettings, SlackStatus, SlackTestResult, PageTarget } from '../shared/types';

/**
 * 슬랙 알람 — 원본 맥북앱(mac-api-monitor)의 Notifier 를 '페이지 단위'로 이식.
 * 점검 회차가 끝날 때마다 evaluateAndNotify() 호출 → 페이지별로 최근 N회 중 M회 이상
 * '실패/심각'이면 1건 발송(쿨다운 적용), 정상화되면 복구 1건.
 * 알람 상태는 메모리가 아니라 DB(checks + alarm_events) 로 판정해 재시작에 안전하다.
 */

const SLACK_TIMEOUT_MS = 10_000;
const SLACK_MAX_RETRY = 2; // 5xx/429/네트워크/타임아웃 시 추가 재시도

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 에러/로그에서 webhook URL·bot token 시크릿을 가린다(DB 저장·콘솔 노출 방지). */
function maskSecret(s: SlackSettings, text: string): string {
  let out = text;
  if (s.webhookUrl) out = out.split(s.webhookUrl).join('[webhook]');
  if (s.botToken) out = out.split(s.botToken).join('[token]');
  return out;
}

/** 슬랙 발송 — 타임아웃 + 재시도(5xx/429/네트워크). 4xx성/설정문제는 즉시 실패. */
async function sendSlack(
  s: SlackSettings,
  text: string,
): Promise<{ status: SlackStatus; error: string | null }> {
  if (s.mode === 'bot') {
    if (!s.botToken || !s.channel) return { status: 'skipped', error: 'Bot Token 또는 채널 미설정' };
  } else if (!s.webhookUrl) {
    return { status: 'skipped', error: 'Webhook URL 미설정' };
  }

  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= SLACK_MAX_RETRY; attempt++) {
    if (attempt > 0) await delay(500 * attempt); // 선형 backoff
    try {
      if (s.mode === 'bot') {
        const r = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${s.botToken}`,
          },
          body: JSON.stringify({ channel: s.channel, text }),
          signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
        });
        if (r.status === 429 || r.status >= 500) {
          lastErr = `HTTP ${r.status}`;
          continue;
        }
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (j.ok) return { status: 'sent', error: null };
        if (j.error === 'rate_limited') {
          lastErr = 'rate_limited';
          continue;
        }
        return { status: 'failed', error: `Slack API: ${j.error ?? 'unknown'}` };
      } else {
        const r = await fetch(s.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
        });
        if (r.ok) return { status: 'sent', error: null };
        if (r.status === 429 || r.status >= 500) {
          lastErr = `HTTP ${r.status}`;
          continue;
        }
        return { status: 'failed', error: `Webhook HTTP ${r.status}` };
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err); // 타임아웃/네트워크 → 재시도
    }
  }
  const masked = maskSecret(s, lastErr);
  console.warn('[slack] send failed after retries:', masked);
  return { status: 'failed', error: masked };
}

/** 설정 화면 "Slack 테스트" 버튼용. */
export async function testSlack(): Promise<SlackTestResult> {
  const s = getSlackSettings();
  if (s.mode === 'bot' && (!s.botToken || !s.channel)) {
    return { ok: false, message: 'Bot Token과 채널을 모두 입력하세요.' };
  }
  if (s.mode === 'webhook' && !s.webhookUrl) {
    return { ok: false, message: 'Webhook URL을 입력하세요.' };
  }
  const text = `:white_check_mark: Page Monitor 테스트 메시지 — ${new Date().toLocaleString('ko-KR')}`;
  const r = await sendSlack(s, text);
  return r.status === 'sent'
    ? { ok: true, message: '발송 성공! 슬랙 채널을 확인하세요.' }
    : { ok: false, message: `발송 실패: ${r.error ?? 'unknown'}` };
}

/** 점검 1건이 '실패/심각'인지 — 세션 만료는 장애 아님, 주의(느림)는 알람 대상 아님. */
function isBad(
  c: { ok: number; durationMs: number; sessionExpired: number },
  criticalMs: number,
): boolean {
  if (c.sessionExpired) return false;
  if (!c.ok) return true; // 응답 자체 실패
  return c.durationMs >= criticalMs; // 심각(느리지만 응답 옴)
}

/** 최근 윈도우 내 '나쁜' 점검의 종류별 집계 — 메시지를 '접속 실패/데이터 오류/속도지연'으로 구분해 표시. */
type BadBreakdown = {
  fails: number; // 응답 자체가 실패(❌ — HTTP 4xx/5xx·타임아웃·로드 실패) 횟수
  dataFails: number; // HTML 은 200인데 같은 사이트 데이터 API 만 5xx/실패라 강등된(failOnApiError) 횟수
  slows: number; // 느리지만 응답은 옴(🔴 속도지연 — durationMs ≥ criticalMs) 횟수
  maxSlowMs: number; // 지연 건 중 가장 느린 응답시간(메시지에 '최대 N ms' 로 표시)
};

// HTML 진입은 정상(2xx/3xx)인데 같은 사이트 데이터 API 만 깨져 강등된 건인지 — '접속 실패'와 구분하기 위함.
function isDataFail(c: { ok: number; status: number; apiFailCount: number }): boolean {
  return !c.ok && c.apiFailCount > 0 && c.status >= 200 && c.status < 400;
}

/**
 * 슬랙/내역에 쓸 제목·상세 문구를 만든다.
 * 제목은 기존처럼 `🔴 {라벨}` 만(군더더기 없음). 상세 한 줄에서 '실패/심각'으로 뭉뚱그리지 않고
 * 응답 자체 실패(접속 실패)와 느림(속도지연)을 횟수로 나눠 보여준다 — 단순 지연을 '실패'로 표시해
 * 과하게 살벌해 보이던 문제 해소. 없는 종류는 생략하고, 지연이 있으면 가장 느린 응답시간(ms)도 함께 표기.
 */
function buildAlarm(
  p: PageTarget,
  evaluated: number, // 실제로 평가한 최근 점검 수(데이터가 윈도우보다 적을 수 있어 정직하게 표기)
  bd: BadBreakdown,
  fresh: number,
  renotify: boolean,
): { title: string; detail: string } {
  const parts: string[] = [];
  if (bd.fails > 0) parts.push(`실패 ${bd.fails}회`);
  if (bd.dataFails > 0) parts.push(`데이터 API 오류 ${bd.dataFails}회`);
  if (bd.slows > 0) parts.push(`지연 ${bd.slows}회 (최대 ${bd.maxSlowMs}ms)`);
  const extra = renotify ? ` (새 ${fresh}건)` : '';
  return {
    title: `🔴 ${p.label}`,
    detail: `${p.url} · 최근 ${evaluated}회 중 ${parts.join(' · ')}${extra}`,
  };
}

async function fire(
  s: SlackSettings,
  p: PageTarget,
  now: number,
  evaluated: number, // 실제 평가한 최근 점검 수(메시지 '최근 N회 중' 표기에 사용)
  bd: BadBreakdown, // 실패/데이터오류/지연 종류별 집계 — 메시지 구분용
  fresh: number, // 이번 회차에 '새로' 생긴 실패 수 — 재알림이면 '(새 N건)' 으로 표기
  lastCheckId: number, // 여기까지 카운트함 — 다음 회차 '새 실패' 기준선으로 저장
  renotify: boolean, // 재알림(이미 울리는 중 악화)이면 새 건수 표기
): Promise<void> {
  const total = bd.fails + bd.dataFails + bd.slows; // 누적(최근 N회 중 총 나쁨) — 이력 badCount 로 저장
  const { title, detail } = buildAlarm(p, evaluated, bd, fresh, renotify);
  const r = await sendSlack(s, `${title}\n${detail}`);
  recordAlarmEvent({
    ts: now,
    pageId: p.id,
    pageLabel: p.label,
    kind: 'alarm',
    title,
    detail,
    badCount: total,
    lastCheckId,
    slackStatus: r.status,
    slackError: r.error,
  });
}

async function recover(
  s: SlackSettings,
  p: PageTarget,
  now: number,
  lastCheckId: number, // 복구 시점까지 본 지점 — 윈도우에 남은 옛 실패로 재발동되지 않도록 기준선 저장
): Promise<void> {
  const title = `✅ 복구 ${p.label}`;
  const detail = `${p.url} · 최근 ${s.recoverStreak}회 연속 정상`;
  const r = await sendSlack(s, `${title}\n${detail}`);
  recordAlarmEvent({
    ts: now,
    pageId: p.id,
    pageLabel: p.label,
    kind: 'recovery',
    title,
    detail,
    badCount: 0,
    lastCheckId,
    slackStatus: r.status,
    slackError: r.error,
  });
}

/**
 * 한 점검 회차 종료 시 호출. 페이지별로 알람/복구 판정 후 발송.
 * 슬랙 꺼져 있으면 즉시 반환. 발송 실패가 점검 흐름을 막지 않도록 호출부에서 catch.
 */
export async function evaluateAndNotify(pageId?: number): Promise<void> {
  const slack = getSlackSettings();
  if (!slack.enabled) return;
  const criticalMs = getSettings().criticalMs;
  const now = Date.now();
  const cooldownMs = slack.cooldownMin * 60_000;

  // pageId 가 주어지면(단건 점검) 그 페이지만 평가 — 전체 평가하면 새 점검이 없는 다른 페이지의 복구/발동을 건드린다.
  const pages = pageId != null ? listPages().filter(p => p.id === pageId) : listPages();
  for (const p of pages) {
    const recent = recentChecksForPage(p.id, slack.windowSize);
    // threshold 만큼의 점검 데이터도 없으면 판단 보류(예: 2회 실패하려면 최소 2회는 점검돼 있어야).
    // 윈도우(windowSize)를 다 채울 때까지 기다리지 않으므로 'threshold 회 실패 시 곧 알람'이 직관대로 동작.
    if (recent.length < slack.threshold) continue;
    const badChecks = recent.filter(c => isBad(c, criticalMs));
    // 같은 '나쁨'이라도 접속 실패 / 데이터 API 오류(HTML 200·API만 5xx) / 느림(속도지연)을 나눠 집계 → 메시지 구분.
    const slowChecks = badChecks.filter(c => c.ok); // ok=1 이면서 isBad → 심각(느림)
    const dataChecks = badChecks.filter(isDataFail); // ok=0 이지만 HTML 진입은 정상, API 만 깨짐
    const failChecks = badChecks.filter(c => !c.ok && !isDataFail(c)); // 진짜 접속 실패
    const bd: BadBreakdown = {
      fails: failChecks.length,
      dataFails: dataChecks.length,
      slows: slowChecks.length,
      maxSlowMs: slowChecks.reduce((m, c) => Math.max(m, c.durationMs), 0),
    };
    const maxId = recent[0].id; // 최신 점검 id(최신순 첫 행) — 발사 시 '여기까지 봄' 기준선

    const last = lastAlarmEvent(p.id);
    const firing = last?.kind === 'alarm';
    // 마지막 이벤트(발동이든 복구든)가 본 지점 이후의 '새 실패'만 트리거로 센다.
    // → 복구 후 윈도우에 남은 옛 실패로 재발동되지 않고, 이미 알린 실패도 반복 발사되지 않는다.
    const baseId = last?.lastCheckId ?? 0;
    const fresh = badChecks.filter(c => c.id > baseId).length;

    if (!firing) {
      // 첫 발동 — 마지막 복구(또는 최초) 이후 '새 실패'가 threshold 이상(복구 직후 떨림은 쿨다운으로 억제).
      const cooldownPassed = now - (last?.ts ?? 0) >= cooldownMs;
      if (fresh >= slack.threshold && cooldownPassed) {
        await fire(slack, p, now, recent.length, bd, fresh, maxId, false);
      }
    } else {
      // 울리는 중. 복구 = 최근 recoverStreak 회가 '연속 정상'이면(윈도우 전체가 0 되길 안 기다림 — 너무 늦음).
      // recoverEnabled 가 꺼져 있으면 복구 알람을 보내지 않는다(발동 알람만).
      const streak = slack.recoverStreak;
      const recentOk =
        slack.recoverEnabled &&
        recent.length >= streak &&
        recent.slice(0, streak).every(c => !isBad(c, criticalMs));
      if (recentOk) {
        await recover(slack, p, now, maxId);
      } else if (fresh >= slack.threshold) {
        // 새 악화 = 마지막 발사 이후 '새로 생긴' 실패가 threshold 이상일 때만 재발사.
        await fire(slack, p, now, recent.length, bd, fresh, maxId, true);
      }
      // fresh < threshold → 침묵
    }
  }
}
