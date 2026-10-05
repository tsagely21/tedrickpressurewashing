// Builds the static site into dist/ (or --out <dir>): copies public/, fills the {{placeholders}} in the HTML from
// config/site.config.json, and writes a _headers file (security headers; Netlify and Cloudflare Pages read it).
// Env overrides, used by tests: SUPABASE_URL, SUPABASE_KEY, FORMSPREE_URL.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function build(out = join(ROOT, 'dist')) {
  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.config.json'), 'utf8'));
  delete config._readme;
  if (process.env.SUPABASE_URL) config.supabase.url = process.env.SUPABASE_URL;
  if (process.env.SUPABASE_KEY) config.supabase.publishableKey = process.env.SUPABASE_KEY;
  if (process.env.FORMSPREE_URL) config.notifications.ownerEmail = { provider: 'formspree', endpoint: process.env.FORMSPREE_URL };
  const mailOrigin = config.notifications.ownerEmail?.endpoint ? ' ' + new URL(config.notifications.ownerEmail.endpoint).origin : '';
  const biz = config.business;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const vars = {
    name: esc(biz.name), shortName: esc(biz.shortName), owner: esc(biz.owner), phone: esc(biz.phone),
    phoneTel: '+1' + biz.phone.replace(/\D/g, ''), tagline: esc(biz.tagline), payments: esc(biz.payments.join(', ')),
    ministerDiscount: esc(biz.ministerDiscount), year: new Date().getFullYear(),
    configJson: JSON.stringify(config).replace(/</g, '\\u003c')
  };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(ROOT, 'public'), out, { recursive: true });

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (name.endsWith('.html')) {
        const html = readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
        writeFileSync(file, html);
      }
    }
  };
  walk(out);

  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", 'img-src \'self\' data: blob: https://*.supabase.co',
    `connect-src 'self' ${new URL(config.supabase.url).origin}${mailOrigin}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"
  ].join('; ');
  writeFileSync(join(out, '_headers'), `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  X-Frame-Options: DENY\n/admin/*\n  X-Robots-Tag: noindex\n`);
  return out;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = build(i > 0 ? resolve(process.argv[i + 1]) : undefined);
  console.log('Built static site in', out);
}
