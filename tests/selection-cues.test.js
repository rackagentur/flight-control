// Colour-role gate for components.css / screens.css / shell.css (CSS text, no rendering).
//   - Selection never relies on a copper outline alone: every selected/current state carries a
//     brand-soft FILL (var(--fill-selected)) plus a brand cue (var(--edge-selected) or var(--accent)).
//   - Aviation blue (var(--route)) carries movement: the live timeline, route hovers, the radar
//     "now" line. Brand copper (var(--accent)) never does.
//   - The duty-state identity dot uses var(--state-accent), not the brand accent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const source = ['shell', 'components', 'screens'].map((n) => strip(readFileSync(join(ROOT, `assets/css/${n}.css`), 'utf8'))).join('\n');

// Innermost rule blocks (also those inside @media / @keyframes): { selectors: [..], body }.
function parseRules(css) {
  const rules = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean), body });
  }
  return rules;
}

// Declarations of every rule whose selector is `target` or a descendant/pseudo/qualified form of it
// (".jr-sector.is-selected" also covers ".jr-sector.is-selected .jr-link").
function declarationsFor(rules, target) {
  const matches = rules.filter((r) => r.selectors.some((s) => s === target || s.startsWith(`${target} `) || s.startsWith(`${target}:`) || s.startsWith(`${target}::`)));
  return { count: matches.length, text: matches.map((r) => r.body).join('\n') };
}

const rules = parseRules(source);
const uses = (text, token) => new RegExp(`var\\(--${token}\\b`).test(text);

// [selector, edge/brand cue tokens (any of)]
const SELECTION = [
  ['.cal-day.is-selected', ['edge-selected']],
  ['.chip[aria-checked="true"]', ['edge-selected']],
  ['.jr-sector.is-selected', ['edge-selected', 'accent']],
  ['.fl-recent-row.is-selected', ['edge-selected']],
  ['.fl-mini-row.is-current', ['edge-selected', 'accent']],
  ['.nav-item[aria-current="page"]', ['edge-selected', 'accent']],
];

const MOVEMENT = [
  '.hz-now',
  '.hz-span.is-current',
  '.hz-layover.is-current',
  '.hz-recovery.is-current',
  '.hz-stop.is-next',
  '.jr-sector.is-active .jr-node',
  '.jr-link:hover .jr-route b',
  '.fl-recent-row:hover .fl-recent-route',
  '.fl-mini-row:hover',
  '.rd-now',
];

test('every selection state carries a brand-soft fill AND a brand edge/icon cue (never an outline alone)', () => {
  const failures = [];
  for (const [selector, brandCues] of SELECTION) {
    const { count, text } = declarationsFor(rules, selector);
    if (!count) { failures.push(`${selector}: no rule found`); continue; }
    if (!uses(text, 'fill-selected')) failures.push(`${selector}: no var(--fill-selected) fill cue`);
    if (!brandCues.some((c) => uses(text, c))) failures.push(`${selector}: no ${brandCues.map((c) => `var(--${c})`).join(' / ')} brand cue`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('the selected-state fill is on the same rule as its edge for rows and cells (fill + edge together)', () => {
  const failures = [];
  for (const selector of ['.cal-day.is-selected', '.chip[aria-checked="true"]', '.fl-recent-row.is-selected', '.jr-sector.is-selected .jr-link']) {
    const rule = rules.find((r) => r.selectors.includes(selector));
    if (!rule) { failures.push(`${selector}: rule not found`); continue; }
    if (!/background:\s*var\(--fill-selected\)/.test(rule.body)) failures.push(`${selector}: background is not var(--fill-selected)`);
    if (!/box-shadow:[^;]*var\(--edge-selected\)/.test(rule.body)) failures.push(`${selector}: box-shadow edge is not var(--edge-selected)`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('the switch track and the tab icon keep the brand accent', () => {
  assert.ok(uses(declarationsFor(rules, '.switch[aria-checked="true"]').text, 'accent'), '.switch[aria-checked="true"] track');
  assert.ok(uses(declarationsFor(rules, '.tab[aria-current="page"]').text, 'accent'), '.tab[aria-current="page"] icon');
});

test('movement and timeline selectors use route blue and never the brand accent', () => {
  const failures = [];
  for (const selector of MOVEMENT) {
    const { count, text } = declarationsFor(rules, selector);
    if (!count) { failures.push(`${selector}: no rule found`); continue; }
    if (!uses(text, 'route')) failures.push(`${selector}: does not use var(--route)`);
    if (uses(text, 'accent') || uses(text, 'state-accent')) failures.push(`${selector}: uses var(--accent) / var(--state-accent)`);
  }
  const breathe = source.match(/@keyframes hz-breathe\s*\{([\s\S]*?\}\s*)\}/)?.[1] ?? '';
  if (!uses(breathe, 'route') || uses(breathe, 'accent')) failures.push('@keyframes hz-breathe: must glow with var(--route) only');
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand accent keeps brand roles (icons, emphasis, links, back affordances, review marks)', () => {
  const failures = [];
  for (const selector of ['.list-icon', '.empty-icon', '.pass-shift', '.pass-alarm:hover', '.intel-link:hover .intel-label', '.fl-back', '.rd-back', '.dest-link', '.rd-mark', '.status-line[data-kind="review"] .status-dot', '.jr-link:focus-visible']) {
    const { count, text } = declarationsFor(rules, selector);
    if (!count) failures.push(`${selector}: no rule found`);
    else if (!uses(text, 'accent')) failures.push(`${selector}: does not use var(--accent)`);
  }
  assert.ok(/\.t-accent\s*\{[^}]*var\(--accent\)/.test(strip(readFileSync(join(ROOT, 'assets/css/base.css'), 'utf8'))), '.t-accent');
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('duty-state identity dot uses var(--state-accent), not the brand accent', () => {
  const { count, text } = declarationsFor(rules, '.status-pill::before');
  assert.ok(count > 0, '.status-pill::before rule not found');
  assert.ok(uses(text, 'state-accent'), '.status-pill::before must use var(--state-accent)');
  assert.ok(!/var\(--accent\b/.test(text), '.status-pill::before must not use var(--accent)');
});

test('selection helper: matches descendants and pseudo-elements, not look-alike classes', () => {
  const r = parseRules('.a.is-x { background: red; } .a.is-x .b, .c { color: blue; } .a.is-xy { margin: 0; } @media (min-width: 1px) { .a.is-x::after { top: 0; } }');
  assert.equal(declarationsFor(r, '.a.is-x').count, 3);
  assert.ok(!declarationsFor(r, '.a.is-x').text.includes('margin'));
  assert.equal(declarationsFor(r, '.c').count, 1);
});
