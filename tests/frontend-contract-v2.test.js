// fc.roster v2 on the frontend: contract validation, adapter, shared classifier and screens,
// controller feature detection and v5 fallback. The payload is produced by the real backend
// model (loaded from backend/apps-script) from the synthetic feed, so both ends are tested
// against each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { validateRoster, validateHistory, request } from '../src/sources/contract-v2.js';
import { adaptV2, adaptHistoryV2 } from '../src/sources/fc-appscript-v2.js';
import { createController, fallbackReason, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { createStore } from '../src/store.js';
import { ApiError } from '../src/api/appscript.js';
import { buildRoster, buildDays } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { buildFlights } from '../src/model/flights.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { flights as flightsScreen } from '../src/ui/screens/flights.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { clock } from '../src/ui/duty.js';
import { PROFILE, loadFixture } from './helpers.js';

const gs = loadGs();
const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const clone = (x) => JSON.parse(JSON.stringify(x));

function backend(body = { action: 'roster' }, now = NOW) {
  const feed = feedEvents();
  const { env } = fakeEnv(gs, { now, feed, synced: syncedEvents(), rows: hotelRows(feed) });
  return clone(gs.fcv2HandlePost_(JSON.stringify(request(body.action, TOKEN, body)), env));
}
const payload = backend();

function pipeline(snapshot, now) {
  const roster = buildRoster(snapshot, PROFILE, now);
  return { roster, state: deriveState(snapshot, roster, PROFILE, now) };
}
const snap = (now = NOW) => adaptV2(payload, { profile: PROFILE, fetchedAt: now });
const dayOf = (snapshot, date) => buildDays(snapshot, buildRoster(snapshot, PROFILE, NOW), PROFILE, NOW, { from: date, count: 1 })[0];

function renderCalendar(snapshot, month, selected = null) {
  resetCalendarUi(month, selected);
  const p = pipeline(snapshot, NOW);
  const view = { ...p, snapshot, profile: PROFILE, now: NOW, review: false, loading: false };
  return calendar.render({ view: () => view }).toString();
}

// --- Contract validation -------------------------------------------------------------

test('feature detection: a real backend payload validates; anything else does not', () => {
  assert.deepEqual(validateRoster(payload), { ok: true });
  assert.equal(validateRoster({ ok: false, error: 'unauthorized' }).reason, 'unauthorized');
  assert.equal(validateRoster({ ...payload, version: 3 }).reason, 'contract-mismatch');
  assert.equal(validateRoster({ ...payload, contract: 'other' }).reason, 'contract-mismatch');
  assert.equal(validateRoster({ ...payload, sectors: [{ ...payload.sectors[0], provenance: 'confirmed' }] }).reason, 'bad-provenance');
  assert.equal(validateRoster({ ...payload, sectors: [{ ...payload.sectors[0], arr: 0 }] }).reason, 'bad-sector');
  assert.equal(validateRoster({ ...payload, coverage: { ...payload.coverage, days: [{ date: '2026-10-01', state: 'off', codes: [] }] } }).reason, 'bad-day');
  assert.equal(validateRoster(null).reason, 'not-an-object');
  assert.deepEqual(request('roster', 't'), { contract: 'fc.roster', version: 2, action: 'roster', token: 't' });
});

// --- ORT and the rest family ----------------------------------------------------------

test('ORT: explicit protected free day through the whole stack, distinct from OFF', () => {
  const s = snap();
  const ort = dayOf(s, '2026-10-04');
  assert.equal(ort.status, 'off');
  assert.equal(ort.offSubtype, 'ort');
  assert.equal(ort.protected, true);
  assert.equal(ort.provenance, 'source');
  const off = dayOf(s, '2026-10-05');
  assert.equal(off.offSubtype, 'off');
  assert.equal(off.protected, false);
  const { state } = pipeline(s, NOW);
  assert.equal(state.status, 'off');
  assert.equal(state.offSubtype, 'ort');
  assert.match(state.reasons[0], /protected free day \(ORT\)/);
  const html = renderCalendar(s, '2026-10', '2026-10-04');
  assert.match(html, /cal-code tok-off tok-ort" aria-hidden="true">ORT</);
  assert.match(html, /cal-code tok-off" aria-hidden="true">OFF</);
  assert.match(html, /cal-code tok-off tok-leave" aria-hidden="true">LEAVE</);
  assert.match(html, /cal-code tok-off" aria-hidden="true">FREE</);
  assert.match(html, /cannot be taken away or reassigned/);
});

test('ORT is never inferred: empty covered days stay UNKNOWN, never OFF or ORT', () => {
  const s = snap();
  const empty = dayOf(s, '2026-10-20');
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.evidence, 'nothing-rostered');
  assert.equal(empty.offSubtype, undefined);
  const { state } = pipeline(s, Date.parse('2026-10-20T10:00:00Z'));
  assert.equal(state.status, 'unknown');
  assert.match(state.reasons.join(' '), /not proof of a day off/);
  // The same day with v5 data is "no duty reported" by absence; still never OFF.
  const v5 = adaptV2({ ...payload, events: payload.events.filter((e) => e.kind !== 'off') }, { profile: PROFILE, fetchedAt: NOW });
  assert.ok(!v5.windows.some((w) => w.kind === 'off'));
  assert.equal(dayOf(v5, '2026-10-04').status, 'unknown');
});

test('coverage: unpublished days are their own UNKNOWN evidence; outside the window is no data', () => {
  const s = snap();
  assert.equal(dayOf(s, '2026-10-27').evidence, 'not-published');
  assert.equal(dayOf(s, '2026-12-01').evidence, 'outside-window');
  assert.equal(dayOf(s, '2026-08-31').evidence, 'before-source');
  assert.equal(dayOf(s, '2026-10-15').evidence, 'unknown-code', 'a rostered day with an unknown code');
});

// --- Report time, pickup, aircraft ----------------------------------------------------

test('report time and outstation pickup reach the duty; wake-up only from a pickup', () => {
  const { roster } = pipeline(snap(), NOW);
  const out = roster.duties.find((d) => d.sectors[0].flightNumber === 'DE9201');
  assert.equal(out.report, Date.parse('2026-10-08T06:30:00Z'));
  assert.equal(out.pickup, null);
  assert.equal(out.wakeup, null, 'no pickup at home → no invented wake-up');
  assert.equal(out.start, out.report);
  const back = roster.duties.find((d) => d.sectors[0].flightNumber === 'DE9202');
  assert.equal(back.pickup, Date.parse('2026-10-10T15:20:00Z'));
  assert.equal(back.wakeup, back.pickup - PROFILE.wakeupOffsetMin * 60000);
});

test('aircraft: shown when present, absent or malformed changes nothing', () => {
  const s = snap();
  const by = Object.fromEntries(s.sectors.map((x) => [x.flightNumber, x]));
  assert.deepEqual(by.DE9201.aircraft, { typeCode: '339', registration: 'DABCD', provenance: 'source' });
  assert.equal(by.DE9205.aircraft, null);
  const bad = adaptV2({ ...payload, sectors: payload.sectors.map((x) => ({ ...x, aircraft: { typeCode: 'A320', registration: '<b>' } })) }, { profile: PROFILE, fetchedAt: NOW });
  assert.ok(bad.sectors.every((x) => x.aircraft === null));
  const r1 = pipeline(s, NOW).roster;
  const r2 = pipeline(bad, NOW).roster;
  assert.deepEqual(r1.rotations.map((r) => r.id), r2.rotations.map((r) => r.id), 'aircraft never affects classification');
  const render = (snapshot, id) => {
    const p = pipeline(snapshot, NOW);
    const view = { ...p, snapshot, profile: PROFILE, now: NOW, review: false, loading: false };
    return flightsScreen.render({ view: () => view, param: () => id, weather: () => null }).toString();
  };
  assert.match(render(s, by.DE9201.id), /Aircraft[\s\S]*?339[\s\S]*?DABCD/);
  assert.doesNotMatch(render(s, by.DE9205.id), /Aircraft/);
});

// --- Hotels and stays -------------------------------------------------------------------

test('hotel provenance: a roster hotel is shown as a record; location only when verified', () => {
  const s = snap();
  const p = pipeline(s, NOW);
  const f = buildFlights(s, p.roster, p.state, PROFILE, NOW);
  const bkk = [...f.sectors.values()].find((e) => e.sector.flightNumber === 'DE9201');
  assert.equal(bkk.stay.kind, 'layover');
  assert.equal(bkk.stay.confidence, 'confirmed', 'the hotel block states the stay');
  assert.equal(bkk.destination.hotel.record.name, 'Sample Riverside Hotel');
  assert.equal(bkk.destination.hotel.record.provenance, 'source');
  assert.equal(bkk.destination.hotel.record.location.mapsUrl, 'https://maps.example.invalid/riverside');
  const view = { ...p, snapshot: s, profile: PROFILE, now: NOW, review: false, loading: false };
  const html = flightsScreen.render({ view: () => view, param: () => bkk.sector.id, weather: () => null }).toString();
  assert.match(html, /Hotel · from roster[\s\S]*Sample Riverside Hotel/);
  assert.match(html, /Hotel in Maps/);
  assert.doesNotMatch(html.slice(html.indexOf('data-fl-detail')), /Not provided by your roster source/);
});

test('a derived-airport stay (standby hotel) never confirms a layover; the gap stays inferred', () => {
  const s = snap();
  assert.ok(s.stays.some((h) => h.airport === 'BER' && h.airportProvenance === 'derived'));
  assert.ok(!s.windows.some((w) => w.kind === 'layover' && w.label === 'BER'));
  const p = pipeline(s, NOW);
  const f = buildFlights(s, p.roster, p.state, PROFILE, NOW);
  const ber = [...f.sectors.values()].find((e) => e.sector.flightNumber === 'DE9203');
  assert.equal(ber.stay.confidence, 'inferred');
  assert.equal(ber.destination.hotel?.record ?? null, null, 'no hotel attached to a stay it was not stated for');
});

test('no hotel block → no hotel record anywhere (search actions only)', () => {
  const s = snap();
  const p = pipeline(s, NOW);
  const f = buildFlights(s, p.roster, p.state, PROFILE, NOW);
  for (const e of f.sectors.values()) {
    if (e.sector.flightNumber !== 'DE9201' && e.destination?.hotel) assert.equal(e.destination.hotel.record, null, e.sector.flightNumber);
  }
});

// --- Time zones -------------------------------------------------------------------------

test('DST/time zones: the frontend shows the same local times the backend states', () => {
  for (const sector of payload.sectors.filter((x) => x.depLocal && x.arrLocal)) {
    assert.equal(clock(sector.dep, sector.originTz), sector.depLocal.slice(11, 16), sector.flightNumber);
    assert.equal(clock(sector.arr, sector.destTz), sector.arrLocal.slice(11, 16), sector.flightNumber);
  }
  const unknown = snap().sectors.find((x) => x.destination === 'QQQ');
  assert.equal(unknown.destTz, null, 'unknown zone stays unknown (UTC shown, labelled)');
});

// --- History ----------------------------------------------------------------------------

test('server history: validated, malformed entries dropped, labelled as roster history', () => {
  const h = backend({ action: 'history' });
  assert.deepEqual(validateHistory(h), { ok: true });
  assert.equal(validateHistory({ ...h, action: 'roster' }).reason, 'contract-mismatch');
  const entries = adaptHistoryV2({ ...h, sectors: [...h.sectors, { flightNumber: 'X', origin: 'bad' }, { ...h.sectors[0], arr: 0 }] }, NOW);
  assert.equal(entries.length, h.sectors.length);
  assert.ok(entries.every((e) => e.historySource === 'roster-calendar'));
});

// --- Controller: feature detection and fallback -----------------------------------------

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}

function harness({ token = TOKEN, post, stats } = {}) {
  const store = createStore(memoryStorage());
  store.set(ENDPOINT_KEY, ENDPOINT);
  if (token) store.set(TOKEN_KEY, token);
  const calls = { post: [], stats: 0 };
  const v5 = loadFixture();
  const api = {
    postContract: async (endpoint, body) => { calls.post.push(body.action); return post(body); },
    fetchStats: async () => { calls.stats += 1; if (stats) return stats(); return { data: v5, meta: {} }; },
  };
  let last = null;
  const c = createController({ profile: PROFILE, onChange: (v) => { last = v; }, store, api, clock: () => NOW });
  return { c, calls, store, view: () => last ?? c.view() };
}

test('v2 available: the roster comes from contract v2; history is fetched once and cached', async () => {
  const h = harness({ post: async (body) => ({ data: backend(body), meta: {} }) });
  await h.c.load({ force: true });
  await new Promise((r) => setTimeout(r, 0));
  const v = h.view();
  assert.equal(v.contract.active, 'v2');
  assert.equal(v.snapshot.contract, 'v2');
  assert.equal(h.calls.stats, 0, 'v5 not called when v2 works');
  assert.deepEqual(h.calls.post, ['roster', 'history']);
  await h.c.load({ force: true });
  assert.deepEqual(h.calls.post, ['roster', 'history', 'roster'], 'history cached for a day');
  assert.equal(h.c.view().snapshot.historySource, 'roster-calendar');
});

test('v5 fallback: no doPost (HTML), refused token, wrong version or invalid payload', async () => {
  const cases = [
    [async () => { throw new ApiError('html-response', 'x'); }, /does not offer the v2 contract/],
    [async () => ({ data: { ok: false, error: 'unauthorized' } }), /token was not accepted/],
    [async () => ({ data: { ...payload, version: 3 } }), /different contract version/],
    [async () => ({ data: { ...payload, sectors: 'nope' } }), /not usable \(missing-sectors\)/],
    [async () => { throw new ApiError('timeout', 'x'); }, /timed out/],
  ];
  for (const [post, reason] of cases) {
    const h = harness({ post });
    await h.c.load({ force: true });
    const v = h.view();
    assert.equal(v.contract.active, 'v5');
    assert.match(v.contract.fallback, reason);
    assert.equal(h.calls.stats, 1, 'falls back to getStats in the same refresh');
    assert.ok(v.snapshot.sectors.length > 0);
  }
});

test('no token: v2 is never attempted; structural failures are not retried for an hour', async () => {
  const none = harness({ token: null, post: async () => { throw new Error('must not be called'); } });
  await none.c.load({ force: true });
  assert.equal(none.calls.post.length, 0);
  assert.equal(none.view().contract.active, 'v5');
  assert.equal(none.view().contract.fallback, null);
  const h = harness({ post: async () => { throw new ApiError('html-response', 'x'); } });
  await h.c.load({ force: true });
  await h.c.load({ force: true });
  assert.equal(h.calls.post.length, 1, 'cool-down after "no v2 here"');
  assert.equal(h.calls.stats, 2);
});

test('backward compatibility: the v5 path is unchanged (no day states, absence evidence)', async () => {
  const h = harness({ token: null, post: async () => { throw new Error('unused'); } });
  await h.c.load({ force: true });
  const s = h.view().snapshot;
  assert.equal(s.dayStates, undefined);
  assert.equal(s.source.id, 'fc-appscript-v5');
  assert.equal(dayOf(s, '2026-10-05').evidence !== 'nothing-rostered', true);
  assert.equal(fallbackReason({ code: 'weird' }), 'the v2 response was not usable (weird)');
});

test('Today on a protected free day says so; leave and free days are listed as rest', () => {
  const s = snap();
  const p = pipeline(s, NOW);
  const view = { ...p, snapshot: s, profile: PROFILE, now: NOW, review: false, loading: false, warnings: [], toneOverride: null, mode: { kind: 'production' } };
  const html = todayScreen.render({ view: () => view }).toString();
  assert.match(html, /Protected free day[\s\S]*>ORT</);
  assert.match(html, /cannot be taken away or reassigned/);
  assert.match(html, /Rest[\s\S]*days off/);
});

// --- Regressions from the blind review --------------------------------------------------

test('regression: unknown codes survive the adapter and are shown as themselves, never as Duty', () => {
  const s = snap();
  assert.ok(JSON.stringify(s).includes('XYZ7'));
  const d = dayOf(s, '2026-10-15');
  assert.equal(d.status, 'unknown');
  assert.equal(d.sourceCode, 'XYZ7');
  const html = renderCalendar(s, '2026-10', '2026-10-15');
  assert.match(html, /aria-hidden="true">XYZ7</);
  assert.doesNotMatch(html.slice(html.indexOf('cal-detail-title')), /cal-detail-title">Duty</);
  const { state } = pipeline(s, Date.parse('2026-10-15T09:00:00Z'));
  assert.equal(state.status, 'unknown');
  assert.match(state.reasons.join(' '), /"XYZ7".*not recognise/);
});

test('regression: server history is kept for its full bound, not cut to 120 days', async () => {
  const many = { ...backend({ action: 'history' }), sectors: Array.from({ length: 12 }, (_, i) => {
    const dep = Date.parse('2025-10-10T08:00:00Z') + i * 25 * 86400000;
    return { id: `s_${i}`, flightNumber: `DE${7000 + i}`, origin: 'FRA', destination: 'BER', dep, arr: dep + 3600000, originTz: 'Europe/Berlin', destTz: 'Europe/Berlin', blockMin: 60, provenance: 'source', basis: 'synced-copy' };
  }) };
  const h = harness({ post: async (body) => ({ data: body.action === 'history' ? many : backend(body) }) });
  await h.c.load({ force: true });
  await new Promise((r) => setTimeout(r, 0));
  const s = h.c.view().snapshot;
  const remembered = s.sectors.filter((x) => x.historySource === 'roster-calendar');
  assert.equal(remembered.length, 12, 'all server history kept, including > 120 days old');
  assert.equal(new Set(s.sectors.map((x) => x.id)).size, s.sectors.length, 'no duplicates after the history merge');
});

test('regression: a home-base hotel stay never becomes a layover window', () => {
  const p = clone(payload);
  p.stays.push({ ...p.stays[0], airport: 'FRA', airportProvenance: 'source' });
  const s = adaptV2(p, { profile: PROFILE, fetchedAt: NOW });
  assert.ok(!s.windows.some((w) => w.kind === 'layover' && w.label === 'FRA'));
});

test('regression: an explicitly coded rest day outranks an inferred layover; generic off windows do not', () => {
  // ORT on a day inside an inferred YYZ layover (fixture v5 flights + one ORT window).
  const base = adaptV2(payload, { profile: PROFILE, fetchedAt: NOW });
  const v5 = (window) => ({ ...base, sectors: [
    { ...base.sectors[0], id: 'a', flightNumber: 'DE1', origin: 'FRA', destination: 'YYZ', dep: Date.parse('2026-10-11T08:00:00Z'), arr: Date.parse('2026-10-11T16:00:00Z'), originTz: 'Europe/Berlin', destTz: 'America/Toronto', pickup: null, report: null },
    { ...base.sectors[0], id: 'b', flightNumber: 'DE2', origin: 'YYZ', destination: 'FRA', dep: Date.parse('2026-10-14T22:00:00Z'), arr: Date.parse('2026-10-15T06:00:00Z'), originTz: 'America/Toronto', destTz: 'Europe/Berlin', pickup: null, report: null },
  ], windows: [window], stays: [], unknownEvents: [] });
  const ort = { kind: 'off', subtype: 'ort', protected: true, start: Date.parse('2026-10-12T22:00:00Z'), end: Date.parse('2026-10-13T22:00:00Z'), label: 'ORT', provenance: 'source' };
  const d1 = dayOf(v5(ort), '2026-10-13');
  assert.equal(d1.status, 'off');
  assert.equal(d1.offSubtype, 'ort');
  const generic = { ...ort, subtype: undefined, protected: false, label: 'OFF' };
  assert.equal(dayOf(v5(generic), '2026-10-13').status, 'layover', 'Phase 5 rule kept for generic off windows');
  const { state } = pipeline(v5(ort), Date.parse('2026-10-13T10:00:00Z'));
  assert.equal(state.status, 'off');
});

test('regression: the newer cache wins at start-up; changing the token keeps device memory', async () => {
  const h = harness({ post: async () => { throw new ApiError('network', 'offline'); }, stats: async () => { throw new ApiError('network', 'offline'); } });
  h.store.setJSON('cache.v2', { payload, fetchedAt: NOW - 20 * 86400000 });
  h.store.setJSON('cache.v5', { payload: loadFixture(), fetchedAt: NOW - 3600000 });
  h.store.setJSON('history.v5', [{ id: 'k', flightNumber: 'DE5555', origin: 'FRA', destination: 'BER', dep: NOW - 5 * 86400000, arr: NOW - 5 * 86400000 + 3600000 }]);
  await h.c.load({ force: true });
  assert.equal(h.c.view().snapshot.source.id, 'fc-appscript-v5', 'fresher v5 cache shown');
  h.c.forgetContractData();
  assert.ok(Array.isArray(h.store.getJSON('history.v5')), 'device memory kept');
  assert.equal(h.store.getJSON('cache.v2'), null);
});

test('unknown codes are listed even on a day classified otherwise (e.g. a layover)', () => {
  const p = clone(payload);
  const bkkDay = Date.parse('2026-10-09T12:00:00Z');
  p.events.push({ id: 'e_ffffffffffffffff', kind: 'unknown', subtype: null, code: 'ME', title: 'ME', start: bkkDay, end: bkkDay + 3600000, location: null, protected: false, provenance: 'source', basis: 'airline-feed' });
  const s = adaptV2(p, { profile: PROFILE, fetchedAt: NOW });
  const d = dayOf(s, '2026-10-09');
  assert.equal(d.status, 'layover');
  assert.deepEqual(d.unknownCodes, ['ME']);
  assert.match(renderCalendar(s, '2026-10', '2026-10-09'), /Also on the roster[\s\S]*ME: a code Flight Control does not recognise/);
  assert.equal(s.windows.find((w) => w.kind === 'layover').endProvenance, 'derived');
});

test('defence in depth: the frontend drops suspicious hotel text and unknown provenance values', () => {
  const p = clone(payload);
  p.stays[1].hotel = { ...p.stays[1].hotel, name: 'MUELLER HANS, SCHMIDT ANNA' };
  p.stays[0].hotel = { ...p.stays[0].hotel, address: `1 Road, CP ${'9'.repeat(6)}Z SAMPLE (FRA)`, phone: '+1 555' };
  p.stays[0].endProvenance = 'confirmed';
  const s = adaptV2(p, { profile: PROFILE, fetchedAt: NOW });
  assert.equal(s.stays[1].hotel, null);
  assert.equal(s.stays[0].hotel.address, null);
  assert.equal(s.stays[0].hotel.phone, null);
  assert.equal(s.stays[0].endProvenance, 'unknown');
});

test('a day with several unknown codes lists all of them in the detail', () => {
  const p = clone(payload);
  const t = Date.parse('2026-10-20T08:00:00Z');
  for (const code of ['ME', 'XYZ']) p.events.push({ id: `e_${code}`, kind: 'unknown', subtype: null, code, title: code, start: t, end: t + 3600000, location: null, protected: false, provenance: 'source', basis: 'airline-feed' });
  const s = adaptV2(p, { profile: PROFILE, fetchedAt: NOW });
  assert.match(renderCalendar(s, '2026-10', '2026-10-20'), /On the roster[\s\S]*ME, XYZ/);
});
