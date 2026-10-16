// Guard: component and screen CSS carry no raw colour literals. Colours and shadows
// live in assets/css/tokens.css as semantic tokens; stylesheets only reference var().
//
// Allowed exceptions: `#000` inside mask / -webkit-mask / mask-image / -webkit-mask-image
// declarations (an alpha mask, not a colour). Comments and data: URIs are ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = ['base', 'shell', 'components', 'screens'];

const MASK_PROPERTIES = new Set(['mask', '-webkit-mask', 'mask-image', '-webkit-mask-image']);

// Replace with spaces of equal length (newlines kept) so line numbers and offsets stay valid.
const blank = (m) => m.replace(/[^\n]/g, ' ');

function sanitize(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/url\(\s*(["']?)data:[\s\S]*?\1\s*\)/gi, blank);
}

const LITERALS = [
  ['hex colour', /#[0-9a-fA-F]{3,8}(?![\w-])/g],
  ['rgb()/rgba()/hsl()/hsla()', /(?<![\w-])(?:rgba?|hsla?)\(/gi],
  // Named colours; the lookarounds keep `white-space`, `--white`, `black-box` etc. out.
  ['named colour', /(?<![\w-])(?:white|black)(?![\w-])/gi],
];

// Name of the declaration property that contains `index`, or null.
function propertyAt(text, index) {
  const start = Math.max(text.lastIndexOf(';', index), text.lastIndexOf('{', index), text.lastIndexOf('}', index)) + 1;
  const m = text.slice(start, index).match(/^\s*([\w-]+)\s*:/);
  return m ? m[1].toLowerCase() : null;
}

function findLiterals(source) {
  const text = sanitize(source);
  const found = [];
  for (const [label, re] of LITERALS) {
    for (const m of text.matchAll(re)) {
      if (label === 'hex colour' && m[0].toLowerCase() === '#000' && MASK_PROPERTIES.has(propertyAt(text, m.index))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      found.push({ line, label, literal: m[0] });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

test('component and screen CSS use tokens, not raw colour literals', () => {
  const failures = [];
  for (const name of SHEETS) {
    const file = `assets/css/${name}.css`;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const lines = source.split('\n');
    for (const { line, label, literal } of findLiterals(source)) {
      failures.push(`${file}:${line}: ${label} "${literal}" -> move to a token in assets/css/tokens.css (${lines[line - 1].trim().slice(0, 80)})`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});

test('literal detector: flags literals, spares masks, comments, data URIs and identifiers', () => {
  const kinds = (css) => findLiterals(css).map((f) => f.literal);
  assert.deepEqual(kinds('a { background: #fff; }'), ['#fff']);
  assert.deepEqual(kinds('a { color: light-dark(#3A5B7C, #94B4D2); }'), ['#3A5B7C', '#94B4D2']);
  assert.deepEqual(kinds('a { box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }'), ['rgb(']);
  assert.deepEqual(kinds('a { color: HSLA(0 0% 0% / 1); }'), ['HSLA(']);
  assert.deepEqual(kinds('a { color: white; }'), ['white']);
  assert.deepEqual(kinds('a { color: black }'), ['black']);
  assert.deepEqual(kinds('a { white-space: nowrap; --knob: var(--white-ish); }'), []);
  assert.deepEqual(kinds('a { -webkit-mask-image: linear-gradient(#000 40%, transparent); mask: linear-gradient(#000, transparent); }'), []);
  assert.deepEqual(kinds('a { background: linear-gradient(#000, transparent); }'), ['#000']);
  assert.deepEqual(kinds('a { mask-image: linear-gradient(#fff, transparent); }'), ['#fff']);
  assert.deepEqual(kinds('/* #fff and rgb(0 0 0) */ a { color: var(--x); }'), []);
  assert.deepEqual(kinds('a { background: url("data:image/svg+xml;utf8,<svg fill=\'#fff\'/>"); }'), []);
  assert.equal(findLiterals('a {\n  color: red;\n  background: #fff;\n}')[0].line, 3);
});
