import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-blue-200 bg-white px-3.5 py-2 text-sm font-medium text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 whitespace-nowrap shrink-0"
      >
        <Download className="h-4 w-4 text-cyan-600" aria-hidden="true" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-blue-200 bg-white px-3.5 py-2 text-sm font-medium text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500 whitespace-nowrap shrink-0"
        >
          <Share className="h-4 w-4 text-cyan-600" aria-hidden="true" />
          <span>Install App</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <h3 className="text-lg font-semibold text-blue-950">Install on iPhone or iPad</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Close installation guide"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-blue-600 hover:bg-cyan-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <ol className="mt-3 space-y-2 text-base text-slate-700 list-decimal pl-5">
                <li>Tap the <strong>Share</strong> button in the Safari toolbar.</li>
                <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
                <li>Tap <strong>Add</strong> to keep Fleet Secure on your home screen.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="cyan-glow-btn mt-5 w-full min-h-[48px] rounded-xl px-4 py-2.5 text-base font-medium"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
