// Destination intelligence (decision D5): only what applies, only what the data supports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDestination, weatherQuery, FORECAST_DAYS } from '../src/model/destination.js';
import { destinationView, diffText } from '../src/ui/destination.js';
import { DEFAULT_PROFILE } from '../src/config/profile.js';
import { at } from './helpers.js';

const P = DEFAULT_PROFILE;
const H = 3600000;

test('home-base arrivals have no destination layer at all', () => {
  const now = at('2026-10-04T06:00:00Z');
  assert.equal(buildDestination({ iata: 'FRA', tz: 'Europe/Berlin', arrival: now + H, stay: null }, P, now), null);
  assert.equal(destinationView(null, null, { now }).toString(), '');
});

test('hotel: never an invented assignment; actions only for overnight stays outside the no-hotel list', () => {
  const now = at('2026-10-04T06:00:00Z');
  const layover = { kind: 'layover', confidence: 'inferred', from: now + 10 * H, to: now + 60 * H };
  const yyz = buildDestination({ iata: 'YYZ', tz: 'America/Toronto', arrival: now + 10 * H, stay: layover }, P, now);
  assert.equal(yyz.hotel.record, null);
  assert.match(yyz.hotel.search, /hotels%20in%20Toronto/);
  const html = destinationView(yyz, null, { now }).toString();
  assert.match(html, /Not provided by your roster source/);
  assert.match(html, /Hotels in Toronto/);
  // BER is on the no-hotel list (v5 behaviour): no hotel UI.
  const ber = buildDestination({ iata: 'BER', tz: 'Europe/Berlin', arrival: now + 10 * H, stay: layover }, P, now);
  assert.equal(ber.hotel, null);
  // A turnaround never offers hotels.
  const turn = buildDestination({ iata: 'YYZ', tz: 'America/Toronto', arrival: now + 10 * H, stay: { kind: 'turn', confidence: null, from: now + 10 * H, to: now + 11 * H } }, P, now);
  assert.equal(turn.hotel, null);
  // Review: the hotel line stays honest, external links are off.
  const review = destinationView(yyz, null, { now, review: true }).toString();
  assert.match(review, /Hotel links are off in review mode/);
  assert.doesNotMatch(review, /https:\/\//);
});

test('unknown airport: local time unknown (UTC shown), weather unavailable, no map link', () => {
  const now = at('2026-10-04T06:00:00Z');
  const d = buildDestination({ iata: 'QQQ', tz: null, arrival: now + H, stay: null }, P, now);
  assert.equal(d.tz, null);
  assert.equal(d.diffNow, null);
  assert.equal(d.maps, null);
  assert.equal(d.weather.reason, 'no-timezone');
  const html = destinationView(d, { status: 'unavailable', reason: 'no-timezone' }, { now }).toString();
  assert.match(html, /Unknown/);
  assert.match(html, /shown in UTC/);
  assert.match(html, /Time zone unknown/);
});

test('time difference from home is DST-correct at arrival and now (EU/US change weeks differ)', () => {
  // EU leaves DST on 25 Oct 2026, the US on 1 Nov 2026: Toronto is 5 h behind that week, 6 h otherwise.
  const now = at('2026-10-20T08:00:00Z');
  const arrival = at('2026-10-28T16:00:00Z');
  const d = buildDestination({ iata: 'YYZ', tz: 'America/Toronto', arrival, stay: null }, P, now);
  assert.equal(d.diffNow, -360);
  assert.equal(d.diffAtArrival, -300);
  assert.equal(diffText(-300), '5h behind home');
  assert.equal(diffText(330), '5h 30m ahead of home');
  assert.equal(diffText(0), 'Same time as home');
});

test('layover nights are counted in outstation-local dates; duration in minutes', () => {
  const now = at('2026-10-04T06:00:00Z');
  // Arrive Bangkok 23:30 local (16:30Z), depart two local days later 01:00 (18:00Z + 1 day).
  const stay = { kind: 'layover', confidence: 'confirmed', from: at('2026-10-06T16:30:00Z'), to: at('2026-10-07T18:00:00Z'), minutes: 1530, nights: 2 };
  const d = buildDestination({ iata: 'BKK', tz: 'Asia/Bangkok', arrival: stay.from, stay }, P, now);
  assert.equal(d.stay.nights, 2);
  assert.equal(d.stay.minutes, 1530);
  assert.equal(d.stay.current, false);
});

test('weather date is the LOCAL arrival date (v5 used days-from-today: intended fix)', () => {
  const now = at('2026-10-04T06:00:00Z');
  // 16:30Z on 6 Oct is 23:30 in Bangkok on 6 Oct, but 18:30 on 6 Oct at home; 18:30Z is 01:30 on 7 Oct in Bangkok.
  const d = buildDestination({ iata: 'BKK', tz: 'Asia/Bangkok', arrival: at('2026-10-06T18:30:00Z'), stay: null }, P, now);
  assert.equal(d.weather.status, 'query');
  assert.equal(d.weather.date, '2026-10-07');
});

test('while staying there, the forecast is for today (local)', () => {
  const now = at('2026-10-08T03:00:00Z');
  const stay = { kind: 'layover', confidence: 'inferred', from: at('2026-10-06T16:30:00Z'), to: at('2026-10-09T18:00:00Z') };
  const d = buildDestination({ iata: 'BKK', tz: 'Asia/Bangkok', arrival: stay.from, stay }, P, now);
  assert.equal(d.stay.current, true);
  assert.equal(d.weather.date, '2026-10-08');
  assert.ok(d.stay.remainingMin > 0);
});

test('forecast range: day 9 is queried, day 10 is "later"', () => {
  const now = at('2026-10-04T06:00:00Z');
  const q = (days) => weatherQuery({ iata: 'BKK', tz: 'Asia/Bangkok', arrival: now + days * 86400000, stay: null }, now);
  assert.equal(FORECAST_DAYS, 10);
  assert.equal(q(9).status, 'query');
  assert.equal(q(10).status, 'later');
});

test('a stay that has ended offers no hotel actions', () => {
  const now = at('2026-10-20T06:00:00Z');
  const past = { kind: 'layover', confidence: 'inferred', from: at('2026-10-10T16:00:00Z'), to: at('2026-10-12T20:00:00Z') };
  const d = buildDestination({ iata: 'YYZ', tz: 'America/Toronto', arrival: past.from, stay: past }, P, now);
  assert.equal(d.hotel, null);
  assert.equal(d.stay.current, false);
  assert.equal(d.weather.reason, 'past');
});

test('Today adopts the shared destination weather; hidden when no outstation applies', async () => {
  const { today } = await import('../src/ui/screens/today.js');
  const { sampleSnapshot, sampleProfile, sampleWeather } = await import('../src/sources/sample.js');
  const { pipeline } = await import('./helpers.js');
  const SP = sampleProfile(P);
  const iso = '2026-10-04T08:00:00Z';
  const render = (state) => {
    const snapshot = sampleSnapshot(state, 'ocean', at(iso), SP);
    const v = pipeline(snapshot, iso, SP);
    const view = { ...v, profile: SP, snapshot, review: true, loading: false, error: null, warnings: [], toneOverride: 'ocean', mode: { kind: 'sample' } };
    return today.render({ view: () => view, weather: sampleWeather }).toString();
  };
  const away = render('layover');
  assert.match(away, /Weather[\s\S]*AWAY · [A-Z][a-z]{2} \d+ [A-Z][a-z]{2}[\s\S]*sample/);
  assert.doesNotMatch(away, /Phase 6/);
  const standby = render('standby');
  assert.doesNotMatch(standby, /Destination forecast|Phase 6/);
});
