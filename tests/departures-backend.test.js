// fc.roster v2 `departures` action (backend, Apps Script sources in a sandbox): request
// validation, chunking (incl. DST), provider URL, normalization, filtering, retry/spacing,
// cache, error mapping, secrecy, auth, capabilities, load order. The provider is always a
// fake; no network. Fixture: tests/fixtures/adb-departures.synthetic.json (synthetic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { loadGs, nodeDeps, fakeEnv, localIso, GS_FILES } from './gs-harness.js';
import { NOW as ROSTER_NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';

const gs = loadGs();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/adb-departures.synthetic.json', import.meta.url), 'utf8'));
const TOKEN = 'test-token-0123456789abcdef';
const KEY = 'SYNTHETIC-PROVIDER-KEY-0042';
const NOW = Date.parse('2026-10-06T08:00:00Z');
const H = 3600000;
const T = (s) => Date.parse(s);
const plain = (x) => JSON.parse(JSON.stringify(x));
const deps = nodeDeps(gs);
const ok = (body) => ({ status: 200, body: JSON.stringify(body) });
const adb = (...entries) => ({ departures: entries });
const entry = (number, utc, extra = {}) => ({ number, status: 'Expected', airline: { iata: number.slice(0, 2) }, movement: { scheduledTime: { utc }, airport: { iata: 'PMI', name: 'Palma de Mallorca' } }, ...extra });

function setup(options = {}) {
  const f = fakeEnv(gs, { now: NOW, departuresKey: KEY, ...options });
  const post = (body, token = TOKEN) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'departures', token, ...body }), f.env));
  const direct = (body, now = NOW) => plain(gs.fcv2HandleDepartures_({ action: 'departures', ...body }, f.env, now));
  return { ...f, post, direct };
}
const range = (hours, startOffsetHours = 2) => ({ airport: 'FRA', from: NOW + startOffsetHours * H, to: NOW + (startOffsetHours + hours) * H });
const FX = { from: T(fixture.from), to: T(fixture.to) };           // 20 h: two chunks
const fixtureFetch = (_url, _key, n) => ok(n === 1 ? { departures: fixture.departures } : fixture.chunk2);

// --- Request validation -----------------------------------------------------------

test('validation: every error code, and no provider call or sleep for any refused request', () => {
  const s = setup({ providerFetch: () => { throw new Error('must not be called'); } });
  const base = range(3);
  const cases = [
    [{ ...base, airport: 'XXX' }, 'unknown-airport'],
    [{ ...base, airport: 'fra' }, 'unknown-airport'],
    [{ ...base, airport: 'FRAA' }, 'unknown-airport'],
    [{ ...base, airport: 123 }, 'unknown-airport'],
    [{ from: base.from, to: base.to }, 'unknown-airport'],
    [{ ...base, from: String(base.from) }, 'bad-range'],
    [{ ...base, to: undefined }, 'bad-range'],
    [{ ...base, from: base.from + 0.5 }, 'bad-range'],
    [{ ...base, to: null }, 'bad-range'],
    [{ ...base, to: base.from }, 'bad-range'],
    [{ ...base, to: base.from - 1 }, 'bad-range'],
    [{ ...base, to: base.from + 24 * H + 1 }, 'range-too-long'],
    [{ ...base, from: NOW - 24 * H - 1, to: NOW - 23 * H }, 'range-out-of-bounds'],
    [{ ...base, from: NOW + 14 * 24 * H, to: NOW + 14 * 24 * H + 1 + H }, 'range-out-of-bounds'],
    [{ ...base, carriers: 'DE' }, 'bad-request'],
    [{ ...base, carriers: [] }, 'bad-request'],
    [{ ...base, carriers: ['de'] }, 'bad-request'],
    [{ ...base, carriers: ['D'] }, 'bad-request'],
    [{ ...base, carriers: ['DEX'] }, 'bad-request'],
    [{ ...base, carriers: [1] }, 'bad-request'],
    [{ ...base, carriers: {} }, 'bad-request'],
    [{ ...base, carriers: ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1', 'J1', 'K1'] }, 'bad-request'],
  ];
  for (const [body, error] of cases) {
    assert.deepEqual(s.post(body), { ok: false, error }, JSON.stringify(body));
  }
  assert.equal(s.calls.provider.length, 0);
  assert.equal(s.calls.sleeps.length, 0);
  assert.equal(Object.hasOwn(gs.FCV2_AIRPORT_TZ_, 'XXX'), false, 'XXX stays outside the zone table for this test');
});

test('validation: the invalid-request body shape is bad-request (existing envelope rule), the boundaries are inclusive', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  assert.equal(plain(gs.fcv2HandlePost_('not json', s.env)).error, 'bad-request');
  assert.equal(s.post({ ...range(1), from: NOW - 24 * H, to: NOW - 23 * H }).ok, true, 'from = now - 24 h is allowed');
  assert.equal(s.post({ ...range(1), from: NOW + 14 * 24 * H - H, to: NOW + 14 * 24 * H }).ok, true, 'to = now + 14 d is allowed');
  assert.equal(s.post({ ...range(24) }).ok, true, 'exactly 24 h is allowed');
  assert.equal(s.post({ ...range(1), carriers: null }).carriers, null, 'null carriers = no filter');
});

test('carriers: validated list is deduplicated and sorted; absent = null', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  assert.deepEqual(s.post({ ...range(1), carriers: ['LH', 'DE', 'DE', 'X3'] }).carriers, ['DE', 'LH', 'X3']);
  assert.equal(s.post({ ...range(1) }).carriers, null);
});

test('departures-not-configured: no key, empty key, and an env without the function; valid requests only', () => {
  for (const departuresKey of [undefined, '']) {
    const s = setup({ departuresKey: departuresKey ?? null, providerFetch: () => { throw new Error('must not be called'); } });
    assert.deepEqual(s.post(range(2)), { ok: false, error: 'departures-not-configured' });
    assert.equal(s.post({ ...range(2), airport: 'XXX' }).error, 'unknown-airport', 'a bad request is still reported as such');
    assert.equal(s.calls.provider.length, 0);
  }
  const s = setup();
  delete s.env.departuresKey;
  assert.equal(plain(gs.fcv2HandleDepartures_({ action: 'departures', ...range(2) }, s.env, NOW)).error, 'departures-not-configured');
});

// --- Chunking ---------------------------------------------------------------------

const localMin = (s) => Date.parse(`${s}:00Z`) / 60000;
function chunksOf(from, to, tz = 'Europe/Berlin') { return plain(gs.fcv2DepartureChunks_(from, to, tz, deps)); }
function assertTiling(chunks, from, to, tz = 'Europe/Berlin') {
  assert.equal(chunks[0].start, from);
  assert.equal(chunks.at(-1).end, to, 'the last window ends at the range end');
  chunks.forEach((c, i) => {
    assert.equal(c.start, from + i * 11 * H, `chunk ${i} starts at from + ${i}*11h`);
    assert.ok(c.end - c.start <= 12 * H, 'instant span <= 12 h');
    assert.ok(localMin(c.toLocal) - localMin(c.fromLocal) <= 720, `local span <= 12 h (${c.fromLocal} .. ${c.toLocal})`);
    assert.equal(c.fromLocal, localIso(c.start, tz).slice(0, 16));
    assert.equal(c.toLocal, localIso(Math.ceil(c.end / 60000) * 60000, tz).slice(0, 16), 'the provider end is rounded UP to the whole minute');
    assert.match(c.fromLocal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    if (i > 0) assert.ok(c.start <= chunks[i - 1].end, `no gap before chunk ${i}`);
  });
}

test('chunking: call-count table (no chunk once the previous one reaches `to`), 1 h, 11 h, 12 h, 23 h, 24 h and an overnight range', () => {
  const from = T('2026-10-06T10:00:00Z');
  // local span (h) -> chunks: <= 12 h 1, > 12 h and <= 23 h 2, > 23 h and <= 24 h 3
  const counts = [[1, 1], [11, 1], [12, 1], [12 + 1 / 3600000, 2], [20, 2], [22, 2], [23, 2], [23 + 1 / 3600000, 3], [24, 3]];
  for (const [hours, n] of counts) {
    const chunks = chunksOf(from, from + Math.round(hours * H));
    assert.equal(chunks.length, n, `${hours} h`);
    assertTiling(chunks, from, from + Math.round(hours * H));
  }
  // The padded provider range (at most 26 h) still needs at most three calls.
  for (const hours of [25, 26]) assert.equal(chunksOf(from, from + hours * H).length, 3, `${hours} h`);
  const twenty = chunksOf(from, from + 20 * H);
  assert.deepEqual(twenty.map((c) => [c.fromLocal, c.toLocal]), [['2026-10-06T12:00', '2026-10-07T00:00'], ['2026-10-06T23:00', '2026-10-07T08:00']]);
  // Overnight: 22:00 -> 10:00 local (crossing midnight).
  const nightFrom = T('2026-10-06T20:00:00Z');
  const night = chunksOf(nightFrom, nightFrom + 12 * H);
  assertTiling(night, nightFrom, nightFrom + 12 * H);
  assert.deepEqual(night.map((c) => [c.fromLocal, c.toLocal]), [['2026-10-06T22:00', '2026-10-07T10:00']], '12 h is one call: nothing is left for a second chunk');
  // A range whose length is a multiple of the step: the chunk starting exactly at `to` does not exist.
  assert.equal(chunksOf(from, from + 22 * H).length, 2);
});

test('chunking across Europe/Berlin DST changes: correct local strings, no gaps, windows never above 12 h', () => {
  // Spring forward 2026-03-29 01:00Z (02:00 -> 03:00): 12 h of instants would span 13 local hours.
  const spring = T('2026-03-28T22:00:00Z');
  const sc = chunksOf(spring, spring + 24 * H);
  assertTiling(sc, spring, spring + 24 * H);
  assert.deepEqual(sc.map((c) => [c.fromLocal, c.toLocal]), [
    ['2026-03-28T23:00', '2026-03-29T11:00'],   // pulled back from 12:00 (13 local hours) to 12 local hours
    ['2026-03-29T11:00', '2026-03-29T23:00'],
    ['2026-03-29T22:00', '2026-03-30T00:00'],
  ]);
  assert.equal(sc[0].end, sc[1].start, 'the shortened window still meets the next one');
  // Fall back 2026-10-25 01:00Z (03:00 -> 02:00): 12 h of instants span 11 local hours.
  const fall = T('2026-10-24T22:00:00Z');
  const fc = chunksOf(fall, fall + 24 * H);
  assertTiling(fc, fall, fall + 24 * H);
  assert.deepEqual(fc.map((c) => [c.fromLocal, c.toLocal]), [
    ['2026-10-25T00:00', '2026-10-25T11:00'],
    ['2026-10-25T10:00', '2026-10-25T22:00'],
    ['2026-10-25T21:00', '2026-10-25T23:00'],
  ]);
  // Every instant of both days lies in some chunk (sampled every 5 minutes).
  for (const [from, n] of [[spring, sc], [fall, fc]]) {
    for (let t = from; t < from + 24 * H; t += 300000) assert.ok(n.some((c) => c.start <= t && t <= c.end), new Date(t).toISOString());
  }
  // A range end off the minute: the pulled-back window still meets the next one (no gap of seconds).
  for (const [tz, from, hours] of [['America/New_York', 1772919747750, 11.963861666666666], ['America/New_York', 1772898109723, 22.171129722222222]]) {
    const to = from + Math.round(hours * H);
    const odd = chunksOf(from, to, tz);
    odd.forEach((c, i) => {
      if (i > 0) assert.ok(Math.floor(c.start / 60000) * 60000 <= odd[i - 1].end, `${tz} chunk ${i}'s whole-minute start is at or before the previous (whole-minute) end`);
      assert.ok(localMin(c.toLocal) - localMin(c.fromLocal) <= 720);
    });
    assert.equal(odd.at(-1).end, to);
  }
  // Starting inside the changeover hour.
  const mid = T('2026-03-29T00:30:00Z');
  assertTiling(chunksOf(mid, mid + 13 * H), mid, mid + 13 * H);
});

test('chunking: the handler asks the provider for exactly these windows', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  const from = T('2026-10-24T22:00:00Z');
  const now = from - 2 * H;
  const r = s.direct({ airport: 'FRA', from, to: from + 24 * H }, now);
  assert.equal(r.ok, true);
  assert.deepEqual(s.calls.provider.map(([u]) => u.split('?')[0].split('/').slice(7, 9)), [
    ['2026-10-25T00:00', '2026-10-25T11:00'], ['2026-10-25T10:00', '2026-10-25T22:00'], ['2026-10-25T21:00', '2026-10-25T23:00'],
  ]);
});

// --- Provider URL and headers -----------------------------------------------------

test('provider URL is exact and the key is passed separately to providerFetch', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  s.post({ ...range(1), airport: 'FRA' });
  assert.equal(s.calls.provider.length, 1);
  const [url, key] = s.calls.provider[0];
  assert.equal(url, 'https://aerodatabox.p.rapidapi.com/flights/airports/iata/FRA/2026-10-06T12:00/2026-10-06T13:00'
    + '?withLeg=false&direction=Departure&withCancelled=true&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false');
  assert.equal(key, KEY);
  assert.ok(!url.includes(KEY), 'the key is never part of the URL');
});

function liveSandbox({ props = {}, status = 200, text = '{}' } = {}) {
  const store = new Map();
  const puts = [];
  const fetched = [];
  const slept = [];
  const sandbox = {
    Utilities: { sleep: (ms) => slept.push(ms) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (Object.hasOwn(props, k) ? props[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => store.get(k) ?? null, put: (k, v, ttl) => { store.set(k, v); puts.push([k, v, ttl]); } }) },
    UrlFetchApp: { fetch: (url, opts) => { fetched.push([url, opts]); return { getResponseCode: () => status, getContentText: () => text }; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(GS_FILES.map((f) => readFileSync(new URL(`../backend/apps-script/${f}`, import.meta.url), 'utf8')).join('\n;\n') + '\n;globalThis.__live = fcv2LiveEnv_();', sandbox);
  return { env: sandbox.__live, puts, fetched, slept };
}

test('live env bindings: key from Script Property only, UrlFetchApp options, sleep, TTL-aware cachePut with the old default kept', () => {
  const none = liveSandbox();
  assert.equal(none.env.departuresKey(), null);
  const live = liveSandbox({ props: { FC_ADB_RAPIDAPI_KEY: KEY }, status: 429, text: 'provider text' });
  assert.equal(live.env.departuresKey(), KEY);
  const res = live.env.providerFetch('https://example.invalid/x', KEY);
  assert.deepEqual(plain(res), { status: 429, body: 'provider text' });
  assert.deepEqual(plain(live.fetched), [['https://example.invalid/x', {
    method: 'get', headers: { 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com', 'x-rapidapi-key': KEY }, muteHttpExceptions: true,
  }]]);
  live.env.sleep(1100);
  assert.deepEqual(live.slept, [1100]);
  live.env.cachePut('k1', { a: 1 });
  live.env.cachePut('k2', { a: 2 }, 600);
  live.env.cachePut('k3', { big: 'x'.repeat(90000) }, 600);
  assert.deepEqual(live.puts, [['k1', '{"a":1}', 6 * 3600], ['k2', '{"a":2}', 600]], 'default TTL unchanged, explicit TTL used, oversize skipped');
  assert.deepEqual(plain(live.env.cacheGet('k2')), { a: 2 });
});

// --- Normalization ----------------------------------------------------------------

const normalize = (body, carriers = null) => plain(gs.fcv2NormalizeAdb_(body, 'FRA', carriers, deps));
const countsOnly = ({ flights, dropped }) => ({ flights, dropped });   // droppedKeys has its own test
const idOf = (number, ms) => `f_${createHash('sha256').update(`${number}|${ms}`).digest('hex').slice(0, 16)}`;
const byNumber = (list) => Object.fromEntries(list.map((f) => [f.flightNumber, f]));

test('normalization: every field of the full wire record', () => {
  const { flights } = normalize({ departures: [fixture.departures[0]] });
  assert.deepEqual(flights, [{
    id: idOf('DE1234', T('2026-10-06T12:30:00Z')), flightNumber: 'DE1234', carrier: 'DE', origin: 'FRA',
    destination: 'PMI', destinationName: 'Palma de Mallorca',
    scheduledDep: T('2026-10-06T12:30:00Z'), revisedDep: T('2026-10-06T12:55:00Z'), status: 'delayed',
    aircraft: { model: 'Airbus A320', registration: 'D-AXXA' }, provenance: 'provider',
  }]);
});

test('normalization: fixture entries (number with space, callSign only, revised, aircraft, carriers, dropped)', () => {
  const r = normalize({ departures: fixture.departures });
  assert.equal(r.dropped, 4, 'missing scheduled time, unparseable utc, a null entry, and an entry without any flight number');
  assert.equal(r.flights.length, 16);
  const f = byNumber(r.flights);
  assert.equal(f.DE1234.flightNumber, 'DE1234', 'whitespace removed');
  assert.equal(f.TUI4XYZ.carrier, 'X3', 'callSign fallback; carrier from airline.iata');
  assert.equal(f.TUI4XYZ.status, 'scheduled');
  assert.equal(f.LH9001.revisedDep, null, 'absent revisedTime');
  assert.deepEqual(f.LH9001.aircraft, { model: 'Boeing 737-800', registration: null });
  assert.deepEqual(f.EW9002.aircraft, { model: null, registration: 'D-AXXB' });
  assert.equal(f.DE9007.aircraft, null, 'no aircraft object: null');
  assert.equal(f.DE9005.destination, null, 'destination iata missing');
  assert.equal(f.DE9005.destinationName, 'Synthetic Field');
  assert.equal(f.DE9006.destination, 'AYT');
  assert.equal(f.DE9006.destinationName, null, 'a destination name over 60 characters is not shown');
  assert.equal(f.DE9008.carrier, 'DE', 'no airline: first two characters of the number');
  assert.equal(f.EW9010.carrier, 'EW', 'invalid airline.iata falls back to the number');
  assert.equal(f[7].carrier, null, 'neither airline nor a two-character prefix');
  assert.equal(f.DE9012.revisedDep, T('2026-10-06T18:00:00Z'));
  assert.ok(r.flights.every((x) => x.origin === 'FRA' && x.provenance === 'provider'));
  assert.equal(r.flights.length, new Set(r.flights.map((x) => x.id)).size);
});

test('normalization: only the utc instant is used (a wrong "local" never matters)', () => {
  const e = fixture.departures[0];
  assert.notEqual(e.movement.scheduledTime.local, '2026-10-06T14:30+02:00');
  assert.equal(normalize({ departures: [e] }).flights[0].scheduledDep, T('2026-10-06T12:30:00Z'));
  const onlyLocal = { number: 'DE9100', movement: { scheduledTime: { local: '2026-10-06 14:30+02:00' } } };
  assert.deepEqual(countsOnly(normalize({ departures: [onlyLocal] })), { flights: [], dropped: 1 });
});

test('normalization: status mapping buckets, case-insensitive, unknown otherwise', () => {
  const map = (s) => gs.fcv2MapDepartureStatus_(s);
  const expected = {
    scheduled: ['Expected', 'CheckIn', 'Scheduled', 'expected', 'CHECKIN'],
    delayed: ['Delayed', 'DELAYED'],
    boarding: ['Boarding', 'GateClosed', 'gateclosed'],
    departed: ['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted'],
    cancelled: ['Canceled', 'Cancelled', 'CanceledUncertain', 'canceled'],
    unknown: ['Unknown', 'SomethingNew', '', undefined, null, 5, 'constructor', '__proto__', 'toString'],
  };
  for (const [bucket, list] of Object.entries(expected)) for (const s of list) assert.equal(map(s), bucket, String(s));
});

test('normalization: carrier, text and number edge cases', () => {
  const one = (extra, number = 'DE9101') => { const { movement, ...rest } = extra; return normalize({ departures: [{ number, ...rest, movement: { scheduledTime: { utc: '2026-10-06 12:00Z' }, ...movement } }] }).flights[0]; };
  assert.equal(one({ airline: { iata: 'LH' } }).carrier, 'LH', 'airline.iata wins over the number prefix');
  assert.equal(one({ airline: { iata: 'lh' } }).carrier, 'DE');
  assert.equal(one({}, 'de 9101').flightNumber, 'DE9101', 'uppercased');
  assert.equal(one({}, ' D E\t9101 ').flightNumber, 'DE9101', 'all whitespace removed');
  assert.equal(one({}, 'X').carrier, null);
  assert.equal(one({ movement: { airport: { iata: 'pmi', name: '  Palma  ' } } }).destination, null, 'iata must be uppercase letters');
  assert.equal(one({ movement: { airport: { iata: 'PMI', name: '  Palma  ' } } }).destinationName, 'Palma');
  assert.equal(one({ movement: { airport: { iata: 'PMI', name: 'x'.repeat(60) } } }).destinationName.length, 60);
  assert.equal(one({ movement: { airport: { iata: 'PMI', name: 'x'.repeat(61) } } }).destinationName, null);
  assert.equal(one({ movement: { airport: { iata: 'PMI', name: '   ' } } }).destinationName, null);
  assert.equal(one({ aircraft: { model: 'y'.repeat(61), reg: '  ' } }).aircraft, null, 'both unusable: null aircraft');
  assert.deepEqual(one({ aircraft: { model: ' Airbus A320 ', reg: 'D-AXXX' } }).aircraft, { model: 'Airbus A320', registration: 'D-AXXX' });
  assert.equal(normalize({ departures: [{ number: 12, callSign: ' ab12 ', movement: { scheduledTime: { utc: '2026-10-06 12:00Z' } } }] }).flights[0].flightNumber, 'AB12', 'non-string number falls back to callSign');
});

test('normalization: utc parsing accepts the provider format and rejects everything else', () => {
  const p = (v) => gs.fcv2ParseProviderUtc_(v);
  assert.equal(p('2026-10-06 14:30Z'), T('2026-10-06T14:30:00Z'));
  assert.equal(p('2026-10-06T14:30Z'), T('2026-10-06T14:30:00Z'));
  assert.equal(p('2026-10-06 14:30:15Z'), T('2026-10-06T14:30:15Z'));
  assert.equal(p('2026-10-06 14:30+00:00'), T('2026-10-06T14:30:00Z'));
  for (const bad of [undefined, null, 5, {}, '', 'not a time', '2026-10-06', '2026-10-06 14:30', '2026-02-30 10:00Z', '2026-10-06 25:00Z']) assert.equal(p(bad), null, String(bad));
});

test('normalization: body shape rules', () => {
  assert.deepEqual(countsOnly(normalize({})), { flights: [], dropped: 0 }, 'an object without departures is an empty list');
  assert.deepEqual(countsOnly(normalize({ departures: null })), { flights: [], dropped: 0 });
  for (const bad of [null, undefined, 'x', 5, [], { departures: 'x' }, { departures: {} }]) assert.equal(gs.fcv2NormalizeAdb_(bad, 'FRA', null, deps), null, JSON.stringify(bad));
});

test('carrier filter: applied per chunk, dropped entries are not carrier-filtered', () => {
  const r = normalize({ departures: fixture.departures }, ['DE']);
  assert.ok(r.flights.length > 0 && r.flights.every((f) => f.carrier === 'DE'));
  assert.equal(r.dropped, 4);
  assert.ok(!r.flights.some((f) => f.carrier === null), 'a null carrier never matches a filter');
  assert.deepEqual(plain(gs.fcv2FilterCarriers_([{ carrier: 'LH' }, { carrier: null }, { carrier: 'X3' }], ['LH', 'X3'])), [{ carrier: 'LH' }, { carrier: 'X3' }]);
  assert.equal(gs.fcv2FilterCarriers_([1, 2], null).length, 2);
});

// --- Whole action over the fixture ------------------------------------------------

const EXPECTED_NUMBERS = ['DE9015', 'DE1234', 'LH9001', 'TUI4XYZ', 'EW9002', 'DE9005', 'DE9006', 'DE9007', 'DE9008', 'LH9009', 'EW9010', 'DE9011', 'DE9012', '7', 'DE9016', 'DE9020', 'LH9021', 'X39022'];

test('action over the fixture: [from,to) filtering, cancelled kept, dedupe, sort, dropped, envelope', () => {
  const s = setup({ providerFetch: fixtureFetch });
  const r = s.post({ airport: 'FRA', ...FX });
  assert.equal(r.ok, true);
  assert.deepEqual(r.flights.map((f) => f.flightNumber), EXPECTED_NUMBERS);
  assert.deepEqual(r.flights.map((f) => f.scheduledDep), [...r.flights.map((f) => f.scheduledDep)].sort((a, b) => a - b));
  assert.equal(r.flights[0].scheduledDep, FX.from, 'from is inclusive');
  assert.ok(r.flights.every((f) => f.scheduledDep >= FX.from && f.scheduledDep < FX.to), 'to is exclusive');
  assert.ok(!r.flights.some((f) => ['DE9013', 'DE9023', 'DE9024'].includes(f.flightNumber)), 'before, at and after the range end are out');
  assert.equal(r.flights.filter((f) => f.flightNumber === 'DE9016').length, 1, 'the duplicate across two chunks is kept once');
  assert.deepEqual(r.flights.filter((f) => f.status === 'cancelled').map((f) => f.flightNumber), ['DE9007', 'DE9011']);
  assert.equal(r.flights.find((f) => f.flightNumber === 'DE9006').status, 'departed');
  assert.equal(r.dropped, 4);
  const { flights, ...envelope } = r;
  assert.deepEqual(envelope, {
    ok: true, contract: 'fc.roster', version: 2, action: 'departures', airport: 'FRA', airportTz: 'Europe/Berlin',
    from: FX.from, to: FX.to, carriers: null, provider: 'aerodatabox', generatedAt: NOW, fetchedAt: NOW, dropped: 4,
  });
  assert.equal(s.calls.provider.length, 2);
});

test('action with carriers: only listed carriers, carriers echoed sorted, the filter is part of the cache key', () => {
  const s = setup({ providerFetch: fixtureFetch });
  const r = s.post({ airport: 'FRA', ...FX, carriers: ['X3', 'LH'] });
  assert.deepEqual(r.carriers, ['LH', 'X3']);
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['LH9001', 'TUI4XYZ', 'LH9009', 'LH9021', 'X39022']);
  assert.deepEqual(s.calls.cachePuts.map(([k]) => k), [
    'fcv2-dep-FRA-2026-10-06T12:00-2026-10-07T00:00-LH,X3', 'fcv2-dep-FRA-2026-10-06T23:00-2026-10-07T08:00-LH,X3']);
  s.post({ airport: 'FRA', ...FX });   // no filter: different keys, so a new provider round
  assert.equal(s.calls.provider.length, 4);
});

test('sort: equal instants order by flight number; ties on id are deduplicated', () => {
  const s = setup({ providerFetch: () => ok(adb(entry('LH9302', '2026-10-06 12:00Z'), entry('DE9301', '2026-10-06 12:00Z'), entry('DE9300', '2026-10-06 12:30Z'), entry('DE9300', '2026-10-06 12:30Z'))) });
  const r = s.post(range(3));
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE9301', 'LH9302', 'DE9300']);
});

test('airport zone: the provider is asked in the airport zone, flights keep origin = airport', () => {
  const s = setup({ providerFetch: () => ok(adb(entry('DE9401', '2026-10-06 11:00Z'))) });
  const tzOfJfk = gs.FCV2_AIRPORT_TZ_.JFK;
  if (!tzOfJfk) return;   // table without JFK: nothing to assert
  const r = s.post({ airport: 'JFK', from: NOW + 2 * H, to: NOW + 4 * H });
  assert.equal(r.airportTz, tzOfJfk);
  assert.ok(s.calls.provider[0][0].includes('/iata/JFK/2026-10-06T06:00/2026-10-06T08:00?'), s.calls.provider[0][0]);
  assert.equal(r.flights[0].origin, 'JFK');
});

// --- Retry, spacing, errors -------------------------------------------------------

test('429: retry after 1200 ms then 2500 ms, then success', () => {
  const s = setup({ providerFetch: (_u, _k, n) => (n < 3 ? { status: 429, body: 'slow down' } : ok(adb(entry('DE9501', '2026-10-06 11:00Z')))) });
  const r = s.post(range(3));
  assert.equal(r.ok, true);
  assert.equal(r.flights.length, 1);
  assert.deepEqual(s.calls.sleeps, [1200, 2500]);
  assert.equal(s.calls.provider.length, 3);
  const early = setup({ providerFetch: (_u, _k, n) => (n < 2 ? { status: 429, body: '' } : ok(adb())) });
  assert.equal(early.post(range(3)).ok, true);
  assert.deepEqual(early.calls.sleeps, [1200]);
});

test('429 after both retries: provider-rate-limited, nothing else', () => {
  const s = setup({ providerFetch: () => ({ status: 429, body: 'PROVIDER-BODY-SECRET' }) });
  assert.deepEqual(s.post(range(3)), { ok: false, error: 'provider-rate-limited' });
  assert.deepEqual(s.calls.sleeps, [1200, 2500]);
  assert.equal(s.calls.provider.length, 3);
});

test('401 and 403: provider-auth-failed, no retry', () => {
  for (const status of [401, 403]) {
    const s = setup({ providerFetch: () => ({ status, body: 'PROVIDER-BODY-SECRET' }) });
    assert.deepEqual(s.post(range(3)), { ok: false, error: 'provider-auth-failed' });
    assert.equal(s.calls.provider.length, 1);
    assert.equal(s.calls.sleeps.length, 0);
  }
});

test('other failures: 500, 404, network throw, HTML, non-object JSON, bad shapes all become provider-unavailable', () => {
  const failures = {
    500: () => ({ status: 500, body: 'PROVIDER-BODY-SECRET' }),
    404: () => ({ status: 404, body: '{"departures":[]}' }),
    400: () => ({ status: 400, body: 'PROVIDER-BODY-SECRET' }),
    throw: () => { throw new Error(`socket closed for ${KEY} https://aerodatabox.p.rapidapi.com/x`); },
    html: () => ({ status: 200, body: '<html>PROVIDER-BODY-SECRET</html>' }),
    array: () => ({ status: 200, body: '[]' }),
    string: () => ({ status: 200, body: '"PROVIDER-BODY-SECRET"' }),
    null: () => ({ status: 200, body: 'null' }),
    number: () => ({ status: 200, body: '5' }),
    badList: () => ({ status: 200, body: '{"departures":"PROVIDER-BODY-SECRET"}' }),
    objectList: () => ({ status: 200, body: '{"departures":{"a":1}}' }),
    noBody: () => ({ status: 200 }),
    noResponse: () => undefined,
  };
  for (const [name, providerFetch] of Object.entries(failures)) {
    const s = setup({ providerFetch });
    const r = s.post(range(3));
    assert.deepEqual(r, { ok: false, error: 'provider-unavailable' }, name);
    assert.equal(s.calls.sleeps.length, 0, `${name}: no retry`);
  }
});

test('no partial results: a failing chunk fails the request, whatever its position', () => {
  const second = (status) => (_u, _k, n) => (n === 1 ? ok({ departures: fixture.departures }) : { status, body: 'x' });
  for (const [status, error] of [[500, 'provider-unavailable'], [401, 'provider-auth-failed'], [429, 'provider-rate-limited']]) {
    const s = setup({ providerFetch: second(status) });
    const r = s.post({ airport: 'FRA', ...FX });
    assert.deepEqual(r, { ok: false, error });
    assert.equal(Object.hasOwn(r, 'flights'), false);
  }
  const first = setup({ providerFetch: (_u, _k, n) => (n === 1 ? { status: 500, body: '' } : ok(fixture.chunk2)) });
  assert.deepEqual(first.post({ airport: 'FRA', ...FX }), { ok: false, error: 'provider-unavailable' });
  assert.equal(first.calls.provider.length, 1, 'stops at the first failure');
});

test('spacing: 1100 ms between provider calls only, none before the first, none for cache hits', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  s.post(range(11));
  assert.deepEqual(s.calls.sleeps, [], 'single chunk');
  const two = setup({ providerFetch: () => ok(adb()) });
  two.post(range(20));
  assert.deepEqual(two.calls.sleeps, [1100]);
  const three = setup({ providerFetch: () => ok(adb()) });
  three.post(range(24));
  assert.deepEqual(three.calls.sleeps, [1100, 1100]);
  three.calls.sleeps.length = 0;
  three.post(range(24));
  assert.deepEqual(three.calls.sleeps, [], 'all cache hits');
  assert.equal(three.calls.provider.length, 3);
  const retry = setup({ providerFetch: (_u, _k, n) => (n === 2 ? { status: 429, body: '' } : ok(adb())) });
  retry.post(range(20));
  assert.deepEqual(retry.calls.sleeps, [1100, 1200], 'spacing, then the retry delay');
});

test('partially cached: only the missing chunk is fetched, without a spacing sleep', () => {
  const s = setup({ providerFetch: () => ok(adb()) });
  s.post(range(20));
  s.cache.delete([...s.cache.keys()][0]);
  s.calls.sleeps.length = 0;
  s.calls.provider.length = 0;
  s.post(range(20));
  assert.equal(s.calls.provider.length, 1);
  assert.deepEqual(s.calls.sleeps, []);
});

// --- Cache ------------------------------------------------------------------------

test('cache: keys, TTL 600 s near / 3600 s later, value shape (normalized, carrier-filtered, not range-filtered)', () => {
  const s = setup({ providerFetch: fixtureFetch });
  s.post({ airport: 'FRA', ...FX });
  assert.deepEqual(s.calls.cachePuts, [
    ['fcv2-dep-FRA-2026-10-06T12:00-2026-10-07T00:00-*', 600],   // starts 10:00Z < now + 6 h
    ['fcv2-dep-FRA-2026-10-06T23:00-2026-10-07T08:00-*', 3600],  // starts 21:00Z >= now + 6 h
  ]);
  const value = plain(s.cache.get('fcv2-dep-FRA-2026-10-06T12:00-2026-10-07T00:00-*'));
  assert.deepEqual(Object.keys(value).sort(), ['dropped', 'droppedKeys', 'fetchedAt', 'flights']);
  assert.equal(value.droppedKeys.length, 4);
  assert.equal(value.fetchedAt, NOW);
  assert.equal(value.dropped, 4);
  assert.ok(value.flights.some((f) => f.flightNumber === 'DE9013'), 'the chunk keeps entries outside the requested range');
  const other = plain(s.cache.get('fcv2-dep-FRA-2026-10-06T23:00-2026-10-07T08:00-*'));
  assert.ok(other.flights.some((f) => f.flightNumber === 'DE9024'));
});

test('cache: the TTL boundary is now + 6 h (a chunk starting exactly then is "later")', () => {
  const at = (offset) => { const s = setup({ providerFetch: () => ok(adb()) }); s.post({ airport: 'FRA', from: NOW + 6 * H + offset, to: NOW + 7 * H + offset }); return s.calls.cachePuts[0][1]; };
  assert.equal(at(-60000), 600);
  assert.equal(at(0), 3600);
});

test('cache: a second identical request is served from the cache with no provider call', () => {
  const s = setup({ providerFetch: fixtureFetch });
  const a = s.post({ airport: 'FRA', ...FX });
  const b = s.post({ airport: 'FRA', ...FX });
  assert.deepEqual(b, a);
  assert.equal(s.calls.provider.length, 2);
});

test('cache: fetchedAt is the oldest provider fetch among the chunks used; generatedAt is now', () => {
  const s = setup({ providerFetch: fixtureFetch });
  const first = s.direct({ airport: 'FRA', ...FX }, NOW);
  assert.equal(first.fetchedAt, NOW);
  const later = s.direct({ airport: 'FRA', ...FX }, NOW + 300000);
  assert.equal(later.generatedAt, NOW + 300000);
  assert.equal(later.fetchedAt, NOW, 'both chunks came from the cache fetched at NOW');
  // One chunk refreshed later: the oldest still wins.
  s.cache.delete('fcv2-dep-FRA-2026-10-06T23:00-2026-10-07T08:00-*');
  const mixed = s.direct({ airport: 'FRA', ...FX }, NOW + 400000);
  assert.equal(mixed.fetchedAt, NOW);
  assert.equal(mixed.generatedAt, NOW + 400000);
  assert.deepEqual(mixed.flights.map((f) => f.flightNumber), EXPECTED_NUMBERS);
});

test('cache: a cached value is re-filtered to the request range, so a narrower request reuses nothing it should not return', () => {
  const s = setup({ providerFetch: fixtureFetch });
  s.direct({ airport: 'FRA', ...FX }, NOW);
  const narrow = s.direct({ airport: 'FRA', from: FX.from, to: FX.from + 11 * H }, NOW);   // different local strings: new key
  assert.equal(narrow.ok, true);
  assert.ok(narrow.flights.every((f) => f.scheduledDep < FX.from + 11 * H));
});

test('cache: malformed cache entries are treated as a miss; cache errors never fail the request', () => {
  const s = setup({ providerFetch: () => ok(adb(entry('DE9601', '2026-10-06 11:00Z'))) });
  const key = 'fcv2-dep-FRA-2026-10-06T12:00-2026-10-06T14:00-*';
  for (const junk of ['x', 5, {}, { flights: 'no', fetchedAt: 1, dropped: 0, droppedKeys: [] }, { flights: [], fetchedAt: 'x', dropped: 0, droppedKeys: [] }, { flights: [], fetchedAt: 1, droppedKeys: [] }, { flights: [], fetchedAt: 1, dropped: 0 }]) {
    s.cache.set(key, junk);
    s.calls.provider.length = 0;
    assert.equal(s.post({ airport: 'FRA', from: NOW + 2 * H, to: NOW + 4 * H }).flights.length, 1);
    assert.equal(s.calls.provider.length, 1);
  }
  s.env.cacheGet = () => { throw new Error('cache down'); };
  s.env.cachePut = () => { throw new Error('cache down'); };
  assert.equal(s.post({ airport: 'FRA', from: NOW + 2 * H, to: NOW + 4 * H }).ok, true);
});

// --- Per-flight server-cache validation -------------------------------------------

const wireFlight = (over = {}) => ({
  id: 'f_0123456789abcdef', flightNumber: 'DE9601', carrier: 'DE', origin: 'FRA', destination: 'PMI', destinationName: 'Palma de Mallorca',
  scheduledDep: NOW + 3 * H, revisedDep: NOW + 3 * H + 600000, status: 'delayed', aircraft: { model: 'Airbus A320', registration: 'D-AXXA' }, provenance: 'provider', ...over,
});
const cacheEntry = (flights, over = {}) => ({ fetchedAt: NOW - 1000, flights, dropped: 0, droppedKeys: [], ...over });
const CACHE_KEY = 'fcv2-dep-FRA-2026-10-06T12:00-2026-10-06T14:00-*';
const cacheRange = { airport: 'FRA', from: NOW + 2 * H, to: NOW + 4 * H };

test('cache validation: a fully valid cached entry is a hit (no provider call), whatever mix of null fields it carries', () => {
  const flights = [
    wireFlight(),
    wireFlight({ id: 'f_fedcba9876543210', flightNumber: 'LH1', carrier: null, destination: null, destinationName: null, revisedDep: null, status: 'unknown', aircraft: null, scheduledDep: NOW + 3 * H + 60000 }),
    wireFlight({ id: 'f_00000000000000aa', flightNumber: 'X'.repeat(16), aircraft: { model: null, registration: 'D-AXXB' }, destinationName: 'N'.repeat(60), scheduledDep: NOW + 3 * H + 120000 }),
    ...['scheduled', 'boarding', 'departed', 'cancelled'].map((status, i) => wireFlight({ id: `f_${String(i + 1).padStart(16, '0')}`, status, flightNumber: `DE${i}`, scheduledDep: NOW + 3 * H + 180000 + i })),
  ];
  for (const f of flights) assert.equal(gs.fcv2ValidWireFlight_(f, 'FRA'), true, JSON.stringify(f));
  const s = setup({ providerFetch: () => { throw new Error('the provider must not be called'); } });
  s.cache.set(CACHE_KEY, cacheEntry(flights));
  const r = s.post(cacheRange);
  assert.equal(r.ok, true);
  assert.equal(s.calls.provider.length, 0);
  assert.equal(r.flights.length, flights.length);
  assert.deepEqual(r.flights.find((f) => f.flightNumber === 'DE9601'), flights[0]);
  assert.equal(r.fetchedAt, NOW - 1000, 'the cached fetch time is reported');
});

test('cache validation: any invalid cached record discards the whole entry (provider called, fresh correct result, no exception)', () => {
  const good = wireFlight({ id: 'f_1111111111111111', flightNumber: 'DE0001', scheduledDep: NOW + 3 * H + 60000 });
  const bad = {
    'flights [null]': cacheEntry([null]),
    'flights [{}]': cacheEntry([{}]),
    'flights [[]]': cacheEntry([[]]),
    'flights [string]': cacheEntry(['DE1']),
    'text scheduledDep': cacheEntry([wireFlight({ scheduledDep: String(NOW + 3 * H) })]),
    'fractional scheduledDep': cacheEntry([wireFlight({ scheduledDep: NOW + 3 * H + 0.5 })]),
    'text revisedDep': cacheEntry([wireFlight({ revisedDep: 'soon' })]),
    'revisedDep missing': cacheEntry([(({ revisedDep, ...rest }) => rest)(wireFlight())]),
    'extra key': cacheEntry([wireFlight({ extra: 1 })]),
    'wrong origin': cacheEntry([wireFlight({ origin: 'MUC' })]),
    'bad status': cacheEntry([wireFlight({ status: 'Expected' })]),
    'aircraft with extra key': cacheEntry([wireFlight({ aircraft: { model: 'A320', registration: null, extra: true } })]),
    'aircraft missing key': cacheEntry([wireFlight({ aircraft: { model: 'A320' } })]),
    'aircraft long model': cacheEntry([wireFlight({ aircraft: { model: 'M'.repeat(61), registration: null } })]),
    'bad id': cacheEntry([wireFlight({ id: 'f_XYZ' })]),
    'bad flightNumber (empty)': cacheEntry([wireFlight({ flightNumber: '' })]),
    'bad flightNumber (17 chars)': cacheEntry([wireFlight({ flightNumber: 'D'.repeat(17) })]),
    'bad carrier': cacheEntry([wireFlight({ carrier: 'de' })]),
    'bad destination': cacheEntry([wireFlight({ destination: 'PMIX' })]),
    'long destinationName': cacheEntry([wireFlight({ destinationName: 'N'.repeat(61) })]),
    'bad provenance': cacheEntry([wireFlight({ provenance: 'roster' })]),
    'one bad record after good ones': cacheEntry([good, good, wireFlight({ status: 'x' })]),
    'droppedKeys not an array': cacheEntry([good], { droppedKeys: 'abc' }),
    'droppedKeys with a non-string': cacheEntry([good], { droppedKeys: ['a', 5] }),
    'dropped negative': cacheEntry([good], { dropped: -1 }),
    'dropped fractional': cacheEntry([good], { dropped: 1.5 }),
    'fetchedAt NaN': cacheEntry([good], { fetchedAt: NaN }),
    'fetchedAt text': cacheEntry([good], { fetchedAt: '1' }),
    'flights an object': cacheEntry({ 0: good }),
  };
  for (const [name, junk] of Object.entries(bad)) {
    const s = setup({ providerFetch: () => ok(adb(entry('DE9601', '2026-10-06 11:00Z'))) });
    s.cache.set(CACHE_KEY, junk);
    let r;
    assert.doesNotThrow(() => { r = s.post(cacheRange); }, name);
    assert.equal(r.ok, true, name);
    assert.equal(s.calls.provider.length, 1, `${name}: the provider is asked again`);
    assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE9601'], name);
    assert.equal(r.flights[0].origin, 'FRA', name);
    assert.equal(r.fetchedAt, NOW, `${name}: fresh data`);
    // The bad entry was replaced by the fresh one, which is a hit next time.
    assert.equal(gs.fcv2ValidWireFlight_(s.cache.get(CACHE_KEY).flights[0], 'FRA'), true, name);
    s.post(cacheRange);
    assert.equal(s.calls.provider.length, 1, `${name}: the replacement entry is valid`);
  }
  // The same flights are only valid for the airport they were requested for.
  assert.equal(gs.fcv2ValidWireFlight_(wireFlight(), 'MUC'), false);
  assert.equal(gs.fcv2ValidWireFlight_(wireFlight(), 'FRA'), true);
  // A throwing/garbage cacheGet value never throws out of the handler (also a non-plain value).
  for (const junk of [undefined, null, 0, 'x', [], [wireFlight()]]) {
    const s = setup({ providerFetch: () => ok(adb(entry('DE9601', '2026-10-06 11:00Z'))) });
    s.cache.set(CACHE_KEY, junk);
    assert.equal(s.post(cacheRange).flights.length, 1);
    assert.equal(s.calls.provider.length, 1);
  }
});

test('cache validation: whatever the normalizer produces passes the per-flight check (fixture, aircraft and null variants)', () => {
  const { flights } = gs.fcv2NormalizeAdb_({ departures: fixture.departures }, 'FRA', null, deps);
  assert.ok(flights.length >= 10);
  for (const f of plain(flights)) assert.equal(gs.fcv2ValidWireFlight_(f, 'FRA'), true, JSON.stringify(f));
  const more = gs.fcv2NormalizeAdb_({ departures: [
    entry('DE1', '2026-10-06 11:00Z', { status: 'weird' }),
    entry('X1', '2026-10-06 11:00:30Z', { aircraft: { model: 'M', reg: 'R' }, airline: {} }),
    { callSign: 'tui4xyz', movement: { scheduledTime: { utc: '2026-10-06 11:00Z' }, revisedTime: { utc: '2026-10-06 11:20Z' } } },
  ] }, 'PMI', null, deps).flights;
  assert.equal(more.length, 3);
  for (const f of plain(more)) assert.equal(gs.fcv2ValidWireFlight_(f, 'PMI'), true, JSON.stringify(f));
  assert.equal(gs.fcv2ValidChunkCache_(plain({ fetchedAt: NOW, flights, dropped: 0, droppedKeys: [] }), 'FRA'), true);
});

test('cache: a chunk whose JSON exceeds 90 000 characters is served but not cached', () => {
  const many = Array.from({ length: 600 }, (_, i) => entry(`DE${String(1000 + i)}`, '2026-10-06 11:00Z', { aircraft: { model: 'Airbus A320', reg: 'D-AXXX' } }));
  const s = setup({ providerFetch: () => ok(adb(...many)) });
  const r = s.post(range(3));
  assert.equal(r.flights.length, 600);
  assert.ok(JSON.stringify({ fetchedAt: NOW, flights: r.flights, dropped: 0, droppedKeys: [] }).length > 90000);
  assert.equal(s.calls.cachePuts.length, 0);
  s.post(range(3));
  assert.equal(s.calls.provider.length, 2, 'not cached, so asked again');
});

// --- Provider semantics: empty windows (M1) ---------------------------------------

test('provider 204 and an empty 200 mean "no flights in this window": an empty list, cached; other statuses keep failing', () => {
  const variants = {
    '204 empty': { status: 204, body: '' },
    '204 no body': { status: 204 },
    '204 null body': { status: 204, body: null },
    '200 empty': { status: 200, body: '' },
    '200 whitespace': { status: 200, body: ' \n ' },
  };
  for (const [name, response] of Object.entries(variants)) {
    const s = setup({ providerFetch: () => response });
    const r = s.post(range(3));
    assert.equal(r.ok, true, name);
    assert.deepEqual(r.flights, [], name);
    assert.equal(r.dropped, 0, name);
    assert.equal(s.calls.cachePuts.length, 1, `${name}: an empty window is cacheable`);
    s.post(range(3));
    assert.equal(s.calls.provider.length, 1, `${name}: the second request is served from the cache`);
  }
  // One empty window among others does not disturb the rest, and a 204 is not retried.
  const mixed = setup({ providerFetch: (_u, _k, n) => (n === 1 ? { status: 204, body: '' } : ok(adb(entry('DE9701', '2026-10-06 21:30Z')))) });
  const r = mixed.post(range(20));
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE9701']);
  assert.deepEqual(mixed.calls.sleeps, [1100]);
  // Everything else stays an error.
  for (const status of [201, 202, 205, 301, 400, 404, 500, 503]) {
    const s = setup({ providerFetch: () => ({ status, body: '' }) });
    assert.deepEqual(s.post(range(3)), { ok: false, error: 'provider-unavailable' }, String(status));
  }
  assert.deepEqual(setup({ providerFetch: () => ({ status: 200, body: 'not json' }) }).post(range(3)), { ok: false, error: 'provider-unavailable' });
  assert.deepEqual(setup({ providerFetch: () => ({ status: 200 }) }).post(range(3)), { ok: false, error: 'provider-unavailable' });
  assert.deepEqual(setup({ providerFetch: () => ({ status: 429, body: '' }) }).post(range(3)), { ok: false, error: 'provider-rate-limited' });
  assert.deepEqual(setup({ providerFetch: () => ({ status: 401, body: '' }) }).post(range(3)), { ok: false, error: 'provider-auth-failed' });
});

// --- Provider windows next to a UTC-offset change (L1) ----------------------------

const adbUtc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
/**
 * A fake provider that reads the local strings like the real one: it answers with every flight whose
 * airport-local wall-clock time lies in [fromLocal, toLocal], both occurrences of a repeated hour included.
 * flights: [{number, t, status?}] (t = instant); the status is read at call time.
 */
function windowProvider(tz, flights) {
  const locals = flights.map((f) => localIso(f.t, tz).slice(0, 16));
  return (url) => {
    const [fromLocal, toLocal] = url.split('?')[0].split('/').slice(-2);
    const hits = flights.filter((_, i) => locals[i] >= fromLocal && locals[i] <= toLocal);
    return ok(adb(...hits.map((f) => entry(f.number, adbUtc(f.t), { status: f.status ?? 'Expected' }))));
  };
}
const every = (from, to, minutes, prefix = 'DE') => {
  const list = [];
  for (let t = from, i = 0; t < to; t += minutes * 60000, i++) list.push({ number: `${prefix}${1000 + i}`, t });
  return list;
};
const CHANGES = [
  { name: 'London fall-back', airport: 'LHR', tz: 'Europe/London', change: T('2026-10-25T01:00:00Z') },
  { name: 'New York fall-back', airport: 'JFK', tz: 'America/New_York', change: T('2026-11-01T06:00:00Z') },
  { name: 'Frankfurt fall-back', airport: 'FRA', tz: 'Europe/Berlin', change: T('2026-10-25T01:00:00Z') },
  { name: 'Sydney fall-back', airport: 'SYD', tz: 'Australia/Sydney', change: T('2026-04-04T16:00:00Z') },
  { name: 'London spring-forward', airport: 'LHR', tz: 'Europe/London', change: T('2026-03-29T01:00:00Z') },
  { name: 'New York spring-forward', airport: 'JFK', tz: 'America/New_York', change: T('2026-03-08T07:00:00Z') },
  { name: 'Frankfurt spring-forward', airport: 'FRA', tz: 'Europe/Berlin', change: T('2026-03-29T01:00:00Z') },
  { name: 'Sydney spring-forward', airport: 'SYD', tz: 'Australia/Sydney', change: T('2026-10-03T16:00:00Z') },
];
const MIN = 60000;

function runWindow(c, fromOffsetMin, toOffsetMin, step = 3) {
  const flights = every(c.change - 40 * H, c.change + 40 * H, step);
  const s = setup({ providerFetch: windowProvider(c.tz, flights) });
  const from = c.change + fromOffsetMin * MIN;
  const to = c.change + toOffsetMin * MIN;
  const r = s.direct({ airport: c.airport, from, to }, c.change);
  const expected = flights.filter((f) => f.t >= from && f.t < to).map((f) => f.number);
  return { r, s, expected, from, to };
}

test('DST fall-back outer boundary: from/to inside the repeated hour lose no flight (local-window provider)', () => {
  const falls = CHANGES.filter((c) => c.name.includes('fall-back'));
  // [from, to] offsets in minutes from the changeover instant: in the first and in the second occurrence of the hour.
  const windows = [[-50, 300], [10, 300], [-300, -20], [-300, 40], [-50, 40], [-18, 400], [30, 120], [-120, -45]];
  for (const c of falls) {
    for (const [a, b] of windows) {
      const { r, expected, s } = runWindow(c, a, b);
      assert.equal(r.ok, true, `${c.name} [${a}, ${b}]`);
      assert.deepEqual(r.flights.map((f) => f.flightNumber), expected, `${c.name} [${a}, ${b}] min around the changeover`);
      assert.ok(expected.length > 0);
      assert.ok(s.calls.provider.length <= 3);
    }
  }
});

test('DST padding: 1 h outward on a boundary within 1 h of an offset change, never otherwise (provider range only)', () => {
  const c = CHANGES[0];                                        // London, change 01:00Z
  const urlWindows = (from, to, now = c.change) => {
    const s = setup({ providerFetch: () => ok(adb()) });
    s.direct({ airport: c.airport, from, to }, now);
    return s.calls.provider.map(([u]) => u.split('?')[0].split('/').slice(-2));
  };
  const local = (ms) => localIso(ms, c.tz).slice(0, 16);
  // `from` exactly 60 min before the change pads (instant + 1 h reaches the change), 61 min does not.
  assert.deepEqual(urlWindows(c.change - 61 * MIN, c.change + 3 * H), [[local(c.change - 61 * MIN), local(c.change + 3 * H)]]);
  assert.deepEqual(urlWindows(c.change - 60 * MIN, c.change + 3 * H), [[local(c.change - 2 * H), local(c.change + 3 * H)]]);
  // `from` 59 min after the change pads (instant - 1 h is still before it), 60 min does not.
  assert.deepEqual(urlWindows(c.change + 59 * MIN, c.change + 5 * H), [[local(c.change - 1 * MIN), local(c.change + 5 * H)]]);
  assert.deepEqual(urlWindows(c.change + 60 * MIN, c.change + 5 * H), [[local(c.change + 60 * MIN), local(c.change + 5 * H)]]);
  // Same for `to`.
  assert.deepEqual(urlWindows(c.change - 4 * H, c.change - 60 * MIN), [[local(c.change - 4 * H), local(c.change)]]);
  assert.deepEqual(urlWindows(c.change - 4 * H, c.change - 61 * MIN), [[local(c.change - 4 * H), local(c.change - 61 * MIN)]]);
  assert.deepEqual(urlWindows(c.change - 4 * H, c.change + 59 * MIN), [[local(c.change - 4 * H), local(c.change + 119 * MIN)]]);
  assert.deepEqual(urlWindows(c.change - 4 * H, c.change + 60 * MIN), [[local(c.change - 4 * H), local(c.change + 60 * MIN)]]);
  // Far from any change: exactly the requested window.
  const far = T('2026-06-10T10:00:00Z');
  assert.deepEqual(urlWindows(far, far + 3 * H, far), [[local(far), local(far + 3 * H)]]);
  // The padded range is still cut by instant: nothing outside [from, to) is returned.
  const { r, from, to } = runWindow(c, -50, 40);
  assert.ok(r.flights.every((f) => f.scheduledDep >= from && f.scheduledDep < to));
  assert.equal(r.from, from);
  assert.equal(r.to, to);
});

test('DST padding: at most three provider calls for any range up to 24 h around a changeover, every flight returned', () => {
  let seed = 4711;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let max = 0;
  for (const c of CHANGES) {
    const flights = every(c.change - 40 * H, c.change + 40 * H, 5);
    for (let k = 0; k < 14; k++) {
      const fromOffset = Math.floor(rnd() * 26 * 60) - 13 * 60;                       // minutes from the change
      const length = k < 3 ? 24 * 60 : 1 + Math.floor(rnd() * 24 * 60);               // some full 24 h ranges
      const from = c.change + fromOffset * MIN + (k % 4 === 0 ? Math.floor(rnd() * MIN) : 0);   // some off the minute
      const to = Math.min(from + length * MIN, from + 24 * H);
      const s = setup({ providerFetch: windowProvider(c.tz, flights) });
      const r = s.direct({ airport: c.airport, from, to }, c.change);
      assert.equal(r.ok, true);
      const expected = flights.filter((f) => f.t >= from && f.t < to).map((f) => f.number);
      assert.deepEqual(r.flights.map((f) => f.flightNumber), expected, `${c.name} from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`);
      max = Math.max(max, s.calls.provider.length);
    }
  }
  assert.ok(max <= 3, `max provider calls ${max}`);
});

// --- Whole-minute provider boundaries ---------------------------------------------

const isoSec = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
/**
 * A fake provider with minute-resolution LOCAL strings, like AeroDataBox: it answers every flight whose airport-local
 * wall-clock MINUTE lies from fromLocal (inclusive) to toLocal (inclusive, or exclusive when `exclusiveEnd`).
 * flights: [{number, t}] (t = instant, may carry seconds; its local minute is the minute it falls in).
 */
const localMinuteMemo = new Map();                         // Intl formatting is slow: one answer per (zone, minute)
const localMinuteOf = (ms, tz) => {
  const key = `${tz}|${Math.floor(ms / 60000)}`;
  if (!localMinuteMemo.has(key)) localMinuteMemo.set(key, localIso(ms, tz).slice(0, 16));
  return localMinuteMemo.get(key);
};
function minuteProvider(tz, flights, exclusiveEnd) {
  const locals = flights.map((f) => localMinuteOf(f.t, tz));
  return (url) => {
    const [fromLocal, toLocal] = url.split('?')[0].split('/').slice(-2);
    const hits = flights.filter((_, i) => locals[i] >= fromLocal && (exclusiveEnd ? locals[i] < toLocal : locals[i] <= toLocal));
    return ok(adb(...hits.map((f) => entry(f.number, isoSec(f.t)))));
  };
}
const urlWindowsOf = (s) => s.calls.provider.map(([u]) => u.split('?')[0].split('/').slice(-2));

test('whole-minute provider end: `to` with seconds is rounded UP (exclusive-end provider keeps the 10:30 flight, nothing at/after `to` is returned)', () => {
  const from = T('2026-10-06T10:00:00Z');
  const to = T('2026-10-06T10:30:20Z');
  const flights = [
    { number: 'DE2001', t: T('2026-10-06T10:29:00Z') },
    { number: 'DE2002', t: T('2026-10-06T10:30:00Z') },       // 10:30:00 < to: in range
    { number: 'DE2003', t: T('2026-10-06T10:30:19Z') },       // in range (second resolution)
    { number: 'DE2004', t: T('2026-10-06T10:30:20Z') },       // exactly `to`: out
    { number: 'DE2005', t: T('2026-10-06T10:30:45Z') },       // same minute, after `to`: out
    { number: 'DE2006', t: T('2026-10-06T10:31:00Z') },       // out
  ];
  for (const exclusiveEnd of [true, false]) {
    const s = setup({ providerFetch: minuteProvider('Europe/Berlin', flights, exclusiveEnd) });
    const r = s.direct({ airport: 'FRA', from, to });
    assert.equal(r.ok, true);
    assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE2001', 'DE2002', 'DE2003'], exclusiveEnd ? 'exclusive end' : 'inclusive end');
    assert.deepEqual(urlWindowsOf(s), [['2026-10-06T12:00', '2026-10-06T12:31']], 'start floored, end rounded up to 12:31 local');
  }
  // A `to` already on a whole minute is unchanged (no extra minute asked).
  const whole = setup({ providerFetch: minuteProvider('Europe/Berlin', flights, true) });
  const r = whole.direct({ airport: 'FRA', from, to: T('2026-10-06T10:30:00Z') });
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE2001']);
  assert.deepEqual(urlWindowsOf(whole), [['2026-10-06T12:00', '2026-10-06T12:30']]);
});

test('whole-minute provider start: `from` with seconds is floored, flights before it are cut by instant', () => {
  const from = T('2026-10-06T10:00:40Z');
  const to = T('2026-10-06T11:00:00Z');
  const flights = [
    { number: 'DE2101', t: T('2026-10-06T10:00:00Z') },       // before `from`: out
    { number: 'DE2102', t: T('2026-10-06T10:00:39Z') },       // out
    { number: 'DE2103', t: T('2026-10-06T10:00:40Z') },       // exactly `from`: in
    { number: 'DE2104', t: T('2026-10-06T10:01:00Z') },
    { number: 'DE2105', t: T('2026-10-06T10:59:00Z') },
    { number: 'DE2106', t: T('2026-10-06T11:00:00Z') },       // exactly `to`: out
  ];
  for (const exclusiveEnd of [true, false]) {
    const s = setup({ providerFetch: minuteProvider('Europe/Berlin', flights, exclusiveEnd) });
    const r = s.direct({ airport: 'FRA', from, to });
    assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE2103', 'DE2104', 'DE2105'], exclusiveEnd ? 'exclusive end' : 'inclusive end');
    assert.deepEqual(urlWindowsOf(s), [['2026-10-06T12:00', '2026-10-06T13:00']]);
  }
  // A range of exactly 12 h from an off-minute start: the rounded window would be 12 h 1 min, so it is split in two
  // windows of at most 12 local hours, and the flights at both edges (second resolution) are still returned.
  const f2 = T('2026-10-06T10:00:30Z');
  const t2 = f2 + 12 * H;
  const s = setup({ providerFetch: minuteProvider('Europe/Berlin', [{ number: 'DE2201', t: f2 }, { number: 'DE2202', t: t2 - 1000 }, { number: 'DE2203', t: t2 }], true) });
  const r = s.direct({ airport: 'FRA', from: f2, to: t2 });
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE2201', 'DE2202']);
  assert.equal(s.calls.provider.length, 2);
  for (const [a, b] of urlWindowsOf(s)) assert.ok(localMin(b) - localMin(a) <= 720, `${a}..${b}`);
});

test('whole-minute windows: rounding never pushes a window above 12 local hours, chunks stay contiguous, at most 3 chunks up to 26 h', () => {
  const MINUTE = 60000;
  const floorMin = (ms) => Math.floor(ms / MINUTE) * MINUTE;
  const ceilMin = (ms) => Math.ceil(ms / MINUTE) * MINUTE;
  for (const [tz, base] of [['Europe/Berlin', T('2026-10-06T10:00:00Z')], ['Europe/Berlin', T('2026-03-28T22:00:00Z')], ['America/New_York', T('2026-03-08T04:00:00Z')]]) {
    for (const startSec of [0, 1, 30, 59]) {
      for (const hours of [11, 11.5, 12, 12.01, 13, 23, 24, 25, 26]) {
        for (const endSec of [0, 1, 59]) {
          const from = base + startSec * 1000;
          const to = from + Math.round(hours * H) + (endSec - startSec) * 1000;
          const chunks = chunksOf(from, to, tz);
          chunks.forEach((c, i) => {
            assert.ok(localMin(c.toLocal) - localMin(c.fromLocal) <= 720, `${tz} ${hours} h: ${c.fromLocal}..${c.toLocal}`);
            assert.ok(c.fromLocal <= c.toLocal);
            if (i > 0) assert.ok(floorMin(c.start) <= chunks[i - 1].end, 'contiguous');
          });
          assert.ok(chunks.length <= 3 || hours > 26, `${tz} ${hours} h: ${chunks.length} chunks`);
          // The last window reaches the whole minute at or above `to`.
          const last = chunks.at(-1);
          assert.equal(localMin(last.toLocal) * MINUTE, localMin(localIso(ceilMin(last.end), tz).slice(0, 16)) * MINUTE);
          assert.ok(last.end >= to - MINUTE || chunks.length > 1);
        }
      }
    }
  }
  const from = T('2026-10-06T10:00:30Z');
  assert.equal(chunksOf(from, from + 12 * H).length, 2, '12 h from an off-minute start: the rounded window would be 12 h 1 min, so two windows');
  assert.equal(chunksOf(from - 30000, from - 30000 + 12 * H).length, 1, '12 h on whole minutes is one window');
});

test('whole-minute windows: property test, exclusive-end provider, both DST changes in six zones (no flight missed, none out of range, <= 12 local hours, <= 3 calls)', () => {
  const zones = [
    { name: 'Frankfurt', airport: 'FRA', tz: 'Europe/Berlin', changes: [T('2026-03-29T01:00:00Z'), T('2026-10-25T01:00:00Z')] },
    { name: 'London', airport: 'LHR', tz: 'Europe/London', changes: [T('2026-03-29T01:00:00Z'), T('2026-10-25T01:00:00Z')] },
    { name: 'New York', airport: 'JFK', tz: 'America/New_York', changes: [T('2026-03-08T07:00:00Z'), T('2026-11-01T06:00:00Z')] },
    { name: 'Sydney', airport: 'SYD', tz: 'Australia/Sydney', changes: [T('2026-10-03T16:00:00Z'), T('2026-04-04T16:00:00Z')] },
    { name: 'Auckland', airport: 'AKL', tz: 'Pacific/Auckland', changes: [T('2026-09-26T14:00:00Z'), T('2026-04-04T14:00:00Z')] },
    { name: 'Halifax', airport: 'YHZ', tz: 'America/Halifax', changes: [T('2026-03-08T06:00:00Z'), T('2026-11-01T05:00:00Z')] },
  ];
  const quiet = [{ name: 'Dubai', airport: 'DXB', tz: 'Asia/Dubai', changes: [T('2026-06-10T10:00:00Z')] }, { name: 'Tokyo', airport: 'HND', tz: 'Asia/Tokyo', changes: [T('2026-06-10T10:00:00Z')] }];
  let seed = 20261006;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const stats = { ranges: 0, missing: 0, outOfRange: 0, maxSpanMin: 0, maxCalls: 0, offMinuteFrom: 0, offMinuteTo: 0, exactly24h: 0, flightsChecked: 0 };
  const cases = [];
  for (const z of zones) for (const change of z.changes) cases.push({ z, change, n: 170 });
  for (const z of quiet) cases.push({ z, change: z.changes[0], n: 150 });
  for (const { z, change, n } of cases) {
    const sparse = [];                                                                 // a flight every 17 minutes everywhere ...
    for (let m = Math.ceil((change - 40 * H) / MIN); m < (change + 40 * H) / MIN; m += 17) sparse.push(m);
    for (let k = 0; k < n; k++) {
      const whole = k % 3 === 0;                                                       // a third on whole minutes
      const fromBase = change + (Math.floor(rnd() * 26 * 60) - 13 * 60) * MIN;
      const from = whole ? fromBase : fromBase + Math.floor(rnd() * MIN);              // seconds and milliseconds
      let length;
      if (k % 7 === 0) length = 24 * H;
      else if (k % 11 === 0) length = [11, 12, 12.5, 22, 23, 23.5][Math.floor(rnd() * 6)] * H;
      else length = (1 + Math.floor(rnd() * 24 * 60)) * MIN;
      const to = Math.min(from + length + (whole ? 0 : Math.floor(rnd() * MIN)), from + 24 * H);
      if (to <= from) continue;
      // ... and a flight at EVERY whole minute within 4 minutes of the range edges and of every provider window edge.
      const minutes = new Set(sparse);
      const asked = gs.fcv2ProviderRange_(from, to, z.tz, deps);
      const edges = [from, to, asked.from, asked.to];
      for (const c of gs.fcv2DepartureChunks_(asked.from, asked.to, z.tz, deps)) edges.push(c.start, c.end);
      for (const e of edges) for (let d = -4; d <= 4; d++) minutes.add(Math.floor(e / MIN) + d);
      const flights = [...minutes].map((m) => ({ number: `DE${m}`, t: m * MIN }));
      const provider = minuteProvider(z.tz, flights, true);
      const s = setup({ providerFetch: provider });
      const r = s.direct({ airport: z.airport, from, to }, change);
      assert.equal(r.ok, true, `${z.name} ${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
      const got = new Set(r.flights.map((f) => f.flightNumber));
      const expected = flights.filter((f) => f.t >= from && f.t < to);
      const missing = expected.filter((f) => !got.has(f.number)).length;
      const outOfRange = r.flights.filter((f) => f.scheduledDep < from || f.scheduledDep >= to).length;
      const windows = urlWindowsOf(s);
      stats.ranges += 1;
      stats.missing += missing;
      stats.outOfRange += outOfRange;
      stats.flightsChecked += expected.length;
      stats.maxCalls = Math.max(stats.maxCalls, windows.length);
      for (const [a, b] of windows) stats.maxSpanMin = Math.max(stats.maxSpanMin, localMin(b) - localMin(a));
      if (from % MIN) stats.offMinuteFrom += 1;
      if (to % MIN) stats.offMinuteTo += 1;
      if (to - from === 24 * H) stats.exactly24h += 1;
      assert.equal(missing, 0, `${z.name}: ${missing} flight(s) missed, ${new Date(from).toISOString()}..${new Date(to).toISOString()}`);
      assert.equal(outOfRange, 0);
    }
  }
  console.log(`property: ${JSON.stringify(stats)}`);
  assert.ok(stats.ranges >= 2000, `ranges ${stats.ranges}`);
  assert.ok(stats.offMinuteFrom > 500 && stats.offMinuteTo > 500, 'off-minute edges are exercised');
  assert.equal(stats.missing, 0);
  assert.equal(stats.outOfRange, 0);
  assert.ok(stats.maxSpanMin <= 720, `max local span ${stats.maxSpanMin} min`);
  assert.ok(stats.maxCalls <= 3, `max calls ${stats.maxCalls}`);
});

// --- dropped counted once per request (L6) ----------------------------------------

test('dropped: a provider entry returned by two overlapping chunks is counted once; repeats inside one response still count', () => {
  const junkNoTime = { number: 'DE9801', movement: { scheduledTime: { local: '2026-10-06 22:00+02:00' } } };
  const junkBadUtc = { number: 'DE9802', movement: { scheduledTime: { utc: 'garbage' } } };
  const junkNoNumber = { movement: { scheduledTime: { utc: '2026-10-06 22:00Z' } } };
  const onlyChunk2 = { callSign: 'DLH9803', movement: { scheduledTime: {} } };
  const twin = { number: 'DE9804' };
  const s = setup({
    providerFetch: (_u, _k, n) => ok(adb(
      junkNoTime, junkBadUtc, junkNoNumber, null, 'junk', twin, twin,    // returned by every chunk
      ...(n === 2 ? [onlyChunk2] : []), entry('DE9800', '2026-10-06 21:30Z'))),
  });
  const r = s.post(range(20));
  assert.equal(s.calls.provider.length, 2);
  assert.equal(r.dropped, 8, '7 distinct dropped entries (the twin counts twice) + 1 only in the second chunk; not 15');
  assert.deepEqual(r.flights.map((f) => f.flightNumber), ['DE9800'], 'the real flight is kept once');
  assert.equal(s.post(range(20)).dropped, 8, 'same count when both chunks come from the cache');
  const single = setup({ providerFetch: () => ok(adb(junkNoTime, junkNoTime)) });
  assert.equal(single.post(range(3)).dropped, 2);
  // Normalization exposes the keys the handler dedupes by (flight number / call sign + raw scheduled utc).
  const keys = normalize({ departures: [junkBadUtc, junkNoTime, twin, twin] }).droppedKeys;
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4);
  assert.ok(keys[0].includes('DE9802') && keys[0].includes('garbage'));
  assert.deepEqual(normalize({ departures: [junkBadUtc] }).droppedKeys, normalize({ departures: [junkBadUtc] }).droppedKeys, 'stable');
});

// --- the newest fetch wins a duplicate flight id (L8) -----------------------------

test('dedupe: the same flight in two chunks keeps the copy from the chunk fetched last (ties: the later chunk)', () => {
  const when = '2026-10-06 21:30Z';                      // inside the overlap of chunk 1 (10:00-22:00Z) and chunk 2 (21:00Z-)
  const statuses = { current: { 1: 'Expected', 2: 'Expected' } };
  const provider = (url) => {
    const call = url.includes('T12:00/') ? 1 : 2;         // 1 = first chunk of the request (12:00 local), 2 = second
    return ok(adb(entry('DE9900', when, { status: statuses.current[call] })));
  };
  const chunkKeys = (s) => [...s.cache.keys()].sort();
  const statusOf = (r) => r.flights.find((f) => f.flightNumber === 'DE9900').status;

  // Older cached chunk 1 (Expected) + fresh chunk 2 (Delayed): the newer fetch wins although it is the later chunk.
  const s = setup({ providerFetch: provider });
  assert.equal(statusOf(s.direct(range(20), NOW)), 'scheduled');
  statuses.current = { 1: 'Expected', 2: 'Delayed' };
  s.cache.delete(chunkKeys(s)[1]);
  s.calls.provider.length = 0;
  const later = s.direct(range(20), NOW + 5 * 60000);
  assert.equal(s.calls.provider.length, 1, 'only the second chunk was fetched again');
  assert.equal(statusOf(later), 'delayed', 'fresh later chunk beats the older cached one');
  assert.equal(later.fetchedAt, NOW, 'fetchedAt is still the oldest fetch among the chunks used');

  // Fresh chunk 1 (Boarding) + older cached chunk 2 (Delayed): now the EARLIER chunk is the newer copy.
  statuses.current = { 1: 'Boarding', 2: 'Expected' };
  s.cache.delete(chunkKeys(s)[0]);
  s.calls.provider.length = 0;
  const earlier = s.direct(range(20), NOW + 10 * 60000);
  assert.equal(s.calls.provider.length, 1);
  assert.equal(statusOf(earlier), 'boarding', 'fresh earlier chunk beats the older cached later chunk');

  // Equal fetchedAt: the later chunk wins.
  const t = setup({ providerFetch: (_u, _k, n) => ok(adb(entry('DE9900', when, { status: n === 1 ? 'Expected' : 'Delayed' }))) });
  assert.equal(statusOf(t.direct(range(20), NOW)), 'delayed');
  assert.equal(new Set(t.direct(range(20), NOW).flights.map((f) => f.id)).size, 1);
});

// --- partial deploy: RosterApiV2.gs without DeparturesV2.gs (L5) ------------------

test('partial deploy: without DeparturesV2.gs, departures is not offered and answers departures-not-configured even with the key set', () => {
  const partial = loadGs(GS_FILES.filter((f) => f !== 'DeparturesV2.gs'));
  assert.equal(partial.fcv2HandleDepartures_, undefined, 'the departures handler is really absent in this sandbox');
  const run = (g, opts, body) => {
    const f = fakeEnv(g, { now: ROSTER_NOW, feed: feedEvents(), synced: syncedEvents(), rows: hotelRows(feedEvents()), ...opts });
    return { f, res: plain(g.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, ...body }), f.env)) };
  };
  const live = { departuresKey: KEY, providerFetch: () => { throw new Error('provider must not be called'); } };
  const req = { action: 'departures', airport: 'FRA', from: ROSTER_NOW + H, to: ROSTER_NOW + 2 * H };
  const { f, res } = run(partial, live, req);
  assert.deepEqual(res, { ok: false, error: 'departures-not-configured' });
  assert.equal(f.calls.provider.length, 0);
  assert.equal(f.calls.sleeps.length, 0);
  const caps = run(partial, live, { action: 'capabilities' }).res;
  assert.deepEqual(caps.actions, ['capabilities', 'roster', 'history', 'stats']);
  assert.equal(caps.limits.departuresMaxHours, 24, 'limits are unchanged');
  // With the file present and the key set, nothing changes for a full deployment.
  assert.deepEqual(run(gs, { departuresKey: KEY }, { action: 'capabilities' }).res.actions, ['capabilities', 'roster', 'history', 'stats', 'departures']);
  // Existing actions answer exactly as with the full deployment.
  for (const body of [{ action: 'roster' }, { action: 'history', to: '2026-10-03' }, { action: 'stats' }, { action: 'nope' }]) {
    assert.deepEqual(run(partial, live, body).res, run(gs, {}, body).res, JSON.stringify(body));
  }
  // Auth still comes first.
  assert.equal(plain(partial.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: 'wrong', ...req }), fakeEnv(partial, { now: ROSTER_NOW, ...live }).env)).error, 'unauthorized');
});

// --- Secrecy ----------------------------------------------------------------------

test('secrecy: neither the key, the URL, nor any provider body appears in any response', () => {
  const secrets = [KEY, 'PROVIDER-BODY-SECRET', 'rapidapi', 'http', 'x-rapidapi', 'aerodatabox.p'];
  const scenarios = [
    () => ({ status: 429, body: 'PROVIDER-BODY-SECRET' }),
    () => ({ status: 401, body: 'PROVIDER-BODY-SECRET' }),
    () => ({ status: 500, body: `PROVIDER-BODY-SECRET ${KEY}` }),
    () => { throw new Error(`failed ${KEY} https://aerodatabox.p.rapidapi.com`); },
    () => ({ status: 200, body: '<html>PROVIDER-BODY-SECRET</html>' }),
    () => ({ status: 200, body: JSON.stringify({ departures: [{ number: 'DE9701', movement: { scheduledTime: { utc: '2026-10-06 11:00Z' } }, secret: 'PROVIDER-BODY-SECRET', url: 'https://x.invalid' }], note: KEY }) }),
  ];
  for (const providerFetch of scenarios) {
    const s = setup({ providerFetch });
    const text = JSON.stringify(s.post(range(3)));
    for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} in ${text}`);
    assert.doesNotThrow(() => s.post(range(3)));
  }
  const s = setup({ providerFetch: fixtureFetch });
  const full = JSON.stringify(s.post({ airport: 'FRA', ...FX }));
  for (const secret of [KEY, 'rapidapi', 'http', 'PROVIDER-BODY-SECRET']) assert.ok(!full.includes(secret));
  assert.ok(!JSON.stringify(s.post({ contract: 'x' })).includes(KEY));
  assert.ok(![...s.cache.values()].some((v) => JSON.stringify(v).includes(KEY)), 'the key is never cached');
  assert.ok(!JSON.stringify(plain(s.post({ action: 'capabilities' }))).includes(KEY));
});

test('the provider key literal never appears in the source and the property name is the documented one', () => {
  const src = readFileSync(new URL('../backend/apps-script/DeparturesV2.gs', import.meta.url), 'utf8');
  assert.equal(gs.FCV2_DEP_KEY_PROPERTY_, 'FC_ADB_RAPIDAPI_KEY');
  assert.ok(!/[A-Fa-f0-9]{32,}/.test(src), 'no key-like literal');
  assert.ok(!/mock|sample data|fallback/i.test(src.replace(/no mock or sample data/i, '')), 'no mock/sample fallback');
});

// --- Auth, capabilities, existing actions -----------------------------------------

test('auth is required first: no/wrong token, wrong contract/version are refused before any provider call', () => {
  const s = setup({ providerFetch: fixtureFetch });
  const send = (body) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'departures', airport: 'FRA', ...FX, ...body }), s.env));
  assert.equal(send({}).error, 'unauthorized');
  assert.equal(send({ token: TOKEN + 'x' }).error, 'unauthorized');
  assert.equal(send({ token: 5 }).error, 'unauthorized');
  assert.equal(send({ token: TOKEN, version: 3 }).error, 'unsupported-contract');
  assert.equal(send({ token: TOKEN, contract: 'other' }).error, 'unsupported-contract');
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'departures', token: TOKEN, airport: 'FRA', ...FX }), setup({ token: null }).env)).error, 'not-configured');
  assert.equal(s.calls.provider.length, 0);
  assert.equal(s.calls.sleeps.length, 0);
  assert.equal(send({ token: TOKEN }).ok, true);
});

test('capabilities gating: departures only with a key, limits always carry departuresMaxHours', () => {
  const caps = (opts) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'capabilities', token: TOKEN }), fakeEnv(gs, { now: NOW, ...opts }).env));
  assert.deepEqual(caps({}).actions, ['capabilities', 'roster', 'history', 'stats']);
  assert.deepEqual(caps({ departuresKey: '' }).actions, ['capabilities', 'roster', 'history', 'stats']);
  assert.deepEqual(caps({ departuresKey: KEY }).actions, ['capabilities', 'roster', 'history', 'stats', 'departures']);
  assert.equal(caps({}).limits.departuresMaxHours, 24);
  assert.equal(caps({ departuresKey: KEY }).limits.departuresMaxHours, 24);
  const without = caps({});
  assert.deepEqual(without, {
    ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', generatedAt: NOW,
    actions: ['capabilities', 'roster', 'history', 'stats'],
    limits: { rosterMaxDays: without.limits.rosterMaxDays, historyMaxMonths: without.limits.historyMaxMonths, historyMaxSectors: without.limits.historyMaxSectors, departuresMaxHours: 24 },
    source: { adapter: 'condor-calendar', baseTimeZone: 'Europe/Berlin' },
  });
  assert.deepEqual(Object.keys(without.limits), ['rosterMaxDays', 'historyMaxMonths', 'historyMaxSectors', 'departuresMaxHours']);
  const env = fakeEnv(gs, { now: NOW, departuresKey: undefined }).env;
  delete env.departuresKey;
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'capabilities', token: TOKEN }), env)).ok, true, 'an env without the function still answers capabilities');
});

test('existing actions are unaffected by the departures configuration', () => {
  const run = (opts, body) => {
    const f = fakeEnv(gs, { now: ROSTER_NOW, feed: feedEvents(), synced: syncedEvents(), rows: hotelRows(feedEvents()), ...opts });
    return JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, ...body }), f.env));
  };
  const withKey = { departuresKey: KEY, providerFetch: () => { throw new Error('departures must not be touched'); } };
  for (const body of [{ action: 'roster' }, { action: 'history', to: '2026-10-03' }, { action: 'stats' }, { action: 'nope' }]) {
    assert.equal(run({}, body), run(withKey, body), JSON.stringify(body));
  }
  assert.equal(JSON.parse(run({}, { action: 'nope' })).error, 'unknown-action');
  assert.equal(JSON.parse(run({}, { action: 'roster' })).ok, true);
  assert.equal(JSON.parse(run({}, { action: 'history', to: '2026-10-03' })).ok, true);
  assert.equal(JSON.parse(run({}, { action: 'stats' })).marker, 'v5-payload');
});

// --- Load order -------------------------------------------------------------------

function runFiles(files, extra = '') {
  const sandbox = { Utilities: {} };
  vm.createContext(sandbox);
  const code = files.map((f) => readFileSync(new URL(`../backend/apps-script/${f}`, import.meta.url), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;${extra}`, sandbox);
  return sandbox;
}

test('load order: DeparturesV2.gs is last in GS_FILES, loads alone, and nothing else needs it while loading', () => {
  assert.equal(GS_FILES.at(-1), 'DeparturesV2.gs');
  assert.doesNotThrow(() => runFiles(['DeparturesV2.gs']), 'no top-level dependency on any other file');
  assert.doesNotThrow(() => runFiles(GS_FILES.filter((f) => f !== 'DeparturesV2.gs')), 'the others load without it (functions reference it only at call time)');
  assert.doesNotThrow(() => runFiles(GS_FILES));
  // Any order of the departures file still loads (file-by-file top-level evaluation).
  for (const order of [['DeparturesV2.gs', ...GS_FILES.slice(0, -1)], [...GS_FILES.slice(0, 3), 'DeparturesV2.gs', ...GS_FILES.slice(3, -1)]]) {
    assert.doesNotThrow(() => runFiles(order));
  }
});

test('naming: every top-level name in DeparturesV2.gs starts with fcv2/FCV2 and ends in an underscore; nothing but declarations at top level', () => {
  const src = readFileSync(new URL('../backend/apps-script/DeparturesV2.gs', import.meta.url), 'utf8');
  const names = [...src.matchAll(/^(?:function|const|let|var)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  assert.ok(names.length >= 15);
  for (const n of names) assert.match(n, /^(?:fcv2|FCV2)[A-Za-z0-9_]*_$/, n);
  const topLevel = src.split('\n').filter((l) => /^\S/.test(l) && !/^(?:function|const|\}|\/\/|\/\*\*)/.test(l));
  assert.deepEqual(topLevel, [], 'no top-level statements other than function and const declarations');
});
