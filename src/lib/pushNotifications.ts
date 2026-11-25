import type { NotificationPriority, NotificationRecord, TripSummary } from '../shared/types';

export const PUSH_PREFS_KEY = 'fleet_secure_push_prefs_v1';
export const PUSH_PREFS_EVENT = 'fleet-secure-push-prefs-changed';
const ALERTED_NOTIF_IDS_KEY = 'fleet_secure_alerted_notif_ids_v1';
const ALERTED_LOCAL_HIRE_KEY = 'fleet_secure_alerted_local_hire_v1';

export interface PushPreferences {
  pushEnabled: boolean;
  soundEnabled: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  pushEnabled: true,
  soundEnabled: true,
};

export function getPushPreferences(): PushPreferences {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_PUSH_PREFERENCES };
    const raw = localStorage.getItem(PUSH_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PUSH_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<PushPreferences>;
    return {
      pushEnabled: parsed.pushEnabled !== undefined ? Boolean(parsed.pushEnabled) : true,
      soundEnabled: parsed.soundEnabled !== undefined ? Boolean(parsed.soundEnabled) : true,
    };
  } catch {
    return { ...DEFAULT_PUSH_PREFERENCES };
  }
}

export function setPushPreferences(next: Partial<PushPreferences>): PushPreferences {
  const merged: PushPreferences = {
    ...getPushPreferences(),
    ...next,
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PUSH_PREFS_KEY, JSON.stringify(merged));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PUSH_PREFS_EVENT, { detail: merged }));
    }
  } catch {
    // Ignore storage errors
  }
  return merged;
}

export function getNotificationPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

let sharedAudioCtx: AudioContext | null = null;
let audioUnlockInstalled = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

export function unlockNotificationAudio(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

export function installAudioUnlockListeners(): () => void {
  if (typeof window === 'undefined' || audioUnlockInstalled) {
    return () => undefined;
  }
  audioUnlockInstalled = true;
  const handler = () => {
    unlockNotificationAudio();
  };
  window.addEventListener('pointerdown', handler, { passive: true });
  window.addEventListener('keydown', handler, { passive: true });
  return () => {
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
    audioUnlockInstalled = false;
  };
}

export function playNotificationChime(priority: NotificationPriority = 'NORMAL'): boolean {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }

    const now = ctx.currentTime + 0.02;
    const notes =
      priority === 'HIGH'
        ? [
            { freq: 880, offset: 0, dur: 0.13 },
            { freq: 1174.66, offset: 0.14, dur: 0.13 },
            { freq: 1318.51, offset: 0.28, dur: 0.18 },
            { freq: 1174.66, offset: 0.52, dur: 0.12 },
            { freq: 1318.51, offset: 0.66, dur: 0.22 },
          ]
        : [
            { freq: 880, offset: 0, dur: 0.12 },
            { freq: 1174.66, offset: 0.13, dur: 0.22 },
          ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = priority === 'HIGH' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.offset);

      gain.gain.setValueAtTime(0.0001, now + n.offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + n.offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.offset + n.dur);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.offset);
      osc.stop(now + n.offset + n.dur + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}

export async function showDeviceNotification(params: {
  title: string;
  body: string;
  tag: string;
  tripId?: number | null;
  priority?: NotificationPriority;
}): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const notifOptions: NotificationOptions & { renotify?: boolean } = {
    body: params.body,
    icon: '/pwa-192x192.png',
    badge: '/favicon-48x48.png',
    tag: params.tag,
    renotify: true,
    requireInteraction: params.priority === 'HIGH',
    data: {
      tripId: params.tripId ?? null,
      url: '/',
    },
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race<ServiceWorkerRegistration | null>([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 900)),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(params.title, notifOptions);
        return true;
      }
    }
  } catch {
    // Fall back to standard Notification API
  }

  try {
    const n = new Notification(params.title, notifOptions);
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore
      }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

function readIdSet(key: string): string[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeIdSet(key: string, ids: string[], cap = 300): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(ids.slice(-cap)));
  } catch {
    // Ignore
  }
}

/**
 * Inspects newly fetched unread notifications, firing a chime + device push alert
 * for items not yet alerted on this device (respecting user preferences; default ON).
 */
export async function processIncomingNotifications(
  items: NotificationRecord[]
): Promise<{ alertedCount: number }> {
  const prefs = getPushPreferences();
  if (!prefs.pushEnabled && !prefs.soundEnabled) {
    return { alertedCount: 0 };
  }

  const unreadItems = items.filter((n) => !n.read_at);
  if (unreadItems.length === 0) return { alertedCount: 0 };

  const seenList = readIdSet(ALERTED_NOTIF_IDS_KEY);
  const seenSet = new Set(seenList);
  const fresh = unreadItems.filter((n) => !seenSet.has(String(n.id)));

  if (fresh.length === 0) return { alertedCount: 0 };

  for (const n of fresh) {
    seenSet.add(String(n.id));
  }
  writeIdSet(ALERTED_NOTIF_IDS_KEY, Array.from(seenSet));

  const highestPriority: NotificationPriority = fresh.some((n) => n.priority === 'HIGH')
    ? 'HIGH'
    : 'NORMAL';

  if (prefs.soundEnabled) {
    playNotificationChime(highestPriority);
  }

  if (prefs.pushEnabled && getNotificationPermissionState() === 'granted') {
    const topAlerts = fresh.slice(0, 3);
    for (const item of topAlerts) {
      await showDeviceNotification({
        title: item.title,
        body: item.body,
        tag: `fleet-secure-notif-${item.id}`,
        tripId: item.trip_id,
        priority: item.priority,
      });
    }
  }

  return { alertedCount: fresh.length };
}

/**
 * Ensures due / overdue hire vehicles also trigger sound + push notifications
 * from cached/loaded open trips even while offline.
 */
export async function notifyDueHiresLocally(trips: TripSummary[]): Promise<void> {
  const prefs = getPushPreferences();
  if (!prefs.pushEnabled && !prefs.soundEnabled) return;

  const todayHarare = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Harare',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const seenList = readIdSet(ALERTED_LOCAL_HIRE_KEY);
  const seenSet = new Set(seenList);
  const alerts: Array<{
    key: string;
    title: string;
    body: string;
    tripId: number;
    priority: NotificationPriority;
  }> = [];

  for (const t of trips) {
    if (t.status !== 'OPEN' || t.trip_type !== 'HIRE' || !t.expected_return_date) continue;
    const isOverdueDate = t.is_return_overdue || t.expected_return_date < todayHarare;
    const isDueToday = !isOverdueDate && (t.is_return_due || t.expected_return_date === todayHarare);
    if (!isOverdueDate && !isDueToday) continue;

    const kind = isOverdueDate ? 'overdue' : 'due';
    const key = `${todayHarare}:${t.id}:${kind}`;
    if (seenSet.has(key)) continue;

    seenSet.add(key);
    alerts.push({
      key,
      tripId: t.id,
      priority: 'HIGH',
      title: isOverdueDate
        ? `Overdue Vehicle Return: ${t.reg_number}`
        : `Vehicle Return Due Today: ${t.reg_number}`,
      body: isOverdueDate
        ? `${t.reg_number} (${t.make_model}) hired to ${t.client_name || 'client'} was due back on ${t.expected_return_date} and is still open.`
        : `${t.reg_number} (${t.make_model}) hired to ${t.client_name || 'client'} is due back today (${t.expected_return_date}).`,
    });
  }

  if (alerts.length === 0) return;
  writeIdSet(ALERTED_LOCAL_HIRE_KEY, Array.from(seenSet));

  if (prefs.soundEnabled) {
    playNotificationChime('HIGH');
  }
  if (prefs.pushEnabled && getNotificationPermissionState() === 'granted') {
    for (const a of alerts.slice(0, 3)) {
      await showDeviceNotification({
        title: a.title,
        body: a.body,
        tag: `fleet-secure-local-${a.key}`,
        tripId: a.tripId,
        priority: a.priority,
      });
    }
  }
}

export async function testNotificationAndSound(): Promise<{
  permission: NotificationPermission | 'unsupported';
  soundPlayed: boolean;
  notificationShown: boolean;
}> {
  const permission = await requestBrowserNotificationPermission();
  const soundPlayed = playNotificationChime('HIGH');
  let notificationShown = false;
  if (permission === 'granted') {
    notificationShown = await showDeviceNotification({
      title: 'Fleet Secure — Sound & Push Active',
      body: 'Alerts for vehicle returns, overdue hires, and flagged trips will chime and appear here.',
      tag: `fleet-secure-test-${Date.now()}`,
      priority: 'HIGH',
    });
  }
  return { permission, soundPlayed, notificationShown };
}
