// Live flight information (frontend data layer, no UI): flight-number normalisation, sector query,
// strict validator, pure adapter and the cached/de-duplicated loader. Invented data only; the
// fake fetch answers in the `flight` wire shape of the fc.roster v2 contract.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeFlightNumber, flightRequest, validateFlightInfo, adaptFlightInfo, FLIGHT_STATUSES, GATE_STATE,
  STALE_FETCH_MS, STALE_UPDATE_MS,
} from '../src/sources/flight-info-v2.js';
import {
  FlightInfoError, flightQueryFor, loadFlightInfo, purgeFlightInfoCache, FLIGHT_TTL_MS, FLIGHT_TIMEOUT_MS, FLIGHT_MAX_ENTRIES,
} from '../src/sources/flight-info-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const HOUR = 3600000;
const MIN = 60000;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0); // 2026-10-08T12:00Z

// ---------- wire builders ----------

const leg = (over = {}) => ({
  airport: 'AAA', scheduled: T0 + 2 * HOUR, revised: null, runway: null,
  terminal: null, gate: null, desk: null, belt: null, quality: ['basic', 'live'], ...over,
});
const wireFlight = (over = {}, dep = {}, arr = {}) => ({
  id: 'g_0123456789abcdef', flightNumber: 'XX1234', status: 'scheduled', lastUpdated: T0 - 5 * MIN,
  departure: leg({ gate: 'A12', ...dep }),
  arrival: leg({ airport: 'BBB', scheduled: T0 + 5 * HOUR, gate: 'B7', desk: null, belt: '3', ...arr }),
  provenance: 'provider', ...over,
});
const wire = (over = {}, flight = wireFlight()) => ({
  ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'aerodatabox',
  generatedAt: T0, fetchedAt: T0, query: { flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' },
  found: true, flight: flight, ...over,
});
const notFound = (over = {}) => wire({ found: false, flight: null, ...over });

const SECTOR = { flightNumber: 'XX1234', origin: 'AAA', dep: Date.UTC(2026, 9, 8, 14, 0), originTz: 'Europe/Berlin' };
const INPUT = { endpoint: ENDPOINT, token: TOKEN, sector: SECTOR };

/** Fake backend: answers `respond(body, callNumber)` as JSON (default: a found flight echoing the request). */
function backend(respond = null) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const payload = respond
      ? await respond(body, calls.length)
      : echo(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetchImpl };
}
const echo = (body, over = {}, flight = wireFlight({ flightNumber: body.flightNumber })) => wire({ query: { flightNumber: body.flightNumber, date: body.date, origin: body.origin }, ...over }, flight);

beforeEach(() => purgeFlightInfoCache());

// ---------- normalisation ----------

test('normalizeFlightNumber: canonical form', () => {
  const table = [
    ['XX1234', 'XX1234'], ['XX 1234', 'XX1234'], ['xx 01234', 'XX1234'], ['xx1234', 'XX1234'], [' xx\t12 34 ', 'XX1234'],
    ['XX 0016', 'XX16'], ['XX02016', 'XX2016'], ['XX7', 'XX7'], ['XX0007', 'XX7'], ['XX0', 'XX0'], ['XX1234A', 'XX1234A'],
    ['x1 99', 'X199'], ['9U 12', '9U12'],
  ];
  for (const [input, expected] of table) assert.equal(normalizeFlightNumber(input), expected, JSON.stringify(input));
});

test('normalizeFlightNumber: bad values give null', () => {
  for (const bad of ['', '   ', 'XX', 'X', 'XX12345', 'XX123456', 'XX1234AB', 'XX-1234', 'XX 12.4', '12', 'XX1A34', 'ß1234', null, undefined, 1234, {}, ['XX1234']]) {
    assert.equal(normalizeFlightNumber(bad), null, String(bad));
  }
});

test('request: contract envelope, token only in the body', () => {
  const body = flightRequest({ flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' }, TOKEN);
  assert.deepEqual(body, { contract: 'fc.roster', version: 2, action: 'flight', token: TOKEN, flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' });
});

// ---------- flightQueryFor ----------

test('flightQueryFor: date is the departure date in the origin zone (overnight)', () => {
  const dep = Date.UTC(2026, 9, 8, 22, 30); // 2026-10-08T22:30Z
  assert.deepEqual(flightQueryFor({ ...SECTOR, dep, originTz: 'Europe/Berlin' }), { flightNumber: 'XX1234', date: '2026-10-09', origin: 'AAA' });
  assert.deepEqual(flightQueryFor({ ...SECTOR, dep, originTz: 'America/New_York' }), { flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' });
  assert.equal(flightQueryFor({ ...SECTOR, flightNumber: 'xx 01234' }).flightNumber, 'XX1234');
});

test('flightQueryFor: any missing or invalid part gives null (no zone is ever guessed)', () => {
  assert.equal(flightQueryFor(null), null);
  assert.equal(flightQueryFor(undefined), null);
  assert.equal(flightQueryFor({ ...SECTOR, originTz: null }), null);
  assert.equal(flightQueryFor({ ...SECTOR, originTz: undefined }), null);
  assert.equal(flightQueryFor({ ...SECTOR, originTz: 'Not/AZone' }), null);
  assert.equal(flightQueryFor({ ...SECTOR, originTz: '' }), null);
  assert.equal(flightQueryFor({ ...SECTOR, flightNumber: 'nope' }), null);
  assert.equal(flightQueryFor({ ...SECTOR, flightNumber: undefined }), null);
  assert.equal(flightQueryFor({ ...SECTOR, origin: 'aaa' }), null);
  assert.equal(flightQueryFor({ ...SECTOR, origin: null }), null);
  assert.equal(flightQueryFor({ ...SECTOR, dep: NaN }), null);
  assert.equal(flightQueryFor({ ...SECTOR, dep: '1791000000000' }), null);
  assert.equal(flightQueryFor({ ...SECTOR, dep: undefined }), null);
});

// ---------- validator ----------

test('validator: accepts found, not-found and every status', () => {
  assert.deepEqual(validateFlightInfo(wire()), { ok: true });
  assert.deepEqual(validateFlightInfo(notFound()), { ok: true });
  for (const status of FLIGHT_STATUSES) assert.deepEqual(validateFlightInfo(wire({}, wireFlight({ status }))), { ok: true }, status);
  assert.deepEqual(validateFlightInfo(wire({}, wireFlight({ lastUpdated: null }, { quality: [], gate: null }, { quality: ['basic', 'live', 'approximate'] }))), { ok: true });
});

test('validator: rejects malformed payloads with a reason', () => {
  const reason = (r) => (r.ok ? 'accepted' : r.reason);
  const bad = (mutate) => { const p = wire(); mutate(p); return reason(validateFlightInfo(p)); };
  assert.equal(reason(validateFlightInfo(null)), 'not-an-object');
  assert.equal(reason(validateFlightInfo('x')), 'not-an-object');
  assert.equal(bad((p) => { p.contract = 'other'; }), 'contract-mismatch');
  assert.equal(bad((p) => { p.version = 5; }), 'contract-mismatch');
  assert.equal(bad((p) => { p.action = 'departures'; }), 'wrong-action');
  assert.equal(bad((p) => { p.extra = 1; }), 'bad-keys');
  assert.equal(bad((p) => { delete p.generatedAt; }), 'bad-keys');
  assert.equal(bad((p) => { delete p.flight; }), 'bad-keys');
  assert.equal(bad((p) => { p.provider = ''; }), 'bad-meta');
  assert.equal(bad((p) => { p.provider = 7; }), 'bad-meta');
  assert.equal(bad((p) => { p.fetchedAt = null; }), 'bad-meta');
  assert.equal(bad((p) => { p.generatedAt = '1'; }), 'bad-meta');
  assert.equal(bad((p) => { p.query.extra = 1; }), 'bad-query');
  assert.equal(bad((p) => { delete p.query.origin; }), 'bad-query');
  assert.equal(bad((p) => { p.query.flightNumber = 'xx1234'; }), 'bad-query');
  assert.equal(bad((p) => { p.query.flightNumber = 'XX01234'; }), 'bad-query');
  assert.equal(bad((p) => { p.query.date = '2026-02-30'; }), 'bad-query');
  assert.equal(bad((p) => { p.query.date = '2026-1-8'; }), 'bad-query');
  assert.equal(bad((p) => { p.query.origin = 'aaa'; }), 'bad-query');
  assert.equal(bad((p) => { p.query = null; }), 'bad-query');
  // found <=> flight
  assert.equal(bad((p) => { p.found = false; }), 'bad-found');
  assert.equal(bad((p) => { p.flight = null; }), 'bad-found');
  assert.equal(bad((p) => { p.found = 'yes'; }), 'bad-found');
  // flight
  assert.equal(bad((p) => { p.flight.extra = 1; }), 'bad-flight');
  assert.equal(bad((p) => { delete p.flight.lastUpdated; }), 'bad-flight');
  assert.equal(bad((p) => { p.flight.lastUpdated = '5'; }), 'bad-flight');
  assert.equal(bad((p) => { p.flight.id = 'g_0123456789ABCDEF'; }), 'bad-id');
  assert.equal(bad((p) => { p.flight.id = 'g_0123456789abcde'; }), 'bad-id');
  assert.equal(bad((p) => { p.flight.id = 'f_0123456789abcdef'; }), 'bad-id');
  assert.equal(bad((p) => { p.flight.id = 5; }), 'bad-id');
  assert.equal(bad((p) => { p.flight.flightNumber = 'XX 1234'; }), 'bad-flight');
  assert.equal(bad((p) => { p.flight.flightNumber = 'XX4321'; }), 'bad-flight'); // not the number that was asked for
  assert.equal(bad((p) => { p.flight.status = 'on-time'; }), 'bad-status');
  assert.equal(bad((p) => { p.flight.provenance = 'source'; }), 'bad-provenance');
  assert.equal(bad((p) => { p.flight.departure.airport = 'CCC'; }), 'bad-flight'); // not leaving the asked origin
  // legs
  assert.equal(bad((p) => { p.flight.departure.extra = 1; }), 'bad-leg');
  assert.equal(bad((p) => { delete p.flight.arrival.belt; }), 'bad-leg');
  assert.equal(bad((p) => { p.flight.arrival.airport = 'bbb'; }), 'bad-leg');
  assert.equal(bad((p) => { p.flight.arrival.scheduled = '1'; }), 'bad-leg');
  assert.equal(bad((p) => { p.flight.arrival.runway = NaN; }), 'bad-leg');
  assert.equal(bad((p) => { p.flight.departure.belt = '3'; }), 'bad-leg');
  assert.equal(bad((p) => { p.flight.arrival.desk = '3'; }), 'bad-leg');
  // text rule
  assert.equal(bad((p) => { p.flight.departure.gate = ''; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = ' A12'; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = 'A12 '; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = 'A  12'; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = 'A'.repeat(17); }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = '<b>'; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.terminal = '-1'; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.terminal = 2; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.arrival.belt = 'A\nB'; }), 'bad-text');
  assert.equal(bad((p) => { p.flight.departure.gate = 'A'.repeat(16); }), 'accepted');
  assert.equal(bad((p) => { p.flight.departure.gate = 'B 3/4, +-.'; }), 'accepted');
  // quality: subset of basic/live/approximate, unique, in that order
  assert.equal(bad((p) => { p.flight.departure.quality = ['live', 'basic']; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.departure.quality = ['basic', 'basic']; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.departure.quality = ['Live']; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.departure.quality = ['verified']; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.departure.quality = 'live'; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.departure.quality = ['approximate', 'live']; }), 'bad-quality');
  assert.equal(bad((p) => { p.flight.arrival.quality = ['live', 'approximate']; }), 'accepted');
});

test('validator: a backend error payload passes its error code through as the reason', () => {
  assert.deepEqual(validateFlightInfo({ ok: false, error: 'provider-rate-limited' }), { ok: false, reason: 'provider-rate-limited' });
  assert.deepEqual(validateFlightInfo({ ok: false }), { ok: false, reason: 'backend-refused' });
});

// ---------- adapter ----------

const view = (flight, now = T0, over = {}) => adaptFlightInfo(wire(over, flight), { now });

test('adapter: both gates available, shape is exactly the view model', () => {
  const v = view(wireFlight({}, { terminal: '1', revised: T0 + 3 * HOUR, runway: T0 + 3 * HOUR + 10 * MIN }, { terminal: '2' }));
  assert.deepEqual(Object.keys(v), ['found', 'fetchedAt', 'lastUpdated', 'stale', 'flightNumber', 'status', 'provenance', 'departure', 'arrival', 'attribution']);
  assert.deepEqual(Object.keys(v.departure), ['airport', 'scheduled', 'revised', 'runway', 'terminal', 'gate', 'desk', 'quality', 'gateState']);
  assert.deepEqual(Object.keys(v.arrival), ['airport', 'scheduled', 'revised', 'runway', 'terminal', 'gate', 'belt', 'quality', 'gateState']);
  assert.equal(v.found, true);
  assert.equal(v.provenance, 'provider');
  assert.equal(v.flightNumber, 'XX1234');
  assert.equal(v.departure.gate, 'A12');
  assert.equal(v.departure.gateState, GATE_STATE.AVAILABLE);
  assert.equal(v.arrival.gate, 'B7');
  assert.equal(v.arrival.belt, '3');
  assert.equal(v.arrival.gateState, GATE_STATE.AVAILABLE);
  assert.equal(v.departure.revised, T0 + 3 * HOUR);
  assert.equal(v.departure.scheduled, T0 + 2 * HOUR); // provider schedule is passed through untouched
  assert.equal(v.stale, false);
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.departure) && Object.isFrozen(v.arrival.quality));
});

test('adapter: contains no roster fields', () => {
  const v = view(wireFlight());
  const names = JSON.stringify([...Object.keys(v), ...Object.keys(v.departure), ...Object.keys(v.arrival)]);
  assert.doesNotMatch(names, /roster|sector|dep"|arr"|originTz|destTz|pickup|duty/i);
});

test('adapter: gate state is pending only with live quality and an open status', () => {
  const noGate = (status, depQ, arrQ) => view(wireFlight({ status }, { gate: null, quality: depQ }, { gate: null, quality: arrQ }));
  // departure gate present, arrival gate missing
  const dep = (arrQ, status = 'scheduled') => view(wireFlight({ status }, {}, { gate: null, quality: arrQ }));
  assert.equal(dep(['basic', 'live']).arrival.gateState, GATE_STATE.PENDING);
  assert.equal(dep(['live']).arrival.gateState, GATE_STATE.PENDING);
  assert.equal(dep(['basic']).arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep(['approximate']).arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep([]).arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep(['basic', 'live'], 'departed').arrival.gateState, GATE_STATE.PENDING); // arrival gate still to come
  assert.equal(dep(['basic', 'live'], 'arrived').arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep(['basic', 'live'], 'diverted').arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep(['basic', 'live'], 'cancelled').arrival.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(dep(['basic', 'live'], 'delayed').arrival.gateState, GATE_STATE.PENDING);
  assert.equal(dep(['basic', 'live'], 'unknown').arrival.gateState, GATE_STATE.UNAVAILABLE); // unknown status supports no reading
  // departure leg
  assert.equal(noGate('scheduled', ['live'], []).departure.gateState, GATE_STATE.PENDING);
  assert.equal(noGate('boarding', ['live'], []).departure.gateState, GATE_STATE.UNAVAILABLE); // boarding/gate closed: not "not assigned yet"
  assert.equal(noGate('scheduled', ['basic'], ['live']).departure.gateState, GATE_STATE.UNAVAILABLE);
  for (const status of ['departed', 'arrived', 'diverted', 'cancelled']) assert.equal(noGate(status, ['live'], ['live']).departure.gateState, GATE_STATE.UNAVAILABLE, status);
});

test('adapter: neither gate, and a gate that exists always wins over quality and status', () => {
  const none = view(wireFlight({}, { gate: null, quality: ['basic'] }, { gate: null, quality: ['basic'] }));
  assert.equal(none.departure.gate, null);
  assert.equal(none.arrival.gate, null);
  assert.equal(none.departure.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(none.arrival.gateState, GATE_STATE.UNAVAILABLE);
  const cancelledWithGate = view(wireFlight({ status: 'cancelled' }, { quality: [] }));
  assert.equal(cancelledWithGate.departure.gate, 'A12');
  assert.equal(cancelledWithGate.departure.gateState, GATE_STATE.AVAILABLE);
});

test('adapter: a cancelled flight never reads as "not assigned yet"', () => {
  const v = view(wireFlight({ status: 'cancelled' }, { gate: null, quality: ['basic', 'live'] }, { gate: null, quality: ['basic', 'live'] }));
  assert.equal(v.status, 'cancelled');
  assert.equal(v.departure.gateState, GATE_STATE.UNAVAILABLE);
  assert.equal(v.arrival.gateState, GATE_STATE.UNAVAILABLE);
});

test('adapter: not found keeps only found, fetchedAt and stale', () => {
  const v = adaptFlightInfo(notFound(), { now: T0 + MIN });
  assert.deepEqual({ ...v }, { found: false, fetchedAt: T0, stale: false, attribution: null });
  assert.equal(adaptFlightInfo(notFound(), { now: T0 + STALE_FETCH_MS + 1 }).stale, true);
});

test('adapter: stale by fetch age (strictly older than 15 min)', () => {
  assert.equal(STALE_FETCH_MS, 15 * MIN);
  assert.equal(view(wireFlight(), T0 + STALE_FETCH_MS).stale, false);
  assert.equal(view(wireFlight(), T0 + STALE_FETCH_MS + 1).stale, true);
  assert.equal(view(wireFlight(), T0 - HOUR).stale, false); // clock skew never counts as stale
});

test('adapter: stale by lastUpdated only when departure is within 12 h of now', () => {
  assert.equal(STALE_UPDATE_MS, 6 * HOUR);
  const now = T0;
  const fresh = { fetchedAt: now }; // fetch age alone is not the cause here
  const near = (lastUpdated, scheduled) => view(wireFlight({ lastUpdated }, { scheduled }), now, fresh).stale;
  assert.equal(near(now - 7 * HOUR, now + 2 * HOUR), true);
  assert.equal(near(now - 6 * HOUR, now + 2 * HOUR), false); // not strictly older than 6 h
  assert.equal(near(now - 7 * HOUR, now + 12 * HOUR), true); // boundary is inclusive
  assert.equal(near(now - 7 * HOUR, now + 12 * HOUR + 1), false);
  assert.equal(near(now - 7 * HOUR, now - 12 * HOUR), true); // recently departed counts too
  assert.equal(near(now - 7 * HOUR, now - 12 * HOUR - 1), false);
  assert.equal(near(null, now + 2 * HOUR), false); // no lastUpdated: this rule does not apply
  assert.equal(near(now - 7 * HOUR, null), false); // no scheduled time: cannot judge nearness
});

// ---------- loader ----------

test('loader: first call posts the token in the body only and returns the adapted view', async () => {
  const b = backend();
  const v = await loadFlightInfo(INPUT, { fetchImpl: b.fetchImpl, now: () => T0 });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, ENDPOINT);
  assert.equal(b.calls[0].url.includes(TOKEN), false);
  assert.deepEqual(b.calls[0].body, { contract: 'fc.roster', version: 2, action: 'flight', token: TOKEN, flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' });
  assert.equal(v.found, true);
  assert.equal(v.departure.gate, 'A12');
  assert.equal(FLIGHT_TIMEOUT_MS, 30000);
});

test('loader: cache hit costs no second request', async () => {
  const b = backend();
  let t = T0;
  const opts = { fetchImpl: b.fetchImpl, now: () => t };
  await loadFlightInfo(INPUT, opts);
  t += FLIGHT_TTL_MS - 1;
  const again = await loadFlightInfo(INPUT, opts);
  assert.equal(b.calls.length, 1);
  assert.equal(again.departure.gate, 'A12');
  // a sector that maps to the same query shares the entry
  await loadFlightInfo({ ...INPUT, sector: { ...SECTOR, flightNumber: 'xx 01234' } }, opts);
  assert.equal(b.calls.length, 1);
});

test('loader: after the TTL the flight is refetched and a changed gate shows', async () => {
  assert.equal(FLIGHT_TTL_MS, 5 * MIN);
  let gate = 'A12';
  const b = backend((body) => echo(body, {}, wireFlight({ flightNumber: body.flightNumber }, { gate })));
  let t = T0;
  const opts = { fetchImpl: b.fetchImpl, now: () => t };
  assert.equal((await loadFlightInfo(INPUT, opts)).departure.gate, 'A12');
  gate = 'C40';
  t += FLIGHT_TTL_MS;
  assert.equal((await loadFlightInfo(INPUT, opts)).departure.gate, 'C40');
  assert.equal(b.calls.length, 2);
});

test('loader: force refetches inside the TTL', async () => {
  let gate = 'A12';
  const b = backend((body) => echo(body, {}, wireFlight({ flightNumber: body.flightNumber }, { gate })));
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  await loadFlightInfo(INPUT, opts);
  gate = 'D9';
  const forced = await loadFlightInfo(INPUT, { ...opts, force: true });
  assert.equal(b.calls.length, 2);
  assert.equal(forced.departure.gate, 'D9');
  assert.equal((await loadFlightInfo(INPUT, opts)).departure.gate, 'D9'); // the forced answer was cached
  assert.equal(b.calls.length, 2);
});

test('loader: concurrent identical calls share one request (force joins too)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const b = backend(async (body) => { await gate; return echo(body); });
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  const a = loadFlightInfo(INPUT, opts);
  const c = loadFlightInfo(INPUT, opts);
  const d = loadFlightInfo(INPUT, { ...opts, force: true });
  release();
  const [ra, rc, rd] = await Promise.all([a, c, d]);
  assert.equal(b.calls.length, 1);
  assert.equal(ra.departure.gate, 'A12');
  assert.deepEqual(rc, ra);
  assert.deepEqual(rd, ra);
  // a different flight is a different request
  await loadFlightInfo({ ...INPUT, sector: { ...SECTOR, flightNumber: 'XX4321' } }, { ...opts });
  assert.equal(b.calls.length, 2);
});

test('loader: accessKey separates cache entries', async () => {
  const b = backend();
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  await loadFlightInfo(INPUT, { ...opts, accessKey: 'one' });
  await loadFlightInfo(INPUT, { ...opts, accessKey: 'two' });
  await loadFlightInfo(INPUT, { ...opts, accessKey: 'one' });
  assert.equal(b.calls.length, 2);
});

test('loader: not-found is cached and keeps the roster out of it', async () => {
  const b = backend((body) => echo(body, { found: false, flight: null }));
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  const first = await loadFlightInfo(INPUT, opts);
  const second = await loadFlightInfo(INPUT, opts);
  assert.equal(b.calls.length, 1);
  assert.deepEqual({ ...first }, { found: false, fetchedAt: T0, stale: false, attribution: null });
  assert.deepEqual(second, first);
});

test('loader: stale is recomputed against the current time on every return', async () => {
  const b = backend((body) => echo(body, { fetchedAt: T0 - 14 * MIN }));
  let t = T0;
  const opts = { fetchImpl: b.fetchImpl, now: () => t };
  assert.equal((await loadFlightInfo(INPUT, opts)).stale, false);
  t += 2 * MIN; // cache hit, but the provider data is now 16 min old
  const later = await loadFlightInfo(INPUT, opts);
  assert.equal(b.calls.length, 1);
  assert.equal(later.stale, true);
});

test('loader: the cache holds at most 16 flights, oldest evicted', async () => {
  assert.equal(FLIGHT_MAX_ENTRIES, 16);
  const b = backend();
  let t = T0;
  const opts = { fetchImpl: b.fetchImpl, now: () => t };
  const sector = (n) => ({ ...SECTOR, flightNumber: `XX${1000 + n}` });
  for (let n = 0; n < 17; n += 1) { t = T0 + n; await loadFlightInfo({ ...INPUT, sector: sector(n) }, opts); }
  assert.equal(b.calls.length, 17);
  await loadFlightInfo({ ...INPUT, sector: sector(16) }, opts); // newest still cached
  await loadFlightInfo({ ...INPUT, sector: sector(1) }, opts); // still cached
  assert.equal(b.calls.length, 17);
  await loadFlightInfo({ ...INPUT, sector: sector(0) }, opts); // evicted: refetched
  assert.equal(b.calls.length, 18);
});

test('loader: backend refusals, invalid responses and transport failures are thrown and never cached', async () => {
  const cases = [
    ['provider-rate-limited', () => ({ ok: false, error: 'provider-rate-limited' })],
    ['provider-unavailable', () => ({ ok: false, error: 'provider-unavailable' })],
    ['flight-ambiguous', () => ({ ok: false, error: 'flight-ambiguous' })],
    ['invalid-response', (body) => echo(body, { extra: true })],
    ['invalid-response', () => ({ ok: false, error: 'Not A Code!' })],
    ['invalid-response', (body) => echo(body, { query: { flightNumber: 'XX9999', date: body.date, origin: body.origin } })], // answers another flight
    ['invalid-response', (body) => echo(body, { query: { flightNumber: body.flightNumber, date: '2026-10-09', origin: body.origin } })],
    ['invalid-response', () => 'text'],
  ];
  for (const [code, respond] of cases) {
    purgeFlightInfoCache();
    let failing = true;
    const b = backend((body, n) => (failing ? respond(body, n) : echo(body)));
    const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
    await assert.rejects(loadFlightInfo(INPUT, opts), (e) => e instanceof FlightInfoError && e.code === code, code);
    failing = false;
    const ok = await loadFlightInfo(INPUT, opts); // next call refetches
    assert.equal(b.calls.length, 2, code);
    assert.equal(ok.found, true);
  }
});

test('loader: a failed request is not served to a joined caller as a result, and the next call retries', async () => {
  let n = 0;
  const b = backend((body) => (n++ === 0 ? { ok: false, error: 'provider-rate-limited' } : echo(body)));
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  const [x, y] = await Promise.allSettled([loadFlightInfo(INPUT, opts), loadFlightInfo(INPUT, opts)]);
  assert.equal(x.status, 'rejected');
  assert.equal(y.status, 'rejected');
  assert.equal(b.calls.length, 1);
  assert.equal((await loadFlightInfo(INPUT, opts)).found, true);
  assert.equal(b.calls.length, 2);
});

test('loader: network failure, timeout and HTTP errors surface their transport code', async () => {
  const run = async (fetchImpl) => loadFlightInfo(INPUT, { fetchImpl, now: () => T0 }).then(() => 'resolved', (e) => `${e.name}:${e.code}`);
  assert.equal(await run(async () => { throw new TypeError('offline'); }), 'FlightInfoError:network');
  assert.equal(await run(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }), 'FlightInfoError:timeout');
  assert.equal(await run(async () => ({ ok: false, status: 500, text: async () => '' })), 'FlightInfoError:http');
  assert.equal(await run(async () => ({ ok: true, status: 200, text: async () => '<html>' })), 'FlightInfoError:html-response');
  assert.equal(await run(async () => ({ ok: true, status: 200, text: async () => 'nope' })), 'FlightInfoError:invalid-json');
});

test('loader: local refusals make no request', async () => {
  const b = backend();
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  const code = (input) => loadFlightInfo(input, opts).then(() => 'resolved', (e) => e.code);
  assert.equal(await code({ ...INPUT, endpoint: '' }), 'not-configured');
  assert.equal(await code({ ...INPUT, endpoint: undefined }), 'not-configured');
  assert.equal(await code({ ...INPUT, token: '' }), 'auth-required');
  assert.equal(await code({ ...INPUT, token: null }), 'auth-required');
  assert.equal(await code({ ...INPUT, sector: { ...SECTOR, originTz: null } }), 'bad-request');
  assert.equal(await code({ ...INPUT, sector: { ...SECTOR, flightNumber: 'x' } }), 'bad-request');
  assert.equal(await code({ ...INPUT, sector: null }), 'bad-request');
  assert.equal(await code({ ...INPUT, endpoint: 'https://example.invalid/exec' }), 'invalid-endpoint');
  assert.equal(b.calls.length, 0);
});

test('loader: shouldStore false discards the answer and caches nothing', async () => {
  const b = backend();
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  await assert.rejects(loadFlightInfo(INPUT, { ...opts, shouldStore: () => false }), (e) => e.code === 'access-changed');
  await loadFlightInfo(INPUT, opts); // not served from cache: refetches
  assert.equal(b.calls.length, 2);
  await loadFlightInfo(INPUT, opts);
  assert.equal(b.calls.length, 2);
});

test('loader: purge clears the cache and discards requests still running', async () => {
  const b = backend();
  const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
  await loadFlightInfo(INPUT, opts);
  purgeFlightInfoCache();
  await loadFlightInfo(INPUT, opts);
  assert.equal(b.calls.length, 2);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = backend(async (body) => { await gate; return echo(body); });
  purgeFlightInfoCache();
  const running = loadFlightInfo(INPUT, { fetchImpl: slow.fetchImpl, now: () => T0 });
  purgeFlightInfoCache();
  release();
  await assert.rejects(running, (e) => e.code === 'access-changed');
  await loadFlightInfo(INPUT, { fetchImpl: slow.fetchImpl, now: () => T0 }); // nothing was cached by the discarded run
  assert.equal(slow.calls.length, 2);
});

test('loader: only memory is used, no device storage is touched', async () => {
  const touched = [];
  const names = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { touched.push(name); throw new Error(`${name} used`); } });
  }
  try {
    const b = backend();
    const opts = { fetchImpl: b.fetchImpl, now: () => T0 };
    await loadFlightInfo(INPUT, opts);
    await loadFlightInfo(INPUT, opts);
    await loadFlightInfo(INPUT, { ...opts, force: true });
    purgeFlightInfoCache();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
  assert.deepEqual(touched, []);
  for (const file of ['src/sources/flight-info-service.js', 'src/sources/flight-info-v2.js']) {
    assert.doesNotMatch(readFileSync(join(ROOT, file), 'utf8'), /localStorage|sessionStorage|indexedDB|caches\.|store\.js/, file);
  }
});

test('stale: flights more than 24 h away use the 3 h fetch-age rule (server caches them for 30 min)', async () => {
  const { STALE_FETCH_FAR_MS, STALE_FAR_FROM_MS } = await import('../src/sources/flight-info-v2.js');
  assert.equal(STALE_FETCH_FAR_MS, 3 * HOUR);
  assert.equal(STALE_FAR_FROM_MS, 24 * HOUR);
  const far = wireFlight({ lastUpdated: null }, { scheduled: T0 + 3 * 24 * HOUR }, { scheduled: T0 + 3 * 24 * HOUR + 3 * HOUR });
  assert.equal(adaptFlightInfo(wire({}, far), { now: T0 + 40 * MIN }).stale, false);
  assert.equal(adaptFlightInfo(wire({}, far), { now: T0 + 3 * HOUR + 1 }).stale, true);
});

test('pending gate: boarding/unknown departures and finished arrivals are "unavailable", not "not assigned yet"', () => {
  const st = (status, dep = {}, arr = {}) => adaptFlightInfo(wire({}, wireFlight({ status }, { gate: null, ...dep }, { gate: null, ...arr })), { now: T0 });
  assert.equal(st('scheduled').departure.gateState, 'pending');
  assert.equal(st('boarding').departure.gateState, 'unavailable');
  assert.equal(st('unknown').departure.gateState, 'unavailable');
  assert.equal(st('departed').arrival.gateState, 'pending');
  assert.equal(st('arrived').arrival.gateState, 'unavailable');
});
