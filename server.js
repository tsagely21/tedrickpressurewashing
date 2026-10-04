import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, normalize, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { env, ROOT, emailConfigured } from './lib/env.js';
import { config } from './lib/config.js';
import { db, transaction } from './lib/db.js';
import { InputError, validateQuote, decodePhoto } from './lib/validate.js';
import { estimate } from './public/js/shared/pricing.js';
import { fmtDate, fmtRange, isDate, addDays } from './public/js/shared/dates.js';
import { checkPassword, clearCookie, generatedPassword, isAdmin, rateLimited, sessionCookie } from './lib/auth.js';
import { availability, bookableRange, confirmBooking, ConflictError, findConflict, parseSlot, ValidationError, windowById } from './lib/schedule.js';
import { notifyOwner, sendMail } from './lib/notify.js';

const PUBLIC = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};

const biz = config.business;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const demo = () => !emailConfigured();

// Public config sent to the browser (contains no secrets).
const publicConfig = () => ({ business: biz, pricing: config.pricing, scheduling: { timezone: config.scheduling.timezone, windows: config.scheduling.windows }, services: config.services, serviceCards: config.serviceCards, gallery: config.gallery, demo: demo() });

function renderHtml(html) {
  const vars = {
    name: esc(biz.name), shortName: esc(biz.shortName), owner: esc(biz.owner), phone: esc(biz.phone),
    phoneTel: '+1' + biz.phone.replace(/\D/g, ''), tagline: esc(biz.tagline), payments: esc(biz.payments.join(', ')),
    ministerDiscount: esc(biz.ministerDiscount), year: new Date().getFullYear(),
    configJson: JSON.stringify(publicConfig()).replace(/</g, '\\u003c')
  };
  return html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---------- helpers ----------
const send = (res, status, body, headers = {}) => {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, ...(isJson ? { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } : {}), ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
};

async function readJson(req, limit) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new InputError('Unsupported request.', null);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new InputError('That request is too large. Try fewer or smaller photos.', 'photos'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new InputError('Malformed request.', null); }
}

const baseUrl = (req) => env.publicUrl || `http://${req.headers.host}`;
const shortId = () => randomBytes(5).toString('hex').toUpperCase();
const clientIp = (req) => req.socket.remoteAddress || 'ip';

const slotOut = (b) => (b.slot_date ? { date: b.slot_date, start: b.slot_start, end: b.slot_end, fullDay: !!b.full_day } : null);
const bookingOut = (b) => !b ? null : ({
  id: b.id, status: b.status, requested: { date: b.req_date, windowId: b.req_window }, note: b.note || '',
  slot: slotOut(b), ownerMessage: b.owner_message || '', createdAt: b.created_at, updatedAt: b.updated_at
});
const latestBooking = (quoteId) => db.prepare('SELECT * FROM bookings WHERE quote_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(quoteId);
const activeBooking = (quoteId) => db.prepare("SELECT * FROM bookings WHERE quote_id=? AND status IN ('pending','proposed','confirmed')").get(quoteId);
const quoteByToken = (token) => db.prepare('SELECT * FROM quotes WHERE token=?').get(String(token || ''));
const serviceLabel = (id) => config.services.find((s) => s.id === id)?.label || id;
const slotText = (s) => `${fmtDate(s.date)}, ${s.fullDay ? 'full day' : fmtRange(s.start, s.end)} (Central Time)`;
const windowText = (b) => { const w = windowById(b.req_window); return `${fmtDate(b.req_date)}, ${w ? w.label.toLowerCase() : b.req_window}`; };

function quoteOut(q) {
  const data = JSON.parse(q.data);
  return {
    id: q.id, ref: q.ref, createdAt: q.created_at, status: q.status, ...data, estimate: JSON.parse(q.estimate),
    photos: db.prepare('SELECT id, original_name AS name FROM photos WHERE quote_id=?').all(q.id),
    bookings: db.prepare('SELECT * FROM bookings WHERE quote_id=? ORDER BY created_at DESC, rowid DESC').all(q.id).map(bookingOut)
  };
}

function quoteSummaryText(data) {
  const lines = data.items.map((i) => {
    const m = i.unsure ? 'size unknown (needs assessment)' : i.linearFt ? `${i.linearFt} ft${i.heightFt ? `, ${i.heightFt} ft high` : ''}` : `${i.areaSqft} sq ft`;
    return `  - ${serviceLabel(i.id)}: ${m}, ${i.condition} dirt/stain`;
  });
  return `${data.contact.name} · ${data.contact.phone}${data.contact.email ? ' · ' + data.contact.email : ''}\n${data.contact.address}, ${data.contact.zip} (${data.propertyType})\n${lines.join('\n')}`;
}

// ---------- API ----------
async function api(req, res, url) {
  const path = url.pathname;
  const method = req.method;
  let m;

  if (method === 'GET' && path === '/api/availability') {
    const { today, min, max } = bookableRange();
    const from = url.searchParams.get('from') || min;
    const to = url.searchParams.get('to') || addDays(from, 41);
    if (!isDate(from) || !isDate(to) || to < from) throw new InputError('Invalid date range.');
    return send(res, 200, availability(from, to));
  }

  if (method === 'POST' && path === '/api/quotes') {
    if (rateLimited('quote:' + clientIp(req), env.quoteLimitPerHour, 3600_000)) return send(res, 429, { error: 'Too many requests. Please call us instead.' });
    const body = await readJson(req, 28 * 1024 * 1024);
    const v = validateQuote(body);
    const photos = v.photos.map(decodePhoto);
    const est = estimate(config, v.items);
    const id = randomUUID();
    const ref = 'TMPW-' + shortId();
    const token = randomBytes(24).toString('base64url');
    const now = new Date().toISOString();
    const dir = join(env.dataDir, 'uploads', id);
    if (photos.length) await mkdir(dir, { recursive: true });
    const saved = [];
    for (const [i, p] of photos.entries()) {
      const filename = `${i + 1}.${p.ext}`;
      await writeFile(join(dir, filename), p.buf);
      saved.push({ filename, mime: p.mime, name: p.name });
    }
    transaction(() => {
      db.prepare('INSERT INTO quotes (id, ref, token, created_at, status, data, estimate) VALUES (?,?,?,?,?,?,?)')
        .run(id, ref, token, now, 'new', JSON.stringify({ propertyType: v.propertyType, items: v.items, notes: v.notes, contact: v.contact }), JSON.stringify(est));
      for (const p of saved) db.prepare('INSERT INTO photos (quote_id, filename, mime, original_name) VALUES (?,?,?,?)').run(id, p.filename, p.mime, p.name);
    });
    notifyOwner(`New quote request ${ref}`, `${quoteSummaryText(v)}\n\nPhotos: ${saved.length}\nReview it in the dashboard: ${baseUrl(req)}/admin/`);
    return send(res, 201, { ref, token, estimate: est, demo: demo() });
  }

  if ((m = /^\/api\/requests\/([\w-]+)$/.exec(path)) && method === 'GET') {
    const q = quoteByToken(m[1]);
    if (!q) return send(res, 404, { error: 'We could not find that request.' });
    const data = JSON.parse(q.data);
    return send(res, 200, {
      ref: q.ref, name: data.contact.name, services: data.items.map((i) => ({ id: i.id, label: serviceLabel(i.id) })),
      estimate: JSON.parse(q.estimate), booking: bookingOut(latestBooking(q.id)), demo: demo()
    });
  }

  if ((m = /^\/api\/requests\/([\w-]+)\/bookings$/.exec(path)) && method === 'POST') {
    const q = quoteByToken(m[1]);
    if (!q) return send(res, 404, { error: 'We could not find that quote request.' });
    const body = await readJson(req, 20_000);
    const { date, windowId } = body;
    if (!isDate(date) || !windowById(windowId)) throw new InputError('Choose a date and time window.');
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(() => {
      if (activeBooking(q.id)) throw new ConflictError('You already have a booking request for this quote.');
      const day = availability(date, date).days[date];
      if (!day?.windows[windowId]) throw new ConflictError('Sorry, that time is no longer available. Please choose another.');
      db.prepare("INSERT INTO bookings (id, quote_id, status, req_date, req_window, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, q.id, 'pending', date, windowId, note, now, now);
    });
    const data = JSON.parse(q.data);
    notifyOwner(`Booking request for ${windowText({ req_date: date, req_window: windowId })} (${q.ref})`, `${quoteSummaryText(data)}\n\nRequested: ${windowText({ req_date: date, req_window: windowId })}\n${note ? 'Note: ' + note + '\n' : ''}\nApprove, decline or propose another time: ${baseUrl(req)}/admin/`);
    return send(res, 201, { booking: bookingOut(db.prepare('SELECT * FROM bookings WHERE id=?').get(id)) });
  }

  if ((m = /^\/api\/requests\/([\w-]+)\/(cancel|respond)$/.exec(path)) && method === 'POST') {
    const q = quoteByToken(m[1]);
    const b = q && latestBooking(q.id);
    if (!b) return send(res, 404, { error: 'No booking request found.' });
    const data = JSON.parse(q.data);
    const now = new Date().toISOString();
    if (m[2] === 'cancel') {
      if (!['pending', 'proposed'].includes(b.status)) throw new ValidationError('Only a pending request can be cancelled online. Please call us to change a confirmed appointment.');
      db.prepare("UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?").run(now, b.id);
      return send(res, 200, { booking: bookingOut(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) });
    }
    const body = await readJson(req, 5000);
    if (b.status !== 'proposed') throw new ValidationError('There is no proposed time to respond to.');
    if (body.action === 'accept') {
      confirmBooking(b.id, { date: b.slot_date, start: b.slot_start, end: b.slot_end, fullDay: !!b.full_day });
      notifyOwner(`Customer accepted the proposed time (${q.ref})`, `${data.contact.name} accepted ${slotText(slotOut(b))}.`);
    } else if (body.action === 'decline') {
      db.prepare("UPDATE bookings SET status='cancelled', updated_at=? WHERE id=?").run(now, b.id);
      notifyOwner(`Customer declined the proposed time (${q.ref})`, `${data.contact.name} declined ${slotText(slotOut(b))}. Contact them: ${data.contact.phone}`);
    } else throw new InputError('Choose accept or decline.');
    return send(res, 200, { booking: bookingOut(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) });
  }

  // ----- owner -----
  if (method === 'POST' && path === '/api/admin/login') {
    if (rateLimited('login:' + clientIp(req), 8, 15 * 60_000)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const body = await readJson(req, 2000);
    if (!checkPassword(body.password)) return send(res, 401, { error: 'Incorrect password.' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req.headers['x-forwarded-proto'] === 'https') });
  }
  if (path.startsWith('/api/admin/')) {
    if (method === 'POST' && path === '/api/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    if (!isAdmin(req)) return send(res, 401, { error: 'Please log in.' });
    return adminApi(req, res, url, method, path);
  }

  return send(res, 404, { error: 'Not found.' });
}

async function adminApi(req, res, url, method, path) {
  let m;
  if (method === 'GET' && path === '/api/admin/overview') {
    const quotes = db.prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT 500').all().map(quoteOut);
    const blocks = db.prepare('SELECT id, date, start_min AS start, end_min AS end, reason FROM blocks ORDER BY date').all();
    const appointments = db.prepare("SELECT b.id, b.slot_date AS date, b.slot_start AS start, b.slot_end AS end, b.full_day AS fullDay, q.ref, q.data FROM bookings b JOIN quotes q ON q.id=b.quote_id WHERE b.status='confirmed' ORDER BY b.slot_date, b.slot_start").all()
      .map(({ data, ...a }) => ({ ...a, fullDay: !!a.fullDay, name: JSON.parse(data).contact.name }));
    const pricingConfigured = Object.values(config.pricing.services).some((r) => typeof r.rate === 'number');
    return send(res, 200, {
      quotes, blocks, appointments,
      setup: { emailConfigured: emailConfigured(), placeholderHours: !!config.scheduling.placeholder, pricingConfigured, generatedPassword: !!generatedPassword },
      windows: config.scheduling.windows, timezone: config.scheduling.timezone, today: bookableRange().today
    });
  }

  if ((m = /^\/api\/admin\/photos\/(\d+)$/.exec(path)) && method === 'GET') {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(Number(m[1]));
    if (!p) return send(res, 404, { error: 'Not found.' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=3600' });
    return createReadStream(join(env.dataDir, 'uploads', p.quote_id, p.filename)).pipe(res);
  }

  if ((m = /^\/api\/admin\/quotes\/([\w-]+)\/status$/.exec(path)) && method === 'POST') {
    const { status } = await readJson(req, 1000);
    if (!['new', 'contacted', 'closed'].includes(status)) throw new InputError('Invalid status.');
    db.prepare('UPDATE quotes SET status=? WHERE id=?').run(status, m[1]);
    return send(res, 200, { ok: true });
  }

  if ((m = /^\/api\/admin\/bookings\/([\w-]+)\/(accept|propose|decline|cancel)$/.exec(path)) && method === 'POST') {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(m[1]);
    if (!b) return send(res, 404, { error: 'Booking not found.' });
    const q = db.prepare('SELECT * FROM quotes WHERE id=?').get(b.quote_id);
    const data = JSON.parse(q.data);
    const body = await readJson(req, 5000);
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
    const now = new Date().toISOString();
    const link = `${baseUrl(req)}/?request=${q.token}#booking`;
    const mail = (subject, text) => sendMail({ to: data.contact.email, subject, text });

    if (m[2] === 'decline' || m[2] === 'cancel') {
      if (m[2] === 'decline' && !['pending', 'proposed'].includes(b.status)) throw new ValidationError(`This request is already ${b.status}.`);
      if (m[2] === 'cancel' && b.status !== 'confirmed') throw new ValidationError('Only confirmed appointments can be cancelled.');
      const status = m[2] === 'decline' ? 'declined' : 'cancelled';
      db.prepare('UPDATE bookings SET status=?, owner_message=?, updated_at=? WHERE id=?').run(status, message || null, now, b.id);
      mail(`Update on your ${biz.shortName} request`, `Hi ${data.contact.name},\n\nUnfortunately we can't ${status === 'declined' ? 'take' : 'keep'} the ${windowText(b)} appointment.${message ? '\n\n' + message : ''}\n\nPlease call ${biz.phone} or pick another time: ${link}`);
    } else {
      // Default to the customer's requested window when no explicit slot is given.
      const w = windowById(b.req_window);
      const slot = parseSlot(body.date ? body : { date: b.req_date, start: w?.start, end: w?.end, fullDay: !!w?.fullDay });
      if (m[2] === 'accept') {
        confirmBooking(b.id, slot, message || null);
        mail(`Your appointment is confirmed – ${biz.shortName}`, `Hi ${data.contact.name},\n\nYour appointment is confirmed for ${slotText({ date: slot.date, start: slot.start, end: slot.end, fullDay: slot.fullDay })}.${message ? '\n\n' + message : ''}\n\nQuestions? Call ${biz.phone}.\nDetails: ${link}`);
      } else {
        if (!['pending', 'proposed'].includes(b.status)) throw new ValidationError(`This request is already ${b.status}.`);
        if (findConflict(slot.date, slot.start, slot.end)) throw new ConflictError('That time overlaps a confirmed appointment or a blocked time.');
        db.prepare("UPDATE bookings SET status='proposed', slot_date=?, slot_start=?, slot_end=?, full_day=?, owner_message=?, updated_at=? WHERE id=?")
          .run(slot.date, slot.start, slot.end, slot.fullDay ? 1 : 0, message || null, now, b.id);
        mail(`A different time is proposed – ${biz.shortName}`, `Hi ${data.contact.name},\n\nWe can't do ${windowText(b)} but could do ${slotText({ date: slot.date, start: slot.start, end: slot.end, fullDay: slot.fullDay })}.${message ? '\n\n' + message : ''}\n\nAccept or decline here: ${link}\nYour appointment is NOT confirmed until you accept.`);
      }
    }
    return send(res, 200, { booking: bookingOut(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id)) });
  }

  if (method === 'POST' && path === '/api/admin/blocks') {
    const body = await readJson(req, 2000);
    if (!isDate(body.date)) throw new InputError('Choose a valid date.');
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
    let start = null, end = null;
    if (!body.allDay) { const s = parseSlot({ date: body.date, start: body.start, end: body.end }); start = s.start; end = s.end; }
    db.prepare('INSERT INTO blocks (date, start_min, end_min, reason, created_at) VALUES (?,?,?,?,?)').run(body.date, start, end, reason, new Date().toISOString());
    return send(res, 201, { ok: true });
  }
  if ((m = /^\/api\/admin\/blocks\/(\d+)$/.exec(path)) && method === 'DELETE') {
    db.prepare('DELETE FROM blocks WHERE id=?').run(Number(m[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found.' });
}

// ---------- static files ----------
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep)) return send(res, 403, 'Forbidden');
  let target = file;
  try {
    const s = await stat(file);
    if (s.isDirectory()) { res.writeHead(301, { Location: url.pathname + '/' }); return res.end(); }
  } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) {
    const html = renderHtml(await readFile(target, 'utf8'));
    return send(res, 200, html, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(target).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else send(res, 405, 'Method not allowed');
  } catch (err) {
    if (err instanceof InputError) return send(res, err.status || 400, { error: err.message, field: err.field });
    if (err instanceof ConflictError) return send(res, 409, { error: err.message });
    if (err instanceof ValidationError) return send(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our end. Please call us to complete your request.' });
  }
});

server.listen(env.port, () => {
  console.log(`\nTedrick Mobile Pressure Washing running at http://localhost:${env.port}`);
  console.log(`Owner dashboard:  http://localhost:${env.port}/admin/`);
  if (generatedPassword) console.log(`\n  ! OWNER_PASSWORD is not set. Temporary dashboard password for this run: ${generatedPassword}\n    Set OWNER_PASSWORD in .env to make it permanent.`);
  if (!emailConfigured()) console.log('\n  ! DEMO MODE for notifications: RESEND_API_KEY / MAIL_FROM / OWNER_EMAIL not set. Emails are written to data/outbox.log, not sent.');
  if (config.scheduling.placeholder) console.log('  ! Booking hours in config/site.config.json are placeholders. Set the real hours and "placeholder": false.');
  console.log('');
});
