// Flight Control V2: boot.
// Order: storage schema → theme → profile → shell → review dock → data controller → router.
// The operational environment (atmosphere) always follows the derived state of whatever the
// controller is showing; in review mode that is labelled review data, never production state.

import { store } from './store.js';
import { applyTheme, setThemePreference, watchSystemTheme, applyEnvironment, getThemePreference } from './theme.js';
import { startRouter, routeById } from './router.js';
import { render } from './lib/html.js';
import { formatTime, countdown } from './lib/time.js';
import { airport } from './data/airports.js';
import { loadProfile } from './config/profile.js';
import { createController } from './controller.js';
import { mountShell } from './ui/shell.js';
import { mountReviewDock, reviewMode } from './ui/review.js';
import { today } from './ui/screens/today.js';
import { more } from './ui/screens/more.js';
import { controls } from './ui/screens/controls.js';
import { settings } from './ui/screens/settings.js';
import { calendar, flights, map, weather, statistics } from './ui/screens/upcoming.js';

const SCREENS = { today, calendar, flights, map, more, weather, statistics, controls, settings };

store.ensureSchema();
applyTheme();
watchSystemTheme();

const profile = loadProfile();
const shell = mountShell();
let currentRoute = null;

// --- Data -----------------------------------------------------------------------------
function environmentFor(view) {
  const { status, location } = view.state;
  const tone = view.toneOverride ?? airport(location)?.tone ?? 'stone';
  return { state: status, tone: status === 'layover' ? tone : null };
}

const controller = createController({
  profile,
  onChange(view) {
    const env = environmentFor(view);
    applyEnvironment(env.state, env.tone);
    shell.setStatus(view);
    if (currentRoute === 'today') show('today', { quiet: true });
  },
});

const review = mountReviewDock(document.getElementById('review-dock'), document.getElementById('review-banner'), (next) => controller.setMode(reviewMode(next)));

const ctx = {
  view: () => controller.view(),
  controller,
  review: () => review.current(),
  rerender: () => currentRoute && show(currentRoute, { quiet: true }),
};

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

// --- Live elements: countdowns tick every second, clocks every 15 s ---------------------
function tickLive() {
  const now = controller.now();
  for (const el of document.querySelectorAll('[data-countdown-to]')) {
    const cd = countdown(now, Number(el.dataset.countdownTo));
    const text = cd.past ? 'Now' : `in ${cd.label}`;
    if (el.textContent !== text) el.textContent = text;
  }
}
function tickClocks() {
  const now = controller.now();
  for (const el of document.querySelectorAll('[data-clock-tz]')) {
    if (el.dataset.clockTz) el.textContent = formatTime(now, el.dataset.clockTz) ?? el.textContent;
  }
}
setInterval(tickLive, 1000);
setInterval(tickClocks, 15000);
// Re-derive state each minute (phases change with time), and refresh stale data.
setInterval(() => controller.tick(), 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') controller.tick(); });

// --- Routing -------------------------------------------------------------------------
let cleanup = null;
let firstRender = true;

function show(routeId, { quiet = false } = {}) {
  currentRoute = routeId;
  const screen = SCREENS[routeId] ?? SCREENS.today;
  const keepScroll = quiet ? window.scrollY : 0;
  cleanup?.();
  cleanup = null;
  render(shell.main, screen.render(ctx));
  cleanup = screen.mount?.(shell.main, ctx) ?? null;
  shell.setActive(routeId);
  syncThemeControls();
  document.title = `${review.current() ? 'Sample · ' : ''}${routeById(routeId)?.title ?? 'Today'} · Flight Control`;
  if (quiet) window.scrollTo({ top: keepScroll });
  if (!firstRender && !quiet) {
    window.scrollTo({ top: 0 });
    // Move focus to the new page title so screen readers announce the change.
    shell.main.querySelector('.page-title')?.focus({ preventScroll: true });
  }
  firstRender = false;
}

startRouter(show);
controller.setMode(reviewMode(review.current()));
