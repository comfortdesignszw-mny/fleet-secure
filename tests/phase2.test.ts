import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { computeLicenceExpiryStatus } from '../src/server/directories';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type { Driver, Vehicle } from '../src/shared/types';

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

async function loginAndChangePin(
  app: ReturnType<typeof createApp>,
  env: AppEnv,
  username: string,
  pin: string,
  newPin: string
): Promise<string> {
  const loginRes = await app.fetch(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, pin }),
    }),
    env
  );
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  const changeRes = await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPin: pin, newPin }),
    }),
    env
  );
  assert.equal(changeRes.status, 200);
  return cookie;
}

test('Licence expiry warning classifies OK, EXPIRING_SOON, and EXPIRED', () => {
  const refDate = new Date('2026-06-01T10:00:00Z');
  assert.equal(computeLicenceExpiryStatus('2026-06-20', refDate).licence_status, 'EXPIRING_SOON');
  assert.equal(computeLicenceExpiryStatus('2026-06-20', refDate).days_to_expiry, 19);
  assert.equal(computeLicenceExpiryStatus('2026-05-25', refDate).licence_status, 'EXPIRED');
  assert.equal(computeLicenceExpiryStatus('2026-09-01', refDate).licence_status, 'OK');
  assert.equal(computeLicenceExpiryStatus(null, refDate).licence_status, 'NONE');
});

test('Vehicles and Drivers CRUD, auto class mapping, derived status, and RBAC', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create Supervisor and Driver accounts
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'sup1',
        full_name: 'Loss Control Sup',
        role: 'SUPERVISOR',
        pin: '2222',
      }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'drv1',
        full_name: 'Yard Driver',
        role: 'DRIVER',
        pin: '3333',
      }),
    }),
    env
  );

  const supCookie = await loginAndChangePin(app, env, 'sup1', '2222', '2299');
  const drvCookie = await loginAndChangePin(app, env, 'drv1', '3333', '3399');

  // 1. Driver cannot create a vehicle or driver (403)
  const drvCreateVeh = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        reg_number: 'AFX 9999',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 10000,
      }),
    }),
    env
  );
  assert.equal(drvCreateVeh.status, 403);

  const drvCreateDriver = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        full_name: 'New Driver',
        licence_number: 'ZW-99999',
        phone: '+26377111222',
        address: 'Harare',
        licence_expiry: null,
      }),
    }),
    env
  );
  assert.equal(drvCreateDriver.status, 403);

  // 2. Supervisor creates vehicles -> auto maps ECONOMY vs HEAVY
  const createSedan = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'afx 1001',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Very Good',
        last_known_mileage: 25000,
      }),
    }),
    env
  );
  assert.equal(createSedan.status, 201);
  const sedanData = (await createSedan.json()) as { vehicle: Vehicle };
  assert.equal(sedanData.vehicle.reg_number, 'AFX 1001');
  assert.equal(sedanData.vehicle.vehicle_class, 'ECONOMY');
  assert.equal(sedanData.vehicle.derived_status, 'Available');

  const createHilux = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'AFX 2002',
        vehicle_type: 'Double Cab',
        make_model: 'Toyota Hilux',
        condition: 'Good',
        last_known_mileage: 80000,
      }),
    }),
    env
  );
  assert.equal(createHilux.status, 201);
  const hiluxData = (await createHilux.json()) as { vehicle: Vehicle };
  assert.equal(hiluxData.vehicle.vehicle_class, 'HEAVY');

  // 3. Supervisor updates condition -> logs VEHICLE_CONDITION_CHANGED + notification
  const condPatch = await app.fetch(
    new Request(`http://localhost/api/vehicles/${hiluxData.vehicle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({ condition: 'Grounded' }),
    }),
    env
  );
  assert.equal(condPatch.status, 200);
  const condAudit = await db
    .prepare("SELECT action FROM audit_log WHERE entity = 'vehicles' AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .bind(String(hiluxData.vehicle.id))
    .first<{ action: string }>();
  assert.equal(condAudit?.action, 'VEHICLE_CONDITION_CHANGED');

  const highNotif = await db
    .prepare("SELECT priority FROM notifications WHERE event_type = 'VEHICLE_CONDITION_CHANGED' LIMIT 1")
    .first<{ priority: string }>();
  assert.equal(highNotif?.priority, 'HIGH');

  // 4. Supervisor creates Driver with soon-to-expire licence
  const soonDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const createDrv = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Tendai Moyo',
        licence_number: 'zw-12345',
        phone: '+26377123456',
        address: '10 First St',
        licence_expiry: soonDate,
      }),
    }),
    env
  );
  assert.equal(createDrv.status, 201);
  const drvPayload = (await createDrv.json()) as { driver: Driver };
  assert.equal(drvPayload.driver.licence_status, 'EXPIRING_SOON');
  assert.equal(drvPayload.driver.derived_status, 'Available');

  // 5. Simulate an OPEN HIRE trip in DB -> verify derived status switches to "Out on Hire"
  await db
    .prepare(
      `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name)
       VALUES ('HIRE', ?, ?, 'OPEN', 'Acme Client')`
    )
    .bind(sedanData.vehicle.id, drvPayload.driver.id)
    .run();

  const vehListRes = await app.fetch(
    new Request('http://localhost/api/vehicles', { headers: { Cookie: drvCookie } }),
    env
  );
  assert.equal(vehListRes.status, 200);
  const vehList = (await vehListRes.json()) as { items: Vehicle[] };
  const updatedSedan = vehList.items.find((v) => v.id === sedanData.vehicle.id);
  assert.equal(updatedSedan?.derived_status, 'Out on Hire');

  const drvListRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: drvCookie } }),
    env
  );
  const drvList = (await drvListRes.json()) as { items: Driver[]; expiringCount: number };
  assert.equal(drvList.expiringCount, 1);
  assert.equal(drvList.items[0].derived_status, 'Out on Hire');
});
