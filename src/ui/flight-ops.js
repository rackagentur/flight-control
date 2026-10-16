// Live flight information for Flight Detail: departure and arrival gates, terminals, desks,
// belts and revised times from the flight-data provider (backend `flight` action).
// Provider facts only, shown beside the roster and never instead of it: the roster's
// scheduled times stay the reference row, a provider time is labelled "Revised", and a
// missing gate is never filled in. Boarding/gate-closed statuses are not shown as facts (D-004).
// Input is the adapted view model of sources/flight-info-v2.js plus a load state; pure render.

import { html } from '../lib/html.js';
import { clock, city } from './duty.js';
import { statusChip } from './flight-parts.js';
import { attributionText } from './attribution.js';
import { flightQueryFor, FLIGHT_TTL_MS } from '../sources/flight-info-service.js';
import { staleAt } from '../sources/flight-info-v2.js';

export const OPS_TEXT = Object.freeze({
  eyebrow: 'Gates & terminals',
  loading: 'Loading live flight information…',
  unavailable: 'Live information unavailable.',
  limited: 'Live information unavailable. The provider limit is reached; try again later.',
  notFound: 'No live operational data for this flight.',
  pending: 'Not assigned yet',
  noGate: 'Gate unavailable',
  stale: 'Information may have changed.',
  lastUpdated: 'Last updated',
  bothMissing: 'Gate and terminal unavailable',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  refreshWait: 'Refresh is available again in a moment',
  otherAirport: (kind) => `The provider does not list the rostered ${kind} airport; no ${kind} gate is shown.`,
  source: 'Live flight information',
});

/** Provider statuses shown as a chip. Scheduled/boarding/departed/arrived are not (roster time and D-004 cover them). */
const STATUS_CHIP = Object.freeze({
  cancelled: { tone: 'critical', label: 'Cancelled (provider)' },
  diverted: { tone: 'caution', label: 'Diverted (provider)' },
  delayed: { tone: 'caution', label: 'Delayed (provider)' },
});

/** Stand-in for a leg whose provider data is not for the roster airport: nothing from it is shown. */
const NO_LEG = Object.freeze({ airport: null, revised: null, terminal: null, gate: null, desk: null, belt: null, gateState: 'unavailable' });

const minutesApart = (a, b) => Math.abs(a - b) >= 60000;

/** Roster time is the reference; the provider's revised time appears only when it differs. */
function timeRows(rosterMs, tz, leg) {
  const rows = [html`<div class="fo-time"><dt class="t-caption t-secondary">Roster</dt><dd class="t-tabular">${clock(rosterMs, tz)}</dd></div>`];
  if (Number.isFinite(leg.revised) && minutesApart(leg.revised, rosterMs)) {
    rows.push(html`<div class="fo-time is-revised"><dt class="t-caption t-secondary">Revised</dt><dd class="t-tabular">${clock(leg.revised, tz)}</dd></div>`);
  }
  return rows;
}

function gateBlock(leg) {
  if (leg.gateState === 'available') {
    return html`<p class="fo-gate"><span class="fo-gate-label t-caption t-secondary">Gate</span><span class="fo-gate-value t-tabular">${leg.gate}</span></p>`;
  }
  // Without a gate the label would repeat itself ("Gate · Gate unavailable"): the text alone carries it.
  const text = leg.gateState === 'pending' ? `Gate ${OPS_TEXT.pending.toLowerCase()}` : OPS_TEXT.noGate;
  return html`<p class="fo-gate is-empty"><span class="fo-gate-none t-callout t-secondary">${text}</span></p>`;
}

function legView(kind, iata, rosterMs, tz, leg) {
  const extra = kind === 'departure' ? (leg.desk ? ['Check-in', leg.desk] : null) : (leg.belt ? ['Baggage belt', leg.belt] : null);
  const name = city(iata);
  return html`
    <div class="fo-leg" data-leg="${kind}">
      <p class="t-eyebrow fo-leg-head">${kind === 'departure' ? 'Departure' : 'Arrival'} · <span class="t-code">${iata}</span></p>
      ${name !== iata ? html`<p class="fo-city t-callout">${name}</p>` : ''}
      ${leg.gateState === 'unavailable' && !leg.terminal
        ? html`<p class="fo-gate is-empty"><span class="fo-gate-none t-callout t-secondary">${OPS_TEXT.bothMissing}</span></p>`
        : html`${gateBlock(leg)}<p class="fo-terminal t-callout">${leg.terminal ? `Terminal ${leg.terminal}` : html`<span class="t-secondary">Terminal unavailable</span>`}</p>`}
      ${extra ? html`<p class="fo-extra t-caption"><span class="t-secondary">${extra[0]}</span> <span class="t-tabular">${extra[1]}</span></p>` : ''}
      <dl class="fo-times">${timeRows(rosterMs, tz, leg)}</dl>
    </div>`;
}

/** Discreet manual refresh; disabled while a load runs or during the refresh pause (cache and rate limits stay in force). */
function refreshButton(state) {
  if (!state.refresh) return '';
  const { busy, cooling } = state.refresh;
  const label = busy ? OPS_TEXT.refreshing : OPS_TEXT.refresh;
  return html`<button type="button" class="fo-refresh t-caption" data-fo-refresh ${busy || cooling ? html`disabled aria-disabled="true"` : ''} ${cooling && !busy ? html`title="${OPS_TEXT.refreshWait}"` : ''}>${label}</button>`;
}

function footer(info, profile, state) {
  const at = Number.isFinite(info.lastUpdated) ? info.lastUpdated : info.fetchedAt;
  const time = Number.isFinite(at) ? clock(at, profile.homeTz) : null;
  const text = info.stale
    ? html`<span class="fo-stale">${time ? `${OPS_TEXT.lastUpdated} ${time} · ` : ''}${OPS_TEXT.stale}</span>`
    : [OPS_TEXT.source, time ? `${Number.isFinite(info.lastUpdated) ? 'Updated' : 'Checked'} ${time}` : null].filter(Boolean).join(' · ');
  const attr = attributionText(info.attribution);
  return html`<div class="fo-foot"><p class="t-caption t-secondary">${text}${attr ? html` · ${attr}` : ''}</p>${refreshButton(state)}</div>`;
}

/**
 * @param {{status:'loading'|'ready'|'error', info?:object, error?:string}|null} state  null = not applicable (no section)
 * @param {{origin:string, destination:string, dep:number, arr:number, originTz:string|null, destTz:string|null}} sector  roster sector (authoritative)
 * @param {{profile:object}} view
 */
export function flightOpsView(state, sector, { profile }) {
  if (!state) return '';
  const head = html`<p class="t-eyebrow" id="fl-ops">${OPS_TEXT.eyebrow}</p>`;
  const quiet = (text, extra = '') => html`<section class="fl-section fl-ops" aria-labelledby="fl-ops">${head}<p class="t-callout t-secondary fo-message" role="status">${text}</p>${extra}</section>`;
  if (state.status === 'loading') return quiet(OPS_TEXT.loading);
  if (state.status === 'error') return quiet(state.error === 'provider-rate-limited' ? OPS_TEXT.limited : OPS_TEXT.unavailable, state.refresh ? html`<div class="fo-foot">${refreshButton(state)}</div>` : '');
  const info = state.info;
  if (!info || !info.found) return html`<section class="fl-section fl-ops is-quiet" aria-labelledby="fl-ops">${head}<p class="t-caption t-secondary fo-message">${OPS_TEXT.notFound}</p>${info ? footer(info, profile, state) : ''}</section>`;
  const chip = STATUS_CHIP[info.status];
  // A leg's provider data belongs to the roster sector only at the roster airport (a diversion or a
  // mismatched leg must never put another airport's gate under the rostered one).
  const usable = (leg, iata) => (leg.airport === iata ? leg : null);
  const dep = usable(info.departure, sector.origin);
  // Information about another departure is about another flight: then nothing from it is shown at all.
  const arr = dep ? usable(info.arrival, sector.destination) : null;
  const mismatch = [dep ? null : OPS_TEXT.otherAirport('departure'), arr ? null : OPS_TEXT.otherAirport('arrival')].filter(Boolean);
  return html`
    <section class="fl-section fl-ops" aria-labelledby="fl-ops">
      ${head}
      ${chip ? html`<p class="fo-status">${statusChip(chip)}</p>` : ''}
      <div class="fo-legs">
        ${legView('departure', sector.origin, sector.dep, sector.originTz, dep ?? NO_LEG)}
        ${legView('arrival', sector.destination, sector.arr, sector.destTz, arr ?? NO_LEG)}
      </div>
      ${mismatch.map((text) => html`<p class="t-caption t-secondary fo-message">${text}</p>`)}
      ${footer(info, profile, state)}
    </section>`;
}

// --- Load state (Flight Detail) ------------------------------------------------------------
// One entry per flight query; nothing is persisted here. Loads start only when a flight's detail is
// rendered, for roster flights from 24 h ago to 6 days ahead, never in review mode, never for history.
// Manual refresh: one forced load per flight, then a 30 s pause; the backend's own cache (5 min near
// departure) and 429 handling still apply, so a refresh never bypasses provider rate limits.
// No polling: the minute tick only redraws. A new load starts by itself only on a VISIT (a router
// navigation, counted by main.js as ctx.visit(); quiet redraws never change it) or when another flight
// is selected, and only if the information is older than the client cache lifetime or the last
// attempt failed more than the pause ago.

export const OPS_REFRESH_COOLDOWN_MS = 30000;
export const OPS_PAST_MS = 24 * 3600000;
export const OPS_AHEAD_MS = 6 * 24 * 3600000;

const sessions = new Map();
let seenAccess;
let mounted = false;
let lastKey = null;

/** True when live information applies to this Flights entry. */
export function opsApplies(entry, view, ctx) {
  if (!entry || view.review || ctx.flightInfoAccess?.() !== 'ready' || typeof ctx.loadFlightInfo !== 'function') return false;
  const s = entry.sector;
  if (!s || s.provenance === 'history' || !s.originTz || !Number.isFinite(s.dep)) return false;
  return s.dep >= view.now - OPS_PAST_MS && s.dep <= view.now + OPS_AHEAD_MS && flightQueryFor(s) !== null;
}

function keyOf(sector) {
  const q = flightQueryFor(sector);
  return q ? `${q.flightNumber}|${q.date}|${q.origin}` : null;
}

function syncAccess(ctx) {
  const id = ctx.accessId?.() ?? '';
  if (id !== seenAccess) { sessions.clear(); seenAccess = id; }
}

function start(ctx, sector, s, { force }) {
  s.busy = true;
  const startedUnder = ctx.accessId?.() ?? '';
  let pending;
  try { pending = Promise.resolve(ctx.loadFlightInfo(sector, { force })); } catch (error) { pending = Promise.reject(error); }
  pending.then(
    (info) => { if ((ctx.accessId?.() ?? '') !== startedUnder) return; s.info = info; s.status = 'ready'; s.error = null; s.loadedAt = Date.now(); },
    (error) => {
      if ((ctx.accessId?.() ?? '') !== startedUnder) return;
      s.failedAt = Date.now();
      // With information on screen it stays (its age shows in the footer); otherwise an error state.
      if (!s.info) { s.status = 'error'; s.error = error?.code ?? 'provider-unavailable'; }
    },
  ).finally(() => { s.busy = false; if (mounted) ctx.rerender?.(); });
}

/** Render-time state for the selected entry; starts the first load. null = no section. */
export function flightOpsState(ctx, entry, view) {
  if (!opsApplies(entry, view, ctx)) return null;
  syncAccess(ctx);
  const key = keyOf(entry.sector);
  let s = sessions.get(key);
  const visit = ctx.visit?.() ?? 0;
  const opened = key !== lastKey || (s && s.visit !== visit);
  lastKey = key;
  const now = Date.now();
  if (!s) {
    s = { status: 'loading', info: null, error: null, busy: false, forcedAt: 0, failedAt: 0, loadedAt: 0, visit };
    sessions.set(key, s);
    start(ctx, entry.sector, s, { force: false });
  } else if (opened && !s.busy) {
    s.visit = visit;
    // Only on opening (never on the minute redraw): retry a failure after the pause, renew old information.
    if (s.status === 'error' && now - s.failedAt >= OPS_REFRESH_COOLDOWN_MS) { s.status = 'loading'; start(ctx, entry.sector, s, { force: false }); }
    else if (s.status === 'ready' && now - s.loadedAt >= FLIGHT_TTL_MS) start(ctx, entry.sector, s, { force: false });
  }
  const cooling = now - Math.max(s.forcedAt, s.failedAt) < OPS_REFRESH_COOLDOWN_MS;
  const info = s.info ? { ...s.info, stale: staleAt(s.info, now) } : null;   // information on screen ages
  return { status: s.status, info, error: s.error, refresh: { busy: s.busy, cooling } };
}

/** Manual refresh: ignored while loading or during the pause. Returns true when a load started. */
export function refreshFlightOps(ctx, entry, view) {
  if (!opsApplies(entry, view, ctx)) return false;
  syncAccess(ctx);
  const s = sessions.get(keyOf(entry.sector));
  if (!s || s.busy || Date.now() - Math.max(s.forcedAt, s.failedAt) < OPS_REFRESH_COOLDOWN_MS) return false;
  s.forcedAt = Date.now();
  if (s.status === 'error') { s.status = 'loading'; s.error = null; }
  start(ctx, entry.sector, s, { force: true });
  ctx.rerender?.();
  return true;
}

export function setFlightOpsMounted(value) { mounted = value; }

/** Test/review hook: forget all load state. */
export function resetFlightOps() { sessions.clear(); seenAccess = undefined; mounted = false; lastKey = null; }
