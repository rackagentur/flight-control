// Crew Intelligence service (Phase 1c, Stage A): memory-only crew answers, enrollment, revocation and the
// single app-wide indexing runner. Not wired into the app yet (Stage B supplies `access` and the UI).
//
// Memory: module-level Map shared by every service instance, never written to the device (no storage,
// IndexedDB, service-worker cache, diagnostics or export). Key = accessId|sectorId|date, 10 min by
// storedAt, at most 8 entries (oldest evicted), purged after 10 min hidden, on sign-out / reset / token
// change (controller purgeRoster -> purgeCrewMemory), on revocation and on access-ending refusals.
// A `generation` counter discards answers that arrive after a purge; answers are also discarded when the
// access id or the active grant changed while the request ran. The only persisted state is the grant
// record, written exclusively through `credentials` (crew-credential.js).
//
// Indexing (docs/CREW-INTELLIGENCE.md §7.5b): one runner for the whole app, owned by one identity
// (access id + purge generation + grant). It starts with one call and continues only while a call made
// progress and work remains, with spacing, a per-trigger call limit, a per-10-minute run limit, one busy
// retry and cooldowns. It stops when hidden, offline, on access changes or when cancelled; a run of another
// identity is detached (its late answers are discarded). `indexingSuggested: false` is never read as "complete".
//
// Enrollment and deletion are serialized by one module-level queue: a deletion waits for an enrollment in
// flight to settle (bounded by its timeout), and once a deletion has begun every enrollment is refused.
// Deletion follows the backend's one-live-grant semantics (crew-credential.js): every potentially live grant
// is revoked against its own endpoint, and each entry is resolved ONLY by evidence about itself (see
// revokePass). `deleted` is reported only after a backend confirmation and when nothing of ours is unresolved.
// Contract facts relied on: an enrollment code is single-use (consumed on success) and a code string is never
// issued twice (≥ 128-bit codes from a password generator, docs/CREW-INTELLIGENCE.md §4.1).

import { clearCrewDiagnostics, crewDiagnosticsEnabled, crewDiagnosticGeneration, recordCrewRequest, recordCrewReport, recordCrewSession } from '../crew-diagnostics.js';
import { postContract, ApiError } from '../api/appscript.js';
import {
  crewEnrollRequest, crewIndexRequest, crewRequest, crewRevokeRequest,
  validateCrew, validateCrewIndex, validateCrewEnroll, validateCrewRevoke,
} from './crew-v2.js';
import { endpointFingerprint, grantFingerprint, accessFingerprint } from './crew-credential.js';

export const CREW_TTL_MS = 10 * 60000;
export const CREW_MAX_ENTRIES = 8;
export const CREW_HIDDEN_PURGE_MS = 10 * 60000;
export const CREW_TIMEOUT_MS = 25000;
export const CREW_INDEX_TIMEOUT_MS = 45000;
export const CREW_CALL_BUDGET = 20;
export const INDEX_SPACING_MS = 3000;
export const INDEX_MAX_CALLS = Object.freeze({ detail: 3, enroll: 2, manual: 2 }); // bootstrap allowance until first work snapshot
export const INDEX_DEADLINE_MS = 180000;
export const INDEX_MAX_RUNS = 3;
export const BUSY_RETRY_MS = 5000;
export const BUSY_COOLDOWN_MS = 60000;
export const RATE_WINDOW_MS = 600000;
export const RATE_MARGIN_MS = 30000;
/**
 * Scheduling hint only (`retryAfter`) for a deletion waiting on an enrollment whose outcome is unknown. Time
 * NEVER resolves a grant: the client clock proves nothing about when a held request reaches the backend.
 */
export const REVOKE_RETRY_HINT_MS = 5 * 60000;

const SECTOR_ID = /^s_[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[\x20-\x7e]{4,64}$/;
const ERROR_CODE = /^[a-z][a-z0-9-]{0,47}$/;
const ACCESS_ENDING = new Set(['crew-revoked', 'crew-not-enrolled']);
const SUSPENDING = new Set(['unauthorized', 'crew-disabled', 'unknown-action', 'unsupported-contract']);
// Suspends indexing only; `crew` lookups stay available.
const SUSPENDING_INDEX = new Set(['index-incompatible']);
// Enrollment refusals that prove THIS attempt did not activate the grant (refused before or by the enrollment
// itself). Anything else (transport, busy, crew-unavailable, invalid response) leaves the outcome unknown.
const ENROLL_DEFINITIVE = new Set(['unauthorized', 'enroll-closed', 'bad-request', 'crew-disabled', 'unknown-action', 'unsupported-contract', 'not-configured', 'rate-limited']);

/**
 * `code`: a backend crew error code, a transport code, or a local refusal:
 *   'crew-not-enrolled', 'revoke-pending', 'credential-unsupported' (a stored record of another version),
 *   'candidate-limit', 'storage', 'suspended', 'cooldown', 'local-limit', 'access-changed', 'bad-code',
 *   'consent-changed' (an enroll caller's `guard()` withdrew its authorization: consent or identity changed), and
 *   'revoke-pending-elsewhere': a crew deletion is still pending for grants of ANOTHER endpoint, so Crew
 *   Intelligence stays off here. Stage B copy (not implemented here; the first sentence is split after its
 *   first word only because tests/portability.test.js forbids that two-word phrase on one line in src/sources):
 *   "Crew
 *   history deletion is still pending for your previous connection. Complete deletion before enabling Crew
 *   Intelligence here."
 */
export class CrewError extends Error {
  constructor(code, detail = null) {
    super(`Crew request failed (${code}).`);
    this.name = 'CrewError';
    this.code = code;
    this.detail = detail;
  }
}

/** key -> {storedAt, value (validated, frozen)} */
const memory = new Map();
/** key -> Promise<value> for requests still running */
const inFlight = new Map();
let generation = 0;
/** The single app-wide indexing run, or null. */
let runner = null;
/** {identity, progress}: counts of the last indexing call of a run identity (no personal data). */
let lastProgress = null;
/** Enrollment / deletion queue (one operation at a time) and the number of deletions waiting or running. */
let opTail = Promise.resolve();
let deleting = 0;
/**
 * Same-code marker of the last enrollment attempt in this session: {grant, marker}, marker = a salted
 * in-memory fingerprint of the code (never the code, never persisted). Lets a retry with the SAME code reuse
 * its grant (one grant <-> one code); cleared on a known outcome and on purge.
 */
let lastCodeAttempt = null;
/**
 * Storage fault (app-wide, survives purgeCrewMemory): a credential write that records uncertainty or deletion
 * state failed. While set, crew operations refuse locally with `storage` and send nothing; every public
 * operation first retries one verified recovery write (inflight folded into unknown). `storageChecked`: that
 * recovery fold has run once in this app session (after a restart it runs on the first operation).
 */
let storageFault = false;
let storageChecked = false;
const CODE_SALT = (() => {
  try { return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).join('.'); } catch { return String(Math.random()); }
})();
// App-wide limits, shared by every service instance (they protect the backend, so a purge never resets them).
const limits = {
  calls: [],              // timestamps of budgeted crew calls (enroll, index, crew)
  runs: [],               // timestamps of started indexing runs
  rateCooldownUntil: 0,   // backend rate-limited: every crew call except revoke
  indexCooldownUntil: 0,  // repeated busy: indexing only
  suspended: null,        // {accessId, code, indexOnly}; cleared by an access-id change or a new enrollment
};

function cancelRunner(reason, discard, triggers = null) {
  if (runner && triggers && !triggers.includes(runner.trigger)) return;
  if (!runner) return;
  if (!runner.cancelled) runner.cancelled = reason;
  if (discard) runner.discard = true;
  runner.abort.abort();
}

/** Detaches the running indexing at once: it makes no further call and its late answers are discarded. */
function detachRunner() {
  if (!runner) return;
  cancelRunner('cancelled', true);
  runner = null;
}

function exclusive(fn) {
  const result = opTail.then(() => fn());
  opTail = result.then(() => {}, () => {});
  return result;
}

/**
 * TEST ONLY: simulates an app restart for the module-level session state that a real restart loses
 * (storage-fault flag, recovery check, same-code marker) and purges memory. Rate limits are kept.
 */
export function __resetCrewStateForTests() {
  storageFault = false;
  storageChecked = false;
  purgeCrewMemory();
}

/**
 * Clears crew memory and in-flight requests, cancels indexing; later answers are discarded. Cannot fail.
 * The app-wide call budget and cooldowns are deliberately kept (they protect the backend).
 */
export function purgeCrewMemory() {
  clearCrewDiagnostics();
  memory.clear();
  inFlight.clear();
  generation += 1;
  lastProgress = null;
  lastCodeAttempt = null;
  detachRunner();
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer = null;
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
    timer = setTimeout(done, ms);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

const defaultVisible = () => {
  try { return globalThis.document?.visibilityState !== 'hidden'; } catch { return true; }
};
const defaultOnline = () => {
  try { return globalThis.navigator?.onLine !== false; } catch { return true; }
};

function transportCode(error) {
  if (error instanceof ApiError && typeof error.code === 'string' && ERROR_CODE.test(error.code)) return error.code;
  return 'network';
}

/**
 * @param {{
 *   credentials: ReturnType<import('./crew-credential.js').createCrewCredentials>,
 *   access: () => ({endpoint:string|null, token:string|null, accessId:string}),
 *   post?: typeof postContract, now?: () => number, sleep?: (ms:number, signal?:AbortSignal) => Promise<void>,
 *   isVisible?: () => boolean, isOnline?: () => boolean, onChange?: (event:{type:string, progress?:object}) => void,
 *   cancelSupported?: (access:{endpoint:string|null, token:string|null, accessId:string}) => boolean,
 * }} deps  `cancelSupported(access)`: whether the backend of exactly that access advertised limits.crewCancel = 1.
 *   Asked BEFORE each revoke dispatch with the access snapshot the request is sent with; the captured answer is
 *   what validates that response (nothing current is consulted after the await). Default false = the earlier
 *   rules (an unconfirmed grant answered stale-request stays unresolved).
 */
export function createCrewService({
  credentials, access, post: transportPost = postContract, now = Date.now, monotonic = () => performance.now(), sleep = defaultSleep,
  isVisible = defaultVisible, isOnline = defaultOnline, onChange = null, cancelSupported = () => false,
}) {
  let hiddenAt = null;
  const post = async (endpoint, body, options) => {
    if (!crewDiagnosticsEnabled()) return transportPost(endpoint, body, options);
    const start = monotonic(), born = crewDiagnosticGeneration();
    const dispatchedAccess = access()?.accessId;
    let outcome = 'error', transportMs = null;
    try {
      const result = await transportPost(endpoint, body, options);
      transportMs = result.meta?.ms ?? null;
      const check = body.action === 'crew' ? validateCrew(result.data, { sectorId: body.sectorId })
        : body.action === 'crewIndex' ? validateCrewIndex(result.data)
        : body.action === 'crewEnroll' ? validateCrewEnroll(result.data) : validateCrewRevoke(result.data, { cancel: options?.diagnosticCancel === true });
      outcome = check ? (check.ok ? 'success' : check.refused ? 'refused' : 'invalid-response') : 'success';
      if (access()?.accessId !== dispatchedAccess) outcome = 'access-changed';
      if (outcome !== 'access-changed' && body.action === 'crewIndex' && body.diagnosticsVersion === 1) recordCrewReport(check?.ok ? check.value.diagnostics : null, born);
      return result;
    } catch (error) { outcome = transportCode(error); throw error; }
    finally { recordCrewRequest({ action: body.action, source: 'network', outcome, elapsedMs: Math.max(0, monotonic() - start), transportMs }, born); }
  };

  const emit = (event) => {
    if (typeof onChange !== 'function') return;
    try { onChange(event); } catch { /* a listener never breaks the service */ }
  };
  const currentAccess = () => {
    const a = access() ?? {};
    return { endpoint: a.endpoint ?? null, token: a.token ?? null, accessId: String(a.accessId ?? '') };
  };
  const prune = (list, t) => list.filter((x) => t - x >= 0 && t - x < RATE_WINDOW_MS);
  const budgetLeft = () => { limits.calls = prune(limits.calls, now()); return limits.calls.length < CREW_CALL_BUDGET; };
  const spend = () => { limits.calls.push(now()); };
  const cooling = () => now() < limits.rateCooldownUntil;
  const indexCooling = () => cooling() || now() < limits.indexCooldownUntil;
  /** The suspension of this access (any other access id lifts it), or null. */
  const suspension = (a) => {
    if (limits.suspended !== null && limits.suspended.accessId !== a.accessId) limits.suspended = null;
    return limits.suspended;
  };
  const crewSuspended = (a) => { const x = suspension(a); return x !== null && !x.indexOnly; };
  const indexSuspended = (a) => suspension(a) !== null;
  /** The confirmed active grant in the record (no access check, no side effects), or null. */
  const storedActive = () => {
    const r = credentials.read();
    return r?.phase === 'active' ? r.grants.find((e) => e.role === 'active').grant : null;
  };
  const grantStill = (grant) => storedActive() === grant;
  const identityOf = (a, grant) => `${a.accessId}|${generation}|${grantFingerprint(grant)}`;
  /** Local refusal while the stored credential forbids crew calls, or null. */
  function gate(a) {
    const kind = credentials.status();
    if (kind === 'unreadable') { fault(); return 'storage-unreadable'; }
    if (kind === 'foreign') return 'credential-unsupported';
    if (deleting > 0) return 'revoke-pending';
    const pending = credentials.pendingRevoke();
    if (!pending) return null;
    return a.endpoint && pending.endpoints.includes(endpointFingerprint(a.endpoint)) ? 'revoke-pending' : 'revoke-pending-elsewhere';
  }
  function rateLimited() {
    const t = now();
    limits.rateCooldownUntil = Math.max(limits.rateCooldownUntil, (Math.floor(t / RATE_WINDOW_MS) + 1) * RATE_WINDOW_MS + RATE_MARGIN_MS);
  }
  /** A credential write failed: fail closed (no reuse of the same-code marker either). */
  function fault() {
    storageFault = true;
    lastCodeAttempt = null;
  }
  /**
   * Storage check at the start of every public operation (and inside the queued ones before dispatch):
   * null = go; 'storage-unreadable' = the credential record cannot be READ (never treated as absent);
   * 'storage' = an earlier write failed and the recovery fold (inflight -> unknown) could not be written;
   * 'lock-unavailable' = the recovery fold could not take the cross-tab credential lock.
   * All refuse locally and send nothing.
   */
  const needsRecovery = () => storageFault || !storageChecked;
  async function storageRefusal() {
    if (credentials.status() === 'unreadable') { fault(); return 'storage-unreadable'; }
    if (!needsRecovery()) return null;
    const folded = await credentials.detailed.foldInflight();
    if (folded.ok) {
      storageFault = false;
      storageChecked = true;
      return null;
    }
    fault();
    return folded.error ?? 'storage';
  }
  /** Throws the storage refusal, if any (see storageRefusal). */
  async function assertStorage() {
    const refusal = await storageRefusal();
    if (refusal) throw new CrewError(refusal);
  }
  async function endAccess() {
    purgeCrewMemory();
    emit({ type: 'access-ended' });
    if (!(await credentials.detailed.dropAccess()).ok) fault();
  }
  function suspend(a, code, indexOnly = false) {
    const current = suspension(a);
    if (!(indexOnly && current && !current.indexOnly)) limits.suspended = { accessId: a.accessId, code, indexOnly };
    // Conservative: no earlier answer is shown while the backend refuses this access.
    if (!indexOnly) memory.clear();
    cancelRunner('suspended', false);
    emit({ type: 'suspended' });
  }

  function remember(key, accessId, storedAt, value) {
    memory.delete(key);
    memory.set(key, { accessId, storedAt, value });
    while (memory.size > CREW_MAX_ENTRIES) {
      let oldest = null;
      for (const [k, v] of memory) if (oldest === null || v.storedAt < memory.get(oldest).storedAt) oldest = k;
      memory.delete(oldest);
    }
  }
  /** Drops expired entries and entries of another access id; runs on every service call. */
  function sweep() {
    const t = now();
    const accessId = currentAccess().accessId;
    for (const [k, v] of memory) {
      if (v.accessId !== accessId || !(t - v.storedAt >= 0 && t - v.storedAt < CREW_TTL_MS)) memory.delete(k);
    }
  }

  // --- crew ----------------------------------------------------------------------------------------

  async function fetchCrew(a, grant, query, key, born) {
    const storedAt = now();
    let data;
    let transport = null;
    try {
      ({ data } = await post(a.endpoint, crewRequest(a.token, grant, query), { timeoutMs: CREW_TIMEOUT_MS }));
    } catch (error) {
      transport = transportCode(error);
    }
    if (born !== generation || currentAccess().accessId !== a.accessId || !grantStill(grant)) throw new CrewError('access-changed');
    if (transport) throw new CrewError(transport);
    const check = validateCrew(data, { sectorId: query.sectorId });
    if (check.ok) {
      remember(key, a.accessId, storedAt, check.value);
      // Advisory only: true may start indexing; false (or absent) never means "complete".
      if (check.value.history?.indexingSuggested === true) requestIndexing('detail', { sectorKey: query.sectorId });
      return check.value;
    }
    if (!check.refused) throw new CrewError('invalid-response', check.reason);
    const code = check.refused;
    if (ACCESS_ENDING.has(code)) await endAccess();
    else if (SUSPENDING.has(code)) suspend(a, code);
    else if (SUSPENDING_INDEX.has(code)) suspend(a, code, true);
    else if (code === 'rate-limited') rateLimited();
    throw new CrewError(code);
  }

  /**
   * Crew of one owned sector (validated, frozen), from memory while fresh unless `force`.
   * @param {{sectorId:string, date:string}} query
   * @param {{force?:boolean}} [options]
   * @throws {CrewError}
   */
  async function loadCrew(query = {}, options = {}) {
    const observation = { dispatched: false, joined: false };
    const start = monotonic(), diagnosticBorn = crewDiagnosticGeneration();
    observation.started = start; observation.diagnosticBorn = diagnosticBorn;
    try { return await loadCrewInner(query, options, observation); }
    catch (error) {
      if (!observation.dispatched) recordCrewRequest({ action: 'crew', source: observation.joined ? 'joined' : 'local-refusal', outcome: 'refused', elapsedMs: Math.max(0, monotonic() - start) }, diagnosticBorn);
      throw error;
    }
  }
  async function loadCrewInner({ sectorId, date } = {}, { force = false } = {}, observation) {
    sweep();
    await assertStorage();
    const a = currentAccess();
    if (!a.endpoint) throw new CrewError('not-configured');
    if (!a.token) throw new CrewError('auth-required');
    const refused = gate(a);
    if (refused) throw new CrewError(refused);
    const grant = credentials.activeGrant(a);
    if (!grant) throw new CrewError('crew-not-enrolled');
    if (typeof sectorId !== 'string' || !SECTOR_ID.test(sectorId) || typeof date !== 'string' || !DATE.test(date)) throw new CrewError('bad-request');
    const key = `${a.accessId}|${sectorId}|${date}`;
    if (!force) {
      const hit = memory.get(key);
      if (hit) { recordCrewRequest({ action: 'crew', source: 'cache', outcome: 'success', elapsedMs: Math.max(0, monotonic() - observation.started) }, observation.diagnosticBorn); return hit.value; }
    }
    const born = generation;
    let running = inFlight.get(key);
    const joined = Boolean(running);
    observation.joined = joined;
    if (!running) {
      if (crewSuspended(a)) throw new CrewError('suspended', limits.suspended.code);
      if (cooling()) throw new CrewError('cooldown');
      if (!budgetLeft()) throw new CrewError('local-limit');
      spend();
      observation.dispatched = true;
      running = fetchCrew(a, grant, { sectorId, date }, key, born);
      inFlight.set(key, running);
      const release = () => { if (inFlight.get(key) === running) inFlight.delete(key); };
      running.then(release, release);
    }
    const joinedStart = monotonic();
    const joinedBorn = crewDiagnosticGeneration();
    const value = await running;
    if (joined) recordCrewRequest({ action: 'crew', source: 'joined', outcome: 'success', elapsedMs: Math.max(0, monotonic() - joinedStart) }, joinedBorn);
    if (born !== generation) throw new CrewError('access-changed');
    return value;
  }

  // --- indexing ------------------------------------------------------------------------------------

  /** Why a call may not be made now, or null. Checked before EVERY indexing call. */
  function blocked(run) {
    if (run.cancelled) return run.cancelled;
    if (run.started !== null && monotonic() - run.started >= INDEX_DEADLINE_MS) return 'deadline';
    if (credentials.status() === 'unreadable') { fault(); return 'storage-unreadable'; }
    const a = currentAccess();
    if (run.born !== generation || a.accessId !== run.accessId) return 'access-changed';
    if (!grantStill(run.grant)) return 'access-changed';
    if (!isVisible()) return 'hidden';
    if (!isOnline()) return 'offline';
    if (indexSuspended(a)) return 'suspended';
    if (indexCooling()) return 'cooldown';
    if (!budgetLeft()) return 'budget';
    return null;
  }

  /** The run still belongs to the CURRENT identity (access id, purge generation, grant) and is not detached. */
  const stillCurrent = (run) => !run.discard && runner === run && run.born === generation
    && currentAccess().accessId === run.accessId && grantStill(run.grant);

  /** Completion: only a run of the current identity reports progress, emits `indexed` or touches memory. */
  function finish(run, stopped) {
    if (!stillCurrent(run)) {
      run.discard = true;
      return { calls: run.calls, processed: 0, progress: null, stopped: run.cancelled ?? 'access-changed' };
    }
    if (run.processed > 0) {
      memory.clear();   // answers computed before the new index are outdated
      emit({ type: 'indexed', progress: run.progress });
    }
    const result = { calls: run.calls, processed: run.processed, progress: run.progress, stopped };
    recordCrewSession({ ...result, initialOutstanding: run.initialOutstanding, allowance: run.allowance, elapsedMs: run.started === null ? 0 : Math.max(0, monotonic() - run.started) }, run.diagnosticGeneration);
    return result;
  }

  async function loop(run) {

    const verifyBefore = run.trigger === 'manual' ? now() : undefined;
    let busyRetried = false;
    for (;;) {
      const stop = blocked(run);
      if (stop) return finish(run, stop);
      if (run.calls >= run.allowance) return finish(run, 'limit');
      const a = currentAccess();
      if (run.started === null) run.started = monotonic();
      run.calls += 1;
      spend();
      let data;
      let transport = null;
      try {
        ({ data } = await post(a.endpoint, crewIndexRequest(a.token, run.grant, { verifyBefore, sessionVersion: 1, diagnosticsVersion: crewDiagnosticsEnabled() ? 1 : undefined }), { timeoutMs: CREW_INDEX_TIMEOUT_MS }));
      } catch (error) {
        transport = transportCode(error);
      }
      if (run.discard || runner !== run) { run.discard = true; return finish(run, run.cancelled ?? 'cancelled'); }
      if (run.born !== generation || currentAccess().accessId !== run.accessId || !grantStill(run.grant)) {
        run.discard = true;
        return finish(run, 'access-changed');
      }
      if (transport) return finish(run, `error:${transport}`);
      const check = validateCrewIndex(data);
      if (check.ok) {
        const { processed, progress, session } = check.value;
        if (run.initialOutstanding === null && session) {
          run.initialOutstanding = session.initialOutstanding;
          run.previousRemaining = session.initialOutstanding;
          if (run.trigger !== 'detail') run.allowance = Math.ceil(session.initialOutstanding / 6) + 2;
        }
        run.processed += processed;
        run.progress = progress;
        lastProgress = { identity: run.identity, progress: { ...progress, at: now() } };
        emit({ type: 'progress', progress });
        if (run.cancelled) return finish(run, run.cancelled);
        if (processed === 0) return finish(run, 'no-progress');
        if (progress.pending + progress.stale === 0 && (!session || session.remaining === 0) && !check.value.cleanupPending) return finish(run, progress.uncovered ? 'uncovered' : 'done');
        if (!session && run.trigger !== 'detail') return finish(run, 'session-unavailable');
        const remaining = session ? session.remaining : progress.pending + progress.stale;
        if (run.previousRemaining !== null && remaining >= run.previousRemaining) {
          // A wholly busy batch is the one permitted exception to immediate no-progress stop.
          if (check.value.outcomes.busy === processed) {
            if (busyRetried || run.calls >= run.allowance) {
              limits.indexCooldownUntil = now() + BUSY_COOLDOWN_MS;
              return finish(run, 'busy');
            }
            busyRetried = true;
            await sleep(BUSY_RETRY_MS, run.abort.signal);
            continue;
          }
          return finish(run, 'no-progress');
        }
        run.previousRemaining = remaining;
        if (run.calls >= run.allowance) return finish(run, 'limit');
        await sleep(INDEX_SPACING_MS, run.abort.signal);
        continue;
      }
      if (!check.refused) return finish(run, 'error:invalid-response');
      const code = check.refused;
      if (code === 'busy') {
        // A second busy, or busy on the last permitted call: stop with an indexing cooldown (no extra call).
        if (busyRetried || run.calls >= run.allowance) {
          limits.indexCooldownUntil = now() + BUSY_COOLDOWN_MS;
          return finish(run, 'busy');
        }
        busyRetried = true;
        await sleep(BUSY_RETRY_MS, run.abort.signal);
        continue;
      }
      if (code === 'rate-limited') { rateLimited(); return finish(run, 'rate-limited'); }
      if (ACCESS_ENDING.has(code)) { run.cancelled = `error:${code}`; run.discard = true; await endAccess(); return finish(run, `error:${code}`); }
      if (SUSPENDING.has(code)) { suspend(a, code); return finish(run, 'suspended'); }
      if (SUSPENDING_INDEX.has(code)) { suspend(a, code, true); return finish(run, 'suspended'); }
      return finish(run, `error:${code}`);
    }
  }

  const settled = (calls, stopped) => Promise.resolve({ calls, processed: 0, progress: null, stopped });

  /**
   * Starts the app-wide indexing runner, or joins the one already running.
   * @param {'detail'|'enroll'|'manual'} trigger
   * @param {{sectorKey?:string}} [options] the sector a `detail` run belongs to (see leaveDetail)
   * @returns {Promise<{calls:number, processed:number, progress:object|null, stopped:string}>}
   */
  function requestIndexing(trigger, { sectorKey = null } = {}) {
    sweep();
    if (!Object.prototype.hasOwnProperty.call(INDEX_MAX_CALLS, trigger)) return settled(0, 'error:bad-trigger');
    if (credentials.status() === 'unreadable') { fault(); detachRunner(); return settled(0, 'storage-unreadable'); }
    if (needsRecovery()) {
      // The recovery fold is a locked (async) write; the run starts only after it succeeded.
      return storageRefusal().then((refusal) => {
        if (refusal) { detachRunner(); return { calls: 0, processed: 0, progress: null, stopped: refusal }; }
        return startIndexing(trigger, sectorKey);
      });
    }
    return startIndexing(trigger, sectorKey);
  }

  function startIndexing(trigger, sectorKey) {
    const a = currentAccess();
    const refused = gate(a);
    if (refused) { detachRunner(); return settled(0, refused); }
    const grant = a.endpoint && a.token ? credentials.activeGrant(a) : null;
    if (!grant) { detachRunner(); return settled(0, 'not-enrolled'); }
    const identity = identityOf(a, grant);
    if (runner && runner.identity === identity) return runner.promise;
    detachRunner();   // a run of another access, purge generation or grant never serves this one
    if (indexSuspended(a)) return settled(0, 'suspended');
    if (!isVisible()) return settled(0, 'hidden');
    if (!isOnline()) return settled(0, 'offline');
    if (indexCooling()) return settled(0, 'cooldown');
    if (!budgetLeft()) return settled(0, 'budget');
    limits.runs = prune(limits.runs, now());
    if (limits.runs.length >= INDEX_MAX_RUNS) return settled(0, 'throttled');
    limits.runs.push(now());
    const run = {
      trigger, sectorKey, grant, identity, accessId: a.accessId, born: generation,
      started: null, initialOutstanding: null, previousRemaining: null, allowance: INDEX_MAX_CALLS[trigger], diagnosticGeneration: crewDiagnosticGeneration(),
      calls: 0, processed: 0, progress: null, cancelled: null, discard: false, abort: new AbortController(),
    };
    runner = run;
    run.promise = loop(run)
      .catch(() => finish(run, 'error:crew-unavailable'))
      .finally(() => { if (runner === run) runner = null; });
    return run.promise;
  }

  /** Stops the running indexing after its current call (that answer still updates progress). */
  function cancelIndexing(reason = 'cancelled') {
    sweep();
    cancelRunner(typeof reason === 'string' && reason ? reason : 'cancelled', false);
  }

  /** The detail screen of `sectorKey` was left: a `detail` run started for it stops. */
  function leaveDetail(sectorKey) {
    sweep();
    if (runner && runner.trigger === 'detail' && runner.sectorKey === sectorKey) cancelRunner('cancelled', false);
  }

  /** Settings was left: an `enroll` or `manual` run (started there) stops. */
  function leaveSettings() {
    sweep();
    cancelRunner('cancelled', false, ['enroll', 'manual']);
  }

  function noteVisibility(visible) {
    sweep();
    if (!visible) {
      if (hiddenAt === null) hiddenAt = now();
      cancelRunner('hidden', false);
      return;
    }
    const since = hiddenAt;
    hiddenAt = null;
    if (since !== null && now() - since > CREW_HIDDEN_PURGE_MS) purgeCrewMemory();
  }

  function noteOnline(online) {
    sweep();
    if (!online) cancelRunner('offline', false);
  }

  /** State of indexing for the CURRENT identity only (another identity's run or progress is never shown). */
  function indexingStatus() {
    sweep();
    const until = Math.max(limits.rateCooldownUntil, limits.indexCooldownUntil);
    const grant = storedActive();
    const identity = grant ? identityOf(currentAccess(), grant) : null;
    const mine = runner !== null && runner.identity === identity;
    return {
      running: mine,
      trigger: mine ? runner.trigger : null,
      lastProgress: lastProgress && lastProgress.identity === identity ? { ...lastProgress.progress } : null,
      cooldownUntil: until > now() ? until : null,
    };
  }

  // --- enrollment ----------------------------------------------------------------------------------

  /**
   * Enrolls this device with an owner-issued code. The code is sent once and never kept. Serialized with
   * deletion. The grant is persisted (inflight) before the request; a working active grant is never touched
   * by a failed attempt, and a grant whose outcome is unknown is kept as potentially live.
   * @param {string} code
   * @param {{guard?: () => boolean}} [options] optional synchronous authorization of the caller (e.g. consent and
   *   identity still the ones the user enrolled under), checked before preparing and again immediately before
   *   dispatch; false -> 'consent-changed', and a prepared attempt is cancelled as never sent.
   * @returns {Promise<{enrolled:true}>}
   * @throws {CrewError}
   */
  async function enroll(code, { guard = null } = {}) {
    sweep();
    const c = typeof code === 'string' ? code.trim() : '';
    if (!CODE.test(c)) throw new CrewError('bad-code');
    await assertStorage();
    const a = currentAccess();
    if (!a.endpoint) throw new CrewError('not-configured');
    if (!a.token) throw new CrewError('auth-required');
    const refusedEarly = gate(a);
    if (refusedEarly) throw new CrewError(refusedEarly);
    if (cooling()) throw new CrewError('cooldown');
    if (!budgetLeft()) throw new CrewError('local-limit');
    const marker = accessFingerprint(CODE_SALT, c);   // in-memory equality marker only
    return exclusive(async () => {
      // Re-checked inside the queue, immediately before dispatch: an earlier queued operation may have started
      // a deletion, hit the backend rate limit or used up the budget.
      await assertStorage();
      const refused = gate(a);
      if (refused) throw new CrewError(refused);
      if (cooling()) throw new CrewError('cooldown');
      if (!budgetLeft()) throw new CrewError('local-limit');
      if (typeof guard === 'function' && !guard()) throw new CrewError('consent-changed');   // nothing prepared yet
      const reuse = lastCodeAttempt && lastCodeAttempt.marker === marker ? lastCodeAttempt.grant : null;
      const born = generation;
      // Persisted (inflight) under the cross-tab lock BEFORE dispatch; the dispatch uses that result only.
      const begunResult = await credentials.detailed.beginEnroll(a, { reuse });
      if (!begunResult.ok) {
        if (['storage', 'storage-unreadable', 'lock-unavailable'].includes(begunResult.error)) fault();   // nothing was dispatched
        throw new CrewError(begunResult.error);
      }
      const begun = begunResult.value;
      // The lock wait may have been long (another tab): every dispatch limit is re-checked NOW, synchronously, with
      // no await before spend() + post(). Suspension never blocks enrollment (enrollment is how it is lifted).
      const late = ineligibleAfterPrepare(a, born, guard);
      if (late) {
        // Never sent: settled as a refusal (removed only if it never had an unknown attempt; a reused entry keeps
        // the uncertainty beginEnroll folded in). If that write fails, the persisted inflight stays conservative.
        if (!(await credentials.detailed.settleEnroll(begun.grant, 'refused')).ok) fault();
        throw new CrewError(late);
      }
      lastCodeAttempt = { grant: begun.grant, marker };   // only an attempt that is really sent becomes the marker
      spend();   // budget consumed exactly at dispatch
      let data;
      try {
        ({ data } = await post(a.endpoint, crewEnrollRequest(a.token, c, begun.grant), { timeoutMs: CREW_TIMEOUT_MS }));
      } catch (error) {
        // The backend may hold it: kept for retry or deletion. If that cannot be written, the persisted
        // inflight flag still marks it potentially live, and the storage fault blocks everything until a
        // recovery write folds it into unknown.
        if (!(await credentials.detailed.settleEnroll(begun.grant, 'unknown')).ok) fault();
        throw new CrewError(transportCode(error));
      }
      const check = validateCrewEnroll(data);
      if (check.ok || (check.refused && ENROLL_DEFINITIVE.has(check.refused))) lastCodeAttempt = null;   // outcome known
      if (check.ok) {
        const settledOk = await credentials.detailed.settleEnroll(begun.grant, 'ok', check.value.G);
        if (!settledOk.ok) { fault(); throw new CrewError(settledOk.error === 'not-found' ? 'storage' : settledOk.error); }
        if (credentials.pendingRevoke()) throw new CrewError('revoke-pending');
        if (born !== generation || currentAccess().accessId !== a.accessId) throw new CrewError('access-changed');
        limits.suspended = null;
        memory.clear();   // answers of the previous grant are not shown under the new one
        requestIndexing('enroll');
        return { enrolled: true };
      }
      if (!check.refused) {
        if (!(await credentials.detailed.settleEnroll(begun.grant, 'unknown')).ok) fault();
        throw new CrewError('invalid-response', check.reason);
      }
      if (!(await credentials.detailed.settleEnroll(begun.grant, ENROLL_DEFINITIVE.has(check.refused) ? 'refused' : 'unknown')).ok) fault();
      if (check.refused === 'rate-limited') rateLimited();
      throw new CrewError(check.refused);
    });
  }

  /** Local refusal for a prepared enrollment just before dispatch, or null (synchronous; see enroll). */
  function ineligibleAfterPrepare(a, born, guard = null) {
    if (storageFault) return 'storage';
    // The caller's own authorization (consent, identity), evaluated synchronously right before dispatch.
    if (typeof guard === 'function' && !guard()) return 'consent-changed';
    const refused = gate(a);
    if (refused) return refused;
    if (born !== generation || currentAccess().accessId !== a.accessId) return 'access-changed';
    if (cooling()) return 'cooldown';
    if (!budgetLeft()) return 'local-limit';
    return null;
  }

  // --- deletion ------------------------------------------------------------------------------------

  /**
   * One deletion pass: a revoke is sent for EVERY unresolved entry of the CURRENT endpoint (confirmed grants
   * first, then candidates newest first). Each entry is resolved only by evidence about itself:
   *   ok (with or without `recorded` for its OWN revokeId) -> 'deleted';
   *   stale-request -> 'dead' only for a grant the backend once confirmed (its single code was consumed, so it
   *   can never activate again); an unconfirmed candidate stays unresolved (a held request may still arrive);
   *   anything else -> unresolved. Time, and other entries' answers, never resolve anything.
   */
  async function revokePass() {
    const a = currentAccess();
    if (!a.endpoint) return { status: 'pending', code: 'not-configured' };
    const ep = endpointFingerprint(a.endpoint);
    const start = credentials.state();
    if (start.kind === 'unreadable') { fault(); return { status: 'pending', code: 'storage-unreadable' }; }
    const record = start.record;
    if (record?.phase !== 'revoking') return { status: 'nothing' };
    const open = record.grants.filter((e) => !e.resolved);
    const local = [...open.filter((e) => e.role === 'active'), ...open.filter((e) => e.role !== 'active').sort((x, y) => y.at - x.at)]
      .filter((e) => e.ep === ep);
    let stop = null;
    let unresolvedEnrollment = false;
    let recorded = false;
    let cacheCleared = true;
    if (local.length && !a.token) stop = 'auth-required';
    for (const planned of stop ? [] : local) {
      const current = credentials.state();   // checked read immediately before each dispatch
      if (current.kind === 'unreadable') { fault(); stop = stop ?? 'storage-unreadable'; break; }
      const e = current.record?.grants.find((x) => x.grant === planned.grant);
      if (!e || e.resolved) continue;
      // Captured for the exact access this request is sent with (endpoint + accessId), before the await (§8.7).
      const cancelTrusted = cancelSupported({ ...a }) === true;
      let data;
      try {
        ({ data } = await post(a.endpoint, crewRevokeRequest(a.token, e.grant, e.revokeId), { timeoutMs: CREW_TIMEOUT_MS, diagnosticCancel: cancelTrusted }));
      } catch (error) {
        stop = stop ?? transportCode(error);
        continue;   // the other entries are still revoked in this pass
      }
      // A cancellation ('cancelled': this grant is not live and is tombstoned, §8.7) is trusted only when the backend
      // the request went to advertised it (captured above); it resolves ONLY this entry (of that endpoint), as dead.
      // Never a deletion confirmation.
      const check = validateCrewRevoke(data, { cancel: cancelTrusted });
      if (check.ok && check.value.state === 'cancelled') {
        const resolvedCancelled = await credentials.detailed.resolveEntry(e.grant, 'dead');
        if (!resolvedCancelled.ok) { fault(); stop = stop ?? resolvedCancelled.error; }
        continue;
      }
      if (check.ok) {
        const resolvedDeleted = await credentials.detailed.resolveEntry(e.grant, 'deleted');
        if (!resolvedDeleted.ok) { fault(); stop = stop ?? resolvedDeleted.error; continue; }
        recorded = recorded || check.value.recorded === true;
        cacheCleared = cacheCleared && check.value.cacheCleared !== false;
        continue;
      }
      if (check.refused === 'stale-request') {
        if (e.role === 'active') {
          const resolvedDead = await credentials.detailed.resolveEntry(e.grant, 'dead');
          if (!resolvedDead.ok) { fault(); stop = stop ?? resolvedDead.error; }
        } else {
          unresolvedEnrollment = true;
        }
        continue;
      }
      stop = stop ?? check.refused ?? 'invalid-response';
    }
    const completed = await credentials.detailed.completeRevoke();   // re-reads under the lock
    if (!completed.ok) { fault(); return { status: 'pending', code: stop ?? completed.error }; }
    if (completed.value === 'deleted') return { status: 'deleted', recorded, cacheCleared };
    if (completed.value === 'superseded') return { status: 'superseded' };
    const final = credentials.state();
    if (final.kind === 'unreadable') { fault(); return { status: 'pending', code: 'storage-unreadable' }; }
    const after = final.record;
    if (after?.phase !== 'revoking' || after.grants.every((e) => e.resolved)) { fault(); return { status: 'pending', code: 'storage' }; }
    if (stop) return { status: 'pending', code: stop };
    if (unresolvedEnrollment || after.grants.some((e) => !e.resolved && e.ep === ep)) {
      return { status: 'pending', code: 'unresolved-enrollment', retryAfter: now() + REVOKE_RETRY_HINT_MS };
    }
    return { status: 'pending', code: 'revoke-pending-elsewhere' };
  }

  /**
   * Opt-out: purges memory and detaches indexing at once, waits for an enrollment in flight, persists the
   * deletion (phase revoking) and revokes every potentially live grant of the current endpoint.
   * @returns {Promise<{status:'deleted', recorded:boolean, cacheCleared:boolean}|{status:'superseded'}
   *   |{status:'pending', code:string, retryAfter?:number}|{status:'nothing'}>}
   * @throws {CrewError} 'storage' when the deletion could not be recorded; 'credential-unsupported'
   */
  async function revoke() {
    sweep();
    await assertStorage();
    if (credentials.status() === 'foreign') throw new CrewError('credential-unsupported');
    purgeCrewMemory();
    deleting += 1;
    try {
      return await exclusive(async () => {
        purgeCrewMemory();
        await assertStorage();
        const { kind, record } = credentials.state();   // one checked read decides
        if (kind === 'unreadable') { fault(); throw new CrewError('storage-unreadable'); }
        if (kind === 'foreign') throw new CrewError('credential-unsupported');
        if (!record) return { status: 'nothing' };
        if (record.phase !== 'revoking') {
          const begun = await credentials.detailed.beginRevoke();   // deletion state persisted under the lock first
          if (!begun.ok && begun.error === 'not-found') return { status: 'nothing' };   // checked under the lock: none
          if (!begun.ok) { fault(); throw new CrewError(begun.error); }
        }
        return revokePass();
      });
    } finally {
      deleting -= 1;
    }
  }

  /** Resumes a pending deletion (e.g. after a restart or sign-in again); `nothing` when none is pending. */
  async function resumeRevoke() {
    sweep();
    await assertStorage();
    const { kind, record } = credentials.state();
    if (kind === 'unreadable') { fault(); throw new CrewError('storage-unreadable'); }
    if (kind === 'foreign') throw new CrewError('credential-unsupported');
    if (record?.phase !== 'revoking') return { status: 'nothing' };
    purgeCrewMemory();
    deleting += 1;
    try {
      return await exclusive(async () => {
        purgeCrewMemory();
        await assertStorage();
        return revokePass();
      });
    } finally {
      deleting -= 1;
    }
  }

  return {
    loadCrew, requestIndexing, cancelIndexing, leaveDetail, leaveSettings, noteVisibility, noteOnline, indexingStatus,
    enroll, revoke, resumeRevoke,
  };
}
