// Radar (read-only, slice 1): "Flights in standby window".
// Scheduled departures from the user's base during a rostered standby window, as factual
// provider data. Order of every row, for fast scanning: departure time → flight number →
// destination → revised time / delay → factual state (Departed / Cancelled only). The aircraft
// is tertiary. Nothing here predicts anything about the user.
//
// Data: the screen never reads storage or the token. ctx.loadDepartures() (main.js) does the
// request; ctx.departuresAccess() says whether one can be made. Requests happen only when the
// screen is opened (mount; the 5-minute device cache makes a quick reopen free) and on Refresh /
// Retry (30 s apart). One more case: when the screen was opened before the roster had loaded, the
// first update() with a usable roster issues that one initial load. Re-renders reuse the in-memory
// result and never fetch.

import { html, render as domRender } from '../../lib/html.js';
import { formatDate } from '../../lib/time.js';
import { pageHeader } from '../components.js';
import { icon } from '../icons.js';
import { hrefFor } from '../../router.js';
import { clock } from '../duty.js';
import { airlineOf } from '../../airlines/index.js';
import { departuresContext } from '../../model/scheduled-flights.js';
import { selectStandbyWindow, checkWindow, buildRadarView } from '../../model/radar.js';
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

// In-memory session for the window on screen (never persisted).
//   { key, window, status:'loading'|'ready'|'error', result, error, refreshError, busy, blockedUntil, earlierOpen }
let session = null;
let mounted = false;
let lastHtml = '';
// True from an opening that found no roster yet until the first update() that can choose a window.
let initialPending = false;

const newSession = (key, window, extra = {}) => ({
  key, window, status: 'loading', result: null, error: null, refreshError: null, busy: false, blockedUntil: 0, earlierOpen: false, ...extra,
});

/**
 * What the screen is about right now. `sticky` (used by update()) keeps the window the screen
 * already shows instead of choosing again, so a roster refresh can never change the request.
 */
function plan(ctx, { sticky = false } = {}) {
  const view = ctx.view();
  const { profile, now, snapshot, review } = view;
  if (!snapshot) return { kind: 'no-roster', view };
  const sel = sticky && session?.window ? checkWindow(session.window, now) : selectStandbyWindow(snapshot, now, ctx.param?.() ?? null);
  if (sel.reason) return { kind: sel.reason, view, sel };
  const { airport } = departuresContext(profile);
  const { start: from, end: to } = sel.window;
  const base = { view, sel, window: sel.window, airport, from, to };
  if (review) return { ...base, kind: 'review', key: `review|${airport}|${from}|${to}` };
  const access = ctx.departuresAccess?.() ?? 'ready';
  if (access !== 'ready') return { ...base, kind: 'access', access };
  return { ...base, kind: 'load', key: `${airport}|${from}|${to}`, query: { airport, from, to, carriers: null } };
}

/** Review mode: the fictional list, built once per window and kept (no request of any kind). */
function reviewSession(p) {
  if (session?.key !== p.key) {
    const { profile, now } = p.view;
    const ownCarrier = airlineOf(profile).flightDesignators?.[0] ?? null;
    session = newSession(p.key, p.window, {
      status: 'ready', review: true,
      result: sampleDepartures({ airport: p.airport, from: p.from, to: p.to, now, ownCarrier, airportTz: profile.homeTz }),
    });
  }
  return session;
}

// --- Loading ---------------------------------------------------------------------------

function start(ctx, p, { force }) {
  const s = session;
  if (!s || s.busy) return;
  s.busy = true;
  s.refreshError = null;
  if (!s.result) { s.status = 'loading'; s.error = null; }
  let pending;
  try { pending = Promise.resolve(ctx.loadDepartures(p.query, { force })); } catch (error) { pending = Promise.reject(error); }
  pending.then(
    (result) => { if (session === s) { s.result = result; s.status = 'ready'; s.error = null; } },
    (error) => {
      if (session !== s) return;
      // With data on screen the list stays; otherwise this is an error state with a Retry.
      if (s.result) s.refreshError = error; else { s.status = 'error'; s.error = error; }
    },
  ).finally(() => {
    s.busy = false;
    if (session === s && mounted) ctx.rerender?.();
  });
}

function refresh(ctx) {
  const p = plan(ctx, { sticky: true });
  if (p.kind !== 'load' || !session || session.key !== p.key || session.busy) return;
  // Refresh and Retry share one 30 s pause (errors are not cached, so rapid retries would reach the provider).
  if (p.view.now < session.blockedUntil) return;
  session.blockedUntil = p.view.now + REFRESH_COOLDOWN_MS;
  start(ctx, p, { force: true });
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
      ${r.aircraft ? html`<span class="rd-ac" title="${r.aircraft}" aria-label="Aircraft ${r.aircraft}">${r.aircraft}</span>` : ''}
    </li>`;
}

function skeleton() {
  return html`
    <ol class="rd-list rd-skeleton" aria-hidden="true">
      ${[0, 1, 2, 3, 4].map(() => html`<li class="rd-row rd-skel"><span class="rd-skel-bar rd-skel-time"></span><span class="rd-skel-bar rd-skel-flight"></span><span class="rd-skel-bar rd-skel-dest"></span></li>`)}
    </ol>`;
}

function sourceBar(s, view, { review }) {
  const tz = view.profile.homeTz;
  const fetched = s.result ? clock(s.result.fetchedAt, tz) : null;
  const blocked = s.busy || view.now < s.blockedUntil;
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
  switch (p.kind) {
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
      const s = p.kind === 'review' ? reviewSession(p) : session?.key === p.key ? session : null;
      const head = { window: p.window, airport: p.airport };
      if (!s || s.status === 'loading') {
        return frame(view, html`
          <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
          <section class="rd-loading" aria-busy="true"><p class="t-callout t-secondary" role="status">${TEXT.loading}</p>${skeleton()}</section>`, head);
      }
      if (s.status === 'error') {
        return frame(view, html`
          <p class="rd-boundary t-callout t-secondary">${TEXT.boundary}</p>
          ${message({ headline: errorText(s.error), action: html`<button type="button" class="btn btn-quiet" data-rd-retry ${s.busy || view.now < s.blockedUntil ? 'disabled' : ''}>Retry</button>` })}`, head);
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
   * Opening the screen starts the one (non-forced) request this visit needs: the device cache
   * answers within 5 minutes, otherwise the backend is asked. The previous in-memory list stays on
   * screen meanwhile. `quiet` marks a redraw of the screen already open (main.js show): it never
   * requests, except for a window the screen has no session for yet.
   */
  mount(root, ctx, { quiet = false } = {}) {
    const p = plan(ctx);
    mounted = true;
    if (!quiet) initialPending = p.kind === 'no-roster';   // roster still loading: update() issues the load
    if (p.kind === 'load') {
      initialPending = false;
      if (session?.key !== p.key) { session = newSession(p.key, p.window); start(ctx, p, { force: false }); }
      else if (!quiet) start(ctx, p, { force: false });
    } else if (p.kind !== 'review') {
      session = null;   // no window, ended, no access: nothing from an earlier visit stays
    }

    const onClick = (event) => {
      const button = event.target.closest('[data-rd-refresh], [data-rd-retry]');
      if (button && !button.disabled) refresh(ctx);
    };
    const onToggle = (event) => {
      if (session && event.target?.matches?.('[data-rd-earlier]')) session.earlierOpen = event.target.open;
    };
    root.addEventListener('click', onClick);
    root.addEventListener('toggle', onToggle, true);

    // Re-enable Refresh when its 30 s pause is over. UI only: this timer never fetches.
    let timer = null;
    const remaining = session ? session.blockedUntil - ctx.view().now : 0;
    if (remaining > 0) {
      timer = setTimeout(() => {
        if (session && !session.busy) root.querySelector?.('[data-rd-refresh], [data-rd-retry]')?.removeAttribute('disabled');
      }, remaining + 50);
      timer.unref?.();
    }
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
      root.removeEventListener('click', onClick);
      root.removeEventListener('toggle', onToggle, true);
    };
  },

  /**
   * Called on every controller change: redraws from memory (rows move past "now"). It never
   * fetches, with one exception: an opening that found no roster yet gets its single initial load
   * from the first update() whose roster has a usable window.
   */
  update(root, ctx) {
    let p;
    if (initialPending) {
      p = plan(ctx);
      if (p.kind !== 'no-roster') {
        initialPending = false;
        if (p.kind === 'load') { session = newSession(p.key, p.window); start(ctx, p, { force: false }); }
      }
    } else {
      p = plan(ctx, { sticky: true });
    }
    if (p.kind !== 'load' && p.kind !== 'review') session = null;
    const previous = lastHtml;
    const next = bodyFor(p);
    lastHtml = next.toString();
    if (lastHtml !== previous) domRender(root, next);
  },
};

/** Test hook: forget the in-memory session. */
export function resetRadarUi() {
  session = null;
  mounted = false;
  lastHtml = '';
  initialPending = false;
}
