// Weather (decision D1): Open-Meteo from the browser, never blocking, failures → unavailable,
// nothing personal in the request, no network at all in review mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeather, forecastUrl, parseForecast, describeWeatherCode } from '../src/sources/weather-openmeteo.js';
import { sampleWeather } from '../src/sources/sample.js';
import { buildDestination } from '../src/model/destination.js';
import { DEFAULT_PROFILE } from '../src/config/profile.js';
import { at } from './helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const daily = (dates) => ({ daily: { time: dates, weathercode: dates.map(() => 2), temperature_2m_max: dates.map(() => 24.4), temperature_2m_min: dates.map(() => 17.6) } });
const QUERY = { status: 'query', iata: 'BKK', lat: 13.69, lon: 100.7501, tz: 'Asia/Bangkok', date: '2026-10-06', todayLocal: '2026-10-04' };

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  fn.calls = calls;
  return fn;
}

test('success: loading first, then the forecast for the requested local date', async () => {
  let updates = 0;
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => daily(['2026-10-05', '2026-10-06']) }));
  const w = createWeather({ fetchImpl, onUpdate: () => { updates += 1; } });
  assert.deepEqual(w.lookup(QUERY), { status: 'loading' });
  await tick(); await tick();
  const r = w.lookup(QUERY);
  assert.equal(r.status, 'ok');
  assert.equal(r.date, '2026-10-06');
  assert.equal(r.max, 24);
  assert.equal(r.min, 18);
  assert.equal(r.text, 'Partly cloudy');
  assert.equal(r.source, 'Open-Meteo');
  assert.equal(updates, 1);
  assert.equal(fetchImpl.calls.length, 1, 'cached: one request');
});

test('the request carries only coordinates and forecast fields; no credentials, no referrer', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => daily(['2026-10-06']) }));
  createWeather({ fetchImpl }).lookup(QUERY);
  await tick();
  const { url, init } = fetchImpl.calls[0];
  const u = new URL(url);
  assert.equal(u.origin, 'https://api.open-meteo.com');
  assert.deepEqual([...u.searchParams.keys()].sort(), ['daily', 'forecast_days', 'latitude', 'longitude', 'timezone']);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(forecastUrl(1, 2), forecastUrl(1, 2));
});

test('failure: HTTP error, network error, empty or malformed forecast → unavailable, never a throw', async () => {
  for (const respond of [
    () => ({ ok: false, status: 500 }),
    () => { throw new TypeError('Failed to fetch'); },
    () => ({ ok: true, json: async () => ({}) }),
    () => ({ ok: true, json: async () => ({ daily: { time: ['2026-10-06'], temperature_2m_max: ['hot'], temperature_2m_min: [null] } }) }),
    () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
  ]) {
    const w = createWeather({ fetchImpl: fakeFetch(respond) });
    assert.doesNotThrow(() => w.lookup(QUERY));
    await tick(); await tick();
    assert.deepEqual(w.lookup(QUERY), { status: 'unavailable', reason: 'error' });
  }
});

test('timeout: a request that never answers is aborted and becomes unavailable', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const w = createWeather({ fetchImpl, timeoutMs: 5 });
  w.lookup(QUERY);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.lookup(QUERY), { status: 'unavailable', reason: 'error' });
});

test('no fetch available (old runtime) → unavailable', async () => {
  const w = createWeather({ fetchImpl: null });
  w.lookup(QUERY);
  await tick();
  assert.equal(w.lookup(QUERY).status, 'unavailable');
});

test('unavailable airport: no coordinates, unknown zone, out of range → no request at all', () => {
  const fetchImpl = fakeFetch(() => { throw new Error('must not be called'); });
  const w = createWeather({ fetchImpl });
  const now = at('2026-10-04T06:00:00Z');
  const p = DEFAULT_PROFILE;
  // ADB is in the airport table without coordinates (never guessed).
  const noCoords = buildDestination({ iata: 'ADB', tz: 'Europe/Istanbul', arrival: now + 86400000, stay: null }, p, now);
  assert.equal(w.lookup(noCoords.weather).reason, 'no-coordinates');
  const unknown = buildDestination({ iata: 'QQQ', tz: null, arrival: now + 86400000, stay: null }, p, now);
  assert.equal(w.lookup(unknown.weather).reason, 'no-timezone');
  const far = buildDestination({ iata: 'BKK', tz: 'Asia/Bangkok', arrival: now + 20 * 86400000, stay: null }, p, now);
  assert.equal(w.lookup(far.weather).status, 'later');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a date missing from the forecast is unavailable, not guessed', async () => {
  const w = createWeather({ fetchImpl: fakeFetch(() => ({ ok: true, json: async () => daily(['2026-10-05']) })) });
  w.lookup(QUERY);
  await tick(); await tick();
  assert.deepEqual(w.lookup(QUERY), { status: 'unavailable', reason: 'not-in-forecast' });
});

test('review samples: labelled, deterministic, and never a network call', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('review mode must not fetch'); };
  try {
    const q = { status: 'unavailable', reason: 'no-coordinates', iata: 'AWAY', tz: 'Asia/Dubai', date: '2026-10-06', todayLocal: '2026-10-04' };
    const a = sampleWeather(q);
    assert.equal(a.status, 'ok');
    assert.equal(a.sample, true);
    assert.equal(a.source, 'Sample');
    assert.deepEqual(sampleWeather(q), a);
    // A real airport in review is not looked up.
    assert.deepEqual(sampleWeather(QUERY), { status: 'unavailable', reason: 'review' });
    assert.equal(sampleWeather({ status: 'unavailable', reason: 'no-timezone' }).reason, 'no-timezone');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('weather codes map to plain text; unknown codes stay null', () => {
  assert.equal(describeWeatherCode(0), 'Clear');
  assert.equal(describeWeatherCode(95), 'Thunderstorm');
  assert.equal(describeWeatherCode(1234), null);
  assert.equal(parseForecast(null).size, 0);
});

test('an expired forecast stays visible while it refreshes', async () => {
  let t = 0;
  let answer = () => ({ ok: true, json: async () => daily(['2026-10-06']) });
  const w = createWeather({ fetchImpl: fakeFetch((...a) => answer(...a)), now: () => t });
  w.lookup(QUERY);
  await tick(); await tick();
  t = 2 * 3600000;
  answer = () => new Promise(() => {}); // the refresh never answers
  const r = w.lookup(QUERY);
  assert.equal(r.status, 'ok');
  assert.equal(r.max, 24);
});
