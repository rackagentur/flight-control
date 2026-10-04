// Transport: endpoint validation and every failure class, with a mocked fetch (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, fetchStats, contractGaps, ApiError } from '../src/api/appscript.js';
import { loadFixture } from './helpers.js';

// Synthetic, obviously fake deployment id: 30 'x' characters.
const URL_OK = `https://script.google.com/macros/s/${'x'.repeat(30)}/exec`;

const respond = (body, { status = 200, type = 'application/json' } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => type },
  text: async () => body,
});

test('only Apps Script /exec URLs are accepted', () => {
  assert.ok(validateEndpoint(URL_OK).ok);
  assert.ok(validateEndpoint(`  ${URL_OK}  `).ok);
  for (const bad of ['', 'http://script.google.com/macros/s/abc/exec', 'https://evil.example/macros/s/xxxxxxxxxxxxxxxxxxxxxxxx/exec',
    `${URL_OK}?action=sync`, `https://script.google.com/macros/s/${'x'.repeat(30)}/dev`]) {
    assert.equal(validateEndpoint(bad).ok, false, bad);
  }
});

test('success: parsed data plus timing meta, simple GET without credentials', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return respond(JSON.stringify({ success: true, upcoming: [] }))(); };
  const { data, meta } = await fetchStats(URL_OK, { fetchImpl });
  assert.equal(data.success, true);
  assert.equal(seen.url, `${URL_OK}?action=getStats`);
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.headers, undefined, 'no custom headers → no CORS preflight');
  assert.ok(meta.bytes > 0);
});

test('failure classes map to explicit error codes', async () => {
  const cases = [
    [respond('<!doctype html><title>Error</title>', { type: 'text/html' }), 'html-response'],
    [respond('{nope'), 'invalid-json'],
    [respond(JSON.stringify({ success: false, message: 'boom' })), 'backend-error'],
    [respond('Server error', { status: 500, type: 'text/plain' }), 'http'],
    [async () => { throw new TypeError('Failed to fetch'); }, 'network'],
  ];
  for (const [fetchImpl, code] of cases) {
    await assert.rejects(fetchStats(URL_OK, { fetchImpl }), (e) => e instanceof ApiError && e.code === code, code);
  }
});

test('timeout aborts and reports', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  }));
  await assert.rejects(fetchStats(URL_OK, { fetchImpl, timeoutMs: 20 }), (e) => e.code === 'timeout');
});

test('missing or invalid configuration never issues a request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; };
  await assert.rejects(fetchStats('', { fetchImpl }), (e) => e.code === 'not-configured');
  await assert.rejects(fetchStats('https://example.com/exec', { fetchImpl }), (e) => e.code === 'invalid-endpoint');
  assert.equal(called, false);
});

test('contract check: the synthetic fixture satisfies the v5 contract; gaps are named', () => {
  const fx = loadFixture();
  assert.deepEqual(contractGaps(fx), []);
  delete fx.dutyBlock;
  delete fx.upcoming[0].pickupTimestamp;
  assert.deepEqual(contractGaps(fx).sort(), ['dutyBlock.current', 'dutyBlock.maxThisMonth', 'dutyBlock.nextOffInDays', 'upcoming[].pickupTimestamp'].sort());
});
