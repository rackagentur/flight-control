// Synthetic data for the Crew Intelligence frontend tests (Phase 1c, Stage A). Everything is invented:
// placeholder names, made-up sector ids, a fake endpoint built at runtime, a deterministic byte source.
// Identifier-shaped strings are built at runtime (never stored as literals in the repository).
import { ApiError } from '../../src/api/appscript.js';

export const TOKEN = 'test-token-0123456789abcdef';
export const OTHER_TOKEN = 'test-token-fedcba9876543210';
export const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
export const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
export const SECTOR = 's_a1b2c3d4e5f6a7b8';
export const SECTOR_2 = 's_b2c3d4e5f6a7b8c9';
export const DATE = '2026-10-20';

/** A personnel-identifier-shaped string (6 digits + capital), built at runtime. */
export const idShaped = (n = 1) => String(300000 + n) + String.fromCharCode(65 + (n % 26));

/**
 * localStorage-like object backed by a Map. `faults.set`: true makes every write fail, a function (key, value)
 * => boolean fails selected writes. `faults.get`: optional (key, stored) => value override of a read (e.g. a
 * concurrent write by another tab between two reads); undefined keeps the stored value.
 */
export function memoryStorage() {
  const m = new Map();
  const faults = { set: false, get: null };
  return {
    map: m, faults,
    getItem: (k) => {
      const stored = m.has(k) ? m.get(k) : null;
      const over = typeof faults.get === 'function' ? faults.get(k, stored) : undefined;
      return over === undefined ? stored : over;
    },
    setItem: (k, v) => {
      if (faults.set === true || (typeof faults.set === 'function' && faults.set(k, String(v)))) throw new Error('quota');
      m.set(k, String(v));
    },
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/** Deterministic byte source: every call returns different bytes. */
export function seqRandom(seed = 1) {
  let n = seed;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) { n = (n * 1103515245 + 12345) >>> 0; out[i] = n >>> 24; }
    return out;
  };
}

/** The synthetic members of a listed sector, in backend order. */
export function sampleMembers() {
  return [
    { rank: 'CP', family: 'SAMPLE', given: 'ALEX', match: 'recorded', count: 3, last: { date: '2026-09-14', flightNumber: 'DE1234', route: 'FRA-PMI' } },
    { rank: 'FO', family: 'Example', given: 'Jordan', match: 'none', count: 0, last: null },
    { rank: 'PU', family: "O'BRIEN", given: 'ANA-LENA', match: 'uncertain', count: null, recordedMatch: true },
    { rank: 'FA', family: 'D’ARCY', given: 'JÖRG', match: 'stale', count: null, asOfRecorded: 2 },
    { rank: 'SEN', family: 'PLACEHOLDER', given: 'SAM', match: 'suppressed', count: null },
    { rank: 'FA', family: 'TESTPERSON', given: 'ROBIN', match: 'unavailable', count: null },
    { rank: null, family: null, given: null, match: 'unavailable', count: null },
  ];
}

/** A `crew` answer (listed sector) with optional overrides of the top level and of `history`. */
export function crewAnswer({ sectorId = SECTOR, state = 'complete', reasons = [], indexingSuggested = false, members = sampleMembers(), top = {} } = {}) {
  return {
    ok: true, contract: 'fc.roster', version: 2, action: 'crew', generatedAt: T0, sectorId, crewListed: true,
    history: { state, reasons, from: '2022-08-01', basis: 'recorded-duties', indexingSuggested },
    members, ...top,
  };
}

export const unlistedAnswer = (sectorId = SECTOR) => ({
  ok: true, contract: 'fc.roster', version: 2, action: 'crew', generatedAt: T0, sectorId, crewListed: false, history: null, members: [],
});

/** A `crewIndex` answer; `total` defaults to the sum of the parts (as the backend counts it). */
export function indexAnswer({ processed = 1, indexed = 5, pending = 3, stale = 1, uncovered = 1, total = indexed + pending + stale + uncovered } = {}) {
  return {
    ok: true, action: 'crewIndex', processed, outcomes: processed ? { committed: processed } : {},
    progress: { total, indexed, pending, stale, uncovered }, gcDeleted: 0, cleanupPending: false,
  };
}

export const enrollAnswer = (G = 1) => ({ ok: true, action: 'crewEnroll', enrolled: true, G });
export const revokeAnswer = (extra = {}) => ({ ok: true, action: 'crewRevoke', state: 'deleted', deletedKeys: 4, ...extra });
export const refusal = (error, extra = {}) => ({ ok: false, error, ...extra });

/** A promise resolved from outside. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Fake postContract: records every body; answers from `handler(body, n)` which may return a payload,
 * a promise of one, or throw (an ApiError for transport failures).
 */
export function fakePost(handler) {
  const bodies = [];
  const post = async (endpoint, body, options) => {
    bodies.push({ endpoint, body: JSON.parse(JSON.stringify(body)), timeoutMs: options?.timeoutMs });
    const data = await handler(body, bodies.length);
    return { data, meta: {} };
  };
  return { post, bodies, actions: () => bodies.map((b) => b.body.action) };
}

export const networkError = () => new ApiError('network', 'The roster backend could not be reached from this page (network or cross-origin policy).');
export const timeoutError = () => new ApiError('timeout', 'No response within 25 s.');

/** Settles pending promise chains (bounded; no real timers waited on beyond a few macrotasks). */
export async function flush(turns = 5) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

// --- The real simulated backend (CrewApiV2.gs handlers, not routed) ------------------------------------------

let crewGs = null;
async function loadCrewGs() {
  if (crewGs) return crewGs;
  const [{ readFileSync }, vm, { GS_FILES }] = await Promise.all([import('node:fs'), import('node:vm'), import('../gs-harness.js')]);
  const sandbox = { console };
  vm.createContext(sandbox);
  const dir = new URL('../../backend/apps-script/', import.meta.url);
  const code = [...GS_FILES, 'CrewCoreV2.gs', 'CrewCondorV2.gs', 'CrewApiV2.gs'].map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__x = { handle: fcv2CrewHandle_, config: FCV2_CONDOR_CONFIG_, capabilities: typeof fcv2CrewCapabilities_ === 'undefined' ? undefined : fcv2CrewCapabilities_, purgeAll: typeof fcv2CrewPurgeAll_ === 'undefined' ? undefined : fcv2CrewPurgeAll_ };`, sandbox);
  crewGs = sandbox.__x;
  return crewGs;
}

/**
 * The simulated crew backend (fcv2CrewHandle_) with fake Apps Script services and a few synthetic flights
 * (October 2026). `now` is the backend clock (ms). `handle(body)` answers a request body as plain JSON.
 * `legacyRevoke`: emulates the backend before Phase 1d.2A for a grant that is not live (answers 'stale-request',
 * or 'busy' while another grant's revocation runs, and writes no tombstone), so earlier protocol tests keep their
 * meaning. `capabilities` answers with fcv2CrewCapabilities_ (limits overridable for negotiation tests).
 * `faults`: { lockBusy, stateWrite: 'throw'|'lost'|(value) => 'throw'|'lost'|null for FC_CREW_STATE writes,
 * propsDel: (key) => true to make that Script Property deletion throw, cacheRemove: true to make removeAll throw }.
 */
export async function simulatedCrewBackend({ now, legacyRevoke = false, limits = undefined }) {
  const gs = await loadCrewGs();
  const syn = await import('./crew.synthetic.mjs');
  const deps = syn.handlerDeps();
  const props = new Map([['FC_CREW_ENABLED', 'on'], ['FC_CREW_PEPPER', 'synthetic-pepper-for-tests-0123456789'], ['FC_CREW_SELF', syn.synthId(999)]]);
  const cache = new Map();
  const store = syn.fakeStore();
  const at = (iso) => Date.parse(iso);
  const crew = [syn.owner(), syn.member(1, 'CP'), syn.member(2, 'FO')];
  const flights = [
    { sourceId: 'r-1', start: at('2026-10-02T06:00:00Z'), end: at('2026-10-02T08:30:00Z'), origin: 'FRA', destination: 'PMI', flightNumber: 'DE1501', crew },
    { sourceId: 'r-2', start: at('2026-10-15T06:00:00Z'), end: at('2026-10-15T08:30:00Z'), origin: 'FRA', destination: 'LPA', flightNumber: 'DE1503', crew },
  ];
  const faults = { lockBusy: false, stateWrite: null, propsDel: null, cacheRemove: false };
  const env = {
    token: () => TOKEN, now, config: gs.config,
    props: {
      get: (k) => (props.has(k) ? props.get(k) : null),
      set: (k, v) => {
        const fault = k !== 'FC_CREW_STATE' ? null : (typeof faults.stateWrite === 'function' ? faults.stateWrite(v) : faults.stateWrite);
        if (fault === 'throw') throw new Error('injected state write failure');
        if (fault === 'lost') return;   // accepted, but never persisted
        props.set(k, v);
      },
      del: (k) => {
        if (typeof faults.propsDel === 'function' && faults.propsDel(k)) throw new Error('injected property delete failure');
        props.delete(k);
      },
    },
    store,
    cache: {
      get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v),
      removeAll: (keys) => { if (faults.cacheRemove) throw new Error('injected cache failure'); keys.forEach((k) => cache.delete(k)); },
    },
    lock: (fn) => (faults.lockBusy ? { ok: false } : { ok: true, value: fn() }),
    readRaw: (from, to) => flights.filter((f) => f.end > from && f.start < to)
      .map((f) => syn.toRaw(f, { synced: f.start < syn.dayStart(deps.localDate(now())) })),
    deps,
  };
  return {
    /** Answers one request body (the roster token in the body is accepted when it equals TOKEN or OTHER_TOKEN). */
    handle(body) {
      const token = body.token === OTHER_TOKEN ? TOKEN : body.token;
      if (body.action === 'capabilities') {
        const crewPart = gs.capabilities ? gs.capabilities(env) : null;
        const answer = { ok: true, contract: 'fc.roster', version: 2, action: 'capabilities', actions: ['capabilities', 'roster', 'history'] };
        if (crewPart) {
          answer.actions = answer.actions.concat(crewPart.actions);
          const merged = limits === undefined ? crewPart.limits : limits;
          if (merged !== null) answer.limits = JSON.parse(JSON.stringify(merged));
        }
        return answer;
      }
      const before = props.get('FC_CREW_STATE');
      const out = JSON.parse(JSON.stringify(gs.handle(JSON.stringify({ ...body, token }), env)));
      if (legacyRevoke && body.action === 'crewRevoke' && out.ok && out.state === 'cancelled') {
        if (before === undefined) props.delete('FC_CREW_STATE'); else props.set('FC_CREW_STATE', before);
        const st = JSON.parse(before ?? '{"phase":"none"}');
        return { ok: false, error: st.phase === 'revoking' ? 'busy' : 'stale-request' };
      }
      return out;
    },
    /** Raw parsed FC_CREW_STATE (synthetic; assertions only). */
    state: () => JSON.parse(props.get('FC_CREW_STATE') ?? 'null'),
    props, store, cache, faults, env, gs,
    /** sha256 of a grant, truncated as in tombstones. */
    shortHash: (grant) => deps.hash(grant).slice(0, 32),
    /** The owner issues a single-use enrollment code valid for `ttlMs` (at most 15 min). */
    issueCode(code, ttlMs = 10 * 60000) { props.set('FC_CREW_ENROLL', `${code}|${now() + ttlMs}`); },
    phase: () => JSON.parse(props.get('FC_CREW_STATE') ?? '{"phase":"none"}').phase,
    /** True when `grant` is the backend's live grant right now (the backend keeps only its SHA-256). */
    isLive: (grant) => {
      const st = JSON.parse(props.get('FC_CREW_STATE') ?? '{"phase":"none"}');
      return st.phase === 'active' && st.grantHash === deps.hash(grant);
    },
    crewKeys: () => store.keys().filter((k) => k.startsWith('fcx.')),
    query: (i) => ({ sectorId: `s_${deps.hash(String(flights[i].sourceId)).slice(0, 16)}`, date: deps.localDate(flights[i].start) }),
  };
}

// --- Stage B: neutral synthetic codes (no real rank codes or airline flight prefix in UI fixtures) -----------

const NEUTRAL_RANKS = ['XA', 'XB', 'XC', 'XD', 'XE', 'XF'];
/** sampleMembers() with neutral rank codes (XA..XF) and the synthetic XQ flight prefix. */
export function neutralMembers() {
  return sampleMembers().map((m, i) => ({
    ...m,
    rank: m.rank === null ? null : NEUTRAL_RANKS[i],
    ...(m.last ? { last: { ...m.last, flightNumber: m.last.flightNumber.replace(/^DE/, 'XQ') } } : {}),
  }));
}
/** crewAnswer() with neutral members unless `members` is given. */
export const neutralCrewAnswer = (over = {}) => crewAnswer({ members: neutralMembers(), ...over });
