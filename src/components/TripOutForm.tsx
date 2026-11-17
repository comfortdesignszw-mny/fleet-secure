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
  Search,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { enqueueOfflineEntry, isLikelyNetworkError } from '../lib/offlineQueue';
import type {
  Driver,
  FuelLevel,
  TripFlag,
  TripSummary,
  TripType,
  UserPublic,
  Vehicle,
} from '../shared/types';
import { FuelGaugePicker } from './FuelGaugePicker';

interface TripOutFormProps {
  tripType: TripType;
  user: UserPublic;
  onCancel: () => void;
  onSaved: (trip: TripSummary, flags: TripFlag[]) => void;
  onQueued?: (summaryLabel: string) => void;
}

interface OutDraft {
  vehicleId: string;
  driverId: string;
  clientName: string;
  destination: string;
  reason: string;
  mileageOut: string;
  fuelOut: FuelLevel | '';
  checklistBy: string;
  notes: string;
}

export const TripOutForm: React.FC<TripOutFormProps> = ({
  tripType,
  user,
  onCancel,
  onSaved,
  onQueued,
}) => {
  const draftKey = `fleet_secure_draft_out_${tripType}`;

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);

  const [showGuide, setShowGuide] = useState(false);
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [driverSearch, setDriverSearch] = useState('');

  const [vehicleId, setVehicleId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [clientName, setClientName] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [mileageOut, setMileageOut] = useState('');
  const [fuelOut, setFuelOut] = useState<FuelLevel | ''>('');
  const [checklistBy, setChecklistBy] = useState(user.full_name);
  const [notes, setNotes] = useState('');

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore local draft on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw) as Partial<OutDraft>;
        if (d.vehicleId) setVehicleId(d.vehicleId);
        if (d.driverId) setDriverId(d.driverId);
        if (d.clientName) setClientName(d.clientName);
        if (d.destination) setDestination(d.destination);
        if (d.reason) setReason(d.reason);
        if (d.mileageOut) setMileageOut(d.mileageOut);
        if (d.fuelOut) setFuelOut(d.fuelOut);
        if (d.checklistBy) setChecklistBy(d.checklistBy);
        if (d.notes) setNotes(d.notes);
      }
    } catch {
      // Ignore draft parse error
    }
  }, [draftKey]);

  // Autosave draft whenever fields change
  useEffect(() => {
    const draft: OutDraft = {
      vehicleId,
      driverId,
      clientName,
      destination,
      reason,
      mileageOut,
      fuelOut,
      checklistBy,
      notes,
    };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
    } catch {
      // Ignore quota errors
    }
  }, [
    draftKey,
    vehicleId,
    driverId,
    clientName,
    destination,
    reason,
    mileageOut,
    fuelOut,
    checklistBy,
    notes,
  ]);

  useEffect(() => {
    let active = true;
    setLoadingLists(true);
    Promise.all([
      api.listVehicles({ status: 'Available', limit: 100 }),
      api.listDrivers({ status: 'Available', limit: 100 }),
    ])
      .then(([vRes, dRes]) => {
        if (!active) return;
        const bookable = vRes.items.filter(
          (v) => v.active && v.condition !== 'Accident' && v.condition !== 'Grounded'
        );
        const activeDrivers = dRes.items.filter((d) => d.active);
        setVehicles(bookable);
        setDrivers(activeDrivers);
        try {
          localStorage.setItem('fleet_secure_cache_bookable_vehicles', JSON.stringify(bookable));
          localStorage.setItem('fleet_secure_cache_bookable_drivers', JSON.stringify(activeDrivers));
        } catch {
          // Ignore cache write errors
        }
      })
      .catch((err) => {
        if (!active) return;
        try {
          const cachedV = localStorage.getItem('fleet_secure_cache_bookable_vehicles');
          const cachedD = localStorage.getItem('fleet_secure_cache_bookable_drivers');
          if (cachedV && cachedD) {
            setVehicles(JSON.parse(cachedV) as Vehicle[]);
            setDrivers(JSON.parse(cachedD) as Driver[]);
            return;
          }
        } catch {
          // Ignore cache parse error
        }
        setError(
          err instanceof ApiError
            ? err.message
            : 'Could not load available vehicles and drivers.'
        );
      })
      .finally(() => {
        if (active) setLoadingLists(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => String(v.id) === vehicleId) || null,
    [vehicles, vehicleId]
  );

  const selectedDriver = useMemo(
    () => drivers.find((d) => String(d.id) === driverId) || null,
    [drivers, driverId]
  );

  const filteredVehicles = useMemo(() => {
    const q = vehicleSearch.trim().toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter(
      (v) =>
        v.reg_number.toLowerCase().includes(q) ||
        v.make_model.toLowerCase().includes(q) ||
        v.vehicle_type.toLowerCase().includes(q)
    );
  }, [vehicles, vehicleSearch]);

  const filteredDrivers = useMemo(() => {
    const q = driverSearch.trim().toLowerCase();
    if (!q) return drivers;
    return drivers.filter(
      (d) =>
        d.full_name.toLowerCase().includes(q) ||
        d.licence_number.toLowerCase().includes(q)
    );
  }, [drivers, driverSearch]);

  const handleSelectVehicle = (nextId: string) => {
    setVehicleId(nextId);
    const v = vehicles.find((item) => String(item.id) === nextId);
    if (v) {
      setMileageOut(String(v.last_known_mileage));
    }
  };

  const mileageDiff = useMemo(() => {
    if (!selectedVehicle || mileageOut === '') return 0;
    const m = Number(mileageOut);
    if (!Number.isFinite(m)) return 0;
    return m - selectedVehicle.last_known_mileage;
  }, [selectedVehicle, mileageOut]);

  const validateAndConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedDriver) {
      setError('Select the driver taking the vehicle.');
      return;
    }
    if (tripType === 'HIRE' && !clientName.trim()) {
      setError('Enter the client name.');
      return;
    }
    if (tripType === 'ERRAND' && (!destination.trim() || !reason.trim())) {
      setError('Enter both the destination and the reason for the errand.');
      return;
    }
    if (!selectedVehicle) {
      setError('Select a vehicle.');
      return;
    }
    const mOut = Number(mileageOut);
    if (mileageOut === '' || !Number.isInteger(mOut) || mOut < 0) {
      setError('Mileage when leaving must be a whole number (0 or higher).');
      return;
    }
    if (!fuelOut) {
      setError('Tap the fuel gauge level when leaving.');
      return;
    }
    if (!checklistBy.trim()) {
      setError('Enter who completed the opening checklist.');
      return;
    }

    setConfirming(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleFinalSave = async () => {
    if (!selectedVehicle || !selectedDriver || !fuelOut) return;
    setSubmitting(true);
    setError(null);

    const deviceTime = new Date().toISOString();
    const payload = {
      trip_type: tripType,
      vehicle_id: selectedVehicle.id,
      driver_id: selectedDriver.id,
      client_name: tripType === 'HIRE' ? clientName.trim() : undefined,
      destination: tripType === 'ERRAND' ? destination.trim() : undefined,
      reason: tripType === 'ERRAND' ? reason.trim() : undefined,
      mileage_out: Number(mileageOut),
      fuel_out: fuelOut,
      opening_checklist_by: checklistBy.trim(),
      notes: notes.trim(),
      device_time: deviceTime,
    };

    const summaryLabel = `${tripType === 'HIRE' ? 'Hire Out' : 'Errand Out'} · ${selectedVehicle.reg_number} (${selectedDriver.full_name})`;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      enqueueOfflineEntry({
        kind: 'OUT',
        summaryLabel,
        createdAtDevice: deviceTime,
        payload,
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
      const res = await api.createTripOut(payload);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        // Ignore
      }
      onSaved(res.trip, res.flags);
    } catch (err) {
      if (isLikelyNetworkError(err)) {
        enqueueOfflineEntry({
          kind: 'OUT',
          summaryLabel,
          createdAtDevice: deviceTime,
          payload,
        });
        try {
          localStorage.removeItem(draftKey);
        } catch {
          // Ignore
        }
        onQueued?.(summaryLabel);
      } else {
        setConfirming(false);
        setError(err instanceof ApiError ? err.message : 'Could not save this trip.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const title = tripType === 'HIRE' ? 'Hire Out a Vehicle' : 'Send on Errand';

  if (confirming && selectedVehicle && selectedDriver && fuelOut) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div>
              <div className="font-semibold">Check carefully before saving</div>
              <div className="mt-0.5">
                You cannot edit or delete this record after saving. If a mistake happens later, only a Supervisor can add a correction note.
              </div>
            </div>
          </div>

          <h1 className="font-display text-2xl font-bold text-slate-900">Confirm {title}</h1>

          <dl className="divide-y divide-slate-200 text-base">
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Trip Type</dt>
              <dd className="font-semibold text-slate-900">
                {tripType === 'HIRE' ? 'Client Hire' : 'Staff Errand'}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Driver</dt>
              <dd className="font-semibold text-slate-900 text-right">{selectedDriver.full_name}</dd>
            </div>
            {tripType === 'HIRE' ? (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Client Name</dt>
                <dd className="font-semibold text-slate-900 text-right">{clientName.trim()}</dd>
              </div>
            ) : (
              <>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Destination</dt>
                  <dd className="font-semibold text-slate-900 text-right">{destination.trim()}</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Reason</dt>
                  <dd className="font-semibold text-slate-900 text-right">{reason.trim()}</dd>
                </div>
              </>
            )}
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Vehicle</dt>
              <dd className="font-semibold text-slate-900 text-right">
                {selectedVehicle.reg_number} · {selectedVehicle.make_model}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Mileage when leaving</dt>
              <dd className="font-mono tabular-nums font-bold text-slate-900">
                {Number(mileageOut).toLocaleString()} km
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Fuel when leaving</dt>
              <dd className="font-mono font-bold text-slate-900">{fuelOut}</dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Opening checklist by</dt>
              <dd className="font-semibold text-slate-900 text-right">{checklistBy.trim()}</dd>
            </div>
            {notes.trim() && (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Notes</dt>
                <dd className="text-slate-800 text-right">{notes.trim()}</dd>
              </div>
            )}
          </dl>

          {mileageDiff !== 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <span className="font-semibold">Unrecorded Mileage Gap Notice:</span> The last recorded mileage for {selectedVehicle.reg_number} was{' '}
              <span className="font-mono">{selectedVehicle.last_known_mileage.toLocaleString()} km</span>. Saving{' '}
              <span className="font-mono">{Number(mileageOut).toLocaleString()} km</span> will raise a high-priority gap flag ({mileageDiff > 0 ? `+${mileageDiff}` : mileageDiff} km).
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={handleFinalSave}
              className="flex-1 min-h-[52px] inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              <span>{submitting ? 'Saving permanently...' : 'Confirm & Save Permanently'}</span>
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setConfirming(false)}
              className="min-h-[52px] rounded-xl border border-slate-300 bg-white px-5 text-base font-medium text-slate-800 hover:bg-slate-50"
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
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span>Back</span>
        </button>
      </div>

      {/* Collapsible How to fill this in */}
      <div className="rounded-2xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          className="flex w-full min-h-[52px] items-center justify-between gap-3 px-5 py-3 text-left"
        >
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
            <HelpCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span>How to fill this in</span>
          </span>
          {showGuide ? (
            <ChevronUp className="h-5 w-5 text-slate-500" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-5 w-5 text-slate-500" aria-hidden="true" />
          )}
        </button>
        {showGuide && (
          <ol className="border-t border-slate-200 px-5 py-4 text-sm text-slate-700 space-y-1.5 list-decimal pl-9">
            <li>Choose the driver and enter the {tripType === 'HIRE' ? 'client name' : 'destination and reason'}.</li>
            <li>Pick the vehicle leaving the yard (only available roadworthy vehicles appear).</li>
            <li>Read the exact odometer on the dashboard and enter <strong>Mileage when leaving</strong>.</li>
            <li>Look at the fuel needle and tap the matching level on the <strong>Fuel gauge</strong>.</li>
            <li>Enter who did the vehicle checklist, tap <strong>Review & Save</strong>, and confirm.</li>
          </ol>
        )}
      </div>

      <form
        onSubmit={validateAndConfirm}
        className="rounded-2xl border border-slate-200 bg-white p-6 space-y-6"
      >
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">{title}</h1>
          <div className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600">
            <Clock className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <span>Date & time: Locked and recorded automatically by server on save</span>
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

        {loadingLists ? (
          <div className="py-6 text-base text-slate-500">Loading available vehicles and drivers...</div>
        ) : (
          <>
            {/* Driver searchable picker */}
            <div className="space-y-2">
              <label htmlFor="out-driver" className="block text-sm font-semibold text-slate-800">
                Driver
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={driverSearch}
                  onChange={(e) => setDriverSearch(e.target.value)}
                  placeholder="Type to filter drivers..."
                  className="block w-full min-h-[44px] rounded-xl border border-slate-300 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
              </div>
              <select
                id="out-driver"
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
                required
                className="block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
              >
                <option value="">Select available driver ({filteredDrivers.length})</option>
                {filteredDrivers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name} ({d.licence_number})
                  </option>
                ))}
              </select>
              {selectedDriver &&
                (selectedDriver.licence_status === 'EXPIRING_SOON' ||
                  selectedDriver.licence_status === 'EXPIRED') && (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                    <span>
                      {selectedDriver.licence_status === 'EXPIRED'
                        ? `Warning: ${selectedDriver.full_name}'s driving licence expired on ${selectedDriver.licence_expiry}.`
                        : `Notice: ${selectedDriver.full_name}'s licence expires in ${selectedDriver.days_to_expiry} days (${selectedDriver.licence_expiry}).`}
                    </span>
                  </div>
                )}
            </div>

            {/* Client or Destination + Reason */}
            {tripType === 'HIRE' ? (
              <div>
                <label htmlFor="out-client" className="block text-sm font-semibold text-slate-800">
                  Client Name
                </label>
                <input
                  id="out-client"
                  type="text"
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Full name of client or company hiring"
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label htmlFor="out-dest" className="block text-sm font-semibold text-slate-800">
                    Destination
                  </label>
                  <input
                    id="out-dest"
                    type="text"
                    required
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="Where is the vehicle going?"
                    className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="out-reason" className="block text-sm font-semibold text-slate-800">
                    Reason for Errand
                  </label>
                  <input
                    id="out-reason"
                    type="text"
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Spare parts collection, service drop-off"
                    className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>
            )}

            {/* Vehicle searchable picker */}
            <div className="space-y-2">
              <label htmlFor="out-vehicle" className="block text-sm font-semibold text-slate-800">
                Vehicle
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={vehicleSearch}
                  onChange={(e) => setVehicleSearch(e.target.value)}
                  placeholder="Type reg number or model..."
                  className="block w-full min-h-[44px] rounded-xl border border-slate-300 pl-10 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
              </div>
              <select
                id="out-vehicle"
                value={vehicleId}
                onChange={(e) => handleSelectVehicle(e.target.value)}
                required
                className="block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
              >
                <option value="">Select available vehicle ({filteredVehicles.length})</option>
                {filteredVehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.reg_number} — {v.make_model} ({v.vehicle_type})
                  </option>
                ))}
              </select>

              {selectedVehicle && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    <strong className="text-slate-900">{selectedVehicle.reg_number}</strong> ·{' '}
                    {selectedVehicle.make_model}
                  </span>
                  <span>
                    {selectedVehicle.vehicle_type} ({selectedVehicle.vehicle_class})
                  </span>
                  <span className="font-mono tabular-nums">
                    Last odometer: {selectedVehicle.last_known_mileage.toLocaleString()} km
                  </span>
                </div>
              )}
            </div>

            {/* Mileage when leaving */}
            <div>
              <label htmlFor="out-mileage" className="block text-sm font-semibold text-slate-800">
                Mileage when leaving (km)
              </label>
              <input
                id="out-mileage"
                type="number"
                inputMode="numeric"
                min={0}
                step="1"
                required
                value={mileageOut}
                onChange={(e) => setMileageOut(e.target.value)}
                placeholder="Enter dashboard odometer reading"
                className="mt-1.5 block w-full min-h-[52px] rounded-xl border border-slate-300 px-4 font-mono tabular-nums text-lg font-semibold text-slate-900 focus:border-slate-900 focus:outline-none"
              />
              {selectedVehicle && mileageDiff !== 0 && (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                  <span>
                    Last recorded mileage was{' '}
                    <strong className="font-mono">
                      {selectedVehicle.last_known_mileage.toLocaleString()} km
                    </strong>
                    . This difference ({mileageDiff > 0 ? `+${mileageDiff}` : mileageDiff} km) will be flagged as an unrecorded gap for your Supervisor.
                  </span>
                </div>
              )}
            </div>

            {/* Visual Fuel Gauge */}
            <FuelGaugePicker
              label="Fuel when leaving"
              value={fuelOut}
              onChange={(lvl) => setFuelOut(lvl)}
            />

            {/* Checklist by */}
            <div>
              <label htmlFor="out-checklist" className="block text-sm font-semibold text-slate-800">
                Opening checklist done by
              </label>
              <input
                id="out-checklist"
                type="text"
                required
                value={checklistBy}
                onChange={(e) => setChecklistBy(e.target.value)}
                className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
              />
            </div>

            {/* Notes */}
            <div>
              <label htmlFor="out-notes" className="block text-sm font-semibold text-slate-800">
                Notes (optional)
              </label>
              <textarea
                id="out-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any scratches, spare wheel check, or extra remarks..."
                className="mt-1.5 block w-full rounded-xl border border-slate-300 p-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full min-h-[52px] rounded-xl bg-slate-900 px-5 text-base font-semibold text-white hover:bg-slate-800"
            >
              Review & Save
            </button>
          </>
        )}
      </form>
    </div>
  );
};
