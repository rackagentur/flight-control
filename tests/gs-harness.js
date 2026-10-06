// Loads the fc.roster v2 Apps Script sources into one sandbox (as Apps Script does: one
// global scope) and provides Node implementations of the injected dependencies.
// Not a test file (no ".test." in the name).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

export const GS_FILES = ['CondorAdapterV2.gs', 'RosterModelV2.gs', 'AirportsV2.gs', 'RosterApiV2.gs', 'RouterV2.gs', 'CondorCodesV2.gs'];
// CondorCodesV2.gs is last on purpose: Apps Script appends a newly added file after the existing ones.
const dir = new URL('../backend/apps-script/', import.meta.url);

function part(ms, tz, opts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', ...opts }).formatToParts(new Date(ms))
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}
export function localDate(ms, tz) {
  const p = part(ms, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}
export function localIso(ms, tz) {
  const p = part(ms, tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const off = Math.round((local - (ms - (ms % 60000))) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Minimal Utilities fake for the two patterns the live env formats with. */
const Utilities = {
  formatDate(date, tz, pattern) {
    if (pattern === 'yyyy-MM-dd') return localDate(date.getTime(), tz);
    if (pattern === "yyyy-MM-dd'T'HH:mmXXX") return localIso(date.getTime(), tz).replace(/\+00:00$/, 'Z'); // as Apps Script does
    throw new Error(`pattern not faked: ${pattern}`);
  },
};

export function loadGs() {
  const sandbox = { Utilities, console };
  vm.createContext(sandbox);
  const code = GS_FILES.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__gs = { FCV2_CONDOR_CONFIG_, FCV2_CONDOR_CODES_, FCV2_AIRPORT_TZ_, fcv2ClassifyEvent_, fcv2ParseDescription_, fcv2BuildRoster_, fcv2BuildHistory_, fcv2HandlePost_, fcv2SafeEqual_, fcv2StartOfDay_, fcv2LocalIso_, fcv2Range_, FCV2_HISTORY_MAX_SECTORS_, fcv2HandleGet_, FCV2_GET_REFUSED_ };`, sandbox);
  return sandbox.__gs;
}

export function nodeDeps(gs, hotelLookup = null) {
  return {
    hash: (s) => createHash('sha256').update(s).digest('hex'),
    localIso,
    localDate,
    tzOf: (iata) => (Object.hasOwn(gs.FCV2_AIRPORT_TZ_, iata) ? gs.FCV2_AIRPORT_TZ_[iata] : null),
    hotelLookup,
  };
}

/** Node version of the live Sheet lookup rules (VERIFIED + name + airport + this stay's source id). */
export function sheetLookup(rows) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return (sourceId, name, airportCode) => {
    if (!airportCode) return null;
    const r = rows.find((x) => norm(x[0]) === norm(name) && String(x[1]).toUpperCase() === airportCode
      && String(x[10]).split('|').map((s) => s.trim()).includes(String(sourceId)) && x[12] === 'VERIFIED');
    return r ? { lat: Number(r[4]), lon: Number(r[5]), mapsUrl: r[6] || null, placeId: r[11] || null } : null;
  };
}

/** A fake env for fcv2HandlePost_. */
export function fakeEnv(gs, { token = 'test-token-0123456789abcdef', now, feed = [], synced = [], rows = [] } = {}) {
  const cache = new Map();
  let failures = 0;
  const calls = { airline: [], synced: [], stats: 0 };
  const config = gs.FCV2_CONDOR_CONFIG_;
  const inRange = (list, from, to) => list.filter((e) => e.end > from && e.start < to);
  return {
    calls,
    cache,
    env: {
      config,
      token: () => token,
      now: () => now,
      stats: () => { calls.stats += 1; return { success: true, upcoming: [], marker: 'v5-payload' }; },
      failures: { get: () => failures, add: () => { failures += 1; } },
      startOfDay: (key) => gs.fcv2StartOfDay_(key, config.baseTimeZone),
      airlineEvents: (from, to) => { calls.airline.push([from, to]); return inRange(feed, from, to); },
      syncedEvents: (from, to) => { calls.synced.push([from, to]); return inRange(synced, from, to); },
      cacheGet: (k) => cache.get(k) ?? null,
      cachePut: (k, v) => cache.set(k, v),
      deps: nodeDeps(gs, sheetLookup(rows)),
    },
  };
}
