// Radar (read-only, slice 1): "Flights in standby window".
// Scheduled departures from the user's base during a rostered standby window, as factual
// provider data. Order of every row, for fast scanning: departure time → flight number →
// destination → revised time / delay → factual state (Departed / Cancelled only). The aircraft
// is tertiary. Nothing here predicts anything about the user.
//
// Data: the screen never reads storage or the token. ctx.loadDepartures() (main.js) does the
// request; ctx.departuresAccess() says whether one can be made.
//
// One rule decides every request (ensure() below). Each render / mount / update first computes a
// PLAN: {mode, reason, window, key}. `mode` is 'review' or 'production', `window` is chosen again
// every time (route param first, then the active or next standby), and `key` is
// `${mode}|${airport}|${from}|${to}` (null when no request is possible: roster not there, no window,
// no access). A load starts only for a production plan with a key, when that key has no session
// (data or a recorded error), no request already running and no cooldown. Opening the screen
// additionally refreshes an existing session for the key, not forced: the 5-minute device cache
// makes that free. Controller ticks only recompute the plan: same key, no request; a new key (the
// roster changed the window, review mode ended, a token appeared) gets at most one. Refresh and
// Retry send one forced load for the current key. A failed load, Refresh and Retry start a 30 s
// cooldown for that key (module level, so leaving and reopening the screen does not skip it).
// Nothing polls: the only timer re-enables a button and counts the Retry wait down.

import { html, render as domRender } from '../../lib/html.js';
import { formatDate } from '../../lib/time.js';
import { pageHeader } from '../components.js';
import { icon } from '../icons.js';
import { hrefFor } from '../../router.js';
import { clock } from '../duty.js';
import { airlineOf } from '../../airlines/index.js';
import { departuresContext } from '../../model/scheduled-flights.js';
import { selectStandbyWindow, buildRadarView } from '../../model/radar.js';
import { sampleDepartures } from '../../sources/sample.js';

export const RADAR_TITLE = 'Flights in standby window';
export const REFRESH_COOLDOWN_MS = 30000;

export const TEXT = Object.freeze({
  boundary: 'Scheduled departures during your standby. Not a prediction of assignment and not a legality check.',
  loading: 'Loading scheduled departures…',
  none: 'No standby in your roster for the next 14 days.',
  ended: 'This standby window has ended.',
  tooLong: 'This window is longer than 24 hours. Departures are listed for windows up to 24 hours.',
  empty: (iata) => `No departures from ${iata} are scheduled in this window.`,
  tooFar: (date) => `Schedules are available from ${date}.`,
  notConfigured: 'Flight data is not set up on the backend.',
  busy: 'The flight-data provider is busy. Try again in a minute.',
  unavailable: 'Flight data is unavailable right now.',
});

/** User-facing text for a loader failure (DeparturesError or ApiError code). */
export function errorText(error) {
  const code = error?.code;
  if (code === 'departures-not-configured') return TEXT.notConfigured;
  if (code === 'provider-rate-limited') return TEXT.busy;
  return TEXT.unavailable;
}

// In-memory session for the plan on screen (never persisted). It belongs to exactly one key.
//   { key, status:'loading'|'ready'|'error', result, error, refreshError, busy, earlierOpen, review? }
let session = null;
let mounted = false;
let lastHtml = '';
// True from an opening that found no roster yet until the first update() that has one.
let openPending = false;
// Module level, so they outlive the screen: key -> instant before which no further load for it starts;
// key -> the session whose load is running.
const cooldowns = new Map();
const inflight = new Map();

const newSession = (key, extra = {}) => ({
  key, status: 'loading', result: null, error: null, refreshError: null, busy: false, earlierOpen: false, ...extra,
});
const cooldownLeft = (key, now) => Math.max(0, (cooldowns.get(key) ?? 0) - now);
/** A session has something to show for its key: data (also while reloading) or a recorded error. */
const hasState = (s) => s.status !== 'loading' || Boolean(s.result);
const WINDOWLESS = new Set(['none', 'ended', 'too-far', 'too-long']);

/**
 * What the screen is about right now: {mode, reason, window, key, ...}. `reason` is 'ok' when a
 * window can be listed, else why not ('no-roster', 'none', 'ended', 'too-far', 'too-long',
 * 'access'). `key` is null whenever no request is possible. Nothing is remembered between calls.
 */
function plan(ctx) {
  const view = ctx.view();
  const { profile, now, snapshot, review } = view;
  const mode = review ? 'review' : 'production';
  const access = review ? 'ready' : ctx.departuresAccess?.() ?? 'ready';
  if (!snapshot) return { mode, reason: 'no-roster', view, access, window: null, key: null };
  const sel = selectStandbyWindow(snapshot, now, ctx.param?.() ?? null);
  if (sel.reason) return { mode, reason: sel.reason, view, access, sel, window: sel.window, key: null };
  const { airport } = departuresContext(profile);
  const { start: from, end: to } = sel.window;
  const base = { mode, view, access, sel, window: sel.window, airport, from, to };
  if (access !== 'ready') return { ...base, reason: 'access', key: null };
  return { ...base, reason: 'ok', key: `${mode}|${airport}|${from}|${to}`, query: { airport, from, to, carriers: null } };
}

/** Review mode: the fictional list, built once per key and kept (no request of any kind). */
function reviewSession(p) {
  if (session?.key !== p.key) {
    const { profile, now } = p.view;
    const ownCarrier = airlineOf(profile).flightDesignators?.[0] ?? null;
    session = newSession(p.key, {
      status: 'ready', review: true,
      result: sampleDepartures({ airport: p.airport, from: p.from, to: p.to, now, ownCarrier, airportTz: profile.homeTz }),
    });
  }
  return session;
}

/** The session for the plan's key: the one on screen, a running load's, or a new one. Any other session is dropped. */
function claim(p) {
  if (session?.key !== p.key) session = inflight.get(p.key) ?? newSession(p.key);
  return session;
}

// --- Loading ---------------------------------------------------------------------------

/**
 * The single place that decides whether a departures load starts. `open`: the screen is being
 * opened (also: the first update after an opening that found no roster).
 */
function ensure(ctx, p, { open = false } = {}) {
  if (p.mode === 'review') {
    if (p.key) reviewSession(p);
    else if (p.reason !== 'no-roster') session = null;
    return;
  }
  if (session?.review) session = null;                              // review data never reaches production
  if (!p.key) {
    // Nothing can be requested. A missing roster keeps what is there (it may come back); no window or
    // no access does not: nothing from an earlier visit stays.
    if (p.access !== 'ready' || WINDOWLESS.has(p.reason)) session = null;
    if (p.access !== 'ready') inflight.clear();
    return;
  }
  const s = claim(p);
  const known = hasState(s);
  if (known && !open) return;                                     // data or a recorded error: nothing to ask
  if (s.busy || inflight.has(p.key)) return;                       // already on its way
  if (known && cooldownLeft(p.key, p.view.now) > 0) return;       // the first load of a key is never held back
  start(ctx, p, s, { force: false });
}

function start(ctx, p, s, { force }) {
  if (s.busy) return;
  s.busy = true;
  inflight.set(s.key, s);
  s.refreshError = null;
  if (!s.result) { s.status = 'loading'; s.error = null; }
  let pending;
  try { pending = Promise.resolve(ctx.loadDepartures(p.query, { force })); } catch (error) { pending = Promise.reject(error); }
  pending.then(
    (result) => { s.result = result; s.status = 'ready'; s.error = null; },
    (error) => {
      // With data on screen the list stays; otherwise this is an error state with a Retry.
      if (s.result) s.refreshError = error; else { s.status = 'error'; s.error = error; }
      // Errors are not cached, so a failed key rests for 30 s before anything asks again.
      cooldowns.set(s.key, ctx.view().now + REFRESH_COOLDOWN_MS);
    },
  ).finally(() => {
    s.busy = false;
    if (inflight.get(s.key) === s) inflight.delete(s.key);
    if (session === s && mounted) ctx.rerender?.();
  });
}

/** Refresh and Retry: one forced load for the CURRENT plan key, then the shared 30 s pause. */
function refresh(ctx) {
  const p = plan(ctx);
  if (p.mode !== 'production' || !p.key) return;
  const s = claim(p);
  if (s.busy || inflight.has(p.key) || cooldownLeft(p.key, p.view.now) > 0) return;
  cooldowns.set(p.key, p.view.now + REFRESH_COOLDOWN_MS);
  start(ctx, p, s, { force: true });
  ctx.rerender?.();
}

// --- Markup ----------------------------------------------------------------------------

function windowLine(window, tz) {
  const same = formatDate(window.start, tz) === formatDate(window.end - 1, tz);
  return same
    ? `${formatDate(window.start, tz)}, ${clock(window.start, tz)}–${clock(window.end, tz)}`
    : `${formatDate(window.start, tz)} ${clock(window.start, tz)} → ${formatDate(window.end, tz)} ${clock(window.end, tz)}`;
}

function frame(view, body, { window = null, airport = null } = {}) {
  const tz = view.profile.homeTz;
  const parts = [];
  if (window?.label) parts.push(window.label);
  if (window) parts.push(windowLine(window, tz));
  if (airport) parts.push(`Departures from ${airport}`);
  return html`
    <div class="page rd">
      <a class="rd-back" href="${hrefFor('today')}"><span aria-hidden="true">‹ </span>Today</a>
      ${pageHeader({ eyebrow: view.review ? 'Sample data · not your roster' : 'Standby', title: RADAR_TITLE, subtitle: parts.length ? parts.join(' · ') : null })}
      ${body}
    </div>`;
}

function message({ headline, text = null, action = null }) {
  return html`
    <div class="empty rd-empty">
      <div class="empty-icon">${icon('radar')}</div>
      <p class="t-headline">${headline}</p>
      ${text ? html`<p class="empty-text t-callout">${text}</p>` : ''}
      ${action ?? ''}
    </div>`;
}

const todayLink = html`<a class="btn btn-quiet" href="${hrefFor('today')}">Open Today</a>`;
const settingsLink = (label) => html`<a class="btn btn-quiet" href="${hrefFor('settings')}">${label}</a>`;

function rowView(r, ownName) {
  return html`
    <li class="rd-row ${r.emphasized ? 'is-own' : ''} ${r.state ? `is-${r.state}` : ''}">
      <span class="rd-time t-tabular">${r.timeText}</span>
      <span class="rd-flight t-code">${r.emphasized ? html`<span class="rd-mark" role="img" aria-label="Your airline (${ownName})" title="Your airline (${ownName})"></span>` : ''}${r.flightNumber}</span>
      <span class="rd-dest"><span class="rd-city">${r.destinationLabel}</span>${r.destinationCode && r.destinationCode !== r.destinationLabel ? html` <span class="rd-iata t-tabular">${r.destinationCode}</span>` : ''}</span>
      ${r.revisedText ? html`<span class="rd-rev t-tabular"><span class="visually-hidden">Revised departure </span>→ ${r.revisedText} · ${r.delayText}</span>` : ''}
      ${r.state ? html`<span class="rd-chip is-${r.state}">${r.state === 'cancelled' ? 'Cancelled' : 'Departed'}</span>` : ''}
      ${r.aircraft ? html`<span class="rd-ac" title="${r.aircraft}"><span class="visually-hidden">Aircraft </span>${r.aircraft}</span>` : ''}
    </li>`;
}

/** Retry's label: while the key rests, how long is left. */
const retryLabel = (wait) => (wait > 0 ? `Retry in ${Math.ceil(wait / 1000)} s` : 'Retry');

function skeleton() {
  return html`
    <ol class="rd-list rd-skeleton" aria-hidden="true">
      ${[0, 1, 2, 3, 4].map(() => html`<li class="rd-row rd-skel"><span class="rd-skel-bar rd-skel-time"></span><span class="rd-skel-bar rd-skel-flight"></span><span class="rd-skel-bar rd-skel-dest"></span></li>`)}
    </ol>`;
}

function sourceBar(s, view, { review }) {
  const tz = view.profile.homeTz;
  const fetched = s.result ? clock(s.result.fetchedAt, tz) : null;
  const blocked = s.busy || cooldownLeft(s.key, view.now) > 0;
  return html`
    <div class="rd-source">
      <div class="rd-source-text">
        <p class="t-caption t-secondary">${review ? 'Sample schedule data · fictional flights' : `Schedule data · fetched ${fetched}${s.result?.fromCache ? ' (cached)' : ''}`}</p>
        ${s.refreshError ? html`<p class="rd-failed t-caption" role="status">Refresh failed · showing data fetched ${fetched}</p>` : ''}
      </div>
      ${review ? '' : html`<button type="button" class="btn btn-quiet rd-refresh" data-rd-refresh ${blocked ? 'disabled' : ''}>${s.busy ? 'Refreshing…' : 'Refresh'}</button>`}
    </div>`;
}

function listView(rv, p, ownName) {
  const { window } = p;
  const nowText = clock(rv.now, rv.tz);
  const earlier = rv.earlier.length ? html`
    <details class="rd-earlier" data-rd-earlier ${session?.earlierOpen ? 'open' : ''}>
      <summary>Earlier in this window (${rv.earlier.length})</summary>
      <ol class="rd-list" role="list">${rv.earlier.map((r) => rowView(r, ownName))}</ol>
    </details>` : '';
  const divider = rv.active ? html`<div class="rd-now" role="separator" aria-label="Now, ${nowText}"><span class="t-tabular">Now · ${nowText}</span></div>` : '';
  const upcoming = rv.groups.map((g) => html`
    <section class="rd-group" aria-label="Departures from ${g.label}">
      ${g.dayLabel ? html`<p class="rd-day t-eyebrow">${g.dayLabel}</p>` : ''}
      <h3 class="rd-hour t-eyebrow t-tabular">${g.label}</h3>
      <ol class="rd-list" role="list">${g.rows.map((r) => rowView(r, ownName))}</ol>
    </section>`);
  const none = rv.active && rv.groups.length === 0 ? html`<p class="rd-rest t-callout t-secondary">No further departures listed in this window.</p>` : '';
  return html`
    ${rv.tzLabel ? html`<p class="rd-tz t-caption t-secondary">${rv.tzLabel}</p>` : ''}
    <div class="rd-flow">${earlier}${divider}${upcoming}${none}</div>`;
}

function loadedBody(s, p) {
  const { view } = p;
  const { profile } = view;
  const pack = airlineOf(profile);
  const rv = buildRadarView(s.result, {
    now: view.now, window: p.window, emphasisCarriers: pack.flightDesignators ?? null, homeTz: profile.homeTz,
  });
  const empty = rv.total === 0;
  return html`
    <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
    ${sourceBar(s, view, { review: Boolean(s.review) })}
    ${empty ? message({ headline: TEXT.empty(p.airport) }) : listView(rv, p, pack.name)}`;
}

function bodyFor(p) {
  const { view } = p;
  switch (p.reason) {
    case 'no-roster': {
      const needsToken = !view.loading && view.error?.code === 'auth-required';
      return frame(view, message({
        headline: view.loading ? 'Loading roster…' : needsToken ? 'Access token required' : 'No roster source connected',
        text: needsToken ? 'Your roster is only shown with the access token. Add it under Roster contract v2 in Settings.' : 'The Radar needs your roster to know your standby window.',
        action: view.loading ? '' : settingsLink(needsToken ? 'Open Settings' : 'Connect roster source'),
      }));
    }
    case 'none':
      return frame(view, message({ headline: TEXT.none, action: todayLink }));
    case 'ended':
      return frame(view, message({ headline: TEXT.ended, action: todayLink }), { window: p.sel.window, airport: departuresContext(view.profile).airport });
    case 'too-far':
      return frame(view, message({ headline: TEXT.tooFar(formatDate(p.sel.availableFrom, view.profile.homeTz)), action: todayLink }), { window: p.sel.window, airport: departuresContext(view.profile).airport });
    case 'too-long':
      return frame(view, message({ headline: TEXT.tooLong, action: todayLink }), { window: p.sel.window, airport: departuresContext(view.profile).airport });
    case 'access': {
      const noEndpoint = p.access === 'no-endpoint';
      return frame(view, message({
        headline: noEndpoint ? 'No roster source connected' : 'Access token required',
        text: noEndpoint ? 'Scheduled departures need your roster source. Connect it in Settings.' : 'Scheduled departures are only loaded with the access token. Add it under Roster contract v2 in Settings.',
        action: settingsLink(noEndpoint ? 'Connect roster source' : 'Open Settings'),
      }), { window: p.window, airport: p.airport });
    }
    default: {
      const s = p.mode === 'review' ? reviewSession(p) : session?.key === p.key ? session : null;
      const head = { window: p.window, airport: p.airport };
      if (!s || s.status === 'loading') {
        return frame(view, html`
          <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
          <section class="rd-loading" aria-busy="true"><p class="t-callout t-secondary" role="status">${TEXT.loading}</p>${skeleton()}</section>`, head);
      }
      if (s.status === 'error') {
        const wait = cooldownLeft(s.key, view.now);
        return frame(view, html`
          <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
          ${message({ headline: errorText(s.error), action: html`<button type="button" class="btn btn-quiet" data-rd-retry ${s.busy || wait > 0 ? 'disabled' : ''}>${retryLabel(wait)}</button>` })}`, head);
      }
      return frame(view, loadedBody(s, p), head);
    }
  }
}

export const radar = {
  title: RADAR_TITLE,

  render(ctx) {
    const out = bodyFor(plan(ctx));
    lastHtml = out.toString();
    return out;
  },

  /**
   * Opening the screen runs the request rule (ensure) with `open`: an existing session for the key is
   * refreshed without force (the device cache answers within 5 minutes), a missing one is loaded.
   * `quiet` marks a redraw of the screen already open (main.js show): it only loads a key that has
   * no session yet.
   */
  mount(root, ctx, { quiet = false } = {}) {
    const p = plan(ctx);
    mounted = true;
    if (!quiet) openPending = p.reason === 'no-roster';   // roster still loading: the first update() that has one opens
    ensure(ctx, p, { open: !quiet });

    const onClick = (event) => {
      const button = event.target.closest('[data-rd-refresh], [data-rd-retry]');
      if (button && !button.disabled) refresh(ctx);
    };
    const onToggle = (event) => {
      if (session && event.target?.matches?.('[data-rd-earlier]')) session.earlierOpen = event.target.open;
    };
    root.addEventListener('click', onClick);
    root.addEventListener('toggle', onToggle, true);

    // UI only, never fetches: counts the Retry wait down and re-enables the buttons when the key's
    // 30 s pause is over.
    let timer = null;
    const arm = () => {
      const s = session;
      const left = s ? cooldownLeft(s.key, ctx.view().now) : 0;
      if (left <= 0) return;
      timer = setTimeout(() => {
        timer = null;
        if (!mounted || session !== s) return;
        const wait = cooldownLeft(s.key, ctx.view().now);
        const retry = root.querySelector?.('[data-rd-retry]');
        if (retry) retry.textContent = retryLabel(wait);
        if (wait > 0) arm();
        else if (!s.busy) root.querySelector?.('[data-rd-refresh], [data-rd-retry]')?.removeAttribute('disabled');
      }, s.status === 'error' ? Math.min(1000, left) + 20 : left + 50);
      timer.unref?.();
    };
    arm();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      root.removeEventListener('click', onClick);
      root.removeEventListener('toggle', onToggle, true);
    };
  },

  /**
   * Called on every controller change (roster ticks): recomputes the plan and redraws from memory
   * (rows move past "now"). Same key: no request. A new key (window changed, review ended, token
   * added) gets its one load from the request rule; the first update after an opening that found no
   * roster counts as that opening.
   */
  update(root, ctx) {
    const p = plan(ctx);
    const open = openPending && p.reason !== 'no-roster';
    if (open) openPending = false;
    ensure(ctx, p, { open });
    const previous = lastHtml;
    const next = bodyFor(p);
    lastHtml = next.toString();
    if (lastHtml !== previous) domRender(root, next);
  },
};

/** Test hook: forget the in-memory session, cooldowns and running loads. */
export function resetRadarUi() {
  session = null;
  mounted = false;
  lastHtml = '';
  openPending = false;
  cooldowns.clear();
  inflight.clear();
}
