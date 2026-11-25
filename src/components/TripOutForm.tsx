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
  Lock,
  Plus,
  Search,
  UserPlus,
  Zap,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { ONLINE_RECONNECTED_EVENT } from '../lib/offlineCache';
import {
  OFFLINE_SYNCED_EVENT,
  enqueueOfflineEntry,
  isLikelyNetworkError,
} from '../lib/offlineQueue';
import {
  DRIVER_LICENCE_CODES,
  VEHICLE_CONDITIONS,
  VEHICLE_TYPES,
  VEHICLE_TYPE_TO_CLASS,
  formatDriverMissingDocsWarning,
  getDriverMissingDocuments,
  type CreateTripOutPayload,
  type Driver,
  type FuelLevel,
  type NewDriverInput,
  type NewVehicleInput,
  type TripFlag,
  type TripSummary,
  type TripType,
  type UserPublic,
  type Vehicle,
  type VehicleCondition,
} from '../shared/types';
import { DocumentUploadField } from './DocumentUploadField';
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
  pendingVehicle: NewVehicleInput | null;
  pendingDriver: NewDriverInput | null;
  clientName: string;
  destination: string;
  reason: string;
  mileageOut: string;
  fuelOut: FuelLevel | '';
  daysHired: string;
  expectedReturnDate: string;
  checklistBy: string;
  notes: string;
}

function getHarareTodayDateStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysHarare(days: number): string {
  const todayStr = getHarareTodayDateStr();
  const dt = new Date(`${todayStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const ROADWORTHY_CONDITIONS = VEHICLE_CONDITIONS.filter(
  (c) => c !== 'Accident' && c !== 'Grounded'
);

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

  // Pending inline new driver / vehicle applied to this trip
  const [pendingDriver, setPendingDriver] = useState<NewDriverInput | null>(null);
  const [pendingVehicle, setPendingVehicle] = useState<NewVehicleInput | null>(null);

  // Inline creation sub-forms
  const [showNewDriverForm, setShowNewDriverForm] = useState(false);
  const [newDriverFullName, setNewDriverFullName] = useState('');
  const [newDriverLicence, setNewDriverLicence] = useState('');
  const [newDriverLicenceCode, setNewDriverLicenceCode] = useState('');
  const [newDriverPhone, setNewDriverPhone] = useState('');
  const [newDriverAddress, setNewDriverAddress] = useState('');
  const [newDriverExpiry, setNewDriverExpiry] = useState('');
  const [newDriverLicenceDoc, setNewDriverLicenceDoc] = useState<string | null>(null);
  const [newDriverDdcNumber, setNewDriverDdcNumber] = useState('');
  const [newDriverDdcDoc, setNewDriverDdcDoc] = useState<string | null>(null);
  const [newDriverRetestNumber, setNewDriverRetestNumber] = useState('');
  const [newDriverRetestDoc, setNewDriverRetestDoc] = useState<string | null>(null);
  const [newDriverMedicalNumber, setNewDriverMedicalNumber] = useState('');
  const [newDriverMedicalDoc, setNewDriverMedicalDoc] = useState<string | null>(null);
  const [newDriverSaveToDir, setNewDriverSaveToDir] = useState(true);
  const [newDriverErr, setNewDriverErr] = useState<string | null>(null);

  const [showNewVehicleForm, setShowNewVehicleForm] = useState(false);
  const [newVehicleReg, setNewVehicleReg] = useState('');
  const [newVehicleType, setNewVehicleType] = useState<string>('Sedan');
  const [newVehicleMakeModel, setNewVehicleMakeModel] = useState('');
  const [newVehicleCondition, setNewVehicleCondition] = useState<VehicleCondition>('Good');
  const [newVehicleMileage, setNewVehicleMileage] = useState('0');
  const [newVehicleSaveToDir, setNewVehicleSaveToDir] = useState(true);
  const [newVehicleErr, setNewVehicleErr] = useState<string | null>(null);

  const [clientName, setClientName] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [mileageOut, setMileageOut] = useState('');
  const [fuelOut, setFuelOut] = useState<FuelLevel | ''>('');
  const [daysHired, setDaysHired] = useState('');
  const [expectedReturnDate, setExpectedReturnDate] = useState('');
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
        if (d.pendingVehicle) setPendingVehicle(d.pendingVehicle);
        if (d.pendingDriver) setPendingDriver(d.pendingDriver);
        if (d.clientName) setClientName(d.clientName);
        if (d.destination) setDestination(d.destination);
        if (d.reason) setReason(d.reason);
        if (d.mileageOut) setMileageOut(d.mileageOut);
        if (d.fuelOut) setFuelOut(d.fuelOut);
        if (d.daysHired) setDaysHired(d.daysHired);
        if (d.expectedReturnDate) setExpectedReturnDate(d.expectedReturnDate);
        if (d.checklistBy !== undefined) setChecklistBy(d.checklistBy);
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
      pendingVehicle,
      pendingDriver,
      clientName,
      destination,
      reason,
      mileageOut,
      fuelOut,
      daysHired,
      expectedReturnDate,
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
    pendingVehicle,
    pendingDriver,
    clientName,
    destination,
    reason,
    mileageOut,
    fuelOut,
    daysHired,
    expectedReturnDate,
    checklistBy,
    notes,
  ]);

  useEffect(() => {
    let active = true;
    const loadLists = (showSpinner: boolean) => {
      if (showSpinner) setLoadingLists(true);
      Promise.all([
        api.listVehicles({ limit: 500 }),
        api.listDrivers({ limit: 500 }),
      ])
        .then(([vRes, dRes]) => {
          if (!active) return;
          const activeVehicles = vRes.items.filter((v) => v.active);
          const activeDrivers = dRes.items.filter((d) => d.active);
          setVehicles(activeVehicles);
          setDrivers(activeDrivers);
          try {
            localStorage.setItem(
              'fleet_secure_cache_bookable_vehicles',
              JSON.stringify(activeVehicles)
            );
            localStorage.setItem(
              'fleet_secure_cache_bookable_drivers',
              JSON.stringify(activeDrivers)
            );
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
              : 'Could not load vehicles and drivers from directory.'
          );
        })
        .finally(() => {
          if (active) setLoadingLists(false);
        });
    };

    loadLists(true);
    const onRefresh = () => loadLists(false);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, onRefresh);
    window.addEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
    return () => {
      active = false;
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, onRefresh);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
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
    const list = !q
      ? vehicles
      : vehicles.filter(
          (v) =>
            v.reg_number.toLowerCase().includes(q) ||
            v.make_model.toLowerCase().includes(q) ||
            v.vehicle_type.toLowerCase().includes(q)
        );
    const available = list.filter(
      (v) =>
        v.derived_status === 'Available' &&
        v.condition !== 'Accident' &&
        v.condition !== 'Grounded'
    );
    const unavailable = list.filter(
      (v) =>
        v.derived_status !== 'Available' ||
        v.condition === 'Accident' ||
        v.condition === 'Grounded'
    );
    return { available, unavailable };
  }, [vehicles, vehicleSearch]);

  const canSeeMissingDocWarnings = user.role === 'ADMIN' || user.role === 'SUPERVISOR';

  const filteredDrivers = useMemo(() => {
    const q = driverSearch.trim().toLowerCase();
    const list = !q
      ? drivers
      : drivers.filter(
          (d) =>
            d.full_name.toLowerCase().includes(q) ||
            (d.licence_number ?? '').toLowerCase().includes(q) ||
            (d.ddc_number ?? '').toLowerCase().includes(q) ||
            d.phone.toLowerCase().includes(q)
        );
    const available = list.filter((d) => d.derived_status === 'Available');
    const unavailable = list.filter((d) => d.derived_status !== 'Available');
    return { available, unavailable };
  }, [drivers, driverSearch]);

  const handleSelectVehicle = (nextId: string) => {
    setVehicleId(nextId);
    if (nextId) {
      setPendingVehicle(null);
      const v = vehicles.find((item) => String(item.id) === nextId);
      if (v) {
        setMileageOut(String(v.last_known_mileage));
      }
    }
  };

  const handleSelectDriver = (nextId: string) => {
    setDriverId(nextId);
    if (nextId) {
      setPendingDriver(null);
    }
  };

  const openNewDriverEditor = (prefill?: NewDriverInput | null) => {
    setNewDriverErr(null);
    if (prefill) {
      setNewDriverFullName(prefill.full_name);
      setNewDriverLicence(prefill.licence_number ?? '');
      setNewDriverLicenceCode(prefill.licence_code ?? '');
      setNewDriverPhone(prefill.phone);
      setNewDriverAddress(prefill.address ?? '');
      setNewDriverExpiry(prefill.licence_expiry ?? '');
      setNewDriverLicenceDoc(prefill.licence_document ?? null);
      setNewDriverDdcNumber(prefill.ddc_number ?? '');
      setNewDriverDdcDoc(prefill.ddc_document ?? null);
      setNewDriverRetestNumber(prefill.retest_cert_number ?? '');
      setNewDriverRetestDoc(prefill.retest_document ?? null);
      setNewDriverMedicalNumber(prefill.medical_cert_number ?? '');
      setNewDriverMedicalDoc(prefill.medical_document ?? null);
      setNewDriverSaveToDir(prefill.save_to_directory);
    } else {
      setNewDriverFullName('');
      setNewDriverLicence('');
      setNewDriverLicenceCode('');
      setNewDriverPhone('');
      setNewDriverAddress('');
      setNewDriverExpiry('');
      setNewDriverLicenceDoc(null);
      setNewDriverDdcNumber('');
      setNewDriverDdcDoc(null);
      setNewDriverRetestNumber('');
      setNewDriverRetestDoc(null);
      setNewDriverMedicalNumber('');
      setNewDriverMedicalDoc(null);
      setNewDriverSaveToDir(true);
    }
    setShowNewDriverForm(true);
  };

  const applyNewDriver = () => {
    setNewDriverErr(null);
    const fullName = newDriverFullName.trim();
    const licenceNumber = newDriverLicence.trim().toUpperCase() || null;
    const licenceCode = newDriverLicenceCode.trim() || null;
    const phone = newDriverPhone.trim();
    const address = newDriverAddress.trim();
    const licenceExpiry = newDriverExpiry.trim() || null;
    const ddcNumber = newDriverDdcNumber.trim().toUpperCase() || null;
    const retestCertNumber = newDriverRetestNumber.trim().toUpperCase() || null;
    const medicalCertNumber = newDriverMedicalNumber.trim().toUpperCase() || null;

    if (fullName.length < 2) {
      setNewDriverErr('Enter the driver’s full name (at least 2 characters).');
      return;
    }
    if (licenceNumber && licenceNumber.length < 2) {
      setNewDriverErr('Licence number must be at least 2 characters when provided.');
      return;
    }
    if (phone.length < 5) {
      setNewDriverErr('Enter a valid contact phone number.');
      return;
    }
    if (licenceExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(licenceExpiry)) {
      setNewDriverErr('Licence expiry date must be in YYYY-MM-DD format.');
      return;
    }
    if (licenceNumber) {
      const existing = drivers.find(
        (d) => d.licence_number && d.licence_number.toUpperCase() === licenceNumber
      );
      if (existing) {
        setNewDriverErr(
          `Licence "${licenceNumber}" already belongs to ${existing.full_name} in your directory. Select them from the driver list instead.`
        );
        return;
      }
    }

    setPendingDriver({
      full_name: fullName,
      licence_number: licenceNumber,
      licence_code: licenceCode,
      phone,
      address,
      licence_expiry: licenceExpiry,
      licence_document: newDriverLicenceDoc,
      ddc_number: ddcNumber,
      ddc_document: newDriverDdcDoc,
      retest_cert_number: retestCertNumber,
      retest_document: newDriverRetestDoc,
      medical_cert_number: medicalCertNumber,
      medical_document: newDriverMedicalDoc,
      save_to_directory: newDriverSaveToDir,
    });
    setDriverId('');
    setShowNewDriverForm(false);
    setError(null);
  };

  const openNewVehicleEditor = (prefill?: NewVehicleInput | null) => {
    setNewVehicleErr(null);
    if (prefill) {
      setNewVehicleReg(prefill.reg_number);
      setNewVehicleType(prefill.vehicle_type);
      setNewVehicleMakeModel(prefill.make_model);
      setNewVehicleCondition(prefill.condition ?? 'Good');
      setNewVehicleMileage(String(prefill.last_known_mileage));
      setNewVehicleSaveToDir(prefill.save_to_directory);
    } else {
      setNewVehicleReg('');
      setNewVehicleType('Sedan');
      setNewVehicleMakeModel('');
      setNewVehicleCondition('Good');
      setNewVehicleMileage(mileageOut || '0');
      setNewVehicleSaveToDir(true);
    }
    setShowNewVehicleForm(true);
  };

  const applyNewVehicle = () => {
    setNewVehicleErr(null);
    const regNumber = newVehicleReg.trim().toUpperCase().replace(/\s+/g, ' ');
    const makeModel = newVehicleMakeModel.trim();
    const mileage = Number(newVehicleMileage);

    if (regNumber.length < 3) {
      setNewVehicleErr('Enter the vehicle registration number (at least 3 characters).');
      return;
    }
    if (!VEHICLE_TYPE_TO_CLASS[newVehicleType]) {
      setNewVehicleErr('Choose a valid vehicle type.');
      return;
    }
    if (makeModel.length < 2) {
      setNewVehicleErr('Enter the vehicle make and model (e.g. Toyota Hilux).');
      return;
    }
    if (!Number.isInteger(mileage) || mileage < 0) {
      setNewVehicleErr('Starting odometer must be a whole number 0 or greater.');
      return;
    }
    const existing = vehicles.find(
      (v) => v.reg_number.toUpperCase() === regNumber
    );
    if (existing) {
      setNewVehicleErr(
        `Registration "${regNumber}" (${existing.make_model}) is already in your directory. Select it from the vehicle list instead.`
      );
      return;
    }

    setPendingVehicle({
      reg_number: regNumber,
      vehicle_type: newVehicleType,
      make_model: makeModel,
      condition: newVehicleCondition,
      last_known_mileage: mileage,
      save_to_directory: newVehicleSaveToDir,
    });
    setVehicleId('');
    setMileageOut(String(mileage));
    setShowNewVehicleForm(false);
    setError(null);
  };

  const effectiveDriverLabel = pendingDriver
    ? pendingDriver.full_name
    : selectedDriver?.full_name ?? '';
  const effectiveVehicleReg = pendingVehicle
    ? pendingVehicle.reg_number
    : selectedVehicle?.reg_number ?? '';
  const effectiveVehicleModel = pendingVehicle
    ? pendingVehicle.make_model
    : selectedVehicle?.make_model ?? '';
  const baselineMileage = pendingVehicle
    ? pendingVehicle.last_known_mileage
    : selectedVehicle?.last_known_mileage ?? null;

  const mileageDiff = useMemo(() => {
    if (baselineMileage === null || mileageOut === '') return 0;
    const m = Number(mileageOut);
    if (!Number.isFinite(m)) return 0;
    return m - baselineMileage;
  }, [baselineMileage, mileageOut]);

  const validateAndConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (showNewDriverForm) {
      setError('Finish applying the new driver details or tap Cancel before continuing.');
      return;
    }
    if (showNewVehicleForm) {
      setError('Finish applying the new vehicle details or tap Cancel before continuing.');
      return;
    }
    if (!selectedDriver && !pendingDriver) {
      setError('Select a driver from the directory or add a new driver.');
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
    if (!selectedVehicle && !pendingVehicle) {
      setError('Select a vehicle from the directory or add a new vehicle.');
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
    if (tripType === 'HIRE') {
      const parsedDays = Number(daysHired);
      if (!daysHired.trim() || !Number.isInteger(parsedDays) || parsedDays < 1) {
        setError('Enter the number of days hired (whole number, 1 or more).');
        return;
      }
      if (!expectedReturnDate || !/^\d{4}-\d{2}-\d{2}$/.test(expectedReturnDate)) {
        setError('Select the expected return date for this hire.');
        return;
      }
    }
    if (tripType === 'HIRE' && !checklistBy.trim()) {
      setError('Enter who completed the opening checklist.');
      return;
    }

    setConfirming(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDaysHiredChange = (val: string) => {
    setDaysHired(val);
    const parsed = Number(val);
    if (val.trim() !== '' && Number.isInteger(parsed) && parsed >= 1) {
      setExpectedReturnDate(addDaysHarare(parsed));
    }
  };

  const handleExpectedReturnDateChange = (val: string) => {
    setExpectedReturnDate(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const todayMs = new Date(`${getHarareTodayDateStr()}T00:00:00Z`).getTime();
      const targetMs = new Date(`${val}T00:00:00Z`).getTime();
      const diffDays = Math.round((targetMs - todayMs) / 86_400_000);
      if (diffDays >= 1) {
        setDaysHired(String(diffDays));
      } else if (diffDays === 0) {
        setDaysHired('1');
      }
    }
  };

  const handleFinalSave = async () => {
    if ((!selectedVehicle && !pendingVehicle) || (!selectedDriver && !pendingDriver) || !fuelOut) {
      return;
    }
    setSubmitting(true);
    setError(null);

    const deviceTime = new Date().toISOString();
    const payload: CreateTripOutPayload & { device_time: string } = {
      trip_type: tripType,
      ...(pendingVehicle ? { new_vehicle: pendingVehicle } : { vehicle_id: selectedVehicle!.id }),
      ...(pendingDriver ? { new_driver: pendingDriver } : { driver_id: selectedDriver!.id }),
      client_name: tripType === 'HIRE' ? clientName.trim() : undefined,
      destination: tripType === 'ERRAND' ? destination.trim() : undefined,
      reason: tripType === 'ERRAND' ? reason.trim() : undefined,
      days_hired: tripType === 'HIRE' ? Number(daysHired) : undefined,
      expected_return_date: tripType === 'HIRE' ? expectedReturnDate : undefined,
      mileage_out: Number(mileageOut),
      fuel_out: fuelOut,
      opening_checklist_by: checklistBy.trim(),
      notes: notes.trim(),
      device_time: deviceTime,
    };

    const summaryLabel = `${tripType === 'HIRE' ? 'Hire Out' : 'Errand Out'} · ${effectiveVehicleReg} (${effectiveDriverLabel})`;

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

  if (confirming && (selectedVehicle || pendingVehicle) && (selectedDriver || pendingDriver) && fuelOut) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-5 shadow-xs">
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div>
              <div className="font-semibold">Check carefully before saving</div>
              <div className="mt-0.5">
                You cannot edit or delete this record after saving. If a mistake happens later, only a Supervisor can add a correction note.
              </div>
            </div>
          </div>

          <h1 className="font-display text-2xl font-bold text-blue-950">Confirm {title}</h1>

          <dl className="divide-y divide-blue-100 text-base">
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Trip Type</dt>
              <dd className="font-semibold text-blue-950">
                {tripType === 'HIRE' ? 'Client Hire' : 'Staff Errand'}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Driver</dt>
              <dd className="font-semibold text-blue-950 text-right">
                <div>{effectiveDriverLabel}</div>
                {(pendingDriver?.licence_code || selectedDriver?.licence_code) && (
                  <div className="text-xs font-medium text-cyan-700">
                    {pendingDriver?.licence_code || selectedDriver?.licence_code}
                  </div>
                )}
                {pendingDriver && (
                  <span
                    className={`mt-1 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${
                      pendingDriver.save_to_directory
                        ? 'bg-cyan-100 text-cyan-900'
                        : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {pendingDriver.save_to_directory
                      ? 'New · Save to Drivers Directory'
                      : 'New · Use once for this trip only'}
                  </span>
                )}
              </dd>
            </div>
            {tripType === 'HIRE' ? (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Client Name</dt>
                <dd className="font-semibold text-blue-950 text-right">{clientName.trim()}</dd>
              </div>
            ) : (
              <>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Destination</dt>
                  <dd className="font-semibold text-blue-950 text-right">{destination.trim()}</dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Reason</dt>
                  <dd className="font-semibold text-blue-950 text-right">{reason.trim()}</dd>
                </div>
              </>
            )}
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Vehicle</dt>
              <dd className="font-semibold text-blue-950 text-right">
                <div>
                  {effectiveVehicleReg} · {effectiveVehicleModel}
                </div>
                {pendingVehicle && (
                  <span
                    className={`mt-1 inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${
                      pendingVehicle.save_to_directory
                        ? 'bg-cyan-100 text-cyan-900'
                        : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {pendingVehicle.save_to_directory
                      ? 'New · Save to Vehicles Directory'
                      : 'New · Use once for this trip only'}
                  </span>
                )}
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Mileage when leaving</dt>
              <dd className="font-mono tabular-nums font-bold text-blue-950">
                {Number(mileageOut).toLocaleString()} km
              </dd>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Fuel when leaving</dt>
              <dd className="font-mono font-bold text-cyan-700">{fuelOut}</dd>
            </div>
            {tripType === 'HIRE' && (
              <>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Number of days hired</dt>
                  <dd className="font-mono tabular-nums font-bold text-blue-950">
                    {daysHired} day{Number(daysHired) === 1 ? '' : 's'}
                  </dd>
                </div>
                <div className="py-3 flex justify-between gap-4">
                  <dt className="text-slate-500">Expected return date</dt>
                  <dd className="font-mono tabular-nums font-bold text-blue-950">
                    {expectedReturnDate}
                  </dd>
                </div>
              </>
            )}
            <div className="py-3 flex justify-between gap-4">
              <dt className="text-slate-500">Opening checklist by</dt>
              <dd className="font-semibold text-blue-950 text-right">
                {checklistBy.trim() || <span className="font-normal text-slate-500">Optional (not recorded)</span>}
              </dd>
            </div>
            {notes.trim() && (
              <div className="py-3 flex justify-between gap-4">
                <dt className="text-slate-500">Notes</dt>
                <dd className="text-slate-800 text-right">{notes.trim()}</dd>
              </div>
            )}
          </dl>

          {mileageDiff !== 0 && baselineMileage !== null && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <span className="font-semibold">Unrecorded Mileage Gap Notice:</span> The starting odometer for {effectiveVehicleReg} was{' '}
              <span className="font-mono">{baselineMileage.toLocaleString()} km</span>. Saving{' '}
              <span className="font-mono">{Number(mileageOut).toLocaleString()} km</span> will raise a high-priority gap flag ({mileageDiff > 0 ? `+${mileageDiff}` : mileageDiff} km).
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
              <span>{submitting ? 'Saving permanently...' : 'Confirm & Save Permanently'}</span>
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
            <li>Pick a driver from the Drivers Directory or tap <strong>+ New Driver</strong> (choose whether to save to directory or use once).</li>
            <li>Enter the {tripType === 'HIRE' ? 'client name' : 'destination and reason'}.</li>
            <li>Pick a vehicle from the Vehicles Directory or tap <strong>+ New Vehicle</strong> (choose whether to save to directory or use once).</li>
            <li>Read the exact odometer on the dashboard and enter <strong>Mileage when leaving</strong>.</li>
            <li>Look at the fuel needle and tap the matching level on the <strong>Fuel gauge</strong>.</li>
            <li>Enter who did the vehicle checklist{tripType === 'ERRAND' ? ' (optional for errands)' : ''}, tap <strong>Review &amp; Save</strong>, and confirm.</li>
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

        {loadingLists ? (
          <div className="py-6 text-base text-slate-500">
            Loading drivers and vehicles directories...
          </div>
        ) : (
          <>
            {/* Driver directory picker + inline "+ New Driver" */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="out-driver" className="block text-sm font-semibold text-blue-950">
                  Driver{' '}
                  <span className="font-normal text-xs text-slate-500">
                    ({filteredDrivers.available.length} available in directory)
                  </span>
                </label>
                {!showNewDriverForm && (
                  <button
                    type="button"
                    onClick={() => openNewDriverEditor(pendingDriver)}
                    className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-cyan-300 bg-cyan-50/70 px-3 py-1.5 text-xs font-semibold text-blue-900"
                  >
                    <UserPlus className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                    <span>{pendingDriver ? 'Edit New Driver' : '+ New Driver'}</span>
                  </button>
                )}
              </div>

              {showNewDriverForm ? (
                <div className="rounded-xl border border-cyan-300 bg-blue-50/40 p-4 space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-blue-950">
                      Add New Driver for This Trip
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowNewDriverForm(false)}
                      className="text-xs font-semibold text-slate-600 hover:text-blue-900"
                    >
                      Cancel
                    </button>
                  </div>

                  {newDriverErr && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
                    >
                      {newDriverErr}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Full Name *
                      </label>
                      <input
                        type="text"
                        value={newDriverFullName}
                        onChange={(e) => setNewDriverFullName(e.target.value)}
                        placeholder="e.g. Tatenda Moyo"
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Phone Number *
                      </label>
                      <input
                        type="tel"
                        value={newDriverPhone}
                        onChange={(e) => setNewDriverPhone(e.target.value)}
                        placeholder="+263 77..."
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Licence Number (optional)
                      </label>
                      <input
                        type="text"
                        value={newDriverLicence}
                        onChange={(e) => setNewDriverLicence(e.target.value.toUpperCase())}
                        placeholder="e.g. ZW-55412"
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Licence Expiry (optional)
                      </label>
                      <input
                        type="date"
                        value={newDriverExpiry}
                        onChange={(e) => setNewDriverExpiry(e.target.value)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-blue-950">
                        Driver&apos;s Licence Code/Class (optional)
                      </label>
                      <select
                        value={newDriverLicenceCode}
                        onChange={(e) => setNewDriverLicenceCode(e.target.value)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      >
                        <option value="">Not specified (optional)</option>
                        {DRIVER_LICENCE_CODES.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        DDC Number (optional)
                      </label>
                      <input
                        type="text"
                        value={newDriverDdcNumber}
                        onChange={(e) => setNewDriverDdcNumber(e.target.value.toUpperCase())}
                        placeholder="Defensive Driving Cert No."
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Retest Cert Number (optional)
                      </label>
                      <input
                        type="text"
                        value={newDriverRetestNumber}
                        onChange={(e) => setNewDriverRetestNumber(e.target.value.toUpperCase())}
                        placeholder="Retest Certificate No."
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Medical Cert Number (optional)
                      </label>
                      <input
                        type="text"
                        value={newDriverMedicalNumber}
                        onChange={(e) => setNewDriverMedicalNumber(e.target.value.toUpperCase())}
                        placeholder="Medical Certificate No."
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Address (optional)
                      </label>
                      <input
                        type="text"
                        value={newDriverAddress}
                        onChange={(e) => setNewDriverAddress(e.target.value)}
                        placeholder="Residential address or depot"
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <DocumentUploadField
                      label="Driving Licence Copy"
                      value={newDriverLicenceDoc}
                      onChange={setNewDriverLicenceDoc}
                    />
                    <DocumentUploadField
                      label="Defensive Driving Certificate (DDC)"
                      value={newDriverDdcDoc}
                      onChange={setNewDriverDdcDoc}
                    />
                    <DocumentUploadField
                      label="Retest Certificate Copy"
                      value={newDriverRetestDoc}
                      onChange={setNewDriverRetestDoc}
                    />
                    <DocumentUploadField
                      label="Medical Certificate Copy"
                      value={newDriverMedicalDoc}
                      onChange={setNewDriverMedicalDoc}
                    />
                  </div>

                  {/* Save to directory vs Use once prompt */}
                  <div className="space-y-1.5">
                    <span className="block text-xs font-semibold text-blue-950">
                      How should this driver be stored?
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => setNewDriverSaveToDir(true)}
                        className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                          newDriverSaveToDir
                            ? 'border-cyan-500 bg-cyan-50/90 ring-2 ring-cyan-400/40'
                            : 'border-blue-200 bg-white hover:border-cyan-300'
                        }`}
                      >
                        <BookmarkCheck
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            newDriverSaveToDir ? 'text-cyan-700' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="text-xs font-bold text-blue-950">
                            Save to Drivers Directory
                          </div>
                          <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                            Keep for future hires and errands.
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setNewDriverSaveToDir(false)}
                        className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                          !newDriverSaveToDir
                            ? 'border-amber-500 bg-amber-50/90 ring-2 ring-amber-400/40'
                            : 'border-blue-200 bg-white hover:border-cyan-300'
                        }`}
                      >
                        <Zap
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            !newDriverSaveToDir ? 'text-amber-700' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="text-xs font-bold text-blue-950">
                            Use for this trip only
                          </div>
                          <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                            One-time trip; won&apos;t stay in active directory.
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={applyNewDriver}
                      className="cyan-glow-btn min-h-[42px] rounded-xl px-4 text-sm font-semibold"
                    >
                      Apply Driver to Trip
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewDriverForm(false)}
                      className="cyan-glow-outline min-h-[42px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : pendingDriver ? (
                <div className="rounded-xl border border-cyan-300 bg-cyan-50/60 p-3.5 text-sm space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-bold text-blue-950">{pendingDriver.full_name}</span>
                      <span className="ml-2 font-mono text-xs text-slate-600">
                        {pendingDriver.licence_number ?? 'No licence recorded'}
                        {pendingDriver.licence_code ? ` · ${pendingDriver.licence_code}` : ''}
                      </span>
                    </div>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        pendingDriver.save_to_directory
                          ? 'bg-cyan-100 text-cyan-900'
                          : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {pendingDriver.save_to_directory
                        ? 'Save to Directory'
                        : 'Use Once · This Trip Only'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span>Phone: {pendingDriver.phone}</span>
                    <button
                      type="button"
                      onClick={() => setPendingDriver(null)}
                      className="font-semibold text-blue-700 hover:text-cyan-700 underline"
                    >
                      Pick from directory instead
                    </button>
                  </div>
                  {canSeeMissingDocWarnings &&
                    getDriverMissingDocuments(pendingDriver).length > 0 && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                        <AlertTriangle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700"
                          aria-hidden="true"
                        />
                        <span>
                          {formatDriverMissingDocsWarning(
                            pendingDriver.full_name,
                            getDriverMissingDocuments(pendingDriver)
                          )}
                        </span>
                      </div>
                    )}
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-600"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      value={driverSearch}
                      onChange={(e) => setDriverSearch(e.target.value)}
                      placeholder="Filter directory by driver name, licence, or phone..."
                      className="cyan-glow-input block w-full min-h-[44px] rounded-xl border border-blue-200 pl-10 pr-3 text-sm text-blue-950 placeholder:text-slate-400"
                    />
                  </div>
                  <select
                    id="out-driver"
                    value={driverId}
                    onChange={(e) => handleSelectDriver(e.target.value)}
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    <option value="">
                      Select driver from directory ({filteredDrivers.available.length} available)
                    </option>
                    {filteredDrivers.available.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.full_name} ({d.licence_number ?? 'No licence'}) · {d.phone}
                      </option>
                    ))}
                    {filteredDrivers.unavailable.length > 0 && (
                      <optgroup label="Currently Out on Trip (Unavailable)">
                        {filteredDrivers.unavailable.map((d) => (
                          <option key={d.id} value={d.id} disabled>
                            {d.full_name} ({d.licence_number ?? 'No licence'}) — {d.derived_status}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                  {selectedDriver && (
                    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 text-xs sm:text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        <strong className="text-blue-950">{selectedDriver.full_name}</strong>
                      </span>
                      <span className="font-mono text-slate-600">
                        Licence: {selectedDriver.licence_number ?? 'Not recorded'}
                        {selectedDriver.licence_code ? ` · ${selectedDriver.licence_code}` : ''}
                      </span>
                      <span>Phone: {selectedDriver.phone}</span>
                    </div>
                  )}
                  {selectedDriver &&
                    (selectedDriver.licence_status === 'EXPIRING_SOON' ||
                      selectedDriver.licence_status === 'EXPIRED') && (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                          aria-hidden="true"
                        />
                        <span>
                          {selectedDriver.licence_status === 'EXPIRED'
                            ? `Warning: ${selectedDriver.full_name}'s driving licence expired on ${selectedDriver.licence_expiry}.`
                            : `Notice: ${selectedDriver.full_name}'s licence expires in ${selectedDriver.days_to_expiry} days (${selectedDriver.licence_expiry}).`}
                        </span>
                      </div>
                    )}
                  {canSeeMissingDocWarnings &&
                    selectedDriver &&
                    (selectedDriver.missing_documents ?? getDriverMissingDocuments(selectedDriver)).length >
                      0 && (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs sm:text-sm text-amber-900">
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                          aria-hidden="true"
                        />
                        <span>
                          {formatDriverMissingDocsWarning(
                            selectedDriver.full_name,
                            selectedDriver.missing_documents ??
                              getDriverMissingDocuments(selectedDriver)
                          )}
                        </span>
                      </div>
                    )}
                </>
              )}
            </div>

            {/* Client or Destination + Reason */}
            {tripType === 'HIRE' ? (
              <div>
                <label htmlFor="out-client" className="block text-sm font-semibold text-blue-950">
                  Client Name
                </label>
                <input
                  id="out-client"
                  type="text"
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Full name of client or company hiring"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label htmlFor="out-dest" className="block text-sm font-semibold text-blue-950">
                    Destination
                  </label>
                  <input
                    id="out-dest"
                    type="text"
                    required
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder="Where is the vehicle going?"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="out-reason" className="block text-sm font-semibold text-blue-950">
                    Reason for Errand
                  </label>
                  <input
                    id="out-reason"
                    type="text"
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Spare parts collection, service drop-off"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>
              </div>
            )}

            {/* Vehicle directory picker + inline "+ New Vehicle" */}
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="out-vehicle" className="block text-sm font-semibold text-blue-950">
                  Vehicle{' '}
                  <span className="font-normal text-xs text-slate-500">
                    ({filteredVehicles.available.length} available in directory)
                  </span>
                </label>
                {!showNewVehicleForm && (
                  <button
                    type="button"
                    onClick={() => openNewVehicleEditor(pendingVehicle)}
                    className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-cyan-300 bg-cyan-50/70 px-3 py-1.5 text-xs font-semibold text-blue-900"
                  >
                    <Plus className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                    <Car className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                    <span>{pendingVehicle ? 'Edit New Vehicle' : '+ New Vehicle'}</span>
                  </button>
                )}
              </div>

              {showNewVehicleForm ? (
                <div className="rounded-xl border border-cyan-300 bg-blue-50/40 p-4 space-y-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-blue-950">
                      Add New Vehicle for This Trip
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowNewVehicleForm(false)}
                      className="text-xs font-semibold text-slate-600 hover:text-blue-900"
                    >
                      Cancel
                    </button>
                  </div>

                  {newVehicleErr && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800"
                    >
                      {newVehicleErr}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Registration Number *
                      </label>
                      <input
                        type="text"
                        value={newVehicleReg}
                        onChange={(e) => setNewVehicleReg(e.target.value.toUpperCase())}
                        placeholder="e.g. AFX 4401"
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Vehicle Type *{' '}
                        <span className="font-mono text-[11px] text-cyan-700">
                          ({VEHICLE_TYPE_TO_CLASS[newVehicleType] || 'ECONOMY'})
                        </span>
                      </label>
                      <select
                        value={newVehicleType}
                        onChange={(e) => setNewVehicleType(e.target.value)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      >
                        {VEHICLE_TYPES.map((vt) => (
                          <option key={vt} value={vt}>
                            {vt} ({VEHICLE_TYPE_TO_CLASS[vt]})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Make &amp; Model *
                      </label>
                      <input
                        type="text"
                        value={newVehicleMakeModel}
                        onChange={(e) => setNewVehicleMakeModel(e.target.value)}
                        placeholder="e.g. Toyota Hilux"
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-blue-950">
                        Condition
                      </label>
                      <select
                        value={newVehicleCondition}
                        onChange={(e) => setNewVehicleCondition(e.target.value as VehicleCondition)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      >
                        {ROADWORTHY_CONDITIONS.map((cond) => (
                          <option key={cond} value={cond}>
                            {cond}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-semibold text-blue-950">
                        Starting Odometer (km) *
                      </label>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step="1"
                        value={newVehicleMileage}
                        onChange={(e) => setNewVehicleMileage(e.target.value)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-lg border border-blue-200 bg-white px-3 font-mono text-sm text-blue-950"
                      />
                    </div>
                  </div>

                  {/* Save to directory vs Use once prompt */}
                  <div className="space-y-1.5">
                    <span className="block text-xs font-semibold text-blue-950">
                      How should this vehicle be stored?
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => setNewVehicleSaveToDir(true)}
                        className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                          newVehicleSaveToDir
                            ? 'border-cyan-500 bg-cyan-50/90 ring-2 ring-cyan-400/40'
                            : 'border-blue-200 bg-white hover:border-cyan-300'
                        }`}
                      >
                        <BookmarkCheck
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            newVehicleSaveToDir ? 'text-cyan-700' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="text-xs font-bold text-blue-950">
                            Save to Vehicles Directory
                          </div>
                          <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                            Keep in fleet directory for future trips.
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setNewVehicleSaveToDir(false)}
                        className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all ${
                          !newVehicleSaveToDir
                            ? 'border-amber-500 bg-amber-50/90 ring-2 ring-amber-400/40'
                            : 'border-blue-200 bg-white hover:border-cyan-300'
                        }`}
                      >
                        <Zap
                          className={`mt-0.5 h-4 w-4 shrink-0 ${
                            !newVehicleSaveToDir ? 'text-amber-700' : 'text-slate-400'
                          }`}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="text-xs font-bold text-blue-950">
                            Use for this trip only
                          </div>
                          <div className="text-[11px] text-slate-600 leading-snug mt-0.5">
                            One-time trip; won&apos;t stay in active directory.
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={applyNewVehicle}
                      className="cyan-glow-btn min-h-[42px] rounded-xl px-4 text-sm font-semibold"
                    >
                      Apply Vehicle to Trip
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewVehicleForm(false)}
                      className="cyan-glow-outline min-h-[42px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : pendingVehicle ? (
                <div className="rounded-xl border border-cyan-300 bg-cyan-50/60 p-3.5 text-sm space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-mono font-bold text-blue-950">
                        {pendingVehicle.reg_number}
                      </span>
                      <span className="ml-2 font-semibold text-slate-800">
                        {pendingVehicle.make_model}
                      </span>
                      <span className="ml-2 text-xs text-slate-600">
                        ({pendingVehicle.vehicle_type} · {VEHICLE_TYPE_TO_CLASS[pendingVehicle.vehicle_type]})
                      </span>
                    </div>
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                        pendingVehicle.save_to_directory
                          ? 'bg-cyan-100 text-cyan-900'
                          : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {pendingVehicle.save_to_directory
                        ? 'Save to Directory'
                        : 'Use Once · This Trip Only'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span>
                      Starting odometer:{' '}
                      <strong className="font-mono">
                        {pendingVehicle.last_known_mileage.toLocaleString()} km
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => setPendingVehicle(null)}
                      className="font-semibold text-blue-700 hover:text-cyan-700 underline"
                    >
                      Pick from directory instead
                    </button>
                  </div>
                </div>
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
                      className="cyan-glow-input block w-full min-h-[44px] rounded-xl border border-blue-200 pl-10 pr-3 text-sm text-blue-950 placeholder:text-slate-400"
                    />
                  </div>
                  <select
                    id="out-vehicle"
                    value={vehicleId}
                    onChange={(e) => handleSelectVehicle(e.target.value)}
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                  >
                    <option value="">
                      Select vehicle from directory ({filteredVehicles.available.length} available)
                    </option>
                    {filteredVehicles.available.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.reg_number} — {v.make_model} ({v.vehicle_type})
                      </option>
                    ))}
                    {filteredVehicles.unavailable.length > 0 && (
                      <optgroup label="Currently Out or Non-Roadworthy (Unavailable)">
                        {filteredVehicles.unavailable.map((v) => (
                          <option key={v.id} value={v.id} disabled>
                            {v.reg_number} — {v.make_model} (
                            {v.derived_status !== 'Available' ? v.derived_status : v.condition})
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {selectedVehicle && (
                    <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-3.5 text-sm text-slate-700 flex flex-wrap gap-x-4 gap-y-1">
                      <span>
                        <strong className="text-blue-950">{selectedVehicle.reg_number}</strong> ·{' '}
                        {selectedVehicle.make_model}
                      </span>
                      <span>
                        {selectedVehicle.vehicle_type} ({selectedVehicle.vehicle_class})
                      </span>
                      <span className="font-mono tabular-nums text-cyan-800 font-medium">
                        Last odometer: {selectedVehicle.last_known_mileage.toLocaleString()} km
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Mileage when leaving */}
            <div>
              <label htmlFor="out-mileage" className="block text-sm font-semibold text-blue-950">
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
                className="cyan-glow-input mt-1.5 block w-full min-h-[52px] rounded-xl border border-blue-200 px-4 font-mono tabular-nums text-lg font-semibold text-blue-950"
              />
              {baselineMileage !== null && mileageDiff !== 0 && (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                  <span>
                    Last recorded mileage was{' '}
                    <strong className="font-mono">
                      {baselineMileage.toLocaleString()} km
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

            {/* Hire duration & expected return date (just after Fuel Out) */}
            {tripType === 'HIRE' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="out-days-hired" className="block text-sm font-semibold text-blue-950">
                    Number of days hired
                  </label>
                  <input
                    id="out-days-hired"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step="1"
                    required
                    value={daysHired}
                    onChange={(e) => handleDaysHiredChange(e.target.value)}
                    placeholder="e.g. 3"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="out-expected-return" className="block text-sm font-semibold text-blue-950">
                    Expected return date
                  </label>
                  <input
                    id="out-expected-return"
                    type="date"
                    required
                    value={expectedReturnDate}
                    onChange={(e) => handleExpectedReturnDateChange(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono text-base text-blue-950"
                  />
                </div>
              </div>
            )}

            {/* Checklist by */}
            <div>
              <label htmlFor="out-checklist" className="block text-sm font-semibold text-blue-950">
                {tripType === 'ERRAND'
                  ? 'Opening checklist done by (optional)'
                  : 'Opening checklist done by'}
              </label>
              <input
                id="out-checklist"
                type="text"
                required={tripType === 'HIRE'}
                value={checklistBy}
                onChange={(e) => setChecklistBy(e.target.value)}
                placeholder={tripType === 'ERRAND' ? 'Optional for errands' : 'Name of person checking'}
                className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
              />
            </div>

            {/* Notes */}
            <div>
              <label htmlFor="out-notes" className="block text-sm font-semibold text-blue-950">
                Notes (optional)
              </label>
              <textarea
                id="out-notes"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any scratches, spare wheel check, or extra remarks..."
                className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3.5 text-base text-blue-950"
              />
            </div>

            <button
              type="submit"
              className="cyan-glow-btn w-full min-h-[52px] rounded-xl px-5 text-base font-semibold"
            >
              Review & Save
            </button>
          </>
        )}
      </form>
    </div>
  );
};
