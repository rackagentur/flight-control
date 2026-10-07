// Radar (read-only, slice 1): "Flights in standby window".
// Scheduled departures from the user's base during a rostered standby window, as factual
// provider data. Order of every row, for fast scanning: departure time → flight number →
// destination → revised time / delay → factual state (Departed / Cancelled only). The aircraft
// is tertiary. Nothing here predicts anything about the user.
//
// Data: the screen never reads storage or the token. ctx.loadDepartures() (main.js) does the
// request (and refuses to write the device cache once the endpoint or token changed);
// ctx.departuresAccess() says whether one can be made.
//
// One rule decides every request (ensure() below). Each render / mount / update first computes a
// PLAN: {mode, reason, window, key}. `mode` is 'review' or 'production', `window` is chosen again
// every time (route param first, then the active or next standby), and `key` is
// `${mode}|${airport}|${carriers or *}|${from}|${to}` (null when no request is possible: roster not
// there, no window, no access). The airport is where the standby is served (radarAirport: the roster
// event's own airport, else inferred from the adjacent duty, else the profile base) and the carriers are
// the active airline pack's flight designators (radarCarriers; none = all carriers). Today and Calendar
// both only link here with the window's start, so this plan() is the one place that decides both.
// A load starts only for a production plan with a key, when that key has no session
// (data or a recorded error), no request already running and no cooldown. Opening the screen
// additionally refreshes an existing session for the key, not forced: the 5-minute device cache
// makes that free. Controller ticks only recompute the plan: same key, no request; a new key (the
// roster changed the window, review mode ended, a token appeared) gets at most one. Refresh and
// Retry send one forced load for the current key. A failed load, Refresh and Retry start a 30 s
// cooldown for that key. The cooldown (and the last error of a failed key) lives at module level, so
// leaving and reopening the screen, or visiting another window and coming back, does not skip it: an
// unexpired failed key starts nothing, not even a "first" load, and shows its error with the Retry
// countdown. Only a key that never failed (no entry) loads at once. The last successful result of every
// key is kept beside its cooldown (module level, this app session): coming back to a key inside its
// pause shows that data at once (with "Refresh failed · showing data fetched HH:MM" when the pause came
// from a failed Refresh), Refresh disabled, no request. A key that never loaded shows the error state.
// ACCESS IDENTITY: ctx.accessId() (main.js) is an opaque counter that changes whenever the endpoint or
// token is removed or replaced (never exposes either). Every load is tagged with the identity it started
// under. On a change (seen in render / mount / update / refresh, or when a load's answer arrives) every
// running load of the old identity is neutralised (its answer or error is ignored entirely: no state,
// no error text, no cooldown), and the cooldowns, remembered errors, last results and the session are
// cleared, so nothing recorded under the old identity can block the new one. The screen then plans for
// the new identity normally: one load for the current key. Losing access (no token / endpoint) drops
// every running load too: a late answer is neither shown nor stored.
// Nothing polls: the only timer re-enables a button and counts the Retry wait down.

import { html, render as domRender } from '../../lib/html.js';
import { formatDate } from '../../lib/time.js';
import { pageHeader } from '../components.js';
import { icon } from '../icons.js';
import { hrefFor } from '../../router.js';
import { clock } from '../duty.js';
import { airlineOf } from '../../airlines/index.js';
import { selectStandbyWindow, buildRadarView, radarAirport, radarCarriers } from '../../model/radar.js';
import { sampleDepartures } from '../../sources/sample.js';

export const RADAR_TITLE = 'Flights in standby window';
export const REFRESH_COOLDOWN_MS = 30000;

export const TEXT = Object.freeze({
  boundary: 'Scheduled departures during your standby. Not a prediction of assignment and not a legality check.',
  loading: 'Loading scheduled departures…',
  none: 'No standby in your roster for the next 14 days.',
  ended: 'This standby window has ended.',
  tooLong: 'This window is longer than 24 hours. Departures are listed for windows up to 24 hours.',
  empty: (iata, carrierName = null) => `No ${carrierName ? `${carrierName} departures` : 'departures'} from ${iata} are scheduled in this window.`,
  tooFar: (date) => `Schedules are available from ${date}.`,
  notConfigured: 'Flight data is not set up on the backend.',
  busy: 'The flight-data provider is busy. Try again in a minute.',
  unavailable: 'Flight data is unavailable right now.',
});

/** What the header says about where the airport comes from; the roster's own statement needs no note. */
const BASIS_NOTE = Object.freeze({
  roster: null,
  'inferred-next': 'from your next duty',
  'inferred-previous': 'from your previous flight',
  base: 'your base · the roster gives no standby location',
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
// Module level, so they outlive the screen: key -> {until, error}: the instant before which no further
// load for it starts, and the error that started the pause (null for a Refresh/Retry pause that has not
// failed); key -> the session whose load is running.
const cooldowns = new Map();
const inflight = new Map();
// key -> last successful result (this app session). Not written by review mode, cleared on access change.
const loaded = new Map();
// The access identity last seen (undefined until the first plan; ctx.accessId() may be absent in tests).
let accessId;

const newSession = (key, extra = {}) => ({
  key, status: 'loading', result: null, error: null, refreshError: null, busy: false, earlierOpen: false, ...extra,
});
const cooldownLeft = (key, now) => Math.max(0, (cooldowns.get(key)?.until ?? 0) - now);
/** A session has something to show for its key: data (also while reloading) or a recorded error. */
const hasState = (s) => s.status !== 'loading' || Boolean(s.result);
const WINDOWLESS = new Set(['none', 'ended', 'too-far', 'too-long']);

/**
 * What the screen is about right now: {mode, reason, window, key, ...}. `reason` is 'ok' when a
 * window can be listed, else why not ('no-roster', 'none', 'ended', 'too-far', 'too-long',
 * 'access'). `key` is null whenever no request is possible. Nothing is remembered between calls.
 */
function plan(ctx) {
  syncAccess(ctx);
  const view = ctx.view();
  const { profile, now, snapshot, review } = view;
  const mode = review ? 'review' : 'production';
  const access = review ? 'ready' : ctx.departuresAccess?.() ?? 'ready';
  if (!snapshot) return { mode, reason: 'no-roster', view, access, window: null, key: null };
  const sel = selectStandbyWindow(snapshot, now, ctx.param?.() ?? null);
  const pack = airlineOf(profile);
  const carriers = radarCarriers(pack);
  const { airport, basis } = radarAirport(sel.window, snapshot, profile);
  const head = { airport, basis, carriers, pack };
  if (sel.reason) return { mode, reason: sel.reason, view, access, sel, window: sel.window, key: null, ...head };
  const { start: from, end: to } = sel.window;
  const base = { mode, view, access, sel, window: sel.window, from, to, ...head };
  if (access !== 'ready') return { ...base, reason: 'access', key: null };
  return { ...base, reason: 'ok', key: `${mode}|${airport}|${carriers?.join(',') ?? '*'}|${from}|${to}`, query: { airport, from, to, carriers } };
}

/** Review mode: the fictional list, built once per key and kept (no request of any kind). */
function reviewSession(p) {
  if (session?.key !== p.key) {
    const { profile, now } = p.view;
    const ownCarrier = p.carriers?.[0] ?? null;
    const sample = sampleDepartures({ airport: p.airport, from: p.from, to: p.to, now, ownCarrier, airportTz: profile.homeTz });
    // The same carrier filter as a real request: with carriers set, every fictional row is one of them
    // (spread over the list), so the sample shows the filtered list, not a mixed one.
    const result = p.carriers
      ? { ...sample, carriers: p.carriers, flights: Object.freeze(sample.flights.map((f, i) => Object.freeze({ ...f, carrier: p.carriers[i % p.carriers.length] }))) }
      : sample;
    session = newSession(p.key, { status: 'ready', review: true, result });
  }
  return session;
}

/**
 * The session for the plan's key: the one on screen, a running load's, or a new one. Any other session
 * is dropped. A new one for a key that failed and still rests starts in its error state (the module-level
 * error), so coming back inside the pause shows the Retry countdown, never a bare loading state.
 */
function claim(p) {
  if (session?.key !== p.key) {
    const rest = cooldowns.get(p.key);
    const resting = cooldownLeft(p.key, p.view.now) > 0;
    const last = loaded.get(p.key);
    // Inside a pause, data already loaded for the key is shown again at once (no request); the failure
    // that started the pause, if any, becomes the "Refresh failed" line. Only without data: the error state.
    session = inflight.get(p.key)
      ?? (resting && last ? newSession(p.key, { status: 'ready', result: last, refreshError: rest?.error ?? null })
        : rest?.error && resting ? newSession(p.key, { status: 'error', error: rest.error }) : newSession(p.key));
  }
  return session;
}

/** Drops every running load (access lost): their answers are ignored when they arrive. */
function dropInflight() {
  for (const s of inflight.values()) s.dropped = true;
  inflight.clear();
}

/**
 * Notices an access change (endpoint or token removed or replaced) and forgets everything that belongs
 * to the old identity: running loads (ignored when they answer), pauses, remembered errors and results,
 * the session. Cheap and idempotent; every entry point goes through plan(), which calls it first.
 */
function syncAccess(ctx) {
  const id = ctx.accessId?.();
  if (id === undefined) return false;
  const changed = accessId !== undefined && id !== accessId;
  accessId = id;
  if (changed) { dropInflight(); cooldowns.clear(); loaded.clear(); session = null; }
  return changed;
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
    if (p.access !== 'ready') dropInflight();
    return;
  }
  const s = claim(p);
  const known = hasState(s);
  if (known && !open) return;                                     // data or a recorded error: nothing to ask
  if (s.busy || inflight.has(p.key)) return;                       // already on its way
  // An unexpired pause blocks any load of the key, a first one included, when the key has something
  // to show or failed (claim() seeds the error). A Refresh pause without a failure leaves a fresh device
  // cache behind, so a session-less return may still ask (not forced: answered from that cache).
  if (cooldownLeft(p.key, p.view.now) > 0 && (known || cooldowns.get(p.key)?.error)) return;
  start(ctx, p, s, { force: false });
}

function start(ctx, p, s, { force }) {
  if (s.busy) return;
  s.busy = true;
  inflight.set(s.key, s);
  s.refreshError = null;
  if (!s.result) { s.status = 'loading'; s.error = null; }
  const startedUnder = ctx.accessId?.();                 // read right before the loader reads endpoint and token
  let renew = false;
  // True when the answer belongs to an access identity that no longer applies: it is ignored entirely.
  const outdated = () => {
    if (s.dropped) return true;
    if (ctx.accessId?.() === startedUnder) return false;
    s.dropped = true;
    syncAccess(ctx);                                      // forget the old identity's state
    renew = true;                                         // and plan again for the new one (if mounted)
    return true;
  };
  let pending;
  try { pending = Promise.resolve(ctx.loadDepartures(p.query, { force })); } catch (error) { pending = Promise.reject(error); }
  pending.then(
    (result) => {
      if (outdated()) return;                     // access was lost or replaced meanwhile: the answer is not used
      s.result = result; s.status = 'ready'; s.error = null;
      loaded.set(s.key, result);
      const rest = cooldowns.get(s.key);
      if (rest) rest.error = null;
    },
    (error) => {
      if (outdated()) return;
      // Data loaded earlier for this key (the session was dropped since) still counts as data on screen.
      if (!s.result && loaded.has(s.key)) { s.result = loaded.get(s.key); s.status = 'ready'; }
      // With data on screen the list stays; otherwise this is an error state with a Retry.
      if (s.result) s.refreshError = error; else { s.status = 'error'; s.error = error; }
      // Errors are not cached, so a failed key rests for 30 s before anything asks again, and the
      // error is remembered with the pause (the session itself may be dropped by then).
      cooldowns.set(s.key, { until: ctx.view().now + REFRESH_COOLDOWN_MS, error });
    },
  ).finally(() => {
    s.busy = false;
    if (inflight.get(s.key) === s) inflight.delete(s.key);
    if ((session === s || renew) && mounted) ctx.rerender?.();
  });
}

/** Refresh and Retry: one forced load for the CURRENT plan key, then the shared 30 s pause. */
function refresh(ctx) {
  const p = plan(ctx);
  if (p.mode !== 'production' || !p.key) return;
  const s = claim(p);
  if (s.busy || inflight.has(p.key) || cooldownLeft(p.key, p.view.now) > 0) return;
  cooldowns.set(p.key, { until: p.view.now + REFRESH_COOLDOWN_MS, error: null });
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

/** "Departures from <airport> · <pack> flights (<basis note>)": airport, carriers, where the airport comes from. */
function sourceLine({ airport, basis, carriers, pack }) {
  const note = BASIS_NOTE[basis] ?? null;
  return `Departures from ${airport} · ${carriers ? `${pack.name} flights` : 'All carriers'}${note ? ` (${note})` : ''}`;
}

function frame(view, body, { window = null, head = null } = {}) {
  const tz = view.profile.homeTz;
  const parts = [];
  if (window?.label) parts.push(window.label);
  if (window) parts.push(windowLine(window, tz));
  if (head?.airport) parts.push(sourceLine(head));
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
    now: view.now, window: p.window, carriers: p.carriers,
    // Every row of a filtered list is the user's airline: no emphasis mark. Only the all-carriers list marks it.
    emphasisCarriers: p.carriers ? null : pack.flightDesignators ?? null, homeTz: profile.homeTz,
  });
  const empty = rv.total === 0;
  return html`
    <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
    ${sourceBar(s, view, { review: Boolean(s.review) })}
    ${empty ? message({ headline: TEXT.empty(p.airport, p.carriers ? pack.name : null) }) : listView(rv, p, pack.name)}`;
}

const headOf = ({ airport, basis, carriers, pack }) => ({ airport, basis, carriers, pack });

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
      return frame(view, message({ headline: TEXT.ended, action: todayLink }), { window: p.sel.window, head: headOf(p) });
    case 'too-far':
      return frame(view, message({ headline: TEXT.tooFar(formatDate(p.sel.availableFrom, view.profile.homeTz)), action: todayLink }), { window: p.sel.window, head: headOf(p) });
    case 'too-long':
      return frame(view, message({ headline: TEXT.tooLong, action: todayLink }), { window: p.sel.window, head: headOf(p) });
    case 'access': {
      const noEndpoint = p.access === 'no-endpoint';
      return frame(view, message({
        headline: noEndpoint ? 'No roster source connected' : 'Access token required',
        text: noEndpoint ? 'Scheduled departures need your roster source. Connect it in Settings.' : 'Scheduled departures are only loaded with the access token. Add it under Roster contract v2 in Settings.',
        action: settingsLink(noEndpoint ? 'Connect roster source' : 'Open Settings'),
      }), { window: p.window, head: headOf(p) });
    }
    default: {
      const s = p.mode === 'review' ? reviewSession(p) : session?.key === p.key ? session : null;
      const head = { window: p.window, head: headOf(p) };
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
    const p = plan(ctx);
    // main.js renders, then mounts: a key that is not on screen yet is claimed here so the first paint
    // already shows its remembered error (Retry countdown) instead of a loading state nothing will end.
    if (p.mode === 'production' && p.key) claim(p);
    const out = bodyFor(p);
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

/** Test hook: forget the in-memory session, cooldowns, last results and running loads. */
export function resetRadarUi() {
  session = null;
  mounted = false;
  lastHtml = '';
  openPending = false;
  cooldowns.clear();
  inflight.clear();
  loaded.clear();
  accessId = undefined;
}
