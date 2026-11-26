import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Download,
  Edit3,
  FilePlus2,
  Plus,
  Printer,
  Search,
  Settings2,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  CACHE_KEYS,
  ONLINE_RECONNECTED_EVENT,
  readCachedEntry,
  writeCachedEntry,
  type CachedVehiclesPayload,
} from '../lib/offlineCache';
import {
  OFFLINE_SYNCED_EVENT,
  enqueueOfflineEntry,
  isLikelyNetworkError,
} from '../lib/offlineQueue';
import {
  FUEL_LEVELS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_TYPES,
  formatHarareTime,
  type ChecklistDetail,
  type ChecklistHirerType,
  type ChecklistInputType,
  type ChecklistItemTemplate,
  type ChecklistItemValue,
  type ChecklistSignatureEntry,
  type ChecklistSketchData,
  type ChecklistSummary,
  type CompleteChecklistPayload,
  type CreateChecklistPayload,
  type FuelLevel,
  type Role,
  type UserPublic,
  type Vehicle,
  type VehicleFuelType,
} from '../shared/types';
import {
  ChecklistSectionG,
  VehicleConditionSketch,
  createEmptySketch,
  exportSketchPngDataUrl,
  inferSketchKind,
} from './VehicleConditionSketch';

export interface ChecklistPrefill {
  trip_id?: number | null;
  vehicle_id?: number;
  hirer_type?: ChecklistHirerType;
  hirer_name?: string;
  representative?: string;
  hire_date?: string;
  days?: number;
  mileage_out?: number;
  fuel_out?: FuelLevel | null;
}

interface ChecklistsViewProps {
  currentUser: UserPublic;
  companyName: string;
  initialPrefill?: ChecklistPrefill | null;
  onConsumePrefill?: () => void;
  onOpenVehicle?: (vehicleId: number) => void;
}

interface DraftChecklistRow {
  localKey: string;
  id?: number;
  template_id: number | null;
  custom_label: string;
  input_type: ChecklistInputType;
  options: string[];
  sort_order: number;
  value_out: ChecklistItemValue;
  value_in: ChecklistItemValue | null;
  note: string;
  photo_data_url: string | null;
}

function getHarareTodayStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return isoDate;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + Math.max(0, days));
  return dt.toISOString().slice(0, 10);
}

function formatChecklistPrintTitle(regNumber: string, hireDateYmd: string): string {
  const cleanReg = regNumber.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'VEHICLE';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hireDateYmd.trim());
  const datePart = match
    ? `${match[3]}-${match[2]}-${match[1].slice(-2)}`
    : (() => {
        const today = getHarareTodayStr();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
        return m ? `${m[3]}-${m[2]}-${m[1].slice(-2)}` : today;
      })();
  return `Checklist_${cleanReg}_${datePart}`;
}

function getExpiryState(expiryDate: string, todayStr: string): 'EXPIRED' | 'SOON' | 'OK' | null {
  if (!expiryDate) return null;
  const dExp = new Date(`${expiryDate}T00:00:00Z`).getTime();
  const dToday = new Date(`${todayStr}T00:00:00Z`).getTime();
  if (Number.isNaN(dExp) || Number.isNaN(dToday)) return null;
  const diffDays = Math.floor((dExp - dToday) / 86_400_000);
  if (diffDays < 0) return 'EXPIRED';
  if (diffDays <= 30) return 'SOON';
  return 'OK';
}

function summarizeChecklistVal(val: ChecklistItemValue | null | undefined, type: ChecklistInputType): string {
  if (!val) return '—';
  if (type === 'tick_cross') {
    if (val.choice === 'tick') return '✓ OK';
    if (val.choice === 'cross') return '✗ Issue';
    return val.choice || '—';
  }
  if (type === 'status_pair' || type === 'yes_no' || type === 'available_na') {
    return val.choice || '—';
  }
  if (type === 'text') return val.text?.trim() || '—';
  if (type === 'text_checkbox') {
    const parts = [val.choice, val.text?.trim()].filter(Boolean);
    return parts.length ? parts.join(' — ') : '—';
  }
  if (type === 'multi_check') {
    return val.checked && val.checked.length > 0 ? val.checked.join(', ') : 'None';
  }
  if (type === 'numbers' && val.counts) {
    const entries = Object.entries(val.counts).map(([k, v]) => `${k}: ${v}`);
    return entries.length ? entries.join(' · ') : '0';
  }
  if (type === 'expiry_checks' && val.expiries) {
    const entries = Object.entries(val.expiries).map(
      ([k, v]) => `${k}: ${v.checked ? 'Yes' : 'No'}${v.expiry_date ? ` (${v.expiry_date})` : ''}`
    );
    return entries.length ? entries.join(' · ') : '—';
  }
  return '—';
}

async function compressPhotoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read selected photo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file.'));
      img.onload = () => {
        const maxSide = 960;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(String(reader.result));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function makeDefaultValue(inputType: ChecklistInputType, options: string[]): ChecklistItemValue {
  if (inputType === 'multi_check') return { checked: [] };
  if (inputType === 'numbers') {
    const counts: Record<string, number> = {};
    for (const opt of options) counts[opt] = 0;
    return { counts };
  }
  if (inputType === 'expiry_checks') {
    const expiries: Record<string, { checked: boolean; expiry_date: string }> = {};
    for (const opt of options) expiries[opt] = { checked: false, expiry_date: '' };
    return { expiries };
  }
  if (inputType === 'text') return { text: '' };
  if (inputType === 'text_checkbox') return { choice: '', text: '' };
  return { choice: '' };
}

function buildDeclarationText(companyName: string): string {
  return `I confirm that I have inspected the vehicle with the ${companyName} representative and agree that all recorded mileage, fuel/battery levels, accessories, and exterior/interior conditions are accurate at the time of check-out / check-in.`;
}

const INPUT_TYPE_LABELS: Array<{ id: ChecklistInputType; label: string }> = [
  { id: 'tick_cross', label: 'Tick / Cross (✓ / ✗)' },
  { id: 'status_pair', label: 'Working / Faulty' },
  { id: 'yes_no', label: 'Yes / No' },
  { id: 'available_na', label: 'Available / N/A' },
  { id: 'text', label: 'Text Note' },
];

export const ChecklistsView: React.FC<ChecklistsViewProps> = ({
  currentUser,
  companyName,
  initialPrefill = null,
  onConsumePrefill,
  onOpenVehicle,
}) => {
  const isAdmin = currentUser.role === 'ADMIN';
  const todayStr = getHarareTodayStr();

  // Mode: list | create | detail
  const [screen, setScreen] = useState<'list' | 'create' | 'detail'>('list');

  // List state
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<'' | 'out' | 'completed'>('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [usingCache, setUsingCache] = useState(false);
  const [cacheUpdatedAt, setCacheUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Reference data (seed synchronously from offline cache when available so prefills load Section F immediately)
  const [vehicles, setVehicles] = useState<Vehicle[]>(
    () => readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll)?.data.items ?? []
  );
  const [templates, setTemplates] = useState<ChecklistItemTemplate[]>(
    () => readCachedEntry<ChecklistItemTemplate[]>(CACHE_KEYS.checklistTemplates)?.data ?? []
  );
  const [referenceLoaded, setReferenceLoaded] = useState(false);
  const [printA4OnSave, setPrintA4OnSave] = useState(true);
  const pendingAutoPrintRef = useRef<{ reg: string; date: string } | null>(null);

  // Detail state
  const [detail, setDetail] = useState<ChecklistDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [returnMode, setReturnMode] = useState(false);

  // Return completion state
  const [retMileageIn, setRetMileageIn] = useState('');
  const [retFuelIn, setRetFuelIn] = useState<FuelLevel | ''>('Full');
  const [retNextService, setRetNextService] = useState('');
  const [retColour, setRetColour] = useState('');
  const [retNotes, setRetNotes] = useState('');
  const [retSketch, setRetSketch] = useState<ChecklistSketchData>(createEmptySketch('sedan'));
  const [retItems, setRetItems] = useState<DraftChecklistRow[]>([]);
  const [retInRenter, setRetInRenter] = useState<ChecklistSignatureEntry>({
    name: '',
    id_number: '',
    signature_data_url: '',
  });
  const [retInCompany, setRetInCompany] = useState<ChecklistSignatureEntry>({
    name: currentUser.full_name,
    id_number: '',
    signature_data_url: '',
  });
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Admin Amend & Delete & Template Manager
  const [showAmendModal, setShowAmendModal] = useState(false);
  const [amendHirerName, setAmendHirerName] = useState('');
  const [amendRep, setAmendRep] = useState('');
  const [amendCell, setAmendCell] = useState('');
  const [amendColour, setAmendColour] = useState('');
  const [amendHireDate, setAmendHireDate] = useState('');
  const [amendDays, setAmendDays] = useState('1');
  const [amendNotes, setAmendNotes] = useState('');
  const [amendReason, setAmendReason] = useState('');
  const [savingAmend, setSavingAmend] = useState(false);

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deletingChecklist, setDeletingChecklist] = useState(false);

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [newTplLabel, setNewTplLabel] = useState('');
  const [newTplType, setNewTplType] = useState<ChecklistInputType>('tick_cross');
  const [savingTpl, setSavingTpl] = useState(false);

  // Create form state (Sections A–G)
  const [cTripId, setCTripId] = useState<number | null>(null);
  const [cHirerType, setCHirerType] = useState<ChecklistHirerType>('renter');
  const [cHirerName, setCHirerName] = useState('');
  const [cRepresentative, setCRepresentative] = useState('');
  const [cCell, setCCell] = useState('');

  const [vehicleSearch, setVehicleSearch] = useState('');
  const [cVehicleMode, setCVehicleMode] = useState<'existing' | 'new'>('existing');
  const [cVehicleId, setCVehicleId] = useState<number>(0);
  const [cNewType, setCNewType] = useState<string>(VEHICLE_TYPES[0]);
  const [cNewMakeModel, setCNewMakeModel] = useState('');
  const [cNewReg, setCNewReg] = useState('');
  const [cColour, setCColour] = useState('');

  const [cHireDate, setCHireDate] = useState(todayStr);
  const [cDays, setCDays] = useState('1');
  const [cMileageOut, setCMileageOut] = useState('0');
  const [cExpectedMileage, setCExpectedMileage] = useState<number | null>(null);
  const [cNextService, setCNextService] = useState('');
  const [cFuelType, setCFuelType] = useState<VehicleFuelType>('diesel');
  const [cFuelOut, setCFuelOut] = useState<FuelLevel | ''>('Full');
  const [cNotes, setCNotes] = useState('');
  const [cSketch, setCSketch] = useState<ChecklistSketchData>(createEmptySketch('sedan'));
  const [cItems, setCItems] = useState<DraftChecklistRow[]>([]);
  const [cOutRenter, setCOutRenter] = useState<ChecklistSignatureEntry>({
    name: '',
    id_number: '',
    signature_data_url: '',
  });
  const [cOutCompany, setCOutCompany] = useState<ChecklistSignatureEntry>({
    name: currentUser.full_name,
    id_number: '',
    signature_data_url: '',
  });
  const [submittingCreate, setSubmittingCreate] = useState(false);

  // Inline custom row state (for create & return)
  const [showAddRow, setShowAddRow] = useState(false);
  const [customRowLabel, setCustomRowLabel] = useState('');
  const [customRowType, setCustomRowType] = useState<ChecklistInputType>('tick_cross');
  const [expandedRowExtras, setExpandedRowExtras] = useState<Record<string, boolean>>({});

  const loadReferenceData = useCallback(async () => {
    try {
      const [vRes, tRes] = await Promise.all([
        api.listVehicles({ limit: 250 }),
        api.listChecklistTemplates(false),
      ]);
      setVehicles(vRes.items);
      writeCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll, {
        items: vRes.items,
        total: vRes.total,
      });
      setTemplates(tRes.items);
      writeCachedEntry<ChecklistItemTemplate[]>(CACHE_KEYS.checklistTemplates, tRes.items);
    } catch {
      const cachedVehicles = readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll);
      if (cachedVehicles) setVehicles(cachedVehicles.data.items);
      const cachedTemplates = readCachedEntry<ChecklistItemTemplate[]>(CACHE_KEYS.checklistTemplates);
      if (cachedTemplates) setTemplates(cachedTemplates.data);
    } finally {
      setReferenceLoaded(true);
    }
  }, []);

  const fetchChecklists = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUsingCache(false);
    setCacheUpdatedAt(null);
    try {
      const res = await api.listChecklists({
        status: statusFilter,
        q: query,
        limit: 100,
      });
      setChecklists(res.items);
      if (!statusFilter && !query) {
        writeCachedEntry<ChecklistSummary[]>(CACHE_KEYS.checklistsAll, res.items);
      }
    } catch (err) {
      if (isLikelyNetworkError(err) || (typeof navigator !== 'undefined' && !navigator.onLine)) {
        const cached = readCachedEntry<ChecklistSummary[]>(CACHE_KEYS.checklistsAll);
        if (cached) {
          const needle = query.trim().toLowerCase();
          const filtered = cached.data.filter((c) => {
            if (statusFilter && c.status !== statusFilter) return false;
            if (needle) {
              const hay = `${c.reg_number} ${c.hirer_name} ${c.hire_date} ${c.car_model}`.toLowerCase();
              if (!hay.includes(needle)) return false;
            }
            return true;
          });
          setChecklists(filtered);
          setUsingCache(true);
          setCacheUpdatedAt(cached.updatedAt);
        } else {
          setError('Offline mode — no cached checklists available yet.');
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to load checklists.');
      }
    } finally {
      setLoading(false);
    }
  }, [statusFilter, query]);

  useEffect(() => {
    void loadReferenceData();
    void fetchChecklists();
  }, [loadReferenceData, fetchChecklists]);

  useEffect(() => {
    const onRefresh = () => {
      void loadReferenceData();
      void fetchChecklists();
    };
    window.addEventListener(ONLINE_RECONNECTED_EVENT, onRefresh);
    window.addEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
    return () => {
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, onRefresh);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onRefresh);
    };
  }, [loadReferenceData, fetchChecklists]);

  const applyVehicleSelection = useCallback(
    (v: Vehicle, overrideMileage?: number, overrideFuel?: FuelLevel | null) => {
      setCVehicleMode('existing');
      setCVehicleId(v.id);
      setCColour(v.colour ?? '');
      const baseMileage = v.last_closing_mileage ?? v.last_known_mileage;
      setCExpectedMileage(baseMileage);
      setCMileageOut(String(overrideMileage !== undefined ? overrideMileage : baseMileage));
      setCNextService(
        v.next_service_due_km !== null && v.next_service_due_km !== undefined
          ? String(v.next_service_due_km)
          : ''
      );
      setCFuelType(v.fuel_type ?? 'diesel');
      setCFuelOut(overrideFuel ?? v.last_fuel_level ?? 'Full');
      setCSketch((prev) => ({
        ...prev,
        vehicle_kind: inferSketchKind(v.vehicle_type, v.make_model),
      }));
    },
    []
  );

  const printChecklistA4 = useCallback((regNumber: string, hireDateYmd: string) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const prevTitle = document.title;
    document.title = formatChecklistPrintTitle(regNumber, hireDateYmd);
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      document.title = prevTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
    window.setTimeout(restore, 1500);
  }, []);

  const buildDraftItemsFromTemplates = useCallback(
    (tplList: ChecklistItemTemplate[]): DraftChecklistRow[] =>
      tplList.map((t, idx) => ({
        localKey: `tpl_${t.id}_${idx}`,
        template_id: t.id,
        custom_label: t.label,
        input_type: t.input_type,
        options: t.options ?? [],
        sort_order: t.sort_order ?? idx + 1,
        value_out: makeDefaultValue(t.input_type, t.options ?? []),
        value_in: null,
        note: '',
        photo_data_url: null,
      })),
    []
  );

  const startNewChecklist = useCallback(
    (prefill?: ChecklistPrefill | null) => {
      setError(null);
      setNotice(null);
      const today = getHarareTodayStr();
      setCTripId(prefill?.trip_id ?? null);
      setCHirerType(prefill?.hirer_type ?? 'renter');
      setCHirerName(prefill?.hirer_name ?? '');
      setCRepresentative(prefill?.representative ?? '');
      setCCell('');
      setCHireDate(prefill?.hire_date ?? today);
      setCDays(String(prefill?.days && prefill.days >= 1 ? prefill.days : 1));
      setCNotes('');
      setShowAddRow(false);
      setExpandedRowExtras({});
      setCOutRenter({
        name: prefill?.hirer_name || prefill?.representative || '',
        id_number: '',
        signature_data_url: '',
      });
      setCOutCompany({
        name: currentUser.full_name,
        id_number: '',
        signature_data_url: '',
      });

      const activeTpls =
        templates.length > 0
          ? templates
          : readCachedEntry<ChecklistItemTemplate[]>(CACHE_KEYS.checklistTemplates)?.data ?? [];
      setCItems(buildDraftItemsFromTemplates(activeTpls));

      const availableVehicles =
        vehicles.length > 0
          ? vehicles
          : readCachedEntry<CachedVehiclesPayload>(CACHE_KEYS.vehiclesAll)?.data.items ?? [];

      const matchedVehicle =
        (prefill?.vehicle_id ? availableVehicles.find((v) => v.id === prefill.vehicle_id) : null) ??
        availableVehicles.find((v) => v.active) ??
        availableVehicles[0] ??
        null;

      if (matchedVehicle) {
        applyVehicleSelection(matchedVehicle, prefill?.mileage_out, prefill?.fuel_out);
      } else {
        setCVehicleMode('new');
        setCVehicleId(0);
        setCColour('');
        setCExpectedMileage(null);
        setCMileageOut(prefill?.mileage_out !== undefined ? String(prefill.mileage_out) : '0');
        setCNextService('');
        setCFuelType('diesel');
        setCFuelOut(prefill?.fuel_out ?? 'Full');
        setCSketch(createEmptySketch('sedan'));
      }

      setScreen('create');
    },
    [templates, vehicles, currentUser.full_name, applyVehicleSelection, buildDraftItemsFromTemplates]
  );

  useEffect(() => {
    if (!initialPrefill || !referenceLoaded) return;
    startNewChecklist(initialPrefill);
    onConsumePrefill?.();
  }, [initialPrefill, referenceLoaded, startNewChecklist, onConsumePrefill]);

  useEffect(() => {
    if (screen !== 'create') return;
    if (cItems.length === 0 && templates.length > 0) {
      setCItems(buildDraftItemsFromTemplates(templates));
    }
  }, [screen, cItems.length, templates, buildDraftItemsFromTemplates]);

  useEffect(() => {
    if (screen !== 'detail' || returnMode || !detail || !pendingAutoPrintRef.current) return;
    const job = pendingAutoPrintRef.current;
    pendingAutoPrintRef.current = null;
    const timer = window.setTimeout(() => {
      printChecklistA4(job.reg, job.date);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [screen, returnMode, detail, printChecklistA4]);

  const openDetail = async (id: number) => {
    if (id < 0) {
      setError('This checklist was saved offline and will open in detail view once synced to the cloud.');
      return;
    }
    setScreen('detail');
    setReturnMode(false);
    setDetailLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.getChecklist(id);
      setDetail(res.checklist);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load checklist.');
      setScreen('list');
    } finally {
      setDetailLoading(false);
    }
  };

  const beginReturnFlow = (chk: ChecklistDetail) => {
    setReturnMode(true);
    setRetMileageIn(String(chk.mileage_out));
    setRetFuelIn(chk.fuel_out ?? 'Full');
    setRetNextService(
      chk.next_service_mileage !== null && chk.next_service_mileage !== undefined
        ? String(chk.next_service_mileage)
        : ''
    );
    setRetColour(chk.colour ?? '');
    setRetNotes(chk.notes ?? '');
    setRetSketch({ ...chk.sketch });
    setRetItems(
      chk.items.map((it) => ({
        localKey: `item_${it.id}`,
        id: it.id,
        template_id: it.template_id,
        custom_label: it.custom_label,
        input_type: it.input_type,
        options: it.options,
        sort_order: it.sort_order,
        value_out: it.value_out,
        value_in: it.value_in ?? JSON.parse(JSON.stringify(it.value_out)),
        note: it.note ?? '',
        photo_data_url: it.photo_data_url ?? null,
      }))
    );
    setRetInRenter({
      name: chk.signatures.outRenter?.name || chk.hirer_name,
      id_number: chk.signatures.outRenter?.id_number || '',
      signature_data_url: '',
    });
    setRetInCompany({
      name: currentUser.full_name,
      id_number: '',
      signature_data_url: '',
    });
    setShowAddRow(false);
    setError(null);
  };

  const selectedVehicle = useMemo(
    () => (cVehicleMode === 'existing' ? vehicles.find((v) => v.id === cVehicleId) ?? null : null),
    [cVehicleMode, vehicles, cVehicleId]
  );

  const filteredVehiclesForPicker = useMemo(() => {
    const q = vehicleSearch.trim().toLowerCase();
    const activeOnes = vehicles.filter((v) => v.active);
    if (!q) return activeOnes;
    return activeOnes.filter((v) =>
      `${v.reg_number} ${v.make_model} ${v.vehicle_type} ${v.colour ?? ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [vehicles, vehicleSearch]);

  const cReturnDate = useMemo(
    () => addDaysToIsoDate(cHireDate, Number(cDays) || 1),
    [cHireDate, cDays]
  );

  const mileageDiffWarning = useMemo(() => {
    if (cExpectedMileage === null) return false;
    const entered = Number(cMileageOut);
    return Number.isFinite(entered) && entered !== cExpectedMileage;
  }, [cExpectedMileage, cMileageOut]);

  const handleAddInlineRowCreate = () => {
    const label = customRowLabel.trim();
    if (!label) return;
    const options =
      customRowType === 'status_pair'
        ? ['Working', 'Faulty']
        : customRowType === 'yes_no'
          ? ['Yes', 'No']
          : customRowType === 'available_na'
            ? ['Available', 'N/A']
            : [];
    const newRow: DraftChecklistRow = {
      localKey: `custom_${Date.now()}`,
      template_id: null,
      custom_label: label,
      input_type: customRowType,
      options,
      sort_order: cItems.length + 1,
      value_out: makeDefaultValue(customRowType, options),
      value_in: null,
      note: '',
      photo_data_url: null,
    };
    setCItems((prev) => [...prev, newRow]);
    setCustomRowLabel('');
    setShowAddRow(false);
  };

  const handleAddInlineRowReturn = async () => {
    if (!detail) return;
    const label = customRowLabel.trim();
    if (!label) return;
    const options =
      customRowType === 'status_pair'
        ? ['Working', 'Faulty']
        : customRowType === 'yes_no'
          ? ['Yes', 'No']
          : customRowType === 'available_na'
            ? ['Available', 'N/A']
            : [];
    try {
      const res = await api.addChecklistItem(detail.id, {
        custom_label: label,
        input_type: customRowType,
        options,
        value_out: makeDefaultValue(customRowType, options),
      });
      setRetItems((prev) => [
        ...prev,
        {
          localKey: `item_${res.item.id}`,
          id: res.item.id,
          template_id: res.item.template_id,
          custom_label: res.item.custom_label,
          input_type: res.item.input_type,
          options: res.item.options,
          sort_order: res.item.sort_order,
          value_out: res.item.value_out,
          value_in: makeDefaultValue(res.item.input_type, res.item.options),
          note: '',
          photo_data_url: null,
        },
      ]);
      setCustomRowLabel('');
      setShowAddRow(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add checklist row.');
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const daysNum = Number(cDays);
    if (!Number.isInteger(daysNum) || daysNum < 1) {
      setError('Days must be at least 1.');
      return;
    }
    const mileageNum = Number(cMileageOut);
    if (!Number.isInteger(mileageNum) || mileageNum < 0) {
      setError('Mileage Out must be 0 or greater.');
      return;
    }
    if (!cOutRenter.name.trim() || !cOutRenter.id_number.trim() || !cOutRenter.signature_data_url) {
      setError('Checked Out By (Renter / Driver) name, ID No., and signature are required.');
      return;
    }
    if (!cOutCompany.name.trim() || !cOutCompany.id_number.trim() || !cOutCompany.signature_data_url) {
      setError('Checked Out By (Company Rep) name, ID No., and signature are required.');
      return;
    }
    if (cVehicleMode === 'existing' && !cVehicleId) {
      setError('Select a vehicle or add a new vehicle.');
      return;
    }
    if (cVehicleMode === 'new' && (!cNewMakeModel.trim() || !cNewReg.trim())) {
      setError('Enter the new vehicle Make/Model and Registration Number.');
      return;
    }

    setSubmittingCreate(true);
    try {
      const sketchPng = await exportSketchPngDataUrl(cSketch);
      const nextServiceNum = cNextService.trim() ? Number(cNextService.trim()) : null;

      const payload: CreateChecklistPayload = {
        trip_id: cTripId,
        ...(cVehicleMode === 'existing'
          ? { vehicle_id: cVehicleId }
          : {
              new_vehicle: {
                vehicle_type: cNewType,
                make_model: cNewMakeModel.trim(),
                reg_number: cNewReg.trim().toUpperCase(),
                colour: cColour.trim() || null,
                fuel_type: cFuelType,
                last_known_mileage: mileageNum,
              },
            }),
        hirer_type: cHirerType,
        hirer_name: cHirerName.trim(),
        representative: cRepresentative.trim(),
        cell: cCell.trim(),
        colour: cColour.trim() || null,
        ...(isAdmin ? { hire_date: cHireDate } : {}),
        days: daysNum,
        mileage_out: mileageNum,
        next_service_mileage:
          nextServiceNum !== null && Number.isInteger(nextServiceNum) ? nextServiceNum : null,
        fuel_type: cFuelType,
        fuel_out: cFuelType === 'ev' && !cFuelOut ? null : (cFuelOut || 'Full'),
        notes: cNotes.trim(),
        sketch: cSketch,
        sketch_png_data_url: sketchPng,
        signatures: {
          outRenter: cOutRenter,
          outCompany: cOutCompany,
        },
        items: cItems.map((row, idx) => ({
          template_id: row.template_id,
          custom_label: row.custom_label,
          input_type: row.input_type,
          options: row.options,
          sort_order: idx + 1,
          value_out: row.value_out,
          note: row.note,
          photo_data_url: row.photo_data_url,
        })),
      };

      try {
        const res = await api.createChecklist(payload);
        if (printA4OnSave) {
          pendingAutoPrintRef.current = {
            reg: res.checklist.reg_number,
            date: res.checklist.hire_date,
          };
        }
        setNotice(`Checklist #${res.checklist.id} saved (${res.checklist.reg_number} — Out).`);
        setDetail(res.checklist);
        setReturnMode(false);
        setScreen('detail');
        void fetchChecklists();
        void loadReferenceData();
      } catch (err) {
        if (isLikelyNetworkError(err)) {
          const regLabel =
            cVehicleMode === 'existing'
              ? selectedVehicle?.reg_number ?? 'Vehicle'
              : cNewReg.trim().toUpperCase();
          enqueueOfflineEntry({
            kind: 'CHECKLIST_CREATE',
            summaryLabel: `Checklist OUT · ${regLabel} (${cHirerName.trim()})`,
            payload,
          });
          const optimistic: ChecklistSummary = {
            id: -Date.now(),
            trip_id: cTripId,
            vehicle_id: cVehicleId || 0,
            status: 'out',
            hirer_type: cHirerType,
            hirer_name: cHirerName.trim(),
            representative: cRepresentative.trim(),
            cell: cCell.trim(),
            car_model:
              cVehicleMode === 'existing'
                ? selectedVehicle?.make_model ?? ''
                : cNewMakeModel.trim(),
            vehicle_type:
              cVehicleMode === 'existing' ? selectedVehicle?.vehicle_type ?? '' : cNewType,
            colour: cColour.trim() || null,
            reg_number: regLabel,
            hire_date: isAdmin ? cHireDate : todayStr,
            days: daysNum,
            return_date: addDaysToIsoDate(isAdmin ? cHireDate : todayStr, daysNum),
            mileage_out: mileageNum,
            mileage_out_diff_warning: mileageDiffWarning,
            previous_closing_mileage: cExpectedMileage,
            mileage_in: null,
            next_service_mileage: nextServiceNum,
            datetime_in: null,
            fuel_type: cFuelType,
            fuel_out: cFuelOut || null,
            fuel_in: null,
            differences: [],
            notes: cNotes.trim(),
            created_by: currentUser.id,
            created_by_name: currentUser.full_name,
            returned_by: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          const cached = readCachedEntry<ChecklistSummary[]>(CACHE_KEYS.checklistsAll);
          const merged = [optimistic, ...(cached?.data ?? checklists)];
          writeCachedEntry(CACHE_KEYS.checklistsAll, merged);
          setChecklists(merged);
          setScreen('list');
          setNotice(
            `Saved checklist for ${regLabel} offline in local cache. It will sync automatically when connection returns.`
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save checklist.');
    } finally {
      setSubmittingCreate(false);
    }
  };

  const handleCompleteReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setError(null);

    const mileageInNum = Number(retMileageIn);
    if (!Number.isInteger(mileageInNum) || mileageInNum < detail.mileage_out) {
      setError(`Mileage In must be a whole number >= Mileage Out (${detail.mileage_out.toLocaleString()} km).`);
      return;
    }
    if (!retInRenter.name.trim() || !retInRenter.id_number.trim() || !retInRenter.signature_data_url) {
      setError('Checked In By (Renter / Driver) name, ID No., and signature are required.');
      return;
    }
    if (!retInCompany.name.trim() || !retInCompany.id_number.trim() || !retInCompany.signature_data_url) {
      setError('Checked In By (Company Rep) name, ID No., and signature are required.');
      return;
    }

    setSubmittingReturn(true);
    try {
      const sketchPng = await exportSketchPngDataUrl(retSketch);
      const nextSvc = retNextService.trim() ? Number(retNextService.trim()) : null;
      const payload: CompleteChecklistPayload = {
        mileage_in: mileageInNum,
        fuel_in: detail.fuel_type === 'ev' && !retFuelIn ? null : (retFuelIn || 'Full'),
        next_service_mileage: nextSvc !== null && Number.isInteger(nextSvc) ? nextSvc : null,
        colour: retColour.trim() || null,
        notes: retNotes.trim(),
        sketch: retSketch,
        sketch_png_data_url: sketchPng,
        signatures: {
          inRenter: retInRenter,
          inCompany: retInCompany,
        },
        items: retItems
          .filter((r) => typeof r.id === 'number')
          .map((r) => ({
            id: r.id!,
            value_in: r.value_in ?? makeDefaultValue(r.input_type, r.options),
            note: r.note,
            photo_data_url: r.photo_data_url,
          })),
      };

      try {
        const res = await api.completeChecklist(detail.id, payload);
        if (printA4OnSave) {
          pendingAutoPrintRef.current = {
            reg: res.checklist.reg_number,
            date: res.checklist.hire_date,
          };
        }
        setDetail(res.checklist);
        setReturnMode(false);
        setNotice(`Checklist #${res.checklist.id} completed and vehicle record updated.`);
        void fetchChecklists();
        void loadReferenceData();
      } catch (err) {
        if (isLikelyNetworkError(err)) {
          enqueueOfflineEntry({
            kind: 'CHECKLIST_COMPLETE',
            summaryLabel: `Complete Return · ${detail.reg_number} (${detail.hirer_name})`,
            payload: { checklist_id: detail.id, payload },
          });
          setReturnMode(false);
          setScreen('list');
          setNotice(
            `Return check-in for ${detail.reg_number} saved offline. It will sync automatically when connected.`
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete checklist return.');
    } finally {
      setSubmittingReturn(false);
    }
  };

  const openAmendModal = () => {
    if (!detail) return;
    setAmendHirerName(detail.hirer_name);
    setAmendRep(detail.representative);
    setAmendCell(detail.cell);
    setAmendColour(detail.colour ?? '');
    setAmendHireDate(detail.hire_date);
    setAmendDays(String(detail.days));
    setAmendNotes(detail.notes);
    setAmendReason('');
    setShowAmendModal(true);
  };

  const handleSaveAmend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setSavingAmend(true);
    setError(null);
    try {
      const res = await api.amendChecklist(detail.id, {
        hirer_name: amendHirerName.trim(),
        representative: amendRep.trim(),
        cell: amendCell.trim(),
        colour: amendColour.trim() || null,
        hire_date: amendHireDate,
        days: Number(amendDays) || 1,
        notes: amendNotes.trim(),
        reason: amendReason.trim(),
      });
      setDetail(res.checklist);
      setShowAmendModal(false);
      setNotice('Checklist amended and logged to audit trail.');
      void fetchChecklists();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not amend checklist.');
    } finally {
      setSavingAmend(false);
    }
  };

  const handleDeleteChecklist = async () => {
    if (!detail) return;
    setDeletingChecklist(true);
    setError(null);
    try {
      await api.deleteChecklist(detail.id);
      setConfirmDeleteOpen(false);
      setDetail(null);
      setScreen('list');
      setNotice(`Checklist #${detail.id} soft-deleted and logged to audit trail.`);
      void fetchChecklists();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete checklist.');
    } finally {
      setDeletingChecklist(false);
    }
  };

  const handleAddTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTplLabel.trim()) return;
    setSavingTpl(true);
    try {
      const options =
        newTplType === 'status_pair'
          ? ['Working', 'Faulty']
          : newTplType === 'yes_no'
            ? ['Yes', 'No']
            : newTplType === 'available_na'
              ? ['Available', 'N/A']
              : [];
      await api.createChecklistTemplate({
        label: newTplLabel.trim(),
        input_type: newTplType,
        options,
      });
      setNewTplLabel('');
      await loadReferenceData();
    } finally {
      setSavingTpl(false);
    }
  };

  const handleToggleTemplateActive = async (tpl: ChecklistItemTemplate) => {
    await api.updateChecklistTemplate(tpl.id, { active: !tpl.active });
    await loadReferenceData();
  };

  const renderItemControl = (
    row: DraftChecklistRow,
    side: 'out' | 'in',
    editable: boolean,
    onUpdateValue: (nextVal: ChecklistItemValue) => void
  ) => {
    const val =
      side === 'out'
        ? row.value_out
        : row.value_in ?? makeDefaultValue(row.input_type, row.options);

    if (!editable) {
      return (
        <span className="text-xs font-medium text-slate-700">
          {summarizeChecklistVal(val, row.input_type)}
        </span>
      );
    }

    if (row.input_type === 'tick_cross') {
      return (
        <div className="inline-flex gap-1.5">
          {[
            { id: 'tick', label: '✓ OK', activeCls: 'border-emerald-600 bg-emerald-600 text-white' },
            { id: 'cross', label: '✗ Issue', activeCls: 'border-red-600 bg-red-600 text-white' },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => onUpdateValue({ ...val, choice: opt.id })}
              className={`min-h-[34px] rounded-lg border px-2.5 text-xs font-bold ${
                val.choice === opt.id
                  ? opt.activeCls
                  : 'border-blue-200 bg-white text-slate-700 hover:bg-blue-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );
    }

    if (
      row.input_type === 'status_pair' ||
      row.input_type === 'yes_no' ||
      row.input_type === 'available_na'
    ) {
      const choices =
        row.options.length > 0
          ? row.options
          : row.input_type === 'yes_no'
            ? ['Yes', 'No']
            : row.input_type === 'available_na'
              ? ['Available', 'N/A']
              : ['Working', 'Faulty'];
      return (
        <div className="inline-flex flex-wrap gap-1.5">
          {choices.map((opt) => {
            const isBad = opt === 'Faulty' || opt === 'No';
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onUpdateValue({ ...val, choice: opt })}
                className={`min-h-[34px] rounded-lg border px-2.5 text-xs font-semibold ${
                  val.choice === opt
                    ? isBad
                      ? 'border-red-600 bg-red-600 text-white'
                      : 'border-cyan-600 bg-cyan-600 text-white'
                    : 'border-blue-200 bg-white text-slate-700 hover:bg-blue-50'
                }`}
              >
                {opt}
              </button>
            );
          })}
        </div>
      );
    }

    if (row.input_type === 'text') {
      return (
        <input
          type="text"
          value={val.text ?? ''}
          onChange={(e) => onUpdateValue({ ...val, text: e.target.value })}
          placeholder="Size / details..."
          className="cyan-glow-input min-h-[36px] w-full rounded-lg border border-blue-200 px-2.5 text-xs text-blue-950"
        />
      );
    }

    if (row.input_type === 'text_checkbox') {
      return (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {['Intact / Clear', 'Chipped / Cracked'].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onUpdateValue({ ...val, choice: opt })}
                className={`min-h-[32px] rounded-lg border px-2 text-xs font-semibold ${
                  val.choice === opt
                    ? opt.includes('Chipped')
                      ? 'border-red-600 bg-red-600 text-white'
                      : 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-blue-200 bg-white text-slate-700'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={val.text ?? ''}
            onChange={(e) => onUpdateValue({ ...val, text: e.target.value })}
            placeholder="Glass note..."
            className="cyan-glow-input min-h-[34px] w-full rounded-lg border border-blue-200 px-2.5 text-xs text-blue-950"
          />
        </div>
      );
    }

    if (row.input_type === 'multi_check') {
      const checked = val.checked ?? [];
      return (
        <div className="flex flex-wrap gap-2">
          {row.options.map((opt) => {
            const isOn = checked.includes(opt);
            return (
              <label
                key={opt}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                  isOn
                    ? 'border-cyan-500 bg-cyan-50 text-cyan-950'
                    : 'border-blue-200 bg-white text-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...checked, opt]
                      : checked.filter((x) => x !== opt);
                    onUpdateValue({ ...val, checked: next });
                  }}
                  className="h-3.5 w-3.5 accent-cyan-600"
                />
                <span>{opt}</span>
              </label>
            );
          })}
        </div>
      );
    }

    if (row.input_type === 'numbers') {
      const counts = val.counts ?? {};
      return (
        <div className="flex flex-wrap gap-3">
          {row.options.map((opt) => (
            <label key={opt} className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-950">
              <span>{opt}:</span>
              <input
                type="number"
                min={0}
                max={20}
                value={counts[opt] ?? 0}
                onChange={(e) =>
                  onUpdateValue({
                    ...val,
                    counts: { ...counts, [opt]: Math.max(0, Number(e.target.value) || 0) },
                  })
                }
                className="cyan-glow-input w-16 min-h-[34px] rounded-lg border border-blue-200 px-2 font-mono text-xs text-blue-950"
              />
            </label>
          ))}
        </div>
      );
    }

    if (row.input_type === 'expiry_checks') {
      const expiries = val.expiries ?? {};
      return (
        <div className="space-y-2">
          {row.options.map((opt) => {
            const entry = expiries[opt] ?? { checked: false, expiry_date: '' };
            const state = getExpiryState(entry.expiry_date, todayStr);
            return (
              <div key={opt} className="flex flex-wrap items-center gap-2 text-xs">
                <label className="inline-flex min-w-[96px] cursor-pointer items-center gap-1.5 font-semibold text-blue-950">
                  <input
                    type="checkbox"
                    checked={entry.checked}
                    onChange={(e) =>
                      onUpdateValue({
                        ...val,
                        expiries: {
                          ...expiries,
                          [opt]: { ...entry, checked: e.target.checked },
                        },
                      })
                    }
                    className="h-4 w-4 accent-cyan-600"
                  />
                  <span>{opt}</span>
                </label>
                <input
                  type="date"
                  aria-label={`${opt} expiry date`}
                  value={entry.expiry_date}
                  onChange={(e) =>
                    onUpdateValue({
                      ...val,
                      expiries: {
                        ...expiries,
                        [opt]: { ...entry, expiry_date: e.target.value },
                      },
                    })
                  }
                  className={`cyan-glow-input min-h-[34px] rounded-lg border px-2 font-mono text-xs ${
                    state === 'EXPIRED'
                      ? 'border-red-400 bg-red-50 text-red-900'
                      : state === 'SOON'
                        ? 'border-amber-400 bg-amber-50 text-amber-900'
                        : 'border-blue-200 bg-white text-blue-950'
                  }`}
                />
                {state === 'EXPIRED' && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-800">
                    Expired
                  </span>
                )}
                {state === 'SOON' && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900">
                    Expiring &le;30d
                  </span>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    return null;
  };

  const renderSectionFRows = (
    rows: DraftChecklistRow[],
    mode: 'create' | 'return',
    onUpdateRow: (localKey: string, updater: (prev: DraftChecklistRow) => DraftChecklistRow) => void
  ) => (
    <div className="space-y-3 rounded-2xl border border-blue-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-blue-950">Section F — 25-Point Vehicle Inspection</h3>
          <p className="text-xs text-slate-600">
            {mode === 'create'
              ? 'Complete all check-out inspection rows. Add optional row notes or photos where needed.'
              : 'OUT values stay locked for comparison. Record every Check-In value on the right.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddRow((v) => !v)}
          className="cyan-glow-outline inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
        >
          <Plus className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
          <span>Add row</span>
        </button>
      </div>

      {showAddRow && (
        <div className="rounded-xl border border-cyan-300 bg-cyan-50/60 p-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-blue-950">Custom Row Name</label>
            <input
              type="text"
              value={customRowLabel}
              onChange={(e) => setCustomRowLabel(e.target.value)}
              placeholder="e.g. Tow Bar Pin / Roof Rack"
              className="cyan-glow-input mt-1 block w-full min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-sm text-blue-950"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-blue-950">Input Type</label>
            <select
              value={customRowType}
              onChange={(e) => setCustomRowType(e.target.value as ChecklistInputType)}
              className="cyan-glow-input mt-1 block min-h-[40px] rounded-lg border border-blue-200 bg-white px-2.5 text-sm text-blue-950"
            >
              {INPUT_TYPE_LABELS.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() =>
              mode === 'create' ? handleAddInlineRowCreate() : void handleAddInlineRowReturn()
            }
            className="cyan-glow-btn min-h-[40px] rounded-lg px-4 text-xs font-semibold"
          >
            Insert Row
          </button>
        </div>
      )}

      <div className="divide-y divide-blue-100 rounded-xl border border-blue-100 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-slate-600">
            Loading 25-point vehicle inspection items...
          </div>
        ) : (
          rows.map((row, idx) => {
          const hasExtras = Boolean(row.note || row.photo_data_url || expandedRowExtras[row.localKey]);
          return (
            <div key={row.localKey} className="p-3 sm:px-4 space-y-2 hover:bg-blue-50/20">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-2 min-w-0 lg:w-64 shrink-0">
                  <span className="mt-0.5 font-mono text-xs font-bold text-slate-400 w-6 shrink-0">
                    {idx + 1}.
                  </span>
                  <span className="text-sm font-semibold text-blue-950">{row.custom_label}</span>
                </div>

                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1">
                    {mode === 'return' && (
                      <div className="text-[11px] font-bold uppercase text-red-700 mb-0.5">OUT (Locked)</div>
                    )}
                    {renderItemControl(row, 'out', mode === 'create', (nextVal) =>
                      onUpdateRow(row.localKey, (p) => ({ ...p, value_out: nextVal }))
                    )}
                  </div>

                  {mode === 'return' && (
                    <div className="flex-1 sm:border-l sm:border-blue-100 sm:pl-3">
                      <div className="text-[11px] font-bold uppercase text-blue-700 mb-0.5">IN (Return)</div>
                      {renderItemControl(row, 'in', true, (nextVal) =>
                        onUpdateRow(row.localKey, (p) => ({ ...p, value_in: nextVal }))
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRowExtras((prev) => ({
                          ...prev,
                          [row.localKey]: !prev[row.localKey],
                        }))
                      }
                      className="min-h-[34px] rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-medium text-blue-900 hover:bg-blue-50"
                    >
                      {hasExtras ? 'Hide Note/Photo' : '+ Note / Photo'}
                    </button>
                  </div>
                </div>
              </div>

              {hasExtras && (
                <div className="ml-6 flex flex-col gap-2 sm:flex-row sm:items-center rounded-xl border border-blue-100 bg-blue-50/30 p-2.5">
                  <input
                    type="text"
                    value={row.note}
                    onChange={(e) =>
                      onUpdateRow(row.localKey, (p) => ({ ...p, note: e.target.value }))
                    }
                    placeholder="Row condition note..."
                    className="cyan-glow-input flex-1 min-h-[36px] rounded-lg border border-blue-200 bg-white px-2.5 text-xs text-blue-950"
                  />
                  <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900 hover:bg-blue-50">
                    <Camera className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                    <span>{row.photo_data_url ? 'Change Photo' : 'Attach Photo'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        try {
                          const dataUrl = await compressPhotoFile(f);
                          onUpdateRow(row.localKey, (p) => ({ ...p, photo_data_url: dataUrl }));
                        } catch {
                          setError('Could not attach photo for this row.');
                        }
                      }}
                    />
                  </label>
                  {row.photo_data_url && (
                    <div className="flex items-center gap-2">
                      <img
                        src={row.photo_data_url}
                        alt={`${row.custom_label} attachment`}
                        className="h-10 w-10 rounded-lg border border-blue-200 object-cover"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateRow(row.localKey, (p) => ({ ...p, photo_data_url: null }))
                        }
                        className="text-xs font-semibold text-red-700 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
        )}
      </div>
    </div>
  );

  // ==================== CREATE CHECKLIST SCREEN ====================
  if (screen === 'create') {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setScreen('list')}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Checklists</span>
          </button>
          <span className="text-xs font-semibold uppercase tracking-wide text-cyan-800 bg-cyan-50 border border-cyan-200 rounded-lg px-3 py-1.5">
            New Vehicle Check-Out Slip
          </span>
        </div>

        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Digital Vehicle Checklist</h1>
          <p className="mt-1 text-sm text-slate-600">
            Replaces the paper Vehicle Checklist / Car Check-In Slip. Works online or offline.
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
            {error}
          </div>
        )}

        <form onSubmit={handleCreateSubmit} className="space-y-5">
          {/* Section A */}
          <div className="rounded-2xl border border-blue-200 bg-white p-4 sm:p-5 space-y-3">
            <h2 className="text-base font-bold text-blue-950">Section A — Hirer / Owner Details</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="chk-hirer-type" className="block text-xs font-semibold text-blue-950">
                  Hirer Type
                </label>
                <select
                  id="chk-hirer-type"
                  value={cHirerType}
                  onChange={(e) => setCHirerType(e.target.value as ChecklistHirerType)}
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                >
                  <option value="renter">Renter&apos;s Name</option>
                  <option value="owner">Owner&apos;s Name</option>
                </select>
              </div>
              <div>
                <label htmlFor="chk-hirer-name" className="block text-xs font-semibold text-blue-950">
                  {cHirerType === 'owner' ? "Owner's Name *" : "Renter's Name *"}
                </label>
                <input
                  id="chk-hirer-name"
                  type="text"
                  required
                  value={cHirerName}
                  onChange={(e) => setCHirerName(e.target.value)}
                  placeholder="Full name or company"
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                />
              </div>
              <div>
                <label htmlFor="chk-rep" className="block text-xs font-semibold text-blue-950">
                  Representative
                </label>
                <input
                  id="chk-rep"
                  type="text"
                  value={cRepresentative}
                  onChange={(e) => setCRepresentative(e.target.value)}
                  placeholder="Optional contact / driver"
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                />
              </div>
              <div>
                <label htmlFor="chk-cell" className="block text-xs font-semibold text-blue-950">
                  Cell *
                </label>
                <input
                  id="chk-cell"
                  type="tel"
                  required
                  value={cCell}
                  onChange={(e) => setCCell(e.target.value)}
                  placeholder="e.g. +263 77..."
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
              </div>
            </div>
          </div>

          {/* Section B */}
          <div className="rounded-2xl border border-blue-200 bg-white p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-bold text-blue-950">Section B — Vehicle Selection</h2>
              <button
                type="button"
                onClick={() => {
                  if (cVehicleMode === 'existing') {
                    setCVehicleMode('new');
                    setCVehicleId(0);
                    setCExpectedMileage(null);
                  } else if (vehicles[0]) {
                    applyVehicleSelection(vehicles[0]);
                  }
                }}
                className="cyan-glow-outline inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-cyan-300 bg-cyan-50/70 px-3 text-xs font-semibold text-blue-950"
              >
                <Plus className="h-3.5 w-3.5 text-cyan-700" aria-hidden="true" />
                <span>{cVehicleMode === 'existing' ? '+ Add new vehicle' : 'Pick from Directory'}</span>
              </button>
            </div>

            {cVehicleMode === 'existing' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="chk-veh-pick" className="block text-xs font-semibold text-blue-950">
                    Car Model / Type *
                  </label>
                  <input
                    type="search"
                    value={vehicleSearch}
                    onChange={(e) => setVehicleSearch(e.target.value)}
                    placeholder="Filter vehicle list..."
                    className="cyan-glow-input mt-1 mb-1.5 block w-full min-h-[36px] rounded-lg border border-blue-200 px-2.5 text-xs text-blue-950"
                  />
                  <select
                    id="chk-veh-pick"
                    value={cVehicleId}
                    onChange={(e) => {
                      const v = vehicles.find((x) => x.id === Number(e.target.value));
                      if (v) applyVehicleSelection(v);
                    }}
                    className="cyan-glow-input block w-full min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    {filteredVehiclesForPicker.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.reg_number} — {v.make_model} ({v.vehicle_type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="chk-colour" className="block text-xs font-semibold text-blue-950">
                    Colour
                  </label>
                  <input
                    id="chk-colour"
                    type="text"
                    value={cColour}
                    onChange={(e) => setCColour(e.target.value)}
                    placeholder="e.g. White / Silver"
                    className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label htmlFor="chk-reg-ro" className="block text-xs font-semibold text-blue-950">
                    Reg Number (from Directory)
                  </label>
                  <input
                    id="chk-reg-ro"
                    type="text"
                    readOnly
                    value={selectedVehicle?.reg_number ?? ''}
                    className="mt-1 block w-full min-h-[44px] rounded-xl border border-slate-200 bg-slate-100 px-3 font-mono font-bold text-sm text-blue-950"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-cyan-200 bg-cyan-50/40 p-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Vehicle Type *</label>
                  <select
                    value={cNewType}
                    onChange={(e) => {
                      setCNewType(e.target.value);
                      setCSketch((prev) => ({
                        ...prev,
                        vehicle_kind: inferSketchKind(e.target.value, cNewMakeModel),
                      }));
                    }}
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  >
                    {VEHICLE_TYPES.map((vt) => (
                      <option key={vt} value={vt}>
                        {vt}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Make &amp; Model *</label>
                  <input
                    type="text"
                    required
                    value={cNewMakeModel}
                    onChange={(e) => {
                      setCNewMakeModel(e.target.value);
                      setCSketch((prev) => ({
                        ...prev,
                        vehicle_kind: inferSketchKind(cNewType, e.target.value),
                      }));
                    }}
                    placeholder="e.g. Toyota Fortuner"
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Reg Number *</label>
                  <input
                    type="text"
                    required
                    value={cNewReg}
                    onChange={(e) => setCNewReg(e.target.value)}
                    placeholder="e.g. AGD 4812"
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 font-mono uppercase text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Colour</label>
                  <input
                    type="text"
                    value={cColour}
                    onChange={(e) => setCColour(e.target.value)}
                    placeholder="e.g. Silver"
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Section C, D, E */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Section C */}
            <div className="rounded-2xl border border-blue-200 bg-white p-4 space-y-3">
              <h2 className="text-base font-bold text-blue-950">Section C — Dates</h2>
              <div>
                <label className="block text-xs font-semibold text-blue-950">
                  Date Out {isAdmin ? '(Admin can edit)' : '(Today locked)'}
                </label>
                <input
                  type="date"
                  value={cHireDate}
                  readOnly={!isAdmin}
                  onChange={(e) => setCHireDate(e.target.value)}
                  className={`mt-1 block w-full min-h-[42px] rounded-xl border px-3 font-mono text-sm ${
                    isAdmin
                      ? 'cyan-glow-input border-blue-200 bg-white text-blue-950'
                      : 'border-slate-200 bg-slate-100 text-slate-600'
                  }`}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Days *</label>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    required
                    value={cDays}
                    onChange={(e) => setCDays(e.target.value)}
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Return Date</label>
                  <input
                    type="date"
                    readOnly
                    value={cReturnDate}
                    className="mt-1 block w-full min-h-[42px] rounded-xl border border-slate-200 bg-slate-100 px-3 font-mono text-sm text-slate-600"
                  />
                </div>
              </div>
            </div>

            {/* Section D */}
            <div className="rounded-2xl border border-blue-200 bg-white p-4 space-y-3">
              <h2 className="text-base font-bold text-blue-950">Section D — Mileage</h2>
              <div>
                <label className="block text-xs font-semibold text-blue-950">Mileage Out (km) *</label>
                <input
                  type="number"
                  min={0}
                  required
                  value={cMileageOut}
                  onChange={(e) => setCMileageOut(e.target.value)}
                  className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
                {mileageDiffWarning && (
                  <p className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900">
                    Differs from last closing mileage ({cExpectedMileage?.toLocaleString()} km) — this change will be audited and alerted.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-blue-950">Mileage In</label>
                <input
                  type="text"
                  disabled
                  value="Locked until Complete Return"
                  className="mt-1 block w-full min-h-[42px] rounded-xl border border-slate-200 bg-slate-100 px-3 text-xs text-slate-500"
                />
              </div>
            </div>

            {/* Section E */}
            <div className="rounded-2xl border border-blue-200 bg-white p-4 space-y-3">
              <h2 className="text-base font-bold text-blue-950">Section E — Service &amp; Fuel</h2>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Next Service (km)</label>
                  <input
                    type="number"
                    min={0}
                    value={cNextService}
                    onChange={(e) => setCNextService(e.target.value)}
                    placeholder="Optional"
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Fuel Type</label>
                  <select
                    value={cFuelType}
                    onChange={(e) => setCFuelType(e.target.value as VehicleFuelType)}
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-2.5 text-sm text-blue-950 capitalize"
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
                <label className="block text-xs font-semibold text-blue-950">
                  {cFuelType === 'ev' ? 'Battery Level (optional)' : 'Fuel Out Level *'}
                </label>
                <select
                  value={cFuelOut}
                  onChange={(e) => setCFuelOut(e.target.value as FuelLevel | '')}
                  className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                >
                  {cFuelType === 'ev' && <option value="">Optional / Not recorded</option>}
                  {FUEL_LEVELS.map((fl) => (
                    <option key={fl} value={fl}>
                      {fl}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Section F */}
          {renderSectionFRows(cItems, 'create', (localKey, updater) =>
            setCItems((prev) => prev.map((r) => (r.localKey === localKey ? updater(r) : r)))
          )}

          {/* Sketch */}
          <VehicleConditionSketch
            value={cSketch}
            onChange={setCSketch}
            activeLayer="out"
            canChangeKind
          />

          {/* Notes */}
          <div className="rounded-2xl border border-blue-200 bg-white p-4">
            <label htmlFor="chk-notes" className="block text-sm font-bold text-blue-950">
              General Notes (optional)
            </label>
            <textarea
              id="chk-notes"
              rows={2}
              value={cNotes}
              onChange={(e) => setCNotes(e.target.value)}
              placeholder="Any general observations or instructions..."
              className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
            />
          </div>

          {/* Section G */}
          <ChecklistSectionG
            declarationText={buildDeclarationText(companyName)}
            signatures={{
              outRenter: cOutRenter,
              outCompany: cOutCompany,
              inRenter: null,
              inCompany: null,
            }}
            mode="create"
            onChangeOutRenter={setCOutRenter}
            onChangeOutCompany={setCOutCompany}
          />

          <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/70 px-4 py-3 text-sm font-medium text-blue-950">
            <input
              type="checkbox"
              checked={printA4OnSave}
              onChange={(e) => setPrintA4OnSave(e.target.checked)}
              className="h-4 w-4 accent-cyan-600"
            />
            <span>
              Print A4 by default on save (
              <span className="font-mono font-semibold text-cyan-900">
                {formatChecklistPrintTitle(
                  cVehicleMode === 'existing' ? selectedVehicle?.reg_number ?? '' : cNewReg,
                  isAdmin ? cHireDate : todayStr
                )}
              </span>
              )
            </span>
          </label>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={submittingCreate}
              className="cyan-glow-btn min-h-[50px] flex-1 rounded-xl px-6 text-base font-bold disabled:opacity-60"
            >
              {submittingCreate
                ? 'Saving Checklist...'
                : printA4OnSave
                  ? 'Save & Print A4 Slip'
                  : 'Save Check-Out Slip'}
            </button>
            <button
              type="button"
              onClick={() => setScreen('list')}
              className="cyan-glow-outline min-h-[50px] rounded-xl border border-blue-200 bg-white px-5 text-base font-medium text-blue-900"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ==================== DETAIL & COMPLETE RETURN SCREEN ====================
  if (screen === 'detail') {
    return (
      <div className="space-y-6">
        <div className="no-print flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              setScreen('list');
              setDetail(null);
              setReturnMode(false);
            }}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Checklists</span>
          </button>

          {detail && (
            <div className="flex flex-wrap items-center gap-2">
              {detail.status === 'out' && !returnMode && (
                <button
                  type="button"
                  onClick={() => beginReturnFlow(detail)}
                  className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  <span>Complete Return</span>
                </button>
              )}
              <a
                href={api.getChecklistPdfUrl(detail.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-3.5 text-sm font-semibold text-blue-900"
              >
                <Download className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                <span>PDF</span>
              </a>
              <button
                type="button"
                onClick={() => printChecklistA4(detail.reg_number, detail.hire_date)}
                title={formatChecklistPrintTitle(detail.reg_number, detail.hire_date)}
                className={`${
                  detail.status === 'completed' || returnMode
                    ? 'cyan-glow-btn'
                    : 'cyan-glow-outline border border-blue-200 bg-white text-blue-900'
                } inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold`}
              >
                <Printer
                  className={`h-4 w-4 ${
                    detail.status === 'completed' || returnMode ? '' : 'text-cyan-600'
                  }`}
                  aria-hidden="true"
                />
                <span>Print A4</span>
              </button>
              {isAdmin && !returnMode && (
                <>
                  <button
                    type="button"
                    onClick={openAmendModal}
                    className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-3.5 text-sm font-semibold text-blue-900"
                  >
                    <Edit3 className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                    <span>Amend</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteOpen(true)}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-red-200 bg-red-50 px-3.5 text-sm font-semibold text-red-800 hover:bg-red-100"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span>Delete</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {notice && (
          <div role="status" className="no-print rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="no-print rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
            {error}
          </div>
        )}

        {detailLoading || !detail ? (
          <div className="rounded-2xl border border-blue-200 bg-white p-6 text-base text-slate-600">
            Loading checklist slip...
          </div>
        ) : returnMode ? (
          <form onSubmit={handleCompleteReturnSubmit} className="space-y-5">
            <div className="rounded-2xl border border-cyan-300 bg-cyan-50/70 p-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-xl font-bold text-blue-950">
                  Complete Return — {detail.reg_number} ({detail.car_model})
                </h2>
                <p className="text-xs text-slate-600">
                  Hirer: {detail.hirer_name} · Mileage Out: {detail.mileage_out.toLocaleString()} km · Fuel Out: {detail.fuel_out ?? 'N/A'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReturnMode(false)}
                className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-900"
              >
                Cancel Return
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 rounded-2xl border border-blue-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="block text-xs font-semibold text-blue-950">
                  Mileage In (km) * (&ge; {detail.mileage_out.toLocaleString()})
                </label>
                <input
                  type="number"
                  required
                  min={detail.mileage_out}
                  value={retMileageIn}
                  onChange={(e) => setRetMileageIn(e.target.value)}
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-blue-950">
                  {detail.fuel_type === 'ev' ? 'Battery In (optional)' : 'Fuel In *'}
                </label>
                <select
                  value={retFuelIn}
                  onChange={(e) => setRetFuelIn(e.target.value as FuelLevel | '')}
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 bg-white px-3 text-sm text-blue-950"
                >
                  {detail.fuel_type === 'ev' && <option value="">Not recorded</option>}
                  {FUEL_LEVELS.map((fl) => (
                    <option key={fl} value={fl}>
                      {fl}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-blue-950">Next Service (km)</label>
                <input
                  type="number"
                  min={0}
                  value={retNextService}
                  onChange={(e) => setRetNextService(e.target.value)}
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 font-mono text-sm text-blue-950"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-blue-950">Colour</label>
                <input
                  type="text"
                  value={retColour}
                  onChange={(e) => setRetColour(e.target.value)}
                  className="cyan-glow-input mt-1 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3 text-sm text-blue-950"
                />
              </div>
            </div>

            {renderSectionFRows(retItems, 'return', (localKey, updater) =>
              setRetItems((prev) => prev.map((r) => (r.localKey === localKey ? updater(r) : r)))
            )}

            <VehicleConditionSketch
              value={retSketch}
              onChange={setRetSketch}
              activeLayer="in"
              canChangeKind={false}
            />

            <div className="rounded-2xl border border-blue-200 bg-white p-4">
              <label className="block text-sm font-bold text-blue-950">Return Notes</label>
              <textarea
                rows={2}
                value={retNotes}
                onChange={(e) => setRetNotes(e.target.value)}
                placeholder="Observations upon vehicle return..."
                className="cyan-glow-input mt-1.5 block w-full rounded-xl border border-blue-200 p-3 text-sm text-blue-950"
              />
            </div>

            <ChecklistSectionG
              declarationText={detail.declaration_text}
              signatures={{
                outRenter: detail.signatures.outRenter,
                outCompany: detail.signatures.outCompany,
                inRenter: retInRenter,
                inCompany: retInCompany,
              }}
              mode="return"
              onChangeInRenter={setRetInRenter}
              onChangeInCompany={setRetInCompany}
            />

            <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-cyan-200 bg-cyan-50/70 px-4 py-3 text-sm font-medium text-blue-950">
              <input
                type="checkbox"
                checked={printA4OnSave}
                onChange={(e) => setPrintA4OnSave(e.target.checked)}
                className="h-4 w-4 accent-cyan-600"
              />
              <span>
                Print A4 by default on save (
                <span className="font-mono font-semibold text-cyan-900">
                  {formatChecklistPrintTitle(detail.reg_number, detail.hire_date)}
                </span>
                )
              </span>
            </label>

            <button
              type="submit"
              disabled={submittingReturn}
              className="cyan-glow-btn min-h-[50px] w-full rounded-xl px-6 text-base font-bold disabled:opacity-60"
            >
              {submittingReturn
                ? 'Completing Return...'
                : printA4OnSave
                  ? 'Complete Return & Print A4'
                  : 'Complete Return & Close Checklist'}
            </button>
          </form>
        ) : (
          <div className="space-y-5">
            {/* Printable Header */}
            <div className="rounded-2xl border border-blue-200 bg-white p-5 space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between border-b border-blue-100 pb-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-cyan-800">
                    {companyName} · Digital Vehicle Checklist #{detail.id}
                  </div>
                  <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">
                    {detail.reg_number} — {detail.car_model}
                  </h1>
                  <div className="mt-1 text-xs text-slate-600">
                    {detail.vehicle_type}
                    {detail.colour ? ` · ${detail.colour}` : ''}
                    {detail.trip_id ? ` · Linked Trip #${detail.trip_id}` : ''}
                  </div>
                </div>
                <div className="flex flex-col sm:items-end gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-bold ${
                      detail.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : 'bg-amber-50 text-amber-900 border border-amber-300'
                    }`}
                  >
                    {detail.status === 'completed' ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Completed (returned)</span>
                      </>
                    ) : (
                      <>
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Out (open)</span>
                      </>
                    )}
                  </span>
                  {onOpenVehicle && detail.vehicle_id > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenVehicle(detail.vehicle_id)}
                      className="no-print text-xs font-semibold text-blue-700 hover:underline"
                    >
                      View Vehicle Record &rarr;
                    </button>
                  )}
                </div>
              </div>

              {/* Differences highlight box when completed */}
              {detail.differences.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-bold text-amber-950">
                    <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden="true" />
                    <span>Differences Detected Between Check-Out &amp; Check-In ({detail.differences.length})</span>
                  </div>
                  <ul className="space-y-1 text-xs text-amber-950">
                    {detail.differences.map((diff, i) => (
                      <li key={i} className="font-medium">
                        • <span className="font-bold">{diff.label}:</span> OUT ({diff.out_summary}) &rarr; IN ({diff.in_summary})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Sections A–E Read-Only Summary Grid */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                <div className="rounded-xl border border-blue-100 bg-blue-50/30 p-3 space-y-1">
                  <div className="font-bold text-blue-900 uppercase">Section A — Hirer</div>
                  <div>
                    <span className="text-slate-500">
                      {detail.hirer_type === 'owner' ? "Owner's Name:" : "Renter's Name:"}
                    </span>{' '}
                    <span className="font-semibold text-blue-950">{detail.hirer_name}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Rep:</span> {detail.representative || '—'}
                  </div>
                  <div>
                    <span className="text-slate-500">Cell:</span>{' '}
                    <span className="font-mono">{detail.cell}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-blue-100 bg-blue-50/30 p-3 space-y-1">
                  <div className="font-bold text-blue-900 uppercase">Section C — Dates</div>
                  <div>
                    <span className="text-slate-500">Hire Date:</span>{' '}
                    <span className="font-mono font-semibold">{detail.hire_date}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Days:</span>{' '}
                    <span className="font-mono font-semibold">{detail.days}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Return Date:</span>{' '}
                    <span className="font-mono font-semibold">{detail.return_date}</span>
                  </div>
                </div>

                <div className="rounded-xl border border-blue-100 bg-blue-50/30 p-3 space-y-1">
                  <div className="font-bold text-blue-900 uppercase">Section D — Mileage</div>
                  <div>
                    <span className="text-slate-500">Out:</span>{' '}
                    <span className="font-mono font-semibold">{detail.mileage_out.toLocaleString()} km</span>
                  </div>
                  <div>
                    <span className="text-slate-500">In:</span>{' '}
                    <span className="font-mono font-semibold">
                      {detail.mileage_in !== null ? `${detail.mileage_in.toLocaleString()} km` : 'Still out'}
                    </span>
                  </div>
                  {detail.mileage_in !== null && detail.mileage_in >= detail.mileage_out && (
                    <div>
                      <span className="text-slate-500">Distance:</span>{' '}
                      <span className="font-mono font-semibold text-blue-950">
                        +{(detail.mileage_in - detail.mileage_out).toLocaleString()} km
                      </span>
                    </div>
                  )}
                  {detail.mileage_out_diff_warning && (
                    <div className="text-[11px] font-semibold text-amber-800">
                      Out km differed from {detail.previous_closing_mileage?.toLocaleString()} km
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-blue-100 bg-blue-50/30 p-3 space-y-1">
                  <div className="font-bold text-blue-900 uppercase">Section E — Service &amp; Fuel</div>
                  <div>
                    <span className="text-slate-500">Type:</span>{' '}
                    <span className="uppercase font-semibold">{detail.fuel_type}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Fuel Out / In:</span>{' '}
                    <span className="font-mono font-semibold">
                      {detail.fuel_out ?? 'N/A'} / {detail.fuel_in ?? '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Next Service:</span>{' '}
                    <span className="font-mono">
                      {detail.next_service_mileage ? `${detail.next_service_mileage.toLocaleString()} km` : '—'}
                    </span>
                  </div>
                  {detail.datetime_in && (
                    <div>
                      <span className="text-slate-500">Checked In:</span>{' '}
                      <span className="font-mono">{formatHarareTime(detail.datetime_in)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Section F Table Read-Only */}
            <div className="rounded-2xl border border-blue-200 bg-white overflow-hidden">
              <div className="border-b border-blue-100 bg-blue-50/60 px-4 py-3 text-sm font-bold text-blue-950">
                Section F — Inspection Checklist ({detail.items.length} items)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-blue-100 bg-slate-50 text-blue-900">
                      <th className="py-2 px-3 w-10">#</th>
                      <th className="py-2 px-3">Item</th>
                      <th className="py-2 px-3">Out</th>
                      <th className="py-2 px-3">In</th>
                      <th className="py-2 px-3">Notes / Photo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-100">
                    {detail.items.map((it, idx) => (
                      <tr key={it.id}>
                        <td className="py-2 px-3 font-mono text-slate-400">{idx + 1}</td>
                        <td className="py-2 px-3 font-semibold text-blue-950">{it.custom_label}</td>
                        <td className="py-2 px-3">{summarizeChecklistVal(it.value_out, it.input_type)}</td>
                        <td className="py-2 px-3">{summarizeChecklistVal(it.value_in, it.input_type)}</td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            {it.note && <span className="text-slate-700">{it.note}</span>}
                            {it.photo_data_url && (
                              <img
                                src={it.photo_data_url}
                                alt={`${it.custom_label} photo`}
                                className="h-9 w-9 rounded border border-blue-200 object-cover"
                              />
                            )}
                            {!it.note && !it.photo_data_url && <span className="text-slate-400">—</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <VehicleConditionSketch
              value={detail.sketch}
              activeLayer={detail.status === 'completed' ? 'in' : 'out'}
              readOnly
            />

            {detail.notes && (
              <div className="rounded-2xl border border-blue-200 bg-white p-4 text-sm">
                <div className="font-bold text-blue-950">General Notes</div>
                <p className="mt-1 text-slate-700">{detail.notes}</p>
              </div>
            )}

            <ChecklistSectionG
              declarationText={detail.declaration_text}
              signatures={detail.signatures}
              mode="view"
            />
          </div>
        )}

        {/* Admin Amend Modal */}
        {showAmendModal && detail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
            <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-8 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-display text-lg font-bold text-blue-950">
                  Amend Checklist #{detail.id}
                </h2>
                <button
                  type="button"
                  onClick={() => setShowAmendModal(false)}
                  aria-label="Close"
                  className="p-2 text-slate-500"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <form onSubmit={handleSaveAmend} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Hirer Name</label>
                  <input
                    type="text"
                    required
                    value={amendHirerName}
                    onChange={(e) => setAmendHirerName(e.target.value)}
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-blue-950">Representative</label>
                    <input
                      type="text"
                      value={amendRep}
                      onChange={(e) => setAmendRep(e.target.value)}
                      className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-blue-950">Cell</label>
                    <input
                      type="text"
                      required
                      value={amendCell}
                      onChange={(e) => setAmendCell(e.target.value)}
                      className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-semibold text-blue-950">Colour</label>
                    <input
                      type="text"
                      value={amendColour}
                      onChange={(e) => setAmendColour(e.target.value)}
                      className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-blue-950">Hire Date</label>
                    <input
                      type="date"
                      value={amendHireDate}
                      onChange={(e) => setAmendHireDate(e.target.value)}
                      className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-2 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-blue-950">Days</label>
                    <input
                      type="number"
                      min={1}
                      value={amendDays}
                      onChange={(e) => setAmendDays(e.target.value)}
                      className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 font-mono text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Notes</label>
                  <textarea
                    rows={2}
                    value={amendNotes}
                    onChange={(e) => setAmendNotes(e.target.value)}
                    className="cyan-glow-input mt-1 block w-full rounded-xl border border-blue-200 p-2.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-blue-950">Audit Reason *</label>
                  <input
                    type="text"
                    required
                    minLength={3}
                    value={amendReason}
                    onChange={(e) => setAmendReason(e.target.value)}
                    placeholder="Reason for Admin amendment..."
                    className="cyan-glow-input mt-1 block w-full min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
                  />
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={savingAmend}
                    className="cyan-glow-btn flex-1 min-h-[44px] rounded-xl text-sm font-semibold"
                  >
                    {savingAmend ? 'Saving...' : 'Save Amendment'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAmendModal(false)}
                    className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 px-4 text-sm font-medium"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Admin Soft Delete Confirmation Modal */}
        {confirmDeleteOpen && detail && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm rounded-2xl border border-red-200 bg-white p-6 shadow-xl space-y-4">
              <h2 className="font-display text-lg font-bold text-red-900">
                Delete Checklist #{detail.id}?
              </h2>
              <p className="text-sm text-slate-600">
                This soft-deletes the checklist for {detail.reg_number} ({detail.hirer_name}) and records an immutable audit entry.
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={deletingChecklist}
                  onClick={() => void handleDeleteChecklist()}
                  className="flex-1 min-h-[44px] rounded-xl bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {deletingChecklist ? 'Deleting...' : 'Confirm Delete'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteOpen(false)}
                  className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 px-4 text-sm font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================== CHECKLISTS LIST SCREEN ====================
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Digital Vehicle Checklist</h1>
          <p className="mt-1 text-base text-slate-600">
            Track vehicle condition at check-out and check-in, signatures, and return differences.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowTemplateModal(true)}
              className="cyan-glow-outline inline-flex min-h-[46px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
            >
              <Settings2 className="h-4 w-4 text-cyan-600" aria-hidden="true" />
              <span>Template Rows</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => startNewChecklist(null)}
            className="cyan-glow-btn inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold whitespace-nowrap"
          >
            <FilePlus2 className="h-5 w-5" aria-hidden="true" />
            <span>New Checklist</span>
          </button>
        </div>
      </div>

      {usingCache && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900 flex items-center gap-2.5">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Offline mode — showing cached checklists
            {cacheUpdatedAt ? ` (last updated ${formatHarareTime(cacheUpdatedAt)} CAT)` : ''}. New slips and returns save locally and sync on reconnect.
          </span>
        </div>
      )}

      {notice && (
        <div role="status" className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          {error}
        </div>
      )}

      {/* Status Chips & Search */}
      <div className="rounded-2xl border border-blue-200/80 bg-white p-4 space-y-3 shadow-xs">
        <div className="flex flex-wrap gap-2">
          {[
            { id: '' as const, label: 'All Checklists' },
            { id: 'out' as const, label: 'Out (open)' },
            { id: 'completed' as const, label: 'Completed (returned)' },
          ].map((chip) => (
            <button
              key={chip.id || 'all'}
              type="button"
              onClick={() => setStatusFilter(chip.id)}
              className={`min-h-[40px] rounded-xl border px-4 text-sm font-semibold transition-all ${
                statusFilter === chip.id
                  ? 'cyan-glow-active'
                  : 'border-blue-200 bg-blue-50/50 text-blue-900 hover:bg-blue-100/60'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(searchInput.trim());
          }}
          className="flex flex-col gap-3 sm:flex-row"
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-cyan-600"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search reg number, renter/owner name, or date (YYYY-MM-DD)..."
              className="cyan-glow-input block w-full min-h-[46px] rounded-xl border border-blue-200 pl-11 pr-4 text-sm text-blue-950"
            />
          </div>
          <button
            type="submit"
            className="cyan-glow-outline min-h-[46px] rounded-xl border border-blue-200 bg-blue-50/70 px-5 text-sm font-semibold text-blue-950"
          >
            Search
          </button>
        </form>
      </div>

      {/* Checklist List */}
      <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
        {loading ? (
          <div className="p-6 text-base text-slate-500">Loading checklists...</div>
        ) : checklists.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <ClipboardCheck className="mx-auto h-10 w-10 text-cyan-600/70" aria-hidden="true" />
            <p className="text-base text-slate-600">No checklists match your filter yet.</p>
            <button
              type="button"
              onClick={() => startNewChecklist(null)}
              className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-5 text-sm font-semibold"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Create First Checklist</span>
            </button>
          </div>
        ) : (
          <div className="divide-y divide-blue-100">
            {checklists.map((c) => (
              <div
                key={c.id}
                onClick={() => void openDetail(c.id)}
                className="p-4 sm:px-5 cursor-pointer hover:bg-cyan-50/40 transition-colors flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-base font-bold text-blue-950">{c.reg_number}</span>
                    <span aria-hidden="true" className="text-cyan-500">·</span>
                    <span className="text-sm font-semibold text-slate-800">{c.car_model}</span>
                    {c.colour && (
                      <span className="text-xs text-slate-500">({c.colour})</span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-0.5 text-xs font-bold ${
                        c.status === 'completed'
                          ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                          : 'bg-amber-50 text-amber-900 border border-amber-300'
                      }`}
                    >
                      {c.status === 'completed' ? (
                        <>
                          <Check className="h-3 w-3" aria-hidden="true" />
                          <span>Completed (returned)</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          <span>Out (open)</span>
                        </>
                      )}
                    </span>
                    {c.id < 0 && (
                      <span className="text-xs font-semibold text-amber-700">(Queued Offline)</span>
                    )}
                  </div>
                  <div className="text-sm text-slate-700">
                    {c.hirer_type === 'owner' ? 'Owner:' : 'Renter:'}{' '}
                    <span className="font-semibold text-blue-950">{c.hirer_name}</span>
                    {' · '}
                    <span className="font-mono text-xs">{c.cell}</span>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-500">
                    Out {c.hire_date} · {c.days}d (Return {c.return_date}) · {c.mileage_out.toLocaleString()} km
                    {c.mileage_in !== null ? ` → ${c.mileage_in.toLocaleString()} km` : ''}
                    {c.differences.length > 0 ? ` · ${c.differences.length} difference(s)` : ''}
                  </div>
                </div>

                {c.id > 0 && c.status === 'out' && (
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const res = await api.getChecklist(c.id);
                      setDetail(res.checklist);
                      setScreen('detail');
                      beginReturnFlow(res.checklist);
                    }}
                    className="cyan-glow-outline self-start sm:self-center min-h-[42px] rounded-xl border border-cyan-300 bg-cyan-50/70 px-4 text-xs font-semibold text-blue-950 whitespace-nowrap"
                  >
                    Complete Return
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Admin Template Manager Modal */}
      {showTemplateModal && isAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-8 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-lg font-bold text-blue-950">
                Checklist Template Rows ({templates.length})
              </h2>
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                aria-label="Close"
                className="p-2 text-slate-500"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleAddTemplate} className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                required
                value={newTplLabel}
                onChange={(e) => setNewTplLabel(e.target.value)}
                placeholder="Add new default row label..."
                className="cyan-glow-input flex-1 min-h-[42px] rounded-xl border border-blue-200 px-3 text-sm"
              />
              <select
                value={newTplType}
                onChange={(e) => setNewTplType(e.target.value as ChecklistInputType)}
                className="cyan-glow-input min-h-[42px] rounded-xl border border-blue-200 bg-white px-2.5 text-xs font-semibold"
              >
                {INPUT_TYPE_LABELS.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={savingTpl}
                className="cyan-glow-btn min-h-[42px] rounded-xl px-4 text-xs font-semibold"
              >
                Add
              </button>
            </form>

            <div className="max-h-80 overflow-y-auto divide-y divide-blue-100 rounded-xl border border-blue-100">
              {templates.map((t, i) => (
                <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <div>
                    <span className="font-mono text-slate-400 mr-1.5">{i + 1}.</span>
                    <span className="font-semibold text-blue-950">{t.label}</span>
                    <span className="ml-2 font-mono text-[11px] text-slate-500">({t.input_type})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleToggleTemplateActive(t)}
                    className={`rounded-lg px-2.5 py-1 font-semibold ${
                      t.active
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : 'bg-slate-100 text-slate-600 border border-slate-200'
                    }`}
                  >
                    {t.active ? 'Active' : 'Hidden'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
