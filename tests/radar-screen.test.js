// Radar screen (read-only, slice 1): every state, request discipline, row order, entry links and
// the wording rules. Screens render to strings; mount() is driven with a minimal fake root.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { radar, resetRadarUi, errorText, TEXT, REFRESH_COOLDOWN_MS } from '../src/ui/screens/radar.js';
import { today } from '../src/ui/screens/today.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { DeparturesError } from '../src/sources/departures-service.js';
import { ApiError } from '../src/api/appscript.js';
import { sampleSnapshot, sampleProfile, sampleDepartures } from '../src/sources/sample.js';
import { normalizeProfile } from '../src/config/profile.js';
import { formatDate, formatTime, localDateKey, addDays } from '../src/lib/time.js';
import { airlineOf } from '../src/airlines/index.js';
import { PROFILE, pipeline } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600000;
const M = 60000;
const D = 24 * H;
const NOW = Date.parse('2026-10-06T20:00:00Z');
const HOME_TZ = PROFILE.homeTz;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sb = (start, end, label = 'SB90') => ({ kind: 'standby', start, end, label });
const ACTIVE = sb(NOW - 3 * H, NOW + 6 * H);

beforeEach(() => resetRadarUi());

// ---------- harness ----------

function flight(over = {}) {
  return {
    id: 'f_0000000000000001', flightNumber: 'XX100', carrier: 'ZZ', origin: 'FRA', destination: 'LHR', destinationName: 'London Heathrow',
    scheduledDep: NOW + H, revisedDep: null, status: 'scheduled', aircraft: { model: 'A320', registration: null }, originTz: HOME_TZ, destTz: null, provenance: 'provider', ...over,
  };
}
const resultFor = (q, flights, over = {}) => ({
  airport: q.airport, airportTz: HOME_TZ, from: q.from, to: q.to, carriers: null, provider: 'x', fetchedAt: NOW - 2 * M, generatedAt: NOW, dropped: 0, flights, fromCache: false, ...over,
});

function fakeRoot() {
  const handlers = {};
  return {
    innerHTML: '',
    addEventListener(type, fn) { (handlers[type] ??= []).push(fn); },
    removeEventListener(type, fn) { handlers[type] = (handlers[type] ?? []).filter((f) => f !== fn); },
    querySelector: () => null,
    toggle(open) { for (const fn of handlers.toggle ?? []) fn({ target: { matches: (sel) => sel === '[data-rd-earlier]', open } }); },
    press(kind) {
      const selector = kind === 'refresh' ? '[data-rd-refresh]' : '[data-rd-retry]';
      const target = { closest: (s) => (s.includes(selector) ? { disabled: false } : null) };
      for (const fn of handlers.click ?? []) fn({ target });
    },
  };
}

/** A radar ctx with a controllable clock and a recording loader; `go()` renders + mounts like main.js. */
function harness({ windows = [ACTIVE], now = NOW, param = null, review = false, access = 'ready', profile = PROFILE, load = null, snapshot = null, noSnapshot = false } = {}) {
  const t = { now };
  const calls = [];
  const root = fakeRoot();
  let cleanup = null;
  let markup = '';
  const ctx = {
    view: () => ({ profile, now: t.now, snapshot: noSnapshot ? null : (snapshot ?? { windows }), review, loading: false, error: null }),
    param: () => param,
    departuresAccess: () => access,
    loadDepartures: (query, opts) => {
      calls.push({ query, opts });
      if (load) return load(query, opts, calls.length);
      return Promise.resolve(resultFor(query, [flight()]));
    },
    rerender: () => draw(),
  };
  function draw() {
    cleanup?.();
    markup = radar.render(ctx).toString();
    cleanup = radar.mount(root, ctx);
  }
  return { ctx, calls, root, t, go: () => { draw(); return markup; }, markup: () => markup, draw, update: () => radar.update(root, ctx), setParam: (p) => { param = p; } };
}

const rowHtml = (markup, flightNumber) => {
  const start = markup.lastIndexOf('<li class="rd-row', markup.indexOf(`>${flightNumber}<`) === -1 ? markup.indexOf(flightNumber) : markup.indexOf(`${flightNumber}</span>`));
  return markup.slice(start, markup.indexOf('</li>', start));
};

// ---------- loading and loaded ----------

test('loading: header and window stay visible, skeleton rows and the loading text show; one request on mount', async () => {
  const h = harness();
  const first = h.go();
  assert.match(first, /Flights in standby window/);
  assert.match(first, /SB90/);
  assert.match(first, /Departures from FRA/);
  assert.ok(first.includes(formatTime(ACTIVE.start, HOME_TZ)) && first.includes(formatTime(ACTIVE.end, HOME_TZ)), 'window local times');
  assert.match(first, /Loading scheduled departures…/);
  assert.match(first, /rd-skel/);
  assert.match(first, /aria-busy="true"/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].query, { airport: 'FRA', from: ACTIVE.start, to: ACTIVE.end, carriers: null });
  assert.equal(h.calls[0].opts.force, false);
  await tick();
  const done = h.markup();
  assert.doesNotMatch(done, /rd-skel/);
  assert.match(done, /XX100/);
  assert.match(done, /Scheduled departures during your standby\. Not a prediction of assignment and not a legality check\./);
  assert.match(done, new RegExp(`Schedule data · fetched ${formatTime(NOW - 2 * M, HOME_TZ)}`));
  assert.doesNotMatch(done, /\(cached\)/);
});

test('re-rendering, re-mounting and update() reuse the loaded result: no further request', async () => {
  const h = harness();
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  h.draw(); h.draw();
  h.t.now += 5 * M;
  h.update();
  h.update();
  await tick();
  assert.equal(h.calls.length, 1);
  // While the first request is still in flight a re-mount does not start another.
  resetRadarUi();
  const slow = harness({ load: () => new Promise(() => {}) });
  slow.go(); slow.draw(); slow.update();
  assert.equal(slow.calls.length, 1);
});

test('update() redraws from memory (rows move past now) and never fetches, even if the roster window changes', async () => {
  const h = harness();
  h.go();
  await tick();
  const root = h.root;
  h.t.now = NOW + 2 * H;
  h.update();
  assert.match(root.innerHTML, /Earlier in this window \(1\)/);
  // The roster refresh now lists a different standby: the screen keeps the window it shows.
  h.ctx.view = () => ({ profile: PROFILE, now: h.t.now, snapshot: { windows: [sb(NOW + D, NOW + D + 5 * H, 'SB91')] }, review: false, loading: false, error: null });
  h.update();
  assert.equal(h.calls.length, 1);
});

test('"(cached)" shows when the result came from the device cache', async () => {
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, [flight()], { fromCache: true })) });
  h.go();
  await tick();
  assert.match(h.markup(), /fetched \d\d:\d\d \(cached\)/);
});

test('active window: earlier section is collapsed with a count, a now divider separates, upcoming follows', async () => {
  const flights = [flight({ flightNumber: 'XX1', scheduledDep: NOW - 2 * H }), flight({ flightNumber: 'XX2', scheduledDep: NOW - H }), flight({ flightNumber: 'XX3', scheduledDep: NOW + H })];
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, flights)) });
  h.go();
  await tick();
  const m = h.markup();
  assert.match(m, /<details class="rd-earlier"[^>]*data-rd-earlier\s*>/);
  assert.doesNotMatch(m, /<details[^>]*\sopen/);
  assert.match(m, /Earlier in this window \(2\)/);
  assert.ok(m.indexOf('Earlier in this window') < m.indexOf('rd-now'));
  assert.ok(m.indexOf('rd-now') < m.indexOf('XX3'));
  assert.match(m, new RegExp(`Now · ${formatTime(NOW, HOME_TZ)}`));
});

test('a future window shows everything as upcoming: no earlier section, no now divider', async () => {
  const future = sb(NOW + 2 * D, NOW + 2 * D + 8 * H);
  const h = harness({ windows: [future], param: String(future.start), load: (q) => Promise.resolve(resultFor(q, [flight({ scheduledDep: future.start + H })])) });
  h.go();
  await tick();
  assert.doesNotMatch(h.markup(), /Earlier in this window|rd-now/);
  assert.match(h.markup(), /XX100/);
});

test('empty list: the specified sentence', async () => {
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, [])) });
  h.go();
  await tick();
  assert.match(h.markup(), /No departures from FRA are scheduled in this window\./);
});

test('a different base airport is used for the request and the header', async () => {
  const profile = normalizeProfile({ base: 'MUC', homeBases: ['MUC'] });
  const h = harness({ profile });
  h.go();
  assert.equal(h.calls[0].query.airport, 'MUC');
  assert.match(h.markup(), /Departures from MUC/);
});

// ---------- refresh ----------

test('Refresh calls the loader with force:true and is disabled for 30 s afterwards', async () => {
  const h = harness();
  h.go();
  await tick();
  assert.doesNotMatch(h.markup(), /data-rd-refresh\s+disabled/);
  h.root.press('refresh');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].opts.force, true);
  await tick();
  assert.match(h.markup(), /data-rd-refresh\s+disabled/);
  // A click inside the pause does nothing.
  h.t.now += REFRESH_COOLDOWN_MS - 1000;
  h.root.press('refresh');
  assert.equal(h.calls.length, 2);
  h.draw();
  assert.match(h.markup(), /data-rd-refresh\s+disabled/);
  h.t.now += 1000;
  h.draw();
  assert.doesNotMatch(h.markup(), /data-rd-refresh\s+disabled/);
  h.root.press('refresh');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].opts.force, true);
});

test('Refresh is disabled and relabelled while its request is in flight', async () => {
  let release;
  const h = harness({ load: (q, o, n) => (n === 1 ? Promise.resolve(resultFor(q, [flight()])) : new Promise((r) => { release = () => r(resultFor(q, [flight({ flightNumber: 'XX200' })])); })) });
  h.go();
  await tick();
  h.root.press('refresh');
  assert.match(h.markup(), /data-rd-refresh\s+disabled>Refreshing…/);
  release();
  await tick();
  assert.match(h.markup(), /XX200/);
});

test('a failed refresh keeps the list and says so with the time of the data on screen', async () => {
  const h = harness({ load: (q, o, n) => (n === 1 ? Promise.resolve(resultFor(q, [flight()])) : Promise.reject(new DeparturesError('provider-unavailable'))) });
  h.go();
  await tick();
  h.root.press('refresh');
  await tick();
  const m = h.markup();
  assert.match(m, new RegExp(`Refresh failed · showing data fetched ${formatTime(NOW - 2 * M, HOME_TZ)}`));
  assert.match(m, /XX100/);
  assert.doesNotMatch(m, /Flight data is unavailable right now\./);
});

// ---------- errors ----------

test('errors: wording per code, each with a manual Retry that asks again', async () => {
  const cases = [
    [new DeparturesError('departures-not-configured'), 'Flight data is not set up on the backend.'],
    [new DeparturesError('provider-rate-limited'), 'The flight-data provider is busy. Try again in a minute.'],
    [new DeparturesError('provider-auth-failed'), 'Flight data is unavailable right now.'],
    [new DeparturesError('provider-unavailable'), 'Flight data is unavailable right now.'],
    [new ApiError('network', 'x'), 'Flight data is unavailable right now.'],
    [new ApiError('timeout', 'x'), 'Flight data is unavailable right now.'],
    [new DeparturesError('invalid-response'), 'Flight data is unavailable right now.'],
    [new Error('anything'), 'Flight data is unavailable right now.'],
  ];
  for (const [error, text] of cases) {
    resetRadarUi();
    const h = harness({ load: (q, o, n) => (n === 1 ? Promise.reject(error) : Promise.resolve(resultFor(q, [flight()]))) });
    h.go();
    await tick();
    assert.ok(h.markup().includes(text), `${error.code ?? error.message}: ${text}`);
    assert.match(h.markup(), /data-rd-retry/);
    assert.doesNotMatch(h.markup(), /rd-row/);
    assert.equal(errorText(error), text);
    h.root.press('retry');
    assert.equal(h.calls.length, 2);
    await tick();
    assert.match(h.markup(), /XX100/);
    assert.doesNotMatch(h.markup(), /data-rd-retry/);
  }
});

test('a synchronous loader failure is handled like a rejected one', async () => {
  const h = harness({ load: () => { throw new DeparturesError('provider-rate-limited'); } });
  h.go();
  await tick();
  assert.match(h.markup(), /The flight-data provider is busy/);
});

// ---------- no request states ----------

test('no standby: the 14-day sentence and a link to Today; no request', async () => {
  const h = harness({ windows: [] });
  const m = h.go();
  await tick();
  assert.match(m, /No standby in your roster for the next 14 days\./);
  assert.match(m, /href="#\/today"/);
  assert.equal(h.calls.length, 0);
});

test('reserve is not a standby: no window, no request', async () => {
  const h = harness({ windows: [{ kind: 'reserve', start: NOW - H, end: NOW + H, label: 'RE' }] });
  assert.match(h.go(), /No standby in your roster/);
  assert.equal(h.calls.length, 0);
});

test('ended window: its sentence, the window stays visible, no request', async () => {
  const past = sb(NOW - 10 * H, NOW - 2 * H, 'SB70');
  const h = harness({ windows: [past], param: String(past.start) });
  const m = h.go();
  await tick();
  assert.match(m, /This standby window has ended\./);
  assert.match(m, /SB70/);
  assert.equal(h.calls.length, 0);
});

test('too-far window: the date schedules become available, no request', async () => {
  const far = sb(NOW + 20 * D, NOW + 20 * D + 6 * H);
  const h = harness({ windows: [far], param: String(far.start) });
  const m = h.go();
  await tick();
  assert.ok(m.includes(`Schedules are available from ${formatDate(far.start - 14 * D, HOME_TZ)}.`));
  assert.equal(h.calls.length, 0);
});

test('too-long window: a short message, no request', async () => {
  const long = sb(NOW - H, NOW + 30 * H);
  const h = harness({ windows: [long] });
  const m = h.go();
  await tick();
  assert.match(m, /longer than 24 hours/);
  assert.equal(h.calls.length, 0);
});

test('no token or no endpoint: the access pattern, no request, nothing kept from an earlier visit', async () => {
  const withToken = harness();
  withToken.go();
  await tick();
  assert.match(withToken.markup(), /XX100/);
  withToken.ctx.departuresAccess = () => 'no-token';
  withToken.update();
  assert.match(withToken.root.innerHTML, /Access token required/);
  assert.doesNotMatch(withToken.root.innerHTML, /XX100/);
  resetRadarUi();
  const noToken = harness({ access: 'no-token' });
  assert.match(noToken.go(), /Access token required[\s\S]*Open Settings/);
  const noEndpoint = harness({ access: 'no-endpoint' });
  assert.match(noEndpoint.go(), /No roster source connected[\s\S]*Connect roster source/);
  assert.equal(noToken.calls.length + noEndpoint.calls.length, 0);
});

test('no roster yet: nothing is requested', () => {
  const h = harness({ noSnapshot: true });
  assert.match(h.go(), /No roster source connected|Loading roster/);
  assert.equal(h.calls.length, 0);
});

// ---------- review mode ----------

function reviewHarness(state = 'standby') {
  const profile = sampleProfile(PROFILE);
  const snapshot = sampleSnapshot(state, 'ocean', NOW, profile);
  return harness({ review: true, profile, snapshot, load: () => { throw new Error('review mode must not call the loader'); } });
}

test('review mode: fictional departures, labelled, and zero network calls', async () => {
  const h = reviewHarness();
  const m = h.go();
  await tick();
  assert.equal(h.calls.length, 0);
  assert.match(m, /Sample data · not your roster/);
  assert.match(m, /SAMPLE 10\d/);
  assert.match(m, /Sample schedule data · fictional flights/);
  assert.doesNotMatch(m, /data-rd-refresh/);
  assert.doesNotMatch(m, /Loading scheduled departures/);
  // Stable across re-renders (built once per window).
  const before = h.markup();
  h.draw();
  assert.equal(h.markup(), before);
  h.update();
  assert.equal(h.calls.length, 0);
});

test('review sample covers each case: delay, early, cancelled, departed, and a boarding status with no state', () => {
  const h = reviewHarness();
  const m = h.go();
  assert.match(m, /→ \d\d:\d\d · \+25 min/);
  assert.match(m, /→ \d\d:\d\d · −5 min/);
  assert.match(m, /rd-chip is-cancelled">Cancelled/);
  assert.match(m, /rd-chip is-departed">Departed/);
  const boarding = rowHtml(m, 'SAMPLE 104');
  assert.ok(boarding.includes('SAMPLE 104'));
  assert.doesNotMatch(boarding, /rd-chip/);
  assert.doesNotMatch(m, /Boarding|Gate closed/i);
  // The departed-in-the-past flight sits in the earlier section.
  assert.match(m, /Earlier in this window \(3\)/);
});

test('review sample emphasises the profile airline by its pack designator', () => {
  const m = reviewHarness().go();
  const pack = airlineOf(sampleProfile(PROFILE));
  assert.match(m, /rd-mark/);
  assert.ok(m.includes(`aria-label="Your airline (${pack.name})"`));
  const generic = sampleProfile(normalizeProfile({ airlineId: 'generic' }));
  const g = harness({ review: true, profile: generic, snapshot: sampleSnapshot('standby', 'ocean', NOW, generic) }).go();
  assert.doesNotMatch(g, /rd-mark|Your airline/);
});

test('sampleDepartures stays inside its range and is fully fictional', () => {
  const r = sampleDepartures({ airport: 'HOME', from: NOW - 3 * H, to: NOW + 6 * H, now: NOW, ownCarrier: null, airportTz: HOME_TZ });
  assert.ok(r.flights.length >= 8);
  assert.ok(r.flights.every((f) => f.scheduledDep >= NOW - 3 * H && f.scheduledDep < NOW + 6 * H && /^SAMPLE 1\d\d$/.test(f.flightNumber)));
  assert.ok(r.flights.every((f) => [null, 'HOME', 'AWAY', 'EAST', 'WEST'].includes(f.destination)));
  assert.equal(r.fromCache, false);
  assert.ok(r.flights.some((f) => f.status === 'boarding'));
});

// ---------- row structure ----------

test('every row reads time, flight number, destination, revised/delay, state, then aircraft', async () => {
  const flights = [flight({ flightNumber: 'XX7', scheduledDep: NOW - 40 * M, revisedDep: NOW - 15 * M, status: 'departed', destination: 'LHR', aircraft: { model: 'B788', registration: null } })];
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, flights)) });
  h.go();
  await tick();
  const row = rowHtml(h.markup(), 'XX7');
  const order = ['rd-time', 'rd-flight', 'rd-dest', 'rd-rev', 'rd-chip', 'rd-ac'].map((c) => row.indexOf(`class="${c}`));
  assert.ok(order.every((i) => i >= 0), `all parts present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(row, /London|LHR/);
  assert.match(row, /→ \d\d:\d\d · \+25 min/);
  assert.match(row, /Departed/);
  assert.match(row, /B788/);
});

test('emphasis is a small mark with an accessible name from the pack; a foreign carrier gets none', async () => {
  const own = airlineOf(PROFILE).flightDesignators[0];
  const flights = [flight({ flightNumber: 'XX8', carrier: own, scheduledDep: NOW + H }), flight({ flightNumber: 'XX9', carrier: 'ZZ', scheduledDep: NOW + 2 * H })];
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, flights)) });
  h.go();
  await tick();
  assert.match(rowHtml(h.markup(), 'XX8'), new RegExp(`role="img" aria-label="Your airline \\(${airlineOf(PROFILE).name}\\)" title="Your airline \\(${airlineOf(PROFILE).name}\\)"`));
  assert.doesNotMatch(rowHtml(h.markup(), 'XX9'), /rd-mark/);
  // Generic profile: nothing is emphasised.
  resetRadarUi();
  const gen = harness({ profile: normalizeProfile({ airlineId: 'generic' }), load: (q) => Promise.resolve(resultFor(q, flights)) });
  gen.go();
  await tick();
  assert.doesNotMatch(gen.markup(), /rd-mark/);
});

test('the earlier section keeps its open state across an update', async () => {
  const flights = [flight({ flightNumber: 'XX1', scheduledDep: NOW - 2 * H }), flight({ flightNumber: 'XX3', scheduledDep: NOW + H })];
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, flights)) });
  h.go();
  await tick();
  assert.doesNotMatch(h.markup(), /data-rd-earlier\s+open/);
  h.root.toggle(true);
  h.t.now += M;
  h.update();
  assert.match(h.root.innerHTML, /data-rd-earlier\s+open/);
  assert.equal(h.calls.length, 1);
});

test('a provider status such as boarding never appears as a state, whatever the time', async () => {
  const flights = ['boarding', 'scheduled', 'delayed', 'unknown'].map((status, i) => flight({ flightNumber: `ST${i}`, status, scheduledDep: NOW + (i + 1) * 30 * M, revisedDep: status === 'delayed' ? NOW + (i + 1) * 30 * M + 10 * M : null }));
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, flights)) });
  h.go();
  await tick();
  assert.doesNotMatch(h.markup(), /rd-chip/);
  assert.doesNotMatch(h.markup(), /Boarding|Gate closed|Delayed/i);
});

// ---------- entry links ----------

const FIXED = '2026-10-06T20:00:00Z';
function todayView(state) {
  const profile = sampleProfile(PROFILE);
  const snapshot = sampleSnapshot(state, 'ocean', NOW, profile);
  return { ...pipeline(snapshot, FIXED, profile), snapshot, profile, review: true, loading: false, error: null };
}

test('Today: the standby card links to the Radar for its window; reserve and others do not', () => {
  const v = todayView('standby');
  assert.equal(v.state.status, 'standby');
  const out = today.render({ view: () => v, weather: () => null }).toString();
  assert.ok(out.includes(`href="#/radar/${v.state.window.start}"`));
  assert.match(out, /Flights in standby window →/);
  for (const state of ['reserve', 'flight', 'off', 'layover']) {
    const view = todayView(state);
    const html = today.render({ view: () => view, weather: () => null }).toString();
    assert.doesNotMatch(html, /#\/radar|Flights in standby window/, state);
  }
});

function calendarDetail(snapshot, dateKey) {
  const profile = sampleProfile(PROFILE);
  const view = { ...pipeline(snapshot, FIXED, profile), snapshot, profile, review: true, loading: false, error: null };
  resetCalendarUi(dateKey.slice(0, 7), dateKey);
  const out = calendar.render({ view: () => view }).toString();
  return out.slice(out.indexOf('cal-detail-card'));
}
const dayOffset = (n) => addDays(localDateKey(NOW, HOME_TZ), n);

test('Calendar: a standby day within 14 days links to the Radar for that window', () => {
  const snapshot = sampleSnapshot('off', 'ocean', NOW, sampleProfile(PROFILE));
  const standby = snapshot.windows.filter((w) => w.kind === 'standby' && w.start > NOW);
  assert.ok(standby.length > 0);
  const w = standby[0];
  const detail = calendarDetail(snapshot, localDateKey(w.start, HOME_TZ));
  assert.ok(detail.includes(`href="#/radar/${w.start}"`), 'link with the window start');
  assert.match(detail, /Flights in standby window →/);
  // Today's own (active) standby day links too.
  const active = sampleSnapshot('standby', 'ocean', NOW, sampleProfile(PROFILE));
  const current = active.windows.find((x) => x.kind === 'standby' && x.start <= NOW && NOW < x.end);
  assert.ok(calendarDetail(active, localDateKey(NOW, HOME_TZ)).includes(`href="#/radar/${current.start}"`));
});

test('Calendar: no link for a standby beyond 14 days, an ended standby, or reserve', () => {
  const profile = sampleProfile(PROFILE);
  const base = sampleSnapshot('off', 'ocean', NOW, profile);
  const far = sb(NOW + 20 * D, NOW + 20 * D + 8 * H);
  const past = sb(NOW - 3 * D, NOW - 3 * D + 8 * H);
  const withExtra = { ...base, windows: [...base.windows, far, past] };
  assert.doesNotMatch(calendarDetail(withExtra, localDateKey(far.start, HOME_TZ)), /#\/radar/);
  assert.doesNotMatch(calendarDetail(withExtra, localDateKey(past.start, HOME_TZ)), /#\/radar/);
  const reserve = base.windows.find((w) => w.kind === 'reserve');
  const detail = calendarDetail(base, localDateKey(reserve.start, HOME_TZ));
  assert.match(detail, /Reserve/);
  assert.doesNotMatch(detail, /#\/radar/);
});

// ---------- discipline and wording ----------

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('requests only on mount and Refresh/Retry: no timers that fetch, no prefetch from Today/Calendar, no polling', () => {
  const screen = read('src/ui/screens/radar.js');
  assert.doesNotMatch(screen, /setInterval/);
  assert.equal((screen.match(/setTimeout/g) ?? []).length, 1, 'one UI timer (re-enabling Refresh)');
  assert.equal((screen.match(/ctx\.loadDepartures\(p\.query/g) ?? []).length, 1, 'one call site');
  for (const file of ['src/ui/screens/today.js', 'src/ui/screens/calendar.js', 'src/controller.js']) {
    assert.doesNotMatch(read(file), /loadDepartures/, `${file} does not fetch departures`);
  }
  const main = read('src/main.js');
  assert.match(main, /loadDepartures: \(query, \{ force = false \} = \{\}\)/);
  assert.doesNotMatch(main.slice(main.indexOf('const ctx')), /setInterval\([^)]*[Dd]epartures/);
  assert.doesNotMatch(screen, /localStorage|sessionStorage|store\.get|TOKEN_KEY/, 'the screen never reads storage or the token');
});

const SENTENCE = 'Not a prediction of assignment and not a legality check.';
const FORBIDDEN = /likely|probab|chance|risk|eligib|can operate|legal(?! check)|boarding|gate ?closed/i;

test('wording: no likelihood, eligibility, legality or provider-estimate words in the Radar files', () => {
  for (const file of ['src/ui/screens/radar.js', 'src/model/radar.js']) {
    const text = read(file).replaceAll(SENTENCE, '');
    const hit = text.match(FORBIDDEN);
    assert.equal(hit, null, `${file}: ${hit?.[0]}`);
    assert.doesNotMatch(text, /'DE'|"DE"|\bDE\b|Condor/i, `${file}: no airline literal`);
  }
});

test('wording: the rendered strings obey the same rules in every state', async () => {
  const states = [];
  const loaded = harness({ load: (q) => Promise.resolve(resultFor(q, [flight({ status: 'boarding' })])) });
  states.push(loaded.go());
  await tick();
  states.push(loaded.markup());
  states.push(reviewHarness().go());
  states.push(harness({ windows: [] }).go());
  states.push(...Object.values(TEXT).map((v) => (typeof v === 'function' ? v('FRA') : v)));
  for (const s of states) assert.equal(s.replaceAll(SENTENCE, '').match(FORBIDDEN), null, s.slice(0, 80));
});
