-- Fleet Secure — D1 (SQLite) Complete Schema
PRAGMA foreign_keys = ON;

-- 1. System Users (Drivers, Supervisors, Fleet Managers, Admins)
CREATE TABLE IF NOT EXISTS users (
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
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
-- idx_users_driver_id is created in ensureInitialSeed after additive ALTER TABLE migration

-- 2. Drivers Directory
CREATE TABLE IF NOT EXISTS drivers (
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

CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(active);
CREATE INDEX IF NOT EXISTS idx_drivers_licence_expiry ON drivers(licence_expiry);
-- idx_drivers_user_id is created in ensureInitialSeed after additive ALTER TABLE migration
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_licence_unique
  ON drivers(UPPER(licence_number))
  WHERE licence_number IS NOT NULL AND licence_number != '';

-- 3. Vehicles Directory
CREATE TABLE IF NOT EXISTS vehicles (
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
);

CREATE INDEX IF NOT EXISTS idx_vehicles_active ON vehicles(active);
CREATE INDEX IF NOT EXISTS idx_vehicles_condition ON vehicles(condition);

-- 4. Trips (Immutable header created on OUT, status transitions OPEN -> CLOSED on IN)
CREATE TABLE IF NOT EXISTS trips (
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_status ON trips(vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_driver_status ON trips(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips(created_at);

-- 5. Trip Out Records (Append-only, immutable)
CREATE TABLE IF NOT EXISTS trip_out (
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
);

-- 6. Trip In Records (Append-only, immutable)
CREATE TABLE IF NOT EXISTS trip_in (
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
);

-- 7. Corrections (Append-only supervisor/admin adjustment records; originals stay intact)
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_table TEXT NOT NULL CHECK (target_table IN ('trips', 'trip_out', 'trip_in')),
  target_id INTEGER NOT NULL,
  field_changes TEXT NOT NULL,
  reason TEXT NOT NULL,
  corrected_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_table, target_id);

-- 8. Audit Log (Append-only tamper-evident SHA-256 hash chain)
CREATE TABLE IF NOT EXISTS audit_log (
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
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

-- 9. System Settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 10. Notification Recipients
CREATE TABLE IF NOT EXISTS notification_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH')),
  destination TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_notif_recipients_active ON notification_recipients(active, channel);

-- 11. Notifications Inbox
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'HIGH')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  trip_id INTEGER REFERENCES trips(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_user_id, read_at, created_at);

-- 12. Login Rate Limit Tracking (D1-backed so it works across stateless edge workers)
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at TEXT NOT NULL,
  locked_until TEXT
);

-- 13. Vehicle Mechanical & Service History Logs
CREATE TABLE IF NOT EXISTS vehicle_maintenance_logs (
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
);

CREATE INDEX IF NOT EXISTS idx_maint_vehicle_date ON vehicle_maintenance_logs(vehicle_id, service_date);

-- 14. Garage Visits (Fleet Manager submits, Admin approves/rejects)
CREATE TABLE IF NOT EXISTS garage_visits (
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
);

CREATE INDEX IF NOT EXISTS idx_garage_vehicle ON garage_visits(vehicle_id, approval_status);

-- 15. Parts & Service Kits Purchase Requests (Fleet Manager submits, Admin authorizes)
CREATE TABLE IF NOT EXISTS parts_purchase_requests (
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
);

CREATE INDEX IF NOT EXISTS idx_parts_vehicle_status ON parts_purchase_requests(vehicle_id, status);

-- 16. Checklist Item Templates (Seeded 25 paper slip rows + admin-customizable)
CREATE TABLE IF NOT EXISTS checklist_item_templates (
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
);

CREATE INDEX IF NOT EXISTS idx_chk_tpl_active_order ON checklist_item_templates(active, sort_order);

-- 17. Digital Vehicle Checklists
CREATE TABLE IF NOT EXISTS checklists (
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
  days INTEGER NOT NULL CHECK (days >= 1),
  return_date TEXT NOT NULL,
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
);

CREATE INDEX IF NOT EXISTS idx_checklists_status ON checklists(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_checklists_reg ON checklists(reg_number, hire_date);
CREATE INDEX IF NOT EXISTS idx_checklists_vehicle ON checklists(vehicle_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checklists_trip ON checklists(trip_id);

-- 18. Checklist Inspection Items
CREATE TABLE IF NOT EXISTS checklist_items (
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
);

CREATE INDEX IF NOT EXISTS idx_checklist_items_parent ON checklist_items(checklist_id, sort_order);
