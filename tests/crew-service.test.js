// Crew Intelligence Phase 1c Stage A: memory-only crew service (src/sources/crew-service.js). Deterministic:
// fake post, injected clock / sleep / visibility / connectivity, in-memory storage. Covers caching and
// stale-answer rejection, refusals, rate limits and bounded retries, the single app-wide indexing runner
// and its cancellation, enrollment, revocation (including network failure during deletion and resumption
// after sign-out) and the memory-only guarantee. Synthetic data only.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { ApiError } from '../src/api/appscript.js';
import { createCrewCredentials, CREW_CREDENTIAL_KEY, CREW_CREDENTIAL_LOCK, endpointFingerprint, accessFingerprint } from '../src/sources/crew-credential.js';
import {
  createCrewService, purgeCrewMemory, CrewError, __resetCrewStateForTests,
  CREW_TTL_MS, CREW_MAX_ENTRIES, CREW_HIDDEN_PURGE_MS, CREW_CALL_BUDGET, CREW_TIMEOUT_MS, CREW_INDEX_TIMEOUT_MS,
  INDEX_SPACING_MS, INDEX_MAX_CALLS, INDEX_MAX_RUNS, BUSY_RETRY_MS, BUSY_COOLDOWN_MS, RATE_WINDOW_MS, RATE_MARGIN_MS,
  REVOKE_RETRY_HINT_MS,
} from '../src/sources/crew-service.js';
import { PROFILE } from './helpers.js';
import {
  TOKEN, OTHER_TOKEN, ENDPOINT, T0, SECTOR, SECTOR_2, DATE, memoryStorage, seqRandom, crewAnswer, indexAnswer as legacyIndexAnswer,
  enrollAnswer, revokeAnswer, refusal, deferred, fakePost, networkError, timeoutError, flush, simulatedCrewBackend,
} from './fixtures/crew-frontend.synthetic.mjs';

const MANUAL_CUTOFF = { at: T0, proof: 'a'.repeat(64) };
const indexAnswer = (options = {}) => {
  const r = legacyIndexAnswer(options);
  return { ...r, session: { version: 1, manualCutoff: MANUAL_CUTOFF, initialOutstanding: r.progress.pending + r.progress.stale + r.processed, remaining: r.progress.pending + r.progress.stale } };
};

const STORED = `fc.v2.${CREW_CREDENTIAL_KEY}`;
const CODE = 'SYNTHETIC-CODE-4711';
const Q = { sectorId: SECTOR, date: DATE };

afterEach(async () => { purgeCrewMemory(); await flush(); });

// Budget, cooldowns, run throttle and suspension are app-wide (module level) and deliberately survive a
// purge, so every harness starts one day after the previous one: earlier tests' windows have passed.
const DAY = 86400000;
let base = T0;

/**
 * handler(body, n) answers each post. `sleep` resolves at once (advancing the clock) unless `abortable`,
 * where it waits for h.wake() or the abort signal.
 */
function harness({ handler = () => assert.fail('unexpected request'), enrolled = true, abortable = false, storage = memoryStorage(), store = null, access = null, locks, monotonic } = {}) {
  purgeCrewMemory();
  const s = store ?? createStore(storage);
  base += DAY;
  const clock = { t: base + 1000 };
  const state = { visible: true, online: true, access: access ?? { endpoint: ENDPOINT, token: TOKEN, accessId: `${base}:0` } };
  const credentials = createCrewCredentials({ store: s, random: seqRandom(3), now: () => clock.t, ...(locks === undefined ? {} : { locks }) });
  const fake = fakePost(handler);
  const events = [];
  const sleeps = [];
  const mine = base;
  const h = { storage, store: s, clock, state, credentials, fake, events, sleeps, wake: null, id: (suffix) => `${mine}:${suffix}` };
  const sleep = abortable
    ? (ms, signal) => new Promise((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener('abort', () => resolve(), { once: true });
      h.wake = () => { clock.t += ms; resolve(); };
    })
    : async (ms) => { sleeps.push(ms); clock.t += ms; };
  h.make = () => createCrewService({
    credentials, access: () => state.access, post: fake.post, now: () => clock.t, sleep,
    monotonic: monotonic ?? (() => clock.t), isVisible: () => state.visible, isOnline: () => state.online, onChange: (e) => events.push(e),
  });
  h.svc = h.make();
  if (enrolled) {
    // Seeded synchronously as a confirmed active record (credential mutations are async locked operations).
    const grant = Buffer.from(seqRandom(1103)(32)).toString('base64url');   // a seed the credentials never use
    s.setJSON(CREW_CREDENTIAL_KEY, { v: 1, phase: 'active', grants: [{
      grant, ep: endpointFingerprint(state.access.endpoint), bind: accessFingerprint(state.access.endpoint, state.access.token),
      at: clock.t, role: 'active', G: 1, unknown: false, inflight: false,
    }] });
  }
  h.grant = () => credentials.read()?.grants.find((e) => e.role === 'active')?.grant ?? null;
  h.entries = () => credentials.read()?.grants ?? [];
  h.posts = (action) => fake.bodies.filter((b) => b.body.action === action).length;
  return h;
}
const code = async (promise) => {
  try { await promise; } catch (error) { assert.ok(error instanceof CrewError, String(error)); return error.code; }
  assert.fail('expected a CrewError');
};
const byAction = (map) => (body, n) => {
  const f = map[body.action];
  if (!f) assert.fail(`unexpected ${body.action}`);
  return typeof f === 'function' ? f(body, n) : f;
};

// --- loadCrew --------------------------------------------------------------------------------------------

test('loadCrew: validated and frozen, served from memory while fresh; force refetches; expires after the TTL', async () => {
  const h = harness({ handler: () => crewAnswer() });
  const v = await h.svc.loadCrew(Q);
  assert.equal(v.sectorId, SECTOR);
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.members[0]));
  assert.deepEqual(h.fake.bodies[0].body, { contract: 'fc.roster', version: 2, action: 'crew', token: TOKEN, grant: h.grant(), sectorId: SECTOR, date: DATE });
  assert.equal(h.fake.bodies[0].timeoutMs, CREW_TIMEOUT_MS);
  assert.equal(await h.svc.loadCrew(Q), v, 'memory hit');
  assert.equal(h.posts('crew'), 1);
  await h.svc.loadCrew(Q, { force: true });
  assert.equal(h.posts('crew'), 2);
  h.clock.t += CREW_TTL_MS;
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 3, 'expired after 10 minutes');
});

test('loadCrew: local refusals send nothing (no endpoint, no token, no active grant, bad query)', async () => {
  const h = harness({ enrolled: false });
  assert.equal(await code(h.svc.loadCrew(Q)), 'crew-not-enrolled');
  await h.credentials.beginEnroll(h.state.access);
  assert.equal(await code(h.svc.loadCrew(Q)), 'crew-not-enrolled', 'enrolling is not enrolled');
  await h.credentials.confirmEnroll(h.state.access, 1);
  assert.equal(await code(h.svc.loadCrew({ sectorId: 'abc', date: DATE })), 'bad-request');
  assert.equal(await code(h.svc.loadCrew({ sectorId: SECTOR, date: '20-10-2026' })), 'bad-request');
  h.state.access = { endpoint: ENDPOINT, token: null, accessId: h.id('2') };
  assert.equal(await code(h.svc.loadCrew(Q)), 'auth-required');
  h.state.access = { endpoint: null, token: null, accessId: h.id('3') };
  assert.equal(await code(h.svc.loadCrew(Q)), 'not-configured');
  assert.equal(h.fake.bodies.length, 0);
});

test('loadCrew: identical requests share one call; at most 8 entries, oldest evicted', async () => {
  const gate = deferred();
  const h = harness({ handler: async (body) => { await gate.promise; return crewAnswer({ sectorId: body.sectorId }); } });
  const a = h.svc.loadCrew(Q);
  const b = h.svc.loadCrew(Q, { force: true });
  gate.resolve();
  assert.equal(await a, await b);
  assert.equal(h.posts('crew'), 1);
  const ids = Array.from({ length: CREW_MAX_ENTRIES }, (_, i) => `s_${String(i).padStart(2, 'a')}c3d4e5f6a7b8c9`);
  for (const sectorId of ids) { h.clock.t += 1; await h.svc.loadCrew({ sectorId, date: DATE }); }
  assert.equal(h.posts('crew'), 1 + CREW_MAX_ENTRIES);
  await h.svc.loadCrew({ sectorId: ids.at(-1), date: DATE });
  assert.equal(h.posts('crew'), 1 + CREW_MAX_ENTRIES, 'the newest is still cached');
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2 + CREW_MAX_ENTRIES, 'the oldest was evicted');
});

test('loadCrew: an invalid response is never cached', async () => {
  const h = harness({ handler: (body, n) => (n === 1 ? crewAnswer({ top: { extra: 1 } }) : crewAnswer()) });
  const err = await h.svc.loadCrew(Q).catch((e) => e);
  assert.deepEqual([err.code, err.detail], ['invalid-response', 'unexpected-field']);
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
});

test('stale-response rejection: access id changes mid-request -> access-changed, nothing cached', async () => {
  const gate = deferred();
  const h = harness({ handler: async (body, n) => { if (n === 1) await gate.promise; return crewAnswer(); } });
  const p = h.svc.loadCrew(Q);
  await flush();
  h.state.access = { ...h.state.access, accessId: h.id('2') };
  gate.resolve();
  assert.equal(await code(p), 'access-changed');
  h.state.access = { ...h.state.access, accessId: h.id('0') };
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2, 'the discarded answer was not stored');
});

test('stale-response rejection: purge mid-request -> access-changed, nothing cached', async () => {
  const gate = deferred();
  const h = harness({ handler: async (body, n) => { if (n === 1) await gate.promise; return crewAnswer(); } });
  const p = h.svc.loadCrew(Q);
  await flush();
  purgeCrewMemory();
  gate.resolve();
  assert.equal(await code(p), 'access-changed');
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
});

test('stale-response rejection: grant replaced mid-request -> access-changed, nothing cached', async () => {
  const gate = deferred();
  const h = harness({ handler: async (body, n) => { if (n === 1) await gate.promise; return crewAnswer(); } });
  const p = h.svc.loadCrew(Q);
  await flush();
  h.clock.t += 16 * 60000;
  await h.credentials.beginEnroll(h.state.access);          // a new enrollment replaces the active record
  await h.credentials.confirmEnroll(h.state.access, 2);
  gate.resolve();
  assert.equal(await code(p), 'access-changed');
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
});

test('refusals crew-revoked / crew-not-enrolled end access: grant removed, memory purged, event emitted', async () => {
  for (const refused of ['crew-revoked', 'crew-not-enrolled']) {
    const h = harness({ handler: (body) => (body.sectorId === SECTOR_2 ? refusal(refused) : crewAnswer()) });
    await h.svc.loadCrew(Q);
    assert.equal(await code(h.svc.loadCrew({ sectorId: SECTOR_2, date: DATE })), refused);
    assert.equal(h.storage.getItem(STORED), null);
    assert.deepEqual(h.events.map((e) => e.type), ['access-ended']);
    assert.equal(await code(h.svc.loadCrew(Q)), 'crew-not-enrolled', 'memory purged, no grant: refused locally');
    assert.equal(h.posts('crew'), 2);
  }
});

test('suspending refusals keep the grant and block calls until the access id changes or a new enrollment succeeds', async () => {
  for (const refused of ['unauthorized', 'crew-disabled', 'unknown-action', 'unsupported-contract']) {
    let answer = refusal(refused);
    const h = harness({ handler: byAction({ crew: () => answer, crewEnroll: enrollAnswer(2), crewIndex: indexAnswer({ processed: 0 }) }) });
    assert.equal(await code(h.svc.loadCrew(Q)), refused);
    assert.notEqual(h.grant(), null, 'grant kept');
    const err = await h.svc.loadCrew(Q).catch((e) => e);
    assert.deepEqual([err.code, err.detail], ['suspended', refused]);
    assert.equal(h.posts('crew'), 1, 'no request while suspended');
    assert.equal((await h.svc.requestIndexing('manual')).stopped, 'suspended');
    answer = crewAnswer();
    h.state.access = { ...h.state.access, accessId: h.id('1') };
    await h.svc.loadCrew(Q);
    assert.equal(h.posts('crew'), 2, 'a new access id lifts the suspension');
    // A successful enrollment lifts it as well.
    answer = refusal(refused);
    await code(h.svc.loadCrew(Q, { force: true }));
    await h.svc.enroll(CODE);
    await flush();
    answer = crewAnswer();
    await h.svc.loadCrew(Q, { force: true });
    assert.equal(h.posts('crew'), 4);
  }
});

test('rate-limited: every crew call except revoke waits for the next fixed window + margin, then resumes', async () => {
  let limited = true;
  const h = harness({ handler: byAction({ crew: () => (limited ? refusal('rate-limited') : crewAnswer()), crewRevoke: revokeAnswer(), crewIndex: indexAnswer({ processed: 0 }) }) });
  assert.equal(await code(h.svc.loadCrew(Q)), 'rate-limited');
  limited = false;
  const until = (Math.floor(h.clock.t / RATE_WINDOW_MS) + 1) * RATE_WINDOW_MS + RATE_MARGIN_MS;
  assert.equal(h.svc.indexingStatus().cooldownUntil, until);
  assert.equal(await code(h.svc.loadCrew(Q)), 'cooldown');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'cooldown');
  assert.equal(await code(h.svc.enroll(CODE)), 'cooldown');
  assert.equal(h.fake.bodies.length, 1, 'nothing sent during the cooldown');
  h.clock.t = until - 1;
  assert.equal(await code(h.svc.loadCrew(Q)), 'cooldown');
  h.clock.t = until;
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
  // Revocation is never gated by the cooldown.
  const h2 = harness({ handler: byAction({ crew: refusal('rate-limited'), crewRevoke: revokeAnswer() }) });
  await code(h2.svc.loadCrew(Q));
  assert.equal((await h2.svc.revoke()).status, 'deleted');
});

test('client budget: at most CREW_CALL_BUDGET crew calls per rolling 10 minutes', async () => {
  const h = harness({ handler: () => crewAnswer() });
  for (let i = 0; i < CREW_CALL_BUDGET; i += 1) await h.svc.loadCrew(Q, { force: true });
  assert.equal(await code(h.svc.loadCrew(Q, { force: true })), 'local-limit');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'budget');
  assert.equal(h.fake.bodies.length, CREW_CALL_BUDGET);
  assert.equal(await h.svc.loadCrew(Q) !== null, true, 'a memory hit needs no call');
  h.clock.t += RATE_WINDOW_MS;
  await h.svc.loadCrew(Q, { force: true });
  assert.equal(h.fake.bodies.length, CREW_CALL_BUDGET + 1);
});

test('indexingSuggested=false: no indexing starts and the state stays incomplete', async () => {
  const h = harness({ handler: byAction({ crew: crewAnswer({ state: 'incomplete', reasons: ['missing-records'], indexingSuggested: false }) }) });
  const v = await h.svc.loadCrew(Q);
  await flush();
  assert.equal(v.history.state, 'incomplete');
  assert.equal(v.history.indexingSuggested, false);
  assert.equal(h.posts('crewIndex'), 0);
  assert.equal(h.svc.indexingStatus().running, false);
});

test('indexingSuggested=true starts one detail run (not awaited by loadCrew)', async () => {
  const h = harness({ handler: byAction({ crew: crewAnswer({ state: 'incomplete', reasons: ['missing-records'], indexingSuggested: true }), crewIndex: indexAnswer({ processed: 0 }) }) });
  const v = await h.svc.loadCrew(Q);
  assert.equal(v.history.state, 'incomplete');
  await flush();
  assert.equal(h.posts('crewIndex'), 1);
  assert.equal(h.svc.indexingStatus().running, false);
});

test('hidden for more than 10 minutes purges crew memory; a shorter absence keeps it', async () => {
  const h = harness({ handler: () => crewAnswer() });
  await h.svc.loadCrew(Q);
  h.svc.noteVisibility(false);
  h.clock.t += CREW_HIDDEN_PURGE_MS - 1000;
  h.svc.noteVisibility(true);
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 1);
  h.svc.noteVisibility(false);
  h.clock.t += 5 * 60000;
  h.svc.noteVisibility(false);   // repeated hidden notes keep the first time
  h.clock.t += 5 * 60000 + 1;
  h.svc.noteVisibility(true);
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
});

// --- Indexing ------------------------------------------------------------------------------------------

test('indexing starts with exactly one call and stops when it made no progress', async () => {
  const h = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 0 }) }) });
  const r = await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls, r.processed, r.stopped], [1, 0, 'no-progress']);
  assert.deepEqual(h.fake.bodies[0].body, { contract: 'fc.roster', version: 2, action: 'crewIndex', token: TOKEN, grant: h.grant(), sessionVersion: 1 });
  assert.equal(h.fake.bodies[0].timeoutMs, CREW_INDEX_TIMEOUT_MS);
  assert.deepEqual(h.events.map((e) => e.type), ['progress']);
});

test('indexing continues only while progress is made and work remains, spaced; stops done', async () => {
  const answers = [indexAnswer({ processed: 6, pending: 4, stale: 0, indexed: 5, uncovered: 1 }), indexAnswer({ processed: 4, pending: 0, stale: 1, indexed: 8, uncovered: 1 }), indexAnswer({ processed: 1, pending: 0, stale: 0, indexed: 9, uncovered: 1 })];
  const h = harness({ handler: byAction({ crewIndex: (body, n) => answers[n - 1] }) });
  const r = await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls, r.processed, r.stopped], [3, 11, 'uncovered']);
  assert.deepEqual(r.progress, { total: 10, indexed: 9, pending: 0, stale: 0, uncovered: 1 });
  assert.deepEqual(h.sleeps, [INDEX_SPACING_MS, INDEX_SPACING_MS]);
  assert.deepEqual(h.svc.indexingStatus().lastProgress, { ...r.progress, at: h.clock.t });
  assert.deepEqual(h.events.map((e) => e.type), ['progress', 'progress', 'progress', 'indexed']);
});

test('indexing stops at the per-trigger call limit; uncovered months alone are not work', async () => {
  const h = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 5, stale: 0 }) }) });
  const r = await h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  assert.deepEqual([r.calls, r.stopped], [2, 'no-progress']);
  const h2 = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 5, stale: 0 }) }) });
  assert.deepEqual([(await h2.svc.requestIndexing('manual')).calls], [INDEX_MAX_CALLS.manual]);
  const h3 = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 2, indexed: 8, pending: 0, stale: 0, uncovered: 2 }) }) });
  assert.equal((await h3.svc.requestIndexing('manual')).stopped, 'uncovered');
});

test('indexing progress invalidates crew memory (answers are outdated) and emits indexed', async () => {
  const h = harness({ handler: byAction({ crew: crewAnswer(), crewIndex: indexAnswer({ processed: 1, pending: 0, stale: 0, indexed: 9 }) }) });
  await h.svc.loadCrew(Q);
  await h.svc.requestIndexing('manual');
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2);
  assert.equal(h.events.at(-1).type, 'indexed');
});

test('manual indexing echoes only the server cutoff across calls, irrespective of device clock', async () => {
  for (const skew of [-86400000, 86400000]) {
    const h = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 3 }) }) });
    h.clock.t += skew;
    await h.svc.requestIndexing('manual');
    const sent = h.fake.bodies.map(b => b.body);
    assert.equal(sent.length, INDEX_MAX_CALLS.manual);
    assert.ok(sent.every(b => b.manualCheck === true && !('verifyBefore' in b)));
    assert.equal(sent[0].manualCutoff, undefined);
    assert.deepEqual(sent[1].manualCutoff, MANUAL_CUTOFF);
  }
});

test('one runner app-wide: a second request (any service instance) joins the running promise', async () => {
  const gate = deferred();
  const h = harness({ handler: byAction({ crewIndex: async () => { await gate.promise; return indexAnswer({ processed: 0 }); } }) });
  const other = h.make();
  const a = h.svc.requestIndexing('enroll');
  const b = other.requestIndexing('manual');
  const c = h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(other.indexingStatus().trigger, 'enroll');
  gate.resolve();
  await a;
  assert.equal(h.posts('crewIndex'), 1);
});

test('INDEX_MAX_RUNS per rolling 10 minutes: further runs are throttled without a call', async () => {
  const h = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 0 }) }) });
  for (let i = 0; i < INDEX_MAX_RUNS; i += 1) assert.equal((await h.svc.requestIndexing('manual')).stopped, 'no-progress');
  assert.deepEqual(await h.svc.requestIndexing('manual'), { calls: 0, processed: 0, progress: null, stopped: 'throttled' });
  assert.equal(h.posts('crewIndex'), INDEX_MAX_RUNS);
  h.clock.t += RATE_WINDOW_MS;
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'no-progress');
});

test('indexing never starts without an active grant, or while hidden or offline', async () => {
  const h = harness({ enrolled: false });
  assert.equal((await h.svc.requestIndexing('enroll')).stopped, 'not-enrolled');
  await h.credentials.beginEnroll(h.state.access);
  assert.equal((await h.svc.requestIndexing('enroll')).stopped, 'not-enrolled');
  await h.credentials.confirmEnroll(h.state.access, 1);
  h.state.visible = false;
  assert.equal((await h.svc.requestIndexing('enroll')).stopped, 'hidden');
  h.state.visible = true;
  h.state.online = false;
  assert.equal((await h.svc.requestIndexing('enroll')).stopped, 'offline');
  assert.equal(h.fake.bodies.length, 0);
});

test('cancellation: leaving the detail stops its run; an in-flight answer still updates progress', async () => {
  const gate = deferred();
  const h = harness({ abortable: true, handler: byAction({ crewIndex: async (body, n) => { if (n === 2) await gate.promise; return indexAnswer({ processed: 1, pending: 5 }); } }) });
  const run = h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  await flush();
  assert.deepEqual(h.sleeps, [INDEX_SPACING_MS]);
  h.svc.leaveDetail(SECTOR_2);
  assert.equal(h.svc.indexingStatus().running, true, 'another sector does not cancel');
  h.wake();
  await flush();
  assert.equal(h.posts('crewIndex'), 2, 'second call in flight');
  h.svc.leaveDetail(SECTOR);
  gate.resolve();
  const r = await run;
  assert.deepEqual([r.calls, r.processed, r.stopped], [2, 2, 'cancelled']);
  assert.equal(h.events.filter((e) => e.type === 'progress').length, 2, 'the in-flight answer updated progress');
  assert.equal(h.posts('crewIndex'), 2, 'no further call');
});

test('cancellation during the spacing pause: no further call', async () => {
  const h = harness({ abortable: true, handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 5 }) }) });
  const run = h.svc.requestIndexing('manual');
  await flush();
  h.svc.cancelIndexing();
  const r = await run;
  assert.deepEqual([r.calls, r.stopped], [1, 'cancelled']);
});

test('visibility loss and offline stop the runner', async () => {
  const h = harness({ abortable: true, handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 5 }) }) });
  const run = h.svc.requestIndexing('manual');
  await flush();
  h.svc.noteVisibility(false);
  assert.equal((await run).stopped, 'hidden');
  h.svc.noteVisibility(true);
  const run2 = h.svc.requestIndexing('manual');
  await flush();
  h.svc.noteOnline(false);
  assert.equal((await run2).stopped, 'offline');
  // Visibility checked before every call even without a notification.
  const h2 = harness({ handler: byAction({ crewIndex: () => { h2.state.visible = false; return indexAnswer({ processed: 1, pending: 5 }); } }) });
  assert.deepEqual([(await h2.svc.requestIndexing('manual')).stopped, h2.posts('crewIndex')], ['hidden', 1]);
});

test('purge or access change mid-call cancels the runner and discards the answer', async () => {
  const gate = deferred();
  const h = harness({ handler: byAction({ crewIndex: async () => { await gate.promise; return indexAnswer({ processed: 3, pending: 2 }); } }) });
  const run = h.svc.requestIndexing('manual');
  await flush();
  purgeCrewMemory();
  gate.resolve();
  const r = await run;
  assert.deepEqual([r.calls, r.processed, r.progress, r.stopped], [1, 0, null, 'cancelled']);
  assert.equal(h.svc.indexingStatus().lastProgress, null);
  assert.deepEqual(h.events, [], 'no progress, no indexed event');

  const gate2 = deferred();
  const h2 = harness({ handler: byAction({ crewIndex: async () => { await gate2.promise; return indexAnswer({ processed: 3, pending: 2 }); } }) });
  const run2 = h2.svc.requestIndexing('manual');
  await flush();
  h2.state.access = { ...h2.state.access, accessId: h2.id('9') };
  gate2.resolve();
  const r2 = await run2;
  assert.deepEqual([r2.processed, r2.stopped], [0, 'access-changed']);
  assert.equal(h2.posts('crewIndex'), 1);
});

test('busy: exactly one retry after BUSY_RETRY_MS, then stop with an indexing cooldown', async () => {
  const h = harness({ handler: byAction({ crewIndex: refusal('busy') }) });
  const r = await h.svc.requestIndexing('manual');
  assert.deepEqual([r.calls, r.stopped], [2, 'busy']);
  assert.deepEqual(h.sleeps, [BUSY_RETRY_MS]);
  assert.equal(h.svc.indexingStatus().cooldownUntil, h.clock.t + BUSY_COOLDOWN_MS);
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'cooldown');
  assert.equal(h.posts('crewIndex'), 2);
  h.clock.t += BUSY_COOLDOWN_MS;
  assert.equal((await h.svc.requestIndexing('manual')).calls, 2, 'allowed again after the cooldown');
  // busy, then success: the run continues.
  const h2 = harness({ handler: byAction({ crewIndex: (b, n) => (n === 1 ? refusal('busy') : indexAnswer({ processed: 0 })) }) });
  assert.deepEqual([(await h2.svc.requestIndexing('manual')).stopped, h2.posts('crewIndex')], ['no-progress', 2]);
});

test('indexing errors stop the run without automatic retry; rate-limited sets the global cooldown', async () => {
  for (const [answer, stopped] of [[() => { throw networkError(); }, 'error:network'], [() => { throw timeoutError(); }, 'error:timeout'],
    [refusal('crew-unavailable'), 'error:crew-unavailable'], [{ ok: true, action: 'crewIndex' }, 'error:invalid-response'], [refusal('rate-limited'), 'rate-limited']]) {
    const h = harness({ handler: byAction({ crewIndex: answer, crew: crewAnswer() }) });
    const r = await h.svc.requestIndexing('manual');
    assert.deepEqual([r.calls, r.stopped], [1, stopped]);
    if (stopped === 'rate-limited') assert.equal(await code(h.svc.loadCrew(Q)), 'cooldown');
  }
  const h = harness({ handler: byAction({ crewIndex: refusal('crew-revoked') }) });
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'error:crew-revoked');
  assert.equal(h.grant(), null, 'access-ending refusal removes the grant');
  assert.deepEqual(h.events.map((e) => e.type), ['access-ended']);
});

// --- Enrollment ------------------------------------------------------------------------------------------

test('enroll: the grant is persisted (inflight) before the request; success activates it and starts indexing', async () => {
  let seenAtSend = null;
  const h = harness({
    enrolled: false,
    handler: byAction({
      crewEnroll: (body) => { seenAtSend = JSON.parse(h.storage.getItem(STORED)); return enrollAnswer(4); },
      crewIndex: indexAnswer({ processed: 0 }),
    }),
  });
  assert.deepEqual(await h.svc.enroll(`  ${CODE}  `), { enrolled: true });
  const sent = h.fake.bodies[0].body;
  assert.deepEqual(seenAtSend.grants.map((e) => [e.grant, e.role, e.inflight]), [[sent.grant, 'candidate', true]]);
  assert.equal(sent.code, CODE, 'trimmed');
  assert.deepEqual(h.entries().map((e) => [e.grant, e.role, e.G, e.inflight, e.unknown]), [[sent.grant, 'active', 4, false, false]]);
  await flush();
  assert.equal(h.posts('crewIndex'), 1, 'indexing requested after enrollment');
  assert.equal([...h.storage.map.values()].some((v) => v.includes(CODE)), false, 'the code is never stored');
});

test('enroll: bad codes are refused locally; storage failure sends nothing', async () => {
  const h = harness({ enrolled: false });
  for (const bad of ['', 'abc', 'x'.repeat(65), 'CODE\u0000X', 'CÖDE-1234', null]) assert.equal(await code(h.svc.enroll(bad)), 'bad-code');
  h.storage.faults.set = true;
  assert.equal(await code(h.svc.enroll(CODE)), 'storage');
  assert.equal(h.fake.bodies.length, 0);
});

test('enroll: transport failure keeps the candidate as unknown; the retry reuses the same grant', async () => {
  const h = harness({ enrolled: false, handler: byAction({ crewEnroll: (b, n) => { if (n === 1) throw networkError(); return enrollAnswer(1); }, crewIndex: indexAnswer({ processed: 0 }) }) });
  assert.equal(await code(h.svc.enroll(CODE)), 'network');
  assert.deepEqual(h.entries().map((e) => [e.role, e.unknown]), [['candidate', true]]);
  await h.svc.enroll(CODE);
  assert.equal(h.fake.bodies[0].body.grant, h.fake.bodies[1].body.grant);
  assert.equal(h.grant(), h.fake.bodies[0].body.grant);
});

test('enroll: definitive refusals remove a never-unknown candidate; busy / crew-unavailable / invalid answers keep it as unknown', async () => {
  for (const refused of ['unauthorized', 'enroll-closed', 'bad-request', 'crew-disabled', 'rate-limited', 'unknown-action']) {
    const h = harness({ enrolled: false, handler: byAction({ crewEnroll: refusal(refused) }) });
    assert.equal(await code(h.svc.enroll(CODE)), refused);
    assert.equal(h.storage.getItem(STORED), null, refused);
  }
  for (const answer of [refusal('busy'), refusal('crew-unavailable'), { ok: true }]) {
    const h = harness({ enrolled: false, handler: byAction({ crewEnroll: answer }) });
    await code(h.svc.enroll(CODE));
    assert.deepEqual(h.entries().map((e) => [e.role, e.unknown]), [['candidate', true]], JSON.stringify(answer));
  }
});

test('revoke: memory purged at once; deletion reported only on the backend confirmation', async () => {
  const h = harness({ handler: byAction({ crew: crewAnswer(), crewRevoke: revokeAnswer({ cacheCleared: false }) }) });
  await h.svc.loadCrew(Q);
  const grant = h.grant();
  const r = await h.svc.revoke();
  assert.deepEqual(r, { status: 'deleted', recorded: false, cacheCleared: false });
  const body = h.fake.bodies.at(-1).body;
  assert.deepEqual([body.action, body.grant, typeof body.revokeId], ['crewRevoke', grant, 'string']);
  assert.equal(h.storage.getItem(STORED), null);
  assert.equal(await code(h.svc.loadCrew(Q)), 'crew-not-enrolled', 'no cached answer survives');
  assert.deepEqual(await h.svc.revoke(), { status: 'nothing' });
});

test('network failure during deletion: pending, record kept, never "deleted"; a later resume succeeds', async () => {
  let fail = true;
  const h = harness({ handler: byAction({ crewRevoke: () => { if (fail) throw networkError(); return revokeAnswer({ recorded: true }); } }) });
  const first = await h.svc.revoke();
  assert.deepEqual(first, { status: 'pending', code: 'network' });
  assert.deepEqual(h.credentials.pendingRevoke(), { unresolved: 1, endpoints: [endpointFingerprint(ENDPOINT)] });
  const revokeId = h.entries()[0].revokeId;
  assert.equal(await code(h.svc.loadCrew(Q)), 'revoke-pending');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'revoke-pending');
  assert.equal(await code(h.svc.enroll(CODE)), 'revoke-pending');
  for (const answer of [refusal('revoke-incomplete'), refusal('busy'), refusal('unauthorized'), { ok: true }]) {
    const h2 = harness({ handler: byAction({ crewRevoke: answer }) });
    const r = await h2.svc.revoke();
    assert.equal(r.status, 'pending', JSON.stringify(answer));
    assert.ok(h2.credentials.pendingRevoke());
  }
  fail = false;
  const done = await h.svc.resumeRevoke();
  assert.deepEqual(done, { status: 'deleted', recorded: true, cacheCleared: true });
  const ids = h.fake.bodies.map((b) => b.body.revokeId);
  assert.deepEqual([new Set(ids).size, ids[0]], [1, revokeId], 'the retry uses the same revokeId');
  assert.equal(h.storage.getItem(STORED), null);
  assert.deepEqual(await h.svc.resumeRevoke(), { status: 'nothing' });
});

test('stale-request: a once-confirmed grant is dead at once -> superseded (never "deleted"); an unconfirmed one stays pending', async () => {
  const h = harness({ handler: byAction({ crewRevoke: refusal('stale-request') }) });
  assert.deepEqual(await h.svc.revoke(), { status: 'superseded' });
  assert.equal(h.storage.getItem(STORED), null);
  const u = harness({ enrolled: false, handler: byAction({ crewEnroll: () => { throw networkError(); }, crewRevoke: refusal('stale-request') }) });
  await code(u.svc.enroll(CODE));
  const r = await u.svc.revoke();
  assert.deepEqual(r, { status: 'pending', code: 'unresolved-enrollment', retryAfter: u.clock.t + REVOKE_RETRY_HINT_MS });
  u.clock.t += 365 * 86400000;
  assert.equal((await u.svc.resumeRevoke()).code, 'unresolved-enrollment', 'time never resolves it');
  assert.ok(u.credentials.pendingRevoke());
});

test('revoke: storage failure while recording the revocation sends nothing', async () => {
  const h = harness();
  h.storage.faults.set = true;
  assert.equal(await code(h.svc.revoke()), 'storage');
  assert.equal(h.fake.bodies.length, 0);
});

test('pending revocation survives sign-out (controller removeToken) and is resumed after signing in again', async () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId: 'revocation-test:0' };
  let online = false;
  const h = harness({ storage, store, access, handler: byAction({ crewRevoke: () => { if (!online) throw networkError(); return revokeAnswer(); } }) });
  const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
  const controller = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  assert.equal((await h.svc.revoke()).status, 'pending');
  assert.equal(controller.removeToken(), true);
  assert.equal(store.get(TOKEN_KEY), null);
  assert.ok(h.credentials.pendingRevoke(), 'kept through sign-out');
  // Signing in again (same or another token): the deletion can be completed.
  store.set(TOKEN_KEY, OTHER_TOKEN);
  controller.forgetContractData();
  h.state.access = { endpoint: ENDPOINT, token: OTHER_TOKEN, accessId: 'revocation-test:1' };
  assert.ok(h.credentials.pendingRevoke(), 'kept through the token change');
  online = true;
  assert.equal((await h.svc.resumeRevoke()).status, 'deleted');
  assert.equal(h.fake.bodies.at(-1).body.token, OTHER_TOKEN);
  assert.equal(storage.getItem(STORED), null);
});

// --- Controller and memory-only ----------------------------------------------------------------------------

test('controller purgeRoster (sign-out, token change, forget) purges crew memory and discards running answers', async () => {
  const gate = deferred();
  const storage = memoryStorage();
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  const h = harness({ storage, store, handler: async (body, n) => { if (n === 2) await gate.promise; return crewAnswer(); } });
  const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
  const controller = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  await h.svc.loadCrew(Q);
  const running = h.svc.loadCrew({ sectorId: SECTOR_2, date: DATE });
  await flush();
  controller.forgetRosterData();
  gate.resolve();
  assert.equal(await code(running), 'access-changed');
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 3, 'the cached answer was purged');
});

test('memory-only: crew answers never reach storage, IndexedDB, caches or the console', async () => {
  const touched = [];
  const saved = { indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'), caches: Object.getOwnPropertyDescriptor(globalThis, 'caches') };
  for (const name of ['indexedDB', 'caches']) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); return undefined; } });
  }
  const logged = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const original = Object.fromEntries(methods.map((m) => [m, console[m]]));
  for (const m of methods) console[m] = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const h = harness({
      enrolled: false,
      handler: byAction({
        crewEnroll: enrollAnswer(1),
        crewIndex: (b, n) => indexAnswer(n < 3 ? { processed: 2, pending: 3 } : { processed: 1, pending: 0, stale: 0, indexed: 9 }),
        crew: crewAnswer({ state: 'incomplete', reasons: ['missing-records'], indexingSuggested: true }),
      }),
    });
    await h.svc.enroll(CODE);
    await flush(20);
    await h.svc.loadCrew(Q);
    await flush(20);
    await h.svc.loadCrew({ sectorId: SECTOR_2, date: DATE }).catch(() => {});
    await flush(20);
    const grant = h.grant();
    assert.ok(grant);
    const keys = [...h.storage.map.keys()];
    assert.deepEqual(keys, [STORED], 'the grant record is the only stored crew key');
    const value = h.storage.getItem(STORED);
    assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['grants', 'phase', 'v']);
    assert.deepEqual(JSON.parse(value).grants.map((e) => Object.keys(e).sort().join()), ['G,at,bind,ep,grant,inflight,role,unknown']);
    for (const needle of [SECTOR, SECTOR_2, 'SAMPLE', 'ALEX', 'Example', 'BRIEN', 'ARCY', 'members', 'history', 'recorded', 'progress', DATE, CODE, TOKEN]) {
      assert.equal(value.includes(needle), false, needle);
    }
    assert.deepEqual(touched, [], 'IndexedDB and Cache Storage untouched');
    assert.equal(logged.length, 0, 'nothing logged');
    assert.ok(h.posts('crewIndex') >= 2);
  } finally {
    for (const m of methods) console[m] = original[m];
    for (const name of ['indexedDB', 'caches']) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
});

test('errors carry codes only: no grant, token, code or names in messages', async () => {
  const h = harness({ handler: byAction({ crew: refusal('sector-not-owned'), crewRevoke: () => { throw networkError(); } }) });
  const grant = h.grant();
  const err = await h.svc.loadCrew(Q).catch((e) => e);
  assert.equal(err.code, 'sector-not-owned');
  for (const text of [err.message, String(err.detail), JSON.stringify(err)]) {
    for (const needle of [grant, TOKEN, CODE, SECTOR]) assert.equal(text.includes(needle), false);
  }
  const r = await h.svc.revoke();
  assert.equal(JSON.stringify(r).includes(grant), false);
});

// --- Verification fixes (regression tests) -----------------------------------------------------------------

test('item 1: a refused re-enrollment keeps the working grant; a failed one keeps both; revoke covers both', async () => {
  const h = harness({ handler: byAction({ crewEnroll: refusal('unauthorized'), crew: crewAnswer(), crewRevoke: revokeAnswer() }) });
  const working = h.grant();
  assert.equal(await code(h.svc.enroll('WRONG-CODE-1234')), 'unauthorized');
  assert.equal(h.fake.bodies[0].body.grant === working, false, 'the enrollment used a candidate grant');
  assert.deepEqual(h.entries().map((e) => [e.grant, e.role]), [[working, 'active']]);
  await h.svc.loadCrew(Q);
  assert.equal(h.fake.bodies.at(-1).body.grant, working, 'lookups still use the working grant');
  const h2 = harness({ handler: byAction({ crewEnroll: () => { throw networkError(); }, crewRevoke: (body) => (body.grant === active ? revokeAnswer() : refusal('stale-request')) }) });
  const active = h2.grant();
  assert.equal(await code(h2.svc.enroll(CODE)), 'network');
  assert.equal(h2.entries().length, 2, 'candidate kept as potentially live');
  assert.equal(h2.credentials.activeGrant(h2.state.access), active, 'the old grant stays active until confirmation');
  const r = await h2.svc.revoke();
  assert.deepEqual(h2.fake.bodies.filter((b) => b.body.action === 'crewRevoke').map((b) => b.body.grant === active), [true, false], 'active first, then the candidate');
  assert.deepEqual([r.status, r.code], ['pending', 'unresolved-enrollment'], 'the unconfirmed candidate stays unresolved');
  h2.clock.t += 30 * 86400000;
  assert.equal((await h2.svc.resumeRevoke()).code, 'unresolved-enrollment', 'client time never resolves it');
  assert.ok(h2.entries().some((e) => e.role === 'candidate' && !e.resolved));
  assert.ok(h2.entries().some((e) => e.grant === active && e.resolved === 'deleted'));
  const h3 = harness({ handler: byAction({ crewEnroll: enrollAnswer(5), crewIndex: indexAnswer({ processed: 0 }) }) });
  const old = h3.grant();
  await h3.svc.enroll(CODE);
  await flush();
  assert.deepEqual(h3.entries().map((e) => [e.grant, e.G]), [[h3.fake.bodies[0].body.grant, 5]]);
  assert.notEqual(h3.grant(), old);
});

test('item 2 / batch 3 item 5: a pending deletion is sent only to its own endpoint; elsewhere it stays fail-closed', async () => {
  const OTHER_ENDPOINT = `https://script.google.com/macros/s/${'B'.repeat(30)}/exec`;
  const h = harness({ handler: byAction({ crewRevoke: (body, n) => { if (n === 1) throw networkError(); return revokeAnswer(); }, crewEnroll: enrollAnswer(1) }) });
  assert.deepEqual(await h.svc.revoke(), { status: 'pending', code: 'network' });
  const pending = h.credentials.read();
  h.state.access = { endpoint: OTHER_ENDPOINT, token: OTHER_TOKEN, accessId: h.id('other') };
  assert.deepEqual(await h.svc.resumeRevoke(), { status: 'pending', code: 'revoke-pending-elsewhere' });
  assert.equal(h.fake.bodies.length, 1, 'the grant never reaches another backend');
  assert.deepEqual(h.credentials.read(), pending, 'record kept');
  assert.equal(await code(h.svc.enroll(CODE)), 'revoke-pending-elsewhere');
  assert.equal(await code(h.svc.loadCrew(Q)), 'revoke-pending-elsewhere');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'revoke-pending-elsewhere');
  // Back on the original endpoint (another token is fine): sent there and confirmed.
  h.state.access = { endpoint: ENDPOINT, token: OTHER_TOKEN, accessId: h.id('back') };
  assert.equal((await h.svc.resumeRevoke()).status, 'deleted');
  assert.deepEqual([h.fake.bodies[1].endpoint, h.fake.bodies[1].body.token], [ENDPOINT, OTHER_TOKEN]);
  assert.equal(h.credentials.pendingRevoke(), null);
});

test('item 4: a token change in another tab (controller.accessChanged) purges crew memory, also for an A->B->A flip', async () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  const h = harness({ storage, store, handler: byAction({ crew: crewAnswer(), crewEnroll: enrollAnswer(2), crewIndex: indexAnswer({ processed: 0 }) }) });
  h.state.access = { endpoint: ENDPOINT, token: TOKEN, accessId: 'flip-test' };   // an id that does not move on A->B->A
  await h.credentials.dropAccess();
  await h.credentials.beginEnroll(h.state.access);
  await h.credentials.confirmEnroll(h.state.access, 1);
  const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
  const controller = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  await h.svc.loadCrew(Q);
  controller.accessChanged();                   // a storage event from another tab: memory is purged
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2, 'accessChanged purged the cached answer');
  store.set(TOKEN_KEY, OTHER_TOKEN);
  controller.accessChanged();
  store.set(TOKEN_KEY, TOKEN);
  controller.accessChanged();
  assert.equal(h.credentials.read(), null, 'the grant bound to A was removed while B was current');
  await h.svc.enroll(CODE);
  await flush();
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 3, 'the old answer was not served from memory');
});

test('item 4/8c: entries of another access id or past the TTL are swept on every service call', async () => {
  const h = harness({ handler: () => crewAnswer() });
  await h.svc.loadCrew(Q);
  const original = h.state.access;
  h.state.access = { ...original, accessId: h.id('x') };
  h.svc.indexingStatus();                       // any call sweeps
  h.state.access = original;
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 2, 'the entry of the other access id was dropped');
  h.clock.t += CREW_TTL_MS;
  h.svc.noteOnline(true);
  h.clock.t -= CREW_TTL_MS;                     // even if the clock is read again earlier, the entry is gone
  await h.svc.loadCrew(Q);
  assert.equal(h.posts('crew'), 3, 'expired entries are swept by noteOnline as well');
});

test('item 5: budget, cooldowns, run throttle and suspension are app-wide across service instances', async () => {
  const h = harness({ handler: byAction({ crew: () => crewAnswer(), crewIndex: indexAnswer({ processed: 0 }) }) });
  const other = h.make();
  for (let i = 0; i < CREW_CALL_BUDGET / 2; i += 1) {
    await h.svc.loadCrew(Q, { force: true });
    await other.loadCrew(Q, { force: true });
  }
  assert.equal(await code(h.svc.loadCrew(Q, { force: true })), 'local-limit');
  assert.equal(await code(other.loadCrew(Q, { force: true })), 'local-limit');
  purgeCrewMemory();
  assert.equal(await code(other.loadCrew(Q, { force: true })), 'local-limit', 'a purge never resets the budget');
  assert.equal(h.fake.bodies.length, CREW_CALL_BUDGET);
  // Rate cooldown set through one instance blocks the other, also after a purge.
  const r = harness({ handler: byAction({ crew: refusal('rate-limited') }) });
  const r2 = r.make();
  await code(r.svc.loadCrew(Q));
  purgeCrewMemory();
  assert.equal(await code(r2.loadCrew(Q)), 'cooldown');
  // Busy cooldown and run throttle are shared too.
  const b = harness({ handler: byAction({ crewIndex: refusal('busy') }) });
  await b.svc.requestIndexing('manual');
  assert.equal((await b.make().requestIndexing('manual')).stopped, 'cooldown');
  const t = harness({ handler: byAction({ crewIndex: indexAnswer({ processed: 0 }) }) });
  for (let i = 0; i < INDEX_MAX_RUNS; i += 1) await t.make().requestIndexing('manual');
  assert.equal((await t.make().requestIndexing('manual')).stopped, 'throttled');
  // Suspension is shared, and an access-id change clears it.
  const s = harness({ handler: byAction({ crew: (body, n) => (n === 1 ? refusal('unauthorized') : crewAnswer()) }) });
  const s2 = s.make();
  await code(s.svc.loadCrew(Q));
  assert.equal(await code(s2.loadCrew(Q)), 'suspended');
  purgeCrewMemory();
  assert.equal(await code(s2.loadCrew(Q)), 'suspended', 'a purge does not lift the suspension');
  s.state.access = { ...s.state.access, accessId: s.id('new') };
  await s2.loadCrew(Q);
  assert.equal(s.posts('crew'), 2);
});

test('item 8a: leaving Settings stops enroll/manual runs, never a detail run', async () => {
  const h = harness({ abortable: true, handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 5 }) }) });
  const run = h.svc.requestIndexing('manual');
  await flush();
  h.svc.leaveSettings();
  assert.deepEqual([(await run).calls, (await run).stopped], [1, 'cancelled']);
  const detail = h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  await flush();
  h.svc.leaveSettings();
  assert.equal(h.svc.indexingStatus().running, true, 'a detail run is not stopped by leaving Settings');
  h.svc.leaveDetail(SECTOR);
  assert.equal((await detail).stopped, 'cancelled');
});

test('item 8b: index-incompatible suspends indexing only; crew lookups continue', async () => {
  for (const source of ['crew', 'crewIndex']) {
    const h = harness({
      handler: byAction({
        crew: (body, n) => (source === 'crew' && n === 1 ? refusal('index-incompatible') : crewAnswer()),
        crewIndex: refusal('index-incompatible'),
      }),
    });
    if (source === 'crew') assert.equal(await code(h.svc.loadCrew(Q)), 'index-incompatible');
    else assert.equal((await h.svc.requestIndexing('manual')).stopped, 'suspended');
    assert.equal((await h.svc.requestIndexing('manual')).stopped, 'suspended', `${source}: indexing suspended`);
    await h.svc.loadCrew(Q, { force: true });
    assert.equal(h.svc.indexingStatus().running, false);
    assert.notEqual(h.grant(), null);
  }
});

// --- Correction batch 3: orphaned grants, deletion recovery, isolation (simulated backend) ---------------------

/**
 * A harness whose backend is the real simulated handler set (CrewApiV2.gs). `plan[action]` holds one-shot
 * steps (body, deliver) => answer: deliver() hands the request to the backend; a step may lose the answer,
 * hold the request, or never deliver it.
 */
async function simulated() {
  let h = null;
  const bclock = { t: 0 };                       // the backend clock, separate from the client clock
  // Earlier protocol (before Phase 1d.2A): these tests pin the stale-request rules; cancellation is in crew-cancel.
  const sim = await simulatedCrewBackend({ now: () => bclock.t, legacyRevoke: true });
  const plan = {};
  h = harness({
    enrolled: false,
    handler: async (body) => {
      const step = plan[body.action]?.shift();
      return step ? step(body, () => sim.handle(body)) : sim.handle(body);
    },
  });
  bclock.t = h.clock.t;
  return { h, sim, plan, bclock };
}

/**
 * Invariant (every deletion result): never `backend active && frontend nothing|deleted|superseded`, and
 * never `backend active && no record`.
 */
async function deletion(h, sim, promise) {
  const r = await promise;
  const recordGone = !h.storage.map.has(STORED);   // the raw map: unaffected by injected read faults
  if (sim.phase() === 'active') {
    assert.equal(['deleted', 'superseded', 'nothing'].includes(r.status), false, `reported ${r.status} while the backend is active`);
    assert.equal(recordGone, false, 'record removed while the backend is active');
  }
  return r;
}
const lose = (body, deliver) => { deliver(); throw networkError(); };          // processed, answer lost
const undelivered = () => { throw timeoutError(); };                            // never reached the backend
/** "The app closes": every in-memory state is dropped; new credentials and service over the SAME storage. */
function restart(h) {
  purgeCrewMemory();
  const credentials = createCrewCredentials({ store: createStore(h.storage), random: seqRandom(77), now: () => h.clock.t });
  const svc = createCrewService({
    credentials, access: () => h.state.access, post: h.fake.post, now: () => h.clock.t,
    sleep: async (ms) => { h.clock.t += ms; }, isVisible: () => true, isOnline: () => true,
  });
  return { credentials, svc };
}
const storedText = (h) => [...h.storage.map.values()].join('\n');
function assertNoCrewData(h) {
  assert.deepEqual([...h.storage.map.keys()].filter((k) => k !== `fc.v2.${CREW_CREDENTIAL_KEY}`), []);
  for (const needle of ['SAMPLE', 'PERSON', 'members', 'history', 's_', CODE]) assert.equal(storedText(h).includes(needle), false, needle);
}

test('E2E recovery: enrollment lost, revoke times out, app restarts, deletion resumed and confirmed by the backend', async () => {
  const { h, sim, plan } = await simulated();
  // 1. Enrollment succeeds on the backend, its response is lost.
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  assert.equal(await code(h.svc.enroll(CODE)), 'network');
  assert.equal(sim.phase(), 'active');
  assert.deepEqual(h.entries().map((e) => [e.role, e.unknown]), [['candidate', true]]);
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'crew-not-enrolled', 'an unconfirmed grant is never used');
  // 2-3. The user turns Crew Intelligence off; the first deletion request times out.
  plan.crewRevoke = [undelivered];
  assert.deepEqual(await deletion(h, sim, h.svc.revoke()), { status: 'pending', code: 'timeout' });
  assert.equal(sim.phase(), 'active', 'nothing was deleted yet, and nothing was reported deleted');
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'revoke-pending');
  assertNoCrewData(h);
  // 4-5. The app closes and restarts.
  const after = restart(h);
  assert.equal(await code(after.svc.loadCrew(sim.query(1))), 'revoke-pending');
  assert.equal((await after.svc.requestIndexing('manual')).stopped, 'revoke-pending');
  assert.equal(await code(after.svc.enroll(CODE)), 'revoke-pending');
  assert.equal(after.credentials.read().phase, 'revoking');
  assertNoCrewData(h);
  // 6-9. Resumed against the original endpoint; the backend confirms; the record goes only now.
  const done = await deletion(h, sim, after.svc.resumeRevoke());
  assert.equal(done.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.deepEqual(sim.crewKeys(), []);
  assert.equal(h.storage.getItem(STORED), null);
  assert.equal(await code(after.svc.loadCrew(sim.query(1))), 'crew-not-enrolled');
});

test('orphaning d1a: a refused re-enrollment keeps the live grant, and revoking it deletes the backend data', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  const working = h.grant();
  sim.issueCode('SECOND-CODE-5678');
  assert.equal(await code(h.svc.enroll('WRONG-CODE-0000')), 'unauthorized');
  assert.deepEqual(h.entries().map((e) => [e.grant, e.role]), [[working, 'active']]);
  assert.equal((await h.svc.loadCrew(sim.query(1))).sectorId, sim.query(1).sectorId, 'the live grant still works');
  const r = await deletion(h, sim, h.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('orphaning d1b: re-enrollment succeeded but its answer was lost (and a typo retry was refused); deletion reaches the live candidate', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  const working = h.grant();
  sim.issueCode('SECOND-CODE-5678');
  plan.crewEnroll = [lose];
  assert.equal(await code(h.svc.enroll('SECOND-CODE-5678')), 'network');
  const candidate = h.entries().find((e) => e.role === 'candidate').grant;
  // The backend now holds the candidate: the old grant is refused ('unauthorized', which suspends crew calls;
  // the enrollment's indexing run may already have met that refusal).
  assert.ok(['unauthorized', 'suspended'].includes(await code(h.svc.loadCrew(sim.query(1)))));
  assert.equal(await code(h.svc.enroll('SECOND-CODX-5678')), 'enroll-closed', 'typo retry: refused');
  const typoGrant = h.fake.bodies.filter((b) => b.body.action === 'crewEnroll').at(-1).body.grant;
  assert.notEqual(typoGrant, candidate, 'one grant <-> one code: another code never re-sends the unknown candidate');
  assert.equal(h.entries().some((e) => e.grant === typoGrant), false, 'the typo attempt was refused and never unknown: removed');
  assert.ok(h.entries().some((e) => e.grant === candidate), 'never dropped: an earlier attempt activated it');
  const r = await deletion(h, sim, h.svc.revoke());
  assert.equal(r.status, 'deleted', 'the confirmed old grant is dead (stale-request), the live candidate deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
  assert.ok(h.fake.bodies.some((b) => b.body.action === 'crewRevoke' && b.body.grant === working));
});

test('orphaning d4A: deletion requested while the first enrollment is still in flight waits for it, then deletes', async () => {
  const { h, sim, plan } = await simulated();
  const gate = deferred();
  sim.issueCode(CODE);
  plan.crewEnroll = [async (body, deliver) => { await gate.promise; return deliver(); }];
  const enrolling = h.svc.enroll(CODE).catch((e) => e.code);
  await flush();
  const revoking = h.svc.revoke();
  await flush();
  assert.equal(h.posts('crewRevoke'), 0, 'deletion waits for the enrollment in flight');
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'revoke-pending');
  assert.equal(await code(h.svc.enroll(CODE)), 'revoke-pending', 'no new enrollment once deletion was requested');
  gate.resolve();
  assert.equal((await deletion(h, sim, revoking)).status, 'deleted');
  await enrolling;
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('orphaning d4B: deletion requested while a re-enrollment answer is delayed deletes the newly live grant', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  sim.issueCode('SECOND-CODE-5678');
  const gate = deferred();
  plan.crewEnroll = [async (body, deliver) => { const answer = deliver(); await gate.promise; return answer; }];
  const enrolling = h.svc.enroll('SECOND-CODE-5678').catch((e) => e.code);
  await flush();
  const revoking = h.svc.revoke();
  await flush();
  assert.equal(h.posts('crewRevoke'), 0);
  gate.resolve();
  const r = await deletion(h, sim, revoking);
  await enrolling;
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('late arrival: an enrollment delivered AFTER a revoke keeps the deletion pending until a final revoke resolves it', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  let held = null;
  plan.crewEnroll = [(body) => { held = body; throw timeoutError(); }];
  assert.equal(await code(h.svc.enroll(CODE)), 'timeout');
  const first = await deletion(h, sim, h.svc.revoke());
  assert.equal(first.code, 'unresolved-enrollment', 'stale-request for an unconfirmed candidate proves nothing');
  assert.equal(sim.phase(), 'none');
  sim.handle(held);                                   // the delayed enrollment finally reaches the backend
  assert.equal(sim.phase(), 'active');
  assert.ok(h.credentials.pendingRevoke(), 'still pending');
  assert.equal((await deletion(h, sim, h.svc.resumeRevoke())).status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
  // Never delivered: never resolved by time; pending (nothing claimed deleted or superseded).
  const other = await simulated();
  other.sim.issueCode(CODE);
  other.plan.crewEnroll = [undelivered];
  await code(other.h.svc.enroll(CODE));
  const pending = await deletion(other.h, other.sim, other.h.svc.revoke());
  assert.equal(pending.status, 'pending');
  other.h.clock.t += 30 * 86400000;
  assert.equal((await deletion(other.h, other.sim, other.h.svc.resumeRevoke())).status, 'pending');
  assert.notEqual(other.h.storage.getItem(STORED), null);
});

test('isolation: a run of a previous grant is detached; its late answer never reaches the new identity', async () => {
  const gate = deferred();
  let n = 0;
  const h = harness({ handler: byAction({ crewIndex: async () => { n += 1; if (n === 1) await gate.promise; return indexAnswer({ processed: 1, indexed: 7, pending: 2, stale: 0, uncovered: 0 }); } }) });
  const r1 = h.svc.requestIndexing('manual');
  await flush();
  purgeCrewMemory();                                         // access A ends
  h.state.access = { endpoint: ENDPOINT, token: OTHER_TOKEN, accessId: h.id('B') };
  await h.credentials.reconcile(h.state.access);
  const next = await h.credentials.beginEnroll(h.state.access);
  await h.credentials.settleEnroll(next.grant, 'ok', 2);
  const r2 = h.svc.requestIndexing('manual');
  assert.notEqual(r2, r1, 'never another identity\'s promise');
  await flush();
  assert.equal(h.fake.bodies[1].body.grant, next.grant);
  gate.resolve();
  const old = await r1;
  assert.deepEqual([old.processed, old.progress, old.stopped], [0, null, 'cancelled']);
  const fresh = await r2;
  assert.equal(h.events.filter((e) => e.type === 'progress').length, fresh.calls, 'progress events of the new run only');
  assert.deepEqual(h.svc.indexingStatus().lastProgress, { ...fresh.progress, at: h.clock.t });
  // Joining is by identity: same access, generation and grant only.
  const g2 = deferred();
  const j = harness({ handler: byAction({ crewIndex: async () => { await g2.promise; return indexAnswer({ processed: 0 }); } }) });
  const a = j.svc.requestIndexing('manual');
  assert.equal(j.svc.requestIndexing('detail'), a);
  j.state.access = { ...j.state.access, accessId: j.id('other') };
  await j.credentials.reconcile(j.state.access);
  assert.notEqual(j.svc.requestIndexing('manual'), a);
  g2.resolve();
  assert.equal((await a).stopped, 'cancelled');
});

test('busy on the final permitted call: indexing cooldown, stop busy, no extra call; allowed again after the cooldown', async () => {
  let n = 0;
  const h = harness({ handler: byAction({ crewIndex: () => { n += 1; return n === INDEX_MAX_CALLS.detail ? refusal('busy') : indexAnswer({ processed: 1, pending: Math.max(1, 6 - n) }); } }) });
  const r = await h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  assert.deepEqual([r.calls, r.stopped], [INDEX_MAX_CALLS.detail, 'busy']);
  assert.deepEqual(h.sleeps, [INDEX_SPACING_MS, INDEX_SPACING_MS], 'no busy retry beyond the limit');
  assert.equal(h.svc.indexingStatus().cooldownUntil, h.clock.t + BUSY_COOLDOWN_MS);
  assert.equal((await h.svc.requestIndexing('detail', { sectorKey: SECTOR })).stopped, 'cooldown');
  assert.equal(h.posts('crewIndex'), INDEX_MAX_CALLS.detail);
  h.clock.t += BUSY_COOLDOWN_MS;
  const later = await h.svc.requestIndexing('detail', { sectorKey: SECTOR });
  assert.ok(later.calls >= 1);
});

test('item 6: a foreign credential record blocks every crew operation locally and is never touched', async () => {
  const h = harness({ enrolled: false, handler: () => assert.fail('nothing may be sent') });
  const value = JSON.stringify({ v: 2, phase: 'active', grants: [{ grant: 'opaque' }] });
  h.storage.setItem(STORED, value);
  assert.equal(await code(h.svc.loadCrew(Q)), 'credential-unsupported');
  assert.equal(await code(h.svc.enroll(CODE)), 'credential-unsupported');
  assert.equal(await code(h.svc.revoke()), 'credential-unsupported');
  assert.equal(await code(h.svc.resumeRevoke()), 'credential-unsupported');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'credential-unsupported');
  assert.equal(h.fake.bodies.length, 0);
  assert.equal(h.storage.getItem(STORED), value);
});

// --- Correction batch 4 (third review): no time-based resolution, budget inside the queue, completion identity ---

test('P0-1: a historical "recorded" ack for grant A never resolves grant B; B is revoked on its backend', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);                                    // A active
  await flush(20);
  const A = h.grant();
  sim.issueCode('SECOND-CODE-5678');
  let heldB = null;
  plan.crewEnroll = [(body) => { heldB = body; throw timeoutError(); }];
  assert.equal(await code(h.svc.enroll('SECOND-CODE-5678')), 'timeout');   // B: backend has not processed it
  plan.crewRevoke = [lose];                                    // revoke A succeeds on the backend, answer lost
  const first = await deletion(h, sim, h.svc.revoke());
  assert.equal(first.status, 'pending');
  assert.equal(sim.phase(), 'deleted');
  sim.handle(heldB);                                           // B finally arrives and activates
  assert.equal(sim.phase(), 'active');
  h.clock.t += 2 * 3600000;                                    // client time proves nothing
  const r = await deletion(h, sim, h.svc.resumeRevoke());
  const revokes = h.fake.bodies.filter((b) => b.body.action === 'crewRevoke');
  assert.ok(revokes.some((b) => b.body.grant === heldB.grant), 'B was explicitly revoked');
  assert.ok(revokes.some((b) => b.body.grant === A));
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('P0-1 variant: B\'s revoke fails in transport -> pending, B kept in the record, never "deleted"', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  await flush(20);
  sim.issueCode('SECOND-CODE-5678');
  let heldB = null;
  plan.crewEnroll = [(body) => { heldB = body; throw timeoutError(); }];
  await code(h.svc.enroll('SECOND-CODE-5678'));
  plan.crewRevoke = [lose];
  await deletion(h, sim, h.svc.revoke());
  sim.handle(heldB);
  h.clock.t += 2 * 3600000;
  plan.crewRevoke = [(body, deliver) => (body.grant === heldB.grant ? undelivered() : deliver()), (body, deliver) => (body.grant === heldB.grant ? undelivered() : deliver())];
  const r = await deletion(h, sim, h.svc.resumeRevoke());
  assert.equal(r.status, 'pending');
  assert.equal(sim.phase(), 'active');
  assert.ok(h.entries().some((e) => e.grant === heldB.grant && !e.resolved), 'B kept, unresolved');
});

test('P0-2: a held enrollment is never declared dead by client time; delivered later, it is deleted', async () => {
  const { h, sim, plan, bclock } = await simulated();
  sim.issueCode(CODE);
  let held = null;
  plan.crewEnroll = [(body) => { held = body; throw timeoutError(); }];
  assert.equal(await code(h.svc.enroll(CODE)), 'timeout');
  h.clock.t += 21 * 60000;                                     // client clock +21 min
  bclock.t += 60000;                                           // backend clock +1 min
  const first = await deletion(h, sim, h.svc.revoke());
  assert.equal(first.status, 'pending');
  assert.equal(first.code, 'unresolved-enrollment');
  assert.notEqual(h.storage.getItem(STORED), null);
  sim.handle(held);                                            // the held enrollment activates
  assert.equal(sim.phase(), 'active');
  const done = await deletion(h, sim, h.svc.resumeRevoke());
  assert.equal(done.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('P0-2: a request that never arrives keeps deletion pending forever, whatever the client clock says', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [undelivered];
  await code(h.svc.enroll(CODE));
  for (const jump of [0, 21 * 60000, 3 * 86400000, 30 * 86400000]) {
    h.clock.t += jump;
    const r = await deletion(h, sim, jump === 0 ? h.svc.revoke() : h.svc.resumeRevoke());
    assert.equal(r.status, 'pending');
    assert.notEqual(h.storage.getItem(STORED), null, 'record present');
    assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'revoke-pending');
    assert.equal(await code(h.svc.enroll(CODE)), 'revoke-pending');
  }
});

test('P1-3: 21 enrollments queued at once -> at most CREW_CALL_BUDGET dispatched, the rest refused locally', async () => {
  const h = harness({ enrolled: false, handler: byAction({ crewEnroll: refusal('unauthorized') }) });
  const all = await Promise.all(Array.from({ length: CREW_CALL_BUDGET + 1 }, () => code(h.svc.enroll(CODE))));
  assert.equal(h.posts('crewEnroll'), CREW_CALL_BUDGET);
  assert.deepEqual(all.filter((c) => c === 'local-limit').length, 1);
});

test('P1-3: two queued enrollments, the first answered rate-limited -> the second is not sent', async () => {
  const h = harness({ enrolled: false, handler: byAction({ crewEnroll: refusal('rate-limited') }) });
  const [a, b] = await Promise.all([code(h.svc.enroll(CODE)), code(h.svc.enroll(CODE))]);
  assert.deepEqual([a, b], ['rate-limited', 'cooldown']);
  assert.equal(h.posts('crewEnroll'), 1);
});

test('P1-4: an access change during the spacing pause (no purge) yields no event and no foreign progress', async () => {
  const h = harness({ abortable: true, handler: byAction({ crewIndex: indexAnswer({ processed: 1, pending: 4 }) }) });
  const run = h.svc.requestIndexing('manual');
  await flush();
  assert.deepEqual(h.events.map((e) => e.type), ['progress']);
  h.state.access = { ...h.state.access, accessId: h.id('changed') };   // no purgeCrewMemory()
  h.wake();
  const r = await run;
  assert.deepEqual(h.events.map((e) => e.type), ['progress'], 'no indexed/progress event after the change');
  assert.deepEqual([r.stopped, r.progress, r.processed], ['access-changed', null, 0]);
  assert.equal(h.svc.indexingStatus().lastProgress, null);
});

test('one grant <-> one code: only a same-code retry in this session re-sends a grant; another code or a restart gets a new one', async () => {
  const h = harness({ enrolled: false, handler: byAction({ crewEnroll: () => { throw networkError(); } }) });
  await code(h.svc.enroll(CODE));
  await code(h.svc.enroll(`  ${CODE} `));
  const grants = () => h.fake.bodies.map((b) => b.body.grant);
  assert.equal(grants()[1], grants()[0], 'same code: same grant (idempotent on the backend)');
  await code(h.svc.enroll('OTHER-CODE-9999'));
  assert.notEqual(grants()[2], grants()[0], 'another code: a new candidate');
  await code(h.svc.enroll(CODE));
  assert.notEqual(grants()[3], grants()[0], 'the marker follows the latest attempt only');
  assert.equal(h.entries().filter((e) => e.unknown).length, 3, 'every unknown candidate is kept');
  assert.equal(await code(h.svc.enroll('FOURTH-CODE-0000')), 'candidate-limit', 'limit reached: refused, none dropped');
  assert.equal(h.fake.bodies.length, 4);
  assert.equal(storedText(h).includes(CODE), false, 'neither the code nor a hash of it is stored');
  const r = harness({ enrolled: false, handler: byAction({ crewEnroll: () => { throw networkError(); } }) });
  await code(r.svc.enroll(CODE));
  purgeCrewMemory();                                         // e.g. an app restart: the in-memory marker is gone
  await code(r.svc.enroll(CODE));
  assert.notEqual(r.fake.bodies[1].body.grant, r.fake.bodies[0].body.grant, 'after a restart a new grant is created');
});

// --- Correction batch 5 (fourth review): enrollment persistence failures never lose a potentially live grant ---

const failUnknownWrite = (k, v) => k === STORED && v.includes('"unknown":true');

for (const later of ['rate-limited', 'unauthorized']) {
  test(`storage fault (review 4 exact): unknown:true not persisted, same-code retry answered ${later} -> the grant is kept and deleted only on backend confirmation`, async () => {
    const { h, sim, plan } = await simulated();
    sim.issueCode(CODE);
    plan.crewEnroll = [lose];                                  // 1-2: enrollment succeeds, answer lost
    h.storage.faults.set = failUnknownWrite;                   // 3: persisting unknown:true fails
    assert.equal(await code(h.svc.enroll(CODE)), 'network');
    assert.equal(sim.phase(), 'active');
    h.storage.faults.set = false;                              // 4: storage restored
    plan.crewEnroll = [() => refusal(later)];                  // 5-6: same-code retry refused
    assert.equal(await code(h.svc.enroll(CODE)), later);
    assert.notEqual(h.storage.getItem(STORED), null, 'the potentially live grant is kept');
    assert.ok(h.entries().some((e) => e.unknown && !e.resolved), 'recorded as unknown');
    const r = await deletion(h, sim, h.svc.revoke());          // 7
    assert.equal(r.status, 'deleted');
    assert.equal(sim.phase(), 'deleted');
    assert.equal(h.storage.getItem(STORED), null);
  });
}

test('storage fault: while storage stays unavailable every operation refuses `storage`, sends nothing and keeps the grant', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  h.storage.faults.set = failUnknownWrite;
  await code(h.svc.enroll(CODE));
  h.storage.faults.set = true;                                 // still not writable
  const sent = h.fake.bodies.length;
  const before = h.storage.getItem(STORED);
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'storage');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'storage');
  assert.equal(await code(h.svc.enroll(CODE)), 'storage');
  assert.equal(await code(h.svc.revoke()), 'storage');
  assert.equal(await code(h.svc.resumeRevoke()), 'storage');
  assert.equal(h.fake.bodies.length, sent, 'nothing sent');
  assert.equal(h.storage.getItem(STORED), before, 'the grant is never discarded');
  assert.equal(sim.phase(), 'active');
  // Writable again: the first operation folds the unsettled attempt into unknown:true and clears the fault.
  h.storage.faults.set = false;
  const r = await deletion(h, sim, h.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
});

test('storage fault: the same-code retry happens only after the recovery fold is durable (unknown:true at send time)', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  h.storage.faults.set = failUnknownWrite;
  await code(h.svc.enroll(CODE));
  const first = h.entries()[0].grant;
  assert.deepEqual([h.entries()[0].inflight, h.entries()[0].unknown], [true, false], 'the unknown write failed');
  h.storage.faults.set = false;
  let atSend = null;
  plan.crewEnroll = [(body) => { atSend = JSON.parse(h.storage.getItem(STORED)).grants; return refusal('unauthorized'); }];
  await code(h.svc.enroll(CODE));
  const original = atSend.find((e) => e.grant === first);
  assert.deepEqual([original.unknown, original.inflight], [true, false], 'folded before the retry was dispatched');
  assert.notEqual(h.fake.bodies.at(-1).body.grant, first, 'no reuse of the marker after a storage fault (a new candidate)');
  assert.ok(h.entries().some((e) => e.grant === first && e.unknown));
  assert.equal((await deletion(h, sim, h.svc.revoke())).status, 'deleted');
});

test('storage fault: recovery once writable writes the fold and clears the fault', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  h.storage.faults.set = failUnknownWrite;
  await code(h.svc.enroll(CODE));
  h.storage.faults.set = false;
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'crew-not-enrolled', 'the operation proceeds (no `storage`)');
  assert.deepEqual(h.entries().map((e) => [e.unknown, e.inflight]), [[true, false]], 'fold written');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'not-enrolled', 'fault cleared');
  assert.equal((await deletion(h, sim, h.svc.revoke())).status, 'deleted');
});

test('storage fault: after an application restart the persisted inflight flag is still potentially live; deletion completes', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  h.storage.faults.set = failUnknownWrite;
  await code(h.svc.enroll(CODE));
  h.storage.faults.set = false;
  __resetCrewStateForTests();                                    // the in-memory fault flag is gone
  const after = restart(h);
  assert.deepEqual(after.credentials.read().grants.map((e) => [e.inflight, e.unknown]), [[true, false]]);
  assert.equal(await code(after.svc.enroll('OTHER-CODE-9999')), 'enroll-closed', 'the code was consumed by the first attempt');
  assert.ok(after.credentials.read().grants.some((e) => e.unknown), 'the first operation folded it into unknown');
  const r = await deletion(h, sim, after.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('storage fault: an enrollment is never dispatched when its inflight write fails', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  h.storage.faults.set = true;
  assert.equal(await code(h.svc.enroll(CODE)), 'storage');
  assert.equal(h.fake.bodies.length, 0, 'post never called');
  assert.equal(sim.phase(), 'none');
  h.storage.faults.set = false;
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'crew-not-enrolled', 'recovered: nothing of ours to keep');
});

// --- Correction batch 6: an unreadable credential record is never treated as absent -------------------------

/** Makes reads of the crew record throw while `flag.on` (other keys stay readable). */
function unreadable(h, on = true) {
  const flag = { on };
  h.storage.faults.get = (k) => { if (flag.on && k === STORED) throw new Error('SecurityError'); return undefined; };
  return flag;
}

test('unreadable storage (red first): an active backend grant is never answered `nothing`; deletion completes once readable', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  assert.equal(sim.phase(), 'active');
  const before = h.storage.map.get(STORED);
  const flag = unreadable(h);
  assert.equal(await code(deletion(h, sim, h.svc.revoke())), 'storage-unreadable');
  assert.equal(await code(h.svc.resumeRevoke()), 'storage-unreadable');
  assert.equal(h.posts('crewRevoke'), 0, 'no revoke sent while unreadable');
  assert.equal(h.storage.map.get(STORED), before, 'never removed or overwritten');
  flag.on = false;
  const r = await deletion(h, sim, h.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
});

test('unreadable storage: before any enrollment nothing is dispatched or written', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  const flag = unreadable(h);
  assert.equal(await code(h.svc.enroll(CODE)), 'storage-unreadable');
  assert.equal(h.fake.bodies.length, 0);
  assert.equal(h.storage.map.has(STORED), false, 'nothing written');
  assert.equal(sim.phase(), 'none');
  flag.on = false;
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'crew-not-enrolled', 'readable again: operations resume');
});

test('unreadable storage: a same-code retry is not dispatched; the unknown candidate is still there once readable', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  await code(h.svc.enroll(CODE));
  const candidate = h.entries()[0].grant;
  const flag = unreadable(h);
  const sent = h.fake.bodies.length;
  assert.equal(await code(h.svc.enroll(CODE)), 'storage-unreadable');
  assert.equal(h.fake.bodies.length, sent, 'no dispatch');
  flag.on = false;
  assert.ok(h.entries().some((e) => e.grant === candidate && e.unknown), 'preserved');
  assert.equal((await deletion(h, sim, h.svc.revoke())).status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
});

test('unreadable storage: becoming unreadable inside the queue just before dispatch refuses the enrollment', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  const flag = unreadable(h, false);
  const pending = h.svc.enroll(CODE);                          // entry checks pass while readable
  flag.on = true;                                              // unreadable before the queued dispatch
  assert.equal(await code(pending), 'storage-unreadable');
  assert.equal(h.fake.bodies.length, 0);
  assert.equal(sim.phase(), 'none');
});

test('unreadable storage: during a deletion pass the next revoke is not sent; never nothing/deleted/superseded; resume completes', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  await flush(20);
  sim.issueCode('SECOND-CODE-5678');
  plan.crewEnroll = [lose];
  await code(h.svc.enroll('SECOND-CODE-5678'));                // the candidate is now live on the backend
  const candidate = h.entries().find((e) => e.role === 'candidate').grant;
  const flag = unreadable(h, false);
  plan.crewRevoke = [(body, deliver) => { const answer = deliver(); flag.on = true; return answer; }];
  const first = await deletion(h, sim, h.svc.revoke());
  assert.deepEqual([first.status, first.code], ['pending', 'storage-unreadable']);
  assert.equal(h.fake.bodies.some((b) => b.body.action === 'crewRevoke' && b.body.grant === candidate), false, 'no revoke sent while unreadable');
  assert.equal(sim.phase(), 'active');
  assert.equal(await code(deletion(h, sim, h.svc.resumeRevoke())), 'storage-unreadable');
  flag.on = false;
  const done = await deletion(h, sim, h.svc.resumeRevoke());
  assert.equal(done.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.map.has(STORED), false);
});

test('unreadable storage: restart while unreadable, then readable -> fold, deletion completes', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  plan.crewEnroll = [lose];
  await code(h.svc.enroll(CODE));
  const flag = unreadable(h);
  __resetCrewStateForTests();
  const after = restart(h);
  assert.equal(await code(deletion(h, sim, after.svc.revoke())), 'storage-unreadable');
  assert.equal(await code(after.svc.loadCrew(sim.query(1))), 'storage-unreadable');
  assert.equal(h.posts('crewRevoke'), 0);
  flag.on = false;
  const r = await deletion(h, sim, after.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.equal(h.storage.map.has(STORED), false, 'removed only after the backend confirmed');
});

test('unreadable storage: loadCrew and requestIndexing refuse; controller sign-out does not delete the unreadable record', async () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.set(ENDPOINT_KEY, ENDPOINT);
  store.set(TOKEN_KEY, TOKEN);
  const h = harness({ storage, store, handler: () => assert.fail('nothing may be sent') });
  const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
  const controller = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
  const before = storage.map.get(STORED);
  const flag = unreadable(h);
  assert.equal(await code(h.svc.loadCrew(Q)), 'storage-unreadable');
  assert.equal((await h.svc.requestIndexing('manual')).stopped, 'storage-unreadable');
  controller.removeToken();
  await flush();   // the crew drop is an async locked mutation; its failure marks cleanup incomplete
  assert.equal(controller.view().storageError, true, 'sign-out reports incomplete local cleanup');
  assert.equal(storage.map.get(STORED), before, 'the unreadable crew record is not deleted');
  flag.on = false;
  assert.equal(storage.map.get(STORED), before);
});

// --- Correction batch 7: cross-tab lock unavailable ----------------------------------------------------------

for (const [label, locks] of [['missing', null], ['rejecting', { request: () => Promise.reject(new Error('denied')) }], ['throwing', { request: () => { throw new Error('denied'); } }]]) {
  test(`lock ${label}: every operation refuses locally with lock-unavailable; nothing is written, dispatched or reported deleted`, async () => {
    const h = harness({ locks, handler: () => assert.fail('nothing may be sent') });
    const before = h.storage.map.get(STORED);
    assert.equal(await code(h.svc.loadCrew(Q)), 'lock-unavailable', 'the first operation needs the locked recovery check');
    assert.equal((await h.svc.requestIndexing('manual')).stopped, 'lock-unavailable');
    assert.equal(await code(h.svc.enroll(CODE)), 'lock-unavailable');
    assert.equal(await code(h.svc.revoke()), 'lock-unavailable');
    assert.equal(await code(h.svc.resumeRevoke()), 'lock-unavailable');
    assert.equal(h.fake.bodies.length, 0);
    assert.equal(h.storage.map.get(STORED), before, 'never an uncoordinated write');
    const empty = harness({ locks, enrolled: false, handler: () => assert.fail('nothing may be sent') });
    assert.equal(await code(empty.svc.enroll(CODE)), 'lock-unavailable', 'no record: enrollment still needs the lock');
    assert.equal(empty.fake.bodies.length, 0);
    assert.equal(empty.storage.map.has(STORED), false);
  });
}

test('lock unavailable: controller sign-out keeps a record it cannot coordinate and reports incomplete cleanup', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });   // no Web Locks
  try {
    for (const withRecord of [true, false]) {
      const storage = memoryStorage();
      const store = createStore(storage);
      store.set(ENDPOINT_KEY, ENDPOINT);
      store.set(TOKEN_KEY, TOKEN);
      const h = harness({ storage, store, enrolled: withRecord });
      const api = { fetchStats: async () => { throw new ApiError('network', 'offline'); }, postContract: async () => { throw new ApiError('network', 'offline'); } };
      const controller = createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => T0, isOnline: () => false });
      const before = storage.map.get(STORED);
      controller.removeToken();
      await flush();
      assert.equal(controller.view().storageError, withRecord, withRecord ? 'incomplete: the record is kept' : 'nothing to coordinate');
      assert.equal(storage.map.get(STORED), before);
    }
  } finally {
    Object.defineProperty(globalThis, 'navigator', saved);
  }
});

// --- Correction batch 8: limits re-checked after the locked beginEnroll; sign-out cleanup reporting -----------

/** Holds the credential lock until release() is called; resolves `held` once it is held. */
function holdCredentialLock() {
  let release;
  const released = new Promise((r) => { release = r; });
  let markHeld;
  const held = new Promise((r) => { markHeld = r; });
  const done = navigator.locks.request(CREW_CREDENTIAL_LOCK, () => { markHeld(); return released; });
  return { held, release: () => { release(); return done; } };
}
const lockWaiters = async () => (await navigator.locks.query()).pending.filter((l) => l.name === CREW_CREDENTIAL_LOCK).length;
const budgeted = (h) => h.fake.bodies.filter((b) => b.body.action !== 'crewRevoke').length;

test('P1 budget (review exact): an enrollment waiting for the lock while the budget is used up is not dispatched as call 21', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);                                      // 1: one enrollment completed
  await flush(30);
  assert.equal(h.svc.indexingStatus().running, false);
  sim.issueCode('SECOND-CODE-5678');
  const lock = holdCredentialLock();                             // 2: the credential lock is held (e.g. another tab)
  await lock.held;
  const second = code(h.svc.enroll('SECOND-CODE-5678'));         // 3: waits inside beginEnroll
  await until(async () => (await lockWaiters()) === 1, 'the enrollment waits for the lock');
  while (budgeted(h) < CREW_CALL_BUDGET) await h.svc.loadCrew(sim.query(1), { force: true });   // 4: budget used up
  const before = budgeted(h);
  await lock.release();                                          // 5
  assert.equal(await second, 'local-limit');                     // 6: not dispatched
  assert.equal(budgeted(h), before, 'no call 21');
  assert.equal(h.posts('crewEnroll'), 1);
  assert.deepEqual(h.entries().map((e) => e.role), ['active'], 'the prepared, unsent candidate is removed');
});

test('P1 cooldown (review exact): a rate limit established during the lock wait stops the waiting enrollment', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  await flush(30);
  sim.issueCode('SECOND-CODE-5678');
  const lock = holdCredentialLock();
  await lock.held;
  const second = code(h.svc.enroll('SECOND-CODE-5678'));
  await until(async () => (await lockWaiters()) === 1, 'the enrollment waits for the lock');
  plan.crew = [() => refusal('rate-limited')];
  assert.equal(await code(h.svc.loadCrew(sim.query(1), { force: true })), 'rate-limited');
  const before = budgeted(h);
  await lock.release();
  assert.equal(await second, 'cooldown');
  assert.equal(budgeted(h), before, 'nothing dispatched during the cooldown');
  assert.equal(h.posts('crewEnroll'), 1);
  assert.deepEqual(h.entries().map((e) => e.role), ['active']);
});

async function until(condition, message, limitMs = 5000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > limitMs) assert.fail(`timed out waiting: ${message}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('batch 8: a cancelled reused same-code candidate keeps its earlier uncertainty; deletion still revokes it via the backend', async () => {
  const { h, sim, plan } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  await flush(30);
  const working = h.grant();
  sim.issueCode('SECOND-CODE-5678');
  let held = null;
  plan.crewEnroll = [(body) => { held = body; throw timeoutError(); }];   // X's request is still in transit
  assert.equal(await code(h.svc.enroll('SECOND-CODE-5678')), 'timeout');
  const x = h.entries().find((e) => e.role === 'candidate').grant;
  const lock = holdCredentialLock();
  await lock.held;
  const retry = code(h.svc.enroll('SECOND-CODE-5678'));          // same code: reuses X
  await until(async () => (await lockWaiters()) === 1, 'the retry waits for the lock');
  while (budgeted(h) < CREW_CALL_BUDGET) await h.svc.loadCrew(sim.query(1), { force: true });
  const before = budgeted(h);
  await lock.release();
  assert.equal(await retry, 'local-limit');
  assert.equal(budgeted(h), before, 'not dispatched');
  const kept = h.entries().find((e) => e.grant === x);
  assert.deepEqual([kept.unknown, kept.inflight], [true, false], 'the earlier unknown attempt is preserved');
  assert.ok(h.entries().some((e) => e.grant === working && e.role === 'active'), 'the active grant is untouched');
  sim.handle(held);                                              // X's earlier request finally activates it
  assert.ok(sim.isLive(x));
  const r = await deletion(h, sim, h.svc.revoke());
  assert.equal(r.status, 'deleted');
  assert.equal(sim.phase(), 'deleted');
  assert.ok(h.fake.bodies.some((b) => b.body.action === 'crewRevoke' && b.body.grant === x), 'X was revoked on its backend');
});

test('batch 8: when the cancellation settle cannot be written, the storage fault holds, nothing is dispatched, the record stays conservative', async () => {
  const { h, sim } = await simulated();
  sim.issueCode(CODE);
  await h.svc.enroll(CODE);
  await flush(30);
  sim.issueCode('SECOND-CODE-5678');
  const lock = holdCredentialLock();
  await lock.held;
  const second = code(h.svc.enroll('SECOND-CODE-5678'));
  await until(async () => (await lockWaiters()) === 1, 'the enrollment waits for the lock');
  while (budgeted(h) < CREW_CALL_BUDGET) await h.svc.loadCrew(sim.query(1), { force: true });
  const before = budgeted(h);
  // Only the write that persists the prepared candidate (inflight) succeeds; the cancellation write fails.
  h.storage.faults.set = (k, v) => k === STORED && !v.includes('"inflight":true');
  await lock.release();
  assert.equal(await second, 'local-limit');
  assert.equal(budgeted(h), before);
  assert.ok(h.entries().some((e) => e.role === 'candidate' && e.inflight), 'conservative: the unsent attempt stays potentially live');
  assert.equal(await code(h.svc.loadCrew(sim.query(1))), 'storage', 'fail closed until a recovery write succeeds');
  assert.equal(budgeted(h), before);
  h.storage.faults.set = false;
  assert.equal(h.posts('crewEnroll'), 1);
});

test('history-scaled session completes fifty months in nine calls; captured allowance never grows', async () => {
  let remaining = 50;
  const h = harness({ handler: byAction({ crewIndex: () => {
    const initial = remaining, processed = Math.min(6,remaining); remaining -= processed;
    return { ...indexAnswer({processed,indexed:50-remaining,pending:remaining,stale:0,uncovered:0}), session:{version:1,initialOutstanding:initial,remaining} };
  } }) });
  const r=await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls,r.stopped,remaining],[9,'done',0]);
  const growing = harness({ handler:byAction({crewIndex:(b,n)=>({...indexAnswer({processed:1,pending:5,stale:0}),session:{version:1,initialOutstanding:n===1?6:600,remaining:n===1?5:500}})}) });
  assert.deepEqual([(await growing.svc.requestIndexing('enroll')).stopped,growing.posts('crewIndex')],['no-progress',2]);
});
test('session deadline includes spacing and diagnostic request latency; no dispatch after deadline',async()=>{
  const h=harness({handler:byAction({crewIndex:()=>{h.clock.t+=180000;return indexAnswer({processed:1,pending:5,stale:0});}})});
  const r=await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls,r.stopped],[1,'deadline']);
});
test('legacy backend validates but cannot authorize history-scaled continuation',async()=>{
  const h=harness({handler:byAction({crewIndex:legacyIndexAnswer({processed:1,pending:5})})});
  assert.deepEqual([(await h.svc.requestIndexing('enroll')).stopped,h.posts('crewIndex')],['session-unavailable',1]);
});

test('wholly busy successful index envelope gets only one budgeted retry', async()=>{
  const h=harness({handler:byAction({crewIndex:()=>({...indexAnswer({processed:1,pending:6,stale:0}),outcomes:{busy:1},session:{version:1,initialOutstanding:6,remaining:6}})})});
  const r=await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls,r.stopped],[2,'busy']);
  assert.deepEqual(h.sleeps,[BUSY_RETRY_MS]);
});

test('private network timing excludes cache/joined calls; failures remain distinct and access purge clears all',async()=>{
  const {startCrewDiagnostics,crewDiagnosticSnapshot}=await import('../src/crew-diagnostics.js');
  const pending=deferred();
  const h=harness({handler:byAction({crew:async()=>{await pending.promise;h.clock.t+=12;return crewAnswer();}})});
  startCrewDiagnostics();
  const first=h.svc.loadCrew(Q),second=h.svc.loadCrew(Q);
  await flush();pending.resolve();await Promise.all([first,second]);
  await h.svc.loadCrew(Q);
  const r=crewDiagnosticSnapshot().requests;
  assert.equal(r.filter(x=>x.source==='network').length,1);
  assert.equal(r.find(x=>x.source==='network').elapsedMs,12);
  assert.equal(r.filter(x=>x.source==='joined').length,1);
  assert.equal(r.filter(x=>x.source==='cache').length,1);
  purgeCrewMemory();assert.equal(crewDiagnosticSnapshot().requests.length,0);
  const failed=harness({handler:byAction({crew:()=>{throw timeoutError();}})});
  startCrewDiagnostics();await code(failed.svc.loadCrew(Q));
  assert.equal(crewDiagnosticSnapshot().requests[0].outcome,'timeout');
  assert.equal(crewDiagnosticSnapshot().crewNetworkSamples.count,0);
});

test('expanding history never bypasses the twenty-request budget even with diagnostics enabled',async()=>{
  const {startCrewDiagnostics,crewDiagnosticSnapshot}=await import('../src/crew-diagnostics.js');
  let remaining=200;
  const h=harness({handler:byAction({crewIndex:()=>{const initial=remaining;remaining-=6;return {...indexAnswer({processed:6,indexed:200-remaining,pending:remaining,stale:0,uncovered:0}),session:{version:1,initialOutstanding:initial,remaining}};}})});
  startCrewDiagnostics();
  const r=await h.svc.requestIndexing('enroll');
  assert.deepEqual([r.calls,r.stopped],[20,'budget']);
  const session=crewDiagnosticSnapshot().sessions[0];
  assert.equal(session.initialOutstanding,200);
  assert.equal(session.allowance,36);
  assert.equal(crewDiagnosticSnapshot().reports.every(x=>x.complete===false),true,'missing backend diagnostics are not zero-valued evidence');
});


test('P2 cache-hit duration uses the advancing clock and cannot affect network percentiles', async () => {
  const { startCrewDiagnostics, crewDiagnosticSnapshot } = await import('../src/crew-diagnostics.js');
  let ticks = 0;
  const h = harness({ monotonic: () => (ticks += 7), handler: byAction({ crew: crewAnswer() }) });
  startCrewDiagnostics();
  for (let i = 0; i < 10; i++) await h.svc.loadCrew(Q, { force: true });
  const before = crewDiagnosticSnapshot().crewNetworkSamples;
  assert.equal(before.count, 10);
  await h.svc.loadCrew(Q);
  const snapshot = crewDiagnosticSnapshot();
  const hit = snapshot.requests.find(x => x.source === 'cache');
  assert.equal(hit.elapsedMs, 7, 'a hard-coded zero must fail this assertion');
  assert.equal(hit.transportMs, null, 'cache hit has no transport measurement');
  assert.equal(h.posts('crew'), 10, 'cache hit sends no request');
  assert.deepEqual(snapshot.crewNetworkSamples, before, 'cache duration is excluded from p50/p95');
});

for (const ending of ['sign-out', 'reset', 'identity-change', 'revocation']) {
  test(`P1 diagnostic records and intent are cleared by ${ending}`, async () => {
    const { startCrewDiagnostics, crewDiagnosticSnapshot, recordCrewRequest } = await import('../src/crew-diagnostics.js');
    const h = harness({ handler: byAction({ crewRevoke: revokeAnswer() }) });
    h.store.set(ENDPOINT_KEY, ENDPOINT); h.store.set(TOKEN_KEY, TOKEN);
    const noRequest = async () => assert.fail('controller must remain offline');
    const controller = createController({ profile: PROFILE, onChange: () => {}, store: h.store,
      api: { fetchStats: noRequest, postContract: noRequest }, clock: () => T0, isOnline: () => false });
    startCrewDiagnostics();
    recordCrewRequest({ action: 'crew', source: 'cache', outcome: 'success', elapsedMs: 7 });
    if (ending === 'sign-out') controller.removeToken();
    else if (ending === 'reset') controller.resetLocalData();
    else if (ending === 'identity-change') { h.store.set(TOKEN_KEY, OTHER_TOKEN); controller.accessChanged(); }
    else assert.equal((await h.svc.revoke()).status, 'deleted');
    await flush();
    const result = crewDiagnosticSnapshot();
    assert.equal(result.enabled, false);
    assert.deepEqual([result.requests, result.reports, result.sessions], [[], [], []]);
  });
}

test('zero-work completion preserves uncovered, cleanup and outstanding-work safeguards', async () => {
  for (const [options, cleanupPending, remaining, expected] of [
    [{}, false, 0, 'done'],
    [{uncovered: 1}, false, 0, 'uncovered'],
    [{}, true, 0, 'no-progress'],
    [{pending: 1}, false, 1, 'no-progress'],
    [{stale: 1}, false, 1, 'no-progress'],
    [{}, false, 1, 'no-progress'],
  ]) {
    const answer = indexAnswer({processed:0,pending:0,stale:0,uncovered:0,...options});
    answer.cleanupPending = cleanupPending;
    answer.session.remaining = remaining;
    const h = harness({handler:byAction({crewIndex:answer})});
    assert.equal((await h.svc.requestIndexing('manual')).stopped, expected);
    assert.equal(h.posts('crewIndex'), 1);
  }
});
test('manual session stops on missing or changed server cutoff', async () => {
  for (const variant of ['missing', 'changed']) {
    const h = harness({handler:byAction({crewIndex:(body,n)=>{
      const a = indexAnswer({processed:1,pending:3});
      if (variant === 'missing') delete a.session.manualCutoff;
      else if (n === 2) a.session.manualCutoff = {...MANUAL_CUTOFF,at:MANUAL_CUTOFF.at+1};
      return a;
    }})});
    assert.equal((await h.svc.requestIndexing('manual')).stopped, variant === 'missing' ? 'session-unavailable' : 'error:invalid-response');
    assert.equal(h.posts('crewIndex'),variant === 'missing' ? 1 : 2);
  }
});

test('cleanup-only continuation can complete without processing another month', async () => {
  const h = harness({handler:byAction({crewIndex:(body,n)=>({
    ...indexAnswer({processed:n === 1 ? 1 : 0,pending:0,stale:0,uncovered:0}),
    cleanupPending:n === 1,
  })})});
  const r = await h.svc.requestIndexing('manual');
  assert.equal(r.stopped,'done');
  assert.equal(r.calls,2);
});


test('manual cutoff refusal stops without renewal or another dispatch', async () => {
  const h = harness({handler:byAction({crewIndex:(body,n)=> n === 1
    ? indexAnswer({processed:1,pending:3}) : refusal('crew-unavailable')})});
  const r = await h.svc.requestIndexing('manual');
  assert.equal(r.calls,2);
  assert.equal(r.stopped,'error:crew-unavailable');
  assert.equal(h.posts('crewIndex'),2);
  assert.deepEqual(h.fake.bodies[1].body.manualCutoff,MANUAL_CUTOFF);
});
