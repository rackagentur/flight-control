// fc.roster v2 backend (Apps Script sources, loaded into a sandbox): classification, ORT,
// aircraft, hotels/stays provenance, coverage, DST, privacy, API auth and bounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadGs, nodeDeps, fakeEnv, localDate } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { renderAirportsGs } from '../scripts/gen-airports-gs.mjs';

const gs = loadGs();
const TOKEN = 'test-token-0123456789abcdef';
const plain = (x) => JSON.parse(JSON.stringify(x));
const post = (env, body) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, token: TOKEN, ...body }), env));
const classify = (title, description = '', extra = {}) => plain(gs.fcv2ClassifyEvent_({ sourceId: 'x', title, start: 0, end: 1, description, basis: 'airline-feed', ...extra }, gs.FCV2_CONDOR_CONFIG_));

function roster(options = {}) {
  const feed = options.feed ?? feedEvents();
  const synced = options.synced ?? syncedEvents();
  const { env } = fakeEnv(gs, { now: options.now ?? NOW, feed, synced, rows: hotelRows(feedEvents()) });
  return post(env, { action: 'roster', ...(options.body ?? {}) });
}

// --- Classification ---------------------------------------------------------------

test('ORT is an explicit, protected free day: kind off, subtype ort, source', () => {
  const e = classify('ORT', 'FRA SAMPLE AIRPORT FRA\n\nORTSTAG');
  assert.equal(e.kind, 'off');
  assert.equal(e.subtype, 'ort');
  assert.equal(e.protected, true);
  const r = roster();
  const day = r.coverage.days.find((d) => d.date === '2026-10-04');
  assert.deepEqual(day.codes.map((c) => [c.subtype, c.protected, c.provenance]), [['ort', true, 'source']]);
});

test('ORT vs ordinary OFF, free day and leave stay distinct subtypes of the free family', () => {
  assert.deepEqual(['OFF', '-', 'U', 'ORT'].map((t) => { const e = classify(t); return [e.kind, e.subtype, e.protected]; }),
    [['off', 'off', false], ['off', 'free', false], ['off', 'leave', false], ['off', 'ort', true]]);
});

test('ORT is never inferred: only the exact code counts; empty days carry no code', () => {
  assert.equal(classify('ORTX').kind, 'unknown');
  assert.equal(classify('XYZ', 'ORTSTAG').kind, 'unknown', 'a description mentioning it is not the code');
  const r = roster();
  const empty = r.coverage.days.filter((d) => d.state === 'empty');
  assert.ok(empty.length >= 5);
  assert.ok(empty.every((d) => d.codes.length === 0));
  assert.ok(r.coverage.days.filter((d) => d.codes.some((c) => c.subtype === 'ort')).every((d) => d.state === 'rostered'));
});

test('a rostered day needs no rest code: duty-only days are rostered with codes []', () => {
  const r = roster();
  const tz = r.source.baseTimeZone;
  const datesOf = (e) => { const s = new Set([localDate(e.start, tz)]); for (let t = e.start; t < e.end; t += 3600000) s.add(localDate(t, tz)); return s; };
  const restDays = new Set(r.events.filter((e) => e.kind === 'off').flatMap((e) => [...datesOf(e)]));
  const dutyDays = new Set(r.events.filter((e) => e.kind !== 'off').flatMap((e) => [...datesOf(e)]));
  const dutyOnly = r.coverage.days.filter((d) => dutyDays.has(d.date) && !restDays.has(d.date));
  assert.ok(dutyOnly.length >= 3, 'the fixture has flight/standby/reserve days without a rest code');
  assert.ok(dutyOnly.every((d) => d.state === 'rostered' && d.codes.length === 0));
  // codes[] is exactly the explicit rest-family events of the day, never derived from duties.
  assert.ok(r.coverage.days.every((d) => (d.codes.length > 0) === restDays.has(d.date)));
});

test('unknown source codes are preserved with their original code and title', () => {
  const r = roster();
  const u = r.events.find((e) => e.kind === 'unknown');
  assert.equal(u.code, 'XYZ7');
  assert.equal(u.title, 'XYZ7');
  assert.equal(u.provenance, 'source');
  assert.ok(r.warnings.some((w) => w.code === 'unknown-code'));
});

test('standby and reserve come only from their codes, with their windows and codes', () => {
  const r = roster();
  assert.deepEqual(r.windows.map((w) => [w.kind, w.code]), [['standby', 'SB90'], ['reserve', 'RE5']]);
  assert.equal(classify('SBX').kind, 'unknown');
});

// --- Aircraft ---------------------------------------------------------------------

test('aircraft: present → source metadata; absent or malformed → null, classification unchanged', () => {
  const r = roster();
  const by = Object.fromEntries(r.sectors.map((s) => [s.flightNumber, s]));
  assert.deepEqual(by.DE9201.aircraft, { typeCode: '339', registration: 'DABCD', provenance: 'source' });
  assert.equal(by.DE9205.aircraft, null, 'absent');
  assert.equal(by.DE9204.aircraft, null, 'malformed "D-ABC (3)" is ignored');
  assert.equal(by.DE9204.flightNumber, 'DE9204');
  assert.equal(r.duties.length, 7, 'aircraft never changes duties');
  assert.equal(classify('DE1 FRA-BER', 'NOTREG (32N) extra').aircraft, null);
  assert.equal(classify('DE1 FRA-BER', 'DABCD (A320)').aircraft, null, 'type must be a 3-character code');
});

// --- Sectors, duties, DST ---------------------------------------------------------

test('sectors: IANA local times with offsets, +N days, block, unknown airport → no local time', () => {
  const r = roster();
  const by = Object.fromEntries(r.sectors.map((s) => [s.flightNumber, s]));
  assert.equal(by.DE9201.depLocal, '2026-10-08T10:00+02:00');
  assert.equal(by.DE9201.arrLocal, '2026-10-09T02:00+07:00');
  assert.equal(by.DE9201.dayShift, 1);
  assert.equal(by.DE9201.blockMin, 660);
  assert.equal(by.DE9205.depLocal, '2026-10-26T10:00+01:00', 'after the EU change: +01:00');
  assert.equal(by.DE9205.destTz, null);
  assert.equal(by.DE9205.arrLocal, null);
  assert.equal(by.DE9205.zoneProvenance, 'unknown');
  assert.ok(r.warnings.some((w) => w.code === 'unknown-airport'));
});

test('DST: the 25-hour leave day on 25 Oct maps to exactly one local date', () => {
  const r = roster();
  const leave = r.coverage.days.filter((d) => d.codes.some((c) => c.subtype === 'leave'));
  assert.deepEqual(leave.map((d) => d.date), ['2026-10-25']);
  assert.equal(gs.fcv2StartOfDay_('2026-10-25', 'Europe/Berlin'), Date.parse('2026-10-24T22:00:00Z'));
  assert.equal(gs.fcv2StartOfDay_('2026-10-26', 'Europe/Berlin'), Date.parse('2026-10-25T23:00:00Z'));
  assert.equal(gs.fcv2StartOfDay_('2026-10-05', 'Asia/Kolkata'), Date.parse('2026-10-04T18:30:00Z'), 'half-hour zone');
  assert.equal(gs.fcv2LocalIso_(Date.parse('2026-03-29T01:30:00Z'), 'Europe/Berlin'), '2026-03-29T03:30+02:00');
});

test('duties: report from check-in (source) and pickup at an outstation; none invented at home', () => {
  const r = roster();
  const bySector = (n) => r.duties.find((d) => d.sectorIds.includes(r.sectors.find((s) => s.flightNumber === n).id));
  const out = bySector('DE9201');
  assert.equal(out.report.at, Date.parse('2026-10-08T06:30:00Z'));
  assert.equal(out.report.provenance, 'source');
  assert.equal(out.report.association, 'derived');
  assert.equal(out.pickup, null, 'no pickup at home base');
  const back = bySector('DE9202');
  assert.equal(back.pickup.at, Date.parse('2026-10-10T15:20:00Z'));
  assert.equal(back.start, back.pickup.at);
  assert.equal(bySector('DE9205').report, null);
});

// --- Stays and hotels ---------------------------------------------------------------

test('hotel block on a flight → a source stay at its destination; end derived from the next departure', () => {
  const r = roster();
  const bkk = r.stays.find((s) => s.airport === 'BKK');
  assert.equal(bkk.provenance, 'source');
  assert.equal(bkk.basis, 'hotel-block');
  assert.equal(bkk.airportProvenance, 'source');
  assert.equal(bkk.endProvenance, 'derived');
  assert.equal(bkk.to, Date.parse('2026-10-10T17:30:00Z'));
  assert.equal(bkk.hotel.name, 'Sample Riverside Hotel');
  assert.equal(bkk.hotel.provenance, 'source');
});

test('hotel location only from a VERIFIED Sheet row recorded for THIS stay', () => {
  const r = roster();
  const bkk = r.stays.find((s) => s.airport === 'BKK');
  assert.deepEqual(bkk.hotel.location, { lat: 13.7, lon: 100.5, mapsUrl: 'https://maps.example.invalid/riverside', placeId: 'place-sample-1', status: 'verified', provenance: 'derived' });
  const ber = r.stays.find((s) => s.airport === 'BER');
  assert.equal(ber.hotel.location, null, 'VERIFIED row exists but not for this stay');
  const yyz = r.stays.find((s) => s.airport === 'YYZ');
  assert.equal(yyz.hotel.location, null, 'REVIEW rows add nothing');
});

test('standby hotel: airport derived from the previous arrival, or unknown; never a fabricated sector', () => {
  const r = roster();
  const ber = r.stays.find((s) => s.airport === 'BER');
  assert.equal(ber.airportProvenance, 'derived');
  assert.equal(r.sectors.length, 7, 'stays never create sectors');
  // Without a previous arrival the airport stays unknown.
  const lone = feedEvents().filter((e) => e.title === 'SB90');
  const r2 = roster({ feed: lone, synced: [] });
  assert.equal(r2.stays[0].airport, null);
  assert.equal(r2.stays[0].airportProvenance, 'unknown');
});

test('no hotel block → no stay and no hotel, even when the Sheet knows a hotel there', () => {
  const r = roster();
  assert.ok(!r.stays.some((s) => s.evidenceEventIds.includes(r.sectors.find((x) => x.flightNumber === 'DE9203').eventId)));
  assert.equal(r.stays.length, 3);
});

// --- Coverage ----------------------------------------------------------------------

test('coverage: previous/current/next month; synced copy before today, airline feed from today', () => {
  const r = roster();
  assert.equal(r.coverage.from, '2026-09-01');
  assert.equal(r.coverage.to, '2026-11-30');
  assert.deepEqual(r.source.segments, [
    { from: '2026-09-01', to: '2026-10-03', basis: 'synced-copy' },
    { from: '2026-10-04', to: '2026-11-30', basis: 'airline-feed' },
  ]);
  assert.equal(r.coverage.lastRosteredDate, '2026-10-26');
  const state = (d) => r.coverage.days.find((x) => x.date === d).state;
  assert.equal(state('2026-10-20'), 'empty');
  assert.equal(state('2026-10-27'), 'unpublished');
  assert.equal(state('2026-09-10'), 'empty', 'synced segment is never "unpublished"');
  assert.ok(r.coverage.days.every((d) => d.state !== 'off'), 'OFF is a code, never a day state');
  assert.equal(r.coverage.days.length, 91);
});

// --- Privacy -------------------------------------------------------------------------

test('privacy: crew lines, employee numbers, booking codes and notes never reach the output', () => {
  const crew = (rank, k) => `${rank} ${String(k).repeat(6)}Z SAMPLE, PERSON (FRA)`;
  const feed = feedEvents().map((e) => (e.title.startsWith('DE') ? { ...e, description: `${e.description}\n${crew('CP', 1)}\n${crew('ST', 2)}\nBooking code: SECRET9` } : e));
  const out = JSON.stringify(roster({ feed }));
  assert.doesNotMatch(out, /\b\d{6}[A-Z]\b/);
  assert.doesNotMatch(out, /SAMPLE, PERSON|SECRET9|SAMPLE1|SAMPLE2|Booking|Original Notes|ORTSTAG|Pick up/);
  assert.match(out, /Sample Riverside Hotel/, 'the hotel block is the one allowed description content');
});

// --- API: auth, contract, bounds -------------------------------------------------------

test('auth: not configured, wrong or missing token are refused; repeated failures are throttled, never the correct token', () => {
  const { env } = fakeEnv(gs, { now: NOW, token: null });
  assert.equal(post(env, { action: 'capabilities' }).error, 'not-configured');
  const f = fakeEnv(gs, { now: NOW });
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'capabilities', token: 'nope' }), f.env)).error, 'unauthorized');
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'capabilities' }), f.env)).error, 'unauthorized');
  for (let i = 0; i < 25; i += 1) gs.fcv2HandlePost_(JSON.stringify({ token: 'x' }), f.env);
  assert.equal(f.env.failures.get(), 20, 'failures are counted up to the limit, then no longer');
  const wrong = (action) => plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action, token: 'nope' }), f.env));
  assert.equal(wrong('capabilities').error, 'rate-limited');
  assert.equal(wrong('stats').error, 'rate-limited');
  assert.equal(f.calls.airline.length + f.calls.synced.length + f.calls.stats, 0, 'nothing is read without a valid token');
  // BH-2: failures by someone else never lock the owner out.
  assert.equal(post(f.env, { action: 'capabilities' }).ok, true, 'the correct token is accepted over the limit');
  assert.equal(post(f.env, { action: 'stats' }).success, true);
  assert.equal(gs.fcv2SafeEqual_('abc', 'abc'), true);
  assert.equal(gs.fcv2SafeEqual_('abc', 'abd'), false);
  assert.equal(gs.fcv2SafeEqual_('abc', 'abcd'), false);
});

test('bad requests and contract versions are rejected', () => {
  const { env } = fakeEnv(gs, { now: NOW });
  assert.equal(plain(gs.fcv2HandlePost_('not json', env)).error, 'bad-request');
  assert.equal(plain(gs.fcv2HandlePost_('', env)).error, 'bad-request');
  assert.equal(plain(gs.fcv2HandlePost_('x'.repeat(9000), env)).error, 'bad-request');
  assert.equal(plain(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 3, token: TOKEN, action: 'roster' }), env)).error, 'unsupported-contract');
  assert.equal(post(env, { action: 'nope' }).error, 'unknown-action');
  assert.equal(post(env, { action: 'roster', from: '2026-01-01', to: '2026-12-31' }).error, 'range-too-long');
  assert.equal(post(env, { action: 'roster', from: '2026-02-30', to: '2026-03-01' }).error, 'bad-range');
});

test('capabilities: feature-detection answer', () => {
  const { env } = fakeEnv(gs, { now: NOW });
  const c = post(env, { action: 'capabilities' });
  assert.equal(c.ok, true);
  assert.equal(c.contract, 'fc.roster');
  assert.equal(c.version, 2);
  assert.deepEqual(c.actions, ['capabilities', 'roster', 'history', 'stats']);
});

test('stats (BH-2): the v5 getStats payload, unchanged, only with the token', () => {
  const f = fakeEnv(gs, { now: NOW });
  assert.deepEqual(post(f.env, { action: 'stats' }), { success: true, upcoming: [], marker: 'v5-payload' });
  assert.equal(f.calls.stats, 1);
  const refused = [
    gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'stats' }), f.env),
    gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'stats', token: TOKEN + 'x' }), f.env),
    gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 3, action: 'stats', token: TOKEN }), f.env),
    gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'stats', token: TOKEN }), fakeEnv(gs, { now: NOW, token: null }).env),
  ].map((r) => plain(r).error);
  assert.deepEqual(refused, ['unauthorized', 'unauthorized', 'unsupported-contract', 'not-configured']);
  assert.equal(f.calls.stats, 1, 'getFlightStats is never called without the token');
  const broken = fakeEnv(gs, { now: NOW });
  broken.env.stats = () => { throw new Error('internal detail'); };
  assert.deepEqual(post(broken.env, { action: 'stats' }), { ok: false, error: 'stats-unavailable' });
});

test('history: bounded (start date, 13 months, past only, 2000 sectors) and cached', () => {
  const synced = syncedEvents();
  const f = fakeEnv(gs, { now: NOW, synced });
  const h = post(f.env, { action: 'history' });
  assert.equal(h.ok, true);
  assert.equal(h.range.from, '2025-10-01');
  assert.equal(h.range.to, '2026-10-03');
  assert.deepEqual(h.sectors.map((s) => s.flightNumber), ['DE9101', 'DE9102']);
  assert.ok(h.sectors.every((s) => s.basis === 'synced-copy' && s.provenance === 'source'));
  assert.equal(JSON.stringify(h).includes('ORT'), false, 'history holds flights only');
  post(f.env, { action: 'history' });
  assert.equal(f.calls.synced.length, 1, 'second call served from cache');
  assert.equal(post(f.env, { action: 'history', from: '2022-07-01', to: '2022-12-31' }).error, 'before-history-start');
  assert.equal(post(f.env, { action: 'history', from: '2024-01-01', to: '2025-06-30' }).error, 'range-too-long');
  assert.equal(post(f.env, { action: 'history', from: '2026-09-01', to: '2026-10-10' }).error, 'history-is-past-only');
  // The sector cap keeps the most recent and says so.
  const many = Array.from({ length: gs.FCV2_HISTORY_MAX_SECTORS_ + 5 }, (_, i) => ({
    sourceId: `h${i}`, title: `DE${1000 + (i % 8000)} FRA-BER`, start: Date.parse('2026-09-01T00:00:00Z') + i * 600000, end: Date.parse('2026-09-01T00:00:00Z') + i * 600000 + 300000, basis: 'synced-copy',
  }));
  const big = plain(gs.fcv2BuildHistory_({ events: many.map((e) => gs.fcv2ClassifyEvent_(e, gs.FCV2_CONDOR_CONFIG_)), from: '2026-09-01', to: '2026-09-30', now: NOW, config: gs.FCV2_CONDOR_CONFIG_ }, nodeDeps(gs)));
  assert.equal(big.sectors.length, gs.FCV2_HISTORY_MAX_SECTORS_);
  assert.equal(big.truncated, true);
  assert.equal(big.sectors.at(-1).id.length, 18);
});

test('an event present in both the synced copy and the feed appears once', () => {
  const feed = feedEvents();
  const dup = { ...feed[0], basis: 'synced-copy' };
  const r = roster({ synced: [...syncedEvents(), dup], body: { from: '2026-10-01', to: '2026-10-31' } });
  assert.equal(r.events.filter((e) => e.kind === 'off' && e.subtype === 'ort' && localDate(e.start + 3600000, 'Europe/Berlin') === '2026-10-04').length, 1);
});

test('ids are opaque hashes, stable for the same source event', () => {
  const a = roster();
  const b = roster();
  assert.deepEqual(a.sectors.map((s) => s.id), b.sectors.map((s) => s.id));
  assert.ok(a.events.every((e) => /^e_[0-9a-f]{16}$/.test(e.id)));
  assert.doesNotMatch(JSON.stringify(a), /src-airline-feed|src-synced-copy/);
});

// --- Portability and generated table ----------------------------------------------------

test('the model is airline-independent; airline specifics live in the adapter config', () => {
  const model = readFileSync(new URL('../backend/apps-script/RosterModelV2.gs', import.meta.url), 'utf8');
  assert.doesNotMatch(model, /\bFRA\b|['"]DE['"]|Europe\/Berlin|['"]ORT['"]|['"]SB|C\/I|P\/U/);
  assert.doesNotMatch(model, /condor/i);
  const api = readFileSync(new URL('../backend/apps-script/RosterApiV2.gs', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /\bFRA\b|['"]DE['"]|Europe\/Berlin/);
});

test('AirportsV2.gs is exactly the generated copy of the frontend airport table', () => {
  const file = readFileSync(new URL('../backend/apps-script/AirportsV2.gs', import.meta.url), 'utf8');
  assert.equal(file, renderAirportsGs());
});

test('backend sources hold no identifiers: calendar/sheet ids and deployment urls are referenced by name only', () => {
  for (const f of ['CondorAdapterV2.gs', 'RosterModelV2.gs', 'RosterApiV2.gs', 'AirportsV2.gs']) {
    const text = readFileSync(new URL(`../backend/apps-script/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /@group\.calendar|@import\.calendar|script\.google\.com\/macros|spreadsheets\/d\/|AIza|[A-Za-z0-9_]{40,}/, f);
    assert.doesNotMatch(text, /^function (?!doPost\b)[A-Za-z0-9]+[^_]\(/m, `${f}: every helper ends in "_"`);
  }
});

test('privacy: a crew line glued to the hotel block (no blank line) is never taken into the address', () => {
  const crewLine = `ST ${'4'.repeat(6)}K SAMPLE, PERSON (FRA)`;
  const parsed = plain(gs.fcv2ParseDescription_(`Hotel\nSample Hotel\n1 Sample Road\nSample City\n+49 30 0000000\n${crewLine}`));
  assert.deepEqual(parsed.hotel, { name: 'Sample Hotel', address: '1 Sample Road, Sample City', phone: '+49 30 0000000' });
  const noPhone = plain(gs.fcv2ParseDescription_(`Hotel\nSample Hotel\n1 Sample Road\n${crewLine}\nmore`));
  assert.deepEqual(noPhone.hotel, { name: 'Sample Hotel', address: null, phone: null }, 'fail-closed: no phone line, no address');
  assert.equal(plain(gs.fcv2ParseDescription_('Hotel\n\nSample')).hotel, null, 'no name, no hotel');
});

test('hotel names with commas or short prefixes are kept', () => {
  const p = plain(gs.fcv2ParseDescription_('Hotel\nNH Collection Hotel, Sample City\nAV 5 de Mayo, Sample Town\n+52 000 000'));
  assert.deepEqual(p.hotel, { name: 'NH Collection Hotel, Sample City', address: 'AV 5 de Mayo, Sample Town', phone: '+52 000 000' });
});

test('privacy: the hotel parser is an allow-list; crew-like lines, name lists and codes end the block', () => {
  const block = (extra) => plain(gs.fcv2ParseDescription_(`Hotel\nSample Hotel\n${extra}\nmore text`)).hotel;
  for (const bad of ['CP Mustermann, Max (FRA)', 'CP 1234567 MUSTERMANN MAX', `cp ${'1'.repeat(6)}a sample`, 'MUSTERMANN, MAX',
    'Buchungscode: ABC123', 'Booking code: X', 'PNR ABC123', 'Sample (FRA)']) {
    assert.deepEqual(block(bad), { name: 'Sample Hotel', address: null, phone: null }, bad);
  }
  assert.equal(plain(gs.fcv2ParseDescription_('Hotel\nMUSTERMANN, MAX\n1 Road')).hotel, null, 'a name list is never a hotel name');
  const two = plain(gs.fcv2ParseDescription_('Hotel\nFirst Hotel\n1 Road\n\nHotel\nSecond Hotel')).hotel;
  assert.equal(two.name, 'First Hotel', 'a second block is ignored, never merged');
});

test('aircraft: only a type code with a digit, never inside the hotel block', () => {
  assert.equal(plain(gs.fcv2ParseDescription_('PARIS (CDG)')).aircraft, null);
  assert.equal(plain(gs.fcv2ParseDescription_('Hotel\nSample Hotel\nHOTEL (PMI)')).aircraft, null);
  assert.deepEqual(plain(gs.fcv2ParseDescription_('DABCD (32N)')).aircraft, { registration: 'DABCD', typeCode: '32N' });
  assert.equal(plain(gs.fcv2ParseDescription_('Hotel\nSample Hotel\nDABCD (32N)')).aircraft, null);
});

test('a hotel block on a flight into the home base never creates a stay', () => {
  const ev = { sourceId: 'hb', title: 'DE9300 PMI-FRA', start: Date.parse('2026-10-06T10:00:00Z'), end: Date.parse('2026-10-06T12:30:00Z'), description: 'Hotel\nSample Hotel\n1 Road', basis: 'airline-feed' };
  const r = roster({ feed: [ev], synced: [] });
  assert.equal(r.stays.length, 0);
  assert.ok(r.warnings.some((w) => w.code === 'hotel-at-home-base'));
});

test('history bound counts calendar months (13 at most), not days', () => {
  const f = fakeEnv(gs, { now: NOW, synced: syncedEvents() });
  assert.equal(post(f.env, { action: 'history', from: '2025-01-01', to: '2026-02-07' }).error, 'range-too-long', '14 months');
  assert.equal(post(f.env, { action: 'history', from: '2025-02-01', to: '2026-02-28' }).ok, true, '13 months');
});

test('zero-offset local times are numeric ("+00:00"), as Apps Script "Z" is normalised', () => {
  assert.equal(gs.fcv2LocalIso_(Date.parse('2026-12-01T10:00:00Z'), 'Europe/London'), '2026-12-01T10:00+00:00');
});

test('leave booked ahead does not mark later unpublished days as published', () => {
  const feed = [...feedEvents(), { sourceId: 'far', title: 'U', start: Date.parse('2026-11-19T23:00:00Z'), end: Date.parse('2026-11-20T23:00:00Z'), location: 'FRA', basis: 'airline-feed' }];
  const r = roster({ feed });
  assert.equal(r.coverage.lastRosteredDate, '2026-10-26');
  assert.equal(r.coverage.days.find((d) => d.date === '2026-11-10').state, 'unpublished');
});

test('privacy (round 2): fail-closed hotel parsing against adversarial crew/name/code lines', () => {
  const hotel = (text) => plain(gs.fcv2ParseDescription_(text)).hotel;
  const leaks = ['Müller, Hans', 'Schmidt, Anna', 'ŻÓŁĆ, ANNA', 'CP1 Mueller Hans', 'FA2 Schmidt Anna', 'PU1 MUELLER HANS',
    'Buchungscode XYZ123', 'Buchungsnummer 123ABC', 'Confirmation 98765XY', 'Reservation ABC123', 'cp mueller hans (fra)',
    'MUELLER/HANS', 'H. MUELLER / A. SCHMIDT', 'Cockpit'];
  for (const bad of leaks) {
    // Without a phone line no address is ever taken.
    assert.deepEqual(hotel(`Hotel\nSample Hotel\n${bad}`), { name: 'Sample Hotel', address: null, phone: null }, bad);
    // With a phone line a bad line drops the whole address.
    const withPhone = hotel(`Hotel\nSample Hotel\n1 Sample Road\n${bad}\n+49 30 000000`);
    assert.equal(withPhone.address === null || !withPhone.address.includes(bad), true, bad);
    // As the name, the hotel is dropped.
    if (!/Cockpit/.test(bad)) assert.equal(hotel(`Hotel\n${bad}\n1 Road\n+49 30 000000`), null, `name ${bad}`);
  }
  const e2e = hotel('Hotel\nSample Riverside Hotel\n99 Sample Street\nCP1 Mustermann Max\nFA2 Musterfrau Erika');
  assert.deepEqual(e2e, { name: 'Sample Riverside Hotel', address: null, phone: null });
  // The real layout still parses fully.
  assert.deepEqual(hotel('Hotel\nSample Airport Hotel\n3 Sample Square\n12345 Sample Town\nSample City\n+49 30 0000000'),
    { name: 'Sample Airport Hotel', address: '3 Sample Square, 12345 Sample Town, Sample City', phone: '+49 30 0000000' });
  assert.deepEqual(hotel('Hotel\nHotel Riu Plaza, Sample City\nAV 5 de Mayo 100\n+52 000 000'),
    { name: 'Hotel Riu Plaza, Sample City', address: 'AV 5 de Mayo 100', phone: '+52 000 000' });
});

test('privacy (round 3): rank-led lines, multi-word name lists and codes never become hotel data', () => {
  const hotel = (text) => plain(gs.fcv2ParseDescription_(text)).hotel;
  for (const name of ['CP MUELLER, HANS', 'CP MUELLER HANS', 'SEN MUELLER HANS', 'CPT MUELLER', 'CP 1234 MUELLER, HANS', 'von Müller, Hans',
    'Müller, Hans Peter', 'MUELLER HANS, SCHMIDT ANNA', 'Mueller Hans (FRA )', 'K7X9QZ']) {
    assert.equal(hotel(`Hotel\n${name}\n99 Sample Street\n+66 2 000 0000`), null, name);
  }
  for (const line of ['K7X9QZ', 'SAMPLE1', 'ABCD123', 'Conf ABC123', 'Mueller Hans 12345X', 'CP MUELLER HANS']) {
    assert.equal(hotel(`Hotel\nSample Riverside Hotel\n99 Sample Street\n${line}\n+66 2 000 0000`).address, null, line);
  }
  assert.deepEqual(hotel('Hotel\nSt. Regis Hotel\n1 Sample Road\n+1 555 0100'), { name: 'St. Regis Hotel', address: '1 Sample Road', phone: '+1 555 0100' });
});
