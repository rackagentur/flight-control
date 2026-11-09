// Settings: Appearance (live), Roster source and Profile (structure; later phases), local data.

import { html } from '../../lib/html.js';
import { html as h, render } from '../../lib/html.js';
import { pageHeader, listRow, themeControl, timeDisplayControl } from '../components.js';
import { store } from '../../store.js';
import { resetTimeDisplayCache, applyTimeDisplay } from '../../time-display.js';
import { applyTheme } from '../../theme.js';
import { validateEndpoint, fetchStatsSecure, contractGaps, postContract } from '../../api/appscript.js';
import { ENDPOINT_KEY, TOKEN_KEY, fallbackReason } from '../../controller.js';
import { SIGNED_OUT_KEY } from '../../roster-storage.js';
import { request as v2Request } from '../../sources/contract-v2.js';
import { workerDiagnosticsView, mountWorkerDiagnostics, updateWorkerDiagnostics } from '../worker-diagnostics.js';
import { crewPanel, mountCrewPanel, updateCrewPanel } from '../crew-section.js';
import { getPartTime, setPartTime, setPartTimeOverride, removePartTimeOverride } from '../../part-time.js';
import { PART_TIME_YEAR } from '../../model/part-time.js';
import { airlineOf } from '../../airlines/index.js';
import { daysInMonth, monthLabel } from '../../model/calendar.js';

const ERROR_HELP = {
  network: 'The browser could not read the response. If the URL opens normally in a browser tab, the backend is blocking cross-origin requests (CORS) from this page.',
  timeout: 'The backend did not answer in time. Apps Script can be slow on a cold start; try again.',
  http: 'The backend answered with an HTTP error.',
  'html-response': 'The backend returned a web page instead of data: getFlightStats may have thrown, or the deployment routes to a different doGet.',
  'invalid-json': 'The response was not valid JSON.',
  'backend-error': 'The backend reported an error.',
  'invalid-endpoint': 'This does not look like an Apps Script web-app URL ending in /exec.',
  'auth-required': 'The backend only serves the roster with the access token. Add or replace it under Roster contract v2.',
};

function resultView(result) {
  if (result.pending) return h`<p class="t-caption">Testing the connection…</p>`;
  if (result.needsToken) {
    return h`
      <p class="source-verdict is-ok">Connected · access token required</p>
      <p class="t-caption">The backend answered and only serves the roster with the access token. Add it under Roster contract v2 below.</p>`;
  }
  if (!result.ok) {
    return h`
      <p class="source-verdict is-error">Connection failed · ${result.code}</p>
      <p class="t-caption">${result.message}</p>
      ${ERROR_HELP[result.code] && ERROR_HELP[result.code] !== result.message && result.code !== 'invalid-endpoint' ? h`<p class="t-caption">${ERROR_HELP[result.code]}</p>` : ''}`;
  }
  return h`
    <p class="source-verdict is-ok">Connected · roster readable from this page</p>
    <ul class="source-checks" role="list">
      <li>Cross-origin read (CORS): allowed</li>
      <li>Response: JSON, success, ${result.ms} ms, ${(result.bytes / 1024).toFixed(1)} KB${result.via === 'post' ? ', read with the access token' : ''}</li>
      <li>Contract: ${result.gaps.length ? `missing ${result.gaps.join(', ')}` : 'all expected v5 fields present'}</li>
      <li>Roster: ${result.flights} upcoming flights, ${result.blocks} free-day blocks</li>
    </ul>`;
}

/** Reads the roster as the app would (with the saved token, if any). Exported for tests. */
export async function testEndpoint(endpoint, token = store.get(TOKEN_KEY)) {
  try {
    const { data, meta, via } = await fetchStatsSecure(endpoint, token);
    return {
      ok: true, via, ms: meta.ms, bytes: meta.bytes, gaps: contractGaps(data),
      flights: Array.isArray(data.upcoming) ? data.upcoming.length : 0,
      blocks: Array.isArray(data.daysOff) ? data.daysOff.length : 0,
    };
  } catch (error) {
    // Reachable, but the roster needs the token: the URL is right, so it can be saved.
    if (error.code === 'auth-required' && !token) return { ok: true, needsToken: true };
    return { ok: false, code: error.code ?? 'network', message: error.message };
  }
}

/** Feature detection: does this backend offer fc.roster v2, and is the token accepted? */
async function testContract(endpoint, token) {
  try {
    const { data } = await postContract(endpoint, v2Request('capabilities', token));
    if (data?.ok === true && data.contract === 'fc.roster' && data.version === 2) return { ok: true, text: `Contract v2 available · actions: ${data.actions.join(', ')}` };
    return { ok: false, text: `Not available: ${fallbackReason({ code: data?.error ?? 'contract-mismatch' })}.` };
  } catch (error) {
    return { ok: false, text: `Not available: ${fallbackReason(error)}. Flight Control keeps using the v5 contract.` };
  }
}

function contractStatus(view) {
  const c = view.contract;
  if (!c?.active) return 'Not loaded yet';
  if (c.active === 'v2') return 'In use: contract v2';
  return c.fallback ? `In use: v5 (fallback: ${c.fallback})` : 'In use: v5';
}

/** The contract status line; shared by render and update so both always agree. */
export function contractLine(view, hasToken) {
  // No token stored and the backend refused the read: say so here too (the shell status line is hidden on narrow screens).
  if (!hasToken && !view.snapshot && view.error?.code === 'auth-required') return 'Access token required · the roster is only served with the token';
  return `${contractStatus(view)}${hasToken ? ' · token saved' : ''}`;
}

/**
 * Parses "4, 5 6" into sorted unique integers within lo..hi. `none` (or empty, when allowEmpty) = [].
 * Exported for tests. @returns {{ok:true, values:number[]}|{ok:false, reason:string}}
 */
export function parseNumberList(text, { lo, hi, allowEmpty = false, what = 'values', orNone = true } = {}) {
  const parts = String(text ?? '').split(/[\s,;]+/).filter(Boolean);
  if (!parts.length || (parts.length === 1 && parts[0].toLowerCase() === 'none')) {
    return allowEmpty || parts.length ? { ok: true, values: [] } : { ok: false, reason: `Enter ${what}${orNone ? ', or "none"' : ''}.` };
  }
  const values = [];
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part) || Number(part) < lo || Number(part) > hi) return { ok: false, reason: `"${part}" is not a valid entry; use numbers from ${lo} to ${hi}, separated by commas.` };
    values.push(Number(part));
  }
  return { ok: true, values: [...new Set(values)].sort((a, b) => a - b) };
}

/** Parse options for the "Replace month" days field (exported so a test can check the empty-input message). */
export const OVERRIDE_DAYS_PARSE = { lo: 1, hi: 31, what: 'the days for this month' };
const PART_TIME_MONTHS = Array.from({ length: 12 }, (_, i) => `${PART_TIME_YEAR}-${String(i + 1).padStart(2, '0')}`);
const listText = (values) => (values.length ? values.join(', ') : 'none');

function partTimeOverridesView(config) {
  const keys = Object.keys(config.overrides).sort();
  return keys.length
    ? h`<ul class="source-checks" role="list">${keys.map((key) => h`<li>${monthLabel(key)}: ${listText(config.overrides[key])}</li>`)}</ul>`
    : h`<p class="t-caption">No month overrides</p>`;
}

export const settings = {
  title: 'Settings',

  render(ctx) {
    const profile = ctx.view().profile;
    const connected = Boolean(store.get(ENDPOINT_KEY));
    const hasToken = Boolean(store.get(TOKEN_KEY));
    const partTime = getPartTime();
    // The part-time schedule exists only for packs that define the term (airline wording lives in src/airlines/).
    const ptTerm = airlineOf(profile).terminology.partTime;
    return html`
      <div class="page">
        ${pageHeader({ title: 'Settings' })}
        <div class="settings">
          <section class="setting-block" aria-labelledby="set-appearance">
            <div class="section-head"><h2 class="t-eyebrow" id="set-appearance">Appearance</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Theme</span>
                  <span class="t-caption">System follows your device. Your choice is remembered on this device.</span>
                </div>
                ${themeControl()}
              </div>
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Time display</span>
                  <span class="t-caption">Local — Airport time zones. UTC — Coordinated Universal Time.</span>
                </div>
                ${timeDisplayControl()}
              </div>
            </div>
          </section>

          ${ptTerm ? html`
          <section class="setting-block" aria-labelledby="set-parttime">
            <div class="section-head"><h2 class="t-eyebrow" id="set-parttime">Part-time schedule</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="t-caption">Your personal part-time days in ${PART_TIME_YEAR}, shown as ${ptTerm.short} (${ptTerm.name}) in the calendar. Kept only on this device, never sent anywhere and never written to the roster. Any roster duty on the same day replaces ${ptTerm.short}.</span>
                </div>
              </div>
              <form class="source-form" data-parttime-form novalidate>
                <label class="setting-copy"><span class="list-label"><input type="checkbox" name="enabled" ${partTime.enabled ? 'checked' : ''}> Show part-time days</span></label>
                <label class="list-label" for="parttime-days">Days of month</label>
                <input class="field-input" id="parttime-days" name="days" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${listText(partTime.days)}" placeholder="4, 5, 6, 7">
                <label class="list-label" for="parttime-paused">Paused months</label>
                <input class="field-input" id="parttime-paused" name="paused" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${listText(partTime.pausedMonths)}" placeholder="7, 8, 9" aria-describedby="parttime-paused-help">
                <p class="t-caption" id="parttime-paused-help">Month numbers, e.g. 7, 8, 9 = July–September. None are generated in these months.</p>
                <div class="source-actions"><button type="submit" class="btn btn-primary">Save part-time schedule</button></div>
                <div class="source-result" data-parttime-result role="status" aria-live="polite"></div>
              </form>
              <form class="source-form" data-parttime-override novalidate>
                <p class="list-label">Replace one month</p>
                <label class="visually-hidden" for="parttime-month">Month</label>
                <select class="field-input" id="parttime-month" name="month">${PART_TIME_MONTHS.map((key) => html`<option value="${key}">${monthLabel(key)}</option>`)}</select>
                <label class="visually-hidden" for="parttime-override-days">Days for this month</label>
                <input class="field-input" id="parttime-override-days" name="days" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="e.g. 10, 11, 12, 13 or none">
                <div class="source-actions">
                  <button type="submit" class="btn btn-primary">Replace month</button>
                  <button type="button" class="btn btn-quiet" data-parttime-remove>Remove override</button>
                </div>
                <div data-parttime-overrides>${partTimeOverridesView(partTime)}</div>
                <div class="source-result" data-parttime-override-result role="status" aria-live="polite"></div>
              </form>
            </div>
          </section>
          ` : ''}

          <section class="setting-block" aria-labelledby="set-source">
            <div class="section-head"><h2 class="t-eyebrow" id="set-source">Roster source</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Flight Control calendar</span>
                  <span class="t-caption">Your processed roster from the Flight Control backend. The web-app URL is stored only in this browser and is never shown again after saving.</span>
                </div>
                <span class="t-caption" data-endpoint-state>${connected ? 'URL saved' : 'Not configured'}</span>
              </div>
              <form class="source-form" data-endpoint-form novalidate>
                <label class="visually-hidden" for="endpoint-input">Backend web-app URL</label>
                <input class="field-input" id="endpoint-input" name="endpoint" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
                  placeholder="${connected ? 'Connected · paste a new URL to replace it' : 'https://script.google.com/macros/s/…/exec'}">
                <div class="source-actions">
                  <button type="submit" class="btn btn-primary">Save credentials</button>
                  <button type="button" class="btn btn-quiet" data-roster-refresh ${connected ? '' : 'disabled'}>Refresh roster</button>
                  <button type="button" class="btn btn-quiet" data-endpoint-test ${connected ? '' : 'disabled'}>Test connection</button>
                  <button type="button" class="btn btn-critical" data-endpoint-remove ${connected ? '' : 'disabled'}>Disconnect</button>
                </div>
                <div class="source-result" data-endpoint-result role="status" aria-live="polite"></div>
              </form>
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Roster contract v2 (preview)</span>
                  <span class="t-caption">Richer roster data (explicit off days, report times, roster hotels, history) from a backend that offers it. Needs the access token configured on the backend. Stored only in this browser; without it, or if v2 is unavailable, the v5 contract is used automatically.</span>
                  <span class="t-caption" data-contract-state>${contractLine(ctx.view(), hasToken)}</span>
                </div>
              </div>
              <form class="source-form" data-token-form novalidate>
                <label class="visually-hidden" for="token-input">Contract v2 access token</label>
                <input class="field-input" id="token-input" name="token" type="password" autocomplete="one-time-code" spellcheck="false"
                  data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"
                  placeholder="${hasToken ? 'Token saved · paste a new one to replace it' : 'Access token'}">
                <div class="source-actions">
                  <button type="submit" class="btn btn-primary" ${connected ? '' : 'disabled'}>Save credentials</button>
                  <button type="button" class="btn btn-critical" data-token-remove ${hasToken || ctx.view().savedRoster ? '' : 'disabled'}>Sign out</button>
                </div>
                <p class="t-caption">Sign out removes the access token, the saved roster and remembered flights from this browser. Home base, wake-up time and display preferences stay. To remove everything, use Reset under Data on this device.</p>
                <div class="source-result" data-token-result role="status" aria-live="polite"></div>
              </form>
              ${listRow({ iconName: 'calendar', label: 'Airline calendar', detail: 'Read the airline roster calendar directly', trail: 'Planned', disabled: true })}
              ${listRow({ iconName: 'report', label: 'ICS import', detail: 'Import a roster file', trail: 'Planned', disabled: true })}
            </div>
          </section>${crewPanel(ctx)}

          <section class="setting-block" aria-labelledby="set-profile">
            <div class="section-head"><h2 class="t-eyebrow" id="set-profile">Profile</h2></div>
            <div class="list">
              ${listRow({ iconName: 'profile', label: 'Home base', detail: `Crew base ${profile.homeBases.join(' · ')} · ${profile.homeTz}`, trail: 'Editable later', disabled: true })}
              ${listRow({ iconName: 'today', label: 'Wake-up before pickup', detail: `${profile.wakeupOffsetMin} min`, trail: 'Editable later', disabled: true })}
              ${listRow({ iconName: 'hotel', label: 'Alarm shortcut and saved hotels', detail: `Shortcut “${profile.alarmShortcutName}”${profile.hotelListUrl ? ' · saved list set' : ''}`, trail: 'Editable later', disabled: true })}
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-data">
            <div class="section-head"><h2 class="t-eyebrow" id="set-data">Data on this device</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Reset local data</span>
                  <span class="t-caption" id="reset-help">Removes everything Flight Control keeps in this browser: the roster connection and access token, the saved roster, remembered flights and all preferences. Flight Control starts again from setup. Your roster itself is not affected.</span>
                </div>
                <button type="button" class="btn btn-critical" id="reset-local" aria-describedby="reset-help">Reset</button>
              </div>
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-about">
            <div class="section-head"><h2 class="t-eyebrow" id="set-about">About</h2></div>
            <div class="list">
              ${listRow({ iconName: 'info', label: 'Flight Control', detail: 'Version 2.0 · operational preview (Phase 4)' })}
              <div data-worker-diagnostics aria-live="polite">${workerDiagnosticsView()}</div>
            </div>
          </section>
        </div>
      </div>`;
  },

  /**
   * Data changed while Settings is open (e.g. a roster load finished). Only the status
   * line and diagnostics are refreshed: a full re-render would discard form input.
   */
  update(root, ctx) {
    updateWorkerDiagnostics(root);
    updateCrewPanel(root, ctx);
    const line = root.querySelector('[data-contract-state]');
    if (!line) return;
    const text = contractLine(ctx.view(), Boolean(store.get(TOKEN_KEY)));
    if (line.textContent !== text) line.textContent = text;
  },

  mount(root, ctx) {
    const stopDiagnostics = mountWorkerDiagnostics(root, () => ctx.view());
    const stopCrew = mountCrewPanel(root, ctx);
    let alive = true, operation = 0;
    const identity = () => JSON.stringify([store.get(ENDPOINT_KEY), store.get(TOKEN_KEY), store.get(SIGNED_OUT_KEY), ctx.controller.accessRevision?.()]);
    const form = root.querySelector('[data-endpoint-form]');
    const input = form.querySelector('#endpoint-input');
    const out = form.querySelector('[data-endpoint-result]');
    const show = (result) => render(out, resultView(result));
    const rerender = () => ctx.rerender?.();

    const onSubmit = async (event) => {
      event.preventDefault();
      const check = validateEndpoint(input.value);
      if (!check.ok) {
        show({ ok: false, code: 'invalid-endpoint', message: check.reason });
        return;
      }

      operation += 1;
      if (!store.set(ENDPOINT_KEY, check.url)) {
        show({ ok: false, code: 'storage', message: 'Connection URL could not be saved.' });
        return;
      }

      input.value = '';
      ctx.controller.forgetContractData();
      if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });

      root.querySelector('[data-endpoint-state]').textContent = 'URL saved';
      for (const button of root.querySelectorAll(
        '[data-roster-refresh], [data-endpoint-test], [data-endpoint-remove], [data-token-form] button[type="submit"]'
      )) button.disabled = false;

      input.placeholder = 'URL saved · paste a new URL to replace it';
      render(out, h`<p class="source-verdict is-ok">Backend URL saved · connection not verified</p>`);
    };
    const refreshButton = root.querySelector('[data-roster-refresh]');
    const onRefresh = () => ctx.controller.refresh({ force: true });
    refreshButton?.addEventListener('click', onRefresh);
    const onTest = async () => {
      const endpoint = store.get(ENDPOINT_KEY);
      if (!endpoint) return;
      show({ pending: true });
      show(await testEndpoint(endpoint));
    };
    const onRemove = () => {
      operation += 1;
      ctx.clearPersonalMemory?.();
      ctx.controller.removeToken({ disconnect: true });
      rerender();
    };
    form.addEventListener('submit', onSubmit);
    const tokenForm = root.querySelector('[data-token-form]');
    const tokenOut = tokenForm.querySelector('[data-token-result]');
    const onToken = async (event) => {
      event.preventDefault();
      const field = tokenForm.querySelector('#token-input');
      const value = field.value.trim();
      const endpoint = store.get(ENDPOINT_KEY);
      if (!value || !endpoint) return;

      operation += 1;
      if (!store.set(TOKEN_KEY, value)) {
        render(tokenOut, h`<p class="source-verdict is-error">Access token could not be saved.</p>`);
        return;
      }

      ctx.controller.forgetContractData();
      if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });

      field.value = '';
      render(tokenOut, h`<p class="source-verdict is-ok">Access token saved · connection not verified</p>`);
    };
    const onTokenRemove = () => {
      operation += 1;
      ctx.clearPersonalMemory?.();
      ctx.controller.removeToken();
      rerender();
    };
    tokenForm.addEventListener('submit', onToken);
    const tokenRemove = root.querySelector('[data-token-remove]');
    tokenRemove.addEventListener('click', onTokenRemove);
    const testButton = root.querySelector('[data-endpoint-test]');
    const removeButton = root.querySelector('[data-endpoint-remove]');
    testButton.addEventListener('click', onTest);
    removeButton.addEventListener('click', onRemove);

    // Part-time schedule: settings-only forms, updated in place so the other forms keep their input.
    // The block is absent when the airline pack has no part-time term; then nothing is wired.
    const ptForm = root.querySelector('[data-parttime-form]');
    const ovForm = root.querySelector('[data-parttime-override]');
    const ptWired = Boolean(ptForm && ovForm);
    const ptOut = ptForm?.querySelector('[data-parttime-result]');
    const ovOut = ovForm?.querySelector('[data-parttime-override-result]');
    const ovList = ovForm?.querySelector('[data-parttime-overrides]');
    const ovRemove = ovForm?.querySelector('[data-parttime-remove]');
    const say = (el, ok, text) => render(el, h`<p class="source-verdict ${ok ? 'is-ok' : 'is-error'}">${text}</p>`);
    const showOverrides = (config) => render(ovList, partTimeOverridesView(config));
    const onPartTime = (event) => {
      event.preventDefault();
      const days = parseNumberList(ptForm.elements.days.value, { lo: 1, hi: 31, what: 'at least one day of the month', orNone: false });
      if (!days.ok) { say(ptOut, false, `Days of month: ${days.reason}`); return; }
      if (!days.values.length) { say(ptOut, false, 'Days of month: enter at least one day.'); return; }
      const paused = parseNumberList(ptForm.elements.paused.value, { lo: 1, hi: 12, allowEmpty: true, what: 'month numbers' });
      if (!paused.ok) { say(ptOut, false, `Paused months: ${paused.reason}`); return; }
      const saved = setPartTime({ ...getPartTime(), enabled: ptForm.elements.enabled.checked, days: days.values, pausedMonths: paused.values });
      if (!saved.ok) { say(ptOut, false, 'The part-time schedule could not be saved on this device.'); return; }
      ptForm.elements.days.value = listText(saved.config.days);
      ptForm.elements.paused.value = listText(saved.config.pausedMonths);
      say(ptOut, true, saved.config.enabled ? 'Saved · part-time days are shown in the calendar.' : 'Saved · part-time days are hidden.');
    };
    const onOverride = (event) => {
      event.preventDefault();
      const month = ovForm.elements.month.value;
      const days = parseNumberList(ovForm.elements.days.value, OVERRIDE_DAYS_PARSE);
      if (!days.ok) { say(ovOut, false, days.reason); return; }
      const length = daysInMonth(month);
      const bad = days.values.find((d) => d > length);
      if (bad !== undefined) { say(ovOut, false, `${monthLabel(month)} has only ${length} days; ${bad} is not one of them.`); return; }
      const saved = setPartTimeOverride(month, days.values);
      if (!saved.ok) { say(ovOut, false, 'The month could not be saved on this device.'); return; }
      showOverrides(saved.config);
      say(ovOut, true, `${monthLabel(month)}: ${listText(days.values)}. Other months are unchanged.`);
    };
    const onOverrideRemove = () => {
      const month = ovForm.elements.month.value;
      const had = Object.hasOwn(getPartTime().overrides, month);
      const saved = removePartTimeOverride(month);
      if (!saved.ok) { say(ovOut, false, 'The change could not be saved on this device.'); return; }
      showOverrides(saved.config);
      say(ovOut, true, had ? `${monthLabel(month)}: override removed, the recurring pattern applies again.` : `${monthLabel(month)} has no override.`);
    };
    if (ptWired) {
      ptForm.addEventListener('submit', onPartTime);
      ovForm.addEventListener('submit', onOverride);
      ovRemove.addEventListener('click', onOverrideRemove);
    }

    let armed = false;
    let timer = null;
    const button = root.querySelector('#reset-local');
    const onClick = () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Tap again to reset';
        timer = setTimeout(() => { armed = false; button.textContent = 'Reset'; }, 4000);
        return;
      }
      clearTimeout(timer);
      operation += 1;
      ctx.clearPersonalMemory?.();
      const cleared = ctx.controller.resetLocalData();
      applyTheme('system');
      resetTimeDisplayCache();
      applyTimeDisplay();
      armed = false;
      rerender();
      const reset = root.querySelector('#reset-local');
      if (reset) reset.textContent = cleared ? 'Cleared' : 'Could not clear · use browser settings';
    };
    button.addEventListener('click', onClick);
    return () => {
      stopDiagnostics();
      stopCrew();
      alive = false; operation += 1;
      clearTimeout(timer);
      button.removeEventListener('click', onClick);
      form.removeEventListener('submit', onSubmit);
      tokenForm.removeEventListener('submit', onToken);
      tokenRemove.removeEventListener('click', onTokenRemove);
      testButton.removeEventListener('click', onTest);
      removeButton.removeEventListener('click', onRemove);
      refreshButton?.removeEventListener('click', onRefresh);
      if (ptWired) {
        ptForm.removeEventListener('submit', onPartTime);
        ovForm.removeEventListener('submit', onOverride);
        ovRemove.removeEventListener('click', onOverrideRemove);
      }
    };
  },
};
