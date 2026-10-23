// Crew Intelligence Stage B4/B5: synthetic screenshots of every crew state (Flight Details section and Settings
// panel), Light/Dark × 320/390/430 px, with simple layout checks (no horizontal overflow, 44 px tap targets).
// Test-only: not part of `npm test`; uses the machine's installed Playwright (PLAYWRIGHT_MODULE_PATH) and its
// chromium. No app bootstrap, storage, service worker, credentials or network: a local page renders the pure
// views with synthetic data. PNGs and index.md go to CREW_SHOTS_DIR (never into the repository).
//   PLAYWRIGHT_MODULE_PATH=/path/to/playwright-core [CHROMIUM_EXECUTABLE=/path/to/installed/chromium] \
//   CREW_SHOTS_DIR=/tmp/shots node tests/browser/crew-screens.mjs
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crewSectionView, crewPanelView } from '../../src/ui/crew-section.js';
import { getAirline } from '../../src/airlines/index.js';
import { validateCrew } from '../../src/sources/crew-v2.js';
import { neutralCrewAnswer as crewAnswer, neutralMembers as sampleMembers, unlistedAnswer, SECTOR, T0 } from '../fixtures/crew-frontend.synthetic.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.CREW_SHOTS_DIR;
if (!OUT || resolve(OUT).startsWith(resolve(root))) throw new Error('Set CREW_SHOTS_DIR to a folder outside the repository.');
mkdirSync(OUT, { recursive: true });

const PACK = getAirline('condor').crew;
const COPY = PACK.copy;
const value = (over) => validateCrew(crewAnswer(over), { sectorId: SECTOR }).value;
const staleMembers = sampleMembers().map((m) => (m.match === 'unavailable' ? m : { rank: m.rank, family: m.family, given: m.given, match: 'stale', count: null, asOfRecorded: 3 }));
const progress = { total: 50, indexed: 38, pending: 6, stale: 2, uncovered: 4, at: T0 };
const panel = (over) => ({ enabled: false, capability: null, enrolled: false, hasRecord: false, pending: null, running: false, progress: null, cleanup: null, phase: 'idle', message: null, ...over });

const DETAIL = {
  complete: { kind: 'crew', value: value() },
  incomplete: { kind: 'crew', value: value({ state: 'incomplete', reasons: ['missing-records'] }) },
  stale: { kind: 'crew', value: value({ state: 'stale', reasons: ['stale-history'], members: staleMembers }) },
  indexing: { kind: 'crew', value: value({ state: 'incomplete', reasons: ['missing-records'] }), indexing: { indexed: 18, total: 50 } },
  'not-listed': { kind: 'crew', value: validateCrew(unlistedAnswer(), { sectorId: SECTOR }).value },
  loading: { kind: 'loading' },
  'not-enrolled': { kind: 'not-enrolled' },
  error: { kind: 'error' },
  offline: { kind: 'offline' },
  limit: { kind: 'limit' },
  suspended: { kind: 'suspended' },
  storage: { kind: 'storage' },
  'not-found': { kind: 'not-found' },
  pending: { kind: 'pending' },
  'pending-elsewhere': { kind: 'pending-elsewhere' },
  revoked: { kind: 'revoked' },
};
const SETTINGS = {
  off: panel(),
  'opt-in': panel({ phase: 'opt-in' }),
  checking: panel({ enabled: true, capability: 'checking' }),
  unsupported: panel({ enabled: true, capability: 'unsupported' }),
  'not-set-up': panel({ enabled: true, capability: 'supported' }),
  'enroll-error': panel({ enabled: true, capability: 'supported', message: { tone: 'error', text: COPY.enrollError.unauthorized } }),
  enrolling: panel({ enabled: true, capability: 'supported', phase: 'enrolling' }),
  on: panel({ enabled: true, capability: 'supported', enrolled: true, hasRecord: true, progress, message: { tone: 'ok', text: COPY.enrolled } }),
  'on-checking': panel({ enabled: true, capability: 'supported', enrolled: true, hasRecord: true, progress, running: true }),
  'confirm-forget': panel({ enabled: true, capability: 'supported', enrolled: true, hasRecord: true, phase: 'confirm-forget' }),
  deleting: panel({ enabled: true, phase: 'deleting' }),
  deleted: panel({ message: { tone: 'ok', text: COPY.deleted } }),
  pending: panel({ pending: { unresolved: 1, endpoints: ['x'] } }),
  'pending-unresolved': panel({ pending: { unresolved: 1, endpoints: ['x'] }, message: { pendingCode: 'unresolved-enrollment' } }),
  'pending-elsewhere': panel({ pending: { unresolved: 1, endpoints: ['x'] }, message: { pendingCode: 'revoke-pending-elsewhere' } }),
  'cleanup-pending': panel({ cleanup: 'pending' }),
  'cleanup-incomplete': panel({ cleanup: 'incomplete' }),
};

function page(kind, name, theme) {
  const body = kind === 'detail'
    ? `<article class="fl-detail-card" aria-labelledby="t"><header class="fl-detail-head"><p class="t-eyebrow">Tue 3 Nov · Flight 1 of 2 in this rotation</p>
       <h2 class="t-title-2" id="t">FRA → PMI</h2><p class="t-callout"><span class="t-code">XQ1234</span></p></header>
       <section class="fl-section" aria-labelledby="ops"><p class="t-eyebrow" id="ops">Gates &amp; terminals</p><p class="t-callout t-secondary">Synthetic placeholder</p></section>
       ${crewSectionView(DETAIL[name], PACK)}
       <section class="fl-section" aria-labelledby="rot"><p class="t-eyebrow" id="rot">Rotation · day 1 of 1</p></section></article>`
    : `<div class="settings"><section class="setting-block" aria-labelledby="set-crew"><div class="section-head"><h2 class="t-eyebrow" id="set-crew">${COPY.settingsTitle}</h2></div>
       <div class="list crew-panel" data-crew-panel>${crewPanelView(SETTINGS[name], COPY)}</div></section></div>`;
  return `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Crew states (synthetic)</title>${['tokens', 'base', 'shell', 'components', 'screens'].map((f) => `<link rel="stylesheet" href="/assets/css/${f}.css">`).join('')}
    <style>.app{grid-template-columns:minmax(0,1fr)} .page{animation:none}</style></head>
    <body><div class="app"><main class="main"><div class="page">${body}</div></main></div></body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    const kind = url.searchParams.get('kind') === 'settings' ? 'settings' : 'detail';
    const name = url.searchParams.get('state');
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    if (!(kind === 'detail' ? DETAIL : SETTINGS)[name]) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page(kind, name, theme));
    return;
  }
  if (!/^\/assets\/css\/[a-z-]+\.css$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'text/css');
  res.end(readFileSync(join(root, url.pathname), 'utf8'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
const lines = ['# Crew Intelligence — synthetic state screenshots', '', 'Synthetic data only. Rank codes are shown raw (no verified mapping, D7 pending).', '',
  '| File | Screen | State | Theme | Width | Layout checks |', '|---|---|---|---|---|---|'];
let failures = 0;
for (const [kind, states] of [['detail', DETAIL], ['settings', SETTINGS]]) {
  for (const name of Object.keys(states)) {
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 390, 430]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
        const tab = await context.newPage();
        await tab.goto(`${base}/?kind=${kind}&state=${name}&theme=${theme}`);
        const checks = await tab.evaluate(() => {
          const out = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) out.push('horizontal overflow');
          const row = document.querySelector('.crew-switch-row');
          if (row) {
            const sw = row.querySelector('.switch').getBoundingClientRect();
            const title = row.querySelector('.list-label').getBoundingClientRect();
            if (sw.top >= title.bottom) out.push('switch wrapped below the title');
          }
          for (const el of document.querySelectorAll('.crew .btn, .crew-panel .btn')) {
            const r = el.getBoundingClientRect();
            if (r.height < 44) out.push(`tap target ${Math.round(r.height)}px: ${el.textContent.trim()}`);
          }
          return out;
        });
        failures += checks.length;
        const file = `${kind}-${name}-${theme}-${width}.png`;
        await tab.screenshot({ path: join(OUT, file), fullPage: true });
        lines.push(`| ${file} | ${kind === 'detail' ? 'Flight Details' : 'Settings'} | ${name} | ${theme} | ${width} | ${checks.length ? checks.join('; ') : 'ok'} |`);
        await context.close();
      }
    }
  }
}
await browser.close();
server.close();
writeFileSync(join(OUT, 'index.md'), `${lines.join('\n')}\n`);
console.log(`Crew screenshots: ${lines.length - 6} files in ${OUT}; layout failures: ${failures}`);
if (failures) process.exitCode = 1;
