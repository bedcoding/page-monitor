import type { FastifyReply } from 'fastify';

/**
 * SSE(Server-Sent Events) 허브.
 * 점검이 끝날 때마다 서버가 "방금 점검했다"를 구독 중인 대시보드들에 밀어준다(push).
 * → 대시보드는 폴링으로 주기를 맞출 필요 없이, 결과가 생기는 그 순간 갱신한다.
 */
const clients = new Set<FastifyReply>();

/** 한 클라이언트(브라우저 EventSource)를 등록하고 keep-alive 핑을 건다. */
export function addClient(reply: FastifyReply): void {
  reply.hijack(); // Fastify 의 자동 응답 종료를 끄고 raw 스트림을 직접 다룬다
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write('retry: 3000\n\n'); // 끊기면 브라우저가 3s 후 재연결
  clients.add(reply);

  // 프록시·방화벽이 idle 연결을 끊지 않도록 주기적 주석 핑.
  const ping = setInterval(() => {
    try {
      reply.raw.write(': ping\n\n');
    } catch {
      /* 끊긴 연결은 close 핸들러가 정리 */
    }
  }, 25_000);

  reply.raw.on('close', () => {
    clearInterval(ping);
    clients.delete(reply);
  });
}

/** 모든 구독자에게 이벤트를 전송. 쓰기 실패한 연결은 정리한다. */
export function broadcast(event: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const reply of clients) {
    try {
      reply.raw.write(payload);
    } catch {
      clients.delete(reply);
    }
  }
}

/** 서버 종료 시 모든 SSE 연결을 닫는다(열린 연결이 app.close 를 막지 않게). */
export function closeAllClients(): void {
  for (const reply of clients) {
    try {
      reply.raw.end();
    } catch {
      /* 무시 */
    }
  }
  clients.clear();
}
