import type { Context, Hono, MiddlewareHandler } from 'hono';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_TYPE_TO_CLASS,
  type AuditLogEntry,
  type DerivedStatus,
  type Driver,
  type LicenceStatus,
  type Role,
  type UserPublic,
  type Vehicle,
  type VehicleCondition,
} from '../shared/types';
import { recordAudit } from './audit';
import { notifyManagersInApp } from './notifications';
import type { AppEnv } from './types';

export interface RouteAuthDeps {
  requireAuth: MiddlewareHandler;
  requirePinChanged: () => MiddlewareHandler;
  requireRole: (allowed: Role[]) => MiddlewareHandler;
  getClientIp: (c: Context<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>) => string;
  getUserAgent: (c: Context<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>) => string;
}

function toDerivedStatus(openTripType: unknown): DerivedStatus {
  if (openTripType === 'HIRE') return 'Out on Hire';
  if (openTripType === 'ERRAND') return 'Out on Errand';
  return 'Available';
}

export function computeLicenceExpiryStatus(
  licenceExpiry: string | null | undefined,
  now = new Date()
): { licence_status: LicenceStatus; days_to_expiry: number | null } {
  if (!licenceExpiry) {
    return { licence_status: 'NONE', days_to_expiry: null };
  }
  const parsed = new Date(`${licenceExpiry}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return { licence_status: 'NONE', days_to_expiry: null };
  }
  // Compare today's date in Africa/Harare (UTC+2)
  const harareTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const todayUtc = new Date(`${harareTodayStr}T00:00:00Z`);
  const days = Math.round((parsed.getTime() - todayUtc.getTime()) / 86_400_000);

  if (days < 0) return { licence_status: 'EXPIRED', days_to_expiry: days };
  if (days <= 30) return { licence_status: 'EXPIRING_SOON', days_to_expiry: days };
  return { licence_status: 'OK', days_to_expiry: days };
}

function mapVehicleRow(row: Record<string, unknown>): Vehicle {
  return {
    id: Number(row.id),
    reg_number: String(row.reg_number),
    vehicle_type: String(row.vehicle_type),
    vehicle_class: row.vehicle_class as 'ECONOMY' | 'HEAVY',
    make_model: String(row.make_model),
    condition: row.condition as VehicleCondition,
    last_known_mileage: Number(row.last_known_mileage),
    active: Number(row.active) === 1,
    created_at: String(row.created_at),
    derived_status: toDerivedStatus(row.open_trip_type),
    open_trip_id: row.open_trip_id ? Number(row.open_trip_id) : null,
    trip_count: row.trip_count !== undefined ? Number(row.trip_count) : undefined,
    total_trip_mileage:
      row.total_trip_mileage !== undefined ? Number(row.total_trip_mileage) : undefined,
  };
}

function mapDriverRow(row: Record<string, unknown>): Driver {
  const licenceExpiry = row.licence_expiry ? String(row.licence_expiry) : null;
  const { licence_status, days_to_expiry } = computeLicenceExpiryStatus(licenceExpiry);
  return {
    id: Number(row.id),
    full_name: String(row.full_name),
    licence_number: String(row.licence_number),
    phone: String(row.phone),
    address: String(row.address ?? ''),
    licence_expiry: licenceExpiry,
    active: Number(row.active) === 1,
    created_at: String(row.created_at),
    created_by: row.created_by ? Number(row.created_by) : null,
    derived_status: toDerivedStatus(row.open_trip_type),
    open_trip_id: row.open_trip_id ? Number(row.open_trip_id) : null,
    licence_status,
    days_to_expiry,
  };
}

const VEHICLE_SELECT_SQL = `
  SELECT
    v.*,
    ot.id AS open_trip_id,
    ot.trip_type AS open_trip_type,
    COALESCE((SELECT COUNT(*) FROM trips t WHERE t.vehicle_id = v.id), 0) AS trip_count,
    COALESCE((
      SELECT SUM(ti.total_mileage)
      FROM trips t
      JOIN trip_in ti ON ti.trip_id = t.id
      WHERE t.vehicle_id = v.id
    ), 0) AS total_trip_mileage
  FROM vehicles v
  LEFT JOIN trips ot ON ot.vehicle_id = v.id AND ot.status = 'OPEN'
`;

const DRIVER_SELECT_SQL = `
  SELECT
    d.*,
    ot.id AS open_trip_id,
    ot.trip_type AS open_trip_type
  FROM drivers d
  LEFT JOIN trips ot ON ot.driver_id = d.id AND ot.status = 'OPEN'
`;

export function registerDirectoryRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // ---------------- VEHICLES DIRECTORY ----------------
  app.get('/vehicles', requireAuth, requirePinChanged(), async (c) => {
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const status = (c.req.query('status') || '').trim();
    const condition = (c.req.query('condition') || '').trim();
    const vehicleClass = (c.req.query('vehicle_class') || '').trim();
    const includeInactive = c.req.query('includeInactive') === '1';
    const page = Math.max(1, Number(c.req.query('page') || 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (!includeInactive) {
      clauses.push('v.active = 1');
    }
    if (q) {
      clauses.push(
        '(LOWER(v.reg_number) LIKE ? OR LOWER(v.make_model) LIKE ? OR LOWER(v.vehicle_type) LIKE ?)'
      );
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (condition) {
      clauses.push('v.condition = ?');
      params.push(condition);
    }
    if (vehicleClass === 'ECONOMY' || vehicleClass === 'HEAVY') {
      clauses.push('v.vehicle_class = ?');
      params.push(vehicleClass);
    }
    if (status === 'Available') {
      clauses.push('ot.id IS NULL');
    } else if (status === 'Out on Hire') {
      clauses.push("ot.trip_type = 'HIRE'");
    } else if (status === 'Out on Errand') {
      clauses.push("ot.trip_type = 'ERRAND'");
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total
       FROM vehicles v
       LEFT JOIN trips ot ON ot.vehicle_id = v.id AND ot.status = 'OPEN'
       ${whereSql}`
    )
      .bind(...params)
      .first<{ total: number }>();

    const { results } = await c.env.DB.prepare(
      `${VEHICLE_SELECT_SQL}
       ${whereSql}
       ORDER BY v.active DESC, v.reg_number ASC
       LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>();

    return c.json({
      items: results.map(mapVehicleRow),
      total: countRow?.total ?? 0,
      page,
      limit,
    });
  });

  app.get('/vehicles/:id', requireAuth, requirePinChanged(), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid vehicle ID.' }, 400);
    }

    const row = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();

    if (!row) {
      return c.json({ error: 'Vehicle not found.' }, 404);
    }

    const { results: trips } = await c.env.DB.prepare(
      `SELECT
         t.id, t.trip_type, t.status, t.client_name, t.destination,
         d.full_name AS driver_name,
         tout.out_at, tout.mileage_out,
         tin.in_at, tin.mileage_in, tin.total_mileage
       FROM trips t
       JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN trip_out tout ON tout.trip_id = t.id
       LEFT JOIN trip_in tin ON tin.trip_id = t.id
       WHERE t.vehicle_id = ?
       ORDER BY t.id DESC
       LIMIT 30`
    )
      .bind(id)
      .all<Record<string, unknown>>();

    const { results: conditionHistory } = await c.env.DB.prepare(
      `SELECT id, ts, user_id, username, user_role, action, entity, entity_id, old_json, new_json, ip, user_agent, prev_hash, hash
       FROM audit_log
       WHERE entity = 'vehicles' AND entity_id = ?
       ORDER BY id DESC
       LIMIT 20`
    )
      .bind(String(id))
      .all<AuditLogEntry>();

    return c.json({
      vehicle: mapVehicleRow(row),
      trips,
      conditionHistory,
    });
  });

  app.post(
    '/vehicles',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        reg_number?: string;
        vehicle_type?: string;
        make_model?: string;
        condition?: VehicleCondition;
        last_known_mileage?: number;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const regNumber = (body.reg_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
      const vehicleType = (body.vehicle_type || '').trim();
      const makeModel = (body.make_model || '').trim();
      const condition = body.condition || 'Good';
      const mileage = Number(body.last_known_mileage ?? 0);

      if (!regNumber || regNumber.length < 3) {
        return c.json({ error: 'Enter the vehicle registration number (at least 3 characters).' }, 400);
      }
      const vehicleClass = VEHICLE_TYPE_TO_CLASS[vehicleType];
      if (!vehicleClass) {
        return c.json({ error: 'Choose a valid vehicle type from the list.' }, 400);
      }
      if (!makeModel || makeModel.length < 2) {
        return c.json({ error: 'Enter the vehicle make and model (e.g. Toyota Hilux).' }, 400);
      }
      if (!VEHICLE_CONDITIONS.includes(condition)) {
        return c.json({ error: 'Choose a valid vehicle condition.' }, 400);
      }
      if (!Number.isInteger(mileage) || mileage < 0) {
        return c.json({ error: 'Starting mileage must be a whole number 0 or greater.' }, 400);
      }

      const existing = await c.env.DB.prepare('SELECT id FROM vehicles WHERE reg_number = ?')
        .bind(regNumber)
        .first<{ id: number }>();
      if (existing) {
        return c.json({ error: `A vehicle with registration "${regNumber}" already exists.` }, 409);
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
        .bind(regNumber, vehicleType, vehicleClass, makeModel, condition, mileage)
        .run();

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const created = mapVehicleRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'VEHICLE_CREATED',
        entity: 'vehicles',
        entityId: newId,
        newValue: {
          reg_number: created.reg_number,
          vehicle_type: created.vehicle_type,
          vehicle_class: created.vehicle_class,
          make_model: created.make_model,
          condition: created.condition,
          last_known_mileage: created.last_known_mileage,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'VEHICLE_CREATED',
          priority: condition === 'Accident' || condition === 'Grounded' ? 'HIGH' : 'NORMAL',
          title: `Vehicle added: ${created.reg_number}`,
          body: `${actor.full_name} added ${created.make_model} (${created.vehicle_type} · ${created.vehicle_class}) with mileage ${created.last_known_mileage.toLocaleString()} km.`,
        },
        { env: c.env }
      );

      return c.json({ vehicle: created }, 201);
    }
  );

  app.patch(
    '/vehicles/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid vehicle ID.' }, 400);
      }

      const existingRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Vehicle not found.' }, 404);
      }

      const oldVehicle = mapVehicleRow(existingRow);

      let body: {
        reg_number?: string;
        vehicle_type?: string;
        make_model?: string;
        condition?: VehicleCondition;
        last_known_mileage?: number;
        active?: boolean;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const nextReg =
        body.reg_number !== undefined
          ? body.reg_number.trim().toUpperCase().replace(/\s+/g, ' ')
          : oldVehicle.reg_number;
      const nextType =
        body.vehicle_type !== undefined ? body.vehicle_type.trim() : oldVehicle.vehicle_type;
      const nextClass = VEHICLE_TYPE_TO_CLASS[nextType];
      const nextMakeModel =
        body.make_model !== undefined ? body.make_model.trim() : oldVehicle.make_model;
      const nextCondition =
        body.condition !== undefined ? body.condition : oldVehicle.condition;
      const nextActive = body.active !== undefined ? Boolean(body.active) : oldVehicle.active;
      const nextMileage =
        body.last_known_mileage !== undefined
          ? Number(body.last_known_mileage)
          : oldVehicle.last_known_mileage;

      if (!nextReg || nextReg.length < 3) {
        return c.json({ error: 'Registration number must be at least 3 characters.' }, 400);
      }
      if (!nextClass) {
        return c.json({ error: 'Choose a valid vehicle type.' }, 400);
      }
      if (!nextMakeModel || nextMakeModel.length < 2) {
        return c.json({ error: 'Enter the vehicle make and model.' }, 400);
      }
      if (!VEHICLE_CONDITIONS.includes(nextCondition)) {
        return c.json({ error: 'Choose a valid vehicle condition.' }, 400);
      }
      if (!Number.isInteger(nextMileage) || nextMileage < 0) {
        return c.json({ error: 'Mileage must be a whole number 0 or greater.' }, 400);
      }

      if (!nextActive && oldVehicle.open_trip_id) {
        return c.json(
          {
            error: `Cannot disable ${oldVehicle.reg_number} while it is currently ${oldVehicle.derived_status}. Close the trip first.`,
          },
          400
        );
      }

      if (nextReg !== oldVehicle.reg_number) {
        const dup = await c.env.DB.prepare(
          'SELECT id FROM vehicles WHERE reg_number = ? AND id != ?'
        )
          .bind(nextReg, id)
          .first<{ id: number }>();
        if (dup) {
          return c.json({ error: `Registration "${nextReg}" is already in use.` }, 409);
        }
      }

      await c.env.DB.prepare(
        `UPDATE vehicles
         SET reg_number = ?, vehicle_type = ?, vehicle_class = ?, make_model = ?, condition = ?, last_known_mileage = ?, active = ?
         WHERE id = ?`
      )
        .bind(
          nextReg,
          nextType,
          nextClass,
          nextMakeModel,
          nextCondition,
          nextMileage,
          nextActive ? 1 : 0,
          id
        )
        .run();

      const updatedRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const updated = mapVehicleRow(updatedRow!);

      const conditionChanged = oldVehicle.condition !== updated.condition;
      const action = conditionChanged ? 'VEHICLE_CONDITION_CHANGED' : 'VEHICLE_UPDATED';

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action,
        entity: 'vehicles',
        entityId: id,
        oldValue: {
          reg_number: oldVehicle.reg_number,
          vehicle_type: oldVehicle.vehicle_type,
          vehicle_class: oldVehicle.vehicle_class,
          make_model: oldVehicle.make_model,
          condition: oldVehicle.condition,
          last_known_mileage: oldVehicle.last_known_mileage,
          active: oldVehicle.active,
        },
        newValue: {
          reg_number: updated.reg_number,
          vehicle_type: updated.vehicle_type,
          vehicle_class: updated.vehicle_class,
          make_model: updated.make_model,
          condition: updated.condition,
          last_known_mileage: updated.last_known_mileage,
          active: updated.active,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      const highPriority =
        conditionChanged && (updated.condition === 'Accident' || updated.condition === 'Grounded');

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: action,
          priority: highPriority ? 'HIGH' : 'NORMAL',
          title: conditionChanged
            ? `${updated.reg_number} condition: ${updated.condition}`
            : `Vehicle updated: ${updated.reg_number}`,
          body: conditionChanged
            ? `${actor.full_name} changed ${updated.reg_number} (${updated.make_model}) from "${oldVehicle.condition}" to "${updated.condition}".`
            : `${actor.full_name} updated details for ${updated.reg_number} (${updated.make_model}).`,
        },
        { env: c.env }
      );

      return c.json({ vehicle: updated });
    }
  );

  // ---------------- DRIVERS DIRECTORY ----------------
  app.get('/drivers', requireAuth, requirePinChanged(), async (c) => {
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const status = (c.req.query('status') || '').trim();
    const expiringOnly = c.req.query('expiring') === '1';
    const includeInactive = c.req.query('includeInactive') === '1';
    const page = Math.max(1, Number(c.req.query('page') || 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (!includeInactive) {
      clauses.push('d.active = 1');
    }
    if (q) {
      clauses.push(
        '(LOWER(d.full_name) LIKE ? OR LOWER(d.licence_number) LIKE ? OR LOWER(d.phone) LIKE ?)'
      );
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    if (status === 'Available') {
      clauses.push('ot.id IS NULL');
    } else if (status === 'Out on Hire') {
      clauses.push("ot.trip_type = 'HIRE'");
    } else if (status === 'Out on Errand') {
      clauses.push("ot.trip_type = 'ERRAND'");
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const { results } = await c.env.DB.prepare(
      `${DRIVER_SELECT_SQL}
       ${whereSql}
       ORDER BY d.active DESC, d.full_name ASC`
    )
      .bind(...params)
      .all<Record<string, unknown>>();

    const allMapped = results.map(mapDriverRow);
    const expiringCount = allMapped.filter(
      (d) => d.active && (d.licence_status === 'EXPIRING_SOON' || d.licence_status === 'EXPIRED')
    ).length;

    const filtered = expiringOnly
      ? allMapped.filter(
          (d) => d.licence_status === 'EXPIRING_SOON' || d.licence_status === 'EXPIRED'
        )
      : allMapped;

    const paginated = filtered.slice(offset, offset + limit);

    return c.json({
      items: paginated,
      total: filtered.length,
      expiringCount,
      page,
      limit,
    });
  });

  app.get('/drivers/:id', requireAuth, requirePinChanged(), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid driver ID.' }, 400);
    }

    const row = await c.env.DB.prepare(`${DRIVER_SELECT_SQL} WHERE d.id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) {
      return c.json({ error: 'Driver not found.' }, 404);
    }

    const { results: trips } = await c.env.DB.prepare(
      `SELECT
         t.id, t.trip_type, t.status, t.client_name, t.destination,
         v.reg_number, v.make_model,
         tout.out_at,
         tin.in_at, tin.total_mileage
       FROM trips t
       JOIN vehicles v ON v.id = t.vehicle_id
       LEFT JOIN trip_out tout ON tout.trip_id = t.id
       LEFT JOIN trip_in tin ON tin.trip_id = t.id
       WHERE t.driver_id = ?
       ORDER BY t.id DESC
       LIMIT 30`
    )
      .bind(id)
      .all<Record<string, unknown>>();

    return c.json({
      driver: mapDriverRow(row),
      trips,
    });
  });

  app.post(
    '/drivers',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        full_name?: string;
        licence_number?: string;
        phone?: string;
        address?: string;
        licence_expiry?: string | null;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const fullName = (body.full_name || '').trim();
      const licenceNumber = (body.licence_number || '').trim().toUpperCase();
      const phone = (body.phone || '').trim();
      const address = (body.address || '').trim();
      const licenceExpiry = body.licence_expiry ? String(body.licence_expiry).trim() : null;

      if (!fullName || fullName.length < 2) {
        return c.json({ error: 'Enter the driver’s full name.' }, 400);
      }
      if (!licenceNumber || licenceNumber.length < 3) {
        return c.json({ error: 'Enter the driver’s licence number.' }, 400);
      }
      if (!phone || phone.length < 5) {
        return c.json({ error: 'Enter a contact phone number for the driver.' }, 400);
      }
      if (licenceExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(licenceExpiry)) {
        return c.json({ error: 'Licence expiry date must be in YYYY-MM-DD format.' }, 400);
      }

      const existing = await c.env.DB.prepare(
        'SELECT id FROM drivers WHERE UPPER(licence_number) = ?'
      )
        .bind(licenceNumber)
        .first<{ id: number }>();
      if (existing) {
        return c.json(
          { error: `A driver with licence number "${licenceNumber}" is already registered.` },
          409
        );
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO drivers (full_name, licence_number, phone, address, licence_expiry, active, created_by)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
        .bind(fullName, licenceNumber, phone, address, licenceExpiry, actor.id)
        .run();

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${DRIVER_SELECT_SQL} WHERE d.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const created = mapDriverRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'DRIVER_CREATED',
        entity: 'drivers',
        entityId: newId,
        newValue: {
          full_name: created.full_name,
          licence_number: created.licence_number,
          phone: created.phone,
          address: created.address,
          licence_expiry: created.licence_expiry,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'DRIVER_CREATED',
          priority: created.licence_status === 'EXPIRED' ? 'HIGH' : 'NORMAL',
          title: `Driver added: ${created.full_name}`,
          body: `${actor.full_name} added driver ${created.full_name} (Licence ${created.licence_number}).`,
        },
        { env: c.env }
      );

      return c.json({ driver: created }, 201);
    }
  );

  app.patch(
    '/drivers/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid driver ID.' }, 400);
      }

      const existingRow = await c.env.DB.prepare(`${DRIVER_SELECT_SQL} WHERE d.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Driver not found.' }, 404);
      }

      const oldDriver = mapDriverRow(existingRow);

      let body: {
        full_name?: string;
        licence_number?: string;
        phone?: string;
        address?: string;
        licence_expiry?: string | null;
        active?: boolean;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const nextName = body.full_name !== undefined ? body.full_name.trim() : oldDriver.full_name;
      const nextLicence =
        body.licence_number !== undefined
          ? body.licence_number.trim().toUpperCase()
          : oldDriver.licence_number;
      const nextPhone = body.phone !== undefined ? body.phone.trim() : oldDriver.phone;
      const nextAddress = body.address !== undefined ? body.address.trim() : oldDriver.address;
      const nextExpiry =
        body.licence_expiry !== undefined
          ? body.licence_expiry
            ? String(body.licence_expiry).trim()
            : null
          : oldDriver.licence_expiry;
      const nextActive = body.active !== undefined ? Boolean(body.active) : oldDriver.active;

      if (!nextName || nextName.length < 2) {
        return c.json({ error: 'Enter the driver’s full name.' }, 400);
      }
      if (!nextLicence || nextLicence.length < 3) {
        return c.json({ error: 'Enter a valid licence number.' }, 400);
      }
      if (!nextPhone || nextPhone.length < 5) {
        return c.json({ error: 'Enter a contact phone number.' }, 400);
      }
      if (nextExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(nextExpiry)) {
        return c.json({ error: 'Licence expiry date must be in YYYY-MM-DD format.' }, 400);
      }
      if (!nextActive && oldDriver.open_trip_id) {
        return c.json(
          {
            error: `Cannot disable ${oldDriver.full_name} while they are currently ${oldDriver.derived_status}. Close the trip first.`,
          },
          400
        );
      }

      if (nextLicence !== oldDriver.licence_number) {
        const dup = await c.env.DB.prepare(
          'SELECT id FROM drivers WHERE UPPER(licence_number) = ? AND id != ?'
        )
          .bind(nextLicence, id)
          .first<{ id: number }>();
        if (dup) {
          return c.json(
            { error: `Licence number "${nextLicence}" belongs to another driver.` },
            409
          );
        }
      }

      await c.env.DB.prepare(
        `UPDATE drivers
         SET full_name = ?, licence_number = ?, phone = ?, address = ?, licence_expiry = ?, active = ?
         WHERE id = ?`
      )
        .bind(nextName, nextLicence, nextPhone, nextAddress, nextExpiry, nextActive ? 1 : 0, id)
        .run();

      const updatedRow = await c.env.DB.prepare(`${DRIVER_SELECT_SQL} WHERE d.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const updated = mapDriverRow(updatedRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'DRIVER_UPDATED',
        entity: 'drivers',
        entityId: id,
        oldValue: {
          full_name: oldDriver.full_name,
          licence_number: oldDriver.licence_number,
          phone: oldDriver.phone,
          address: oldDriver.address,
          licence_expiry: oldDriver.licence_expiry,
          active: oldDriver.active,
        },
        newValue: {
          full_name: updated.full_name,
          licence_number: updated.licence_number,
          phone: updated.phone,
          address: updated.address,
          licence_expiry: updated.licence_expiry,
          active: updated.active,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'DRIVER_UPDATED',
          priority: 'NORMAL',
          title: `Driver updated: ${updated.full_name}`,
          body: `${actor.full_name} updated details for driver ${updated.full_name} (${updated.licence_number}).`,
        },
        { env: c.env }
      );

      return c.json({ driver: updated });
    }
  );
}
