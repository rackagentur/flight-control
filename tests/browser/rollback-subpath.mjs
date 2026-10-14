// Release-safety acceptance (desktop Chrome): (1) the offline shell under the production GitHub Pages
// subpath /flight-control/; (2) the emergency rollback worker (scripts/rollback/sw.js) replacing an
// installed Step 6.6 shell and handing over to the restored pre-6.6 application (origin/main tree,
// read from local git). Synthetic roster only; every external request is intercepted; nothing is
// deployed or fetched from production. Uses an already installed Playwright (PLAYWRIGHT_MODULE_PATH).
//
//   PLAYWRIGHT_MODULE_PATH=/abs/path/to/playwright node tests/browser/rollback-subpath.mjs [restoredRef]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGs, fakeEnv } from '../gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../fixtures/condor-feed.synthetic.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const RESTORED_REF = process.argv[2] || '0ae7d58';     // the production commit a rollback would restore
const BASE = '/flight-control/';
const userData = mkdtempSync(join(tmpdir(), 'fc-rollback-browser-'));
const TOKEN = 'synthetic-rollback-test-token';
const endpoint = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const gs = loadGs(), feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const backend = (action) => JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action, token: 'test-token-0123456789abcdef' }), env)));
const roster = backend('roster'), history = backend('history');
const ASSETS = JSON.parse(readFileSync(join(root, 'sw.js'), 'utf8').match(/\nconst ASSETS = (\[[\s\S]*?\]);\n/)[1]);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let app = 'current';            // 'current' = this working tree (Step 6.6); 'restored' = RESTORED_REF + rollback worker
let network = true;
const pageErrors = [], badResponses = [];
const restoredFile = (relative) => {
  try { return execFileSync('git', ['show', `${RESTORED_REF}:${relative}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
};
const ROADMAP_HTML = `<!doctype html><meta charset="utf-8"><title>Neighbour app</title><script>
navigator.serviceWorker.register('/roadmap/sw.js', { scope: '/roadmap/' });</script>`;
const ROADMAP_SW = `self.addEventListener('install', (e) => e.waitUntil(caches.open('roadmap-cache-v1').then((c) => c.put('/roadmap/x', new Response('neighbour')))));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const send = (status, body, type) => { res.writeHead(status, { 'Content-Type': type ?? 'text/plain', 'Cache-Control': 'no-cache' }); res.end(body); };
  if (path === '/roadmap/' || path === '/roadmap/index.html') return send(200, ROADMAP_HTML, 'text/html');
  if (path === '/roadmap/sw.js') return send(200, ROADMAP_SW, 'text/javascript');
  if (!path.startsWith(BASE)) return send(404, 'outside the Pages subpath');     // nothing is served at the origin root
  const relative = path === BASE ? 'index.html' : path.slice(BASE.length);
  if (!['index.html', 'manifest.webmanifest', 'sw.js'].includes(relative) && !relative.startsWith('src/') && !relative.startsWith('assets/')) return send(404, 'not found');
  const type = TYPES[extname(relative)];
  if (app === 'restored') {
    const body = relative === 'sw.js' ? readFileSync(join(root, 'scripts/rollback/sw.js')) : restoredFile(relative);
    return body ? send(200, body, type) : send(404, 'not found');
  }
  const file = resolve(root, relative);
  if (!file.startsWith(root)) return send(404, 'not found');
  try { send(200, readFileSync(file), type); } catch { send(404, 'not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const appUrl = `${origin}${BASE}`;

const context = await chromium.launchPersistentContext(userData, { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await context.addInitScript(({ now }) => { Date.now = () => now; }, { now: NOW });
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => { if (r.url().startsWith(appUrl) && r.status() >= 400) badResponses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
};
context.on('page', watch);
for (const p of context.pages()) watch(p);
await context.route('https://**/*', async (route) => {
  const request = route.request();
  if (!network || !request.url().startsWith(endpoint)) return route.abort('internetdisconnected');
  const body = request.method() === 'POST' ? request.postDataJSON() : {};
  const data = body.action === 'roster' ? roster : body.action === 'history' ? history : { success: false, error: 'auth-required' };
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
});
const offline = async (value) => { network = !value; await context.setOffline(value); };
const ready = (page) => until(page, () => document.querySelector('[data-sync-status]')?.textContent.includes('Available offline'), 'offline shell ready');
const go = async (page, hash) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForFunction((h) => location.hash === h && document.querySelector('.page-title'), hash);
};
/** Polls an (async) page predicate from Node; tolerates navigations. waitForFunction would treat a Promise as truthy. */
async function until(page, predicate, message, timeoutMs = 60000, extra = null) {
  const start = Date.now();
  for (;;) {
    try { if (await page.evaluate(predicate)) return; } catch { /* navigating: retry in the new document */ }
    if (Date.now() - start > timeoutMs) {
      let snapshot = null;
      try {
        snapshot = await state(page);
        snapshot = { controlled: snapshot.controlled, registrations: snapshot.registrations, caches: snapshot.caches.map((c) => `${c.name}:${c.urls.length}`),
          storage: Object.keys(snapshot.storage), status: await page.evaluate(() => document.querySelector('[data-sync-status]')?.textContent?.trim() ?? null) };
      } catch { /* unavailable */ }
      assert.fail(`timed out: ${message} ${JSON.stringify(snapshot)} ${extra ? JSON.stringify(await extra()) : ''}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
const state = (page) => page.evaluate(async () => ({
  registrations: (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: (r.active || r.waiting || r.installing)?.scriptURL ?? null })),
  caches: await Promise.all((await caches.keys()).map(async (name) => ({ name, urls: (await (await caches.open(name)).keys()).map((q) => new URL(q.url).pathname) }))),
  controlled: !!navigator.serviceWorker.controller,
  storage: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
}));

try {
  // ---------------------------------------------------------------- (1) GitHub Pages subpath
  let page = context.pages()[0];
  await page.goto(appUrl);
  await page.evaluate(({ endpoint, token }) => {
    localStorage.setItem('fc.v2.endpoint', endpoint); localStorage.setItem('fc.v2.token.v2', token); localStorage.setItem('fc.v2.timeDisplay', 'utc');
  }, { endpoint, token: TOKEN });
  // First visit: let the worker finish installing before reloading. A reload that races activation can
  // leave that one document uncontrolled until the next launch (browser behaviour, harmless in use).
  await until(page, async () => !!(await navigator.serviceWorker.getRegistration(location.href))?.active, 'shell worker active');
  await page.reload(); await ready(page);
  await page.waitForFunction(() => localStorage.getItem('fc.v2.roster.v1'));
  let s = await state(page);
  const shell = s.registrations.find((r) => r.scope === appUrl);
  assert.ok(shell, `registration scoped to ${BASE}`);
  assert.equal(shell.script, `${appUrl}sw.js`);
  assert.equal(s.controlled, true);
  const shellCaches = s.caches.filter((c) => c.name.startsWith('fc-shell-'));
  assert.equal(shellCaches.length, 1);
  assert.equal(shellCaches[0].urls.length, ASSETS.length, 'every precached asset stored');
  assert.ok(shellCaches[0].urls.every((p) => p.startsWith(BASE)), 'all cached URLs under the subpath');
  assert.deepEqual(badResponses, [], 'no failed app requests');
  console.log('PASS subpath startup, asset loading, worker registration and scope, complete shell cache');

  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const href = new URL(link.getAttribute('href'), location.href);
    const m = await (await fetch(href)).json();
    return { manifestUrl: href.href, start: new URL(m.start_url, href).href, scope: new URL(m.scope, href).href };
  });
  assert.equal(manifest.manifestUrl, `${appUrl}manifest.webmanifest`);
  assert.equal(manifest.start, `${appUrl}#/today`);
  assert.equal(manifest.scope, appUrl);
  console.log('PASS manifest start_url and scope resolve under the subpath');

  await offline(true);
  await page.reload(); await ready(page);
  for (const hash of ['#/today', '#/calendar', '#/flights']) await go(page, hash);
  assert.match(await page.locator('main').innerText(), /DE92\d\d/, 'cached flights listed offline');
  await go(page, '#/today');
  assert.ok(await page.evaluate(() => localStorage.getItem('fc.v2.roster.v1')));
  console.log('PASS offline startup, Today/Calendar/Flights navigation and cached roster under the subpath');
  await offline(false);
  await page.reload(); await ready(page);

  // ---------------------------------------------------------------- (2) Emergency rollback
  await page.evaluate(async () => {
    await (await caches.open('unrelated-cache')).put('/unrelated', new Response('keep'));
    localStorage.setItem('other-app.setting', 'keep');
  });
  const neighbour = await context.newPage();
  await neighbour.goto(`${origin}/roadmap/`);
  await until(neighbour, async () => !!(await navigator.serviceWorker.getRegistration('/roadmap/'))?.active && (await caches.keys()).includes('roadmap-cache-v1'), 'neighbour worker active');
  await neighbour.close();
  const before = await state(page);
  assert.ok(before.registrations.some((r) => r.scope === `${origin}/roadmap/`));
  assert.ok(before.caches.some((c) => c.name === 'roadmap-cache-v1') && before.caches.some((c) => c.name === 'unrelated-cache'));
  console.log('PASS installed 6.6 shell + populated cache + same-origin neighbour app and caches before rollback');

  app = 'restored';                                                   // "deploy" the rollback: restored app + rollback worker
  await page.goto(appUrl);                                            // a normal launch (the browser may run its update check)
  // The browser's own update check is not guaranteed on every launch (only at least every 24 h).
  // If it has not handed over within 10 s, trigger the same update lifecycle explicitly.
  const handedOver = async () => !navigator.serviceWorker.controller
    && !(await navigator.serviceWorker.getRegistration(location.href))
    && !!document.querySelector('.page-title') && !document.querySelector('[data-sync-status]');
  let trigger = 'browser update check on launch';
  const updateCalls = [];
  const workerStates = () => page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration(location.href);
    return r ? { active: r.active?.state ?? null, waiting: r.waiting?.state ?? null, installing: r.installing?.state ?? null } : null;
  }).catch(() => null);
  try { await until(page, handedOver, 'natural update', 10000); } catch {
    // Emulate the browser's periodic check: registration.update(), a few times.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const outcome = await page.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration(location.href);
        if (!r) return 'no registration';
        await r.update();
        return 'update() resolved';
      }).catch((e) => `update() failed: ${e.message.split('\n')[0].slice(0, 80)}`);
      updateCalls.push(outcome);
      trigger = `explicit registration.update() ×${attempt}`;
      try { await until(page, handedOver, 'after update()', 5000); break; } catch { /* retry */ }
    }
    // Observed in Chrome (rare): the rollback worker installs but stays waiting while the old shell still
    // controls an open page. A relaunch (iPhone: force-close + reopen) releases it. Model exactly that.
    for (let relaunch = 1; relaunch <= 2 && !(await page.evaluate(handedOver).catch(() => false)); relaunch++) {
      updateCalls.push(`before relaunch ${relaunch}: ${JSON.stringify(await workerStates())}`);
      for (const p of context.pages()) await p.close();
      page = await context.newPage();
      await page.goto(appUrl);
      trigger = `relaunch ×${relaunch} after the rollback worker waited`;
      try { await until(page, handedOver, 'after relaunch', 20000); break; } catch { /* one more relaunch */ }
    }
  }
  await until(page, handedOver, 'rollback handed over to the restored app', 60000, async () => ({
    trigger, updateCalls,
    workers: await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({
      scope: new URL(r.scope).pathname, active: r.active?.state ?? null, waiting: r.waiting?.state ?? null, installing: r.installing?.state ?? null }))).catch(() => null),
    served: await fetch(`${appUrl}sw.js`).then((r) => r.text()).then((t) => (t.includes('EMERGENCY ROLLBACK WORKER') ? 'rollback worker' : 'other')),
  }));
  console.log(`INFO rollback picked up via: ${trigger}${updateCalls.length ? ` (${updateCalls.join('; ')})` : ''}`);
  const after = await state(page);
  assert.equal(after.registrations.some((r) => r.scope === appUrl), false, 'Flight Control registration removed');
  assert.ok(after.registrations.some((r) => r.scope === `${origin}/roadmap/`), 'neighbour registration untouched');
  assert.equal(after.caches.some((c) => c.name.startsWith('fc-shell-')), false, 'all Flight Control shell caches removed');
  assert.deepEqual(after.caches.find((c) => c.name === 'unrelated-cache')?.urls, ['/unrelated'], 'unrelated cache untouched');
  assert.deepEqual(after.caches.find((c) => c.name === 'roadmap-cache-v1')?.urls, ['/roadmap/x'], 'neighbour cache untouched');
  for (const key of ['fc.v2.roster.v1', 'fc.v2.token.v2', 'fc.v2.endpoint', 'fc.v2.timeDisplay', 'other-app.setting']) {
    assert.equal(after.storage[key], before.storage[key], `${key} unchanged`);
  }
  console.log('PASS rollback worker removed the shell registration and only fc-shell-* caches; roster, token, settings and neighbours intact');

  let fromWorker = null;
  page.once('response', (r) => { if (r.url() === appUrl) fromWorker = r.fromServiceWorker(); });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.page-title'));
  assert.equal(fromWorker, false, 'document loaded from the network');
  assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), false);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-sync-status]')), false, 'restored (pre-6.6) application is running');
  await page.waitForFunction(() => /DE92\d\d/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 30000 });
  assert.equal((await state(page)).registrations.some((r) => r.scope === appUrl), false, 'restored app does not re-register a worker');
  console.log(`PASS restored application (${RESTORED_REF}) loads from the network with its roster; no worker re-registered`);

  assert.deepEqual(pageErrors, [], 'no browser page errors');
  console.log('PASS no browser page errors');
} finally {
  await context.close();
  server.close();
  rmSync(userData, { recursive: true, force: true });
}
