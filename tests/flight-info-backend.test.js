// fc.roster v2 `flight` action (backend, Apps Script sources in a sandbox): request validation,
// canonical flight-number normalization, provider URL, matching (origin-local date), wire shape,
// status mapping, retry / error mapping, cache (key, TTL, strict validation), capabilities,
// secrecy, partial deploys and load order. The provider is always a fake; no network.
// Fixture: tests/fixtures/adb-flight.synthetic.json (synthetic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { loadGs, fakeEnv, GS_FILES } from './gs-harness.js';

const gs = loadGs();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/adb-flight.synthetic.json', import.meta.url), 'utf8'));
const CASES = fixture.cases;
const TOKEN = 'test-token-0123456789abcdef';
const KEY = 'SYNTHETIC-PROVIDER-KEY-0042';
const NOW = Date.parse(fixture.now);                  // 2026-10-06 10:00 in FRA (origin-local today 2026-10-06)
const T = (s) => Date.parse(s);
const H = 3600000;
const plain = (x) => JSON.parse(JSON.stringify(x));
const clone = plain;
const ok = (body) => ({ status: 200, body: JSON.stringify(body) });
const REQ = { flightNumber: 'DE1234', date: '2026-10-06', origin: 'FRA' };
const URL_BASE = 'https://aerodatabox.p.rapidapi.com/flights/number/';
const URL_QUERY = '?withAircraftImage=false&withLocation=false';
const idOf = (number, date, origin) => 'g_' + createHash('sha256').update(`${number}|${date}|${origin}`).digest('hex').slice(0, 16);

function setup(options = {}) {
  const f = fakeEnv(gs, { now: NOW, departuresKey: KEY, providerFetch: () => ok(CASES.bothGates), ...options });
  const post = (body, token = TOKEN) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'flight', token, ...body }), f.env));
  const direct = (body, now = NOW) => plain(gs.fcv2HandleFlight_({ action: 'flight', ...body }, f.env, now));
  return { ...f, post, direct };
}
const refuse = () => { throw new Error('provider must not be called'); };

// A single bothGates-shaped provider entry that tests can alter.
const entry = (patch = {}) => ({ ...clone(CASES.bothGates[0]), ...patch });
const withDeparture = (patch) => { const e = entry(); e.departure = { ...e.departure, ...patch }; return [e]; };
const withArrival = (patch) => { const e = entry(); e.arrival = { ...e.arrival, ...patch }; return [e]; };

const EXPECTED_BOTH = {
  id: idOf('DE1234', '2026-10-06', 'FRA'),
  flightNumber: 'DE1234',
  status: 'delayed',
  lastUpdated: T('2026-10-06T07:55:00Z'),
  departure: {
    airport: 'FRA', scheduled: T('2026-10-06T08:30:00Z'), revised: T('2026-10-06T08:50:00Z'), runway: null,
    terminal: '1', gate: 'A 24', desk: '101-110', belt: null, quality: ['basic', 'live'],
  },
  arrival: {
    airport: 'PMI', scheduled: T('2026-10-06T11:00:00Z'), revised: T('2026-10-06T11:20:00Z'), runway: null,
    terminal: 'B', gate: '12', desk: null, belt: '4', quality: ['basic', 'live'],
  },
  provenance: 'provider',
};

// --- Request validation -------------------------------------------------------------

test('validation: every error code, and no provider call or sleep for any refused request', () => {
  const s = setup({ providerFetch: refuse });
  const cases = [
    [{ date: REQ.date, origin: 'FRA' }, 'bad-request'],                                  // missing number
    [{ flightNumber: 'DE1234', origin: 'FRA' }, 'bad-request'],                          // missing date
    [{ flightNumber: 'DE1234', date: REQ.date }, 'bad-request'],                         // missing origin
    [{}, 'bad-request'],
    [{ ...REQ, flightNumber: 1234 }, 'bad-request'],
    [{ ...REQ, flightNumber: null }, 'bad-request'],
    [{ ...REQ, date: 20261006 }, 'bad-request'],
    [{ ...REQ, date: null }, 'bad-request'],
    [{ ...REQ, origin: 7 }, 'bad-request'],
    [{ ...REQ, origin: ['FRA'] }, 'bad-request'],
    [{ ...REQ, flightNumber: '' }, 'bad-request'],
    [{ ...REQ, flightNumber: '   ' }, 'bad-request'],
    [{ ...REQ, flightNumber: 'DE' }, 'bad-request'],
    [{ ...REQ, flightNumber: 'DE12345' }, 'bad-request'],     // five digits that are not leading zeros
    [{ ...REQ, flightNumber: 'DE-1234' }, 'bad-request'],
    [{ ...REQ, flightNumber: 'DE1234AB' }, 'bad-request'],
    [{ ...REQ, flightNumber: 'DEU1234' }, 'bad-request'],
    [{ ...REQ, flightNumber: 'ß1234' }, 'bad-request'],       // not ASCII (an upper-casing "SS" must not sneak in)
    [{ ...REQ, flightNumber: 'DE' + '0'.repeat(40) + '1' }, 'bad-request'],
    [{ ...REQ, date: '2026-10-6' }, 'bad-request'],
    [{ ...REQ, date: '06.10.2026' }, 'bad-request'],
    [{ ...REQ, date: '2026-13-01' }, 'bad-request'],
    [{ ...REQ, date: '2026-00-10' }, 'bad-request'],
    [{ ...REQ, date: '2026-02-30' }, 'bad-request'],          // Feb 30 is not a date (and not rolled over to Mar 2)
    [{ ...REQ, date: '2026-02-29' }, 'bad-request'],          // 2026 is no leap year
    [{ ...REQ, date: '2026-10-06T00:00' }, 'bad-request'],
    [{ ...REQ, origin: 'XXX' }, 'unknown-airport'],
    [{ ...REQ, origin: 'fra' }, 'unknown-airport'],
    [{ ...REQ, origin: 'FRAA' }, 'unknown-airport'],
    [{ ...REQ, origin: '' }, 'unknown-airport'],
    [{ ...REQ, date: '2026-10-04' }, 'range-out-of-bounds'],  // today - 2 days
    [{ ...REQ, date: '2026-10-14' }, 'range-out-of-bounds'],  // today + 8 days
    [{ ...REQ, date: '2020-01-01' }, 'range-out-of-bounds'],
    [{ ...REQ, date: '2099-12-31' }, 'range-out-of-bounds'],
  ];
  for (const [body, error] of cases) {
    assert.deepEqual(s.post(body), { ok: false, error }, JSON.stringify(body));
  }
  assert.equal(Object.hasOwn(gs.FCV2_AIRPORT_TZ_, 'XXX'), false, 'XXX stays outside the zone table for this test');
  assert.equal(s.calls.provider.length, 0);
  assert.equal(s.calls.sleeps.length, 0);
  assert.equal(s.calls.cachePuts.length, 0);
});

test('validation: the window is origin-local today -1 .. +7 days, inclusive on both sides', () => {
  const s = setup({ providerFetch: () => ok([]) });
  assert.equal(s.post({ ...REQ, date: '2026-10-05' }).ok, true, 'today - 1 day');
  assert.equal(s.post({ ...REQ, date: '2026-10-13' }).ok, true, 'today + 7 days');
  assert.equal(s.post({ ...REQ, date: '2026-10-04' }).error, 'range-out-of-bounds');
  assert.equal(s.post({ ...REQ, date: '2026-10-14' }).error, 'range-out-of-bounds');
});

test('validation: "today" is the ORIGIN airport\'s local date, not the UTC date', () => {
  // 2026-10-06 23:30Z: FRA already is on 2026-10-07 (UTC+2), so its window is 10-06 .. 10-14.
  const lateUtc = Date.parse('2026-10-06T23:30:00Z');
  const s = setup({ now: lateUtc, providerFetch: () => ok([]) });
  assert.equal(s.post({ ...REQ, date: '2026-10-14' }).ok, true);
  assert.equal(s.post({ ...REQ, date: '2026-10-06' }).ok, true);
  assert.equal(s.post({ ...REQ, date: '2026-10-05' }).error, 'range-out-of-bounds');
  assert.equal(s.post({ ...REQ, date: '2026-10-15' }).error, 'range-out-of-bounds');
  // 2026-10-06 02:00Z: JFK is still on 2026-10-05 (UTC-4), so its window is 10-04 .. 10-12.
  const earlyUtc = Date.parse('2026-10-06T02:00:00Z');
  const j = setup({ now: earlyUtc, providerFetch: () => ok([]) });
  assert.equal(j.post({ ...REQ, origin: 'JFK', date: '2026-10-12' }).ok, true);
  assert.equal(j.post({ ...REQ, origin: 'JFK', date: '2026-10-04' }).ok, true);
  assert.equal(j.post({ ...REQ, origin: 'JFK', date: '2026-10-13' }).error, 'range-out-of-bounds');
  assert.equal(j.post({ ...REQ, origin: 'JFK', date: '2026-10-03' }).error, 'range-out-of-bounds');
});

test('flight-not-configured: no key, empty key and an env without the function; valid requests only', () => {
  for (const departuresKey of [null, '']) {
    const s = setup({ departuresKey, providerFetch: refuse });
    assert.deepEqual(s.post(REQ), { ok: false, error: 'flight-not-configured' });
    assert.equal(s.post({ ...REQ, origin: 'XXX' }).error, 'unknown-airport', 'a bad request is still reported as such');
    assert.equal(s.post({ ...REQ, flightNumber: 'x' }).error, 'bad-request');
    assert.equal(s.calls.provider.length, 0);
  }
  const s = setup({ providerFetch: refuse });
  delete s.env.departuresKey;
  assert.equal(s.direct(REQ).error, 'flight-not-configured');
});

test('auth: a wrong token never reaches the provider, and the action needs the v2 contract', () => {
  const s = setup({ providerFetch: refuse });
  assert.equal(s.post(REQ, 'wrong').error, 'unauthorized');
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 3, action: 'flight', token: TOKEN, ...REQ }), s.env)).error, 'unsupported-contract');
  assert.equal(s.calls.provider.length, 0);
});

// --- Normalization ------------------------------------------------------------------

test('canonical flight numbers: whitespace, case and leading zeros', () => {
  const table = [
    ['DE1234', 'DE1234'], ['DE 1234', 'DE1234'], ['de1234', 'DE1234'], [' d e 1 2 3 4 ', 'DE1234'], ['DE\t1234', 'DE1234'],
    ['DE 2016', 'DE2016'], ['de2016', 'DE2016'], ['DE02016', 'DE2016'], ['DE 0016', 'DE16'], ['DE0016', 'DE16'],
    ['DE0', 'DE0'], ['DE0000', 'DE0'], ['DE7', 'DE7'],
    ['DE1234A', 'DE1234A'], ['de1234a', 'DE1234A'], ['DE 0123 b', 'DE123B'],
    ['3K12', '3K12'], ['D1234', 'D1234'], ['4Y 0007', '4Y7'],
  ];
  for (const [input, canonical] of table) assert.equal(gs.fcv2FlightCanonical_(input), canonical, JSON.stringify(input));
  for (const bad of ['', 'DE', 'D', '12', 'DE12345', 'DE-12', 'DE1234AB', 'DE12A4', 'ÄÖ1234', 'ß1234', 'DE 1234.', null, undefined, 1234, {}, ['DE1234']]) {
    assert.equal(gs.fcv2FlightCanonical_(bad), null, JSON.stringify(bad));
  }
});

test('normalization: "DE 2016", "de2016" and "DE02016" ask the provider for the same path and share one cache key', () => {
  const keys = new Set();
  const urls = new Set();
  for (const flightNumber of ['DE 2016', 'de2016', 'DE02016', '  DE2016  ']) {
    const s = setup({ providerFetch: () => ok(CASES.overnight) });
    const res = s.post({ flightNumber, date: '2026-10-07', origin: 'FRA' });
    assert.equal(res.ok, true, flightNumber);
    assert.deepEqual(res.query, { flightNumber: 'DE2016', date: '2026-10-07', origin: 'FRA' });
    assert.equal(res.found, true);
    assert.equal(res.flight.flightNumber, 'DE2016');
    assert.equal(s.calls.provider.length, 1);
    urls.add(s.calls.provider[0][0]);
    keys.add(s.calls.cachePuts[0][0]);
  }
  assert.deepEqual([...urls], [`${URL_BASE}DE2016/2026-10-07${URL_QUERY}`]);
  assert.deepEqual([...keys], ['fcv2-flt-DE2016-2026-10-07-FRA']);
  // One setup, three spellings: the first call fetches, the others are served from the cache.
  const s = setup({ providerFetch: () => ok(CASES.overnight) });
  const bodies = ['DE 2016', 'de2016', 'DE02016'].map((flightNumber) => s.post({ flightNumber, date: '2026-10-07', origin: 'FRA' }));
  assert.equal(s.calls.provider.length, 1, 'spellings share the cache entry');
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);
});

test('provider URL: canonical number, the date as given, fixed query, no key in it', () => {
  const s = setup({ providerFetch: () => ok([]) });
  s.post({ flightNumber: 'de 0016', date: '2026-10-07', origin: 'FRA' });
  s.post({ flightNumber: 'DE1234a', date: '2026-10-05', origin: 'PMI' });
  assert.equal(s.calls.provider[0][0], `${URL_BASE}DE16/2026-10-07${URL_QUERY}`);
  assert.equal(s.calls.provider[1][0], `${URL_BASE}DE1234A/2026-10-05${URL_QUERY}`);
  for (const [url, key] of s.calls.provider) {
    assert.equal(key, KEY, 'the provider call carries the departures key');
    assert.ok(!url.includes(KEY));
  }
  assert.equal(gs.fcv2FlightUrl_('DE16', '2026-10-07'), `${URL_BASE}DE16/2026-10-07${URL_QUERY}`);
});

// --- Wire shape -----------------------------------------------------------------------

test('wire: both gates, terminals, desk and belt; times from utc; quality and lastUpdated preserved; codeshare entry ignored', () => {
  const s = setup();
  const res = s.post(REQ);
  assert.deepEqual(res, {
    ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'aerodatabox',
    generatedAt: NOW, fetchedAt: NOW,
    query: { flightNumber: 'DE1234', date: '2026-10-06', origin: 'FRA' },
    found: true, flight: EXPECTED_BOTH,
    attribution: { name: 'AeroDataBox', url: 'https://aerodatabox.com/' },
  });
  assert.deepEqual(Object.keys(res), ['ok', 'contract', 'version', 'action', 'provider', 'generatedAt', 'fetchedAt', 'query', 'found', 'flight', 'attribution']);
  assert.deepEqual(Object.keys(res.flight), ['id', 'flightNumber', 'status', 'lastUpdated', 'departure', 'arrival', 'provenance']);
  assert.deepEqual(Object.keys(res.flight.departure), ['airport', 'scheduled', 'revised', 'runway', 'terminal', 'gate', 'desk', 'belt', 'quality']);
  assert.deepEqual(Object.keys(res.flight.arrival), Object.keys(res.flight.departure));
  assert.ok(!JSON.stringify(res).includes('Z 99'), 'the codeshare listing LH 7777 is not this flight');
});

test('wire: departure gate only -> arrival gate/terminal/belt stay null (never copied or invented)', () => {
  const s = setup({ providerFetch: () => ok(CASES.departureGateOnly) });
  const res = s.post({ flightNumber: 'DE 1300', date: '2026-10-06', origin: 'FRA' });
  assert.equal(res.found, true);
  assert.equal(res.flight.status, 'boarding');
  assert.deepEqual(res.flight.departure, { airport: 'FRA', scheduled: T('2026-10-06T09:00:00Z'), revised: null, runway: null, terminal: null, gate: 'B 7', desk: null, belt: null, quality: ['live'] });
  assert.deepEqual(res.flight.arrival, { airport: 'HER', scheduled: T('2026-10-06T12:45:00Z'), revised: null, runway: null, terminal: null, gate: null, desk: null, belt: null, quality: ['basic'] });
});

test('wire: no gates at all -> every gate/terminal/desk/belt is null and the quality says basic', () => {
  const s = setup({ providerFetch: () => ok(CASES.noGates) });
  const res = s.post({ flightNumber: 'DE1400', date: '2026-10-06', origin: 'FRA' });
  assert.equal(res.found, true);
  assert.equal(res.flight.status, 'scheduled');
  for (const leg of [res.flight.departure, res.flight.arrival]) {
    assert.deepEqual([leg.terminal, leg.gate, leg.desk, leg.belt, leg.revised, leg.runway], [null, null, null, null, null, null]);
    assert.deepEqual(leg.quality, ['basic']);
  }
  assert.equal(res.flight.lastUpdated, T('2026-10-06T06:00:00Z'));
});

test('wire: "Live" vs "Basic" quality is preserved per leg, unique and in the fixed order; unknown flags are dropped', () => {
  const run = (quality) => {
    const s = setup({ providerFetch: () => ok(withDeparture({ quality })) });
    return s.post(REQ).flight.departure.quality;
  };
  assert.deepEqual(run(['Basic']), ['basic']);
  assert.deepEqual(run(['Live']), ['live']);
  assert.deepEqual(run(['Live', 'Basic']), ['basic', 'live']);
  assert.deepEqual(run(['Approximate', 'Live', 'Basic', 'live', 'BASIC', 'Bogus', 7, null]), ['basic', 'live', 'approximate']);
  assert.deepEqual(run([]), []);
  assert.deepEqual(run(undefined), []);
  assert.deepEqual(run('Live'), []);
  // Per leg: departure live, arrival basic.
  const s = setup({ providerFetch: () => ok(CASES.departureGateOnly) });
  const f = s.post({ flightNumber: 'DE1300', date: '2026-10-06', origin: 'FRA' }).flight;
  assert.deepEqual([f.departure.quality, f.arrival.quality], [['live'], ['basic']]);
});

test('wire: lastUpdated is the provider timestamp (ms), null when absent or unparseable; times unparseable -> null', () => {
  const lu = (v) => { const e = entry(); if (v === undefined) delete e.lastUpdatedUtc; else e.lastUpdatedUtc = v; return setup({ providerFetch: () => ok([e]) }).post(REQ).flight.lastUpdated; };
  assert.equal(lu('2026-10-06 07:55Z'), T('2026-10-06T07:55:00Z'));
  assert.equal(lu(undefined), null);
  assert.equal(lu(''), null);
  assert.equal(lu('yesterday'), null);
  assert.equal(lu('2026-02-30 07:55Z'), null);
  assert.equal(lu(1790000000000), null);
  const e = entry();
  e.departure.revisedTime = { utc: 'garbage', local: '2026-10-06 10:50+02:00' };
  e.departure.runwayTime = { utc: '2026-10-06 08:41Z' };
  e.arrival.scheduledTime = undefined;
  e.arrival.runwayTime = 'x';
  const f = setup({ providerFetch: () => ok([e]) }).post(REQ).flight;
  assert.equal(f.departure.revised, null, 'no time from the local string');
  assert.equal(f.departure.runway, T('2026-10-06T08:41:00Z'));
  assert.equal(f.arrival.scheduled, null);
  assert.equal(f.arrival.runway, null);
});

test('wire: gate/terminal/desk/belt text is trimmed and collapsed, restricted to 1..16 safe characters, otherwise null', () => {
  const text = (v) => gs.fcv2FlightText_(v);
  assert.equal(text('  B   7 '), 'B 7');
  assert.equal(text('A24'), 'A24');
  assert.equal(text('101-110'), '101-110');
  assert.equal(text('Z+1, 2.3/4'), 'Z+1, 2.3/4');
  assert.equal(text('1234567890123456'), '1234567890123456');
  for (const bad of ['', '   ', '12345678901234567', '<b>', '-A', ' .A', 'A;B', 'Aä', 'A"B', 12, null, undefined, {}, ['A']]) assert.equal(text(bad), null, JSON.stringify(bad));
  const e = entry();
  e.departure.gate = '<script>';
  e.departure.terminal = 2;
  e.departure.checkInDesk = ' 5 ';
  e.arrival.baggageBelt = 'x'.repeat(17);
  e.arrival.terminal = 'T 2';
  const f = setup({ providerFetch: () => ok([e]) }).post(REQ).flight;
  assert.deepEqual([f.departure.gate, f.departure.terminal, f.departure.desk, f.arrival.belt, f.arrival.terminal], [null, null, '5', null, 'T 2']);
});

test('wire: departure.belt is always null and arrival.desk is always null, even if the provider sends them', () => {
  const e = entry();
  e.departure.baggageBelt = '9';
  e.arrival.checkInDesk = '88';
  const f = setup({ providerFetch: () => ok([e]) }).post(REQ).flight;
  assert.equal(f.departure.belt, null);
  assert.equal(f.arrival.desk, null);
  assert.equal(f.departure.desk, '101-110');
  assert.equal(f.arrival.belt, '4');
});

test('wire: id is g_ + 16 hex of sha256(canonical|date|origin)', () => {
  const f = setup().post(REQ).flight;
  assert.match(f.id, /^g_[0-9a-f]{16}$/);
  assert.equal(f.id, idOf('DE1234', '2026-10-06', 'FRA'));
  const other = setup({ providerFetch: () => ok(CASES.noGates) }).post({ flightNumber: 'de 1400', date: '2026-10-06', origin: 'FRA' }).flight;
  assert.equal(other.id, idOf('DE1400', '2026-10-06', 'FRA'));
  assert.notEqual(other.id, f.id);
});

test('status mapping table (case-insensitive, spaces removed); everything else is unknown', () => {
  const table = {
    Expected: 'scheduled', CheckIn: 'scheduled', 'Check In': 'scheduled', Scheduled: 'scheduled', scheduled: 'scheduled',
    Delayed: 'delayed', DELAYED: 'delayed',
    Boarding: 'boarding', GateClosed: 'boarding', 'Gate Closed': 'boarding', boarding: 'boarding',
    Departed: 'departed', EnRoute: 'departed', 'En Route': 'departed', Approaching: 'departed',
    Arrived: 'arrived', arrived: 'arrived',
    Diverted: 'diverted',
    Canceled: 'cancelled', Cancelled: 'cancelled', CanceledUncertain: 'cancelled', 'canceled uncertain': 'cancelled',
    Unknown: 'unknown', '': 'unknown', Landed: 'unknown', Whatever: 'unknown', constructor: 'unknown', toString: 'unknown',
  };
  for (const [provider, wire] of Object.entries(table)) assert.equal(gs.fcv2FlightStatus_(provider), wire, provider);
  assert.equal(gs.fcv2FlightStatus_('__proto__'), 'unknown');
  for (const bad of [null, undefined, 3, {}, ['Arrived']]) assert.equal(gs.fcv2FlightStatus_(bad), 'unknown');
  // End to end for one value per wire status (and a missing status).
  for (const [provider, wire] of [['Expected', 'scheduled'], ['Delayed', 'delayed'], ['GateClosed', 'boarding'], ['EnRoute', 'departed'], ['Arrived', 'arrived'], ['Diverted', 'diverted'], ['CanceledUncertain', 'cancelled'], ['Nope', 'unknown'], [undefined, 'unknown']]) {
    const e = entry({ status: provider });
    assert.equal(setup({ providerFetch: () => ok([e]) }).post(REQ).flight.status, wire, String(provider));
  }
  assert.deepEqual([...new Set(Object.values(gs.FCV2_FLT_STATUS_))].sort(), ['arrived', 'boarding', 'cancelled', 'delayed', 'departed', 'diverted', 'scheduled']);
});

// --- Matching -------------------------------------------------------------------------

test('overnight: the origin-local departure date decides, not the UTC date', () => {
  // DE 2016 leaves FRA at 2026-10-07 00:40 local = 2026-10-06 22:40Z.
  const s = setup({ providerFetch: () => ok(CASES.overnight) });
  const local = s.post({ flightNumber: 'DE 2016', date: '2026-10-07', origin: 'FRA' });
  assert.equal(local.found, true);
  assert.equal(local.flight.departure.scheduled, T('2026-10-06T22:40:00Z'));
  assert.equal(local.flight.departure.gate, 'C 3');
  assert.equal(local.flight.id, idOf('DE2016', '2026-10-07', 'FRA'));
  const utcDay = setup({ providerFetch: () => ok(CASES.overnight) }).post({ flightNumber: 'DE 2016', date: '2026-10-06', origin: 'FRA' });
  assert.equal(utcDay.ok, true);
  assert.equal(utcDay.found, false, 'the UTC date of the same flight does not match');
  assert.equal(utcDay.flight, null);
});

test('multi-leg day: the leg that departs from the requested origin is picked', () => {
  const asked = (origin) => {
    const s = setup({ providerFetch: () => ok(CASES.multiLeg) });
    return s.post({ flightNumber: 'DE5500', date: '2026-10-06', origin });
  };
  const fra = asked('FRA');
  assert.equal(fra.found, true);
  assert.deepEqual([fra.flight.departure.airport, fra.flight.arrival.airport, fra.flight.departure.gate, fra.flight.status], ['FRA', 'HER', 'D 41', 'scheduled']);
  assert.deepEqual(fra.flight.departure.quality, ['basic', 'live', 'approximate']);
  assert.equal(fra.flight.lastUpdated, T('2026-10-06T07:20:00Z'));
  const pmi = asked('PMI');
  assert.equal(pmi.found, true);
  assert.deepEqual([pmi.flight.departure.airport, pmi.flight.arrival.airport, pmi.flight.departure.gate, pmi.flight.status], ['PMI', 'FRA', 'P 1', 'arrived']);
  assert.equal(pmi.flight.id, idOf('DE5500', '2026-10-06', 'PMI'));
  const her = asked('HER');
  assert.equal(her.found, false, 'HER is only a destination of this number');
  assert.equal(her.flight, null);
});

test('two matching legs (same number, origin and local date) -> flight-ambiguous, never a guess, never cached', () => {
  const list = [...clone(CASES.multiLeg), clone(CASES.multiLeg[1])];
  list[2].departure.gate = 'E 5';
  const s = setup({ providerFetch: () => ok(list) });
  assert.deepEqual(s.post({ flightNumber: 'DE5500', date: '2026-10-06', origin: 'FRA' }), { ok: false, error: 'flight-ambiguous' });
  assert.equal(s.calls.cachePuts.length, 0);
  assert.equal(s.cache.size, 0);
  // The other origin of the same response is still unambiguous.
  assert.equal(s.post({ flightNumber: 'DE5500', date: '2026-10-06', origin: 'PMI' }).found, true);
});

test('matching ignores other numbers, other origins, other local dates and malformed entries', () => {
  const good = entry();
  const otherNumber = entry({ number: 'DE 1235' });
  const noNumber = entry(); delete noNumber.number;
  const otherDate = entry(); otherDate.departure.scheduledTime = { utc: '2026-10-07 08:30Z', local: '2026-10-07 10:30+02:00' };
  const noLocal = entry(); noLocal.departure.scheduledTime = { utc: '2026-10-06 08:30Z' };
  const noAirport = entry(); delete noAirport.departure.airport;
  const otherOrigin = entry(); otherOrigin.departure.airport = { iata: 'MUC' };
  const noDeparture = entry(); delete noDeparture.departure;
  const junk = [null, 7, 'x', [], {}];
  const noise = [otherNumber, noNumber, otherDate, noLocal, noAirport, otherOrigin, noDeparture, ...junk];
  const s = setup({ providerFetch: () => ok([...noise, good]) });
  const res = s.post(REQ);
  assert.equal(res.found, true);
  assert.deepEqual(res.flight, EXPECTED_BOTH);
  const none = setup({ providerFetch: () => ok(noise) }).post(REQ);
  assert.equal(none.ok, true);
  assert.equal(none.found, false);
  assert.equal(none.flight, null);
  // A differently spelled provider number of the same flight matches ("DE 01234" -> DE1234).
  const spelled = setup({ providerFetch: () => ok([entry({ number: 'de 01234' })]) }).post(REQ);
  assert.equal(spelled.found, true);
  assert.equal(spelled.flight.flightNumber, 'DE1234');
});

// --- Provider outcomes -----------------------------------------------------------------

test('not found: 204, 404, empty 200 body and [] answer ok with found:false, flight:null (and are cached like a result)', () => {
  const variants = [
    { status: 204, body: '' },
    { status: 404, body: '' },
    { status: 404, body: '{"message":"Not Found"}' },
    { status: 200, body: '' },
    { status: 200, body: '  \n' },
    { status: 200, body: '[]' },
  ];
  for (const reply of variants) {
    const s = setup({ providerFetch: () => reply });
    const res = s.post(REQ);
    assert.deepEqual(res, {
      ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'aerodatabox', generatedAt: NOW, fetchedAt: NOW,
      query: { flightNumber: 'DE1234', date: '2026-10-06', origin: 'FRA' }, found: false, flight: null,
      attribution: { name: 'AeroDataBox', url: 'https://aerodatabox.com/' },
    }, JSON.stringify(reply));
    assert.equal(s.calls.sleeps.length, 0);
    assert.equal(s.calls.cachePuts.length, 1);
    assert.deepEqual(plain(s.cache.get('fcv2-flt-DE1234-2026-10-06-FRA')), { fetchedAt: NOW, found: false, flight: null });
    s.post(REQ);
    assert.equal(s.calls.provider.length, 1, 'the negative answer is served from the cache');
  }
});

test('429 then 200 succeeds after one wait of 1200 ms; 429 three times is provider-rate-limited (1200, 2500)', () => {
  const s = setup({ providerFetch: (_u, _k, n) => (n === 1 ? { status: 429, body: '' } : ok(CASES.bothGates)) });
  const res = s.post(REQ);
  assert.equal(res.ok, true);
  assert.deepEqual(res.flight, EXPECTED_BOTH);
  assert.deepEqual(s.calls.sleeps, [1200]);
  assert.equal(s.calls.provider.length, 2);
  const t = setup({ providerFetch: (_u, _k, n) => (n <= 2 ? { status: 429, body: '' } : ok(CASES.bothGates)) });
  assert.equal(t.post(REQ).ok, true);
  assert.deepEqual(t.calls.sleeps, [1200, 2500]);
  const u = setup({ providerFetch: () => ({ status: 429, body: 'quota' }) });
  assert.deepEqual(u.post(REQ), { ok: false, error: 'provider-rate-limited' });
  assert.deepEqual(u.calls.sleeps, [1200, 2500]);
  assert.equal(u.calls.provider.length, 3);
  assert.equal(u.calls.cachePuts.length, 0, 'errors are never cached');
  assert.equal(u.cache.size, 0);
});

test('401 and 403 are provider-auth-failed (no retry); other statuses, garbage and non-arrays are provider-unavailable', () => {
  const run = (reply) => { const s = setup({ providerFetch: typeof reply === 'function' ? reply : () => reply }); const res = s.post(REQ); assert.equal(s.calls.sleeps.length, 0); assert.equal(s.cache.size, 0); return res; };
  assert.deepEqual(run({ status: 401, body: 'nope' }), { ok: false, error: 'provider-auth-failed' });
  assert.deepEqual(run({ status: 403, body: '' }), { ok: false, error: 'provider-auth-failed' });
  for (const reply of [
    { status: 500, body: 'oops' }, { status: 502, body: '' }, { status: 400, body: '{}' }, { status: 301, body: '' },
    { status: 200, body: '<html>maintenance</html>' }, { status: 200, body: '{"flights":[]}' }, { status: 200, body: '{}' },
    { status: 200, body: 'null' }, { status: 200, body: '"text"' }, { status: 200, body: '42' }, { status: 200, body: '[1,' },
    { status: 200, body: undefined }, { status: 200 }, { status: 200, body: 7 },
    null, undefined, 'string',
  ]) {
    assert.deepEqual(run(reply), { ok: false, error: 'provider-unavailable' }, JSON.stringify(reply));
  }
  assert.deepEqual(run(() => { throw new Error('network down ' + KEY); }), { ok: false, error: 'provider-unavailable' });
});

test('an error is not cached: the next request fetches again and succeeds', () => {
  const s = setup({ providerFetch: (_u, _k, n) => (n === 1 ? { status: 500, body: '' } : ok(CASES.bothGates)) });
  assert.equal(s.post(REQ).error, 'provider-unavailable');
  assert.equal(s.post(REQ).found, true);
  assert.equal(s.calls.provider.length, 2);
});

// --- Cache ----------------------------------------------------------------------------

test('cache: a second request is served from the cache (one provider call), keeping the original fetchedAt', () => {
  const s = setup();
  const first = s.post(REQ);
  const second = s.direct(REQ, NOW + 60000);
  assert.equal(s.calls.provider.length, 1);
  assert.equal(second.fetchedAt, NOW);
  assert.equal(second.generatedAt, NOW + 60000);
  assert.deepEqual({ ...second, generatedAt: first.generatedAt }, first);
  assert.deepEqual(s.calls.cachePuts, [['fcv2-flt-DE1234-2026-10-06-FRA', 300]]);
  // A different date, number or origin is a different entry.
  s.post({ ...REQ, date: '2026-10-07' });
  s.post({ ...REQ, flightNumber: 'DE1235' });
  s.post({ ...REQ, origin: 'PMI' });
  assert.equal(s.calls.provider.length, 4);
  assert.deepEqual(s.calls.cachePuts.map((p) => p[0]), ['fcv2-flt-DE1234-2026-10-06-FRA', 'fcv2-flt-DE1234-2026-10-07-FRA', 'fcv2-flt-DE1235-2026-10-06-FRA', 'fcv2-flt-DE1234-2026-10-06-PMI']);
});

test('cache: a corrupted or foreign entry is ignored and refetched (and replaced)', () => {
  const key = 'fcv2-flt-DE1234-2026-10-06-FRA';
  const good = { fetchedAt: NOW - 1000, found: true, flight: clone(EXPECTED_BOTH) };
  const mutate = (fn) => { const v = clone(good); fn(v); return v; };
  const corrupt = [
    'garbage', 42, [], {}, { fetchedAt: NOW },
    { fetchedAt: NOW, found: false },
    { fetchedAt: NOW, found: false, flight: clone(EXPECTED_BOTH) },
    { fetchedAt: NOW, found: true, flight: null },
    { found: true, flight: clone(EXPECTED_BOTH) },
    mutate((v) => { v.fetchedAt = 'now'; }),
    mutate((v) => { v.extra = 1; }),
    mutate((v) => { v.flight.extra = 1; }),
    mutate((v) => { delete v.flight.lastUpdated; }),
    mutate((v) => { v.flight.id = 'g_0000000000000000'; }),
    mutate((v) => { v.flight.id = idOf('DE1234', '2026-10-07', 'FRA'); }),
    mutate((v) => { v.flight.flightNumber = 'DE1235'; }),
    mutate((v) => { v.flight.status = 'landed'; }),
    mutate((v) => { v.flight.status = 'Delayed'; }),
    mutate((v) => { v.flight.provenance = 'roster'; }),
    mutate((v) => { v.flight.lastUpdated = '2026-10-06 07:55Z'; }),
    mutate((v) => { v.flight.departure.airport = 'MUC'; }),
    mutate((v) => { v.flight.departure.gate = 12; }),
    mutate((v) => { v.flight.departure.gate = 'A  24'; }),
    mutate((v) => { v.flight.departure.gate = '<b>'; }),
    mutate((v) => { v.flight.departure.belt = '1'; }),
    mutate((v) => { v.flight.arrival.desk = '1'; }),
    mutate((v) => { v.flight.departure.scheduled = 1.5; }),
    mutate((v) => { v.flight.departure.quality = ['live', 'basic']; }),
    mutate((v) => { v.flight.departure.quality = ['basic', 'basic']; }),
    mutate((v) => { v.flight.departure.quality = ['Basic']; }),
    mutate((v) => { v.flight.arrival.quality = 'basic'; }),
    mutate((v) => { delete v.flight.arrival.runway; }),
    mutate((v) => { v.flight.arrival.extra = null; }),
    mutate((v) => { v.flight.departure = null; }),
  ];
  corrupt.forEach((value, i) => {
    const s = setup();
    s.cache.set(key, value);
    const res = s.post(REQ);
    assert.equal(s.calls.provider.length, 1, `corrupt #${i} is refetched`);
    assert.deepEqual(res.flight, EXPECTED_BOTH, `corrupt #${i}`);
    assert.deepEqual(plain(s.cache.get(key)), { fetchedAt: NOW, found: true, flight: EXPECTED_BOTH }, `corrupt #${i} is replaced`);
  });
  // The well-formed entry is trusted as is (control).
  const s = setup({ providerFetch: refuse });
  s.cache.set(key, good);
  const res = s.post(REQ);
  assert.equal(res.fetchedAt, NOW - 1000);
  assert.deepEqual(res.flight, EXPECTED_BOTH);
});

test('cache: a cache that throws never fails the request', () => {
  const s = setup();
  s.env.cacheGet = () => { throw new Error('cache read failed'); };
  s.env.cachePut = () => { throw new Error('cache write failed'); };
  assert.deepEqual(s.post(REQ).flight, EXPECTED_BOTH);
  assert.equal(s.calls.provider.length, 1);
});

test('gate change: a cached gate is kept until the entry is gone; then the new provider gate is shown', () => {
  let gate = 'A 24';
  const s = setup({ providerFetch: () => ok(withDeparture({ gate })) });
  assert.equal(s.post(REQ).flight.departure.gate, 'A 24');
  gate = 'A 25';
  assert.equal(s.post(REQ).flight.departure.gate, 'A 24', 'cached for the TTL');
  s.cache.clear();   // the TTL expired
  const fresh = s.direct(REQ, NOW + 301000);
  assert.equal(fresh.flight.departure.gate, 'A 25');
  assert.equal(fresh.fetchedAt, NOW + 301000);
  assert.equal(s.calls.provider.length, 2);
  // A gate the provider drops is null afterwards, not the old one.
  gate = undefined;
  s.cache.clear();
  assert.equal(s.post(REQ).flight.departure.gate, null);
});

test('cache TTL: 300 s when the departure is within 24 h of now, else 1800 s (also for found:false, from the local noon of the date)', () => {
  const ttlOf = (s) => s.calls.cachePuts.at(-1)[1];
  const at = (utc, local) => ok(withDeparture({ scheduledTime: { utc, local } }));
  // Found: 08:30Z is 30 min after now.
  const near = setup(); near.post(REQ);
  assert.equal(ttlOf(near), 300);
  // Exactly 24 h ahead: still near; one minute more: far.
  const edge = setup({ providerFetch: () => at('2026-10-07 08:00Z', '2026-10-07 10:00+02:00') });
  edge.post({ ...REQ, date: '2026-10-07' });
  assert.equal(ttlOf(edge), 300);
  const beyond = setup({ providerFetch: () => at('2026-10-07 08:01Z', '2026-10-07 10:01+02:00') });
  beyond.post({ ...REQ, date: '2026-10-07' });
  assert.equal(ttlOf(beyond), 1800);
  const far = setup({ providerFetch: () => at('2026-10-12 10:00Z', '2026-10-12 12:00+02:00') });
  far.post({ ...REQ, date: '2026-10-12' });
  assert.equal(ttlOf(far), 1800);
  // A departure that left yesterday (within 24 h in the past) is near too.
  const past = setup({ providerFetch: () => at('2026-10-05 12:00Z', '2026-10-05 14:00+02:00') });
  past.post({ ...REQ, date: '2026-10-05' });
  assert.equal(ttlOf(past), 300);
  // Not found: local noon of the date (10:00Z in FRA in October).
  const missToday = setup({ providerFetch: () => ok([]) }); missToday.post(REQ);
  assert.equal(ttlOf(missToday), 300);
  const missTomorrow = setup({ providerFetch: () => ok([]) }); missTomorrow.post({ ...REQ, date: '2026-10-07' });
  assert.equal(ttlOf(missTomorrow), 1800, 'local noon of 2026-10-07 is 10:00Z, 26 h after now');
});

// --- Provider attribution (additive, success responses only) ----------------------------

const ATTRIBUTION = { name: 'AeroDataBox', url: 'https://aerodatabox.com/' };

test('attribution: the constant is frozen and exactly { name, url }', () => {
  assert.deepEqual(plain(gs.FCV2_FLT_ATTRIBUTION_), ATTRIBUTION);
  assert.equal(Object.isFrozen(gs.FCV2_FLT_ATTRIBUTION_), true);
  assert.deepEqual(Object.keys(gs.FCV2_FLT_ATTRIBUTION_), ['name', 'url']);
});

test('attribution: present with the exact value on found and not-found, fresh and from the server cache', () => {
  for (const [label, reply, found] of [['found', ok(CASES.bothGates), true], ['not found', { status: 404, body: '' }, false]]) {
    const s = setup({ providerFetch: () => reply });
    const fresh = s.post(REQ);
    assert.equal(fresh.ok, true, label);
    assert.equal(fresh.found, found, label);
    assert.deepEqual(fresh.attribution, ATTRIBUTION, `${label} fresh`);
    assert.equal(Object.keys(fresh).at(-1), 'attribution', 'additive: appended after the existing keys');
    assert.equal(s.calls.provider.length, 1);
    const cached = s.post(REQ);
    assert.equal(s.calls.provider.length, 1, `${label}: second request is a cache hit`);
    assert.deepEqual(cached.attribution, ATTRIBUTION, `${label} cached`);
    assert.deepEqual(cached, fresh, label);
    assert.deepEqual(s.direct(REQ, NOW + 60000).attribution, ATTRIBUTION, `${label} direct handler, cached`);
  }
});

test('attribution: cache entries never contain it (it is added at response time)', () => {
  for (const reply of [ok(CASES.bothGates), { status: 204, body: '' }]) {
    const s = setup({ providerFetch: () => reply });
    s.post(REQ);
    assert.equal(s.cache.size, 1);
    const value = plain(s.cache.get('fcv2-flt-DE1234-2026-10-06-FRA'));
    assert.deepEqual(Object.keys(value), ['fetchedAt', 'found', 'flight']);
    assert.ok(!JSON.stringify(value).includes('AeroDataBox') && !JSON.stringify(value).includes('aerodatabox.com'));
  }
});

test('attribution: absent on every error response', () => {
  const noAttribution = (res, label) => {
    assert.equal(res.ok, false, label);
    assert.equal(typeof res.error, 'string', label);
    assert.equal(Object.hasOwn(res, 'attribution'), false, label);
    assert.ok(!JSON.stringify(res).includes('AeroDataBox'), label);
  };
  const failing = (reply) => setup({ providerFetch: typeof reply === 'function' ? reply : () => reply });
  const refused = setup({ providerFetch: refuse });
  for (const body of [{ ...REQ, flightNumber: 'x' }, { ...REQ, date: '2026-13-01' }, { ...REQ, origin: 'XXX' }, { ...REQ, date: '2026-10-14' }, {}]) {
    noAttribution(refused.post(body), JSON.stringify(body));
  }
  noAttribution(refused.post(REQ, 'wrong-token'), 'unauthorized');
  noAttribution(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 3, action: 'flight', token: TOKEN, ...REQ }), refused.env)), 'unsupported-contract');
  noAttribution(setup({ departuresKey: null, providerFetch: refuse }).post(REQ), 'flight-not-configured');
  noAttribution(failing({ status: 429, body: '' }).post(REQ), '429 exhausted');
  noAttribution(failing({ status: 401, body: '' }).post(REQ), '401');
  noAttribution(failing({ status: 500, body: '' }).post(REQ), '500');
  noAttribution(failing({ status: 200, body: '<html>' }).post(REQ), 'garbage body');
  noAttribution(failing(() => { throw new Error('network'); }).post(REQ), 'throw');
  const ambiguous = [...clone(CASES.multiLeg), clone(CASES.multiLeg[1])];
  ambiguous[2].departure.gate = 'E 5';
  const dup = failing(ok(ambiguous)).post({ flightNumber: 'DE5500', date: '2026-10-06', origin: 'FRA' });
  assert.equal(dup.error, 'flight-ambiguous');
  noAttribution(dup, 'flight-ambiguous');
});

test('attribution: the provider request (URL, key, retries) is unchanged', () => {
  const s = setup({ providerFetch: () => ok(CASES.bothGates) });
  s.post(REQ);
  assert.deepEqual(s.calls.provider, [[`${URL_BASE}DE1234/2026-10-06${URL_QUERY}`, KEY]]);
  assert.deepEqual(s.calls.sleeps, []);
  assert.deepEqual(s.calls.cachePuts, [['fcv2-flt-DE1234-2026-10-06-FRA', 300]]);
});

// --- Capabilities / secrecy / deploys -----------------------------------------------------

const capsOf = (g, opts) => plain(g.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'capabilities', token: TOKEN }), fakeEnv(g, { now: NOW, ...opts }).env));

test('capabilities: flight is offered only with the key (and the file); limits.flightDaysAhead is 7 then', () => {
  const without = capsOf(gs, { departuresKey: null });
  assert.deepEqual(without.actions, ['capabilities', 'roster', 'history', 'stats']);
  assert.ok(!without.actions.includes('flight'));
  assert.equal(without.limits.flightDaysAhead, undefined, 'limits are unchanged without a key');
  assert.equal(capsOf(gs, { departuresKey: '' }).actions.includes('flight'), false);
  const withKey = capsOf(gs, { departuresKey: KEY });
  assert.deepEqual(withKey.actions, ['capabilities', 'roster', 'history', 'stats', 'departures', 'flight']);
  assert.equal(withKey.limits.flightDaysAhead, 7);
  assert.equal(withKey.limits.departuresMaxHours, 24, 'existing limits unchanged');
  assert.equal(withKey.limits.rosterMaxDays, without.limits.rosterMaxDays);
  assert.ok(!JSON.stringify(withKey).includes(KEY));
});

test('departures is untouched: same env, same key, the departures request and capability still work', () => {
  const s = setup({ providerFetch: () => ok({ departures: [] }) });
  const res = plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'departures', token: TOKEN, airport: 'FRA', from: NOW + H, to: NOW + 2 * H }), s.env));
  assert.equal(res.ok, true);
  assert.equal(res.action, 'departures');
  assert.deepEqual(res.flights, []);
  assert.ok(s.calls.provider[0][0].includes('/flights/airports/iata/FRA/'));
  assert.equal(s.calls.provider[0][1], KEY);
  assert.ok(capsOf(gs, { departuresKey: KEY }).actions.includes('departures'));
});

test('secrecy: the provider key never appears in any response, and the source holds no key, log call or property name', () => {
  const replies = [
    ok(CASES.bothGates), ok([]), { status: 204, body: '' }, { status: 404, body: KEY }, { status: 401, body: KEY }, { status: 403, body: KEY },
    { status: 429, body: KEY }, { status: 500, body: KEY }, { status: 200, body: KEY }, ok({ key: KEY }),
    () => { throw new Error(KEY); },
  ];
  for (const reply of replies) {
    const s = setup({ providerFetch: typeof reply === 'function' ? reply : () => reply });
    const text = JSON.stringify([s.post(REQ), s.post({ ...REQ, origin: 'XXX' }), s.post({ ...REQ, date: 'x' }), s.post(REQ, 'bad-token'), s.post({ action: 'capabilities' })]);
    assert.ok(!text.includes(KEY), JSON.stringify(reply));
    assert.ok(![...s.cache.values()].some((v) => JSON.stringify(v).includes(KEY)), 'nothing keyed is cached');
    assert.ok(![...s.cache.keys()].some((k) => k.includes(KEY)));
  }
  const src = readFileSync(new URL('../backend/apps-script/FlightInfoV2.gs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ .*$/gm, ''), /console\.|Logger\.|FC_ADB_RAPIDAPI_KEY|PropertiesService|UrlFetchApp|CacheService/, 'no logging and no direct service or property access');
});

test('partial deploy: without FlightInfoV2.gs the action is not offered and answers flight-not-configured even with the key', () => {
  const partial = loadGs(GS_FILES.filter((f) => f !== 'FlightInfoV2.gs'));
  assert.equal(partial.fcv2HandleFlight_, undefined);
  const f = fakeEnv(partial, { now: NOW, departuresKey: KEY, providerFetch: refuse });
  const res = plain(partial.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'flight', token: TOKEN, ...REQ }), f.env));
  assert.deepEqual(res, { ok: false, error: 'flight-not-configured' });
  assert.equal(f.calls.provider.length, 0);
  const caps = capsOf(partial, { departuresKey: KEY });
  assert.deepEqual(caps.actions, ['capabilities', 'roster', 'history', 'stats', 'departures']);
  assert.equal(caps.limits.flightDaysAhead, undefined);
});

test('partial deploy: FlightInfoV2.gs works without DeparturesV2.gs (self-contained), and offers only flight', () => {
  const partial = loadGs(GS_FILES.filter((f) => f !== 'DeparturesV2.gs'));
  assert.equal(partial.fcv2HandleDepartures_, undefined);
  const f = fakeEnv(partial, { now: NOW, departuresKey: KEY, providerFetch: () => ok(CASES.bothGates) });
  const res = plain(partial.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'flight', token: TOKEN, ...REQ }), f.env));
  assert.equal(res.ok, true);
  assert.deepEqual(res.flight, EXPECTED_BOTH);
  assert.deepEqual(capsOf(partial, { departuresKey: KEY }).actions, ['capabilities', 'roster', 'history', 'stats', 'flight']);
});

// --- Load order / naming ----------------------------------------------------------------

function runFiles(files) {
  const sandbox = { Utilities: {} };
  vm.createContext(sandbox);
  vm.runInContext(files.map((f) => readFileSync(new URL(`../backend/apps-script/${f}`, import.meta.url), 'utf8')).join('\n;\n'), sandbox);
  return sandbox;
}

test('load order: FlightInfoV2.gs is last in GS_FILES, loads alone, and any position still loads', () => {
  assert.equal(GS_FILES.at(-1), 'FlightInfoV2.gs');
  assert.doesNotThrow(() => runFiles(['FlightInfoV2.gs']), 'no top-level dependency on any other file');
  assert.doesNotThrow(() => runFiles(GS_FILES.filter((f) => f !== 'FlightInfoV2.gs')));
  assert.doesNotThrow(() => runFiles(GS_FILES));
  const others = GS_FILES.filter((f) => f !== 'FlightInfoV2.gs');
  assert.doesNotThrow(() => runFiles(['FlightInfoV2.gs', ...others]));
  assert.doesNotThrow(() => runFiles([...others.slice(0, 3), 'FlightInfoV2.gs', ...others.slice(3)]));
  assert.doesNotThrow(() => runFiles(['DeparturesV2.gs', 'FlightInfoV2.gs']));
  assert.doesNotThrow(() => runFiles(['FlightInfoV2.gs', 'DeparturesV2.gs']));
});

test('naming: top-level names are fcv2/FCV2 ... _, declarations only, and none collides with DeparturesV2.gs or references its names', () => {
  const read = (name) => readFileSync(new URL(`../backend/apps-script/${name}`, import.meta.url), 'utf8');
  const namesOf = (src) => [...src.matchAll(/^(?:function|const|let|var)\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  const src = read('FlightInfoV2.gs');
  const names = namesOf(src);
  assert.ok(names.length >= 20);
  for (const n of names) assert.match(n, /^(?:fcv2|FCV2)[A-Za-z0-9_]*_$/, n);
  assert.equal(new Set(names).size, names.length, 'no name declared twice in the file');
  const topLevel = src.split('\n').filter((l) => /^\S/.test(l) && !/^(?:function|const|\}|\/\/|\/\*\*)/.test(l));
  assert.deepEqual(topLevel, [], 'no top-level statements other than function and const declarations');
  for (const other of ['DeparturesV2.gs', 'RosterApiV2.gs', 'RosterModelV2.gs', 'AirportsV2.gs', 'RouterV2.gs', 'CondorAdapterV2.gs', 'CondorCodesV2.gs']) {
    const shared = namesOf(read(other)).filter((n) => names.includes(n));
    assert.deepEqual(shared, [], `names shared with ${other}`);
  }
  const body = src.replace(/^\s*\/\/.*$/gm, '');
  for (const dep of namesOf(read('DeparturesV2.gs'))) assert.ok(!new RegExp(`\\b${dep}\\b`).test(body), `${dep} (DeparturesV2.gs) is not referenced`);
});

test('the request URL carries no undocumented parameter (dateLocalRole removed); matching still enforces departure airport and local date', () => {
  const url = gs.fcv2FlightUrl_('DE2016', '2026-10-06');
  assert.ok(!/dateLocalRole/.test(url));
  assert.ok(url.endsWith('/flights/number/DE2016/2026-10-06?withAircraftImage=false&withLocation=false'));
});
