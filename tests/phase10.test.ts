import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { hashPin } from '../src/server/crypto';
import { LocalD1Adapter } from '../src/server/local-d1';
import { ensureInitialSeed, resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import {
  getDriverMissingDocuments,
  type Driver,
  type FleetMaintenanceOverview,
  type GarageVisit,
  type PartsPurchaseRequest,
  type Vehicle,
} from '../src/shared/types';

const SAMPLE_PDF_DATA_URL =
  'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%Quotation\n%%EOF').toString('base64');

function createTestEnv(customSchemaSql?: string): { db: LocalD1Adapter; env: AppEnv } {
  resetSeedCacheForTests();
  const schemaSql =
    customSchemaSql ?? fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
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
  const data = (await loginRes.json()) as { user: { must_change_pin: boolean } };
  if (data.user.must_change_pin) {
    const chRes = await app.fetch(
      new Request('http://localhost/api/auth/change-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ currentPin: pin, newPin }),
      }),
      env
    );
    assert.equal(chRes.status, 200);
    const updatedCookie = (chRes.headers.get('set-cookie') || '').split(';')[0];
    return updatedCookie || cookie;
  }
  return cookie;
}

test('Driver missing warnings only fire for Driver Licence (DDC, Retest, Medical are optional)', () => {
  const completeLicence = getDriverMissingDocuments({
    licence_number: 'ZW-90001',
    has_licence_document: true,
    ddc_number: null,
    has_ddc_document: false,
    retest_cert_number: null,
    has_retest_document: false,
    medical_cert_number: null,
    has_medical_document: false,
  });
  assert.deepEqual(completeLicence, []);

  const missingCopyOnly = getDriverMissingDocuments({
    licence_number: 'ZW-90002',
    has_licence_document: false,
  });
  assert.deepEqual(missingCopyOnly, ["Driver's Licence Copy (PDF/Image)"]);

  const missingNumOnly = getDriverMissingDocuments({
    licence_number: null,
    has_licence_document: true,
  });
  assert.deepEqual(missingNumOnly, ["Driver's Licence Number"]);

  const missingBoth = getDriverMissingDocuments({
    licence_number: null,
    has_licence_document: false,
  });
  assert.deepEqual(missingBoth, ["Driver's Licence (Number & Copy)"]);
});

test('Existing legacy users table migrates cleanly to allow FLEET_MANAGER role', async () => {
  const legacySchema = `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'ADMIN')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      must_change_pin INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_number TEXT NOT NULL UNIQUE,
      vehicle_type TEXT NOT NULL,
      vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY', 'HEAVY')),
      make_model TEXT NOT NULL,
      condition TEXT NOT NULL,
      last_known_mileage INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `;
  const { db, env } = createTestEnv(legacySchema);

  await ensureInitialSeed(db, env);

  const schemaRow = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .first<{ sql: string }>();
  assert.ok(schemaRow?.sql.includes('FLEET_MANAGER'));

  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');
  const createFmRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'fm_legacy',
        full_name: 'Legacy Fleet Manager',
        role: 'FLEET_MANAGER',
        pin: '4444',
      }),
    }),
    env
  );
  assert.equal(createFmRes.status, 201);
});

test('FLEET_MANAGER RBAC, Grounding authorization, Maintenance logs, Garage Visits, and Parts Purchase approval workflow', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  await Promise.all([
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'fm1',
          full_name: 'Fleet Manager Sam',
          role: 'FLEET_MANAGER',
          pin: '4444',
        }),
      }),
      env
    ),
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'sup1',
          full_name: 'Supervisor Ruth',
          role: 'SUPERVISOR',
          pin: '2222',
        }),
      }),
      env
    ),
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'drv1',
          full_name: 'Driver Joe',
          role: 'DRIVER',
          pin: '3333',
        }),
      }),
      env
    ),
  ]);

  const fmCookie = await loginAndChangePin(app, env, 'fm1', '4444', '4488');
  const supCookie = await loginAndChangePin(app, env, 'sup1', '2222', '2288');
  const drvCookie = await loginAndChangePin(app, env, 'drv1', '3333', '3388');

  // 1. FLEET_MANAGER cannot modify Drivers, Settings, or Staff Users (403)
  const fmCreateDriver = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ full_name: 'Blocked Driver', phone: '+26377000111' }),
    }),
    env
  );
  assert.equal(fmCreateDriver.status, 403);

  const fmUpdateSettings = await app.fetch(
    new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ company_name: 'Hacked' }),
    }),
    env
  );
  assert.equal(fmUpdateSettings.status, 403);

  const fmCreateUser = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ username: 'x', full_name: 'X', role: 'DRIVER', pin: '1234' }),
    }),
    env
  );
  assert.equal(fmCreateUser.status, 403);

  // Driver with complete Licence (number + copy) and NO DDC/Retest/Medical has zero missing_documents
  const drvCompleteLicRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Peter Moyo',
        phone: '+263771234567',
        licence_number: 'ZW-55511',
        licence_document: SAMPLE_PDF_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(drvCompleteLicRes.status, 201);
  const drvCompleteLic = ((await drvCompleteLicRes.json()) as { driver: Driver }).driver;
  assert.deepEqual(drvCompleteLic.missing_documents, []);

  // 2. FLEET_MANAGER has full access to Vehicle Directory & Grounding workflow
  const fmCreateVeh = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        reg_number: 'FMX 101',
        vehicle_type: 'Double Cab',
        make_model: 'Toyota Hilux',
        condition: 'Good',
        last_known_mileage: 120000,
        next_service_due_km: 120800,
      }),
    }),
    env
  );
  assert.equal(fmCreateVeh.status, 201);
  const veh = ((await fmCreateVeh.json()) as { vehicle: Vehicle }).vehicle;
  assert.equal(veh.next_service_due_km, 120800);

  // SUPERVISOR is blocked from marking vehicle Grounded (403)
  const supGroundAttempt = await app.fetch(
    new Request(`http://localhost/api/vehicles/${veh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({ condition: 'Grounded' }),
    }),
    env
  );
  assert.equal(supGroundAttempt.status, 403);

  // SUPERVISOR is blocked from changing next_service_due_km (403)
  const supNextServiceAttempt = await app.fetch(
    new Request(`http://localhost/api/vehicles/${veh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({ next_service_due_km: 130000 }),
    }),
    env
  );
  assert.equal(supNextServiceAttempt.status, 403);

  // FLEET_MANAGER can mark vehicle Grounded (200)
  const fmGround = await app.fetch(
    new Request(`http://localhost/api/vehicles/${veh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ condition: 'Grounded' }),
    }),
    env
  );
  assert.equal(fmGround.status, 200);

  // SUPERVISOR cannot return Grounded vehicle back to Good / active service (403)
  const supRestoreAttempt = await app.fetch(
    new Request(`http://localhost/api/vehicles/${veh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({ condition: 'Good' }),
    }),
    env
  );
  assert.equal(supRestoreAttempt.status, 403);

  // FLEET_MANAGER can authorise changing Grounded -> Very Good (200)
  const fmRestore = await app.fetch(
    new Request(`http://localhost/api/vehicles/${veh.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ condition: 'Very Good' }),
    }),
    env
  );
  assert.equal(fmRestore.status, 200);

  // 3. Mechanical / Service History & Next Service Due km
  const supLogAttempt = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        vehicle_id: veh.id,
        record_type: 'SERVICE',
        service_date: '2026-11-25',
        odometer_km: 120000,
        summary: 'Blocked attempt',
      }),
    }),
    env
  );
  assert.equal(supLogAttempt.status, 403);

  const fmLogRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        vehicle_id: veh.id,
        record_type: 'SERVICE',
        service_date: '2026-11-25',
        odometer_km: 120000,
        summary: '120k km Full Service & Oil Change',
        details: 'Replaced oil, fuel & air filters',
        workshop_name: 'In-House Garage',
        cost: 185.5,
        next_service_due_km: 130000,
      }),
    }),
    env
  );
  assert.equal(fmLogRes.status, 201);

  // 4. Garage Visits: Fleet Manager requests -> Admin approves -> Fleet Manager updates status
  const fmGarageRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/garage-visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        vehicle_id: veh.id,
        visit_date: '2026-11-26',
        workshop_name: 'Harare Suspension Centre',
        reason: 'Front shock absorbers replacement',
        odometer_km: 120000,
        estimated_cost: 340,
      }),
    }),
    env
  );
  assert.equal(fmGarageRes.status, 201);
  const visit = ((await fmGarageRes.json()) as { visit: GarageVisit }).visit;
  assert.equal(visit.approval_status, 'PENDING_APPROVAL');

  const earlyInGarage = await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visit.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ visit_status: 'IN_GARAGE' }),
    }),
    env
  );
  assert.equal(earlyInGarage.status, 400);

  const fmSelfApproveGarage = await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visit.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ decision: 'APPROVED' }),
    }),
    env
  );
  assert.equal(fmSelfApproveGarage.status, 403);

  const adminApproveGarage = await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visit.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ decision: 'APPROVED', approval_notes: 'Approved for workshop' }),
    }),
    env
  );
  assert.equal(adminApproveGarage.status, 200);

  const fmMarkInGarage = await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visit.id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ visit_status: 'IN_GARAGE' }),
    }),
    env
  );
  assert.equal(fmMarkInGarage.status, 200);

  // 5. Parts & Service Kits Purchase Form (fork new vehicle inline + attach quotation)
  const fmPartsRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/parts-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        request_date: '2026-11-25',
        new_vehicle: {
          reg_number: 'NEW 777',
          vehicle_type: 'SUV',
          make_model: 'Toyota Fortuner',
          condition: 'Needs Little Attention',
          last_known_mileage: 95000,
        },
        parts_required: 'Full Service Kit + Rear Brake Pads',
        is_full_service_kit: true,
        date_required: '2026-11-28',
        estimated_amount: 420.75,
        quotation_file: SAMPLE_PDF_DATA_URL,
        quotation_filename: 'fortuner-quote.pdf',
      }),
    }),
    env
  );
  assert.equal(fmPartsRes.status, 201);
  const partsCreated = (await fmPartsRes.json()) as {
    request: PartsPurchaseRequest;
    createdVehicle?: Vehicle;
  };
  assert.equal(partsCreated.request.status, 'PENDING_ADMIN_AUTHORIZATION');
  assert.equal(partsCreated.request.has_quotation_file, true);
  assert.equal(partsCreated.createdVehicle?.reg_number, 'NEW 777');

  const fmSelfAuthParts = await app.fetch(
    new Request(
      `http://localhost/api/fleet-maintenance/parts-requests/${partsCreated.request.id}/decision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
        body: JSON.stringify({ decision: 'APPROVED' }),
      }
    ),
    env
  );
  assert.equal(fmSelfAuthParts.status, 403);

  const adminAuthParts = await app.fetch(
    new Request(
      `http://localhost/api/fleet-maintenance/parts-requests/${partsCreated.request.id}/decision`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({ decision: 'APPROVED', admin_notes: 'PO #2026-88 issued' }),
      }
    ),
    env
  );
  assert.equal(adminAuthParts.status, 200);

  // Overview is readable (read-only) by DRIVER and SUPERVISOR, and omits base64 quotation blobs
  const drvOverviewRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/overview', {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  assert.equal(drvOverviewRes.status, 200);
  const drvOverview = (await drvOverviewRes.json()) as FleetMaintenanceOverview;
  assert.equal(drvOverview.partsRequests.length, 1);
  assert.equal(drvOverview.partsRequests[0].quotation_file, undefined);
  assert.equal(drvOverview.partsRequests[0].has_quotation_file, true);
  assert.equal(
    drvOverview.serviceDues.find((s) => s.vehicle_id === veh.id)?.next_service_due_km,
    130000
  );

  // Quotation endpoint serves the PDF file
  const quotRes = await app.fetch(
    new Request(
      `http://localhost/api/fleet-maintenance/parts-requests/${partsCreated.request.id}/quotation`,
      { headers: { Cookie: adminCookie } }
    ),
    env
  );
  assert.equal(quotRes.status, 200);
  const quotJson = (await quotRes.json()) as { quotation_file: string; quotation_filename: string };
  assert.equal(quotJson.quotation_file, SAMPLE_PDF_DATA_URL);
  assert.equal(quotJson.quotation_filename, 'fortuner-quote.pdf');

  // Audit log never stores raw base64 quotation data
  const partsAudit = await db
    .prepare(
      "SELECT new_json FROM audit_log WHERE action = 'PARTS_PURCHASE_REQUESTED' ORDER BY id DESC LIMIT 1"
    )
    .first<{ new_json: string }>();
  assert.ok(partsAudit?.new_json);
  assert.ok(!partsAudit.new_json.includes('data:application/pdf;base64'));
  assert.ok(partsAudit.new_json.includes('"has_quotation_file":true'));

  // FLEET_MANAGER can read their own notifications inbox (includes Admin approval alerts)
  const fmNotifRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: fmCookie } }),
    env
  );
  assert.equal(fmNotifRes.status, 200);
  const fmNotifs = (await fmNotifRes.json()) as { items: Array<{ event_type: string }> };
  assert.ok(fmNotifs.items.some((n) => n.event_type === 'PARTS_PURCHASE_AUTHORIZED'));
});

test('Legacy users table with active foreign-key rows migrates cleanly and creates FLEET_MANAGER and SUPERVISOR users', async () => {
  const legacyFullSchema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'ADMIN')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      licence_number TEXT,
      phone TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      licence_expiry TEXT,
      licence_document TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_by INTEGER REFERENCES users(id)
    );
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
      vehicle_type TEXT NOT NULL,
      vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY', 'HEAVY')),
      make_model TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'Good',
      last_known_mileage INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_type TEXT NOT NULL CHECK (trip_type IN ('HIRE', 'ERRAND')),
      vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      driver_id INTEGER NOT NULL REFERENCES drivers(id),
      status TEXT NOT NULL DEFAULT 'OPEN',
      client_name TEXT,
      destination TEXT,
      reason TEXT,
      days_hired INTEGER,
      expected_return_date TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE trip_out (
      trip_id INTEGER PRIMARY KEY REFERENCES trips(id),
      out_at TEXT NOT NULL,
      device_time TEXT,
      received_at TEXT NOT NULL,
      mileage_out INTEGER NOT NULL,
      fuel_out TEXT NOT NULL,
      opening_checklist_by TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      flags TEXT NOT NULL DEFAULT '[]',
      recorded_by INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL DEFAULT 'system',
      user_role TEXT NOT NULL DEFAULT 'SYSTEM',
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      old_json TEXT,
      new_json TEXT,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE notification_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH')),
      destination TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_user_id INTEGER NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      trip_id INTEGER REFERENCES trips(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      read_at TEXT
    );
  `;

  const { db, env } = createTestEnv(legacyFullSchema);

  const legacyPinHash = await hashPin('1234');
  // Seed legacy Admin and FK-linked child rows across drivers, notification_recipients, notifications, audit_log, trips
  await db
    .prepare(
      'INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin) VALUES (1, ?, ?, ?, ?, 1, 0)'
    )
    .bind('admin', 'Old Admin', 'ADMIN', legacyPinHash)
    .run();
  await db
    .prepare("INSERT INTO notification_recipients (user_id, channel, destination, active) VALUES (1, 'IN_APP', 'admin', 1)")
    .run();
  await db
    .prepare("INSERT INTO drivers (id, full_name, phone, created_by) VALUES (1, 'John Legacy', '+263770000111', 1)")
    .run();
  await db
    .prepare("INSERT INTO vehicles (id, reg_number, vehicle_type, vehicle_class, make_model) VALUES (1, 'LEG 001', 'Sedan', 'ECONOMY', 'Toyota Corolla')")
    .run();
  await db
    .prepare("INSERT INTO trips (id, trip_type, vehicle_id, driver_id, status) VALUES (1, 'ERRAND', 1, 1, 'OPEN')")
    .run();
  await db
    .prepare("INSERT INTO trip_out (trip_id, out_at, received_at, mileage_out, fuel_out, opening_checklist_by, recorded_by) VALUES (1, '2026-11-01T08:00:00Z', '2026-11-01T08:00:00Z', 1000, 'Full', 'Old Admin', 1)")
    .run();
  await db
    .prepare("INSERT INTO audit_log (ts, user_id, username, user_role, action, entity, entity_id, prev_hash, hash) VALUES ('2026-11-01T08:00:00Z', 1, 'admin', 'ADMIN', 'LEGACY_INIT', 'users', '1', 'GENESIS', 'HASH1')")
    .run();
  await db
    .prepare("INSERT INTO notifications (recipient_user_id, event_type, priority, title, body, trip_id) VALUES (1, 'TRIP_OUT', 'NORMAL', 'Legacy Trip', 'Recorded', 1)")
    .run();

  await ensureInitialSeed(db, env);

  const schemaRow = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .first<{ sql: string }>();
  assert.ok(schemaRow?.sql.includes('FLEET_MANAGER'));

  // Verify existing FK-linked rows survived intact
  const driverRow = await db.prepare('SELECT created_by FROM drivers WHERE id = 1').first<{ created_by: number }>();
  assert.equal(driverRow?.created_by, 1);

  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '1234');

  const createFmRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'fm_migrated',
        full_name: 'Fleet Manager Migrated',
        role: 'FLEET_MANAGER',
        pin: '4545',
      }),
    }),
    env
  );
  assert.equal(createFmRes.status, 201);
  const fmBody = (await createFmRes.json()) as { user: { id: number; role: string } };
  assert.equal(fmBody.user.role, 'FLEET_MANAGER');

  const createSupRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'sup_migrated',
        full_name: 'Supervisor Migrated',
        role: 'SUPERVISOR',
        pin: '5656',
      }),
    }),
    env
  );
  assert.equal(createSupRes.status, 201);

  const fmRecipient = await db
    .prepare("SELECT id FROM notification_recipients WHERE user_id = ? AND channel = 'IN_APP'")
    .bind(fmBody.user.id)
    .first<{ id: number }>();
  assert.ok(fmRecipient?.id);
});

test('Next Service Due notifications alert Fleet Manager and Admin when mileage reaches target, with deduplication', async () => {
  const { env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  await Promise.all([
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'fm_alerts',
          full_name: 'Fleet Manager Alerts',
          role: 'FLEET_MANAGER',
          pin: '4444',
        }),
      }),
      env
    ),
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'sup_alerts',
          full_name: 'Supervisor Alerts',
          role: 'SUPERVISOR',
          pin: '2222',
        }),
      }),
      env
    ),
    app.fetch(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          username: 'drv_alerts',
          full_name: 'Driver Alerts',
          role: 'DRIVER',
          pin: '3333',
        }),
      }),
      env
    ),
  ]);

  const fmCookie = await loginAndChangePin(app, env, 'fm_alerts', '4444', '4488');
  const supCookie = await loginAndChangePin(app, env, 'sup_alerts', '2222', '2288');
  const drvCookie = await loginAndChangePin(app, env, 'drv_alerts', '3333', '3388');

  const drvCreateRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Pilot Driver',
        phone: '+263771112233',
        licence_number: 'LIC-771',
        licence_document: SAMPLE_PDF_DATA_URL,
      }),
    }),
    env
  );
  assert.equal(drvCreateRes.status, 201);
  const driver = ((await drvCreateRes.json()) as { driver: Driver }).driver;

  const vehCreateRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        reg_number: 'SVC 200',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 9800,
        next_service_due_km: 10000,
      }),
    }),
    env
  );
  assert.equal(vehCreateRes.status, 201);
  const vehicle = ((await vehCreateRes.json()) as { vehicle: Vehicle }).vehicle;

  // Dispatch and close a trip that pushes mileage past 10,000 km
  const tripOutRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: vehicle.id,
        driver_id: driver.id,
        destination: 'Airport',
        reason: 'Pickup',
        mileage_out: 9800,
        fuel_out: 'Full',
      }),
    }),
    env
  );
  assert.equal(tripOutRes.status, 201);
  const tripId = ((await tripOutRes.json()) as { trip: { id: number } }).trip.id;

  const tripInRes = await app.fetch(
    new Request(`http://localhost/api/trips/${tripId}/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        mileage_in: 10050,
        fuel_in: '3/4',
        closing_checklist_by: 'Supervisor Alerts',
      }),
    }),
    env
  );
  assert.equal(tripInRes.status, 200);

  // FLEET_MANAGER and ADMIN both receive HIGH-priority VEHICLE_SERVICE_DUE alert
  const fmNotifsRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: fmCookie } }),
    env
  );
  const fmNotifs = (await fmNotifsRes.json()) as {
    items: Array<{ event_type: string; priority: string; title: string }>;
  };
  const fmServiceAlerts = fmNotifs.items.filter((n) => n.event_type === 'VEHICLE_SERVICE_DUE');
  assert.equal(fmServiceAlerts.length, 1);
  assert.equal(fmServiceAlerts[0].priority, 'HIGH');
  assert.ok(fmServiceAlerts[0].title.includes('SVC 200'));

  const adminNotifsRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: adminCookie } }),
    env
  );
  const adminNotifs = (await adminNotifsRes.json()) as {
    items: Array<{ event_type: string; priority: string }>;
  };
  assert.equal(
    adminNotifs.items.filter((n) => n.event_type === 'VEHICLE_SERVICE_DUE').length,
    1
  );

  // SUPERVISOR and DRIVER do NOT receive VEHICLE_SERVICE_DUE alerts
  const supNotifsRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: supCookie } }),
    env
  );
  const supNotifs = (await supNotifsRes.json()) as { items: Array<{ event_type: string }> };
  assert.equal(
    supNotifs.items.filter((n) => n.event_type === 'VEHICLE_SERVICE_DUE').length,
    0
  );

  const drvNotifsRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: drvCookie } }),
    env
  );
  assert.equal(drvNotifsRes.status, 403);

  // Polling / checking overdue again does NOT duplicate the notification for 10,000 km target
  await app.fetch(
    new Request('http://localhost/api/notifications/check-overdue', {
      method: 'POST',
      headers: { Cookie: fmCookie },
    }),
    env
  );
  const fmNotifsAfterRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: fmCookie } }),
    env
  );
  const fmNotifsAfter = (await fmNotifsAfterRes.json()) as {
    items: Array<{ event_type: string }>;
  };
  assert.equal(
    fmNotifsAfter.items.filter((n) => n.event_type === 'VEHICLE_SERVICE_DUE').length,
    1
  );

  // Updating next_service_due_km to 10,040 km (new reached threshold) triggers a fresh alert
  const updateTargetRes = await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/next-service/${vehicle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ next_service_due_km: 10040 }),
    }),
    env
  );
  assert.equal(updateTargetRes.status, 200);

  const fmNotifsSecondTargetRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: fmCookie } }),
    env
  );
  const fmNotifsSecondTarget = (await fmNotifsSecondTargetRes.json()) as {
    items: Array<{ event_type: string }>;
  };
  assert.equal(
    fmNotifsSecondTarget.items.filter((n) => n.event_type === 'VEHICLE_SERVICE_DUE').length,
    2
  );
});

test('Fleet Maintenance Dashboard overview summary stats dynamically track every maintenance action and emit status alerts', async () => {
  const { env } = createTestEnv();
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'fm_stats',
        full_name: 'Fleet Manager Stats',
        role: 'FLEET_MANAGER',
        pin: '4444',
      }),
    }),
    env
  );
  const fmCookie = await loginAndChangePin(app, env, 'fm_stats', '4444', '4488');

  const getOverview = async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/fleet-maintenance/overview', {
        headers: { Cookie: fmCookie },
      }),
      env
    );
    assert.equal(res.status, 200);
    return (await res.json()) as FleetMaintenanceOverview;
  };

  // Add overdue vehicle & grounded vehicle
  const v1Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        reg_number: 'STAT 1',
        vehicle_type: 'Double Cab',
        make_model: 'Isuzu D-Max',
        condition: 'Grounded',
        last_known_mileage: 50200,
        next_service_due_km: 50000,
      }),
    }),
    env
  );
  const v1 = ((await v1Res.json()) as { vehicle: Vehicle }).vehicle;

  await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        reg_number: 'STAT 2',
        vehicle_type: 'SUV',
        make_model: 'Toyota Prado',
        condition: 'Good',
        last_known_mileage: 19600,
        next_service_due_km: 20000,
      }),
    }),
    env
  );

  // Log 1 SERVICE and 1 MECHANICAL entry
  await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        vehicle_id: v1.id,
        record_type: 'SERVICE',
        service_date: '2026-11-25',
        odometer_km: 50200,
        summary: 'Oil service',
      }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        vehicle_id: v1.id,
        record_type: 'MECHANICAL',
        service_date: '2026-11-25',
        odometer_km: 50200,
        summary: 'Clutch assembly inspection',
      }),
    }),
    env
  );

  // Request garage visit -> check pending -> Admin approve -> IN_GARAGE -> check inGarageCount -> COMPLETED
  const gRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/garage-visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        vehicle_id: v1.id,
        visit_date: '2026-11-25',
        workshop_name: 'Central Auto',
        reason: 'Clutch overhaul',
        odometer_km: 50200,
      }),
    }),
    env
  );
  const visitId = ((await gRes.json()) as { visit: GarageVisit }).visit.id;

  const pRes = await app.fetch(
    new Request('http://localhost/api/fleet-maintenance/parts-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({
        request_date: '2026-11-25',
        vehicle_id: v1.id,
        parts_required: 'Clutch Plate Kit',
        is_full_service_kit: false,
        date_required: '2026-11-27',
        estimated_amount: 310,
      }),
    }),
    env
  );
  const partsId = ((await pRes.json()) as { request: PartsPurchaseRequest }).request.id;

  const snapPending = await getOverview();
  assert.equal(snapPending.summary.serviceOverdueCount, 1);
  assert.equal(snapPending.summary.serviceDueSoonCount, 1);
  assert.equal(snapPending.summary.serviceDueSoonOrOverdueCount, 2);
  assert.equal(snapPending.summary.groundedVehiclesCount, 1);
  assert.equal(snapPending.summary.totalLogs, 2);
  assert.equal(snapPending.summary.serviceLogsCount, 1);
  assert.equal(snapPending.summary.mechanicalLogsCount, 1);
  assert.equal(snapPending.summary.pendingGarageApprovals, 1);
  assert.equal(snapPending.summary.inGarageCount, 0);
  assert.equal(snapPending.summary.pendingPartsAuthorizations, 1);

  // Approve garage visit and move to IN_GARAGE; authorize parts and mark PURCHASED
  await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visitId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ decision: 'APPROVED' }),
    }),
    env
  );
  await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visitId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ visit_status: 'IN_GARAGE' }),
    }),
    env
  );
  await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/parts-requests/${partsId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ decision: 'APPROVED' }),
    }),
    env
  );

  const snapActive = await getOverview();
  assert.equal(snapActive.summary.pendingGarageApprovals, 0);
  assert.equal(snapActive.summary.approvedGarageCount, 1);
  assert.equal(snapActive.summary.inGarageCount, 1);
  assert.equal(snapActive.summary.pendingPartsAuthorizations, 0);
  assert.equal(snapActive.summary.approvedPartsCount, 1);

  // Complete garage visit & mark parts PURCHASED
  await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/garage-visits/${visitId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ visit_status: 'COMPLETED', actual_cost: 295 }),
    }),
    env
  );
  await app.fetch(
    new Request(`http://localhost/api/fleet-maintenance/parts-requests/${partsId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: fmCookie },
      body: JSON.stringify({ status: 'PURCHASED' }),
    }),
    env
  );

  const snapCompleted = await getOverview();
  assert.equal(snapCompleted.summary.inGarageCount, 0);
  assert.equal(snapCompleted.summary.completedGarageCount, 1);
  assert.equal(snapCompleted.summary.approvedPartsCount, 0);
  assert.equal(snapCompleted.summary.purchasedPartsCount, 1);

  // Verify push inbox for Admin received status update alerts
  const adminNotifsRes = await app.fetch(
    new Request('http://localhost/api/notifications', { headers: { Cookie: adminCookie } }),
    env
  );
  const adminNotifs = (await adminNotifsRes.json()) as { items: Array<{ event_type: string }> };
  assert.ok(adminNotifs.items.some((n) => n.event_type === 'GARAGE_VISIT_STATUS_UPDATED'));
  assert.ok(adminNotifs.items.some((n) => n.event_type === 'PARTS_PURCHASE_COMPLETED'));
});

