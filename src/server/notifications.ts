import type { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  type NotificationChannel,
  type NotificationPriority,
  type NotificationRecipient,
  type NotificationRecord,
  type Role,
  type UserPublic,
} from '../shared/types';
import { recordAudit } from './audit';
import type { RouteAuthDeps } from './directories';
import type { AppEnv, D1DatabaseLike } from './types';

export interface ManagerNotificationInput {
  eventType: string;
  priority?: NotificationPriority;
  title: string;
  body: string;
  tripId?: number | null;
}

export interface DispatchOptions {
  env?: AppEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const VALID_CHANNELS: readonly NotificationChannel[] = ['IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH'];

/**
 * Clean stub for future WhatsApp Business Cloud API or Twilio integration.
 */
export async function sendWhatsApp(
  destination: string,
  message: string
): Promise<{ ok: boolean; stubbed: boolean }> {
  // TODO: Replace stub with WhatsApp Business Cloud API or Twilio API call once credentials are provisioned.
  if (!destination.trim() || !message.trim()) {
    return { ok: false, stubbed: true };
  }
  return { ok: true, stubbed: true };
}

/**
 * Non-blocking email dispatch via Resend REST API (compatible with Cloudflare Workers & Node fetch).
 */
export async function sendEmailNotification(params: {
  to: string;
  subject: string;
  text: string;
  env?: AppEnv;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const apiKey = params.env?.RESEND_API_KEY?.trim();
  const from = params.env?.EMAIL_FROM?.trim();
  if (!apiKey || !from || !params.to.trim()) {
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to.trim()],
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${detail.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Email request failed' };
  }
}

async function dispatchExternalChannels(
  db: D1DatabaseLike,
  input: ManagerNotificationInput,
  env?: AppEnv
): Promise<void> {
  try {
    const { results: recipients } = await db
      .prepare(
        `SELECT nr.channel, nr.destination
         FROM notification_recipients nr
         JOIN users u ON u.id = nr.user_id
         WHERE nr.active = 1
           AND u.active = 1
           AND u.role IN ('ADMIN', 'SUPERVISOR')
           AND nr.channel IN ('EMAIL', 'WHATSAPP')
           AND TRIM(nr.destination) != ''`
      )
      .all<{ channel: NotificationChannel; destination: string }>();

    const prefix = input.priority === 'HIGH' ? '[HIGH PRIORITY] ' : '';
    const subject = `${prefix}Fleet Secure — ${input.title}`;
    const text = `${input.title}\n\n${input.body}`;

    await Promise.allSettled(
      recipients.map(async (r) => {
        if (r.channel === 'EMAIL') {
          await sendEmailNotification({
            to: r.destination,
            subject,
            text,
            env,
          });
        } else if (r.channel === 'WHATSAPP') {
          await sendWhatsApp(r.destination, `${subject}\n${input.body}`);
        }
      })
    );
  } catch (err) {
    console.error('External notification dispatch error:', err);
  }
}

/**
 * Queues in-app notifications for every active Admin and Supervisor recipient,
 * and fires configured external Email/WhatsApp channels non-blockingly.
 * Never throws so directory/trip transactions cannot be blocked by delivery failures.
 */
export async function notifyManagersInApp(
  db: D1DatabaseLike,
  input: ManagerNotificationInput,
  options?: DispatchOptions
): Promise<void> {
  try {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT u.id
         FROM users u
         LEFT JOIN notification_recipients nr ON nr.user_id = u.id AND nr.channel = 'IN_APP'
         WHERE u.active = 1
           AND u.role IN ('ADMIN', 'SUPERVISOR')
           AND (nr.id IS NULL OR nr.active = 1)`
      )
      .all<{ id: number }>();

    for (const row of results) {
      await db
        .prepare(
          `INSERT INTO notifications (recipient_user_id, event_type, priority, title, body, trip_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.id,
          input.eventType,
          input.priority ?? 'NORMAL',
          input.title,
          input.body,
          input.tripId ?? null
        )
        .run();
    }

    const externalWork = dispatchExternalChannels(db, input, options?.env);
    if (options?.waitUntil) {
      options.waitUntil(externalWork);
    } else {
      // Fire-and-forget when no waitUntil context exists (Express/tests)
      void externalWork;
    }
  } catch (err) {
    console.error('Failed to queue manager notification:', err);
  }
}

/**
 * Scans open HIRE trips against `overdue_hire_hours` and creates HIGH-priority
 * alerts once per overdue trip. Safe to invoke on cron ticks or periodic polls.
 */
export async function checkAndNotifyOverdueHires(
  db: D1DatabaseLike,
  options?: DispatchOptions
): Promise<{ checked: number; newlyNotified: number }> {
  try {
    const settingRow = await db
      .prepare("SELECT value FROM settings WHERE key = 'overdue_hire_hours'")
      .first<{ value: string }>();
    const overdueHours = Number(settingRow?.value ?? DEFAULT_SETTINGS.overdue_hire_hours);
    const limitHours = Number.isFinite(overdueHours) && overdueHours > 0 ? overdueHours : 24;

    const { results: openHires } = await db
      .prepare(
        `SELECT t.id, t.client_name, v.reg_number, v.make_model, d.full_name AS driver_name, tout.out_at
         FROM trips t
         JOIN trip_out tout ON tout.trip_id = t.id
         JOIN vehicles v ON v.id = t.vehicle_id
         JOIN drivers d ON d.id = t.driver_id
         WHERE t.status = 'OPEN' AND t.trip_type = 'HIRE'`
      )
      .all<{
        id: number;
        client_name: string | null;
        reg_number: string;
        make_model: string;
        driver_name: string;
        out_at: string;
      }>();

    const nowMs = Date.now();
    let newlyNotified = 0;

    for (const hire of openHires) {
      const elapsedHours = (nowMs - new Date(hire.out_at).getTime()) / 3_600_000;
      if (elapsedHours <= limitHours) continue;

      const existingAlert = await db
        .prepare(
          `SELECT id FROM notifications WHERE event_type = 'HIRE_OVERDUE' AND trip_id = ? LIMIT 1`
        )
        .bind(hire.id)
        .first<{ id: number }>();

      if (existingAlert) continue;

      const hoursText = Math.floor(elapsedHours);
      await notifyManagersInApp(
        db,
        {
          eventType: 'HIRE_OVERDUE',
          priority: 'HIGH',
          title: `Overdue Hire: ${hire.reg_number} (${hoursText}h out)`,
          body: `${hire.reg_number} (${hire.make_model}) hired to ${hire.client_name || 'client'} with driver ${hire.driver_name} has been out for ${hoursText} hours (limit: ${limitHours}h).`,
          tripId: hire.id,
        },
        options
      );

      await recordAudit(db, {
        userId: null,
        username: 'system',
        userRole: 'SYSTEM',
        action: 'OVERDUE_HIRE_DETECTED',
        entity: 'trips',
        entityId: hire.id,
        newValue: {
          reg_number: hire.reg_number,
          elapsed_hours: hoursText,
          limit_hours: limitHours,
        },
      });

      newlyNotified++;
    }

    return { checked: openHires.length, newlyNotified };
  } catch (err) {
    console.error('Overdue hire check error:', err);
    return { checked: 0, newlyNotified: 0 };
  }
}

function mapNotificationRow(row: Record<string, unknown>): NotificationRecord {
  return {
    id: Number(row.id),
    recipient_user_id: Number(row.recipient_user_id),
    event_type: String(row.event_type),
    priority: (row.priority === 'HIGH' ? 'HIGH' : 'NORMAL') as NotificationPriority,
    title: String(row.title),
    body: String(row.body),
    trip_id: row.trip_id !== null && row.trip_id !== undefined ? Number(row.trip_id) : null,
    created_at: String(row.created_at),
    read_at: row.read_at ? String(row.read_at) : null,
  };
}

function getWaitUntil(c: unknown): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = (c as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') {
      return (p: Promise<unknown>) => ctx.waitUntil!(p);
    }
  } catch {
    // Ignore when running outside Cloudflare Workers (Node/Express)
  }
  return undefined;
}

export function registerNotificationRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // ---------------- INBOX (SUPERVISOR / ADMIN) ----------------
  app.get(
    '/notifications/unread-count',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const user = c.get('user')!;
      await checkAndNotifyOverdueHires(c.env.DB, {
        env: c.env,
        waitUntil: getWaitUntil(c),
      });

      const counts = await c.env.DB.prepare(
        `SELECT
           COUNT(*) as unread_count,
           SUM(CASE WHEN priority = 'HIGH' THEN 1 ELSE 0 END) as high_unread_count
         FROM notifications
         WHERE recipient_user_id = ? AND read_at IS NULL`
      )
        .bind(user.id)
        .first<{ unread_count: number; high_unread_count: number | null }>();

      return c.json({
        unreadCount: Number(counts?.unread_count ?? 0),
        highUnreadCount: Number(counts?.high_unread_count ?? 0),
      });
    }
  );

  app.get(
    '/notifications',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const user = c.get('user')!;
      await checkAndNotifyOverdueHires(c.env.DB, {
        env: c.env,
        waitUntil: getWaitUntil(c),
      });

      const unreadOnly = c.req.query('unreadOnly') === '1';
      const priority = (c.req.query('priority') || '').trim();
      const page = Math.max(1, Number(c.req.query('page') || 1));
      const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 30)));
      const offset = (page - 1) * limit;

      const clauses: string[] = ['recipient_user_id = ?'];
      const params: unknown[] = [user.id];

      if (unreadOnly) {
        clauses.push('read_at IS NULL');
      }
      if (priority === 'HIGH' || priority === 'NORMAL') {
        clauses.push('priority = ?');
        params.push(priority);
      }

      const whereSql = `WHERE ${clauses.join(' AND ')}`;

      const countRow = await c.env.DB.prepare(
        `SELECT COUNT(*) as total FROM notifications ${whereSql}`
      )
        .bind(...params)
        .first<{ total: number }>();

      const unreadRow = await c.env.DB.prepare(
        `SELECT COUNT(*) as unread FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL`
      )
        .bind(user.id)
        .first<{ unread: number }>();

      const { results } = await c.env.DB.prepare(
        `SELECT * FROM notifications ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
      )
        .bind(...params, limit, offset)
        .all<Record<string, unknown>>();

      return c.json({
        items: results.map(mapNotificationRow),
        total: Number(countRow?.total ?? 0),
        unreadCount: Number(unreadRow?.unread ?? 0),
        page,
        limit,
      });
    }
  );

  app.post(
    '/notifications/read-all',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const user = c.get('user')!;
      const nowIso = new Date().toISOString();
      const res = await c.env.DB.prepare(
        `UPDATE notifications SET read_at = ? WHERE recipient_user_id = ? AND read_at IS NULL`
      )
        .bind(nowIso, user.id)
        .run();

      return c.json({ ok: true, updated: res.meta.changes });
    }
  );

  app.post(
    '/notifications/:id/read',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const user = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid notification ID.' }, 400);
      }

      const existing = await c.env.DB.prepare(
        `SELECT * FROM notifications WHERE id = ? AND recipient_user_id = ?`
      )
        .bind(id, user.id)
        .first<Record<string, unknown>>();

      if (!existing) {
        return c.json({ error: 'Notification not found.' }, 404);
      }

      if (!existing.read_at) {
        await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), id)
          .run();
      }

      const updated = await c.env.DB.prepare(`SELECT * FROM notifications WHERE id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();

      return c.json({ notification: mapNotificationRow(updated!) });
    }
  );

  app.post(
    '/notifications/check-overdue',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const result = await checkAndNotifyOverdueHires(c.env.DB, {
        env: c.env,
        waitUntil: getWaitUntil(c),
      });
      return c.json(result);
    }
  );

  // ---------------- RECIPIENTS MANAGEMENT (ADMIN ONLY) ----------------
  app.get(
    '/notification-recipients',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const { results } = await c.env.DB.prepare(
        `SELECT nr.id, nr.user_id, u.username, u.full_name, u.role, nr.channel, nr.destination, nr.active
         FROM notification_recipients nr
         JOIN users u ON u.id = nr.user_id
         ORDER BY u.full_name ASC, nr.channel ASC`
      ).all<Record<string, unknown>>();

      const { results: managerRows } = await c.env.DB.prepare(
        `SELECT id, username, full_name, role
         FROM users
         WHERE active = 1 AND role IN ('SUPERVISOR', 'ADMIN')
         ORDER BY full_name ASC`
      ).all<{ id: number; username: string; full_name: string; role: Role }>();

      const items: NotificationRecipient[] = results.map((r) => ({
        id: Number(r.id),
        user_id: Number(r.user_id),
        username: String(r.username),
        full_name: String(r.full_name),
        role: r.role as Role,
        channel: r.channel as NotificationChannel,
        destination: String(r.destination ?? ''),
        active: Number(r.active) === 1,
      }));

      return c.json({
        items,
        managers: managerRows,
        emailConfigured: Boolean(c.env.RESEND_API_KEY && c.env.EMAIL_FROM),
      });
    }
  );

  app.post(
    '/notification-recipients',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        user_id?: number;
        channel?: NotificationChannel;
        destination?: string;
        active?: boolean;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const userId = Number(body.user_id);
      const channel = body.channel;
      const destination = (body.destination || '').trim();
      const active = body.active !== undefined ? Boolean(body.active) : true;

      if (!Number.isInteger(userId) || userId <= 0) {
        return c.json({ error: 'Select a Supervisor or Admin user.' }, 400);
      }
      if (!channel || !VALID_CHANNELS.includes(channel)) {
        return c.json({ error: 'Choose a valid notification channel.' }, 400);
      }
      if (channel === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
        return c.json({ error: 'Enter a valid email address for Email alerts.' }, 400);
      }
      if (channel === 'WHATSAPP' && destination.length < 7) {
        return c.json({ error: 'Enter a phone number with country code for WhatsApp alerts.' }, 400);
      }

      const targetUser = await c.env.DB.prepare(
        `SELECT id, username, full_name, role, active FROM users WHERE id = ?`
      )
        .bind(userId)
        .first<{ id: number; username: string; full_name: string; role: Role; active: number }>();

      if (!targetUser || targetUser.active !== 1) {
        return c.json({ error: 'Selected user account is inactive or missing.' }, 404);
      }
      if (targetUser.role !== 'SUPERVISOR' && targetUser.role !== 'ADMIN') {
        return c.json(
          { error: 'Only Supervisors and Administrators can receive management alerts.' },
          400
        );
      }

      const existing = await c.env.DB.prepare(
        `SELECT id FROM notification_recipients WHERE user_id = ? AND channel = ?`
      )
        .bind(userId, channel)
        .first<{ id: number }>();

      let recipientId: number;
      if (existing) {
        recipientId = existing.id;
        await c.env.DB.prepare(
          `UPDATE notification_recipients SET destination = ?, active = ? WHERE id = ?`
        )
          .bind(destination, active ? 1 : 0, recipientId)
          .run();
      } else {
        const res = await c.env.DB.prepare(
          `INSERT INTO notification_recipients (user_id, channel, destination, active)
           VALUES (?, ?, ?, ?)`
        )
          .bind(userId, channel, destination, active ? 1 : 0)
          .run();
        recipientId = res.meta.last_row_id;
      }

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: existing ? 'NOTIFICATION_RECIPIENT_UPDATED' : 'NOTIFICATION_RECIPIENT_CREATED',
        entity: 'notification_recipients',
        entityId: recipientId,
        newValue: {
          user_id: userId,
          username: targetUser.username,
          channel,
          destination,
          active,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json(
        {
          recipient: {
            id: recipientId,
            user_id: targetUser.id,
            username: targetUser.username,
            full_name: targetUser.full_name,
            role: targetUser.role,
            channel,
            destination,
            active,
          } satisfies NotificationRecipient,
        },
        existing ? 200 : 201
      );
    }
  );

  app.patch(
    '/notification-recipients/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid recipient ID.' }, 400);
      }

      const existing = await c.env.DB.prepare(
        `SELECT nr.*, u.username, u.full_name, u.role
         FROM notification_recipients nr
         JOIN users u ON u.id = nr.user_id
         WHERE nr.id = ?`
      )
        .bind(id)
        .first<Record<string, unknown>>();

      if (!existing) {
        return c.json({ error: 'Recipient not found.' }, 404);
      }

      let body: { destination?: string; active?: boolean };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const channel = existing.channel as NotificationChannel;
      const nextDestination =
        body.destination !== undefined ? body.destination.trim() : String(existing.destination ?? '');
      const nextActive =
        body.active !== undefined ? Boolean(body.active) : Number(existing.active) === 1;

      if (channel === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextDestination)) {
        return c.json({ error: 'Enter a valid email address for Email alerts.' }, 400);
      }

      await c.env.DB.prepare(
        `UPDATE notification_recipients SET destination = ?, active = ? WHERE id = ?`
      )
        .bind(nextDestination, nextActive ? 1 : 0, id)
        .run();

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'NOTIFICATION_RECIPIENT_UPDATED',
        entity: 'notification_recipients',
        entityId: id,
        oldValue: {
          destination: String(existing.destination ?? ''),
          active: Number(existing.active) === 1,
        },
        newValue: {
          destination: nextDestination,
          active: nextActive,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({
        recipient: {
          id,
          user_id: Number(existing.user_id),
          username: String(existing.username),
          full_name: String(existing.full_name),
          role: existing.role as Role,
          channel,
          destination: nextDestination,
          active: nextActive,
        } satisfies NotificationRecipient,
      });
    }
  );

  app.delete(
    '/notification-recipients/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid recipient ID.' }, 400);
      }

      const existing = await c.env.DB.prepare(
        `SELECT * FROM notification_recipients WHERE id = ?`
      )
        .bind(id)
        .first<Record<string, unknown>>();

      if (!existing) {
        return c.json({ error: 'Recipient not found.' }, 404);
      }

      await c.env.DB.prepare(`DELETE FROM notification_recipients WHERE id = ?`).bind(id).run();

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'NOTIFICATION_RECIPIENT_DELETED',
        entity: 'notification_recipients',
        entityId: id,
        oldValue: {
          user_id: Number(existing.user_id),
          channel: String(existing.channel),
          destination: String(existing.destination ?? ''),
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ ok: true });
    }
  );
}
