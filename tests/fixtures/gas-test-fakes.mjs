// Fake Apps Script services for the isolated GAS test package (tests/gas-test-package.test.js). Node only;
// synthetic data only. Builds on tests/fixtures/crew-gas-fakes.mjs (Properties, Cache, Lock, Session,
// Utilities, ContentService) and adds what that file lacks: a world of fake calendars that can be written,
// calendar OAuth scope enforcement (calendar.readonly vs calendar), a userinfo.email gate for Session, and
// loaders that run a BUILT bundle string (not the raw files) in a vm sandbox.
// Not a test file (no ".test." in the name).
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { gasFakes } from './crew-gas-fakes.mjs';

export const SCOPE_READ = 'https://www.googleapis.com/auth/calendar.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar';
export const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

export const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
/** Deterministic hex built at runtime (no token-shaped literal is ever stored in the repository). */
export const hex = (label, n = 64) => sha(`fct-test|${label}`).slice(0, n);

export const NAMES = { feed: 'FC-TEST Airline Feed', synced: 'FC-TEST Synced Roster' };
export const MARKER = hex('marker', 32);
export const OWNER = 'owner@example.invalid';
/** The synthetic owner id form: "99" + four digits + "X" (assembled so no 6-digit+letter literal exists here). */
export const SELF = ['99', '0000', 'X'].join('');

export const IDS = {
  feed: `fake-feed-${hex('feed', 12)}`,
  synced: `fake-synced-${hex('synced', 12)}`,
  prodFeed: `fake-prod-feed-${hex('pf', 12)}`,
  prodSynced: `fake-prod-synced-${hex('ps', 12)}`,
  personal: `fake-personal-${hex('pe', 12)}`,
};

/** A world of fake calendars shared by several sandboxes (the seeder project writes, the API project reads). */
export function makeWorld() {
  // hooks.before(info) runs before a mutation is applied (throwing = a platform failure, nothing applied; or it may
  // change the world); hooks.after(info) runs after it was applied (throwing = the process died right after the
  // write). info = { op, calId, tag, n } with n the number of mutations applied so far. mutations counts them.
  const world = { calendars: new Map(), writes: [], seq: 0, mutations: 0, reads: 0, hooks: { before: null, after: null, read: null } };
  const add = (id, { name, description = '', owned = true }) => {
    world.calendars.set(id, { id, name, description, owned, events: [] });
    return world.calendars.get(id);
  };
  add(IDS.feed, { name: NAMES.feed, description: `synthetic\nfc-test-marker:${MARKER}` });
  add(IDS.synced, { name: NAMES.synced, description: `synthetic\nfc-test-marker:${MARKER}` });
  add(IDS.prodFeed, { name: 'Airline duty plan', description: 'production-like calendar (fake)' });
  add(IDS.prodSynced, { name: 'My synced roster', description: 'production-like calendar (fake)' });
  add(IDS.personal, { name: 'Personal', description: '' });
  world.add = add;
  /** A direct (untagged, "personal") event, as a person would add one by hand. */
  world.addEvent = (calId, { title, start, end, description = '', location = '', tags = {} }) => {
    world.seq += 1;
    const rec = { id: `evt-${world.seq}@fake.invalid`, title, start, end, description, location, tags: new Map(Object.entries(tags)) };
    world.calendars.get(calId).events.push(rec);
    return rec;
  };
  return world;
}

/** One mutation: scope check, before hook, apply (recorded in world.writes), after hook. */
function mutate(world, cal, scopes, spies, op, detail, apply) {
  if (!scopes.includes(SCOPE_WRITE)) { spies.denied.push(op); throw new Error(`scope: ${op} needs calendar`); }
  const info = { op, calId: cal.id, ...detail, n: world.mutations };
  if (world.hooks.before) world.hooks.before(info);
  world.writes.push([cal.id, op]);
  world.mutations += 1;
  const result = apply();
  if (world.hooks.after) world.hooks.after({ ...info, n: world.mutations });
  return result;
}

function eventApi(world, cal, rec, scopes, spies) {
  const doMutate = (op, detail, apply) => mutate(world, cal, scopes, spies, op, detail, apply);
  return {
    getId: () => rec.id,
    getOriginalCalendarId: () => rec.originalCalendarId ?? cal.id,
    getTitle: () => rec.title,
    getStartTime: () => new Date(rec.start),
    getEndTime: () => new Date(rec.end),
    getLocation: () => rec.location,
    getDescription: () => rec.description,
    getTag: (k) => (rec.tags.has(k) ? rec.tags.get(k) : null),
    setTag: (k, v) => doMutate('setTag', { tag: k }, () => { rec.tags.set(k, String(v)); }),
    setTime: (s, e) => doMutate('setTime', {}, () => { rec.start = s.getTime(); rec.end = e.getTime(); }),
    setDescription: (d) => doMutate('setDescription', {}, () => { rec.description = String(d); }),
    deleteEvent: () => doMutate('deleteEvent', {}, () => { cal.events.splice(cal.events.indexOf(rec), 1); }),
  };
}

function calendarApi(world, cal, scopes, spies, faults) {
  const needRead = (op) => {
    if (!scopes.includes(SCOPE_READ) && !scopes.includes(SCOPE_WRITE)) { spies.denied.push(op); throw new Error(`scope: ${op} needs calendar.readonly`); }
  };
  return {
    getId: () => cal.id,
    getName: () => { needRead('getName'); return cal.name; },
    getDescription: () => { needRead('getDescription'); return cal.description; },
    isOwnedByMe: () => { needRead('isOwnedByMe'); return cal.owned; },
    getEvents: (from, to) => {
      needRead('getEvents');
      if (faults.getEvents) throw new Error(`calendar read failed for ${cal.id}`);   // a message that holds an id: must never leak
      spies.reads.push([cal.id, from.getTime(), to.getTime()]);
      const list = cal.events.filter((e) => e.end > from.getTime() && e.start < to.getTime()).sort((a, b) => a.start - b.start)
        .map((r) => eventApi(world, cal, r, scopes, spies));
      world.reads += 1;
      if (world.hooks.read) world.hooks.read({ calId: cal.id, n: world.reads });
      return list;
    },
    createEvent: (title, start, end, options = {}) => mutate(world, cal, scopes, spies, 'createEvent', {}, () => {
      world.seq += 1;
      const rec = { id: `evt-${world.seq}@fake.invalid`, title, start: start.getTime(), end: end.getTime(), description: options.description ?? '', location: options.location ?? '', tags: new Map() };
      cal.events.push(rec);
      return eventApi(world, cal, rec, scopes, spies);
    }),
  };
}

/**
 * The sandbox globals of one project. scopes: the manifest's oauthScopes (enforced by the calendar and Session
 * fakes; UrlFetchApp and SpreadsheetApp are never granted). clock: { t } fixed time. The production-project
 * constants and getFlightStats are deliberately NOT provided: the bundle must define them itself.
 */
export function servicesFor(world, { scopes, script = {}, user = {}, email = OWNER, clock, lockBusy = false }) {
  const base = gasFakes({ script, user, email, lockBusy });
  const spies = { ...base.spies, denied: [], reads: [], fetch: 0, spreadsheet: 0, sessionDenied: 0 };
  const faults = { getEvents: false, lookup: false };
  const g = { ...base.globals };
  for (const k of ['SOURCE_CALENDAR_ID', 'TARGET_CALENDAR_ID', 'SYNC_PROPERTY_KEY', 'HOTEL_SPREADSHEET_ID', 'HOTEL_SHEET_NAME', 'getFlightStats']) delete g[k];
  g.CalendarApp = {
    getCalendarById: (id) => {
      if (!scopes.includes(SCOPE_READ) && !scopes.includes(SCOPE_WRITE)) { spies.denied.push('getCalendarById'); throw new Error('scope: calendar'); }
      if (faults.lookup) throw new Error(`calendar lookup failed for ${id}`);
      const cal = world.calendars.get(id);
      return cal ? calendarApi(world, cal, scopes, spies, faults) : null;
    },
  };
  g.UrlFetchApp = { fetch: () => { spies.fetch += 1; throw new Error('scope: external request not granted'); } };
  g.SpreadsheetApp = { openById: () => { spies.spreadsheet += 1; throw new Error('scope: spreadsheets not granted'); } };
  const session = base.globals.Session;
  g.Session = {
    getEffectiveUser: () => {
      if (!scopes.includes(SCOPE_EMAIL)) { spies.sessionDenied += 1; throw new Error('scope: userinfo.email'); }
      return session.getEffectiveUser();
    },
  };
  class FixedDate extends Date { static now() { return clock.t; } }
  g.Date = FixedDate;
  return { globals: g, spies, faults, scriptProps: base.scriptProps, userProps: base.userProps, cache: base.cache, base };
}

/** Runs a built bundle in a fresh vm sandbox and returns { t, sandbox }: t holds the requested names. */
export function loadBundle(source, globals, names) {
  const sandbox = { ...globals };
  vm.createContext(sandbox);
  const exported = names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ');
  vm.runInContext(`${source}\n;globalThis.__t = { ${exported} };`, sandbox);
  return { t: sandbox.__t, sandbox };
}

/** Script Properties of a correctly configured API project (override or remove with undefined). */
export function apiProps(over = {}) {
  const props = {
    FCT_ISOLATED: 'fc-test-isolated-v1', FCT_MARKER: MARKER,
    FCT_DENY_SHA256: `${sha(IDS.prodFeed)},${sha(IDS.prodSynced)}`,
    FCT_CAL_FEED_ID: IDS.feed, FCT_CAL_SYNCED_ID: IDS.synced,
    FC_V2_TOKEN: `fctest_${hex('token')}`, FC_CREW_PEPPER: `fctest_pepper_${hex('pepper')}`,
    FC_CREW_SELF: SELF, FC_CREW_OWNER: OWNER, FC_CREW_ENABLED: 'on',
    ...over,
  };
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
}

/** Script Properties of a correctly configured seeder project. */
export function seederProps(over = {}) {
  const props = {
    FCT_ISOLATED: 'fc-test-isolated-v1', FCT_MARKER: MARKER,
    FCT_DENY_SHA256: `${sha(IDS.prodFeed)},${sha(IDS.prodSynced)}`,
    FCT_CAL_FEED_ID: IDS.feed, FCT_CAL_SYNCED_ID: IDS.synced,
    FCT_SEED_CONFIRM: 'SEED-SYNTHETIC-ONLY',
    ...over,
  };
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined));
}

/**
 * Fault injection helpers (the seeder tests). Each returns nothing; hooks are replaced, not stacked.
 *   crashAfter(world, pred)   the process dies right after the first mutation matching pred was applied (once)
 *   failBefore(world, pred)   the first mutation matching pred is refused by the platform (nothing applied, once)
 *   afterNth(world, n, fn)    fn() runs right after the nth applied mutation (the world changes under the run)
 *   beforeOp(world, pred, fn) fn() runs right before the first mutation matching pred (the world changes)
 */
export function crashAfter(world, pred) {
  let done = false;
  world.hooks.after = (info) => { if (!done && pred(info)) { done = true; throw new Error('process died after the write'); } };
}
export function failBefore(world, pred) {
  let done = false;
  world.hooks.before = (info) => { if (!done && pred(info)) { done = true; throw new Error('platform refused the write'); } };
}
export function afterNth(world, n, fn) {
  let done = false;
  world.hooks.after = (info) => { if (!done && info.n === n) { done = true; fn(info); } };
}
export function beforeOp(world, pred, fn) {
  let done = false;
  world.hooks.before = (info) => { if (!done && pred(info)) { done = true; fn(info); } };
}
export function afterNthRead(world, n, fn) {
  let done = false;
  world.hooks.read = (info) => { if (!done && info.n === n) { done = true; fn(info); } };
}
export const clearHooks = (world) => { world.hooks.before = null; world.hooks.after = null; world.hooks.read = null; };
