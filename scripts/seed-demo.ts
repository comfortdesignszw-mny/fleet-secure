/**
 * Removable demo seed script for Fleet Secure.
 * Seeds 10 vehicles and 8 drivers into the local SQLite database.
 * Run with: npx tsx scripts/seed-demo.ts
 */
import { createLocalDatabase } from '../src/server/local-d1';
import { ensureInitialSeed, seedPreviewDemoData } from '../src/server/seed';

async function main() {
  const db = createLocalDatabase();
  await ensureInitialSeed(db, {
    INITIAL_ADMIN_USERNAME: process.env.INITIAL_ADMIN_USERNAME,
    INITIAL_ADMIN_PIN: process.env.INITIAL_ADMIN_PIN,
    INITIAL_ADMIN_NAME: process.env.INITIAL_ADMIN_NAME,
  });

  const counts = await seedPreviewDemoData(db);
  console.log(
    `Seeded ${counts.vehiclesAdded} new vehicles, ${counts.driversAdded} new drivers, and ${counts.tripsAdded} sample trips.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
