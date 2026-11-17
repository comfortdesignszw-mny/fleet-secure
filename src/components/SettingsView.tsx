import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Plus, Search, Trash2, UserCheck, UserX, X } from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
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

interface SettingsViewProps {
  currentUser: UserPublic;
  onSettingsChanged?: (settings: AppSettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  currentUser,
  onSettingsChanged,
}) => {
  const [tab, setTab] = useState<'general' | 'users' | 'recipients'>('general');

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
    let active = true;
    setLoadingSettings(true);
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
  }, []);

  const loadUsers = useCallback(async () => {
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
  }, [userQuery]);

  useEffect(() => {
    if (tab === 'users') {
      loadUsers();
    }
  }, [tab, loadUsers]);

  const loadRecipients = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    if (tab === 'recipients') {
      void loadRecipients();
    }
  }, [tab, loadRecipients]);

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
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900">{en.settings.title}</h1>
        <p className="mt-1 text-base text-slate-600">{en.settings.subtitle}</p>
      </div>

      {/* Segmented tabs */}
      <div className="inline-flex flex-wrap rounded-xl border border-slate-200 bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => setTab('general')}
          className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-colors whitespace-nowrap ${
            tab === 'general'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Company & Fuel Rules
        </button>
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-colors whitespace-nowrap ${
            tab === 'users'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Staff Accounts & Roles
        </button>
        <button
          type="button"
          onClick={() => setTab('recipients')}
          className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold transition-colors whitespace-nowrap ${
            tab === 'recipients'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Notification Recipients
        </button>
      </div>

      {tab === 'general' && (
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
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"
            >
              {settingsMsg}
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
            <h2 className="text-lg font-semibold text-slate-900">{en.settings.companySection}</h2>

            {loadingSettings ? (
              <div className="space-y-3 animate-pulse">
                <div className="h-11 rounded-xl bg-slate-100" />
                <div className="h-11 rounded-xl bg-slate-100" />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="s-company-name" className="block text-sm font-semibold text-slate-800">
                    Company or Yard Name
                  </label>
                  <input
                    id="s-company-name"
                    type="text"
                    value={settings.company_name}
                    onChange={(e) => setSettings({ ...settings, company_name: e.target.value })}
                    className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="s-contact" className="block text-sm font-semibold text-slate-800">
                    Contact Phone Numbers
                  </label>
                  <input
                    id="s-contact"
                    type="text"
                    value={settings.contact_numbers}
                    onChange={(e) => setSettings({ ...settings, contact_numbers: e.target.value })}
                    className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="s-address" className="block text-sm font-semibold text-slate-800">
                    Yard / Office Address
                  </label>
                  <input
                    id="s-address"
                    type="text"
                    value={settings.company_address}
                    onChange={(e) => setSettings({ ...settings, company_address: e.target.value })}
                    className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5">
            <h2 className="text-lg font-semibold text-slate-900">{en.settings.fuelSection}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="s-eco-tank" className="block text-sm font-semibold text-slate-800">
                  Economy Tank Size (Litres)
                </label>
                <input
                  id="s-eco-tank"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.economy_tank_litres}
                  onChange={(e) => setSettings({ ...settings, economy_tank_litres: e.target.value })}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="s-eco-kml" className="block text-sm font-semibold text-slate-800">
                  Economy Rate (km per Litre)
                </label>
                <input
                  id="s-eco-kml"
                  type="number"
                  min={1}
                  step="0.5"
                  value={settings.economy_km_per_litre}
                  onChange={(e) => setSettings({ ...settings, economy_km_per_litre: e.target.value })}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="s-heavy-tank" className="block text-sm font-semibold text-slate-800">
                  Heavy Tank Size (Litres)
                </label>
                <input
                  id="s-heavy-tank"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.heavy_tank_litres}
                  onChange={(e) => setSettings({ ...settings, heavy_tank_litres: e.target.value })}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="s-heavy-kml" className="block text-sm font-semibold text-slate-800">
                  Heavy Rate (km per Litre)
                </label>
                <input
                  id="s-heavy-kml"
                  type="number"
                  min={1}
                  step="0.5"
                  value={settings.heavy_km_per_litre}
                  onChange={(e) => setSettings({ ...settings, heavy_km_per_litre: e.target.value })}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="s-fuel-pct" className="block text-sm font-semibold text-slate-800">
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
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="s-overdue" className="block text-sm font-semibold text-slate-800">
                  Overdue Hire Limit (Hours)
                </label>
                <input
                  id="s-overdue"
                  type="number"
                  min={1}
                  step="1"
                  value={settings.overdue_hire_hours}
                  onChange={(e) => setSettings({ ...settings, overdue_hire_hours: e.target.value })}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 font-mono tabular-nums text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={savingSettings || loadingSettings}
              className="min-h-[48px] rounded-xl bg-slate-900 px-6 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {savingSettings ? 'Saving...' : en.settings.saveSettings}
            </button>
          </div>
        </form>
      )}

      {tab === 'users' && (
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
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"
            >
              {usersMsg}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1 max-w-md">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Filter staff by name or username..."
                className="block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
              />
            </div>

            <button
              type="button"
              onClick={() => {
                setUsersErr(null);
                setShowCreateUser(true);
              }}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
              <span>{en.settings.addUser}</span>
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {loadingUsers ? (
              <div className="p-6 text-base text-slate-500">Loading staff accounts...</div>
            ) : users.length === 0 ? (
              <div className="p-8 text-center text-base text-slate-600">
                No staff accounts match your search.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-base font-semibold text-slate-900">{u.full_name}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className="font-mono text-sm text-slate-600">{u.username}</span>
                        {u.id === currentUser.id && (
                          <>
                            <span aria-hidden="true" className="text-slate-400">·</span>
                            <span className="text-xs font-semibold text-slate-700">You</span>
                          </>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className="font-medium text-slate-700">{ROLE_LABELS[u.role]}</span>
                        <span aria-hidden="true">·</span>
                        {u.active ? (
                          <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
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
                      className="min-h-[44px] self-start sm:self-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0"
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

      {tab === 'recipients' && (
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
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"
            >
              {recipientsMsg}
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex items-start gap-3">
              <Bell className="h-5 w-5 text-slate-700 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="text-sm text-slate-700">
                <p className="font-semibold text-slate-900">Alert Delivery Channels</p>
                <p className="mt-1">
                  All active Supervisors and Admins receive in-app inbox alerts automatically.
                  Add Email addresses below to send instant copies when{' '}
                  <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">RESEND_API_KEY</code>{' '}
                  and{' '}
                  <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">EMAIL_FROM</code>{' '}
                  are set ({emailConfigured ? 'Email active' : 'Email secret not configured yet'}).
                  WhatsApp numbers can also be pre-registered here for future gateway integration.
                </p>
              </div>
            </div>

            <form
              onSubmit={handleAddRecipient}
              className="grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-4 sm:items-end"
            >
              <div>
                <label htmlFor="rec-user" className="block text-sm font-semibold text-slate-800">
                  Manager
                </label>
                <select
                  id="rec-user"
                  value={recUserId}
                  onChange={(e) => setRecUserId(Number(e.target.value))}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name} ({m.role})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="rec-channel" className="block text-sm font-semibold text-slate-800">
                  Channel
                </label>
                <select
                  id="rec-channel"
                  value={recChannel}
                  onChange={(e) => setRecChannel(e.target.value as NotificationChannel)}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  <option value="EMAIL">Email</option>
                  <option value="IN_APP">In-App Inbox</option>
                  <option value="WHATSAPP">WhatsApp (Future Stub)</option>
                  <option value="PUSH">Push (Optional)</option>
                </select>
              </div>

              <div>
                <label htmlFor="rec-dest" className="block text-sm font-semibold text-slate-800">
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
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={savingRecipient || managers.length === 0}
                className="min-h-[48px] rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60 whitespace-nowrap"
              >
                {savingRecipient ? 'Saving...' : 'Save Recipient'}
              </button>
            </form>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {loadingRecipients ? (
              <div className="p-6 text-base text-slate-500">Loading notification recipients...</div>
            ) : recipients.length === 0 ? (
              <div className="p-8 text-center text-base text-slate-600">
                No notification channels configured yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-200">
                {recipients.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-base font-semibold text-slate-900">{r.full_name}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className="font-mono text-xs font-semibold text-slate-700">{r.channel}</span>
                        <span aria-hidden="true" className="text-slate-400">·</span>
                        <span className={`text-xs font-semibold ${r.active ? 'text-emerald-700' : 'text-red-700'}`}>
                          {r.active ? 'Enabled' : 'Paused'}
                        </span>
                      </div>
                      <div className="text-sm text-slate-600 font-mono">
                        {r.destination || 'In-app inbox (automatic for this account)'}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleToggleRecipient(r)}
                        className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 whitespace-nowrap"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-display text-xl font-bold text-slate-900">Add Staff Account</h2>
              <button
                type="button"
                onClick={() => setShowCreateUser(false)}
                aria-label="Close"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="mt-4 space-y-4">
              <div>
                <label htmlFor="cu-name" className="block text-sm font-semibold text-slate-800">
                  Full Name
                </label>
                <input
                  id="cu-name"
                  type="text"
                  required
                  value={newFullName}
                  onChange={(e) => setNewFullName(e.target.value)}
                  placeholder="e.g. Tendai Moyo"
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="cu-username" className="block text-sm font-semibold text-slate-800">
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
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="cu-role" className="block text-sm font-semibold text-slate-800">
                  Role
                </label>
                <select
                  id="cu-role"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Role)}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="cu-pin" className="block text-sm font-semibold text-slate-800">
                  Temporary PIN or Password
                </label>
                <input
                  id="cu-pin"
                  type="text"
                  required
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder="Minimum 4 characters"
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  The staff member will be forced to change this PIN on first sign-in.
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="flex-1 min-h-[48px] rounded-xl bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {creatingUser ? 'Creating...' : 'Create Account'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateUser(false)}
                  className="min-h-[48px] rounded-xl border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-xl font-bold text-slate-900">Manage Staff Account</h2>
                <p className="text-sm font-mono text-slate-500">{editingUser.username}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingUser(null)}
                aria-label="Close"
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleUpdateUser} className="mt-4 space-y-4">
              <div>
                <label htmlFor="eu-name" className="block text-sm font-semibold text-slate-800">
                  Full Name
                </label>
                <input
                  id="eu-name"
                  type="text"
                  required
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="eu-role" className="block text-sm font-semibold text-slate-800">
                  Role
                </label>
                <select
                  id="eu-role"
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as Role)}
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between rounded-xl border border-slate-200 p-3.5">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Account Active</div>
                  <div className="text-xs text-slate-500">Disabled users cannot sign in</div>
                </div>
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                  aria-label="Account active"
                  className="h-6 w-6 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                />
              </div>

              <div>
                <label htmlFor="eu-pin" className="block text-sm font-semibold text-slate-800">
                  Reset PIN (optional)
                </label>
                <input
                  id="eu-pin"
                  type="text"
                  value={editResetPin}
                  onChange={(e) => setEditResetPin(e.target.value)}
                  placeholder="Leave blank to keep current PIN"
                  className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-3.5 text-base text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={savingUser}
                  className="flex-1 min-h-[48px] rounded-xl bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                >
                  {savingUser ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="min-h-[48px] rounded-xl border border-slate-300 px-4 text-base font-medium text-slate-700 hover:bg-slate-50"
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
