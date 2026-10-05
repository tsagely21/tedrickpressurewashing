// Browser test: drives real Chrome through the customer + owner flows via the DevTools protocol.
// Run with: node test/browser.mjs   (needs Chrome or Edge installed). Screenshots go to test/screenshots/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 3112, CDP = 9333, BASE = `http://localhost:${PORT}`;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
assert.ok(CHROME, 'Chrome or Edge not found');
const tmp = mkdtempSync(join(tmpdir(), 'tm-browser-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(tmp, 'yard.png'), PNG);

// The site is built and served by a local stand-in for Supabase that runs the real supabase/schema.sql.
const server = spawn(process.execPath, ['test/fake-supabase.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT, OUT: join(tmp, 'site') } });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${join(tmp, 'profile')}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error('Timed out waiting for: ' + label);
    await sleep(100);
  }
}

let ws, id = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const until = (expr, label, ms) => waitFor(() => ev(expr), label, ms);
const shot = async (name) => writeFileSync(join(SHOTS, name + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const goto = async (url) => { await send('Page.navigate', { url }); await sleep(300); await until('document.readyState === "complete"', 'load ' + url); };
const key = (k, code) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: { Escape: 27, ArrowRight: 39, ArrowLeft: 37 }[k] }).then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k }));

// Helpers executed inside the page
const PAGE = `
window.T = {
  click: (sel) => { const e = document.querySelector(sel); if (!e) throw new Error('no element ' + sel); e.click(); },
  clickText: (txt, scope = document) => { const e = [...scope.querySelectorAll('button,a')].find((b) => b.textContent.trim().includes(txt)); if (!e) throw new Error('no button ' + txt); e.click(); },
  type: (sel, v) => { const e = document.querySelector(sel); if (!e) throw new Error('no input ' + sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); },
  text: (sel) => document.querySelector(sel)?.innerText || ''
};`;

async function customerFlow(label, metrics) {
  console.log(`\n== ${label} ==`);
  await send('Emulation.setDeviceMetricsOverride', metrics);
  await goto(BASE + '/');
  await ev(PAGE);
  assert.ok((await ev('document.title')).includes('Tedrick'));
  await shot(`${label}-1-hero`);

  // Gallery: cards, arrows, viewer
  assert.equal(await ev('document.querySelectorAll(".g-card").length'), 6);
  const before = await ev('document.querySelector("#gallery-track").scrollLeft');
  await ev('T.click("#gal-next")');
  await until(`document.querySelector("#gallery-track").scrollLeft > ${before}`, 'gallery arrow scroll');
  await ev('document.querySelector("#gallery-track").scrollTo(0,0)');
  await ev('T.click(".g-card")');
  await until('document.querySelector("#viewer").open', 'viewer opens');
  assert.equal(await ev('document.querySelectorAll("#viewer-body img").length'), 3, 'before + two after photos');
  await sleep(300);
  await shot(`${label}-2-viewer`);
  await key('ArrowRight');
  await until('document.querySelector("#viewer-title").textContent === "Driveway Cleaning"', 'next project via keyboard');
  assert.ok((await ev('document.querySelector("#viewer-body").innerText')).includes('photo placeholder') || (await ev('document.querySelectorAll("#viewer-body .placeholder").length')) === 2, 'placeholders labeled');
  await key('Escape');
  await until('!document.querySelector("#viewer").open', 'Escape closes viewer');

  // The draggable slider is used only for projects flagged compare:true (same-view photos). Flip one in-page to test it.
  await ev('import("/js/util.js").then((m) => { m.CONFIG.gallery[0].compare = true; })');
  await ev('T.click(".g-card")');
  await until('document.querySelector("#viewer .compare input[type=range]")', 'slider renders for compare:true');
  await ev('T.type("#viewer .compare input[type=range]", "80")');
  assert.equal(await ev('document.querySelector("#viewer .compare").style.getPropertyValue("--pos")'), '80%', 'slider moves');
  await sleep(300);
  await shot(`${label}-2b-slider`);
  await ev('document.querySelector("#viewer").close()');
  await ev('import("/js/util.js").then((m) => { m.CONFIG.gallery[0].compare = false; })');

  // Service card pre-selects services in the quote builder
  await ev('T.clickText("Get a Quote", document.querySelectorAll(".s-card")[4])');
  await until('[...document.querySelectorAll("input[name=service]:checked")].length === 2', 'deck+fence preselected');
  await ev('T.click("input[name=service][value=fence]")'); // uncheck fence
  await ev('T.click("input[name=service][value=driveway-concrete]")');
  await ev('T.clickText("Continue")');
  await until('document.querySelector("#step-title")?.textContent.includes("Measurements")', 'step 2');

  // Validation: empty measurement blocks Continue
  await ev('T.clickText("Continue")');
  await until('document.querySelectorAll(".error-text").length > 0', 'measurement validation');
  // Driveway via length x width; deck "not sure"
  await ev('document.querySelector("#len-driveway-concrete").closest("details").open = true');
  await ev('T.type("#len-driveway-concrete", "20")');
  await ev('T.type("#wid-driveway-concrete", "25")');
  assert.equal(await ev('document.querySelector("#area-driveway-concrete").value'), '500', 'area computed from L x W');
  await ev('T.click("#unsure-deck")');
  await until('document.querySelector("#area-deck")?.disabled === true', 'deck unsure disables area');
  await ev('T.click("input[name=cond-driveway-concrete][value=heavy]")');
  await ev('document.querySelector("#f-driveway-concrete-material").value="Concrete"; document.querySelector("#f-driveway-concrete-material").dispatchEvent(new Event("change"))');
  await shot(`${label}-3-measurements`);
  await ev('document.querySelector("#quote-summary").open = true'); // collapsible on mobile
  assert.match(await ev('document.querySelector("#summary-body").innerText'), /500 sq ft/);
  assert.match(await ev('document.querySelector("#summary-body").innerText'), /Submit for a free personalized quote/);
  await ev('T.clickText("Continue")');
  await until('document.querySelector("#photo-input")', 'step 3');

  // Contact validation, photo upload + removal
  await ev('T.clickText("Continue")');
  await until('document.querySelector("#err-name")', 'contact validation');
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#photo-input' });
  await send('DOM.setFileInputFiles', { nodeId, files: [join(tmp, 'yard.png'), join(tmp, 'yard.png')] });
  await until('document.querySelectorAll(".thumb").length === 2', 'photo previews');
  await ev('T.click(".thumb button")');
  await until('document.querySelectorAll(".thumb").length === 1', 'photo removal');
  await ev('T.type("#c-name", "Pat Tester"); T.type("#c-phone", "225-555-0142"); T.type("#c-email", "pat@example.com"); T.type("#c-address", "12 Oak St, Baton Rouge"); T.type("#c-zip", "70801")');
  await ev('T.type("#q-notes", "Gate code 1234")');
  await shot(`${label}-4-contact`);
  await ev('T.clickText("Continue")');
  await until('document.querySelector("#step-title")?.textContent.includes("Review")', 'review step');
  const review = await ev('document.querySelector("#quote-panel").innerText');
  for (const s of ['Pat Tester', '500 sq ft', "Not sure", 'Gate code 1234', '1 attached', 'Submit for a free personalized quote']) assert.ok(review.includes(s), 'review shows ' + s);
  // Edit button goes back and keeps state
  await ev('T.click("button[aria-label=\\"Edit Contact\\"]")');
  await until('document.querySelector("#c-name")?.value === "Pat Tester"', 'edit preserves data');
  await ev('T.clickText("Continue")');
  await until('document.querySelector("#submit-quote")', 'back to review');
  await shot(`${label}-5-review`);
  await ev('T.click("#submit-quote")');
  await until('document.querySelector(".success .ref")', 'submit success', 15000);
  const ref = await ev('document.querySelector(".success .ref").textContent');
  console.log('  quote submitted', ref);
  await shot(`${label}-6-success`);

  // Booking: calendar, window, pending status
  await ev('T.click("a[href=\\"#booking\\"].btn-gold")');
  await until('document.querySelector(".cal-day:not([disabled])")', 'calendar loaded');
  assert.ok((await ev('document.querySelectorAll(".cal-day[disabled]").length')) > 0, 'some days unavailable');
  await ev('T.click(".cal-day:not([disabled])")');
  await until('document.querySelector("input[name=window]")', 'windows shown');
  await ev('T.click("input[name=window]:not(:disabled)")'); // first window still free (earlier runs may have taken others)
  await shot(`${label}-7-booking`);
  await ev('T.clickText("Request This Time")');
  await until('document.querySelector(".status-pill.pending")', 'pending status', 10000);
  assert.match(await ev('document.querySelector("#booking-panel").innerText'), /Pending owner approval/);
  assert.doesNotMatch(await ev('document.querySelector("#booking-panel").innerText'), /Confirmed/);
  await shot(`${label}-8-pending`);
  return ref;
}

async function ownerFlow(label, ref) {
  console.log(`\n== owner dashboard (${label}) ==`);
  await goto(BASE + '/admin/');
  await ev(PAGE);
  await until('document.querySelector("#pw")', 'login form');
  await ev('T.type("#email", "owner@test.local"); T.type("#pw", "wrong"); document.querySelector("form.login").requestSubmit()');
  await until('document.querySelector(".notice.err")', 'wrong password rejected');
  await until('document.querySelector("#pw")', 'login form re-rendered');
  await ev('T.type("#email", "owner@test.local"); T.type("#pw", "testpass"); document.querySelector("form.login").requestSubmit()');
  await until('document.querySelector(".rq")', 'requests listed');
  const text = await ev('document.querySelector(".req-list").innerText');
  assert.ok(text.includes(ref) && text.includes('Pat Tester') && text.includes('Pending approval'));
  assert.ok((await ev('document.querySelectorAll(".rq img").length')) >= 1, 'uploaded photo visible to owner');
  await shot(`${label}-9-admin`);
  const tabs = () => ev('[...document.querySelectorAll(".tab")].map((t) => t.innerText.trim()).join("|")');
  assert.equal(await tabs(), 'Needs attention1|Contacted|Confirmed|All requests|Blocked dates');

  // Quote status: Contacted moves it into the Contacted category
  await ev('document.querySelector("select[id^=st-]").value = "contacted"; document.querySelector("select[id^=st-]").dispatchEvent(new Event("change"))');
  await until('document.querySelector(".notice.ok")', 'status updated');
  await ev('T.clickText("Contacted")');
  await until('document.querySelector(".rq")', 'contacted category lists the request');
  assert.ok((await ev('document.querySelector(".req-list").innerText')).includes(ref));
  assert.deepEqual(await ev('[...document.querySelectorAll("select[id^=st-] option")].map((o) => o.textContent)'), ['New', 'Contacted', 'Confirmed', 'Closed']);

  // Confirm the appointment (its booking is still pending, so it is also under Needs attention)
  await ev('T.clickText("Needs attention")');
  await ev('T.clickText("Confirm appointment")');
  await until('document.querySelector(".notice.ok")', 'accepted', 10000);
  assert.equal(await tabs(), 'Needs attention|Contacted|Confirmed1|All requests|Blocked dates', 'moved out of attention/contacted into Confirmed');

  // ONE Confirmed category lists it, with the customer's contact details
  await ev('T.clickText("Confirmed")');
  await until('document.querySelector(".appt")', 'confirmed appointment card');
  const appt = await ev('document.querySelector(".appt").innerText');
  for (const s of ['Pat Tester', '225-555-0142', '12 Oak St', 'Cancel appointment']) assert.ok(appt.includes(s), 'appointment card shows ' + s);
  await shot(`${label}-9b-confirmed-tab`);

  // The quote's status now reads Confirmed (and is locked while the appointment stands)
  await ev('T.clickText("View full request")');
  await until('document.querySelector("select[id^=st-]")', 'full request opens');
  assert.equal(await ev('document.querySelector("select[id^=st-]").value'), 'confirmed');
  assert.equal(await ev('document.querySelector("select[id^=st-]").disabled'), true);

  // Customer now sees confirmation
  await goto(BASE + '/');
  await until('document.querySelector(".status-pill.confirmed")', 'customer sees confirmed', 10000);
  await shot(`${label}-10-confirmed`);
}

try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${CDP}/json/version`); await fetch(BASE); break; } catch { await sleep(200); } }
  const target = await (await fetch(`http://localhost:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('DOM.enable');

  const ref = await customerFlow('desktop', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
  await ownerFlow('desktop', ref);

  await customerFlow('mobile', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // No horizontal page scroll on mobile
  await goto(BASE + '/');
  assert.ok(await ev('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal overflow on mobile');
  await shot('mobile-0-top');
  await ev('window.scrollTo(0, document.body.scrollHeight)');
  await shot('mobile-11-bottom');

  // The deliberate wrong-password attempt is the only expected failing request.
  const unexpected = errors.filter((e) => !/status of 400.*\/auth\/v1\/token/s.test(e));
  assert.deepEqual(unexpected, [], 'console errors: ' + unexpected.join(' | '));
  console.log('\nAll browser checks passed. Screenshots in test/screenshots/');
} catch (err) {
  console.error('\nFAILED:', err.message);
  try { await shot('failure'); } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  ws?.close(); chrome.kill(); server.kill();
  await sleep(500);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
