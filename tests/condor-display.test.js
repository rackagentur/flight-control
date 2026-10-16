// Condor display terminology (owner decision D-012): Strichtag shows its roster code "-" (U+002D) and
// Urlaub shows "U" in compact places; Today says Strichtag / No duty assigned and Urlaub / Holiday.
// Classifications are unchanged ('-' = unassigned, 'U' = off/leave); the generic pack is unchanged.
// Synthetic feed only, through the real backend sources, adapter, model and screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { buildRoster } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { normalizeProfile } from '../src/config/profile.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { today as todayScreen } from '../src/ui/screens/today.js';
import { weekView } from '../src/ui/week.js';
import { airlineOf } from '../src/airlines/index.js';
import { createStore } from '../src/store.js';
import { saveRecord, restoreRecord, acceptedSnapshot } from '../src/roster-storage.js';
import { PROFILE } from './helpers.js';

const gs = loadGs();
const feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const payload = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'roster', token: 'test-token-0123456789abcdef' }), env)));
const GENERIC = normalizeProfile({ airlineId: 'generic' });
const DASH_DAY = '2026-10-06', LEAVE_DAY = '2026-10-25';
const noonOf = (date) => Date.parse(`${date}T10:00:00Z`);

function view(profile, now, snapshot = adaptV2(payload, { profile, fetchedAt: NOW })) {
  const roster = buildRoster(snapshot, profile, now);
  const state = deriveState(snapshot, roster, profile, now);
  return { roster, state, snapshot, profile, now, review: false, loading: false, warnings: [], toneOverride: null, mode: { kind: 'production' } };
}
const renderCal = (v, selected) => { resetCalendarUi('2026-10', selected); return calendar.render({ view: () => v }).toString(); };
const renderToday = (v) => todayScreen.render({ view: () => v, weather: () => null }).toString();
const cellOf = (markup, date) => markup.match(new RegExp(`<button[^>]*data-date="${date}"[\\s\\S]*?</button>`))[0];
const strip = (v, date) => weekView(v.roster.days.filter((d) => d.date === date), v.profile.homeTz, airlineOf(v.profile).terminology).toString();

test('fixture: the synthetic feed carries one "-" day and one "U" day with the unchanged classifications', () => {
  const codes = Object.fromEntries(payload.coverage.days.filter((d) => d.codes.length).map((d) => [d.date, d.codes.map((c) => [c.kind, c.subtype, c.code])]));
  assert.deepEqual(codes[DASH_DAY], [['unassigned', null, '-']]);
  assert.deepEqual(codes[LEAVE_DAY], [['off', 'leave', 'U']]);
});

test('Condor calendar: "-" for Strichtag, "U" for Urlaub in cells and key; never STR or LEAVE; styling classes unchanged', () => {
  const cal = renderCal(view(PROFILE, NOW), DASH_DAY);
  assert.match(cellOf(cal, DASH_DAY), /<span class="cal-code tok-unassigned" aria-hidden="true">-<\/span>/);
  assert.match(cellOf(cal, LEAVE_DAY), /<span class="cal-code tok-off tok-leave" aria-hidden="true">U<\/span>/);
  assert.match(cal, /cal-key-item key-unassigned"><span class="cal-key-sample" aria-hidden="true">-<\/span>- · Strichtag · no duty assigned</);
  assert.match(cal, /cal-key-item key-leave"><span class="cal-key-sample" aria-hidden="true">U<\/span>Urlaub · holiday</);
  assert.doesNotMatch(cal, /\bSTR\b|STRICHTAG|LEAVE/);
  assert.match(cellOf(cal, DASH_DAY).match(/aria-label="([^"]*)"/)[1], /Strichtag/);
  assert.match(cellOf(cal, LEAVE_DAY).match(/aria-label="([^"]*)"/)[1], /Urlaub/);
  assert.equal(cal.includes('– · Strichtag'), false, 'never an en dash');
});

test('Condor Today: Strichtag / No duty assigned; Urlaub / Holiday; neither is a flight duty', () => {
  const dash = view(PROFILE, noonOf(DASH_DAY));
  assert.equal(dash.state.status, 'unassigned');
  const t1 = renderToday(dash);
  assert.match(t1, /<h2 class="pass-state t-display" id="status-title">Strichtag<\/h2>\s*<p class="pass-lede">No duty assigned<\/p>/);
  const leave = view(PROFILE, noonOf(LEAVE_DAY));
  assert.deepEqual([leave.state.status, leave.state.offSubtype], ['off', 'leave']);
  const t2 = renderToday(leave);
  assert.match(t2, /<h2 class="pass-state t-display" id="status-title">Urlaub<\/h2>\s*<p class="pass-lede">Holiday<\/p>/);
  assert.deepEqual(leave.state.reasons, ['The roster lists today as: Urlaub (holiday).']);
  for (const markup of [t1, t2]) assert.doesNotMatch(markup, /\bSTR\b|STRICHTAG|LEAVE|>Leave</);
});

test('Condor 7-day strip: "-" and "U" codes with full names for screen readers; other off days keep OFF', () => {
  const v = view(PROFILE, NOW);
  assert.match(strip(v, DASH_DAY), /<span class="week-code" aria-hidden="true">-<\/span>/);
  const u = strip(view(PROFILE, noonOf(LEAVE_DAY)), LEAVE_DAY);
  assert.match(u, /<span class="week-code" aria-hidden="true">U<\/span>/);
  assert.match(u, /aria-label="[^"]*Urlaub"/);
  assert.match(strip(v, '2026-10-05'), /<span class="week-code" aria-hidden="true">OFF<\/span>/, 'an OFF day is unchanged');
  assert.match(strip(v, '2026-10-04'), /<span class="week-code" aria-hidden="true">OFF<\/span>/, 'ORT keeps the generic OFF strip code');
});

test('no pickup, wake-up or duty on a "-" or "U" day; Today only names the next later duty', () => {
  for (const date of [DASH_DAY, LEAVE_DAY]) {
    const v = view(PROFILE, noonOf(date));
    const day = v.roster.days.find((d) => d.date === date);
    assert.ok(['unassigned', 'off'].includes(day.status), date);
    assert.deepEqual(day.sectors, [], `${date}: no sectors`);
    const dayStart = Date.parse(`${date}T00:00:00+02:00`) - 3600000, dayEnd = dayStart + 27 * 3600000;
    assert.ok(v.roster.duties.every((d) => d.end <= dayStart || d.start >= dayEnd), `${date}: no duty (and no pickup/wake-up) overlaps the day`);
    if (v.state.duty) assert.ok(v.state.duty.start >= dayEnd - 3 * 3600000, `${date}: the shown duty is a later one`);
  }
});

test('offline restore: a saved record renders "-" and "U" exactly as live data', () => {
  const m = new Map();
  const store = createStore({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } });
  assert.equal(saveRecord(store, { version: 1, source: 'synthetic-source', contract: 'v2', payload, fetchedAt: NOW, history: [], serverHistory: null }), true);
  const { record, saved } = restoreRecord(store, 'synthetic-source', PROFILE, true);
  assert.equal(saved, true);
  const restored = acceptedSnapshot(record.contract, record.payload, PROFILE, record.fetchedAt);
  const live = renderCal(view(PROFILE, NOW), DASH_DAY);
  const offline = renderCal(view(PROFILE, NOW, restored), DASH_DAY);
  for (const date of [DASH_DAY, LEAVE_DAY]) assert.equal(cellOf(offline, date), cellOf(live, date), `${date} identical after restore`);
  assert.match(cellOf(offline, DASH_DAY), />-<\/span>/);
  assert.match(cellOf(offline, LEAVE_DAY), />U<\/span>/);
});

test('generic airline unchanged: LEAVE / Leave, UNAS / Unassigned day, OFF in the strip, no Condor wording', () => {
  const t = airlineOf(GENERIC).terminology;
  assert.deepEqual({ ...t.offSubtype.leave }, { short: 'LEAVE', name: 'Leave' });
  const v = view(GENERIC, NOW);
  const cal = renderCal(v, DASH_DAY);
  assert.match(cellOf(cal, LEAVE_DAY), /aria-hidden="true">LEAVE<\/span>/);
  assert.match(cellOf(cal, DASH_DAY), /aria-hidden="true">UNAS<\/span>/);
  assert.match(cal, /cal-key-item key-leave"><span class="cal-key-sample" aria-hidden="true">LEAVE<\/span>Leave</);
  assert.match(strip(view(GENERIC, noonOf(LEAVE_DAY)), LEAVE_DAY), /<span class="week-code" aria-hidden="true">OFF<\/span>/);
  const leaveToday = renderToday(view(GENERIC, noonOf(LEAVE_DAY)));
  assert.match(leaveToday, /id="status-title">Leave<\/h2>/);
  assert.doesNotMatch(leaveToday, /Holiday|Urlaub/);
  assert.doesNotMatch(cal + leaveToday, /Strichtag|Urlaub/);
});
