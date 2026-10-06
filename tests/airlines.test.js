// Airline registry: Condor pack, generic fallback, profile migration, and the guarantee that
// core (model/ui) carries no airline terminology.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAirline, airlineOf, AIRLINE_IDS } from '../src/airlines/index.js';
import { normalizeProfile } from '../src/config/profile.js';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { request } from '../src/sources/contract-v2.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { buildRoster } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { PROFILE } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('getAirline: Condor by id, generic for unknown or missing ids', () => {
  const condor = getAirline('condor');
  assert.equal(condor.id, 'condor');
  assert.equal(condor.iata, 'DE');
  assert.equal(getAirline('nope').id, 'generic');
  assert.equal(getAirline(undefined).id, 'generic');
  assert.equal(getAirline(null).id, 'generic');
  assert.equal(getAirline('toString').id, 'generic', 'prototype keys are not airlines');
  assert.equal(getAirline('generic').iata, null);
});

test('profiles are deep-frozen', () => {
  for (const id of ['condor', 'nope']) {
    const a = getAirline(id);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.terminology) && Object.isFrozen(a.terminology.offSubtype));
    assert.ok(Object.isFrozen(a.terminology.offSubtype.ort));
    assert.throws(() => { a.name = 'x'; }, TypeError);
    assert.throws(() => { a.terminology.offSubtype.ort.short = 'x'; }, TypeError);
  }
});

test('unassigned wording: Condor says Strichtag, generic stays neutral, neither claims the day can be assigned or mentions hours', () => {
  const c = getAirline('condor').terminology.unassigned;
  const g = getAirline('generic').terminology.unassigned;
  assert.deepEqual({ ...c }, { short: 'STRICHTAG', cell: 'STR', name: 'Strichtag', legend: 'STR · STRICHTAG · unassigned day, not off', reason: 'The roster lists today as STRICHTAG: no duty is assigned. This is not a day off.', summary: 'Strichtage' });
  assert.deepEqual({ ...g }, { short: 'UNASG', cell: 'UNAS', name: 'Unassigned day', legend: 'UNAS · unassigned day, not off', reason: 'The roster lists today as unassigned: no duty is assigned. This is not a day off.', summary: 'unassigned' });
  assert.doesNotMatch(JSON.stringify(g), /strichtag|\bSTR\b/i);
  for (const t of [c, g]) assert.match(t.cell, /^[A-Z]{3,4}$/, 'the compact code is short enough for a 7-column cell at the normal code size');
  for (const t of [c, g]) assert.doesNotMatch(JSON.stringify(t), /\b48\b|hours?\b|can still|convert/i);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(g));
});

test('generic terminology carries no ORT; Condor keeps its own wording', () => {
  assert.doesNotMatch(JSON.stringify(getAirline('generic')), /ORT/);
  assert.equal(getAirline('generic').terminology.offSubtype.ort.short, 'PROT');
  const t = getAirline('condor').terminology;
  assert.equal(t.offSubtype.ort.short, 'ORT');
  assert.equal(t.offSubtype.ort.name, 'Protected free day');
});

test('every pack and the generic fallback supply all terminology the Today/Calendar UI reads', () => {
  assert.ok(AIRLINE_IDS.includes('condor'));
  assert.ok(Object.isFrozen(AIRLINE_IDS));
  const text = (v, what) => assert.ok(typeof v === 'string' && v.trim().length > 0, what);
  for (const id of [...AIRLINE_IDS, 'generic']) {
    const pack = getAirline(id);
    assert.equal(pack.id, id);
    const t = pack.terminology;
    // calendar.js and today.js read short + name for these four subtypes unconditionally.
    for (const sub of ['off', 'free', 'leave', 'ort']) {
      text(t.offSubtype?.[sub]?.short, `${id}: offSubtype.${sub}.short`);
      text(t.offSubtype?.[sub]?.name, `${id}: offSubtype.${sub}.name`);
      if ('detail' in t.offSubtype[sub]) text(t.offSubtype[sub].detail, `${id}: offSubtype.${sub}.detail is optional but never empty`);
    }
    text(t.protectedLegend, `${id}: protectedLegend`);
    text(t.protectedEyebrow, `${id}: protectedEyebrow`);
    text(t.protectedReason, `${id}: protectedReason`);
    // today.js, calendar.js, week.js and the state engine read all six for an unassigned day.
    for (const field of ['short', 'cell', 'name', 'legend', 'reason', 'summary']) text(t.unassigned?.[field], `${id}: unassigned.${field}`);
  }
});

test('profile: Condor by default, legacy airlineAdapter migrates, invalid ids fall back', () => {
  assert.equal(airlineOf(normalizeProfile({})).id, 'condor');
  assert.equal(normalizeProfile({}).airlineId, 'condor');
  assert.equal(normalizeProfile({ airlineAdapter: 'condor' }).airlineId, 'condor');
  assert.equal('airlineAdapter' in normalizeProfile({ airlineAdapter: 'condor' }), false);
  assert.equal(normalizeProfile({ airlineId: 'eurowings' }).airlineId, 'eurowings');
  assert.equal(airlineOf(normalizeProfile({ airlineId: 'eurowings' })).id, 'generic');
  for (const bad of ['Condor', 'a b', '', 'x'.repeat(33), 7, {}]) {
    assert.equal(normalizeProfile({ airlineId: bad }).airlineId, 'condor', `invalid: ${String(bad)}`);
  }
  assert.equal(airlineOf(undefined).id, 'generic');
});

test('core carries no ORT terminology (src/model and src/ui, comments included)', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(name) && /\bORT\b/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'src/model'));
  walk(join(ROOT, 'src/ui'));
  assert.deepEqual(offenders, []);
});

// --- Rendering: the airline profile decides the wording ---------------------------------

const gs = loadGs();
const feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const payload = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify(request('roster', 'test-token-0123456789abcdef', { action: 'roster' })), env)));
const GENERIC_PROFILE = normalizeProfile({ ...PROFILE, airlineId: 'generic' });

function views(profile) {
  const snapshot = adaptV2(payload, { profile, fetchedAt: NOW });
  const roster = buildRoster(snapshot, profile, NOW);
  const state = deriveState(snapshot, roster, profile, NOW);
  return { roster, state, snapshot, profile, now: NOW, review: false, loading: false, warnings: [], toneOverride: null, mode: { kind: 'production' } };
}
function renderCalendar(profile) {
  resetCalendarUi('2026-10', '2026-10-04');
  const view = views(profile);
  return calendar.render({ view: () => view }).toString();
}

test('Condor profile renders ORT in calendar, key, detail and Today', () => {
  const cal = renderCalendar(PROFILE);
  assert.match(cal, /cal-code tok-off tok-ort" aria-hidden="true">ORT</);
  assert.match(cal, /Protected free day \(ORT, protected\)/);
  assert.match(cal, /ORT · protected free day/);
  assert.match(cal, /ORT · from roster/);
  const view = views(PROFILE);
  assert.match(view.state.reasons[0], /protected free day \(ORT\)/);
  const html = todayScreen.render({ view: () => view }).toString();
  assert.match(html, /Protected free day[\s\S]*>ORT</);
});

test('generic profile renders PROT and no ORT anywhere', () => {
  const cal = renderCalendar(GENERIC_PROFILE);
  assert.match(cal, /cal-code tok-off tok-ort" aria-hidden="true">PROT</);
  assert.match(cal, /PROT · protected free day/);
  assert.doesNotMatch(cal, /\bORT\b/);
  const view = views(GENERIC_PROFILE);
  assert.doesNotMatch(view.state.reasons[0], /ORT/);
  assert.match(view.state.reasons[0], /protected free day/);
  const html = todayScreen.render({ view: () => view }).toString();
  assert.match(html, /Protected free day[\s\S]*>PROT</);
  assert.doesNotMatch(html, /\bORT\b/);
});
