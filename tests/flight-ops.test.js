// Flight Detail live gates (src/ui/flight-ops.js): rendered from the real adapter output.
// Invariants: the roster time is always the reference row; a provider time appears only as
// "Revised"; gates/terminals are never invented; boarding is never shown (D-004); data is escaped.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { flightOpsView, OPS_TEXT, flightOpsState, refreshFlightOps, setFlightOpsMounted, resetFlightOps, OPS_REFRESH_COOLDOWN_MS } from '../src/ui/flight-ops.js';
import { adaptFlightInfo } from '../src/sources/flight-info-v2.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 20, 7, 31);
// Invented roster sector: FRA 10:45 local -> JFK 13:15 local.
const SECTOR = { origin: 'FRA', destination: 'JFK', dep: Date.UTC(2026, 9, 20, 8, 45), arr: Date.UTC(2026, 9, 20, 17, 15), originTz: 'Europe/Berlin', destTz: 'America/New_York' };
const VIEW = { profile: { homeTz: 'Europe/Berlin' } };

const leg = (over = {}) => ({ airport: 'FRA', scheduled: SECTOR.dep, revised: null, runway: null, terminal: null, gate: null, desk: null, belt: null, quality: ['basic', 'live'], ...over });
function payload({ status = 'scheduled', dep = {}, arr = {}, found = true, fetchedAt = NOW - MIN, lastUpdated = NOW - 2 * MIN } = {}) {
  return {
    ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'p', generatedAt: NOW, fetchedAt,
    query: { flightNumber: 'XX2016', date: '2026-10-20', origin: 'FRA' }, found,
    flight: found ? { id: 'g_0123456789abcdef', flightNumber: 'XX2016', status, lastUpdated,
      departure: leg(dep), arrival: leg({ airport: 'JFK', scheduled: SECTOR.arr, ...arr }), provenance: 'provider' } : null,
  };
}
const render = (p, sector = SECTOR) => String(flightOpsView({ status: 'ready', info: adaptFlightInfo(p, { now: NOW }) }, sector, VIEW));
const legHtml = (out, kind) => out.split(`data-leg="${kind}"`)[1].split('data-leg=')[0];

test('both gates and terminals are shown per leg; the roster time is the reference row', () => {
  const out = render(payload({ dep: { gate: 'B43', terminal: '1', desk: '501-512' }, arr: { gate: '5', terminal: '7', belt: '4' } }));
  assert.match(legHtml(out, 'departure'), /fo-gate-value[^>]*>B43</);
  assert.match(legHtml(out, 'departure'), /Terminal 1/);
  assert.match(legHtml(out, 'departure'), /Check-in<\/span> <span class="t-tabular">501-512/);
  assert.match(legHtml(out, 'arrival'), /fo-gate-value[^>]*>5</);
  assert.match(legHtml(out, 'arrival'), /Terminal 7/);
  assert.match(legHtml(out, 'arrival'), /Baggage belt<\/span> <span class="t-tabular">4/);
  assert.match(legHtml(out, 'departure'), /Roster<\/dt><dd class="t-tabular">10:45/);
  assert.match(legHtml(out, 'arrival'), /Roster<\/dt><dd class="t-tabular">13:15/);
  assert.ok(!out.includes('Revised'), 'no revised row without a provider revision');
});

test('a revised time is a separate labelled row and never replaces the roster time', () => {
  const out = render(payload({ status: 'delayed', dep: { gate: 'B43', revised: SECTOR.dep + 20 * MIN } }));
  const dep = legHtml(out, 'departure');
  assert.match(dep, /Roster<\/dt><dd class="t-tabular">10:45/);
  assert.match(dep, /Revised<\/dt><dd class="t-tabular">11:05/);
  // A revision equal to the roster time (under a minute apart) adds nothing.
  assert.ok(!render(payload({ dep: { revised: SECTOR.dep + 30000 } })).includes('Revised'));
  // The provider's own scheduled time never appears: only the roster's.
  const shifted = render(payload({ dep: { scheduled: SECTOR.dep + 3 * HOUR } }));
  assert.ok(!shifted.includes('13:45') && legHtml(shifted, 'departure').includes('10:45'));
});

test('departure gate only: arrival says "not assigned yet" only with live data and an open flight', () => {
  const live = render(payload({ dep: { gate: 'B43' }, arr: { gate: null, quality: ['basic', 'live'] } }));
  assert.match(legHtml(live, 'arrival'), new RegExp(`Gate ${OPS_TEXT.pending.toLowerCase()}`));
  const basic = render(payload({ dep: { gate: 'B43' }, arr: { gate: null, quality: ['basic'] } }));
  assert.match(legHtml(basic, 'arrival'), new RegExp(OPS_TEXT.bothMissing));
  assert.ok(!legHtml(basic, 'arrival').includes('fo-gate-value'));
});

test('neither gate nor terminal: nothing is invented', () => {
  const out = render(payload({ dep: { quality: ['basic'] }, arr: { quality: ['basic'] } }));
  assert.ok(!out.includes('fo-gate-value'));
  // Refinement: one compact line instead of two empty rows.
  assert.equal(out.split(OPS_TEXT.bothMissing).length - 1, 2);
  assert.ok(!out.includes('Terminal unavailable'));
  const withTerminal = render(payload({ dep: { terminal: '1', quality: ['basic'] } }));
  assert.match(legHtml(withTerminal, 'departure'), new RegExp(`${OPS_TEXT.noGate}[\\s\\S]*Terminal 1`));
  assert.ok(!/Check-in|Baggage belt/.test(out));
});

test('cancelled/diverted/delayed show a provider-labelled chip; boarding and routine statuses show none (D-004)', () => {
  assert.match(render(payload({ status: 'cancelled' })), /Cancelled \(provider\)/);
  assert.match(render(payload({ status: 'diverted' })), /Diverted \(provider\)/);
  assert.match(render(payload({ status: 'delayed' })), /Delayed \(provider\)/);
  for (const status of ['boarding', 'scheduled', 'departed', 'arrived', 'unknown']) {
    const out = render(payload({ status }));
    assert.ok(!out.includes('chip-status'), status);
    assert.ok(!/boarding/i.test(out), status);
  }
  // A cancelled flight never claims a gate is about to be assigned.
  assert.ok(!render(payload({ status: 'cancelled' })).includes(OPS_TEXT.pending.toLowerCase()));
});

test('stale information is flagged; the footer names the update time', () => {
  const fresh = render(payload());
  assert.match(fresh, /Live flight information · Updated 09:29/);
  assert.ok(!fresh.includes(OPS_TEXT.stale));
  assert.match(render(payload({ fetchedAt: NOW - 20 * MIN })), /Last updated 09:29 · Information may have changed\./);
});

test('not found, provider unavailable, quota and loading are quiet one-line states', () => {
  assert.match(render(payload({ found: false })), new RegExp(OPS_TEXT.notFound));
  assert.ok(!render(payload({ found: false })).includes('data-leg'));
  assert.match(String(flightOpsView({ status: 'error', error: 'provider-unavailable' }, SECTOR, VIEW)), new RegExp(OPS_TEXT.unavailable));
  assert.match(String(flightOpsView({ status: 'error', error: 'provider-rate-limited' }, SECTOR, VIEW)), /provider limit is reached/);
  assert.match(String(flightOpsView({ status: 'loading' }, SECTOR, VIEW)), /Loading live flight information/);
  assert.equal(String(flightOpsView(null, SECTOR, VIEW)), '', 'no section when live data does not apply');
});

test('provider text is escaped', () => {
  const info = adaptFlightInfo(payload(), { now: NOW });
  // The validator refuses such text; the view must escape it anyway.
  const out = String(flightOpsView({ status: 'ready', info: { ...info, departure: { ...info.departure, gate: 'A<b>1', gateState: 'available' } } }, SECTOR, VIEW));
  assert.ok(out.includes('A&lt;b&gt;1') && !out.includes('<b>'));
});

test('a leg whose provider airport differs from the roster airport shows none of its data (diversion)', () => {
  const out = render(payload({ status: 'diverted', dep: { gate: 'B43' }, arr: { airport: 'BOS', gate: 'Z9', terminal: 'E', belt: '7', revised: SECTOR.arr + 40 * MIN } }));
  const arr = legHtml(out, 'arrival');
  assert.match(arr, /Arrival · <span class="t-code">JFK/);
  assert.ok(!/Z9|Terminal E|Baggage belt|Revised/.test(arr), 'nothing from the BOS leg under JFK');
  assert.match(arr, /Roster<\/dt><dd class="t-tabular">13:15/);
  assert.match(out, /does not list the rostered arrival airport/);
  assert.match(legHtml(out, 'departure'), /B43/);
  assert.match(out, /Diverted \(provider\)/);
});

test('"not assigned yet" only while the gate can still be published (scheduled/delayed departure)', () => {
  for (const [status, expected] of [['scheduled', true], ['delayed', true], ['boarding', false], ['unknown', false], ['departed', false]]) {
    const out = render(payload({ status, dep: { gate: null, quality: ['basic', 'live'] } }));
    assert.equal(legHtml(out, 'departure').includes(OPS_TEXT.pending.toLowerCase()), expected, status);
  }
});

test('information for another departure airport shows no gate on either leg', () => {
  const info = adaptFlightInfo(payload({ dep: { gate: 'B43' }, arr: { gate: '5', belt: '4' } }), { now: NOW });
  const out = String(flightOpsView({ status: 'ready', info: { ...info, departure: { ...info.departure, airport: 'MUC' } } }, SECTOR, VIEW));
  assert.ok(!/B43|fo-gate-value|Baggage belt/.test(out));
});

// --- Load state and manual refresh -------------------------------------------------------

const ENTRY = { status: 'upcoming', sector: { ...SECTOR, flightNumber: 'XX2016', provenance: 'roster' } };
function fakeCtx({ access = 'ready', answer = () => adaptFlightInfo(payload(), { now: NOW }) } = {}) {
  const calls = [];
  let id = 'a1';
  let visits = 1;
  const ctx = {
    flightInfoAccess: () => access, accessId: () => id, visit: () => visits, rerenders: 0,
    rerender() { this.rerenders += 1; },
    loadFlightInfo: (sector, opts) => { calls.push({ sector, opts }); return Promise.resolve().then(() => answer(calls.length)); },
  };
  return { ctx, calls, setAccess: (v) => { id = v; }, navigate: () => { visits += 1; } };
}
const VIEWNOW = { ...VIEW, now: SECTOR.dep - 2 * HOUR, review: false };
const settle = () => new Promise((r) => setTimeout(r, 0));

test('load state: one load per flight, rendered after it settles; never in review mode, for history or far flights', async () => {
  resetFlightOps(); setFlightOpsMounted(true);
  const { ctx, calls } = fakeCtx();
  assert.equal(flightOpsState(ctx, ENTRY, VIEWNOW).status, 'loading');
  flightOpsState(ctx, ENTRY, VIEWNOW);
  await settle();
  assert.equal(calls.length, 1, 'no duplicate request for the same flight');
  assert.equal(ctx.rerenders, 1);
  assert.equal(flightOpsState(ctx, ENTRY, VIEWNOW).status, 'ready');
  assert.equal(flightOpsState(ctx, ENTRY, { ...VIEWNOW, review: true }), null);
  assert.equal(flightOpsState(ctx, { ...ENTRY, sector: { ...ENTRY.sector, provenance: 'history' } }, VIEWNOW), null);
  assert.equal(flightOpsState(ctx, ENTRY, { ...VIEWNOW, now: SECTOR.dep - 8 * 24 * HOUR }), null);
  assert.equal(flightOpsState(fakeCtx({ access: 'no-token' }).ctx, ENTRY, VIEWNOW), null);
  assert.equal(calls.length, 1);
});

test('manual refresh: forced once, then paused; ignored while loading', async () => {
  resetFlightOps(); setFlightOpsMounted(true);
  const { ctx, calls } = fakeCtx();
  flightOpsState(ctx, ENTRY, VIEWNOW);
  assert.equal(refreshFlightOps(ctx, ENTRY, VIEWNOW), false, 'ignored while the first load runs');
  await settle();
  assert.equal(refreshFlightOps(ctx, ENTRY, VIEWNOW), true);
  assert.deepEqual(calls.map((c) => c.opts.force), [false, true]);
  assert.equal(flightOpsState(ctx, ENTRY, VIEWNOW).refresh.busy, true);
  await settle();
  const st = flightOpsState(ctx, ENTRY, VIEWNOW);
  assert.equal(st.refresh.cooling, true);
  assert.equal(refreshFlightOps(ctx, ENTRY, VIEWNOW), false, 'paused for OPS_REFRESH_COOLDOWN_MS');
  assert.equal(OPS_REFRESH_COOLDOWN_MS, 30000);
  assert.match(String(flightOpsView(st, SECTOR, VIEW)), /data-fo-refresh disabled/);
});

test('errors: shown once, not retried in a loop; data on screen survives a failed refresh; access change forgets state', async () => {
  resetFlightOps(); setFlightOpsMounted(true);
  let fail = true;
  const err = Object.assign(new Error('x'), { code: 'provider-rate-limited' });
  const { ctx, calls, setAccess } = fakeCtx({ answer: () => { if (fail) throw err; return adaptFlightInfo(payload({ dep: { gate: 'B43' } }), { now: NOW }); } });
  flightOpsState(ctx, ENTRY, VIEWNOW); await settle();
  const st = flightOpsState(ctx, ENTRY, VIEWNOW);
  assert.equal(st.status, 'error');
  assert.match(String(flightOpsView(st, SECTOR, VIEW)), /provider limit is reached/);
  flightOpsState(ctx, ENTRY, VIEWNOW); flightOpsState(ctx, ENTRY, VIEWNOW); await settle();
  assert.equal(calls.length, 1, 'no retry loop');
  setAccess('a2'); fail = false;
  flightOpsState(ctx, ENTRY, VIEWNOW); await settle();
  assert.equal(calls.length, 2, 'a new access identity starts fresh');
  assert.match(String(flightOpsView(flightOpsState(ctx, ENTRY, VIEWNOW), SECTOR, VIEW)), /B43/);
  setFlightOpsMounted(false);
});

// The app redraws Flights every minute by running cleanup + mount again (main.js show()). These tests
// replay that cycle with a controlled clock: redraws must never start provider requests.

// Same order as main.js show(): cleanup, render, mount. A quiet redraw does not change ctx.visit().
function redraw(ctx) { setFlightOpsMounted(false); const st = flightOpsState(ctx, ENTRY, VIEWNOW); setFlightOpsMounted(true); return st; }
function reopen(ctx, navigate) { setFlightOpsMounted(false); navigate(); return redraw(ctx); }

test('no retry loop: a failed lookup is not repeated by minute redraws, only after the detail is opened again', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  resetFlightOps(); setFlightOpsMounted(true);
  const err = Object.assign(new Error('x'), { code: 'provider-unavailable' });
  const { ctx, calls, navigate } = fakeCtx({ answer: () => { throw err; } });
  flightOpsState(ctx, ENTRY, VIEWNOW); await settle();
  for (let i = 0; i < 10; i++) { mock.timers.tick(60000); redraw(ctx); await settle(); }
  assert.equal(calls.length, 1, '10 minutes of redraws, one request');
  mock.timers.tick(5000); reopen(ctx, navigate); await settle();   // left Flights and came back
  assert.equal(calls.length, 2, 'the visit itself tries once more (after the pause)');
  mock.timers.tick(1000); reopen(ctx, navigate); await settle();
  assert.equal(calls.length, 2, 'a visit within the pause does not');
  redraw(ctx); await settle();
  assert.equal(calls.length, 2);
});

test('information on screen ages: stale wording appears without a new request; reopening after the cache lifetime renews it', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  resetFlightOps(); setFlightOpsMounted(true);
  const { ctx, calls, navigate } = fakeCtx({ answer: () => adaptFlightInfo(payload({ fetchedAt: Date.now(), lastUpdated: Date.now() }), { now: Date.now() }) });
  flightOpsState(ctx, ENTRY, VIEWNOW); await settle();
  assert.equal(redraw(ctx).info.stale, false);
  for (let i = 0; i < 20; i++) { mock.timers.tick(60000); redraw(ctx); await settle(); }
  const st = redraw(ctx);
  assert.equal(st.info.stale, true, '20 min later the footer says the information may have changed');
  assert.match(String(flightOpsView(st, SECTOR, VIEW)), /Last updated .* · Information may have changed\./);
  assert.equal(calls.length, 1, 'redraws alone never ask again');
  mock.timers.tick(5000); reopen(ctx, navigate); await settle();
  assert.equal(calls.length, 2, 'the visit renews information older than the cache lifetime, on that render');
  assert.equal(redraw(ctx).info.stale, false);
});

test('slow renders cannot turn redraws into visits', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  t.after(() => mock.timers.reset());
  resetFlightOps();
  const err = Object.assign(new Error('x'), { code: 'provider-unavailable' });
  const { ctx, calls } = fakeCtx({ answer: () => { throw err; } });
  redraw(ctx); await settle();
  for (let i = 0; i < 10; i++) { setFlightOpsMounted(false); mock.timers.tick(1500); flightOpsState(ctx, ENTRY, VIEWNOW); setFlightOpsMounted(true); mock.timers.tick(58500); await settle(); }
  assert.equal(calls.length, 1);
});
