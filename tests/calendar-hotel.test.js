// C6: the Calendar day detail shows the roster hotel for every day of a stated stay.
// Synthetic data only. The hotel is never inferred; no record means no section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar, resetCalendarUi, hotelSection } from '../src/ui/screens/calendar.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW as FEED_NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';

const fx = fixtureSnapshot();
const NOW = '2026-10-04T08:00:00Z';
// The fixture's FRA → YYZ → FRA rotation: arrive 10 Oct 16:20Z, depart 12 Oct 22:30Z.
const STAY = { start: at('2026-10-10T16:20:00Z'), end: at('2026-10-12T22:30:00Z') };

const HOTEL = { name: 'Testhaus Example Inn', address: '1 Sample Road, Testville', phone: '+1 (555) 010-0100', provenance: 'source', location: null };
const VERIFIED = { ...HOTEL, location: { lat: 43.7, lon: -79.4, mapsUrl: 'https://maps.example.test/?q=testhaus', provenance: 'derived' } };

// As the v2 adapter builds it: the layover window and the stay carry the same hotel.
function withStay(hotel, extra = []) {
  const windows = [{ kind: 'layover', ...STAY, label: 'YYZ', hotel, provenance: 'source', basis: 'hotel-block' }, ...extra];
  const stays = [{ airport: 'YYZ', airportProvenance: 'source', from: STAY.start, to: STAY.end, endProvenance: 'derived', provenance: 'source', basis: 'hotel-block', hotel }];
  return { ...fx, windows, stays, capabilities: { ...fx.capabilities, explicitOff: true } };
}

function detail(snapshot, selected, review = false) {
  const view = { ...pipeline(snapshot, NOW), snapshot, profile: PROFILE, review, loading: false, error: null };
  resetCalendarUi('2026-10', selected);
  const out = calendar.render({ view: () => view }).toString();
  return out.slice(out.indexOf('cal-detail-card'));
}

test('C6: a layover day with a roster hotel shows name, address and tel link, no map link without a verified location', () => {
  const d = detail(withStay(HOTEL), '2026-10-11');
  assert.match(d, /Hotel · from roster/);
  assert.match(d, /Testhaus Example Inn/);
  assert.match(d, /1 Sample Road, Testville/);
  assert.match(d, /<a class="dest-link" href="tel:\+15550100100">\+1 \(555\) 010-0100<\/a>/);
  assert.doesNotMatch(d, /Hotel in Maps|maps\.example|https?:\/\//);
});

test('C6: the hotel shows on every day of the stay, and not on home-base days', () => {
  const snap = withStay(HOTEL);
  const days = ['2026-10-10', '2026-10-11', '2026-10-12'];
  for (const date of days) assert.match(detail(snap, date), /Hotel · from roster/, `stay day ${date}`);
  for (const date of ['2026-10-09', '2026-10-14']) assert.doesNotMatch(detail(snap, date), /Hotel · from roster/, `home day ${date}`);
});

test('C6: "Away from base" days (inferred layover) show the roster stay hotel matched by airport and arrival', () => {
  const stay = { airport: 'YYZ', airportProvenance: 'derived', from: at('2026-10-10T16:20:00Z'), to: at('2026-10-12T22:30:00Z'), provenance: 'source', basis: 'hotel-block', hotel: HOTEL };
  const off = at('2026-10-10T22:00:00Z'); // 11 Oct 00:00 Berlin: a stated off day attached to the layover
  const snap = { ...fx, stays: [stay], windows: [{ kind: 'off', start: off, end: off + 86400000, label: 'OFF' }], capabilities: { ...fx.capabilities, explicitOff: true } };
  const d = detail(snap, '2026-10-11');
  assert.match(d, /Away from base · inferred/);
  assert.match(d, /Hotel · from roster[\s\S]*Testhaus Example Inn/);
  // A stay at another airport is not this layover's hotel (the arrival-time match is gone: see the follow-up tests below).
  assert.doesNotMatch(detail({ ...snap, stays: [{ ...stay, airport: 'DXB' }] }, '2026-10-11'), /Hotel/);
});

test('C6: a verified location adds a map link (and review mode keeps external links off)', () => {
  const d = detail(withStay(VERIFIED), '2026-10-11');
  assert.match(d, /href="https:\/\/maps\.example\.test\/\?q=testhaus"[^>]*rel="noopener noreferrer"/);
  assert.match(d, /Hotel in Maps/);
  assert.doesNotMatch(detail(withStay(VERIFIED), '2026-10-11', true), /maps\.example/);
});

test('C6: no hotel record, no section: nothing is inferred from the city', () => {
  for (const hotel of [null, undefined, { name: '' }]) {
    const d = detail(withStay(hotel), '2026-10-11');
    assert.doesNotMatch(d, /Hotel/);
    assert.match(d, /Layover/);
  }
  assert.equal(hotelSection({ start: STAY.start, end: STAY.end, window: null, layover: null }, fx), '');
});

test('C6: hotel text is escaped (name, address, phone href)', () => {
  const evil = { ...HOTEL, name: '<script>alert(1)</script> Inn', address: '<img src=x onerror=alert(2)>', phone: '+1 555 010 0100' };
  const d = detail(withStay(evil), '2026-10-11');
  assert.doesNotMatch(d, /<script>alert|<img src=x/);
  assert.match(d, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Inn/);
  assert.match(d, /&lt;img src=x onerror=alert\(2\)&gt;/);
});

// --- C6 follow-up: the hotel is looked up in the stays, by the day's location airport ------------

const stayAt = (airport, from, to, hotel = HOTEL, extra = {}) => ({ airport, airportProvenance: 'source', from: at(from), to: to ? at(to) : null, endProvenance: 'derived', provenance: 'source', basis: 'hotel-block', hotel, ...extra });
const offDay = (iso) => { const start = at(iso); return { kind: 'off', start, end: start + 86400000, label: 'OFF' }; };

test('C6: an outstation standby day (derived-airport stay, inferred layover) shows the hotel even though the stay starts later than the layover', () => {
  // Inferred layover at YYZ from 10 Oct 16:20Z; the roster hotel block (derived airport) starts on 11 Oct 02:55Z.
  const stay = stayAt('YYZ', '2026-10-11T02:55:00Z', '2026-10-11T14:55:00Z', HOTEL, { airportProvenance: 'derived' });
  const snap = { ...fx, stays: [stay], windows: [offDay('2026-10-10T22:00:00Z')], capabilities: { ...fx.capabilities, explicitOff: true } };
  const d = detail(snap, '2026-10-11');
  assert.match(d, /Away from base · inferred/);
  assert.match(d, /Hotel · from roster[\s\S]*Testhaus Example Inn/);
});

test('C6: an open stay (no end) shows on its arrival day only', () => {
  const snap = withStay(HOTEL);
  const open = { ...snap, stays: [stayAt('YYZ', '2026-10-10T16:20:00Z', null)] };
  assert.match(detail(open, '2026-10-10'), /Hotel · from roster/, 'arrival day');
  assert.doesNotMatch(detail(open, '2026-10-11'), /Hotel · from roster/, 'next day');
  assert.doesNotMatch(detail(open, '2026-10-12'), /Hotel · from roster/, 'later day');
});

test('C6: a day whose own stay has no hotel does not borrow a neighbouring stay at another airport', () => {
  // The layover window's own hotel was rejected (null); a stay at JFK overlaps the same days with a hotel.
  const snap = withStay(null);
  snap.stays = [...snap.stays, stayAt('JFK', '2026-10-10T20:00:00Z', '2026-10-12T20:00:00Z')];
  const d = detail(snap, '2026-10-11');
  assert.doesNotMatch(d, /Hotel/);
  assert.match(d, /Layover/);
});

test('C6: a stay at another airport than the day location shows nothing', () => {
  const snap = withStay(HOTEL);
  snap.stays = [{ ...snap.stays[0], airport: 'DXB' }];
  assert.doesNotMatch(detail(snap, '2026-10-11'), /Hotel/);
  // And no airport (no window, no inferred layover) means no hotel at all.
  assert.equal(hotelSection({ start: STAY.start, end: STAY.end, window: { kind: 'off', label: 'OFF' }, layover: null }, withStay(HOTEL)), '');
});

test('C6: with several matching stays at the airport, the most recent arrival wins', () => {
  const older = { ...HOTEL, name: 'Older Example Inn' };
  const snap = withStay(HOTEL);
  snap.stays = [stayAt('YYZ', '2026-10-10T16:20:00Z', '2026-10-12T22:30:00Z', older), stayAt('YYZ', '2026-10-11T08:00:00Z', '2026-10-12T22:30:00Z', HOTEL)];
  const d = detail(snap, '2026-10-12');
  assert.match(d, /Testhaus Example Inn/);
  assert.doesNotMatch(d, /Older Example Inn/);
});

test('C6: end to end with the real backend model: stay hotels show on the synthetic BKK layover and BER standby, none at home', () => {
  const gs = loadGs();
  const { env } = fakeEnv(gs, { now: FEED_NOW, feed: feedEvents(), synced: syncedEvents(), rows: hotelRows(feedEvents()) });
  const payload = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: 'test-token-0123456789abcdef', action: 'roster' }), env)));
  const snapshot = adaptV2(payload, { profile: PROFILE, fetchedAt: FEED_NOW });
  const view = { ...pipeline(snapshot, '2026-10-04T08:00:00Z'), snapshot, profile: PROFILE, review: false, loading: false, error: null };
  const show = (date) => { resetCalendarUi('2026-10', date); const out = calendar.render({ view: () => view }).toString(); return out.slice(out.indexOf('cal-detail-card')); };
  const bkk = show('2026-10-09');
  assert.match(bkk, /Sample Riverside Hotel/);
  assert.match(bkk, /Hotel in Maps/);
  const ber = show('2026-10-13');
  assert.match(ber, /Sample Airport Hotel/);
  assert.doesNotMatch(ber, /Hotel in Maps/);
  assert.doesNotMatch(show('2026-10-06'), /Hotel · from roster/);
});
