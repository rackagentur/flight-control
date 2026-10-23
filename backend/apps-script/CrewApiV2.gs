// ============================================================================
// FLIGHT CONTROL — CREW INTELLIGENCE: ACTION HANDLERS (Phase 1b, simulated only)
// ============================================================================
// NOT DEPLOYED and NOT ROUTED: RosterApiV2.gs / RouterV2.gs never call this file. Tests drive
// fcv2CrewHandle_ with fake services. Actions (spec §3, §4, §7, §8):
//   crewEnroll {code, grant}   owner-issued single-use code (Script Property FC_CREW_ENROLL) → crew grant
//   crewIndex  {verifyBefore?, retryUncovered?} bounded, resumable indexing / re-verification / capacity recovery
//   crew       {sectorId, date} crew of one owned sector with recorded familiarity before it
//   crewRevoke {revokeId}      idempotent revocation and namespace-safe deletion (never gated); for a grant that is
//                              not live it records a tombstone instead (state 'cancelled', §8.7)
// Editor-only (not routable): crewPurgeAll() — owner-confirmed purge of every crew record (§8.3).
// Every request carries the roster token; every action except crewEnroll and crewRevoke-retries also
// needs the crew grant. Responses are built field by field from an allow-list; employee ids, keyed
// hashes, crew bases and index internals never leave. Nothing is logged; any unexpected error becomes
// {ok:false, error:"crew-unavailable"} without details.
//
// env (all injected): {
//   token(), now(), config,                       // FCV2_CONDOR_CONFIG_
//   props: { get, set, del },                     // Script Properties (owner secrets, FC_CREW_STATE)
//   store: { keys, get, set, del },               // User Properties (only fcx.* is touched)
//   cache: { get, put(k, v, ttlSec), removeAll(keys) },
//   lock(fn) -> { ok: true, value } | { ok: false } (script lock, short wait),
//   readRaw(from, to) -> raw events (synced copy before today, airline feed from today: D-SRC),
//   deps: { hash, hmacHex(pepper, text), hmacKey(pepper, text), pack, unpack, monthStart, monthOf,
//           localDate(ms), dayStart(dateKey), newId() }
// }
// ============================================================================

const FCV2_CREW_ACTIONS_ = ['crewEnroll', 'crewIndex', 'crew', 'crewRevoke'];
const FCV2_CREW_RATE_MAX_ = 60;
const FCV2_CREW_RATE_KEY_ = 'fcv2-crew-rate';
const FCV2_CREW_ENROLL_FAILURES_KEY_ = 'fcv2-crew-enroll-failures';
const FCV2_CREW_INDEX_MAX_MONTHS_ = 6;
const FCV2_CREW_INDEX_BUDGET_MS_ = 15000;
const FCV2_CREW_MEMBER_FIELDS_ = ['rank', 'family', 'given', 'match', 'count', 'last', 'recordedMatch', 'asOfRecorded'];

function fcv2CrewState_(env) {
  const raw = env.props.get('FC_CREW_STATE');
  if (!raw) return fcv2CrewInitialState_();
  try { return JSON.parse(raw); } catch (err) { return fcv2CrewInitialState_(); }
}

function fcv2CrewSettings_(env) {
  const pepper = env.props.get('FC_CREW_PEPPER');
  const self = env.props.get('FC_CREW_SELF');
  const enabled = env.props.get('FC_CREW_ENABLED') === 'on' && !!pepper && !!self;
  return { enabled: enabled, pepper: pepper, self: self, pid: pepper ? env.deps.hash('pid|' + pepper).slice(0, 8) : null };
}

/** Core context: keyed 128-bit colleague keys and pepper-keyed fingerprints. */
function fcv2CrewCtx_(env, s, now) {
  return {
    now: now, selfId: s.self, deps: env.deps,
    keyOf: function (id) { return env.deps.hmacKey(s.pepper, 'id|' + id); },
    hmac: function (text) { return env.deps.hmacHex(s.pepper, text); },
  };
}

function fcv2CrewCoreEnv_(env, now) {
  return {
    getState: function () { return fcv2CrewState_(env); },
    setState: function (st) { env.props.set('FC_CREW_STATE', JSON.stringify(st)); },
    store: env.store, now: now, deps: env.deps, hash: env.deps.hash,
    cacheRemove: function (keys) { if (keys && keys.length) env.cache.removeAll(keys); },
    lock: function (fn) {
      const r = env.lock(fn);
      if (!r.ok) throw { crewBusy: true };
      return r.value;
    },
  };
}

function fcv2CrewMonthList_(fromMonth, toMonth) {
  const out = [];
  for (let m = fromMonth; m <= toMonth; m = fcv2CrewNextMonth_(m)) out.push(m);
  return out;
}

/** Months that may hold a durable shard today: on/after the 8th of the following month. */
function fcv2CrewSealableMonths_(config, todayKey) {
  const first = config.historyStart.slice(0, 7);
  return fcv2CrewMonthList_(first, todayKey.slice(0, 7)).filter(function (m) { return todayKey >= fcv2CrewNextMonth_(m) + '-08'; });
}

function fcv2CrewIsDate_(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
}

/** Entry point for the simulated environment. */
function fcv2CrewHandle_(body, env) {
  try {
    if (typeof body !== 'string' || !body || body.length > 8192) return { ok: false, error: 'bad-request' };
    let req;
    try { req = JSON.parse(body); } catch (err) { return { ok: false, error: 'bad-request' }; }
    if (!req || typeof req !== 'object') return { ok: false, error: 'bad-request' };
    const expected = env.token();
    if (!expected) return { ok: false, error: 'not-configured' };
    if (typeof req.token !== 'string' || !fcv2CrewSafeEqual_(req.token, expected)) return { ok: false, error: 'unauthorized' };
    if (req.contract !== 'fc.roster' || req.version !== 2) return { ok: false, error: 'unsupported-contract' };
    if (FCV2_CREW_ACTIONS_.indexOf(req.action) < 0) return { ok: false, error: 'unknown-action' };
    if (req.action === 'crewRevoke') return fcv2CrewHandleRevoke_(req, env);   // never gated, never rate-limited
    const rateKey = FCV2_CREW_RATE_KEY_ + '-' + Math.floor(env.now() / 600000);   // fixed 10-minute windows
    const count = Number(env.cache.get(rateKey) || 0);
    if (count >= FCV2_CREW_RATE_MAX_) return { ok: false, error: 'rate-limited' };
    env.cache.put(rateKey, String(count + 1), 600);
    const s = fcv2CrewSettings_(env);
    if (!s.enabled) return { ok: false, error: 'crew-disabled' };
    if (req.action === 'crewEnroll') return fcv2CrewHandleEnroll_(req, env, s);
    const state = fcv2CrewState_(env);
    if (state.phase === 'active' && state.pid !== s.pid) return fcv2CrewRotate_(env);
    const grantHash = typeof req.grant === 'string' ? env.deps.hash(req.grant) : '';
    // An interrupted revocation (client or system, e.g. pepper rotation) is completed by the app that holds
    // the grant it recorded; this only deletes data, it never grants access (§8.5).
    if (state.phase === 'revoking' && state.revoke && grantHash && fcv2CrewSafeEqual_(state.revoke.credHash, grantHash)) {
      const r = fcv2CrewRevoke_(fcv2CrewCoreEnv_(env, env.now()), { revokeId: state.revoke.revokeId, grant: req.grant });
      return { ok: false, error: r.ok ? 'crew-revoked' : (r.error || 'revoke-incomplete') };
    }
    if (!fcv2CrewAuthorized_(state, grantHash, s.pid)) return { ok: false, error: state.phase === 'active' ? 'unauthorized' : 'crew-not-enrolled' };
    const result = req.action === 'crewIndex' ? fcv2CrewHandleIndex_(req, env, s, state) : fcv2CrewHandleCrew_(req, env, s, state);
    if (!result.ok) return result;
    // Final response authorisation (§4.0 rule 3): nothing computed under an older generation is returned.
    if (!fcv2CrewFinalCheck_(state, fcv2CrewState_(env), grantHash, s.pid)) return { ok: false, error: 'crew-revoked' };
    return result;
  } catch (err) {
    if (err && err.crewBusy) return { ok: false, error: 'busy' };
    return { ok: false, error: 'crew-unavailable' };
  }
}

function fcv2CrewHandleEnroll_(req, env, s) {
  const lock = env.lock(function () {
    const now = env.now();
    const state = fcv2CrewState_(env);
    const failures = Number(env.cache.get(FCV2_CREW_ENROLL_FAILURES_KEY_) || 0);
    let cacheKeys = [];
    try { cacheKeys = JSON.parse(env.store.get(FCV2_CREW_MANIFEST_KEY_) || '{}').cacheKeys || []; } catch (err) { cacheKeys = []; }
    const r = fcv2CrewEnroll_(state, env.props.get('FC_CREW_ENROLL'), req,
      { now: now, pid: s.pid, newEpoch: env.deps.newId(), hash: env.deps.hash, failures: failures, cacheKeys: cacheKeys });
    if (r.failed) env.cache.put(FCV2_CREW_ENROLL_FAILURES_KEY_, String(failures + 1), 900);
    if (r.burn) env.props.del('FC_CREW_ENROLL');
    if (r.consume) {
      env.props.del('FC_CREW_ENROLL');                                 // consume first, then grant (§4.2)
      env.props.set('FC_CREW_STATE', JSON.stringify(r.state));
      // The previous generation's index (if any) is obsolete: purge it now; a failure stays pending in
      // state.purge and is resumed by the next crewIndex (§8.6). Old data is never read under the new G.
      fcv2CrewResumePurge_(fcv2CrewCoreEnv_(env, now));
    }
    return r.result;
  });
  if (!lock.ok) return { ok: false, error: 'busy' };
  const r = lock.value;
  return r.ok ? { ok: true, action: 'crewEnroll', enrolled: true, G: r.G } : { ok: false, error: r.error };
}

function fcv2CrewHandleRevoke_(req, env) {
  const r = fcv2CrewRevoke_(fcv2CrewCoreEnv_(env, env.now()), { revokeId: req.revokeId, grant: req.grant });
  if (!r.ok) return { ok: false, error: r.error };
  const out = { ok: true, action: 'crewRevoke', state: r.state, deletedKeys: r.deletedKeys || 0 };
  if (r.recorded) out.recorded = true;
  if (r.cacheCleared === false) out.cacheCleared = false;            // entries expire within 6 h and are unreachable
  return out;
}

/** Pepper rotation: system revoke + namespace purge (§8.5). */
function fcv2CrewRotate_(env) {
  const now = env.now();
  const lock = env.lock(function () {
    const st = fcv2CrewState_(env);
    let cacheKeys = [];
    try { cacheKeys = JSON.parse(env.store.get(FCV2_CREW_MANIFEST_KEY_) || '{}').cacheKeys || []; } catch (err) { cacheKeys = []; }
    const revoking = fcv2CrewSystemRevoke_(st, { now: now, cacheKeys: cacheKeys });
    env.props.set('FC_CREW_STATE', JSON.stringify(revoking));
    const purge = fcv2CrewPurge_(env.store);
    fcv2CrewCacheRemove_(fcv2CrewCoreEnv_(env, now), cacheKeys);
    if (purge.complete) {
      env.props.set('FC_CREW_STATE', JSON.stringify(Object.assign({}, revoking, {
        phase: 'deleted', revoke: null,
        lastRevoke: { revokeId: revoking.revoke.revokeId, G: revoking.G, outcome: 'deleted', deletedKeys: purge.deleted, at: now, credHash: fcv2CrewShortHash_(revoking.revoke.credHash) },
      })));
    }
    return true;
  });
  return lock.ok ? { ok: false, error: 'crew-revoked' } : { ok: false, error: 'busy' };
}

/** Bounded, resumable indexing and re-verification (§7.2, §7.4, §7.5). */
function fcv2CrewHandleIndex_(req, env, s, state) {
  const started = env.now();
  const todayKey = env.deps.localDate(started);
  const config = env.config;
  const reader = fcv2CrewReaderFrom_(env.readRaw, config);
  const sealable = fcv2CrewSealableMonths_(config, todayKey);
  const core = fcv2CrewCoreEnv_(env, started);
  const resumed = env.lock(function () { return fcv2CrewResumePurge_(core); });
  const outcomes = {};
  let processed = 0;
  const done = {};
  while (processed < FCV2_CREW_INDEX_MAX_MONTHS_ && env.now() - started < FCV2_CREW_INDEX_BUDGET_MS_) {
    const read = fcv2CrewManifest_(env.store, state, env.deps);
    if (read.kind === 'invalid' || read.kind === 'torn' || read.kind === 'foreign') return { ok: false, error: 'index-incompatible' };
    // read.kind 'obsolete' (an older generation not yet purged) is an empty index for this generation.
    const m = read.manifest;
    const now = env.now();
    const plan = fcv2CrewIndexPlan_(env.store, state, env.deps, sealable,
      { now: now, done: done, verifyBefore: req.verifyBefore, retryUncovered: req.retryUncovered });
    const month = plan.months[0] || null;
    if (!month) break;
    done[month] = true;
    processed++;
    const captured = { G: state.G, epoch: state.epoch, mgen: m.mgen };
    const ctx = fcv2CrewCtx_(env, s, now);
    const built = fcv2CrewBuildMonth_(month, reader, ctx);
    if (!fcv2CrewSealable_(month, built, todayKey)) { outcomes[month] = 'not-sealable'; continue; }
    const fp = fcv2CrewFingerprint_(built, ctx);
    const prev = m.months[month];
    const lock = env.lock(function () {
      core.now = env.now();
      // The unchanged-fingerprint shortcut needs a valid stored shard: a missing or corrupt shard is rebuilt
      // through the crash-safe commit, and verifiedAt is never advanced for data that is not there (§7.5d).
      if (prev && prev.status === 'ok' && prev.fp === fp && plan.reasons[month] !== 'damaged'
        && fcv2CrewMonthIntegrity_(env.store, m, month, env.deps) === 'valid') return fcv2CrewTouchMonth_(core, captured, month, now).outcome;
      const enc = fcv2CrewEncodeMonth_(built, env.deps);
      return fcv2CrewCommitMonth_(core, captured, month, {
        body: enc.body, digest: enc.digest, verifiedAt: now, missing: built.missing, grouping: built.grouping, fp: fp,
      }).outcome;
    });
    outcomes[month] = lock.ok ? lock.value : 'busy';
    if (!lock.ok) break;
  }
  const gc = env.lock(function () { core.now = env.now(); return fcv2CrewGc_(core); });
  const after = fcv2CrewManifest_(env.store, state, env.deps);
  const months = after.kind === 'ok' || after.kind === 'absent' ? after.manifest.months : {};
  const now = env.now();
  const progress = { total: sealable.length, indexed: 0, pending: 0, stale: 0, uncovered: 0 };
  const floorAfter = sealable.filter(function (x) { return months[x] && months[x].status === 'uncovered'; }).pop() || '';
  sealable.forEach(function (x) {
    const e = months[x];
    if (!e && x < floorAfter) progress.uncovered++;                    // below the storage floor: not attempted
    else if (!e) progress.pending++;
    else if (e.status === 'uncovered') progress.uncovered++;
    else if (e.status !== 'ok' || e.neighbour || now - e.verifiedAt > FCV2_CREW_FRESH_MS_) progress.stale++;
    else if (after.kind === 'ok' && fcv2CrewMonthIntegrity_(env.store, after.manifest, x, env.deps) !== 'valid') progress.stale++;   // damaged
    else progress.indexed++;
  });
  const counts = {};
  Object.keys(outcomes).forEach(function (k) { counts[outcomes[k]] = (counts[outcomes[k]] || 0) + 1; });
  return {
    ok: true, action: 'crewIndex', processed: processed, outcomes: counts, progress: progress, gcDeleted: gc.ok ? gc.value.deleted : 0,
    cleanupPending: resumed.ok ? !resumed.value.done : true,
  };
}

/** Crew of one owned sector with recorded familiarity before it (§3.3, §4.5, §6). */
function fcv2CrewHandleCrew_(req, env, s, state) {
  const config = env.config;
  if (typeof req.sectorId !== 'string' || !/^s_[0-9a-f]{16}$/.test(req.sectorId) || !fcv2CrewIsDate_(req.date)) return { ok: false, error: 'bad-request' };
  const now = env.now();
  const todayKey = env.deps.localDate(now);
  if (req.date < config.historyStart || req.date > fcv2AddDaysKey_(todayKey, 120)) return { ok: false, error: 'bad-range' };
  const reader = fcv2CrewReaderFrom_(env.readRaw, config);
  const dayStart = env.deps.dayStart(req.date);
  const day = reader(dayStart - FCV2_CREW_MARGIN_MS_, dayStart + 24 * 3600000 + FCV2_CREW_MARGIN_MS_);
  const flight = day.flights.filter(function (f) { return 's_' + env.deps.hash(String(f.sourceId)).slice(0, 16) === req.sectorId; })[0];
  if (!flight) return { ok: false, error: 'sector-not-found' };
  const base = { ok: true, contract: 'fc.roster', version: 2, action: 'crew', generatedAt: now, sectorId: req.sectorId };
  if (!flight.crew) return Object.assign(base, { crewListed: false, history: null, members: [] });
  if (!flight.crew.some(function (c) { return c.id === s.self; })) return { ok: false, error: 'sector-not-owned' };
  const ctx = fcv2CrewCtx_(env, s, now);
  const selected = fcv2CrewSelectedDuty_(flight.sourceId, flight.start, reader, ctx);
  const members = flight.crew.filter(function (c) { return c.parseFailed || c.id !== s.self; }).map(function (c) {
    if (c.parseFailed) return { rank: null, family: null, given: null, key: null };
    return { rank: c.rank, family: c.family, given: c.given, key: c.id ? ctx.keyOf(c.id) : null };
  });
  const selMonth = env.deps.monthOf(selected.found && !selected.unbounded ? selected.start : flight.start);
  const range = fcv2CrewMonthList_(config.historyStart.slice(0, 7), selMonth);
  const sealableNow = fcv2CrewSealableMonths_(config, todayKey);
  const sealed = range.filter(function (m) { return sealableNow.indexOf(m) >= 0; });
  const open = range.filter(function (m) { return sealableNow.indexOf(m) < 0; });
  const snap = fcv2CrewReadSnapshot_({ getState: function () { return fcv2CrewState_(env); }, store: env.store, now: now, deps: env.deps }, sealed);
  let result;
  // Read-only, advisory hint (§7.5b, §7.5d): the same eligibility decision crewIndex uses, restricted to this
  // answer's months. Store reads only. true = indexing is worth attempting (not a guarantee); false ≠ complete.
  const plan = fcv2CrewIndexPlan_(env.store, state, env.deps, sealableNow, { now: now });
  const indexingSuggested = plan.months.some(function (m) { return sealed.indexOf(m) >= 0; });
  if (!snap.ok) {
    result = fcv2CrewResult_({ snapshotOk: false, members: members, selected: selected, months: [], count: null });
  } else {
    const live = open.map(function (m) { return fcv2CrewBuildMonth_(m, reader, ctx); });
    const duties = Object.keys(snap.months).reduce(function (a, k) { return a.concat(snap.months[k]); }, [])
      .concat(live.reduce(function (a, b) { return a.concat(b.duties); }, []));
    const sel = selected.found && !selected.unbounded ? selected : { key: null, start: Infinity, lpk: null };
    const count = fcv2CrewCount_(duties, sel, members.filter(function (m) { return m.key; }).map(function (m) { return m.key; }), now);
    const statuses = sealed.map(function (m) { return snap.status[m]; })
      .concat(live.map(function (b) { return { status: 'fresh', missing: b.missing, grouping: b.grouping }; }));
    result = fcv2CrewResult_({ snapshotOk: true, months: statuses, selected: selected, count: count, members: members });
  }
  return Object.assign(base, {
    crewListed: true,
    history: {
      state: result.state, reasons: result.reasons.slice(), from: config.historyStart, basis: 'recorded-duties',
      indexingSuggested: indexingSuggested,
    },
    members: result.members.map(function (m) { return fcv2CrewMemberOut_(m, env); }),
  });
}

/** Allow-listed member object: never an id, a key, a base or index internals. */
function fcv2CrewMemberOut_(m, env) {
  const out = {};
  FCV2_CREW_MEMBER_FIELDS_.forEach(function (f) {
    if (!(f in m)) return;
    if (f === 'last') {
      out.last = m.last ? { date: env.deps.localDate(m.last.start), flightNumber: m.last.fn, route: m.last.route } : null;
      return;
    }
    out[f] = m[f];
  });
  return out;
}

function fcv2AddDaysKey_(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Capabilities (crew part, merged by a future router: Phase 1d.2B) and the editor-only purge (§8.3)
// ---------------------------------------------------------------------------

/**
 * The crew part of `capabilities`. Pure. While crew is enabled: every crew action. While disabled (kill switch):
 * only crewRevoke, which is never gated (§8.1), so an app can still learn crewCancel and finish a deletion.
 */
function fcv2CrewCapabilities_(env) {
  if (!fcv2CrewSettings_(env).enabled) return { actions: ['crewRevoke'], limits: { crewCancel: 1 } };
  return { actions: FCV2_CREW_ACTIONS_.slice(), limits: { crewCancel: 1 } };
}

const FCV2_CREW_PURGE_CONFIRM_KEY_ = 'FC_CREW_PURGE_CONFIRM';
const FCV2_CREW_PURGE_CONFIRM_VALUE_ = 'PURGE-ALL-CREW-DATA';

/**
 * Owner-confirmed purge of every crew record (§8.3). Pure: env = { props:{get,set,del}, store:{keys,get,del},
 * cache:{removeAll}, lock(fn) -> {ok, value}, now() }. Under the lock:
 *   1. A persisted fence (`FC_CREW_STATE.purging`) means a retry: no confirmation needed (the fence is the
 *      owner's durable intent). Otherwise FC_CREW_PURGE_CONFIRM must equal exactly PURGE-ALL-CREW-DATA.
 *   2. Fence: G+1 (only when not already fenced), phase deleted, no grant, no revocation, no pending purge,
 *      `purging: true`; verified by read-back before anything is destroyed. Then the confirmation is consumed.
 *   3. Delete FC_CREW_ENROLL, every fcx.* key (namespace-safe) and the registered cache keys.
 *   4. Verify (no enrollment code, no fcx.* key, purge complete); only then remove the fence and write the
 *      unbound purge receipt, verified by read-back -> 'deleted'. Any failure after step 2 leaves the fence.
 * `cancelled` tombstones and codeHash are kept. Never touches the roster token, pepper, owner id, the crew switch
 * or any other property. Returns ONLY { outcome: 'deleted'|'incomplete'|'refused'|'busy'|'error', deletedKeys,
 * remaining } (no ids, names or hashes).
 */
function fcv2CrewPurgeAll_(env) {
  const crewKeys = function () { return env.store.keys().filter(function (k) { return k.indexOf(FCV2_CREW_PREFIX_) === 0; }).length; };
  const readState = function () { const raw = env.props.get('FC_CREW_STATE'); return raw ? JSON.parse(raw) : null; };
  try {
    const lock = env.lock(function () {
      const state = fcv2CrewState_(env);
      const retry = state.purging === true;
      if (!retry && env.props.get(FCV2_CREW_PURGE_CONFIRM_KEY_) !== FCV2_CREW_PURGE_CONFIRM_VALUE_) {
        return { outcome: 'refused', deletedKeys: 0, remaining: crewKeys() };
      }
      let manifestKeys = [];
      try { manifestKeys = JSON.parse(env.store.get(FCV2_CREW_MANIFEST_KEY_) || '{}').cacheKeys || []; } catch (err) { manifestKeys = []; }
      const cacheKeys = manifestKeys
        .concat(state.revoke && state.revoke.cacheKeys ? state.revoke.cacheKeys : [])
        .concat(state.purge && state.purge.cacheKeys ? state.purge.cacheKeys : []);
      const fence = Object.assign({}, state, {
        G: retry ? state.G : state.G + 1, phase: 'deleted', grantHash: null, revoke: null, purge: null, purging: true,
      });
      env.props.set('FC_CREW_STATE', JSON.stringify(fence));            // logical invalidation + durable fence
      const fenced = readState();
      if (!fenced || fenced.purging !== true || fenced.G !== fence.G || fenced.phase !== 'deleted') {
        return { outcome: 'incomplete', deletedKeys: 0, remaining: crewKeys() };   // nothing destroyed
      }
      if (env.props.get(FCV2_CREW_PURGE_CONFIRM_KEY_) !== null) env.props.del(FCV2_CREW_PURGE_CONFIRM_KEY_);
      env.props.del('FC_CREW_ENROLL');
      const purge = fcv2CrewPurge_(env.store);
      if (cacheKeys.length) env.cache.removeAll(cacheKeys);
      const remaining = crewKeys();
      if (!purge.complete || remaining !== 0 || env.props.get('FC_CREW_ENROLL') !== null) {
        return { outcome: 'incomplete', deletedKeys: purge.deleted, remaining: remaining };   // the fence stays
      }
      const done = Object.assign({}, fence, {
        lastRevoke: { revokeId: 'purge-' + (fence.G - 1), G: fence.G - 1, outcome: 'deleted', deletedKeys: purge.deleted, at: env.now(), aliases: [] },
      });
      delete done.purging;
      env.props.set('FC_CREW_STATE', JSON.stringify(done));
      const after = readState();
      const ok = !!after && after.purging === undefined && after.phase === 'deleted' && after.G === fence.G;
      return { outcome: ok ? 'deleted' : 'incomplete', deletedKeys: purge.deleted, remaining: remaining };
    });
    if (!lock.ok) return { outcome: 'busy', deletedKeys: 0, remaining: crewKeys() };
    return lock.value;
  } catch (err) {
    return { outcome: 'error', deletedKeys: 0, remaining: null };
  }
}

/**
 * Editor-only entry point (Run menu in the Apps Script editor; names ending in "_" are hidden there). Not routed:
 * doGet/doPost never call it. Logs and returns only the outcome summary.
 */
function crewPurgeAll() {
  const result = fcv2CrewPurgeAll_({
    props: (function (p) { return { get: function (k) { return p.getProperty(k); }, set: function (k, v) { p.setProperty(k, v); }, del: function (k) { p.deleteProperty(k); } }; })(PropertiesService.getScriptProperties()),
    store: (function (u) { return { keys: function () { return u.getKeys(); }, get: function (k) { return u.getProperty(k); }, del: function (k) { u.deleteProperty(k); } }; })(PropertiesService.getUserProperties()),
    cache: (function (c) { return { removeAll: function (keys) { c.removeAll(keys); } }; })(CacheService.getScriptCache()),
    lock: function (fn) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) return { ok: false };
      try { return { ok: true, value: fn() }; } finally { lock.releaseLock(); }
    },
    now: function () { return Date.now(); },
  });
  console.log(JSON.stringify(result));
  return result;
}
