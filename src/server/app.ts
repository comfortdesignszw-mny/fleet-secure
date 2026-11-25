import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  DEFAULT_SETTINGS,
  ROLES,
  type AppSettings,
  type AuditLogEntry,
  type Role,
  type UserPublic,
} from '../shared/types';
import { recordAudit, verifyAuditChain } from './audit';
import { hashPin, signSession, verifyPin, verifySession } from './crypto';
import { registerDashboardRoutes } from './dashboard';
import { registerDirectoryRoutes } from './directories';
import {
  ensureInitialSeed,
  ensureUsersRoleConstraintAllowsFleetManager,
  seedPreviewDemoData,
  type DemoSeedCounts,
} from './seed';
import { notifyManagersInApp, registerNotificationRoutes } from './notifications';
import { registerMaintenanceRoutes } from './maintenance';
import { registerReportRoutes } from './reports';
import { registerTripRoutes } from './trips';
import type { AppEnv, D1DatabaseLike } from './types';

const SESSION_COOKIE = 'fleet_session';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

interface Variables {
  user?: UserPublic;
}

type AppContext = Context<{ Bindings: AppEnv; Variables: Variables }>;

function getSessionSecret(env: AppEnv): string {
  return env.SESSION_SECRET || 'dev-only-fleet-secure-secret-change-in-prod';
}

function getClientIp(c: AppContext): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function getUserAgent(c: AppContext): string {
  return c.req.header('user-agent') || '';
}

function isHttpsRequest(c: AppContext): boolean {
  const proto = (c.req.header('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (proto === 'https') return true;

  const cfVisitor = c.req.header('cf-visitor') || '';
  if (cfVisitor.includes('"https"')) return true;

  const origin = (c.req.header('origin') || '').trim().toLowerCase();
  if (origin.startsWith('https://')) return true;

  const referer = (c.req.header('referer') || '').trim().toLowerCase();
  if (referer.startsWith('https://')) return true;

  const effectiveHost = (c.req.header('x-forwarded-host') || c.req.header('host') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (
    effectiveHost.endsWith('.run.app') ||
    effectiveHost.endsWith('.pages.dev') ||
    effectiveHost.endsWith('.workers.dev')
  ) {
    return true;
  }

  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function getRequestSessionToken(c: AppContext): string | undefined {
  const cookieToken = getCookie(c, SESSION_COOKIE);
  if (cookieToken) return cookieToken;
  const authHeader = c.req.header('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

function getSessionCookieOptions(c: AppContext) {
  const https = isHttpsRequest(c);
  return {
    httpOnly: true,
    secure: https,
    sameSite: (https ? 'None' : 'Lax') as 'None' | 'Lax',
    ...(https ? { partitioned: true as const } : {}),
    path: '/',
  };
}

function mapUserRow(row: Record<string, unknown>): UserPublic {
  return {
    id: Number(row.id),
    username: String(row.username),
    full_name: String(row.full_name),
    role: row.role as Role,
    active: Number(row.active) === 1,
    must_change_pin: Number(row.must_change_pin) === 1,
    created_at: String(row.created_at),
  };
}

async function getAllSettings(db: D1DatabaseLike): Promise<AppSettings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const merged: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    merged[row.key] = row.value;
  }
  return merged as unknown as AppSettings;
}

export function createApp() {
  const app = new Hono<{ Bindings: AppEnv; Variables: Variables }>().basePath('/api');

  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    console.error('Unhandled API error:', msg, err);
    if (/too big|too large|SQLITE_TOOBIG|body limit/i.test(msg)) {
      return c.json(
        { error: 'Uploaded document is too large for the database. Please use a smaller image or PDF (under 700 KB).' },
        400
      );
    }
    return c.json(
      { error: 'Server error while processing this request. Please try again.' },
      500
    );
  });

  // Security headers & strict origin/CSRF checks
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'geolocation=(), microphone=()');
    c.header('Cache-Control', 'no-store');
  });

  // Ensure initial DB seed on first request
  app.use('*', async (c, next) => {
    await ensureInitialSeed(c.env.DB, c.env);
    await next();
  });

  // CSRF check for state-changing requests
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const origin = c.req.header('origin');
      if (origin) {
        const allowedHosts = new Set<string>();
        const host = c.req.header('host')?.trim().toLowerCase();
        if (host) allowedHosts.add(host);
        const forwardedHost = c.req
          .header('x-forwarded-host')
          ?.split(',')[0]
          ?.trim()
          .toLowerCase();
        if (forwardedHost) allowedHosts.add(forwardedHost);
        try {
          allowedHosts.add(new URL(c.req.url).host.toLowerCase());
        } catch {
          // ignore invalid request URL
        }
        if (c.env.APP_URL) {
          try {
            allowedHosts.add(new URL(c.env.APP_URL).host.toLowerCase());
          } catch {
            // ignore invalid APP_URL
          }
        }
        if (allowedHosts.size > 0) {
          try {
            const originHost = new URL(origin).host.toLowerCase();
            if (!allowedHosts.has(originHost)) {
              return c.json(
                { error: 'Request origin mismatch. Please reload the page and try again.' },
                403
              );
            }
          } catch {
            return c.json({ error: 'Invalid request origin.' }, 403);
          }
        }
      }
    }
    await next();
  });

  // Auth middleware helpers
  async function requireAuth(c: AppContext, next: Next) {
    const token = getRequestSessionToken(c);
    const payload = await verifySession(token, getSessionSecret(c.env));
    if (!payload) {
      return c.json({ error: 'Your session has expired. Please sign in again.' }, 401);
    }
    const row = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(payload.uid)
      .first<Record<string, unknown>>();

    if (!row || Number(row.active) !== 1) {
      deleteCookie(c, SESSION_COOKIE, getSessionCookieOptions(c));
      return c.json({ error: 'Your account is inactive. Contact an Administrator.' }, 401);
    }

    c.set('user', mapUserRow(row));
    await next();
  }

  function requireRole(allowed: Role[]) {
    return async (c: AppContext, next: Next) => {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'Authentication required.' }, 401);
      }
      if (!allowed.includes(user.role)) {
        return c.json(
          { error: 'You do not have permission for this action. Ask a Supervisor or Administrator.' },
          403
        );
      }
      await next();
    };
  }

  function requirePinChanged() {
    return async (c: AppContext, next: Next) => {
      const user = c.get('user');
      if (user?.must_change_pin) {
        return c.json({ error: 'Please change your initial PIN before continuing.' }, 403);
      }
      await next();
    };
  }

  // Health endpoint
  app.get('/health', (c) => {
    return c.json({ ok: true, service: 'fleet-secure', time: new Date().toISOString() });
  });

  // ---------------- PREVIEW SANDBOX & ADMIN SIGNUP ----------------
  app.get('/auth/preview-status', async (c) => {
    const previewSignupEnabled = c.env.ALLOW_PREVIEW_SIGNUP === 'true';
    const [vRow, dRow, tRow] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM vehicles').first<{ cnt: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM drivers').first<{ cnt: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM trips').first<{ cnt: number }>(),
    ]);
    return c.json({
      previewSignupEnabled,
      vehicleCount: vRow?.cnt ?? 0,
      driverCount: dRow?.cnt ?? 0,
      tripCount: tRow?.cnt ?? 0,
    });
  });

  app.post('/auth/signup-admin', async (c) => {
    if (c.env.ALLOW_PREVIEW_SIGNUP !== 'true') {
      return c.json(
        { error: 'Preview Admin sign-up is disabled in this environment.' },
        403
      );
    }

    let body: {
      full_name?: string;
      username?: string;
      pin?: string;
      load_demo_data?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request format.' }, 400);
    }

    const fullName = (body.full_name ?? '').trim();
    const username = (body.username ?? '').trim().toLowerCase();
    const pin = String(body.pin ?? '').trim();
    const loadDemoData = body.load_demo_data !== false;

    if (!fullName || fullName.length < 2) {
      return c.json({ error: 'Enter your full name (at least 2 characters).' }, 400);
    }
    if (!username || !/^[a-z0-9._-]{3,32}$/.test(username)) {
      return c.json(
        {
          error:
            'Username must be 3–32 characters using only letters, numbers, dots, underscores, or hyphens.',
        },
        400
      );
    }
    if (!pin || pin.length < 4 || pin.length > 64) {
      return c.json(
        { error: 'Choose a PIN or password between 4 and 64 characters.' },
        400
      );
    }

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: number }>();
    if (existing) {
      return c.json(
        { error: `Username "${username}" is already taken. Pick another username or sign in.` },
        409
      );
    }

    const pinHash = await hashPin(pin);
    const res = await c.env.DB.prepare(
      `INSERT INTO users (username, full_name, role, pin_hash, active, must_change_pin)
       VALUES (?, ?, 'ADMIN', ?, 1, 0)`
    )
      .bind(username, fullName, pinHash)
      .run();

    const newId = res.meta.last_row_id;

    await c.env.DB.prepare(
      `INSERT INTO notification_recipients (user_id, channel, destination, active)
       VALUES (?, 'IN_APP', '', 1)`
    )
      .bind(newId)
      .run();

    const createdRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(newId)
      .first<Record<string, unknown>>();
    const user = mapUserRow(createdRow!);

    const ip = getClientIp(c);
    const ua = getUserAgent(c);

    await recordAudit(c.env.DB, {
      userId: user.id,
      username: user.username,
      userRole: user.role,
      action: 'AUTH_PREVIEW_ADMIN_SIGNUP',
      entity: 'users',
      entityId: user.id,
      newValue: { username: user.username, full_name: user.full_name, role: 'ADMIN' },
      ip,
      userAgent: ua,
    });

    let demoSeeded: DemoSeedCounts | null = null;
    if (loadDemoData) {
      demoSeeded = await seedPreviewDemoData(c.env.DB, user.id);
      if (
        demoSeeded.vehiclesAdded > 0 ||
        demoSeeded.driversAdded > 0 ||
        demoSeeded.tripsAdded > 0
      ) {
        await recordAudit(c.env.DB, {
          userId: user.id,
          username: user.username,
          userRole: user.role,
          action: 'PREVIEW_DEMO_SEEDED',
          entity: 'system',
          entityId: 'demo',
          newValue: demoSeeded,
          ip,
          userAgent: ua,
        });
      }
    }

    const token = await signSession(
      { id: user.id, username: user.username, role: user.role },
      getSessionSecret(c.env)
    );

    setCookie(c, SESSION_COOKIE, token, {
      ...getSessionCookieOptions(c),
      maxAge: 60 * 60 * 12,
    });

    return c.json({ user, demoSeeded, sessionToken: token }, 201);
  });

  app.post('/demo/seed', requireAuth, requirePinChanged(), requireRole(['ADMIN']), async (c) => {
    if (c.env.ALLOW_PREVIEW_SIGNUP !== 'true') {
      return c.json({ error: 'Preview demo seeding is disabled in this environment.' }, 403);
    }
    const actor = c.get('user')!;
    const counts = await seedPreviewDemoData(c.env.DB, actor.id);

    if (counts.vehiclesAdded > 0 || counts.driversAdded > 0 || counts.tripsAdded > 0) {
      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'PREVIEW_DEMO_SEEDED',
        entity: 'system',
        entityId: 'demo',
        newValue: counts,
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });
    }

    return c.json({ ok: true, ...counts });
  });

  // ---------------- AUTH ----------------
  app.post('/auth/login', async (c) => {
    let body: { username?: string; pin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request format.' }, 400);
    }

    const username = (body.username ?? '').trim().toLowerCase();
    const pin = String(body.pin ?? '');

    if (!username || !pin) {
      return c.json({ error: 'Enter both your username and your PIN or password.' }, 400);
    }

    const ip = getClientIp(c);
    const ua = getUserAgent(c);
    const rateKey = `${ip}:${username}`;
    const now = new Date();

    const attemptRow = await c.env.DB.prepare(
      'SELECT attempts, first_attempt_at, locked_until FROM login_attempts WHERE key = ?'
    )
      .bind(rateKey)
      .first<{ attempts: number; first_attempt_at: string; locked_until: string | null }>();

    if (attemptRow?.locked_until && new Date(attemptRow.locked_until) > now) {
      const minsLeft = Math.max(
        1,
        Math.ceil((new Date(attemptRow.locked_until).getTime() - now.getTime()) / 60_000)
      );
      return c.json(
        {
          error: `Too many wrong PIN attempts. Please wait ${minsLeft} minute${minsLeft === 1 ? '' : 's'} and try again.`,
        },
        429
      );
    }

    const userRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, pin_hash, active, must_change_pin, created_at FROM users WHERE username = ?'
    )
      .bind(username)
      .first<Record<string, unknown>>();

    const validPin = userRow ? await verifyPin(pin, String(userRow.pin_hash)) : false;

    if (!userRow || !validPin) {
      const windowExpired =
        attemptRow &&
        now.getTime() - new Date(attemptRow.first_attempt_at).getTime() > LOCKOUT_MINUTES * 60_000;

      const nextAttempts = windowExpired || !attemptRow ? 1 : attemptRow.attempts + 1;
      const lockedUntil =
        nextAttempts >= MAX_LOGIN_ATTEMPTS
          ? new Date(now.getTime() + LOCKOUT_MINUTES * 60_000).toISOString()
          : null;

      await c.env.DB.prepare(
        `INSERT INTO login_attempts (key, attempts, first_attempt_at, locked_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           attempts = excluded.attempts,
           first_attempt_at = CASE WHEN ? THEN excluded.first_attempt_at ELSE login_attempts.first_attempt_at END,
           locked_until = excluded.locked_until`
      )
        .bind(rateKey, nextAttempts, now.toISOString(), lockedUntil, windowExpired ? 1 : 0)
        .run();

      await recordAudit(c.env.DB, {
        userId: userRow ? Number(userRow.id) : null,
        username,
        userRole: userRow ? String(userRow.role) : 'UNKNOWN',
        action: lockedUntil ? 'AUTH_LOGIN_LOCKOUT' : 'AUTH_LOGIN_FAILED',
        entity: 'auth',
        entityId: username,
        newValue: { attempts: nextAttempts, locked: Boolean(lockedUntil) },
        ip,
        userAgent: ua,
      });

      if (lockedUntil) {
        await notifyManagersInApp(
          c.env.DB,
          {
            eventType: 'AUTH_LOCKOUT',
            priority: 'HIGH',
            title: `Login locked for "${username}"`,
            body: `Account "${username}" was temporarily locked after ${MAX_LOGIN_ATTEMPTS} failed sign-in attempts from ${ip}.`,
          },
          { env: c.env }
        );

        return c.json(
          {
            error: `Too many wrong PIN attempts. Sign-in is locked for ${LOCKOUT_MINUTES} minutes. Ask an Administrator if you forgot your PIN.`,
          },
          429
        );
      }

      return c.json(
        { error: 'Username or PIN is incorrect. Check your spelling and try again.' },
        401
      );
    }

    if (Number(userRow.active) !== 1) {
      return c.json(
        { error: 'This account has been disabled. Contact your Administrator.' },
        403
      );
    }

    // Clear failed attempts on success
    await c.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(rateKey).run();

    const user = mapUserRow(userRow);
    const token = await signSession(
      { id: user.id, username: user.username, role: user.role },
      getSessionSecret(c.env)
    );

    setCookie(c, SESSION_COOKIE, token, {
      ...getSessionCookieOptions(c),
      maxAge: 60 * 60 * 12,
    });

    await recordAudit(c.env.DB, {
      userId: user.id,
      username: user.username,
      userRole: user.role,
      action: 'AUTH_LOGIN_SUCCESS',
      entity: 'users',
      entityId: user.id,
      ip,
      userAgent: ua,
    });

    return c.json({ user, sessionToken: token });
  });

  app.post('/auth/logout', async (c) => {
    const token = getRequestSessionToken(c);
    const payload = await verifySession(token, getSessionSecret(c.env));
    deleteCookie(c, SESSION_COOKIE, getSessionCookieOptions(c));

    if (payload) {
      await recordAudit(c.env.DB, {
        userId: payload.uid,
        username: payload.username,
        userRole: payload.role,
        action: 'AUTH_LOGOUT',
        entity: 'users',
        entityId: payload.uid,
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });
    }

    return c.json({ ok: true });
  });

  app.get('/auth/me', requireAuth, async (c) => {
    const user = c.get('user')!;
    return c.json({ user });
  });

  app.post('/auth/change-pin', requireAuth, async (c) => {
    const user = c.get('user')!;
    let body: { currentPin?: string; newPin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request format.' }, 400);
    }

    const currentPin = String(body.currentPin ?? '');
    const newPin = String(body.newPin ?? '').trim();

    if (!currentPin || !newPin) {
      return c.json({ error: 'Enter both your current PIN and your new PIN.' }, 400);
    }
    if (newPin.length < 4 || newPin.length > 64) {
      return c.json({ error: 'Your new PIN or password must be at least 4 characters long.' }, 400);
    }
    if (newPin === currentPin) {
      return c.json({ error: 'Choose a new PIN that is different from your current one.' }, 400);
    }

    const row = await c.env.DB.prepare('SELECT pin_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ pin_hash: string }>();

    if (!row || !(await verifyPin(currentPin, row.pin_hash))) {
      return c.json({ error: 'Your current PIN is not correct.' }, 400);
    }

    const nextHash = await hashPin(newPin);
    await c.env.DB.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0 WHERE id = ?')
      .bind(nextHash, user.id)
      .run();

    await recordAudit(c.env.DB, {
      userId: user.id,
      username: user.username,
      userRole: user.role,
      action: 'AUTH_CHANGE_PIN',
      entity: 'users',
      entityId: user.id,
      newValue: { must_change_pin: false },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    const updatedRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(user.id)
      .first<Record<string, unknown>>();

    const updatedUser = mapUserRow(updatedRow!);
    const refreshedToken = await signSession(
      { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role },
      getSessionSecret(c.env)
    );
    setCookie(c, SESSION_COOKIE, refreshedToken, {
      ...getSessionCookieOptions(c),
      maxAge: 60 * 60 * 12,
    });

    return c.json({ user: updatedUser, sessionToken: refreshedToken });
  });

  // ---------------- SETTINGS ----------------
  app.get('/settings', requireAuth, requirePinChanged(), async (c) => {
    const settings = await getAllSettings(c.env.DB);
    return c.json({ settings });
  });

  app.put('/settings', requireAuth, requirePinChanged(), requireRole(['ADMIN']), async (c) => {
    const user = c.get('user')!;
    let body: Partial<AppSettings>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid settings payload.' }, 400);
    }

    const oldSettings = await getAllSettings(c.env.DB);
    const allowedKeys = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];
    const numericPositiveKeys: (keyof AppSettings)[] = [
      'economy_tank_litres',
      'economy_km_per_litre',
      'heavy_tank_litres',
      'heavy_km_per_litre',
      'fuel_mismatch_threshold_pct',
      'overdue_hire_hours',
    ];

    const updates: Partial<AppSettings> = {};
    for (const key of allowedKeys) {
      if (body[key] === undefined) continue;
      const val = String(body[key]).trim();
      if (!val) {
        return c.json({ error: `Setting "${key}" cannot be empty.` }, 400);
      }
      if (numericPositiveKeys.includes(key)) {
        const num = Number(val);
        if (!Number.isFinite(num) || num <= 0) {
          return c.json({ error: `Setting "${key}" must be a positive number.` }, 400);
        }
        if (key === 'fuel_mismatch_threshold_pct' && num > 100) {
          return c.json({ error: 'Fuel mismatch threshold cannot exceed 100%.' }, 400);
        }
      }
      updates[key] = val;
    }

    for (const [key, value] of Object.entries(updates)) {
      await c.env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
        .bind(key, value)
        .run();
    }

    const newSettings = await getAllSettings(c.env.DB);

    await recordAudit(c.env.DB, {
      userId: user.id,
      username: user.username,
      userRole: user.role,
      action: 'SETTINGS_UPDATED',
      entity: 'settings',
      entityId: 'global',
      oldValue: oldSettings,
      newValue: newSettings,
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    return c.json({ settings: newSettings });
  });

  // ---------------- USERS (ADMIN ONLY) ----------------
  app.get('/users', requireAuth, requirePinChanged(), requireRole(['ADMIN']), async (c) => {
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const page = Math.max(1, Number(c.req.query('page') || 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
    const offset = (page - 1) * limit;

    let whereSql = '';
    const params: unknown[] = [];
    if (q) {
      whereSql = 'WHERE LOWER(username) LIKE ? OR LOWER(full_name) LIKE ?';
      params.push(`%${q}%`, `%${q}%`);
    }

    const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM users ${whereSql}`)
      .bind(...params)
      .first<{ total: number }>();

    const { results } = await c.env.DB.prepare(
      `SELECT id, username, full_name, role, active, must_change_pin, created_at
       FROM users ${whereSql}
       ORDER BY active DESC, full_name ASC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>();

    return c.json({
      items: results.map(mapUserRow),
      total: countRow?.total ?? 0,
      page,
      limit,
    });
  });

  app.post('/users', requireAuth, requirePinChanged(), requireRole(['ADMIN']), async (c) => {
    const actor = c.get('user')!;
    let body: { username?: string; full_name?: string; role?: Role; pin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body.' }, 400);
    }

    const username = (body.username || '').trim().toLowerCase();
    const fullName = (body.full_name || '').trim();
    const role = body.role;
    const pin = String(body.pin || '').trim();

    if (!username || !/^[a-z0-9._-]{3,32}$/.test(username)) {
      return c.json(
        { error: 'Username must be 3–32 characters using only letters, numbers, dots, underscores, or hyphens.' },
        400
      );
    }
    if (!fullName || fullName.length < 2) {
      return c.json({ error: 'Enter the staff member’s full name.' }, 400);
    }
    if (!role || !ROLES.includes(role)) {
      return c.json(
        { error: 'Choose a valid role: Driver, Supervisor, Fleet Manager / Supervisor, or Admin.' },
        400
      );
    }
    if (!pin || pin.length < 4) {
      return c.json({ error: 'Set an initial PIN or password of at least 4 characters.' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?')
      .bind(username)
      .first<{ id: number }>();
    if (existing) {
      return c.json({ error: `Username "${username}" is already taken.` }, 409);
    }

    const pinHash = await hashPin(pin);
    const insertUser = async () =>
      c.env.DB.prepare(
        `INSERT INTO users (username, full_name, role, pin_hash, active, must_change_pin)
         VALUES (?, ?, ?, ?, 1, 1)`
      )
        .bind(username, fullName, role, pinHash)
        .run();

    let res;
    try {
      res = await insertUser();
    } catch (insertErr) {
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
      if (/check constraint/i.test(msg)) {
        const migrated = await ensureUsersRoleConstraintAllowsFleetManager(c.env.DB);
        if (migrated) {
          res = await insertUser();
        } else {
          throw insertErr;
        }
      } else {
        throw insertErr;
      }
    }

    const newId = res.meta.last_row_id;

    // Auto-create default IN_APP notification recipient for Supervisors, Fleet Managers, and Admins
    if (role === 'SUPERVISOR' || role === 'FLEET_MANAGER' || role === 'ADMIN') {
      try {
        const hasInApp = await c.env.DB.prepare(
          `SELECT id FROM notification_recipients WHERE user_id = ? AND channel = 'IN_APP'`
        )
          .bind(newId)
          .first<{ id: number }>();
        if (!hasInApp) {
          await c.env.DB.prepare(
            `INSERT INTO notification_recipients (user_id, channel, destination, active)
             VALUES (?, 'IN_APP', '', 1)`
          )
            .bind(newId)
            .run();
        }
      } catch (recErr) {
        console.warn('Could not auto-create IN_APP notification recipient:', recErr);
      }
    }

    const createdRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(newId)
      .first<Record<string, unknown>>();

    const created = mapUserRow(createdRow!);

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: 'USER_CREATED',
      entity: 'users',
      entityId: newId,
      newValue: { username: created.username, full_name: created.full_name, role: created.role },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    return c.json({ user: created }, 201);
  });

  app.patch('/users/:id', requireAuth, requirePinChanged(), requireRole(['ADMIN']), async (c) => {
    const actor = c.get('user')!;
    const targetId = Number(c.req.param('id'));
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return c.json({ error: 'Invalid user ID.' }, 400);
    }

    const existingRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first<Record<string, unknown>>();

    if (!existingRow) {
      return c.json({ error: 'User account not found.' }, 404);
    }

    const oldUser = mapUserRow(existingRow);

    let body: { full_name?: string; role?: Role; active?: boolean; resetPin?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body.' }, 400);
    }

    const nextFullName = body.full_name !== undefined ? body.full_name.trim() : oldUser.full_name;
    const nextRole = body.role !== undefined ? body.role : oldUser.role;
    const nextActive = body.active !== undefined ? Boolean(body.active) : oldUser.active;

    if (!nextFullName || nextFullName.length < 2) {
      return c.json({ error: 'Full name must be at least 2 characters.' }, 400);
    }
    if (!ROLES.includes(nextRole)) {
      return c.json({ error: 'Invalid role selected.' }, 400);
    }

    // Prevent removing the last active Admin
    if (oldUser.role === 'ADMIN' && (nextRole !== 'ADMIN' || !nextActive)) {
      const adminCountRow = await c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE role = 'ADMIN' AND active = 1 AND id != ?`
      )
        .bind(targetId)
        .first<{ cnt: number }>();

      if ((adminCountRow?.cnt ?? 0) === 0) {
        return c.json(
          { error: 'You cannot disable or demote the last active Administrator.' },
          400
        );
      }
    }

    const runUpdate = async () => {
      if (body.resetPin !== undefined) {
        const resetPin = String(body.resetPin).trim();
        if (resetPin.length < 4) {
          return { invalidPin: true as const };
        }
        const newHash = await hashPin(resetPin);
        await c.env.DB.prepare(
          `UPDATE users SET full_name = ?, role = ?, active = ?, pin_hash = ?, must_change_pin = 1 WHERE id = ?`
        )
          .bind(nextFullName, nextRole, nextActive ? 1 : 0, newHash, targetId)
          .run();
      } else {
        await c.env.DB.prepare(`UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?`)
          .bind(nextFullName, nextRole, nextActive ? 1 : 0, targetId)
          .run();
      }
      return { invalidPin: false as const };
    };

    try {
      const updateOutcome = await runUpdate();
      if (updateOutcome.invalidPin) {
        return c.json({ error: 'Reset PIN must be at least 4 characters.' }, 400);
      }
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      if (/check constraint/i.test(msg)) {
        const migrated = await ensureUsersRoleConstraintAllowsFleetManager(c.env.DB);
        if (migrated) {
          const retryOutcome = await runUpdate();
          if (retryOutcome.invalidPin) {
            return c.json({ error: 'Reset PIN must be at least 4 characters.' }, 400);
          }
        } else {
          throw updateErr;
        }
      } else {
        throw updateErr;
      }
    }

    if (
      nextActive &&
      (nextRole === 'SUPERVISOR' || nextRole === 'FLEET_MANAGER' || nextRole === 'ADMIN')
    ) {
      try {
        const hasInApp = await c.env.DB.prepare(
          `SELECT id FROM notification_recipients WHERE user_id = ? AND channel = 'IN_APP'`
        )
          .bind(targetId)
          .first<{ id: number }>();
        if (!hasInApp) {
          await c.env.DB.prepare(
            `INSERT INTO notification_recipients (user_id, channel, destination, active)
             VALUES (?, 'IN_APP', '', 1)`
          )
            .bind(targetId)
            .run();
        }
      } catch (recErr) {
        console.warn('Could not ensure IN_APP notification recipient:', recErr);
      }
    }

    const updatedRow = await c.env.DB.prepare(
      'SELECT id, username, full_name, role, active, must_change_pin, created_at FROM users WHERE id = ?'
    )
      .bind(targetId)
      .first<Record<string, unknown>>();
    const updatedUser = mapUserRow(updatedRow!);

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: body.resetPin ? 'USER_PIN_RESET' : 'USER_UPDATED',
      entity: 'users',
      entityId: targetId,
      oldValue: { full_name: oldUser.full_name, role: oldUser.role, active: oldUser.active },
      newValue: {
        full_name: updatedUser.full_name,
        role: updatedUser.role,
        active: updatedUser.active,
        pin_reset: Boolean(body.resetPin),
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    return c.json({ user: updatedUser });
  });

  // ---------------- AUDIT LOG (SUPERVISOR / ADMIN, READ-ONLY) ----------------
  app.get(
    '/audit-log',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const q = (c.req.query('q') || '').trim().toLowerCase();
      const action = (c.req.query('action') || '').trim();
      const entity = (c.req.query('entity') || '').trim();
      const page = Math.max(1, Number(c.req.query('page') || 1));
      const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
      const offset = (page - 1) * limit;

      const clauses: string[] = [];
      const params: unknown[] = [];

      if (q) {
        clauses.push(
          '(LOWER(username) LIKE ? OR LOWER(action) LIKE ? OR LOWER(entity) LIKE ? OR LOWER(entity_id) LIKE ? OR LOWER(COALESCE(new_json, "")) LIKE ?)'
        );
        const like = `%${q}%`;
        params.push(like, like, like, like, like);
      }
      if (action) {
        clauses.push('action = ?');
        params.push(action);
      }
      if (entity) {
        clauses.push('entity = ?');
        params.push(entity);
      }

      const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM audit_log ${whereSql}`)
        .bind(...params)
        .first<{ total: number }>();

      const { results } = await c.env.DB.prepare(
        `SELECT id, ts, user_id, username, user_role, action, entity, entity_id, old_json, new_json, ip, user_agent, prev_hash, hash
         FROM audit_log ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`
      )
        .bind(...params, limit, offset)
        .all<AuditLogEntry>();

      return c.json({
        items: results,
        total: countRow?.total ?? 0,
        page,
        limit,
      });
    }
  );

  app.post(
    '/audit-log/verify',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const result = await verifyAuditChain(c.env.DB);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'AUDIT_CHAIN_VERIFIED',
        entity: 'audit_log',
        entityId: 'chain',
        newValue: result,
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ result });
    }
  );

  registerDirectoryRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  registerTripRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  registerDashboardRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  registerNotificationRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  registerReportRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  registerMaintenanceRoutes(app, {
    requireAuth,
    requirePinChanged,
    requireRole,
    getClientIp,
    getUserAgent,
  });

  return app;
}
