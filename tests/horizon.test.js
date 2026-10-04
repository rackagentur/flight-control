// Duty Horizon model: milestones from data only, phase status at boundaries, "now" placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSnapshot, pipeline } from './helpers.js';

const snap = fixtureSnapshot();

test('rotation milestones: wake-up, pickup, departures, arrivals; no invented briefing', () => {
  const { horizon } = pipeline(snap, '2026-10-10T05:00:00Z');
  assert.deepEqual(horizon.stops.map((s) => s.kind), ['wakeup', 'pickup', 'departure', 'arrival', 'departure', 'arrival']);
  assert.ok(!horizon.stops.some((s) => s.kind === 'briefing'), 'v5 has no report time');
  assert.deepEqual(horizon.spans.map((s) => s.kind), ['before', 'prepare', 'ground', 'flight', 'layover', 'return', 'recovery']);
});

test('phase status at boundaries: departure instant makes the flight current', () => {
  const dep = Date.parse('2026-10-10T07:40:00Z');
  const before = pipeline(snap, new Date(dep - 1000).toISOString()).horizon;
  const atDep = pipeline(snap, new Date(dep).toISOString()).horizon;
  assert.equal(before.spans.find((s) => s.kind === 'ground').status, 'current');
  assert.equal(atDep.spans.find((s) => s.kind === 'flight').status, 'current');
  assert.equal(atDep.spans.find((s) => s.kind === 'ground').status, 'past');
});

test('"now" moves monotonically through the rotation', () => {
  const xs = ['2026-10-10T04:00:00Z', '2026-10-10T05:00:00Z', '2026-10-10T10:00:00Z', '2026-10-11T15:00:00Z', '2026-10-12T23:30:00Z', '2026-10-13T08:00:00Z']
    .map((iso) => pipeline(snap, iso).horizon.now.x);
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] >= xs[i - 1], `x[${i}]=${xs[i]} < x[${i - 1}]=${xs[i - 1]}`);
  assert.ok(xs[0] >= 0 && xs.at(-1) <= 1);
});

test('exactly one next milestone, and it is the first upcoming stop', () => {
  const { horizon } = pipeline(snap, '2026-10-11T15:00:00Z');
  const next = horizon.stops.filter((s) => s.next);
  assert.equal(next.length, 1);
  assert.equal(next[0].kind, 'departure');
  assert.equal(next[0].code, 'YYZ');
});

test('upcoming rotation is shown in upcoming mode before it starts', () => {
  const { horizon } = pipeline(snap, '2026-10-04T08:00:00Z');
  assert.equal(horizon.mode, 'upcoming');
  assert.equal(horizon.rotation.duties[0].sectors[0].flightNumber, 'DE2074');
});

test('after landing at base the rotation shows recovery for 12 hours, then the next rotation', () => {
  assert.equal(pipeline(snap, '2026-10-13T09:00:00Z').horizon.mode, 'recovery');
  const next = pipeline(snap, '2026-10-13T20:00:00Z').horizon;
  assert.equal(next.mode, 'upcoming');
  assert.equal(next.rotation.duties[0].sectors[0].flightNumber, 'DE2324');
});

test('an open rotation (no return in the data) has no recovery phase', () => {
  const { horizon } = pipeline(snap, '2026-10-30T18:00:00Z');
  assert.equal(horizon.rotation.closed, false);
  assert.ok(!horizon.spans.some((s) => s.kind === 'recovery'));
});
