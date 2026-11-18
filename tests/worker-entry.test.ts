import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionContext } from 'hono';
import worker from '../src/index';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';

const dummyCtx: ExecutionContext = {
  waitUntil(_promise: Promise<unknown>) {},
  passThroughOnException() {},
  props: {},
};

test('Cloudflare Worker entry routes /api/health to Hono and static routes to ASSETS', async () => {
  resetSeedCacheForTests();
  const db = new LocalD1Adapter(':memory:');

  const assetCalls: string[] = [];
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    ASSETS: {
      async fetch(input) {
        const url = typeof input === 'string' ? input : input.url;
        assetCalls.push(url);
        return new Response('<html>SPA</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      },
    },
  };

  // 1. /api/health routes to Hono and auto-bootstraps empty D1 schema + initial admin
  const healthRes = await worker.fetch(new Request('https://fleet-secure.workers.dev/api/health'), env, dummyCtx);
  assert.equal(healthRes.status, 200);
  const healthBody = (await healthRes.json()) as { ok: boolean; service: string };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, 'fleet-secure');

  // Verify empty D1 schema was bootstrapped cleanly without manual migration
  const adminUser = await db
    .prepare("SELECT username, role FROM users WHERE username = 'admin'")
    .first<{ username: string; role: string }>();
  assert.equal(adminUser?.username, 'admin');
  assert.equal(adminUser?.role, 'ADMIN');

  // 2. Non-API requests delegate to env.ASSETS.fetch
  const spaRes = await worker.fetch(new Request('https://fleet-secure.workers.dev/'), env, dummyCtx);
  assert.equal(spaRes.status, 200);
  assert.equal(await spaRes.text(), '<html>SPA</html>');
  assert.deepEqual(assetCalls, ['https://fleet-secure.workers.dev/']);

  // 3. /api/* returns clear 503 JSON if DB binding is missing
  const missingDbRes = await worker.fetch(
    new Request('https://fleet-secure.workers.dev/api/health'),
    { DB: undefined as unknown as AppEnv['DB'] },
    dummyCtx
  );
  assert.equal(missingDbRes.status, 503);
});
