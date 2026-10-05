// C6: the Calendar day detail shows the roster hotel for every day of a stated stay.
// Synthetic data only. The hotel is never inferred; no record means no section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendar, resetCalendarUi, hotelSection } from '../src/ui/screens/calendar.js';
import { PROFILE, at, fixtureSnapshot, pipeline } from './helpers.js';

const fx = fixtureSnapshot();
const NOW = '2026-10-04T08:00:00Z';
// The fixture's FRA → YYZ → FRA rotation: arrive 10 Oct 16:20Z, depart 12 Oct 22:30Z.
const STAY = { start: at('2026-10-10T16:20:00Z'), end: at('2026-10-12T22:30:00Z') };

const HOTEL = { name: 'Testhaus Example Inn', address: '1 Sample Road, Testville', phone: '+1 (555) 010-0100', provenance: 'source', location: null };
const VERIFIED = { ...HOTEL, location: { lat: 43.7, lon: -79.4, mapsUrl: 'https://maps.example.test/?q=testhaus', provenance: 'derived' } };

function withStay(hotel, extra = []) {
  const windows = [{ kind: 'layover', ...STAY, label: 'YYZ', hotel, provenance: 'source', basis: 'hotel-block' }, ...extra];
  return { ...fx, windows, capabilities: { ...fx.capabilities, explicitOff: true } };
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
  const stay = { airport: 'YYZ', airportProvenance: 'derived', from: at('2026-10-10T16:20:00Z'), to: null, provenance: 'source', basis: 'hotel-block', hotel: HOTEL };
  const off = at('2026-10-10T22:00:00Z'); // 11 Oct 00:00 Berlin: a stated off day attached to the layover
  const snap = { ...fx, stays: [stay], windows: [{ kind: 'off', start: off, end: off + 86400000, label: 'OFF' }], capabilities: { ...fx.capabilities, explicitOff: true } };
  const d = detail(snap, '2026-10-11');
  assert.match(d, /Away from base · inferred/);
  assert.match(d, /Hotel · from roster[\s\S]*Testhaus Example Inn/);
  // A stay at another airport or another arrival time is not this layover's hotel.
  assert.doesNotMatch(detail({ ...snap, stays: [{ ...stay, airport: 'DXB' }] }, '2026-10-11'), /Hotel/);
  assert.doesNotMatch(detail({ ...snap, stays: [{ ...stay, from: stay.from + 3600000 }] }, '2026-10-11'), /Hotel/);
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
