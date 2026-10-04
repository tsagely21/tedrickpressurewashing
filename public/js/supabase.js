// Minimal Supabase client using fetch: database functions (RPC), owner login (Auth), and photo storage.
// The publishable key is designed to be public; access is controlled by the database (see supabase/schema.sql).
import { CONFIG, ApiError } from './util.js';

const { url, publishableKey } = CONFIG.supabase;
const SESSION_KEY = 'tm_owner_session';
const GENERIC = 'Something went wrong on our end. Please call us to complete your request.';
const OFFLINE = 'We could not reach the server. Check your connection, or call us to complete your request.';

let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { /* storage unavailable */ }
function setSession(s) {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
export const hasSession = () => Boolean(session?.access_token);

const toSession = (d) => ({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000 });

function toApiError(status, data) {
  if (data?.code === 'P0001') return new ApiError(data.message, 400, data.details || null);
  if (data?.code === 'P0002') return new ApiError(data.message, 404);
  if (data?.code === '42501' || status === 403) return new ApiError('Not authorized.', 403);
  if (status === 401 || ['PGRST301', 'PGRST303'].includes(data?.code)) return new ApiError('Please log in.', 401);
  console.error('Supabase error', status, data);
  return new ApiError(data?.statusCode === '413' || status === 413 ? 'That file is too large.' : GENERIC, status);
}

async function refresh() {
  if (!session?.refresh_token) return false;
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) throw new Error('refresh failed');
    setSession(toSession(await res.json()));
    return true;
  } catch { setSession(null); return false; }
}

/** Low-level request. Customer calls send only the publishable key; owner calls (auth: true) add the login token. */
async function request(path, { method = 'GET', body, headers = {}, auth = false, json = true } = {}, retry = true) {
  if (auth && session && session.expires_at - 60_000 < Date.now()) await refresh();
  const h = { apikey: publishableKey, ...headers };
  if (auth && session) h.Authorization = `Bearer ${session.access_token}`;
  if (body !== undefined && json) h['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : json ? JSON.stringify(body) : body });
  } catch { throw new ApiError(OFFLINE, 0); }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && auth && retry && (await refresh())) return request(path, { method, body, headers, auth, json }, false);
  if (!res.ok) throw toApiError(res.status, data);
  return data;
}

/** Call a database function. */
export const rpc = (name, args = {}, { auth = false } = {}) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, auth });

// ---- owner login ----
export async function signIn(email, password) {
  let res;
  try {
    res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
    });
  } catch { throw new ApiError(OFFLINE, 0); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status === 400 ? 'Incorrect email or password.' : data.msg || data.message || GENERIC, res.status);
  setSession(toSession(data));
}

export async function signOut() {
  try { await request('/auth/v1/logout', { method: 'POST', auth: true, body: {} }, false); } catch { /* ignore */ }
  setSession(null);
}

// ---- photo storage (private bucket "quote-photos") ----
export async function uploadPhoto(path, blob) {
  await request(`/storage/v1/object/quote-photos/${path}`, { method: 'POST', body: blob, json: false, headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'false' } });
}

/** Owner only: temporary viewing URLs for private photos. Returns { path: url }. */
export async function signedUrls(paths) {
  if (!paths.length) return {};
  const rows = await request('/storage/v1/object/sign/quote-photos', { method: 'POST', auth: true, body: { expiresIn: 3600, paths } });
  return Object.fromEntries((rows || []).filter((r) => r.signedURL).map((r) => [r.path, `${url}/storage/v1${r.signedURL}`]));
}

export async function removePhotos(paths) {
  if (paths.length) await request('/storage/v1/object/quote-photos', { method: 'DELETE', auth: true, body: { prefixes: paths } });
}
