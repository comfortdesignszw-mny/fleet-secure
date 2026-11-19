import { api, ApiError } from './api';
import type {
  CreateTripOutPayload,
  Driver,
  FuelLevel,
  TripFlag,
  TripSummary,
  Vehicle,
  VehicleCondition,
} from '../shared/types';

export const OFFLINE_QUEUE_KEY = 'fleet_secure_offline_queue_v1';
export const OFFLINE_QUEUE_EVENT = 'fleet-secure-offline-queue-changed';
export const OFFLINE_SYNCED_EVENT = 'fleet-secure-synced';

export type OutTripPayload = CreateTripOutPayload & {
  device_time: string;
};

export interface InTripPayload {
  trip_id: number;
  mileage_in: number;
  fuel_in: FuelLevel;
  closing_checklist_by: string;
  notes?: string;
  device_time: string;
}

export interface OfflineCreateDriverPayload {
  full_name: string;
  licence_number?: string | null;
  phone: string;
  address?: string;
  licence_expiry?: string | null;
  licence_document?: string | null;
  ddc_number?: string | null;
  ddc_document?: string | null;
  retest_cert_number?: string | null;
  retest_document?: string | null;
  medical_cert_number?: string | null;
  medical_document?: string | null;
}

export interface OfflineCreateVehiclePayload {
  reg_number: string;
  vehicle_type: string;
  make_model: string;
  condition: VehicleCondition;
  last_known_mileage: number;
}

export type QueuedTripEntry =
  | {
      id: string;
      kind: 'OUT';
      summaryLabel: string;
      createdAtDevice: string;
      payload: OutTripPayload;
      lastError?: string | null;
    }
  | {
      id: string;
      kind: 'IN';
      summaryLabel: string;
      createdAtDevice: string;
      payload: InTripPayload;
      lastError?: string | null;
    }
  | {
      id: string;
      kind: 'DRIVER_CREATE';
      summaryLabel: string;
      createdAtDevice: string;
      payload: OfflineCreateDriverPayload;
      lastError?: string | null;
    }
  | {
      id: string;
      kind: 'VEHICLE_CREATE';
      summaryLabel: string;
      createdAtDevice: string;
      payload: OfflineCreateVehiclePayload;
      lastError?: string | null;
    };

function notifyQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT));
  }
}

function notifySynced(result: SyncFlushResult) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: result }));
  }
}

export function getOfflineQueue(storage?: Storage): QueuedTripEntry[] {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return [];
  try {
    const raw = store.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedTripEntry[]) : [];
  } catch {
    return [];
  }
}

function saveOfflineQueue(items: QueuedTripEntry[], storage?: Storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return;
  try {
    store.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
    notifyQueueChanged();
  } catch {
    // Ignore storage quota errors
  }
}

export function enqueueOfflineEntry(
  entry: Omit<QueuedTripEntry, 'id' | 'createdAtDevice' | 'lastError'> & {
    createdAtDevice?: string;
  },
  storage?: Storage
): QueuedTripEntry {
  const createdAtDevice = entry.createdAtDevice ?? new Date().toISOString();
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const fullEntry = {
    ...entry,
    id,
    createdAtDevice,
    lastError: null,
  } as QueuedTripEntry;

  const queue = getOfflineQueue(storage);
  queue.push(fullEntry);
  saveOfflineQueue(queue, storage);
  return fullEntry;
}

export function removeOfflineEntry(id: string, storage?: Storage): void {
  const next = getOfflineQueue(storage).filter((item) => item.id !== id);
  saveOfflineQueue(next, storage);
}

export interface SyncFlushResult {
  syncedCount: number;
  failedCount: number;
  remaining: QueuedTripEntry[];
  lastFlags: TripFlag[];
  lastTrip: TripSummary | null;
}

export interface OfflineSyncHandlers {
  sendOut: (payload: OutTripPayload) => Promise<{ trip: TripSummary; flags: TripFlag[] }>;
  sendIn: (
    tripId: number,
    payload: Omit<InTripPayload, 'trip_id'>
  ) => Promise<{ trip: TripSummary; flags: TripFlag[] }>;
  createDriver?: (payload: OfflineCreateDriverPayload) => Promise<{ driver: Driver }>;
  createVehicle?: (payload: OfflineCreateVehiclePayload) => Promise<{ vehicle: Vehicle }>;
}

const defaultHandlers: OfflineSyncHandlers = {
  sendOut: (payload) => api.createTripOut(payload),
  sendIn: (tripId, payload) => api.createTripIn(tripId, payload),
  createDriver: (payload) => api.createDriver(payload),
  createVehicle: (payload) => api.createVehicle(payload),
};

let inFlightFlushPromise: Promise<SyncFlushResult> | null = null;

async function runFlushOfflineQueue(
  handlers: OfflineSyncHandlers,
  storage?: Storage
): Promise<SyncFlushResult> {
  const queue = getOfflineQueue(storage);
  if (queue.length === 0) {
    return { syncedCount: 0, failedCount: 0, remaining: [], lastFlags: [], lastTrip: null };
  }

  let syncedCount = 0;
  let failedCount = 0;
  const remaining: QueuedTripEntry[] = [];
  let lastFlags: TripFlag[] = [];
  let lastTrip: TripSummary | null = null;

  for (const item of queue) {
    try {
      if (item.kind === 'OUT') {
        const res = await handlers.sendOut(item.payload);
        lastTrip = res.trip;
        lastFlags = res.flags;
      } else if (item.kind === 'IN') {
        const { trip_id, ...rest } = item.payload;
        const res = await handlers.sendIn(trip_id, rest);
        lastTrip = res.trip;
        lastFlags = res.flags;
      } else if (item.kind === 'DRIVER_CREATE') {
        const sendDriver = handlers.createDriver ?? ((p) => api.createDriver(p));
        await sendDriver(item.payload);
      } else if (item.kind === 'VEHICLE_CREATE') {
        const sendVehicle = handlers.createVehicle ?? ((p) => api.createVehicle(p));
        await sendVehicle(item.payload);
      }
      syncedCount++;
    } catch (err) {
      failedCount++;
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Network error while syncing.';
      remaining.push({ ...item, lastError: message });
    }
  }

  saveOfflineQueue(remaining, storage);
  const result = { syncedCount, failedCount, remaining, lastFlags, lastTrip };
  if (syncedCount > 0) {
    notifySynced(result);
  }
  return result;
}

export async function flushOfflineQueue(
  handlers: OfflineSyncHandlers = defaultHandlers,
  storage?: Storage
): Promise<SyncFlushResult> {
  // Deduplicate concurrent flushes when sharing the default browser storage
  if (!storage && handlers === defaultHandlers) {
    if (inFlightFlushPromise) {
      return inFlightFlushPromise;
    }
    inFlightFlushPromise = runFlushOfflineQueue(handlers, storage).finally(() => {
      inFlightFlushPromise = null;
    });
    return inFlightFlushPromise;
  }
  return runFlushOfflineQueue(handlers, storage);
}

export function isLikelyNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }
  if (err instanceof ApiError) {
    return err.status === 0 || err.status >= 502;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }
  return (
    err instanceof TypeError ||
    (err instanceof Error && /network|fetch|offline|failed to fetch|load failed/i.test(err.message))
  );
}
