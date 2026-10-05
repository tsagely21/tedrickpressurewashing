import { CONFIG, $, h, spinner, notice } from './util.js';
import { rpc, signIn, signOut, hasSession, signedUrls, removePhotos } from './supabase.js';
import { fmtDate, fmtRange, fromMin } from './shared/dates.js';
import { estimate, money } from './shared/pricing.js';

const app = $('#app');
const S = { data: null, urls: {}, tab: 'attention', openId: null, message: null, busy: false };
const own = (fn, args) => rpc(fn, args, { auth: true }); // owner calls carry the login token
const svcLabel = (id) => CONFIG.services.find((s) => s.id === id)?.label || id;
const svcDef = (id) => CONFIG.services.find((s) => s.id === id);
const winDef = (id) => CONFIG.scheduling.windows.find((w) => w.id === id);
const slotText = (s) => `${fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${s.fullDay ? 'Full day' : fmtRange(s.start, s.end)}`;
const LABELS = { pending: 'Pending approval', proposed: 'Proposed – awaiting customer', confirmed: 'Confirmed', declined: 'Declined', cancelled: 'Cancelled' };
// Order-insensitive JSON, to compare scheduling settings in the database with the site config.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

async function load() {
  if (!hasSession()) return loginView();
  try {
    if (!(await own('is_owner', {}))) return notOwnerView();
    let data = await own('owner_overview', {});
    // Keep the database's scheduling settings in step with config/site.config.json.
    if (canon(data.scheduling) !== canon(CONFIG.scheduling)) {
      await own('owner_sync_settings', { p_scheduling: CONFIG.scheduling });
      data = await own('owner_overview', {});
      S.message = S.message || notice('info', 'Scheduling settings were updated from the site configuration.');
    }
    S.data = data;
    S.urls = await signedUrls(data.quotes.flatMap((q) => q.photos.map((p) => p.path))).catch(() => ({}));
    $('#admin-actions').classList.remove('hidden');
    draw();
  } catch (err) {
    $('#admin-actions').classList.add('hidden');
    if (err.status === 401) return loginView();
    app.replaceChildren(notice('err', err.message));
  }
}

function loginView(error) {
  $('#admin-actions').classList.add('hidden');
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card login', onSubmit: async (e) => {
    e.preventDefault();
    try { await signIn(email.value.trim(), pw.value); await load(); }
    catch (err) { loginView(err.message); }
  } },
    h('h2', null, 'Owner login'),
    error && notice('err', error),
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'Email'), email),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Password'), pw),
    h('button', { class: 'btn btn-gold', type: 'submit' }, 'Log in'));
  app.replaceChildren(form);
  email.focus();
}

function notOwnerView() {
  $('#admin-actions').classList.remove('hidden');
  app.replaceChildren(notice('err', 'This account is not set up as the owner. Run supabase/make-owner.sql for this email (see the README), then log in again.'));
}

async function act(fn, okMessage) {
  if (S.busy) return;
  S.busy = true;
  S.message = null;
  try {
    await fn();
    S.message = notice('ok', okMessage);
  } catch (err) { S.message = notice('err', err.message); }
  S.busy = false;
  await load();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// One set of categories. A request is "confirmed" when its status is Confirmed or it has a confirmed appointment.
const latest = (q) => q.bookings[0];
const isConfirmed = (q) => q.status === 'confirmed' || latest(q)?.status === 'confirmed';
const CATEGORIES = [
  ['attention', 'Needs attention', (q) => !isConfirmed(q) && q.status !== 'closed' && (q.status === 'new' || ['pending', 'proposed'].includes(latest(q)?.status))],
  ['contacted', 'Contacted', (q) => q.status === 'contacted' && !isConfirmed(q)],
  ['confirmed', 'Confirmed', isConfirmed],
  ['all', 'All requests', () => true]
];

function draw() {
  const d = S.data;
  const setup = [];
  if (!CONFIG.notifications.email) setup.push(notice('warn', 'Email notifications are not set up. You will not be emailed about new requests or bookings, so check this dashboard regularly. Customers see their status on the website instead.'));
  if (CONFIG.scheduling.placeholder) setup.push(notice('warn', 'Setup: booking hours and time windows in config/site.config.json are placeholders. Enter your real hours and set "placeholder" to false.'));
  if (!Object.values(CONFIG.pricing.services).some((r) => typeof r.rate === 'number')) setup.push(notice('info', 'No pricing rates are configured, so customers see “Submit for a free personalized quote.” Add rates in config/site.config.json to show estimates.'));

  const tab = (id, label, count) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(S.tab === id), onClick: () => { S.tab = id; draw(); } }, label, count ? h('span', { class: 'count' }, count) : null);
  const test = CATEGORIES.find((c) => c[0] === S.tab)?.[2];
  app.replaceChildren(
    ...[S.message, ...setup].filter(Boolean),
    h('div', { class: 'tabs', role: 'tablist' },
      CATEGORIES.map(([id, label, fn]) => tab(id, label, id === 'all' ? 0 : d.quotes.filter(fn).length)),
      tab('blocks', 'Blocked dates', 0)),
    S.tab === 'blocks' ? blocksView() : S.tab === 'confirmed' ? confirmedView() : requestList(test || (() => true)));
  S.message = null;
  if (S.openId) { document.getElementById(`rq-${S.openId}`)?.scrollIntoView({ block: 'start' }); S.openId = null; }
}

// ---------- requests ----------
function requestList(test) {
  const list = S.data.quotes.filter(test);
  return list.length ? h('div', { class: 'req-list' }, list.map(requestCard)) : h('p', { class: 'empty' }, 'Nothing here yet.');
}

function measure(i) {
  if (i.unsure) return 'Customer unsure – needs assessment';
  if (i.linearFt) return `${i.linearFt} linear ft${i.heightFt ? `, ${i.heightFt} ft high` : ''}`;
  return `${Number(i.areaSqft).toLocaleString()} sq ft${i.length && i.width ? ` (${i.length} × ${i.width} ft)` : ''}`;
}

function requestCard(q) {
  const b = q.bookings[0];
  const c = q.contact;
  const open = (b && ['pending', 'proposed'].includes(b.status)) || S.openId === q.id;
  const est = estimate(CONFIG, q.items);
  return h('details', { class: 'rq', id: `rq-${q.id}`, open: open || null },
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
          est.available ? [h('p', null, h('strong', null, money(est.total, CONFIG.pricing.currency))), h('ul', null, est.lines.map((l) => h('li', null, `${l.label}: ${money(l.amount, CONFIG.pricing.currency)}`)))] : h('p', null, 'No dollar estimate (', est.reason === 'needs-assessment' ? 'needs assessment' : 'no rates configured', ').'),
          h('label', { class: 'label', for: `st-${q.id}` }, 'Quote status'),
          h('select', { id: `st-${q.id}`, disabled: b?.status === 'confirmed' ? true : null, onChange: (e) => act(() => own('owner_set_quote_status', { p_id: q.id, p_status: e.target.value }), 'Status updated.') },
            ['new', 'contacted', 'confirmed', 'closed'].map((s) => h('option', { value: s, selected: q.status === s }, s[0].toUpperCase() + s.slice(1)))),
          b?.status === 'confirmed' ? h('p', { class: 'muted' }, 'Has a confirmed appointment. Cancel the appointment to change this.') : null)),
      h('div', { class: 'box' }, h('h4', null, 'Services & measurements'),
        h('ul', null, q.items.map((i) => h('li', null, h('strong', null, svcLabel(i.id)), ` – ${measure(i)}; ${i.condition} dirt`,
          Object.entries(i.fields).length ? ` · ${svcDef(i.id).fields.filter((f) => i.fields[f.key]).map((f) => `${f.label.replace(' (optional)', '')}: ${i.fields[f.key]}`).join('; ')}` : '',
          i.notes ? h('div', { class: 'muted' }, `Notes: ${i.notes}`) : null))),
        q.notes ? h('p', null, h('strong', null, 'Customer notes: '), q.notes) : null),
      q.photos.length ? h('div', { class: 'box' }, h('h4', null, `Photos (${q.photos.length})`),
        h('div', { class: 'photos' }, q.photos.map((p) => h('a', { href: S.urls[p.path], target: '_blank', rel: 'noopener' }, h('img', { src: S.urls[p.path], alt: `Customer photo ${p.name || ''}`, loading: 'lazy' }))))) : null,
      q.bookings.length ? h('div', { class: 'box' }, h('h4', null, 'Booking'), q.bookings.map((bk, n) => bookingPanel(q, bk, n === 0))) : null,
      q.status === 'confirmed' && latest(q)?.status !== 'confirmed' ? h('div', { class: 'box' }, h('h4', null, 'Schedule appointment'), h('p', { class: 'muted' }, 'Pick the date and time. It is blocked on the customer calendar as soon as you save.'), scheduleForm(q)) : null,
      h('div', { class: 'actions' }, h('button', { class: 'link-btn', type: 'button', onClick: () => confirm(`Permanently delete request ${q.ref} from ${c.name}, including its photos and bookings?`) && act(async () => { await removePhotos(q.photos.map((p) => p.path)); await own('owner_delete_quote', { p_id: q.id }); }, 'Request deleted.') }, 'Delete this request'))));
}

function bookingPanel(q, b, latest) {
  const w = winDef(b.requested.windowId);
  const head = h('p', null, h('span', { class: `status-pill small ${b.status}` }, LABELS[b.status]), ' ',
    b.requested.windowId === 'custom' ? 'Scheduled by you' : `Requested ${fmtDate(b.requested.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${w ? w.label.toLowerCase() : b.requested.windowId}`,
    b.slot && b.status !== 'pending' ? ` · Scheduled: ${slotText(b.slot)}` : '');
  const extras = [b.note && h('p', { class: 'muted' }, `Customer note: ${b.note}`), b.ownerMessage && h('p', { class: 'muted' }, `Your message: ${b.ownerMessage}`)];
  if (!latest) return h('div', null, head, ...extras);

  if (b.status === 'confirmed') {
    return h('div', null, head, ...extras, h('button', { class: 'btn btn-danger btn-sm', type: 'button', onClick: () => confirm('Cancel this confirmed appointment? The time will open up again.') && act(() => own('owner_booking_action', { p_id: b.id, p_action: 'cancel', p_slot: null, p_message: null }), 'Appointment cancelled.') }, 'Cancel appointment'));
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
  const slot = () => ({ date: f.date.value, start: f.start.value, end: f.end.value, fullDay: f.full.checked });
  const btn = (label, cls, action, ok, confirmText) => h('button', { class: `btn ${cls} btn-sm`, type: 'button', disabled: S.busy ? true : null, onClick: () => {
    if (confirmText && !confirm(confirmText)) return;
    act(() => own('owner_booking_action', { p_id: b.id, p_action: action, p_slot: action === 'decline' ? null : slot(), p_message: f.msg.value }), ok);
  } }, label);

  return h('div', { class: 'slot-form' }, head, ...extras,
    h('p', { class: 'muted' }, 'Set the appointment time below (prefilled from the request). Accepting blocks that time so no one else can book it; the customer is told only after you accept.'),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: f.date.id }, 'Date'), f.date),
      h('div', { class: 'field' }, h('label', { for: f.start.id }, 'Start'), f.start),
      h('div', { class: 'field' }, h('label', { for: f.end.id }, 'End'), f.end)),
    h('label', { class: 'check' }, f.full, 'Full-day job (blocks the whole day)'),
    h('div', { class: 'field' }, h('label', { for: f.msg.id }, 'Message to customer'), f.msg),
    h('div', { class: 'actions' },
      b.status === 'pending' ? btn('Confirm appointment', 'btn-gold', 'accept', 'Appointment confirmed. See it under Confirmed.') : null,
      btn(b.status === 'proposed' ? 'Change proposed time' : 'Propose this time instead', 'btn-dark', 'propose', 'Alternative time sent to the customer.'),
      btn('Decline', 'btn-ghost', 'decline', 'Request declined.', 'Decline this request?')));
}

// ---------- confirmed appointments ----------
const tzName = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.scheduling.timezone, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName').value;
const confirmedRows = () => S.data.quotes
  .filter((q) => q.bookings[0]?.status === 'confirmed')
  .map((q) => ({ q, b: q.bookings[0] }))
  .sort((x, y) => (x.b.slot.date + String(x.b.slot.start).padStart(4, '0')).localeCompare(y.b.slot.date + String(y.b.slot.start).padStart(4, '0')));

// Pick a date/time for a confirmed request (or move an existing appointment). Blocks that time for customers right away.
function scheduleForm(q, b) {
  const cur = b?.slot;
  const uid = `${q.id}-${b ? 'r' : 's'}`;
  const f = {
    date: h('input', { id: `sd-${uid}`, type: 'date', min: S.data.today, required: true, value: cur?.date || '' }),
    start: h('input', { id: `ss-${uid}`, type: 'time', value: fromMin(cur && !cur.fullDay ? cur.start : 480) }),
    end: h('input', { id: `se-${uid}`, type: 'time', value: fromMin(cur && !cur.fullDay ? cur.end : 720) }),
    full: h('input', { id: `sf-${uid}`, type: 'checkbox', checked: Boolean(cur?.fullDay) }),
    msg: h('textarea', { id: `sm-${uid}`, maxlength: '500', placeholder: 'Optional note the customer will see on their status page' })
  };
  const sync = () => { f.start.disabled = f.end.disabled = f.full.checked; };
  f.full.addEventListener('change', sync);
  sync();
  return h('form', { class: 'sched-form', onSubmit: (e) => {
    e.preventDefault();
    act(() => own('owner_schedule_appointment', { p_quote_id: q.id, p_slot: { date: f.date.value, start: f.start.value, end: f.end.value, fullDay: f.full.checked }, p_message: f.msg.value }),
      b ? 'Appointment rescheduled. The new time is blocked on the customer calendar.' : 'Appointment scheduled. That time is now blocked on the customer calendar.');
  } },
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: f.date.id }, 'Date'), f.date),
      h('div', { class: 'field' }, h('label', { for: f.start.id }, 'Start'), f.start),
      h('div', { class: 'field' }, h('label', { for: f.end.id }, 'End'), f.end)),
    h('label', { class: 'check' }, f.full, 'Full-day job (blocks the whole day)'),
    h('div', { class: 'field' }, h('label', { for: f.msg.id }, 'Message to customer (optional)'), f.msg),
    h('button', { class: 'btn btn-gold btn-sm', type: 'submit', disabled: S.busy ? true : null }, b ? 'Save new time' : 'Schedule appointment'));
}

function apptCard({ q, b }) {
  const c = q.contact;
  return h('article', { class: 'appt' },
    h('div', { class: 'appt-when' },
      h('strong', null, fmtDate(b.slot.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
      h('span', null, b.slot.fullDay ? 'Full day' : fmtRange(b.slot.start, b.slot.end), ` (${tzName})`)),
    h('div', { class: 'appt-who' },
      h('strong', null, c.name, ' · ', q.ref),
      h('span', null, h('a', { href: `tel:${c.phone}` }, c.phone), c.email ? [' · ', h('a', { href: `mailto:${c.email}` }, c.email)] : null),
      h('span', null, `${c.address}, ${c.zip}`),
      h('span', { class: 'muted' }, q.items.map((i) => svcLabel(i.id)).join(', ')),
      b.ownerMessage ? h('span', { class: 'muted' }, `Your message: ${b.ownerMessage}`) : null),
    h('div', { class: 'appt-actions' },
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { S.openId = q.id; S.tab = 'all'; draw(); } }, 'View full request'),
      h('button', { class: 'btn btn-danger btn-sm', type: 'button', disabled: S.busy ? true : null, onClick: () => confirm(`Cancel ${c.name}'s confirmed appointment? The time will open up again.`) && act(() => own('owner_booking_action', { p_id: b.id, p_action: 'cancel', p_slot: null, p_message: null }), 'Appointment cancelled.') }, 'Cancel appointment')),
    h('details', { class: 'resched' }, h('summary', null, 'Reschedule this appointment'), scheduleForm(q, b)));
}

function confirmedView() {
  const rows = confirmedRows();
  const upcoming = rows.filter((r) => r.b.slot.date >= S.data.today);
  const past = rows.filter((r) => r.b.slot.date < S.data.today).reverse();
  const unscheduled = S.data.quotes.filter((q) => q.status === 'confirmed' && latest(q)?.status !== 'confirmed');
  return h('div', null,
    h('h3', null, 'Upcoming confirmed appointments'),
    upcoming.length ? h('div', { class: 'appt-list' }, upcoming.map(apptCard)) : h('p', { class: 'empty' }, 'No confirmed appointments yet. When you confirm a booking request, it will show up here.'),
    unscheduled.length ? [h('h3', { class: 'spaced' }, 'Marked confirmed (no appointment time in the system)'), h('div', { class: 'req-list' }, unscheduled.map(requestCard))] : null,
    past.length ? [h('h3', { class: 'spaced' }, 'Past appointments'), h('div', { class: 'appt-list' }, past.map(apptCard))] : null);
}

// ---------- blocked dates ----------
function blocksView() {
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
      h('h3', null, 'Block time off'),
      h('p', { class: 'muted' }, 'Customers cannot book blocked times.'),
      h('form', { class: 'card', onSubmit: (e) => { e.preventDefault(); act(() => own('owner_add_block', { p_date: date.value || null, p_all_day: all.checked, p_start: all.checked ? null : start.value, p_end: all.checked ? null : end.value, p_reason: reason.value }), 'Time blocked.'); } },
        h('div', { class: 'field' }, h('label', { for: 'bl-date' }, 'Date'), date),
        h('label', { class: 'check' }, all, 'Block the whole day'),
        h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'bl-start' }, 'From'), start), h('div', { class: 'field' }, h('label', { for: 'bl-end' }, 'To'), end)),
        h('div', { class: 'field' }, h('label', { for: 'bl-reason' }, 'Reason (private)'), reason),
        h('button', { class: 'btn btn-gold', type: 'submit' }, 'Block this time'))),
    h('div', null,
      h('h3', null, 'Blocked dates'),
      d.blocks.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Date', 'Time', 'Reason', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, d.blocks.map((b) => h('tr', null, h('td', null, fmtDate(b.date, { weekday: 'short', month: 'short', day: 'numeric' })), h('td', null, b.start == null ? 'All day' : fmtRange(b.start, b.end)), h('td', null, b.reason || ''), h('td', null, h('button', { class: 'link-btn', type: 'button', 'aria-label': `Remove block on ${b.date}`, onClick: () => act(() => own('owner_remove_block', { p_id: b.id }), 'Block removed.') }, 'Remove'))))))) : h('p', { class: 'empty' }, 'No blocked dates.')));
}
$('#logout').addEventListener('click', async () => { await signOut(); S.data = null; loginView(); });
$('#refresh').addEventListener('click', () => { app.replaceChildren(spinner()); load(); });
load();
