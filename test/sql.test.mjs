// Tests the database layer (supabase/schema.sql) on a real Postgres engine: access control, validation,
// availability, booking approval and the no-overlap guarantee.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDb, rpc } from './db.mjs';

let db, OWNER, OTHER;
const anon = (fn, args, opts) => rpc(db, 'anon', fn, args, opts);
const owner = (fn, args) => rpc(db, 'authenticated', fn, args, { sub: OWNER });
const other = (fn, args) => rpc(db, 'authenticated', fn, args, { sub: OTHER });

const rejects = (promise, pattern, code) =>
  assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    if (code) assert.equal(err.code, code);
    return true;
  });

const payload = (over = {}) => ({
  propertyType: 'residential',
  items: [{ id: 'driveway-concrete', unsure: false, areaSqft: 400, condition: 'moderate', fields: { material: 'Concrete' }, notes: '' }],
  notes: '', website: '',
  contact: { name: 'Test Customer', phone: '225-555-0100', email: 't@example.com', address: '1 Main St', zip: '70801', preferred: 'phone' },
  ...over
});
const newQuote = (over) => anon('submit_quote', { p_id: randomUUID(), p_data: payload(over) });
const book = (token, date, window) => anon('request_booking', { p_token: token, p_date: date, p_window: window, p_note: '' });

/** The nth bookable day where morning, afternoon and full-day are all free. */
async function openDay(n = 0) {
  const a = await anon('get_availability', {});
  const days = Object.entries(a.days).filter(([, d]) => d.windows.morning && d.windows.afternoon && d.windows['full-day']);
  return days[n][0];
}
const accept = (id, slot) => owner('owner_booking_action', { p_id: id, p_action: 'accept', p_slot: slot ?? null, p_message: null });

before(async () => {
  db = await createDb();
  OWNER = (await db.query(`insert into auth.users (email) values ('owner@test.local') returning id`)).rows[0].id;
  OTHER = (await db.query(`insert into auth.users (email) values ('stranger@test.local') returning id`)).rows[0].id;
  await db.query('insert into public.owners (user_id) values ($1)', [OWNER]);
});

test('anonymous visitors cannot read or write tables directly, or call owner/internal functions', async () => {
  for (const sql of ['select * from public.quotes', 'select * from public.bookings', 'select * from public.owners', 'select * from public.settings', "insert into public.blocks (date) values (current_date)"]) {
    await rejects(db.transaction(async (tx) => { await tx.exec('set local role anon'); await tx.exec(sql); }), /permission denied/);
  }
  await rejects(anon('owner_overview'), /permission denied/);
  await rejects(anon('slot_conflict', { p_date: '2030-01-01', p_start: 0, p_end: 10 }), /permission denied/);
  await rejects(anon('confirm_internal', { p_id: randomUUID(), p_date: '2030-01-01', p_start: 0, p_end: 10, p_full: false, p_msg: null }), /permission denied/);
});

test('logged-in users who are not the owner are refused too', async () => {
  await rejects(other('owner_overview'), /Not authorized/, '42501');
  assert.equal(await other('is_owner'), false);
  assert.equal(await owner('is_owner'), true);
});

test('quote validation: helpful messages, no bad data stored', async () => {
  const bad = (over, pattern, code = 'P0001') => rejects(newQuote(over), pattern, code);
  await bad({ items: [] }, /at least one service/i);
  await bad({ items: [{ id: 'driveway-concrete', unsure: false, condition: 'light' }] }, /approximate size/i);
  await bad({ items: [{ id: 'Bad Id!', unsure: true }] }, /unknown service/i);
  await bad({ items: [{ id: 'fence', unsure: true }, { id: 'fence', unsure: true }] }, /duplicate/i);
  await bad({ contact: { ...payload().contact, zip: '12' } }, /ZIP/);
  await bad({ contact: { ...payload().contact, phone: '123' } }, /phone/i);
  await bad({ contact: { ...payload().contact, name: '' } }, /name/i);
  await bad({ contact: { ...payload().contact, email: 'nope' } }, /email/i);
  await bad({ contact: { ...payload().contact, email: '', preferred: 'email' } }, /email/i);
  await bad({ propertyType: 'castle' }, /residential or commercial/i);
  await bad({ website: 'spam' }, /could not submit/i);
  await bad({ items: 'junk' }, /at least one service/i);
  assert.equal((await db.query('select count(*)::int n from public.quotes')).rows[0].n, 0);
});

test('quote saves normalised data; "not sure" and fence measurements accepted; length x width computes area', async () => {
  const q = await newQuote({ items: [
    { id: 'house-soft-wash', unsure: true, condition: 'heavy', areaSqft: 999 },
    { id: 'fence', unsure: false, linearFt: 120, heightFt: 6, condition: 'light' },
    { id: 'sidewalk-patio', unsure: false, length: 10, width: 12, fields: { material: 'Pavers', evil: 'x'.repeat(500) } }
  ] });
  assert.match(q.ref, /^TMPW-[0-9A-F]{8}$/);
  assert.equal(q.token.length, 64);
  const stored = (await db.query('select data from public.quotes where ref = $1', [q.ref])).rows[0].data;
  assert.equal(stored.items[0].areaSqft, null, 'unsure items drop numbers');
  assert.equal(stored.items[1].linearFt, 120);
  assert.equal(stored.items[2].areaSqft, 120);
  assert.equal(stored.items[2].fields.evil.length, 200, 'field values are truncated');
});

test('customers can look up only their own request by its private token', async () => {
  const q = await newQuote();
  const r = await anon('get_request', { p_token: q.token });
  assert.equal(r.ref, q.ref);
  assert.equal(r.booking, null);
  await rejects(anon('get_request', { p_token: 'wrong' }), /could not find/i, 'PT404');
});

test('availability: tomorrow onward, Sundays closed, only booleans (no customer data)', async () => {
  const a = await anon('get_availability', {});
  assert.equal(a.timezone, 'America/Chicago');
  assert.ok(a.min > a.today);
  assert.ok(Object.keys(a.days).every((d) => d >= a.min && d <= a.max));
  const sunday = Object.entries(a.days).find(([d]) => new Date(d + 'T00:00:00Z').getUTCDay() === 0);
  assert.equal(sunday[1].open, false);
  assert.doesNotMatch(JSON.stringify(a), /Customer|225-555/);
});

test('booking request: past dates refused, saved as pending, one active request per quote', async () => {
  const q = await newQuote();
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await rejects(book(q.token, yesterday, 'morning'), /no longer available/i);
  await rejects(book(q.token, await openDay(0), 'midnight'), /choose a date/i);
  const day = await openDay(0);
  const b = (await book(q.token, day, 'morning')).booking;
  assert.equal(b.status, 'pending');
  assert.equal(b.slot, null, 'no time is held until the owner accepts');
  await rejects(book(q.token, day, 'afternoon'), /already have a booking/i);
  assert.equal((await anon('get_request', { p_token: q.token })).booking.status, 'pending');
});

test('only the owner can accept; confirmed appointments never overlap', async () => {
  const day = await openDay(1);
  const made = [];
  for (let i = 0; i < 3; i++) {
    const q = await newQuote();
    made.push({ q, b: (await book(q.token, day, 'morning')).booking });
  }
  await rejects(other('owner_booking_action', { p_id: made[0].b.id, p_action: 'accept', p_slot: null, p_message: null }), /Not authorized/);

  assert.equal((await accept(made[0].b.id)).booking.status, 'confirmed');
  await rejects(accept(made[1].b.id), /overlaps/i);
  await rejects(accept(made[2].b.id, { date: day, start: '11:00', end: '13:00' }), /overlaps/i); // partial overlap
  await rejects(accept(made[2].b.id, { date: day, fullDay: true }), /overlaps/i); // full day over a booked morning

  const a = (await anon('get_availability', { p_from: day, p_to: day })).days[day];
  assert.deepEqual(a.windows, { morning: false, afternoon: true, 'full-day': false });
  const late = await newQuote();
  await rejects(book(late.token, day, 'morning'), /no longer available/i);

  assert.equal((await accept(made[1].b.id, { date: day, start: '12:00', end: '17:00' })).booking.status, 'confirmed');
  await rejects(accept(made[1].b.id), /already confirmed/i);
});

test('the database itself refuses overlapping confirmed appointments (backstop for simultaneous approvals)', async () => {
  const day = await openDay(2);
  const mk = async () => { const q = await newQuote(); return (await book(q.token, day, 'morning')).booking.id; };
  const [a, b] = [await mk(), await mk()];
  await db.query(`update public.bookings set status='confirmed', slot_date=$2, slot_start=480, slot_end=720 where id=$1`, [a, day]);
  await assert.rejects(
    db.query(`update public.bookings set status='confirmed', slot_date=$2, slot_start=600, slot_end=900 where id=$1`, [b, day]),
    (err) => err.code === '23P01');
  // non-overlapping is fine
  await db.query(`update public.bookings set status='confirmed', slot_date=$2, slot_start=720, slot_end=900 where id=$1`, [b, day]);
});

test('full-day appointment blocks the whole day until cancelled', async () => {
  const day = await openDay(3);
  const q = await newQuote();
  const b = (await book(q.token, day, 'full-day')).booking;
  const done = (await accept(b.id)).booking;
  assert.equal(done.slot.fullDay, true);
  const a = (await anon('get_availability', { p_from: day, p_to: day })).days[day];
  assert.equal(a.open, false);
  assert.equal(Object.values(a.windows).some(Boolean), false);
  await owner('owner_booking_action', { p_id: b.id, p_action: 'cancel', p_slot: null, p_message: 'Sorry' });
  assert.equal((await anon('get_availability', { p_from: day, p_to: day })).days[day].open, true);
});

test('propose another time: customer confirms only by accepting; a proposal alone blocks nothing', async () => {
  const day = await openDay(4);
  const q = await newQuote();
  const b = (await book(q.token, day, 'morning')).booking;
  const p = (await owner('owner_booking_action', { p_id: b.id, p_action: 'propose', p_slot: { date: day, start: '13:00', end: '15:00' }, p_message: 'Afternoon is better' })).booking;
  assert.equal(p.status, 'proposed');
  assert.equal((await anon('get_availability', { p_from: day, p_to: day })).days[day].windows.afternoon, true);
  const done = (await anon('respond_proposal', { p_token: q.token, p_action: 'accept' })).booking;
  assert.equal(done.status, 'confirmed');
  assert.equal(done.slot.start, 780);
  assert.equal((await anon('get_availability', { p_from: day, p_to: day })).days[day].windows.afternoon, false);
});

test('a proposal that becomes unavailable cannot be accepted', async () => {
  const day = await openDay(5);
  const q = await newQuote();
  const b = (await book(q.token, day, 'morning')).booking;
  await owner('owner_booking_action', { p_id: b.id, p_action: 'propose', p_slot: { date: day, start: '09:00', end: '10:00' }, p_message: null });
  const other1 = await newQuote();
  const ob = (await book(other1.token, day, 'morning')).booking;
  await accept(ob.id); // owner confirms someone else for the morning meanwhile
  await rejects(anon('respond_proposal', { p_token: q.token, p_action: 'accept' }), /overlaps/i);
});

test('decline, customer cancel, and owner validation', async () => {
  const day = await openDay(6);
  const q = await newQuote();
  const b = (await book(q.token, day, 'morning')).booking;
  await rejects(owner('owner_booking_action', { p_id: b.id, p_action: 'accept', p_slot: { date: '2020-01-01', start: '09:00', end: '10:00' }, p_message: null }), /in the past/i);
  await rejects(owner('owner_booking_action', { p_id: b.id, p_action: 'accept', p_slot: { date: day, start: '10:00', end: '09:00' }, p_message: null }), /after the start/i);
  await rejects(owner('owner_booking_action', { p_id: b.id, p_action: 'accept', p_slot: { date: 'garbage', start: '10:00', end: '11:00' }, p_message: null }), /valid date/i);
  assert.equal((await owner('owner_booking_action', { p_id: b.id, p_action: 'decline', p_slot: null, p_message: 'Booked solid' })).booking.status, 'declined');
  // after a decline the customer can ask again, then cancel
  const again = (await book(q.token, day, 'afternoon')).booking;
  assert.equal(again.status, 'pending');
  assert.equal((await anon('cancel_booking', { p_token: q.token })).booking.status, 'cancelled');
});

test('blocked dates stop bookings and cannot be placed over a confirmed appointment', async () => {
  const day = await openDay(7);
  await owner('owner_add_block', { p_date: day, p_all_day: true, p_start: null, p_end: null, p_reason: 'Day off' });
  const q = await newQuote();
  await rejects(book(q.token, day, 'morning'), /no longer available/i);
  assert.equal((await anon('get_availability', { p_from: day, p_to: day })).days[day].open, false);
  const { blocks } = await owner('owner_overview');
  await owner('owner_remove_block', { p_id: blocks[0].id });
  assert.equal((await book(q.token, day, 'morning')).booking.status, 'pending');
  await accept((await anon('get_request', { p_token: q.token })).booking.id);
  await rejects(owner('owner_add_block', { p_date: day, p_all_day: false, p_start: '09:00', p_end: '10:00', p_reason: '' }), /confirmed appointment/i);
});

test('quote status: confirming an appointment marks the quote Confirmed; cancelling returns it to Contacted; owner can set any status', async () => {
  const day = await openDay(8);
  const q = await newQuote();
  const statusOf = async () => (await owner('owner_overview')).quotes.find((x) => x.id === q.id).status;
  assert.equal(await statusOf(), 'new');
  await owner('owner_set_quote_status', { p_id: q.id, p_status: 'contacted' });
  assert.equal(await statusOf(), 'contacted');
  const b = (await book(q.token, day, 'morning')).booking;
  await accept(b.id);
  assert.equal(await statusOf(), 'confirmed');
  await owner('owner_booking_action', { p_id: b.id, p_action: 'cancel', p_slot: null, p_message: null });
  assert.equal(await statusOf(), 'contacted');
  await owner('owner_set_quote_status', { p_id: q.id, p_status: 'confirmed' });
  assert.equal(await statusOf(), 'confirmed');
  await rejects(owner('owner_set_quote_status', { p_id: q.id, p_status: 'bogus' }), /invalid status/i);
});

test('owner can schedule and reschedule a confirmed request; the time is blocked on the customer calendar', async () => {
  const [day1, day2] = [await openDay(9), await openDay(10)];
  const slot = (date, extra = {}) => ({ date, start: '09:00', end: '11:00', ...extra });
  const q = await newQuote();
  const schedule = (id, s, msg = null) => owner('owner_schedule_appointment', { p_quote_id: id, p_slot: s, p_message: msg });
  const windows = async (day) => (await anon('get_availability', { p_from: day, p_to: day })).days[day].windows;

  // A request with no booking at all (e.g. marked Confirmed after a phone call)
  await owner('owner_set_quote_status', { p_id: q.id, p_status: 'confirmed' });
  const first = (await schedule(q.id, slot(day1), 'See you then')).booking;
  assert.equal(first.status, 'confirmed');
  assert.equal(first.slot.start, 540);
  assert.equal(first.requested.windowId, 'custom');
  assert.deepEqual(await windows(day1), { morning: false, afternoon: true, 'full-day': false });
  const seen = (await anon('get_request', { p_token: q.token })).booking;
  assert.equal(seen.status, 'confirmed', 'customer status link shows the confirmed time');
  assert.equal(seen.ownerMessage, 'See you then');

  // Reschedule: old time opens up, new time is blocked; the same booking row is reused
  const moved = (await schedule(q.id, slot(day2, { start: '13:00', end: '15:00' }))).booking;
  assert.equal(moved.id, first.id);
  assert.deepEqual(await windows(day1), { morning: true, afternoon: true, 'full-day': true });
  assert.deepEqual(await windows(day2), { morning: true, afternoon: false, 'full-day': false });
  assert.equal((await owner('owner_overview')).appointments.filter((a) => a.ref === q.ref).length, 1);

  // Full day, conflicts, validation, and permissions
  const second = await newQuote();
  await rejects(schedule(second.id, slot(day2, { start: '14:00', end: '16:00' })), /overlaps/i);
  await rejects(schedule(second.id, slot(day2, { fullDay: true })), /overlaps/i);
  await rejects(schedule(q.id, slot('2020-01-01')), /in the past/i);
  await rejects(schedule(q.id, slot(day1, { start: '11:00', end: '10:00' })), /after the start/i);
  await rejects(schedule(q.id, { date: 'nope' }), /valid date/i);
  await rejects(schedule(randomUUID(), slot(day1)), /not found/i, 'PT404');
  await rejects(other('owner_schedule_appointment', { p_quote_id: q.id, p_slot: slot(day1), p_message: null }), /Not authorized/);
  await rejects(anon('owner_schedule_appointment', { p_quote_id: q.id, p_slot: slot(day1), p_message: null }), /permission denied/);
  const full = (await schedule(second.id, slot(await openDay(11), { fullDay: true }))).booking;
  assert.equal(full.slot.fullDay, true);
  assert.equal(Object.values(await windows(full.slot.date)).some(Boolean), false);

  // A pending customer request can be scheduled too (it is confirmed at the chosen time)
  const pending = await newQuote();
  const pb = (await book(pending.token, await openDay(12), 'morning')).booking;
  const done = (await schedule(pending.id, slot(await openDay(13)))).booking;
  assert.equal(done.id, pb.id);
  assert.equal(done.status, 'confirmed');
  const status = (await owner('owner_overview')).quotes.find((x) => x.id === pending.id).status;
  assert.equal(status, 'confirmed');
});

test('owner overview contains requests, photos and appointments; deleting a quote removes its bookings', async () => {
  const o = await owner('owner_overview');
  assert.ok(o.quotes.length > 5 && o.appointments.length > 0);
  assert.equal(o.quotes[0].contact.name, 'Test Customer');
  const q = await newQuote();
  await owner('owner_delete_quote', { p_id: q.id });
  assert.equal((await db.query('select count(*)::int n from public.quotes where id = $1', [q.id])).rows[0].n, 0);
});

test('photos: only into a fresh quote folder; recorded only if the file exists; owner-only to read', async () => {
  const q = await newQuote();
  assert.equal(await anon('can_upload_photo', { p_name: `${q.id}/1.jpg` }), true);
  assert.equal(await anon('can_upload_photo', { p_name: `${randomUUID()}/1.jpg` }), false, 'unknown quote');
  assert.equal(await anon('can_upload_photo', { p_name: `${q.id}/9.jpg` }), false, 'only 8 per quote');
  assert.equal(await anon('can_upload_photo', { p_name: `${q.id}/../x.jpg` }), false);
  await db.query(`insert into storage.objects (bucket_id, name) values ('quote-photos', $1)`, [`${q.id}/1.jpg`]);
  await anon('attach_photos', { p_token: q.token, p_files: [{ path: `${q.id}/1.jpg`, name: 'yard.jpg' }, { path: `${q.id}/2.jpg`, name: 'missing.jpg' }] });
  await rejects(anon('attach_photos', { p_token: q.token, p_files: [{ path: `${randomUUID()}/1.jpg`, name: 'x' }] }), /invalid photo/i);
  const mine = (await owner('owner_overview')).quotes.find((x) => x.id === q.id);
  assert.deepEqual(mine.photos.map((p) => p.path), [`${q.id}/1.jpg`]);
  // storage row-level security: anonymous visitors cannot read objects
  await db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    assert.equal((await tx.query('select count(*)::int n from storage.objects')).rows[0].n, 0);
  });
});

test('settings sync validates input and changes availability', async () => {
  await rejects(owner('owner_sync_settings', { p_scheduling: { timezone: 'America/Chicago' } }), /invalid scheduling/i);
  await rejects(anon('owner_sync_settings', { p_scheduling: {} }), /permission denied/);
  const s = (await owner('owner_overview')).scheduling;
  const closedSaturdays = { ...s, businessHours: { ...s.businessHours, 6: null } };
  await owner('owner_sync_settings', { p_scheduling: closedSaturdays });
  const a = await anon('get_availability', {});
  const sat = Object.entries(a.days).find(([d]) => new Date(d + 'T00:00:00Z').getUTCDay() === 6);
  assert.equal(sat[1].open, false);
  await owner('owner_sync_settings', { p_scheduling: s });
});
