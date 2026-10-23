// Crew Intelligence Stage B1: the app-wide crew runtime (src/crew-runtime.js) — opt-in preference, capability
// check (no request while disabled; at most one per access per session), pending-deletion resumption on start /
// online / visible only, and the pure sector eligibility. Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStore } from '../src/store.js';
import { createCrewCredentials, accessFingerprint, endpointFingerprint, CREW_CREDENTIAL_KEY } from '../src/sources/crew-credential.js';
import { createCrewRuntime, crewEligibility, crewSupportedBy, CREW_ENABLED_KEY, CREW_HISTORY_START } from '../src/crew-runtime.js';
import { memoryStorage, flush, TOKEN, ENDPOINT, T0, SECTOR } from './fixtures/crew-frontend.synthetic.mjs';

const CAPS = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history', 'crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] };
const HOME = 'Europe/Berlin';

function setup({ handler = () => CAPS, accessId = 'a1', service = null } = {}) {
  const storage = memoryStorage();
  const store = createStore(storage);
  const bodies = [];
  const post = async (endpoint, body) => { bodies.push(body); return { data: await handler(body) }; };
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId };
  const credentials = createCrewCredentials({ store });
  const runtime = createCrewRuntime({ store, access: () => access, post, credentials, service, isVisible: () => true, isOnline: () => true });
  return { storage, store, bodies, access, credentials, runtime };
}

// --- opt-in ------------------------------------------------------------------------------------------------

test('opt-in: off by default; `crew.enabled` is the only key written', () => {
  const h = setup();
  assert.equal(h.runtime.enabled(), false);
  assert.equal(h.runtime.setEnabled(true), true);
  assert.equal(h.runtime.enabled(), true);
  assert.deepEqual([...h.storage.map.keys()], [`fc.v2.${CREW_ENABLED_KEY}`]);
  assert.equal(h.storage.getItem(`fc.v2.${CREW_ENABLED_KEY}`), 'true');
  h.runtime.setEnabled(false);
  assert.equal(h.runtime.enabled(), false);
  assert.deepEqual([...h.storage.map.keys()], []);
});

// --- capability ---------------------------------------------------------------------------------------------

test('capability: no request while crew is disabled', async () => {
  const h = setup();
  assert.deepEqual(await h.runtime.capability(), { supported: false, cancel: false, actions: null, error: 'disabled' });
  assert.equal(h.bodies.length, 0);
});

test('capability: one request per access per session (memory-cached); supported iff every crew action is listed', async () => {
  const h = setup();
  h.runtime.setEnabled(true);
  const [a, b] = await Promise.all([h.runtime.capability(), h.runtime.capability()]);
  assert.equal(a.supported, true);
  assert.equal(b, a);
  await h.runtime.capability();
  assert.deepEqual(h.bodies.map((x) => x.action), ['capabilities'], 'one request');
  assert.deepEqual(Object.keys(h.bodies[0]).sort(), ['action', 'contract', 'token', 'version'], 'the existing capabilities request');
  h.access.accessId = 'a2';
  await h.runtime.capability();
  assert.equal(h.bodies.length, 2, 'another access: its own request');
  assert.equal(crewSupportedBy({ ...CAPS, actions: ['capabilities', 'roster', 'history'] }), false, 'production router today: unsupported');
  assert.equal(crewSupportedBy({ ...CAPS, actions: ['crew', 'crewEnroll', 'crewIndex'] }), false);
  assert.equal(crewSupportedBy({ ok: false, error: 'unknown-action' }), false);
  assert.equal(crewSupportedBy(CAPS), true);
});

test('capability: an unsupported or failing backend is cached as unsupported (no retry loop in the session)', async () => {
  let n = 0;
  const h = setup({ handler: () => { n += 1; if (n === 1) throw Object.assign(new Error('x'), { code: 'network' }); return CAPS; } });
  h.runtime.setEnabled(true);
  assert.deepEqual(await h.runtime.capability(), { supported: false, cancel: false, actions: null, error: 'network' });
  assert.deepEqual(await h.runtime.capability(), { supported: false, cancel: false, actions: null, error: 'network' });
  assert.equal(n, 1);
  const u = setup({ handler: () => ({ ...CAPS, actions: ['capabilities', 'roster', 'history'] }) });
  u.runtime.setEnabled(true);
  assert.equal((await u.runtime.capability()).supported, false);
});

// --- pending deletion ---------------------------------------------------------------------------------------

function fakeService() {
  const calls = { resume: 0, visibility: [], online: [] };
  let gate = null;
  return {
    calls,
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => release(); },
    resumeRevoke: async () => { calls.resume += 1; if (gate) await gate; return { status: 'deleted' }; },
    noteVisibility: (v) => calls.visibility.push(v),
    noteOnline: (v) => calls.online.push(v),
  };
}
async function seedPendingDeletion(h) {
  h.storage.setItem(`fc.v2.${CREW_CREDENTIAL_KEY}`, JSON.stringify({ v: 1, phase: 'active', grants: [{
    grant: 'A'.repeat(43), ep: endpointFingerprint(ENDPOINT), bind: accessFingerprint(ENDPOINT, TOKEN), at: T0, role: 'active', G: 1, unknown: false, inflight: false,
  }] }));
  assert.ok(await h.credentials.beginRevoke());
}

test('pending deletion: resumed on start, online and visible only when one is pending; independent of the opt-in', async () => {
  const svc = fakeService();
  const h = setup({ service: svc });
  await h.runtime.start();
  h.runtime.connectivityChanged(true);
  h.runtime.visibilityChanged(true);
  await flush();
  assert.equal(svc.calls.resume, 0, 'nothing pending: nothing resumed');
  await seedPendingDeletion(h);
  assert.equal(h.runtime.enabled(), false, 'crew is off');
  await h.runtime.start();
  h.runtime.connectivityChanged(false);
  h.runtime.visibilityChanged(false);
  await flush();
  assert.equal(svc.calls.resume, 1, 'offline and hidden do not resume');
  h.runtime.connectivityChanged(true);
  await flush();
  h.runtime.visibilityChanged(true);
  await flush();
  assert.equal(svc.calls.resume, 3);
  assert.deepEqual(svc.calls.online, [true, false, true], 'every change is forwarded to the service');
  assert.deepEqual(svc.calls.visibility, [true, false, true]);
});

test('pending deletion: concurrent triggers share one resumption', async () => {
  const svc = fakeService();
  const h = setup({ service: svc });
  await seedPendingDeletion(h);
  const release = svc.hold();
  const a = h.runtime.start();
  h.runtime.connectivityChanged(true);
  h.runtime.visibilityChanged(true);
  release();
  await a;
  await flush();
  assert.equal(svc.calls.resume, 1);
});

test('pending deletion: the real service completes it on start without the opt-in (deletion is never a crew feature request)', async () => {
  const h = setup({ handler: (body) => (body.action === 'crewRevoke' ? { ok: true, action: 'crewRevoke', state: 'deleted', deletedKeys: 1 } : CAPS) });
  await seedPendingDeletion(h);
  const r = await h.runtime.start();
  assert.equal(r.status, 'deleted');
  // Phase 1d.2A correction: an unresolved pending deletion learns the capability once (crewCancel, §8.7) first.
  assert.deepEqual(h.bodies.map((b) => b.action), ['capabilities', 'crewRevoke']);
  assert.equal(h.storage.getItem(`fc.v2.${CREW_CREDENTIAL_KEY}`), null);
});

test('main.js: one runtime instance, wired to start, online/offline, visibility and storage events; never to the tick', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.equal((main.match(/createCrewRuntime\(/g) ?? []).length, 1);
  assert.match(main, /crew\.start\(\)/);
  assert.match(main, /crew\.visibilityChanged\(/);
  assert.match(main, /crew\.connectivityChanged\(true\)/);
  assert.match(main, /crew\.connectivityChanged\(false\)/);
  assert.match(main, /crew\.accessChanged\(\)/);
  assert.doesNotMatch(main, /setInterval\([^)]*crew/);
});

// --- eligibility --------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sector = (over = {}) => ({ id: SECTOR, flightNumber: 'XQ100', origin: 'AAA', destination: 'BBB', dep: Date.parse('2026-10-20T08:00:00Z'), arr: Date.parse('2026-10-20T10:00:00Z'), originTz: 'Europe/Berlin', destTz: 'Europe/Berlin', provenance: 'source', ...over });
const view = (sectors, over = {}) => ({ review: false, mode: { kind: 'production' }, snapshot: { contract: 'v2', sectors }, ...over });
const check = (s, v = view([s])) => crewEligibility({ view: v, sector: s, now: NOW, homeTz: HOME });

test('eligibility: a current v2 roster sector -> its id and origin-local departure date', () => {
  assert.deepEqual(check(sector()), { eligible: true, query: { sectorId: SECTOR, date: '2026-10-20' } });
  // Origin-local date, not UTC: 23:30 UTC on the 20th departs on the 20th in New York (UTC-4) and on the 21st in Berlin.
  const ny = sector({ dep: Date.parse('2026-10-20T23:30:00Z'), originTz: 'America/New_York' });
  assert.equal(check(ny).query.date, '2026-10-20');
  const fra = sector({ dep: Date.parse('2026-10-20T23:30:00Z'), originTz: 'Europe/Berlin' });
  assert.equal(check(fra).query.date, '2026-10-21');
});

test('eligibility: not for remembered history, v5, sample/review, unknown zone, ids that are not backend sector ids', () => {
  const s = sector();
  assert.equal(check({ ...s, provenance: 'history' }, view([{ ...s, provenance: 'history' }])).reason, 'not-current-roster');
  assert.equal(check(s, view([{ ...s, provenance: 'history' }])).reason, 'not-current-roster', 'must be in the current roster');
  assert.equal(check(s, view([s], { snapshot: { contract: 'v5', sectors: [s] } })).reason, 'not-v2');
  assert.equal(check(s, view([s], { review: true })).reason, 'not-production');
  assert.equal(check(s, view([s], { mode: { kind: 'sample' } })).reason, 'not-production');
  assert.equal(check({ ...s, originTz: null }, view([{ ...s, originTz: null }])).reason, 'no-date');
  for (const id of ['x1', 's_ABCDEF0123456789', 's_0123', 'h_0123456789abcdef']) {
    assert.equal(check({ ...s, id }, view([{ ...s, id }])).reason, 'no-sector-id', id);
  }
  assert.equal(crewEligibility({ view: null, sector: s, now: NOW, homeTz: HOME }).eligible, false);
});

test(`eligibility: date window [${CREW_HISTORY_START}, today + 120]`, () => {
  const at = (iso) => { const s = sector({ dep: Date.parse(iso) }); return check(s).eligible; };
  assert.equal(at('2022-08-01T08:00:00Z'), true);
  assert.equal(at('2022-07-31T08:00:00Z'), false);
  assert.equal(at('2027-02-19T08:00:00Z'), true, 'today (2026-10-22) + 120 days');
  assert.equal(at('2027-02-20T08:00:00Z'), false);
});

test('privacy: the runtime writes nothing but crew.enabled (crew answers stay in memory; no roster/calendar/history keys)', async () => {
  const h = setup();
  h.runtime.setEnabled(true);
  await h.runtime.capability();
  await h.runtime.start();
  assert.deepEqual([...h.storage.map.keys()], [`fc.v2.${CREW_ENABLED_KEY}`]);
});

test('batch fix1: consent changes, cross-tab crew storage changes and access changes invalidate (authorization epoch); unrelated keys do not', () => {
  const h = setup();
  const events = [];
  h.runtime.subscribe((e) => events.push(e.type));
  const a0 = h.runtime.authorization();
  assert.equal(a0.authorized, false);
  h.runtime.setEnabled(true);
  const a1 = h.runtime.authorization();
  assert.notEqual(a1.key, a0.key);
  h.runtime.storageChanged('fc.v2.theme');
  assert.equal(h.runtime.authorization().key, a1.key, 'unrelated key: no invalidation');
  h.runtime.storageChanged(`fc.v2.${CREW_CREDENTIAL_KEY}`);
  h.runtime.storageChanged(`fc.v2.${CREW_ENABLED_KEY}`);
  h.runtime.storageChanged(null);
  h.runtime.accessChanged();
  h.runtime.connectivityChanged(true);
  assert.deepEqual(events, ['invalidated', 'invalidated', 'invalidated', 'invalidated', 'invalidated', 'online']);
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /crew\.storageChanged\(event\.key\)/);
  assert.match(main, /'fc\.v2\.crew\.v1'/);
  assert.match(main, /'fc\.v2\.crew\.enabled'/);
});
