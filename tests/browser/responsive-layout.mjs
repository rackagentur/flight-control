// Network-free full Flight Detail regression page. Run with Node; open the printed URL.
// The matrix uses 375/393 CSS-pixel frames, 100/125/200% text, both themes and Local/UTC.
// Real screen/model rendering; no app boot, credentials, service worker or provider calls.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGs, fakeEnv } from '../gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from '../fixtures/condor-feed.synthetic.mjs';
import { adaptV2 } from '../../src/sources/fc-appscript-v2.js';
import { PROFILE, pipeline } from '../helpers.js';
import { flights } from '../../src/ui/screens/flights.js';
import { destinationView } from '../../src/ui/destination.js';
import { applyTimeDisplay } from '../../src/time-display.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gs = loadGs(), feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const wire = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'roster', token: 'test-token-0123456789abcdef' }), env)));
const snapshot = adaptV2(wire, { profile: PROFILE, fetchedAt: NOW });
function markup(mode) {
  applyTimeDisplay(mode);
  const view = { ...pipeline(snapshot, new Date(NOW).toISOString()), snapshot, profile: PROFILE, review: false, loading: false };
  const selected = snapshot.sectors.find((s) => s.origin === 'FRA' && s.destination === 'BKK');
  const screen = String(flights.render({ view: () => view, param: () => selected.id,
    weather: () => ({ status: 'unavailable', reason: 'review' }) }));
  // Also test a long unbroken hotel name/address without changing the normal synthetic fixture.
  const hotel = String(destinationView({ iata: 'BKK', city: 'Bangkok', tz: null,
    hotel: { record: { name: 'SyntheticHotel'.repeat(8), address: 'SyntheticAddress'.repeat(8), phone: '+66 2 000 0000' } } }, null, { now: NOW }));
  return screen + `<section class="fl-detail-card" id="long-hotel">${hotel}</section>`;
}

function browserCheck() {
  const results = [], check = (name, pass) => results.push({ name, pass });
  const overlap = (a, b) => a.left < b.right - .5 && a.right > b.left + .5 && a.top < b.bottom - .5 && a.bottom > b.top + .5;
  const textBoxes = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), boxes = [];
    let node;
    while ((node = walker.nextNode())) if (node.textContent.trim()) {
      const range = document.createRange(); range.selectNodeContents(node); boxes.push(...range.getClientRects());
    }
    return boxes;
  };
  for (const [i, row] of [...document.querySelectorAll('.ms-row')].entries()) {
    const box = row.getBoundingClientRect();
    const parts = [...row.querySelectorAll('.ms-time,.ms-label,.ms-rel,.ms-note')].map(textBoxes);
    check(`timing ${i}: all text inside row`, parts.flat().every((r) => r.left >= box.left - 1 && r.right <= box.right + 1));
    check(`timing ${i}: no text collisions`, parts.every((a, j) => parts.slice(j + 1).every((b) => a.every((x) => b.every((y) => !overlap(x, y))))));
  }
  for (const [i, row] of [...document.querySelectorAll('.hz-times,.hz-labels')].entries()) {
    const bounds = row.getBoundingClientRect();
    if (!bounds.width) continue;
    const visible = [...row.children].filter((el) => getComputedStyle(el).visibility !== 'hidden');
    const boxes = visible.map((el) => el.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    check(`timeline ${i}: labels stay within container`, boxes.every((b) => b.left >= bounds.left - 1 && b.right <= bounds.right + 1));
    check(`timeline ${i}: 8px label clearance`, boxes.every((b, j) => !j || b.left - boxes[j - 1].right >= 7.5));
    check(`timeline ${i}: text height contained`, boxes.every((b) => b.bottom <= bounds.bottom + 1));
    const chip = row.parentElement.querySelector('.tz-mode');
    if (chip && getComputedStyle(chip).display !== 'none') check(`timeline ${i}: UTC badge clear of labels`, boxes.every((b) => !overlap(b, chip.getBoundingClientRect())));
    if (row.classList.contains('hz-times')) check(`timeline ${i}: next milestone retained`, !row.querySelector('.is-next') || getComputedStyle(row.querySelector('.is-next')).visibility === 'visible');
  }
  for (const [i, address] of [...document.querySelectorAll('.dest-hotel-address')].entries()) {
    const name = address.parentElement.querySelector('.dest-hotel-name'), value = address.closest('.dest-value');
    check(`hotel ${i}: address below name`, address.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1);
    const box = value.getBoundingClientRect();
    check(`hotel ${i}: long text wraps`, textBoxes(value).every((r) => r.left >= box.left - 1 && r.right <= box.right + 1));
  }
  check('fixture includes timing and hotel', document.querySelectorAll('.ms-row').length >= 2 && document.querySelectorAll('.dest-hotel-address').length === 2);
  const result = { width: innerWidth, scale: document.documentElement.dataset.scale, theme: document.documentElement.dataset.theme,
    mode: document.documentElement.dataset.timeDisplay, passed: results.every((r) => r.pass), results };
  document.querySelector('#results').textContent = JSON.stringify(result);
  if (parent !== window) parent.postMessage({ kind: 'layout-result', key: location.search, result }, location.origin);
}
const cases = [];
for (const width of [375, 393]) for (const scale of [1, 1.25, 2]) for (const theme of ['light', 'dark']) for (const mode of ['local', 'utc']) cases.push({ width, scale, theme, mode });
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'none'; img-src 'self'; font-src 'self'; base-uri 'none'");
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<h1>Full Flight Detail layout checks</h1><pre id="summary">Running 24 cases…</pre><script>
      const results = new Map(); addEventListener('message', e => { if(e.origin !== location.origin || e.data?.kind !== 'layout-result') return;
      results.set(e.data.key,e.data.result); const all = [...results.values()]; document.querySelector('#summary').textContent = JSON.stringify({complete:all.length===24,cases:all.length,passed:all.every(r=>r.passed),assertions:all.reduce((n,r)=>n+r.results.length,0),failures:all.filter(r=>!r.passed)},null,2); });</script>
      ${cases.map((c) => `<iframe title="${JSON.stringify(c).replaceAll('"', '')}" width="${c.width}" height="1100" src="/case?${new URLSearchParams(c)}"></iframe>`).join('')}`); return;
  }
  if (url.pathname === '/case') {
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const scale = [1,1.25,2].includes(Number(url.searchParams.get('scale'))) ? Number(url.searchParams.get('scale')) : 1;
    const mode = url.searchParams.get('mode') === 'utc' ? 'utc' : 'local';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html data-theme="${theme}" data-time-display="${mode}" data-scale="${scale}" style="font-size:${scale*100}%"><meta name="viewport" content="width=device-width, initial-scale=1">
      ${['tokens','base','components','shell','screens'].map((f) => `<link rel="stylesheet" href="/assets/css/${f}.css">`).join('')}
      <body><main class="main">${markup(mode)}<pre id="results"></pre></main><script type="module">
      import {mountHorizonLabels} from '/src/ui/horizon.js'; mountHorizonLabels(document);
      const check = ${browserCheck.toString()};
      await document.fonts.ready; requestAnimationFrame(()=>requestAnimationFrame(check));
      addEventListener('resize',()=>requestAnimationFrame(()=>requestAnimationFrame(check)));
      </script></body></html>`); return;
  }
  if (!/^\/(?:src\/.*\.js|assets\/css\/[a-z-]+\.css)$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try { res.setHeader('Content-Type', extname(file) === '.css' ? 'text/css' : 'text/javascript'); res.end(readFileSync(file)); }
  catch { res.writeHead(404); res.end(); }
});
server.listen(8094, '127.0.0.1', () => console.log('Local synthetic layout matrix: http://127.0.0.1:8094/'));
