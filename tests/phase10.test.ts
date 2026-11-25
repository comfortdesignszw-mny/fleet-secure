import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
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
