import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  enqueueOfflineEntry,
  flushOfflineQueue,
  getOfflineQueue,
  removeOfflineEntry,
} from '../src/lib/offlineQueue';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type { TripDetail, TripFlag, TripSummary } from '../src/shared/types';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

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

  await app.fetch(
    new Request('http://localhost/api/auth/change-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPin: pin, newPin }),
    }),
    env
  );
  return cookie;
}

test('Offline submission queue preserves device_time, syncs to backend, and flags OFFLINE_DELAY when > 10 minutes late', async () => {
  const { env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv_off', full_name: 'Yard Driver', role: 'DRIVER', pin: '1111' }),
    }),
    env
  );
  const drvCookie = await loginAndChangePin(app, env, 'drv_off', '1111', '1155');

  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 3030',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 12000,
      }),
    }),
    env
  );
  const vehicle = ((await vRes.json()) as { vehicle: { id: number } }).vehicle;

  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Kudzai Phiri',
        licence_number: 'ZW-3030',
        phone: '+263771303030',
        address: 'Harare',
        licence_expiry: '2029-12-31',
      }),
    }),
    env
  );
  const driver = ((await dRes.json()) as { driver: { id: number } }).driver;

  const storage = new MemoryStorage();
  const capturedDeviceTime = new Date(Date.now() - 25 * 60_000).toISOString(); // 25 minutes ago

  const queued = enqueueOfflineEntry(
    {
      kind: 'OUT',
      summaryLabel: 'Hire Out · AFX 3030 (Kudzai Phiri)',
      createdAtDevice: capturedDeviceTime,
      payload: {
        trip_type: 'HIRE',
        vehicle_id: vehicle.id,
        driver_id: driver.id,
        client_name: 'Offline Client Co',
        mileage_out: 12000,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
        notes: 'Recorded with zero yard signal',
        device_time: capturedDeviceTime,
      },
    },
    storage
  );

  assert.equal(getOfflineQueue(storage).length, 1);

  // Flush queue against live Hono API
  const syncResult = await flushOfflineQueue(
    {
      sendOut: async (payload) => {
        const res = await app.fetch(
          new Request('http://localhost/api/trips/out', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
            body: JSON.stringify(payload),
          }),
          env
        );
        assert.equal(res.status, 201);
        return (await res.json()) as { trip: TripSummary; flags: TripFlag[] };
      },
      sendIn: async () => {
        throw new Error('Not expected');
      },
    },
    storage
  );

  assert.equal(syncResult.syncedCount, 1);
  assert.equal(syncResult.failedCount, 0);
  assert.equal(getOfflineQueue(storage).length, 0);
  assert.ok(syncResult.lastFlags.some((f) => f.code === 'OFFLINE_DELAY'));

  // Verify stored trip_out recorded both device_time and server received_at
  const detailRes = await app.fetch(
    new Request(`http://localhost/api/trips/${syncResult.lastTrip!.id}`, {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  const detail = (await detailRes.json()) as TripDetail;
  assert.equal(detail.out.device_time, capturedDeviceTime);
  assert.ok(new Date(detail.out.received_at).getTime() > new Date(capturedDeviceTime).getTime());

  // Failed items stay queued with lastError and can be discarded cleanly
  const badEntry = enqueueOfflineEntry(
    {
      kind: 'IN',
      summaryLabel: 'Broken return',
      payload: {
        trip_id: 999999,
        mileage_in: 12100,
        fuel_in: '3/4',
        closing_checklist_by: 'Yard Driver',
        device_time: new Date().toISOString(),
      },
    },
    storage
  );

  const failSync = await flushOfflineQueue(
    {
      sendOut: async () => {
        throw new Error('Not expected');
      },
      sendIn: async () => {
        throw new Error('Trip record not found.');
      },
    },
    storage
  );

  assert.equal(failSync.failedCount, 1);
  assert.equal(getOfflineQueue(storage).length, 1);
  assert.equal(getOfflineQueue(storage)[0].lastError, 'Trip record not found.');

  removeOfflineEntry(badEntry.id, storage);
  assert.equal(getOfflineQueue(storage).length, 0);
  assert.ok(queued.id);
});
