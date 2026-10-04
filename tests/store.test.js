import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, SCHEMA_VERSION } from '../src/store.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

test('values are namespaced under fc.v2.', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  store.set('theme', 'dark');
  assert.deepEqual(mem.dump(), { 'fc.v2.theme': 'dark' });
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get('missing', 'fallback'), 'fallback');
});

test('JSON round-trip with a safe fallback for corrupt data', () => {
  const mem = memoryStorage({ 'fc.v2.bad': '{nope' });
  const store = createStore(mem);
  store.setJSON('profile', { base: 'FRA' });
  assert.deepEqual(store.getJSON('profile'), { base: 'FRA' });
  assert.equal(store.getJSON('bad', 'fb'), 'fb');
});

test('clearAll removes only fc.v2.* keys', () => {
  const mem = memoryStorage({ 'fc.v2.theme': 'dark', 'fc.v2.schema': '1', deploymentUrl: 'legacy', other: 'x' });
  const removed = createStore(mem).clearAll();
  assert.equal(removed, 2);
  assert.deepEqual(mem.dump(), { deploymentUrl: 'legacy', other: 'x' });
});

test('ensureSchema records the version and reports the previous one', () => {
  const mem = memoryStorage();
  const store = createStore(mem);
  assert.equal(store.ensureSchema(), null);
  assert.equal(store.ensureSchema(), SCHEMA_VERSION);
});

test('throwing storage (private mode / blocked) never breaks callers', () => {
  const hostile = {
    get length() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); },
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const store = createStore(hostile);
  assert.equal(store.get('theme', 'system'), 'system');
  assert.equal(store.set('theme', 'dark'), false);
  assert.doesNotThrow(() => store.remove('theme'));
  assert.equal(store.clearAll(), 0);
  assert.equal(store.ensureSchema(), null);
});
