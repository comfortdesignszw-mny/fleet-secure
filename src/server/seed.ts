import { DEFAULT_SETTINGS, VEHICLE_TYPE_TO_CLASS } from '../shared/types';
import { recordAudit } from './audit';
import { hashPin } from './crypto';
import type { AppEnv, D1DatabaseLike } from './types';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'FLEET_MANAGER', 'ADMIN')),
    pin_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
    driver_id INTEGER,
    temp_pin_enc TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  `CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active)`,
  `CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    licence_number TEXT,
    licence_code TEXT,
    phone TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    licence_expiry TEXT,
    licence_document TEXT,
    ddc_number TEXT,
    ddc_document TEXT,
    retest_cert_number TEXT,
    retest_document TEXT,
    medical_cert_number TEXT,
    medical_document TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by INTEGER REFERENCES users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(active)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_licence_expiry ON drivers(licence_expiry)`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reg_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    vehicle_type TEXT NOT NULL,
    vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY', 'HEAVY')),
    make_model TEXT NOT NULL,
    colour TEXT,
    fuel_type TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('diesel', 'petrol', 'ev')),
    condition TEXT NOT NULL DEFAULT 'Good' CHECK (
      condition IN ('Very Good', 'Good', 'Needs Little Attention', 'Bad Condition', 'Accident', 'Grounded')
    ),
    last_known_mileage INTEGER NOT NULL DEFAULT 0 CHECK (last_known_mileage >= 0),
    last_closing_mileage INTEGER,
    last_fuel_level TEXT,
    next_service_due_km INTEGER,
    next_service_mileage INTEGER,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vehicles_active ON vehicles(active)`,
  `CREATE INDEX IF NOT EXISTS idx_vehicles_condition ON vehicles(condition)`,
  `CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_type TEXT NOT NULL CHECK (trip_type IN ('HIRE', 'ERRAND')),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    driver_id INTEGER NOT NULL REFERENCES drivers(id),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
    client_name TEXT,
    destination TEXT,
    reason TEXT,
    days_hired INTEGER,
    expected_return_date TEXT,
    checklist_id INTEGER REFERENCES checklists(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_vehicle_status ON trips(vehicle_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_driver_status ON trips(driver_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at)`,
  `CREATE TABLE IF NOT EXISTS trip_out (
    trip_id INTEGER PRIMARY KEY REFERENCES trips(id),
    out_at TEXT NOT NULL,
    device_time TEXT,
    received_at TEXT NOT NULL,
    mileage_out INTEGER NOT NULL CHECK (mileage_out >= 0),
    fuel_out TEXT NOT NULL CHECK (
      fuel_out IN ('Full', 'Full-', '3/4+', '3/4', '3/4-', '1/2+', '1/2', '1/2-', '1/4+', '1/4', '1/4-', 'Empty+', 'Empty')
    ),
    opening_checklist_by TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    flags TEXT NOT NULL DEFAULT '[]',
    recorded_by INTEGER NOT NULL REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS trip_in (
    trip_id INTEGER PRIMARY KEY REFERENCES trips(id),
    in_at TEXT NOT NULL,
    device_time TEXT,
    received_at TEXT NOT NULL,
    mileage_in INTEGER NOT NULL CHECK (mileage_in >= 0),
    fuel_in TEXT NOT NULL CHECK (
      fuel_in IN ('Full', 'Full-', '3/4+', '3/4', '3/4-', '1/2+', '1/2', '1/2-', '1/4+', '1/4', '1/4-', 'Empty+', 'Empty')
    ),
    closing_checklist_by TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    total_mileage INTEGER NOT NULL CHECK (total_mileage >= 0),
    est_fuel_litres REAL NOT NULL,
    gauge_fuel_litres REAL NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_table TEXT NOT NULL CHECK (target_table IN ('trips', 'trip_out', 'trip_in')),
    target_id INTEGER NOT NULL,
    field_changes TEXT NOT NULL,
    reason TEXT NOT NULL,
    corrected_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_table, target_id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    username TEXT NOT NULL DEFAULT 'system',
    user_role TEXT NOT NULL DEFAULT 'SYSTEM',
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    old_json TEXT,
    new_json TEXT,
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH')),
    destination TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notif_recipients_active ON notification_recipients(active, channel)`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_user_id INTEGER NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'HIGH')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    trip_id INTEGER REFERENCES trips(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    read_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, read_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_attempt_at TEXT NOT NULL,
    locked_until TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS vehicle_maintenance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    record_type TEXT NOT NULL CHECK (record_type IN ('MECHANICAL', 'SERVICE')),
    service_date TEXT NOT NULL,
    odometer_km INTEGER NOT NULL CHECK (odometer_km >= 0),
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    workshop_name TEXT NOT NULL DEFAULT '',
    cost REAL,
    next_service_due_km INTEGER,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_maint_vehicle_date ON vehicle_maintenance_logs(vehicle_id, service_date)`,
  `CREATE TABLE IF NOT EXISTS garage_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    visit_date TEXT NOT NULL,
    workshop_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    odometer_km INTEGER NOT NULL CHECK (odometer_km >= 0),
    estimated_cost REAL,
    actual_cost REAL,
    approval_status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (
      approval_status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')
    ),
    visit_status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (
      visit_status IN ('SCHEDULED', 'IN_GARAGE', 'COMPLETED', 'CANCELLED')
    ),
    notes TEXT NOT NULL DEFAULT '',
    requested_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    approval_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_garage_vehicle ON garage_visits(vehicle_id, approval_status)`,
  `CREATE TABLE IF NOT EXISTS parts_purchase_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_date TEXT NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    parts_required TEXT NOT NULL,
    is_full_service_kit INTEGER NOT NULL DEFAULT 0 CHECK (is_full_service_kit IN (0, 1)),
    date_required TEXT NOT NULL,
    estimated_amount REAL NOT NULL CHECK (estimated_amount >= 0),
    quotation_file TEXT,
    quotation_filename TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING_ADMIN_AUTHORIZATION' CHECK (
      status IN ('PENDING_ADMIN_AUTHORIZATION', 'APPROVED', 'REJECTED', 'PURCHASED')
    ),
    admin_notes TEXT NOT NULL DEFAULT '',
    requested_by INTEGER REFERENCES users(id),
    authorized_by INTEGER REFERENCES users(id),
    authorized_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parts_vehicle_status ON parts_purchase_requests(vehicle_id, status)`,
  `CREATE TABLE IF NOT EXISTS checklist_item_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Inspection',
    input_type TEXT NOT NULL CHECK (
      input_type IN (
        'tick_cross',
        'status_pair',
        'yes_no',
        'text',
        'text_checkbox',
        'multi_check',
        'expiry_checks',
        'numbers',
        'available_na'
      )
    ),
    options_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chk_tpl_active_order ON checklist_item_templates(active, sort_order)`,
  `CREATE TABLE IF NOT EXISTS checklists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER REFERENCES trips(id),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'completed')),
    hirer_type TEXT NOT NULL CHECK (hirer_type IN ('renter', 'owner')),
    hirer_name TEXT NOT NULL,
    representative TEXT NOT NULL DEFAULT '',
    cell TEXT NOT NULL DEFAULT '',
    car_model TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,
    colour TEXT,
    reg_number TEXT NOT NULL,
    hire_date TEXT NOT NULL,
    days INTEGER CHECK (days IS NULL OR days >= 1),
    return_date TEXT,
    mileage_out INTEGER NOT NULL CHECK (mileage_out >= 0),
    mileage_out_diff_warning INTEGER NOT NULL DEFAULT 0 CHECK (mileage_out_diff_warning IN (0, 1)),
    previous_closing_mileage INTEGER,
    mileage_in INTEGER CHECK (mileage_in IS NULL OR mileage_in >= 0),
    next_service_mileage INTEGER,
    datetime_in TEXT,
    fuel_type TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('diesel', 'petrol', 'ev')),
    fuel_out TEXT,
    fuel_in TEXT,
    sketch_json TEXT NOT NULL DEFAULT '{}',
    sketch_png_data_url TEXT,
    signatures_json TEXT NOT NULL DEFAULT '{}',
    declaration_text TEXT NOT NULL DEFAULT '',
    differences_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    returned_by INTEGER REFERENCES users(id),
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_status ON checklists(status, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_reg ON checklists(reg_number, hire_date)`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_vehicle ON checklists(vehicle_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_checklists_trip ON checklists(trip_id)`,
  `CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    template_id INTEGER REFERENCES checklist_item_templates(id),
    custom_label TEXT NOT NULL,
    input_type TEXT NOT NULL CHECK (
      input_type IN (
        'tick_cross',
        'status_pair',
        'yes_no',
        'text',
        'text_checkbox',
        'multi_check',
        'expiry_checks',
        'numbers',
        'available_na'
      )
    ),
    options_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    value_out_json TEXT NOT NULL DEFAULT '{}',
    value_in_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    photo_data_url TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checklist_items_parent ON checklist_items(checklist_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS subhire_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
    checklist_id INTEGER REFERENCES checklists(id),
    subhirer_name TEXT NOT NULL,
    representative TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    received_mileage INTEGER NOT NULL CHECK (received_mileage >= 0),
    fuel_level TEXT NOT NULL CHECK (
      fuel_level IN ('Full', 'Full-', '3/4+', '3/4', '3/4-', '1/2+', '1/2', '1/2-', '1/4+', '1/4', '1/4-', 'Empty+', 'Empty')
    ),
    opening_checklist_by TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETURNED')),
    received_at TEXT NOT NULL,
    device_time TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subhires_vehicle ON subhire_receipts(vehicle_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_subhires_checklist ON subhire_receipts(checklist_id)`,
];

async function ensureSchemaTables(db: D1DatabaseLike): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run();
  }
}

let seedChecked = false;

export async function ensureUsersRoleConstraintAllowsFleetManager(
  db: D1DatabaseLike
): Promise<boolean> {
  try {
    const usersSchemaRow = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .first<{ sql: string }>();
    if (!usersSchemaRow?.sql) return false;
    if (usersSchemaRow.sql.includes('FLEET_MANAGER')) return true;

    const createUsersSql = `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'FLEET_MANAGER', 'ADMIN')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`;

    // Attempt 1: Cloudflare D1-compatible batch transaction using PRAGMA defer_foreign_keys = ON
    // Recreating `users` directly and re-inserting all rows decrements SQLite's deferred FK counter
    // back to 0 before COMMIT (unlike `ALTER TABLE RENAME`, which leaves deferred FK violations open).
    try {
      const statements = [
        db.prepare('PRAGMA defer_foreign_keys = ON'),
        db.prepare('DROP TABLE IF EXISTS users_backup'),
        db.prepare('CREATE TABLE users_backup AS SELECT * FROM users'),
        db.prepare('DROP TABLE users'),
        db.prepare(createUsersSql),
        db.prepare(
          `INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin, created_at)
           SELECT id, username, full_name, role, pin_hash, active, must_change_pin, created_at FROM users_backup`
        ),
        db.prepare('DROP TABLE users_backup'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active)'),
        db.prepare('PRAGMA defer_foreign_keys = OFF'),
      ];
      if (typeof db.batch === 'function') {
        await db.batch(statements);
      } else {
        await db.exec(`
          BEGIN IMMEDIATE;
          PRAGMA defer_foreign_keys = ON;
          DROP TABLE IF EXISTS users_backup;
          CREATE TABLE users_backup AS SELECT * FROM users;
          DROP TABLE users;
          ${createUsersSql};
          INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin, created_at)
          SELECT id, username, full_name, role, pin_hash, active, must_change_pin, created_at FROM users_backup;
          DROP TABLE users_backup;
          CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
          CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
          COMMIT;
        `);
      }
    } catch (batchErr) {
      try {
        await db.prepare('DROP TABLE IF EXISTS users_backup').run();
      } catch {
        // Ignore cleanup
      }

      // Attempt 2: Standard SQLite fallback using PRAGMA foreign_keys = OFF (e.g., if legacy rows had orphaned refs)
      try {
        await db.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TABLE IF EXISTS users_backup;
          CREATE TABLE users_backup AS SELECT * FROM users;
          DROP TABLE users;
          ${createUsersSql};
          INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin, created_at)
          SELECT id, username, full_name, role, pin_hash, active, must_change_pin, created_at FROM users_backup;
          DROP TABLE users_backup;
          CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
          CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
          PRAGMA foreign_keys = ON;
        `);
      } catch (fallbackErr) {
        try {
          await db.prepare('DROP TABLE IF EXISTS users_backup').run();
          await db.prepare('PRAGMA foreign_keys = ON').run();
        } catch {
          // Ignore cleanup
        }
        console.warn('Users CHECK constraint migration warning:', batchErr, fallbackErr);
      }
    }

    const verifiedRow = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .first<{ sql: string }>();
    return Boolean(verifiedRow?.sql?.includes('FLEET_MANAGER'));
  } catch {
    return false;
  }
}

export async function ensureInitialSeed(db: D1DatabaseLike, env: Partial<AppEnv>): Promise<void> {
  if (seedChecked) return;

  await ensureSchemaTables(db);

  // Ensure newer trip & vehicle columns exist on pre-existing databases
  try {
    const tripCols = await db.prepare('PRAGMA table_info(trips)').all<{ name: string }>();
    const colNames = new Set(tripCols.results.map((c) => c.name));
    if (!colNames.has('days_hired')) {
      await db.exec('ALTER TABLE trips ADD COLUMN days_hired INTEGER');
    }
    if (!colNames.has('expected_return_date')) {
      await db.exec('ALTER TABLE trips ADD COLUMN expected_return_date TEXT');
    }
    if (!colNames.has('checklist_id')) {
      await db.exec('ALTER TABLE trips ADD COLUMN checklist_id INTEGER');
    }
  } catch {
    // Ignore if table is freshly created from schema.sql
  }

  try {
    const vehicleCols = await db.prepare('PRAGMA table_info(vehicles)').all<{ name: string }>();
    const vColNames = new Set(vehicleCols.results.map((c) => c.name));
    if (!vColNames.has('next_service_due_km')) {
      await db.exec('ALTER TABLE vehicles ADD COLUMN next_service_due_km INTEGER');
    }
    if (!vColNames.has('colour')) {
      await db.exec('ALTER TABLE vehicles ADD COLUMN colour TEXT');
    }
    if (!vColNames.has('fuel_type')) {
      await db.exec("ALTER TABLE vehicles ADD COLUMN fuel_type TEXT NOT NULL DEFAULT 'petrol'");
    }
    if (!vColNames.has('next_service_mileage')) {
      await db.exec('ALTER TABLE vehicles ADD COLUMN next_service_mileage INTEGER');
    }
    if (!vColNames.has('last_closing_mileage')) {
      await db.exec('ALTER TABLE vehicles ADD COLUMN last_closing_mileage INTEGER');
    }
    if (!vColNames.has('last_fuel_level')) {
      await db.exec('ALTER TABLE vehicles ADD COLUMN last_fuel_level TEXT');
    }
  } catch {
    // Ignore if already exists
  }

  // Ensure checklists.days and checklists.return_date allow NULL (for Owner checklists)
  try {
    const chkCols = await db
      .prepare('PRAGMA table_info(checklists)')
      .all<{ name: string; notnull: number }>();
    const needsNullableMigration = chkCols.results.some(
      (col) => (col.name === 'days' || col.name === 'return_date') && Number(col.notnull) === 1
    );
    if (needsNullableMigration) {
      const createChecklistsSql = `CREATE TABLE checklists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER REFERENCES trips(id),
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        status TEXT NOT NULL DEFAULT 'out' CHECK (status IN ('out', 'completed')),
        hirer_type TEXT NOT NULL CHECK (hirer_type IN ('renter', 'owner')),
        hirer_name TEXT NOT NULL,
        representative TEXT NOT NULL DEFAULT '',
        cell TEXT NOT NULL DEFAULT '',
        car_model TEXT NOT NULL,
        vehicle_type TEXT NOT NULL,
        colour TEXT,
        reg_number TEXT NOT NULL,
        hire_date TEXT NOT NULL,
        days INTEGER CHECK (days IS NULL OR days >= 1),
        return_date TEXT,
        mileage_out INTEGER NOT NULL CHECK (mileage_out >= 0),
        mileage_out_diff_warning INTEGER NOT NULL DEFAULT 0 CHECK (mileage_out_diff_warning IN (0, 1)),
        previous_closing_mileage INTEGER,
        mileage_in INTEGER CHECK (mileage_in IS NULL OR mileage_in >= 0),
        next_service_mileage INTEGER,
        datetime_in TEXT,
        fuel_type TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('diesel', 'petrol', 'ev')),
        fuel_out TEXT,
        fuel_in TEXT,
        sketch_json TEXT NOT NULL DEFAULT '{}',
        sketch_png_data_url TEXT,
        signatures_json TEXT NOT NULL DEFAULT '{}',
        declaration_text TEXT NOT NULL DEFAULT '',
        differences_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_by INTEGER NOT NULL REFERENCES users(id),
        returned_by INTEGER REFERENCES users(id),
        deleted_at TEXT,
        deleted_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`;
      const createItemsSql = `CREATE TABLE checklist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        template_id INTEGER REFERENCES checklist_item_templates(id),
        custom_label TEXT NOT NULL,
        input_type TEXT NOT NULL CHECK (
          input_type IN (
            'tick_cross',
            'status_pair',
            'yes_no',
            'text',
            'text_checkbox',
            'multi_check',
            'expiry_checks',
            'numbers',
            'available_na'
          )
        ),
        options_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        value_out_json TEXT NOT NULL DEFAULT '{}',
        value_in_json TEXT,
        note TEXT NOT NULL DEFAULT '',
        photo_data_url TEXT
      )`;

      await db.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE IF EXISTS checklist_items_backup;
        DROP TABLE IF EXISTS checklists_backup;
        CREATE TABLE checklists_backup AS SELECT * FROM checklists;
        CREATE TABLE checklist_items_backup AS SELECT * FROM checklist_items;
        DROP TABLE checklist_items;
        DROP TABLE checklists;
        ${createChecklistsSql};
        ${createItemsSql};
        INSERT INTO checklists (
          id, trip_id, vehicle_id, status, hirer_type, hirer_name, representative, cell,
          car_model, vehicle_type, colour, reg_number, hire_date, days, return_date,
          mileage_out, mileage_out_diff_warning, previous_closing_mileage, mileage_in,
          next_service_mileage, datetime_in, fuel_type, fuel_out, fuel_in,
          sketch_json, sketch_png_data_url, signatures_json, declaration_text, differences_json,
          notes, created_by, returned_by, deleted_at, deleted_by, created_at, updated_at
        )
        SELECT
          id, trip_id, vehicle_id, status, hirer_type, hirer_name, representative, cell,
          car_model, vehicle_type, colour, reg_number, hire_date, days, return_date,
          mileage_out, mileage_out_diff_warning, previous_closing_mileage, mileage_in,
          next_service_mileage, datetime_in, fuel_type, fuel_out, fuel_in,
          sketch_json, sketch_png_data_url, signatures_json, declaration_text, differences_json,
          notes, created_by, returned_by, deleted_at, deleted_by, created_at, updated_at
        FROM checklists_backup;
        INSERT INTO checklist_items (
          id, checklist_id, template_id, custom_label, input_type, options_json,
          sort_order, value_out_json, value_in_json, note, photo_data_url
        )
        SELECT
          id, checklist_id, template_id, custom_label, input_type, options_json,
          sort_order, value_out_json, value_in_json, note, photo_data_url
        FROM checklist_items_backup;
        DROP TABLE checklist_items_backup;
        DROP TABLE checklists_backup;
        CREATE INDEX IF NOT EXISTS idx_checklists_status ON checklists(status, deleted_at);
        CREATE INDEX IF NOT EXISTS idx_checklists_reg ON checklists(reg_number, hire_date);
        CREATE INDEX IF NOT EXISTS idx_checklists_vehicle ON checklists(vehicle_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_checklists_trip ON checklists(trip_id);
        CREATE INDEX IF NOT EXISTS idx_checklist_items_parent ON checklist_items(checklist_id, sort_order);
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch (chkMigErr) {
    try {
      await db.prepare('PRAGMA foreign_keys = ON').run();
    } catch {
      // Ignore cleanup
    }
    console.warn('Checklists nullable migration warning:', chkMigErr);
  }

  // Ensure users table CHECK constraint allows FLEET_MANAGER on pre-existing databases
  const usersRoleMigrated = await ensureUsersRoleConstraintAllowsFleetManager(db);

  // Ensure additive credential-handoff columns exist on users
  try {
    const userCols = await db.prepare('PRAGMA table_info(users)').all<{ name: string }>();
    const uColNames = new Set(userCols.results.map((c) => c.name));
    if (!uColNames.has('driver_id')) {
      await db.prepare('ALTER TABLE users ADD COLUMN driver_id INTEGER').run();
    }
    if (!uColNames.has('temp_pin_enc')) {
      await db.prepare('ALTER TABLE users ADD COLUMN temp_pin_enc TEXT').run();
    }
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_driver_id ON users(driver_id)').run();
  } catch {
    // Ignore if already exists
  }

  // Ensure drivers table has all certificate/document columns and supports optional licence_number
  try {
    const driverCols = await db
      .prepare('PRAGMA table_info(drivers)')
      .all<{ name: string; notnull: number }>();
    const licenceCol = driverCols.results.find((c) => c.name === 'licence_number');
    const driverColNames = new Set(driverCols.results.map((c) => c.name));

    // Step 1: Always add missing nullable columns individually first.
    // On Cloudflare D1, ALTER TABLE ADD COLUMN succeeds even when trips holds FK references to drivers.
    const extraCols: Array<[string, string]> = [
      ['licence_code', 'TEXT'],
      ['licence_document', 'TEXT'],
      ['ddc_number', 'TEXT'],
      ['ddc_document', 'TEXT'],
      ['retest_cert_number', 'TEXT'],
      ['retest_document', 'TEXT'],
      ['medical_cert_number', 'TEXT'],
      ['medical_document', 'TEXT'],
      ['user_id', 'INTEGER REFERENCES users(id)'],
    ];
    for (const [col, colType] of extraCols) {
      if (!driverColNames.has(col)) {
        try {
          await db.prepare(`ALTER TABLE drivers ADD COLUMN ${col} ${colType}`).run();
        } catch {
          // Ignore if column was added concurrently
        }
      }
    }

    // Step 2: If legacy schema still has licence_number NOT NULL, attempt table rebuild.
    // If Cloudflare D1 blocks DROP TABLE drivers due to trips FK, catch cleanly and fall back
    // to sentinel handling in routes while keeping all newly added columns intact.
    if (licenceCol && Number(licenceCol.notnull) === 1) {
      try {
        await db.prepare('DROP TABLE IF EXISTS drivers_migrated').run();
        await db.exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE drivers_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            licence_number TEXT,
            licence_code TEXT,
            phone TEXT NOT NULL,
            address TEXT NOT NULL DEFAULT '',
            licence_expiry TEXT,
            licence_document TEXT,
            ddc_number TEXT,
            ddc_document TEXT,
            retest_cert_number TEXT,
            retest_document TEXT,
            medical_cert_number TEXT,
            medical_document TEXT,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            user_id INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            created_by INTEGER REFERENCES users(id)
          );
          INSERT INTO drivers_migrated (
            id, full_name, licence_number, licence_code, phone, address, licence_expiry,
            licence_document, ddc_number, ddc_document,
            retest_cert_number, retest_document,
            medical_cert_number, medical_document,
            active, user_id, created_at, created_by
          )
          SELECT
            id, full_name, NULLIF(TRIM(licence_number), ''), licence_code, phone, address, licence_expiry,
            licence_document, ddc_number, ddc_document,
            retest_cert_number, retest_document,
            medical_cert_number, medical_document,
            active, user_id, created_at, created_by
          FROM drivers;
          DROP TABLE drivers;
          ALTER TABLE drivers_migrated RENAME TO drivers;
          PRAGMA foreign_keys = ON;
        `);
      } catch (err) {
        try {
          await db.prepare('DROP TABLE IF EXISTS drivers_migrated').run();
        } catch {
          // ignore cleanup failure
        }
        try {
          await db.prepare('PRAGMA foreign_keys = ON').run();
        } catch {
          // ignore pragma failure
        }
        console.warn('Skipping drivers NOT NULL rebuild; using sentinel fallback:', err);
      }
    }

    // Step 3: Ensure indexes exist independently of rebuild outcome
    const driverIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(active)',
      'CREATE INDEX IF NOT EXISTS idx_drivers_licence_expiry ON drivers(licence_expiry)',
      'CREATE INDEX IF NOT EXISTS idx_drivers_user_id ON drivers(user_id)',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_licence_unique ON drivers(UPPER(licence_number)) WHERE licence_number IS NOT NULL AND licence_number != ''",
    ];
    for (const idxSql of driverIndexes) {
      try {
        await db.prepare(idxSql).run();
      } catch {
        // Ignore if index already exists or cannot be altered
      }
    }
  } catch (err) {
    console.warn('Driver schema migration check warning:', err);
  }

  // Ensure all default settings keys exist
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  // Seed default 25 paper slip checklist item templates
  await seedDefaultChecklistTemplates(db);

  // Ensure at least one user exists; seed initial Admin from env
  const countRow = await db.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>();
  if ((countRow?.cnt ?? 0) === 0) {
    const username = (env.INITIAL_ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const initialPin = env.INITIAL_ADMIN_PIN || '1234';
    const fullName = env.INITIAL_ADMIN_NAME || 'Fleet Administrator';
    const pinHash = await hashPin(initialPin);

    const res = await db
      .prepare(
        `INSERT INTO users (username, full_name, role, pin_hash, active, must_change_pin)
         VALUES (?, ?, 'ADMIN', ?, 1, 1)`
      )
      .bind(username, fullName, pinHash)
      .run();

    await db
      .prepare(
        `INSERT INTO notification_recipients (user_id, channel, destination, active)
         VALUES (?, 'IN_APP', '', 1)`
      )
      .bind(res.meta.last_row_id)
      .run();

    await recordAudit(db, {
      userId: res.meta.last_row_id,
      username,
      userRole: 'SYSTEM',
      action: 'SYSTEM_SEED_ADMIN',
      entity: 'users',
      entityId: res.meta.last_row_id,
      newValue: { username, full_name: fullName, role: 'ADMIN', must_change_pin: true },
    });
  }

  if (usersRoleMigrated) {
    seedChecked = true;
  }
}

export interface DemoSeedCounts {
  vehiclesAdded: number;
  driversAdded: number;
  tripsAdded: number;
}

export async function seedPreviewDemoData(
  db: D1DatabaseLike,
  actorId: number | null = null
): Promise<DemoSeedCounts> {
  const vehicles = [
    { reg: 'AFX 1024', type: 'Sedan', make: 'Toyota Corolla Quest', cond: 'Very Good', km: 42310 },
    { reg: 'AFX 1025', type: 'Hatchback', make: 'Honda Fit Hybrid', cond: 'Good', km: 68190 },
    { reg: 'AFY 2210', type: 'Mini SUV', make: 'Suzuki Vitara Brezza', cond: 'Very Good', km: 28400 },
    { reg: 'AFZ 3340', type: 'Double Cab', make: 'Toyota Hilux GD-6 4x4', cond: 'Good', km: 94120 },
    { reg: 'AGA 4102', type: 'Double Cab', make: 'Ford Ranger Wildtrak', cond: 'Needs Little Attention', km: 112500 },
    { reg: 'AGB 5518', type: 'SUV', make: 'Toyota Fortuner 2.8', cond: 'Very Good', km: 51200 },
    { reg: 'AGC 6091', type: 'Executive Sedan', make: 'Mercedes-Benz C200', cond: 'Good', km: 63900 },
    { reg: 'AGD 7712', type: 'Quantum', make: 'Toyota Quantum 14-Seater', cond: 'Good', km: 148300 },
    { reg: 'AGE 8804', type: 'Truck', make: 'Isuzu NPR 4-Ton', cond: 'Bad Condition', km: 210450 },
    { reg: 'AGF 9001', type: 'Sedan', make: 'Nissan Almera', cond: 'Grounded', km: 135800 },
  ];

  let vehiclesAdded = 0;
  for (const v of vehicles) {
    const vClass = VEHICLE_TYPE_TO_CLASS[v.type];
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO vehicles (reg_number, vehicle_type, vehicle_class, make_model, condition, last_known_mileage, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .bind(v.reg, v.type, vClass, v.make, v.cond, v.km)
      .run();
    vehiclesAdded += res.meta.changes ?? 0;
  }

  const now = new Date();
  const plusDays = (days: number) =>
    new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

  const drivers = [
    { name: 'Tendai Moyo', lic: 'ZW-884120', phone: '+263 77 234 5510', addr: '12 Fife Ave, Harare', exp: plusDays(320) },
    { name: 'Tatenda Ncube', lic: 'ZW-773190', phone: '+263 71 845 9012', addr: '45 Lobengula St, Bulawayo', exp: plusDays(18) },
    { name: 'Farai Chikwanda', lic: 'ZW-662019', phone: '+263 77 901 3344', addr: '8 Borrowdale Rd, Harare', exp: plusDays(540) },
    { name: 'Rumbidzai Gumbo', lic: 'ZW-559812', phone: '+263 78 412 8821', addr: '29 Josiah Tongogara, Harare', exp: plusDays(-5) },
    { name: 'Kudakwashe Sibanda', lic: 'ZW-441209', phone: '+263 77 512 1190', addr: '101 Churchill Ave, Harare', exp: plusDays(190) },
    { name: 'Blessing Ndlovu', lic: 'ZW-330918', phone: '+263 71 399 4401', addr: '19 Leopold Takawira, Harare', exp: plusDays(25) },
    { name: 'Nyasha Mutasa', lic: 'ZW-229104', phone: '+263 77 620 7788', addr: '53 Samora Machel Ave, Harare', exp: plusDays(410) },
    { name: 'Tafadzwa Dube', lic: 'ZW-118403', phone: '+263 78 730 9955', addr: '7 Enterprise Rd, Harare', exp: null },
  ];

  let driversAdded = 0;
  for (const d of drivers) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO drivers (full_name, licence_number, phone, address, licence_expiry, active, created_by)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(d.name, d.lic, d.phone, d.addr, d.exp, actorId)
      .run();
    driversAdded += res.meta.changes ?? 0;
  }

  // Seed 2 realistic sample trips only if there are no trips yet
  let tripsAdded = 0;
  const tripCountRow = await db.prepare('SELECT COUNT(*) as cnt FROM trips').first<{ cnt: number }>();
  if ((tripCountRow?.cnt ?? 0) === 0) {
    let recorderId = actorId;
    if (!recorderId) {
      const adminRow = await db
        .prepare("SELECT id FROM users WHERE active = 1 ORDER BY id ASC LIMIT 1")
        .first<{ id: number }>();
      recorderId = adminRow?.id ?? null;
    }

    const sedan = await db
      .prepare("SELECT id, last_known_mileage FROM vehicles WHERE reg_number = 'AFX 1024'")
      .first<{ id: number; last_known_mileage: number }>();
    const hilux = await db
      .prepare("SELECT id, last_known_mileage FROM vehicles WHERE reg_number = 'AFZ 3340'")
      .first<{ id: number; last_known_mileage: number }>();
    const driver1 = await db
      .prepare("SELECT id FROM drivers WHERE licence_number = 'ZW-884120'")
      .first<{ id: number }>();
    const driver2 = await db
      .prepare("SELECT id FROM drivers WHERE licence_number = 'ZW-662019'")
      .first<{ id: number }>();

    if (recorderId && sedan && driver1) {
      const outTime = new Date(now.getTime() - 26 * 3_600_000).toISOString();
      const inTime = new Date(now.getTime() - 4 * 3_600_000).toISOString();
      const startKm = Math.max(0, Number(sedan.last_known_mileage) - 180);
      const endKm = Number(sedan.last_known_mileage);

      const t1 = await db
        .prepare(
          `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, client_name, created_at)
           VALUES ('HIRE', ?, ?, 'CLOSED', 'Harare Logistics Pvt', ?)`
        )
        .bind(sedan.id, driver1.id, outTime)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_out (trip_id, out_at, device_time, received_at, mileage_out, fuel_out, opening_checklist_by, notes, flags, recorded_by)
           VALUES (?, ?, ?, ?, ?, '3/4', 'Yard Supervisor', 'Client corporate day hire — spare wheel & jack verified', '[]', ?)`
        )
        .bind(t1.meta.last_row_id, outTime, outTime, outTime, startKm, recorderId)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_in (trip_id, in_at, device_time, received_at, mileage_in, fuel_in, closing_checklist_by, notes, recorded_by, total_mileage, est_fuel_litres, gauge_fuel_litres, flags)
           VALUES (?, ?, ?, ?, ?, '1/2', 'Yard Supervisor', 'Returned clean with no body damage', ?, 180, 18.0, 15.0, '[]')`
        )
        .bind(t1.meta.last_row_id, inTime, inTime, inTime, endKm, recorderId)
        .run();

      tripsAdded += 1;
    }

    if (recorderId && hilux && driver2) {
      const outTime = new Date(now.getTime() - 2 * 3_600_000).toISOString();
      const t2 = await db
        .prepare(
          `INSERT INTO trips (trip_type, vehicle_id, driver_id, status, destination, reason, created_at)
           VALUES ('ERRAND', ?, ?, 'OPEN', 'CBD Licensing Office', 'ZINARA & vehicle fitness disc renewal', ?)`
        )
        .bind(hilux.id, driver2.id, outTime)
        .run();

      await db
        .prepare(
          `INSERT INTO trip_out (trip_id, out_at, device_time, received_at, mileage_out, fuel_out, opening_checklist_by, notes, flags, recorded_by)
           VALUES (?, ?, ?, ?, ?, '1/2+', 'Yard Supervisor', 'Sample open trip ready for testing Return Errand flow', '[]', ?)`
        )
        .bind(t2.meta.last_row_id, outTime, outTime, outTime, Number(hilux.last_known_mileage), recorderId)
        .run();

      tripsAdded += 1;
    }
  }

  return { vehiclesAdded, driversAdded, tripsAdded };
}

const DEFAULT_CHECKLIST_TEMPLATES: ReadonlyArray<{
  code: string;
  label: string;
  category: string;
  input_type: string;
  options: string[];
  sort_order: number;
}> = [
  { code: 'spare_wheel', label: 'Spare Wheel', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 1 },
  { code: 'jack', label: 'Jack', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 2 },
  { code: 'wheel_spanner', label: 'Wheel Spanner', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 3 },
  { code: 'lock_nut', label: 'Lock Nut / Wheel Key', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 4 },
  { code: 'emergency_triangle', label: 'Emergency Triangle', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 5 },
  { code: 'fire_extinguisher', label: 'Fire Extinguisher', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 6 },
  { code: 'reflector_vest', label: 'Reflector Vest', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 7 },
  { code: 'first_aid_kit', label: 'First Aid Kit', category: 'Tools & Safety', input_type: 'tick_cross', options: [], sort_order: 8 },
  { code: 'headlights', label: 'Headlights', category: 'Lights & Electrical', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 9 },
  { code: 'indicators_hazards', label: 'Indicators & Hazard Lights', category: 'Lights & Electrical', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 10 },
  { code: 'brake_reverse_lights', label: 'Brake & Reverse Lights', category: 'Lights & Electrical', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 11 },
  { code: 'air_conditioning', label: 'Air Conditioning', category: 'Cabin & Controls', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 12 },
  { code: 'radio_bluetooth', label: 'Radio / Bluetooth', category: 'Cabin & Controls', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 13 },
  { code: 'wipers_washer', label: 'Wipers & Washer', category: 'Cabin & Controls', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 14 },
  { code: 'horn', label: 'Horn', category: 'Cabin & Controls', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 15 },
  { code: 'seatbelts', label: 'Seatbelts', category: 'Cabin & Controls', input_type: 'status_pair', options: ['Working', 'Faulty'], sort_order: 16 },
  { code: 'spare_key', label: 'Spare Key Provided', category: 'Keys & Docs', input_type: 'yes_no', options: ['Yes', 'No'], sort_order: 17 },
  { code: 'body_interior_condition', label: 'Vehicle Condition Inside & Outside', category: 'General Condition', input_type: 'text', options: [], sort_order: 18 },
  { code: 'fuel_tank_cap', label: 'Fuel Tank Cap', category: 'Exterior', input_type: 'available_na', options: ['Available', 'N/A'], sort_order: 19 },
  { code: 'floor_mats', label: 'Floor Mats', category: 'Interior', input_type: 'numbers', options: ['Rubber Mats', 'Carpet Mats'], sort_order: 20 },
  { code: 'wheel_caps_rims', label: 'Wheel Caps / Alloy Rims', category: 'Wheels & Tyres', input_type: 'text_checkbox', options: ['All 4 Intact', 'Scuffed', 'Missing Cap'], sort_order: 21 },
  { code: 'tyres_condition', label: 'Tyres Condition', category: 'Wheels & Tyres', input_type: 'multi_check', options: ['Good Tread', 'Worn', 'Spare Good', 'Pressure OK'], sort_order: 22 },
  { code: 'windscreen_mirrors', label: 'Windscreen & Mirrors', category: 'Exterior', input_type: 'multi_check', options: ['Clean / No Cracks', 'Chipped', 'Cracked', 'Mirrors OK'], sort_order: 23 },
  { code: 'licences_discs', label: 'Vehicle Licences & Discs', category: 'Keys & Docs', input_type: 'expiry_checks', options: ['ZINARA Disc', 'ZBC Radio Licence', 'Insurance Disc'], sort_order: 24 },
  { code: 'service_book_manual', label: 'Service Book & Owner Manual', category: 'Keys & Docs', input_type: 'available_na', options: ['Available', 'N/A'], sort_order: 25 },
];

export async function seedDefaultChecklistTemplates(db: D1DatabaseLike): Promise<void> {
  for (const tpl of DEFAULT_CHECKLIST_TEMPLATES) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO checklist_item_templates (code, label, category, input_type, options_json, sort_order, is_default, active)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`
      )
      .bind(tpl.code, tpl.label, tpl.category, tpl.input_type, JSON.stringify(tpl.options), tpl.sort_order)
      .run();
  }
}

export function resetSeedCacheForTests(): void {
  seedChecked = false;
}

