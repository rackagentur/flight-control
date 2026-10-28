// Data controller: where the roster comes from, and the derived view the UI renders.
//   production  cached payload first (instant), then live data; sector history kept.
//               With a v2 token configured, the fc.roster v2 contract is tried first and
//               validated; v5 fallback is allowed before a richer v2 roster is saved.
//               (Feature detection: the response must identify itself as fc.roster v2.)
//   sample      ?review fictional snapshot per state (HOME/AWAY, SAMPLE flights); never
//               touches production storage, uses a fictional review profile
// The synthetic v5 fixture is test data only and is never shown in the app.

import { store as defaultStore } from './store.js';
import { fetchStats, postContract, fetchStatsSecure, ApiError } from './api/appscript.js';
import { AdapterError } from './sources/fc-appscript-v5.js';
import { adaptHistoryV2 } from './sources/fc-appscript-v2.js';
import { request as v2Request, validateRoster, validateHistory } from './sources/contract-v2.js';
import { purgeDeparturesCache } from './sources/departures-service.js';
import { purgeFlightInfoCache } from './sources/flight-info-service.js';
import { purgeCrewMemory } from './sources/crew-service.js';
import { dropCrewAccess, reconcileCrewAccess, accessFingerprint, CREW_CREDENTIAL_KEY } from './sources/crew-credential.js';
import { sampleSnapshot, sampleProfile } from './sources/sample.js';
import { withHistory, rememberSectors, validEntry } from './model/history.js';
import { normalizeProfile } from './config/profile.js';
import { SIGNED_OUT_KEY, MAX_SERVER_SECTORS, sourceIdentity, acceptedSnapshot, restoreRecord, saveRecord, purgeRecords } from './roster-storage.js';
import { buildRoster } from './model/roster.js';
import { deriveState } from './model/state.js';
import { buildHorizon } from './model/horizon.js';

export const ENDPOINT_KEY = 'endpoint';
export const TOKEN_KEY = 'token.v2';
const REFRESH_MS = 10 * 60000;
const HISTORY_V2_TTL_MS = 24 * 3600000;
// After a structural failure (no doPost, wrong contract) v2 is not retried for a while,
// so a deployment without v2 never doubles every refresh.
const V2_RETRY_MS = 60 * 60000;

/** Plain-language fallback reason. */
export function fallbackReason(error) {
  const code = error?.code ?? error?.message ?? 'unknown';
  return {
    unauthorized: 'the v2 token was not accepted',
    'not-configured': 'the backend has no v2 token configured',
    'rate-limited': 'too many failed v2 attempts; try again later',
    'html-response': 'the backend does not offer the v2 contract yet',
    'contract-mismatch': 'the backend answered with a different contract version',
    'unsupported-contract': 'the backend answered with a different contract version',
    network: 'the v2 request could not reach the backend',
    timeout: 'the v2 request timed out',
  }[code] ?? `the v2 response was not usable (${code})`;
}

class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function createController({ profile, onChange, store = defaultStore, api = { fetchStats, postContract }, clock = () => Date.now(), isOnline = () => globalThis.navigator?.onLine !== false }) {
  let mode = { kind: 'production' };
  let contract = { active: null, fallback: null };
  let snapshot = null, record = null, error = null;
  let saved = false, loading = false, storageError = false;
  let shellReady = false, pending = null, reconnectPending = false;
  let historyAttemptAt = 0;
  let lastLiveAttempt = 0, generation = 0, v2RetryAt = 0, accessRevision = 0;
  let signedOut = store.get(SIGNED_OUT_KEY) === 'true';
  // Crew credential cleanup of the latest sign-out (cross-tab locked, so possibly asynchronous):
  // null (none) | 'pending' | 'done' | 'incomplete'. `crewSignOutSeq` lets a newer sign-out / sign-in supersede it.
  let crewCleanupState = null;
  let crewCleanupDone = Promise.resolve(null);
  let crewSignOutSeq = 0;
  // Fingerprint of the access that sign-out left (a re-authentication with ANOTHER access supersedes its report),
  // and the crew cleanup failure, kept apart from `storageError` (non-crew sign-out failures stay closed).
  let crewCleanupAccess = null;
  let crewCleanupError = null;
  let access = { endpoint: store.get(ENDPOINT_KEY), token: store.get(TOKEN_KEY) };
  const now = clock;
  const activeProfile = () => mode.kind === 'sample' ? sampleProfile(profile) : profile;

  function view() {
    const t = now(), p = activeProfile();
    const roster = snapshot ? buildRoster(snapshot, p, t) : null;
    const state = deriveState(snapshot, roster, p, t);
    return { profile: p, now: t, snapshot, roster, state, horizon: roster ? buildHorizon(roster, state, p, t) : null,
      error, loading, review: mode.kind === 'sample', mode, contract,
      toneOverride: mode.kind === 'sample' ? mode.tone : null, warnings: roster?.warnings ?? [], crewCleanup: crewCleanupState,
      offline: !isOnline(), savedRoster: saved, storageError: storageError || !!crewCleanupError, shellReady,
      offlineReady: mode.kind === 'production' && saved && shellReady,
      lastSyncedAt: saved ? record?.fetchedAt ?? null : null,
      usingSaved: !!snapshot && (snapshot.source.kind === 'cache' || !isOnline() || !!error || storageError || !!crewCleanupError),
    };
  }
  const emit = () => onChange(view());
  function combined(base, entry, at) {
    const server = base.contract === 'v2' ? entry.serverHistory?.sectors ?? [] : [];
    const merged = withHistory(base, [...server, ...entry.history], at);
    return base.contract === 'v2' ? { ...merged, historySource: server.length ? 'roster-calendar' : 'device' } : merged;
  }
  function purgeRoster() {
    const ok = purgeRecords(store);
    const departuresCleared = purgeDeparturesCache(store);
    purgeFlightInfoCache();   // in memory only; cannot fail
    purgeCrewMemory();        // in memory only; cannot fail
    record = snapshot = null; saved = false; loading = false;
    contract = { active: null, fallback: null }; v2RetryAt = 0; historyAttemptAt = 0;
    return ok && departuresCleared;
  }
  function invalidate() { generation += 1; accessRevision += 1; pending = null; reconnectPending = false; loading = false; }
  const clearStorageError = () => new ApiError('storage', 'Local data could not be fully cleared. Clear website data in browser settings.');
  function loadProduction(opts = {}) {
    if (pending) return pending;
    const task = runLoad(opts);
    pending = task;
    task.finally(() => {
      if (pending !== task) return;
      pending = null;
      const retry = reconnectPending && error && isOnline() && !signedOut && mode.kind === 'production';
      reconnectPending = false;
      if (retry) loadProduction({ force: true });
    });
    return task;
  }
  async function runLoad({ force = false, manual = false } = {}) {
    // A failed local sign-out stays closed until explicit reconnection, even if storage
    // could not retain the tombstone or remove the endpoint/credential.
    if (signedOut && storageError) { error = clearStorageError(); emit(); return; }
    const gen = ++generation;
    const endpoint = store.get(ENDPOINT_KEY), token = store.get(TOKEN_KEY);
    const current = () => gen === generation && endpoint === store.get(ENDPOINT_KEY) && token === store.get(TOKEN_KEY) && !signedOut;
    if (endpoint !== access.endpoint || token !== access.token) {
      // Settings and cross-tab changes normally invalidate first. This is defence in depth.
      purgeRoster(); access = { endpoint, token };
    }
    error = null;
    if (!endpoint) { snapshot = null; saved = false; loading = false; emit(); return; }
    if (signedOut || store.get(SIGNED_OUT_KEY) === 'true') {
      signedOut = true; snapshot = null; saved = false;
      error = new ApiError('auth-required', 'Access token required. Reconnect in Settings.'); emit(); return;
    }
    loading = true;
    try {
      const source = await sourceIdentity(endpoint, token);
      if (!current()) return;
      if (!snapshot) {
        // Old records were unbound: only migrate with the existing endpoint AND token.
        const restored = restoreRecord(store, source, profile, !!token);
        record = restored.record; saved = restored.saved;
        if (record) {
          storageError = !saved;
          snapshot = combined(acceptedSnapshot(record.contract, record.payload, profile, record.fetchedAt), record, now());
          contract = { active: record.contract, fallback: null };
        }
      }
      emit(); // saved data is visible before any request, regardless of credential validity
      if (!manual && !isOnline()) return;
      if (!force && snapshot?.source.kind === 'live' && now() - snapshot.source.fetchedAt < REFRESH_MS / 2) return;
      lastLiveAttempt = now();
      const accept = (data, version) => {
        const fetchedAt = now();
        const fresh = acceptedSnapshot(version, data, profile, fetchedAt, 'live');
        if (version === 'v2' && record?.contract === 'v2' && record.payload.events.some((e) => e.end > fetchedAt) && !data.events.some((e) => e.end > fetchedAt)) {
          throw new AdapterError('invalid-roster', 'The response unexpectedly omitted all remaining duties. Saved data is unchanged.');
        }
        const candidate = { version: 1, source, contract: version, payload: data, fetchedAt,
          history: rememberSectors(record?.history ?? [], fresh, fetchedAt, profile.homeTz), serverHistory: record?.serverHistory ?? null, historyCheckedAt: record?.historyCheckedAt ?? null };
        // Also exercise downstream models before replacing durable data.
        const next = combined(fresh, candidate, fetchedAt);
        buildRoster(next, profile, fetchedAt);
        if (!current()) return false;
        const written = saveRecord(store, candidate);
        storageError = !written;
        if (written) { record = candidate; saved = true; snapshot = next; }
        else if (!snapshot) { snapshot = next; saved = false; }
        // With a saved roster, a quota failure leaves both the visible and durable copy intact.
        contract = { active: record?.contract ?? version, fallback: contract.fallback };
        return written;
      };
      if (token && now() >= v2RetryAt) {
        try {
          const { data } = await api.postContract(endpoint, v2Request('roster', token));
          if (!current()) return;
          const check = validateRoster(data);
          if (!check.ok) throw new ContractError(check.reason);
          const written = accept(data, 'v2');
          contract.fallback = null;
          if (written) refreshServerHistory(endpoint, token, gen);
          return;
        } catch (e) {
          if (!current()) return;
          // An unusable roster must not downgrade a good saved copy through the v5 fallback.
          const code = e?.code ?? e?.message;
          if (record?.contract === 'v2' && !['html-response', 'contract-mismatch', 'unsupported-contract', 'not-configured', 'rate-limited', 'unauthorized', 'network', 'timeout'].includes(code)) throw e;
          if (record?.contract === 'v2') {
            throw new ApiError(code === 'unauthorized' ? 'auth-required' : code, fallbackReason(e));
          }
          contract.fallback = fallbackReason(e);
          if (['html-response', 'contract-mismatch', 'unsupported-contract', 'not-configured', 'rate-limited'].includes(code)) v2RetryAt = now() + V2_RETRY_MS;
        }
      }
      const { data } = await fetchStatsSecure(endpoint, token && now() >= v2RetryAt ? token : null, api);
      if (!current()) return;
      accept(data, 'v5');
      if (!token) contract.fallback = null;
    } catch (e) {
      if (!current()) return;
      error = e instanceof ApiError || e instanceof AdapterError ? e : new ApiError('invalid-roster', 'The roster response could not be safely used. Saved data is unchanged.');
      if (error.code === 'auth-required' && !token) {
        // Open-source data is not authenticated offline access. Revoke it permanently
        // when the backend changes policy, including in other tabs and after restart.
        signedOut = true; accessRevision += 1;
        const marked = store.set(SIGNED_OUT_KEY, true);
        storageError = !purgeRoster() || !marked;
      }
    } finally {
      if (gen === generation) { loading = false; emit(); }
    }
  }
  async function refreshServerHistory(endpoint, token, gen) {
    const checked = Math.max(historyAttemptAt, record?.historyCheckedAt ?? 0, record?.serverHistory?.fetchedAt ?? 0);
    if (checked && now() - checked < HISTORY_V2_TTL_MS) return;
    historyAttemptAt = now();
    const original = record;
    try {
      const { data } = await api.postContract(endpoint, v2Request('history', token));
      if (gen !== generation || signedOut || endpoint !== store.get(ENDPOINT_KEY) || token !== store.get(TOKEN_KEY) || record !== original || !validateHistory(data).ok) return;
      const sectors = adaptHistoryV2(data, now());
      // Reject a partial or empty history read rather than discarding valid remembered history.
      const complete = sectors.length > 0 && sectors.length === data.sectors.length && sectors.length <= MAX_SERVER_SECTORS && sectors.every(validEntry);
      // Record the daily check even for an empty/partially adaptable response, while
      // retaining the last good history. This is not a successful roster sync time.
      const candidate = { ...record, historyCheckedAt: now(),
        serverHistory: complete ? { fetchedAt: now(), sectors } : record.serverHistory };
      if (!saveRecord(store, candidate)) { storageError = true; emit(); return; }
      record = candidate;
      snapshot = combined(acceptedSnapshot(record.contract, record.payload, profile, record.fetchedAt, snapshot.source.kind), record, now());
      emit();
    } catch { /* saved roster and history remain */ }
  }
  // Sign-out keeps operational preferences (home base, wake-up offset, airline, ...); the name and
  // the personal saved-hotel-list link are account-specific and go with the credentials.
  function signOutProfile() {
    const stored = store.getJSON('profile', null);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return store.remove('profile');
    const { name, hotelListUrl, ...kept } = stored;
    return Object.keys(kept).length ? store.setJSON('profile', kept) : store.remove('profile');
  }
  /**
   * Crew part of a sign-out. Decided at once when a checked read finds no crew record ('done'); otherwise the
   * locked drop runs ('pending') and ends 'done' or 'incomplete' (lock unavailable / storage failure: the record
   * is kept and the existing storageError + clearStorageError() report it). Never a server-side deletion claim.
   */
  function startCrewCleanup(leaving) {
    const seq = ++crewSignOutSeq;
    crewCleanupAccess = accessFingerprint(leaving.endpoint ?? null, leaving.token ?? null);
    crewCleanupError = null;
    const checked = typeof store.getChecked === 'function' ? store.getChecked(CREW_CREDENTIAL_KEY) : { ok: false };
    if (checked.ok && checked.value === null) {
      crewCleanupState = 'done';
      crewCleanupDone = Promise.resolve('done');
      return;
    }
    crewCleanupState = 'pending';
    crewCleanupDone = Promise.resolve()
      .then(() => dropCrewAccess(store))
      .then((dropped) => dropped === true, () => false)
      .then((dropped) => {
        const result = dropped ? 'done' : 'incomplete';
        if (seq !== crewSignOutSeq) return result;   // superseded: the newer session is never marked by it
        crewCleanupState = result;
        if (!dropped && !storageError) { crewCleanupError = clearStorageError(); error = crewCleanupError; }
        emit();
        return result;
      });
  }
  /** A newer session: the earlier sign-out's crew report (pending or failed) is no longer this page's. */
  function supersedeCrewCleanup() {
    crewSignOutSeq += 1;
    crewCleanupState = null;
    crewCleanupDone = Promise.resolve(null);
    crewCleanupAccess = null;
    if (crewCleanupError && error === crewCleanupError) error = null;
    crewCleanupError = null;
  }
  /**
   * Sign-out (and, with `reset`, the full local reset). The boolean is synchronous and covers the LOCAL sign-out
   * only; the crew credential cleanup is reported by view().crewCleanup and the awaitable crewCleanup().
   */
  function removeToken({ reset = false, disconnect = false } = {}) {
    invalidate(); signedOut = true;
    // Tombstone prevents a legacy open GET from repopulating data after explicit sign-out.
    let marked = store.set(SIGNED_OUT_KEY, true);
    // The confirmed crew grant goes with the token. Sign-out keeps a pending crew deletion record (and turns
    // an unconfirmed, possibly live grant into one) so the deletion can be resumed later; reset removes
    // everything (clearAllChecked), so a pending server-side deletion can no longer be resumed from this device.
    const removed = [store.remove(TOKEN_KEY), reset ? store.remove('profile') : signOutProfile(), purgeRoster()];
    // The crew drop is a cross-tab locked mutation reported through crewCleanup. Reset clears the whole namespace
    // below instead (unchanged, no lock; its boolean is the report).
    if (reset) supersedeCrewCleanup(); else startCrewCleanup(access);
    profile = normalizeProfile(reset ? {} : { ...store.getJSON('profile', {}), name: '', hotelListUrl: '' });
    if (disconnect) removed.push(store.remove(ENDPOINT_KEY));
    if (reset) { removed.push(store.remove(ENDPOINT_KEY), store.clearAllChecked()); }
    // Cleanup can free quota. set() verifies the stored value; retry only after removal.
    // Reset instead secures access by clearing the entire namespace, including endpoint.
    if (!reset && !marked) marked = store.set(SIGNED_OUT_KEY, true);
    const markerFailed = !reset && !marked;
    if (markerFailed) removed.push(store.remove(ENDPOINT_KEY));
    access = { endpoint: store.get(ENDPOINT_KEY), token: null };
    storageError = markerFailed || removed.some((ok) => !ok);
    if (reset && storageError) store.set(SIGNED_OUT_KEY, true);
    error = storageError ? clearStorageError()
      : store.get(ENDPOINT_KEY) ? new ApiError('auth-required', 'Access token required. Reconnect in Settings.') : null;
    if (mode.kind === 'sample') snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile), mode.variant ?? null);
    emit(); return !storageError;
  }
  return {
    view, now, accessRevision: () => accessRevision, load: loadProduction,
    /** Promise of the final crew cleanup state of the latest sign-out: null | 'done' | 'incomplete'. */
    crewCleanup: () => crewCleanupDone,
    setMode(next) {
      invalidate(); mode = next?.kind === 'sample' ? next : { kind: 'production' };
      snapshot = null; error = null;
      if (mode.kind === 'sample') { snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile), mode.variant ?? null); emit(); }
      else loadProduction();
    },
    refresh({ force = true } = {}) {
      if (mode.kind === 'production') return loadProduction({ force, manual: true });
      snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile), mode.variant ?? null); emit();
    },
    tick() {
      if (mode.kind === 'production' && !signedOut && isOnline() && store.get(ENDPOINT_KEY) && !loading && now() - lastLiveAttempt > REFRESH_MS) return loadProduction({ force: true });
      emit();
    },
    connectivityChanged() {
      if (isOnline() && mode.kind === 'production' && !signedOut) {
        if (pending) reconnectPending = true;
        return loadProduction({ force: true });
      }
      emit();
    },
    setShellReady(value) { shellReady = value === true; emit(); },
    forgetContractData() {
      supersedeCrewCleanup();   // a new sign-in / token save: an earlier sign-out's late result is not this session's
      invalidate(); purgeRoster(); storageError = false; store.remove(SIGNED_OUT_KEY); signedOut = false;
      access = { endpoint: store.get(ENDPOINT_KEY), token: store.get(TOKEN_KEY) };
      void reconcileCrewAccess(store, access);   // locked async mutation; its result was ignored before too
    },
    forgetRosterData() { invalidate(); purgeRoster(); },
    // Invoked for changes in other tabs, including deletion of the roster record.
    accessChanged() {
      // A storage event cannot undo a failed explicit sign-out in this page.
      if (signedOut && storageError) { invalidate(); error = clearStorageError(); emit(); return; }
      invalidate(); record = snapshot = null; saved = false; profile = normalizeProfile(store.getJSON('profile', {}));
      access = { endpoint: store.get(ENDPOINT_KEY), token: store.get(TOKEN_KEY) };
      // Re-authentication in another tab with a DIFFERENT access supersedes this page's crew sign-out report
      // (reporting only: the record is never removed here; reconcile below still runs under the lock).
      if (crewCleanupAccess !== null && access.token && store.get(SIGNED_OUT_KEY) !== 'true'
        && accessFingerprint(access.endpoint ?? null, access.token) !== crewCleanupAccess) supersedeCrewCleanup();
      purgeCrewMemory();   // in memory only; cannot fail
      void reconcileCrewAccess(store, access);   // locked async mutation; its result was ignored before too
      signedOut = store.get(SIGNED_OUT_KEY) === 'true' || !access.endpoint;
      if (mode.kind === 'production') loadProduction(); else emit();
    },
    removeToken,
    resetLocalData: () => removeToken({ reset: true }),
  };
}
