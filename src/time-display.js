// Time display preference: Local | UTC. A user preference, separate from the theme.
//   local  every operational time is shown in the time zone of the place the event belongs to
//          (departure at its airport, arrival at its airport, layover at the destination, base at home).
//          It is never the device's current time zone.
//   utc    every operational time is converted to UTC.
// The preference changes only how an instant is written. It never touches roster data, instants or day keys.
// The current mode is held in module state so the shared formatters (lib/op-time.js) can read it
// synchronously while rendering; the persisted value is the source of truth across reloads and tabs.

import { store as defaultStore } from './store.js';

export const TIME_DISPLAY_MODES = Object.freeze(['local', 'utc']);
export const TIME_DISPLAY_KEY = 'timeDisplay';
export const DEFAULT_TIME_DISPLAY = 'local';

/**
 * One preference bound to a store. The app uses the default instance exported below; tests can bind
 * their own store to check persistence without touching browser storage.
 */
export function createTimeDisplay(store = defaultStore) {
  let current = null;

  const read = () => {
    const value = store.get(TIME_DISPLAY_KEY, DEFAULT_TIME_DISPLAY);
    return TIME_DISPLAY_MODES.includes(value) ? value : DEFAULT_TIME_DISPLAY;
  };

  const get = () => {
    if (current === null) current = read();
    return current;
  };

  /** Applies the mode to the page (data attribute for CSS) and announces it. */
  const apply = (mode = get()) => {
    current = TIME_DISPLAY_MODES.includes(mode) ? mode : DEFAULT_TIME_DISPLAY;
    const root = globalThis.document?.documentElement;
    if (!root) return current;
    root.dataset.timeDisplay = current;
    root.dispatchEvent(new CustomEvent('fc:time-display', { detail: { mode: current } }));
    return current;
  };

  /** Local is the default and is stored as the absence of the key. */
  const set = (mode) => {
    const value = TIME_DISPLAY_MODES.includes(mode) ? mode : DEFAULT_TIME_DISPLAY;
    if (value === DEFAULT_TIME_DISPLAY) store.remove(TIME_DISPLAY_KEY);
    else store.set(TIME_DISPLAY_KEY, value);
    current = value;
    apply(value);
    return value;
  };

  /** Another tab changed (or cleared) the stored preference: follow it. */
  const watch = () => {
    const onStorage = (event) => {
      if (event.key === null || event.key === `fc.v2.${TIME_DISPLAY_KEY}`) apply(read());
    };
    globalThis.addEventListener?.('storage', onStorage);
    return () => globalThis.removeEventListener?.('storage', onStorage);
  };

  /** Forgets the cached mode so the next read goes to the store again. */
  const reset = () => { current = null; };

  return { get, set, apply, watch, reset };
}

const pref = createTimeDisplay();

export const getTimeDisplay = () => pref.get();
export const setTimeDisplay = (mode) => pref.set(mode);
export const applyTimeDisplay = (mode) => pref.apply(mode);
export const watchTimeDisplay = () => pref.watch();
export const resetTimeDisplayCache = () => pref.reset();
