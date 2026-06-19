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
const NAV_TIMEOUT_MS = 30_000; // 기본 진입 타임아웃(설정 미지정 시). 보통은 navTimeoutFor(criticalMs) 로 동적 산정.
const API_COLLECT_MS = 4_000; // 진입 후 networkidle 까지 추가 대기(최대) — API 수집용, 진입속도엔 미포함
const MAX_BODY = 4096; // 실패 시 진단 스냅샷(본문/요약) 앞부분만 보관
const MAX_FAIL_LIST = 20; // body 요약에 담는 실패 API 최대 개수(캐시버스터 폭주 방어)

// 점검 1회의 옵션 — 설정 탭(DB settings)에서 파생해 호출부가 주입한다(checker 는 DB 를 모름 = 순수).
export interface CheckOptions {
  failOnApiError: boolean; // 같은 사이트 API 5xx/연결실패면 페이지를 실패로 승격할지
  navTimeoutMs: number; // 진입(goto) 타임아웃
}
const DEFAULT_OPTS: CheckOptions = { failOnApiError: true, navTimeoutMs: NAV_TIMEOUT_MS };

/**
 * 진입 타임아웃 = '심각' 임계의 2배, 단 [30s, 60s] 로 클램프.
 * 하한 30s 는 기존 고정값(NAV_TIMEOUT_MS)을 보존하기 위함 — criticalMs(느림 판정 임계)는 '죽음 판정 한계'가
 * 아니므로, 임계값을 작게 잡았다고 멀쩡하지만 무거운 페이지를 30s 전에 timeout(❌ 실패)으로 오탐하면 안 된다.
 * 임계값을 크게(>15s) 잡은 느린 페이지에서만 타임아웃이 더 늘어난다.
 */
export function navTimeoutFor(criticalMs: number): number {
  const base = Number(criticalMs) || 0;
  return Math.min(Math.max(base * 2, 30_000), 60_000);
}

// 흔한 2단계 TLD + 공유 PaaS private suffix — eTLD+1(등록 가능 도메인) 추정용. 완벽한 public-suffix 목록은 아님.
// PaaS 도메인(appspot.com 등)을 넣어두면 a.appspot.com↔b.appspot.com 같은 무관한 제3자 앱을
// same-site 로 오인해 엉뚱한 5xx 로 페이지를 강등하거나 남의 API 를 수집하는 일을 막는다.
const TWO_LEVEL_TLDS = new Set([
  'co.kr', 'ne.kr', 'or.kr', 'go.kr', 're.kr', 'pe.kr',
  'co.jp', 'ne.jp', 'or.jp', 'co.uk', 'org.uk', 'com.au', 'net.au', 'com.cn', 'com.br',
  // 공유 호스팅(같은 suffix 아래 서로 다른 소유자) — 사내 자체 도메인엔 영향 없고 PaaS 배포 시 오인 방지
  'appspot.com', 'herokuapp.com', 'github.io', 'web.app', 'firebaseapp.com',
  'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'cloudfront.net',
]);

/** host → 등록 가능 도메인(예: api.lezhin.com → lezhin.com, x.lezhin.co.kr → lezhin.co.kr). */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * 요청 host 가 점검 대상 페이지와 "같은 사이트"인지 — host 동일 또는 등록 가능 도메인 공유.
 * www.lezhin.com 페이지의 api.lezhin.com 호출을 같은 사이트로 본다(서브도메인 API 수집 누락 방지).
 * 판정 불가 시 false(오탐 방지).
 */
function isSameSite(reqHost: string, pageHost: string): boolean {
  if (!pageHost || !reqHost) return false;
  const r = reqHost.toLowerCase();
  const p = pageHost.toLowerCase();
  if (r === p) return true;
  return registrableDomain(r) === registrableDomain(p);
}

/**
 * 그 회차에 수집한 API 매핑을 저장할지 — 페이지에 정상 '진입'했는가(HTML 2xx/3xx).
 * API 오류로 ok=false 강등된 건(failOnApiError)도 진입 자체는 성공했으니 그 회차의 정상 API 매핑은 보존한다.
 * 세션 만료 / HTTP 4xx·5xx / 로드 실패(status 0)는 그 페이지의 API 가 아니므로 제외.
 */
export function didEnterPage(r: { sessionExpired: boolean; status: number }): boolean {
  return !r.sessionExpired && r.status >= 200 && r.status < 400;
}

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
  opts: CheckOptions = DEFAULT_OPTS,
): Promise<PageCheckOutcome[]> {
  if (pages.length === 0) return [];
  const browser = await chromium.launch({ headless: true });
  const limit = pLimit(CONCURRENCY);
  try {
    return await Promise.all(pages.map(p => limit(() => checkOne(browser, p, loginPattern, opts))));
  } finally {
    await browser.close();
  }
}

async function checkOne(
  browser: Browser,
  target: PageTarget,
  loginPattern: string,
  opts: CheckOptions,
): Promise<PageCheckOutcome> {
  const ts = Date.now();
  // 로그인 필요 페이지면 저장된 세션 주입(없으면 비로그인 상태로 진입 → 보통 세션 만료로 잡힘).
  const useSession = target.login_required === 1 && hasStorageState();
  const context = await browser.newContext(useSession ? { storageState: STORAGE_STATE_PATH } : {});
  const page = await context.newPage();

  // 페이지를 방문하는 '그 김에' same-site API(xhr/fetch) 호출을 함께 수집한다.
  const apis: CapturedApi[] = [];
  let targetHost = '';
  try {
    targetHost = new URL(target.url).hostname;
  } catch {
    /* 잘못된 url 은 아래 goto 에서 잡힌다 */
  }
  // 같은 사이트 API(xhr/fetch) 오류 집계 — 페이지 HTML 은 200이어도 데이터 API 가 깨졌으면 페이지 장애로 본다.
  let apiServerErrors = 0; // 5xx 응답
  let apiFailedRequests = 0; // 응답 자체 없음(연결 실패/타임아웃)
  const apiFailSummary: string[] = []; // body 진단용 실패 API 요약(상한)

  // 요청 시작 시각을 기록해 응답 도착까지의 소요시간(ms)을 잰다.
  const reqStartAt = new WeakMap<Request, number>();
  page.on('request', req => {
    reqStartAt.set(req, Date.now());
  });
  page.on('response', res => {
    try {
      if (!targetHost) return; // host 파싱 실패 시 same-site 필터가 무력화되므로 아예 수집 안 함
      const req = res.request();
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return; // 정적자산 제외 — API 만
      const status = res.status();
      if (status >= 300 && status < 400) return; // 리다이렉트 중간 hop 제외 — 최종 응답만 집계
      const u = new URL(res.url());
      if (!isSameSite(u.hostname, targetHost)) return; // 같은 사이트(eTLD+1)만 — api.lezhin.com 등 서브도메인 포함
      const startedAt = reqStartAt.get(req);
      apis.push({
        method: req.method(),
        url: res.url(),
        path: u.pathname,
        status,
        durationMs: startedAt ? Date.now() - startedAt : null,
      });
      // 5xx = 데이터 API 서버 오류. 페이지 실패 승격 후보로 카운트.
      if (status >= 500) {
        apiServerErrors++;
        if (apiFailSummary.length < MAX_FAIL_LIST) {
          apiFailSummary.push(`${req.method()} ${u.pathname} → ${status}`);
        }
      }
    } catch {
      /* 개별 응답 파싱 실패는 무시 */
    }
  });
  // 응답 자체가 없는(연결 실패/타임아웃) 같은 사이트 xhr/fetch 도 집계. ERR_ABORTED(정상적 취소)는 제외.
  page.on('requestfailed', req => {
    try {
      if (!targetHost) return;
      const rt = req.resourceType();
      if (rt !== 'xhr' && rt !== 'fetch') return;
      const errText = req.failure()?.errorText ?? '';
      if (errText.includes('ERR_ABORTED')) return; // 네비게이션/중복요청 취소는 장애 아님
      const u = new URL(req.url());
      if (!isSameSite(u.hostname, targetHost)) return;
      apiFailedRequests++;
      if (apiFailSummary.length < MAX_FAIL_LIST) {
        apiFailSummary.push(`${req.method()} ${u.pathname} → 실패(${errText || '연결 실패'})`);
      }
    } catch {
      /* 무시 */
    }
  });

  const start = Date.now();
  let navMs = 0;
  let status = 0;
  let ok = false;
  let error: string | null = null;
  let sessionExpired = false;
  let body: string | null = null; // 실패 시 진단 스냅샷(응답 본문 또는 실패 API 요약)

  try {
    const res = await page.goto(target.url, {
      waitUntil: 'domcontentloaded',
      timeout: opts.navTimeoutMs,
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

    // 페이지 HTML 은 정상(2xx/3xx)이지만 같은 사이트 데이터 API 가 5xx/연결실패면 '데이터 로드 실패'로 강등.
    // 화면이 빈 백지인데 200이라 정상으로 보고되던 사각지대 해소(설정 fail_on_api_error 로 끌 수 있음).
    const apiFails = apiServerErrors + apiFailedRequests;
    if (ok && opts.failOnApiError && apiFails > 0) {
      ok = false;
      error = `같은 사이트 API ${apiFails}건 오류(5xx/연결 실패) — 페이지 HTML 은 ${status} 이나 데이터 로드 실패`;
    }

    // 실패 진단 스냅샷(정상/세션만료는 안 받음): API 실패면 그 목록, 아니면 응답 본문 앞부분.
    if (!ok && !sessionExpired) {
      if (apiFailSummary.length > 0) {
        body = `[같은 사이트 API 실패 ${apiFails}건]\n` + apiFailSummary.join('\n');
      } else if (res) {
        try {
          const t = await res.text();
          body = t.length > MAX_BODY ? t.slice(0, MAX_BODY) : t;
        } catch {
          /* 본문 못 읽음 — null 유지 */
        }
      }
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
      // 세션 만료(로그인 페이지로 튕김)는 장애가 아니고, 그 와중의 API 실패도 그 페이지의 것이 아니므로 0.
      apiFailCount: sessionExpired ? 0 : apiServerErrors + apiFailedRequests,
      body,
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
