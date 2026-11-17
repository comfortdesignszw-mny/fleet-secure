-- Fleet Secure — D1 (SQLite) Complete Schema
PRAGMA foreign_keys = ON;

-- 1. System Users (Drivers, Supervisors, Admins)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'ADMIN')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);

-- 2. Drivers Directory
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  licence_number TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  licence_expiry TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(active);
CREATE INDEX IF NOT EXISTS idx_drivers_licence_expiry ON drivers(licence_expiry);

-- 3. Vehicles Directory
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  vehicle_type TEXT NOT NULL,
  vehicle_class TEXT NOT NULL CHECK (vehicle_class IN ('ECONOMY', 'HEAVY')),
  make_model TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'Good' CHECK (
    condition IN ('Very Good', 'Good', 'Needs Little Attention', 'Bad Condition', 'Accident', 'Grounded')
  ),
  last_known_mileage INTEGER NOT NULL DEFAULT 0 CHECK (last_known_mileage >= 0),
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
