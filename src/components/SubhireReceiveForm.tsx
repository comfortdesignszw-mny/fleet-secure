import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookmarkCheck,
  Car,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  Link2,
  Lock,
  Plus,
  Search,
  Unlink,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { CACHE_KEYS, ONLINE_RECONNECTED_EVENT, readCachedEntry, type CachedVehiclesPayload } from '../lib/offlineCache';
import { OFFLINE_SYNCED_EVENT, enqueueOfflineEntry, isLikelyNetworkError } from '../lib/offlineQueue';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_TYPES,
  VEHICLE_TYPE_TO_CLASS,
  evaluateChecklistVehicleMatch,
  formatSubhiredMakeModel,
  toHarareYmd,
  type ChecklistSummary,
  type CreateSubhirePayload,
  type FuelLevel,
  type SubhireReceipt,
  type UserPublic,
  type Vehicle,
  type VehicleCondition,
  type VehicleFuelType,
} from '../shared/types';
import type { ChecklistPrefill } from './ChecklistsView';
import { FuelGaugePicker } from './FuelGaugePicker';
import { LinkChecklistModal } from './LinkChecklistModal';

interface SubhireReceiveFormProps {
  user: UserPublic;
  externalLinkedChecklist?: ChecklistSummary | null;
  onConsumeExternalLinkedChecklist?: () => void;
  onStartCreateChecklist?: (prefill: ChecklistPrefill) => void;
  onCancel: () => void;
  onSaved: (receipt: SubhireReceipt, vehicle: Vehicle) => void;
  onQueued?: (summaryLabel: string) => void;
}

interface LinkedChecklistBadge {
  id: number;
  hirer_type?: 'renter' | 'owner';
  reg_number: string;
  vehicle_type?: string;
  hirer_name: string;
  hire_date: string;
  created_at?: string;
  status: 'out' | 'completed';
  vehicle_id: number;
}

interface SubhireDraft {
  subhirerName: string;
  representative: string;
  phone: string;
  address: string;
  vehicleEntryMode: 'new' | 'existing';
  existingVehicleId: string;
  regNumber: string;
  vehicleType: string;
  makeModel: string;
  colour: string;
  fuelType: VehicleFuelType;
  condition: VehicleCondition;
  startingOdometer: string;
  nextServiceDueKm: string;
  saveToDirectory: boolean;
  receivedMileage: string;
  fuelLevel: FuelLevel | '';
  checklistBy: string;
  linkedChecklist: LinkedChecklistBadge | null;
  notes: string;
}

const DRAFT_KEY = 'fleet_secure_draft_subhire_receive';

const RECEIVE_CONDITIONS = VEHICLE_CONDITIONS.filter(
  (c) => c !== 'Accident' && c !== 'Grounded'
);

export const SubhireReceiveForm: React.FC<SubhireReceiveFormProps> = ({
  user,
  externalLinkedChecklist = null,
  onConsumeExternalLinkedChecklist,
  onStartCreateChecklist,
  onCancel,
  onSaved,
  onQueued,
}) => {
  const canMaintain = user.role === 'FLEET_MANAGER' || user.role === 'ADMIN';

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  // Section A — Subhirer Details
  const [subhirerName, setSubhirerName] = useState('');
  const [representative, setRepresentative] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  // Section B — Vehicle Details (Add New Vehicle Form or pick existing)
  const [vehicleEntryMode, setVehicleEntryMode] = useState<'new' | 'existing'>('new');
  const [existingVehicleId, setExistingVehicleId] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [regNumber, setRegNumber] = useState('');
  const [vehicleType, setVehicleType] = useState<string>(VEHICLE_TYPES[0]);
  const [makeModel, setMakeModel] = useState('');
  const [colour, setColour] = useState('');
  const [fuelType, setFuelType] = useState<VehicleFuelType>('diesel');
  const [condition, setCondition] = useState<VehicleCondition>('Good');
  const [startingOdometer, setStartingOdometer] = useState('0');
  const [nextServiceDueKm, setNextServiceDueKm] = useState('');
  const [saveToDirectory, setSaveToDirectory] = useState(true);

  // Handover / Inspection fields
  const [receivedMileage, setReceivedMileage] = useState('0');
  const [fuelLevel, setFuelLevel] = useState<FuelLevel | ''>('');
  const [checklistBy, setChecklistBy] = useState(user.full_name);
  const [linkedChecklist, setLinkedChecklist] = useState<LinkedChecklistBadge | null>(null);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [notes, setNotes] = useState('');

  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore local draft on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Partial<SubhireDraft>;
        if (d.subhirerName !== undefined) setSubhirerName(d.subhirerName);
        if (d.representative !== undefined) setRepresentative(d.representative);
        if (d.phone !== undefined) setPhone(d.phone);
        if (d.address !== undefined) setAddress(d.address);
        if (d.vehicleEntryMode) setVehicleEntryMode(d.vehicleEntryMode);
        if (d.existingVehicleId !== undefined) setExistingVehicleId(d.existingVehicleId);
        if (d.regNumber !== undefined) setRegNumber(d.regNumber);
        if (d.vehicleType) setVehicleType(d.vehicleType);
        if (d.makeModel !== undefined) setMakeModel(d.makeModel);
        if (d.colour !== undefined) setColour(d.colour);
        if (d.fuelType) setFuelType(d.fuelType);
        if (d.condition) setCondition(d.condition);
        if (d.startingOdometer !== undefined) setStartingOdometer(d.startingOdometer);
        if (d.nextServiceDueKm !== undefined) setNextServiceDueKm(d.nextServiceDueKm);
        if (d.saveToDirectory !== undefined) setSaveToDirectory(d.saveToDirectory);
        if (d.receivedMileage !== undefined) setReceivedMileage(d.receivedMileage);
        if (d.fuelLevel !== undefined) setFuelLevel(d.fuelLevel);
        if (d.checklistBy !== undefined) setChecklistBy(d.checklistBy);
        if (d.linkedChecklist !== undefined) setLinkedChecklist(d.linkedChecklist);
        if (d.notes !== undefined) setNotes(d.notes);
      }
    } catch {
      // Ignore draft parse errors
    }
  }, []);

  // Consume newly returned Owner checklist when coming back from ChecklistsView
  useEffect(() => {
    if (!externalLinkedChecklist || externalLinkedChecklist.hirer_type !== 'owner') return;
    setLinkedChecklist({
      id: externalLinkedChecklist.id,
      hirer_type: externalLinkedChecklist.hirer_type,
      reg_number: externalLinkedChecklist.reg_number,
      vehicle_type: externalLinkedChecklist.vehicle_type,
      hirer_name: externalLinkedChecklist.hirer_name,
      hire_date: externalLinkedChecklist.hire_date,
      created_at: externalLinkedChecklist.created_at,
      status: externalLinkedChecklist.status,
      vehicle_id: externalLinkedChecklist.vehicle_id,
    });
    if (!subhirerName.trim() && externalLinkedChecklist.hirer_name) {
      setSubhirerName(externalLinkedChecklist.hirer_name);
    }
    if (!representative.trim() && externalLinkedChecklist.representative) {
      setRepresentative(externalLinkedChecklist.representative);
    }
    if (!phone.trim() && externalLinkedChecklist.cell) {
      setPhone(externalLinkedChecklist.cell);
    }
    if (externalLinkedChecklist.created_by_name) {
      setChecklistBy(externalLinkedChecklist.created_by_name);
    }
    if (externalLinkedChecklist.vehicle_id > 0) {
      setVehicleEntryMode('existing');
      setExistingVehicleId(String(externalLinkedChecklist.vehicle_id));
      setReceivedMileage(String(externalLinkedChecklist.mileage_out));
      if (externalLinkedChecklist.fuel_out) {
        setFuelLevel(externalLinkedChecklist.fuel_out);
      }
    }
    onConsumeExternalLinkedChecklist?.();
  }, [
    externalLinkedChecklist,
    subhirerName,
    representative,
    phone,
    onConsumeExternalLinkedChecklist,
  ]);

  // Persist draft
  useEffect(() => {
    const draft: SubhireDraft = {
      subhirerName,
      representative,
      phone,
      address,
      vehicleEntryMode,
      existingVehicleId,
      regNumber,
      vehicleType,
      makeModel,
      colour,
      fuelType,
      condition,
      startingOdometer,
      nextServiceDueKm,
      saveToDirectory,
      receivedMileage,
      fuelLevel,
      checklistBy,
      linkedChecklist,
      notes,
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Ignore storage quota errors
    }
  }, [
    subhirerName,
    representative,
    phone,
    address,
    vehicleEntryMode,
    existingVehicleId,
    regNumber,
    vehicleType,
    makeModel,
    colour,
    fuelType,
    condition,
    startingOdometer,
    nextServiceDueKm,
    saveToDirectory,
    receivedMileage,
    fuelLevel,
    checklistBy,
    linkedChecklist,
    notes,
  ]);

  useEffect(() => {
    let active = true;
    const loadVehicles = () => {
      setLoadingVehicles(true);
      api
        .listVehicles({ limit: 500 })
        .then((res) => {
          if (!active) return;
          setVehicles(res.items.filter((v) => v.active));
        })
        .catch(() => {
          if (!active) return;
          const cached = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
          if (cached) {
            setVehicles(cached.data.items.filter((v) => v.active));
          }
        })
        .finally(() => {
          if (active) setLoadingVehicles(false);
        });
    };
    loadVehicles();
    window.addEventListener(ONLINE_RECONNECTED_EVENT, loadVehicles);
    window.addEventListener(OFFLINE_SYNCED_EVENT, loadVehicles);
    return () => {
      active = false;
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, loadVehicles);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, loadVehicles);
    };
  }, []);

  const filteredVehicles = useMemo(() => {
    const q = vehicleSearch.trim().toLowerCase();
    const sorted = [...vehicles].sort((a, b) => {
      const aSub = /\(subhired\)/i.test(a.make_model) ? 0 : 1;
      const bSub = /\(subhired\)/i.test(b.make_model) ? 0 : 1;
      return aSub - bSub;
    });
    if (!q) return sorted;
    return sorted.filter(
      (v) =>
        v.reg_number.toLowerCase().includes(q) ||
        v.make_model.toLowerCase().includes(q) ||
        v.vehicle_type.toLowerCase().includes(q)
    );
  }, [vehicles, vehicleSearch]);

  const selectedExistingVehicle = useMemo(
    () => vehicles.find((v) => String(v.id) === existingVehicleId) || null,
    [vehicles, existingVehicleId]
  );

  const formattedMakeModelPreview = useMemo(
    () => (makeModel.trim() ? formatSubhiredMakeModel(makeModel) : ''),
    [makeModel]
  );

  const handleSelectExistingVehicle = (nextId: string) => {
    setExistingVehicleId(nextId);
    const v = vehicles.find((x) => String(x.id) === nextId);
    if (v) {
      setReceivedMileage(String(v.last_known_mileage));
    }
  };

  const effectiveSubhireReg =
    vehicleEntryMode === 'existing'
      ? selectedExistingVehicle?.reg_number ?? ''
      : regNumber.trim().toUpperCase().replace(/\s+/g, ' ');
  const effectiveSubhireType =
    vehicleEntryMode === 'existing'
      ? selectedExistingVehicle?.vehicle_type ?? ''
      : vehicleType;

  const linkedChecklistMatch = useMemo(() => {
    if (!linkedChecklist) return null;
    if (vehicleEntryMode === 'existing' && existingVehicleId && !selectedExistingVehicle && loadingVehicles) {
      return null;
    }
    return evaluateChecklistVehicleMatch(
      {
        hirer_type: linkedChecklist.hirer_type ?? 'owner',
        hirer_name: linkedChecklist.hirer_name,
        reg_number: linkedChecklist.reg_number,
        vehicle_type: linkedChecklist.vehicle_type ?? '',
        created_at: linkedChecklist.created_at || linkedChecklist.hire_date,
      },
      {
        expectedHirerType: 'owner',
        partyName: subhirerName,
        regNumber: effectiveSubhireReg,
        vehicleType: effectiveSubhireType,
        logDateYmd: toHarareYmd(new Date()),
      }
    );
  }, [
    linkedChecklist,
    vehicleEntryMode,
    existingVehicleId,
    selectedExistingVehicle,
    loadingVehicles,
    subhirerName,
    effectiveSubhireReg,
    effectiveSubhireType,
  ]);

  const handleSelectLinkedChecklist = (chk: ChecklistSummary) => {
    setLinkedChecklist({
      id: chk.id,
      hirer_type: chk.hirer_type,
      reg_number: chk.reg_number,
      vehicle_type: chk.vehicle_type,
      hirer_name: chk.hirer_name,
      hire_date: chk.hire_date,
      created_at: chk.created_at,
      status: chk.status,
      vehicle_id: chk.vehicle_id,
    });
    if (!checklistBy.trim() || checklistBy === user.full_name) {
      setChecklistBy(chk.created_by_name || chk.representative || user.full_name);
    }
    if (!subhirerName.trim() && chk.hirer_name) {
      setSubhirerName(chk.hirer_name);
    }
    if (!representative.trim() && chk.representative) {
      setRepresentative(chk.representative);
    }
    if (!phone.trim() && chk.cell) {
      setPhone(chk.cell);
    }
    setShowLinkModal(false);
  };

  const handleCreateNewLinkedChecklist = () => {
    setShowLinkModal(false);
    if (!onStartCreateChecklist) return;
    const odometerNum = Number(receivedMileage || startingOdometer || 0);
    onStartCreateChecklist({
      hirer_type: 'owner',
      hirer_name: subhirerName.trim(),
      representative: representative.trim(),
      cell: phone.trim(),
      vehicle_id:
        vehicleEntryMode === 'existing' && selectedExistingVehicle
          ? selectedExistingVehicle.id
          : undefined,
      mileage_out: Number.isInteger(odometerNum) && odometerNum >= 0 ? odometerNum : 0,
      fuel_out: fuelLevel || 'Full',
      new_vehicle:
        vehicleEntryMode === 'new' && regNumber.trim() && makeModel.trim()
          ? {
              reg_number: regNumber.trim().toUpperCase().replace(/\s+/g, ' '),
              vehicle_type: vehicleType,
              make_model: formatSubhiredMakeModel(makeModel),
              colour: colour.trim() || null,
              fuel_type: fuelType,
              condition,
              last_known_mileage:
                Number.isInteger(Number(startingOdometer)) && Number(startingOdometer) >= 0
                  ? Number(startingOdometer)
                  : 0,
              next_service_due_km:
                canMaintain && nextServiceDueKm.trim() !== '' ? Number(nextServiceDueKm) : null,
            }
          : undefined,
      returnTarget: { kind: 'SUBHIRE' },
    });
  };

  const validateAndConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (subhirerName.trim().length < 2) {
      setError('Enter the Subhirer Name (at least 2 characters).');
      return;
    }
    if (phone.trim().length < 5) {
      setError('Enter a valid Phone Number for the Subhirer.');
      return;
    }

    if (vehicleEntryMode === 'existing') {
      if (!selectedExistingVehicle) {
        setError('Select an existing vehicle or switch to Add New Vehicle.');
        return;
      }
    } else {
      const cleanReg = regNumber.trim().toUpperCase().replace(/\s+/g, ' ');
      if (cleanReg.length < 3) {
        setError('Registration Number must be at least 3 characters.');
        return;
      }
      if (makeModel.trim().length < 2) {
        setError('Enter the vehicle Make & Model.');
        return;
      }
      const startKm = Number(startingOdometer);
      if (!Number.isInteger(startKm) || startKm < 0) {
        setError('Current Odometer must be a whole number 0 or greater.');
        return;
      }
      if (
        canMaintain &&
        nextServiceDueKm.trim() !== '' &&
        (!Number.isInteger(Number(nextServiceDueKm)) || Number(nextServiceDueKm) < 0)
      ) {
        setError('Next Service Due mileage must be a whole number 0 or greater.');
        return;
      }
    }

    const rMileage = Number(receivedMileage);
    if (!Number.isInteger(rMileage) || rMileage < 0) {
      setError('Mileage when received must be a whole number 0 or greater.');
      return;
    }
    if (!fuelLevel) {
      setError('Tap a fuel level on the gauge for when the vehicle is received.');
      return;
    }
    if (!checklistBy.trim()) {
      setError('Enter the name of the person who did the checklist.');
      return;
    }
    if (linkedChecklist && linkedChecklistMatch && !linkedChecklistMatch.matched) {
      setError(linkedChecklistMatch.reasons[0]);
      return;
    }

    setConfirming(true);
  };

  const handleFinalSave = async () => {
    setError(null);
    setSubmitting(true);

    const payload: CreateSubhirePayload = {
      subhirer_name: subhirerName.trim(),
      representative: representative.trim(),
      phone: phone.trim(),
      address: address.trim(),
      received_mileage: Number(receivedMileage),
      fuel_level: fuelLevel as FuelLevel,
      opening_checklist_by: checklistBy.trim(),
      checklist_id: linkedChecklist ? linkedChecklist.id : null,
      notes: notes.trim(),
      device_time: new Date().toISOString(),
      ...(vehicleEntryMode === 'existing' && selectedExistingVehicle
        ? { vehicle_id: selectedExistingVehicle.id }
        : {
            new_vehicle: {
              reg_number: regNumber.trim().toUpperCase().replace(/\s+/g, ' '),
              vehicle_type: vehicleType,
              make_model: formatSubhiredMakeModel(makeModel),
              colour: colour.trim() || null,
              fuel_type: fuelType,
              condition,
              last_known_mileage: Number(startingOdometer),
              ...(canMaintain && nextServiceDueKm.trim() !== ''
                ? { next_service_due_km: Number(nextServiceDueKm) }
                : {}),
              save_to_directory: saveToDirectory,
            },
          }),
    };

    try {
      const res = await api.createSubhire(payload);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Ignore
      }
      onSaved(res.receipt, res.vehicle);
    } catch (err) {
      if (isLikelyNetworkError(err)) {
        const regLabel =
          vehicleEntryMode === 'existing' && selectedExistingVehicle
            ? selectedExistingVehicle.reg_number
            : regNumber.trim().toUpperCase();
        const summaryLabel = `Receive Subhired · ${regLabel} (${subhirerName.trim()})`;
        enqueueOfflineEntry({
          kind: 'SUBHIRE_CREATE',
          summaryLabel,
          payload,
        });
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {
          // Ignore
        }
        if (onQueued) {
          onQueued(summaryLabel);
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not save subhired vehicle.');
        setConfirming(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (confirming) {
    const displayReg =
      vehicleEntryMode === 'existing' && selectedExistingVehicle
        ? selectedExistingVehicle.reg_number
        : regNumber.trim().toUpperCase().replace(/\s+/g, ' ');
    const displayModel =
      vehicleEntryMode === 'existing' && selectedExistingVehicle
        ? selectedExistingVehicle.make_model
        : formattedMakeModelPreview;

    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="cyan-glow-card rounded-2xl border border-blue-200/80 bg-white p-6 space-y-5">
          <div className="flex items-start gap-3 rounded-xl border border-cyan-300 bg-cyan-50/70 p-4 text-cyan-950">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-cyan-700" aria-hidden="true" />
            <div className="text-sm leading-relaxed">
              <div className="font-semibold">Confirm Subhired Vehicle Receipt</div>
              <div>
                The vehicle will be registered into the fleet
                {vehicleEntryMode === 'new' && saveToDirectory ? ` as "${displayModel}"` : ''} and this receipt will be logged permanently.
              </div>
            </div>
          </div>

          <h1 className="font-display text-2xl font-bold text-blue-950">
            Confirm Receive Vehicle From Subhirer
          </h1>

          <dl className="divide-y divide-blue-100 text-base">
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Subhirer Name</dt>
              <dd className="font-semibold text-blue-950 text-right">{subhirerName.trim()}</dd>
            </div>
            {representative.trim() && (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Representative</dt>
                <dd className="font-semibold text-blue-950 text-right">{representative.trim()}</dd>
              </div>
            )}
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Phone Number</dt>
              <dd className="font-mono font-semibold text-blue-950 text-right">{phone.trim()}</dd>
            </div>
            {address.trim() && (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Address</dt>
                <dd className="text-slate-800 text-right">{address.trim()}</dd>
              </div>
            )}
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Vehicle</dt>
              <dd className="font-semibold text-blue-950 text-right">
                <div>
                  <span className="font-mono">{displayReg}</span> · {displayModel}
                </div>
                {vehicleEntryMode === 'new' && (
                  <div className="mt-1 text-xs font-medium text-cyan-800">
                    {vehicleType} · {colour.trim() || 'No colour'} · {condition} ·{' '}
                    {saveToDirectory ? 'Save to Vehicles Directory' : 'Use Once'}
                  </div>
                )}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Mileage when received</dt>
              <dd className="font-mono tabular-nums font-bold text-blue-950">
                {Number(receivedMileage).toLocaleString()} km
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Fuel when received</dt>
              <dd className="font-mono font-bold text-cyan-700">{fuelLevel}</dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Checklist done by</dt>
              <dd className="font-semibold text-blue-950 text-right">
                <div>{checklistBy.trim()}</div>
                {linkedChecklist && (
                  <div className="mt-0.5 text-xs font-medium text-cyan-800">
                    Linked Owner&apos;s Checklist #{linkedChecklist.id} ({linkedChecklist.reg_number} · {linkedChecklist.hirer_name})
                  </div>
                )}
              </dd>
            </div>
            {notes.trim() && (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Notes</dt>
                <dd className="text-slate-800 text-right">{notes.trim()}</dd>
              </div>
            )}
          </dl>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="button"
              disabled={submitting}
              onClick={handleFinalSave}
              className="cyan-glow-btn flex-1 min-h-[52px] inline-flex items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold disabled:opacity-60"
            >
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              <span>{submitting ? 'Saving permanently...' : 'Confirm & Save Permanently'}</span>
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => setConfirming(false)}
              className="cyan-glow-outline min-h-[52px] rounded-xl border border-blue-200 bg-white px-5 text-base font-medium text-blue-900"
            >
              Go Back &amp; Edit
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
            <li>Enter the external <strong>Subhirer Details</strong> (name, representative, phone, and address).</li>
            <li>Complete <strong>Section B — Vehicle Details</strong>; the vehicle will be saved with <strong>(Subhired)</strong> added to its Make &amp; Model (e.g. <em>Toyota Hilux (Subhired)</em>).</li>
            <li>Record the <strong>Mileage when received</strong> and tap the matching <strong>Fuel gauge</strong> level.</li>
            <li>Enter who did the inspection and click <strong>Link the Checklist</strong> to attach or create the matching <strong>Owner&apos;s Checklist</strong>.</li>
          </ol>
        )}
      </div>

      <form
        onSubmit={validateAndConfirm}
        className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-6 shadow-xs"
      >
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">
            Receive a Vehicle From Subhirer
          </h1>
          <div className="mt-2 inline-flex items-center gap-2 text-sm text-slate-600">
            <Clock className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Date &amp; time: Locked and recorded automatically by server on save</span>
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

        {/* Section A — Subhirer Details */}
        <div className="rounded-xl border border-blue-200/90 bg-blue-50/30 p-4 space-y-4">
          <div>
            <h2 className="text-base font-bold text-blue-950">Section A — Subhirer Details</h2>
            <p className="text-xs text-slate-600">
              Company or owner supplying the external vehicle into your fleet
            </p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sub-name" className="block text-sm font-semibold text-blue-950">
                Subhirer Name *
              </label>
              <input
                id="sub-name"
                type="text"
                required
                value={subhirerName}
                onChange={(e) => setSubhirerName(e.target.value)}
                placeholder="Company or owner full name"
                className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
              />
            </div>
            <div>
              <label htmlFor="sub-rep" className="block text-sm font-semibold text-blue-950">
                Representative
              </label>
              <input
                id="sub-rep"
                type="text"
                value={representative}
                onChange={(e) => setRepresentative(e.target.value)}
                placeholder="Contact person / driver handing over"
                className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
              />
            </div>
            <div>
              <label htmlFor="sub-phone" className="block text-sm font-semibold text-blue-950">
                Phone Number *
              </label>
              <input
                id="sub-phone"
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+263 77..."
                className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 font-mono text-base text-blue-950"
              />
            </div>
            <div>
              <label htmlFor="sub-addr" className="block text-sm font-semibold text-blue-950">
                Address
              </label>
              <input
                id="sub-addr"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Subhirer physical address"
                className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
              />
            </div>
          </div>
        </div>

        {/* Section B — Vehicle Details (Add New Vehicle Form) */}
        <div className="rounded-xl border border-cyan-300/90 bg-blue-50/40 p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-blue-950">
                Section B — Vehicle Details ({vehicleEntryMode === 'new' ? 'Add New Vehicle' : 'Directory Vehicle'})
              </h2>
              <p className="text-xs text-slate-600">
                {vehicleEntryMode === 'new'
                  ? 'Saved automatically with (Subhired) added to Make & Model.'
                  : 'Select an already registered vehicle from the directory.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setVehicleEntryMode((prev) => (prev === 'new' ? 'existing' : 'new'))
              }
              className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-cyan-300 bg-white px-3 text-xs font-semibold text-blue-900"
            >
              {vehicleEntryMode === 'new' ? (
                <>
                  <Car className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                  <span>Pick Existing Vehicle</span>
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                  <span>Add New Vehicle</span>
                </>
              )}
            </button>
          </div>

          {vehicleEntryMode === 'existing' ? (
            <div className="space-y-3">
              {loadingVehicles ? (
                <div className="text-sm text-slate-500">Loading vehicles directory...</div>
              ) : (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-600"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={vehicleSearch}
                      onChange={(e) => setVehicleSearch(e.target.value)}
                      placeholder="Filter directory by reg number, make/model, or type..."
                      className="cyan-glow-input block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white pl-10 pr-3 text-sm text-blue-950"
                    />
                  </div>
                  <select
                    value={existingVehicleId}
                    onChange={(e) => handleSelectExistingVehicle(e.target.value)}
                    className="cyan-glow-input block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-sm text-blue-950"
                  >
                    <option value="">Select vehicle ({filteredVehicles.length} available)</option>
                    {filteredVehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.reg_number} — {v.make_model} ({v.vehicle_type})
                      </option>
                    ))}
                  </select>
                  {selectedExistingVehicle && (
                    <div className="rounded-xl border border-blue-200 bg-white p-3 text-xs sm:text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        <strong className="font-mono text-blue-950">{selectedExistingVehicle.reg_number}</strong> ·{' '}
                        {selectedExistingVehicle.make_model}
                      </span>
                      <span className="font-mono text-cyan-800 font-medium">
                        Last odometer: {selectedExistingVehicle.last_known_mileage.toLocaleString()} km
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="sub-v-reg" className="block text-sm font-semibold text-blue-950">
                    Registration Number *
                  </label>
                  <input
                    id="sub-v-reg"
                    type="text"
                    required
                    value={regNumber}
                    onChange={(e) => setRegNumber(e.target.value.toUpperCase())}
                    placeholder="e.g. AFX 4821"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 font-mono uppercase text-base text-blue-950"
                  />
                </div>

                <div>
                  <label htmlFor="sub-v-type" className="block text-sm font-semibold text-blue-950">
                    Vehicle Type *
                  </label>
                  <select
                    id="sub-v-type"
                    value={vehicleType}
                    onChange={(e) => setVehicleType(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    {VEHICLE_TYPES.map((vt) => (
                      <option key={vt} value={vt}>
                        {vt} ({VEHICLE_TYPE_TO_CLASS[vt]})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">
                    Fuel class:{' '}
                    <span className="font-semibold text-cyan-700">
                      {VEHICLE_TYPE_TO_CLASS[vehicleType] ?? 'ECONOMY'}
                    </span>
                  </p>
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="sub-v-make" className="block text-sm font-semibold text-blue-950">
                    Make &amp; Model *
                  </label>
                  <input
                    id="sub-v-make"
                    type="text"
                    required
                    value={makeModel}
                    onChange={(e) => setMakeModel(e.target.value)}
                    placeholder="e.g. Toyota Hilux"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  />
                  {formattedMakeModelPreview && (
                    <p className="mt-1 text-xs font-medium text-cyan-800">
                      Saved in Vehicles Directory as:{' '}
                      <strong className="text-blue-950">{formattedMakeModelPreview}</strong>
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="sub-v-colour" className="block text-sm font-semibold text-blue-950">
                    Colour (optional)
                  </label>
                  <input
                    id="sub-v-colour"
                    type="text"
                    value={colour}
                    onChange={(e) => setColour(e.target.value)}
                    placeholder="e.g. White"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  />
                </div>

                <div>
                  <label htmlFor="sub-v-fuel" className="block text-sm font-semibold text-blue-950">
                    Fuel Type
                  </label>
                  <select
                    id="sub-v-fuel"
                    value={fuelType}
                    onChange={(e) => setFuelType(e.target.value as VehicleFuelType)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    {VEHICLE_FUEL_TYPES.map((ft) => (
                      <option key={ft.value} value={ft.value}>
                        {ft.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="sub-v-cond" className="block text-sm font-semibold text-blue-950">
                    Vehicle Condition
                  </label>
                  <select
                    id="sub-v-cond"
                    value={condition}
                    onChange={(e) => setCondition(e.target.value as VehicleCondition)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    {RECEIVE_CONDITIONS.map((cond) => (
                      <option key={cond} value={cond}>
                        {cond}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="sub-v-odo" className="block text-sm font-semibold text-blue-950">
                    Current Odometer (km) *
                  </label>
                  <input
                    id="sub-v-odo"
                    type="number"
                    min={0}
                    step="1"
                    required
                    value={startingOdometer}
                    onChange={(e) => {
                      const val = e.target.value;
                      setStartingOdometer(val);
                      if (receivedMileage === startingOdometer || receivedMileage === '0' || receivedMileage === '') {
                        setReceivedMileage(val);
                      }
                    }}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 font-mono tabular-nums text-base text-blue-950"
                  />
                </div>

                {canMaintain && (
                  <div className="sm:col-span-2">
                    <label htmlFor="sub-v-svc" className="block text-sm font-semibold text-blue-950">
                      Next Service Due (km, optional)
                    </label>
                    <input
                      id="sub-v-svc"
                      type="number"
                      min={0}
                      step="1"
                      value={nextServiceDueKm}
                      onChange={(e) => setNextServiceDueKm(e.target.value)}
                      placeholder="e.g. 135000"
                      className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3.5 font-mono tabular-nums text-base text-blue-950"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setSaveToDirectory(true)}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                    saveToDirectory
                      ? 'border-cyan-500 bg-cyan-50/90 ring-2 ring-cyan-400/40'
                      : 'border-blue-200 bg-white hover:border-cyan-300'
                  }`}
                >
                  <BookmarkCheck
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      saveToDirectory ? 'text-cyan-700' : 'text-slate-400'
                    }`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className="text-xs font-bold text-blue-950">
                      Save to Vehicles Directory
                    </div>
                    <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                      Add to active fleet as {formattedMakeModelPreview || 'Make & Model (Subhired)'}.
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setSaveToDirectory(false)}
                  className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                    !saveToDirectory
                      ? 'border-amber-500 bg-amber-50/90 ring-2 ring-amber-400/40'
                      : 'border-blue-200 bg-white hover:border-cyan-300'
                  }`}
                >
                  <Zap
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      !saveToDirectory ? 'text-amber-700' : 'text-slate-400'
                    }`}
                    aria-hidden="true"
                  />
                  <div>
                    <div className="text-xs font-bold text-blue-950">
                      Record for this intake only
                    </div>
                    <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                      Keep history without adding to active dispatch list.
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Mileage when received */}
        <div>
          <label htmlFor="sub-mileage" className="block text-sm font-semibold text-blue-950">
            Mileage when received (km)
          </label>
          <input
            id="sub-mileage"
            type="number"
            inputMode="numeric"
            min={0}
            step="1"
            required
            value={receivedMileage}
            onChange={(e) => setReceivedMileage(e.target.value)}
            placeholder="Enter dashboard odometer reading"
            className="cyan-glow-input mt-1.5 block w-full min-h-[52px] rounded-xl border border-blue-200 px-4 font-mono tabular-nums text-lg font-semibold text-blue-950"
          />
        </div>

        {/* Fuel gauge */}
        <FuelGaugePicker
          label="Fuel level when received"
          value={fuelLevel}
          onChange={(lvl) => setFuelLevel(lvl)}
        />

        {/* Checklist done by + Link the Checklist (Owner's Checklist) */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="sub-checklist-by" className="block text-sm font-semibold text-blue-950">
              Checklist done by
            </label>
            <button
              type="button"
              onClick={() => setShowLinkModal(true)}
              className="cyan-glow-outline inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-cyan-300 bg-cyan-50/70 px-3 text-xs font-semibold text-blue-950"
            >
              <Link2 className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
              <span>{linkedChecklist ? 'Change Linked Checklist' : 'Link the Checklist'}</span>
            </button>
          </div>
          <input
            id="sub-checklist-by"
            type="text"
            required
            value={checklistBy}
            onChange={(e) => setChecklistBy(e.target.value)}
            placeholder="Name of person checking the received vehicle"
            className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
          />
          {linkedChecklist && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-300 bg-cyan-50/70 px-3.5 py-2.5 text-xs text-blue-950">
                <div>
                  <span className="font-semibold text-cyan-800">Linked Owner&apos;s Checklist #{linkedChecklist.id}:</span>{' '}
                  <span className="font-mono font-bold">{linkedChecklist.reg_number}</span>
                  {linkedChecklist.vehicle_type ? ` (${linkedChecklist.vehicle_type})` : ''} ·{' '}
                  <span>{linkedChecklist.hirer_name}</span> ({linkedChecklist.hire_date})
                </div>
                <button
                  type="button"
                  onClick={() => setLinkedChecklist(null)}
                  className="inline-flex items-center gap-1 font-semibold text-red-700 hover:underline"
                >
                  <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Unlink</span>
                </button>
              </div>
              {linkedChecklistMatch && !linkedChecklistMatch.matched && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                  <span>{linkedChecklistMatch.reasons[0]}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Notes */}
        <div>
          <label htmlFor="sub-notes" className="block text-sm font-semibold text-blue-950">
            Notes (optional)
          </label>
          <textarea
            id="sub-notes"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Condition remarks, agreed subhire terms, spare wheel check..."
            className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3.5 text-base text-blue-950"
          />
        </div>

        <button
          type="submit"
          className="cyan-glow-btn w-full min-h-[52px] rounded-xl px-5 text-base font-semibold"
        >
          Review &amp; Save
        </button>
      </form>

      {showLinkModal && (
        <LinkChecklistModal
          hirerType="owner"
          vehicleId={vehicleEntryMode === 'existing' && selectedExistingVehicle ? selectedExistingVehicle.id : null}
          regNumber={effectiveSubhireReg}
          vehicleType={effectiveSubhireType}
          partyName={subhirerName}
          logDateYmd={toHarareYmd(new Date())}
          selectedChecklistId={linkedChecklist?.id ?? null}
          onSelect={handleSelectLinkedChecklist}
          onCreateNew={handleCreateNewLinkedChecklist}
          onClose={() => setShowLinkModal(false)}
        />
      )}
    </div>
  );
};
