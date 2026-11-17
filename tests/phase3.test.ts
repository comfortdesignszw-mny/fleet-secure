import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import { calculateTripFuelAndMileage } from '../src/server/trips';
import type { AppEnv } from '../src/server/types';
import { DEFAULT_SETTINGS, type TripDetail, type TripFlag, type TripSummary } from '../src/shared/types';

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

test('Fuel and mileage calculations for Economy and Heavy vehicles', () => {
  // Economy: 60L, 10 km/L, 25% threshold = 15L
  const ecoNormal = calculateTripFuelAndMileage({
    mileageOut: 10000,
    mileageIn: 10150,
    fuelOut: 'Full',
    fuelIn: '3/4',
    vehicleClass: 'ECONOMY',
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(ecoNormal.total_mileage, 150);
  assert.equal(ecoNormal.est_fuel_litres, 15.0);
  assert.equal(ecoNormal.gauge_fuel_litres, 15.0);
  assert.equal(ecoNormal.fuel_mismatch, false);

  // Heavy: 80L, 8 km/L, 25% threshold = 20L -> big discrepancy
  const heavyMismatch = calculateTripFuelAndMileage({
    mileageOut: 50000,
    mileageIn: 50040, // 40 km -> est 5.0 L
    fuelOut: 'Full',
    fuelIn: '1/2', // gauge 40.0 L -> diff 35L > 20L
    vehicleClass: 'HEAVY',
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(heavyMismatch.total_mileage, 40);
  assert.equal(heavyMismatch.est_fuel_litres, 5.0);
  assert.equal(heavyMismatch.gauge_fuel_litres, 40.0);
  assert.equal(heavyMismatch.fuel_mismatch, true);

  // Refuelled vehicle gives negative gauge_fuel_litres
  const refuelled = calculateTripFuelAndMileage({
    mileageOut: 20000,
    mileageIn: 20100,
    fuelOut: '1/4',
    fuelIn: 'Full',
    vehicleClass: 'ECONOMY',
    settings: DEFAULT_SETTINGS,
  });
  assert.equal(refuelled.gauge_fuel_litres, -45.0);
});

test('Trip Out/In validation, UNRECORDED_GAP, FUEL_MISMATCH, immutability, and corrections', async () => {
  const { env } = createTestEnv();
  const app = createApp();

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create Driver & Supervisor users
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv1', full_name: 'Yard Driver', role: 'DRIVER', pin: '1111' }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'sup1', full_name: 'Loss Control', role: 'SUPERVISOR', pin: '2222' }),
    }),
    env
  );
  const drvCookie = await loginAndChangePin(app, env, 'drv1', '1111', '1199');
  const supCookie = await loginAndChangePin(app, env, 'sup1', '2222', '2299');

  // Seed 2 vehicles (one Good, one Grounded) and 1 driver via Supervisor
  const v1Res = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'AFX 5001',
        vehicle_type: 'Sedan',
        make_model: 'Toyota Corolla',
        condition: 'Good',
        last_known_mileage: 10000,
      }),
    }),
    env
  );
  const v1 = ((await v1Res.json()) as { vehicle: { id: number } }).vehicle;

  const vGroundedRes = await app.fetch(
    new Request('http://localhost/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        reg_number: 'AFX 5002',
        vehicle_type: 'Sedan',
        make_model: 'Nissan Almera',
        condition: 'Grounded',
        last_known_mileage: 30000,
      }),
    }),
    env
  );
  const vGrounded = ((await vGroundedRes.json()) as { vehicle: { id: number } }).vehicle;

  const d1Res = await app.fetch(
    new Request('http://localhost/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        full_name: 'Farai Moyo',
        licence_number: 'ZW-77889',
        phone: '+26377111999',
        address: 'Harare',
        licence_expiry: '2029-12-31',
      }),
    }),
    env
  );
  const d1 = ((await d1Res.json()) as { driver: { id: number } }).driver;

  // 1. Grounded vehicle cannot be booked out
  const groundedOut = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: vGrounded.id,
        driver_id: d1.id,
        client_name: 'Client A',
        mileage_out: 30000,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(groundedOut.status, 400);

  // 2. Errand requires destination & reason
  const badErrand = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: v1.id,
        driver_id: d1.id,
        destination: 'CBD',
        mileage_out: 10000,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(badErrand.status, 400);

  // 3. Driver books out v1 with +50 km gap -> allowed, raises UNRECORDED_GAP
  const hireOut = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: d1.id,
        client_name: 'Zim Corp',
        mileage_out: 10050,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(hireOut.status, 201);
  const hireOutBody = (await hireOut.json()) as { trip: TripSummary; flags: TripFlag[] };
  assert.ok(hireOutBody.flags.some((f) => f.code === 'UNRECORDED_GAP'));

  // 4. Cannot book same OPEN vehicle again
  const doubleBook = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: d1.id,
        client_name: 'Client B',
        mileage_out: 10050,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(doubleBook.status, 409);

  // 5. Return with mileage_in < mileage_out is rejected
  const badIn = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        mileage_in: 10020,
        fuel_in: '1/2',
        closing_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(badIn.status, 400);

  // 6. Return with fuel mismatch (only 20 km driven, dropped from Full to 1/4 = 45L vs 2L est)
  const goodIn = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        mileage_in: 10070,
        fuel_in: '1/4',
        closing_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(goodIn.status, 200);
  const goodInBody = (await goodIn.json()) as { trip: TripSummary; flags: TripFlag[] };
  assert.equal(goodInBody.trip.total_mileage, 20);
  assert.ok(goodInBody.flags.some((f) => f.code === 'FUEL_MISMATCH'));

  // 7. Immutability: DELETE or PATCH on trip returns 404 (not permitted)
  const delTrip = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    }),
    env
  );
  assert.equal(delTrip.status, 404);

  // 8. Driver cannot create a correction (403); Supervisor can
  const drvCorr = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        target_table: 'trip_in',
        field_changes: { fuel_in: 'Full-' },
        reason: 'Misread gauge needle',
      }),
    }),
    env
  );
  assert.equal(drvCorr.status, 403);

  const supCorr = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}/corrections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: supCookie },
      body: JSON.stringify({
        target_table: 'trip_in',
        field_changes: { fuel_in: 'Full-' },
        reason: 'Guard confirmed tank was actually Full- on inspection',
      }),
    }),
    env
  );
  assert.equal(supCorr.status, 201);

  const detailRes = await app.fetch(
    new Request(`http://localhost/api/trips/${hireOutBody.trip.id}`, {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  const detail = (await detailRes.json()) as TripDetail;
  assert.equal(detail.inRecord?.fuel_in, '1/4'); // Original stays intact!
  assert.equal(detail.corrections.length, 1);
  assert.equal(detail.trip.correction_count, 1);
});
