// Radar airport and carriers: where the standby is served from (roster event, adjacent duty, base) and
// which carriers the list shows (the active airline pack's flight designators). Covers the roster adapter
// (window eventId/location), the pure model (radarAirport, radarCarriers, the client-side carrier filter)
// and the screen end to end: header wording, request query, cache/quota behaviour, and the single path
// shared by the Today and Calendar entry links. Airline and airport literals live in these tests only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { radarAirport, radarCarriers, buildRadarView, RADAR_INFER_HORIZON_MS, RADAR_MAX_CARRIERS } from '../src/model/radar.js';
import { airlineOf } from '../src/airlines/index.js';
import { radar, resetRadarUi, REFRESH_COOLDOWN_MS } from '../src/ui/screens/radar.js';
import { today } from '../src/ui/screens/today.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { loadDepartures, DEPARTURES_TTL_MS } from '../src/sources/departures-service.js';
import { createStore } from '../src/store.js';
import { PROFILE, pipeline } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600000;
const M = 60000;
const NOW_ISO = '2026-10-06T20:00:00Z';
const NOW = Date.parse(NOW_ISO);
const TZ = PROFILE.homeTz;
const GENERIC_PROFILE = { ...PROFILE, airlineId: 'generic' };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetRadarUi());

// ---------- synthetic roster ----------

const SB_START = NOW - 3 * H;
const SB_END = NOW + 6 * H;

/** A fc.roster v2 payload: FRA-based crew, SB90 standby, next duty checks in at BER and flies BER-FRA. */
function payloadV2({ standbyLocation = null, withNextDuty = true, previous = false, windowEventId = 'e_sb' } = {}) {
  const sectors = [];
  const events = [{ id: 'e_sb', kind: 'standby', subtype: null, code: 'SB90', title: 'SB90', start: SB_START, end: SB_END, location: standbyLocation, protected: false, provenance: 'source', basis: 'airline-feed' }];
  const duties = [];
  if (previous) {
    sectors.push({ id: 's_prev', eventId: 'e_prev', flightNumber: 'DE9001', origin: 'FRA', destination: 'BER', dep: NOW - 12 * H, arr: NOW - 10 * H, originTz: TZ, destTz: TZ, blockMin: 120, provenance: 'source' });
  }
  if (withNextDuty) {
    events.push({ id: 'e_ci', kind: 'checkin', subtype: null, code: 'C/I', title: 'C/I', start: NOW + 9 * H, end: NOW + 10 * H, location: 'BER', protected: false, provenance: 'source', basis: 'airline-feed' });
    sectors.push({ id: 's_next', eventId: 'e_next', flightNumber: 'DE4094', origin: 'BER', destination: 'FRA', dep: NOW + 10 * H, arr: NOW + 11.5 * H, originTz: TZ, destTz: TZ, blockMin: 90, provenance: 'source' });
    duties.push({ id: 'd_next', kind: 'flight', sectorIds: ['s_next'], report: { at: NOW + 9 * H, eventId: 'e_ci', provenance: 'source', association: 'derived' }, pickup: null, start: NOW + 9 * H, end: NOW + 11.5 * H, provenance: 'derived' });
  }
  return {
    ok: true, contract: 'fc.roster', version: 2, action: 'roster', generatedAt: NOW,
    coverage: { from: '2026-10-01', to: '2026-10-31', lastRosteredDate: '2026-10-08', days: [] },
    events, sectors, duties,
    windows: [{ kind: 'standby', code: 'SB90', start: SB_START, end: SB_END, eventId: windowEventId, provenance: 'source' }],
    stays: [], warnings: [],
  };
}
const snapshotOf = (opts, profile = PROFILE) => adaptV2(payloadV2(opts), { profile, fetchedAt: NOW });

// ---------- adapter ----------

test('adaptV2: a standby window keeps its event id and the IATA location of that event', () => {
  const w = snapshotOf({ standbyLocation: 'BER' }).windows.find((x) => x.kind === 'standby');
  assert.equal(w.eventId, 'e_sb');
  assert.equal(w.location, 'BER');
  assert.equal(w.label, 'SB90');
  assert.equal(w.provenance, 'source');
});

test('adaptV2: a missing, non-IATA or unlinked location becomes null', () => {
  const find = (opts) => snapshotOf(opts).windows.find((x) => x.kind === 'standby');
  assert.equal(find({ standbyLocation: null }).location, null);
  assert.equal(find({ standbyLocation: '' }).location, null);
  assert.equal(find({ standbyLocation: 'Berlin' }).location, null);
  assert.equal(find({ standbyLocation: 'ber' }).location, null);
  assert.equal(find({ standbyLocation: 'BERL' }).location, null);
  assert.equal(find({ standbyLocation: 42 }).location, null);
  // The window points at an event the payload does not carry: no location, the id is still kept.
  const unlinked = find({ standbyLocation: 'BER', windowEventId: 'e_gone' });
  assert.equal(unlinked.location, null);
  assert.equal(unlinked.eventId, 'e_gone');
  // No event id at all.
  const p = payloadV2({ standbyLocation: 'BER' });
  delete p.windows[0].eventId;
  const w = adaptV2(p, { profile: PROFILE, fetchedAt: NOW }).windows.find((x) => x.kind === 'standby');
  assert.equal(w.eventId, null);
  assert.equal(w.location, null);
});

test('adaptV2: the new window fields are additive (the rest of the window is unchanged)', () => {
  const w = snapshotOf({ standbyLocation: 'BER' }).windows.find((x) => x.kind === 'standby');
  assert.deepEqual(w, { kind: 'standby', start: SB_START, end: SB_END, label: 'SB90', provenance: 'source', eventId: 'e_sb', location: 'BER' });
});

// ---------- radarAirport ----------

const T = Date.parse('2026-10-10T10:00:00Z');
const win = (over = {}) => ({ kind: 'standby', start: T, end: T + 8 * H, label: 'SB90', ...over });
let seq = 0;
const sec = (origin, destination, dep, blockMin = 90) => ({ id: `s${(seq += 1)}`, flightNumber: `XX${seq}`, origin, destination, dep, arr: dep + blockMin * M, blockMin, pickup: null, report: null, provenance: 'source' });
const snap = (...sectors) => ({ sectors, windows: [] });
const FRA_PROFILE = { ...PROFILE, base: 'FRA' };

test('radarAirport: the explicit roster location of the window always wins, even against adjacent duties', () => {
  const s = snap(sec('MUC', 'HAM', T - 5 * H), sec('DUS', 'HAM', T + 9 * H));
  assert.deepEqual(radarAirport(win({ location: 'BER' }), s, FRA_PROFILE), { airport: 'BER', basis: 'roster' });
  assert.deepEqual(radarAirport(win({ location: 'BER' }), null, FRA_PROFILE), { airport: 'BER', basis: 'roster' });
  // Not an IATA code: not a roster statement.
  assert.equal(radarAirport(win({ location: 'ber' }), s, FRA_PROFILE).basis, 'inferred-next');
  assert.equal(radarAirport(win({ location: null }), s, FRA_PROFILE).basis, 'inferred-next');
});

test('radarAirport: the next duty origin, when no flight sector departs in between; it beats the previous arrival', () => {
  const s = snap(sec('MUC', 'HAM', T - 5 * H), sec('BER', 'FRA', T + 12 * H), sec('FRA', 'LHR', T + 14 * H));
  assert.deepEqual(radarAirport(win(), s, FRA_PROFILE), { airport: 'BER', basis: 'inferred-next' });
});

test('radarAirport: a flight sector departing between the window and the next duty skips the next rule', () => {
  // A duty that starts during the standby (two sectors, the second after the window end), then the next duty.
  const during = [sec('MUC', 'HAM', T + 7 * H), sec('HAM', 'NUE', T + 10 * H)];
  const next = sec('BER', 'FRA', T + 20 * H);
  assert.deepEqual(radarAirport(win(), snap(...during, next), FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  // With an earlier arrival, the previous rule answers instead.
  const prev = sec('DUS', 'HAM', T - 6 * H);
  assert.deepEqual(radarAirport(win(), snap(prev, ...during, next), FRA_PROFILE), { airport: 'HAM', basis: 'inferred-previous' });
  // A sector departing inside the window blocks the next rule too.
  const inside = sec('MUC', 'HAM', T + 2 * H);
  assert.equal(radarAirport(win(), snap(inside, next), FRA_PROFILE).basis, 'base');
});

test('radarAirport: without a next duty within 48 h, the arrival of the last previous sector is used', () => {
  const prev = sec('FRA', 'BER', T - 9 * H);
  const farNext = sec('MUC', 'FRA', T + 8 * H + 49 * H);
  assert.deepEqual(radarAirport(win(), snap(prev, farNext), FRA_PROFILE), { airport: 'BER', basis: 'inferred-previous' });
  assert.deepEqual(radarAirport(win(), snap(prev), FRA_PROFILE), { airport: 'BER', basis: 'inferred-previous' });
  // Several previous sectors: the last one by departure.
  const earlier = sec('FRA', 'MUC', T - 20 * H);
  assert.equal(radarAirport(win(), snap(earlier, prev), FRA_PROFILE).airport, 'BER');
});

test('radarAirport: the 48 h reliability horizon (inclusive) on both sides, then the base', () => {
  assert.equal(RADAR_INFER_HORIZON_MS, 48 * H);
  const w = win();
  const nextAt = (offset) => snap(sec('BER', 'FRA', w.end + offset));
  assert.equal(radarAirport(w, nextAt(RADAR_INFER_HORIZON_MS), FRA_PROFILE).basis, 'inferred-next');
  assert.deepEqual(radarAirport(w, nextAt(RADAR_INFER_HORIZON_MS + 1), FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  // Previous: arrival exactly 48 h before the start is still fine, 1 ms more is not.
  const arrivingAt = (before) => { const s = sec('FRA', 'BER', w.start - before - 90 * M); s.arr = w.start - before; return snap(s); };
  assert.equal(radarAirport(w, arrivingAt(RADAR_INFER_HORIZON_MS), FRA_PROFILE).basis, 'inferred-previous');
  assert.deepEqual(radarAirport(w, arrivingAt(RADAR_INFER_HORIZON_MS + 1), FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  // Both beyond the horizon.
  assert.equal(radarAirport(w, snap(sec('FRA', 'BER', w.start - 60 * H), sec('BER', 'FRA', w.end + 60 * H)), FRA_PROFILE).basis, 'base');
});

test('radarAirport: a sector still in the air at the window start is not a reliable previous arrival', () => {
  const w = win();
  assert.equal(radarAirport(w, snap(sec('FRA', 'BER', w.start - 30 * M, 120)), FRA_PROFILE).basis, 'base');
});

test('radarAirport: no sectors, no snapshot or unusable sectors give the profile base, labelled base', () => {
  assert.deepEqual(radarAirport(win(), snap(), FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  assert.deepEqual(radarAirport(win(), null, FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  assert.deepEqual(radarAirport(win(), { windows: [] }, FRA_PROFILE), { airport: 'FRA', basis: 'base' });
  const junk = [{ ...sec('MUC', 'HAM', T + 9 * H), origin: 'EAST' }, { ...sec('MUC', 'HAM', T - 9 * H), destination: null }];
  assert.equal(radarAirport(win(), snap(...junk), FRA_PROFILE).basis, 'base');
  assert.deepEqual(radarAirport(win(), snap(), { ...PROFILE, base: 'MUC' }), { airport: 'MUC', basis: 'base' });
});

test('radarAirport: overnight windows and a clock change work on instants', () => {
  const berlinNight = Date.parse('2026-10-24T20:00:00Z');                 // 22:00 local, the night clocks go back
  const w = { kind: 'standby', start: berlinNight, end: berlinNight + 10 * H };
  assert.deepEqual(radarAirport(w, snap(sec('BER', 'FRA', berlinNight + 12 * H)), FRA_PROFILE), { airport: 'BER', basis: 'inferred-next' });
  assert.deepEqual(radarAirport(w, snap(sec('FRA', 'BER', berlinNight - 8 * H)), FRA_PROFILE), { airport: 'BER', basis: 'inferred-previous' });
});

test('radarAirport: derived from the adapter snapshot of a real-shaped payload (check-in at BER, first sector from BER)', () => {
  const s = snapshotOf({ standbyLocation: null });
  const w = s.windows.find((x) => x.kind === 'standby');
  assert.deepEqual(radarAirport(w, s, PROFILE), { airport: 'BER', basis: 'inferred-next' });
  const explicit = snapshotOf({ standbyLocation: 'MUC' });
  assert.deepEqual(radarAirport(explicit.windows.find((x) => x.kind === 'standby'), explicit, PROFILE), { airport: 'MUC', basis: 'roster' });
});

// ---------- radarCarriers ----------

test('radarCarriers: the pack designators, deduplicated, or null without any', () => {
  assert.deepEqual(radarCarriers(airlineOf(PROFILE)), ['DE']);
  assert.deepEqual(radarCarriers({ flightDesignators: ['AA', 'BB'] }), ['AA', 'BB']);
  assert.deepEqual(radarCarriers({ flightDesignators: ['AA', 'AA', 'BB'] }), ['AA', 'BB']);
  assert.equal(radarCarriers(airlineOf(GENERIC_PROFILE)), null);
  assert.equal(radarCarriers({ flightDesignators: [] }), null);
  assert.equal(radarCarriers({}), null);
  assert.equal(radarCarriers(null), null);
  assert.equal(radarCarriers({ flightDesignators: ['', 'x', 'ABC', 7] }), null, 'malformed designators are not a filter');
});

test('radarCarriers: a fresh mutable array, capped at what the backend accepts', () => {
  const pack = airlineOf(PROFILE);
  const out = radarCarriers(pack);
  assert.notEqual(out, pack.flightDesignators);
  assert.equal(Object.isFrozen(out), false);
  const many = Array.from({ length: 14 }, (_, i) => `A${String.fromCharCode(65 + i)}`);
  assert.equal(RADAR_MAX_CARRIERS, 10);
  assert.deepEqual(radarCarriers({ flightDesignators: many }), many.slice(0, 10));
});

// ---------- buildRadarView: defensive carrier filter ----------

const F = (n, carrier, over = {}) => ({
  id: `f_${String(n).padStart(16, '0')}`, flightNumber: `${carrier ?? 'ZZ'}${n}`, carrier, origin: 'BER', destination: 'FRA', destinationName: 'Frankfurt',
  scheduledDep: NOW + n * 10 * M, revisedDep: null, status: 'scheduled', aircraft: null, originTz: TZ, destTz: null, provenance: 'provider', ...over,
});
const result = (flights) => ({ airport: 'BER', airportTz: TZ, from: SB_START, to: SB_END, carriers: null, provider: 'x', fetchedAt: NOW, generatedAt: NOW, dropped: 0, flights, fromCache: false });
const MIXED = [F(1, 'DE'), F(2, 'LH'), F(3, 'EW'), F(4, 'DE', { status: 'cancelled' }), F(5, 'X3'), F(6, 'LH', { status: 'delayed', revisedDep: NOW + 6 * 10 * M + 25 * M }), F(7, 'FR'), F(8, null)];
const rowsOf = (rv) => [...rv.earlier, ...rv.groups.flatMap((g) => g.rows)];

test('buildRadarView: with carriers set only rows of those carriers remain (unknown carriers too); without, all rows', () => {
  const win0 = { start: SB_START, end: SB_END };
  const filtered = buildRadarView(result(MIXED), { now: NOW, window: win0, carriers: ['DE'], homeTz: TZ });
  assert.deepEqual(rowsOf(filtered).map((r) => r.flightNumber), ['DE1', 'DE4']);
  assert.equal(filtered.total, 2);
  const both = buildRadarView(result(MIXED), { now: NOW, window: win0, carriers: ['DE', 'LH'], homeTz: TZ });
  assert.deepEqual(rowsOf(both).map((r) => r.flightNumber), ['DE1', 'LH2', 'DE4', 'LH6']);
  for (const carriers of [null, undefined, []]) {
    assert.equal(buildRadarView(result(MIXED), { now: NOW, window: win0, carriers, homeTz: TZ }).total, MIXED.length);
  }
});

// ---------- the screen ----------

function fakeRoot() {
  const handlers = {};
  return {
    innerHTML: '',
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] ?? []).filter((f) => f !== fn); },
    querySelector: () => null,
    press(selector) {
      const target = { closest: (s) => (s.includes(selector) ? { disabled: false } : null) };
      for (const fn of handlers.click ?? []) fn({ target });
    },
  };
}

/** The view a screen gets from the controller, for a snapshot at NOW. */
function viewFor(snapshot, profile = PROFILE) {
  return { ...pipeline(snapshot, NOW_ISO, profile), snapshot, profile, review: false, loading: false, error: null };
}

/** A radar ctx over `view` with a recording loader; go() renders and mounts the way main.js does. */
function radarHarness(view, { param = null, load = null } = {}) {
  const t = { now: view.now };
  const calls = [];
  const root = fakeRoot();
  let cleanup = null;
  let markup = '';
  let current = view;
  const ctx = {
    view: () => ({ ...current, now: t.now }),
    param: () => param,
    departuresAccess: () => 'ready',
    loadDepartures: (query, opts) => { calls.push({ query, opts }); return load ? load(query, opts, calls.length) : Promise.resolve(serverFiltered(query)); },
    rerender: () => draw({ quiet: true }),
  };
  function draw(opts = {}) { cleanup?.(); markup = radar.render(ctx).toString(); cleanup = radar.mount(root, ctx, opts); }
  return {
    ctx, calls, root, t,
    go: () => { draw(); return markup; },
    markup: () => markup,
    update: () => radar.update(root, ctx),
    leave: () => { cleanup?.(); cleanup = null; },
    setView: (v) => { current = v; },
    setParam: (p) => { param = p; },
  };
}

/** What the backend returns after its server-side carrier filter. */
function serverFiltered(query, flights = MIXED) {
  const kept = flights.filter((f) => !query.carriers || query.carriers.includes(f.carrier));
  return { ...result(kept), airport: query.airport, from: query.from, to: query.to, carriers: query.carriers };
}

const flightsShown = (markup) => (markup.match(/class="rd-flight t-code">(?:<span[^>]*><\/span>)?([A-Z0-9]+)</g) ?? []).map((m) => m.replace(/.*>([A-Z0-9]+)<$/, '$1'));

const standbyRows = (markup) => flightsShown(markup);

test('MAIN: FRA crew on an SB90 standby at BER, Condor pack, mixed carriers: BER and DE only, labelled as inferred', async () => {
  const view = viewFor(snapshotOf({ standbyLocation: null }));
  assert.equal(view.state.status, 'standby', 'precondition: the synthetic roster is on a standby at NOW');
  const h = radarHarness(view);
  const first = h.go();
  assert.deepEqual(h.calls.map((c) => c.query), [{ airport: 'BER', from: SB_START, to: SB_END, carriers: ['DE'] }]);
  assert.match(first, /Departures from BER · Condor flights \(from your next duty\)/);
  await tick();
  const m = h.markup();
  assert.match(m, /Departures from BER · Condor flights \(from your next duty\)/);
  assert.deepEqual(standbyRows(m), ['DE1', 'DE4']);
  assert.doesNotMatch(m, /LH2|EW3|X35|LH6|FR7/);
  assert.match(m, /rd-chip is-cancelled">Cancelled/, 'the cancelled DE row is listed, as a fact');
  assert.doesNotMatch(m, /rd-mark|Your airline/, 'every row is the user\'s airline: no emphasis dot');
});

test('MAIN: the delayed foreign flight never shows; a delayed own-airline flight keeps its revised time', async () => {
  const flights = [F(1, 'DE', { status: 'delayed', revisedDep: NOW + 10 * M + 20 * M }), F(2, 'LH', { status: 'delayed', revisedDep: NOW + 20 * M + 30 * M })];
  const h = radarHarness(viewFor(snapshotOf()), { load: (q) => Promise.resolve(serverFiltered(q, flights)) });
  h.go();
  await tick();
  assert.match(h.markup(), /DE1/);
  assert.match(h.markup(), /\+20 min/);
  assert.doesNotMatch(h.markup(), /LH2|\+30 min/);
});

test('MAIN: a loader that ignores the filter and returns mixed rows still shows only the pack carriers', async () => {
  const h = radarHarness(viewFor(snapshotOf()), { load: (q) => Promise.resolve({ ...result(MIXED), airport: q.airport, from: q.from, to: q.to }) });
  h.go();
  await tick();
  assert.deepEqual(standbyRows(h.markup()), ['DE1', 'DE4']);
  assert.doesNotMatch(h.markup(), /LH2|EW3|X35|LH6|FR7|ZZ8/);
});

test('MAIN: Today link and Calendar link open the identical plan (same window, same request)', async () => {
  const snapshot = snapshotOf({ standbyLocation: null });
  const view = viewFor(snapshot);
  const todayOut = today.render({ view: () => view, weather: () => null }).toString();
  const todayHref = todayOut.match(/href="(#\/radar\/\d+)"/)?.[1];
  resetCalendarUi('2026-10', '2026-10-06');
  const calOut = calendar.render({ view: () => view }).toString();
  const calHref = calOut.match(/href="(#\/radar\/\d+)"[^>]*data-cal-radar/)?.[1];
  assert.ok(todayHref, 'Today links to the Radar');
  assert.ok(calHref, 'Calendar links to the Radar');
  assert.equal(todayHref, calHref);
  const param = todayHref.split('/').pop();

  const seen = [];
  for (const entry of ['today', 'calendar']) {
    resetRadarUi();
    const h = radarHarness(view, { param });
    const m = h.go();
    await tick();
    seen.push({ entry, query: h.calls[0].query, calls: h.calls.length, header: m.match(/Departures from [^<]*/)?.[0], rows: standbyRows(h.markup()) });
    h.leave();
  }
  assert.deepEqual(seen[0].query, { airport: 'BER', from: SB_START, to: SB_END, carriers: ['DE'] });
  assert.deepEqual(seen[0].query, seen[1].query);
  assert.deepEqual([seen[0].calls, seen[1].calls], [1, 1]);
  assert.equal(seen[0].header, seen[1].header);
  assert.match(seen[0].header, /Departures from BER · Condor flights \(from your next duty\)/);
  assert.deepEqual(seen[0].rows, ['DE1', 'DE4']);
  assert.deepEqual(seen[1].rows, ['DE1', 'DE4']);
});

test('roster basis: the standby event states the airport itself; no "(from …)" note, and it wins over the adjacent duty', async () => {
  const view = viewFor(snapshotOf({ standbyLocation: 'BER' }));
  const h = radarHarness(view);
  const m = h.go();
  assert.deepEqual(h.calls[0].query, { airport: 'BER', from: SB_START, to: SB_END, carriers: ['DE'] });
  assert.match(m, /Departures from BER · Condor flights/);
  assert.doesNotMatch(m, /\(from your|\(your base/);
  // Against a different adjacent duty the stated airport still wins.
  resetRadarUi();
  const other = radarHarness(viewFor(snapshotOf({ standbyLocation: 'MUC' })));
  other.go();
  assert.equal(other.calls[0].query.airport, 'MUC');
  assert.doesNotMatch(other.markup(), /\(from your|\(your base/);
});

test('previous-flight basis: no next duty, the positioning flight arrived at BER', () => {
  const h = radarHarness(viewFor(snapshotOf({ withNextDuty: false, previous: true })));
  const m = h.go();
  assert.equal(h.calls[0].query.airport, 'BER');
  assert.match(m, /Departures from BER · Condor flights \(from your previous flight\)/);
});

test('base fallback: no location and no usable neighbour: the base, said clearly', () => {
  const h = radarHarness(viewFor(snapshotOf({ withNextDuty: false })));
  const m = h.go();
  assert.deepEqual(h.calls[0].query, { airport: 'FRA', from: SB_START, to: SB_END, carriers: ['DE'] });
  assert.match(m, /Departures from FRA · Condor flights \(your base · the roster gives no standby location\)/);
});

test('generic pack: no carrier filter, "All carriers", every row shown, no emphasis mark', async () => {
  const view = viewFor(snapshotOf({ standbyLocation: null }, GENERIC_PROFILE), GENERIC_PROFILE);
  const h = radarHarness(view);
  const m = h.go();
  assert.deepEqual(h.calls[0].query, { airport: 'BER', from: SB_START, to: SB_END, carriers: null });
  assert.match(m, /Departures from BER · All carriers \(from your next duty\)/);
  await tick();
  assert.equal(standbyRows(h.markup()).length, MIXED.length);
  assert.doesNotMatch(h.markup(), /rd-mark|Your airline/);
  assert.doesNotMatch(h.markup(), /Condor flights/);
});

test('empty state names the pack carrier; the all-carriers fallback keeps the original sentence', async () => {
  const empty = (q) => Promise.resolve(serverFiltered(q, []));
  const h = radarHarness(viewFor(snapshotOf()), { load: empty });
  h.go();
  await tick();
  assert.match(h.markup(), /No Condor departures from BER are scheduled in this window\./);
  resetRadarUi();
  const g = radarHarness(viewFor(snapshotOf({}, GENERIC_PROFILE), GENERIC_PROFILE), { load: empty });
  g.go();
  await tick();
  assert.match(g.markup(), /No departures from BER are scheduled in this window\./);
  // The filter can also empty a list the provider filled (client-side twin).
  resetRadarUi();
  const foreign = radarHarness(viewFor(snapshotOf()), { load: (q) => Promise.resolve({ ...result([F(1, 'LH')]), airport: q.airport, from: q.from, to: q.to }) });
  foreign.go();
  await tick();
  assert.match(foreign.markup(), /No Condor departures from BER are scheduled in this window\./);
});

test('the ended, too-far and too-long states carry the same header and request nothing', () => {
  const header = /Departures from BER · Condor flights \(from your next duty\)/;
  const param = String(SB_START);
  const ended = radarHarness({ ...viewFor(snapshotOf()), now: SB_END + H }, { param });
  const endedOut = ended.go();
  assert.match(endedOut, /This standby window has ended\./);
  assert.match(endedOut, header);
  const farView = viewFor(snapshotOf());
  const far = radarHarness({ ...farView, now: SB_START - 15 * 24 * H }, { param });
  const farOut = far.go();
  assert.match(farOut, /Schedules are available from/);
  assert.match(farOut, /Departures from (?:BER|FRA) · Condor flights/);
  const long = viewFor(snapshotOf());
  long.snapshot.windows[0].end = SB_START + 30 * H;
  const tooLong = radarHarness(long, { param });
  const longOut = tooLong.go();
  assert.match(longOut, /longer than 24 hours/);
  assert.match(longOut, /Departures from (?:BER|FRA) · Condor flights/);
  for (const h of [ended, far, tooLong]) assert.equal(h.calls.length, 0);
});

// ---------- cache, cooldown, key ----------

/** Real loadDepartures with a device cache and a counting fake backend that honours `carriers`. */
function cachedHarness(view) {
  const fx = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/departures-v2.synthetic.json'), 'utf8'));
  const data = new Map();
  const store = createStore({ getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), key: (i) => [...data.keys()][i] ?? null, get length() { return data.size; } });
  const net = [];
  const api = {
    postContract: async (endpoint, body) => {
      net.push(body);
      const p = structuredClone(fx);
      const flights = MIXED.filter((f) => !body.carriers || body.carriers.includes(f.carrier)).filter((f) => f.carrier);
      Object.assign(p, { airport: body.airport, from: body.from, to: body.to, carriers: body.carriers ?? null, fetchedAt: h.t.now, generatedAt: h.t.now });
      p.flights = flights.map((f, i) => ({ ...fx.flights[0], id: `f_${String(i + 1).padStart(16, '0')}`, flightNumber: f.flightNumber, carrier: f.carrier, origin: body.airport, destination: 'FRA', scheduledDep: f.scheduledDep, revisedDep: null, status: 'scheduled' }));
      return { data: p, meta: {} };
    },
  };
  const h = radarHarness(view, { load: (q, o) => loadDepartures({ ...q, endpoint: `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`, token: 'test-token-0123456789abcdef' }, { api, store, now: () => h.t.now, force: o.force }) });
  return { h, net };
}

test('quota: the filtered request is one call carrying carriers; reopening within 5 minutes costs no network call', async () => {
  const { h, net } = cachedHarness(viewFor(snapshotOf()));
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1);
  assert.equal(net[0].airport, 'BER');
  assert.deepEqual(net[0].carriers, ['DE']);
  assert.deepEqual(standbyRows(h.markup()), ['DE1', 'DE4']);
  h.t.now += DEPARTURES_TTL_MS - 1000;
  h.leave();
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1, 'device cache hit');
  assert.match(h.markup(), /\(cached\)/);
  h.update(); h.t.now += 500; h.update();
  await tick();
  assert.equal(net.length, 1);
});

test('cooldown: Refresh sends one forced load for the airport + carriers key and rests 30 s', async () => {
  const { h, net } = cachedHarness(viewFor(snapshotOf()));
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1);
  h.root.press('[data-rd-refresh]');
  await tick(); await tick();
  assert.equal(net.length, 2, 'Refresh is forced past the device cache');
  assert.deepEqual(net[1].carriers, ['DE']);
  h.root.press('[data-rd-refresh]');
  h.t.now += REFRESH_COOLDOWN_MS - 1000;
  h.root.press('[data-rd-refresh]');
  await tick(); await tick();
  assert.equal(net.length, 2, 'no further request inside the pause');
  h.t.now += 1000;
  h.root.press('[data-rd-refresh]');
  await tick(); await tick();
  assert.equal(net.length, 3);
});

test('key: another carrier set is another key; unchanged keys reuse their session', async () => {
  const { h, net } = cachedHarness(viewFor(snapshotOf()));
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1);
  h.update(); h.update();
  await tick();
  assert.equal(net.length, 1, 'same key: no new request on controller ticks');
  // The same window under a pack without designators: a different key, asked once, with carriers null.
  h.setView(viewFor(snapshotOf({}, GENERIC_PROFILE), GENERIC_PROFILE));
  h.update();
  await tick(); await tick();
  assert.equal(net.length, 2);
  assert.equal(net[1].carriers ?? null, null);
  assert.match(h.markup(), /All carriers/);
  assert.equal(standbyRows(h.markup()).length, MIXED.filter((f) => f.carrier).length);
  h.update();
  await tick();
  assert.equal(net.length, 2);
  // Another airport is another key too (the standby event states MUC).
  h.setView(viewFor(snapshotOf({ standbyLocation: 'MUC' })));
  h.update();
  await tick(); await tick();
  assert.equal(net.length, 3);
  assert.equal(net[2].airport, 'MUC');
  assert.deepEqual(net[2].carriers, ['DE']);
});

// ---------- repo scans ----------

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('no airport, airline or designator literal in the Radar screen and model', () => {
  for (const file of ['src/ui/screens/radar.js', 'src/model/radar.js']) {
    const text = read(file);
    for (const re of [/\bBER\b/, /\bFRA\b/, /'DE'/, /"DE"/, /Condor/i]) {
      assert.doesNotMatch(text, re, `${file}: ${re}`);
    }
  }
});

test('one path decides the Radar airport and carriers: only plan() in the screen; Today and Calendar just link', () => {
  const screen = read('src/ui/screens/radar.js');
  assert.equal((screen.match(/radarAirport\(/g) ?? []).length, 1, 'one call site');
  assert.equal((screen.match(/radarCarriers\(/g) ?? []).length, 1, 'one call site');
  assert.doesNotMatch(screen, /departuresContext|profile\.base|homeBases/);
  assert.match(screen, /key: `\$\{mode\}\|\$\{airport\}\|\$\{carriers\?\.join\(','\) \?\? '\*'\}\|\$\{from\}\|\$\{to\}`/);
  for (const file of ['src/ui/screens/today.js', 'src/ui/screens/calendar.js']) {
    const text = read(file);
    assert.doesNotMatch(text, /radarAirport|radarCarriers|departuresContext/, file);
    assert.match(text, /hrefFor\('radar', String\([\w.]+\.start\)\)/, `${file}: links by window start only`);
  }
});
