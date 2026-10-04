import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, emailConfigured } from './env.js';

/**
 * Send an email through Resend (https://resend.com) when RESEND_API_KEY, MAIL_FROM and OWNER_EMAIL are set.
 * Otherwise DEMO MODE: the message is appended to data/outbox.log and nothing is emailed.
 * Returns { sent: boolean }.
 */
export async function sendMail({ to, subject, text }) {
  if (!to) return { sent: false };
  if (!emailConfigured()) {
    appendFileSync(join(env.dataDir, 'outbox.log'), `--- ${new Date().toISOString()} (NOT SENT: email not configured)\nTo: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
    return { sent: false };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.mailFrom, to: [to], subject, text })
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    return { sent: true };
  } catch (err) {
    console.error('Email failed:', err.message);
    appendFileSync(join(env.dataDir, 'outbox.log'), `--- ${new Date().toISOString()} (SEND FAILED: ${err.message})\nTo: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
    return { sent: false };
  }
}

export const notifyOwner = (subject, text) => sendMail({ to: env.ownerEmail, subject, text });
