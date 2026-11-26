import type { Hono } from 'hono';
import {
  DEFAULT_SETTINGS,
  FUEL_LEVELS,
  VEHICLE_TYPE_TO_CLASS,
  formatHarareTime,
  type AppSettings,
  type ChecklistDetail,
  type ChecklistDiffEntry,
  type ChecklistHirerType,
  type ChecklistInputType,
  type ChecklistItem,
  type ChecklistItemTemplate,
  type ChecklistItemValue,
  type ChecklistSignatureEntry,
  type ChecklistSignatures,
  type ChecklistSketchData,
  type ChecklistSummary,
  type CompleteChecklistPayload,
  type CreateChecklistPayload,
  type FuelLevel,
  type SketchDamagePin,
  type UserPublic,
  type VehicleFuelType,
} from '../shared/types';
import { recordAudit } from './audit';
import { validateDocumentDataUrl, type RouteAuthDeps } from './directories';
import { checkAndNotifyVehicleServiceDues, notifyManagersInApp } from './notifications';
import { buildChecklistPdf } from './pdf';
import type { AppEnv, D1DatabaseLike } from './types';

const VALID_INPUT_TYPES: readonly ChecklistInputType[] = [
  'tick_cross',
  'status_pair',
  'yes_no',
  'text',
  'text_checkbox',
  'multi_check',
  'expiry_checks',
  'numbers',
  'available_na',
];

const VALID_FUEL_TYPES: readonly VehicleFuelType[] = ['diesel', 'petrol', 'ev'];
const MAX_PNG_DATA_URL_CHARS = 1_200_000;

export function getHarareTodayDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDaysToYmd(ymd: string, days: number): string {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function buildDeclarationText(companyName: string): string {
  const name = companyName.trim() || DEFAULT_SETTINGS.company_name;
  return `I confirm that the vehicle described above was inspected together with a ${name} representative and that all mileage, fuel/battery readings, tools, accessories, documents, and existing body marks shown on this Digital Vehicle Checklist are true and accurate.`;
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function emptySketch(vehicleKind: ChecklistSketchData['vehicle_kind'] = 'sedan'): ChecklistSketchData {
  return {
    vehicle_kind: vehicleKind,
    strokes_out: [],
    pins_out: [],
    no_damage_out: false,
    strokes_in: [],
    pins_in: [],
    no_damage_in: false,
  };
}

export function inferSketchKind(vehicleType: string): ChecklistSketchData['vehicle_kind'] {
  const low = vehicleType.toLowerCase();
  if (low.includes('double cab')) return 'doublecab';
  if (low.includes('suv')) return 'suv';
  if (low.includes('kombi') || low.includes('quantum') || low.includes('bus') || low.includes('truck')) {
    return 'kombi';
  }
  return 'sedan';
}

function validateDataUrlImage(raw: unknown, label: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a valid image.` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^data:image\/(?:png|jpeg|jpg|webp|svg\+xml)(?:;[^;,]+)*;base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return { ok: false, error: `${label} must be a PNG, JPEG, or WEBP image.` };
  }
  if (trimmed.length > MAX_PNG_DATA_URL_CHARS) {
    return { ok: false, error: `${label} exceeds the maximum size limit.` };
  }
  return { ok: true, value: trimmed };
}

function validateSignatureEntry(
  raw: unknown,
  label: string
): { ok: true; value: ChecklistSignatureEntry } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `${label} sign-off details are required.` };
  }
  const entry = raw as Partial<ChecklistSignatureEntry>;
  const name = String(entry.name ?? '').trim();
  const idNumber = String(entry.id_number ?? '').trim();
  if (name.length < 2) {
    return { ok: false, error: `Enter full name for ${label}.` };
  }
  if (idNumber.length < 2) {
    return { ok: false, error: `Enter ID / Staff No. for ${label}.` };
  }
  const sigCheck = validateDataUrlImage(entry.signature_data_url, `${label} signature`);
  if (!sigCheck.ok) return sigCheck;
  if (!sigCheck.value) {
    return { ok: false, error: `Draw a signature for ${label}.` };
  }
  return {
    ok: true,
    value: {
      name,
      id_number: idNumber,
      signature_data_url: sigCheck.value,
      signed_at: new Date().toISOString(),
    },
  };
}

export function formatItemValueText(inputType: ChecklistInputType, val: ChecklistItemValue | null): string {
  if (!val) return '-';
  if (inputType === 'tick_cross') {
    if (val.choice === 'tick') return 'Present (Tick)';
    if (val.choice === 'cross') return 'Missing / Faulty (X)';
    return val.choice || '-';
  }
  if (inputType === 'status_pair' || inputType === 'yes_no' || inputType === 'available_na') {
    return val.choice || '-';
  }
  if (inputType === 'text') {
    return (val.text || '').trim() || '-';
  }
  if (inputType === 'text_checkbox') {
    const checks = Array.isArray(val.checked) && val.checked.length > 0 ? val.checked.join(', ') : '';
    const txt = (val.text || '').trim();
    return [checks, txt].filter(Boolean).join(' | ') || '-';
  }
  if (inputType === 'multi_check') {
    const checks = Array.isArray(val.checked) && val.checked.length > 0 ? val.checked.join(', ') : '-';
    const txt = (val.text || '').trim();
    return txt ? `${checks} (${txt})` : checks;
  }
  if (inputType === 'numbers') {
    const counts = val.counts || {};
    const parts = Object.entries(counts).map(([k, v]) => `${k}: ${Number(v ?? 0)}`);
    return parts.length > 0 ? parts.join(', ') : '-';
  }
  if (inputType === 'expiry_checks') {
    const expiries = val.expiries || {};
    const parts = Object.entries(expiries).map(([k, info]) => {
      const state = info.checked ? 'Valid' : 'No';
      const exp = info.expiry_date ? ` (Exp ${info.expiry_date})` : '';
      return `${k}: ${state}${exp}`;
    });
    return parts.length > 0 ? parts.join('; ') : '-';
  }
  return '-';
}

export function computeChecklistDifferences(
  items: ChecklistItem[],
  sketch: ChecklistSketchData,
  mileageOut: number,
  mileageIn: number | null,
  fuelOut: FuelLevel | null,
  fuelIn: FuelLevel | null
): ChecklistDiffEntry[] {
  const diffs: ChecklistDiffEntry[] = [];

  for (const item of items) {
    if (!item.value_in) continue;
    const outStr = formatItemValueText(item.input_type, item.value_out);
    const inStr = formatItemValueText(item.input_type, item.value_in);
    if (outStr !== inStr) {
      diffs.push({
        item_id: item.id,
        label: item.custom_label,
        out_summary: outStr,
        in_summary: inStr,
        kind: 'item',
      });
    }
  }

  const outPins = sketch.pins_out?.length ?? 0;
  const inPins = sketch.pins_in?.length ?? 0;
  const outStrokes = sketch.strokes_out?.length ?? 0;
  const inStrokes = sketch.strokes_in?.length ?? 0;
  if (inPins > 0 || inStrokes > 0 || (sketch.no_damage_out && !sketch.no_damage_in)) {
    diffs.push({
      item_id: null,
      label: 'Body Condition Sketch Marks',
      out_summary: sketch.no_damage_out
        ? 'No damage (OUT)'
        : `${outPins} pin(s), ${outStrokes} stroke(s)`,
      in_summary: sketch.no_damage_in
        ? 'No new damage (IN)'
        : `${inPins} new IN pin(s), ${inStrokes} IN stroke(s)`,
      kind: 'sketch',
    });
  }

  // Odometer increase between OUT and IN is normal trip distance and is not flagged as a discrepancy.

  if (fuelOut && fuelIn && fuelOut !== fuelIn) {
    diffs.push({
      item_id: null,
      label: 'Fuel / Gauge Level',
      out_summary: fuelOut,
      in_summary: fuelIn,
      kind: 'fuel',
    });
  }

  return diffs;
}

function mapTemplateRow(row: Record<string, unknown>): ChecklistItemTemplate {
  return {
    id: Number(row.id),
    code: String(row.code),
    label: String(row.label),
    category: String(row.category),
    input_type: row.input_type as ChecklistInputType,
    options: parseJsonSafe<string[]>(row.options_json, []),
    sort_order: Number(row.sort_order),
    is_default: Number(row.is_default) === 1,
    active: Number(row.active) === 1,
    created_at: String(row.created_at),
  };
}

function mapChecklistSummaryRow(row: Record<string, unknown>): ChecklistSummary {
  return {
    id: Number(row.id),
    trip_id: row.trip_id !== null && row.trip_id !== undefined ? Number(row.trip_id) : null,
    vehicle_id: Number(row.vehicle_id),
    status: row.status as 'out' | 'completed',
    hirer_type: row.hirer_type as ChecklistHirerType,
    hirer_name: String(row.hirer_name),
    representative: String(row.representative ?? ''),
    cell: String(row.cell ?? ''),
    car_model: String(row.car_model),
    vehicle_type: String(row.vehicle_type),
    colour: row.colour ? String(row.colour) : null,
    reg_number: String(row.reg_number),
    hire_date: String(row.hire_date),
    days: Number(row.days),
    return_date: String(row.return_date),
    mileage_out: Number(row.mileage_out),
    mileage_out_diff_warning: Number(row.mileage_out_diff_warning ?? 0) === 1,
    previous_closing_mileage:
      row.previous_closing_mileage !== null && row.previous_closing_mileage !== undefined
        ? Number(row.previous_closing_mileage)
        : null,
    mileage_in: row.mileage_in !== null && row.mileage_in !== undefined ? Number(row.mileage_in) : null,
    next_service_mileage:
      row.next_service_mileage !== null && row.next_service_mileage !== undefined
        ? Number(row.next_service_mileage)
        : null,
    datetime_in: row.datetime_in ? String(row.datetime_in) : null,
    fuel_type: (row.fuel_type as VehicleFuelType) || 'petrol',
    fuel_out: (row.fuel_out as FuelLevel | null) ?? null,
    fuel_in: (row.fuel_in as FuelLevel | null) ?? null,
    differences: parseJsonSafe<ChecklistDiffEntry[]>(row.differences_json, []),
    notes: String(row.notes ?? ''),
    created_by: Number(row.created_by),
    created_by_name: row.created_by_name ? String(row.created_by_name) : undefined,
    returned_by: row.returned_by !== null && row.returned_by !== undefined ? Number(row.returned_by) : null,
    returned_by_name: row.returned_by_name ? String(row.returned_by_name) : undefined,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapChecklistItemRow(row: Record<string, unknown>): ChecklistItem {
  return {
    id: Number(row.id),
    checklist_id: Number(row.checklist_id),
    template_id: row.template_id !== null && row.template_id !== undefined ? Number(row.template_id) : null,
    custom_label: String(row.custom_label),
    input_type: row.input_type as ChecklistInputType,
    options: parseJsonSafe<string[]>(row.options_json, []),
    sort_order: Number(row.sort_order),
    value_out: parseJsonSafe<ChecklistItemValue>(row.value_out_json, {}),
    value_in: row.value_in_json ? parseJsonSafe<ChecklistItemValue>(row.value_in_json, {}) : null,
    note: String(row.note ?? ''),
    photo_data_url: row.photo_data_url ? String(row.photo_data_url) : null,
  };
}

async function getSettingsMap(db: D1DatabaseLike): Promise<AppSettings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const merged: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of results) {
    merged[row.key] = row.value;
  }
  return merged as unknown as AppSettings;
}

const CHECKLIST_LIST_SELECT = `
  SELECT
    c.id, c.trip_id, c.vehicle_id, c.status, c.hirer_type, c.hirer_name, c.representative, c.cell,
    c.car_model, c.vehicle_type, c.colour, c.reg_number, c.hire_date, c.days, c.return_date,
    c.mileage_out, c.mileage_out_diff_warning, c.previous_closing_mileage, c.mileage_in,
    c.next_service_mileage, c.datetime_in, c.fuel_type, c.fuel_out, c.fuel_in,
    c.differences_json, c.notes, c.created_by, c.returned_by, c.created_at, c.updated_at,
    cu.full_name AS created_by_name,
    ru.full_name AS returned_by_name
  FROM checklists c
  LEFT JOIN users cu ON cu.id = c.created_by
  LEFT JOIN users ru ON ru.id = c.returned_by
`;

async function fetchChecklistDetail(db: D1DatabaseLike, checklistId: number): Promise<ChecklistDetail | null> {
  const row = await db
    .prepare(
      `SELECT c.*, cu.full_name AS created_by_name, ru.full_name AS returned_by_name
       FROM checklists c
       LEFT JOIN users cu ON cu.id = c.created_by
       LEFT JOIN users ru ON ru.id = c.returned_by
       WHERE c.id = ? AND c.deleted_at IS NULL`
    )
    .bind(checklistId)
    .first<Record<string, unknown>>();
  if (!row) return null;

  const { results: itemRows } = await db
    .prepare('SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY sort_order ASC, id ASC')
    .bind(checklistId)
    .all<Record<string, unknown>>();

  const summary = mapChecklistSummaryRow(row);
  return {
    ...summary,
    sketch: parseJsonSafe<ChecklistSketchData>(
      row.sketch_json,
      emptySketch(inferSketchKind(summary.vehicle_type))
    ),
    sketch_png_data_url: row.sketch_png_data_url ? String(row.sketch_png_data_url) : null,
    signatures: parseJsonSafe<ChecklistSignatures>(row.signatures_json, {
      outRenter: null,
      outCompany: null,
      inRenter: null,
      inCompany: null,
    }),
    declaration_text: String(row.declaration_text ?? ''),
    items: itemRows.map(mapChecklistItemRow),
  };
}

export function registerChecklistRoutes(
  app: Hono<{ Bindings: AppEnv; Variables: { user?: UserPublic } }>,
  deps: RouteAuthDeps
) {
  const { requireAuth, requirePinChanged, requireRole, getClientIp, getUserAgent } = deps;

  // ---------------- CHECKLIST ITEM TEMPLATES ----------------
  app.get('/checklist-templates', requireAuth, requirePinChanged(), async (c) => {
    const includeInactive = c.req.query('includeInactive') === '1';
    const sql = includeInactive
      ? 'SELECT * FROM checklist_item_templates ORDER BY sort_order ASC, id ASC'
      : 'SELECT * FROM checklist_item_templates WHERE active = 1 ORDER BY sort_order ASC, id ASC';
    const { results } = await c.env.DB.prepare(sql).all<Record<string, unknown>>();
    return c.json({ items: results.map(mapTemplateRow) });
  });

  app.post(
    '/checklist-templates',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      let body: {
        label?: string;
        category?: string;
        input_type?: ChecklistInputType;
        options?: string[];
        sort_order?: number;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const label = (body.label || '').trim();
      const category = (body.category || 'Custom').trim();
      const inputType = body.input_type || 'tick_cross';
      const options = Array.isArray(body.options)
        ? body.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
      const sortOrder = Number.isInteger(body.sort_order) ? Number(body.sort_order) : 100;

      if (label.length < 2) {
        return c.json({ error: 'Template item label must be at least 2 characters.' }, 400);
      }
      if (!VALID_INPUT_TYPES.includes(inputType)) {
        return c.json({ error: 'Choose a valid checklist input type.' }, 400);
      }

      const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
      const code = `custom_${slug || 'item'}_${Date.now().toString(36)}`;

      const res = await c.env.DB.prepare(
        `INSERT INTO checklist_item_templates (code, label, category, input_type, options_json, sort_order, is_default, active)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1)`
      )
        .bind(code, label, category, inputType, JSON.stringify(options), sortOrder)
        .run();

      const createdRow = await c.env.DB.prepare('SELECT * FROM checklist_item_templates WHERE id = ?')
        .bind(res.meta.last_row_id)
        .first<Record<string, unknown>>();
      const template = mapTemplateRow(createdRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'CHECKLIST_TEMPLATE_CREATED',
        entity: 'checklist_item_templates',
        entityId: template.id,
        newValue: { code: template.code, label: template.label, input_type: template.input_type },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ template }, 201);
    }
  );

  app.patch(
    '/checklist-templates/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid template ID.' }, 400);

      const oldRow = await c.env.DB.prepare('SELECT * FROM checklist_item_templates WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>();
      if (!oldRow) return c.json({ error: 'Checklist template not found.' }, 404);
      const oldTpl = mapTemplateRow(oldRow);

      let body: { label?: string; active?: boolean; sort_order?: number; category?: string };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid request body.' }, 400);
      }

      const nextLabel = body.label !== undefined ? body.label.trim() : oldTpl.label;
      const nextActive = body.active !== undefined ? Boolean(body.active) : oldTpl.active;
      const nextSort = body.sort_order !== undefined ? Number(body.sort_order) : oldTpl.sort_order;
      const nextCat = body.category !== undefined ? body.category.trim() : oldTpl.category;

      if (nextLabel.length < 2) {
        return c.json({ error: 'Template label must be at least 2 characters.' }, 400);
      }

      await c.env.DB.prepare(
        `UPDATE checklist_item_templates SET label = ?, category = ?, sort_order = ?, active = ? WHERE id = ?`
      )
        .bind(nextLabel, nextCat, nextSort, nextActive ? 1 : 0, id)
        .run();

      const updatedRow = await c.env.DB.prepare('SELECT * FROM checklist_item_templates WHERE id = ?')
        .bind(id)
        .first<Record<string, unknown>>();
      const template = mapTemplateRow(updatedRow!);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'CHECKLIST_TEMPLATE_UPDATED',
        entity: 'checklist_item_templates',
        entityId: id,
        oldValue: { label: oldTpl.label, active: oldTpl.active },
        newValue: { label: template.label, active: template.active },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ template });
    }
  );

  // ---------------- CHECKLISTS LIST & DETAIL ----------------
  app.get('/checklists', requireAuth, requirePinChanged(), async (c) => {
    const status = (c.req.query('status') || '').trim();
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const vehicleId = Number(c.req.query('vehicle_id') || 0);
    const tripId = Number(c.req.query('trip_id') || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || 50)));

    const clauses: string[] = ['c.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (status === 'out' || status === 'completed') {
      clauses.push('c.status = ?');
      params.push(status);
    }
    if (vehicleId > 0) {
      clauses.push('c.vehicle_id = ?');
      params.push(vehicleId);
    }
    if (tripId > 0) {
      clauses.push('c.trip_id = ?');
      params.push(tripId);
    }
    if (q) {
      clauses.push(
        '(LOWER(c.reg_number) LIKE ? OR LOWER(c.hirer_name) LIKE ? OR LOWER(c.hire_date) LIKE ? OR LOWER(c.car_model) LIKE ?)'
      );
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const whereSql = `WHERE ${clauses.join(' AND ')}`;
    const { results } = await c.env.DB.prepare(
      `${CHECKLIST_LIST_SELECT}
       ${whereSql}
       ORDER BY CASE WHEN c.status = 'out' THEN 0 ELSE 1 END, c.id DESC
       LIMIT ?`
    )
      .bind(...params, limit)
      .all<Record<string, unknown>>();

    return c.json({ items: results.map(mapChecklistSummaryRow) });
  });

  app.get('/checklists/:id', requireAuth, requirePinChanged(), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: 'Invalid checklist ID.' }, 400);
    }
    const detail = await fetchChecklistDetail(c.env.DB, id);
    if (!detail) {
      return c.json({ error: 'Checklist record not found.' }, 404);
    }
    return c.json({ checklist: detail });
  });

  // ---------------- CREATE NEW CHECKLIST (OUT STAGE) ----------------
  app.post('/checklists', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    let body: CreateChecklistPayload;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid checklist payload.' }, 400);
    }

    const hirerType = body.hirer_type;
    if (hirerType !== 'renter' && hirerType !== 'owner') {
      return c.json({ error: "Select Hirer Type (Renter's Name or Owner's Name)." }, 400);
    }
    const hirerName = String(body.hirer_name || '').trim();
    if (hirerName.length < 2) {
      return c.json({ error: "Enter the Renter's or Owner's full name." }, 400);
    }
    const representative = String(body.representative || '').trim();
    const cell = String(body.cell || '').trim();
    if (!cell || cell.length < 5) {
      return c.json({ error: 'Enter a valid contact Cell phone number.' }, 400);
    }

    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return c.json({ error: 'Days must be a whole number of at least 1.' }, 400);
    }

    const todayHarare = getHarareTodayDate();
    let hireDate = todayHarare;
    let hireDateOverridden = false;
    if (body.hire_date && body.hire_date.trim() !== todayHarare) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.hire_date.trim())) {
        return c.json({ error: 'Hire date must be YYYY-MM-DD.' }, 400);
      }
      if (actor.role !== 'ADMIN') {
        return c.json(
          { error: 'Only an Administrator may override or backdate the Hire Date.' },
          403
        );
      }
      hireDate = body.hire_date.trim();
      hireDateOverridden = true;
    }
    const returnDate = addDaysToYmd(hireDate, days);

    const fuelType = (body.fuel_type || 'petrol') as VehicleFuelType;
    if (!VALID_FUEL_TYPES.includes(fuelType)) {
      return c.json({ error: 'Choose a valid Fuel Type (Diesel, Petrol, or EV).' }, 400);
    }

    let fuelOut: FuelLevel | null = body.fuel_out ?? null;
    if (fuelType === 'ev') {
      if (fuelOut && !(FUEL_LEVELS as readonly string[]).includes(fuelOut)) {
        return c.json({ error: 'Invalid gauge level selected.' }, 400);
      }
    } else {
      if (!fuelOut || !(FUEL_LEVELS as readonly string[]).includes(fuelOut)) {
        return c.json({ error: 'Select the Fuel OUT gauge level.' }, 400);
      }
    }

    const mileageOut = Number(body.mileage_out);
    if (!Number.isInteger(mileageOut) || mileageOut < 0) {
      return c.json({ error: 'Mileage OUT must be a whole number 0 or greater.' }, 400);
    }

    const nextServiceMileage =
      body.next_service_mileage !== undefined &&
      body.next_service_mileage !== null &&
      String(body.next_service_mileage).trim() !== ''
        ? Number(body.next_service_mileage)
        : null;
    if (nextServiceMileage !== null && (!Number.isInteger(nextServiceMileage) || nextServiceMileage < 0)) {
      return c.json({ error: 'Next Service Mileage must be a whole number 0 or greater.' }, 400);
    }

    // Resolve or add inline vehicle in Vehicle Directory
    let vehicleRow: Record<string, unknown> | null = null;
    let vehicleCreatedInline = false;

    if (body.new_vehicle) {
      const nv = body.new_vehicle;
      const reg = String(nv.reg_number || '').trim().toUpperCase().replace(/\s+/g, ' ');
      const vType = String(nv.vehicle_type || '').trim();
      const makeModel = String(nv.make_model || '').trim();
      const colour = nv.colour ? String(nv.colour).trim() : null;
      const vFuel: VehicleFuelType = VALID_FUEL_TYPES.includes(nv.fuel_type as VehicleFuelType)
        ? (nv.fuel_type as VehicleFuelType)
        : fuelType;
      const startKm = Number.isInteger(nv.last_known_mileage)
        ? Number(nv.last_known_mileage)
        : mileageOut;

      if (reg.length < 3) {
        return c.json({ error: 'New vehicle registration number must be at least 3 characters.' }, 400);
      }
      const vClass = VEHICLE_TYPE_TO_CLASS[vType];
      if (!vClass) {
        return c.json({ error: 'Choose a valid vehicle type for the new vehicle.' }, 400);
      }
      if (makeModel.length < 2) {
        return c.json({ error: 'Enter make & model for the new vehicle.' }, 400);
      }

      const dup = await c.env.DB.prepare('SELECT id FROM vehicles WHERE reg_number = ?')
        .bind(reg)
        .first<{ id: number }>();
      if (dup) {
        return c.json(
          { error: `Registration "${reg}" already exists in the Vehicle Directory. Pick it from the dropdown instead.` },
          409
        );
      }

      const vIns = await c.env.DB.prepare(
        `INSERT INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, colour, fuel_type, condition, last_known_mileage, next_service_due_km, next_service_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, 'Good', ?, ?, ?, 1)`
      )
        .bind(reg, vType, vClass, makeModel, colour, vFuel, startKm, nextServiceMileage, nextServiceMileage)
        .run();

      vehicleRow = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(vIns.meta.last_row_id)
        .first<Record<string, unknown>>();
      vehicleCreatedInline = true;
    } else if (body.vehicle_id) {
      vehicleRow = await c.env.DB.prepare('SELECT * FROM vehicles WHERE id = ?')
        .bind(Number(body.vehicle_id))
        .first<Record<string, unknown>>();
      if (!vehicleRow) {
        return c.json({ error: 'Selected vehicle was not found in the Vehicle Directory.' }, 404);
      }
    } else {
      return c.json({ error: 'Select a vehicle from the Vehicle Directory or add a new vehicle.' }, 400);
    }

    const vehicleId = Number(vehicleRow!.id);
    const regNumber = String(vehicleRow!.reg_number);
    const carModel = String(vehicleRow!.make_model);
    const vehicleType = String(vehicleRow!.vehicle_type);
    const colour = body.colour !== undefined ? (body.colour ? String(body.colour).trim() : null) : vehicleRow!.colour ? String(vehicleRow!.colour) : null;

    const prevClosing =
      vehicleRow!.last_closing_mileage !== null && vehicleRow!.last_closing_mileage !== undefined
        ? Number(vehicleRow!.last_closing_mileage)
        : Number(vehicleRow!.last_known_mileage ?? 0);
    const mileageDiffWarning = mileageOut !== prevClosing;

    // Validate Sketch (OUT)
    const rawSketch = body.sketch || emptySketch(inferSketchKind(vehicleType));
    const strokesOut = Array.isArray(rawSketch.strokes_out) ? rawSketch.strokes_out : [];
    const pinsOut: SketchDamagePin[] = Array.isArray(rawSketch.pins_out) ? rawSketch.pins_out : [];
    const noDamageOut = Boolean(rawSketch.no_damage_out);
    if (!noDamageOut && strokesOut.length === 0 && pinsOut.length === 0) {
      return c.json(
        { error: 'Mark damage on the Vehicle Condition Sketch or tick "No damage found (OUT)".' },
        400
      );
    }

    const sanitizedSketch: ChecklistSketchData = {
      vehicle_kind:
        rawSketch.vehicle_kind && ['sedan', 'suv', 'doublecab', 'kombi'].includes(rawSketch.vehicle_kind)
          ? rawSketch.vehicle_kind
          : inferSketchKind(vehicleType),
      strokes_out: strokesOut,
      pins_out: pinsOut,
      no_damage_out: noDamageOut,
      // Lock IN fields on creation
      strokes_in: [],
      pins_in: [],
      no_damage_in: false,
    };

    const sketchPngCheck = validateDataUrlImage(body.sketch_png_data_url, 'Vehicle sketch snapshot');
    if (!sketchPngCheck.ok) return c.json({ error: sketchPngCheck.error }, 400);

    // Validate OUT signatures (Section G)
    const outRenterSig = validateSignatureEntry(body.signatures?.outRenter, 'Renter / Driver (OUT)');
    if (!outRenterSig.ok) return c.json({ error: outRenterSig.error }, 400);
    const outCompanySig = validateSignatureEntry(body.signatures?.outCompany, 'Company Representative (OUT)');
    if (!outCompanySig.ok) return c.json({ error: outCompanySig.error }, 400);

    const signatures: ChecklistSignatures = {
      outRenter: outRenterSig.value,
      outCompany: outCompanySig.value,
      inRenter: null,
      inCompany: null,
    };

    // Validate inspection rows
    const incomingItems = Array.isArray(body.items) ? body.items : [];
    if (incomingItems.length === 0) {
      return c.json({ error: 'Checklist inspection rows are required.' }, 400);
    }

    const validatedItems: Array<{
      template_id: number | null;
      custom_label: string;
      input_type: ChecklistInputType;
      options: string[];
      sort_order: number;
      value_out: ChecklistItemValue;
      note: string;
      photo_data_url: string | null;
    }> = [];

    for (let i = 0; i < incomingItems.length; i++) {
      const it = incomingItems[i];
      const label = String(it.custom_label || '').trim();
      const inputType = it.input_type;
      if (!label) {
        return c.json({ error: `Checklist row #${i + 1} is missing a label.` }, 400);
      }
      if (!VALID_INPUT_TYPES.includes(inputType)) {
        return c.json({ error: `Checklist row "${label}" has an invalid input type.` }, 400);
      }
      const photoRes = validateDocumentDataUrl(it.photo_data_url, `Photo for "${label}"`);
      if (!photoRes.ok) return c.json({ error: photoRes.error }, 400);

      validatedItems.push({
        template_id: it.template_id ? Number(it.template_id) : null,
        custom_label: label,
        input_type: inputType,
        options: Array.isArray(it.options) ? it.options.map((o) => String(o)) : [],
        sort_order: Number.isInteger(it.sort_order) ? Number(it.sort_order) : i + 1,
        value_out: it.value_out && typeof it.value_out === 'object' ? it.value_out : {},
        note: String(it.note || '').trim(),
        photo_data_url: photoRes.value,
      });
    }

    const settings = await getSettingsMap(c.env.DB);
    const declarationText = buildDeclarationText(settings.company_name);
    const tripId = body.trip_id && Number.isInteger(Number(body.trip_id)) ? Number(body.trip_id) : null;
    const notes = String(body.notes || '').trim();

    const ins = await c.env.DB.prepare(
      `INSERT INTO checklists (
         trip_id, vehicle_id, status, hirer_type, hirer_name, representative, cell,
         car_model, vehicle_type, colour, reg_number, hire_date, days, return_date,
         mileage_out, mileage_out_diff_warning, previous_closing_mileage, mileage_in,
         next_service_mileage, datetime_in, fuel_type, fuel_out, fuel_in,
         sketch_json, sketch_png_data_url, signatures_json, declaration_text, differences_json, notes,
         created_by
       )
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, '[]', ?, ?)`
    )
      .bind(
        tripId,
        vehicleId,
        hirerType,
        hirerName,
        representative,
        cell,
        carModel,
        vehicleType,
        colour,
        regNumber,
        hireDate,
        days,
        returnDate,
        mileageOut,
        mileageDiffWarning ? 1 : 0,
        prevClosing,
        nextServiceMileage,
        fuelType,
        fuelOut,
        JSON.stringify(sanitizedSketch),
        sketchPngCheck.value,
        JSON.stringify(signatures),
        declarationText,
        notes,
        actor.id
      )
      .run();

    const checklistId = ins.meta.last_row_id;

    for (const item of validatedItems) {
      await c.env.DB.prepare(
        `INSERT INTO checklist_items (checklist_id, template_id, custom_label, input_type, options_json, sort_order, value_out_json, value_in_json, note, photo_data_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
        .bind(
          checklistId,
          item.template_id,
          item.custom_label,
          item.input_type,
          JSON.stringify(item.options),
          item.sort_order,
          JSON.stringify(item.value_out),
          item.note,
          item.photo_data_url
        )
        .run();
    }

    // Update vehicle colour / fuel_type / next service / mileage snapshot if changed
    await c.env.DB.prepare(
      `UPDATE vehicles
       SET colour = COALESCE(?, colour),
           fuel_type = ?,
           next_service_mileage = COALESCE(?, next_service_mileage),
           next_service_due_km = COALESCE(?, next_service_due_km),
           last_known_mileage = CASE WHEN ? > last_known_mileage THEN ? ELSE last_known_mileage END
       WHERE id = ?`
    )
      .bind(colour, fuelType, nextServiceMileage, nextServiceMileage, mileageOut, mileageOut, vehicleId)
      .run();

    const detail = await fetchChecklistDetail(c.env.DB, checklistId);

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: 'CHECKLIST_CREATED',
      entity: 'checklists',
      entityId: checklistId,
      newValue: {
        checklist_id: checklistId,
        reg_number: regNumber,
        hirer_type: hirerType,
        hirer_name: hirerName,
        hire_date: hireDate,
        hire_date_overridden: hireDateOverridden,
        return_date: returnDate,
        mileage_out: mileageOut,
        previous_closing_mileage: prevClosing,
        mileage_out_diff_warning: mileageDiffWarning,
        fuel_type: fuelType,
        fuel_out: fuelOut,
        vehicle_created_inline: vehicleCreatedInline,
        items_count: validatedItems.length,
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    await notifyManagersInApp(
      c.env.DB,
      {
        eventType: 'CHECKLIST_CREATED',
        priority: mileageDiffWarning ? 'HIGH' : 'NORMAL',
        title: `Vehicle Checklist Out: ${regNumber}${mileageDiffWarning ? ' (Mileage Altered)' : ''}`,
        body: `${actor.full_name} completed OUT checklist #${checklistId} for ${regNumber} (${hirerName}, ${mileageOut.toLocaleString()} km${mileageDiffWarning ? `, differs from previous closing ${prevClosing.toLocaleString()} km` : ''}).`,
        tripId,
      },
      { env: c.env, roles: ['ADMIN', 'SUPERVISOR'] }
    );

    if (nextServiceMileage !== null) {
      await checkAndNotifyVehicleServiceDues(c.env.DB, { env: c.env });
    }

    return c.json({ checklist: detail }, 201);
  });

  // ---------------- ADD CUSTOM ITEM TO OPEN CHECKLIST ----------------
  app.post('/checklists/:id/items', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    const checklistId = Number(c.req.param('id'));
    if (!Number.isInteger(checklistId) || checklistId <= 0) {
      return c.json({ error: 'Invalid checklist ID.' }, 400);
    }

    const parent = await c.env.DB.prepare('SELECT id, status, deleted_at FROM checklists WHERE id = ?')
      .bind(checklistId)
      .first<{ id: number; status: string; deleted_at: string | null }>();
    if (!parent || parent.deleted_at) {
      return c.json({ error: 'Checklist not found.' }, 404);
    }
    if (parent.status !== 'out') {
      return c.json({ error: 'Cannot add rows after a checklist has been completed.' }, 400);
    }

    let body: {
      custom_label?: string;
      input_type?: ChecklistInputType;
      options?: string[];
      value_out?: ChecklistItemValue;
      note?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid request body.' }, 400);
    }

    const label = String(body.custom_label || '').trim();
    const inputType = body.input_type || 'tick_cross';
    if (label.length < 2) {
      return c.json({ error: 'Row label must be at least 2 characters.' }, 400);
    }
    if (!VALID_INPUT_TYPES.includes(inputType)) {
      return c.json({ error: 'Invalid checklist input type.' }, 400);
    }

    const maxRow = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM checklist_items WHERE checklist_id = ?'
    )
      .bind(checklistId)
      .first<{ max_sort: number }>();
    const sortOrder = Number(maxRow?.max_sort ?? 0) + 1;

    const ins = await c.env.DB.prepare(
      `INSERT INTO checklist_items (checklist_id, template_id, custom_label, input_type, options_json, sort_order, value_out_json, value_in_json, note)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?)`
    )
      .bind(
        checklistId,
        label,
        inputType,
        JSON.stringify(Array.isArray(body.options) ? body.options : []),
        sortOrder,
        JSON.stringify(body.value_out || {}),
        String(body.note || '').trim()
      )
      .run();

    const itemRow = await c.env.DB.prepare('SELECT * FROM checklist_items WHERE id = ?')
      .bind(ins.meta.last_row_id)
      .first<Record<string, unknown>>();
    const item = mapChecklistItemRow(itemRow!);

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: 'CHECKLIST_CUSTOM_ROW_ADDED',
      entity: 'checklists',
      entityId: checklistId,
      newValue: { item_id: item.id, custom_label: item.custom_label, input_type: item.input_type },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    return c.json({ item }, 201);
  });

  // ---------------- COMPLETE RETURN (IN STAGE) ----------------
  app.post('/checklists/:id/complete', requireAuth, requirePinChanged(), async (c) => {
    const actor = c.get('user')!;
    const checklistId = Number(c.req.param('id'));
    if (!Number.isInteger(checklistId) || checklistId <= 0) {
      return c.json({ error: 'Invalid checklist ID.' }, 400);
    }

    const existing = await fetchChecklistDetail(c.env.DB, checklistId);
    if (!existing) {
      return c.json({ error: 'Checklist not found.' }, 404);
    }
    if (existing.status !== 'out') {
      return c.json({ error: 'This checklist has already been completed and returned.' }, 409);
    }

    let body: CompleteChecklistPayload;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid return checklist payload.' }, 400);
    }

    const mileageIn = Number(body.mileage_in);
    if (!Number.isInteger(mileageIn) || mileageIn < 0) {
      return c.json({ error: 'Mileage IN must be a whole number 0 or greater.' }, 400);
    }
    if (mileageIn < existing.mileage_out) {
      return c.json(
        {
          error: `Mileage IN (${mileageIn.toLocaleString()} km) cannot be less than Mileage OUT (${existing.mileage_out.toLocaleString()} km).`,
        },
        400
      );
    }

    let fuelIn: FuelLevel | null = body.fuel_in ?? null;
    if (existing.fuel_type === 'ev') {
      if (fuelIn && !(FUEL_LEVELS as readonly string[]).includes(fuelIn)) {
        return c.json({ error: 'Invalid gauge level selected.' }, 400);
      }
    } else {
      if (!fuelIn || !(FUEL_LEVELS as readonly string[]).includes(fuelIn)) {
        return c.json({ error: 'Select the Fuel IN gauge level on return.' }, 400);
      }
    }

    const nextServiceMileage =
      body.next_service_mileage !== undefined
        ? body.next_service_mileage !== null && String(body.next_service_mileage).trim() !== ''
          ? Number(body.next_service_mileage)
          : null
        : existing.next_service_mileage;

    if (nextServiceMileage !== null && (!Number.isInteger(nextServiceMileage) || nextServiceMileage < 0)) {
      return c.json({ error: 'Next Service Mileage must be a whole number.' }, 400);
    }

    // Preserve immutable OUT sketch, validate IN sketch additions or no_damage_in
    const incomingSketch = body.sketch || existing.sketch;
    const strokesIn = Array.isArray(incomingSketch.strokes_in) ? incomingSketch.strokes_in : [];
    const pinsIn = Array.isArray(incomingSketch.pins_in) ? incomingSketch.pins_in : [];
    const noDamageIn = Boolean(incomingSketch.no_damage_in);
    if (!noDamageIn && strokesIn.length === 0 && pinsIn.length === 0) {
      return c.json(
        { error: 'Mark any return damage on the sketch or tick "No damage found (IN)".' },
        400
      );
    }

    const mergedSketch: ChecklistSketchData = {
      vehicle_kind: existing.sketch.vehicle_kind,
      strokes_out: existing.sketch.strokes_out,
      pins_out: existing.sketch.pins_out,
      no_damage_out: existing.sketch.no_damage_out,
      strokes_in: strokesIn,
      pins_in: pinsIn,
      no_damage_in: noDamageIn,
    };

    const sketchPngCheck = validateDataUrlImage(body.sketch_png_data_url, 'Vehicle sketch snapshot');
    if (!sketchPngCheck.ok) return c.json({ error: sketchPngCheck.error }, 400);

    // Validate IN signatures (preserve OUT signatures)
    const inRenterSig = validateSignatureEntry(body.signatures?.inRenter, 'Renter / Driver (IN)');
    if (!inRenterSig.ok) return c.json({ error: inRenterSig.error }, 400);
    const inCompanySig = validateSignatureEntry(body.signatures?.inCompany, 'Company Representative (IN)');
    if (!inCompanySig.ok) return c.json({ error: inCompanySig.error }, 400);

    const mergedSignatures: ChecklistSignatures = {
      outRenter: existing.signatures.outRenter,
      outCompany: existing.signatures.outCompany,
      inRenter: inRenterSig.value,
      inCompany: inCompanySig.value,
    };

    const itemUpdates = Array.isArray(body.items) ? body.items : [];
    const updateById = new Map(itemUpdates.map((it) => [Number(it.id), it]));

    for (const origItem of existing.items) {
      const upd = updateById.get(origItem.id);
      if (upd) {
        const photoCheck =
          upd.photo_data_url !== undefined
            ? validateDocumentDataUrl(upd.photo_data_url, `Photo for "${origItem.custom_label}"`)
            : { ok: true as const, value: origItem.photo_data_url };
        if (!photoCheck.ok) return c.json({ error: photoCheck.error }, 400);

        const nextNote = upd.note !== undefined ? String(upd.note).trim() : origItem.note;
        await c.env.DB.prepare(
          'UPDATE checklist_items SET value_in_json = ?, note = ?, photo_data_url = ? WHERE id = ? AND checklist_id = ?'
        )
          .bind(
            JSON.stringify(upd.value_in ?? {}),
            nextNote,
            photoCheck.value,
            origItem.id,
            checklistId
          )
          .run();
      }
    }

    const refreshedItemsRows = await c.env.DB.prepare(
      'SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY sort_order ASC, id ASC'
    )
      .bind(checklistId)
      .all<Record<string, unknown>>();
    const updatedItems = refreshedItemsRows.results.map(mapChecklistItemRow);

    const differences = computeChecklistDifferences(
      updatedItems,
      mergedSketch,
      existing.mileage_out,
      mileageIn,
      existing.fuel_out,
      fuelIn
    );

    const datetimeIn = new Date().toISOString();
    const nextColour =
      body.colour !== undefined ? (body.colour ? String(body.colour).trim() : null) : existing.colour;
    const nextNotes = body.notes !== undefined ? String(body.notes).trim() : existing.notes;

    await c.env.DB.prepare(
      `UPDATE checklists
       SET status = 'completed',
           mileage_in = ?,
           next_service_mileage = ?,
           datetime_in = ?,
           fuel_in = ?,
           colour = ?,
           sketch_json = ?,
           sketch_png_data_url = COALESCE(?, sketch_png_data_url),
           signatures_json = ?,
           differences_json = ?,
           notes = ?,
           returned_by = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    )
      .bind(
        mileageIn,
        nextServiceMileage,
        datetimeIn,
        fuelIn,
        nextColour,
        JSON.stringify(mergedSketch),
        sketchPngCheck.value,
        JSON.stringify(mergedSignatures),
        JSON.stringify(differences),
        nextNotes,
        actor.id,
        checklistId
      )
      .run();

    // Write back vehicle snapshots (last closing mileage, last fuel level, colour, next service)
    await c.env.DB.prepare(
      `UPDATE vehicles
       SET last_known_mileage = CASE WHEN ? > last_known_mileage THEN ? ELSE last_known_mileage END,
           last_closing_mileage = ?,
           last_fuel_level = COALESCE(?, last_fuel_level),
           colour = COALESCE(?, colour),
           next_service_mileage = COALESCE(?, next_service_mileage),
           next_service_due_km = COALESCE(?, next_service_due_km)
       WHERE id = ?`
    )
      .bind(
        mileageIn,
        mileageIn,
        mileageIn,
        fuelIn,
        nextColour,
        nextServiceMileage,
        nextServiceMileage,
        existing.vehicle_id
      )
      .run();

    const completed = await fetchChecklistDetail(c.env.DB, checklistId);
    const hasInspectionDiffs = differences.some((d) => d.kind === 'item' || d.kind === 'sketch');

    await recordAudit(c.env.DB, {
      userId: actor.id,
      username: actor.username,
      userRole: actor.role,
      action: 'CHECKLIST_COMPLETED',
      entity: 'checklists',
      entityId: checklistId,
      newValue: {
        checklist_id: checklistId,
        reg_number: existing.reg_number,
        mileage_in: mileageIn,
        fuel_in: fuelIn,
        datetime_in: datetimeIn,
        differences_count: differences.length,
        has_inspection_differences: hasInspectionDiffs,
      },
      ip: getClientIp(c),
      userAgent: getUserAgent(c),
    });

    await notifyManagersInApp(
      c.env.DB,
      {
        eventType: 'CHECKLIST_COMPLETED',
        priority: hasInspectionDiffs ? 'HIGH' : 'NORMAL',
        title: `Vehicle Checklist Returned: ${existing.reg_number}${hasInspectionDiffs ? ' (Differences Noted)' : ''}`,
        body: `${actor.full_name} completed IN checklist #${checklistId} for ${existing.reg_number} at ${mileageIn.toLocaleString()} km.${hasInspectionDiffs ? ` ${differences.length} difference(s) flagged between OUT and IN.` : ''}`,
        tripId: existing.trip_id,
      },
      { env: c.env, roles: ['ADMIN', 'SUPERVISOR'] }
    );

    await checkAndNotifyVehicleServiceDues(c.env.DB, { env: c.env });

    return c.json({ checklist: completed });
  });

  // ---------------- ADMIN AMEND CHECKLIST ----------------
  app.patch(
    '/checklists/:id/amend',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const checklistId = Number(c.req.param('id'));
      if (!Number.isInteger(checklistId) || checklistId <= 0) {
        return c.json({ error: 'Invalid checklist ID.' }, 400);
      }

      const existing = await fetchChecklistDetail(c.env.DB, checklistId);
      if (!existing) {
        return c.json({ error: 'Checklist not found.' }, 404);
      }

      let body: {
        hirer_name?: string;
        representative?: string;
        cell?: string;
        colour?: string | null;
        hire_date?: string;
        days?: number;
        notes?: string;
        reason?: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid amendment payload.' }, 400);
      }

      const reason = String(body.reason || '').trim();
      if (reason.length < 4) {
        return c.json({ error: 'Provide an amendment reason (at least 4 characters).' }, 400);
      }

      const nextHirer = body.hirer_name !== undefined ? body.hirer_name.trim() : existing.hirer_name;
      const nextRep = body.representative !== undefined ? body.representative.trim() : existing.representative;
      const nextCell = body.cell !== undefined ? body.cell.trim() : existing.cell;
      const nextColour = body.colour !== undefined ? (body.colour ? body.colour.trim() : null) : existing.colour;
      const nextHireDate = body.hire_date !== undefined ? body.hire_date.trim() : existing.hire_date;
      const nextDays = body.days !== undefined ? Number(body.days) : existing.days;
      const nextNotes = body.notes !== undefined ? body.notes.trim() : existing.notes;

      if (nextHirer.length < 2) return c.json({ error: 'Hirer name is required.' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(nextHireDate)) {
        return c.json({ error: 'Hire date must be YYYY-MM-DD.' }, 400);
      }
      if (!Number.isInteger(nextDays) || nextDays < 1) {
        return c.json({ error: 'Days must be 1 or more.' }, 400);
      }
      const nextReturnDate = addDaysToYmd(nextHireDate, nextDays);

      await c.env.DB.prepare(
        `UPDATE checklists
         SET hirer_name = ?, representative = ?, cell = ?, colour = ?, hire_date = ?, days = ?, return_date = ?, notes = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      )
        .bind(nextHirer, nextRep, nextCell, nextColour, nextHireDate, nextDays, nextReturnDate, nextNotes, checklistId)
        .run();

      const updated = await fetchChecklistDetail(c.env.DB, checklistId);

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'CHECKLIST_AMENDED',
        entity: 'checklists',
        entityId: checklistId,
        oldValue: {
          hirer_name: existing.hirer_name,
          representative: existing.representative,
          cell: existing.cell,
          colour: existing.colour,
          hire_date: existing.hire_date,
          days: existing.days,
          notes: existing.notes,
        },
        newValue: {
          hirer_name: nextHirer,
          representative: nextRep,
          cell: nextCell,
          colour: nextColour,
          hire_date: nextHireDate,
          days: nextDays,
          notes: nextNotes,
          reason,
        },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ checklist: updated });
    }
  );

  // ---------------- ADMIN SOFT DELETE CHECKLIST ----------------
  app.delete(
    '/checklists/:id',
    requireAuth,
    requirePinChanged(),
    requireRole(['ADMIN']),
    async (c) => {
      const actor = c.get('user')!;
      const checklistId = Number(c.req.param('id'));
      if (!Number.isInteger(checklistId) || checklistId <= 0) {
        return c.json({ error: 'Invalid checklist ID.' }, 400);
      }

      const existing = await c.env.DB.prepare(
        'SELECT id, reg_number, hirer_name, status, deleted_at FROM checklists WHERE id = ?'
      )
        .bind(checklistId)
        .first<{ id: number; reg_number: string; hirer_name: string; status: string; deleted_at: string | null }>();

      if (!existing || existing.deleted_at) {
        return c.json({ error: 'Checklist not found.' }, 404);
      }

      const deletedAt = new Date().toISOString();
      await c.env.DB.prepare('UPDATE checklists SET deleted_at = ?, deleted_by = ? WHERE id = ?')
        .bind(deletedAt, actor.id, checklistId)
        .run();

      await recordAudit(c.env.DB, {
        userId: actor.id,
        username: actor.username,
        userRole: actor.role,
        action: 'CHECKLIST_SOFT_DELETED',
        entity: 'checklists',
        entityId: checklistId,
        oldValue: { reg_number: existing.reg_number, hirer_name: existing.hirer_name, status: existing.status },
        newValue: { deleted_at: deletedAt },
        ip: getClientIp(c),
        userAgent: getUserAgent(c),
      });

      return c.json({ ok: true, id: checklistId });
    }
  );

  // ---------------- CHECKLIST PDF EXPORT ----------------
  app.get('/checklists/:id/pdf', requireAuth, requirePinChanged(), async (c) => {
    const checklistId = Number(c.req.param('id'));
    if (!Number.isInteger(checklistId) || checklistId <= 0) {
      return c.json({ error: 'Invalid checklist ID.' }, 400);
    }
    const detail = await fetchChecklistDetail(c.env.DB, checklistId);
    if (!detail) {
      return c.json({ error: 'Checklist not found.' }, 404);
    }

    const settings = await getSettingsMap(c.env.DB);
    const sketchSummary: string[] = [
      `Silhouette: ${detail.sketch.vehicle_kind.toUpperCase()}`,
      `OUT: ${
        detail.sketch.no_damage_out
          ? 'No damage found (OUT)'
          : `${detail.sketch.pins_out.length} pin(s) [${detail.sketch.pins_out.map((p) => `#${p.number}(${p.type}${p.note ? `:${p.note}` : ''})`).join(', ')}], ${detail.sketch.strokes_out.length} freehand mark(s)`
      }`,
      `IN: ${
        detail.status === 'out'
          ? 'Pending return inspection'
          : detail.sketch.no_damage_in
            ? 'No new damage found (IN)'
            : `${detail.sketch.pins_in.length} pin(s) [${detail.sketch.pins_in.map((p) => `#${p.number}(${p.type}${p.note ? `:${p.note}` : ''})`).join(', ')}], ${detail.sketch.strokes_in.length} freehand mark(s)`
      }`,
    ];

    const sigsSummary = [
      {
        roleLabel: 'Renter / Driver (OUT)',
        name: detail.signatures.outRenter?.name || '',
        idNumber: detail.signatures.outRenter?.id_number || '',
        signedAt: detail.signatures.outRenter?.signed_at ? formatHarareTime(detail.signatures.outRenter.signed_at) : '',
      },
      {
        roleLabel: 'Company Rep (OUT)',
        name: detail.signatures.outCompany?.name || '',
        idNumber: detail.signatures.outCompany?.id_number || '',
        signedAt: detail.signatures.outCompany?.signed_at ? formatHarareTime(detail.signatures.outCompany.signed_at) : '',
      },
      {
        roleLabel: 'Renter / Driver (IN)',
        name: detail.signatures.inRenter?.name || '',
        idNumber: detail.signatures.inRenter?.id_number || '',
        signedAt: detail.signatures.inRenter?.signed_at ? formatHarareTime(detail.signatures.inRenter.signed_at) : '',
      },
      {
        roleLabel: 'Company Rep (IN)',
        name: detail.signatures.inCompany?.name || '',
        idNumber: detail.signatures.inCompany?.id_number || '',
        signedAt: detail.signatures.inCompany?.signed_at ? formatHarareTime(detail.signatures.inCompany.signed_at) : '',
      },
    ];

    const pdfBytes = buildChecklistPdf({
      companyName: settings.company_name,
      companyContact: settings.contact_numbers,
      companyAddress: settings.company_address,
      checklistId: detail.id,
      statusLabel: detail.status === 'completed' ? 'COMPLETED (RETURNED)' : 'OUT (OPEN)',
      hirerLabel: detail.hirer_type === 'owner' ? "Owner's Name" : "Renter's Name",
      hirerName: detail.hirer_name,
      representative: detail.representative,
      cell: detail.cell,
      carModel: detail.car_model,
      vehicleType: detail.vehicle_type,
      colour: detail.colour || '',
      regNumber: detail.reg_number,
      hireDate: detail.hire_date,
      days: detail.days,
      returnDate: detail.return_date,
      mileageOut: detail.mileage_out,
      mileageIn: detail.mileage_in,
      nextServiceMileage: detail.next_service_mileage,
      datetimeIn: detail.datetime_in ? formatHarareTime(detail.datetime_in) : '',
      fuelType: detail.fuel_type,
      fuelOut: detail.fuel_out || '',
      fuelIn: detail.fuel_in || '',
      items: detail.items.map((it, idx) => ({
        idx: idx + 1,
        label: it.custom_label,
        outText: formatItemValueText(it.input_type, it.value_out),
        inText: it.value_in ? formatItemValueText(it.input_type, it.value_in) : '-',
        note: it.note,
      })),
      differences: detail.differences.map((d) => ({
        label: d.label,
        outText: d.out_summary,
        inText: d.in_summary,
      })),
      sketchSummary,
      declarationText: detail.declaration_text || buildDeclarationText(settings.company_name),
      signaturesSummary: sigsSummary,
      generatedAt: formatHarareTime(new Date().toISOString()),
    });

    const cleanReg = detail.reg_number.toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'VEHICLE';
    const [yy, mm, dd] = detail.hire_date.split('-');
    const dateTag = yy && mm && dd ? `${dd}-${mm}-${yy.slice(-2)}` : detail.hire_date;
    const filename = `Checklist_${cleanReg}_${dateTag}.pdf`;
    return new Response(pdfBytes.slice().buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
