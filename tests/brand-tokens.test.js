// Gate for the Flight Control brand foundation (section 6 of assets/css/tokens.css).
// Day Flight (light) / Night Flight (dark): contrast, brand-vs-status distinctness
// (OKLab Euclidean distance) and a few brief guards. Sections 3-5 of tokens.css and the
// component sheets consume these tokens (see tests/tokens.test.js, tests/selection-cues.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'assets/css/tokens.css'), 'utf8');

const TOKEN_NAMES = [
  'base-canvas', 'base-canvas-2', 'base-surface-1', 'base-surface-2',
  'base-ink-1', 'base-ink-2', 'base-ink-3', 'base-line',
  'brand', 'brand-strong', 'brand-soft', 'brand-edge', 'brand-fill', 'on-brand',
  'route', 'route-soft',
  'status-positive', 'status-caution', 'status-critical',
];
const MODES = ['light', 'dark'];

const SURFACES = ['base-canvas', 'base-canvas-2', 'base-surface-1', 'base-surface-2'];
const TEXT_CAPABLE = ['base-ink-1', 'base-ink-2', 'brand', 'brand-strong', 'route', 'status-positive', 'status-critical'];
const DECORATIVE = ['base-ink-3'];
// Non-text indicators (dots, icons, outlines; WCAG 1.4.11): [token, backgrounds, minimum ratio].
// Status TEXT uses base ink plus its label, never the status colour alone.
const INDICATORS = [
  ['status-caution', SURFACES, 3.0],
  ['brand-edge', [...SURFACES, 'brand-soft'], 3.0],
];
// Amber guard: OKLab hue angle window for status-caution (olive >= ~90 deg, copper/red < 60 deg).
const CAUTION_HUE = [60, 85];

// [foreground, background, minimum ratio]
const PAIRS = [
  ['brand', 'brand-soft', 4.5],
  ['base-ink-1', 'brand-soft', 4.5],
  ['on-brand', 'brand-fill', 4.5],
  ['route', 'route-soft', 4.5],
  ['base-ink-1', 'route-soft', 4.5],
];

// [a, b, minimum OKLab distance]
const DISTINCT = [
  ['brand', 'status-caution', 0.09],
  ['brand', 'status-critical', 0.09],
  ['brand', 'status-positive', 0.09],
  ['brand', 'route', 0.15],
  ['status-caution', 'status-critical', 0.09],
  ['status-caution', 'status-positive', 0.09],
];

// Locate the section-6 :root block by its header comment.
function parseBrandBlock(source) {
  const header = source.search(/\/\*\s*6\.\s*Flight Control brand foundation/);
  assert.ok(header >= 0, 'tokens.css: section 6 header "6. Flight Control brand foundation" not found');
  const rest = source.slice(header);
  const m = rest.match(/:root\s*\{([^}]*)\}/);
  assert.ok(m, 'tokens.css: no ":root { ... }" block found after the section 6 header');
  const tokens = {};
  for (const [, name, light, dark] of m[1].matchAll(/--([\w-]+):\s*light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/g)) {
    tokens[name] = { light, dark };
  }
  return tokens;
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

// sRGB hex -> OKLab (Bjorn Ottosson's reference matrices).
function oklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function hueDeg(hex) {
  const { a, b } = oklab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

function deltaE(hexA, hexB) {
  const x = oklab(hexA);
  const y = oklab(hexB);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

const tokens = parseBrandBlock(css);

// Section-5 fixed operational marks, resolved to hex pairs (a mark is either light-dark(#a, #b)
// or var(--token) pointing at a section-6 token).
function parseMarks(source) {
  const header = source.search(/\/\*\s*5\.\s*Fixed operational marks/);
  assert.ok(header >= 0, 'tokens.css: section 5 header "5. Fixed operational marks" not found');
  const m = source.slice(header).match(/:root\s*\{([^}]*)\}/);
  assert.ok(m, 'tokens.css: no ":root { ... }" block after the section 5 header');
  const marks = {};
  for (const [, name, value] of m[1].matchAll(/--(mark-[\w-]+):\s*([^;]+);/g)) {
    const pair = value.match(/^light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)$/);
    const ref = value.trim().match(/^var\(--([\w-]+)\)$/);
    marks[name] = pair ? { light: pair[1], dark: pair[2] } : ref ? tokens[ref[1]] : null;
    assert.ok(marks[name], `--${name}: cannot resolve "${value.trim()}"`);
  }
  return marks;
}
const marks = parseMarks(css);

// [mark, brand-side token, minimum OKLab distance]: roster marks must never read as brand copper.
const MARK_DISTINCT = [
  ['mark-off', 'brand', 0.09],
  ['mark-reserve', 'brand', 0.09],
  ['mark-layover', 'brand', 0.09],
];
// The selection fill must be a perceptible second cue on every base surface (brand-edge is close to
// caution amber on Day Flight, so selection never relies on the outline colour alone).
const MIN_SELECTED_FILL_DE = 0.03;

test('brand foundation: all 19 tokens exist as 6-digit light-dark pairs', () => {
  const missing = TOKEN_NAMES.filter((n) => !tokens[n]);
  assert.deepEqual(missing, [], `missing or malformed tokens: ${missing.join(', ')}`);
  assert.equal(TOKEN_NAMES.length, 19);
  for (const n of TOKEN_NAMES) {
    for (const mode of MODES) assert.match(tokens[n][mode], /^#[0-9A-Fa-f]{6}$/, `--${n} ${mode}`);
  }
});

test('brand foundation: every token is declared exactly once in the whole file', () => {
  const failures = [];
  for (const n of TOKEN_NAMES) {
    // Anchored so --brand does not match --brand-soft, --on-brand or --brand-edge.
    const count = [...css.matchAll(new RegExp(`(?<![\\w-])--${n}\\s*:`, 'g'))].length;
    if (count !== 1) failures.push(`--${n} declared ${count} times (expected exactly 1)`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: tokens are never declared inside a [data-state] block', () => {
  const offenders = [];
  for (const [, selector, body] of css.matchAll(/([^{}]*\[data-state[^{}]*)\{([^}]*)\}/g)) {
    for (const [, name] of body.matchAll(/(--[\w-]+)\s*:/g)) {
      if (TOKEN_NAMES.includes(name.slice(2))) offenders.push(`${name} in ${selector.trim().replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('brand foundation: text-capable tokens reach 4.5:1 on every base surface; ink-3 reaches 3:1', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const bg of SURFACES) {
      for (const fg of TEXT_CAPABLE) {
        const ratio = contrast(tokens[fg][mode], tokens[bg][mode]);
        if (ratio < 4.5) failures.push(`${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)} < 4.5`);
      }
      for (const fg of DECORATIVE) {
        const ratio = contrast(tokens[fg][mode], tokens[bg][mode]);
        if (ratio < 3.0) failures.push(`${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)} < 3.0 (decorative)`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: non-text indicators reach 3:1 on their backgrounds', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const [fg, bgs, min] of INDICATORS) {
      for (const bg of bgs) {
        const ratio = contrast(tokens[fg][mode], tokens[bg][mode]);
        if (ratio < min) failures.push(`${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${min} (indicator)`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: status-caution stays amber (OKLab hue window), in both themes', () => {
  const [lo, hi] = CAUTION_HUE;
  const failures = [];
  for (const mode of MODES) {
    const h = hueDeg(tokens['status-caution'][mode]);
    if (h < lo || h > hi) failures.push(`${mode}: status-caution hue = ${h.toFixed(1)} deg, outside [${lo}, ${hi}]`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: paired fills keep 4.5:1 for their text', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const [fg, bg, min] of PAIRS) {
      const ratio = contrast(tokens[fg][mode], tokens[bg][mode]);
      if (ratio < min) failures.push(`${mode}: ${fg} on ${bg} = ${ratio.toFixed(2)} < ${min}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: brand stays measurably distinct from status and route (OKLab distance)', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const [a, b, min] of DISTINCT) {
      const d = deltaE(tokens[a][mode], tokens[b][mode]);
      if (d < min) failures.push(`${mode}: ${a} vs ${b} = ${d.toFixed(3)} < ${min}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: roster marks (off, reserve, layover) stay distinct from brand copper; flight/standby follow route/caution', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const [mark, other, min] of MARK_DISTINCT) {
      const d = deltaE(marks[mark][mode], tokens[other][mode]);
      if (d < min) failures.push(`${mode}: ${mark} vs ${other} = ${d.toFixed(3)} < ${min}`);
    }
    if (marks['mark-flight'][mode] !== tokens.route[mode]) failures.push(`${mode}: mark-flight must resolve to route`);
    if (marks['mark-standby'][mode] !== tokens['status-caution'][mode]) failures.push(`${mode}: mark-standby must resolve to status-caution`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: selected fill (brand-soft) is a perceptible cue on every base surface', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const bg of SURFACES) {
      const d = deltaE(tokens['brand-soft'][mode], tokens[bg][mode]);
      if (d < MIN_SELECTED_FILL_DE) failures.push(`${mode}: brand-soft vs ${bg} = ${d.toFixed(3)} < ${MIN_SELECTED_FILL_DE}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('brand foundation: brief guards (Day canvas cool, Night canvas warm and dark, ink leaning)', () => {
  const lc = oklab(tokens['base-canvas'].light);
  const dc = oklab(tokens['base-canvas'].dark);
  const li = oklab(tokens['base-ink-1'].light);
  const di = oklab(tokens['base-ink-1'].dark);
  assert.notEqual(tokens['base-canvas'].light.toUpperCase(), '#FFFFFF', 'light base-canvas must not be white');
  assert.ok(lc.b < 0, `light base-canvas must be cool: OKLab b = ${lc.b.toFixed(4)}`);
  assert.ok(lc.L < 0.97, `light base-canvas must not be near white: OKLab L = ${lc.L.toFixed(4)}`);
  assert.ok(dc.b > 0, `dark base-canvas must be warm: OKLab b = ${dc.b.toFixed(4)}`);
  assert.ok(dc.L < 0.25, `dark base-canvas must be dark: OKLab L = ${dc.L.toFixed(4)}`);
  assert.ok(li.b < 0, `light base-ink-1 must be navy-leaning: OKLab b = ${li.b.toFixed(4)}`);
  assert.ok(di.b > 0, `dark base-ink-1 must be warm: OKLab b = ${di.b.toFixed(4)}`);
});

test('brand foundation: report of every measured ratio and distance', (t) => {
  const lines = [];
  for (const mode of MODES) {
    lines.push('', `== ${mode === 'light' ? 'Day Flight (light)' : 'Night Flight (dark)'} ==`);
    lines.push('-- contrast on base surfaces (text-capable >= 4.5, ink-3 >= 3.0; caution is an indicator, below) --');
    lines.push(['token'.padEnd(18), ...SURFACES.map((s) => s.padStart(15))].join(' '));
    for (const fg of [...TEXT_CAPABLE, ...DECORATIVE]) {
      lines.push([fg.padEnd(18), ...SURFACES.map((bg) => contrast(tokens[fg][mode], tokens[bg][mode]).toFixed(2).padStart(15))].join(' '));
    }
    lines.push('-- non-text indicators (>= 3.0; brand-edge also on brand-soft) --');
    lines.push(['token'.padEnd(18), ...[...SURFACES, 'brand-soft'].map((s) => s.padStart(15))].join(' '));
    for (const [fg, bgs] of INDICATORS) {
      lines.push([fg.padEnd(18), ...[...SURFACES, 'brand-soft'].map((bg) => (bgs.includes(bg)
        ? contrast(tokens[fg][mode], tokens[bg][mode]).toFixed(2) : '-').padStart(15))].join(' '));
    }
    lines.push(`-- status-caution OKLab hue ${hueDeg(tokens['status-caution'][mode]).toFixed(1)} deg (window ${CAUTION_HUE[0]}-${CAUTION_HUE[1]}) --`);
    lines.push('-- pair contrast (>= 4.5) --');
    for (const [fg, bg, min] of PAIRS) {
      lines.push(`${(fg + ' on ' + bg).padEnd(32)} ${contrast(tokens[fg][mode], tokens[bg][mode]).toFixed(2).padStart(6)}  (min ${min})`);
    }
    lines.push('-- OKLab distance --');
    for (const [a, b, min] of DISTINCT) {
      lines.push(`${(a + ' vs ' + b).padEnd(32)} ${deltaE(tokens[a][mode], tokens[b][mode]).toFixed(3).padStart(6)}  (min ${min})`);
    }
    lines.push('-- roster marks vs brand (OKLab distance) --');
    for (const [mark, other, min] of MARK_DISTINCT) {
      lines.push(`${(mark + ' vs ' + other).padEnd(32)} ${deltaE(marks[mark][mode], tokens[other][mode]).toFixed(3).padStart(6)}  (min ${min})`);
    }
    lines.push('-- brand-soft (selected fill) vs base surfaces --');
    for (const bg of SURFACES) {
      lines.push(`${('brand-soft vs ' + bg).padEnd(32)} ${deltaE(tokens['brand-soft'][mode], tokens[bg][mode]).toFixed(3).padStart(6)}  (min ${MIN_SELECTED_FILL_DE})`);
    }
  }
  const report = lines.join('\n');
  console.log(`\nBRAND TOKEN REPORT${report}\n`);
  t.diagnostic('brand token report printed above');
  assert.ok(lines.length > 0);
});
