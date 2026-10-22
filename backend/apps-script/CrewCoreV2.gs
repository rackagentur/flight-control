// ============================================================================
// FLIGHT CONTROL — CREW INTELLIGENCE CORE (Phase 1a, synthetic only)
// ============================================================================
// NOT DEPLOYED. Not part of the installed Apps Script project and not loaded by the
// fc.roster v2 sandbox (tests/gs-harness.js GS_FILES). Specification:
// docs/CREW-INTELLIGENCE.md Revision 4.1. Implementation of the backend actions is
// not authorized; this file holds only the pure, Node-tested algorithms:
//   - canonical duty grouping (same rule as fcv2Duties_) and conservative linking
//   - monthly ownership with read-window extension, completion and sealing rules
//   - familiarity counting before a selected duty, suspect groups, result states
//   - generation-based access (enroll / authorize / revoke) and namespace-safe purge
//   - crash-safe month commit, garbage collection and whole-query snapshot reads
//   - encoded storage sizes and peak admission
//
// Input crew entries are already parsed by the airline adapter (a later phase):
//   { rank, id, family, given } or { parseFailed: true }; id may be null.
// Every I/O and crypto primitive is injected (deps / env). No Apps Script service is
// used, nothing is logged, and no thrown message contains crew text.
// All names start with fcv2Crew and end in "_" (not callable through google.script.run).
// ============================================================================

const FCV2_CREW_DUTY_GAP_MS_ = 6 * 3600000;       // must equal FCV2_DUTY_GAP_MS_ (parity test)
const FCV2_CREW_LINK_SPAN_MS_ = 20 * 3600000;     // suspect-group link span: max augmented FDP 18 h + 2 h (spec §6.3b, A2)
const FCV2_CREW_MIN_REST_MS_ = 10 * 3600000;      // connected duties closer than a minimum rest are linked (shortRest)
const FCV2_CREW_SCHEMA_ = 1;
const FCV2_CREW_MARGIN_MS_ = 36 * 3600000;        // read margin around a month / selected flight
const FCV2_CREW_MAX_EXTENSIONS_ = 4;              // per side
const FCV2_CREW_PREFIX_ = 'fcx.';
const FCV2_CREW_MANIFEST_KEY_ = 'fcx.m';
const FCV2_CREW_PART_MAX_ = 8000;                 // characters per stored value (limit 9 KB)
const FCV2_CREW_MAX_PARTS_ = 3;
const FCV2_CREW_MANIFEST_MAX_ = 8000;
const FCV2_CREW_STORE_LIMIT_ = 500000;            // bytes per property store, KB = 1,000 (conservative)
const FCV2_CREW_SAFETY_ = 16000;
const FCV2_CREW_GC_GRACE_MS_ = 120000;
const FCV2_CREW_FRESH_MS_ = 14 * 86400000;        // verification freshness window
const FCV2_CREW_SNAPSHOT_ATTEMPTS_ = 3;
const FCV2_CREW_ENROLL_MAX_MS_ = 15 * 60000;
const FCV2_CREW_ENROLL_MAX_FAILURES_ = 5;

// ---------------------------------------------------------------------------
// Duties
// ---------------------------------------------------------------------------

/**
 * The fcv2Duties_ chaining rule (0 <= gap <= 6 h, connected airports) on flights in the exact order
 * fcv2BuildRoster_ gives it: by start, then end, stable (ties keep the input order). Flights with an
 * identical start and end make the grouping depend on input order; their duties are marked `tied`
 * (a grouping-uncertainty anomaly) instead of being silently re-ordered.
 */
function fcv2CrewGroupDuties_(flights, deps) {
  const sorted = flights.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  const tied = {};
  sorted.forEach(function (f, i) {
    const n = sorted[i + 1];
    if (n && n.start === f.start && n.end === f.end) { tied[i] = true; tied[i + 1] = true; }
  });
  const groups = [];
  let current = null;
  sorted.forEach(function (f, i) {
    const prev = current && current.flights[current.flights.length - 1];
    const gap = prev ? f.start - prev.end : -1;
    if (!(prev && gap >= 0 && gap <= FCV2_CREW_DUTY_GAP_MS_ && prev.destination === f.origin)) {
      current = { flights: [], tied: false };
      groups.push(current);
    }
    current.flights.push(f);
    if (tied[i]) current.tied = true;
  });
  return groups.map(function (g) {
    const first = g.flights[0];
    const last = g.flights[g.flights.length - 1];
    return {
      key: deps.hash(String(first.sourceId)).slice(0, 16), start: first.start, end: last.end,
      origin: first.origin, destination: last.destination, flights: g.flights, lpk: null, link: null, tied: g.tied,
    };
  });
}

/**
 * Links between consecutive duties that may be one real duty (spec §6.3b): within the link span and
 * disconnected airports (chainBreak), an unrecognised event in between (hiddenEvent), or connected
 * airports closer than a minimum rest (shortRest).
 */
function fcv2CrewLinkDuties_(duties, hidden) {
  return duties.map(function (d, i) {
    const prev = i > 0 ? duties[i - 1] : null;
    if (!prev || d.start - prev.end > FCV2_CREW_LINK_SPAN_MS_) return d;
    const between = (hidden || []).some(function (h) { return h.end > prev.end && h.start < d.start; });
    const link = prev.destination !== d.origin ? 'chainBreak' : between ? 'hiddenEvent'
      : d.start - prev.end < FCV2_CREW_MIN_REST_MS_ ? 'shortRest' : null;
    if (!link) return d;
    const out = Object.assign({}, d);
    out.lpk = prev.key;
    out.link = link;
    return out;
  });
}

/** Reads, groups and links one window, extending it while an edge could change the target duties. */
function fcv2CrewWindow_(from, to, read, deps, needsEdges) {
  let extBack = 0;
  let extFwd = 0;
  for (;;) {
    const got = read(from, to);
    const duties = fcv2CrewLinkDuties_(fcv2CrewGroupDuties_(got.flights, deps), got.hidden || []);
    const edges = needsEdges(duties, from, to);
    if (edges.back && extBack < FCV2_CREW_MAX_EXTENSIONS_) { from -= FCV2_CREW_MARGIN_MS_; extBack++; continue; }
    if (edges.fwd && extFwd < FCV2_CREW_MAX_EXTENSIONS_) { to += FCV2_CREW_MARGIN_MS_; extFwd++; continue; }
    return { duties: duties, edges: edges, from: from, to: to };
  }
}

/** Edge rule for a contiguous run of target duties [i0..i1] (spec §5.3). */
function fcv2CrewEdges_(duties, i0, i1, from, to) {
  if (i0 < 0) return { back: false, fwd: false };
  const first = duties[i0];
  const needed = first.lpk && i0 > 0 ? duties[i0 - 1] : first;   // a linked predecessor must be whole too
  return {
    back: needed.flights[0].start < from + FCV2_CREW_DUTY_GAP_MS_ || first.start - from < FCV2_CREW_LINK_SPAN_MS_,
    fwd: duties[i1].end > to - FCV2_CREW_DUTY_GAP_MS_,
  };
}

function fcv2CrewNextMonth_(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? (y + 1) + '-01' : y + '-' + (m < 9 ? '0' : '') + (m + 1);
}

/** Crew keys of one sector, or null when the sector cannot be indexed; counts missing-record anomalies. */
function fcv2CrewSectorKeys_(flight, ctx, missing) {
  if (!flight.crew || !flight.crew.length) { missing.noCrewList++; return null; }
  if (!flight.crew.some(function (c) { return c.id === ctx.selfId; })) { missing.ownerMissing++; return null; }
  const keys = [];
  flight.crew.forEach(function (c) {
    if (c.parseFailed) { missing.parseFailed++; return; }
    if (!c.id) { missing.missingId++; return; }
    if (c.id === ctx.selfId) return;
    const k = ctx.keyOf(c.id);
    if (keys.indexOf(k) < 0) keys.push(k);
  });
  return keys;
}

/**
 * Builds month M's index content: completed duties whose home month (base zone) is M.
 * ctx: { now, selfId, keyOf(id), deps: { hash, monthStart(month) -> ms, monthOf(ms) -> 'YYYY-MM' } }
 * read(from, to) -> { flights, hidden } with calendar OVERLAP semantics.
 */
function fcv2CrewBuildMonth_(month, read, ctx) {
  const start = ctx.deps.monthStart(month);
  const end = ctx.deps.monthStart(fcv2CrewNextMonth_(month));
  const inMonth = function (d) { return d.start >= start && d.start < end; };
  const w = fcv2CrewWindow_(start - FCV2_CREW_MARGIN_MS_, end + FCV2_CREW_MARGIN_MS_, read, ctx.deps, function (duties, from, to) {
    const idx = duties.map(function (d, i) { return inMonth(d) ? i : -1; }).filter(function (i) { return i >= 0; });
    return idx.length ? fcv2CrewEdges_(duties, idx[0], idx[idx.length - 1], from, to) : { back: false, fwd: false };
  });
  const missing = { noCrewList: 0, ownerMissing: 0, missingId: 0, parseFailed: 0 };
  const grouping = { chainBreak: 0, hiddenEvent: 0, shortRest: 0, tiedFlights: 0, dutyUnbounded: 0 };
  const kept = w.duties.filter(inMonth);
  const out = [];
  let openDuties = 0;
  kept.forEach(function (d, i) {
    if ((i === 0 && w.edges.back) || (i === kept.length - 1 && w.edges.fwd)) { grouping.dutyUnbounded++; return; }
    if (d.end > ctx.now) { openDuties++; return; }                     // completed duties only, never "<= month end"
    if (d.link) grouping[d.link]++;
    if (d.tied) grouping.tiedFlights++;
    out.push({
      key: d.key, start: d.start, end: d.end, lpk: d.lpk, tied: d.tied,
      sectors: d.flights.map(function (f) {
        return { fn: f.flightNumber, route: f.origin + '-' + f.destination, keys: fcv2CrewSectorKeys_(f, ctx, missing) || [] };
      }),
    });
  });
  return { month: month, duties: out, missing: missing, grouping: grouping, openDuties: openDuties, window: { from: w.from, to: w.to } };
}

/** Sealing (spec §5.4, §7.5): today >= the 8th of the next month and every home-month duty completed. */
function fcv2CrewSealable_(month, built, todayKey) {
  return todayKey >= fcv2CrewNextMonth_(month) + '-08' && built.openDuties === 0 && built.grouping.dutyUnbounded === 0;
}

/** The selected sector's canonical duty, with the same grouping, linking and edge rules. */
function fcv2CrewSelectedDuty_(sourceId, center, read, ctx) {
  const find = function (duties) {
    for (let i = 0; i < duties.length; i++) {
      if (duties[i].flights.some(function (f) { return f.sourceId === sourceId; })) return i;
    }
    return -1;
  };
  const w = fcv2CrewWindow_(center - FCV2_CREW_MARGIN_MS_, center + FCV2_CREW_MARGIN_MS_, read, ctx.deps, function (duties, from, to) {
    const i = find(duties);
    return fcv2CrewEdges_(duties, i, i, from, to);
  });
  const i = find(w.duties);
  if (i < 0) return { found: false };
  const d = w.duties[i];
  if (w.edges.back || w.edges.fwd) return { found: true, unbounded: true };
  return { found: true, unbounded: false, key: d.key, start: d.start, end: d.end, lpk: d.lpk };
}

// ---------------------------------------------------------------------------
// Familiarity
// ---------------------------------------------------------------------------

/**
 * Counts earlier encounters for each member key (spec §6.1, §6.3a, §6.3b).
 * duties: every indexed duty of the query snapshot (sealed + live), any order.
 * selected: { key, start, lpk }. Returns raw (recorded fragments), groups (suspect groups) and whether
 * any of the member's recorded matches touches a grouping uncertainty (then no number is shown).
 */
function fcv2CrewCount_(duties, selected, memberKeys, now) {
  const flags = { duplicate: false, linkMismatch: false, linkGap: false, selectedLinkGap: false };
  const byKey = {};
  duties.forEach(function (d) {
    if (byKey[d.key]) { if (JSON.stringify(byKey[d.key]) !== JSON.stringify(d)) flags.duplicate = true; return; }
    byKey[d.key] = d;
  });
  const list = Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return a.start - b.start || (a.key < b.key ? -1 : 1); });
  const comp = {};
  let next = 0;
  list.forEach(function (d, i) {
    const prev = i > 0 ? list[i - 1] : null;
    if (d.lpk && prev && prev.key === d.lpk) { comp[d.key] = comp[prev.key]; return; }
    if (d.lpk && byKey[d.lpk]) flags.linkMismatch = true;              // named predecessor exists but is not adjacent
    if (d.lpk && !byKey[d.lpk] && prev) { flags.linkGap = true; comp[d.key] = comp[prev.key]; return; }   // conservative merge
    comp[d.key] = next++;
  });
  let selComp = null;
  if (byKey[selected.key]) selComp = comp[selected.key];
  else if (selected.lpk) {
    if (byKey[selected.lpk]) selComp = comp[selected.lpk];
    else {
      const before = list.filter(function (d) { return d.start < selected.start; });
      if (before.length) { flags.selectedLinkGap = true; selComp = comp[before[before.length - 1].key]; }
    }
  }
  const eligible = list.filter(function (d) {
    return d.end <= now && d.start < selected.start && d.key !== selected.key && (selComp === null || comp[d.key] !== selComp);
  });
  const sizes = {};
  list.forEach(function (d) { sizes[comp[d.key]] = (sizes[comp[d.key]] || 0) + 1; });
  const uncertainDuty = function (d) { return sizes[comp[d.key]] > 1 || d.tied; };
  const groupingInRange = flags.linkGap || flags.selectedLinkGap || eligible.some(uncertainDuty);
  const members = {};
  memberKeys.forEach(function (k) {
    let raw = 0;
    const groups = {};
    let last = null;
    let uncertain = false;
    eligible.forEach(function (d) {
      const shared = d.sectors.filter(function (s) { return s.keys.indexOf(k) >= 0; });
      if (!shared.length) return;
      raw++;
      groups[comp[d.key]] = true;
      if (uncertainDuty(d)) uncertain = true;
      if (!last || d.start > last.start) {
        const s = shared[shared.length - 1];
        last = { start: d.start, fn: s.fn, route: s.route };
      }
    });
    members[k] = { raw: raw, groups: Object.keys(groups).length, uncertain: uncertain, last: last };
  });
  return { members: members, flags: flags, groupingInRange: groupingInRange };
}

function fcv2CrewSum_(o) {
  return Object.keys(o || {}).reduce(function (n, k) { return n + (o[k] || 0); }, 0);
}

/**
 * Result state and member classification (spec §6.4, §6.5, correction pass).
 * Counts are RECORDED matches: distinct recorded duties in the available roster records, never a
 * claim about real-world duties (exact or minimum). A member whose recorded matches touch a grouping
 * uncertainty gets no number at all.
 * q: { snapshotOk, months: [{ status: fresh|stale|replaceFailed|pending|uncovered, missing, grouping }],
 *      selected: { unbounded }, count: fcv2CrewCount_ result, members: [{ rank, family, given, key|null }] }
 * state: complete | incomplete | stale. match: recorded | none | uncertain | stale | suppressed | unavailable.
 */
function fcv2CrewResult_(q) {
  const person = function (m, fields) {
    return Object.assign({ rank: m.rank, family: m.family, given: m.given }, fields);
  };
  const suppressAll = function (state, reason) {
    return {
      state: state, reasons: [reason],
      members: q.members.map(function (m) {
        return person(m, m.key ? { match: 'suppressed', count: null } : { match: 'unavailable', count: null });
      }),
    };
  };
  if (!q.snapshotOk) return suppressAll('stale', 'snapshot-unavailable');
  if (q.selected.unbounded) return suppressAll('incomplete', 'selected-duty-uncertain');
  const flags = q.count.flags;
  if (flags.duplicate || flags.linkMismatch) return suppressAll('stale', 'index-inconsistent');
  const stale = q.months.some(function (m) { return m.status === 'stale' || m.status === 'replaceFailed'; });
  if (stale) {
    return {
      state: 'stale', reasons: ['stale-history'],
      members: q.members.map(function (m) {
        if (!m.key) return person(m, { match: 'unavailable', count: null });
        const c = q.count.members[m.key];
        return person(m, { match: 'stale', count: null, asOfRecorded: c.uncertain ? null : c.groups });   // labelled "as of", never a bound
      }),
    };
  }
  const missing = q.months.some(function (m) { return m.status === 'pending' || m.status === 'uncovered'; })
    || q.months.some(function (m) { return fcv2CrewSum_(m.missing) > 0; });
  const grouping = q.count.groupingInRange || q.months.some(function (m) { return fcv2CrewSum_(m.grouping) > 0; });
  const reasons = [];
  if (missing) reasons.push('missing-records');
  if (grouping) reasons.push('grouping-uncertain');
  return {
    state: missing ? 'incomplete' : 'complete', reasons: reasons,
    members: q.members.map(function (m) {
      if (!m.key) return person(m, { match: 'unavailable', count: null });
      const c = q.count.members[m.key];
      if (c.uncertain) return person(m, { match: 'uncertain', count: null, recordedMatch: c.raw > 0 });
      return person(m, { match: c.groups > 0 ? 'recorded' : 'none', count: c.groups, basis: 'recorded-duties', last: c.last });
    }),
  };
}

// ---------------------------------------------------------------------------
// Generation protocol (spec §4.0) — pure transitions on the FC_CREW_STATE record
// ---------------------------------------------------------------------------

function fcv2CrewInitialState_() {
  return { G: 0, phase: 'none', pid: null, epoch: null, grantHash: null, codeHash: null, enrolledAt: null, revoke: null, lastRevoke: null };
}

function fcv2CrewSafeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Access check used at the start of a request and again right before its response. */
function fcv2CrewAuthorized_(state, grantHash, pid) {
  return state.phase === 'active' && fcv2CrewSafeEqual_(state.grantHash, grantHash) && state.pid === pid;
}

/** Final response authorisation (§4.0 rule 3): same generation as at the start and still authorised. */
function fcv2CrewFinalCheck_(startState, nowState, grantHash, pid) {
  return nowState.G === startState.G && nowState.epoch === startState.epoch && fcv2CrewAuthorized_(nowState, grantHash, pid);
}

/**
 * Enrollment transition (§4.2, §4.3). Runs under the lock.
 * enrollProp: the owner's FC_CREW_ENROLL value ("<code>|<expiresAtMs>") or null.
 * ctx: { now, pid, newEpoch, hash, failures }. Returns { result, state?, consume?, burn?, failed? }.
 */
function fcv2CrewEnroll_(state, enrollProp, req, ctx) {
  if (!req || typeof req.code !== 'string' || typeof req.grant !== 'string') return { result: { ok: false, error: 'bad-request' } };
  if (state.phase === 'revoking') return { result: { ok: false, error: 'busy' } };
  const codeHash = ctx.hash(req.code);
  const grantHash = ctx.hash(req.grant);
  if (state.phase === 'active' && fcv2CrewSafeEqual_(state.codeHash, codeHash) && fcv2CrewSafeEqual_(state.grantHash, grantHash) && state.pid === ctx.pid) {
    return { result: { ok: true, enrolled: true, G: state.G } };     // idempotent retry, nothing changes
  }
  if (typeof enrollProp !== 'string') return { result: { ok: false, error: 'enroll-closed' } };
  const cut = enrollProp.lastIndexOf('|');
  const code = enrollProp.slice(0, cut);
  const expires = Number(enrollProp.slice(cut + 1));
  if (cut <= 0 || !(expires > ctx.now) || expires > ctx.now + FCV2_CREW_ENROLL_MAX_MS_) return { result: { ok: false, error: 'enroll-closed' } };
  if (!fcv2CrewSafeEqual_(ctx.hash(code), codeHash)) {
    const burn = ctx.failures + 1 >= FCV2_CREW_ENROLL_MAX_FAILURES_;
    return { result: { ok: false, error: burn ? 'enroll-closed' : 'unauthorized' }, failed: true, burn: burn };
  }
  return {
    result: { ok: true, enrolled: true, G: state.G + 1 }, consume: true,
    state: {
      G: state.G + 1, phase: 'active', pid: ctx.pid, epoch: ctx.newEpoch, grantHash: grantHash, codeHash: codeHash,
      enrolledAt: ctx.now, revoke: null, lastRevoke: state.lastRevoke || null,
    },
  };
}

/** Revocation start (§8.1, §8.2 step 1). Returns { result } (done, nothing to do) or { state?, proceed: true }. */
function fcv2CrewBeginRevoke_(state, req, ctx) {
  if (!req || typeof req.revokeId !== 'string' || typeof req.grant !== 'string') return { result: { ok: false, error: 'bad-request' } };
  if (state.lastRevoke && state.lastRevoke.revokeId === req.revokeId) {
    return { result: { ok: true, state: 'deleted', recorded: true, deletedKeys: state.lastRevoke.deletedKeys } };
  }
  const grantHash = ctx.hash(req.grant);
  if (state.phase === 'revoking') {
    if (state.revoke.revokeId === req.revokeId && fcv2CrewSafeEqual_(state.revoke.credHash, grantHash)) return { proceed: true };
    return { result: { ok: false, error: 'busy' } };
  }
  if (state.phase !== 'active' || !fcv2CrewSafeEqual_(state.grantHash, grantHash)) return { result: { ok: false, error: 'stale-request' } };
  return {
    proceed: true,
    state: Object.assign({}, state, {
      G: state.G + 1, phase: 'revoking', grantHash: null,
      revoke: { revokeId: req.revokeId, credHash: grantHash, cacheKeys: ctx.cacheKeys || [], requestedAt: ctx.now },
    }),
  };
}

/** System invalidation (pid rotation, unreadable manifest): same as a revoke, without a client. */
function fcv2CrewSystemRevoke_(state, ctx) {
  return Object.assign({}, state, {
    G: state.G + 1, phase: 'revoking', grantHash: null,
    revoke: { revokeId: 'system-' + state.G, credHash: null, cacheKeys: ctx.cacheKeys || [], requestedAt: ctx.now },
  });
}

/**
 * Namespace-safe purge (§8.2 step 2-3): only keys starting with "fcx.", parts first, manifest last.
 * store: { keys(), del(key) }. Never deletes or counts as ours any other key.
 */
function fcv2CrewPurge_(store) {
  const before = store.keys();
  const ours = before.filter(function (k) { return k.indexOf(FCV2_CREW_PREFIX_) === 0; });
  const others = before.length - ours.length;
  const order = ours.filter(function (k) { return k !== FCV2_CREW_MANIFEST_KEY_; });
  if (ours.indexOf(FCV2_CREW_MANIFEST_KEY_) >= 0) order.push(FCV2_CREW_MANIFEST_KEY_);
  let deleted = 0;
  let failed = false;
  for (let i = 0; i < order.length; i++) {
    try { store.del(order[i]); deleted++; } catch (err) { failed = true; break; }
  }
  const after = store.keys();
  const remaining = after.filter(function (k) { return k.indexOf(FCV2_CREW_PREFIX_) === 0; }).length;
  return { complete: !failed && remaining === 0 && after.length - remaining === others, deleted: deleted, remaining: remaining };
}

/**
 * Full revocation under the lock: begin (logical invalidation, cache keys captured from the manifest
 * BEFORE it is deleted), purge, cache removal, confirm.
 * env: { lock(fn), getState(), setState(s), store, cacheRemove(keys), now, hash }
 */
function fcv2CrewRevoke_(env, req) {
  return env.lock(function () {
    const state = env.getState();
    const raw = env.store.get(FCV2_CREW_MANIFEST_KEY_);
    let cacheKeys = [];
    try { cacheKeys = raw ? (JSON.parse(raw).cacheKeys || []) : []; } catch (err) { cacheKeys = []; }
    const begin = fcv2CrewBeginRevoke_(state, req, { hash: env.hash, cacheKeys: cacheKeys, now: env.now });
    if (begin.result) return begin.result;
    if (begin.state) env.setState(begin.state);
    const current = begin.state || state;
    const purge = fcv2CrewPurge_(env.store);
    env.cacheRemove(current.revoke.cacheKeys);
    if (!purge.complete) return { ok: false, error: 'revoke-incomplete', state: 'revoking', remaining: purge.remaining };
    const done = Object.assign({}, current, {
      phase: 'deleted', revoke: null,
      lastRevoke: { revokeId: current.revoke.revokeId, G: current.G, outcome: 'deleted', deletedKeys: purge.deleted, at: env.now },
    });
    env.setState(done);
    return { ok: true, state: 'deleted', deletedKeys: purge.deleted };
  });
}

// ---------------------------------------------------------------------------
// Encoding, storage sizes, commit, GC, snapshot reads (spec §7, §9)
// ---------------------------------------------------------------------------

/** Compact month content: a per-month key dictionary and minutes since epoch. */
function fcv2CrewEncodeMonth_(built, deps) {
  const dict = [];
  const index = {};
  const ki = function (k) { if (!(k in index)) { index[k] = dict.length; dict.push(k); } return index[k]; };
  const d = built.duties.map(function (x) {
    return [x.key, Math.round(x.start / 60000), Math.round(x.end / 60000), x.lpk || '',
      x.sectors.map(function (s) { return [s.fn, s.route, s.keys.map(ki)]; }), x.tied ? 1 : 0];
  });
  const body = deps.pack(JSON.stringify({ v: 1, m: built.month, k: dict, d: d }));
  return { body: body, digest: deps.hash(body).slice(0, 32) };
}

function fcv2CrewDecodeMonth_(body, deps) {
  const o = JSON.parse(deps.unpack(body));
  return o.d.map(function (x) {
    return {
      key: x[0], start: x[1] * 60000, end: x[2] * 60000, lpk: x[3] || null, tied: x[5] === 1,
      sectors: x[4].map(function (s) { return { fn: s[0], route: s[1], keys: s[2].map(function (i) { return o.k[i]; }) }; }),
    };
  });
}

function fcv2CrewPartKey_(G, epoch, month, gen, part) {
  return FCV2_CREW_PREFIX_ + 's.' + G + '.' + epoch + '.' + month + '.' + gen + '.' + part;
}

function fcv2CrewPartHeader_(G, epoch, month, gen, part, of) {
  return [G, epoch, month, gen, part, of].join('|') + '|';
}

/** Splits an encoded month body into stored values (header + chunk), each <= FCV2_CREW_PART_MAX_. */
function fcv2CrewParts_(G, epoch, month, gen, body) {
  const room = FCV2_CREW_PART_MAX_ - fcv2CrewPartHeader_(G, epoch, month, gen, 9, 9).length;
  const n = Math.max(1, Math.ceil(body.length / room));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ key: fcv2CrewPartKey_(G, epoch, month, gen, i), value: fcv2CrewPartHeader_(G, epoch, month, gen, i, n) + body.slice(i * room, (i + 1) * room) });
  }
  return out;
}

/** Bytes a store holds: UTF-8 bytes of every key and value (all crew values are ASCII). */
function fcv2CrewStoreBytes_(store) {
  return store.keys().reduce(function (n, k) {
    const v = store.get(k);
    return n + fcv2CrewUtf8_(k) + fcv2CrewUtf8_(v || '');
  }, 0);
}

function fcv2CrewUtf8_(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/**
 * Peak admission (§9.4): everything stored now (U + C + R + O + K + current manifest), minus the
 * current manifest, plus the manifest reserve, the new parts and the safety margin.
 */
function fcv2CrewPeak_(storeBytes, manifestBytes, newPartsBytes) {
  return storeBytes - manifestBytes + FCV2_CREW_MANIFEST_MAX_ + newPartsBytes + FCV2_CREW_SAFETY_;
}

const FCV2_CREW_MISSING_KEYS_ = ['noCrewList', 'ownerMissing', 'missingId', 'parseFailed'];
const FCV2_CREW_GROUPING_KEYS_ = ['chainBreak', 'hiddenEvent', 'shortRest', 'tiedFlights', 'dutyUnbounded'];
const FCV2_CREW_STATUS_CODES_ = { ok: 'o', replacing: 'p', uncovered: 'u', replaceFailed: 'r' };

/** Compact manifest month entry: [gen, parts, digest, verifiedAtMinutes, status, missing[] | 0, grouping[] | 0]. */
function fcv2CrewEntryOut_(e) {
  const counts = function (o, keys) { return o ? keys.map(function (k) { return o[k] || 0; }) : 0; };
  return [e.gen, e.parts, e.digest || '', e.verifiedAt ? Math.round(e.verifiedAt / 60000) : 0, FCV2_CREW_STATUS_CODES_[e.status],
    counts(e.missing, FCV2_CREW_MISSING_KEYS_), counts(e.grouping, FCV2_CREW_GROUPING_KEYS_)];
}

function fcv2CrewEntryIn_(a) {
  const status = Object.keys(FCV2_CREW_STATUS_CODES_).filter(function (k) { return FCV2_CREW_STATUS_CODES_[k] === a[4]; })[0];
  const obj = function (arr, keys) {
    if (!arr) return null;
    const o = {};
    keys.forEach(function (k, i) { o[k] = arr[i]; });
    return o;
  };
  return { gen: a[0], parts: a[1], digest: a[2] || null, verifiedAt: a[3] ? a[3] * 60000 : null, status: status,
    missing: obj(a[5], FCV2_CREW_MISSING_KEYS_), grouping: obj(a[6], FCV2_CREW_GROUPING_KEYS_) };
}

/** Serialized manifest (compact entries); its length is what the 8 KB cap applies to. */
function fcv2CrewManifestRaw_(m) {
  const months = {};
  Object.keys(m.months).forEach(function (k) { months[k] = fcv2CrewEntryOut_(m.months[k]); });
  return JSON.stringify(Object.assign({}, m, { months: months }));
}

function fcv2CrewEmptyManifest_(state) {
  return { schema: FCV2_CREW_SCHEMA_, G: state.G, epoch: state.epoch, mgen: 0, months: {}, retired: [], cacheKeys: [] };
}

/**
 * Structural validation of a parsed manifest (correction pass): supported schema, required fields and
 * types, every month entry and retired record well-formed. Anything else is never read, committed over
 * or garbage-collected (only an explicit revocation deletes it).
 */
function fcv2CrewValidManifest_(m) {
  const isInt = function (x, min) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x && x >= min; };
  const isObj = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
  const counts = function (x, n) { return x === 0 || (Array.isArray(x) && x.length === n && x.every(function (v) { return isInt(v, 0); })); };
  const codes = Object.keys(FCV2_CREW_STATUS_CODES_).map(function (k) { return FCV2_CREW_STATUS_CODES_[k]; });
  if (!isObj(m) || m.schema !== FCV2_CREW_SCHEMA_) return false;
  if (!isInt(m.G, 1) || typeof m.epoch !== 'string' || !m.epoch || !isInt(m.mgen, 0)) return false;
  if (!isObj(m.months) || !Array.isArray(m.retired) || !Array.isArray(m.cacheKeys)) return false;
  const monthsOk = Object.keys(m.months).every(function (k) {
    const e = m.months[k];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(k) || !Array.isArray(e) || e.length !== 7) return false;
    if (!isInt(e[0], 0) || !isInt(e[1], 0) || e[1] > FCV2_CREW_MAX_PARTS_ || typeof e[2] !== 'string' || !isInt(e[3], 0)) return false;
    if (codes.indexOf(e[4]) < 0 || !counts(e[5], FCV2_CREW_MISSING_KEYS_.length) || !counts(e[6], FCV2_CREW_GROUPING_KEYS_.length)) return false;
    return e[1] === 0 || (e[0] > 0 && /^[0-9a-f]{32}$/.test(e[2]));
  });
  const retiredOk = m.retired.every(function (r) {
    return Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && r[0].indexOf(FCV2_CREW_PREFIX_ + 's.') === 0 && isInt(r[1], 0);
  });
  const cacheOk = m.cacheKeys.every(function (k) { return typeof k === 'string' && k.indexOf(FCV2_CREW_PREFIX_) === 0; });
  return monthsOk && retiredOk && cacheOk;
}

/**
 * The stored manifest, classified: absent (an empty one for this generation), ok, foreign (valid but of
 * another generation/epoch) or invalid (unparsable, unsupported schema or malformed).
 */
function fcv2CrewManifest_(store, state) {
  const raw = store.get(FCV2_CREW_MANIFEST_KEY_);
  if (!raw) return { kind: 'absent', manifest: fcv2CrewEmptyManifest_(state) };
  let m;
  try { m = JSON.parse(raw); } catch (err) { return { kind: 'invalid', manifest: null }; }
  if (!fcv2CrewValidManifest_(m)) return { kind: 'invalid', manifest: null };
  if (m.G !== state.G || m.epoch !== state.epoch) return { kind: 'foreign', manifest: null };
  Object.keys(m.months).forEach(function (k) { m.months[k] = fcv2CrewEntryIn_(m.months[k]); });
  return { kind: 'ok', manifest: m };
}

/**
 * The stale marker for a failed replacement could not be written: fail closed by deleting the old
 * generation's parts, so every reader of that month finds a missing part and returns stale/no counts
 * (§7.2a). Deleting frees space, so it is the write most likely to succeed when the store is full.
 */
function fcv2CrewFailClosed_(store, state, month, prev) {
  let ok = true;
  for (let i = 0; i < prev.parts; i++) {
    try { store.del(fcv2CrewPartKey_(state.G, state.epoch, month, prev.gen, i)); } catch (err) { ok = false; }
  }
  return { outcome: ok ? 'replaceFailed' : 'replaceFailed-unpersisted', closedBy: ok ? 'parts-deleted' : null };
}

/**
 * Crash-safe commit of one month (§7.2, §7.2a). Must run under the script lock.
 * captured: { G, epoch, mgen } read when the month was built (outside the lock).
 * entry: { body, digest, verifiedAt, missing, grouping }.
 * A replacement of an indexed month first persists status "replacing" (stale for every reader), so a
 * crash or any later failure can never leave the old generation reported as fresh. If even that marker
 * cannot be written, the old parts are deleted (fail closed).
 * Outcomes: committed | aborted-generation | aborted-conflict | index-incompatible | uncovered |
 * replaceFailed | replaceFailed-unpersisted (nothing durable could be written: the caller must treat
 * the month as stale for this request; across requests this is the documented limitation).
 */
function fcv2CrewCommitMonth_(env, captured, month, entry) {
  const state = env.getState();
  if (state.phase !== 'active' || state.G !== captured.G || state.epoch !== captured.epoch) return { outcome: 'aborted-generation' };
  const store = env.store;
  const read = fcv2CrewManifest_(store, state);
  if (read.kind === 'invalid') return { outcome: 'index-incompatible' };
  if (read.kind === 'foreign') return { outcome: 'aborted-generation' };
  const manifest = read.manifest;
  if (manifest.mgen !== captured.mgen) return { outcome: 'aborted-conflict' };
  const clone = function (m) { return JSON.parse(JSON.stringify(m)); };
  const prev = manifest.months[month] || null;
  const replacing = !!(prev && prev.gen > 0);
  let base = manifest;
  if (replacing) {
    const marked = clone(manifest);
    marked.mgen++;
    marked.months[month] = Object.assign({}, prev, { status: 'replacing' });
    try { store.set(FCV2_CREW_MANIFEST_KEY_, fcv2CrewManifestRaw_(marked)); base = marked; }
    catch (err) { return fcv2CrewFailClosed_(store, state, month, prev); }
  }
  const gen = prev ? prev.gen + 1 : 1;
  const parts = fcv2CrewParts_(state.G, state.epoch, month, gen, entry.body);
  const partsBytes = parts.reduce(function (n, p) { return n + fcv2CrewUtf8_(p.key) + fcv2CrewUtf8_(p.value); }, 0);
  const manifestRaw = store.get(FCV2_CREW_MANIFEST_KEY_) || '';
  const peak = fcv2CrewPeak_(fcv2CrewStoreBytes_(store), fcv2CrewUtf8_(FCV2_CREW_MANIFEST_KEY_) + fcv2CrewUtf8_(manifestRaw), partsBytes);
  const fail = function () {
    const next = clone(base);
    next.mgen++;
    if (replacing) next.months[month] = Object.assign({}, prev, { status: 'replaceFailed' });
    else next.months[month] = { gen: 0, parts: 0, digest: null, verifiedAt: null, status: 'uncovered', missing: null, grouping: null };
    // If this write fails too, a replacement is still marked "replacing" (stale) and a new month stays
    // absent (pending): neither is ever reported fresh.
    try { store.set(FCV2_CREW_MANIFEST_KEY_, fcv2CrewManifestRaw_(next)); } catch (err) { /* see above */ }
    return { outcome: replacing ? 'replaceFailed' : 'uncovered', peak: peak };
  };
  if (parts.length > FCV2_CREW_MAX_PARTS_ || peak > FCV2_CREW_STORE_LIMIT_) return fail();
  const written = [];
  const unstage = function () { written.forEach(function (k) { try { store.del(k); } catch (e) { /* orphan, removed by GC */ } }); };
  try {
    parts.forEach(function (p) { store.set(p.key, p.value); written.push(p.key); });
  } catch (err) { unstage(); return fail(); }
  const next = clone(base);
  next.mgen++;
  next.months[month] = { gen: gen, parts: parts.length, digest: entry.digest, verifiedAt: entry.verifiedAt, status: 'ok', missing: entry.missing, grouping: entry.grouping };
  if (replacing) {
    for (let i = 0; i < prev.parts; i++) next.retired.push([fcv2CrewPartKey_(state.G, state.epoch, month, prev.gen, i), env.now]);
  }
  const raw = fcv2CrewManifestRaw_(next);
  if (raw.length > FCV2_CREW_MANIFEST_MAX_) { unstage(); return fail(); }
  try { store.set(FCV2_CREW_MANIFEST_KEY_, raw); } catch (err) { unstage(); return fail(); }
  return { outcome: 'committed', gen: gen, peak: peak, mgen: next.mgen };
}

/** Garbage collection (§7.6). Must run under the script lock. Only fcx.s.* keys of a valid, current manifest's store are deleted. */
function fcv2CrewGc_(env) {
  const state = env.getState();
  const store = env.store;
  const read = fcv2CrewManifest_(store, state);
  if (read.kind !== 'ok') return { deleted: 0, skipped: read.kind };
  const manifest = read.manifest;
  const referenced = {};
  Object.keys(manifest.months).forEach(function (m) {
    const e = manifest.months[m];
    for (let i = 0; i < e.parts; i++) referenced[fcv2CrewPartKey_(manifest.G, manifest.epoch, m, e.gen, i)] = true;
  });
  const retiredKeys = {};
  const keep = [];
  let deleted = 0;
  manifest.retired.forEach(function (r) {
    if (env.now - r[1] >= FCV2_CREW_GC_GRACE_MS_) { try { store.del(r[0]); deleted++; } catch (err) { keep.push(r); retiredKeys[r[0]] = true; } }
    else { keep.push(r); retiredKeys[r[0]] = true; }
  });
  store.keys().forEach(function (k) {
    if (k.indexOf(FCV2_CREW_PREFIX_ + 's.') !== 0 || referenced[k] || retiredKeys[k]) return;
    try { store.del(k); deleted++; } catch (err) { /* next GC */ }
  });
  if (keep.length !== manifest.retired.length) {
    const next = JSON.parse(JSON.stringify(manifest));
    next.retired = keep;
    next.mgen++;
    try { store.set(FCV2_CREW_MANIFEST_KEY_, fcv2CrewManifestRaw_(next)); } catch (err) { /* retired list kept; parts already gone are harmless */ }
  }
  return { deleted: deleted };
}

/**
 * Whole-query snapshot (§7.6, Revision 4.1): one manifest for every month, every part validated
 * against it; any failure restarts the whole query; after the attempts are exhausted nothing
 * authoritative is returned. env: { getState(), store, now, deps: { hash, unpack }, hook?(attempt) }.
 * A month verified more than 14 days ago, or marked "replacing", is reported stale.
 */
function fcv2CrewReadSnapshot_(env, months) {
  for (let attempt = 1; attempt <= FCV2_CREW_SNAPSHOT_ATTEMPTS_; attempt++) {
    const state = env.getState();
    if (state.phase !== 'active') return { ok: false, reason: 'revoked' };
    const read = fcv2CrewManifest_(env.store, state);
    if (read.kind === 'invalid' || read.kind === 'foreign') return { ok: false, reason: 'index-incompatible' };
    const manifest = read.manifest;
    if (env.hook) env.hook(attempt);
    const data = {};
    const status = {};
    let valid = true;
    for (let i = 0; i < months.length && valid; i++) {
      const m = months[i];
      const e = manifest.months[m];
      if (!e) { status[m] = { status: 'pending' }; continue; }
      const aged = e.status === 'ok' && !(env.now - e.verifiedAt <= FCV2_CREW_FRESH_MS_);
      const shown = e.status === 'ok' ? (aged ? 'stale' : 'fresh') : e.status === 'replacing' ? 'stale' : e.status;
      status[m] = { status: shown, missing: e.missing, grouping: e.grouping, verifiedAt: e.verifiedAt };
      if (!e.gen) continue;
      let body = '';
      for (let p = 0; p < e.parts; p++) {
        const v = env.store.get(fcv2CrewPartKey_(manifest.G, manifest.epoch, m, e.gen, p));
        const header = fcv2CrewPartHeader_(manifest.G, manifest.epoch, m, e.gen, p, e.parts);
        if (typeof v !== 'string' || v.indexOf(header) !== 0) { valid = false; break; }
        body += v.slice(header.length);
      }
      if (!valid) break;
      if (env.deps.hash(body).slice(0, 32) !== e.digest) { valid = false; break; }
      try { data[m] = fcv2CrewDecodeMonth_(body, env.deps); } catch (err) { valid = false; }
    }
    if (valid) return { ok: true, mgen: manifest.mgen, months: data, status: status, attempts: attempt };
  }
  return { ok: false, reason: 'snapshot-unavailable' };
}
