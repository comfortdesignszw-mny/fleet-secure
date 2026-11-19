import React, { useRef, useState } from 'react';
import { Camera, Eye, FileText, Trash2, Upload, X } from 'lucide-react';

interface DocumentUploadFieldProps {
  label: string;
  value: string | null;
  onChange: (nextDataUrl: string | null) => void;
  disabled?: boolean;
  hint?: string;
}

const MAX_PDF_BYTES = 700_000;
const MAX_SERVER_DATA_URL_CHARS = 950_000;
const TARGET_IMAGE_DATA_URL_CHARS = 450_000;

async function compressImageFile(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read image file. Try a JPG or PNG photo.'));
      el.src = objectUrl;
    });

    const passes: Array<{ maxDim: number; quality: number }> = [
      { maxDim: 1400, quality: 0.78 },
      { maxDim: 1050, quality: 0.62 },
      { maxDim: 800, quality: 0.5 },
    ];

    let lastDataUrl = '';
    for (const pass of passes) {
      const naturalW = img.naturalWidth || img.width || 1;
      const naturalH = img.naturalHeight || img.height || 1;
      const scale = Math.min(1, pass.maxDim / Math.max(naturalW, naturalH));
      const width = Math.max(1, Math.round(naturalW * scale));
      const height = Math.max(1, Math.round(naturalH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Could not process image in this browser.');
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', pass.quality);
      if (dataUrl.startsWith('data:image/')) {
        lastDataUrl = dataUrl;
        if (dataUrl.length <= TARGET_IMAGE_DATA_URL_CHARS) {
          return dataUrl;
        }
      }
    }

    if (!lastDataUrl.startsWith('data:image/')) {
      throw new Error('Could not encode image. Please try another photo.');
    }
    return lastDataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
      } else {
        reject(new Error('Could not read file.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

export function isPdfDataUrl(dataUrl: string | null | undefined): boolean {
  return Boolean(dataUrl && dataUrl.startsWith('data:application/pdf'));
}

function isSupportedImageFile(file: File): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name || '');
}

export const DocumentUploadField: React.FC<DocumentUploadFieldProps> = ({
  label,
  value,
  onChange,
  disabled = false,
  hint = 'Optional · Upload PDF (<700 KB) / image or take photo',
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [processing, setProcessing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const handleFileSelected = async (file: File | undefined) => {
    if (!file) return;
    setLocalError(null);
    setProcessing(true);
    try {
      const isPdf =
        file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isImage = !isPdf && isSupportedImageFile(file);

      if (!isPdf && !isImage) {
        setLocalError('Select a PDF document or an image (JPG, PNG, WEBP).');
        return;
      }

      if (isPdf) {
        if (file.size > MAX_PDF_BYTES) {
          setLocalError('PDF file is too large. Keep PDF documents under 700 KB.');
          return;
        }
        const rawDataUrl = await readFileAsDataUrl(file);
        const dataUrl = rawDataUrl.startsWith('data:application/pdf')
          ? rawDataUrl
          : rawDataUrl.replace(/^data:[^;]*;base64,/i, 'data:application/pdf;base64,');
        if (dataUrl.length > MAX_SERVER_DATA_URL_CHARS) {
          setLocalError('PDF file is too large after encoding. Keep PDF documents under 700 KB.');
          return;
        }
        onChange(dataUrl);
      } else {
        const dataUrl = await compressImageFile(file);
        if (dataUrl.length > MAX_SERVER_DATA_URL_CHARS) {
          setLocalError('Image is still too large after compression. Try a smaller photo.');
          return;
        }
        onChange(dataUrl);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not attach document.');
    } finally {
      setProcessing(false);
    }
  };

  const hasDoc = Boolean(value);
  const isPdf = isPdfDataUrl(value);

  return (
    <div className="rounded-xl border border-blue-200/80 bg-blue-50/25 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-blue-950">{label}</div>
          <div className="text-[11px] text-slate-500">{hint}</div>
        </div>

        {!disabled && (
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.pdf"
              className="sr-only"
              disabled={processing}
              onChange={async (e) => {
                const inputEl = e.currentTarget;
                const f = inputEl.files?.[0];
                try {
                  await handleFileSelected(f);
                } finally {
                  inputEl.value = '';
                }
              }}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              disabled={processing}
              onChange={async (e) => {
                const inputEl = e.currentTarget;
                const f = inputEl.files?.[0];
                try {
                  await handleFileSelected(f);
                } finally {
                  inputEl.value = '';
                }
              }}
            />

            <button
              type="button"
              disabled={processing}
              onClick={() => fileInputRef.current?.click()}
              className="cyan-glow-outline inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-900 disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
              <span>{processing ? 'Processing...' : hasDoc ? 'Replace File' : 'Upload PDF/Image'}</span>
            </button>

            <button
              type="button"
              disabled={processing}
              onClick={() => cameraInputRef.current?.click()}
              className="cyan-glow-outline inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-900 disabled:opacity-50"
            >
              <Camera className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
              <span>Camera</span>
            </button>
          </div>
        )}
      </div>

      {hasDoc && value && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-2.5 py-2">
          <div className="flex items-center gap-2 min-w-0">
            {isPdf ? (
              <FileText className="h-5 w-5 shrink-0 text-emerald-700" aria-hidden="true" />
            ) : (
              <img
                src={value}
                alt={`${label} thumbnail`}
                className="h-9 w-12 rounded border border-emerald-200 object-cover shrink-0 bg-white"
              />
            )}
            <span className="text-xs font-semibold text-emerald-900 truncate">
              {isPdf ? 'PDF document attached' : 'Image attached'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 text-xs font-semibold text-emerald-900 hover:bg-emerald-100"
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              <span>View</span>
            </button>
            {!disabled && (
              <button
                type="button"
                onClick={() => onChange(null)}
                aria-label={`Remove ${label}`}
                className="inline-flex min-h-[32px] items-center gap-1 rounded-md border border-red-200 bg-white px-2 text-xs font-semibold text-red-700 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Remove</span>
              </button>
            )}
          </div>
        </div>
      )}

      {localError && (
        <div className="text-xs font-medium text-red-700" role="alert">
          {localError}
        </div>
      )}

      {previewOpen && value && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-blue-950/60 backdrop-blur-xs p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-display text-base font-bold text-blue-950">{label}</h3>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                aria-label="Close document preview"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-blue-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {isPdf ? (
              <div className="space-y-3">
                <iframe
                  title={label}
                  src={value}
                  className="h-[65vh] w-full rounded-xl border border-blue-200 bg-slate-50"
                />
                <div className="flex justify-end">
                  <a
                    href={value}
                    download={`${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`}
                    className="cyan-glow-btn inline-flex min-h-[40px] items-center rounded-xl px-4 text-xs font-semibold"
                  >
                    Download PDF
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <img
                  src={value}
                  alt={label}
                  className="max-h-[70vh] w-auto rounded-xl border border-blue-200 object-contain"
                />
                <a
                  href={value}
                  download={`${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`}
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
