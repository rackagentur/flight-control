// ============================================================================
// FLIGHT CONTROL — CREW INTELLIGENCE CORE (Phase 1a, synthetic only)
// ============================================================================
// NOT DEPLOYED. Not part of the installed Apps Script project and not loaded by the
// fc.roster v2 sandbox (tests/gs-harness.js GS_FILES). Specification:
// docs/CREW-INTELLIGENCE.md Revision 4.1 + Phase 1b. Live backend actions are not
// authorized; this file holds only the pure, Node-tested algorithms:
//   - canonical duty grouping (delegates to the roster's own fcv2Duties_, RosterModelV2.gs,
//     which must be loaded in the same global scope) and conservative linking
//   - monthly ownership with read-window extension, completion and sealing rules
//   - familiarity counting before a selected duty, suspect groups, result states
//   - generation-based access (enroll / authorize / revoke) and namespace-safe purge
//   - fingerprints, partitioned manifests (root + one document per year), crash-safe month
//     commit, reconciliation helpers, garbage collection and whole-query snapshot reads
//   - encoded storage sizes and peak admission
//
// Input crew entries are already parsed by the airline adapter (a later phase):
//   { rank, id, family, given } or { parseFailed: true }; id may be null.
// Every I/O and crypto primitive is injected (deps / env). No Apps Script service is
// used, nothing is logged, and no thrown message contains crew text.
// All names start with fcv2Crew and end in "_" (not callable through google.script.run).
// ============================================================================

const FCV2_CREW_LINK_SPAN_MS_ = 20 * 3600000;     // suspect-group link span: max augmented FDP 18 h + 2 h (spec §6.3b, A2)
const FCV2_CREW_MIN_REST_MS_ = 10 * 3600000;      // connected duties closer than a minimum rest are linked (shortRest)
const FCV2_CREW_SCHEMA_ = 2;                      // 2 = partitioned manifest (Phase 1b); 1 was never deployed
const FCV2_CREW_PARSER_VERSION_ = 1;
const FCV2_CREW_DUTY_RULES_ = 1;
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
const FCV2_CREW_CANCEL_MAX_ = 64;                 // grant tombstones kept in FC_CREW_STATE.cancelled (never evicted)

// ---------------------------------------------------------------------------
// Duties
// ---------------------------------------------------------------------------

/**
 * Canonical duties: the roster's own fcv2Duties_ (RosterModelV2.gs, unchanged) on flights in exactly the
 * order fcv2BuildRoster_ gives it — by start, then end, stable. No second copy of the chaining rule.
 * Flights with an identical start and end make the grouping depend on input order; their duties are
 * marked `tied` (a grouping-uncertainty anomaly) instead of being silently re-ordered.
 */
function fcv2CrewGroupDuties_(flights, deps) {
  const sorted = flights.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  const tied = {};
  sorted.forEach(function (f, i) {
    const n = sorted[i + 1];
    if (n && n.start === f.start && n.end === f.end) { tied[i] = true; tied[i + 1] = true; }
  });
  const bySector = {};
  sorted.forEach(function (f, i) { bySector['s_' + deps.hash(String(f.sourceId)).slice(0, 16)] = i; });
  const duties = fcv2Duties_(sorted.map(function (f) {
    return { sourceId: f.sourceId, start: f.start, end: f.end, flight: { origin: f.origin, destination: f.destination } };
  }), [], [], { hash: deps.hash });
  return duties.map(function (d) {
    const idx = d.sectorIds.map(function (id) { return bySector[id]; });
    const fl = idx.map(function (i) { return sorted[i]; });
    const first = fl[0];
    const last = fl[fl.length - 1];
    return {
      key: d.id.slice(2), start: first.start, end: last.end, origin: first.origin, destination: last.destination,
      flights: fl, lpk: null, link: null, tied: idx.some(function (i) { return tied[i] === true; }),
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
    return { duties: duties, edges: edges, from: from, to: to, read: got };
  }
}

/** Edge rule for a contiguous run of target duties [i0..i1] (spec §5.3). */
function fcv2CrewEdges_(duties, i0, i1, from, to) {
  if (i0 < 0) return { back: false, fwd: false };
  const first = duties[i0];
  const needed = first.lpk && i0 > 0 ? duties[i0 - 1] : first;   // a linked predecessor must be whole too
  return {
    back: needed.flights[0].start < from + FCV2_DUTY_GAP_MS_ || first.start - from < FCV2_CREW_LINK_SPAN_MS_,
    fwd: duties[i1].end > to - FCV2_DUTY_GAP_MS_,
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
  return {
    month: month, duties: out, missing: missing, grouping: grouping, openDuties: openDuties, window: { from: w.from, to: w.to },
    inputs: w.read,                                                    // final window events, for the fingerprint only (never stored)
  };
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

/** First 32 hex of a grant hash: the form kept in tombstones and revocation receipts (no crew data). */
function fcv2CrewShortHash_(hash) {
  return typeof hash === 'string' ? hash.slice(0, 32) : null;
}

/** True when this grant hash was cancelled (§8.7): it can never be activated. */
function fcv2CrewTombstoned_(state, grantHash) {
  const list = state && Array.isArray(state.cancelled) ? state.cancelled : [];
  return list.indexOf(fcv2CrewShortHash_(grantHash)) >= 0;
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
  const codeHash = ctx.hash(req.code);
  const grantHash = ctx.hash(req.grant);
  // An unfinished owner purge (durable fence, §8.3) closes enrollment until the purge completes. Checked first,
  // under the lock; no failure count, no burn, no consume, no state change.
  if (state.purging === true) return { result: { ok: false, error: 'enroll-closed' } };
  // A cancelled grant can never be activated (§8.7): checked first, under the same lock as cancellation. No
  // failure count, no burn, no consume, no state change; the outstanding code stays available for other grants.
  if (fcv2CrewTombstoned_(state, grantHash)) return { result: { ok: false, error: 'enroll-closed' } };
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
  // A valid owner code may also supersede an interrupted revocation (e.g. a pepper rotation whose cleanup
  // failed): the old index is never reinterpreted (new G and epoch) and is purged under `purge` (§8.6).
  const interrupted = state.phase === 'revoking' && state.revoke
    ? { revokeId: state.revoke.revokeId, G: state.G, outcome: 'superseded', deletedKeys: 0, at: ctx.now, aliases: [], credHash: fcv2CrewShortHash_(state.revoke.credHash) } : null;
  return {
    result: { ok: true, enrolled: true, G: state.G + 1 }, consume: true,
    state: {
      G: state.G + 1, phase: 'active', pid: ctx.pid, epoch: ctx.newEpoch, grantHash: grantHash, codeHash: codeHash,
      enrolledAt: ctx.now, revoke: null, lastRevoke: interrupted || state.lastRevoke || null,
      purge: { pending: true, cacheKeys: (ctx.cacheKeys || []).concat(state.revoke ? state.revoke.cacheKeys || [] : []) },
      cancelled: Array.isArray(state.cancelled) ? state.cancelled.slice() : [],   // tombstones are never evicted
    },
  };
}

/**
 * Revocation start (§8.1, §8.2 step 1, §8.7). Returns { result } (done, nothing to do), { state?, proceed: true },
 * or { cancel: true, state } (append a grant tombstone, nothing else changes).
 * Order: 1 receipt of this revokeId bound to this grant; 2 the live grant -> revoke; 3 the revocation in progress
 * for this grant -> proceed; 4 any other grant -> cancellation (tombstone). Every state built here keeps the
 * purge fence (`purging`, §8.3) via Object.assign.
 */
function fcv2CrewBeginRevoke_(state, req, ctx) {
  if (!req || typeof req.revokeId !== 'string' || typeof req.grant !== 'string') return { result: { ok: false, error: 'bad-request' } };
  const grantHash = ctx.hash(req.grant);
  const last = state.lastRevoke;
  // A receipt answers ONLY for the grant it was issued for. Unbound receipts (legacy records, system or purge
  // receipts: no credHash) never answer; the request falls through to the normal order below.
  if (last && typeof last.credHash === 'string' && last.credHash === fcv2CrewShortHash_(grantHash)
    && (last.revokeId === req.revokeId || (last.aliases || []).indexOf(req.revokeId) >= 0)) {
    return { result: { ok: true, state: 'deleted', recorded: true, deletedKeys: last.deletedKeys } };
  }
  if (state.phase === 'revoking') {
    const system = state.revoke.revokeId.indexOf('system-') === 0;
    const sameGrant = fcv2CrewSafeEqual_(state.revoke.credHash, grantHash);
    if ((state.revoke.revokeId === req.revokeId || system) && sameGrant) return { proceed: true, alias: req.revokeId };
    if (sameGrant) return { result: { ok: false, error: 'busy' } };
  }
  if (state.phase !== 'active' || !fcv2CrewSafeEqual_(state.grantHash, grantHash)) {
    // Cancellation (§8.7): this grant is not live; record a tombstone so it can never be activated later.
    const list = Array.isArray(state.cancelled) ? state.cancelled : [];
    if (list.indexOf(fcv2CrewShortHash_(grantHash)) >= 0) return { result: { ok: true, state: 'cancelled', recorded: true, deletedKeys: 0 } };
    if (list.length >= FCV2_CREW_CANCEL_MAX_) return { result: { ok: false, error: 'busy' } };   // never falsely definitive
    return { cancel: true, short: fcv2CrewShortHash_(grantHash), state: Object.assign({}, state, { cancelled: list.concat([fcv2CrewShortHash_(grantHash)]) }) };
  }
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
    // credHash: the grant that was current, so the owner's app can authenticate the cleanup (§8.5);
    // it grants nothing (phase is revoking; grantHash is cleared).
    revoke: { revokeId: 'system-' + state.G, credHash: state.grantHash || null, cacheKeys: ctx.cacheKeys || [], requestedAt: ctx.now },
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
 * Cache entries are epoch-scoped and expire within 6 h; a failed removal never blocks a revocation or a
 * purge (it is reported, and the entries are unreachable under the new generation anyway).
 */
function fcv2CrewCacheRemove_(env, keys) {
  if (!keys || !keys.length) return true;
  try { env.cacheRemove(keys); return true; } catch (err) { return false; }
}

/**
 * Resumable purge of every fcx.* key that does not belong to the current generation (§8.6): runs under the
 * lock after a re-enrollment or a superseded revocation. Keys of the current G/epoch are kept; the root is
 * removed only when it is not the current generation's. Clears state.purge when nothing obsolete remains.
 */
function fcv2CrewResumePurge_(env) {
  const state = env.getState();
  if (!state.purge || !state.purge.pending || state.phase !== 'active') return { done: true, deleted: 0 };
  const own = ['s.', 'y.'].map(function (k) { return FCV2_CREW_PREFIX_ + k + state.G + '.' + state.epoch + '.'; });
  let rootCurrent = false;
  try {
    const r = JSON.parse(env.store.get(FCV2_CREW_MANIFEST_KEY_) || 'null');
    rootCurrent = !!r && r.G === state.G && r.epoch === state.epoch;
  } catch (err) { rootCurrent = false; }
  let deleted = 0;
  let failed = false;
  env.store.keys().forEach(function (k) {
    if (k.indexOf(FCV2_CREW_PREFIX_) !== 0) return;
    if (own.some(function (p) { return k.indexOf(p) === 0; })) return;
    if (k === FCV2_CREW_MANIFEST_KEY_ && rootCurrent) return;
    try { env.store.del(k); deleted++; } catch (err) { failed = true; }
  });
  fcv2CrewCacheRemove_(env, state.purge.cacheKeys);
  if (failed) return { done: false, deleted: deleted };
  env.setState(Object.assign({}, state, { purge: null }));
  return { done: true, deleted: deleted };
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
    if (begin.cancel) {
      env.setState(begin.state);                                       // only `cancelled` differs
      const back = env.getState();
      if (!back || !Array.isArray(back.cancelled) || back.cancelled.indexOf(begin.short) < 0) return { ok: false, error: 'crew-unavailable' };
      return { ok: true, state: 'cancelled', deletedKeys: 0 };
    }
    if (begin.state) env.setState(begin.state);
    const current = begin.state || state;
    const purge = fcv2CrewPurge_(env.store);
    const cacheCleared = fcv2CrewCacheRemove_(env, current.revoke.cacheKeys);
    if (!purge.complete) return { ok: false, error: 'revoke-incomplete', state: 'revoking', remaining: purge.remaining };
    const aliases = begin.alias && begin.alias !== current.revoke.revokeId ? [begin.alias] : [];
    const done = Object.assign({}, current, {
      phase: 'deleted', revoke: null, purge: null,
      lastRevoke: { revokeId: current.revoke.revokeId, G: current.G, outcome: 'deleted', deletedKeys: purge.deleted, at: env.now, aliases: aliases, credHash: fcv2CrewShortHash_(current.revoke.credHash) },
    });
    env.setState(done);
    return { ok: true, state: 'deleted', deletedKeys: purge.deleted, cacheCleared: cacheCleared };
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

const FCV2_CREW_PAYLOAD_VERSION_ = 1;
const FCV2_CREW_MIN_MINUTE_ = Date.UTC(2000, 0, 1) / 60000;   // plausibility bounds for encoded minutes
const FCV2_CREW_MAX_MINUTE_ = Date.UTC(2100, 0, 1) / 60000;
const FCV2_CREW_MAX_DUTY_MINUTES_ = 14 * 1440;                // a stored duty never spans more than 14 days

/**
 * Strict validation of the ENCODED month payload, before any conversion (the contract written by
 * fcv2CrewEncodeMonth_): {v: 1, m: "YYYY-MM", k: [22-char keys], d: [[key16hex, startMin, endMin, lpk16hex|"",
 * [[flightNumber, "AAA-BBB", [keyIndex…]], …], tied 0|1], …]}. Exact keys and tuple lengths, integer minutes
 * within plausible bounds with end >= start and the start in the expected home month, integer dictionary
 * indices within bounds, tied exactly 0 or 1. Nothing is coerced; anything else is rejected.
 */
function fcv2CrewValidPayload_(o, month, deps) {
  const isInt = function (x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; };
  const isObj = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
  if (!isObj(o) || Object.keys(o).sort().join(',') !== 'd,k,m,v') return false;
  if (o.v !== FCV2_CREW_PAYLOAD_VERSION_ || typeof month !== 'string' || o.m !== month) return false;
  if (!Array.isArray(o.k) || !Array.isArray(o.d)) return false;
  const seenKey = {};
  for (let i = 0; i < o.k.length; i++) {
    const k = o.k[i];
    if (typeof k !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(k) || seenKey[k]) return false;
    seenKey[k] = true;
  }
  const seenDuty = {};
  for (let i = 0; i < o.d.length; i++) {
    const x = o.d[i];
    if (!Array.isArray(x) || x.length !== 6) return false;
    if (typeof x[0] !== 'string' || !/^[0-9a-f]{16}$/.test(x[0]) || seenDuty[x[0]]) return false;
    seenDuty[x[0]] = true;
    if (!isInt(x[1]) || !isInt(x[2]) || x[1] < FCV2_CREW_MIN_MINUTE_ || x[2] > FCV2_CREW_MAX_MINUTE_) return false;
    if (x[2] < x[1] || x[2] - x[1] > FCV2_CREW_MAX_DUTY_MINUTES_) return false;
    if (typeof deps.monthOf !== 'function' || deps.monthOf(x[1] * 60000) !== month) return false;
    if (typeof x[3] !== 'string' || !(x[3] === '' || /^[0-9a-f]{16}$/.test(x[3]))) return false;
    if (x[5] !== 0 && x[5] !== 1) return false;
    if (!Array.isArray(x[4]) || x[4].length === 0) return false;
    for (let j = 0; j < x[4].length; j++) {
      const s = x[4][j];
      if (!Array.isArray(s) || s.length !== 3) return false;
      if (typeof s[0] !== 'string' || !s[0] || s[0].length > 12 || typeof s[1] !== 'string' || !/^[A-Z]{3}-[A-Z]{3}$/.test(s[1])) return false;
      if (!Array.isArray(s[2]) || !s[2].every(function (ix) { return isInt(ix) && ix >= 0 && ix < o.k.length; })) return false;
    }
  }
  return true;
}

/** Decodes a month body; throws (without content) unless the encoded payload passes fcv2CrewValidPayload_. */
function fcv2CrewDecodeMonth_(body, deps, month) {
  let o;
  try { o = JSON.parse(deps.unpack(body)); } catch (err) { throw new Error('invalid-payload'); }
  if (!fcv2CrewValidPayload_(o, month, deps)) throw new Error('invalid-payload');
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

// ---------------------------------------------------------------------------
// Fingerprints (spec §7.3)
// ---------------------------------------------------------------------------

/**
 * Month fingerprint over every input that affects grouping or familiarity: all flight and hidden events
 * of the final read window (times, flight number, airports, crew lines as keyed hashes, parse failures),
 * the window bounds and the rule versions. ctx.hmac(text) is keyed with the pepper, so the value reveals
 * nothing about names or identifiers. Returns 32 hex characters.
 */
function fcv2CrewFingerprint_(built, ctx) {
  const crew = function (list) {
    if (!list || !list.length) return null;
    return list.map(function (c) {
      if (c.parseFailed) return '!';
      return [c.rank || '', c.id ? ctx.hmac('id|' + c.id) : '', ctx.hmac('n|' + (c.family || '') + '|' + (c.given || ''))];
    });
  };
  const flights = (built.inputs.flights || []).map(function (f) {
    return [String(f.sourceId), f.start, f.end, f.flightNumber || '', f.origin, f.destination, crew(f.crew)];
  }).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });
  const hidden = (built.inputs.hidden || []).map(function (h) { return [h.start, h.end]; })
    .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
  const canonical = JSON.stringify({
    v: [FCV2_CREW_SCHEMA_, FCV2_CREW_PARSER_VERSION_, FCV2_CREW_DUTY_RULES_], self: ctx.hmac('self|' + ctx.selfId),
    month: built.month, window: [built.window.from, built.window.to], flights: flights, hidden: hidden,
  });
  return ctx.hmac('fp|' + canonical).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Partitioned manifest (Phase 1b, schema 2): a small root + one immutable document per year
// ---------------------------------------------------------------------------
//   fcx.m                                  root: {schema, G, epoch, mgen, years: {YYYY: [ygen, digest]}, retired, cacheKeys}
//   fcx.y.<G>.<epoch>.<YYYY>.<ygen>        year document: header "G|epoch|YYYY|ygen|" + {"m": {"MM": entry}}
//   fcx.s.<G>.<epoch>.<YYYY-MM>.<gen>.<p>  month parts (unchanged)
// A publication writes the changed year documents (new ygen, staged) and then the root (one write = the
// atomic commit point). Readers take one root, validate every referenced year document and part, and
// restart the whole query on any mismatch. Superseded year documents and parts are retired and removed
// by GC after the grace period.

const FCV2_CREW_MISSING_KEYS_ = ['noCrewList', 'ownerMissing', 'missingId', 'parseFailed'];
const FCV2_CREW_GROUPING_KEYS_ = ['chainBreak', 'hiddenEvent', 'shortRest', 'tiedFlights', 'dutyUnbounded'];
const FCV2_CREW_STATUS_CODES_ = { ok: 'o', replacing: 'p', uncovered: 'u', replaceFailed: 'r' };

/** Compact month entry: [gen, parts, digest, verifiedAtMinutes, status, missing[] | 0, grouping[] | 0, fp, neighbourFlag]. */
function fcv2CrewEntryOut_(e) {
  const counts = function (o, keys) { return o ? keys.map(function (k) { return o[k] || 0; }) : 0; };
  return [e.gen, e.parts, e.digest || '', e.verifiedAt ? Math.round(e.verifiedAt / 60000) : 0, FCV2_CREW_STATUS_CODES_[e.status],
    counts(e.missing, FCV2_CREW_MISSING_KEYS_), counts(e.grouping, FCV2_CREW_GROUPING_KEYS_), e.fp || '', e.neighbour ? 1 : 0];
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
    missing: obj(a[5], FCV2_CREW_MISSING_KEYS_), grouping: obj(a[6], FCV2_CREW_GROUPING_KEYS_), fp: a[7] || null, neighbour: a[8] === 1 };
}

const FCV2_CREW_IS_INT_ = function (x, min) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x && x >= min; };

function fcv2CrewValidEntry_(e) {
  const isInt = FCV2_CREW_IS_INT_;
  const counts = function (x, n) { return x === 0 || (Array.isArray(x) && x.length === n && x.every(function (v) { return isInt(v, 0); })); };
  const codes = Object.keys(FCV2_CREW_STATUS_CODES_).map(function (k) { return FCV2_CREW_STATUS_CODES_[k]; });
  if (!Array.isArray(e) || e.length !== 9) return false;
  if (!isInt(e[0], 0) || !isInt(e[1], 0) || e[1] > FCV2_CREW_MAX_PARTS_ || typeof e[2] !== 'string' || !isInt(e[3], 0)) return false;
  if (codes.indexOf(e[4]) < 0 || !counts(e[5], FCV2_CREW_MISSING_KEYS_.length) || !counts(e[6], FCV2_CREW_GROUPING_KEYS_.length)) return false;
  if (typeof e[7] !== 'string' || !(e[7] === '' || /^[0-9a-f]{32}$/.test(e[7])) || (e[8] !== 0 && e[8] !== 1)) return false;
  return e[1] === 0 || (e[0] > 0 && /^[0-9a-f]{32}$/.test(e[2]));
}

/** Root validation: supported schema, required fields and types, retired and cache keys inside fcx. */
function fcv2CrewValidRoot_(m) {
  const isInt = FCV2_CREW_IS_INT_;
  const isObj = function (x) { return !!x && typeof x === 'object' && !Array.isArray(x); };
  if (!isObj(m) || m.schema !== FCV2_CREW_SCHEMA_) return false;
  if (!isInt(m.G, 1) || typeof m.epoch !== 'string' || !m.epoch || !isInt(m.mgen, 0)) return false;
  if (!isObj(m.years) || !Array.isArray(m.retired) || !Array.isArray(m.cacheKeys)) return false;
  const yearsOk = Object.keys(m.years).every(function (y) {
    const v = m.years[y];
    return /^\d{4}$/.test(y) && Array.isArray(v) && v.length === 2 && isInt(v[0], 1) && /^[0-9a-f]{32}$/.test(v[1]);
  });
  const retiredOk = m.retired.every(function (r) {
    return Array.isArray(r) && r.length === 2 && typeof r[0] === 'string'
      && (r[0].indexOf(FCV2_CREW_PREFIX_ + 's.') === 0 || r[0].indexOf(FCV2_CREW_PREFIX_ + 'y.') === 0) && isInt(r[1], 0);
  });
  const cacheOk = m.cacheKeys.every(function (k) { return typeof k === 'string' && k.indexOf(FCV2_CREW_PREFIX_) === 0; });
  return yearsOk && retiredOk && cacheOk;
}

/** Kept for callers of the Phase 1a name: validates a root. */
function fcv2CrewValidManifest_(m) { return fcv2CrewValidRoot_(m); }

function fcv2CrewYearKey_(G, epoch, year, ygen) {
  return FCV2_CREW_PREFIX_ + 'y.' + G + '.' + epoch + '.' + year + '.' + ygen;
}

function fcv2CrewEmptyManifest_(state) {
  return { schema: FCV2_CREW_SCHEMA_, G: state.G, epoch: state.epoch, mgen: 0, months: {}, years: {}, retired: [], cacheKeys: [] };
}

/**
 * The stored manifest as one flattened view {schema, G, epoch, mgen, months, years, retired, cacheKeys},
 * classified: absent | ok | obsolete (an older generation: returned as an empty manifest, never read) |
 * foreign (valid, same or newer G but another epoch) | invalid (unparsable, unsupported or
 * malformed root or year document) | torn (a referenced year document is missing or does not match its
 * digest — a reader racing a publication or GC; never expected under the lock).
 * deps.hash is needed to check year-document digests.
 */
function fcv2CrewManifest_(store, state, deps) {
  const raw = store.get(FCV2_CREW_MANIFEST_KEY_);
  if (!raw) return { kind: 'absent', manifest: fcv2CrewEmptyManifest_(state) };
  let root;
  try { root = JSON.parse(raw); } catch (err) { return { kind: 'invalid', manifest: null }; }
  if (!fcv2CrewValidRoot_(root)) return { kind: 'invalid', manifest: null };
  // An older generation's index is obsolete: never read, treated as absent and replaced/purged (§8.6).
  if (root.G < state.G) return { kind: 'obsolete', manifest: fcv2CrewEmptyManifest_(state) };
  if (root.G !== state.G || root.epoch !== state.epoch) return { kind: 'foreign', manifest: null };
  const months = {};
  const years = Object.keys(root.years);
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const ygen = root.years[y][0];
    const v = store.get(fcv2CrewYearKey_(root.G, root.epoch, y, ygen));
    const header = [root.G, root.epoch, y, ygen].join('|') + '|';
    if (typeof v !== 'string' || v.indexOf(header) !== 0) return { kind: 'torn', manifest: null };
    const body = v.slice(header.length);
    if (deps.hash(body).slice(0, 32) !== root.years[y][1]) return { kind: 'torn', manifest: null };
    let doc;
    try { doc = JSON.parse(body); } catch (err) { return { kind: 'invalid', manifest: null }; }
    if (!doc || typeof doc.m !== 'object' || Array.isArray(doc.m)) return { kind: 'invalid', manifest: null };
    const keys = Object.keys(doc.m);
    for (let k = 0; k < keys.length; k++) {
      if (!/^(0[1-9]|1[0-2])$/.test(keys[k]) || !fcv2CrewValidEntry_(doc.m[keys[k]])) return { kind: 'invalid', manifest: null };
      months[y + '-' + keys[k]] = fcv2CrewEntryIn_(doc.m[keys[k]]);
    }
  }
  return { kind: 'ok', manifest: {
    schema: root.schema, G: root.G, epoch: root.epoch, mgen: root.mgen, months: months, years: root.years,
    retired: root.retired, cacheKeys: root.cacheKeys,
  } };
}

/**
 * Publishes `next` (a flattened manifest derived from `base`): every year whose month entries changed gets
 * a new immutable year document, then one root write commits. Returns false (and removes the staged year
 * documents) if any write fails or a value would exceed 8,000 characters; `base` then stays published.
 */
function fcv2CrewPublish_(store, base, next, deps, now) {
  const yearOf = function (months, y) {
    const out = {};
    Object.keys(months).forEach(function (k) { if (k.slice(0, 4) === y) out[k.slice(5)] = fcv2CrewEntryOut_(months[k]); });
    return out;
  };
  const allYears = {};
  Object.keys(base.months).concat(Object.keys(next.months)).forEach(function (k) { allYears[k.slice(0, 4)] = true; });
  const years = JSON.parse(JSON.stringify(base.years || {}));
  const retired = next.retired.slice();
  const staged = [];
  const unstage = function () { staged.forEach(function (k) { try { store.del(k); } catch (e) { /* orphan, removed by GC */ } }); };
  const ys = Object.keys(allYears).sort();
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    const before = JSON.stringify(yearOf(base.months, y));
    const after = JSON.stringify(yearOf(next.months, y));
    if (before === after && years[y]) continue;
    const ygen = years[y] ? years[y][0] + 1 : 1;
    const body = JSON.stringify({ m: yearOf(next.months, y) });
    const value = [next.G, next.epoch, y, ygen].join('|') + '|' + body;
    if (value.length > FCV2_CREW_MANIFEST_MAX_) { unstage(); return false; }
    const key = fcv2CrewYearKey_(next.G, next.epoch, y, ygen);
    try { store.set(key, value); staged.push(key); } catch (err) { unstage(); return false; }
    if (years[y]) retired.push([fcv2CrewYearKey_(next.G, next.epoch, y, years[y][0]), now]);
    years[y] = [ygen, deps.hash(body).slice(0, 32)];
  }
  const root = JSON.stringify({ schema: FCV2_CREW_SCHEMA_, G: next.G, epoch: next.epoch, mgen: next.mgen, years: years, retired: retired, cacheKeys: next.cacheKeys });
  if (root.length > FCV2_CREW_MANIFEST_MAX_) { unstage(); return false; }
  try { store.set(FCV2_CREW_MANIFEST_KEY_, root); } catch (err) { unstage(); return false; }
  next.years = years;
  next.retired = retired;
  return true;
}

/** Old parts of a month deleted when the stale marker cannot be written (§7.2a). */
function fcv2CrewFailClosed_(store, state, month, prev) {
  let ok = true;
  for (let i = 0; i < prev.parts; i++) {
    try { store.del(fcv2CrewPartKey_(state.G, state.epoch, month, prev.gen, i)); } catch (err) { ok = false; }
  }
  return { outcome: ok ? 'replaceFailed' : 'replaceFailed-unpersisted', closedBy: ok ? 'parts-deleted' : null };
}

function fcv2CrewAdjacentMonths_(month) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const prev = m === 1 ? (y - 1) + '-12' : y + '-' + (m - 1 < 10 ? '0' : '') + (m - 1);
  return [prev, fcv2CrewNextMonth_(month)];
}

/**
 * Crash-safe commit of one month (§7.2, §7.2a). Must run under the script lock.
 * captured: { G, epoch, mgen } read before the month was built (outside the lock).
 * entry: { body, digest, verifiedAt, missing, grouping, fp }.
 * env: { getState(), store, now, deps: { hash } }.
 * A replacement first persists status "replacing" (stale for readers); if even that cannot be written,
 * the old parts are deleted (fail closed). A replacement that changes the content flags both adjacent
 * months (their read windows overlap) so they are stale until re-verified.
 * Outcomes: committed | aborted-generation | aborted-conflict | index-incompatible | uncovered |
 * replaceFailed | replaceFailed-unpersisted.
 */
function fcv2CrewCommitMonth_(env, captured, month, entry) {
  const state = env.getState();
  if (state.phase !== 'active' || state.G !== captured.G || state.epoch !== captured.epoch) return { outcome: 'aborted-generation' };
  const store = env.store;
  const deps = env.deps;
  const read = fcv2CrewManifest_(store, state, deps);
  if (read.kind === 'invalid' || read.kind === 'torn') return { outcome: 'index-incompatible' };
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
    if (!fcv2CrewPublish_(store, manifest, marked, deps, env.now)) return fcv2CrewFailClosed_(store, state, month, prev);
    base = marked;
  }
  const gen = prev ? prev.gen + 1 : 1;
  const parts = fcv2CrewParts_(state.G, state.epoch, month, gen, entry.body);
  const partsBytes = parts.reduce(function (n, p) { return n + fcv2CrewUtf8_(p.key) + fcv2CrewUtf8_(p.value); }, 0);
  const manifestBytes = fcv2CrewUtf8_(FCV2_CREW_MANIFEST_KEY_) + fcv2CrewUtf8_(store.get(FCV2_CREW_MANIFEST_KEY_) || '');
  // One year document is rewritten per commit: reserve a full value for it next to the root reserve.
  const peak = fcv2CrewPeak_(fcv2CrewStoreBytes_(store), manifestBytes, partsBytes + FCV2_CREW_MANIFEST_MAX_);
  if (env.diagnostics) env.diagnostics.admission(peak, entry.body.length, parts.length);
  const fail = function () {
    const next = clone(base);
    next.mgen++;
    if (replacing) next.months[month] = Object.assign({}, prev, { status: 'replaceFailed' });
    else next.months[month] = { gen: 0, parts: 0, digest: null, verifiedAt: null, status: 'uncovered', missing: null, grouping: null, fp: null, neighbour: false };
    // If this publication fails too, a replacement stays "replacing" (stale) and a new month stays absent (pending).
    fcv2CrewPublish_(store, base, next, deps, env.now);
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
  next.months[month] = {
    gen: gen, parts: parts.length, digest: entry.digest, verifiedAt: entry.verifiedAt, status: 'ok',
    missing: entry.missing, grouping: entry.grouping, fp: entry.fp || null, neighbour: false,
  };
  if (replacing) {
    for (let i = 0; i < prev.parts; i++) next.retired.push([fcv2CrewPartKey_(state.G, state.epoch, month, prev.gen, i), env.now]);
    if (prev.digest !== entry.digest) {
      fcv2CrewAdjacentMonths_(month).forEach(function (adj) {
        if (next.months[adj] && next.months[adj].gen > 0) next.months[adj].neighbour = true;
      });
    }
  }
  if (!fcv2CrewPublish_(store, base, next, deps, env.now)) { unstage(); return fail(); }
  return { outcome: 'committed', gen: gen, peak: peak, mgen: next.mgen, neighboursFlagged: replacing && prev.digest !== entry.digest };
}

/** Re-verification without a content change: fresh verifiedAt, neighbour flag cleared. Under the lock. */
function fcv2CrewTouchMonth_(env, captured, month, verifiedAt) {
  const state = env.getState();
  if (state.phase !== 'active' || state.G !== captured.G || state.epoch !== captured.epoch) return { outcome: 'aborted-generation' };
  const read = fcv2CrewManifest_(env.store, state, env.deps);
  if (read.kind !== 'ok') return { outcome: read.kind === 'foreign' ? 'aborted-generation' : 'index-incompatible' };
  const manifest = read.manifest;
  if (manifest.mgen !== captured.mgen) return { outcome: 'aborted-conflict' };
  const next = JSON.parse(JSON.stringify(manifest));
  next.mgen++;
  next.months[month] = Object.assign({}, next.months[month], { verifiedAt: verifiedAt, neighbour: false });
  return fcv2CrewPublish_(env.store, manifest, next, env.deps, env.now) ? { outcome: 'verified', mgen: next.mgen } : { outcome: 'touch-failed' };
}

/** Garbage collection (§7.6). Must run under the script lock. Only fcx.s.* / fcx.y.* keys are deleted. */
function fcv2CrewGc_(env) {
  const state = env.getState();
  const store = env.store;
  const read = fcv2CrewManifest_(store, state, env.deps);
  if (read.kind !== 'ok' && read.kind !== 'obsolete' && read.kind !== 'absent') return { deleted: 0, skipped: read.kind };
  const manifest = read.manifest;
  const referenced = {};
  referenced[FCV2_CREW_MANIFEST_KEY_] = true;
  Object.keys(manifest.years).forEach(function (y) { referenced[fcv2CrewYearKey_(manifest.G, manifest.epoch, y, manifest.years[y][0])] = true; });
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
    const ours = k.indexOf(FCV2_CREW_PREFIX_ + 's.') === 0 || k.indexOf(FCV2_CREW_PREFIX_ + 'y.') === 0;
    if (!ours || referenced[k] || retiredKeys[k]) return;
    try { store.del(k); deleted++; } catch (err) { /* next GC */ }
  });
  if (read.kind === 'ok' && keep.length !== manifest.retired.length) {
    const next = JSON.parse(JSON.stringify(manifest));
    next.retired = keep;
    next.mgen++;
    fcv2CrewPublish_(store, manifest, next, env.deps, env.now);         // root only; failure keeps the old list (harmless)
  }
  return { deleted: deleted };
}

/**
 * Integrity of one committed month shard (§7.5d): 'absent' (no committed generation), 'valid', 'missing'
 * (a part is gone) or 'corrupt' (header, digest or structure wrong). Store reads only — no Calendar access.
 */
function fcv2CrewMonthIntegrity_(store, manifest, month, deps) {
  const e = manifest.months[month];
  if (!e || !e.gen || !e.parts) return 'absent';
  let body = '';
  for (let p = 0; p < e.parts; p++) {
    const v = store.get(fcv2CrewPartKey_(manifest.G, manifest.epoch, month, e.gen, p));
    if (typeof v !== 'string') return 'missing';
    const header = fcv2CrewPartHeader_(manifest.G, manifest.epoch, month, e.gen, p, e.parts);
    if (v.indexOf(header) !== 0) return 'corrupt';
    body += v.slice(header.length);
  }
  if (deps.hash(body).slice(0, 32) !== e.digest) return 'corrupt';
  try { fcv2CrewDecodeMonth_(body, deps, month); return 'valid'; } catch (err) { return 'corrupt'; }
}


/**
 * The single indexing-eligibility decision (§7.5, §7.5d), shared by crewIndex (what to do next) and the crew
 * response hint (whether indexing could make progress). Store reads only — never a Calendar read or a write.
 * o: { now, done?: {month: true}, verifyBefore?, retryUncovered? }.
 * Returns { blocked: null | 'invalid' | 'torn' | 'foreign', months: [ordered candidates], reasons: {month: why} }.
 * Eligibility means "worth attempting", not "will succeed": a later Calendar read or admission can still fail.
 */
function fcv2CrewIndexPlan_(store, state, deps, sealable, o) {
  const read = fcv2CrewManifest_(store, state, deps);
  if (read.kind === 'invalid' || read.kind === 'torn' || read.kind === 'foreign') return { blocked: read.kind, months: [], reasons: {} };
  const m = read.manifest;
  const done = o.done || {};
  const reasons = {};
  const months = [];
  const add = function (x, why) { if (!(x in reasons) && !done[x]) { reasons[x] = why; months.push(x); } };
  const free = FCV2_CREW_STORE_LIMIT_ - fcv2CrewStoreBytes_(store) - 2 * FCV2_CREW_MANIFEST_MAX_ - FCV2_CREW_SAFETY_;
  const roomy = o.retryUncovered === true || free >= FCV2_CREW_PART_MAX_;     // capacity gate for new data (Q25)
  const floor = sealable.filter(function (x) { return m.months[x] && m.months[x].status === 'uncovered'; }).pop() || '';
  // 1) flagged months: verification may only touch them; a failed replacement needs room again.
  sealable.forEach(function (x) {
    const e = m.months[x];
    if (!e) return;
    if (e.neighbour || e.status === 'replacing') add(x, 'flagged');
    else if (e.status === 'replaceFailed' && roomy) add(x, 'flagged');
  });
  // 2) damaged committed shards (missing or corrupt parts): repaired now, never only after the threshold.
  sealable.forEach(function (x) {
    const e = m.months[x];
    if (e && e.status === 'ok' && e.gen > 0 && fcv2CrewMonthIntegrity_(store, m, x, deps) !== 'valid') add(x, 'damaged');
  });
  // 3) unindexed months above the storage floor, newest first.
  sealable.filter(function (x) { return !m.months[x] && x > floor; }).reverse().forEach(function (x) { add(x, 'missing'); });
  // 4) the floor month itself, only when capacity allows (coverage grows downward without gaps).
  if (floor && roomy) add(floor, 'floor');
  // 5) overdue verification (threshold), or an owner-started re-check (verifyBefore), oldest first.
  const cutoff = typeof o.verifyBefore === 'number' && o.verifyBefore <= o.now ? o.verifyBefore : o.now - FCV2_CREW_FRESH_MS_;
  sealable.filter(function (x) { const e = m.months[x]; return e && e.status === 'ok' && e.verifiedAt < cutoff; })
    .sort(function (a, b) { return m.months[a].verifiedAt - m.months[b].verifiedAt; })
    .forEach(function (x) { add(x, 'aged'); });
  return { blocked: null, months: months, reasons: reasons, floor: floor };
}

/**
 * Whole-query snapshot (§7.6): one root and its year documents for every month, every part validated
 * against it; any failure (torn manifest, missing part, digest mismatch) restarts the whole query; after
 * the attempts are exhausted nothing authoritative is returned.
 * env: { getState(), store, now, deps: { hash, unpack }, hook?(attempt) }.
 * A month verified more than 14 days ago, marked "replacing" or neighbour-flagged is reported stale.
 */
function fcv2CrewReadSnapshot_(env, months) {
  for (let attempt = 1; attempt <= FCV2_CREW_SNAPSHOT_ATTEMPTS_; attempt++) {
    const state = env.getState();
    if (state.phase !== 'active') return { ok: false, reason: 'revoked' };
    const read = fcv2CrewManifest_(env.store, state, env.deps);
    if (read.kind === 'invalid' || read.kind === 'foreign') return { ok: false, reason: 'index-incompatible' };
    if (read.kind === 'torn') continue;
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
      const shown = e.status === 'ok' ? (aged || e.neighbour ? 'stale' : 'fresh') : e.status === 'replacing' ? 'stale' : e.status;
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
      try {
        data[m] = fcv2CrewDecodeMonth_(body, env.deps, m);              // strict encoded-payload validation (§7.5d)
      } catch (err) { valid = false; }
    }
    if (valid) return { ok: true, mgen: manifest.mgen, months: data, status: status, attempts: attempt };
  }
  return { ok: false, reason: 'snapshot-unavailable' };
}
