// Flight Control V2: boot.
// Order: storage schema → theme → environment (UNKNOWN until roster data exists) → shell → router.

import { store } from './store.js';
import { applyTheme, setThemePreference, watchSystemTheme, applyEnvironment, getThemePreference } from './theme.js';
import { startRouter, routeById } from './router.js';
import { render } from './lib/html.js';
import { mountShell } from './ui/shell.js';
import { environment, TONES } from './ui/environments.js';
import { today } from './ui/screens/today.js';
import { more } from './ui/screens/more.js';
import { controls } from './ui/screens/controls.js';
import { settings } from './ui/screens/settings.js';
import { calendar, flights, map, weather, statistics } from './ui/screens/upcoming.js';

const SCREENS = { today, calendar, flights, map, more, weather, statistics, controls, settings };

store.ensureSchema();
applyTheme();
watchSystemTheme();
// No roster source yet: the honest operational state is UNKNOWN.
applyEnvironment('unknown');

const shell = mountShell();
const banner = document.getElementById('preview-banner');

// --- App-wide environment preview (design preview only; always bannered) -----------
// main.js owns whether the app-wide preview is active; screens only read it.
let appPreviewActive = false;
const ctx = {
  isAppPreviewActive: () => appPreviewActive,
  setAppPreview(state, tone) {
    appPreviewActive = true;
    applyEnvironment(state, tone);
    const env = environment(state);
    const toneName = state === 'layover' ? TONES.find((t) => t.tone === tone)?.name : null;
    banner.querySelector('[data-banner-text]').textContent =
      `Previewing the ${env.name.toLowerCase()}${toneName ? ` (${toneName.toLowerCase()})` : ''} environment · not roster data`;
    banner.hidden = false;
  },
  clearAppPreview() {
    appPreviewActive = false;
    applyEnvironment('unknown');
    banner.hidden = true;
    document.dispatchEvent(new CustomEvent('fc:preview-cleared'));
  },
};
banner.querySelector('[data-banner-exit]').addEventListener('click', () => ctx.clearAppPreview());

// --- Theme controls (sidebar quick switch + Settings) share one behaviour ----------
function syncThemeControls() {
  const current = getThemePreference();
  for (const button of document.querySelectorAll('[data-theme-control] [data-theme-value]')) {
    const on = button.dataset.themeValue === current;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme-control] [data-theme-value]');
  if (!button) return;
  setThemePreference(button.dataset.themeValue);
});

document.addEventListener('keydown', (event) => {
  // Radio-group arrow-key navigation for every segmented control.
  const button = event.target.closest('[role="radiogroup"] [role="radio"]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const radios = [...button.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')];
  const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
  const next = radios[(radios.indexOf(button) + step + radios.length) % radios.length];
  next.focus();
  next.click();
});

document.documentElement.addEventListener('fc:theme', syncThemeControls);

// --- Routing -------------------------------------------------------------------------
let cleanup = null;
let firstRender = true;

function show(routeId) {
  const screen = SCREENS[routeId] ?? SCREENS.today;
  cleanup?.();
  cleanup = null;
  render(shell.main, screen.render(ctx));
  cleanup = screen.mount?.(shell.main, ctx) ?? null;
  shell.setActive(routeId);
  syncThemeControls();
  document.title = `${routeById(routeId)?.title ?? 'Today'} · Flight Control`;
  if (!firstRender) {
    window.scrollTo({ top: 0 });
    // Move focus to the new page title so screen readers announce the change.
    shell.main.querySelector('.page-title')?.focus({ preventScroll: true });
  }
  firstRender = false;
}

startRouter(show);
