// Shell gate (Step 4): the floating tab bar, rail/sidebar, shared glass material and brand mark.
//   - Navigation is state-independent: shell.css never consumes duty-state tokens or the
//     state-tinted glass; it reads the brand-base shell materials (tokens.css section 7).
//   - The tab bar keeps its safe-area behaviour and the page keeps room for it.
//   - The current tab carries more than a colour change (heavier label + halo).
//   - Tab labels stay readable (>= 4.5:1) over the glass, whatever the duty atmosphere behind it.
//   - The brand mark takes its colours from tokens; the segmented control has two selection cues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const tokens = strip(read('assets/css/tokens.css'));
const shell = strip(read('assets/css/shell.css'));
const components = strip(read('assets/css/components.css'));
const icons = read('src/ui/icons.js');

// Innermost rule blocks: { selectors: [..], body }.
function parseRules(css) {
  const rules = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean), body });
  }
  return rules;
}
// Body of the rule whose selector list contains exactly `selector` ('' when absent).
const ruleBody = (rules, selector) => rules.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join('\n');
const decl = (body, prop) => body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`))?.[1].trim();

const shellRules = parseRules(shell);
const componentRules = parseRules(components);

test('shell.css is state-independent: no duty-state tokens, tint or state-tinted glass', () => {
  const offenders = [...shell.matchAll(/var\(\s*(--(?:st-[\w-]+|tint|glass(?:-strong|-edge)?|sheen(?:-edge)?|state-accent))\b/g)].map((m) => m[1]);
  assert.deepEqual(offenders, [], `shell.css must read the brand-base shell materials, not ${offenders.join(', ')}`);
});

test('.tabbar is a floating glass capsule that keeps the safe-area insets', () => {
  const body = ruleBody(shellRules, '.tabbar');
  assert.ok(body, '.tabbar rule not found');
  assert.match(body, /position:\s*fixed/);
  assert.match(body, /var\(--shell-glass\)/);
  assert.match(body, /var\(--shell-edge\)/);
  assert.match(body, /var\(--shell-shadow-color\)/);
  assert.match(body, /border-radius:\s*var\(--tabbar-radius\)/);
  assert.match(body, /height:\s*var\(--tabbar-height\)/);
  assert.match(body, /backdrop-filter:\s*blur\(/);
  for (const side of ['bottom', 'left', 'right']) {
    assert.match(decl(body, side) ?? '', new RegExp(`env\\(safe-area-inset-${side}\\)`), `.tabbar ${side} must include env(safe-area-inset-${side})`);
  }
});

test('.main still reserves the tab bar height and the bottom safe area', () => {
  const padding = decl(ruleBody(shellRules, '.main'), 'padding') ?? '';
  assert.match(padding, /var\(--tabbar-height\)/);
  assert.match(padding, /env\(safe-area-inset-bottom\)/);
});

test('tabbar layout tokens: taller bar, rounded capsule', () => {
  assert.match(tokens, /--tabbar-height:\s*62px/);
  assert.match(tokens, /--tabbar-radius:\s*26px/);
});

test('tabs: idle ink is restrained, the current tab uses the brand and a non-colour cue', () => {
  const tab = ruleBody(shellRules, '.tab');
  const current = ruleBody(shellRules, '.tab[aria-current="page"]');
  assert.match(tab, /color:\s*var\(--tab-idle\)/);
  assert.match(current, /color:\s*var\(--tab-active\)/);
  const w = decl(tab, 'font-weight');
  const wc = decl(current, 'font-weight');
  assert.ok(w && wc && w !== wc, `current tab font-weight (${wc}) must differ from idle (${w})`);
  assert.match(ruleBody(shellRules, '.tab[aria-current="page"]::before'), /var\(--tab-halo\)/, 'current tab halo');
  // The active tab speaks the brand (copper/champagne), never the route blue.
  assert.match(tokens, /--tab-active:\s*var\(--brand\)\s*;/, '--tab-active must be var(--brand)');
  assert.match(tokens, /--tab-halo:\s*color-mix\(in oklab,\s*var\(--brand\)/, '--tab-halo must derive from var(--brand)');
  assert.doesNotMatch(shell, /transition:\s*all\b/, 'no `transition: all` in shell.css');
});

// --- Contrast of tab labels over the glass ------------------------------------------------------------

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

// `--name: light-dark(#L, #D);` -> { light, dark } (first definition in `source`).
function pair(source, name) {
  const m = source.match(new RegExp(`--${name}\\s*:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`));
  assert.ok(m, `--${name} light-dark(#, #) not found`);
  return { light: hex(m[1]), dark: hex(m[2]) };
}

// Atmosphere stops per state (section 3), keyed 'unknown', 'flight', 'layover/ocean' ...
function atmospheres() {
  const start = tokens.search(/3\.\s*Operational state atmospheres/);
  const section = tokens.slice(tokens.search(/\[data-state="unknown"\]/), tokens.search(/4\.\s*Semantic tokens/));
  assert.ok(start >= 0 || section);
  const out = {};
  for (const [, sel, body] of section.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const vals = {};
    for (const n of ['atmos-1', 'atmos-3']) {
      const m = body.match(new RegExp(`--st-${n}\\s*:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`));
      if (m) vals[n] = { light: hex(m[1]), dark: hex(m[2]) };
    }
    if (!vals['atmos-1']) continue;
    const state = sel.match(/\[data-state="(\w+)"\](?:\[data-tone="(\w+)"\])?\s*$/);
    if (!state) continue;
    out[state[2] ? `${state[1]}/${state[2]}` : state[1]] = vals;
  }
  return out;
}

test('tab labels stay readable (>= 4.5:1) over the tab-bar glass in every state and theme', () => {
  const glassAlpha = { light: 0.78, dark: 0.80 };   // --shell-glass: base-surface-1 at 78% / 80%
  assert.match(tokens, /--shell-glass:\s*light-dark\(color-mix\(in oklab, var\(--base-surface-1\) 78%, transparent\), color-mix\(in oklab, var\(--base-surface-1\) 80%, transparent\)\)/, 'glass alpha drifted from the values this test models');
  const surface = pair(tokens, 'base-surface-1');
  const canvas = pair(tokens, 'base-canvas');
  const ink2 = pair(tokens, 'base-ink-2');
  const brand = pair(tokens, 'brand');
  const atmos = atmospheres();
  assert.ok(Object.keys(atmos).length >= 9, `parsed ${Object.keys(atmos).length} atmospheres`);

  const rows = [];
  const failures = [];
  for (const mode of ['light', 'dark']) {
    const backdrops = [['base-canvas', canvas[mode]]];
    for (const [state, v] of Object.entries(atmos)) backdrops.push([`${state} atmos-1`, v['atmos-1'][mode]], [`${state} atmos-3`, v['atmos-3'][mode]]);
    let minIdle = Infinity; let minActive = Infinity; let worst = '';
    for (const [label, bg] of backdrops) {
      const glass = over(surface[mode], bg, glassAlpha[mode]);
      const idle = contrast(ink2[mode], glass);
      const active = contrast(brand[mode], glass);
      if (idle < minIdle) { minIdle = idle; worst = label; }
      minActive = Math.min(minActive, active);
      rows.push({ theme: mode, backdrop: label, 'idle ink-2': idle.toFixed(2), 'active brand': active.toFixed(2) });
      if (idle < 4.5) failures.push(`${mode} ${label}: idle ink-2 ${idle.toFixed(2)}`);
      if (active < 4.5) failures.push(`${mode} ${label}: active brand ${active.toFixed(2)}`);
    }
    rows.push({ theme: mode, backdrop: `MIN (idle worst: ${worst})`, 'idle ink-2': minIdle.toFixed(2), 'active brand': minActive.toFixed(2) });
  }
  console.table(rows);
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brandMark takes its colours from tokens (no hex literals in icons.js)', () => {
  const body = icons.slice(icons.indexOf('export function brandMark'));
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}(?![\w-])/, 'hex literal inside brandMark()');
  assert.doesNotMatch(icons, /#[0-9a-fA-F]{3,8}(?![\w-])/, 'hex literal in icons.js');
  for (const t of ['brand-mark-hi', 'brand-mark-lo', 'brand-mark-ink']) assert.match(body, new RegExp(`var\\(--${t}\\)`), `brandMark uses --${t}`);
});

test('segmented control: selected segment has a raised fill AND brand text (two cues)', () => {
  const body = ruleBody(componentRules, '.segmented button[aria-checked="true"]');
  assert.ok(body, 'selected segment rule not found');
  assert.match(body, /color:\s*var\(--brand\)/);
  assert.match(body, /background:\s*var\(--surface-1\)/);
  assert.match(body, /var\(--shadow-segment\)/);
});
