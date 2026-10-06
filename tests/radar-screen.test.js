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
import { DeparturesError, loadDepartures, DEPARTURES_TTL_MS } from '../src/sources/departures-service.js';
import { createStore } from '../src/store.js';
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
    rerender: () => draw({ quiet: true }),   // like main.js: show(route, { quiet: true })
  };
  function draw(opts = {}) {
    cleanup?.();
    markup = radar.render(ctx).toString();
    cleanup = radar.mount(root, ctx, opts);
  }
  // go() / reopen(): the screen is opened (route navigation). draw(): a redraw of the open screen.
  const open = () => { draw(); return markup; };
  return { ctx, calls, root, t, go: open, reopen: open, leave: () => { cleanup?.(); cleanup = null; }, markup: () => markup, draw: () => draw({ quiet: true }), update: () => radar.update(root, ctx), setParam: (p) => { param = p; } };
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

test('update() redraws from memory (rows move past now); while the key is unchanged it never fetches', async () => {
  const h = harness();
  h.go();
  await tick();
  const root = h.root;
  h.t.now = NOW + 2 * H;
  h.update();
  assert.match(root.innerHTML, /Earlier in this window \(1\)/);
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

// ---------- opening the screen before the roster is there (F1) ----------

const rosterView = (h, over = {}) => { h.ctx.view = () => ({ profile: PROFILE, now: h.t.now, snapshot: { windows: [ACTIVE] }, review: false, loading: false, error: null, ...over }); };
const loadingView = (h) => { h.ctx.view = () => ({ profile: PROFILE, now: h.t.now, snapshot: null, review: false, loading: true, error: null }); };

test('cold open without a roster: "Loading roster…" (not the departures skeleton), then the first update with a roster issues exactly one request', async () => {
  const h = harness({ noSnapshot: true });
  loadingView(h);
  const first = h.go();
  assert.match(first, /Loading roster…/);
  assert.doesNotMatch(first, /Loading scheduled departures…|rd-skel/);
  assert.equal(h.calls.length, 0);
  h.update();                                   // roster still loading: nothing
  assert.equal(h.calls.length, 0);
  rosterView(h);                                // the roster arrives
  h.update();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].query, { airport: 'FRA', from: ACTIVE.start, to: ACTIVE.end, carriers: null });
  assert.equal(h.calls[0].opts.force, false);
  assert.match(h.root.innerHTML, /Loading scheduled departures…/);
  await tick();
  assert.match(h.markup(), /XX100/);            // the completion redraw shows the list
  assert.equal(h.calls.length, 1, 'the completion redraw does not request again');
  // Later updates, redraws and clock moves never request again.
  h.update(); h.draw(); h.t.now += 10 * M; h.update(); h.update();
  await tick();
  assert.equal(h.calls.length, 1);
});

test('cold deep link with a window param: the initial load is for that window', async () => {
  const other = sb(NOW + 2 * D, NOW + 2 * D + 5 * H, 'SB91');
  const h = harness({ noSnapshot: true, param: String(other.start) });
  loadingView(h);
  h.go();
  assert.equal(h.calls.length, 0);
  rosterView(h, { snapshot: { windows: [ACTIVE, other] } });
  h.update();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].query, { airport: 'FRA', from: other.start, to: other.end, carriers: null });
  await tick();
  assert.match(h.root.innerHTML, /SB91/);
  h.update(); h.update();
  assert.equal(h.calls.length, 1);
});

test('cold open: a failed roster keeps the existing states and requests nothing; a later roster still gets its one load', async () => {
  const h = harness({ noSnapshot: true });
  h.ctx.view = () => ({ profile: PROFILE, now: h.t.now, snapshot: null, review: false, loading: false, error: { code: 'auth-required' } });
  assert.match(h.go(), /Access token required[\s\S]*Open Settings/);
  h.update();
  assert.match(h.markup(), /Access token required/);
  assert.equal(h.calls.length, 0);
  rosterView(h);
  h.update();
  assert.equal(h.calls.length, 1);
  h.update();
  assert.equal(h.calls.length, 1);
});

test('cold open: a roster without a usable window or without a token shows that state and requests nothing; a window that appears later gets its one load', async () => {
  const none = harness({ noSnapshot: true });
  loadingView(none);
  none.go();
  rosterView(none, { snapshot: { windows: [] } });
  none.update();
  assert.match(none.root.innerHTML, /No standby in your roster for the next 14 days\./);
  assert.equal(none.calls.length, 0);
  rosterView(none);                              // a window shows up later: the key changes from null, one load
  none.update();
  assert.equal(none.calls.length, 1);
  none.update();
  assert.equal(none.calls.length, 1);
  const noToken = harness({ noSnapshot: true, access: 'no-token' });
  loadingView(noToken);
  noToken.go();
  rosterView(noToken);
  noToken.update();
  assert.match(noToken.root.innerHTML, /Access token required/);
  assert.equal(noToken.calls.length, 0);
});

test('cold open in review mode: no request, the fictional list appears once the sample roster is there', () => {
  const profile = sampleProfile(PROFILE);
  const snapshot = sampleSnapshot('standby', 'ocean', NOW, profile);
  const h = harness({ review: true, profile, snapshot, noSnapshot: true, load: () => { throw new Error('review mode must not call the loader'); } });
  h.ctx.view = () => ({ profile, now: NOW, snapshot: null, review: true, loading: true, error: null });
  h.go();
  h.ctx.view = () => ({ profile, now: NOW, snapshot, review: true, loading: false, error: null });
  h.update();
  assert.match(h.root.innerHTML, /Sample schedule data/);
  assert.equal(h.calls.length, 0);
});

// ---------- reopening the screen (F3) ----------

/** Real loadDepartures with a device cache and a counting fake backend, on the harness clock. */
function cachedHarness(over = {}) {
  const fx = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/departures-v2.synthetic.json'), 'utf8'));
  const data = new Map();
  const store = createStore({ getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), key: (i) => [...data.keys()][i] ?? null, get length() { return data.size; } });
  const net = [];
  let hold = null;
  const api = {
    postContract: async (endpoint, body) => {
      net.push(body);
      if (hold) await hold;
      const p = structuredClone(fx);
      Object.assign(p, { airport: body.airport, from: body.from, to: body.to, carriers: body.carriers ?? null, fetchedAt: h.t.now, generatedAt: h.t.now });
      p.flights = [{ ...fx.flights[0], flightNumber: `DE9${net.length}01`, scheduledDep: NOW + H, revisedDep: null }];
      return { data: p, meta: {} };
    },
  };
  const h = harness({ ...over, load: (q, o) => loadDepartures({ ...q, endpoint: 'https://script.google.com/macros/s/' + 'A'.repeat(30) + '/exec', token: 'test-token-0123456789abcdef' }, { api, store, now: () => h.t.now, force: o.force }) });
  return { h, net, holdNext: () => { let release; hold = new Promise((r) => { release = () => { hold = null; r(); }; }); return release; } };
}

test('reopening within 5 minutes costs no network call (device cache); redraws and updates cost none either', async () => {
  const { h, net } = cachedHarness();
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1);
  assert.match(h.markup(), /DE9101/);
  h.t.now += DEPARTURES_TTL_MS - 1000;
  h.reopen();
  await tick(); await tick();
  assert.equal(net.length, 1, 'device cache hit');
  assert.match(h.markup(), /\(cached\)/);
  h.draw(); h.update(); h.t.now += 500; h.update();
  await tick(); await tick();
  assert.equal(net.length, 1);
});

test('reopening after 5 minutes asks the backend once, not forced; the previous list stays visible meanwhile with its fetched time', async () => {
  const { h, net, holdNext } = cachedHarness();
  h.go();
  await tick(); await tick();
  const firstFetched = formatTime(NOW - 0, HOME_TZ);
  assert.equal(net.length, 1);
  h.t.now += DEPARTURES_TTL_MS;
  const release = holdNext();
  const opened = h.reopen();
  await tick();
  assert.equal(net.length, 2);
  assert.match(opened, /DE9101/, 'previous list is shown at once');
  assert.doesNotMatch(opened, /rd-skel|Loading scheduled departures/);
  assert.ok(opened.includes(`fetched ${firstFetched}`), 'labelled with the time of the data on screen');
  h.draw(); h.update();                                   // while it runs: no third request
  assert.equal(net.length, 2);
  release();
  await tick(); await tick();
  assert.match(h.markup(), /DE9201/);
  assert.equal(net.length, 2);
  h.draw(); h.update();
  assert.equal(net.length, 2);
});

test('a reopen that fails keeps the previous list and says the refresh failed', async () => {
  const h = harness({ load: (q, o, n) => (n === 1 ? Promise.resolve(resultFor(q, [flight()])) : Promise.reject(new DeparturesError('provider-unavailable'))) });
  h.go();
  await tick();
  h.reopen();
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].opts.force, false);
  assert.match(h.markup(), /XX100/);
  assert.match(h.markup(), /Refresh failed · showing data fetched/);
});

test('reopening for a different window requests that window', async () => {
  const other = sb(NOW + 2 * D, NOW + 2 * D + 5 * H, 'SB91');
  const h = harness({ windows: [ACTIVE, other] });
  h.go();
  await tick();
  h.setParam(String(other.start));
  h.reopen();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].query.from, other.start);
  assert.equal(h.calls[1].opts.force, false);
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
    h.t.now += REFRESH_COOLDOWN_MS;               // a failed load rests 30 s before Retry is offered
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

test('a failed load starts the 30 s pause: Retry is disabled with the remaining time, then asks once, forced', async () => {
  const h = harness({ load: () => Promise.reject(new DeparturesError('provider-unavailable')) });
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.markup(), /data-rd-retry\s+disabled>Retry in 30 s</);
  h.root.press('retry');
  assert.equal(h.calls.length, 1, 'no request inside the pause');
  h.t.now += 5000;
  h.draw();
  assert.match(h.markup(), /data-rd-retry\s+disabled>Retry in 25 s</);
  h.t.now += REFRESH_COOLDOWN_MS - 5000 - 1;
  h.draw();
  assert.match(h.markup(), /data-rd-retry\s+disabled>Retry in 1 s</);
  h.root.press('retry');
  assert.equal(h.calls.length, 1);
  h.t.now += 1;
  h.draw();
  assert.match(h.markup(), /data-rd-retry\s*>Retry</);
  h.root.press('retry');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].opts.force, true);
  await tick();                                   // failed again: the pause starts again
  assert.match(h.markup(), /data-rd-retry\s+disabled>Retry in 30 s</);
  h.t.now += 29000;
  h.root.press('retry');
  assert.equal(h.calls.length, 2);
});

// ---------- one request rule: plan, key, cooldown ----------

const viewOf = (h, over = {}) => { h.ctx.view = () => ({ profile: PROFILE, now: h.t.now, snapshot: { windows: [ACTIVE] }, review: false, loading: false, error: null, ...over }); };
const sampleView = (h) => {
  const profile = sampleProfile(PROFILE);
  viewOf(h, { review: true, profile, snapshot: sampleSnapshot('standby', 'ocean', NOW, profile) });
};

for (const cached of [false, true]) {
  test(`exit review while on Radar (${cached ? 'roster cached' : 'no cached roster'}): the production window under its own label, exactly one request, never the sample; entering review again: none, sample shown`, async () => {
    const h = harness();
    sampleView(h);
    const inReview = h.go();
    assert.match(inReview, /SAMPLE 10\d/);
    assert.match(inReview, /Sample data · not your roster/);
    assert.equal(h.calls.length, 0);
    // Exit review: controller.setMode only runs update().
    if (cached) viewOf(h);
    else {
      viewOf(h, { snapshot: null, loading: true });
      h.update();
      assert.match(h.root.innerHTML, /Loading roster…/);
      assert.doesNotMatch(h.root.innerHTML, /SAMPLE|Sample data/);
      assert.equal(h.calls.length, 0);
      viewOf(h);                                  // the roster arrives
    }
    h.update();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0].query, { airport: 'FRA', from: ACTIVE.start, to: ACTIVE.end, carriers: null });
    assert.equal(h.calls[0].opts.force, false);
    assert.match(h.root.innerHTML, /SB90/);
    assert.match(h.root.innerHTML, /<p class="t-eyebrow">Standby<\/p>/);
    assert.match(h.root.innerHTML, /Loading scheduled departures…/);
    assert.doesNotMatch(h.root.innerHTML, /SAMPLE|Sample data|fictional/);
    await tick();
    assert.match(h.markup(), /XX100/);
    assert.doesNotMatch(h.markup(), /SAMPLE|Sample data|fictional/);
    assert.match(h.markup(), /data-rd-refresh/);
    assert.equal(h.calls.length, 1);
    h.update(); h.update();
    assert.equal(h.calls.length, 1);
    // Back into review: no request, the sample list, no leak of the production list.
    sampleView(h);
    h.update();
    assert.equal(h.calls.length, 1);
    assert.match(h.root.innerHTML, /SAMPLE 10\d/);
    assert.match(h.root.innerHTML, /Sample data · not your roster/);
    assert.doesNotMatch(h.root.innerHTML, /XX100/);
  });
}

test('error, leave, reopen within 30 s: no request, Retry disabled with the countdown; after 30 s the reopen asks once', async () => {
  const h = harness({ load: () => Promise.reject(new DeparturesError('provider-unavailable')) });
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  h.leave();
  h.t.now += 5000;
  const again = h.reopen();
  assert.equal(h.calls.length, 1);
  assert.match(again, /Flight data is unavailable right now\./);
  assert.match(again, /data-rd-retry\s+disabled>Retry in 25 s</);
  await tick();
  h.leave();
  h.t.now += 24000;
  h.reopen();
  assert.equal(h.calls.length, 1, 'still inside the pause');
  assert.match(h.markup(), /data-rd-retry\s+disabled>Retry in 1 s</);
  h.leave();
  h.t.now += 1000;
  h.reopen();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].opts.force, false);
});

test('a Retry or Refresh pause also survives leaving and reopening the screen', async () => {
  const h = harness();
  h.go();
  await tick();
  h.root.press('refresh');
  await tick();
  assert.equal(h.calls.length, 2);
  h.leave();
  h.t.now += 10000;
  h.reopen();
  await tick();
  assert.equal(h.calls.length, 2, 'the opening does not ask inside the pause');
  assert.match(h.markup(), /data-rd-refresh\s+disabled/);
  h.leave();
  h.t.now += 20000;
  h.reopen();
  await tick();
  assert.equal(h.calls.length, 3, 'after the pause the opening asks once, not forced');
  assert.equal(h.calls[2].opts.force, false);
});

test('a window change from a roster update while open: the plan follows, one non-forced load for the new key, none for the old; Refresh then forces the new key only', async () => {
  const h = harness();
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  const next = sb(ACTIVE.start, ACTIVE.end + H, 'SB90');          // the standby now ends an hour later
  viewOf(h, { snapshot: { windows: [next] } });
  h.update();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].query, { airport: 'FRA', from: next.start, to: next.end, carriers: null });
  assert.equal(h.calls[1].opts.force, false);
  assert.ok(h.root.innerHTML.includes(formatTime(next.end, HOME_TZ)), 'the new window is shown');
  assert.match(h.root.innerHTML, /Loading scheduled departures…/, 'the old list is not shown for the new key');
  h.update(); h.update();
  assert.equal(h.calls.length, 2, 'while it loads: no second request');
  await tick();
  assert.match(h.markup(), /XX100/);
  h.t.now += 5 * M; h.update(); h.update(); h.draw();
  assert.equal(h.calls.length, 2);
  h.root.press('refresh');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].opts.force, true);
  assert.equal(h.calls[2].query.to, next.end);
  assert.equal(h.calls.filter((c) => c.query.to === ACTIVE.end).length, 1, 'the old window is never asked again');
});

test('a window change replaces the window shown even with a route param, and a key without a roster change never asks', async () => {
  const other = sb(NOW + 2 * D, NOW + 2 * D + 5 * H, 'SB91');
  const h = harness({ windows: [ACTIVE, other], param: String(other.start) });
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].query.from, other.start);
  for (let i = 0; i < 20; i += 1) { h.t.now += M; h.update(); }
  await tick();
  assert.equal(h.calls.length, 1, 'many ticks, same key: no request');
  h.setParam(null);                                     // route param gone: the active window is the plan
  h.update();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].query.from, ACTIVE.start);
});

test('a token that appears while open changes the key from null: one load, then none', async () => {
  const h = harness({ access: 'no-token' });
  assert.match(h.go(), /Access token required/);
  assert.equal(h.calls.length, 0);
  h.update();
  assert.equal(h.calls.length, 0);
  h.ctx.departuresAccess = () => 'ready';
  h.update();
  assert.equal(h.calls.length, 1);
  await tick();
  assert.match(h.markup(), /XX100/);
  h.update();
  assert.equal(h.calls.length, 1);
});

test('the pause does not hold back the first load of a window the screen has nothing for', async () => {
  const h = harness({ load: (q, o, n) => (n === 1 ? Promise.reject(new DeparturesError('provider-unavailable')) : Promise.resolve(resultFor(q, [flight()]))) });
  h.go();
  await tick();
  assert.equal(h.calls.length, 1);
  viewOf(h, { snapshot: { windows: [] } });             // the window goes away: nothing from before stays
  h.update();
  assert.match(h.root.innerHTML, /No standby in your roster/);
  viewOf(h);                                            // and comes back inside the pause
  h.update();
  assert.equal(h.calls.length, 2, 'a key with no session is loaded at once');
  await tick();
  assert.match(h.markup(), /XX100/);
});

test('in-flight dedupe: rapid update()s, redraws, reopens and a window that vanishes and returns while a load runs still make one request, and its result lands', async () => {
  let release;
  const h = harness({ load: (q) => new Promise((r) => { release = () => r(resultFor(q, [flight({ flightNumber: 'XX555' })])); }) });
  h.go();
  for (let i = 0; i < 5; i += 1) { h.update(); h.draw(); h.t.now += 1000; }
  h.leave(); h.reopen();
  assert.equal(h.calls.length, 1);
  viewOf(h, { snapshot: { windows: [] } });
  h.update();
  viewOf(h);
  h.update();
  h.update();
  assert.equal(h.calls.length, 1);
  assert.match(h.root.innerHTML, /Loading scheduled departures…/);
  release();
  await tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.markup(), /XX555/);
});

test('reopen within 5 minutes asks the loader not forced and costs no network; after 5 minutes it costs one request, not forced', async () => {
  const { h, net } = cachedHarness();
  h.go();
  await tick(); await tick();
  assert.equal(net.length, 1);
  assert.equal(h.calls[0].opts.force, false);
  h.leave();
  h.t.now += DEPARTURES_TTL_MS - 1000;
  h.reopen();
  await tick(); await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].opts.force, false);
  assert.equal(net.length, 1, 'device cache');
  h.leave();
  h.t.now += 2000;
  h.reopen();
  await tick(); await tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].opts.force, false);
  assert.equal(net.length, 2, 'the cache is older than 5 minutes: the backend is asked once');
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

test('a destination that falls back to its IATA code shows it once; a known city keeps its code beside it', async () => {
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, [
    flight({ flightNumber: 'XX301', destination: 'ZZZ', destinationName: null, scheduledDep: NOW + H }),
    flight({ flightNumber: 'XX302', destination: 'ZZZ', destinationName: 'Zed Town', scheduledDep: NOW + 2 * H, id: 'f_0000000000000002' }),
    flight({ flightNumber: 'XX303', destination: 'LHR', destinationName: 'London Heathrow', scheduledDep: NOW + 3 * H, id: 'f_0000000000000003' }),
  ])) });
  h.go();
  await tick();
  const count = (text, word) => text.split(word).length - 1;
  assert.equal(count(rowHtml(h.markup(), 'XX301'), 'ZZZ'), 1);
  assert.equal(count(rowHtml(h.markup(), 'XX302'), 'ZZZ'), 1);
  assert.match(rowHtml(h.markup(), 'XX302'), /Zed Town[\s\S]*rd-iata[^>]*>ZZZ/);
  assert.match(rowHtml(h.markup(), 'XX303'), /rd-iata[^>]*>LHR/);
});

test('the aircraft is one clipped line: full text in title, accessible name as visually-hidden text (no aria-label on a plain span)', async () => {
  const model = 'De Havilland Canada DHC-8-400 Dash 8Q';
  const h = harness({ load: (q) => Promise.resolve(resultFor(q, [flight({ aircraft: { model, registration: null } })])) });
  h.go();
  await tick();
  assert.match(h.markup(), new RegExp(`<span class="rd-ac" title="${model}"><span class="visually-hidden">Aircraft </span>${model}</span>`));
  assert.doesNotMatch(h.markup(), /aria-label="Aircraft/);
});

test('CSS: the aircraft column is capped so time and flight/destination keep their width at phone width', () => {
  const css = readFileSync(join(ROOT, 'assets/css/screens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  const row = rule('.rd-row');
  const columns = row.match(/grid-template-columns:\s*([^;]+);/)[1];
  assert.match(columns, /^4\.1rem minmax\(0, 1fr\) minmax\(0, max-content\)$/, 'fixed time column, shrinkable flight/destination, bounded third column');
  const ac = rule('.rd-ac');
  assert.match(ac, /max-width:\s*\d+ch/);
  assert.match(ac, /overflow:\s*hidden/);
  assert.match(ac, /text-overflow:\s*ellipsis/);
  assert.match(ac, /white-space:\s*nowrap/);
  assert.match(ac, /min-width:\s*0/);
  assert.match(rule('.rd-flight'), /white-space:\s*nowrap/, 'the flight number never wraps');
  assert.doesNotMatch(css, /\.rd-row\s*\{[^}]*grid-template-columns:[^;]*\bauto\b/, 'no unbounded auto column');
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

test('requests come from one rule only (open, new key, Refresh/Retry): no timers that fetch, no prefetch from Today/Calendar, no polling', () => {
  const screen = read('src/ui/screens/radar.js');
  assert.doesNotMatch(screen, /setInterval/);
  assert.equal((screen.match(/setTimeout/g) ?? []).length, 1, 'one UI timer (Retry countdown, re-enabling the buttons)');
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
