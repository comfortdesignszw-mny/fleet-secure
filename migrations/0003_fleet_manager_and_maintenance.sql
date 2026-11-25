-- Migration 0003: Add FLEET_MANAGER role and fleet maintenance tables (D1-safe defer_foreign_keys pattern)
PRAGMA defer_foreign_keys = ON;

DROP TABLE IF EXISTS users_backup;
CREATE TABLE users_backup AS SELECT * FROM users;
DROP TABLE users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('DRIVER', 'SUPERVISOR', 'FLEET_MANAGER', 'ADMIN')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_pin INTEGER NOT NULL DEFAULT 1 CHECK (must_change_pin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO users (id, username, full_name, role, pin_hash, active, must_change_pin, created_at)
SELECT id, username, full_name, role, pin_hash, active, must_change_pin, created_at FROM users_backup;

DROP TABLE users_backup;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);

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

PRAGMA defer_foreign_keys = OFF;
