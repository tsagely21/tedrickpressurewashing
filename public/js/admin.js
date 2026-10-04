import { CONFIG, $, h, api, spinner, notice } from './util.js';
import { fmtDate, fmtRange, fromMin } from './shared/dates.js';
import { money } from './shared/pricing.js';

const app = $('#app');
const S = { data: null, tab: 'requests', filter: 'attention', message: null, busy: null };
const svcLabel = (id) => CONFIG.services.find((s) => s.id === id)?.label || id;
const svcDef = (id) => CONFIG.services.find((s) => s.id === id);
const winDef = (id) => CONFIG.scheduling.windows.find((w) => w.id === id);
const slotText = (s) => `${fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${s.fullDay ? 'Full day' : fmtRange(s.start, s.end)}`;
const LABELS = { pending: 'Pending approval', proposed: 'Proposed – awaiting customer', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled' };

async function load() {
  try {
    S.data = await api('/api/admin/overview');
    $('#admin-actions').classList.remove('hidden');
    draw();
  } catch (err) {
    $('#admin-actions').classList.add('hidden');
    if (err.status === 401) return loginView();
    app.replaceChildren(notice('err', err.message));
  }
}

function loginView(error) {
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card login', onSubmit: async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: { password: pw.value } }); await load(); }
    catch (err) { loginView(err.message); }
  } },
    h('h2', null, 'Owner login'),
    error && notice('err', error),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), pw),
    h('button', { class: 'btn btn-gold', type: 'submit' }, 'Log in'));
  app.replaceChildren(form);
  pw.focus();
}

async function act(path, body, okMessage, method = 'POST') {
  S.busy = path;
  S.message = null;
  try {
    await api(path, { method, body });
    S.message = notice('ok', okMessage);
  } catch (err) { S.message = notice('err', err.message); }
  S.busy = null;
  await load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function draw() {
  const d = S.data;
  const needs = d.quotes.filter((q) => ['pending', 'proposed'].includes(q.bookings[0]?.status) || q.status === 'new');
  const setup = [];
  if (d.setup.generatedPassword) setup.push(notice('warn', 'Setup: OWNER_PASSWORD is not set; the server printed a temporary password to its console. Set OWNER_PASSWORD in .env.'));
  if (!d.setup.emailConfigured) setup.push(notice('warn', 'Demo mode for notifications: RESEND_API_KEY, MAIL_FROM and OWNER_EMAIL are not set. You will not be emailed about new requests and customers will not receive emails. Messages are written to data/outbox.log.'));
  if (d.setup.placeholderHours) setup.push(notice('warn', 'Setup: booking hours and time windows in config/site.config.json are placeholders. Enter your real hours and set "placeholder" to false.'));
  if (!d.setup.pricingConfigured) setup.push(notice('info', 'No pricing rates are configured, so customers see “Submit for a free personalized quote.” Add rates in config/site.config.json to show estimates.'));

  const tab = (id, label, count) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(S.tab === id), onClick: () => { S.tab = id; draw(); } }, label, count ? h('span', { class: 'count' }, count) : null);
  app.replaceChildren(
    ...[S.message, ...setup].filter(Boolean),
    h('div', { class: 'tabs', role: 'tablist' }, tab('requests', 'Requests', needs.length), tab('schedule', 'Schedule & blocked dates')),
    S.tab === 'requests' ? requestsView() : scheduleView());
  S.message = null;
}

// ---------- requests ----------
function requestsView() {
  const filters = [['attention', 'Needs attention'], ['confirmed', 'Confirmed'], ['all', 'All']];
  const list = S.data.quotes.filter((q) => {
    const b = q.bookings[0];
    if (S.filter === 'confirmed') return b?.status === 'confirmed';
    if (S.filter === 'attention') return ['pending', 'proposed'].includes(b?.status) || q.status === 'new';
    return true;
  });
  return h('div', null,
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter requests' }, filters.map(([id, l]) => h('button', { class: 'tab', 'aria-pressed': String(S.filter === id), 'aria-selected': String(S.filter === id), onClick: () => { S.filter = id; draw(); } }, l))),
    list.length ? h('div', { class: 'req-list' }, list.map(requestCard)) : h('p', { class: 'empty' }, 'Nothing here yet.'));
}

function measure(i) {
  if (i.unsure) return 'Customer unsure – needs assessment';
  if (i.linearFt) return `${i.linearFt} linear ft${i.heightFt ? `, ${i.heightFt} ft high` : ''}`;
  return `${Number(i.areaSqft).toLocaleString()} sq ft${i.length && i.width ? ` (${i.length} × ${i.width} ft)` : ''}`;
}

function requestCard(q) {
  const b = q.bookings[0];
  const c = q.contact;
  const open = b && ['pending', 'proposed'].includes(b.status);
  return h('details', { class: 'rq', open: open || null },
    h('summary', null,
      h('span', { class: 'who' }, c.name, ' · ', q.ref),
      h('span', { class: 'pills' },
        q.status === 'new' ? h('span', { class: 'status-pill small pill-new' }, 'New') : null,
        b ? h('span', { class: `status-pill small ${b.status}` }, LABELS[b.status]) : h('span', { class: 'sub' }, 'No booking requested')),
      h('span', { class: 'sub' }, `${new Date(q.createdAt).toLocaleString('en-US', { timeZone: CONFIG.scheduling.timezone, dateStyle: 'medium', timeStyle: 'short' })} · ${q.items.map((i) => svcLabel(i.id)).join(', ')}`)),
    h('div', { class: 'req-body' },
      h('div', { class: 'cols' },
        h('div', { class: 'box' }, h('h4', null, 'Contact'),
          h('p', null, h('strong', null, c.name)),
          h('p', null, h('a', { href: `tel:${c.phone}` }, c.phone), c.email ? [' · ', h('a', { href: `mailto:${c.email}` }, c.email)] : null),
          h('p', null, `${c.address}, ${c.zip}`),
          h('p', null, `${q.propertyType === 'commercial' ? 'Commercial' : 'Residential'} · prefers ${{ phone: 'phone call', text: 'text message', email: 'email' }[c.preferred]}`)),
        h('div', { class: 'box' }, h('h4', null, 'Estimate'),
          q.estimate.available ? [h('p', null, h('strong', null, money(q.estimate.total, CONFIG.pricing.currency))), h('ul', null, q.estimate.lines.map((l) => h('li', null, `${l.label}: ${money(l.amount, CONFIG.pricing.currency)}`)))] : h('p', null, 'No estimate shown to customer (', q.estimate.reason === 'needs-assessment' ? 'needs assessment' : 'no rates configured', ').'),
          h('label', { class: 'label', for: `st-${q.id}` }, 'Quote status'),
          h('select', { id: `st-${q.id}`, onChange: (e) => act(`/api/admin/quotes/${q.id}/status`, { status: e.target.value }, 'Status updated.') },
            ['new', 'contacted', 'closed'].map((s) => h('option', { value: s, selected: q.status === s }, s[0].toUpperCase() + s.slice(1)))))),
      h('div', { class: 'box' }, h('h4', null, 'Services & measurements'),
        h('ul', null, q.items.map((i) => h('li', null, h('strong', null, svcLabel(i.id)), ` – ${measure(i)}; ${i.condition} dirt`,
          Object.entries(i.fields).length ? ` · ${svcDef(i.id).fields.filter((f) => i.fields[f.key]).map((f) => `${f.label.replace(' (optional)', '')}: ${i.fields[f.key]}`).join('; ')}` : '',
          i.notes ? h('div', { class: 'muted' }, `Notes: ${i.notes}`) : null))),
        q.notes ? h('p', null, h('strong', null, 'Customer notes: '), q.notes) : null),
      q.photos.length ? h('div', { class: 'box' }, h('h4', null, `Photos (${q.photos.length})`),
        h('div', { class: 'photos' }, q.photos.map((p) => h('a', { href: `/api/admin/photos/${p.id}`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/admin/photos/${p.id}`, alt: `Customer photo ${p.name || ''}`, loading: 'lazy' }))))) : null,
      q.bookings.length ? h('div', { class: 'box' }, h('h4', null, 'Booking'), q.bookings.map((bk, n) => bookingPanel(q, bk, n === 0))) : null));
}

function bookingPanel(q, b, latest) {
  const w = winDef(b.requested.windowId);
  const head = h('p', null, h('span', { class: `status-pill small ${b.status}` }, LABELS[b.status]), ' ',
    `Requested ${fmtDate(b.requested.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${w ? w.label.toLowerCase() : b.requested.windowId}`,
    b.slot && b.status !== 'pending' ? ` · Scheduled: ${slotText(b.slot)}` : '');
  const extras = [b.note && h('p', { class: 'muted' }, `Customer note: ${b.note}`), b.ownerMessage && h('p', { class: 'muted' }, `Your message: ${b.ownerMessage}`)];
  if (!latest) return h('div', null, head, ...extras);

  if (b.status === 'confirmed') {
    return h('div', null, head, ...extras, h('button', { class: 'btn btn-danger btn-sm', type: 'button', onClick: () => confirm('Cancel this confirmed appointment? The time will open up again.') && act(`/api/admin/bookings/${b.id}/cancel`, {}, 'Appointment cancelled.') }, 'Cancel appointment'));
  }
  if (!['pending', 'proposed'].includes(b.status)) return h('div', null, head, ...extras);

  const f = {
    date: h('input', { id: `d-${b.id}`, type: 'date', min: S.data.today, value: b.slot?.date || b.requested.date }),
    start: h('input', { id: `s-${b.id}`, type: 'time', value: fromMin(b.slot?.start ?? (w ? Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3)) : 480)) }),
    end: h('input', { id: `e-${b.id}`, type: 'time', value: fromMin(b.slot?.end ?? (w ? Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3)) : 720)) }),
    full: h('input', { id: `f-${b.id}`, type: 'checkbox', checked: b.slot ? b.slot.fullDay : Boolean(w?.fullDay) }),
    msg: h('textarea', { id: `m-${b.id}`, maxlength: '500', placeholder: 'Optional message to the customer' })
  };
  const sync = () => { f.start.disabled = f.end.disabled = f.full.checked; };
  f.full.addEventListener('change', sync);
  sync();
  const body = () => ({ date: f.date.value, start: f.start.value, end: f.end.value, fullDay: f.full.checked, message: f.msg.value });
  const btn = (label, cls, path, ok, confirmText) => h('button', { class: `btn ${cls} btn-sm`, type: 'button', disabled: S.busy ? true : null, onClick: () => { if (confirmText && !confirm(confirmText)) return; act(`/api/admin/bookings/${b.id}/${path}`, body(), ok); } }, label);

  return h('div', { class: 'slot-form' }, head, ...extras,
    h('p', { class: 'muted' }, 'Set the appointment time below (prefilled from the request). Accepting blocks that time so no one else can book it; the customer is told only after you accept.'),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: f.date.id }, 'Date'), f.date),
      h('div', { class: 'field' }, h('label', { for: f.start.id }, 'Start'), f.start),
      h('div', { class: 'field' }, h('label', { for: f.end.id }, 'End'), f.end)),
    h('label', { class: 'check' }, f.full, 'Full-day job (blocks the whole day)'),
    h('div', { class: 'field' }, h('label', { for: f.msg.id }, 'Message to customer'), f.msg),
    h('div', { class: 'actions' },
      b.status === 'pending' ? btn('Accept & confirm', 'btn-gold', 'accept', 'Appointment confirmed.') : null,
      btn(b.status === 'proposed' ? 'Change proposed time' : 'Propose this time instead', 'btn-dark', 'propose', 'Alternative time sent to the customer.'),
      btn('Decline', 'btn-ghost', 'decline', 'Request declined.', 'Decline this request?')));
}

// ---------- schedule ----------
function scheduleView() {
  const d = S.data;
  const date = h('input', { id: 'bl-date', type: 'date', min: d.today, required: true });
  const start = h('input', { id: 'bl-start', type: 'time', value: '08:00' });
  const end = h('input', { id: 'bl-end', type: 'time', value: '17:00' });
  const all = h('input', { id: 'bl-all', type: 'checkbox', checked: true });
  const reason = h('input', { id: 'bl-reason', type: 'text', maxlength: '200', placeholder: 'e.g. Day off' });
  const sync = () => { start.disabled = end.disabled = all.checked; };
  all.addEventListener('change', sync);
  sync();

  return h('div', { class: 'cols' },
    h('div', null,
      h('h3', null, 'Confirmed appointments'),
      d.appointments.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Date', 'Time', 'Customer', 'Request'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, d.appointments.map((a) => h('tr', null, h('td', null, fmtDate(a.date, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', null, a.fullDay ? 'Full day' : fmtRange(a.start, a.end)), h('td', null, a.name), h('td', null, a.ref)))))) : h('p', { class: 'empty' }, 'No confirmed appointments.')),
    h('div', null,
      h('h3', null, 'Block time off'),
      h('form', { class: 'card', onSubmit: (e) => { e.preventDefault(); act('/api/admin/blocks', { date: date.value, allDay: all.checked, start: start.value, end: end.value, reason: reason.value }, 'Time blocked.'); } },
        h('div', { class: 'field' }, h('label', { for: 'bl-date' }, 'Date'), date),
        h('label', { class: 'check' }, all, 'Block the whole day'),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'bl-start' }, 'From'), start), h('div', { class: 'field' }, h('label', { for: 'bl-end' }, 'To'), end)),
        h('div', { class: 'field' }, h('label', { for: 'bl-reason' }, 'Reason (private)'), reason),
        h('button', { class: 'btn btn-gold', type: 'submit' }, 'Block this time')),
      h('h3', null, 'Blocked dates'),
      d.blocks.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Date', 'Time', 'Reason', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, d.blocks.map((b) => h('tr', null, h('td', null, fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', null, b.start == null ? 'All day' : fmtRange(b.start, b.end)), h('td', null, b.reason || ''), h('td', null, h('button', { class: 'link-btn', type: 'button', 'aria-label': `Remove block on ${b.date}`, onClick: () => act(`/api/admin/blocks/${b.id}`, undefined, 'Block removed.', 'DELETE') }, 'Remove'))))))) : h('p', { class: 'empty' }, 'No blocked dates.')));
}

$('#logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); S.data = null; $('#admin-actions').classList.add('hidden'); loginView(); });
$('#refresh').addEventListener('click', () => { app.replaceChildren(spinner()); load(); });
load();
