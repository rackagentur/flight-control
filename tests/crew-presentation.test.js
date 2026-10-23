// Crew Intelligence Phase 1c Stage A: Condor crew presentation adapter (pure). Grouping uses owner-verified
// rank mappings only (the real table is empty: decision D7 pending), unknown codes fall back to a neutral
// group with the raw code, names keep their spelling. Synthetic names and NEUTRAL synthetic rank codes only
// (XA..XF): no real airline code or meaning appears in this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDOR_CREW_RANK_CODES, CONDOR_CREW_RANKS, presentCrew, formatCrewName, crewInitials, formatCrewRoute,
} from '../src/airlines/condor/crew.js';
import { validateCrew } from '../src/sources/crew-v2.js';
import { loadGs } from './gs-harness.js';
import { crewAnswer, sampleMembers as wireMembers, SECTOR } from './fixtures/crew-frontend.synthetic.mjs';

// The fixture's members with their rank codes replaced by neutral synthetic codes, in backend order.
const NEUTRAL = ['XA', 'XB', 'XC', 'XD', 'XE', 'XF'];
const sampleMembers = () => wireMembers().map((m, i) => (m.rank === null ? m : { ...m, rank: NEUTRAL[i] }));
const validated = () => {
  const check = validateCrew(crewAnswer({ members: sampleMembers() }), { sectorId: SECTOR });
  assert.equal(check.ok, true, check.reason);
  return check.value.members;
};
// A test-only table: these "meanings" are invented for the test and say nothing about real rank codes.
const TEST_RANKS = Object.freeze({ XA: { group: 'cockpit', label: 'Test cockpit rank' }, XC: { group: 'cabin', label: 'Test cabin rank' } });

test('rank codes are exactly the backend parser list; the verified table is empty until the owner confirms meanings', () => {
  assert.deepEqual([...CONDOR_CREW_RANK_CODES], [...loadGs().FCV2_CONDOR_CONFIG_.crewRanks]);
  assert.ok(Object.isFrozen(CONDOR_CREW_RANK_CODES));
  assert.deepEqual(Object.keys(CONDOR_CREW_RANKS), []);
  assert.ok(Object.isFrozen(CONDOR_CREW_RANKS));
});

test('neutral fallback with the real (empty) table: one `crew` group, raw codes, nothing verified', () => {
  const out = presentCrew(validated());
  assert.deepEqual(out.groups.map((g) => g.id), ['crew']);
  assert.equal(out.unreadable, 1);
  const members = out.groups[0].members;
  assert.deepEqual(members.map((m) => m.rank), [
    { code: 'XA', label: 'XA', verified: false }, { code: 'XB', label: 'XB', verified: false },
    { code: 'XC', label: 'XC', verified: false }, { code: 'XD', label: 'XD', verified: false },
    { code: 'XE', label: 'XE', verified: false }, { code: 'XF', label: 'XF', verified: false },
  ]);
  // Backend order is kept.
  assert.deepEqual(members.map((m) => m.name), ['ALEX SAMPLE', 'Jordan Example', "ANA-LENA O'BRIEN", 'JÖRG D’ARCY', 'SAM PLACEHOLDER', 'ROBIN TESTPERSON'], 'spelling kept exactly');
});

test('grouping with an injected verified table: cockpit, cabin, then the neutral group; empty groups omitted', () => {
  const out = presentCrew(validated(), { ranks: TEST_RANKS });
  assert.deepEqual(out.groups.map((g) => [g.id, g.members.map((m) => m.rank.code)]), [
    ['cockpit', ['XA']], ['cabin', ['XC']], ['crew', ['XB', 'XD', 'XE', 'XF']],
  ]);
  assert.deepEqual(out.groups[0].members[0].rank, { code: 'XA', label: 'Test cockpit rank', verified: true });
  const onlyCabin = presentCrew([sampleMembers()[2]], { ranks: TEST_RANKS });
  assert.deepEqual(onlyCabin.groups.map((g) => g.id), ['cabin']);
  // A malformed table entry is not treated as verified.
  const bad = presentCrew([sampleMembers()[0]], { ranks: { XA: { group: 'flight-deck', label: 'X' } } });
  assert.deepEqual(bad.groups[0].members[0].rank, { code: 'XA', label: 'XA', verified: false });
  // Prototype keys are never mappings.
  const proto = presentCrew([{ ...sampleMembers()[0], rank: 'XZ' }], { ranks: Object.create({ XZ: { group: 'cabin', label: 'inherited' } }) });
  assert.equal(proto.groups[0].id, 'crew');
});

test('null rank with names: neutral group, label null; match data passed through unchanged', () => {
  const out = presentCrew([{ rank: null, family: 'SAMPLE', given: 'ALEX', match: 'unavailable', count: null }]);
  assert.deepEqual(out.groups[0].members[0], {
    name: 'ALEX SAMPLE', initials: 'AS', rank: { code: null, label: null, verified: false },
    match: 'unavailable', count: null, last: null, recordedMatch: null, asOfRecorded: null,
  });
  const [recorded, none, uncertain, stale] = presentCrew(validated()).groups[0].members;
  assert.deepEqual([recorded.match, recorded.count, recorded.last], ['recorded', 3, { date: '2026-09-14', flightNumber: 'DE1234', route: 'FRA-PMI' }]);
  assert.deepEqual([none.match, none.count, none.last], ['none', 0, null]);
  assert.deepEqual([uncertain.match, uncertain.count, uncertain.recordedMatch], ['uncertain', null, true]);
  assert.deepEqual([stale.match, stale.count, stale.asOfRecorded], ['stale', null, 2]);
});

test('unreadable entries are counted, not presented', () => {
  const out = presentCrew([{ rank: null, family: null, given: null, match: 'unavailable', count: null }, null]);
  assert.deepEqual(out, { groups: [], unreadable: 2 });
  assert.deepEqual(presentCrew([]), { groups: [], unreadable: 0 });
});

test('item 7: names are shown exactly as received (no re-casing); parts trimmed, one space, missing part omitted', () => {
  assert.equal(formatCrewName('ALEX', 'SAMPLE'), 'ALEX SAMPLE');
  assert.equal(formatCrewName('ANA-LENA', "O'BRIEN"), "ANA-LENA O'BRIEN");
  assert.equal(formatCrewName('Ana-Lena', "O'Brien"), "Ana-Lena O'Brien");
  assert.equal(formatCrewName('Jörg', 'D’Arcy'), 'Jörg D’Arcy');
  assert.equal(formatCrewName('JÖRG', 'D’ARCY'), 'JÖRG D’ARCY');
  assert.equal(formatCrewName('HANS', 'VAN DER BERG'), 'HANS VAN DER BERG');
  assert.equal(formatCrewName('Anne', 'McDonald'), 'Anne McDonald');
  assert.equal(formatCrewName('STRASSE', 'GROß'), 'STRASSE GROß');
  assert.equal(formatCrewName('  SAM J. ', ' PLACEHOLDER '), 'SAM J. PLACEHOLDER');
  assert.equal(formatCrewName('ALEX', null), 'ALEX');
  assert.equal(formatCrewName('', 'SAMPLE'), 'SAMPLE');
  assert.equal(formatCrewName(null, null), null);
});

test('initials: first letter of given and family, upper case, Unicode; missing parts omitted', () => {
  assert.equal(crewInitials('ALEX', 'SAMPLE'), 'AS');
  assert.equal(crewInitials('jörg', 'd’arcy'), 'JD');
  assert.equal(crewInitials('änne', 'übel'), 'ÄÜ');
  assert.equal(crewInitials(null, 'SAMPLE'), 'S');
  assert.equal(crewInitials('ALEX', null), 'A');
  assert.equal(crewInitials(null, null), '');
  assert.equal(crewInitials('ßigrid', 'éclair'), 'ßÉ', 'ß would become two letters: kept');
  assert.equal(crewInitials("'Arcy", '-x'), 'AX', 'first LETTER of each part');
});

test('route: two IATA codes joined by an en dash; anything else null', () => {
  assert.equal(formatCrewRoute('FRA-PMI'), 'FRA–PMI');
  assert.equal(formatCrewRoute('fra-pmi'), null);
  assert.equal(formatCrewRoute('FRA-PMIX'), null);
  assert.equal(formatCrewRoute(null), null);
});
