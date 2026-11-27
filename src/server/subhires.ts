import type { Hono } from 'hono';
import {
  FUEL_LEVELS,
  VEHICLE_CONDITIONS,
  VEHICLE_TYPE_TO_CLASS,
  evaluateChecklistVehicleMatch,
  formatSubhiredMakeModel,
  toHarareYmd,
  type CreateSubhirePayload,
  type FuelLevel,
  type SubhireReceipt,
  type UserPublic,
  type Vehicle,
  type VehicleClass,
  type VehicleCondition,
  type VehicleFuelType,
} from '../shared/types';
import { recordAudit } from './audit';
import { mapVehicleRow, type RouteAuthDeps } from './directories';
import { checkAndNotifyVehicleServiceDues, notifyManagersInApp } from './notifications';
import type { AppEnv } from './types';

const VALID_FUEL_TYPES: readonly VehicleFuelType[] = ['diesel', 'petrol', 'ev'];

function mapSubhireRow(row: Record<string, unknown>): SubhireReceipt {
  return {
    id: Number(row.id),
    vehicle_id: Number(row.vehicle_id),
    checklist_id:
      row.checklist_id !== null && row.checklist_id !== undefined ? Number(row.checklist_id) : null,
    subhirer_name: String(row.subhirer_name),
    representative: String(row.representative ?? ''),
    phone: String(row.phone),
    address: String(row.address ?? ''),
    received_mileage: Number(row.received_mileage),
    fuel_level: row.fuel_level as FuelLevel,
    opening_checklist_by: String(row.opening_checklist_by),
    notes: String(row.notes ?? ''),
    status: (row.status as 'ACTIVE' | 'RETURNED') || 'ACTIVE',
    received_at: String(row.received_at),
    device_time: row.device_time ? String(row.device_time) : null,
    created_by: Number(row.created_by),
    created_by_name: row.created_by_name ? String(row.created_by_name) : undefined,
    created_at: String(row.created_at),
    reg_number: String(row.reg_number),
    make_model: String(row.make_model),
    vehicle_type: String(row.vehicle_type),
    vehicle_class: row.vehicle_class as VehicleClass,
    checklist_hirer_name: row.checklist_hirer_name ? String(row.checklist_hirer_name) : null,
    checklist_hirer_type: row.checklist_hirer_type
      ? (row.checklist_hirer_type as 'renter' | 'owner')
      : null,
  };
}

const SUBHIRE_SELECT = `
  SELECT
    sr.*,
    v.reg_number, v.make_model, v.vehicle_type, v.vehicle_class,
    u.full_name AS created_by_name,
    chk.hirer_name AS checklist_hirer_name,
    chk.hirer_type AS checklist_hirer_type
  FROM subhire_receipts sr
  JOIN vehicles v ON v.id = sr.vehicle_id
  JOIN users u ON u.id = sr.created_by
  LEFT JOIN checklists chk ON chk.id = sr.checklist_id
`;

export function registerSubhireRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, getClientIp, getUserAgent } = deps;

  app.get('/subhires', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50)));
    const whereSql = actor.role === 'DRIVER' ? 'WHERE sr.created_by = ?' : '';
    const params: unknown[] = actor.role === 'DRIVER' ? [actor.id, limit] : [limit];

    const { results } = await c.env.DB.prepare(
      `${SUBHIRE_SELECT}
       ${whereSql}
       ORDER BY sr.id DESC
       LIMIT ?`
    )
      .bind(...params)
      .all<Record<string, unknown>>();

    return c.json({ items: results.map(mapSubhireRow) });
  });

  app.post('/subhires', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    let body: CreateSubhirePayload;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request payload.' }, 400);
    }

    const subhirerName = String(body.subhirer_name || '').trim();
    const representative = String(body.representative || '').trim();
    const phone = String(body.phone || '').trim();
    const address = String(body.address || '').trim();
    const receivedMileage = Number(body.received_mileage);
    const fuelLevel = body.fuel_level;
    const checklistBy = String(body.opening_checklist_by || '').trim();
    const notes = String(body.notes || '').trim();
    const deviceTime = body.device_time ? String(body.device_time).trim() : null;

    if (subhirerName.length < 2) {
      return c.json({ error: 'Enter the Subhirer Name.' }, 400);
    }
    if (phone.length < 5) {
      return c.json({ error: 'Enter a valid Subhirer phone number.' }, 400);
    }
    if (!Number.isInteger(receivedMileage) || receivedMileage < 0) {
      return c.json({ error: 'Mileage when received must be a whole number 0 or greater.' }, 400);
    }
    if (!fuelLevel || !(FUEL_LEVELS as readonly string[]).includes(fuelLevel)) {
      return c.json({ error: 'Select the fuel level when received.' }, 400);
    }
    if (!checklistBy) {
      return c.json({ error: 'Enter the name of the person who did the checklist.' }, 400);
    }

    let parsedChecklistId: number | null = null;
    if (body.checklist_id !== undefined && body.checklist_id !== null && Number(body.checklist_id) !== 0) {
      const candidateId = Number(body.checklist_id);
      if (!Number.isInteger(candidateId) || candidateId <= 0) {
        return c.json({ error: 'Invalid linked checklist ID.' }, 400);
      }
      parsedChecklistId = candidateId;
    }

    let existingVehicleRow: Record<string, unknown> | null = null;
    let newSubhireVehicleSpec: {
      regNumber: string;
      vehicleType: string;
      vehicleClass: VehicleClass;
      formattedMakeModel: string;
      colour: string | null;
      fuelType: VehicleFuelType;
      condition: VehicleCondition;
      effectiveMileage: number;
      nextServiceDueKm: number | null;
      saveToDirectory: boolean;
    } | null = null;

    if (body.new_vehicle) {
      const nv = body.new_vehicle;
      const regNumber = String(nv.reg_number || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ');
      const vehicleType = String(nv.vehicle_type || '').trim();
      const formattedMakeModel = formatSubhiredMakeModel(String(nv.make_model || ''));
      const colour = nv.colour ? String(nv.colour).trim() : null;
      const fuelType: VehicleFuelType = VALID_FUEL_TYPES.includes(nv.fuel_type as VehicleFuelType)
        ? (nv.fuel_type as VehicleFuelType)
        : 'petrol';
      const condition = (nv.condition || 'Good') as VehicleCondition;
      const startMileage =
        nv.last_known_mileage !== undefined && nv.last_known_mileage !== null
          ? Number(nv.last_known_mileage)
          : receivedMileage;
      const saveToDirectory = nv.save_to_directory !== false;
      const nextServiceDueKm =
        nv.next_service_due_km !== undefined &&
        nv.next_service_due_km !== null &&
        String(nv.next_service_due_km).trim() !== ''
          ? Number(nv.next_service_due_km)
          : null;

      if (regNumber.length < 3) {
        return c.json({ error: 'Registration number must be at least 3 characters.' }, 400);
      }
      const vehicleClass = VEHICLE_TYPE_TO_CLASS[vehicleType];
      if (!vehicleClass) {
        return c.json({ error: 'Choose a valid Vehicle Type.' }, 400);
      }
      if (String(nv.make_model || '').trim().length < 2) {
        return c.json({ error: 'Enter the vehicle Make & Model.' }, 400);
      }
      if (!(VEHICLE_CONDITIONS as readonly string[]).includes(condition)) {
        return c.json({ error: 'Choose a valid Vehicle Condition.' }, 400);
      }
      if (condition === 'Accident' || condition === 'Grounded') {
        return c.json(
          { error: `A subhired vehicle marked "${condition}" cannot be received into active fleet.` },
          400
        );
      }
      if (!Number.isInteger(startMileage) || startMileage < 0) {
        return c.json({ error: 'Current odometer must be a whole number 0 or greater.' }, 400);
      }
      if (
        nextServiceDueKm !== null &&
        (!Number.isInteger(nextServiceDueKm) || nextServiceDueKm < 0)
      ) {
        return c.json(
          { error: 'Next service due mileage must be a whole number 0 or greater.' },
          400
        );
      }

      const existingVehicle = await c.env.DB.prepare(
        'SELECT id, active FROM vehicles WHERE reg_number = ?'
      )
        .bind(regNumber)
        .first<{ id: number; active: number }>();

      if (existingVehicle) {
        return c.json(
          {
            error:
              existingVehicle.active === 1
                ? `Vehicle "${regNumber}" is already in the Vehicles Directory. Pick it from the existing vehicle selector instead.`
                : `Vehicle "${regNumber}" already exists in past records. Use a different registration or ask a Supervisor to re-enable it.`,
          },
          409
        );
      }

      newSubhireVehicleSpec = {
        regNumber,
        vehicleType,
        vehicleClass,
        formattedMakeModel,
        colour,
        fuelType,
        condition,
        effectiveMileage: Math.max(startMileage, receivedMileage),
        nextServiceDueKm,
        saveToDirectory,
      };
    } else if (body.vehicle_id && Number.isInteger(Number(body.vehicle_id)) && Number(body.vehicle_id) > 0) {
      existingVehicleRow = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(Number(body.vehicle_id))
        .first<Record<string, unknown>>();
      if (!existingVehicleRow || Number(existingVehicleRow.active) !== 1) {
        return c.json({ error: 'The selected vehicle is inactive or does not exist.' }, 404);
      }
      if (existingVehicleRow.condition === 'Accident' || existingVehicleRow.condition === 'Grounded') {
        return c.json(
          { error: `${existingVehicleRow.reg_number} is marked "${existingVehicleRow.condition}" and cannot be received into active fleet.` },
          400
        );
      }
    } else {
      return c.json({ error: 'Enter the subhired vehicle details or select an existing vehicle.' }, 400);
    }

    let linkedChecklistId: number | null = null;
    if (parsedChecklistId !== null) {
      const chkRow = await c.env.DB.prepare(
        `SELECT id, hirer_type, hirer_name, vehicle_id, reg_number, vehicle_type, hire_date, created_at, created_by, deleted_at
         FROM checklists WHERE id = ?`
      )
        .bind(parsedChecklistId)
        .first<{
          id: number;
          hirer_type: string;
          hirer_name: string;
          vehicle_id: number;
          reg_number: string;
          vehicle_type: string;
          hire_date: string;
          created_at: string;
          created_by: number;
          deleted_at: string | null;
        }>();
      if (!chkRow || chkRow.deleted_at) {
        return c.json({ error: 'Selected checklist was not found.' }, 404);
      }
      if (actor.role === 'DRIVER' && Number(chkRow.created_by) !== actor.id) {
        return c.json({ error: 'You can only link checklists that you created.' }, 403);
      }

      const targetRegNumber = newSubhireVehicleSpec
        ? newSubhireVehicleSpec.regNumber
        : String(existingVehicleRow!.reg_number);
      const targetVehicleType = newSubhireVehicleSpec
        ? newSubhireVehicleSpec.vehicleType
        : String(existingVehicleRow!.vehicle_type);
      const logDateYmd = toHarareYmd(
        deviceTime && !Number.isNaN(new Date(deviceTime).getTime())
          ? new Date(deviceTime)
          : new Date()
      );

      const matchResult = evaluateChecklistVehicleMatch(
        {
          hirer_type: chkRow.hirer_type as 'renter' | 'owner',
          hirer_name: chkRow.hirer_name,
          reg_number: chkRow.reg_number,
          vehicle_type: chkRow.vehicle_type,
          created_at: chkRow.created_at,
        },
        {
          expectedHirerType: 'owner',
          partyName: subhirerName,
          regNumber: targetRegNumber,
          vehicleType: targetVehicleType,
          logDateYmd,
        }
      );
      if (!matchResult.matched) {
        return c.json({ error: matchResult.reasons[0] }, 400);
      }
      linkedChecklistId = parsedChecklistId;
    }

    let vehicleRow: Record<string, unknown> | null = null;
    let vehicleCreatedInline = false;

    if (newSubhireVehicleSpec) {
      const vIns = await c.env.DB.prepare(
        `INSERT INTO vehicles (
           reg_number, vehicle_type, vehicle_class, make_model, colour, fuel_type,
           condition, last_known_mileage, last_fuel_level, next_service_due_km, next_service_mileage, active
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          newSubhireVehicleSpec.regNumber,
          newSubhireVehicleSpec.vehicleType,
          newSubhireVehicleSpec.vehicleClass,
          newSubhireVehicleSpec.formattedMakeModel,
          newSubhireVehicleSpec.colour,
          newSubhireVehicleSpec.fuelType,
          newSubhireVehicleSpec.condition,
          newSubhireVehicleSpec.effectiveMileage,
          fuelLevel,
          newSubhireVehicleSpec.nextServiceDueKm,
          newSubhireVehicleSpec.nextServiceDueKm,
          newSubhireVehicleSpec.saveToDirectory ? 1 : 0
        )
        .run();

      const newVehicleId = Number(vIns.meta.last_row_id);
      vehicleRow = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(newVehicleId)
        .first<Record<string, unknown>>();
      vehicleCreatedInline = true;

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: newSubhireVehicleSpec.saveToDirectory ? 'VEHICLE_CREATED' : 'VEHICLE_ONE_TIME_SUBHIRE',
        entity: 'vehicles',
        entityId: newVehicleId,
        newValue: {
          reg_number: newSubhireVehicleSpec.regNumber,
          vehicle_type: newSubhireVehicleSpec.vehicleType,
          vehicle_class: newSubhireVehicleSpec.vehicleClass,
          make_model: newSubhireVehicleSpec.formattedMakeModel,
          colour: newSubhireVehicleSpec.colour,
          fuel_type: newSubhireVehicleSpec.fuelType,
          condition: newSubhireVehicleSpec.condition,
          last_known_mileage: newSubhireVehicleSpec.effectiveMileage,
          next_service_due_km: newSubhireVehicleSpec.nextServiceDueKm,
          saved_to_directory: newSubhireVehicleSpec.saveToDirectory,
          subhired: true,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });
    } else {
      const nextMileage = Math.max(Number(existingVehicleRow!.last_known_mileage ?? 0), receivedMileage);
      await c.env.DB.prepare(
        `UPDATE vehicles SET last_known_mileage = ?, last_fuel_level = ? WHERE id = ?`
      )
        .bind(nextMileage, fuelLevel, Number(existingVehicleRow!.id))
        .run();
      vehicleRow = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(Number(existingVehicleRow!.id))
        .first<Record<string, unknown>>();
    }

    const vehicleId = Number(vehicleRow!.id);
    const nowIso = new Date().toISOString();

    const ins = await c.env.DB.prepare(
      `INSERT INTO subhire_receipts (
         vehicle_id, checklist_id, subhirer_name, representative, phone, address,
         received_mileage, fuel_level, opening_checklist_by, notes, status, received_at, device_time, created_by
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`
    )
      .bind(
        vehicleId,
        linkedChecklistId,
        subhirerName,
        representative,
        phone,
        address,
        receivedMileage,
        fuelLevel,
        checklistBy,
        notes,
        nowIso,
        deviceTime,
        actor.id
      )
      .run();

    const receiptId = Number(ins.meta.last_row_id);
    const createdRow = await c.env.DB.prepare(`${SUBHIRE_SELECT} WHERE sr.id = ?`)
      .bind(receiptId)
      .first<Record<string, unknown>>();
    const receipt = mapSubhireRow(createdRow!);
    const mappedVehicle: Vehicle = mapVehicleRow({
      ...vehicleRow!,
      open_trip_id: null,
      open_trip_type: null,
    });

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: 'SUBHIRE_VEHICLE_RECEIVED',
      entity: 'subhire_receipts',
      entityId: receiptId,
      newValue: {
        vehicle_id: vehicleId,
        reg_number: receipt.reg_number,
        make_model: receipt.make_model,
        subhirer_name: subhirerName,
        representative,
        phone,
        address,
        received_mileage: receivedMileage,
        fuel_level: fuelLevel,
        opening_checklist_by: checklistBy,
        checklist_id: linkedChecklistId,
        vehicle_created_inline: vehicleCreatedInline,
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    await notifyManagersInApp(
      c.env.DB,
      {
        eventType: 'SUBHIRE_VEHICLE_RECEIVED',
        priority: 'NORMAL',
        title: `Subhired Vehicle Received: ${receipt.reg_number}`,
        body: `${actor.full_name} received ${receipt.reg_number} (${receipt.make_model}) from subhirer ${subhirerName}${
          representative ? ` (Rep: ${representative})` : ''
        } at ${receivedMileage.toLocaleString()} km (Fuel ${fuelLevel}).`,
      },
      { env: c.env }
    );

    if (
      mappedVehicle.next_service_due_km !== null &&
      mappedVehicle.next_service_due_km !== undefined
    ) {
      await checkAndNotifyVehicleServiceDues(c.env.DB, { env: c.env });
    }

    return c.json({ receipt, vehicle: mappedVehicle }, 201);
  });
}
