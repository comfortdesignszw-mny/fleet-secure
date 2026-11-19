import type { Context, Hono, MiddlewareHandler } from 'hono';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_TYPE_TO_CLASS,
  getDriverMissingDocuments,
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

const MAX_DOC_DATA_URL_CHARS = 2_800_000;

export function validateDocumentDataUrl(
  raw: unknown,
  label: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `${label} must be an image or PDF file.` };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, value: null };
  }
  const validPrefix =
    /^data:image\/(?:jpeg|jpg|png|webp|gif|heic|heif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed) ||
    /^data:application\/pdf(?:;[^;,]+)*;base64,[A-Za-z0-9+/=]+$/i.test(trimmed);
  if (!validPrefix) {
    return {
      ok: false,
      error: `${label} must be a valid image (JPG, PNG, WEBP) or PDF document.`,
    };
  }
  if (trimmed.length > MAX_DOC_DATA_URL_CHARS) {
    return {
      ok: false,
      error: `${label} is too large. Please upload a PDF or image smaller than 2 MB.`,
    };
  }
  return { ok: true, value: trimmed };
}

function mapDriverRow(
  row: Record<string, unknown>,
  options: { includeDocuments?: boolean; includeMissingWarning?: boolean } = {}
): Driver {
  const licenceExpiry = row.licence_expiry ? String(row.licence_expiry) : null;
  const { licence_status, days_to_expiry } = computeLicenceExpiryStatus(licenceExpiry);
  const licenceNumber = row.licence_number ? String(row.licence_number) : null;
  const ddcNumber = row.ddc_number ? String(row.ddc_number) : null;
  const retestCertNumber = row.retest_cert_number ? String(row.retest_cert_number) : null;
  const medicalCertNumber = row.medical_cert_number ? String(row.medical_cert_number) : null;

  const hasLicenceDoc =
    Number(row.has_licence_document ?? 0) === 1 || Boolean(row.licence_document);
  const hasDdcDoc = Number(row.has_ddc_document ?? 0) === 1 || Boolean(row.ddc_document);
  const hasRetestDoc =
    Number(row.has_retest_document ?? 0) === 1 || Boolean(row.retest_document);
  const hasMedicalDoc =
    Number(row.has_medical_document ?? 0) === 1 || Boolean(row.medical_document);

  const driver: Driver = {
    id: Number(row.id),
    full_name: String(row.full_name),
    licence_number: licenceNumber,
    phone: String(row.phone),
    address: String(row.address ?? ''),
    licence_expiry: licenceExpiry,
    has_licence_document: hasLicenceDoc,
    ddc_number: ddcNumber,
    has_ddc_document: hasDdcDoc,
    retest_cert_number: retestCertNumber,
    has_retest_document: hasRetestDoc,
    medical_cert_number: medicalCertNumber,
    has_medical_document: hasMedicalDoc,
    active: Number(row.active) === 1,
    created_at: String(row.created_at),
    created_by: row.created_by ? Number(row.created_by) : null,
    derived_status: toDerivedStatus(row.open_trip_type),
    open_trip_id: row.open_trip_id ? Number(row.open_trip_id) : null,
    licence_status,
    days_to_expiry,
  };

  if (options.includeDocuments) {
    driver.licence_document = row.licence_document ? String(row.licence_document) : null;
    driver.ddc_document = row.ddc_document ? String(row.ddc_document) : null;
    driver.retest_document = row.retest_document ? String(row.retest_document) : null;
    driver.medical_document = row.medical_document ? String(row.medical_document) : null;
  }

  if (options.includeMissingWarning) {
    driver.missing_documents = getDriverMissingDocuments(driver);
  }

  return driver;
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

const DRIVER_LIST_SELECT_SQL = `
  SELECT
    d.id, d.full_name, d.licence_number, d.phone, d.address, d.licence_expiry,
    d.ddc_number, d.retest_cert_number, d.medical_cert_number,
    d.active, d.created_at, d.created_by,
    CASE WHEN d.licence_document IS NOT NULL AND d.licence_document != '' THEN 1 ELSE 0 END AS has_licence_document,
    CASE WHEN d.ddc_document IS NOT NULL AND d.ddc_document != '' THEN 1 ELSE 0 END AS has_ddc_document,
    CASE WHEN d.retest_document IS NOT NULL AND d.retest_document != '' THEN 1 ELSE 0 END AS has_retest_document,
    CASE WHEN d.medical_document IS NOT NULL AND d.medical_document != '' THEN 1 ELSE 0 END AS has_medical_document,
    ot.id AS open_trip_id,
    ot.trip_type AS open_trip_type
  FROM drivers d
  LEFT JOIN trips ot ON ot.driver_id = d.id AND ot.status = 'OPEN'
`;

const DRIVER_DETAIL_SELECT_SQL = `
  SELECT
    d.*,
    CASE WHEN d.licence_document IS NOT NULL AND d.licence_document != '' THEN 1 ELSE 0 END AS has_licence_document,
    CASE WHEN d.ddc_document IS NOT NULL AND d.ddc_document != '' THEN 1 ELSE 0 END AS has_ddc_document,
    CASE WHEN d.retest_document IS NOT NULL AND d.retest_document != '' THEN 1 ELSE 0 END AS has_retest_document,
    CASE WHEN d.medical_document IS NOT NULL AND d.medical_document != '' THEN 1 ELSE 0 END AS has_medical_document,
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
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 25)));
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
         t.id, t.trip_type, t.status, t.client_name, t.destination, t.days_hired, t.expected_return_date,
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
    const actor = c.get('user')!;
    const canSeeMissingWarnings = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR';

    const q = (c.req.query('q') || '').trim().toLowerCase();
    const status = (c.req.query('status') || '').trim();
    const expiringOnly = c.req.query('expiring') === '1';
    const includeInactive = c.req.query('includeInactive') === '1';
    const page = Math.max(1, Number(c.req.query('page') || 1));
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') || 25)));
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (!includeInactive) {
      clauses.push('d.active = 1');
    }
    if (q) {
      clauses.push(
        "(LOWER(d.full_name) LIKE ? OR LOWER(COALESCE(d.licence_number, '')) LIKE ? OR LOWER(d.phone) LIKE ? OR LOWER(COALESCE(d.ddc_number, '')) LIKE ? OR LOWER(COALESCE(d.retest_cert_number, '')) LIKE ? OR LOWER(COALESCE(d.medical_cert_number, '')) LIKE ?)"
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like);
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
      `${DRIVER_LIST_SELECT_SQL}
       ${whereSql}
       ORDER BY d.active DESC, d.full_name ASC`
    )
      .bind(...params)
      .all<Record<string, unknown>>();

    const allMapped = results.map((r) =>
      mapDriverRow(r, {
        includeDocuments: false,
        includeMissingWarning: canSeeMissingWarnings,
      })
    );
    const expiringCount = allMapped.filter(
      (d) => d.active && (d.licence_status === 'EXPIRING_SOON' || d.licence_status === 'EXPIRED')
    ).length;
    const missingDocsCount = canSeeMissingWarnings
      ? allMapped.filter((d) => d.active && (d.missing_documents?.length ?? 0) > 0).length
      : undefined;

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
      missingDocsCount,
      page,
      limit,
    });
  });

  app.get('/drivers/:id', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    const canSeeMissingWarnings = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR';
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid driver ID.' }, 400);
    }

    const row = await c.env.DB.prepare(`${DRIVER_DETAIL_SELECT_SQL} WHERE d.id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!row) {
      return c.json({ error: 'Driver not found.' }, 404);
    }

    const { results: trips } = await c.env.DB.prepare(
      `SELECT
         t.id, t.trip_type, t.status, t.client_name, t.destination, t.days_hired, t.expected_return_date,
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
      driver: mapDriverRow(row, {
        includeDocuments: true,
        includeMissingWarning: canSeeMissingWarnings,
      }),
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
        licence_number?: string | null;
        phone?: string;
        address?: string;
        licence_expiry?: string | null;
        licence_document?: string | null;
        ddc_number?: string | null;
        ddc_document?: string | null;
        retest_cert_number?: string | null;
        retest_document?: string | null;
        medical_cert_number?: string | null;
        medical_document?: string | null;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const fullName = (body.full_name || '').trim();
      const rawLicence = body.licence_number ? String(body.licence_number).trim().toUpperCase() : '';
      const licenceNumber = rawLicence || null;
      const phone = (body.phone || '').trim();
      const address = (body.address || '').trim();
      const licenceExpiry = body.licence_expiry ? String(body.licence_expiry).trim() : null;
      const ddcNumber = body.ddc_number ? String(body.ddc_number).trim().toUpperCase() || null : null;
      const retestCertNumber = body.retest_cert_number
        ? String(body.retest_cert_number).trim().toUpperCase() || null
        : null;
      const medicalCertNumber = body.medical_cert_number
        ? String(body.medical_cert_number).trim().toUpperCase() || null
        : null;

      if (!fullName || fullName.length < 2) {
        return c.json({ error: 'Enter the driver’s full name.' }, 400);
      }
      if (licenceNumber && licenceNumber.length < 2) {
        return c.json({ error: 'Licence number must be at least 2 characters when provided.' }, 400);
      }
      if (!phone || phone.length < 5) {
        return c.json({ error: 'Enter a contact phone number for the driver.' }, 400);
      }
      if (licenceExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(licenceExpiry)) {
        return c.json({ error: 'Licence expiry date must be in YYYY-MM-DD format.' }, 400);
      }

      const licDoc = validateDocumentDataUrl(body.licence_document, "Driver's Licence document");
      if (!licDoc.ok) return c.json({ error: licDoc.error }, 400);
      const ddcDoc = validateDocumentDataUrl(body.ddc_document, 'Defensive Driving Certificate');
      if (!ddcDoc.ok) return c.json({ error: ddcDoc.error }, 400);
      const retestDoc = validateDocumentDataUrl(body.retest_document, 'Retest Certificate');
      if (!retestDoc.ok) return c.json({ error: retestDoc.error }, 400);
      const medDoc = validateDocumentDataUrl(body.medical_document, 'Medical Certificate');
      if (!medDoc.ok) return c.json({ error: medDoc.error }, 400);

      if (licenceNumber) {
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
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO drivers (
           full_name, licence_number, phone, address, licence_expiry,
           licence_document, ddc_number, ddc_document,
           retest_cert_number, retest_document,
           medical_cert_number, medical_document,
           active, created_by
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
        .bind(
          fullName,
          licenceNumber,
          phone,
          address,
          licenceExpiry,
          licDoc.value,
          ddcNumber,
          ddcDoc.value,
          retestCertNumber,
          retestDoc.value,
          medicalCertNumber,
          medDoc.value,
          actor.id
        )
        .run();

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${DRIVER_DETAIL_SELECT_SQL} WHERE d.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const created = mapDriverRow(createdRow!, {
        includeDocuments: true,
        includeMissingWarning: true,
      });

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
          ddc_number: created.ddc_number,
          retest_cert_number: created.retest_cert_number,
          medical_cert_number: created.medical_cert_number,
          has_licence_document: created.has_licence_document,
          has_ddc_document: created.has_ddc_document,
          has_retest_document: created.has_retest_document,
          has_medical_document: created.has_medical_document,
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
          body: `${actor.full_name} added driver ${created.full_name} (${
            created.licence_number ? `Licence ${created.licence_number}` : 'No licence recorded yet'
          }).`,
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

      const existingRow = await c.env.DB.prepare(`${DRIVER_DETAIL_SELECT_SQL} WHERE d.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Driver not found.' }, 404);
      }

      const oldDriver = mapDriverRow(existingRow, {
        includeDocuments: true,
        includeMissingWarning: true,
      });

      let body: {
        full_name?: string;
        licence_number?: string | null;
        phone?: string;
        address?: string;
        licence_expiry?: string | null;
        licence_document?: string | null;
        ddc_number?: string | null;
        ddc_document?: string | null;
        retest_cert_number?: string | null;
        retest_document?: string | null;
        medical_cert_number?: string | null;
        medical_document?: string | null;
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
          ? body.licence_number
            ? String(body.licence_number).trim().toUpperCase() || null
            : null
          : oldDriver.licence_number;
      const nextPhone = body.phone !== undefined ? body.phone.trim() : oldDriver.phone;
      const nextAddress = body.address !== undefined ? body.address.trim() : oldDriver.address;
      const nextExpiry =
        body.licence_expiry !== undefined
          ? body.licence_expiry
            ? String(body.licence_expiry).trim()
            : null
          : oldDriver.licence_expiry;
      const nextDdcNumber =
        body.ddc_number !== undefined
          ? body.ddc_number
            ? String(body.ddc_number).trim().toUpperCase() || null
            : null
          : oldDriver.ddc_number;
      const nextRetestNumber =
        body.retest_cert_number !== undefined
          ? body.retest_cert_number
            ? String(body.retest_cert_number).trim().toUpperCase() || null
            : null
          : oldDriver.retest_cert_number;
      const nextMedicalNumber =
        body.medical_cert_number !== undefined
          ? body.medical_cert_number
            ? String(body.medical_cert_number).trim().toUpperCase() || null
            : null
          : oldDriver.medical_cert_number;
      const nextActive = body.active !== undefined ? Boolean(body.active) : oldDriver.active;

      if (!nextName || nextName.length < 2) {
        return c.json({ error: 'Enter the driver’s full name.' }, 400);
      }
      if (nextLicence && nextLicence.length < 2) {
        return c.json({ error: 'Licence number must be at least 2 characters when provided.' }, 400);
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

      let nextLicenceDoc = oldDriver.licence_document ?? null;
      if (body.licence_document !== undefined) {
        const res = validateDocumentDataUrl(body.licence_document, "Driver's Licence document");
        if (!res.ok) return c.json({ error: res.error }, 400);
        nextLicenceDoc = res.value;
      }

      let nextDdcDoc = oldDriver.ddc_document ?? null;
      if (body.ddc_document !== undefined) {
        const res = validateDocumentDataUrl(body.ddc_document, 'Defensive Driving Certificate');
        if (!res.ok) return c.json({ error: res.error }, 400);
        nextDdcDoc = res.value;
      }

      let nextRetestDoc = oldDriver.retest_document ?? null;
      if (body.retest_document !== undefined) {
        const res = validateDocumentDataUrl(body.retest_document, 'Retest Certificate');
        if (!res.ok) return c.json({ error: res.error }, 400);
        nextRetestDoc = res.value;
      }

      let nextMedicalDoc = oldDriver.medical_document ?? null;
      if (body.medical_document !== undefined) {
        const res = validateDocumentDataUrl(body.medical_document, 'Medical Certificate');
        if (!res.ok) return c.json({ error: res.error }, 400);
        nextMedicalDoc = res.value;
      }

      if (nextLicence && nextLicence !== oldDriver.licence_number) {
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
         SET full_name = ?, licence_number = ?, phone = ?, address = ?, licence_expiry = ?,
             licence_document = ?, ddc_number = ?, ddc_document = ?,
             retest_cert_number = ?, retest_document = ?,
             medical_cert_number = ?, medical_document = ?,
             active = ?
         WHERE id = ?`
      )
        .bind(
          nextName,
          nextLicence,
          nextPhone,
          nextAddress,
          nextExpiry,
          nextLicenceDoc,
          nextDdcNumber,
          nextDdcDoc,
          nextRetestNumber,
          nextRetestDoc,
          nextMedicalNumber,
          nextMedicalDoc,
          nextActive ? 1 : 0,
          id
        )
        .run();

      const updatedRow = await c.env.DB.prepare(`${DRIVER_DETAIL_SELECT_SQL} WHERE d.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const updated = mapDriverRow(updatedRow!, {
        includeDocuments: true,
        includeMissingWarning: true,
      });

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
          ddc_number: oldDriver.ddc_number,
          retest_cert_number: oldDriver.retest_cert_number,
          medical_cert_number: oldDriver.medical_cert_number,
          has_licence_document: oldDriver.has_licence_document,
          has_ddc_document: oldDriver.has_ddc_document,
          has_retest_document: oldDriver.has_retest_document,
          has_medical_document: oldDriver.has_medical_document,
          active: oldDriver.active,
        },
        newValue: {
          full_name: updated.full_name,
          licence_number: updated.licence_number,
          phone: updated.phone,
          address: updated.address,
          licence_expiry: updated.licence_expiry,
          ddc_number: updated.ddc_number,
          retest_cert_number: updated.retest_cert_number,
          medical_cert_number: updated.medical_cert_number,
          has_licence_document: updated.has_licence_document,
          has_ddc_document: updated.has_ddc_document,
          has_retest_document: updated.has_retest_document,
          has_medical_document: updated.has_medical_document,
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
          body: `${actor.full_name} updated details for driver ${updated.full_name} (${
            updated.licence_number ?? 'No licence recorded'
          }).`,
        },
        { env: c.env }
      );

      return c.json({ driver: updated });
    }
  );
}
