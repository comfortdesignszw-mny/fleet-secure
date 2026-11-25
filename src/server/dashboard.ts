import type { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  type DashboardDailyTrip,
  type DashboardData,
  type DashboardVehicleStat,
  type FuelLevel,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
  type VehicleClass,
} from '../shared/types';
import type { RouteAuthDeps } from './directories';
import { checkAndNotifyOverdueHires } from './notifications';
import type { AppEnv, D1DatabaseLike } from './types';

function toHarareDateStr(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function getOverdueHours(db: D1DatabaseLike): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = 'overdue_hire_hours'")
    .first<{ value: string }>();
  return Number(row?.value ?? DEFAULT_SETTINGS.overdue_hire_hours);
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

export function registerDashboardRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged } = deps;

  // Read-only dashboard visible to EVERY logged-in user (Driver, Supervisor, Admin)
  app.get('/dashboard', requireAuth, async (c) => {
    const now = new Date();
    const todayStr = toHarareDateStr(now);
    const monthStartStr = `${todayStr.slice(0, 7)}-01`;

    const fromParam = (c.req.query('from') || '').trim();
    const toParam = (c.req.query('to') || '').trim();
    const rangeFrom = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : monthStartStr;
    const rangeTo = /^\d{4}-\d{2}-\d{2}$/.test(toParam) ? toParam : todayStr;

    await checkAndNotifyOverdueHires(c.env.DB, { env: c.env });

    const overdueHours = await getOverdueHours(c.env.DB);
    const nowMs = now.getTime();

    // 1. Fleet & Driver counts
    const { results: vehiclesRows } = await c.env.DB.prepare(
      `SELECT v.id, v.reg_number, v.make_model, v.vehicle_type, v.vehicle_class, v.condition, v.active,
              ot.id AS open_trip_id, ot.trip_type AS open_trip_type
       FROM vehicles v
       LEFT JOIN trips ot ON ot.vehicle_id = v.id AND ot.status = 'OPEN'
       WHERE v.active = 1`
    ).all<Record<string, unknown>>();

    let outOnHire = 0;
    let outOnErrand = 0;
    let availableVehicles = 0;

    for (const v of vehiclesRows) {
      if (v.open_trip_type === 'HIRE') {
        outOnHire++;
      } else if (v.open_trip_type === 'ERRAND') {
        outOnErrand++;
      } else if (v.condition !== 'Accident' && v.condition !== 'Grounded') {
        availableVehicles++;
      }
    }

    const driverCountRow = await c.env.DB.prepare(
      'SELECT COUNT(*) as total FROM drivers WHERE active = 1'
    ).first<{ total: number }>();

    // 2. All trips (for accurate Harare date grouping, monthly totals, flags, overdue, and per-vehicle stats)
    const { results: tripRows } = await c.env.DB.prepare(
      `SELECT
         t.id, t.trip_type, t.vehicle_id, t.driver_id, t.status, t.client_name, t.destination, t.reason,
         t.days_hired, t.expected_return_date, t.created_at,
         v.reg_number, v.make_model, v.vehicle_type, v.vehicle_class,
         d.full_name AS driver_name, d.phone AS driver_phone,
         tout.out_at, tout.mileage_out, tout.fuel_out, tout.flags AS out_flags,
         tin.in_at, tin.mileage_in, tin.fuel_in, tin.total_mileage, tin.est_fuel_litres, tin.gauge_fuel_litres, tin.flags AS in_flags
       FROM trips t
       JOIN vehicles v ON v.id = t.vehicle_id
       JOIN drivers d ON d.id = t.driver_id
       JOIN trip_out tout ON tout.trip_id = t.id
       LEFT JOIN trip_in tin ON tin.trip_id = t.id
       ORDER BY tout.out_at ASC`
    ).all<Record<string, unknown>>();

    let tripsToday = 0;
    let mileageThisMonth = 0;
    let estFuelThisMonth = 0;
    let flaggedTripsTotal = 0;
    let overdueHires = 0;

    const longestVehiclesOut: TripSummary[] = [];
    const vehicleStatsMap = new Map<number, DashboardVehicleStat>();

    // Initialize map for all active vehicles so even 0-trip vehicles show up in table
    for (const v of vehiclesRows) {
      vehicleStatsMap.set(Number(v.id), {
        vehicle_id: Number(v.id),
        reg_number: String(v.reg_number),
        make_model: String(v.make_model),
        vehicle_type: String(v.vehicle_type),
        vehicle_class: v.vehicle_class as VehicleClass,
        trip_count: 0,
        total_mileage: 0,
        est_fuel_litres: 0,
        gauge_fuel_litres: 0,
        flagged_trips: 0,
      });
    }

    const dailyMap = new Map<string, { hire: number; errand: number }>();

    for (const r of tripRows) {
      const outAt = String(r.out_at);
      const outDateHarare = toHarareDateStr(new Date(outAt));
      const inAt = r.in_at ? String(r.in_at) : null;
      const inDateHarare = inAt ? toHarareDateStr(new Date(inAt)) : null;

      const outFlags = parseFlags(r.out_flags);
      const inFlags = parseFlags(r.in_flags);
      const combinedFlags = [...outFlags, ...inFlags];

      const status = r.status as 'OPEN' | 'CLOSED';
      const tripType = r.trip_type as TripType;
      const expectedReturnDate = r.expected_return_date ? String(r.expected_return_date) : null;
      const isReturnDue =
        status === 'OPEN' &&
        tripType === 'HIRE' &&
        Boolean(expectedReturnDate) &&
        expectedReturnDate! <= todayStr;
      const isReturnOverdue =
        status === 'OPEN' &&
        tripType === 'HIRE' &&
        Boolean(expectedReturnDate) &&
        expectedReturnDate! < todayStr;
      const elapsedHours = (nowMs - new Date(outAt).getTime()) / 3_600_000;
      const elapsedOverdue = status === 'OPEN' && tripType === 'HIRE' && elapsedHours > overdueHours;
      const isOverdue = elapsedOverdue || isReturnOverdue;

      if (isOverdue) {
        overdueHires++;
        if (elapsedOverdue) {
          combinedFlags.push({
            code: 'OVERDUE',
            severity: 'HIGH',
            message: `Hire out for ${Math.floor(elapsedHours)}h (limit ${overdueHours}h).`,
          });
        } else if (isReturnOverdue) {
          combinedFlags.push({
            code: 'OVERDUE',
            severity: 'HIGH',
            message: `Return date was ${expectedReturnDate} and hire is still open.`,
          });
        }
      }

      if (combinedFlags.length > 0) {
        flaggedTripsTotal++;
      }

      if (outDateHarare === todayStr) {
        tripsToday++;
      }

      // Monthly totals (closed trips in current Harare month)
      if (status === 'CLOSED' && (inDateHarare ?? outDateHarare).startsWith(todayStr.slice(0, 7))) {
        mileageThisMonth += Number(r.total_mileage ?? 0);
        estFuelThisMonth += Number(r.est_fuel_litres ?? 0);
      }

      if (status === 'OPEN') {
        const daysHired =
          r.days_hired !== null && r.days_hired !== undefined ? Number(r.days_hired) : null;

        longestVehiclesOut.push({
          id: Number(r.id),
          trip_type: tripType,
          vehicle_id: Number(r.vehicle_id),
          driver_id: Number(r.driver_id),
          status,
          client_name: r.client_name ? String(r.client_name) : null,
          destination: r.destination ? String(r.destination) : null,
          reason: r.reason ? String(r.reason) : null,
          days_hired: daysHired,
          expected_return_date: expectedReturnDate,
          is_return_due: isReturnDue,
          is_return_overdue: isReturnOverdue,
          created_at: String(r.created_at),
          reg_number: String(r.reg_number),
          make_model: String(r.make_model),
          vehicle_type: String(r.vehicle_type),
          vehicle_class: r.vehicle_class as VehicleClass,
          driver_name: String(r.driver_name),
          driver_phone: String(r.driver_phone),
          out_at: outAt,
          mileage_out: Number(r.mileage_out),
          fuel_out: r.fuel_out as FuelLevel,
          in_at: null,
          mileage_in: null,
          fuel_in: null,
          total_mileage: null,
          est_fuel_litres: null,
          gauge_fuel_litres: null,
          flags: combinedFlags,
          correction_count: 0,
          is_overdue: isOverdue,
        });
      }

      // Range-filtered aggregations (per-vehicle table & daily chart)
      if (outDateHarare >= rangeFrom && outDateHarare <= rangeTo) {
        const vid = Number(r.vehicle_id);
        let stat = vehicleStatsMap.get(vid);
        if (!stat) {
          stat = {
            vehicle_id: vid,
            reg_number: String(r.reg_number),
            make_model: String(r.make_model),
            vehicle_type: String(r.vehicle_type),
            vehicle_class: r.vehicle_class as VehicleClass,
            trip_count: 0,
            total_mileage: 0,
            est_fuel_litres: 0,
            gauge_fuel_litres: 0,
            flagged_trips: 0,
          };
          vehicleStatsMap.set(vid, stat);
        }
        stat.trip_count += 1;
        if (status === 'CLOSED') {
          stat.total_mileage += Number(r.total_mileage ?? 0);
          stat.est_fuel_litres = Number(
            (stat.est_fuel_litres + Number(r.est_fuel_litres ?? 0)).toFixed(1)
          );
          stat.gauge_fuel_litres = Number(
            (stat.gauge_fuel_litres + Number(r.gauge_fuel_litres ?? 0)).toFixed(1)
          );
        }
        if (combinedFlags.length > 0) {
          stat.flagged_trips += 1;
        }

        const dayBucket = dailyMap.get(outDateHarare) ?? { hire: 0, errand: 0 };
        if (tripType === 'HIRE') dayBucket.hire += 1;
        else dayBucket.errand += 1;
        dailyMap.set(outDateHarare, dayBucket);
      }
    }

    const vehicleStats = Array.from(vehicleStatsMap.values()).sort((a, b) =>
      a.reg_number.localeCompare(b.reg_number)
    );

    const topMileageVehicles = [...vehicleStats]
      .filter((v) => v.total_mileage > 0)
      .sort((a, b) => b.total_mileage - a.total_mileage)
      .slice(0, 5);

    // Build contiguous daily series across the selected range (capped to last 31 days if huge)
    const dailyTrips: DashboardDailyTrip[] = [];
    const endDt = new Date(`${rangeTo}T00:00:00Z`);
    const startDt = new Date(`${rangeFrom}T00:00:00Z`);
    const diffDays = Math.round((endDt.getTime() - startDt.getTime()) / 86_400_000);
    const effectiveStart =
      diffDays > 30 ? new Date(endDt.getTime() - 30 * 86_400_000) : startDt;

    for (
      let cursor = new Date(effectiveStart.getTime());
      cursor <= endDt;
      cursor = new Date(cursor.getTime() + 86_400_000)
    ) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const counts = dailyMap.get(dateStr) ?? { hire: 0, errand: 0 };
      dailyTrips.push({
        date: dateStr,
        hire_count: counts.hire,
        errand_count: counts.errand,
        total: counts.hire + counts.errand,
      });
    }

    const payload: DashboardData = {
      range: { from: rangeFrom, to: rangeTo },
      cards: {
        out_on_hire: outOnHire,
        out_on_errand: outOnErrand,
        available_vehicles: availableVehicles,
        total_fleet: vehiclesRows.length,
        total_drivers: driverCountRow?.total ?? 0,
        trips_today: tripsToday,
        mileage_this_month: mileageThisMonth,
        est_fuel_this_month: Number(estFuelThisMonth.toFixed(1)),
        flagged_trips: flaggedTripsTotal,
        overdue_hires: overdueHires,
      },
      vehicle_stats: vehicleStats,
      top_mileage_vehicles: topMileageVehicles,
      longest_vehicles_out: longestVehiclesOut.slice(0, 10), // already ordered oldest out_at first
      daily_trips: dailyTrips,
    };

    return c.json(payload);
  });
}
