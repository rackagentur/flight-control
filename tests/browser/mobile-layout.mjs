// Local, network-free layout regression page. Run: node tests/browser/mobile-layout.mjs
// Open the printed URL at 320/375/390 px and desktop widths, light/dark, scale 1/1.25/2.
// The page measures the REAL rendered component, not CSS source strings. safe=50 substitutes
// only CSS env(safe-area-inset-top) for a deterministic inset; it is not an iOS emulator.
// No app bootstrap, service worker, storage, credentials or external requests are used.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flightOpsView } from '../../src/ui/flight-ops.js';
import { adaptFlightInfo } from '../../src/sources/flight-info-v2.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const now = Date.UTC(2026, 9, 20, 7);
const sector = { origin: 'FRA', destination: 'BKK', dep: now + 3600000, arr: now + 12 * 3600000,
  originTz: 'Europe/Berlin', destTz: 'Asia/Bangkok' };
function markup(mode) {
  const missing = mode === 'missing', long = mode === 'long';
  const leg = (airport, scheduled, gate, terminal, quality) => ({ airport, scheduled, revised: null,
    runway: null, gate: missing ? null : gate, terminal: missing ? null : terminal, desk: null, belt: null, quality });
  const wire = { ok: true, contract: 'fc.roster', version: 2, action: 'flight', provider: 'synthetic',
    generatedAt: now, fetchedAt: now, query: { flightNumber: 'DE9201', date: '2026-10-20', origin: 'FRA' }, found: true,
    flight: { id: 'g_0123456789abcdef', flightNumber: 'DE9201', status: 'delayed', lastUpdated: now,
      departure: { ...leg('FRA', sector.dep, long ? 'A12345678901234567890' : 'A 24', '1', ['basic', 'live']), revised: missing ? null : sector.dep + 1200000 },
      arrival: leg('BKK', sector.arr, '12', long ? 'ABCDEFGHIJKLMN' : 'B', ['basic']), provenance: 'provider' },
    attribution: { name: 'AeroDataBox', url: 'https://aerodatabox.com/' } };
  const info = { ...adaptFlightInfo(wire, { now }), stale: mode === 'stale' };
  return String(flightOpsView({ status: 'ready', info, refresh: { busy: false, cooling: false } }, sector, { profile: { homeTz: 'Europe/Berlin' } }));
}
const script = `
function check() {
  const results = [], assert = (name, pass) => results.push({name, pass});
  const rect = el => el.getBoundingClientRect();
  assert('document fits viewport', document.documentElement.scrollWidth <= innerWidth + 1);
  for (const leg of document.querySelectorAll('.fo-leg')) {
    const box = rect(leg), css = getComputedStyle(leg);
    const left = box.left + parseFloat(css.paddingLeft), right = box.right - parseFloat(css.paddingRight);
    const walker = document.createTreeWalker(leg, NodeFilter.SHOW_TEXT);
    let node, fits = true;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.left < left - 1 || r.right > right + 1) fits = false;
    }
    assert(leg.dataset.leg + ' text stays in its column', fits);
    for (const row of leg.querySelectorAll('.fo-time')) {
      const label = rect(row.querySelector('dt')), value = rect(row.querySelector('dd'));
      assert(leg.dataset.leg + ' time does not overlap label', value.left >= label.right - 1 || value.top >= label.bottom - 1);
    }
  }
  const card = rect(document.querySelector('.fl-detail-card'));
  for (const el of document.querySelectorAll('.fo-foot > *, .attr')) {
    const r = rect(el); assert('footer content stays in card', r.left >= card.left && r.right <= card.right);
  }
  const inset = Number(new URLSearchParams(location.search).get('safe') || 0);
  const status = rect(document.querySelector('.sync-status'));
  assert('initial status clears top inset', status.top + scrollY >= inset);
  const cover = getComputedStyle(document.body, '::after');
  assert('scrolling has a non-interactive opaque top inset cover', !inset ||
    (cover.position === 'fixed' && parseFloat(cover.top) === 0 && parseFloat(cover.height) >= inset &&
     cover.pointerEvents === 'none' && cover.backgroundColor !== 'rgba(0, 0, 0, 0)' && Number(cover.zIndex) > 0));
  document.querySelector('#results').textContent = JSON.stringify({width: innerWidth, results, passed: results.every(r => r.pass)}, null, 2);
}
document.querySelector('#check').onclick = check;
document.querySelector('#scroll').onclick = () => { scrollTo(0, document.querySelector('.sync-status').offsetTop); check(); };
addEventListener('load', check); addEventListener('resize', check);
`;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const safe = ['0', '50'].includes(url.searchParams.get('safe')) ? url.searchParams.get('safe') : '0';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'");
  if (url.pathname === '/') {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const scale = ['1', '1.25', '2'].includes(url.searchParams.get('scale')) ? url.searchParams.get('scale') : '1';
    const mode = ['gates', 'missing', 'long', 'stale'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'gates';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
      <title>Flight Control — synthetic mobile layout regression</title>
      ${['tokens','base','shell','components','screens'].map(f => `<link rel="stylesheet" href="/assets/css/${f}.css?safe=${safe}">`).join('')}
      <style>html {font-size:${16 * Number(scale)}px} .app {grid-template-columns:minmax(0,1fr)} .page {max-width:400px;animation:none} #test-tools {margin-top:60vh} #results {white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}</style></head>
      <body><div class="app"><main class="main"><p class="sync-status t-caption">Roster synchronized · Last sync 2026-10-20 09:00 (Europe/Berlin) · Available offline</p>
      <div class="page"><article class="fl-detail-card"><header class="fl-detail-head"><p class="t-eyebrow">Synthetic flight · DE9201</p><h1 class="t-title-2">Frankfurt → Bangkok</h1></header>${markup(mode)}</article>
      <section id="test-tools"><p>Local regression fixture · simulated top inset ${safe}px · ${theme} · text scale ${scale}</p><button id="check">Check layout</button><button id="scroll">Scroll content behind inset</button><pre id="results"></pre></section></div></main></div>
      <script>${script}</script></body></html>`);
    return;
  }
  if (!/^\/assets\/css\/[a-z-]+\.css$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  try {
    const file = resolve(root, '.' + url.pathname);
    res.setHeader('Content-Type', extname(file) === '.css' ? 'text/css' : 'text/plain');
    // Emulate only the environment value, leaving every application rule unchanged.
    res.end(readFileSync(file, 'utf8').replace(/env\(safe-area-inset-top(?:,\s*0px)?\)/g, `${safe}px`));
  } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.FC_LAYOUT_PORT || 8089), '127.0.0.1', () => console.log(`Layout regression: http://127.0.0.1:${server.address().port}/?safe=50&theme=light&mode=gates`));
