// Crew Intelligence Stage B0: a crew sign-out cleanup report of one page is superseded when ANOTHER access signs in
// (in another tab); a same-token restoration is not newer; non-crew sign-out failures stay closed; a late failure
// after supersede reaches only its own awaiter. Two controllers share one store; locks are faked to inject a
// failure after a held phase. Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { ApiError } from '../src/api/appscript.js';
import { SIGNED_OUT_KEY } from '../src/roster-storage.js';
import { accessFingerprint, endpointFingerprint, CREW_CREDENTIAL_KEY } from '../src/sources/crew-credential.js';
import { PROFILE } from './helpers.js';
import { memoryStorage, flush, TOKEN, OTHER_TOKEN, ENDPOINT, T0 } from './fixtures/crew-frontend.synthetic.mjs';

const STORED = `fc.v2.${CREW_CREDENTIAL_KEY}`;
const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
const record = () => JSON.stringify({ v: 1, phase: 'active', grants: [{
  grant: 'A'.repeat(43), ep: endpointFingerprint(ENDPOINT), bind: accessFingerprint(ENDPOINT, TOKEN), at: T0, role: 'active', G: 1, unknown: false, inflight: false,
}] });

/** Replaces navigator.locks: every request waits for release(), then fails (the crew drop cannot coordinate). */
function failingLocksAfterRelease() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let release;
  const released = new Promise((r) => { release = r; });
  const locks = { request: () => released.then(() => { throw new Error('denied'); }) };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, locks }, configurable: true, writable: true });
  return { release, restore: () => Object.defineProperty(globalThis, 'navigator', saved) };
}

function tabs(storage = memoryStorage()) {
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  storage.setItem(STORED, record());
  const mk = () => createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  return { storage, store, A: mk(), B: mk() };
}

test('B0: cross-tab re-authentication with another token supersedes A\'s pending crew cleanup; the late failure does not error A', async () => {
  const locks = failingLocksAfterRelease();
  try {
    const { storage, store, A, B } = tabs();
    assert.equal(A.removeToken(), true, 'synchronous local sign-out');
    assert.equal(A.view().crewCleanup, 'pending');
    const awaited = A.crewCleanup();
    store.set(TOKEN_KEY, OTHER_TOKEN);                     // tab B signs in with a new token
    B.forgetContractData();
    A.accessChanged();                                     // A sees the storage event
    assert.equal(A.view().crewCleanup, null, 'superseded');
    locks.release();
    assert.equal(await awaited, 'incomplete', 'the failure reaches only its own awaiter');
    await flush();
    assert.equal(A.view().crewCleanup, null);
    assert.equal(A.view().storageError, false, 'the new session is not marked');
    assert.notEqual(storage.getItem(STORED), null, 'reporting only: the record is never removed');
  } finally {
    locks.restore();
  }
});

test('B0: restoring the SAME token is not newer: the crew cleanup report stays and fails visibly', async () => {
  const locks = failingLocksAfterRelease();
  try {
    const { storage, store, A } = tabs();
    A.removeToken();
    store.set(TOKEN_KEY, TOKEN);                           // another tab puts the same token back
    store.remove(SIGNED_OUT_KEY);
    A.accessChanged();
    assert.equal(A.view().crewCleanup, 'pending', 'not superseded');
    locks.release();
    assert.equal(await A.crewCleanup(), 'incomplete');
    await flush();
    assert.equal(A.view().crewCleanup, 'incomplete');
    assert.equal(A.view().storageError, true);
    assert.notEqual(storage.getItem(STORED), null);
  } finally {
    locks.restore();
  }
});

test('B0: a re-authentication while the signed-out marker is still set does not supersede', async () => {
  const locks = failingLocksAfterRelease();
  try {
    const { store, A } = tabs();
    A.removeToken();
    store.set(TOKEN_KEY, OTHER_TOKEN);                     // token present, but SIGNED_OUT marker still set
    A.accessChanged();
    assert.equal(A.view().crewCleanup, 'pending');
    locks.release();
    assert.equal(await A.crewCleanup(), 'incomplete');
  } finally {
    locks.restore();
  }
});

test('B0: a non-crew sign-out failure is still not undone by a storage event', async () => {
  const storage = memoryStorage();
  const { store, A } = tabs(storage);
  storage.removeItem(STORED);                              // no crew record: crew cleanup is done at once
  storage.faults.set = (k) => k === `fc.v2.${SIGNED_OUT_KEY}`;   // the sign-out marker cannot be written
  assert.equal(A.removeToken(), false);
  assert.equal(A.view().crewCleanup, 'done');
  storage.faults.set = false;
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, OTHER_TOKEN);
  A.accessChanged();
  assert.equal(A.view().storageError, true, 'still closed');
  assert.match(A.view().error.message, /could not be fully cleared/);
});
