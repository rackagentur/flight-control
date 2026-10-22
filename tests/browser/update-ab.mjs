// Service-worker update acceptance (desktop Chrome): preview build A installed and synced (synthetic data), then
// build B "deployed". Expected lifecycle (no skipWaiting): a launch keeps A in control while B installs and waits;
// after closing every window ("force-close") the next launch runs B. The saved roster, token and settings survive
// the update; B works offline; Reset still clears local data. Builds come from scripts/preview/stage.mjs --label.
// Nothing is deployed and no production system is contacted. Uses an installed Playwright (PLAYWRIGHT_MODULE_PATH).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { loadGs, fakeEnv } from '../gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../fixtures/condor-feed.synthetic.mjs';
import { stage } from '../../scripts/preview/stage.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const work = mkdtempSync(join(tmpdir(), 'fc-update-ab-'));
const builds = { A: stage(join(work, 'A'), { label: 'A' }), B: stage(join(work, 'B'), { label: 'B' }) };
const userData = join(work, 'profile');
const TOKEN = 'synthetic-update-test-token';
const endpoint = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const gs = loadGs(), feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const backend = (action) => JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action, token: 'test-token-0123456789abcdef' }), env)));
const roster = backend('roster'), history = backend('history');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let live = 'A';
let network = true;
const pageErrors = [];
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const relative = path === '/' ? 'index.html' : path.slice(1);
  const dir = builds[live].out;
  const file = resolve(dir, relative);
  if (!file.startsWith(dir) || relative === 'vercel.json') { res.writeHead(404); res.end(); return; }
  try { const body = readFileSync(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(userData, { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(({ now }) => { Date.now = () => now; }, { now: NOW });
context.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(e.message)));
for (const p of context.pages()) p.on('pageerror', (e) => pageErrors.push(e.message));
await context.route('https://**/*', async (route) => {
  const request = route.request();
  if (!network || !request.url().startsWith(endpoint)) return route.abort('internetdisconnected');
  const body = request.method() === 'POST' ? request.postDataJSON() : {};
  const data = body.action === 'roster' ? roster : body.action === 'history' ? history : { success: false, error: 'auth-required' };
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
});

/** Polls an (async) page predicate from Node; tolerates navigations. */
async function until(page, predicate, message, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    try { if (await page.evaluate(predicate)) return; } catch { /* navigating */ }
    if (Date.now() - start > timeoutMs) assert.fail(`timed out: ${message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const ready = (page) => until(page, () => document.querySelector('[data-sync-status]')?.textContent.includes('Available offline'), 'offline shell ready');
const shellVersion = (page) => page.evaluate(() => new Promise((resolve) => {
  const worker = navigator.serviceWorker.controller;
  if (!worker) { resolve(null); return; }
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => resolve(e.data?.version ?? null);
  worker.postMessage({ type: 'FC_SHELL_STATUS' }, [channel.port2]);
  setTimeout(() => resolve(null), 4000);
}));
const aboutLabel = async (page) => {
  await page.evaluate(() => { location.hash = '#/settings'; });
  await until(page, () => !!document.querySelector('#reset-local'), 'settings rendered');
  return (await page.locator('main').innerText()).match(/Version 2\.0 · preview build ([A-Z0-9-]+)/)?.[1] ?? null;
};
const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
// "Force-close": every window closes (as an iPhone app swipe-away does), time passes, then the app is opened again.
const relaunch = async (pauseMs = 0) => {
  for (const p of context.pages()) await p.close({ runBeforeUnload: false });
  if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
  const p = await context.newPage(); await p.goto(url); return p;
};

try {
  // ---------------------------------------------------------------- Build A installed and synced
  let page = context.pages()[0];
  await page.goto(url);
  await page.evaluate(({ endpoint, token }) => {
    localStorage.setItem('fc.v2.endpoint', endpoint); localStorage.setItem('fc.v2.token.v2', token); localStorage.setItem('fc.v2.timeDisplay', 'utc');
  }, { endpoint, token: TOKEN });
  await until(page, async () => !!(await navigator.serviceWorker.getRegistration())?.active, 'build A worker active');
  await page.reload(); await ready(page);
  await until(page, () => !!localStorage.getItem('fc.v2.roster.v1'), 'roster saved');
  assert.equal(await shellVersion(page), builds.A.version);
  assert.equal(await aboutLabel(page), 'A');
  const before = await storage(page);
  console.log(`PASS build A installed, synchronized and visible (shell ${builds.A.version})`);

  // ---------------------------------------------------------------- Build B deployed; first launch
  live = 'B';
  page = await relaunch();
  await ready(page);
  const updateCalls = [];
  try {
    await until(page, async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, 'B installed and waiting', 15000);
  } catch {
    // The launch update check is not guaranteed (I-009): emulate the browser's periodic check.
    for (let i = 0; i < 3; i++) {
      updateCalls.push(await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); return 'update()'; }).catch(() => 'update() failed'));
      try { await until(page, async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, 'B waiting after update()', 5000); break; } catch { /* retry */ }
    }
  }
  assert.ok(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), 'build B installed and waiting');
  assert.equal(await shellVersion(page), builds.A.version, 'the open app keeps running A (no interruption, no mixed versions)');
  assert.equal(await aboutLabel(page), 'A');
  console.log(`PASS first launch after deploying B: A stays in control, B installed and waiting${updateCalls.length ? ` (needed ${updateCalls.join(', ')})` : ' (browser update check on launch)'}`);

  // ---------------------------------------------------------------- Force-close and reopen
  page = await relaunch(Number(process.env.FORCE_CLOSE_PAUSE_MS ?? 3000));
  await until(page, async () => !(await navigator.serviceWorker.getRegistration())?.waiting && !!navigator.serviceWorker.controller, 'B activated after relaunch');
  await ready(page);
  assert.equal(await shellVersion(page), builds.B.version, 'B is the controlling shell');
  assert.equal(await aboutLabel(page), 'B');
  const after = await storage(page);
  for (const key of ['fc.v2.roster.v1', 'fc.v2.token.v2', 'fc.v2.endpoint', 'fc.v2.timeDisplay']) assert.equal(after[key], before[key], `${key} preserved across the update`);
  const cacheNames = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('fc-shell-')));
  assert.ok(cacheNames.includes(`fc-shell-${builds.B.version}`), 'B shell cache present');
  assert.ok(cacheNames.length <= 2, 'at most the previous shell kept as recovery copy');
  console.log('PASS after force-close + reopen: B active and visible; roster, token, endpoint and settings preserved');

  // ---------------------------------------------------------------- B offline
  network = false; await context.setOffline(true);
  await page.reload(); await ready(page);
  for (const hash of ['#/today', '#/calendar', '#/flights']) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction((h) => location.hash === h && !!document.querySelector('.page-title'), hash);   // sync predicate
  }
  assert.match(await page.locator('main').innerText(), /DE92\d\d/);
  assert.equal(await shellVersion(page), builds.B.version);
  console.log('PASS build B offline: Today, Calendar, Flights with the cached roster');
  network = true; await context.setOffline(false);

  // ---------------------------------------------------------------- Reset still works on B
  await page.reload(); await ready(page);
  await page.evaluate(() => { location.hash = '#/settings'; });
  await until(page, () => !!document.querySelector('#reset-local'), 'settings');
  await page.click('#reset-local'); await page.click('#reset-local');
  await until(page, () => Object.keys(localStorage).every((k) => !k.startsWith('fc.v2.')), 'reset cleared local data');
  assert.ok(await page.evaluate(async () => (await caches.keys()).some((k) => k.startsWith('fc-shell-'))), 'static shell stays (no personal data)');
  console.log('PASS Reset Local Data on B clears roster, token and settings; static shell remains');

  assert.deepEqual(pageErrors, [], 'no browser page errors');
  console.log('PASS no browser page errors');
} finally {
  await context.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
