// Phase 1d.2B: crew actions routed through the existing doPost (RosterApiV2.gs), live service adapters
// (CrewApiV2.gs fcv2CrewLiveEnv_), the execution-identity + configuration gate, capability negotiation and the
// partial-deployment matrix. Everything runs in Node against fake Apps Script services
// (tests/fixtures/crew-gas-fakes.mjs) with synthetic data only; nothing is deployed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GS_FILES, CREW_GS_FILES, loadGs, localDate } from './gs-harness.js';
import { gasFakes } from './fixtures/crew-gas-fakes.mjs';
import { NOW, feedEvents, syncedEvents } from './fixtures/condor-feed.synthetic.mjs';
import { handlerDeps, crewOf, toRaw, SELF, synthId } from './fixtures/crew.synthetic.mjs';
import { crewSupportedBy, crewCancelSupported } from '../src/crew-runtime.js';

const DIR = new URL('../backend/apps-script/', import.meta.url);
const ALL = [...GS_FILES, ...CREW_GS_FILES];
const TOKEN = 'test-token-0123456789abcdef';
const OWNER = 'owner@example.invalid';
const PEPPER = 'synthetic-pepper-for-tests-0123456789';
const CODE = 'SYNTHETIC-ROUTE-CODE-0001';
const FULL = { FC_CREW_OWNER: OWNER, FC_CREW_ENABLED: 'on', FC_CREW_PEPPER: PEPPER, FC_CREW_SELF: SELF };
const CREW_ACTIONS = ['crew', 'crewEnroll', 'crewIndex', 'crewRevoke'];
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

// Synthetic crew flights: one in the synced copy (before today), one in the airline feed (after today).
const crewFlights = [
  { sourceId: 'crew-src-1', start: Date.parse('2026-09-10T06:00:00Z'), end: Date.parse('2026-09-10T08:30:00Z'), origin: 'FRA', destination: 'PMI', flightNumber: 'DE7101', crew: crewOf(1, 2) },
  { sourceId: 'crew-src-2', start: Date.parse('2026-10-20T06:00:00Z'), end: Date.parse('2026-10-20T08:30:00Z'), origin: 'FRA', destination: 'LPA', flightNumber: 'DE7103', crew: crewOf(1, 3) },
];
const feed = () => [...feedEvents(), toRaw(crewFlights[1])];
const synced = () => [...syncedEvents(), toRaw(crewFlights[0], { synced: true })];
const untagged = () => [{ sourceId: 'personal-1', title: 'Personal appointment', start: Date.parse('2026-09-10T10:00:00Z'), end: Date.parse('2026-09-10T11:00:00Z'), location: '', description: 'private' }];
const query = (f) => ({ sectorId: `s_${sha(f.sourceId).slice(0, 16)}`, date: localDate(f.start, 'Europe/Berlin') });

/** A loaded project with fake services; doPost/doGet as Apps Script calls them. */
function live({ files = ALL, script = {}, user = {}, email = OWNER, sessionThrows = false, lockBusy = false, transform = null, now = NOW, throwing = null } = {}) {
  const clock = { t: now };
  class FixedDate extends Date { static now() { return clock.t; } }
  const fakes = gasFakes({ script: { FC_V2_TOKEN: TOKEN, ...script }, user, email, sessionThrows, lockBusy, feed: feed(), synced: synced(), untagged: untagged() });
  const globals = { ...fakes.globals, Date: FixedDate };
  if (throwing) throwing(globals);
  const gs = loadGs(files, globals, transform);
  const post = (body) => JSON.parse(gs.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  const call = (action, extra = {}) => post({ contract: 'fc.roster', version: 2, token: TOKEN, action, ...extra });
  return { gs, fakes, spies: fakes.spies, clock, post, call };
}
const state = (w) => JSON.parse(w.fakes.scriptProps.map.get('FC_CREW_STATE') ?? 'null');
const fcxKeys = (w) => [...w.fakes.userProps.map.keys()].filter((k) => k.startsWith('fcx.'));
const issue = (w) => w.fakes.scriptProps.map.set('FC_CREW_ENROLL', `${CODE}|${w.clock.t + 10 * 60000}`);

/** Every non-crew answer (generatedAt is fixed by the clock). */
function nonCrew(w) {
  return [
    w.call('capabilities'), w.call('roster'), w.call('history', { from: '2026-09-01', to: '2026-09-30' }), w.call('stats'),
    w.call('departures', { airport: 'FRA', from: NOW, to: NOW + 3600000 }), w.call('flight', { flightNumber: 'DE9201', date: '2026-10-08', origin: 'FRA' }),
  ].map((x) => JSON.stringify(x));
}
const BASELINE = nonCrew(live({ files: GS_FILES }));
const capsOf = (w) => w.call('capabilities');
const extras = (caps) => caps.actions.filter((a) => !['capabilities', 'roster', 'history', 'stats', 'departures', 'flight'].includes(a)).sort();
const noOutput = (w) => assert.deepEqual(w.spies.console, [], 'nothing logged');

// --- Baseline and default deployments ---------------------------------------------------------------------

test('baseline: without crew files every crew action is the unchanged unknown-action; capabilities have no crew part', () => {
  const w = live({ files: GS_FILES, script: FULL });
  for (const a of [...CREW_ACTIONS, 'crewPurgeAll']) assert.deepEqual(w.call(a, { grant: 'g', revokeId: 'r', code: CODE }), { ok: false, error: 'unknown-action' }, a);
  assert.deepEqual(extras(capsOf(w)), []);
  assert.equal(capsOf(w).limits.crewCancel, undefined);
  assert.equal(w.spies.session, 0);
});

test('default deployment (crew files, no FC_CREW_* configuration): non-crew answers byte-identical; Session never called; crew gated', () => {
  const w = live({ script: {} });
  assert.deepEqual(nonCrew(w), BASELINE);
  assert.equal(w.call('crew', { grant: 'g', ...query(crewFlights[0]) }).error, 'crew-disabled');
  assert.equal(w.call('crewEnroll', { grant: 'g', code: CODE }).error, 'crew-disabled');
  assert.equal(w.call('crewIndex', { grant: 'g' }).error, 'crew-disabled');
  assert.deepEqual(w.call('crewRevoke', { grant: 'g', revokeId: 'r1' }), { ok: false, error: 'crew-unavailable' }, 'never a false confirmation');
  assert.deepEqual(w.call('crewPurgeAll'), { ok: false, error: 'unknown-action' });
  assert.equal(w.spies.session, 0, 'default deployments never call Session');
  assert.equal(w.spies.lock.acquired, 0);
  assert.deepEqual(fcxKeys(w), []);
  assert.equal(w.fakes.scriptProps.map.has('FC_CREW_STATE'), false, 'nothing written');
  noOutput(w);
});

// --- Gate matrix ------------------------------------------------------------------------------------------

const MATRIX = [
  ['owner missing', { script: { ...FULL, FC_CREW_OWNER: undefined } }, null, 0],
  ['owner blank', { script: { ...FULL, FC_CREW_OWNER: '   ' } }, null, 0],
  ['owner mismatch', { script: FULL, email: 'someone-else@example.invalid' }, null, 1],
  ['Session throws', { script: FULL, sessionThrows: true }, null, 1],
  ['empty email', { script: FULL, email: '' }, null, 1],
  ['switch missing', { script: { ...FULL, FC_CREW_ENABLED: undefined } }, 'revoke', 1],
  ['switch off', { script: { ...FULL, FC_CREW_ENABLED: 'off' } }, 'revoke', 1],
  ['pepper missing', { script: { ...FULL, FC_CREW_PEPPER: undefined } }, 'revoke', 1],
  ['self missing', { script: { ...FULL, FC_CREW_SELF: undefined } }, 'revoke', 1],
  ['full', { script: FULL }, 'full', 1],
  ['full, email case and spaces differ', { script: { ...FULL, FC_CREW_OWNER: ' Owner@Example.INVALID ' }, email: 'OWNER@example.invalid' }, 'full', 1],
];
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

test('gate matrix: capabilities shape, crew answers and roster byte-identity per configuration', () => {
  for (const [name, opts, mode, sessionCalls] of MATRIX) {
    const w = live({ ...opts, script: clean(opts.script) });
    const caps = capsOf(w);
    const expected = mode === 'full' ? ['crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] : mode === 'revoke' ? ['crewRevoke'] : [];
    assert.deepEqual(extras(caps), expected, `${name}: actions`);
    assert.equal(caps.limits.crewCancel, mode ? 1 : undefined, `${name}: crewCancel`);
    assert.equal(caps.actions.includes('crewPurgeAll'), false);
    if (!mode) assert.equal(JSON.stringify(caps), BASELINE[0], `${name}: base answer byte-identical`);
    // Roster, history, stats, departures, flight: byte-identical to the no-crew baseline (capabilities aside).
    assert.deepEqual(nonCrew(w).slice(1), BASELINE.slice(1), `${name}: non-crew answers`);
    const revoke = w.call('crewRevoke', { grant: 'never-enrolled', revokeId: 'r-1' });
    if (mode) assert.deepEqual(revoke, { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0 }, `${name}: revoke reaches the logic`);
    else assert.deepEqual(revoke, { ok: false, error: 'crew-unavailable' }, `${name}: revoke unavailable`);
    if (mode !== 'full') {
      assert.equal(w.call('crew', { grant: 'g', ...query(crewFlights[0]) }).error, 'crew-disabled', name);
      issue(w);
      assert.equal(w.call('crewEnroll', { grant: 'g', code: CODE }).error, 'crew-disabled', name);
      assert.ok(w.fakes.scriptProps.map.has('FC_CREW_ENROLL'), `${name}: code untouched`);
      assert.equal(w.call('crewIndex', { grant: 'g' }).error, 'crew-disabled', name);
    }
    if (!mode) assert.equal(w.fakes.scriptProps.map.has('FC_CREW_STATE'), false, `${name}: nothing written`);
    if (sessionCalls === 0) assert.equal(w.spies.session, 0, `${name}: Session not called without an owner`);
    else assert.ok(w.spies.session >= 1, `${name}: identity evaluated`);
    noOutput(w);
  }
});

test('full mode end to end through doPost: enroll, index, crew, revoke (real live adapters, non-reentrant lock)', () => {
  const w = live({ script: FULL });
  issue(w);
  const grant = 'synthetic-grant-route-0001';
  assert.deepEqual(w.call('crewEnroll', { grant, code: CODE }), { ok: true, action: 'crewEnroll', enrolled: true, G: 1 });
  assert.equal(w.fakes.scriptProps.map.has('FC_CREW_ENROLL'), false, 'code consumed');
  let idx;
  for (let i = 0; i < 20; i += 1) { idx = w.call('crewIndex', { grant }); if (!idx.ok || idx.progress?.done) break; }
  assert.equal(idx.ok, true, JSON.stringify(idx));
  assert.ok(fcxKeys(w).length > 0, 'index stored in User Properties (fcx.*)');
  assert.ok(fcxKeys(w).every((k) => !k.includes(SELF)), 'no identifier in keys');
  const crew = w.call('crew', { grant, ...query(crewFlights[0]) });
  assert.equal(crew.ok, true, JSON.stringify(crew));
  const text = JSON.stringify(crew);
  assert.equal(text.includes(synthId(1)) || text.includes(SELF), false, 'no employee ids in the answer');
  assert.ok(text.includes('SAMPLEB'), 'synthetic colleague listed');
  assert.equal(w.call('crew', { grant: 'wrong-grant', ...query(crewFlights[0]) }).ok, false);
  const r = w.call('crewRevoke', { grant, revokeId: 'r-route-1' });
  assert.equal(r.state, 'deleted', JSON.stringify(r));
  assert.deepEqual(fcxKeys(w), []);
  assert.equal(w.spies.lock.nested, 0, 'no nested script lock');
  assert.ok(w.spies.lock.acquired > 0);
  assert.equal(w.spies.calendar.some(([, from, to]) => from >= to), false);
  noOutput(w);
});

test('pending deletion (state revoking) with the switch off: the app completes it (revocation-only mode)', () => {
  const grant = 'synthetic-grant-pending-0001';
  const w = live({ script: { ...FULL, FC_CREW_ENABLED: 'off' }, user: { 'fcx.m': '{"schema":2}', 'fcx.s.2.e.2026-09.1.0': 'x', 'other.user.key': 'kept' } });
  w.fakes.scriptProps.map.set('FC_CREW_STATE', JSON.stringify({ G: 2, phase: 'revoking', pid: 'abcd1234', epoch: 'e', grantHash: null, codeHash: null, enrolledAt: NOW - 1e6, revoke: { revokeId: 'r-pending', credHash: sha(grant), cacheKeys: [], requestedAt: NOW - 1000 }, lastRevoke: null }));
  assert.deepEqual(extras(capsOf(w)), ['crewRevoke']);
  const r = w.call('crewRevoke', { grant, revokeId: 'r-pending' });
  assert.equal(r.state, 'deleted', JSON.stringify(r));
  assert.deepEqual(fcxKeys(w), []);
  assert.equal(w.fakes.userProps.map.get('other.user.key'), 'kept');
  assert.equal(state(w).phase, 'deleted');
  noOutput(w);
});

test('interrupted purge (purging fence), switch on and off: enrollment refused, cancellation kept, capabilities per mode', () => {
  for (const enabled of ['on', 'off']) {
    const w = live({ script: { ...FULL, FC_CREW_ENABLED: enabled } });
    w.fakes.scriptProps.map.set('FC_CREW_STATE', JSON.stringify({ G: 3, phase: 'deleted', pid: null, epoch: null, grantHash: null, codeHash: null, enrolledAt: null, revoke: null, lastRevoke: null, purge: null, purging: true }));
    issue(w);
    assert.deepEqual(extras(capsOf(w)), enabled === 'on' ? ['crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] : ['crewRevoke']);
    const e = w.call('crewEnroll', { grant: 'g-late', code: CODE });
    assert.equal(e.error, enabled === 'on' ? 'enroll-closed' : 'crew-disabled', enabled);
    assert.ok(w.fakes.scriptProps.map.has('FC_CREW_ENROLL'), 'code neither burned nor consumed');
    assert.equal(w.call('crewRevoke', { grant: 'g-other', revokeId: 'r' }).state, 'cancelled');
    assert.equal(state(w).purging, true, 'fence kept');
  }
});

// --- Limiter, contract and reachability -------------------------------------------------------------------

test('wrong token: the existing limiter counts and answers before any crew code runs (crew env never built)', () => {
  const w = live({ script: FULL });
  const answers = [];
  for (let i = 0; i < 22; i += 1) answers.push(w.post({ contract: 'fc.roster', version: 2, token: 'wrong-token', action: CREW_ACTIONS[i % 4], grant: 'g', revokeId: 'r' }).error);
  assert.deepEqual(answers.slice(0, 20), Array(20).fill('unauthorized'));
  assert.deepEqual(answers.slice(20), ['rate-limited', 'rate-limited']);
  assert.equal(w.post({ contract: 'fc.roster', version: 3, token: TOKEN, action: 'crewRevoke', grant: 'g', revokeId: 'r' }).error, 'unsupported-contract');
  assert.equal(w.spies.session, 0, 'no identity check');
  assert.equal(w.spies.userStore, 0, 'User Properties never opened');
  assert.equal(w.spies.lock.acquired + w.spies.lock.refused, 0);
  assert.equal(w.fakes.scriptProps.map.has('FC_CREW_STATE'), false);
  // The correct token is unaffected by the limiter.
  assert.equal(w.call('crewRevoke', { grant: 'g', revokeId: 'r' }).state, 'cancelled');
});

test('crewPurgeAll is unreachable through doPost, doGet and the crew route; nothing changes', () => {
  const w = live({ script: { ...FULL, FC_CREW_PURGE_CONFIRM: 'PURGE-ALL-CREW-DATA' }, user: { 'fcx.m': '{}' } });
  assert.deepEqual(w.call('crewPurgeAll'), { ok: false, error: 'unknown-action' });
  assert.deepEqual(JSON.parse(w.gs.doGet({ parameter: { action: 'crewPurgeAll' } }).text), { success: false, message: 'Not available.' });
  const routed = w.gs.fcv2CrewRoute_({ action: 'crewPurgeAll' }, JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'crewPurgeAll' }), w.gs.fcv2LiveEnv_());
  assert.equal(routed.ok, false);
  assert.equal(w.fakes.scriptProps.map.get('FC_CREW_PURGE_CONFIRM'), 'PURGE-ALL-CREW-DATA');
  assert.deepEqual(fcxKeys(w), ['fcx.m']);
  noOutput(w);
});

// --- Partial deployments --------------------------------------------------------------------------------

test('partial deployment: any crew file missing, or an older file without one needed function -> unchanged unknown-action', () => {
  const variants = CREW_GS_FILES.map((f) => ({ name: `without ${f}`, files: ALL.filter((x) => x !== f) }));
  for (const fn of ['fcv2CrewTombstoned_', 'fcv2CrewReaderFrom_', 'fcv2CrewPurge_', 'fcv2CrewHandle_']) {
    variants.push({ name: `older file without ${fn}`, files: ALL, transform: (file, src) => src.replace(new RegExp(`function ${fn}\\(`), `function ${fn}Removed(`) });
  }
  for (const v of variants) {
    const w = live({ files: v.files, transform: v.transform ?? null, script: FULL });
    for (const a of CREW_ACTIONS) assert.deepEqual(w.call(a, { grant: 'g', revokeId: 'r', code: CODE }), { ok: false, error: 'unknown-action' }, `${v.name}: ${a}`);
    assert.deepEqual(nonCrew(w), BASELINE, `${v.name}: base answers byte-identical`);
    assert.equal(w.spies.session, 0, v.name);
  }
});

test('the availability check covers every function defined in the three crew files', () => {
  const src = readFileSync(new URL('CrewApiV2.gs', DIR), 'utf8');
  const body = src.slice(src.indexOf('function fcv2CrewAvailable_('), src.indexOf('\n}\n', src.indexOf('function fcv2CrewAvailable_(')));
  const checked = new Set([...body.matchAll(/typeof (\w+)/g)].map((m) => m[1]));
  const defined = CREW_GS_FILES.flatMap((f) => [...readFileSync(new URL(f, DIR), 'utf8').matchAll(/^function (fcv2\w+_)\(/gm)].map((m) => m[1]));
  assert.ok(defined.length > 60);
  assert.deepEqual(defined.filter((n) => !checked.has(n)), [], 'unchecked crew functions');
});

test('exceptions inside crew code: crew actions answer crew-unavailable without details; capabilities fall back to the base answer', () => {
  const w = live({ script: FULL, throwing: (g) => { g.PropertiesService = { ...g.PropertiesService, getUserProperties: () => { throw new Error('secret detail'); } }; } });
  for (const a of CREW_ACTIONS) assert.deepEqual(w.call(a, { grant: 'g', revokeId: 'r', code: CODE }), { ok: false, error: 'crew-unavailable' }, a);
  assert.equal(JSON.stringify(capsOf(w)), BASELINE[0]);
  assert.deepEqual(nonCrew(w).slice(1), BASELINE.slice(1));
  noOutput(w);
});

test('lock contention through the live lock: busy, nothing changed', () => {
  const w = live({ script: FULL, lockBusy: true });
  issue(w);
  assert.equal(w.call('crewEnroll', { grant: 'g', code: CODE }).error, 'busy');
  assert.equal(w.call('crewRevoke', { grant: 'g', revokeId: 'r' }).error, 'busy');
  assert.ok(w.fakes.scriptProps.map.has('FC_CREW_ENROLL'));
  assert.equal(w.fakes.scriptProps.map.has('FC_CREW_STATE'), false);
});

// --- Live adapters ------------------------------------------------------------------------------------------

test('live deps produce the same formats as the synthetic handler deps (hash, HMAC, base-zone dates incl. DST, pack)', () => {
  const w = live({ script: FULL });
  const env = w.gs.fcv2CrewLiveEnv_(w.gs.fcv2LiveEnv_());
  const d = env.deps;
  const syn = handlerDeps();
  for (const s of ['', 'grant-ä-ß-✈', 'x'.repeat(300)]) {
    assert.equal(d.hash(s), syn.hash(s));
    assert.equal(d.hmacHex(PEPPER, s), syn.hmacHex(PEPPER, s));
    assert.equal(d.hmacKey(PEPPER, `id|${s}`), syn.hmacKey(PEPPER, `id|${s}`));
    assert.match(d.hmacKey(PEPPER, s), /^[A-Za-z0-9_-]{22}$/);
  }
  const instants = ['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', '2026-10-31T22:59:00Z', '2026-10-31T23:00:00Z', '2026-12-31T23:00:00Z', '2026-06-30T22:00:00Z'].map(Date.parse);
  for (const t of instants) {
    assert.equal(d.localDate(t), syn.localDate(t), new Date(t).toISOString());
    assert.equal(d.monthOf(t), syn.monthOf(t));
  }
  for (const key of ['2026-03-29', '2026-03-30', '2026-10-25', '2026-10-26', '2026-11-01', '2027-01-01']) assert.equal(d.dayStart(key), syn.dayStart(key), key);
  for (const m of ['2026-03', '2026-04', '2026-10', '2026-11', '2027-01']) assert.equal(d.monthStart(m), syn.monthStart(m), m);
  const text = JSON.stringify({ v: 1, k: ['ä', '✈'], d: Array.from({ length: 400 }, (_, i) => i) });
  assert.equal(d.unpack(d.pack(text)), text);
  assert.equal(d.unpack(syn.pack(text)), text, 'reads what the synthetic deps wrote');
  assert.equal(syn.unpack(d.pack(text)), text, 'and vice versa');
  assert.match(d.pack(text), /^[A-Za-z0-9+/]+=*$/);
  const ids = new Set(Array.from({ length: 20 }, () => d.newId()));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test('live readRaw: synced copy (tagged only) before the start of today, airline feed from it; nothing else read', () => {
  const w = live({ script: FULL });
  const base = w.gs.fcv2LiveEnv_();
  const env = w.gs.fcv2CrewLiveEnv_(base);
  const today = base.startOfDay(localDate(NOW, 'Europe/Berlin'));
  const from = Date.parse('2026-09-01T00:00:00Z');
  const to = Date.parse('2026-11-01T00:00:00Z');
  const raws = env.readRaw(from, to);
  assert.deepEqual(w.spies.calendar, [['target', from, today], ['source', today, to]]);
  assert.equal(raws.some((r) => r.sourceId === 'personal-1' || /personal/.test(r.sourceId)), false, 'untagged personal events never read');
  assert.ok(raws.some((r) => r.sourceId === 'crew-src-1' && r.basis === 'synced-copy'));
  assert.ok(raws.some((r) => r.sourceId === 'crew-src-2' && r.basis === 'airline-feed'));
  w.spies.calendar.length = 0;
  env.readRaw(today + 3600000, to);
  assert.deepEqual(w.spies.calendar, [['source', today + 3600000, to]], 'future only: feed only');
  w.spies.calendar.length = 0;
  env.readRaw(from, today - 3600000);
  assert.deepEqual(w.spies.calendar, [['target', from, today - 3600000]], 'past only: synced copy only');
});

// --- Frontend compatibility ---------------------------------------------------------------------------------

test('frontend consumers accept every capabilities shape (base, revocation-only, full)', async () => {
  const shapes = {
    base: capsOf(live({ script: {} })),
    revoke: capsOf(live({ script: { ...FULL, FC_CREW_ENABLED: 'off' } })),
    full: capsOf(live({ script: FULL })),
  };
  assert.deepEqual([crewSupportedBy(shapes.base), crewCancelSupported(shapes.base)], [false, false]);
  assert.deepEqual([crewSupportedBy(shapes.revoke), crewCancelSupported(shapes.revoke)], [false, true]);
  assert.deepEqual([crewSupportedBy(shapes.full), crewCancelSupported(shapes.full)], [true, true]);
  // settings.js testContract (not exported): evaluated from its source with the same inputs it receives.
  const src = readFileSync(new URL('../src/ui/screens/settings.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function testContract('), src.indexOf('\nfunction contractStatus('));
  for (const [name, data] of Object.entries(shapes)) {
    const testContract = new Function('postContract', 'v2Request', 'fallbackReason', `${fn}; return testContract;`)(async () => ({ data }), () => ({}), () => 'x');
    const r = await testContract('https://example.invalid', TOKEN);
    assert.equal(r.ok, true, name);
    assert.ok(r.text.includes('capabilities, roster, history, stats'), name);
  }
});
