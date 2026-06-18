import { chromium } from 'playwright';
import readline from 'node:readline';
import { getConfig } from './config';
import { STORAGE_STATE_PATH } from './checker';

/**
 * 최초 1회 로그인 세션 저장 스크립트.
 *   npm run login                 → data/pages.json 의 loginUrl 사용
 *   npm run login -- https://...  → 인자 URL 사용
 * headed 크롬이 떠서 사람이 직접 로그인 → 터미널에서 Enter → storageState 저장.
 * 이후 헤드리스 점검이 이 세션을 재사용한다.
 */
async function main() {
  const cfg = getConfig();
  const url = process.argv[2] || cfg.loginUrl;
  if (!url) {
    console.error(
      '로그인 URL이 없습니다. data/pages.json 의 loginUrl 을 채우거나 인자로 주세요:\n  npm run login -- https://example.com/login',
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);

  // 세션 저장 — 중복 호출 방지
  let saved = false;
  async function save() {
    if (saved) return;
    saved = true;
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`\n세션 저장됨: ${STORAGE_STATE_PATH}`);
  }

  // Ctrl+C(SIGINT) 로도 저장 — yarn 등을 거쳐 실행하면 stdin(Enter)이 스크립트까지
  // 전달되지 않는 경우가 있어, 입력에 의존하지 않는 종료 경로를 둔다.
  process.on('SIGINT', async () => {
    await save();
    await browser.close().catch(() => {});
    process.exit(0);
  });
  // 사용자가 브라우저 창을 직접 닫아도 저장 시도
  context.on('close', () => {
    save().catch(() => {});
  });

  console.log('\n브라우저에서 로그인하세요. 완료되면 둘 중 아무거나:');
  console.log('  · 이 터미널에서 Enter');
  console.log('  · Enter 가 안 먹으면 Ctrl+C');
  console.log('→ 세션이 저장됩니다.\n');

  await new Promise<void>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });

  await save();
  await browser.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
