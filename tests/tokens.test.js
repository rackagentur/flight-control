// Contrast gate for the operational state palettes (WCAG 2.x relative luminance).
// Parses assets/css/tokens.css; every state × theme must meet the targets below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'assets/css/tokens.css'), 'utf8');

const REQUIRED_STATES = ['unknown', 'off', 'flight', 'standby', 'reserve', 'layover', 'layover/ocean', 'layover/olive', 'layover/sand', 'layover/stone'];
const TOKENS = ['canvas', 'surface', 'atmos-1', 'atmos-2', 'atmos-3', 'ink', 'ink-2', 'ink-3', 'accent', 'line', 'tint'];

// [foreground, background, minimum ratio, rationale]
const TARGETS = [
  ['ink', 'canvas', 4.5, 'body text'],
  ['ink', 'surface', 4.5, 'body text on surfaces'],
  ['ink', 'atmos-1', 4.5, 'hero text'],
  ['ink', 'atmos-2', 4.5, 'hero text'],
  ['ink', 'atmos-3', 4.5, 'hero text'],
  ['ink-2', 'canvas', 4.5, 'secondary text'],
  ['ink-2', 'surface', 4.5, 'secondary text on surfaces'],
  ['ink-2', 'atmos-1', 4.5, 'hero secondary text'],
  ['ink-2', 'atmos-2', 4.5, 'hero secondary text'],
  ['ink-2', 'atmos-3', 4.5, 'hero secondary text (captions sit on the lower atmosphere)'],
  ['ink-3', 'canvas', 3.0, 'decorative marks only (never text: enforced below)'],
  ['accent', 'canvas', 3.0, 'UI components and large accent text'],
  ['accent', 'surface', 3.0, 'UI components on surfaces'],
];

function parseStates(source) {
  const states = {};
  const blockRe = /((?:(?::root|\[data-state="\w+"\](?:\[data-tone="\w+"\])?)\s*,?\s*)+)\{([^}]*)\}/g;
  for (const [, selectors, body] of source.matchAll(blockRe)) {
    const tokens = {};
    for (const [, name, light, dark] of body.matchAll(/--st-([\w-]+):\s*light-dark\((#[0-9A-Fa-f]{6}),\s*(#[0-9A-Fa-f]{6})\)/g)) {
      tokens[name] = { light, dark };
    }
    if (!Object.keys(tokens).length) continue;
    for (const sel of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = sel.match(/\[data-state="(\w+)"\](?:\[data-tone="(\w+)"\])?/);
      const key = sel === ':root' ? 'root' : m[2] ? `${m[1]}/${m[2]}` : m[1];
      states[key] = tokens;
    }
  }
  return states;
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// sRGB approximation of color-mix(in oklab, a p%, transparent) layered over b.
function over(top, bottom, alpha) {
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(ch(top, i) * alpha + ch(bottom, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

const states = parseStates(css);

test('every operational state defines every palette token for light and dark', () => {
  for (const state of REQUIRED_STATES) {
    assert.ok(states[state], `missing palette for ${state}`);
    for (const token of TOKENS) assert.ok(states[state][token], `${state}: missing --st-${token}`);
  }
});

test('palette contrast meets targets in every state × theme', () => {
  const failures = [];
  for (const state of REQUIRED_STATES) {
    for (const mode of ['light', 'dark']) {
      for (const [fg, bg, min, why] of TARGETS) {
        const ratio = contrast(states[state][fg][mode], states[state][bg][mode]);
        if (ratio < min) failures.push(`${state} ${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${min} (${why})`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('state environments are distinguishable from each other (canvas or accent differ)', () => {
  const seen = new Map();
  for (const state of REQUIRED_STATES.filter((s) => s !== 'layover')) {
    for (const mode of ['light', 'dark']) {
      const sig = `${mode}:${states[state].canvas[mode]}:${states[state].accent[mode]}`;
      assert.ok(!seen.has(sig), `${state} ${mode} duplicates ${seen.get(sig)}`);
      seen.set(sig, state);
    }
  }
});

test('hero text stays legible over the tint glow (top-right corner, 38% mix)', () => {
  const failures = [];
  for (const state of REQUIRED_STATES) {
    for (const mode of ['light', 'dark']) {
      const t = states[state];
      const corner = over(t.tint[mode], t['atmos-1'][mode], 0.38);
      for (const [fg, min] of [['ink', 4.5], ['ink-2', 4.5]]) {
        const ratio = contrast(t[fg][mode], corner);
        if (ratio < min) failures.push(`${state} ${mode}: ${fg} on tint corner ${corner} = ${ratio.toFixed(2)} < ${min}`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('tertiary ink is never used as a text colour', () => {
  const sheets = ['base', 'shell', 'components', 'screens'].map((name) => readFileSync(join(ROOT, `assets/css/${name}.css`), 'utf8'));
  const offenders = sheets.flatMap((sheet) => sheet.match(/(?:^|[;{\s])color:\s*var\(--fg-3\)/g) ?? []);
  assert.deepEqual(offenders, []);
});

test('page text stays legible under the environment key light (strongest region)', () => {
  // Mirrors --env-key: tint at 30% (light) / 42% (dark) over the top of the scene (atmos-1).
  const strength = { light: 0.30, dark: 0.42 };
  const failures = [];
  for (const state of REQUIRED_STATES) {
    for (const mode of ['light', 'dark']) {
      const t = states[state];
      const lit = over(t.tint[mode], t['atmos-1'][mode], strength[mode]);
      for (const fg of ['ink', 'ink-2']) {
        const ratio = contrast(t[fg][mode], lit);
        if (ratio < 4.5) failures.push(`${state} ${mode}: ${fg} under key light ${lit} = ${ratio.toFixed(2)} < 4.5`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});
