// fc.roster v2 crew actions (Crew Intelligence Phase 1c, Stage A): request builders and STRICT
// response validators. Pure: no I/O, no storage, no logging.
//
// The wire contract is backend/apps-script/CrewApiV2.gs (allow-listed member fields) and
// CrewCoreV2.gs (states, reasons, match classes). Every validator builds a NEW deep-frozen value
// field by field from an exact key set; an unexpected key anywhere, a wrong type, enum or range,
// or any string shaped like a personnel identifier rejects the whole response. Backend semantics
// are copied, never derived: `history.state` and `history.indexingSuggested` are the backend's own,
// and nothing here upgrades a state or reads `indexingSuggested: false` as "complete".

import { validateCrewDiagnostics } from '../crew-diagnostics.js';
import { request } from './contract-v2.js';

/** Every error code a crew action may answer with (dispatcher, handlers and revocation). */
export const CREW_ERROR_CODES = Object.freeze([
  'not-configured', 'unauthorized', 'unsupported-contract', 'unknown-action', 'rate-limited', 'crew-disabled',
  'crew-not-enrolled', 'crew-revoked', 'busy', 'crew-unavailable', 'index-incompatible', 'bad-request', 'bad-range',
  'sector-not-found', 'sector-not-owned', 'revoke-incomplete', 'stale-request', 'enroll-closed',
]);

export const CREW_STATES = Object.freeze(['complete', 'incomplete', 'stale']);
export const CREW_REASONS = Object.freeze([
  'snapshot-unavailable', 'selected-duty-uncertain', 'index-inconsistent', 'stale-history', 'missing-records', 'grouping-uncertain',
]);
export const CREW_MATCHES = Object.freeze(['recorded', 'none', 'uncertain', 'stale', 'suppressed', 'unavailable']);
export const CREW_MAX_MEMBERS = 40;

const CODES = new Set(CREW_ERROR_CODES);
const STATES = new Set(CREW_STATES);
const REASONS = new Set(CREW_REASONS);
const MATCHES = new Set(CREW_MATCHES);
// Reasons that a backend "complete" answer can never carry (CrewCoreV2.gs fcv2CrewResult_).
const NOT_COMPLETE = new Set(['snapshot-unavailable', 'selected-duty-uncertain', 'index-inconsistent', 'stale-history', 'missing-records']);
const SECTOR_ID = /^s_[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANK = /^[A-Z]{2,3}$/;
const NAME = /^\p{L}[\p{L} .'’-]{0,39}$/u;
const DIGIT = /\d/;
const FLIGHT_NUMBER = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
const ROUTE = /^[A-Z]{3}-[A-Z]{3}$/;
// Every per-month outcome crewIndex can report (CrewApiV2.gs fcv2CrewHandleIndex_; CrewCoreV2.gs commit,
// touch and fail-closed paths). Anything else is rejected.
export const CREW_INDEX_OUTCOMES = Object.freeze([
  'not-sealable', 'busy', 'committed', 'verified', 'uncovered', 'replaceFailed', 'replaceFailed-unpersisted',
  'aborted-generation', 'aborted-conflict', 'index-incompatible', 'touch-failed',
]);
const OUTCOMES = new Set(CREW_INDEX_OUTCOMES);
// FCV2_CREW_INDEX_MAX_MONTHS_ (CrewApiV2.gs): months processed per crewIndex call.
export const CREW_INDEX_MAX_MONTHS = 6;
// Personnel-identifier shapes: 5+ consecutive digits, or 6 digits followed by a capital letter.
const IDENTIFIER_SHAPES = [/\d{5,}/, /\d{6}[A-Z]/];
const MAX_DEPTH = 8;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

class Reject extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const reject = (reason) => { throw new Reject(reason); };

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Exact key set: every required key present, nothing outside required + optional. */
function keys(obj, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) reject('unexpected-field');
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(obj, k)) reject('missing-field');
}

/** Rejects any string (keys included) shaped like a personnel identifier; `skip` holds exempt paths. */
function identityGuard(value, depth = 0, path = '', skip = new Set()) {
  if (depth > MAX_DEPTH) reject('too-deep');
  if (typeof value === 'string') {
    if (!skip.has(path) && IDENTIFIER_SHAPES.some((re) => re.test(value))) reject('identifier-shaped');
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (IDENTIFIER_SHAPES.some((re) => re.test(k))) reject('identifier-shaped');
    identityGuard(v, depth + 1, `${path}/${k}`, skip);
  }
}

function run(payload, build, skip, revokeRefusal = false) {
  try {
    if (!isObject(payload)) reject('not-an-object');
    if (payload.ok === false) return refusal(payload, revokeRefusal);
    if (payload.ok !== true) reject('not-ok');
    identityGuard(payload, 0, '', skip);
    return { ok: true, value: deepFreeze(build(payload)) };
  } catch (error) {
    if (error instanceof Reject) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'invalid' };
  }
}

/** A backend refusal is exactly {ok:false, error:<known code>} (+ state/remaining for a crewRevoke revoke-incomplete). */
function refusal(p, revokeRefusal) {
  const extra = revokeRefusal && p.error === 'revoke-incomplete' ? ['state', 'remaining'] : [];
  const allowed = new Set(['ok', 'error', ...extra]);
  if (Object.keys(p).some((k) => !allowed.has(k)) || typeof p.error !== 'string' || !CODES.has(p.error)) return { ok: false, reason: 'bad-refusal' };
  if ('state' in p && p.state !== 'revoking') return { ok: false, reason: 'bad-refusal' };
  if ('remaining' in p && !isCount(p.remaining)) return { ok: false, reason: 'bad-refusal' };
  return { ok: false, refused: p.error };
}

function name(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || DIGIT.test(v) || !NAME.test(v)) reject('bad-name');
  return v;
}

function last(v) {
  if (v === null) return null;
  if (!isObject(v)) reject('bad-last');
  keys(v, ['date', 'flightNumber', 'route']);
  if (!isDate(v.date)) reject('bad-last');
  if (typeof v.flightNumber !== 'string' || !FLIGHT_NUMBER.test(v.flightNumber)) reject('bad-last');
  if (typeof v.route !== 'string' || !ROUTE.test(v.route)) reject('bad-last');
  return { date: v.date, flightNumber: v.flightNumber, route: v.route };
}

function member(m) {
  if (!isObject(m)) reject('bad-member');
  keys(m, ['rank', 'family', 'given', 'match', 'count'], ['last', 'recordedMatch', 'asOfRecorded']);
  if (!(m.rank === null || (typeof m.rank === 'string' && RANK.test(m.rank)))) reject('bad-rank');
  const family = name(m.family);
  const given = name(m.given);
  if (typeof m.match !== 'string' || !MATCHES.has(m.match)) reject('bad-match');
  const out = { rank: m.rank, family, given, match: m.match, count: null };
  // An unreadable crew line carries no rank and no name, and never a match.
  if (family === null && given === null && (m.rank !== null || m.match !== 'unavailable')) reject('inconsistent-member');
  const has = (k) => Object.prototype.hasOwnProperty.call(m, k);
  if (has('last') && m.match !== 'recorded' && m.match !== 'none') reject('inconsistent-member');
  if (has('recordedMatch') && m.match !== 'uncertain') reject('inconsistent-member');
  if (has('asOfRecorded') && m.match !== 'stale') reject('inconsistent-member');
  switch (m.match) {
    case 'recorded':
      if (!isInt(m.count) || m.count < 1) reject('inconsistent-count');
      out.count = m.count;
      out.last = has('last') ? last(m.last) : null;
      break;
    case 'none':
      // CrewCoreV2.gs: count is the number of recorded groups, 0 for `none`; there is no last match.
      if (m.count !== 0) reject('inconsistent-count');
      if (has('last') && m.last !== null) reject('inconsistent-member');
      out.count = 0;
      out.last = null;
      break;
    case 'uncertain':
      if (m.count !== null) reject('inconsistent-count');
      if (typeof m.recordedMatch !== 'boolean') reject('inconsistent-member');
      out.recordedMatch = m.recordedMatch;
      break;
    case 'stale':
      if (m.count !== null) reject('inconsistent-count');
      if (!has('asOfRecorded') || !(m.asOfRecorded === null || isCount(m.asOfRecorded))) reject('inconsistent-member');
      out.asOfRecorded = m.asOfRecorded;
      break;
    default:   // suppressed, unavailable
      if (m.count !== null) reject('inconsistent-count');
  }
  return out;
}

function history(h) {
  if (!isObject(h)) reject('bad-history');
  keys(h, ['state', 'reasons', 'from', 'basis', 'indexingSuggested']);
  if (typeof h.state !== 'string' || !STATES.has(h.state)) reject('bad-state');
  if (!Array.isArray(h.reasons) || h.reasons.length > CREW_REASONS.length) reject('bad-reasons');
  const seen = new Set();
  for (const r of h.reasons) {
    if (typeof r !== 'string' || !REASONS.has(r) || seen.has(r)) reject('bad-reasons');
    seen.add(r);
  }
  if (h.state === 'complete' && h.reasons.some((r) => NOT_COMPLETE.has(r))) reject('inconsistent-history');
  if (!isDate(h.from)) reject('bad-history');
  if (h.basis !== 'recorded-duties') reject('bad-history');
  if (typeof h.indexingSuggested !== 'boolean') reject('bad-history');
  return { state: h.state, reasons: h.reasons.slice(), from: h.from, basis: h.basis, indexingSuggested: h.indexingSuggested };
}

// --- Requests ---------------------------------------------------------------------------------------

/** crewEnroll: the owner-issued code and a fresh device grant. */
export function crewEnrollRequest(token, code, grant) {
  return request('crewEnroll', token, { code, grant });
}

/** crewIndex: bounded indexing; optional `verifyBefore` (ms) and `retryUncovered` are sent only when given. */
export function crewIndexRequest(token, grant, { verifyBefore, retryUncovered, sessionVersion, diagnosticsVersion } = {}) {
  const extra = { grant };
  if (verifyBefore !== undefined) extra.verifyBefore = verifyBefore;
  if (retryUncovered !== undefined) extra.retryUncovered = retryUncovered;
  if (sessionVersion === 1) extra.sessionVersion = 1;
  if (diagnosticsVersion === 1) extra.diagnosticsVersion = 1;
  return request('crewIndex', token, extra);
}

/** crew: one owned sector on its roster date. */
export function crewRequest(token, grant, { sectorId, date }) {
  return request('crew', token, { grant, sectorId, date });
}

/** crewRevoke: idempotent revocation and deletion. */
export function crewRevokeRequest(token, grant, revokeId) {
  return request('crewRevoke', token, { grant, revokeId });
}

// --- Validators -------------------------------------------------------------------------------------

/**
 * Strict `crew` response. `sectorId` must equal the requested one (it is a sector hash, exempt from the
 * identifier guard only because it is compared for equality with the request).
 * @param {unknown} payload
 * @param {{sectorId:string}} query
 * @returns {{ok:true, value:object}|{ok:false, reason:string}|{ok:false, refused:string}}
 */
export function validateCrew(payload, { sectorId } = {}) {
  return run(payload, (p) => {
    keys(p, ['ok', 'contract', 'version', 'action', 'generatedAt', 'sectorId', 'crewListed', 'history', 'members']);
    if (p.contract !== 'fc.roster' || p.version !== 2) reject('contract-mismatch');
    if (p.action !== 'crew') reject('wrong-action');
    if (typeof p.generatedAt !== 'number' || !Number.isFinite(p.generatedAt)) reject('bad-generated-at');
    if (typeof sectorId !== 'string' || !SECTOR_ID.test(sectorId) || p.sectorId !== sectorId) reject('sector-mismatch');
    if (typeof p.crewListed !== 'boolean') reject('bad-crew-listed');
    if (!Array.isArray(p.members) || p.members.length > CREW_MAX_MEMBERS) reject('bad-members');
    const base = { ok: true, contract: p.contract, version: p.version, action: p.action, generatedAt: p.generatedAt, sectorId: p.sectorId };
    if (!p.crewListed) {
      if (p.history !== null || p.members.length !== 0) reject('inconsistent-unlisted');
      return { ...base, crewListed: false, history: null, members: [] };
    }
    return { ...base, crewListed: true, history: history(p.history), members: p.members.map(member) };
  }, new Set(['/sectorId']));
}

/**
 * Strict `crewIndex` response.
 * @returns {{ok:true, value:object}|{ok:false, reason:string}|{ok:false, refused:string}}
 */
export function validateCrewIndex(payload) {
  return run(payload, (p) => {
    keys(p, ['ok', 'action', 'processed', 'outcomes', 'progress', 'gcDeleted', 'cleanupPending'], ['session', 'diagnostics']);
    const extra = {};
    if (p.session !== undefined) {
      keys(p.session, ['version','initialOutstanding','remaining']);
      if (p.session.version !== 1 || !Number.isSafeInteger(p.session.initialOutstanding) || p.session.initialOutstanding < 0 || !Number.isSafeInteger(p.session.remaining) || p.session.remaining < 0) reject('bad-session');
      extra.session = { ...p.session };
    }
    if (p.diagnostics !== undefined) extra.diagnostics = validateCrewDiagnostics(p.diagnostics);
    if (p.action !== 'crewIndex') reject('wrong-action');
    if (!isCount(p.processed) || p.processed > CREW_INDEX_MAX_MONTHS) reject('bad-processed');
    if (!isObject(p.outcomes)) reject('bad-outcomes');
    const outcomes = {};
    let counted = 0;
    for (const [k, v] of Object.entries(p.outcomes)) {
      if (!OUTCOMES.has(k) || !Number.isInteger(v) || v < 1) reject('bad-outcomes');
      outcomes[k] = v;
      counted += v;
    }
    // Every processed month has exactly one outcome.
    if (counted !== p.processed) reject('bad-outcomes');
    if (!isObject(p.progress)) reject('bad-progress');
    keys(p.progress, ['total', 'indexed', 'pending', 'stale', 'uncovered']);
    const { total, indexed, pending, stale, uncovered } = p.progress;
    if (![total, indexed, pending, stale, uncovered].every(isCount)) reject('bad-progress');
    if (indexed + pending + stale + uncovered !== total) reject('bad-progress');
    if (extra.diagnostics?.complete && extra.diagnostics.months.length !== p.processed) reject('bad-diagnostic-count');
    if (!isCount(p.gcDeleted)) reject('bad-gc');
    if (typeof p.cleanupPending !== 'boolean') reject('bad-cleanup');
    return {
      ok: true, action: p.action, processed: p.processed, outcomes, ...extra,
      progress: { total, indexed, pending, stale, uncovered }, gcDeleted: p.gcDeleted, cleanupPending: p.cleanupPending,
    };
  });
}

/**
 * Strict `crewEnroll` response.
 * @returns {{ok:true, value:{ok:true, action:'crewEnroll', enrolled:true, G:number}}|{ok:false, reason:string}|{ok:false, refused:string}}
 */
export function validateCrewEnroll(payload) {
  return run(payload, (p) => {
    keys(p, ['ok', 'action', 'enrolled', 'G']);
    if (p.action !== 'crewEnroll') reject('wrong-action');
    if (p.enrolled !== true) reject('not-enrolled');
    if (!isInt(p.G) || p.G < 1) reject('bad-generation');
    return { ok: true, action: p.action, enrolled: true, G: p.G };
  });
}

/**
 * Strict `crewRevoke` response: deletion is confirmed only by {ok:true, state:'deleted'}. A cancellation
 * {ok:true, state:'cancelled', deletedKeys:0, recorded?:true} (the grant was not live and is now tombstoned, §8.7)
 * is accepted ONLY with {cancel:true}, i.e. when the backend advertised limits.crewCancel = 1; otherwise it is
 * rejected (the entry stays unresolved).
 * @param {unknown} payload
 * @param {{cancel?:boolean}} [options]
 * @returns {{ok:true, value:object}|{ok:false, reason:string}|{ok:false, refused:string}}
 */
export function validateCrewRevoke(payload, { cancel = false } = {}) {
  return run(payload, (p) => {
    keys(p, ['ok', 'action', 'state', 'deletedKeys'], ['recorded', 'cacheCleared']);
    if (p.action !== 'crewRevoke') reject('wrong-action');
    if (p.state === 'cancelled') {
      if (cancel !== true) reject('bad-state');
      if (p.deletedKeys !== 0) reject('bad-deleted-keys');
      if ('cacheCleared' in p) reject('unexpected-field');
      if ('recorded' in p && p.recorded !== true) reject('bad-recorded');
      return p.recorded === true ? { ok: true, action: p.action, state: 'cancelled', deletedKeys: 0, recorded: true }
        : { ok: true, action: p.action, state: 'cancelled', deletedKeys: 0 };
    }
    if (p.state !== 'deleted') reject('bad-state');
    if (!isCount(p.deletedKeys)) reject('bad-deleted-keys');
    if ('recorded' in p && p.recorded !== true) reject('bad-recorded');
    if ('cacheCleared' in p && p.cacheCleared !== false) reject('bad-cache-cleared');
    const out = { ok: true, action: p.action, state: 'deleted', deletedKeys: p.deletedKeys };
    if (p.recorded === true) out.recorded = true;
    if (p.cacheCleared === false) out.cacheCleared = false;
    return out;
  }, new Set(), true);
}
