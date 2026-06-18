import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 모든 런타임 경로의 기준. server/ 의 부모 = 프로젝트 루트.
// process.cwd() 가 아니라 이 파일 위치 기준이라, 어느 디렉토리에서 기동해도 흔들리지 않는다.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
