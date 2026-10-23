// Phase 1d.2A: enrollment cancellation via grant tombstones (CrewCoreV2.gs / CrewApiV2.gs §8.7), receipts bound to
// their grant, the capability-gated frontend trust (limits.crewCancel = 1), and the editor-only crewPurgeAll (§8.3).
// Real .gs handlers (simulatedCrewBackend), real Node Web Locks for the frontend credential record. Synthetic only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createCrewCredentials, CREW_CREDENTIAL_KEY } from '../src/sources/crew-credential.js';
import { createCrewService, purgeCrewMemory, __resetCrewStateForTests } from '../src/sources/crew-service.js';
import { createCrewRuntime, crewCancelSupported, crewSupportedBy } from '../src/crew-runtime.js';
import { ApiError } from '../src/api/appscript.js';
import { loadGs, fakeEnv } from './gs-harness.js';
import { memoryStorage, simulatedCrewBackend, flush, TOKEN, ENDPOINT, T0 } from './fixtures/crew-frontend.synthetic.mjs';

const STORED = `fc.v2.${CREW_CREDENTIAL_KEY}`;
const CODE = 'SYNTHETIC-CANCEL-CODE-0123';
const plain = (x) => JSON.parse(JSON.stringify(x));
let day = 0;

beforeEach(() => { __resetCrewStateForTests(); purgeCrewMemory(); });

/** Backend + one frontend tab (credentials over a memory store, real Web Locks, service with or without the capability). */
async function setup({ cancel = true, legacyRevoke = false, limits } = {}) {
  day += 1;
  const clock = { t: T0 + day * 86400000 };
  const sim = await simulatedCrewBackend({ now: () => clock.t, legacyRevoke, limits });
  const storage = memoryStorage();
  const store = createStore(storage);
  const held = [];
  const plan = {};
  const post = async (endpoint, body) => {
    const step = plan[body.action]?.shift();
    if (step === 'hold') { held.push(body); throw new ApiError('timeout', 'held'); }   // still in transit
    if (step === 'lose') { sim.handle(body); throw new ApiError('network', 'lost'); }  // processed, answer lost
    return { data: sim.handle(body) };
  };
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId: `c${day}` };
  const credentials = createCrewCredentials({ store, now: () => clock.t });
  const svc = createCrewService({ credentials, access: () => access, post, now: () => clock.t, sleep: async () => {}, isVisible: () => true, isOnline: () => true, cancelSupported: () => cancel });
  const deliver = () => held.splice(0).map((b) => sim.handle(b));
  return { clock, sim, storage, store, credentials, svc, plan, held, deliver, access, post };
}
const revoke = (sim, grant, revokeId) => sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewRevoke', grant, revokeId });
const enrollRaw = (sim, grant, code = CODE) => sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewEnroll', grant, code });
const crewIndex = (sim, grant) => sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewIndex', grant });

/** No false deletion: backend active => never deleted/superseded/nothing and the record kept. */
async function deletion(h, promise) {
  const r = await promise;
  if (h.sim.phase() === 'active') {
    assert.equal(['deleted', 'superseded', 'nothing'].includes(r.status), false, `reported ${r.status} while the backend is active`);
    assert.ok(h.storage.map.has(STORED), 'record removed while the backend is active');
  }
  return r;
}

// --- Backend semantics ------------------------------------------------------------------------------------

test('cancel before a held enrollment executes: tombstone; the late enrollment is refused; the backend never becomes active', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  h.plan.crewEnroll = ['hold'];
  await assert.rejects(h.svc.enroll(CODE), (e) => e.code === 'timeout');
  const r = await deletion(h, h.svc.revoke());
  assert.deepEqual(r, { status: 'superseded' }, 'resolved as cancelled: never a deletion claim');
  assert.equal(h.storage.getItem(STORED), null);
  const [late] = h.deliver();
  assert.deepEqual(late, { ok: false, error: 'enroll-closed' });
  assert.equal(h.sim.phase(), 'none', 'never active');
  assert.ok(h.sim.props.get('FC_CREW_ENROLL'), 'the outstanding code is untouched');
  assert.equal(h.sim.cache.has('fcv2-crew-enroll-failures'), false, 'no failure counted');
});

test('enrollment completed before the cancel arrives: the normal revoke deletes (not "cancelled")', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  h.plan.crewEnroll = ['lose'];
  await assert.rejects(h.svc.enroll(CODE), (e) => e.code === 'network');
  assert.equal(h.sim.phase(), 'active');
  const r = await deletion(h, h.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(h.sim.phase(), 'deleted');
  assert.deepEqual(h.sim.state().cancelled ?? [], [], 'no tombstone for a deleted live grant');
});

test('delayed enrollment after a cancel with the code still outstanding: refused; another grant can still use the code', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  const cancelled = revoke(h.sim, 'G1'.repeat(20), 'r-1');
  assert.deepEqual(cancelled, { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0 });
  const before = JSON.stringify(h.sim.state());
  assert.deepEqual(enrollRaw(h.sim, 'G1'.repeat(20)), { ok: false, error: 'enroll-closed' });
  assert.equal(JSON.stringify(h.sim.state()), before, 'refusal changes nothing');
  assert.ok(h.sim.props.get('FC_CREW_ENROLL'));
  assert.equal(enrollRaw(h.sim, 'G3'.repeat(20)).enrolled, true, 'a newer enrollment with the outstanding code succeeds');
  assert.equal(h.sim.phase(), 'active');
  assert.deepEqual(h.sim.state().cancelled, [h.sim.shortHash('G1'.repeat(20))], 'the tombstone survives the new enrollment');
});

test('repeated cancel is recorded and writes nothing', async () => {
  const h = await setup();
  revoke(h.sim, 'gx', 'r-1');
  const before = h.sim.props.get('FC_CREW_STATE');
  assert.deepEqual(revoke(h.sim, 'gx', 'r-2'), { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0, recorded: true });
  assert.equal(h.sim.props.get('FC_CREW_STATE'), before);
});

test('protects newer enrollments: cancelling g1 while g2 is active leaves g2, G, epoch, the index and the code untouched', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  assert.equal(enrollRaw(h.sim, 'g2').enrolled, true);
  assert.equal(crewIndex(h.sim, 'g2').ok, true);
  h.sim.issueCode('SECOND-SYNTHETIC-CODE-99');
  const st = h.sim.state();
  const fcx = Object.fromEntries(h.sim.crewKeys().map((k) => [k, h.sim.store.get(k)]));
  const code = h.sim.props.get('FC_CREW_ENROLL');
  assert.equal(revoke(h.sim, 'g1', 'r-g1').state, 'cancelled');
  const after = h.sim.state();
  assert.deepEqual({ ...after, cancelled: undefined }, { ...st, cancelled: undefined }, 'only the tombstone list differs');
  assert.deepEqual(after.cancelled, [h.sim.shortHash('g1')]);
  assert.deepEqual(Object.fromEntries(h.sim.crewKeys().map((k) => [k, h.sim.store.get(k)])), fcx, 'fcx.* untouched');
  assert.equal(h.sim.props.get('FC_CREW_ENROLL'), code);
  assert.equal(crewIndex(h.sim, 'g2').ok, true, 'g2 still authorized for crewIndex');
  assert.equal(h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crew', grant: 'g2', ...h.sim.query(1) }).ok, true, 'and for crew');
});

test('cancel while g2 is being revoked: the revocation of g2 is unaffected and completes', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  enrollRaw(h.sim, 'g2');
  crewIndex(h.sim, 'g2');
  h.sim.store.faults.del = () => true;
  assert.equal(revoke(h.sim, 'g2', 'r-g2').error, 'revoke-incomplete');
  assert.equal(h.sim.phase(), 'revoking');
  const revokingState = h.sim.state();
  assert.equal(revoke(h.sim, 'g1', 'r-g1').state, 'cancelled', 'another grant during the revocation: cancelled (was busy)');
  assert.deepEqual({ ...h.sim.state(), cancelled: undefined }, { ...revokingState, cancelled: undefined });
  h.sim.store.faults.del = null;
  assert.equal(revoke(h.sim, 'g2', 'r-g2').state, 'deleted');
  assert.equal(h.sim.phase(), 'deleted');
});

test('receipts are bound to their grant: revokeId R of g1 never confirms g2 (red on the old code: false "deleted")', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  enrollRaw(h.sim, 'g1');
  assert.equal(revoke(h.sim, 'g1', 'R').state, 'deleted');
  assert.deepEqual(revoke(h.sim, 'g1', 'R'), { ok: true, action: 'crewRevoke', state: 'deleted', deletedKeys: 0, recorded: true }, 'own receipt');
  h.sim.issueCode('SECOND-SYNTHETIC-CODE-99');
  assert.equal(enrollRaw(h.sim, 'g2', 'SECOND-SYNTHETIC-CODE-99').enrolled, true);
  const other = revoke(h.sim, 'g2', 'R');
  assert.notEqual(other.recorded, true, 'never the receipt of another grant');
  assert.equal(other.state, 'deleted', 'g2 itself was revoked by this request');
  assert.equal(h.sim.phase(), 'deleted');
});

test('tombstone write failure or lost write: not cancelled (crew-unavailable); the frontend stays pending, then completes', async () => {
  for (const fault of ['throw', 'lost']) {
    const h = await setup();
    h.sim.issueCode(CODE);
    h.plan.crewEnroll = ['hold'];
    await assert.rejects(h.svc.enroll(CODE));
    h.sim.faults.stateWrite = fault;
    const r = await deletion(h, h.svc.revoke());
    assert.deepEqual(r, { status: 'pending', code: 'crew-unavailable' }, fault);
    assert.ok(h.credentials.pendingRevoke());
    assert.equal(h.sim.state()?.cancelled, undefined, 'nothing recorded');
    h.sim.faults.stateWrite = null;
    assert.deepEqual(await deletion(h, h.svc.resumeRevoke()), { status: 'superseded' });
    assert.deepEqual(h.deliver(), [{ ok: false, error: 'enroll-closed' }]);
  }
});

test('lock contention -> busy, nothing changed; a full tombstone list -> busy (never falsely definitive)', async () => {
  const h = await setup();
  h.sim.faults.lockBusy = true;
  const before = h.sim.props.get('FC_CREW_STATE');
  assert.deepEqual(revoke(h.sim, 'gx', 'r-1'), { ok: false, error: 'busy' });
  assert.equal(h.sim.props.get('FC_CREW_STATE'), before);
  h.sim.faults.lockBusy = false;
  const full = { G: 0, phase: 'none', pid: null, epoch: null, grantHash: null, codeHash: null, enrolledAt: null, revoke: null, lastRevoke: null,
    cancelled: Array.from({ length: 64 }, (_, i) => String(i).padStart(32, '0').replace(/\d/g, (d) => 'abcdefghij'[d])) };
  h.sim.props.set('FC_CREW_STATE', JSON.stringify(full));
  assert.deepEqual(revoke(h.sim, 'gy', 'r-2'), { ok: false, error: 'busy' });
  assert.equal(JSON.parse(h.sim.props.get('FC_CREW_STATE')).cancelled.length, 64, 'no eviction');
});

// --- Capability negotiation and the frontend --------------------------------------------------------------

test('capability: crewCancel trusted only for exactly 1; the simulated backend advertises it while crew is enabled', async () => {
  const base = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history', 'crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] };
  assert.equal(crewCancelSupported({ ...base, limits: { crewCancel: 1 } }), true);
  for (const limits of [undefined, null, {}, { crewCancel: 2 }, { crewCancel: '1' }, { crewCancel: true }]) {
    assert.equal(crewCancelSupported({ ...base, limits }), false, JSON.stringify(limits));
  }
  assert.equal(crewCancelSupported({ ...base, actions: ['capabilities', 'crewIndex'], limits: { crewCancel: 1 } }), false, 'crewRevoke must be offered');
  for (const bad of [{ ok: false }, { version: 1 }, { contract: 'other' }, { actions: null }]) {
    assert.equal(crewCancelSupported({ ...base, ...bad, limits: { crewCancel: 1 } }), false, JSON.stringify(bad));
  }
  const h = await setup();
  const caps = h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'capabilities' });
  assert.equal(crewSupportedBy(caps) && crewCancelSupported(caps), true);
  h.sim.props.set('FC_CREW_ENABLED', 'off');
  const off = h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'capabilities' });
  assert.equal(crewSupportedBy(off), false, 'kill switch off: crew stays hidden');
  assert.equal(crewCancelSupported(off), true, 'kill switch off: cancellation still advertised (crewRevoke is never gated)');
  assert.deepEqual(plain(h.sim.gs.capabilities(h.sim.env)), { actions: ['crewRevoke'], limits: { crewCancel: 1 } });
});

test('capability {actions:[crewRevoke], limits:{crewCancel:1}} without the other crew actions: crew hidden, cancel trusted', () => {
  const caps = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history', 'crewRevoke'], limits: { crewCancel: 1 } };
  assert.equal(crewSupportedBy(caps), false);
  assert.equal(crewCancelSupported(caps), true);
});

test('without the capability a "cancelled" answer is never trusted: the deletion stays pending, nothing claimed', async () => {
  const h = await setup({ cancel: false });
  h.sim.issueCode(CODE);
  h.plan.crewEnroll = ['hold'];
  await assert.rejects(h.svc.enroll(CODE));
  const r = await deletion(h, h.svc.revoke());
  assert.deepEqual([r.status, r.code], ['pending', 'invalid-response']);
  assert.ok(h.credentials.pendingRevoke());
});

/** Runtime over a persisted pending deletion (browser restart): learns the capability, then resumes. */
async function restartWith({ limits, legacyRevoke }) {
  const h = await setup({ legacyRevoke, limits });
  h.sim.issueCode(CODE);
  h.plan.crewEnroll = ['hold'];
  await assert.rejects(h.svc.enroll(CODE));
  h.plan.crewRevoke = ['hold'];
  assert.equal((await h.svc.revoke()).status, 'pending');
  h.held.splice(h.held.findIndex((b) => b.action === 'crewRevoke'), 1);   // the revoke never arrived
  __resetCrewStateForTests();                                    // "browser restart"
  const bodies = [];
  const rt = createCrewRuntime({
    store: createStore(h.storage), access: () => h.access,
    post: async (ep, body) => { bodies.push(body.action); return { data: h.sim.handle(body) }; },
    credentials: createCrewCredentials({ store: createStore(h.storage), now: () => h.clock.t }),
    now: () => h.clock.t, isVisible: () => true, isOnline: () => true,
  });
  assert.equal(rt.enabled(), false, 'crew is off');
  const r = await rt.start();
  return { h, r, bodies };
}

test('browser restart with an unresolved deletion: with the capability the candidate is cancelled and the deletion completes', async () => {
  const { h, r, bodies } = await restartWith({});
  assert.deepEqual(bodies, ['capabilities', 'crewRevoke'], 'capability learned once although crew is off');
  assert.deepEqual(r, { status: 'superseded' });
  assert.equal(h.storage.getItem(STORED), null);
  assert.deepEqual(h.deliver(), [{ ok: false, error: 'enroll-closed' }]);
  assert.equal(h.sim.phase(), 'none');
});

test('browser restart without the capability (older backend): stays pending as unresolved-enrollment', async () => {
  const { h, r, bodies } = await restartWith({ limits: null, legacyRevoke: true });
  assert.deepEqual(bodies, ['capabilities', 'crewRevoke']);
  assert.deepEqual([r.status, r.code], ['pending', 'unresolved-enrollment']);
  assert.ok(h.credentials.pendingRevoke());
});

/** Backend kill switch off; a deletion left pending without a known capability; then a restart (crew off locally). */
async function killSwitchRestart(prepare) {
  const h = await setup({ cancel: false });
  await prepare(h);
  h.sim.props.set('FC_CREW_ENABLED', 'off');
  const first = await deletion(h, h.svc.revoke());
  assert.deepEqual([first.status, first.code], ['pending', 'invalid-response'], 'untrusted before the capability is known');
  __resetCrewStateForTests();
  const bodies = [];
  const rt = createCrewRuntime({
    store: createStore(h.storage), access: () => h.access,
    post: async (ep, body) => { bodies.push(body.action); return { data: h.sim.handle(body) }; },
    credentials: createCrewCredentials({ store: createStore(h.storage), now: () => h.clock.t }),
    now: () => h.clock.t, isVisible: () => true, isOnline: () => true,
  });
  assert.equal(rt.enabled(), false);
  const r = await deletion(h, rt.start());
  return { h, r, bodies, rt };
}

test('kill switch off + confirmed grant the backend no longer holds: capability learned while disabled, resolved dead, deletion completes', async () => {
  const { h, r, bodies, rt } = await killSwitchRestart(async (x) => {
    x.sim.issueCode(CODE);
    assert.deepEqual(await x.svc.enroll(CODE), { enrolled: true });
    for (let i = 0; i < 20; i += 1) await flush();               // let any follow-up of the enrollment settle first
    x.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
    assert.equal(x.sim.gs.purgeAll(x.sim.env).outcome, 'deleted');   // backend state: deleted (grant no longer live)
  });
  assert.deepEqual(bodies, ['capabilities', 'crewRevoke']);
  assert.notEqual(r.status, 'pending', JSON.stringify(r));
  assert.notEqual(r.status, 'deleted', 'never a deletion claim from a cancellation');
  assert.equal(h.storage.getItem(STORED), null);
  assert.equal((await rt.capability()).supported, false, 'crew stays hidden');
});

test('kill switch off + unresolved candidate: cancelled, deletion completes, the late enrollment is refused', async () => {
  const { h, r, bodies } = await killSwitchRestart(async (x) => {
    x.sim.issueCode(CODE);
    x.plan.crewEnroll = ['hold'];
    await assert.rejects(x.svc.enroll(CODE));
  });
  assert.deepEqual(bodies, ['capabilities', 'crewRevoke']);
  assert.deepEqual(r, { status: 'superseded' });
  assert.equal(h.storage.getItem(STORED), null);
  h.sim.props.set('FC_CREW_ENABLED', 'on');                       // even after the switch is back on
  assert.deepEqual(h.deliver(), [{ ok: false, error: 'enroll-closed' }]);
  assert.equal(h.sim.phase(), 'none');
});

// --- Editor-only purge --------------------------------------------------------------------------------------

async function purgeWorld() {
  const h = await setup();
  h.sim.issueCode(CODE);
  enrollRaw(h.sim, 'g-live');
  crewIndex(h.sim, 'g-live');
  revoke(h.sim, 'g-old', 'r-old');                               // a tombstone that must survive
  h.sim.issueCode('NEXT-SYNTHETIC-CODE-0000');
  h.sim.store.set('other.key', 'kept');
  return h;
}
const purge = (h) => plain(h.sim.gs.purgeAll(h.sim.env));
const SAFE = ['deletedKeys', 'outcome', 'remaining'];

test('purge: refused without the exact confirmation; nothing changes', async () => {
  for (const value of [undefined, 'purge-all-crew-data', 'PURGE-ALL-CREW-DATA ', 'yes']) {
    const h = await purgeWorld();
    if (value !== undefined) h.sim.props.set('FC_CREW_PURGE_CONFIRM', value);
    const props = JSON.stringify([...h.sim.props]);
    const keys = JSON.stringify(h.sim.store.keys());
    const r = purge(h);
    assert.equal(r.outcome, 'refused');
    assert.deepEqual(Object.keys(r).sort(), SAFE);
    assert.equal(JSON.stringify([...h.sim.props]), props);
    assert.equal(JSON.stringify(h.sim.store.keys()), keys);
  }
});

test('purge: with the confirmation every crew record is deleted; tombstones, codeHash and every other key are kept', async () => {
  const h = await purgeWorld();
  const before = h.sim.state();
  const keep = Object.fromEntries(['FC_CREW_ENABLED', 'FC_CREW_PEPPER', 'FC_CREW_SELF'].map((k) => [k, h.sim.props.get(k)]));
  assert.ok(h.sim.crewKeys().length > 0);
  h.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  const r = purge(h);
  assert.equal(r.outcome, 'deleted');
  assert.deepEqual(Object.keys(r).sort(), SAFE);
  assert.ok(r.deletedKeys > 0);
  assert.equal(r.remaining, 0);
  assert.equal(JSON.stringify(r).match(/[0-9a-f]{16,}/), null, 'no hashes or ids in the output');
  assert.equal(h.sim.props.has('FC_CREW_PURGE_CONFIRM'), false, 'confirmation consumed');
  assert.equal(h.sim.props.has('FC_CREW_ENROLL'), false);
  const after = h.sim.state();
  assert.deepEqual([after.phase, after.G, after.grantHash, after.revoke, after.purge], ['deleted', before.G + 1, null, null, null]);
  assert.deepEqual(after.cancelled, before.cancelled);
  assert.equal(after.codeHash, before.codeHash);
  assert.equal(after.lastRevoke.revokeId, `purge-${before.G}`);
  assert.deepEqual(h.sim.crewKeys(), []);
  assert.equal(h.sim.store.get('other.key'), 'kept');
  for (const [k, v] of Object.entries(keep)) assert.equal(h.sim.props.get(k), v, k);
  assert.equal(h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewIndex', grant: 'g-live' }).error, 'crew-not-enrolled', 'the old grant is gone');
});

test('purge: a failing deletion -> incomplete; a busy lock -> busy; an exception -> error (no message)', async () => {
  const h = await purgeWorld();
  h.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  h.sim.store.faults.del = () => true;
  const r = purge(h);
  assert.equal(r.outcome, 'incomplete');
  assert.ok(r.remaining > 0);
  const b = await purgeWorld();
  b.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  b.sim.faults.lockBusy = true;
  assert.equal(purge(b).outcome, 'busy');
  assert.equal(b.sim.props.get('FC_CREW_PURGE_CONFIRM'), 'PURGE-ALL-CREW-DATA', 'not consumed while busy');
  const e = await purgeWorld();
  e.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  e.sim.faults.stateWrite = 'throw';
  assert.deepEqual(purge(e), { outcome: 'error', deletedKeys: 0, remaining: null });
});

test('purge is not routable: crew dispatcher, v2 POST and GET refuse crewPurgeAll and change nothing', async () => {
  const h = await purgeWorld();
  h.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  const props = JSON.stringify([...h.sim.props]);
  assert.equal(h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewPurgeAll' }).error, 'unknown-action');
  const gs = loadGs();
  const { env } = fakeEnv(gs, { now: h.clock.t });
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: 'test-token-0123456789abcdef', action: 'crewPurgeAll' }), env)).error, 'unknown-action');
  assert.deepEqual(plain(gs.fcv2HandleGet_({ action: 'crewPurgeAll' }, { stats: () => 'S', v5GetOpen: () => true })), plain(gs.FCV2_GET_REFUSED_));
  assert.equal(JSON.stringify([...h.sim.props]), props, 'nothing changed');
});

test('cross-tab invariant holds through cancellation: backend never active while the record is gone', async () => {
  const h = await setup();
  h.sim.issueCode(CODE);
  h.plan.crewEnroll = ['hold'];
  await assert.rejects(h.svc.enroll(CODE));
  await deletion(h, h.svc.revoke());
  h.deliver();
  await flush();
  assert.equal(h.sim.phase() === 'active' && !h.storage.map.has(STORED), false);
});

// --- Correction batch 1 (Codex reproductions) ----------------------------------------------------------------

const CODE2 = 'SECOND-SYNTHETIC-CODE-99';
const NEXT = 'NEXT-SYNTHETIC-CODE-0000';

/** A revoked with receipt RA, the receipt then replaced by `receipt(state)`; B enrolled with an index. */
async function receiptWorld(receipt) {
  const h = await setup();
  h.sim.issueCode(CODE);
  enrollRaw(h.sim, 'gA');
  assert.equal(revoke(h.sim, 'gA', 'RA').state, 'deleted');
  const st = h.sim.state();
  if (receipt) h.sim.props.set('FC_CREW_STATE', JSON.stringify({ ...st, lastRevoke: receipt(st) }));
  h.sim.issueCode(CODE2);
  assert.equal(enrollRaw(h.sim, 'gB', CODE2).enrolled, true);
  assert.equal(crewIndex(h.sim, 'gB').ok, true);
  assert.ok(h.sim.crewKeys().length > 0);
  return h;
}
/** Backend-side deletion invariant: an answer "deleted" never while the grant's generation is still active. */
function noFalseDeleted(h, r) {
  assert.notEqual(r.recorded, true, 'never answered by a receipt of another grant');
  if (r.ok && r.state === 'deleted') assert.notEqual(h.sim.phase(), 'active', '"deleted" while B is active');
}

test('Codex P0 repro: a legacy receipt without credHash (A) never confirms B; B is really revoked', async () => {
  const h = await receiptWorld((st) => { const { credHash, ...legacy } = st.lastRevoke; return legacy; });
  const r = revoke(h.sim, 'gB', 'RA');
  noFalseDeleted(h, r);
  assert.equal(r.state, 'deleted');
  assert.equal(h.sim.phase(), 'deleted');
  assert.deepEqual(h.sim.crewKeys(), []);
});

test('P0: unbound system- and purge- receipts never answer for the active grant B', async () => {
  for (const id of ['system-1', 'purge-1']) {
    const h = await receiptWorld((st) => ({ revokeId: id, G: 1, outcome: 'deleted', deletedKeys: 0, at: st.lastRevoke.at, aliases: [], ...(id.startsWith('system') ? { credHash: null } : {}) }));
    const r = revoke(h.sim, 'gB', id);
    noFalseDeleted(h, r);
    assert.equal(h.sim.phase(), 'deleted', `${id}: B was revoked for real`);
    assert.deepEqual(h.sim.crewKeys(), []);
  }
});

test('P0: a bound receipt is idempotent for its own grant; A\'s bound receipt with B\'s grant is not a receipt', async () => {
  const h = await receiptWorld(null);
  assert.equal(h.sim.state().lastRevoke.credHash, h.sim.shortHash('gA'));
  const r = revoke(h.sim, 'gB', 'RA');
  noFalseDeleted(h, r);
  assert.equal(h.sim.phase(), 'deleted');
  const again = revoke(h.sim, 'gB', 'RA');
  assert.deepEqual([again.state, again.recorded], ['deleted', true], 'B\'s own receipt now answers, idempotently');
});

async function fenceWorld() {
  const h = await purgeWorld();                                   // active g-live, outstanding NEXT code, tombstone, other.key
  h.sim.props.set('FC_CREW_PURGE_CONFIRM', 'PURGE-ALL-CREW-DATA');
  return h;
}

test('Codex P1 repro: purge interrupted while deleting FC_CREW_ENROLL -> the held enrollment is refused (durable fence)', async () => {
  const h = await fenceWorld();
  h.sim.faults.propsDel = (k) => k === 'FC_CREW_ENROLL';
  const r = purge(h);
  assert.notEqual(r.outcome, 'deleted');
  h.sim.faults.propsDel = null;
  assert.deepEqual(enrollRaw(h.sim, 'g-held', NEXT), { ok: false, error: 'enroll-closed' }, 'the held enrollment is delivered');
  assert.notEqual(h.sim.phase(), 'active');
  assert.equal(h.sim.state().purging, true);
  assert.ok(h.sim.props.has('FC_CREW_ENROLL'), 'refused by the fence: no burn, no consume');
  assert.equal(h.sim.cache.has('fcv2-crew-enroll-failures'), false, 'no failure counted');
});

test('P1 fence: a failure at each destructive step keeps the fence, never "deleted"; a retry without confirmation completes and clears it', async () => {
  const steps = {
    'enroll-code delete': (h) => { h.sim.faults.propsDel = (k) => k === 'FC_CREW_ENROLL'; },
    'fcx delete': (h) => { h.sim.store.faults.del = () => true; },
    'cache remove': (h) => {
      const m = JSON.parse(h.sim.store.get('fcx.m'));                 // register one synthetic cache key
      h.sim.store.set('fcx.m', JSON.stringify({ ...m, cacheKeys: ['fcv2-crew-synthetic-agg'] }));
      h.sim.cache.set('fcv2-crew-synthetic-agg', 'x');
      h.sim.faults.cacheRemove = true;
    },
    'final state write (throws)': (h) => { h.sim.faults.stateWrite = (v) => (JSON.parse(v).purging ? null : 'throw'); },
    'final state write (lost)': (h) => { h.sim.faults.stateWrite = (v) => (JSON.parse(v).purging ? null : 'lost'); },
  };
  for (const [name, inject] of Object.entries(steps)) {
    const h = await fenceWorld();
    const G0 = h.sim.state().G;
    inject(h);
    const r = purge(h);
    assert.ok(['incomplete', 'error'].includes(r.outcome), `${name}: ${r.outcome}`);
    assert.deepEqual(Object.keys(r).sort(), SAFE);
    assert.equal(h.sim.state().purging, true, `${name}: the fence persists`);
    assert.equal(h.sim.state().phase, 'deleted', name);
    assert.equal(h.sim.props.has('FC_CREW_PURGE_CONFIRM'), false, `${name}: consumed once the fence was verified`);
    assert.deepEqual(enrollRaw(h.sim, 'g-late', NEXT), { ok: false, error: 'enroll-closed' }, name);
    assert.equal(crewIndex(h.sim, 'g-live').ok, false, name);
    h.sim.faults.propsDel = null; h.sim.store.faults.del = null; h.sim.faults.cacheRemove = false; h.sim.faults.stateWrite = null;
    const again = purge(h);                                         // no confirmation property: the fence is the intent
    assert.equal(again.outcome, 'deleted', name);
    assert.equal(again.remaining, 0);
    const st = h.sim.state();
    assert.equal(st.purging, undefined, `${name}: fence cleared`);
    assert.equal(st.G, G0 + 1, `${name}: one generation step for the whole purge`);
    assert.equal(st.lastRevoke.revokeId, `purge-${G0}`);
    assert.equal(st.lastRevoke.credHash, undefined, 'purge receipts are unbound (never answer)');
    assert.deepEqual(h.sim.crewKeys(), []);
    assert.equal(h.sim.props.has('FC_CREW_ENROLL'), false);
    assert.equal(h.sim.store.get('other.key'), 'kept');
  }
});

test('P1 fence: the fence write fails or is lost -> nothing destroyed, not "deleted", confirmation kept', async () => {
  for (const fault of ['throw', 'lost']) {
    const h = await fenceWorld();
    const keys = JSON.stringify(h.sim.store.keys());
    const code = h.sim.props.get('FC_CREW_ENROLL');
    const st = h.sim.props.get('FC_CREW_STATE');
    h.sim.faults.stateWrite = fault;
    const r = purge(h);
    assert.ok(['incomplete', 'error'].includes(r.outcome), fault);
    assert.equal(JSON.stringify(h.sim.store.keys()), keys, fault);
    assert.equal(h.sim.props.get('FC_CREW_ENROLL'), code, fault);
    assert.equal(h.sim.props.get('FC_CREW_STATE'), st, fault);
    assert.equal(h.sim.props.get('FC_CREW_PURGE_CONFIRM'), 'PURGE-ALL-CREW-DATA', `${fault}: not consumed`);
  }
});

test('P1 fence: while fenced a cancellation still works and keeps the fence; crew stays unauthorized', async () => {
  const h = await fenceWorld();
  h.sim.store.faults.del = () => true;
  assert.equal(purge(h).outcome, 'incomplete');
  h.sim.store.faults.del = null;
  assert.equal(revoke(h.sim, 'g-other', 'r-other').state, 'cancelled');
  assert.equal(h.sim.state().purging, true);
  assert.equal(revoke(h.sim, 'g-live', 'r-live').state, 'cancelled', 'the purged grant is no longer live');
  assert.equal(h.sim.handle({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crew', grant: 'g-live', ...h.sim.query(1) }).ok, false);
  assert.equal(purge(h).outcome, 'deleted');
});

test('P1 fence: unrelated properties untouched; after a completed purge a new enrollment works', async () => {
  const h = await fenceWorld();
  h.sim.props.set('FC_V2_TOKEN', 'synthetic-roster-token');
  h.sim.props.set('UNRELATED_PROPERTY', 'kept');
  const keep = [...h.sim.props].filter(([k]) => !['FC_CREW_STATE', 'FC_CREW_ENROLL', 'FC_CREW_PURGE_CONFIRM'].includes(k));
  assert.equal(purge(h).outcome, 'deleted');
  assert.deepEqual([...h.sim.props].filter(([k]) => k !== 'FC_CREW_STATE'), keep);
  h.sim.issueCode('FRESH-SYNTHETIC-CODE-777');
  assert.equal(enrollRaw(h.sim, 'g-new', 'FRESH-SYNTHETIC-CODE-777').enrolled, true);
  assert.equal(h.sim.phase(), 'active');
});

// Cancellation capability bound to the backend the revoke was sent to.
const ENDPOINT_B = ENDPOINT.replace('A'.repeat(30), 'B'.repeat(30));

async function twoBackends({ limitsA, limitsB }) {
  day += 1;
  const clock = { t: T0 + day * 86400000 };
  const sims = { A: await simulatedCrewBackend({ now: () => clock.t, limits: limitsA }), B: await simulatedCrewBackend({ now: () => clock.t, limits: limitsB }) };
  const storage = memoryStorage();
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId: `A${day}` };
  const plan = {};
  const parked = [];
  const held = [];
  const sent = [];
  const post = async (endpoint, body) => {
    const name = endpoint === ENDPOINT ? 'A' : 'B';
    sent.push(`${name}:${body.action}`);
    const step = plan[body.action]?.shift();
    if (step === 'hold') { held.push({ name, body }); throw new ApiError('timeout', 'held'); }
    if (step === 'park') return new Promise((resolve) => parked.push(() => resolve({ data: sims[name].handle(body) })));
    return { data: sims[name].handle(body) };
  };
  const rt = createCrewRuntime({
    store: createStore(storage), access: () => access, post,
    credentials: createCrewCredentials({ store: createStore(storage), now: () => clock.t }),
    now: () => clock.t, isVisible: () => true, isOnline: () => true,
  });
  rt.setEnabled(true);
  const use = async (name) => {
    Object.assign(access, name === 'A' ? { endpoint: ENDPOINT, accessId: `A${day}` } : { endpoint: ENDPOINT_B, accessId: `B${day}` });
    rt.accessChanged();
    return rt.capability();
  };
  const candidate = async (name) => {
    await use(name);
    sims[name].issueCode(CODE);
    plan.crewEnroll = ['hold'];
    await assert.rejects(rt.service.enroll(CODE));
  };
  return { sims, storage, access, plan, parked, held, sent, rt, use, candidate };
}
const settle = async (cond) => { for (let i = 0; i < 500 && !cond(); i += 1) await flush(); assert.ok(cond()); };

test('Codex P1 repro: A does not advertise crewCancel; access switches to B (crewCancel 1) while A\'s revoke is held; A\'s "cancelled" stays untrusted', async () => {
  const w = await twoBackends({ limitsA: null, limitsB: undefined });
  await w.candidate('A');
  assert.equal((await w.use('A')).cancel, false);
  w.plan.crewRevoke = ['park'];
  const pending = w.rt.service.revoke();
  await settle(() => w.parked.length === 1);
  assert.equal((await w.use('B')).cancel, true, 'B advertises crewCancel');
  w.parked.shift()();
  const r = await pending;
  assert.deepEqual([r.status, r.code], ['pending', 'invalid-response']);
  const rec = w.rt.credentials.read();
  assert.equal(rec.phase, 'revoking', 'recovery evidence kept');
  assert.equal(rec.grants.filter((e) => !e.resolved).length, 1, 'A\'s entry stays unresolved');
});

test('P1 reverse: A advertises crewCancel; switch to B (unsupported) while A\'s revoke is held; A\'s answer resolves only A\'s own entry', async () => {
  const w = await twoBackends({ limitsA: undefined, limitsB: null });
  await w.candidate('A');
  assert.equal((await w.use('A')).cancel, true);
  w.plan.crewRevoke = ['park'];
  const pending = w.rt.service.revoke();
  await settle(() => w.parked.length === 1);
  assert.equal((await w.use('B')).cancel, false, 'B does not advertise crewCancel');
  w.parked.shift()();
  const r = await pending;
  // Per-entry evidence (Stage A rule): the answer came from A's backend about A's entry; trust was captured for A.
  assert.deepEqual(r, { status: 'superseded' });
  assert.equal(w.storage.getItem(STORED), null);
  assert.equal(w.sent.filter((x) => x === 'B:crewRevoke').length, 0, 'nothing sent to B for A\'s pass');
  // B can never hold an entry during A's pending deletion: enrollment is refused while a deletion is pending.
});

test('P1: same backend with the capability -> accepted; B\'s capability never changes A\'s captured value', async () => {
  const w = await twoBackends({ limitsA: undefined, limitsB: null });
  await w.candidate('A');
  assert.equal((await w.use('B')).cancel, false);
  assert.equal((await w.use('A')).cancel, true);
  const r = await w.rt.service.revoke();
  assert.deepEqual(r, { status: 'superseded' });
  assert.equal(w.storage.getItem(STORED), null);
});
