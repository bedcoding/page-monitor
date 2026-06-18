import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev: Vite(5173)가 대시보드를 띄우고, /api 요청은 Fastify(4000)로 프록시.
// prod: `npm run build` → dist 를 Fastify 가 정적 서빙(단일 포트 4000).
// ※ 서버 포트는 server/index.ts 의 PORT(기본 4000)와 반드시 일치시킬 것.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
