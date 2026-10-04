// Data controller: where the roster comes from, and the derived view the UI renders.
//   production  cached payload first (instant), then live getStats; sector history kept
//   sample      ?review fictional snapshot per state (HOME/AWAY, SAMPLE flights); never
//               touches production storage, uses a fictional review profile
// The synthetic v5 fixture is test data only and is never shown in the app.

import { store } from './store.js';
import { fetchStats, ApiError } from './api/appscript.js';
import { adaptV5, AdapterError } from './sources/fc-appscript-v5.js';
import { sampleSnapshot, sampleProfile } from './sources/sample.js';
import { withHistory, rememberSectors } from './model/history.js';
import { buildRoster } from './model/roster.js';
import { deriveState } from './model/state.js';
import { buildHorizon } from './model/horizon.js';

const CACHE_KEY = 'cache.v5';
const HISTORY_KEY = 'history.v5';
export const ENDPOINT_KEY = 'endpoint';
const REFRESH_MS = 10 * 60000;

export function createController({ profile, onChange }) {
  let mode = { kind: 'production' };
  let snapshot = null;
  let error = null;
  let loading = false;
  let lastLiveAttempt = 0;
  let generation = 0;               // ignores stale async results after a mode switch

  const now = () => Date.now();
  const activeProfile = () => (mode.kind === 'sample' ? sampleProfile(profile) : profile);

  function view() {
    const t = now();
    const p = activeProfile();
    const roster = snapshot ? buildRoster(snapshot, p, t) : null;
    const state = deriveState(snapshot, roster, p, t);
    const horizon = roster ? buildHorizon(roster, state, p, t) : null;
    return {
      profile: p, now: t, snapshot, roster, state, horizon, error, loading,
      review: mode.kind === 'sample', mode,
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

    const cached = store.getJSON(CACHE_KEY);
    if (!snapshot && cached?.payload && Number.isFinite(cached.fetchedAt)) {
      try {
        snapshot = withHistory(adaptV5(cached.payload, { profile, fetchedAt: cached.fetchedAt, kind: 'cache' }), store.getJSON(HISTORY_KEY, []), now());
      } catch { snapshot = null; }
    }
    if (!force && snapshot?.source.kind === 'live' && now() - snapshot.source.fetchedAt < REFRESH_MS / 2) { emit(); return; }

    loading = true;
    lastLiveAttempt = Date.now();
    emit();
    try {
      const { data } = await fetchStats(endpoint);
      if (gen !== generation) return;
      const fetchedAt = Date.now();
      const fresh = adaptV5(data, { profile, fetchedAt, kind: 'live' });
      const history = rememberSectors(store.getJSON(HISTORY_KEY, []), fresh, fetchedAt);
      store.setJSON(HISTORY_KEY, history);
      store.setJSON(CACHE_KEY, { payload: data, fetchedAt });
      snapshot = withHistory(fresh, history, fetchedAt);
    } catch (e) {
      if (gen !== generation) return;
      error = e instanceof ApiError || e instanceof AdapterError ? e : new ApiError('network', 'Unexpected error while loading the roster.');
    } finally {
      if (gen === generation) { loading = false; emit(); }
    }
  }

  return {
    view,
    now,
    /** @param {{kind:'production'}|{kind:'sample',state:string,tone:string}} next */
    setMode(next) {
      mode = next?.kind === 'sample' ? next : { kind: 'production' };
      generation += 1;
      error = null;
      snapshot = null;
      if (mode.kind === 'sample') {
        snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile));
        loading = false;
        emit();
      } else {
        loadProduction();
      }
    },
    refresh({ force = false } = {}) {
      if (mode.kind === 'production') loadProduction({ force });
      else { snapshot = sampleSnapshot(mode.state, mode.tone, now(), sampleProfile(profile)); emit(); }
    },
    /** Called periodically; re-fetches production data when stale. */
    tick() {
      if (mode.kind === 'production' && store.get(ENDPOINT_KEY) && !loading && Date.now() - lastLiveAttempt > REFRESH_MS) loadProduction({ force: true });
      else emit();
    },
    /** Removes cached roster data and sector history (Settings → reset / disconnect). */
    forgetRosterData() {
      store.remove(CACHE_KEY);
      store.remove(HISTORY_KEY);
    },
  };
}
