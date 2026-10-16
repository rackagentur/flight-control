// Guard: component and screen stylesheets never redefine a design token.
// Every custom property declared in assets/css/tokens.css (scale, state atmosphere, semantic,
// marks, brand base, plus the @property registrations) is owned by tokens.css. base.css,
// shell.css, components.css and screens.css may consume tokens with var(), and may declare
// their own local aliases (--journey, --tok-*, --jr-*, --layover-tone ...), but must never
// declare a name that tokens.css also declares. Local aliases are fine because tokens.css
// does not declare them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = ['base', 'shell', 'components', 'screens'];

// The one sanctioned exception: shell.css re-sets the layout scale primitives per breakpoint
// (`@media` blocks widening --gutter, --content-max, --context-width). These are responsive
// layout knobs, not colour or semantic tokens. Anything else, in any sheet, is a failure.
const RESPONSIVE_LAYOUT_OVERRIDES = { shell: new Set(['--gutter', '--content-max', '--context-width']) };

const blank = (m) => m.replace(/[^\n]/g, ' ');
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/url\(\s*(["']?)data:[\s\S]*?\1\s*\)/gi, blank);

// `--name:` declarations (not var(--name) uses, not `transition: --name 1s`).
const DECLARATION = /(?<![\w-])(--[\w-]+)\s*:/g;
const REGISTRATION = /@property\s+(--[\w-]+)/g;

function declaredNames(source) {
  const text = strip(source);
  return new Set([...text.matchAll(DECLARATION), ...text.matchAll(REGISTRATION)].map((m) => m[1]));
}

// [{ name, line }] for each declaration in `source` whose name is in `owned`.
function redefinitions(source, owned) {
  const text = strip(source);
  const found = [];
  for (const m of text.matchAll(DECLARATION)) {
    if (owned.has(m[1])) found.push({ name: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return found;
}

const tokensSource = readFileSync(join(ROOT, 'assets/css/tokens.css'), 'utf8');
const owned = declaredNames(tokensSource);

test('tokens.css owns a substantial token set (guard sanity)', () => {
  assert.ok(owned.size > 100, `only ${owned.size} tokens parsed from tokens.css`);
  for (const name of ['--canvas', '--accent', '--state-accent', '--fill-selected', '--edge-selected', '--st-atmos-1', '--st-canvas', '--brand', '--route', '--mark-flight', '--base-ink-1']) {
    assert.ok(owned.has(name), `${name} should be declared in tokens.css`);
  }
});

test('base, shell, components and screens never redefine a token declared in tokens.css', () => {
  const failures = [];
  for (const sheet of SHEETS) {
    const file = `assets/css/${sheet}.css`;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const lines = source.split('\n');
    for (const { name, line } of redefinitions(source, owned)) {
      if (RESPONSIVE_LAYOUT_OVERRIDES[sheet]?.has(name)) continue;
      failures.push(`${file}:${line}: redefines ${name} (declared in tokens.css) -> consume it with var(${name}) or use a local alias (${lines[line - 1].trim().slice(0, 80)})`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('the responsive layout exception is narrow: shell.css only, layout knobs only', () => {
  assert.deepEqual(Object.keys(RESPONSIVE_LAYOUT_OVERRIDES), ['shell']);
  for (const name of RESPONSIVE_LAYOUT_OVERRIDES.shell) {
    assert.match(name, /^--(gutter|content-max|context-width)$/);
    assert.ok(owned.has(name), `${name} should still be a tokens.css layout token`);
  }
});

test('guard detector: flags redefinitions, spares local aliases, uses, transitions and comments', () => {
  const owns = new Set(['--accent', '--st-canvas']);
  const names = (css) => redefinitions(css, owns).map((f) => f.name);
  assert.deepEqual(names('a { --accent: red; }'), ['--accent']);
  assert.deepEqual(names('a { --accent : var(--x); --st-canvas:#fff }'), ['--accent', '--st-canvas']);
  assert.deepEqual(names('a { --journey: var(--mark-flight); --tok-off: var(--mark-off); }'), []);
  assert.deepEqual(names('a { color: var(--accent); transition: --st-canvas 1s; }'), []);
  assert.deepEqual(names('/* --accent: red; */ a { color: var(--accent, red); }'), []);
  assert.equal(redefinitions('a {\n  color: red;\n  --accent: blue;\n}', owns)[0].line, 3);
  assert.deepEqual([...declaredNames('@property --st-tint { syntax: "<color>"; } :root { --brand: #fff; }')].sort(), ['--brand', '--st-tint']);
});
