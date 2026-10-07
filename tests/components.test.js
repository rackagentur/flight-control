// Step 5 component foundation gate (CSS text, no rendering):
//   radius scale, elevation steps, type scale, fixed-width operational time, the brand button and
//   the status-chip primitive. Colour literals are policed elsewhere (css-literals, token-guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const SHEETS = ['base', 'shell', 'components', 'screens'];
const sheets = Object.fromEntries(SHEETS.map((n) => [n, strip(read(`assets/css/${n}.css`))]));
const tokens = strip(read('assets/css/tokens.css'));

// Innermost rule blocks (also inside @media): { selectors: [..], body }.
function parseRules(css) {
  const rules = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selectors: sel.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean), body });
  }
  return rules;
}
const rules = SHEETS.flatMap((n) => parseRules(sheets[n]));
const withSelector = (selector) => rules.filter((r) => r.selectors.includes(selector));
const declarations = (body, prop) => [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());

const SURFACES = ['.pass', '.card', '.list', '.cal-detail-card', '.fl-detail-card', '.review-dock', '.row-card', '.fl-recent-row', '.fl-mini-row', '.btn', '.list-icon', '.empty-icon', '.chip-status'];

test('every surface radius is a var(--radius-*) token', () => {
  const failures = [];
  for (const selector of SURFACES) {
    const found = withSelector(selector);
    const radii = found.flatMap((r) => declarations(r.body, 'border-radius'));
    if (!radii.length) failures.push(`${selector}: no border-radius declared`);
    for (const v of radii) if (!/^var\(--radius-[\w-]+\)$/.test(v)) failures.push(`${selector}: border-radius ${v}`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('surface shadows are built from var(--elev-1|2|3); selected states append cues to the same step', () => {
  const STEP = {
    '.pass': 3,
    '.card': 2, '.list': 2, '.cal-detail-card': 2, '.fl-detail-card': 2, '.review-dock': 2,
    '.row-card': 1, '.fl-recent-row': 1, '.fl-mini-row': 1, '.btn-quiet': 1, '.chip-status': 1,
    '.fl-recent-row.is-selected': 1, '.fl-mini-row.is-current': 1,
  };
  const failures = [];
  for (const [selector, step] of Object.entries(STEP)) {
    const shadows = withSelector(selector).flatMap((r) => declarations(r.body, 'box-shadow'));
    if (!shadows.length) failures.push(`${selector}: no box-shadow declared`);
    for (const v of shadows) if (!new RegExp(`var\\(--elev-${step}\\)`).test(v)) failures.push(`${selector}: box-shadow ${v} lacks var(--elev-${step})`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('cards use the card padding token and the shared row card uses the row padding tokens', () => {
  for (const selector of ['.card', '.cal-detail-card', '.fl-detail-card']) {
    assert.ok(withSelector(selector).some((r) => declarations(r.body, 'padding').includes('var(--pad-card)')), `${selector} padding: var(--pad-card)`);
  }
  const row = withSelector('.row-card').map((r) => r.body).join('\n');
  assert.match(row, /padding:\s*var\(--pad-row-y\)\s+var\(--pad-row-x\)/);
  assert.match(row, /background:\s*var\(--glass-strong\)/);
  // The two Flights rows share the declarations via one grouped rule.
  const grouped = rules.find((r) => r.selectors.includes('.row-card'));
  assert.ok(grouped.selectors.includes('.fl-recent-row') && grouped.selectors.includes('.fl-mini-row'), '.row-card, .fl-recent-row and .fl-mini-row share one rule');
});

test('no font-size literals except the glyph allowlist: everything else is var(--text-*)', () => {
  const ALLOW = new Set(['.jr-chev', '.cal-step', '.cal-key-sample']); // glyph sizes + the calendar key mark (Step 3 marks stay byte-identical)
  const failures = [];
  for (const name of SHEETS) {
    for (const r of parseRules(sheets[name])) {
      for (const v of declarations(r.body, 'font-size')) {
        if (/^var\(--text-[\w-]+\)$/.test(v)) continue;
        if (r.selectors.every((s) => ALLOW.has(s))) continue;
        failures.push(`${name}.css ${r.selectors.join(', ')}: font-size ${v}`);
      }
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  // The allowlist is real: both glyph rules still exist.
  for (const s of ALLOW) assert.ok(withSelector(s).some((r) => declarations(r.body, 'font-size').length), `${s} keeps its glyph size`);
});

test('time and countdown displays use fixed-width digits (tabular-nums)', () => {
  const TIME = [
    '.t-route', '.fl-rot-route', '.jr-route', '.cal-sector-route',
    '.rd-time', '.rd-rev', '.hz-time', '.hz-time-value', '.week-date', '.cal-num',
    '.pass-countdown', '.pass-sectors', '.pass-field dd', '.intel-clock',
    '.jr-day-times', '.fl-recent-date', '.cal-pickup',
  ];
  const failures = [];
  for (const selector of TIME) {
    const found = withSelector(selector);
    if (!found.length) { failures.push(`${selector}: no rule`); continue; }
    if (!found.some((r) => /font-variant-numeric:\s*tabular-nums/.test(r.body))) failures.push(`${selector}: no tabular-nums`);
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('route lines: titles semibold + tight + tabular; sector lines keep code/time weight contrast; arrows secondary ink', () => {
  const group = withSelector('.t-route')[0];
  for (const s of ['.t-route', '.fl-rot-route']) assert.ok(group.selectors.includes(s), `${s} in the route-title group`);
  assert.match(group.body, /font-weight:\s*var\(--weight-semibold\)/);
  assert.match(group.body, /letter-spacing:\s*-0\.01em/);
  assert.match(group.body, /font-variant-numeric:\s*tabular-nums/);
  for (const s of ['.jr-route', '.cal-sector-route']) {
    const rules = withSelector(s);
    assert.ok(rules.some((r) => /font-variant-numeric:\s*tabular-nums/.test(r.body)), `${s} has tabular digits`);
    // Bold airport codes (<b>) against regular-weight times: the line itself must not be made semibold.
    assert.ok(!rules.some((r) => /font-weight:\s*var\(--weight-semibold\)/.test(r.body)), `${s} keeps regular-weight times`);
  }
  for (const s of ['.fl-arrow', '.jr-arrow', '.cal-sector-arrow']) {
    assert.ok(withSelector(s).some((r) => /color:\s*var\(--fg-2\)/.test(r.body)), `${s} colour var(--fg-2)`);
  }
});

test('typography hierarchy: bold page title, eyebrow tracking token, input text at body size', () => {
  assert.match(withSelector('.page-title').map((r) => r.body).join(';'), /font-weight:\s*var\(--weight-bold\)/);
  assert.match(withSelector('.t-eyebrow').map((r) => r.body).join(';'), /letter-spacing:\s*var\(--tracking-eyebrow\)/);
  assert.ok(withSelector('.field-input').some((r) => declarations(r.body, 'font-size').includes('var(--text-body)')), '.field-input font-size var(--text-body) (no iOS focus zoom)');
});

test('section rhythm: sections are 32px apart', () => {
  assert.ok(withSelector('.section + .section').some((r) => /margin-top:\s*var\(--space-6\)/.test(r.body)));
});

// --- Buttons -----------------------------------------------------------------------------------------

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function pair(name) {
  const m = tokens.match(new RegExp(`--${name}\\s*:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{6})\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`));
  assert.ok(m, `--${name} light-dark(#, #) not found`);
  return { light: hex(m[1]), dark: hex(m[2]) };
}

test('.btn-primary is the brand fill with on-brand ink, readable in both themes; quiet buttons take glass', () => {
  const body = withSelector('.btn-primary').map((r) => r.body).join('\n');
  assert.match(body, /background:\s*var\(--brand-fill\)/);
  assert.match(body, /color:\s*var\(--on-brand\)/);
  assert.match(body, /box-shadow:[^;]*var\(--brand-edge\)[^;]*var\(--elev-1\)/);
  const fill = pair('brand-fill');
  const ink = pair('on-brand');
  for (const theme of ['light', 'dark']) {
    const c = contrast(ink[theme], fill[theme]);
    assert.ok(c >= 4.5, `on-brand on brand-fill (${theme}) ${c.toFixed(2)}:1 must be >= 4.5`);
  }
  const quiet = withSelector('.btn-quiet').map((r) => r.body).join('\n');
  assert.match(quiet, /background:\s*var\(--glass-strong\)/);
  assert.match(quiet, /color:\s*var\(--fg-1\)/);
  assert.ok(withSelector('.btn-quiet svg').some((r) => /color:\s*var\(--accent\)/.test(r.body)), '.btn-quiet svg is accent');
  assert.match(withSelector('.btn:active:not(:disabled)').map((r) => r.body).join(''), /scale\(0\.96\)/);
});

test('settings: both "Save and test" buttons are primary', () => {
  const src = read('src/ui/screens/settings.js');
  const buttons = [...src.matchAll(/<button\b[^>]*>\s*Save and test\s*<\/button>/g)].map((m) => m[0]);
  assert.equal(buttons.length, 2);
  for (const b of buttons) {
    assert.match(b, /class="btn btn-primary"/, b);
    assert.doesNotMatch(b, /btn-quiet/);
  }
});

// --- Icon tiles and the status chip primitive ----------------------------------------------------------

test('icon tiles: list icon 32px / control radius, empty icon 44px / row radius, brand-soft fill with accent glyph', () => {
  const list = withSelector('.list-icon').map((r) => r.body).join('\n');
  const empty = withSelector('.empty-icon').map((r) => r.body).join('\n');
  assert.match(list, /width:\s*32px/); assert.match(list, /height:\s*32px/); assert.match(list, /border-radius:\s*var\(--radius-control\)/);
  assert.match(empty, /width:\s*44px/); assert.match(empty, /height:\s*44px/); assert.match(empty, /border-radius:\s*var\(--radius-row\)/);
  for (const b of [list, empty]) { assert.match(b, /background:\s*var\(--fill-selected\)/); assert.match(b, /color:\s*var\(--accent\)/); }
});

test('.chip-status keeps ink text; the status colour is only the dot; the primitive is not used in markup yet', () => {
  const chipRules = rules.filter((r) => r.selectors.some((s) => s === '.chip-status' || s.startsWith('.chip-status[') || s.startsWith('.chip-status::')));
  assert.ok(chipRules.length >= 5);
  const base = withSelector('.chip-status').map((r) => r.body).join('\n');
  assert.match(base, /color:\s*var\(--fg-1\)/);
  assert.match(base, /height:\s*24px/);
  assert.match(base, /border-radius:\s*var\(--radius-pill\)/);
  assert.match(withSelector('.chip-status::before').map((r) => r.body).join('\n'), /background:\s*var\(--chip-dot,\s*var\(--fg-2\)\)/);
  for (const r of chipRules) {
    for (const c of declarations(r.body, 'color')) assert.ok(!/status|caution|critical|positive|chip-dot/.test(c), `${r.selectors.join(', ')}: text colour ${c} must stay ink`);
  }
  for (const [status, token] of [['positive', 'status-positive'], ['caution', 'status-caution'], ['critical', 'status-critical']]) {
    const body = withSelector(`.chip-status[data-status="${status}"]`).map((r) => r.body).join('\n');
    assert.match(body, new RegExp(`--chip-dot:\\s*var\\(--${token}\\)`));
  }
  // Primitive only: no markup or script references it.
  const files = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? walk(p) : files.push(p); }
  })(join(ROOT, 'src'));
  files.push(join(ROOT, 'index.html'));
  const used = files.filter((f) => /chip-status/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(used, [], 'chip-status is not used in src/ or index.html yet');
});

// --- Scale tokens ----------------------------------------------------------------------------------------

test('radius scale and component tokens', () => {
  const tok = (name) => tokens.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))?.[1].trim();
  assert.equal(tok('radius-hero'), '28px');
  assert.equal(tok('radius-card'), '20px');
  assert.equal(tok('radius-row'), '14px');
  assert.equal(tok('radius-control'), '10px');
  assert.equal(tok('radius-pill'), '999px');
  assert.equal(tok('pad-card'), '20px');
  assert.equal(tok('pad-row-y'), '12px');
  assert.equal(tok('pad-row-x'), '14px');
  assert.equal(tok('weight-bold'), '700');
  assert.equal(tok('tracking-eyebrow'), '0.12em');
  assert.equal(parseFloat(tok('text-mini')) * 16, 10.5);
  assert.equal(parseFloat(tok('text-micro')) * 16, 11);
});

test('elevation tokens exist and are built only from shell materials', () => {
  for (const n of [1, 2, 3]) {
    const v = tokens.match(new RegExp(`--elev-${n}\\s*:\\s*([^;]+);`))?.[1];
    assert.ok(v, `--elev-${n} defined`);
    assert.ok(!/#|rgb|hsl/i.test(v), `--elev-${n} has no colour literal`);
    assert.match(v, /var\(--shell-edge\)/);
  }
  assert.match(tokens.match(/--elev-3\s*:\s*([^;]+);/)[1], /var\(--pass-lift\)/);
});
