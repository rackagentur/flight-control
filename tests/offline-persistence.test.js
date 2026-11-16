// Synthetic-only Step 6.6 persistence and authentication boundary tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createController, TOKEN_KEY, ENDPOINT_KEY } from '../src/controller.js';
import { ROSTER_KEY, sourceIdentity, acceptedSnapshot, restoreRecord } from '../src/roster-storage.js';
import { ApiError } from '../src/api/appscript.js';
import { loadGs, fakeEnv } from './gs-harness.js';
import { NOW, feedEvents, syncedEvents, hotelRows } from './fixtures/condor-feed.synthetic.mjs';
import { PROFILE, loadFixture } from './helpers.js';
import { opTime, opShift } from '../src/lib/op-time.js';
import { syncStatusText } from '../src/ui/sync-status.js';

const TOKEN = 'test-token-0123456789abcdef';
const ENDPOINT = `https://script.google.com/macros/s/${'A'.repeat(30)}/exec`;
const gs = loadGs(), feed = feedEvents();
const { env } = fakeEnv(gs, { now: NOW, feed, synced: syncedEvents(), rows: hotelRows(feed) });
const payload = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'roster', token: TOKEN }), env)));
const clone = (value) => structuredClone(value);
const turn = () => new Promise((r) => setTimeout(r, 0));
function harness() {
  const m = new Map(); let fail = false, online = true, time = NOW, response = payload, calls = 0;
  let post = null, fetch = null;
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { if (fail) throw new Error('quota'); m.set(k, v); }, removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i], get length() { return m.size; } };
  const store = createStore(storage); store.set(ENDPOINT_KEY, ENDPOINT); store.set(TOKEN_KEY, TOKEN);
  const api = { postContract: async (_url, body) => { calls++; if (post) return post(body); if (body.action === 'history') return { data: { ok: false } }; if (response instanceof Error) throw response; return { data: response }; }, fetchStats: async () => { if (fetch) return fetch(); throw new ApiError('network', 'offline'); } };
  const make = () => createController({ profile: PROFILE, store, api, clock: () => time, isOnline: () => online, onChange: () => {} });
  return { store, m, make, get calls() { return calls; }, fail: (v) => { fail = v; }, online: (v) => { online = v; }, time: (v) => { time = v; }, respond: (v) => { response = v; }, post: (v) => { post = v; }, fetch: (v) => { fetch = v; } };
}

test('online save, offline restart and Local/UTC preserve canonical data; readiness needs both stores', async () => {
  const h = harness(); let c = h.make(); await c.load(); await turn();
  const original = h.store.getJSON(ROSTER_KEY); assert.ok(original); assert.equal(c.view().offlineReady, false);
  c.setShellReady(true); assert.equal(c.view().offlineReady, true);
  h.online(false); c = h.make(); const before = h.calls; await c.load();
  assert.equal(h.calls, before); assert.equal(c.view().snapshot.source.kind, 'cache');
  assert.equal(c.view().snapshot.sectors.length, payload.sectors.length);
  assert.deepEqual(h.store.getJSON(ROSTER_KEY), original);
  for (const sector of c.view().snapshot.sectors) {
    const wire = payload.sectors.find((s) => s.id === sector.id);
    assert.equal(sector.dep, wire.dep); assert.equal(sector.arr, wire.arr);
    assert.ok(opTime(sector.dep, sector.originTz, 'utc'));
    assert.ok(opTime(sector.dep, sector.originTz, 'local'));
    assert.equal(opShift(sector.dep, sector.originTz, sector.arr, sector.destTz, 'utc'), opShift(wire.dep, wire.originTz, wire.arr, wire.destTz, 'utc'));
  }
  assert.match(syncStatusText(c.view()), /Offline · Saved roster.*Last sync.*Offline setup incomplete/);
});

test('malformed, incomplete and unexpectedly empty responses leave saved bytes and timestamp unchanged', async () => {
  const h = harness(), c = h.make(); await c.load(); await turn(); const before = h.store.get(ROSTER_KEY);
  const cases = [null, { ok: true }, { ...payload, sectors: 'bad' }, { ...payload, sectors: [null] },
    { ...payload, events: [], sectors: [], duties: [], windows: [], stays: [] },
    { ...payload, coverage: { ...payload.coverage, days: payload.coverage.days.slice(1) } },
    { ...payload, duties: [] }, { ...payload, windows: [] },
    { ...payload, sectors: payload.sectors.slice(1) }];
  for (const value of cases) { h.respond(value); h.time(NOW + 600000); await c.load({ force: true }); assert.equal(h.store.get(ROSTER_KEY), before); assert.equal(c.view().lastSyncedAt, NOW); }
});

test('OFF-only, leave-only and standby-only rosters remain acceptable without flights', () => {
  for (const predicate of [(e) => e.kind === 'off' && e.subtype === 'off', (e) => e.kind === 'off' && e.subtype === 'leave', (e) => e.kind === 'standby']) {
    const subset = feed.filter((raw) => predicate(gs.fcv2ClassifyEvent_(raw, gs.FCV2_CONDOR_CONFIG_)));
    assert.ok(subset.length);
    const { env: limited } = fakeEnv(gs, { now: NOW, feed: subset });
    const p = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'roster', token: TOKEN }), limited)));
    const snapshot = acceptedSnapshot('v2', p, PROFILE, NOW);
    assert.equal(snapshot.sectors.length, 0); assert.ok(snapshot.windows.length);
  }
});

test('legacy malformed entries are rejected, unknown airports keep UTC fallback', () => {
  const legacy = loadFixture(); legacy.upcoming.push({ flightNumber: 'BAD' });
  assert.throws(() => acceptedSnapshot('v5', legacy, PROFILE, NOW), /malformed legacy/);
  const p = clone(payload); p.sectors[0].originTz = 'Not/AZone'; p.sectors[0].origin = 'QQQ';
  const s = acceptedSnapshot('v2', p, PROFILE, NOW).sectors.find((s) => s.id === p.sectors[0].id);
  assert.equal(s.originTz, null); assert.match(opTime(s.dep, s.originTz, 'local'), /UTC/);
});

test('failed write retains old record and visible roster; first failure never claims saved readiness', async () => {
  const h = harness(), c = h.make(); await c.load(); await turn(); const before = h.store.get(ROSTER_KEY);
  h.fail(true); h.time(NOW + 600000); c.setShellReady(true); await c.load({ force: true });
  assert.equal(h.store.get(ROSTER_KEY), before); assert.equal(c.view().storageError, true); assert.equal(c.view().lastSyncedAt, NOW);
  const h2 = harness(); h2.fail(true); const c2 = h2.make(); c2.setShellReady(true); await c2.load();
  assert.ok(c2.view().snapshot); assert.equal(c2.view().offlineReady, false); assert.equal(c2.view().savedRoster, false); assert.equal(c2.view().lastSyncedAt, null);
  assert.equal(createStore().setJSON('x', {}), false);
  h2.online(false);
  assert.match(syncStatusText(c2.view()), /Roster in memory only/);
  assert.doesNotMatch(syncStatusText(c2.view()), /Available offline/);
});

test('migration picks newest VALID legacy cache, removes originals only after saving, preserves fetch time', async () => {
  const h = harness(); h.online(false);
  h.store.setJSON('cache.v5', { payload: loadFixture(), fetchedAt: NOW - 1000 });
  h.store.setJSON('cache.v2', { payload: { ...payload, sectors: null }, fetchedAt: NOW });
  const c = h.make(); await c.load();
  assert.equal(c.view().snapshot.source.id, 'fc-appscript-v5'); assert.equal(c.view().lastSyncedAt, NOW - 1000);
  assert.equal(h.store.get('cache.v5'), null); assert.equal(h.store.get('cache.v2'), null);
  const h2 = harness(); h2.online(false); h2.store.setJSON('cache.v2', { payload, fetchedAt: NOW }); h2.fail(true);
  await h2.make().load(); assert.ok(h2.store.get('cache.v2')); assert.equal(h2.store.get(ROSTER_KEY), null);
});

test('source identity isolates endpoint and token; corrupt/future records never migrate legacy remnants', async () => {
  const h = harness(); await h.make().load(); await turn(); h.online(false);
  h.store.set(TOKEN_KEY, 'different-token'); const changed = h.make(); await changed.load(); assert.equal(changed.view().snapshot, null);
  h.store.set(TOKEN_KEY, TOKEN); h.store.set(ENDPOINT_KEY, ENDPOINT.replace('A', 'B')); const other = h.make(); await other.load(); assert.equal(other.view().snapshot, null);
  const identity = await sourceIdentity(ENDPOINT, TOKEN);
  h.store.setJSON('cache.v5', { payload: loadFixture(), fetchedAt: NOW });
  for (const value of ['broken', JSON.stringify({ ...h.store.getJSON(ROSTER_KEY), version: 99 })]) {
    h.store.set(ROSTER_KEY, value); assert.equal(restoreRecord(h.store, identity, PROFILE, true).record, null);
  }
});

test('expired credentials keep saved roster; explicit sign-out suppresses even an open fallback', async () => {
  const h = harness(), c = h.make(); await c.load(); await turn();
  h.post(async () => ({ data: { ok: false, error: 'unauthorized' } })); await c.load({ force: true });
  assert.ok(c.view().snapshot); assert.ok(h.store.get(ROSTER_KEY));
  c.removeToken(); const before = h.calls; await c.load({ force: true }); await h.make().load();
  assert.equal(h.calls, before); assert.equal(h.store.get(ROSTER_KEY), null); assert.equal(h.store.get(TOKEN_KEY), null);
});

test('sign-out/reset invalidate deferred roster AND history; cannot restore sensitive data', async () => {
  for (const action of ['roster', 'history']) for (const reset of [false, true]) {
    const h = harness(); let release;
    h.post((body) => body.action === action ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ data: payload }));
    const c = h.make(); const pending = c.load(); while (!release) await turn();
    if (reset) c.resetLocalData(); else c.removeToken();
    release({ data: action === 'roster' ? payload : { ok: true, contract: 'fc.roster', version: 2, action: 'history', sectors: payload.sectors } });
    await pending; await turn(); assert.equal(h.store.get(ROSTER_KEY), null); assert.equal(c.view().snapshot, null);
  }
});

test('reconnection deduplicates requests, does not request while offline, and replaces only after success', async () => {
  const h = harness(), c = h.make(); await c.load(); await turn(); h.online(false); const before = h.calls;
  c.connectivityChanged(); c.tick(); assert.equal(h.calls, before);
  let release; h.post((body) => body.action === 'roster' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ data: { ok: false } }));
  h.online(true); h.time(NOW + 600000); const p = c.connectivityChanged(); c.connectivityChanged(); c.tick();
  while (!release) await turn(); assert.equal(h.calls, before + 1);
  release({ data: payload }); await p; assert.equal(c.view().lastSyncedAt, NOW + 600000);
});

test('explicit reset reports blocked deletion and clears in-memory data anyway', async () => {
  const h = harness(), c = h.make(); await c.load();
  h.store.clearAllChecked = () => false;
  assert.equal(c.resetLocalData(), false); assert.equal(c.view().snapshot, null); assert.equal(c.view().storageError, true);
});

test('backend-built point events survive save/restart, including local midnight; reversed intervals fail', async () => {
  for (const title of ['C/I', 'P/U', 'XYZ7', 'SB90']) {
    const raw = { ...feed[0], sourceId: `point-${title}`, title, start: Date.parse('2026-10-06T22:00:00Z'), end: Date.parse('2026-10-06T22:00:00Z'), description: '', location: 'FRA' };
    const { env: pointEnv } = fakeEnv(gs, { now: NOW, feed: [...feed, raw] });
    const data = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'roster', token: TOKEN }), pointEnv)));
    assert.ok(data.events.some((e) => e.start === raw.start && e.end === raw.end));
    const h = harness(); h.respond(data); await h.make().load(); await turn();
    assert.deepEqual(h.store.getJSON(ROSTER_KEY).payload, data);
    h.online(false); const restarted = h.make(); await restarted.load(); assert.ok(restarted.view().snapshot);
    const reversed = clone(data); reversed.events.find((e) => e.start === raw.start).end--;
    assert.throws(() => acceptedSnapshot('v2', reversed, PROFILE, NOW));
  }
});

test('saved v5 refresh survives v2 HTTP/validation failures and later upgrades to recovered v2', async () => {
  for (const failure of [new ApiError('http', 'synthetic 500'), { ...payload, windows: [] }]) {
    const h = harness(); h.respond(failure); h.fetch(async () => ({ data: loadFixture() }));
    const c = h.make(); await c.load(); assert.equal(c.view().contract.active, 'v5');
    h.time(NOW + 600000); await c.load({ force: true });
    assert.equal(c.view().error, null); assert.equal(c.view().lastSyncedAt, NOW + 600000);
    h.respond(payload); h.time(NOW + 1200000); await c.load({ force: true });
    assert.equal(c.view().contract.active, 'v2'); assert.equal(h.store.getJSON(ROSTER_KEY).contract, 'v2');
    const before = h.store.get(ROSTER_KEY); h.respond(failure); await c.load({ force: true });
    assert.equal(h.store.get(ROSTER_KEY), before); assert.equal(c.view().contract.active, 'v2');
  }
});

test('open backend becoming protected revokes saved roster and persists revocation offline', async () => {
  const h = harness(); h.store.remove(TOKEN_KEY); h.fetch(async () => ({ data: loadFixture() }));
  const c = h.make(); await c.load(); assert.ok(c.view().snapshot); assert.ok(h.store.get(ROSTER_KEY));
  h.fetch(async () => { throw new ApiError('auth-required', 'synthetic policy change'); });
  await c.refresh(); assert.equal(c.view().snapshot, null); assert.equal(h.store.get(ROSTER_KEY), null);
  assert.equal(c.view().error.code, 'auth-required'); assert.equal(h.store.get('signedOut'), 'true');
  h.online(false); const restarted = h.make(); await restarted.load(); assert.equal(restarted.view().snapshot, null);
});

test('empty and partially adaptable history retain last good history and respect daily policy across restart', async () => {
  for (const sectors of [[], [{ ...payload.sectors[0], origin: 'NOT-IATA' }]]) {
    const h = harness(); let calls = 0;
    const good = JSON.parse(JSON.stringify(gs.fcv2HandlePost_(JSON.stringify({ contract: 'fc.roster', version: 2, action: 'history', token: TOKEN }), env)));
    let response = good;
    h.post(async (body) => { if (body.action === 'history') { calls++; return { data: response }; } return { data: payload }; });
    let c = h.make(); await c.load(); await turn(); const previous = h.store.getJSON(ROSTER_KEY).serverHistory;
    assert.ok(previous.sectors.length); response = { ...good, sectors };
    h.time(NOW + 86400000); await c.refresh(); await turn(); assert.equal(calls, 2);
    assert.deepEqual(h.store.getJSON(ROSTER_KEY).serverHistory, previous);
    h.time(NOW + 86400000 + 600000); c = h.make(); await c.load(); await turn(); assert.equal(calls, 2);
    h.time(NOW + 2 * 86400000); await c.refresh(); await turn(); assert.equal(calls, 3);
  }
});

test('manual refresh tries network despite false navigator hint; automatic loads stay offline', async () => {
  const h = harness(), c = h.make(); h.online(false); await c.load(); c.tick(); c.connectivityChanged(); assert.equal(h.calls, 0);
  await c.refresh(); await turn(); assert.ok(h.calls); assert.ok(c.view().snapshot);
});

test('reconnect during failed pending request schedules one immediate retry, sign-out cancels it', async () => {
  for (const revoke of [false, true]) {
    const h = harness(); let release, attempts = 0;
    h.post(async (body) => {
      if (body.action !== 'roster') return { data: { ok: false } };
      attempts++;
      if (attempts === 1) return new Promise((resolve, reject) => { release = () => reject(new ApiError('network', 'synthetic disconnect')); });
      return { data: payload };
    });
    const c = h.make(), loading = c.load(); while (!release) await turn();
    h.online(false); c.connectivityChanged(); h.online(true); c.connectivityChanged(); c.connectivityChanged();
    if (revoke) c.removeToken(); release(); await loading; await turn(); await turn();
    assert.equal(attempts, revoke ? 1 : 2); assert.equal(!!c.view().snapshot, !revoke);
  }
});

test('disconnect reports no source and removes credentials and saved roster', async () => {
  const h = harness(), c = h.make(); await c.load(); c.removeToken({ disconnect: true });
  assert.equal(c.view().error, null); assert.equal(c.view().snapshot, null); assert.equal(h.store.get(ENDPOINT_KEY), null);
});
