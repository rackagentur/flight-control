// ============================================================================
// FLIGHT CONTROL — ISOLATED APPS SCRIPT TEST PACKAGE: CALENDAR SEEDER (test-only)
// ============================================================================
// NEVER add this file to the production Apps Script project. It lives only in the throwaway "FC-TEST Seeder"
// project, whose manifest grants ONE scope (calendar, read/write). The API test project cannot write any
// calendar at platform level; this project holds the write scope and is deleted after use.
//
// It never creates calendars (the owner creates the two calendars by hand in Google Calendar). It only
// creates, updates and deletes EVENTS inside the two calendars that pass the guard (fctCalendar_).
//
// OWNERSHIP (what lets the seeder touch an event). Fixture content is public, so content never proves ownership.
// The seeder keeps an installation secret in Script Property FCT_SEED_INSTALL (32 lowercase hex, generated on the
// first seeding run from Utilities.getUuid, never logged, never set by hand, never deleted by removal). The proof
// for one fixture event is sha256('fct-own|' + install + '|' + role + '|' + key) cut to 32 hex. Every event the
// seeder creates carries, as the FIRST LINE of its description, 'fct-own:<role>:<key>:<proof>', followed by a blank
// line and the fixture description. The description is part of the createEvent payload; tags are NOT (they need
// separate setTag calls afterwards). Whether CalendarApp writes the description atomically with the event is a
// reasonable but UNVERIFIED platform assumption. Ownership is proven ONLY by that first line recomputing against
// the install id. Tags are never ownership proof. No install id means nothing is owned.
//
// REQUIRED TAGS of a fully seeded event: fct-seed = '1', fct-key = <key>, fct-own = <proof>, and for the synced
// role also SYNC_PROPERTY_KEY = <fixture sourceId> (the tag the production reader needs). An event counts as
// seeded only when all of them are exactly right; an owned event with missing or wrong tags is repaired.
//
// CONFLICTS. For a fixture key with no owned event, any other event that has the key as its fct-key tag, carries
// the expected fct-own value or has the same title, start and end as the fixture event is a look-alike: the
// seeder touches nothing, creates nothing for that key and reports {role, key, reason} (ok:false). Two owned
// events for one key report 'duplicate-owned' and none is touched. Resolve by hand: inspect the event in the test
// calendar, delete it there, and run the seeder again.
//
// GUARD REVALIDATION. Before EVERY calendar mutation (createEvent, each setTag, setTime, setDescription,
// deleteEvent) fctSeedGuarded_ re-reads the Script Properties and re-opens the calendar (fctSeederIsolation_ and
// fctCalendar_), requires the same calendar identity as the handle in use and, for an event, the original
// calendar id when the method exists (UNVERIFIED semantics). On failure the run stops at once and reports
// ok:false, stopped:true, the guard code and the progress so far; nothing is reported as success. A rerun repairs
// and continues: the safe-retry state is the calendar itself (owned events and tags) plus FCT_SEED_INSTALL and
// FCT_SEED_ANCHOR. Repeated checks reduce but cannot eliminate the race between a check and the mutation after it.
//
// Removal deletes ONLY events whose description proves ownership, in the two guarded calendars, within a
// bounded window. Logs hold counts and fixture keys only.
//
// Editor entry points: fctSeedDryRun, fctSeedAll, fctApplyScheduleChange, fctRemoveSeeded.
// Seeding is idempotent and time-boxed: when the budget runs out it stops and reports partial; run it again.
// ============================================================================

const FCT_SEED_CONFIRM_VALUE_ = 'SEED-SYNTHETIC-ONLY';
const FCT_TAG_SEED_ = 'fct-seed';
const FCT_TAG_KEY_ = 'fct-key';
const FCT_TAG_OWN_ = 'fct-own';
const FCT_TAG_VARIANT_ = 'fct-variant';
const FCT_ANCHOR_PROPERTY_ = 'FCT_SEED_ANCHOR';
const FCT_INSTALL_PROPERTY_ = 'FCT_SEED_INSTALL';
const FCT_OWN_PREFIX_ = 'fct-own:';
const FCT_OWN_LINE_ = /^fct-own:(feed|synced):([A-Za-z0-9_-]{1,40}):([a-f0-9]{32})$/;
const FCT_SEED_BUDGET_MS_ = 270000;       // an execution lasts 6 minutes at most
const FCT_SEED_BACK_DAYS_ = 400;          // bounded window for lookups and removal
const FCT_SEED_FORWARD_DAYS_ = 500;
const FCT_SEED_REREAD_MS_ = 86400000;     // window around a fixture event for the confirming re-read

/**
 * Isolation check of the seeder project: the isolation flag, the marker, the deny list, none of the production-only
 * keys and the explicit confirmation. (The token, pepper and owner id belong to the API project.)
 */
function fctSeederIsolation_(props) {
  const no = function (reason) { return { ok: false, reason: reason }; };
  if (fctProp_(props, 'FCT_ISOLATED') !== FCT_ISOLATED_VALUE_) return no('not-isolated');
  for (let i = 0; i < FCT_PRODUCTION_ONLY_KEYS_.length; i++) {
    if (fctProp_(props, FCT_PRODUCTION_ONLY_KEYS_[i]) !== null) return no('production-property');
  }
  if (!/^[a-f0-9]{32,64}$/.test(fctProp_(props, 'FCT_MARKER') || '')) return no('marker-missing');
  if (fctDenyList_(props) === null) return no('denylist-missing');
  if (fctProp_(props, 'FCT_SEED_CONFIRM') !== FCT_SEED_CONFIRM_VALUE_) return no('confirm-missing');
  return { ok: true };
}

/** Isolation and both calendars, or throws { fctGuard: <code> }. Each calendar is a handle { id, calendar }. */
function fctSeederPrepare_(deps) {
  const d = deps || fctDeps_();
  const iso = fctSeederIsolation_(d.props);
  if (!iso.ok) throw { fctGuard: iso.reason };
  return { feed: fctCalendar_('feed', d), synced: fctCalendar_('synced', d) };
}

/**
 * Runs exactly ONE calendar mutation after a fresh validation: the Script Properties and BOTH test calendars are
 * checked again (the same checks as at the start of the run, so invalidating either calendar halts the seeder), the fresh calendar id must equal the handle's id, the calendar object actually in use must
 * report that same id and, when an event is given and the platform offers getOriginalCalendarId, the event must
 * come from that calendar. Any failure (or a failing mutation) throws { fctGuard: <code>, fctStop: true } and
 * nothing is mutated. The check and the mutation are separate platform calls: a calendar changed in between is
 * not detected (reduced, not eliminated).
 */
function fctSeedGuarded_(deps, role, handle, mutate, ev) {
  const d = deps || fctDeps_();
  const stop = function (code) { throw { fctGuard: code, fctStop: true }; };
  let code = null;
  let fresh = null;
  try {
    const iso = fctSeederIsolation_(d.props);
    if (!iso.ok) code = iso.reason;
    else {
      const both = { feed: fctCalendar_('feed', d), synced: fctCalendar_('synced', d) };
      fresh = both[role] || null;
      if (!fresh) code = 'bad-role';
    }
  } catch (err) {
    code = err && err.fctGuard ? err.fctGuard : 'guard-error';
  }
  if (code !== null) stop(code);
  const wanted = fctNormId_(fresh.id);
  let handleId = null;
  try { handleId = handle && handle.calendar && typeof handle.calendar.getId === 'function' ? fctNormId_(handle.calendar.getId()) : null; } catch (err) { handleId = null; }
  if (!handle || fctNormId_(handle.id) !== wanted || handleId !== wanted) stop('handle-identity');
  if (ev && typeof ev.getOriginalCalendarId === 'function') {
    let original = null;
    try { original = fctNormId_(ev.getOriginalCalendarId()); } catch (err) { original = null; }
    if (original !== wanted) stop('event-calendar');
  }
  try {
    return mutate();
  } catch (err) {
    return stop('write-failed');
  }
}

/** The local ("Berlin") date key of an instant. */
function fctTodayKey_(nowMs) {
  return Utilities.formatDate(new Date(nowMs), 'Europe/Berlin', 'yyyy-MM-dd');
}

function fctSeedWindow_(anchorKey, nowMs) {
  const a = Date.parse(anchorKey + 'T00:00:00Z');
  return { from: Math.min(a, nowMs) - FCT_SEED_BACK_DAYS_ * 86400000, to: Math.max(a, nowMs) + FCT_SEED_FORWARD_DAYS_ * 86400000 };
}

/** The anchor a seeding started with (kept until fctRemoveSeeded), or null. */
function fctStoredAnchor_() {
  const v = PropertiesService.getScriptProperties().getProperty(FCT_ANCHOR_PROPERTY_);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** The installation id (32 lowercase hex), null when none exists yet; a malformed value throws { fctGuard }. */
function fctStoredInstall_() {
  const v = PropertiesService.getScriptProperties().getProperty(FCT_INSTALL_PROPERTY_);
  if (v === null || v === undefined || v === '') return null;
  if (!/^[a-f0-9]{32}$/.test(String(v))) throw { fctGuard: 'install-invalid' };
  return String(v);
}

/** The installation id; generated once (and stored) when absent. Never logged, never written to a calendar. */
function fctSeedEnsureInstall_(existing) {
  if (existing) return existing;
  const sp = PropertiesService.getScriptProperties();
  const fresh = fctSha256_(Utilities.getUuid() + '|' + Utilities.getUuid()).slice(0, 32);
  sp.setProperty(FCT_INSTALL_PROPERTY_, fresh);
  // Overlapping seeder executions are serialized by the script lock in fctSeederLog_, so nothing else can store
  // a different id between this write and the read-back (the last write would win otherwise).
  const stored = fctStoredInstall_();
  if (!stored) throw { fctGuard: 'install-invalid' };
  return stored;
}

/** Proof that the installation created the fixture event (role, key). */
function fctSeedProof_(install, role, key) {
  return fctSha256_('fct-own|' + install + '|' + role + '|' + key).slice(0, 32);
}

function fctSeedMarkerLine_(install, role, key) {
  return FCT_OWN_PREFIX_ + role + ':' + key + ':' + fctSeedProof_(install, role, key);
}

/** Marker line, a blank line, then the fixture description (the blank line ends any block the production parser reads). */
function fctSeedDescription_(install, role, key, description) {
  return fctSeedMarkerLine_(install, role, key) + '\n\n' + description;
}

/**
 * { role, key } when the FIRST line of the event's description parses exactly and its proof recomputes against the
 * installation id; otherwise null. No install id: nothing is owned. Tags play no part.
 */
function fctSeedOwned_(ev, install) {
  if (!install) return null;
  const first = String(ev.getDescription() || '').split(/\r?\n/, 1)[0];
  const m = FCT_OWN_LINE_.exec(first);
  if (!m) return null;
  return m[3] === fctSeedProof_(install, m[1], m[2]) ? { role: m[1], key: m[2] } : null;
}

/** The exact tag set of a fully seeded event, in write order. */
function fctSeedRequiredTags_(fx, role, proof) {
  const tags = [[FCT_TAG_SEED_, '1'], [FCT_TAG_KEY_, fx.key], [FCT_TAG_OWN_, proof]];
  if (role === 'synced') tags.push([SYNC_PROPERTY_KEY, fx.sourceId]);
  return tags;
}

function fctSeedMissingTags_(ev, fx, role, proof) {
  return fctSeedRequiredTags_(fx, role, proof).filter(function (t) { return ev.getTag(t[0]) !== t[1]; });
}

function fctSeedTagsComplete_(ev, fx, role, proof) {
  return fctSeedMissingTags_(ev, fx, role, proof).length === 0;
}

/** Events of a calendar in the bounded window, each read once: ownership, key and own tags, title and times. */
function fctSeedRead_(calendar, fromMs, toMs, install) {
  return calendar.getEvents(new Date(fromMs), new Date(toMs)).map(function (ev) {
    return {
      ev: ev, owned: fctSeedOwned_(ev, install), keyTag: ev.getTag(FCT_TAG_KEY_), ownTag: ev.getTag(FCT_TAG_OWN_),
      title: String(ev.getTitle()), start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime(),
    };
  });
}

/**
 * State of one fixture key among the events read: { state: 'owned', entry } (exactly one proven-owned event),
 * { state: 'absent' } (nothing owned, nothing resembling it) or { state: 'conflict', reason }
 * ('duplicate-owned', 'unowned-tagged', 'unowned-lookalike'). A conflict is never resolved by the seeder.
 */
function fctSeedKeyStatus_(entries, role, fx, install) {
  const ownedHere = [];
  const others = [];
  entries.forEach(function (e) {
    if (e.owned && e.owned.role === role && e.owned.key === fx.key) ownedHere.push(e);
    else others.push(e);
  });
  if (ownedHere.length > 1) return { state: 'conflict', reason: 'duplicate-owned' };
  if (ownedHere.length === 1) return { state: 'owned', entry: ownedHere[0] };
  const proof = install ? fctSeedProof_(install, role, fx.key) : null;
  for (let i = 0; i < others.length; i++) {
    const e = others[i];
    if (e.keyTag === fx.key || (proof !== null && e.ownTag === proof)) return { state: 'conflict', reason: 'unowned-tagged' };
    if (e.owned === null && e.title === fx.title && e.start === fx.start && e.end === fx.end) return { state: 'conflict', reason: 'unowned-lookalike' };
  }
  return { state: 'absent' };
}

/** A fresh read of one event (by id) from the calendar, or null: the confirming read after tag writes. */
function fctSeedReread_(calendar, ev, fx) {
  const id = ev.getId();
  const list = calendar.getEvents(new Date(fx.start - FCT_SEED_REREAD_MS_), new Date(fx.end + FCT_SEED_REREAD_MS_));
  for (let i = 0; i < list.length; i++) {
    if (list[i].getId() === id) return list[i];
  }
  return null;
}

/**
 * The plan: guarded calendars, the stored installation id (or null), the fixture for the stored anchor (a seeding
 * that already started keeps its anchor) or else for today, and the events read from both calendars.
 */
function fctSeedPlan_(deps, nowMs) {
  const d = deps || fctDeps_();
  const calendars = fctSeederPrepare_(d);
  const anchor = fctStoredAnchor_() || fctTodayKey_(nowMs);
  const win = fctSeedWindow_(anchor, nowMs);
  const install = fctStoredInstall_();
  return {
    deps: d,
    anchor: anchor,
    fixture: fctFixture_(anchor),
    calendars: calendars,
    install: install,
    events: {
      feed: fctSeedRead_(calendars.feed.calendar, win.from, win.to, install),
      synced: fctSeedRead_(calendars.synced.calendar, win.from, win.to, install),
    },
    window: win,
  };
}

/** The progress object of a stopped run: counts only. */
function fctSeedProgress_(out) {
  const p = {};
  Object.keys(out).forEach(function (k) { if (typeof out[k] === 'number' || typeof out[k] === 'boolean') p[k] = out[k]; });
  return p;
}

/** Any error during the mutating phase becomes a stop that carries the progress so far (no message, id or name). */
function fctSeedStopped_(err, out) {
  return { fctGuard: err && err.fctGuard ? err.fctGuard : 'error', fctStop: true, progress: fctSeedProgress_(out) };
}

/** Counts only: what a seeding run would do. Writes nothing. */
function fctSeedDryRunCounts_(deps, nowMs) {
  const plan = fctSeedPlan_(deps, nowMs);
  const out = { anchor: plan.anchor, conflicts: 0, conflictList: [] };
  ['feed', 'synced'].forEach(function (role) {
    const list = plan.fixture[role];
    const c = { fixture: list.length, present: 0, repair: 0, conflicts: 0, toCreate: 0 };
    list.forEach(function (fx) {
      const st = fctSeedKeyStatus_(plan.events[role], role, fx, plan.install);
      if (st.state === 'conflict') { c.conflicts++; out.conflicts++; out.conflictList.push({ role: role, key: fx.key, reason: st.reason }); return; }
      if (st.state === 'absent') { c.toCreate++; return; }
      if (fctSeedTagsComplete_(st.entry.ev, fx, role, fctSeedProof_(plan.install, role, fx.key))) c.present++;
      else c.repair++;
    });
    out[role] = c;
  });
  if (out.conflicts > 0) out.ok = false;
  return out;
}

/**
 * Creates the missing fixture events and repairs owned events with missing or wrong tags (idempotent, time-boxed).
 * Every mutation is guarded. An event counts as created, repaired or skipped only after all its required tags were
 * confirmed by a fresh read. Counts only.
 */
function fctSeedAllCounts_(deps, nowMs, clock) {
  const plan = fctSeedPlan_(deps, nowMs);
  const d = plan.deps;
  const started = clock();
  const out = { anchor: plan.anchor, created: 0, repaired: 0, skipped: 0, partial: false, conflicts: 0, conflictList: [] };
  // The installation id and the anchor are remembered before the first calendar write: a continued run builds the
  // same fixture and recognizes the events of this installation.
  const install = fctSeedEnsureInstall_(plan.install);
  if (fctStoredAnchor_() === null) PropertiesService.getScriptProperties().setProperty(FCT_ANCHOR_PROPERTY_, plan.anchor);
  try {
    ['feed', 'synced'].forEach(function (role) {
      const handle = plan.calendars[role];
      plan.fixture[role].forEach(function (fx) {
        if (out.partial) return;
        const proof = fctSeedProof_(install, role, fx.key);
        const st = fctSeedKeyStatus_(plan.events[role], role, fx, install);
        if (st.state === 'conflict') { out.conflicts++; out.conflictList.push({ role: role, key: fx.key, reason: st.reason }); return; }
        if (st.state === 'owned' && fctSeedTagsComplete_(st.entry.ev, fx, role, proof)) { out.skipped++; return; }
        if (clock() - started > FCT_SEED_BUDGET_MS_) { out.partial = true; return; }
        let ev = null;
        let outcome = 'repaired';
        if (st.state === 'owned') {
          ev = st.entry.ev;
        } else {
          ev = fctSeedGuarded_(d, role, handle, function () {
            return handle.calendar.createEvent(fx.title, new Date(fx.start), new Date(fx.end),
              { description: fctSeedDescription_(install, role, fx.key, fx.description), location: fx.location });
          }, null);
          outcome = 'created';
        }
        fctSeedRequiredTags_(fx, role, proof).forEach(function (t) {
          if (ev.getTag(t[0]) === t[1]) return;
          fctSeedGuarded_(d, role, handle, function () { ev.setTag(t[0], t[1]); }, ev);
        });
        const again = fctSeedReread_(handle.calendar, ev, fx);
        if (again === null || !fctSeedTagsComplete_(again, fx, role, proof)) throw { fctGuard: 'tags-unconfirmed' };
        if (outcome === 'created') out.created++;
        else out.repaired++;
      });
    });
  } catch (err) {
    throw fctSeedStopped_(err, out);
  }
  if (out.conflicts > 0) out.ok = false;
  return out;
}

/**
 * Moves the scheduled-change flight in place (same event, so the same source id) and swaps one crew member.
 * Needs exactly one proven-owned event with complete tags. Time, description (the ownership line is kept) and the
 * variant tag are three separate guarded writes, the tag last, so an interrupted run simply repeats all three.
 */
function fctApplyScheduleChangeCounts_(deps, nowMs) {
  const plan = fctSeedPlan_(deps, nowMs);
  const d = plan.deps;
  const variant = plan.fixture.variants.scheduleChange;
  const fx = plan.fixture.feed.filter(function (e) { return e.key === variant.key; })[0];
  if (!plan.install || !fx) return { ok: false, applied: false, reason: 'seed-missing' };
  const st = fctSeedKeyStatus_(plan.events.feed, 'feed', fx, plan.install);
  if (st.state === 'conflict') {
    return { ok: false, applied: false, reason: 'conflict', conflicts: 1, conflictList: [{ role: 'feed', key: fx.key, reason: st.reason }] };
  }
  if (st.state === 'absent') return { ok: false, applied: false, reason: 'seed-missing' };
  const ev = st.entry.ev;
  if (!fctSeedTagsComplete_(ev, fx, 'feed', fctSeedProof_(plan.install, 'feed', fx.key))) return { ok: false, applied: false, reason: 'tags-incomplete' };
  if (ev.getTag(FCT_TAG_VARIANT_) === 'scheduleChange') return { applied: false, reason: 'already-applied' };
  const handle = plan.calendars.feed;
  const out = { applied: false, steps: 0 };
  try {
    fctSeedGuarded_(d, 'feed', handle, function () { ev.setTime(new Date(variant.start), new Date(variant.end)); }, ev);
    out.steps++;
    fctSeedGuarded_(d, 'feed', handle, function () { ev.setDescription(fctSeedDescription_(plan.install, 'feed', fx.key, variant.description)); }, ev);
    out.steps++;
    fctSeedGuarded_(d, 'feed', handle, function () { ev.setTag(FCT_TAG_VARIANT_, 'scheduleChange'); }, ev);
    out.steps++;
  } catch (err) {
    throw fctSeedStopped_(err, out);
  }
  out.applied = true;
  return out;
}

/**
 * Deletes ONLY events whose description proves ownership (installation id, role of the calendar), in the two
 * guarded calendars, within the bounded window. Tags are irrelevant; everything else is kept. The installation id
 * is never removed, so a later run can still prove ownership and a second run deletes nothing.
 */
function fctRemoveSeededCounts_(deps, nowMs) {
  const d = deps || fctDeps_();
  const calendars = fctSeederPrepare_(d);
  const win = fctSeedWindow_(fctStoredAnchor_() || fctTodayKey_(nowMs), nowMs);
  const install = fctStoredInstall_();
  const out = { deleted: 0, kept: 0 };
  try {
    ['feed', 'synced'].forEach(function (role) {
      const handle = calendars[role];
      handle.calendar.getEvents(new Date(win.from), new Date(win.to)).forEach(function (ev) {
        const owned = fctSeedOwned_(ev, install);
        if (owned === null || owned.role !== role) { out.kept++; return; }
        fctSeedGuarded_(d, role, handle, function () { ev.deleteEvent(); }, ev);
        out.deleted++;
      });
    });
  } catch (err) {
    throw fctSeedStopped_(err, out);
  }
  PropertiesService.getScriptProperties().deleteProperty(FCT_ANCHOR_PROPERTY_);
  return out;
}

/**
 * Runs a seeder action and logs one JSON line: counts, conflict keys, or a stable guard code (never an id or a name).
 * A stopped run (guard failure or a failing write) reports ok:false, stopped:true, the guard code and the progress.
 */
function fctSeederLog_(action, run) {
  let line;
  // One seeder execution at a time: a second, overlapping run refuses as busy before reading or writing anything.
  let lock = null;
  try { lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) lock = null; } catch (err) { lock = null; }
  if (lock === null) {
    line = { action: action, ok: false, reason: 'busy' };
    console.log(JSON.stringify(line));
    return line;
  }
  try {
    line = Object.assign({ action: action, ok: true }, run());
  } catch (err) {
    if (err && err.fctStop) line = { action: action, ok: false, stopped: true, guard: err.fctGuard || 'error', progress: err.progress || {} };
    else line = { action: action, ok: false, reason: err && err.fctGuard ? err.fctGuard : 'error' };
  } finally {
    lock.releaseLock();
  }
  console.log(JSON.stringify(line));
  return line;
}

function fctSeedDryRun() {
  return fctSeederLog_('dry-run', function () { return fctSeedDryRunCounts_(null, Date.now()); });
}

function fctSeedAll() {
  return fctSeederLog_('seed', function () { return fctSeedAllCounts_(null, Date.now(), function () { return Date.now(); }); });
}

function fctApplyScheduleChange() {
  return fctSeederLog_('schedule-change', function () { return fctApplyScheduleChangeCounts_(null, Date.now()); });
}

function fctRemoveSeeded() {
  return fctSeederLog_('remove', function () { return fctRemoveSeededCounts_(null, Date.now()); });
}
