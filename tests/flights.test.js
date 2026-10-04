// Flights (Phase 6): journeys built on the shared roster model, the honest list boundary,
// stays, destination layers, "Seen on this device", and the rendered screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlights, defaultSector } from '../src/model/flights.js';
import { sampleSnapshot, sampleProfile } from '../src/sources/sample.js';
import { flights as screen } from '../src/ui/screens/flights.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

const NOW = '2026-10-04T06:00:00Z';
const SP = sampleProfile(PROFILE);

function model(snapshot, iso = NOW, profile = PROFILE) {
  const { now, roster, state } = pipeline(snapshot, iso, profile);
  return { f: buildFlights(snapshot, roster, state, profile, now), roster, now, state };
}

function sample(state, variant = null, iso = NOW) {
  return sampleSnapshot(state, 'ocean', at(iso), SP, variant);
}

function render(snapshot, { iso = NOW, profile = PROFILE, param = null, review = false, weather = null } = {}) {
  const v = pipeline(snapshot, iso, profile);
  const view = { ...v, profile, snapshot, review, loading: false, error: null };
  return screen.render({ view: () => view, param: () => param, weather: weather ?? (() => ({ status: 'unavailable', reason: 'no-destination' })) }).toString();
}

test('journeys are the roster rotations (no second rotation engine), each sector exactly once', () => {
  const fx = fixtureSnapshot();
  const { f, roster } = model(fx);
  assert.deepEqual(f.upcoming.map((r) => r.id), roster.rotations.map((r) => r.id));
  const ids = f.upcoming.flatMap((r) => r.sectors.map((e) => e.sector.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, fx.sectors.length);
  assert.deepEqual(f.upcoming[0].route, ['FRA', 'YYZ', 'FRA']);
});

test('V5 five-flight boundary: stated calmly with the limit from the adapter', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  assert.equal(f.boundary.kind, 'truncated');
  assert.equal(f.boundary.limit, 5);
  assert.equal(f.boundary.through, fx.flightCoverageEnd);
  const html = render(fx);
  assert.match(html, /End of the listed flights/);
  assert.match(html, /shares its next 5 flights at a time/);
  assert.doesNotMatch(html, /error|failed/i);
  // Not truncated: the window it lists is stated instead.
  const short = fixtureSnapshot((p) => { p.upcoming = p.upcoming.slice(0, 2); });
  assert.equal(model(short).f.boundary.kind, 'window');
  assert.match(render(short), /lists flights through/);
});

test('the last listed flight to an outstation: return not yet listed (open), never a guessed layover', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  const last = f.upcoming.at(-1);
  assert.equal(last.openEnd, true);
  const open = last.legs.find((l) => l.type === 'open');
  assert.ok(open);
  assert.equal(open.stay.to, null);
  assert.equal(last.sectors.at(-1).destination.stay.kind, 'open');
  assert.match(render(fx), /Return not yet listed/);
});

test('inferred vs confirmed layover: different line style class and words', () => {
  // The sample month: AWAY layover inferred (+4…+7), WEST layover stated by the roster (+21…+23).
  const snap = sample('off');
  const { f } = model(snap, NOW, SP);
  const stays = f.upcoming.flatMap((r) => r.legs.filter((l) => l.type === 'layover'));
  const away = stays.find((l) => l.airport === 'AWAY' && l.stay.from > at(NOW) + 3 * 86400000);
  const west = stays.find((l) => l.airport === 'WEST');
  assert.equal(away.stay.confidence, 'inferred');
  assert.equal(west.stay.confidence, 'confirmed');
  const html = render(snap, { profile: SP, review: true });
  assert.match(html, /jr-stay kind-layover is-inferred[\s\S]*?Layover · inferred/);
  assert.match(html, /jr-stay kind-layover is-confirmed[\s\S]*?Layover · from roster/);
});

test('multi-sector duty: one rotation, one duty, turnarounds between sectors, pickup once', () => {
  const snap = sample('off', 'multi');
  const { f } = model(snap, NOW, SP);
  const r = f.upcoming[0];
  assert.equal(r.sectorCount, 4);
  assert.equal(r.legs.filter((l) => l.type === 'duty').length, 1);
  assert.equal(r.legs.filter((l) => l.type === 'turn').length, 3);
  assert.deepEqual(r.route, ['HOME', 'EAST', 'HOME', 'SOUTH', 'HOME']);
  assert.ok(r.sectors[0].pickup !== null);
  assert.ok(r.sectors.slice(1).every((e) => e.pickup === null && e.wakeup === null));
  // The mid-duty home turnaround has no destination layer; the outstations do.
  assert.equal(r.sectors[1].destination, null);
  assert.equal(r.sectors[0].destination.stay.kind, 'turn');
  assert.equal(r.sectors[0].destination.hotel, null);
});

test('home-base sector detail shows no destination, layover or hotel UI', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  const inbound = f.upcoming[0].sectors[1]; // YYZ → FRA
  assert.equal(inbound.destination, null);
  const html = render(fx, { param: inbound.sector.id });
  const detail = html.slice(html.indexOf('data-fl-detail'));
  assert.doesNotMatch(detail, /Destination|Hotel|Layover ·/);
  const outbound = render(fx, { param: f.upcoming[0].sectors[0].sector.id });
  assert.match(outbound.slice(outbound.indexOf('data-fl-detail')), /Destination[\s\S]*Toronto[\s\S]*Layover · inferred[\s\S]*Not provided by your roster source/);
});

test('incomplete/UNKNOWN data: unknown zone in UTC, no pickup stated, return beyond the list', () => {
  const snap = sample('off', 'incomplete');
  const { f } = model(snap, NOW, SP);
  assert.equal(f.boundary.kind, 'truncated');
  const north = f.upcoming[0].sectors[0];
  assert.equal(north.sector.destTz, null);
  assert.equal(north.destination.tz, null);
  assert.equal(north.destination.weather.reason, 'no-timezone');
  const html = render(snap, { profile: SP, review: true, param: north.sector.id });
  assert.match(html, /UTC/);
  assert.match(html, /No pickup listed for this duty/);
  assert.match(html, /Time zone unknown/);
  assert.match(html, /End of the listed flights/);
  assert.match(html, /Return not yet listed/);
});

test('"Seen on this device": flown rotations only, newest first, remembered vs current source', () => {
  const snap = sample('off', 'history');
  const { f } = model(snap, NOW, SP);
  assert.ok(f.recent.count >= 8);
  assert.ok(f.recent.remembered >= 6);
  const rots = f.recent.months.flatMap((m) => m.rotations);
  assert.ok(rots.every((r, i) => i === 0 || r.start <= rots[i - 1].start), 'newest first');
  assert.equal(rots[0].provenance, 'source');
  assert.ok(rots.slice(1).every((r) => r.provenance === 'history'));
  assert.ok(f.upcoming.every((r) => r.status !== 'past'), 'upcoming never contains flown rotations');
  const html = render(snap, { profile: SP, review: true });
  assert.ok(html.indexOf('fl-upcoming') < html.indexOf('fl-recent'), 'upcoming before remembered history');
  assert.match(html, /Seen on this device/);
  assert.match(html, /Not a complete flight history/);
  assert.match(html, /tag-source">Current roster/);
  assert.match(html, /tag-remembered">Remembered/);
  const rememberedId = rots[1].sectors[0].sector.id;
  const detail = render(snap, { profile: SP, review: true, param: rememberedId });
  assert.match(detail, /Remembered on this device/);
  assert.match(detail, /Last seen in your roster/);
});

test('no remembered flights: the limitation is stated instead of an empty list', () => {
  const html = render(fixtureSnapshot());
  assert.match(html, /No earlier flights seen on this device yet/);
});

test('detail is per sector inside its rotation; unknown ids fall back calmly', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  const e = f.upcoming[0].sectors[0];
  const html = render(fx, { param: e.sector.id });
  assert.match(html, /fl-layout is-explicit/);
  assert.match(html, /Flight 1 of 2 in this rotation/);
  assert.match(html, /Rotation · day 1 of 4/);
  assert.match(html, /aria-current="true"/);
  const missing = render(fx, { param: 'XX0000-1-2' });
  assert.match(missing, /no longer listed/);
  assert.doesNotMatch(missing, /fl-layout is-explicit/);
  assert.equal(defaultSector(f), e.sector.id);
});

test('timezone/DST: +1 day across zones and local arrival dates per airport', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  const bkk = f.upcoming.at(-1).sectors[0];
  assert.equal(bkk.sector.destTz, 'Asia/Bangkok');
  assert.equal(bkk.shift, 1);
  assert.match(render(fx, { param: bkk.sector.id }), /pass-shift">\+1/);
  // DXB rotation crosses the EU DST change (25 Oct): the difference from home is taken at arrival.
  const dxb = f.upcoming[1].sectors[0];
  assert.equal(dxb.destination.diffAtArrival, 180);
});

test('weather never blocks: provider states render as text, review uses samples only', () => {
  const fx = fixtureSnapshot();
  const { f } = model(fx);
  const id = f.upcoming[0].sectors[0].sector.id;
  const states = [
    { status: 'loading' }, { status: 'unavailable', reason: 'error' },
    { status: 'ok', date: '2026-10-10', max: 12, min: 4, text: 'Overcast', source: 'Open-Meteo' },
  ];
  const texts = [/Loading forecast/, /Forecast unavailable right now/, /Overcast · 12° \/ 4°[\s\S]*Open-Meteo/];
  states.forEach((w, i) => assert.match(render(fx, { param: id, weather: () => w }), texts[i]));
  assert.doesNotThrow(() => render(fx, { param: id, weather: () => null }));
});

test('review render: clearly synthetic, no external links for fictional places', () => {
  const html = render(sample('layover'), { profile: SP, review: true });
  assert.match(html, /Sample data · not your roster/);
  assert.doesNotMatch(html, /https:\/\//);
});

test('empty and loading states', () => {
  const view = { snapshot: null, loading: false, profile: PROFILE, now: at(NOW), review: false };
  assert.match(screen.render({ view: () => view, param: () => null }).toString(), /No roster source connected/);
  const loading = { ...view, loading: true };
  assert.match(screen.render({ view: () => loading, param: () => null }).toString(), /Loading roster/);
});

test('sample sector ids are unique and stable across rebuilds (deep links survive a reload)', () => {
  for (const state of ['off', 'flight', 'standby', 'reserve', 'layover']) {
    for (const variant of [null, 'multi', 'incomplete', 'history']) {
      const a = sampleSnapshot(state, 'ocean', at(NOW), SP, variant).sectors.map((s) => s.id);
      const b = sampleSnapshot(state, 'ocean', at(NOW) + 7 * 60000, SP, variant).sectors.map((s) => s.id);
      assert.equal(new Set(a).size, a.length, `${state}/${variant}`);
      assert.deepEqual(a, b);
    }
  }
});

test('regression: a remembered outbound with no return seen is an itinerary gap, never an ongoing stay', () => {
  const fx = fixtureSnapshot();
  const H = 3600000;
  const dep = at('2026-08-05T08:00:00Z');
  const jfk = { id: 'XQ1-a', flightNumber: 'XQ1', origin: 'FRA', destination: 'JFK', dep, arr: dep + 9 * H, blockMin: 540, originTz: 'Europe/Berlin', destTz: 'America/New_York', pickup: null, provenance: 'history', legacy: null };
  const snap = { ...fx, sectors: [jfk, ...fx.sectors] };
  const { f } = model(snap);
  const e = f.sectors.get('XQ1-a');
  assert.equal(e.stay.kind, 'gap');
  assert.equal(e.destination.stay.current, false);
  assert.equal(e.destination.hotel, null);
  assert.equal(e.destination.weather.reason, 'past', 'no weather request for a place left weeks ago');
  const html = render(snap, { param: 'XQ1-a' });
  assert.doesNotMatch(html, /Hotels in New York|My saved hotels|beyond the flights your roster source lists/);
  assert.match(html, /Return not seen/);
});

test('regression: an itinerary gap inside the source (arrive A, next departs B) is not a stay', () => {
  const gap = fixtureSnapshot((p) => { p.upcoming[1].origin = 'YUL'; });
  const { f } = model(gap, '2026-10-11T15:00:00Z');
  const yyz = [...f.sectors.values()].find((e) => e.sector.destination === 'YYZ');
  assert.equal(yyz.stay.kind, 'gap');
  assert.equal(yyz.stay.nextOrigin, 'YUL');
  assert.equal(yyz.destination.stay.current, false);
  assert.equal(yyz.destination.hotel, null);
});

test('regression: a payload without a flight list claims no coverage', () => {
  const none = fixtureSnapshot((p) => { delete p.upcoming; });
  assert.equal(none.flightCoverageEnd, null);
  const { f } = model(none);
  assert.equal(f.boundary.kind, 'missing');
  const html = render(none);
  assert.match(html, /No flight list in the last update/);
  assert.doesNotMatch(html, /lists flights through/);
});

test('remembered sectors are marked visibly inside a journey, not only for screen readers', () => {
  const fx = fixtureSnapshot();
  const first = fx.sectors[0];
  const snap = { ...fx, sectors: fx.sectors.map((s) => (s === first ? { ...s, provenance: 'history' } : s)) };
  const html = render(snap, { iso: '2026-10-10T20:00:00Z' });
  assert.match(html, /jr-sector is-[a-z]+ is-remembered[\s\S]*?tag-remembered jr-tag">Remembered/);
});

test('regression: a gap rotation never says "Return not yet listed" (note, line style, detail)', () => {
  const fx = fixtureSnapshot();
  const H = 3600000;
  const dep = at('2026-08-05T08:00:00Z');
  const jfk = { id: 'XQ1-a', flightNumber: 'XQ1', origin: 'FRA', destination: 'JFK', dep, arr: dep + 9 * H, blockMin: 540, originTz: 'Europe/Berlin', destTz: 'America/New_York', pickup: null, provenance: 'history', legacy: null };
  const snap = { ...fx, sectors: [jfk, ...fx.sectors] };
  const { f } = model(snap);
  const r = f.sectors.get('XQ1-a').journey;
  assert.equal(r.openEnd, false);
  assert.equal(r.gapEnd, true);
  const html = render(snap, { param: 'XQ1-a' });
  const detail = html.slice(html.indexOf('data-fl-detail'));
  assert.doesNotMatch(detail, /not yet listed/);
  assert.match(detail, /No return to base is seen in this rotation/);
});

test('regression: same airport beyond the 6-day limit reads "No layover inferred", not "departs YYZ"', () => {
  // Return from YYZ moved 8 days later: listed, but too long to infer a layover.
  const long = fixtureSnapshot((p) => { const r = p.upcoming[1]; r.depTimestamp += 6 * 86400000; r.endTimestamp += 6 * 86400000; });
  const { f } = model(long);
  const yyz = [...f.sectors.values()].find((e) => e.sector.destination === 'YYZ');
  assert.equal(yyz.stay.kind, 'gap');
  assert.equal(yyz.stay.reason, 'too-long');
  const html = render(long, { param: yyz.sector.id });
  assert.match(html, /No layover inferred[\s\S]*more than 6 days later/);
  assert.doesNotMatch(html, /Next listed flight departs YYZ|not yet listed by your roster source/);
});

test('regression: unknown origin zone → journey, mini list and timing all date the flight in UTC', () => {
  // Departs 23:00 UTC on 9 Oct (already 10 Oct at home): every date shown is the UTC one.
  const q = fixtureSnapshot((p) => { const s = p.upcoming[0]; s.origin = 'QQQ'; const len = s.endTimestamp - s.depTimestamp; s.depTimestamp = Date.parse('2026-10-09T23:00:00Z'); s.endTimestamp = s.depTimestamp + len; });
  const { f } = model(q);
  const e = [...f.sectors.values()].find((x) => x.sector.origin === 'QQQ');
  const html = render(q, { param: e.sector.id });
  assert.match(html, /23:00 UTC/);
  const detail = html.slice(html.indexOf('data-fl-detail'));
  const list = html.slice(0, html.indexOf('data-fl-detail'));
  assert.match(detail, /Fri 9 Oct · Flight 1/);
  assert.match(detail, /QQQ → YYZ[\s\S]*?Fri 9 Oct/, 'mini list');
  assert.match(list, /jr-day-date">Fri 9 Oct/);
  assert.match(list, /fl-rot-meta t-tabular">Fri 9 Oct/);
  assert.doesNotMatch(html, /QQQ 23:00 UTC[^<]*Sat 10 Oct/);
});

test('regression: a trip still waiting for its unlisted return stays in Upcoming, not in history', () => {
  const one = fixtureSnapshot((p) => { p.upcoming = p.upcoming.slice(0, 1); });
  const { f } = model(one, '2026-10-10T20:00:00Z');
  assert.equal(f.upcoming.length, 1);
  assert.equal(f.upcoming[0].openEnd, true);
  assert.equal(f.recent.count, 0);
  assert.doesNotMatch(render(one, { iso: '2026-10-10T20:00:00Z' }), /No upcoming flights listed/);
});

test('regression: the journey list never says "Back at" an outstation (gap and open trips)', () => {
  const gap = fixtureSnapshot((p) => { p.upcoming[1].origin = 'YUL'; });
  const html = render(gap);
  assert.doesNotMatch(html, /Back at <b>YYZ<\/b>/);
  assert.match(html, /Back at <b>FRA<\/b>/);
  const open = render(fixtureSnapshot());
  assert.doesNotMatch(open, /Back at <b>BKK<\/b>/);
});
