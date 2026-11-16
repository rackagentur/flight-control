// Crew grant record (Crew Intelligence Phase 1c, Stage A). The device's crew grants live next to the
// roster access token, in one store key (`crew.v1`, persisted as fc.v2.crew.v1):
//   { v: 1, phase: 'none'|'active'|'revoking', grants: [entry, ...], revokeStartedAt? }
//   entry = { grant, ep, bind, at, role: 'active'|'candidate', G, unknown, inflight, revokeId?, resolved? }
// grant = 32 random bytes (base64url, no padding); ep = fingerprint of the endpoint the grant belongs to;
// bind = fingerprint of the roster access (endpoint + token); at = time of the latest enrollment send attempt;
// G = backend generation of the confirmed active grant (null for candidates); unknown = an enrollment attempt
// with this grant had no known outcome (lost response, timeout, app closed), so the backend MAY hold it;
// inflight = an enrollment request with this grant was being sent (persisted before sending; a flag left behind
// by a closed app keeps the grant potentially live); revokeId (16 random bytes) and resolved ('deleted'|'dead')
// exist only while revoking. role 'active' = the backend CONFIRMED this grant (while revoking, more than one
// entry may carry it). One grant <-> one code: a grant is only ever re-sent with the code it was first sent with
// (decided by the caller in memory, never persisted); a different code or a restart gets a new candidate.
//
// Backend facts relied on (CrewCoreV2.gs): at most ONE grant is live; a successful enrollment replaces the
// previous one; a revocation of the live grant deletes everything. A candidate whose outcome is unknown is
// therefore potentially live and is never silently discarded: it is revoked like the active grant.
//
// The record never holds names, sector ids, enrollment codes or crew responses. Nothing here logs, and there
// is no export helper for grants. A record of another version, or a v1 record that looks like deletion state
// but is malformed, is `foreign`: never trusted, sent, overwritten or deleted (only reset removes it). A record
// that cannot be READ (storage blocked, read throws, no storage backend) is `unreadable`: never treated as
// absent, never removed or overwritten; every method refuses without writing.

const KEY = 'crew.v1';
const MAX_CANDIDATES = 3;
const GRANT = /^[A-Za-z0-9_-]{43}$/;
const REVOKE_ID = /^[A-Za-z0-9_-]{22}$/;
const FP = /^[0-9a-f]{16}$/;
const PHASES = new Set(['none', 'active', 'revoking']);
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Store key of the crew grant record (without the fc.v2. prefix). */
export const CREW_CREDENTIAL_KEY = KEY;
/** Candidate grants kept at most beside the active one; further enrollments are refused locally. */
export const CREW_MAX_CANDIDATES = MAX_CANDIDATES;

function fnv1a(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Deterministic 16-hex fingerprint of a roster access (two FNV-1a 32-bit passes with different seeds).
 * A binding check only, NOT secrecy: the token itself sits in the same storage.
 * @param {string|null} endpoint
 * @param {string|null} token
 * @returns {string}
 */
export function accessFingerprint(endpoint, token) {
  const text = `${endpoint ?? ''}\n${token ?? ''}`;
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x5bd1e995);
}

/**
 * Deterministic 16-hex fingerprint of the endpoint alone: a pending revocation is sent only to the backend
 * the grant was enrolled with (the roster token may change; the backend checks the current token).
 * @param {string|null} endpoint
 * @returns {string}
 */
export function endpointFingerprint(endpoint) {
  const text = `endpoint\n${endpoint ?? ''}`;
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x5bd1e995);
}

/**
 * Short fingerprint of a grant (for run identities in memory; never stored, never sent).
 * @param {string} grant
 * @returns {string}
 */
export function grantFingerprint(grant) {
  const text = `grant\n${grant ?? ''}`;
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x5bd1e995);
}

function base64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

function defaultRandom(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o, required, optional = []) => {
  const own = Object.keys(o);
  return required.every((k) => own.includes(k)) && own.every((k) => required.includes(k) || optional.includes(k));
};
const ENTRY_KEYS = ['grant', 'ep', 'bind', 'at', 'role', 'G', 'unknown', 'inflight'];

function validEntry(e, revoking) {
  if (!isObject(e) || !exactKeys(e, revoking ? [...ENTRY_KEYS, 'revokeId'] : ENTRY_KEYS, revoking ? ['resolved'] : [])) return false;
  if (typeof e.grant !== 'string' || !GRANT.test(e.grant)) return false;
  if (typeof e.ep !== 'string' || !FP.test(e.ep) || typeof e.bind !== 'string' || !FP.test(e.bind) || !isTime(e.at)) return false;
  if (e.role === 'active') { if (!(Number.isInteger(e.G) && e.G >= 1)) return false; } else if (e.role !== 'candidate' || e.G !== null) return false;
  if (typeof e.unknown !== 'boolean' || typeof e.inflight !== 'boolean') return false;
  if (revoking && (typeof e.revokeId !== 'string' || !REVOKE_ID.test(e.revokeId))) return false;
  if ('resolved' in e && e.resolved !== 'dead' && e.resolved !== 'deleted') return false;
  return true;
}

function validRecord(r) {
  if (!isObject(r) || !exactKeys(r, ['v', 'phase', 'grants'], r.phase === 'revoking' ? ['revokeStartedAt'] : [])) return false;
  if (r.v !== 1 || !PHASES.has(r.phase) || !Array.isArray(r.grants) || r.grants.length < 1 || r.grants.length > MAX_CANDIDATES + 1) return false;
  const revoking = r.phase === 'revoking';
  if (!r.grants.every((e) => validEntry(e, revoking))) return false;
  if (new Set(r.grants.map((e) => e.grant)).size !== r.grants.length) return false;
  if (revoking && new Set(r.grants.map((e) => e.revokeId)).size !== r.grants.length) return false;
  const actives = r.grants.filter((e) => e.role === 'active').length;
  if (!revoking && (actives > 1 || (r.phase === 'active') !== (actives === 1))) return false;
  if ('revokeStartedAt' in r && !isTime(r.revokeStartedAt)) return false;
  return true;
}

/** A v1-looking value that may carry deletion state (kept as foreign when malformed). */
const revokingLike = (r) => isObject(r) && (r.phase === 'revoking' || r.state === 'revoking' || Array.isArray(r.grants));

/** Potentially live on the backend: confirmed active, or an enrollment attempt with unknown outcome. */
const potentiallyLive = (e) => e.role === 'active' || e.unknown || e.inflight;
/** Potentially live and not yet resolved by backend evidence: such an entry must never silently disappear. */
const live = (e) => !e.resolved && potentiallyLive(e);

/**
 * Name of the one origin-wide Web Lock that serializes every mutation of the crew record across tabs.
 * Web Locks are not re-entrant: callbacks run plain synchronous transitions only (no nested requests).
 */
export const CREW_CREDENTIAL_LOCK = 'fc.v2.crew.v1.lock';

/**
 * Credential record access. Reads (status, state, read, activeGrant, pendingRevoke) are synchronous and NEVER
 * write. Every mutation is async and runs entirely inside the exclusive Web Lock: it re-reads the stored record
 * (checked read) inside the lock, computes its transition from THAT read, applies the monotonic guard, writes and
 * verifies by a checked read-back, then releases. Without a usable lock (`locks` missing, request throws or
 * rejects) every mutation refuses with 'lock-unavailable' and writes nothing — never an uncoordinated write.
 * Exception: dropAccess/reconcile with no record present (checked read: none) succeed without the lock (nothing
 * to coordinate; without locks no tab can create a record, because enrollment refuses).
 *
 * Mutations resolve to the legacy result types; `detailed.<method>` resolves to {ok, value, error} with error in
 * 'lock-unavailable' | 'storage-unreadable' | 'storage' | 'credential-unsupported' | 'revoke-pending' |
 * 'candidate-limit' | 'not-found' | 'invalid'.
 * @param {{store: ReturnType<import('../store.js').createStore>, random?: (bytes:number)=>Uint8Array, now?: ()=>number,
 *   locks?: {request: Function}|null}} deps
 */
export function createCrewCredentials({ store, random = defaultRandom, now = Date.now, locks = globalThis.navigator?.locks ?? null }) {
  const bindOf = (access) => accessFingerprint(access?.endpoint ?? null, access?.token ?? null);
  const epOf = (access) => endpointFingerprint(access?.endpoint ?? null);
  const fresh = (length) => {
    const bytes = random(length);
    if (!bytes || bytes.length !== length) throw new Error('random source unavailable');
    return base64url(bytes);
  };
  const phaseOf = (grants) => (grants.some((e) => e.role === 'active') ? 'active' : 'none');
  const readChecked = () => (typeof store.getChecked === 'function' ? store.getChecked(KEY) : { ok: false });

  /**
   * One checked read: {kind: 'none'|'ok'|'foreign'|'unreadable', record, malformed}. Never writes: a malformed
   * (non-deletion) record reads as `none` with malformed:true and is replaced or removed only by a locked mutation.
   */
  function inspect() {
    const got = readChecked();
    if (!got.ok) return { kind: 'unreadable', record: null, malformed: false };
    const raw = got.value;
    if (raw === null) return { kind: 'none', record: null, malformed: false };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { kind: 'none', record: null, malformed: true }; }
    if (parsed !== null && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'v') && parsed.v !== 1) return { kind: 'foreign', record: null, malformed: false };
    if (validRecord(parsed)) return { kind: 'ok', record: { ...parsed, grants: parsed.grants.map((e) => ({ ...e })) }, malformed: false };
    if (revokingLike(parsed)) return { kind: 'foreign', record: null, malformed: false };
    return { kind: 'none', record: null, malformed: true };
  }
  const read = () => inspect().record;

  // --- inside the lock only ----------------------------------------------------------------------------

  /**
   * Monotonic guard + verified write, against `stored` = the read taken inside the lock. Refuses (false, nothing
   * written) when an entry live in `stored` would disappear or stop being potentially live, unless
   * `allowed(storedEntry)` names an evidence-backed transition. `next` null removes.
   */
  function commit(stored, next, allowed = () => false) {
    if (stored.kind === 'foreign' || stored.kind === 'unreadable') return false;
    for (const e of stored.record?.grants ?? []) {
      if (!live(e) || allowed(e)) continue;
      const kept = next?.grants.find((x) => x.grant === e.grant);
      if (!kept || !live(kept)) return false;
    }
    const done = next ? store.setJSON(KEY, next) === true : store.remove(KEY) === true;
    if (!done) return false;
    const back = readChecked();   // a read-back that cannot be READ counts as a failed write
    return back.ok && back.value === (next ? JSON.stringify(next) : null);
  }
  const recordOf = (grants) => (grants.length ? { v: 1, phase: phaseOf(grants), grants } : null);
  const ok = (value) => ({ ok: true, value, error: null });
  const fail = (error, value = null) => ({ ok: false, value, error });
  const writeFailure = () => fail(readChecked().ok ? 'storage' : 'storage-unreadable');

  /** Runs a synchronous transition inside the exclusive lock; {ok:false, error:'lock-unavailable'} without one. */
  async function locked(transition) {
    if (!locks || typeof locks.request !== 'function') return fail('lock-unavailable');
    try {
      return await locks.request(CREW_CREDENTIAL_LOCK, { mode: 'exclusive' }, () => {
        try { return transition(inspect()); } catch { return fail('storage'); }
      });
    } catch {
      return fail('lock-unavailable');
    }
  }

  /** Access lost: a plain confirmed grant is removed (owner rule); anything potentially live becomes a deletion. */
  function loseAccessT(stored) {
    const r = stored.record;
    if (r.grants.some((e) => e.role === 'candidate' && potentiallyLive(e))) return toRevokingT(stored);
    return commit(stored, null, (e) => e.role === 'active') ? ok(null) : writeFailure();
  }

  function toRevokingT(stored) {
    const r = stored.record;
    if (r.phase === 'revoking') return ok(r);
    let grants;
    try { grants = r.grants.map((e) => ({ ...e, revokeId: fresh(16) })); } catch { return fail('storage'); }
    const next = { v: 1, phase: 'revoking', grants, revokeStartedAt: now() };
    return commit(stored, next) ? ok(next) : writeFailure();
  }

  function settleT(stored, grant, outcome, G) {
    if (stored.kind === 'unreadable') return fail('storage-unreadable');
    const r = stored.record;
    const entry = r?.grants.find((e) => e.grant === grant && e.role === 'candidate');
    if (!entry) return fail('not-found');
    if (outcome === 'ok' && !(Number.isInteger(G) && G >= 1)) return fail('invalid');
    const replaced = (patch) => r.grants.map((e) => (e === entry ? { ...e, ...patch } : e));
    // A refusal may remove the entry only if, in the stored record, it never had an unknown attempt.
    const refusable = (e) => e.grant === grant && !e.unknown;
    const put = (next, allowed) => (commit(stored, next, allowed) ? ok(true) : writeFailure());
    if (r.phase === 'revoking') {
      if (outcome === 'ok') return put({ ...r, grants: replaced({ role: 'active', G, unknown: false, inflight: false }) });
      if (outcome === 'unknown') return put({ ...r, grants: replaced({ inflight: false, unknown: true }) });
      if (entry.unknown) return put({ ...r, grants: replaced({ inflight: false }) });
      const rest = r.grants.filter((e) => e !== entry);
      return put(rest.length ? { ...r, grants: rest } : null, refusable);
    }
    if (outcome === 'ok') {
      // Backend G is monotonic (CrewCoreV2.gs: every enrollment and revocation increments it). A stored confirmed
      // grant of the same endpoint with a G not lower than G_x was activated after X: X is the replaced one
      // (its single code was consumed). Only lower-G confirmed grants are dropped.
      const newer = r.grants.some((e) => e.role === 'active' && e.ep === entry.ep && e.G >= G);
      if (newer) return put(recordOf(r.grants.filter((e) => e !== entry)), (e) => e.grant === grant);
      const grants = r.grants.filter((e) => !(e.role === 'active' && e.ep === entry.ep))
        .map((e) => (e === entry ? { ...e, role: 'active', G, unknown: false, inflight: false } : e));
      return put(recordOf(grants), (e) => e.role === 'active' && e.ep === entry.ep && e.G < G);
    }
    if (outcome === 'unknown') return put(recordOf(replaced({ inflight: false, unknown: true })));
    if (entry.unknown) return put(recordOf(replaced({ inflight: false })));
    return put(recordOf(r.grants.filter((e) => e !== entry)), refusable);
  }

  // --- detailed mutations ------------------------------------------------------------------------------

  const detailed = {
    /**
     * Picks the grant for an enrollment attempt and persists it as `inflight` BEFORE any request is sent.
     * `reuse` = the caller's in-memory same-code decision (one grant <-> one code); a reused entry folds an
     * earlier unsettled attempt (inflight) into unknown in the same write. The active grant is never touched.
     */
    beginEnroll(access, { reuse = null } = {}) {
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        if (stored.kind === 'foreign') return fail('credential-unsupported');
        if (stored.record?.phase === 'revoking') return fail('revoke-pending');
        const bind = bindOf(access);
        const ep = epOf(access);
        let current = stored;
        let grants = stored.record ? stored.record.grants : [];
        if (grants.some((e) => e.bind !== bind)) {
          const lost = loseAccessT(stored);   // bound to another access: handled as an access change first
          if (!lost.ok) return lost;
          current = inspect();
          if (current.record?.phase === 'revoking') return fail('revoke-pending');
          grants = current.record ? current.record.grants : [];
        }
        const t = now();
        let entry = reuse ? grants.find((e) => e.grant === reuse && e.role === 'candidate' && e.ep === ep && e.bind === bind) : undefined;
        if (!entry) {
          if (grants.filter((e) => e.role === 'candidate').length >= MAX_CANDIDATES) return fail('candidate-limit');
          let grant;
          try { grant = fresh(32); } catch { return fail('storage'); }
          entry = { grant, ep, bind, at: t, role: 'candidate', G: null, unknown: false, inflight: false };
          grants = [...grants, entry];
        }
        const updated = grants.map((e) => (e.grant === entry.grant ? { ...e, at: t, inflight: true, unknown: e.unknown || e.inflight } : e));
        return commit(current, recordOf(updated)) ? ok({ grant: entry.grant }) : writeFailure();
      });
    },

    /** Outcome of an enrollment attempt ('ok' | 'unknown' | 'refused'), see settleT. */
    settleEnroll(grant, outcome, G = null) {
      return locked((stored) => settleT(stored, grant, outcome, G));
    },

    /** Test/compat helper: confirms the newest candidate of this access (or `grant`) as active with generation G. */
    confirmEnroll(access, G, grant) {
      return locked((stored) => {
        const bind = bindOf(access);
        const entry = stored.record?.grants.filter((e) => e.role === 'candidate' && e.bind === bind && (grant === undefined || e.grant === grant))
          .sort((a, b) => b.at - a.at)[0];
        return entry ? settleT(stored, entry.grant, 'ok', G) : fail('not-found');
      });
    },

    /** Starts (or continues) a deletion; value = the revoking record as persisted. */
    beginRevoke() {
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        if (stored.kind !== 'ok') return fail(stored.kind === 'foreign' ? 'credential-unsupported' : 'not-found');
        return toRevokingT(stored);
      });
    },

    /** Marks one entry of a pending deletion 'deleted' (backend confirmed) or 'dead' (proven not live). */
    resolveEntry(grant, resolved) {
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        const r = stored.record;
        if (r?.phase !== 'revoking' || (resolved !== 'deleted' && resolved !== 'dead')) return fail('invalid');
        if (!r.grants.some((e) => e.grant === grant)) return fail('not-found');
        return commit(stored, { ...r, grants: r.grants.map((e) => (e.grant === grant ? { ...e, resolved } : e)) }, (e) => e.grant === grant)
          ? ok(true) : writeFailure();
      });
    },

    /**
     * Removes the deletion record when every entry (re-read under the lock) is resolved: value 'deleted' (at least
     * one backend confirmation), 'superseded' (all proven dead) or null (still pending — e.g. an entry added).
     */
    completeRevoke() {
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        const r = stored.record;
        if (r?.phase !== 'revoking' || !r.grants.every((e) => e.resolved)) return ok(null);
        const status = r.grants.some((e) => e.resolved === 'deleted') ? 'deleted' : 'superseded';
        return commit(stored, null) ? ok(status) : writeFailure();
      });
    },

    /** Recovery: every `inflight` folded into `unknown: true` (everything else kept), one verified write. */
    async foldInflight() {
      const peek = inspect();
      if (peek.kind === 'unreadable') return fail('storage-unreadable');
      if (peek.kind === 'foreign' || (peek.kind === 'none' && !peek.malformed)) return ok(true);   // nothing of ours
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        if (stored.kind !== 'ok') return ok(true);
        const r = stored.record;
        return commit(stored, { ...r, grants: r.grants.map((e) => (e.inflight ? { ...e, inflight: false, unknown: true } : e)) })
          ? ok(true) : writeFailure();
      });
    },

    /**
     * Sign-out: a plain confirmed grant is removed (owner rule, §7.5b); an unresolved candidate is never discarded
     * (the record becomes a pending deletion). Revoking and foreign records are kept; a malformed one is removed.
     */
    async dropAccess() {
      const peek = inspect();
      if (peek.kind === 'unreadable') return fail('storage-unreadable');
      if (peek.kind === 'none' && !peek.malformed) return ok(true);   // nothing to coordinate (no lock needed)
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        if (stored.kind === 'foreign' || stored.record?.phase === 'revoking') return ok(true);
        if (stored.kind === 'none') return stored.malformed ? (commit(stored, null) ? ok(true) : writeFailure()) : ok(true);
        return loseAccessT(stored).ok ? ok(true) : writeFailure();
      });
    },

    /** Access changed: like dropAccess for grants bound to another access; matching grants are kept. */
    async reconcile(access) {
      const peek = inspect();
      if (peek.kind === 'unreadable') return fail('storage-unreadable');
      if (peek.kind === 'none' && !peek.malformed) return ok(true);
      return locked((stored) => {
        if (stored.kind === 'unreadable') return fail('storage-unreadable');
        if (stored.kind === 'foreign' || stored.record?.phase === 'revoking') return ok(true);
        if (stored.kind === 'none') return stored.malformed ? (commit(stored, null) ? ok(true) : writeFailure()) : ok(true);
        const bind = bindOf(access);
        const r = stored.record;
        if (r.grants.every((e) => e.bind === bind)) return ok(true);
        return loseAccessT(stored).ok ? ok(true) : writeFailure();
      });
    },
  };

  const legacy = (fn, map) => async (...args) => map(await fn(...args));
  const bool = (r) => r.ok && r.value !== false;
  return {
    detailed,

    /** 'none' | 'ok' | 'foreign' (a record this version must not touch) | 'unreadable' (storage cannot be read). */
    status: () => inspect().kind,

    /** One checked read: {kind, record, malformed} (record null unless kind is 'ok'). Never writes. */
    state: inspect,

    /** The validated record (a copy), or null (none, malformed, foreign or unreadable). Never writes. */
    read,

    /** The confirmed active grant bound to this access; never a candidate, never while revoking. Never writes. */
    activeGrant(access) {
      const r = read();
      if (!r || r.phase !== 'active') return null;
      const active = r.grants.find((e) => e.role === 'active');
      return active.bind === bindOf(access) ? active.grant : null;
    },

    /** Summary of a pending deletion: unresolved entries and their endpoint fingerprints, or null. Never writes. */
    pendingRevoke() {
      const r = read();
      if (r?.phase !== 'revoking') return null;
      const open = r.grants.filter((e) => !e.resolved);
      return { unresolved: open.length, endpoints: [...new Set(open.map((e) => e.ep))] };
    },

    /** @returns {Promise<{grant:string}|{error:string}>} */
    beginEnroll: legacy(detailed.beginEnroll, (r) => (r.ok ? r.value : { error: r.error })),
    /** @returns {Promise<boolean>} */
    settleEnroll: legacy(detailed.settleEnroll, bool),
    /** @returns {Promise<boolean>} */
    confirmEnroll: legacy(detailed.confirmEnroll, bool),
    /** @returns {Promise<object|null>} the revoking record, or null */
    beginRevoke: legacy(detailed.beginRevoke, (r) => (r.ok ? r.value : null)),
    /** @returns {Promise<boolean>} */
    resolveEntry: legacy(detailed.resolveEntry, bool),
    /** @returns {Promise<'deleted'|'superseded'|null>} */
    completeRevoke: legacy(detailed.completeRevoke, (r) => (r.ok ? r.value : null)),
    /** @returns {Promise<boolean>} */
    foldInflight: legacy(detailed.foldInflight, bool),
    /** @returns {Promise<boolean>} */
    dropAccess: legacy(detailed.dropAccess, bool),
    /** @returns {Promise<boolean>} */
    reconcile: legacy(detailed.reconcile, bool),
  };
}

/** Controller helper: sign-out / token removal (keeps a pending deletion and potentially live candidates). */
export function dropCrewAccess(store) {
  return createCrewCredentials({ store }).dropAccess();
}

/** Controller helper: the roster access changed; a grant bound to another access is removed or kept for deletion. */
export function reconcileCrewAccess(store, access) {
  return createCrewCredentials({ store }).reconcile(access);
}
