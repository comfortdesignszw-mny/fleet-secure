import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Car,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Edit3,
  Plus,
  Search,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  CACHE_KEYS,
  ONLINE_RECONNECTED_EVENT,
  readCachedEntry,
  writeCachedEntry,
  type CachedVehicleDetail,
  type CachedVehiclesPayload,
} from '../lib/offlineCache';
import {
  OFFLINE_SYNCED_EVENT,
  enqueueOfflineEntry,
  isLikelyNetworkError,
} from '../lib/offlineQueue';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_TYPES,
  VEHICLE_TYPE_TO_CLASS,
  formatHarareTime,
  type AuditLogEntry,
  type DerivedStatus,
  type Role,
  type Vehicle,
  type VehicleCondition,
  type VehicleFuelType,
} from '../shared/types';

interface VehiclesViewProps {
  userRole: Role;
  initialVehicleId?: number | null;
  onOpenTrip?: (tripId: number) => void;
  onOpenMaintenance?: () => void;
}

const LEGACY_CACHE_KEY = 'fleet_secure_cache_vehicles';

function StatusIndicator({ status }: { status: DerivedStatus }) {
  if (status === 'Available') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-cyan-700">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Available</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700">
      <Car className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

function ConditionText({ condition }: { condition: VehicleCondition }) {
  if (condition === 'Accident' || condition === 'Grounded') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-700">
        <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{condition}</span>
      </span>
    );
  }
  if (condition === 'Bad Condition' || condition === 'Needs Little Attention') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{condition}</span>
      </span>
    );
  }
  return <span className="text-sm font-medium text-blue-900">{condition}</span>;
}

function canSupervisorPickCondition(
  oldCondition: VehicleCondition | null,
  candidate: VehicleCondition,
  isFleetAuth: boolean
): boolean {
  if (isFleetAuth) return true;
  if (candidate === 'Grounded' && oldCondition !== 'Grounded') return false;
  if (oldCondition === 'Grounded' && candidate !== 'Grounded') return false;
  if (
    oldCondition &&
    oldCondition !== candidate &&
    (candidate === 'Good' || candidate === 'Very Good') &&
    (oldCondition === 'Needs Little Attention' ||
      oldCondition === 'Bad Condition' ||
      oldCondition === 'Accident' ||
      oldCondition === 'Grounded')
  ) {
    return false;
  }
  return true;
}

export const VehiclesView: React.FC<VehiclesViewProps> = ({
  userRole,
  initialVehicleId = null,
  onOpenTrip,
  onOpenMaintenance,
}) => {
  const canManage =
    userRole === 'SUPERVISOR' || userRole === 'FLEET_MANAGER' || userRole === 'ADMIN';
  const canAuthorizeGrounded = userRole === 'FLEET_MANAGER' || userRole === 'ADMIN';
  const canMaintain = userRole === 'FLEET_MANAGER' || userRole === 'ADMIN';

  const [items, setItems] = useState<Vehicle[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 25;

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [classFilter, setClassFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const [loading, setLoading] = useState(true);
  const [usingCache, setUsingCache] = useState(false);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Detail view
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [detailTrips, setDetailTrips] = useState<
    Array<{
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
    }>
  >([]);
  const [conditionHistory, setConditionHistory] = useState<AuditLogEntry[]>([]);
  const [detailChecklists, setDetailChecklists] = useState<
    NonNullable<CachedVehicleDetail['checklists']>
  >([]);

  // Create / Edit modal
  const [showForm, setShowForm] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [formReg, setFormReg] = useState('');
  const [formType, setFormType] = useState<string>(VEHICLE_TYPES[0]);
  const [formMakeModel, setFormMakeModel] = useState('');
  const [formColour, setFormColour] = useState('');
  const [formFuelType, setFormFuelType] = useState<VehicleFuelType>('diesel');
  const [formCondition, setFormCondition] = useState<VehicleCondition>('Good');
  const [formMileage, setFormMileage] = useState('0');
  const [formNextServiceDueKm, setFormNextServiceDueKm] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const applyOfflineVehicleFilters = useCallback(
    (rawList: Vehicle[]): { paged: Vehicle[]; total: number } => {
      const q = query.trim().toLowerCase();
      const filtered = rawList.filter((v) => {
        if (!includeInactive && !v.active) return false;
        if (statusFilter && v.derived_status !== statusFilter) return false;
        if (conditionFilter && v.condition !== conditionFilter) return false;
        if (classFilter && v.vehicle_class !== classFilter) return false;
        if (q) {
          const hay = [v.reg_number, v.make_model, v.vehicle_type, v.vehicle_class]
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
    [query, statusFilter, conditionFilter, classFilter, includeInactive, page]
  );

  const fetchVehicles = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    try {
      const res = await api.listVehicles({
        q: query,
        status: statusFilter,
        condition: conditionFilter,
        vehicle_class: classFilter,
        includeInactive,
        page,
        limit,
      });
      setItems(res.items);
      setTotal(res.total);

      if (!query && !statusFilter && !conditionFilter && !classFilter && page === 1) {
        const existingCache = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
        const existingInactive =
          !includeInactive && existingCache
            ? existingCache.data.items.filter((v) => !v.active)
            : [];
        const merged = [
          ...res.items,
          ...existingInactive.filter((old) => !res.items.some((r) => r.id === old.id)),
        ];
        writeCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll, {
          items: merged,
          total: includeInactive ? res.total : merged.length,
        });
      }
      try {
        localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(res.items));
      } catch {
        // Ignore storage quota errors
      }
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cachedV2 = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
        let rawList: Vehicle[] | null = cachedV2?.data.items ?? null;
        const updatedAt = cachedV2?.updatedAt ?? null;
        if (!rawList) {
          try {
            const legacy = localStorage.getItem(LEGACY_CACHE_KEY);
            if (legacy) rawList = JSON.parse(legacy) as Vehicle[];
          } catch {
            // Ignore
          }
        }
        if (rawList) {
          const applied = applyOfflineVehicleFilters(rawList);
          setItems(applied.paged);
          setTotal(applied.total);
          setUsingCache(true);
          setCacheUpdatedAt(updatedAt);
        } else {
          setError('Offline mode — no cached vehicle list saved yet.');
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load vehicles.');
      }
    } finally {
      setLoading(false);
    }
  }, [
    query,
    statusFilter,
    conditionFilter,
    classFilter,
    includeInactive,
    page,
    applyOfflineVehicleFilters,
  ]);

  const loadVehicleDetail = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetailLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    try {
      const res = await api.getVehicle(id);
      setDetailVehicle(res.vehicle);
      setDetailTrips(res.trips);
      setConditionHistory(res.conditionHistory);
      setDetailChecklists(res.checklists ?? []);
      writeCachedEntry<CachedVehicleDetail>(CACHE_KEYS.vehicleDetail(id), {
        vehicle: res.vehicle,
        trips: res.trips,
        conditionHistory: res.conditionHistory,
        checklists: res.checklists ?? [],
      });
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cachedDetail = readCachedEntry<CachedVehicleDetail>(CACHE_KEYS.vehicleDetail(id));
        if (cachedDetail) {
          setDetailVehicle(cachedDetail.data.vehicle);
          setDetailTrips(cachedDetail.data.trips);
          setConditionHistory(cachedDetail.data.conditionHistory);
          setDetailChecklists(cachedDetail.data.checklists ?? []);
          setUsingCache(true);
          setCacheUpdatedAt(cachedDetail.updatedAt);
        } else {
          const cachedAll = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
          const listMatch = cachedAll?.data.items.find((v) => v.id === id);
          if (listMatch) {
            setDetailVehicle(listMatch);
            setDetailTrips([]);
            setConditionHistory([]);
            setDetailChecklists([]);
            setUsingCache(true);
            setCacheUpdatedAt(cachedAll?.updatedAt ?? null);
          } else {
            setError('You are offline and this vehicle’s details have not been cached yet.');
          }
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load vehicle details.');
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVehicles();
  }, [fetchVehicles]);

  useEffect(() => {
    const refreshOnReconnect = () => {
      void fetchVehicles();
      if (selectedId !== null && selectedId > 0) {
        void loadVehicleDetail(selectedId);
      }
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, refreshOnReconnect);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, refreshOnReconnect);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, refreshOnReconnect);
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, refreshOnReconnect);
    };
  }, [fetchVehicles, loadVehicleDetail, selectedId]);

  useEffect(() => {
    if (initialVehicleId) {
      loadVehicleDetail(initialVehicleId);
    }
  }, [initialVehicleId, loadVehicleDetail]);

  const openCreateModal = () => {
    setEditingVehicle(null);
    setFormReg('');
    setFormType(VEHICLE_TYPES[0]);
    setFormMakeModel('');
    setFormColour('');
    setFormFuelType('diesel');
    setFormCondition('Good');
    setFormMileage('0');
    setFormNextServiceDueKm('');
    setFormActive(true);
    setFormError(null);
    setShowForm(true);
  };

  const openEditModal = (v: Vehicle) => {
    setEditingVehicle(v);
    setFormReg(v.reg_number);
    setFormType(v.vehicle_type);
    setFormMakeModel(v.make_model);
    setFormColour(v.colour ?? '');
    setFormFuelType(v.fuel_type ?? 'diesel');
    setFormCondition(v.condition);
    setFormMileage(String(v.last_known_mileage));
    setFormNextServiceDueKm(
      v.next_service_due_km !== null && v.next_service_due_km !== undefined
        ? String(v.next_service_due_km)
        : ''
    );
    setFormActive(v.active);
    setFormError(null);
    setShowForm(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const mileageNum = Number(formMileage);
      if (!Number.isInteger(mileageNum) || mileageNum < 0) {
        setFormError('Mileage must be a whole number 0 or greater.');
        setSaving(false);
        return;
      }

      const nextDueVal =
        formNextServiceDueKm.trim() === '' ? null : Number(formNextServiceDueKm);
      if (nextDueVal !== null && (!Number.isInteger(nextDueVal) || nextDueVal < 0)) {
        setFormError('Next service due mileage must be a whole number 0 or greater.');
        setSaving(false);
        return;
      }

      if (editingVehicle) {
        const res = await api.updateVehicle(editingVehicle.id, {
          reg_number: formReg.trim(),
          vehicle_type: formType,
          make_model: formMakeModel.trim(),
          colour: formColour.trim() || null,
          fuel_type: formFuelType,
          condition: formCondition,
          last_known_mileage: mileageNum,
          ...(canMaintain ? { next_service_due_km: nextDueVal } : {}),
          active: formActive,
        });
        setShowForm(false);
        setNotice(`Updated ${res.vehicle.reg_number} (${res.vehicle.make_model}).`);
        if (selectedId === res.vehicle.id) {
          await loadVehicleDetail(res.vehicle.id);
        }
        await fetchVehicles();
      } else {
        const payload = {
          reg_number: formReg.trim().toUpperCase().replace(/\s+/g, ' '),
          vehicle_type: formType,
          make_model: formMakeModel.trim(),
          colour: formColour.trim() || null,
          fuel_type: formFuelType,
          condition: formCondition,
          last_known_mileage: mileageNum,
          ...(canMaintain && nextDueVal !== null ? { next_service_due_km: nextDueVal } : {}),
        };
        try {
          const res = await api.createVehicle(payload);
          setShowForm(false);
          setNotice(`Added ${res.vehicle.reg_number} (${res.vehicle.make_model}) to the fleet.`);
          await fetchVehicles();
        } catch (err) {
          if (isLikelyNetworkError(err)) {
            enqueueOfflineEntry({
              kind: 'VEHICLE_CREATE',
              summaryLabel: `Add Vehicle · ${payload.reg_number}`,
              payload,
            });
            const optimisticVehicle: Vehicle = {
              id: -Date.now(),
              reg_number: payload.reg_number,
              vehicle_type: payload.vehicle_type,
              vehicle_class: VEHICLE_TYPE_TO_CLASS[payload.vehicle_type] ?? 'ECONOMY',
              make_model: payload.make_model,
              condition: payload.condition,
              last_known_mileage: payload.last_known_mileage,
              active: true,
              created_at: new Date().toISOString(),
              derived_status: 'Available',
              open_trip_id: null,
            };
            const cachedV2 = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
            const nextCachedList = [optimisticVehicle, ...(cachedV2?.data.items ?? items)];
            writeCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll, {
              items: nextCachedList,
              total: nextCachedList.length,
            });
            const nextList = [optimisticVehicle, ...items];
            setItems(nextList);
            setTotal(nextList.length);
            try {
              localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(nextList));
            } catch {
              // Ignore quota errors
            }
            setShowForm(false);
            setNotice(
              `Saved vehicle "${payload.reg_number}" offline in local cache. Will sync automatically when connected.`
            );
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save vehicle.');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickCondition = async (v: Vehicle, nextCondition: VehicleCondition) => {
    if (nextCondition === v.condition) return;
    setError(null);
    try {
      const res = await api.updateVehicle(v.id, { condition: nextCondition });
      setNotice(
        `Condition for ${res.vehicle.reg_number} changed to "${res.vehicle.condition}" and logged.`
      );
      if (selectedId === v.id) {
        await loadVehicleDetail(v.id);
      }
      await fetchVehicles();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update vehicle condition.');
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
              setDetailVehicle(null);
            }}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Vehicles</span>
          </button>

          <div className="flex flex-wrap items-center gap-2.5">
            {onOpenMaintenance && (
              <button
                type="button"
                onClick={onOpenMaintenance}
                className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
              >
                <Wrench className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                <span>Fleet Maintenance</span>
              </button>
            )}
            {canManage && detailVehicle && (
              <button
                type="button"
                onClick={() => openEditModal(detailVehicle)}
                className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold"
              >
                <Edit3 className="h-4 w-4" aria-hidden="true" />
                <span>Edit Vehicle</span>
              </button>
            )}
          </div>
        </div>

        {usingCache && (
          <div
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
          >
            Offline mode — showing cached vehicle details
            {cacheUpdatedAt ? ` (last updated ${formatHarareTime(cacheUpdatedAt)} CAT)` : ''}. Will refresh automatically when connected.
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
          >
            {notice}
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

        {detailLoading || !detailVehicle ? (
          <div className="rounded-2xl border border-blue-200/80 bg-white p-6 text-base text-slate-600 shadow-xs">
            Loading vehicle record...
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-medium text-cyan-700">
                    {detailVehicle.vehicle_type} · {detailVehicle.vehicle_class}
                    {detailVehicle.colour ? ` · ${detailVehicle.colour}` : ''}
                    {detailVehicle.fuel_type ? ` · ${detailVehicle.fuel_type.toUpperCase()}` : ''}
                    {!detailVehicle.active && ' · Inactive'}
                  </div>
                  <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">
                    {detailVehicle.reg_number} — {detailVehicle.make_model}
                  </h1>
                </div>
                <div className="flex flex-col sm:items-end gap-1">
                  <StatusIndicator status={detailVehicle.derived_status} />
                  <div className="text-sm font-mono tabular-nums text-slate-600">
                    Odometer: {detailVehicle.last_known_mileage.toLocaleString()} km
                  </div>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 border-t border-blue-100 pt-5 sm:grid-cols-4">
                <div>
                  <div className="text-xs font-medium text-slate-500">Current Condition</div>
                  <div className="mt-1">
                    <ConditionText condition={detailVehicle.condition} />
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Next Service Due</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-blue-950">
                    {detailVehicle.next_service_due_km !== null &&
                    detailVehicle.next_service_due_km !== undefined
                      ? `${detailVehicle.next_service_due_km.toLocaleString()} km`
                      : 'Not set'}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Recorded Trips</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-blue-950">
                    {detailVehicle.trip_count ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Tracked Trip Distance</div>
                  <div className="mt-1 text-base font-semibold font-mono tabular-nums text-cyan-700">
                    {(detailVehicle.total_trip_mileage ?? 0).toLocaleString()} km
                  </div>
                </div>
              </div>

              {canManage && (
                <div className="mt-6 border-t border-blue-100 pt-5">
                  <label
                    htmlFor="detail-condition-select"
                    className="block text-sm font-semibold text-blue-950"
                  >
                    Update Vehicle Condition (Logged Automatically)
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Vehicles marked &ldquo;Accident&rdquo; or &ldquo;Grounded&rdquo; cannot be booked out on trips. Only Fleet Manager / Supervisor or Admin can mark a vehicle Grounded or restore a Grounded vehicle back to Good / Very Good.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {VEHICLE_CONDITIONS.map((cond) => {
                      const allowed = canSupervisorPickCondition(
                        detailVehicle.condition,
                        cond,
                        canAuthorizeGrounded
                      );
                      return (
                        <button
                          key={cond}
                          type="button"
                          disabled={!allowed}
                          title={
                            !allowed
                              ? 'Fleet Manager / Supervisor or Admin authorization required'
                              : undefined
                          }
                          onClick={() => handleQuickCondition(detailVehicle, cond)}
                          className={`min-h-[44px] rounded-xl border px-3.5 text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                            detailVehicle.condition === cond
                              ? 'cyan-glow-active'
                              : 'cyan-glow-outline border-blue-200 bg-white text-blue-900'
                          }`}
                        >
                          {cond}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <h2 className="text-lg font-semibold text-blue-950">Vehicle Trip History</h2>
              {detailTrips.length === 0 ? (
                <p className="mt-2 text-base text-slate-600">
                  No trips recorded for this vehicle yet.
                </p>
              ) : (
                <div className="mt-4 divide-y divide-blue-100">
                  {detailTrips.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => onOpenTrip?.(t.id)}
                      className={`py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between ${
                        onOpenTrip ? 'cursor-pointer hover:bg-cyan-50/45 rounded-lg px-2 -mx-2 transition-colors' : ''
                      }`}
                    >
                      <div>
                        <div className="text-sm font-semibold text-blue-950">
                          {t.trip_type} · {t.driver_name}
                          {t.client_name ? ` · Client: ${t.client_name}` : ''}
                          {t.destination ? ` · ${t.destination}` : ''}
                        </div>
                        <div className="text-xs font-mono tabular-nums text-slate-500">
                          Out: {formatHarareTime(t.out_at)} · In: {formatHarareTime(t.in_at)}
                          {t.trip_type === 'HIRE' && t.days_hired !== null ? ` · ${t.days_hired}d` : ''}
                          {t.trip_type === 'HIRE' && t.expected_return_date
                            ? ` · Due ${t.expected_return_date}`
                            : ''}
                        </div>
                      </div>
                      <div className="text-sm font-mono tabular-nums text-cyan-800 font-semibold">
                        {t.total_mileage !== null ? `${t.total_mileage.toLocaleString()} km` : t.status}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <h2 className="flex items-center gap-2 text-lg font-semibold text-blue-950">
                <ClipboardCheck className="h-5 w-5 text-cyan-600" aria-hidden="true" />
                <span>Digital Vehicle Checklists ({detailChecklists.length})</span>
              </h2>
              {detailChecklists.length === 0 ? (
                <p className="mt-2 text-base text-slate-600">
                  No inspection checklists recorded for this vehicle yet.
                </p>
              ) : (
                <div className="mt-4 divide-y divide-blue-100">
                  {detailChecklists.map((chk) => (
                    <div key={chk.id} className="py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-blue-950">
                          Checklist #{chk.id} · {chk.hirer_type === 'owner' ? 'Owner:' : 'Renter:'} {chk.hirer_name}
                        </div>
                        <div className="text-xs font-mono tabular-nums text-slate-500">
                          Out {chk.hire_date} · {chk.return_date ? `Return ${chk.return_date}` : 'Return Optional'} · {chk.mileage_out.toLocaleString()} km
                          {chk.mileage_in !== null ? ` → ${chk.mileage_in.toLocaleString()} km` : ''}
                        </div>
                      </div>
                      <span
                        className={`self-start sm:self-center rounded-lg px-2.5 py-0.5 text-xs font-bold ${
                          chk.status === 'completed'
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : 'bg-amber-50 text-amber-900 border border-amber-300'
                        }`}
                      >
                        {chk.status === 'completed' ? 'Completed' : 'Out (open)'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <h2 className="text-lg font-semibold text-blue-950">Directory & Condition Changes</h2>
              {conditionHistory.length === 0 ? (
                <p className="mt-2 text-base text-slate-600">No changes logged yet.</p>
              ) : (
                <div className="mt-4 divide-y divide-blue-100">
                  {conditionHistory.map((h) => (
                    <div key={h.id} className="py-3 text-sm">
                      <div className="font-semibold text-blue-950">
                        {h.action} · {h.username} ({h.user_role})
                      </div>
                      <div className="text-xs font-mono tabular-nums text-slate-500">
                        {formatHarareTime(h.ts)} CAT
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Vehicles (Fleet Directory)</h1>
          <p className="mt-1 text-base text-slate-600">
            View fleet availability, condition, and odometer readings. Tap any vehicle for full history.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={openCreateModal}
            className="cyan-glow-btn inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap shrink-0"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
            <span>Add Vehicle</span>
          </button>
        )}
      </div>

      {usingCache && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
        >
          Offline mode — showing cached vehicles database
          {cacheUpdatedAt ? ` (last updated ${formatHarareTime(cacheUpdatedAt)} CAT)` : ''}. Ready to refresh instantly on active connection.
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
        >
          {notice}
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

      {/* Search & Filter Bar */}
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
              placeholder="Search registration, make, or model..."
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4 items-center">
          <select
            aria-label="Filter by availability"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
          >
            <option value="">All availability</option>
            <option value="Available">Available</option>
            <option value="Out on Hire">Out on Hire</option>
            <option value="Out on Errand">Out on Errand</option>
          </select>

          <select
            aria-label="Filter by condition"
            value={conditionFilter}
            onChange={(e) => {
              setConditionFilter(e.target.value);
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
          >
            <option value="">All conditions</option>
            {VEHICLE_CONDITIONS.map((cond) => (
              <option key={cond} value={cond}>
                {cond}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by vehicle class"
            value={classFilter}
            onChange={(e) => {
              setClassFilter(e.target.value);
              setPage(1);
            }}
            className="cyan-glow-input min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
          >
            <option value="">All classes</option>
            <option value="ECONOMY">Economy (60L · 10 km/L)</option>
            <option value="HEAVY">Heavy (80L · 8 km/L)</option>
          </select>

          {canManage && (
            <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-blue-950 cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => {
                  setIncludeInactive(e.target.checked);
                  setPage(1);
                }}
                className="h-5 w-5 rounded border-blue-300 text-cyan-600 accent-cyan-600"
              />
              <span>Show disabled vehicles</span>
            </label>
          )}
        </div>
      </form>

      {/* Vehicles List / Table */}
      <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
        {loading ? (
          <div className="p-6 text-base text-slate-500">Loading vehicles...</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-base text-slate-600">No vehicles match your search.</p>
            {canManage && (
              <button
                type="button"
                onClick={openCreateModal}
                className="cyan-glow-btn inline-flex min-h-[48px] items-center gap-2 rounded-xl px-5 text-sm font-semibold"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Add First Vehicle</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-blue-100 bg-blue-50/60 text-xs font-semibold text-blue-900">
                    <th className="py-3 px-4">Registration</th>
                    <th className="py-3 px-4">Make & Model</th>
                    <th className="py-3 px-4">Type & Class</th>
                    <th className="py-3 px-4">Condition</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Mileage</th>
                    {canManage && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100 text-sm">
                  {items.map((v) => (
                    <tr
                      key={v.id}
                      onClick={() => loadVehicleDetail(v.id)}
                      className="cursor-pointer hover:bg-cyan-50/45 transition-colors"
                    >
                      <td className="py-3.5 px-4 font-mono font-semibold text-blue-950">
                        {v.reg_number}
                        {!v.active && (
                          <span className="ml-2 text-xs font-sans text-red-700">(Disabled)</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-medium text-blue-950">{v.make_model}</td>
                      <td className="py-3.5 px-4 text-slate-600">
                        {v.vehicle_type} · {v.vehicle_class}
                      </td>
                      <td className="py-3.5 px-4">
                        <ConditionText condition={v.condition} />
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusIndicator status={v.derived_status} />
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-blue-950">
                        {v.last_known_mileage.toLocaleString()} km
                      </td>
                      {canManage && (
                        <td
                          className="py-2 px-4 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => openEditModal(v)}
                            className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                          >
                            <Wrench className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                            <span>Manage</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="divide-y divide-blue-100 md:hidden">
              {items.map((v) => (
                <div
                  key={v.id}
                  onClick={() => loadVehicleDetail(v.id)}
                  className="p-4 space-y-2 cursor-pointer hover:bg-cyan-50/40 active:bg-cyan-50/70 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-base font-bold text-blue-950">
                        {v.reg_number}
                        {!v.active && (
                          <span className="ml-2 font-sans text-xs font-medium text-red-700">
                            Disabled
                          </span>
                        )}
                      </div>
                      <div className="text-base font-medium text-blue-900">{v.make_model}</div>
                    </div>
                    <StatusIndicator status={v.derived_status} />
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <span>
                      {v.vehicle_type} · {v.vehicle_class}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums text-cyan-800 font-medium">
                      {v.last_known_mileage.toLocaleString()} km
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <ConditionText condition={v.condition} />
                    {canManage && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(v);
                        }}
                        className="cyan-glow-outline min-h-[44px] rounded-lg border border-blue-200 bg-white px-3.5 text-sm font-semibold text-blue-900"
                      >
                        Manage
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-slate-600 tabular-nums">
          Total: <span className="font-semibold text-blue-950">{total}</span> vehicles
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

      {/* Add / Edit Vehicle Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-8">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-bold text-blue-950">
                {editingVehicle ? `Edit ${editingVehicle.reg_number}` : 'Add New Vehicle'}
              </h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                aria-label="Close"
                className="cyan-glow-outline flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-transparent text-slate-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm font-medium text-red-800"
              >
                {formError}
              </div>
            )}

            <form onSubmit={handleFormSubmit} className="mt-4 space-y-4">
              <div>
                <label htmlFor="v-reg" className="block text-sm font-semibold text-blue-950">
                  Registration Number
                </label>
                <input
                  id="v-reg"
                  type="text"
                  required
                  value={formReg}
                  onChange={(e) => setFormReg(e.target.value)}
                  placeholder="e.g. AFX 4821"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="v-type" className="block text-sm font-semibold text-blue-950">
                  Vehicle Type
                </label>
                <select
                  id="v-type"
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                >
                  {VEHICLE_TYPES.map((vt) => (
                    <option key={vt} value={vt}>
                      {vt} ({VEHICLE_TYPE_TO_CLASS[vt]})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  Fuel class assigned automatically:{' '}
                  <span className="font-semibold text-cyan-700">
                    {VEHICLE_TYPE_TO_CLASS[formType] ?? 'ECONOMY'}
                  </span>
                </p>
              </div>

              <div>
                <label htmlFor="v-make" className="block text-sm font-semibold text-blue-950">
                  Make &amp; Model
                </label>
                <input
                  id="v-make"
                  type="text"
                  required
                  value={formMakeModel}
                  onChange={(e) => setFormMakeModel(e.target.value)}
                  placeholder="e.g. Toyota Hilux GD-6"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="v-colour" className="block text-sm font-semibold text-blue-950">
                    Colour (optional)
                  </label>
                  <input
                    id="v-colour"
                    type="text"
                    value={formColour}
                    onChange={(e) => setFormColour(e.target.value)}
                    placeholder="e.g. White"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="v-fuel-type" className="block text-sm font-semibold text-blue-950">
                    Fuel Type
                  </label>
                  <select
                    id="v-fuel-type"
                    value={formFuelType}
                    onChange={(e) => setFormFuelType(e.target.value as VehicleFuelType)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    {VEHICLE_FUEL_TYPES.map((ft) => (
                      <option key={ft.value} value={ft.value}>
                        {ft.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="v-cond" className="block text-sm font-semibold text-blue-950">
                  Vehicle Condition
                </label>
                <select
                  id="v-cond"
                  value={formCondition}
                  onChange={(e) => setFormCondition(e.target.value as VehicleCondition)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                >
                  {VEHICLE_CONDITIONS.map((cond) => {
                    const allowed = canSupervisorPickCondition(
                      editingVehicle?.condition ?? null,
                      cond,
                      canAuthorizeGrounded
                    );
                    return (
                      <option key={cond} value={cond} disabled={!allowed}>
                        {cond}
                        {!allowed ? ' (Fleet Manager / Admin only)' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label htmlFor="v-mileage" className="block text-sm font-semibold text-blue-950">
                  Current Odometer (km)
                </label>
                <input
                  id="v-mileage"
                  type="number"
                  min={0}
                  step="1"
                  required
                  value={formMileage}
                  onChange={(e) => setFormMileage(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              {canMaintain && (
                <div>
                  <label htmlFor="v-next-due" className="block text-sm font-semibold text-blue-950">
                    Next Service Due (km, optional)
                  </label>
                  <input
                    id="v-next-due"
                    type="number"
                    min={0}
                    step="1"
                    value={formNextServiceDueKm}
                    onChange={(e) => setFormNextServiceDueKm(e.target.value)}
                    placeholder="e.g. 135000"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                  />
                </div>
              )}

              {editingVehicle && (
                <div className="flex items-center justify-between rounded-xl border border-blue-200 p-3.5 bg-blue-50/30">
                  <div>
                    <div className="text-sm font-semibold text-blue-950">Vehicle Active</div>
                    <div className="text-xs text-slate-500">
                      {!editingVehicle.active && !canAuthorizeGrounded
                        ? 'Fleet Manager or Admin authorization required to reactivate'
                        : 'Uncheck to retire a vehicle without deleting its history'}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={formActive}
                    disabled={!editingVehicle.active && !canAuthorizeGrounded}
                    onChange={(e) => setFormActive(e.target.checked)}
                    aria-label="Vehicle active"
                    className="h-6 w-6 rounded border-blue-300 text-cyan-600 accent-cyan-600 disabled:opacity-40"
                  />
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-base font-semibold disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingVehicle ? 'Save Changes' : 'Add Vehicle'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
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
};
