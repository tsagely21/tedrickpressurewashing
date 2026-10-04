// End-to-end tests: starts the real server on a throwaway database and exercises the HTTP API.
// Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, todayIn, weekday } from '../public/js/shared/dates.js';
import { estimate } from '../public/js/shared/pricing.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const DATA = join(tmpdir(), 'tedrick-e2e-data');
let server;
let cookie = '';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(path, { method = 'GET', body, auth = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}

const quoteBody = (over = {}) => ({
  propertyType: 'residential',
  services: [{ id: 'driveway-concrete', areaSqft: '400', condition: 'moderate', fields: { material: 'Concrete' } }],
  notes: '', photos: [],
  contact: { name: 'Test Customer', phone: '225-555-0100', email: 'test@example.com', address: '1 Main St', zip: '70801', preferred: 'phone' },
  ...over
});

async function newQuote(over) {
  const r = await call('/api/quotes', { method: 'POST', body: quoteBody(over) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

/** First bookable date (Mon–Sat) where both morning and afternoon are free. */
async function openDay(skip = 0) {
  const a = (await call('/api/availability')).data;
  const days = Object.entries(a.days).filter(([, d]) => d.windows.morning && d.windows.afternoon && d.windows['full-day']);
  return days[skip][0];
}

before(async () => {
  rmSync(DATA, { recursive: true, force: true });
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_DIR: DATA, QUOTE_LIMIT_PER_HOUR: '1000', OWNER_PASSWORD: 'testpass', RESEND_API_KEY: '', MAIL_FROM: '', OWNER_EMAIL: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testpass' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  if (server) { server.kill(); await once(server, 'exit'); }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* temp dir; OS cleans up */ }
});

test('home page renders with business details and no unfilled template tags', async () => {
  const r = await call('/');
  assert.equal(r.status, 200);
  assert.match(r.data, /Refresh Your Property\. Restore Your Curb Appeal\./);
  assert.match(r.data, /225-284-0115/);
  assert.doesNotMatch(r.data, /\{\{/);
});

test('static server blocks path traversal; owner API and photos require login', async () => {
  assert.ok([403, 404].includes((await call('/..%2f..%2fserver.js')).status));
  assert.equal((await call('/api/admin/overview')).status, 401);
  assert.equal((await call('/api/admin/photos/1')).status, 401);
  assert.equal((await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"nope"}' })).status, 401);
});

test('pricing: no dollar total without configured rates; total when rates exist', () => {
  const cfg = { services: [{ id: 'a', label: 'A', measure: 'area' }], pricing: { conditionMultipliers: {}, services: { a: { method: 'sqft', rate: null, minimum: null } } } };
  const items = [{ id: 'a', areaSqft: '100', condition: 'light' }];
  assert.equal(estimate(cfg, items).available, false);
  cfg.pricing.services.a = { method: 'sqft', rate: 0.5, minimum: 80 };
  assert.deepEqual(estimate(cfg, items).total, 80); // minimum charge applies
  assert.deepEqual(estimate(cfg, [{ id: 'a', areaSqft: '400', condition: 'light' }]).total, 200);
  assert.equal(estimate(cfg, [{ id: 'a', unsure: true, condition: 'light' }]).available, false);
});

test('quote validation rejects bad input with helpful messages', async () => {
  const bad = async (over, pattern) => {
    const r = await call('/api/quotes', { method: 'POST', body: quoteBody(over) });
    assert.equal(r.status, 400);
    assert.match(r.data.error, pattern);
  };
  await bad({ services: [] }, /at least one service/i);
  await bad({ services: [{ id: 'driveway-concrete', areaSqft: '', condition: 'light' }] }, /approximate area/i);
  await bad({ contact: { ...quoteBody().contact, zip: '12' } }, /ZIP/);
  await bad({ contact: { ...quoteBody().contact, phone: '123' } }, /phone/i);
  await bad({ website: 'spam' }, /could not submit/i);
  await bad({ photos: [{ name: 'x.png', data: 'data:image/png;base64,AAAA' }] }, /photo/i);
});

test('quote saves, fallback estimate shown, photos stored and visible only to owner', async () => {
  const q = await newQuote({ photos: [{ name: 'yard.png', data: PNG }] });
  assert.equal(q.estimate.available, false);
  assert.match(q.ref, /^TMPW-/);
  const status = await call(`/api/requests/${q.token}`);
  assert.equal(status.data.booking, null);
  const overview = (await call('/api/admin/overview', { auth: true })).data;
  const saved = overview.quotes.find((x) => x.ref === q.ref);
  assert.equal(saved.photos.length, 1);
  assert.equal(saved.contact.name, 'Test Customer');
  const photo = await fetch(`${BASE}/api/admin/photos/${saved.photos[0].id}`, { headers: { Cookie: cookie } });
  assert.equal(photo.headers.get('content-type'), 'image/png');
});

test('"not sure" and fence measurements are accepted', async () => {
  await newQuote({ services: [{ id: 'house-soft-wash', unsure: true, condition: 'heavy' }, { id: 'fence', linearFt: '120', heightFt: '6', condition: 'light' }] });
});

test('availability: public, no customer data, past dates and Sundays excluded', async () => {
  const a = (await call('/api/availability')).data;
  const today = todayIn(a.timezone);
  assert.equal(a.timezone, 'America/Chicago');
  assert.ok(!(today in a.days), 'today is not bookable with leadDays=1');
  assert.ok(Object.keys(a.days).every((d) => d > today));
  const sunday = Object.entries(a.days).find(([d]) => weekday(d) === 0);
  assert.equal(sunday[1].open, false);
  assert.doesNotMatch(JSON.stringify(a), /Customer|225-555/);
});

test('booking: past/unavailable dates rejected; valid request is pending and saved', async () => {
  const q = await newQuote();
  const yesterday = addDays(todayIn('America/Chicago'), -1);
  const past = await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: yesterday, windowId: 'morning' } });
  assert.equal(past.status, 409);
  const day = await openDay(0);
  const ok = await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'morning' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.booking.status, 'pending');
  const again = await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'afternoon' } });
  assert.equal(again.status, 409, 'one active booking per quote');
  const st = (await call(`/api/requests/${q.token}`)).data;
  assert.equal(st.booking.status, 'pending');
  assert.equal(st.booking.slot, null, 'no confirmed time until owner accepts');
});

test('confirmed appointments never overlap, even when approved simultaneously', async () => {
  const day = await openDay(1);
  const customers = [];
  for (let i = 0; i < 3; i++) {
    const q = await newQuote();
    const b = await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'morning' } });
    assert.equal(b.status, 201, 'several customers may request the same window; only approval blocks it');
    customers.push({ q, id: b.data.booking.id });
  }
  // Fire all three approvals at once.
  const results = await Promise.all(customers.map((c) => call(`/api/admin/bookings/${c.id}/accept`, { method: 'POST', body: {}, auth: true })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409], `expected exactly one approval, got ${codes}`);

  // The morning (and therefore the full day) is now unavailable to new customers; the afternoon is not.
  const a = (await call(`/api/availability?from=${day}&to=${day}`)).data.days[day];
  assert.equal(a.windows.morning, false);
  assert.equal(a.windows['full-day'], false);
  assert.equal(a.windows.afternoon, true);
  const late = await newQuote();
  const blocked = await call(`/api/requests/${late.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'morning' } });
  assert.equal(blocked.status, 409);

  // A different, non-overlapping window can still be approved; a full-day job on the same day cannot.
  const loser = customers[results.findIndex((r) => r.status === 409)];
  const afternoon = await call(`/api/admin/bookings/${loser.id}/accept`, { method: 'POST', body: { date: day, start: '12:00', end: '17:00' }, auth: true });
  assert.equal(afternoon.status, 200);
  const other = customers.find((c) => c.id !== loser.id && results[customers.indexOf(c)].status === 409);
  const full = await call(`/api/admin/bookings/${other.id}/accept`, { method: 'POST', body: { date: day, fullDay: true }, auth: true });
  assert.equal(full.status, 409);
  // Partial overlap (11:00–13:00 clips both) is also refused.
  const partial = await call(`/api/admin/bookings/${other.id}/accept`, { method: 'POST', body: { date: day, start: '11:00', end: '13:00' }, auth: true });
  assert.equal(partial.status, 409);
});

test('full-day appointment blocks the whole day', async () => {
  const day = await openDay(2);
  const q = await newQuote();
  const b = await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'full-day' } });
  assert.equal(b.status, 201);
  assert.equal((await call(`/api/admin/bookings/${b.data.booking.id}/accept`, { method: 'POST', body: {}, auth: true })).status, 200);
  const a = (await call(`/api/availability?from=${day}&to=${day}`)).data.days[day];
  assert.equal(a.open, false);
  assert.equal(Object.values(a.windows).some(Boolean), false);
  // Cancelling frees the day again.
  assert.equal((await call(`/api/admin/bookings/${b.data.booking.id}/cancel`, { method: 'POST', body: {}, auth: true })).status, 200);
  assert.equal((await call(`/api/availability?from=${day}&to=${day}`)).data.days[day].open, true);
});

test('owner can propose another time; customer confirms only by accepting; blocked dates stop bookings', async () => {
  const day = await openDay(3);
  const q = await newQuote();
  const b = (await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'morning' } })).data.booking;
  const prop = await call(`/api/admin/bookings/${b.id}/propose`, { method: 'POST', body: { date: day, start: '13:00', end: '15:00', message: 'Afternoon works better' }, auth: true });
  assert.equal(prop.data.booking.status, 'proposed');
  let st = (await call(`/api/requests/${q.token}`)).data;
  assert.equal(st.booking.status, 'proposed');
  // A proposal alone must not block the time.
  assert.equal((await call(`/api/availability?from=${day}&to=${day}`)).data.days[day].windows.afternoon, true);
  const acc = await call(`/api/requests/${q.token}/respond`, { method: 'POST', body: { action: 'accept' } });
  assert.equal(acc.data.booking.status, 'confirmed');
  assert.equal(acc.data.booking.slot.start, 13 * 60);

  const blockDay = await openDay(4);
  assert.equal((await call('/api/admin/blocks', { method: 'POST', body: { date: blockDay, allDay: true, reason: 'Day off' }, auth: true })).status, 201);
  const q2 = await newQuote();
  const r = await call(`/api/requests/${q2.token}/bookings`, { method: 'POST', body: { date: blockDay, windowId: 'morning' } });
  assert.equal(r.status, 409);
  const blocks = (await call('/api/admin/overview', { auth: true })).data.blocks;
  assert.equal((await call(`/api/admin/blocks/${blocks[0].id}`, { method: 'DELETE', auth: true })).status, 200);
  assert.equal((await call(`/api/requests/${q2.token}/bookings`, { method: 'POST', body: { date: blockDay, windowId: 'morning' } })).status, 201);
});

test('owner cannot approve a past date', async () => {
  const q = await newQuote();
  const day = await openDay(5);
  const b = (await call(`/api/requests/${q.token}/bookings`, { method: 'POST', body: { date: day, windowId: 'morning' } })).data.booking;
  const r = await call(`/api/admin/bookings/${b.id}/accept`, { method: 'POST', body: { date: addDays(todayIn('America/Chicago'), -2), start: '09:00', end: '10:00' }, auth: true });
  assert.equal(r.status, 400);
});
