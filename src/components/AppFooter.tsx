import React, { useState } from 'react';
import { FileText, Phone, Shield, ShieldCheck } from 'lucide-react';
import { LegalDocsModal, type LegalDocType } from './LegalDocsModal';

interface AppFooterProps {
  compact?: boolean;
}

export const AppFooter: React.FC<AppFooterProps> = ({ compact = false }) => {
  const [openDoc, setOpenDoc] = useState<LegalDocType | null>(null);

  return (
    <>
      <footer
        className={`no-print border-t border-blue-100 bg-white/95 backdrop-blur-sm ${
          compact ? 'rounded-2xl border px-4 py-3.5 shadow-sm' : 'px-4 py-4 sm:px-6 md:px-8'
        }`}
      >
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2.5 text-center sm:flex-row sm:text-left">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs sm:text-sm font-semibold text-blue-950">
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-700 to-cyan-500 text-white shadow-sm">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span>© 2026 Fleet Secure. All Rights Reserved</span>
            </span>
            <span className="inline-flex items-center gap-2 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setOpenDoc('terms')}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-blue-700 underline decoration-blue-300 underline-offset-2 hover:bg-blue-50 hover:text-cyan-700"
              >
                <FileText className="h-3 w-3" aria-hidden="true" />
                <span>Terms of Use</span>
              </button>
              <span aria-hidden="true" className="text-slate-300">
                |
              </span>
              <button
                type="button"
                onClick={() => setOpenDoc('privacy')}
                className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-blue-700 underline decoration-blue-300 underline-offset-2 hover:bg-blue-50 hover:text-cyan-700"
              >
                <Shield className="h-3 w-3" aria-hidden="true" />
                <span>Privacy Policy</span>
              </button>
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs sm:text-sm text-slate-600">
            <span>Developed with</span>
            <span role="img" aria-label="love" className="text-red-500">
              ❤️
            </span>
            <span>by</span>
            <span className="font-semibold text-blue-800">Comfort Designs</span>
            <span aria-hidden="true" className="text-cyan-500">
              -
            </span>
            <a
              href="tel:+263772824132"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-xs sm:text-sm font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-cyan-500"
            >
              <Phone className="h-3.5 w-3.5 text-cyan-600" aria-hidden="true" />
              <span>+263772824132</span>
            </a>
          </div>
        </div>
      </footer>

      <LegalDocsModal
        openDoc={openDoc}
        onClose={() => setOpenDoc(null)}
        onSwitchDoc={setOpenDoc}
      />
    </>
  );
};
