import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit3,
  Lock,
  Search,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  CACHE_KEYS,
  ONLINE_RECONNECTED_EVENT,
  readCachedEntry,
  writeCachedEntry,
  type CachedTripsPayload,
} from '../lib/offlineCache';
import { OFFLINE_SYNCED_EVENT, isLikelyNetworkError } from '../lib/offlineQueue';
import {
  FUEL_LEVELS,
  formatHarareTime,
  type FuelLevel,
  type Role,
  type TripDetail,
  type TripSummary,
  type TripType,
} from '../shared/types';

interface TripsViewProps {
  userRole: Role;
  initialTripId?: number | null;
  onRecordReturn?: (trip: TripSummary) => void;
}

const LEGACY_CACHE_KEY = 'fleet_secure_cache_trips';

function toHarareDateOnly(isoString: string): string {
  const dt = new Date(isoString);
  if (Number.isNaN(dt.getTime())) return isoString.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

export const TripsView: React.FC<TripsViewProps> = ({
  userRole,
  initialTripId = null,
  onRecordReturn,
}) => {
  const canCorrect = userRole === 'SUPERVISOR' || userRole === 'ADMIN';

  const [tab, setTab] = useState<'OPEN' | 'CLOSED' | 'ALL'>('ALL');
  const [tripType, setTripType] = useState<TripType | ''>('');
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const [items, setItems] = useState<TripSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingCache, setUsingCache] = useState(false);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<string | null>(null);

  // Detail state
  const [selectedId, setSelectedId] = useState<number | null>(initialTripId);
  const [detail, setDetail] = useState<TripDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Correction modal state
  const [showCorrectModal, setShowCorrectModal] = useState(false);
  const [corrTarget, setCorrTarget] = useState<'trips' | 'trip_out' | 'trip_in'>('trip_out');
  const [corrField, setCorrField] = useState('mileage_out');
  const [corrValue, setCorrValue] = useState('');
  const [corrReason, setCorrReason] = useState('');
  const [savingCorr, setSavingCorr] = useState(false);
  const [corrError, setCorrError] = useState<string | null>(null);
  const [corrNotice, setCorrNotice] = useState<string | null>(null);

  const applyOfflineTripFilters = useCallback(
    (rawList: TripSummary[]): { paged: TripSummary[]; total: number } => {
      const q = query.trim().toLowerCase();
      const filtered = rawList.filter((t) => {
        if (tab !== 'ALL' && t.status !== tab) return false;
        if (tripType && t.trip_type !== tripType) return false;
        if (flaggedOnly && t.flags.length === 0) return false;
        const outDate = toHarareDateOnly(t.out_at);
        if (fromDate && outDate < fromDate) return false;
        if (toDate && outDate > toDate) return false;
        if (q) {
          const hay = [
            t.reg_number,
            t.make_model,
            t.driver_name,
            t.client_name ?? '',
            t.destination ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      const offset = (page - 1) * limit;
      return {
        paged: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },
    [tab, tripType, flaggedOnly, fromDate, toDate, query, page]
  );

  const fetchTrips = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    try {
      const res = await api.listTrips({
        status: tab === 'ALL' ? '' : tab,
        trip_type: tripType,
        flagged: flaggedOnly,
        from: fromDate,
        to: toDate,
        q: query,
        page,
        limit,
      });
      setItems(res.items);
      setTotal(res.total);
      if (tab === 'ALL' && !tripType && !flaggedOnly && !fromDate && !toDate && !query && page === 1) {
        writeCachedEntry<CachedTripsPayload>(CACHE_KEYS.tripsAll, {
          items: res.items,
          total: res.total,
        });
      }
      try {
        localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(res.items));
      } catch {
        // Ignore
      }
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cachedV2 = readCachedEntry<CachedTripsPayload>(CACHE_KEYS.tripsAll);
        let rawList: TripSummary[] | null = cachedV2?.data.items ?? null;
        const updatedAt = cachedV2?.updatedAt ?? null;
        if (!rawList) {
          try {
            const legacy = localStorage.getItem(LEGACY_CACHE_KEY);
            if (legacy) rawList = JSON.parse(legacy) as TripSummary[];
          } catch {
            // Ignore
          }
        }
        if (rawList) {
          const applied = applyOfflineTripFilters(rawList);
          setItems(applied.paged);
          setTotal(applied.total);
          setUsingCache(true);
          setCacheUpdatedAt(updatedAt);
        } else {
          setError('Offline mode — no cached trips saved yet.');
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load trips.');
      }
    } finally {
      setLoading(false);
    }
  }, [tab, tripType, flaggedOnly, fromDate, toDate, query, page, applyOfflineTripFilters]);

  const loadDetail = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetailLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    try {
      const data = await api.getTrip(id);
      setDetail(data);
      writeCachedEntry<TripDetail>(CACHE_KEYS.tripDetail(id), data);
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cachedDetail = readCachedEntry<TripDetail>(CACHE_KEYS.tripDetail(id));
        if (cachedDetail) {
          setDetail(cachedDetail.data);
          setUsingCache(true);
          setCacheUpdatedAt(cachedDetail.updatedAt);
        } else {
          const cachedAll = readCachedEntry<CachedTripsPayload>(CACHE_KEYS.tripsAll);
          const match = cachedAll?.data.items.find((t) => t.id === id);
          if (match) {
            setDetail({
              trip: match,
              out: {
                trip_id: match.id,
                out_at: match.out_at,
                device_time: null,
                received_at: match.created_at,
                mileage_out: match.mileage_out,
                fuel_out: match.fuel_out,
                opening_checklist_by: '',
                notes: '',
                flags: match.flags,
                recorded_by: 0,
                recorded_by_name: 'Cached summary',
              },
              inRecord:
                match.in_at && match.mileage_in !== null && match.fuel_in
                  ? {
                      trip_id: match.id,
                      in_at: match.in_at,
                      device_time: null,
                      received_at: match.in_at,
                      mileage_in: match.mileage_in,
                      fuel_in: match.fuel_in,
                      closing_checklist_by: 'Cached summary',
                      notes: '',
                      recorded_by: 0,
                      recorded_by_name: 'Cached summary',
                      total_mileage: match.total_mileage ?? 0,
                      est_fuel_litres: match.est_fuel_litres ?? 0,
                      gauge_fuel_litres: match.gauge_fuel_litres ?? 0,
                      flags: match.flags,
                    }
                  : null,
              corrections: [],
            });
            setUsingCache(true);
            setCacheUpdatedAt(cachedAll?.updatedAt ?? null);
          } else {
            setError('You are offline and this trip’s details have not been cached yet.');
          }
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load trip details.');
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  useEffect(() => {
    const refreshOnReconnect = () => {
      void fetchTrips();
      if (selectedId !== null) {
        void loadDetail(selectedId);
      }
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, refreshOnReconnect);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, refreshOnReconnect);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, refreshOnReconnect);
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, refreshOnReconnect);
    };
  }, [fetchTrips, loadDetail, selectedId]);

  useEffect(() => {
    if (initialTripId) {
      loadDetail(initialTripId);
    }
  }, [initialTripId, loadDetail]);

  const openCorrectionModal = () => {
    if (!detail) return;
    setCorrTarget('trip_out');
    setCorrField('mileage_out');
    setCorrValue('');
    setCorrReason('');
    setCorrError(null);
    setShowCorrectModal(true);
  };

  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setCorrError(null);
    if (!corrValue.trim()) {
      setCorrError('Enter the corrected value.');
      return;
    }
    if (corrReason.trim().length < 5) {
      setCorrError('Enter a clear reason (at least 5 characters).');
      return;
    }

    setSavingCorr(true);
    try {
      const parsedVal =
        corrField === 'mileage_out' || corrField === 'mileage_in' || corrField === 'days_hired'
          ? Number(corrValue.trim())
          : corrValue.trim();

      await api.createTripCorrection(detail.trip.id, {
        target_table: corrTarget,
        field_changes: { [corrField]: parsedVal },
        reason: corrReason.trim(),
      });

      setShowCorrectModal(false);
      setCorrNotice('Correction recorded. The original entry remains visible for audit.');
      await loadDetail(detail.trip.id);
      await fetchTrips();
    } catch (err) {
      setCorrError(err instanceof ApiError ? err.message : 'Could not save correction.');
    } finally {
      setSavingCorr(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (selectedId !== null) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
              setCorrNotice(null);
            }}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Trips</span>
          </button>

          <div className="flex items-center gap-3">
            {detail?.trip.status === 'OPEN' && onRecordReturn && (
              <button
                type="button"
                onClick={() => onRecordReturn(detail.trip)}
                className="cyan-glow-btn min-h-[44px] rounded-xl px-4 text-sm font-semibold"
              >
                Record Return
              </button>
            )}
            {canCorrect && detail && (
              <button
                type="button"
                onClick={openCorrectionModal}
                className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
              >
                <Edit3 className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                <span>Add Correction Entry</span>
              </button>
            )}
          </div>
        </div>

        {usingCache && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
          >
            Offline mode — showing cached trip record
            {cacheUpdatedAt ? ` (last updated ${formatHarareTime(cacheUpdatedAt)} CAT)` : ''}. Will refresh automatically when connected.
          </div>
        )}
        {corrNotice && (
          <div
            role="status"
            className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
          >
            {corrNotice}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
          >
            {error}
          </div>
        )}

        {detailLoading || !detail ? (
          <div className="rounded-2xl border border-blue-200/80 bg-white p-6 text-base text-slate-600 shadow-xs">
            Loading trip record...
          </div>
        ) : (
          <>
            {/* Trip Summary Header */}
            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-4 shadow-xs">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-mono text-cyan-700 font-semibold">
                    Trip #{detail.trip.id} · {detail.trip.trip_type} · {detail.trip.status}
                    {detail.corrections.length > 0 && ' · Corrected'}
                  </div>
                  <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">
                    {detail.trip.reg_number} — {detail.trip.make_model}
                  </h1>
                  <div className="mt-1 text-base text-slate-700">
                    Driver: <span className="font-semibold text-blue-950">{detail.trip.driver_name}</span>
                    {detail.trip.client_name ? ` · Client: ${detail.trip.client_name}` : ''}
                    {detail.trip.destination ? ` · To: ${detail.trip.destination}` : ''}
                  </div>
                  {detail.trip.reason && (
                    <div className="mt-1 text-sm text-slate-600">Reason: {detail.trip.reason}</div>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs text-cyan-700 font-medium">
                  <Lock className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                  <span>Immutable Record</span>
                </div>
              </div>

              {/* Flags */}
              {detail.trip.flags.length > 0 && (
                <div className="space-y-2 pt-2">
                  {detail.trip.flags.map((flag, idx) => (
                    <div
                      key={`${flag.code}-${idx}`}
                      className={`flex items-start gap-2.5 rounded-xl border p-3.5 text-sm ${
                        flag.severity === 'HIGH'
                          ? 'border-red-200 bg-red-50 text-red-900'
                          : 'border-amber-200 bg-amber-50 text-amber-900'
                      }`}
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      <div>
                        <span className="font-semibold">{flag.code}:</span> {flag.message}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Out & In Side-by-Side */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-6 space-y-3">
                <h2 className="text-lg font-semibold text-blue-950">Departure (OUT)</h2>
                <dl className="divide-y divide-blue-100 text-sm">
                  <div className="py-2 flex justify-between gap-3">
                    <dt className="text-slate-500">Time Out (CAT)</dt>
                    <dd className="font-mono tabular-nums text-blue-950">
                      {formatHarareTime(detail.out.out_at)}
                    </dd>
                  </div>
                  <div className="py-2 flex justify-between gap-3">
                    <dt className="text-slate-500">Mileage Out</dt>
                    <dd className="font-mono tabular-nums font-semibold text-blue-950">
                      {detail.out.mileage_out.toLocaleString()} km
                    </dd>
                  </div>
                  <div className="py-2 flex justify-between gap-3">
                    <dt className="text-slate-500">Fuel Out</dt>
                    <dd className="font-mono font-semibold text-cyan-700">{detail.out.fuel_out}</dd>
                  </div>
                  {detail.trip.trip_type === 'HIRE' &&
                    (detail.trip.days_hired !== null || detail.trip.expected_return_date !== null) && (
                      <>
                        {detail.trip.days_hired !== null && (
                          <div className="py-2 flex justify-between gap-3">
                            <dt className="text-slate-500">Days Hired</dt>
                            <dd className="font-mono tabular-nums font-semibold text-blue-950">
                              {detail.trip.days_hired} day{detail.trip.days_hired === 1 ? '' : 's'}
                            </dd>
                          </div>
                        )}
                        {detail.trip.expected_return_date && (
                          <div className="py-2 flex justify-between gap-3">
                            <dt className="text-slate-500">Expected Return Date</dt>
                            <dd
                              className={`font-mono tabular-nums font-semibold ${
                                detail.trip.is_return_due || detail.trip.is_return_overdue
                                  ? 'text-red-700'
                                  : 'text-blue-950'
                              }`}
                            >
                              {detail.trip.expected_return_date}
                              {detail.trip.is_return_overdue
                                ? ' (Return Overdue)'
                                : detail.trip.is_return_due
                                  ? ' (Return Due)'
                                  : ''}
                            </dd>
                          </div>
                        )}
                      </>
                    )}
                  <div className="py-2 flex justify-between gap-3">
                    <dt className="text-slate-500">Checklist By</dt>
                    <dd className="text-blue-950">
                      {detail.out.opening_checklist_by || (
                        <span className="text-slate-400">Optional (not recorded)</span>
                      )}
                    </dd>
                  </div>
                  <div className="py-2 flex justify-between gap-3">
                    <dt className="text-slate-500">Recorded By</dt>
                    <dd className="text-blue-950">{detail.out.recorded_by_name}</dd>
                  </div>
                  {detail.out.notes && (
                    <div className="py-2">
                      <dt className="text-slate-500">Notes</dt>
                      <dd className="mt-1 text-slate-800">{detail.out.notes}</dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-6 space-y-3">
                <h2 className="text-lg font-semibold text-blue-950">Return (IN)</h2>
                {detail.inRecord ? (
                  <dl className="divide-y divide-blue-100 text-sm">
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Time In (CAT)</dt>
                      <dd className="font-mono tabular-nums text-blue-950">
                        {formatHarareTime(detail.inRecord.in_at)}
                      </dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Mileage In</dt>
                      <dd className="font-mono tabular-nums font-semibold text-blue-950">
                        {detail.inRecord.mileage_in.toLocaleString()} km
                      </dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Total Mileage</dt>
                      <dd className="font-mono tabular-nums font-bold text-blue-950">
                        {detail.inRecord.total_mileage.toLocaleString()} km
                      </dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Fuel In</dt>
                      <dd className="font-mono font-semibold text-cyan-700">
                        {detail.inRecord.fuel_in}
                      </dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Est. vs Gauge Fuel</dt>
                      <dd className="font-mono tabular-nums font-semibold text-blue-950">
                        {detail.inRecord.est_fuel_litres} L est · {detail.inRecord.gauge_fuel_litres} L gauge
                      </dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Checklist By</dt>
                      <dd className="text-blue-950">{detail.inRecord.closing_checklist_by}</dd>
                    </div>
                    <div className="py-2 flex justify-between gap-3">
                      <dt className="text-slate-500">Recorded By</dt>
                      <dd className="text-blue-950">{detail.inRecord.recorded_by_name}</dd>
                    </div>
                    {detail.inRecord.notes && (
                      <div className="py-2">
                        <dt className="text-slate-500">Notes</dt>
                        <dd className="mt-1 text-slate-800">{detail.inRecord.notes}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="text-base text-slate-600">
                    Vehicle is currently still out. Return record will appear here once closed.
                  </p>
                )}
              </div>
            </div>

            {/* Supervisor Corrections */}
            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-4 shadow-xs">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-semibold text-blue-950">
                  Supervisor Correction Entries ({detail.corrections.length})
                </h2>
              </div>
              {detail.corrections.length === 0 ? (
                <p className="text-base text-slate-600">
                  No corrections have been added to this trip.
                </p>
              ) : (
                <div className="divide-y divide-blue-100">
                  {detail.corrections.map((c) => (
                    <div key={c.id} className="py-3 space-y-1 text-sm">
                      <div className="font-semibold text-blue-950">
                        Corrected ({c.target_table}) · by {c.corrected_by_name}
                      </div>
                      <div className="text-slate-700">Reason: {c.reason}</div>
                      <div className="font-mono text-xs text-cyan-800">
                        Corrected values: {JSON.stringify(c.field_changes)}
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-500">
                        {formatHarareTime(c.created_at)} CAT
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Correction Modal */}
        {showCorrectModal && detail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
            <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
              <div className="flex items-center justify-between gap-4">
                <h2 className="font-display text-xl font-bold text-blue-950">
                  Add Correction Entry
                </h2>
                <button
                  type="button"
                  onClick={() => setShowCorrectModal(false)}
                  aria-label="Close"
                  className="cyan-glow-outline flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-transparent text-slate-500"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Original values stay intact for audit. This creates a linked correction note.
              </p>

              {corrError && (
                <div
                  role="alert"
                  className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800"
                >
                  {corrError}
                </div>
              )}

              <form onSubmit={handleSaveCorrection} className="mt-4 space-y-4">
                <div>
                  <label htmlFor="corr-target" className="block text-sm font-semibold text-blue-950">
                    Section to Correct
                  </label>
                  <select
                    id="corr-target"
                    value={corrTarget}
                    onChange={(e) => {
                      const val = e.target.value as 'trips' | 'trip_out' | 'trip_in';
                      setCorrTarget(val);
                      if (val === 'trip_out') setCorrField('mileage_out');
                      else if (val === 'trip_in') setCorrField('mileage_in');
                      else setCorrField('client_name');
                      setCorrValue('');
                    }}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    <option value="trip_out">Departure (OUT)</option>
                    {detail.inRecord && <option value="trip_in">Return (IN)</option>}
                    <option value="trips">Trip Header (Client / Destination)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="corr-field" className="block text-sm font-semibold text-blue-950">
                    Field
                  </label>
                  <select
                    id="corr-field"
                    value={corrField}
                    onChange={(e) => {
                      setCorrField(e.target.value);
                      setCorrValue('');
                    }}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    {corrTarget === 'trip_out' && (
                      <>
                        <option value="mileage_out">Mileage Out</option>
                        <option value="fuel_out">Fuel Out</option>
                        <option value="notes">Out Notes</option>
                      </>
                    )}
                    {corrTarget === 'trip_in' && (
                      <>
                        <option value="mileage_in">Mileage In</option>
                        <option value="fuel_in">Fuel In</option>
                        <option value="notes">Return Notes</option>
                      </>
                    )}
                    {corrTarget === 'trips' && (
                      <>
                        <option value="client_name">Client Name</option>
                        <option value="days_hired">Number of Days Hired</option>
                        <option value="expected_return_date">Expected Return Date</option>
                        <option value="destination">Destination</option>
                        <option value="reason">Reason</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label htmlFor="corr-val" className="block text-sm font-semibold text-blue-950">
                    Corrected Value
                  </label>
                  {corrField === 'fuel_out' || corrField === 'fuel_in' ? (
                    <select
                      id="corr-val"
                      value={corrValue}
                      onChange={(e) => setCorrValue(e.target.value as FuelLevel)}
                      required
                      className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                    >
                      <option value="">Choose fuel level...</option>
                      {FUEL_LEVELS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="corr-val"
                      type={
                        corrField === 'expected_return_date'
                          ? 'date'
                          : corrField.includes('mileage') || corrField === 'days_hired'
                            ? 'number'
                            : 'text'
                      }
                      required
                      value={corrValue}
                      onChange={(e) => setCorrValue(e.target.value)}
                      placeholder="Enter the correct value"
                      className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                    />
                  )}
                </div>

                <div>
                  <label htmlFor="corr-reason" className="block text-sm font-semibold text-blue-950">
                    Reason for Correction (required)
                  </label>
                  <textarea
                    id="corr-reason"
                    rows={2}
                    required
                    value={corrReason}
                    onChange={(e) => setCorrReason(e.target.value)}
                    placeholder="Explain why the original figure was wrong..."
                    className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3.5 text-base text-blue-950"
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={savingCorr}
                    className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-base font-semibold disabled:opacity-60"
                  >
                    {savingCorr ? 'Saving...' : 'Save Correction'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCorrectModal(false)}
                    className="cyan-glow-outline min-h-[48px] rounded-xl border border-blue-200 bg-white px-4 text-base font-medium text-blue-900"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-blue-950">Trips & Record Book</h1>
        <p className="mt-1 text-base text-slate-600">
          Every hire and errand recorded permanently. Tap any trip to view flags, fuel totals, or corrections.
        </p>
      </div>

      {usingCache && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
        >
          Offline mode — showing cached trips
          {cacheUpdatedAt ? ` (last updated ${formatHarareTime(cacheUpdatedAt)} CAT)` : ''}. Ready to refresh instantly on active connection.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
        >
          {error}
        </div>
      )}

      {/* Tabs: Ongoing | Finished | All */}
      <div className="inline-flex rounded-xl border border-blue-200/80 bg-blue-50/70 p-1">
        {(['OPEN', 'CLOSED', 'ALL'] as const).map((t) => {
          const label = t === 'OPEN' ? 'Ongoing' : t === 'CLOSED' ? 'Finished' : 'All Trips';
          return (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTab(t);
                setPage(1);
              }}
              className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-all whitespace-nowrap ${
                tab === t
                  ? 'cyan-glow-active'
                  : 'text-blue-900/70 hover:text-blue-950 hover:bg-white/60'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(searchInput.trim());
        }}
        className="rounded-2xl border border-blue-200/80 bg-white p-4 space-y-3 shadow-xs"
      >
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-cyan-600"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search reg number, driver, client, or destination..."
              className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 pl-11 pr-4 text-base text-blue-950 placeholder:text-slate-400"
            />
          </div>
          <button
            type="submit"
            className="cyan-glow-outline min-h-[48px] rounded-xl border border-blue-200 bg-blue-50/70 px-5 text-sm font-semibold text-blue-950 whitespace-nowrap shrink-0"
          >
            Search
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 items-center">
          <select
            aria-label="Filter by trip type"
            value={tripType}
            onChange={(e) => {
              setTripType(e.target.value as TripType | '');
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
          >
            <option value="">All types (Hire & Errand)</option>
            <option value="HIRE">Hires only</option>
            <option value="ERRAND">Errands only</option>
          </select>

          <input
            type="date"
            aria-label="From date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
          />

          <input
            type="date"
            aria-label="To date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
          />

          <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-blue-950 cursor-pointer">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => {
                setFlaggedOnly(e.target.checked);
                setPage(1);
              }}
              className="h-5 w-5 rounded border-blue-300 text-cyan-600 accent-cyan-600"
            />
            <span>Flagged trips only</span>
          </label>
        </div>
      </form>

      {/* Trips list */}
      <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
        {loading ? (
          <div className="p-6 text-base text-slate-500">Loading trips...</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-base text-slate-600">
            No trips match your filters yet.
          </div>
        ) : (
          <div className="divide-y divide-blue-100">
            {items.map((t) => (
              <div
                key={t.id}
                onClick={() => loadDetail(t.id)}
                className="p-4 sm:px-5 cursor-pointer hover:bg-cyan-50/45 transition-colors flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-blue-950">
                    <span className="font-mono text-blue-900">{t.reg_number}</span>
                    <span aria-hidden="true" className="text-blue-300">·</span>
                    <span>{t.driver_name}</span>
                    <span aria-hidden="true" className="text-blue-300">·</span>
                    <span className="text-sm font-medium text-slate-600">
                      {t.trip_type === 'HIRE' ? `Hire (${t.client_name})` : `Errand (${t.destination})`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">
                      Out: {formatHarareTime(t.out_at)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-cyan-800 font-medium">
                      {t.total_mileage !== null
                        ? `${t.total_mileage.toLocaleString()} km · Est. ${t.est_fuel_litres} L`
                        : `Left at ${t.mileage_out.toLocaleString()} km`}
                    </span>
                    {t.trip_type === 'HIRE' && t.days_hired !== null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-blue-800">
                          {t.days_hired}d hire
                        </span>
                      </>
                    )}
                    {t.trip_type === 'HIRE' && t.expected_return_date && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span
                          className={`font-mono tabular-nums font-medium ${
                            t.is_return_due || t.is_return_overdue
                              ? 'text-red-700 font-semibold'
                              : 'text-slate-600'
                          }`}
                        >
                          Due {t.expected_return_date}
                          {t.is_return_overdue
                            ? ' (Return Overdue)'
                            : t.is_return_due
                              ? ' (Return Due)'
                              : ''}
                        </span>
                      </>
                    )}
                    {t.correction_count > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-cyan-700">
                          Corrected ({t.correction_count})
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  {t.flags.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
                      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                      <span>{t.flags.map((f) => f.code).join(', ')}</span>
                    </span>
                  )}

                  {t.status === 'OPEN' ? (
                    <span
                      className={`inline-flex items-center gap-1 text-sm font-semibold ${
                        t.is_overdue || t.is_return_overdue || t.is_return_due
                          ? 'text-red-700'
                          : 'text-amber-700'
                      }`}
                    >
                      <Clock className="h-4 w-4" aria-hidden="true" />
                      <span>
                        {t.is_return_overdue || t.is_overdue
                          ? 'Overdue'
                          : t.is_return_due
                            ? 'Return Due'
                            : 'Ongoing'}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-cyan-700">
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      <span>Closed</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-slate-600 tabular-nums">
          Total: <span className="font-semibold text-blue-950">{total}</span> trips
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-blue-200 bg-white px-3.5 text-sm font-medium text-blue-900 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Prev</span>
          </button>
          <span className="px-2 text-sm font-mono tabular-nums text-blue-950">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-blue-200 bg-white px-3.5 text-sm font-medium text-blue-900 disabled:opacity-40"
          >
            <span>Next</span>
            <ChevronRight className="h-4 w-4 text-cyan-600" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
