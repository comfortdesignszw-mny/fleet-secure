import React, { useEffect, useState } from 'react';
import {
  Database,
  Eye,
  EyeOff,
  Lock,
  User as UserIcon,
  UserPlus,
} from 'lucide-react';
import { en } from '../i18n/en';
import { api, ApiError } from '../lib/api';
import type { UserPublic } from '../shared/types';
import { AppFooter } from './AppFooter';
import { PWAInstallButton } from './PWAInstallButton';

interface LoginViewProps {
  onSuccess: (user: UserPublic) => void;
}

type AuthMode = 'login' | 'signup';

export const LoginView: React.FC<LoginViewProps> = ({ onSuccess }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [previewEnabled, setPreviewEnabled] = useState(false);

  // Sign-in state
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  // Admin preview sign-up state
  const [fullName, setFullName] = useState('');
  const [signupUsername, setSignupUsername] = useState('');
  const [signupPin, setSignupPin] = useState('');
  const [showSignupPin, setShowSignupPin] = useState(false);
  const [loadDemoData, setLoadDemoData] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getPreviewStatus()
      .then((res) => {
        if (active) setPreviewEnabled(res.previewSignupEnabled);
      })
      .catch(() => {
        if (active) setPreviewEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
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

  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!fullName.trim() || fullName.trim().length < 2) {
      setError('Enter your full name (at least 2 characters).');
      return;
    }
    if (!signupUsername.trim()) {
      setError('Choose a username (e.g. comfort.admin).');
      return;
    }
    if (!signupPin.trim() || signupPin.trim().length < 4) {
      setError('Choose a PIN or password of at least 4 characters.');
      return;
    }

    setLoading(true);
    try {
      const { user } = await api.signupAdmin({
        full_name: fullName.trim(),
        username: signupUsername.trim().toLowerCase(),
        pin: signupPin.trim(),
        load_demo_data: loadDemoData,
      });
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
    <div className="relative min-h-screen overflow-x-hidden bg-gradient-to-b from-blue-50 via-[#F4F9FF] to-cyan-50/60 flex flex-col justify-between px-4 py-6 sm:px-6 sm:py-8">
      {/* Subtle decorative cyan/blue top aura */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-28 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-400/20 via-cyan-300/25 to-blue-500/20 blur-3xl"
      />

      <div className="relative mx-auto w-full max-w-md flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src="/pwa-192x192.png"
            alt="Fleet Secure logo"
            referrerPolicy="no-referrer"
            className="h-11 w-11 rounded-xl shadow-md shadow-cyan-500/25 object-cover ring-1 ring-blue-200/80 shrink-0"
          />
          <div>
            <span className="font-display text-lg font-bold tracking-tight text-blue-950 block leading-none">
              {en.appName}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-cyan-700">
              Yard & Fleet Record Book
            </span>
          </div>
        </div>
        <PWAInstallButton />
      </div>

      <main className="relative mx-auto my-6 w-full max-w-md rounded-2xl border border-blue-200/80 bg-white p-6 sm:p-8 shadow-lg shadow-blue-900/5 transition-shadow hover:border-cyan-300 hover:shadow-cyan-500/15">
        {previewEnabled && (
          <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-1.5">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`min-h-[44px] rounded-lg px-3 text-sm font-semibold transition-all ${
                mode === 'login'
                  ? 'cyan-glow-active'
                  : 'text-blue-900 hover:bg-white hover:text-cyan-700'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
              }}
              className={`inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-all ${
                mode === 'signup'
                  ? 'cyan-glow-active'
                  : 'text-blue-900 hover:bg-white hover:text-cyan-700'
              }`}
            >
              <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Admin Sign Up</span>
            </button>
          </div>
        )}

        {mode === 'login' ? (
          <>
            <h1 className="font-display text-2xl font-bold text-blue-950 text-balance">
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

            <form onSubmit={handleLoginSubmit} className="mt-6 space-y-5" noValidate>
              <div>
                <label htmlFor="login-username" className="block text-sm font-semibold text-blue-950">
                  {en.auth.usernameLabel}
                </label>
                <div className="relative mt-1.5">
                  <UserIcon
                    className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-500"
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
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="login-pin" className="block text-sm font-semibold text-blue-950">
                  {en.auth.pinLabel}
                </label>
                <div className="relative mt-1.5">
                  <Lock
                    className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-500"
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
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white pl-11 pr-12 text-base text-slate-900 placeholder:text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((v) => !v)}
                    aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-lg text-blue-600 hover:bg-cyan-50 hover:text-cyan-700"
                  >
                    {showPin ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="cyan-glow-btn w-full min-h-[52px] rounded-xl px-5 py-3 text-base font-semibold disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
              >
                {loading ? en.auth.signingIn : en.auth.signInButton}
              </button>
            </form>

            <div className="mt-5 border-t border-blue-100 pt-4 text-sm text-slate-600">
              Forgot your PIN or locked out? Ask your Supervisor or Administrator to reset your PIN.
            </div>
          </>
        ) : (
          <>
            <h1 className="font-display text-2xl font-bold text-blue-950 text-balance">
              Create Admin Account
            </h1>
            <p className="mt-1.5 text-sm sm:text-base text-slate-600 leading-relaxed">
              Register an Administrator account to manage your fleet, drivers, trips, and audit reports.
            </p>

            {error && (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSignupSubmit} className="mt-5 space-y-4" noValidate>
              <div>
                <label htmlFor="signup-fullname" className="block text-sm font-semibold text-blue-950">
                  Your Full Name
                </label>
                <input
                  id="signup-fullname"
                  type="text"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Comfort Moyo"
                  className="cyan-glow-input mt-1.5 block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white px-4 text-base text-slate-900 placeholder:text-slate-400"
                />
              </div>

              <div>
                <label htmlFor="signup-username" className="block text-sm font-semibold text-blue-950">
                  Choose Username
                </label>
                <div className="relative mt-1.5">
                  <UserIcon
                    className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-500"
                    aria-hidden="true"
                  />
                  <input
                    id="signup-username"
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    value={signupUsername}
                    onChange={(e) => setSignupUsername(e.target.value)}
                    placeholder="e.g. comfort.admin"
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white pl-11 pr-4 text-base text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  3–32 characters: letters, numbers, dots, underscores, or hyphens.
                </p>
              </div>

              <div>
                <label htmlFor="signup-pin" className="block text-sm font-semibold text-blue-950">
                  Choose PIN or Password
                </label>
                <div className="relative mt-1.5">
                  <Lock
                    className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-blue-500"
                    aria-hidden="true"
                  />
                  <input
                    id="signup-pin"
                    type={showSignupPin ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={signupPin}
                    onChange={(e) => setSignupPin(e.target.value)}
                    placeholder="At least 4 characters"
                    className="cyan-glow-input block w-full min-h-[48px] rounded-xl border border-blue-200 bg-white pl-11 pr-12 text-base text-slate-900 placeholder:text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSignupPin((v) => !v)}
                    aria-label={showSignupPin ? 'Hide PIN' : 'Show PIN'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-lg text-blue-600 hover:bg-cyan-50 hover:text-cyan-700"
                  >
                    {showSignupPin ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              <label className="cyan-glow-card flex cursor-pointer items-start gap-3 rounded-xl border border-blue-200 bg-blue-50/50 p-3.5">
                <input
                  type="checkbox"
                  checked={loadDemoData}
                  onChange={(e) => setLoadDemoData(e.target.checked)}
                  className="mt-0.5 h-5 w-5 rounded border-blue-300 text-cyan-600 focus:ring-cyan-500"
                />
                <span className="text-sm text-slate-700 leading-snug">
                  <span className="flex items-center gap-1.5 font-semibold text-blue-950">
                    <Database className="h-4 w-4 text-cyan-600 shrink-0" aria-hidden="true" />
                    <span>Include starter fleet &amp; drivers</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-600">
                    Populates starter vehicles and drivers so your workspace is ready immediately.
                  </span>
                </span>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="cyan-glow-btn w-full min-h-[52px] rounded-xl px-5 py-3 text-base font-semibold disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-500"
              >
                {loading ? 'Creating Admin Account...' : 'Create Admin & Enter App'}
              </button>
            </form>
          </>
        )}
      </main>

      <div className="relative mx-auto w-full max-w-2xl">
        <AppFooter compact />
      </div>
    </div>
  );
};
