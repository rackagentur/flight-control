// Crew Intelligence Stage B2–B5: Flight Details crew section and Settings crew panel. Pure render per state,
// hidden when off/unsupported/ineligible, existing screens unchanged when off, privacy (names only in member
// rows, never in storage, live regions, hrefs or titles), offline safety, no browser dialogs. Synthetic only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAirline } from '../src/airlines/index.js';
import { presentCrew, CONDOR_CREW_RANKS } from '../src/airlines/condor/crew.js';
import { validateCrew } from '../src/sources/crew-v2.js';
import { createStore } from '../src/store.js';
import { createCrewCredentials, accessFingerprint, endpointFingerprint, CREW_CREDENTIAL_KEY } from '../src/sources/crew-credential.js';
import { createCrewRuntime, CREW_ENABLED_KEY } from '../src/crew-runtime.js';
import {
  crewSectionView, crewSection, crewSectionState, crewErrorKind, resetCrewSection, crewPanelView, crewPanel, resetCrewPanel,
} from '../src/ui/crew-section.js';
import { flights } from '../src/ui/screens/flights.js';
import { settings } from '../src/ui/screens/settings.js';
import { normalizeProfile } from '../src/config/profile.js';
import { neutralCrewAnswer as crewAnswer, unlistedAnswer, neutralMembers as sampleMembers, memoryStorage, flush, SECTOR, TOKEN, ENDPOINT, T0 } from './fixtures/crew-frontend.synthetic.mjs';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW as FEED_NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { request as v2Request } from '../src/sources/contract-v2.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { buildRoster } from '../src/model/roster.js';
import { deriveState } from '../src/model/state.js';
import { PROFILE as PROFILE_FIX } from './helpers.js';

const PACK = getAirline('condor').crew;
const COPY = PACK.copy;
const NAMES = ['SAMPLE', 'ALEX', 'Example', 'Jordan', 'BRIEN', 'ANA-LENA', 'ARCY', 'PLACEHOLDER', 'TESTPERSON', 'ROBIN', 'SAM'];
const value = (over = {}) => {
  const r = validateCrew(crewAnswer(over), { sectorId: SECTOR });
  assert.equal(r.ok, true, r.reason);
  return r.value;
};
const str = (x) => String(x);
const liveRegions = (markup) => [...markup.matchAll(/aria-live="polite">([\s\S]*?)<\/div>/g)].map((m) => m[1]).join('\n');
const memberFacts = (markup) => [...markup.matchAll(/<p class="crew-fact">([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

beforeEach(() => { resetCrewSection(); resetCrewPanel(); });

// --- B2 render per state ------------------------------------------------------------------------------------

test('B2 complete: summary, neutral group with raw codes (no invented ranks), counts and last shared duty', () => {
  const m = str(crewSectionView({ kind: 'crew', value: value() }, PACK));
  assert.match(m, /aria-labelledby="fl-crew"/);
  assert.match(m, /<span class="crew-summary-n">2 of 6<\/span> with recorded shared duties/, 'recorded + uncertain-with-match count as shared');
  assert.doesNotMatch(m, /crew-group-label/, 'one neutral group: no group label');
  assert.deepEqual(Object.keys(CONDOR_CREW_RANKS), [], 'D7 pending: no verified ranks');
  for (const code of ['XA', 'XB', 'XC', 'XD', 'XE']) assert.match(m, new RegExp(`<span class="crew-rank">${code}</span>`));
  assert.doesNotMatch(m, /Captain|First Officer|Purser|Flight Attendant|Cockpit|Cabin/);
  assert.deepEqual(memberFacts(m), [
    '3 recorded shared duties', 'No shared duty recorded in available history', 'Shared duty recorded · Count uncertain',
    'Re-checking', 'History unavailable', 'History unavailable',
  ]);
  assert.match(m, /Last XQ1234 FRA–PMI · 14 Sept? 2026/);
  assert.doesNotMatch(m, /\bDE\d/, 'no airline flight prefix in UI fixtures');
  assert.match(m, /1 crew line could not be read\./);
  assert.match(m, /Not stored on this phone/);
  assert.match(m, /class="crew-member is-shared"/);
});

test('B2 verified groups: when the owner fills the rank map, Cockpit and Cabin appear (test-only map)', () => {
  const ranks = { XA: { group: 'cockpit', label: 'Test cockpit rank' }, XC: { group: 'cabin', label: 'Test cabin rank' } };
  const pack = { ...PACK, present: (members) => presentCrew(members, { ranks }) };
  const m = str(crewSectionView({ kind: 'crew', value: value() }, pack));
  assert.deepEqual([...m.matchAll(/<p class="crew-group-label">([^<]+)<\/p>/g)].map((x) => x[1]), ['Cockpit', 'Cabin', 'Crew on this flight']);
  assert.match(m, /<span class="crew-rank">Test cockpit rank<\/span>/);
});

test('B2 incomplete: counts shown and labelled as incomplete history', () => {
  const m = str(crewSectionView({ kind: 'crew', value: value({ state: 'incomplete', reasons: ['missing-records'] }) }, PACK));
  assert.match(liveRegions(m), /History incomplete/);
  assert.match(m, /Numbers can be lower than your real history/);
  assert.match(m, /<strong class="crew-count">3<\/strong> recorded shared duties/);
  assert.doesNotMatch(m, /crew-summary/);
});

test('B2 stale: no number and no date anywhere in the members; "Re-checking"', () => {
  const stale = sampleMembers().map((x) => (x.match === 'unavailable' ? x : { rank: x.rank, family: x.family, given: x.given, match: 'stale', count: null, asOfRecorded: 4 }));
  const m = str(crewSectionView({ kind: 'crew', value: value({ state: 'stale', reasons: ['stale-history'], members: stale }) }, PACK));
  assert.match(liveRegions(m), /History is being re-checked/);
  for (const fact of memberFacts(m)) assert.doesNotMatch(fact, /\d/, `no number: ${fact}`);
  assert.doesNotMatch(m, /crew-last|Last |at least|checked (?:on|at|today|\d)/i, 'no number, no date, no "checked <date>" line');
  assert.ok(memberFacts(m).filter((f) => f === 'Re-checking').length >= 5);
});

test('B2 indexing progress, not-listed, and every message state; live regions never contain names', () => {
  const idx = str(crewSectionView({ kind: 'crew', value: value({ state: 'incomplete', reasons: ['missing-records'] }), indexing: { indexed: 18, total: 50 } }, PACK));
  assert.match(liveRegions(idx), /Updating history[\s\S]*18 of 50 months/);
  assert.match(idx, /This list refreshes when it’s done/);
  const expected = {
    loading: /Loading crew/, 'not-enrolled': /not set up on this phone[\s\S]*href="#\/settings"/, 'not-listed': /Crew not published yet/,
    pending: /Deleting crew history/, 'pending-elsewhere': /previous connection/, revoked: /Crew Intelligence is off[\s\S]*Open Settings/,
    offline: /You’re offline/, limit: /paused for a few minutes/, suspended: /isn’t available for this connection/,
    storage: /storage isn’t available/, 'not-found': /isn’t available for this flight/, error: /couldn’t be loaded[\s\S]*data-crew-retry/,
  };
  for (const [kind, re] of Object.entries(expected)) {
    const m = str(crewSectionView({ kind }, PACK));
    assert.match(m, re, kind);
    assert.match(m, /role="status" aria-live="polite"/, `${kind}: polite status region`);
  }
  assert.equal(str(crewSectionView({ kind: 'not-listed' }, PACK)).includes('crew-list'), false);
  const full = str(crewSectionView({ kind: 'crew', value: value() }, PACK));
  for (const name of NAMES) assert.equal(liveRegions(full).includes(name), false, `${name} not announced`);
  assert.equal(str(crewSectionView({ kind: 'crew', value: validateCrew(unlistedAnswer(), { sectorId: SECTOR }).value }, PACK)).includes('crew-member'), false);
});

test('B2 error codes map to calm states', () => {
  assert.deepEqual(['network', 'timeout', 'rate-limited', 'cooldown', 'local-limit', 'suspended', 'storage-unreadable', 'lock-unavailable', 'invalid-response', 'crew-revoked', 'revoke-pending', 'revoke-pending-elsewhere', 'crew-not-enrolled', 'sector-not-owned'].map(crewErrorKind),
    ['offline', 'offline', 'limit', 'limit', 'limit', 'suspended', 'storage', 'storage', 'error', 'revoked', 'pending', 'pending-elsewhere', 'not-enrolled', 'not-found']);
});

// --- Runtime-driven section: hidden / loading / loaded / offline ----------------------------------------------

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sector = { id: SECTOR, flightNumber: 'XQ100', origin: 'AAA', destination: 'BBB', dep: Date.parse('2026-10-20T08:00:00Z'), arr: Date.parse('2026-10-20T10:00:00Z'), originTz: 'Europe/Berlin', destTz: 'Europe/Berlin', provenance: 'source' };
const viewOf = (over = {}) => ({ review: false, mode: { kind: 'production' }, now: NOW, profile: normalizeProfile({}), snapshot: { contract: 'v2', sectors: [sector] }, ...over });
const CAPS = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history', 'crew', 'crewEnroll', 'crewIndex', 'crewRevoke'] };

function runtime({ enabled = true, caps = CAPS, crew = () => crewAnswer({ sectorId: SECTOR }), enrolled = true } = {}) {
  const storage = memoryStorage();
  const store = createStore(storage);
  const bodies = [];
  const post = async (ep, body) => { bodies.push(body); return { data: body.action === 'capabilities' ? caps : body.action === 'crew' ? crew(body) : { ok: true, action: 'crewIndex', processed: 0, outcomes: {}, progress: { total: 1, indexed: 1, pending: 0, stale: 0, uncovered: 0 }, gcDeleted: 0, cleanupPending: false } }; };
  if (enrolled) {
    storage.setItem(`fc.v2.${CREW_CREDENTIAL_KEY}`, JSON.stringify({ v: 1, phase: 'active', grants: [{ grant: 'A'.repeat(43), ep: endpointFingerprint(ENDPOINT), bind: accessFingerprint(ENDPOINT, TOKEN), at: T0, role: 'active', G: 1, unknown: false, inflight: false }] }));
  }
  const access = { endpoint: ENDPOINT, token: TOKEN, accessId: `ui-${Math.random()}` };
  const rt = createCrewRuntime({ store, access: () => access, post, credentials: createCrewCredentials({ store }), isVisible: () => true, isOnline: () => true });
  if (enabled) rt.setEnabled(true);
  const ctx = { crew: rt, accessId: () => access.accessId, rerender: () => {}, view: () => viewOf() };
  return { storage, store, bodies, rt, ctx };
}

test('B2 hidden: no runtime, crew off, capability unsupported, ineligible sector, airline without crew pack', async () => {
  const entry = { sector };
  assert.equal(crewSection({ accessId: () => 'x' }, entry, viewOf()), '');
  const off = runtime({ enabled: false });
  assert.equal(crewSection(off.ctx, entry, viewOf()), '');
  assert.equal(off.bodies.length, 0, 'no request while disabled');
  const unsupported = runtime({ caps: { ...CAPS, actions: ['capabilities', 'roster', 'history'] } });
  assert.equal(crewSection(unsupported.ctx, entry, viewOf()), '', 'hidden while the capability is checked');
  await flush();
  assert.equal(crewSection(unsupported.ctx, entry, viewOf()), '', 'unsupported: hidden');
  assert.deepEqual(unsupported.bodies.map((b) => b.action), ['capabilities']);
  resetCrewSection();
  const ok = runtime();
  assert.equal(crewSection(ok.ctx, { sector: { ...sector, provenance: 'history' } }, viewOf()), '', 'remembered history: hidden');
  assert.equal(crewSection(ok.ctx, entry, viewOf({ review: true })), '', 'sample/review: hidden');
  assert.equal(crewSection(ok.ctx, entry, viewOf({ profile: normalizeProfile({ airlineId: 'generic' }) })), '', 'no crew pack: hidden');
});

test('B2 loading -> loaded from the runtime (memory only: storage holds only the credential record and crew.enabled)', async () => {
  const h = runtime();
  const entry = { sector };
  assert.equal(crewSectionState(h.ctx, entry, viewOf()), null);
  await flush();
  assert.deepEqual(crewSectionState(h.ctx, entry, viewOf()), { kind: 'loading' });
  await flush();
  const state = crewSectionState(h.ctx, entry, viewOf());
  assert.equal(state.kind, 'crew');
  assert.deepEqual(h.bodies.map((b) => b.action), ['capabilities', 'crew']);
  assert.deepEqual(h.bodies[1].sectorId, SECTOR);
  assert.deepEqual([...h.storage.map.keys()].sort(), [`fc.v2.${CREW_CREDENTIAL_KEY}`, `fc.v2.${CREW_ENABLED_KEY}`].sort());
  const stored = [...h.storage.map.values()].join('\n');
  for (const name of NAMES) assert.equal(stored.includes(name), false, `${name} never stored`);
});

test('B2 offline safe: no crew request while offline; the offline state is shown', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const h = runtime();
  crewSectionState(h.ctx, { sector }, viewOf());
  await flush();
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false, locks: saved.get ? saved.get.call(globalThis).locks : undefined }, configurable: true, writable: true });
  try {
    const state = crewSectionState(h.ctx, { sector }, viewOf());
    assert.deepEqual(state, { kind: 'offline' });
    assert.deepEqual(h.bodies.map((b) => b.action), ['capabilities'], 'no crew request offline');
  } finally {
    Object.defineProperty(globalThis, 'navigator', saved);
  }
});

// --- Existing screens unchanged when off ----------------------------------------------------------------------

test('B5 Flights screen markup is byte-identical with crew absent, off, or while its capability is unknown', async () => {
  const gs = loadGs();
  const feed = feedEvents();
  const { env } = fakeEnv(gs, { now: FEED_NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
  const payload = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify(v2Request('roster', 'test-token-0123456789abcdef')), env)));
  const snapshot = adaptV2(payload, { profile: PROFILE_FIX, fetchedAt: FEED_NOW });
  const roster = buildRoster(snapshot, PROFILE_FIX, FEED_NOW);
  const view = { roster, state: deriveState(snapshot, roster, PROFILE_FIX, FEED_NOW), snapshot, profile: PROFILE_FIX, now: FEED_NOW, review: false, loading: false, mode: { kind: 'production' } };
  const off = runtime({ enabled: false });
  const unknown = runtime();
  const ids = snapshot.sectors.filter((x) => x.provenance === 'source').map((x) => x.id).slice(0, 6);
  assert.ok(ids.length >= 3);
  for (const id of [null, ...ids]) {
    const base = { view: () => view, param: () => id, weather: () => null, accessId: () => 'same' };
    const without = flights.render(base).toString();
    assert.equal(flights.render({ ...base, crew: off.rt }).toString(), without, `crew off: ${id}`);
    resetCrewSection();
    assert.equal(flights.render({ ...base, crew: unknown.rt }).toString(), without, `capability unknown: ${id}`);
  }
  assert.equal(off.bodies.length, 0);
});

test('B5 Today and Calendar never reference crew; diagnostics and calendar modules import nothing from crew', () => {
  for (const file of ['src/ui/screens/today.js', 'src/ui/screens/calendar.js', 'src/ui/worker-diagnostics.js']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /crew/i, file);
  }
});

test('B5 Settings: no crew panel for an airline without a crew pack; the panel for Condor', () => {
  const view = () => ({ profile: normalizeProfile({ airlineId: 'generic' }), contract: {}, snapshot: null, error: null, savedRoster: false });
  const h = runtime({ enabled: false });
  assert.equal(crewPanel({ ...h.ctx, view }), '');
  const markup = str(crewPanel({ ...h.ctx, view: () => ({ profile: normalizeProfile({}), crewCleanup: null }) }));
  assert.match(markup, /id="set-crew">Crew Intelligence</);
  assert.match(markup, /role="switch" aria-checked="false"/);
  assert.equal(typeof settings.render, 'function');
});

// --- B3 Settings panel states ---------------------------------------------------------------------------------

const model = (over = {}) => ({ enabled: false, capability: null, enrolled: false, hasRecord: false, pending: null, running: false, progress: null, cleanup: null, phase: 'idle', message: null, ...over });

test('B3 panel states: off, opt-in with privacy points and code entry, checking, unsupported, not set up, on with progress', () => {
  assert.match(str(crewPanelView(model(), COPY)), /<span class="t-caption">Off<\/span>/);
  const optIn = str(crewPanelView(model({ phase: 'opt-in' }), COPY));
  assert.match(optIn, /Turn on Crew Intelligence\?/);
  assert.match(optIn, /Names appear only in flight details/);
  assert.match(optIn, /<label class="list-label" for="crew-code">Enrollment code<\/label>/);
  assert.match(optIn, /data-crew-not-now/);
  assert.match(str(crewPanelView(model({ enabled: true, capability: 'checking' }), COPY)), /Checking your roster backend/);
  assert.match(str(crewPanelView(model({ enabled: true, capability: 'unsupported' }), COPY)), /Not offered by your roster backend/);
  const notSetUp = str(crewPanelView(model({ enabled: true, capability: 'supported' }), COPY));
  assert.match(notSetUp, /not set up on this phone/);
  assert.match(notSetUp, /data-crew-enroll/);
  const on = str(crewPanelView(model({ enabled: true, capability: 'supported', enrolled: true, hasRecord: true, progress: { total: 50, indexed: 38, pending: 6, stale: 2, uncovered: 4, at: T0 } }), COPY));
  assert.match(on, /names in flight details only/);
  assert.match(on, /<dt>Months indexed<\/dt><dd>38 of 50<\/dd>/);
  assert.match(on, /Check history now/);
  assert.match(on, /Turn off and delete crew history/);
  assert.doesNotMatch(on, /As of|last check|\d{1,2}:\d{2}/i, 'no "checked <date>" line, no time');
});

test('B3 panel states: inline confirm (no browser dialog), deleting, pending variants, sign-out cleanup status', () => {
  const confirm = str(crewPanelView(model({ enabled: true, enrolled: true, hasRecord: true, phase: 'confirm-forget' }), COPY));
  assert.match(confirm, /Turn off and delete crew history\?/);
  assert.match(confirm, /data-crew-forget-confirm/);
  assert.match(confirm, /data-crew-forget-cancel/);
  assert.match(str(crewPanelView(model({ enabled: true, phase: 'deleting' }), COPY)), /Turning off…/);
  for (const [code, re] of [[undefined, /next time you’re online/], ['unresolved-enrollment', /earlier sign-up request/], ['revoke-pending-elsewhere', /previous connection/], ['lock-unavailable', /coordinate tabs/]]) {
    const m = str(crewPanelView(model({ pending: { unresolved: 1, endpoints: ['x'] }, message: { pendingCode: code } }), COPY));
    assert.match(m, re, String(code));
    assert.match(m, /data-crew-retry-delete/);
  }
  assert.match(str(crewPanelView(model({ cleanup: 'pending' }), COPY)), /Removing this phone’s crew access/);
  assert.match(str(crewPanelView(model({ cleanup: 'incomplete' }), COPY)), /could not be removed/);
  const src = readFileSync(new URL('../src/ui/crew-section.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(alert|confirm|prompt)\s*\(/, 'no browser dialogs');
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|console\./, 'no storage or logging in the UI module');
});

test('B3 sign-out never deletes server-side history: the controller and settings never call revoke on sign-out', () => {
  const controller = readFileSync(new URL('../src/controller.js', import.meta.url), 'utf8');
  const settingsSrc = readFileSync(new URL('../src/ui/screens/settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /revoke\(/);
  assert.doesNotMatch(settingsSrc, /revoke/i);
});

test('B5 privacy: names never in hrefs, titles or crew copy; enrollment code input is never stored', () => {
  const m = str(crewSectionView({ kind: 'crew', value: value() }, PACK));
  for (const href of m.matchAll(/href="([^"]*)"/g)) for (const name of NAMES) assert.equal(href[1].includes(name), false);
  assert.doesNotMatch(m, /<title|<h1|<h2/);
  const src = readFileSync(new URL('../src/ui/crew-section.js', import.meta.url), 'utf8');
  assert.match(src, /input\.value = '';   \/\/ the code is never kept/);
  assert.doesNotMatch(src, /store\.set|setJSON/);
});
