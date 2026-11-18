import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { verifyAuditChain } from '../src/server/audit';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';

function createTestEnv(allowPreviewSignup?: string): { db: LocalD1Adapter; env: AppEnv } {
  resetSeedCacheForTests();
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new LocalD1Adapter(':memory:', schemaSql);
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
    ...(allowPreviewSignup !== undefined ? { ALLOW_PREVIEW_SIGNUP: allowPreviewSignup } : {}),
  };
  return { db, env };
}

test('Preview signup status and endpoints are disabled unless ALLOW_PREVIEW_SIGNUP=true', async () => {
  const { env: defaultEnv } = createTestEnv();
  const app = createApp();

  const statusDefault = await app.fetch(
    new Request('http://localhost/api/auth/preview-status'),
    defaultEnv
  );
  assert.equal(statusDefault.status, 200);
  const statusDefaultData = (await statusDefault.json()) as {
    previewSignupEnabled: boolean;
    vehicleCount: number;
  };
  assert.equal(statusDefaultData.previewSignupEnabled, false);
  assert.equal(statusDefaultData.vehicleCount, 0);

  const { env: disabledEnv } = createTestEnv('false');
  const statusDisabled = await app.fetch(
    new Request('http://localhost/api/auth/preview-status'),
    disabledEnv
  );
  const statusDisabledData = (await statusDisabled.json()) as { previewSignupEnabled: boolean };
  assert.equal(statusDisabledData.previewSignupEnabled, false);

  const blockedSignup = await app.fetch(
    new Request('http://localhost/api/auth/signup-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Comfort Tester',
        username: 'comfort.admin',
        pin: '4321',
        load_demo_data: true,
      }),
    }),
    disabledEnv
  );
  assert.equal(blockedSignup.status, 403);
});

test('Preview admin self-signup creates active ADMIN, seeds demo data, sets cookie, and maintains audit chain', async () => {
  const { db, env } = createTestEnv('true');
  const app = createApp();

  const statusRes = await app.fetch(new Request('http://localhost/api/auth/preview-status'), env);
  assert.equal(statusRes.status, 200);
  const statusData = (await statusRes.json()) as { previewSignupEnabled: boolean };
  assert.equal(statusData.previewSignupEnabled, true);

  const signupRes = await app.fetch(
    new Request('http://localhost/api/auth/signup-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Comfort Preview Admin',
        username: 'comfort.tester',
        pin: '4321',
        load_demo_data: true,
      }),
    }),
    env
  );
  assert.equal(signupRes.status, 201);

  const setCookie = signupRes.headers.get('set-cookie') || '';
  const cookiePair = setCookie.split(';')[0];
  assert.ok(cookiePair.startsWith('fleet_session='));

  const signupBody = (await signupRes.json()) as {
    user: { id: number; username: string; full_name: string; role: string; must_change_pin: boolean };
    demoSeeded: { vehiclesAdded: number; driversAdded: number; tripsAdded: number } | null;
  };
  assert.equal(signupBody.user.username, 'comfort.tester');
  assert.equal(signupBody.user.role, 'ADMIN');
  assert.equal(signupBody.user.must_change_pin, false);
  assert.ok(signupBody.demoSeeded);
  assert.ok(signupBody.demoSeeded.vehiclesAdded >= 5);
  assert.ok(signupBody.demoSeeded.driversAdded >= 5);
  assert.ok(signupBody.demoSeeded.tripsAdded >= 2);

  // Immediately able to access Admin endpoints without forced PIN change
  const settingsRes = await app.fetch(
    new Request('http://localhost/api/settings', {
      headers: { Cookie: cookiePair },
    }),
    env
  );
  assert.equal(settingsRes.status, 200);

  // Duplicate username returns 409
  const dupRes = await app.fetch(
    new Request('http://localhost/api/auth/signup-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Duplicate User',
        username: 'comfort.tester',
        pin: '9999',
      }),
    }),
    env
  );
  assert.equal(dupRes.status, 409);

  // Hash-chained audit log stays completely valid
  const auditVerify = await verifyAuditChain(db);
  assert.equal(auditVerify.ok, true);
  assert.ok(auditVerify.totalRows >= 2);
});

test('POST /api/demo/seed requires ADMIN and ALLOW_PREVIEW_SIGNUP=true, and seeds idempotently', async () => {
  const { env } = createTestEnv('true');
  const app = createApp();

  // Signup admin without seeding demo data initially
  const adminSignup = await app.fetch(
    new Request('http://localhost/api/auth/signup-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: 'Yard Owner',
        username: 'yard.owner',
        pin: '5678',
        load_demo_data: false,
      }),
    }),
    env
  );
  assert.equal(adminSignup.status, 201);
  const adminCookie = (adminSignup.headers.get('set-cookie') || '').split(';')[0];

  // Create a driver account and verify non-admin cannot trigger demo seed
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'yard.driver',
        full_name: 'Yard Driver',
        role: 'DRIVER',
        pin: '1122',
      }),
    }),
    env
  );

  const driverLogin = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'yard.driver', pin: '1122' }),
    }),
    env
  );
  const driverCookie = (driverLogin.headers.get('set-cookie') || '').split(';')[0];
  await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: driverCookie },
      body: JSON.stringify({ currentPin: '1122', newPin: '3344' }),
    }),
    env
  );

  const driverSeed = await app.fetch(
    new Request('http://localhost/api/demo/seed', {
      method: 'POST',
      headers: { Cookie: driverCookie },
    }),
    env
  );
  assert.equal(driverSeed.status, 403);

  // Admin can trigger demo seed when fleet is empty
  const firstSeed = await app.fetch(
    new Request('http://localhost/api/demo/seed', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(firstSeed.status, 200);
  const firstBody = (await firstSeed.json()) as {
    ok: boolean;
    vehiclesAdded: number;
    driversAdded: number;
    tripsAdded: number;
  };
  assert.equal(firstBody.ok, true);
  assert.ok(firstBody.vehiclesAdded >= 5);
  assert.ok(firstBody.driversAdded >= 5);
  assert.ok(firstBody.tripsAdded >= 2);

  // Second seed is idempotent (adds 0 new records)
  const secondSeed = await app.fetch(
    new Request('http://localhost/api/demo/seed', {
      method: 'POST',
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(secondSeed.status, 200);
  const secondBody = (await secondSeed.json()) as {
    ok: boolean;
    vehiclesAdded: number;
    driversAdded: number;
    tripsAdded: number;
  };
  assert.equal(secondBody.ok, true);
  assert.equal(secondBody.vehiclesAdded, 0);
  assert.equal(secondBody.driversAdded, 0);
  assert.equal(secondBody.tripsAdded, 0);
});

test('Reverse proxy with X-Forwarded-Host and HTTPS allows preview signup/login and sets Partitioned SameSite=None cookie while blocking foreign origins', async () => {
  const { env } = createTestEnv('true');
  const app = createApp();
  const proxyOrigin = 'https://ais-dev-qtw6ywdmrkrb4qx3iys3y5-234259268816.europe-west2.run.app';
  const proxyHost = 'ais-dev-qtw6ywdmrkrb4qx3iys3y5-234259268816.europe-west2.run.app';

  // Signup via reverse-proxied Host: localhost:3000 + X-Forwarded-Host + HTTPS
  const signupRes = await app.fetch(
    new Request('https://localhost:3000/api/auth/signup-admin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'https',
        Origin: proxyOrigin,
      },
      body: JSON.stringify({
        full_name: 'Proxy Admin',
        username: 'proxy.admin',
        pin: '4321',
        load_demo_data: false,
      }),
    }),
    env
  );
  assert.equal(signupRes.status, 201);
  const setCookie = signupRes.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('Secure'));
  assert.ok(setCookie.includes('SameSite=None'));
  assert.ok(setCookie.includes('Partitioned'));

  const cookiePair = setCookie.split(';')[0];

  // Login via reverse-proxied Host: localhost:3000 + X-Forwarded-Host + HTTPS
  const loginRes = await app.fetch(
    new Request('https://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'https',
        Origin: proxyOrigin,
      },
      body: JSON.stringify({ username: 'proxy.admin', pin: '4321' }),
    }),
    env
  );
  assert.equal(loginRes.status, 200);

  // Authenticated GET succeeds with cookie
  const meRes = await app.fetch(
    new Request('https://localhost:3000/api/auth/me', {
      headers: {
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'https',
        Cookie: cookiePair,
      },
    }),
    env
  );
  assert.equal(meRes.status, 200);

  // Truly foreign origin is still rejected with 403
  const evilRes = await app.fetch(
    new Request('https://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'https',
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ username: 'proxy.admin', pin: '4321' }),
    }),
    env
  );
  assert.equal(evilRes.status, 403);
});

test('First-login forced PIN change succeeds behind nginx HTTP proxy (cookie + Bearer fallback)', async () => {
  const { env } = createTestEnv('true');
  const app = createApp();
  const proxyOrigin = 'https://ais-dev-qtw6ywdmrkrb4qx3iys3y5-234259268816.europe-west2.run.app';
  const proxyHost = 'ais-dev-qtw6ywdmrkrb4qx3iys3y5-234259268816.europe-west2.run.app';

  // 1. Login as seeded initial admin (must_change_pin = true) behind nginx sending X-Forwarded-Proto: http
  const loginRes = await app.fetch(
    new Request('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'http',
        Origin: proxyOrigin,
      },
      body: JSON.stringify({ username: 'admin', pin: '1234' }),
    }),
    env
  );
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('Secure'));
  assert.ok(setCookie.includes('SameSite=None'));
  assert.ok(setCookie.includes('Partitioned'));

  const loginBody = (await loginRes.json()) as {
    user: { must_change_pin: boolean };
    sessionToken: string;
  };
  assert.equal(loginBody.user.must_change_pin, true);
  assert.ok(loginBody.sessionToken);

  // 2. First-login PIN change succeeds even when browser omits cookie and uses Bearer fallback
  const changePinRes = await app.fetch(
    new Request('http://localhost:3000/api/auth/change-pin', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'http',
        Origin: proxyOrigin,
        Authorization: `Bearer ${loginBody.sessionToken}`,
      },
      body: JSON.stringify({ currentPin: '1234', newPin: '5678' }),
    }),
    env
  );
  assert.equal(changePinRes.status, 200);
  const changeBody = (await changePinRes.json()) as {
    user: { must_change_pin: boolean };
    sessionToken: string;
  };
  assert.equal(changeBody.user.must_change_pin, false);
  assert.ok(changeBody.sessionToken);

  // 3. Subsequent protected API call succeeds using either cookie or Bearer token
  const cookiePair = (changePinRes.headers.get('set-cookie') || '').split(';')[0];
  const settingsRes = await app.fetch(
    new Request('http://localhost:3000/api/settings', {
      headers: {
        Host: 'localhost:3000',
        'X-Forwarded-Host': proxyHost,
        'X-Forwarded-Proto': 'http',
        Cookie: cookiePair,
      },
    }),
    env
  );
  assert.equal(settingsRes.status, 200);
});


