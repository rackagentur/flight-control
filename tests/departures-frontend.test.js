// Phase 3 (frontend): ScheduledFlight model, departures request/validator/adapter, cached service,
// airline context and the instant-based window filter. No UI. Fixture: departures-v2.synthetic.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { departuresRequest, validateDepartures, adaptDepartures } from '../src/sources/departures-v2.js';
import { loadDepartures, purgeDeparturesCache, DEPARTURES_CACHE_KEY, DEPARTURES_TIMEOUT_MS, DeparturesError } from '../src/sources/departures-service.js';
import { departuresContext, rangeForWindow, inWindow } from '../src/model/scheduled-flights.js';
import { ApiError } from '../src/api/appscript.js';
import { createStore } from '../src/store.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { normalizeProfile } from '../src/config/profile.js';
import { offsetMinutes, startOfLocalDay } from '../src/lib/time.js';
import { PROFILE, loadFixture, at } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = () => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/departures-v2.synthetic.json'), 'utf8'));
const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const FX = fixture();
const Q = { endpoint: ENDPOINT, token: TOKEN, airport: 'FRA', from: FX.from, to: FX.to, carriers: ['DE'] };
const HOUR = 3600000;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
const freshStore = () => createStore(memoryStorage());

/** Fake backend: echoes the request into a valid payload. Records calls. */
function backend(mutate = null) {
  const calls = [];
  const postContract = async (endpoint, body) => {
    calls.push({ endpoint, body });
    const p = fixture();
    p.airport = body.airport; p.from = body.from; p.to = body.to; p.carriers = body.carriers ?? null;
    if (mutate) return { data: mutate(p, body, calls.length) ?? p, meta: {} };
    return { data: p, meta: {} };
  };
  return { calls, api: { postContract } };
}

// ---------- fixture ----------

test('fixture is synthetic, valid, and covers the awkward cases', () => {
  assert.equal(FX._synthetic, true);
  assert.deepEqual(validateDepartures(FX), { ok: true });
  const f = FX.flights;
  assert.ok(f.some((x) => x.status === 'cancelled'));
  assert.ok(f.some((x) => x.revisedDep !== null && x.status === 'delayed'));
  assert.ok(f.some((x) => x.destination === null));
  assert.ok(f.some((x) => x.destination === 'ZZZ'));
  assert.ok(f.some((x) => x.aircraft === null));
  assert.ok(f.every((x) => /^DE9\d{3}$/.test(x.flightNumber) && /^f_[0-9a-f]{16}$/.test(x.id)));
});

// ---------- request ----------

test('request: contract envelope, token only in the body, carriers optional', () => {
  const body = departuresRequest({ airport: 'FRA', from: 1, to: 2, carriers: ['DE'] }, TOKEN);
  assert.deepEqual(body, { contract: 'fc.roster', version: 2, action: 'departures', token: TOKEN, airport: 'FRA', from: 1, to: 2, carriers: ['DE'] });
  const none = departuresRequest({ airport: 'FRA', from: 1, to: 2, carriers: null }, TOKEN);
  assert.equal('carriers' in none, false);
  assert.equal(JSON.stringify(Object.entries(none).filter(([k]) => k !== 'token')).includes(TOKEN), false);
});

test('request: the service posts the token in the body only, never in the URL', async () => {
  const b = backend();
  await loadDepartures(Q, { api: b.api, store: freshStore() });
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].endpoint, ENDPOINT);
  assert.equal(b.calls[0].endpoint.includes(TOKEN), false);
  assert.equal(b.calls[0].body.token, TOKEN);
  assert.equal(b.calls[0].body.action, 'departures');
});

// ---------- validator ----------

test('validator: accepts the fixture and an empty flight list', () => {
  assert.deepEqual(validateDepartures(FX), { ok: true });
  assert.deepEqual(validateDepartures({ ...FX, flights: [], carriers: null }), { ok: true });
});

test('validator: rejects malformed payloads with a reason', () => {
  const bad = (mutate) => { const p = fixture(); mutate(p); return validateDepartures(p); };
  const reason = (r) => (r.ok ? 'accepted' : r.reason);
  assert.equal(reason(validateDepartures(null)), 'not-an-object');
  assert.equal(reason(validateDepartures('x')), 'not-an-object');
  assert.equal(reason(bad((p) => { p.contract = 'other'; })), 'contract-mismatch');
  assert.equal(reason(bad((p) => { p.version = 5; })), 'contract-mismatch');
  assert.equal(reason(bad((p) => { p.action = 'roster'; })), 'wrong-action');
  assert.equal(reason(bad((p) => { p.airport = 'fra'; })), 'bad-airport');
  assert.equal(reason(bad((p) => { p.from = 'x'; })), 'bad-range');
  assert.equal(reason(bad((p) => { p.to = Infinity; })), 'bad-range');
  assert.equal(reason(bad((p) => { p.to = p.from; })), 'bad-range');
  assert.equal(reason(bad((p) => { delete p.flights; })), 'missing-flights');
  assert.equal(reason(bad((p) => { p.flights = {}; })), 'missing-flights');
  assert.equal(reason(bad((p) => { delete p.provider; })), 'bad-meta');
  assert.equal(reason(bad((p) => { p.fetchedAt = null; })), 'bad-meta');
  assert.equal(reason(bad((p) => { p.carriers = ['de']; })), 'bad-carriers');
  assert.equal(reason(bad((p) => { p.flights[0].id = 5; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].flightNumber = null; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].origin = 'Frankfurt'; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].scheduledDep = NaN; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].scheduledDep = '1791259200000'; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].revisedDep = undefined; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].destination = 'Palma'; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].aircraft = { model: 3, registration: null }; })), 'bad-flight');
  assert.equal(reason(bad((p) => { p.flights[0].status = 'on-time'; })), 'bad-status');
  assert.equal(reason(bad((p) => { p.flights[0].provenance = 'source'; })), 'bad-provenance');
  assert.equal(reason(bad((p) => { p.flights[0] = null; })), 'bad-flight');
});

test('validator: a backend error payload passes its error code through as the reason', () => {
  assert.deepEqual(validateDepartures({ ok: false, error: 'provider-rate-limited' }), { ok: false, reason: 'provider-rate-limited' });
  assert.deepEqual(validateDepartures({ ok: false }), { ok: false, reason: 'backend-refused' });
});

// ---------- adapter ----------

test('adapter: tz from the V2 airport table (never the payload), unknown airport -> null, frozen', () => {
  const p = fixture();
  p.flights[0].originTz = 'Pacific/Auckland';   // a hostile or buggy payload field must be ignored
  p.flights[0].destTz = 'Pacific/Auckland';
  const r = adaptDepartures(p);
  const by = (fn) => r.flights.find((f) => f.flightNumber === fn);
  const pmi = by('DE9101');
  assert.equal(pmi.originTz, 'Europe/Berlin');
  assert.equal(pmi.destTz, 'Europe/Madrid');
  assert.equal(by('DE9411').destTz, null, 'ZZZ is not in our table');
  assert.equal(by('DE9310').destination, null);
  assert.equal(by('DE9310').destTz, null);
  assert.equal(r.airportTz, 'Europe/Berlin');
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.flights) && Object.isFrozen(r.carriers));
  assert.ok(r.flights.every((f) => Object.isFrozen(f) && f.provenance === 'provider'));
  assert.ok(Object.isFrozen(by('DE9101').aircraft));
  assert.equal(by('DE9500').aircraft, null);
  assert.equal('fromCache' in r, false);
});

test('adapter: copies only known fields; nothing extra leaks; roster-only fields never appear', () => {
  const p = fixture();
  p.flights[0].secret = 'x';
  p.flights[0].pickup = 1;
  p.flights[0].aircraft.extra = 'y';
  p.extra = 'z';
  const r = adaptDepartures(p);
  assert.deepEqual(Object.keys(r).sort(), ['airport', 'airportTz', 'carriers', 'dropped', 'fetchedAt', 'flights', 'from', 'generatedAt', 'provider', 'to']);
  assert.deepEqual(Object.keys(r.flights[0]).sort(), ['aircraft', 'carrier', 'destTz', 'destination', 'destinationName', 'flightNumber', 'id', 'origin', 'originTz', 'provenance', 'revisedDep', 'scheduledDep', 'status']);
  assert.deepEqual(Object.keys(r.flights.find((f) => f.flightNumber === 'DE9101').aircraft).sort(), ['model', 'registration']);
  for (const f of r.flights) for (const k of ['pickup', 'report', 'dep', 'arr', 'blockMin', 'duty', 'legacy']) assert.equal(k in f, false, k);
});

test('adapter: provider label is passed through verbatim as an opaque string; carriers null stays null', () => {
  const r = adaptDepartures({ ...fixture(), provider: 'opaque-label-7', carriers: null });
  assert.equal(r.provider, 'opaque-label-7');
  assert.equal(r.carriers, null);
});

// ---------- service ----------

test('service: loads, adapts, reports fromCache=false, and stores the entry', async () => {
  const b = backend(); const store = freshStore();
  const r = await loadDepartures(Q, { api: b.api, store, now: () => 1000 });
  assert.equal(r.fromCache, false);
  assert.equal(r.flights.length, FX.flights.length);
  assert.ok(Object.isFrozen(r));
  const cache = store.getJSON(DEPARTURES_CACHE_KEY);
  const key = `FRA|${FX.from}|${FX.to}|DE`;
  assert.deepEqual(Object.keys(cache.entries), [key]);
  assert.equal(cache.entries[key].storedAt, 1000);
  assert.equal(cache.entries[key].fetchedAt, FX.fetchedAt);
  assert.equal(cache.entries[key].payload.airport, 'FRA');
});

test('service: cache hit within TTL (no request), miss at and after TTL', async () => {
  const b = backend(); const store = freshStore(); let t = 10000;
  const deps = { api: b.api, store, now: () => t };
  await loadDepartures(Q, deps);
  t += 299999;
  const hit = await loadDepartures(Q, deps);
  assert.equal(hit.fromCache, true);
  assert.equal(b.calls.length, 1);
  assert.equal(hit.flights.length, FX.flights.length);
  assert.ok(hit.flights.every((f) => Object.isFrozen(f)));
  t += 1;   // exactly 5 min since storedAt
  const miss = await loadDepartures(Q, deps);
  assert.equal(miss.fromCache, false);
  assert.equal(b.calls.length, 2);
});

test('service: a custom ttlMs is honoured', async () => {
  const b = backend(); const store = freshStore(); let t = 0;
  const deps = { api: b.api, store, now: () => t, ttlMs: 1000 };
  await loadDepartures(Q, deps);
  t = 999; assert.equal((await loadDepartures(Q, deps)).fromCache, true);
  t = 1000; assert.equal((await loadDepartures(Q, deps)).fromCache, false);
});

test('service: the cache key includes carriers (order-insensitive), airport and range', async () => {
  const b = backend(); const store = freshStore();
  const deps = { api: b.api, store, now: () => 5 };
  await loadDepartures(Q, deps);
  await loadDepartures({ ...Q, carriers: null }, deps);
  await loadDepartures({ ...Q, carriers: ['EW', 'DE'] }, deps);
  assert.equal(b.calls.length, 3);
  assert.equal((await loadDepartures({ ...Q, carriers: ['DE', 'EW', 'DE'] }, deps)).fromCache, true, 'sorted and de-duplicated');
  assert.equal(b.calls.length, 3);
  await loadDepartures({ ...Q, airport: 'CGN' }, deps);
  await loadDepartures({ ...Q, to: Q.to - 60000 }, deps);
  assert.equal(b.calls.length, 5);
  const keys = Object.keys(store.getJSON(DEPARTURES_CACHE_KEY).entries);
  assert.ok(keys.includes(`FRA|${FX.from}|${FX.to}|*`));
  assert.ok(keys.includes(`FRA|${FX.from}|${FX.to}|DE,EW`));
  assert.deepEqual(b.calls[2].body.carriers, ['DE', 'EW'], 'normalized carriers are what is requested');
});

test('service: at most 8 entries; the oldest storedAt is evicted', async () => {
  const b = backend(); const store = freshStore(); let t = 1000;
  const deps = { api: b.api, store, now: () => t };
  const range = (i) => ({ ...Q, from: FX.from + i * 60000, to: FX.from + i * 60000 + HOUR });
  for (let i = 0; i < 9; i += 1) { t += 1000; await loadDepartures(range(i), deps); }
  const keys = Object.keys(store.getJSON(DEPARTURES_CACHE_KEY).entries);
  assert.equal(keys.length, 8);
  assert.equal(keys.some((k) => k.includes(`|${FX.from}|`)), false, 'entry 0 (oldest) evicted');
  assert.ok(keys.some((k) => k.includes(`|${range(8).from}|`)), 'newest kept');
  const callsBefore = b.calls.length;
  assert.equal((await loadDepartures(range(1), deps)).fromCache, true);
  assert.equal(b.calls.length, callsBefore);
});

test('service: the request is posted with an explicit 60 s timeout (up to three provider calls run behind it)', async () => {
  assert.equal(DEPARTURES_TIMEOUT_MS, 60000);
  const seen = [];
  const api = { postContract: async (endpoint, body, options) => {
    seen.push(options);
    const p = fixture(); p.carriers = body.carriers; return { data: p, meta: {} };
  } };
  await loadDepartures(Q, { api, store: freshStore() });
  assert.deepEqual(seen, [{ timeoutMs: 60000 }]);
});

test('service: failures are never cached; a later success is served from the network', async () => {
  const store = freshStore(); let mode = 'fail'; let n = 0;
  const api = { postContract: async (endpoint, body) => {
    n += 1;
    if (mode === 'fail') throw new ApiError('timeout', 'slow');
    const p = fixture(); p.carriers = body.carriers; return { data: p, meta: {} };
  } };
  await assert.rejects(loadDepartures(Q, { api, store }), (e) => e instanceof ApiError && e.code === 'timeout');
  assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
  mode = 'ok';
  assert.equal((await loadDepartures(Q, { api, store })).fromCache, false);
  assert.equal(n, 2);
  // a failure after a success does not evict or overwrite the good entry
  mode = 'fail';
  assert.equal((await loadDepartures(Q, { api, store })).fromCache, true);
});

test('service: backend {ok:false} codes are surfaced as DeparturesError.code and not cached', async () => {
  for (const code of ['provider-rate-limited', 'provider-auth-failed', 'provider-unavailable', 'departures-not-configured', 'unauthorized', 'range-out-of-bounds', 'unknown-airport', 'bad-request']) {
    const store = freshStore();
    const api = { postContract: async () => ({ data: { ok: false, error: code }, meta: {} }) };
    await assert.rejects(loadDepartures(Q, { api, store }), (e) => e instanceof DeparturesError && e.code === code, code);
    assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
  }
});

test('service: transport ApiError is surfaced unchanged (code preserved)', async () => {
  for (const code of ['network', 'timeout', 'http', 'html-response', 'invalid-json']) {
    const err = new ApiError(code, 'x');
    const api = { postContract: async () => { throw err; } };
    await assert.rejects(loadDepartures(Q, { api, store: freshStore() }), (e) => e === err && e.code === code);
  }
  const api = { postContract: async () => { throw new TypeError('boom'); } };
  await assert.rejects(loadDepartures(Q, { api, store: freshStore() }), (e) => e instanceof ApiError && e.code === 'network');
});

test('service: an invalid or mismatched response is refused as invalid-response and not cached', async () => {
  const cases = {
    'bad flight': (p) => { p.flights[0].status = 'nope'; },
    'wrong action': (p) => { p.action = 'roster'; },
    'other airport': (p) => { p.airport = 'CGN'; },
    'other range': (p) => { p.to += 1; },
    'other carriers': (p) => { p.carriers = null; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const store = freshStore();
    const api = { postContract: async (e, body) => { const p = fixture(); p.carriers = body.carriers; mutate(p); return { data: p, meta: {} }; } };
    await assert.rejects(loadDepartures(Q, { api, store }), (e) => e instanceof DeparturesError && e.code === 'invalid-response', name);
    assert.equal(store.get(DEPARTURES_CACHE_KEY), null, name);
  }
  const api = { postContract: async () => ({ data: null, meta: {} }) };
  await assert.rejects(loadDepartures(Q, { api, store: freshStore() }), (e) => e.code === 'invalid-response');
});

test('service: a corrupt or foreign cache is ignored (treated as a miss), not an error', async () => {
  const b = backend(); const store = freshStore();
  store.set(DEPARTURES_CACHE_KEY, '{not json');
  assert.equal((await loadDepartures(Q, { api: b.api, store, now: () => 1 })).fromCache, false);
  store.setJSON(DEPARTURES_CACHE_KEY, { entries: { [`FRA|${FX.from}|${FX.to}|DE`]: { fetchedAt: 1, storedAt: 1, payload: { ok: true } } } });
  assert.equal((await loadDepartures(Q, { api: b.api, store, now: () => 2 })).fromCache, false);
  store.setJSON(DEPARTURES_CACHE_KEY, { entries: { [`FRA|${FX.from}|${FX.to}|DE`]: { fetchedAt: 1, storedAt: 100, payload: fixture() } } });
  assert.equal((await loadDepartures(Q, { api: b.api, store, now: () => 50 })).fromCache, false, 'storedAt in the future is not trusted');
});

test('service: works without a store (no caching)', async () => {
  const b = backend();
  await loadDepartures(Q, { api: b.api, store: null });
  await loadDepartures(Q, { api: b.api, store: null });
  assert.equal(b.calls.length, 2);
});

test('service: input validation refuses before any network call', async () => {
  const b = backend(); const deps = { api: b.api, store: freshStore() };
  const cases = [
    [{ airport: 'fra' }, 'unknown-airport'],
    [{ airport: 'FRAX' }, 'unknown-airport'],
    [{ airport: null }, 'unknown-airport'],
    [{ from: NaN }, 'bad-range'],
    [{ to: Infinity }, 'bad-range'],
    [{ from: '1' }, 'bad-range'],
    [{ to: Q.from }, 'bad-range'],
    [{ to: Q.from - 1 }, 'bad-range'],
    [{ to: Q.from + 24 * HOUR + 1 }, 'range-too-long'],
    [{ carriers: [] }, 'bad-request'],
    [{ carriers: 'DE' }, 'bad-request'],
    [{ carriers: ['de'] }, 'bad-request'],
    [{ carriers: ['DEU'] }, 'bad-request'],
    [{ carriers: [1] }, 'bad-request'],
    [{ carriers: Array.from({ length: 11 }, (_, i) => `A${i}`) }, 'bad-request'],
    [{ token: '' }, 'bad-request'],
    [{ token: null }, 'bad-request'],
    [{ endpoint: '' }, 'bad-request'],
  ];
  for (const [patch, code] of cases) {
    await assert.rejects(loadDepartures({ ...Q, ...patch }, deps), (e) => e instanceof DeparturesError && e.code === code, JSON.stringify(patch));
  }
  assert.equal(b.calls.length, 0, 'no request was made');
  // exactly 24 h is allowed
  await loadDepartures({ ...Q, to: Q.from + 24 * HOUR }, deps);
  assert.equal(b.calls.length, 1);
});

test('service: purgeDeparturesCache removes only the departures key', async () => {
  const b = backend(); const store = freshStore();
  store.set('theme', 'dark');
  await loadDepartures(Q, { api: b.api, store });
  assert.ok(store.getJSON(DEPARTURES_CACHE_KEY));
  purgeDeparturesCache(store);
  assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(DEPARTURES_CACHE_KEY, 'departures.v2');
});

// ---------- controller purge ----------

function controllerWith(store) {
  const api = { fetchStats: async () => ({ data: loadFixture(), meta: {} }), postContract: async () => { throw new ApiError('html-response', 'no v2'); } };
  return createController({ profile: PROFILE, onChange: () => {}, store, api, clock: () => at(loadFixture()._now) });
}
const seedDepartures = async (store) => {
  store.set(ENDPOINT_KEY, ENDPOINT); store.set(TOKEN_KEY, TOKEN); store.set('theme', 'dark');
  await loadDepartures(Q, { api: backend().api, store });
  assert.ok(store.getJSON(DEPARTURES_CACHE_KEY));
};

test('controller: removing the token purges the departures cache, keeps theme and endpoint', async () => {
  const store = freshStore(); await seedDepartures(store);
  controllerWith(store).removeToken();
  assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(store.get(ENDPOINT_KEY), ENDPOINT);
});

test('controller: replacing the token (forgetContractData) purges the departures cache', async () => {
  const store = freshStore(); await seedDepartures(store);
  controllerWith(store).forgetContractData();
  assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
  assert.equal(store.get('theme'), 'dark');
});

test('controller: forgetRosterData (roster purge path) purges the departures cache', async () => {
  const store = freshStore(); await seedDepartures(store);
  controllerWith(store).forgetRosterData();
  assert.equal(store.get(DEPARTURES_CACHE_KEY), null);
});

// ---------- context ----------

test('context: Condor -> profile base and the DE designator; custom base respected', () => {
  assert.deepEqual(departuresContext(PROFILE), { airport: 'FRA', carriers: ['DE'] });
  const cgn = normalizeProfile({ airlineId: 'condor', base: 'MUC', homeBases: ['MUC'] });
  assert.deepEqual(departuresContext(cgn), { airport: 'MUC', carriers: ['DE'] });
});

test('context: generic or unknown airline -> carriers null; missing profile is safe', () => {
  assert.deepEqual(departuresContext(normalizeProfile({ airlineId: 'generic', base: 'CGN' })), { airport: 'CGN', carriers: null });
  assert.deepEqual(departuresContext(normalizeProfile({ airlineId: 'no-such-airline', base: 'DUS' })), { airport: 'DUS', carriers: null });
  assert.deepEqual(departuresContext(null), { airport: null, carriers: null });
});

test('context: the returned carriers cannot mutate the airline pack', () => {
  const ctx = departuresContext(PROFILE);
  assert.throws(() => { ctx.carriers.push('XX'); }, TypeError);
  assert.deepEqual(departuresContext(PROFILE).carriers, ['DE']);
});

// ---------- rangeForWindow ----------

const TZ = 'Europe/Berlin';
/** Berlin wall time -> instant (valid for times that exist exactly once; DST-safe, unlike midnight + n hours). */
function berlin(dateKey, h, m = 0) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  const t1 = wall - offsetMinutes(wall, TZ) * 60000;
  return wall - offsetMinutes(t1, TZ) * 60000;
}

test('rangeForWindow: normal and overnight windows return the instants unchanged', () => {
  assert.deepEqual(rangeForWindow({ start: 100, end: 200 }), { from: 100, to: 200 });
  const w = { start: berlin('2026-10-06', 22), end: berlin('2026-10-07', 6) };   // 22:00 -> 06:00 local, 8 h
  assert.equal(w.end - w.start, 8 * HOUR);
  assert.deepEqual(rangeForWindow(w), { from: w.start, to: w.end });
  assert.deepEqual(rangeForWindow({ start: 0, end: 24 * HOUR }), { from: 0, to: 24 * HOUR });
});

test('rangeForWindow: DST nights are measured in real time (2026-03-29 spring, 2026-10-25 autumn)', () => {
  const spring = { start: berlin('2026-03-28', 22), end: berlin('2026-03-29', 6) };
  assert.equal(spring.end - spring.start, 7 * HOUR, '02:00 -> 03:00 gap: only 7 real hours');
  assert.deepEqual(rangeForWindow(spring), { from: spring.start, to: spring.end });
  const autumn = { start: berlin('2026-10-24', 22), end: berlin('2026-10-25', 6) };
  assert.equal(autumn.end - autumn.start, 9 * HOUR, 'repeated hour: 9 real hours');
  assert.deepEqual(rangeForWindow(autumn), { from: autumn.start, to: autumn.end });
  // local midnight to midnight: 23 h in spring (allowed), 25 h in autumn (> 24 h -> null)
  assert.ok(rangeForWindow({ start: berlin('2026-03-29', 0), end: berlin('2026-03-30', 0) }));
  const longDay = { start: berlin('2026-10-25', 0), end: berlin('2026-10-26', 0) };
  assert.equal(longDay.end - longDay.start, 25 * HOUR);
  assert.equal(rangeForWindow(longDay), null);
});

test('rangeForWindow: longer than maxHours, zero/negative, non-finite and missing -> null', () => {
  assert.equal(rangeForWindow({ start: 0, end: 24 * HOUR + 1 }), null);
  assert.deepEqual(rangeForWindow({ start: 0, end: 12 * HOUR }, { maxHours: 12 }), { from: 0, to: 12 * HOUR });
  assert.equal(rangeForWindow({ start: 0, end: 12 * HOUR + 1 }, { maxHours: 12 }), null);
  assert.equal(rangeForWindow({ start: 5, end: 5 }), null);
  assert.equal(rangeForWindow({ start: 9, end: 5 }), null);
  assert.equal(rangeForWindow({ start: NaN, end: 5 }), null);
  assert.equal(rangeForWindow({ start: 0, end: Infinity }), null);
  assert.equal(rangeForWindow({ start: '0', end: 5 }), null);
  assert.equal(rangeForWindow(null), null);
  assert.equal(rangeForWindow(undefined), null);
  assert.equal(rangeForWindow({}), null);
  assert.equal(rangeForWindow({ start: 0, end: 5 }, { maxHours: 0 }), null);
});

test('rangeForWindow feeds the request: a fixture-style roster window produces a valid service range', async () => {
  const w = { start: berlin('2026-10-06', 22), end: berlin('2026-10-07', 6), kind: 'standby' };
  const range = rangeForWindow(w);
  const b = backend();
  const r = await loadDepartures({ ...Q, ...range, carriers: departuresContext(PROFILE).carriers }, { api: b.api, store: freshStore() });
  assert.equal(r.from, w.start);
  assert.equal(r.to, w.end);
  assert.deepEqual(b.calls[0].body.carriers, ['DE']);
});

// ---------- inWindow ----------

const flight = (flightNumber, scheduledDep, extra = {}) => ({ id: `f_${flightNumber}`, flightNumber, scheduledDep, revisedDep: null, status: 'scheduled', ...extra });

test('inWindow: half-open [start, end): start included, end excluded, order by time then flight number', () => {
  const flights = [flight('DE9003', 300), flight('DE9002', 200), flight('DE9001', 200), flight('DE9000', 100), flight('DE9004', 400), flight('DE8999', 99)];
  const got = inWindow(flights, { start: 100, end: 400 });
  assert.deepEqual(got.map((f) => f.flightNumber), ['DE9000', 'DE9001', 'DE9002', 'DE9003']);
  assert.deepEqual(inWindow(flights, { start: 400, end: 401 }).map((f) => f.flightNumber), ['DE9004']);
  assert.deepEqual(inWindow(flights, { start: 100, end: 100 }), []);
  assert.deepEqual(inWindow(flights, { start: 400, end: 100 }), []);
  assert.deepEqual(inWindow(flights, { start: NaN, end: 100 }), []);
  assert.deepEqual(inWindow(null, { start: 0, end: 1 }), []);
  assert.equal(flights[0].flightNumber, 'DE9003', 'input array is not reordered');
  assert.equal(inWindow(flights, { start: 0, end: 1000 }).length, 6);
});

test('inWindow: stable for equal time and number; returns the same flight objects', () => {
  const a = flight('DE9001', 10, { id: 'a' }); const b = flight('DE9001', 10, { id: 'b' });
  const got = inWindow([a, b], { start: 0, end: 20 });
  assert.deepEqual(got.map((f) => f.id), ['a', 'b']);
  assert.equal(got[0], a);
});

test('inWindow: revisedDep is ignored for membership (scheduledDep decides)', () => {
  const start = 1000; const end = 2000;
  const late = flight('DE9001', 900, { revisedDep: 1500, status: 'delayed' });     // scheduled before, revised inside
  const early = flight('DE9002', 1900, { revisedDep: 2500, status: 'delayed' });   // scheduled inside, revised after
  const cancelled = flight('DE9003', 1200, { status: 'cancelled' });
  assert.deepEqual(inWindow([late, early, cancelled], { start, end }).map((f) => f.flightNumber), ['DE9003', 'DE9002']);
});

test('inWindow: overnight window with the fixture, by instant', () => {
  const adapted = adaptDepartures(FX);
  const start = FX.from + 4 * HOUR; const end = FX.from + 10 * HOUR;   // 04:00Z..10:00Z offsets in the fixture
  const got = inWindow(adapted.flights, { start, end });
  assert.deepEqual(got.map((f) => f.flightNumber), ['DE9102', 'DE9055', 'DE9310', 'DE9411']);
  assert.ok(got.every((f) => f.scheduledDep >= start && f.scheduledDep < end));
  assert.ok(got.some((f) => f.status === 'cancelled'), 'cancelled flights stay in the list');
});

test('inWindow: a local overnight window 22:00 -> 06:00 Berlin selects by instant across midnight', () => {
  const w = { start: berlin('2026-10-06', 22), end: berlin('2026-10-07', 6) };
  const flights = [
    flight('DE9001', berlin('2026-10-06', 21, 59)),
    flight('DE9002', berlin('2026-10-06', 22)),
    flight('DE9003', berlin('2026-10-07', 0, 5)),
    flight('DE9004', berlin('2026-10-07', 5, 59)),
    flight('DE9005', berlin('2026-10-07', 6)),
  ];
  assert.deepEqual(inWindow(flights, w).map((f) => f.flightNumber), ['DE9002', 'DE9003', 'DE9004']);
});

test('inWindow: DST nights by instant (spring 2026-03-29 gap; autumn 2026-10-25 repeated 02:30)', () => {
  // Spring: 02:00 CET -> 03:00 CEST. 01:59 CET = 00:59Z, 03:00 CEST = 01:00Z (adjacent instants).
  const w1 = { start: berlin('2026-03-28', 22), end: berlin('2026-03-29', 6) };
  const s = (iso) => Date.parse(iso);
  const spring = [flight('DE9001', s('2026-03-28T20:59:59Z')), flight('DE9002', s('2026-03-28T21:00:00Z')), flight('DE9003', s('2026-03-29T00:59:00Z')), flight('DE9004', s('2026-03-29T01:00:00Z')), flight('DE9005', s('2026-03-29T03:59:59Z')), flight('DE9006', s('2026-03-29T04:00:00Z'))];
  assert.equal(w1.start, s('2026-03-28T21:00:00Z'));
  assert.equal(w1.end, s('2026-03-29T04:00:00Z'));
  assert.deepEqual(inWindow(spring, w1).map((f) => f.flightNumber), ['DE9002', 'DE9003', 'DE9004', 'DE9005']);

  // Autumn: 02:30 happens twice: 02:30 CEST = 00:30Z and 02:30 CET = 01:30Z.
  const first = s('2026-10-25T00:30:00Z'); const second = s('2026-10-25T01:30:00Z');
  const autumn = [flight('DE9010', first), flight('DE9011', second), flight('DE9012', s('2026-10-25T02:00:00Z'))];
  const w2 = { start: s('2026-10-25T00:00:00Z'), end: s('2026-10-25T02:00:00Z') };       // 02:00 CEST -> 03:00 CET
  assert.deepEqual(inWindow(autumn, w2).map((f) => f.flightNumber), ['DE9010', 'DE9011'], 'both 02:30s are inside, 03:00 CET is the half-open end');
  const secondHour = { start: s('2026-10-25T01:00:00Z'), end: s('2026-10-25T02:00:00Z') }; // 02:00 CET -> 03:00 CET
  assert.deepEqual(inWindow(autumn, secondHour).map((f) => f.flightNumber), ['DE9011']);
  const firstHour = { start: s('2026-10-25T00:00:00Z'), end: s('2026-10-25T01:00:00Z') };
  assert.deepEqual(inWindow(autumn, firstHour).map((f) => f.flightNumber), ['DE9010']);
  // A window written from the repo's own tz helper agrees with the explicit instants.
  assert.equal(berlin('2026-10-25', 0), s('2026-10-24T22:00:00Z'));
  assert.equal(berlin('2026-10-25', 0), startOfLocalDay('2026-10-25', TZ));
  assert.equal(berlin('2026-03-29', 6), s('2026-03-29T04:00:00Z'));
});

// ---------- type separation ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const SF_FILES = ['src/sources/departures-v2.js', 'src/sources/departures-service.js', 'src/model/scheduled-flights.js'];
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('type separation: ScheduledFlight code never imports roster/state/horizon/history or sector adapters', () => {
  for (const f of SF_FILES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.doesNotMatch(spec, /(^|\/)(roster|state|horizon|history|flights|calendar|fc-appscript-v[25])\.js$/, `${f} imports ${spec}`);
    }
  }
});

test('type separation: ScheduledFlight code never uses sector-only fields or roster concepts', () => {
  const banned = /\b(pickup|report|reporting|duty|duties|blockMin|typeCode|historySource|legacy|wakeup|rotation|layover|standby|reserve|probability|eligib\w*)\b/i;
  for (const f of SF_FILES) {
    const code = strip(readFileSync(join(ROOT, f), 'utf8'));
    assert.doesNotMatch(code, banned, f);
    assert.doesNotMatch(code, /\b(dep|arr|blockMin)\s*:/, `${f} sets a sector-only key`);
    assert.doesNotMatch(code, /\bSector\b|\bRosterSnapshot\b/, `${f} touches roster types`);
  }
});

test('type separation: roster building and roster adapters know nothing of ScheduledFlight', () => {
  for (const f of ['src/model/roster.js', 'src/model/state.js', 'src/model/horizon.js', 'src/model/history.js', 'src/sources/fc-appscript-v2.js', 'src/sources/fc-appscript-v5.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /departures-v2|departures-service|scheduled-flights|ScheduledFlight/, f);
  }
});

test('provider isolation: no provider name or provider field names anywhere in src/', () => {
  const forbidden = /aerodatabox|rapidapi|\bmovement\b|scheduledTime|revisedTime|callSign|withCodeshared|withCancelled|x-rapidapi/i;
  for (const f of walk(join(ROOT, 'src'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), forbidden, f);
  }
});

test('provider isolation: the browser only calls the backend endpoint, never a provider host', () => {
  for (const f of SF_FILES) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /https?:\/\//, `${f} hard-codes a URL`);
    assert.doesNotMatch(src, /\bfetch\s*\(/, `${f} calls fetch directly`);
  }
});

// ---------- force (Radar manual refresh) ----------

test('force skips the device-cache read but still writes the cache; a normal call still hits it', async () => {
  const b = backend();
  const store = freshStore();
  await loadDepartures(Q, { api: b.api, store });
  assert.equal(b.calls.length, 1);
  const hit = await loadDepartures(Q, { api: b.api, store });
  assert.equal(b.calls.length, 1, 'normal call served from the cache');
  assert.equal(hit.fromCache, true);
  const forced = await loadDepartures(Q, { api: b.api, store, force: true });
  assert.equal(b.calls.length, 2, 'force asks the backend again');
  assert.equal(forced.fromCache, false);
  const key = Object.keys(store.getJSON(DEPARTURES_CACHE_KEY).entries)[0];
  const before = store.getJSON(DEPARTURES_CACHE_KEY).entries[key].storedAt;
  await loadDepartures(Q, { api: b.api, store, force: true, now: () => before + 1000 });
  assert.equal(store.getJSON(DEPARTURES_CACHE_KEY).entries[key].storedAt, before + 1000, 'the fresh answer is written');
  const after = await loadDepartures(Q, { api: b.api, store, now: () => before + 2000 });
  assert.equal(after.fromCache, true, 'and is served to the next normal call');
  assert.equal(b.calls.length, 3);
});

test('force does not bypass validation or error handling', async () => {
  const store = freshStore();
  await assert.rejects(loadDepartures({ ...Q, token: '' }, { api: backend().api, store, force: true }), (e) => e.code === 'bad-request');
  const failing = { postContract: async () => { throw new ApiError('timeout', 'slow'); } };
  await assert.rejects(loadDepartures(Q, { api: failing, store, force: true }), (e) => e.code === 'timeout');
  assert.equal(store.getJSON(DEPARTURES_CACHE_KEY, null), null, 'failures are never cached');
});
