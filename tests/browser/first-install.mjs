// Deterministic first-install/navigation race; synthetic/sample mode, all external traffic blocked.
// Run with the same PLAYWRIGHT_MODULE_PATH and BROWSER_CHANNEL as offline.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const latch = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
const bounded = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Install/navigation handshake timed out')), 10000); })]); }
  finally { clearTimeout(timer); }
};
for (const scope of ['/', '/flight-control/']) {
  const assetSeen = latch(), docSeen = latch(), asset = latch(), doc = latch();
  let documents = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith(scope)) { res.writeHead(404); res.end(); return; }
    const relative = path.slice(scope.length) || 'index.html';
    if (relative === 'assets/css/base.css' && req.headers['sec-fetch-dest'] === 'empty') {
      assetSeen.release(); await asset.promise; // keep the initial worker installing
    }
    if (path === scope && ++documents === 2) {
      docSeen.release(); await doc.promise; // navigation client exists, document not execution-ready
    }
    const file = resolve(root, relative);
    if (!file.startsWith(root) || !/^(index.html|sw.js|manifest.webmanifest|src\/|assets\/)/.test(relative)) { res.writeHead(404); res.end(); return; }
    try {
      const body = readFileSync(file);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}${scope}`;
  const profile = mkdtempSync(join(tmpdir(), 'fc-first-install-'));
  const context = await chromium.launchPersistentContext(profile, { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  await context.route('https://**/*', (route) => route.abort());
  const page = context.pages()[0]; const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(url); await bounded(assetSeen.promise);
    const reload = page.reload(); await bounded(docSeen.promise); asset.release();
    const worker = context.serviceWorkers()[0];
    await bounded(worker.evaluate(() => new Promise((resolve) => {
      const worker = self.registration.installing || self.registration.active;
      const check = () => { if (worker.state === 'activated') { worker.removeEventListener('statechange', check); resolve(); } };
      worker.addEventListener('statechange', check); check();
    })));
    doc.release(); await reload;
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
    await page.evaluate(async (scope) => {
      const { watchOfflineShell } = await import(`${scope}src/offline-shell.js`);
      watchOfflineShell((ready) => { window.testShellReady = ready; });
    }, scope);
    await page.waitForFunction(() => window.testShellReady === true, null, { timeout: 5000 });
    assert.equal(documents, 2, 'recovery must not reload the page');
    assert.equal(await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).pathname), `${scope}sw.js`);
    await context.setOffline(true); await page.reload();
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    await page.waitForSelector('.page-title');
    assert.deepEqual(errors, []);
    console.log(`PASS ${scope} activation during pending navigation recovers control, confirms complete shell, and reloads offline`);
  } finally {
    asset.release(); doc.release(); await context.close(); server.close(); server.closeAllConnections();
    rmSync(profile, { recursive: true, force: true });
  }
}
