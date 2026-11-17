import { checkAndNotifyOverdueHires } from '../src/server/notifications';
import type { AppEnv } from '../src/server/types';

/**
 * Optional Cloudflare Worker Cron Trigger for hourly overdue-hire checks
 * even when no manager has the dashboard open.
 * Deploy with: `npx wrangler deploy -c wrangler.cron.toml`
 */
export default {
  async scheduled(_event: unknown, env: AppEnv): Promise<void> {
    await checkAndNotifyOverdueHires(env.DB, { env });
  },
};
