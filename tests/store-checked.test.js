// store.getChecked (Crew Intelligence Stage A, batch 6): a read that distinguishes "absent" from "unreadable".
// The existing methods keep their semantics (get still answers the fallback on a failing read).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

test('getChecked: a present value is returned with ok:true', () => {
  const store = createStore(memoryStorage());
  store.set('crew.v1', 'x');
  assert.deepEqual(store.getChecked('crew.v1'), { ok: true, value: 'x' });
});

test('getChecked: an absent key is ok:true with value null (truly absent)', () => {
  assert.deepEqual(createStore(memoryStorage()).getChecked('crew.v1'), { ok: true, value: null });
});

test('getChecked: a throwing getItem is ok:false; get keeps answering the fallback as before', () => {
  const hostile = { getItem() { throw new Error('blocked'); }, setItem() {}, removeItem() {}, key: () => null, length: 0 };
  const store = createStore(hostile);
  assert.deepEqual(store.getChecked('crew.v1'), { ok: false });
  assert.equal(store.get('crew.v1'), null, 'get unchanged: null');
  assert.equal(store.get('theme', 'system'), 'system', 'get unchanged: fallback');
});

test('getChecked: no storage backend is ok:false; get is unchanged', () => {
  const store = createStore(null);
  if (globalThis.window?.localStorage) return;   // Node has no browser storage: the store is inert
  assert.deepEqual(store.getChecked('crew.v1'), { ok: false });
  assert.equal(store.get('theme', 'system'), 'system');
});

test('getChecked reads the namespaced key only', () => {
  const mem = memoryStorage();
  mem.setItem('crew.v1', 'not ours');
  const store = createStore(mem);
  assert.deepEqual(store.getChecked('crew.v1'), { ok: true, value: null });
  mem.setItem('fc.v2.crew.v1', 'ours');
  assert.deepEqual(store.getChecked('crew.v1'), { ok: true, value: 'ours' });
});
