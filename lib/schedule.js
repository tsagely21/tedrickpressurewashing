import { db, transaction } from './db.js';
import { config } from './config.js';
import { addDays, isDate, minutesNowIn, toMin, todayIn, weekday } from '../public/js/shared/dates.js';

const sch = config.scheduling;
const tz = sch.timezone;
const DAY = 1440;

export class ConflictError extends Error {}
export class ValidationError extends Error {}

export const windows = sch.windows.map((w) => ({ ...w, startMin: toMin(w.start), endMin: toMin(w.end) }));
export const windowById = (id) => windows.find((w) => w.id === id);

export function bookableRange(now = new Date()) {
  const today = todayIn(tz, now);
  return { today, min: addDays(today, sch.leadDays), max: addDays(today, sch.horizonDays) };
}

/** First confirmed appointment or block that overlaps [start,end) on `date`, else null. */
export function findConflict(date, start, end, ignoreBookingId = null) {
  const appt = db
    .prepare(
      `SELECT id FROM bookings WHERE status='confirmed' AND slot_date=? AND id IS NOT ?
       AND (full_day=1 OR (slot_start < ? AND slot_end > ?)) LIMIT 1`
    )
    .get(date, ignoreBookingId, end, start);
  if (appt) return { type: 'appointment' };
  const block = db
    .prepare(`SELECT id FROM blocks WHERE date=? AND (start_min IS NULL OR (start_min < ? AND end_min > ?)) LIMIT 1`)
    .get(date, end, start);
  return block ? { type: 'block' } : null;
}

/** Public availability: booleans only, never customer data. */
export function availability(from, to, now = new Date()) {
  const { today, min, max } = bookableRange(now);
  const nowMin = minutesNowIn(tz, now);
  const days = {};
  let d = from < min ? min : from;
  const last = to > max ? max : to;
  for (let n = 0; d <= last && n < 100; n++, d = addDays(d, 1)) {
    const hours = sch.businessHours[weekday(d)];
    const day = { open: false, windows: {} };
    if (hours) {
      const open = toMin(hours.open);
      const close = toMin(hours.close);
      for (const w of windows) {
        const inHours = w.startMin >= open && w.endMin <= close;
        const notPast = d > today || w.startMin > nowMin;
        day.windows[w.id] = inHours && notPast && !findConflict(d, w.fullDay ? 0 : w.startMin, w.fullDay ? DAY : w.endMin);
      }
      day.open = Object.values(day.windows).some(Boolean);
    }
    days[d] = day;
  }
  return { timezone: tz, today, min, max, windows: windows.map(({ id, label, start, end, fullDay }) => ({ id, label, start, end, fullDay: !!fullDay })), days };
}

/** Normalise an owner/customer supplied slot into {date,start,end,fullDay} or throw. */
export function parseSlot({ date, start, end, fullDay }, now = new Date()) {
  if (!isDate(date)) throw new ValidationError('Choose a valid date.');
  if (date < todayIn(tz, now)) throw new ValidationError('That date is in the past.');
  if (fullDay) return { date, start: 0, end: DAY, fullDay: true };
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!re.test(start || '') || !re.test(end || '')) throw new ValidationError('Choose a valid start and end time.');
  const s = toMin(start);
  const e = toMin(end);
  if (e <= s) throw new ValidationError('End time must be after the start time.');
  return { date, start: s, end: e, fullDay: false };
}

/**
 * Confirm a booking atomically. The write lock (BEGIN IMMEDIATE) is held while we check for
 * overlaps and write, so two simultaneous approvals can never both succeed for overlapping times.
 */
export function confirmBooking(bookingId, slot, ownerMessage = null) {
  return transaction(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
    if (!b) throw new ValidationError('Booking not found.');
    if (!['pending', 'proposed'].includes(b.status)) throw new ValidationError(`This request is already ${b.status}.`);
    if (findConflict(slot.date, slot.start, slot.end, bookingId)) {
      throw new ConflictError('That time overlaps a confirmed appointment or a blocked time.');
    }
    db.prepare(
      `UPDATE bookings SET status='confirmed', slot_date=?, slot_start=?, slot_end=?, full_day=?,
       owner_message=COALESCE(?, owner_message), updated_at=? WHERE id=?`
    ).run(slot.date, slot.start, slot.end, slot.fullDay ? 1 : 0, ownerMessage, new Date().toISOString(), bookingId);
    return db.prepare('SELECT * FROM bookings WHERE id=?').get(bookingId);
  });
}
