// Data controller: where the roster comes from, and the derived view the UI renders.
//   production  cached payload first (instant), then live data; sector history kept.
//               With a v2 token configured, the fc.roster v2 contract is tried first and
//               validated; any failure falls back to the unchanged v5 getStats contract.
//               (Feature detection: the response must identify itself as fc.roster v2.)
//   sample      ?review fictional snapshot per state (HOME/AWAY, SAMPLE flights); never
//               touches production storage, uses a fictional review profile
// The synthetic v5 fixture is test data only and is never shown in the app.

import { store as defaultStore } from './store.js';
import { fetchStats, postContract, fetchStatsSecure, ApiError } from './api/appscript.js';
import { adaptV5, AdapterError } from './sources/fc-appscript-v5.js';
import { adaptV2, adaptHistoryV2 } from './sources/fc-appscript-v2.js';
import { request as v2Request, validateRoster, validateHistory } from './sources/contract-v2.js';
import { sampleSnapshot, sampleProfile } from './sources/sample.js';
import { withHistory, rememberSectors } from './model/history.js';
import { buildRoster } from './model/roster.js';
import { deriveState } from './model/state.js';
import { buildHorizon } from './model/horizon.js';

const CACHE_KEY = 'cache.v5';
const HISTORY_KEY = 'history.v5';
const CACHE_V2_KEY = 'cache.v2';
const HISTORY_V2_KEY = 'history.v2';
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

export function createController({ profile, onChange, store = defaultStore, api = { fetchStats, postContract }, clock = () => Date.now() }) {
  let mode = { kind: 'production' };
  let contract = { active: null, fallback: null };
  let v2RetryAt = 0;
  let freshBase = null;   // the latest v2 snapshot before history was merged in
  let snapshot = null;
  let error = null;
  let loading = false;
  let lastLiveAttempt = 0;
  let generation = 0;               // ignores stale async results after a mode switch

  const now = clock;
  const activeProfile = () => (mode.kind === 'sample' ? sampleProfile(profile) : profile);

  function view() {
    const t = now();
    const p = activeProfile();
    const roster = snapshot ? buildRoster(snapshot, p, t) : null;
    const state = deriveState(snapshot, roster, p, t);
    const horizon = roster ? buildHorizon(roster, state, p, t) : null;
    return {
      profile: p, now: t, snapshot, roster, state, horizon, error, loading,
      review: mode.kind === 'sample', mode, contract,
      toneOverride: mode.kind === 'sample' ? mode.tone : null,
      warnings: roster?.warnings ?? [],
    };
  }

  const emit = () => onChange(view());

  async function loadProduction({ force = false } = {}) {
    const gen = ++generation;
    const endpoint = store.get(ENDPOINT_KEY);
    error = null;
    if (!endpoint) { snapshot = null; loading = false; emit(); return; }

    const token = store.get(TOKEN_KEY);
    const cachedV2 = token ? store.getJSON(CACHE_V2_KEY) : null;
    // No token: no cached roster at start-up (S6); a cache only reappears after a live read succeeds.
    const cached = token ? store.getJSON(CACHE_KEY) : null;
    // Start-up: whichever cache is newer (a stale v2 cache never hides a fresher v5 one).
    const v2First = cachedV2?.payload && Number.isFinite(cachedV2.fetchedAt) && !(Number.isFinite(cached?.fetchedAt) && cached.fetchedAt > cachedV2.fetchedAt);
    if (!snapshot && v2First && validateRoster(cachedV2.payload).ok) {
      try {
        freshBase = adaptV2(cachedV2.payload, { profile, fetchedAt: cachedV2.fetchedAt, kind: 'cache' });
        snapshot = withAllHistory(freshBase, now());
        contract = { active: 'v2', fallback: null };
      } catch { snapshot = null; }
    }
    if (!snapshot && cached?.payload && Number.isFinite(cached.fetchedAt)) {
      try {
        snapshot = withHistory(adaptV5(cached.payload, { profile, fetchedAt: cached.fetchedAt, kind: 'cache' }), store.getJSON(HISTORY_KEY, []), now());
        contract = { active: 'v5', fallback: contract.fallback };
      } catch { snapshot = null; }
    }
    if (!force && snapshot?.source.kind === 'live' && now() - snapshot.source.fetchedAt < REFRESH_MS / 2) { emit(); return; }

    loading = true;
    lastLiveAttempt = Date.now();
    emit();
    try {
      if (token && now() >= v2RetryAt) {
        try {
          const { data } = await api.postContract(endpoint, v2Request('roster', token));
          if (gen !== generation) return;
          const check = validateRoster(data);
          if (!check.ok) throw new ContractError(check.reason);
          const fetchedAt = now();
          const fresh = adaptV2(data, { profile, fetchedAt, kind: 'live' });
          store.setJSON(HISTORY_KEY, rememberSectors(store.getJSON(HISTORY_KEY, []), fresh, fetchedAt, profile.homeTz));
          store.setJSON(CACHE_V2_KEY, { payload: data, fetchedAt });
          freshBase = fresh;
          snapshot = withAllHistory(fresh, fetchedAt);
          contract = { active: 'v2', fallback: null };
          refreshServerHistory(endpoint, token, gen);
          return;
        } catch (e) {
          if (gen !== generation) return;
          contract = { active: 'v5', fallback: fallbackReason(e) };
          if (['html-response', 'contract-mismatch', 'unsupported-contract', 'not-configured', 'rate-limited'].includes(e?.code ?? e?.message)) v2RetryAt = now() + V2_RETRY_MS;
        }
      }
      // BH-2: with a token, the v5 payload is read through the authenticated POST first
      // (not during the v2 cool-down, so a backend without doPost is not asked twice).
      const { data } = await fetchStatsSecure(endpoint, token && now() >= v2RetryAt ? token : null, api);
      if (gen !== generation) return;
      const fetchedAt = now();
      const fresh = adaptV5(data, { profile, fetchedAt, kind: 'live' });
      const history = rememberSectors(store.getJSON(HISTORY_KEY, []), fresh, fetchedAt, profile.homeTz);
      store.setJSON(HISTORY_KEY, history);
      store.setJSON(CACHE_KEY, { payload: data, fetchedAt });
      snapshot = withHistory(fresh, history, fetchedAt);
      contract = { active: 'v5', fallback: token ? contract.fallback : null };
    } catch (e) {
      if (gen !== generation) return;
      error = e instanceof ApiError || e instanceof AdapterError ? e : new ApiError('network', 'Unexpected error while loading the roster.');
      // S6: refused without a token means nothing roster-derived may stay on this device.
      if (error.code === 'auth-required' && !store.get(TOKEN_KEY)) purgeRoster();
    } finally {
      if (gen === generation) { loading = false; emit(); }
    }
  }

  /** Device history plus server history (v2), labelled by where it came from. */
  function withAllHistory(fresh, at) {
    const server = store.getJSON(HISTORY_V2_KEY);
    const serverSectors = Array.isArray(server?.sectors) ? server.sectors : [];
    const merged = withHistory(fresh, [...serverSectors, ...store.getJSON(HISTORY_KEY, [])], at);
    return { ...merged, historySource: serverSectors.length ? 'roster-calendar' : 'device' };
  }

  /** Fetches bounded server history at most once a day; failures keep device history only. */
  async function refreshServerHistory(endpoint, token, gen) {
    const existing = store.getJSON(HISTORY_V2_KEY);
    if (existing && now() - existing.fetchedAt < HISTORY_V2_TTL_MS) return;
    try {
      const { data } = await api.postContract(endpoint, v2Request('history', token));
      if (gen !== generation || !validateHistory(data).ok) return;
      const fetchedAt = now();
      store.setJSON(HISTORY_V2_KEY, { fetchedAt, sectors: adaptHistoryV2(data, fetchedAt) });
      if (snapshot?.contract === 'v2' && freshBase) { snapshot = withAllHistory(freshBase, fetchedAt); emit(); }
    } catch { /* device history remains */ }
  }

  /** Removes every roster-derived key and the in-memory roster (never theme, endpoint, profile). */
  function purgeRoster() {
    for (const key of [CACHE_KEY, HISTORY_KEY, CACHE_V2_KEY, HISTORY_V2_KEY]) store.remove(key);
    contract = { active: null, fallback: null };
    v2RetryAt = 0;
    freshBase = null;
    if (mode.kind === 'production') { snapshot = null; loading = false; }
  }

  return {
    view,
    now,
    /** For tests: resolves when the current production load has settled. */
    load: (opts) => loadProduction(opts),
    /** @param {{kind:'production'}|{kind:'sample',state:string,tone:string}} next */
    setMode(next) {
      mode = next?.kind === 'sample' ? next : { kind: 'production' };
      generation += 1;
      error = null;
      snapshot = null;
      if (mode.kind === 'sample') {
        snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile), mode.variant ?? null);
        loading = false;
        emit();
      } else {
        loadProduction();
      }
    },
    refresh({ force = false } = {}) {
      if (mode.kind === 'production') loadProduction({ force });
      else { snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile), mode.variant ?? null); emit(); }
    },
    /** Called periodically; re-fetches production data when stale. */
    tick() {
      if (mode.kind === 'production' && store.get(ENDPOINT_KEY) && !loading && Date.now() - lastLiveAttempt > REFRESH_MS) loadProduction({ force: true });
      else emit();
    },
    /** Removes cached roster data and sector history (Settings → reset / disconnect). */
    /** Token changed: forget contract caches and fallback state, keep device memory. */
    forgetContractData() {
      store.remove(CACHE_V2_KEY);
      store.remove(HISTORY_V2_KEY);
      contract = { active: null, fallback: null };
      v2RetryAt = 0;
      freshBase = null;
    },
    forgetRosterData() { generation += 1; purgeRoster(); },  // a stale in-flight load must not write it back
    /** S6: removing the token purges all roster-derived data; history returns once the token does. */
    removeToken() {
      store.remove(TOKEN_KEY);
      generation += 1;
      purgeRoster();
      if (mode.kind === 'production') loadProduction(); else emit();
    },
  };
}
