// Worker lifecycle with real Response bodies and digest verification; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const ROOT = new URL('../', import.meta.url);
const code = readFileSync(new URL('sw.js', ROOT), 'utf8');
function worker({ broken = false } = {}) {
  const buckets = new Map([['fc-shell-previous', new Map([['old', new Response('old working shell')]])]]);
  const events = new Map(); let claimed = false;
  const registration = { active: { state: 'activated' }, installing: null, waiting: null };
  const caches = { keys: async () => [...buckets.keys()], delete: async (key) => buckets.delete(key), open: async (key) => {
    if (!buckets.has(key)) buckets.set(key, new Map()); const entries = buckets.get(key);
    return { put: async (url, response) => entries.set(url, response.clone()), match: async (url) => entries.get(url)?.clone() };
  } };
  const fetches = []; let replacement = null, unavailable = false;
  const messages = [];
  const context = vm.createContext({ URL, crypto: globalThis.crypto, caches,
    self: { registration, location: { href: 'https://example.invalid/flight-control/sw.js' }, clients: { matchAll: async () => [{ postMessage: (m) => messages.push(m) }], claim: async () => { claimed = true; } }, addEventListener: (name, handler) => events.set(name, handler) },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      if (unavailable) throw new Error('offline');
      const path = new URL(url).pathname.replace('/flight-control/', '');
      if (replacement !== null) return new Response(replacement);
      return new Response(broken && path === 'src/main.js' ? 'partially deployed file' : readFileSync(new URL(path, ROOT)));
    } });
  vm.runInContext(code, context);
  return { buckets, events, fetches, messages, registration, replace: (v) => { replacement = v; }, offline: () => { unavailable = true; }, get claimed() { return claimed; }, async run(name, extra = {}) {
    let result; events.get(name)({ ...extra, waitUntil: (p) => { result = p; }, respondWith: (p) => { result = p; } }); return result;
  } };
}

test('generated worker exactly matches current app assets and worker body', () => {
  execFileSync(process.execPath, ['scripts/build-offline.mjs', '--check'], { cwd: ROOT });
});
test('complete install, offline navigation and readiness; no API/private requests cached', async () => {
  assert.match(readFileSync(new URL('index.html', ROOT), 'utf8'), /<link[^>]+rel="manifest"[^>]+crossorigin="use-credentials"/);
  const w = worker(); await w.run('install'); await w.run('activate'); assert.equal(w.claimed, true);
  const key = [...w.buckets.keys()].find((key) => key !== 'fc-shell-previous');
  assert.ok(w.buckets.get(key).size > 50);
  assert.ok(w.fetches.every((f) => f.options.credentials === 'same-origin'));
  const request = { method: 'GET', url: 'https://example.invalid/flight-control/?review#/today', mode: 'navigate' };
  const response = await w.run('fetch', { request }); assert.match(await response.text(), /Flight Control/);
  for (const request of [
    { method: 'POST', url: 'https://example.invalid/flight-control/index.html' },
    { method: 'GET', url: 'https://example.invalid/flight-control/reference/private.gs' },
    { method: 'GET', url: 'https://script.google.com/macros/s/synthetic/exec' },
    { method: 'GET', url: 'https://example.invalid/flight-control/src/main.js?token=synthetic' },
  ]) assert.equal(await w.run('fetch', { request }), undefined);
  let message; const status = () => w.run('message', { data: { type: 'FC_SHELL_STATUS' }, ports: [{ postMessage: (m) => { message = m; } }] });
  await status(); assert.equal(message.ready, true);
  w.buckets.get(key).delete('https://example.invalid/flight-control/src/main.js');
  await status(); assert.equal(message.ready, false);
});
test('interrupted or mismatched update cannot replace the last complete offline shell', async () => {
  const w = worker({ broken: true });
  await assert.rejects(w.run('install'), /Incomplete application update/);
  assert.deepEqual([...w.buckets.keys()], ['fc-shell-previous']);
  assert.equal(await w.buckets.get('fc-shell-previous').get('old').text(), 'old working shell');
  assert.equal(w.claimed, false);
});

test('cache miss returns changed online bytes without contaminating offline cache or claiming readiness', async () => {
  const w = worker(); await w.run('install');
  const cache = w.buckets.get([...w.buckets.keys()].find((k) => k !== 'fc-shell-previous'));
  const url = 'https://example.invalid/flight-control/src/main.js'; cache.delete(url);
  w.replace('/* synthetic next version */');
  const response = await w.run('fetch', { request: { method: 'GET', url } });
  assert.equal(await response.text(), '/* synthetic next version */'); assert.equal(cache.has(url), false);
  let message; await w.run('message', { data: { type: 'FC_SHELL_STATUS' }, ports: [{ postMessage: (m) => { message = m; } }] });
  assert.equal(message.ready, false); assert.equal(w.messages.at(-1).type, 'FC_SHELL_CHANGED');
  w.replace(null); await w.run('fetch', { request: { method: 'GET', url } }); assert.equal(cache.has(url), true);
});

test('previous shell repairs only exact hash matches, even offline', async () => {
  const w = worker(); await w.run('install');
  const cache = w.buckets.get([...w.buckets.keys()].find((k) => k !== 'fc-shell-previous'));
  const url = 'https://example.invalid/flight-control/src/main.js';
  const previous = w.buckets.get('fc-shell-previous'); previous.set(url, cache.get(url).clone()); cache.delete(url);
  w.offline(); const response = await w.run('fetch', { request: { method: 'GET', url } });
  assert.equal(await response.text(), readFileSync(new URL('src/main.js', ROOT), 'utf8')); assert.equal(cache.has(url), true);
  cache.delete(url); previous.set(url, new Response('wrong version'));
  await assert.rejects(w.run('fetch', { request: { method: 'GET', url } }), /offline/); assert.equal(cache.has(url), false);
});

test('readiness retries a timed-out worker message, stays conservative and bounds retries', async () => {
  const { watchOfflineShell } = await import('../src/offline-shell.js');
  for (const recovers of [true, false]) {
    let attempts = 0; const statuses = [];
    const nav = { serviceWorker: {
      controller: { postMessage: (_message, ports) => {
        attempts++;
        if (recovers && attempts > 1) ports[0].postMessage({ ready: true });
        ports[0].close();
      } },
      addEventListener() {}, register: () => new Promise(() => {}),
    } };
    let done; const finished = new Promise((resolve) => { done = resolve; });
    watchOfflineShell((value) => {
      statuses.push(value);
      if (value || statuses.length === 3) done();
    }, { nav, events: null, timeoutMs: 10, retryDelayMs: 5 });
    await finished;
    assert.equal(attempts, recovers ? 2 : 3);
    assert.equal(statuses[0], false); assert.equal(statuses.at(-1), recovers);
  }
});


test('claim recovery requires an in-scope window, complete shell, and no pending update', async () => {
  const source = { type: 'window', url: 'https://example.invalid/flight-control/' };
  const claim = (w, source) => w.run('message', { data: { type: 'FC_SHELL_CLAIM' }, source });
  const w = worker();
  await claim(w, source); assert.equal(w.claimed, false, 'incomplete shell');
  await w.run('install');
  for (const bad of [null, { ...source, type: 'worker' }, { ...source, url: 'https://other.invalid/flight-control/' }, { ...source, url: 'https://example.invalid/elsewhere/' }]) {
    await claim(w, bad); assert.equal(w.claimed, false);
  }
  for (const key of ['installing', 'waiting']) {
    w.registration[key] = {}; await claim(w, source); assert.equal(w.claimed, false);
    w.registration[key] = null;
  }
  w.registration.active.state = 'activating'; await claim(w, source); assert.equal(w.claimed, false);
  w.registration.active.state = 'activated'; await claim(w, source); assert.equal(w.claimed, true);
});

test('uncontrolled document requests claim once, stays unready until controlling worker confirms cache', async () => {
  const { watchOfflineShell } = await import('../src/offline-shell.js');
  for (const pending of [null, 'waiting', 'installing']) {
    const messages = [], statuses = [], listeners = new Map();
    const active = { state: 'activated', postMessage: (message, ports) => {
      messages.push(message.type);
      if (ports) { ports[0].postMessage({ ready: true }); ports[0].close(); }
    } };
    const registration = { active, addEventListener() {}, ...(pending ? { [pending]: { addEventListener() {} } } : {}) };
    const serviceWorker = { controller: null, register: async () => registration, addEventListener: (type, fn) => listeners.set(type, fn) };
    watchOfflineShell((ready) => statuses.push(ready), { nav: { serviceWorker }, events: null });
    await new Promise((r) => setTimeout(r, 0));
    listeners.get('controllerchange')(); // duplicate lifecycle notification while still uncontrolled
    assert.deepEqual(messages, pending ? [] : ['FC_SHELL_CLAIM']);
    assert.ok(statuses.every((ready) => !ready));
    serviceWorker.controller = active; listeners.get('controllerchange')();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(statuses.at(-1), true);
  }
});
