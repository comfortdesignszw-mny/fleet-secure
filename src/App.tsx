/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell,
  Car,
  ClipboardList,
  FileSpreadsheet,
  HelpCircle,
  Home,
  KeyRound,
  LogOut,
  Menu,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { en } from './i18n/en';
import {
  ApiError,
  api,
  checkServerReachable,
  clearCachedSession,
  getCachedSettings,
  getCachedUser,
} from './lib/api';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import {
  OFFLINE_QUEUE_EVENT,
  OFFLINE_SYNCED_EVENT,
  flushOfflineQueue,
  getOfflineQueue,
  isLikelyNetworkError,
} from './lib/offlineQueue';
import { ONLINE_RECONNECTED_EVENT, warmOfflineCaches } from './lib/offlineCache';
import {
  MAINTENANCE_UPDATED_EVENT,
  OPEN_NOTIFICATION_EVENT,
  PUSH_PREFS_EVENT,
  REFRESH_NOTIFICATIONS_EVENT,
  getNotificationPermissionState,
  getPushPreferences,
  installAudioUnlockListeners,
  processIncomingNotifications,
  requestBrowserNotificationPermission,
  requestNotificationsRefresh,
  unlockNotificationAudio,
} from './lib/pushNotifications';
import { DEFAULT_SETTINGS, ROLE_LABELS, type AppSettings, type UserPublic } from './shared/types';
import { AppFooter } from './components/AppFooter';
import { AuditLogView } from './components/AuditLogView';
import { DriversView } from './components/DriversView';
import { FleetMaintenanceView } from './components/FleetMaintenanceView';
import { HelpView } from './components/HelpView';
import { HomeView, type NavSection } from './components/HomeView';
import { LoginView } from './components/LoginView';
import { NotificationsView } from './components/NotificationsView';
import { OfflineIndicator } from './components/OfflineIndicator';
import { OnboardingWalkthroughModal } from './components/OnboardingWalkthroughModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { ReportsView } from './components/ReportsView';
import { SettingsView, type SettingsTab } from './components/SettingsView';
import { TripsView } from './components/TripsView';
import { VehiclesView } from './components/VehiclesView';

export default function App() {
  const isOnline = useOnlineStatus();
  const [user, setUser] = useState<UserPublic | null>(() => getCachedUser());
  const [authChecked, setAuthChecked] = useState<boolean>(() => Boolean(getCachedUser()));
  const [section, setSection] = useState<NavSection>('home');
  const [homeResetKey, setHomeResetKey] = useState(0);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [selectedTripId, setSelectedTripId] = useState<number | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);
  const [selectedNotificationId, setSelectedNotificationId] = useState<number | null>(null);
  const [pendingNotificationLink, setPendingNotificationLink] = useState<{
    notificationId: number | null;
  } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get('section') !== 'notifications') return null;
    const rawId = params.get('notificationId');
    const parsedId = rawId ? Number(rawId) : NaN;
    return {
      notificationId: Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null,
    };
  });
  const [settings, setSettings] = useState<AppSettings>(
    () => getCachedSettings() ?? DEFAULT_SETTINGS
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [highUnreadNotifications, setHighUnreadNotifications] = useState(0);
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(
    () => getOfflineQueue().length
  );
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<{
    tone: 'ok' | 'warn';
    text: string;
  } | null>(null);
  const [pushPrefs, setPushPrefs] = useState(() => getPushPreferences());
  const [notifPerm, setNotifPerm] = useState(() => getNotificationPermissionState());
  const [permBannerDismissed, setPermBannerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('fleet_secure_notif_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });

  const verifySession = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearCachedSession();
        setUser(null);
      } else if (!isLikelyNetworkError(err) && !getCachedUser()) {
        setUser(null);
      }
      // On network/offline drop, preserve the cached authenticated user session
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    void verifySession();
  }, [verifySession]);

  useEffect(() => {
    const refreshQueueCount = () => {
      setPendingQueueCount(getOfflineQueue().length);
    };
    window.addEventListener(OFFLINE_QUEUE_EVENT, refreshQueueCount);
    window.addEventListener('storage', refreshQueueCount);
    return () => {
      window.removeEventListener(OFFLINE_QUEUE_EVENT, refreshQueueCount);
      window.removeEventListener('storage', refreshQueueCount);
    };
  }, []);

  const triggerSync = useCallback(
    async (manual: boolean) => {
      if (syncingNow) return;
      setSyncingNow(true);
      try {
        const reachable = manual ? await checkServerReachable(2500) : isOnline;
        if (!reachable) {
          if (manual) {
            const qCount = getOfflineQueue().length;
            setSyncFeedback({
              tone: 'warn',
              text:
                qCount > 0
                  ? `Offline — ${qCount} record${qCount === 1 ? '' : 's'} saved in local cache.`
                  : 'Offline — working from local cache.',
            });
          }
          return;
        }

        await verifySession();
        const result = await flushOfflineQueue();
        setPendingQueueCount(result.remaining.length);

        if (result.syncedCount > 0 && result.failedCount === 0) {
          setSyncFeedback({
            tone: 'ok',
            text: `Synced ${result.syncedCount} offline record${result.syncedCount === 1 ? '' : 's'} to cloud.`,
          });
        } else if (result.failedCount > 0) {
          setSyncFeedback({
            tone: 'warn',
            text: `Synced ${result.syncedCount}; ${result.failedCount} item${result.failedCount === 1 ? '' : 's'} still pending.`,
          });
        } else if (manual) {
          setSyncFeedback({
            tone: 'ok',
            text: 'All records are synced and up to date.',
          });
        }
      } finally {
        setSyncingNow(false);
      }
    },
    [isOnline, syncingNow, verifySession]
  );

  useEffect(() => {
    if (!syncFeedback) return;
    const timer = window.setTimeout(() => setSyncFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [syncFeedback]);

  // Unlock Web Audio on first user interaction and keep push preferences in sync
  useEffect(() => {
    const cleanupAudio = installAudioUnlockListeners();
    const onPrefs = () => setPushPrefs(getPushPreferences());
    window.addEventListener(PUSH_PREFS_EVENT, onPrefs);
    return () => {
      cleanupAudio();
      window.removeEventListener(PUSH_PREFS_EVENT, onPrefs);
    };
  }, []);

  // Immediate auto-sync, session verification, and offline cache warming on connection
  useEffect(() => {
    if (!user || !isOnline) return;
    void verifySession();
    if (!user.must_change_pin) {
      void warmOfflineCaches(user.role);
    }
    if (getOfflineQueue().length > 0) {
      void triggerSync(false);
    }
  }, [isOnline, user?.id, user?.must_change_pin, user?.role]);

  // Force refresh all offline snapshots when network reconnects or offline queue finishes syncing
  useEffect(() => {
    if (!user || user.must_change_pin) return;
    const onReconnected = () => {
      void warmOfflineCaches(user.role, { force: true });
    };
    window.addEventListener(ONLINE_RECONNECTED_EVENT, onReconnected);
    window.addEventListener(OFFLINE_SYNCED_EVENT, onReconnected);
    return () => {
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, onReconnected);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onReconnected);
    };
  }, [user?.id, user?.role, user?.must_change_pin]);

  useEffect(() => {
    if (!user || user.must_change_pin) return;
    api
      .getSettings()
      .then((res) => setSettings(res.settings))
      .catch(() => {
        // Keep cached/default settings if offline
      });
  }, [user, isOnline]);

  // Apply deep-linked notification route from URL or Service Worker click once user session is ready
  useEffect(() => {
    if (!user || user.must_change_pin || !pendingNotificationLink) return;
    const isAlertUser =
      user.role === 'SUPERVISOR' || user.role === 'FLEET_MANAGER' || user.role === 'ADMIN';
    if (isAlertUser) {
      setSection('notifications');
      setSelectedNotificationId(pendingNotificationLink.notificationId);
      setSelectedTripId(null);
      setSelectedVehicleId(null);
      setMobileMenuOpen(false);
      requestNotificationsRefresh();
    }
    setPendingNotificationLink(null);
    if (typeof window !== 'undefined' && window.location.search.includes('section=notifications')) {
      window.history.replaceState({}, '', window.location.pathname || '/');
    }
  }, [user, pendingNotificationLink]);

  // Handle notification click events from browser Notification API fallback or SW postMessage
  useEffect(() => {
    const openFromPayload = (payload: {
      notificationId?: unknown;
      tripId?: unknown;
    } | null) => {
      const rawId = payload?.notificationId;
      const parsedId = typeof rawId === 'number' || typeof rawId === 'string' ? Number(rawId) : NaN;
      const cleanId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;

      if (!user || user.must_change_pin) {
        setPendingNotificationLink({ notificationId: cleanId });
        return;
      }

      const isAlertUser =
        user.role === 'SUPERVISOR' || user.role === 'FLEET_MANAGER' || user.role === 'ADMIN';
      if (!isAlertUser) return;

      setSection('notifications');
      setSelectedNotificationId(cleanId);
      setSelectedTripId(null);
      setSelectedVehicleId(null);
      setMobileMenuOpen(false);
      requestNotificationsRefresh();
    };

    const onCustomOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ notificationId?: unknown; tripId?: unknown }>).detail;
      openFromPayload(detail ?? null);
    };

    const onSwMessage = (ev: MessageEvent) => {
      if (ev.data && typeof ev.data === 'object' && ev.data.type === 'OPEN_NOTIFICATION') {
        openFromPayload(ev.data as { notificationId?: unknown; tripId?: unknown });
      }
    };

    window.addEventListener(OPEN_NOTIFICATION_EVENT, onCustomOpen);
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }
    return () => {
      window.removeEventListener(OPEN_NOTIFICATION_EVENT, onCustomOpen);
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage);
      }
    };
  }, [user]);

  useEffect(() => {
    if (!user || user.must_change_pin || !isOnline) return;
    const isAlertUser =
      user.role === 'SUPERVISOR' || user.role === 'FLEET_MANAGER' || user.role === 'ADMIN';
    if (!isAlertUser) {
      setUnreadNotifications(0);
      setHighUnreadNotifications(0);
      return;
    }

    let cancelled = false;
    const canScanOverdue =
      user.role === 'SUPERVISOR' || user.role === 'FLEET_MANAGER' || user.role === 'ADMIN';
    const refreshCount = (checkOverdue = false) => {
      const preCheck =
        checkOverdue && canScanOverdue
          ? api.checkOverdueHires().catch(() => undefined)
          : Promise.resolve();
      void preCheck.then(() =>
        api
          .getUnreadNotificationsCount()
          .then((res) => {
            if (cancelled) return;
            setUnreadNotifications(res.unreadCount);
            setHighUnreadNotifications(res.highUnreadCount);
            if (res.latestUnread && res.latestUnread.length > 0) {
              void processIncomingNotifications(res.latestUnread);
            }
          })
          .catch(() => {
            // Ignore transient offline errors
          })
      );
    };

    refreshCount(true);
    const timer = window.setInterval(() => refreshCount(true), 30_000);
    const onReconnect = () => refreshCount(true);
    const onImmediateRefresh = () => refreshCount(false);
    window.addEventListener(ONLINE_RECONNECTED_EVENT, onReconnect);
    window.addEventListener(OFFLINE_SYNCED_EVENT, onReconnect);
    window.addEventListener(REFRESH_NOTIFICATIONS_EVENT, onImmediateRefresh);
    window.addEventListener(MAINTENANCE_UPDATED_EVENT, onImmediateRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(ONLINE_RECONNECTED_EVENT, onReconnect);
      window.removeEventListener(OFFLINE_SYNCED_EVENT, onReconnect);
      window.removeEventListener(REFRESH_NOTIFICATIONS_EVENT, onImmediateRefresh);
      window.removeEventListener(MAINTENANCE_UPDATED_EVENT, onImmediateRefresh);
    };
  }, [user, section, isOnline]);

  useEffect(() => {
    if (!user || user.must_change_pin) return;
    try {
      const key = `fleet_secure_walkthrough_done_${user.id}_${user.role}`;
      if (!localStorage.getItem(key)) {
        setShowWalkthrough(true);
      }
    } catch {
      // Ignore storage error
    }
  }, [user]);

  const dismissWalkthrough = () => {
    if (user) {
      try {
        localStorage.setItem(`fleet_secure_walkthrough_done_${user.id}_${user.role}`, '1');
      } catch {
        // Ignore
      }
    }
    setShowWalkthrough(false);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      clearCachedSession();
    } finally {
      setUser(null);
      setSection('home');
      setMobileMenuOpen(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#F4F9FF] flex items-center justify-center p-6">
        <div className="text-base font-semibold text-blue-800">Loading Fleet Secure...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginView
          onSuccess={(loggedInUser) => {
            setUser(loggedInUser);
            setSection('home');
            setHomeResetKey((k) => k + 1);
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  const isSupervisorOrAdmin = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
  const isAlertRecipient = isSupervisorOrAdmin || user.role === 'FLEET_MANAGER';
  const isAdmin = user.role === 'ADMIN';

  const navItems: {
    id: NavSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    visible: boolean;
  }[] = [
    { id: 'home', label: en.nav.home, icon: Home, visible: true },
    { id: 'trips', label: en.nav.trips, icon: ClipboardList, visible: true },
    { id: 'vehicles', label: en.nav.vehicles, icon: Car, visible: true },
    { id: 'maintenance', label: en.nav.maintenance, icon: Wrench, visible: true },
    { id: 'drivers', label: en.nav.drivers, icon: Users, visible: true },
    { id: 'notifications', label: en.nav.notifications, icon: Bell, visible: isAlertRecipient },
    { id: 'audit', label: en.nav.auditLog, icon: ShieldCheck, visible: isSupervisorOrAdmin },
    { id: 'reports', label: en.nav.reports, icon: FileSpreadsheet, visible: isSupervisorOrAdmin },
    { id: 'settings', label: en.nav.settings, icon: SlidersHorizontal, visible: true },
    { id: 'help', label: en.nav.help, icon: HelpCircle, visible: true },
  ];

  const visibleNav = navItems.filter((item) => item.visible);
  const mobileBottomNav = visibleNav.filter((item) =>
    [
      'home',
      'trips',
      'vehicles',
      user.role === 'FLEET_MANAGER'
        ? 'maintenance'
        : isSupervisorOrAdmin
          ? 'audit'
          : 'settings',
    ].includes(item.id)
  );

  const navigateTo = (next: NavSection, tripId?: number) => {
    setSelectedTripId(tripId ?? null);
    setSelectedVehicleId(null);
    setSelectedNotificationId(null);
    setMobileMenuOpen(false);
    if (next === 'home' || next === 'dashboard') {
      setSection('home');
      setHomeResetKey((k) => k + 1);
      return;
    }
    if (next === 'change-pin') {
      setSettingsTab('pin');
      setSection('settings');
      return;
    }
    if (next === 'settings') {
      setSettingsTab(user.must_change_pin || !isAdmin ? 'pin' : 'general');
    }
    setSection(next);
  };

  const openPinChangeInSettings = () => {
    setSelectedTripId(null);
    setSelectedVehicleId(null);
    setSelectedNotificationId(null);
    setSettingsTab('pin');
    setSection('settings');
    setMobileMenuOpen(false);
  };

  const openVehicleFromDashboard = (vid: number) => {
    setSelectedVehicleId(vid);
    setSelectedTripId(null);
    setSelectedNotificationId(null);
    setSection('vehicles');
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#F4F9FF] text-slate-900 flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:border-r md:border-blue-100 md:bg-white md:shrink-0">
        <div className="flex h-16 items-center gap-2.5 border-b border-blue-100 px-5">
          <img
            src="/pwa-192x192.png"
            alt="Fleet Secure logo"
            referrerPolicy="no-referrer"
            className="h-9 w-9 rounded-xl shadow-sm shadow-cyan-500/30 object-cover shrink-0 ring-1 ring-blue-200/80"
          />
          <span className="font-display text-lg font-bold tracking-tight text-blue-950 whitespace-nowrap">
            {en.appName}
          </span>
        </div>

        <nav className="flex-1 space-y-1.5 p-3" aria-label="Main navigation">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`flex w-full min-h-[44px] items-center justify-between gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-all whitespace-nowrap ${
                  active
                    ? 'cyan-glow-active'
                    : 'border-transparent text-slate-700 cyan-glow-outline'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`h-5 w-5 shrink-0 ${active ? 'text-cyan-200' : 'text-blue-600'}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'notifications' && unreadNotifications > 0 && (
                  <span
                    className={`font-mono tabular-nums text-xs font-bold px-1.5 py-0.5 rounded-md ${
                      active
                        ? 'bg-white text-blue-900'
                        : highUnreadNotifications > 0
                          ? 'bg-red-100 text-red-800'
                          : 'bg-cyan-100 text-cyan-900'
                    }`}
                  >
                    {unreadNotifications}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-blue-100 p-4 space-y-3 bg-gradient-to-b from-white to-blue-50/40">
          <div>
            <div className="text-sm font-semibold text-blue-950 truncate">{user.full_name}</div>
            <div className="text-xs text-slate-500 truncate">
              {user.username} · {ROLE_LABELS[user.role]}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="cyan-glow-outline flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-blue-200 bg-white px-3 text-sm font-semibold text-blue-900"
          >
            <LogOut className="h-4 w-4 text-blue-600" aria-hidden="true" />
            <span>{en.auth.signOut}</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top Bar (3-zone contract) */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-blue-100 bg-white/95 backdrop-blur-sm px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              className="cyan-glow-outline flex md:hidden min-h-[44px] min-w-[44px] -ml-2 items-center justify-center rounded-lg border border-transparent text-blue-800"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 md:hidden min-w-0">
              <img
                src="/pwa-192x192.png"
                alt="Fleet Secure logo"
                referrerPolicy="no-referrer"
                className="h-7 w-7 rounded-lg shadow-xs object-cover shrink-0 ring-1 ring-blue-200/80"
              />
              <span className="font-display text-base font-bold text-blue-950 truncate">
                {en.appName}
              </span>
            </div>
            <span className="hidden md:inline text-sm font-medium text-blue-700/80 truncate">
              {settings.company_name} <span className="text-cyan-500">/</span>{' '}
              <span className="font-semibold text-blue-950">
                {visibleNav.find((n) => n.id === section)?.label ?? 'Account'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <button
              type="button"
              onClick={() => void triggerSync(true)}
              disabled={syncingNow}
              title={
                pendingQueueCount > 0
                  ? `Sync ${pendingQueueCount} offline record${pendingQueueCount === 1 ? '' : 's'} now`
                  : isOnline
                    ? 'Sync records now'
                    : 'Offline — tap to check connection and sync'
              }
              aria-label={
                pendingQueueCount > 0
                  ? `Sync ${pendingQueueCount} pending offline records`
                  : 'Manual cloud sync'
              }
              className={`relative inline-flex h-10 w-10 items-center justify-center rounded-full border transition-all ${
                pendingQueueCount > 0
                  ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                  : !isOnline
                    ? 'border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-200'
                    : 'border-blue-200 bg-white text-blue-700 hover:border-cyan-400 hover:text-cyan-700 cyan-glow-outline'
              }`}
            >
              <RefreshCw
                className={`h-4 w-4 ${syncingNow ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {pendingQueueCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-600 px-1 font-mono text-[10px] font-bold text-white shadow-xs">
                  {pendingQueueCount}
                </span>
              )}
            </button>
            {isAlertRecipient && (
              <button
                type="button"
                onClick={() => navigateTo('notifications')}
                aria-label={`Notifications inbox, ${unreadNotifications} unread`}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold whitespace-nowrap transition-all ${
                  highUnreadNotifications > 0
                    ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100'
                    : unreadNotifications > 0
                      ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      : 'border-blue-200 bg-white text-blue-800 cyan-glow-outline'
                }`}
              >
                <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="font-mono tabular-nums">{unreadNotifications}</span>
                <span className="hidden sm:inline">Alerts</span>
              </button>
            )}
            <PWAInstallButton />
            <button
              type="button"
              onClick={handleLogout}
              className="cyan-glow-outline md:hidden inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-sm font-medium text-blue-900 whitespace-nowrap"
            >
              <LogOut className="h-4 w-4 text-blue-600" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </header>

        {syncFeedback && (
          <div className="px-4 sm:px-6 pt-3 max-w-6xl w-full mx-auto">
            <div
              role="status"
              className={`rounded-xl border px-4 py-2.5 text-sm font-medium shadow-xs ${
                syncFeedback.tone === 'ok'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  : 'border-amber-300 bg-amber-50 text-amber-900'
              }`}
            >
              {syncFeedback.text}
            </div>
          </div>
        )}

        {isAlertRecipient &&
          !user.must_change_pin &&
          pushPrefs.pushEnabled &&
          notifPerm === 'default' &&
          !permBannerDismissed && (
            <div className="px-4 sm:px-6 pt-3 max-w-6xl w-full mx-auto">
              <div
                role="region"
                aria-label="Enable device push notifications"
                className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-cyan-300 bg-cyan-50/90 px-4 py-3 text-sm text-blue-950 shadow-xs"
              >
                <div className="flex items-center gap-2.5">
                  <Bell className="h-4 w-4 shrink-0 text-cyan-700" aria-hidden="true" />
                  <span>
                    Allow device notifications so overdue hire returns and flagged trips alert your notification tray with sound.
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={async () => {
                      unlockNotificationAudio();
                      const res = await requestBrowserNotificationPermission();
                      setNotifPerm(res);
                    }}
                    className="cyan-glow-btn min-h-[38px] rounded-lg px-3.5 text-xs font-semibold whitespace-nowrap"
                  >
                    Enable Sound &amp; Alerts
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPermBannerDismissed(true);
                      try {
                        localStorage.setItem('fleet_secure_notif_banner_dismissed', '1');
                      } catch {
                        // Ignore
                      }
                    }}
                    className="min-h-[38px] rounded-lg px-2.5 text-xs font-medium text-blue-800 hover:bg-cyan-100"
                  >
                    Not now
                  </button>
                </div>
              </div>
            </div>
          )}

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <div
              className="fixed inset-0 bg-blue-950/45 backdrop-blur-[1px]"
              onClick={() => setMobileMenuOpen(false)}
              aria-hidden="true"
            />
            <div className="relative z-10 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl border-r border-blue-100">
              <div className="flex h-14 items-center justify-between border-b border-blue-100 px-4">
                <div className="flex items-center gap-2">
                  <img
                    src="/pwa-192x192.png"
                    alt="Fleet Secure logo"
                    referrerPolicy="no-referrer"
                    className="h-8 w-8 rounded-lg shadow-xs object-cover shrink-0 ring-1 ring-blue-200/80"
                  />
                  <span className="font-display text-lg font-bold text-blue-950">{en.appName}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close menu"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-blue-700 hover:bg-cyan-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto p-3 space-y-1">
                {visibleNav.map((item) => {
                  const Icon = item.icon;
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => navigateTo(item.id)}
                      className={`flex w-full min-h-[48px] items-center justify-between gap-3 rounded-xl border px-3.5 text-base font-semibold transition-all ${
                        active
                          ? 'cyan-glow-active'
                          : 'border-transparent text-slate-700 hover:bg-cyan-50 hover:text-blue-900'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <Icon
                          className={`h-5 w-5 shrink-0 ${active ? 'text-cyan-200' : 'text-blue-600'}`}
                          aria-hidden="true"
                        />
                        <span>{item.label}</span>
                      </span>
                      {item.id === 'notifications' && unreadNotifications > 0 && (
                        <span className="font-mono tabular-nums text-xs font-bold px-2 py-0.5 rounded-md bg-red-100 text-red-800">
                          {unreadNotifications}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
              <div className="border-t border-blue-100 p-4 bg-blue-50/40">
                <div className="text-sm font-semibold text-blue-950">{user.full_name}</div>
                <div className="text-xs text-slate-500">
                  {user.username} · {ROLE_LABELS[user.role]}
                </div>
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 md:p-8 max-w-6xl w-full mx-auto">
          {(section === 'home' || section === 'dashboard') && (
            <HomeView
              user={user}
              companyName={settings.company_name}
              homeResetKey={homeResetKey}
              onNavigate={navigateTo}
              onOpenVehicle={openVehicleFromDashboard}
              onOpenPinSettings={openPinChangeInSettings}
            />
          )}
          {(section === 'settings' || section === 'change-pin') && (
            <SettingsView
              currentUser={user}
              initialTab={settingsTab}
              onSettingsChanged={(updated) => setSettings(updated)}
              onUserUpdated={(updatedUser) => setUser(updatedUser)}
              onBackHome={() => navigateTo('home')}
            />
          )}
          {section === 'help' && (
            <HelpView
              userRole={user.role}
              onReplayWalkthrough={() => setShowWalkthrough(true)}
            />
          )}
          {user.must_change_pin &&
            section !== 'home' &&
            section !== 'dashboard' &&
            section !== 'settings' &&
            section !== 'change-pin' &&
            section !== 'help' && (
              <div className="mx-auto max-w-lg rounded-2xl border border-amber-300 bg-white p-6 shadow-sm space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-blue-700 text-white">
                    <KeyRound className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <div>
                    <h1 className="font-display text-xl font-bold text-blue-950">
                      Set Your Personal PIN First
                    </h1>
                    <p className="mt-1 text-sm text-slate-600">
                      For security, please change your temporary sign-in PIN in Settings before opening detailed fleet records or recording trips.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3 pt-1">
                  <button
                    type="button"
                    onClick={openPinChangeInSettings}
                    className="cyan-glow-btn min-h-[44px] rounded-xl px-5 text-sm font-semibold"
                  >
                    Change PIN in Settings
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateTo('home')}
                    className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900"
                  >
                    Back to Home
                  </button>
                </div>
              </div>
            )}
          {!user.must_change_pin && section === 'audit' && isSupervisorOrAdmin && <AuditLogView />}
          {!user.must_change_pin && section === 'vehicles' && (
            <VehiclesView
              userRole={user.role}
              initialVehicleId={selectedVehicleId}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
              onOpenMaintenance={() => navigateTo('maintenance')}
            />
          )}
          {!user.must_change_pin && section === 'maintenance' && (
            <FleetMaintenanceView
              userRole={user.role}
              onOpenVehicle={openVehicleFromDashboard}
            />
          )}
          {!user.must_change_pin && section === 'drivers' && (
            <DriversView
              userRole={user.role}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
            />
          )}
          {!user.must_change_pin && section === 'trips' && (
            <TripsView userRole={user.role} initialTripId={selectedTripId} />
          )}
          {!user.must_change_pin && section === 'notifications' && isAlertRecipient && (
            <NotificationsView
              focusedNotificationId={selectedNotificationId}
              onClearFocusedNotification={() => setSelectedNotificationId(null)}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
              onOpenMaintenance={() => navigateTo('maintenance')}
              onUnreadCountChanged={(cnt) => {
                setUnreadNotifications(cnt);
                if (cnt === 0) setHighUnreadNotifications(0);
              }}
            />
          )}
          {!user.must_change_pin && section === 'reports' && isSupervisorOrAdmin && <ReportsView />}
        </main>

        <div className="pb-16 md:pb-0">
          <AppFooter />
        </div>

        {/* Mobile Bottom Tab Bar (<= 64px height so header + bottom bar stays < 15% mobile height) */}
        <nav
          aria-label="Mobile quick navigation"
          className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-4 h-16 border-t border-blue-100 bg-white/95 backdrop-blur-sm md:hidden"
        >
          {mobileBottomNav.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors ${
                  active ? 'text-cyan-700 bg-cyan-50/70' : 'text-slate-500 hover:text-blue-700'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="truncate max-w-full px-1">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {showWalkthrough && (
        <OnboardingWalkthroughModal
          role={user.role}
          fullName={user.full_name}
          onClose={dismissWalkthrough}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}
