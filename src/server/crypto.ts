import type { Role } from '../shared/types';

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toBase64Url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(derivedBits))}`;
}

export async function verifyPin(pin: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const salt = fromHex(parts[2]);
  const expected = fromHex(parts[3]);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return timingSafeEqualBytes(new Uint8Array(derivedBits), expected);
}

export interface SessionPayload {
  uid: number;
  username: string;
  role: Role;
  iat: number;
  exp: number;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSession(
  user: { id: number; username: string; role: Role },
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    uid: user.id,
    username: user.username,
    role: user.role,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const key = await importHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadPart));
  const sigPart = toBase64Url(new Uint8Array(sigBuffer));
  return `${payloadPart}.${sigPart}`;
}

export async function verifySession(
  token: string | undefined | null,
  secret: string
): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadPart, sigPart] = parts;
  if (!payloadPart || !sigPart) return null;

  try {
    const key = await importHmacKey(secret);
    const sigBytes = fromBase64Url(sigPart);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes as Uint8Array<ArrayBuffer>,
      new TextEncoder().encode(payloadPart)
    );
    if (!ok) return null;

    const json = new TextDecoder().decode(fromBase64Url(payloadPart));
    const payload = JSON.parse(json) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.uid || !payload.role || !payload.exp || payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
