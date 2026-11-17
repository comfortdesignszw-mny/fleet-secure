/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  Car,
  ClipboardList,
  FileSpreadsheet,
  HelpCircle,
  Home,
  LogOut,
  Menu,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from 'lucide-react';
import { en } from './i18n/en';
import { api } from './lib/api';
import { DEFAULT_SETTINGS, ROLE_LABELS, type AppSettings, type UserPublic } from './shared/types';
import { AuditLogView } from './components/AuditLogView';
import { ChangePinView } from './components/ChangePinView';
import { DashboardView } from './components/DashboardView';
import { DriversView } from './components/DriversView';
import { HelpView } from './components/HelpView';
import { HomeView, type NavSection } from './components/HomeView';
import { LoginView } from './components/LoginView';
import { NotificationsView } from './components/NotificationsView';
import { OfflineIndicator } from './components/OfflineIndicator';
import { OnboardingWalkthroughModal } from './components/OnboardingWalkthroughModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { ReportsView } from './components/ReportsView';
import { SettingsView } from './components/SettingsView';
import { TripsView } from './components/TripsView';
import { VehiclesView } from './components/VehiclesView';

export default function App() {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [section, setSection] = useState<NavSection>('home');
  const [selectedTripId, setSelectedTripId] = useState<number | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<number | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [highUnreadNotifications, setHighUnreadNotifications] = useState(0);
  const [showWalkthrough, setShowWalkthrough] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .me()
      .then((res) => {
        if (active) setUser(res.user);
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!user || user.must_change_pin) return;
    api
      .getSettings()
      .then((res) => setSettings(res.settings))
      .catch(() => {
        // Keep defaults if offline
      });
  }, [user]);

  useEffect(() => {
    if (!user || user.must_change_pin) return;
    if (user.role !== 'SUPERVISOR' && user.role !== 'ADMIN') {
      setUnreadNotifications(0);
      setHighUnreadNotifications(0);
      return;
    }

    let cancelled = false;
    const refreshCount = () => {
      api
        .getUnreadNotificationsCount()
        .then((res) => {
          if (!cancelled) {
            setUnreadNotifications(res.unreadCount);
            setHighUnreadNotifications(res.highUnreadCount);
          }
        })
        .catch(() => {
          // Ignore transient offline errors
        });
    };

    refreshCount();
    const timer = window.setInterval(refreshCount, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user, section]);

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
    } finally {
      setUser(null);
      setSection('home');
      setMobileMenuOpen(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-base font-medium text-slate-600">Loading Fleet Secure...</div>
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
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  if (user.must_change_pin) {
    return (
      <>
        <ChangePinView
          user={user}
          forced
          onUpdated={(updatedUser) => {
            setUser(updatedUser);
            setSection('home');
          }}
          onLogout={handleLogout}
        />
        <OfflineIndicator />
      </>
    );
  }

  const isSupervisorOrAdmin = user.role === 'SUPERVISOR' || user.role === 'ADMIN';
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
    { id: 'drivers', label: en.nav.drivers, icon: Users, visible: true },
    { id: 'dashboard', label: en.nav.dashboard, icon: BarChart3, visible: true },
    { id: 'notifications', label: en.nav.notifications, icon: Bell, visible: isSupervisorOrAdmin },
    { id: 'audit', label: en.nav.auditLog, icon: ShieldCheck, visible: isSupervisorOrAdmin },
    { id: 'reports', label: en.nav.reports, icon: FileSpreadsheet, visible: isSupervisorOrAdmin },
    { id: 'settings', label: en.nav.settings, icon: SlidersHorizontal, visible: isAdmin },
    { id: 'help', label: en.nav.help, icon: HelpCircle, visible: true },
  ];

  const visibleNav = navItems.filter((item) => item.visible);
  const mobileBottomNav = visibleNav.filter((item) =>
    ['home', 'trips', 'vehicles', isSupervisorOrAdmin ? 'audit' : 'dashboard'].includes(item.id)
  );

  const navigateTo = (next: NavSection, tripId?: number) => {
    setSelectedTripId(tripId ?? null);
    setSelectedVehicleId(null);
    setSection(next);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col md:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col md:border-r md:border-slate-200 md:bg-white md:shrink-0">
        <div className="flex h-16 items-center gap-2.5 border-b border-slate-200 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-white shrink-0">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            {en.appName}
          </span>
        </div>

        <nav className="flex-1 space-y-1 p-3" aria-label="Main navigation">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`flex w-full min-h-[44px] items-center justify-between gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'notifications' && unreadNotifications > 0 && (
                  <span
                    className={`font-mono tabular-nums text-xs font-bold px-1.5 py-0.5 rounded-md ${
                      active
                        ? 'bg-white text-slate-900'
                        : highUnreadNotifications > 0
                          ? 'bg-red-100 text-red-800'
                          : 'bg-slate-200 text-slate-800'
                    }`}
                  >
                    {unreadNotifications}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-200 p-4 space-y-3">
          <div>
            <div className="text-sm font-semibold text-slate-900 truncate">{user.full_name}</div>
            <div className="text-xs text-slate-500 truncate">
              {user.username} · {ROLE_LABELS[user.role]}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>{en.auth.signOut}</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top Bar (3-zone contract) */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              className="flex md:hidden min-h-[44px] min-w-[44px] -ml-2 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-display text-base font-bold text-slate-900 truncate md:hidden">
              {en.appName}
            </span>
            <span className="hidden md:inline text-sm font-medium text-slate-500 truncate">
              {settings.company_name} / {visibleNav.find((n) => n.id === section)?.label ?? 'Account'}
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isSupervisorOrAdmin && (
              <button
                type="button"
                onClick={() => navigateTo('notifications')}
                aria-label={`Notifications inbox, ${unreadNotifications} unread`}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold whitespace-nowrap ${
                  highUnreadNotifications > 0
                    ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100'
                    : unreadNotifications > 0
                      ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
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
              className="md:hidden inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </header>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <div
              className="fixed inset-0 bg-slate-900/50"
              onClick={() => setMobileMenuOpen(false)}
              aria-hidden="true"
            />
            <div className="relative z-10 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl">
              <div className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
                <span className="font-display text-lg font-bold text-slate-900">{en.appName}</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close menu"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
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
                      className={`flex w-full min-h-[48px] items-center justify-between gap-3 rounded-xl px-3.5 text-base font-semibold ${
                        active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
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
              <div className="border-t border-slate-200 p-4">
                <div className="text-sm font-semibold text-slate-900">{user.full_name}</div>
                <div className="text-xs text-slate-500">
                  {user.username} · {ROLE_LABELS[user.role]}
                </div>
              </div>
            </div>
          </div>
        )}

        <main className="flex-1 p-4 pb-24 sm:p-6 md:p-8 md:pb-8 max-w-6xl w-full mx-auto">
          {section === 'home' && (
            <HomeView
              user={user}
              companyName={settings.company_name}
              onNavigate={navigateTo}
            />
          )}
          {section === 'audit' && isSupervisorOrAdmin && <AuditLogView />}
          {section === 'settings' && isAdmin && (
            <SettingsView
              currentUser={user}
              onSettingsChanged={(updated) => setSettings(updated)}
            />
          )}
          {section === 'change-pin' && (
            <ChangePinView
              user={user}
              onUpdated={(updated) => {
                setUser(updated);
                setSection('home');
              }}
              onCancel={() => setSection('home')}
            />
          )}
          {section === 'vehicles' && (
            <VehiclesView
              userRole={user.role}
              initialVehicleId={selectedVehicleId}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
            />
          )}
          {section === 'drivers' && (
            <DriversView
              userRole={user.role}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
            />
          )}
          {section === 'trips' && (
            <TripsView userRole={user.role} initialTripId={selectedTripId} />
          )}
          {section === 'dashboard' && (
            <DashboardView
              onOpenVehicle={(vid) => {
                setSelectedVehicleId(vid);
                setSelectedTripId(null);
                setSection('vehicles');
              }}
              onOpenTrip={(tid) => navigateTo('trips', tid)}
            />
          )}
          {section === 'notifications' && isSupervisorOrAdmin && (
            <NotificationsView
              onOpenTrip={(tid) => navigateTo('trips', tid)}
              onUnreadCountChanged={(cnt) => {
                setUnreadNotifications(cnt);
                if (cnt === 0) setHighUnreadNotifications(0);
              }}
            />
          )}
          {section === 'reports' && isSupervisorOrAdmin && <ReportsView />}
          {section === 'help' && (
            <HelpView
              userRole={user.role}
              onReplayWalkthrough={() => setShowWalkthrough(true)}
            />
          )}
        </main>

        {/* Mobile Bottom Tab Bar (<= 64px height so header + bottom bar stays < 15% mobile height) */}
        <nav
          aria-label="Mobile quick navigation"
          className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-4 h-16 border-t border-slate-200 bg-white md:hidden"
        >
          {mobileBottomNav.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                  active ? 'text-slate-900' : 'text-slate-500'
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
