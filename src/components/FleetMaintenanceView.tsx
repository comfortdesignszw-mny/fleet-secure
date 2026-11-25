import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Car,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Eye,
  FileText,
  Gauge,
  Package,
  Plus,
  ShieldCheck,
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
} from '../lib/offlineCache';
import { OFFLINE_SYNCED_EVENT, isLikelyNetworkError } from '../lib/offlineQueue';
import {
  VEHICLE_CONDITIONS,
  VEHICLE_TYPES,
  VEHICLE_TYPE_TO_CLASS,
  formatHarareTime,
  type FleetMaintenanceOverview,
  type GarageVisit,
  type GarageVisitStatus,
  type MaintenanceRecordType,
  type NextServiceStatus,
  type PartsPurchaseRequest,
  type Role,
  type Vehicle,
  type VehicleCondition,
  type VehicleServiceDueSummary,
} from '../shared/types';
import { DocumentUploadField, isPdfDataUrl } from './DocumentUploadField';

interface FleetMaintenanceViewProps {
  userRole: Role;
  onOpenVehicle?: (vehicleId: number) => void;
}

type MaintenanceTab = 'service-dues' | 'history' | 'garage' | 'parts';

function getHarareTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function ServiceDueBadge({ status }: { status: NextServiceStatus }) {
  if (status === 'OVERDUE') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-bold text-red-800">
        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Overdue</span>
      </span>
    );
  }
  if (status === 'DUE_SOON') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Due Soon</span>
      </span>
    );
  }
  if (status === 'OK') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>On Track</span>
      </span>
    );
  }
  return <span className="text-xs text-slate-400">Not set</span>;
}

function ApprovalStatusBadge({ status }: { status: string }) {
  if (status === 'APPROVED' || status === 'PURCHASED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{status === 'PURCHASED' ? 'Purchased' : 'Admin Approved'}</span>
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">
        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Rejected</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Waiting for Admin Authorization</span>
    </span>
  );
}

export const FleetMaintenanceView: React.FC<FleetMaintenanceViewProps> = ({
  userRole,
  onOpenVehicle,
}) => {
  const canMaintain = userRole === 'FLEET_MANAGER' || userRole === 'ADMIN';
  const isAdmin = userRole === 'ADMIN';

  const [activeTab, setActiveTab] = useState<MaintenanceTab>('service-dues');
  const [overview, setOverview] = useState<FleetMaintenanceOverview | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleFilter, setVehicleFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [usingCache, setUsingCache] = useState(false);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Inline Edit Next Service Due Modal
  const [editingDueVehicle, setEditingDueVehicle] = useState<VehicleServiceDueSummary | null>(null);
  const [dueKmInput, setDueKmInput] = useState('');
  const [savingDue, setSavingDue] = useState(false);

  // Mechanical / Service History Modal
  const [showLogModal, setShowLogModal] = useState(false);
  const [logVehicleId, setLogVehicleId] = useState('');
  const [logType, setLogType] = useState<MaintenanceRecordType>('SERVICE');
  const [logDate, setLogDate] = useState(getHarareTodayIso);
  const [logOdometer, setLogOdometer] = useState('');
  const [logSummary, setLogSummary] = useState('');
  const [logDetails, setLogDetails] = useState('');
  const [logWorkshop, setLogWorkshop] = useState('');
  const [logCost, setLogCost] = useState('');
  const [logNextDue, setLogNextDue] = useState('');
  const [savingLog, setSavingLog] = useState(false);

  // Garage Visit Modal
  const [showGarageModal, setShowGarageModal] = useState(false);
  const [garageVehicleId, setGarageVehicleId] = useState('');
  const [garageDate, setGarageDate] = useState(getHarareTodayIso);
  const [garageWorkshop, setGarageWorkshop] = useState('');
  const [garageReason, setGarageReason] = useState('');
  const [garageOdometer, setGarageOdometer] = useState('');
  const [garageEstCost, setGarageEstCost] = useState('');
  const [garageNotes, setGarageNotes] = useState('');
  const [savingGarage, setSavingGarage] = useState(false);

  // Garage Visit Update Status Modal
  const [updatingVisit, setUpdatingVisit] = useState<GarageVisit | null>(null);
  const [visitStatusInput, setVisitStatusInput] = useState<GarageVisitStatus>('IN_GARAGE');
  const [visitActualCost, setVisitActualCost] = useState('');
  const [visitNotesInput, setVisitNotesInput] = useState('');
  const [savingVisitStatus, setSavingVisitStatus] = useState(false);

  // Parts & Service Kits Purchase Request Form Modal
  const [showPartsModal, setShowPartsModal] = useState(false);
  const [partsRequestDate, setPartsRequestDate] = useState(getHarareTodayIso);
  const [partsVehicleMode, setPartsVehicleMode] = useState<'existing' | 'new'>('existing');
  const [partsVehicleId, setPartsVehicleId] = useState('');
  const [newVehReg, setNewVehReg] = useState('');
  const [newVehType, setNewVehType] = useState<string>(VEHICLE_TYPES[0]);
  const [newVehMakeModel, setNewVehMakeModel] = useState('');
  const [newVehCondition, setNewVehCondition] = useState<VehicleCondition>('Needs Little Attention');
  const [newVehMileage, setNewVehMileage] = useState('0');
  const [partsIsFullKit, setPartsIsFullKit] = useState(false);
  const [partsRequiredText, setPartsRequiredText] = useState('');
  const [partsDateRequired, setPartsDateRequired] = useState(getHarareTodayIso);
  const [partsEstAmount, setPartsEstAmount] = useState('');
  const [partsQuotationFile, setPartsQuotationFile] = useState<string | null>(null);
  const [partsQuotationFilename, setPartsQuotationFilename] = useState('');
  const [savingParts, setSavingParts] = useState(false);

  // Admin Decision Modal (shared for Garage Visit & Parts Requests)
  const [decisionTarget, setDecisionTarget] = useState<
    | { kind: 'garage'; visit: GarageVisit; decision: 'APPROVED' | 'REJECTED' }
    | { kind: 'parts'; req: PartsPurchaseRequest; decision: 'APPROVED' | 'REJECTED' }
    | null
  >(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [savingDecision, setSavingDecision] = useState(false);

  // Quotation Preview Modal
  const [quotationPreview, setQuotationPreview] = useState<{
    title: string;
    file: string;
    filename: string;
  } | null>(null);
  const [loadingQuotationId, setLoadingQuotationId] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    const vFilterNum = vehicleFilter ? Number(vehicleFilter) : undefined;
    try {
      const [maintRes, vehRes] = await Promise.all([
        api.getFleetMaintenanceOverview(vFilterNum),
        api.listVehicles({ includeInactive: true, limit: 500 }),
      ]);
      setOverview(maintRes);
      setVehicles(vehRes.items);
      if (!vFilterNum) {
        writeCachedEntry<FleetMaintenanceOverview>(CACHE_KEYS.fleetMaintenance, maintRes);
      }
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cachedMaint = readCachedEntry<FleetMaintenanceOverview>(CACHE_KEYS.fleetMaintenance);
        const cachedVeh = readCachedEntry<{ items: Vehicle[] }>(CACHE_KEYS.vehiclesAll);
        if (cachedMaint) {
          setOverview(cachedMaint.data);
          if (cachedVeh?.data.items) setVehicles(cachedVeh.data.items);
          setUsingCache(true);
          setCacheUpdatedAt(cachedMaint.updatedAt);
        } else {
          setError('Offline mode — no cached fleet maintenance records saved yet.');
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load fleet maintenance data.');
      }
    } finally {
      setLoading(false);
    }
  }, [vehicleFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const refresh = () => void loadData();
    window.addEventListener(OFFLINE_SYNCED_EVENT, refresh);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, refresh);
    return () => {
      window.removeEventListener(OFFLINE_SYNCED_EVENT, refresh);
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, refresh);
    };
  }, [loadData]);

  const activeVehicles = useMemo(() => vehicles.filter((v) => v.active), [vehicles]);

  const handleOpenDueEdit = (row: VehicleServiceDueSummary) => {
    setEditingDueVehicle(row);
    setDueKmInput(row.next_service_due_km !== null ? String(row.next_service_due_km) : '');
    setError(null);
  };

  const handleSaveNextDue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDueVehicle) return;
    setSavingDue(true);
    setError(null);
    try {
      const parsed = dueKmInput.trim() === '' ? null : Number(dueKmInput);
      await api.updateVehicleNextService(editingDueVehicle.vehicle_id, parsed);
      setNotice(
        parsed !== null
          ? `Next service due for ${editingDueVehicle.reg_number} updated to ${parsed.toLocaleString()} km.`
          : `Cleared next service due mileage for ${editingDueVehicle.reg_number}.`
      );
      setEditingDueVehicle(null);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update next service due km.');
    } finally {
      setSavingDue(false);
    }
  };

  const openCreateLogModal = () => {
    const firstVeh = activeVehicles[0];
    setLogVehicleId(firstVeh ? String(firstVeh.id) : '');
    setLogType('SERVICE');
    setLogDate(getHarareTodayIso());
    setLogOdometer(firstVeh ? String(firstVeh.last_known_mileage) : '0');
    setLogSummary('');
    setLogDetails('');
    setLogWorkshop('');
    setLogCost('');
    setLogNextDue('');
    setError(null);
    setShowLogModal(true);
  };

  const handleCreateLog = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingLog(true);
    setError(null);
    try {
      const res = await api.createMaintenanceLog({
        vehicle_id: Number(logVehicleId),
        record_type: logType,
        service_date: logDate,
        odometer_km: Number(logOdometer),
        summary: logSummary.trim(),
        details: logDetails.trim(),
        workshop_name: logWorkshop.trim(),
        cost: logCost.trim() === '' ? null : Number(logCost),
        next_service_due_km: logNextDue.trim() === '' ? null : Number(logNextDue),
      });
      setShowLogModal(false);
      setNotice(
        `Saved ${res.log.record_type.toLowerCase()} record for ${res.log.reg_number} (${res.log.summary}).`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save maintenance history entry.');
    } finally {
      setSavingLog(false);
    }
  };

  const openCreateGarageModal = () => {
    const firstVeh = activeVehicles[0];
    setGarageVehicleId(firstVeh ? String(firstVeh.id) : '');
    setGarageDate(getHarareTodayIso());
    setGarageWorkshop('');
    setGarageReason('');
    setGarageOdometer(firstVeh ? String(firstVeh.last_known_mileage) : '0');
    setGarageEstCost('');
    setGarageNotes('');
    setError(null);
    setShowGarageModal(true);
  };

  const handleCreateGarageVisit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingGarage(true);
    setError(null);
    try {
      const res = await api.createGarageVisit({
        vehicle_id: Number(garageVehicleId),
        visit_date: garageDate,
        workshop_name: garageWorkshop.trim(),
        reason: garageReason.trim(),
        odometer_km: Number(garageOdometer),
        estimated_cost: garageEstCost.trim() === '' ? null : Number(garageEstCost),
        notes: garageNotes.trim(),
      });
      setShowGarageModal(false);
      setNotice(
        `Garage visit submitted for ${res.visit.reg_number} at ${res.visit.workshop_name}. Waiting for Admin approval.`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit garage visit.');
    } finally {
      setSavingGarage(false);
    }
  };

  const handleUpdateVisitStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!updatingVisit) return;
    setSavingVisitStatus(true);
    setError(null);
    try {
      const res = await api.updateGarageVisitStatus(updatingVisit.id, {
        visit_status: visitStatusInput,
        actual_cost: visitActualCost.trim() === '' ? null : Number(visitActualCost),
        notes: visitNotesInput.trim(),
      });
      setUpdatingVisit(null);
      setNotice(`Updated garage visit for ${res.visit.reg_number} to ${res.visit.visit_status}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update garage visit status.');
    } finally {
      setSavingVisitStatus(false);
    }
  };

  const openPartsRequestModal = () => {
    const firstVeh = activeVehicles[0];
    setPartsRequestDate(getHarareTodayIso());
    setPartsVehicleMode(firstVeh ? 'existing' : 'new');
    setPartsVehicleId(firstVeh ? String(firstVeh.id) : '');
    setNewVehReg('');
    setNewVehType(VEHICLE_TYPES[0]);
    setNewVehMakeModel('');
    setNewVehCondition('Needs Little Attention');
    setNewVehMileage('0');
    setPartsIsFullKit(false);
    setPartsRequiredText('');
    setPartsDateRequired(getHarareTodayIso());
    setPartsEstAmount('');
    setPartsQuotationFile(null);
    setPartsQuotationFilename('');
    setError(null);
    setShowPartsModal(true);
  };

  const handleSubmitPartsRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingParts(true);
    setError(null);
    try {
      const payload =
        partsVehicleMode === 'new'
          ? {
              request_date: partsRequestDate,
              new_vehicle: {
                reg_number: newVehReg.trim(),
                vehicle_type: newVehType,
                make_model: newVehMakeModel.trim(),
                condition: newVehCondition,
                last_known_mileage: Number(newVehMileage),
              },
              parts_required: partsRequiredText.trim(),
              is_full_service_kit: partsIsFullKit,
              date_required: partsDateRequired,
              estimated_amount: Number(partsEstAmount),
              quotation_file: partsQuotationFile,
              quotation_filename: partsQuotationFilename.trim() || null,
            }
          : {
              request_date: partsRequestDate,
              vehicle_id: Number(partsVehicleId),
              parts_required: partsRequiredText.trim(),
              is_full_service_kit: partsIsFullKit,
              date_required: partsDateRequired,
              estimated_amount: Number(partsEstAmount),
              quotation_file: partsQuotationFile,
              quotation_filename: partsQuotationFilename.trim() || null,
            };

      const res = await api.createPartsRequest(payload);
      setShowPartsModal(false);
      setNotice(
        `Submitted parts purchase request for ${res.request.reg_number} ($${res.request.estimated_amount.toFixed(2)}). Waiting for Admin Authorization.`
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not submit parts & service kit request.'
      );
    } finally {
      setSavingParts(false);
    }
  };

  const handleSubmitDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decisionTarget) return;
    setSavingDecision(true);
    setError(null);
    try {
      if (decisionTarget.kind === 'garage') {
        const res = await api.decideGarageVisit(decisionTarget.visit.id, {
          decision: decisionTarget.decision,
          approval_notes: decisionNotes.trim(),
        });
        setNotice(
          `Garage visit for ${res.visit.reg_number} marked ${res.visit.approval_status}.`
        );
      } else {
        const res = await api.decidePartsRequest(decisionTarget.req.id, {
          decision: decisionTarget.decision,
          admin_notes: decisionNotes.trim(),
        });
        setNotice(
          `Parts request for ${res.request.reg_number} ${res.request.status.toLowerCase()}.`
        );
      }
      setDecisionTarget(null);
      setDecisionNotes('');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record Admin decision.');
    } finally {
      setSavingDecision(false);
    }
  };

  const handleMarkPurchased = async (req: PartsPurchaseRequest) => {
    setError(null);
    try {
      const res = await api.markPartsRequestPurchased(req.id);
      setNotice(`Marked parts request for ${res.request.reg_number} as Purchased.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark request as Purchased.');
    }
  };

  const handleViewQuotation = async (req: PartsPurchaseRequest) => {
    setLoadingQuotationId(req.id);
    setError(null);
    try {
      const res = await api.getPartsRequestQuotation(req.id);
      setQuotationPreview({
        title: `Quotation · ${req.reg_number} (${req.parts_required})`,
        file: res.quotation_file,
        filename: res.quotation_filename,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load quotation file.');
    } finally {
      setLoadingQuotationId(null);
    }
  };

  const summary = overview?.summary ?? {
    totalLogs: 0,
    pendingGarageApprovals: 0,
    inGarageCount: 0,
    pendingPartsAuthorizations: 0,
    serviceDueSoonOrOverdueCount: 0,
    groundedVehiclesCount: 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">
            Fleet Maintenance Dashboard
          </h1>
          <p className="mt-1 text-base text-slate-600">
            Vehicle mechanical &amp; service history, garage visits, parts &amp; service kit requests, and next service dues in km.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canMaintain && (
            <>
              <button
                type="button"
                onClick={openCreateLogModal}
                className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
              >
                <Wrench className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                <span>Log Service / Repair</span>
              </button>
              <button
                type="button"
                onClick={openCreateGarageModal}
                className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
              >
                <Car className="h-4 w-4 text-blue-600" aria-hidden="true" />
                <span>Garage Visit</span>
              </button>
              <button
                type="button"
                onClick={openPartsRequestModal}
                className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-4 text-sm font-semibold"
              >
                <Package className="h-4 w-4" aria-hidden="true" />
                <span>Request Parts / Service Kit</span>
              </button>
            </>
          )}
        </div>
      </div>

      {!canMaintain && (
        <div
          role="note"
          className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50/75 p-4 text-sm text-blue-950"
        >
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" aria-hidden="true" />
          <div>
            <span className="font-semibold">Read-Only Maintenance View:</span> Mechanical history, garage visits, parts requests, and service due mileages are maintained by the Fleet Manager / Supervisor and authorized by the Administrator.
          </div>
        </div>
      )}

      {usingCache && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900"
        >
          Offline mode — showing cached fleet maintenance snapshot
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

      {/* KPI Summary Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Service Due / Overdue</div>
          <div
            className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
              summary.serviceDueSoonOrOverdueCount > 0 ? 'text-amber-700' : 'text-blue-950'
            }`}
          >
            {summary.serviceDueSoonOrOverdueCount}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Grounded Vehicles</div>
          <div
            className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
              summary.groundedVehiclesCount > 0 ? 'text-red-700' : 'text-blue-950'
            }`}
          >
            {summary.groundedVehiclesCount}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Garage Pending Admin</div>
          <div
            className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
              summary.pendingGarageApprovals > 0 ? 'text-amber-700' : 'text-blue-950'
            }`}
          >
            {summary.pendingGarageApprovals}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Vehicles in Garage</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-cyan-700">
            {summary.inGarageCount}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Parts Pending Admin</div>
          <div
            className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
              summary.pendingPartsAuthorizations > 0 ? 'text-amber-700' : 'text-blue-950'
            }`}
          >
            {summary.pendingPartsAuthorizations}
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs">
          <div className="text-xs font-medium text-slate-500">Logged Services</div>
          <div className="mt-1 font-mono text-2xl font-bold tabular-nums text-blue-950">
            {summary.totalLogs}
          </div>
        </div>
      </div>

      {/* Filter & Sub-tab Controls */}
      <div className="flex flex-col gap-3 rounded-2xl border border-blue-200/80 bg-white p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: 'service-dues', label: 'Next Service Dues (km)', icon: Gauge },
              { id: 'history', label: 'Mechanical & Service History', icon: Wrench },
              { id: 'garage', label: 'Garage Visits', icon: Car },
              { id: 'parts', label: 'Parts & Service Kits', icon: Package },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex min-h-[42px] items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition-all ${
                  active
                    ? 'cyan-glow-active'
                    : 'cyan-glow-outline border-blue-200 bg-white text-blue-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="maint-veh-filter" className="text-xs font-semibold text-slate-500">
            Vehicle:
          </label>
          <select
            id="maint-veh-filter"
            value={vehicleFilter}
            onChange={(e) => setVehicleFilter(e.target.value)}
            className="cyan-glow-input min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
          >
            <option value="">All Vehicles</option>
            {vehicles.map((v) => (
              <option key={v.id} value={String(v.id)}>
                {v.reg_number} · {v.make_model}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-blue-200/80 bg-white p-6 text-base text-slate-500">
          Loading maintenance records...
        </div>
      ) : (
        <>
          {/* TAB 1: NEXT SERVICE DUES (KM) */}
          {activeTab === 'service-dues' && (
            <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
              <div className="border-b border-blue-100 bg-blue-50/40 px-5 py-3.5">
                <h2 className="text-base font-bold text-blue-950">
                  Next Service Dues &amp; Fleet Condition ({overview?.serviceDues.length ?? 0})
                </h2>
              </div>

              {(overview?.serviceDues.length ?? 0) === 0 ? (
                <div className="p-6 text-sm text-slate-600">No vehicles match this filter.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-blue-100 bg-blue-50/60 text-xs font-semibold text-blue-900">
                        <th className="py-3 px-4">Vehicle</th>
                        <th className="py-3 px-4">Condition</th>
                        <th className="py-3 px-4 text-right">Current Odometer</th>
                        <th className="py-3 px-4 text-right">Next Service Due</th>
                        <th className="py-3 px-4 text-right">Remaining (km)</th>
                        <th className="py-3 px-4">Status</th>
                        {canMaintain && <th className="py-3 px-4 text-right">Action</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-blue-100">
                      {(overview?.serviceDues ?? []).map((s) => (
                        <tr key={s.vehicle_id} className="hover:bg-cyan-50/35">
                          <td className="py-3 px-4">
                            <button
                              type="button"
                              onClick={() => onOpenVehicle?.(s.vehicle_id)}
                              className="text-left group"
                            >
                              <div className="font-mono font-bold text-blue-950 group-hover:text-cyan-700">
                                {s.reg_number}
                                {!s.active && (
                                  <span className="ml-2 text-xs font-sans text-red-700">
                                    (Disabled)
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-slate-600">
                                {s.make_model} · {s.vehicle_type}
                              </div>
                            </button>
                          </td>
                          <td className="py-3 px-4 font-medium text-blue-900">
                            <span
                              className={
                                s.condition === 'Grounded' || s.condition === 'Accident'
                                  ? 'font-semibold text-red-700'
                                  : ''
                              }
                            >
                              {s.condition}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-950">
                            {s.last_known_mileage.toLocaleString()} km
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-blue-950">
                            {s.next_service_due_km !== null
                              ? `${s.next_service_due_km.toLocaleString()} km`
                              : '—'}
                          </td>
                          <td
                            className={`py-3 px-4 text-right font-mono tabular-nums font-semibold ${
                              s.service_due_status === 'OVERDUE'
                                ? 'text-red-700'
                                : s.service_due_status === 'DUE_SOON'
                                  ? 'text-amber-700'
                                  : 'text-slate-700'
                            }`}
                          >
                            {s.remaining_km !== null ? `${s.remaining_km.toLocaleString()} km` : '—'}
                          </td>
                          <td className="py-3 px-4">
                            <ServiceDueBadge status={s.service_due_status} />
                          </td>
                          {canMaintain && (
                            <td className="py-2 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => handleOpenDueEdit(s)}
                                className="cyan-glow-outline min-h-[38px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                              >
                                Set Due km
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: MECHANICAL & SERVICE HISTORY */}
          {activeTab === 'history' && (
            <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50/40 px-5 py-3.5">
                <h2 className="text-base font-bold text-blue-950">
                  Mechanical &amp; Service History ({overview?.maintenanceLogs.length ?? 0})
                </h2>
                {canMaintain && (
                  <button
                    type="button"
                    onClick={openCreateLogModal}
                    className="cyan-glow-btn inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    <span>Add History Entry</span>
                  </button>
                )}
              </div>

              {(overview?.maintenanceLogs.length ?? 0) === 0 ? (
                <div className="p-6 text-sm text-slate-600">
                  No mechanical or service logs recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-blue-100">
                  {(overview?.maintenanceLogs ?? []).map((log) => (
                    <div key={log.id} className="p-4 sm:px-5 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                              log.record_type === 'SERVICE'
                                ? 'bg-cyan-100 text-cyan-900'
                                : 'bg-blue-100 text-blue-900'
                            }`}
                          >
                            {log.record_type}
                          </span>
                          <span className="font-mono font-bold text-blue-950">{log.reg_number}</span>
                          <span className="text-sm text-slate-600">{log.make_model}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-600">
                          <span>{log.service_date}</span>
                          <span>{log.odometer_km.toLocaleString()} km</span>
                          {log.cost !== null && (
                            <span className="font-semibold text-blue-950">
                              ${log.cost.toFixed(2)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-sm font-semibold text-blue-950">{log.summary}</div>
                      {log.details && <p className="text-sm text-slate-700">{log.details}</p>}
                      <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                        {log.workshop_name && <span>Workshop: {log.workshop_name}</span>}
                        {log.next_service_due_km !== null && (
                          <span>
                            Next service set: {log.next_service_due_km.toLocaleString()} km
                          </span>
                        )}
                        {log.created_by_name && <span>Logged by: {log.created_by_name}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: GARAGE VISITS */}
          {activeTab === 'garage' && (
            <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50/40 px-5 py-3.5">
                <h2 className="text-base font-bold text-blue-950">
                  Garage Visits ({overview?.garageVisits.length ?? 0})
                </h2>
                {canMaintain && (
                  <button
                    type="button"
                    onClick={openCreateGarageModal}
                    className="cyan-glow-btn inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    <span>Request Garage Visit</span>
                  </button>
                )}
              </div>

              {(overview?.garageVisits.length ?? 0) === 0 ? (
                <div className="p-6 text-sm text-slate-600">No garage visits recorded yet.</div>
              ) : (
                <div className="divide-y divide-blue-100">
                  {(overview?.garageVisits ?? []).map((visit) => (
                    <div
                      key={visit.id}
                      className="p-4 sm:px-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-bold text-blue-950">
                            {visit.reg_number}
                          </span>
                          <span className="text-sm text-slate-600">{visit.make_model}</span>
                          <ApprovalStatusBadge status={visit.approval_status} />
                          <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-900">
                            {visit.visit_status.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="text-sm font-semibold text-blue-950">
                          {visit.workshop_name} — {visit.reason}
                        </div>
                        <div className="text-xs font-mono tabular-nums text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                          <span>Date: {visit.visit_date}</span>
                          <span>Odometer: {visit.odometer_km.toLocaleString()} km</span>
                          {visit.estimated_cost !== null && (
                            <span>Est: ${visit.estimated_cost.toFixed(2)}</span>
                          )}
                          {visit.actual_cost !== null && (
                            <span>Actual: ${visit.actual_cost.toFixed(2)}</span>
                          )}
                        </div>
                        {visit.notes && <p className="text-xs text-slate-600">{visit.notes}</p>}
                        {visit.approval_notes && (
                          <p className="text-xs font-medium text-blue-900">
                            Admin note: {visit.approval_notes}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {isAdmin && visit.approval_status === 'PENDING_APPROVAL' && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setDecisionTarget({ kind: 'garage', visit, decision: 'APPROVED' });
                                setDecisionNotes('');
                              }}
                              className="cyan-glow-btn min-h-[38px] rounded-lg px-3 text-xs font-semibold"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDecisionTarget({ kind: 'garage', visit, decision: 'REJECTED' });
                                setDecisionNotes('');
                              }}
                              className="min-h-[38px] rounded-lg border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50"
                            >
                              Reject
                            </button>
                          </>
                        )}

                        {canMaintain && visit.approval_status === 'APPROVED' && (
                          <button
                            type="button"
                            onClick={() => {
                              setUpdatingVisit(visit);
                              setVisitStatusInput(
                                visit.visit_status === 'SCHEDULED' ? 'IN_GARAGE' : 'COMPLETED'
                              );
                              setVisitActualCost(
                                visit.actual_cost !== null ? String(visit.actual_cost) : ''
                              );
                              setVisitNotesInput(visit.notes);
                            }}
                            className="cyan-glow-outline min-h-[38px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                          >
                            Update Status
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: PARTS & SERVICE KITS PURCHASES */}
          {activeTab === 'parts' && (
            <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100 bg-blue-50/40 px-5 py-3.5">
                <h2 className="text-base font-bold text-blue-950">
                  Parts &amp; Service Kits Purchases ({overview?.partsRequests.length ?? 0})
                </h2>
                {canMaintain && (
                  <button
                    type="button"
                    onClick={openPartsRequestModal}
                    className="cyan-glow-btn inline-flex min-h-[38px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    <span>New Purchase Request</span>
                  </button>
                )}
              </div>

              {(overview?.partsRequests.length ?? 0) === 0 ? (
                <div className="p-6 text-sm text-slate-600">
                  No parts or service kit purchase requests submitted yet.
                </div>
              ) : (
                <div className="divide-y divide-blue-100">
                  {(overview?.partsRequests ?? []).map((req) => (
                    <div
                      key={req.id}
                      className="p-4 sm:px-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-bold text-blue-950">
                            {req.reg_number}
                          </span>
                          <span className="text-sm text-slate-600">{req.make_model}</span>
                          {req.is_full_service_kit && (
                            <span className="rounded bg-cyan-100 px-2 py-0.5 text-[11px] font-bold text-cyan-900">
                              Full Service Kit
                            </span>
                          )}
                          <ApprovalStatusBadge status={req.status} />
                        </div>

                        <div className="text-sm font-semibold text-blue-950">
                          {req.parts_required}
                        </div>

                        <div className="text-xs font-mono tabular-nums text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                          <span>Date: {req.request_date}</span>
                          <span>Required by: {req.date_required}</span>
                          <span className="font-semibold text-blue-950">
                            Est. Amount: ${req.estimated_amount.toFixed(2)}
                          </span>
                        </div>

                        <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                          {req.requested_by_name && (
                            <span>Requested by: {req.requested_by_name}</span>
                          )}
                          {req.authorized_by_name && (
                            <span>Authorized by: {req.authorized_by_name}</span>
                          )}
                          {req.admin_notes && (
                            <span className="font-medium text-blue-900">
                              Admin notes: {req.admin_notes}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        {req.has_quotation_file && (
                          <button
                            type="button"
                            disabled={loadingQuotationId === req.id}
                            onClick={() => void handleViewQuotation(req)}
                            className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                          >
                            <Eye className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                            <span>
                              {loadingQuotationId === req.id ? 'Loading...' : 'View Quotation'}
                            </span>
                          </button>
                        )}

                        {isAdmin && req.status === 'PENDING_ADMIN_AUTHORIZATION' && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setDecisionTarget({ kind: 'parts', req, decision: 'APPROVED' });
                                setDecisionNotes('');
                              }}
                              className="cyan-glow-btn min-h-[38px] rounded-lg px-3 text-xs font-semibold"
                            >
                              Authorize
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDecisionTarget({ kind: 'parts', req, decision: 'REJECTED' });
                                setDecisionNotes('');
                              }}
                              className="min-h-[38px] rounded-lg border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 hover:bg-red-50"
                            >
                              Reject
                            </button>
                          </>
                        )}

                        {canMaintain && req.status === 'APPROVED' && (
                          <button
                            type="button"
                            onClick={() => void handleMarkPurchased(req)}
                            className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-900"
                          >
                            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Mark Purchased</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* MODAL: SET NEXT SERVICE DUE KM */}
      {editingDueVehicle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-lg font-bold text-blue-950">
                Next Service Due · {editingDueVehicle.reg_number}
              </h2>
              <button
                type="button"
                onClick={() => setEditingDueVehicle(null)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Current odometer: {editingDueVehicle.last_known_mileage.toLocaleString()} km
            </p>
            <form onSubmit={handleSaveNextDue} className="mt-4 space-y-4">
              <div>
                <label htmlFor="due-km-input" className="block text-sm font-semibold text-blue-950">
                  Next Service Due Mileage (km)
                </label>
                <input
                  id="due-km-input"
                  type="number"
                  min={0}
                  step="1"
                  value={dueKmInput}
                  onChange={(e) => setDueKmInput(e.target.value)}
                  placeholder="Leave blank to clear"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono text-base text-blue-950"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={savingDue}
                  className="cyan-glow-btn flex-1 min-h-[44px] rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
                >
                  {savingDue ? 'Saving...' : 'Save Service Due'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingDueVehicle(null)}
                  className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADD MECHANICAL / SERVICE HISTORY ENTRY */}
      {showLogModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-bold text-blue-950">
                Record Mechanical / Service History
              </h2>
              <button
                type="button"
                onClick={() => setShowLogModal(false)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateLog} className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="log-veh" className="block text-sm font-semibold text-blue-950">
                    Vehicle *
                  </label>
                  <select
                    id="log-veh"
                    required
                    value={logVehicleId}
                    onChange={(e) => {
                      setLogVehicleId(e.target.value);
                      const v = vehicles.find((x) => String(x.id) === e.target.value);
                      if (v) setLogOdometer(String(v.last_known_mileage));
                    }}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={String(v.id)}>
                        {v.reg_number} · {v.make_model}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="log-type" className="block text-sm font-semibold text-blue-950">
                    Entry Type *
                  </label>
                  <select
                    id="log-type"
                    value={logType}
                    onChange={(e) => setLogType(e.target.value as MaintenanceRecordType)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    <option value="SERVICE">Service History</option>
                    <option value="MECHANICAL">Mechanical Repair</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="log-date" className="block text-sm font-semibold text-blue-950">
                    Service Date *
                  </label>
                  <input
                    id="log-date"
                    type="date"
                    required
                    value={logDate}
                    onChange={(e) => setLogDate(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="log-odo" className="block text-sm font-semibold text-blue-950">
                    Odometer (km) *
                  </label>
                  <input
                    id="log-odo"
                    type="number"
                    min={0}
                    step="1"
                    required
                    value={logOdometer}
                    onChange={(e) => setLogOdometer(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="log-summary" className="block text-sm font-semibold text-blue-950">
                  Work Summary *
                </label>
                <input
                  id="log-summary"
                  type="text"
                  required
                  value={logSummary}
                  onChange={(e) => setLogSummary(e.target.value)}
                  placeholder="e.g. 10,000 km full oil & filter service / Brake pad replacement"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3.5 text-sm text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="log-details" className="block text-sm font-semibold text-blue-950">
                  Technical Details (optional)
                </label>
                <textarea
                  id="log-details"
                  rows={2}
                  value={logDetails}
                  onChange={(e) => setLogDetails(e.target.value)}
                  placeholder="Parts changed, mechanic findings, notes..."
                  className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="log-workshop" className="block text-sm font-semibold text-blue-950">
                    Workshop
                  </label>
                  <input
                    id="log-workshop"
                    type="text"
                    value={logWorkshop}
                    onChange={(e) => setLogWorkshop(e.target.value)}
                    placeholder="e.g. In-house / AutoCare"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="log-cost" className="block text-sm font-semibold text-blue-950">
                    Cost ($)
                  </label>
                  <input
                    id="log-cost"
                    type="number"
                    min={0}
                    step="0.01"
                    value={logCost}
                    onChange={(e) => setLogCost(e.target.value)}
                    placeholder="0.00"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="log-next-due" className="block text-sm font-semibold text-blue-950">
                    Next Due (km)
                  </label>
                  <input
                    id="log-next-due"
                    type="number"
                    min={0}
                    step="1"
                    value={logNextDue}
                    onChange={(e) => setLogNextDue(e.target.value)}
                    placeholder="e.g. 135000"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingLog}
                  className="cyan-glow-btn flex-1 min-h-[46px] rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
                >
                  {savingLog ? 'Saving...' : 'Save History Entry'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowLogModal(false)}
                  className="cyan-glow-outline min-h-[46px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: REQUEST GARAGE VISIT */}
      {showGarageModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-blue-950">
                  Request Garage Visit
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Requires Administrator approval before vehicle enters garage work.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGarageModal(false)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreateGarageVisit} className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="gar-veh" className="block text-sm font-semibold text-blue-950">
                    Vehicle *
                  </label>
                  <select
                    id="gar-veh"
                    required
                    value={garageVehicleId}
                    onChange={(e) => {
                      setGarageVehicleId(e.target.value);
                      const v = vehicles.find((x) => String(x.id) === e.target.value);
                      if (v) setGarageOdometer(String(v.last_known_mileage));
                    }}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    {vehicles.map((v) => (
                      <option key={v.id} value={String(v.id)}>
                        {v.reg_number} · {v.make_model}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="gar-date" className="block text-sm font-semibold text-blue-950">
                    Visit Date *
                  </label>
                  <input
                    id="gar-date"
                    type="date"
                    required
                    value={garageDate}
                    onChange={(e) => setGarageDate(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="gar-shop" className="block text-sm font-semibold text-blue-950">
                  Garage / Workshop Name *
                </label>
                <input
                  id="gar-shop"
                  type="text"
                  required
                  value={garageWorkshop}
                  onChange={(e) => setGarageWorkshop(e.target.value)}
                  placeholder="e.g. Harare Motor Works"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3.5 text-sm text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="gar-reason" className="block text-sm font-semibold text-blue-950">
                  Reason / Fault Description *
                </label>
                <input
                  id="gar-reason"
                  type="text"
                  required
                  value={garageReason}
                  onChange={(e) => setGarageReason(e.target.value)}
                  placeholder="e.g. Suspension inspection and wheel alignment"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3.5 text-sm text-blue-950"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="gar-odo" className="block text-sm font-semibold text-blue-950">
                    Odometer (km) *
                  </label>
                  <input
                    id="gar-odo"
                    type="number"
                    min={0}
                    step="1"
                    required
                    value={garageOdometer}
                    onChange={(e) => setGarageOdometer(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="gar-est" className="block text-sm font-semibold text-blue-950">
                    Estimated Cost ($)
                  </label>
                  <input
                    id="gar-est"
                    type="number"
                    min={0}
                    step="0.01"
                    value={garageEstCost}
                    onChange={(e) => setGarageEstCost(e.target.value)}
                    placeholder="0.00"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="gar-notes" className="block text-sm font-semibold text-blue-950">
                  Notes (optional)
                </label>
                <textarea
                  id="gar-notes"
                  rows={2}
                  value={garageNotes}
                  onChange={(e) => setGarageNotes(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingGarage}
                  className="cyan-glow-btn flex-1 min-h-[46px] rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
                >
                  {savingGarage ? 'Submitting...' : 'Submit for Admin Approval'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowGarageModal(false)}
                  className="cyan-glow-outline min-h-[46px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: UPDATE GARAGE VISIT STATUS */}
      {updatingVisit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-lg font-bold text-blue-950">
                Update Garage Visit · {updatingVisit.reg_number}
              </h2>
              <button
                type="button"
                onClick={() => setUpdatingVisit(null)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleUpdateVisitStatus} className="mt-4 space-y-4">
              <div>
                <label htmlFor="gv-status" className="block text-sm font-semibold text-blue-950">
                  Visit Status
                </label>
                <select
                  id="gv-status"
                  value={visitStatusInput}
                  onChange={(e) => setVisitStatusInput(e.target.value as GarageVisitStatus)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                >
                  <option value="SCHEDULED">Scheduled</option>
                  <option value="IN_GARAGE">In Garage</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </div>
              <div>
                <label htmlFor="gv-actual" className="block text-sm font-semibold text-blue-950">
                  Actual Cost ($)
                </label>
                <input
                  id="gv-actual"
                  type="number"
                  min={0}
                  step="0.01"
                  value={visitActualCost}
                  onChange={(e) => setVisitActualCost(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
              </div>
              <div>
                <label htmlFor="gv-notes" className="block text-sm font-semibold text-blue-950">
                  Notes
                </label>
                <textarea
                  id="gv-notes"
                  rows={2}
                  value={visitNotesInput}
                  onChange={(e) => setVisitNotesInput(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={savingVisitStatus}
                  className="cyan-glow-btn flex-1 min-h-[44px] rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
                >
                  {savingVisitStatus ? 'Saving...' : 'Save Status'}
                </button>
                <button
                  type="button"
                  onClick={() => setUpdatingVisit(null)}
                  className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: PARTS & SERVICE KITS PURCHASE REQUEST FORM */}
      {showPartsModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-blue-950">
                  Parts &amp; Service Kits Purchase Request
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Submit for Administrator authorization before purchasing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPartsModal(false)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitPartsRequest} className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="pr-date" className="block text-sm font-semibold text-blue-950">
                    Date *
                  </label>
                  <input
                    id="pr-date"
                    type="date"
                    required
                    value={partsRequestDate}
                    onChange={(e) => setPartsRequestDate(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="pr-date-req" className="block text-sm font-semibold text-blue-950">
                    Date Required *
                  </label>
                  <input
                    id="pr-date-req"
                    type="date"
                    required
                    value={partsDateRequired}
                    onChange={(e) => setPartsDateRequired(e.target.value)}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
              </div>

              {/* Vehicle needs Parts/Service (Pick from Fleet Database OR Add New) */}
              <div className="rounded-xl border border-blue-200/80 bg-blue-50/30 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-blue-950">
                    Vehicle Needs Parts / Service *
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPartsVehicleMode('existing')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                        partsVehicleMode === 'existing'
                          ? 'cyan-glow-active'
                          : 'border-blue-200 bg-white text-blue-900'
                      }`}
                    >
                      Fleet Database
                    </button>
                    <button
                      type="button"
                      onClick={() => setPartsVehicleMode('new')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                        partsVehicleMode === 'new'
                          ? 'cyan-glow-active'
                          : 'border-blue-200 bg-white text-blue-900'
                      }`}
                    >
                      + Add New Vehicle
                    </button>
                  </div>
                </div>

                {partsVehicleMode === 'existing' ? (
                  <select
                    aria-label="Select vehicle from fleet database"
                    required
                    value={partsVehicleId}
                    onChange={(e) => setPartsVehicleId(e.target.value)}
                    className="cyan-glow-input block w-full min-h-[46px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    <option value="">Select a vehicle...</option>
                    {vehicles.map((v) => (
                      <option key={v.id} value={String(v.id)}>
                        {v.reg_number} · {v.make_model} ({v.condition})
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="space-y-3 border-t border-blue-200/70 pt-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor="nv-reg"
                          className="block text-xs font-semibold text-blue-950"
                        >
                          Registration Number *
                        </label>
                        <input
                          id="nv-reg"
                          type="text"
                          required
                          value={newVehReg}
                          onChange={(e) => setNewVehReg(e.target.value)}
                          placeholder="e.g. AGB 9102"
                          className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono uppercase text-sm text-blue-950"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="nv-type"
                          className="block text-xs font-semibold text-blue-950"
                        >
                          Vehicle Type *
                        </label>
                        <select
                          id="nv-type"
                          value={newVehType}
                          onChange={(e) => setNewVehType(e.target.value)}
                          className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                        >
                          {VEHICLE_TYPES.map((vt) => (
                            <option key={vt} value={vt}>
                              {vt} ({VEHICLE_TYPE_TO_CLASS[vt]})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label
                          htmlFor="nv-make"
                          className="block text-xs font-semibold text-blue-950"
                        >
                          Make &amp; Model *
                        </label>
                        <input
                          id="nv-make"
                          type="text"
                          required
                          value={newVehMakeModel}
                          onChange={(e) => setNewVehMakeModel(e.target.value)}
                          placeholder="e.g. Isuzu D-Max"
                          className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="nv-km"
                          className="block text-xs font-semibold text-blue-950"
                        >
                          Odometer (km) *
                        </label>
                        <input
                          id="nv-km"
                          type="number"
                          min={0}
                          step="1"
                          required
                          value={newVehMileage}
                          onChange={(e) => setNewVehMileage(e.target.value)}
                          className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="nv-cond"
                        className="block text-xs font-semibold text-blue-950"
                      >
                        Condition
                      </label>
                      <select
                        id="nv-cond"
                        value={newVehCondition}
                        onChange={(e) => setNewVehCondition(e.target.value as VehicleCondition)}
                        className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                      >
                        {VEHICLE_CONDITIONS.map((cond) => (
                          <option key={cond} value={cond}>
                            {cond}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="pr-parts" className="block text-sm font-semibold text-blue-950">
                    Parts Required / Full Service Kit *
                  </label>
                  <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={partsIsFullKit}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setPartsIsFullKit(checked);
                        if (checked && !partsRequiredText.trim()) {
                          setPartsRequiredText('Full Service Kit');
                        }
                      }}
                      className="h-4 w-4 rounded border-blue-300 text-cyan-600 accent-cyan-600"
                    />
                    <span>Full Service Kit</span>
                  </label>
                </div>
                <textarea
                  id="pr-parts"
                  rows={2}
                  required
                  value={partsRequiredText}
                  onChange={(e) => setPartsRequiredText(e.target.value)}
                  placeholder="List parts required (e.g. Full Service Kit: oil filter, air filter, fuel filter, 5W-30 oil, front brake pads)"
                  className="cyan-glow-input block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="pr-amount" className="block text-sm font-semibold text-blue-950">
                  Amount (EST) ($) *
                </label>
                <input
                  id="pr-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  value={partsEstAmount}
                  onChange={(e) => setPartsEstAmount(e.target.value)}
                  placeholder="e.g. 245.00"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[46px] rounded-xl border border-blue-200 px-3.5 font-mono text-base text-blue-950"
                />
              </div>

              <div className="space-y-2">
                <DocumentUploadField
                  label="Attach Quotation File (if available)"
                  value={partsQuotationFile}
                  onChange={setPartsQuotationFile}
                  hint="Optional · Upload supplier quotation PDF (<700 KB) / image or take photo"
                />
                {partsQuotationFile && (
                  <input
                    type="text"
                    value={partsQuotationFilename}
                    onChange={(e) => setPartsQuotationFilename(e.target.value)}
                    placeholder="Quotation reference / file label (optional, e.g. Q-2026-104.pdf)"
                    className="cyan-glow-input block w-full min-h-[40px] rounded-xl border border-blue-200 px-3 text-xs text-blue-950"
                  />
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingParts}
                  className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
                >
                  {savingParts ? 'Submitting...' : 'Submit & Wait for Admin Authorization'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPartsModal(false)}
                  className="cyan-glow-outline min-h-[48px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: ADMIN APPROVAL / AUTHORIZATION DECISION */}
      {decisionTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-lg font-bold text-blue-950">
                Admin{' '}
                {decisionTarget.decision === 'APPROVED'
                  ? decisionTarget.kind === 'parts'
                    ? 'Authorize Purchase'
                    : 'Approve Garage Visit'
                  : 'Reject Request'}
              </h2>
              <button
                type="button"
                onClick={() => setDecisionTarget(null)}
                aria-label="Close"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm text-slate-700">
              {decisionTarget.kind === 'garage'
                ? `${decisionTarget.visit.reg_number} at ${decisionTarget.visit.workshop_name}: ${decisionTarget.visit.reason}`
                : `${decisionTarget.req.reg_number} — ${decisionTarget.req.parts_required} (Est. $${decisionTarget.req.estimated_amount.toFixed(2)})`}
            </p>
            <form onSubmit={handleSubmitDecision} className="mt-4 space-y-4">
              <div>
                <label htmlFor="dec-notes" className="block text-sm font-semibold text-blue-950">
                  Admin Notes (optional)
                </label>
                <textarea
                  id="dec-notes"
                  rows={2}
                  value={decisionNotes}
                  onChange={(e) => setDecisionNotes(e.target.value)}
                  placeholder="Authorization reference or reason..."
                  className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
                />
              </div>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={savingDecision}
                  className={`flex-1 min-h-[44px] rounded-xl px-4 text-sm font-semibold ${
                    decisionTarget.decision === 'APPROVED'
                      ? 'cyan-glow-btn'
                      : 'bg-red-700 text-white hover:bg-red-800'
                  } disabled:opacity-60`}
                >
                  {savingDecision
                    ? 'Saving...'
                    : decisionTarget.decision === 'APPROVED'
                      ? 'Confirm Authorization'
                      : 'Confirm Rejection'}
                </button>
                <button
                  type="button"
                  onClick={() => setDecisionTarget(null)}
                  className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: QUOTATION PREVIEW */}
      {quotationPreview && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-blue-950/60 backdrop-blur-xs p-4"
          onClick={() => setQuotationPreview(null)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-5 w-5 text-cyan-600 shrink-0" aria-hidden="true" />
                <h3 className="font-display text-base font-bold text-blue-950 truncate">
                  {quotationPreview.title}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setQuotationPreview(null)}
                aria-label="Close quotation preview"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {isPdfDataUrl(quotationPreview.file) ? (
              <div className="space-y-3">
                <iframe
                  title={quotationPreview.title}
                  src={quotationPreview.file}
                  className="h-[65vh] w-full rounded-xl border border-blue-200 bg-slate-50"
                />
                <div className="flex justify-end">
                  <a
                    href={quotationPreview.file}
                    download={quotationPreview.filename || 'quotation.pdf'}
                    className="cyan-glow-btn inline-flex min-h-[40px] items-center rounded-xl px-4 text-xs font-semibold"
                  >
                    Download PDF
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <img
                  src={quotationPreview.file}
                  alt={quotationPreview.title}
                  className="max-h-[70vh] w-auto rounded-xl border border-blue-200 object-contain"
                />
                <a
                  href={quotationPreview.file}
                  download={quotationPreview.filename || 'quotation.jpg'}
                  className="cyan-glow-outline inline-flex min-h-[40px] items-center rounded-xl border border-blue-200 bg-white px-4 text-xs font-semibold text-blue-900"
                >
                  Download Image
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
