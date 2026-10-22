// Crew Intelligence Phase 1b (synthetic only): Condor crew-list parser, canonical duty integration,
// simulated action handlers (backend/apps-script/CrewApiV2.gs, NOT deployed, NOT routed), historical
// reconciliation (T5), concurrency, privacy invariants, partitioned-manifest benchmark and roster
// regression protection. Spec: docs/CREW-INTELLIGENCE.md (Revision 4.1 + Phase 1b).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GS_FILES, loadGs, fakeEnv } from './gs-harness.js';
import { NOW as ROSTER_NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import {
  SELF, synthId, member, owner, crewOf, flight, generateHistory, fakeStore, handlerDeps, toRaw, crewLine, dayStart, cryptoDeps, reader,
} from './fixtures/crew.synthetic.mjs';

const H = 3600000;
const DAY = 86400000;
const dir = new URL('../backend/apps-script/', import.meta.url);
const plain = (x) => JSON.parse(JSON.stringify(x));
const CREW_FILES = ['CrewCoreV2.gs', 'CrewCondorV2.gs', 'CrewApiV2.gs'];

function load(files, names) {
  const sandbox = { console };
  vm.createContext(sandbox);
  const code = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__x = { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`, sandbox);
  return sandbox.__x;
}

const gs = load([...GS_FILES, ...CREW_FILES], [
  'FCV2_CONDOR_CONFIG_', 'FCV2_AIRPORT_TZ_', 'fcv2StartOfDay_', 'fcv2HandlePost_', 'fcv2ClassifyEvent_', 'fcv2ParseDescription_',
  'fcv2CrewParseLines_', 'fcv2CrewNormalizeEvent_', 'fcv2CrewHandle_', 'fcv2CrewManifest_', 'fcv2CrewInitialState_',
  'FCV2_CREW_MANIFEST_MAX_', 'FCV2_CREW_STORE_LIMIT_', 'fcv2CrewBuildMonth_', 'fcv2CrewEncodeMonth_', 'fcv2CrewCommitMonth_',
  'fcv2CrewEnroll_', 'fcv2CrewGc_', 'fcv2CrewYearKey_', 'fcv2CrewEntryOut_', 'fcv2CrewPartKey_', 'fcv2CrewMonthIntegrity_',
]);
const CONFIG = gs.FCV2_CONDOR_CONFIG_;
const deps = handlerDeps();
const TOKEN = 'test-token-0123456789abcdef';
const PEPPER = 'synthetic-pepper-for-tests-0123456789';
const TODAY_NOW = Date.parse('2026-10-22T12:00:00Z');

// --- Fake Apps Script services ----------------------------------------------------------------------

function makeEnv({ now = TODAY_NOW, history = [], feed = [], hidden = [], initialStore = {}, props = {} } = {}) {
  const clock = { now };
  const propMap = new Map(Object.entries({ FC_CREW_ENABLED: 'on', FC_CREW_PEPPER: PEPPER, FC_CREW_SELF: SELF, ...props }));
  const cacheMap = new Map();
  const store = fakeStore(initialStore);
  const lock = { held: false };
  const hooks = { onRead: null };
  const data = { history, feed, hidden };
  const env = {
    token: () => TOKEN,
    now: () => clock.now,
    config: CONFIG,
    props: { get: (k) => (propMap.has(k) ? propMap.get(k) : null), set: (k, v) => propMap.set(k, v), del: (k) => propMap.delete(k) },
    store,
    cache: {
      get: (k) => { const e = cacheMap.get(k); return e && e.until > clock.now ? e.v : null; },
      put: (k, v, ttl) => cacheMap.set(k, { v, until: clock.now + ttl * 1000 }),
      removeAll: (keys) => keys.forEach((k) => cacheMap.delete(k)),
    },
    lock: (fn) => {
      if (lock.held) return { ok: false };
      lock.held = true;
      try { return { ok: true, value: fn() }; } finally { lock.held = false; }
    },
    readRaw: (from, to) => {
      if (hooks.onRead) { const h = hooks.onRead; hooks.onRead = null; h(); }
      const todayStart = dayStart(deps.localDate(clock.now));
      const overlap = (e) => e.end > from && e.start < to;
      const synced = data.history.filter((f) => f.start < todayStart).filter(overlap).map((f) => toRaw(f, { synced: true }));
      const fresh = [...data.history.filter((f) => f.start >= todayStart), ...data.feed].filter(overlap).map((f) => toRaw(f));
      const unknown = data.hidden.filter(overlap).map((h, i) => ({ sourceId: `dh-${h.start}-${i}`, title: h.title ?? 'DH/LH123', start: h.start, end: h.end, location: '', description: '' }));
      return [...synced, ...fresh, ...unknown];
    },
    deps,
  };
  return { env, clock, propMap, cacheMap, store, lock, hooks, data };
}

const call = (env, body) => plain(gs.fcv2CrewHandle_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, ...body }), env));
const CODE = 'SYNTHETIC-ENROLL-CODE-0123456789';
function enroll(t, grant = 'grant-A', code = CODE) {
  t.propMap.set('FC_CREW_ENROLL', `${code}|${t.clock.now + 10 * 60000}`);
  return call(t.env, { action: 'crewEnroll', code, grant });
}
function indexAll(t, grant = 'grant-A', extra = {}) {
  const runs = [];
  for (let i = 0; i < 40; i++) {
    const r = call(t.env, { action: 'crewIndex', grant, ...extra });
    runs.push(r);
    if (!r.ok || r.processed === 0) break;
    t.clock.now += 1000;
  }
  return runs;
}
/** Like indexAll, but spaced beyond the rate-limit window (long backfills). */
function indexSpaced(t, grant = 'grant-A', extra = {}, max = 200) {
  const runs = [];
  for (let i = 0; i < max; i++) {
    const r = call(t.env, { action: 'crewIndex', grant, ...extra });
    runs.push(r);
    if (!r.ok || r.processed === 0) break;
    t.clock.now += 11 * 60000;
  }
  return runs;
}
const sectorId = (f) => `s_${deps.hash(String(f.sourceId)).slice(0, 16)}`;
const crewQuery = (t, f, grant = 'grant-A') => call(t.env, { action: 'crew', grant, sectorId: sectorId(f), date: deps.localDate(f.start) });

/** Brute-force recorded count: distinct roster duties before the selected duty containing the colleague. */
function brute(history, sel, id, now) {
  const core = load(['RosterModelV2.gs', 'CrewCoreV2.gs'], ['fcv2CrewGroupDuties_']);
  const duties = plain(core.fcv2CrewGroupDuties_(history, cryptoDeps()));
  const selDuty = duties.find((d) => d.flights.some((f) => f.sourceId === sel.sourceId));
  return duties.filter((d) => d.end <= now && d.start < selDuty.start && d.key !== selDuty.key
    && d.flights.some((f) => f.crew && f.crew.some((c) => c.id === id))).length;
}

// --- Parser -------------------------------------------------------------------------------------------

test('parser: crew lines with id, without id, with and without base; CPT vs CP; duplicates once', () => {
  const desc = [
    'FRA SAMPLE AIRPORT FRA', '', 'DABCD (32N)', '',
    `CP ${synthId(1)} SAMPLE, ALEX (FRA)`,
    `CPT ${synthId(2)} EXAMPLE, JORDAN`,
    'PU PLACEHOLDER, SAM (FRA )',
    `FA ${synthId(3)} TEST-PERSON, ROBIN`,
    `FA ${synthId(3)} TEST-PERSON, ROBIN (FRA)`,
    '', 'Booking code: SAMPLE9',
  ].join('\n');
  assert.deepEqual(plain(gs.fcv2CrewParseLines_(desc, CONFIG)), [
    { rank: 'CP', id: synthId(1), family: 'SAMPLE', given: 'ALEX' },
    { rank: 'CPT', id: synthId(2), family: 'EXAMPLE', given: 'JORDAN' },
    { rank: 'PU', id: null, family: 'PLACEHOLDER', given: 'SAM' },
    { rank: 'FA', id: synthId(3), family: 'TEST-PERSON', given: 'ROBIN' },
  ]);
});

test('parser: malformed rank lines are parse failures; v5 enrichment, hotel and booking lines are never crew', () => {
  const desc = [
    `CP ${synthId(1)} SAMPLE ALEX`,                 // no comma
    `FA ${synthId(2)} SAMPLE2, ALEX (FRA)`,          // digits in a name
    `ST ${synthId(3)} ${'X'.repeat(130)}, Y`,         // over-long line: ignored, not crew
    '👥 CREW HISTORY', `😊 Colleague ${synthId(4)}`, '   • Flown together 3 times', 'Original Notes:',
    'Hotel', 'Sample Riverside Hotel', '99 Sample Street', 'Bangkok', '+66 2 000 0000',
    'Booking code: SAMPLE9', 'CPX is not a rank',
  ].join('\n');
  assert.deepEqual(plain(gs.fcv2CrewParseLines_(desc, CONFIG)), [{ parseFailed: true }, { parseFailed: true }]);
  assert.equal(gs.fcv2CrewParseLines_('FRA SAMPLE AIRPORT FRA\n\nDABCD (32N)', CONFIG), null, 'no crew list → null');
  assert.equal(gs.fcv2CrewParseLines_(null, CONFIG), null);
});

test('parser: the synced-copy form (prefix, v5 block, Original Notes) yields the same crew as the feed form', () => {
  const f = flight('2025-03-01T06:00:00Z', '2025-03-01T08:30:00Z', 'FRA', 'PMI', crewOf(5, 6));
  const a = plain(gs.fcv2CrewNormalizeEvent_(toRaw(f), CONFIG));
  const b = plain(gs.fcv2CrewNormalizeEvent_(toRaw(f, { synced: true }), CONFIG));
  assert.equal(a.type, 'flight');
  assert.deepEqual(a, b);
  assert.deepEqual(a.flight.crew.map((c) => c.id), [SELF, synthId(5), synthId(6)]);
});

test('parser: deadheads, other carriers and unknown codes are hidden events; day codes and standby are not', () => {
  const ev = (title) => plain(gs.fcv2CrewNormalizeEvent_({ sourceId: title, title, start: 1, end: 2, description: '' }, CONFIG)).type;
  assert.deepEqual(['DH/DE1234', 'LH123 FRA-MUC', 'XYZ', 'OFF', 'SB90', 'C/I'].map(ev), ['hidden', 'hidden', 'hidden', 'other', 'other', 'other']);
});

test('roster regression: loading the crew files changes no roster, history or classification output (byte-identical)', () => {
  const base = loadGs();
  const withCrew = loadGs([...GS_FILES, ...CREW_FILES]);
  const plainRoster = (g) => {
    const { env } = fakeEnv(g, { now: ROSTER_NOW, feed: feedEvents(), synced: syncedEvents(), rows: hotelRows(feedEvents()) });
    return [
      JSON.stringify(g.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'roster' }), env)),
      JSON.stringify(g.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, action: 'capabilities' }), env)),
    ];
  };
  assert.deepEqual(plainRoster(withCrew), plainRoster(base));
  const f = flight('2025-03-01T06:00:00Z', '2025-03-01T08:30:00Z', 'FRA', 'PMI', crewOf(7));
  for (const raw of [toRaw(f), toRaw(f, { synced: true })]) {
    assert.equal(JSON.stringify(gs.fcv2ClassifyEvent_(raw, CONFIG)), JSON.stringify(base.fcv2ClassifyEvent_(raw, base.FCV2_CONDOR_CONFIG_)));
    assert.equal(JSON.stringify(gs.fcv2ClassifyEvent_(raw, CONFIG)).includes(synthId(7)), false, 'roster classification never carries crew');
  }
  assert.equal(readFileSync(new URL('RouterV2.gs', dir), 'utf8').includes('fcv2CrewHandle_'), false);
  assert.equal(readFileSync(new URL('RosterApiV2.gs', dir), 'utf8').includes('fcv2Crew'), false, 'not routed');
});

// --- Handlers: gating, enrollment, authorization, rate limiting --------------------------------------

test('handlers: disabled by default; crewRevoke still answers when disabled', () => {
  const t = makeEnv({ props: { FC_CREW_ENABLED: '' } });
  assert.equal(call(t.env, { action: 'crew', grant: 'g', sectorId: 's_0123456789abcdef', date: '2026-10-01' }).error, 'crew-disabled');
  assert.equal(call(t.env, { action: 'crewEnroll', code: 'x', grant: 'g' }).error, 'crew-disabled');
  assert.equal(call(t.env, { action: 'crewRevoke', revokeId: 'r1', grant: 'g' }).error, 'stale-request', 'reaches the revoke logic');
  assert.equal(call({ ...t.env, token: () => TOKEN }, { action: 'crew', token: 'wrong' }).error, 'unauthorized');
});

test('handlers / T1: enrollment needs the owner code; a token alone can neither enroll nor replace the grant', () => {
  const t = makeEnv();
  assert.equal(call(t.env, { action: 'crewEnroll', code: CODE, grant: 'grant-A' }).error, 'enroll-closed');
  const ok = enroll(t);
  assert.deepEqual([ok.ok, ok.G], [true, 1]);
  assert.equal(t.propMap.has('FC_CREW_ENROLL'), false, 'code consumed');
  assert.equal(call(t.env, { action: 'crewEnroll', code: CODE, grant: 'grant-EVIL' }).error, 'enroll-closed', 'token holder cannot replace');
  assert.equal(call(t.env, { action: 'crewEnroll', code: CODE, grant: 'grant-A' }).G, 1, 'lost-response retry is idempotent');
  t.propMap.set('FC_CREW_ENROLL', `REAL-CODE-0123456789ABCDEF|${t.clock.now + 60000}`);
  for (let i = 0; i < 5; i++) call(t.env, { action: 'crewEnroll', code: `GUESS-${i}`, grant: 'grant-EVIL' });
  assert.equal(t.propMap.has('FC_CREW_ENROLL'), false, 'burned after 5 wrong codes');
  assert.equal(JSON.parse(t.propMap.get('FC_CREW_STATE')).G, 1, 'grant unchanged');
  t.lock.held = true;
  assert.equal(enroll(t, 'grant-B', 'OTHER-CODE-0123456789ABCD').error, 'busy');
  t.lock.held = false;
});

test('handlers: separate crew authorization; not enrolled, wrong grant and rate limit; revoke is never rate-limited', () => {
  const t = makeEnv();
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled');
  enroll(t);
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-WRONG' }).error, 'unauthorized');
  assert.equal(call(t.env, { action: 'crewIndex' }).error, 'unauthorized');
  for (let i = 0; i < 70; i++) call(t.env, { action: 'crew', grant: 'grant-A', sectorId: 'bad', date: '2026-10-01' });
  assert.equal(call(t.env, { action: 'crew', grant: 'grant-A', sectorId: 's_0123456789abcdef', date: '2026-10-01' }).error, 'rate-limited');
  assert.equal(call(t.env, { action: 'crewRevoke', revokeId: 'r1', grant: 'grant-A' }).ok, true);
});

// --- End to end ---------------------------------------------------------------------------------------

function indexedHistory(opts = {}) {
  const history = generateHistory({ seed: 11, from: '2022-08-01', until: '2026-10-31', ...opts });
  const t = makeEnv({ history });
  enroll(t);
  const runs = indexAll(t);
  return { t, history, runs };
}

test('end to end: bounded indexing completes the history; crew answers match brute force; allow-listed response', () => {
  const { t, history, runs } = indexedHistory();
  assert.ok(runs.length > 5, 'bounded: several calls');
  assert.ok(runs.every((r) => r.ok && r.processed <= 6));
  const last = runs[runs.length - 1];
  assert.deepEqual([last.progress.pending, last.progress.stale, last.progress.uncovered], [0, 0, 0]);
  assert.equal(last.progress.indexed, last.progress.total);
  const sel = history.filter((f) => f.end < TODAY_NOW).at(-1);
  const r = crewQuery(t, sel);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['action', 'contract', 'crewListed', 'generatedAt', 'history', 'members', 'ok', 'sectorId', 'version']);
  assert.deepEqual(Object.keys(r.history).sort(), ['basis', 'from', 'indexingSuggested', 'reasons', 'state']);
  assert.equal(r.history.indexingSuggested, false);
  assert.equal(r.history.state, 'complete');
  const others = sel.crew.filter((c) => c.id !== SELF);
  assert.equal(r.members.length, others.length);
  r.members.forEach((m, i) => {
    assert.ok(Object.keys(m).every((k) => ['rank', 'family', 'given', 'match', 'count', 'last'].includes(k)), JSON.stringify(Object.keys(m)));
    assert.equal(m.family, others[i].family);
    assert.equal(m.count, brute(history, sel, others[i].id, TODAY_NOW), m.family);
  });
  const text = JSON.stringify(r);
  for (const c of sel.crew) if (c.id) assert.equal(text.includes(c.id), false, 'no employee id in the response');
  assert.equal(text.includes('OWNER'), false, 'the owner is never listed');
});

test('end to end: a future sector from the airline feed uses live open months and never counts future duties', () => {
  const { t, history } = indexedHistory();
  const future = flight('2026-11-05T06:00:00Z', '2026-11-05T08:30:00Z', 'FRA', 'PMI', [owner(), ...history.filter((f) => f.end < TODAY_NOW).at(-1).crew.slice(1)]);
  const later = flight('2026-11-20T06:00:00Z', '2026-11-20T08:30:00Z', 'FRA', 'LPA', future.crew);
  t.data.feed.push(future, later);
  const r = crewQuery(t, later);
  assert.equal(r.ok, true);
  const m = r.members[0];
  assert.equal(m.count, brute([...history, future, later], later, future.crew[1].id, TODAY_NOW), 'the future 5 Nov duty is not completed and not counted');
});

test('end to end: crew list not published and not-owned sectors leak nothing', () => {
  const { t } = indexedHistory({ until: '2023-02-28' });
  const noList = flight('2026-11-03T06:00:00Z', '2026-11-03T08:30:00Z', 'FRA', 'PMI', null);
  const other = flight('2026-11-04T06:00:00Z', '2026-11-04T08:30:00Z', 'FRA', 'PMI', [member(1), member(2)]);
  t.data.feed.push(noList, other);
  assert.deepEqual(pickKeys(crewQuery(t, noList), ['ok', 'crewListed', 'members']), { ok: true, crewListed: false, members: [] });
  assert.deepEqual(crewQuery(t, other), { ok: false, error: 'sector-not-owned' });
  assert.equal(call(t.env, { action: 'crew', grant: 'grant-A', sectorId: 's_ffffffffffffffff', date: '2026-11-04' }).error, 'sector-not-found');
  assert.equal(call(t.env, { action: 'crew', grant: 'grant-A', sectorId: sectorId(other), date: '2022-07-31' }).error, 'bad-range');
});
const pickKeys = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));

test('positioning: a deadhead between two duties makes affected colleagues uncertain (no number), never a guess', () => {
  const history = [
    flight('2025-05-02T05:00:00Z', '2025-05-02T07:30:00Z', 'FRA', 'PMI', crewOf(301)),
    flight('2025-05-02T16:00:00Z', '2025-05-02T18:30:00Z', 'PMI', 'FRA', crewOf(301)),     // 8.5 h later: connected, short rest
  ];
  const sel = flight('2025-06-10T06:00:00Z', '2025-06-10T08:30:00Z', 'FRA', 'LPA', crewOf(301));
  const t = makeEnv({ history: [...history, sel], hidden: [{ start: Date.parse('2025-05-02T10:00:00Z'), end: Date.parse('2025-05-02T12:00:00Z') }] });
  enroll(t);
  indexAll(t);
  const r = crewQuery(t, sel);
  assert.deepEqual([r.members[0].match, r.members[0].count], ['uncertain', null]);
  assert.ok(r.history.reasons.includes('grouping-uncertain'));
});

// --- T5: reconciliation of corrections and deletions ------------------------------------------------

test('T5: deleted flights, changed crew lists, corrected titles and a duty moved across months are reconciled; counted once', () => {
  const { t, history } = indexedHistory({ until: '2026-10-31' });
  const sel = history.filter((f) => f.end < TODAY_NOW).at(-1);
  const victim = sel.crew[1].id;
  const before = crewQuery(t, sel).members[0].count;
  // 1) delete one past flight shared with the colleague; 2) change a crew list; 3) correct a title;
  // 4) move a whole duty from 31 May 2024 to 1 June 2024 (across the month boundary).
  const shared = history.filter((f) => f.end < sel.start - 30 * DAY && f.crew.some((c) => c.id === victim));
  assert.ok(shared.length >= 1, 'fixture has an earlier shared flight');
  const del = shared[0];
  // Delete the whole shared duty (all its legs share one generated crew list and lie within 16 h): counts are per duty.
  t.data.history = t.data.history.filter((f) => !(f.crew === del.crew && Math.abs(f.start - del.start) < 16 * H));
  const change = t.data.history.find((f) => f.start < Date.parse('2023-06-01T00:00:00Z') && f.crew.length > 3);
  change.crew = [...change.crew.slice(0, 3), member(4321)];
  const retitle = t.data.history.find((f) => f.start > Date.parse('2024-02-01T00:00:00Z'));
  retitle.flightNumber = 'DE9999';
  const quiet = [Date.parse('2024-05-29T00:00:00Z'), Date.parse('2024-06-03T00:00:00Z')];   // clear the days around the move
  t.data.history = t.data.history.filter((f) => f.end <= quiet[0] || f.start >= quiet[1]);
  const moving = { ...flight('2024-05-31T19:00:00Z', '2024-05-31T21:30:00Z', 'FRA', 'PMI', crewOf(4400)), sourceId: 'moving-out' };
  const movingBack = { ...flight('2024-05-31T22:30:00Z', '2024-06-01T01:00:00Z', 'PMI', 'FRA', moving.crew), sourceId: 'moving-back' };
  t.data.history.push(moving, movingBack);
  t.data.history.sort((a, b) => a.start - b.start);
  indexSpaced(t, 'grant-A', { verifyBefore: t.clock.now });      // "Re-check history" picks up every change
  moving.start = Date.parse('2024-05-31T23:30:00Z');             // 01:30 local, 1 June: the duty's home month becomes June
  moving.end = Date.parse('2024-06-01T02:00:00Z');
  movingBack.start = Date.parse('2024-06-01T03:00:00Z');
  movingBack.end = Date.parse('2024-06-01T05:30:00Z');
  const runs = indexSpaced(t, 'grant-A', { verifyBefore: t.clock.now });
  const outcomes = runs.reduce((o, r) => { Object.entries(r.outcomes || {}).forEach(([k, v]) => { o[k] = (o[k] || 0) + v; }); return o; }, {});
  assert.ok(outcomes.committed >= 2, JSON.stringify(outcomes));
  assert.ok(outcomes.verified > 30, 'unchanged months only re-verified');
  const final = runs[runs.length - 1].progress;
  assert.deepEqual([final.pending, final.stale], [0, 0], 'neighbour flags resolved');
  const after = crewQuery(t, sel);
  assert.equal(after.members[0].count, brute(t.data.history, sel, victim, TODAY_NOW));
  assert.equal(after.members[0].count, before - 1, 'deleted shared flight no longer counted');
  const movedSel = flight('2024-07-01T06:00:00Z', '2024-07-01T08:30:00Z', 'FRA', 'LPA', crewOf(4400));
  t.data.history.push(movedSel);
  indexSpaced(t, 'grant-A', { verifyBefore: t.clock.now });
  const m = crewQuery(t, movedSel).members[0];
  assert.deepEqual([m.match, m.count, m.last.date, m.last.route], ['recorded', 1, '2024-06-01', 'PMI-FRA'], 'moved duty counted once, in June');
});

test('T5: an unverified change stays visible until re-verification (documented cadence) and turns stale after 14 days', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  t.clock.now += 15 * DAY;
  const r = crewQuery(t, sel);
  assert.equal(r.history.state, 'stale');
  assert.ok(r.members.every((m) => m.count === null));
  indexAll(t);
  assert.equal(crewQuery(t, sel).history.state, 'complete');
});

// --- Concurrency -------------------------------------------------------------------------------------

test('concurrency: a revocation landing while crewIndex builds outside the lock publishes nothing and returns crew-revoked', () => {
  const history = generateHistory({ seed: 3, from: '2024-01-01', until: '2024-06-30' });
  const t = makeEnv({ history });
  enroll(t);
  t.hooks.onRead = () => assert.equal(call(t.env, { action: 'crewRevoke', revokeId: 'rev-1', grant: 'grant-A' }).state, 'deleted');
  assert.deepEqual(call(t.env, { action: 'crewIndex', grant: 'grant-A' }), { ok: false, error: 'crew-revoked' });
  assert.deepEqual(t.store.keys().filter((k) => k.startsWith('fcx.')), []);
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled');
});

test('concurrency: a revocation during a crew query withholds the result; revoke while the lock is held answers busy, retry completes', () => {
  const { t, history } = indexedHistory({ until: '2023-06-30' });
  const sel = history.filter((f) => f.end < Date.parse('2023-06-01T00:00:00Z')).at(-1);
  t.hooks.onRead = () => call(t.env, { action: 'crewRevoke', revokeId: 'rev-2', grant: 'grant-A' });
  assert.deepEqual(crewQuery(t, sel), { ok: false, error: 'crew-revoked' });
  const t2 = indexedHistory({ until: '2023-03-31' }).t;
  t2.lock.held = true;
  assert.equal(call(t2.env, { action: 'crewRevoke', revokeId: 'rev-3', grant: 'grant-A' }).error, 'busy');
  t2.lock.held = false;
  const done = call(t2.env, { action: 'crewRevoke', revokeId: 'rev-3', grant: 'grant-A' });
  assert.deepEqual([done.ok, done.state], [true, 'deleted']);
  assert.equal(call(t2.env, { action: 'crewRevoke', revokeId: 'rev-3', grant: 'grant-A' }).recorded, true);
});

test('rotation: a new pepper revokes the old index (purged) and requires re-enrollment', () => {
  const { t } = indexedHistory({ until: '2023-03-31' });
  t.propMap.set('FC_CREW_PEPPER', 'rotated-pepper-0123456789abcdef');
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-revoked');
  assert.deepEqual(t.store.keys().filter((k) => k.startsWith('fcx.')), []);
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled');
  assert.equal(enroll(t, 'grant-B', 'NEW-CODE-AFTER-ROTATION-01').ok, true);
});

// --- Storage exhaustion, privacy ----------------------------------------------------------------------

test('storage exhaustion through the handlers: unrelated properties fill the store; new months stay uncovered, answers say incomplete', () => {
  const big = {};
  for (let i = 0; i < 52; i++) big[`unrelated.${i}`] = 'z'.repeat(8900);     // ~463 KB: small manifest writes fit, month shards do not
  const history = generateHistory({ seed: 5, from: '2024-01-01', until: '2024-06-30' });
  const t = makeEnv({ history, initialStore: big });
  enroll(t);
  const runs = indexAll(t);
  const last = runs[runs.length - 1];
  const read = gs.fcv2CrewManifest_(t.store, JSON.parse(t.propMap.get('FC_CREW_STATE')), deps);
  const status = (m) => (read.manifest.months[m] ? read.manifest.months[m].status : 'absent');
  for (const m of ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06']) assert.notEqual(status(m), 'ok', `${m} holds data and cannot fit`);
  assert.equal(last.progress.indexed + last.progress.uncovered + last.progress.pending + last.progress.stale, last.progress.total);
  assert.ok(last.progress.uncovered >= 6);
  const sel = history.filter((f) => f.start > Date.parse('2024-05-01T00:00:00Z'))[0];
  assert.equal(crewQuery(t, sel).history.state, 'incomplete');
  for (const [k, v] of Object.entries(big)) assert.equal(t.store.get(k), v);
});

test('privacy: durable records, state, cache and responses hold no names or raw ids; crew files never log', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  const ids = new Set(history.flatMap((f) => f.crew.map((c) => c.id)));
  const durable = [...t.store.keys().map((k) => `${k}=${t.store.get(k)}`), ...[...t.propMap].map(([k, v]) => `${k}=${v}`), ...[...t.cacheMap].map(([k, v]) => `${k}=${JSON.stringify(v)}`)];
  const core = load(['RosterModelV2.gs', 'CrewCoreV2.gs'], ['fcv2CrewDecodeMonth_']);
  const decoded = t.store.keys().filter((k) => k.startsWith('fcx.s.')).map((k) => {
    const v = t.store.get(k);
    return JSON.stringify(core.fcv2CrewDecodeMonth_(v.split('|').slice(6).join('|'), deps, v.split('|')[2]));
  });
  const all = [...durable, ...decoded].join('\n');
  for (const id of ids) {
    if (id === SELF) continue;
    assert.equal(all.includes(id), false, 'raw id stored');
  }
  assert.equal(/SAMPLE[A-Z]|PERSON[A-Z]/.test(all), false, 'name stored');
  for (const f of ['CrewCoreV2.gs', 'CrewCondorV2.gs', 'CrewApiV2.gs']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.equal(/\bLogger\.|console\.|UrlFetchApp|CacheService|PropertiesService|CalendarApp/.test(src), false, `${f} uses no live service or log`);
  }
});

// --- Manifest capacity benchmark ---------------------------------------------------------------------

test('benchmark: single manifest (Phase 1a) vs partitioned root + year documents over 4 and 20 years', (t) => {
  const core = load(['RosterModelV2.gs', 'CrewCoreV2.gs'], ['fcv2CrewEntryOut_', 'FCV2_CREW_MANIFEST_MAX_']);
  const entry = core.fcv2CrewEntryOut_({ gen: 3, parts: 1, digest: 'a'.repeat(32), verifiedAt: TODAY_NOW, status: 'ok', missing: { noCrewList: 1 }, grouping: { chainBreak: 0 }, fp: 'b'.repeat(32), neighbour: false });
  const rows = [];
  for (const years of [4, 20, 40]) {
    const months = {};
    for (let y = 0; y < years; y++) for (let m = 1; m <= 12; m++) months[`${2022 + y}-${String(m).padStart(2, '0')}`] = entry;
    const single = JSON.stringify({ schema: 1, G: 12, epoch: 'epoch0001', mgen: 999, months, retired: [], cacheKeys: [] }).length;
    const yearDoc = `12|epoch0001|2030|9|${JSON.stringify({ m: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1).padStart(2, '0'), entry])) })}`.length;
    const yearsMap = Object.fromEntries(Array.from({ length: years }, (_, i) => [String(2022 + i), [9, 'c'.repeat(32)]]));
    const root = JSON.stringify({ schema: 2, G: 12, epoch: 'epoch0001', mgen: 999, years: yearsMap, retired: [], cacheKeys: [] }).length;
    rows.push({ years, single, root, yearDoc });
    t.diagnostic(`MEASURED manifest ${years}y: single=${single} bytes (cap ${core.FCV2_CREW_MANIFEST_MAX_}${single > core.FCV2_CREW_MANIFEST_MAX_ ? ', EXCEEDED' : ''}) · partitioned root=${root} bytes + year document=${yearDoc} bytes each`);
  }
  assert.ok(rows.find((r) => r.years === 20).single > 8000, 'the Phase 1a format cannot hold 20 years');
  assert.ok(rows.every((r) => r.root < 8000 && r.yearDoc < 8000), 'partitioned format holds 40 years');
});

test('benchmark: 20 synthetic years through real commits — store exhaustion leaves the oldest months uncovered, never a partial write', (t) => {
  const history = generateHistory({ seed: 9, from: '2022-08-01', until: '2042-07-31' });
  const tt = makeEnv({ history, now: Date.parse('2042-08-20T12:00:00Z') });
  enroll(tt);
  const t0 = performance.now();
  const runs = indexSpaced(tt, 'grant-A');
  const ms = Math.round(performance.now() - t0);
  const last = runs.at(-1).progress;
  const read = gs.fcv2CrewManifest_(tt.store, JSON.parse(tt.propMap.get('FC_CREW_STATE')), deps);
  assert.equal(read.kind, 'ok');
  const months = read.manifest.months;
  const indexed = Object.keys(months).filter((m) => months[m].status === 'ok').sort();
  const uncovered = Object.keys(months).filter((m) => months[m].status === 'uncovered').sort();
  const bytes = tt.store.keys().reduce((n, k) => n + k.length + tt.store.get(k).length, 0);
  t.diagnostic(`MEASURED 20y: months=${last.total} indexed=${indexed.length} (from ${indexed[0]}) uncovered=${uncovered.length} (newest uncovered ${uncovered.at(-1)}) store=${bytes} bytes root=${tt.store.get('fcx.m').length} bytes calls=${runs.length} node-ms=${ms}`);
  assert.ok(bytes <= 500000);
  assert.ok(uncovered.length > 0 && indexed.length > 0);
  assert.ok(uncovered.at(-1) < indexed[0], 'exhaustion leaves only the oldest months uncovered: one contiguous recent range');
  assert.equal(last.indexed + last.uncovered, last.total, 'every month is either indexed or reported uncovered');
  assert.ok(tt.store.get('fcx.m').length < 8000);
});

// --- Phase 1b correction pass: lifecycle defects reproduced by Codex ---------------------------------

const stateOf = (t) => JSON.parse(t.propMap.get('FC_CREW_STATE'));
const fcxKeys = (t) => t.store.keys().filter((k) => k.startsWith('fcx.'));

test('P1 re-enrollment: enroll → index → replace grant → index again → valid new-generation result; old grant dead, old index purged', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  const oldEpoch = stateOf(t).epoch;
  assert.ok(fcxKeys(t).length > 10);
  const re = enroll(t, 'grant-B', 'SECOND-CODE-0123456789ABCD');
  assert.deepEqual([re.ok, re.G], [true, 2]);
  assert.equal(stateOf(t).purge, null, 'cleanup completed in the same transition');
  assert.equal(fcxKeys(t).some((k) => k.includes(oldEpoch)), false, 'old generation purged');
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'unauthorized', 'old grant dead');
  const runs = indexAll(t, 'grant-B');
  assert.equal(runs.at(-1).progress.indexed, runs.at(-1).progress.total);
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  const r = crewQuery(t, sel, 'grant-B');
  assert.equal(r.history.state, 'complete');
  assert.equal(r.members[0].count, brute(t.data.history, sel, sel.crew[1].id, TODAY_NOW));
});

test('P1 re-enrollment interrupted: a failed purge stays pending, old data is never read, and the next crewIndex completes it', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31', });
  t.store.map.set('unrelated.key', 'keep');
  const oldEpoch = stateOf(t).epoch;
  let failures = 3;
  t.store.faults.del = () => failures-- > 0;                      // the first deletions fail
  const re = enroll(t, 'grant-B', 'SECOND-CODE-0123456789ABCD');
  assert.equal(re.ok, true, 'enrollment itself never blocks on cleanup');
  assert.equal(stateOf(t).purge.pending, true);
  assert.ok(fcxKeys(t).some((k) => k.includes(oldEpoch)), 'some obsolete keys remain');
  t.store.faults.del = null;
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  const before = crewQuery(t, sel, 'grant-B');
  assert.equal(before.history.state, 'incomplete', 'the obsolete index is treated as absent, not reinterpreted');
  const first = call(t.env, { action: 'crewIndex', grant: 'grant-B' });
  assert.deepEqual([first.ok, first.cleanupPending], [true, false]);
  assert.equal(fcxKeys(t).some((k) => k.includes(oldEpoch)), false);
  assert.equal(stateOf(t).purge, null);
  indexAll(t, 'grant-B');
  assert.equal(crewQuery(t, sel, 'grant-B').history.state, 'complete');
  assert.equal(t.store.get('unrelated.key'), 'keep');
});

test('P1 interrupted pepper rotation: deletion failure → storage restored → the app authenticates recovery → cleanup → re-enroll → index', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  t.propMap.set('FC_CREW_PEPPER', 'rotated-pepper-0123456789abcdef');
  t.store.faults.del = () => true;                                 // every deletion fails
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-revoked');
  assert.equal(stateOf(t).phase, 'revoking');
  assert.ok(fcxKeys(t).length > 0);
  // Fail closed: no access for anyone meanwhile; an unauthenticated caller cannot trigger the cleanup.
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-WRONG' }).error, 'crew-not-enrolled');
  assert.equal(call(t.env, { action: 'crewIndex' }).error, 'crew-not-enrolled');
  assert.ok(fcxKeys(t).length > 0, 'nothing deleted without the credential');
  t.store.faults.del = null;                                       // storage restored
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-revoked', 'cleanup resumed with the recorded grant');
  assert.deepEqual([stateOf(t).phase, fcxKeys(t)], ['deleted', []]);
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled', 'access never restored under the old pepper');
  assert.equal(call(t.env, { action: 'crewRevoke', revokeId: 'app-retry', grant: 'grant-A' }).error, 'stale-request');
  assert.equal(enroll(t, 'grant-C', 'POST-ROTATION-CODE-012345').ok, true);
  indexAll(t, 'grant-C');
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  const r = crewQuery(t, sel, 'grant-C');
  assert.equal(r.history.state, 'complete');
  assert.equal(r.members[0].count, brute(t.data.history, sel, sel.crew[1].id, TODAY_NOW));
});

test('P1 interrupted rotation, alternative recovery: an owner code supersedes the stuck revocation; the next crewIndex purges', () => {
  const { t } = indexedHistory({ until: '2023-06-30' });
  t.propMap.set('FC_CREW_PEPPER', 'rotated-pepper-0123456789abcdef');
  t.store.faults.del = () => true;
  call(t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(stateOf(t).phase, 'revoking');
  const re = enroll(t, 'grant-D', 'OWNER-RECOVERY-CODE-01234');
  assert.equal(re.ok, true);
  assert.deepEqual([stateOf(t).phase, stateOf(t).purge.pending, stateOf(t).lastRevoke.outcome], ['active', true, 'superseded']);
  t.store.faults.del = null;
  const r = call(t.env, { action: 'crewIndex', grant: 'grant-D' });
  assert.deepEqual([r.ok, r.cleanupPending], [true, false]);
  assert.equal(fcxKeys(t).every((k) => k === 'fcx.m' || k.includes(`.${stateOf(t).G}.${stateOf(t).epoch}.`)), true);
});

test('P1 cache-removal failure never blocks revocation or rotation cleanup', () => {
  const a = indexedHistory({ until: '2023-03-31' }).t;
  const root = JSON.parse(a.store.get('fcx.m'));
  root.cacheKeys = ['fcx.c.registered'];
  a.store.map.set('fcx.m', JSON.stringify(root));
  a.env.cache.removeAll = () => { throw new Error('cache unavailable'); };
  const r = call(a.env, { action: 'crewRevoke', revokeId: 'rev-cache', grant: 'grant-A' });
  assert.deepEqual([r.ok, r.state, r.cacheCleared], [true, 'deleted', false]);
  assert.deepEqual(fcxKeys(a), []);
  const b = indexedHistory({ until: '2023-03-31' }).t;
  b.env.cache.removeAll = () => { throw new Error('cache unavailable'); };
  b.propMap.set('FC_CREW_PEPPER', 'rotated-pepper-0123456789abcdef');
  assert.equal(call(b.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-revoked');
  assert.deepEqual([stateOf(b).phase, fcxKeys(b)], ['deleted', []]);
});

test('P2 capacity recovery: freed storage lets crewIndex extend coverage downward from the floor, contiguous after every call', () => {
  const big = {};
  for (let i = 0; i < 50; i++) big[`unrelated.${i}`] = 'z'.repeat(8900);
  const history = generateHistory({ seed: 5, from: '2022-08-01', until: '2026-10-31' });
  const t = makeEnv({ history, initialStore: big });
  enroll(t);
  indexAll(t);
  const statusMap = () => gs.fcv2CrewManifest_(t.store, stateOf(t), deps).manifest.months;
  const contiguous = () => {
    const m = statusMap();
    const ok = Object.keys(m).filter((k) => m[k].status === 'ok').sort();
    const all = Object.keys(m).sort();
    const sealable = all.filter((k) => k >= ok[0]);
    return ok.length > 0 && sealable.every((k) => m[k].status === 'ok');      // no gaps above the oldest covered month
  };
  const stuck = indexAll(t).at(-1).progress;
  assert.ok(stuck.uncovered > 0 && contiguous());
  const floorBefore = Object.keys(statusMap()).filter((k) => statusMap()[k].status === 'uncovered').sort().at(-1);
  // Still full: no automatic retry; an explicit retry is attempted and fails safely.
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).processed, 0);
  const explicit = call(t.env, { action: 'crewIndex', grant: 'grant-A', retryUncovered: true });
  assert.deepEqual([explicit.processed, explicit.outcomes.uncovered], [1, 1]);
  // Storage becomes available: automatic recovery, month by month, never creating a gap.
  for (let i = 0; i < 25; i++) t.store.map.delete(`unrelated.${i}`);
  let last;
  for (let i = 0; i < 40; i++) {
    last = call(t.env, { action: 'crewIndex', grant: 'grant-A' });
    t.clock.now += 1000;
    assert.ok(contiguous(), `contiguous after call ${i}`);
    if (last.processed === 0) break;
  }
  assert.equal(statusMap()[floorBefore].status, 'ok', 'the former floor month is covered');
  assert.equal(last.progress.indexed + last.progress.uncovered, last.progress.total);
  assert.ok(last.progress.indexed > stuck.indexed);
  for (let i = 25; i < 50; i++) assert.equal(t.store.get(`unrelated.${i}`), big[`unrelated.${i}`]);
});

// --- §7.5a / §7.5b: historical re-verification contract ----------------------------------------------

const verifiedAtMap = (t) => {
  const m = gs.fcv2CrewManifest_(t.store, stateOf(t), deps).manifest.months;
  return Object.fromEntries(Object.keys(m).map((k) => [k, m[k].verifiedAt]));
};
const fcxSnapshot = (t) => JSON.stringify(fcxKeys(t).sort().map((k) => [k, t.store.get(k)]));

test('freshness: crew queries never advance verifiedAt or write the index; repeated queries cannot make overdue history fresh', () => {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  const before = verifiedAtMap(t);
  const stored = fcxSnapshot(t);
  for (let i = 0; i < 5; i++) { crewQuery(t, sel); t.clock.now += 60000; }
  assert.deepEqual(verifiedAtMap(t), before, 'crew alone does not verify');
  assert.equal(fcxSnapshot(t), stored, 'crew writes nothing durable');
  t.clock.now += 15 * DAY;                                          // threshold passed: overdue, not refreshed
  for (let i = 0; i < 5; i++) {
    const r = crewQuery(t, sel);
    assert.deepEqual([r.history.state, r.history.indexingSuggested], ['stale', true]);
    assert.ok(r.members.every((m) => m.count === null));
    t.clock.now += 11 * 60000;                                       // also beyond the rate-limit window
  }
  assert.deepEqual(verifiedAtMap(t), before, 'still not verified by queries');
  const idx = indexAll(t);
  assert.ok(idx[0].outcomes.verified > 0, 'crewIndex re-verifies after the threshold');
  const fresh = crewQuery(t, sel);
  assert.deepEqual([fresh.history.state, fresh.history.indexingSuggested], ['complete', false]);
});

test('freshness: interrupted indexing keeps conservative semantics (incomplete + indexingSuggested, recorded counts only)', () => {
  const history = generateHistory({ seed: 21, from: '2022-08-01', until: '2026-10-31' });
  const t = makeEnv({ history });
  enroll(t);
  const one = call(t.env, { action: 'crewIndex', grant: 'grant-A' });     // a single bounded call: newest 6 months only
  assert.ok(one.ok && one.progress.pending > 0);
  const sel = history.filter((f) => f.end < TODAY_NOW).at(-1);
  const r = crewQuery(t, sel);
  assert.deepEqual([r.history.state, r.history.indexingSuggested], ['incomplete', true]);
  assert.ok(r.history.reasons.includes('missing-records'));
  r.members.forEach((m) => assert.ok(m.count === null || m.match === 'recorded' || m.match === 'none'));
  assert.ok(r.members.every((m) => !('bound' in m)), 'no minimum or exactness claims');
});

test('time budget is cooperative: a slow Calendar read is never interrupted; the call stops at the next check', () => {
  const history = generateHistory({ seed: 21, from: '2025-01-01', until: '2026-10-31' });
  const t = makeEnv({ history });
  enroll(t);
  const raw = t.env.readRaw;
  t.env.readRaw = (from, to) => { t.clock.now += 20000; return raw(from, to); };   // each read takes 20 s
  const started = t.clock.now;
  const r = call(t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(r.ok, true);
  assert.equal(r.processed, 1, 'stops before starting another month');
  assert.ok(t.clock.now - started > 15000, 'the budget was exceeded by the read in progress (not a hard deadline)');
});

test('freshness: unenrolled and revoked clients cannot initiate indexing (see also: authorization, rotation and concurrency tests)', () => {
  const t = makeEnv();
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled');
  enroll(t);
  assert.equal(call(t.env, { action: 'crewRevoke', revokeId: 'r-x', grant: 'grant-A' }).state, 'deleted');
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'crew-not-enrolled');
  assert.deepEqual(fcxKeys(t), []);
});

// --- Targeted recovery fix: damaged shards and the shared eligibility hint ---------------------------

const DAMAGED = '2023-09';
const partKeys = (t, month) => fcxKeys(t).filter((k) => k.startsWith('fcx.s.') && k.includes(`.${month}.`));
const manifestOf = (t) => gs.fcv2CrewManifest_(t.store, stateOf(t), deps).manifest;
/** Rewrites a month's single part and re-signs its digest in the year document and root (a "valid-looking" bad shard). */
function resign(t, month, body) {
  const key = partKeys(t, month)[0];
  const v = t.store.get(key);
  const header = v.split('|').slice(0, 6).join('|') + '|';
  t.store.map.set(key, header + body);
  const root = JSON.parse(t.store.get('fcx.m'));
  const y = month.slice(0, 4);
  const ykey = gs.fcv2CrewYearKey_(root.G, root.epoch, y, root.years[y][0]);
  const yv = t.store.get(ykey);
  const yh = yv.slice(0, yv.indexOf('{'));
  const doc = JSON.parse(yv.slice(yh.length));
  doc.m[month.slice(5)][2] = deps.hash(body).slice(0, 32);
  const yb = JSON.stringify(doc);
  t.store.map.set(ykey, yh + yb);
  root.years[y][1] = deps.hash(yb).slice(0, 32);
  t.store.map.set('fcx.m', JSON.stringify(root));
}
function damagedCase(damage) {
  const { t, history } = indexedHistory({ until: '2023-12-31' });
  const sel = history.filter((f) => f.end < Date.parse('2023-12-01T00:00:00Z')).at(-1);
  const healthy = crewQuery(t, sel);
  assert.equal(healthy.history.state, 'complete');
  const verifiedBefore = manifestOf(t).months[DAMAGED].verifiedAt;
  damage(t);
  return { t, history, sel, healthy, verifiedBefore };
}
function expectRepaired({ t, sel, healthy }) {
  const broken = crewQuery(t, sel);
  assert.equal(broken.history.state, 'stale');
  assert.equal(broken.history.indexingSuggested, true, 'repair is actionable');
  assert.ok(broken.members.every((m) => m.count === null), 'no unsupported counts');
  const r = call(t.env, { action: 'crewIndex', grant: 'grant-A' });           // immediately: no 14-day wait
  assert.equal(r.outcomes.committed, 1, JSON.stringify(r.outcomes));
  assert.equal(gs.fcv2CrewMonthIntegrity_(t.store, manifestOf(t), DAMAGED, deps), 'valid');
  const fixed = crewQuery(t, sel);
  assert.deepEqual([fixed.history.state, fixed.history.indexingSuggested], ['complete', false]);
  assert.deepEqual(fixed.members.map((m) => m.count), healthy.members.map((m) => m.count));
  assert.equal(fixed.members[0].count, brute(t.data.history, sel, sel.crew[1].id, TODAY_NOW));
}

test('repair A: a deleted committed shard is rebuilt by the next crewIndex (no threshold wait); counts match the source', () => {
  const c = damagedCase((t) => partKeys(t, DAMAGED).forEach((k) => t.store.map.delete(k)));
  expectRepaired(c);
});

test('repair B: a corrupt checksum, a wrong header and a re-signed but structurally invalid shard are all rebuilt', () => {
  expectRepaired(damagedCase((t) => { const k = partKeys(t, DAMAGED)[0]; t.store.map.set(k, t.store.get(k).slice(0, -8) + 'AAAAAAAA'); }));
  expectRepaired(damagedCase((t) => { const k = partKeys(t, DAMAGED)[0]; t.store.map.set(k, `9|x|${DAMAGED}|1|0|1|${t.store.get(k).split('|').slice(6).join('|')}`); }));
  expectRepaired(damagedCase((t) => resign(t, DAMAGED, deps.pack(JSON.stringify({ v: 1, m: DAMAGED, k: [], d: [['not-hex', 1, 2, '', []]] })))));
  expectRepaired(damagedCase((t) => resign(t, DAMAGED, 'not-base64-gzip')));
});

test('repair C: a failed reconstruction stays fail-closed (stale, no counts) and is retried once storage writes work', () => {
  const c = damagedCase((t) => partKeys(t, DAMAGED).forEach((k) => t.store.map.delete(k)));
  const { t, sel } = c;
  t.store.faults.set = (k) => k.startsWith('fcx.s.');               // the rebuilt parts cannot be written
  const r = call(t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(r.outcomes.replaceFailed, 1, JSON.stringify(r.outcomes));
  assert.notEqual(manifestOf(t).months[DAMAGED].verifiedAt > c.verifiedBefore, true, 'verifiedAt not advanced');
  const q = crewQuery(t, sel);
  assert.equal(q.history.state, 'stale');
  assert.ok(q.members.every((m) => m.count === null));
  t.store.faults.set = null;
  call(t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(crewQuery(t, sel).history.state, 'complete');
});

test('repair D: a valid unchanged month still takes the efficient path — nothing to do before the threshold, touch-only after', () => {
  const { t } = indexedHistory({ until: '2023-12-31' });
  const keys = fcxKeys(t).filter((k) => k.startsWith('fcx.s.')).sort();
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).processed, 0, 'no work while fresh and intact');
  t.clock.now += 15 * DAY;
  const r = call(t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(r.outcomes.verified, r.processed);
  assert.equal(r.outcomes.committed, undefined);
  assert.deepEqual(fcxKeys(t).filter((k) => k.startsWith('fcx.s.')).sort(), keys, 'no shard rewritten');
});

test('hint: false for an unsupported manifest schema that indexing refuses to modify', () => {
  const { t, history } = indexedHistory({ until: '2023-06-30' });
  const root = JSON.parse(t.store.get('fcx.m'));
  t.store.map.set('fcx.m', JSON.stringify({ ...root, schema: 99 }));
  const sel = history.filter((f) => f.end < Date.parse('2023-06-01T00:00:00Z')).at(-1);
  const q = crewQuery(t, sel);
  assert.deepEqual([q.history.state, q.history.indexingSuggested], ['stale', false], 'stale, but indexing cannot help');
  assert.equal(call(t.env, { action: 'crewIndex', grant: 'grant-A' }).error, 'index-incompatible');
});

test('hint: false while capacity blocks the floor; true again once capacity is available', () => {
  const big = {};
  for (let i = 0; i < 50; i++) big[`unrelated.${i}`] = 'z'.repeat(8900);
  const history = generateHistory({ seed: 5, from: '2022-08-01', until: '2026-10-31' });
  const t = makeEnv({ history, initialStore: big });
  enroll(t);
  indexAll(t);
  const m = manifestOf(t).months;
  const floor = Object.keys(m).filter((k) => m[k].status === 'uncovered').sort().at(-1);
  const sel = history.filter((f) => f.end < TODAY_NOW).at(-1);
  const blocked = crewQuery(t, sel);
  assert.equal(blocked.history.state, 'incomplete', 'uncovered history is incomplete');
  assert.equal(blocked.history.indexingSuggested, false, `floor ${floor} cannot progress under admission`);
  for (let i = 0; i < 25; i++) t.store.map.delete(`unrelated.${i}`);
  assert.equal(crewQuery(t, sel).history.indexingSuggested, true, 're-evaluated: capacity is available');
});

test('hint: false for grouping uncertainty (indexing cannot resolve it) and for complete, current history', () => {
  const history = [
    flight('2025-05-02T05:00:00Z', '2025-05-02T07:30:00Z', 'FRA', 'PMI', crewOf(301)),
    flight('2025-05-02T16:00:00Z', '2025-05-02T18:30:00Z', 'PMI', 'FRA', crewOf(301)),
  ];
  const sel = flight('2025-06-10T06:00:00Z', '2025-06-10T08:30:00Z', 'FRA', 'LPA', crewOf(301));
  const t = makeEnv({ history: [...history, sel], hidden: [{ start: Date.parse('2025-05-02T10:00:00Z'), end: Date.parse('2025-05-02T12:00:00Z') }] });
  enroll(t);
  indexAll(t);
  const r = crewQuery(t, sel);
  assert.ok(r.history.reasons.includes('grouping-uncertain'));
  assert.equal(r.members[0].match, 'uncertain');
  assert.equal(r.history.indexingSuggested, false);
});

// --- Encoded payload validation (strict, before decoding) --------------------------------------------

/** Rewrites DAMAGED's payload: fn(obj) returns an object or a raw JSON string; checksums are re-signed so only validation can reject it. */
function mutatePayload(t, fn) {
  const key = partKeys(t, DAMAGED)[0];
  const body = t.store.get(key).split('|').slice(6).join('|');
  const o = JSON.parse(deps.unpack(body));
  const out = fn(o);
  resign(t, DAMAGED, deps.pack(typeof out === 'string' ? out : JSON.stringify(out)));
}
const firstWithKeys = (o) => o.d.findIndex((x) => x[4].some((s) => s[2].length > 0));
function expectNo1970(...responses) {
  for (const r of responses) assert.equal(JSON.stringify(r).includes('1970'), false, 'no fabricated 1970 date');
}

const MALFORMED = {
  'null departure timestamp': (o) => { o.d[firstWithKeys(o)][1] = null; return o; },
  'null arrival timestamp': (o) => { o.d[firstWithKeys(o)][2] = null; return o; },
  'string timestamp': (o) => { const x = o.d[firstWithKeys(o)]; x[1] = String(x[1]); return o; },
  'fractional timestamp': (o) => { o.d[firstWithKeys(o)][1] += 0.5; return o; },
  'non-finite timestamp (1e999 → Infinity)': (o) => { const x = o.d[firstWithKeys(o)]; return JSON.stringify(o).replace(`"${x[0]}",${x[1]},`, `"${x[0]}",1e999,`); },
  'unsupported payload version 999': (o) => ({ ...o, v: 999 }),
  'invalid uncertainty flag 2': (o) => { o.d[firstWithKeys(o)][5] = 2; return o; },
  'invalid uncertainty flag true': (o) => { o.d[firstWithKeys(o)][5] = true; return o; },
  'out-of-range dictionary index': (o) => { o.d[firstWithKeys(o)][4][0][2] = [o.k.length]; return o; },
  'negative dictionary index': (o) => { o.d[firstWithKeys(o)][4][0][2] = [-1]; return o; },
  'malformed duty tuple': (o) => { const i = firstWithKeys(o); o.d[i] = o.d[i].slice(0, 5); return o; },
  'encoded month mismatch': (o) => ({ ...o, m: '2023-08' }),
};

for (const [name, fn] of Object.entries(MALFORMED)) {
  test(`payload: ${name} → stale, no counts, actionable hint, rebuilt by crewIndex, no 1970 date`, () => {
    const c = damagedCase((t) => mutatePayload(t, fn));
    const broken = crewQuery(c.t, c.sel);
    expectNo1970(broken);
    assert.equal(gs.fcv2CrewMonthIntegrity_(c.t.store, manifestOf(c.t), DAMAGED, deps), 'corrupt');
    expectRepaired(c);
    expectNo1970(crewQuery(c.t, c.sel));
  });
}

test('payload control: a valid, re-signed payload is accepted unchanged and needs no repair', () => {
  const c = damagedCase((t) => mutatePayload(t, (o) => o));
  const q = crewQuery(c.t, c.sel);
  assert.deepEqual([q.history.state, q.history.indexingSuggested], ['complete', false]);
  assert.deepEqual(q.members.map((m) => [m.match, m.count, m.last && m.last.date]), c.healthy.members.map((m) => [m.match, m.count, m.last && m.last.date]));
  assert.equal(call(c.t.env, { action: 'crewIndex', grant: 'grant-A' }).processed, 0);
});

test('payload: a failed reconstruction of a malformed shard stays stale with no counts and no 1970 date', () => {
  const c = damagedCase((t) => mutatePayload(t, MALFORMED['null departure timestamp']));
  c.t.store.faults.set = (k) => k.startsWith('fcx.s.');
  const r = call(c.t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(r.outcomes.replaceFailed, 1, JSON.stringify(r.outcomes));
  assert.equal(manifestOf(c.t).months[DAMAGED].verifiedAt, c.verifiedBefore, 'verifiedAt not advanced');
  const q = crewQuery(c.t, c.sel);
  assert.equal(q.history.state, 'stale');
  assert.ok(q.members.every((m) => m.count === null));
  expectNo1970(q);
  c.t.store.faults.set = null;
  call(c.t.env, { action: 'crewIndex', grant: 'grant-A' });
  assert.equal(crewQuery(c.t, c.sel).history.state, 'complete');
});

test('payload semantics preserved: strict decoding of every valid synthetic month equals the previous (lenient) decoding', () => {
  const { t } = indexedHistory({ until: '2026-10-31' });
  const core = load(['RosterModelV2.gs', 'CrewCoreV2.gs'], ['fcv2CrewDecodeMonth_']);
  const lenient = (body) => {                                         // the pre-correction decoder, verbatim semantics
    const o = JSON.parse(deps.unpack(body));
    return o.d.map((x) => ({ key: x[0], start: x[1] * 60000, end: x[2] * 60000, lpk: x[3] || null, tied: x[5] === 1,
      sectors: x[4].map((s) => ({ fn: s[0], route: s[1], keys: s[2].map((i) => o.k[i]) })) }));
  };
  const parts = fcxKeys(t).filter((k) => k.startsWith('fcx.s.'));
  assert.ok(parts.length >= 50);
  for (const k of parts) {
    const v = t.store.get(k);
    const body = v.split('|').slice(6).join('|');
    assert.deepEqual(plain(core.fcv2CrewDecodeMonth_(body, deps, v.split('|')[2])), lenient(body), k);
  }
});
