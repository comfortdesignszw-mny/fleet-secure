import type { ExecutionContext } from 'hono';
import { createApp } from './server/app';
import { checkAndNotifyOverdueHires } from './server/notifications';
import type { AppEnv } from './server/types';

const app = createApp();

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!env?.DB) {
        return new Response(
          JSON.stringify({
            error: 'D1 database binding "DB" is not configured on this Worker.',
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          }
        );
      }
      return app.fetch(request, env, ctx);
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Static assets binding "ASSETS" is not configured.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },

  async scheduled(
    _controller: unknown,
    env: AppEnv,
    ctx: ExecutionContext
  ): Promise<void> {
    if (!env?.DB) return;
    ctx.waitUntil(checkAndNotifyOverdueHires(env.DB, { env }));
  },
};
