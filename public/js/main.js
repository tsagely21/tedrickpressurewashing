import { CONFIG, $, $$, h, icon } from './util.js';
import { initGallery } from './gallery.js';
import { initQuote, preselect } from './quote.js';
import { initBooking } from './booking.js';

// Mobile menu
const toggle = $('#menu-toggle');
const nav = $('#nav');
toggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});
nav.addEventListener('click', (e) => {
  if (e.target.closest('a')) { nav.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
});

// Service cards
$('#service-grid').append(...CONFIG.serviceCards.map((c) =>
  h('article', { class: 'card s-card' },
    h('div', { class: 's-icon' }, icon(c.icon)),
    h('h3', null, c.title),
    h('p', null, c.description),
    h('button', { class: 'btn btn-gold btn-sm', type: 'button', onClick: () => preselect(c.serviceIds), 'aria-label': `Get a quote for ${c.title}` }, 'Get a Quote'))));

initGallery();
initQuote();
initBooking();
