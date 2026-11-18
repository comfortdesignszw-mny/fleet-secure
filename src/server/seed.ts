import { DEFAULT_SETTINGS, VEHICLE_TYPE_TO_CLASS } from '../shared/types';
import { recordAudit } from './audit';
import { hashPin } from './crypto';
import type { AppEnv, D1DatabaseLike } from './types';

let seedChecked = false;

export async function ensureInitialSeed(db: D1DatabaseLike, env: Partial<AppEnv>): Promise<void> {
  if (seedChecked) return;

  // Ensure newer trip columns exist on pre-existing databases
  try {
    const tripCols = await db.prepare('PRAGMA table_info(trips)').all<{ name: string }>();
    const colNames = new Set(tripCols.results.map((c) => c.name));
    if (!colNames.has('days_hired')) {
      await db.exec('ALTER TABLE trips ADD COLUMN days_hired INTEGER');
    }
    if (!colNames.has('expected_return_date')) {
      await db.exec('ALTER TABLE trips ADD COLUMN expected_return_date TEXT');
    }
  } catch {
    // Ignore if table is freshly created from schema.sql
  }

  // Ensure all default settings keys exist
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  // Ensure at least one user exists; seed initial Admin from env
  const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
  if ((countRow?.cnt ?? 0) === 0) {
    const username = (env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const initialPin = env.INITIAL_ADMIN_PIN || '1234';
    const fullName = env.INITIAL_ADMIN_NAME || 'Fleet Administrator';
    const pinHash = await hashPin(initialPin);

    const res = await db
      .prepare(
        `INSERT INTO users (username, full_name, role, pin_hash, active, must_change_pin)
         VALUES (?, ?, 'ADMIN', ?, 1, 1)`
      )
      .bind(username, fullName, pinHash)
      .run();

    await db
      .prepare(
        `INSERT INTO notification_recipients (user_id, channel, destination, active)
         VALUES (?, 'IN_APP', '', 1)`
      )
      .bind(res.meta.last_row_id)
      .run();

    await recordAudit(db, {
      userId: res.meta.last_row_id,
      username,
      userRole: 'SYSTEM',
      action: 'SYSTEM_SEED_ADMIN',
      entity: 'users',
      entityId: res.meta.last_row_id,
      newValue: { username, full_name: fullName, role: 'ADMIN', must_change_pin: true },
    });
  }

  seedChecked = true;
}

export interface DemoSeedCounts {
  vehiclesAdded: number;
  driversAdded: number;
  tripsAdded: number;
}

export async function seedPreviewDemoData(
  db: D1DatabaseLike,
  actorId: number | null = null
): Promise<DemoSeedCounts> {
  const vehicles = [
    { reg: 'AFX 1024', type: 'Sedan', make: 'Toyota Corolla Quest', cond: 'Very Good', km: 42310 },
    { reg: 'AFX 1025', type: 'Hatchback', make: 'Honda Fit Hybrid', cond: 'Good', km: 68190 },
    { reg: 'AFY 2210', type: 'Mini SUV', make: 'Suzuki Vitara Brezza', cond: 'Very Good', km: 28400 },
    { reg: 'AFZ 3340', type: 'Double Cab', make: 'Toyota Hilux GD-6 4x4', cond: 'Good', km: 94120 },
    { reg: 'AGA 4102', type: 'Double Cab', make: 'Ford Ranger Wildtrak', cond: 'Needs Little Attention', km: 112500 },
    { reg: 'AGB 5518', type: 'SUV', make: 'Toyota Fortuner 2.8', cond: 'Very Good', km: 51200 },
    { reg: 'AGC 6091', type: 'Executive Sedan', make: 'Mercedes-Benz C200', cond: 'Good', km: 63900 },
    { reg: 'AGD 7712', type: 'Quantum', make: 'Toyota Quantum 14-Seater', cond: 'Good', km: 148300 },
    { reg: 'AGE 8804', type: 'Truck', make: 'Isuzu NPR 4-Ton', cond: 'Bad Condition', km: 210450 },
    { reg: 'AGF 9001', type: 'Sedan', make: 'Nissan Almera', cond: 'Grounded', km: 135800 },
  ];

  let vehiclesAdded = 0;
  for (const v of vehicles) {
    const vClass = VEHICLE_TYPE_TO_CLASS[v.type];
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(v.reg, v.type, vClass, v.make, v.cond, v.km)
      .run();
    vehiclesAdded += res.meta.changes ?? 0;
  }

  const now = new Date();
  const plusDays = (days: number) =>
    new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

  const drivers = [
    { name: 'Tendai Moyo', lic: 'ZW-884120', phone: '+263 77 234 5510', addr: '12 Fife Ave, Harare', exp: plusDays(320) },
    { name: 'Tatenda Ncube', lic: 'ZW-773190', phone: '+263 71 845 9012', addr: '45 Lobengula St, Bulawayo', exp: plusDays(18) },
    { name: 'Farai Chikwanda', lic: 'ZW-662019', phone: '+263 77 901 3344', addr: '8 Borrowdale Rd, Harare', exp: plusDays(540) },
    { name: 'Rumbidzai Gumbo', lic: 'ZW-559812', phone: '+263 78 412 8821', addr: '29 Josiah Tongogara, Harare', exp: plusDays(-5) },
    { name: 'Kudakwashe Sibanda', lic: 'ZW-441209', phone: '+263 77 512 1190', addr: '101 Churchill Ave, Harare', exp: plusDays(190) },
    { name: 'Blessing Ndlovu', lic: 'ZW-330918', phone: '+263 71 399 4401', addr: '19 Leopold Takawira, Harare', exp: plusDays(25) },
    { name: 'Nyasha Mutasa', lic: 'ZW-229104', phone: '+263 77 620 7788', addr: '53 Samora Machel Ave, Harare', exp: plusDays(410) },
    { name: 'Tafadzwa Dube', lic: 'ZW-118403', phone: '+263 78 730 9955', addr: '7 Enterprise Rd, Harare', exp: null },
  ];

  let driversAdded = 0;
  for (const d of drivers) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO drivers (full_name, licence_number, phone, address, licence_expiry, active, created_by)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(d.name, d.lic, d.phone, d.addr, d.exp, actorId)
      .run();
    driversAdded += res.meta.changes ?? 0;
  }

  // Seed 2 realistic sample trips only if there are no trips yet
  let tripsAdded = 0;
  const tripCountRow = await db.prepare('SELECT COUNT(*) as cnt FROM trips').first<{ cnt: number }>();
  if ((tripCountRow?.cnt ?? 0) === 0) {
    let recorderId = actorId;
    if (!recorderId) {
      const adminRow = await db
        .prepare("SELECT id FROM users WHERE active = 1 ORDER BY id ASC LIMIT 1")
        .first<{ id: number }>();
      recorderId = adminRow?.id ?? null;
    }

    const sedan = await db
      .prepare("SELECT id, last_known_mileage FROM vehicles WHERE reg_number = 'AFX 1024'")
      .first<{ id: number; last_known_mileage: number }>();
    const hilux = await db
      .prepare("SELECT id, last_known_mileage FROM vehicles WHERE reg_number = 'AFZ 3340'")
      .first<{ id: number; last_known_mileage: number }>();
    const driver1 = await db
      .prepare("SELECT id FROM drivers WHERE licence_number = 'ZW-884120'")
      .first<{ id: number }>();
    const driver2 = await db
      .prepare("SELECT id FROM drivers WHERE licence_number = 'ZW-662019'")
      .first<{ id: number }>();

    if (recorderId && sedan && driver1) {
      const outTime = new Date(now.getTime() - 26 * 3_600_000).toISOString();
      const inTime = new Date(now.getTime() - 4 * 3_600_000).toISOString();
      const startKm = Math.max(0, Number(sedan.last_known_mileage) - 180);
      const endKm = Number(sedan.last_known_mileage);

      const t1 = await db
        .prepare(
          `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name, created_at)
           VALUES ('HIRE', ?, ?, 'CLOSED', 'Harare Logistics Pvt', ?)`
        )
        .bind(sedan.id, driver1.id, outTime)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_out (trip_id, out_at, device_time, received_at, mileage_out, fuel_out, opening_checklist_by, notes, flags, recorded_by)
           VALUES (?, ?, ?, ?, ?, '3/4', 'Yard Supervisor', 'Client corporate day hire — spare wheel & jack verified', '[]', ?)`
        )
        .bind(t1.meta.last_row_id, outTime, outTime, outTime, startKm, recorderId)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_in (trip_id, in_at, device_time, received_at, mileage_in, fuel_in, closing_checklist_by, notes, recorded_by, total_mileage, est_fuel_litres, gauge_fuel_litres, flags)
           VALUES (?, ?, ?, ?, ?, '1/2', 'Yard Supervisor', 'Returned clean with no body damage', ?, 180, 18.0, 15.0, '[]')`
        )
        .bind(t1.meta.last_row_id, inTime, inTime, inTime, endKm, recorderId)
        .run();

      tripsAdded += 1;
    }

    if (recorderId && hilux && driver2) {
      const outTime = new Date(now.getTime() - 2 * 3_600_000).toISOString();
      const t2 = await db
        .prepare(
          `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, destination, reason, created_at)
           VALUES ('ERRAND', ?, ?, 'OPEN', 'CBD Licensing Office', 'ZINARA & vehicle fitness disc renewal', ?)`
        )
        .bind(hilux.id, driver2.id, outTime)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_out (trip_id, out_at, device_time, received_at, mileage_out, fuel_out, opening_checklist_by, notes, flags, recorded_by)
           VALUES (?, ?, ?, ?, ?, '1/2+', 'Yard Supervisor', 'Sample open trip ready for testing Return Errand flow', '[]', ?)`
        )
        .bind(t2.meta.last_row_id, outTime, outTime, outTime, Number(hilux.last_known_mileage), recorderId)
        .run();

      tripsAdded += 1;
    }
  }

  return { vehiclesAdded, driversAdded, tripsAdded };
}

export function resetSeedCacheForTests(): void {
  seedChecked = false;
}
