// Crew Intelligence in Flight Details (Stage B2): the crew of the selected flight with recorded shared duties.
// Inserted between the live gates/terminals section and the rotation, and ONLY when everything holds: crew turned
// on, the backend offers it, the airline pack has crew wording, and the sector is eligible (current v2 roster,
// production, date window). Otherwise nothing is rendered at all (the screen stays byte-identical).
//
// Data comes only from ctx.crew (the app-wide runtime): answers stay in the service's memory; this module keeps
// the latest answer per sector in memory for rendering, TAGGED with the authorization it was fetched under
// (ctx.crew.authorization(): consent epoch, access id, active grant, no pending deletion). An answer is shown only
// while that exact authorization is still current (re-read synchronously at render) and within the service's
// memory lifetime; every invalidation event clears it, and late answers of an older authorization are dropped.
// Offline/network states are retryable: the online event clears them and the visible detail re-renders once. Never a
// number for a stale state, never a check date, counts only from complete/incomplete answers (incomplete
// labelled). Names appear only in the member rows: never in titles, URLs, live regions or storage.

import { startCrewDiagnostics, clearCrewDiagnostics, crewDiagnosticSnapshot, crewDiagnosticsEnabled, crewDiagnosticGeneration } from '../crew-diagnostics.js';
import { html } from '../lib/html.js';
import { airlineOf } from '../airlines/index.js';
import { crewEligibility } from '../crew-runtime.js';
import { CREW_TTL_MS } from '../sources/crew-service.js';

const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** 'YYYY-MM-DD' (a roster date, not an instant) -> '14 Aug 2026'. */
const dayLabel = (key) => (typeof key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(key) ? DAY_FORMAT.format(Date.parse(`${key}T12:00:00Z`)) : '');

const LIMIT = new Set(['rate-limited', 'cooldown', 'local-limit']);
const STORAGE = new Set(['storage', 'storage-unreadable', 'lock-unavailable', 'credential-unsupported']);
const NOT_FOUND = new Set(['sector-not-found', 'sector-not-owned', 'bad-range', 'bad-request']);
const REVOKED = new Set(['crew-revoked', 'access-ended']);
const OFFLINE = new Set(['network', 'timeout', 'offline']);
const PROGRESS_TICK_MS = 1500;

/** Error code -> display kind (pure). */
export function crewErrorKind(code) {
  if (code === 'crew-not-enrolled') return 'not-enrolled';
  if (code === 'revoke-pending') return 'pending';
  if (code === 'revoke-pending-elsewhere') return 'pending-elsewhere';
  if (REVOKED.has(code)) return 'revoked';
  if (OFFLINE.has(code)) return 'offline';
  if (LIMIT.has(code)) return 'limit';
  if (code === 'suspended') return 'suspended';
  if (STORAGE.has(code)) return 'storage';
  if (NOT_FOUND.has(code)) return 'not-found';
  return 'error';
}

// --- Pure rendering ----------------------------------------------------------------------------------------

function memberFact(m, state, copy, route) {
  if (m.match === 'stale' || state === 'stale') return { text: copy.stale };
  if (m.match === 'suppressed' || m.match === 'unavailable') return { text: copy.unavailable };
  if (m.match === 'uncertain') return { text: m.recordedMatch === false ? copy.uncertainNoMatch : copy.uncertain };
  if (m.match === 'none') return { text: copy.none };
  if (m.match === 'recorded' && Number.isInteger(m.count) && m.count >= 1) {
    const last = m.last ? copy.last(m.last.flightNumber, route(m.last.route) ?? m.last.route, dayLabel(m.last.date)) : null;
    return { count: String(m.count), text: copy.countText(m.count), last, shared: true };
  }
  return { text: copy.unavailable };
}

function memberRow(m, state, copy, route) {
  const fact = memberFact(m, state, copy, route);
  return html`
    <li class="crew-member ${fact.shared ? 'is-shared' : ''}">
      <span class="crew-avatar" aria-hidden="true">${m.initials}</span>
      <div class="crew-body">
        <p class="crew-line"><span class="crew-name">${m.name}</span>${m.rank?.label ? html`<span class="crew-rank">${m.rank.label}</span>` : ''}</p>
        <p class="crew-fact">${fact.count ? html`<strong class="crew-count">${fact.count}</strong> ` : ''}${fact.text}</p>
        ${fact.last ? html`<p class="crew-last">${fact.last}</p>` : ''}
      </div>
    </li>`;
}

function statusBlock(title, text, action = '') {
  return html`<div class="crew-status" role="status" aria-live="polite">${title ? html`<p class="crew-status-title">${title}</p>` : ''}${text ? html`<p class="crew-status-text">${text}</p>` : ''}</div>${action}`;
}

/**
 * The crew section for a render state (pure). Returns '' for no state.
 * @param {object|null} state  from crewSectionState(), or a synthetic state in tests/harness
 * @param {{copy: object, present: Function, route: Function}} pack  the airline pack's `crew`
 */
export function crewSectionView(state, pack) {
  if (!state || !pack) return '';
  const { copy } = pack;
  const head = html`<p class="t-eyebrow" id="fl-crew">${copy.eyebrow}</p>`;
  const wrap = (body, extraClass = '') => html`<div class="crew-slot" data-crew-slot><section class="fl-section crew ${extraClass}" aria-labelledby="fl-crew">${head}${body}</section></div>`;
  const retry = html`<p class="crew-actions"><button type="button" class="btn btn-quiet" data-crew-retry>${copy.retry}</button></p>`;
  const settingsLink = html`<p class="crew-actions"><a class="btn btn-quiet" href="#/settings">${copy.openSettings}</a></p>`;
  switch (state.kind) {
    case 'loading': return wrap(statusBlock(null, copy.loading), 'is-quiet');
    case 'not-enrolled': return wrap(html`${statusBlock(null, copy.notEnrolled)}${settingsLink}`, 'is-quiet');
    case 'not-listed': return wrap(statusBlock(copy.notListed, copy.notListedText), 'is-quiet');
    case 'pending': return wrap(statusBlock(copy.pendingTitle, copy.pendingText), 'is-quiet');
    case 'pending-elsewhere': return wrap(statusBlock(copy.pendingTitle, copy.pendingElsewhereText), 'is-quiet');
    case 'revoked': return wrap(html`${statusBlock(copy.revokedTitle, copy.revokedText)}${settingsLink}`, 'is-quiet');
    case 'offline': return wrap(statusBlock(copy.errorTitle, copy.offlineText), 'is-quiet');
    case 'limit': return wrap(statusBlock(copy.errorTitle, copy.limitText), 'is-quiet');
    case 'suspended': return wrap(statusBlock(copy.errorTitle, copy.suspendedText), 'is-quiet');
    case 'storage': return wrap(statusBlock(copy.errorTitle, copy.storageText), 'is-quiet');
    case 'not-found': return wrap(statusBlock(null, copy.notFoundText), 'is-quiet');
    case 'error': return wrap(html`${statusBlock(copy.errorTitle, copy.errorText)}${retry}`, 'is-quiet');
    case 'crew': break;
    default: return '';
  }
  const value = state.value;
  const history = value.history;
  const presented = pack.present(value.members);
  const members = presented.groups.flatMap((g) => g.members);
  const hState = history?.state;
  let lead = '';
  if (state.indexing) {
    lead = statusBlock(copy.indexingTitle, state.indexing.total ? copy.indexingMonths(state.indexing.indexed, state.indexing.total) : null);
  } else if (hState === 'stale') {
    lead = statusBlock(copy.staleTitle, copy.staleText);
  } else if (hState === 'incomplete') {
    lead = statusBlock(copy.incompleteTitle, copy.incompleteText);
  } else if (hState === 'complete') {
    const shared = members.filter((m) => (m.match === 'recorded' && m.count >= 1) || (m.match === 'uncertain' && m.recordedMatch !== false)).length;
    lead = html`<p class="crew-summary"><span class="crew-summary-n">${copy.summaryCount(shared, members.length)}</span> ${copy.summaryText}</p>`;
  }
  const single = presented.groups.length === 1 && presented.groups[0].id === 'crew';
  return wrap(html`
    ${lead}
    ${presented.groups.map((g) => html`
      <div class="crew-group">
        ${single ? '' : html`<p class="crew-group-label">${copy.groupLabel[g.id]}</p>`}
        <ul class="crew-list" role="list">${g.members.map((m) => memberRow(m, hState, copy, pack.route))}</ul>
      </div>`)}
    ${presented.unreadable ? html`<p class="crew-foot">${copy.unreadable(presented.unreadable)}</p>` : ''}
    ${state.indexing ? html`<p class="crew-foot">${copy.indexingText}</p>` : ''}
    <p class="crew-foot">${copy.foot}</p>`);
}

// --- Load state (memory only) ------------------------------------------------------------------------------

const ui = { accessId: undefined, capability: null, entries: new Map(), mounted: false, root: null, ctx: null, shown: null, ticker: null, watching: null };
const subscribedTo = new WeakSet();

function syncAccess(ctx) {
  const id = ctx.accessId?.() ?? '';
  if (id !== ui.accessId) { ui.accessId = id; ui.capability = null; ui.entries.clear(); }
}

function refresh() {
  if (!ui.mounted || !ui.ctx) return;
  ui.ctx.rerender?.();
}

/** Invalidations clear every answer; the online event clears only retryable (offline/network) states. */
function ensureSubscribed(crew) {
  if (subscribedTo.has(crew) || typeof crew.subscribe !== 'function') return;
  subscribedTo.add(crew);
  crew.subscribe((event) => {
    if (event?.type === 'online') {
      let cleared = false;
      for (const [k, s] of ui.entries) if (s.status === 'error' && OFFLINE.has(s.error)) { ui.entries.delete(k); cleared = true; }
      if (cleared) refresh();
      return;
    }
    ui.entries.clear();
    ui.watching = null;
    refresh();
  });
}

/** Re-renders only the crew slot (indexing progress), without a full page redraw. */
function refreshSlot() {
  if (!ui.mounted || !ui.root || !ui.ctx || !ui.shown) return;
  const slot = ui.root.querySelector('[data-crew-slot]');
  const pack = airlineOf(ui.ctx.view().profile).crew;
  const state = currentState(ui.ctx, ui.shown);
  if (!slot || !state) return;
  const markup = String(crewSectionView(state, pack));
  if (slot.outerHTML !== markup) slot.outerHTML = markup;
}

/** One lookup for an entry, tagged with the authorization and a sequence number; stale results are dropped. */
function startLoad(ctx, query, s, { force = false } = {}) {
  const auth = ctx.crew.authorization().key;
  s.seq += 1;
  const seq = s.seq;
  s.status = 'loading';
  s.auth = auth;
  const current = () => ui.entries.get(s.key) === s && s.seq === seq && ctx.crew.authorization().key === auth;
  ctx.crew.service.loadCrew(query, { force }).then(
    (value) => { if (!current()) return; s.status = 'ready'; s.value = value; s.error = null; s.storedAt = Date.now(); watchIndexing(ctx, query); },
    (error) => {
      if (!current()) return;
      const code = error?.code ?? 'error';
      if (code === 'access-changed') { ui.entries.delete(s.key); return; }
      s.status = 'error'; s.error = code; s.value = null;
    },
  ).finally(refresh);
}

/** Follows a detail indexing run the service started for this sector; reloads the crew when it made progress. */
function watchIndexing(ctx, query) {
  const svc = ctx.crew.service;
  if (!svc.indexingStatus().running || ui.watching) return;
  const run = svc.requestIndexing('detail', { sectorKey: query.sectorId });   // joins the running run (same identity)
  ui.watching = run;
  clearInterval(ui.ticker);
  ui.ticker = setInterval(refreshSlot, PROGRESS_TICK_MS);
  Promise.resolve(run).then((result) => {
    if (result?.processed > 0 && ui.watching === run) {
      const s = ui.entries.get(`${query.sectorId}|${query.date}`);
      if (s && s.status === 'ready') startLoad(ctx, query, s, { force: true });
    }
  }).finally(() => { if (ui.watching === run) ui.watching = null; clearInterval(ui.ticker); ui.ticker = null; refresh(); });
}

/** The entry for `key` if it may still be used under the current authorization (else it is forgotten). */
function usableEntry(ctx, key) {
  const s = ui.entries.get(key);
  if (!s) return null;
  const expired = s.status === 'ready' && !(Date.now() - s.storedAt >= 0 && Date.now() - s.storedAt < CREW_TTL_MS);
  if (s.auth !== ctx.crew.authorization().key || expired) { ui.entries.delete(key); return null; }
  return s;
}

function currentState(ctx, shown) {
  const s = usableEntry(ctx, shown.key);
  if (!s) return null;
  if (s.status === 'loading' && !s.value) return { kind: 'loading' };
  if (s.status === 'error') return { kind: crewErrorKind(s.error) };
  if (!s.value) return { kind: 'loading' };
  // Names only under the exact, still-valid authorization they were fetched with.
  const auth = ctx.crew.authorization();
  if (!auth.authorized || auth.key !== s.auth) return { kind: 'loading' };
  if (!s.value.crewListed) return { kind: 'not-listed' };
  const status = ctx.crew.service.indexingStatus();
  const progress = status.running ? status.lastProgress : null;
  return { kind: 'crew', value: s.value, indexing: status.running ? { indexed: progress?.indexed ?? 0, total: progress?.total ?? 0 } : null };
}

/**
 * Render-time crew state for the selected Flights entry; starts loads. null = no section (nothing rendered).
 * @returns {object|null}
 */
export function crewSectionState(ctx, entry, view) {
  const crew = ctx?.crew;
  const pack = airlineOf(view?.profile).crew;
  if (!crew || !pack || !entry || !crew.enabled()) return null;
  const eligibility = crewEligibility({ view, sector: entry.sector, now: view.now, homeTz: view.profile?.homeTz });
  if (!eligibility.eligible) return null;
  ensureSubscribed(crew);
  syncAccess(ctx);
  if (!ui.capability) {
    ui.capability = { status: 'loading', supported: false };
    const cap = ui.capability;
    crew.capability().then((r) => { cap.status = 'ready'; cap.supported = r.supported === true; }, () => { cap.status = 'ready'; }).finally(refresh);
  }
  if (ui.capability.status !== 'ready' || !ui.capability.supported) return null;
  const query = eligibility.query;
  const key = `${query.sectorId}|${query.date}`;
  ui.shown = { key, query };
  if (!usableEntry(ctx, key)) {
    const s = { key, status: 'idle', value: null, error: null, seq: 0, auth: crew.authorization().key, storedAt: 0 };
    ui.entries.set(key, s);
    // Offline: nothing is requested; the state is retryable and cleared by the online event.
    if (globalThis.navigator?.onLine === false) { s.status = 'error'; s.error = 'offline'; }
    else startLoad(ctx, query, s);
  }
  return currentState(ctx, ui.shown);
}

/** Markup for the Flights detail: '' unless the crew section applies. */
export function crewSection(ctx, entry, view) {
  const state = crewSectionState(ctx, entry, view);
  return state ? crewSectionView(state, airlineOf(view.profile).crew) : '';
}

/** Flights detail mounted: retry wiring; leaving the detail lets the service stop a detail run for it. */
export function mountCrewSection(root, ctx) {
  ui.mounted = true;
  ui.root = root;
  ui.ctx = ctx;
  const shown = ui.shown;
  const onClick = (event) => {
    if (!event.target.closest('[data-crew-retry]') || !ui.shown) return;
    event.preventDefault();
    const s = ui.entries.get(ui.shown.key);
    if (s && s.status !== 'loading') { startLoad(ctx, ui.shown.query, s, { force: true }); refresh(); }
  };
  root.addEventListener('click', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    ui.mounted = false;
    // A quiet redraw unmounts and mounts again at once: only a real navigation away leaves the detail.
    setTimeout(() => {
      if (shown && (!ui.mounted || ui.shown?.key !== shown.key)) ctx.crew?.service?.leaveDetail(shown.query.sectorId);
    }, 0);
  };
}

/** Test hook: forget all crew UI state. */
export function resetCrewSection() {
  clearInterval(ui.ticker);
  Object.assign(ui, { accessId: undefined, capability: null, mounted: false, root: null, ctx: null, shown: null, ticker: null, watching: null });
  ui.entries.clear();
}

// --- Settings panel (Stage B3) -----------------------------------------------------------------------------
// Opt-in, enrollment, indexing progress, "Forget crew data" (explicit inline confirm, no browser dialogs) and the
// sign-out crew cleanup status. The enrollment code lives only in the input and the one request; never stored.

const panel = { phase: 'idle', message: null, capability: null, accessId: undefined };

function panelModel(ctx) {
  const crew = ctx.crew;
  const id = ctx.accessId?.() ?? '';
  if (id !== panel.accessId) { panel.accessId = id; panel.capability = null; }
  const record = crew.credentials.read();
  const status = crew.service.indexingStatus();
  return {
    diagnostics: crewDiagnosticSnapshot(),
    enabled: crew.enabled(),
    // A capability answer belongs to the access it was asked for (an answer for A never shows under B).
    capability: panel.capability && panel.capability.accessId === id ? panel.capability.status : null,
    enrolled: !!record && record.phase === 'active' && record.grants.some((e) => e.role === 'active'),
    hasRecord: !!record,
    pending: crew.credentials.pendingRevoke(),
    running: status.running,
    progress: status.lastProgress,
    cleanup: ctx.view().crewCleanup ?? null,
    phase: panel.phase,
    message: panel.message,
  };
}

function codeForm(copy, { compact = false } = {}) {
  return html`
    <form class="crew-form" data-crew-enroll novalidate>
      <label class="list-label" for="crew-code">${copy.codeLabel}</label>
      <input class="field-input" id="crew-code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
        data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-describedby="crew-code-help">
      <p class="t-caption" id="crew-code-help">${copy.codeHelp}</p>
      <div class="source-actions">
        <button type="submit" class="btn btn-primary">${copy.turnOn}</button>
        ${compact ? '' : html`<button type="button" class="btn btn-quiet" data-crew-not-now>${copy.notNow}</button>`}
      </div>
    </form>`;
}

/**
 * The Settings crew panel (pure).
 * @param {object} m  panel model (see panelModel), or a synthetic model in tests/harness
 * @param {object} copy  the airline pack's crew copy
 */
export function crewPanelView(m, copy) {
  const busy = m.phase === 'enrolling' || m.phase === 'deleting';
  const statusText = m.phase === 'deleting' ? copy.deleting
    : m.phase === 'enrolling' ? copy.enrolling
      : !m.enabled ? copy.statusOff
        : m.capability === 'checking' ? copy.statusChecking
          : m.capability === 'unsupported' ? copy.statusUnsupported
            : m.enrolled ? copy.statusOn : copy.statusNotSetUp;
  const on = m.enabled || m.phase === 'deleting';
  const p = m.progress;
  return html`
    <div class="setting-row crew-switch-row">
      <div class="setting-copy">
        <span class="list-label" id="crew-switch-label">${copy.settingsTitle}</span>
        <span class="t-caption">${statusText}</span>
      </div>
      <button type="button" class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-labelledby="crew-switch-label" data-crew-switch ${busy ? 'disabled' : ''}></button>
    </div>
    ${m.phase === 'opt-in' && !m.enabled ? html`
      <div class="crew-sheet" role="group" aria-labelledby="crew-optin-title">
        <p class="t-headline" id="crew-optin-title">${copy.optInTitle}</p>
        <ul class="crew-points" role="list">${copy.optInPoints.map((t) => html`<li class="t-callout">${t}</li>`)}</ul>
        ${codeForm(copy)}
      </div>` : ''}
    ${m.enabled && !m.enrolled && !m.pending && m.capability === 'supported' && m.phase !== 'enrolling' ? html`<div class="crew-sheet">${codeForm(copy, { compact: true })}</div>` : ''}
    ${m.enabled && m.enrolled && !m.pending ? html`
      <div class="crew-sheet">
        ${p ? html`
          <dl class="crew-progress">
            <div><dt>${copy.monthsIndexed}</dt><dd>${copy.monthsValue(p.indexed, p.total)}</dd></div>
            ${p.pending ? html`<div><dt>${copy.monthsWaiting}</dt><dd>${p.pending}</dd></div>` : ''}
            ${p.stale ? html`<div><dt>${copy.monthsRechecking}</dt><dd>${p.stale}</dd></div>` : ''}
            ${p.uncovered ? html`<div><dt>${copy.monthsUncovered}</dt><dd>${p.uncovered}</dd></div>` : ''}
          </dl>` : ''}
        <div class="source-actions">
          <button type="button" class="btn btn-quiet" data-crew-check ${m.running || busy ? 'disabled' : ''}>${m.running ? copy.checking : copy.checkNow}</button>
        </div>
        <p class="t-caption">${copy.progressNote}</p>
        ${m.phase === 'confirm-forget' ? '' : html`<div class="source-actions"><button type="button" class="btn btn-critical" data-crew-forget ${busy ? 'disabled' : ''}>${copy.forget}</button></div>`}
      </div>` : ''}
    ${m.phase === 'confirm-forget' ? html`
      <div class="crew-sheet crew-confirm" role="group" aria-labelledby="crew-forget-title">
        <p class="t-headline" id="crew-forget-title">${copy.forgetConfirmTitle}</p>
        <p class="t-callout">${copy.forgetConfirmText}</p>
        <div class="source-actions">
          <button type="button" class="btn btn-critical" data-crew-forget-confirm>${copy.forgetConfirm}</button>
          <button type="button" class="btn btn-quiet" data-crew-forget-cancel>${copy.cancel}</button>
        </div>
      </div>` : ''}
    ${m.pending ? html`
      <div class="crew-sheet">
        <p class="list-label">${copy.pendingTitle}</p>
        <p class="t-caption">${copy.pendingStatus[m.message?.pendingCode] ?? copy.pendingStatus.default}</p>
        <div class="source-actions"><button type="button" class="btn btn-quiet" data-crew-retry-delete ${busy ? 'disabled' : ''}>${copy.retryDelete}</button></div>
      </div>` : ''}
    ${m.cleanup && m.cleanup !== 'done' ? html`<p class="t-caption crew-cleanup">${copy.signOutCleanup[m.cleanup]}</p>` : ''}
    <details class="crew-sheet"><summary>Private performance diagnostics</summary>
      <p class="t-caption">Memory only: up to 100 requests and 20 index reports. No crew content. Starting sends nothing.</p>
      <button type="button" class="btn btn-quiet" data-crew-diagnostics-start ${m.running || busy ? 'disabled' : ''}>Start new session</button>
      <button type="button" class="btn btn-quiet" data-crew-diagnostics-end>End and clear</button>
      <button type="button" class="btn btn-quiet" data-crew-diagnostics-show>Show sanitized summary</button>
      ${m.diagnostics?.enabled ? html`<p class="t-caption">Recording aggregates</p>` : ''}
      <pre data-crew-diagnostics-output hidden></pre>
    </details>
    <div class="source-result" data-crew-result role="status" aria-live="polite">${m.message?.text ? html`<p class="source-verdict ${m.message.tone === 'error' ? 'is-error' : 'is-ok'}">${m.message.text}</p>` : ''}</div>`;
}

/** Settings markup: '' unless the airline pack offers crew wording and the app has a crew runtime. */
export function crewPanel(ctx) {
  const pack = airlineOf(ctx.view().profile).crew;
  if (!ctx.crew || !pack) return '';
  return html`
    <section class="setting-block" aria-labelledby="set-crew">
      <div class="section-head"><h2 class="t-eyebrow" id="set-crew">${pack.copy.settingsTitle}</h2></div>
      <div class="list crew-panel" data-crew-panel>${crewPanelView(panelModel(ctx), pack.copy)}</div>
    </section>`;
}

function drawPanel(root, ctx) {
  const box = root.querySelector('[data-crew-panel]');
  const pack = airlineOf(ctx.view().profile).crew;
  if (!box || !pack) return;
  // Never wipe a code being typed: a background update waits until the field is left.
  if (box.contains(document.activeElement) && document.activeElement?.id === 'crew-code') return;
  box.innerHTML = String(crewPanelView(panelModel(ctx), pack.copy));
}

/** Settings update hook (data changed while Settings is open). */
export function updateCrewPanel(root, ctx) { if (ctx.crew) drawPanel(root, ctx); }

/** Capability for the access current at the call; a late answer never updates another access's Settings state. */
function checkCapability(ctx) {
  const accessId = ctx.accessId?.() ?? '';
  const mark = { accessId, status: 'checking' };
  panel.capability = mark;
  const settle = (supported) => {
    if (panel.capability === mark && (ctx.accessId?.() ?? '') === accessId) mark.status = supported ? 'supported' : 'unsupported';
    return supported;
  };
  return ctx.crew.capability().then((r) => settle(r.supported === true), () => settle(false));
}

/**
 * Enrollment from Settings (no DOM). Consent and identity are captured at the start; after every await they and the
 * backend support are checked again, and the service evaluates the same check synchronously right before dispatch.
 * @returns {Promise<{outcome:'enrolled'|'cancelled'|'unsupported'|'error', code?:string}>}
 */
export async function startCrewEnrollment(ctx, code) {
  const crew = ctx.crew;
  if (!crew.enabled()) {
    // Preserve only explicit recording intent across this synchronous initial opt-in.
    // setEnabled still purges every old record. No deferred re-arm may cross an access
    // change, another consent transition, or an intervening diagnostic clear.
    const recording = crewDiagnosticsEnabled();
    const before = { accessId: ctx.accessId?.() ?? '', epoch: crew.consentEpoch(), diagnostics: crewDiagnosticGeneration() };
    crew.setEnabled(true);
    if (recording && crew.enabled() && (ctx.accessId?.() ?? '') === before.accessId
      && crew.consentEpoch() === before.epoch + 1 && crewDiagnosticGeneration() === before.diagnostics + 1) {
      startCrewDiagnostics();
    }
  }
  const start = { accessId: ctx.accessId?.() ?? '', epoch: crew.consentEpoch() };
  const still = () => crew.enabled() && (ctx.accessId?.() ?? '') === start.accessId && crew.consentEpoch() === start.epoch;
  const supported = await checkCapability(ctx);
  if (!still()) return { outcome: 'cancelled', code: 'consent-changed' };
  if (!supported) { crew.setEnabled(false); return { outcome: 'unsupported' }; }
  try {
    await crew.service.enroll(code, { guard: still });
    return { outcome: 'enrolled' };
  } catch (error) {
    const c = error?.code ?? 'error';
    return c === 'consent-changed' ? { outcome: 'cancelled', code: c } : { outcome: 'error', code: c };
  }
}

/** Wires the Settings crew panel; returns its cleanup. */
export function mountCrewPanel(root, ctx) {
  const box = root.querySelector('[data-crew-panel]');
  if (!box || !ctx.crew) return () => {};
  const pack = airlineOf(ctx.view().profile).crew;
  const copy = pack.copy;
  let alive = true;
  const draw = () => { if (alive) drawPanel(root, ctx); };
  const say = (text, tone = 'ok', extra = {}) => { panel.message = { text, tone, ...extra }; };
  if (ctx.crew.enabled() && !(panel.capability && panel.capability.accessId === (ctx.accessId?.() ?? ''))) checkCapability(ctx).then(draw);

  const deletionResult = (r) => {
    if (r.status === 'deleted') say(copy.deleted);
    else if (r.status === 'superseded') say(copy.superseded);
    else if (r.status === 'nothing') say(copy.nothingToDelete);
    else say(null, 'ok', { pendingCode: r.code });
  };
  const onClick = async (event) => {
    const t = event.target;
    if (t.closest('[data-crew-switch]')) {
      panel.message = null;
      if (!ctx.crew.enabled()) { panel.phase = panel.phase === 'opt-in' ? 'idle' : 'opt-in'; draw(); return; }
      if (ctx.crew.credentials.read()) { panel.phase = 'confirm-forget'; draw(); return; }
      ctx.crew.setEnabled(false); panel.phase = 'idle'; draw(); return;
    }
    if (t.closest('[data-crew-not-now]')) { panel.phase = 'idle'; panel.message = null; draw(); return; }
    if (t.closest('[data-crew-forget]')) { panel.phase = 'confirm-forget'; panel.message = null; draw(); return; }
    if (t.closest('[data-crew-forget-cancel]')) { panel.phase = 'idle'; draw(); return; }
    if (t.closest('[data-crew-forget-confirm]') || t.closest('[data-crew-retry-delete]')) {
      const resume = Boolean(t.closest('[data-crew-retry-delete]'));
      panel.phase = 'deleting'; panel.message = null; draw();
      try {
        const r = resume ? await ctx.crew.service.resumeRevoke() : await ctx.crew.service.revoke();
        if (!resume) ctx.crew.setEnabled(false);
        ctx.crew.invalidate?.('forget');
        deletionResult(r);
      } catch (error) {
        say(null, 'ok', { pendingCode: error?.code });
      }
      panel.phase = 'idle'; draw();
      return;
    }
    if (t.closest('[data-crew-diagnostics-start]')) { if (ctx.crew.service.indexingStatus().running) return; startCrewDiagnostics(); draw(); return; }
    if (t.closest('[data-crew-diagnostics-end]')) { clearCrewDiagnostics(); draw(); return; }
    if (t.closest('[data-crew-diagnostics-show]')) {
      const output = box.querySelector('[data-crew-diagnostics-output]');
      output.textContent = JSON.stringify(crewDiagnosticSnapshot(), null, 2); output.hidden = false; return;
    }
    if (t.closest('[data-crew-check]')) {
      panel.message = null;
      const run = ctx.crew.service.requestIndexing('manual');
      draw();
      const r = await run;
      say(copy.checkResult[r?.stopped] ?? copy.checkResultDefault, r?.stopped === 'done' || r?.stopped === 'no-progress' || r?.stopped === 'limit' ? 'ok' : 'error');
      draw();
    }
  };
  const onSubmit = async (event) => {
    if (!event.target.closest('[data-crew-enroll]')) return;
    event.preventDefault();
    const input = event.target.querySelector('#crew-code');
    const code = input?.value ?? '';
    if (input) input.value = '';   // the code is never kept
    panel.message = null;
    panel.phase = 'enrolling'; draw();
    const r = await startCrewEnrollment(ctx, code);
    if (r.outcome === 'enrolled') say(copy.enrolled);
    else if (r.outcome === 'unsupported') say(copy.statusUnsupported, 'error');
    else if (r.outcome === 'cancelled') say(copy.enrollCancelled, 'error');
    else say(copy.enrollError[r.code] ?? copy.enrollErrorDefault, 'error');
    panel.phase = 'idle'; draw();
  };
  box.addEventListener('click', onClick);
  box.addEventListener('submit', onSubmit);
  return () => {
    alive = false;
    box.removeEventListener('click', onClick);
    box.removeEventListener('submit', onSubmit);
    if (panel.phase === 'opt-in' || panel.phase === 'confirm-forget') panel.phase = 'idle';
  };
}

/** Test hook: forget the Settings panel state. */
export function resetCrewPanel() { Object.assign(panel, { phase: 'idle', message: null, capability: null, accessId: undefined }); }
