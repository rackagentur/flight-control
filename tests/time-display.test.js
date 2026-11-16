// Step 6.5: the global Time Display preference (Local | UTC) and the one shared formatting layer.
// Local = each operational time in the zone of the place it belongs to (never the device zone);
// UTC = every operational time in UTC. The preference changes the representation only, never the instant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.js';
import {
  createTimeDisplay, setTimeDisplay, getTimeDisplay, TIME_DISPLAY_KEY, TIME_DISPLAY_MODES,
} from '../src/time-display.js';
import { opTime, opTimeSpoken, opShift, opZoneNote, tzTag, opDate, eventLocalTime } from '../src/lib/op-time.js';
import { formatTime, offsetMinutes, localDateKey, dayShift } from '../src/lib/time.js';
import { clock, alarmLink, dutyFields, sectorList } from '../src/ui/duty.js';
import { sectorCard, sectorLabel, displayShift } from '../src/ui/flight-parts.js';
import { horizonView } from '../src/ui/horizon.js';
import { buildRadarView } from '../src/model/radar.js';
import { buildFlights } from '../src/model/flights.js';
import { adaptV2, adaptHistoryV2 } from '../src/sources/fc-appscript-v2.js';
import { timeDisplayControl } from '../src/ui/components.js';
import { flights as flightsScreen } from '../src/ui/screens/flights.js';
import { today } from '../src/ui/screens/today.js';
import { settings } from '../src/ui/screens/settings.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { PROFILE, fixtureSnapshot, pipeline } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const at = (iso) => Date.parse(iso);
const BERLIN = 'Europe/Berlin';
const TORONTO = 'America/Toronto';
const BANGKOK = 'Asia/Bangkok';

/** Runs `fn` with the module-level mode set, always restoring Local so no test leaks into another. */
function inMode(mode, fn) {
  setTimeDisplay(mode);
  try { return fn(); } finally { setTimeDisplay('local'); }
}

const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
};

/** The instant a displayed "HH:MM" denotes in `tz` on the date key (what a reader would reconstruct). */
function instantFrom(hhmm, tz, dateKey) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = dateKey.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let t = wall;
  for (let i = 0; i < 3; i += 1) t = wall - offsetMinutes(t, tz) * 60000;
  return t;
}

const sector = (over = {}) => ({
  id: 'S1', flightNumber: 'DE2074', origin: 'FRA', destination: 'YYZ',
  dep: at('2026-10-10T07:40:00Z'), arr: at('2026-10-10T16:20:00Z'), blockMin: 520,
  originTz: BERLIN, destTz: TORONTO, pickup: null, provenance: 'source', ...over,
});
const entryOf = (s, extra = {}) => ({ sector: s, shift: dayShift(s.dep, s.originTz, s.arr, s.destTz), status: 'upcoming', ...extra });

// --- Preference: default, persistence, validation ------------------------------------------------------

test('the modes are Local and UTC; the default is Local', () => {
  assert.deepEqual([...TIME_DISPLAY_MODES], ['local', 'utc']);
  assert.equal(createTimeDisplay(createStore(fakeStorage())).get(), 'local');
  assert.equal(getTimeDisplay(), 'local', 'the app-wide preference starts as Local');
});

test('UTC is persisted under its own key; Local removes the key; the choice survives a reload', () => {
  const storage = fakeStorage();
  const pref = createTimeDisplay(createStore(storage));
  assert.equal(pref.set('utc'), 'utc');
  assert.equal(storage.getItem(`fc.v2.${TIME_DISPLAY_KEY}`), 'utc');
  assert.equal(storage.getItem('fc.v2.theme'), null, 'the theme is a separate setting and is not touched');
  // A fresh instance over the same storage is a page reload.
  assert.equal(createTimeDisplay(createStore(storage)).get(), 'utc');
  assert.equal(pref.set('local'), 'local');
  assert.equal(storage.getItem(`fc.v2.${TIME_DISPLAY_KEY}`), null, 'Local is stored as no key');
  assert.equal(createTimeDisplay(createStore(storage)).get(), 'local');
});

test('an invalid stored value or an invalid request falls back to Local', () => {
  const storage = fakeStorage();
  storage.setItem(`fc.v2.${TIME_DISPLAY_KEY}`, 'device');
  const pref = createTimeDisplay(createStore(storage));
  assert.equal(pref.get(), 'local');
  pref.set('utc');
  assert.equal(pref.set('banana'), 'local');
  assert.equal(storage.getItem(`fc.v2.${TIME_DISPLAY_KEY}`), null);
  assert.equal(pref.get(), 'local');
});

test('a store that cannot persist still works for the session (Local default, in-memory switch)', () => {
  const pref = createTimeDisplay(createStore(null));
  assert.equal(pref.get(), 'local');
  pref.set('utc');
  assert.equal(pref.get(), 'utc');
});

test('apply() sets the root data attribute and announces fc:time-display; a storage event from another tab is followed', () => {
  const events = [];
  const listeners = {};
  const root = { dataset: {}, dispatchEvent: (e) => { events.push(e); return true; } };
  const savedDoc = globalThis.document;
  const savedAdd = globalThis.addEventListener;
  const savedRemove = globalThis.removeEventListener;
  globalThis.document = { documentElement: root };
  globalThis.addEventListener = (type, fn) => { listeners[type] = fn; };
  globalThis.removeEventListener = (type) => { delete listeners[type]; };
  try {
    const storage = fakeStorage();
    const pref = createTimeDisplay(createStore(storage));
    const stop = pref.watch();
    pref.set('utc');
    assert.equal(root.dataset.timeDisplay, 'utc');
    assert.equal(events.at(-1).type, 'fc:time-display');
    assert.equal(events.at(-1).detail.mode, 'utc');
    // Another tab switches back to Local (key removed).
    storage.removeItem(`fc.v2.${TIME_DISPLAY_KEY}`);
    listeners.storage({ key: `fc.v2.${TIME_DISPLAY_KEY}` });
    assert.equal(pref.get(), 'local');
    assert.equal(root.dataset.timeDisplay, 'local');
    listeners.storage({ key: 'fc.v2.theme' });
    assert.equal(events.filter((e) => e.type === 'fc:time-display').length, 2, 'an unrelated key does nothing');
    stop();
    assert.equal(listeners.storage, undefined);
  } finally {
    globalThis.document = savedDoc;
    globalThis.addEventListener = savedAdd;
    globalThis.removeEventListener = savedRemove;
  }
});

// --- Conversion: DST --------------------------------------------------------------------------------------

test('DST boundary Europe/Berlin 2026-10-25 (CEST to CET at 01:00 UTC): two different instants read 02:30 local, one UTC reading each', () => {
  const a = at('2026-10-25T00:30:00Z');
  const b = at('2026-10-25T01:30:00Z');
  assert.equal(opTime(a, BERLIN, 'local'), '02:30', '00:30 UTC is 02:30 CEST');
  assert.equal(opTime(b, BERLIN, 'local'), '02:30', '01:30 UTC is 02:30 CET (the repeated hour)');
  assert.equal(opTime(a, BERLIN, 'utc'), '00:30');
  assert.equal(opTime(b, BERLIN, 'utc'), '01:30');
  assert.notEqual(a, b);
  assert.equal(offsetMinutes(a, BERLIN), 120);
  assert.equal(offsetMinutes(b, BERLIN), 60);
  // The zone note in UTC mode tells the repeated 02:30 apart by its UTC reading, never by guessing.
  assert.equal(opZoneNote(a, BERLIN, PROFILE, 'utc'), '02:30 local');
  assert.equal(tzTag(a, BERLIN, b, BERLIN, 'local'), 'UTC+1', 'one zone but a different offset at the two instants: the arrival is tagged');
});

test('DST gap Europe/Berlin 2026-03-29 (CET to CEST at 01:00 UTC): local jumps 01:59 to 03:00, UTC does not', () => {
  const before = at('2026-03-29T00:59:00Z');
  const after = at('2026-03-29T01:00:00Z');
  assert.deepEqual([opTime(before, BERLIN, 'local'), opTime(after, BERLIN, 'local')], ['01:59', '03:00']);
  assert.deepEqual([opTime(before, BERLIN, 'utc'), opTime(after, BERLIN, 'utc')], ['00:59', '01:00']);
});

test('a duty that crosses the autumn change keeps its block length in both modes', () => {
  const dep = at('2026-10-25T00:30:00Z');
  const arr = at('2026-10-25T01:30:00Z');
  const s = sector({ origin: 'FRA', destination: 'MUC', originTz: BERLIN, destTz: BERLIN, dep, arr, blockMin: 60 });
  for (const mode of ['local', 'utc']) {
    const text = inMode(mode, () => sectorCard({ sector: s, entry: entryOf(s), href: null }).toString());
    assert.match(text, mode === 'local' ? /FRA<\/b> 02:30[\s\S]*MUC<\/b> 02:30/ : /FRA<\/b> 00:30[\s\S]*MUC<\/b> 01:30/);
    assert.match(text, /<span>1h<\/span>/);
  }
});

// --- Sectors that cross time zones -----------------------------------------------------------------------

test('FRA to YYZ: Local shows each end in its own airport zone, UTC shows both in UTC, the arrival offset is tagged only in Local', () => {
  const s = sector();
  assert.equal(opTime(s.dep, s.originTz, 'local'), '09:40', 'departure at Frankfurt (UTC+2)');
  assert.equal(opTime(s.arr, s.destTz, 'local'), '12:20', 'arrival at Toronto (UTC-4)');
  assert.equal(opTime(s.dep, s.originTz, 'utc'), '07:40');
  assert.equal(opTime(s.arr, s.destTz, 'utc'), '16:20');
  assert.equal(tzTag(s.dep, s.originTz, s.arr, s.destTz, 'local'), 'UTC−4');
  assert.equal(tzTag(s.dep, s.originTz, s.arr, s.destTz, 'utc'), null);
  assert.equal(opShift(s.dep, s.originTz, s.arr, s.destTz, 'local'), 0);
  assert.equal(opShift(s.dep, s.originTz, s.arr, s.destTz, 'utc'), 0);
  // Not the device zone: the answer is the same whatever TZ the process runs in (zones are always explicit).
  assert.equal(opTime(s.dep, s.originTz, 'local'), formatTime(s.dep, BERLIN));
});

test('the same zone on both ends carries no offset tag; zones that differ in offset only by DST on the day do', () => {
  const s = sector({ destination: 'MUC', destTz: BERLIN });
  assert.equal(tzTag(s.dep, s.originTz, s.arr, s.destTz, 'local'), null);
  // Berlin to London is one hour apart in October: tagged.
  assert.equal(tzTag(s.dep, BERLIN, s.arr, 'Europe/London', 'local'), 'UTC+1');
});

test('FRA to BKK (UTC+2 to UTC+7): Local and UTC give different wall clocks for the same two instants', () => {
  const dep = at('2026-10-10T21:30:00Z');
  const arr = at('2026-10-11T08:30:00Z');
  assert.deepEqual([opTime(dep, BERLIN, 'local'), opTime(arr, BANGKOK, 'local')], ['23:30', '15:30']);
  assert.deepEqual([opTime(dep, BERLIN, 'utc'), opTime(arr, BANGKOK, 'utc')], ['21:30', '08:30']);
  assert.equal(tzTag(dep, BERLIN, arr, BANGKOK, 'local'), 'UTC+7');
  assert.equal(opShift(dep, BERLIN, arr, BANGKOK, 'local'), 1);
  assert.equal(opShift(dep, BERLIN, arr, BANGKOK, 'utc'), 1);
});

test('the +N day mark follows the displayed dates: eastbound overnight cases where Local and UTC disagree', () => {
  // Leaves Frankfurt at 01:00 local on the 11th (23:00 UTC on the 10th) and lands in Bangkok at 17:00 on the 11th.
  const dep = at('2026-10-10T23:00:00Z');
  const arr = at('2026-10-11T10:00:00Z');
  assert.equal(opShift(dep, BERLIN, arr, BANGKOK, 'local'), 0, 'both on the 11th locally');
  assert.equal(opShift(dep, BERLIN, arr, BANGKOK, 'utc'), 1, 'the 10th to the 11th in UTC');
  // Leaves at 14:00 local, lands at 06:30 local next morning: +1 locally, same UTC day.
  const dep2 = at('2026-10-10T12:00:00Z');
  const arr2 = at('2026-10-10T23:30:00Z');
  assert.equal(opShift(dep2, BERLIN, arr2, BANGKOK, 'local'), 1);
  assert.equal(opShift(dep2, BERLIN, arr2, BANGKOK, 'utc'), 0);
  // The sector card reads the mode: the mark appears and disappears with the displayed dates.
  const s = sector({ destination: 'BKK', destTz: BANGKOK, dep: dep2, arr: arr2 });
  const e = entryOf(s);
  assert.equal(e.shift, 1, 'the roster model keeps the local-date value');
  const local = inMode('local', () => sectorCard({ sector: s, entry: e, href: null }).toString());
  const utc = inMode('utc', () => sectorCard({ sector: s, entry: e, href: null }).toString());
  assert.match(local, /pass-shift/);
  assert.doesNotMatch(utc, /pass-shift/);
  assert.equal(displayShift(e, s, 'local'), 1);
  assert.equal(displayShift(e, s, 'utc'), 0);
  assert.match(inMode('local', () => sectorLabel(e, s)), /\(\+1 day\)/);
  assert.doesNotMatch(inMode('utc', () => sectorLabel(e, s)), /day\)/);
});

// --- Switching: representation changes, the event does not ----------------------------------------------

test('Local to UTC to Local: the text changes, the represented instant and the model never do', () => {
  const s = Object.freeze(sector());
  const e = Object.freeze(entryOf(s));
  const before = JSON.stringify([s, e]);

  const render = (mode) => inMode(mode, () => sectorCard({ sector: s, entry: e, href: null }).toString());
  const local = render('local');
  const utc = render('utc');
  const localAgain = render('local');
  assert.equal(local, localAgain, 'switching back restores exactly the Local rendering');
  assert.notEqual(local, utc);
  assert.match(local, /<b>FRA<\/b> 09:40/);
  assert.match(utc, /<b>FRA<\/b> 07:40/);
  assert.match(local, /<b>YYZ<\/b> 12:20/);
  assert.match(utc, /<b>YYZ<\/b> 16:20/);

  // Read the displayed clock back and rebuild the instant: it is the same one in both modes.
  const readBack = (text, mode) => {
    const dep = /<b>FRA<\/b> (\d\d:\d\d)/.exec(text)[1];
    const arr = /<b>YYZ<\/b> (\d\d:\d\d)/.exec(text)[1];
    return mode === 'utc'
      ? [instantFrom(dep, 'UTC', '2026-10-10'), instantFrom(arr, 'UTC', '2026-10-10')]
      : [instantFrom(dep, BERLIN, '2026-10-10'), instantFrom(arr, TORONTO, '2026-10-10')];
  };
  assert.deepEqual(readBack(local, 'local'), [s.dep, s.arr]);
  assert.deepEqual(readBack(utc, 'utc'), [s.dep, s.arr]);
  assert.equal(JSON.stringify([s, e]), before, 'rendering in either mode leaves the data untouched');
});

test('the Flights screen re-renders from the same snapshot in both modes with the same instants', () => {
  const snap = fixtureSnapshot();
  const frozenBefore = JSON.stringify(snap.sectors);
  const v = pipeline(snap, '2026-10-04T06:00:00Z');
  const view = { ...v, profile: PROFILE, snapshot: snap, review: false, loading: false, error: null };
  const ctx = { view: () => view, param: () => null, weather: () => ({ status: 'unavailable', reason: 'no-destination' }) };
  const local = inMode('local', () => flightsScreen.render(ctx).toString());
  const utc = inMode('utc', () => flightsScreen.render(ctx).toString());
  // The fixture's first sector: FRA 09:40 CEST = 07:40 UTC, to YYZ 12:20 EDT = 16:20 UTC.
  assert.match(local, /<b>FRA<\/b> 09:40/);
  assert.match(utc, /<b>FRA<\/b> 07:40/);
  assert.match(local, /<b>YYZ<\/b> 12:20<\/span>/, "the route line stays one line: no tag beside the time");
  assert.match(local, /<span class="tz-tag">arr. UTC−4<\/span>/, "arrival zone context sits in the card sub-line");
  assert.match(utc, /<b>YYZ<\/b> 16:20<\/span>/);
  assert.doesNotMatch(utc, /tz-tag/, 'no per-sector offset tag in UTC');
  assert.match(utc, /class="tz-mode" aria-hidden="true">UTC</, 'the UTC chip is in the block header (CSS shows it only in UTC mode)');
  assert.equal(JSON.stringify(snap.sectors), frozenBefore);
});

test('Flight detail: wake-up and pickup follow the mode, notes follow the mode, dates stay', () => {
  const snap = fixtureSnapshot();
  const v = pipeline(snap, '2026-10-04T06:00:00Z');
  const view = { ...v, profile: PROFILE, snapshot: snap, review: false, loading: false, error: null };
  const f = buildFlights(snap, v.roster, v.state, PROFILE, v.now);
  const id = f.upcoming[0].sectors[0].sector.id;
  const ctx = { view: () => view, param: () => id, weather: () => ({ status: 'unavailable', reason: 'no-destination' }) };
  const local = inMode('local', () => flightsScreen.render(ctx).toString());
  const utc = inMode('utc', () => flightsScreen.render(ctx).toString());
  const timing = (html) => html.slice(html.indexOf('id="fl-timing"'), html.indexOf('fl-facts'));
  assert.match(timing(local), /UTC−4 · \d\d:\d\d at home/, 'Local keeps the offset note');
  assert.match(timing(utc), /12:20 local/, 'UTC says what the clock reads where it happens');
  assert.doesNotMatch(timing(utc), /at home/);
  assert.match(timing(utc), /Sat 10 Oct/, 'dates are the same in both modes');
  assert.match(timing(local), /Sat 10 Oct/);
});

test('Today: the pass times follow the mode', () => {
  const snap = fixtureSnapshot();
  const v = pipeline(snap, '2026-10-10T05:00:00Z');
  const view = { ...v, profile: PROFILE, snapshot: snap, review: false, loading: false, error: null };
  const ctx = { view: () => view, weather: () => ({ status: 'unavailable', reason: 'no-destination' }) };
  const local = inMode('local', () => today.render(ctx).toString());
  const utc = inMode('utc', () => today.render(ctx).toString());
  assert.match(local, /pass-fields/);
  assert.match(local, /09:40/);
  assert.match(utc, /07:40/);
  assert.doesNotMatch(utc, /<dd>09:40/);
  assert.match(utc, /class="tz-mode"/);
});

test('Calendar: day-detail flights, wake-up and pickup follow the mode; the month cell marks UTC with a Z', () => {
  const snap = fixtureSnapshot();
  const v = pipeline(snap, '2026-10-04T08:00:00Z');
  const view = { ...v, profile: PROFILE, snapshot: snap, review: false, loading: false, error: null };
  const show = (mode) => inMode(mode, () => { resetCalendarUi('2026-10', '2026-10-10'); return calendar.render({ view: () => view }).toString(); });
  const local = show('local');
  const utc = show('utc');
  const detail = (html) => html.slice(html.indexOf('cal-detail-card'));
  assert.match(detail(local), /<b>FRA<\/b> 09:40/);
  assert.match(detail(utc), /<b>FRA<\/b> 07:40/);
  assert.match(detail(utc), /class="tz-mode" aria-hidden="true">UTC</, 'one chip on the flights eyebrow');
  const cell = (html) => /data-date="2026-10-10"[\s\S]*?cal-sub t-tabular" aria-hidden="true">([^<]*)</.exec(html)[1];
  assert.equal(cell(local), 'FRA 09:40');
  assert.equal(cell(utc), 'FRA 07:40Z');
  const wake = (html) => /Wake-up <b>([^<]*)</.exec(detail(html))?.[1];
  if (wake(local)) assert.notEqual(wake(local), wake(utc), 'the wake-up reads differently, for the same instant');
});

// --- Unknown zones: nothing is guessed --------------------------------------------------------------------

test('an unknown zone is never guessed: Local says UTC out loud, UTC mode needs no marker, no zone note is invented', () => {
  const ms = at('2026-10-10T07:40:00Z');
  assert.equal(opTime(ms, null, 'local'), '07:40 UTC');
  assert.equal(opTime(ms, undefined, 'local'), '07:40 UTC');
  assert.equal(opTime(ms, 'Not/AZone', 'local'), '07:40 UTC', 'an invalid zone is treated as unknown');
  assert.equal(opTime(ms, null, 'local', { compact: true }), '07:40Z');
  assert.equal(opTime(ms, null, 'utc'), '07:40');
  assert.equal(opTime(ms, BERLIN, 'utc', { zulu: true }), '07:40Z');
  assert.equal(opTimeSpoken(ms, BERLIN, 'utc'), '07:40 UTC');
  assert.equal(opTimeSpoken(ms, null, 'local'), '07:40 UTC');
  assert.equal(opZoneNote(ms, null, PROFILE, 'local'), 'Time zone unknown (UTC shown)');
  assert.equal(opZoneNote(ms, null, PROFILE, 'utc'), null);
  assert.equal(tzTag(ms, null, ms + 3600000, TORONTO, 'local'), null);
  assert.equal(opShift(ms, null, ms + 3600000, TORONTO, 'local'), null, 'a date shift needs both zones in Local');
  assert.equal(opShift(ms, null, ms + 3600000, TORONTO, 'utc'), 0, 'in UTC it is always known');
  assert.equal(eventLocalTime(ms, null), null);
  assert.equal(opDate(ms, null, 'local'), opDate(ms, 'UTC', 'local'));
  assert.equal(opTime(Number.NaN, BERLIN, 'local'), null, 'a non-finite instant yields null, never a made-up time');
});

test('clock() is a thin wrapper over the shared layer', () => {
  const ms = at('2026-10-10T07:40:00Z');
  assert.equal(clock(ms, BERLIN, 'local'), opTime(ms, BERLIN, 'local'));
  assert.equal(clock(ms, BERLIN, 'utc'), '07:40');
  assert.equal(clock(ms, null, 'local'), '07:40 UTC');
  inMode('utc', () => assert.equal(clock(ms, BERLIN), '07:40'));
  assert.equal(clock(ms, BERLIN), '09:40');
});

// --- Alarms: the visible text follows the mode, the payload never does -------------------------------------

const payloadOf = (link) => decodeURIComponent(/text=([^"]*)"/.exec(link.toString())[1]);
const visibleOf = (link) => />([^<]*)<\/a>$/.exec(link.toString())[1];

test('alarmLink: the Shortcut always receives the event-zone wall clock, in Local and in UTC mode', () => {
  const pickup = at('2026-10-10T05:45:00Z'); // 07:45 at Frankfurt
  const local = alarmLink(PROFILE, pickup, BERLIN, 'pickup', 'local');
  const utc = alarmLink(PROFILE, pickup, BERLIN, 'pickup', 'utc');
  assert.equal(visibleOf(local), '07:45');
  assert.equal(visibleOf(utc), '05:45');
  assert.equal(payloadOf(local), '07:45');
  assert.equal(payloadOf(utc), '07:45', 'a phone alarm is set on the phone clock: never UTC');
  assert.match(utc.toString(), /title="Set an alarm for pickup at 07:45 local time with the AddAlarm shortcut"/);
  assert.match(local.toString(), /title="Set an alarm for pickup 07:45 with the AddAlarm shortcut"/);
  assert.match(local.toString(), /shortcuts:\/\/run-shortcut\?name=AddAlarm&amp;input=text&amp;text=07%3A45"/);
});

test('alarmLink with an unknown zone keeps today\'s behaviour (the payload says UTC)', () => {
  const ms = at('2026-10-10T05:45:00Z');
  assert.equal(payloadOf(alarmLink(PROFILE, ms, null, 'wake-up', 'local')), '05:45 UTC');
  assert.equal(visibleOf(alarmLink(PROFILE, ms, null, 'wake-up', 'local')), '05:45 UTC');
  assert.equal(payloadOf(alarmLink(PROFILE, ms, null, 'wake-up', 'utc')), '05:45 UTC');
  assert.equal(visibleOf(alarmLink(PROFILE, ms, null, 'wake-up', 'utc')), '05:45');
});

// --- Duty fields, sector list, horizon, accessible names ---------------------------------------------------

const dutyOf = (s) => ({ sectors: [s], wakeup: s.dep - 4 * 3600000, pickup: s.dep - 2 * 3600000 });

test('dutyFields: departure, arrival, +N and notes follow the mode; wake-up and pickup alarms keep their payload', () => {
  const s = sector({ destination: 'BKK', destTz: BANGKOK, dep: at('2026-10-10T12:00:00Z'), arr: at('2026-10-10T23:30:00Z') });
  const duty = dutyOf(s);
  const local = inMode('local', () => dutyFields(duty, PROFILE).toString());
  const utc = inMode('utc', () => dutyFields(duty, PROFILE).toString());
  assert.match(local, /<dd>14:00<span class="pass-note">Frankfurt/);
  assert.match(local, /06:30<sup class="pass-shift"[^>]*>\+1<\/sup>/);
  assert.match(utc, /<dd>12:00<span class="pass-note">Frankfurt/);
  assert.match(utc, /<dd>23:30<span class="pass-note">/);
  assert.doesNotMatch(utc, /pass-shift/);
  assert.match(utc, /14:00 local/);
  assert.match(utc, /06:30 local/);
  // Wake-up 08:00 UTC = 10:00 local: visible follows the mode, payload does not.
  assert.match(local, /class="pass-alarm"[^>]*text=10%3A00"[^>]*>10:00</);
  assert.match(utc, /class="pass-alarm"[^>]*text=10%3A00"[^>]*>08:00</);
});

test('sectorList and sector cards tag the arrival offset in Local only', () => {
  const s = sector();
  const duty = { sectors: [s, sector({ id: 'S2', origin: 'YYZ', destination: 'FRA', originTz: TORONTO, destTz: BERLIN, dep: at('2026-10-10T20:00:00Z'), arr: at('2026-10-11T06:00:00Z') })] };
  const local = inMode('local', () => sectorList(duty).toString());
  const utc = inMode('utc', () => sectorList(duty).toString());
  assert.match(local, /YYZ 12:20 <span class="tz-tag">UTC−4<\/span>/);
  assert.match(local, /FRA 08:00 <span class="tz-tag">UTC\+2<\/span>/);
  assert.match(utc, /FRA 07:40 → YYZ 16:20<\/li>/);
  assert.doesNotMatch(utc, /tz-tag/);
});

test('accessible sector name: Local names the arrival offset, UTC says "UTC"', () => {
  const s = sector();
  const e = entryOf(s);
  assert.equal(sectorLabel(e, s, 'local'), 'DE2074, FRA 09:40 to YYZ 12:20 UTC−4, Sat 10 Oct');
  assert.equal(sectorLabel(e, s, 'utc'), 'DE2074, FRA 07:40 UTC to YYZ 16:20 UTC, Sat 10 Oct');
});

test('Duty Horizon: stop times and the accessible summary follow the mode; one chip, no UTC repeated per stop', () => {
  const snap = fixtureSnapshot();
  const { horizon } = pipeline(snap, '2026-10-10T05:00:00Z');
  const local = horizonView(horizon, { mode: 'local' }).toString();
  const utc = horizonView(horizon, { mode: 'utc' }).toString();
  const values = (html) => [...html.matchAll(/hz-time-value">([^<]*)</g)].map((m) => m[1]);
  assert.ok(values(local).length >= 2);
  assert.notDeepEqual(values(local), values(utc));
  assert.ok(values(utc).every((v) => /^\d\d:\d\d$/.test(v)), 'plain HH:MM in UTC mode');
  assert.equal([...utc.matchAll(/class="tz-mode"/g)].length, 1);
  assert.match(/aria-label="([^"]*)"/.exec(utc)[1], /\d\d:\d\d UTC/);
  assert.doesNotMatch(/aria-label="([^"]*)"/.exec(local)[1], / UTC[,.)]/);
  // The stops are the same instants: both renderings list the same stops in the same order.
  assert.equal(values(local).length, values(utc).length);
});

// --- Radar -----------------------------------------------------------------------------------------------

const rdResult = (flights, over = {}) => ({ airport: 'BKK', airportTz: BANGKOK, from: 0, to: 0, carriers: null, provider: 'x', fetchedAt: at('2026-10-10T10:00:00Z'), generatedAt: 0, dropped: 0, flights, fromCache: false, ...over });
const rdFlight = (n, iso) => ({ id: `F${n}`, flightNumber: `XX${n}`, carrier: 'XX', scheduledDep: at(iso), revisedDep: null, destination: 'FRA', status: 'scheduled', aircraft: null });

test('Radar rows: airport-local in Local, UTC in UTC, grouped by the shown hour; the listed flights and instants are identical', () => {
  const flights = [rdFlight(1, '2026-10-10T16:10:00Z'), rdFlight(2, '2026-10-10T16:50:00Z'), rdFlight(3, '2026-10-10T17:20:00Z'), { ...rdFlight(4, '2026-10-10T18:00:00Z'), revisedDep: at('2026-10-10T18:25:00Z') }];
  const window = { kind: 'standby', start: at('2026-10-10T15:00:00Z'), end: at('2026-10-10T21:00:00Z') };
  const now = at('2026-10-10T14:00:00Z');
  const local = buildRadarView(rdResult(flights), { now, window, homeTz: BERLIN, mode: 'local' });
  const utc = buildRadarView(rdResult(flights), { now, window, homeTz: BERLIN, mode: 'utc' });
  const rows = (v) => v.groups.flatMap((g) => g.rows);
  assert.deepEqual(rows(local).map((r) => r.timeText), ['23:10', '23:50', '00:20', '01:00'], 'Bangkok is UTC+7');
  assert.deepEqual(rows(utc).map((r) => r.timeText), ['16:10', '16:50', '17:20', '18:00']);
  assert.deepEqual(local.groups.map((g) => g.label), ['23:00', '00:00', '01:00']);
  assert.deepEqual(utc.groups.map((g) => g.label), ['16:00', '17:00', '18:00']);
  assert.equal(rows(local).at(-1).revisedText, '01:25');
  assert.equal(rows(utc).at(-1).revisedText, '18:25');
  assert.equal(local.groups[0].dayLabel, 'Sat 10 Oct');
  assert.equal(local.groups[1].dayLabel, 'Sun 11 Oct', 'Local day lines follow the airport dates');
  assert.equal(utc.groups[0].dayLabel, null, 'all in one UTC day');
  assert.deepEqual(rows(local).map((r) => [r.id, r.scheduledDep, r.effectiveDep]), rows(utc).map((r) => [r.id, r.scheduledDep, r.effectiveDep]));
  assert.equal(local.total, utc.total);
  assert.match(local.tzLabel, /local at BKK \(UTC\+7\)/);
  assert.equal(utc.tzLabel, 'Times are in UTC (BKK local time is UTC+7)');
});

// --- Adapter: zone fallback (data-model limitation fix) --------------------------------------------------------

const v2Payload = (sectors) => ({
  sectors, duties: [], events: [], windows: [], stays: [], warnings: [],
  coverage: { from: '2026-10-01', to: '2026-10-31', lastRosteredDate: '2026-10-31', days: [] },
});
const v2Sector = (over = {}) => ({
  id: 'a', flightNumber: 'DE2074', origin: 'FRA', destination: 'YYZ',
  dep: at('2026-10-10T07:40:00Z'), arr: at('2026-10-10T16:20:00Z'), blockMin: 520, ...over,
});

test('v2 adapter: backend zone null + known IATA falls back to the airport table', () => {
  const snap = adaptV2(v2Payload([v2Sector({ originTz: null, destTz: null })]), { profile: PROFILE, fetchedAt: 0 });
  assert.equal(snap.sectors[0].originTz, BERLIN);
  assert.equal(snap.sectors[0].destTz, TORONTO);
  const absent = adaptV2(v2Payload([v2Sector()]), { profile: PROFILE, fetchedAt: 0 });
  assert.equal(absent.sectors[0].originTz, BERLIN, 'a missing field behaves like null');
  assert.equal(absent.warnings.length, 0);
});

test('v2 adapter: a zone stated by the backend wins over the table', () => {
  const snap = adaptV2(v2Payload([v2Sector({ originTz: 'Europe/London', destTz: 'America/Chicago' })]), { profile: PROFILE, fetchedAt: 0 });
  assert.equal(snap.sectors[0].originTz, 'Europe/London');
  assert.equal(snap.sectors[0].destTz, 'America/Chicago');
});

test('v2 adapter: an unknown airport with no stated zone stays null and is warned about once', () => {
  const snap = adaptV2(v2Payload([v2Sector({ id: 'a', destination: 'ZZZ' }), v2Sector({ id: 'b', origin: 'ZZZ', destination: 'FRA', dep: at('2026-10-11T07:40:00Z'), arr: at('2026-10-11T16:20:00Z') })]), { profile: PROFILE, fetchedAt: 0 });
  assert.equal(snap.sectors[0].destTz, null);
  assert.equal(snap.sectors[1].originTz, null);
  assert.deepEqual(snap.warnings.map((w) => w.code), ['unknown-airport']);
  assert.match(snap.warnings[0].message, /ZZZ/);
  // The screen then says so instead of inventing a local time.
  assert.equal(opTime(snap.sectors[0].arr, snap.sectors[0].destTz, 'local'), '16:20 UTC');
});

test('v2 adapter: an invalid backend zone falls back to the airport table (known airport)', () => {
  for (const bad of ['Europe/Frnkfurt', 'UTC+2', 'Not/AZone', ' ']) {
    const snap = adaptV2(v2Payload([v2Sector({ originTz: bad, destTz: bad })]), { profile: PROFILE, fetchedAt: 0 });
    assert.equal(snap.sectors[0].originTz, BERLIN, `${JSON.stringify(bad)} → airport table`);
    assert.equal(snap.sectors[0].destTz, TORONTO);
    assert.equal(snap.warnings.length, 0);
  }
});

test('v2 adapter: an invalid backend zone on an unknown airport stays unknown (null + warning, never UTC or device time)', () => {
  const s = v2Sector({ destination: 'ZZZ', destTz: 'Europe/Frnkfurt' });
  const snap = adaptV2(v2Payload([s]), { profile: PROFILE, fetchedAt: 0 });
  assert.equal(snap.sectors[0].destTz, null);
  assert.deepEqual(snap.warnings.map((w) => w.code), ['unknown-airport']);
  // The instant is untouched and shown as labelled UTC, not reinterpreted.
  assert.equal(snap.sectors[0].arr, s.arr);
  assert.equal(opTime(snap.sectors[0].arr, snap.sectors[0].destTz, 'local'), '16:20 UTC');
  const [h] = adaptHistoryV2(v2Payload([s]), 0);
  assert.equal(h.destTz, null);
});

test('v2 history adapter uses the same fallback', () => {
  const [h] = adaptHistoryV2(v2Payload([v2Sector({ originTz: null, destTz: 'America/Chicago' })]), 0);
  assert.equal(h.originTz, BERLIN);
  assert.equal(h.destTz, 'America/Chicago');
});

// --- Control, Settings and wiring ----------------------------------------------------------------------------

test('timeDisplayControl is the same segmented radio group as the theme control, with Local and UTC', () => {
  const html = inMode('local', () => timeDisplayControl().toString());
  assert.match(html, /^\s*<div class="segmented " role="radiogroup" aria-label="Time display" data-time-display-control>/);
  assert.match(html, /data-time-display-value="local"\s+aria-checked="true"\s+tabindex="0">Local</);
  assert.match(html, /data-time-display-value="utc"\s+aria-checked="false"\s+tabindex="-1">UTC</);
  const utc = inMode('utc', () => timeDisplayControl().toString());
  assert.match(utc, /data-time-display-value="utc"\s+aria-checked="true"/);
  assert.match(utc, /data-time-display-value="local"\s+aria-checked="false"/);
});

test('Settings > Appearance has Theme and a separate Time display setting with the agreed helper text', () => {
  const html = settings.render({ view: () => ({ profile: PROFILE }) }).toString();
  assert.match(html, /<span class="list-label">Theme<\/span>/);
  assert.match(html, /<span class="list-label">Time display<\/span>/);
  assert.match(html, /Local — Airport time zones\. UTC — Coordinated Universal Time\./);
  assert.equal([...html.matchAll(/data-time-display-control/g)].length, 1);
  assert.equal([...html.matchAll(/data-theme-control/g)].length, 1, 'the theme control is still its own, separate control');
  assert.ok(html.indexOf('Theme</span>') < html.indexOf('Time display</span>'), 'under Theme');
});

test('the time display control is not in the sidebar quick switch; main.js wires click, sync and a re-render of the current screen', () => {
  assert.doesNotMatch(read('src/ui/shell.js'), /timeDisplayControl|data-time-display/);
  const main = read('src/main.js');
  assert.match(main, /\[data-time-display-control\] \[data-time-display-value\]/);
  assert.match(main, /setTimeDisplay\(button\.dataset\.timeDisplayValue\)/);
  assert.match(main, /addEventListener\('fc:time-display'/);
  assert.match(main, /applyTimeDisplay\(\);\s*watchTimeDisplay\(\)/);
});

test('CSS: the mode chip is hidden unless the root is in UTC mode; the offset tag is neutral', () => {
  const css = read('assets/css/components.css');
  assert.match(css, /\.tz-mode \{ display: none; \}/);
  assert.match(css, /:root\[data-time-display="utc"\] \.tz-mode \{/);
  assert.match(css, /\.tz-tag \{[^}]*color: var\(--fg-2\)/);
});

// --- No bypass ---------------------------------------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('no screen or model formats an operational time by itself: formatTime( appears only in the labelled location clocks', () => {
  // Labelled location clocks show the time at a named place now, not an event, and stay on that place's zone.
  const ALLOWED = new Map([
    ['src/ui/screens/today.js', 2],   // layover "local time" at the named place; Home / outstation "Local time" clocks
    ['src/ui/destination.js', 1],     // "Local time" at the destination
  ]);
  const found = new Map();
  for (const file of [...walk(join(ROOT, 'src/ui')), ...walk(join(ROOT, 'src/model'))]) {
    const count = (readFileSync(file, 'utf8').match(/\bformatTime\(/g) ?? []).length;
    if (count) found.set(relative(ROOT, file), count);
  }
  assert.deepEqual([...found].sort(), [...ALLOWED].sort());
});

test('no bypass through the other time-of-day formatters either', () => {
  for (const file of [...walk(join(ROOT, 'src/ui')), ...walk(join(ROOT, 'src/model'))]) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /toLocaleTimeString|toLocaleString\(|getHours\(|getUTCHours\(|DateTimeFormat\([^)]*hour/, relative(ROOT, file));
  }
});

test('localDateKey is unaffected by the mode (roster-day semantics are not display)', () => {
  const ms = at('2026-10-10T23:30:00Z');
  const before = localDateKey(ms, BERLIN);
  inMode('utc', () => assert.equal(localDateKey(ms, BERLIN), before));
  assert.equal(before, '2026-10-11');
});

test('a date that qualifies a shown time follows the display mode (never a UTC time beside a local date)', () => {
  // YYZ departure 01:00Z on 9 Oct = 21:00 on Thu 8 Oct in Toronto.
  const s = { id: 'x1', flightNumber: 'XX1', origin: 'YYZ', destination: 'FRA', dep: Date.UTC(2026, 9, 9, 1, 0), arr: Date.UTC(2026, 9, 9, 8, 30),
    blockMin: 450, originTz: 'America/Toronto', destTz: 'Europe/Berlin', provenance: 'source' };
  const e = { sector: s, status: 'upcoming', shift: 0 };
  const local = sectorLabel(e, s, 'local');
  const utc = sectorLabel(e, s, 'utc');
  assert.match(local, /YYZ 21:00 .*Thu 8 Oct/);
  assert.match(utc, /YYZ 01:00 UTC .*Fri 9 Oct/);
  assert.equal(opDate(s.dep, s.originTz, 'local'), 'Thu 8 Oct');
  assert.equal(opDate(s.dep, s.originTz, 'utc'), 'Fri 9 Oct');
});
