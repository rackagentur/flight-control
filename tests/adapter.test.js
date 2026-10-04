// v5 adapter: field mapping, legacy preservation, defensive validation, first-flight pickup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptV5, AdapterError, V5_CAPABILITIES } from '../src/sources/fc-appscript-v5.js';
import { formatTime } from '../src/lib/time.js';
import { PROFILE, at, loadFixture, fixtureSnapshot } from './helpers.js';

test('maps every fixture sector with instants, IANA zones and preserved legacy strings', () => {
  const snap = fixtureSnapshot();
  assert.equal(snap.sectors.length, 5);
  const [out] = snap.sectors;
  assert.equal(out.flightNumber, 'DE2074');
  assert.equal(out.origin, 'FRA');
  assert.equal(out.destination, 'YYZ');
  assert.equal(out.originTz, 'Europe/Berlin');
  assert.equal(out.destTz, 'America/Toronto');
  assert.equal(out.blockMin, 520);
  assert.equal(out.legacy.arrivalLocal, '10:20', 'v5 string kept for parity only');
  assert.equal(formatTime(out.arr, out.destTz), '12:20', 'V2 derives the corrected local arrival');
  assert.equal(snap.capabilities, V5_CAPABILITIES);
  assert.equal(snap.source.kind, 'fixture');
});

test('pickup attaches to the first flight of a duty only, and is never fabricated', () => {
  const snap = fixtureSnapshot();
  const byNumber = Object.fromEntries(snap.sectors.map((s) => [s.flightNumber, s]));
  assert.equal(byNumber.DE2074.pickup, at('2026-10-10T05:25:00Z'));
  assert.equal(byNumber.DE2324.pickup, at('2026-10-26T07:00:00Z'));
  // v5 dropped the return pickups (legacy defect B7): V2 must not invent them.
  assert.equal(byNumber.DE2075.pickup, null);
  assert.equal(byNumber.DE2325.pickup, null);
});

test('a pickup shared by two flights on the same day stays on the first flight only', () => {
  const snap = fixtureSnapshot((p) => {
    const first = p.upcoming[0];
    p.upcoming[1] = { ...p.upcoming[1], origin: 'YYZ', depTimestamp: first.endTimestamp + 3600000, endTimestamp: first.endTimestamp + 4 * 3600000,
      pickupTimestamp: first.pickupTimestamp, pickup: first.pickup };
  });
  const withPickup = snap.sectors.filter((s) => s.pickup !== null);
  assert.equal(withPickup.filter((s) => s.pickup === at('2026-10-10T05:25:00Z')).length, 1);
  assert.equal(withPickup[0].flightNumber, 'DE2074');
});

test('implausible pickups (after departure or > 8 h before) are dropped with a warning', () => {
  const snap = fixtureSnapshot((p) => { p.upcoming[0].pickupTimestamp = p.upcoming[0].depTimestamp + 60000; });
  assert.equal(snap.sectors[0].pickup, null);
  assert.ok(snap.warnings.some((w) => w.code === 'implausible-pickup'));
});

test('days-off blocks are built from numbers relative to the fetch day, never from display strings', () => {
  const snap = fixtureSnapshot((p) => { for (const b of p.daysOff) b.startDate = 'garbage'; });
  assert.deepEqual(snap.offBlocks, [
    { start: '2026-10-04', days: 2 },
    { start: '2026-10-08', days: 2 },
    { start: '2026-10-11', days: 2 },
  ]);
  assert.equal(snap.offCoverageEnd, '2026-10-12', 'three blocks: the source speaks only up to the end of the third');
});

test('a cached payload adapted on a later day keeps its original day references', () => {
  const payload = loadFixture();
  const snap = adaptV5(payload, { profile: PROFILE, fetchedAt: at(payload._now), kind: 'cache' });
  assert.equal(snap.offBlocks[0].start, '2026-10-04');
});

test('malformed and missing fields degrade with warnings instead of throwing', () => {
  const snap = fixtureSnapshot((p) => {
    p.upcoming[0].depTimestamp = 'soon';
    p.upcoming[1].origin = 'toronto';
    p.upcoming[2] = null;
    p.upcoming[3].destination = 'ZZZ';
    delete p.dutyBlock;
    p.daysOff = [{ count: -1, daysUntil: 2 }];
  });
  assert.deepEqual(snap.sectors.map((s) => s.flightNumber), ['DE2325', 'DE2160']);
  const codes = snap.warnings.map((w) => w.code);
  for (const code of ['malformed-sector', 'unknown-airport', 'malformed-days-off', 'upcoming-truncated']) assert.ok(codes.includes(code), code);
  const unknown = snap.sectors.find((s) => s.flightNumber === 'DE2325');
  assert.equal(unknown.destTz, null, 'unknown airport: no guessed zone');
  assert.equal(snap.dutyBlock, null);
});

test('missing upcoming list yields an empty roster with a warning', () => {
  const snap = fixtureSnapshot((p) => { delete p.upcoming; });
  assert.equal(snap.sectors.length, 0);
  assert.ok(snap.warnings.some((w) => w.code === 'missing-field'));
});

test('backend errors and non-objects are rejected explicitly', () => {
  assert.throws(() => adaptV5({ success: false, message: 'Calendar not found' }, { profile: PROFILE, fetchedAt: Date.now() }),
    (e) => e instanceof AdapterError && e.code === 'backend-error' && /Calendar not found/.test(e.message));
  assert.throws(() => adaptV5(null, { profile: PROFILE, fetchedAt: Date.now() }), AdapterError);
  assert.throws(() => adaptV5({ success: true }, { profile: PROFILE }), AdapterError);
});

test('exact duplicate sectors (same flight, route and times) are merged with a warning', () => {
  const snap = fixtureSnapshot((p) => { p.upcoming.splice(1, 0, { ...p.upcoming[0] }); });
  assert.equal(snap.sectors.filter((s) => s.flightNumber === 'DE2074').length, 1);
  assert.ok(snap.warnings.some((w) => w.code === 'duplicate-sector'));
});

test('same flight number with different times is NOT merged', () => {
  const snap = fixtureSnapshot((p) => {
    p.upcoming.splice(1, 0, { ...p.upcoming[0], depTimestamp: p.upcoming[0].depTimestamp + 86400000, endTimestamp: p.upcoming[0].endTimestamp + 86400000 });
  });
  assert.equal(snap.sectors.filter((s) => s.flightNumber === 'DE2074').length, 2);
});

test('duplicate sectors do not inflate statistics: month figures corrected and recorded', () => {
  const base = fixtureSnapshot();
  const dup = fixtureSnapshot((p) => { p.upcoming.splice(3, 0, { ...p.upcoming[2] }); }); // DE2324, 26 Oct (fetch month)
  const block = dup.sectors.find((s) => s.flightNumber === 'DE2324').blockMin / 60;
  assert.equal(dup.stats.month.flights, base.stats.month.flights - 1);
  assert.equal(dup.stats.month.flightsRemaining, base.stats.month.flightsRemaining - 1);
  assert.equal(dup.stats.month.hours, Math.round((base.stats.month.hours - block) * 10) / 10);
  assert.equal(dup.stats.month.projectedHours, Math.round((dup.stats.month.hours / 4) * 31 * 10) / 10);
  assert.deepEqual(dup.stats.adjustments.map((a) => a.field).sort(), ['month.flights', 'month.flightsRemaining', 'month.hours']);
  assert.equal(base.stats.adjustments.length, 0);
  // A future duplicate is not yet in v5's year/all-time counts: those stay untouched.
  assert.equal(dup.stats.year.flights, base.stats.year.flights);
  assert.equal(dup.stats.allTime.flights, base.stats.allTime.flights);
});

test('duplicates produce no extra duty, rotation or timeline entry', async () => {
  const { pipeline } = await import('./helpers.js');
  const dup = fixtureSnapshot((p) => { p.upcoming.splice(1, 0, { ...p.upcoming[0] }); });
  const { roster, horizon } = pipeline(dup, '2026-10-10T05:00:00Z');
  assert.equal(roster.duties.filter((d) => d.sectors.some((s) => s.flightNumber === 'DE2074')).length, 1);
  assert.ok(!roster.warnings.some((w) => w.code === 'itinerary-gap'));
  assert.equal(horizon.stops.filter((s) => s.kind === 'departure' && s.sector.flightNumber === 'DE2074').length, 1);
});

test('duplicate overnight sector arriving on the 1st counts in the new month (v5 counts overlap)', () => {
  // Fetched on 1 Nov 00:30 Berlin; the duplicate departed 31 Oct 22:00 Berlin and lands on 1 Nov.
  const dup = fixtureSnapshot((p) => {
    p._now = '2026-10-31T23:30:00Z';
    const s = { ...p.upcoming[4], depTimestamp: Date.parse('2026-10-31T21:00:00Z'), endTimestamp: Date.parse('2026-11-01T08:00:00Z') };
    p.upcoming = [s, { ...s }];
  });
  const fields = dup.stats.adjustments.map((a) => a.field);
  assert.ok(fields.includes('month.flights') && fields.includes('month.hours'));
  assert.ok(fields.includes('year.flights'), 'already departed: also in year/all-time');
});

test('already-departed duplicate: year projection recomputed, all-time hours stay whole', () => {
  const dup = fixtureSnapshot((p) => {
    const s = { ...p.upcoming[0], depTimestamp: Date.parse('2026-10-04T04:00:00Z'), endTimestamp: Date.parse('2026-10-04T05:30:00Z') };
    p.upcoming = [s, { ...s }];
  });
  const hours = 1.5;
  assert.equal(dup.stats.year.hours, Math.round((902.4 - hours) * 10) / 10);
  assert.equal(dup.stats.year.projectedHours, Math.round((dup.stats.year.hours / 277) * 365));
  assert.ok(Number.isInteger(dup.stats.allTime.hours));
});

test('same flight and departure with a different arrival: kept, flagged, unique ids', () => {
  const snap = fixtureSnapshot((p) => { p.upcoming.splice(1, 0, { ...p.upcoming[0], endTimestamp: p.upcoming[0].endTimestamp + 300000 }); });
  const twins = snap.sectors.filter((s) => s.flightNumber === 'DE2074');
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].id, twins[1].id);
  assert.ok(snap.warnings.some((w) => w.code === 'conflicting-sectors'));
});

test('merging duplicates keeps a pickup carried only by the second copy', () => {
  const snap = fixtureSnapshot((p) => {
    const first = { ...p.upcoming[0], pickupTimestamp: null, pickup: null };
    p.upcoming = [first, { ...p.upcoming[0] }, ...p.upcoming.slice(1)];
  });
  assert.equal(snap.sectors.find((s) => s.flightNumber === 'DE2074').pickup, Date.parse('2026-10-10T05:25:00Z'));
});
