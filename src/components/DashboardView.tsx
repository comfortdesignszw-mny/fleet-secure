import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  formatHarareTime,
  type DashboardData,
  type DashboardVehicleStat,
} from '../shared/types';

interface DashboardViewProps {
  onOpenVehicle: (vehicleId: number) => void;
  onOpenTrip: (tripId: number) => void;
  embedded?: boolean;
}

type SortKey = 'reg_number' | 'trip_count' | 'total_mileage' | 'est_fuel_litres' | 'gauge_fuel_litres';

function toHarareDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatDuration(outAt: string): string {
  const hrs = Math.max(0, Math.floor((Date.now() - new Date(outAt).getTime()) / 3_600_000));
  if (hrs < 24) return `${hrs}h out`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h out`;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onOpenVehicle,
  onOpenTrip,
  embedded = false,
}) => {
  const today = toHarareDate(new Date());
  const monthStart = `${today.slice(0, 7)}-01`;

  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState(today);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>('total_mileage');
  const [sortAsc, setSortAsc] = useState(false);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDashboard({ from: fromDate, to: toDate });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load dashboard.');
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const applyPreset = (preset: 'month' | '7d' | '30d' | 'year') => {
    const now = new Date();
    const end = toHarareDate(now);
    setToDate(end);
    if (preset === 'month') {
      setFromDate(`${end.slice(0, 7)}-01`);
    } else if (preset === '7d') {
      setFromDate(toHarareDate(new Date(now.getTime() - 6 * 86_400_000)));
    } else if (preset === '30d') {
      setFromDate(toHarareDate(new Date(now.getTime() - 29 * 86_400_000)));
    } else {
      setFromDate(`${end.slice(0, 4)}-01-01`);
    }
  };

  const sortedVehicles = useMemo(() => {
    if (!data) return [];
    const copy = [...data.vehicle_stats];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp = 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        cmp = av.localeCompare(bv);
      } else {
        cmp = Number(av) - Number(bv);
      }
      return sortAsc ? cmp : -cmp;
    });
    return copy;
  }, [data, sortKey, sortAsc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v);
    } else {
      setSortKey(key);
      setSortAsc(key === 'reg_number');
    }
  };

  const maxDailyTotal = useMemo(() => {
    if (!data || data.daily_trips.length === 0) return 1;
    return Math.max(1, ...data.daily_trips.map((d) => d.total));
  }, [data]);

  const maxTopMileage = useMemo(() => {
    if (!data || data.top_mileage_vehicles.length === 0) return 1;
    return Math.max(1, ...data.top_mileage_vehicles.map((v) => v.total_mileage));
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {embedded ? (
            <h2 className="font-display text-xl sm:text-2xl font-bold text-blue-950">
              Fleet Dashboard
            </h2>
          ) : (
            <h1 className="font-display text-2xl font-bold text-blue-950">Fleet Dashboard</h1>
          )}
          <p className="mt-1 text-base text-slate-600">
            Live overview of vehicle availability, mileage, fuel estimates, and alerts.
          </p>
        </div>

        <button
          type="button"
          onClick={loadDashboard}
          disabled={loading}
          className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 self-start sm:self-auto rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 text-cyan-600 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
        >
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="rounded-2xl border border-blue-200/80 bg-white p-8 text-base text-slate-500 shadow-xs">
          Loading dashboard figures...
        </div>
      ) : (
        data && (
          <>
            {/* 10 Summary Cards (on top right after header) */}
            <section aria-label="Fleet summary cards" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Out on Hire</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-950">
                  {data.cards.out_on_hire}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Out on Errands</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-950">
                  {data.cards.out_on_errand}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-cyan-200 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Available Vehicles</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-cyan-600">
                  {data.cards.available_vehicles}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Total Fleet</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-950">
                  {data.cards.total_fleet}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Total Drivers</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-950">
                  {data.cards.total_drivers}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Trips Today</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-700">
                  {data.cards.trips_today}
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Mileage This Month</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-blue-950">
                  {data.cards.mileage_this_month.toLocaleString()} <span className="text-sm font-normal text-slate-500">km</span>
                </div>
              </div>

              <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-4">
                <div className="text-xs font-medium text-slate-500">Est. Fuel This Month</div>
                <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-cyan-700">
                  {data.cards.est_fuel_this_month.toLocaleString()} <span className="text-sm font-normal text-slate-500">L</span>
                </div>
              </div>

              <div
                className={`cyan-glow-card rounded-2xl border p-4 ${
                  data.cards.flagged_trips > 0
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-blue-200/80 bg-white'
                }`}
              >
                <div className="text-xs font-medium text-slate-600">Flagged Trips</div>
                <div
                  className={`mt-1 flex items-center gap-1.5 text-2xl font-bold font-mono tabular-nums ${
                    data.cards.flagged_trips > 0 ? 'text-amber-800' : 'text-blue-950'
                  }`}
                >
                  {data.cards.flagged_trips > 0 && (
                    <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
                  )}
                  <span>{data.cards.flagged_trips}</span>
                </div>
              </div>

              <div
                className={`cyan-glow-card rounded-2xl border p-4 ${
                  data.cards.overdue_hires > 0
                    ? 'border-red-300 bg-red-50'
                    : 'border-blue-200/80 bg-white'
                }`}
              >
                <div className="text-xs font-medium text-slate-600">Overdue Hires</div>
                <div
                  className={`mt-1 flex items-center gap-1.5 text-2xl font-bold font-mono tabular-nums ${
                    data.cards.overdue_hires > 0 ? 'text-red-700' : 'text-blue-950'
                  }`}
                >
                  {data.cards.overdue_hires > 0 && (
                    <Clock className="h-5 w-5 shrink-0" aria-hidden="true" />
                  )}
                  <span>{data.cards.overdue_hires}</span>
                </div>
              </div>
            </section>

            {/* Date Range Filter Bar */}
            <div className="rounded-2xl border border-blue-200/80 bg-white p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between shadow-xs">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset('month')}
                  className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-sm font-medium text-blue-900"
                >
                  This Month
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('7d')}
                  className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-sm font-medium text-blue-900"
                >
                  Last 7 Days
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('30d')}
                  className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-sm font-medium text-blue-900"
                >
                  Last 30 Days
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('year')}
                  className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-sm font-medium text-blue-900"
                >
                  This Year
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="dash-from" className="text-xs font-semibold text-blue-950">
                  From
                </label>
                <input
                  id="dash-from"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="cyan-glow-input min-h-[40px] rounded-lg border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
                <label htmlFor="dash-to" className="text-xs font-semibold text-blue-950">
                  To
                </label>
                <input
                  id="dash-to"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="cyan-glow-input min-h-[40px] rounded-lg border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
              </div>
            </div>

            {/* Daily Trips Chart */}
            <section className="rounded-2xl border border-blue-200/80 bg-white p-5 sm:p-6 space-y-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-blue-950">Daily Trips</h2>
                  <p className="text-xs text-slate-500 font-mono">
                    {data.range.from} to {data.range.to} (Africa/Harare)
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs font-medium text-blue-950">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-xs bg-blue-700" aria-hidden="true" />
                    <span>Hires</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-xs bg-cyan-500" aria-hidden="true" />
                    <span>Errands</span>
                  </span>
                </div>
              </div>

              {data.daily_trips.length === 0 ? (
                <p className="text-sm text-slate-500">No days in selected range.</p>
              ) : (
                <div className="overflow-x-auto pb-2">
                  <div className="min-w-[420px] flex items-end gap-1.5 h-44 pt-4">
                    {data.daily_trips.map((d) => {
                      const hirePct = (d.hire_count / maxDailyTotal) * 100;
                      const errandPct = (d.errand_count / maxDailyTotal) * 100;
                      return (
                        <div
                          key={d.date}
                          title={`${d.date}: ${d.hire_count} Hires, ${d.errand_count} Errands`}
                          className="flex-1 flex flex-col items-center justify-end h-full min-w-[16px]"
                        >
                          <div className="text-[11px] font-mono tabular-nums text-blue-900 mb-1">
                            {d.total > 0 ? d.total : ''}
                          </div>
                          <div className="w-full max-w-[28px] flex flex-col-reverse justify-start h-28 bg-blue-50 rounded-t-md overflow-hidden border border-blue-100">
                            {d.hire_count > 0 && (
                              <div
                                className="w-full bg-blue-700"
                                style={{ height: `${Math.max(8, hirePct)}%` }}
                              />
                            )}
                            {d.errand_count > 0 && (
                              <div
                                className="w-full bg-cyan-500"
                                style={{ height: `${Math.max(8, errandPct)}%` }}
                              />
                            )}
                          </div>
                          <div className="mt-1.5 text-[10px] font-mono tabular-nums text-slate-500">
                            {d.date.slice(5)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            {/* Top 5 Mileage + Longest Vehicles Out */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <section className="rounded-2xl border border-blue-200/80 bg-white p-5 sm:p-6 space-y-4 shadow-xs">
                <h2 className="text-lg font-semibold text-blue-950">
                  Top 5 Highest-Mileage Vehicles
                </h2>
                {data.top_mileage_vehicles.length === 0 ? (
                  <p className="text-sm text-slate-600">
                    No closed trips recorded in this date range yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {data.top_mileage_vehicles.map((v, idx) => {
                      const pct = Math.max(6, (v.total_mileage / maxTopMileage) * 100);
                      return (
                        <button
                          key={v.vehicle_id}
                          type="button"
                          onClick={() => onOpenVehicle(v.vehicle_id)}
                          className="cyan-glow-card w-full text-left space-y-1.5 rounded-xl border border-transparent p-2.5 -mx-2 hover:bg-cyan-50/40"
                        >
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="font-semibold text-blue-950">
                              <span className="font-mono text-cyan-700 mr-1.5">{idx + 1}.</span>
                              <span className="font-mono">{v.reg_number}</span> · {v.make_model}
                            </span>
                            <span className="font-mono tabular-nums font-bold text-blue-950 shrink-0">
                              {v.total_mileage.toLocaleString()} km
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-blue-100 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-blue-700 to-cyan-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-blue-200/80 bg-white p-5 sm:p-6 space-y-4 shadow-xs">
                <h2 className="text-lg font-semibold text-blue-950">Longest Vehicles Out</h2>
                {data.longest_vehicles_out.length === 0 ? (
                  <p className="text-sm text-slate-600">No vehicles are currently out of the yard.</p>
                ) : (
                  <div className="divide-y divide-blue-100">
                    {data.longest_vehicles_out.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => onOpenTrip(t.id)}
                        className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-cyan-50/45 rounded-lg px-2 -mx-2 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-blue-950 truncate">
                            <span className="font-mono">{t.reg_number}</span> · {t.driver_name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {t.trip_type === 'HIRE' ? `Hire: ${t.client_name}` : `Errand: ${t.destination}`} · Left {formatHarareTime(t.out_at)}
                            {t.trip_type === 'HIRE' && t.expected_return_date
                              ? ` · Due ${t.expected_return_date}`
                              : ''}
                          </div>
                        </div>
                        <span
                          className={`text-xs font-mono tabular-nums font-semibold shrink-0 ${
                            t.is_overdue || t.is_return_due ? 'text-red-700' : 'text-amber-700'
                          }`}
                        >
                          {formatDuration(t.out_at)}
                          {t.is_return_due ? ' (Return Due)' : t.is_overdue ? ' (Overdue)' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* Per-Vehicle Mileage & Est. Fuel Table */}
            <section className="rounded-2xl border border-blue-200/80 bg-white overflow-hidden shadow-xs">
              <div className="border-b border-blue-100 bg-blue-50/30 px-5 py-4">
                <h2 className="text-lg font-semibold text-blue-950">
                  Per-Vehicle Mileage &amp; Estimated Fuel
                </h2>
                <p className="text-xs text-slate-500">
                  Tap column headers to sort. Tap any vehicle row to open its full history.
                </p>
              </div>

              {sortedVehicles.length === 0 ? (
                <div className="p-6 text-base text-slate-600">No vehicles found.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-blue-100 bg-blue-50/60 text-xs font-semibold text-blue-900">
                        <th className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => toggleSort('reg_number')}
                            className="inline-flex items-center gap-1 hover:text-cyan-700"
                          >
                            <span>Vehicle</span>
                            <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                          </button>
                        </th>
                        <th className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort('trip_count')}
                            className="inline-flex items-center gap-1 hover:text-cyan-700"
                          >
                            <span>Trips</span>
                            <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                          </button>
                        </th>
                        <th className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort('total_mileage')}
                            className="inline-flex items-center gap-1 hover:text-cyan-700"
                          >
                            <span>Mileage</span>
                            <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                          </button>
                        </th>
                        <th className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort('est_fuel_litres')}
                            className="inline-flex items-center gap-1 hover:text-cyan-700"
                          >
                            <span>Est. Fuel</span>
                            <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                          </button>
                        </th>
                        <th className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => toggleSort('gauge_fuel_litres')}
                            className="inline-flex items-center gap-1 hover:text-cyan-700"
                          >
                            <span>Gauge Fuel</span>
                            <ArrowUpDown className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-blue-100 text-sm">
                      {sortedVehicles.map((v: DashboardVehicleStat) => (
                        <tr
                          key={v.vehicle_id}
                          onClick={() => onOpenVehicle(v.vehicle_id)}
                          className="cursor-pointer hover:bg-cyan-50/45 transition-colors"
                        >
                          <td className="py-3 px-4">
                            <div className="font-mono font-semibold text-blue-950">
                              {v.reg_number}
                            </div>
                            <div className="text-xs text-slate-500">
                              {v.make_model} · {v.vehicle_class}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-950">
                            {v.trip_count}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-blue-950">
                            {v.total_mileage.toLocaleString()} km
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-cyan-700 font-medium">
                            {v.est_fuel_litres.toFixed(1)} L
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-950">
                            {v.gauge_fuel_litres.toFixed(1)} L
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
};
