import type { Hono } from 'hono';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_TYPE_TO_CLASS,
  type FleetMaintenanceOverview,
  type GarageApprovalStatus,
  type GarageVisit,
  type GarageVisitStatus,
  type MaintenanceRecordType,
  type NextServiceStatus,
  type PartsPurchaseRequest,
  type PartsPurchaseStatus,
  type UserPublic,
  type Vehicle,
  type VehicleCondition,
  type VehicleMaintenanceLog,
  type VehicleServiceDueSummary,
} from '../shared/types';
import { recordAudit } from './audit';
import {
  VEHICLE_SELECT_SQL,
  mapVehicleRow,
  validateDocumentDataUrl,
  type RouteAuthDeps,
} from './directories';
import { notifyManagersInApp } from './notifications';
import type { AppEnv } from './types';

function isValidIsoDate(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const parsed = new Date(`${val}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

function parseOptionalCost(raw: unknown, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: null };
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, error: `${label} must be 0 or greater.` };
  }
  return { ok: true, value: Math.round(num * 100) / 100 };
}

function parseOptionalIntKm(raw: unknown, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, value: null };
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    return { ok: false, error: `${label} must be a whole number 0 or greater.` };
  }
  return { ok: true, value: num };
}

function computeNextServiceStatus(
  lastKnownMileage: number,
  nextServiceDueKm: number | null
): { remaining_km: number | null; service_due_status: NextServiceStatus } {
  if (nextServiceDueKm === null || nextServiceDueKm === undefined) {
    return { remaining_km: null, service_due_status: 'UNSET' };
  }
  const remaining = nextServiceDueKm - lastKnownMileage;
  if (remaining <= 0) {
    return { remaining_km: remaining, service_due_status: 'OVERDUE' };
  }
  if (remaining <= 1000) {
    return { remaining_km: remaining, service_due_status: 'DUE_SOON' };
  }
  return { remaining_km: remaining, service_due_status: 'OK' };
}

function mapMaintenanceLogRow(row: Record<string, unknown>): VehicleMaintenanceLog {
  return {
    id: Number(row.id),
    vehicle_id: Number(row.vehicle_id),
    reg_number: String(row.reg_number),
    make_model: String(row.make_model),
    record_type: row.record_type as MaintenanceRecordType,
    service_date: String(row.service_date),
    odometer_km: Number(row.odometer_km),
    summary: String(row.summary),
    details: String(row.details ?? ''),
    workshop_name: String(row.workshop_name ?? ''),
    cost: row.cost !== null && row.cost !== undefined ? Number(row.cost) : null,
    next_service_due_km:
      row.next_service_due_km !== null && row.next_service_due_km !== undefined
        ? Number(row.next_service_due_km)
        : null,
    created_by: row.created_by ? Number(row.created_by) : null,
    created_by_name: row.created_by_name ? String(row.created_by_name) : undefined,
    created_at: String(row.created_at),
  };
}

function mapGarageVisitRow(row: Record<string, unknown>): GarageVisit {
  return {
    id: Number(row.id),
    vehicle_id: Number(row.vehicle_id),
    reg_number: String(row.reg_number),
    make_model: String(row.make_model),
    visit_date: String(row.visit_date),
    workshop_name: String(row.workshop_name),
    reason: String(row.reason),
    odometer_km: Number(row.odometer_km),
    estimated_cost:
      row.estimated_cost !== null && row.estimated_cost !== undefined
        ? Number(row.estimated_cost)
        : null,
    actual_cost:
      row.actual_cost !== null && row.actual_cost !== undefined ? Number(row.actual_cost) : null,
    approval_status: row.approval_status as GarageApprovalStatus,
    visit_status: row.visit_status as GarageVisitStatus,
    notes: String(row.notes ?? ''),
    requested_by: row.requested_by ? Number(row.requested_by) : null,
    requested_by_name: row.requested_by_name ? String(row.requested_by_name) : undefined,
    approved_by: row.approved_by ? Number(row.approved_by) : null,
    approved_by_name: row.approved_by_name ? String(row.approved_by_name) : undefined,
    approved_at: row.approved_at ? String(row.approved_at) : null,
    approval_notes: String(row.approval_notes ?? ''),
    created_at: String(row.created_at),
  };
}

function mapPartsRequestRow(row: Record<string, unknown>): PartsPurchaseRequest {
  return {
    id: Number(row.id),
    request_date: String(row.request_date),
    vehicle_id: Number(row.vehicle_id),
    reg_number: String(row.reg_number),
    make_model: String(row.make_model),
    parts_required: String(row.parts_required),
    is_full_service_kit: Number(row.is_full_service_kit) === 1,
    date_required: String(row.date_required),
    estimated_amount: Number(row.estimated_amount),
    quotation_filename: row.quotation_filename ? String(row.quotation_filename) : null,
    has_quotation_file: Number(row.has_quotation_file ?? 0) === 1,
    status: row.status as PartsPurchaseStatus,
    admin_notes: String(row.admin_notes ?? ''),
    requested_by: row.requested_by ? Number(row.requested_by) : null,
    requested_by_name: row.requested_by_name ? String(row.requested_by_name) : undefined,
    authorized_by: row.authorized_by ? Number(row.authorized_by) : null,
    authorized_by_name: row.authorized_by_name ? String(row.authorized_by_name) : undefined,
    authorized_at: row.authorized_at ? String(row.authorized_at) : null,
    created_at: String(row.created_at),
  };
}

const LOG_SELECT_SQL = `
  SELECT
    l.*,
    v.reg_number,
    v.make_model,
    u.full_name AS created_by_name
  FROM vehicle_maintenance_logs l
  JOIN vehicles v ON v.id = l.vehicle_id
  LEFT JOIN users u ON u.id = l.created_by
`;

const GARAGE_SELECT_SQL = `
  SELECT
    g.*,
    v.reg_number,
    v.make_model,
    ru.full_name AS requested_by_name,
    au.full_name AS approved_by_name
  FROM garage_visits g
  JOIN vehicles v ON v.id = g.vehicle_id
  LEFT JOIN users ru ON ru.id = g.requested_by
  LEFT JOIN users au ON au.id = g.approved_by
`;

const PARTS_LIST_SELECT_SQL = `
  SELECT
    p.id, p.request_date, p.vehicle_id, p.parts_required, p.is_full_service_kit,
    p.date_required, p.estimated_amount, p.quotation_filename, p.status, p.admin_notes,
    p.requested_by, p.authorized_by, p.authorized_at, p.created_at,
    CASE WHEN p.quotation_file IS NOT NULL AND p.quotation_file != '' THEN 1 ELSE 0 END AS has_quotation_file,
    v.reg_number,
    v.make_model,
    ru.full_name AS requested_by_name,
    au.full_name AS authorized_by_name
  FROM parts_purchase_requests p
  JOIN vehicles v ON v.id = p.vehicle_id
  LEFT JOIN users ru ON ru.id = p.requested_by
  LEFT JOIN users au ON au.id = p.authorized_by
`;

export function registerMaintenanceRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // ---------------- OVERVIEW (ALL AUTHENTICATED ROLES; READ-ONLY FOR DRIVER/SUPERVISOR) ----------------
  app.get('/fleet-maintenance/overview', requireAuth, requirePinChanged(), async (c) => {
    const vehicleIdParam = c.req.query('vehicle_id');
    const filterVehicleId = vehicleIdParam ? Number(vehicleIdParam) : null;
    if (vehicleIdParam && (!Number.isInteger(filterVehicleId) || (filterVehicleId ?? 0) <= 0)) {
      return c.json({ error: 'Invalid vehicle filter.' }, 400);
    }

    const whereClause = filterVehicleId ? 'WHERE v.id = ?' : '';
    const filterBind = filterVehicleId ? [filterVehicleId] : [];

    const [logsRes, garageRes, partsRes, vehiclesRes] = await Promise.all([
      c.env.DB.prepare(
        `${LOG_SELECT_SQL} ${whereClause} ORDER BY l.service_date DESC, l.id DESC LIMIT 200`
      )
        .bind(...filterBind)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(
        `${GARAGE_SELECT_SQL} ${whereClause} ORDER BY g.visit_date DESC, g.id DESC LIMIT 200`
      )
        .bind(...filterBind)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(
        `${PARTS_LIST_SELECT_SQL} ${whereClause} ORDER BY p.request_date DESC, p.id DESC LIMIT 200`
      )
        .bind(...filterBind)
        .all<Record<string, unknown>>(),
      c.env.DB.prepare(
        `SELECT id, reg_number, make_model, vehicle_type, condition, last_known_mileage, next_service_due_km, active
         FROM vehicles
         ORDER BY active DESC, reg_number ASC`
      ).all<Record<string, unknown>>(),
    ]);

    const maintenanceLogs = logsRes.results.map(mapMaintenanceLogRow);
    const garageVisits = garageRes.results.map(mapGarageVisitRow);
    const partsRequests = partsRes.results.map(mapPartsRequestRow);

    const serviceDues: VehicleServiceDueSummary[] = vehiclesRes.results.map((v) => {
      const mileage = Number(v.last_known_mileage);
      const nextDue =
        v.next_service_due_km !== null && v.next_service_due_km !== undefined
          ? Number(v.next_service_due_km)
          : null;
      const { remaining_km, service_due_status } = computeNextServiceStatus(mileage, nextDue);
      return {
        vehicle_id: Number(v.id),
        reg_number: String(v.reg_number),
        make_model: String(v.make_model),
        vehicle_type: String(v.vehicle_type),
        condition: v.condition as VehicleCondition,
        last_known_mileage: mileage,
        next_service_due_km: nextDue,
        remaining_km,
        service_due_status,
        active: Number(v.active) === 1,
      };
    });

    const filteredServiceDues = filterVehicleId
      ? serviceDues.filter((s) => s.vehicle_id === filterVehicleId)
      : serviceDues;

    const summary: FleetMaintenanceOverview['summary'] = {
      totalLogs: maintenanceLogs.length,
      pendingGarageApprovals: garageVisits.filter((g) => g.approval_status === 'PENDING_APPROVAL')
        .length,
      inGarageCount: garageVisits.filter(
        (g) => g.approval_status === 'APPROVED' && g.visit_status === 'IN_GARAGE'
      ).length,
      pendingPartsAuthorizations: partsRequests.filter(
        (p) => p.status === 'PENDING_ADMIN_AUTHORIZATION'
      ).length,
      serviceDueSoonOrOverdueCount: serviceDues.filter(
        (s) =>
          s.active &&
          (s.service_due_status === 'DUE_SOON' || s.service_due_status === 'OVERDUE')
      ).length,
      groundedVehiclesCount: serviceDues.filter((s) => s.active && s.condition === 'Grounded')
        .length,
    };

    const payload: FleetMaintenanceOverview = {
      maintenanceLogs,
      garageVisits,
      partsRequests,
      serviceDues: filteredServiceDues,
      summary,
    };

    return c.json(payload);
  });

  // ---------------- MECHANICAL & SERVICE HISTORY LOGS ----------------
  app.post(
    '/fleet-maintenance/logs',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        vehicle_id?: number;
        record_type?: MaintenanceRecordType;
        service_date?: string;
        odometer_km?: number;
        summary?: string;
        details?: string;
        workshop_name?: string;
        cost?: number | null;
        next_service_due_km?: number | null;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const vehicleId = Number(body.vehicle_id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return c.json({ error: 'Choose a valid vehicle.' }, 400);
      }
      const recordType = body.record_type;
      if (recordType !== 'MECHANICAL' && recordType !== 'SERVICE') {
        return c.json({ error: 'Choose a valid record type (MECHANICAL or SERVICE).' }, 400);
      }
      const serviceDate = (body.service_date || '').trim();
      if (!isValidIsoDate(serviceDate)) {
        return c.json({ error: 'Enter a valid service date (YYYY-MM-DD).' }, 400);
      }
      const odometerKm = Number(body.odometer_km);
      if (!Number.isInteger(odometerKm) || odometerKm < 0) {
        return c.json({ error: 'Odometer reading (km) must be a whole number 0 or greater.' }, 400);
      }
      const summary = (body.summary || '').trim();
      if (!summary || summary.length < 3) {
        return c.json({ error: 'Enter a work summary (at least 3 characters).' }, 400);
      }
      const details = (body.details || '').trim();
      const workshopName = (body.workshop_name || '').trim();
      const costCheck = parseOptionalCost(body.cost, 'Cost');
      if (!costCheck.ok) return c.json({ error: costCheck.error }, 400);
      const nextDueCheck = parseOptionalIntKm(body.next_service_due_km, 'Next service due (km)');
      if (!nextDueCheck.ok) return c.json({ error: nextDueCheck.error }, 400);

      const vehicleRow = await c.env.DB.prepare(
        'SELECT id, reg_number, make_model, last_known_mileage, next_service_due_km FROM vehicles WHERE id = ?'
      )
        .bind(vehicleId)
        .first<Record<string, unknown>>();
      if (!vehicleRow) {
        return c.json({ error: 'Vehicle not found.' }, 404);
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO vehicle_maintenance_logs
           (vehicle_id, record_type, service_date, odometer_km, summary, details, workshop_name, cost, next_service_due_km, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          vehicleId,
          recordType,
          serviceDate,
          odometerKm,
          summary,
          details,
          workshopName,
          costCheck.value,
          nextDueCheck.value,
          actor.id
        )
        .run();

      if (nextDueCheck.value !== null) {
        await c.env.DB.prepare('UPDATE vehicles SET next_service_due_km = ? WHERE id = ?')
          .bind(nextDueCheck.value, vehicleId)
          .run();
      }

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${LOG_SELECT_SQL} WHERE l.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const log = mapMaintenanceLogRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'MAINTENANCE_LOG_CREATED',
        entity: 'vehicle_maintenance_logs',
        entityId: newId,
        newValue: {
          vehicle_id: vehicleId,
          reg_number: log.reg_number,
          record_type: log.record_type,
          service_date: log.service_date,
          odometer_km: log.odometer_km,
          summary: log.summary,
          workshop_name: log.workshop_name,
          cost: log.cost,
          next_service_due_km: log.next_service_due_km,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'MAINTENANCE_LOG_CREATED',
          priority: 'NORMAL',
          title: `${log.record_type === 'SERVICE' ? 'Service' : 'Mechanical'} logged: ${log.reg_number}`,
          body: `${actor.full_name} recorded ${log.record_type.toLowerCase()} entry for ${log.reg_number} (${log.make_model}) at ${log.odometer_km.toLocaleString()} km: ${log.summary}.`,
        },
        { env: c.env, roles: ['ADMIN', 'FLEET_MANAGER'] }
      );

      return c.json({ log }, 201);
    }
  );

  // ---------------- NEXT SERVICE DUE (KM) ----------------
  app.patch(
    '/fleet-maintenance/next-service/:vehicleId',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const vehicleId = Number(c.req.param('vehicleId'));
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return c.json({ error: 'Invalid vehicle ID.' }, 400);
      }

      let body: { next_service_due_km?: number | null };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const nextDueCheck = parseOptionalIntKm(body.next_service_due_km, 'Next service due (km)');
      if (!nextDueCheck.ok) return c.json({ error: nextDueCheck.error }, 400);

      const existingRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
        .bind(vehicleId)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Vehicle not found.' }, 404);
      }
      const oldVehicle = mapVehicleRow(existingRow);

      await c.env.DB.prepare('UPDATE vehicles SET next_service_due_km = ? WHERE id = ?')
        .bind(nextDueCheck.value, vehicleId)
        .run();

      const updatedRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
        .bind(vehicleId)
        .first<Record<string, unknown>>();
      const updated = mapVehicleRow(updatedRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'VEHICLE_NEXT_SERVICE_UPDATED',
        entity: 'vehicles',
        entityId: vehicleId,
        oldValue: { next_service_due_km: oldVehicle.next_service_due_km ?? null },
        newValue: { next_service_due_km: updated.next_service_due_km ?? null },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      const { remaining_km, service_due_status } = computeNextServiceStatus(
        updated.last_known_mileage,
        updated.next_service_due_km ?? null
      );

      return c.json({
        vehicle: updated,
        serviceDue: {
          vehicle_id: updated.id,
          reg_number: updated.reg_number,
          make_model: updated.make_model,
          vehicle_type: updated.vehicle_type,
          condition: updated.condition,
          last_known_mileage: updated.last_known_mileage,
          next_service_due_km: updated.next_service_due_km ?? null,
          remaining_km,
          service_due_status,
          active: updated.active,
        } satisfies VehicleServiceDueSummary,
      });
    }
  );

  // ---------------- GARAGE VISITS ----------------
  app.post(
    '/fleet-maintenance/garage-visits',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        vehicle_id?: number;
        visit_date?: string;
        workshop_name?: string;
        reason?: string;
        odometer_km?: number;
        estimated_cost?: number | null;
        notes?: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const vehicleId = Number(body.vehicle_id);
      if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
        return c.json({ error: 'Choose a valid vehicle.' }, 400);
      }
      const visitDate = (body.visit_date || '').trim();
      if (!isValidIsoDate(visitDate)) {
        return c.json({ error: 'Enter a valid garage visit date (YYYY-MM-DD).' }, 400);
      }
      const workshopName = (body.workshop_name || '').trim();
      if (!workshopName || workshopName.length < 2) {
        return c.json({ error: 'Enter the workshop or garage name.' }, 400);
      }
      const reason = (body.reason || '').trim();
      if (!reason || reason.length < 3) {
        return c.json({ error: 'Enter the reason for the garage visit.' }, 400);
      }
      const odometerKm = Number(body.odometer_km);
      if (!Number.isInteger(odometerKm) || odometerKm < 0) {
        return c.json({ error: 'Odometer reading (km) must be a whole number 0 or greater.' }, 400);
      }
      const estCheck = parseOptionalCost(body.estimated_cost, 'Estimated cost');
      if (!estCheck.ok) return c.json({ error: estCheck.error }, 400);
      const notes = (body.notes || '').trim();

      const vehicleRow = await c.env.DB.prepare('SELECT id FROM vehicles WHERE id = ?')
        .bind(vehicleId)
        .first<{ id: number }>();
      if (!vehicleRow) {
        return c.json({ error: 'Vehicle not found.' }, 404);
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO garage_visits
           (vehicle_id, visit_date, workshop_name, reason, odometer_km, estimated_cost, approval_status, visit_status, notes, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 'SCHEDULED', ?, ?)`
      )
        .bind(vehicleId, visitDate, workshopName, reason, odometerKm, estCheck.value, notes, actor.id)
        .run();

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${GARAGE_SELECT_SQL} WHERE g.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const visit = mapGarageVisitRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'GARAGE_VISIT_REQUESTED',
        entity: 'garage_visits',
        entityId: newId,
        newValue: {
          vehicle_id: visit.vehicle_id,
          reg_number: visit.reg_number,
          visit_date: visit.visit_date,
          workshop_name: visit.workshop_name,
          reason: visit.reason,
          estimated_cost: visit.estimated_cost,
          approval_status: visit.approval_status,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'GARAGE_VISIT_REQUESTED',
          priority: 'HIGH',
          title: `Garage visit awaiting Admin approval: ${visit.reg_number}`,
          body: `${actor.full_name} requested garage visit for ${visit.reg_number} at ${visit.workshop_name} on ${visit.visit_date}: ${visit.reason}.`,
        },
        { env: c.env, roles: ['ADMIN'] }
      );

      return c.json({ visit }, 201);
    }
  );

  app.post(
    '/fleet-maintenance/garage-visits/:id/decision',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid garage visit ID.' }, 400);
      }

      let body: { decision?: 'APPROVED' | 'REJECTED'; approval_notes?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const decision = body.decision;
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        return c.json({ error: 'Decision must be APPROVED or REJECTED.' }, 400);
      }
      const approvalNotes = (body.approval_notes || '').trim();

      const existingRow = await c.env.DB.prepare(`${GARAGE_SELECT_SQL} WHERE g.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Garage visit record not found.' }, 404);
      }
      const oldVisit = mapGarageVisitRow(existingRow);

      const nextVisitStatus: GarageVisitStatus =
        decision === 'REJECTED' && oldVisit.visit_status === 'SCHEDULED'
          ? 'CANCELLED'
          : oldVisit.visit_status;
      const nowIso = new Date().toISOString();

      await c.env.DB.prepare(
        `UPDATE garage_visits
         SET approval_status = ?, visit_status = ?, approved_by = ?, approved_at = ?, approval_notes = ?
         WHERE id = ?`
      )
        .bind(decision, nextVisitStatus, actor.id, nowIso, approvalNotes, id)
        .run();

      const updatedRow = await c.env.DB.prepare(`${GARAGE_SELECT_SQL} WHERE g.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const visit = mapGarageVisitRow(updatedRow!);

      const action = decision === 'APPROVED' ? 'GARAGE_VISIT_APPROVED' : 'GARAGE_VISIT_REJECTED';

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action,
        entity: 'garage_visits',
        entityId: id,
        oldValue: {
          approval_status: oldVisit.approval_status,
          visit_status: oldVisit.visit_status,
        },
        newValue: {
          approval_status: visit.approval_status,
          visit_status: visit.visit_status,
          approval_notes: visit.approval_notes,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: action,
          priority: decision === 'REJECTED' ? 'HIGH' : 'NORMAL',
          title: `Garage visit ${decision.toLowerCase()}: ${visit.reg_number}`,
          body: `Admin ${actor.full_name} ${decision.toLowerCase()} the garage visit for ${visit.reg_number} at ${visit.workshop_name}.${
            visit.approval_notes ? ` Notes: ${visit.approval_notes}` : ''
          }`,
        },
        { env: c.env, roles: ['FLEET_MANAGER', 'ADMIN'] }
      );

      return c.json({ visit });
    }
  );

  app.patch(
    '/fleet-maintenance/garage-visits/:id/status',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid garage visit ID.' }, 400);
      }

      let body: {
        visit_status?: GarageVisitStatus;
        actual_cost?: number | null;
        notes?: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const existingRow = await c.env.DB.prepare(`${GARAGE_SELECT_SQL} WHERE g.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Garage visit record not found.' }, 404);
      }
      const oldVisit = mapGarageVisitRow(existingRow);

      const nextStatus = body.visit_status ?? oldVisit.visit_status;
      if (
        nextStatus !== 'SCHEDULED' &&
        nextStatus !== 'IN_GARAGE' &&
        nextStatus !== 'COMPLETED' &&
        nextStatus !== 'CANCELLED'
      ) {
        return c.json({ error: 'Choose a valid visit status.' }, 400);
      }

      if (
        (nextStatus === 'IN_GARAGE' || nextStatus === 'COMPLETED') &&
        oldVisit.approval_status !== 'APPROVED'
      ) {
        return c.json(
          { error: 'Admin approval is required before marking a garage visit In Garage or Completed.' },
          400
        );
      }

      const actualCostCheck =
        body.actual_cost !== undefined
          ? parseOptionalCost(body.actual_cost, 'Actual cost')
          : { ok: true as const, value: oldVisit.actual_cost };
      if (!actualCostCheck.ok) return c.json({ error: actualCostCheck.error }, 400);
      const nextNotes = body.notes !== undefined ? body.notes.trim() : oldVisit.notes;

      await c.env.DB.prepare(
        'UPDATE garage_visits SET visit_status = ?, actual_cost = ?, notes = ? WHERE id = ?'
      )
        .bind(nextStatus, actualCostCheck.value, nextNotes, id)
        .run();

      const updatedRow = await c.env.DB.prepare(`${GARAGE_SELECT_SQL} WHERE g.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const visit = mapGarageVisitRow(updatedRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'GARAGE_VISIT_STATUS_UPDATED',
        entity: 'garage_visits',
        entityId: id,
        oldValue: {
          visit_status: oldVisit.visit_status,
          actual_cost: oldVisit.actual_cost,
        },
        newValue: {
          visit_status: visit.visit_status,
          actual_cost: visit.actual_cost,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ visit });
    }
  );

  // ---------------- PARTS & SERVICE KITS PURCHASE REQUESTS ----------------
  app.post(
    '/fleet-maintenance/parts-requests',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        request_date?: string;
        vehicle_id?: number;
        new_vehicle?: {
          reg_number?: string;
          vehicle_type?: string;
          make_model?: string;
          condition?: VehicleCondition;
          last_known_mileage?: number;
        };
        parts_required?: string;
        is_full_service_kit?: boolean;
        date_required?: string;
        estimated_amount?: number;
        quotation_file?: string | null;
        quotation_filename?: string | null;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const requestDate = (body.request_date || '').trim();
      if (!isValidIsoDate(requestDate)) {
        return c.json({ error: 'Enter a valid request date (YYYY-MM-DD).' }, 400);
      }
      const dateRequired = (body.date_required || '').trim();
      if (!isValidIsoDate(dateRequired)) {
        return c.json({ error: 'Enter a valid Date Required (YYYY-MM-DD).' }, 400);
      }

      const isFullServiceKit = Boolean(body.is_full_service_kit);
      let partsRequired = (body.parts_required || '').trim();
      if (!partsRequired && isFullServiceKit) {
        partsRequired = 'Full Service Kit';
      }
      if (!partsRequired || partsRequired.length < 2) {
        return c.json({ error: 'Specify the parts required or select Full Service Kit.' }, 400);
      }

      const estAmount = Number(body.estimated_amount);
      if (!Number.isFinite(estAmount) || estAmount < 0) {
        return c.json({ error: 'Amount (EST) must be 0 or greater.' }, 400);
      }
      const roundedAmount = Math.round(estAmount * 100) / 100;

      const quotationCheck = validateDocumentDataUrl(body.quotation_file, 'Quotation file');
      if (!quotationCheck.ok) {
        return c.json({ error: quotationCheck.error }, 400);
      }
      const quotationFilename =
        quotationCheck.value && body.quotation_filename
          ? String(body.quotation_filename).trim().slice(0, 160) || 'quotation'
          : quotationCheck.value
            ? 'quotation'
            : null;

      let targetVehicleId: number | null = body.vehicle_id ? Number(body.vehicle_id) : null;
      let createdVehicle: Vehicle | undefined;

      if (body.new_vehicle) {
        const nv = body.new_vehicle;
        const regNumber = (nv.reg_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
        const vehicleType = (nv.vehicle_type || '').trim();
        const makeModel = (nv.make_model || '').trim();
        const condition = nv.condition || 'Needs Little Attention';
        const mileage = Number(nv.last_known_mileage ?? 0);

        if (!regNumber || regNumber.length < 3) {
          return c.json(
            { error: 'Enter the new vehicle registration number (at least 3 characters).' },
            400
          );
        }
        const vehicleClass = VEHICLE_TYPE_TO_CLASS[vehicleType];
        if (!vehicleClass) {
          return c.json({ error: 'Choose a valid vehicle type for the new vehicle.' }, 400);
        }
        if (!makeModel || makeModel.length < 2) {
          return c.json({ error: 'Enter the new vehicle make and model.' }, 400);
        }
        if (!VEHICLE_CONDITIONS.includes(condition)) {
          return c.json({ error: 'Choose a valid vehicle condition.' }, 400);
        }
        if (!Number.isInteger(mileage) || mileage < 0) {
          return c.json({ error: 'Mileage must be a whole number 0 or greater.' }, 400);
        }

        const dup = await c.env.DB.prepare('SELECT id FROM vehicles WHERE reg_number = ?')
          .bind(regNumber)
          .first<{ id: number }>();
        if (dup) {
          return c.json(
            {
              error: `A vehicle with registration "${regNumber}" already exists in the Fleet Database. Select it instead.`,
            },
            409
          );
        }

        const vehRes = await c.env.DB.prepare(
          `INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, next_service_due_km, active)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`
        )
          .bind(regNumber, vehicleType, vehicleClass, makeModel, condition, mileage)
          .run();

        targetVehicleId = vehRes.meta.last_row_id;
        const vehRow = await c.env.DB.prepare(`${VEHICLE_SELECT_SQL} WHERE v.id = ?`)
          .bind(targetVehicleId)
          .first<Record<string, unknown>>();
        createdVehicle = mapVehicleRow(vehRow!);

        await recordAudit(c.env.DB, {
          userId: actor.id,
          username: actor.username,
          userRole: actor.role,
          action: 'VEHICLE_CREATED',
          entity: 'vehicles',
          entityId: targetVehicleId,
          newValue: {
            reg_number: createdVehicle.reg_number,
            vehicle_type: createdVehicle.vehicle_type,
            vehicle_class: createdVehicle.vehicle_class,
            make_model: createdVehicle.make_model,
            condition: createdVehicle.condition,
            last_known_mileage: createdVehicle.last_known_mileage,
            source: 'PARTS_PURCHASE_REQUEST',
          },
          ip: getClientIp(c),
          userAgent: getUserAgent(c),
        });
      } else {
        if (!targetVehicleId || !Number.isInteger(targetVehicleId) || targetVehicleId <= 0) {
          return c.json({ error: 'Select a vehicle from the Fleet Database or add a new vehicle.' }, 400);
        }
        const existingVeh = await c.env.DB.prepare('SELECT id FROM vehicles WHERE id = ?')
          .bind(targetVehicleId)
          .first<{ id: number }>();
        if (!existingVeh) {
          return c.json({ error: 'Selected vehicle not found.' }, 404);
        }
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO parts_purchase_requests
           (request_date, vehicle_id, parts_required, is_full_service_kit, date_required, estimated_amount, quotation_file, quotation_filename, status, requested_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_ADMIN_AUTHORIZATION', ?)`
      )
        .bind(
          requestDate,
          targetVehicleId,
          partsRequired,
          isFullServiceKit ? 1 : 0,
          dateRequired,
          roundedAmount,
          quotationCheck.value,
          quotationFilename,
          actor.id
        )
        .run();

      const newId = res.meta.last_row_id;
      const createdRow = await c.env.DB.prepare(`${PARTS_LIST_SELECT_SQL} WHERE p.id = ?`)
        .bind(newId)
        .first<Record<string, unknown>>();
      const requestRecord = mapPartsRequestRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'PARTS_PURCHASE_REQUESTED',
        entity: 'parts_purchase_requests',
        entityId: newId,
        newValue: {
          request_date: requestRecord.request_date,
          vehicle_id: requestRecord.vehicle_id,
          reg_number: requestRecord.reg_number,
          parts_required: requestRecord.parts_required,
          is_full_service_kit: requestRecord.is_full_service_kit,
          date_required: requestRecord.date_required,
          estimated_amount: requestRecord.estimated_amount,
          has_quotation_file: requestRecord.has_quotation_file,
          quotation_filename: requestRecord.quotation_filename,
          status: requestRecord.status,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'PARTS_PURCHASE_REQUESTED',
          priority: 'HIGH',
          title: `Parts purchase authorization required: ${requestRecord.reg_number}`,
          body: `${actor.full_name} requested $${requestRecord.estimated_amount.toFixed(2)} for ${requestRecord.parts_required} (${requestRecord.reg_number}), required by ${requestRecord.date_required}. Waiting for Admin authorization.`,
        },
        { env: c.env, roles: ['ADMIN'] }
      );

      return c.json(
        createdVehicle ? { request: requestRecord, createdVehicle } : { request: requestRecord },
        201
      );
    }
  );

  app.get('/fleet-maintenance/parts-requests/:id/quotation', requireAuth, requirePinChanged(), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid request ID.' }, 400);
    }

    const row = await c.env.DB.prepare(
      'SELECT quotation_file, quotation_filename FROM parts_purchase_requests WHERE id = ?'
    )
      .bind(id)
      .first<{ quotation_file: string | null; quotation_filename: string | null }>();

    if (!row) {
      return c.json({ error: 'Parts purchase request not found.' }, 404);
    }
    if (!row.quotation_file) {
      return c.json({ error: 'No quotation file attached to this request.' }, 404);
    }

    return c.json({
      quotation_file: row.quotation_file,
      quotation_filename: row.quotation_filename || 'quotation',
    });
  });

  app.post(
    '/fleet-maintenance/parts-requests/:id/decision',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid request ID.' }, 400);
      }

      let body: { decision?: 'APPROVED' | 'REJECTED' | 'PURCHASED'; admin_notes?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const decision = body.decision;
      if (decision !== 'APPROVED' && decision !== 'REJECTED' && decision !== 'PURCHASED') {
        return c.json({ error: 'Decision must be APPROVED, REJECTED, or PURCHASED.' }, 400);
      }
      const adminNotes = (body.admin_notes || '').trim();

      const existingRow = await c.env.DB.prepare(`${PARTS_LIST_SELECT_SQL} WHERE p.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Parts purchase request not found.' }, 404);
      }
      const oldReq = mapPartsRequestRow(existingRow);

      const nowIso = new Date().toISOString();
      await c.env.DB.prepare(
        `UPDATE parts_purchase_requests
         SET status = ?, admin_notes = ?, authorized_by = ?, authorized_at = ?
         WHERE id = ?`
      )
        .bind(decision, adminNotes, actor.id, nowIso, id)
        .run();

      const updatedRow = await c.env.DB.prepare(`${PARTS_LIST_SELECT_SQL} WHERE p.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const updated = mapPartsRequestRow(updatedRow!);

      const action =
        decision === 'REJECTED' ? 'PARTS_PURCHASE_REJECTED' : 'PARTS_PURCHASE_AUTHORIZED';

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action,
        entity: 'parts_purchase_requests',
        entityId: id,
        oldValue: { status: oldReq.status },
        newValue: { status: updated.status, admin_notes: updated.admin_notes },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: action,
          priority: decision === 'REJECTED' ? 'HIGH' : 'NORMAL',
          title: `Parts purchase ${decision.toLowerCase()}: ${updated.reg_number}`,
          body: `Admin ${actor.full_name} marked parts request for ${updated.reg_number} (${updated.parts_required}) as ${decision}.${
            updated.admin_notes ? ` Notes: ${updated.admin_notes}` : ''
          }`,
        },
        { env: c.env, roles: ['FLEET_MANAGER', 'ADMIN'] }
      );

      return c.json({ request: updated });
    }
  );

  app.patch(
    '/fleet-maintenance/parts-requests/:id/status',
    requireAuth,
    requirePinChanged(),
    requireRole(['FLEET_MANAGER', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) {
        return c.json({ error: 'Invalid request ID.' }, 400);
      }

      let body: { status?: PartsPurchaseStatus };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      if (body.status !== 'PURCHASED') {
        return c.json({ error: 'Only marking an approved request as PURCHASED is supported here.' }, 400);
      }

      const existingRow = await c.env.DB.prepare(`${PARTS_LIST_SELECT_SQL} WHERE p.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      if (!existingRow) {
        return c.json({ error: 'Parts purchase request not found.' }, 404);
      }
      const oldReq = mapPartsRequestRow(existingRow);

      if (oldReq.status !== 'APPROVED') {
        return c.json(
          { error: 'Only Admin-approved parts requests can be marked as Purchased.' },
          400
        );
      }

      await c.env.DB.prepare("UPDATE parts_purchase_requests SET status = 'PURCHASED' WHERE id = ?")
        .bind(id)
        .run();

      const updatedRow = await c.env.DB.prepare(`${PARTS_LIST_SELECT_SQL} WHERE p.id = ?`)
        .bind(id)
        .first<Record<string, unknown>>();
      const updated = mapPartsRequestRow(updatedRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'PARTS_PURCHASE_COMPLETED',
        entity: 'parts_purchase_requests',
        entityId: id,
        oldValue: { status: oldReq.status },
        newValue: { status: updated.status },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ request: updated });
    }
  );
}
