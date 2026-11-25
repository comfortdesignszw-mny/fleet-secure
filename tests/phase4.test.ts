import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server/app';
import { LocalD1Adapter } from '../src/server/local-d1';
import { resetSeedCacheForTests } from '../src/server/seed';
import type { AppEnv } from '../src/server/types';
import type { DashboardData, TripSummary } from '../src/shared/types';

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

test('Dashboard is readable by all logged-in roles and aggregates fleet, mileage, fuel, flags, and date ranges', async () => {
  const { db, env } = createTestEnv();
  const app = createApp();

  // Unauthenticated access denied
  const anonRes = await app.fetch(new Request('http://localhost/api/dashboard'), env);
  assert.equal(anonRes.status, 401);

  const adminCookie = await loginAndChangePin(app, env, 'admin', '1234', '9999');

  // Create Driver & Supervisor
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'drv_dash', full_name: 'Yard Driver', role: 'DRIVER', pin: '1111' }),
    }),
    env
  );
  await app.fetch(
    new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ username: 'sup_dash', full_name: 'Supervisor', role: 'SUPERVISOR', pin: '2222' }),
    }),
    env
  );
  const drvCookie = await loginAndChangePin(app, env, 'drv_dash', '1111', '1188');
  const supCookie = await loginAndChangePin(app, env, 'sup_dash', '2222', '2288');

  // Create 4 vehicles: v1 (Economy), v2 (Heavy), v3 (Economy - will be on errand), v4 (Grounded)
  const createVehicle = async (
    reg: string,
    type: string,
    make: string,
    cond: string,
    km: number,
    cookie = supCookie
  ) => {
    const res = await app.fetch(
      new Request('http://localhost/api/vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          reg_number: reg,
          vehicle_type: type,
          make_model: make,
          condition: cond,
          last_known_mileage: km,
        }),
      }),
      env
    );
    assert.equal(res.status, 201);
    return ((await res.json()) as { vehicle: { id: number } }).vehicle;
  };

  const v1 = await createVehicle('ADA 1001', 'Sedan', 'Toyota Corolla', 'Good', 10000);
  const v2 = await createVehicle('ADA 1002', 'Double Cab', 'Toyota Hilux', 'Very Good', 50000);
  const v3 = await createVehicle('ADA 1003', 'Hatchback', 'Honda Fit', 'Good', 20000);
  await createVehicle('ADA 1004', 'Sedan', 'Nissan Almera', 'Grounded', 40000, adminCookie);

  // Create 2 drivers
  const createDriver = async (name: string, lic: string) => {
    const res = await app.fetch(
      new Request('http://localhost/api/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: supCookie },
        body: JSON.stringify({
          full_name: name,
          licence_number: lic,
          phone: '+263771000111',
          address: 'Harare',
          licence_expiry: '2029-12-31',
        }),
      }),
      env
    );
    assert.equal(res.status, 201);
    return ((await res.json()) as { driver: { id: number } }).driver;
  };

  const d1 = await createDriver('Tinashe Moyo', 'LIC-01');
  const d2 = await createDriver('Rudo Ncube', 'LIC-02');

  // Trip 1 (CLOSED, v2 Heavy): 200 km -> 25.0L est, Full -> 1/2 (40L gauge) => no mismatch if within 25% of 80L=20L (diff 15L <= 20L)
  const t1OutRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v2.id,
        driver_id: d1.id,
        client_name: 'Alpha Mining',
        mileage_out: 50000,
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(t1OutRes.status, 201);
  const t1 = ((await t1OutRes.json()) as { trip: TripSummary }).trip;

  const t1InRes = await app.fetch(
    new Request(`http://localhost/api/trips/${t1.id}/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        mileage_in: 50200,
        fuel_in: '1/2',
        closing_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(t1InRes.status, 200);

  // Trip 2 (OPEN HIRE, v1 Economy): backdate out_at by 30 hours so it is OVERDUE (> 24h)
  const t2OutRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'HIRE',
        vehicle_id: v1.id,
        driver_id: d1.id,
        client_name: 'Beta Logistics',
        mileage_out: 10050, // +50km gap -> raises UNRECORDED_GAP flag too
        fuel_out: 'Full',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(t2OutRes.status, 201);
  const t2 = ((await t2OutRes.json()) as { trip: TripSummary }).trip;

  // Move t2 out_at 30 hours earlier in DB to verify overdue detection & oldest-first ordering
  const thirtyHoursAgo = new Date(Date.now() - 30 * 3_600_000).toISOString();
  await db.prepare('UPDATE trip_out SET out_at = ? WHERE trip_id = ?').bind(thirtyHoursAgo, t2.id).run();

  // Trip 3 (OPEN ERRAND, v3 Economy): just left now
  const t3OutRes = await app.fetch(
    new Request('http://localhost/api/trips/out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: drvCookie },
      body: JSON.stringify({
        trip_type: 'ERRAND',
        vehicle_id: v3.id,
        driver_id: d2.id,
        destination: 'ZIMRA Kurima House',
        reason: 'Tax clearance',
        mileage_out: 20000,
        fuel_out: '3/4',
        opening_checklist_by: 'Yard Driver',
      }),
    }),
    env
  );
  assert.equal(t3OutRes.status, 201);
  const t3 = ((await t3OutRes.json()) as { trip: TripSummary }).trip;

  // Verify DRIVER, SUPERVISOR, and ADMIN can all read /api/dashboard
  for (const cookie of [drvCookie, supCookie, adminCookie]) {
    const res = await app.fetch(
      new Request('http://localhost/api/dashboard', { headers: { Cookie: cookie } }),
      env
    );
    assert.equal(res.status, 200);
  }

  const dashRes = await app.fetch(
    new Request('http://localhost/api/dashboard', { headers: { Cookie: drvCookie } }),
    env
  );
  const dash = (await dashRes.json()) as DashboardData;

  assert.equal(dash.cards.total_fleet, 4);
  assert.equal(dash.cards.total_drivers, 2);
  assert.equal(dash.cards.out_on_hire, 1); // v1
  assert.equal(dash.cards.out_on_errand, 1); // v3
  assert.equal(dash.cards.available_vehicles, 1); // v2 only (v4 is Grounded)
  assert.equal(dash.cards.mileage_this_month, 200);
  assert.equal(dash.cards.est_fuel_this_month, 25);
  assert.equal(dash.cards.overdue_hires, 1);
  assert.equal(dash.cards.flagged_trips, 1); // t2 has UNRECORDED_GAP + OVERDUE

  // Longest vehicles out: oldest out_at first (t2 before t3)
  assert.equal(dash.longest_vehicles_out.length, 2);
  assert.equal(dash.longest_vehicles_out[0].id, t2.id);
  assert.equal(dash.longest_vehicles_out[0].is_overdue, true);
  assert.equal(dash.longest_vehicles_out[1].id, t3.id);
  assert.equal(dash.longest_vehicles_out[1].is_overdue, false);

  // Top mileage vehicles includes v2 with 200 km
  assert.equal(dash.top_mileage_vehicles.length, 1);
  assert.equal(dash.top_mileage_vehicles[0].reg_number, 'ADA 1002');
  assert.equal(dash.top_mileage_vehicles[0].total_mileage, 200);

  // All 4 active vehicles appear in vehicle_stats
  assert.equal(dash.vehicle_stats.length, 4);

  // Custom date range outside current dates should show 0 range-filtered trips while keeping live fleet counts
  const pastDashRes = await app.fetch(
    new Request('http://localhost/api/dashboard?from=2020-01-01&to=2020-01-07', {
      headers: { Cookie: drvCookie },
    }),
    env
  );
  assert.equal(pastDashRes.status, 200);
  const pastDash = (await pastDashRes.json()) as DashboardData;
  assert.equal(pastDash.range.from, '2020-01-01');
  assert.equal(pastDash.range.to, '2020-01-07');
  assert.equal(pastDash.daily_trips.length, 7);
  assert.equal(pastDash.top_mileage_vehicles.length, 0);
  assert.equal(pastDash.cards.out_on_hire, 1);
});
