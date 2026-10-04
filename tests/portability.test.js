// Commercial portability: airline- and crew-specific values live in source adapters and the
// profile (config), never in the Flights/Calendar/Today UI or the normalized model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
const SCANNED = [...files('src/ui'), ...files('src/model'), 'src/controller.js', 'src/main.js', 'src/router.js'];

const AIRLINE = [
  { name: 'airline flight-number prefix', re: /\bDE ?\d{2,4}\b/ },
  { name: 'airline name', re: /condor/i },
  { name: 'hard-coded crew base', re: /['"`]FRA['"`]|\bFRA\b/ },
  { name: 'v5 payload field', re: /\b(fraDep|fraArr|isFraFlight|depTimestamp|endTimestamp)\b/ },
];

test('UI, model and app wiring contain no airline-specific values', () => {
  const hits = [];
  for (const path of SCANNED) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const { name, re } of AIRLINE) if (re.test(text)) hits.push(`${path}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test('the v5 flight limit lives in the adapter, not in the screens', () => {
  const adapter = readFileSync(join(ROOT, 'src/sources/fc-appscript-v5.js'), 'utf8');
  assert.match(adapter, /V5_FLIGHT_LIMIT = 5/);
  const flights = readFileSync(join(ROOT, 'src/ui/screens/flights.js'), 'utf8');
  assert.doesNotMatch(flights, /\b5 flights\b/);
});

test('crew intelligence is excluded (decision D3): nothing reads colleague or employee data', () => {
  for (const path of [...SCANNED, ...files('src/sources'), ...files('src/config')]) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    assert.doesNotMatch(text, /colleague|employee ?number|crew ?history/i, path);
  }
});
