import React, { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
import type { UserPublic } from '../shared/types';

interface ChangePinViewProps {
  user: UserPublic;
  forced?: boolean;
  onUpdated: (user: UserPublic) => void;
  onLogout?: () => void;
  onCancel?: () => void;
}

export const ChangePinView: React.FC<ChangePinViewProps> = ({
  user,
  forced = false,
  onUpdated,
  onLogout,
  onCancel,
}) => {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!currentPin || !newPin || !confirmPin) {
      setError('Fill in all three fields.');
      return;
    }
    if (newPin.trim().length < 4) {
      setError('Your new PIN or password must be at least 4 characters.');
      return;
    }
    if (newPin.trim() !== confirmPin.trim()) {
      setError('The new PIN and confirmation do not match.');
      return;
    }

    setLoading(true);
    try {
      const { user: updated } = await api.changePin(currentPin, newPin.trim());
      setSuccess('Your PIN has been updated.');
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update your PIN.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={forced ? 'min-h-screen bg-slate-50 flex items-center justify-center px-4 py-8' : ''}>
      <div className="mx-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-100 text-amber-800">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          {forced && onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span>{en.auth.signOut}</span>
            </button>
          )}
        </div>

        <h1 className="mt-4 font-display text-2xl font-bold text-slate-900">
          {forced ? en.auth.mustChangeTitle : 'Change your PIN or Password'}
        </h1>
        <p className="mt-2 text-base text-slate-600">
          {forced
            ? `Signed in as ${user.full_name} (${user.username}). ${en.auth.mustChangeHint}`
            : `Signed in as ${user.full_name} (${user.username}). Choose a private PIN only you know.`}
        </p>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
          >
            {error}
          </div>
        )}

        {success && (
          <div
            role="status"
            className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800"
          >
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="current-pin" className="block text-sm font-semibold text-slate-800">
              {en.auth.currentPinLabel}
            </label>
            <input
              id="current-pin"
              type="password"
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value)}
              className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-4 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
            />
          </div>

          <div>
            <label htmlFor="new-pin" className="block text-sm font-semibold text-slate-800">
              {en.auth.newPinLabel}
            </label>
            <input
              id="new-pin"
              type="password"
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              placeholder="At least 4 characters"
              className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-4 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
            />
          </div>

          <div>
            <label htmlFor="confirm-pin" className="block text-sm font-semibold text-slate-800">
              {en.auth.confirmPinLabel}
            </label>
            <input
              id="confirm-pin"
              type="password"
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className="mt-1.5 block w-full min-h-[48px] rounded-xl border border-slate-300 px-4 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
            />
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="flex-1 min-h-[48px] rounded-xl bg-slate-900 px-5 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {loading ? 'Saving...' : en.auth.saveNewPin}
            </button>
            {!forced && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="min-h-[48px] rounded-xl border border-slate-300 bg-white px-5 py-3 text-base font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};
