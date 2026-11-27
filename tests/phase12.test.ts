import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { ensureInitialSeed, resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import {
  evaluateChecklistVehicleMatch,
  formatSubhiredMakeModel,
  toHarareYmd,
  type ChecklistDetail,
  type ChecklistSummary,
  type Driver,
  type ReportPreviewData,
  type SubhireReceipt,
  type TripSummary,
  type Vehicle,
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

const SAMPLE_ITEMS = [
  {
    custom_label: 'Spare Wheel',
    input_type: 'tick_cross' as const,
    options: [],
    sort_order: 1,
    value_out: { choice: 'tick' },
    note: '',
    photo_data_url: null,
  },
];

test('formatSubhiredMakeModel appends (Subhired) without duplicating', () => {
  assert.equal(formatSubhiredMakeModel('Toyota Hilux'), 'Toyota Hilux (Subhired)');
  assert.equal(formatSubhiredMakeModel('Toyota Hilux (Subhired)'), 'Toyota Hilux (Subhired)');
  assert.equal(formatSubhiredMakeModel('  Nissan NP300  '), 'Nissan NP300 (Subhired)');
  assert.equal(formatSubhiredMakeModel('Ford Ranger (subhired)'), 'Ford Ranger (Subhired)');
});

test('Owner checklists allow optional Days & Return Date while Renter checklists enforce Days >= 1', async () => {
  const { db, env } = createTestEnv();
  await ensureInitialSeed(db, env);
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AHT9001',
        vehicle_type: 'Double Cab',
        make_model: 'Toyota Hilux',
        last_known_mileage: 50000,
      }),
    }),
    env
  );
  assert.equal(vRes.status, 201);
  const { vehicle } = (await vRes.json()) as { vehicle: Vehicle };

  const cleanSketch = { ...createEmptySketch('doublecab'), no_damage_out: true };

  // Renter checklist without days must fail with 400
  const badRenterRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        vehicle_id: vehicle.id,
        hirer_type: 'renter',
        hirer_name: 'Chido Moyo',
        cell: '+263771112233',
        days: null,
        mileage_out: 50000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: cleanSketch,
        signatures: {
          outRenter: { name: 'Chido Moyo', id_number: '63-111111A00', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-222222B00', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(badRenterRes.status, 400);

  // Owner checklist with days: null and return_date: null must succeed (201)
  const ownerRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        vehicle_id: vehicle.id,
        hirer_type: 'owner',
        hirer_name: 'Kuda Motors',
        representative: 'Farai Dube',
        cell: '+263774445566',
        days: null,
        return_date: null,
        mileage_out: 50000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: cleanSketch,
        signatures: {
          outRenter: { name: 'Farai Dube', id_number: '63-333333C00', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-222222B00', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(ownerRes.status, 201);
  const { checklist: ownerChk } = (await ownerRes.json()) as { checklist: ChecklistDetail };
  assert.equal(ownerChk.hirer_type, 'owner');
  assert.equal(ownerChk.days, null);
  assert.equal(ownerChk.return_date, null);

  // Amend owner checklist keeping optional dates null
  const amendRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${ownerChk.id}/amend`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        hirer_name: 'Kuda Motors Pvt Ltd',
        days: null,
        return_date: null,
        reason: 'Updated owner registered entity name',
      }),
    }),
    env
  );
  assert.equal(amendRes.status, 200);
  const amended = (await amendRes.json()) as { checklist: ChecklistDetail };
  assert.equal(amended.checklist.hirer_name, 'Kuda Motors Pvt Ltd');
  assert.equal(amended.checklist.days, null);
  assert.equal(amended.checklist.return_date, null);

  // PDF generation and Reports preview/export handle null days & return_date cleanly
  const pdfRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${ownerChk.id}/pdf`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');

  const today = ownerChk.hire_date;
  const repRes = await app.fetch(
    new Request(`http://localhost/api/reports/preview?from=${today}&to=${today}&type=checklists`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(repRes.status, 200);
  const repJson = (await repRes.json()) as ReportPreviewData;
  assert.equal(repJson.rows.length, 1);
  assert.ok(String(repJson.rows[0].hirer).includes('Kuda Motors Pvt Ltd'));
  assert.equal(repJson.rows[0].return_date, '-');

  const csvRes = await app.fetch(
    new Request(`http://localhost/api/reports/export?format=csv&from=${today}&to=${today}&type=checklists`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.ok(csvText.includes('Kuda Motors Pvt Ltd'));
});

test('Hire Out & Subhirer forms strictly match Renter vs Owner checklists and format (Subhired) vehicles', async () => {
  const { db, env } = createTestEnv();
  await ensureInitialSeed(db, env);
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create driver & fleet vehicle
  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Tinashe Chikwanda',
        phone: '+263775551234',
        licence_number: 'ZW882211',
      }),
    }),
    env
  );
  assert.equal(dRes.status, 201);
  const { driver } = (await dRes.json()) as { driver: Driver };

  const vRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'AGX4001',
        vehicle_type: 'SUV',
        make_model: 'Toyota Fortuner',
        last_known_mileage: 22000,
      }),
    }),
    env
  );
  assert.equal(vRes.status, 201);
  const { vehicle } = (await vRes.json()) as { vehicle: Vehicle };

  // Create one Renter checklist and one Owner checklist
  const renterChkRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        vehicle_id: vehicle.id,
        hirer_type: 'renter',
        hirer_name: 'Delta Beverages',
        cell: '+263772223344',
        days: 3,
        mileage_out: 22000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: { ...createEmptySketch('suv'), no_damage_out: true },
        signatures: {
          outRenter: { name: 'Delta Rep', id_number: '63-101010X00', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-202020Y00', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(renterChkRes.status, 201);
  const { checklist: renterChk } = (await renterChkRes.json()) as { checklist: ChecklistDetail };

  const ownerChkRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        new_vehicle: {
          vehicle_type: 'Double Cab',
          make_model: 'Ford Ranger (Subhired)',
          reg_number: 'SUB1001',
          fuel_type: 'diesel',
          last_known_mileage: 18500,
        },
        hirer_type: 'owner',
        hirer_name: 'Ndlovu Rentals',
        representative: 'Bongani Ndlovu',
        cell: '+263779998877',
        days: null,
        return_date: null,
        mileage_out: 18500,
        fuel_type: 'diesel',
        fuel_out: '3/4',
        sketch: { ...createEmptySketch('doublecab'), no_damage_out: true },
        signatures: {
          outRenter: { name: 'Bongani Ndlovu', id_number: '63-404040Z00', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-202020Y00', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(ownerChkRes.status, 201);
  const { checklist: ownerChk } = (await ownerChkRes.json()) as { checklist: ChecklistDetail };

  // Filter GET /api/checklists by hirer_type
  const listRenters = await app.fetch(
    new Request('http://localhost/api/checklists?hirer_type=renter', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(listRenters.status, 200);
  const renterItems = ((await listRenters.json()) as { items: ChecklistSummary[] }).items;
  assert.ok(renterItems.every((c) => c.hirer_type === 'renter'));
  assert.ok(renterItems.some((c) => c.id === renterChk.id));

  const listOwners = await app.fetch(
    new Request('http://localhost/api/checklists?hirer_type=owner', {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(listOwners.status, 200);
  const ownerItems = ((await listOwners.json()) as { items: ChecklistSummary[] }).items;
  assert.ok(ownerItems.every((c) => c.hirer_type === 'owner'));
  assert.ok(ownerItems.some((c) => c.id === ownerChk.id));

  // Attempting to link an Owner checklist on Hire Out must be rejected (400)
  const badHireRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: vehicle.id,
        driver_id: driver.id,
        client_name: 'Delta Beverages',
        days_hired: 3,
        expected_return_date: renterChk.return_date,
        mileage_out: 22000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: ownerChk.id,
      }),
    }),
    env
  );
  assert.equal(badHireRes.status, 400);

  // Linking matching Renter checklist on Hire Out succeeds & binds both sides
  const goodHireRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: vehicle.id,
        driver_id: driver.id,
        client_name: 'Delta Beverages',
        days_hired: 3,
        expected_return_date: renterChk.return_date,
        mileage_out: 22000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(goodHireRes.status, 201);
  const { trip } = (await goodHireRes.json()) as { trip: TripSummary };
  assert.equal(trip.checklist_id, renterChk.id);

  const chkCheckRes = await app.fetch(
    new Request(`http://localhost/api/checklists/${renterChk.id}`, {
      headers: { Cookie: adminCookie },
    }),
    env
  );
  const chkAfterTrip = ((await chkCheckRes.json()) as { checklist: ChecklistDetail }).checklist;
  assert.equal(chkAfterTrip.trip_id, trip.id);

  // Attempting to link a Renter checklist on Subhirer Receive must be rejected (400)
  const badSubhireRes = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Ndlovu Rentals',
        representative: 'Bongani Ndlovu',
        phone: '+263779998877',
        address: '12 Samora Machel Ave',
        new_vehicle: {
          reg_number: 'SUB2002',
          vehicle_type: 'Double Cab',
          make_model: 'Isuzu D-Max',
          fuel_type: 'diesel',
          condition: 'Good',
          last_known_mileage: 12000,
        },
        received_mileage: 12000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(badSubhireRes.status, 400);

  // Receiving Sub3003 / Makoni Fleet Hire with Ndlovu Rentals / SUB1001 Owner checklist must be rejected (400) and NOT create orphan SUB3003 vehicle
  const mismatchSubhireRes = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Makoni Fleet Hire',
        representative: 'Rudo Makoni',
        phone: '+263776001122',
        address: '45 Second Street, Harare',
        new_vehicle: {
          reg_number: 'SUB3003',
          vehicle_type: 'Double Cab',
          make_model: 'Isuzu D-Max',
          colour: 'White',
          fuel_type: 'diesel',
          condition: 'Good',
          last_known_mileage: 31000,
          next_service_due_km: 40000,
        },
        received_mileage: 31000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: ownerChk.id,
        notes: 'Mismatched checklist test',
      }),
    }),
    env
  );
  assert.equal(mismatchSubhireRes.status, 400);
  const orphanCheck = await db
    .prepare("SELECT id FROM vehicles WHERE reg_number = 'SUB3003'")
    .first<{ id: number }>();
  assert.equal(orphanCheck, null);

  // Create matching Owner checklist for Makoni Fleet Hire / SUB3003 / Double Cab (today)
  const makoniOwnerChkRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        new_vehicle: {
          vehicle_type: 'Double Cab',
          make_model: 'Isuzu D-Max (Subhired)',
          reg_number: 'SUB3003',
          fuel_type: 'diesel',
          last_known_mileage: 31000,
          save_to_directory: false,
        },
        hirer_type: 'owner',
        hirer_name: 'Makoni Fleet Hire',
        representative: 'Rudo Makoni',
        cell: '+263776001122',
        days: null,
        return_date: null,
        mileage_out: 31000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: { ...createEmptySketch('doublecab'), no_damage_out: true },
        signatures: {
          outRenter: { name: 'Rudo Makoni', id_number: '63-505050A00', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-202020Y00', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(makoniOwnerChkRes.status, 201);
  const { checklist: makoniOwnerChk } = (await makoniOwnerChkRes.json()) as {
    checklist: ChecklistDetail;
  };

  // Receiving a Subhired vehicle with matching Owner checklist (existing vehicle from checklist) links cleanly
  const goodSubhireRes = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Makoni Fleet Hire',
        representative: 'Rudo Makoni',
        phone: '+263776001122',
        address: '45 Second Street, Harare',
        new_vehicle: {
          reg_number: 'SUB4004',
          vehicle_type: 'Double Cab',
          make_model: 'Isuzu D-Max',
          colour: 'White',
          fuel_type: 'diesel',
          condition: 'Good',
          last_known_mileage: 31000,
          next_service_due_km: 40000,
        },
        received_mileage: 31000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: makoniOwnerChk.id,
        notes: 'Should fail on reg mismatch',
      }),
    }),
    env
  );
  assert.equal(goodSubhireRes.status, 400);

  // Now link matching Makoni checklist to its matching SUB3003 vehicle & verify receipt
  const matchedSubhireRes = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Makoni Fleet Hire',
        representative: 'Rudo Makoni',
        phone: '+263776001122',
        address: '45 Second Street, Harare',
        vehicle_id: makoniOwnerChk.vehicle_id,
        received_mileage: 31000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: makoniOwnerChk.id,
        notes: 'Received clean with spare wheel',
      }),
    }),
    env
  );
  assert.equal(matchedSubhireRes.status, 201);
  const subhirePayload = (await matchedSubhireRes.json()) as {
    receipt: SubhireReceipt;
    vehicle: Vehicle;
  };
  assert.equal(subhirePayload.vehicle.make_model, 'Isuzu D-Max (Subhired)');
  assert.equal(subhirePayload.receipt.checklist_id, makoniOwnerChk.id);
  assert.equal(subhirePayload.receipt.subhirer_name, 'Makoni Fleet Hire');

  // Unauthenticated subhire listing rejected
  const unauthSubhireList = await app.fetch(new Request('http://localhost/api/subhires'), env);
  assert.equal(unauthSubhireList.status, 401);

  // Authenticated subhire listing returns the created receipt
  const subhireListRes = await app.fetch(
    new Request('http://localhost/api/subhires', { headers: { Cookie: adminCookie } }),
    env
  );
  assert.equal(subhireListRes.status, 200);
  const subhires = ((await subhireListRes.json()) as { items: SubhireReceipt[] }).items;
  assert.equal(subhires.length, 1);
  assert.equal(subhires[0].make_model, 'Isuzu D-Max (Subhired)');
  assert.equal(subhires[0].checklist_id, makoniOwnerChk.id);
});

test('Strict 5-rule checklist and vehicle matching rejects every mismatch and normalizes valid matches', async () => {
  const todayHarare = toHarareYmd(new Date());

  // Unit tests for evaluateChecklistVehicleMatch
  const okMatch = evaluateChecklistVehicleMatch(
    {
      hirer_type: 'renter',
      hirer_name: '  Delta   Beverages ',
      reg_number: 'agx-4001',
      vehicle_type: 'SUV',
      created_at: `${todayHarare}T08:15:00+02:00`,
    },
    {
      expectedHirerType: 'renter',
      partyName: 'delta beverages',
      regNumber: 'AGX 4001',
      vehicleType: 'suv',
      logDateYmd: todayHarare,
    }
  );
  assert.equal(okMatch.matched, true);
  assert.deepEqual(okMatch.reasons, []);

  // Different creation date fails
  const wrongDateMatch = evaluateChecklistVehicleMatch(
    {
      hirer_type: 'owner',
      hirer_name: 'Ndlovu Rentals',
      reg_number: 'SUB1001',
      vehicle_type: 'Double Cab',
      created_at: '2026-01-10 09:00:00',
    },
    {
      expectedHirerType: 'owner',
      partyName: 'Ndlovu Rentals',
      regNumber: 'SUB1001',
      vehicleType: 'Double Cab',
      logDateYmd: todayHarare,
    }
  );
  assert.equal(wrongDateMatch.matched, false);
  assert.equal(wrongDateMatch.checks.dateOk, false);
  assert.equal(wrongDateMatch.checks.hirerTypeOk, true);
  assert.equal(wrongDateMatch.checks.regOk, true);
  assert.equal(wrongDateMatch.checks.vehicleTypeOk, true);
  assert.equal(wrongDateMatch.checks.nameOk, true);

  // API integration tests for all 5 mismatch dimensions on both Hire Out & Subhire Receive
  const { db, env } = createTestEnv();
  await ensureInitialSeed(db, env);
  const app = createApp();
  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  const dRes = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        full_name: 'Farai Mupfumi',
        phone: '+263771009988',
        licence_number: 'ZW991122',
      }),
    }),
    env
  );
  const { driver } = (await dRes.json()) as { driver: Driver };

  const v1Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'MATCH1',
        vehicle_type: 'SUV',
        make_model: 'Toyota Prado',
        last_known_mileage: 10000,
      }),
    }),
    env
  );
  const { vehicle: v1 } = (await v1Res.json()) as { vehicle: Vehicle };

  const v2Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        reg_number: 'MATCH2',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        last_known_mileage: 5000,
      }),
    }),
    env
  );
  const { vehicle: v2 } = (await v2Res.json()) as { vehicle: Vehicle };

  const renterChkRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        vehicle_id: v1.id,
        hirer_type: 'renter',
        hirer_name: 'Econet Wireless',
        cell: '+263771111222',
        days: 2,
        mileage_out: 10000,
        fuel_type: 'diesel',
        fuel_out: 'Full',
        sketch: { ...createEmptySketch('suv'), no_damage_out: true },
        signatures: {
          outRenter: { name: 'Econet Rep', id_number: '63-111111A11', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-222222B22', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(renterChkRes.status, 201);
  const { checklist: renterChk } = (await renterChkRes.json()) as { checklist: ChecklistDetail };

  // 1. Wrong client name on Hire Out -> 400
  const wrongClientHire = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: driver.id,
        client_name: 'Different Client Ltd',
        days_hired: 2,
        expected_return_date: renterChk.return_date,
        mileage_out: 10000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongClientHire.status, 400);

  // 2. Wrong vehicle reg & type on Hire Out -> 400
  const wrongVehicleHire = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v2.id,
        driver_id: driver.id,
        client_name: 'Econet Wireless',
        days_hired: 2,
        expected_return_date: renterChk.return_date,
        mileage_out: 5000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongVehicleHire.status, 400);

  // 3. Vehicle type mismatch even with matching reg (simulate edited checklist vehicle_type) -> 400
  await db.prepare("UPDATE checklists SET vehicle_type = 'Sedan' WHERE id = ?").bind(renterChk.id).run();
  const wrongTypeHire = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: driver.id,
        client_name: 'Econet Wireless',
        days_hired: 2,
        expected_return_date: renterChk.return_date,
        mileage_out: 10000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongTypeHire.status, 400);
  await db.prepare("UPDATE checklists SET vehicle_type = 'SUV' WHERE id = ?").bind(renterChk.id).run();

  // 4. Different creation date on checklist -> 400
  await db.prepare("UPDATE checklists SET created_at = '2026-01-15T10:00:00Z' WHERE id = ?").bind(renterChk.id).run();
  const wrongDateHire = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: driver.id,
        client_name: 'Econet Wireless',
        days_hired: 2,
        expected_return_date: renterChk.return_date,
        mileage_out: 10000,
        fuel_out: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: renterChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongDateHire.status, 400);

  // Subhire matching rejections: create matching Owner checklist on v2 (Sedan / MATCH2)
  const ownerSubChkRes = await app.fetch(
    new Request('http://localhost/api/checklists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        vehicle_id: v2.id,
        hirer_type: 'owner',
        hirer_name: 'Zimbabwe Car Hire',
        representative: 'Tawanda Moyo',
        cell: '+263773334445',
        days: null,
        return_date: null,
        mileage_out: 5000,
        fuel_type: 'petrol',
        fuel_out: 'Full',
        sketch: { ...createEmptySketch('sedan'), no_damage_out: true },
        signatures: {
          outRenter: { name: 'Tawanda Moyo', id_number: '63-333333C33', signature_data_url: TINY_PNG_DATA_URL },
          outCompany: { name: 'Test Admin', id_number: '63-222222B22', signature_data_url: TINY_PNG_DATA_URL },
        },
        items: SAMPLE_ITEMS,
      }),
    }),
    env
  );
  assert.equal(ownerSubChkRes.status, 201);
  const { checklist: ownerSubChk } = (await ownerSubChkRes.json()) as { checklist: ChecklistDetail };

  // Wrong subhirer name -> 400
  const wrongOwnerNameSub = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Other Fleet Co',
        phone: '+263773334445',
        vehicle_id: v2.id,
        received_mileage: 5000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: ownerSubChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongOwnerNameSub.status, 400);

  // Wrong vehicle type on new subhired vehicle (reg SUBNEW99 vs MATCH2) -> 400 & no orphan vehicle
  const wrongVehicleSub = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Zimbabwe Car Hire',
        phone: '+263773334445',
        new_vehicle: {
          reg_number: 'SUBNEW99',
          vehicle_type: 'SUV',
          make_model: 'Honda CR-V',
          fuel_type: 'petrol',
          last_known_mileage: 5000,
        },
        received_mileage: 5000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: ownerSubChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongVehicleSub.status, 400);
  const orphanSubNew99 = await db
    .prepare("SELECT id FROM vehicles WHERE reg_number = 'SUBNEW99'")
    .first<{ id: number }>();
  assert.equal(orphanSubNew99, null);

  // Different creation date on owner checklist -> 400
  await db.prepare("UPDATE checklists SET created_at = '2026-01-15T10:00:00Z' WHERE id = ?").bind(ownerSubChk.id).run();
  const wrongDateSub = await app.fetch(
    new Request('http://localhost/api/subhires', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        subhirer_name: 'Zimbabwe Car Hire',
        phone: '+263773334445',
        vehicle_id: v2.id,
        received_mileage: 5000,
        fuel_level: 'Full',
        opening_checklist_by: 'Test Admin',
        checklist_id: ownerSubChk.id,
      }),
    }),
    env
  );
  assert.equal(wrongDateSub.status, 400);
});

test('Migration updates legacy NOT NULL checklists.days and return_date without losing existing rows', async () => {
  resetSeedCacheForTests();
  const baseSchema = fs.readFileSync(path.resolve(process.cwd(), 'schema.sql'), 'utf-8');
  const legacySchema = baseSchema
    .replace('days INTEGER CHECK (days IS NULL OR days >= 1),', 'days INTEGER NOT NULL CHECK (days >= 1),')
    .replace('return_date TEXT,', 'return_date TEXT NOT NULL,');
  assert.ok(legacySchema.includes('days INTEGER NOT NULL'));
  assert.ok(legacySchema.includes('return_date TEXT NOT NULL'));

  const db = new LocalD1Adapter(':memory:', legacySchema);
  const env: AppEnv = {
    DB: db,
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PIN: '1234',
    INITIAL_ADMIN_NAME: 'Test Admin',
  };

  await db
    .prepare(
      `INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin)
       VALUES (1, 'admin', 'Test Admin', 'ADMIN', 'legacyhash', 1, 0)`
    )
    .run();
  await db
    .prepare(
      `INSERT INTO vehicles (id, reg_number, vehicle_type, vehicle_class, make_model)
       VALUES (1, 'LEGACY1', 'Sedan', 'ECONOMY', 'Toyota Corolla')`
    )
    .run();
  await db
    .prepare(
      `INSERT INTO checklists (id, vehicle_id, status, hirer_type, hirer_name, cell, car_model, vehicle_type, reg_number, hire_date, days, return_date, mileage_out, created_by)
       VALUES (10, 1, 'out', 'renter', 'Legacy Client', '+263771000111', 'Toyota Corolla', 'Sedan', 'LEGACY1', '2026-11-20', 2, '2026-11-22', 1000, 1)`
    )
    .run();
  await db
    .prepare(
      `INSERT INTO checklist_items (checklist_id, custom_label, input_type, sort_order)
       VALUES (10, 'Spare Wheel', 'tick_cross', 1)`
    )
    .run();

  await ensureInitialSeed(db, env);

  const legacyRow = await db
    .prepare('SELECT id, days, return_date FROM checklists WHERE id = 10')
    .first<{ id: number; days: number | null; return_date: string | null }>();
  assert.equal(legacyRow?.id, 10);
  assert.equal(legacyRow?.days, 2);
  assert.equal(legacyRow?.return_date, '2026-11-22');

  const legacyItem = await db
    .prepare('SELECT checklist_id, custom_label FROM checklist_items WHERE checklist_id = 10')
    .first<{ checklist_id: number; custom_label: string }>();
  assert.equal(legacyItem?.checklist_id, 10);
  assert.equal(legacyItem?.custom_label, 'Spare Wheel');

  // Now inserting NULL days and NULL return_date succeeds on migrated table
  await db
    .prepare(
      `INSERT INTO checklists (vehicle_id, status, hirer_type, hirer_name, cell, car_model, vehicle_type, reg_number, hire_date, days, return_date, mileage_out, created_by)
       VALUES (1, 'out', 'owner', 'Owner No Return Date', '+263771222333', 'Toyota Corolla', 'Sedan', 'LEGACY1', '2026-11-27', NULL, NULL, 1050, 1)`
    )
    .run();

  const migratedRow = await db
    .prepare("SELECT days, return_date FROM checklists WHERE hirer_name = 'Owner No Return Date'")
    .first<{ days: number | null; return_date: string | null }>();
  assert.equal(migratedRow?.days, null);
  assert.equal(migratedRow?.return_date, null);
});
