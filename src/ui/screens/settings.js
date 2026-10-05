// Settings: Appearance (live), Roster source and Profile (structure; later phases), local data.

import { html } from '../../lib/html.js';
import { html as h, render } from '../../lib/html.js';
import { pageHeader, listRow, themeControl } from '../components.js';
import { store } from '../../store.js';
import { applyTheme } from '../../theme.js';
import { validateEndpoint, fetchStats, contractGaps, postContract } from '../../api/appscript.js';
import { ENDPOINT_KEY, TOKEN_KEY, fallbackReason } from '../../controller.js';
import { request as v2Request } from '../../sources/contract-v2.js';

const ERROR_HELP = {
  network: 'The browser could not read the response. If the URL opens normally in a browser tab, the backend is blocking cross-origin requests (CORS) from this page.',
  timeout: 'The backend did not answer in time. Apps Script can be slow on a cold start; try again.',
  http: 'The backend answered with an HTTP error.',
  'html-response': 'The backend returned a web page instead of data: getFlightStats may have thrown, or the deployment routes to a different doGet.',
  'invalid-json': 'The response was not valid JSON.',
  'backend-error': 'The backend reported an error.',
  'invalid-endpoint': 'This does not look like an Apps Script web-app URL ending in /exec.',
};

function resultView(result) {
  if (result.pending) return h`<p class="t-caption">Testing the connection…</p>`;
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
      <li>Response: JSON, success, ${result.ms} ms, ${(result.bytes / 1024).toFixed(1)} KB</li>
      <li>Contract: ${result.gaps.length ? `missing ${result.gaps.join(', ')}` : 'all expected v5 fields present'}</li>
      <li>Roster: ${result.flights} upcoming flights, ${result.blocks} free-day blocks</li>
    </ul>`;
}

async function testEndpoint(endpoint) {
  try {
    const { data, meta } = await fetchStats(endpoint);
    return {
      ok: true, ms: meta.ms, bytes: meta.bytes, gaps: contractGaps(data),
      flights: Array.isArray(data.upcoming) ? data.upcoming.length : 0,
      blocks: Array.isArray(data.daysOff) ? data.daysOff.length : 0,
    };
  } catch (error) {
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
  return `${contractStatus(view)}${hasToken ? ' · token saved' : ''}`;
}

export const settings = {
  title: 'Settings',

  render(ctx) {
    const profile = ctx.view().profile;
    const connected = Boolean(store.get(ENDPOINT_KEY));
    const hasToken = Boolean(store.get(TOKEN_KEY));
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
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-source">
            <div class="section-head"><h2 class="t-eyebrow" id="set-source">Roster source</h2></div>
            <div class="list">
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="list-label">Flight Control calendar</span>
                  <span class="t-caption">Your processed roster from the Flight Control backend. The web-app URL is stored only in this browser and is never shown again after saving.</span>
                </div>
                <span class="t-caption" data-endpoint-state>${connected ? 'Connected' : 'Not connected'}</span>
              </div>
              <form class="source-form" data-endpoint-form novalidate>
                <label class="visually-hidden" for="endpoint-input">Backend web-app URL</label>
                <input class="field-input" id="endpoint-input" name="endpoint" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
                  placeholder="${connected ? 'Connected · paste a new URL to replace it' : 'https://script.google.com/macros/s/…/exec'}">
                <div class="source-actions">
                  <button type="submit" class="btn btn-quiet">Save and test</button>
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
                <input class="field-input" id="token-input" name="token" type="password" autocomplete="off" spellcheck="false"
                  placeholder="${hasToken ? 'Token saved · paste a new one to replace it' : 'Access token'}">
                <div class="source-actions">
                  <button type="submit" class="btn btn-quiet" ${connected ? '' : 'disabled'}>Save and test</button>
                  <button type="button" class="btn btn-critical" data-token-remove ${hasToken ? '' : 'disabled'}>Remove token</button>
                </div>
                <div class="source-result" data-token-result role="status" aria-live="polite"></div>
              </form>
              ${listRow({ iconName: 'calendar', label: 'Airline calendar', detail: 'Read the airline roster calendar directly', trail: 'Planned', disabled: true })}
              ${listRow({ iconName: 'report', label: 'ICS import', detail: 'Import a roster file', trail: 'Planned', disabled: true })}
            </div>
          </section>

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
                  <span class="t-caption" id="reset-help">Clears preferences, the saved roster connection, the cached roster and remembered flights in this browser. Your roster itself is not affected.</span>
                </div>
                <button type="button" class="btn btn-critical" id="reset-local" aria-describedby="reset-help">Reset</button>
              </div>
            </div>
          </section>

          <section class="setting-block" aria-labelledby="set-about">
            <div class="section-head"><h2 class="t-eyebrow" id="set-about">About</h2></div>
            <div class="list">
              ${listRow({ iconName: 'info', label: 'Flight Control', detail: 'Version 2.0 · operational preview (Phase 4)' })}
            </div>
          </section>
        </div>
      </div>`;
  },

  /**
   * Data changed while Settings is open (e.g. a roster load finished). Only the status
   * line is refreshed: a full re-render would discard what is being typed into the forms.
   */
  update(root, ctx) {
    const line = root.querySelector('[data-contract-state]');
    if (!line) return;
    const text = contractLine(ctx.view(), Boolean(store.get(TOKEN_KEY)));
    if (line.textContent !== text) line.textContent = text;
  },

  mount(root, ctx) {
    const form = root.querySelector('[data-endpoint-form]');
    const input = form.querySelector('#endpoint-input');
    const out = form.querySelector('[data-endpoint-result]');
    const show = (result) => render(out, resultView(result));
    const rerender = () => ctx.rerender?.();

    const onSubmit = async (event) => {
      event.preventDefault();
      const check = validateEndpoint(input.value);
      if (!check.ok) { show({ ok: false, code: 'invalid-endpoint', message: check.reason }); return; }
      show({ pending: true });
      const result = await testEndpoint(check.url);
      if (result.ok) {
        store.set(ENDPOINT_KEY, check.url);
        input.value = '';
        ctx.controller.forgetRosterData();
        if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });
        root.querySelector('[data-endpoint-state]').textContent = 'Connected';
        for (const b of root.querySelectorAll('[data-endpoint-test], [data-endpoint-remove]')) b.disabled = false;
        input.placeholder = 'Connected · paste a new URL to replace it';
      }
      show(result);
    };
    const onTest = async () => {
      const endpoint = store.get(ENDPOINT_KEY);
      if (!endpoint) return;
      show({ pending: true });
      show(await testEndpoint(endpoint));
    };
    const onRemove = () => {
      store.remove(ENDPOINT_KEY);
      ctx.controller.forgetRosterData();
      if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });
      rerender();
    };
    form.addEventListener('submit', onSubmit);
    const tokenForm = root.querySelector('[data-token-form]');
    const tokenOut = tokenForm.querySelector('[data-token-result]');
    const onToken = async (event) => {
      event.preventDefault();
      const value = tokenForm.querySelector('#token-input').value.trim();
      const endpoint = store.get(ENDPOINT_KEY);
      if (!value || !endpoint) return;
      render(tokenOut, h`<p class="t-caption">Testing contract v2…</p>`);
      const result = await testContract(endpoint, value);
      if (result.ok) {
        store.set(TOKEN_KEY, value);
        ctx.controller.forgetContractData();
        if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });
      }
      tokenForm.querySelector('#token-input').value = '';
      render(tokenOut, h`<p class="source-verdict ${result.ok ? 'is-ok' : 'is-error'}">${result.text}</p>${result.ok ? '' : h`<p class="t-caption">The token was not saved.</p>`}`);
    };
    const onTokenRemove = () => {
      store.remove(TOKEN_KEY);
      ctx.controller.forgetContractData();
      if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });
      rerender();
    };
    tokenForm.addEventListener('submit', onToken);
    const tokenRemove = root.querySelector('[data-token-remove]');
    tokenRemove.addEventListener('click', onTokenRemove);
    const testButton = root.querySelector('[data-endpoint-test]');
    const removeButton = root.querySelector('[data-endpoint-remove]');
    testButton.addEventListener('click', onTest);
    removeButton.addEventListener('click', onRemove);

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
      const removed = store.clearAll();
      applyTheme('system');
      if (!ctx.review()) ctx.controller.setMode({ kind: 'production' });
      armed = false;
      button.textContent = removed > 0 ? 'Cleared' : 'Nothing to clear';
      button.disabled = true;
    };
    button.addEventListener('click', onClick);
    return () => {
      clearTimeout(timer);
      button.removeEventListener('click', onClick);
      form.removeEventListener('submit', onSubmit);
      tokenForm.removeEventListener('submit', onToken);
      tokenRemove.removeEventListener('click', onTokenRemove);
      testButton.removeEventListener('click', onTest);
      removeButton.removeEventListener('click', onRemove);
    };
  },
};
