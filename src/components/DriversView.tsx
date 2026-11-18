import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Phone,
  Plus,
  Search,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  formatHarareTime,
  type DerivedStatus,
  type Driver,
  type LicenceStatus,
  type Role,
} from '../shared/types';

interface DriversViewProps {
  userRole: Role;
  initialDriverId?: number | null;
  onOpenTrip?: (tripId: number) => void;
}

const CACHE_KEY = 'fleet_secure_cache_drivers';

function DriverStatusText({ status }: { status: DerivedStatus }) {
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
      <UserCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

function LicenceExpiryIndicator({
  status,
  expiry,
  days,
}: {
  status: LicenceStatus;
  expiry: string | null;
  days: number | null;
}) {
  if (status === 'EXPIRED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-700">
        <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Expired ({expiry})
        </span>
      </span>
    );
  }
  if (status === 'EXPIRING_SOON') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          Expires in {days} day{days === 1 ? '' : 's'} ({expiry})
        </span>
      </span>
    );
  }
  if (status === 'OK' && expiry) {
    return <span className="text-sm font-mono tabular-nums text-blue-950">{expiry}</span>;
  }
  return <span className="text-sm text-slate-400">Not recorded</span>;
}

export const DriversView: React.FC<DriversViewProps> = ({
  userRole,
  initialDriverId = null,
  onOpenTrip,
}) => {
  const canManage = userRole === 'SUPERVISOR' || userRole === 'ADMIN';

  const [items, setItems] = useState<Driver[]>([]);
  const [total, setTotal] = useState(0);
  const [expiringCount, setExpiringCount] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 25;

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [loading, setLoading] = useState(true);
  const [usingCache, setUsingCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Detail view
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailDriver, setDetailDriver] = useState<Driver | null>(null);
  const [detailTrips, setDetailTrips] = useState<
    Array<{
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
    }>
  >([]);

  // Create / Edit modal
  const [showForm, setShowForm] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | null>(null);
  const [formName, setFormName] = useState('');
  const [formLicence, setFormLicence] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formExpiry, setFormExpiry] = useState('');
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchDrivers = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingCache(false);
    try {
      const res = await api.listDrivers({
        q: query,
        status: statusFilter,
        expiring: expiringOnly,
        includeInactive,
        page,
        limit,
      });
      setItems(res.items);
      setTotal(res.total);
      setExpiringCount(res.expiringCount);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(res.items));
      } catch {
        // Ignore quota errors
      }
    } catch (err) {
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as Driver[];
          setItems(parsed);
          setTotal(parsed.length);
          setUsingCache(true);
        } else {
          setError(err instanceof ApiError ? err.message : 'Could not load drivers.');
        }
      } catch {
        setError(err instanceof ApiError ? err.message : 'Could not load drivers.');
      }
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter, expiringOnly, includeInactive, page]);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  const loadDriverDetail = useCallback(async (id: number) => {
    setSelectedId(id);
    setDetailLoading(true);
    setError(null);
    try {
      const res = await api.getDriver(id);
      setDetailDriver(res.driver);
      setDetailTrips(res.trips);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load driver details.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialDriverId) {
      loadDriverDetail(initialDriverId);
    }
  }, [initialDriverId, loadDriverDetail]);

  const openCreateModal = () => {
    setEditingDriver(null);
    setFormName('');
    setFormLicence('');
    setFormPhone('');
    setFormAddress('');
    setFormExpiry('');
    setFormActive(true);
    setFormError(null);
    setShowForm(true);
  };

  const openEditModal = (d: Driver) => {
    setEditingDriver(d);
    setFormName(d.full_name);
    setFormLicence(d.licence_number);
    setFormPhone(d.phone);
    setFormAddress(d.address);
    setFormExpiry(d.licence_expiry ?? '');
    setFormActive(d.active);
    setFormError(null);
    setShowForm(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (editingDriver) {
        const res = await api.updateDriver(editingDriver.id, {
          full_name: formName.trim(),
          licence_number: formLicence.trim(),
          phone: formPhone.trim(),
          address: formAddress.trim(),
          licence_expiry: formExpiry.trim() ? formExpiry.trim() : null,
          active: formActive,
        });
        setShowForm(false);
        setNotice(`Updated driver ${res.driver.full_name}.`);
        if (selectedId === res.driver.id) {
          await loadDriverDetail(res.driver.id);
        }
      } else {
        const res = await api.createDriver({
          full_name: formName.trim(),
          licence_number: formLicence.trim(),
          phone: formPhone.trim(),
          address: formAddress.trim(),
          licence_expiry: formExpiry.trim() ? formExpiry.trim() : null,
        });
        setShowForm(false);
        setNotice(`Added driver ${res.driver.full_name} to the directory.`);
      }
      await fetchDrivers();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save driver.');
    } finally {
      setSaving(false);
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
              setDetailDriver(null);
            }}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Drivers</span>
          </button>

          {canManage && detailDriver && (
            <button
              type="button"
              onClick={() => openEditModal(detailDriver)}
              className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold"
            >
              <Edit3 className="h-4 w-4" aria-hidden="true" />
              <span>Edit Driver</span>
            </button>
          )}
        </div>

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

        {detailLoading || !detailDriver ? (
          <div className="rounded-2xl border border-blue-200/80 bg-white p-6 text-base text-slate-600 shadow-xs">
            Loading driver record...
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-mono text-cyan-700 font-medium">
                    Licence: {detailDriver.licence_number}
                    {!detailDriver.active && ' · Inactive'}
                  </div>
                  <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">
                    {detailDriver.full_name}
                  </h1>
                </div>
                <DriverStatusText status={detailDriver.derived_status} />
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 border-t border-blue-100 pt-5 sm:grid-cols-3">
                <div>
                  <div className="text-xs font-medium text-slate-500">Phone Number</div>
                  <div className="mt-1 flex items-center gap-1.5 text-base font-medium text-blue-950">
                    <Phone className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                    <span className="font-mono">{detailDriver.phone}</span>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-medium text-slate-500">Licence Expiry</div>
                  <div className="mt-1">
                    <LicenceExpiryIndicator
                      status={detailDriver.licence_status}
                      expiry={detailDriver.licence_expiry}
                      days={detailDriver.days_to_expiry}
                    />
                  </div>
                </div>

                <div>
                  <div className="text-xs font-medium text-slate-500">Home Address</div>
                  <div className="mt-1 text-base text-slate-800">
                    {detailDriver.address || '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs">
              <h2 className="text-lg font-semibold text-blue-950">Driver Trip History</h2>
              {detailTrips.length === 0 ? (
                <p className="mt-2 text-base text-slate-600">
                  No trips recorded for this driver yet.
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
                          {t.trip_type} · {t.reg_number} ({t.make_model})
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
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Drivers Directory</h1>
          <p className="mt-1 text-base text-slate-600">
            Driver contact records, licence expiry checks, and live availability. Tap a driver for history.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={openCreateModal}
            className="cyan-glow-btn inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap shrink-0"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
            <span>Add Driver</span>
          </button>
        )}
      </div>

      {expiringCount > 0 && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3 text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div className="text-sm">
              <span className="font-semibold">Licence Renewal Warning:</span>{' '}
              {expiringCount} active driver{expiringCount === 1 ? ' has' : 's have'} a driving licence expiring within 30 days or already expired.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setExpiringOnly((v) => !v);
              setPage(1);
            }}
            className="min-h-[44px] self-start sm:self-center rounded-xl border border-amber-400 bg-white px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 whitespace-nowrap shrink-0"
          >
            {expiringOnly ? 'Show All Drivers' : 'Show Expiring Only'}
          </button>
        </div>
      )}

      {usingCache && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
        >
          Showing your last saved driver list because you are offline.
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

      {/* Search & Filters */}
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
              placeholder="Search name, licence number, or phone..."
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

        <div className="flex flex-wrap items-center gap-4">
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

          <label className="inline-flex min-h-[44px] items-center gap-2 text-sm text-blue-950 cursor-pointer">
            <input
              type="checkbox"
              checked={expiringOnly}
              onChange={(e) => {
                setExpiringOnly(e.target.checked);
                setPage(1);
              }}
              className="h-5 w-5 rounded border-blue-300 text-cyan-600 accent-cyan-600"
            />
            <span>Expiring / expired licence only</span>
          </label>

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
              <span>Show disabled drivers</span>
            </label>
          )}
        </div>
      </form>

      {/* Drivers Table / Cards */}
      <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
        {loading ? (
          <div className="p-6 text-base text-slate-500">Loading drivers...</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-base text-slate-600">No drivers match your search.</p>
            {canManage && (
              <button
                type="button"
                onClick={openCreateModal}
                className="cyan-glow-btn inline-flex min-h-[48px] items-center gap-2 rounded-xl px-5 text-sm font-semibold"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Add First Driver</span>
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-blue-100 bg-blue-50/60 text-xs font-semibold text-blue-900">
                    <th className="py-3 px-4">Full Name</th>
                    <th className="py-3 px-4">Licence No.</th>
                    <th className="py-3 px-4">Phone</th>
                    <th className="py-3 px-4">Licence Expiry</th>
                    <th className="py-3 px-4">Status</th>
                    {canManage && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100 text-sm">
                  {items.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => loadDriverDetail(d.id)}
                      className="cursor-pointer hover:bg-cyan-50/45 transition-colors"
                    >
                      <td className="py-3.5 px-4 font-semibold text-blue-950">
                        {d.full_name}
                        {!d.active && (
                          <span className="ml-2 text-xs font-normal text-red-700">(Disabled)</span>
                        )}
                      </td>
                      <td className="py-3.5 px-4 font-mono text-slate-700">{d.licence_number}</td>
                      <td className="py-3.5 px-4 font-mono text-slate-700">{d.phone}</td>
                      <td className="py-3.5 px-4">
                        <LicenceExpiryIndicator
                          status={d.licence_status}
                          expiry={d.licence_expiry}
                          days={d.days_to_expiry}
                        />
                      </td>
                      <td className="py-3.5 px-4">
                        <DriverStatusText status={d.derived_status} />
                      </td>
                      {canManage && (
                        <td
                          className="py-2 px-4 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => openEditModal(d)}
                            className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                          >
                            <Edit3 className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                            <span>Manage</span>
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-blue-100 md:hidden">
              {items.map((d) => (
                <div
                  key={d.id}
                  onClick={() => loadDriverDetail(d.id)}
                  className="p-4 space-y-2 cursor-pointer hover:bg-cyan-50/40 active:bg-cyan-50/70 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-base font-bold text-blue-950">
                        {d.full_name}
                        {!d.active && (
                          <span className="ml-2 text-xs font-medium text-red-700">Disabled</span>
                        )}
                      </div>
                      <div className="text-xs font-mono text-slate-500">
                        {d.licence_number} · {d.phone}
                      </div>
                    </div>
                    <DriverStatusText status={d.derived_status} />
                  </div>

                  <div className="flex items-center justify-between pt-1">
                    <LicenceExpiryIndicator
                      status={d.licence_status}
                      expiry={d.licence_expiry}
                      days={d.days_to_expiry}
                    />
                    {canManage && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(d);
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
          Total: <span className="font-semibold text-blue-950">{total}</span> drivers
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

      {/* Add / Edit Driver Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-8">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-bold text-blue-950">
                {editingDriver ? `Edit ${editingDriver.full_name}` : 'Add New Driver'}
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
                <label htmlFor="d-name" className="block text-sm font-semibold text-blue-950">
                  Full Name
                </label>
                <input
                  id="d-name"
                  type="text"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Tatenda Ncube"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="d-licence" className="block text-sm font-semibold text-blue-950">
                  Driving Licence Number
                </label>
                <input
                  id="d-licence"
                  type="text"
                  required
                  value={formLicence}
                  onChange={(e) => setFormLicence(e.target.value)}
                  placeholder="e.g. 940281ZW"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="d-phone" className="block text-sm font-semibold text-blue-950">
                  Phone Number
                </label>
                <input
                  id="d-phone"
                  type="tel"
                  required
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="e.g. +263 77 123 4567"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="d-address" className="block text-sm font-semibold text-blue-950">
                  Home Address (optional)
                </label>
                <input
                  id="d-address"
                  type="text"
                  value={formAddress}
                  onChange={(e) => setFormAddress(e.target.value)}
                  placeholder="e.g. 14 Samora Machel Ave, Harare"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="d-expiry" className="block text-sm font-semibold text-blue-950">
                  Licence Expiry Date (optional)
                </label>
                <input
                  id="d-expiry"
                  type="date"
                  value={formExpiry}
                  onChange={(e) => setFormExpiry(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono text-base text-blue-950"
                />
              </div>

              {editingDriver && (
                <div className="flex items-center justify-between rounded-xl border border-blue-200 p-3.5 bg-blue-50/30">
                  <div>
                    <div className="text-sm font-semibold text-blue-950">Driver Active</div>
                    <div className="text-xs text-slate-500">
                      Uncheck to retire a driver while keeping past trip records
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                    aria-label="Driver active"
                    className="h-6 w-6 rounded border-blue-300 text-cyan-600 accent-cyan-600"
                  />
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-base font-semibold disabled:opacity-60"
                >
                  {saving ? 'Saving...' : editingDriver ? 'Save Changes' : 'Add Driver'}
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
