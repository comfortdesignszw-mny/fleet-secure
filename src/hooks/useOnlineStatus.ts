import { useCallback, useEffect, useRef, useState } from 'react';
import { checkServerReachable } from '../lib/api';
import { dispatchOnlineReconnected } from '../lib/offlineCache';

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const wasOnlineRef = useRef(isOnline);

  useEffect(() => {
    if (!wasOnlineRef.current && isOnline) {
      dispatchOnlineReconnected();
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline]);

  const probeNow = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setIsOnline(false);
      return false;
    }
    const reachable = await checkServerReachable(2500);
    setIsOnline(reachable);
    return reachable;
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void probeNow();
    };
    const handleOffline = () => setIsOnline(false);
    const handleResume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setIsOnline(false);
        return;
      }
      void probeNow();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleResume);
    document.addEventListener('visibilitychange', handleResume);

    // When offline, periodically probe health while tab is visible so reconnection triggers sync immediately
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (!isOnline) {
        void probeNow();
      }
    }, 5000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
      window.clearInterval(timer);
    };
  }, [isOnline, probeNow]);

  return isOnline;
}
