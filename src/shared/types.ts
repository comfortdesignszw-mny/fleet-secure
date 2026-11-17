export type Role = 'DRIVER' | 'SUPERVISOR' | 'ADMIN';

export const ROLES: readonly Role[] = ['DRIVER', 'SUPERVISOR', 'ADMIN'] as const;

export const ROLE_LABELS: Record<Role, string> = {
  DRIVER: 'Driver',
  SUPERVISOR: 'Supervisor (Loss Control)',
  ADMIN: 'Admin',
};

export const FUEL_LEVELS = [
  'Full',
  'Full-',
  '3/4+',
  '3/4',
  '3/4-',
  '1/2+',
  '1/2',
  '1/2-',
  '1/4+',
  '1/4',
  '1/4-',
  'Empty+',
  'Empty',
] as const;

export type FuelLevel = (typeof FUEL_LEVELS)[number];

export const FUEL_FRACTIONS: Record<FuelLevel, number> = {
  Full: 1.0,
  'Full-': 0.94,
  '3/4+': 0.83,
  '3/4': 0.75,
  '3/4-': 0.67,
  '1/2+': 0.58,
  '1/2': 0.5,
  '1/2-': 0.42,
  '1/4+': 0.33,
  '1/4': 0.25,
  '1/4-': 0.17,
  'Empty+': 0.08,
  Empty: 0.0,
};

export type VehicleClass = 'ECONOMY' | 'HEAVY';

export const VEHICLE_TYPE_TO_CLASS: Record<string, VehicleClass> = {
  Sedan: 'ECONOMY',
  Hatchback: 'ECONOMY',
  'Mini SUV': 'ECONOMY',
  'Double Cab': 'HEAVY',
  SUV: 'HEAVY',
  Truck: 'HEAVY',
  'Executive Sedan': 'HEAVY',
  Kombi: 'HEAVY',
  Quantum: 'HEAVY',
  Bus: 'HEAVY',
};

export const VEHICLE_TYPES = Object.keys(VEHICLE_TYPE_TO_CLASS);

export const VEHICLE_CONDITIONS = [
  'Very Good',
  'Good',
  'Needs Little Attention',
  'Bad Condition',
  'Accident',
  'Grounded',
] as const;

export type VehicleCondition = (typeof VEHICLE_CONDITIONS)[number];

export interface UserPublic {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  active: boolean;
  must_change_pin: boolean;
  created_at: string;
}

export interface AuditLogEntry {
  id: number;
  ts: string;
  user_id: number | null;
  username: string;
  user_role: string;
  action: string;
  entity: string;
  entity_id: string;
  old_json: string | null;
  new_json: string | null;
  ip: string;
  user_agent: string;
  prev_hash: string;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  totalRows: number;
  checkedAt: string;
  brokenRowId?: number;
  reason?: string;
}

export interface AppSettings {
  company_name: string;
  contact_numbers: string;
  company_address: string;
  economy_tank_litres: string;
  economy_km_per_litre: string;
  heavy_tank_litres: string;
  heavy_km_per_litre: string;
  fuel_mismatch_threshold_pct: string;
  overdue_hire_hours: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  company_name: 'Fleet Secure Rentals',
  contact_numbers: '+263 242 000 000',
  company_address: 'Harare, Zimbabwe',
  economy_tank_litres: '60',
  economy_km_per_litre: '10',
  heavy_tank_litres: '80',
  heavy_km_per_litre: '8',
  fuel_mismatch_threshold_pct: '25',
  overdue_hire_hours: '24',
};

export type DerivedStatus = 'Available' | 'Out on Hire' | 'Out on Errand';

export type LicenceStatus = 'NONE' | 'OK' | 'EXPIRING_SOON' | 'EXPIRED';

export interface Vehicle {
  id: number;
  reg_number: string;
  vehicle_type: string;
  vehicle_class: VehicleClass;
  make_model: string;
  condition: VehicleCondition;
  last_known_mileage: number;
  active: boolean;
  created_at: string;
  derived_status: DerivedStatus;
  open_trip_id: number | null;
  trip_count?: number;
  total_trip_mileage?: number;
}

export interface Driver {
  id: number;
  full_name: string;
  licence_number: string;
  phone: string;
  address: string;
  licence_expiry: string | null;
  active: boolean;
  created_at: string;
  created_by: number | null;
  derived_status: DerivedStatus;
  open_trip_id: number | null;
  licence_status: LicenceStatus;
  days_to_expiry: number | null;
}

export type TripType = 'HIRE' | 'ERRAND';
export type TripStatus = 'OPEN' | 'CLOSED';

export interface TripFlag {
  code: 'UNRECORDED_GAP' | 'FUEL_MISMATCH' | 'OVERDUE' | 'OFFLINE_DELAY' | 'LICENCE_EXPIRING';
  severity: 'WARN' | 'HIGH';
  message: string;
  meta?: Record<string, unknown>;
}

export interface TripOutRecord {
  trip_id: number;
  out_at: string;
  device_time: string | null;
  received_at: string;
  mileage_out: number;
  fuel_out: FuelLevel;
  opening_checklist_by: string;
  notes: string;
  flags: TripFlag[];
  recorded_by: number;
  recorded_by_name?: string;
}

export interface TripInRecord {
  trip_id: number;
  in_at: string;
  device_time: string | null;
  received_at: string;
  mileage_in: number;
  fuel_in: FuelLevel;
  closing_checklist_by: string;
  notes: string;
  recorded_by: number;
  recorded_by_name?: string;
  total_mileage: number;
  est_fuel_litres: number;
  gauge_fuel_litres: number;
  flags: TripFlag[];
}

export interface TripCorrection {
  id: number;
  target_table: 'trips' | 'trip_out' | 'trip_in';
  target_id: number;
  field_changes: Record<string, unknown>;
  reason: string;
  corrected_by: number;
  corrected_by_name?: string;
  created_at: string;
}

export interface TripSummary {
  id: number;
  trip_type: TripType;
  vehicle_id: number;
  driver_id: number;
  status: TripStatus;
  client_name: string | null;
  destination: string | null;
  reason: string | null;
  created_at: string;
  reg_number: string;
  make_model: string;
  vehicle_type: string;
  vehicle_class: VehicleClass;
  driver_name: string;
  driver_phone: string;
  out_at: string;
  mileage_out: number;
  fuel_out: FuelLevel;
  in_at: string | null;
  mileage_in: number | null;
  fuel_in: FuelLevel | null;
  total_mileage: number | null;
  est_fuel_litres: number | null;
  gauge_fuel_litres: number | null;
  flags: TripFlag[];
  correction_count: number;
  is_overdue: boolean;
}

export interface TripDetail {
  trip: TripSummary;
  out: TripOutRecord;
  inRecord: TripInRecord | null;
  corrections: TripCorrection[];
}

export interface DashboardVehicleStat {
  vehicle_id: number;
  reg_number: string;
  make_model: string;
  vehicle_type: string;
  vehicle_class: VehicleClass;
  trip_count: number;
  total_mileage: number;
  est_fuel_litres: number;
  gauge_fuel_litres: number;
  flagged_trips: number;
}

export interface DashboardDailyTrip {
  date: string;
  hire_count: number;
  errand_count: number;
  total: number;
}

export interface DashboardData {
  range: { from: string; to: string };
  cards: {
    out_on_hire: number;
    out_on_errand: number;
    available_vehicles: number;
    total_fleet: number;
    total_drivers: number;
    trips_today: number;
    mileage_this_month: number;
    est_fuel_this_month: number;
    flagged_trips: number;
    overdue_hires: number;
  };
  vehicle_stats: DashboardVehicleStat[];
  top_mileage_vehicles: DashboardVehicleStat[];
  longest_vehicles_out: TripSummary[];
  daily_trips: DashboardDailyTrip[];
}

export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
export type NotificationPriority = 'NORMAL' | 'HIGH';

export interface NotificationRecord {
  id: number;
  recipient_user_id: number;
  event_type: string;
  priority: NotificationPriority;
  title: string;
  body: string;
  trip_id: number | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationRecipient {
  id: number;
  user_id: number;
  username: string;
  full_name: string;
  role: Role;
  channel: NotificationChannel;
  destination: string;
  active: boolean;
}

export type ReportType =
  | 'all_trips'
  | 'hires'
  | 'errands'
  | 'vehicles'
  | 'drivers'
  | 'flagged_trips'
  | 'audit_log';

export type ExportFormat = 'csv' | 'pdf' | 'json' | 'md';

export interface ReportPreviewData {
  type: ReportType;
  title: string;
  company: {
    name: string;
    contact_numbers: string;
    address: string;
  };
  generated_at_harare: string;
  range: { from: string | null; to: string | null };
  summary: Record<string, string | number>;
  columns: string[];
  rows: Record<string, string | number | null>[];
  total_rows: number;
}

export function formatHarareTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return new Intl.DateTimeFormat('en-ZW', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}



