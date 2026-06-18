import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type {
  PageTarget,
  CheckResult,
  SessionStatus,
  PageApiRow,
  ApiCallRow,
  ApiPageRow,
  ApiTestResult,
  HistoryPoint,
  SchedulerStatus,
  Settings,
  DailyStat,
  SlackSettings,
  SlackSettingsPatch,
  AlarmEvent,
} from '../shared/types';
import { api } from './api';

// 응답시간 색 판정 임계값 — 설정에서 온다(설정 로드 전엔 폴백값 사용).
interface Thresholds {
  warningMs: number; // 이 이상 🟡 주의
  criticalMs: number; // 이 이상 🔴 심각(느림)
}
const DEFAULT_THRESHOLDS: Thresholds = { warningMs: 1500, criticalMs: 3000 };

// 측정 주기 프리셋 — 모두 cron(*/N 또는 0 */N)으로 균등하게 표현되는 값만.
// (임의 분 입력을 막아 비약수 불균등(*/7)·60분↑ 근사 오차를 원천 차단)
const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1분' },
  { value: 2, label: '2분' },
  { value: 5, label: '5분' },
  { value: 10, label: '10분' },
  { value: 15, label: '15분' },
  { value: 30, label: '30분' },
  { value: 60, label: '1시간' },
  { value: 120, label: '2시간' },
  { value: 240, label: '4시간' },
  { value: 360, label: '6시간' },
  { value: 720, label: '12시간' },
  { value: 1440, label: '24시간' },
];

type View = 'byPage' | 'byApi';
type MainTab = 'view' | 'add' | 'log' | 'settings' | 'slack';

// ── 자동 갱신(이 브라우저 한정 UI 설정 — localStorage) ──
// 켜면 SSE 를 구독해, 서버가 점검을 끝낼 때마다 push 받아 화면을 갱신한다.
// 폴링 주기를 맞출 필요가 없다(결과가 생기는 시점에 서버가 알려줌).
type AutoRefresh = { enabled: boolean };
const AUTO_REFRESH_KEY = 'pm.autoRefresh';
function loadAutoRefresh(): AutoRefresh {
  try {
    const raw = localStorage.getItem(AUTO_REFRESH_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { enabled?: unknown };
      return { enabled: !!v.enabled };
    }
  } catch {
    /* 손상된 값은 무시하고 기본값 */
  }
  return { enabled: false };
}

type Notify = (msg: string, kind?: 'error' | 'ok') => void;

export function App() {
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'ok' } | null>(null);
  // 알림 toast — 에러(빨강)·성공(초록) 공용. 잠깐 보였다 5초 뒤 자동 사라짐(클릭해도 닫힘).
  // useCallback 으로 참조 고정 — 안 그러면 매 렌더 새 함수가 되어, onErr 를 deps 로 쓰는
  // 데이터 로딩 effect 들이 재실행되며 목록을 다시 불러와 펼침/상태가 리셋된다.
  const notify: Notify = useCallback((text, kind = 'error') => setToast({ text, kind }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const [tab, setTab] = useState<MainTab>('view');
  const [view, setView] = useState<View>('byPage');
  const [reloadKey, setReloadKey] = useState(0);
  const [autoRefresh, setAutoRefreshState] = useState<AutoRefresh>(loadAutoRefresh);
  const [refreshTick, setRefreshTick] = useState(0); // 자동 새로고침 폴링 신호(soft — 펼침/편집 보존)

  useEffect(() => {
    api.session().then(setSession).catch(e => notify(String(e)));
    api.scheduler().then(setSched).catch(() => {});
    api.getSettings().then(setSettings).catch(() => {});
  }, [reloadKey]);

  // 자동 갱신: 켜면 SSE 구독. 서버가 점검을 끝낼 때마다 push → refreshTick 증가.
  // (끊겨도 EventSource 가 자동 재연결하므로 onerror 별도 처리 불필요)
  useEffect(() => {
    if (!autoRefresh.enabled) return;
    const es = new EventSource('/api/events');
    es.onmessage = () => setRefreshTick(t => t + 1);
    return () => es.close();
  }, [autoRefresh.enabled]);

  // 갱신 신호마다 상단 배지(스케줄러 lastRun·세션)도 가볍게 갱신.
  useEffect(() => {
    if (refreshTick === 0) return;
    api.scheduler().then(setSched).catch(() => {});
    api.session().then(setSession).catch(() => {});
  }, [refreshTick]);

  function changeAutoRefresh(next: AutoRefresh) {
    setAutoRefreshState(next);
    try {
      localStorage.setItem(AUTO_REFRESH_KEY, JSON.stringify(next));
    } catch {
      /* 저장 실패해도 이번 세션 동안은 동작 */
    }
  }

  const thresholds: Thresholds = settings
    ? { warningMs: settings.warningMs, criticalMs: settings.criticalMs }
    : DEFAULT_THRESHOLDS;

  async function runCheck() {
    setRunning(true);
    setToast(null);
    try {
      await api.runCheck();
      setReloadKey(k => k + 1);
    } catch (e) {
      notify(String(e));
    } finally {
      setRunning(false);
    }
  }

  // 전체 데이터를 JSON 파일로 내려받기(export). 브라우저 Blob 다운로드.
  async function exportJson() {
    setExporting(true);
    setToast(null);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.download = `page-monitor-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="wrap">
      <header>
        <h1>Page Monitor</h1>
        <div className="actions">
          <SchedulerBadge sched={sched} />
          {autoRefresh.enabled && (
            <span
              className="badge auto-on"
              title="점검이 끝날 때마다 서버가 알려줘 화면이 자동 갱신됩니다 (페이지 리로드 없는 부분 갱신)"
            >
              ⟳ 실시간 갱신
            </span>
          )}
          <SessionBadge session={session} />
          <button onClick={exportJson} disabled={exporting} title="페이지·점검결과·API 매핑을 JSON 파일로 내려받기">
            {exporting ? '내보내는 중…' : 'JSON 내보내기'}
          </button>
          <button className="primary" onClick={runCheck} disabled={running}>
            {running ? '점검 중…' : '지금 전체 점검'}
          </button>
        </div>
      </header>

      {toast && (
        <div
          className={'toast ' + toast.kind}
          role="alert"
          onClick={() => setToast(null)}
          title="클릭하면 닫힙니다"
        >
          {toast.text}
        </div>
      )}

      <nav className="maintabs">
        <button className={tab === 'view' ? 'mtab on' : 'mtab'} onClick={() => setTab('view')}>
          페이지 현황
        </button>
        <button className={tab === 'add' ? 'mtab on' : 'mtab'} onClick={() => setTab('add')}>
          페이지 추가
        </button>
        <button className={tab === 'log' ? 'mtab on' : 'mtab'} onClick={() => setTab('log')}>
          페이지 로그
        </button>
        <button className={tab === 'settings' ? 'mtab on' : 'mtab'} onClick={() => setTab('settings')}>
          설정
        </button>
        <button className={tab === 'slack' ? 'mtab on' : 'mtab'} onClick={() => setTab('slack')}>
          슬랙 알람
        </button>
      </nav>

      {tab === 'view' && (
        <>
          <div className="viewtabs">
            <button className={view === 'byPage' ? 'tab on' : 'tab'} onClick={() => setView('byPage')}>
              페이지별 API 보기
            </button>
            <button className={view === 'byApi' ? 'tab on' : 'tab'} onClick={() => setView('byApi')}>
              API별 페이지 보기
            </button>
          </div>
          {view === 'byPage' ? (
            <PageView
              reloadKey={reloadKey}
              refreshTick={refreshTick}
              onErr={notify}
              onChanged={() => setReloadKey(k => k + 1)}
              thresholds={thresholds}
            />
          ) : (
            <ApiView reloadKey={reloadKey} onErr={notify} />
          )}
        </>
      )}

      {tab === 'add' && (
        <>
          <AddPageForm
            onAdded={() => {
              setReloadKey(k => k + 1);
              setTab('view'); // 단건 추가는 바로 조회로
            }}
          />
          <JsonImportForm onImported={() => setReloadKey(k => k + 1)} onErr={notify} />
        </>
      )}

      {tab === 'log' && <LogView reloadKey={reloadKey} onErr={notify} thresholds={thresholds} />}

      {tab === 'settings' && (
        <SettingsView
          autoRefresh={autoRefresh}
          onAutoRefreshChange={changeAutoRefresh}
          onSaved={() => setReloadKey(k => k + 1)}
          onErr={notify}
        />
      )}

      {tab === 'slack' && <SlackView onErr={notify} />}
    </div>
  );
}

// ── 페이지별 보기: 페이지 → 그 페이지가 호출한 API ──

function PageView({
  reloadKey,
  refreshTick,
  onErr,
  onChanged,
  thresholds,
}: {
  reloadKey: number;
  refreshTick: number;
  onErr: Notify;
  onChanged: () => void;
  thresholds: Thresholds;
}) {
  const [pages, setPages] = useState<PageTarget[]>([]);
  const [byPage, setByPage] = useState<Map<number, CheckResult>>(new Map());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [apiCache, setApiCache] = useState<Map<number, PageApiRow[]>>(new Map());
  const [historyCache, setHistoryCache] = useState<Map<number, HistoryPoint[]>>(new Map());
  const reloadKeyRef = useRef(reloadKey);
  const expandedRef = useRef(expandedId); // 자동 갱신 effect 에서 현재 펼친 페이지 참조용
  expandedRef.current = expandedId;

  useEffect(() => {
    reloadKeyRef.current = reloadKey;
    let cancelled = false;
    Promise.all([api.pages(), api.latest()])
      .then(([ps, latest]) => {
        if (cancelled) return;
        setPages(ps);
        setByPage(new Map(latest.map(r => [r.pageId, r])));
        setApiCache(new Map()); // 재점검으로 매핑이 갱신됐으니 펼침 캐시 무효화
        setHistoryCache(new Map()); // 추이도 갱신됐으니 무효화
        setExpandedId(null); // 펼침을 닫아 stale '불러오는 중…' 고착 방지(다시 클릭하면 fresh)
      })
      .catch(e => {
        if (!cancelled) onErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onErr]);

  // 자동 갱신(soft): 최신 결과 + (펼쳐져 있으면) 그 페이지의 추이 그래프를 다시 받아 갱신.
  // pages 목록·펼침 상태·편집 input·API 목록 캐시는 건드리지 않아 부분 렌더로 매끄럽게 바뀐다.
  useEffect(() => {
    if (refreshTick === 0) return; // 최초 마운트분은 위 effect 가 이미 처리
    let cancelled = false;
    const exp = expandedRef.current;
    const tasks: Promise<unknown>[] = [
      api.latest().then(latest => {
        if (!cancelled) setByPage(new Map(latest.map(r => [r.pageId, r])));
      }),
    ];
    if (exp !== null) {
      // 펼쳐 둔 페이지의 추이 라인차트도 최신 점까지 갱신.
      tasks.push(
        api.pageHistory(exp).then(h => {
          if (!cancelled) setHistoryCache(prev => new Map(prev).set(exp, h));
        }),
      );
    }
    Promise.all(tasks).catch(() => {
      /* 자동 갱신 실패는 조용히 무시(다음 주기에 재시도) */
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  async function toggle(pageId: number) {
    if (expandedId === pageId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(pageId);
    if (!apiCache.has(pageId)) {
      const at = reloadKeyRef.current;
      try {
        // 추이(history)와 호출 API 를 함께 불러온다.
        const [apis, history] = await Promise.all([
          api.pageApis(pageId),
          api.pageHistory(pageId),
        ]);
        if (reloadKeyRef.current !== at) return; // 그 사이 재점검됨 → stale 응답 폐기
        setApiCache(prev => new Map(prev).set(pageId, apis));
        setHistoryCache(prev => new Map(prev).set(pageId, history));
      } catch (e) {
        onErr(String(e));
      }
    }
  }

  async function remove(pageId: number, label: string) {
    if (!confirm(`'${label}' 페이지를 삭제할까요?\n점검 이력과 수집된 API 매핑도 함께 삭제됩니다.`)) return;
    try {
      await api.deletePage(pageId);
      onChanged(); // reloadKey 증가 → 목록·API뷰 재로드(고아 API 청소 반영)
    } catch (e) {
      onErr(String(e));
    }
  }

  async function savePage(
    pageId: number,
    patch: { label: string; group: string | null; loginRequired: boolean },
  ) {
    try {
      await api.updatePage(pageId, patch);
      onChanged(); // 목록·API뷰에 변경 반영
    } catch (e) {
      onErr(String(e));
    }
  }

  // 수동 API 추가/삭제 후 그 페이지 API 목록만 다시 불러와 캐시 갱신(펼침 유지).
  async function reloadApis(pageId: number) {
    try {
      const apis = await api.pageApis(pageId);
      setApiCache(prev => new Map(prev).set(pageId, apis));
    } catch (e) {
      onErr(String(e));
    }
  }

  return (
    <>
      <p className="hint">페이지 행을 클릭하면 그 페이지가 호출한 API 목록이 펼쳐집니다.</p>
      <table>
        <thead>
          <tr>
            <th className="status-col">상태</th>
            <th>페이지</th>
            <th>그룹</th>
            <th className="num">응답시간</th>
            <th className="num">HTTP</th>
            <th>비고</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pages.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                점검할 페이지가 없습니다. 위에서 추가하거나 data/pages.json을 채우세요.
              </td>
            </tr>
          ) : (
            pages.map(p => (
              <PageRow
                key={p.id}
                page={p}
                result={byPage.get(p.id)}
                expanded={expandedId === p.id}
                apis={apiCache.get(p.id)}
                history={historyCache.get(p.id)}
                thresholds={thresholds}
                onToggle={() => toggle(p.id)}
                onSave={patch => savePage(p.id, patch)}
                onDelete={() => remove(p.id, p.label)}
                onApiChanged={() => reloadApis(p.id)}
                onErr={onErr}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function PageRow({
  page,
  result,
  expanded,
  apis,
  history,
  thresholds,
  onToggle,
  onSave,
  onDelete,
  onApiChanged,
  onErr,
}: {
  page: PageTarget;
  result: CheckResult | undefined;
  expanded: boolean;
  apis: PageApiRow[] | undefined;
  history: HistoryPoint[] | undefined;
  thresholds: Thresholds;
  onToggle: () => void;
  onSave: (patch: { label: string; group: string | null; loginRequired: boolean }) => void;
  onDelete: () => void;
  onApiChanged: () => void;
  onErr: Notify;
}) {
  const slow = result?.ok && result.durationMs >= thresholds.warningMs;
  const [editing, setEditing] = useState(false);
  const [dLabel, setDLabel] = useState(page.label);
  const [dGroup, setDGroup] = useState(page.group ?? '');
  const [dLogin, setDLogin] = useState(page.login_required === 1);

  function startEdit() {
    setDLabel(page.label);
    setDGroup(page.group ?? '');
    setDLogin(page.login_required === 1);
    setEditing(true);
  }
  function saveEdit() {
    const label = dLabel.trim();
    setEditing(false);
    if (!label) return; // 빈 이름이면 저장 취소(이름은 필수)
    onSave({ label, group: dGroup.trim() || null, loginRequired: dLogin });
  }
  function cancelEdit() {
    setEditing(false);
  }
  // 편집 input 공통 키 처리 (Enter 저장 / Esc 취소)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') saveEdit();
    else if (e.key === 'Escape') cancelEdit();
  };
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <>
      <tr className="page-row" onClick={editing ? undefined : onToggle}>
        <td className="status-cell">{statusIcon(result, thresholds)}</td>
        <td>
          <div className="label">
            {editing ? (
              <input
                className="rename-input"
                value={dLabel}
                autoFocus
                placeholder="이름"
                onClick={stop}
                onChange={e => setDLabel(e.target.value)}
                onKeyDown={onKey}
              />
            ) : (
              <>
                <span className="caret">{expanded ? '▼' : '▶'}</span> {page.label}
              </>
            )}
          </div>
          <UrlLink className="url" url={page.url} />
        </td>
        <td>
          {editing ? (
            <input
              className="rename-input grp"
              value={dGroup}
              placeholder="그룹"
              onClick={stop}
              onChange={e => setDGroup(e.target.value)}
              onKeyDown={onKey}
            />
          ) : (
            (page.group ?? '—')
          )}
        </td>
        <td className="num" style={{ color: slow ? '#fbbf24' : undefined }}>
          {result ? `${result.durationMs} ms` : '—'}
        </td>
        <td className="num">{result && result.status > 0 ? result.status : '—'}</td>
        <td className="note">
          {editing ? (
            <label className="chk" onClick={stop}>
              <input
                type="checkbox"
                checked={dLogin}
                onChange={e => setDLogin(e.target.checked)}
              />
              로그인 필요
            </label>
          ) : (
            (result?.error ?? (result ? '정상' : '미점검'))
          )}
        </td>
        <td className="num row-actions">
          {editing ? (
            <>
              <button className="iconbtn" title="저장" onClick={e => { stop(e); saveEdit(); }}>
                ✓
              </button>
              <button className="iconbtn" title="취소" onClick={e => { stop(e); cancelEdit(); }}>
                ✕
              </button>
            </>
          ) : (
            <>
              <button
                className="iconbtn"
                title="수정 (이름·그룹·로그인필요)"
                onClick={e => {
                  stop(e); // 행 클릭(펼침)과 분리
                  startEdit();
                }}
              >
                ✏️
              </button>
              <button
                className="del"
                title="이 페이지 삭제"
                onClick={e => {
                  stop(e); // 행 클릭(펼침)과 분리
                  onDelete();
                }}
              >
                🗑
              </button>
            </>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="api-row">
          <td colSpan={7}>
            <HistorySparkline points={history} thresholds={thresholds} />
            <ApiList
              apis={apis}
              pageId={page.id}
              pageUrl={page.url}
              onChanged={onApiChanged}
              onErr={onErr}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// 점검 1건의 상태 → 색 class + 한글 라벨 (점·모달 공용).
function statusInfo(p: HistoryPoint, t: Thresholds): { cls: string; label: string } {
  if (p.sessionExpired) return { cls: 'exp', label: '세션 만료 (재로그인 필요 · 장애 아님)' };
  if (!p.ok) return { cls: 'fail', label: '실패 (응답 자체 실패)' };
  if (p.durationMs >= t.criticalMs) return { cls: 'crit', label: '심각 (느리지만 응답 옴)' };
  if (p.durationMs >= t.warningMs) return { cls: 'slow', label: '주의 (느림)' };
  return { cls: 'ok', label: '정상' };
}

// 점검 1건의 상태 → 색 class (점·막대 공용).
function pointClass(p: HistoryPoint, t: Thresholds): string {
  return statusInfo(p, t).cls;
}

// 최근 점검 추이 — 응답시간 라인차트 + 임계값 기준선(점선) + hover 툴팁. 라이브러리 없이 SVG.
function HistorySparkline({
  points,
  thresholds,
}: {
  points: HistoryPoint[] | undefined;
  thresholds: Thresholds;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (points === undefined) return <div className="api-loading">추이 불러오는 중…</div>;
  if (points.length === 0) return null; // 이력이 없으면 영역 자체를 비움

  const W = 640;
  const H = 120;
  const padL = 48;
  const padR = 12;
  const padT = 12;
  const padB = 20;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  // Y 상한: 응답시간 최대와 심각 임계값 중 큰 값 + 여백(임계값 선이 항상 보이게).
  const peak = Math.max(...points.map(p => p.durationMs), thresholds.criticalMs, 1);
  const yMax = Math.max(100, Math.ceil((peak * 1.1) / 100) * 100);
  const n = points.length;
  const xOf = (i: number) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yOf = (ms: number) => padT + ih - (Math.min(ms, yMax) / yMax) * ih;
  const linePath = points
    .map((p, i) => `${i ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.durationMs).toFixed(1)}`)
    .join(' ');
  const first = new Date(points[0].ts).toLocaleString('ko-KR');
  const last = new Date(points[n - 1].ts).toLocaleString('ko-KR');
  const hp = hover != null ? points[hover] : null;

  return (
    <div className="trend">
      <div className="trend-head">
        최근 점검 추이 · {n}회
        {hp && (
          <span className="trend-tip">
            {new Date(hp.ts).toLocaleString('ko-KR')} · <b>{hp.durationMs}ms</b> · HTTP{' '}
            {hp.status || '—'}
            {hp.sessionExpired ? ' · 세션만료' : !hp.ok ? ' · 실패' : ''}
          </span>
        )}
      </div>
      <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)}>
        {/* 바닥선 + Y 라벨(0/최대) */}
        <line className="ax-line" x1={padL} x2={W - padR} y1={yOf(0)} y2={yOf(0)} />
        <text className="ax-label" x={padL - 6} y={yOf(0)} textAnchor="end">
          0
        </text>
        <text className="ax-label" x={padL - 6} y={yOf(yMax) + 9} textAnchor="end">
          {yMax}
        </text>
        {/* 임계값 기준선(점선) — 원본 맥북앱처럼 주의/심각 라인 */}
        {thresholds.warningMs <= yMax && (
          <>
            <line className="th-warn" x1={padL} x2={W - padR} y1={yOf(thresholds.warningMs)} y2={yOf(thresholds.warningMs)} />
            <text className="th-label warn" x={W - padR} y={yOf(thresholds.warningMs) - 3} textAnchor="end">
              주의 {thresholds.warningMs}
            </text>
          </>
        )}
        {thresholds.criticalMs <= yMax && (
          <>
            <line className="th-crit" x1={padL} x2={W - padR} y1={yOf(thresholds.criticalMs)} y2={yOf(thresholds.criticalMs)} />
            <text className="th-label crit" x={W - padR} y={yOf(thresholds.criticalMs) - 3} textAnchor="end">
              심각 {thresholds.criticalMs}
            </text>
          </>
        )}
        {/* 응답시간 선 */}
        <path className="trend-line" d={linePath} />
        {/* hover 수직선 */}
        {hover != null && (
          <line className="hover-v" x1={xOf(hover)} x2={xOf(hover)} y1={padT} y2={padT + ih} />
        )}
        {/* 점(상태색) */}
        {points.map((p, i) => (
          <circle
            key={`${p.ts}-${i}`}
            className={'pt ' + pointClass(p, thresholds)}
            cx={xOf(i)}
            cy={yOf(p.durationMs)}
            r={hover === i ? 4 : 2.4}
          />
        ))}
        {/* 마우스 캡처용 투명 세로 띠 */}
        {points.map((p, i) => (
          <rect
            key={`hit-${p.ts}-${i}`}
            x={xOf(i) - iw / n / 2}
            y={padT}
            width={iw / n}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <div className="trend-axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

// API URL 이 페이지와 다른 사이트(origin)인지 — 상대경로(/api/..)는 same-site 로 본다.
// JSON 파싱(관대) — page-apis.json 처럼 배열을 쉼표째 복사해도 먹히게 끝/내부 trailing comma 를 정리한 뒤 파싱.
function parseLooseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/,(\s*[\]}])/g, '$1').replace(/,\s*$/, ''));
}

function isCrossOrigin(apiUrl: string, pageUrl: string): boolean {
  if (!/^https?:\/\//i.test(apiUrl)) return false;
  try {
    return new URL(apiUrl).origin !== new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

// 테스트(GET 호출) 가부 자동 판정 — 클라/서버(routes.ts test 게이트)가 공유한다.
//   비GET → 불가(부작용) / 교차 사이트 → 불가(SSRF) / 동적<id> → 불가(placeholder 호출은 무의미) / 그 외 정적 GET same-site → 가능
function apiCallable(a: PageApiRow, pageUrl: string): { ok: boolean; reason: string } {
  if (a.method.toUpperCase() !== 'GET')
    return { ok: false, reason: a.method.toUpperCase() + ' · 부작용 방지로 테스트 불가' };
  if (isCrossOrigin(a.url, pageUrl)) return { ok: false, reason: '교차 사이트 · 테스트 불가' };
  if (/[<>]/.test(a.url)) return { ok: false, reason: '동적 파라미터(<id> 등) · 테스트 불가' };
  return { ok: true, reason: '' };
}

// API 단건 GET 테스트 버튼 — 호출 가부(disabled)는 호출측(ApiItem)이 판정해 내려준다.
// 클릭하면 그 API 를 저장된 로그인 세션(storageState)으로 1회 GET → 결과를 곧바로 모달로 띄운다.
// (인라인 결과/응답보기 버튼을 행에 늘어놓으면 난잡해져, 상태·응답시간·본문을 모달 한 곳에 모은다.)
function ApiTestButton({
  pageId,
  method,
  url,
  disabled,
  reason,
  onErr,
}: {
  pageId: number;
  method: string;
  url: string;
  disabled?: boolean;
  reason?: string;
  onErr: Notify;
}) {
  const [state, setState] = useState<ApiTestResult | 'loading' | null>(null);
  const [open, setOpen] = useState(false);

  async function run() {
    setState('loading');
    setOpen(true); // 클릭 즉시 모달 — 오래 걸려도 진행 상황(스피너)을 모달 안에서 보여준다
    try {
      setState(await api.testApi(pageId, method, url));
    } catch (e) {
      setOpen(false);
      setState(null);
      onErr(String(e));
    }
  }

  return (
    <span className="api-test-wrap">
      <button
        className="api-test"
        title={
          disabled
            ? reason || '테스트 불가'
            : '이 API를 GET으로 한 번 호출해 응답을 모달로 확인합니다(로그인 세션 포함)'
        }
        onClick={e => {
          e.stopPropagation();
          run();
        }}
        disabled={disabled || state === 'loading'}
      >
        테스트
      </button>
      {open && state && (
        <ApiBodyModal result={state} method={method} url={url} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

// API 테스트 결과 모달 — '테스트' 누르면 이 모달이 떠서 상태/응답시간 + 응답 본문(앞 4KB)을 한곳에 보여준다.
// 본문은 JSON 이고 안 잘렸으면 보기 좋게 들여쓰기. 본문이 없으면 안내만.
function ApiBodyModal({
  result,
  method,
  url,
  onClose,
}: {
  result: ApiTestResult | 'loading';
  method: string;
  url: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 호출 진행 중 — 스피너만(결과가 오면 아래 본문 렌더로 교체된다).
  if (result === 'loading') {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card api-body-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <span className={'api-method ' + method.toLowerCase()}>{method}</span>
            <strong>호출 중…</strong>
            <button className="modal-x" onClick={onClose} title="닫기">
              ✕
            </button>
          </div>
          <div className="api-body-url" title={url}>
            {url}
          </div>
          <div className="api-body-loading">
            <span className="api-body-spin" />
            응답을 기다리는 중 (최대 30초)
          </div>
        </div>
      </div>
    );
  }

  const statusLabel = result.sessionExpired ? '인증필요' : result.ok ? 'OK' : '실패';
  const statusCls = result.ok ? 'ok' : result.sessionExpired ? 'exp' : 'bad';
  const hasBody = result.body != null && result.body !== '';

  let pretty = result.body ?? '';
  if (!result.bodyTruncated && result.contentType.includes('json')) {
    try {
      pretty = JSON.stringify(JSON.parse(result.body ?? ''), null, 2);
    } catch {
      /* 파싱 실패 시 raw 표시 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card api-body-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className={'api-method ' + method.toLowerCase()}>{method}</span>
          <span className={'api-test-result ' + statusCls}>{statusLabel}</span>
          <strong>
            {result.status || '—'} · {result.durationMs}ms
            {result.contentType ? ' · ' + result.contentType : ''}
          </strong>
          <button className="modal-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>
        <div className="api-body-url" title={url}>
          {url}
        </div>
        {result.error && <div className="api-body-error">{result.error}</div>}
        {hasBody ? (
          <>
            <pre className="api-body-pre">{pretty}</pre>
            <div className="api-body-foot">
              {result.bodyTruncated
                ? '응답이 길어 앞 4KB만 표시했습니다 (이후 생략).'
                : `본문 ${(result.body ?? '').length.toLocaleString()}자`}
            </div>
          </>
        ) : (
          <div className="api-body-foot">응답 본문이 없습니다.</div>
        )}
      </div>
    </div>
  );
}

// API 한 줄 — 자동/수동 공통. method/path + (자동이면 실측 meta) + 테스트 버튼(정적 GET same-site 만 활성,
// 비GET·동적<id>·교차사이트는 disabled) + (수동이면 삭제). 가부는 apiCallable 이 자동 판정.
function ApiItem({
  a,
  pageId,
  pageUrl,
  onChanged,
  onErr,
}: {
  a: PageApiRow;
  pageId: number;
  pageUrl: string;
  onChanged: () => void;
  onErr: Notify;
}) {
  const isManual = a.source === 'manual';
  const c = apiCallable(a, pageUrl);

  async function remove() {
    try {
      await api.deleteManualApi(pageId, a.method, a.url);
      onChanged();
    } catch (e) {
      onErr(String(e));
    }
  }

  return (
    <div className={'api-item' + (isManual ? ' manual' : '')}>
      <span className={'api-method ' + a.method.toLowerCase()}>{a.method}</span>
      <span className="api-path" title={a.url}>
        {a.path}
      </span>
      {!isManual && (
        <span className="api-meta">
          <span className={'api-status ' + (a.status >= 400 || a.status === 0 ? 'bad' : 'ok')}>
            {a.status || '—'}
          </span>
          {a.durationMs != null && <span className="api-ms">{a.durationMs}ms</span>}
          <span className="api-hits">×{a.hitCount}</span>
        </span>
      )}
      {/* 테스트 버튼 — 정적 GET same-site 만 활성. 비GET·동적<id>·교차사이트는 disabled(hover 에 사유). */}
      <ApiTestButton
        pageId={pageId}
        method={a.method}
        url={a.url}
        disabled={!c.ok}
        reason={c.reason}
        onErr={onErr}
      />
      {isManual && (
        <button className="api-del" title="이 수동 API 삭제" onClick={remove}>
          🗑
        </button>
      )}
    </div>
  );
}

function ApiList({
  apis,
  pageId,
  pageUrl,
  onChanged,
  onErr,
}: {
  apis: PageApiRow[] | undefined;
  pageId: number;
  pageUrl: string;
  onChanged: () => void;
  onErr: Notify;
}) {
  if (apis === undefined) return <div className="api-loading">API 불러오는 중…</div>;
  const auto = apis.filter(a => a.source !== 'manual');
  const manual = apis.filter(a => a.source === 'manual');

  return (
    <div className="api-list">
      {/* 자동 감지 — 점검 중 page.on('response') 로 잡힌 same-site xhr/fetch */}
      <div className="api-head">
        이 페이지에서 자동 감지된 API · {auto.length}개
        {auto.length > 0 && <span className="api-test-hint"> · GET만 테스트 가능(부작용 방지)</span>}
      </div>
      {auto.length === 0 ? (
        <div className="api-empty">
          자동 감지된 API가 없습니다. ‘지금 전체 점검’ 시 이 페이지가 브라우저에서 호출한 API가 모입니다.
        </div>
      ) : (
        auto.map(a => (
          <ApiItem
            key={`a ${a.method} ${a.url}`}
            a={a}
            pageId={pageId}
            pageUrl={pageUrl}
            onChanged={onChanged}
            onErr={onErr}
          />
        ))
      )}

      {/* 수동 등록 — Next.js SSR 등 브라우저에 안 잡히는 API 를 사람이 기록 */}
      <div className="api-head manual">수동으로 추가한 API · {manual.length}개</div>
      {manual.map(a => (
        <ApiItem
          key={`m ${a.method} ${a.url}`}
          a={a}
          pageId={pageId}
          pageUrl={pageUrl}
          onChanged={onChanged}
          onErr={onErr}
        />
      ))}
      <ManualApiForm pageId={pageId} onAdded={onChanged} onErr={onErr} />
      <ManualApiJsonForm pageId={pageId} onAdded={onChanged} onErr={onErr} />
    </div>
  );
}

// 수동 API 등록 폼 — method + 경로. 점검에 안 잡히는 SSR API 등을 손으로 기록.
function ManualApiForm({
  pageId,
  onAdded,
  onErr,
}: {
  pageId: number;
  onAdded: () => void;
  onErr: Notify;
}) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    try {
      const r = await api.addManualApi(pageId, method, p);
      if (!r.added) {
        onErr('이미 등록된 API입니다 (자동 감지됐거나 이미 수동 등록됨).');
      }
      setPath('');
      onAdded();
    } catch (e) {
      onErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-api-form">
      <select value={method} onChange={e => setMethod(e.target.value)}>
        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input
        placeholder="/api/path — SSR 등 자동 감지 안 되는 API 직접 입력"
        value={path}
        onChange={e => setPath(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
        }}
      />
      <button onClick={submit} disabled={busy || !path.trim()}>
        수동 추가
      </button>
    </div>
  );
}

// 수동 API 배열 일괄 등록 — 펼침 토글 + textarea. API 문자열들을 배열로 한방에 넣는 흐름.
function ManualApiJsonForm({
  pageId,
  onAdded,
  onErr,
}: {
  pageId: number;
  onAdded: () => void;
  onErr: Notify;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    let parsed: unknown;
    try {
      parsed = parseLooseJson(text);
    } catch {
      onErr('배열 형식이 올바르지 않습니다.');
      return;
    }
    // 123, "abc", true 같은 것도 유효한 JSON 이라 파싱은 통과한다 → 배열/{apis} 인지 여기서 막아 서버로 안 쏜다.
    const ok =
      Array.isArray(parsed) ||
      (!!parsed && typeof parsed === 'object' && Array.isArray((parsed as { apis?: unknown }).apis));
    if (!ok) {
      onErr('배열을 넣어주세요. 예: ["GET /경로"]');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const r = await api.importManualApis(pageId, parsed);
      const summary = `추가 ${r.added}개 · 건너뜀 ${r.skipped}개 · 총 ${r.total}개`;
      setResult(summary);
      onErr(summary, 'ok');
      if (r.added > 0) setText('');
      onAdded();
    } catch (e) {
      onErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual-json">
      <button className="manual-json-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} 배열로 여러 개 추가
      </button>
      {open && (
        <div className="manual-json-body">
          <p className="hint">
            API를 <strong>배열</strong>로 넣으세요. 한 줄에 하나씩 <code>"GET /경로"</code> (메서드 생략 시 GET)
          </p>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={'[\n  "GET /api/time",\n  "POST /api/x-api",\n  { "method": "GET", "path": "/ssr/data" }\n]'}
          />
          <div className="manual-json-actions">
            <button onClick={submit} disabled={busy || !text.trim()}>
              일괄 추가
            </button>
            {result && <span className="hint">{result}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── API별 보기: API → 그 API를 호출하는 페이지 (역매핑) ──

function ApiView({ reloadKey, onErr }: { reloadKey: number; onErr: Notify }) {
  const [apis, setApis] = useState<ApiCallRow[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pageCache, setPageCache] = useState<Map<number, ApiPageRow[]>>(new Map());
  const reloadKeyRef = useRef(reloadKey);

  useEffect(() => {
    reloadKeyRef.current = reloadKey;
    let cancelled = false;
    api
      .apis()
      .then(a => {
        if (cancelled) return;
        setApis(a);
        setPageCache(new Map());
        setExpandedId(null);
      })
      .catch(e => {
        if (!cancelled) onErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onErr]);

  async function toggle(apiId: number) {
    if (expandedId === apiId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(apiId);
    if (!pageCache.has(apiId)) {
      const at = reloadKeyRef.current;
      try {
        const ps = await api.apiPages(apiId);
        if (reloadKeyRef.current !== at) return; // 그 사이 재점검됨 → stale 응답 폐기
        setPageCache(prev => new Map(prev).set(apiId, ps));
      } catch (e) {
        onErr(String(e));
      }
    }
  }

  return (
    <>
      <p className="hint">API 행을 클릭하면 그 API를 호출하는 페이지 목록이 펼쳐집니다.</p>
      <table>
        <thead>
          <tr>
            <th>메서드</th>
            <th>API 경로</th>
            <th className="num">HTTP</th>
            <th className="num">응답시간</th>
            <th className="num">호출수</th>
            <th className="num">쓰는 페이지</th>
          </tr>
        </thead>
        <tbody>
          {apis.length === 0 ? (
            <tr>
              <td colSpan={6} className="empty">
                수집된 API가 없습니다. ‘지금 전체 점검’을 실행하세요.
              </td>
            </tr>
          ) : (
            apis.map(a => (
              <ApiRow
                key={a.id}
                api={a}
                expanded={expandedId === a.id}
                pages={pageCache.get(a.id)}
                onToggle={() => toggle(a.id)}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function ApiRow({
  api: a,
  expanded,
  pages,
  onToggle,
}: {
  api: ApiCallRow;
  expanded: boolean;
  pages: ApiPageRow[] | undefined;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="page-row" onClick={onToggle}>
        <td>
          <span className={'api-method ' + a.method.toLowerCase()}>{a.method}</span>
        </td>
        <td>
          <div className="label">
            <span className="caret">{expanded ? '▼' : '▶'}</span> <span className="mono">{a.path}</span>
          </div>
          <div className="url">{a.url}</div>
        </td>
        <td className="num">
          <span className={'api-status ' + (a.status >= 400 || a.status === 0 ? 'bad' : 'ok')}>
            {a.status || '—'}
          </span>
        </td>
        <td className="num">{a.durationMs != null ? `${a.durationMs} ms` : '—'}</td>
        <td className="num">×{a.hitCount}</td>
        <td className="num">{a.pageCount}곳</td>
      </tr>
      {expanded && (
        <tr className="api-row">
          <td colSpan={6}>
            <PageList pages={pages} />
          </td>
        </tr>
      )}
    </>
  );
}

function PageList({ pages }: { pages: ApiPageRow[] | undefined }) {
  if (pages === undefined) return <div className="api-loading">페이지 불러오는 중…</div>;
  if (pages.length === 0) {
    return <div className="api-empty">이 API를 호출하는 페이지가 없습니다.</div>;
  }
  return (
    <div className="api-list">
      <div className="api-head">이 API를 호출하는 페이지 · {pages.length}곳</div>
      {pages.map(p => (
        <div className="api-item" key={p.pageId}>
          <span className="api-pagelabel">{p.label}</span>
          <UrlLink className="api-pageurl" url={p.url} />
          <span className="api-meta">
            {p.durationMs != null && <span className="api-ms">{p.durationMs}ms</span>}
            <span className="api-hits">×{p.hitCount}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── 로그 탭: 일별 막대(Claude Status 풍) + 클릭 시 그날 개별 점검 동그라미(맥북앱 풍) ──

function LogView({
  reloadKey,
  onErr,
  thresholds,
}: {
  reloadKey: number;
  onErr: Notify;
  thresholds: Thresholds;
}) {
  const [pages, setPages] = useState<PageTarget[]>([]);
  const [daily, setDaily] = useState<Map<number, DailyStat[]>>(new Map());
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .pages()
      .then(async ps => {
        const entries = await Promise.all(
          ps.map(async p => [p.id, await api.pageDaily(p.id)] as const),
        );
        if (cancelled) return;
        setPages(ps);
        setDaily(new Map(entries));
      })
      .catch(e => {
        if (!cancelled) onErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, onErr]);

  if (loading) return <p className="hint">로그 불러오는 중…</p>;

  return (
    <>
      <div className="log-toolbar">
        <p className="hint" style={{ margin: 0 }}>
          일별 막대를 클릭하면 그날 개별 점검이 펼쳐집니다.
          {issuesOnly && ' · 이슈만 보기: 정상(초록)은 숨김'}
        </p>
        <label className="chk">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={e => setIssuesOnly(e.target.checked)}
          />
          이슈만 보기
        </label>
      </div>
      {pages.length === 0 ? (
        <p className="empty">점검 이력이 없습니다. "지금 전체 점검"을 실행하세요.</p>
      ) : (
        pages.map(p => (
          <LogPageCard
            key={p.id}
            page={p}
            days={daily.get(p.id) ?? []}
            thresholds={thresholds}
            issuesOnly={issuesOnly}
            onErr={onErr}
          />
        ))
      )}
    </>
  );
}

function LogPageCard({
  page,
  days,
  thresholds,
  issuesOnly,
  onErr,
}: {
  page: PageTarget;
  days: DailyStat[];
  thresholds: Thresholds;
  issuesOnly: boolean;
  onErr: Notify;
}) {
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [checks, setChecks] = useState<HistoryPoint[] | null>(null);
  // 모달엔 클릭한 점검(point)과 직전 점검(prev)을 함께 — 간격/추세("직전엔 정상") 표시용.
  const [selected, setSelected] = useState<{ point: HistoryPoint; prev: HistoryPoint | null } | null>(
    null,
  );
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // hover 커스텀 툴팁용

  const total = days.reduce((a, d) => a + d.total, 0);
  const expiredTotal = days.reduce((a, d) => a + d.expired, 0);
  const up = days.reduce((a, d) => a + d.ok + d.warn + d.crit, 0); // 응답 성공(정상+주의+심각)
  const denom = total - expiredTotal; // 세션 만료는 '장애 아님'이라 정상률 분모에서 제외
  const uptimePct = denom ? Math.round((up / denom) * 1000) / 10 : 0;

  async function toggleDate(date: string) {
    if (openDate === date) {
      setOpenDate(null);
      return;
    }
    setOpenDate(date);
    setChecks(null);
    try {
      setChecks(await api.pageChecks(page.id, date));
    } catch (e) {
      onErr(String(e));
    }
  }

  return (
    <div className="log-card">
      <div className="log-card-head">
        <div className="log-id">
          <span className="log-label">{page.label}</span>
          <UrlLink className="log-url" url={page.url} />
        </div>
        <span className="log-uptime">
          정상률 {uptimePct}% · {total}회{expiredTotal ? ` · 만료 ${expiredTotal} 제외` : ''}
        </span>
      </div>
      {days.length === 0 ? (
        <p className="hint">이력 없음</p>
      ) : (
        <>
          <div className="daily-bars">
            {days.map(d => {
              // 비율 스택 — 그날 점검들을 정상/지연/오류/만료 비율로 세로 분할(색이 비율대로 쌓임).
              const segs = [
                { cls: 'ok', n: d.ok },
                { cls: 'slow', n: d.warn + d.crit }, // 지연(주의+심각 — 느리지만 응답 옴)
                { cls: 'fail', n: d.fail }, // 오류(응답 자체 실패)
                { cls: 'exp', n: d.expired }, // 만료(장애 아님 — 회색)
              ];
              const parts = [`정상 ${d.ok}`, `주의 ${d.warn}`, `심각 ${d.crit}`, `실패 ${d.fail}`];
              if (d.expired) parts.push(`만료 ${d.expired}`);
              return (
                <button
                  key={d.date}
                  className={'dbar' + (openDate === d.date ? ' on' : '')}
                  title={`${d.date} · 총 ${d.total}회\n${parts.join(' · ')}\n평균 ${d.avgMs}ms · 최대 ${d.maxMs}ms`}
                  onClick={() => toggleDate(d.date)}
                >
                  {segs.map(s =>
                    s.n > 0 ? (
                      <span
                        key={s.cls}
                        className={'seg ' + s.cls}
                        style={{ height: `${(s.n / d.total) * 100}%` }}
                      />
                    ) : null,
                  )}
                </button>
              );
            })}
          </div>
          <div className="daily-axis">
            <span>{days[0]?.date ?? ''}</span>
            <span>{days[days.length - 1]?.date ?? ''}</span>
          </div>
        </>
      )}
      {openDate && (
        <div className="day-detail">
          <div className="day-detail-head">{openDate} · 그날 개별 점검 (클릭하면 상세)</div>
          {checks === null ? (
            <span className="hint">불러오는 중…</span>
          ) : checks.length === 0 ? (
            <span className="hint">점검 없음</span>
          ) : issuesOnly && checks.every(c => statusInfo(c, thresholds).cls === 'ok') ? (
            <span className="hint">이슈 없음 — 이 날은 모두 정상</span>
          ) : (
            <div className="dots">
              {checks.map((c, i) => {
                const info = statusInfo(c, thresholds);
                // 이슈만 보기: 정상(초록)은 숨김. prev 는 전체 기준이라 간격 계산은 그대로 정확.
                if (issuesOnly && info.cls === 'ok') return null;
                const prev = i > 0 ? checks[i - 1] : null; // checksByDate 는 시간순 → 바로 앞이 직전 점검
                return (
                  <button
                    key={`${c.ts}-${i}`}
                    className={'dot ' + info.cls}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(h => (h === i ? null : h))}
                    onClick={() => setSelected({ point: c, prev })}
                  >
                    {hoverIdx === i && (
                      <span className="dot-tip">
                        <b>{new Date(c.ts).toLocaleTimeString('ko-KR')}</b> · {info.label}
                        <br />
                        {c.durationMs}ms · HTTP {c.status || '—'}
                        <br />
                        {prev ? (
                          <span className="dot-tip-gap">
                            직전({new Date(prev.ts).toLocaleTimeString('ko-KR')}·
                            {statusInfo(prev, thresholds).label}) {fmtGap(c.ts - prev.ts)}
                          </span>
                        ) : (
                          <span className="dot-tip-gap">이 날 첫 점검</span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {selected && (
        <CheckDetailModal
          point={selected.point}
          prev={selected.prev}
          thresholds={thresholds}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

// 점검 1건 상세 모달 — 동그라미 클릭 시 시각·응답시간·HTTP·상태·오류 메시지 + 직전 점검과의 간격.
function CheckDetailModal({
  point,
  prev,
  thresholds,
  onClose,
}: {
  point: HistoryPoint;
  prev: HistoryPoint | null;
  thresholds: Thresholds;
  onClose: () => void;
}) {
  const info = statusInfo(point, thresholds);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className={'dot ' + info.cls} />
          <strong>{info.label}</strong>
          <button className="modal-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>
        <dl className="modal-body">
          <dt>시각</dt>
          <dd>{new Date(point.ts).toLocaleString('ko-KR')}</dd>
          <dt>응답시간</dt>
          <dd>{point.durationMs} ms</dd>
          <dt>HTTP</dt>
          <dd>{point.status > 0 ? point.status : '— (응답 없음)'}</dd>
          {prev ? (
            <>
              <dt>직전 점검</dt>
              <dd>
                {new Date(prev.ts).toLocaleString('ko-KR')} · {statusInfo(prev, thresholds).label} ·{' '}
                {fmtGap(point.ts - prev.ts)}
              </dd>
            </>
          ) : null}
          {point.error ? (
            <>
              <dt>오류</dt>
              <dd className="modal-err">{point.error}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}

// ── 공통 ──

// 페이지 URL — 클릭하면 실제 사이트가 새 탭으로 열린다(행 클릭=펼침과는 분리).
function UrlLink({ url, className }: { url: string; className?: string }) {
  return (
    <a
      className={className ? `urllink ${className}` : 'urllink'}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      onClick={e => e.stopPropagation()}
    >
      {url}
    </a>
  );
}

function statusIcon(r: CheckResult | undefined, t: Thresholds): string {
  if (!r) return '⚪';
  if (r.sessionExpired) return '🔁'; // 세션 만료 — 재로그인 필요(장애 아님)
  if (r.ok) {
    if (r.durationMs >= t.criticalMs) return '🔴'; // 심각하게 느림(응답은 옴) — 빨강 동그라미
    if (r.durationMs >= t.warningMs) return '🟡'; // 주의
    return '🟢';
  }
  return '❌'; // 실패(응답 자체 실패) — 빨간 X
}

// cron 식을 사람이 읽을 말로. minutesToCron 이 내는 분/시간 패턴을 모두 커버.
function cronToKo(expr: string): string {
  const min = expr.match(/^\*\/(\d+) \* \* \* \*$/);
  if (min) return `${min[1]}분마다`;
  if (expr === '* * * * *') return '매분';
  if (expr === '0 * * * *') return '1시간마다';
  const hr = expr.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hr) return `${hr[1]}시간마다`;
  if (expr === '0 0 * * *') return '매일';
  return expr;
}

function SchedulerBadge({ sched }: { sched: SchedulerStatus | null }) {
  if (!sched) return null;
  if (!sched.enabled) {
    return <span className="badge gray" title="자동 점검 꺼짐 (SCHEDULER=off 또는 config)">⏸ 자동 점검 꺼짐</span>;
  }
  const last = sched.lastRun ? new Date(sched.lastRun).toLocaleTimeString('ko-KR') : '아직';
  return (
    <span
      className="badge green"
      title={`cron: ${sched.cron}\n마지막 자동 점검: ${last}${sched.running ? '\n(지금 점검 중)' : ''}`}
    >
      {sched.running ? '🔄' : '⏱'} 자동 점검 {cronToKo(sched.cron)}
    </span>
  );
}

function SessionBadge({ session }: { session: SessionStatus | null }) {
  if (!session) return null;
  if (!session.exists) {
    return <span className="badge gray">세션 없음 · npm run login</span>;
  }
  const when = session.savedAt ? new Date(session.savedAt).toLocaleString('ko-KR') : '';
  return <span className="badge green">세션 저장됨 · {when}</span>;
}

function AddPageForm({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [loginRequired, setLoginRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.addPage({
        url: url.trim(),
        label: label.trim() || undefined,
        group: group.trim() || null,
        loginRequired,
      });
      setUrl('');
      setLabel('');
      setGroup('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addform">
      <input placeholder="https://… 점검할 페이지 URL" value={url} onChange={e => setUrl(e.target.value)} />
      <input placeholder="페이지 이름" value={label} onChange={e => setLabel(e.target.value)} />
      <input placeholder="그룹" value={group} onChange={e => setGroup(e.target.value)} />
      <label className="chk">
        <input type="checkbox" checked={loginRequired} onChange={e => setLoginRequired(e.target.checked)} />
        로그인 필요
      </label>
      <button onClick={submit} disabled={busy || !url.trim()}>
        추가
      </button>
    </div>
  );
}

// 여러 페이지를 JSON 으로 한 번에 추가(내보내기 JSON 도 그대로 호환). 추가 전용 — 기존 것 안 건드림.
function JsonImportForm({ onImported, onErr }: { onImported: () => void; onErr: Notify }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    let parsed: unknown;
    try {
      parsed = parseLooseJson(text);
    } catch {
      onErr('JSON 형식이 올바르지 않습니다. (배열 또는 { "pages": [...] } 형태인지 확인하세요)');
      return;
    }
    // 123, "abc" 같은 것도 유효한 JSON 이라 파싱은 통과한다 → 배열/{pages} 인지 여기서 막아 서버로 안 쏜다.
    const ok =
      Array.isArray(parsed) ||
      (!!parsed && typeof parsed === 'object' && Array.isArray((parsed as { pages?: unknown }).pages));
    if (!ok) {
      onErr('배열을 넣어주세요. 예: [{ "url": "..." }]');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.importPages(parsed);
      const summary = `추가 ${r.added}개 · 건너뜀 ${r.skipped}개(중복/빈 URL) · 총 ${r.total}개`;
      setMsg(summary);
      onErr(summary, 'ok');
      if (r.added > 0) {
        onImported();
        setText('');
      }
    } catch (e) {
      onErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jsonimport">
      <div className="ji-head">JSON으로 일괄 추가</div>
      <div className="ji-hint">
        최상위 배열 또는 <code>{'{ "pages": [...] }'}</code> 형식 · 내보낸 JSON도 그대로 붙여넣기 가능 (중복 URL은 건너뜀)
      </div>
      <textarea
        className="ji-text"
        rows={8}
        spellCheck={false}
        placeholder={
          '[\n  { "url": "https://example.com", "label": "예시", "group": "demo", "loginRequired": false }\n]'
        }
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {msg && <div className="ji-msg">{msg}</div>}
      <button className="primary" onClick={submit} disabled={busy || !text.trim()}>
        {busy ? '추가 중…' : 'JSON 일괄 추가'}
      </button>
    </div>
  );
}

// ── 설정 탭: 측정 주기 / 임계값 / 데이터 보관 (카드별 독립 저장 → 즉시 반영) ──

function SettingsView({
  autoRefresh,
  onAutoRefreshChange,
  onSaved,
  onErr,
}: {
  autoRefresh: AutoRefresh;
  onAutoRefreshChange: (next: AutoRefresh) => void;
  onSaved: () => void;
  onErr: Notify;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(e => onErr(String(e)));
  }, [onErr]);

  if (!settings) return <p className="hint">설정 불러오는 중…</p>;

  // 저장 → 갱신된 전체 설정 반환(throw 는 카드가 잡음). 저장한 카드가 결과로 자기 draft 동기화.
  async function save(patch: Partial<Settings>): Promise<Settings> {
    const next = await api.updateSettings(patch);
    setSettings(next);
    onSaved(); // 상단 배지·임계값 즉시 갱신
    return next;
  }

  return (
    <div className="settings">
      <SettingCard
        title="측정 주기"
        current={settings}
        rows={[
          { key: 'enabled', label: '자동 점검', kind: 'bool' },
          { key: 'checkIntervalMin', label: '측정 간격', kind: 'select', options: INTERVAL_OPTIONS },
        ]}
        note={
          settings.enabled
            ? `${intervalLabel(settings.checkIntervalMin)}마다 전체 자동 점검`
            : '자동 점검 꺼짐 — 수동 "지금 전체 점검"만 동작'
        }
        onSave={save}
        onErr={onErr}
      />
      <SettingCard
        title="임계값"
        current={settings}
        rows={[
          { key: 'warningMs', label: '주의 (ms)', kind: 'num', min: 0, max: 600000 },
          { key: 'criticalMs', label: '심각 (ms)', kind: 'num', min: 0, max: 600000 },
        ]}
        note="응답시간이 주의 이상이면 🟡, 심각 이상이면 🔴 로 표시 (응답 실패는 ❌)"
        onSave={save}
        onErr={onErr}
      />
      <SettingCard
        title="데이터 보관"
        current={settings}
        rows={[{ key: 'retentionDays', label: '보관 기간 (일)', kind: 'num', min: 0, max: 3650 }]}
        note="이 기간 지난 점검 이력을 자동 정리 (0 = 정리 안 함)"
        onSave={save}
        onErr={onErr}
      />
      <AutoRefreshCard value={autoRefresh} onChange={onAutoRefreshChange} />
    </div>
  );
}

// 자동 갱신 카드 — 이 브라우저(localStorage)에만 적용되는 실시간 갱신 on/off.
// 켜면 SSE 를 구독해, 서버가 점검을 끝낼 때마다 push 받아 화면을 갱신한다(주기 설정 불필요).
function AutoRefreshCard({
  value,
  onChange,
}: {
  value: AutoRefresh;
  onChange: (next: AutoRefresh) => void;
}) {
  return (
    <section className="setcard">
      <h3>자동 갱신 (실시간)</h3>
      <div className="setrow">
        <label>사용</label>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
        />
      </div>
      <p className="setnote">
        {value.enabled
          ? '점검이 끝날 때마다 서버가 알려줘 화면이 자동 갱신됩니다(SSE 푸시) — 페이지 리로드·깜빡임 없이 상태·응답시간·펼친 그래프가 바뀜. 주기 설정 불필요 · 이 브라우저에만 적용.'
          : '꺼짐 — F5/"지금 전체 점검" 해야 갱신. 켜면 점검이 끝나는 시점마다 자동 갱신 · 이 브라우저에만 적용(localStorage).'}
      </p>
    </section>
  );
}

// 측정 간격(분) → 사람이 읽는 라벨(프리셋 기준, 없으면 분 표기).
function intervalLabel(min: number): string {
  return INTERVAL_OPTIONS.find(o => o.value === min)?.label ?? `${min}분`;
}

type SettingRow = {
  key: keyof Settings;
  label: string;
  kind: 'num' | 'bool' | 'select';
  min?: number;
  max?: number;
  options?: { value: number; label: string }[];
};

// 입력 중 빈칸을 허용하려 draft 값에 string 도 둔다(저장 시 number 로 정규화).
type CardDraft = Record<string, number | boolean | string>;

function SettingCard({
  title,
  current,
  rows,
  note,
  onSave,
  onErr,
}: {
  title: string;
  current: Settings;
  rows: SettingRow[];
  note?: string;
  onSave: (patch: Partial<Settings>) => Promise<Settings>;
  onErr: Notify;
}) {
  const pick = (): CardDraft => Object.fromEntries(rows.map(r => [r.key, current[r.key]]));
  const [draft, setDraft] = useState<CardDraft>(pick);
  const [busy, setBusy] = useState(false);

  // 이 카드 필드가 편집됐는지(빈칸 '' 도 number 와 다르므로 dirty).
  const dirty = rows.some(r =>
    r.kind === 'num' ? String(draft[r.key]) !== String(current[r.key]) : draft[r.key] !== current[r.key],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // 다른 카드 저장 등으로 current 가 바뀌면 draft 동기화 — 단 이 카드를 편집 중(dirty)이면 보존.
  useEffect(() => {
    if (dirtyRef.current) return;
    setDraft(Object.fromEntries(rows.map(r => [r.key, current[r.key]])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function set(key: keyof Settings, value: number | boolean | string) {
    setDraft(d => ({ ...d, [key]: value }));
  }

  async function submit() {
    // 빈칸은 저장 시점에만 0 으로 정규화(서버 updateSettings 가 다시 클램프/보정).
    const patch: Record<string, number | boolean> = {};
    for (const r of rows) {
      const v = draft[r.key];
      patch[r.key] = r.kind === 'bool' ? Boolean(v) : v === '' || v == null ? 0 : Number(v);
    }
    setBusy(true);
    try {
      const next = await onSave(patch as Partial<Settings>);
      setDraft(Object.fromEntries(rows.map(r => [r.key, next[r.key]]))); // 결과로 동기화
    } catch (e) {
      onErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="setcard">
      <h3>{title}</h3>
      {rows.map(r => (
        <div className="setrow" key={r.key}>
          <label>{r.label}</label>
          {r.kind === 'bool' ? (
            <input
              type="checkbox"
              checked={Boolean(draft[r.key])}
              onChange={e => set(r.key, e.target.checked)}
            />
          ) : r.kind === 'select' ? (
            <select value={String(draft[r.key] ?? '')} onChange={e => set(r.key, Number(e.target.value))}>
              {(r.options ?? []).map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {/* 기존 DB 의 비프리셋 값도 선택 상태로 보이게(예전 임의 분) */}
              {r.options && !r.options.some(o => o.value === current[r.key]) && (
                <option value={String(current[r.key])}>{String(current[r.key])}분</option>
              )}
            </select>
          ) : (
            <input
              type="number"
              value={draft[r.key] === '' ? '' : String(draft[r.key] ?? '')}
              min={r.min}
              max={r.max}
              onChange={e => set(r.key, e.target.value === '' ? '' : Number(e.target.value))}
            />
          )}
        </div>
      ))}
      {note && <div className="setnote">{note}</div>}
      <div className="setactions">
        <button className="primary" onClick={submit} disabled={busy || !dirty}>
          저장
        </button>
        <button onClick={() => setDraft(pick())} disabled={busy || !dirty}>
          취소
        </button>
      </div>
    </section>
  );
}

// ── 슬랙 알람 탭 ──

function SlackView({ onErr }: { onErr: Notify }) {
  const [s, setS] = useState<SlackSettings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    api.slackSettings().then(setS).catch(e => onErr(String(e)));
  }, [onErr]);

  if (!s) return <p className="hint">슬랙 설정 불러오는 중…</p>;
  const cur = s;

  async function save(patch: SlackSettingsPatch) {
    setS(prev => (prev ? { ...prev, ...patch } : prev)); // 낙관적 즉시 반영
    try {
      setS(await api.updateSlackSettings(patch)); // 서버 clamp 결과로 동기화
    } catch (e) {
      onErr(String(e));
      api.slackSettings().then(setS).catch(() => {}); // 실패 시 서버값 롤백
    }
  }

  async function onTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      setTestMsg(await api.testSlack());
    } catch (e) {
      setTestMsg({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="settings">
      <section className="setcard">
        <div className="slack-row">
          <label>알람 켜기</label>
          <div className="slack-enable">
            <input
              type="checkbox"
              checked={cur.enabled}
              onChange={e => save({ enabled: e.target.checked })}
            />
            <button className="slack-history-btn" onClick={() => setHistoryOpen(true)}>
              알람 발송 내역
            </button>
          </div>
        </div>

        <div className="slack-row">
          <label>발송 방식</label>
          <div className="slack-modes">
            <button
              className={cur.mode === 'webhook' ? 'modebtn on' : 'modebtn'}
              onClick={() => save({ mode: 'webhook' })}
            >
              Webhook
            </button>
            <button
              className={cur.mode === 'bot' ? 'modebtn on' : 'modebtn'}
              onClick={() => save({ mode: 'bot' })}
            >
              Bot Token
            </button>
          </div>
        </div>

        {cur.mode === 'webhook' ? (
          <div className="slack-row">
            <label>Webhook URL</label>
            <SlackField
              placeholder="https://hooks.slack.com/services/..."
              value={cur.webhookUrl}
              onCommit={v => save({ webhookUrl: v })}
            />
          </div>
        ) : (
          <>
            <div className="slack-row">
              <label>Bot Token</label>
              <SlackField
                type="password"
                placeholder="xoxb-..."
                value={cur.botToken}
                onCommit={v => save({ botToken: v })}
              />
            </div>
            <div className="slack-row">
              <label>채널</label>
              <SlackField
                placeholder="#alerts 또는 C0XXXXXXX"
                value={cur.channel}
                onCommit={v => save({ channel: v })}
              />
            </div>
            <p className="hint slack-note">
              봇을 채널에 초대해야 발송됩니다. 토큰엔 <code>chat:write</code> 권한 필요.
            </p>
          </>
        )}

        <div className="slack-test">
          <button onClick={onTest} disabled={testing}>
            {testing ? '발송 중…' : 'Slack 테스트'}
          </button>
          {testMsg && (
            <span className={testMsg.ok ? 'slack-ok' : 'slack-bad'}>{testMsg.message}</span>
          )}
        </div>
      </section>

      <section className="setcard">
        <h3>알람 조건</h3>
        <div className="setrow">
          <label>알람 쿨다운 (분)</label>
          <SlackNum value={cur.cooldownMin} min={0} max={1440} onCommit={v => save({ cooldownMin: v })} />
        </div>
        <div className="setrow">
          <label>윈도우 크기 (최근 N회)</label>
          <SlackNum value={cur.windowSize} min={1} max={100} onCommit={v => save({ windowSize: v })} />
        </div>
        <div className="setrow">
          <label>🔴 실패/심각 M회 시 발동</label>
          <SlackNum value={cur.threshold} min={1} max={cur.windowSize} onCommit={v => save({ threshold: v })} />
        </div>
        <div className="setrow">
          <label>✅ 복구 알람 받기</label>
          <input
            type="checkbox"
            checked={cur.recoverEnabled}
            onChange={e => save({ recoverEnabled: e.target.checked })}
          />
        </div>
        {cur.recoverEnabled && (
          <div className="setrow">
            <label>복구 조건 (최근 N회 연속 정상)</label>
            <SlackNum
              value={cur.recoverStreak}
              min={1}
              max={cur.windowSize}
              onCommit={v => save({ recoverStreak: v })}
            />
          </div>
        )}
        <p className="setnote">
          한 페이지의 최근 <b>{cur.windowSize}회</b> 중 <b>{cur.threshold}회</b>가 <b>실패/심각</b>이면
          발동합니다. 이후엔 <b>새로 생긴</b> 실패가 {cur.threshold}건 더 쌓일 때마다 재발사하고(메시지엔
          누적 수 표시),{' '}
          {cur.recoverEnabled ? (
            <>
              최근 <b>{cur.recoverStreak}회</b> 연속 정상이면 ✅ 복구 알림.
            </>
          ) : (
            <>복구 알람은 꺼져 있습니다(발동 알람만 옴).</>
          )}{' '}
          (세션 만료·주의는 제외)
        </p>
      </section>

      {historyOpen && <AlarmHistoryModal onClose={() => setHistoryOpen(false)} onErr={onErr} />}
    </div>
  );
}

// 자격증명 입력 — 타이핑 중엔 로컬, blur 때 1회 저장(키 입력마다 저장 방지).
function SlackField({
  value,
  onCommit,
  type = 'text',
  placeholder,
}: {
  value: string;
  onCommit: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="slack-input"
      type={type}
      placeholder={placeholder}
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) onCommit(v);
      }}
    />
  );
}

// 숫자 입력 — blur 때 정규화 저장(빈칸/NaN 이면 원복).
function SlackNum({
  value,
  onCommit,
  min,
  max,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
}) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <input
      className="slack-input num"
      type="number"
      min={min}
      max={max}
      value={v}
      onChange={e => setV(e.target.value)}
      onBlur={() => {
        const n = Math.round(Number(v));
        if (Number.isFinite(n) && n !== value) onCommit(n);
        else setV(String(value));
      }}
    />
  );
}

const SLACK_STATUS_META: Record<string, { icon: string; label: string; cls: string }> = {
  sent: { icon: '✅', label: '전송됨', cls: 'slack-ok' },
  failed: { icon: '❌', label: '실패', cls: 'slack-bad' },
  skipped: { icon: '⏭️', label: '미설정', cls: 'slack-skip' },
};

function AlarmHistoryModal({ onClose, onErr }: { onClose: () => void; onErr: Notify }) {
  const [events, setEvents] = useState<AlarmEvent[] | null>(null);

  useEffect(() => {
    api.alarmEvents(200).then(setEvents).catch(e => onErr(String(e)));
  }, [onErr]);
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const total = events?.length ?? 0;
  const sent = events?.filter(e => e.slackStatus === 'sent').length ?? 0;
  const failed = events?.filter(e => e.slackStatus === 'failed').length ?? 0;
  const skipped = events?.filter(e => e.slackStatus === 'skipped').length ?? 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card alarm-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <strong>알람 발송 내역</strong>
          {total > 0 && (
            <span className="alarm-summary">
              최근 {total}건
              {sent > 0 && <span className="slack-ok"> · ✅{sent}</span>}
              {failed > 0 && <span className="slack-bad"> · ❌{failed}</span>}
              {skipped > 0 && <span className="slack-skip"> · ⏭️{skipped}</span>}
            </span>
          )}
          <button className="modal-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>
        <div className="alarm-list">
          {events === null ? (
            <span className="hint">불러오는 중…</span>
          ) : total === 0 ? (
            <span className="hint">
              아직 발사된 알람이 없습니다. 알람 조건이 한 번도 충족된 적이 없다는 뜻입니다.
            </span>
          ) : (
            events.map(ev => {
              const meta = SLACK_STATUS_META[ev.slackStatus] ?? SLACK_STATUS_META.skipped;
              return (
                <div className="alarm-item" key={ev.id}>
                  <span className="alarm-icon" title={`슬랙 ${meta.label}`}>
                    {meta.icon}
                  </span>
                  <div className="alarm-body">
                    <div className="alarm-title">{ev.title}</div>
                    <div className="alarm-detail" title={ev.detail}>
                      {ev.detail}
                    </div>
                    <div className={'alarm-status ' + meta.cls}>
                      슬랙 {meta.label}
                      {ev.slackError ? ` · ${ev.slackError}` : ''}
                    </div>
                  </div>
                  <span className="alarm-ts">{fmtAlarmTs(ev.ts)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// 두 점검 사이 간격을 사람이 읽는 말로 ("5분 후" / "1시간 20분 후"). 모니터링 핵심: '언제부터 에러'.
function fmtGap(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}초 후`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분 후`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분 후` : `${h}시간 후`;
}

function fmtAlarmTs(ts: number): string {
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${da} ${h}:${mi}`;
}
