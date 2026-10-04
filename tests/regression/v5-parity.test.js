// v5 parity: every v5 `upcoming[]` field is classified.
//   same          V2 must reproduce the v5 value exactly → any difference is a REGRESSION.
//   intended-fix  V2 deliberately differs (known v5 defect, IANA-correct display) → reported
//                 as a diagnostic, never silently accepted as "same".
// An unclassified field fails: new contract fields must be classified explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, dayShift, calendarDaysUntil, offsetMinutes } from '../../src/lib/time.js';
import { airport } from '../../src/data/airports.js';
import { PROFILE, at, loadFixture, fixtureSnapshot } from '../helpers.js';
import { adaptV5 } from '../../src/sources/fc-appscript-v5.js';

const BERLIN = 'Europe/Berlin';

/** How V2 presents each v5 field, from the normalized sector. */
const CLASSIFICATION = {
  flightNumber: { kind: 'same', v2: (s) => s.flightNumber },
  origin: { kind: 'same', v2: (s) => s.origin },
  destination: { kind: 'same', v2: (s) => s.destination },
  depTimestamp: { kind: 'same', v2: (s) => s.dep },
  endTimestamp: { kind: 'same', v2: (s) => s.arr },
  duration: { kind: 'same', v2: (s) => Math.round((s.blockMin / 60) * 10) / 10 },
  // Pickups: same instant as v5, except V2 keeps a shared pickup on the first flight only
  // (v5 UI showed it once per day too). Displayed in the origin zone (B5) when that differs.
  pickupTimestamp: { kind: 'same-pickup', v2: (s) => s.pickup },
  pickup: { kind: 'intended-fix', defect: 'B5/dedupe', why: 'origin-zone display; first flight of a duty only', v2: (s) => (s.pickup === null ? null : formatTime(s.pickup, s.originTz)) },
  wakeup: { kind: 'intended-fix', defect: 'B5/dedupe', why: 'origin-zone display; first flight of a duty only', v2: (s) => (s.pickup === null ? null : formatTime(s.pickup - PROFILE.wakeupOffsetMin * 60000, s.originTz)) },
  isFraFlight: { kind: 'same', v2: (s) => s.origin === 'FRA' || s.destination === 'FRA' },
  destCountry: { kind: 'same', v2: (s) => airport(s.destination)?.cc ?? null },
  date: { kind: 'intended-fix', defect: 'B5', why: 'v5 formats the departure date in the script zone; V2 uses the origin zone', v2: (s) => s.dep },
  time: { kind: 'intended-fix', defect: 'B5', why: 'outstation departures were shown in Berlin time labelled local', v2: (s) => formatTime(s.dep, s.originTz) },
  arrivalLocal: { kind: 'intended-fix', defect: 'B1/B6', why: 'fixed-offset arithmetic formatted as UTC; V2 uses the IANA zone', v2: (s) => formatTime(s.arr, s.destTz) },
  arrivalNextDay: { kind: 'intended-fix', defect: 'B1', why: '+1 compared UTC dates; V2 compares local dates', v2: (s) => dayShift(s.dep, s.originTz, s.arr, s.destTz) > 0 },
  fraDep: { kind: 'intended-fix', defect: 'B1', why: 'base-reference time off by the origin offset', v2: (s) => formatTime(s.dep, BERLIN) },
  fraArr: { kind: 'intended-fix', defect: 'B1', why: 'base-reference time off by the origin offset', v2: (s) => formatTime(s.arr, BERLIN) },
  daysUntil: { kind: 'intended-fix', defect: 'B4', why: 'ceil(ms/day) turned later-today into tomorrow; V2 counts calendar days', v2: (s, now) => calendarDaysUntil(now, s.dep, PROFILE.homeTz) },
  originTz: { kind: 'intended-fix', defect: 'B6', why: 'fixed summer offsets; V2 uses DST-aware IANA zones', v2: (s) => offsetMinutes(s.dep, s.originTz) / 60 },
  destTz: { kind: 'intended-fix', defect: 'B6', why: 'fixed summer offsets; V2 uses DST-aware IANA zones', v2: (s) => offsetMinutes(s.arr, s.destTz) / 60 },
};

const payload = loadFixture();
const now = at(payload._now);
const snap = fixtureSnapshot();
const byId = new Map(snap.sectors.map((s) => [`${s.flightNumber}-${s.dep}`, s]));

test('every v5 upcoming field is classified', () => {
  const fields = new Set(payload.upcoming.flatMap((f) => Object.keys(f)));
  const unclassified = [...fields].filter((f) => !(f in CLASSIFICATION));
  assert.deepEqual(unclassified, [], `classify these v5 fields: ${unclassified.join(', ')}`);
});

test('"same" fields: V2 reproduces v5 exactly (differences are regressions)', () => {
  const regressions = [];
  for (const v5 of payload.upcoming) {
    const s = byId.get(`${v5.flightNumber}-${v5.depTimestamp}`);
    assert.ok(s, `${v5.flightNumber} missing from V2`);
    for (const [field, rule] of Object.entries(CLASSIFICATION)) {
      if (rule.kind === 'same-pickup') {
        const actual = rule.v2(s, now);
        const v5Value = v5[field] ?? null;
        // Allowed difference: V2 null because an earlier flight already carries this pickup.
        const deduped = actual === null && v5Value !== null && payload.upcoming.some((o) => o.depTimestamp < v5.depTimestamp && o.pickupTimestamp === v5Value);
        if (actual !== v5Value && !deduped) regressions.push(`${v5.flightNumber}.${field}: v5=${JSON.stringify(v5Value)} V2=${JSON.stringify(actual)}`);
        continue;
      }
      if (rule.kind !== 'same') continue;
      const actual = rule.v2(s, now);
      if (actual !== v5[field]) regressions.push(`${v5.flightNumber}.${field}: v5=${JSON.stringify(v5[field])} V2=${JSON.stringify(actual)}`);
    }
  }
  assert.deepEqual(regressions, [], `UNINTENDED REGRESSIONS:\n${regressions.join('\n')}`);
});

test('"intended-fix" fields: differences are reported with their defect, and V2 values are correct', (t) => {
  const report = [];
  for (const v5 of payload.upcoming) {
    const s = byId.get(`${v5.flightNumber}-${v5.depTimestamp}`);
    for (const [field, rule] of Object.entries(CLASSIFICATION)) {
      if (rule.kind !== 'intended-fix' || field === 'date') continue;
      const v2 = rule.v2(s, now);
      if (v2 !== v5[field]) report.push(`[${rule.defect}] ${v5.flightNumber}.${field}: v5=${JSON.stringify(v5[field])} → V2=${JSON.stringify(v2)}`);
    }
  }
  for (const line of report) t.diagnostic(line);
  // Spot-check the corrected values themselves (ground truth from the synthetic instants).
  const out = byId.get(`DE2074-${at('2026-10-10T07:40:00Z')}`);
  assert.equal(CLASSIFICATION.arrivalLocal.v2(out), '12:20');                 // v5: 10:20
  const ret = byId.get(`DE2075-${at('2026-10-12T22:30:00Z')}`);
  assert.equal(CLASSIFICATION.time.v2(ret), '18:30');                         // v5: 00:30 (Berlin, labelled local)
  assert.equal(CLASSIFICATION.arrivalNextDay.v2(ret), true);
  const dxb = byId.get(`DE2324-${at('2026-10-26T09:00:00Z')}`);
  assert.equal(CLASSIFICATION.arrivalLocal.v2(dxb), '19:00');                 // after EU DST end; v5: 17:00
  assert.equal(CLASSIFICATION.originTz.v2(dxb), 1);                           // FRA is UTC+1 after 25 Oct; v5: 2
  assert.ok(report.length >= 8, 'the fixture exercises the known v5 defects');
});

test('a pickup shared by two same-day flights is a documented dedupe, not a regression', () => {
  const shared = loadFixture();
  const first = shared.upcoming[0];
  shared.upcoming.splice(1, 0, { ...first, flightNumber: 'DE2099', origin: 'YYZ', destination: 'YUL',
    depTimestamp: first.endTimestamp + 3600000, endTimestamp: first.endTimestamp + 3 * 3600000 });
  const s = adaptV5(shared, { profile: PROFILE, fetchedAt: at(shared._now) });
  const second = s.sectors.find((x) => x.flightNumber === 'DE2099');
  assert.equal(second.pickup, null);
  assert.ok(shared.upcoming.some((o) => o.depTimestamp < second.dep && o.pickupTimestamp === first.pickupTimestamp));
});
