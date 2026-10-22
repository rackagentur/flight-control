// Crew Intelligence Phase 1a: pure core algorithms (backend/apps-script/CrewCoreV2.gs, NOT deployed)
// against fabricated data only. Spec: docs/CREW-INTELLIGENCE.md Revision 4.1, §13 (T2–T4, T7–T9, T12–T17)
// plus parity with the roster's duty grouping and storage measurements on a synthetic history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  SELF, synthId, cryptoDeps, flight, member, owner, crewOf, reader, generateHistory, fakeStore, rng,
} from './fixtures/crew.synthetic.mjs';

const H = 3600000;
const dir = new URL('../backend/apps-script/', import.meta.url);
const plain = (x) => JSON.parse(JSON.stringify(x));

function load(files, names) {
  const sandbox = { console };
  vm.createContext(sandbox);
  const code = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__x = { ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`, sandbox);
  return sandbox.__x;
}

const core = load(['RosterModelV2.gs', 'CrewCoreV2.gs'], [
  'FCV2_CREW_LINK_SPAN_MS_', 'FCV2_CREW_PART_MAX_', 'FCV2_CREW_MANIFEST_MAX_', 'FCV2_CREW_STORE_LIMIT_',
  'FCV2_CREW_MANIFEST_KEY_', 'fcv2CrewGroupDuties_', 'fcv2CrewLinkDuties_', 'fcv2CrewBuildMonth_', 'fcv2CrewSealable_',
  'fcv2CrewSelectedDuty_', 'fcv2CrewCount_', 'fcv2CrewResult_', 'fcv2CrewInitialState_', 'fcv2CrewAuthorized_',
  'fcv2CrewFinalCheck_', 'fcv2CrewEnroll_', 'fcv2CrewBeginRevoke_', 'fcv2CrewSystemRevoke_', 'fcv2CrewPurge_', 'fcv2CrewRevoke_',
  'fcv2CrewEncodeMonth_', 'fcv2CrewDecodeMonth_', 'fcv2CrewParts_', 'fcv2CrewPartKey_', 'fcv2CrewStoreBytes_', 'fcv2CrewPeak_',
  'fcv2CrewManifest_', 'fcv2CrewValidManifest_', 'fcv2CrewYearKey_', 'fcv2CrewCommitMonth_', 'fcv2CrewTouchMonth_', 'fcv2CrewGc_', 'fcv2CrewReadSnapshot_',
]);
const rosterModel = load(['RosterModelV2.gs'], ['fcv2Duties_', 'FCV2_DUTY_GAP_MS_']);

const deps = cryptoDeps();
const NOW = Date.parse('2026-10-22T12:00:00Z');
const ctxAt = (now) => ({ now, selfId: SELF, keyOf: deps.keyOf, deps });
const CODE = 'SYNTHETICENROLLMENTCODE0123456789';

function months(from, to) {
  const out = [];
  for (let m = from; m <= to;) {
    out.push(m);
    const y = +m.slice(0, 4);
    const n = +m.slice(5, 7);
    m = n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, '0')}`;
  }
  return out;
}

/** An enrolled state, an env over a fake store, and helpers to build, commit and query. */
function harness({ now = NOW, initial = {} } = {}) {
  const enrolled = core.fcv2CrewEnroll_(core.fcv2CrewInitialState_(), `${CODE}|${now + 600000}`, { code: CODE, grant: 'grant-1' },
    { now, pid: 'pid-1', newEpoch: 'epoch-1', hash: deps.hash, failures: 0 });
  const h = {
    state: enrolled.state, store: fakeStore(initial), now, removedCache: [],
  };
  h.env = {
    getState: () => h.state, setState: (s) => { h.state = plain(s); }, store: h.store, lock: (fn) => fn(),
    cacheRemove: (keys) => { h.removedCache.push(...keys); }, hash: deps.hash, deps,
    get now() { return h.now; },
  };
  h.manifest = () => { const r = core.fcv2CrewManifest_(h.store, h.state, deps); return r.kind === 'ok' || r.kind === 'absent' ? r.manifest : null; };
  h.commit = (month, flights, hidden = [], at = h.now) => {
    const built = core.fcv2CrewBuildMonth_(month, reader(flights, hidden), ctxAt(at));
    const enc = core.fcv2CrewEncodeMonth_(built, deps);
    const m = h.manifest();
    return plain(core.fcv2CrewCommitMonth_(h.env, { G: h.state.G, epoch: h.state.epoch, mgen: m ? m.mgen : -1 }, month,
      { body: enc.body, digest: enc.digest, verifiedAt: h.now, missing: built.missing, grouping: built.grouping }));
  };
  h.touch = (month) => plain(core.fcv2CrewTouchMonth_(h.env, { G: h.state.G, epoch: h.state.epoch, mgen: h.manifest().mgen }, month, h.now));
  h.query = (monthList, selectedFlight, flights, hidden = [], hook) => {
    const ctx = ctxAt(h.now);
    const selected = plain(core.fcv2CrewSelectedDuty_(selectedFlight.sourceId, selectedFlight.start, reader(flights, hidden), ctx));
    const members = selectedFlight.crew.filter((c) => c.id !== SELF)
      .map((c) => ({ rank: c.rank, family: c.family, given: c.given, key: c.id ? deps.keyOf(c.id) : null, ref: c.id }));
    const snap = core.fcv2CrewReadSnapshot_({ ...h.env, now: h.now, hook }, monthList);
    if (!snap.ok) return { result: plain(core.fcv2CrewResult_({ snapshotOk: false, members, selected, months: [], count: null })), snap: plain(snap), members };
    const duties = Object.values(snap.months).flat();
    const count = core.fcv2CrewCount_(duties, selected.found ? selected : { key: null, start: Infinity }, members.filter((m) => m.key).map((m) => m.key), h.now);
    const result = plain(core.fcv2CrewResult_({ snapshotOk: true, months: monthList.map((m) => snap.status[m]), selected, count, members }));
    return { result, snap: plain(snap), count: plain(count), members, selected };
  };
  return h;
}
const byRef = (q, n) => q.result.members[q.members.findIndex((m) => m.ref === synthId(n))];

// --- Parity with the roster's canonical duty grouping -----------------------------------------------

test('parity: crew duty grouping equals the roster fcv2Duties_ rule (same gap constant, same duties and ids)', () => {
  const r = rng(42);
  const airports = ['FRA', 'PMI', 'LPA', 'HER'];
  const flights = [];
  let t = Date.parse('2025-03-01T05:00:00Z');
  let at = 'FRA';
  for (let i = 0; i < 400; i++) {
    const dest = airports[Math.floor(r() * airports.length)];
    const origin = r() < 0.85 ? at : airports[Math.floor(r() * airports.length)];
    const block = (1 + r() * 4) * H;
    flights.push({ sourceId: `p-${i}`, start: t, end: t + block, origin, destination: dest, flightNumber: 'DE1', crew: null });
    t += block + (r() < 0.6 ? r() * 7 * H : 8 * H + r() * 30 * H);
    at = dest;
  }
  for (const set of [flights, generateHistory({ until: '2023-03-31' })]) {
    const roster = plain(rosterModel.fcv2Duties_(set.map((f) => ({ ...f, flight: { origin: f.origin, destination: f.destination } })), [], [], { hash: deps.hash }));
    const ours = plain(core.fcv2CrewGroupDuties_(set, deps));
    assert.equal(ours.length, roster.length);
    ours.forEach((d, i) => {
      assert.equal(`d_${d.key}`, roster[i].id);
      assert.deepEqual(d.flights.map((f) => `s_${deps.hash(f.sourceId).slice(0, 16)}`), roster[i].sectorIds);
    });
  }
});

// --- T2 / T14: cross-midnight, cross-month, long predecessors, completion, sealing -------------------

test('T2: a duty crossing midnight and the month end belongs to its home month only and is counted once', () => {
  const c = crewOf(11);
  const outLeg = flight('2025-10-31T20:30:00Z', '2025-11-01T01:00:00Z', 'FRA', 'LPA', c);   // 21:30 Berlin, 31 Oct
  const backLeg = flight('2025-11-01T02:00:00Z', '2025-11-01T06:10:00Z', 'LPA', 'FRA', c);
  const later = flight('2025-12-10T06:00:00Z', '2025-12-10T08:30:00Z', 'FRA', 'PMI', crewOf(11));
  const all = [outLeg, backLeg, later];
  const oct = plain(core.fcv2CrewBuildMonth_('2025-10', reader(all), ctxAt(NOW)));
  const nov = plain(core.fcv2CrewBuildMonth_('2025-11', reader(all), ctxAt(NOW)));
  assert.equal(oct.duties.length, 1);
  assert.equal(oct.duties[0].sectors.length, 2);
  assert.equal(nov.duties.length, 0);
  const h = harness();
  ['2025-10', '2025-11', '2025-12'].forEach((m) => assert.equal(h.commit(m, all).outcome, 'committed'));
  const q = h.query(['2025-10', '2025-11', '2025-12'], later, all);
  assert.equal(q.result.state, 'complete');
  assert.deepEqual([byRef(q, 11).match, byRef(q, 11).count, byRef(q, 11).basis], ['recorded', 1, 'recorded-duties']);
  assert.equal(byRef(q, 11).last.route, 'LPA-FRA');
});

test('T2: completion is dutyEnd <= now (never month end); a month is sealed only after its duties complete and on the 8th', () => {
  const c = crewOf(12);
  const all = [flight('2025-10-31T20:30:00Z', '2025-11-01T01:00:00Z', 'FRA', 'LPA', c), flight('2025-11-01T02:00:00Z', '2025-11-01T06:10:00Z', 'LPA', 'FRA', c)];
  const before = plain(core.fcv2CrewBuildMonth_('2025-10', reader(all), ctxAt(Date.parse('2025-11-01T03:00:00Z'))));
  assert.equal(before.duties.length, 0);
  assert.equal(before.openDuties, 1);
  assert.equal(core.fcv2CrewSealable_('2025-10', before, '2025-11-09'), false);
  const after = plain(core.fcv2CrewBuildMonth_('2025-10', reader(all), ctxAt(Date.parse('2025-11-02T00:00:00Z'))));
  assert.equal(after.duties.length, 1);
  assert.equal(core.fcv2CrewSealable_('2025-10', after, '2025-11-07'), false);
  assert.equal(core.fcv2CrewSealable_('2025-10', after, '2025-11-08'), true);
});

test('T2: a chain that keeps touching the window edges is dutyUnbounded, not indexed, and never falls back to days', () => {
  const c = crewOf(13);
  const all = [];
  let t = Date.parse('2025-10-20T00:00:00Z');
  for (let i = 0; i < 150; i++) {                                  // ping-pong every 4 h for 25 days (home month October)
    all.push(flight(new Date(t).toISOString(), new Date(t + 2 * H).toISOString(), i % 2 ? 'PMI' : 'FRA', i % 2 ? 'FRA' : 'PMI', c));
    t += 4 * H;
  }
  const calls = [];
  const built = plain(core.fcv2CrewBuildMonth_('2025-10', reader(all, [], calls), ctxAt(NOW)));
  assert.equal(built.duties.length, 0);
  assert.equal(built.grouping.dutyUnbounded, 1);
  assert.equal(calls.length, 5, 'four forward extensions before giving up');
  assert.equal(core.fcv2CrewSealable_('2025-10', built, '2026-01-01'), false);
  assert.equal(plain(core.fcv2CrewBuildMonth_('2025-11', reader(all), ctxAt(NOW))).duties.length, 0, 'never re-homed to November');
});

test('T14: a long-haul predecessor outside the initial window is found by extension; the duty keeps its home month and identity', () => {
  const c = crewOf(14);
  const center = Date.parse('2025-06-15T12:00:00Z');
  const wStart = center - 36 * H;
  const l0 = flight(new Date(wStart - 10 * H).toISOString(), new Date(wStart - 1 * H).toISOString(), 'PUJ', 'FRA', c);   // ends before the window
  const l1 = flight(new Date(wStart + 2 * H).toISOString(), new Date(wStart + 4 * H).toISOString(), 'FRA', 'PMI', c);    // chains (gap 3 h)
  const sel = plain(core.fcv2CrewSelectedDuty_(l1.sourceId, center, reader([l0, l1]), ctxAt(NOW)));
  assert.equal(sel.unbounded, false);
  assert.equal(sel.key, deps.hash(l0.sourceId).slice(0, 16), 'duty identity comes from the long predecessor');
  // Cross-month: an 11 h long-haul departing 31 Oct (Berlin) chaining into a 1 Nov sector stays an October duty.
  const a = flight('2025-10-31T21:30:00Z', '2025-11-01T08:30:00Z', 'CUN', 'FRA', c);
  const b = flight('2025-11-01T10:00:00Z', '2025-11-01T12:30:00Z', 'FRA', 'PMI', c);
  const oct = plain(core.fcv2CrewBuildMonth_('2025-10', reader([a, b]), ctxAt(NOW)));
  const nov = plain(core.fcv2CrewBuildMonth_('2025-11', reader([a, b]), ctxAt(NOW)));
  assert.equal(oct.duties.length, 1);
  assert.equal(oct.duties[0].sectors.length, 2);
  assert.equal(nov.duties.length, 0);
  const selB = plain(core.fcv2CrewSelectedDuty_(b.sourceId, b.start, reader([a, b]), ctxAt(NOW)));
  assert.equal(selB.key, oct.duties[0].key, 'selected-flight duty equals the indexed duty');
});

// --- T3: historical cutoffs ------------------------------------------------------------------------

test('T3: only completed duties before the selected duty count; same-duty legs and later duties never count', () => {
  const all = [
    flight('2024-01-10T06:00:00Z', '2024-01-10T08:30:00Z', 'FRA', 'PMI', crewOf(21)),
    flight('2024-01-10T09:30:00Z', '2024-01-10T12:00:00Z', 'PMI', 'FRA', crewOf(21)),     // same duty as above
    flight('2024-03-05T06:00:00Z', '2024-03-05T08:30:00Z', 'FRA', 'HER', crewOf(21)),
    flight('2024-05-20T06:00:00Z', '2024-05-20T08:30:00Z', 'FRA', 'LPA', crewOf(21)),     // first leg of the selected duty
    flight('2024-05-20T09:30:00Z', '2024-05-20T13:30:00Z', 'LPA', 'FRA', crewOf(21)),     // selected leg
    flight('2024-06-02T06:00:00Z', '2024-06-02T08:30:00Z', 'FRA', 'RHO', crewOf(21)),     // after the selected duty
    flight('2026-12-01T06:00:00Z', '2026-12-01T08:30:00Z', 'FRA', 'PMI', crewOf(21)),     // future scheduled duty
  ];
  const h = harness();
  const list = months('2024-01', '2026-12');
  list.forEach((m) => h.commit(m, all));
  const q = h.query(list, all[4], all);
  assert.equal(q.result.state, 'complete');
  assert.equal(byRef(q, 21).count, 2, 'Jan and Mar only');
  const built = plain(core.fcv2CrewBuildMonth_('2026-12', reader(all), ctxAt(NOW)));
  assert.equal(built.duties.length, 0, 'future duties are never indexed');
});

// --- T4: missing records ---------------------------------------------------------------------------

test('T4: missing ids, missing crew lists, missing owner lines and parse failures make the result incomplete, with true lower bounds', () => {
  const noId = { rank: 'FA', id: null, family: 'SAMPLEX', given: 'PERSONX' };
  const all = [
    flight('2025-02-01T06:00:00Z', '2025-02-01T08:30:00Z', 'FRA', 'PMI', crewOf(31)),
    flight('2025-02-08T06:00:00Z', '2025-02-08T08:30:00Z', 'FRA', 'PMI', null),                                  // no crew list
    flight('2025-02-15T06:00:00Z', '2025-02-15T08:30:00Z', 'FRA', 'PMI', [member(31)]),                          // owner line missing
    flight('2025-02-22T06:00:00Z', '2025-02-22T08:30:00Z', 'FRA', 'PMI', [owner(), member(31), { parseFailed: true }]),
    flight('2025-04-01T06:00:00Z', '2025-04-01T08:30:00Z', 'FRA', 'LPA', [owner(), member(31), noId]),
  ];
  const h = harness();
  h.commit('2025-02', all);
  const q = h.query(['2025-02', '2025-03', '2025-04'], all[4], all);      // March never indexed → pending
  assert.equal(q.result.state, 'incomplete');
  assert.deepEqual(q.result.reasons, ['missing-records']);
  assert.deepEqual([byRef(q, 31).match, byRef(q, 31).basis, byRef(q, 31).count], ['recorded', 'recorded-duties', 2], 'recorded matches, not a real-world minimum');
  assert.equal('bound' in byRef(q, 31), false);
  const unavailable = q.result.members.find((m) => m.family === 'SAMPLEX');
  assert.deepEqual([unavailable.match, unavailable.count], ['unavailable', null]);
  const m = h.manifest().months['2025-02'].missing;
  assert.deepEqual([m.noCrewList, m.ownerMissing, m.parseFailed], [1, 1, 1]);
});

// --- T15: conservative linking and inflated counts ------------------------------------------------

function linkCase(fragments, hidden = []) {
  const h = harness();
  const selected = flight('2025-09-20T06:00:00Z', '2025-09-20T08:30:00Z', 'FRA', 'PMI', crewOf(41));
  const all = [...fragments, selected];
  h.commit('2025-09', all, hidden);
  return h.query(['2025-09'], selected, all, hidden);
}

test('T15a: a missing middle sector (gap <= 6 h, disconnected): the member is uncertain — no number, never 2 or "at least"', () => {
  const q = linkCase([
    flight('2025-09-02T06:00:00Z', '2025-09-02T08:30:00Z', 'FRA', 'PMI', crewOf(41)),
    flight('2025-09-02T12:00:00Z', '2025-09-02T16:30:00Z', 'LPA', 'FRA', crewOf(41)),
  ]);
  assert.deepEqual(q.result.reasons, ['grouping-uncertain']);
  assert.deepEqual([byRef(q, 41).match, byRef(q, 41).count, byRef(q, 41).recordedMatch], ['uncertain', null, true]);
  assert.deepEqual([q.count.members[deps.keyOf(synthId(41))].raw, q.count.members[deps.keyOf(synthId(41))].groups], [2, 1]);
});

test('T15b: a missing LONG sector (fragments 11 h apart, disconnected) is linked; no number is shown', () => {
  const q = linkCase([
    flight('2025-09-03T06:00:00Z', '2025-09-03T10:30:00Z', 'FRA', 'LPA', crewOf(41)),
    flight('2025-09-03T21:30:00Z', '2025-09-04T06:00:00Z', 'PUJ', 'FRA', crewOf(41)),     // LPA→PUJ (9 h) missing
  ]);
  assert.deepEqual([byRef(q, 41).match, byRef(q, 41).count], ['uncertain', null]);
});

test('T15c: an unrecognised event between connected fragments 11 h apart links them; without it they are two recorded duties', () => {
  const frags = [
    flight('2025-09-04T06:00:00Z', '2025-09-04T08:30:00Z', 'FRA', 'PMI', crewOf(41)),
    flight('2025-09-04T09:30:00Z', '2025-09-04T12:00:00Z', 'PMI', 'FRA', crewOf(41)),
    flight('2025-09-04T23:00:00Z', '2025-09-05T01:30:00Z', 'FRA', 'HER', crewOf(41)),      // 11 h after: beyond a minimum rest
  ];
  const hidden = [{ start: Date.parse('2025-09-04T14:00:00Z'), end: Date.parse('2025-09-04T16:00:00Z') }];
  const linked = linkCase(frags, hidden);
  assert.deepEqual([byRef(linked, 41).match, byRef(linked, 41).count], ['uncertain', null]);
  const separate = linkCase(frags.map((f) => ({ ...f, sourceId: `${f.sourceId}-b` })));
  assert.deepEqual([separate.result.state, byRef(separate, 41).match, byRef(separate, 41).count], ['complete', 'recorded', 2]);
});

test('T15d: uncertainty is transitive (A~B~C is one group)', () => {
  const q = linkCase([
    flight('2025-09-05T06:00:00Z', '2025-09-05T08:00:00Z', 'FRA', 'PMI', crewOf(41)),
    flight('2025-09-05T10:00:00Z', '2025-09-05T12:00:00Z', 'LPA', 'HER', crewOf(41)),
    flight('2025-09-05T14:00:00Z', '2025-09-05T16:00:00Z', 'RHO', 'FRA', crewOf(41)),
  ]);
  const c = q.count.members[deps.keyOf(synthId(41))];
  assert.deepEqual([c.raw, c.groups, c.uncertain, byRef(q, 41).count], [3, 1, true, null]);
});

test('T15e: selecting a LATER fragment never counts the earlier fragment of its own suspect group', () => {
  const h = harness();
  const first = flight('2025-09-06T06:00:00Z', '2025-09-06T08:30:00Z', 'FRA', 'PMI', crewOf(42));
  const later = flight('2025-09-06T12:00:00Z', '2025-09-06T16:30:00Z', 'LPA', 'FRA', crewOf(42));
  h.commit('2025-09', [first, later]);
  const q = h.query(['2025-09'], later, [first, later]);
  assert.equal(byRef(q, 42).count, 0, 'the earlier fragment may be the same duty');
  assert.equal(byRef(q, 42).match, 'none');
  assert.ok(q.result.reasons.includes('grouping-uncertain'));
});

test('T15f: an unbounded selected duty suppresses every count (no safe lower bound)', () => {
  const h = harness();
  const all = [];
  let t = Date.parse('2025-09-10T00:00:00Z');
  for (let i = 0; i < 240; i++) { all.push(flight(new Date(t).toISOString(), new Date(t + 2 * H).toISOString(), i % 2 ? 'PMI' : 'FRA', i % 2 ? 'FRA' : 'PMI', crewOf(43))); t += 4 * H; }
  const q = h.query(['2025-09'], all[120], all);
  assert.equal(q.result.state, 'incomplete');
  assert.deepEqual(q.result.reasons, ['selected-duty-uncertain']);
  assert.ok(q.result.members.every((m) => m.count === null && m.match === 'suppressed'));
});

test('T15g: connected fragments closer than a minimum rest (missing round trip) are uncertain, never two recorded duties', () => {
  const q = linkCase([
    flight('2025-09-07T05:00:00Z', '2025-09-07T07:30:00Z', 'FRA', 'PMI', crewOf(41)),
    flight('2025-09-07T08:30:00Z', '2025-09-07T11:00:00Z', 'PMI', 'FRA', crewOf(41)),
    // missing FRA→HER→FRA (connected, no event); the visible gap is 8 h, less than a minimum rest
    flight('2025-09-07T19:00:00Z', '2025-09-07T21:30:00Z', 'FRA', 'LPA', crewOf(41)),
  ]);
  assert.deepEqual([byRef(q, 41).match, byRef(q, 41).count], ['uncertain', null]);
  assert.notEqual(q.result.state, 'verified');
});

test('T15h (residual A1, documented): a missing round trip with >= 10 h connected gap and no event is not detectable; the count is labelled recorded duties, never real duties', () => {
  const q = linkCase([
    flight('2025-09-08T05:00:00Z', '2025-09-08T07:30:00Z', 'FRA', 'PMI', crewOf(41)),
    flight('2025-09-08T08:30:00Z', '2025-09-08T11:00:00Z', 'PMI', 'FRA', crewOf(41)),
    flight('2025-09-08T21:30:00Z', '2025-09-08T23:30:00Z', 'FRA', 'LPA', crewOf(41)),
  ]);
  const m = byRef(q, 41);
  assert.deepEqual([q.result.state, m.match, m.count, m.basis], ['complete', 'recorded', 2, 'recorded-duties']);
  assert.equal('bound' in m || 'exact' in m, false, 'no exactness or minimum claim');
});

// --- T12: namespace-safe deletion -------------------------------------------------------------------

test('T12: revocation deletes only fcx.* (including orphans) and keeps every unrelated property byte-identical', () => {
  const unrelated = { fcxa: 'keep-1', 'FCX.m': 'keep-2', 'fc.x': 'keep-3', other: 'keep-4', 'fcx': 'keep-5' };
  const h = harness({ initial: unrelated });
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(51))];
  h.commit('2025-01', f);
  h.commit('2025-02', f);
  h.store.map.set('fcx.s.0.oldepoch.2024-12.1.0', 'orphan-from-older-generation');
  const m = JSON.parse(h.store.get('fcx.m'));
  m.cacheKeys = ['fcx.c.1.epoch-1.agg.0', 'fcx.c.1.epoch-1.open.2026-10'];
  h.store.map.set('fcx.m', JSON.stringify(m));
  const order = [];
  h.store.faults.del = (k) => { order.push(k); return false; };
  const out = plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'rev-1', grant: 'grant-1' }));
  assert.equal(out.ok, true);
  assert.equal(order[order.length - 1], 'fcx.m', 'manifest deleted last');
  assert.deepEqual(h.store.keys().filter((k) => k.startsWith('fcx.')), []);
  for (const [k, v] of Object.entries(unrelated)) assert.equal(h.store.get(k), v, k);
  assert.deepEqual(h.removedCache, m.cacheKeys, 'cache keys captured before the manifest was deleted');
  assert.equal(h.state.phase, 'deleted');
});

test('T12: unrelated properties count toward admission; a store filled by other keys leaves a new month uncovered', () => {
  const big = {};
  for (let i = 0; i < 55; i++) big[`other.${i}`] = 'x'.repeat(8900);
  const h = harness({ initial: big });
  const out = h.commit('2025-01', [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(52))]);
  assert.equal(out.outcome, 'uncovered');
  assert.equal(h.manifest().months['2025-01'].status, 'uncovered');
  assert.equal(Object.keys(big).every((k) => h.store.get(k) === big[k]), true);
});

// --- T1 / T13 / T7: generation protocol and races ---------------------------------------------------

const enrollCtx = (now, failures = 0, epoch = 'epoch-x') => ({ now, pid: 'pid-1', newEpoch: epoch, hash: deps.hash, failures });

test('T1: enrollment needs an owner-issued, unexpired, single-use code; 5 failures burn it; retries are idempotent', () => {
  const s0 = core.fcv2CrewInitialState_();
  const prop = `${CODE}|${NOW + 600000}`;
  assert.equal(plain(core.fcv2CrewEnroll_(s0, null, { code: CODE, grant: 'g' }, enrollCtx(NOW))).result.error, 'enroll-closed');
  assert.equal(plain(core.fcv2CrewEnroll_(s0, `${CODE}|${NOW - 1}`, { code: CODE, grant: 'g' }, enrollCtx(NOW))).result.error, 'enroll-closed');
  assert.equal(plain(core.fcv2CrewEnroll_(s0, `${CODE}|${NOW + 16 * 60000}`, { code: CODE, grant: 'g' }, enrollCtx(NOW))).result.error, 'enroll-closed');
  for (let f = 0; f < 5; f++) {
    const r = plain(core.fcv2CrewEnroll_(s0, prop, { code: 'WRONG', grant: 'g' }, enrollCtx(NOW, f)));
    assert.equal(r.burn, f === 4);
  }
  const ok = plain(core.fcv2CrewEnroll_(s0, prop, { code: CODE, grant: 'g1' }, enrollCtx(NOW)));
  assert.deepEqual([ok.result.ok, ok.consume, ok.state.G, ok.state.phase], [true, true, 1, 'active']);
  // The code is consumed (property deleted): a concurrent second enroll with another grant fails; the same retry is idempotent.
  assert.equal(plain(core.fcv2CrewEnroll_(ok.state, null, { code: CODE, grant: 'g2' }, enrollCtx(NOW))).result.error, 'enroll-closed');
  assert.deepEqual(plain(core.fcv2CrewEnroll_(ok.state, null, { code: CODE, grant: 'g1' }, enrollCtx(NOW))).result, { ok: true, enrolled: true, G: 1 });
});

test('T13a/b: enrollment during a revocation needs an owner code and supersedes it under the lock; and a delayed enroll retry after a revoke never restores access', () => {
  const h = harness();
  const begun = plain(core.fcv2CrewBeginRevoke_(h.state, { revokeId: 'r1', grant: 'grant-1' }, { hash: deps.hash, now: NOW }));
  assert.equal(begun.state.phase, 'revoking');
  assert.equal(begun.state.G, h.state.G + 1);
  // Phase 1b correction: a valid owner code supersedes an interrupted revocation (serialized by the lock):
  // new generation, cleanup pending, the revocation recorded, the old grant dead.
  const superseding = plain(core.fcv2CrewEnroll_(begun.state, `NEWCODE0123456789ABCDEFGHIJ|${NOW + 60000}`, { code: 'NEWCODE0123456789ABCDEFGHIJ', grant: 'g9' }, enrollCtx(NOW)));
  assert.deepEqual([superseding.result.ok, superseding.state.G, superseding.state.purge.pending, superseding.state.lastRevoke.outcome], [true, begun.state.G + 1, true, 'superseded']);
  assert.equal(core.fcv2CrewAuthorized_(superseding.state, deps.hash('grant-1'), 'pid-1'), false);
  assert.equal(plain(core.fcv2CrewEnroll_(begun.state, null, { code: 'NO-CODE', grant: 'g9' }, enrollCtx(NOW))).result.error, 'enroll-closed', 'never without an owner code');
  const done = plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  assert.equal(done.state, 'deleted');
  const late = plain(core.fcv2CrewEnroll_(h.state, null, { code: CODE, grant: 'grant-1' }, enrollCtx(NOW)));
  assert.equal(late.result.error, 'enroll-closed');
  assert.equal(late.state, undefined, 'no state change');
  assert.equal(core.fcv2CrewAuthorized_(h.state, deps.hash('grant-1'), 'pid-1'), false);
});

test('T13c / T8: delayed revoke retries return the recorded outcome or stale-request and never touch a newer generation', () => {
  const h = harness();
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' })).state, 'deleted');
  const re = plain(core.fcv2CrewEnroll_(h.state, `CODE2CODE2CODE2CODE2CODE2|${NOW + 60000}`, { code: 'CODE2CODE2CODE2CODE2CODE2', grant: 'grant-2' }, enrollCtx(NOW, 0, 'epoch-2')));
  h.state = re.state;
  const g = h.state.G;
  const lateSame = plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  assert.deepEqual([lateSame.ok, lateSame.recorded], [true, true]);
  assert.equal(h.state.G, g);
  assert.equal(core.fcv2CrewAuthorized_(h.state, deps.hash('grant-2'), 'pid-1'), true, 'new grant still valid');
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r2', grant: 'grant-2' })).state, 'deleted');
  h.state = plain(core.fcv2CrewEnroll_(h.state, `CODE3CODE3CODE3CODE3CODE3|${NOW + 60000}`, { code: 'CODE3CODE3CODE3CODE3CODE3', grant: 'grant-3' }, enrollCtx(NOW, 0, 'epoch-3'))).state;
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' })).error, 'stale-request');
  assert.equal(core.fcv2CrewAuthorized_(h.state, deps.hash('grant-3'), 'pid-1'), true);
});

test('T13d / T7: an indexer that captured G commits nothing after a revoke; its old parts are purged and never read', () => {
  const h = harness();
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(61))];
  const built = core.fcv2CrewBuildMonth_('2025-01', reader(f), ctxAt(NOW));
  const enc = core.fcv2CrewEncodeMonth_(built, deps);
  const captured = { G: h.state.G, epoch: h.state.epoch, mgen: h.manifest().mgen };
  plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  const late = plain(core.fcv2CrewCommitMonth_(h.env, captured, '2025-01', { body: enc.body, digest: enc.digest, verifiedAt: NOW, missing: built.missing, grouping: built.grouping }));
  assert.equal(late.outcome, 'aborted-generation');
  assert.deepEqual(h.store.keys(), []);
  // Re-enroll; leftover parts of an older generation are ignored by readers and removed by GC.
  h.state = plain(core.fcv2CrewEnroll_(h.state, `CODE4CODE4CODE4CODE4CODE4|${NOW + 60000}`, { code: 'CODE4CODE4CODE4CODE4CODE4', grant: 'grant-4' }, enrollCtx(NOW, 0, 'epoch-4'))).state;
  h.store.map.set(core.fcv2CrewPartKey_(captured.G, captured.epoch, '2025-01', 1, 0), 'stale-part');
  h.commit('2025-02', f);
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01', '2025-02']));
  assert.equal(snap.ok, true);
  assert.equal(snap.status['2025-01'].status, 'pending', 'old-generation month is not readable');
  core.fcv2CrewGc_(h.env);
  assert.equal(h.store.keys().some((k) => k.includes(`.${captured.epoch}.`)), false);
});

test('T13e/f: a result computed under G is withheld when a revoke or a pid rotation lands before the final check', () => {
  const h = harness();
  const start = plain(h.state);
  plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  assert.equal(core.fcv2CrewFinalCheck_(start, h.state, deps.hash('grant-1'), 'pid-1'), false);
  const h2 = harness();
  assert.equal(core.fcv2CrewAuthorized_(h2.state, deps.hash('grant-1'), 'pid-2'), false, 'rotated pepper invalidates the grant');
  const rotated = plain(core.fcv2CrewSystemRevoke_(h2.state, { now: NOW, cacheKeys: [] }));
  assert.deepEqual([rotated.G, rotated.phase, rotated.grantHash], [h2.state.G + 1, 'revoking', null]);
});

test('T7: a reader whose query spans a revocation gets no result', () => {
  const h = harness();
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(62))];
  h.commit('2025-01', f);
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW, hook: () => core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }) }, ['2025-01']));
  assert.equal(snap.ok, false);
});

// --- T8: failed deletion and retry -----------------------------------------------------------------

test('T8: a failed deletion stays revoking (access already gone), and a retry with the same revokeId completes it', () => {
  const h = harness({ initial: { unrelated: 'keep' } });
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(71))];
  h.commit('2025-01', f);
  h.commit('2025-02', f);
  let fail = true;
  h.store.faults.del = (k) => k !== 'fcx.m' && fail && ((fail = false), true);
  const first = plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  assert.deepEqual([first.ok, first.error, h.state.phase], [false, 'revoke-incomplete', 'revoking']);
  assert.equal(core.fcv2CrewAuthorized_(h.state, deps.hash('grant-1'), 'pid-1'), false);
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r-other', grant: 'grant-1' })).error, 'busy');
  const retry = plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' }));
  assert.deepEqual([retry.ok, retry.state, h.state.phase], [true, 'deleted', 'deleted']);
  assert.deepEqual(h.store.keys(), ['unrelated']);
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' })).recorded, true, 'lost response retry');
});

// --- T9 / T16: capacity ----------------------------------------------------------------------------

test('T16 / T9: admission uses the peak with old and new parts coexisting; refused replacements are stale, refused new months uncovered', () => {
  const f = generateHistory({ from: '2025-01-01', until: '2025-03-31' });
  const h = harness();
  assert.equal(h.commit('2025-01', f).outcome, 'committed');
  const janBytes = core.fcv2CrewStoreBytes_(h.store);
  // Fill with unrelated keys until the replacement of January no longer fits at peak, although the
  // store after commit + GC (old parts removed) would have fitted.
  const target = core.FCV2_CREW_STORE_LIMIT_ - janBytes - 8000 - 16000 + 2000;
  let i = 0;
  for (let left = target; left > 0; left -= 8950) h.store.map.set(`other.${i++}`, 'y'.repeat(Math.min(8900, Math.max(1, left - 50))));
  const replaced = h.commit('2025-01', f.map((x) => ({ ...x, flightNumber: `${x.flightNumber}X` })));
  assert.equal(replaced.outcome, 'replaceFailed');
  assert.ok(replaced.peak > core.FCV2_CREW_STORE_LIMIT_);
  assert.equal(h.manifest().months['2025-01'].status, 'replaceFailed');
  const fresh = h.commit('2025-02', f);
  assert.equal(fresh.outcome, 'uncovered');
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01', '2025-02']));
  assert.deepEqual([snap.ok, snap.status['2025-01'].status, snap.status['2025-02'].status], [true, 'replaceFailed', 'uncovered']);
  const sel = f.find((x) => x.start > Date.parse('2025-03-10T00:00:00Z'));
  const q = h.query(['2025-01', '2025-02'], sel, f);
  assert.equal(q.result.state, 'stale', 'a failed replacement is stale, never a lower bound');
  assert.ok(q.result.members.every((m) => m.count === null));
  assert.ok(core.fcv2CrewStoreBytes_(h.store) <= core.FCV2_CREW_STORE_LIMIT_);
});

test('T9: a write that throws despite admission leaves no staged parts and the last valid generation intact', () => {
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(81))];
  const h = harness();
  h.commit('2025-01', f);
  const before = new Map(h.store.map);
  h.store.faults.set = (k) => k.startsWith('fcx.s.');
  const out = h.commit('2025-01', [{ ...f[0], flightNumber: 'DE9' }]);
  assert.equal(out.outcome, 'replaceFailed');
  h.store.faults.set = null;
  const parts = h.store.keys().filter((k) => k.startsWith('fcx.s.'));
  assert.deepEqual(parts, [...before.keys()].filter((k) => k.startsWith('fcx.s.')));
});

// --- T17: whole-query snapshot ---------------------------------------------------------------------

function snapshotCase() {
  const h = harness();
  const x1 = flight('2025-10-30T06:00:00Z', '2025-10-30T08:30:00Z', 'FRA', 'PMI', crewOf(91), { id: 'moving-1' });
  const nov = flight('2025-11-12T06:00:00Z', '2025-11-12T08:30:00Z', 'FRA', 'HER', crewOf(92));
  const sel = flight('2025-12-15T06:00:00Z', '2025-12-15T08:30:00Z', 'FRA', 'LPA', crewOf(91, 92));
  const v1 = [x1, nov, sel];
  ['2025-10', '2025-11', '2025-12'].forEach((m) => h.commit(m, v1));
  const moved = { ...x1, start: Date.parse('2025-11-02T06:00:00Z'), end: Date.parse('2025-11-02T08:30:00Z') };   // correction moves the duty
  const v2 = [moved, nov, sel];
  return { h, v1, v2, sel };
}
const MONTHS3 = ['2025-10', '2025-11', '2025-12'];

test('T17a/b/c: commits of adjacent months and a moved duty identity during a query restart it from one manifest; counted exactly once', () => {
  const { h, v2, sel } = snapshotCase();
  let fired = false;
  const hook = (attempt) => {
    if (fired) return;
    fired = true;
    h.commit('2025-11', v2);                  // November now contains the moved duty …
    h.commit('2025-10', v2);                  // … and October no longer does
    h.now += 121000;                          // reader delayed beyond the GC grace
    core.fcv2CrewGc_(h.env);
    MONTHS3.filter((m) => h.manifest().months[m].neighbour).forEach((m) => h.touch(m));   // reconciliation re-verifies flagged neighbours
  };
  const q = h.query(MONTHS3, sel, v2, [], hook);
  assert.equal(q.snap.attempts, 2, 'the whole query restarted');
  assert.equal(q.result.state, 'complete');
  assert.equal(byRef(q, 91).count, 1, 'moved duty counted once');
  assert.equal(byRef(q, 92).count, 1);
});

test('T17b: a snapshot taken between the two commits (duty present in two shards) is stale and suppressed, never double-counted', () => {
  const { h, v2, sel } = snapshotCase();
  h.commit('2025-11', v2);                    // October not yet rebuilt
  const q = h.query(MONTHS3, sel, v2);
  assert.equal(q.result.state, 'stale');
  assert.ok(q.result.members.every((m) => m.count === null));
});

test('T17d/e: corrupted parts or continuous commits exhaust the retries: stale, reason snapshot-unavailable, no counts', () => {
  const { h, v1, sel } = snapshotCase();
  const key = h.store.keys().find((k) => k.includes('.2025-11.'));
  h.store.map.set(key, 'corrupted');
  const q = h.query(MONTHS3, sel, v1);
  assert.deepEqual([q.result.state, q.result.reasons], ['stale', ['snapshot-unavailable']]);
  assert.ok(q.result.members.every((m) => m.count === null));
  const { h: h2, v1: w1, v2: w2, sel: sel2 } = snapshotCase();
  let flip = false;
  const busy = () => { flip = !flip; h2.commit('2025-11', flip ? w2 : w1); h2.now += 121000; core.fcv2CrewGc_(h2.env); };
  const q2 = h2.query(MONTHS3, sel2, w1, [], busy);
  assert.equal(q2.snap.reason, 'snapshot-unavailable');
  assert.ok(q2.result.members.every((m) => m.count === null));
});

test('T17: GC never deletes retired parts younger than 120 s, so a prompt reader of the old manifest stays valid', () => {
  const { h, v1, v2, sel } = snapshotCase();
  const q = h.query(MONTHS3, sel, v1, [], () => { h.commit('2025-12', v2); h.now += 60000; core.fcv2CrewGc_(h.env); });
  assert.equal(q.snap.attempts, 1, 'old generation still complete inside the grace period');
  assert.equal(q.result.state, 'complete');
});

// --- Privacy and storage measurements on a realistic synthetic history -----------------------------

test('privacy + storage: Aug 2022 → Oct 2026 synthetic history fits the limits; shards hold no names or raw ids; counts match brute force', (t) => {
  const flights = generateHistory({ seed: 7, from: '2022-08-01', until: '2026-10-31' });
  const list = months('2022-08', '2026-10');
  const h = harness();
  const sizes = [];
  let distinct = 0;
  for (const m of list) {
    const built = core.fcv2CrewBuildMonth_(m, reader(flights), ctxAt(NOW));
    const enc = core.fcv2CrewEncodeMonth_(built, deps);
    const keys = new Set(built.duties.flatMap((d) => d.sectors.flatMap((s) => s.keys)));
    distinct += keys.size;
    sizes.push({ m, bytes: enc.body.length, duties: built.duties.length, sectors: built.duties.reduce((n, d) => n + d.sectors.length, 0), keys: keys.size });
    const out = h.commit(m, flights);
    assert.equal(out.outcome, 'committed', m);
  }
  h.now += 121000;
  core.fcv2CrewGc_(h.env);                    // retired year documents removed before measuring
  const values = h.store.keys().map((k) => h.store.get(k));
  assert.ok(values.every((v) => v.length <= core.FCV2_CREW_PART_MAX_));
  const manifestBytes = h.store.get('fcx.m').length;
  assert.ok(manifestBytes <= core.FCV2_CREW_MANIFEST_MAX_);
  const total = core.fcv2CrewStoreBytes_(h.store);
  const largest = sizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const peak = core.fcv2CrewPeak_(total, 'fcx.m'.length + manifestBytes, largest.bytes + 200);
  assert.ok(peak <= core.FCV2_CREW_STORE_LIMIT_);
  // Privacy: decoded shards contain neither names nor raw identifiers.
  const ids = new Set(flights.flatMap((f) => f.crew.map((c) => c.id)));
  const snap = core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, list);
  assert.equal(snap.ok, true);
  const decoded = JSON.stringify(snap.months);
  assert.equal(/SAMPLE|PERSON|OWNER/.test(decoded), false);
  for (const id of ids) assert.equal(decoded.includes(id), false);
  // Correctness on realistic data: snapshot counts equal a brute-force count over the generator's flights.
  const sel = flights.filter((f) => f.end < NOW).at(-1);
  const q = h.query(list, sel, flights);
  const selKey = deps.hash(plain(core.fcv2CrewGroupDuties_(flights, deps)).find((d) => d.flights.some((f) => f.sourceId === sel.sourceId)).flights[0].sourceId).slice(0, 16);
  const duties = plain(core.fcv2CrewGroupDuties_(flights, deps)).filter((d) => d.end <= NOW && d.start < q.selected.start && d.key !== selKey);
  for (const m of q.members) {
    const brute = duties.filter((d) => d.flights.some((f) => f.crew.some((c) => c.id === m.ref))).length;
    assert.equal(q.result.members.find((x) => x.family === m.family).count, brute);
  }
  assert.equal(q.result.state, 'complete');
  const b = sizes.map((s) => s.bytes).sort((x, y) => x - y);
  const pct = (p) => b[Math.min(b.length - 1, Math.floor(p * b.length))];
  t.diagnostic(`MEASURED months=${list.length} flights=${flights.length} duties=${sizes.reduce((n, s) => n + s.duties, 0)} sectors/month median=${sizes.map((s) => s.sectors).sort((x, y) => x - y)[25]} distinct-keys/month median=${sizes.map((s) => s.keys).sort((x, y) => x - y)[25]} sum-distinct-per-month=${distinct}`);
  t.diagnostic(`MEASURED encoded month body bytes min=${b[0]} median=${pct(0.5)} p90=${pct(0.9)} max=${b[b.length - 1]} (largest ${largest.m})`);
  t.diagnostic(`MEASURED store total=${total} bytes (keys+values, ${h.store.keys().length} keys) manifest=${manifestBytes} bytes; CALCULATED replacement-admission estimate for the largest month=${peak} bytes (formula §9.4, not an observed peak) limit=${core.FCV2_CREW_STORE_LIMIT_}`);
  t.diagnostic(`MEASURED growth per 12 months ≈ ${Math.round((b.reduce((s, x) => s + x, 0) / list.length) * 12)} bytes of month bodies`);
});

// --- T6 / T10 ---------------------------------------------------------------------------------------

test('T6: a crash after staging (parts written, manifest not) leaves the committed state readable; GC removes the orphans', () => {
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(95))];
  const h = harness();
  h.commit('2025-01', f);
  const orphan = core.fcv2CrewPartKey_(h.state.G, h.state.epoch, '2025-01', 2, 0);
  h.store.map.set(orphan, 'staged-before-crash');
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01']));
  assert.deepEqual([snap.ok, snap.status['2025-01'].status], [true, 'fresh']);
  core.fcv2CrewGc_(h.env);
  assert.equal(h.store.get(orphan), null);
  assert.equal(plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01'])).ok, true);
});

test('T10: a month verified more than 14 days ago is stale; its count is never presented as a bound', () => {
  const f = [
    flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(96)),
    flight('2025-02-05T06:00:00Z', '2025-02-05T08:30:00Z', 'FRA', 'LPA', crewOf(96)),
  ];
  const h = harness();
  h.commit('2025-01', f);
  h.commit('2025-02', f);
  h.now = NOW + 15 * 86400000;
  const q = h.query(['2025-01', '2025-02'], f[1], f);
  assert.equal(q.result.state, 'stale');
  assert.deepEqual([byRef(q, 96).match, byRef(q, 96).count, byRef(q, 96).asOfRecorded], ['stale', null, 1]);
});

// --- Correction pass: canonical parity with tied departures ------------------------------------------

const rosterDuties = (set) => plain(rosterModel.fcv2Duties_(set.map((f) => ({ ...f, flight: { origin: f.origin, destination: f.destination } })), [], [], { hash: deps.hash }));
// fcv2BuildRoster_ hands fcv2Duties_ its events sorted by start, then end (stable).
const rosterOrder = (set) => set.slice().sort((a, b) => a.start - b.start || a.end - b.end);
const sameDuties = (set) => {
  const roster = rosterDuties(rosterOrder(set));
  const ours = plain(core.fcv2CrewGroupDuties_(set, deps));
  assert.deepEqual(ours.map((d) => `d_${d.key}`), roster.map((d) => d.id));
  assert.deepEqual(ours.map((d) => d.flights.map((f) => `s_${deps.hash(f.sourceId).slice(0, 16)}`)), roster.map((d) => d.sectorIds));
  return ours;
};

test('parity (tied departures): the 3-versus-2 counterexample groups exactly like the roster', () => {
  const t = (s) => Date.parse(`2025-05-01T${s}:00Z`);
  const a = { sourceId: 'a', start: t('06:00'), end: t('09:00'), origin: 'FRA', destination: 'PMI', flightNumber: 'DE1', crew: null };
  const b = { sourceId: 'b', start: t('06:00'), end: t('07:00'), origin: 'LPA', destination: 'FRA', flightNumber: 'DE2', crew: null };
  const c = { sourceId: 'c', start: t('09:30'), end: t('12:00'), origin: 'PMI', destination: 'FRA', flightNumber: 'DE3', crew: null };
  for (const input of [[a, b, c], [c, b, a], [b, c, a]]) {
    const ours = sameDuties(input);
    assert.deepEqual(ours.map((d) => d.flights.map((f) => f.sourceId)), [['b'], ['a', 'c']], 'two duties, B alone and A+C');
  }
});

test('parity (full ties): identical start and end keep input order like the roster, and the duty is flagged tied', () => {
  const t = (s) => Date.parse(`2025-05-02T${s}:00Z`);
  const x = { sourceId: 'x', start: t('06:00'), end: t('08:00'), origin: 'FRA', destination: 'PMI', flightNumber: 'DE1', crew: null };
  const y = { sourceId: 'y', start: t('06:00'), end: t('08:00'), origin: 'FRA', destination: 'LPA', flightNumber: 'DE2', crew: null };
  const z = { sourceId: 'z', start: t('09:00'), end: t('11:00'), origin: 'PMI', destination: 'FRA', flightNumber: 'DE3', crew: null };
  for (const input of [[x, y, z], [y, x, z]]) {
    const ours = sameDuties(input);
    assert.ok(ours.some((d) => d.tied), 'order-dependent grouping is flagged as grouping uncertainty');
  }
});

test('parity (randomised ties): coarse departure grid with many ties, shuffled inputs', () => {
  const r = rng(99);
  const airports = ['FRA', 'PMI', 'LPA'];
  const set = [];
  for (let i = 0; i < 300; i++) {
    const start = Date.parse('2025-06-01T00:00:00Z') + Math.floor(r() * 200) * H;   // hourly grid → frequent ties
    set.push({ sourceId: `r-${i}`, start, end: start + (1 + Math.floor(r() * 3)) * H, origin: airports[Math.floor(r() * 3)], destination: airports[Math.floor(r() * 3)], flightNumber: 'DE1', crew: null });
  }
  for (let k = 0; k < 5; k++) {
    const shuffled = set.slice().sort(() => r() - 0.5);
    sameDuties(shuffled);
  }
});

// --- Correction pass: manifest schema validation ---------------------------------------------------

/** Applies `mutate(root, yearDoc)` to the stored root and the 2025 year document (re-signing the year digest,
 * so the failure under test is validation, not a torn read), then checks reads, commits and GC refuse it. */
function invalidManifestCase(mutate) {
  const h = harness();
  const f = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(97))];
  h.commit('2025-01', f);
  h.store.map.set('fcx.s.1.epoch-1.2024-12.1.0', 'orphan');
  if (typeof mutate === 'string') h.store.map.set('fcx.m', mutate);
  else {
    const root = JSON.parse(h.store.get('fcx.m'));
    const ykey = core.fcv2CrewYearKey_(root.G, root.epoch, '2025', root.years['2025'][0]);
    const value = h.store.get(ykey);
    const header = value.slice(0, value.indexOf('{'));
    const doc = JSON.parse(value.slice(header.length));
    const out = mutate(root, doc);
    const body = JSON.stringify(doc);
    h.store.map.set(ykey, header + body);
    if (out.years && out.years['2025'] && Array.isArray(out.years['2025'])) out.years['2025'][1] = deps.hash(body).slice(0, 32);
    h.store.map.set('fcx.m', JSON.stringify(out));
  }
  const before = new Map(h.store.map);
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01']));
  const built = core.fcv2CrewBuildMonth_('2025-02', reader(f), ctxAt(NOW));
  const enc = core.fcv2CrewEncodeMonth_(built, deps);
  const commit = plain(core.fcv2CrewCommitMonth_(h.env, { G: h.state.G, epoch: h.state.epoch, mgen: 0 }, '2025-02', { body: enc.body, digest: enc.digest, verifiedAt: NOW, missing: built.missing, grouping: built.grouping }));
  const gc = plain(core.fcv2CrewGc_(h.env));
  assert.equal(snap.ok, false);
  assert.equal(snap.reason, 'index-incompatible');
  assert.equal(commit.outcome, 'index-incompatible');
  assert.deepEqual([gc.deleted, gc.skipped], [0, 'invalid']);
  assert.deepEqual([...h.store.map], [...before], 'unknown or invalid data is never modified');
}

test('schema: an unsupported version (schema 99) is never read, committed over or garbage-collected', () => {
  invalidManifestCase((m) => ({ ...m, schema: 99 }));
  invalidManifestCase((m) => ({ ...m, schema: 1 }));               // the Phase 1a single-manifest format is not read either
});

test('schema: missing required fields are rejected', () => {
  invalidManifestCase((m) => { const { mgen, ...rest } = m; return rest; });
  invalidManifestCase((m) => { const { retired, ...rest } = m; return rest; });
  invalidManifestCase((m) => { const { years, ...rest } = m; return rest; });
});

test('schema: valid JSON with an invalid structure is rejected', () => {
  invalidManifestCase((m) => ({ ...m, years: [] }));
  invalidManifestCase((m, doc) => { doc.m['01'] = [1, 1, 'nothex', 0, 'o', 0, 0, '', 0]; return m; });
  invalidManifestCase((m, doc) => { doc.m['13'] = doc.m['01']; return m; });
  invalidManifestCase((m, doc) => { doc.m['01'] = doc.m['01'].slice(0, 7); return m; });
  invalidManifestCase((m) => ({ ...m, retired: [['other.key', 1]] }));
  invalidManifestCase((m) => ({ ...m, G: '1' }));
  invalidManifestCase('[]');
  invalidManifestCase('{not json');
});

test('schema: a revocation still deletes an unsupported index (explicit deletion always works) and nothing else', () => {
  const h = harness({ initial: { keep: 'me' } });
  h.commit('2025-01', [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(98))]);
  h.store.map.set('fcx.m', JSON.stringify({ schema: 99 }));
  assert.equal(plain(core.fcv2CrewRevoke_(h.env, { revokeId: 'r1', grant: 'grant-1' })).state, 'deleted');
  assert.deepEqual(h.store.keys(), ['keep']);
});

// --- Correction pass: fail closed on replacement failure --------------------------------------------

function replacementCase() {
  const f1 = [flight('2025-01-05T06:00:00Z', '2025-01-05T08:30:00Z', 'FRA', 'PMI', crewOf(99))];
  const f2 = [{ ...f1[0], crew: crewOf(99, 100) }];
  const sel = flight('2025-03-01T06:00:00Z', '2025-03-01T08:30:00Z', 'FRA', 'LPA', crewOf(99));
  const h = harness();
  h.commit('2025-01', f1);
  return { h, f2, sel };
}

test('replacement failure: both the replacement-manifest write and the failure-marker write fail → old parts deleted, readers stale with no counts', () => {
  const { h, f2, sel } = replacementCase();
  h.store.faults.set = (k) => k === 'fcx.m';                     // every manifest write fails
  const out = h.commit('2025-01', f2);
  assert.deepEqual([out.outcome, out.closedBy], ['replaceFailed', 'parts-deleted']);
  h.store.faults.set = null;
  const q = h.query(['2025-01'], sel, [...f2, sel]);
  assert.deepEqual([q.result.state, q.result.reasons], ['stale', ['snapshot-unavailable']]);
  assert.ok(q.result.members.every((m) => m.count === null), 'the old shard is never reported fresh');
});

test('replacement failure: after the durable "replacing" marker, a failed replacement and a failed replaceFailed write still read as stale', () => {
  const { h, f2, sel } = replacementCase();
  let manifestWrites = 0;
  h.store.faults.set = (k) => k.startsWith('fcx.s.') || (k === 'fcx.m' && ++manifestWrites > 1);   // marker ok, everything after fails
  const out = h.commit('2025-01', f2);
  assert.equal(out.outcome, 'replaceFailed');
  h.store.faults.set = null;
  assert.equal(h.manifest().months['2025-01'].status, 'replacing');
  const q = h.query(['2025-01'], sel, [...f2, sel]);
  assert.equal(q.result.state, 'stale');
  assert.ok(q.result.members.every((m) => m.count === null));
});

test('replacement failure (documented limitation): when the store accepts neither writes nor deletes, the outcome says unpersisted', () => {
  const { h, f2 } = replacementCase();
  h.store.faults.set = () => true;
  h.store.faults.del = () => true;
  const out = h.commit('2025-01', f2);
  assert.equal(out.outcome, 'replaceFailed-unpersisted', 'the caller must treat the month as stale for this request');
  h.store.faults.set = null;
  h.store.faults.del = null;
  // Across requests nothing durable records the failure: the old generation still reads as fresh until re-verified.
  const snap = plain(core.fcv2CrewReadSnapshot_({ ...h.env, now: NOW }, ['2025-01']));
  assert.equal(snap.status['2025-01'].status, 'fresh');
});
