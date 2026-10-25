// Crew Intelligence Stage B correction batch 1: asynchronous authorization of what the crew UI shows.
// Invariant: no crew name renders unless the CURRENT consent (crew.enabled), authenticated identity (accessId) and
// credential state (active grant, no pending deletion) authorize that exact response. Also: enrollment never proceeds
// after consent or identity changed during its awaits, and an offline Flight Details recovers when back online.
// Real runtime + service with a scripted fake backend; a minimal fake DOM for the Settings panel. Synthetic data.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { normalizeProfile } from '../src/config/profile.js';
import { createCrewCredentials, accessFingerprint, endpointFingerprint, CREW_CREDENTIAL_KEY } from '../src/sources/crew-credential.js';
import { purgeCrewMemory } from '../src/sources/crew-service.js';
import { createCrewRuntime, CREW_ENABLED_KEY } from '../src/crew-runtime.js';
import { crewSectionState, crewSection, resetCrewSection, mountCrewPanel, resetCrewPanel, crewPanel } from '../src/ui/crew-section.js';
import { ApiError } from '../src/api/appscript.js';
import {
  neutralCrewAnswer, enrollAnswer, revokeAnswer, indexAnswer, memoryStorage, flush, deferred, SECTOR, TOKEN, OTHER_TOKEN, ENDPOINT, T0,
} from './fixtures/crew-frontend.synthetic.mjs';

const STORED = `fc.v2.${CREW_CREDENTIAL_KEY}`;
const NAMES = ['SAMPLE', 'Example', 'BRIEN', 'ARCY', 'PLACEHOLDER', 'TESTPERSON'];
const CAPS = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history', 'crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] };
const NOW = Date.parse('2026-10-22T12:00:00Z');
const sector = { id: SECTOR, flightNumber: 'XQ100', origin: 'AAA', destination: 'BBB', dep: Date.parse('2026-10-20T08:00:00Z'), arr: Date.parse('2026-10-20T10:00:00Z'), originTz: 'Europe/Berlin', destTz: 'Europe/Berlin', provenance: 'source' };
const view = () => ({ review: false, mode: { kind: 'production' }, now: NOW, profile: normalizeProfile({}), snapshot: { contract: 'v2', sectors: [sector] } });
const entry = { sector };
const shown = (h) => String(crewSection(h.ctx, entry, view()));
const namesIn = (markup) => NAMES.filter((n) => markup.includes(n));

let base = 0;
/** handlers[action](body) -> answer | Promise; default: ok answers. */
function world(handlers = {}) {
  base += 1;
  const storage = memoryStorage();
  const store = createStore(storage);
  const bodies = [];
  const defaults = {
    capabilities: () => CAPS,
    crew: () => neutralCrewAnswer({ sectorId: SECTOR }),
    crewEnroll: () => enrollAnswer(1),
    crewRevoke: () => revokeAnswer(),
    crewIndex: () => indexAnswer({ processed: 0 }),
  };
  const post = async (ep, body) => { bodies.push(body); return { data: await (handlers[body.action] ?? defaults[body.action])(body) }; };
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId: `a${base}` };
  const rt = createCrewRuntime({ store, access: () => access, post, credentials: createCrewCredentials({ store }), isVisible: () => true, isOnline: () => true });
  const ctx = { crew: rt, accessId: () => access.accessId, rerender: () => {}, view };
  return { storage, store, bodies, access, rt, ctx, posts: (a) => bodies.filter((b) => b.action === a).length };
}
function seedGrant(h, token = TOKEN) {
  h.storage.setItem(STORED, JSON.stringify({ v: 1, phase: 'active', grants: [{ grant: 'A'.repeat(43), ep: endpointFingerprint(ENDPOINT), bind: accessFingerprint(ENDPOINT, token), at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }));
}
/** Renders until the crew list is shown (bounded). */
async function loaded(h) {
  for (let i = 0; i < 20; i += 1) {
    const s = crewSectionState(h.ctx, entry, view());
    if (s?.kind === 'crew') return s;
    await flush();
  }
  assert.fail('crew never loaded');
}

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const realLocks = globalThis.navigator.locks;
function setOnline(online) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: online, locks: realLocks }, configurable: true, writable: true });
}
beforeEach(() => { resetCrewSection(); resetCrewPanel(); purgeCrewMemory(); });
afterEach(() => { Object.defineProperty(globalThis, 'navigator', savedNavigator); delete globalThis.document; });

// --- P1-A: names never outlive their authorization -----------------------------------------------------------

test('P1-A (review exact): after "forget" (revoke ok, credential removed) the same flight shows no names', async () => {
  const h = world();
  h.rt.setEnabled(true);
  seedGrant(h);
  await loaded(h);
  assert.deepEqual(namesIn(shown(h)), NAMES, 'authorized: names shown');
  const r = await h.rt.service.revoke();
  assert.equal(r.status, 'deleted');
  assert.equal(h.storage.getItem(STORED), null);
  assert.deepEqual(namesIn(shown(h)), [], 'deleted crew names are never shown again');
  h.rt.setEnabled(false);
  h.rt.setEnabled(true);                                       // re-enabled without a new grant
  await flush();
  assert.deepEqual(namesIn(shown(h)), []);
});

test('P1-A: disable + re-enable (grant unchanged) never shows the old answer before a fresh authorized lookup', async () => {
  const h = world();
  h.rt.setEnabled(true);
  seedGrant(h);
  await loaded(h);
  h.rt.setEnabled(false);
  assert.equal(shown(h), '', 'off: hidden');
  h.rt.setEnabled(true);
  assert.deepEqual(namesIn(shown(h)), [], 'consent renewed: the earlier answer is not reused');
  await loaded(h);
  assert.equal(h.posts('crew'), 2, 'a fresh lookup under the new consent');
});

test('P1-A: cross-tab revocation (another tab removes the record, storage event) invalidates displayed names', async () => {
  const h = world();
  h.rt.setEnabled(true);
  seedGrant(h);
  await loaded(h);
  h.storage.removeItem(STORED);                                // another tab completed a deletion
  h.rt.storageChanged?.(STORED);
  assert.deepEqual(namesIn(shown(h)), []);
  // A cross-tab opt-out works the same way.
  const o = world();
  o.rt.setEnabled(true);
  seedGrant(o);
  await loaded(o);
  o.storage.removeItem(`fc.v2.${CREW_ENABLED_KEY}`);
  o.rt.storageChanged?.(`fc.v2.${CREW_ENABLED_KEY}`);
  assert.equal(shown(o), '');
});

test('P1-A: a late crew response after revoke or opt-out does not repopulate names; the credential record is untouched by UI invalidation', async () => {
  const gate = deferred();
  const h = world({ crew: async () => { await gate.promise; return neutralCrewAnswer({ sectorId: SECTOR }); } });
  h.rt.setEnabled(true);
  seedGrant(h);
  crewSectionState(h.ctx, entry, view());
  await flush();
  assert.deepEqual(crewSectionState(h.ctx, entry, view()), { kind: 'loading' });
  h.rt.setEnabled(false);                                      // opt-out while the request is in flight
  gate.resolve();
  await flush();
  h.rt.setEnabled(true);
  assert.deepEqual(namesIn(shown(h)), [], 'the late answer of the earlier consent is dropped');
  // Pending deletion evidence (Stage A) is never touched by UI invalidation.
  const p = world();
  p.rt.setEnabled(true);
  seedGrant(p);
  await loaded(p);
  assert.ok(await p.rt.credentials.beginRevoke());
  const record = p.storage.getItem(STORED);
  p.rt.storageChanged?.(STORED);
  p.rt.setEnabled(false);
  assert.deepEqual(namesIn(shown(p)), []);
  assert.equal(p.storage.getItem(STORED), record);
});

// --- P1-B: enrollment re-checks consent, identity and support after every await -------------------------------

/** Minimal DOM for the Settings panel: one panel box, the code input, captured listeners. */
function panelDom() {
  const listeners = {};
  const input = { value: '', id: 'crew-code' };
  const form = { querySelector: (sel) => (sel === '#crew-code' ? input : null) };
  const box = { innerHTML: '', addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: () => {}, contains: () => false };
  const root = { querySelector: (sel) => (sel === '[data-crew-panel]' ? box : null) };
  globalThis.document = { activeElement: null };
  const submit = (code) => {
    input.value = code;
    return listeners.submit({ preventDefault: () => {}, target: { closest: (sel) => (sel === '[data-crew-enroll]' ? form : null), querySelector: form.querySelector } });
  };
  const click = (selector) => listeners.click({ preventDefault: () => {}, target: { closest: (sel) => (sel === selector ? {} : null) } });
  return { root, box, submit, click };
}

test('P1-B Repro A (review exact): consent withdrawn while capabilities are held -> no enrollment dispatched', async () => {
  const caps = deferred();
  const h = world({ capabilities: () => caps.promise });
  const dom = panelDom();
  const stop = mountCrewPanel(dom.root, { ...h.ctx, view: () => ({ ...view(), crewCleanup: null }) });
  const submitted = dom.submit('SYNTHETIC-CODE-1234');
  await flush();
  assert.equal(h.rt.enabled(), true, 'turning on sets consent');
  h.rt.setEnabled(false);                                      // the user turns crew off again (or another tab does)
  caps.resolve(CAPS);
  await submitted;
  await flush();
  assert.equal(h.posts('crewEnroll'), 0, 'no enrollment after consent was withdrawn');
  assert.equal(h.storage.getItem(STORED), null, 'no grant created');
  stop();
});

test('P1-B Repro B (review exact): identity changes while A\'s capabilities are held -> never enrolls under B', async () => {
  const caps = deferred();
  let n = 0;
  const h = world({ capabilities: () => { n += 1; return n === 1 ? caps.promise : { ...CAPS, actions: ['capabilities', 'roster', 'history'] }; } });
  const dom = panelDom();
  const stop = mountCrewPanel(dom.root, { ...h.ctx, view: () => ({ ...view(), crewCleanup: null }) });
  const submitted = dom.submit('SYNTHETIC-CODE-1234');
  await flush();
  h.access.token = OTHER_TOKEN;                                // switched to auth B
  h.access.accessId = `${h.access.accessId}-B`;
  h.rt.accessChanged();
  caps.resolve(CAPS);                                          // A's (supported) answer arrives late
  await submitted;
  await flush();
  assert.equal(h.posts('crewEnroll'), 0, 'A\'s capability never authorizes B');
  assert.equal(h.storage.getItem(STORED), null);
  stop();
});

test('P1-B: a stale capability answer for A never changes B\'s Settings state', async () => {
  const caps = deferred();
  let n = 0;
  const h = world({ capabilities: () => { n += 1; return n === 1 ? caps.promise : new Promise(() => {}); } });
  h.rt.setEnabled(true);
  const dom = panelDom();
  const pctx = { ...h.ctx, view: () => ({ ...view(), crewCleanup: null }) };
  const stop = mountCrewPanel(dom.root, pctx);                 // asks A's capability (held)
  h.access.token = OTHER_TOKEN;
  h.access.accessId = `${h.access.accessId}-B`;
  h.rt.accessChanged();
  caps.resolve(CAPS);                                          // A: supported, arriving late
  await flush();
  const markup = String(crewPanel(pctx));
  assert.doesNotMatch(markup, /data-crew-enroll/, 'B shows no code form on A\'s answer');
  assert.doesNotMatch(markup, /Checking your roster backend|Not offered/, 'B has no capability result yet');
  stop();
});

test('P1-B: the service guard runs after the locked beginEnroll; false cancels as never-sent and keeps earlier uncertainty', async () => {
  let lose = true;
  const h = world({ crewEnroll: () => { if (lose) { lose = false; throw new ApiError('network', 'lost'); } return enrollAnswer(1); } });
  h.rt.setEnabled(true);
  await assert.rejects(h.rt.service.enroll('SYNTHETIC-CODE-1234'), (e) => e.code === 'network');
  const before = JSON.parse(h.storage.getItem(STORED)).grants;
  assert.deepEqual(before.map((e) => [e.unknown, e.inflight]), [[true, false]]);
  let calls = 0;
  const guard = () => { calls += 1; return calls === 1; };      // valid at entry, withdrawn during the lock wait
  await assert.rejects(h.rt.service.enroll('SYNTHETIC-CODE-1234', { guard }), (e) => e.code === 'consent-changed');
  assert.equal(h.posts('crewEnroll'), 1, 'never sent');
  assert.ok(calls >= 2, 'checked again after the locked write');
  const after = JSON.parse(h.storage.getItem(STORED)).grants;
  assert.deepEqual(after.map((e) => [e.grant, e.unknown, e.inflight]), [[before[0].grant, true, false]], 'earlier uncertainty kept');
});

// --- P2: offline Flight Details recovers ----------------------------------------------------------------------

test('P2 (review exact): opened offline, then back online -> the same flight loads (no permanent offline state)', async () => {
  const h = world();
  h.rt.setEnabled(true);
  seedGrant(h);
  crewSectionState(h.ctx, entry, view());
  await flush();
  setOnline(false);
  assert.deepEqual(crewSectionState(h.ctx, entry, view()), { kind: 'offline' });
  assert.equal(h.posts('crew'), 0);
  setOnline(true);
  h.rt.connectivityChanged(true);
  await loaded(h);
  assert.equal(h.posts('crew'), 1, 'success replaces the offline state');
});

test('P2: repeated online events and re-renders cause one request, not a storm', async () => {
  const gate = deferred();
  const h = world({ crew: async () => { await gate.promise; return neutralCrewAnswer({ sectorId: SECTOR }); } });
  h.rt.setEnabled(true);
  seedGrant(h);
  crewSectionState(h.ctx, entry, view());
  await flush();
  setOnline(false);
  crewSectionState(h.ctx, entry, view());
  setOnline(true);
  for (let i = 0; i < 5; i += 1) { h.rt.connectivityChanged(true); crewSectionState(h.ctx, entry, view()); }
  await flush();
  assert.equal(h.posts('crew'), 1);
  gate.resolve();
  await loaded(h);
  assert.equal(h.posts('crew'), 1);
});

test('P2: a late network failure of an older request never overwrites a newer success', async () => {
  const first = deferred();
  let n = 0;
  const h = world({ crew: async () => { n += 1; if (n === 1) { await first.promise; throw new ApiError('network', 'late'); } return neutralCrewAnswer({ sectorId: SECTOR }); } });
  h.rt.setEnabled(true);
  seedGrant(h);
  crewSectionState(h.ctx, entry, view());
  await flush();
  crewSectionState(h.ctx, entry, view());                      // request 1 in flight
  await flush();
  h.rt.setEnabled(false);
  h.rt.setEnabled(true);                                       // a newer authorization: request 2
  await loaded(h);
  first.resolve();
  await flush();
  assert.equal(crewSectionState(h.ctx, entry, view()).kind, 'crew', 'the newer success stays');
});

test('private diagnostic controls do not enroll or request data and expose only aggregate output', async () => {
  const { crewDiagnosticSnapshot } = await import('../src/crew-diagnostics.js');
  const h = world();
  const dom = panelDom();
  const output = { textContent: '', hidden: true };
  dom.box.querySelector = sel => sel === '[data-crew-diagnostics-output]' ? output : null;
  const stop = mountCrewPanel(dom.root, h.ctx);
  await dom.click('[data-crew-diagnostics-start]');
  assert.equal(crewDiagnosticSnapshot().enabled, true);
  await dom.click('[data-crew-diagnostics-show]');
  assert.equal(output.hidden, false);
  assert.equal(JSON.parse(output.textContent).requests.length, 0);
  assert.deepEqual(h.bodies, []);
  await dom.click('[data-crew-diagnostics-end]');
  assert.equal(crewDiagnosticSnapshot().enabled, false);
  assert.deepEqual(h.bodies, []);
  stop();
});


test('P1 first opt-in re-arms explicit diagnostics before automatic initial backfill', async () => {
  const { crewDiagnosticSnapshot, recordCrewRequest } = await import('../src/crew-diagnostics.js');
  const diagnostic = {
    version: 1, complete: true, serverMs: 12, diagnosticMs: 2,
    storeOperations: { keys: 1, reads: 2, writes: 1, deletes: 0 },
    storage: { observedPeakBytes: 10, admissionPeakBytes: 16010, peakCategories: {
      otherValueBytes: 0, committedValueBytes: 8, retiredValueBytes: 0, orphanValueBytes: 0,
      stagedValueBytes: 0, manifestValueBytes: 1, keyBytes: 1,
    } },
    committedParts: { count: 1, medianValueBytes: 8, maxValueBytes: 8 },
    months: [{ elapsedMs: 10, eventsRead: 1, encodedBodyBytes: 4, partCount: 1, lockWaitMs: 1, lockHeldMs: 2, outcome: 'committed' }],
    maintenance: { lockWaitMs: 0, lockHeldMs: 1 },
  };
  const h = world({
    crewEnroll: () => { assert.equal(crewDiagnosticSnapshot().enabled, true, 'armed before dispatch'); return enrollAnswer(); },
    crewIndex: body => {
      assert.equal(body.diagnosticsVersion, 1);
      return { ...indexAnswer({ processed: 1, indexed: 1, pending: 0, stale: 0, uncovered: 0 }),
        session: { version: 1, initialOutstanding: 1, remaining: 0 }, diagnostics: diagnostic };
    },
  });
  const dom = panelDom();
  const stop = mountCrewPanel(dom.root, h.ctx);
  assert.equal(h.rt.enabled(), false);
  await dom.click('[data-crew-diagnostics-start]');
  recordCrewRequest({ action: 'crew', source: 'cache', outcome: 'success', elapsedMs: 7 });
  await dom.submit('SYNTHETIC-CODE-1234');
  for (let i = 0; i < 30 && (h.posts('crewIndex') === 0 || h.rt.service.indexingStatus().running); i++) await flush();
  assert.equal(h.posts('crewEnroll'), 1);
  assert.equal(h.posts('crewIndex'), 1);
  const result = crewDiagnosticSnapshot();
  assert.equal(result.requests.some(x => x.source === 'cache'), false, 'old records are cleared at consent transition');
  assert.deepEqual(result.requests.map(x => [x.action, x.outcome]), [['crewEnroll', 'success'], ['crewIndex', 'success']]);
  assert.deepEqual(result.reports, [diagnostic]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].initialOutstanding, 1);
  assert.equal(result.sessions[0].stopped, 'done');
  stop();
});


test('P1 opt-in without diagnostic intent does not start recording', async () => {
  const { crewDiagnosticSnapshot } = await import('../src/crew-diagnostics.js');
  const h = world();
  const dom = panelDom();
  const stop = mountCrewPanel(dom.root, h.ctx);
  await dom.submit('SYNTHETIC-CODE-1234');
  await flush();
  assert.equal(crewDiagnosticSnapshot().enabled, false);
  assert.equal(h.bodies.find(b => b.action === 'crewIndex')?.diagnosticsVersion, undefined);
  stop();
});

for (const ending of ['identity', 'consent', 'storage-reset', 'owner-end']) {
  test(`P1 no deferred diagnostic re-arm after ${ending} during capability wait`, async () => {
    const { crewDiagnosticSnapshot } = await import('../src/crew-diagnostics.js');
    const caps = deferred();
    const h = world({ capabilities: () => caps.promise });
    const dom = panelDom();
    const stop = mountCrewPanel(dom.root, h.ctx);
    await dom.click('[data-crew-diagnostics-start]');
    const submitted = dom.submit('SYNTHETIC-CODE-1234');
    await flush();
    assert.equal(crewDiagnosticSnapshot().enabled, true);
    if (ending === 'identity') {
      // Controller access changes purge service memory before notifying this runtime.
      purgeCrewMemory(); h.access.accessId += '-next'; h.rt.accessChanged();
    } else if (ending === 'consent') h.rt.setEnabled(false);
    else if (ending === 'storage-reset') h.rt.storageChanged(null);
    else await dom.click('[data-crew-diagnostics-end]');
    caps.resolve(CAPS); await submitted; await flush();
    const result = crewDiagnosticSnapshot();
    assert.equal(result.enabled, false);
    assert.deepEqual([result.requests, result.reports, result.sessions], [[], [], []]);
    if (ending !== 'owner-end') assert.equal(h.posts('crewEnroll'), 0);
    stop();
  });
}

test('P1 synchronous intervening reset during opt-in cannot revive diagnostic intent', async () => {
  const { crewDiagnosticSnapshot } = await import('../src/crew-diagnostics.js');
  const h = world();
  const dom = panelDom();
  const stop = mountCrewPanel(dom.root, h.ctx);
  const unsubscribe = h.rt.subscribe(event => { if (event.reason === 'consent') h.rt.storageChanged(null); });
  await dom.click('[data-crew-diagnostics-start]');
  await dom.submit('SYNTHETIC-CODE-1234'); await flush();
  assert.equal(crewDiagnosticSnapshot().enabled, false);
  assert.deepEqual(crewDiagnosticSnapshot().requests, []);
  unsubscribe(); stop();
});
