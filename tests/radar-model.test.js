// Radar (read-only, slice 1): window selection and the departures view model. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectStandbyWindow, buildRadarView, checkWindow, radarLinkable, delayText, RADAR_WINDOW_KINDS, RADAR_HORIZON_MS } from '../src/model/radar.js';
import { rangeForWindow } from '../src/model/scheduled-flights.js';
import { airlineOf, getAirline } from '../src/airlines/index.js';
import { offsetMinutes, formatTime } from '../src/lib/time.js';
import { PROFILE } from '../tests/helpers.js';

const H = 3600000;
const M = 60000;
const D = 24 * H;
const TZ = 'Europe/Berlin';
// The instant whose Berlin wall clock reads dateKey hh:mm (a skipped time is not used in these tests).
const berlin = (dateKey, hh, mm = 0) => {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 3; i += 1) t = wall - offsetMinutes(t, TZ) * M;
  return t;
};
const sb = (start, end, label = 'SB90') => ({ kind: 'standby', start, end, label });
const snap = (...windows) => ({ windows });
const NOW = Date.parse('2026-10-06T10:00:00Z');

test('only standby is an allowed kind (reserve is deliberately not)', () => {
  assert.deepEqual([...RADAR_WINDOW_KINDS], ['standby']);
  assert.throws(() => { RADAR_WINDOW_KINDS.push('reserve'); }, TypeError);
});

test('selectStandbyWindow: a param equal to a window start wins over the current window', () => {
  const current = sb(NOW - 2 * H, NOW + 4 * H, 'CUR');
  const later = sb(NOW + 2 * D, NOW + 2 * D + 8 * H, 'LATER');
  const r = selectStandbyWindow(snap(current, later), NOW, String(later.start));
  assert.equal(r.window, later);
  assert.equal(r.reason, null);
  // A param that matches nothing falls through to the current window.
  assert.equal(selectStandbyWindow(snap(current, later), NOW, '12345').window, current);
  assert.equal(selectStandbyWindow(snap(current, later), NOW, 'abc').window, current);
});

test('selectStandbyWindow: the window containing now, else the next one within 14 days', () => {
  const current = sb(NOW - H, NOW + H);
  const next = sb(NOW + 3 * D, NOW + 3 * D + 6 * H, 'NEXT');
  assert.equal(selectStandbyWindow(snap(next, current), NOW).window, current);
  const upcoming = selectStandbyWindow(snap(sb(NOW + 5 * D, NOW + 5 * D + H, 'B'), next), NOW);
  assert.equal(upcoming.window, next);
  assert.equal(upcoming.reason, null);
  // The end is exclusive: a window ending exactly now is not current.
  assert.equal(selectStandbyWindow(snap(sb(NOW - H, NOW)), NOW).reason, 'none');
});

test('selectStandbyWindow: an ended window by param is reported as ended', () => {
  const past = sb(NOW - 10 * H, NOW - 2 * H);
  const r = selectStandbyWindow(snap(past), NOW, String(past.start));
  assert.equal(r.window, past);
  assert.equal(r.reason, 'ended');
  assert.equal(checkWindow(past, past.end).reason, 'ended');
});

test('selectStandbyWindow: too-far gives the date schedules open (start minus 14 days); exactly 14 days is allowed', () => {
  const far = sb(NOW + 20 * D, NOW + 20 * D + 8 * H);
  const r = selectStandbyWindow(snap(far), NOW, String(far.start));
  assert.equal(r.reason, 'too-far');
  assert.equal(r.availableFrom, far.start - RADAR_HORIZON_MS);
  assert.equal(r.availableFrom, far.start - 14 * D);
  // Without a param a window beyond 14 days is simply none.
  assert.equal(selectStandbyWindow(snap(far), NOW).reason, 'none');
  const edge = sb(NOW + 14 * D, NOW + 14 * D + H);
  assert.equal(selectStandbyWindow(snap(edge), NOW).reason, null);
  assert.equal(checkWindow(sb(NOW + 14 * D + 1, NOW + 15 * D), NOW).reason, 'too-far');
});

test('selectStandbyWindow: longer than 24 h is too-long, 24 h exactly is fine', () => {
  const long = sb(NOW - H, NOW - H + 25 * H);
  assert.equal(selectStandbyWindow(snap(long), NOW).reason, 'too-long');
  assert.equal(selectStandbyWindow(snap(sb(NOW - H, NOW + 23 * H)), NOW).reason, null);
  assert.equal(rangeForWindow(long), null);
});

test('selectStandbyWindow: reserve (and other kinds) are ignored; nothing at all is none', () => {
  const reserve = { kind: 'reserve', start: NOW - H, end: NOW + H, label: 'RE' };
  const r = selectStandbyWindow(snap(reserve), NOW, String(reserve.start));
  assert.deepEqual(r, { window: null, reason: 'none', availableFrom: null });
  assert.equal(selectStandbyWindow(snap(), NOW).reason, 'none');
  assert.equal(selectStandbyWindow({ windows: [{ kind: 'off', start: NOW - H, end: NOW + H }] }, NOW).reason, 'none');
  assert.equal(selectStandbyWindow(null, NOW).reason, 'none');
  assert.equal(selectStandbyWindow({}, NOW).reason, 'none');
});

test('overnight window 22:00 to 06:00 Europe/Berlin is selected and requested as instants', () => {
  const w = sb(berlin('2026-10-10', 22), berlin('2026-10-11', 6));
  assert.equal(w.end - w.start, 8 * H);
  const at0230 = berlin('2026-10-11', 2, 30);
  const r = selectStandbyWindow(snap(w), at0230);
  assert.equal(r.window, w);
  assert.equal(r.reason, null);
  assert.deepEqual(rangeForWindow(w), { from: w.start, to: w.end });
  // The day before the window opens: still the next upcoming window.
  assert.equal(selectStandbyWindow(snap(w), berlin('2026-10-09', 12)).window, w);
});

test('both 2026 DST nights: 22:00 to 06:00 is 7 h (spring) and 9 h (autumn) and stays one valid window', () => {
  const spring = sb(berlin('2026-03-28', 22), berlin('2026-03-29', 6));
  const autumn = sb(berlin('2026-10-24', 22), berlin('2026-10-25', 6));
  assert.equal(spring.end - spring.start, 7 * H);
  assert.equal(autumn.end - autumn.start, 9 * H);
  for (const [w, key] of [[spring, '2026-03-29'], [autumn, '2026-10-25']]) {
    const during = berlin(key, 4);
    const r = selectStandbyWindow(snap(w), during);
    assert.equal(r.window, w);
    assert.equal(r.reason, null);
    assert.deepEqual(rangeForWindow(w), { from: w.start, to: w.end });
  }
  // 06:00 is the (exclusive) end on both nights.
  assert.equal(selectStandbyWindow(snap(autumn), autumn.end).reason, 'none');
});

test('radarLinkable: standby only, not ended, starting within 14 days', () => {
  assert.equal(radarLinkable(sb(NOW - H, NOW + H), NOW), true);
  assert.equal(radarLinkable(sb(NOW + 14 * D, NOW + 14 * D + H), NOW), true);
  assert.equal(radarLinkable(sb(NOW + 15 * D, NOW + 15 * D + H), NOW), false);
  assert.equal(radarLinkable(sb(NOW - 2 * H, NOW), NOW), false);
  assert.equal(radarLinkable({ kind: 'reserve', start: NOW - H, end: NOW + H }, NOW), false);
  assert.equal(radarLinkable(null, NOW), false);
});

// ---------- buildRadarView ----------

let seq = 0;
function fl(over = {}) {
  seq += 1;
  return {
    id: `f_${String(seq).padStart(16, '0')}`, flightNumber: `XX${1000 + seq}`, carrier: null, origin: 'FRA', destination: 'LHR', destinationName: 'London Heathrow',
    scheduledDep: NOW, revisedDep: null, status: 'scheduled', aircraft: { model: 'A320', registration: null }, originTz: TZ, destTz: null, provenance: 'provider', ...over,
  };
}
const result = (flights, over = {}) => ({ airport: 'FRA', airportTz: TZ, from: 0, to: 0, carriers: null, provider: 'x', fetchedAt: NOW, generatedAt: NOW, dropped: 0, flights, fromCache: false, ...over });
const WIN = sb(NOW - 3 * H, NOW + 6 * H);
const view = (flights, opts = {}, over = {}) => buildRadarView(result(flights, over), { now: NOW, window: WIN, emphasisCarriers: null, homeTz: TZ, ...opts });
const rowsOf = (v) => [...v.earlier, ...v.groups.flatMap((g) => g.rows)];

test('rows are sorted by scheduled time then flight number, and limited to the window', () => {
  const v = view([
    fl({ flightNumber: 'ZZ9', scheduledDep: NOW + H }),
    fl({ flightNumber: 'AA2', scheduledDep: NOW + 2 * H }),
    fl({ flightNumber: 'AA1', scheduledDep: NOW + 2 * H }),
    fl({ flightNumber: 'OUT', scheduledDep: NOW + 7 * H }),
  ]);
  assert.deepEqual(rowsOf(v).map((r) => r.flightNumber), ['ZZ9', 'AA1', 'AA2']);
  assert.equal(v.total, 3);
});

test('hour groups are by local hour at the airport, not at home or UTC', () => {
  const dep = (hh, mm) => berlin('2026-10-06', hh, mm);
  const flights = [fl({ scheduledDep: dep(14, 5) }), fl({ scheduledDep: dep(14, 55) }), fl({ scheduledDep: dep(15, 0) }), fl({ scheduledDep: dep(17, 30) })];
  const win = sb(dep(13, 0), dep(20, 0));
  const v = buildRadarView(result(flights), { now: dep(12, 0), window: win, emphasisCarriers: null, homeTz: TZ });
  assert.deepEqual(v.groups.map((g) => [g.label, g.rows.length]), [['14:00', 2], ['15:00', 1], ['17:00', 1]]);
  assert.equal(v.tzLabel, null);
  // Same instants, airport in New York: hours move with the airport zone and the label says so.
  const ny = buildRadarView(result(flights, { airportTz: 'America/New_York' }), { now: dep(12, 0), window: win, emphasisCarriers: null, homeTz: TZ });
  assert.deepEqual(ny.groups.map((g) => g.label), ['08:00', '09:00', '11:00']);
  assert.match(ny.tzLabel, /local at FRA/);
  assert.equal(ny.groups[0].rows[0].timeText, formatTime(dep(14, 5), 'America/New_York'));
});

test('an overnight window labels the day only when the date changes', () => {
  const w = sb(berlin('2026-10-10', 22), berlin('2026-10-11', 6));
  const flights = [fl({ scheduledDep: berlin('2026-10-10', 22, 30) }), fl({ scheduledDep: berlin('2026-10-10', 23, 10) }), fl({ scheduledDep: berlin('2026-10-11', 1, 0) })];
  const v = buildRadarView(result(flights), { now: berlin('2026-10-10', 12), window: w, emphasisCarriers: null, homeTz: TZ });
  assert.deepEqual(v.groups.map((g) => g.label), ['22:00', '23:00', '01:00']);
  assert.deepEqual(v.groups.map((g) => g.dayLabel !== null), [true, false, true]);
  // A same-day window has no day labels.
  assert.ok(view([fl({ scheduledDep: NOW + H })]).groups.every((g) => g.dayLabel === null));
});

test('the repeated hour on the autumn DST night stays two groups, in instant order', () => {
  const w = sb(berlin('2026-10-24', 22), berlin('2026-10-25', 6));
  const first = berlin('2026-10-24', 22) + 4 * H + 10 * M;     // 02:10 CEST
  const second = first + H;                                      // 02:10 CET
  const v = buildRadarView(result([fl({ scheduledDep: second }), fl({ scheduledDep: first })]), { now: berlin('2026-10-24', 12), window: w, emphasisCarriers: null, homeTz: TZ });
  // Identical headings are told apart by the UTC offset of each hour.
  assert.deepEqual(v.groups.map((g) => g.label), ['02:00 · UTC+2', '02:00 · UTC+1']);
  assert.deepEqual(rowsOf(v).map((r) => r.scheduledDep), [first, second]);
  // Headings that do not repeat stay plain (a following hour, and a normal night).
  const next = berlin('2026-10-24', 22) + 6 * H;
  const w2 = buildRadarView(result([fl({ scheduledDep: first }), fl({ scheduledDep: second }), fl({ scheduledDep: next })]), { now: berlin('2026-10-24', 12), window: w, emphasisCarriers: null, homeTz: TZ });
  assert.deepEqual(w2.groups.map((g) => g.label), ['02:00 · UTC+2', '02:00 · UTC+1', '03:00']);
  assert.ok(view([fl({ scheduledDep: NOW + H }), fl({ scheduledDep: NOW + 2 * H })]).groups.every((g) => /^\d\d:00$/.test(g.label)));
});

test('the same hour on different days is not a repeat: the day line tells them apart, no offset is added', () => {
  const w = sb(berlin('2026-10-10', 22), berlin('2026-10-11', 23, 30));
  const v = buildRadarView(result([fl({ scheduledDep: berlin('2026-10-10', 23, 10) }), fl({ scheduledDep: berlin('2026-10-11', 23, 10) })]), { now: berlin('2026-10-10', 12), window: w, emphasisCarriers: null, homeTz: TZ });
  assert.deepEqual(v.groups.map((g) => g.label), ['23:00', '23:00']);
});

test('active window: earlier rows (revised, else scheduled, before now) are split off with a count', () => {
  const v = view([
    fl({ flightNumber: 'A1', scheduledDep: NOW - 2 * H }),
    fl({ flightNumber: 'A2', scheduledDep: NOW - 30 * M, revisedDep: NOW + 20 * M, status: 'delayed' }),   // revised still ahead: upcoming
    fl({ flightNumber: 'A3', scheduledDep: NOW + 10 * M, revisedDep: NOW - 5 * M }),                       // revised already passed: earlier
    fl({ flightNumber: 'A4', scheduledDep: NOW + H }),
  ]);
  assert.equal(v.active, true);
  assert.deepEqual(v.earlier.map((r) => r.flightNumber), ['A1', 'A3']);
  assert.deepEqual(v.groups.flatMap((g) => g.rows).map((r) => r.flightNumber), ['A2', 'A4']);
  assert.equal(v.upcomingCount, 2);
});

test('a future window: everything is upcoming, no earlier section', () => {
  const w = sb(NOW + 2 * D, NOW + 2 * D + 8 * H);
  const v = buildRadarView(result([fl({ scheduledDep: NOW + 2 * D + H }), fl({ scheduledDep: NOW + 2 * D + 3 * H })]), { now: NOW, window: w, emphasisCarriers: null, homeTz: TZ });
  assert.equal(v.active, false);
  assert.equal(v.earlier.length, 0);
  assert.equal(v.upcomingCount, 2);
});

test('delay is whole minutes between scheduled and revised, signed, and absent when equal', () => {
  const v = view([
    fl({ flightNumber: 'L1', scheduledDep: NOW + H, revisedDep: NOW + H + 25 * M, status: 'delayed' }),
    fl({ flightNumber: 'E1', scheduledDep: NOW + 2 * H, revisedDep: NOW + 2 * H - 5 * M }),
    fl({ flightNumber: 'S1', scheduledDep: NOW + 3 * H, revisedDep: NOW + 3 * H }),
    fl({ flightNumber: 'R1', scheduledDep: NOW + 4 * H, revisedDep: NOW + 4 * H + 90 * 1000 }),         // shown 22:00 -> 22:01: 1 min
    fl({ flightNumber: 'Z1', scheduledDep: NOW + 5 * H, revisedDep: NOW + 5 * H + 20 * 1000 }),         // same displayed minute: no revision shown
  ]);
  const by = Object.fromEntries(rowsOf(v).map((r) => [r.flightNumber, r]));
  assert.equal(by.L1.delayMin, 25);
  assert.equal(by.L1.delayText, '+25 min');
  assert.equal(by.L1.revisedDep, NOW + H + 25 * M);
  assert.equal(by.E1.delayMin, -5);
  assert.equal(by.E1.delayText, '−5 min');
  assert.equal(by.S1.revisedDep, null);
  assert.equal(by.S1.delayMin, null);
  assert.equal(by.R1.delayMin, 1);
  assert.equal(by.Z1.revisedDep, null);
  assert.equal(delayText(-12), '−12 min');
});

test('the delay is computed from the displayed whole-minute times, so the text always equals revised minus scheduled as shown', () => {
  const base = berlin('2026-10-10', 22);   // 22:00:00 local
  const rows = rowsOf(view([
    fl({ flightNumber: 'A1', scheduledDep: base, revisedDep: base + 40 * 1000 }),                 // 22:00 / 22:00 -> no revision
    fl({ flightNumber: 'A2', scheduledDep: base + 2 * H, revisedDep: base + 2 * H + 70 * 1000 }), // 00:00 -> 00:01 +1 min
    fl({ flightNumber: 'A3', scheduledDep: base + 3 * H + 50 * 1000, revisedDep: base + 3 * H + 70 * 1000 }), // 01:00 -> 01:01 (20 s apart, shown 1 min)
    fl({ flightNumber: 'A4', scheduledDep: base + 4 * H + 10 * 1000, revisedDep: base + 4 * H - 20 * 1000 }), // 01:59 shown vs 02:00:10 sched -> earlier
    fl({ flightNumber: 'A5', scheduledDep: base + 5 * H + 50 * 1000, revisedDep: base + 5 * H + 55 * 1000 }), // same displayed minute -> none
  ], { window: sb(base - H, base + 12 * H) }));
  const by = Object.fromEntries(rows.map((r) => [r.flightNumber, r]));
  assert.equal(by.A1.revisedDep, null);
  assert.equal(by.A1.revisedText, null);
  assert.equal(by.A1.delayText, null);
  assert.deepEqual([by.A2.timeText, by.A2.revisedText, by.A2.delayText], ['00:00', '00:01', '+1 min']);
  assert.deepEqual([by.A3.timeText, by.A3.revisedText, by.A3.delayText], ['01:00', '01:01', '+1 min']);
  assert.equal(by.A4.delayMin, -1);
  assert.equal(by.A5.revisedText, null);
  // Whatever the instants, a shown revision always differs from the shown time by exactly the shown minutes.
  for (const r of rows.filter((x) => x.revisedText)) {
    const hm = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const diff = ((hm(r.revisedText) - hm(r.timeText)) + 1440 + 720) % 1440 - 720;
    assert.equal(r.delayMin, diff, r.flightNumber);
    assert.equal(r.delayText, delayText(diff));
  }
});

test('states: cancelled always; departed only once its time has passed; every other status shows none', () => {
  const rows = (status, dep, revised = null) => rowsOf(view([fl({ status, scheduledDep: dep, revisedDep: revised })]))[0];
  assert.equal(rows('cancelled', NOW + H).state, 'cancelled');
  assert.equal(rows('cancelled', NOW - H).state, 'cancelled');
  assert.equal(rows('departed', NOW - H).state, 'departed');
  assert.equal(rows('departed', NOW).state, 'departed');
  // A departed status before its time (the provider's coarse labels) is not shown as a fact.
  assert.equal(rows('departed', NOW + 30 * M).state, null);
  // The revised time decides when it exists.
  assert.equal(rows('departed', NOW - 10 * M, NOW + 5 * M).state, null);
  assert.equal(rows('departed', NOW + 10 * M, NOW - 5 * M).state, 'departed');
  for (const status of ['boarding', 'scheduled', 'delayed', 'unknown']) {
    for (const dep of [NOW - H, NOW + H]) assert.equal(rows(status, dep).state, null, `${status} @ ${dep - NOW}`);
  }
});

test('emphasis comes only from the airline pack designators', () => {
  const pack = airlineOf(PROFILE);
  assert.ok(pack.flightDesignators.length > 0, 'the default pack has designators');
  const flights = [fl({ carrier: pack.flightDesignators[0] }), fl({ carrier: 'ZZ' }), fl({ carrier: null })];
  const v = view(flights, { emphasisCarriers: pack.flightDesignators });
  assert.deepEqual(rowsOf(v).map((r) => r.emphasized), [true, false, false]);
  const generic = getAirline('generic');
  assert.equal(generic.flightDesignators, undefined);
  const g = view(flights, { emphasisCarriers: generic.flightDesignators ?? null });
  assert.ok(rowsOf(g).every((r) => r.emphasized === false));
  assert.ok(rowsOf(view(flights, { emphasisCarriers: [] })).every((r) => r.emphasized === false));
});

test('destination: airport table city, else provider name, else IATA, else a dash; the code is kept', () => {
  const rows = rowsOf(view([
    fl({ flightNumber: 'D1', scheduledDep: NOW + 1 * H, destination: 'LHR', destinationName: 'Provider London' }),
    fl({ flightNumber: 'D2', scheduledDep: NOW + 2 * H, destination: 'ZZZ', destinationName: 'Zed Town' }),
    fl({ flightNumber: 'D3', scheduledDep: NOW + 3 * H, destination: 'ZZZ', destinationName: null }),
    fl({ flightNumber: 'D4', scheduledDep: NOW + 4 * H, destination: null, destinationName: 'Nowhere Intl' }),
    fl({ flightNumber: 'D5', scheduledDep: NOW + 5 * H, destination: null, destinationName: null }),
  ]));
  const by = Object.fromEntries(rows.map((r) => [r.flightNumber, r]));
  assert.notEqual(by.D1.destinationLabel, 'Provider London');
  assert.equal(by.D1.destinationCode, 'LHR');
  assert.deepEqual([by.D2.destinationLabel, by.D2.destinationCode], ['Zed Town', 'ZZZ']);
  assert.deepEqual([by.D3.destinationLabel, by.D3.destinationCode], ['ZZZ', 'ZZZ']);
  assert.deepEqual([by.D4.destinationLabel, by.D4.destinationCode], ['Nowhere Intl', null]);
  assert.deepEqual([by.D5.destinationLabel, by.D5.destinationCode], ['—', null]);
});

test('aircraft model is carried when present; tzLabel appears only when the zones differ', () => {
  const v = view([fl({ aircraft: null }), fl({ aircraft: { model: 'B788', registration: null }, scheduledDep: NOW + H })]);
  assert.deepEqual(rowsOf(v).map((r) => r.aircraft), [null, 'B788']);
  assert.equal(v.tzLabel, null);
  const other = view([fl()], {}, { airportTz: 'Europe/London' });
  assert.match(other.tzLabel, /local at FRA \(UTC[+±−]/);
  assert.equal(other.tz, 'Europe/London');
  assert.equal(view([]).total, 0);
});

test('the view is frozen and exposes the fetch metadata', () => {
  const v = view([fl()], {}, { fetchedAt: NOW - 5 * M, fromCache: true });
  assert.ok(Object.isFrozen(v));
  assert.equal(v.fetchedAt, NOW - 5 * M);
  assert.equal(v.fromCache, true);
});
