import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

/**
 * 점검 설정 — data/pages.json 한 파일에서 읽는다.
 * { loginUrl, loginPattern, pages: [...] }
 * - loginUrl: `npm run login` 이 여는 로그인 페이지
 * - loginPattern: 점검 중 최종 URL 이 이 문자열을 포함하면 "세션 만료"로 판정
 */
// 정적 부트스트랩 설정 — pages.json 에서 읽는다(런타임 편집값은 DB settings 테이블 담당).
export interface Config {
  loginUrl: string;
  loginPattern: string;
}

const CONFIG_PATH = path.join(DATA_DIR, 'pages.json');
const DEFAULT: Config = { loginUrl: '', loginPattern: '/login' };

export function getConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      loginUrl: typeof raw.loginUrl === 'string' ? raw.loginUrl : DEFAULT.loginUrl,
      // 빈 문자열이면 세션 만료 감지가 통째로 꺼지는 함정 → DEFAULT 로 보정
      loginPattern:
        typeof raw.loginPattern === 'string' && raw.loginPattern.trim()
          ? raw.loginPattern
          : DEFAULT.loginPattern,
    };
  } catch {
    return DEFAULT;
  }
}

/**
 * pages.json 에 옛 scheduler 키가 남아 있으면 1회 경고 — 이제 무시되기 때문(설정 탭/DB settings 로 이관).
 * 비기본값을 적어두고 운영하다 조용히 기본값으로 되돌아가는 혼란 방지.
 */
export function warnIfLegacyScheduler(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (raw && typeof raw === 'object' && 'scheduler' in raw) {
      console.warn(
        '[config] pages.json 의 scheduler 설정은 더 이상 적용되지 않습니다 — 측정주기/임계값/보관기간은 대시보드 "설정" 탭에서 조정하세요.',
      );
    }
  } catch {
    /* 파일 없음/파싱 실패는 무시 */
  }
}

/** seed 용 — pages.json 의 pages 배열. */
export function getSeedPages(): Array<{ url: string; label?: string; group?: string | null; loginRequired?: boolean }> {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return Array.isArray(raw.pages) ? raw.pages : [];
  } catch {
    return [];
  }
}
