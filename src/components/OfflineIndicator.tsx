import React, { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import {
  OFFLINE_QUEUE_EVENT,
  flushOfflineQueue,
  getOfflineQueue,
  type QueuedTripEntry,
} from '../lib/offlineQueue';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  const [queue, setQueue] = useState<QueuedTripEntry[]>(() => getOfflineQueue());
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const refresh = () => setQueue(getOfflineQueue());
    window.addEventListener(OFFLINE_QUEUE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    if (!isOnline || queue.length === 0) return;
    let cancelled = false;
    setSyncing(true);
    flushOfflineQueue()
      .catch(() => {
        // Errors stay stored per item for manual review
      })
      .finally(() => {
        if (!cancelled) {
          setSyncing(false);
          setQueue(getOfflineQueue());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOnline, queue.length]);

  const handleManualSync = async () => {
    if (!isOnline || syncing) return;
    setSyncing(true);
    try {
      await flushOfflineQueue();
      setQueue(getOfflineQueue());
    } finally {
      setSyncing(false);
    }
  };

  if (isOnline && queue.length === 0) return null;

  return (
    <div
      role="status"
      className={`fixed bottom-20 left-4 right-4 md:bottom-5 md:left-auto md:right-5 z-40 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-md ${
        !isOnline
          ? 'border-amber-300 bg-amber-50 text-amber-900'
          : 'border-cyan-300 bg-white text-blue-950 shadow-cyan-500/15'
      }`}
    >
      <div className="flex items-center gap-2.5">
        {!isOnline ? (
          <WifiOff className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        ) : (
          <RefreshCw
            className={`h-4 w-4 shrink-0 text-cyan-600 ${syncing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
        )}
        <span>
          {!isOnline
            ? queue.length > 0
              ? `Offline · ${queue.length} record${queue.length === 1 ? '' : 's'} cached locally`
              : 'Offline mode · Session active, new entries will cache & auto-sync'
            : syncing
              ? `Syncing ${queue.length} offline record${queue.length === 1 ? '' : 's'}...`
              : `${queue.length} offline record${queue.length === 1 ? '' : 's'} waiting to sync`}
        </span>
      </div>

      {isOnline && queue.length > 0 && !syncing && (
        <button
          type="button"
          onClick={handleManualSync}
          aria-label="Sync queued records now"
          className="cyan-glow-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          title="Sync now"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
