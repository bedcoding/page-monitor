import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { initDb, listPages, addPage, closeDb } from './db';
import { registerRoutes } from './routes';
import { startScheduler, stopScheduler, awaitIdle } from './scheduler';
import { closeAllClients } from './events';
import { getSeedPages, warnIfLegacyScheduler } from './config';
import { DIST_DIR } from './paths';

// 기본 4000 (3000 은 다른 React 앱과 잘 충돌해서 피함). 필요하면 PORT 환경변수로 변경.
// 비숫자/빈값/범위초과면 조용한 NaN→임의포트 바인딩을 막고 4000 으로 폴백.
const portEnv = Number(process.env.PORT);
const PORT = Number.isInteger(portEnv) && portEnv > 0 && portEnv <= 65535 ? portEnv : 4000;

/** DB 가 비어 있으면 data/pages.json 의 pages 로 1회 시드. */
function seedIfEmpty() {
  if (listPages().length > 0) return;
  for (const p of getSeedPages()) {
    if (!p.url) continue;
    addPage({
      url: p.url,
      label: p.label ?? p.url,
      group: p.group ?? null,
      login_required: p.loginRequired === false ? 0 : 1,
    });
  }
}

async function main() {
  initDb();
  seedIfEmpty();
  warnIfLegacyScheduler();

  const app = Fastify({ logger: false });
  registerRoutes(app);

  // prod: vite build 산출물(dist)을 정적 서빙(단일 포트). dev 는 Vite(5173)가 UI 담당.
  const dist = DIST_DIR;
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(
    `[page-monitor] API: http://localhost:${PORT}` +
      (fs.existsSync(dist)
        ? ` (대시보드 포함)`
        : `  ·  dev 대시보드: http://localhost:5173`),
  );

  // 2단계: 자동 주기 점검 시작(기본 5분). env SCHEDULER=off 또는 config 로 끌 수 있음.
  startScheduler();
  // 그레이스풀 종료: 다음 발화 차단 → 진행 중 회차 완료 대기 → 서버/DB 정리 → exit.
  // (진행 중 점검의 헤드리스 크롬이 좀비로 남거나 WAL 미체크포인트 되는 것 방지)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, async () => {
      console.log(`[page-monitor] ${sig} 수신 — 진행 중 점검 정리 후 종료`);
      stopScheduler();
      closeAllClients(); // 열린 SSE 연결을 닫아 app.close 가 멈추지 않게
      await awaitIdle(10_000); // 진행 중 점검 완료까지(최대 10s) 대기 후 정리
      await app.close().catch(() => {});
      closeDb();
      console.log('[page-monitor] 종료 완료');
      process.exit(0);
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
