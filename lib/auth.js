import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// If OWNER_PASSWORD is not set, a random password is generated at startup and printed to the console
// (so the dashboard is never open or guessable). Set OWNER_PASSWORD in .env for a permanent one.
export const generatedPassword = env.ownerPassword ? null : randomBytes(9).toString('base64url');
const password = env.ownerPassword || generatedPassword;
const secret = env.sessionSecret || randomBytes(32).toString('hex');
const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'tm_admin';

const digest = (s) => createHash('sha256').update(s).digest();
export const checkPassword = (attempt) => timingSafeEqual(digest(String(attempt ?? '')), digest(password));

const sign = (v) => createHmac('sha256', secret).update(v).digest('base64url');

export function sessionCookie(secure) {
  const exp = String(Date.now() + SESSION_MS);
  return `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export function isAdmin(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`).exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(sign(m[1]));
  const b = Buffer.from(m[2]);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tiny in-memory sliding-window rate limiter keyed by string. */
const hits = new Map();
export function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}
