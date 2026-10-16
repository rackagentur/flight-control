import { refreshControls, mountPullRefresh } from './ui/pull-refresh.js';
// Flight Control V2: boot.
// Order: storage schema → theme → profile → shell → review dock → data controller → router.
// The operational environment (atmosphere) always follows the derived state of whatever the
// controller is showing; in review mode that is labelled review data, never production state.

import { store } from './store.js';
import { applyTheme, setThemePreference, watchSystemTheme, applyEnvironment, getThemePreference } from './theme.js';
import { getTimeDisplay, setTimeDisplay, applyTimeDisplay, watchTimeDisplay } from './time-display.js';
import { startRouter, routeById, hrefFor } from './router.js';
import { html, render } from './lib/html.js';
import { syncStatus, syncStatusText } from './ui/sync-status.js';
import { watchOfflineShell } from './offline-shell.js';
import { ROSTER_KEY, SIGNED_OUT_KEY } from './roster-storage.js';
import { formatTime, countdown, addDays, localDateKey } from './lib/time.js';
import { airport } from './data/airports.js';
import { loadProfile } from './config/profile.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from './controller.js';
import { loadDepartures } from './sources/departures-service.js';
import { loadFlightInfo } from './sources/flight-info-service.js';
import { mountShell } from './ui/shell.js';
import { mountReviewDock, reviewMode } from './ui/review.js';
import { today } from './ui/screens/today.js';
import { more } from './ui/screens/more.js';
import { controls } from './ui/screens/controls.js';
import { settings } from './ui/screens/settings.js';
import { calendar, focusCalendar } from './ui/screens/calendar.js';
import { flights } from './ui/screens/flights.js';
import { radar } from './ui/screens/radar.js';
import { map, weather, statistics } from './ui/screens/upcoming.js';
import { createWeather } from './sources/weather-openmeteo.js';
import { sampleWeather } from './sources/sample.js';
import { buildFlights } from './model/flights.js';
import { mountHorizonLabels } from './ui/horizon.js';

const SCREENS = { today, calendar, flights, radar, map, more, weather, statistics, controls, settings };

store.ensureSchema();
applyTheme();
watchSystemTheme();
applyTimeDisplay();
watchTimeDisplay();

const profile = loadProfile();
const shell = mountShell();
let currentRoute = null;
let currentParam = null;
let renderingView = null;
let pullRefresh = null;
let latestView = null;
const LIVE_ROUTES = new Set(['today', 'calendar', 'flights']);

// --- Data -----------------------------------------------------------------------------
function environmentFor(view) {
  const { status, location } = view.state;
  const tone = view.toneOverride ?? airport(location)?.tone ?? 'stone';
  return { state: status, tone: status === 'layover' ? tone : null };
}

const controller = createController({
  profile,
  onChange(view) {
    latestView = view;
    const env = environmentFor(view);
    applyEnvironment(env.state, env.tone);
    shell.setStatus(view);
    pullRefresh?.update(`${currentRoute}/${currentParam ?? ""}`);
    const status = shell.main.querySelector('[data-sync-status]');
    if (status) status.textContent = syncStatusText(view);
    if (LIVE_ROUTES.has(currentRoute)) show(currentRoute, { quiet: true, param: currentParam, view });
    // Other screens may refresh in place (Settings: the contract status line).
    else SCREENS[currentRoute]?.update?.(shell.main, ctx);
  },
});

// S6: the token was removed in another tab (or storage cleared): purge this tab's roster too.
window.addEventListener('storage', (event) => {
  if (event.key === null || [TOKEN_KEY, ENDPOINT_KEY, SIGNED_OUT_KEY, 'profile'].some((key) => event.key === `fc.v2.${key}`) || (event.key === `fc.v2.${ROSTER_KEY}` && event.newValue === null)) {
    liveWeather.clear();
    controller.accessChanged();
    if (currentRoute) show(currentRoute, { quiet: true, param: currentParam });
  }
});

const review = mountReviewDock(
  document.getElementById('review-dock'),
  document.getElementById('review-banner'),
  (next) => controller.setMode(reviewMode(next)),
  (offset) => {
    // Review-only: jump to a scenario day of the fictional sample month.
    const { now, profile } = controller.view();
    const today = localDateKey(now, profile.homeTz);
    const date = offset === null ? null : addDays(today, offset);
    focusCalendar((date ?? today).slice(0, 7), date);
    if (location.hash !== '#/calendar') location.hash = '#/calendar';
    else show('calendar', { quiet: true });
  },
  (scenario) => {
    // Review-only: open Flights on the scenario's list or sector (fictional sample data).
    const view = controller.view();
    const f = view.roster ? buildFlights(view.snapshot, view.roster, view.state, view.profile, view.now) : null;
    let target = hrefFor('flights');
    if (f && scenario.pick === 'stay') {
      const staying = [...f.sectors.values()].find((e) => e.destination?.stay?.current);
      if (staying) target = hrefFor('flights', staying.sector.id);
    }
    if (location.hash !== target) location.hash = target;
    else show('flights', { quiet: true, param: currentParam });
    if (scenario.pick === 'recent') requestAnimationFrame(() => document.getElementById('fl-recent')?.scrollIntoView({ block: 'start' }));
  },
);

// Weather (decision D1): Open-Meteo from the browser in production; review mode uses labelled
// samples and never touches the network.
const liveWeather = createWeather({
  onUpdate: () => { if (currentRoute === 'flights' || currentRoute === 'today') show(currentRoute, { quiet: true, param: currentParam }); },
});

let accessGeneration = 0;
let visitSeq = 0;
let seenAccess = { endpoint: store.get(ENDPOINT_KEY), token: store.get(TOKEN_KEY) };

const ctx = {
  view: () => renderingView ?? controller.view(),
  controller,
  clearPersonalMemory: () => liveWeather.clear(),
  review: () => review.current(),
  param: () => currentParam,
  weather: (query) => (review.current() ? sampleWeather(query) : liveWeather.lookup(query)),
  rerender: () => currentRoute && show(currentRoute, { quiet: true, param: currentParam }),
  visit: () => visitSeq,
  // Departures (Radar): the screen never reads storage or the token; it only asks. Called on mount of
  // #/radar and on Refresh / Retry, never on a timer. `force` skips the 5-minute device cache read.
  // Opaque identity of the access (endpoint + token): a counter that moves whenever either is removed or
  // replaced, in this tab or another (compared lazily against the store on every call). The Radar tags
  // each load with it and ignores answers of an older identity. It never exposes the token.
  accessId: () => {
    const endpoint = store.get(ENDPOINT_KEY);
    const token = store.get(TOKEN_KEY);
    if (endpoint !== seenAccess.endpoint || token !== seenAccess.token) { accessGeneration += 1; seenAccess = { endpoint, token }; }
    return `${accessGeneration}:${controller.accessRevision()}`;
  },
  // Live flight information (Flight Detail gates): same access rule and same stale-answer guard as departures.
  flightInfoAccess: () => (!store.get(ENDPOINT_KEY) ? 'no-endpoint' : !store.get(TOKEN_KEY) ? 'no-token' : 'ready'),
  loadFlightInfo: (sector, { force = false } = {}) => {
    const endpoint = store.get(ENDPOINT_KEY);
    const token = store.get(TOKEN_KEY);
    const revision = controller.accessRevision();
    return loadFlightInfo({ endpoint, token, sector }, {
      force, accessKey: ctx.accessId(),
      shouldStore: () => store.get(ENDPOINT_KEY) === endpoint && store.get(TOKEN_KEY) === token && controller.accessRevision() === revision,
    });
  },
  departuresAccess: () => (!store.get(ENDPOINT_KEY) ? 'no-endpoint' : !store.get(TOKEN_KEY) ? 'no-token' : 'ready'),
  // The answer is written to the device cache (and handed back) only while the endpoint and token it was
  // requested with are still the ones in the store: removing or replacing the token mid-request must not
  // leave a departures entry behind (the controller purges the cache at that moment).
  loadDepartures: (query, { force = false } = {}) => {
    const endpoint = store.get(ENDPOINT_KEY);
    const token = store.get(TOKEN_KEY);
    const revision = controller.accessRevision();
    return loadDepartures({ ...query, endpoint, token }, {
      store, force,
      shouldStore: () => store.get(ENDPOINT_KEY) === endpoint && store.get(TOKEN_KEY) === token && controller.accessRevision() === revision,
    });
  },
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

// --- Time display control (Settings): Local | UTC, separate from the theme -----------------
function syncTimeDisplayControls() {
  const current = getTimeDisplay();
  for (const button of document.querySelectorAll('[data-time-display-control] [data-time-display-value]')) {
    const on = button.dataset.timeDisplayValue === current;
    button.setAttribute('aria-checked', String(on));
    button.tabIndex = on ? 0 : -1;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-time-display-control] [data-time-display-value]');
  if (!button) return;
  setTimeDisplay(button.dataset.timeDisplayValue);
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
// A Time Display change (here or in another tab) only changes how instants are written: draw the current
// screen again from the same data. Focus and scroll stay where they are (quiet render).
const TIME_ROUTES = new Set(['today', 'calendar', 'flights', 'radar']);
document.documentElement.addEventListener('fc:time-display', (event) => {
  const hadFocus = document.activeElement?.closest?.('[data-time-display-control]');
  // Screens without operational times (Settings keeps typed input) are left alone; the others redraw.
  if (TIME_ROUTES.has(currentRoute)) show(currentRoute, { quiet: true, param: currentParam });
  syncTimeDisplayControls();
  const status = shell.main.querySelector('[data-sync-status]');
  if (status) status.textContent = syncStatusText(controller.view());
  if (hadFocus) document.querySelector(`[data-time-display-control] [data-time-display-value="${event.detail.mode}"]`)?.focus();
});

// --- Live elements: countdowns tick every second, clocks every 15 s ---------------------
function tickLive() {
  const now = controller.now();
  for (const el of document.querySelectorAll('[data-countdown-to]')) {
    const cd = countdown(now, Number(el.dataset.countdownTo));
    const text = cd.past ? 'Now' : `in ${cd.label}`;
    if (el.textContent !== text) el.textContent = text;
  }
}
// These are labelled location clocks ("local time" at home / the outstation): they show the time at that
// place in both Time Display modes, so they deliberately do not go through the operational time layer.
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

function show(routeId, { quiet = false, param = null, soft = false, view = null } = {}) {
  currentRoute = routeId;
  currentParam = param;
  // A detail change inside the same screen keeps the page in place; the screen handles focus/scroll.
  if (soft) quiet = true;
  const screen = SCREENS[routeId] ?? SCREENS.today;
  const keepScroll = quiet ? window.scrollY : 0;
  const refreshFocused = document.activeElement?.matches('[data-roster-manual-refresh]');
  cleanup?.();
  cleanup = null;
  const previousView = renderingView;
  renderingView = view ?? controller.view();
  try {
    render(shell.main, html`${syncStatus(renderingView)}${LIVE_ROUTES.has(routeId) && !renderingView.review ? refreshControls() : ""}${screen.render(ctx)}`);
    const screenCleanup = screen.mount?.(shell.main, ctx, { quiet });
    const horizonCleanup = mountHorizonLabels(shell.main);
    cleanup = () => { horizonCleanup(); screenCleanup?.(); };
  } finally { renderingView = previousView; }
  pullRefresh?.update(`${routeId}/${param ?? ""}`);
  if (refreshFocused) shell.main.querySelector('[data-roster-manual-refresh]')?.focus({ preventScroll: true });
  shell.setActive(routeId);
  syncThemeControls();
  syncTimeDisplayControls();
  document.title = `${review.current() ? 'Sample · ' : ''}${routeById(routeId)?.title ?? 'Today'} · Flight Control`;
  if (quiet && !soft) window.scrollTo({ top: keepScroll });
  if (!firstRender && !quiet) {
    window.scrollTo({ top: 0 });
    // Move focus to the new page title so screen readers announce the change.
    shell.main.querySelector('.page-title')?.focus({ preventScroll: true });
  }
  firstRender = false;
}

pullRefresh = mountPullRefresh({ root: shell.main, enabled: () => LIVE_ROUTES.has(currentRoute) && !review.current(),
  refresh: () => controller.refresh({ force: true }), view: () => latestView ?? controller.view() });

// Navigations (not quiet redraws) are counted: Flight Detail renews live information only on a visit.
startRouter((id, param) => { visitSeq += 1; show(id, { param, soft: id === currentRoute && param !== currentParam }); });
controller.setMode(reviewMode(review.current()));

window.addEventListener('online', () => controller.connectivityChanged());
window.addEventListener('offline', () => controller.connectivityChanged());
watchOfflineShell((ready) => controller.setShellReady(ready));
// Persistence is a best-effort request; readiness still depends on verified writes.
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
