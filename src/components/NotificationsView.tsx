import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  CheckCheck,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatHarareTime, type NotificationRecord } from '../shared/types';

interface NotificationsViewProps {
  onOpenTrip: (tripId: number) => void;
  onUnreadCountChanged?: (unreadCount: number) => void;
}

export const NotificationsView: React.FC<NotificationsViewProps> = ({
  onOpenTrip,
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
      onUnreadCountChanged?.(res.unreadCount);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, [filterUnread, filterHigh, onUnreadCountChanged]);

  useEffect(() => {
    void load();
  }, [load]);

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
          ? `Found ${res.newlyNotified} newly overdue hire${res.newlyNotified === 1 ? '' : 's'} and added high-priority alert(s).`
          : `Checked ${res.checked} open hire${res.checked === 1 ? '' : 's'}. No new overdue alerts.`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check overdue hires.');
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">Notifications Inbox</h1>
          <p className="mt-1 text-base text-slate-600">
            Alerts for every trip, mileage gap, fuel mismatch, overdue hire, and security lockout.
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
            <span>{checkingOverdue ? 'Checking...' : 'Check Overdue Hires'}</span>
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
            return (
              <div
                key={item.id}
                className={`cyan-glow-card rounded-2xl border p-4 sm:p-5 transition-colors ${
                  isHigh
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
