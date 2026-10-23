// Crew Intelligence Phase 1c Stage A: crew grant record (src/sources/crew-credential.js) and its controller
// wiring. The record tracks the confirmed active grant AND every potentially live candidate (enrollment
// outcome unknown); deletion state survives sign-out and token changes; records of another version are
// never touched. Synthetic data only; in-memory storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { ApiError } from '../src/api/appscript.js';
import {
  createCrewCredentials, accessFingerprint, endpointFingerprint, grantFingerprint, dropCrewAccess, reconcileCrewAccess,
  CREW_CREDENTIAL_KEY, CREW_MAX_CANDIDATES, CREW_CREDENTIAL_LOCK,
} from '../src/sources/crew-credential.js';
import { PROFILE } from './helpers.js';
import { memoryStorage, seqRandom, flush, TOKEN, OTHER_TOKEN, ENDPOINT, T0 } from './fixtures/crew-frontend.synthetic.mjs';

const ACCESS = { endpoint: ENDPOINT, token: TOKEN };
const OTHER = { endpoint: ENDPOINT, token: OTHER_TOKEN };
const STORED = `fc.v2.${CREW_CREDENTIAL_KEY}`;
const BIND = accessFingerprint(ENDPOINT, TOKEN);
const EP = endpointFingerprint(ENDPOINT);

function setup(storage = memoryStorage()) {
  const store = createStore(storage);
  const clock = { t: T0 };
  const creds = createCrewCredentials({ store, random: seqRandom(), now: () => clock.t });
  const raw = () => storage.getItem(STORED);
  const record = () => (raw() === null ? null : JSON.parse(raw()));
  const entry = (grant) => record()?.grants.find((e) => e.grant === grant);
  return { storage, store, clock, creds, raw, record, entry };
}
/** Enroll + confirm (the backend accepted the grant). */
async function active(h, access = ACCESS, G = 1) {
  const { grant } = await h.creds.beginEnroll(access);
  assert.equal(await h.creds.settleEnroll(grant, 'ok', G), true);
  return grant;
}
/** An enrollment attempt whose outcome is unknown (lost response). */
async function unknownCandidate(h, access = ACCESS) {
  const { grant } = await h.creds.beginEnroll(access);
  assert.equal(await h.creds.settleEnroll(grant, 'unknown'), true);
  return grant;
}

test('fingerprints: deterministic 16 hex chars; access, endpoint and grant fingerprints differ', async () => {
  assert.match(BIND, /^[0-9a-f]{16}$/);
  assert.equal(accessFingerprint(ENDPOINT, TOKEN), BIND);
  assert.notEqual(accessFingerprint(ENDPOINT, OTHER_TOKEN), BIND);
  assert.notEqual(accessFingerprint(ENDPOINT, null), BIND);
  assert.match(EP, /^[0-9a-f]{16}$/);
  assert.notEqual(endpointFingerprint(`${ENDPOINT}x`), EP);
  assert.notEqual(EP, BIND);
  assert.match(grantFingerprint('A'.repeat(43)), /^[0-9a-f]{16}$/);
  assert.equal(BIND.includes(TOKEN), false);
});

test('enroll: the candidate is persisted as inflight BEFORE the grant is returned; 32 random bytes, base64url', async () => {
  const h = setup();
  const begun = await h.creds.beginEnroll(ACCESS);
  assert.match(begun.grant, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(h.record(), { v: 1, phase: 'none', grants: [
    { grant: begun.grant, ep: EP, bind: BIND, at: T0, role: 'candidate', G: null, unknown: false, inflight: true },
  ] });
  assert.equal(h.creds.activeGrant(ACCESS), null, 'never a candidate');
  assert.equal(h.raw().includes(TOKEN), false, 'the token is not copied into the record');
});

test('enroll: storage write failure returns an error (nothing may be sent)', async () => {
  const h = setup();
  h.storage.faults.set = true;
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage' });
  assert.equal(h.raw(), null);
  h.storage.faults.set = false;
  const working = await active(h);
  h.storage.faults.set = true;
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage' });
  assert.equal(h.creds.activeGrant(ACCESS), working, 'the active grant is untouched');
});

test('outcomes: ok activates (the previous active grant is superseded); refused removes a never-unknown candidate', async () => {
  const h = setup();
  const first = await active(h);
  assert.deepEqual([h.record().phase, h.entry(first).role, h.entry(first).G], ['active', 'active', 1]);
  const { grant: wrong } = await h.creds.beginEnroll(ACCESS);
  assert.equal(h.creds.activeGrant(ACCESS), first, 'the working grant stays in use during a re-enrollment');
  assert.equal(await h.creds.settleEnroll(wrong, 'refused'), true);
  assert.equal(h.entry(wrong), undefined, 'refused and never unknown: removed');
  assert.equal(h.creds.activeGrant(ACCESS), first, 'a failed enrollment never touches the active entry');
  const second = (await h.creds.beginEnroll(ACCESS)).grant;
  assert.equal(await h.creds.settleEnroll(second, 'ok', 2), true);
  assert.deepEqual(h.record().grants.map((e) => [e.grant, e.role, e.G]), [[second, 'active', 2]], 'one live grant on the backend');
});

test('item 1: an unknown candidate is never dropped by a later definitive refusal; only an explicit same-code reuse re-sends it', async () => {
  const h = setup();
  const working = await active(h);
  const candidate = await unknownCandidate(h);
  assert.deepEqual([h.entry(candidate).unknown, h.entry(candidate).inflight], [true, false]);
  h.clock.t += 60 * 60000;
  const fresh = await h.creds.beginEnroll(ACCESS);
  assert.notEqual(fresh.grant, candidate, 'no reuse without the caller\'s same-code marker (one grant <-> one code)');
  await h.creds.settleEnroll(fresh.grant, 'refused');
  const retry = await h.creds.beginEnroll(ACCESS, { reuse: candidate });
  assert.equal(retry.grant, candidate, 'same code in this session: the same grant (idempotent on the backend)');
  assert.deepEqual([h.entry(candidate).at, h.entry(candidate).inflight], [h.clock.t, true], 'at = latest send attempt');
  assert.equal(await h.creds.settleEnroll(candidate, 'refused'), true);
  assert.deepEqual([h.entry(candidate).unknown, h.entry(candidate).inflight], [true, false], 'kept: an earlier attempt may have activated it');
  assert.equal(h.creds.activeGrant(ACCESS), working);
  assert.notEqual(await h.creds.beginEnroll(ACCESS, { reuse: 'B'.repeat(43) }).grant, 'B'.repeat(43), 'an unknown reuse target is ignored');
});

test('item 1: an inflight flag left by a closed app keeps the grant potentially live (pending deletion on sign-out)', async () => {
  const storage = memoryStorage();
  const h = setup(storage);
  await h.creds.beginEnroll(ACCESS);
  const restarted = createCrewCredentials({ store: createStore(storage), random: seqRandom(9), now: () => T0 });
  assert.equal(restarted.read().grants[0].inflight, true, 'kept as written: no outcome was ever observed');
  assert.equal(await restarted.dropAccess(), true);
  assert.equal(restarted.read().phase, 'revoking', 'potentially live: kept for deletion, never discarded');
});

test('item 1: at most CREW_MAX_CANDIDATES candidates; further enrollments are refused locally, none dropped', async () => {
  const h = setup();
  const keep = [];
  for (let i = 0; i < CREW_MAX_CANDIDATES; i += 1) {
    const { grant } = await h.creds.beginEnroll(ACCESS);
    keep.push(grant);
    // Retries reuse an unknown candidate of the same endpoint; distinct candidates are simulated by giving
    // each one another endpoint fingerprint.
    const r = h.record();
    h.storage.setItem(STORED, JSON.stringify({ ...r, grants: r.grants.map((e) => (e.grant === grant ? { ...e, inflight: false, unknown: true, ep: endpointFingerprint(`${ENDPOINT}#${i}`) } : e)) }));
  }
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'candidate-limit' });
  assert.deepEqual(h.record().grants.map((e) => e.grant), keep);
});

test('deletion: beginRevoke covers the active grant and every candidate, persisted with a revokeId each; idempotent', async () => {
  const h = setup();
  const working = await active(h);
  const candidate = await unknownCandidate(h);
  const r = await h.creds.beginRevoke();
  assert.equal(r.phase, 'revoking');
  assert.deepEqual(h.record().grants.map((e) => e.grant).sort(), [working, candidate].sort());
  assert.ok(h.record().grants.every((e) => /^[A-Za-z0-9_-]{22}$/.test(e.revokeId)));
  assert.deepEqual(await h.creds.beginRevoke(), h.record(), 'idempotent');
  assert.deepEqual(h.creds.pendingRevoke(), { unresolved: 2, endpoints: [EP] });
  assert.equal(h.creds.activeGrant(ACCESS), null, 'nothing is handed out while revoking');
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'revoke-pending' });
  assert.equal(await h.creds.dropAccess(), true);
  assert.equal(await h.creds.reconcile(OTHER), true);
  assert.equal(h.record().phase, 'revoking', 'survives sign-out and token changes');
  assert.equal(await h.creds.resolveEntry(working, 'deleted'), true);
  assert.equal(await h.creds.completeRevoke(), null, 'one entry still unresolved');
  assert.equal(await h.creds.resolveEntry(candidate, 'dead'), true);
  assert.equal(await h.creds.completeRevoke(), 'deleted');
  assert.equal(h.raw(), null);
  const s = setup();
  const only = await unknownCandidate(s);
  await s.creds.beginRevoke();
  await s.creds.resolveEntry(only, 'dead');
  assert.equal(await s.creds.completeRevoke(), 'superseded', 'all proven dead, none confirmed deleted');
});

test('deletion: storage write failure returns null and leaves the record as it was', async () => {
  const h = setup();
  assert.equal(await h.creds.beginRevoke(), null);
  await active(h);
  const before = h.raw();
  h.storage.faults.set = true;
  assert.equal(await h.creds.beginRevoke(), null);
  assert.equal(h.raw(), before);
});

test('sign-out / token change: a plain confirmed grant is removed; an unresolved candidate becomes a pending deletion', async () => {
  const plain = setup();
  await active(plain);
  assert.equal(await plain.creds.dropAccess(), true);
  assert.equal(plain.raw(), null, 'owner rule: the stored grant is removed on sign-out');
  const tokenChange = setup();
  await active(tokenChange);
  assert.equal(await tokenChange.creds.reconcile(ACCESS), true);
  assert.notEqual(tokenChange.raw(), null, 'same access: kept');
  assert.equal(await reconcileCrewAccess(tokenChange.store, OTHER), true);
  assert.equal(tokenChange.raw(), null, 'other access: removed');
  const withCandidate = setup();
  const working = await active(withCandidate);
  const candidate = await unknownCandidate(withCandidate);
  assert.equal(await dropCrewAccess(withCandidate.store), true);
  assert.equal(withCandidate.record().phase, 'revoking', 'potentially live: kept for deletion, never discarded');
  assert.deepEqual(withCandidate.record().grants.map((e) => e.grant).sort(), [working, candidate].sort());
  const changed = setup();
  await unknownCandidate(changed);
  assert.equal(await changed.creds.reconcile(OTHER), true);
  assert.equal(changed.record().phase, 'revoking', 'access mismatch with an unknown candidate: pending deletion');
  const empty = setup();
  assert.equal(await dropCrewAccess(empty.store), true, 'nothing to remove is success');
});

test('item 6: records of another version are never trusted, sent, overwritten or deleted', async () => {
  const foreignValues = [
    JSON.stringify({ v: 2, phase: 'active', grants: [] }),
    JSON.stringify({ v: 0 }),
    JSON.stringify({ v: '1', anything: true }),
  ];
  for (const value of foreignValues) {
    const h = setup();
    h.storage.setItem(STORED, value);
    assert.equal(h.creds.status(), 'foreign', value);
    assert.equal(h.creds.read(), null);
    assert.equal(h.creds.activeGrant(ACCESS), null);
    assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'credential-unsupported' });
    assert.equal(await h.creds.beginRevoke(), null);
    assert.equal(h.creds.pendingRevoke(), null);
    assert.equal(await h.creds.dropAccess(), true);
    assert.equal(await h.creds.reconcile(OTHER), true);
    assert.equal(await dropCrewAccess(h.store), true);
    assert.equal(h.raw(), value, 'untouched');
  }
});

test('item 6: a malformed v1 record that may hold deletion state is preserved as foreign; other malformed v1 records are removed', async () => {
  const grant = 'A'.repeat(43);
  const keep = [
    JSON.stringify({ v: 1, phase: 'revoking', grants: [{ grant, ep: EP, bind: BIND, at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }),
    JSON.stringify({ v: 1, phase: 'none', grants: [{ grant: 'short' }] }),
    JSON.stringify({ v: 1, state: 'revoking', grant, revokeId: 'x' }),
  ];
  for (const value of keep) {
    const h = setup();
    h.storage.setItem(STORED, value);
    assert.equal(h.creds.status(), 'foreign', value);
    assert.equal(await h.creds.dropAccess(), true);
    assert.equal(h.raw(), value, `preserved: ${value}`);
  }
  const remove = [
    'not json',
    JSON.stringify({ v: 1, state: 'active', grant, G: 1 }),
    JSON.stringify({ v: 1, phase: 'active' }),
    JSON.stringify([1]),
    JSON.stringify(null),
  ];
  for (const value of remove) {
    const h = setup();
    h.storage.setItem(STORED, value);
    assert.equal(h.creds.read(), null, value);
    assert.equal(h.creds.status(), 'none');
    assert.equal(h.raw(), value, 'reads never write (batch 7): cleanup happens only in a locked mutation');
    assert.equal(await h.creds.dropAccess(), true);
    assert.equal(h.raw(), null, `removed: ${value}`);
  }
  // Valid records with names, codes or unknown keys are malformed (removed when not deletion-like).
  const named = setup();
  named.storage.setItem(STORED, JSON.stringify({ v: 1, phase: 'none', grants: [], family: 'SAMPLE' }));
  assert.equal(named.creds.status(), 'foreign', 'a grants array: may hold deletion state, preserved');
  const ok = setup();
  ok.storage.setItem(STORED, JSON.stringify({ v: 1, phase: 'active', grants: [{ grant, ep: EP, bind: BIND, at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }));
  assert.equal(ok.creds.activeGrant(ACCESS), grant);
});

// --- Controller wiring ------------------------------------------------------------------------------------

function controllerWith(storage) {
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  const api = {
    fetchStats: async () => { throw new ApiError('network', 'offline'); },
    postContract: async () => { throw new ApiError('network', 'offline'); },
  };
  const c = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  const creds = createCrewCredentials({ store, random: seqRandom(7), now: () => T0 });
  const activate = async () => { const { grant } = await creds.beginEnroll(ACCESS); await creds.settleEnroll(grant, 'ok', 1); return grant; };
  return { store, c, creds, activate };
}

test('controller: sign-out drops a plain active crew grant', async () => {
  const storage = memoryStorage();
  const { c, activate } = controllerWith(storage);
  await activate();
  assert.equal(c.removeToken(), true);
  await flush();   // the crew drop is an async locked mutation
  assert.equal(storage.getItem(STORED), null);
});

test('item 6: sign-out keeps a pending deletion record; reset removes it (cannot be resumed from this device)', async () => {
  const signOut = controllerWith(memoryStorage());
  await signOut.activate();
  await signOut.creds.beginRevoke();
  const before = signOut.creds.read();
  assert.equal(signOut.c.removeToken(), true, 'keeping the pending deletion is not a storage failure');
  await flush();   // the crew drop is an async locked mutation
  assert.deepEqual(signOut.creds.read(), before, 'sign-out: resumable');
  const storage = memoryStorage();
  const reset = controllerWith(storage);
  await reset.activate();
  await reset.creds.beginRevoke();
  assert.equal(reset.c.resetLocalData(), true);
  await flush();   // the crew drop is an async locked mutation
  assert.equal(reset.creds.pendingRevoke(), null, 'reset: the pending deletion record is gone');
  assert.equal(storage.getItem(STORED), null);
});

test('controller: reset is the only path that removes a foreign record', async () => {
  const storage = memoryStorage();
  const h = controllerWith(storage);
  const value = JSON.stringify({ v: 9, opaque: true });
  storage.setItem(STORED, value);
  assert.equal(h.c.removeToken(), true);
  await flush();   // the crew drop is an async locked mutation
  assert.equal(storage.getItem(STORED), value, 'sign-out leaves it');
  h.store.set(TOKEN_KEY, OTHER_TOKEN);
  h.c.forgetContractData();
  await flush();   // the crew reconcile is an async locked mutation
  h.c.accessChanged();
  await flush();   // the crew reconcile is an async locked mutation
  assert.equal(storage.getItem(STORED), value, 'token changes leave it');
  assert.equal(h.c.resetLocalData(), true);
  await flush();   // the crew drop is an async locked mutation
  assert.equal(storage.getItem(STORED), null);
});

test('controller: a token change (forgetContractData / accessChanged) removes a plain grant bound to the old access', async () => {
  const storage = memoryStorage();
  const { store, c, activate } = controllerWith(storage);
  await activate();
  c.forgetContractData();
  await flush();   // the crew reconcile is an async locked mutation
  assert.notEqual(storage.getItem(STORED), null, 'same access: the grant stays');
  store.set(TOKEN_KEY, OTHER_TOKEN);
  c.forgetContractData();
  await flush();   // the crew reconcile is an async locked mutation
  assert.equal(storage.getItem(STORED), null, 'new token: the old grant is removed');

  const other = controllerWith(memoryStorage());
  await other.activate();
  other.store.set(TOKEN_KEY, OTHER_TOKEN);   // e.g. changed in another tab
  other.c.accessChanged();
  await flush();   // the crew reconcile is an async locked mutation
  assert.equal(other.creds.read(), null);
  const third = controllerWith(memoryStorage());
  await third.activate();
  await third.creds.beginRevoke();
  const pending = third.creds.read();
  third.store.set(TOKEN_KEY, OTHER_TOKEN);
  third.c.forgetContractData();
  await flush();   // the crew reconcile is an async locked mutation
  third.c.accessChanged();
  await flush();   // the crew reconcile is an async locked mutation
  assert.deepEqual(third.creds.read(), pending, 'a pending deletion is never removed by an access change');
});

// --- Correction batch 5: uncertainty is folded and never erased ---------------------------------------------

test('batch 5: reusing a grant folds an unsettled earlier attempt (inflight) into unknown in the same write', async () => {
  const h = setup();
  const { grant } = await h.creds.beginEnroll(ACCESS);              // attempt 1: its settle write never happened
  assert.deepEqual([h.entry(grant).inflight, h.entry(grant).unknown], [true, false]);
  assert.equal((await h.creds.beginEnroll(ACCESS, { reuse: grant })).grant, grant);
  assert.deepEqual([h.entry(grant).inflight, h.entry(grant).unknown], [true, true], 'folded and persisted with the new attempt');
  assert.equal(await h.creds.settleEnroll(grant, 'refused'), true);
  assert.deepEqual([h.entry(grant).inflight, h.entry(grant).unknown], [false, true], 'a later refusal cannot erase it');
});

test('batch 5/7: a mutation computes from the read taken inside the lock: a fold made meanwhile by another holder survives a refusal', async () => {
  const h = setup();
  const { grant } = await h.creds.beginEnroll(ACCESS);
  let settling = null;
  await navigator.locks.request(CREW_CREDENTIAL_LOCK, async () => {
    settling = h.creds.settleEnroll(grant, 'refused');   // must wait for the lock
    await flush();
    assert.equal(h.entry(grant).inflight, true, 'nothing written while another holder has the lock');
    // The other holder (e.g. another tab) folds the unsettled attempt into unknown.
    h.storage.setItem(STORED, JSON.stringify({ ...h.record(), grants: h.record().grants.map((e) => ({ ...e, inflight: false, unknown: true })) }));
  });
  assert.equal(await settling, true);
  assert.deepEqual([h.entry(grant).unknown, h.entry(grant).inflight], [true, false], 'computed from the fresh read: kept');
});

test('batch 5: foldInflight is one verified write; it fails closed and never touches a foreign record', async () => {
  const h = setup();
  const { grant } = await h.creds.beginEnroll(ACCESS);
  h.storage.faults.set = true;
  assert.equal(await h.creds.foldInflight(), false, 'write failure is reported');
  assert.equal(h.entry(grant).inflight, true, 'nothing lost');
  h.storage.faults.set = false;
  assert.equal(await h.creds.foldInflight(), true);
  assert.deepEqual([h.entry(grant).inflight, h.entry(grant).unknown], [false, true]);
  const empty = setup();
  assert.equal(await empty.creds.foldInflight(), true, 'nothing of ours to keep');
  const foreign = setup();
  const value = JSON.stringify({ v: 7 });
  foreign.storage.setItem(STORED, value);
  assert.equal(await foreign.creds.foldInflight(), true);
  assert.equal(foreign.raw(), value);
});

test('batch 5: the guard allows only evidence-backed transitions (plain confirmed grant on sign-out, resolveEntry)', async () => {
  const h = setup();
  await active(h);
  assert.equal(await h.creds.dropAccess(), true);
  assert.equal(h.raw(), null, 'owner rule: a plain confirmed grant may go');
  const r = setup();
  const g = await unknownCandidate(r);
  await r.creds.beginRevoke();
  assert.equal(await r.creds.completeRevoke(), null, 'unresolved: never removed');
  assert.notEqual(r.raw(), null);
  assert.equal(await r.creds.resolveEntry(g, 'deleted'), true, 'backend evidence');
  assert.equal(await r.creds.completeRevoke(), 'deleted');
});

// --- Correction batch 6: unreadable storage ----------------------------------------------------------------

test('batch 6: an unreadable record is never treated as absent; every method refuses without writing', async () => {
  const h = setup();
  await active(h);
  await unknownCandidate(h);
  const before = h.storage.map.get(STORED);
  h.storage.faults.get = (k) => { if (k === STORED) throw new Error('SecurityError'); return undefined; };
  assert.equal(h.creds.status(), 'unreadable');
  assert.equal(h.creds.read(), null);
  assert.deepEqual(h.creds.state(), { kind: 'unreadable', record: null, malformed: false });
  assert.equal(h.creds.activeGrant(ACCESS), null);
  assert.equal(h.creds.activeGrant(OTHER), null);
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage-unreadable' });
  assert.equal(await h.creds.settleEnroll('A'.repeat(43), 'refused'), false);
  assert.equal(await h.creds.confirmEnroll(ACCESS, 2), false);
  assert.equal(await h.creds.beginRevoke(), null);
  assert.equal(h.creds.pendingRevoke(), null);
  assert.equal(await h.creds.resolveEntry('A'.repeat(43), 'deleted'), false);
  assert.equal(await h.creds.completeRevoke(), null);
  assert.equal(await h.creds.foldInflight(), false);
  assert.equal(await h.creds.dropAccess(), false);
  assert.equal(await h.creds.reconcile(OTHER), false);
  assert.equal(await dropCrewAccess(h.store), false);
  assert.equal(await reconcileCrewAccess(h.store, OTHER), false);
  assert.equal(h.storage.map.get(STORED), before, 'never removed or overwritten');
  h.storage.faults.get = null;
  assert.equal(h.creds.status(), 'ok');
});

test('batch 6: a malformed record is not cleaned up while unreadable; no backend at all is unreadable', async () => {
  const h = setup();
  h.storage.map.set(STORED, 'not json');
  h.storage.faults.get = (k) => { if (k === STORED) throw new Error('blocked'); return undefined; };
  assert.equal(h.creds.status(), 'unreadable');
  assert.equal(h.storage.map.get(STORED), 'not json');
  h.storage.faults.get = null;
  assert.equal(h.creds.status(), 'none', 'readable: the malformed record is cleaned up as before');
  const noBackend = createCrewCredentials({ store: { getChecked: () => ({ ok: false }) } });
  assert.equal(noBackend.status(), 'unreadable');
  assert.deepEqual(await noBackend.beginEnroll(ACCESS), { error: 'storage-unreadable' });
});

test('batch 6: a write whose read-back cannot be read counts as failed', async () => {
  const h = setup();
  let reads = 0;
  h.storage.faults.get = (k) => { if (k === STORED && ++reads > 2) throw new Error('blocked'); return undefined; };
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage-unreadable' }, 'the failed read-back is reported as unreadable storage');
});

// --- Correction batch 7: locked mutations ---------------------------------------------------------------------

test('batch 7: reads never write (malformed record, bind mismatch); only locked mutations change the record', async () => {
  const h = setup();
  h.storage.setItem(STORED, 'not json');
  assert.equal(h.creds.read(), null);
  assert.equal(h.creds.status(), 'none');
  assert.equal(h.raw(), 'not json');
  const m = setup();
  await active(m);
  const before = m.raw();
  assert.equal(m.creds.activeGrant(OTHER), null);
  assert.equal(m.raw(), before, 'a mismatching access is handled by reconcile, not by a read');
});

test('batch 7: out-of-order confirmations are ordered by the backend generation G (lower G never replaces higher)', async () => {
  const h = setup();
  const x = (await h.creds.beginEnroll(ACCESS)).grant;
  const y = (await h.creds.beginEnroll(ACCESS)).grant;
  assert.equal(await h.creds.settleEnroll(y, 'ok', 2), true);           // y confirmed first (backend G 2)
  assert.equal(await h.creds.settleEnroll(x, 'ok', 1), true);           // x's older confirmation arrives late
  assert.deepEqual(h.record().grants.map((e) => [e.grant, e.role, e.G]), [[y, 'active', 2]], 'x was replaced on the backend: removed');
  const r = setup();
  const x2 = (await r.creds.beginEnroll(ACCESS)).grant;
  const y2 = (await r.creds.beginEnroll(ACCESS)).grant;
  await r.creds.settleEnroll(x2, 'ok', 1);
  await r.creds.settleEnroll(y2, 'ok', 2);
  assert.deepEqual(r.record().grants.map((e) => [e.grant, e.role, e.G]), [[y2, 'active', 2]], 'in order: the lower G is dropped');
  const d = setup();
  const x3 = (await d.creds.beginEnroll(ACCESS)).grant;
  const y3 = (await d.creds.beginEnroll(ACCESS)).grant;
  await d.creds.settleEnroll(y3, 'ok', 2);
  await d.creds.beginRevoke();
  await d.creds.settleEnroll(x3, 'ok', 1);
  assert.deepEqual(d.record().grants.map((e) => [e.grant, e.role]).sort(), [[x3, 'active'], [y3, 'active']].sort(), 'inside a deletion both stay to be revoked');
});

test('batch 7: two tabs (instances) on one store: enrollment after another tab began a deletion is refused', async () => {
  const storage = memoryStorage();
  const a = createCrewCredentials({ store: createStore(storage), random: seqRandom(1), now: () => T0 });
  const b = createCrewCredentials({ store: createStore(storage), random: seqRandom(2), now: () => T0 });
  const { grant } = await a.beginEnroll(ACCESS);
  await a.settleEnroll(grant, 'ok', 1);
  assert.ok(await a.beginRevoke());
  assert.deepEqual(await b.beginEnroll(ACCESS), { error: 'revoke-pending' });
});

test('batch 7: completeRevoke re-reads under the lock: an unresolved entry written meanwhile keeps the deletion pending', async () => {
  const h = setup();
  const g = await active(h);
  await h.creds.beginRevoke();
  await h.creds.resolveEntry(g, 'deleted');
  let completing = null;
  await navigator.locks.request(CREW_CREDENTIAL_LOCK, async () => {
    completing = h.creds.completeRevoke();                                // queued behind this holder
    await flush();
    const rec = h.record();                                               // another tab adds a still unresolved entry
    const extra = { ...rec.grants[0], grant: 'C'.repeat(43), revokeId: 'D'.repeat(22), role: 'candidate', G: null, unknown: true, inflight: false };
    delete extra.resolved;
    h.storage.setItem(STORED, JSON.stringify({ ...rec, grants: [...rec.grants, extra] }));
  });
  assert.equal(await completing, null, 'still pending');
  assert.equal(h.record().grants.length, 2, 'the newer entry is never removed');
});

test('batch 7: a storage write or read failure while holding the lock fails closed and releases the lock; recovery works', async () => {
  const h = setup();
  h.storage.faults.set = true;
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage' });
  assert.deepEqual((await navigator.locks.query()).held.filter((l) => l.name === CREW_CREDENTIAL_LOCK), [], 'released');
  h.storage.faults.set = false;
  assert.match((await h.creds.beginEnroll(ACCESS)).grant, /^[A-Za-z0-9_-]{43}$/);
  h.storage.faults.get = (k) => { if (k === STORED) throw new Error('blocked'); return undefined; };
  assert.deepEqual(await h.creds.beginEnroll(ACCESS), { error: 'storage-unreadable' });
  assert.equal(await h.creds.foldInflight(), false);
  assert.deepEqual((await navigator.locks.query()).held.filter((l) => l.name === CREW_CREDENTIAL_LOCK), [], 'released');
  h.storage.faults.get = null;
  assert.equal(await h.creds.foldInflight(), true);
  assert.equal(h.record().grants[0].unknown, true);
});

test('batch 7: without a usable lock every mutation refuses with lock-unavailable and writes nothing', async () => {
  for (const locks of [null, { request: () => Promise.reject(new Error('x')) }, { request: () => { throw new Error('x'); } }]) {
    const h = setup();
    await active(h);
    const before = h.raw();
    const c = createCrewCredentials({ store: h.store, random: seqRandom(5), now: () => T0, locks });
    assert.deepEqual(await c.detailed.beginEnroll(ACCESS), { ok: false, value: null, error: 'lock-unavailable' });
    assert.deepEqual(await c.beginEnroll(ACCESS), { error: 'lock-unavailable' });
    assert.equal(await c.settleEnroll('A'.repeat(43), 'refused'), false);
    assert.equal(await c.beginRevoke(), null);
    assert.equal(await c.resolveEntry('A'.repeat(43), 'deleted'), false);
    assert.equal(await c.completeRevoke(), null);
    assert.equal(await c.foldInflight(), false);
    assert.equal(await c.dropAccess(), false, 'a record is present: sign-out cannot coordinate (fail closed)');
    assert.equal(await c.reconcile(OTHER), false);
    assert.equal(h.raw(), before, 'never an uncoordinated write');
    const empty = createCrewCredentials({ store: createStore(memoryStorage()), locks });
    assert.equal(await empty.dropAccess(), true, 'no record: nothing to coordinate');
    assert.equal(await empty.reconcile(OTHER), true);
    assert.equal(await empty.foldInflight(), true);
  }
});

// --- Correction batch 8: sign-out crew cleanup is reported explicitly --------------------------------------

test('batch 8: sign-out with no crew record reports crew cleanup done immediately (ordinary sign-out unchanged)', async () => {
  const storage = memoryStorage();
  const { c } = controllerWith(storage);
  assert.equal(c.view().crewCleanup, null);
  assert.equal(c.removeToken(), true);
  assert.equal(c.view().crewCleanup, 'done');
  assert.equal(await c.crewCleanup(), 'done');
});

test('batch 8: sign-out while the credential lock is held: true at once, crew cleanup pending, then done', async () => {
  const storage = memoryStorage();
  const { c, activate } = controllerWith(storage);
  await activate();
  let release;
  const released = new Promise((r) => { release = r; });
  let markHeld;
  const held = new Promise((r) => { markHeld = r; });
  const holder = navigator.locks.request(CREW_CREDENTIAL_LOCK, () => { markHeld(); return released; });
  await held;
  assert.equal(c.removeToken(), true, 'the local sign-out itself succeeded');
  assert.equal(c.view().crewCleanup, 'pending');
  assert.notEqual(storage.getItem(STORED), null);
  release();
  await holder;
  assert.equal(await c.crewCleanup(), 'done');
  assert.equal(c.view().crewCleanup, 'done');
  assert.equal(c.view().storageError, false);
  assert.equal(storage.getItem(STORED), null);
});

test('batch 8: a crew cleanup that cannot coordinate reports incomplete + storageError and keeps the record', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
  try {
    const storage = memoryStorage();
    const { c } = controllerWith(storage);
    storage.setItem(STORED, JSON.stringify({ v: 1, phase: 'active', grants: [{ grant: 'A'.repeat(43), ep: EP, bind: BIND, at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }));
    const before = storage.getItem(STORED);
    assert.equal(c.removeToken(), true);
    assert.equal(await c.crewCleanup(), 'incomplete');
    assert.equal(c.view().crewCleanup, 'incomplete');
    assert.equal(c.view().storageError, true);
    assert.equal(storage.getItem(STORED), before, 'never discarded');
  } finally {
    Object.defineProperty(globalThis, 'navigator', saved);
  }
});

test('batch 8: a late crew cleanup failure after a new token save does not mark the new session', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let release;
  const released = new Promise((r) => { release = r; });
  const fakeLocks = { request: (name, opts, cb) => released.then(() => { throw new Error('denied'); }) };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, locks: fakeLocks }, configurable: true, writable: true });
  try {
    const storage = memoryStorage();
    const { c, store } = controllerWith(storage);
    storage.setItem(STORED, JSON.stringify({ v: 1, phase: 'active', grants: [{ grant: 'A'.repeat(43), ep: EP, bind: BIND, at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }));
    assert.equal(c.removeToken(), true);
    assert.equal(c.view().crewCleanup, 'pending');
    const stale = c.crewCleanup();
    store.set(TOKEN_KEY, OTHER_TOKEN);                       // the user signs in again
    c.forgetContractData();
    assert.equal(c.view().crewCleanup, null);
    release();                                               // the earlier cleanup fails late
    assert.equal(await stale, 'incomplete', 'the earlier sign-out learns its own result');
    await flush();
    assert.equal(c.view().storageError, false, 'the new session is not marked');
    assert.equal(c.view().crewCleanup, null);
  } finally {
    Object.defineProperty(globalThis, 'navigator', saved);
  }
});
