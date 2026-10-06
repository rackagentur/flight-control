// Calendar rotation aircraft: ONE per rotation, on its first day only (the start or single cell).
// The month calendar does not show how many sectors a day or a rotation has. Nothing on middle, end,
// layover, off, standby or reserve cells; nothing on later rows or in later months; nothing when the
// rotation's first day is not in the data (open start). The OFF / FREE / ORT / SB / RE / LEAVE markers
// are pinned here too. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleSnapshot, sampleProfile } from '../src/sources/sample.js';
import { calendar, resetCalendarUi } from '../src/ui/screens/calendar.js';
import { startOfLocalDay } from '../src/lib/time.js';
import { icon } from '../src/ui/icons.js';
import { PROFILE, pipeline } from './helpers.js';

const SP = sampleProfile(PROFILE);
const TZ = SP.homeTz;
const NOW = '2026-10-06T08:00:00Z';
const H = 3600000;
const M = 60000;
const TZS = { HOME: TZ, EAST: 'Europe/Athens', WEST: 'America/New_York', SOUTH: 'Europe/Lisbon' };

let seq = 0;
/** A sector leaving `origin` at hh:mm local home time on `date`. */
function sec(origin, destination, date, hh, mm, block) {
  seq += 1;
  const dep = startOfLocalDay(date, TZ) + hh * H + mm * M;
  return { id: `t-${seq}`, flightNumber: `TEST ${seq}`, origin, destination, dep, arr: dep + block * M, blockMin: block, originTz: TZS[origin], destTz: TZS[destination], pickup: null, provenance: 'source', legacy: null };
}
const off = (date, label, extra = {}) => ({ kind: 'off', start: startOfLocalDay(date, TZ), end: startOfLocalDay(`${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, '0')}`, TZ), label, ...extra });
const timed = (kind, date, label) => ({ ...off(date, label), kind });

/** One month of October / early November 2026 with every case the rule has to tell apart. */
function scenario() {
  const sectors = [
    // Oct 5: a day trip of 4 sectors (single day); Oct 7: a day trip of 2 sectors (single day).
    sec('HOME', 'EAST', '2026-10-05', 6, 10, 155), sec('EAST', 'HOME', '2026-10-05', 9, 35, 165),
    sec('HOME', 'SOUTH', '2026-10-05', 13, 5, 140), sec('SOUTH', 'HOME', '2026-10-05', 16, 10, 135),
    sec('HOME', 'EAST', '2026-10-07', 6, 30, 150), sec('EAST', 'HOME', '2026-10-07', 9, 50, 160),
    // Oct 12-14: one sector out, a layover day, one sector back.
    sec('HOME', 'WEST', '2026-10-12', 10, 0, 520), sec('WEST', 'HOME', '2026-10-14', 8, 0, 460),
    // Oct 15-19: three sectors on the first day, three layover days, back on Monday (the next week row).
    sec('HOME', 'EAST', '2026-10-15', 6, 0, 150), sec('EAST', 'SOUTH', '2026-10-15', 9, 30, 180), sec('SOUTH', 'EAST', '2026-10-15', 13, 0, 180),
    sec('EAST', 'HOME', '2026-10-19', 8, 0, 190),
    // Oct 22-24: its first day is not in the data (it starts away from base).
    sec('EAST', 'SOUTH', '2026-10-22', 8, 0, 180), sec('SOUTH', 'HOME', '2026-10-24', 8, 0, 190),
    // Oct 30 - Nov 2: crosses the month boundary, overnight sector out.
    sec('HOME', 'WEST', '2026-10-30', 22, 0, 600), sec('WEST', 'HOME', '2026-11-02', 13, 0, 460),
    // Sep 24 - 30: started in the previous month; October's first visible days (Sep 28-30) are its middle and end.
    sec('HOME', 'WEST', '2026-09-24', 9, 0, 520), sec('WEST', 'HOME', '2026-09-30', 9, 0, 460),
    // Back to back: day trips on consecutive days (Nov 23, 24); a two-day rotation A (Nov 25-26) then a day trip B (Nov 27).
    sec('HOME', 'EAST', '2026-11-23', 6, 0, 150), sec('EAST', 'HOME', '2026-11-23', 9, 30, 160),
    sec('HOME', 'SOUTH', '2026-11-24', 6, 0, 150), sec('SOUTH', 'HOME', '2026-11-24', 9, 30, 160),
    sec('HOME', 'EAST', '2026-11-25', 7, 0, 150), sec('EAST', 'HOME', '2026-11-26', 9, 0, 190),
    sec('HOME', 'SOUTH', '2026-11-27', 7, 0, 150), sec('SOUTH', 'HOME', '2026-11-27', 10, 30, 150),
    // Same day: A ends on Nov 14 (back at 06:40) and B departs the same day (15:00).
    sec('HOME', 'EAST', '2026-11-13', 6, 0, 150), sec('EAST', 'HOME', '2026-11-14', 3, 30, 190),
    sec('HOME', 'SOUTH', '2026-11-14', 15, 0, 150), sec('SOUTH', 'HOME', '2026-11-14', 18, 30, 150),
  ].sort((a, b) => a.dep - b.dep);
  const windows = [
    timed('standby', '2026-10-01', 'SB'), timed('reserve', '2026-10-02', 'RE'),
    off('2026-10-03', 'OFF'), off('2026-10-04', 'ORT', { subtype: 'ort', protected: true }),
    off('2026-10-26', 'FREE', { subtype: 'free' }), off('2026-10-27', 'LEAVE', { subtype: 'leave' }),
  ];
  const base = sampleSnapshot('off', 'ocean', Date.parse(NOW), SP);
  return { ...base, sectors, windows, offBlocks: [], coverageStart: startOfLocalDay('2026-09-20', TZ), flightCoverageEnd: '2026-11-30', offCoverageEnd: '2026-11-30', warnings: [] };
}

function render(snapshot, monthKey) {
  const view = { ...pipeline(snapshot, NOW, SP), snapshot, profile: SP, review: true, loading: false, error: null };
  resetCalendarUi(monthKey, null);
  return calendar.render({ view: () => view }).toString();
}

/** date -> cell markup, for every day cell in the grid. */
function cells(markup) {
  const out = new Map();
  for (const m of markup.matchAll(/<button[^>]*data-date="(\d{4}-\d\d-\d\d)"[\s\S]*?<\/button>/g)) out.set(m[1], m[0]);
  return out;
}
const planes = (cell) => (cell.match(/<span class="cal-glyph /g) ?? []).length;
const planesOf = (grid) => Object.fromEntries([...grid].filter(([, c]) => planes(c)).map(([d, c]) => [d, planes(c)]));

test('the aircraft icon is a filled top-down path in the icon set (no emoji, no text, no external asset)', () => {
  const svg = icon('aircraft').toString();
  assert.match(svg, /^<svg viewBox="0 0 24 24"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /<path [^>]*fill="currentColor"[^>]*d="M12 3c/);
  assert.match(svg, /rotate\(90\)/, 'the top-down shape of the flights icon, turned to point right');
  assert.ok(!/<text|<image|<use|https?:/.test(svg));
  assert.ok(!/[☀-➿\u{1F300}-\u{1FAFF}]/u.test(svg), 'no emoji or dingbat such as the airplane character');
});

test('exactly one aircraft per rotation, on its start or single cell, whatever the sector count', () => {
  const grid = cells(render(scenario(), '2026-10'));
  // 4 sectors (single), 2 sectors (single), 1 sector (start), 3 sectors (start): one each.
  assert.equal(planes(grid.get('2026-10-05')), 1);
  assert.equal(planes(grid.get('2026-10-07')), 1);
  assert.equal(planes(grid.get('2026-10-12')), 1);
  assert.equal(planes(grid.get('2026-10-15')), 1);
  assert.match(grid.get('2026-10-05'), /pos-single/);
  assert.match(grid.get('2026-10-12'), /pos-start/);
  // And nowhere else in the whole grid: the open-start rotation (22-24) has none, the Oct 30 start has one.
  assert.deepEqual(planesOf(grid), { '2026-10-05': 1, '2026-10-07': 1, '2026-10-12': 1, '2026-10-15': 1, '2026-10-30': 1 });
});

test('no aircraft on middle, end, layover, off, standby or reserve cells, nor on later rows of the same rotation', () => {
  const grid = cells(render(scenario(), '2026-10'));
  for (const date of ['2026-10-13', '2026-10-14', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-23', '2026-10-24', '2026-10-31']) {
    assert.equal(planes(grid.get(date)), 0, date);
  }
  assert.match(grid.get('2026-10-13'), /kind-layover/);
  assert.match(grid.get('2026-10-14'), /pos-end/);
  assert.match(grid.get('2026-10-19'), /pos-end/, 'the rotation ends on the next week row');
  assert.match(grid.get('2026-10-17'), /pos-middle/);
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-26', '2026-10-27']) {
    assert.equal(planes(grid.get(date)), 0, date);
    assert.ok(!/cal-band/.test(grid.get(date)), `${date} has no journey line`);
  }
});

test('open start: a rotation whose first day is not in the data gets no aircraft', () => {
  const grid = cells(render(scenario(), '2026-10'));
  assert.match(grid.get('2026-10-22'), /cal-band pos-start[^"]*open-start/);
  assert.equal(planes(grid.get('2026-10-22')), 0);
});

test('month boundary: the aircraft belongs to the start day, shown once in either month view', () => {
  const oct = cells(render(scenario(), '2026-10'));
  const nov = cells(render(scenario(), '2026-11'));
  assert.equal(planes(oct.get('2026-10-30')), 1);
  assert.equal(planes(oct.get('2026-10-31')), 0);
  assert.equal(planes(nov.get('2026-10-30')), 1, 'the Oct start day is an outside cell of the November grid');
  assert.match(nov.get('2026-10-30'), /is-outside/);
  assert.equal(planes(nov.get('2026-11-01')), 0);
  assert.equal(planes(nov.get('2026-11-02')), 0, 'the return day has no aircraft');
  assert.deepEqual(planesOf(nov), { '2026-10-30': 1, '2026-11-13': 1, '2026-11-23': 1, '2026-11-24': 1, '2026-11-25': 1, '2026-11-27': 1 });
});

test('the calendar never shows a sector count: no count element, no multiplication sign, no per-sector markup', () => {
  for (const month of ['2026-10', '2026-11']) {
    const markup = render(scenario(), month);
    assert.ok(!/cal-glyph-count|data-glyphs|cal-glyph-row|×/.test(markup), month);
  }
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  assert.ok(!/glyph-count|glyph-row|data-glyphs|@container|--k\b|--n\b|nth-child\(\d\) \{ --i/.test(css), 'no capacity or count rules left behind');
});

test('the aircraft is decorative, a sibling after the band (so fade masks never dim it), and the anchors stay', () => {
  const grid = cells(render(scenario(), '2026-10'));
  for (const date of ['2026-10-05', '2026-10-12']) {
    const cell = grid.get(date);
    assert.match(cell, /<span class="cal-band [^"]*"><\/span><span class="cal-glyph pos-(start|single)" aria-hidden="true"><svg [^>]*>[\s\S]*?<\/svg><svg [^>]*>[\s\S]*?<\/svg><\/span>/);
  }
});

test('markers OFF / FREE / ORT / SB / RE / LEAVE render exactly as before', () => {
  const grid = cells(render(scenario(), '2026-10'));
  const code = (date) => grid.get(date).match(/<span class="(cal-code[^"]*)" aria-hidden="true">([^<]*)<\/span>/).slice(1, 3);
  assert.deepEqual(code('2026-10-01'), ['cal-code tok-sb', 'SB']);
  assert.deepEqual(code('2026-10-02'), ['cal-code tok-re', 'RE']);
  assert.deepEqual(code('2026-10-03'), ['cal-code tok-off', 'OFF']);
  assert.deepEqual(code('2026-10-04'), ['cal-code tok-off tok-ort', 'ORT']);
  assert.deepEqual(code('2026-10-26'), ['cal-code tok-off', 'FREE']);
  assert.deepEqual(code('2026-10-27'), ['cal-code tok-off tok-leave', 'LEAVE']);
  for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-26', '2026-10-27']) {
    assert.match(grid.get(date), /<span class="cal-track" aria-hidden="true"><span class="cal-mark"><\/span><\/span>/, date);
  }
});

test('the aircraft is the start marker: no start ring anywhere; the 8px ring marks only the end; the line stops under it', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  // No ring on a start cell (or on the start end of a day trip): only ::after rings remain, on end and single bands.
  assert.ok(!/pos-start::before|pos-single::before|\.cal-band\.open-start::before/.test(css), 'no start ring rules');
  assert.match(css, /\.cal-band\.pos-end::after, \.cal-band\.pos-single::after \{\n  content: ""; position: absolute; top: -1\.5px; width: 8px; height: 8px; border-radius: 50%;\n  background: var\(--canvas\); box-shadow: inset 0 0 0 2px var\(--journey\);\n  right: 0;\n\}/);
  assert.ok(!/width: 12px; height: 12px/.test(css.slice(css.indexOf('.cal-band {'), css.indexOf('Aircraft: ONE'))), 'no 12px rings left');
  // The line trims 4px (the ring's radius) at its ring end, so nothing pokes out past the ring.
  assert.match(css, /\.cal-band\.kind-flight\.pos-end:not\(\.open-end\), \.cal-band\.kind-flight\.pos-single:not\(\.open-end\) \{ background: linear-gradient\(90deg, var\(--journey\) calc\(100% - 4px\), transparent calc\(100% - 4px\)\); \}/);
  // Band positions (BASE rules at column 0; the min-width: 1200px block repeats them indented).
  assert.match(css, /^\.cal-band\.pos-start \{ left: 50%; \}$/m, 'a start line begins at the aircraft centre (the cell centre)');
  assert.match(css, /^\.cal-band\.pos-end \{ right: calc\(50% - 5px\); \}$/m);
  assert.match(css, /^\.cal-band\.pos-single \{ left: calc\(2px \+ var\(--glyph\) \* 0\.4\); right: 0\.5px; \}/m, 'a day trip: aircraft centre to the ring');
  assert.match(css, /\n  \.cal-band \{ left: -2px; right: -2px; \}\n  \.cal-band\.pos-single \{ left: calc\(2px \+ var\(--glyph\) \* 0\.4\); right: -0\.5px; \}\n  \.cal-band\.pos-start \{ left: 50%; \}\n  \.cal-band\.pos-end \{ right: calc\(50% - 5px\); \}/);
  // The line itself: thickness, colour, layover dotting and double rail, fades, extents (unchanged from the baseline).
  assert.match(css, /\.cal-band \{ position: absolute; top: 3\.5px; left: -1px; right: -1px; height: 5px; background: var\(--journey\); \}/);
  assert.match(css, /\.cal-band\.kind-layover\.is-confirmed \{ top: 3px; height: 7px; background: linear-gradient\(var\(--layover-tone\) 0 2px, transparent 2px 5px, var\(--layover-tone\) 5px 7px\); \}/);
  assert.match(css, /\.cal-band\.kind-layover\.is-inferred \{ background: repeating-linear-gradient\(90deg, var\(--layover-tone\) 0 4px, transparent 4px 8px\); \}/);
  assert.match(css, /mask-image: linear-gradient\(90deg, transparent, #000 60%\)/);
  assert.match(css, /mask-image: linear-gradient\(90deg, #000 40%, transparent\)/);
  assert.ok(!/--node|has-glyphs/.test(css));
});

test('back-to-back rotations stay apart: a ring and the next day\'s aircraft keep at least 4px (ring inset + cell gap + aircraft margin)', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  const ringInset = 0.5;     // .cal-band.pos-single right: 0.5px (end bands: ring at the cell centre, far from the next cell)
  const margin = 2;          // .cal-glyph.pos-single ink starts 2px from the cell edge
  assert.match(css, /\.cal-glyph\.pos-single \{ left: calc\(2px - var\(--gs\) \* 0\.1\); \}/);
  assert.ok(ringInset + 2 + margin >= 4, 'cell gap is 2px below 1200px (4px above)');
});

test('stylesheet: the aircraft is dimmed outside the month, static, sized by screen and placed by day type', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  assert.match(css, /\.cal-day\.is-outside \.cal-glyph svg:last-child \{ color: color-mix\(in oklab, var\(--journey\) 55%, var\(--canvas\)\); \}/, 'dimmed like the line (opacity .55), but opaque: no darker overlap with the line');
  const block = css.slice(css.indexOf('/* Aircraft: ONE per rotation'), css.indexOf('.cal-day.is-outside .cal-glyph svg:last-child'));
  assert.ok(block.length > 200 && !/animation|transition|@keyframes/.test(block), 'static');
  assert.ok(!/z-index/.test(block), 'no stacking changes: the focus and selected rings keep their paint order');
  assert.ok(!/container-type|@container|cqw|wrap-out/.test(css.slice(css.indexOf('/* Aircraft:'))) , 'the aircraft stays inside its own cell: no cross-cell sizing left');
  assert.match(block, /\.cal-glyph\.pos-start \{ --gs: var\(--glyph-start\); left: 50%; transform: translate\(-50%, -50%\); \}/, 'start day: centred on the cell');
  assert.match(block, /\.cal-glyph\.pos-single \{ left: calc\(2px - var\(--gs\) \* 0\.1\); \}/, 'day trip: ink 2px from the cell edge');
  // Pin EVERY declaration that sets an aircraft size, in file order, so an appended override fails.
  const sizes = [...css.matchAll(/(--glyph-start|--glyph|--gs)\s*:\s*([^;}]+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
  assert.deepEqual(sizes, [
    '--glyph: 23px', '--glyph-start: 26px',
    '--glyph: 21px', '--glyph-start: 24px',
    '--glyph: 25px', '--glyph-start: 26.4px',
    '--gs: var(--glyph)',
    '--gs: var(--glyph-start)',
  ]);
});

test('the aircraft: journey colour, a halo masked out of the line band, points right, two svgs per glyph', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8');
  assert.match(css, /\.cal-glyph svg, \.cal-key-plane svg \{[^}]*color: var\(--journey\);/, 'journey blue');
  assert.match(css, /\.cal-glyph svg:first-child, \.cal-key-plane svg:first-child \{ color: var\(--canvas\); -webkit-mask-image: linear-gradient\(to bottom, #000 calc\(50% - 2\.5px\), transparent calc\(50% - 2\.5px\) calc\(50% \+ 2\.5px\), #000 calc\(50% \+ 2\.5px\)\); mask-image: linear-gradient\(to bottom, #000 calc\(50% - 2\.5px\), transparent calc\(50% - 2\.5px\) calc\(50% \+ 2\.5px\), #000 calc\(50% \+ 2\.5px\)\); \}/, 'canvas halo, hidden inside the 5px line band');
  assert.ok(!/paint-order/.test(css), 'no stroke halo on the body path (it would cut the line)');
  const body = icon('aircraft').toString();
  const halo = icon('aircraftHalo').toString();
  for (const svg of [body, halo]) {
    assert.match(svg, /transform="translate\(12 12\) rotate\(90\) scale\(1\.0667\) translate\(-12 -12\)"/, 'turned clockwise 90deg: nose to the right');
    assert.ok(!/scale\(-|matrix\(-|rotate\(-|rotate\(270|rotate\(180/.test(svg), 'never mirrored or turned to point left');
  }
  assert.match(body, /fill="currentColor" stroke="none"/);
  assert.match(halo, /fill="none" stroke="currentColor" stroke-width="2\.8"/);
  assert.equal(body.match(/ d="([^"]*)"/)[1], halo.match(/ d="([^"]*)"/)[1], 'the halo is the same outline as the body');
  const grid = cells(render(scenario(), '2026-10'));
  for (const date of ['2026-10-05', '2026-10-12', '2026-10-15', '2026-10-30']) {
    const glyph = grid.get(date).match(/<span class="cal-glyph [^"]*"[^>]*>[\s\S]*?<\/svg><\/span>/)[0];
    assert.equal((glyph.match(/<svg /g) ?? []).length, 2, `${date}: halo svg then body svg`);
    assert.ok(glyph.indexOf('fill="none" stroke="currentColor" stroke-width="2.8"') < glyph.indexOf('fill="currentColor" stroke="none"'), `${date}: halo underneath`);
  }
});

test('edge cases: previous-month start, next-month end, back-to-back, same-day end and start', () => {
  const oct = cells(render(scenario(), '2026-10'));
  const nov = cells(render(scenario(), '2026-11'));
  const pos = (cell) => cell.match(/cal-band pos-(\w+)/)?.[1];
  // (a) A rotation that started last month: no aircraft on the first visible day; its end ring shows (dimmed) on Sep 30.
  assert.equal(pos(oct.get('2026-09-28')), 'middle');
  assert.match(oct.get('2026-09-28'), /wrap-in/, 'keeps its fade');
  assert.equal(planes(oct.get('2026-09-28')), 0);
  assert.equal(planes(oct.get('2026-09-29')), 0);
  assert.equal(pos(oct.get('2026-09-30')), 'end');
  assert.match(oct.get('2026-09-30'), /is-outside/);
  // ... and a start that is only an outside cell of the other month still shows its aircraft, dimmed.
  assert.equal(planes(nov.get('2026-10-30')), 1);
  assert.match(nov.get('2026-10-30'), /is-outside/);
  // (b) A rotation ending next month: aircraft on its real start day, no end ring in this month's grid.
  assert.equal(pos(oct.get('2026-10-30')), 'start');
  assert.equal(pos(oct.get('2026-10-31')), 'middle');
  assert.equal(pos(oct.get('2026-11-01')), 'middle');
  assert.match(oct.get('2026-11-01'), /wrap-out/, 'keeps its fade');
  assert.ok(![...oct].some(([date, c]) => date > '2026-10-30' && /pos-end/.test(c)), 'no end ring for the rotation that ends in November');
  assert.equal(pos(nov.get('2026-11-02')), 'end');
  // (d1) consecutive day trips: each is its own cell with its own aircraft.
  assert.equal(pos(nov.get('2026-11-23')), 'single');
  assert.equal(pos(nov.get('2026-11-24')), 'single');
  assert.equal(planes(nov.get('2026-11-23')), 1);
  assert.equal(planes(nov.get('2026-11-24')), 1);
  // (d2) A ends on day N, B starts on N+1.
  assert.equal(pos(nov.get('2026-11-25')), 'start');
  assert.equal(pos(nov.get('2026-11-26')), 'end');
  assert.equal(pos(nov.get('2026-11-27')), 'single');
  assert.equal(planes(nov.get('2026-11-27')), 1);
  assert.equal(planes(nov.get('2026-11-26')), 0);
  // (d3) The model gives a day ONE rotation: when A ends and B starts on the same day, the day shows A's end (ring)
  // and B's aircraft is not drawn on it (B has no cell of its own to start in). Documented behaviour, not changed here.
  assert.equal(pos(nov.get('2026-11-13')), 'start');
  assert.equal(pos(nov.get('2026-11-14')), 'end');
  assert.equal(planes(nov.get('2026-11-14')), 0);
});

test('the CSS of the OFF / FREE / ORT / SB / RE / LEAVE markers is byte-for-byte as at baseline (and the duty / unknown marker)', () => {
  const css = readFileSync(new URL('../assets/css/screens.css', import.meta.url), 'utf8').split('\n');
  const lines = [
      ".cal-day.is-outside .cal-band, .cal-day.is-outside .cal-mark, .cal-day.is-outside .cal-code[class*=\"tok-\"] { opacity: 0.55; }",
      ".cal-code.tok-sb, .cal-code.tok-re, .cal-code.tok-off { min-width: 30px; padding: 0 6px; border-radius: 9px; font-size: 10.5px; letter-spacing: 0.06em; }",
      ".cal-code.tok-sb { box-shadow: inset 0 0 0 1.5px var(--tok-standby); }",
      ".cal-code.tok-re { background: repeating-linear-gradient(90deg, color-mix(in oklab, var(--tok-reserve) 26%, transparent) 0 3px, transparent 3px 5px); box-shadow: inset 0 0 0 1px var(--tok-reserve); }",
      ".cal-code.tok-off { background: color-mix(in oklab, var(--tok-off) 30%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tok-off) 70%, transparent); }",
      ".cal-code.tok-ort { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--tok-off) 70%, transparent), 0 0 0 1.5px var(--canvas), 0 0 0 2.5px var(--tok-off); }",
      ".cal-code.tok-leave { background: repeating-linear-gradient(135deg, color-mix(in oklab, var(--tok-off) 34%, transparent) 0 3px, color-mix(in oklab, var(--tok-off) 14%, transparent) 3px 6px); }",
      ".cal-code.tok-duty, .cal-code.tok-unknown { color: var(--fg-2); font-weight: var(--weight-medium); }",
      "  --tok-standby: light-dark(#8E6322, #D9A85C);",
      "  --tok-reserve: light-dark(#6E5F51, #C2AF9A);",
      "  --tok-off: light-dark(#85552F, #D2A273);"
  ];
  for (const line of lines) assert.ok(css.includes(line), `changed or missing: ${line.slice(0, 60)}`);
});

test('calendar key: one line per rotation, with the aircraft in the sample; other entries kept', () => {
  const markup = render(scenario(), '2026-10');
  assert.match(markup, /Flight · one line per rotation</);
  assert.ok(!/one aircraft per sector/.test(markup));
  assert.match(markup, /class="cal-key-plane"/);
  for (const label of ['Layover · inferred (dotted)', 'Layover · from roster (double line)', 'Standby', 'Reserve', 'Off · stated by roster', 'ORT · protected free day', 'Leave', 'Duty · type not given', 'Unknown', 'No data']) {
    assert.ok(markup.includes(label), label);
  }
});
