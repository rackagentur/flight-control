// Appearance: Light / Dark / System theme and the operational-state environment.
// Theme is a user preference (persisted). Operational state is derived from roster data
// and only ever set by the state engine (Phase 4); until then the app shows UNKNOWN.

import { store } from './store.js';

export const THEMES = ['light', 'dark', 'system'];
export const STATES = ['off', 'flight', 'standby', 'reserve', 'layover', 'unknown'];
export const LAYOVER_TONES = ['ocean', 'olive', 'stone', 'sand'];

const THEME_KEY = 'theme';
const root = () => document.documentElement;
const systemDark = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)');

export function getThemePreference() {
  const value = store.get(THEME_KEY, 'system');
  return THEMES.includes(value) ? value : 'system';
}

export function setThemePreference(theme) {
  const value = THEMES.includes(theme) ? theme : 'system';
  if (value === 'system') store.remove(THEME_KEY);
  else store.set(THEME_KEY, value);
  applyTheme(value);
  return value;
}

export function resolvedTheme(preference = getThemePreference()) {
  if (preference !== 'system') return preference;
  return systemDark()?.matches ? 'dark' : 'light';
}

export function applyTheme(preference = getThemePreference()) {
  // A theme switch is instant; the slow atmosphere cross-fade is reserved for operational
  // state changes. Suspending transitions also works around Chrome keeping transitioned,
  // registered light-dark() colours on the previous scheme after color-scheme changes.
  const el = root();
  el.classList.add('theme-switching');
  if (preference === 'system') delete el.dataset.theme;
  else el.dataset.theme = preference;
  getComputedStyle(el).getPropertyValue('--st-canvas'); // flush style with transitions off
  syncThemeColor();
  // A timer (not rAF) so this also completes in background tabs, e.g. a system theme
  // change while the app is hidden. The flush above already committed the new values.
  setTimeout(() => el.classList.remove('theme-switching'), 0);
  el.dispatchEvent(new CustomEvent('fc:theme', { detail: { preference, resolved: resolvedTheme(preference) } }));
}

/** Keeps the browser/OS chrome colour in step with the current canvas. */
export function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const canvas = getComputedStyle(root()).getPropertyValue('--st-canvas').trim();
  if (canvas) meta.setAttribute('content', canvas);
}

export function watchSystemTheme() {
  const query = systemDark();
  const onSystem = () => { if (getThemePreference() === 'system') applyTheme('system'); };
  // Another tab changed the stored preference (or cleared local data): follow it.
  const onStorage = (event) => {
    if (event.key === null || event.key === `fc.v2.${THEME_KEY}`) applyTheme(getThemePreference());
  };
  query?.addEventListener('change', onSystem);
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    query?.removeEventListener('change', onSystem);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

/** Applies an operational environment to an element (default: the whole app). */
export function applyEnvironment(state, tone = null, element = root()) {
  element.dataset.state = STATES.includes(state) ? state : 'unknown';
  if (state === 'layover' && LAYOVER_TONES.includes(tone)) element.dataset.tone = tone;
  else delete element.dataset.tone;
  if (element === root()) {
    // Wait for the atmosphere cross-fade to settle before sampling the canvas colour.
    setTimeout(syncThemeColor, 600);
  }
}
