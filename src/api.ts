import type {
  PageTarget,
  CheckResult,
  SessionStatus,
  NewPage,
  PageApiRow,
  ApiCallRow,
  ApiPageRow,
  ApiTestResult,
  HistoryPoint,
  SchedulerStatus,
  ExportData,
  Settings,
  SettingsPatch,
  DailyStat,
  SlackSettings,
  SlackSettingsPatch,
  SlackTestResult,
  AlarmEvent,
} from '../shared/types';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    // 본문이 없을 땐 Content-Type 을 붙이지 않는다.
    // (붙이면 Fastify 가 '빈 JSON body' 로 보고 400 FST_ERR_CTP_EMPTY_JSON_BODY)
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function del<T>(url: string): Promise<T> {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  pages: () => get<PageTarget[]>('/api/pages'),
  addPage: (p: NewPage) => post<{ id: number }>('/api/pages', p),
  importPages: (data: unknown) =>
    post<{ added: number; skipped: number; total: number }>('/api/pages/import', data),
  updatePage: (
    id: number,
    p: { label?: string; group?: string | null; loginRequired?: boolean },
  ) => patch<{ updated: boolean }>(`/api/pages/${id}`, p),
  deletePage: (id: number) => del<{ deleted: boolean }>(`/api/pages/${id}`),
  runCheck: () => post<CheckResult[]>('/api/check'),
  checkPage: (id: number) => post<CheckResult | null>(`/api/pages/${id}/check`),
  latest: () => get<CheckResult[]>('/api/results/latest'),
  session: () => get<SessionStatus>('/api/session'),
  pageApis: (id: number) => get<PageApiRow[]>(`/api/pages/${id}/apis`),
  addManualApi: (id: number, method: string, path: string) =>
    post<{ added: boolean }>(`/api/pages/${id}/apis`, { method, path }),
  importManualApis: (id: number, data: unknown) =>
    post<{ added: number; skipped: number; total: number }>(`/api/pages/${id}/apis/import`, data),
  deleteManualApi: (id: number, method: string, url: string) =>
    del<{ deleted: boolean }>(
      `/api/pages/${id}/apis?method=${encodeURIComponent(method)}&url=${encodeURIComponent(url)}`,
    ),
  testApi: (id: number, method: string, url: string) =>
    post<ApiTestResult>(`/api/pages/${id}/apis/test`, { method, url }),
  pageHistory: (id: number, limit = 30) =>
    get<HistoryPoint[]>(`/api/pages/${id}/history?limit=${limit}`),
  pageDaily: (id: number, days = 30) => get<DailyStat[]>(`/api/pages/${id}/daily?days=${days}`),
  pageChecks: (id: number, date: string) =>
    get<HistoryPoint[]>(`/api/pages/${id}/checks?date=${date}`),
  apis: () => get<ApiCallRow[]>('/api/apis'),
  apiPages: (id: number) => get<ApiPageRow[]>(`/api/apis/${id}/pages`),
  scheduler: () => get<SchedulerStatus>('/api/scheduler'),
  exportData: () => get<ExportData>('/api/export'),
  getSettings: () => get<Settings>('/api/settings'),
  updateSettings: (p: SettingsPatch) => patch<Settings>('/api/settings', p),
  slackSettings: () => get<SlackSettings>('/api/slack/settings'),
  updateSlackSettings: (p: SlackSettingsPatch) => patch<SlackSettings>('/api/slack/settings', p),
  testSlack: () => post<SlackTestResult>('/api/slack/test'),
  alarmEvents: (limit = 200) => get<AlarmEvent[]>(`/api/slack/events?limit=${limit}`),
};
