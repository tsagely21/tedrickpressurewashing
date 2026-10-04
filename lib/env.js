import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (KEY=value per line). Real environment variables win.
const file = join(ROOT, '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

export const env = {
  port: Number(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR ? (isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : join(ROOT, process.env.DATA_DIR)) : join(ROOT, 'data'),
  quoteLimitPerHour: Number(process.env.QUOTE_LIMIT_PER_HOUR) || 10,
  ownerPassword: process.env.OWNER_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  resendKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || '',
  ownerEmail: process.env.OWNER_EMAIL || ''
};
export const emailConfigured = () => Boolean(env.resendKey && env.mailFrom && env.ownerEmail);
