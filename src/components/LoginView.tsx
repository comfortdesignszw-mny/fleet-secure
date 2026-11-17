import React, { useState } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck, User as UserIcon } from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
import type { UserPublic } from '../shared/types';
import { PWAInstallButton } from './PWAInstallButton';

interface LoginViewProps {
  onSuccess: (user: UserPublic) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onSuccess }) => {
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username.trim() || !pin) {
      setError('Enter both your username and your PIN or password.');
      return;
    }

    setLoading(true);
    try {
      const { user } = await api.login(username.trim(), pin);
      onSuccess(user);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to reach the server. Check your internet connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-md flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-slate-900">
            {en.appName}
          </span>
        </div>
        <PWAInstallButton />
      </div>

      <main className="mx-auto my-8 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <h1 className="font-display text-2xl font-bold text-slate-900 text-balance">
          {en.auth.signInTitle}
        </h1>
        <p className="mt-2 text-base text-slate-600 leading-relaxed">{en.auth.signInHint}</p>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-5" noValidate>
          <div>
            <label htmlFor="login-username" className="block text-sm font-semibold text-slate-800">
              {en.auth.usernameLabel}
            </label>
            <div className="relative mt-1.5">
              <UserIcon
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="login-username"
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={en.auth.usernamePlaceholder}
                className="block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              />
            </div>
          </div>

          <div>
            <label htmlFor="login-pin" className="block text-sm font-semibold text-slate-800">
              {en.auth.pinLabel}
            </label>
            <div className="relative mt-1.5">
              <Lock
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                id="login-pin"
                name="pin"
                type={showPin ? 'text' : 'password'}
                autoComplete="current-password"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={en.auth.pinPlaceholder}
                className="block w-full min-h-[48px] rounded-xl border border-slate-300 bg-white pl-11 pr-12 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              />
              <button
                type="button"
                onClick={() => setShowPin((v) => !v)}
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                {showPin ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[52px] rounded-xl bg-slate-900 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          >
            {loading ? en.auth.signingIn : en.auth.signInButton}
          </button>
        </form>

        <div className="mt-6 border-t border-slate-200 pt-4 text-sm text-slate-600">
          Forgot your PIN or locked out? Ask your Supervisor or Administrator to reset your PIN.
        </div>
      </main>

      <footer className="mx-auto w-full max-w-md text-center text-xs text-slate-500">
        {en.appName} · {en.appSubtitle} · All entries are permanently logged.
      </footer>
    </div>
  );
};
