// Duty-state atmosphere gate (section 3 of assets/css/tokens.css) over the brand base (section 6).
//
// Duty states are restrained atmospheric overlays: each state declares ONLY
// {accent, atmos-1, atmos-2, atmos-3, tint}; canvas, surfaces, ink and lines always come from
// the brand base. This file checks, for every state x theme: the declared token set, text
// contrast of base ink over the atmospheres, state-accent contrast, subtlety (OKLab distance to
// the base canvas), that states are not flattened into each other, and that state accents stay
// distinct from brand and critical. WCAG 2.x relative luminance for contrast; OKLab Euclidean
// distance (same maths as tests/brand-tokens.test.js) for distinctness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'assets/css/tokens.css'), 'utf8');

const STATES = ['unknown', 'off', 'flight', 'standby', 'reserve', 'layover', 'layover/ocean', 'layover/olive', 'layover/sand', 'layover/stone'];
const MODES = ['light', 'dark'];
const STATE_TOKENS = ['accent', 'atmos-1', 'atmos-2', 'atmos-3', 'tint'];
const ATMOS = ['atmos-1', 'atmos-2', 'atmos-3'];
const BASE_SURFACES = ['base-canvas', 'base-canvas-2', 'base-surface-1', 'base-surface-2'];
const CHARACTER_STATES = ['off', 'flight', 'standby', 'reserve'];

// Thresholds (the lead's design; not to be loosened here).
const MAX_TOP_DE = 0.025;       // atmos-1 vs base canvas
const MAX_BOTTOM_DE = 0.08;     // atmos-3 vs base canvas
const MIN_CHARACTER_DE = 0.010; // atmos-3 of a character state vs unknown, and pairwise
const MIN_BRAND_DE = 0.085;     // st-accent vs brand
const MIN_CRITICAL_DE = 0.09;   // st-accent vs status-critical
const PRESENCE_STATES = ['off', 'flight', 'standby', 'reserve', 'layover/ocean'];
const PRESENCE_MIN_DE = 0.012;  // atmos-3 vs unknown atmos-3: every presence state is perceptible
const PRESENCE_MAX_DE = 0.060;  // ... and none shouts
const PRESENCE_MAX_RATIO = 3.0; // largest / smallest per theme: no single state dominates
const RESERVE_MIN_ROUTE_DE = 0.09; // reserve accent vs route blue

const between = (source, startRe, endRe) => {
  const start = source.search(startRe);
  assert.ok(start >= 0, `tokens.css: ${startRe} not found`);
  const rest = source.slice(start);
  const end = endRe ? rest.slice(1).search(endRe) : -1;
  return end >= 0 ? rest.slice(0, end + 1) : rest;
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const section3 = stripComments(between(css, /\/\*\s*3\.\s*Operational state atmospheres/, /\/\*\s*4\.\s*Semantic tokens/));
const section4 = stripComments(between(css, /\/\*\s*4\.\s*Semantic tokens/, /\/\*\s*5\.\s*Fixed operational marks/));
const section6 = stripComments(between(css, /\/\*\s*6\.\s*Flight Control brand foundation/, null));

// Every block of section 3: { selectors: [..], decls: { name: rawValue } }.
function parseBlocks(source) {
  const blocks = [];
  for (const [, selectorText, body] of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const decls = {};
    for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) decls[name] = value.trim();
    blocks.push({ selectors: selectorText.split(',').map((s) => s.trim()).filter(Boolean), decls });
  }
  return blocks;
}

const keyOf = (sel) => {
  const m = sel.match(/^\[data-state="(\w+)"\](?:\[data-tone="(\w+)"\])?$/);
  return m ? (m[2] ? `${m[1]}/${m[2]}` : m[1]) : null;
};

const blocks3 = parseBlocks(section3);
const stateBlocks = {}; // key -> declared custom properties (raw)
for (const { selectors, decls } of blocks3) {
  for (const sel of selectors) {
    const key = keyOf(sel);
    if (key) stateBlocks[key] = decls;
  }
}

const LD = /^light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)$/;
const parsePair = (raw) => {
  const m = raw?.match(LD);
  return m ? { light: m[1], dark: m[2] } : null;
};

const states = {};
for (const key of STATES) {
  states[key] = {};
  for (const name of STATE_TOKENS) states[key][name] = parsePair(stateBlocks[key]?.[`st-${name}`]);
}

const base = {};
for (const [, name, light, dark] of section6.matchAll(/--([\w-]+):\s*light-dark\(\s*(#[0-9A-Fa-f]{6})\s*,\s*(#[0-9A-Fa-f]{6})\s*\)/g)) base[name] = { light, dark };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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

function deltaE(hexA, hexB) {
  const x = oklab(hexA);
  const y = oklab(hexB);
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b);
}

// sRGB approximation of color-mix(in oklab, a p%, transparent) layered over b.
function over(top, bottom, alpha) {
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(ch(top, i) * alpha + ch(bottom, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

test('every state block declares exactly {accent, atmos-1, atmos-2, atmos-3, tint} as light-dark hex pairs', () => {
  const failures = [];
  const expected = STATE_TOKENS.map((n) => `st-${n}`).sort();
  for (const key of STATES) {
    const decls = stateBlocks[key];
    if (!decls) { failures.push(`${key}: no state block found`); continue; }
    const names = Object.keys(decls).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) failures.push(`${key}: declares [${names.join(', ')}], expected [${expected.join(', ')}]`);
    for (const n of STATE_TOKENS) if (!states[key][n]) failures.push(`${key}: --st-${n} is not a light-dark(#hex, #hex) pair`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('states never redefine canvas, surfaces, ink or lines (those come from the brand base)', () => {
  const forbidden = /^(st-(canvas|surface|ink|ink-2|ink-3|line)|canvas|surface-1|fg-[123]|line|base-.+|brand.*|route.*|status-.+)$/;
  const failures = [];
  for (const { selectors, decls } of blocks3) {
    if (selectors.every((s) => s === ':root')) continue; // the plain :root block, checked below
    for (const name of Object.keys(decls)) if (forbidden.test(name)) failures.push(`--${name} declared in ${selectors.join(', ')}`);
  }
  assert.deepEqual(failures, []);
  // No stylesheet references the removed per-state tokens anywhere.
  for (const name of ['tokens', 'base', 'shell', 'components', 'screens']) {
    const sheet = stripComments(readFileSync(join(ROOT, `assets/css/${name}.css`), 'utf8'));
    const hits = [...sheet.matchAll(/var\(--st-(surface|ink|ink-2|ink-3|line)\)|--st-(surface|ink|ink-2|ink-3|line)\s*:/g)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${name}.css still references removed state tokens`);
  }
});

test('--st-canvas is one plain :root alias of --base-canvas, never per-state', () => {
  const plain = blocks3.filter((b) => b.selectors.length === 1 && b.selectors[0] === ':root');
  assert.equal(plain.length, 1, 'expected exactly one plain :root block in section 3');
  assert.equal(plain[0].decls['st-canvas'], 'var(--base-canvas)');
  for (const [key, decls] of Object.entries(stateBlocks)) assert.ok(!('st-canvas' in decls), `${key} must not declare --st-canvas`);
  // @property registrations stay consistent with the new base values.
  const prop = (name) => css.match(new RegExp(`@property --${name}\\s*\\{[^}]*initial-value:\\s*(#[0-9A-Fa-f]{6})`))?.[1];
  assert.equal(prop('st-canvas')?.toUpperCase(), base['base-canvas'].light.toUpperCase());
  for (const n of ['atmos-1', 'atmos-2', 'atmos-3', 'tint']) {
    assert.equal(prop(`st-${n}`)?.toUpperCase(), states.unknown[n].light.toUpperCase(), `@property --st-${n} initial-value`);
  }
});

test('semantic tokens read the brand base; state only supplies the atmosphere and its accent', () => {
  const decl = (name) => section4.match(new RegExp(`(?<![\\w-])--${name}\\s*:\\s*([^;]+);`))?.[1].trim();
  const expected = {
    canvas: 'var(--st-canvas)', 'surface-1': 'var(--base-surface-1)',
    'fg-1': 'var(--base-ink-1)', 'fg-2': 'var(--base-ink-2)', 'fg-3': 'var(--base-ink-3)', line: 'var(--base-line)',
    accent: 'var(--brand)', 'state-accent': 'var(--st-accent)', tint: 'var(--st-tint)',
    'fill-selected': 'var(--brand-soft)', 'edge-selected': 'var(--brand-edge)',
    'horizon-fill': 'var(--route)', caution: 'var(--status-caution)', critical: 'var(--status-critical)', positive: 'var(--status-positive)',
  };
  const failures = [];
  for (const [name, value] of Object.entries(expected)) if (decl(name) !== value) failures.push(`--${name}: ${decl(name)} (expected ${value})`);
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  assert.match(decl('focus-ring'), /var\(--brand\)/);
  assert.ok(!/--st-(surface|ink|line)/.test(section4), 'section 4 still references removed state tokens');
});

test('base ink stays legible over every atmosphere (ink-1, ink-2 >= 4.5; ink-3 >= 3.0 on atmos-1)', () => {
  const failures = [];
  for (const key of STATES) {
    for (const mode of MODES) {
      for (const a of ATMOS) {
        for (const ink of ['base-ink-1', 'base-ink-2']) {
          const ratio = contrast(base[ink][mode], states[key][a][mode]);
          if (ratio < 4.5) failures.push(`${key} ${mode}: ${ink} on ${a} = ${ratio.toFixed(2)} < 4.5`);
        }
      }
      const r3 = contrast(base['base-ink-3'][mode], states[key]['atmos-1'][mode]);
      if (r3 < 3.0) failures.push(`${key} ${mode}: base-ink-3 on atmos-1 = ${r3.toFixed(2)} < 3.0 (decorative)`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('state accent reaches 3:1 (non-text) on every base surface and on its own atmospheres', () => {
  const failures = [];
  for (const key of STATES) {
    for (const mode of MODES) {
      const accent = states[key].accent[mode];
      for (const bg of BASE_SURFACES) {
        const ratio = contrast(accent, base[bg][mode]);
        if (ratio < 3.0) failures.push(`${key} ${mode}: st-accent on ${bg} = ${ratio.toFixed(2)} < 3.0`);
      }
      for (const a of ATMOS) {
        const ratio = contrast(accent, states[key][a][mode]);
        if (ratio < 3.0) failures.push(`${key} ${mode}: st-accent on ${a} = ${ratio.toFixed(2)} < 3.0`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('atmospheres are subtle: top within 0.025 of the base canvas, bottom within 0.08 (OKLab)', () => {
  const failures = [];
  for (const key of STATES) {
    for (const mode of MODES) {
      const top = deltaE(states[key]['atmos-1'][mode], base['base-canvas'][mode]);
      const bottom = deltaE(states[key]['atmos-3'][mode], base['base-canvas'][mode]);
      if (top > MAX_TOP_DE) failures.push(`${key} ${mode}: dE(atmos-1, base-canvas) = ${top.toFixed(4)} > ${MAX_TOP_DE}`);
      if (bottom > MAX_BOTTOM_DE) failures.push(`${key} ${mode}: dE(atmos-3, base-canvas) = ${bottom.toFixed(4)} > ${MAX_BOTTOM_DE}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('states are not flattened: OFF, FLIGHT, STANDBY, RESERVE keep a perceptible personality', () => {
  const failures = [];
  for (const mode of MODES) {
    for (const key of CHARACTER_STATES) {
      const d = deltaE(states[key]['atmos-3'][mode], states.unknown['atmos-3'][mode]);
      if (d < MIN_CHARACTER_DE) failures.push(`${mode}: dE(${key} atmos-3, unknown atmos-3) = ${d.toFixed(4)} < ${MIN_CHARACTER_DE}`);
    }
    for (let i = 0; i < CHARACTER_STATES.length; i++) {
      for (let j = i + 1; j < CHARACTER_STATES.length; j++) {
        const [a, b] = [CHARACTER_STATES[i], CHARACTER_STATES[j]];
        const d = deltaE(states[a]['atmos-3'][mode], states[b]['atmos-3'][mode]);
        if (d < MIN_CHARACTER_DE) failures.push(`${mode}: dE(${a} atmos-3, ${b} atmos-3) = ${d.toFixed(4)} < ${MIN_CHARACTER_DE}`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('state accents stay apart from brand copper and critical red; flight = route blue, standby = caution amber', () => {
  const failures = [];
  for (const key of STATES) {
    for (const mode of MODES) {
      const accent = states[key].accent[mode];
      const db = deltaE(accent, base.brand[mode]);
      const dc = deltaE(accent, base['status-critical'][mode]);
      if (db < MIN_BRAND_DE) failures.push(`${key} ${mode}: dE(st-accent, brand) = ${db.toFixed(3)} < ${MIN_BRAND_DE}`);
      if (dc < MIN_CRITICAL_DE) failures.push(`${key} ${mode}: dE(st-accent, status-critical) = ${dc.toFixed(3)} < ${MIN_CRITICAL_DE}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  for (const mode of MODES) {
    assert.equal(states.flight.accent[mode].toUpperCase(), base.route[mode].toUpperCase(), `flight accent must equal route (${mode})`);
    assert.equal(states.standby.accent[mode].toUpperCase(), base['status-caution'][mode].toUpperCase(), `standby accent must equal status-caution (${mode})`);
  }
});

test('state presence balance: off, flight, standby, reserve, layover/ocean are perceptible, none dominates', () => {
  const failures = [];
  for (const mode of MODES) {
    const ds = PRESENCE_STATES.map((key) => [key, deltaE(states[key]['atmos-3'][mode], states.unknown['atmos-3'][mode])]);
    for (const [key, d] of ds) {
      if (d < PRESENCE_MIN_DE || d > PRESENCE_MAX_DE) failures.push(`${mode}: dE(${key} atmos-3, unknown atmos-3) = ${d.toFixed(4)} outside [${PRESENCE_MIN_DE}, ${PRESENCE_MAX_DE}]`);
    }
    const max = Math.max(...ds.map(([, d]) => d));
    const min = Math.min(...ds.map(([, d]) => d));
    if (max > PRESENCE_MAX_RATIO * min) failures.push(`${mode}: largest ${max.toFixed(4)} > ${PRESENCE_MAX_RATIO} x smallest ${min.toFixed(4)} (ratio ${(max / min).toFixed(2)})`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('reserve accent (dusk violet-grey) stays apart from route blue and brand copper', () => {
  const failures = [];
  for (const mode of MODES) {
    const accent = states.reserve.accent[mode];
    const dr = deltaE(accent, base.route[mode]);
    const db = deltaE(accent, base.brand[mode]);
    if (dr < RESERVE_MIN_ROUTE_DE) failures.push(`${mode}: dE(reserve accent, route) = ${dr.toFixed(3)} < ${RESERVE_MIN_ROUTE_DE}`);
    if (db < MIN_BRAND_DE) failures.push(`${mode}: dE(reserve accent, brand) = ${db.toFixed(3)} < ${MIN_BRAND_DE}`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('tertiary ink is never used as a text colour', () => {
  const sheets = ['base', 'shell', 'components', 'screens'].map((name) => readFileSync(join(ROOT, `assets/css/${name}.css`), 'utf8'));
  const offenders = sheets.flatMap((sheet) => sheet.match(/(?:^|[;{\s])color:\s*var\(--fg-3\)/g) ?? []);
  assert.deepEqual(offenders, []);
});

test('hero text stays legible over the tint glow (top-right corner, 38% mix) and the environment key light', () => {
  // Mirrors the .pass tint glow (38%) and --env-key (percentages parsed from tokens.css).
  const envKey = section4.match(/--env-key:\s*light-dark\(color-mix\(in oklab, var\(--st-tint\) (\d+)%[^;]*?,\s*color-mix\(in oklab, var\(--st-tint\) (\d+)%/);
  assert.ok(envKey, '--env-key formula not found in section 4');
  const strength = { light: Number(envKey[1]) / 100, dark: Number(envKey[2]) / 100 };
  const failures = [];
  for (const key of STATES) {
    for (const mode of MODES) {
      const tint = states[key].tint[mode];
      const atmos1 = states[key]['atmos-1'][mode];
      for (const [label, lit] of [['tint corner', over(tint, atmos1, 0.38)], ['key light', over(tint, atmos1, strength[mode])]]) {
        for (const ink of ['base-ink-1', 'base-ink-2']) {
          const ratio = contrast(base[ink][mode], lit);
          if (ratio < 4.5) failures.push(`${key} ${mode}: ${ink} on ${label} ${lit} = ${ratio.toFixed(2)} < 4.5`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('report: every measured ratio and distance for the duty-state atmospheres', (t) => {
  const lines = [];
  for (const mode of MODES) {
    lines.push('', `== ${mode === 'light' ? 'Day Flight (light)' : 'Night Flight (dark)'} ==`);
    lines.push(['state'.padEnd(14), 'ink1/a1', 'ink1/a2', 'ink1/a3', 'ink2/a1', 'ink2/a2', 'ink2/a3', 'ink3/a1', 'acc/cnv', 'acc/cv2', 'acc/s1', 'acc/s2', 'acc/a1', 'acc/a2', 'acc/a3'].map((s, i) => (i ? s.padStart(8) : s)).join(''));
    for (const key of STATES) {
      const s = states[key];
      const cells = [
        ...['base-ink-1', 'base-ink-2'].flatMap((ink) => ATMOS.map((a) => contrast(base[ink][mode], s[a][mode]))),
        contrast(base['base-ink-3'][mode], s['atmos-1'][mode]),
        ...BASE_SURFACES.map((bg) => contrast(s.accent[mode], base[bg][mode])),
        ...ATMOS.map((a) => contrast(s.accent[mode], s[a][mode])),
      ];
      lines.push(key.padEnd(14) + cells.map((c) => c.toFixed(2).padStart(8)).join(''));
    }
    lines.push('', `${'state'.padEnd(14)}${'dE a1/cnv'.padStart(11)}${'dE a3/cnv'.padStart(11)}${'dE a3/unk'.padStart(11)}${'dE acc/brand'.padStart(14)}${'dE acc/crit'.padStart(13)}`);
    for (const key of STATES) {
      const s = states[key];
      lines.push(key.padEnd(14)
        + deltaE(s['atmos-1'][mode], base['base-canvas'][mode]).toFixed(4).padStart(11)
        + deltaE(s['atmos-3'][mode], base['base-canvas'][mode]).toFixed(4).padStart(11)
        + deltaE(s['atmos-3'][mode], states.unknown['atmos-3'][mode]).toFixed(4).padStart(11)
        + deltaE(s.accent[mode], base.brand[mode]).toFixed(3).padStart(14)
        + deltaE(s.accent[mode], base['status-critical'][mode]).toFixed(3).padStart(13));
    }
    lines.push('', 'state presence balance: dE(atmos-3, unknown atmos-3), bounds [' + PRESENCE_MIN_DE + ', ' + PRESENCE_MAX_DE + '], max/min <= ' + PRESENCE_MAX_RATIO + ':');
    const presence = PRESENCE_STATES.map((key) => [key, deltaE(states[key]['atmos-3'][mode], states.unknown['atmos-3'][mode])]);
    for (const [key, d] of presence) lines.push(`  ${key.padEnd(20)} ${d.toFixed(4)}`);
    lines.push(`  ${'max/min ratio'.padEnd(20)} ${(Math.max(...presence.map(([, d]) => d)) / Math.min(...presence.map(([, d]) => d))).toFixed(2)}`);
    lines.push(`  ${'reserve accent/route'.padEnd(20)} ${deltaE(states.reserve.accent[mode], base.route[mode]).toFixed(3)} (>= ${RESERVE_MIN_ROUTE_DE})`);
    lines.push('', 'pairwise dE(atmos-3) among OFF / FLIGHT / STANDBY / RESERVE:');
    for (let i = 0; i < CHARACTER_STATES.length; i++) {
      for (let j = i + 1; j < CHARACTER_STATES.length; j++) {
        const [a, b] = [CHARACTER_STATES[i], CHARACTER_STATES[j]];
        lines.push(`  ${(a + ' vs ' + b).padEnd(20)} ${deltaE(states[a]['atmos-3'][mode], states[b]['atmos-3'][mode]).toFixed(4)}`);
      }
    }
  }
  const report = lines.join('\n');
  t.diagnostic(`DUTY-STATE ATMOSPHERE REPORT${report}`);
  assert.ok(lines.length > 0);
});
