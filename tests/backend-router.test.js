// Backend hardening BH-1: the web app's GET surface (backend/apps-script/RouterV2.gs).
// Only the read-only v5 getStats contract is served; nothing else is reachable by GET,
// no HtmlService page is ever returned, and the project has exactly one doGet/doPost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { loadGs } from './gs-harness.js';

const DIR = new URL('../backend/apps-script/', import.meta.url);
const gs = loadGs();
const plain = (x) => JSON.parse(JSON.stringify(x));

// Every function a GET could previously reach (directly or through google.script.run).
const GUARDED = ['syncWorkToJointCalendar', 'standbyHourlySync', 'generateMonthlyDashboard', 'generatePreviousMonthDashboard',
  'cleanupSyncedEvents', 'forceRefreshAllDescriptions', 'setupRecommendedTriggers', 'setupMonthlyTrigger', 'getAppHtml'];

/** RouterV2.gs alone in a sandbox with recording fakes for the Apps Script services. */
function router({ v5Get = 'open' } = {}) {
  const calls = [];
  const sandbox = {
    calls,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => { calls.push(`property:${k}`); return k === 'FC_V5_GET' ? v5Get : null; } }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) { const out = { text, mime: null, setMimeType(m) { out.mime = m; return out; } }; calls.push('ContentService'); return out; },
    },
    HtmlService: new Proxy({}, { get: () => () => { calls.push('HtmlService'); return {}; } }),
    getFlightStats: () => { calls.push('getFlightStats'); return { success: true, upcoming: [], marker: 'v5-payload' }; },
  };
  for (const name of GUARDED) sandbox[name] = () => { calls.push(name); };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('RouterV2.gs', DIR), 'utf8'), sandbox);
  return sandbox;
}

const get = (sb, parameter) => { const out = sb.doGet(parameter === undefined ? undefined : { parameter }); return { out, body: JSON.parse(out.text) }; };

test('getStats is served unchanged as JSON while FC_V5_GET is "open" (migration window)', () => {
  const sb = router({ v5Get: 'open' });
  const { out, body } = get(sb, { action: 'getStats' });
  assert.equal(out.mime, 'application/json');
  assert.deepEqual(body, { success: true, upcoming: [], marker: 'v5-payload' });
  assert.deepEqual(sb.calls.filter((c) => c !== 'ContentService'), ['property:FC_V5_GET', 'getFlightStats']);
});

test('BH-2: without FC_V5_GET = "open", getStats by GET answers auth-required and reads nothing', () => {
  for (const v5Get of [null, '', 'closed', 'OPEN', 'open ', 'true', '1']) {
    const sb = router({ v5Get });
    const { out, body } = get(sb, { action: 'getStats' });
    assert.equal(out.mime, 'application/json');
    assert.deepEqual(body, { success: false, error: 'auth-required', message: 'Authentication required.' }, String(v5Get));
    assert.ok(!sb.calls.includes('getFlightStats'), `no roster read for FC_V5_GET=${JSON.stringify(v5Get)}`);
  }
});

test('no action, the retired actions and the legacy ?function= wrapper are refused without side effects', () => {
  const cases = [undefined, {}, { action: '' }, { action: 'sync' }, { action: 'dashboard' }, { action: 'dashboardPrev' },
    { action: 'GETSTATS' }, { action: ['getStats'] }, { function: 'syncWorkToJointCalendar' }, { function: 'getFlightStats', callback: 'cb' },
    { action: 'cleanupSyncedEvents' }, { action: 'getAppHtml' }];
  for (const parameter of cases) {
    const sb = router();
    const { out, body } = get(sb, parameter);
    assert.equal(out.mime, 'application/json', JSON.stringify(parameter));
    assert.deepEqual(body, { success: false, message: 'Not available.' }, JSON.stringify(parameter));
    assert.deepEqual(sb.calls, ['ContentService'], `nothing but the JSON answer for ${JSON.stringify(parameter)}`);
    const closed = router({ v5Get: null });
    assert.deepEqual(get(closed, parameter).body, { success: false, message: 'Not available.' });
  }
});

test('never an HtmlService page (google.script.run stays unreachable), never JSONP, never echoes input', () => {
  const sb = router();
  for (const parameter of [undefined, { action: 'getStats' }, { action: '<script>alert(1)</script>' }, { callback: 'evil', function: 'x' }]) {
    const { out } = get(sb, parameter);
    assert.equal(out.mime, 'application/json');
    assert.ok(!/alert|evil/.test(out.text), 'request values are not reflected');
  }
  assert.ok(!sb.calls.includes('HtmlService'));
  const source = readFileSync(new URL('RouterV2.gs', DIR), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/HtmlService|MimeType\.JAVASCRIPT|google\.script/.test(source));
});

test('the pure handler is shared by Node and Apps Script', () => {
  const open = { stats: () => 'S', v5GetOpen: () => true };
  const shut = { stats: () => 'S', v5GetOpen: () => false };
  assert.equal(gs.fcv2HandleGet_({ action: 'getStats' }, open), 'S');
  assert.equal(plain(gs.fcv2HandleGet_({ action: 'getStats' }, shut)).error, 'auth-required');
  assert.deepEqual(plain(gs.fcv2HandleGet_({ action: 'sync' }, open)), plain(gs.FCV2_GET_REFUSED_));
  assert.ok(Object.isFrozen(gs.FCV2_GET_REFUSED_));
});

test('the committed backend defines exactly one doGet and one doPost; helpers stay private', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.gs'));
  const all = files.map((f) => readFileSync(new URL(f, DIR), 'utf8')).join('\n');
  assert.equal((all.match(/^function doGet\(/gm) ?? []).length, 1);
  assert.equal((all.match(/^function doPost\(/gm) ?? []).length, 1);
  const publicNames = [...all.matchAll(/^function ([A-Za-z0-9_$]+)\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith('_'));
  assert.deepEqual(publicNames.sort(), ['doGet', 'doPost']);
});
