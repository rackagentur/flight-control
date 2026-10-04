// Operational state engine: every state, the approved evidence rules, fallbacks, next event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSnapshot, sampleProfile } from '../src/sources/sample.js';
import { airport } from '../src/data/airports.js';
import { withHistory, rememberSectors } from '../src/model/history.js';
import { deriveState } from '../src/model/state.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

const snap = fixtureSnapshot();
const SP = sampleProfile(PROFILE);

test('no source → UNKNOWN (no-source)', () => {
  const state = deriveState(null, null, PROFILE, Date.now());
  assert.equal(state.status, 'unknown');
  assert.equal(state.phase, 'no-source');
});

test('v5 "day off" alone is NOT OFF: UNKNOWN with the reason, and the next duty still known', () => {
  const { state } = pipeline(snap, '2026-10-04T08:00:00Z');
  assert.equal(state.status, 'unknown');
  assert.equal(state.confidence, 'unknown');
  assert.equal(state.phase, 'no-duty-reported');
  assert.match(state.reasons[0], /not proof of a day off/);
  assert.equal(state.duty.sectors[0].flightNumber, 'DE2074');
  assert.equal(state.nextEvent.kind, 'wakeup');
});

test('FLIGHT before wake-up on a home departure day (confirmed, pre-departure)', () => {
  const { state } = pipeline(snap, '2026-10-10T04:00:00Z');
  assert.deepEqual([state.status, state.confidence, state.provenance, state.phase], ['flight', 'confirmed', 'source', 'pre-departure']);
  assert.equal(state.nextEvent.kind, 'wakeup');
});

test('next event steps wake-up → pickup → departure → arrival', () => {
  assert.equal(pipeline(snap, '2026-10-10T04:30:00Z').state.nextEvent.kind, 'pickup');
  assert.equal(pipeline(snap, '2026-10-10T05:30:00Z').state.nextEvent.kind, 'departure');
  assert.equal(pipeline(snap, '2026-10-10T10:00:00Z').state.nextEvent.kind, 'arrival');
});

test('FLIGHT airborne between departure and arrival', () => {
  const { state } = pipeline(snap, '2026-10-10T10:00:00Z');
  assert.equal(state.status, 'flight');
  assert.equal(state.phase, 'airborne');
});

test('LAYOVER inferred from itinerary evidence, never presented as confirmed', () => {
  const { state } = pipeline(snap, '2026-10-11T15:00:00Z');
  assert.equal(state.status, 'layover');
  assert.equal(state.confidence, 'inferred');
  assert.equal(state.provenance, 'derived');
  assert.equal(state.location, 'YYZ');
  assert.equal(state.nextEvent.label, 'Departure DE2075');
});

test('layover without visible inbound flight is ambiguous → UNKNOWN', () => {
  // Drop the outbound FRA→YYZ: the next departure is from YYZ but nothing shows how we got there.
  const partial = fixtureSnapshot((p) => { p.upcoming.shift(); });
  const { state } = pipeline(partial, '2026-10-11T15:00:00Z');
  assert.equal(state.status, 'unknown');
  assert.match(state.reasons.join(' '), /next departure is from YYZ/);
});

test('remembered inbound sector (history) restores the strong evidence for a layover', () => {
  const full = fixtureSnapshot();
  const history = rememberSectors([], full, at('2026-10-10T08:00:00Z'));
  // Next day v5 no longer lists the outbound (it departed before today 00:00).
  const nextDay = fixtureSnapshot((p) => { p.upcoming.shift(); });
  const merged = withHistory({ ...nextDay, coverageStart: at('2026-10-10T22:00:00Z') }, history, at('2026-10-11T15:00:00Z'));
  assert.equal(merged.sectors[0].provenance, 'history');
  const { state } = pipeline(merged, '2026-10-11T15:00:00Z');
  assert.equal(state.status, 'layover');
  assert.equal(state.confidence, 'inferred');
});

test('an itinerary gap (arrive A, depart B) produces no layover and a warning', () => {
  const gap = fixtureSnapshot((p) => { p.upcoming[1].origin = 'YUL'; });
  const { state, roster } = pipeline(gap, '2026-10-11T15:00:00Z');
  assert.notEqual(state.status, 'layover');
  assert.ok(roster.warnings.some((w) => w.code === 'itinerary-gap'));
});

test('overnight return: airborne across home midnight, then duty complete at base', () => {
  assert.equal(pipeline(snap, '2026-10-12T22:40:00Z').state.phase, 'airborne');
  const after = pipeline(snap, '2026-10-13T09:00:00Z').state;
  assert.equal(after.status, 'flight');
  assert.equal(after.phase, 'post-duty');
  assert.equal(after.location, 'FRA');
});

test('STANDBY and RESERVE only when the source states the window', () => {
  for (const kind of ['standby', 'reserve']) {
    const now = Date.now();
    const sample = sampleSnapshot(kind, null, now, SP);
    const { state } = pipeline(sample, new Date(now).toISOString(), SP);
    assert.equal(state.status, kind);
    assert.equal(state.confidence, 'confirmed');
    assert.equal(state.nextEvent.kind, `${kind}-end`);
  }
});

test('OFF only from a source that states it; next event is the next duty, not the end of the day off', () => {
  const now = Date.now();
  const { state } = pipeline(sampleSnapshot('off', null, now, SP), new Date(now).toISOString(), SP);
  assert.equal(state.status, 'off');
  assert.equal(state.confidence, 'confirmed');
  assert.notEqual(state.nextEvent.kind, 'off-end');
});

test('sample FLIGHT and LAYOVER scenarios resolve to their states', () => {
  const now = Date.now();
  assert.equal(pipeline(sampleSnapshot('flight', null, now, SP), new Date(now).toISOString(), SP).state.status, 'flight');
  const layover = pipeline(sampleSnapshot('layover', 'ocean', now, SP), new Date(now).toISOString(), SP).state;
  assert.equal(layover.status, 'layover');
  assert.equal(layover.location, 'AWAY');
});

test('empty roster → UNKNOWN with an explanation', () => {
  const empty = fixtureSnapshot((p) => { p.upcoming = []; p.daysOff = []; });
  const { state } = pipeline(empty, '2026-10-04T08:00:00Z');
  assert.equal(state.status, 'unknown');
  assert.ok(state.reasons.length > 0);
});

test('7-day view: flights confirmed, layover inferred, free days unknown (not off), busy days unspecified', () => {
  const { roster } = pipeline(snap, '2026-10-04T08:00:00Z');
  const summary = roster.days.map((d) => `${d.date.slice(8)}:${d.status}${d.evidence ? `/${d.evidence}` : ''}`);
  assert.deepEqual(summary, [
    '04:unknown/no-duty-reported', '05:unknown/no-duty-reported', '06:unknown/duty-unspecified', '07:unknown/duty-unspecified',
    '08:unknown/no-duty-reported', '09:unknown/no-duty-reported', '10:flight',
  ]);
  const later = pipeline(snap, '2026-10-10T08:00:00Z').roster.days;
  assert.deepEqual(later.slice(0, 4).map((d) => [d.label, d.status, d.confidence]), [
    ['YYZ', 'flight', 'confirmed'], ['YYZ', 'layover', 'inferred'], ['YYZ', 'layover', 'inferred'], ['FRA', 'flight', 'confirmed'],
  ]);
});

test('post-duty shows the duty just completed, with the next duty only as the next event', () => {
  const cut = fixtureSnapshot((p) => { p.upcoming = p.upcoming.slice(0, 2); });
  const lone = pipeline(cut, '2026-10-13T08:00:00Z').state;
  assert.equal(lone.phase, 'post-duty');
  assert.equal(lone.duty.sectors[0].flightNumber, 'DE2075', 'completed duty, not a fallback to unknown');
  assert.equal(lone.nextDuty, null);
  const withNext = pipeline(snap, '2026-10-13T09:00:00Z').state;
  assert.equal(withNext.duty.sectors[0].flightNumber, 'DE2075');
  assert.equal(withNext.nextDuty.sectors[0].flightNumber, 'DE2324');
});

test('review samples use only fictional identifiers (never real airports or airline flight numbers)', () => {
  const now = Date.now();
  for (const [state, tone] of [['off'], ['flight'], ['standby'], ['reserve'], ['layover', 'ocean'], ['layover', 'sand'], ['unknown']]) {
    const sample = sampleSnapshot(state, tone, now, SP);
    assert.equal(sample.source.kind, 'sample');
    assert.match(sample.source.label, /not your roster/i);
    for (const s of sample.sectors) {
      assert.match(s.flightNumber, /^SAMPLE \d{2}$/, s.flightNumber);
      assert.equal(airport(s.origin), null, `${s.origin} must not be a real airport`);
      assert.equal(airport(s.destination), null, `${s.destination} must not be a real airport`);
    }
  }
});

test('today counted as a non-flight duty day by the source → UNKNOWN with that exact reason (never OFF)', () => {
  // Fixture day 6 Oct is busy in v5 (no free block) without a flight (SB/RE/ORT in the source).
  const { state } = pipeline(snap, '2026-10-06T08:00:00Z');
  assert.equal(state.status, 'unknown');
  assert.equal(state.phase, 'duty-unspecified');
  assert.match(state.reasons[0], /duty day without a flight/);
});

test('history matches sectors by content: old-format ids or repeats never double up', () => {
  const full = fixtureSnapshot();
  const out = full.sectors[0];
  const legacyIdCopy = { ...out, id: `${out.flightNumber}-${out.dep}` }; // pre-change id format
  const history = rememberSectors([legacyIdCopy], full, at('2026-10-10T08:00:00Z'));
  assert.equal(history.filter((s) => s.flightNumber === out.flightNumber && s.dep === out.dep).length, 1);
  const nextDay = fixtureSnapshot((p) => { p.upcoming.shift(); });
  const merged = withHistory({ ...nextDay, coverageStart: at('2026-10-10T22:00:00Z') }, [...history, legacyIdCopy], at('2026-10-11T15:00:00Z'));
  assert.equal(merged.sectors.filter((s) => s.flightNumber === out.flightNumber).length, 1);
});
