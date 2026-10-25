// Crew Intelligence Phase 1c Stage A: strict crew response validation and request builders
// (src/sources/crew-v2.js). Exact key sets at every level, identity guard, enum/range/consistency
// checks, refusal shapes, backend semantics copied (never upgraded). The last test drives the simulated
// backend handlers (CrewApiV2.gs, not routed) to prove that real answers pass. Synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GS_FILES } from './gs-harness.js';
import { member, owner, synthId, fakeStore, handlerDeps, toRaw, dayStart } from './fixtures/crew.synthetic.mjs';
import {
  CREW_ERROR_CODES, CREW_INDEX_OUTCOMES, CREW_INDEX_MAX_MONTHS, validateCrew, validateCrewIndex, validateCrewEnroll, validateCrewRevoke,
  crewEnrollRequest, crewIndexRequest, crewRequest, crewRevokeRequest,
} from '../src/sources/crew-v2.js';
import {
  crewAnswer, unlistedAnswer, indexAnswer, enrollAnswer, revokeAnswer, refusal, sampleMembers, idShaped, SECTOR, SECTOR_2, TOKEN, T0,
} from './fixtures/crew-frontend.synthetic.mjs';

const check = (payload, sectorId = SECTOR) => validateCrew(payload, { sectorId });
const reason = (payload, sectorId) => {
  const r = check(payload, sectorId);
  assert.equal(r.ok, false, 'must be rejected');
  return r.reason ?? `refused:${r.refused}`;
};
const withMember = (i, patch) => {
  const members = sampleMembers();
  members[i] = { ...members[i], ...patch };
  return crewAnswer({ members });
};
const without = (obj, key) => { const o = { ...obj }; delete o[key]; return o; };
const isDeepFrozen = (v) => !v || typeof v !== 'object' || (Object.isFrozen(v) && Object.values(v).every(isDeepFrozen));

test('valid answer: a new deep-frozen value built field by field; state and hint copied', () => {
  const input = crewAnswer({ state: 'incomplete', reasons: ['missing-records'], indexingSuggested: false });
  const r = check(input);
  assert.equal(r.ok, true, r.reason);
  assert.notEqual(r.value, input);
  assert.notEqual(r.value.members[0], input.members[0]);
  assert.ok(isDeepFrozen(r.value));
  assert.equal(r.value.history.state, 'incomplete', 'never upgraded');
  assert.equal(r.value.history.indexingSuggested, false, 'kept as given');
  assert.deepEqual(r.value.members.map((m) => m.match), ['recorded', 'none', 'uncertain', 'stale', 'suppressed', 'unavailable', 'unavailable']);
  assert.deepEqual(JSON.parse(JSON.stringify(r.value)), input, 'the value carries exactly the validated wire data');
  const unlisted = check(unlistedAnswer());
  assert.equal(unlisted.ok, true);
  assert.deepEqual([unlisted.value.crewListed, unlisted.value.history, unlisted.value.members], [false, null, []]);
});

test('names keep hyphens, apostrophes (straight and typographic), periods, spaces and umlauts', () => {
  for (const [given, family] of [['ANA-LENA', "O'BRIEN"], ['JÖRG', 'D’ARCY'], ['SAM J.', 'VAN PLACEHOLDER'], ['Änne', 'Übel']]) {
    const r = check(withMember(0, { given, family }));
    assert.equal(r.ok, true, `${given} ${family}: ${r.reason}`);
    assert.deepEqual([r.value.members[0].given, r.value.members[0].family], [given, family]);
  }
});

test('schema rejection: an unexpected key at the top, history, member or last level', () => {
  assert.equal(reason(crewAnswer({ top: { debug: true } })), 'unexpected-field');
  const a = crewAnswer();
  a.history = { ...a.history, verifiedAt: T0 };
  assert.equal(reason(a), 'unexpected-field');
  assert.equal(reason(withMember(1, { note: 'x' })), 'unexpected-field');
  assert.equal(reason(withMember(0, { last: { date: '2026-09-14', flightNumber: 'DE1234', route: 'FRA-PMI', aircraft: 'DABCD' } })), 'unexpected-field');
  for (const key of ['id', 'key', 'employee', 'staffId', 'base', 'basis']) {
    assert.equal(reason(withMember(1, { [key]: 'FRA' })), 'unexpected-field', key);
  }
  assert.equal(reason(without(crewAnswer(), 'generatedAt')), 'missing-field');
  assert.equal(check(withMember(1, { count: undefined })).ok, false, 'undefined is not a count');
});

test('identity guard: identifier-shaped strings anywhere are rejected; never echoed in the reason', () => {
  const id = idShaped(7);
  assert.equal(reason(withMember(0, { family: id })), 'identifier-shaped');
  assert.equal(reason(withMember(1, { given: `SAMPLE ${id}` })), 'identifier-shaped');
  assert.equal(reason(withMember(0, { last: { date: '2026-09-14', flightNumber: 'DE12345', route: 'FRA-PMI' } })), 'identifier-shaped', '5 digits');
  assert.equal(reason(crewAnswer({ top: { [id]: 1 } })), 'identifier-shaped', 'keys too');
  assert.equal(reason(crewAnswer({ reasons: [id] })), 'identifier-shaped');
  const r = check(withMember(0, { family: id }));
  assert.equal(JSON.stringify(r).includes(id), false);
});

test('schema rejection: digits in names, bad names, bad ranks', () => {
  assert.equal(reason(withMember(0, { given: 'ALEX2' })), 'bad-name');
  assert.equal(reason(withMember(0, { family: '-SAMPLE' })), 'bad-name');
  assert.equal(reason(withMember(0, { family: '' })), 'bad-name');
  assert.equal(reason(withMember(0, { family: 'A'.repeat(41) })), 'bad-name');
  assert.equal(reason(withMember(0, { family: 'SAMPLE;' })), 'bad-name');
  assert.equal(reason(withMember(0, { rank: 'cp' })), 'bad-rank');
  assert.equal(reason(withMember(0, { rank: 'CPTX' })), 'bad-rank');
  assert.equal(reason(withMember(6, { rank: 'CP' })), 'inconsistent-member', 'an unreadable line has no rank');
  assert.equal(reason(withMember(6, { match: 'none', count: 0 })), 'inconsistent-member', 'an unreadable line has no match');
});

test('schema rejection: bad enums, duplicate reasons, impossible complete state, bad dates', () => {
  assert.equal(reason(crewAnswer({ state: 'done' })), 'bad-state');
  assert.equal(reason(crewAnswer({ reasons: ['other'] })), 'bad-reasons');
  assert.equal(reason(crewAnswer({ state: 'incomplete', reasons: ['missing-records', 'missing-records'] })), 'bad-reasons');
  assert.equal(reason(crewAnswer({ state: 'complete', reasons: ['missing-records'] })), 'inconsistent-history');
  assert.equal(check(crewAnswer({ state: 'complete', reasons: ['grouping-uncertain'] })).ok, true);
  assert.equal(reason(withMember(0, { match: 'maybe' })), 'bad-match');
  assert.equal(reason(crewAnswer({ indexingSuggested: 'yes' })), 'bad-history');
  const a = crewAnswer();
  a.history = { ...a.history, basis: 'calendar' };
  assert.equal(reason(a), 'bad-history');
  const b = crewAnswer();
  b.history = { ...b.history, from: '2022-02-30' };
  assert.equal(reason(b), 'bad-history');
  assert.equal(reason(withMember(0, { last: { date: '2026-13-01', flightNumber: 'DE1234', route: 'FRA-PMI' } })), 'bad-last');
  assert.equal(reason(withMember(0, { last: { date: '2026-09-14', flightNumber: 'DE1234', route: 'FRA–PMI' } })), 'bad-last');
  assert.equal(reason(crewAnswer({ top: { generatedAt: Number.NaN } })), 'bad-generated-at');
  assert.equal(reason(crewAnswer({ top: { version: 3 } })), 'contract-mismatch');
  assert.equal(reason(crewAnswer({ top: { action: 'crewIndex' } })), 'wrong-action');
});

test('schema rejection: count/match inconsistencies', () => {
  assert.equal(reason(withMember(0, { count: 0 })), 'inconsistent-count', 'recorded needs ≥ 1');
  assert.equal(reason(withMember(0, { count: 1.5 })), 'inconsistent-count');
  assert.equal(reason(withMember(1, { count: null })), 'inconsistent-count', 'none is 0 (CrewCoreV2.gs)');
  assert.equal(reason(withMember(1, { last: { date: '2026-09-14', flightNumber: 'DE1234', route: 'FRA-PMI' } })), 'inconsistent-member');
  assert.equal(reason(withMember(2, { count: 2 })), 'inconsistent-count', 'uncertain has no number');
  assert.equal(reason(withMember(2, { recordedMatch: 'yes' })), 'inconsistent-member');
  assert.equal(reason(withMember(3, { count: 2 })), 'inconsistent-count', 'stale has no current number');
  assert.equal(reason(crewAnswer({ members: [without(sampleMembers()[3], 'asOfRecorded')] })), 'inconsistent-member', 'stale carries asOfRecorded');
  assert.equal(reason(withMember(4, { count: 1 })), 'inconsistent-count');
  assert.equal(reason(withMember(0, { recordedMatch: true })), 'inconsistent-member', 'recordedMatch only with uncertain');
  assert.equal(reason(withMember(2, { asOfRecorded: 1 })), 'inconsistent-member', 'asOfRecorded only with stale');
  assert.equal(reason(withMember(4, { last: null })), 'inconsistent-member', 'last only with recorded/none');
  assert.equal(check(withMember(3, { asOfRecorded: null })).ok, true, 'stale with an uncertain as-of value');
});

test('schema rejection: wrong sector, unlisted with members or history, more than 40 members', () => {
  assert.equal(reason(crewAnswer(), SECTOR_2), 'sector-mismatch');
  assert.equal(validateCrew(crewAnswer(), {}).reason, 'sector-mismatch', 'the requested sector is mandatory');
  assert.equal(reason({ ...unlistedAnswer(), members: [sampleMembers()[1]] }), 'inconsistent-unlisted');
  assert.equal(reason({ ...unlistedAnswer(), history: crewAnswer().history }), 'inconsistent-unlisted');
  const many = Array.from({ length: 41 }, () => sampleMembers()[1]);
  assert.equal(reason(crewAnswer({ members: many })), 'bad-members');
  assert.equal(check(crewAnswer({ members: many.slice(0, 40) })).ok, true);
  assert.equal(reason(null), 'not-an-object');
  assert.equal(reason([]), 'not-an-object');
  assert.equal(reason({ ...crewAnswer(), ok: 'true' }), 'not-ok');
});

test('refusal shapes: exactly {ok:false, error:<known code>}; revoke-incomplete may add state/remaining', () => {
  for (const code of CREW_ERROR_CODES) assert.deepEqual(check(refusal(code)), { ok: false, refused: code });
  assert.deepEqual(check(refusal('unknown-thing')), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(check(refusal('busy', { detail: 'x' })), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(check(refusal('busy', { remaining: 1 })), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(check({ ok: false }), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(validateCrewRevoke(refusal('revoke-incomplete', { state: 'revoking', remaining: 2 })), { ok: false, refused: 'revoke-incomplete' });
  assert.deepEqual(validateCrewRevoke(refusal('revoke-incomplete', { state: 'deleted' })), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(validateCrewRevoke(refusal('revoke-incomplete', { remaining: -1 })), { ok: false, reason: 'bad-refusal' });
});

test('crewIndex, crewEnroll and crewRevoke validators: exact shapes', () => {
  const idx = validateCrewIndex(indexAnswer());
  assert.equal(idx.ok, true, idx.reason);
  assert.ok(isDeepFrozen(idx.value));
  assert.equal(validateCrewIndex({ ...indexAnswer(), extra: 1 }).reason, 'unexpected-field');
  assert.equal(validateCrewIndex(indexAnswer({ total: 11 })).reason, 'bad-progress', 'progress parts add up to total');
  assert.equal(validateCrewIndex({ ...indexAnswer(), outcomes: { committed: -1 } }).reason, 'bad-outcomes');
  assert.equal(validateCrewIndex({ ...indexAnswer(), progress: { ...indexAnswer().progress, months: [] } }).reason, 'unexpected-field');
  assert.equal(validateCrewIndex({ ...indexAnswer(), cleanupPending: 'no' }).reason, 'bad-cleanup');

  assert.deepEqual(validateCrewEnroll(enrollAnswer(3)).value, { ok: true, action: 'crewEnroll', enrolled: true, G: 3 });
  assert.equal(validateCrewEnroll(enrollAnswer(0)).reason, 'bad-generation');
  assert.equal(validateCrewEnroll({ ...enrollAnswer(), grant: 'x' }).reason, 'unexpected-field');
  assert.deepEqual(validateCrewEnroll(refusal('enroll-closed')), { ok: false, refused: 'enroll-closed' });

  assert.deepEqual(validateCrewRevoke(revokeAnswer()).value, { ok: true, action: 'crewRevoke', state: 'deleted', deletedKeys: 4 });
  assert.deepEqual(validateCrewRevoke(revokeAnswer({ recorded: true, cacheCleared: false })).value,
    { ok: true, action: 'crewRevoke', state: 'deleted', deletedKeys: 4, recorded: true, cacheCleared: false });
  assert.equal(validateCrewRevoke(revokeAnswer({ cacheCleared: true })).reason, 'bad-cache-cleared');
  assert.equal(validateCrewRevoke(revokeAnswer({ state: 'revoking' })).reason, 'bad-state');
  assert.equal(validateCrewRevoke(revokeAnswer({ recorded: false })).reason, 'bad-recorded');
});

test('item 3: crewIndex outcomes are an exact allow-list of backend outcomes; counts add up to processed', () => {
  assert.deepEqual([...CREW_INDEX_OUTCOMES].sort(), [
    'aborted-conflict', 'aborted-generation', 'busy', 'committed', 'index-incompatible', 'not-sealable', 'replaceFailed',
    'replaceFailed-unpersisted', 'touch-failed', 'uncovered', 'verified',
  ]);
  for (const outcome of CREW_INDEX_OUTCOMES) {
    const r = validateCrewIndex({ ...indexAnswer({ processed: 2 }), outcomes: { [outcome]: 2 } });
    assert.equal(r.ok, true, `${outcome}: ${r.reason}`);
  }
  const mixed = validateCrewIndex({ ...indexAnswer({ processed: 6 }), outcomes: { replaceFailed: 1, 'replaceFailed-unpersisted': 1, committed: 3, 'not-sealable': 1 } });
  assert.equal(mixed.ok, true, mixed.reason);
  for (const key of ['sample-person', 'employee', 'constructor', 'toString', 'Committed']) {
    assert.equal(validateCrewIndex({ ...indexAnswer(), outcomes: { [key]: 1 } }).reason, 'bad-outcomes', key);
  }
  assert.equal(validateCrewIndex({ ...indexAnswer(), outcomes: JSON.parse('{"__proto__":1}') }).reason, 'bad-outcomes');
  assert.equal(validateCrewIndex({ ...indexAnswer({ processed: 0 }), outcomes: { committed: 3 } }).reason, 'bad-outcomes', 'sum must equal processed');
  assert.equal(validateCrewIndex({ ...indexAnswer({ processed: 2 }), outcomes: { committed: 1, verified: 0 } }).reason, 'bad-outcomes', 'zero counts never occur');
  assert.equal(validateCrewIndex({ ...indexAnswer({ processed: CREW_INDEX_MAX_MONTHS + 1 }), outcomes: { committed: CREW_INDEX_MAX_MONTHS + 1 } }).reason, 'bad-processed');
  // revoke-incomplete extras belong to crewRevoke only.
  assert.deepEqual(validateCrew(refusal('revoke-incomplete', { state: 'revoking', remaining: 2 }), { sectorId: SECTOR }), { ok: false, reason: 'bad-refusal' });
  assert.deepEqual(validateCrew(refusal('revoke-incomplete'), { sectorId: SECTOR }), { ok: false, refused: 'revoke-incomplete' });
});

test('request builders: fc.roster v2 envelope; undefined options are omitted', () => {
  assert.deepEqual(crewEnrollRequest(TOKEN, 'CODE', 'g'), { contract: 'fc.roster', version: 2, action: 'crewEnroll', token: TOKEN, code: 'CODE', grant: 'g' });
  assert.deepEqual(crewIndexRequest(TOKEN, 'g'), { contract: 'fc.roster', version: 2, action: 'crewIndex', token: TOKEN, grant: 'g' });
  assert.deepEqual(Object.keys(crewIndexRequest(TOKEN, 'g', { verifyBefore: undefined })).sort(), ['action', 'contract', 'grant', 'token', 'version']);
  assert.equal(crewIndexRequest(TOKEN, 'g', { verifyBefore: T0, retryUncovered: true }).verifyBefore, T0);
  assert.deepEqual(crewRequest(TOKEN, 'g', { sectorId: SECTOR, date: '2026-10-20' }),
    { contract: 'fc.roster', version: 2, action: 'crew', token: TOKEN, grant: 'g', sectorId: SECTOR, date: '2026-10-20' });
  assert.deepEqual(crewRevokeRequest(TOKEN, 'g', 'r'), { contract: 'fc.roster', version: 2, action: 'crewRevoke', token: TOKEN, grant: 'g', revokeId: 'r' });
});

// --- Real (simulated) backend answers pass the validators -----------------------------------------------

function loadCrewBackend() {
  const sandbox = { console };
  vm.createContext(sandbox);
  const dir = new URL('../backend/apps-script/', import.meta.url);
  const code = [...GS_FILES, 'CrewCoreV2.gs', 'CrewCondorV2.gs', 'CrewApiV2.gs'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__x = { handle: fcv2CrewHandle_, config: FCV2_CONDOR_CONFIG_ };`, sandbox);
  return sandbox.__x;
}

test('wire compatibility: answers of the simulated backend handlers (CrewApiV2.gs) pass the strict validators', () => {
  const gs = loadCrewBackend();
  const deps = handlerDeps();
  const now = Date.parse('2026-10-22T12:00:00Z');
  const props = new Map([['FC_CREW_ENABLED', 'on'], ['FC_CREW_PEPPER', 'synthetic-pepper-for-tests-0123456789'], ['FC_CREW_SELF', synthId(999)]]);
  const cache = new Map();
  const at = (iso) => Date.parse(iso);
  const crew = [owner(), member(1, 'CP'), member(2, 'FO'), { rank: 'PU', id: null, family: "O'SAMPLE", given: 'ANA-LENA' }, { parseFailed: true }];
  const flights = [
    { sourceId: 'w-1', start: at('2026-10-02T06:00:00Z'), end: at('2026-10-02T08:30:00Z'), origin: 'FRA', destination: 'PMI', flightNumber: 'DE1501', crew },
    { sourceId: 'w-2', start: at('2026-10-02T09:30:00Z'), end: at('2026-10-02T12:00:00Z'), origin: 'PMI', destination: 'FRA', flightNumber: 'DE1502', crew },
    { sourceId: 'w-3', start: at('2026-10-15T06:00:00Z'), end: at('2026-10-15T08:30:00Z'), origin: 'FRA', destination: 'LPA', flightNumber: 'DE1503', crew: [owner(), member(1, 'CP'), member(3, 'FA')] },
    { sourceId: 'w-4', start: at('2026-10-20T06:00:00Z'), end: at('2026-10-20T09:00:00Z'), origin: 'FRA', destination: 'HER', flightNumber: 'DE1505', crew: null },
  ];
  const env = {
    token: () => TOKEN, now: () => now, config: gs.config,
    props: { get: (k) => (props.has(k) ? props.get(k) : null), set: (k, v) => props.set(k, v), del: (k) => props.delete(k) },
    store: fakeStore(),
    cache: { get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), removeAll: (keys) => keys.forEach((k) => cache.delete(k)) },
    lock: (fn) => ({ ok: true, value: fn() }),
    readRaw: (from, to) => flights.filter((f) => f.end > from && f.start < to).map((f) => toRaw(f, { synced: f.start < dayStart(deps.localDate(now)) })),
    deps,
  };
  const call = (body) => JSON.parse(JSON.stringify(gs.handle(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, ...body }), env)));
  const sid = (f) => `s_${deps.hash(String(f.sourceId)).slice(0, 16)}`;

  props.set('FC_CREW_ENROLL', `SYNTHETIC-ENROLL-CODE-0123456789|${now + 10 * 60000}`);
  const enrolled = call({ action: 'crewEnroll', code: 'SYNTHETIC-ENROLL-CODE-0123456789', grant: 'grant-A' });
  assert.equal(validateCrewEnroll(enrolled).ok, true, JSON.stringify(validateCrewEnroll(enrolled)));

  const before = call({ action: 'crew', grant: 'grant-A', sectorId: sid(flights[2]), date: '2026-10-15' });
  const c1 = validateCrew(before, { sectorId: sid(flights[2]) });
  assert.equal(c1.ok, true, c1.reason);
  assert.equal(c1.value.history.state, before.history.state);
  assert.equal(c1.value.history.indexingSuggested, true, 'unindexed months: the backend suggests indexing');
  assert.deepEqual(c1.value.members.map((m) => m.match), ['recorded', 'none']);
  assert.equal(c1.value.members[0].last.route, 'PMI-FRA');

  const idx = call({ action: 'crewIndex', grant: 'grant-A' });
  const i1 = validateCrewIndex(idx);
  assert.equal(i1.ok, true, i1.reason);
  assert.ok(i1.value.processed > 0);

  const own = validateCrew(call({ action: 'crew', grant: 'grant-A', sectorId: sid(flights[0]), date: '2026-10-02' }), { sectorId: sid(flights[0]) });
  assert.equal(own.ok, true, own.reason);
  assert.deepEqual(own.value.members.map((m) => [m.rank, m.match]), [['CP', 'none'], ['FO', 'none'], ['PU', 'unavailable'], [null, 'unavailable']]);
  assert.equal(own.value.members[2].family, "O'SAMPLE");

  const unlisted = validateCrew(call({ action: 'crew', grant: 'grant-A', sectorId: sid(flights[3]), date: '2026-10-20' }), { sectorId: sid(flights[3]) });
  assert.equal(unlisted.ok, true, unlisted.reason);
  assert.equal(unlisted.value.crewListed, false);

  // Real fail-closed path: committed shards lost and their rebuild cannot be written -> replaceFailed.
  for (const k of env.store.keys().filter((x) => x.startsWith('fcx.s.'))) env.store.del(k);
  env.store.faults.set = (k) => k.startsWith('fcx.s.');
  const failed = call({ action: 'crewIndex', grant: 'grant-A' });
  env.store.faults.set = null;
  const f1 = validateCrewIndex(failed);
  assert.equal(f1.ok, true, `${f1.reason} ${JSON.stringify(failed.outcomes)}`);
  assert.ok(f1.value.outcomes.replaceFailed > 0, JSON.stringify(failed.outcomes));
  const afterFail = validateCrew(call({ action: 'crew', grant: 'grant-A', sectorId: sid(flights[0]), date: '2026-10-02' }), { sectorId: sid(flights[0]) });
  assert.equal(afterFail.ok, true, afterFail.reason);
  assert.equal(afterFail.value.history.state, 'stale', 'fail-closed answer copied as stale');
  assert.ok(afterFail.value.members.every((m) => m.count === null));

  assert.deepEqual(validateCrew(call({ action: 'crew', grant: 'grant-B', sectorId: sid(flights[0]), date: '2026-10-02' }), { sectorId: sid(flights[0]) }), { ok: false, refused: 'unauthorized' });
  const revoked = call({ action: 'crewRevoke', grant: 'grant-A', revokeId: 'revoke-1' });
  assert.equal(validateCrewRevoke(revoked).ok, true, JSON.stringify(revoked));
  assert.equal(validateCrewRevoke(call({ action: 'crewRevoke', grant: 'grant-A', revokeId: 'revoke-1' })).value.recorded, true, 'idempotent retry is recorded');
  // Phase 1d.2A: a grant that is not live is cancelled (tombstone). Trusted only when the backend advertises it.
  const cancelled = call({ action: 'crewRevoke', grant: 'grant-A', revokeId: 'revoke-2' });
  assert.deepEqual(validateCrewRevoke(cancelled), { ok: false, reason: 'bad-state' }, 'without the capability: unresolved');
  assert.deepEqual(validateCrewRevoke(cancelled, { cancel: true }).value, { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0 });
  assert.deepEqual(validateCrewRevoke(call({ action: 'crewRevoke', grant: 'grant-A', revokeId: 'revoke-3' }), { cancel: true }).value,
    { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0, recorded: true }, 'repeated cancellation is recorded');
  assert.deepEqual(validateCrew(call({ action: 'crew', grant: 'grant-A', sectorId: sid(flights[0]), date: '2026-10-02' }), { sectorId: sid(flights[0]) }), { ok: false, refused: 'crew-not-enrolled' });
});

test('Phase 1d.2A: cancelled revoke answers are strict and trusted only with the capability', () => {
  const base = { ok: true, action: 'crewRevoke', state: 'cancelled', deletedKeys: 0 };
  assert.equal(validateCrewRevoke(base).reason, 'bad-state');
  assert.equal(validateCrewRevoke(base, { cancel: false }).reason, 'bad-state');
  assert.deepEqual(validateCrewRevoke(base, { cancel: true }).value, base);
  assert.deepEqual(validateCrewRevoke({ ...base, recorded: true }, { cancel: true }).value, { ...base, recorded: true });
  assert.equal(validateCrewRevoke({ ...base, deletedKeys: 1 }, { cancel: true }).reason, 'bad-deleted-keys');
  assert.equal(validateCrewRevoke({ ...base, recorded: false }, { cancel: true }).reason, 'bad-recorded');
  assert.equal(validateCrewRevoke({ ...base, cacheCleared: false }, { cancel: true }).reason, 'unexpected-field');
  assert.equal(validateCrewRevoke({ ...base, extra: 1 }, { cancel: true }).reason, 'unexpected-field');
  assert.equal(validateCrewRevoke({ ...base, state: 'revoked' }, { cancel: true }).reason, 'bad-state');
  assert.equal(validateCrewRevoke(revokeAnswer(), { cancel: true }).value.state, 'deleted', 'deleted unchanged');
});


test('manual cutoff contract is bounded, optional and opaque only at the proof path', () => {
  const base = indexAnswer();
  assert.equal(validateCrewIndex(base).ok,true);
  const answer = c => ({...base,session:{version:1,initialOutstanding:10,remaining:9,manualCutoff:c}});
  assert.equal(validateCrewIndex(answer({at:T0,proof:'1'.repeat(64)})).ok,true);
  for (const c of [null, {}, {at:-1,proof:'a'.repeat(64)}, {at:T0,proof:'a'.repeat(65)}, {at:T0,proof:'not-a-proof'}, {at:T0,proof:'a'.repeat(64),extra:true}]) {
    assert.equal(validateCrewIndex(answer(c)).ok,false);
  }
});
