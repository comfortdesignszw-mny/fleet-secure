import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  FileCheck2,
  Phone,
  Plus,
  Search,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  OFFLINE_SYNCED_EVENT,
  enqueueOfflineEntry,
  isLikelyNetworkError,
} from '../lib/offlineQueue';
import {
  formatDriverMissingDocsWarning,
  formatHarareTime,
  getDriverMissingDocuments,
  type DerivedStatus,
  type Driver,
  type LicenceStatus,
  type Role,
} from '../shared/types';
import { DocumentUploadField } from './DocumentUploadField';

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
        <span>Expired ({expiry})</span>
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
  const canSeeMissingDocWarnings = userRole === 'SUPERVISOR' || userRole === 'ADMIN';

  const [items, setItems] = useState<Driver[]>([]);
  const [total, setTotal] = useState(0);
  const [expiringCount, setExpiringCount] = useState(0);
  const [missingDocsCount, setMissingDocsCount] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 25;

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [missingDocsOnly, setMissingDocsOnly] = useState(false);
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
  const [formLicenceDoc, setFormLicenceDoc] = useState<string | null>(null);
  const [formDdcNumber, setFormDdcNumber] = useState('');
  const [formDdcDoc, setFormDdcDoc] = useState<string | null>(null);
  const [formRetestNumber, setFormRetestNumber] = useState('');
  const [formRetestDoc, setFormRetestDoc] = useState<string | null>(null);
  const [formMedicalNumber, setFormMedicalNumber] = useState('');
  const [formMedicalDoc, setFormMedicalDoc] = useState<string | null>(null);
  const [docChanged, setDocChanged] = useState<{
    licence: boolean;
    ddc: boolean;
    retest: boolean;
    medical: boolean;
  }>({ licence: false, ddc: false, retest: false, medical: false });
  const [formActive, setFormActive] = useState(true);
  const [loadingExistingDocs, setLoadingExistingDocs] = useState(false);
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
      const list = missingDocsOnly && canSeeMissingDocWarnings
        ? res.items.filter((d) => (d.missing_documents?.length ?? 0) > 0)
        : res.items;
      setItems(list);
      setTotal(missingDocsOnly && canSeeMissingDocWarnings ? list.length : res.total);
      setExpiringCount(res.expiringCount);
      setMissingDocsCount(res.missingDocsCount ?? 0);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(res.items));
      } catch {
        // Ignore quota errors
      }
    } catch (err) {
      if (isLikelyNetworkError(err)) {
        try {
          const cached = localStorage.getItem(CACHE_KEY);
          if (cached) {
            const parsed = JSON.parse(cached) as Driver[];
            setItems(parsed);
            setTotal(parsed.length);
            setUsingCache(true);
          } else {
            setError('You appear to be offline and no cached driver list is available.');
          }
        } catch {
          setError('You appear to be offline and could not read cached drivers.');
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load drivers.');
      }
    } finally {
      setLoading(false);
    }
  }, [query, statusFilter, expiringOnly, missingDocsOnly, canSeeMissingDocWarnings, includeInactive, page]);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  useEffect(() => {
    const onSynced = () => {
      void fetchDrivers();
    };
    window.addEventListener(OFFLINE_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(OFFLINE_SYNCED_EVENT, onSynced);
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
    setFormLicenceDoc(null);
    setFormDdcNumber('');
    setFormDdcDoc(null);
    setFormRetestNumber('');
    setFormRetestDoc(null);
    setFormMedicalNumber('');
    setFormMedicalDoc(null);
    setDocChanged({ licence: true, ddc: true, retest: true, medical: true });
    setFormActive(true);
    setFormError(null);
    setShowForm(true);
  };

  const openEditModal = async (d: Driver) => {
    setEditingDriver(d);
    setFormName(d.full_name);
    setFormLicence(d.licence_number ?? '');
    setFormPhone(d.phone);
    setFormAddress(d.address);
    setFormExpiry(d.licence_expiry ?? '');
    setFormLicenceDoc(d.licence_document ?? null);
    setFormDdcNumber(d.ddc_number ?? '');
    setFormDdcDoc(d.ddc_document ?? null);
    setFormRetestNumber(d.retest_cert_number ?? '');
    setFormRetestDoc(d.retest_document ?? null);
    setFormMedicalNumber(d.medical_cert_number ?? '');
    setFormMedicalDoc(d.medical_document ?? null);
    setDocChanged({ licence: false, ddc: false, retest: false, medical: false });
    setFormActive(d.active);
    setFormError(null);
    setLoadingExistingDocs(false);
    setShowForm(true);

    // If opened from list (which omits heavy base64 blobs), fetch full record so previews appear
    if (
      d.id > 0 &&
      ((d.has_licence_document && d.licence_document === undefined) ||
        (d.has_ddc_document && d.ddc_document === undefined) ||
        (d.has_retest_document && d.retest_document === undefined) ||
        (d.has_medical_document && d.medical_document === undefined))
    ) {
      setLoadingExistingDocs(true);
      try {
        const res = await api.getDriver(d.id);
        setFormLicenceDoc(res.driver.licence_document ?? null);
        setFormDdcDoc(res.driver.ddc_document ?? null);
        setFormRetestDoc(res.driver.retest_document ?? null);
        setFormMedicalDoc(res.driver.medical_document ?? null);
      } catch {
        // Keep existing state if offline
      } finally {
        setLoadingExistingDocs(false);
      }
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const cleanName = formName.trim();
      const cleanLicence = formLicence.trim().toUpperCase() || null;
      const cleanPhone = formPhone.trim();
      const cleanAddress = formAddress.trim();
      const cleanExpiry = formExpiry.trim() ? formExpiry.trim() : null;
      const cleanDdc = formDdcNumber.trim().toUpperCase() || null;
      const cleanRetest = formRetestNumber.trim().toUpperCase() || null;
      const cleanMedical = formMedicalNumber.trim().toUpperCase() || null;

      if (editingDriver) {
        const res = await api.updateDriver(editingDriver.id, {
          full_name: cleanName,
          licence_number: cleanLicence,
          phone: cleanPhone,
          address: cleanAddress,
          licence_expiry: cleanExpiry,
          ...(docChanged.licence ? { licence_document: formLicenceDoc } : {}),
          ddc_number: cleanDdc,
          ...(docChanged.ddc ? { ddc_document: formDdcDoc } : {}),
          retest_cert_number: cleanRetest,
          ...(docChanged.retest ? { retest_document: formRetestDoc } : {}),
          medical_cert_number: cleanMedical,
          ...(docChanged.medical ? { medical_document: formMedicalDoc } : {}),
          active: formActive,
        });
        setShowForm(false);
        setNotice(`Updated driver ${res.driver.full_name}.`);
        if (selectedId === res.driver.id) {
          await loadDriverDetail(res.driver.id);
        }
        await fetchDrivers();
      } else {
        const payload = {
          full_name: cleanName,
          licence_number: cleanLicence,
          phone: cleanPhone,
          address: cleanAddress,
          licence_expiry: cleanExpiry,
          licence_document: formLicenceDoc,
          ddc_number: cleanDdc,
          ddc_document: formDdcDoc,
          retest_cert_number: cleanRetest,
          retest_document: formRetestDoc,
          medical_cert_number: cleanMedical,
          medical_document: formMedicalDoc,
        };
        try {
          const res = await api.createDriver(payload);
          setShowForm(false);
          setNotice(`Added driver ${res.driver.full_name} to the directory.`);
          await fetchDrivers();
        } catch (err) {
          if (isLikelyNetworkError(err)) {
            enqueueOfflineEntry({
              kind: 'DRIVER_CREATE',
              summaryLabel: `Add Driver · ${cleanName}`,
              payload,
            });
            const optimisticDriver: Driver = {
              id: -Date.now(),
              full_name: cleanName,
              licence_number: cleanLicence,
              phone: cleanPhone,
              address: cleanAddress,
              licence_expiry: cleanExpiry,
              has_licence_document: Boolean(formLicenceDoc),
              ddc_number: cleanDdc,
              has_ddc_document: Boolean(formDdcDoc),
              retest_cert_number: cleanRetest,
              has_retest_document: Boolean(formRetestDoc),
              medical_cert_number: cleanMedical,
              has_medical_document: Boolean(formMedicalDoc),
              missing_documents: canSeeMissingDocWarnings
                ? getDriverMissingDocuments({
                    licence_number: cleanLicence,
                    has_licence_document: Boolean(formLicenceDoc),
                    ddc_number: cleanDdc,
                    has_ddc_document: Boolean(formDdcDoc),
                    retest_cert_number: cleanRetest,
                    has_retest_document: Boolean(formRetestDoc),
                    medical_cert_number: cleanMedical,
                    has_medical_document: Boolean(formMedicalDoc),
                  })
                : undefined,
              active: true,
              created_at: new Date().toISOString(),
              created_by: null,
              derived_status: 'Available',
              open_trip_id: null,
              licence_status: 'NONE',
              days_to_expiry: null,
            };
            const nextList = [optimisticDriver, ...items];
            setItems(nextList);
            setTotal(nextList.length);
            try {
              localStorage.setItem(CACHE_KEY, JSON.stringify(nextList));
            } catch {
              // Ignore quota errors
            }
            setShowForm(false);
            setNotice(
              `Saved driver "${cleanName}" offline in local cache. Will sync automatically when connection returns.`
            );
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save driver.');
    } finally {
      setSaving(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  if (selectedId !== null) {
    const detailMissingDocs =
      canSeeMissingDocWarnings && detailDriver
        ? detailDriver.missing_documents ?? getDriverMissingDocuments(detailDriver)
        : [];

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
              onClick={() => void openEditModal(detailDriver)}
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
            {canSeeMissingDocWarnings && detailMissingDocs.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
              >
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
                <div>
                  <div className="font-semibold">Missing Critical Driver Documents</div>
                  <p className="mt-0.5">
                    {formatDriverMissingDocsWarning(detailDriver.full_name, detailMissingDocs)}
                  </p>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-blue-200/80 bg-white p-6 shadow-xs space-y-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-mono text-cyan-700 font-medium">
                    Licence: {detailDriver.licence_number ?? 'Not recorded'}
                    {!detailDriver.active && ' · Inactive'}
                  </div>
                  <h1 className="mt-1 font-display text-2xl font-bold text-blue-950">
                    {detailDriver.full_name}
                  </h1>
                </div>
                <DriverStatusText status={detailDriver.derived_status} />
              </div>

              <div className="grid grid-cols-1 gap-4 border-t border-blue-100 pt-5 sm:grid-cols-3">
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

              {/* Certificates & Documents Section */}
              <div className="border-t border-blue-100 pt-5 space-y-3">
                <h2 className="text-sm font-semibold text-blue-950 flex items-center gap-2">
                  <FileCheck2 className="h-4 w-4 text-cyan-600" aria-hidden="true" />
                  <span>Certificates &amp; Uploaded Documents</span>
                </h2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    {
                      title: "Driver's Licence",
                      number: detailDriver.licence_number,
                      doc: detailDriver.licence_document,
                      hasDoc: detailDriver.has_licence_document,
                    },
                    {
                      title: 'Defensive Driving Certificate (DDC)',
                      number: detailDriver.ddc_number,
                      doc: detailDriver.ddc_document,
                      hasDoc: detailDriver.has_ddc_document,
                    },
                    {
                      title: 'Retest Certificate',
                      number: detailDriver.retest_cert_number,
                      doc: detailDriver.retest_document,
                      hasDoc: detailDriver.has_retest_document,
                    },
                    {
                      title: 'Medical Certificate',
                      number: detailDriver.medical_cert_number,
                      doc: detailDriver.medical_document,
                      hasDoc: detailDriver.has_medical_document,
                    },
                  ].map((cert) => (
                    <div
                      key={cert.title}
                      className="rounded-xl border border-blue-100 bg-blue-50/25 p-3.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-blue-950">{cert.title}</span>
                        <span className="font-mono text-xs text-slate-700">
                          {cert.number ?? 'No number'}
                        </span>
                      </div>
                      {cert.doc ? (
                        <DocumentUploadField
                          label={`${cert.title} File`}
                          value={cert.doc}
                          onChange={() => {}}
                          disabled
                          hint="Attached copy"
                        />
                      ) : cert.hasDoc ? (
                        <div className="text-xs font-medium text-emerald-700">
                          Document uploaded on server
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">No PDF or photo uploaded</div>
                      )}
                    </div>
                  ))}
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
            Driver contact records, licences, certificates (DDC, Retest, Medical), and live availability.
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

      {canSeeMissingDocWarnings && missingDocsCount > 0 && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50/75 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3 text-amber-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div className="text-sm">
              <span className="font-semibold">Incomplete Driver Documents:</span>{' '}
              {missingDocsCount} active driver{missingDocsCount === 1 ? ' is' : 's are'} missing one or more critical documents (Licence, DDC, Retest, or Medical Certificate).
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setMissingDocsOnly((v) => !v);
              setPage(1);
            }}
            className="min-h-[44px] self-start sm:self-center rounded-xl border border-amber-400 bg-white px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 whitespace-nowrap shrink-0"
          >
            {missingDocsOnly ? 'Show All Drivers' : 'Filter Missing Docs'}
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
              placeholder="Search name, licence, DDC, retest, medical, or phone..."
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
                    <th className="py-3 px-4">DDC / Retest / Medical</th>
                    <th className="py-3 px-4">Phone</th>
                    <th className="py-3 px-4">Licence Expiry</th>
                    <th className="py-3 px-4">Status</th>
                    {canManage && <th className="py-3 px-4 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-100 text-sm">
                  {items.map((d) => {
                    const missingDocs = canSeeMissingDocWarnings
                      ? d.missing_documents ?? getDriverMissingDocuments(d)
                      : [];
                    return (
                      <tr
                        key={d.id}
                        onClick={() => d.id > 0 && loadDriverDetail(d.id)}
                        className={`${d.id > 0 ? 'cursor-pointer hover:bg-cyan-50/45' : ''} transition-colors`}
                      >
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-blue-950">
                            {d.full_name}
                            {!d.active && (
                              <span className="ml-2 text-xs font-normal text-red-700">(Disabled)</span>
                            )}
                            {d.id < 0 && (
                              <span className="ml-2 text-xs font-medium text-amber-700">
                                (Queued Offline)
                              </span>
                            )}
                          </div>
                          {canSeeMissingDocWarnings && missingDocs.length > 0 && (
                            <div className="mt-1 inline-flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
                              <span>{formatDriverMissingDocsWarning(d.full_name, missingDocs)}</span>
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-slate-700">
                          {d.licence_number ?? <span className="text-slate-400 font-sans">Not recorded</span>}
                        </td>
                        <td className="py-3.5 px-4 text-xs font-mono text-slate-600 space-y-0.5">
                          <div>DDC: {d.ddc_number ?? '—'}</div>
                          <div>Retest: {d.retest_cert_number ?? '—'}</div>
                          <div>Medical: {d.medical_cert_number ?? '—'}</div>
                        </td>
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
                            {d.id > 0 && (
                              <button
                                type="button"
                                onClick={() => void openEditModal(d)}
                                className="cyan-glow-outline inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
                              >
                                <Edit3 className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
                                <span>Manage</span>
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-blue-100 md:hidden">
              {items.map((d) => {
                const missingDocs = canSeeMissingDocWarnings
                  ? d.missing_documents ?? getDriverMissingDocuments(d)
                  : [];
                return (
                  <div
                    key={d.id}
                    onClick={() => d.id > 0 && loadDriverDetail(d.id)}
                    className={`p-4 space-y-2 ${d.id > 0 ? 'cursor-pointer hover:bg-cyan-50/40 active:bg-cyan-50/70' : ''} transition-colors`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-base font-bold text-blue-950">
                          {d.full_name}
                          {!d.active && (
                            <span className="ml-2 text-xs font-medium text-red-700">Disabled</span>
                          )}
                          {d.id < 0 && (
                            <span className="ml-2 text-xs font-medium text-amber-700">
                              Queued Offline
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-slate-500">
                          {d.licence_number ?? 'No licence'} · {d.phone}
                        </div>
                        {(d.ddc_number || d.retest_cert_number || d.medical_cert_number) && (
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                            {d.ddc_number ? `DDC: ${d.ddc_number} ` : ''}
                            {d.retest_cert_number ? `· Retest: ${d.retest_cert_number} ` : ''}
                            {d.medical_cert_number ? `· Med: ${d.medical_cert_number}` : ''}
                          </div>
                        )}
                      </div>
                      <DriverStatusText status={d.derived_status} />
                    </div>

                    {canSeeMissingDocWarnings && missingDocs.length > 0 && (
                      <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs font-medium text-amber-900">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
                        <span>{formatDriverMissingDocsWarning(d.full_name, missingDocs)}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-1">
                      <LicenceExpiryIndicator
                        status={d.licence_status}
                        expiry={d.licence_expiry}
                        days={d.days_to_expiry}
                      />
                      {canManage && d.id > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void openEditModal(d);
                          }}
                          className="cyan-glow-outline min-h-[44px] rounded-lg border border-blue-200 bg-white px-3.5 text-sm font-semibold text-blue-900"
                        >
                          Manage
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
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
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-blue-950/50 backdrop-blur-xs p-4 overflow-y-auto">
          <div className="w-full max-w-lg rounded-2xl border border-blue-200 bg-white p-6 shadow-xl my-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-blue-950">
                  {editingDriver ? `Edit ${editingDriver.full_name}` : 'Add New Driver'}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Only Full Name and Phone are required. All licences and certificates are optional and can be uploaded later.
                </p>
              </div>
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

            {loadingExistingDocs && (
              <div
                role="status"
                className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs font-medium text-blue-900"
              >
                Loading existing uploaded document previews...
              </div>
            )}

            <form onSubmit={handleFormSubmit} className="mt-4 space-y-4">
              <div>
                <label htmlFor="d-name" className="block text-sm font-semibold text-blue-950">
                  Full Name *
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="d-phone" className="block text-sm font-semibold text-blue-950">
                    Phone Number *
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
                    placeholder="e.g. 14 Samora Machel Ave"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>
              </div>

              <div className="border-t border-blue-100 pt-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                  Driver&apos;s Licence (Optional)
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="d-licence" className="block text-sm font-semibold text-blue-950">
                      Driving Licence Number
                    </label>
                    <input
                      id="d-licence"
                      type="text"
                      value={formLicence}
                      onChange={(e) => setFormLicence(e.target.value)}
                      placeholder="e.g. 940281ZW (optional)"
                      className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-base text-blue-950"
                    />
                  </div>

                  <div>
                    <label htmlFor="d-expiry" className="block text-sm font-semibold text-blue-950">
                      Licence Expiry Date
                    </label>
                    <input
                      id="d-expiry"
                      type="date"
                      value={formExpiry}
                      onChange={(e) => setFormExpiry(e.target.value)}
                      className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono text-base text-blue-950"
                    />
                  </div>
                </div>

                <DocumentUploadField
                  label="Driving Licence Copy (PDF / Photo)"
                  value={formLicenceDoc}
                  onChange={(val) => {
                    setFormLicenceDoc(val);
                    setDocChanged((prev) => ({ ...prev, licence: true }));
                  }}
                />
              </div>

              <div className="border-t border-blue-100 pt-4 space-y-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                  Defensive Driving, Retest &amp; Medical Certificates (Optional)
                </div>

                <div>
                  <label htmlFor="d-ddc" className="block text-sm font-semibold text-blue-950">
                    Defensive Driving Certificate (DDC) Number
                  </label>
                  <input
                    id="d-ddc"
                    type="text"
                    value={formDdcNumber}
                    onChange={(e) => setFormDdcNumber(e.target.value)}
                    placeholder="e.g. DDC-2026-0412 (optional)"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-sm text-blue-950"
                  />
                </div>
                <DocumentUploadField
                  label="Defensive Driving Certificate (DDC)"
                  value={formDdcDoc}
                  onChange={(val) => {
                    setFormDdcDoc(val);
                    setDocChanged((prev) => ({ ...prev, ddc: true }));
                  }}
                />

                <div>
                  <label htmlFor="d-retest" className="block text-sm font-semibold text-blue-950">
                    Retest Certificate Number
                  </label>
                  <input
                    id="d-retest"
                    type="text"
                    value={formRetestNumber}
                    onChange={(e) => setFormRetestNumber(e.target.value)}
                    placeholder="e.g. RET-88210 (optional)"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-sm text-blue-950"
                  />
                </div>
                <DocumentUploadField
                  label="Retest Certificate Copy"
                  value={formRetestDoc}
                  onChange={(val) => {
                    setFormRetestDoc(val);
                    setDocChanged((prev) => ({ ...prev, retest: true }));
                  }}
                />

                <div>
                  <label htmlFor="d-medical" className="block text-sm font-semibold text-blue-950">
                    Medical Certificate Number
                  </label>
                  <input
                    id="d-medical"
                    type="text"
                    value={formMedicalNumber}
                    onChange={(e) => setFormMedicalNumber(e.target.value)}
                    placeholder="e.g. MED-30194 (optional)"
                    className="cyan-glow-input mt-1.5 block w-full min-h-[44px] rounded-xl border border-blue-200 px-3.5 font-mono uppercase text-sm text-blue-950"
                  />
                </div>
                <DocumentUploadField
                  label="Medical Certificate Copy"
                  value={formMedicalDoc}
                  onChange={(val) => {
                    setFormMedicalDoc(val);
                    setDocChanged((prev) => ({ ...prev, medical: true }));
                  }}
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
