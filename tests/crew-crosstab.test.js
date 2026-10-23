// Crew Intelligence Stage A, batch 7: cross-tab coordination of the credential record. Every "tab" is a real
// node:worker_threads worker (own runtime) sharing one localStorage-like double over SharedArrayBuffers; Web
// Locks are Node's navigator.locks (shared between workers of one process). The backend is the real simulated
// handler set (CrewApiV2.gs) in the main thread, reached by message passing. Synthetic data only.
//
// Red-first evidence: CREW_CROSSTAB_CREDENTIAL_MODULE may point the workers at another credential module (the
// reconstructed pre-batch-7 module); the default is src/sources/crew-credential.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createSharedBuffers, sharedControls } from './fixtures/crew-shared-storage.mjs';
import { simulatedCrewBackend, TOKEN, ENDPOINT, T0 } from './fixtures/crew-frontend.synthetic.mjs';

const MODULE = process.env.CREW_CROSSTAB_CREDENTIAL_MODULE || undefined;
const STORED = 'fc.v2.crew.v1';
const LOCK = 'fc.v2.crew.v1.lock';
const GOOD = 'SYNTHETIC-GOOD-CODE-1234';
const WRONG = 'SYNTHETIC-WRONG-CODE-9999';

/** Waits for a condition (sync or async); polling is test plumbing only, never a decision of the code under test. */
async function until(condition, message, limitMs = 10000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > limitMs) assert.fail(`timed out waiting: ${message}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function world() {
  const bclock = { t: T0 + 3 * 86400000 };
  const sim = await simulatedCrewBackend({ now: () => bclock.t });
  const buffers = createSharedBuffers();
  const ctl = sharedControls(buffers);
  const workers = [];
  const w = {
    sim, ctl, bclock,
    /** route(body, reply, tabId): default delivers to the backend at once. */
    route: (body, reply) => reply({ data: sim.handle(body) }),
    record: () => { const raw = ctl.raw(STORED); return raw === null ? null : JSON.parse(raw); },
    tab(tabId) {
      const worker = new Worker(new URL('./fixtures/crew-crosstab-worker.mjs', import.meta.url), {
        workerData: { buffers, tabId, credentialModule: MODULE, endpoint: ENDPOINT, token: TOKEN, accessId: 'same-origin' },
      });
      workers.push(worker);
      const results = new Map();
      let n = 0;
      let markReady;
      const ready = new Promise((r) => { markReady = r; });
      worker.on('message', (msg) => {
        if (msg.type === 'ready') markReady();
        else if (msg.type === 'post') w.route(msg.body, (answer) => worker.postMessage({ type: 'post-reply', reqId: msg.reqId, ...answer }), tabId);
        else if (msg.type === 'result') { const done = results.get(msg.id); results.delete(msg.id); done(msg); }
      });
      const call = async (cmd, args = {}) => {
        await ready;
        n += 1;
        const id = n;
        return new Promise((resolve) => { results.set(id, resolve); worker.postMessage({ id, cmd, ...args }); });
      };
      return { worker, call, ready };
    },
    close: () => Promise.all(workers.map((x) => x.terminate())),
  };
  return w;
}

/** Cross-tab invariant: backend active => the shared record holds that live grant, or a deletion is pending. */
function invariant(w) {
  if (w.sim.phase() !== 'active') return;
  const rec = w.record();
  assert.ok(rec, 'backend active => a local credential record exists');
  assert.ok(rec.phase === 'revoking' || rec.grants.some((e) => w.sim.isLive(e.grant)), 'backend active => the record holds the live grant (or deletion is pending)');
}

test('race (review exact): tab A pauses between its decision and its write while tab B enrolls; B\'s live grant is never lost', async () => {
  const w = await world();
  try {
    w.sim.issueCode(GOOD);
    const A = w.tab(1);
    const B = w.tab(2);
    await Promise.all([A.ready, B.ready]);
    w.ctl.arm(1);                                                        // A blocks inside its crew setItem
    const pA = A.call('enrollDirect', { code: WRONG });
    await until(() => w.ctl.pausedTab() === 1, 'A paused between its preservation check and its write');
    let bDone = false;
    const pB = B.call('enrollDirect', { code: GOOD }).then((r) => { bDone = true; return r; });
    // Decided by observation, not by time: B either finished (uncoordinated writes) or waits for A's lock.
    await until(async () => bDone || (await B.call('lockState')).value.pending.some((l) => l.name === LOCK), 'B finished or waits for the lock');
    if (!MODULE) assert.equal(bDone, false, 'B waits for the lock A holds during its paused write');
    w.ctl.resume();
    const [a, b] = await Promise.all([pA, pB]);
    assert.ok(a.value?.error, 'A was refused by the backend');
    assert.equal(b.value?.settled, true, 'B enrolled');
    assert.equal(w.sim.phase(), 'active');
    invariant(w);
    const active = w.record().grants.filter((e) => e.role === 'active');
    assert.equal(active.length, 1);
    assert.ok(w.sim.isLive(active[0].grant), 'the stored active grant is the backend\'s live grant');
  } finally {
    await w.close();
  }
});

test('concurrent enrollment from two tabs with the same code: one ok, one refused; neither loses the other\'s evidence', async () => {
  const w = await world();
  try {
    w.sim.issueCode(GOOD);
    const A = w.tab(1);
    const B = w.tab(2);
    const [a, b] = await Promise.all([A.call('enroll', { code: GOOD }), B.call('enroll', { code: GOOD })]);
    const outcomes = [a, b].map((r) => (r.error ? r.error : 'enrolled')).sort();
    assert.deepEqual(outcomes, ['enroll-closed', 'enrolled']);
    assert.equal(w.sim.phase(), 'active');
    invariant(w);
    assert.deepEqual(w.record().grants.map((e) => e.role), ['active'], 'the refused candidate (never unknown) is gone, the live grant kept');
  } finally {
    await w.close();
  }
});

test('enrollment vs deletion: tab A deletes while tab B\'s enrollment is in flight; never deleted while B is live', async () => {
  const w = await world();
  try {
    w.sim.issueCode(GOOD);
    const A = w.tab(1);
    const B = w.tab(2);
    let held = null;
    w.route = (body, reply) => {
      if (body.action === 'crewEnroll' && !held) { held = { body, reply }; return; }   // B's request is in transit
      reply({ data: w.sim.handle(body) });
    };
    const pB = B.call('enroll', { code: GOOD });
    await until(() => held !== null, 'B dispatched (its candidate persisted as inflight first)');
    assert.equal(w.record().grants[0].inflight, true);
    const first = await A.call('revoke');
    assert.deepEqual([first.value?.status, first.value?.code], ['pending', 'unresolved-enrollment'], 'B\'s candidate is part of the deletion');
    held.reply({ data: w.sim.handle(held.body) });                    // B's enrollment arrives and activates
    assert.equal(w.sim.phase(), 'active');
    const b = await pB;
    assert.equal(b.error, 'revoke-pending', 'B learns that a deletion is pending');
    invariant(w);
    assert.equal(w.record().phase, 'revoking');
    const done = await A.call('resume');
    assert.equal(done.value?.status, 'deleted');
    assert.equal(w.sim.phase(), 'deleted');
    assert.equal(w.record(), null);
    const late = await B.call('enroll', { code: GOOD });
    assert.ok(late.error, 'no silent re-enrollment');
  } finally {
    await w.close();
  }
});

test('restart recovery: a tab closed mid-enrollment (request processed, no answer) is recovered by a new tab; deletion completes', async () => {
  const w = await world();
  try {
    w.sim.issueCode(GOOD);
    const A = w.tab(1);
    w.route = (body, reply) => {
      if (body.action === 'crewEnroll') { w.sim.handle(body); return; }   // processed; the tab never gets the answer
      reply({ data: w.sim.handle(body) });
    };
    void A.call('enroll', { code: GOOD });
    await until(() => w.sim.phase() === 'active', 'the backend activated A\'s grant');
    assert.equal(w.record().grants[0].inflight, true, 'uncertainty persisted before dispatch');
    await A.worker.terminate();                                         // the tab is closed (not holding the lock)
    invariant(w);
    const C = w.tab(3);
    const r = await C.call('revoke');
    assert.equal(r.value?.status, 'deleted', JSON.stringify(r));
    assert.equal(w.sim.phase(), 'deleted');
    assert.equal(w.record(), null);
  } finally {
    await w.close();
  }
});
