-- Migration 0002: Make driver licence optional and add driver certificate & document columns
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS drivers_migrated (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  licence_number TEXT,
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by INTEGER REFERENCES users(id)
);

INSERT INTO drivers_migrated (id, full_name, licence_number, phone, address, licence_expiry, active, created_at, created_by)
SELECT id, full_name, NULLIF(TRIM(licence_number), ''), phone, address, licence_expiry, active, created_at, created_by
FROM drivers;

DROP TABLE drivers;
ALTER TABLE drivers_migrated RENAME TO drivers;

CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers(active);
CREATE INDEX IF NOT EXISTS idx_drivers_licence_expiry ON drivers(licence_expiry);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_licence_unique
  ON drivers(UPPER(licence_number))
  WHERE licence_number IS NOT NULL AND licence_number != '';

PRAGMA foreign_keys = ON;
