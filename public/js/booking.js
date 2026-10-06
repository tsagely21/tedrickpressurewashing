import { CONFIG, $, h, icon, spinner, notice } from './util.js';
import { rpc } from './supabase.js';
import { notifyOwner } from './notify.js';
import { addDays, fmtDate, fmtRange, pad, toMin, weekday } from './shared/dates.js';

const KEY = 'tm_request';
const panel = () => $('#booking-panel');
const state = { token: null, ref: null, status: null, month: null, avail: null, date: null, windowId: null, note: '', busy: false, error: '', loading: false };

function loadToken() {
  const fromUrl = new URL(location.href).searchParams.get('request');
  try {
    if (fromUrl) localStorage.setItem(KEY, JSON.stringify({ token: fromUrl }));
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    state.token = saved?.token || fromUrl || null;
  } catch { state.token = fromUrl || null; }
}
const svcLabel = (id) => CONFIG.services.find((s) => s.id === id)?.label || id;
const forget = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } state.token = null; };

async function refresh() {
  loadToken();
  if (!state.token) { state.status = null; return draw(); }
  state.loading = true;
  draw();
  try {
    const r = await rpc('get_request', { p_token: state.token });
    state.status = { ...r, services: r.items.map((i) => ({ id: i.id, label: svcLabel(i.id) })) };
    state.ref = r.ref;
  } catch (err) {
    if (err.status === 404) forget();
    state.status = null;
    state.error = err.status === 404 ? '' : err.message;
  }
  state.loading = false;
  state.date = null; state.windowId = null; state.avail = null;
  draw();
}

function draw() {
  const p = panel();
  if (state.loading) return p.replaceChildren(h('p', { class: 'muted' }, spinner(), ' Loading your request…'));
  if (!state.status) return p.replaceChildren(noQuote());
  const b = state.status.booking;
  if (b && ['pending', 'proposed', 'confirmed'].includes(b.status)) return p.replaceChildren(...statusView(b));
  p.replaceChildren(...pickerView(b));
  if (!state.avail) loadAvailability();
}

function noQuote() {
  return h('div', { class: 'success' },
    state.error && notice('err', state.error),
    h('h3', null, 'Start with a quote request'),
    h('p', { class: 'muted' }, 'Booking requests are attached to a quote request, so you won’t need to re-enter your details. Build your quote first, then come back here to pick a time.'),
    h('a', { class: 'btn btn-gold btn-lg', href: '#quote', 'data-start-quote': '' }, 'Build My Quote'));
}

// ----- status of an existing booking -----
const slotLine = (s) => `${fmtDate(s.date)}, ${s.fullDay ? 'full day' : fmtRange(s.start, s.end)} (Central Time)`;
const windowLabel = (id) => CONFIG.scheduling.windows.find((w) => w.id === id)?.label.toLowerCase() || id;

function statusView(b) {
  const st = state.status;
  const head = h('p', { class: 'muted' }, `Request ${st.ref} · ${st.services.map((s) => s.label).join(', ')}`);
  const link = h('p', { class: 'muted' }, 'Bookmark this page to check back: ', h('a', { href: `/?request=${state.token}#booking` }, 'your request link'));
  const refreshBtn = h('button', { class: 'link-btn', type: 'button', onClick: refresh }, 'Check for updates');
  const msg = b.ownerMessage && notice('info', `Message from the owner: ${b.ownerMessage}`);
  const demo = !CONFIG.notifications.customerEmail && notice('info', 'Email updates are not turned on yet. Bookmark this page and check back, or call us.');
  const act = (label, kind, fn) => h('button', { class: `btn ${kind}`, type: 'button', disabled: state.busy, onClick: fn }, state.busy ? spinner() : null, label);
  const err = state.error && notice('err', state.error);
  let box;
  if (b.status === 'pending') {
    box = [h('span', { class: 'status-pill pending' }, 'Pending owner approval'),
      h('p', { class: 'when' }, `${fmtDate(b.requested.date)}, ${windowLabel(b.requested.windowId)}`),
      h('p', null, 'Your request has been saved. You are not confirmed yet: the owner will review it and accept, decline, or suggest another time.'),
      act('Cancel request / choose another time', 'btn-ghost', () => respond('cancel'))];
  } else if (b.status === 'proposed') {
    box = [h('span', { class: 'status-pill proposed' }, 'New time proposed'),
      h('p', { class: 'when' }, slotLine(b.slot)),
      h('p', null, 'The owner suggested a different time. You are not confirmed until you accept.'),
      h('div', { class: 'hero-actions center' }, act('Accept this time', 'btn-gold', () => respond('respond', { action: 'accept' })), act('Decline', 'btn-ghost', () => respond('respond', { action: 'decline' })))];
  } else {
    box = [h('span', { class: 'status-pill confirmed' }, 'Confirmed'),
      h('p', { class: 'when' }, slotLine(b.slot)),
      h('p', null, `Your appointment is confirmed. Need to change it? Call ${CONFIG.business.phone}.`)];
  }
  return [head, h('div', { class: 'status-box' }, ...box, msg, err, demo), h('p', { class: 'status-box' }, refreshBtn), h('div', { class: 'status-box' }, link)];
}

async function respond(action, body) {
  state.busy = true; state.error = '';
  draw();
  try {
    if (action === 'cancel') await rpc('cancel_booking', { p_token: state.token });
    else {
      await rpc('respond_proposal', { p_token: state.token, p_action: body.action });
      const who = `${state.status.name} (${state.ref})`;
      notifyOwner(`Customer ${body.action === 'accept' ? 'accepted' : 'declined'} the proposed time - ${state.ref}`, `${who} ${body.action === 'accept' ? 'ACCEPTED' : 'DECLINED'} the time you proposed.`, { reference: state.ref });
    }
    state.busy = false;
    await refresh();
  } catch (err) { state.busy = false; state.error = err.message; await refresh(); state.error = ''; }
}

// ----- date / window picker -----
const monthOf = (d) => d.slice(0, 7);
const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };

async function loadAvailability() {
  try {
    if (!state.month) {
      const first = await rpc('get_availability', {});
      state.month = monthOf(first.min);
      state.range = { min: first.min, max: first.max, today: first.today };
    }
    state.avail = await rpc('get_availability', { p_from: `${state.month}-01`, p_to: lastDay(state.month) });
    state.range = { min: state.avail.min, max: state.avail.max, today: state.avail.today };
  } catch (err) { state.error = err.message; state.avail = { days: {}, windows: CONFIG.scheduling.windows }; }
  draw();
}

function pickerView(prev) {
  const out = [h('p', { class: 'muted' }, `Request ${state.status.ref} · ${state.status.services.map((s) => s.label).join(', ')}`)];
  if (prev && ['declined', 'cancelled'].includes(prev.status)) {
    out.push(notice('warn', `Your previous request was ${prev.status}.${prev.ownerMessage ? ' ' + prev.ownerMessage : ''} You can request another time below.`));
  }
  if (state.error) out.push(notice('err', state.error));
  if (!state.avail) { out.push(h('p', { class: 'muted' }, spinner(), ' Loading available dates…')); return out; }

  const { range } = state;
  const ym = state.month;
  const days = state.avail.days;
  const lead = weekday(`${ym}-01`);
  const cells = [...['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => h('div', { class: 'cal-dow', 'aria-hidden': 'true' }, d)),
    ...Array.from({ length: lead }, () => h('div', { class: 'cal-blank' }))];
  for (let n = 1, d = `${ym}-01`; d <= lastDay(ym); n++, d = addDays(d, 1)) {
    const info = days[d];
    const ok = Boolean(info?.open);
    cells.push(h('button', { class: 'cal-day', type: 'button', disabled: !ok, 'aria-pressed': String(state.date === d), 'aria-label': `${fmtDate(d)}${ok ? '' : ', unavailable'}`, onClick: () => { state.date = d; state.windowId = null; draw(); document.getElementById('win-0')?.focus({ preventScroll: true }); } }, String(n)));
  }
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));
  const move = (n) => { state.month = addMonth(state.month, n); state.avail = null; state.date = null; state.error = ''; draw(); };

  out.push(
    h('div', { class: 'cal-head' },
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', disabled: ym <= monthOf(range.min), onClick: () => move(-1) }, icon('left')),
      h('h3', { 'aria-live': 'polite' }, monthName),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', disabled: ym >= monthOf(range.max), onClick: () => move(1) }, icon('right'))),
    h('div', { class: 'cal-grid', role: 'group', 'aria-label': 'Choose a date' }, cells),
    h('p', { class: 'cal-legend' }, 'Struck-through dates are unavailable, in the past, or already booked. All times are Central Time.'));

  if (state.date) {
    const info = days[state.date];
    out.push(h('fieldset', { class: 'field' }, h('legend', { class: 'label' }, `Time window on ${fmtDate(state.date, { weekday: 'long', month: 'long', day: 'numeric' })}`),
      h('div', { class: 'windows' }, CONFIG.scheduling.windows.map((w, i) => {
        const free = Boolean(info?.windows[w.id]);
        return h('label', { class: `choice${free ? '' : ' is-off'}` },
          h('input', { id: `win-${i}`, type: 'radio', name: 'window', value: w.id, disabled: !free, checked: state.windowId === w.id, onChange: () => { state.windowId = w.id; draw(); } }),
          h('span', null, h('div', null, w.label, h('small', null, `${fmtRange(toMin(w.start), toMin(w.end))}${free ? '' : ' · unavailable'}`))));
      }))));
  }
  out.push(
    h('div', { class: 'field' }, h('label', { for: 'b-note' }, 'Notes for scheduling (optional)'), h('textarea', { id: 'b-note', maxlength: '500', onInput: (e) => { state.note = e.target.value; } }, state.note)),
    h('div', { class: 'nav-row' }, h('span'), h('div', { class: 'right' },
      h('button', { class: 'btn btn-gold btn-lg', type: 'button', disabled: !state.date || !state.windowId || state.busy, onClick: submit }, state.busy ? [spinner(), 'Sending…'] : 'Request This Time'))),
    h('p', { class: 'muted' }, 'This is a request only. It will show as “Pending owner approval” until the owner accepts it. ', h('a', { href: '/privacy/', target: '_blank', rel: 'noopener' }, 'Privacy policy (opens in a new tab)'), '.'));
  return out;
}

async function submit() {
  state.busy = true; state.error = '';
  draw();
  try {
    await rpc('request_booking', { p_token: state.token, p_date: state.date, p_window: state.windowId, p_note: state.note });
    const win = CONFIG.scheduling.windows.find((w) => w.id === state.windowId);
    const services = state.status.services.map((s) => s.label).join(', ');
    notifyOwner(`Booking request ${state.ref} - ${fmtDate(state.date)}`,
      [`New booking request for ${state.status.name} (${state.ref})`, '', `Requested: ${fmtDate(state.date)}, ${win ? win.label.toLowerCase() : state.windowId} (Central Time)`, `Services: ${services}`, state.note.trim() ? `Note: ${state.note.trim()}` : '', '', 'Status: Pending owner approval. Confirm, decline or propose another time in the dashboard.'].filter((l) => l !== '').join('\n'),
      { reference: state.ref });
    state.busy = false; state.note = '';
    await refresh();
    panel().scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (err) {
    state.busy = false; state.error = err.message; state.avail = null; state.windowId = null;
    draw();
  }
}

export function initBooking() {
  document.addEventListener('quote:submitted', () => { state.month = null; refresh(); });
  refresh();
}
