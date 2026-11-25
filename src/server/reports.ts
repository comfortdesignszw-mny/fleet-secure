import type { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  formatHarareTime,
  normalizeDriverLicenceNumber,
  type AppSettings,
  type ExportFormat,
  type ReportPreviewData,
  type ReportType,
  type TripFlag,
  type UserPublic,
} from '../shared/types';
import { recordAudit } from './audit';
import { computeLicenceExpiryStatus, type RouteAuthDeps } from './directories';
import { buildReportPdf } from './pdf';
import type { AppEnv, D1DatabaseLike } from './types';

const VALID_TYPES: readonly ReportType[] = [
  'all_trips',
  'hires',
  'errands',
  'vehicles',
  'drivers',
  'flagged_trips',
  'audit_log',
];

const VALID_FORMATS: readonly ExportFormat[] = ['csv', 'pdf', 'json', 'md'];

const REPORT_TITLES: Record<ReportType, string> = {
  all_trips: 'All Vehicle Trips Report',
  hires: 'Client Hires Report',
  errands: 'Staff Errands Report',
  vehicles: 'Vehicles Directory & Usage Report',
  drivers: 'Drivers Directory & Licence Report',
  flagged_trips: 'Flagged & Overdue Trips Report',
  audit_log: 'Audit Trail Report',
};

function toHarareDateStr(isoString: string): string {
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
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

interface ColumnDef {
  key: string;
  label: string;
  width: number;
}

interface BuiltReport {
  preview: ReportPreviewData;
  columnDefs: ColumnDef[];
}

async function buildReportDataset(
  db: D1DatabaseLike,
  type: ReportType,
  fromParam: string,
  toParam: string
): Promise<BuiltReport> {
  const settings = await loadSettings(db);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toParam) ? toParam : null;
  const generatedAt = formatHarareTime(new Date().toISOString());

  const company = {
    name: settings.company_name,
    contact_numbers: settings.contact_numbers,
    address: settings.company_address,
  };

  let columnDefs: ColumnDef[] = [];
  const rows: Record<string, string | number | null>[] = [];
  const summary: Record<string, string | number> = {};

  if (type === 'all_trips' || type === 'hires' || type === 'errands' || type === 'flagged_trips') {
    const overdueHours = Number(settings.overdue_hire_hours || 24);
    const nowMs = Date.now();

    let sql = `
      SELECT
        t.id, t.trip_type, t.status, t.client_name, t.destination, t.reason, t.days_hired, t.expected_return_date,
        v.reg_number, v.make_model, v.vehicle_class,
        d.full_name AS driver_name,
        tout.out_at, tout.mileage_out, tout.fuel_out, tout.flags AS out_flags,
        tin.in_at, tin.mileage_in, tin.fuel_in, tin.total_mileage, tin.est_fuel_litres, tin.gauge_fuel_litres, tin.flags AS in_flags,
        (SELECT COUNT(*) FROM corrections c WHERE c.target_id = t.id AND c.target_table IN ('trips','trip_out','trip_in')) AS correction_count
      FROM trips t
      JOIN vehicles v ON v.id = t.vehicle_id
      JOIN drivers d ON d.id = t.driver_id
      JOIN trip_out tout ON tout.trip_id = t.id
      LEFT JOIN trip_in tin ON tin.trip_id = t.id
    `;
    const params: unknown[] = [];
    if (type === 'hires') {
      sql += " WHERE t.trip_type = 'HIRE'";
    } else if (type === 'errands') {
      sql += " WHERE t.trip_type = 'ERRAND'";
    }
    sql += ' ORDER BY t.id DESC';

    const { results } = await db.prepare(sql).bind(...params).all<Record<string, unknown>>();

    let totalKm = 0;
    let totalEstFuel = 0;
    let openCount = 0;
    let flaggedCount = 0;

    for (const r of results) {
      const outAt = String(r.out_at);
      const outDateHarare = toHarareDateStr(outAt);
      if (from && outDateHarare < from) continue;
      if (to && outDateHarare > to) continue;

      const outFlags = parseFlags(r.out_flags);
      const inFlags = parseFlags(r.in_flags);
      const combinedFlags = [...outFlags, ...inFlags];
      const elapsedHours = (nowMs - new Date(outAt).getTime()) / 3_600_000;
      const todayHarare = toHarareDateStr(new Date(nowMs).toISOString());
      const expectedRet = r.expected_return_date ? String(r.expected_return_date) : null;
      const isReturnOverdue =
        r.status === 'OPEN' && r.trip_type === 'HIRE' && Boolean(expectedRet) && expectedRet! < todayHarare;
      const isOverdue =
        (r.status === 'OPEN' && r.trip_type === 'HIRE' && elapsedHours > overdueHours) ||
        isReturnOverdue;

      if (isOverdue && !combinedFlags.some((f) => f.code === 'OVERDUE')) {
        combinedFlags.push({
          code: 'OVERDUE',
          severity: 'HIGH',
          message: isReturnOverdue
            ? `Return overdue (due ${expectedRet})`
            : `Overdue (${Math.floor(elapsedHours)}h)`,
        });
      }

      if (type === 'flagged_trips' && combinedFlags.length === 0) continue;

      if (r.status === 'OPEN') openCount++;
      if (combinedFlags.length > 0) flaggedCount++;
      totalKm += Number(r.total_mileage ?? 0);
      totalEstFuel += Number(r.est_fuel_litres ?? 0);

      rows.push({
        trip_id: Number(r.id),
        type: String(r.trip_type),
        status: isOverdue ? 'OPEN (OVERDUE)' : String(r.status),
        reg_number: String(r.reg_number),
        driver: String(r.driver_name),
        purpose:
          r.trip_type === 'HIRE'
            ? String(r.client_name ?? '')
            : `${r.destination ?? ''}${r.reason ? ` (${r.reason})` : ''}`,
        days_hired: r.days_hired !== null && r.days_hired !== undefined ? Number(r.days_hired) : '-',
        expected_return: r.expected_return_date ? String(r.expected_return_date) : '-',
        out_at: formatHarareTime(outAt),
        in_at: r.in_at ? formatHarareTime(String(r.in_at)) : 'Still Out',
        km_out: Number(r.mileage_out),
        km_in: r.mileage_in !== null && r.mileage_in !== undefined ? Number(r.mileage_in) : '-',
        distance_km: r.total_mileage !== null && r.total_mileage !== undefined ? Number(r.total_mileage) : '-',
        fuel_out_in: `${r.fuel_out} -> ${r.fuel_in ?? '-'}`,
        est_vs_gauge_l:
          r.est_fuel_litres !== null && r.est_fuel_litres !== undefined
            ? `${r.est_fuel_litres} / ${r.gauge_fuel_litres}`
            : '-',
        flags: combinedFlags.map((f) => f.code).join(', ') || 'None',
        corrections: Number(r.correction_count ?? 0),
      });
    }

    columnDefs = [
      { key: 'trip_id', label: 'ID', width: 5 },
      { key: 'type', label: 'Type', width: 6 },
      { key: 'status', label: 'Status', width: 9 },
      { key: 'reg_number', label: 'Vehicle', width: 9 },
      { key: 'driver', label: 'Driver', width: 12 },
      { key: 'purpose', label: 'Client / Destination', width: 14 },
      { key: 'days_hired', label: 'Days', width: 5 },
      { key: 'expected_return', label: 'Exp. Return', width: 10 },
      { key: 'out_at', label: 'Left (Harare)', width: 13 },
      { key: 'in_at', label: 'Returned', width: 13 },
      { key: 'distance_km', label: 'Km', width: 6 },
      { key: 'fuel_out_in', label: 'Gauge', width: 10 },
      { key: 'est_vs_gauge_l', label: 'Est/Gge L', width: 9 },
      { key: 'flags', label: 'Flags', width: 12 },
    ];

    summary['Total Trips'] = rows.length;
    summary['Currently Open'] = openCount;
    summary['Flagged'] = flaggedCount;
    summary['Total Distance'] = `${totalKm.toLocaleString()} km`;
    summary['Est. Fuel'] = `${totalEstFuel.toFixed(1)} L`;
  } else if (type === 'vehicles') {
    const { results } = await db
      .prepare(
        `SELECT v.*,
                ot.trip_type AS open_trip_type,
                (SELECT COUNT(*) FROM trips t WHERE t.vehicle_id = v.id) AS trip_count,
                (SELECT COALESCE(SUM(tin.total_mileage), 0)
                 FROM trips t JOIN trip_in tin ON tin.trip_id = t.id
                 WHERE t.vehicle_id = v.id) AS total_trip_mileage
         FROM vehicles v
         LEFT JOIN trips ot ON ot.vehicle_id = v.id AND ot.status = 'OPEN'
         ORDER BY v.active DESC, v.reg_number ASC`
      )
      .all<Record<string, unknown>>();

    let activeCount = 0;
    let outCount = 0;
    for (const v of results) {
      const active = Number(v.active) === 1;
      if (active) activeCount++;
      const status =
        v.open_trip_type === 'HIRE'
          ? 'Out on Hire'
          : v.open_trip_type === 'ERRAND'
            ? 'Out on Errand'
            : active
              ? 'Available'
              : 'Inactive';
      if (v.open_trip_type) outCount++;

      rows.push({
        reg_number: String(v.reg_number),
        make_model: String(v.make_model),
        vehicle_type: String(v.vehicle_type),
        vehicle_class: String(v.vehicle_class),
        condition: String(v.condition),
        status,
        odometer_km: Number(v.last_known_mileage),
        trips: Number(v.trip_count ?? 0),
        recorded_km: Number(v.total_trip_mileage ?? 0),
        active: active ? 'Yes' : 'No',
      });
    }

    columnDefs = [
      { key: 'reg_number', label: 'Reg No.', width: 12 },
      { key: 'make_model', label: 'Make & Model', width: 18 },
      { key: 'vehicle_type', label: 'Type', width: 12 },
      { key: 'vehicle_class', label: 'Class', width: 10 },
      { key: 'condition', label: 'Condition', width: 16 },
      { key: 'status', label: 'Status', width: 12 },
      { key: 'odometer_km', label: 'Odometer', width: 10 },
      { key: 'trips', label: 'Trips', width: 8 },
      { key: 'recorded_km', label: 'Trip Km', width: 10 },
    ];

    summary['Total Vehicles'] = rows.length;
    summary['Active Fleet'] = activeCount;
    summary['Currently Out'] = outCount;
  } else if (type === 'drivers') {
    const { results } = await db
      .prepare(
        `SELECT d.*,
                ot.trip_type AS open_trip_type,
                (SELECT COUNT(*) FROM trips t WHERE t.driver_id = d.id) AS trip_count
         FROM drivers d
         LEFT JOIN trips ot ON ot.driver_id = d.id AND ot.status = 'OPEN'
         ORDER BY d.active DESC, d.full_name ASC`
      )
      .all<Record<string, unknown>>();

    let activeCount = 0;
    let expiringCount = 0;
    for (const d of results) {
      const active = Number(d.active) === 1;
      if (active) activeCount++;
      const licCheck = computeLicenceExpiryStatus(
        d.licence_expiry ? String(d.licence_expiry) : null
      );
      if (licCheck.licence_status === 'EXPIRING_SOON' || licCheck.licence_status === 'EXPIRED') {
        expiringCount++;
      }
      const status =
        d.open_trip_type === 'HIRE'
          ? 'Out on Hire'
          : d.open_trip_type === 'ERRAND'
            ? 'Out on Errand'
            : active
              ? 'Available'
              : 'Inactive';

      rows.push({
        full_name: String(d.full_name),
        licence_number: normalizeDriverLicenceNumber(d.licence_number) ?? 'Not recorded',
        licence_code: d.licence_code ? String(d.licence_code) : 'Not recorded',
        phone: String(d.phone),
        address: String(d.address ?? ''),
        licence_expiry: d.licence_expiry ? String(d.licence_expiry) : 'Not set',
        licence_status: licCheck.licence_status,
        status,
        trips: Number(d.trip_count ?? 0),
        active: active ? 'Yes' : 'No',
      });
    }

    columnDefs = [
      { key: 'full_name', label: 'Driver Name', width: 16 },
      { key: 'licence_number', label: 'Licence No.', width: 12 },
      { key: 'licence_code', label: 'Class / Code', width: 14 },
      { key: 'phone', label: 'Phone', width: 13 },
      { key: 'address', label: 'Address', width: 16 },
      { key: 'licence_expiry', label: 'Expiry Date', width: 10 },
      { key: 'licence_status', label: 'Licence', width: 12 },
      { key: 'status', label: 'Status', width: 11 },
      { key: 'trips', label: 'Trips', width: 6 },
    ];

    summary['Total Drivers'] = rows.length;
    summary['Active'] = activeCount;
    summary['Expiring / Expired'] = expiringCount;
  } else if (type === 'audit_log') {
    const { results } = await db
      .prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 1000`)
      .all<Record<string, unknown>>();

    for (const r of results) {
      const ts = String(r.ts);
      const harareDate = toHarareDateStr(ts);
      if (from && harareDate < from) continue;
      if (to && harareDate > to) continue;

      rows.push({
        id: Number(r.id),
        ts_harare: formatHarareTime(ts),
        username: String(r.username),
        role: String(r.user_role),
        action: String(r.action),
        entity: `${r.entity}#${r.entity_id}`,
        ip: String(r.ip ?? ''),
        hash_short: String(r.hash).slice(0, 12),
      });
    }

    columnDefs = [
      { key: 'id', label: 'ID', width: 6 },
      { key: 'ts_harare', label: 'Time (Harare)', width: 18 },
      { key: 'username', label: 'User', width: 13 },
      { key: 'role', label: 'Role', width: 12 },
      { key: 'action', label: 'Action', width: 22 },
      { key: 'entity', label: 'Record', width: 15 },
      { key: 'ip', label: 'IP', width: 12 },
      { key: 'hash_short', label: 'Hash', width: 12 },
    ];

    summary['Audit Rows'] = rows.length;
  }

  return {
    preview: {
      type,
      title: REPORT_TITLES[type],
      company,
      generated_at_harare: generatedAt,
      range: { from, to },
      summary,
      columns: columnDefs.map((c) => c.key),
      rows,
      total_rows: rows.length,
    },
    columnDefs,
  };
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(columnDefs: ColumnDef[], rows: Record<string, string | number | null>[]): string {
  const header = columnDefs.map((c) => escapeCsvCell(c.label)).join(',');
  const lines = rows.map((r) => columnDefs.map((c) => escapeCsvCell(r[c.key])).join(','));
  // UTF-8 BOM so Microsoft Excel handles characters cleanly
  return `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
}

function buildMarkdown(preview: ReportPreviewData, columnDefs: ColumnDef[]): string {
  const rangeStr =
    preview.range.from || preview.range.to
      ? `${preview.range.from || 'Start'} to ${preview.range.to || 'Today'}`
      : 'All Dates';
  const summaryLines = Object.entries(preview.summary)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');

  const headerRow = `| ${columnDefs.map((c) => c.label).join(' | ')} |`;
  const sepRow = `| ${columnDefs.map(() => '---').join(' | ')} |`;
  const bodyRows = preview.rows.map(
    (r) =>
      `| ${columnDefs
        .map((c) => String(r[c.key] ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '))
        .join(' | ')} |`
  );

  return [
    `# ${preview.company.name} — ${preview.title}`,
    '',
    `- **Address:** ${preview.company.address}`,
    `- **Contact:** ${preview.company.contact_numbers}`,
    `- **Date Range:** ${rangeStr}`,
    `- **Generated (Africa/Harare):** ${preview.generated_at_harare}`,
    '',
    '## Summary',
    summaryLines,
    '',
    '## Records',
    ...(preview.rows.length > 0 ? [headerRow, sepRow, ...bodyRows] : ['_No matching records._']),
    '',
  ].join('\n');
}

export function registerReportRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // Live preview JSON for Reports UI
  app.get(
    '/reports/preview',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const typeParam = (c.req.query('type') || 'all_trips') as ReportType;
      if (!VALID_TYPES.includes(typeParam)) {
        return c.json({ error: 'Invalid report type.' }, 400);
      }
      const from = (c.req.query('from') || '').trim();
      const to = (c.req.query('to') || '').trim();
      const { preview } = await buildReportDataset(c.env.DB, typeParam, from, to);
      return c.json(preview);
    }
  );

  // Downloadable export in CSV, PDF, JSON, or Markdown
  app.get(
    '/reports/export',
    requireAuth,
    requirePinChanged(),
    requireRole(['SUPERVISOR', 'ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const typeParam = (c.req.query('type') || 'all_trips') as ReportType;
      const formatParam = (c.req.query('format') || 'csv').toLowerCase() as ExportFormat;

      if (!VALID_TYPES.includes(typeParam)) {
        return c.json({ error: 'Invalid report type.' }, 400);
      }
      if (!VALID_FORMATS.includes(formatParam)) {
        return c.json({ error: 'Invalid export format. Use csv, pdf, json, or md.' }, 400);
      }

      const from = (c.req.query('from') || '').trim();
      const to = (c.req.query('to') || '').trim();
      const { preview, columnDefs } = await buildReportDataset(c.env.DB, typeParam, from, to);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'REPORT_EXPORTED',
        entity: 'reports',
        entityId: `${typeParam}:${formatParam}`,
        newValue: {
          type: typeParam,
          format: formatParam,
          from: preview.range.from,
          to: preview.range.to,
          total_rows: preview.total_rows,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      const dateTag = toHarareDateStr(new Date().toISOString()) || 'export';
      const filename = `fleet-secure-${typeParam}-${dateTag}.${formatParam}`;

      if (formatParam === 'csv') {
        const csv = buildCsv(columnDefs, preview.rows);
        return new Response(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      if (formatParam === 'json') {
        return new Response(JSON.stringify(preview, null, 2), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      if (formatParam === 'md') {
        const md = buildMarkdown(preview, columnDefs);
        return new Response(md, {
          status: 200,
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        });
      }

      // PDF
      const dateRangeLabel =
        preview.range.from || preview.range.to
          ? `${preview.range.from || 'Start'} to ${preview.range.to || 'Today'}`
          : 'All Dates';
      const pdfBytes = buildReportPdf({
        companyName: preview.company.name,
        companyContact: preview.company.contact_numbers,
        companyAddress: preview.company.address,
        reportTitle: preview.title,
        generatedAt: preview.generated_at_harare,
        dateRangeLabel,
        summaryItems: Object.entries(preview.summary).map(([label, value]) => ({
          label,
          value: String(value),
        })),
        columns: columnDefs,
        rows: preview.rows,
      });

      return new Response(pdfBytes.slice().buffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }
  );
}
