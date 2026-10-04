import { config } from './config.js';

export class InputError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

const str = (v, max, field, { required = false, label = field } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new InputError(`${label} is required.`, field);
  if (s.length > max) throw new InputError(`${label} is too long.`, field);
  return s;
};
const num = (v, field, label, { max = 1_000_000 } = {}) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new InputError(`${label} must be a positive number.`, field);
  return Math.round(n * 100) / 100;
};

export const CONDITIONS = ['light', 'moderate', 'heavy'];
export const PREFERRED = ['phone', 'text', 'email'];

/** Validate and normalise a quote request body. Throws InputError with a customer-readable message. */
export function validateQuote(body) {
  if (body.website) throw new InputError('Could not submit this request.', 'website'); // honeypot

  const propertyType = body.propertyType;
  if (!['residential', 'commercial'].includes(propertyType)) throw new InputError('Choose residential or commercial.', 'propertyType');

  if (!Array.isArray(body.services) || !body.services.length) throw new InputError('Select at least one service.', 'services');
  if (body.services.length > config.services.length) throw new InputError('Too many services selected.', 'services');

  const seen = new Set();
  const items = body.services.map((raw) => {
    const svc = config.services.find((s) => s.id === raw?.id);
    if (!svc || seen.has(svc.id)) throw new InputError('Unknown or duplicate service.', 'services');
    seen.add(svc.id);

    const unsure = raw.unsure === true;
    const item = { id: svc.id, unsure, condition: CONDITIONS.includes(raw.condition) ? raw.condition : 'moderate', fields: {}, notes: str(raw.notes, 1000, 'notes') };

    if (!unsure) {
      if (svc.measure === 'fence') {
        item.linearFt = num(raw.linearFt, svc.id, 'Fence length');
        item.heightFt = num(raw.heightFt, svc.id, 'Fence height', { max: 30 });
        if (!item.linearFt) throw new InputError(`Enter the fence length for ${svc.label}, or choose "I'm not sure".`, svc.id);
      } else {
        item.length = num(raw.length, svc.id, 'Length');
        item.width = num(raw.width, svc.id, 'Width');
        item.areaSqft = num(raw.areaSqft, svc.id, 'Area');
        if (!item.areaSqft && item.length && item.width) item.areaSqft = Math.round(item.length * item.width);
        if (!item.areaSqft) throw new InputError(`Enter the approximate area for ${svc.label}, or choose "I'm not sure".`, svc.id);
      }
    }
    for (const f of svc.fields) {
      const v = str(raw.fields?.[f.key], 200, svc.id);
      if (v && f.type === 'select' && !f.options.includes(v)) throw new InputError(`Invalid choice for ${f.label}.`, svc.id);
      if (v) item.fields[f.key] = v;
    }
    return item;
  });

  const c = body.contact || {};
  const contact = {
    name: str(c.name, 100, 'name', { required: true, label: 'Name' }),
    phone: str(c.phone, 30, 'phone', { required: true, label: 'Phone' }),
    email: str(c.email, 150, 'email'),
    address: str(c.address, 200, 'address', { required: true, label: 'Service address' }),
    zip: str(c.zip, 10, 'zip', { required: true, label: 'ZIP code' }),
    preferred: PREFERRED.includes(c.preferred) ? c.preferred : 'phone'
  };
  if (contact.name.length < 2) throw new InputError('Please enter your name.', 'name');
  if (contact.phone.replace(/\D/g, '').length < 10) throw new InputError('Enter a phone number with area code.', 'phone');
  if (!/^\d{5}(-\d{4})?$/.test(contact.zip)) throw new InputError('Enter a 5-digit ZIP code.', 'zip');
  if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new InputError('Enter a valid email address.', 'email');
  if (contact.preferred === 'email' && !contact.email) throw new InputError('Add an email address, or choose another contact method.', 'email');

  const photos = Array.isArray(body.photos) ? body.photos : [];
  if (photos.length > 8) throw new InputError('You can upload up to 8 photos.', 'photos');

  return { propertyType, items, notes: str(body.notes, 2000, 'notes'), contact, photos };
}

const MAGIC = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8, 'jpg'],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, 'png'],
  ['image/webp', (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', 'webp']
];

/** Decode a data: URL, check it really is a JPEG/PNG/WebP and is under 4 MB. */
export function decodePhoto(p) {
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(p?.data || '');
  if (!m) throw new InputError('One of the photos could not be read. Use JPG, PNG or WebP images.', 'photos');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new InputError('A photo is too large (max 4 MB each).', 'photos');
  const type = MAGIC.find(([, test]) => buf.length > 12 && test(buf));
  if (!type) throw new InputError('One of the photos is not a valid JPG, PNG or WebP image.', 'photos');
  return { buf, mime: type[0], ext: type[2], name: str(p.name, 120, 'photos') };
}
