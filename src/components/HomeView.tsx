import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Car,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  HelpCircle,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  OFFLINE_QUEUE_EVENT,
  flushOfflineQueue,
  getOfflineQueue,
  removeOfflineEntry,
  type QueuedTripEntry,
} from '../lib/offlineQueue';
import {
  ROLE_LABELS,
  formatHarareTime,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
} from '../shared/types';
import { TripInForm } from './TripInForm';
import { TripOutForm } from './TripOutForm';

export type NavSection =
  | 'home'
  | 'trips'
  | 'vehicles'
  | 'drivers'
  | 'dashboard'
  | 'notifications'
  | 'audit'
  | 'reports'
  | 'settings'
  | 'help'
  | 'change-pin';

interface HomeViewProps {
  user: UserPublic;
  companyName: string;
  onNavigate: (section: NavSection, tripId?: number) => void;
}

type ActiveYardMode =
  | { kind: 'OUT'; tripType: TripType }
  | { kind: 'IN'; tripType: TripType; tripId?: number | null }
  | null;

function formatElapsed(outAt: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(outAt).getTime());
  const totalMins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours === 0) return `${mins}m out`;
  if (hours < 24) return `${hours}h ${mins}m out`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h out`;
}

export const HomeView: React.FC<HomeViewProps> = ({ user, companyName, onNavigate }) => {
  const [mode, setMode] = useState<ActiveYardMode>(null);
  const [ongoing, setOngoing] = useState<TripSummary[]>([]);
  const [loadingOngoing, setLoadingOngoing] = useState(true);
  const [queuedEntries, setQueuedEntries] = useState<QueuedTripEntry[]>(() => getOfflineQueue());
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [savedBanner, setSavedBanner] = useState<{
    message: string;
    flags: TripFlag[];
    tripId: number | null;
  } | null>(null);

  const loadOngoing = useCallback(async () => {
    setLoadingOngoing(true);
    try {
      const res = await api.listTrips({ status: 'OPEN', limit: 50 });
      setOngoing(res.items);
      try {
        localStorage.setItem('fleet_secure_cache_home_ongoing', JSON.stringify(res.items));
      } catch {
        // Ignore
      }
    } catch {
      try {
        const cached = localStorage.getItem('fleet_secure_cache_home_ongoing');
        if (cached) setOngoing(JSON.parse(cached) as TripSummary[]);
      } catch {
        // Ignore
      }
    } finally {
      setLoadingOngoing(false);
    }
  }, []);

  useEffect(() => {
    loadOngoing();
  }, [loadOngoing]);

  useEffect(() => {
    const refresh = () => setQueuedEntries(getOfflineQueue());
    window.addEventListener(OFFLINE_QUEUE_EVENT, refresh);
    return () => window.removeEventListener(OFFLINE_QUEUE_EVENT, refresh);
  }, []);

  const handleSyncNow = async () => {
    setSyncingQueue(true);
    try {
      const res = await flushOfflineQueue();
      setQueuedEntries(getOfflineQueue());
      if (res.syncedCount > 0) {
        setSavedBanner({
          message: `Synced ${res.syncedCount} queued entr${res.syncedCount === 1 ? 'y' : 'ies'} to the server.`,
          flags: res.lastFlags,
          tripId: res.lastTrip?.id ?? null,
        });
        await loadOngoing();
      }
    } finally {
      setSyncingQueue(false);
    }
  };

  if (mode?.kind === 'OUT') {
    return (
      <TripOutForm
        tripType={mode.tripType}
        user={user}
        onCancel={() => setMode(null)}
        onSaved={(trip, flags) => {
          setMode(null);
          setSavedBanner({
            message: `Saved ${trip.trip_type === 'HIRE' ? 'Hire Out' : 'Errand Out'} for ${trip.reg_number} (${trip.driver_name}).`,
            flags,
            tripId: trip.id,
          });
          loadOngoing();
        }}
        onQueued={(summaryLabel) => {
          setMode(null);
          setQueuedEntries(getOfflineQueue());
          setSavedBanner({
            message: `Saved offline (Waiting to send): ${summaryLabel}. It will upload automatically when internet returns.`,
            flags: [],
            tripId: null,
          });
        }}
      />
    );
  }

  if (mode?.kind === 'IN') {
    return (
      <TripInForm
        tripType={mode.tripType}
        user={user}
        initialTripId={mode.tripId}
        onCancel={() => setMode(null)}
        onSaved={(trip, flags) => {
          setMode(null);
          setSavedBanner({
            message: `Saved return for ${trip.reg_number} (+${trip.total_mileage?.toLocaleString() ?? 0} km, est. ${trip.est_fuel_litres ?? 0} L).`,
            flags,
            tripId: trip.id,
          });
          loadOngoing();
        }}
        onQueued={(summaryLabel) => {
          setMode(null);
          setQueuedEntries(getOfflineQueue());
          setSavedBanner({
            message: `Saved offline (Waiting to send): ${summaryLabel}. It will upload automatically when internet returns.`,
            flags: [],
            tripId: null,
          });
        }}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-500">
            {companyName} · {ROLE_LABELS[user.role]}
          </p>
          <h1 className="mt-1 font-display text-2xl sm:text-3xl font-bold text-slate-900">
            Welcome, {user.full_name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onNavigate('change-pin')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <KeyRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>Change PIN</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('help')}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <HelpCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>Help</span>
          </button>
        </div>
      </div>

      {savedBanner && (
        <div
          role="status"
          className={`rounded-2xl border p-4 space-y-2 ${
            savedBanner.flags.some((f) => f.severity === 'HIGH')
              ? 'border-amber-300 bg-amber-50 text-amber-950'
              : 'border-emerald-200 bg-emerald-50 text-emerald-950'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span>{savedBanner.message}</span>
            </div>
            <div className="flex items-center gap-3">
              {savedBanner.tripId && (
                <button
                  type="button"
                  onClick={() => onNavigate('trips', savedBanner.tripId!)}
                  className="text-sm font-semibold underline underline-offset-2"
                >
                  View Trip #{savedBanner.tripId}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSavedBanner(null)}
                className="text-sm font-medium opacity-75 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          </div>
          {savedBanner.flags.length > 0 && (
            <div className="space-y-1 text-sm">
              {savedBanner.flags.map((f, i) => (
                <div key={i} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                  <span>
                    <strong>{f.code}:</strong> {f.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {queuedEntries.length > 0 && (
        <section
          aria-labelledby="waiting-queue-heading"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-5 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-amber-950">
              <WifiOff className="h-5 w-5 text-amber-700 shrink-0" aria-hidden="true" />
              <h2 id="waiting-queue-heading" className="text-base font-bold">
                Waiting to send ({queuedEntries.length})
              </h2>
            </div>
            <button
              type="button"
              disabled={syncingQueue}
              onClick={handleSyncNow}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              <RefreshCw
                className={`h-4 w-4 ${syncingQueue ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{syncingQueue ? 'Sending...' : 'Sync Now'}</span>
            </button>
          </div>

          <div className="divide-y divide-amber-200 rounded-xl border border-amber-200 bg-white">
            {queuedEntries.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{item.summaryLabel}</div>
                  <div className="text-xs font-mono text-slate-500">
                    Captured {formatHarareTime(item.createdAtDevice)} · Waiting to send
                  </div>
                  {item.lastError && (
                    <div className="text-xs font-medium text-red-700">
                      Sync note: {item.lastError}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    removeOfflineEntry(item.id);
                    setQueuedEntries(getOfflineQueue());
                  }}
                  aria-label={`Remove queued entry ${item.summaryLabel}`}
                  className="inline-flex min-h-[40px] self-start sm:self-center items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Discard</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Primary Yard Actions (4 large tap targets) */}
      <section aria-labelledby="yard-actions-heading">
        <h2 id="yard-actions-heading" className="text-base font-semibold text-slate-800">
          Record Vehicle Movement
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode({ kind: 'OUT', tripType: 'HIRE' })}
            className="flex min-h-[88px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-white">
              <ArrowUpRight className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-900">Hire Out a Vehicle</div>
              <div className="mt-0.5 text-sm text-slate-600">
                Record client name, mileage, and fuel when leaving
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode({ kind: 'IN', tripType: 'HIRE' })}
            className="flex min-h-[88px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-700 text-white">
              <ArrowDownLeft className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-900">Return a Hired Vehicle</div>
              <div className="mt-0.5 text-sm text-slate-600">
                Close an open hire and check total mileage and fuel
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode({ kind: 'OUT', tripType: 'ERRAND' })}
            className="flex min-h-[88px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-600 text-white">
              <Car className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-900">Send on Errand</div>
              <div className="mt-0.5 text-sm text-slate-600">
                Log staff destination, reason, mileage, and fuel
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode({ kind: 'IN', tripType: 'ERRAND' })}
            className="flex min-h-[88px] items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sky-700 text-white">
              <ClipboardCheck className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-900">Errand Returned</div>
              <div className="mt-0.5 text-sm text-slate-600">
                Record return mileage and closing fuel level
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* Ongoing Trips (Live) */}
      <section aria-labelledby="ongoing-heading" className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <h2 id="ongoing-heading" className="text-base font-semibold text-slate-900">
            Ongoing Trips ({ongoing.length})
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('trips')}
            className="text-sm font-semibold text-slate-700 hover:text-slate-900 underline underline-offset-2"
          >
            All Trips
          </button>
        </div>

        {loadingOngoing ? (
          <div className="p-6 text-base text-slate-500">Checking vehicles out...</div>
        ) : ongoing.length === 0 ? (
          <div className="p-6 text-base text-slate-600">
            All vehicles are currently parked in the yard.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {ongoing.map((t) => (
              <div
                key={t.id}
                className="p-4 sm:px-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div
                  onClick={() => onNavigate('trips', t.id)}
                  className="space-y-1 cursor-pointer min-w-0"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-base font-bold text-slate-900">
                      {t.reg_number}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">·</span>
                    <span className="text-base font-medium text-slate-800">{t.make_model}</span>
                    <span aria-hidden="true" className="text-slate-400">·</span>
                    <span
                      className={`inline-flex items-center gap-1 text-sm font-semibold ${
                        t.is_overdue ? 'text-red-700' : 'text-amber-700'
                      }`}
                    >
                      <Clock className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {formatElapsed(t.out_at)}
                        {t.is_overdue ? ' (Overdue)' : ''}
                      </span>
                    </span>
                  </div>
                  <div className="text-sm text-slate-600">
                    {t.trip_type === 'HIRE' ? `Hire to ${t.client_name}` : `Errand: ${t.destination}`} · Driver: {t.driver_name}
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    Left {formatHarareTime(t.out_at)} · {t.mileage_out.toLocaleString()} km · Fuel {t.fuel_out}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setMode({ kind: 'IN', tripType: t.trip_type, tripId: t.id })
                  }
                  className="min-h-[48px] self-start sm:self-center rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
                >
                  Record Return
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <section aria-labelledby="admin-tools-heading">
          <h2 id="admin-tools-heading" className="text-base font-semibold text-slate-800">
            Supervisor & Admin Quick Access
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onNavigate('audit')}
              className="flex min-h-[72px] items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-5 text-left hover:border-slate-400 hover:bg-slate-50"
            >
              <ShieldCheck className="h-6 w-6 shrink-0 text-emerald-700" aria-hidden="true" />
              <div>
                <div className="text-base font-semibold text-slate-900">Audit Log & Integrity Check</div>
                <div className="text-sm text-slate-600">
                  Inspect permanent logs and verify the SHA-256 hash chain
                </div>
              </div>
            </button>

            {user.role === 'ADMIN' && (
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="flex min-h-[72px] items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-5 text-left hover:border-slate-400 hover:bg-slate-50"
              >
                <SlidersHorizontal className="h-6 w-6 shrink-0 text-slate-800" aria-hidden="true" />
                <div>
                  <div className="text-base font-semibold text-slate-900">Settings & Staff Accounts</div>
                  <div className="text-sm text-slate-600">
                    Manage users, roles, fuel rules, and company profile
                  </div>
                </div>
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
};
