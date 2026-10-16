// iPhone preview tooling (docs/IPHONE-ACCEPTANCE.md): the staged site holds only the offline shell's
// files, and the generated SYNTHETIC test backend serves contract v2 that the real frontend accepts,
// with each failure mode the acceptance run needs. Nothing here deploys or contacts a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { stage, precacheList, PREVIEW_CONFIG } from '../scripts/preview/stage.mjs';
import { generate, MANIFEST, MODES } from '../scripts/preview/gen-test-backend.mjs';
import { localDate, localIso } from './gs-harness.js';
import { validateRoster, validateHistory } from '../src/sources/contract-v2.js';
import { adaptV2 } from '../src/sources/fc-appscript-v2.js';
import { PROFILE } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

test('stage: only sw.js, the precached shell files and vercel.json; byte-identical copies', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'fc-stage-')), 'site');
  try {
    const { files } = stage(out);
    const assets = precacheList(readFileSync(join(root, 'sw.js'), 'utf8'));
    const expected = ['sw.js', 'vercel.json', ...assets.map((a) => a.path)].sort();
    const staged = walk(out).map((f) => relative(out, f).replaceAll('\\', '/')).sort();
    assert.deepEqual(staged, expected);
    assert.deepEqual(files, expected);
    for (const p of staged) {
      assert.ok(!/^(reference|docs|tests|backend|scripts|legacy|\.claude|\.git)\//.test(p), `${p} must not be staged`);
      if (p !== 'vercel.json') assert.ok(readFileSync(join(out, p)).equals(readFileSync(join(root, p))), `${p} copied unchanged`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'vercel.json'), 'utf8')), JSON.parse(JSON.stringify(PREVIEW_CONFIG)));
  } finally { rmSync(dirname(out), { recursive: true, force: true }); }
});

test('stage: refuses a directory inside the repository or a non-empty directory', () => {
  assert.throws(() => stage(join(root, 'preview-site')), /inside the repository/);
  assert.throws(() => stage(root), /inside the repository/);
  const dir = mkdtempSync(join(tmpdir(), 'fc-stage-'));
  try {
    writeFileSync(join(dir, 'stray.txt'), 'x');
    assert.throws(() => stage(dir), /empty or absent/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preview config: worker and entry document are revalidated; preview is not indexed', () => {
  const find = (source) => PREVIEW_CONFIG.headers.find((h) => h.source === source)?.headers ?? [];
  for (const source of ['/', '/index.html', '/sw.js']) assert.ok(find(source).some((h) => h.key === 'Cache-Control' && h.value === 'no-cache'), source);
  assert.ok(find('/(.*)').some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)));
});

// --- Synthetic test backend ------------------------------------------------------------------

function loadBackend({ props = {}, now = Date.now() } = {}) {
  const store = { ...props };
  const sleeps = [];
  const cache = new Map();
  const sandbox = {
    console,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in store ? store[k] : null) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    Utilities: {
      formatDate(date, tz, pattern) {
        if (pattern === 'yyyy-MM-dd') return localDate(date.getTime(), tz);
        if (pattern === "yyyy-MM-dd'T'HH:mmXXX") return localIso(date.getTime(), tz).replace(/\+00:00$/, 'Z');
        throw new Error(`pattern not faked: ${pattern}`);
      },
      computeDigest: (_alg, text) => [...createHash('sha256').update(text).digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      sleep: (ms) => sleeps.push(ms),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(generate(), sandbox);
  const post = (action, token = props.FC_TEST_TOKEN, extra = {}) =>
    JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ contract: 'fc.roster', version: 2, action, token, ...extra }) } }).text);
  const get = (params) => JSON.parse(sandbox.doGet({ parameter: params }).text);
  return { post, get, sleeps, store };
}

const TOKEN = 'synthetic-preview-token-0123456789';

test('test backend: synthetic roster around today is accepted by the real frontend validator and adapter', () => {
  const now = Date.now();
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN }, now });
  const caps = b.post('capabilities');
  assert.equal(caps.ok, true);
  assert.deepEqual(caps.actions, ['capabilities', 'roster', 'history', 'stats'], 'no departures action');
  const roster = b.post('roster');
  assert.equal(validateRoster(roster).ok, true, validateRoster(roster).reason);
  assert.ok(roster.sectors.length >= 5, 'flights present');
  assert.ok(roster.sectors.some((s) => s.dep > now), 'upcoming flights');
  assert.ok(roster.sectors.some((s) => s.aircraft), 'aircraft line parsed');
  assert.ok(roster.stays.some((s) => s.hotel?.location?.status === 'verified'), 'one verified synthetic hotel pin');
  const snapshot = adaptV2(roster, { profile: PROFILE, fetchedAt: now });
  assert.ok(snapshot.sectors.length >= 5);
  const history = b.post('history');
  assert.equal(validateHistory(history).ok, true);
  assert.equal(b.post('stats').success, true);
});

test('test backend: wrong or missing token, and no token configured, are refused', () => {
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN } });
  assert.equal(b.post('roster', 'wrong-token').error, 'unauthorized');
  assert.equal(b.post('roster', null).error, 'unauthorized');
  assert.equal(loadBackend().post('roster', TOKEN).error, 'not-configured');
});

test('test backend: modes timeout, malformed, empty and auth behave as the run sheet expects', () => {
  const props = { FC_TEST_TOKEN: TOKEN };
  const t = loadBackend({ props: { ...props, FC_TEST_MODE: 'timeout' } });
  assert.equal(t.post('roster').ok, true);
  assert.ok(t.sleeps[0] > 25000, 'sleeps beyond the 25 s client timeout');
  const m = loadBackend({ props: { ...props, FC_TEST_MODE: 'malformed' } }).post('roster');
  assert.equal(validateRoster(m).ok, false);
  const e = loadBackend({ props: { ...props, FC_TEST_MODE: 'empty' } }).post('roster');
  assert.equal(validateRoster(e).ok, true);
  assert.equal(e.events.length, 0);
  assert.equal(loadBackend({ props: { ...props, FC_TEST_MODE: 'auth' } }).post('capabilities').error, 'unauthorized');
  assert.equal(loadBackend({ props: { ...props, FC_TEST_MODE: 'nonsense' } }).post('roster').ok, true, 'unknown mode = valid');
  assert.deepEqual(MODES, ['valid', 'timeout', 'malformed', 'empty', 'auth']);
});

test('test backend: GET never serves data; manifest is an anonymous web app executing as the deployer', () => {
  const b = loadBackend({ props: { FC_TEST_TOKEN: TOKEN } });
  assert.equal(b.get({ action: 'getStats' }).error, 'auth-required');
  assert.equal(b.get({}).success, false);
  assert.deepEqual(MANIFEST.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
});

test('test backend source: synthetic data only, no production configuration names are read', () => {
  const src = generate();
  const testSection = src.slice(src.indexOf('SYNTHETIC TEST BACKEND'));
  for (const name of ['SOURCE_CALENDAR_ID', 'TARGET_CALENDAR_ID', 'HOTEL_SPREADSHEET_ID', 'CalendarApp', 'SpreadsheetApp', 'UrlFetchApp', 'FC_V2_TOKEN'])
    assert.ok(!testSection.includes(name), `test section must not use ${name}`);
  assert.match(src, /Sample Riverside Hotel/);
});
