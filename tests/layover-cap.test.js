// Approved classifier rule: an inferred layover needs the departure within 6 calendar days of
// the arrival, counted in the outstation's local dates. Explicit roster layovers are not capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INFERRED_LAYOVER_DAYS, layoverCalendarDays, buildDays } from '../src/model/roster.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

/** FRA→YYZ arriving `arrIso`, YYZ→FRA departing `depIso` (all synthetic). */
function trip(arrIso, depIso, { explicitOff = false } = {}) {
  const snap = fixtureSnapshot((p) => {
    const arr = at(arrIso);
    const dep = at(depIso);
    p.upcoming = [
      { ...p.upcoming[0], flightNumber: 'DE9301', origin: 'FRA', destination: 'YYZ', depTimestamp: arr - 8 * 3600000, endTimestamp: arr, pickupTimestamp: null },
      { ...p.upcoming[1], flightNumber: 'DE9302', origin: 'YYZ', destination: 'FRA', depTimestamp: dep, endTimestamp: dep + 7.5 * 3600000, pickupTimestamp: null },
    ];
    p.daysOff = [];
  });
  return explicitOff ? { ...snap, capabilities: { ...snap.capabilities, explicitOff: true } } : snap;
}

const layoverDays = (snap, fromKey, count) => {
  const { roster, now } = pipeline(snap, '2026-10-04T08:00:00Z');
  return buildDays(snap, roster, PROFILE, now, { from: fromKey, count });
};

test('the cap is 6 calendar days', () => {
  assert.equal(MAX_INFERRED_LAYOVER_DAYS, 6);
});

test('boundary: 5 and 6 calendar days → LAYOVER · inferred; 7 → no layover, UNKNOWN (not OFF)', () => {
  // Arrive YYZ Sat 10 Oct 12:20 EDT; depart 18:30 EDT on +5 / +6 / +7 days (Toronto dates).
  const arr = '2026-10-10T16:20:00Z';
  const cases = [['2026-10-15T22:30:00Z', 5, true], ['2026-10-16T22:30:00Z', 6, true], ['2026-10-17T22:30:00Z', 7, false]];
  for (const [dep, days, inferred] of cases) {
    const snap = trip(arr, dep);
    assert.equal(layoverCalendarDays(at(arr), at(dep), 'America/Toronto'), days);
    const { roster, state } = pipeline(snap, '2026-10-13T15:00:00Z');
    assert.equal(roster.rotations.length, inferred ? 1 : 2, `${days} days`);
    assert.equal(state.status, inferred ? 'layover' : 'unknown', `${days} days`);
    if (inferred) assert.equal(state.confidence, 'inferred');
    else {
      assert.ok(roster.warnings.some((w) => w.code === 'layover-too-long'));
      assert.match(state.reasons.join(' '), /More than 6 days/);
    }
    const middle = layoverDays(snap, '2026-10-12', 3);
    for (const day of middle) {
      if (inferred) assert.deepEqual([day.status, day.confidence, day.provenance], ['layover', 'inferred', 'derived']);
      else {
        assert.equal(day.status, 'unknown', `${days} days: ${day.date}`);
        assert.notEqual(day.status, 'off');
        assert.equal(day.rotationId, null, 'not connected across the gap');
      }
    }
  }
});

test('excess days are never reinterpreted as OFF, even for a source that can state OFF', () => {
  const snap = trip('2026-10-10T16:20:00Z', '2026-10-17T22:30:00Z', { explicitOff: true });
  for (const day of layoverDays(snap, '2026-10-11', 6)) assert.notEqual(day.status, 'off');
});

test('DST boundary: Toronto changes clocks on 1 Nov inside the gap; days are calendar days, not 24 h blocks', () => {
  // Arrive Wed 28 Oct 12:20 EDT. Depart Tue 3 Nov 18:30 EST = 6 days (≈ 150 h) → inferred.
  const six = trip('2026-10-28T16:20:00Z', '2026-11-03T23:30:00Z');
  assert.equal(layoverCalendarDays(at('2026-10-28T16:20:00Z'), at('2026-11-03T23:30:00Z'), 'America/Toronto'), 6);
  assert.equal(pipeline(six, '2026-10-31T15:00:00Z').state.status, 'layover');
  // Depart Wed 4 Nov 01:00 EST (06:00Z): 7 calendar days although only ≈ 158.7 h → not inferred.
  const seven = trip('2026-10-28T16:20:00Z', '2026-11-04T06:00:00Z');
  assert.equal(layoverCalendarDays(at('2026-10-28T16:20:00Z'), at('2026-11-04T06:00:00Z'), 'America/Toronto'), 7);
  assert.equal(pipeline(seven, '2026-10-31T15:00:00Z').state.status, 'unknown');
});

test('time-zone boundary: counted in the outstation\'s local dates, not home dates', () => {
  // Arrive YYZ Sat 10 Oct 20:00 EDT (Sun 11 Oct 02:00 Berlin); depart Sat 17 Oct 08:00 EDT (14:00 Berlin).
  const arr = '2026-10-11T00:00:00Z';
  const dep = '2026-10-17T12:00:00Z';
  assert.equal(layoverCalendarDays(at(arr), at(dep), 'America/Toronto'), 7, 'Toronto dates: 10 → 17 Oct');
  assert.equal(layoverCalendarDays(at(arr), at(dep), 'Europe/Berlin'), 6, 'Berlin dates would say 6');
  assert.equal(pipeline(trip(arr, dep), '2026-10-13T15:00:00Z').state.status, 'unknown');
});

test('an explicit roster layover is never subject to the cap', () => {
  const snap = trip('2026-10-10T16:20:00Z', '2026-10-21T22:30:00Z'); // 11 days apart
  const stated = { ...snap, windows: [{ kind: 'layover', start: at('2026-10-10T16:20:00Z'), end: at('2026-10-21T22:30:00Z'), label: 'YYZ' }] };
  const { state } = pipeline(stated, '2026-10-15T15:00:00Z');
  assert.deepEqual([state.status, state.confidence, state.provenance], ['layover', 'confirmed', 'source']);
  const days = layoverDays(stated, '2026-10-12', 8);
  assert.ok(days.every((d) => d.status === 'layover' && d.confidence === 'confirmed'));
});

test('an explicit roster layover keeps the rotation connected across a long gap', () => {
  const snap = trip('2026-10-10T16:20:00Z', '2026-10-21T22:30:00Z');
  const stated = { ...snap, windows: [{ kind: 'layover', start: at('2026-10-10T16:20:00Z'), end: at('2026-10-21T22:30:00Z'), label: 'YYZ' }] };
  const { roster } = pipeline(stated, '2026-10-15T15:00:00Z');
  assert.equal(roster.rotations.length, 1);
  assert.ok(!roster.warnings.some((w) => w.code === 'layover-too-long'));
});

test('D3: a stated layover window that only overlaps the gap still exempts it from the cap', () => {
  const arr = at('2026-10-10T16:20:00Z');
  const dep = at('2026-10-21T22:30:00Z');
  const snap = trip('2026-10-10T16:20:00Z', '2026-10-21T22:30:00Z');
  const stated = { ...snap, windows: [{ kind: 'layover', start: arr + 2 * 3600000, end: dep - 3 * 3600000, label: 'YYZ' }] };
  const { roster } = pipeline(stated, '2026-10-15T15:00:00Z');
  assert.equal(roster.rotations.length, 1);
  assert.ok(!roster.warnings.some((w) => w.code === 'layover-too-long'));
  // A window for a different airport does not exempt the gap.
  const other = { ...snap, windows: [{ kind: 'layover', start: arr, end: dep, label: 'YUL' }] };
  assert.equal(pipeline(other, '2026-10-15T15:00:00Z').roster.rotations.length, 2);
});
