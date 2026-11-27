import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpRight,
  Car,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Database,
  HelpCircle,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  CACHE_KEYS,
  ONLINE_RECONNECTED_EVENT,
  readCachedEntry,
  warmOfflineCaches,
  writeCachedEntry,
  type CachedTripsPayload,
} from '../lib/offlineCache';
import { notifyDueHiresLocally } from '../lib/pushNotifications';
import {
  OFFLINE_QUEUE_EVENT,
  OFFLINE_SYNCED_EVENT,
  flushOfflineQueue,
  getOfflineQueue,
  removeOfflineEntry,
  type QueuedTripEntry,
} from '../lib/offlineQueue';
import {
  ROLE_LABELS,
  formatHarareTime,
  type ChecklistSummary,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
} from '../shared/types';
import type { ChecklistPrefill } from './ChecklistsView';
import { DashboardView } from './DashboardView';
import { SubhireReceiveForm } from './SubhireReceiveForm';
import { TripInForm } from './TripInForm';
import { TripOutForm } from './TripOutForm';

export type NavSection =
  | 'home'
  | 'trips'
  | 'checklists'
  | 'vehicles'
  | 'maintenance'
  | 'drivers'
  | 'dashboard'
  | 'notifications'
  | 'audit'
  | 'reports'
  | 'settings'
  | 'help'
  | 'change-pin';

export interface PendingYardRestore {
  mode: { kind: 'OUT'; tripType: 'HIRE' } | { kind: 'SUBHIRE' };
  linkedChecklist: ChecklistSummary | null;
}

interface HomeViewProps {
  user: UserPublic;
  companyName: string;
  homeResetKey?: number;
  pendingYardRestore?: PendingYardRestore | null;
  onConsumePendingYardRestore?: () => void;
  onNavigate: (section: NavSection, tripId?: number) => void;
  onOpenVehicle: (vehicleId: number) => void;
  onOpenPinSettings: () => void;
  onCreateChecklistForTrip?: (trip: TripSummary) => void;
  onStartCreateChecklist?: (prefill: ChecklistPrefill) => void;
}

type ActiveYardMode =
  | { kind: 'OUT'; tripType: TripType }
  | { kind: 'IN'; tripType: TripType; tripId?: number | null }
  | { kind: 'SUBHIRE' }
  | null;

function getHarareTodayDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

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

export const HomeView: React.FC<HomeViewProps> = ({
  user,
  companyName,
  homeResetKey = 0,
  pendingYardRestore = null,
  onConsumePendingYardRestore,
  onNavigate,
  onOpenVehicle,
  onOpenPinSettings,
  onCreateChecklistForTrip,
  onStartCreateChecklist,
}) => {
  const [mode, setMode] = useState<ActiveYardMode>(null);
  const [restoredChecklist, setRestoredChecklist] = useState<ChecklistSummary | null>(null);
  const [ongoing, setOngoing] = useState<TripSummary[]>([]);
  const [loadingOngoing, setLoadingOngoing] = useState(true);
  const [usingOngoingCache, setUsingOngoingCache] = useState(false);
  const [ongoingCacheUpdatedAt, setOngoingCacheUpdatedAt] = useState<string | null>(null);
  const [queuedEntries, setQueuedEntries] = useState<QueuedTripEntry[]>(() => getOfflineQueue());
  const [syncingQueue, setSyncingQueue] = useState(false);
  const [showSandboxSeed, setShowSandboxSeed] = useState(false);
  const [seedingDemo, setSeedingDemo] = useState(false);
  const [pinActionWarning, setPinActionWarning] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const [headerRecordOpen, setHeaderRecordOpen] = useState(false);
  const [savedBanner, setSavedBanner] = useState<{
    message: string;
    flags: TripFlag[];
    tripId: number | null;
  } | null>(null);

  const dueReturns = useMemo(() => {
    const todayHarare = getHarareTodayDateStr();
    return ongoing.filter(
      (t) =>
        t.trip_type === 'HIRE' &&
        (t.is_return_overdue ||
          t.is_return_due ||
          (t.expected_return_date !== null && t.expected_return_date <= todayHarare))
    );
  }, [ongoing]);

  const loadOngoing = useCallback(async () => {
    setLoadingOngoing(true);
    setUsingOngoingCache(false);
    setOngoingCacheUpdatedAt(null);
    try {
      const res = await api.listTrips({ status: 'OPEN', limit: 50 });
      setOngoing(res.items);
      writeCachedEntry<TripSummary[]>('home_ongoing', res.items);
      try {
        localStorage.setItem('fleet_secure_cache_home_ongoing', JSON.stringify(res.items));
      } catch {
        // Ignore
      }
      void notifyDueHiresLocally(res.items);
    } catch {
      const cachedV2 = readCachedEntry<TripSummary[]>('home_ongoing');
      const cachedTripsAll = !cachedV2
        ? readCachedEntry<CachedTripsPayload>(CACHE_KEYS.tripsAll)
        : null;
      let items: TripSummary[] | null = cachedV2?.data ?? null;
      let updatedAt: string | null = cachedV2?.updatedAt ?? null;

      if (!items && cachedTripsAll) {
        items = cachedTripsAll.data.items.filter((t) => t.status === 'OPEN');
        updatedAt = cachedTripsAll.updatedAt;
      }
      if (!items) {
        try {
          const legacy = localStorage.getItem('fleet_secure_cache_home_ongoing');
          if (legacy) items = JSON.parse(legacy) as TripSummary[];
        } catch {
          // Ignore
        }
      }

      if (items) {
        setOngoing(items);
        setUsingOngoingCache(true);
        setOngoingCacheUpdatedAt(updatedAt);
        void notifyDueHiresLocally(items);
      }
    } finally {
      setLoadingOngoing(false);
    }
  }, []);

  useEffect(() => {
    if (pendingYardRestore) return;
    setMode(null);
    setPinActionWarning(false);
    setQuickActionsOpen(false);
    setHeaderRecordOpen(false);
  }, [homeResetKey, pendingYardRestore]);

  useEffect(() => {
    if (!pendingYardRestore) return;
    setMode(pendingYardRestore.mode);
    setRestoredChecklist(pendingYardRestore.linkedChecklist);
    setHeaderRecordOpen(false);
    setQuickActionsOpen(false);
    onConsumePendingYardRestore?.();
  }, [pendingYardRestore, onConsumePendingYardRestore]);

  useEffect(() => {
    if (!headerRecordOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHeaderRecordOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [headerRecordOpen]);

  useEffect(() => {
    if (!user.must_change_pin) {
      setPinActionWarning(false);
    }
  }, [user.must_change_pin]);

  useEffect(() => {
    loadOngoing();
  }, [loadOngoing]);

  useEffect(() => {
    if (user.role !== 'ADMIN' || user.must_change_pin) return;
    api
      .getPreviewStatus()
      .then((res) => {
        setShowSandboxSeed(res.previewSignupEnabled && res.vehicleCount === 0);
      })
      .catch(() => {
        setShowSandboxSeed(false);
      });
  }, [user.role, user.must_change_pin]);

  useEffect(() => {
    const refresh = () => setQueuedEntries(getOfflineQueue());
    const handleSyncedOrReconnected = () => {
      setQueuedEntries(getOfflineQueue());
      void loadOngoing();
    };
    window.addEventListener(OFFLINE_QUEUE_EVENT, refresh);
    window.addEventListener(OFFLINE_SYNCED_EVENT, handleSyncedOrReconnected);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, handleSyncedOrReconnected);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, refresh);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, handleSyncedOrReconnected);
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, handleSyncedOrReconnected);
    };
  }, [loadOngoing]);

  const openYardAction = (nextMode: Exclude<ActiveYardMode, null>) => {
    setHeaderRecordOpen(false);
    if (user.must_change_pin) {
      setPinActionWarning(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setPinActionWarning(false);
    setMode(nextMode);
  };

  const compactActions: Array<{
    label: string;
    hint: string;
    mode: Exclude<ActiveYardMode, null>;
    icon: React.ComponentType<{ className?: string }>;
    badgeClass: string;
  }> = [
    {
      label: 'Hire Out a Vehicle',
      hint: 'Client, mileage & fuel out',
      mode: { kind: 'OUT', tripType: 'HIRE' },
      icon: ArrowUpRight,
      badgeClass: 'from-blue-700 to-blue-600',
    },
    {
      label: 'Send on Errands',
      hint: 'Destination, mileage & fuel out',
      mode: { kind: 'OUT', tripType: 'ERRAND' },
      icon: Car,
      badgeClass: 'from-blue-600 to-cyan-500',
    },
    {
      label: 'Record Hire Return',
      hint: 'Close hire & check mileage',
      mode: { kind: 'IN', tripType: 'HIRE' },
      icon: ArrowDownLeft,
      badgeClass: 'from-cyan-600 to-blue-600',
    },
    {
      label: 'Record an Errand Return',
      hint: 'Closing mileage & fuel',
      mode: { kind: 'IN', tripType: 'ERRAND' },
      icon: ClipboardCheck,
      badgeClass: 'from-sky-600 to-cyan-500',
    },
    {
      label: 'Receive a Vehicle From Subhirer',
      hint: 'Subhirer intake, (Subhired) & checklist',
      mode: { kind: 'SUBHIRE' },
      icon: ArrowDownToLine,
      badgeClass: 'from-indigo-600 to-cyan-500',
    },
  ];

  const handleLoadDemoData = async () => {
    setSeedingDemo(true);
    try {
      const res = await api.seedDemoData();
      setShowSandboxSeed(false);
      setSavedBanner({
        message: `Loaded sample preview fleet: ${res.vehiclesAdded} vehicles, ${res.driversAdded} drivers, and ${res.tripsAdded} sample trips.`,
        flags: [],
        tripId: null,
      });
      await loadOngoing();
    } catch (err) {
      setSavedBanner({
        message: err instanceof ApiError ? err.message : 'Could not load sample fleet data.',
        flags: [],
        tripId: null,
      });
    } finally {
      setSeedingDemo(false);
    }
  };

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

  if (mode?.kind === 'SUBHIRE') {
    return (
      <SubhireReceiveForm
        user={user}
        externalLinkedChecklist={restoredChecklist}
        onConsumeExternalLinkedChecklist={() => setRestoredChecklist(null)}
        onStartCreateChecklist={onStartCreateChecklist}
        onCancel={() => {
          setRestoredChecklist(null);
          setMode(null);
        }}
        onSaved={(receipt, vehicle) => {
          setRestoredChecklist(null);
          setMode(null);
          setSavedBanner({
            message: `Received ${vehicle.reg_number} (${vehicle.make_model}) from subhirer ${receipt.subhirer_name}.`,
            flags: [],
            tripId: null,
          });
          void loadOngoing();
          void warmOfflineCaches(user.role, { force: true });
        }}
        onQueued={(summaryLabel) => {
          setRestoredChecklist(null);
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

  if (mode?.kind === 'OUT') {
    return (
      <TripOutForm
        tripType={mode.tripType}
        user={user}
        externalLinkedChecklist={mode.tripType === 'HIRE' ? restoredChecklist : null}
        onConsumeExternalLinkedChecklist={() => setRestoredChecklist(null)}
        onStartCreateChecklist={onStartCreateChecklist}
        onCancel={() => {
          setRestoredChecklist(null);
          setMode(null);
        }}
        onSaved={(trip, flags) => {
          setRestoredChecklist(null);
          setMode(null);
          setSavedBanner({
            message: `Saved ${trip.trip_type === 'HIRE' ? 'Hire Out' : 'Errand Out'} for ${trip.reg_number} (${trip.driver_name}).`,
            flags,
            tripId: trip.id,
          });
          void loadOngoing();
          void warmOfflineCaches(user.role, { force: true });
        }}
        onQueued={(summaryLabel) => {
          setRestoredChecklist(null);
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
          void loadOngoing();
          void warmOfflineCaches(user.role, { force: true });
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-cyan-700">
            {companyName} · {ROLE_LABELS[user.role]}
          </p>
          <h1 className="mt-1 font-display text-2xl sm:text-3xl font-bold text-blue-950">
            Welcome, {user.full_name}
          </h1>
        </div>
        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setHeaderRecordOpen(true)}
            aria-expanded={headerRecordOpen}
            aria-haspopup="dialog"
            className="cyan-glow-btn inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span>Record</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('help')}
            className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-3.5 py-2 text-xs font-semibold text-blue-900 whitespace-nowrap shrink-0"
          >
            <HelpCircle className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Help</span>
          </button>
        </div>
      </div>

      {headerRecordOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Quick Actions menu"
          onClick={() => setHeaderRecordOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-2xl border border-blue-200 bg-white p-5 shadow-2xl space-y-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-700">
                  Quick Actions
                </div>
                <h2 className="font-display text-lg font-bold text-blue-950">
                  Record Vehicle Movement
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setHeaderRecordOpen(false)}
                aria-label="Close quick actions"
                className="cyan-glow-outline flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl border border-blue-200 bg-white text-slate-600"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2">
              {compactActions.map((act) => {
                const Icon = act.icon;
                return (
                  <button
                    key={act.label}
                    type="button"
                    onClick={() => openYardAction(act.mode)}
                    className="cyan-glow-card group flex min-h-[56px] items-center gap-3 rounded-xl border border-blue-200/80 bg-blue-50/30 px-3.5 py-2.5 text-left transition-all hover:border-cyan-400"
                  >
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${act.badgeClass} text-white shadow-xs`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-blue-950 group-hover:text-blue-700 truncate">
                        {act.label}
                      </div>
                      <div className="text-xs text-slate-500 truncate">{act.hint}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {user.must_change_pin && (
        <section
          role={pinActionWarning ? 'alert' : 'region'}
          aria-label="First login PIN setup prompt"
          className={`cyan-glow-card rounded-2xl border p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between ${
            pinActionWarning
              ? 'border-amber-400 bg-amber-50'
              : 'border-cyan-300 bg-gradient-to-r from-amber-50 via-white to-cyan-50'
          }`}
        >
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-blue-700 text-white shadow-sm">
              <KeyRound className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-blue-950">
                {pinActionWarning
                  ? 'Please Set Your Personal PIN First'
                  : 'First Login: Change Your Temporary PIN'}
              </h2>
              <p className="mt-0.5 text-sm text-slate-700">
                {pinActionWarning
                  ? 'Before recording a trip or return, please change your temporary PIN to a personal PIN of your choice in Settings.'
                  : 'For your account security, please replace your temporary sign-in PIN with a personal PIN that only you know.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenPinSettings}
            className="cyan-glow-btn inline-flex min-h-[48px] shrink-0 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold whitespace-nowrap"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            <span>Change PIN in Settings</span>
          </button>
        </section>
      )}

      {dueReturns.length > 0 && (
        <section
          role="alert"
          aria-label="Vehicle return due reminders"
          className="rounded-2xl border border-red-300 bg-red-50/90 p-4 sm:p-5 space-y-3"
        >
          <div className="flex items-center gap-2.5 text-red-900">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-700" aria-hidden="true" />
            <h2 className="text-base font-bold">
              Vehicle Return Due &amp; Overdue Alerts ({dueReturns.length})
            </h2>
          </div>
          <div className="divide-y divide-red-200 rounded-xl border border-red-200 bg-white">
            {dueReturns.map((t) => {
              const todayHarare = getHarareTodayDateStr();
              const isPastDue =
                t.is_return_overdue ||
                (t.expected_return_date !== null && t.expected_return_date < todayHarare);
              return (
                <div
                  key={t.id}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="text-sm text-blue-950">
                    <span
                      className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                        isPastDue
                          ? 'bg-red-700 text-white'
                          : 'bg-amber-200 text-amber-950'
                      }`}
                    >
                      {isPastDue ? 'Overdue' : 'Due Today'}
                    </span>
                    <strong className="font-mono">{t.reg_number}</strong> ({t.make_model}) hired to{' '}
                    <strong>{t.client_name}</strong>{' '}
                    {isPastDue ? 'was due to return on' : 'is due to return on'}{' '}
                    <strong className="font-mono text-red-700">{t.expected_return_date}</strong>
                    {isPastDue ? ' and has not been closed.' : '.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => openYardAction({ kind: 'IN', tripType: 'HIRE', tripId: t.id })}
                    className="cyan-glow-btn min-h-[40px] self-start sm:self-center rounded-xl px-3.5 text-xs font-semibold whitespace-nowrap shrink-0"
                  >
                    Record Return
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {showSandboxSeed && (
        <section className="cyan-glow-card rounded-2xl border border-cyan-300 bg-gradient-to-r from-blue-50 via-white to-cyan-50 p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-700 to-cyan-500 text-white shadow-sm">
              <Database className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-blue-950">
                Preview Sandbox: Fleet is Empty
              </h2>
              <p className="mt-0.5 text-sm text-slate-600">
                Load 10 sample vehicles, 8 drivers, and 2 trips with one click so you can test Hire Out, Errand Return, Flags, Audit Trail, and Reports immediately.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={seedingDemo}
            onClick={handleLoadDemoData}
            className="cyan-glow-btn min-h-[48px] shrink-0 rounded-xl px-5 text-sm font-semibold whitespace-nowrap disabled:opacity-60"
          >
            {seedingDemo ? 'Loading Sample Data...' : 'Load Sample Fleet'}
          </button>
        </section>
      )}

      {savedBanner && (
        <div
          role="status"
          className={`rounded-2xl border p-4 space-y-2 ${
            savedBanner.flags.some((f) => f.severity === 'HIGH')
              ? 'border-amber-300 bg-amber-50 text-amber-950'
              : 'border-cyan-300 bg-cyan-50/70 text-blue-950'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-semibold text-sm">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-cyan-600" aria-hidden="true" />
              <span>{savedBanner.message}</span>
            </div>
            <div className="flex items-center gap-3">
              {savedBanner.tripId && (
                <button
                  type="button"
                  onClick={() => onNavigate('trips', savedBanner.tripId!)}
                  className="text-sm font-semibold text-blue-700 underline underline-offset-2 hover:text-cyan-700"
                >
                  View Trip #{savedBanner.tripId}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSavedBanner(null)}
                className="text-sm font-medium text-blue-800 opacity-75 hover:opacity-100"
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
              className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
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
                  className="cyan-glow-outline inline-flex min-h-[40px] self-start sm:self-center items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Discard</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Embedded Fleet Dashboard on Top (Stats Cards -> Ongoing Trips -> Daily Trips Bar Graphs) */}
      <DashboardView
        embedded
        onOpenVehicle={onOpenVehicle}
        onOpenTrip={(tid) => onNavigate('trips', tid)}
        afterStatsSlot={
          <section
            aria-labelledby="ongoing-heading"
            className="rounded-2xl border border-blue-200/80 bg-white overflow-hidden shadow-sm shadow-blue-900/5"
          >
            <div className="flex items-center justify-between gap-4 border-b border-blue-100 bg-gradient-to-r from-white to-blue-50/60 px-5 py-4">
              <div>
                <h2 id="ongoing-heading" className="text-base font-semibold text-blue-950">
                  Ongoing Trips ({ongoing.length})
                </h2>
                {usingOngoingCache && (
                  <p className="text-xs font-medium text-amber-800 mt-0.5">
                    Offline cached snapshot
                    {ongoingCacheUpdatedAt ? ` · updated ${formatHarareTime(ongoingCacheUpdatedAt)} CAT` : ''}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onNavigate('trips')}
                className="text-sm font-semibold text-blue-700 hover:text-cyan-600 underline underline-offset-2"
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
              <div className="divide-y divide-blue-100">
                {ongoing.map((t) => (
                  <div
                    key={t.id}
                    className="p-4 sm:px-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between transition-colors hover:bg-cyan-50/40"
                  >
                    <div
                      onClick={() => onNavigate('trips', t.id)}
                      className="space-y-1 cursor-pointer min-w-0"
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-base font-bold text-blue-950">
                          {t.reg_number}
                        </span>
                        <span aria-hidden="true" className="text-cyan-500">·</span>
                        <span className="text-base font-medium text-slate-800">{t.make_model}</span>
                        <span aria-hidden="true" className="text-cyan-500">·</span>
                        <span
                          className={`inline-flex items-center gap-1 text-sm font-semibold ${
                            t.is_overdue || t.is_return_due || t.is_return_overdue
                              ? 'text-red-700'
                              : 'text-amber-700'
                          }`}
                        >
                          <Clock className="h-4 w-4" aria-hidden="true" />
                          <span>
                            {formatElapsed(t.out_at)}
                            {t.is_return_overdue
                              ? ' (Return Overdue)'
                              : t.is_return_due
                                ? ' (Return Due)'
                                : t.is_overdue
                                  ? ' (Overdue)'
                                  : ''}
                          </span>
                        </span>
                      </div>
                      <div className="text-sm text-slate-600">
                        {t.trip_type === 'HIRE' ? `Hire to ${t.client_name}` : `Errand: ${t.destination}`} · Driver: {t.driver_name}
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-500">
                        Left {formatHarareTime(t.out_at)} · {t.mileage_out.toLocaleString()} km · Fuel {t.fuel_out}
                        {t.trip_type === 'HIRE' && t.days_hired !== null ? ` · ${t.days_hired}d hire` : ''}
                        {t.trip_type === 'HIRE' && t.expected_return_date
                          ? ` · Due ${t.expected_return_date}`
                          : ''}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 self-start sm:self-center shrink-0">
                      {t.trip_type === 'HIRE' && onCreateChecklistForTrip && (
                        <button
                          type="button"
                          onClick={() => onCreateChecklistForTrip(t)}
                          className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-3.5 text-xs font-semibold text-blue-900 whitespace-nowrap"
                        >
                          <ClipboardCheck className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                          <span>Checklist</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          openYardAction({ kind: 'IN', tripType: t.trip_type, tripId: t.id })
                        }
                        className="cyan-glow-btn min-h-[48px] rounded-xl px-4 text-sm font-semibold whitespace-nowrap"
                      >
                        Record Return
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        }
      />

      {/* Quick Actions (compact bar just below Dashboard, + Record toggles small quick-action buttons) */}
      <section
        aria-labelledby="yard-actions-heading"
        className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="yard-actions-heading" className="text-sm font-bold text-blue-950">
              Quick Actions
            </h2>
            <p className="text-xs text-slate-500">
              Tap + Record to log a vehicle hire, errand, or return
            </p>
          </div>
          <button
            type="button"
            onClick={() => setQuickActionsOpen((v) => !v)}
            aria-expanded={quickActionsOpen}
            className="cyan-glow-btn inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
          >
            {quickActionsOpen ? (
              <>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Hide</span>
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Record</span>
              </>
            )}
          </button>
        </div>

        {quickActionsOpen && (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 border-t border-blue-100 pt-3">
            {compactActions.map((act) => {
              const Icon = act.icon;
              return (
                <button
                  key={act.label}
                  type="button"
                  onClick={() => openYardAction(act.mode)}
                  className="cyan-glow-card group flex min-h-[54px] items-center gap-2.5 rounded-xl border border-blue-200/80 bg-blue-50/30 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${act.badgeClass} text-white shadow-xs`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-blue-950 group-hover:text-blue-700 leading-tight">
                      {act.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                      {act.hint}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {(user.role === 'FLEET_MANAGER' || user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
        <section aria-labelledby="admin-tools-heading">
          <h2 id="admin-tools-heading" className="text-base font-semibold text-blue-950">
            Management Quick Access
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => onNavigate('maintenance')}
              className="cyan-glow-card group flex min-h-[76px] items-center gap-3.5 rounded-2xl border border-blue-200/80 bg-white p-5 text-left"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-cyan-600 group-hover:bg-cyan-500 group-hover:text-white transition-colors">
                <Wrench className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <div className="text-base font-semibold text-blue-950 group-hover:text-blue-700">
                  Fleet Maintenance Dashboard
                </div>
                <div className="text-sm text-slate-600">
                  {user.role === 'FLEET_MANAGER' || user.role === 'ADMIN'
                    ? 'Mechanical/service history, garage visits, parts kits & service dues'
                    : 'View service dues, garage visits, and parts requests (read-only)'}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => onNavigate('vehicles')}
              className="cyan-glow-card group flex min-h-[76px] items-center gap-3.5 rounded-2xl border border-blue-200/80 bg-white p-5 text-left"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <Car className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <div className="text-base font-semibold text-blue-950 group-hover:text-blue-700">
                  Vehicles Directory
                </div>
                <div className="text-sm text-slate-600">
                  Manage vehicle condition, Grounded status, and odometer readings
                </div>
              </div>
            </button>

            {(user.role === 'SUPERVISOR' || user.role === 'ADMIN') && (
              <button
                type="button"
                onClick={() => onNavigate('audit')}
                className="cyan-glow-card group flex min-h-[76px] items-center gap-3.5 rounded-2xl border border-blue-200/80 bg-white p-5 text-left"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-cyan-600 group-hover:bg-cyan-500 group-hover:text-white transition-colors">
                  <ShieldCheck className="h-6 w-6" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-base font-semibold text-blue-950 group-hover:text-blue-700">
                    Audit Log &amp; Integrity Check
                  </div>
                  <div className="text-sm text-slate-600">
                    Inspect permanent logs and verify the SHA-256 hash chain
                  </div>
                </div>
              </button>
            )}

            {user.role === 'ADMIN' && (
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="cyan-glow-card group flex min-h-[76px] items-center gap-3.5 rounded-2xl border border-blue-200/80 bg-white p-5 text-left"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                  <SlidersHorizontal className="h-6 w-6" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-base font-semibold text-blue-950 group-hover:text-blue-700">
                    Settings &amp; Staff Accounts
                  </div>
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
