// Phase 2: recognised Condor roster codes. A single dash '-' (Strichtag, evidence: live-feed trace 2026-10-06) is the
// airline-neutral canonical day kind 'unassigned' (NOT off/free); '--' never occurs in the feed and is unknown again;
// five Condor standby roster symbols are 'standby'.
// Classifier → backend roster → adapter → day model → state engine → screens, with synthetic data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { request, validateRoster } from '../src/sources/contract-v2.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { buildRoster, buildDays } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { buildMonth } from '../src/model/calendar.js';
import { normalizeProfile } from '../src/config/profile.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { weekView } from '../src/ui/week.js';
import { airlineOf } from '../src/airlines/index.js';
import { PROFILE } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const gs = loadGs();
const plain = (x) => JSON.parse(JSON.stringify(x));
const TOKEN = 'test-token-0123456789abcdef';
const classify = (title, description = '') => plain(gs.fcv2ClassifyEvent_({ sourceId: 'x', title, start: 0, end: 1, description, basis: 'airline-feed' }, gs.FCV2_CONDOR_CONFIG_));
const PREFIX = '✈️✈️✈️ ';
const HOTEL_BLOCK = 'Hotel\nSample Plain Hotel\n1 Sample Road\nSample Town\n+49 30 0000000';

// --- 1. Classifier --------------------------------------------------------------------

test("'-' (single dash) is the unassigned day: kind unassigned, no subtype, not protected, no hotel", () => {
  for (const title of ['-', `${PREFIX}-`, '  -  ', '- ']) {
    const e = classify(title, HOTEL_BLOCK);
    assert.deepEqual([e.kind, e.code, e.title, e.subtype, e.protected, e.hotel], ['unassigned', '-', '-', null, false, null], JSON.stringify(title));
  }
});

test("'-' is not off, not free, not ORT; OFF, U and ORT are untouched", () => {
  const dash = classify('-');
  assert.notEqual(dash.kind, 'off');
  assert.notEqual(dash.subtype, 'free');
  assert.notEqual(dash.subtype, 'ort');
  assert.deepEqual(['OFF', 'U', 'ORT'].map((t) => { const e = classify(t); return [e.kind, e.subtype, e.protected]; }),
    [['off', 'off', false], ['off', 'leave', false], ['off', 'ort', true]]);
  // The table no longer emits the 'free' subtype at all (it stays a valid contract subtype for other airlines).
  assert.equal(JSON.stringify(gs.FCV2_CONDOR_CODES_).includes('"free"'), false);
});

test("'--' never occurs in the real feed: it is unknown again, with the original code kept", () => {
  for (const title of ['--', `${PREFIX}--`, '-- ']) {
    const e = classify(title, HOTEL_BLOCK);
    assert.deepEqual([e.kind, e.code, e.title, e.subtype, e.protected, e.hotel], ['unknown', '--', '--', null, false, null], JSON.stringify(title));
  }
});

test('the five Condor standby roster symbols are standby (code is the raw title); the hotel block is attached like SB90', () => {
  for (const t of ['SB90S', 'SB90_I', 'SBH30', 'SBAUS', 'SB90KO']) {
    for (const title of [t, `${PREFIX}${t}`]) {
      const e = classify(title);
      assert.deepEqual([e.kind, e.code, e.title, e.subtype, e.protected, e.hotel], ['standby', t, t, null, false, null], title);
    }
    const withHotel = classify(t, HOTEL_BLOCK);
    assert.equal(withHotel.kind, 'standby');
    assert.deepEqual(withHotel.hotel, classify('SB90', HOTEL_BLOCK).hotel, `${t}: same hotel handling as SB90`);
    assert.equal(withHotel.hotel.name, 'Sample Plain Hotel');
  }
  // Existing SB/RE patterns are unchanged.
  assert.deepEqual(['SB', 'SB90', 'SB999', 'RE', 'RE10', 'RE5'].map((t) => classify(t).kind), ['standby', 'standby', 'standby', 'reserve', 'reserve', 'reserve']);
});

test('agreement symbol names and every other unrecognised code stay unknown; there is no permissive fallback', () => {
  const unknown = ['SBY', 'SBYHOT', 'SBYKO', 'SBY_I', 'SB30-AUS', 'SBYAP', 'RES10', 'RES10_I',
    'XYZ', 'XYZ7', '--', '---', '- -', '–', '—', '-- ', '--x', '-x', 'x-', 'sb90s', 'Sb90S', 'sbh30', 'SB90S2', 'SB90_', 'SB90K', 'SB90KOO', 'SBAUS1', 'SBH3', 'SB 90S', '*'];
  for (const t of unknown) {
    for (const title of [t, `${PREFIX}${t}`]) {
      const e = classify(title, HOTEL_BLOCK);
      assert.equal(e.kind, 'unknown', title);
      assert.deepEqual([e.subtype, e.protected, e.hotel], [null, false, null], title);
    }
  }
  // A trailing space is removed by title cleaning, so 'SB90S ' / '- ' are the exact symbols.
  assert.equal(classify('SB90S ').kind, 'standby');
  assert.equal(classify('SB90S ').code, 'SB90S');
  assert.equal(classify('- ').kind, 'unassigned');
  assert.equal(classify('-- ').kind, 'unknown');
  // A description that mentions a code never makes the title that code.
  assert.equal(classify('XYZ', '-\nSB90S').kind, 'unknown');
  // Codes seen in the live feed but not established stay unknown (meaning not established).
  for (const t of ['U1', 'SBX', 'HS5', 'EM', 'RE10S', 'DH/DE1234', 'LH1234 FRA-MUC']) assert.equal(classify(t).kind, 'unknown', t);
});

// --- 3. Backend roster ----------------------------------------------------------------

const NOW_UNASSIGNED = Date.parse('2026-10-19T09:00:00Z');
let n = 900;
const ev = (title, start, end, description = '') => ({ sourceId: `src-airline-feed-${++n}`, title, start: Date.parse(start), end: Date.parse(end), location: 'FRA', description, basis: 'airline-feed' });
// Local Berlin days as the feed encodes them (24 h events at local midnight).
const dayEv = (title, fromIso, toIso) => ev(title, fromIso, toIso, 'FRA SAMPLE AIRPORT FRA');
/** The synthetic feed plus, from today (19 Oct) on: a '-' day (19), optionally a '--' day (20, unknown), an SB90S day (21) and an ORT day (22). */
function extendedFeed({ withUnknown = true, withDouble = false, extra = [] } = {}) {
  const base = feedEvents().filter((e) => withUnknown || e.title !== 'XYZ7');
  return [...base,
    dayEv('-', '2026-10-18T22:00:00Z', '2026-10-19T22:00:00Z'),
    ...(withDouble ? [dayEv('--', '2026-10-19T22:00:00Z', '2026-10-20T22:00:00Z')] : []),
    ev('SB90S', '2026-10-21T02:55:00Z', '2026-10-21T14:55:00Z', HOTEL_BLOCK),
    dayEv('ORT', '2026-10-21T22:00:00Z', '2026-10-22T22:00:00Z'),
    ...extra];
}
function backendRoster(feed, now = NOW_UNASSIGNED) {
  const { env } = fakeEnv(gs, { now, feed, synced: syncedEvents(), rows: hotelRows(feedEvents()) });
  return plain(gs.fcv2HandlePost_(JSON.stringify(request('roster', TOKEN, { action: 'roster', from: '2026-10-01', to: '2026-11-02' })), env));
}

test("backend: a '-' day is an unassigned event and a coverage code; capabilities.unassigned; contract still validates", () => {
  const r = backendRoster(extendedFeed({ withUnknown: false }));
  assert.equal(validateRoster(r).ok, true);
  // One dash day: today (19 Oct). The base feed's own dash day (6 Oct) is before 'now' and not served by the airline feed.
  const dashEvents = r.events.filter((x) => x.code === '-');
  assert.equal(dashEvents.length, 1);
  for (const e of dashEvents) assert.deepEqual([e.kind, e.subtype, e.protected, e.provenance], ['unassigned', null, false, 'source']);
  const e = dashEvents.find((x) => x.start === Date.parse('2026-10-18T22:00:00Z'));
  const day = r.coverage.days.find((d) => d.date === '2026-10-19');
  assert.equal(day.state, 'rostered');
  assert.deepEqual(day.codes.map((c) => ({ ...c, eventId: typeof c.eventId })), [{ kind: 'unassigned', subtype: null, code: '-', protected: false, eventId: 'string', provenance: 'source' }]);
  assert.equal(day.codes[0].eventId, e.id);
  assert.equal(r.capabilities.unassigned, true);
  assert.equal(r.capabilities.explicitOff, true);
  // Not an off/free code, not a window; never a warning.
  assert.ok(r.coverage.days.every((d) => d.codes.every((c) => c.kind === 'off' || c.code === '-')));
  assert.ok(r.coverage.days.every((d) => d.codes.every((c) => c.subtype !== 'free')));
  assert.ok(r.windows.every((w) => w.kind === 'standby' || w.kind === 'reserve'));
  assert.ok(!r.windows.some((w) => w.code === '-'));
  assert.equal(r.warnings.some((w) => w.code === 'unknown-code'), false, 'no unknown-code warning when every code is recognised');
});

test("backend: '--' is an unknown event with the unknown-code warning and never reaches coverage codes", () => {
  const r = backendRoster(extendedFeed({ withUnknown: false, withDouble: true }));
  const e = r.events.find((x) => x.code === '--');
  assert.deepEqual([e.kind, e.subtype, e.protected, e.title], ['unknown', null, false, '--']);
  const w = r.warnings.find((x) => x.code === 'unknown-code');
  assert.ok(w);
  assert.match(w.message, /^1 roster event\(s\)/);
  assert.equal(r.coverage.days.find((d) => d.date === '2026-10-20').codes.length, 0);
  assert.equal(validateRoster(r).ok, true);
});

test('backend: the SB90S day is a standby event and window with its hotel handled like SB90', () => {
  const r = backendRoster(extendedFeed({ withUnknown: false }));
  const e = r.events.find((x) => x.code === 'SB90S');
  assert.deepEqual([e.kind, e.subtype, e.protected], ['standby', null, false]);
  assert.deepEqual(r.windows.filter((w) => w.kind === 'standby').map((w) => w.code), ['SB90S']);
  assert.ok(r.stays.some((s) => s.hotel.name === 'Sample Plain Hotel'));
});

test("backend: an unrecognised code ('XYZ') still yields unknown plus the warning; 'unknown' never leaks into coverage codes", () => {
  const r = backendRoster(extendedFeed({ withUnknown: false, extra: [dayEv('XYZ', '2026-10-26T23:00:00Z', '2026-10-27T23:00:00Z')] }));
  const u = r.events.find((x) => x.code === 'XYZ');
  assert.equal(u.kind, 'unknown');
  const w = r.warnings.find((x) => x.code === 'unknown-code');
  assert.ok(w);
  assert.match(w.message, /^1 roster event\(s\)/);
  assert.equal(r.coverage.days.find((d) => d.date === '2026-10-27').codes.length, 0);
});

test('backend: the rest of the output is unchanged by an unassigned day (off codes, windows, sectors); a dash day is never an off code', () => {
  const feed = extendedFeed({ withUnknown: false });
  const withIt = backendRoster(feed);
  const without = backendRoster(feed.filter((e) => e.title !== '-'));
  assert.deepEqual(withIt.sectors, without.sectors);
  assert.deepEqual(withIt.coverage.days.map((d) => [d.date, d.codes.filter((c) => c.kind === 'off')]), without.coverage.days.map((d) => [d.date, d.codes.filter((c) => c.kind === 'off')]));
});

// --- 4. Frontend model ----------------------------------------------------------------

const payload = backendRoster(extendedFeed({ withUnknown: false }));
const payloadDouble = backendRoster(extendedFeed({ withUnknown: false, withDouble: true }));
const snapshotFor = (profile = PROFILE, p = payload) => adaptV2(p, { profile, fetchedAt: NOW_UNASSIGNED });
const GENERIC_PROFILE = normalizeProfile({ ...PROFILE, airlineId: 'generic' });

test("adapter: a '-' event becomes an unassigned window, never an off window or an unknown event", () => {
  const snap = snapshotFor();
  const w = snap.windows.filter((x) => x.kind === 'unassigned');
  assert.equal(w.length, 1, 'today (19 Oct)');
  for (const x of w) assert.deepEqual([x.subtype, x.protected, x.provenance, x.label], [undefined, undefined, 'source', '-']);
  assert.ok(!snap.windows.some((x) => x.kind === 'off' && x.label === '-'));
  assert.ok(!snap.unknownEvents.some((u) => u.code === '-'));
  // '--' stays an unknown event and never becomes a window.
  const d = snapshotFor(PROFILE, payloadDouble);
  assert.ok(d.unknownEvents.some((u) => u.code === '--'));
  assert.equal(d.windows.filter((x) => x.kind === 'unassigned').length, 1);
});

test("day model: '-' → status unassigned (not off, not unknown), confirmed, source, no offSubtype; '--' is an unknown day with unknown-code evidence", () => {
  const snap = snapshotFor();
  const roster = buildRoster(snap, PROFILE, NOW_UNASSIGNED);
  const days = buildDays(snap, roster, PROFILE, NOW_UNASSIGNED, { from: '2026-10-04', count: 25 });
  const by = Object.fromEntries(days.map((d) => [d.date, d]));
  const u = by['2026-10-19'];
  assert.deepEqual([u.status, u.confidence, u.provenance, u.evidence], ['unassigned', 'confirmed', 'source', null]);
  assert.equal('offSubtype' in u, false);
  assert.equal(u.protected, undefined);
  assert.equal(u.window.kind, 'unassigned');
  assert.deepEqual([by['2026-10-20'].status, by['2026-10-20'].evidence], ['unknown', 'nothing-rostered']);
  assert.deepEqual([by['2026-10-22'].status, by['2026-10-22'].offSubtype, by['2026-10-22'].protected], ['off', 'ort', true]);
  assert.equal(by['2026-10-21'].status, 'standby');
  // A day with nothing rostered next to it stays unknown, never unassigned.
  assert.equal(by['2026-10-23'].status, 'unknown');
  // '--': an unrecognised code, shown as unknown with its code, never unassigned and never off.
  const sd = snapshotFor(PROFILE, payloadDouble);
  const dd = buildDays(sd, buildRoster(sd, PROFILE, NOW_UNASSIGNED), PROFILE, NOW_UNASSIGNED, { from: '2026-10-19', count: 3 });
  assert.deepEqual([dd[0].status, dd[1].status, dd[1].evidence, dd[1].label, dd[1].offSubtype], ['unassigned', 'unknown', 'unknown-code', '--', undefined]);
});

test('day model: an unassigned day outranks an inferred layover but not a flight, standby or reserve', () => {
  const window = (kind) => ({ kind, start: Date.parse('2026-10-19T00:00:00Z'), end: Date.parse('2026-10-20T00:00:00Z'), label: 'x', provenance: 'source' });
  const base = snapshotFor();
  const make = (windows) => ({ ...base, windows, sectors: [], unknownEvents: [], dayStates: {}, coverageEnd: '2026-11-02' });
  const status = (windows) => { const s = make(windows); const r = buildRoster(s, PROFILE, NOW_UNASSIGNED); return buildDays(s, r, PROFILE, NOW_UNASSIGNED, { from: '2026-10-19', count: 1 })[0].status; };
  assert.equal(status([window('unassigned')]), 'unassigned');
  assert.equal(status([window('unassigned'), window('standby')]), 'standby');
  assert.equal(status([window('unassigned'), window('reserve')]), 'reserve');
  assert.equal(status([window('off'), window('unassigned')]), 'unassigned', 'unassigned ranks above off');
  assert.equal(status([window('unassigned'), window('layover')]), 'layover', 'a stated layover keeps its rank');
});

test('state engine: today on a Strichtag is status unassigned with the airline reason; never off', () => {
  const snap = snapshotFor();
  const roster = buildRoster(snap, PROFILE, NOW_UNASSIGNED);
  const state = deriveState(snap, roster, PROFILE, NOW_UNASSIGNED);
  assert.deepEqual([state.status, state.confidence, state.provenance, state.phase], ['unassigned', 'confirmed', 'source', 'unassigned']);
  assert.deepEqual(state.reasons, ['The roster lists today as STRICHTAG: no duty is assigned. This is not a day off.']);
  assert.equal(state.offSubtype, undefined);
  assert.notEqual(state.status, 'off');
  const generic = deriveState(snapshotFor(GENERIC_PROFILE), buildRoster(snapshotFor(GENERIC_PROFILE), GENERIC_PROFILE, NOW_UNASSIGNED), GENERIC_PROFILE, NOW_UNASSIGNED);
  assert.equal(generic.status, 'unassigned');
  assert.deepEqual(generic.reasons, ['The roster lists today as unassigned: no duty is assigned. This is not a day off.']);
});

test('state engine: nextEvent never reports an unassigned day beginning or ending', () => {
  const snap = snapshotFor();
  const roster = buildRoster(snap, PROFILE, NOW_UNASSIGNED);
  for (const iso of ['2026-10-18T12:00:00Z', '2026-10-19T09:00:00Z', '2026-10-19T23:00:00Z']) {
    const now = Date.parse(iso);
    const st = deriveState(snap, roster, PROFILE, now);
    assert.ok(st.nextEvent, iso);
    assert.doesNotMatch(st.nextEvent.kind, /unassigned/, iso);
    assert.doesNotMatch(st.nextEvent.label, /unassigned|strichtag/i, iso);
  }
  // Before the Strichtag the next event is the SB90S window, not the Strichtag.
  assert.equal(deriveState(snap, roster, PROFILE, Date.parse('2026-10-18T12:00:00Z')).nextEvent.kind, 'standby-start');
});

test('month summary: unassignedDays counts it and offDays excludes it', () => {
  const snap = snapshotFor();
  const roster = buildRoster(snap, PROFILE, NOW_UNASSIGNED);
  const m = buildMonth(snap, roster, PROFILE, NOW_UNASSIGNED, '2026-10');
  const without = { ...snap, windows: snap.windows.filter((w) => w.kind !== 'unassigned') };
  const m0 = buildMonth(without, buildRoster(without, PROFILE, NOW_UNASSIGNED), PROFILE, NOW_UNASSIGNED, '2026-10');
  assert.equal(m0.summary.unassignedDays, 0);
  assert.equal(m.summary.offDays, m0.summary.offDays, 'a Strichtag is never counted as off');
  assert.equal(m.summary.unassignedDays, 1, "the '-' day (today)");
  assert.equal(m.summary.offDays, 2, 'ORT (22 Oct) and leave (25 Oct): the explicit rest days; the dash day (19 Oct) is not one');
});

// --- 5. Rendering ---------------------------------------------------------------------

function view(profile, now = NOW_UNASSIGNED, p = payload) {
  const snapshot = adaptV2(p, { profile, fetchedAt: now });
  const roster = buildRoster(snapshot, profile, now);
  const state = deriveState(snapshot, roster, profile, now);
  return { roster, state, snapshot, profile, now, review: false, loading: false, warnings: [], toneOverride: null, mode: { kind: 'production' } };
}
const renderCal = (profile, selected = '2026-10-19', p = payload) => { resetCalendarUi('2026-10', selected); return calendar.render({ view: () => view(profile, NOW_UNASSIGNED, p) }).toString(); };
const renderToday = (profile, p = payload) => todayScreen.render({ view: () => view(profile, NOW_UNASSIGNED, p), weather: () => null }).toString();
const textOf = (markup) => markup.replace(/<[^>]*>/g, ' ');
const cellOf = (markup, date) => markup.match(new RegExp(`<button[^>]*data-date="${date}"[\\s\\S]*?</button>`))[0];

test('Condor profile renders the compact STR in the calendar cell, key and week strip; the full STRICHTAG / Strichtag elsewhere', () => {
  const cal = renderCal(PROFILE);
  assert.match(cal, /cal-code tok-unassigned" aria-hidden="true">STR</);
  assert.doesNotMatch(cal, /tok-unassigned" aria-hidden="true">STRICHTAG</, 'the long word is not a cell code any more');
  assert.match(cal, /cal-key-item key-unassigned"><span class="cal-key-sample" aria-hidden="true">STR<\/span>STR · STRICHTAG · unassigned day, not off</);
  assert.match(cal, /<h2 class="t-title-2" id="cal-detail-title">Strichtag<\/h2>/);
  assert.match(cal, /<p class="t-eyebrow">Strichtag · from roster<\/p>/);
  assert.match(cal, /aria-label="Today, [^"]*: Strichtag, confirmed"/);
  assert.match(cal, /<li><span class="t-tabular">1<\/span> Strichtage<\/li>/);
  assert.match(cal, /status-pill" data-confidence="confirmed">Confirmed</);
  const today = renderToday(PROFILE);
  assert.match(today, /<span class="t-eyebrow">Strichtag<\/span>/);
  assert.match(today, /<h2 class="pass-state t-display" id="status-title">STRICHTAG<\/h2>/);
  assert.match(today, /Next duty/, 'the next known duty is still shown');
  assert.match(today, /week-day is-unassigned[^>]*aria-label="Today, [^"]*: Strichtag"/);
  assert.match(today, /<span class="week-code" aria-hidden="true">STR<\/span>/);
  assert.doesNotMatch(today, /week-code" aria-hidden="true">STRICHTAG</);
  // Screen readers get the full name, never only the abbreviation.
  assert.doesNotMatch(cellOf(cal, '2026-10-19').match(/aria-label="([^"]*)"/)[1], /\bSTR\b/);
});

test('generic profile renders UNAS / Unassigned day / UNASG and never STRICHTAG, STR or Strichtag', () => {
  const cal = renderCal(GENERIC_PROFILE);
  assert.match(cal, /cal-code tok-unassigned" aria-hidden="true">UNAS</);
  assert.match(cal, /cal-key-item key-unassigned"><span class="cal-key-sample" aria-hidden="true">UNAS<\/span>UNAS · unassigned day, not off</);
  assert.match(cal, /id="cal-detail-title">Unassigned day</);
  assert.match(cal, /Unassigned day · from roster/);
  assert.match(cal, /<li><span class="t-tabular">1<\/span> unassigned<\/li>/);
  const today = renderToday(GENERIC_PROFILE);
  assert.match(today, /<span class="t-eyebrow">Unassigned day<\/span>/);
  assert.match(today, /id="status-title">UNASG</);
  assert.match(today, /<span class="week-code" aria-hidden="true">UNAS<\/span>/);
  for (const markup of [cal, today]) {
    assert.doesNotMatch(markup, /strichtag/i);
    assert.doesNotMatch(textOf(markup), /\bSTR\b/);
    assert.doesNotMatch(markup, /tok-unassigned" aria-hidden="true">STR</);
  }
});

test("the roster symbol '-' is never rendered for an unassigned day (cell, label, detail, Today, week strip)", () => {
  for (const profile of [PROFILE, GENERIC_PROFILE]) {
    const code = airlineOf(profile).terminology.unassigned.cell;
    for (const markup of [renderCal(profile), renderCal(profile, '2026-10-20'), renderToday(profile)]) {
      assert.doesNotMatch(markup, />\s*-\s*</, 'no element whose text is a lone dash');
    }
    const cell = cellOf(renderCal(profile), '2026-10-19');
    assert.match(cell, new RegExp(`<span class="cal-code tok-unassigned" aria-hidden="true">${code}</span>`));
    assert.doesNotMatch(cell.match(/aria-label="([^"]*)"/)[1], /: -[,\s]|: -$/);
    const v = view(profile);
    const strip = weekView(v.roster.days.filter((d) => d.status === 'unassigned'), profile.homeTz, airlineOf(profile).terminology).toString();
    assert.match(strip, new RegExp(`<span class="week-code" aria-hidden="true">${code}</span>`));
    assert.doesNotMatch(strip, />\s*-\s*</);
  }
});

test("a '-' day is not in Today's rest/off lists and is not counted as an off day", () => {
  const today = renderToday(PROFILE);
  const rest = today.match(/<h2 class="t-eyebrow">Rest<\/h2>[\s\S]*?<\/section>/)[0];
  assert.match(textOf(rest), /22 Oct/, 'the ORT day is listed');
  assert.doesNotMatch(textOf(rest), /19 Oct/, 'the dash day (today) is not listed as rest');
  const v = view(PROFILE);
  assert.ok(!v.snapshot.windows.some((w) => w.kind === 'off' && w.label === '-'));
  assert.notEqual(v.state.status, 'off');
  assert.notEqual(v.state.offSubtype, 'free');
});

test("'--' is shown as unknown (never Strichtag, off or duty); 'XYZ' likewise", () => {
  const pd = payloadDouble;
  const cal = renderCal(PROFILE, '2026-10-20', pd);
  const cell = cellOf(cal, '2026-10-20');
  assert.match(cell, /cal-day is-unknown/);
  assert.doesNotMatch(cell, /tok-unassigned|is-unassigned|tok-off/);
  assert.match(cell.match(/aria-label="([^"]*)"/)[1], /Unknown/);
  const label = cell.match(/aria-label="([^"]*)"/)[1];
  assert.match(label, /^Tue 20 Oct: Unknown --: The roster lists a code Flight Control does not recognise/);
  assert.doesNotMatch(label, /Strichtag/);
  // The unassigned day next to it is still Strichtag.
  assert.match(cellOf(cal, '2026-10-19'), /tok-unassigned" aria-hidden="true">STR</);
  const v = view(PROFILE, NOW_UNASSIGNED, pd);
  const strip = weekView(v.roster.days.filter((d) => d.date === '2026-10-20'), PROFILE.homeTz, airlineOf(PROFILE).terminology).toString();
  assert.match(strip, /week-day is-unknown/);
  assert.doesNotMatch(strip, /is-unassigned|>STR</);
  // 'XYZ' goes the same way.
  const px = backendRoster(extendedFeed({ withUnknown: false, extra: [dayEv('XYZ', '2026-10-26T23:00:00Z', '2026-10-27T23:00:00Z')] }));
  const xcell = cellOf(renderCal(PROFILE, '2026-10-27', px), '2026-10-27');
  assert.match(xcell, /cal-day is-unknown/);
  assert.doesNotMatch(xcell, /tok-unassigned|tok-off/);
});

test('Strichtag cells carry no off styling: tok-unassigned, never tok-off / tok-ort, and the day is not described as off', () => {
  const cal = renderCal(PROFILE);
  const cell = cellOf(cal, '2026-10-19');
  assert.match(cell, /cal-day is-unassigned/);
  assert.doesNotMatch(cell, /tok-off|tok-ort|is-off/);
  const label = cell.match(/aria-label="([^"]*)"/)[1];
  assert.match(label, /: Strichtag, confirmed$/);
  assert.doesNotMatch(label, /\boff\b|\bfree\b/i);
});

test('CSS: the compact code needs no shrink rule; the unassigned marks are outlined and hatched, unlike the unknown and off marks', () => {
  const screens = readFileSync(join(ROOT, 'assets/css/screens.css'), 'utf8');
  const components = readFileSync(join(ROOT, 'assets/css/components.css'), 'utf8');
  // No size hacks for a long word any more: STR / UNAS use the shared capsule size of SB / RE / OFF.
  assert.doesNotMatch(screens, /font-size:\s*7px/);
  // STR / UNAS carry exactly the shared SB / RE / OFF capsule metrics (own rule, so the shared marker rule stays at baseline).
  const shared = screens.match(/^\.cal-code\.tok-sb, \.cal-code\.tok-re, \.cal-code\.tok-off \{[^}]*\}/m)[0];
  const token = screens.match(/^\.cal-code\.tok-unassigned \{[^}]*\}/m)[0];
  for (const prop of ['min-width: 30px', 'border-radius: 9px', 'font-size: 10.5px', 'letter-spacing: 0.06em']) {
    assert.ok(shared.includes(prop), `shared capsule has ${prop}`);
    assert.ok(token.includes(prop), `unassigned capsule has ${prop}`);
    const name = prop.split(':')[0];
    assert.equal(token.split(`${name}:`).length - 1, 1, `unassigned capsule declares ${name} exactly once (no override)`);
  }
  assert.doesNotMatch(token, /text-overflow|ellipsis/);
  assert.doesNotMatch(screens, /\.week-day\.is-unassigned \.week-code/);
  assert.match(screens, /\.key-unassigned \.cal-key-sample/);
  // Week strip: outlined + hatched capsule, taller than the 3 px bars.
  const mark = screens.match(/\.week-day\.is-unassigned \.week-mark \{[^}]*\}/)[0];
  assert.match(mark, /repeating-linear-gradient/);
  assert.match(mark, /box-shadow: inset 0 0 0 1px/);
  assert.match(mark, /height: 7px/);
  const unknownMark = components.match(/\.week-day\.is-unknown \.week-mark \{[^}]*\}/)[0];
  assert.doesNotMatch(unknownMark, /repeating-linear-gradient|height/, 'the unknown mark stays a plain thin outline');
  const offMark = components.match(/\.week-day\.is-off \.week-mark \{[^}]*\}/)[0];
  assert.doesNotMatch(offMark, /repeating-linear-gradient/);
});

// --- Repo scans -----------------------------------------------------------------------

function walk(dir, hits, test) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, hits, test);
    else if (/\.(js|mjs|gs)$/.test(name) && test(readFileSync(p, 'utf8'))) hits.push(p.slice(ROOT.length + 1));
  }
}

test('core carries no Strichtag wording and no dash roster-code literal used for classification (comments included)', () => {
  // '-' appears legitimately all over core (route strings 'FRA-PMI', ranges, joins), so the dash scan is scoped to
  // classification positions only: a comparison, switch case, `exact:` entry or membership test against a lone
  // '-' / '--' literal. A bare '--' literal anywhere in core is also refused (it has no legitimate use there).
  const classify = /(?:[!=]==?|\bcase|\bexact\s*:|\.includes\(|\.has\(|\bindexOf\()\s*(['"`])-{1,2}\1|(['"`])--\2/;
  const strichtag = [];
  const literal = [];
  // All of src/ is core except the airline packs (src/airlines/), which own codes and wording.
  walk(join(ROOT, 'src'), strichtag, (t) => /strichtag/i.test(t));
  walk(join(ROOT, 'src'), literal, (t) => classify.test(t));
  const inPack = (p) => p.startsWith('src/airlines/');
  strichtag.splice(0, strichtag.length, ...strichtag.filter((p) => !inPack(p)));
  literal.splice(0, literal.length, ...literal.filter((p) => !inPack(p)));
  const backend = join(ROOT, 'backend/apps-script/RosterModelV2.gs');
  const bt = readFileSync(backend, 'utf8');
  if (/strichtag/i.test(bt)) strichtag.push('backend/apps-script/RosterModelV2.gs');
  if (classify.test(bt)) literal.push('backend/apps-script/RosterModelV2.gs');
  assert.deepEqual(strichtag, []);
  assert.deepEqual(literal, []);
  // The scan really detects what it claims to (guards against a regex that matches nothing).
  for (const bad of ["if (title === '-') {", "case '-':", "{ exact: '-' }", "x.includes('-')", 'const d = "--";']) assert.ok(classify.test(bad), bad);
  for (const ok of ["const r = 'FRA-PMI';", "a.split('-')", "parts.join('-')", "x ? '—' : ''"]) assert.ok(!classify.test(ok), ok);
});
