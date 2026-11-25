import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellRing,
  Check,
  CheckCheck,
  RefreshCw,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import {
  CACHE_KEYS,
  ONLINE_RECONNECTED_EVENT,
  readCachedEntry,
  writeCachedEntry,
  type CachedNotificationsPayload,
} from '../lib/offlineCache';
import { OFFLINE_SYNCED_EVENT, isLikelyNetworkError } from '../lib/offlineQueue';
import {
  MAINTENANCE_UPDATED_EVENT,
  PUSH_PREFS_EVENT,
  REFRESH_NOTIFICATIONS_EVENT,
  getNotificationPermissionState,
  getPushPreferences,
  processIncomingNotifications,
  requestBrowserNotificationPermission,
  setPushPreferences,
  testNotificationAndSound,
  unlockNotificationAudio,
  type PushPreferences,
} from '../lib/pushNotifications';
import { formatHarareTime, type NotificationRecord } from '../shared/types';

interface NotificationsViewProps {
  focusedNotificationId?: number | null;
  onClearFocusedNotification?: () => void;
  onOpenTrip: (tripId: number) => void;
  onOpenMaintenance?: () => void;
  onUnreadCountChanged?: (unreadCount: number) => void;
}

const MAINTENANCE_EVENT_PREFIXES = [
  'VEHICLE_SERVICE_DUE',
  'GARAGE_VISIT_',
  'PARTS_PURCHASE_',
  'MAINTENANCE_LOG_',
];

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  focusedNotificationId = null,
  onClearFocusedNotification,
  onOpenTrip,
  onOpenMaintenance,
  onUnreadCountChanged,
}) => {
  const [items, setItems] = useState<NotificationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filterUnread, setFilterUnread] = useState(false);
  const [filterHigh, setFilterHigh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checkingOverdue, setCheckingOverdue] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offlineUpdatedAt, setOfflineUpdatedAt] = useState<string | null>(null);
  const [pushPrefs, setPushPrefsState] = useState<PushPreferences>(() => getPushPreferences());
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    getNotificationPermissionState()
  );
  const [testingPush, setTestingPush] = useState(false);

  useEffect(() => {
    const syncPrefs = () => {
      setPushPrefsState(getPushPreferences());
      setNotifPerm(getNotificationPermissionState());
    };
    window.addEventListener(PUSH_PREFS_EVENT, syncPrefs);
    return () => window.removeEventListener(PUSH_PREFS_EVENT, syncPrefs);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listNotifications({
        unreadOnly: filterUnread,
        priority: filterHigh ? 'HIGH' : '',
        limit: 50,
      });
      setItems(res.items);
      setTotal(res.total);
      setUnreadCount(res.unreadCount);
      setOfflineUpdatedAt(null);
      onUnreadCountChanged?.(res.unreadCount);

      if (!filterUnread && !filterHigh) {
        writeCachedEntry<CachedNotificationsPayload>(CACHE_KEYS.notifications, {
          items: res.items,
          total: res.total,
          unreadCount: res.unreadCount,
        });
      }
      void processIncomingNotifications(res.items);
    } catch (err) {
      const offline =
        (typeof navigator !== 'undefined' && navigator.onLine === false) ||
        isLikelyNetworkError(err);
      if (offline) {
        const cached = readCachedEntry<CachedNotificationsPayload>(CACHE_KEYS.notifications);
        if (cached) {
          const allCached = cached.data.items;
          const unreadCached = allCached.filter((n) => !n.read_at).length;
          const filtered = allCached.filter((n) => {
            if (filterUnread && n.read_at) return false;
            if (filterHigh && n.priority !== 'HIGH') return false;
            return true;
          });
          setItems(filtered);
          setTotal(filtered.length);
          setUnreadCount(unreadCached);
          onUnreadCountChanged?.(unreadCached);
          setOfflineUpdatedAt(cached.updatedAt);
          setError(null);
          return;
        }
      }
      setError(err instanceof ApiError ? err.message : 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, [filterUnread, filterHigh, onUnreadCountChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleReconnect = () => {
      void load();
    };
    window.addEventListener(ONLINE_RECONNECTED_EVENT, handleReconnect);
    window.addEventListener(OFFLINE_SYNCED_EVENT, handleReconnect);
    window.addEventListener(REFRESH_NOTIFICATIONS_EVENT, handleReconnect);
    window.addEventListener(MAINTENANCE_UPDATED_EVENT, handleReconnect);
    return () => {
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, handleReconnect);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, handleReconnect);
      window.removeEventListener(REFRESH_NOTIFICATIONS_EVENT, handleReconnect);
      window.removeEventListener(MAINTENANCE_UPDATED_EVENT, handleReconnect);
    };
  }, [load]);

  // Reset filters when navigating directly to a specific notification from a device push alert
  useEffect(() => {
    if (!focusedNotificationId) return;
    if (filterUnread) setFilterUnread(false);
    if (filterHigh) setFilterHigh(false);
  }, [focusedNotificationId, filterUnread, filterHigh]);

  // Scroll the focused alert card into view once loaded
  useEffect(() => {
    if (!focusedNotificationId || loading) return;
    const el = document.getElementById(`notification-card-${focusedNotificationId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusedNotificationId, loading, items]);

  const handleTogglePush = async (enabled: boolean) => {
    unlockNotificationAudio();
    const updated = setPushPreferences({ pushEnabled: enabled });
    setPushPrefsState(updated);
    if (enabled && notifPerm === 'default') {
      const perm = await requestBrowserNotificationPermission();
      setNotifPerm(perm);
    }
  };

  const handleToggleSound = (enabled: boolean) => {
    unlockNotificationAudio();
    const updated = setPushPreferences({ soundEnabled: enabled });
    setPushPrefsState(updated);
  };

  const handleTestPush = async () => {
    setTestingPush(true);
    try {
      unlockNotificationAudio();
      const res = await testNotificationAndSound();
      setNotifPerm(res.permission);
      setNotice(
        res.notificationShown
          ? 'Test chime played and alert sent to your device notification area.'
          : 'Test sound chime played.'
      );
    } finally {
      setTestingPush(false);
    }
  };

  const handleMarkRead = async (item: NotificationRecord) => {
    if (item.read_at) return;
    try {
      const res = await api.markNotificationRead(item.id);
      setItems((prev) => prev.map((n) => (n.id === item.id ? res.notification : n)));
      const nextUnread = Math.max(0, unreadCount - 1);
      setUnreadCount(nextUnread);
      onUnreadCountChanged?.(nextUnread);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark notification as read.');
    }
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    setError(null);
    try {
      await api.markAllNotificationsRead();
      setUnreadCount(0);
      onUnreadCountChanged?.(0);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark all notifications as read.');
    } finally {
      setMarkingAll(false);
    }
  };

  const handleCheckOverdue = async () => {
    setCheckingOverdue(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.checkOverdueHires();
      setNotice(
        res.newlyNotified > 0
          ? `Found ${res.newlyNotified} newly overdue hire/service alert${res.newlyNotified === 1 ? '' : 's'} and updated your inbox.`
          : `Checked ${res.checked} open hire${res.checked === 1 ? '' : 's'} and vehicle service dues. No new alerts.`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check overdue hires & service dues.');
    } finally {
      setCheckingOverdue(false);
    }
  };

  const handleOpenRelatedTrip = async (item: NotificationRecord) => {
    if (!item.read_at) {
      await handleMarkRead(item);
    }
    if (item.trip_id) {
      onOpenTrip(item.trip_id);
    }
  };

  const handleOpenRelatedMaintenance = async (item: NotificationRecord) => {
    if (!item.read_at) {
      await handleMarkRead(item);
    }
    onOpenMaintenance?.();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Notifications Inbox</h1>
          <p className="mt-1 text-base text-slate-600">
            Alerts for every trip, mileage gap, fuel mismatch, overdue hire, next service due, and maintenance approval.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCheckOverdue}
            disabled={checkingOverdue}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900 disabled:opacity-60 whitespace-nowrap"
          >
            <RefreshCw className={`h-4 w-4 text-cyan-600 ${checkingOverdue ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>{checkingOverdue ? 'Checking...' : 'Check Due Hires & Service'}</span>
          </button>

          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={markingAll}
              className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-2 rounded-xl px-4 text-sm font-semibold disabled:opacity-60 whitespace-nowrap"
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
              <span>{markingAll ? 'Marking...' : 'Mark All Read'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Quick Sound & Device Push Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-200/80 bg-cyan-50/50 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <img
            src="/pwa-192x192.png"
            alt="Fleet Secure tray icon"
            className="h-9 w-9 rounded-lg border border-blue-200 bg-white object-cover shrink-0"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-blue-950">
              <input
                type="checkbox"
                checked={pushPrefs.pushEnabled}
                onChange={(e) => void handleTogglePush(e.target.checked)}
                className="h-4 w-4 rounded border-blue-300 text-cyan-600 accent-cyan-600"
              />
              <BellRing className="h-4 w-4 text-cyan-600" aria-hidden="true" />
              <span>Device Push Alerts</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 font-semibold text-blue-950">
              <input
                type="checkbox"
                checked={pushPrefs.soundEnabled}
                onChange={(e) => handleToggleSound(e.target.checked)}
                className="h-4 w-4 rounded border-blue-300 text-cyan-600 accent-cyan-600"
              />
              {pushPrefs.soundEnabled ? (
                <Volume2 className="h-4 w-4 text-cyan-600" aria-hidden="true" />
              ) : (
                <VolumeX className="h-4 w-4 text-slate-500" aria-hidden="true" />
              )}
              <span>Sound Chime</span>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {notifPerm === 'default' && (
            <button
              type="button"
              onClick={async () => {
                unlockNotificationAudio();
                const perm = await requestBrowserNotificationPermission();
                setNotifPerm(perm);
              }}
              className="cyan-glow-btn min-h-[38px] rounded-xl px-3.5 text-xs font-semibold whitespace-nowrap"
            >
              Allow Device Alerts
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleTestPush()}
            disabled={testingPush}
            className="cyan-glow-outline min-h-[38px] rounded-xl border border-blue-200 bg-white px-3.5 text-xs font-semibold text-blue-900 whitespace-nowrap disabled:opacity-60"
          >
            {testingPush ? 'Testing...' : 'Test Sound & Alert'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-200/80 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setFilterUnread(false)}
            className={`min-h-[44px] rounded-xl border px-4 text-sm font-semibold whitespace-nowrap transition-all ${
              !filterUnread
                ? 'cyan-glow-active'
                : 'border-blue-200 bg-white text-blue-900 cyan-glow-outline'
            }`}
          >
            All Alerts
          </button>
          <button
            type="button"
            onClick={() => setFilterUnread(true)}
            className={`min-h-[44px] rounded-xl border px-4 text-sm font-semibold whitespace-nowrap transition-all ${
              filterUnread
                ? 'cyan-glow-active'
                : 'border-blue-200 bg-white text-blue-900 cyan-glow-outline'
            }`}
          >
            Unread ({unreadCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterHigh((v) => !v)}
            className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-4 text-sm font-semibold whitespace-nowrap ${
              filterHigh
                ? 'bg-red-700 text-white'
                : 'border border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
            }`}
          >
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <span>High Priority Only</span>
          </button>
        </div>

        <span className="text-sm font-medium text-blue-700 font-mono tabular-nums">
          {total} {total === 1 ? 'alert' : 'alerts'}
        </span>
      </div>

      {offlineUpdatedAt && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-950"
        >
          <WifiOff className="h-4 w-4 text-amber-700 shrink-0" aria-hidden="true" />
          <span>
            Offline mode — showing cached notifications (last updated{' '}
            {formatHarareTime(offlineUpdatedAt)}). Will refresh instantly when connected.
          </span>
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

      {notice && (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"
        >
          {notice}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-white" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-blue-200/80 bg-white p-10 text-center">
          <Bell className="mx-auto h-10 w-10 text-cyan-500" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-semibold text-blue-950">
            {filterUnread ? 'You are all caught up' : 'No notifications yet'}
          </h2>
          <p className="mt-1 text-base text-slate-600">
            {filterUnread
              ? 'All alerts in your inbox have been marked as read.'
              : 'Trip activity, overdue hires, and flagged records will appear here automatically.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const isHigh = item.priority === 'HIGH';
            const isUnread = !item.read_at;
            const isFocused = focusedNotificationId === item.id;
            const isMaintenanceEvent = MAINTENANCE_EVENT_PREFIXES.some((prefix) =>
              item.event_type.startsWith(prefix)
            );
            return (
              <div
                key={item.id}
                id={`notification-card-${item.id}`}
                className={`cyan-glow-card rounded-2xl border p-4 sm:p-5 transition-all ${
                  isFocused
                    ? 'ring-2 ring-cyan-500 ring-offset-2 border-cyan-500 shadow-md bg-cyan-50/40'
                    : isHigh
                      ? isUnread
                        ? 'border-red-300 bg-red-50/70'
                        : 'border-red-200 bg-white'
                      : isUnread
                        ? 'border-cyan-300 bg-white'
                        : 'border-blue-100 bg-blue-50/30'
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      {isFocused && (
                        <>
                          <span className="inline-flex items-center gap-1 rounded bg-cyan-600 px-2 py-0.5 text-[11px] font-bold text-white">
                            Opened from alert
                          </span>
                          {onClearFocusedNotification && (
                            <button
                              type="button"
                              onClick={onClearFocusedNotification}
                              className="text-xs font-semibold text-cyan-800 underline hover:text-cyan-950"
                            >
                              Clear focus
                            </button>
                          )}
                          <span aria-hidden="true" className="text-slate-400">·</span>
                        </>
                      )}
                      {isHigh && (
                        <span className="inline-flex items-center gap-1 font-bold uppercase tracking-wide text-red-700">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          HIGH PRIORITY
                        </span>
                      )}
                      {isHigh && <span aria-hidden="true" className="text-slate-400">·</span>}
                      <span className={`font-semibold ${isUnread ? 'text-blue-700' : 'text-slate-500'}`}>
                        {isUnread ? 'UNREAD' : 'READ'}
                      </span>
                      <span aria-hidden="true" className="text-slate-400">·</span>
                      <span className="font-mono text-slate-500">{item.event_type}</span>
                      <span aria-hidden="true" className="text-slate-400">·</span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatHarareTime(item.created_at)}
                      </span>
                    </div>

                    <h3 className="text-base font-bold text-blue-950">{item.title}</h3>
                    <p className="text-sm text-slate-700 leading-relaxed">{item.body}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {item.trip_id && (
                      <button
                        type="button"
                        onClick={() => handleOpenRelatedTrip(item)}
                        className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-4 text-sm font-semibold whitespace-nowrap"
                      >
                        <span>Open Trip #{item.trip_id}</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}

                    {!item.trip_id && isMaintenanceEvent && onOpenMaintenance && (
                      <button
                        type="button"
                        onClick={() => handleOpenRelatedMaintenance(item)}
                        className="cyan-glow-btn inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-4 text-sm font-semibold whitespace-nowrap"
                      >
                        <span>Open Maintenance</span>
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}

                    {isUnread && (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(item)}
                        className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-blue-200 bg-white px-3.5 text-sm font-semibold text-blue-900 whitespace-nowrap"
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        <span>Mark Read</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
