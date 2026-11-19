import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Lock,
} from 'lucide-react';
import { api, ApiError, getCachedSettings } from '../lib/api';
import { enqueueOfflineEntry, isLikelyNetworkError } from '../lib/offlineQueue';
import {
  DEFAULT_SETTINGS,
  FUEL_FRACTIONS,
  formatHarareTime,
  type AppSettings,
  type FuelLevel,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
} from '../shared/types';
import { FuelGaugePicker } from './FuelGaugePicker';

interface TripInFormProps {
  tripType: TripType;
  user: UserPublic;
  initialTripId?: number | null;
  onCancel: () => void;
  onSaved: (trip: TripSummary, flags: TripFlag[]) => void;
  onQueued?: (summaryLabel: string) => void;
}

interface InDraft {
  tripId: string;
  mileageIn: string;
  fuelIn: FuelLevel | '';
  checklistBy: string;
  notes: string;
}

export const TripInForm: React.FC<TripInFormProps> = ({
  tripType,
  user,
  initialTripId,
  onCancel,
  onSaved,
  onQueued,
}) => {
  const draftKey = `fleet_secure_draft_in_${tripType}`;

  const [openTrips, setOpenTrips] = useState<TripSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  const [selectedTripId, setSelectedTripId] = useState(
    initialTripId ? String(initialTripId) : ''
  );
  const [mileageIn, setMileageIn] = useState('');
  const [fuelIn, setFuelIn] = useState<FuelLevel | ''>('');
  const [checklistBy, setChecklistBy] = useState(user.full_name);
  const [notes, setNotes] = useState('');

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialTripId) {
      setSelectedTripId(String(initialTripId));
      return;
    }
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw) as Partial<InDraft>;
        if (d.tripId) setSelectedTripId(d.tripId);
        if (d.mileageIn) setMileageIn(d.mileageIn);
        if (d.fuelIn) setFuelIn(d.fuelIn);
        if (d.checklistBy) setChecklistBy(d.checklistBy);
        if (d.notes) setNotes(d.notes);
      }
    } catch {
      // Ignore
    }
  }, [draftKey, initialTripId]);

  useEffect(() => {
    const draft: InDraft = {
      tripId: selectedTripId,
      mileageIn,
      fuelIn,
      checklistBy,
      notes,
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Ignore
    }
  }, [draftKey, selectedTripId, mileageIn, fuelIn, checklistBy, notes]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const openCacheKey = `fleet_secure_cache_open_trips_${tripType}`;
    const cachedSettingsFallback = getCachedSettings() ?? DEFAULT_SETTINGS;
    setSettings(cachedSettingsFallback);
    Promise.all([
      api.listTrips({ status: 'OPEN', trip_type: tripType, limit: 100 }),
      api.getSettings().catch(() => ({ settings: cachedSettingsFallback })),
    ])
      .then(([tRes, sRes]) => {
        if (!active) return;
        setOpenTrips(tRes.items);
        setSettings(sRes.settings);
        try {
          localStorage.setItem(openCacheKey, JSON.stringify(tRes.items));
        } catch {
          // Ignore cache write errors
        }
      })
      .catch((err) => {
        if (!active) return;
        try {
          const cached = localStorage.getItem(openCacheKey);
          if (cached) {
            setOpenTrips(JSON.parse(cached) as TripSummary[]);
            return;
          }
          const homeOngoing = localStorage.getItem('fleet_secure_cache_home_ongoing');
          if (homeOngoing) {
            const parsed = (JSON.parse(homeOngoing) as TripSummary[]).filter(
              (t) => t.trip_type === tripType
            );
            setOpenTrips(parsed);
            return;
          }
        } catch {
          // Ignore
        }
        setError(err instanceof ApiError ? err.message : 'Could not load open trips.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tripType]);

  const selectedTrip = useMemo(
    () => openTrips.find((t) => String(t.id) === selectedTripId) || null,
    [openTrips, selectedTripId]
  );

  // Live locked calculations
  const liveCalc = useMemo(() => {
    if (!selectedTrip) return null;
    const mIn = Number(mileageIn);
    const validMileage = mileageIn !== '' && Number.isInteger(mIn) && mIn >= selectedTrip.mileage_out;
    const totalMileage = validMileage ? mIn - selectedTrip.mileage_out : null;

    const tankSize =
      selectedTrip.vehicle_class === 'HEAVY'
        ? Number(settings.heavy_tank_litres || 80)
        : Number(settings.economy_tank_litres || 60);
    const kmPerLitre =
      selectedTrip.vehicle_class === 'HEAVY'
        ? Number(settings.heavy_km_per_litre || 8)
        : Number(settings.economy_km_per_litre || 10);
    const thresholdPct = Number(settings.fuel_mismatch_threshold_pct || 25);

    const estFuelLitres =
      totalMileage !== null ? Number((totalMileage / kmPerLitre).toFixed(1)) : null;

    const gaugeFuelLitres = fuelIn
      ? Number(
          ((FUEL_FRACTIONS[selectedTrip.fuel_out] - FUEL_FRACTIONS[fuelIn]) * tankSize).toFixed(1)
        )
      : null;

    const thresholdLitres = Number(((thresholdPct / 100) * tankSize).toFixed(1));
    const fuelMismatch =
      estFuelLitres !== null &&
      gaugeFuelLitres !== null &&
      Math.abs(estFuelLitres - gaugeFuelLitres) > thresholdLitres;

    return {
      totalMileage,
      estFuelLitres,
      gaugeFuelLitres,
      thresholdLitres,
      fuelMismatch,
    };
  }, [selectedTrip, mileageIn, fuelIn, settings]);

  const validateAndConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedTrip) {
      setError('Select the ongoing trip that is returning.');
      return;
    }
    const mIn = Number(mileageIn);
    if (mileageIn === '' || !Number.isInteger(mIn) || mIn < 0) {
      setError('Enter the mileage when returning as a whole number.');
      return;
    }
    if (mIn < selectedTrip.mileage_out) {
      setError(
        `Mileage when returning (${mIn.toLocaleString()} km) cannot be less than mileage when leaving (${selectedTrip.mileage_out.toLocaleString()} km).`
      );
      return;
    }
    if (!fuelIn) {
      setError('Tap the fuel gauge level when returning.');
      return;
    }
    if (!checklistBy.trim()) {
      setError('Enter who completed the closing checklist.');
      return;
    }

    setConfirming(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleFinalSave = async () => {
    if (!selectedTrip || !fuelIn) return;
    setSubmitting(true);
    setError(null);

    const deviceTime = new Date().toISOString();
    const bodyPayload = {
      mileage_in: Number(mileageIn),
      fuel_in: fuelIn,
      closing_checklist_by: checklistBy.trim(),
      notes: notes.trim(),
      device_time: deviceTime,
    };

    const summaryLabel = `${tripType === 'HIRE' ? 'Hire Return' : 'Errand Return'} · ${selectedTrip.reg_number} (Trip #${selectedTrip.id})`;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      enqueueOfflineEntry({
        kind: 'IN',
        summaryLabel,
        createdAtDevice: deviceTime,
        payload: { trip_id: selectedTrip.id, ...bodyPayload },
      });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // Ignore
      }
      setSubmitting(false);
      onQueued?.(summaryLabel);
      return;
    }

    try {
      const res = await api.createTripIn(selectedTrip.id, bodyPayload);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // Ignore
      }
      onSaved(res.trip, res.flags);
    } catch (err) {
      if (isLikelyNetworkError(err)) {
        enqueueOfflineEntry({
          kind: 'IN',
          summaryLabel,
          createdAtDevice: deviceTime,
          payload: { trip_id: selectedTrip.id, ...bodyPayload },
        });
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // Ignore
        }
        onQueued?.(summaryLabel);
      } else {
        setConfirming(false);
        setError(err instanceof ApiError ? err.message : 'Could not save return record.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = tripType === 'HIRE' ? 'Return a Hired Vehicle' : 'Errand Returned';

  if (confirming && selectedTrip && fuelIn && liveCalc) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-5 shadow-xs">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div>
              <div className="font-semibold">Check carefully before saving</div>
              <div className="mt-0.5">
                You cannot edit or delete this return record after saving.
              </div>
            </div>
          </div>

          <h1 className="font-display text-2xl font-bold text-blue-950">Confirm {title}</h1>

          <dl className="divide-y divide-blue-100 text-base">
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Vehicle</dt>
              <dd className="font-semibold text-blue-950 text-right">
                {selectedTrip.reg_number} · {selectedTrip.make_model}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Driver</dt>
              <dd className="font-semibold text-blue-950 text-right">{selectedTrip.driver_name}</dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Mileage when leaving / returning</dt>
              <dd className="font-mono tabular-nums font-semibold text-blue-950">
                {selectedTrip.mileage_out.toLocaleString()} → {Number(mileageIn).toLocaleString()} km
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Total Mileage (auto)</dt>
              <dd className="font-mono tabular-nums font-bold text-blue-950">
                {liveCalc.totalMileage?.toLocaleString()} km
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Fuel when leaving / returning</dt>
              <dd className="font-mono font-semibold text-cyan-700">
                {selectedTrip.fuel_out} → {fuelIn}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Est. Fuel Consumed (auto)</dt>
              <dd className="font-mono tabular-nums font-bold text-blue-950">
                {liveCalc.estFuelLitres} L (Gauge: {liveCalc.gaugeFuelLitres} L)
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Closing checklist by</dt>
              <dd className="font-semibold text-blue-950 text-right">{checklistBy.trim()}</dd>
            </div>
          </dl>

          {liveCalc.fuelMismatch && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <span className="font-semibold">Fuel Mismatch Warning:</span> Estimated fuel ({liveCalc.estFuelLitres} L) and gauge fuel ({liveCalc.gaugeFuelLitres} L) differ by more than {liveCalc.thresholdLitres} L. Saving will raise a high-priority flag.
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={handleFinalSave}
              className="cyan-glow-btn flex-1 min-h-[52px] inline-flex items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold disabled:opacity-60"
            >
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              <span>{submitting ? 'Saving permanently...' : 'Confirm & Save Return'}</span>
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setConfirming(false)}
              className="cyan-glow-outline min-h-[52px] rounded-xl border border-blue-200 bg-white px-5 text-base font-medium text-blue-900"
            >
              Go Back & Edit
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
        >
          <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
          <span>Back</span>
        </button>
      </div>

      {/* Collapsible How to fill this in */}
      <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white">
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          className="flex w-full min-h-[52px] items-center justify-between gap-3 px-5 py-3 text-left"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-blue-950">
            <HelpCircle className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>How to fill this in</span>
          </span>
          {showGuide ? (
            <ChevronUp className="h-5 w-5 text-cyan-600" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-5 w-5 text-cyan-600" aria-hidden="true" />
          )}
        </button>
        {showGuide && (
          <ol className="border-t border-blue-100 px-5 py-4 text-sm text-slate-700 space-y-1.5 list-decimal pl-9">
            <li>Pick the vehicle returning from the ongoing list below.</li>
            <li>Read the exact odometer on the dashboard and enter <strong>Mileage when returning</strong>.</li>
            <li>Tap the matching level on the <strong>Fuel when returning</strong> gauge.</li>
            <li>Check the automatic <strong>Total Mileage</strong> and <strong>Estimated Fuel</strong>.</li>
            <li>Enter who did the closing checklist, tap <strong>Review & Save</strong>, and confirm.</li>
          </ol>
        )}
      </div>

      <form
        onSubmit={validateAndConfirm}
        className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-6 shadow-xs"
      >
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">{title}</h1>
          <div className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600">
            <Clock className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Return date & time: Locked and recorded automatically by server on save</span>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-6 text-base text-slate-500">Loading ongoing trips...</div>
        ) : openTrips.length === 0 ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-6 text-center space-y-3">
            <p className="text-base text-slate-700">
              There are no ongoing {tripType === 'HIRE' ? 'hires' : 'errands'} to return right now.
            </p>
            <button
              type="button"
              onClick={onCancel}
              className="cyan-glow-btn min-h-[48px] rounded-xl px-5 text-sm font-semibold"
            >
              Back to Home
            </button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="in-trip" className="block text-sm font-semibold text-blue-950">
                Select Ongoing {tripType === 'HIRE' ? 'Hire' : 'Errand'}
              </label>
              <select
                id="in-trip"
                value={selectedTripId}
                onChange={(e) => setSelectedTripId(e.target.value)}
                required
                className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
              >
                <option value="">Choose vehicle returning...</option>
                {openTrips.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.reg_number} — {t.driver_name} (
                    {t.trip_type === 'HIRE' ? t.client_name : t.destination})
                  </option>
                ))}
              </select>
            </div>

            {selectedTrip && (
              <>
                {/* What went out summary */}
                <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-4 space-y-2 text-sm">
                  <div className="font-semibold text-blue-950">
                    What went out · {selectedTrip.reg_number} ({selectedTrip.make_model})
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-700">
                    <div>Driver: {selectedTrip.driver_name}</div>
                    <div>
                      {selectedTrip.trip_type === 'HIRE'
                        ? `Client: ${selectedTrip.client_name}`
                        : `Destination: ${selectedTrip.destination}`}
                    </div>
                    <div className="font-mono tabular-nums">
                      Left at: {formatHarareTime(selectedTrip.out_at)}
                    </div>
                    <div className="font-mono tabular-nums text-cyan-800 font-medium">
                      Out: {selectedTrip.mileage_out.toLocaleString()} km · Fuel: {selectedTrip.fuel_out}
                    </div>
                  </div>
                </div>

                {/* Mileage when returning */}
                <div>
                  <label htmlFor="in-mileage" className="block text-sm font-semibold text-blue-950">
                    Mileage when returning (km)
                  </label>
                  <input
                    id="in-mileage"
                    type="number"
                    inputMode="numeric"
                    min={selectedTrip.mileage_out}
                    step="1"
                    required
                    value={mileageIn}
                    onChange={(e) => setMileageIn(e.target.value)}
                    placeholder={`Must be ${selectedTrip.mileage_out.toLocaleString()} or higher`}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[52px] rounded-xl border border-blue-200 px-4 font-mono tabular-nums text-lg font-semibold text-blue-950"
                  />
                </div>

                {/* Visual Fuel Gauge */}
                <FuelGaugePicker
                  label="Fuel when returning"
                  value={fuelIn}
                  onChange={(lvl) => setFuelIn(lvl)}
                />

                {/* Locked live calculation box */}
                <div className="rounded-xl border border-cyan-200 bg-cyan-50/40 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-semibold text-blue-900">
                    <Lock className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                    <span>Automatic Totals (Locked)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="text-xs text-slate-500">Total Mileage</div>
                      <div className="mt-0.5 text-xl font-bold font-mono tabular-nums text-blue-950">
                        {liveCalc?.totalMileage !== null && liveCalc?.totalMileage !== undefined
                          ? `${liveCalc.totalMileage.toLocaleString()} km`
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Est. Fuel Consumed</div>
                      <div className="mt-0.5 text-xl font-bold font-mono tabular-nums text-cyan-700">
                        {liveCalc?.estFuelLitres !== null && liveCalc?.estFuelLitres !== undefined
                          ? `${liveCalc.estFuelLitres} L`
                          : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">Gauge Fuel Used</div>
                      <div className="mt-0.5 text-xl font-bold font-mono tabular-nums text-blue-950">
                        {liveCalc?.gaugeFuelLitres !== null && liveCalc?.gaugeFuelLitres !== undefined
                          ? `${liveCalc.gaugeFuelLitres} L`
                          : '—'}
                      </div>
                    </div>
                  </div>

                  {liveCalc?.fuelMismatch && (
                    <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                      <span>
                        Fuel mismatch detected (difference exceeds ±{liveCalc.thresholdLitres} L). Double-check the mileage and fuel gauge before saving.
                      </span>
                    </div>
                  )}
                </div>

                {/* Closing checklist by */}
                <div>
                  <label htmlFor="in-checklist" className="block text-sm font-semibold text-blue-950">
                    Closing checklist done by
                  </label>
                  <input
                    id="in-checklist"
                    type="text"
                    required
                    value={checklistBy}
                    onChange={(e) => setChecklistBy(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>

                {/* Notes */}
                <div>
                  <label htmlFor="in-notes" className="block text-sm font-semibold text-blue-950">
                    Return notes (optional)
                  </label>
                  <textarea
                    id="in-notes"
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any new damage, receipts, or refuel notes..."
                    className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3.5 text-base text-blue-950"
                  />
                </div>

                <button
                  type="submit"
                  className="cyan-glow-btn w-full min-h-[52px] rounded-xl px-5 text-base font-semibold"
                >
                  Review & Save Return
                </button>
              </>
            )}
          </>
        )}
      </form>
    </div>
  );
};
