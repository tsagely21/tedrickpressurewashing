import { CONFIG, $, h, icon, spinner, notice } from './util.js';
import { rpc, uploadPhoto } from './supabase.js';
import { estimate, money } from './shared/pricing.js';

const STEPS = ['Property & services', 'Measurements', 'Photos & contact', 'Review'];
const CONDITIONS = [
  ['light', 'Light', 'Light dust, dirt or fading'],
  ['moderate', 'Moderate', 'Visible dirt, algae or buildup'],
  ['heavy', 'Heavy', 'Heavy buildup or set-in stains']
];
const MAX_PHOTOS = 8;

const svc = (id) => CONFIG.services.find((s) => s.id === id);
const blankItem = () => ({ areaSqft: '', unsure: false, length: '', width: '', linearFt: '', heightFt: '', condition: 'moderate', fields: {}, notes: '' });
const blankState = () => ({
  step: 1, propertyType: 'residential', selected: [], items: {}, notes: '', website: '',
  photos: [], photoError: '', contact: { name: '', phone: '', email: '', address: '', zip: '', preferred: 'phone' },
  errors: {}, formError: '', submitting: false, submitted: null
});
let state = blankState();

const panel = () => $('#quote-panel');
const selectedServices = () => CONFIG.services.filter((s) => state.selected.includes(s.id));
const payloadItems = () => selectedServices().map((s) => ({ id: s.id, ...state.items[s.id] }));
const num = (v) => (v === '' || v == null ? NaN : Number(v));

// ---------- summary + estimate ----------
function estimateBlock(est, dark = false) {
  const wrap = h('div', { class: dark ? 'est-box' : 'review-block' });
  if (est?.available) {
    wrap.append(
      h('div', { class: 'est-total' }, money(est.total, CONFIG.pricing.currency)),
      h('ul', null, est.lines.map((l) => h('li', null, `${l.label}: ${money(l.amount, CONFIG.pricing.currency)}`))),
      h('p', { class: 'est-note' }, CONFIG.pricing.disclaimer));
  } else {
    wrap.append(
      h('strong', null, CONFIG.pricing.fallbackMessage),
      h('p', { class: 'est-note' }, est?.reason === 'needs-assessment' ? "We'll confirm measurements and send your price." : 'No payment is needed to request a quote.'));
  }
  return wrap;
}

function measureText(item) {
  if (item.unsure) return "Not sure – we'll assess";
  if (item.linearFt !== '') return `${item.linearFt} linear ft${item.heightFt ? `, ${item.heightFt} ft high` : ''}`;
  return item.areaSqft !== '' ? `${Number(item.areaSqft).toLocaleString()} sq ft` : '—';
}

function refreshSummary() {
  const body = $('#summary-body');
  const sel = selectedServices();
  const groups = [];
  groups.push(h('div', { class: 'sum-group' }, h('h4', null, 'Property'), h('p', { class: 'sum-empty' }, state.propertyType === 'commercial' ? 'Commercial' : 'Residential')));
  groups.push(h('div', { class: 'sum-group' }, h('h4', null, 'Services'),
    sel.length ? h('ul', null, sel.map((s) => h('li', null, `${s.label} – ${measureText(state.items[s.id])}`))) : h('p', { class: 'sum-empty' }, 'None selected yet')));
  if (state.contact.name) groups.push(h('div', { class: 'sum-group' }, h('h4', null, 'Contact'), h('p', { class: 'sum-empty' }, [state.contact.name, state.contact.phone].filter(Boolean).join(' · '))));
  if (state.photos.length) groups.push(h('div', { class: 'sum-group' }, h('h4', null, 'Photos'), h('p', { class: 'sum-empty' }, `${state.photos.length} attached`)));
  groups.push(h('div', { class: 'sum-group' }, h('h4', null, 'Estimate'),
    sel.length ? estimateBlock(estimate(CONFIG, payloadItems()), true) : h('p', { class: 'sum-empty' }, CONFIG.pricing.fallbackMessage)));
  body.replaceChildren(...groups);
}

function renderProgress() {
  const done = state.submitted ? STEPS.length + 1 : state.step;
  $('#progress').replaceChildren(...STEPS.map((label, i) => {
    const n = i + 1;
    const cls = n < done ? 'done' : n === state.step && !state.submitted ? 'current' : '';
    return h('li', { class: cls, 'aria-current': cls === 'current' ? 'step' : null }, label);
  }));
}

// ---------- rendering ----------
function go(step, { scroll = true } = {}) {
  state.step = step;
  state.formError = '';
  render();
  if (scroll) $('#progress').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('#step-title')?.focus({ preventScroll: true });
}

function render(focusId) {
  renderProgress();
  const p = panel();
  if (state.submitted) p.replaceChildren(successView());
  else p.replaceChildren(...[step1, step2, step3, step4][state.step - 1]());
  refreshSummary();
  if (focusId) document.getElementById(focusId)?.focus();
}

const title = (text) => h('h3', { id: 'step-title', tabindex: '-1' }, text);
const errorFor = (key) => state.errors[key] && h('p', { class: 'error-text', id: `err-${key}`, role: 'alert' }, state.errors[key]);

function navRow({ back, next, nextLabel = 'Continue', nextIcon = true }) {
  return h('div', { class: 'nav-row' },
    back ? h('button', { class: 'btn btn-ghost', type: 'button', onClick: back }, icon('left'), 'Back') : h('span'),
    h('div', { class: 'right' }, next && h('button', { class: 'btn btn-gold', type: 'button', onClick: next }, nextLabel, nextIcon && icon('right'))));
}

// Step 1
function step1() {
  return [
    title('Tell us about the property'),
    h('fieldset', null, h('legend', { class: 'label' }, 'Property type'),
      h('div', { class: 'choices' }, ['residential', 'commercial'].map((t) =>
        h('label', { class: 'choice' },
          h('input', { type: 'radio', name: 'propertyType', value: t, checked: state.propertyType === t, onChange: () => { state.propertyType = t; refreshSummary(); } }),
          h('span', null, t === 'residential' ? 'Residential (home)' : 'Commercial (business)'))))),
    h('fieldset', null, h('legend', { class: 'label' }, 'Services requested ', h('span', { class: 'hint' }, '(choose all that apply)')),
      h('div', { class: 'choices', 'aria-describedby': state.errors.services ? 'err-services' : null }, CONFIG.services.map((s) =>
        h('label', { class: 'choice' },
          h('input', { type: 'checkbox', name: 'service', value: s.id, checked: state.selected.includes(s.id), onChange: (e) => toggleService(s.id, e.target.checked) }),
          h('span', null, icon(s.icon), s.label)))),
      errorFor('services')),
    navRow({ next: () => { if (!state.selected.length) { state.errors = { services: 'Select at least one service to continue.' }; render('step-title'); return; } state.errors = {}; go(2); } })
  ];
}

function toggleService(id, on) {
  state.selected = on ? [...new Set([...state.selected, id])] : state.selected.filter((x) => x !== id);
  if (on && !state.items[id]) state.items[id] = blankItem();
  state.errors = {};
  $('#err-services')?.remove();
  refreshSummary();
}

// Step 2
function step2() {
  const cards = selectedServices().map(serviceCard);
  return [
    title('Measurements and job details'),
    h('p', { class: 'muted' }, 'Rough numbers are fine. We confirm everything before a final price. Not sure about a measurement? Choose “I’m not sure.”'),
    ...cards,
    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: assessAll }, 'I can’t estimate any of these: request an assessment'),
    navRow({ back: () => go(1), next: validateStep2 })
  ];
}

function assessAll() {
  selectedServices().forEach((s) => { state.items[s.id].unsure = true; });
  state.errors = {};
  go(3);
}

function serviceCard(s) {
  const item = state.items[s.id];
  const id = s.id;
  const off = item.unsure;
  const fence = s.measure === 'fence';
  const bad = Boolean(state.errors[id]);
  const bind = (key, scope = item) => (e) => { scope[key] = e.target.value; clearError(id); refreshSummary(); };

  const measure = [];
  if (fence) {
    measure.push(h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: `lin-${id}` }, s.measureLabel),
        h('input', { id: `lin-${id}`, type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: item.linearFt, disabled: off, 'aria-invalid': bad && !off ? 'true' : null, 'aria-describedby': bad ? `err-${id}` : null, onInput: bind('linearFt') })),
      h('div', { class: 'field' }, h('label', { for: `hgt-${id}` }, 'Average height (feet)'),
        h('input', { id: `hgt-${id}`, type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: item.heightFt, disabled: off, onInput: bind('heightFt') }))));
  } else {
    const area = h('input', { id: `area-${id}`, type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: item.areaSqft, disabled: off, 'aria-invalid': bad && !off ? 'true' : null, 'aria-describedby': bad ? `err-${id}` : null, onInput: bind('areaSqft') });
    const calc = () => {
      const l = num(item.length), w = num(item.width);
      if (l > 0 && w > 0) { item.areaSqft = String(Math.round(l * w)); area.value = item.areaSqft; clearError(id); refreshSummary(); }
    };
    measure.push(
      h('div', { class: 'field' }, h('label', { for: `area-${id}` }, s.measureLabel), area),
      h('details', { class: 'calc', open: item.length !== '' || item.width !== '' },
        h('summary', null, 'Calculate from length × width'),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('label', { for: `len-${id}` }, 'Length (ft)'), h('input', { id: `len-${id}`, type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: item.length, disabled: off, onInput: (e) => { item.length = e.target.value; calc(); } })),
          h('div', { class: 'field' }, h('label', { for: `wid-${id}` }, 'Width (ft)'), h('input', { id: `wid-${id}`, type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: item.width, disabled: off, onInput: (e) => { item.width = e.target.value; calc(); } })))));
  }

  const fields = s.fields.map((f) => {
    const fid = `f-${id}-${f.key}`;
    const input = f.type === 'select'
      ? h('select', { id: fid, onChange: (e) => { item.fields[f.key] = e.target.value; refreshSummary(); } },
          h('option', { value: '' }, 'Select…'),
          f.options.map((o) => h('option', { value: o, selected: item.fields[f.key] === o }, o)))
      : h('input', { id: fid, type: 'text', maxlength: '200', placeholder: f.placeholder || '', value: item.fields[f.key] || '', onInput: (e) => { item.fields[f.key] = e.target.value; } });
    return h('div', { class: 'field' }, h('label', { for: fid }, f.label), input);
  });

  return h('section', { class: 'svc-card', 'aria-labelledby': `h-${id}` },
    h('h4', { id: `h-${id}` }, icon(s.icon), s.label),
    h('p', { class: 'help' }, s.measureHelp),
    ...measure,
    h('label', { class: 'check' }, h('input', { id: `unsure-${id}`, type: 'checkbox', checked: off, onChange: (e) => { item.unsure = e.target.checked; clearError(id); render(`unsure-${id}`); } }), 'I’m not sure: please assess this for me'),
    errorFor(id),
    h('div', { class: 'row' }, fields),
    h('fieldset', null, h('legend', { class: 'label' }, 'Dirt / stain level'),
      h('div', { class: 'choices' }, CONDITIONS.map(([v, label, desc]) =>
        h('label', { class: 'choice' },
          h('input', { type: 'radio', name: `cond-${id}`, value: v, checked: item.condition === v, onChange: () => { item.condition = v; refreshSummary(); } }),
          h('span', null, h('div', null, label, h('small', null, desc))))))),
    h('div', { class: 'field' }, h('label', { for: `notes-${id}` }, 'Notes for this service (optional)'),
      h('textarea', { id: `notes-${id}`, maxlength: '1000', onInput: (e) => { item.notes = e.target.value; } }, item.notes)));
}

function clearError(id) {
  if (state.errors[id]) { delete state.errors[id]; document.getElementById(`err-${id}`)?.remove(); }
}

function validateStep2() {
  state.errors = {};
  for (const s of selectedServices()) {
    const it = state.items[s.id];
    if (it.unsure) continue;
    const ok = s.measure === 'fence' ? num(it.linearFt) > 0 : num(it.areaSqft) > 0;
    if (!ok) state.errors[s.id] = `Enter an approximate ${s.measure === 'fence' ? 'length' : 'size'} for ${s.label}, or choose “I’m not sure.”`;
  }
  const first = Object.keys(state.errors)[0];
  if (first) {
    render();
    const s = svc(first);
    document.getElementById(s.measure === 'fence' ? `lin-${first}` : `area-${first}`)?.focus();
    return;
  }
  go(3);
}

// Step 3
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.82));
}

async function addPhotos(files) {
  state.photoError = '';
  const problems = [];
  for (const f of files) {
    if (state.photos.length >= MAX_PHOTOS) { problems.push(`Only ${MAX_PHOTOS} photos can be attached.`); break; }
    if (!f.type.startsWith('image/')) { problems.push(`${f.name} isn't an image.`); continue; }
    try { const blob = await shrink(f); state.photos.push({ name: f.name, blob, url: URL.createObjectURL(blob) }); }
    catch { problems.push(`${f.name} couldn't be read. Try a JPG or PNG.`); }
  }
  state.photoError = problems.join(' ');
  render('photo-input');
}

const CONTACT_FIELDS = [
  ['name', 'Full name', 'text', 'name', 'name'],
  ['phone', 'Phone', 'tel', 'tel', 'tel'],
  ['email', 'Email', 'email', 'email', 'email'],
  ['address', 'Service address', 'text', 'street-address', 'street-address'],
  ['zip', 'ZIP code', 'text', 'postal-code', 'postal-code']
];

function step3() {
  const c = state.contact;
  const field = ([key, label, type, auto, _x]) => {
    const required = key !== 'email';
    return h('div', { class: 'field' },
      h('label', { for: `c-${key}` }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : h('span', { class: 'hint' }, ' (recommended)')),
      h('input', { id: `c-${key}`, type, autocomplete: auto, required, inputmode: key === 'zip' ? 'numeric' : null, maxlength: key === 'zip' ? '10' : '150', value: c[key], 'aria-invalid': state.errors[key] ? 'true' : null, 'aria-describedby': state.errors[key] ? `err-${key}` : null, onInput: (e) => { c[key] = e.target.value; if (state.errors[key]) { delete state.errors[key]; document.getElementById(`err-${key}`)?.remove(); } refreshSummary(); } }),
      errorFor(key));
  };
  return [
    title('Photos and contact information'),
    h('div', { class: 'field' },
      h('label', { for: 'photo-input' }, 'Property photos (optional)'),
      h('p', { class: 'hint' }, `Photos help us estimate accurately. Up to ${MAX_PHOTOS} images.`),
      h('div', { class: 'photo-drop' },
        h('input', { id: 'photo-input', type: 'file', accept: 'image/*', multiple: true, 'aria-describedby': 'photo-msg', onChange: (e) => { addPhotos([...e.target.files]); } })),
      h('div', { id: 'photo-msg' }, state.photoError && notice('err', state.photoError)),
      state.photos.length ? h('ul', { class: 'photo-grid', style: null }, state.photos.map((p, i) =>
        h('li', { class: 'thumb', role: 'listitem' }, h('img', { src: p.url, alt: `Attached photo ${i + 1}: ${p.name}` }),
          h('button', { type: 'button', 'aria-label': `Remove photo ${i + 1}`, onClick: () => { URL.revokeObjectURL(p.url); state.photos.splice(i, 1); render('photo-input'); } }, icon('close'))))) : null),
    h('div', { class: 'field' }, h('label', { for: 'q-notes' }, 'Anything else we should know? (optional)'),
      h('textarea', { id: 'q-notes', maxlength: '2000', onInput: (e) => { state.notes = e.target.value; } }, state.notes)),
    h('div', { class: 'row' }, CONTACT_FIELDS.slice(0, 3).map(field)),
    h('div', { class: 'row' }, CONTACT_FIELDS.slice(3).map(field)),
    h('fieldset', null, h('legend', { class: 'label' }, 'Preferred contact method'),
      h('div', { class: 'choices' }, [['phone', 'Phone call'], ['text', 'Text message'], ['email', 'Email']].map(([v, l]) =>
        h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'preferred', value: v, checked: c.preferred === v, onChange: () => { c.preferred = v; } }), h('span', null, l))))),
    h('div', { class: 'sr-only', 'aria-hidden': 'true' }, h('label', null, 'Leave this empty', h('input', { type: 'text', tabindex: '-1', autocomplete: 'off', value: state.website, onInput: (e) => { state.website = e.target.value; } }))),
    navRow({ back: () => go(2), next: validateStep3 })
  ];
}

function contactErrors() {
  const c = state.contact;
  const e = {};
  if (c.name.trim().length < 2) e.name = 'Please enter your name.';
  if (c.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a phone number with area code.';
  if (c.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) e.email = 'Enter a valid email address.';
  if (c.preferred === 'email' && !c.email.trim()) e.email = 'Add an email address, or choose another contact method.';
  if (!c.address.trim()) e.address = 'Enter the address where the work will be done.';
  if (!/^\d{5}(-\d{4})?$/.test(c.zip.trim())) e.zip = 'Enter a 5-digit ZIP code.';
  return e;
}

function validateStep3() {
  state.errors = contactErrors();
  const first = Object.keys(state.errors)[0];
  if (first) { render(); document.getElementById(`c-${first}`)?.focus(); return; }
  go(4);
}

// Step 4
function reviewBlock(heading, editStep, rows) {
  return h('section', { class: 'review-block' },
    h('header', null, h('h4', null, heading), h('button', { class: 'link-btn', type: 'button', onClick: () => go(editStep), 'aria-label': `Edit ${heading}` }, 'Edit')),
    h('dl', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
}

function step4() {
  const c = state.contact;
  const svcBlocks = selectedServices().map((s) => {
    const it = state.items[s.id];
    const rows = [['Size', measureText(it)], ['Dirt level', it.condition[0].toUpperCase() + it.condition.slice(1)]];
    for (const f of s.fields) if (it.fields[f.key]) rows.push([f.label.replace(' (optional)', ''), it.fields[f.key]]);
    if (it.notes.trim()) rows.push(['Notes', it.notes.trim()]);
    return reviewBlock(s.label, 2, rows);
  });
  return [
    title('Review your request'),
    state.formError && notice('err', state.formError),
    reviewBlock('Property', 1, [['Type', state.propertyType === 'commercial' ? 'Commercial' : 'Residential']]),
    ...svcBlocks,
    reviewBlock('Photos & notes', 3, [['Photos', state.photos.length ? `${state.photos.length} attached` : 'None'], ['Notes', state.notes.trim() || 'None']]),
    reviewBlock('Contact', 3, [['Name', c.name], ['Phone', c.phone], ['Email', c.email || 'Not provided'], ['Address', `${c.address}, ${c.zip}`], ['Prefer', { phone: 'Phone call', text: 'Text message', email: 'Email' }[c.preferred]]]),
    estimateBlock(estimate(CONFIG, payloadItems())),
    h('p', { class: 'muted' }, 'No payment is required to request a quote.'),
    h('div', { class: 'nav-row' },
      h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => go(3), disabled: state.submitting }, icon('left'), 'Back'),
      h('div', { class: 'right' }, h('button', { class: 'btn btn-gold btn-lg', type: 'button', id: 'submit-quote', disabled: state.submitting, onClick: submit }, state.submitting ? [spinner(), 'Sending…'] : 'Submit Quote Request')))
  ];
}

const numOrNull = (v) => { const n = Number(v); return v !== '' && v != null && n > 0 ? n : null; };
const rpcItems = () => payloadItems().map((i) => ({
  id: i.id, unsure: i.unsure, condition: i.condition, areaSqft: numOrNull(i.areaSqft), length: numOrNull(i.length), width: numOrNull(i.width),
  linearFt: numOrNull(i.linearFt), heightFt: numOrNull(i.heightFt), fields: i.fields, notes: i.notes
}));

async function submit() {
  state.submitting = true;
  state.formError = '';
  render();
  try {
    const id = crypto.randomUUID();
    const res = await rpc('submit_quote', {
      p_id: id,
      p_data: { propertyType: state.propertyType, items: rpcItems(), notes: state.notes, contact: state.contact, website: state.website }
    });
    // The request is saved. Photos go to private storage next; a photo failure must not hide that the quote went through.
    const files = [];
    let photosFailed = 0;
    for (const [i, p] of state.photos.entries()) {
      const path = `${id}/${i + 1}.jpg`;
      try { await uploadPhoto(path, p.blob); files.push({ path, name: p.name }); } catch { photosFailed++; }
    }
    if (files.length) {
      try { await rpc('attach_photos', { p_token: res.token, p_files: files }); } catch { photosFailed += files.length; }
    }
    state.submitting = false;
    state.submitted = { ref: res.ref, token: res.token, estimate: estimate(CONFIG, payloadItems()), photosFailed };
    try { localStorage.setItem('tm_request', JSON.stringify({ token: res.token, ref: res.ref })); } catch { /* storage unavailable */ }
    render();
    $('#progress').scrollIntoView({ block: 'start', behavior: 'smooth' });
    document.dispatchEvent(new CustomEvent('quote:submitted'));
  } catch (err) {
    state.submitting = false;
    state.formError = err.message;
    if (err.field && state.contact[err.field] !== undefined) { state.errors = { [err.field]: err.message }; state.step = 3; }
    else if (err.field && state.items[err.field]) { state.errors = { [err.field]: err.message }; state.step = 2; }
    render();
    $('#step-title')?.focus();
  }
}

function successView() {
  const r = state.submitted;
  const link = `${location.origin}/?request=${r.token}#booking`;
  return h('div', { class: 'success' },
    h('div', { class: 'tick' }, icon('check')),
    h('h3', { id: 'step-title', tabindex: '-1' }, 'Quote request received!'),
    h('p', null, 'Your request ID is ', h('span', { class: 'ref' }, r.ref), '.'),
    h('p', { class: 'muted' }, 'We’ll review your details and follow up using your preferred contact method.'),
    estimateBlock(r.estimate),
    r.photosFailed ? notice('warn', `Your request was saved, but ${r.photosFailed} photo${r.photosFailed > 1 ? 's' : ''} could not be uploaded. You can send photos when we contact you.`) : null,
    notice('info', CONFIG.notifications.email ? 'Save this link to check your booking status any time.' : 'Save this link to check your booking status. Email updates are not turned on yet, so this page is where you will see changes.'),
    h('p', null, h('a', { href: link }, link)),
    h('div', { class: 'hero-actions center' },
      h('a', { class: 'btn btn-gold btn-lg', href: '#booking' }, icon('right'), 'Next: request a booking time'),
      h('button', { class: 'btn btn-ghost btn-lg', type: 'button', onClick: () => { state = blankState(); render(); } }, 'Start another quote')));
}
// ---------- public API ----------
export function preselect(ids) {
  if (state.submitted) state = blankState();
  for (const id of ids) {
    if (!state.items[id]) state.items[id] = blankItem();
    if (!state.selected.includes(id)) state.selected.push(id);
  }
  state.step = 1;
  state.errors = {};
  render();
  $('#quote').scrollIntoView({ behavior: 'smooth' });
}

export function initQuote() {
  const summary = $('#quote-summary');
  const mq = window.matchMedia('(min-width: 961px)');
  const sync = () => { if (mq.matches) summary.setAttribute('open', ''); };
  mq.addEventListener('change', () => { if (mq.matches) summary.setAttribute('open', ''); else summary.removeAttribute('open'); });
  sync();
  summary.addEventListener('click', (e) => { if (mq.matches && e.target.closest('summary')) e.preventDefault(); });
  render();
}
