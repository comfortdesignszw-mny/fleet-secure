import React from 'react';
import { Phone, ShieldCheck } from 'lucide-react';

interface AppFooterProps {
  compact?: boolean;
}

export const AppFooter: React.FC<AppFooterProps> = ({ compact = false }) => {
  return (
    <footer
      className={`border-t border-blue-100 bg-white/95 backdrop-blur-sm ${
        compact ? 'rounded-2xl border px-4 py-3.5 shadow-sm' : 'px-4 py-4 sm:px-6 md:px-8'
      }`}
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 text-center sm:flex-row sm:text-left">
        <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold text-blue-950">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-blue-700 to-cyan-500 text-white shadow-sm">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span>© 2026 Fleet Secure. All Rights Reserved</span>
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
  );
};
