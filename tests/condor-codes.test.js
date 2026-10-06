// Condor roster-code table (Phase 1b): one authoritative table in the airline pack, a generated
// Apps Script copy, and a backend classifier that reads it with byte-identical output.
// The golden file holds BASELINE classifier outputs captured from commit 48d800a (synthetic inputs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadGs, GS_FILES } from './gs-harness.js';
import { CONDOR_ROSTER_CODES, CONDOR_FLIGHT_DESIGNATORS } from '../src/airlines/condor/roster-codes.js';
import { getAirline } from '../src/airlines/index.js';
import { renderCondorCodesGs } from '../scripts/gen-condor-codes-gs.mjs';

const gs = loadGs();
const golden = JSON.parse(readFileSync(new URL('./fixtures/condor-classifier.golden.json', import.meta.url), 'utf8'));
const gsDir = new URL('../backend/apps-script/', import.meta.url);
const classifyWith = (g, input) => g.fcv2ClassifyEvent_(input, g.FCV2_CONDOR_CONFIG_);
const bare = (title) => ({ sourceId: 'x', title, start: 0, end: 1, description: '', basis: 'airline-feed' });

// Phase 2 (approved 2026-10-06, corrected after the live-feed trace): the ONLY golden cases whose output may differ
// from the pre-1b baseline, keyed by cleaned title, with the explicit new kind. '-' (a single dash) is the Strichtag;
// '--' never occurs in the feed and stays unknown, byte-identical to the golden. Every other case is byte-identical.
const APPROVED_CHANGES = new Map([
  ['-', 'unassigned'], ['SB90S', 'standby'], ['SB90_I', 'standby'], ['SBH30', 'standby'], ['SBAUS', 'standby'], ['SB90KO', 'standby'],
]);
const BASELINE_KIND = new Map([['-', 'off'], ['SB90S', 'unknown'], ['SB90_I', 'unknown'], ['SBH30', 'unknown'], ['SBAUS', 'unknown'], ['SB90KO', 'unknown']]);
const plain = (x) => JSON.parse(JSON.stringify(x));
/** The new expected output of an approved golden case: the baseline output with the approved kind. */
function approvedOutput(c) {
  const kind = APPROVED_CHANGES.get(c.output.title);
  const hotel = kind === 'standby' ? plain(gs.fcv2ParseDescription_(c.input.description)).hotel : null;
  return { ...c.output, kind, subtype: null, code: c.output.title, protected: false, hotel };
}
/** The expected output of a golden case: the baseline, or the approved new output. */
const expectedOutput = (c) => (APPROVED_CHANGES.has(c.output.title) ? approvedOutput(c) : c.output);

// --- Golden equivalence ---------------------------------------------------------------

test('golden corpus: synthetic, large, and covers every outcome', () => {
  assert.equal(golden._synthetic, true);
  assert.ok(golden.cases.length >= 150, `corpus size ${golden.cases.length}`);
  const kinds = new Set(golden.cases.map((c) => c.output.kind));
  for (const k of ['flight', 'checkin', 'pickup', 'standby', 'reserve', 'off', 'unknown']) assert.ok(kinds.has(k), k);
});

test('the classifier reproduces every baseline output byte for byte, except the explicitly approved Phase 2 changes', () => {
  const changed = [];
  for (const c of golden.cases) {
    const actual = JSON.stringify(classifyWith(gs, c.input));
    if (APPROVED_CHANGES.has(c.output.title)) {
      assert.equal(c.output.kind, BASELINE_KIND.get(c.output.title), 'the recorded baseline kind of this approved title');
      assert.equal(actual, JSON.stringify(approvedOutput(c)), `approved change ${JSON.stringify(c.input.title)}`);
      changed.push(`${JSON.stringify(c.input.title)}: ${c.output.kind}/${c.output.subtype} → ${plain(classifyWith(gs, c.input)).kind}`);
    } else {
      assert.equal(actual, JSON.stringify(c.output), `unchanged title ${JSON.stringify(c.input.title)}`);
    }
  }
  assert.equal(changed.length, 22, 'exactly the approved golden cases changed');
  for (const t of APPROVED_CHANGES.keys()) assert.ok(golden.cases.some((c) => c.output.title === t), `golden covers ${t}`);
});

test("'-' cases become unassigned; '--' cases are exactly the golden (unknown), byte for byte", () => {
  const dash = golden.cases.filter((c) => c.output.title === '-');
  const double = golden.cases.filter((c) => c.output.title === '--');
  assert.ok(dash.length >= 7 && double.length >= 6, 'the golden covers both symbols');
  for (const c of dash) {
    const e = plain(classifyWith(gs, c.input));
    assert.deepEqual([e.kind, e.subtype, e.protected, e.hotel, e.code], ['unassigned', null, false, null, '-'], JSON.stringify(c.input.title));
    assert.equal(c.output.kind, 'off', 'the baseline had the dash as a free day');
  }
  for (const c of double) {
    assert.equal(c.output.kind, 'unknown');
    assert.equal(JSON.stringify(classifyWith(gs, c.input)), JSON.stringify(c.output), JSON.stringify(c.input.title));
  }
});

// --- Generated Apps Script copy -------------------------------------------------------

test('CondorCodesV2.gs is exactly the generated copy of the pack table', () => {
  const file = readFileSync(new URL('CondorCodesV2.gs', gsDir), 'utf8');
  assert.equal(file, renderCondorCodesGs());
  assert.match(file, /^\/\/ GENERATED by scripts\/gen-condor-codes-gs\.mjs .* Do not edit by hand\./);
});

test('the sandbox global equals the pack table, deeply frozen', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(gs.FCV2_CONDOR_CODES_)), { flightDesignators: CONDOR_FLIGHT_DESIGNATORS, codes: CONDOR_ROSTER_CODES });
  assert.ok(Object.isFrozen(gs.FCV2_CONDOR_CODES_) && Object.isFrozen(gs.FCV2_CONDOR_CODES_.codes) && Object.isFrozen(gs.FCV2_CONDOR_CODES_.codes[0].match));
  assert.equal('airlineCodes' in gs.FCV2_CONDOR_CONFIG_, false, 'the adapter config no longer duplicates designators');
  assert.equal('dayCodes' in gs.FCV2_CONDOR_CONFIG_, false, 'the adapter config no longer duplicates day codes');
});

// --- Load order (Apps Script appends a new file last) ---------------------------------

function loadOrdered(files) {
  const sandbox = { console };
  vm.createContext(sandbox);
  const code = files.map((f) => readFileSync(new URL(f, gsDir), 'utf8')).join('\n;\n');
  vm.runInContext(`${code}\n;globalThis.__g = { fcv2ClassifyEvent_, FCV2_CONDOR_CONFIG_ };`, sandbox);
  return sandbox.__g;
}
const BACKEND = GS_FILES.filter((f) => f !== 'CondorCodesV2.gs');

test('load order: the codes file may come first or last; the adapter alone loads without it', () => {
  // Every seventh baseline case plus EVERY approved Phase 2 case, each with its (new) expected output.
  const sample = golden.cases.filter((c, i) => i % 7 === 0 || APPROVED_CHANGES.has(c.output.title));
  assert.ok(sample.filter((c) => APPROVED_CHANGES.has(c.output.title)).length === 22, 'all 22 approved cases are replayed');
  for (const order of [['CondorCodesV2.gs', ...BACKEND], [...BACKEND, 'CondorCodesV2.gs']]) {
    const g = loadOrdered(order);
    for (const c of sample) assert.equal(JSON.stringify(classifyWith(g, c.input)), JSON.stringify(expectedOutput(c)), `${order[0]} ${JSON.stringify(c.input.title)}`);
  }
  // Adapter before codes is the production order; with no codes file at all nothing throws at load time.
  assert.doesNotThrow(() => loadOrdered(['CondorAdapterV2.gs', 'CondorCodesV2.gs']));
  assert.doesNotThrow(() => loadOrdered(['CondorAdapterV2.gs']));
  const adapter = readFileSync(new URL('CondorAdapterV2.gs', gsDir), 'utf8');
  const topLevel = adapter.split('\n').filter((l) => /^(const|let|var) /.test(l)).join('\n');
  assert.doesNotMatch(topLevel, /FCV2_CONDOR_CODES_/, 'no top-level declaration reads the codes file');
});

// --- Table shape ----------------------------------------------------------------------

test('the table holds only typedef fields and contract-v2 canonical values', () => {
  const FIELDS = new Set(['id', 'match', 'kind', 'subtype', 'protected', 'source']);
  const KINDS = new Set(['checkin', 'pickup', 'standby', 'reserve', 'off', 'unassigned']);
  const SUBTYPES = new Set(['off', 'free', 'leave', 'ort']);
  // Phase 1b order; the single dash (Strichtag) took the position of the former free-day entry, the five standby symbols are appended.
  assert.deepEqual(CONDOR_ROSTER_CODES.map((d) => d.id), ['checkin', 'pickup', 'standby-sb', 'reserve-re', 'day-off', 'day-unassigned', 'day-leave', 'day-ort',
    'standby-sb90s', 'standby-sb90-i', 'standby-sbh30', 'standby-sbaus', 'standby-sb90ko']);
  assert.equal(new Set(CONDOR_ROSTER_CODES.map((d) => d.id)).size, CONDOR_ROSTER_CODES.length, 'ids are unique');
  for (const d of CONDOR_ROSTER_CODES) {
    for (const k of Object.keys(d)) assert.ok(FIELDS.has(k), `${d.id}: unexpected field ${k}`);
    assert.ok(KINDS.has(d.kind), `${d.id}: kind ${d.kind}`);
    if ('subtype' in d) assert.ok(SUBTYPES.has(d.subtype), `${d.id}: subtype ${d.subtype}`);
    assert.equal(d.kind === 'off', 'subtype' in d, `${d.id}: only free-family codes carry a subtype`);
    if ('protected' in d) assert.equal(d.protected, true);
    assert.deepEqual(Object.keys(d.match).length, 1);
    const [type, value] = Object.entries(d.match)[0];
    assert.ok(type === 'exact' || type === 'pattern');
    assert.ok(typeof value === 'string' && value.length > 0);
    if (type === 'pattern') assert.match(value, /^\^.*\$$/, `${d.id}: pattern is anchored`);
    assert.match(d.source, /^(docs\/CONTRACT-V2\.md |Condor MTV Fibel|Owner statement \+ live-feed trace 2026-10-06)/);
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.match));
  }
  assert.ok(Object.isFrozen(CONDOR_ROSTER_CODES) && Object.isFrozen(CONDOR_FLIGHT_DESIGNATORS));
  assert.deepEqual([...CONDOR_FLIGHT_DESIGNATORS], ['DE']);
  assert.equal(CONDOR_ROSTER_CODES.filter((d) => d.protected).map((d) => d.id).join(), 'day-ort');
});

test('the Condor pack exposes the table; terminology stays separate from raw codes', () => {
  const condor = getAirline('condor');
  assert.equal(condor.rosterCodes, CONDOR_ROSTER_CODES);
  assert.equal(condor.flightDesignators, CONDOR_FLIGHT_DESIGNATORS);
  assert.equal(getAirline('generic').rosterCodes, undefined);
  assert.doesNotMatch(JSON.stringify(CONDOR_ROSTER_CODES), /Protected free day|Off day|Free day|label/);
});

// --- Unrecognised codes stay unknown ---------------------------------------------------

test('agreement names and other unrecognised codes are still unknown (Phase 2 recognises only exact roster symbols)', () => {
  for (const t of ['SBY', 'SBYHOT', 'SBYKO', 'SBY_I', 'SB30-AUS', 'SBYAP', 'RES10', 'RES10_I', 'SB1000', 'sb90', 'SB 90', '--']) {
    for (const title of [t, `✈️✈️✈️ ${t}`]) {
      const e = classifyWith(gs, bare(title));
      assert.equal(e.kind, 'unknown', title);
      assert.equal(e.subtype, null, title);
      assert.equal(e.protected, false, title);
      assert.equal(e.hotel, null, title);
    }
  }
});

test('own-key semantics: prototype names are never codes', () => {
  for (const t of ['__proto__', 'toString', 'constructor', 'hasOwnProperty', 'valueOf']) assert.equal(classifyWith(gs, bare(t)).kind, 'unknown', t);
});

test('every recognised code in the corpus maps to exactly one table entry, and every entry is exercised', () => {
  const tests = CONDOR_ROSTER_CODES.map((d) => ('exact' in d.match ? (t) => t === d.match.exact : (t) => new RegExp(d.match.pattern).test(t)));
  const used = new Set();
  for (const c of golden.cases) {
    const o = expectedOutput(c);   // approved Phase 2 cases are asserted with their new expectations, not skipped
    if (o.kind === 'flight' || o.kind === 'unknown') {
      if (o.kind === 'unknown') assert.ok(!tests.some((t) => t(o.title)), `unknown title ${JSON.stringify(o.title)} matches no entry`);
      continue;
    }
    const hits = CONDOR_ROSTER_CODES.filter((_, i) => tests[i](o.title));
    assert.equal(hits.length, 1, `${JSON.stringify(o.title)} matches ${hits.length} entries`);
    const d = hits[0];
    assert.deepEqual([o.kind, o.subtype, o.protected], [d.kind, d.subtype ?? null, d.protected === true], o.title);
    used.add(d.id);
  }
  assert.deepEqual([...used].sort(), CONDOR_ROSTER_CODES.map((d) => d.id).sort(), 'every table entry, Phase 2 included, is exercised by a golden case');
});
