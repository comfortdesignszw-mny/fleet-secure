import type { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  FUEL_FRACTIONS,
  FUEL_LEVELS,
  UNRECORDED_LICENCE_PREFIX,
  VEHICLE_CONDITIONS,
  VEHICLE_TYPE_TO_CLASS,
  normalizeDriverLicenceNumber,
  type AppSettings,
  type FuelLevel,
  type NewDriverInput,
  type NewVehicleInput,
  type TripCorrection,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
  type VehicleClass,
  type VehicleCondition,
} from '../shared/types';
import { recordAudit } from './audit';
import {
  computeLicenceExpiryStatus,
  isNotNullLicenceError,
  makeUnrecordedLicenceSentinel,
  validateDocumentDataUrl,
  validateDriverLicenceCode,
  type RouteAuthDeps,
} from './directories';
import {
  checkAndNotifyOverdueHires,
  checkAndNotifyVehicleServiceDues,
  notifyManagersInApp,
} from './notifications';
import type { AppEnv, D1DatabaseLike } from './types';

export interface FuelCalcResult {
  total_mileage: number;
  est_fuel_litres: number;
  gauge_fuel_litres: number;
  fuel_mismatch: boolean;
  tank_size: number;
  km_per_litre: number;
  threshold_litres: number;
}

export function calculateTripFuelAndMileage(params: {
  mileageOut: number;
  mileageIn: number;
  fuelOut: FuelLevel;
  fuelIn: FuelLevel;
  vehicleClass: VehicleClass;
  settings: AppSettings;
}): FuelCalcResult {
  const totalMileage = params.mileageIn - params.mileageOut;
  const tankSize =
    params.vehicleClass === 'HEAVY'
      ? Number(params.settings.heavy_tank_litres || 80)
      : Number(params.settings.economy_tank_litres || 60);
  const kmPerLitre =
    params.vehicleClass === 'HEAVY'
      ? Number(params.settings.heavy_km_per_litre || 8)
      : Number(params.settings.economy_km_per_litre || 10);
  const thresholdPct = Number(params.settings.fuel_mismatch_threshold_pct || 25);

  const estFuelLitres = Number((totalMileage / kmPerLitre).toFixed(1));
  const fracOut = FUEL_FRACTIONS[params.fuelOut];
  const fracIn = FUEL_FRACTIONS[params.fuelIn];
  const gaugeFuelLitres = Number(((fracOut - fracIn) * tankSize).toFixed(1));
  const thresholdLitres = Number(((thresholdPct / 100) * tankSize).toFixed(1));
  const fuelMismatch = Math.abs(estFuelLitres - gaugeFuelLitres) > thresholdLitres;

  return {
    total_mileage: totalMileage,
    est_fuel_litres: estFuelLitres,
    gauge_fuel_litres: gaugeFuelLitres,
    fuel_mismatch: fuelMismatch,
    tank_size: tankSize,
    km_per_litre: kmPerLitre,
    threshold_litres: thresholdLitres,
  };
}

async function loadSettings(db: D1DatabaseLike): Promise<AppSettings> {
  const { results } = await db
    .prepare('SELECT key, value FROM settings')
    .all<{ key: string; value: string }>();
  const merged: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    merged[row.key] = row.value;
  }
  return merged as unknown as AppSettings;
}

function parseFlags(raw: unknown): TripFlag[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TripFlag[]) : [];
  } catch {
    return [];
  }
}

function toHarareDateStr(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function mapTripSummaryRow(
  row: Record<string, unknown>,
  overdueHours: number,
  nowMs: number,
  todayHarare = toHarareDateStr(new Date(nowMs))
): TripSummary {
  const outFlags = parseFlags(row.out_flags);
  const inFlags = parseFlags(row.in_flags);
  const combinedFlags = [...outFlags, ...inFlags];

  const outAt = String(row.out_at);
  const status = row.status as 'OPEN' | 'CLOSED';
  const tripType = row.trip_type as TripType;
  const daysHired =
    row.days_hired !== null && row.days_hired !== undefined ? Number(row.days_hired) : null;
  const expectedReturnDate = row.expected_return_date ? String(row.expected_return_date) : null;
  const isReturnDue =
    status === 'OPEN' &&
    tripType === 'HIRE' &&
    Boolean(expectedReturnDate) &&
    expectedReturnDate! <= todayHarare;
  const isReturnOverdue =
    status === 'OPEN' &&
    tripType === 'HIRE' &&
    Boolean(expectedReturnDate) &&
    expectedReturnDate! < todayHarare;

  const elapsedHours = (nowMs - new Date(outAt).getTime()) / 3_600_000;
  const elapsedOverdue = status === 'OPEN' && tripType === 'HIRE' && elapsedHours > overdueHours;
  const isOverdue = elapsedOverdue || isReturnOverdue;

  if (elapsedOverdue && !combinedFlags.some((f) => f.code === 'OVERDUE')) {
    combinedFlags.push({
      code: 'OVERDUE',
      severity: 'HIGH',
      message: `Hire has been out for ${Math.floor(elapsedHours)} hours (limit: ${overdueHours}h).`,
    });
  } else if (isReturnOverdue && !combinedFlags.some((f) => f.code === 'OVERDUE')) {
    const daysOverdue = Math.max(
      1,
      Math.round(
        (new Date(`${todayHarare}T00:00:00Z`).getTime() -
          new Date(`${expectedReturnDate}T00:00:00Z`).getTime()) /
          86_400_000
      )
    );
    combinedFlags.push({
      code: 'OVERDUE',
      severity: 'HIGH',
      message: `Vehicle return date (${expectedReturnDate}) is ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} overdue and hire is still open.`,
    });
  }

  return {
    id: Number(row.id),
    trip_type: tripType,
    vehicle_id: Number(row.vehicle_id),
    driver_id: Number(row.driver_id),
    status,
    client_name: row.client_name ? String(row.client_name) : null,
    destination: row.destination ? String(row.destination) : null,
    reason: row.reason ? String(row.reason) : null,
    days_hired: daysHired,
    expected_return_date: expectedReturnDate,
    is_return_due: isReturnDue,
    is_return_overdue: isReturnOverdue,
    created_at: String(row.created_at),
    reg_number: String(row.reg_number),
    make_model: String(row.make_model),
    vehicle_type: String(row.vehicle_type),
    vehicle_class: row.vehicle_class as VehicleClass,
    driver_name: String(row.driver_name),
    driver_phone: String(row.driver_phone),
    out_at: outAt,
    mileage_out: Number(row.mileage_out),
    fuel_out: row.fuel_out as FuelLevel,
    in_at: row.in_at ? String(row.in_at) : null,
    mileage_in: row.mileage_in !== null && row.mileage_in !== undefined ? Number(row.mileage_in) : null,
    fuel_in: row.fuel_in ? (row.fuel_in as FuelLevel) : null,
    total_mileage:
      row.total_mileage !== null && row.total_mileage !== undefined ? Number(row.total_mileage) : null,
    est_fuel_litres:
      row.est_fuel_litres !== null && row.est_fuel_litres !== undefined
        ? Number(row.est_fuel_litres)
        : null,
    gauge_fuel_litres:
      row.gauge_fuel_litres !== null && row.gauge_fuel_litres !== undefined
        ? Number(row.gauge_fuel_litres)
        : null,
    flags: combinedFlags,
    correction_count: Number(row.correction_count ?? 0),
    is_overdue: isOverdue,
  };
}

const TRIP_SUMMARY_SELECT = `
  SELECT
    t.id, t.trip_type, t.vehicle_id, t.driver_id, t.status, t.client_name, t.destination, t.reason,
    t.days_hired, t.expected_return_date, t.created_at,
    v.reg_number, v.make_model, v.vehicle_type, v.vehicle_class,
    d.full_name AS driver_name, d.phone AS driver_phone,
    tout.out_at, tout.mileage_out, tout.fuel_out, tout.flags AS out_flags,
    tin.in_at, tin.mileage_in, tin.fuel_in, tin.total_mileage, tin.est_fuel_litres, tin.gauge_fuel_litres, tin.flags AS in_flags,
    COALESCE((
      SELECT COUNT(*) FROM corrections c
      WHERE (c.target_table = 'trips' AND c.target_id = t.id)
         OR (c.target_table = 'trip_out' AND c.target_id = t.id)
         OR (c.target_table = 'trip_in' AND c.target_id = t.id)
    ), 0) AS correction_count
  FROM trips t
  JOIN vehicles v ON v.id = t.vehicle_id
  JOIN drivers d ON d.id = t.driver_id
  JOIN trip_out tout ON tout.trip_id = t.id
  LEFT JOIN trip_in tin ON tin.trip_id = t.id
`;

export function registerTripRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // ---------------- LIST TRIPS ----------------
  app.get('/trips', requireAuth, async (c) => {
    const status = (c.req.query('status') || '').trim();
    const tripType = (c.req.query('trip_type') || '').trim();
    const vehicleId = Number(c.req.query('vehicle_id') || 0);
    const driverId = Number(c.req.query('driver_id') || 0);
    const flaggedOnly = c.req.query('flagged') === '1';
    const fromDate = (c.req.query('from') || '').trim();
    const toDate = (c.req.query('to') || '').trim();
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const page = Math.max(1, Number(c.req.query('page') || 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (status === 'OPEN' || status === 'CLOSED') {
      clauses.push('t.status = ?');
      params.push(status);
    }
    if (tripType === 'HIRE' || tripType === 'ERRAND') {
      clauses.push('t.trip_type = ?');
      params.push(tripType);
    }
    if (vehicleId > 0) {
      clauses.push('t.vehicle_id = ?');
      params.push(vehicleId);
    }
    if (driverId > 0) {
      clauses.push('t.driver_id = ?');
      params.push(driverId);
    }
    if (fromDate) {
      clauses.push('tout.out_at >= ?');
      params.push(`${fromDate}T00:00:00.000Z`);
    }
    if (toDate) {
      clauses.push('tout.out_at <= ?');
      params.push(`${toDate}T23:59:59.999Z`);
    }
    if (q) {
      clauses.push(
        `(LOWER(v.reg_number) LIKE ? OR LOWER(v.make_model) LIKE ? OR LOWER(d.full_name) LIKE ? OR LOWER(COALESCE(t.client_name, '')) LIKE ? OR LOWER(COALESCE(t.destination, '')) LIKE ?)`
      );
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const settings = await loadSettings(c.env.DB);
    const overdueHours = Number(settings.overdue_hire_hours || 24);
    const nowMs = Date.now();

    const { results } = await c.env.DB.prepare(
      `${TRIP_SUMMARY_SELECT}
       ${whereSql}
       ORDER BY t.id DESC`
    )
      .bind(...params)
      .all<Record<string, unknown>>();

    const mapped = results.map((r) => mapTripSummaryRow(r, overdueHours, nowMs));
    const filtered = flaggedOnly ? mapped.filter((t) => t.flags.length > 0) : mapped;
    const paginated = filtered.slice(offset, offset + limit);

    return c.json({
      items: paginated,
      total: filtered.length,
      page,
      limit,
    });
  });

  // ---------------- TRIP DETAIL ----------------
  app.get('/trips/:id', requireAuth, requirePinChanged(), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid trip ID.' }, 400);
    }

    const settings = await loadSettings(c.env.DB);
    const overdueHours = Number(settings.overdue_hire_hours || 24);

    const summaryRow = await c.env.DB.prepare(`${TRIP_SUMMARY_SELECT} WHERE t.id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!summaryRow) {
      return c.json({ error: 'Trip record not found.' }, 404);
    }

    const outRow = await c.env.DB.prepare(
      `SELECT tout.*, u.full_name AS recorded_by_name
       FROM trip_out tout
       JOIN users u ON u.id = tout.recorded_by
       WHERE tout.trip_id = ?`
    )
      .bind(id)
      .first<Record<string, unknown>>();

    const inRow = await c.env.DB.prepare(
      `SELECT tin.*, u.full_name AS recorded_by_name
       FROM trip_in tin
       JOIN users u ON u.id = tin.recorded_by
       WHERE tin.trip_id = ?`
    )
      .bind(id)
      .first<Record<string, unknown>>();

    const { results: correctionRows } = await c.env.DB.prepare(
      `SELECT c.*, u.full_name AS corrected_by_name
       FROM corrections c
       JOIN users u ON u.id = c.corrected_by
       WHERE (c.target_table IN ('trips', 'trip_out', 'trip_in') AND c.target_id = ?)
       ORDER BY c.id DESC`
    )
      .bind(id)
      .all<Record<string, unknown>>();

    const corrections: TripCorrection[] = correctionRows.map((cr) => {
      let changes: Record<string, unknown> = {};
      try {
        changes = JSON.parse(String(cr.field_changes || '{}')) as Record<string, unknown>;
      } catch {
        changes = {};
      }
      return {
        id: Number(cr.id),
        target_table: cr.target_table as 'trips' | 'trip_out' | 'trip_in',
        target_id: Number(cr.target_id),
        field_changes: changes,
        reason: String(cr.reason),
        corrected_by: Number(cr.corrected_by),
        corrected_by_name: String(cr.corrected_by_name ?? ''),
        created_at: String(cr.created_at),
      };
    });

    return c.json({
      trip: mapTripSummaryRow(summaryRow, overdueHours, Date.now()),
      out: {
        trip_id: Number(outRow!.trip_id),
        out_at: String(outRow!.out_at),
        device_time: outRow!.device_time ? String(outRow!.device_time) : null,
        received_at: String(outRow!.received_at),
        mileage_out: Number(outRow!.mileage_out),
        fuel_out: outRow!.fuel_out as FuelLevel,
        opening_checklist_by: String(outRow!.opening_checklist_by),
        notes: String(outRow!.notes ?? ''),
        flags: parseFlags(outRow!.flags),
        recorded_by: Number(outRow!.recorded_by),
        recorded_by_name: String(outRow!.recorded_by_name ?? ''),
      },
      inRecord: inRow
        ? {
            trip_id: Number(inRow.trip_id),
            in_at: String(inRow.in_at),
            device_time: inRow.device_time ? String(inRow.device_time) : null,
            received_at: String(inRow.received_at),
            mileage_in: Number(inRow.mileage_in),
            fuel_in: inRow.fuel_in as FuelLevel,
            closing_checklist_by: String(inRow.closing_checklist_by),
            notes: String(inRow.notes ?? ''),
            recorded_by: Number(inRow.recorded_by),
            recorded_by_name: String(inRow.recorded_by_name ?? ''),
            total_mileage: Number(inRow.total_mileage),
            est_fuel_litres: Number(inRow.est_fuel_litres),
            gauge_fuel_litres: Number(inRow.gauge_fuel_litres),
            flags: parseFlags(inRow.flags),
          }
        : null,
      corrections,
    });
  });

  // ---------------- RECORD TRIP OUT (IMMUTABLE) ----------------
  app.post('/trips/out', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    let body: {
      trip_type?: TripType;
      vehicle_id?: number;
      driver_id?: number;
      new_vehicle?: Partial<NewVehicleInput>;
      new_driver?: Partial<NewDriverInput>;
      client_name?: string;
      destination?: string;
      reason?: string;
      days_hired?: number | string | null;
      expected_return_date?: string | null;
      mileage_out?: number;
      fuel_out?: FuelLevel;
      opening_checklist_by?: string;
      notes?: string;
      device_time?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request format.' }, 400);
    }

    const tripType = body.trip_type;
    const requestedVehicleId = body.vehicle_id !== undefined ? Number(body.vehicle_id) : 0;
    const requestedDriverId = body.driver_id !== undefined ? Number(body.driver_id) : 0;
    const clientName = (body.client_name || '').trim();
    const destination = (body.destination || '').trim();
    const reason = (body.reason || '').trim();
    const mileageOut = Number(body.mileage_out);
    const fuelOut = body.fuel_out;
    const checklistBy = (body.opening_checklist_by || '').trim();
    const notes = (body.notes || '').trim();
    const deviceTime = body.device_time ? String(body.device_time).trim() : null;

    let daysHired: number | null = null;
    let expectedReturnDate: string | null = null;

    if (tripType !== 'HIRE' && tripType !== 'ERRAND') {
      return c.json({ error: 'Choose either Hire or Errand.' }, 400);
    }
    if (tripType === 'HIRE') {
      if (!clientName) {
        return c.json({ error: 'Enter the client name for this hire.' }, 400);
      }
      if (
        body.days_hired !== undefined &&
        body.days_hired !== null &&
        String(body.days_hired).trim() !== ''
      ) {
        const parsedDays = Number(body.days_hired);
        if (!Number.isInteger(parsedDays) || parsedDays < 1) {
          return c.json({ error: 'Number of days hired must be a whole number of at least 1.' }, 400);
        }
        daysHired = parsedDays;
      }
      if (
        body.expected_return_date !== undefined &&
        body.expected_return_date !== null &&
        String(body.expected_return_date).trim() !== ''
      ) {
        const parsedDate = String(body.expected_return_date).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(parsedDate)) {
          return c.json({ error: 'Expected return date must be in YYYY-MM-DD format.' }, 400);
        }
        expectedReturnDate = parsedDate;
      }
    }
    if (tripType === 'ERRAND' && (!destination || !reason)) {
      return c.json({ error: 'Enter both the destination and the reason for this errand.' }, 400);
    }
    if (!Number.isInteger(mileageOut) || mileageOut < 0) {
      return c.json({ error: 'Mileage when leaving must be a whole number 0 or greater.' }, 400);
    }
    if (!fuelOut || !FUEL_LEVELS.includes(fuelOut)) {
      return c.json({ error: 'Tap a fuel gauge level for when the vehicle is leaving.' }, 400);
    }
    if (tripType === 'HIRE' && !checklistBy) {
      return c.json({ error: 'Enter the name of the person who did the opening checklist.' }, 400);
    }

    // Validate vehicle (either existing directory selection or new inline creation)
    let vehicle: Record<string, unknown> | null = null;
    let newVehicleSpec: {
      regNumber: string;
      vehicleType: string;
      vehicleClass: VehicleClass;
      makeModel: string;
      condition: VehicleCondition;
      mileage: number;
      saveToDirectory: boolean;
    } | null = null;

    if (body.new_vehicle) {
      const regNumber = (body.new_vehicle.reg_number || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' ');
      const vehicleType = (body.new_vehicle.vehicle_type || '').trim();
      const makeModel = (body.new_vehicle.make_model || '').trim();
      const condition = (body.new_vehicle.condition || 'Good') as VehicleCondition;
      const mileage =
        body.new_vehicle.last_known_mileage !== undefined
          ? Number(body.new_vehicle.last_known_mileage)
          : mileageOut;
      const saveToDirectory = Boolean(body.new_vehicle.save_to_directory);

      if (!regNumber || regNumber.length < 3) {
        return c.json({ error: 'Enter the new vehicle registration number (at least 3 characters).' }, 400);
      }
      const vehicleClass = VEHICLE_TYPE_TO_CLASS[vehicleType];
      if (!vehicleClass) {
        return c.json({ error: 'Choose a valid vehicle type for the new vehicle.' }, 400);
      }
      if (!makeModel || makeModel.length < 2) {
        return c.json({ error: 'Enter the new vehicle make and model (e.g. Toyota Hilux).' }, 400);
      }
      if (!VEHICLE_CONDITIONS.includes(condition)) {
        return c.json({ error: 'Choose a valid vehicle condition.' }, 400);
      }
      if (condition === 'Accident' || condition === 'Grounded') {
        return c.json(
          { error: `A new vehicle marked "${condition}" cannot be booked out on a trip.` },
          400
        );
      }
      if (!Number.isInteger(mileage) || mileage < 0) {
        return c.json({ error: 'Starting mileage must be a whole number 0 or greater.' }, 400);
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
                ? `Vehicle "${regNumber}" is already in the Vehicles Directory. Select it from the vehicle list instead.`
                : `Vehicle "${regNumber}" already exists in past records. Use a different registration or ask a Supervisor to re-enable it.`,
          },
          409
        );
      }

      newVehicleSpec = {
        regNumber,
        vehicleType,
        vehicleClass,
        makeModel,
        condition,
        mileage,
        saveToDirectory,
      };
    } else {
      if (!Number.isInteger(requestedVehicleId) || requestedVehicleId <= 0) {
        return c.json({ error: 'Select a vehicle or add a new vehicle.' }, 400);
      }
      vehicle = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(requestedVehicleId)
        .first<Record<string, unknown>>();
      if (!vehicle || Number(vehicle.active) !== 1) {
        return c.json({ error: 'The selected vehicle is inactive or does not exist.' }, 400);
      }
      if (vehicle.condition === 'Accident' || vehicle.condition === 'Grounded') {
        return c.json(
          {
            error: `${vehicle.reg_number} is marked "${vehicle.condition}" and cannot leave the yard. Ask a Supervisor to inspect and update its condition first.`,
          },
          400
        );
      }
      const openVehicleTrip = await c.env.DB.prepare(
        "SELECT id, trip_type FROM trips WHERE vehicle_id = ? AND status = 'OPEN'"
      )
        .bind(requestedVehicleId)
        .first<{ id: number; trip_type: string }>();
      if (openVehicleTrip) {
        return c.json(
          {
            error: `${vehicle.reg_number} is already out on a ${openVehicleTrip.trip_type.toLowerCase()}. Record its return before booking it out again.`,
          },
          409
        );
      }
    }

    // Validate driver (either existing directory selection or new inline creation)
    let driver: Record<string, unknown> | null = null;
    let newDriverSpec: {
      fullName: string;
      licenceNumber: string | null;
      licenceCode: string | null;
      phone: string;
      address: string;
      licenceExpiry: string | null;
      licenceDocument: string | null;
      ddcNumber: string | null;
      ddcDocument: string | null;
      retestCertNumber: string | null;
      retestDocument: string | null;
      medicalCertNumber: string | null;
      medicalDocument: string | null;
      saveToDirectory: boolean;
    } | null = null;

    if (body.new_driver) {
      const fullName = (body.new_driver.full_name || '').trim();
      const rawLicence = normalizeDriverLicenceNumber(body.new_driver.licence_number);
      const licenceNumber = rawLicence ? rawLicence.toUpperCase() : null;
      const licCodeCheck = validateDriverLicenceCode(body.new_driver.licence_code);
      if (!licCodeCheck.ok) return c.json({ error: licCodeCheck.error }, 400);
      const licenceCode = licCodeCheck.value;
      const phone = (body.new_driver.phone || '').trim();
      const address = (body.new_driver.address || '').trim();
      const licenceExpiry = body.new_driver.licence_expiry
        ? String(body.new_driver.licence_expiry).trim()
        : null;
      const ddcNumber = body.new_driver.ddc_number
        ? String(body.new_driver.ddc_number).trim().toUpperCase() || null
        : null;
      const retestCertNumber = body.new_driver.retest_cert_number
        ? String(body.new_driver.retest_cert_number).trim().toUpperCase() || null
        : null;
      const medicalCertNumber = body.new_driver.medical_cert_number
        ? String(body.new_driver.medical_cert_number).trim().toUpperCase() || null
        : null;
      const saveToDirectory = Boolean(body.new_driver.save_to_directory);

      if (!fullName || fullName.length < 2) {
        return c.json({ error: 'Enter the new driver’s full name (at least 2 characters).' }, 400);
      }
      if (licenceNumber && licenceNumber.length < 2) {
        return c.json({ error: 'Licence number must be at least 2 characters when provided.' }, 400);
      }
      if (!phone || phone.length < 5) {
        return c.json({ error: 'Enter a contact phone number for the new driver.' }, 400);
      }
      if (licenceExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(licenceExpiry)) {
        return c.json({ error: 'Licence expiry date must be in YYYY-MM-DD format.' }, 400);
      }

      const licDoc = validateDocumentDataUrl(body.new_driver.licence_document, "Driver's Licence document");
      if (!licDoc.ok) return c.json({ error: licDoc.error }, 400);
      const ddcDoc = validateDocumentDataUrl(body.new_driver.ddc_document, 'Defensive Driving Certificate');
      if (!ddcDoc.ok) return c.json({ error: ddcDoc.error }, 400);
      const retestDoc = validateDocumentDataUrl(body.new_driver.retest_document, 'Retest Certificate');
      if (!retestDoc.ok) return c.json({ error: retestDoc.error }, 400);
      const medDoc = validateDocumentDataUrl(body.new_driver.medical_document, 'Medical Certificate');
      if (!medDoc.ok) return c.json({ error: medDoc.error }, 400);

      if (licenceNumber) {
        const existingDriver = await c.env.DB.prepare(
          `SELECT id, active FROM drivers WHERE UPPER(licence_number) = ? AND licence_number NOT LIKE '${UNRECORDED_LICENCE_PREFIX}%'`
        )
          .bind(licenceNumber)
          .first<{ id: number; active: number }>();
        if (existingDriver) {
          return c.json(
            {
              error:
                existingDriver.active === 1
                  ? `A driver with licence "${licenceNumber}" is already in the Drivers Directory. Select them from the driver list instead.`
                  : `A driver with licence "${licenceNumber}" already exists in past records. Use a different licence number or ask a Supervisor to re-enable them.`,
            },
            409
          );
        }
      }

      newDriverSpec = {
        fullName,
        licenceNumber,
        licenceCode,
        phone,
        address,
        licenceExpiry,
        licenceDocument: licDoc.value,
        ddcNumber,
        ddcDocument: ddcDoc.value,
        retestCertNumber,
        retestDocument: retestDoc.value,
        medicalCertNumber,
        medicalDocument: medDoc.value,
        saveToDirectory,
      };
    } else {
      if (!Number.isInteger(requestedDriverId) || requestedDriverId <= 0) {
        return c.json({ error: 'Select a driver or add a new driver.' }, 400);
      }
      driver = await c.env.DB.prepare('SELECT * FROM drivers WHERE id = ?')
        .bind(requestedDriverId)
        .first<Record<string, unknown>>();
      if (!driver || Number(driver.active) !== 1) {
        return c.json({ error: 'The selected driver is inactive or does not exist.' }, 400);
      }
      const openDriverTrip = await c.env.DB.prepare(
        "SELECT id, trip_type FROM trips WHERE driver_id = ? AND status = 'OPEN'"
      )
        .bind(requestedDriverId)
        .first<{ id: number; trip_type: string }>();
      if (openDriverTrip) {
        return c.json(
          {
            error: `${driver.full_name} is already out on another trip (#${openDriverTrip.id}).`,
          },
          409
        );
      }
    }

    // All validation passed; insert inline vehicle / driver records if requested
    let vehicleId = requestedVehicleId;
    if (newVehicleSpec) {
      const vInsert = await c.env.DB.prepare(
        `INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          newVehicleSpec.regNumber,
          newVehicleSpec.vehicleType,
          newVehicleSpec.vehicleClass,
          newVehicleSpec.makeModel,
          newVehicleSpec.condition,
          newVehicleSpec.mileage,
          newVehicleSpec.saveToDirectory ? 1 : 0
        )
        .run();
      vehicleId = Number(vInsert.meta.last_row_id);
      vehicle = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(vehicleId)
        .first<Record<string, unknown>>();

      const vAction = newVehicleSpec.saveToDirectory ? 'VEHICLE_CREATED' : 'VEHICLE_ONE_TIME_TRIP';
      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: vAction,
        entity: 'vehicles',
        entityId: vehicleId,
        newValue: {
          reg_number: newVehicleSpec.regNumber,
          vehicle_type: newVehicleSpec.vehicleType,
          vehicle_class: newVehicleSpec.vehicleClass,
          make_model: newVehicleSpec.makeModel,
          condition: newVehicleSpec.condition,
          last_known_mileage: newVehicleSpec.mileage,
          saved_to_directory: newVehicleSpec.saveToDirectory,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: vAction,
          priority: 'NORMAL',
          title: newVehicleSpec.saveToDirectory
            ? `Vehicle added during trip: ${newVehicleSpec.regNumber}`
            : `One-time vehicle used: ${newVehicleSpec.regNumber}`,
          body: `${actor.full_name} added ${newVehicleSpec.makeModel} (${newVehicleSpec.regNumber}) while booking a trip (${
            newVehicleSpec.saveToDirectory ? 'saved to directory' : 'one-time trip only'
          }).`,
        },
        { env: c.env }
      );
    }

    let driverId = requestedDriverId;
    if (newDriverSpec) {
      const insertInlineDriver = async (licVal: string | null) =>
        c.env.DB.prepare(
          `INSERT INTO drivers (
             full_name, licence_number, licence_code, phone, address, licence_expiry,
             licence_document, ddc_number, ddc_document,
             retest_cert_number, retest_document,
             medical_cert_number, medical_document,
             active, created_by
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            newDriverSpec.fullName,
            licVal,
            newDriverSpec.licenceCode,
            newDriverSpec.phone,
            newDriverSpec.address,
            newDriverSpec.licenceExpiry,
            newDriverSpec.licenceDocument,
            newDriverSpec.ddcNumber,
            newDriverSpec.ddcDocument,
            newDriverSpec.retestCertNumber,
            newDriverSpec.retestDocument,
            newDriverSpec.medicalCertNumber,
            newDriverSpec.medicalDocument,
            newDriverSpec.saveToDirectory ? 1 : 0,
            actor.id
          )
          .run();

      let dInsert;
      try {
        dInsert = await insertInlineDriver(newDriverSpec.licenceNumber);
      } catch (err) {
        if (newDriverSpec.licenceNumber === null && isNotNullLicenceError(err)) {
          dInsert = await insertInlineDriver(makeUnrecordedLicenceSentinel());
        } else {
          throw err;
        }
      }
      driverId = Number(dInsert.meta.last_row_id);
      driver = await c.env.DB.prepare('SELECT * FROM drivers WHERE id = ?')
        .bind(driverId)
        .first<Record<string, unknown>>();

      const dAction = newDriverSpec.saveToDirectory ? 'DRIVER_CREATED' : 'DRIVER_ONE_TIME_TRIP';
      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: dAction,
        entity: 'drivers',
        entityId: driverId,
        newValue: {
          full_name: newDriverSpec.fullName,
          licence_number: newDriverSpec.licenceNumber,
          licence_code: newDriverSpec.licenceCode,
          phone: newDriverSpec.phone,
          address: newDriverSpec.address,
          licence_expiry: newDriverSpec.licenceExpiry,
          ddc_number: newDriverSpec.ddcNumber,
          retest_cert_number: newDriverSpec.retestCertNumber,
          medical_cert_number: newDriverSpec.medicalCertNumber,
          saved_to_directory: newDriverSpec.saveToDirectory,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: dAction,
          priority: 'NORMAL',
          title: newDriverSpec.saveToDirectory
            ? `Driver added during trip: ${newDriverSpec.fullName}`
            : `One-time driver used: ${newDriverSpec.fullName}`,
          body: `${actor.full_name} added driver ${newDriverSpec.fullName} (${
            newDriverSpec.licenceNumber ?? 'No licence recorded'
          }) while booking a trip (${
            newDriverSpec.saveToDirectory ? 'saved to directory' : 'one-time trip only'
          }).`,
        },
        { env: c.env }
      );
    }

    // Server-side timestamps (cannot be back-dated by user)
    const nowIso = new Date().toISOString();
    const outFlags: TripFlag[] = [];
    const lastKnownMileage = Number(vehicle!.last_known_mileage ?? 0);

    if (mileageOut !== lastKnownMileage) {
      const diff = mileageOut - lastKnownMileage;
      outFlags.push({
        code: 'UNRECORDED_GAP',
        severity: 'HIGH',
        message:
          diff > 0
            ? `Unrecorded mileage gap of +${diff.toLocaleString()} km since last recorded odometer (${lastKnownMileage.toLocaleString()} km vs ${mileageOut.toLocaleString()} km).`
            : `Odometer when leaving (${mileageOut.toLocaleString()} km) is lower than last recorded mileage (${lastKnownMileage.toLocaleString()} km) by ${Math.abs(diff).toLocaleString()} km.`,
        meta: { last_known_mileage: lastKnownMileage, mileage_out: mileageOut, diff_km: diff },
      });
    }

    if (deviceTime) {
      const devMs = new Date(deviceTime).getTime();
      const srvMs = new Date(nowIso).getTime();
      if (!Number.isNaN(devMs) && Math.abs(srvMs - devMs) > 10 * 60_000) {
        const mins = Math.round(Math.abs(srvMs - devMs) / 60_000);
        outFlags.push({
          code: 'OFFLINE_DELAY',
          severity: 'WARN',
          message: `Recorded offline and synced ${mins} minutes after capture.`,
          meta: { device_time: deviceTime, received_at: nowIso, delay_minutes: mins },
        });
      }
    }

    const licCheck = computeLicenceExpiryStatus(
      driver!.licence_expiry ? String(driver!.licence_expiry) : null
    );
    if (licCheck.licence_status === 'EXPIRED' || licCheck.licence_status === 'EXPIRING_SOON') {
      outFlags.push({
        code: 'LICENCE_EXPIRING',
        severity: licCheck.licence_status === 'EXPIRED' ? 'HIGH' : 'WARN',
        message:
          licCheck.licence_status === 'EXPIRED'
            ? `Driver licence expired on ${driver!.licence_expiry}.`
            : `Driver licence expires in ${licCheck.days_to_expiry} day(s) on ${driver!.licence_expiry}.`,
      });
    }

    const tripRes = await c.env.DB.prepare(
      `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name, destination, reason, days_hired, expected_return_date)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`
    )
      .bind(
        tripType,
        vehicleId,
        driverId,
        tripType === 'HIRE' ? clientName : null,
        tripType === 'ERRAND' ? destination : null,
        tripType === 'ERRAND' ? reason : null,
        tripType === 'HIRE' ? daysHired : null,
        tripType === 'HIRE' ? expectedReturnDate : null
      )
      .run();

    const tripId = tripRes.meta.last_row_id;

    await c.env.DB.prepare(
      `INSERT INTO trip_out (trip_id, out_at, device_time, received_at, mileage_out, fuel_out, opening_checklist_by, notes, flags, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        tripId,
        nowIso,
        deviceTime,
        nowIso,
        mileageOut,
        fuelOut,
        checklistBy,
        notes,
        JSON.stringify(outFlags),
        actor.id
      )
      .run();

    const settings = await loadSettings(c.env.DB);
    const createdRow = await c.env.DB.prepare(`${TRIP_SUMMARY_SELECT} WHERE t.id = ?`)
      .bind(tripId)
      .first<Record<string, unknown>>();
    const summary = mapTripSummaryRow(
      createdRow!,
      Number(settings.overdue_hire_hours || 24),
      Date.now()
    );

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: tripType === 'HIRE' ? 'TRIP_OUT_HIRE' : 'TRIP_OUT_ERRAND',
      entity: 'trips',
      entityId: tripId,
      newValue: {
        trip_type: tripType,
        vehicle: summary.reg_number,
        driver: summary.driver_name,
        client_name: summary.client_name,
        destination: summary.destination,
        reason: summary.reason,
        days_hired: summary.days_hired,
        expected_return_date: summary.expected_return_date,
        mileage_out: mileageOut,
        fuel_out: fuelOut,
        flags: outFlags,
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    const hireDurationNote =
      tripType === 'HIRE' && (daysHired || expectedReturnDate)
        ? ` (${[
            daysHired ? `${daysHired} day${daysHired === 1 ? '' : 's'}` : null,
            expectedReturnDate ? `return due ${expectedReturnDate}` : null,
          ]
            .filter(Boolean)
            .join(', ')})`
        : '';

    const hasHighFlag = outFlags.some((f) => f.severity === 'HIGH');
    await notifyManagersInApp(
      c.env.DB,
      {
        eventType: tripType === 'HIRE' ? 'TRIP_OUT_HIRE' : 'TRIP_OUT_ERRAND',
        priority: hasHighFlag ? 'HIGH' : 'NORMAL',
        title: `${tripType === 'HIRE' ? 'Hire Out' : 'Errand Out'}: ${summary.reg_number}${
          outFlags.length > 0 ? ' (FLAGGED)' : ''
        }`,
        body: `${summary.driver_name} took ${summary.reg_number} (${summary.make_model}) at ${mileageOut.toLocaleString()} km, fuel ${fuelOut}${hireDurationNote}.${
          outFlags.length > 0 ? ` Flags: ${outFlags.map((f) => f.code).join(', ')}.` : ''
        }`,
        tripId,
      },
      { env: c.env }
    );

    if (
      tripType === 'HIRE' &&
      expectedReturnDate &&
      expectedReturnDate <= toHarareDateStr(new Date())
    ) {
      await checkAndNotifyOverdueHires(c.env.DB, { env: c.env });
    }

    return c.json({ trip: summary, flags: outFlags }, 201);
  });

  // ---------------- RECORD TRIP IN / RETURN (IMMUTABLE) ----------------
  app.post('/trips/:id/in', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    const tripId = Number(c.req.param('id'));
    if (!Number.isInteger(tripId) || tripId <= 0) {
      return c.json({ error: 'Invalid trip ID.' }, 400);
    }

    let body: {
      mileage_in?: number;
      fuel_in?: FuelLevel;
      closing_checklist_by?: string;
      notes?: string;
      device_time?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request format.' }, 400);
    }

    const mileageIn = Number(body.mileage_in);
    const fuelIn = body.fuel_in;
    const checklistBy = (body.closing_checklist_by || '').trim();
    const notes = (body.notes || '').trim();
    const deviceTime = body.device_time ? String(body.device_time).trim() : null;

    const existing = await c.env.DB.prepare(
      `SELECT t.*, v.vehicle_class, v.reg_number, v.make_model, d.full_name AS driver_name,
              tout.mileage_out, tout.fuel_out, tout.out_at
       FROM trips t
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN drivers d ON d.id = t.driver_id
       JOIN trip_out tout ON tout.trip_id = t.id
       WHERE t.id = ?`
    )
      .bind(tripId)
      .first<Record<string, unknown>>();

    if (!existing) {
      return c.json({ error: 'Trip record not found.' }, 404);
    }
    if (existing.status !== 'OPEN') {
      return c.json({ error: 'This trip has already been closed and cannot be saved again.' }, 409);
    }

    const mileageOut = Number(existing.mileage_out);
    if (!Number.isInteger(mileageIn) || mileageIn < 0) {
      return c.json({ error: 'Mileage when returning must be a whole number.' }, 400);
    }
    if (mileageIn < mileageOut) {
      return c.json(
        {
          error: `Mileage when returning (${mileageIn.toLocaleString()} km) cannot be less than mileage when leaving (${mileageOut.toLocaleString()} km).`,
        },
        400
      );
    }
    if (!fuelIn || !FUEL_LEVELS.includes(fuelIn)) {
      return c.json({ error: 'Tap a fuel gauge level for when the vehicle returned.' }, 400);
    }
    if (!checklistBy) {
      return c.json({ error: 'Enter the name of the person who did the closing checklist.' }, 400);
    }

    const settings = await loadSettings(c.env.DB);
    const calc = calculateTripFuelAndMileage({
      mileageOut,
      mileageIn,
      fuelOut: existing.fuel_out as FuelLevel,
      fuelIn,
      vehicleClass: existing.vehicle_class as VehicleClass,
      settings,
    });

    const nowIso = new Date().toISOString();
    const inFlags: TripFlag[] = [];

    if (calc.fuel_mismatch) {
      inFlags.push({
        code: 'FUEL_MISMATCH',
        severity: 'HIGH',
        message: `Fuel mismatch: distance (${calc.total_mileage.toLocaleString()} km) estimates ${calc.est_fuel_litres} L used, but gauge change shows ${calc.gauge_fuel_litres} L (limit ±${calc.threshold_litres} L).`,
        meta: {
          est_fuel_litres: calc.est_fuel_litres,
          gauge_fuel_litres: calc.gauge_fuel_litres,
          threshold_litres: calc.threshold_litres,
        },
      });
    }

    if (deviceTime) {
      const devMs = new Date(deviceTime).getTime();
      const srvMs = new Date(nowIso).getTime();
      if (!Number.isNaN(devMs) && Math.abs(srvMs - devMs) > 10 * 60_000) {
        const mins = Math.round(Math.abs(srvMs - devMs) / 60_000);
        inFlags.push({
          code: 'OFFLINE_DELAY',
          severity: 'WARN',
          message: `Return recorded offline and synced ${mins} minutes after capture.`,
          meta: { device_time: deviceTime, received_at: nowIso, delay_minutes: mins },
        });
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO trip_in
       (trip_id, in_at, device_time, received_at, mileage_in, fuel_in, closing_checklist_by, notes, recorded_by, total_mileage, est_fuel_litres, gauge_fuel_litres, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        tripId,
        nowIso,
        deviceTime,
        nowIso,
        mileageIn,
        fuelIn,
        checklistBy,
        notes,
        actor.id,
        calc.total_mileage,
        calc.est_fuel_litres,
        calc.gauge_fuel_litres,
        JSON.stringify(inFlags)
      )
      .run();

    await c.env.DB.prepare("UPDATE trips SET status = 'CLOSED' WHERE id = ?").bind(tripId).run();
    await c.env.DB.prepare('UPDATE vehicles SET last_known_mileage = ? WHERE id = ?')
      .bind(mileageIn, existing.vehicle_id)
      .run();

    const closedRow = await c.env.DB.prepare(`${TRIP_SUMMARY_SELECT} WHERE t.id = ?`)
      .bind(tripId)
      .first<Record<string, unknown>>();
    const summary = mapTripSummaryRow(
      closedRow!,
      Number(settings.overdue_hire_hours || 24),
      Date.now()
    );

    const tripType = existing.trip_type as TripType;
    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: tripType === 'HIRE' ? 'TRIP_IN_HIRE' : 'TRIP_IN_ERRAND',
      entity: 'trips',
      entityId: tripId,
      newValue: {
        vehicle: summary.reg_number,
        driver: summary.driver_name,
        mileage_in: mileageIn,
        fuel_in: fuelIn,
        total_mileage: calc.total_mileage,
        est_fuel_litres: calc.est_fuel_litres,
        gauge_fuel_litres: calc.gauge_fuel_litres,
        flags: inFlags,
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    const hasHighFlag = inFlags.some((f) => f.severity === 'HIGH');
    await notifyManagersInApp(
      c.env.DB,
      {
        eventType: tripType === 'HIRE' ? 'TRIP_IN_HIRE' : 'TRIP_IN_ERRAND',
        priority: hasHighFlag ? 'HIGH' : 'NORMAL',
        title: `${tripType === 'HIRE' ? 'Hire Returned' : 'Errand Returned'}: ${summary.reg_number}${
          inFlags.length > 0 ? ' (FLAGGED)' : ''
        }`,
        body: `${summary.driver_name} returned ${summary.reg_number} (+${calc.total_mileage.toLocaleString()} km, est. ${calc.est_fuel_litres} L vs gauge ${calc.gauge_fuel_litres} L).`,
        tripId,
      },
      { env: c.env }
    );

    await checkAndNotifyVehicleServiceDues(c.env.DB, { env: c.env });

    return c.json({ trip: summary, flags: summary.flags });
  });

  // ---------------- APPEND CORRECTION ENTRY (SUPERVISOR / ADMIN ONLY) ----------------
  app.post(
    '/trips/:id/corrections',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const tripId = Number(c.req.param('id'));
      if (!Number.isInteger(tripId) || tripId <= 0) {
        return c.json({ error: 'Invalid trip ID.' }, 400);
      }

      const tripRow = await c.env.DB.prepare('SELECT id, status FROM trips WHERE id = ?')
        .bind(tripId)
        .first<{ id: number; status: string }>();
      if (!tripRow) {
        return c.json({ error: 'Trip record not found.' }, 404);
      }

      let body: {
        target_table?: 'trips' | 'trip_out' | 'trip_in';
        field_changes?: Record<string, unknown>;
        reason?: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const targetTable = body.target_table;
      const fieldChanges = body.field_changes;
      const reason = (body.reason || '').trim();

      if (targetTable !== 'trips' && targetTable !== 'trip_out' && targetTable !== 'trip_in') {
        return c.json({ error: 'Select which part of the trip is being corrected.' }, 400);
      }
      if (targetTable === 'trip_in' && tripRow.status === 'OPEN') {
        return c.json({ error: 'Cannot add a return correction before the vehicle has returned.' }, 400);
      }
      if (!fieldChanges || typeof fieldChanges !== 'object' || Object.keys(fieldChanges).length === 0) {
        return c.json({ error: 'Provide at least one corrected value.' }, 400);
      }
      if (!reason || reason.length < 5) {
        return c.json({ error: 'Enter a clear reason for this correction (at least 5 characters).' }, 400);
      }

      const res = await c.env.DB.prepare(
        `INSERT INTO corrections (target_table, target_id, field_changes, reason, corrected_by)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(targetTable, tripId, JSON.stringify(fieldChanges), reason, actor.id)
        .run();

      const corrId = res.meta.last_row_id;
      const row = await c.env.DB.prepare(
        `SELECT c.*, u.full_name AS corrected_by_name
         FROM corrections c
         JOIN users u ON u.id = c.corrected_by
         WHERE c.id = ?`
      )
        .bind(corrId)
        .first<Record<string, unknown>>();

      const correction: TripCorrection = {
        id: Number(row!.id),
        target_table: row!.target_table as 'trips' | 'trip_out' | 'trip_in',
        target_id: Number(row!.target_id),
        field_changes: fieldChanges,
        reason: String(row!.reason),
        corrected_by: Number(row!.corrected_by),
        corrected_by_name: String(row!.corrected_by_name ?? ''),
        created_at: String(row!.created_at),
      };

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'TRIP_CORRECTION_ADDED',
        entity: 'corrections',
        entityId: corrId,
        newValue: {
          trip_id: tripId,
          target_table: targetTable,
          field_changes: fieldChanges,
          reason,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      await notifyManagersInApp(
        c.env.DB,
        {
          eventType: 'TRIP_CORRECTION_ADDED',
          priority: 'NORMAL',
          title: `Correction added to Trip #${tripId}`,
          body: `${actor.full_name} added a correction on ${targetTable}: "${reason}".`,
          tripId,
        },
        { env: c.env }
      );

      return c.json({ correction }, 201);
    }
  );
}
