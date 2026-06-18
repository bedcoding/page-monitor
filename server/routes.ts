import type { FastifyInstance } from 'fastify';
import {
  listPages,
  addPage,
  importPages,
  updatePage,
  deletePage,
  recordChecks,
  latestResults,
  recordApiCalls,
  apisByPage,
  addManualApi,
  deleteManualApi,
  listApiCalls,
  pagesByApi,
  pageHistory,
  dailyStats,
  checksByDate,
  getSettings,
  updateSettings,
  getSlackSettings,
  updateSlackSettings,
  listAlarmEvents,
} from './db';
import { checkAllPages, sessionStatus, testApiCall } from './checker';
import { schedulerStatus, tryAcquireCheck, releaseCheck, reconfigure } from './scheduler';
import { addClient, broadcast } from './events';
import { testSlack, evaluateAndNotify } from './slack';
import { getConfig } from './config';
import type {
  NewPage,
  CheckResult,
  ExportData,
  SettingsPatch,
  SlackSettingsPatch,
} from '../shared/types';

// 시크릿(webhook URL·bot token) 화면 표시용 마스킹 — 값 유무·앞뒤 일부만 보이고 본문은 가린다.
// (빈 값은 빈 문자열 그대로 — UI 에서 '미설정'으로 보이게)
function maskForDisplay(s: string): string {
  if (!s) return '';
  if (s.length <= 10) return '••••••';
  return s.slice(0, 6) + '••••••••' + s.slice(-4);
}

// 수동 API 일괄 입력 항목 파싱 — "GET /path" / "/path"(method 기본 GET) / {method?, path|url} 모두 허용.
// (내보낸 JSON 의 apis 항목 {method,url,path,...} 도 그대로 먹힌다.)
function parseManualApiItem(raw: unknown): { method: string; path: string } | null {
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const m = s.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
    if (m) return { method: m[1].toUpperCase(), path: m[2].trim() };
    return { method: 'GET', path: s }; // 경로만 주면 GET
  }
  if (raw && typeof raw === 'object') {
    const o = raw as { method?: unknown; path?: unknown; url?: unknown };
    const path = String(o.path ?? o.url ?? '').trim();
    if (!path) return null;
    const method = String(o.method ?? 'GET').trim().toUpperCase() || 'GET';
    return { method, path };
  }
  return null;
}

export function registerRoutes(app: FastifyInstance): void {
  // 점검 대상 목록
  app.get('/api/pages', async () => listPages());

  // 점검 대상 추가 — body 스키마로 타입 검증(실패 시 Fastify 가 자동 400 반환)
  app.post(
    '/api/pages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', minLength: 1 },
            label: { type: 'string' },
            group: { type: ['string', 'null'] },
            loginRequired: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as NewPage;
      const url = b.url.trim();
      if (!url) {
        // 공백뿐인 url 은 스키마(minLength)를 통과하므로 여기서 400 처리
        return reply.code(400).send({ error: 'url이 필요합니다.' });
      }
      const id = addPage({
        url,
        label: (b.label ?? '').trim() || url,
        group: typeof b.group === 'string' ? b.group.trim() || null : null,
        login_required: b.loginRequired === false ? 0 : 1,
      });
      return { id };
    },
  );

  // 점검 대상 JSON 일괄 추가 — 최상위 배열 또는 { pages: [...] }(내보내기 JSON 호환)
  app.post('/api/pages/import', async (req, reply) => {
    const body = req.body as unknown;
    const list = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as { pages?: unknown }).pages)
        ? (body as { pages: unknown[] }).pages
        : null;
    if (!list) {
      return reply
        .code(400)
        .send({ error: '최상위 JSON 배열 또는 { "pages": [...] } 형식이 필요합니다.' });
    }
    const r = importPages(list);
    return { ...r, total: list.length };
  });

  // 점검 대상 메타 수정(이름/그룹/로그인필요) — url 은 바꾸지 않음(이력 기준)
  app.patch(
    '/api/pages/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            group: { type: ['string', 'null'] },
            loginRequired: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: '잘못된 id' });
      }
      const b = req.body as { label?: string; group?: string | null; loginRequired?: boolean };
      const patch: { label?: string; group?: string | null; login_required?: number } = {};
      if (b.label !== undefined) {
        const label = b.label.trim();
        if (!label) return reply.code(400).send({ error: '이름이 비어 있습니다.' });
        patch.label = label;
      }
      if (b.group !== undefined) {
        patch.group = typeof b.group === 'string' ? b.group.trim() || null : null;
      }
      if (b.loginRequired !== undefined) {
        patch.login_required = b.loginRequired ? 1 : 0;
      }
      const ok = updatePage(id, patch);
      if (!ok) return reply.code(404).send({ error: '해당 페이지가 없습니다.' });
      return { updated: true };
    },
  );

  // 점검 대상 삭제 — checks·API 매핑도 CASCADE 로 함께 정리됨
  app.delete('/api/pages/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: '잘못된 id' });
    }
    const deleted = deletePage(id);
    if (!deleted) {
      return reply.code(404).send({ error: '해당 페이지가 없습니다.' });
    }
    return { deleted: true };
  });

  // 전체 즉시 점검 — Playwright 동시 방문 → 결과 반환 + DB 저장
  app.post('/api/check', async (_req, reply) => {
    // 자동(cron)/수동 점검이 같은 락을 공유 — 이미 점검 중이면 409(겹쳐 띄우지 않음)
    if (!tryAcquireCheck()) {
      return reply.code(409).send({ error: '이미 점검이 진행 중입니다. 잠시 후 다시 시도하세요.' });
    }
    try {
      const pages = listPages();
      const cfg = getConfig();
      const outcomes = await checkAllPages(pages, cfg.loginPattern);
      const results = outcomes.map(o => o.result);
      recordChecks(results);
      // 점검하는 '그 김에' 수집된 페이지별 호출 API 도 저장.
      // 단, 세션 만료(로그인 페이지로 튕김)나 실패한 점검의 API 는 그 페이지의 것이 아니므로 제외.
      for (const o of outcomes) {
        if (o.result.sessionExpired || !o.result.ok) continue;
        recordApiCalls(o.result.pageId, o.apis);
      }
      // 구독 중인 다른 대시보드에도 "방금 점검 끝남" 푸시(누른 본인은 이 응답으로 바로 갱신)
      broadcast({ type: 'checked', source: 'manual', at: new Date().toISOString() });
      // 슬랙 알람 평가/발송(꺼져 있으면 즉시 반환). 실패해도 점검 응답은 정상 반환.
      await evaluateAndNotify().catch(e => console.warn('[slack] notify failed:', e));
      return results;
    } finally {
      releaseCheck();
    }
  });

  // 각 페이지 최근 점검 결과
  app.get('/api/results/latest', async () => latestResults());

  // 특정 페이지의 API 목록 (자동 감지 + 수동 등록, source 로 구분)
  app.get('/api/pages/:id/apis', async req => {
    const id = Number((req.params as { id: string }).id);
    return apisByPage(id);
  });

  // 수동 API 등록 — Next.js SSR 등 브라우저에 안 잡히는 API 를 사람이 기록(method+path)
  app.post(
    '/api/pages/:id/apis',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            method: { type: 'string' },
            path: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: '잘못된 id' });
      const b = req.body as { method?: string; path: string };
      const method = (b.method ?? 'GET').trim().toUpperCase() || 'GET';
      const path = b.path.trim();
      if (!path) return reply.code(400).send({ error: '경로가 필요합니다.' });
      const added = addManualApi(id, method, path);
      return { added }; // 이미 있으면 added:false
    },
  );

  // 수동 API JSON 일괄 등록 — 배열 또는 { apis:[...] }. 각 항목 "GET /path" / "/path" / {method?,path}
  app.post('/api/pages/:id/apis/import', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: '잘못된 id' });
    const body = req.body as unknown;
    const list = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as { apis?: unknown }).apis)
        ? (body as { apis: unknown[] }).apis
        : null;
    if (!list) {
      return reply
        .code(400)
        .send({ error: '최상위 JSON 배열 또는 { "apis": [...] } 형식이 필요합니다.' });
    }
    let added = 0;
    let skipped = 0;
    for (const raw of list) {
      const p = parseManualApiItem(raw);
      if (!p) {
        skipped++;
        continue;
      }
      if (addManualApi(id, p.method, p.path)) added++;
      else skipped++;
    }
    return { added, skipped, total: list.length };
  });

  // API 단건 테스트 — GET 만 허용(읽기 전용·부작용 없음). storageState 로 로그인 상태로 1회 호출.
  // 자동 감지 API 는 절대 URL, 수동 등록 API 는 상대경로(/api/foo)라 페이지 origin 으로 절대화한다.
  app.post(
    '/api/pages/:id/apis/test',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            method: { type: 'string' },
            url: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: '잘못된 id' });
      const b = req.body as { method?: string; url: string };
      const method = (b.method ?? 'GET').trim().toUpperCase();
      if (method !== 'GET') {
        return reply.code(400).send({ error: 'GET 메서드만 테스트할 수 있습니다 (부작용 방지).' });
      }
      const page = listPages().find(p => p.id === id);
      if (!page) return reply.code(404).send({ error: '해당 페이지가 없습니다.' });
      const rawUrl = b.url.trim();
      // 동적 파라미터(<id> 등) 템플릿 URL 은 placeholder 를 그대로 호출해봐야 무의미 → 거부(클라 자동 판정과 동일).
      if (/[<>]/.test(rawUrl)) {
        return reply
          .code(400)
          .send({ error: '동적 파라미터(<id> 등)가 포함되어 호출할 수 없습니다.' });
      }
      // 절대 URL 이면 그대로, 상대경로면 페이지 url 을 기준으로 절대화.
      let target = rawUrl;
      if (!/^https?:\/\//i.test(target)) {
        try {
          target = new URL(target, page.url).href;
        } catch {
          return reply.code(400).send({ error: '테스트할 URL을 만들 수 없습니다.' });
        }
      }
      // 이 페이지와 같은 사이트(origin)의 API 만 — SSRF/오용 방지 + '이 페이지의 API 테스트' 의도에 부합.
      // (자동 감지 API 는 애초에 same-site 만 수집되므로 정상 케이스는 모두 통과)
      try {
        if (new URL(target).origin !== new URL(page.url).origin) {
          return reply
            .code(400)
            .send({ error: '이 페이지와 같은 사이트의 API만 테스트할 수 있습니다.' });
        }
      } catch {
        return reply.code(400).send({ error: '유효하지 않은 URL입니다.' });
      }
      const useSession = page.login_required === 1;
      const cfg = getConfig();
      const result = await testApiCall(target, useSession, cfg.loginPattern);
      return result;
    },
  );

  // 수동 API 삭제 — source='manual' 인 것만(자동 감지 건은 다음 점검에 다시 생김)
  app.delete('/api/pages/:id/apis', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { method?: string; url?: string };
    if (!Number.isInteger(id) || !q.method || !q.url) {
      return reply.code(400).send({ error: 'method, url 쿼리가 필요합니다.' });
    }
    const deleted = deleteManualApi(id, q.method, q.url);
    if (!deleted) return reply.code(404).send({ error: '해당 수동 API가 없습니다.' });
    return { deleted: true };
  });

  // 특정 페이지의 점검 이력(추이용) — 오래된→최신 순
  app.get('/api/pages/:id/history', async req => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return [];
    return pageHistory(id);
  });

  // 로그 탭 — 일별 집계(막대) · ?days=30
  app.get('/api/pages/:id/daily', async req => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return [];
    const days = Number((req.query as { days?: string }).days) || 30;
    return dailyStats(id, days);
  });

  // 로그 탭 드릴다운 — 특정 날짜의 개별 점검(동그라미) · ?date=YYYY-MM-DD
  app.get('/api/pages/:id/checks', async req => {
    const id = Number((req.params as { id: string }).id);
    const date = (req.query as { date?: string }).date;
    if (!Number.isInteger(id) || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    return checksByDate(id, date);
  });

  // 스케줄러(자동 주기 점검) 상태
  app.get('/api/scheduler', async () => schedulerStatus());

  // SSE 구독 — 점검이 끝날 때마다 서버가 push. 대시보드가 폴링 없이 실시간 갱신.
  app.get('/api/events', async (_req, reply) => {
    addClient(reply); // reply.hijack() 으로 연결을 열어둔 채 유지
  });

  // ── 슬랙 알람 ──
  // 조회 시 시크릿은 마스킹(앞 몇 자 + 뒤 몇 자만). 실제 발송은 서버 내부의 평문값을 쓴다.
  app.get('/api/slack/settings', async () => {
    const s = getSlackSettings();
    return { ...s, webhookUrl: maskForDisplay(s.webhookUrl), botToken: maskForDisplay(s.botToken) };
  });

  app.patch(
    '/api/slack/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            mode: { type: 'string', enum: ['webhook', 'bot'] },
            webhookUrl: { type: 'string' },
            botToken: { type: 'string' },
            channel: { type: 'string' },
            cooldownMin: { type: 'number' },
            windowSize: { type: 'number' },
            threshold: { type: 'number' },
            recoverEnabled: { type: 'boolean' },
            recoverStreak: { type: 'number' },
          },
        },
      },
    },
    async req => {
      const body = { ...(req.body as SlackSettingsPatch) };
      // 마스킹된 값(• 포함)이 그대로 돌아오면 = 사용자가 안 바꾼 것 → 그 필드는 무시(기존 평문 보존).
      if (typeof body.webhookUrl === 'string' && body.webhookUrl.includes('•')) delete body.webhookUrl;
      if (typeof body.botToken === 'string' && body.botToken.includes('•')) delete body.botToken;
      return updateSlackSettings(body);
    },
  );

  // 슬랙 테스트 발송(설정 화면 버튼)
  app.post('/api/slack/test', async () => testSlack());

  // 알람 발송 내역(최신순)
  app.get('/api/slack/events', async req => {
    const limit = Number((req.query as { limit?: string }).limit) || 200;
    return listAlarmEvents(limit);
  });

  // ── 설정(설정 탭) ──
  app.get('/api/settings', async () => getSettings());

  // 설정 부분 수정 → 저장 + 스케줄러 즉시 재구성(주기/켜짐 변경 반영)
  app.patch(
    '/api/settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            checkIntervalMin: { type: 'number' },
            warningMs: { type: 'number' },
            criticalMs: { type: 'number' },
            retentionDays: { type: 'number' },
          },
        },
      },
    },
    async req => {
      const next = updateSettings(req.body as SettingsPatch);
      reconfigure(); // enabled/주기 변경을 타이머에 즉시 적용
      return next;
    },
  );

  // 전체 데이터 JSON 내보내기 — 페이지 + 최신 결과 + API 매핑 + API별 요약을 한 묶음으로.
  app.get('/api/export', async (): Promise<ExportData> => {
    const pages = listPages();
    const latest = new Map<number, CheckResult>(latestResults().map(r => [r.pageId, r]));
    return {
      exportedAt: new Date().toISOString(),
      pageCount: pages.length,
      pages: pages.map(p => ({
        id: p.id,
        url: p.url,
        label: p.label,
        group: p.group,
        loginRequired: p.login_required === 1,
        latestResult: latest.get(p.id) ?? null,
        apis: apisByPage(p.id),
      })),
      apiSummary: listApiCalls(),
    };
  });

  // 수집된 전체 API 목록 (API → 페이지 보기)
  app.get('/api/apis', async () => listApiCalls());

  // 특정 API 를 호출한 페이지 목록 (API → 페이지 역매핑)
  app.get('/api/apis/:id/pages', async req => {
    const id = Number((req.params as { id: string }).id);
    return pagesByApi(id);
  });

  // 로그인 세션 상태(storageState 존재/저장시각)
  app.get('/api/session', async () => sessionStatus());
}
