// Step 6.6 desktop-browser acceptance. Synthetic roster only; every external request is intercepted.
// Uses an already installed Playwright (PLAYWRIGHT_MODULE_PATH), never installs dependencies.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from '../helpers.js';
import { loadGs, fakeEnv } from '../gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../fixtures/condor-feed.synthetic.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const userData = mkdtempSync(join(tmpdir(), 'fc66-browser-'));
const TOKEN = 'synthetic-offline-test-token';
const protectedPreview = process.env.FC_PROTECTED_PREVIEW === '1';
const previewCookie = 'fc_synthetic_preview_session';
const endpoint = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const gs = loadGs(), feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const backend = (action) => JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action, token: 'test-token-0123456789abcdef' }), env)));
const roster = backend('roster'), history = backend('history');
let changedAsset = false;
let brokenUpdate = false, apiMode = 'valid', network = true, rosterCalls = 0, context;
let held = [], onHeld = null;
const pageErrors = [];
const server = createServer((req, res) => {
  if (protectedPreview && !req.headers.cookie?.split('; ').includes(`${previewCookie}=synthetic`)) {
    res.writeHead(401); res.end('Synthetic preview authentication required'); return;
  }
  const path = new URL(req.url, 'http://localhost').pathname;
  const relative = path === '/' ? 'index.html' : path.slice(1);
  if (!['index.html', 'manifest.webmanifest', 'sw.js'].includes(relative) && !relative.startsWith('src/') && !relative.startsWith('assets/')) { res.writeHead(404); res.end(); return; }
  const file = resolve(root, relative);
  if (!file.startsWith(root)) { res.writeHead(404); res.end(); return; }
  try {
    let body = readFileSync(file);
    if (brokenUpdate && relative === 'sw.js') body = Buffer.from(body.toString().replace(/const VERSION = '[^']+'/, "const VERSION = 'interrupted-synthetic-update'"));
    if (brokenUpdate && relative === 'assets/css/base.css') { res.writeHead(503); res.end('Synthetic interrupted update'); return; }
    if (changedAsset && relative === 'assets/css/base.css') body = Buffer.concat([body, Buffer.from('\n/* synthetic next build */')]);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
async function launch() {
  const c = await chromium.launchPersistentContext(userData, { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (protectedPreview) await c.addCookies([{ name: previewCookie, value: 'synthetic', url, httpOnly: true, sameSite: 'Lax' }]);
  await c.addInitScript(({ now }) => { Date.now = () => now; }, { now: NOW });
  c.on('page', (page) => page.on('pageerror', (e) => pageErrors.push(e.message)));
  for (const page of c.pages()) page.on('pageerror', (e) => pageErrors.push(e.message));
  await c.route('https://**/*', async (route) => {
    const request = route.request();
    if (!network || !request.url().startsWith(endpoint)) return route.abort('internetdisconnected');
    const body = request.method() === 'POST' ? request.postDataJSON() : {};
    let data = apiMode === 'open' ? loadFixture() : { success: false, error: 'auth-required' };
    if (body.action === 'roster') {
      rosterCalls++;
      if (apiMode === 'deferred') {
        await new Promise((resolve) => { held.push(resolve); onHeld?.(); });
        try { await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(roster) }); } catch { /* page may have closed */ }
        return;
      }
      data = apiMode === 'valid' ? roster : apiMode === 'empty' ? { ...roster, events: [], sectors: [], duties: [], windows: [], stays: [] }
        : apiMode === 'auth' ? { ok: false, error: 'unauthorized' } : { ...roster, sectors: null };
    } else if (body.action === 'history') data = history;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  });
  return c;
}
async function drag(page, { dx = 0, dy = 100 } = {}) {
  const session = await context.newCDPSession(page);
  const box = await page.locator('.page-title').boundingBox();
  const x = 160, y = Math.min(450, box.y + box.height / 2);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const fraction of [0.06, 0.18, 0.36, 0.6, 1]) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * fraction, y: y + dy * fraction }] });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}
async function ready(page) {
  try { await page.waitForFunction(() => document.querySelector('[data-sync-status]')?.textContent.includes('Available offline'), null, { timeout: 60000 }); }
  catch (error) {
    console.error('Offline readiness diagnostic', await page.evaluate(async () => ({
      status: document.querySelector('[data-sync-status]')?.textContent,
      workers: (await navigator.serviceWorker.getRegistrations()).map((r) => ({ active: r.active?.state, installing: r.installing?.state })),
      caches: await Promise.all((await caches.keys()).map(async (name) => ({ name, entries: (await (await caches.open(name)).keys()).length }))),
      controlled: !!navigator.serviceWorker.controller,
    })));
    throw error;
  }
}
const savedBytes = (page) => page.evaluate(() => localStorage.getItem('fc.v2.roster.v1'));
async function offline(c, value) { network = !value; await c.setOffline(value); }
async function route(page, hash) { await page.evaluate((hash) => { location.hash = hash; }, hash); await page.waitForFunction((hash) => location.hash === hash && document.querySelector('.page-title'), hash); }
try {
  if (protectedPreview) {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(new URL('src/main.js', url))).status, 401);
    console.log('PASS unauthenticated preview document and assets denied');
  }
  context = await launch(); let page = context.pages()[0]; await page.goto(url);
  await page.evaluate(({ endpoint, token }) => { localStorage.setItem('fc.v2.endpoint', endpoint); localStorage.setItem('fc.v2.token.v2', token); }, { endpoint, token: TOKEN });
  await page.reload(); await ready(page);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('fc.v2.roster.v1')).serverHistory?.sectors.length > 0);
  const initial = await savedBytes(page); assert.equal(JSON.parse(initial).payload.sectors.length, roster.sectors.length);
  console.log('PASS initial sync + complete shell readiness');
  const cacheInfo = await page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) { const cache = await caches.open(name); out.push({ name, paths: (await cache.keys()).map((r) => new URL(r.url).pathname) }); }
    return out;
  });
  assert.ok(cacheInfo.every((c) => c.name.startsWith('fc-shell-') && c.paths.every((p) => /^\/(src\/|assets\/|index.html$|manifest.webmanifest$)/.test(p))));
  console.log('PASS cache contains static allowlist only');
  let documents = 0; page.on('request', (r) => { if (r.isNavigationRequest()) documents++; });
  for (const hash of ['#/today', '#/calendar', '#/flights']) {
    await route(page, hash); await page.evaluate(() => window.scrollTo(0, 0));
    const callsBefore = rosterCalls;
    if (hash === '#/flights') await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    await Promise.all([page.waitForResponse((r) => r.url() === endpoint && r.request().postDataJSON()?.action === 'roster'), drag(page)]);
    await page.waitForFunction(() => document.querySelector('[data-roster-manual-refresh]')?.getAttribute('aria-disabled') === 'false');
    assert.equal(rosterCalls, callsBefore + 1);
    await page.evaluate(() => delete navigator.onLine);
  }
  assert.equal(documents, 0, 'pulls must never navigate/reload the page');
  await route(page, '#/today'); await page.evaluate(() => window.scrollTo(0, 0));
  const gestureBefore = rosterCalls;
  await drag(page, { dy: 45 }); await drag(page, { dx: 100, dy: 15 });
  assert.equal(rosterCalls, gestureBefore, 'short and horizontal gestures do not refresh');
  await page.evaluate(() => window.scrollTo(0, 100));
  assert.ok(await page.evaluate(() => window.scrollY > 1));
  await drag(page); assert.equal(rosterCalls, gestureBefore, 'pull below the top stays native');
  await page.waitForTimeout(400); // allow native scroll momentum to settle before a new gesture
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  apiMode = 'deferred'; const startedPull = new Promise((resolve) => { onHeld = resolve; });
  const pullBytes = await savedBytes(page); await drag(page);
  let pullTimeout;
  try { await Promise.race([startedPull, new Promise((_, reject) => { pullTimeout = setTimeout(() => reject(new Error('Synthetic pull request did not start')), 10000); })]); }
  finally { clearTimeout(pullTimeout); }
  assert.equal(await savedBytes(page), pullBytes);
  if (process.env.FC_PULL_SCREENSHOT) await page.screenshot({ path: process.env.FC_PULL_SCREENSHOT });
  assert.equal(await page.locator('[data-roster-manual-refresh]').getAttribute('aria-disabled'), 'true');
  await page.evaluate(() => document.querySelector('[data-roster-manual-refresh]').click());
  await drag(page); assert.equal(rosterCalls, gestureBefore + 1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.refresh-mark').evaluate((el) => getComputedStyle(el).animationName), 'none');
  apiMode = 'valid'; held.splice(0).forEach((release) => release()); onHeld = null;
  await page.waitForFunction(() => document.querySelector('[data-roster-manual-refresh]')?.getAttribute('aria-disabled') === 'false');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const fallback = page.locator('[data-roster-manual-refresh]'); await fallback.focus();
  await Promise.all([page.waitForResponse((r) => r.url() === endpoint && r.request().postDataJSON()?.action === 'roster'), page.keyboard.press('Enter')]);
  await page.waitForFunction(() => document.activeElement?.matches('[data-roster-manual-refresh]'));
  apiMode = 'malformed'; const beforeFailedPull = await savedBytes(page);
  await page.waitForFunction(() => document.querySelector('[data-roster-manual-refresh]')?.getAttribute('aria-disabled') === 'false');
  await Promise.all([page.waitForResponse((r) => r.url() === endpoint && r.request().postDataJSON()?.action === 'roster'), drag(page)]);
  await page.waitForFunction(() => document.querySelector('[data-sync-status]')?.textContent.includes('Refresh failed'));
  assert.equal(await savedBytes(page), beforeFailedPull);
  apiMode = 'valid';
  await Promise.all([page.waitForResponse((r) => r.url() === endpoint && r.request().postDataJSON()?.action === 'roster'), drag(page)]);
  await page.waitForFunction(() => document.querySelector('[data-roster-manual-refresh]')?.getAttribute('aria-disabled') === 'false');
  console.log('PASS touch pulls on Today/Calendar/Flights, threshold/direction, no reload, visible cached data, deduplication, reduced motion and keyboard fallback');
  await offline(context, true); await page.reload(); await ready(page);
  assert.equal(await savedBytes(page), initial);
  for (const hash of ['#/today', '#/calendar', '#/flights', `#/flights/${roster.sectors[0].id}`]) {
    await route(page, hash); assert.match(await page.locator('[data-sync-status]').innerText(), /Offline · Saved roster/);
  }
  await page.waitForSelector('[data-fl-detail]');
  await route(page, '#/settings'); await page.locator('[data-time-display-value="utc"]').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('fc.v2.timeDisplay')), 'utc');
  await route(page, '#/flights');
  assert.equal(await page.locator('[data-sync-status]').isVisible(), true);
  if (process.env.FC_SCREENSHOT) await page.screenshot({ path: process.env.FC_SCREENSHOT, fullPage: true });
  console.log('PASS offline reload + Today/Calendar/Flights/detail + UTC + mobile status');
  await context.close(); context = await launch(); await offline(context, true); page = context.pages()[0];
  await page.goto(url); await ready(page); assert.equal(await savedBytes(page), initial);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.timeDisplay), 'utc');
  console.log('PASS browser process restart offline with persisted roster and UTC');
  const before = rosterCalls; await offline(context, false);
  await page.waitForFunction(() => document.querySelector('[data-sync-status]')?.textContent.startsWith('Roster synchronized'));
  assert.equal(rosterCalls, before + 1); console.log('PASS reconnect triggers one roster refresh');
  for (const mode of ['empty', 'malformed', 'auth']) {
    apiMode = mode; const previous = await savedBytes(page); await page.reload();
    await page.waitForFunction(() => /Refresh failed|Authentication needed/.test(document.querySelector('[data-sync-status]')?.textContent));
    assert.equal(await savedBytes(page), previous);
  }
  console.log('PASS empty/malformed/auth rejection retain saved bytes');
  apiMode = 'valid';
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'fc.v2.roster.v1' && this.getItem('fc.test.denyWrites')) throw new DOMException('Synthetic quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const beforeQuota = await savedBytes(page);
  await page.evaluate(() => localStorage.setItem('fc.test.denyWrites', 'true'));
  await page.reload(); await page.waitForFunction(() => document.querySelector('[data-sync-status]')?.textContent.includes('Could not save update'));
  assert.equal(await savedBytes(page), beforeQuota);
  await page.evaluate(() => localStorage.removeItem('fc.test.denyWrites'));
  await page.reload(); await ready(page);
  console.log('PASS browser quota failure preserves saved roster and reports failure');
  // Evict a static asset while the server has different bytes. The response may
  // recover online, but the active offline cache must remain incomplete.
  const assetUrl = new URL('assets/css/base.css', url).href;
  await page.evaluate(async (assetUrl) => {
    for (const name of await caches.keys()) await (await caches.open(name)).delete(assetUrl);
  }, assetUrl);
  changedAsset = true;
  assert.match(await page.evaluate(async (assetUrl) => (await fetch(assetUrl)).text(), assetUrl), /synthetic next build/);
  assert.equal(await page.evaluate(async (assetUrl) => !!await caches.match(assetUrl), assetUrl), false);
  await page.waitForFunction(() => document.querySelector('[data-sync-status]')?.textContent.includes('Offline setup incomplete'));
  changedAsset = false; await page.evaluate(async (assetUrl) => (await fetch(assetUrl)).text(), assetUrl); await ready(page);
  console.log('PASS evicted asset recovers online; changed bytes never cached; readiness recovers only with matching bytes');
  // False navigator.onLine is a hint, not a veto on a deliberate Refresh roster.
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await route(page, '#/settings'); const manualBefore = rosterCalls;
  await Promise.all([page.waitForResponse((r) => r.url() === endpoint && r.request().postDataJSON()?.action === 'roster'), page.locator('[data-roster-refresh]').click()]);
  assert.equal(rosterCalls, manualBefore + 1);
  await page.evaluate(() => delete navigator.onLine);
  console.log('PASS explicit UI refresh requests roster despite false online hint');
  const originalController = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
  brokenUpdate = true;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    window.__updateResult = 'pending';
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') window.__updateResult = 'rejected'; });
    }, { once: true });
    await registration.update();
  });
  await page.waitForFunction(() => window.__updateResult === 'rejected');
  await offline(context, true); await page.reload(); await ready(page);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), originalController);
  assert.ok((await page.evaluate(() => caches.keys())).every((k) => !k.includes('interrupted')));
  console.log('PASS interrupted application update preserves offline launch');
  brokenUpdate = false;
  const second = await context.newPage(); await second.goto(url); await ready(second);
  apiMode = 'deferred';
  const requestStarted = new Promise((resolve) => { onHeld = resolve; });
  await offline(context, false);
  await requestStarted;
  await route(page, '#/settings'); await page.locator('[data-token-remove]').click();
  const lateResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().postDataJSON()?.action === 'roster');
  apiMode = 'valid'; held.splice(0).forEach((release) => release()); onHeld = null;
  await (await lateResponse).finished();
  await second.waitForFunction(() => !localStorage.getItem('fc.v2.roster.v1') && !document.querySelector('[data-sync-status]')?.textContent.includes('Saved roster'));
  assert.equal(await savedBytes(page), null);
  await offline(context, true); await page.reload(); assert.equal(await savedBytes(page), null); console.log('PASS sign-out purges both tabs and survives offline reload');
  // Reconnect deliberately, then exercise explicit reset separately.
  await offline(context, false);
  await page.evaluate(({ endpoint, token }) => { localStorage.setItem('fc.v2.endpoint', endpoint); localStorage.setItem('fc.v2.token.v2', token); localStorage.removeItem('fc.v2.signedOut'); }, { endpoint, token: TOKEN });
  await page.reload(); await ready(page); await route(page, '#/settings');
  // Deliver both confirmation clicks within the UI's four-second window.
  await page.locator('#reset-local').dblclick({ delay: 100 });
  assert.equal(await savedBytes(page), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('fc.v2.token.v2')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('fc.v2.endpoint')), null);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.timeDisplay), 'local');
  console.log('PASS explicit reset clears credentials, roster and in-memory preference');
  // An open legacy source becomes protected: revoke in both tabs and across restart.
  apiMode = 'open';
  await page.evaluate((endpoint) => { localStorage.setItem('fc.v2.endpoint', endpoint); localStorage.removeItem('fc.v2.signedOut'); }, endpoint);
  await page.reload(); await ready(page); await second.reload(); await ready(second);
  assert.equal(JSON.parse(await savedBytes(page)).contract, 'v5');
  apiMode = 'auth'; await route(page, '#/settings'); await page.locator('[data-roster-refresh]').click();
  await page.waitForFunction(() => localStorage.getItem('fc.v2.signedOut') === 'true' && !localStorage.getItem('fc.v2.roster.v1'));
  await second.waitForFunction(() => !document.querySelector('[data-sync-status]')?.textContent.includes('Saved roster'));
  await offline(context, true); await page.reload(); assert.equal(await savedBytes(page), null);
  await route(page, '#/flights'); assert.doesNotMatch(await page.locator('main').innerText(), /DE\d{3,4}/);
  console.log('PASS open-to-protected authentication transition clears both tabs and survives offline restart');
  assert.deepEqual(pageErrors, []); console.log('PASS no browser page errors');
} finally {
  held.splice(0).forEach((release) => release());
  await context?.close(); await new Promise((r) => server.close(r)); rmSync(userData, { recursive: true, force: true });
}
