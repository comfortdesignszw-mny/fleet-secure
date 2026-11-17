import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
import {
  formatHarareTime,
  type AuditLogEntry,
  type AuditVerifyResult,
} from '../shared/types';

export const AuditLogView: React.FC = () => {
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 20;

  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [entityFilter, setEntityFilter] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<AuditVerifyResult | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAuditLog({
        q: query,
        entity: entityFilter,
        page,
        limit,
      });
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load audit records.');
    } finally {
      setLoading(false);
    }
  }, [query, entityFilter, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setQuery(searchInput.trim());
  };

  const handleVerifyChain = async () => {
    setVerifying(true);
    setError(null);
    try {
      const { result } = await api.verifyAuditChain();
      setVerifyResult(result);
      await fetchLogs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to verify audit trail.');
    } finally {
      setVerifying(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">{en.audit.title}</h1>
          <p className="mt-1 text-base text-slate-600 max-w-2xl">{en.audit.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={handleVerifyChain}
          disabled={verifying}
          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap shrink-0"
        >
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          <span>{verifying ? en.audit.verifying : en.audit.verifyButton}</span>
        </button>
      </div>

      {verifyResult && (
        <div
          role="status"
          className={`flex items-start gap-3 rounded-2xl border p-4 ${
            verifyResult.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          {verifyResult.ok ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" aria-hidden="true" />
          )}
          <div className="text-sm">
            <div className="font-semibold">
              {verifyResult.ok ? en.audit.verifiedOk : en.audit.verifiedBroken}
            </div>
            <div className="mt-1 font-mono tabular-nums text-xs opacity-90">
              Checked {verifyResult.totalRows} row{verifyResult.totalRows === 1 ? '' : 's'} ·{' '}
              {formatHarareTime(verifyResult.checkedAt)} (Africa/Harare)
            </div>
            {!verifyResult.ok && verifyResult.reason && (
              <div className="mt-1 font-medium">{verifyResult.reason}</div>
            )}
          </div>
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

      {/* Search & Filter bar */}
      <form
        onSubmit={handleSearchSubmit}
        className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by username, action, or details..."
            className="block w-full min-h-[48px] rounded-xl border border-slate-300 pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
          />
        </div>

        <select
          aria-label="Filter by record type"
          value={entityFilter}
          onChange={(e) => {
            setEntityFilter(e.target.value);
            setPage(1);
          }}
          className="min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-800 focus:border-slate-900 focus:outline-none"
        >
          <option value="">All record types</option>
          <option value="trips">Trips (Out / In)</option>
          <option value="corrections">Trip Corrections</option>
          <option value="vehicles">Vehicles</option>
          <option value="drivers">Drivers</option>
          <option value="auth">Sign-ins & Lockouts</option>
          <option value="users">Staff Accounts</option>
          <option value="settings">System Settings</option>
          <option value="audit_log">Chain Checks</option>
        </select>

        <button
          type="submit"
          className="min-h-[48px] rounded-xl border border-slate-300 bg-slate-100 px-5 text-sm font-semibold text-slate-900 hover:bg-slate-200 whitespace-nowrap shrink-0"
        >
          Search
        </button>
      </form>

      {/* Audit Entries */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {loading ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="p-4 animate-pulse space-y-2">
                <div className="h-4 w-48 rounded bg-slate-200" />
                <div className="h-3 w-72 rounded bg-slate-100" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-base text-slate-600">{en.audit.empty}</div>
        ) : (
          <div className="divide-y divide-slate-200">
            {items.map((row) => {
              const isExpanded = expandedId === row.id;
              return (
                <div key={row.id} className="p-4 sm:px-5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-mono tabular-nums font-semibold text-slate-900">
                          #{row.id}
                        </span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className="font-semibold text-slate-900">{row.action}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className="text-slate-700">
                          {row.entity} ({row.entity_id})
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className="font-mono tabular-nums">
                          {formatHarareTime(row.ts)} CAT
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {row.username} ({row.user_role})
                        </span>
                        {row.ip && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{row.ip}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : row.id)}
                      className="inline-flex min-h-[44px] items-center gap-1.5 self-start sm:self-center rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                    >
                      <span>{isExpanded ? 'Hide Details' : 'View Hash & Data'}</span>
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <div className="font-semibold text-slate-700">Previous Hash</div>
                          <div className="mt-1 break-all font-mono text-slate-600">
                            {row.prev_hash}
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold text-slate-700">Row SHA-256 Hash</div>
                          <div className="mt-1 break-all font-mono text-slate-900">{row.hash}</div>
                        </div>
                      </div>

                      {row.old_json && (
                        <div>
                          <div className="font-semibold text-slate-700">Before</div>
                          <pre className="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-2.5 font-mono text-slate-700">
                            {row.old_json}
                          </pre>
                        </div>
                      )}

                      {row.new_json && (
                        <div>
                          <div className="font-semibold text-slate-700">After / Details</div>
                          <pre className="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-white p-2.5 font-mono text-slate-700">
                            {row.new_json}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-slate-600 tabular-nums">
          Total: <span className="font-semibold text-slate-900">{total}</span> entries
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span>Prev</span>
          </button>
          <span className="px-2 text-sm font-mono tabular-nums text-slate-700">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-300 bg-white px-3.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-40"
          >
            <span>Next</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
