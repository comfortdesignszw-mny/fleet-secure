import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Car,
  ClipboardList,
  Download,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Printer,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ExportFormat, ReportPreviewData, ReportType } from '../shared/types';

function toHarareInputDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const REPORT_OPTIONS: Array<{
  type: ReportType;
  label: string;
  description: string;
  usesDateRange: boolean;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    type: 'all_trips',
    label: 'All Trips',
    description: 'Every hire and errand with mileage, fuel estimates, and flags.',
    usesDateRange: true,
    icon: ClipboardList,
  },
  {
    type: 'hires',
    label: 'Client Hires',
    description: 'Customer rentals only with client names and return status.',
    usesDateRange: true,
    icon: Car,
  },
  {
    type: 'errands',
    label: 'Staff Errands',
    description: 'Internal staff runs with destination and stated reason.',
    usesDateRange: true,
    icon: Car,
  },
  {
    type: 'flagged_trips',
    label: 'Flagged & Overdue',
    description: 'Trips with fuel mismatches, mileage gaps, offline delays, or overdue hires.',
    usesDateRange: true,
    icon: AlertTriangle,
  },
  {
    type: 'vehicles',
    label: 'Vehicles Directory',
    description: 'Full fleet list with class, condition, odometer, and cumulative trip km.',
    usesDateRange: false,
    icon: Car,
  },
  {
    type: 'drivers',
    label: 'Drivers Directory',
    description: 'Drivers list, phone numbers, licence numbers, and expiry warnings.',
    usesDateRange: false,
    icon: Users,
  },
  {
    type: 'audit_log',
    label: 'Audit Log',
    description: 'Tamper-evident security & action trail with hash prefixes.',
    usesDateRange: true,
    icon: ShieldCheck,
  },
];

export const ReportsView: React.FC = () => {
  const todayStr = toHarareInputDate(new Date());
  const monthStartStr = `${todayStr.slice(0, 7)}-01`;

  const [reportType, setReportType] = useState<ReportType>('all_trips');
  const [fromDate, setFromDate] = useState(monthStartStr);
  const [toDate, setToDate] = useState(todayStr);
  const [preview, setPreview] = useState<ReportPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedMeta = REPORT_OPTIONS.find((r) => r.type === reportType)!;

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getReportPreview({
        type: reportType,
        from: selectedMeta.usesDateRange ? fromDate : undefined,
        to: selectedMeta.usesDateRange ? toDate : undefined,
      });
      setPreview(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load report preview.');
    } finally {
      setLoading(false);
    }
  }, [reportType, fromDate, toDate, selectedMeta.usesDateRange]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const applyPreset = (preset: 'today' | '7d' | 'month' | 'all') => {
    const now = new Date();
    const t = toHarareInputDate(now);
    if (preset === 'today') {
      setFromDate(t);
      setToDate(t);
    } else if (preset === '7d') {
      const d7 = new Date(now.getTime() - 6 * 86_400_000);
      setFromDate(toHarareInputDate(d7));
      setToDate(t);
    } else if (preset === 'month') {
      setFromDate(`${t.slice(0, 7)}-01`);
      setToDate(t);
    } else {
      setFromDate('');
      setToDate('');
    }
  };

  const handleDownload = async (format: ExportFormat) => {
    setDownloading(format);
    setError(null);
    setNotice(null);
    try {
      const url = api.getReportExportUrl({
        type: reportType,
        format,
        from: selectedMeta.usesDateRange ? fromDate : undefined,
        to: selectedMeta.usesDateRange ? toDate : undefined,
      });

      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        const txt = await res.text();
        let msg = 'Could not generate export.';
        try {
          const parsed = JSON.parse(txt) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch {
          // ignore
        }
        throw new Error(msg);
      }

      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `fleet-secure-${reportType}.${format}`;

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);

      setNotice(`Downloaded ${filename} and recorded export in the audit log.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-blue-950">Reports &amp; Exports</h1>
        <p className="mt-1 text-base text-slate-600">
          Download clean records for Excel, printable PDF reports with your company details, JSON, or Markdown.
        </p>
      </div>

      {/* Step 1: Choose Report Type */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-cyan-700">
          1. Choose What to Export
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {REPORT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = reportType === opt.type;
            return (
              <button
                key={opt.type}
                type="button"
                onClick={() => setReportType(opt.type)}
                className={`flex flex-col items-start text-left rounded-2xl border p-4 transition-all min-h-[96px] ${
                  active
                    ? 'cyan-glow-active'
                    : 'cyan-glow-card border-blue-200/80 bg-white text-blue-950'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-base">
                  <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-cyan-200' : 'text-blue-600'}`} aria-hidden="true" />
                  <span>{opt.label}</span>
                </div>
                <p
                  className={`mt-1.5 text-xs leading-relaxed ${
                    active ? 'text-cyan-50' : 'text-slate-600'
                  }`}
                >
                  {opt.description}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Step 2: Date Range Filter */}
      <section className="rounded-2xl border border-blue-200/80 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-cyan-700">
              2. Date Range (Africa/Harare)
            </h2>
            {!selectedMeta.usesDateRange && (
              <p className="mt-0.5 text-xs text-slate-500">
                Directory reports always export the full current list regardless of date.
              </p>
            )}
          </div>

          {selectedMeta.usesDateRange && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyPreset('today')}
                className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => applyPreset('7d')}
                className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
              >
                Last 7 Days
              </button>
              <button
                type="button"
                onClick={() => applyPreset('month')}
                className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
              >
                This Month
              </button>
              <button
                type="button"
                onClick={() => applyPreset('all')}
                className="cyan-glow-outline min-h-[40px] rounded-lg border border-blue-200 bg-white px-3 text-xs font-semibold text-blue-900"
              >
                All Dates
              </button>
            </div>
          )}
        </div>

        {selectedMeta.usesDateRange && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-lg">
            <div>
              <label htmlFor="rep-from" className="block text-sm font-semibold text-blue-950">
                From Date
              </label>
              <input
                id="rep-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base font-mono text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="rep-to" className="block text-sm font-semibold text-blue-950">
                To Date
              </label>
              <input
                id="rep-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base font-mono text-slate-900"
              />
            </div>
          </div>
        )}
      </section>

      {/* Step 3: Download Buttons */}
      <section className="rounded-2xl border border-blue-200/80 bg-white p-5 space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-cyan-700">
              3. Download Format
            </h2>
            {preview && (
              <p className="mt-1 text-sm text-slate-600">
                Ready: <span className="font-semibold text-blue-950">{preview.title}</span> ·{' '}
                <span className="font-mono tabular-nums font-semibold text-blue-950">
                  {preview.total_rows}
                </span>{' '}
                {preview.total_rows === 1 ? 'record' : 'records'}
              </p>
            )}
          </div>
          {preview && (
            <div className="text-xs text-slate-500">
              Header: {preview.company.name} · {preview.company.contact_numbers}
            </div>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
          >
            {error}
          </div>
        )}

        {notice && (
          <div
            role="status"
            className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-blue-950"
          >
            {notice}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            disabled={downloading !== null || loading}
            onClick={() => handleDownload('csv')}
            className="cyan-glow-btn flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl px-4 text-base font-semibold disabled:opacity-60"
          >
            <FileSpreadsheet className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{downloading === 'csv' ? 'Preparing CSV...' : 'Download CSV (Excel)'}</span>
          </button>

          <button
            type="button"
            disabled={downloading !== null || loading}
            onClick={() => handleDownload('pdf')}
            className="cyan-glow-btn flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl px-4 text-base font-semibold disabled:opacity-60"
          >
            <Printer className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>{downloading === 'pdf' ? 'Building PDF...' : 'Download PDF'}</span>
          </button>

          <button
            type="button"
            disabled={downloading !== null || loading}
            onClick={() => handleDownload('json')}
            className="cyan-glow-outline flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl border border-blue-200 bg-white px-4 text-base font-semibold text-blue-900 disabled:opacity-60"
          >
            <FileCode2 className="h-5 w-5 shrink-0 text-cyan-600" aria-hidden="true" />
            <span>{downloading === 'json' ? 'Preparing JSON...' : 'Download JSON'}</span>
          </button>

          <button
            type="button"
            disabled={downloading !== null || loading}
            onClick={() => handleDownload('md')}
            className="cyan-glow-outline flex min-h-[56px] items-center justify-center gap-2.5 rounded-xl border border-blue-200 bg-white px-4 text-base font-semibold text-blue-900 disabled:opacity-60"
          >
            <FileText className="h-5 w-5 shrink-0 text-cyan-600" aria-hidden="true" />
            <span>{downloading === 'md' ? 'Preparing Markdown...' : 'Download Markdown'}</span>
          </button>
        </div>
      </section>

      {/* Live Summary & Preview Table */}
      <section className="rounded-2xl border border-blue-200/80 bg-white overflow-hidden shadow-xs">
        <div className="border-b border-blue-100 p-4 sm:px-5 flex flex-wrap items-center justify-between gap-3 bg-blue-50/30">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <h2 className="text-base font-semibold text-blue-950">Report Preview</h2>
          </div>
          {preview && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              {Object.entries(preview.summary).map(([k, v]) => (
                <span key={k}>
                  {k}: <strong className="font-mono tabular-nums text-blue-950">{v}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-8 text-center text-base text-slate-500">Loading preview...</div>
        ) : !preview || preview.rows.length === 0 ? (
          <div className="p-8 text-center text-base text-slate-600">
            No records match the selected report and date range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-blue-100 text-left text-sm">
              <thead className="bg-blue-50/60 text-xs font-semibold uppercase tracking-wider text-blue-900">
                <tr>
                  {preview.columns.map((col) => (
                    <th key={col} className="px-4 py-3 whitespace-nowrap">
                      {col.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-blue-100 bg-white">
                {preview.rows.slice(0, 25).map((row, idx) => (
                  <tr key={idx} className="hover:bg-cyan-50/40 transition-colors">
                    {preview.columns.map((col) => (
                      <td key={col} className="px-4 py-3 whitespace-nowrap font-mono text-xs text-slate-800">
                        {row[col] === null || row[col] === undefined || row[col] === ''
                          ? '—'
                          : String(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length > 25 && (
              <div className="border-t border-blue-100 bg-blue-50/40 px-4 py-2.5 text-xs text-slate-600">
                Showing first 25 of {preview.rows.length} rows. All {preview.rows.length} rows are included in the downloaded file.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
