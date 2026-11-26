-- Migration 0004: Driver temporary credential handoff columns, vehicle checklist metadata, and Checklists module tables
-- All alterations are additive so existing SQLite / Cloudflare D1 foreign keys remain intact.

-- 1. Staff <-> Driver linkage & encrypted temporary PIN handoff
ALTER TABLE users ADD COLUMN driver_id INTEGER REFERENCES drivers(id);
ALTER TABLE users ADD COLUMN temp_pin_enc TEXT;
CREATE INDEX IF NOT EXISTS idx_users_driver_id ON users(driver_id);

ALTER TABLE drivers ADD COLUMN user_id INTEGER REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_drivers_user_id ON drivers(user_id);

-- 2. Additional vehicle fields reused by Checklists
ALTER TABLE vehicles ADD COLUMN colour TEXT;
ALTER TABLE vehicles ADD COLUMN fuel_type TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('diesel', 'petrol', 'ev'));
ALTER TABLE vehicles ADD COLUMN next_service_mileage INTEGER;
ALTER TABLE vehicles ADD COLUMN last_closing_mileage INTEGER;
ALTER TABLE vehicles ADD COLUMN last_fuel_level TEXT;

-- 3. Checklist Item Templates (25 standard inspection items + admin-added defaults)
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

-- 4. Digital Vehicle Checklists (OUT -> IN lifecycle)
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

-- 5. Individual Checklist Rows (OUT & IN snapshots + optional notes & photo)
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
