import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { recordAudit, verifyAuditChain } from '../src/server/audit';
import { hashPin, signSession, verifyPin, verifySession } from '../src/server/crypto';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';

function createTestEnv(): { db: LocalD1Adapter; env: AppEnv } {
  resetSeedCacheForTests();
  const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const db = new LocalD1Adapter(':memory:', schemaSql);
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
  };
  return { db, env };
}

test('PBKDF2 PIN hashing and verification', async () => {
  const hash = await hashPin('8472');
  assert.ok(hash.startsWith('pbkdf2_sha256$100000$'));
  assert.equal(await verifyPin('8472', hash), true);
  assert.equal(await verifyPin('0000', hash), false);
});

test('HMAC-SHA256 session signing and verification', async () => {
  const secret = 'test-secret-value-123456';
  const token = await signSession({ id: 7, username: 'supervisor1', role: 'SUPERVISOR' }, secret);
  const parsed = await verifySession(token, secret);
  assert.ok(parsed);
  assert.equal(parsed.uid, 7);
  assert.equal(parsed.role, 'SUPERVISOR');

  const tampered = token.slice(0, -4) + 'XXXX';
  assert.equal(await verifySession(tampered, secret), null);
});

test('Audit hash chain detects tampering', async () => {
  const { db } = createTestEnv();

  await recordAudit(db, {
    userId: null,
    username: 'system',
    userRole: 'SYSTEM',
    action: 'ROW_ONE',
    entity: 'settings',
    entityId: '1',
    newValue: { ok: true },
  });

  await recordAudit(db, {
    userId: null,
    username: 'admin',
    userRole: 'ADMIN',
    action: 'ROW_TWO',
    entity: 'users',
    entityId: '2',
    newValue: { role: 'DRIVER' },
  });

  const valid = await verifyAuditChain(db);
  assert.equal(valid.ok, true);
  assert.equal(valid.totalRows, 2);

  // Tamper directly with row 1 in SQLite
  db.raw.prepare(`UPDATE audit_log SET action = 'TAMPERED' WHERE id = 1`).run();

  const broken = await verifyAuditChain(db);
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenRowId, 1);
});

test('Auth flow, forced PIN change, RBAC, and login lockout', async () => {
  const { env } = createTestEnv();
  const app = createApp();

  // 1. Login as seeded admin
  const loginRes = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', pin: '1234' }),
    }),
    env
  );
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const cookiePair = setCookie.split(';')[0];
  assert.ok(cookiePair.startsWith('fleet_session='));

  const loginBody = (await loginRes.json()) as { user: { must_change_pin: boolean } };
  assert.equal(loginBody.user.must_change_pin, true);

  // 2. Blocked from settings until initial PIN is changed
  const blockedRes = await app.fetch(
    new Request('http://localhost/api/settings', {
      headers: { Cookie: cookiePair },
    }),
    env
  );
  assert.equal(blockedRes.status, 403);

  // 3. Change PIN
  const changeRes = await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({ currentPin: '1234', newPin: '9876' }),
    }),
    env
  );
  assert.equal(changeRes.status, 200);

  // 4. Create a DRIVER user as Admin
  const createDriverRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookiePair },
      body: JSON.stringify({
        username: 'driver1',
        full_name: 'Tariro Dube',
        role: 'DRIVER',
        pin: '4455',
      }),
    }),
    env
  );
  assert.equal(createDriverRes.status, 201);

  // 5. Sign in as DRIVER, change PIN, and verify Driver cannot access Audit Log or Users
  const driverLogin = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'driver1', pin: '4455' }),
    }),
    env
  );
  assert.equal(driverLogin.status, 200);
  const driverCookie = (driverLogin.headers.get('set-cookie') || '').split(';')[0];

  await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: driverCookie },
      body: JSON.stringify({ currentPin: '4455', newPin: '5566' }),
    }),
    env
  );

  const driverAuditRes = await app.fetch(
    new Request('http://localhost/api/audit-log', {
      headers: { Cookie: driverCookie },
    }),
    env
  );
  assert.equal(driverAuditRes.status, 403);

  const driverUsersRes = await app.fetch(
    new Request('http://localhost/api/users', {
      headers: { Cookie: driverCookie },
    }),
    env
  );
  assert.equal(driverUsersRes.status, 403);

  // 6. Rate-limit lockout after 5 wrong PIN attempts
  for (let i = 0; i < 4; i++) {
    const fail = await app.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'driver1', pin: '0000' }),
      }),
      env
    );
    assert.equal(fail.status, 401);
  }
  const locked = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'driver1', pin: '0000' }),
    }),
    env
  );
  assert.equal(locked.status, 429);

  // 7. Admin verifies the entire audit chain is intact
  const verifyRes = await app.fetch(
    new Request('http://localhost/api/audit-log/verify', {
      method: 'POST',
      headers: { Cookie: cookiePair },
    }),
    env
  );
  assert.equal(verifyRes.status, 200);
  const verifyData = (await verifyRes.json()) as { result: { ok: boolean; totalRows: number } };
  assert.equal(verifyData.result.ok, true);
  assert.ok(verifyData.result.totalRows >= 5);
});
