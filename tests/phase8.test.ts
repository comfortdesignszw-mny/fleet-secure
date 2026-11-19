import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  enqueueOfflineEntry,
  flushOfflineQueue,
  getOfflineQueue,
} from '../src/lib/offlineQueue';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { ensureInitialSeed, resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv, D1DatabaseLike } from '../src/server/types';
import {
  formatDriverMissingDocsWarning,
  getDriverMissingDocuments,
  type Driver,
  type TripDetail,
  type TripFlag,
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

const SAMPLE_PDF_DATA_URL = 'data:application/pdf;base64,JVBERi0xLjQKJSB0ZXN0IHBkZg==';
const SAMPLE_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/';

test('Legacy drivers schema auto-migrates nullable licence_number and cert columns while preserving trips FK', async () => {
  resetSeedCacheForTests();
  const legacySchemaSql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('DRIVER','SUPERVISOR','ADMIN')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_number TEXT NOT NULL UNIQUE,
      vehicle_type TEXT NOT NULL,
      vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY','HEAVY')),
      make_model TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'Good',
      last_known_mileage INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      licence_number TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      licence_expiry TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_type TEXT NOT NULL CHECK (trip_type IN ('HIRE','ERRAND')),
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      driver_id INTEGER NOT NULL REFERENCES drivers(id),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
      client_name TEXT,
      destination TEXT,
      reason TEXT,
      days_hired INTEGER,
      expected_return_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;

  const db = new LocalD1Adapter(':memory:', legacySchemaSql);
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
  };

  await db
    .prepare(
      "INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model) VALUES ('AFX 1111', 'Sedan', 'ECONOMY', 'Toyota Corolla')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO drivers (full_name, licence_number, phone) VALUES ('Legacy Driver', 'ZW-LEG-1', '+263771000001')"
    )
    .run();
  await db
    .prepare(
      "INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name) VALUES ('HIRE', 1, 1, 'OPEN', 'Legacy Client')"
    )
    .run();

  await ensureInitialSeed(db, env);

  const tableInfo = await db.prepare('PRAGMA table_info(drivers)').all<{
    name: string;
    notnull: number;
  }>();
  const licenceCol = tableInfo.results.find((c) => c.name === 'licence_number');
  assert.ok(licenceCol);
  assert.equal(licenceCol.notnull, 0);

  for (const col of [
    'licence_document',
    'ddc_number',
    'ddc_document',
    'retest_cert_number',
    'retest_document',
    'medical_cert_number',
    'medical_document',
  ]) {
    assert.ok(tableInfo.results.some((c) => c.name === col), `Missing migrated column ${col}`);
  }

  // Existing trip + driver preserved intact
  const tripCount = await db.prepare('SELECT COUNT(*) as cnt FROM trips').first<{ cnt: number }>();
  assert.equal(tripCount?.cnt, 1);

  // Inserting a driver with NULL licence_number now succeeds cleanly
  await db
    .prepare('INSERT INTO drivers (full_name, licence_number, phone) VALUES (?, NULL, ?)')
    .bind('No Licence Driver', '+263771000002')
    .run();
});

test('Errand opening checklist is optional while Hire opening checklist remains required', async () => {
  const { env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 8801',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 20000,
      }),
    }),
    env
  );
  const v = ((await vRes.json()) as { vehicle: Vehicle }).vehicle;

  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Chipo Banda',
        phone: '+263771880100',
      }),
    }),
    env
  );
  const d = ((await dRes.json()) as { driver: Driver }).driver;

  // HIRE without opening_checklist_by -> 400
  const hireMissingChecklist = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v.id,
        driver_id: d.id,
        client_name: 'Client X',
        mileage_out: 20000,
        fuel_out: 'Full',
      }),
    }),
    env
  );
  assert.equal(hireMissingChecklist.status, 400);

  // ERRAND without opening_checklist_by -> 201 and stored cleanly as ''
  const errandNoChecklist = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: v.id,
        driver_id: d.id,
        destination: 'Msasa Depot',
        reason: 'Brake pads delivery',
        mileage_out: 20000,
        fuel_out: '3/4',
      }),
    }),
    env
  );
  assert.equal(errandNoChecklist.status, 201);
  const errandBody = (await errandNoChecklist.json()) as { trip: TripSummary };

  const detailRes = await app.fetch(
    new Request(`http://localhost/api/trips/${errandBody.trip.id}`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as TripDetail;
  assert.equal(detail.out.opening_checklist_by, '');
});

test('Drivers support optional docs, DDC/Retest/Medical certs, partial uniqueness, and Admin/Supervisor-only missing warnings', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'sup_doc', full_name: 'Sup Doc', role: 'SUPERVISOR', pin: '2222' }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv_doc', full_name: 'Drv Doc', role: 'DRIVER', pin: '3333' }),
    }),
    env
  );
  const supCookie = await loginAndChangePin(app, env, 'sup_doc', '2222', '2288');
  const drvCookie = await loginAndChangePin(app, env, 'drv_doc', '3333', '3388');

  // 1. Create two drivers without licence_number or certificates
  const createD1 = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Tinashe Ncube',
        phone: '+263771400001',
      }),
    }),
    env
  );
  assert.equal(createD1.status, 201);
  const d1 = ((await createD1.json()) as { driver: Driver }).driver;
  assert.equal(d1.licence_number, null);
  assert.ok(d1.missing_documents && d1.missing_documents.length === 4);

  const warningText = formatDriverMissingDocsWarning(d1.full_name, d1.missing_documents!);
  assert.ok(warningText.startsWith("Driver Tinashe Ncube's details are missing a critical document(s):"));

  const createD2 = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Blessing Sibanda',
        phone: '+263771400002',
        licence_number: 'ZW-DOC-100',
        ddc_number: 'DDC-901',
        ddc_document: SAMPLE_PDF_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(createD2.status, 201);

  // Duplicate non-empty licence number still rejected (409)
  const dupLic = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Duplicate Lic',
        phone: '+263771400003',
        licence_number: 'zw-doc-100',
      }),
    }),
    env
  );
  assert.equal(dupLic.status, 409);

  // 2. Role-gating on missing_documents & missingDocsCount
  const adminListRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: adminCookie } }),
    env
  );
  const adminList = (await adminListRes.json()) as { items: Driver[]; missingDocsCount?: number };
  assert.equal(adminList.missingDocsCount, 2);
  assert.ok(Array.isArray(adminList.items[0].missing_documents));

  const supListRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: supCookie } }),
    env
  );
  const supList = (await supListRes.json()) as { items: Driver[]; missingDocsCount?: number };
  assert.equal(supList.missingDocsCount, 2);
  assert.ok(Array.isArray(supList.items[0].missing_documents));

  const drvListRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: drvCookie } }),
    env
  );
  const drvList = (await drvListRes.json()) as { items: Driver[]; missingDocsCount?: number };
  assert.equal(drvList.missingDocsCount, undefined);
  assert.equal(drvList.items[0].missing_documents, undefined);

  // 3. Complete all docs on d1 via PATCH and check list vs detail vs audit redaction
  const patchD1 = await app.fetch(
    new Request(`http://localhost/api/drivers/${d1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        licence_number: 'ZW-FULL-01',
        licence_document: SAMPLE_JPEG_DATA_URL,
        ddc_number: 'DDC-01',
        ddc_document: SAMPLE_PDF_DATA_URL,
        retest_cert_number: 'RET-01',
        retest_document: SAMPLE_JPEG_DATA_URL,
        medical_cert_number: 'MED-01',
        medical_document: SAMPLE_PDF_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(patchD1.status, 200);
  const updatedD1 = ((await patchD1.json()) as { driver: Driver }).driver;
  assert.deepEqual(updatedD1.missing_documents, []);
  assert.equal(getDriverMissingDocuments(updatedD1).length, 0);

  // List omits raw data URLs while setting has_*_document = true
  const listAfterRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: adminCookie } }),
    env
  );
  const listAfter = (await listAfterRes.json()) as { items: Driver[]; missingDocsCount?: number };
  const d1FromList = listAfter.items.find((x) => x.id === d1.id)!;
  assert.equal(d1FromList.has_licence_document, true);
  assert.equal(d1FromList.has_ddc_document, true);
  assert.equal(d1FromList.has_retest_document, true);
  assert.equal(d1FromList.has_medical_document, true);
  assert.equal(d1FromList.licence_document, undefined);
  assert.equal(listAfter.missingDocsCount, 1); // Only d2 remains incomplete

  // Detail returns full documents for viewing/downloading, and omits missing_documents for DRIVER
  const adminDetailRes = await app.fetch(
    new Request(`http://localhost/api/drivers/${d1.id}`, { headers: { Cookie: adminCookie } }),
    env
  );
  const adminDetail = (await adminDetailRes.json()) as { driver: Driver };
  assert.equal(adminDetail.driver.licence_document, SAMPLE_JPEG_DATA_URL);
  assert.equal(adminDetail.driver.ddc_document, SAMPLE_PDF_DATA_URL);

  const drvDetailRes = await app.fetch(
    new Request(`http://localhost/api/drivers/${d1.id}`, { headers: { Cookie: drvCookie } }),
    env
  );
  const drvDetail = (await drvDetailRes.json()) as { driver: Driver };
  assert.equal(drvDetail.driver.missing_documents, undefined);

  // PATCH without document fields preserves existing documents
  const patchNoDocs = await app.fetch(
    new Request(`http://localhost/api/drivers/${d1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ phone: '+263771400099' }),
    }),
    env
  );
  assert.equal(patchNoDocs.status, 200);
  const preservedD1 = ((await patchNoDocs.json()) as { driver: Driver }).driver;
  assert.equal(preservedD1.has_licence_document, true);
  assert.equal(preservedD1.licence_document, SAMPLE_JPEG_DATA_URL);

  // Audit log must not dump base64 data URLs
  const auditRow = await db
    .prepare("SELECT new_json FROM audit_log WHERE entity = 'drivers' AND entity_id = ? ORDER BY id DESC LIMIT 1")
    .bind(String(d1.id))
    .first<{ new_json: string }>();
  assert.ok(auditRow?.new_json);
  assert.ok(!auditRow.new_json.includes('data:application/pdf;base64'));
  assert.ok(!auditRow.new_json.includes('data:image/jpeg;base64'));

  // 4. Inline new_driver during Trip Out works without licence_number and saves cert fields
  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AFX 8802',
        vehicle_type: 'SUV',
        make_model: 'Toyota Fortuner',
        condition: 'Good',
        last_known_mileage: 50000,
      }),
    }),
    env
  );
  const v = ((await vRes.json()) as { vehicle: Vehicle }).vehicle;

  const tripWithInlineDriver = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: v.id,
        new_driver: {
          full_name: 'Inline Cert Driver',
          phone: '+263779000111',
          ddc_number: 'DDC-INLINE-9',
          retest_cert_number: 'RET-INLINE-9',
          medical_cert_number: 'MED-INLINE-9',
          medical_document: SAMPLE_PDF_DATA_URL,
          save_to_directory: true,
        },
        destination: 'Borrowdale',
        reason: 'Documents drop',
        mileage_out: 50000,
        fuel_out: 'Full',
      }),
    }),
    env
  );
  assert.equal(tripWithInlineDriver.status, 201);
});

test('Extended offline queue supports DRIVER_CREATE, VEHICLE_CREATE, OUT, and IN entries and retains only failed items', async () => {
  const storage = new MemoryStorage();

  enqueueOfflineEntry(
    {
      kind: 'DRIVER_CREATE',
      summaryLabel: 'New Driver · Tapiwa Moyo',
      payload: {
        full_name: 'Tapiwa Moyo',
        phone: '+263771555111',
        ddc_number: 'DDC-555',
      },
    },
    storage
  );
  enqueueOfflineEntry(
    {
      kind: 'VEHICLE_CREATE',
      summaryLabel: 'New Vehicle · AFZ 5555',
      payload: {
        reg_number: 'AFZ 5555',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 12000,
      },
    },
    storage
  );
  enqueueOfflineEntry(
    {
      kind: 'OUT',
      summaryLabel: 'Errand Out · AFZ 5555',
      payload: {
        trip_type: 'ERRAND',
        vehicle_id: 1,
        driver_id: 1,
        destination: 'Yard B',
        reason: 'Dispatch',
        mileage_out: 12000,
        fuel_out: 'Full',
        device_time: new Date().toISOString(),
      },
    },
    storage
  );
  enqueueOfflineEntry(
    {
      kind: 'IN',
      summaryLabel: 'Errand Return · AFZ 5555',
      payload: {
        trip_id: 99,
        mileage_in: 12040,
        fuel_in: 'Full-',
        closing_checklist_by: 'Guard A',
        device_time: new Date().toISOString(),
      },
    },
    storage
  );

  assert.equal(getOfflineQueue(storage).length, 4);

  const calls: string[] = [];
  const partialRes = await flushOfflineQueue(
    {
      createDriver: async (payload) => {
        calls.push(`DRIVER:${payload.full_name}`);
        return { driver: {} as Driver };
      },
      createVehicle: async (payload) => {
        calls.push(`VEHICLE:${payload.reg_number}`);
        return { vehicle: {} as Vehicle };
      },
      sendOut: async (payload) => {
        calls.push(`OUT:${payload.destination}`);
        return { trip: { id: 1 } as TripSummary, flags: [] as TripFlag[] };
      },
      sendIn: async () => {
        throw new Error('Temporary server timeout');
      },
    },
    storage
  );

  assert.deepEqual(calls, ['DRIVER:Tapiwa Moyo', 'VEHICLE:AFZ 5555', 'OUT:Yard B']);
  assert.equal(partialRes.syncedCount, 3);
  assert.equal(partialRes.failedCount, 1);
  assert.equal(getOfflineQueue(storage).length, 1);
  assert.equal(getOfflineQueue(storage)[0].kind, 'IN');
  assert.equal(getOfflineQueue(storage)[0].lastError, 'Temporary server timeout');
});

test('Cloudflare D1 FK block on DROP TABLE drivers still adds doc columns, loads enrolled drivers, and supports optional licence + doc uploads', async () => {
  resetSeedCacheForTests();
  const legacySchemaSql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('DRIVER','SUPERVISOR','ADMIN')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_number TEXT NOT NULL UNIQUE,
      vehicle_type TEXT NOT NULL,
      vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY','HEAVY')),
      make_model TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'Good',
      last_known_mileage INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      licence_number TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      licence_expiry TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_type TEXT NOT NULL CHECK (trip_type IN ('HIRE','ERRAND')),
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      driver_id INTEGER NOT NULL REFERENCES drivers(id),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
      client_name TEXT,
      destination TEXT,
      reason TEXT,
      days_hired INTEGER,
      expected_return_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;

  const innerDb = new LocalD1Adapter(':memory:', legacySchemaSql);
  await innerDb
    .prepare(
      "INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model) VALUES ('AFX 7777', 'Sedan', 'ECONOMY', 'Honda Fit')"
    )
    .run();
  await innerDb
    .prepare(
      "INSERT INTO drivers (full_name, licence_number, phone) VALUES ('Enrolled Legacy Driver', 'ZW-OLD-99', '+263772000001')"
    )
    .run();
  await innerDb
    .prepare(
      "INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name) VALUES ('HIRE', 1, 1, 'OPEN', 'Acme Corp')"
    )
    .run();

  // Simulate Cloudflare D1 ignoring PRAGMA foreign_keys = OFF on DROP TABLE drivers
  const d1SimulatedDb: D1DatabaseLike = {
    prepare: (q: string) => innerDb.prepare(q),
    exec: async (q: string) => {
      if (/DROP\s+TABLE\s+drivers\b/i.test(q)) {
        throw new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT');
      }
      return innerDb.exec(q);
    },
  };

  const env: AppEnv = {
    DB: d1SimulatedDb,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
  };

  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // 1. Enrolled legacy driver must load cleanly with 200 (not 500 Server error)
  const listRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as { items: Driver[]; total: number };
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0].full_name, 'Enrolled Legacy Driver');
  assert.equal(listBody.items[0].licence_number, 'ZW-OLD-99');

  // 2. Two new drivers WITHOUT licence_number must save cleanly via sentinel fallback (even with NOT NULL UNIQUE)
  const createA = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'No Licence Alpha',
        phone: '+263772000002',
        ddc_number: 'DDC-A1',
        ddc_document: SAMPLE_PDF_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(createA.status, 201);
  const driverA = ((await createA.json()) as { driver: Driver }).driver;
  assert.equal(driverA.licence_number, null);
  assert.equal(driverA.has_ddc_document, true);

  const createB = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'No Licence Beta',
        phone: '+263772000003',
        medical_document: SAMPLE_JPEG_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(createB.status, 201);
  const driverB = ((await createB.json()) as { driver: Driver }).driver;
  assert.equal(driverB.licence_number, null);

  // 3. PATCH without licence_number preserves null externally and attaches new document cleanly
  const patchA = await app.fetch(
    new Request(`http://localhost/api/drivers/${driverA.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        licence_number: null,
        retest_cert_number: 'RET-A1',
        retest_document: SAMPLE_JPEG_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(patchA.status, 200);
  const patchedA = ((await patchA.json()) as { driver: Driver }).driver;
  assert.equal(patchedA.licence_number, null);
  assert.equal(patchedA.ddc_document, SAMPLE_PDF_DATA_URL);
  assert.equal(patchedA.retest_document, SAMPLE_JPEG_DATA_URL);

  // 4. Oversized >1 MB document upload returns clean 400 JSON error (never 500)
  const oversizedPdf = `data:application/pdf;base64,${'A'.repeat(1_050_000)}`;
  const oversizeRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Oversize Doc Driver',
        phone: '+263772000004',
        licence_document: oversizedPdf,
      }),
    }),
    env
  );
  assert.equal(oversizeRes.status, 400);
  const oversizeJson = (await oversizeRes.json()) as { error: string };
  assert.match(oversizeJson.error, /too large/i);
});

