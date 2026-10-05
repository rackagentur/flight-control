// Transport: endpoint validation and every failure class, with a mocked fetch (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, fetchStats, fetchStatsSecure, contractGaps, ApiError } from '../src/api/appscript.js';
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

// --- BH-2: the v5 payload behind the access token ---------------------------------------

test('BH-2: a GET refused with auth-required is its own error class', async () => {
  const fetchImpl = respond(JSON.stringify({ success: false, error: 'auth-required', message: 'Authentication required.' }));
  await assert.rejects(fetchStats(URL_OK, { fetchImpl }), (e) => e instanceof ApiError && e.code === 'auth-required' && /access token/.test(e.message));
});

/** A fake transport recording the order of calls; post/get answer per scenario. */
function fakeApi({ post, get }) {
  const calls = [];
  return {
    calls,
    api: {
      postContract: async (endpoint, body) => { calls.push(['post', body.action, body.token]); return post(body); },
      fetchStats: async (endpoint) => { calls.push(['get']); return get(); },
    },
  };
}
const V5 = { success: true, upcoming: [] };
const ok = async () => ({ data: V5, meta: { ms: 1, bytes: 2 } });
const authRequired = async () => { throw new ApiError('auth-required', 'This roster backend requires the access token.'); };

test('BH-2: with a token the payload is read by authenticated POST; GET is not used', async () => {
  const f = fakeApi({ post: async () => ({ data: V5, meta: {} }), get: ok });
  const r = await fetchStatsSecure(URL_OK, 'tok', f.api);
  assert.equal(r.via, 'post');
  assert.deepEqual(r.data, V5);
  assert.deepEqual(f.calls, [['post', 'stats', 'tok']], 'token only in the POST body; no GET');
});

test('BH-2: an older backend (unknown-action) or the migration window falls back to GET', async () => {
  for (const post of [async () => ({ data: { ok: false, error: 'unknown-action' } }), async () => { throw new ApiError('html-response', 'x'); }, async () => { throw new ApiError('timeout', 'x'); }]) {
    const f = fakeApi({ post, get: ok });
    const r = await fetchStatsSecure(URL_OK, 'tok', f.api);
    assert.equal(r.via, 'get');
    assert.deepEqual(f.calls.map((c) => c[0]), ['post', 'get']);
  }
});

test('BH-2: without a token only GET is tried; once GET is closed the error says the token is needed', async () => {
  const f = fakeApi({ post: async () => { throw new Error('must not POST without a token'); }, get: authRequired });
  await assert.rejects(fetchStatsSecure(URL_OK, null, f.api), (e) => e.code === 'auth-required' && /access token/.test(e.message));
  assert.deepEqual(f.calls, [['get']]);
});

test('BH-2: a refused token is named when GET is closed too', async () => {
  const cases = [['unauthorized', /not accepted/], ['rate-limited', /too many failed/], ['not-configured', /no access token configured/]];
  for (const [error, message] of cases) {
    const f = fakeApi({ post: async () => ({ data: { ok: false, error } }), get: authRequired });
    await assert.rejects(fetchStatsSecure(URL_OK, 'bad', f.api), (e) => e.code === 'auth-required' && message.test(e.message), error);
  }
});

