import React, { useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCheck, FilePlus2, Search, ShieldCheck, WifiOff, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { CACHE_KEYS, readCachedEntry } from '../lib/offlineCache';
import { isLikelyNetworkError } from '../lib/offlineQueue';
import {
  evaluateChecklistVehicleMatch,
  toHarareYmd,
  type ChecklistHirerType,
  type ChecklistSummary,
} from '../shared/types';

interface LinkChecklistModalProps {
  hirerType: ChecklistHirerType;
  vehicleId?: number | null;
  regNumber?: string;
  vehicleType?: string;
  partyName?: string;
  logDateYmd?: string;
  selectedChecklistId?: number | null;
  onSelect: (checklist: ChecklistSummary) => void;
  onCreateNew: () => void;
  onClose: () => void;
}

export const LinkChecklistModal: React.FC<LinkChecklistModalProps> = ({
  hirerType,
  regNumber = '',
  vehicleType = '',
  partyName = '',
  logDateYmd,
  selectedChecklistId = null,
  onSelect,
  onCreateNew,
  onClose,
}) => {
  const [items, setItems] = useState<ChecklistSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingCache, setUsingCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const effectiveLogDate = logDateYmd || toHarareYmd(new Date());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setUsingCache(false);

    api
      .listChecklists({ hirer_type: hirerType, limit: 100 })
      .then((res) => {
        if (!active) return;
        setItems(res.items.filter((c) => c.hirer_type === hirerType));
      })
      .catch((err) => {
        if (!active) return;
        if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
          const cached = readCachedEntry<ChecklistSummary[]>(CACHE_KEYS.checklistsAll);
          if (cached) {
            setItems(cached.data.filter((c) => c.hirer_type === hirerType && c.id > 0));
            setUsingCache(true);
            return;
          }
        }
        setError(err instanceof ApiError ? err.message : 'Could not load matching checklists.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hirerType]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const missingPrereqs = useMemo(() => {
    const missing: string[] = [];
    if (!partyName.trim()) {
      missing.push(hirerType === 'renter' ? 'Client Name' : 'Subhirer Name');
    }
    if (!regNumber.trim()) {
      missing.push('Registration Number');
    }
    if (!vehicleType.trim()) {
      missing.push('Vehicle Type');
    }
    return missing;
  }, [partyName, regNumber, vehicleType, hirerType]);

  const strictMatchedItems = useMemo(() => {
    if (missingPrereqs.length > 0) return [];
    const target = {
      expectedHirerType: hirerType,
      partyName,
      regNumber,
      vehicleType,
      logDateYmd: effectiveLogDate,
    };
    return items.filter(
      (c) =>
        evaluateChecklistVehicleMatch(
          {
            hirer_type: c.hirer_type,
            hirer_name: c.hirer_name,
            reg_number: c.reg_number,
            vehicle_type: c.vehicle_type,
            created_at: c.created_at || c.hire_date,
          },
          target
        ).matched
    );
  }, [items, missingPrereqs, hirerType, partyName, regNumber, vehicleType, effectiveLogDate]);

  const rankedItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = !q
      ? strictMatchedItems
      : strictMatchedItems.filter((c) =>
          `${c.reg_number} ${c.vehicle_type} ${c.car_model} ${c.hirer_name} ${c.representative} ${c.hire_date} ${c.id}`
            .toLowerCase()
            .includes(q)
        );

    return [...filtered].sort((a, b) => b.id - a.id);
  }, [strictMatchedItems, search]);

  const roleNoun = hirerType === 'renter' ? "Renter's" : "Owner's";
  const partyLabel = hirerType === 'renter' ? 'Client / Renter' : 'Subhirer / Owner';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Link ${roleNoun} Checklist`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-blue-200 bg-white p-5 sm:p-6 shadow-2xl my-8 space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-700">
              Checklist Lookup · Section A: {roleNoun} Name
            </div>
            <h2 className="mt-0.5 font-display text-lg sm:text-xl font-bold text-blue-950">
              Link {roleNoun} Checklist
            </h2>
            <p className="mt-1 text-xs sm:text-sm text-slate-600">
              {hirerType === 'renter'
                ? "Showing Renter's checklists matching today's creation date, vehicle reg & type, and client name."
                : "Showing Owner's checklists matching today's creation date, vehicle reg & type, and subhirer name."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checklist lookup"
            className="cyan-glow-outline flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl border border-blue-200 bg-white text-slate-600"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Active 5-rule Matching Criteria */}
        <div className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-3 text-xs text-blue-950 space-y-1.5">
          <div className="flex items-center gap-1.5 font-bold text-cyan-900">
            <ShieldCheck className="h-4 w-4 text-cyan-700 shrink-0" aria-hidden="true" />
            <span>Active Matching Rules</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:text-xs">
            <div>
              <span className="text-slate-600">Section A Type:</span>{' '}
              <strong className="font-semibold">{roleNoun} Name</strong>
            </div>
            <div>
              <span className="text-slate-600">Creation Date:</span>{' '}
              <strong className="font-mono">{effectiveLogDate}</strong>
            </div>
            <div>
              <span className="text-slate-600">Vehicle Reg &amp; Type:</span>{' '}
              <strong className="font-mono">
                {regNumber.trim() || 'Not entered'} · {vehicleType.trim() || 'Not selected'}
              </strong>
            </div>
            <div>
              <span className="text-slate-600">{partyLabel}:</span>{' '}
              <strong className="font-semibold">{partyName.trim() || 'Not entered'}</strong>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-600"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter matched checklists..."
              className="cyan-glow-input block w-full min-h-[44px] rounded-xl border border-blue-200 pl-10 pr-3 text-sm text-blue-950"
            />
          </div>
          <button
            type="button"
            onClick={onCreateNew}
            className="cyan-glow-btn inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold whitespace-nowrap"
          >
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
            <span>Create New Checklist</span>
          </button>
        </div>

        {usingCache && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-900">
            <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Offline mode — showing locally cached {roleNoun} checklists.</span>
          </div>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="max-h-96 overflow-y-auto rounded-xl border border-blue-100 divide-y divide-blue-100">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Looking up matching {roleNoun} checklists...
            </div>
          ) : missingPrereqs.length > 0 ? (
            <div className="p-6 text-center space-y-3">
              <ClipboardCheck className="mx-auto h-9 w-9 text-cyan-600/70" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-blue-950">
                  Enter {missingPrereqs.join(', ')} first to match existing checklists.
                </p>
                <p className="text-xs text-slate-600">
                  Existing checklists must match Section A ({roleNoun} Name), today&apos;s creation date ({effectiveLogDate}), vehicle registration &amp; type, and {partyLabel.toLowerCase()} name. You can also create a new checklist now.
                </p>
              </div>
              <button
                type="button"
                onClick={onCreateNew}
                className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50/70 px-4 text-xs font-semibold text-blue-950"
              >
                <FilePlus2 className="h-4 w-4 text-cyan-700" aria-hidden="true" />
                <span>Create {roleNoun} Checklist Now</span>
              </button>
            </div>
          ) : rankedItems.length === 0 ? (
            <div className="p-6 text-center space-y-3">
              <ClipboardCheck className="mx-auto h-9 w-9 text-cyan-600/70" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-blue-950">
                  No {roleNoun} checklist matched all required criteria{search ? ` for "${search}"` : ''}.
                </p>
                <p className="text-xs text-slate-600">
                  {items.length > 0
                    ? `${items.length} ${roleNoun} checklist(s) exist, but none matched creation date ${effectiveLogDate}, vehicle ${regNumber.trim().toUpperCase()} (${vehicleType}), and ${partyLabel.toLowerCase()} "${partyName.trim()}".`
                    : `No ${roleNoun} checklists have been created yet.`}
                </p>
              </div>
              <button
                type="button"
                onClick={onCreateNew}
                className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-cyan-300 bg-cyan-50/70 px-4 text-xs font-semibold text-blue-950"
              >
                <FilePlus2 className="h-4 w-4 text-cyan-700" aria-hidden="true" />
                <span>Create {roleNoun} Checklist Now</span>
              </button>
            </div>
          ) : (
            rankedItems.map((chk) => {
              const isCurrentlySelected = selectedChecklistId === chk.id;
              const createdDateYmd = toHarareYmd(chk.created_at || chk.hire_date);

              return (
                <div
                  key={chk.id}
                  className={`p-3.5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between transition-colors ${
                    isCurrentlySelected ? 'bg-cyan-50/80' : 'hover:bg-blue-50/40'
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono text-xs font-bold text-cyan-800">#{chk.id}</span>
                      <span className="font-mono text-sm font-bold text-blue-950">{chk.reg_number}</span>
                      <span aria-hidden="true" className="text-cyan-500">·</span>
                      <span className="text-sm font-medium text-slate-800">
                        {chk.car_model} ({chk.vehicle_type})
                      </span>
                      <span className="text-xs font-semibold text-emerald-700">
                        · Matches all rules
                      </span>
                    </div>
                    <div className="text-xs sm:text-sm text-slate-700">
                      {chk.hirer_type === 'owner' ? 'Owner:' : 'Renter:'}{' '}
                      <strong className="text-blue-950">{chk.hirer_name}</strong>
                      {chk.representative ? ` · Rep: ${chk.representative}` : ''}
                    </div>
                    <div className="text-xs font-mono tabular-nums text-slate-500">
                      Created {createdDateYmd}
                      {chk.days !== null ? ` · ${chk.days}d` : ''}
                      {chk.return_date ? ` (Due ${chk.return_date})` : ''}
                      {` · ${chk.mileage_out.toLocaleString()} km`}
                      {` · ${chk.status === 'completed' ? 'Completed' : 'Out (open)'}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onSelect(chk)}
                    className={`min-h-[40px] shrink-0 self-start sm:self-center inline-flex items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold whitespace-nowrap ${
                      isCurrentlySelected
                        ? 'bg-emerald-600 text-white'
                        : 'cyan-glow-btn'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{isCurrentlySelected ? 'Selected' : 'Select Checklist'}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

