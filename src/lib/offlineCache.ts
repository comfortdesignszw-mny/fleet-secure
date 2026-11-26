import { api } from './api';
import {
  ALL_SKETCH_3D_IMAGE_URLS,
  type AppSettings,
  type AuditLogEntry,
  type ChecklistItemTemplate,
  type ChecklistSummary,
  type DashboardData,
  type Driver,
  type FleetMaintenanceOverview,
  type FuelLevel,
  type NotificationRecipient,
  type NotificationRecord,
  type ReportPreviewData,
  type ReportType,
  type Role,
  type TripDetail,
  type TripSummary,
  type UserPublic,
  type Vehicle,
} from '../shared/types';

export const VEHICLE_IMAGE_CACHE_NAME = 'fleet-secure-vehicle-images-v1';
const sketchObjectUrlMap = new Map<string, string>();
const sketchInFlightMap = new Map<string, Promise<string>>();

export function getCachedSketchImageSync(url: string): string {
  return sketchObjectUrlMap.get(url) ?? url;
}

export async function resolveCachedSketchImageSrc(url: string): Promise<string> {
  const existing = sketchObjectUrlMap.get(url);
  if (existing) return existing;

  const inflight = sketchInFlightMap.get(url);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      if (typeof window === 'undefined' || typeof caches === 'undefined') {
        return url;
      }
      const cache = await caches.open(VEHICLE_IMAGE_CACHE_NAME);
      let response = await cache.match(url);
      if (!response && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
        const fetched = await fetch(url, { cache: 'force-cache' });
        if (fetched.ok) {
          await cache.put(url, fetched.clone());
          response = fetched;
        }
      }
      if (response) {
        const blob = await response.blob();
        if (blob.size > 0 && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          const objectUrl = URL.createObjectURL(blob);
          sketchObjectUrlMap.set(url, objectUrl);
          return objectUrl;
        }
      }
      return url;
    } catch {
      return url;
    } finally {
      sketchInFlightMap.delete(url);
    }
  })();

  sketchInFlightMap.set(url, task);
  return task;
}

export async function warmVehicleSketchImages(): Promise<void> {
  if (typeof window === 'undefined') return;
  await Promise.allSettled(ALL_SKETCH_3D_IMAGE_URLS.map((u) => resolveCachedSketchImageSrc(u)));
}

export const ONLINE_RECONNECTED_EVENT = 'fleet-secure-online-reconnected';

export function dispatchOnlineReconnected(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ONLINE_RECONNECTED_EVENT));
  }
}

export interface CachedPayload<T> {
  data: T;
  updatedAt: string;
}

const CACHE_PREFIX = 'fleet_secure_cache_v2_';

export const CACHE_KEYS = {
  dashboardDefault: 'dashboard_default',
  dashboardRange: (from: string, to: string) => `dashboard_${from || 'start'}_${to || 'end'}`,
  tripsAll: 'trips_all',
  tripDetail: (id: number) => `trip_detail_${id}`,
  vehiclesAll: 'vehicles_all',
  vehicleDetail: (id: number) => `vehicle_detail_${id}`,
  fleetMaintenance: 'fleet_maintenance_overview',
  driversAll: 'drivers_all',
  driverDetail: (id: number) => `driver_detail_${id}`,
  auditLogs: 'audit_logs_recent',
  notifications: 'notifications_recent',
  notificationRecipients: 'notification_recipients',
  staffUsers: 'staff_users_all',
  checklistsAll: 'checklists_all',
  checklistTemplates: 'checklist_templates_active',
  reportPreview: (type: ReportType, from: string, to: string) =>
    `report_${type}_${from || 'all'}_${to || 'all'}`,
  reportDefault: (type: ReportType) => `report_${type}_default`,
};

export function readCachedEntry<T>(key: string): CachedPayload<T> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload<T>;
    if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedEntry<T>(key: string, data: T): CachedPayload<T> {
  const entry: CachedPayload<T> = {
    data,
    updatedAt: new Date().toISOString(),
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
    }
  } catch {
    // Ignore storage quota errors cleanly
  }
  return entry;
}

export function stripHeavyDriverDocuments(driver: Driver): Driver {
  return {
    ...driver,
    licence_document: null,
    ddc_document: null,
    retest_document: null,
    medical_document: null,
  };
}

export interface CachedVehicleDetail {
  vehicle: Vehicle;
  trips: Array<{
    id: number;
    trip_type: 'HIRE' | 'ERRAND';
    status: 'OPEN' | 'CLOSED';
    driver_name: string;
    client_name: string | null;
    destination: string | null;
    out_at: string | null;
    in_at: string | null;
    days_hired: number | null;
    expected_return_date: string | null;
    mileage_out: number | null;
    mileage_in: number | null;
    total_mileage: number | null;
  }>;
  conditionHistory: AuditLogEntry[];
  checklists?: Array<{
    id: number;
    status: 'out' | 'completed';
    hirer_type: 'renter' | 'owner';
    hirer_name: string;
    hire_date: string;
    return_date: string;
    mileage_out: number;
    mileage_in: number | null;
    fuel_out: FuelLevel | null;
    fuel_in: FuelLevel | null;
    created_at: string;
  }>;
}

export interface CachedDriverDetail {
  driver: Driver;
  trips: Array<{
    id: number;
    trip_type: 'HIRE' | 'ERRAND';
    status: 'OPEN' | 'CLOSED';
    reg_number: string;
    make_model: string;
    client_name: string | null;
    destination: string | null;
    out_at: string | null;
    in_at: string | null;
    days_hired: number | null;
    expected_return_date: string | null;
    total_mileage: number | null;
  }>;
}

export interface CachedNotificationsPayload {
  items: NotificationRecord[];
  total: number;
  unreadCount: number;
}

export interface CachedRecipientsPayload {
  items: NotificationRecipient[];
  managers: Array<{ id: number; username: string; full_name: string; role: Role }>;
  emailConfigured: boolean;
}

export interface CachedTripsPayload {
  items: TripSummary[];
  total: number;
}

export interface CachedDriversPayload {
  items: Driver[];
  total: number;
  expiringCount: number;
  missingDocsCount?: number;
}

export interface CachedVehiclesPayload {
  items: Vehicle[];
  total: number;
}

export interface CachedAuditPayload {
  items: AuditLogEntry[];
  total: number;
}

export interface CachedUsersPayload {
  items: UserPublic[];
  total: number;
}

let lastWarmStartedAt = 0;
let warmInFlight: Promise<void> | null = null;

/**
 * Quietly warms all role-appropriate offline snapshots while online so every screen
 * (Dashboard, Trips, Vehicles, Drivers, Audit Log, Reports, Notifications, Settings)
 * renders meaningful up-to-date data immediately even if the user next opens the app offline.
 */
export async function warmOfflineCaches(
  role: Role,
  options: { force?: boolean } = {}
): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const now = Date.now();
  if (!options.force && now - lastWarmStartedAt < 45_000) return;
  if (warmInFlight) return warmInFlight;

  lastWarmStartedAt = now;

  warmInFlight = (async () => {
    const coreTasks: Promise<unknown>[] = [
      api
        .getDashboard()
        .then((dash) => {
          writeCachedEntry<DashboardData>(CACHE_KEYS.dashboardDefault, dash);
          writeCachedEntry<DashboardData>(
            CACHE_KEYS.dashboardRange(dash.range.from, dash.range.to),
            dash
          );
        })
        .catch(() => undefined),
      api
        .listTrips({ limit: 100 })
        .then((res) => {
          writeCachedEntry<CachedTripsPayload>(CACHE_KEYS.tripsAll, {
            items: res.items,
            total: res.total,
          });
          try {
            const ongoing = res.items.filter((t) => t.status === 'OPEN');
            localStorage.setItem('fleet_secure_cache_home_ongoing', JSON.stringify(ongoing));
          } catch {
            // Ignore
          }
        })
        .catch(() => undefined),
      api
        .listVehicles({ includeInactive: true, limit: 500 })
        .then((res) => {
          writeCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll, {
            items: res.items,
            total: res.total,
          });
        })
        .catch(() => undefined),
      api
        .listDrivers({ includeInactive: true, limit: 500 })
        .then((res) => {
          writeCachedEntry<CachedDriversPayload>(CACHE_KEYS.driversAll, {
            items: res.items.map(stripHeavyDriverDocuments),
            total: res.total,
            expiringCount: res.expiringCount,
            missingDocsCount: res.missingDocsCount,
          });
        })
        .catch(() => undefined),
      api.getSettings().catch(() => undefined),
      api
        .getFleetMaintenanceOverview()
        .then((overview) => {
          writeCachedEntry<FleetMaintenanceOverview>(CACHE_KEYS.fleetMaintenance, overview);
        })
        .catch(() => undefined),
      api
        .listChecklists({ limit: 100 })
        .then((res) => {
          writeCachedEntry<ChecklistSummary[]>(CACHE_KEYS.checklistsAll, res.items);
        })
        .catch(() => undefined),
      api
        .listChecklistTemplates()
        .then((res) => {
          writeCachedEntry<ChecklistItemTemplate[]>(CACHE_KEYS.checklistTemplates, res.items);
        })
        .catch(() => undefined),
      warmVehicleSketchImages().catch(() => undefined),
    ];

    if (role === 'SUPERVISOR' || role === 'FLEET_MANAGER' || role === 'ADMIN') {
      coreTasks.push(
        api
          .listNotifications({ limit: 50 })
          .then((res) => {
            writeCachedEntry<CachedNotificationsPayload>(CACHE_KEYS.notifications, {
              items: res.items,
              total: res.total,
              unreadCount: res.unreadCount,
            });
          })
          .catch(() => undefined)
      );
    }

    if (role === 'SUPERVISOR' || role === 'ADMIN') {
      coreTasks.push(
        api
          .listAuditLog({ limit: 50 })
          .then((res) => {
            writeCachedEntry<CachedAuditPayload>(CACHE_KEYS.auditLogs, {
              items: res.items,
              total: res.total,
            });
          })
          .catch(() => undefined)
      );

      const reportTypesToWarm: ReportType[] = [
        'all_trips',
        'hires',
        'vehicles',
        'drivers',
        'checklists',
      ];
      for (const rType of reportTypesToWarm) {
        coreTasks.push(
          api
            .getReportPreview({ type: rType })
            .then((preview) => {
              writeCachedEntry<ReportPreviewData>(CACHE_KEYS.reportDefault(rType), preview);
            })
            .catch(() => undefined)
        );
      }
    }

    if (role === 'ADMIN') {
      coreTasks.push(
        api
          .listUsers({ limit: 100 })
          .then((res) => {
            writeCachedEntry<CachedUsersPayload>(CACHE_KEYS.staffUsers, {
              items: res.items,
              total: res.total,
            });
          })
          .catch(() => undefined),
        api
          .listNotificationRecipients()
          .then((res) => {
            writeCachedEntry<CachedRecipientsPayload>(CACHE_KEYS.notificationRecipients, res);
          })
          .catch(() => undefined)
      );
    }

    await Promise.allSettled(coreTasks);
  })().finally(() => {
    warmInFlight = null;
  });

  return warmInFlight;
}

export function exportCachedReportOffline(
  preview: ReportPreviewData,
  format: 'csv' | 'json' | 'md'
): void {
  const dateTag = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const filename = `fleet-secure-${preview.type}-cached-${dateTag}.${format}`;

  let content = '';
  let mimeType = 'text/plain;charset=utf-8';

  if (format === 'json') {
    content = JSON.stringify(preview, null, 2);
    mimeType = 'application/json;charset=utf-8';
  } else if (format === 'csv') {
    const escapeCell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = preview.columns.map(escapeCell).join(',');
    const lines = preview.rows.map((r) => preview.columns.map((c) => escapeCell(r[c])).join(','));
    content = `\uFEFF${[header, ...lines].join('\r\n')}\r\n`;
    mimeType = 'text/csv;charset=utf-8';
  } else {
    const rangeStr =
      preview.range.from || preview.range.to
        ? `${preview.range.from || 'Start'} to ${preview.range.to || 'Today'}`
        : 'All Dates';
    const summaryLines = Object.entries(preview.summary)
      .map(([k, v]) => `- **${k}:** ${v}`)
      .join('\n');
    const headerRow = `| ${preview.columns.join(' | ')} |`;
    const sepRow = `| ${preview.columns.map(() => '---').join(' | ')} |`;
    const bodyRows = preview.rows.map(
      (r) =>
        `| ${preview.columns
          .map((c) => String(r[c] ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '))
          .join(' | ')} |`
    );
    content = [
      `# ${preview.company.name} — ${preview.title} (Offline Cached Snapshot)`,
      '',
      `- **Date Range:** ${rangeStr}`,
      `- **Snapshot Generated (Harare):** ${preview.generated_at_harare}`,
      '',
      '## Summary',
      summaryLines,
      '',
      '## Records',
      ...(preview.rows.length > 0 ? [headerRow, sepRow, ...bodyRows] : ['_No records._']),
      '',
    ].join('\n');
    mimeType = 'text/markdown;charset=utf-8';
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type { AppSettings, TripDetail };
