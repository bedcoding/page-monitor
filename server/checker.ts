import { chromium, request, type Browser, type Request } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import type {
  PageTarget,
  CheckResult,
  SessionStatus,
  CapturedApi,
  PageCheckOutcome,
  ApiTestResult,
} from '../shared/types';
import { DATA_DIR } from './paths';

export const STORAGE_STATE_PATH = path.join(DATA_DIR, 'storageState.json');

const CONCURRENCY = 6; // 동시 방문 상한 (6시 정각 전체 동시 + 리소스 폭주 방지)
const NAV_TIMEOUT_MS = 30_000;
const API_COLLECT_MS = 4_000; // 진입 후 networkidle 까지 추가 대기(최대) — API 수집용, 진입속도엔 미포함

function hasStorageState(): boolean {
  return fs.existsSync(STORAGE_STATE_PATH);
}

export function sessionStatus(): SessionStatus {
  try {
    const st = fs.statSync(STORAGE_STATE_PATH);
    return { exists: true, savedAt: st.mtimeMs };
  } catch {
    return { exists: false, savedAt: null };
  }
}

/**
 * 등록된 페이지 전체를 헤드리스 크롬으로 동시에 방문해 진입 속도/상태를 측정.
 * 로그인 필요 페이지는 storageState(저장된 세션)를 주입한다.
 */
export async function checkAllPages(
  pages: PageTarget[],
  loginPattern: string,
): Promise<PageCheckOutcome[]> {
  if (pages.length === 0) return [];
  const browser = await chromium.launch({ headless: true });
  const limit = pLimit(CONCURRENCY);
  try {
    return await Promise.all(pages.map(p => limit(() => checkOne(browser, p, loginPattern))));
  } finally {
    await browser.close();
  }
}

async function checkOne(
  browser: Browser,
  target: PageTarget,
  loginPattern: string,
): Promise<PageCheckOutcome> {
  const ts = Date.now();
  // 로그인 필요 페이지면 저장된 세션 주입(없으면 비로그인 상태로 진입 → 보통 세션 만료로 잡힘).
  const useSession = target.login_required === 1 && hasStorageState();
  const context = await browser.newContext(useSession ? { storageState: STORAGE_STATE_PATH } : {});
  const page = await context.newPage();

  // 페이지를 방문하는 '그 김에' same-site API(xhr/fetch) 호출을 함께 수집한다.
  const apis: CapturedApi[] = [];
  let targetOrigin = '';
  try {
    targetOrigin = new URL(target.url).origin;
  } catch {
    /* 잘못된 url 은 아래 goto 에서 잡힌다 */
  }
  // 요청 시작 시각을 기록해 응답 도착까지의 소요시간(ms)을 잰다.
  const reqStartAt = new WeakMap<Request, number>();
  page.on('request', req => {
    reqStartAt.set(req, Date.now());
  });
  page.on('response', res => {
    try {
      if (!targetOrigin) return; // origin 파싱 실패 시 same-site 필터가 무력화되므로 아예 수집 안 함
      const req = res.request();
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return; // 정적자산 제외 — API 만
      const status = res.status();
      if (status >= 300 && status < 400) return; // 리다이렉트 중간 hop 제외 — 최종 응답만 집계
      const u = new URL(res.url());
      if (u.origin !== targetOrigin) return; // 같은 사이트만
      const startedAt = reqStartAt.get(req);
      apis.push({
        method: req.method(),
        url: res.url(),
        path: u.pathname,
        status,
        durationMs: startedAt ? Date.now() - startedAt : null,
      });
    } catch {
      /* 개별 응답 파싱 실패는 무시 */
    }
  });

  const start = Date.now();
  let navMs = 0;
  let status = 0;
  let ok = false;
  let error: string | null = null;
  let sessionExpired = false;

  try {
    const res = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    navMs = Date.now() - start; // 진입 속도 = domcontentloaded 까지
    status = res?.status() ?? 0;
    // 페이지가 호출하는 API 를 더 모으려 네트워크가 잠잠해질 때까지 잠깐 더 대기(진입속도엔 미포함)
    await page.waitForLoadState('networkidle', { timeout: API_COLLECT_MS }).catch(() => {});
    const finalUrl = page.url();

    if (loginPattern && finalUrl.includes(loginPattern)) {
      // 로그인 페이지로 튕김 = 세션 만료. 장애가 아니라 "재로그인 필요" 신호.
      sessionExpired = true;
      ok = false;
      error = `세션 만료 — 로그인 페이지로 이동됨 (${finalUrl})`;
    } else if (status >= 200 && status < 400) {
      ok = true;
    } else {
      // status 0 = 응답 객체 없음(res=null)/로드 실패. >=400 과 함께 실패로 처리.
      ok = false;
      error = status >= 400 ? `HTTP ${status}` : '응답 없음(로드 실패)';
    }
  } catch (e) {
    if (!navMs) navMs = Date.now() - start;
    ok = false;
    error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
  } finally {
    await context.close();
  }

  return {
    result: {
      pageId: target.id,
      url: target.url,
      label: target.label,
      ts,
      status,
      durationMs: navMs,
      ok,
      error,
      sessionExpired,
    },
    apis,
  };
}

/**
 * API 1건을 GET 으로 직접 호출해 살아있는지 확인('테스트' 버튼).
 * - GET 전용은 호출부(라우트)에서 강제 — 여기선 받은 url 을 그대로 GET 한다(부작용 없는 읽기).
 * - useSession=true 면 저장된 로그인 세션(storageState)의 쿠키를 실어 백오피스 API 도 인증 상태로 확인.
 * - 헤드리스 브라우저를 띄우지 않고 APIRequestContext 로 가볍게 쏜다(점검과 별개, 이력 저장 안 함).
 */
export async function testApiCall(
  url: string,
  useSession: boolean,
  loginPattern: string,
): Promise<ApiTestResult> {
  const ctx = await request.newContext(
    useSession && hasStorageState() ? { storageState: STORAGE_STATE_PATH } : {},
  );
  const start = Date.now();
  const MAX_BODY = 4096; // 응답 본문은 앞부분만(큰 JSON·민감 데이터 대비)
  try {
    const res = await ctx.get(url, { timeout: NAV_TIMEOUT_MS, maxRedirects: 10 });
    const durationMs = Date.now() - start;
    const status = res.status();
    const finalUrl = res.url();
    const contentType = (res.headers()['content-type'] ?? '').split(';')[0].trim();
    // 응답 본문 앞 4KB만 읽는다(못 읽으면 null). 상태와 무관하게 받아 '응답 보기'에 쓴다.
    let body: string | null = null;
    let bodyTruncated = false;
    try {
      const text = await res.text();
      bodyTruncated = text.length > MAX_BODY;
      body = bodyTruncated ? text.slice(0, MAX_BODY) : text;
    } catch {
      /* 본문 못 읽음 — null 유지 */
    }
    const base = { durationMs, status, contentType, body, bodyTruncated };
    // 401/403 또는 로그인 페이지로 리다이렉트 = 인증 필요(장애 아님 — 세션 만료와 동일 취급).
    if (status === 401 || status === 403 || (loginPattern && finalUrl.includes(loginPattern))) {
      return {
        ...base,
        ok: false,
        sessionExpired: true,
        error: `인증 필요 (HTTP ${status}) — 로그인 세션이 없거나 만료됨`,
      };
    }
    if (status >= 200 && status < 400) {
      return { ...base, ok: true, sessionExpired: false, error: null };
    }
    return { ...base, ok: false, sessionExpired: false, error: `HTTP ${status}` };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      durationMs: Date.now() - start,
      sessionExpired: false,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 300),
      contentType: '',
      body: null,
      bodyTruncated: false,
    };
  } finally {
    await ctx.dispose();
  }
}
