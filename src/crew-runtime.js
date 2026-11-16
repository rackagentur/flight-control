// Crew Intelligence runtime (Phase 1c, Stage B1): the ONE app-wide crew service, the opt-in preference, the
// backend capability check and sector eligibility. No UI here (Stage B2/B3 render from it).
//
// - Opt-in: store key `crew.enabled` ('true' or absent; default off). Reset clears it with the namespace;
//   sign-out KEEPS it (a preference, like theme), while grant handling is unchanged (Stage A).
// - Capability: the existing fc.roster v2 `capabilities` action, at most ONE request per access id per session
//   (memory only, the outcome is cached, failures included), and never while crew is disabled.
// - Pending deletion: resumed on startup, when the page comes back online and when it becomes visible, only when a
//   deletion is pending; independent of the opt-in (a requested deletion is always completed). Never on a timer.
//   When that deletion still holds unresolved entries, the capability (limits.crewCancel) is learned once per
//   access per session even with crew off (§8.7): such an entry may be answered by a cancellation.
// - Crew answers stay in the service's memory; nothing here writes anything but `crew.enabled`.
// - Authorization (what may be SHOWN): `authorization()` names the current consent epoch, access id and active
//   grant; the UI shows an answer only under the exact authorization it was fetched with. Every change of consent
//   (this tab or another), of the credential record in another tab, of the access, and a long hidden period bumps
//   the epoch and notifies subscribers; the online event is announced too (retryable states recover).

import { postContract } from './api/appscript.js';
import { request as v2Request } from './sources/contract-v2.js';
import { localDateKey } from './lib/time.js';
import { createCrewCredentials, grantFingerprint, CREW_CREDENTIAL_KEY } from './sources/crew-credential.js';
import { createCrewService, purgeCrewMemory, CREW_HIDDEN_PURGE_MS } from './sources/crew-service.js';

export const CREW_ENABLED_KEY = 'crew.enabled';
/** First roster date the backend indexes (FCV2_CONDOR_CONFIG_.historyStart); requests before it are refused. */
export const CREW_HISTORY_START = '2022-08-01';
/** The backend accepts dates up to today + 120 days (CrewApiV2.gs fcv2CrewHandleCrew_, bad-range). */
export const CREW_MAX_DAYS_AHEAD = 120;
/** Backend actions a full crew feature needs (capabilities `actions`). */
export const CREW_ACTIONS = Object.freeze(['crew', 'crewEnroll', 'crewIndex', 'crewRevoke']);

const SECTOR_ID = /^s_[0-9a-f]{16}$/;

function addDaysKey(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a sector may be looked up, and the query to send. Pure.
 * Eligible only for a sector of the CURRENT v2 roster (not remembered history, not v5, not sample/review data),
 * with a backend sector id and a date in [CREW_HISTORY_START, today + CREW_MAX_DAYS_AHEAD].
 *
 * Date: the sector's ORIGIN-local departure date. The backend reads that date's base-zone day with a ±36 h margin
 * (FCV2_CREW_MARGIN_MS_) and matches the sector id inside it; any origin zone differs from the base zone by less than
 * 14 h, so the departure always lies inside that window. A missing origin zone is never guessed (not eligible).
 * `today` is the user's home-zone date; at the window's edges the backend may still answer `bad-range`.
 *
 * @param {{view: {review?:boolean, mode?:{kind:string}, snapshot?:object}, sector: object, now: number, homeTz: string}} input
 * @returns {{eligible: true, query: {sectorId:string, date:string}} | {eligible: false, reason: string}}
 */
export function crewEligibility({ view, sector, now, homeTz }) {
  if (!view || view.review || (view.mode && view.mode.kind !== 'production')) return { eligible: false, reason: 'not-production' };
  const snapshot = view.snapshot;
  if (!snapshot || snapshot.contract !== 'v2') return { eligible: false, reason: 'not-v2' };
  if (!sector || typeof sector.id !== 'string' || !SECTOR_ID.test(sector.id)) return { eligible: false, reason: 'no-sector-id' };
  if (sector.provenance !== 'source' || !Array.isArray(snapshot.sectors) || !snapshot.sectors.some((s) => s.id === sector.id && s.provenance === 'source')) {
    return { eligible: false, reason: 'not-current-roster' };
  }
  if (typeof sector.dep !== 'number' || !Number.isFinite(sector.dep) || typeof sector.originTz !== 'string' || !sector.originTz) return { eligible: false, reason: 'no-date' };
  const date = localDateKey(sector.dep, sector.originTz);
  const today = typeof homeTz === 'string' ? localDateKey(now, homeTz) : null;
  if (!date || !today) return { eligible: false, reason: 'no-date' };
  if (date < CREW_HISTORY_START || date > addDaysKey(today, CREW_MAX_DAYS_AHEAD)) return { eligible: false, reason: 'out-of-range' };
  return { eligible: true, query: { sectorId: sector.id, date } };
}

/** Supported iff the backend's v2 capabilities list every crew action. Pure. */
export function crewSupportedBy(data) {
  return !!data && data.ok === true && data.contract === 'fc.roster' && data.version === 2 && Array.isArray(data.actions)
    && CREW_ACTIONS.every((a) => data.actions.includes(a));
}

/**
 * Grant cancellation (§8.7) is trusted only when a v2 backend offers crewRevoke and advertises limits.crewCancel
 * exactly 1. Independent of crewSupportedBy: with the backend kill switch on, crew stays hidden but a deletion
 * can still complete. Pure.
 */
export function crewCancelSupported(data) {
  return !!data && data.ok === true && data.contract === 'fc.roster' && data.version === 2 && Array.isArray(data.actions)
    && data.actions.includes('crewRevoke') && !!data.limits && typeof data.limits === 'object' && data.limits.crewCancel === 1;
}

/**
 * The app-wide crew runtime.
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   access: () => ({endpoint:string|null, token:string|null, accessId:string}),
 *   post?: typeof postContract, credentials?: object, service?: object, onChange?: (event:object) => void,
 *   now?: () => number, isVisible?: () => boolean, isOnline?: () => boolean,
 * }} deps `credentials` / `service` are injectable for tests; otherwise created here (one instance per app).
 */
export function createCrewRuntime({ store, access, post = postContract, credentials = null, service = null, onChange = null, now, isVisible, isOnline }) {
  const creds = credentials ?? createCrewCredentials({ store });
  /** accessId -> resolved capability (synchronous view of the per-access cache, for the revoke dispatch). */
  const known = new Map();
  const currentId = () => String((access() ?? {}).accessId ?? '');
  const svc = service ?? createCrewService({
    credentials: creds, access, post,
    // Only the capability learned for THAT access id (the one the revoke is sent with); unknown -> false.
    cancelSupported: (target) => known.get(String(target?.accessId ?? ''))?.cancel === true,
    ...(now ? { now } : {}), ...(isVisible ? { isVisible } : {}), ...(isOnline ? { isOnline } : {}),
    onChange: (event) => { if (typeof onChange === 'function') onChange(event); },
  });
  /** accessId -> Promise<{supported:boolean, actions:string[]|null, error:string|null}> */
  const capabilities = new Map();
  let resuming = null;
  let epoch = 0;
  let hiddenAt = null;
  const subscribers = new Set();
  const clock = now ?? Date.now;

  const enabled = () => store.get(CREW_ENABLED_KEY) === 'true';

  function emit(event) {
    for (const fn of [...subscribers]) { try { fn(event); } catch { /* a subscriber never breaks the runtime */ } }
  }
  /** Invalidates every shown or in-flight crew answer: a new authorization epoch. */
  function invalidate(reason) {
    epoch += 1;
    emit({ type: 'invalidated', reason });
  }

  /** Opt-in preference; returns whether it was stored. Any change of consent invalidates shown answers. */
  function setEnabled(on) {
    const stored = on ? store.set(CREW_ENABLED_KEY, 'true') : store.remove(CREW_ENABLED_KEY);
    purgeCrewMemory();   // answers fetched under an earlier consent are forgotten (memory only)
    invalidate('consent');
    return stored;
  }

  /**
   * The authorization crew answers are fetched and shown under (synchronous; reads only).
   * `authorized`: consent on, an active grant for this access, no pending deletion.
   * @returns {{key:string, authorized:boolean, accessId:string}}
   */
  function authorization() {
    const a = access() ?? {};
    const accessId = String(a.accessId ?? '');
    const on = enabled();
    const grant = a.endpoint && a.token ? creds.activeGrant({ endpoint: a.endpoint, token: a.token }) : null;
    const pending = creds.pendingRevoke() !== null;
    const key = `${epoch}|${accessId}|${on ? 1 : 0}|${grant ? grantFingerprint(grant) : '-'}|${pending ? 1 : 0}`;
    return { key, authorized: on && !!grant && !pending, accessId };
  }

  /**
   * Backend capability for the current access. No request while crew is disabled or without endpoint/token.
   * @returns {Promise<{supported:boolean, actions:string[]|null, error:string|null}>}
   */
  function capability() {
    if (!enabled()) return Promise.resolve({ supported: false, cancel: false, actions: null, error: 'disabled' });
    return fetchCapability();
  }

  /** At most one capabilities request per access id per session (the outcome is cached, failures included). */
  function fetchCapability() {
    const a = access() ?? {};
    if (!a.endpoint || !a.token) return Promise.resolve({ supported: false, cancel: false, actions: null, error: 'no-access' });
    const key = String(a.accessId ?? '');
    if (!capabilities.has(key)) {
      capabilities.set(key, post(a.endpoint, v2Request('capabilities', a.token))
        .then(({ data }) => ({ supported: crewSupportedBy(data), cancel: crewCancelSupported(data), actions: Array.isArray(data?.actions) ? data.actions.slice() : null, error: data?.ok === true ? null : (typeof data?.error === 'string' ? data.error : 'invalid-response') }))
        .catch((error) => ({ supported: false, cancel: false, actions: null, error: typeof error?.code === 'string' ? error.code : 'network' }))
        .then((r) => { known.set(key, r); return r; }));
    }
    return capabilities.get(key);
  }

  /** A pending deletion that still has unresolved entries (candidates or confirmed grants may be answered 'cancelled'). */
  function unresolvedDeletion() {
    const r = creds.read();
    return r?.phase === 'revoking' && r.grants.some((e) => !e.resolved);
  }

  /** Resumes a pending deletion (deduplicated); a no-op when none is pending. Works with the opt-in off. */
  function resumePendingDeletion() {
    if (resuming) return resuming;
    if (!creds.pendingRevoke()) return Promise.resolve({ status: 'nothing' });
    // Exception to "no request while disabled": a pending deletion with unresolved entries may be answered by a
    // cancellation (§8.7), so the capability is learned once per access per session even with crew off.
    const learn = unresolvedDeletion() && !known.has(currentId()) ? fetchCapability().catch(() => null) : Promise.resolve(null);
    resuming = learn.then(() => svc.resumeRevoke())
      .catch((error) => ({ status: 'pending', code: error?.code ?? 'error' }))
      .finally(() => { resuming = null; });
    return resuming;
  }

  return {
    service: svc,
    credentials: creds,
    enabled,
    setEnabled,
    capability,
    authorization,
    /** Current consent/authorization epoch (moves on every invalidation). */
    consentEpoch: () => epoch,
    invalidate,
    /** Subscribes to {type:'invalidated'|'online'} events; returns the unsubscribe function. */
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    /**
     * Another tab changed crew storage (`fc.v2.crew.v1` or `fc.v2.crew.enabled`; null = storage cleared): crew
     * memory is purged and shown answers are invalidated. Never touches the credential record.
     */
    storageChanged(key) {
      if (key !== null && key !== `fc.v2.${CREW_CREDENTIAL_KEY}` && key !== `fc.v2.${CREW_ENABLED_KEY}`) return;
      purgeCrewMemory();
      invalidate('storage');
    },
    resumePendingDeletion,
    /** App start: complete a deletion that was left pending. */
    start: () => resumePendingDeletion(),
    /** Page visibility changed (forwarded to the service; a pending deletion is resumed on becoming visible). */
    visibilityChanged(visible) {
      svc.noteVisibility(visible);
      if (!visible) { if (hiddenAt === null) hiddenAt = clock(); return; }
      // Same rule as the service's memory: answers do not survive a long hidden period.
      if (hiddenAt !== null && clock() - hiddenAt > CREW_HIDDEN_PURGE_MS) invalidate('expired');
      hiddenAt = null;
      resumePendingDeletion();
    },
    /** Connectivity changed (forwarded; a pending deletion is resumed when back online). */
    connectivityChanged(online) {
      svc.noteOnline(online);
      if (!online) return;
      emit({ type: 'online' });
      resumePendingDeletion();
    },
    /** Access changed or removed: capability answers of other accesses are forgotten; shown answers invalidated. */
    accessChanged() { capabilities.clear(); known.clear(); invalidate('access'); },
  };
}
