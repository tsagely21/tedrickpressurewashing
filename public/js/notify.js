import { CONFIG } from './util.js';

/**
 * Best-effort email to the business owner through Formspree (config: notifications.ownerEmail.endpoint).
 * The request is already saved in Supabase before this runs, so it never throws and never blocks the customer;
 * the owner dashboard remains the source of truth. Returns true if Formspree accepted the message.
 */
export async function notifyOwner(subject, message, fields = {}) {
  const endpoint = CONFIG.notifications.ownerEmail?.endpoint;
  if (!endpoint) return false;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject, ...fields, message: `${message}\n\nOpen the dashboard: ${location.origin}/admin/` })
    });
    return res.ok;
  } catch {
    return false;
  }
}
