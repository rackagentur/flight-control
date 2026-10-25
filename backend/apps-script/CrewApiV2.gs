// ============================================================================
// FLIGHT CONTROL — CREW INTELLIGENCE: ACTION HANDLERS (Phase 1b, simulated only)
// ============================================================================
// NOT DEPLOYED. Phase 1d.2B: RosterApiV2.gs routes the four actions below through fcv2CrewRoute_ (after its
// token and contract checks) when every crew file is present; the gate (execution identity + configuration) is
// enforced there. Tests drive fcv2CrewHandle_ and doPost with fake services. Actions (spec §3, §4, §7, §8):
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

/**
 * The durable FC_CREW_STATE record. Absent -> the initial state. Unparseable, not an object or with an invalid
 * security-critical field -> throws {crewStateCorrupt: true}: never replaced by a fresh state and never
 * overwritten. Every caller fails closed (crew-unavailable, purge 'error'); the raw value stays for a reviewed
 * recovery. A read failure throws as well.
 */
function fcv2CrewState_(env) {
  const raw = env.props.get('FC_CREW_STATE');
  if (raw === null || raw === undefined) return fcv2CrewInitialState_();
  let st = null;
  try { st = JSON.parse(raw); } catch (err) { st = null; }
  if (!fcv2CrewValidState_(st)) throw { crewStateCorrupt: true };
  return st;
}

/** Shape check of the fields that decide authorization, fencing and cleanup (not a full schema). */
function fcv2CrewValidState_(st) {
  const isObj = function (v) { return !!v && typeof v === 'object' && !Array.isArray(v); };
  const optStr = function (v) { return v === null || v === undefined || typeof v === 'string'; };
  const optObj = function (v) { return v === null || v === undefined || isObj(v); };
  const keyList = function (v) { return Array.isArray(v) && v.every(function (k) { return typeof k === 'string'; }); };
  if (!isObj(st)) return false;
  if (typeof st.G !== 'number' || !(st.G >= 0) || Math.floor(st.G) !== st.G) return false;
  if (['none', 'active', 'revoking', 'deleted'].indexOf(st.phase) < 0) return false;
  if (!optStr(st.grantHash) || !optStr(st.pid) || !optStr(st.epoch) || !optStr(st.codeHash)) return false;
  if (st.purging !== undefined && st.purging !== true) return false;
  if (st.cancelled !== undefined && !keyList(st.cancelled)) return false;
  if (st.purgeCacheKeys !== undefined && !keyList(st.purgeCacheKeys)) return false;
  if (!optObj(st.revoke) || !optObj(st.purge) || !optObj(st.lastRevoke)) return false;
  if (st.phase === 'revoking' && !isObj(st.revoke)) return false;
  if (isObj(st.revoke) && (typeof st.revoke.revokeId !== 'string' || !optStr(st.revoke.credHash)
    || (st.revoke.cacheKeys !== undefined && !keyList(st.revoke.cacheKeys)))) return false;
  if (isObj(st.purge) && st.purge.cacheKeys !== undefined && !keyList(st.purge.cacheKeys)) return false;
  // Purge-fence invariant: the only writers of a fenced state (the purge fence and cancellations, which change
  // only `cancelled`) leave phase 'deleted', no grant, no revocation and no pending generation purge. Stale pid,
  // epoch and codeHash are carried over and grant nothing. Any other fenced combination is contradictory.
  if (st.purging === true && (st.phase !== 'deleted' || st.grantHash !== null
    || (st.revoke !== null && st.revoke !== undefined) || (st.purge !== null && st.purge !== undefined))) return false;
  return true;
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
    store: env.store, now: now, deps: env.deps, hash: env.deps.hash, diagnostics: env.diagnostics,
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
    if (req.action === 'crewRevoke') return fcv2CrewHandleRevoke_(req, Object.assign({}, env, { lock: function (fn) { return env.lock(fn, 5000); } }));   // never gated, never rate-limited
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
      const r = fcv2CrewRevoke_(fcv2CrewCoreEnv_(Object.assign({}, env, { lock: function (fn) { return env.lock(fn, 5000); } }), env.now()), { revokeId: state.revoke.revokeId, grant: req.grant });
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
  }, 5000);
  return lock.ok ? { ok: false, error: 'crew-revoked' } : { ok: false, error: 'busy' };
}

/** Bounded, resumable indexing and re-verification (§7.2, §7.4, §7.5). */
function fcv2CrewHandleIndex_(req, env, s, state) {
  const started = env.now();
  const original = env;
  env = Object.assign({}, original, { lock: function (fn) { return original.lock(fn, 2000); } });
  const diagnostic = req.diagnosticsVersion === 1 ? fcv2CrewDiagnostics_(env, state) : null;
  if (diagnostic) env = diagnostic.env;
  const todayKey = env.deps.localDate(started);
  const config = env.config;
  const reader = fcv2CrewReaderFrom_(env.readRaw, config);
  const sealable = fcv2CrewSealableMonths_(config, todayKey);
  const core = fcv2CrewCoreEnv_(env, started);
  const resumed = env.lock(function () { return fcv2CrewResumePurge_(core); });
  const initialOutstanding = req.sessionVersion === 1 ? fcv2CrewIndexPlan_(env.store, state, env.deps, sealable,
    { now: env.now(), verifyBefore: req.verifyBefore, retryUncovered: req.retryUncovered }).months.length : null;
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
    if (diagnostic) diagnostic.beginMonth();
    const built = fcv2CrewBuildMonth_(month, reader, ctx);
    if (!fcv2CrewSealable_(month, built, todayKey)) { outcomes[month] = 'not-sealable'; if (diagnostic) diagnostic.endMonth('not-sealable'); continue; }
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
    if (diagnostic) diagnostic.endMonth(outcomes[month]);
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
  const result = {
    ok: true, action: 'crewIndex', processed: processed, outcomes: counts, progress: progress, gcDeleted: gc.ok ? gc.value.deleted : 0,
    cleanupPending: resumed.ok ? !resumed.value.done : true,
  };
  if (req.sessionVersion === 1) result.session = { version: 1, initialOutstanding: initialOutstanding,
    remaining: fcv2CrewIndexPlan_(env.store, state, env.deps, sealable,
      { now: env.now(), verifyBefore: req.verifyBefore, retryUncovered: req.retryUncovered }).months.length };
  if (diagnostic) result.diagnostics = diagnostic.finish(started);
  return result;
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
  let readable = true;
  try { fcv2CrewState_(env); } catch (err) { readable = false; }   // corrupt state: never offer enroll/crew/index
  if (!readable || !fcv2CrewSettings_(env).enabled) return { actions: ['crewRevoke'], limits: { crewCancel: 1 } };
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
 *      `purging: true`, plus `purgeCacheKeys` (every registered cache key, merged with those an earlier run kept);
 *      verified by read-back before anything is destroyed. Then the confirmation is consumed. An unreadable or
 *      malformed manifest (or registry) is unknown, not empty: fenced, nothing destroyed -> 'incomplete', on
 *      every run (no automatic completion). A corrupt FC_CREW_STATE (or recovery registry) -> 'error', nothing
 *      written or destroyed.
 *   3. Delete FC_CREW_ENROLL, every fcx.* key (namespace-safe) and the cache keys kept in the fence.
 *   4. Verify (no enrollment code, no fcx.* key, purge complete, cache removal succeeded); only then remove the
 *      fence and its `purgeCacheKeys` and write the unbound purge receipt, verified by read-back -> 'deleted'.
 *      Any failure after step 2 leaves the fence and its cache keys for the next run.
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
      // The manifest's cache-key registry: absent -> none; unreadable, malformed or an invalid registry -> unknown
      // (null), never "none": the destructive steps then wait (see below) instead of losing registered keys.
      let manifestKeys = null;
      try {
        const raw = env.store.get(FCV2_CREW_MANIFEST_KEY_);
        if (raw === null || raw === undefined) {
          manifestKeys = [];
        } else {
          const m = JSON.parse(raw);
          if (m && typeof m === 'object' && Array.isArray(m.cacheKeys)
            && m.cacheKeys.every(function (k) { return typeof k === 'string'; })) manifestKeys = m.cacheKeys;
        }
      } catch (err) { manifestKeys = null; }
      // Cleanup keys: the manifest's registry, the state's revocation/purge copies and, on a retry, the keys the
      // fence kept from an earlier run (the manifest may already be gone). Kept in the fence until removal succeeds.
      const seen = {};
      const cacheKeys = (manifestKeys || [])
        .concat(state.revoke && state.revoke.cacheKeys ? state.revoke.cacheKeys : [])
        .concat(state.purge && state.purge.cacheKeys ? state.purge.cacheKeys : [])
        .concat(Array.isArray(state.purgeCacheKeys) ? state.purgeCacheKeys : [])
        .filter(function (k) { if (typeof k !== 'string' || seen[k]) return false; seen[k] = true; return true; });
      const fence = Object.assign({}, state, {
        G: retry ? state.G : state.G + 1, phase: 'deleted', grantHash: null, revoke: null, purge: null, purging: true,
        purgeCacheKeys: cacheKeys,
      });
      env.props.set('FC_CREW_STATE', JSON.stringify(fence));            // logical invalidation + durable fence
      const fenced = readState();
      if (!fenced || fenced.purging !== true || fenced.G !== fence.G || fenced.phase !== 'deleted'
        || JSON.stringify(fenced.purgeCacheKeys) !== JSON.stringify(cacheKeys)) {
        return { outcome: 'incomplete', deletedKeys: 0, remaining: crewKeys() };   // nothing destroyed
      }
      if (env.props.get(FCV2_CREW_PURGE_CONFIRM_KEY_) !== null) env.props.del(FCV2_CREW_PURGE_CONFIRM_KEY_);
      // Unknown registry: access is already fenced, nothing is destroyed; a retry reads the manifest again. No
      // automatic completion: a permanently corrupt manifest needs a separately reviewed recovery (§8.3).
      if (manifestKeys === null) {
        return { outcome: 'incomplete', deletedKeys: 0, remaining: crewKeys() };
      }
      env.props.del('FC_CREW_ENROLL');
      const purge = fcv2CrewPurge_(env.store);
      let cacheCleared = true;
      if (cacheKeys.length) { try { env.cache.removeAll(cacheKeys); } catch (err) { cacheCleared = false; } }
      const remaining = crewKeys();
      if (!purge.complete || !cacheCleared || remaining !== 0 || env.props.get('FC_CREW_ENROLL') !== null) {
        return { outcome: 'incomplete', deletedKeys: purge.deleted, remaining: remaining };   // the fence (and its keys) stay
      }
      const done = Object.assign({}, fence, {
        lastRevoke: { revokeId: 'purge-' + (fence.G - 1), G: fence.G - 1, outcome: 'deleted', deletedKeys: purge.deleted, at: env.now(), aliases: [] },
      });
      delete done.purging;
      delete done.purgeCacheKeys;
      env.props.set('FC_CREW_STATE', JSON.stringify(done));
      const after = readState();
      const ok = !!after && after.purging === undefined && after.purgeCacheKeys === undefined
        && after.phase === 'deleted' && after.G === fence.G;
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

// ---------------------------------------------------------------------------
// Routing, execution-identity gate and live services (Phase 1d.2B — local only, NOT deployed)
// ---------------------------------------------------------------------------
// RosterApiV2.gs routes crew, crewEnroll, crewIndex and crewRevoke here, AFTER its token check (with the failure
// limiter) and contract check, and only when fcv2CrewAvailable_() is true. The crew env is built lazily
// (env.crew()) only for those actions and for capabilities. crewPurgeAll is never routed.

const FCV2_CREW_OWNER_PROPERTY_ = 'FC_CREW_OWNER';
const FCV2_CREW_LOCK_WAIT_MS_ = 10000;

/**
 * True only when every crew function is part of the deployment (CrewCoreV2.gs, CrewCondorV2.gs, CrewApiV2.gs,
 * including older copies of a file that lack a newer function). typeof never throws for a missing name.
 */
function fcv2CrewAvailable_() {
  const kinds = [
    // CrewCoreV2.gs
    typeof fcv2CrewGroupDuties_, typeof fcv2CrewLinkDuties_, typeof fcv2CrewWindow_, typeof fcv2CrewEdges_,
    typeof fcv2CrewNextMonth_, typeof fcv2CrewSectorKeys_, typeof fcv2CrewBuildMonth_, typeof fcv2CrewSealable_,
    typeof fcv2CrewSelectedDuty_, typeof fcv2CrewCount_, typeof fcv2CrewSum_, typeof fcv2CrewResult_,
    typeof fcv2CrewInitialState_, typeof fcv2CrewSafeEqual_, typeof fcv2CrewShortHash_, typeof fcv2CrewTombstoned_,
    typeof fcv2CrewAuthorized_, typeof fcv2CrewFinalCheck_, typeof fcv2CrewEnroll_, typeof fcv2CrewBeginRevoke_,
    typeof fcv2CrewSystemRevoke_, typeof fcv2CrewPurge_, typeof fcv2CrewCacheRemove_, typeof fcv2CrewResumePurge_,
    typeof fcv2CrewRevoke_, typeof fcv2CrewEncodeMonth_, typeof fcv2CrewValidPayload_, typeof fcv2CrewDecodeMonth_,
    typeof fcv2CrewPartKey_, typeof fcv2CrewPartHeader_, typeof fcv2CrewParts_, typeof fcv2CrewStoreBytes_,
    typeof fcv2CrewUtf8_, typeof fcv2CrewPeak_, typeof fcv2CrewFingerprint_, typeof fcv2CrewEntryOut_,
    typeof fcv2CrewEntryIn_, typeof fcv2CrewValidEntry_, typeof fcv2CrewValidRoot_, typeof fcv2CrewValidManifest_,
    typeof fcv2CrewYearKey_, typeof fcv2CrewEmptyManifest_, typeof fcv2CrewManifest_, typeof fcv2CrewPublish_,
    typeof fcv2CrewFailClosed_, typeof fcv2CrewAdjacentMonths_, typeof fcv2CrewCommitMonth_, typeof fcv2CrewTouchMonth_,
    typeof fcv2CrewGc_, typeof fcv2CrewMonthIntegrity_, typeof fcv2CrewIndexPlan_, typeof fcv2CrewReadSnapshot_,
    // CrewCondorV2.gs
    typeof fcv2CrewParseLines_, typeof fcv2CrewNormalizeEvent_, typeof fcv2CrewReaderFrom_,
    // CrewApiV2.gs
    typeof fcv2CrewState_, typeof fcv2CrewValidState_, typeof fcv2CrewSettings_, typeof fcv2CrewCtx_, typeof fcv2CrewCoreEnv_, typeof fcv2CrewDiagnostics_,
    typeof fcv2CrewMonthList_, typeof fcv2CrewSealableMonths_, typeof fcv2CrewIsDate_, typeof fcv2CrewHandle_,
    typeof fcv2CrewHandleEnroll_, typeof fcv2CrewHandleRevoke_, typeof fcv2CrewRotate_, typeof fcv2CrewHandleIndex_,
    typeof fcv2CrewHandleCrew_, typeof fcv2CrewMemberOut_, typeof fcv2AddDaysKey_, typeof fcv2CrewCapabilities_,
    typeof fcv2CrewPurgeAll_, typeof fcv2CrewAvailable_, typeof fcv2CrewIdentityVerified_, typeof fcv2CrewMode_,
    typeof fcv2CrewRoute_, typeof fcv2CrewRouteCapabilities_, typeof fcv2CrewLiveEnv_, typeof fcv2CrewReadRaw_,
    typeof fcv2CrewLiveDeps_,
  ];
  for (let i = 0; i < kinds.length; i++) if (kinds[i] !== 'function') return false;
  return true;
}

/**
 * Execution identity: the account this script RUNS AS (effective user, see fcv2CrewLiveEnv_) equals the owner-configured
 * Script Property FC_CREW_OWNER (trimmed, case-insensitive). This is NOT authentication of the HTTP caller (the
 * roster token and the crew grant do that); it only ensures crew data is processed under the owner's account and
 * stored in the owner's User Properties. Fails closed: no owner configured, an empty email or any exception ->
 * false. Without FC_CREW_OWNER, Session is never called. (Platform note, unverified: getEmail() may need the
 * userinfo.email scope; without it it returns '' or throws, and crew stays unavailable.)
 */
function fcv2CrewIdentityVerified_(env) {
  try {
    const owner = String(env.props.get(FCV2_CREW_OWNER_PROPERTY_) || '').trim().toLowerCase();
    if (!owner) return false;
    const email = String(env.effectiveEmail() || '').trim().toLowerCase();
    return !!email && email === owner;
  } catch (err) {
    return false;
  }
}

/** 'full' (identity verified and crew enabled), 'revoke' (identity verified only) or null. */
function fcv2CrewMode_(env) {
  if (!fcv2CrewIdentityVerified_(env)) return null;
  return fcv2CrewSettings_(env).enabled ? 'full' : 'revoke';
}

/**
 * Routed crew action (called by fcv2HandlePost_ after its token and contract checks). The gate is enforced here,
 * not only advertised: crew/crewEnroll/crewIndex need full mode ('crew-disabled'); crewRevoke needs at least
 * revocation-only mode ('crew-unavailable': never a false confirmation; the owner's fallback is crewPurgeAll).
 */
function fcv2CrewRoute_(req, body, base) {
  const env = typeof base.crew === 'function' ? base.crew() : null;
  if (!env) return { ok: false, error: 'crew-unavailable' };
  const mode = fcv2CrewMode_(env);
  if (req.action === 'crewRevoke') {
    if (!mode) return { ok: false, error: 'crew-unavailable' };
  } else if (mode !== 'full') {
    return { ok: false, error: 'crew-disabled' };
  }
  return fcv2CrewHandle_(body, env);
}

/** Crew part of capabilities under the gate: null (base answer unchanged), revocation-only or full (§8.7). */
function fcv2CrewRouteCapabilities_(base) {
  const env = typeof base.crew === 'function' ? base.crew() : null;
  if (!env || !fcv2CrewMode_(env)) return null;
  return fcv2CrewCapabilities_(env);
}

/** Raw events for the crew reader: synced copy (tagged only) before the start of today, airline feed from it. */
function fcv2CrewReadRaw_(base, from, to) {
  const today = base.startOfDay(base.deps.localDate(base.now(), base.config.baseTimeZone));
  let out = [];
  if (from < today) out = out.concat(base.syncedEvents(from, Math.min(to, today)));
  if (to > today) out = out.concat(base.airlineEvents(Math.max(from, today), to));
  return out;                                   // synced first: the reader keeps the first copy of a sourceId
}

/** Live primitives in the formats of the synthetic handler deps (base time zone, never UTC substitution). */
function fcv2CrewLiveDeps_(base, tz) {
  const hex = function (bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); };
  const hmac = function (pepper, text) { return Utilities.computeHmacSha256Signature(String(text), String(pepper), Utilities.Charset.UTF_8); };
  return {
    hash: base.deps.hash,                                               // fcv2Hash_: hex SHA-256 of UTF-8
    hmacHex: function (pepper, text) { return hex(hmac(pepper, text)); },
    hmacKey: function (pepper, text) { return Utilities.base64EncodeWebSafe(hmac(pepper, text)).slice(0, 22); },   // 128 bits
    pack: function (s) { return Utilities.base64Encode(Utilities.gzip(Utilities.newBlob('').setDataFromString(s, 'UTF-8')).getBytes()); },
    unpack: function (s) { return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip')).getDataAsString('UTF-8'); },
    monthStart: function (month) { return fcv2StartOfDay_(month + '-01', tz); },
    monthOf: function (ms) { return fcv2LocalDate_(ms, tz).slice(0, 7); },
    localDate: function (ms) { return fcv2LocalDate_(ms, tz); },
    dayStart: function (key) { return fcv2StartOfDay_(key, tz); },
    newId: function () { return Utilities.getUuid().replace(/-/g, '').toLowerCase(); },
  };
}

/**
 * Live crew env over Apps Script services; `base` is the roster env (fcv2LiveEnv_): token, clock and the calendar
 * readers are shared, never duplicated. Built only for crew actions and capabilities.
 */
function fcv2CrewLiveEnv_(base) {
  const config = FCV2_CONDOR_CONFIG_;
  const script = PropertiesService.getScriptProperties();
  const user = PropertiesService.getUserProperties();
  const cache = CacheService.getScriptCache();
  return {
    token: base.token,
    now: base.now,
    config: config,
    props: {
      get: function (k) { return script.getProperty(k); },
      set: function (k, v) { script.setProperty(k, v); },
      del: function (k) { script.deleteProperty(k); },
    },
    store: {
      keys: function () { return user.getKeys(); },
      get: function (k) { return user.getProperty(k); },
      set: function (k, v) { user.setProperty(k, v); },
      del: function (k) { user.deleteProperty(k); },
    },
    cache: {
      get: function (k) { return cache.get(k); },
      put: function (k, v, ttl) { cache.put(k, v, ttl); },
      removeAll: function (keys) { cache.removeAll(keys); },
    },
    lock: function (fn, waitMs) {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(waitMs === undefined ? FCV2_CREW_LOCK_WAIT_MS_ : waitMs)) return { ok: false };
      try { return { ok: true, value: fn() }; } finally { lock.releaseLock(); }
    },
    readRaw: function (from, to) { return fcv2CrewReadRaw_(base, from, to); },
    effectiveEmail: function () { return Session.getEffectiveUser().getEmail(); },
    deps: fcv2CrewLiveDeps_(base, config.baseTimeZone),
  };
}

/** Opt-in, request-local accounting. No values/keys escape; at most 2048 key/size entries.
 * One scan per acquired lock; mutation verification reads only the changed key. Diagnostic
 * failures invalidate evidence, never change storage admission, authorization or operation results.
 */
function fcv2CrewDiagnostics_(base, state) {
  let complete = true, sizes = null, classes = {}, current = null, peak = null, peakCategories = null;
  let admission = null, month = null, monthStarted = 0;
  const months = [];
  const maintenance = { lockWaitMs: 0, lockHeldMs: 0 };
  let parts = { count: 0, medianValueBytes: null, maxValueBytes: null };
  const operations = { keys: 0, reads: 0, writes: 0, deletes: 0 };
  const raw = { keys: function () { operations.keys++; return base.store.keys(); },
    get: function (k) { operations.reads++; return base.store.get(k); },
    set: function (k, v) { operations.writes++; return base.store.set(k, v); },
    del: function (k) { operations.deletes++; return base.store.del(k); } };
  let diagnosticMs = 0;
  const safe = function (fn) { const t = base.now(); try { fn(); } catch (err) { complete = false; sizes = null; }
    finally { diagnosticMs += Math.max(0, base.now() - t); } };
  const blank = function () { return { otherValueBytes: 0, committedValueBytes: 0, retiredValueBytes: 0,
    orphanValueBytes: 0, stagedValueBytes: 0, manifestValueBytes: 0, keyBytes: 0 }; };
  const category = function (k) { return classes[k] || (k.indexOf('fcx.') === 0 ? 'orphanValueBytes' : 'otherValueBytes'); };
  const classify = function () {
    const r = fcv2CrewManifest_(raw, state, base.deps);
    if (r.kind !== 'ok' && r.kind !== 'absent') throw new Error('unavailable');
    classes = {};
    const m = r.manifest;
    classes[FCV2_CREW_MANIFEST_KEY_] = 'manifestValueBytes';
    Object.keys(m.years || {}).forEach(function (y) { classes[fcv2CrewYearKey_(m.G, m.epoch, y, m.years[y][0])] = 'manifestValueBytes'; });
    (m.retired || []).forEach(function (x) { classes[x[0]] = 'retiredValueBytes'; });
    Object.keys(m.months).forEach(function (key) {
      const e = m.months[key];
      for (let i = 0; i < (e.parts || 0); i++) classes[fcv2CrewPartKey_(m.G, m.epoch, key, e.gen, i)] = 'committedValueBytes';
    });
  };
  const total = function () {
    current = blank();
    const values = [];
    Object.keys(sizes).forEach(function (k) {
      current.keyBytes += fcv2CrewUtf8_(k);
      current[category(k)] += sizes[k];
      if (category(k) === 'committedValueBytes') values.push(sizes[k]);
    });
    const n = Object.keys(current).reduce(function (sum, k) { return sum + current[k]; }, 0);
    if (peak === null || n > peak) { peak = n; peakCategories = Object.assign({}, current); }
    values.sort(function (a, b) { return a - b; });
    const mid = Math.floor(values.length / 2);
    parts = { count: values.length, medianValueBytes: values.length ? (values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2) : null,
      maxValueBytes: values.length ? values[values.length - 1] : null };
  };
  const scan = function () {
    const keys = raw.keys();
    if (keys.length > 2048 || keys.reduce(function (n, k) { return n + k.length; }, 0) > 131072) throw new Error('capacity');
    sizes = Object.create(null);
    keys.forEach(function (k) { const v = raw.get(k); if (typeof v !== 'string') throw new Error('unreadable'); sizes[k] = fcv2CrewUtf8_(v); });
    classify(); total();
  };
  const env = Object.assign({}, base);
  env.store = {
    keys: function () { return raw.keys(); }, get: function (k) { return raw.get(k); },
    set: function (k, v) {
      try { raw.set(k, v); } catch (err) { complete = false; throw err; }
      safe(function () {
        if (!sizes) throw new Error('unobserved');
        if (raw.get(k) !== v) throw new Error('ambiguous');
        if (!Object.prototype.hasOwnProperty.call(sizes, k) && Object.keys(sizes).length >= 2048) throw new Error('capacity');
        if (!classes[k] && k.indexOf('fcx.') === 0) classes[k] = 'stagedValueBytes';
        sizes[k] = fcv2CrewUtf8_(v);
        if (Object.keys(sizes).reduce(function (n, key) { return n + key.length; }, 0) > 131072) throw new Error('capacity');
        total();
        if (k === FCV2_CREW_MANIFEST_KEY_) { classify(); total(); }
      });
    },
    del: function (k) {
      try { raw.del(k); } catch (err) { complete = false; throw err; }
      safe(function () { if (!sizes || raw.get(k) != null) throw new Error('ambiguous'); delete sizes[k]; total(); });
    },
  };
  env.lock = function (fn) {
    const start = base.now();
    let entered = false;
    const bucket = month || maintenance;
    const result = base.lock(function () {
      entered = true;
      const acquired = base.now();
      bucket.lockWaitMs += Math.max(0, acquired - start);
      safe(scan);
      try { return fn(); } finally {
        safe(function () { if (!sizes) throw new Error('unavailable'); classify(); total(); });
        bucket.lockHeldMs += Math.max(0, base.now() - acquired);
        sizes = null;
      }
    });
    if (!entered) bucket.lockWaitMs += Math.max(0, base.now() - start);
    return result;
  };
  env.readRaw = function (from, to) { const rows = base.readRaw(from, to); if (month) month.eventsRead += rows.length; return rows; };
  env.diagnostics = { admission: function (n, body, count) {
    admission = admission === null ? n : Math.max(admission, n);
    if (month) { month.encodedBodyBytes = body; month.partCount = count; }
  } };
  return {
    env: env,
    beginMonth: function () { monthStarted = base.now(); month = { elapsedMs: 0, eventsRead: 0, encodedBodyBytes: null,
      partCount: null, lockWaitMs: 0, lockHeldMs: 0, outcome: null }; },
    endMonth: function (outcome) { month.elapsedMs = Math.max(0, base.now() - monthStarted); month.outcome = outcome; months.push(month); month = null; },
    finish: function (start) {
      complete = complete && peak !== null && !months.some(function (m) {
        return m.outcome === 'committed' && (m.encodedBodyBytes === null || m.partCount === null || admission === null);
      });
      const out = { version: 1, complete: complete, storeOperations: operations, diagnosticMs: diagnosticMs, serverMs: Math.max(0, base.now() - start),
        storage: { observedPeakBytes: complete ? peak : null, admissionPeakBytes: admission, peakCategories: complete ? peakCategories : null },
        committedParts: complete ? parts : { count: null, medianValueBytes: null, maxValueBytes: null }, months: months, maintenance: maintenance };
      if (JSON.stringify(out).length > 8192) { out.complete = false; out.months = []; out.storage = { observedPeakBytes: null, admissionPeakBytes: null, peakCategories: null }; out.committedParts = { count: null, medianValueBytes: null, maxValueBytes: null }; }
      return out;
    },
  };
}
