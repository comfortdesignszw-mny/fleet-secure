import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CACHE_KEYS,
  readCachedEntry,
  stripHeavyDriverDocuments,
  writeCachedEntry,
} from '../src/lib/offlineCache';
import {
  DEFAULT_PUSH_PREFERENCES,
  getPushPreferences,
  setPushPreferences,
} from '../src/lib/pushNotifications';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { checkAndNotifyOverdueHires } from '../src/server/notifications';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import {
  DRIVER_LICENCE_CODES,
  type DashboardData,
  type Driver,
  type NotificationRecord,
  type ReportPreviewData,
  type TripSummary,
  type Vehicle,
} from '../src/shared/types';

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

function harareDateOffset(daysOffset: number): string {
  const target = new Date(Date.now() + daysOffset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(target);
}

test('Driver licence_code CRUD, validation, search, inline Trip Out, and drivers report preview', async () => {
  const { env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  assert.deepEqual(DRIVER_LICENCE_CODES, [
    'Code A, A1/Class 3',
    'Code B, BE/Class 4',
    'Code C,CE/Class 2',
    'Code D, DE/Class 1',
  ]);

  // 1. Create driver with valid licence_code
  const createRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Kudzai Dube',
        phone: '+263771990001',
        licence_code: 'Code D, DE/Class 1',
      }),
    }),
    env
  );
  assert.equal(createRes.status, 201);
  const created = ((await createRes.json()) as { driver: Driver }).driver;
  assert.equal(created.licence_code, 'Code D, DE/Class 1');

  // 2. Reject invalid licence_code with 400
  const invalidRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Bad Code Driver',
        phone: '+263771990002',
        licence_code: 'Class Z Invalid',
      }),
    }),
    env
  );
  assert.equal(invalidRes.status, 400);

  // 3. PATCH updates licence_code
  const patchRes = await app.fetch(
    new Request(`http://localhost/api/drivers/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ licence_code: 'Code C,CE/Class 2' }),
    }),
    env
  );
  assert.equal(patchRes.status, 200);
  const patched = ((await patchRes.json()) as { driver: Driver }).driver;
  assert.equal(patched.licence_code, 'Code C,CE/Class 2');

  // 4. GET /api/drivers?q=... matches licence_code
  const searchRes = await app.fetch(
    new Request('http://localhost/api/drivers?q=Class%202', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(searchRes.status, 200);
  const searchBody = (await searchRes.json()) as { items: Driver[]; total: number };
  assert.equal(searchBody.total, 1);
  assert.equal(searchBody.items[0].id, created.id);
  assert.equal(searchBody.items[0].licence_code, 'Code C,CE/Class 2');

  // 5. Inline new_driver on POST /api/trips/out saves licence_code
  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 9901',
        vehicle_type: 'Truck',
        make_model: 'Isuzu NPR',
        condition: 'Good',
        last_known_mileage: 30000,
      }),
    }),
    env
  );
  const vehicle = ((await vRes.json()) as { vehicle: Vehicle }).vehicle;

  const tripRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: vehicle.id,
        new_driver: {
          full_name: 'Inline Code Driver',
          phone: '+263771990003',
          licence_code: 'Code A, A1/Class 3',
          save_to_directory: true,
        },
        destination: 'Graniteside',
        reason: 'Spare pickup',
        mileage_out: 30000,
        fuel_out: 'Full',
      }),
    }),
    env
  );
  assert.equal(tripRes.status, 201);

  // 6. Drivers report preview includes licence_code column and values
  const reportRes = await app.fetch(
    new Request('http://localhost/api/reports/preview?type=drivers', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(reportRes.status, 200);
  const preview = (await reportRes.json()) as ReportPreviewData;
  assert.ok(preview.columns.includes('licence_code'));
  assert.ok(preview.rows.some((r) => r.licence_code === 'Code C,CE/Class 2'));
  assert.ok(preview.rows.some((r) => r.licence_code === 'Code A, A1/Class 3'));
});

test('Hired vehicles notify on return due date AND separately once past due date without closing', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  const v1Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 9910',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 10000,
      }),
    }),
    env
  );
  const v1 = ((await v1Res.json()) as { vehicle: Vehicle }).vehicle;

  const v2Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 9911',
        vehicle_type: 'SUV',
        make_model: 'Toyota Hilux',
        condition: 'Good',
        last_known_mileage: 40000,
      }),
    }),
    env
  );
  const v2 = ((await v2Res.json()) as { vehicle: Vehicle }).vehicle;

  const d1Res = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Due Hire Driver',
        phone: '+263771991001',
      }),
    }),
    env
  );
  const d1 = ((await d1Res.json()) as { driver: Driver }).driver;

  const d2Res = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Overdue Hire Driver',
        phone: '+263771991002',
      }),
    }),
    env
  );
  const d2 = ((await d2Res.json()) as { driver: Driver }).driver;

  const today = harareDateOffset(0);
  const tomorrow = harareDateOffset(1);
  const twoDaysAgo = harareDateOffset(-2);

  // Trip 1: due today -> triggers HIRE_RETURN_DUE automatically on POST /api/trips/out
  const dueTripRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: d1.id,
        client_name: 'Client Due Today',
        days_hired: 1,
        expected_return_date: today,
        mileage_out: 10000,
        fuel_out: 'Full',
        opening_checklist_by: 'Guard A',
      }),
    }),
    env
  );
  assert.equal(dueTripRes.status, 201);
  const dueTrip = ((await dueTripRes.json()) as { trip: TripSummary }).trip;

  // Trip 2: booked for tomorrow (not yet due)
  const overdueTripRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v2.id,
        driver_id: d2.id,
        client_name: 'Client Past Due',
        days_hired: 3,
        expected_return_date: tomorrow,
        mileage_out: 40000,
        fuel_out: '3/4',
        opening_checklist_by: 'Guard B',
      }),
    }),
    env
  );
  assert.equal(overdueTripRes.status, 201);
  const overdueTrip = ((await overdueTripRes.json()) as { trip: TripSummary }).trip;

  // Initial scan: both already checked; Trip 2 not due yet -> 0 new alerts
  const scan0 = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(scan0.checked, 2);
  assert.equal(scan0.newlyNotified, 0);

  // Simulate Trip 2 reaching its due date (today) without closing -> triggers HIRE_RETURN_DUE
  await db
    .prepare('UPDATE trips SET expected_return_date = ? WHERE id = ?')
    .bind(today, overdueTrip.id)
    .run();
  const scanDue = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(scanDue.newlyNotified, 1);

  // Simulate Trip 2 passing its due date (2 days ago) without closing -> triggers HIRE_RETURN_OVERDUE
  await db
    .prepare('UPDATE trips SET expected_return_date = ? WHERE id = ?')
    .bind(twoDaysAgo, overdueTrip.id)
    .run();
  const scanOverdue = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(scanOverdue.newlyNotified, 1);

  // Repeat scan deduplicates cleanly
  const scanRepeat = await checkAndNotifyOverdueHires(db, { env });
  assert.equal(scanRepeat.newlyNotified, 0);

  // Check unread-count returns latestUnread array containing HIRE_RETURN_OVERDUE and HIRE_RETURN_DUE
  const unreadRes = await app.fetch(
    new Request('http://localhost/api/notifications/unread-count', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(unreadRes.status, 200);
  const unreadBody = (await unreadRes.json()) as {
    unreadCount: number;
    highUnreadCount: number;
    latestUnread: NotificationRecord[];
  };
  assert.ok(Array.isArray(unreadBody.latestUnread));
  assert.ok(
    unreadBody.latestUnread.some(
      (n) => n.trip_id === dueTrip.id && n.event_type === 'HIRE_RETURN_DUE' && n.priority === 'HIGH'
    )
  );
  assert.ok(
    unreadBody.latestUnread.some(
      (n) =>
        n.trip_id === overdueTrip.id &&
        n.event_type === 'HIRE_RETURN_OVERDUE' &&
        n.priority === 'HIGH'
    )
  );

  // GET /api/trips flags overdueTrip as is_return_overdue + OVERDUE flag
  const tripsRes = await app.fetch(
    new Request('http://localhost/api/trips?status=OPEN', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(tripsRes.status, 200);
  const tripsBody = (await tripsRes.json()) as { items: TripSummary[] };
  const overdueRow = tripsBody.items.find((t) => t.id === overdueTrip.id)!;
  const dueRow = tripsBody.items.find((t) => t.id === dueTrip.id)!;
  assert.equal(overdueRow.is_return_overdue, true);
  assert.equal(overdueRow.is_return_due, true);
  assert.ok(overdueRow.flags.some((f) => f.code === 'OVERDUE'));
  assert.equal(dueRow.is_return_due, true);
  assert.equal(dueRow.is_return_overdue, false);

  // Dashboard counts overdue_hires and exposes overdue flag
  const dashRes = await app.fetch(
    new Request('http://localhost/api/dashboard', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(dashRes.status, 200);
  const dash = (await dashRes.json()) as DashboardData;
  assert.ok(dash.cards.overdue_hires >= 1);
});

test('Push notification defaults are ON and offline cache stores timestamped snapshots without heavy blobs', () => {
  const mem = new MemoryStorage();
  const prevStorage = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  (globalThis as unknown as { localStorage: Storage }).localStorage = mem;
  try {
    assert.deepEqual(DEFAULT_PUSH_PREFERENCES, { pushEnabled: true, soundEnabled: true });
    assert.deepEqual(getPushPreferences(), { pushEnabled: true, soundEnabled: true });

    const updated = setPushPreferences({ soundEnabled: false });
    assert.deepEqual(updated, { pushEnabled: true, soundEnabled: false });
    assert.deepEqual(getPushPreferences(), { pushEnabled: true, soundEnabled: false });

    const driverWithBlob: Driver = {
      id: 1,
      full_name: 'Cached Driver',
      licence_number: 'ZW-CACHED-1',
      licence_code: 'Code B, BE/Class 4',
      phone: '+263771000001',
      address: 'Harare',
      licence_expiry: null,
      licence_document: 'data:application/pdf;base64,AAA',
      ddc_number: 'DDC-1',
      ddc_document: 'data:image/jpeg;base64,BBB',
      retest_cert_number: null,
      retest_document: null,
      medical_cert_number: null,
      medical_document: null,
      has_licence_document: true,
      has_ddc_document: true,
      has_retest_document: false,
      has_medical_document: false,
      licence_status: 'NONE',
      active: true,
      created_at: new Date().toISOString(),
      created_by: null,
      derived_status: 'Available',
      open_trip_id: null,
      days_to_expiry: null,
    };

    const stripped = stripHeavyDriverDocuments(driverWithBlob);
    assert.equal(stripped.licence_document, null);
    assert.equal(stripped.ddc_document, null);
    assert.equal(stripped.has_licence_document, true);
    assert.equal(stripped.licence_code, 'Code B, BE/Class 4');

    writeCachedEntry(CACHE_KEYS.driversAll, {
      items: [stripped],
      total: 1,
      expiringCount: 0,
    });
    const readBack = readCachedEntry<{ items: Driver[]; total: number }>(CACHE_KEYS.driversAll);
    assert.ok(readBack?.updatedAt);
    assert.equal(readBack?.data.items[0].full_name, 'Cached Driver');
  } finally {
    if (prevStorage) {
      (globalThis as unknown as { localStorage: Storage }).localStorage = prevStorage;
    } else {
      delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    }
  }
});
