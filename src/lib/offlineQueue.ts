import { api, ApiError } from './api';
import type {
  CreateTripOutPayload,
  FuelLevel,
  TripFlag,
  TripSummary,
} from '../shared/types';

export const OFFLINE_QUEUE_KEY = 'fleet_secure_offline_queue_v1';
export const OFFLINE_QUEUE_EVENT = 'fleet-secure-offline-queue-changed';

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
    };

function notifyQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT));
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
}

const defaultHandlers: OfflineSyncHandlers = {
  sendOut: (payload) => api.createTripOut(payload),
  sendIn: (tripId, payload) => api.createTripIn(tripId, payload),
};

export async function flushOfflineQueue(
  handlers: OfflineSyncHandlers = defaultHandlers,
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
      } else {
        const { trip_id, ...rest } = item.payload;
        const res = await handlers.sendIn(trip_id, rest);
        lastTrip = res.trip;
        lastFlags = res.flags;
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
  return { syncedCount, failedCount, remaining, lastFlags, lastTrip };
}

export function isLikelyNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return true;
  }
  if (err instanceof ApiError) {
    return err.status >= 502;
  }
  return err instanceof TypeError || (err instanceof Error && /network|fetch|offline/i.test(err.message));
}
