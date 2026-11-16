// Part-time schedule preference, kept on this device only (fc.v2.partTime). Mirrors time-display.js:
// one preference bound to a store, so tests can check persistence with their own storage.
// Never sent anywhere and never written to roster data. "Reset local data" clears it with every
// other fc.v2.* key; signing out does not touch it.

import { store as defaultStore } from './store.js';
import { normalizePartTime } from './model/part-time.js';

export const PART_TIME_KEY = 'partTime';

export function createPartTime(store = defaultStore) {
  const get = () => normalizePartTime(store.getJSON(PART_TIME_KEY));

  const set = (config) => {
    const next = normalizePartTime(config);
    return { ok: store.setJSON(PART_TIME_KEY, next), config: next };
  };

  /** Replaces one month's generated days (an empty list = no V that month). */
  const setOverride = (monthKey, days) => {
    const current = get();
    const next = normalizePartTime({ ...current, overrides: { ...current.overrides, [monthKey]: days } });
    if (!Object.hasOwn(next.overrides, monthKey)) return { ok: false, config: current };
    return set(next);
  };

  const removeOverride = (monthKey) => {
    const current = get();
    const { [monthKey]: _removed, ...rest } = current.overrides;
    return set({ ...current, overrides: rest });
  };

  const reset = () => ({ ok: store.remove(PART_TIME_KEY), config: normalizePartTime(null) });

  return { get, set, setOverride, removeOverride, reset };
}

const pref = createPartTime();

export const getPartTime = () => pref.get();
export const setPartTime = (config) => pref.set(config);
export const setPartTimeOverride = (monthKey, days) => pref.setOverride(monthKey, days);
export const removePartTimeOverride = (monthKey) => pref.removeOverride(monthKey);
