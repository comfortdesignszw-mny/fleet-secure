import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bell, KeyRound, Plus, Search, ShieldAlert, Trash2, UserCheck, UserX, X } from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
import { ChangePinView } from './ChangePinView';
import {
  DEFAULT_SETTINGS,
  ROLE_LABELS,
  ROLES,
  formatHarareTime,
  type AppSettings,
  type NotificationChannel,
  type NotificationRecipient,
  type Role,
  type UserPublic,
} from '../shared/types';

export type SettingsTab = 'general' | 'users' | 'recipients' | 'pin';

interface SettingsViewProps {
  currentUser: UserPublic;
  initialTab?: SettingsTab;
  onSettingsChanged?: (settings: AppSettings) => void;
  onUserUpdated: (user: UserPublic) => void;
  onBackHome?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  initialTab,
  onSettingsChanged,
  onUserUpdated,
  onBackHome,
}) => {
  const isAdmin = currentUser.role === 'ADMIN';
  const pinChangeRequired = currentUser.must_change_pin;
  const canLoadAdminData = isAdmin && !pinChangeRequired;

  const resolveDefaultTab = useCallback(
    (requested?: SettingsTab): SettingsTab => {
      if (!isAdmin || pinChangeRequired) return 'pin';
      return requested ?? 'general';
    },
    [isAdmin, pinChangeRequired]
  );

  const [tab, setTab] = useState<SettingsTab>(() => resolveDefaultTab(initialTab));
  const [pinSavedSuccess, setPinSavedSuccess] = useState(false);

  // Settings state
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [usersErr, setUsersErr] = useState<string | null>(null);
  const [usersMsg, setUsersMsg] = useState<string | null>(null);

  // Notification recipients state
  const [recipients, setRecipients] = useState<NotificationRecipient[]>([]);
  const [managers, setManagers] = useState<
    Array<{ id: number; username: string; full_name: string; role: Role }>
  >([]);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [recipientsErr, setRecipientsErr] = useState<string | null>(null);
  const [recipientsMsg, setRecipientsMsg] = useState<string | null>(null);
  const [recUserId, setRecUserId] = useState<number>(0);
  const [recChannel, setRecChannel] = useState<NotificationChannel>('EMAIL');
  const [recDestination, setRecDestination] = useState('');
  const [savingRecipient, setSavingRecipient] = useState(false);

  // Create user modal
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newRole, setNewRole] = useState<Role>('DRIVER');
  const [newPin, setNewPin] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);

  // Edit user modal
  const [editingUser, setEditingUser] = useState<UserPublic | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editRole, setEditRole] = useState<Role>('DRIVER');
  const [editActive, setEditActive] = useState(true);
  const [editResetPin, setEditResetPin] = useState('');
  const [savingUser, setSavingUser] = useState(false);

  useEffect(() => {
    setTab(resolveDefaultTab(initialTab));
  }, [initialTab, resolveDefaultTab]);

  useEffect(() => {
    if (!canLoadAdminData) {
      setLoadingSettings(false);
      return;
    }
    let active = true;
    setLoadingSettings(true);
    setSettingsErr(null);
    api
      .getSettings()
      .then((res) => {
        if (active) setSettings(res.settings);
      })
      .catch((err) => {
        if (active) setSettingsErr(err instanceof ApiError ? err.message : 'Failed to load settings.');
      })
      .finally(() => {
        if (active) setLoadingSettings(false);
      });
    return () => {
      active = false;
    };
  }, [canLoadAdminData]);

  const loadUsers = useCallback(async () => {
    if (!canLoadAdminData) return;
    setLoadingUsers(true);
    setUsersErr(null);
    try {
      const res = await api.listUsers({ q: userQuery.trim(), limit: 50 });
      setUsers(res.items);
    } catch (err) {
      setUsersErr(err instanceof ApiError ? err.message : 'Failed to load staff accounts.');
    } finally {
      setLoadingUsers(false);
    }
  }, [canLoadAdminData, userQuery]);

  useEffect(() => {
    if (tab === 'users' && canLoadAdminData) {
      loadUsers();
    }
  }, [tab, canLoadAdminData, loadUsers]);

  const loadRecipients = useCallback(async () => {
    if (!canLoadAdminData) return;
    setLoadingRecipients(true);
    setRecipientsErr(null);
    try {
      const res = await api.listNotificationRecipients();
      setRecipients(res.items);
      setManagers(res.managers);
      setEmailConfigured(res.emailConfigured);
      setRecUserId((prev) => prev || res.managers[0]?.id || 0);
    } catch (err) {
      setRecipientsErr(err instanceof ApiError ? err.message : 'Failed to load recipients.');
    } finally {
      setLoadingRecipients(false);
    }
  }, [canLoadAdminData]);

  useEffect(() => {
    if (tab === 'recipients' && canLoadAdminData) {
      void loadRecipients();
    }
  }, [tab, canLoadAdminData, loadRecipients]);

  const handleAddRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRecipient(true);
    setRecipientsErr(null);
    setRecipientsMsg(null);
    try {
      await api.upsertNotificationRecipient({
        user_id: recUserId,
        channel: recChannel,
        destination: recDestination.trim(),
        active: true,
      });
      setRecDestination('');
      setRecipientsMsg('Notification recipient saved and logged to the audit trail.');
      await loadRecipients();
    } catch (err) {
      setRecipientsErr(err instanceof ApiError ? err.message : 'Could not save recipient.');
    } finally {
      setSavingRecipient(false);
    }
  };

  const handleToggleRecipient = async (r: NotificationRecipient) => {
    setRecipientsErr(null);
    try {
      await api.updateNotificationRecipient(r.id, { active: !r.active });
      await loadRecipients();
    } catch (err) {
      setRecipientsErr(err instanceof ApiError ? err.message : 'Could not update recipient.');
    }
  };

  const handleDeleteRecipient = async (r: NotificationRecipient) => {
    setRecipientsErr(null);
    try {
      await api.deleteNotificationRecipient(r.id);
      setRecipientsMsg(`Removed ${r.channel} alert channel for ${r.full_name}.`);
      await loadRecipients();
    } catch (err) {
      setRecipientsErr(err instanceof ApiError ? err.message : 'Could not remove recipient.');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsErr(null);
    setSettingsMsg(null);
    try {
      const res = await api.updateSettings(settings);
      setSettings(res.settings);
      setSettingsMsg('System settings saved and logged to the audit trail.');
      onSettingsChanged?.(res.settings);
    } catch (err) {
      setSettingsErr(err instanceof ApiError ? err.message : 'Could not save settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingUser(true);
    setUsersErr(null);
    setUsersMsg(null);
    try {
      const res = await api.createUser({
        username: newUsername.trim(),
        full_name: newFullName.trim(),
        role: newRole,
        pin: newPin.trim(),
      });
      setShowCreateUser(false);
      setNewUsername('');
      setNewFullName('');
      setNewRole('DRIVER');
      setNewPin('');
      setUsersMsg(
        `Created account for ${res.user.full_name} (${res.user.username}). They will be asked to change their PIN on first sign-in.`
      );
      await loadUsers();
    } catch (err) {
      setUsersErr(err instanceof ApiError ? err.message : 'Could not create staff account.');
    } finally {
      setCreatingUser(false);
    }
  };

  const openEditUser = (u: UserPublic) => {
    setEditingUser(u);
    setEditFullName(u.full_name);
    setEditRole(u.role);
    setEditActive(u.active);
    setEditResetPin('');
    setUsersErr(null);
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSavingUser(true);
    setUsersErr(null);
    setUsersMsg(null);
    try {
      const payload: {
        full_name?: string;
        role?: Role;
        active?: boolean;
        resetPin?: string;
      } = {
        full_name: editFullName.trim(),
        role: editRole,
        active: editActive,
      };
      if (editResetPin.trim()) {
        payload.resetPin = editResetPin.trim();
      }
      const res = await api.updateUser(editingUser.id, payload);
      setEditingUser(null);
      setUsersMsg(`Updated ${res.user.full_name} (${res.user.username}).`);
      await loadUsers();
    } catch (err) {
      setUsersErr(err instanceof ApiError ? err.message : 'Could not update staff account.');
    } finally {
      setSavingUser(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold text-blue-950">
            {isAdmin ? en.settings.title : 'Account Settings & PIN'}
          </h1>
          <p className="mt-1 text-base text-blue-900/75">
            {isAdmin
              ? en.settings.subtitle
              : 'Review your account details and update your personal sign-in PIN.'}
          </p>
        </div>
        {onBackHome && (
          <button
            type="button"
            onClick={onBackHome}
            className="cyan-glow-outline inline-flex min-h-[44px] items-center gap-2 self-start sm:self-auto rounded-xl border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-900 whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-4 w-4 text-cyan-600" aria-hidden="true" />
            <span>Back to Home</span>
          </button>
        )}
      </div>

      {isAdmin && pinChangeRequired && (
        <div
          role="status"
          className="rounded-2xl border border-amber-300 bg-amber-50 p-4 flex items-start gap-3 text-sm text-amber-950"
        >
          <ShieldAlert className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold">Set your personal PIN to unlock Admin settings</p>
            <p className="mt-0.5 text-amber-900/85">
              Company Rules, Staff Accounts, and Notification Recipients will unlock automatically as soon as you save your new personal PIN below.
            </p>
          </div>
        </div>
      )}

      {/* Segmented tabs (Admin sees all 4 tabs; Staff see Account & Change PIN) */}
      {isAdmin && (
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-blue-200/80 bg-blue-50/70 p-1">
          <button
            type="button"
            disabled={pinChangeRequired}
            onClick={() => setTab('general')}
            className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
              tab === 'general'
                ? 'cyan-glow-active'
                : 'text-blue-900/75 hover:bg-white/70 hover:text-blue-950'
            }`}
          >
            Company & Fuel Rules
          </button>
          <button
            type="button"
            disabled={pinChangeRequired}
            onClick={() => setTab('users')}
            className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
              tab === 'users'
                ? 'cyan-glow-active'
                : 'text-blue-900/75 hover:bg-white/70 hover:text-blue-950'
            }`}
          >
            Staff Accounts & Roles
          </button>
          <button
            type="button"
            disabled={pinChangeRequired}
            onClick={() => setTab('recipients')}
            className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-all whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${
              tab === 'recipients'
                ? 'cyan-glow-active'
                : 'text-blue-900/75 hover:bg-white/70 hover:text-blue-950'
            }`}
          >
            Notification Recipients
          </button>
          <button
            type="button"
            onClick={() => setTab('pin')}
            className={`inline-flex items-center gap-1.5 min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-all whitespace-nowrap ${
              tab === 'pin'
                ? 'cyan-glow-active'
                : 'text-blue-900/75 hover:bg-white/70 hover:text-blue-950'
            }`}
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            <span>Change PIN</span>
          </button>
        </div>
      )}

      {tab === 'pin' && (
        <div className="space-y-6">
          {!isAdmin && (
            <div className="rounded-2xl border border-blue-200/80 bg-white p-5 shadow-xs">
              <h2 className="text-base font-semibold text-blue-950">Your Account</h2>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
                <div>
                  <div className="text-xs font-medium text-slate-500">Full Name</div>
                  <div className="mt-0.5 font-semibold text-blue-950">{currentUser.full_name}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Username</div>
                  <div className="mt-0.5 font-mono text-blue-900">{currentUser.username}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-slate-500">Role</div>
                  <div className="mt-0.5 font-semibold text-cyan-700">{ROLE_LABELS[currentUser.role]}</div>
                </div>
              </div>
            </div>
          )}

          {pinSavedSuccess && (
            <div
              role="status"
              className="mx-auto max-w-md rounded-2xl border border-cyan-300 bg-cyan-50 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="text-sm font-semibold text-blue-950">
                Your new PIN is active!
              </span>
              {onBackHome && (
                <button
                  type="button"
                  onClick={onBackHome}
                  className="cyan-glow-btn min-h-[40px] rounded-xl px-4 text-sm font-semibold whitespace-nowrap"
                >
                  Go to Home &amp; Dashboard
                </button>
              )}
            </div>
          )}

          <ChangePinView
            user={currentUser}
            forced={false}
            onUpdated={(updatedUser) => {
              setPinSavedSuccess(true);
              onUserUpdated(updatedUser);
            }}
          />
        </div>
      )}

      {tab === 'general' && canLoadAdminData && (
        <form onSubmit={handleSaveSettings} className="space-y-6">
          {settingsErr && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
            >
              {settingsErr}
            </div>
          )}
          {settingsMsg && (
            <div
              role="status"
              className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
            >
              {settingsMsg}
            </div>
          )}

          <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-5 shadow-xs">
            <h2 className="text-lg font-semibold text-blue-950">{en.settings.companySection}</h2>

            {loadingSettings ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-11 rounded-xl bg-blue-100/70" />
                <div className="h-11 rounded-xl bg-blue-100/70" />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="s-company-name" className="block text-sm font-semibold text-blue-950">
                    Company or Yard Name
                  </label>
                  <input
                    id="s-company-name"
                    type="text"
                    value={settings.company_name}
                    onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>

                <div>
                  <label htmlFor="s-contact" className="block text-sm font-semibold text-blue-950">
                    Contact Phone Numbers
                  </label>
                  <input
                    id="s-contact"
                    type="text"
                    value={settings.contact_numbers}
                    onChange={(e) => setSettings({ ...settings, contact_numbers: e.target.value })}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="s-address" className="block text-sm font-semibold text-blue-950">
                    Yard / Office Address
                  </label>
                  <input
                    id="s-address"
                    type="text"
                    value={settings.company_address}
                    onChange={(e) => setSettings({ ...settings, company_address: e.target.value })}
                    className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-blue-200/80 bg-white p-6 space-y-5 shadow-xs">
            <h2 className="text-lg font-semibold text-blue-950">{en.settings.fuelSection}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="s-eco-tank" className="block text-sm font-semibold text-blue-950">
                  Economy Tank Size (Litres)
                </label>
                <input
                  id="s-eco-tank"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.economy_tank_litres}
                  onChange={(e) => setSettings({ ...settings, economy_tank_litres: e.target.value })}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="s-eco-kml" className="block text-sm font-semibold text-blue-950">
                  Economy Rate (km per Litre)
                </label>
                <input
                  id="s-eco-kml"
                  type="number"
                  min={1}
                  step="0.5"
                  value={settings.economy_km_per_litre}
                  onChange={(e) => setSettings({ ...settings, economy_km_per_litre: e.target.value })}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="s-heavy-tank" className="block text-sm font-semibold text-blue-950">
                  Heavy Tank Size (Litres)
                </label>
                <input
                  id="s-heavy-tank"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.heavy_tank_litres}
                  onChange={(e) => setSettings({ ...settings, heavy_tank_litres: e.target.value })}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="s-heavy-kml" className="block text-sm font-semibold text-blue-950">
                  Heavy Rate (km per Litre)
                </label>
                <input
                  id="s-heavy-kml"
                  type="number"
                  min={1}
                  step="0.5"
                  value={settings.heavy_km_per_litre}
                  onChange={(e) => setSettings({ ...settings, heavy_km_per_litre: e.target.value })}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="s-fuel-pct" className="block text-sm font-semibold text-blue-950">
                  Fuel Mismatch Flag (% of tank)
                </label>
                <input
                  id="s-fuel-pct"
                  type="number"
                  min={1}
                  max={100}
                  step="1"
                  value={settings.fuel_mismatch_threshold_pct}
                  onChange={(e) =>
                    setSettings({ ...settings, fuel_mismatch_threshold_pct: e.target.value })
                  }
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="s-overdue" className="block text-sm font-semibold text-blue-950">
                  Overdue Hire Limit (Hours)
                </label>
                <input
                  id="s-overdue"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.overdue_hire_hours}
                  onChange={(e) => setSettings({ ...settings, overdue_hire_hours: e.target.value })}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 font-mono tabular-nums text-base text-blue-950"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSettings || loadingSettings}
              className="cyan-glow-btn min-h-[48px] rounded-xl px-6 py-3 text-base font-semibold disabled:opacity-60"
            >
              {savingSettings ? 'Saving...' : en.settings.saveSettings}
            </button>
          </div>
        </form>
      )}

      {tab === 'users' && canLoadAdminData && (
        <div className="space-y-4">
          {usersErr && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
            >
              {usersErr}
            </div>
          )}
          {usersMsg && (
            <div
              role="status"
              className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
            >
              {usersMsg}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-cyan-600"
                aria-hidden="true"
              />
              <input
                type="search"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Filter staff by name or username..."
                className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white pl-11 pr-4 text-base text-blue-950 placeholder:text-blue-400"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                setUsersErr(null);
                setShowCreateUser(true);
              }}
              className="cyan-glow-btn inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap shrink-0"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
              <span>{en.settings.addUser}</span>
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
            {loadingUsers ? (
              <div className="p-6 text-base text-blue-900/70">Loading staff accounts...</div>
            ) : users.length === 0 ? (
              <div className="p-8 text-center text-base text-blue-900/70">
                No staff accounts match your search.
              </div>
            ) : (
              <div className="divide-y divide-blue-100">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-col gap-3 p-4 transition-colors hover:bg-cyan-50/40 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-base font-semibold text-blue-950">{u.full_name}</span>
                        <span aria-hidden="true" className="text-blue-300">·</span>
                        <span className="font-mono text-sm text-blue-800/80">{u.username}</span>
                        {u.id === currentUser.id && (
                          <>
                            <span aria-hidden="true" className="text-blue-300">·</span>
                            <span className="text-xs font-semibold text-cyan-700">You</span>
                          </>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-blue-800/70">
                        <span className="font-medium text-blue-900">{ROLE_LABELS[u.role]}</span>
                        <span aria-hidden="true">·</span>
                        {u.active ? (
                          <span className="inline-flex items-center gap-1 font-medium text-cyan-700">
                            <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-medium text-red-700">
                            <UserX className="h-3.5 w-3.5" aria-hidden="true" />
                            Disabled
                          </span>
                        )}
                        {u.must_change_pin && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-medium text-amber-700">Must change PIN</span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          Added {formatHarareTime(u.created_at)}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => openEditUser(u)}
                      className="cyan-glow-outline min-h-[44px] self-start sm:self-center rounded-xl border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-900 whitespace-nowrap shrink-0"
                    >
                      Manage
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'recipients' && canLoadAdminData && (
        <div className="space-y-5">
          {recipientsErr && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
            >
              {recipientsErr}
            </div>
          )}
          {recipientsMsg && (
            <div
              role="status"
              className="rounded-xl border border-cyan-300 bg-cyan-50 p-4 text-sm font-medium text-cyan-900"
            >
              {recipientsMsg}
            </div>
          )}

          <div className="rounded-2xl border border-blue-200/80 bg-white p-5 space-y-4 shadow-xs">
            <div className="flex items-start gap-3">
              <Bell className="h-5 w-5 text-cyan-600 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="text-sm text-blue-900/80">
                <p className="font-semibold text-blue-950">Alert Delivery Channels</p>
                <p className="mt-1">
                  All active Supervisors and Admins receive in-app inbox alerts automatically.
                  Add Email addresses below to send instant copies when{' '}
                  <code className="font-mono text-xs bg-blue-50 text-blue-900 px-1.5 py-0.5 rounded">RESEND_API_KEY</code>{' '}
                  and{' '}
                  <code className="font-mono text-xs bg-blue-50 text-blue-900 px-1.5 py-0.5 rounded">EMAIL_FROM</code>{' '}
                  are set ({emailConfigured ? 'Email active' : 'Email secret not configured yet'}).
                  WhatsApp numbers can also be pre-registered here for future gateway integration.
                </p>
              </div>
            </div>

            <form
              onSubmit={handleAddRecipient}
              className="grid grid-cols-1 gap-3 border-t border-blue-100 pt-4 sm:grid-cols-4 sm:items-end"
            >
              <div>
                <label htmlFor="rec-user" className="block text-sm font-semibold text-blue-950">
                  Manager
                </label>
                <select
                  id="rec-user"
                  value={recUserId}
                  onChange={(e) => setRecUserId(Number(e.target.value))}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3 text-base text-blue-950"
                >
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name} ({m.role})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="rec-channel" className="block text-sm font-semibold text-blue-950">
                  Channel
                </label>
                <select
                  id="rec-channel"
                  value={recChannel}
                  onChange={(e) => setRecChannel(e.target.value as NotificationChannel)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3 text-base text-blue-950"
                >
                  <option value="EMAIL">Email</option>
                  <option value="IN_APP">In-App Inbox</option>
                  <option value="WHATSAPP">WhatsApp (Future Stub)</option>
                  <option value="PUSH">Push (Optional)</option>
                </select>
              </div>

              <div>
                <label htmlFor="rec-dest" className="block text-sm font-semibold text-blue-950">
                  {recChannel === 'EMAIL'
                    ? 'Email Address'
                    : recChannel === 'WHATSAPP'
                      ? 'Phone (+263...)'
                      : 'Destination (Optional)'}
                </label>
                <input
                  id="rec-dest"
                  type="text"
                  value={recDestination}
                  onChange={(e) => setRecDestination(e.target.value)}
                  required={recChannel === 'EMAIL' || recChannel === 'WHATSAPP'}
                  placeholder={
                    recChannel === 'EMAIL'
                      ? 'supervisor@company.co.zw'
                      : recChannel === 'WHATSAPP'
                        ? '+263771234567'
                        : 'Browser / App'
                  }
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <button
                type="submit"
                disabled={savingRecipient || managers.length === 0}
                className="cyan-glow-btn min-h-[48px] rounded-xl px-5 text-sm font-semibold disabled:opacity-60 whitespace-nowrap"
              >
                {savingRecipient ? 'Saving...' : 'Save Recipient'}
              </button>
            </form>
          </div>

          <div className="overflow-hidden rounded-2xl border border-blue-200/80 bg-white shadow-xs">
            {loadingRecipients ? (
              <div className="p-6 text-base text-blue-900/70">Loading notification recipients...</div>
            ) : recipients.length === 0 ? (
              <div className="p-8 text-center text-base text-blue-900/70">
                No notification channels configured yet.
              </div>
            ) : (
              <div className="divide-y divide-blue-100">
                {recipients.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-col gap-3 p-4 transition-colors hover:bg-cyan-50/40 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-base font-semibold text-blue-950">{r.full_name}</span>
                        <span aria-hidden="true" className="text-blue-300">·</span>
                        <span className="font-mono text-xs font-semibold text-blue-900">{r.channel}</span>
                        <span aria-hidden="true" className="text-blue-300">·</span>
                        <span className={`text-xs font-semibold ${r.active ? 'text-cyan-700' : 'text-red-700'}`}>
                          {r.active ? 'Enabled' : 'Paused'}
                        </span>
                      </div>
                      <div className="text-sm text-blue-900/75 font-mono">
                        {r.destination || 'In-app inbox (automatic for this account)'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleRecipient(r)}
                        className="cyan-glow-outline min-h-[44px] rounded-xl border border-blue-200 bg-white px-4 text-sm font-semibold text-blue-900 whitespace-nowrap"
                      >
                        {r.active ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteRecipient(r)}
                        aria-label={`Remove ${r.channel} recipient for ${r.full_name}`}
                        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Staff Account Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-bold text-blue-950">Add Staff Account</h2>
              <button
                type="button"
                onClick={() => setShowCreateUser(false)}
                aria-label="Close"
                className="cyan-glow-outline flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-transparent text-blue-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="mt-4 space-y-4">
              <div>
                <label htmlFor="cu-name" className="block text-sm font-semibold text-blue-950">
                  Full Name
                </label>
                <input
                  id="cu-name"
                  type="text"
                  required
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="e.g. Tendai Moyo"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="cu-username" className="block text-sm font-semibold text-blue-950">
                  Username
                </label>
                <input
                  id="cu-username"
                  type="text"
                  required
                  autoCapitalize="none"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="e.g. tendai.moyo"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="cu-role" className="block text-sm font-semibold text-blue-950">
                  Role
                </label>
                <select
                  id="cu-role"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="cu-pin" className="block text-sm font-semibold text-blue-950">
                  Temporary PIN or Password
                </label>
                <input
                  id="cu-pin"
                  type="text"
                  required
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder="Minimum 4 characters"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
                <p className="mt-1 text-xs text-blue-800/70">
                  The staff member will be forced to change this PIN on first sign-in.
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-base font-semibold disabled:opacity-60"
                >
                  {creatingUser ? 'Creating...' : 'Create Account'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateUser(false)}
                  className="cyan-glow-outline min-h-[48px] rounded-xl border border-blue-200 px-4 text-base font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Staff Account Modal */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-blue-950/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl border border-blue-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-blue-950">Manage Staff Account</h2>
                <p className="text-sm font-mono text-blue-800/70">{editingUser.username}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingUser(null)}
                aria-label="Close"
                className="cyan-glow-outline flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-transparent text-blue-700"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateUser} className="mt-4 space-y-4">
              <div>
                <label htmlFor="eu-name" className="block text-sm font-semibold text-blue-950">
                  Full Name
                </label>
                <input
                  id="eu-name"
                  type="text"
                  required
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div>
                <label htmlFor="eu-role" className="block text-sm font-semibold text-blue-950">
                  Role
                </label>
                <select
                  id="eu-role"
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as Role)}
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-3.5 text-base text-blue-950"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-blue-200/80 bg-blue-50/40 p-3.5">
                <div>
                  <div className="text-sm font-semibold text-blue-950">Account Active</div>
                  <div className="text-xs text-blue-800/70">Disabled users cannot sign in</div>
                </div>
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                  aria-label="Account active"
                  className="h-6 w-6 rounded border-blue-300 text-cyan-600 accent-cyan-600 focus:ring-cyan-500"
                />
              </div>

              <div>
                <label htmlFor="eu-pin" className="block text-sm font-semibold text-blue-950">
                  Reset PIN (optional)
                </label>
                <input
                  id="eu-pin"
                  type="text"
                  value={editResetPin}
                  onChange={(e) => setEditResetPin(e.target.value)}
                  placeholder="Leave blank to keep current PIN"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 px-3.5 text-base text-blue-950"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingUser}
                  className="cyan-glow-btn flex-1 min-h-[48px] rounded-xl px-4 text-base font-semibold disabled:opacity-60"
                >
                  {savingUser ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="cyan-glow-outline min-h-[48px] rounded-xl border border-blue-200 px-4 text-base font-medium text-blue-900"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
