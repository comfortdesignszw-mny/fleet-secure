import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { ensureInitialSeed, resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type {
  ChecklistDetail,
  ChecklistItemTemplate,
  Driver,
  DriverTempCredentials,
  ReportPreviewData,
  Vehicle,
} from '../src/shared/types';
import { createEmptySketch } from '../src/components/VehicleConditionSketch';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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

test('Driver temporary credential handoff works and wipes temp_pin_enc permanently after PIN change', async () => {
  const { db, env } = createTestEnv();
  await ensureInitialSeed(db, env);
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create driver profile first
  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Tatenda Ncube',
        phone: '+263771234567',
        licence_number: '991234ZW',
      }),
    }),
    env
  );
  assert.equal(dRes.status, 201);
  const { driver } = (await dRes.json()) as { driver: Driver };
  assert.equal(driver.linked_user_id, null);

  // Admin creates linked DRIVER user with temporary PIN
  const uRes = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'tatenda.ncube',
        full_name: 'Tatenda Ncube',
        role: 'DRIVER',
        pin: '4321',
        driver_id: driver.id,
      }),
    }),
    env
  );
  assert.equal(uRes.status, 201);

  // Driver directory now exposes linked_user_id and has_pending_temp_credentials for Admin
  const listRes = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as { items: Driver[] };
  const updatedDriver = listJson.items.find((x) => x.id === driver.id)!;
  assert.ok(updatedDriver.linked_user_id);
  assert.equal(updatedDriver.has_pending_temp_credentials, true);

  // Admin can retrieve decrypted temporary credentials while pending
  const credRes = await app.fetch(
    new Request(`http://localhost/api/drivers/${driver.id}/credentials`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(credRes.status, 200);
  const credJson = (await credRes.json()) as { credentials: DriverTempCredentials };
  assert.equal(credJson.credentials.full_name, 'Tatenda Ncube');
  assert.equal(credJson.credentials.username, 'tatenda.ncube');
  assert.equal(credJson.credentials.temp_pin, '4321');

  // Non-admin Supervisor cannot view driver temporary credentials
  const supCreate = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'sec.sup',
        full_name: 'Sec Supervisor',
        role: 'SUPERVISOR',
        pin: '2222',
      }),
    }),
    env
  );
  assert.equal(supCreate.status, 201);
  const supCookie = await loginAndChangePin(app, env, 'sec.sup', '2222', '7777');
  const forbiddenCred = await app.fetch(
    new Request(`http://localhost/api/drivers/${driver.id}/credentials`, {
      headers: { Cookie: supCookie },
    }),
    env
  );
  assert.equal(forbiddenCred.status, 403);

  // Driver signs in and changes their temporary PIN -> temp_pin_enc is wiped!
  await loginAndChangePin(app, env, 'tatenda.ncube', '4321', '8844');

  // Pending credentials link disappears and endpoint returns 410 Gone
  const afterList = await app.fetch(
    new Request('http://localhost/api/drivers', { headers: { Cookie: adminCookie } }),
    env
  );
  const afterDriver = ((await afterList.json()) as { items: Driver[] }).items.find(
    (x) => x.id === driver.id
  )!;
  assert.equal(afterDriver.has_pending_temp_credentials, false);

  const goneCred = await app.fetch(
    new Request(`http://localhost/api/drivers/${driver.id}/credentials`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(goneCred.status, 410);
});

test('Digital Checklists module: 25 templates, +Add new vehicle, date guard, mileage diff alert, return writeback, PDF & report', async () => {
  const { db, env } = createTestEnv();
  await ensureInitialSeed(db, env);
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create a regular staff user (DRIVER) to test hire_date guard and non-admin rules
  const staffCreate = await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        username: 'yard.staff',
        full_name: 'Yard Staff',
        role: 'DRIVER',
        pin: '1111',
      }),
    }),
    env
  );
  assert.equal(staffCreate.status, 201);
  const staffCookie = await loginAndChangePin(app, env, 'yard.staff', '1111', '6543');

  // Verify 25 paper slip templates are seeded
  const tplRes = await app.fetch(
    new Request('http://localhost/api/checklist-templates', {
      headers: { Cookie: staffCookie },
    }),
    env
  );
  assert.equal(tplRes.status, 200);
  const { items: templates } = (await tplRes.json()) as { items: ChecklistItemTemplate[] };
  assert.equal(templates.length, 25);
  assert.ok(templates.some((t) => t.label.includes('ZINARA') || t.options.some((o) => o.includes('ZINARA'))));
  assert.ok(templates.some((t) => t.label.includes('Wheel Spanner')));

  const baseItemsPayload = templates.map((t, idx) => ({
    template_id: t.id,
    custom_label: t.label,
    input_type: t.input_type,
    options: t.options,
    sort_order: idx + 1,
    value_out: t.input_type === 'tick_cross' ? { choice: 'tick' } : { choice: 'Working' },
  }));

  // Non-admin cannot backdate hire_date
  const backdateAttempt = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        new_vehicle: {
          vehicle_type: 'SUV',
          make_model: 'Toyota Fortuner',
          reg_number: 'CHK 9012',
          colour: 'Pearl White',
          fuel_type: 'diesel',
          last_known_mileage: 50000,
        },
        hirer_type: 'renter',
        hirer_name: 'Kudzai Chikwanha',
        representative: 'Farai Moyo',
        cell: '+263772223334',
        colour: 'Pearl White',
        hire_date: '2024-01-01',
        days: 3,
        mileage_out: 50000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: createEmptySketch('suv'),
        signatures: {
          outRenter: { name: 'Kudzai Chikwanha', id_number: '63-112233A44', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Yard Staff', id_number: 'STAFF-1', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: baseItemsPayload,
      }),
    }),
    env
  );
  assert.equal(backdateAttempt.status, 403);

  // Staff creates checklist with +Add new vehicle (server uses Harare today)
  const createRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        new_vehicle: {
          vehicle_type: 'SUV',
          make_model: 'Toyota Fortuner',
          reg_number: 'CHK 9012',
          colour: 'Pearl White',
          fuel_type: 'diesel',
          last_known_mileage: 50000,
        },
        hirer_type: 'renter',
        hirer_name: 'Kudzai Chikwanha',
        representative: 'Farai Moyo',
        cell: '+263772223334',
        colour: 'Pearl White',
        days: 3,
        mileage_out: 50250, // Intentionally differs from 50000 -> diff warning + HIGH alert!
        next_service_mileage: 55000,
        fuel_type: 'diesel',
        fuel_out: '3/4',
        sketch: {
          ...createEmptySketch('suv'),
          no_damage_out: false,
          pins_out: [
            { id: 'p_left', view: 'left', number: 1, x: 220, y: 180, type: 'S', note: 'Left door scratch' },
            { id: 'p_right', view: 'right', number: 2, x: 420, y: 190, type: 'D', note: 'Right fender dent' },
            { id: 'p_top', view: 'top', number: 3, x: 320, y: 120, type: 'C', note: 'Roof stone chip' },
          ],
          strokes_out: [
            {
              id: 's_left',
              view: 'left',
              points: [
                { x: 200, y: 170 },
                { x: 260, y: 185 },
              ],
              width: 4,
            },
          ],
        },
        sketch_png_data_url: TINY_PNG_DATA_URL,
        signatures: {
          outRenter: { name: 'Kudzai Chikwanha', id_number: '63-112233A44', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Yard Staff', id_number: 'STAFF-1', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: baseItemsPayload,
      }),
    }),
    env
  );
  assert.equal(createRes.status, 201);
  const { checklist } = (await createRes.json()) as { checklist: ChecklistDetail };
  assert.equal(checklist.status, 'out');
  assert.equal(checklist.reg_number, 'CHK 9012');
  assert.equal(checklist.colour, 'Pearl White');
  assert.equal(checklist.mileage_out_diff_warning, true);
  assert.equal(checklist.items.length, 25);
  assert.equal(checklist.sketch.pins_out.length, 3);
  assert.equal(checklist.sketch.pins_out[0]?.view, 'left');
  assert.equal(checklist.sketch.pins_out[1]?.view, 'right');
  assert.equal(checklist.sketch.pins_out[2]?.view, 'top');

  // Add a custom row to the open checklist
  const customRowRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        custom_label: 'Roof Rack Key',
        input_type: 'yes_no',
        options: ['Yes', 'No'],
        value_out: { choice: 'Yes' },
      }),
    }),
    env
  );
  assert.equal(customRowRes.status, 201);

  // Fetch updated checklist before return
  const getBeforeRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}`, {
      headers: { Cookie: staffCookie },
    }),
    env
  );
  const { checklist: beforeRet } = (await getBeforeRes.json()) as { checklist: ChecklistDetail };
  assert.equal(beforeRet.items.length, 26);

  // Complete return fails if mileage_in < mileage_out
  const badReturnRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        mileage_in: 50100,
        fuel_in: '1/2',
        sketch: beforeRet.sketch,
        signatures: {
          inRenter: { name: 'Kudzai Chikwanha', id_number: '63-112233A44', signature_data_url: TINY_PNG_DATA_URL },
          inCompany: { name: 'Yard Staff', id_number: 'STAFF-1', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: beforeRet.items.map((it) => ({ id: it.id, value_in: it.value_out })),
      }),
    }),
    env
  );
  assert.equal(badReturnRes.status, 400);

  // Valid return changes item #1 to 'cross' and custom row to 'No' -> computes Differences (NO odometer diff warning!) + updates Vehicle
  const completeRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({
        mileage_in: 50680,
        fuel_in: '1/2',
        sketch: { ...beforeRet.sketch, no_damage_in: true },
        sketch_png_data_url: TINY_PNG_DATA_URL,
        signatures: {
          inRenter: { name: 'Kudzai Chikwanha', id_number: '63-112233A44', signature_data_url: TINY_PNG_DATA_URL },
          inCompany: { name: 'Yard Staff', id_number: 'STAFF-1', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: beforeRet.items.map((it, idx) =>
          idx === 0
            ? { id: it.id, value_in: { choice: 'cross' } }
            : it.custom_label === 'Roof Rack Key'
              ? { id: it.id, value_in: { choice: 'No' } }
              : { id: it.id, value_in: it.value_out }
        ),
      }),
    }),
    env
  );
  assert.equal(completeRes.status, 200);
  const { checklist: completed } = (await completeRes.json()) as { checklist: ChecklistDetail };
  assert.equal(completed.status, 'completed');
  assert.equal(completed.mileage_in, 50680);
  assert.equal(completed.fuel_in, '1/2');
  assert.ok(completed.differences.length >= 2);
  assert.equal(
    completed.differences.some((d) => d.kind === 'mileage'),
    false,
    'Odometer distance between OUT and IN should never be flagged as a difference warning'
  );

  // Verify Vehicle record received writeback (last_closing_mileage, last_fuel_level, and checklists history)
  const vehDetailRes = await app.fetch(
    new Request(`http://localhost/api/vehicles/${checklist.vehicle_id}`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(vehDetailRes.status, 200);
  const vehDetail = (await vehDetailRes.json()) as {
    vehicle: Vehicle;
    checklists: Array<{ id: number; status: string }>;
  };
  assert.equal(vehDetail.vehicle.last_closing_mileage, 50680);
  assert.equal(vehDetail.vehicle.last_fuel_level, '1/2');
  assert.equal(vehDetail.checklists[0]?.id, checklist.id);

  // Verify PDF export returns valid PDF header & reg+date filename format
  const pdfRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/pdf`, {
      headers: { Cookie: staffCookie },
    }),
    env
  );
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  const contentDisp = pdfRes.headers.get('content-disposition') || '';
  assert.match(contentDisp, /Checklist_CHK9012_\d{2}-\d{2}-\d{2}\.pdf/);
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(pdfBuf.toString('utf8', 0, 8).startsWith('%PDF-1.4'));

  // Verify Checklists Report preview includes the record
  const repRes = await app.fetch(
    new Request('http://localhost/api/reports/preview?type=checklists', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(repRes.status, 200);
  const repData = (await repRes.json()) as ReportPreviewData;
  assert.equal(repData.total_rows, 1);

  // Non-admin cannot amend or soft delete; Admin can
  const staffAmend = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/amend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ hirer_name: 'X', reason: 'Attempt' }),
    }),
    env
  );
  assert.equal(staffAmend.status, 403);

  const adminAmend = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}/amend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ colour: 'Arctic White', reason: 'Corrected paint name' }),
    }),
    env
  );
  assert.equal(adminAmend.status, 200);

  const adminDelete = await app.fetch(
    new Request(`http://localhost/api/checklists/${checklist.id}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(adminDelete.status, 200);
});
