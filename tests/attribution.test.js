// Provider attribution: validation (readAttribution, both wire validators), adapters and the Flight
// Detail footer. The provider is data from the backend; values here are invented unless marked.
// Radar caption tests live in radar-screen.test.js (they need that file's screen harness).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAttribution } from '../src/sources/attribution.js';
import { attributionText } from '../src/ui/attribution.js';
import { validateDepartures, adaptDepartures } from '../src/sources/departures-v2.js';
import { validateFlightInfo, adaptFlightInfo } from '../src/sources/flight-info-v2.js';
import { flightOpsView } from '../src/ui/flight-ops.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOOD = { name: 'Example Data', url: 'https://data.example/' };
const REAL = { name: 'AeroDataBox', url: 'https://aerodatabox.com/' }; // the backend's real value: allowed in tests only

// ---------- readAttribution ----------

test('readAttribution accepts the valid shape and returns the parsed href', () => {
  assert.deepEqual(readAttribution(GOOD), { name: 'Example Data', url: 'https://data.example/' });
  assert.deepEqual(readAttribution(REAL), { name: 'AeroDataBox', url: 'https://aerodatabox.com/' });
  assert.equal(readAttribution({ name: ' Padded ', url: 'https://data.example' }).name, 'Padded');
  assert.equal(readAttribution({ name: 'A&B Data-1', url: 'https://data.example' }).url, 'https://data.example/');
  assert.equal(Object.isFrozen(readAttribution(GOOD)), true);
});

test('readAttribution rejects non-https, credentials, extra or missing keys, odd names and non-objects', () => {
  const bad = [
    { ...GOOD, url: 'http://data.example/' },
    { ...GOOD, url: 'javascript:alert(1)' },
    { ...GOOD, url: 'https://user:pw@data.example/' },
    { ...GOOD, url: 'https://user@data.example/' },
    { ...GOOD, url: 'https://data.example/' + 'a'.repeat(200) },
    { ...GOOD, url: 'not a url' },
    { ...GOOD, url: 'https://xn--ä.example/' },
    { ...GOOD, url: 42 },
    { ...GOOD, extra: 1 },
    { name: 'Example Data' },
    { url: GOOD.url },
    { name: '', url: GOOD.url },
    { name: '   ', url: GOOD.url },
    { name: 'x'.repeat(41), url: GOOD.url },
    { name: '<b>Data</b>', url: GOOD.url },
    { name: '.Data', url: GOOD.url },
    { name: 'Data\nData', url: GOOD.url },
    { name: 'Dätä', url: GOOD.url },
    { name: 7, url: GOOD.url },
    null, undefined, 'x', 7, true, [], [GOOD.name, GOOD.url], () => GOOD,
    Object.create({ name: 'Example Data', url: GOOD.url }),
  ];
  for (const a of bad) assert.equal(readAttribution(a), null, JSON.stringify(a));
  assert.equal(readAttribution({ name: 'x'.repeat(40), url: GOOD.url })?.name.length, 40);
  const throwing = { get name() { throw new Error('boom'); }, url: GOOD.url };
  assert.equal(readAttribution(throwing), null, 'never throws');
});

// ---------- departures ----------

const FX = () => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/departures-v2.synthetic.json'), 'utf8'));

test('validateDepartures: attribution is optional; valid passes, bad fails with bad-attribution', () => {
  assert.deepEqual(validateDepartures(FX()), { ok: true });
  assert.deepEqual(validateDepartures({ ...FX(), attribution: GOOD }), { ok: true });
  for (const bad of [null, 'x', { ...GOOD, url: 'http://data.example/' }, { ...GOOD, extra: 1 }, {}, undefined]) {
    assert.deepEqual(validateDepartures({ ...FX(), attribution: bad }), { ok: false, reason: 'bad-attribution' }, JSON.stringify(bad));
  }
});

test('adaptDepartures carries a valid attribution and gives null when absent', () => {
  assert.deepEqual(adaptDepartures({ ...FX(), attribution: GOOD }).attribution, GOOD);
  assert.equal(adaptDepartures(FX()).attribution, null);
});

// ---------- flight info ----------

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const MIN = 60000;
const leg = (over = {}) => ({ airport: 'AAA', scheduled: T0 + 2 * 3600000, revised: null, runway: null, terminal: null, gate: 'A12', desk: null, belt: null, quality: ['basic', 'live'], ...over });
const wire = (over = {}, found = true) => ({
  ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'p', generatedAt: T0, fetchedAt: T0 - MIN,
  query: { flightNumber: 'XX1234', date: '2026-10-08', origin: 'AAA' }, found,
  flight: found ? { id: 'g_0123456789abcdef', flightNumber: 'XX1234', status: 'scheduled', lastUpdated: T0 - 2 * MIN, departure: leg(), arrival: leg({ airport: 'BBB', gate: null, belt: '3' }), provenance: 'provider' } : null,
  ...over,
});

test('validateFlightInfo accepts with and without attribution (found and not found) and rejects a bad one', () => {
  for (const found of [true, false]) {
    assert.deepEqual(validateFlightInfo(wire({}, found)), { ok: true });
    assert.deepEqual(validateFlightInfo(wire({ attribution: GOOD }, found)), { ok: true });
    for (const bad of [null, 'x', { ...GOOD, url: 'http://data.example/' }, { ...GOOD, extra: 1 }, undefined]) {
      assert.deepEqual(validateFlightInfo(wire({ attribution: bad }, found)), { ok: false, reason: 'bad-attribution' }, JSON.stringify(bad));
    }
  }
  // Still strict about every other key.
  assert.deepEqual(validateFlightInfo(wire({ attribution: GOOD, surprise: 1 })), { ok: false, reason: 'bad-keys' });
});

test('adaptFlightInfo carries attribution for found and not-found, null when absent', () => {
  assert.deepEqual(adaptFlightInfo(wire({ attribution: GOOD }), { now: T0 }).attribution, GOOD);
  assert.deepEqual(adaptFlightInfo(wire({ attribution: GOOD }, false), { now: T0 }).attribution, GOOD);
  assert.equal(adaptFlightInfo(wire(), { now: T0 }).attribution, null);
  assert.equal(adaptFlightInfo(wire({}, false), { now: T0 }).attribution, null);
});

// ---------- display ----------

test('attributionText renders the link exactly, escapes the name, and is empty for null', () => {
  const out = String(attributionText(GOOD));
  assert.equal(out, '<span class="attr">Data: <a class="attr-link" href="https://data.example/" target="_blank" rel="noopener">Example Data<span class="visually-hidden"> (opens in a new tab)</span></a></span>');
  assert.match(out, /rel="noopener"/);
  assert.doesNotMatch(out, /noreferrer|referrerpolicy/);
  assert.equal(String(attributionText(null)), '');
  assert.equal(String(attributionText(undefined)), '');
  const escaped = String(attributionText({ name: '<img src=x onerror=1>', url: 'https://data.example/?q="x"' }));
  assert.ok(!escaped.includes('<img'));
  assert.match(escaped, /&lt;img src=x onerror=1&gt;/);
  assert.ok(!escaped.includes('q="x"'));
});

const NOW = T0 + 5 * MIN;
const SECTOR = { origin: 'AAA', destination: 'BBB', dep: T0 + 2 * 3600000, arr: T0 + 5 * 3600000, originTz: 'Europe/Berlin', destTz: 'Europe/Berlin' };
const VIEW = { profile: { homeTz: 'Europe/Berlin' } };
const footerOf = (out) => out.split('class="fo-foot"')[1] ?? '';
const view = (state) => String(flightOpsView(state, SECTOR, VIEW));
const info = (over = {}, found = true, now = NOW) => adaptFlightInfo(wire({ attribution: GOOD, ...over }, found), { now });
const LINK = /Data: <a class="attr-link" href="https:\/\/data\.example\/" target="_blank" rel="noopener">Example Data<span class="visually-hidden"> \(opens in a new tab\)<\/span><\/a>/;

test('Flight Detail footer shows the attribution link in the normal, stale and not-found footers', () => {
  const normal = view({ status: 'ready', info: info() });
  assert.equal(info().stale, false);
  assert.match(footerOf(normal), /Live flight information · Updated \d\d:\d\d · <span class="attr">Data: <a class="attr-link"/);
  assert.match(footerOf(normal), LINK);

  const staleInfo = info({}, true, T0 + 3 * 3600000);
  assert.equal(staleInfo.stale, true);
  const stale = view({ status: 'ready', info: staleInfo });
  assert.match(footerOf(stale), /fo-stale/);
  assert.match(footerOf(stale), /Information may have changed\.<\/span> · <span class="attr">Data: <a class="attr-link"/);
  assert.match(footerOf(stale), LINK);

  const none = view({ status: 'ready', info: info({}, false) });
  assert.match(none, /fo-message/);
  assert.match(footerOf(none), LINK);
});

test('Flight Detail footer shows no attribution when null, nor in loading or error states', () => {
  const without = adaptFlightInfo(wire(), { now: NOW });
  assert.doesNotMatch(view({ status: 'ready', info: without }), /attr-link|Data:/);
  assert.doesNotMatch(view({ status: 'ready', info: adaptFlightInfo(wire({}, false), { now: NOW }) }), /attr-link|Data:/);
  assert.doesNotMatch(view({ status: 'loading' }), /attr-link|Data:/);
  assert.doesNotMatch(view({ status: 'error', error: 'timeout', info: info() }), /attr-link|Data:/);
  // The name is escaped in the footer (an adapted, validated name cannot hold markup, so check the renderer directly).
  const forged = { ...info(), attribution: { name: '<b>x</b>', url: 'https://data.example/' } };
  assert.doesNotMatch(view({ status: 'ready', info: forged }), /<b>x/);
});
