/**
 * Removable demo seed script for Fleet Secure.
 * Seeds 10 vehicles and 8 drivers into the local SQLite database.
 * Run with: npx tsx scripts/seed-demo.ts
 */
import { createLocalDatabase } from '../src/server/local-d1';
import { ensureInitialSeed } from '../src/server/seed';
import { VEHICLE_TYPE_TO_CLASS } from '../src/shared/types';

async function main() {
  const db = createLocalDatabase();
  await ensureInitialSeed(db, {
    INITIAL_ADMIN_USERNAME: process.env.INITIAL_ADMIN_USERNAME,
    INITIAL_ADMIN_PIN: process.env.INITIAL_ADMIN_PIN,
    INITIAL_ADMIN_NAME: process.env.INITIAL_ADMIN_NAME,
  });

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

  for (const v of vehicles) {
    const vClass = VEHICLE_TYPE_TO_CLASS[v.type];
    await db
      .prepare(
        `INSERT OR IGNORE INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(v.reg, v.type, vClass, v.make, v.cond, v.km)
      .run();
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

  for (const d of drivers) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO drivers (full_name, licence_number, phone, address, licence_expiry, active)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .bind(d.name, d.lic, d.phone, d.addr, d.exp)
      .run();
  }

  console.log('Seeded 10 vehicles and 8 drivers.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
