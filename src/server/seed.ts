import { DEFAULT_SETTINGS } from '../shared/types';
import { recordAudit } from './audit';
import { hashPin } from './crypto';
import type { AppEnv, D1DatabaseLike } from './types';

let seedChecked = false;

export async function ensureInitialSeed(db: D1DatabaseLike, env: Partial<AppEnv>): Promise<void> {
  if (seedChecked) return;

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

export function resetSeedCacheForTests(): void {
  seedChecked = false;
}
