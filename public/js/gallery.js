import { CONFIG, $, h, icon } from './util.js';

const projects = CONFIG.gallery;
const src = (p) => '/' + p.replace(/^\//, '');
let current = 0;

function placeholder(text, note) {
  return h('div', { class: 'placeholder', role: 'img', 'aria-label': text }, icon('image'), h('span', null, text), note && h('small', null, note));
}

function card(p, i) {
  const hasPhotos = p.before || p.after.length;
  const cover = p.before || p.after[0];
  return h('button', { class: 'g-card', type: 'button', role: 'listitem', 'aria-label': `${p.label}: open before and after photos`, onClick: () => openViewer(i) },
    h('div', { class: 'g-media' },
      cover ? h('img', { src: src(cover), alt: `${p.label} project photo`, loading: 'lazy' }) : placeholder('Photo coming soon', 'Placeholder – add in site.config.json'),
      h('div', { class: 'g-badges' }, hasPhotos ? h('span', { class: 'badge gold' }, 'Before & After') : h('span', { class: 'badge' }, 'Placeholder'))),
    h('div', { class: 'g-info' }, h('h3', null, p.label), h('span', null, p.category)));
}

function shot(label, kind, path, projectLabel) {
  return h('figure', { class: 'shot' },
    path ? h('img', { src: src(path), alt: `${label} photo of ${projectLabel}` }) : placeholder(`${label} photo placeholder`, 'Replace in site.config.json'),
    h('span', { class: `badge ${kind}` }, label));
}

function slider(p) {
  const box = h('div', { class: 'compare' });
  const range = h('input', { type: 'range', min: '0', max: '100', value: '50', 'aria-label': `Before and after comparison slider for ${p.label}. Drag or use arrow keys.` });
  range.addEventListener('input', () => box.style.setProperty('--pos', range.value + '%'));
  box.append(
    h('img', { src: src(p.after[0]), alt: `After: ${p.label}` }),
    h('img', { class: 'c-before', src: src(p.before), alt: `Before: ${p.label}` }),
    h('span', { class: 'badge l' }, 'Before'), h('span', { class: 'badge r' }, 'After'),
    h('div', { class: 'c-line' }), range);
  return box;
}

function renderViewer() {
  const p = projects[current];
  $('#viewer-cat').textContent = p.category;
  $('#viewer-title').textContent = p.label;
  $('#viewer-desc').textContent = p.description;
  $('#viewer-count').textContent = `${current + 1} of ${projects.length}`;
  const body = $('#viewer-body');
  body.replaceChildren();
  // Slider only when the project is flagged as the same view (compare: true); otherwise side by side.
  if (p.compare && p.before && p.after[0]) {
    body.className = 'viewer-body';
    body.append(slider(p), ...p.after.slice(1).map((a, n) => shot(`After ${n + 2}`, 'after', a, p.label)));
  } else {
    body.className = 'viewer-body pair';
    const afters = p.after.length ? p.after : [null];
    body.append(shot('Before', 'before', p.before, p.label), ...afters.map((a, n) => shot(afters.length > 1 ? `After ${n + 1}` : 'After', 'after', a, p.label)));
  }
}

export function openViewer(i) {
  current = (i + projects.length) % projects.length;
  renderViewer();
  const dlg = $('#viewer');
  if (!dlg.open) dlg.showModal();
}

export function initGallery() {
  const track = $('#gallery-track');
  track.append(...projects.map(card));

  const prev = $('#gal-prev');
  const next = $('#gal-next');
  const step = () => Math.max(track.clientWidth * 0.8, 240);
  const update = () => {
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  prev.addEventListener('click', () => track.scrollBy({ left: -step(), behavior: 'smooth' }));
  next.addEventListener('click', () => track.scrollBy({ left: step(), behavior: 'smooth' }));
  track.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  track.addEventListener('keydown', (e) => {
    if (e.target !== track) return;
    if (e.key === 'ArrowRight') track.scrollBy({ left: step(), behavior: 'smooth' });
    if (e.key === 'ArrowLeft') track.scrollBy({ left: -step(), behavior: 'smooth' });
  });
  update();

  const dlg = $('#viewer');
  $('#viewer-close').addEventListener('click', () => dlg.close());
  $('#viewer-prev').addEventListener('click', () => openViewer(current - 1));
  $('#viewer-next').addEventListener('click', () => openViewer(current + 1));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type="range"]')) return; // arrows belong to the slider
    if (e.key === 'ArrowRight') openViewer(current + 1);
    if (e.key === 'ArrowLeft') openViewer(current - 1);
  });
  $('.viewer-quote', dlg).addEventListener('click', () => dlg.close());
}
