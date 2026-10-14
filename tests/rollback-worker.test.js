// Emergency rollback worker (scripts/rollback/sw.js): removes only this app's shell caches and its
// own registration, never storage; never part of the normal build. Lifecycle in a real browser:
// tests/browser/rollback-subpath.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../scripts/rollback/sw.js', import.meta.url), 'utf8');

function runWorker(cacheNames) {
  const listeners = {};
  const deleted = [], navigated = [];
  let unregistered = 0, claimed = 0, skipped = 0;
  const names = new Set(cacheNames);
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { skipped += 1; },
    clients: {
      claim: async () => { claimed += 1; },
      matchAll: async () => [{ url: 'https://example.test/flight-control/#/today', navigate: async (u) => { navigated.push(u); } }],
    },
    registration: { unregister: async () => { unregistered += 1; return true; } },
  };
  const caches = { keys: async () => [...names], delete: async (n) => { deleted.push(n); return names.delete(n); } };
  vm.runInNewContext(SOURCE, { self, caches });
  const fire = async (type) => { let p = null; listeners[type]?.({ waitUntil: (x) => { p = x; } }); await p; };
  return { listeners, fire, deleted, navigated, names, counts: () => ({ unregistered, claimed, skipped }) };
}

test('rollback worker: activates at once, deletes only fc-shell-* caches, unregisters itself, reloads windows', async () => {
  const w = runWorker(['fc-shell-aaaa', 'fc-shell-bbbb', 'unrelated-cache', 'roadmap-cache-v1', 'fc-other']);
  await w.fire('install');
  await w.fire('activate');
  assert.deepEqual(w.deleted.sort(), ['fc-shell-aaaa', 'fc-shell-bbbb']);
  assert.deepEqual([...w.names].sort(), ['fc-other', 'roadmap-cache-v1', 'unrelated-cache']);
  assert.deepEqual(w.counts(), { unregistered: 1, claimed: 1, skipped: 1 });
  assert.deepEqual(w.navigated, ['https://example.test/flight-control/#/today']);
});

test('rollback worker: no fetch handler and no storage access; never in the normal precache', () => {
  const w = runWorker([]);
  assert.deepEqual(Object.keys(w.listeners).sort(), ['activate', 'install']);
  const code = SOURCE.replace(/\/\/.*$/gm, '');                    // comments describe what it never touches
  for (const api of ['localStorage', 'indexedDB', 'cookieStore', 'document.cookie', 'fetch']) assert.ok(!code.includes(api), `must not use ${api}`);
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.ok(!sw.includes('scripts/rollback'), 'rollback worker is not precached');
  assert.notEqual(sw, SOURCE);
});
