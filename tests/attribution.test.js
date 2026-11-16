// Provider attribution (src/sources/attribution.js), added in ea20186 without its own tests.
// The departures adapter gained an `attribution` key in the same commit; the existing
// "copies only known fields" test was not updated, which left `npm test` red on PR #1.
// Synthetic values only: the provider is never named and no real provider URL appears.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAttribution } from '../src/sources/attribution.js';
import { validateDepartures, adaptDepartures } from '../src/sources/departures-v2.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = () => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/departures-v2.synthetic.json'), 'utf8'));
const GOOD = { name: 'Example Data', url: 'https://example.invalid/about' };

test('readAttribution accepts exactly {name, url} with a short plain name and an https URL', () => {
  const a = readAttribution(GOOD);
  assert.deepEqual(a, { name: 'Example Data', url: 'https://example.invalid/about' });
  assert.ok(Object.isFrozen(a));
  assert.equal(readAttribution({ name: '  Example  ', url: GOOD.url }).name, 'Example');
});

test('readAttribution rejects anything else with null and never throws', () => {
  const bad = [
    undefined, null, 'Example', 42, [], [GOOD],
    {}, { name: GOOD.name }, { url: GOOD.url },
    { ...GOOD, extra: 'x' },
    { name: 7, url: GOOD.url }, { name: GOOD.name, url: 7 },
    { name: '', url: GOOD.url }, { name: 'x'.repeat(41), url: GOOD.url },
    { name: '<b>Example</b>', url: GOOD.url }, { name: '-Example', url: GOOD.url },
    { name: GOOD.name, url: 'http://example.invalid/' },
    { name: GOOD.name, url: 'javascript:alert(1)' },
    { name: GOOD.name, url: 'https://user:pass@example.invalid/' },
    { name: GOOD.name, url: 'not a url' },
    { name: GOOD.name, url: `https://example.invalid/${'a'.repeat(200)}` },
    Object.assign(Object.create({ inherited: true }), GOOD),
  ];
  for (const b of bad) assert.equal(readAttribution(b), null, JSON.stringify(b));
});

test('departures: absent attribution adapts to null; a valid one passes through sanitized', () => {
  const none = fixture();
  delete none.attribution;
  assert.equal(validateDepartures(none).ok, true);
  assert.equal(adaptDepartures(none).attribution, null);

  const p = { ...fixture(), attribution: { name: ' Example Data ', url: GOOD.url } };
  assert.equal(validateDepartures(p).ok, true);
  assert.deepEqual(adaptDepartures(p).attribution, { name: 'Example Data', url: GOOD.url });
});

test('departures: a present but malformed attribution is refused, not silently dropped', () => {
  for (const attribution of [null, {}, { ...GOOD, extra: 1 }, { name: GOOD.name, url: 'http://example.invalid/' }]) {
    const r = validateDepartures({ ...fixture(), attribution });
    assert.deepEqual(r, { ok: false, reason: 'bad-attribution' }, JSON.stringify(attribution));
  }
});
