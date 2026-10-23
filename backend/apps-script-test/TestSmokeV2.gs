// ============================================================================
// FLIGHT CONTROL — ISOLATED APPS SCRIPT TEST PACKAGE: LIVE SMOKE RUNNER (test-only)
// ============================================================================
// NEVER add this file to the production Apps Script project. Runs ordered scenarios from the Apps Script
// editor against the REAL services of the "FC-TEST Crew API" project (Calendar read, Script/User Properties,
// Cache, Lock, Session) and the two synthetic calendars. Each request goes through the production
// fcv2HandlePost_ with the guarded, hardened environment (fctEnv_). It reads the roster token from Script
// Properties and never logs it. Output: one redacted JSON line per scenario, {id, pass, failed?, counts?},
// then a summary line. Failed checks are named by fixed strings, never by value.
//
// Entry points (three runs, because the schedule-change step needs the SEEDER project in between):
//   fctRunSmoke()             S0 setup/isolation, S1 capabilities, S2 auth failures, S3 enrollment,
//                             S4 crewIndex until complete, S5 crew lookups (records a baseline for S6),
//                             S13 time zones and daylight saving through the live Utilities
//   (seeder project)          fctApplyScheduleChange()
//   fctRunSmokeAfterChange()  S6 schedule change seen by lookup and re-verification
//   fctRunSmokeFinish()       S7 revocation, S8 cancellation, S9 owner purge, S10 malformed state (restored),
//                             S11 cache cleanup, S12 guard failure (in-memory overrides only)
//   fctRunSmokeResume()       continues S4 (indexing is resumable), then S5 and S13: use it if fctRunSmoke() ran out of time
//   fctRestoreState()         recovery if a run died inside S10 (restores FC_CREW_STATE from the backup)
// Run it on the same day the seeder ran: the feed block is ahead of "today" only for a few days.
// ============================================================================

const FCT_SMOKE_GRANT_PROP_ = 'FCT_SMOKE_GRANT';
const FCT_SMOKE_BASE_PROP_ = 'FCT_SMOKE_BASE';
const FCT_SMOKE_BACKUP_PROP_ = 'FCT_SMOKE_STATE_BACKUP';
const FCT_PURGE_CONFIRM_VALUE_ = 'PURGE-ALL-CREW-DATA';
const FCT_CREW_ACTIONS_ = ['crew', 'crewEnroll', 'crewIndex', 'crewRevoke'];
const FCT_INDEX_MAX_CALLS_ = 40;
const FCT_INDEX_BUDGET_MS_ = 200000;   // leaves time for the lookups: an execution lasts 6 minutes at most

/** The smoke context over the real services (the Node tests give the sandbox fakes of the same globals). */
function fctSmokeCtx_(deps) {
  const d = deps || fctDeps_();
  const sp = PropertiesService.getScriptProperties();
  const ctx = {
    deps: d,
    props: {
      get: function (k) { return sp.getProperty(k); },
      set: function (k, v) { sp.setProperty(k, v); },
      del: function (k) { sp.deleteProperty(k); },
    },
    user: { keys: function () { return PropertiesService.getUserProperties().getKeys(); } },
    cache: CacheService.getScriptCache(),
    now: function () { return Date.now(); },
    uuid: function () { return Utilities.getUuid().replace(/-/g, '').toLowerCase(); },
    log: function (line) { console.log(line); },
    purgeAll: function () { return crewPurgeAll(); },
    env: null,
  };
  ctx.getEnv = function () { if (ctx.env === null) ctx.env = fctEnv_(d); return ctx.env; };
  ctx.token = function () { return sp.getProperty('FC_V2_TOKEN'); };
  ctx.raw = function (obj) { return fcv2HandlePost_(JSON.stringify(obj), ctx.getEnv()); };
  ctx.call = function (action, extra) {
    return ctx.raw(Object.assign({ contract: 'fc.roster', version: 2, token: ctx.token(), action: action }, extra || {}));
  };
  return ctx;
}

/** A check collector: c(name, condition) records the fixed name of a failed condition. */
function fctChecks_() {
  const failed = [];
  const c = function (name, cond) { if (!cond) failed.push(name); return !!cond; };
  c.failed = failed;
  return c;
}

function fctTodayKeyOf_(ctx) {
  const env = ctx.getEnv();
  return env.deps.localDate(env.now(), env.config.baseTimeZone);
}

/** Finds a seeded flight in the live airline feed by its flight number; returns its sector id and local date. */
function fctSmokeFind_(ctx, flightNumber) {
  const env = ctx.getEnv();
  const tz = env.config.baseTimeZone;
  const today = fctTodayKeyOf_(ctx);
  const from = env.startOfDay(today);
  const raws = env.airlineEvents(from, from + 200 * 86400000);
  for (let i = 0; i < raws.length; i++) {
    if (String(raws[i].title).indexOf(flightNumber + ' ') === 0) {
      return {
        sectorId: 's_' + env.deps.hash(String(raws[i].sourceId)).slice(0, 16),
        date: env.deps.localDate(raws[i].start, tz), start: raws[i].start, end: raws[i].end,
      };
    }
  }
  return null;
}

function fctFcxKeyCount_(ctx) {
  return ctx.user.keys().filter(function (k) { return k.indexOf('fcx.') === 0; }).length;
}

function fctIssueCode_(ctx) {
  const code = 'fctest-' + ctx.uuid();
  ctx.props.set('FC_CREW_ENROLL', code + '|' + (ctx.now() + 10 * 60000));
  return code;
}

/** Calls crewIndex until the whole sealable range is indexed (bounded). Returns { complete, calls, progress }. */
function fctIndexUntilComplete_(ctx, grant, extra) {
  const started = ctx.now();
  let progress = null;
  let calls = 0;
  for (; calls < FCT_INDEX_MAX_CALLS_ && ctx.now() - started < FCT_INDEX_BUDGET_MS_;) {
    const r = ctx.call('crewIndex', Object.assign({ grant: grant }, extra || {}));
    calls++;
    if (!r.ok) return { complete: false, calls: calls, progress: progress, error: r.error };
    progress = r.progress;
    if (progress.total > 0 && progress.indexed === progress.total && progress.pending === 0 && progress.stale === 0 && progress.uncovered === 0) {
      return { complete: true, calls: calls, progress: progress };
    }
  }
  return { complete: false, calls: calls, progress: progress };
}

function fctMemberKey_(m) { return String(m.family) + '|' + String(m.given); }

function fctNoIds_(value) {
  const text = JSON.stringify(value);
  return !/\b[0-9]{6}[A-Z]\b/.test(text) && text.indexOf('"key"') < 0 && text.indexOf('"id"') < 0;
}

// ---------------------------------------------------------------------------
// Scenarios. Each takes ctx and returns { failed: [names], counts?, skipped? }.
// ---------------------------------------------------------------------------

/** S0 setup and isolation: guard passes; the seeded events are present (counts only). */
function fctScenarioS0_(ctx) {
  const c = fctChecks_();
  c('isolation', fctIsolation_(ctx.deps.props).ok === true);
  let prepared = false;
  try { fctPrepare_(ctx.deps); prepared = true; } catch (err) { prepared = false; }
  c('calendars-guarded', prepared);
  if (!prepared) return { failed: c.failed };
  const env = ctx.getEnv();
  const today = fctTodayKeyOf_(ctx);
  const fx = fctFixture_(today);
  const from = env.startOfDay(today);
  const feedCount = env.airlineEvents(from, from + 40 * 86400000).length;
  const syncedCount = env.syncedEvents(from - 200 * 86400000, from).length;
  // The seeder project sets the sync tag, this project reads it: a different script project. If tags turn out to be
  // private to the script that set them, the synced calendar would hold events but none would be visible here.
  const syncedAll = ctx.deps.calendarApp.getCalendarById(TARGET_CALENDAR_ID).getEvents(new Date(from - 200 * 86400000), new Date(from)).length;
  c('sync-tag-visible-across-projects', syncedAll === 0 || syncedCount > 0);
  const wantFeed = fx.feed.filter(function (e) { return e.start >= from && e.start < from + 40 * 86400000; }).length;
  const wantSynced = fx.synced.filter(function (e) { return e.start >= from - 200 * 86400000 && e.start < from; }).length;
  c('feed-seeded', feedCount >= wantFeed && wantFeed > 0);
  c('synced-seeded', syncedCount >= wantSynced && wantSynced > 0);
  c('primary-flight-ahead', fctSmokeFind_(ctx, fx.expect.primary.flightNumber) !== null);
  return { failed: c.failed, counts: { feed: feedCount, synced: syncedCount, syncedAll: syncedAll, wantFeed: wantFeed, wantSynced: wantSynced } };
}

/** S1 capabilities: crew block present, provider actions absent. */
function fctScenarioS1_(ctx) {
  const c = fctChecks_();
  const r = ctx.call('capabilities');
  c('ok', r.ok === true && r.action === 'capabilities');
  const actions = Array.isArray(r.actions) ? r.actions : [];
  FCT_CREW_ACTIONS_.forEach(function (a) { c('has-' + a, actions.indexOf(a) >= 0); });
  c('no-departures', actions.indexOf('departures') < 0);
  c('no-flight', actions.indexOf('flight') < 0);
  c('crew-cancel-limit', !!r.limits && r.limits.crewCancel === 1);
  c('no-purge-action', actions.indexOf('crewPurgeAll') < 0);
  return { failed: c.failed, counts: { actions: actions.length } };
}

/** S2 authentication and contract failures. */
function fctScenarioS2_(ctx) {
  const c = fctChecks_();
  c('missing-token', ctx.raw({ contract: 'fc.roster', version: 2, action: 'capabilities' }).error === 'unauthorized');
  c('wrong-token', ctx.raw({ contract: 'fc.roster', version: 2, token: 'fctest_wrong', action: 'capabilities' }).error === 'unauthorized');
  c('wrong-contract', ctx.raw({ contract: 'fc.roster', version: 3, token: ctx.token(), action: 'capabilities' }).error === 'unsupported-contract');
  c('unknown-action', ctx.call('nope').error === 'unknown-action');
  c('purge-not-routable', ctx.call('crewPurgeAll').error === 'unknown-action');
  c('bad-body', fcv2HandlePost_('not json', ctx.getEnv()).error === 'bad-request');
  const now = ctx.now();
  c('departures-off', ctx.call('departures', { airport: 'FRA', from: now, to: now + 3600000 }).error === 'departures-not-configured');
  c('flight-off', ctx.call('flight', { flightNumber: 'DE9201', date: fctTodayKeyOf_(ctx), origin: 'FRA' }).error === 'flight-not-configured');
  const stats = ctx.call('stats');
  c('stats-synthetic', stats.success === true && stats.synthetic === true);
  const noGrant = ctx.call('crew', { sectorId: 's_0000000000000000', date: '2026-01-01' });
  c('crew-needs-grant', noGrant.ok === false && ['crew-not-enrolled', 'unauthorized'].indexOf(noGrant.error) >= 0);
  return { failed: c.failed };
}

/** S3 enrollment with a runner-issued synthetic code (the owner needs no manual step). */
function fctScenarioS3_(ctx) {
  const c = fctChecks_();
  const grant = 'fctest-grant-' + ctx.uuid() + ctx.uuid();
  const code = fctIssueCode_(ctx);
  const first = ctx.call('crewEnroll', { grant: grant, code: code });
  c('enrolled', first.ok === true && first.enrolled === true && typeof first.G === 'number' && first.G >= 1);
  c('code-consumed', ctx.props.get('FC_CREW_ENROLL') === null);
  const again = ctx.call('crewEnroll', { grant: grant, code: code });
  c('idempotent-retry', again.ok === true && again.G === first.G);
  const reuse = ctx.call('crewEnroll', { grant: 'fctest-grant-' + ctx.uuid(), code: code });
  c('code-single-use', reuse.ok === false && reuse.error === 'enroll-closed');
  // A second, live code with a wrong guess: refused and counted; the code is removed afterwards.
  fctIssueCode_(ctx);
  const wrong = ctx.call('crewEnroll', { grant: 'fctest-grant-' + ctx.uuid(), code: 'fctest-wrong' });
  c('wrong-code', wrong.ok === false && wrong.error === 'unauthorized');
  ctx.props.del('FC_CREW_ENROLL');
  ctx.props.set(FCT_SMOKE_GRANT_PROP_, grant);
  return { failed: c.failed, counts: { G: first.G } };
}

/** S4 crewIndex until the whole sealable range is indexed. */
function fctScenarioS4_(ctx) {
  const c = fctChecks_();
  const grant = ctx.props.get(FCT_SMOKE_GRANT_PROP_);
  if (!grant) return { failed: ['no-grant'] };
  const r = fctIndexUntilComplete_(ctx, grant, null);
  c('index-ok', !r.error);
  c('complete', r.complete === true);
  c('stored', fctFcxKeyCount_(ctx) > 0);
  const p = r.progress || { total: 0, indexed: 0 };
  return { failed: c.failed, counts: { calls: r.calls, total: p.total, indexed: p.indexed, keys: fctFcxKeyCount_(ctx) } };
}

function fctExpectMembers_(c, name, got, want) {
  const ok = got.length === want.length && want.every(function (w, i) {
    const m = got[i];
    const sameName = m.rank === w.rank && m.family === w.family && m.given === w.given;
    const sameCount = w.count > 0 ? (m.match === 'recorded' && m.count === w.count) : (m.match === 'none' && m.count === 0);
    return sameName && sameCount;
  });
  c(name, ok);
}

/** S5 crew lookups on known synthetic sectors. */
function fctScenarioS5_(ctx) {
  const c = fctChecks_();
  const grant = ctx.props.get(FCT_SMOKE_GRANT_PROP_);
  if (!grant) return { failed: ['no-grant'] };
  const fx = fctFixture_(fctTodayKeyOf_(ctx));
  const primary = fctSmokeFind_(ctx, fx.expect.primary.flightNumber);
  if (!primary) return { failed: ['primary-not-found'] };
  const r = ctx.call('crew', { grant: grant, sectorId: primary.sectorId, date: primary.date });
  c('primary-ok', r.ok === true && r.crewListed === true && Array.isArray(r.members));
  if (r.ok === true && Array.isArray(r.members)) {
    fctExpectMembers_(c, 'primary-members', r.members, fx.expect.primary.members);
    c('history-recorded-duties', !!r.history && r.history.basis === 'recorded-duties');
    // The fixture holds records that cannot be indexed on purpose, so the answer is incomplete, not complete.
    c('history-incomplete-by-design', !!r.history && r.history.state === 'incomplete' && r.history.reasons.indexOf('missing-records') >= 0);
    c('no-identifiers', fctNoIds_(r));
  }
  const none = fctSmokeFind_(ctx, fx.expect.noCrewList.flightNumber);
  const rn = none ? ctx.call('crew', { grant: grant, sectorId: none.sectorId, date: none.date }) : { ok: false };
  c('no-crew-list', rn.ok === true && rn.crewListed === false && Array.isArray(rn.members) && rn.members.length === 0 && rn.history === null);
  const inv = fctSmokeFind_(ctx, fx.expect.invalid.flightNumber);
  const ri = inv ? ctx.call('crew', { grant: grant, sectorId: inv.sectorId, date: inv.date }) : { ok: false };
  c('invalid-records-ok', ri.ok === true && Array.isArray(ri.members) && ri.members.length === fx.expect.invalid.members);
  if (ri.ok === true && Array.isArray(ri.members)) {
    c('invalid-records-unavailable', ri.members.filter(function (m) { return m.match === 'unavailable'; }).length === fx.expect.invalid.unavailable);
    c('invalid-no-identifiers', fctNoIds_(ri));
  }
  c('unknown-sector', ctx.call('crew', { grant: grant, sectorId: 's_0000000000000000', date: primary.date }).error === 'sector-not-found');
  c('bad-sector-id', ctx.call('crew', { grant: grant, sectorId: 'x', date: primary.date }).error === 'bad-request');
  c('bad-range', ctx.call('crew', { grant: grant, sectorId: primary.sectorId, date: '2000-01-01' }).error === 'bad-range');
  c('wrong-grant', ctx.call('crew', { grant: 'fctest-not-the-grant', sectorId: primary.sectorId, date: primary.date }).error === 'unauthorized');
  // Baseline for S6 (the schedule-change flight before the seeder moves it).
  const f2 = fctSmokeFind_(ctx, fx.expect.scheduleChange.flightNumber);
  if (f2) {
    ctx.props.set(FCT_SMOKE_BASE_PROP_, JSON.stringify({ sectorId: f2.sectorId, start: f2.start, shifted: f2.start !== fx.variants.scheduleChange.before.start }));
  }
  c('baseline-recorded', !!f2);
  return { failed: c.failed, counts: { primaryMembers: fx.expect.primary.members.length } };
}

/** S13 time zones and daylight saving through the live Utilities.formatDate (not covered by any Node fake). */
function fctScenarioS13_(ctx) {
  const c = fctChecks_();
  const today = fctTodayKeyOf_(ctx);
  const fx = fctFixture_(today);
  const r = ctx.call('roster', { from: fcv2AddDays_(today, 1), to: fcv2AddDays_(today, 99) });
  c('roster-ok', r.ok === true && Array.isArray(r.sectors));
  if (!(r.ok === true && Array.isArray(r.sectors))) return { failed: c.failed };
  let checked = 0;
  fx.expect.zones.forEach(function (z) {
    const s = r.sectors.filter(function (x) { return x.flightNumber === z.flightNumber; })[0];
    if (!s) { c('zone-' + z.key + '-present', z.key === 'X1' || z.key === 'X2' || z.key === 'X3' || z.key === 'X4'); return; }   // fixed dates may be out of range or in the past
    checked++;
    const off = function (iso) { return typeof iso === 'string' ? iso.slice(-6) : null; };
    if (z.depOffset) c('zone-' + z.key + '-dep-offset', off(s.depLocal) === z.depOffset);
    if (z.arrOffset) c('zone-' + z.key + '-arr-offset', off(s.arrLocal) === z.arrOffset);
    if (z.dayShift !== undefined) c('zone-' + z.key + '-day-shift', s.dayShift === z.dayShift);
  });
  c('zones-checked', checked >= 2);
  return { failed: c.failed, counts: { checked: checked } };
}

/** S6 schedule change: same sector id, moved time, replaced crew member, re-verification. */
function fctScenarioS6_(ctx) {
  const c = fctChecks_();
  const grant = ctx.props.get(FCT_SMOKE_GRANT_PROP_);
  let base = null;
  try { base = JSON.parse(ctx.props.get(FCT_SMOKE_BASE_PROP_) || 'null'); } catch (err) { base = null; }
  if (!grant || !base) return { failed: [], skipped: 'no-baseline' };
  const fx = fctFixture_(fctTodayKeyOf_(ctx));
  const f2 = fctSmokeFind_(ctx, fx.expect.scheduleChange.flightNumber);
  c('flight-found', !!f2);
  if (!f2) return { failed: c.failed };
  c('same-source-id', f2.sectorId === base.sectorId);
  c('time-moved', f2.start === base.start + fx.expect.scheduleChange.shiftMinutes * 60000 && base.shifted === false);
  const r = ctx.call('crew', { grant: grant, sectorId: f2.sectorId, date: f2.date });
  c('lookup-ok', r.ok === true && Array.isArray(r.members));
  if (r.ok === true && Array.isArray(r.members)) {
    fctExpectMembers_(c, 'crew-replaced', r.members, fx.expect.scheduleChange.after);
    const removed = fx.expect.scheduleChange.before.filter(function (b) {
      return !fx.expect.scheduleChange.after.some(function (a) { return fctMemberKey_(a) === fctMemberKey_(b); });
    });
    c('removed-member-gone', removed.length === 1 && !r.members.some(function (m) { return fctMemberKey_(m) === fctMemberKey_(removed[0]); }));
  }
  const reverify = fctIndexUntilComplete_(ctx, grant, { verifyBefore: ctx.now() });
  c('reverify-ok', !reverify.error);
  c('reverify-complete', reverify.complete === true);
  return { failed: c.failed, counts: { calls: reverify.calls } };
}

/** S7 revocation: deletes the index, is idempotent, leaves other user properties alone. */
function fctScenarioS7_(ctx) {
  const c = fctChecks_();
  const grant = ctx.props.get(FCT_SMOKE_GRANT_PROP_);
  if (!grant) return { failed: ['no-grant'] };
  const others = ctx.user.keys().filter(function (k) { return k.indexOf('fcx.') !== 0; }).length;
  const had = fctFcxKeyCount_(ctx);
  const rid = 'fctest-rev-' + ctx.uuid();
  const r = ctx.call('crewRevoke', { grant: grant, revokeId: rid });
  c('revoked', r.ok === true && r.state === 'deleted');
  c('deleted-keys', r.ok === true && r.deletedKeys > 0 && had > 0);
  c('index-gone', fctFcxKeyCount_(ctx) === 0);
  c('other-properties-kept', ctx.user.keys().filter(function (k) { return k.indexOf('fcx.') !== 0; }).length === others);
  const after = ctx.call('crew', { grant: grant, sectorId: 's_0000000000000000', date: '2026-01-01' });
  c('grant-dead', after.ok === false && after.error === 'crew-not-enrolled');
  const again = ctx.call('crewRevoke', { grant: grant, revokeId: rid });
  c('idempotent', again.ok === true && again.state === 'deleted' && again.recorded === true);
  return { failed: c.failed, counts: { deleted: r.deletedKeys || 0 } };
}

/** S8 cancellation: a grant that is not live gets a tombstone and can never be activated. */
function fctScenarioS8_(ctx) {
  const c = fctChecks_();
  const grant = 'fctest-grant-' + ctx.uuid() + ctx.uuid();
  const r = ctx.call('crewRevoke', { grant: grant, revokeId: 'fctest-cancel-' + ctx.uuid() });
  c('cancelled', r.ok === true && r.state === 'cancelled' && r.deletedKeys === 0);
  const code = fctIssueCode_(ctx);
  const e = ctx.call('crewEnroll', { grant: grant, code: code });
  c('late-enrollment-refused', e.ok === false && e.error === 'enroll-closed');
  c('code-untouched', ctx.props.get('FC_CREW_ENROLL') !== null);
  ctx.props.del('FC_CREW_ENROLL');
  let st = null;
  try { st = JSON.parse(ctx.props.get('FC_CREW_STATE') || 'null'); } catch (err) { st = null; }
  c('not-active-after-cancel', !!st && st.phase !== 'active');
  return { failed: c.failed };
}

/** S9 owner purge with the confirmation property. */
function fctScenarioS9_(ctx) {
  const c = fctChecks_();
  const grant = 'fctest-grant-' + ctx.uuid() + ctx.uuid();
  const e = ctx.call('crewEnroll', { grant: grant, code: fctIssueCode_(ctx) });
  c('enrolled', e.ok === true);
  const idx = ctx.call('crewIndex', { grant: grant });
  c('indexed-some', idx.ok === true && fctFcxKeyCount_(ctx) > 0);
  const refused = ctx.purgeAll();
  c('refused-without-confirmation', !!refused && refused.outcome === 'refused' && fctFcxKeyCount_(ctx) > 0);
  const keep = ['FC_V2_TOKEN', 'FC_CREW_PEPPER', 'FC_CREW_SELF', 'FC_CREW_ENABLED', 'FCT_ISOLATED'];
  ctx.props.set('FC_CREW_PURGE_CONFIRM', FCT_PURGE_CONFIRM_VALUE_);
  fctIssueCode_(ctx);
  const done = ctx.purgeAll();
  c('purged', !!done && done.outcome === 'deleted' && done.remaining === 0);
  c('index-gone', fctFcxKeyCount_(ctx) === 0);
  c('confirmation-consumed', ctx.props.get('FC_CREW_PURGE_CONFIRM') === null);
  c('code-removed', ctx.props.get('FC_CREW_ENROLL') === null);
  c('other-properties-kept', keep.every(function (k) { return ctx.props.get(k) !== null; }));
  const after = ctx.call('crew', { grant: grant, sectorId: 's_0000000000000000', date: '2026-01-01' });
  c('grant-dead', after.ok === false && after.error === 'crew-not-enrolled');
  return { failed: c.failed, counts: { deleted: done ? done.deletedKeys : 0 } };
}

/** S10 malformed FC_CREW_STATE fails closed and is never overwritten; the original value is restored exactly. */
function fctScenarioS10_(ctx) {
  const c = fctChecks_();
  const raw = ctx.props.get('FC_CREW_STATE');
  ctx.props.set(FCT_SMOKE_BACKUP_PROP_, JSON.stringify({ present: raw !== null, raw: raw }));
  const bad = ['{ this is not json', '{"G":-1,"phase":"active"}'];
  try {
    bad.forEach(function (garbage, i) {
      ctx.props.set('FC_CREW_STATE', garbage);
      const tag = '-' + (i + 1);
      c('crew-unavailable' + tag, ctx.call('crew', { grant: 'fctest-x', sectorId: 's_0000000000000000', date: '2026-01-01' }).error === 'crew-unavailable');
      c('index-unavailable' + tag, ctx.call('crewIndex', { grant: 'fctest-x' }).error === 'crew-unavailable');
      c('revoke-unavailable' + tag, ctx.call('crewRevoke', { grant: 'fctest-x', revokeId: 'fctest-r' }).error === 'crew-unavailable');
      const caps = ctx.call('capabilities');
      const extras = (caps.actions || []).filter(function (a) { return FCT_CREW_ACTIONS_.indexOf(a) >= 0; });
      c('capabilities-revoke-only' + tag, extras.length === 1 && extras[0] === 'crewRevoke');
      const purge = ctx.purgeAll();
      c('purge-error' + tag, !!purge && purge.outcome === 'error');
      c('never-overwritten' + tag, ctx.props.get('FC_CREW_STATE') === garbage);
    });
  } finally {
    if (raw === null) ctx.props.del('FC_CREW_STATE'); else ctx.props.set('FC_CREW_STATE', raw);
    ctx.props.del(FCT_SMOKE_BACKUP_PROP_);
  }
  c('restored-exactly', ctx.props.get('FC_CREW_STATE') === raw);
  return { failed: c.failed };
}

/** S11 cache cleanup effects observable through the live adapters. */
function fctScenarioS11_(ctx) {
  const c = fctChecks_();
  const crewEnv = fcv2CrewLiveEnv_(ctx.getEnv());
  const probe = 'fctest-probe-' + ctx.uuid();
  crewEnv.cache.put(probe, '1', 60);
  c('probe-written', ctx.cache.get(probe) === '1');
  crewEnv.cache.removeAll([probe]);
  c('probe-removed', ctx.cache.get(probe) === null);
  // A refused enrollment attempt is counted in the cache, and the counter can be cleaned.
  fctIssueCode_(ctx);
  const wrong = ctx.call('crewEnroll', { grant: 'fctest-grant-' + ctx.uuid(), code: 'fctest-wrong' });
  c('wrong-code-refused', wrong.ok === false);
  c('failure-counted', Number(ctx.cache.get('fcv2-crew-enroll-failures') || 0) >= 1);
  ctx.props.del('FC_CREW_ENROLL');
  ctx.cache.removeAll(['fcv2-crew-enroll-failures']);
  c('failure-counter-cleared', ctx.cache.get('fcv2-crew-enroll-failures') === null);
  // A revoke that has nothing to delete reports no cache problem.
  const r = ctx.call('crewRevoke', { grant: 'fctest-grant-' + ctx.uuid(), revokeId: 'fctest-r-' + ctx.uuid() });
  c('no-cache-warning', r.ok === true && r.cacheCleared === undefined);
  return { failed: c.failed };
}

/** S12 permission and guard failures, simulated with in-memory property overrides only (no real calendar is touched). */
function fctScenarioS12_(ctx) {
  const c = fctChecks_();
  const real = ctx.deps.props;
  const feedId = real.get('FCT_CAL_FEED_ID');
  const withProps = function (over) {
    return {
      calendarApp: ctx.deps.calendarApp, hash: ctx.deps.hash,
      props: { get: function (k) { return Object.prototype.hasOwnProperty.call(over, k) ? over[k] : real.get(k); } },
    };
  };
  const body = JSON.stringify({ contract: 'fc.roster', version: 2, token: ctx.token(), action: 'capabilities' });
  const cases = [
    ['not-isolated', { FCT_ISOLATED: 'no' }, 'not-isolated'],
    ['production-key', { FC_ADB_RAPIDAPI_KEY: 'x' }, 'production-property'],
    ['token-format', { FC_V2_TOKEN: 'bad-token' }, 'token-format'],
    ['denied-calendar', { FCT_DENY_SHA256: fctSha256_(feedId) + ',' + fctSha256_('other') }, 'calendar-denied'],
    ['same-calendar-twice', { FCT_CAL_SYNCED_ID: feedId }, 'calendar-ids-equal'],
    ['wrong-marker', { FCT_MARKER: new Array(33).join('a') }, 'calendar-marker'],
    ['missing-calendar', { FCT_CAL_FEED_ID: 'fctest-no-such-calendar' }, null],
  ];
  cases.forEach(function (k) {
    const deps = withProps(k[1]);
    let code = null;
    try { fctPrepare_(deps); } catch (err) { code = err && err.fctGuard ? err.fctGuard : 'error'; }
    c('refused-' + k[0], code !== null && (k[2] === null || code === k[2]));
    const answer = fctHandle_(body, deps);
    c('not-configured-' + k[0], answer.ok === false && answer.error === 'not-configured');
    const text = JSON.stringify(answer);
    c('no-leak-' + k[0], text.indexOf('fctGuard') < 0 && text.indexOf('calendar-') < 0 && text.indexOf('reason') < 0);
  });
  c('control-passes', fctHandle_(body, ctx.deps).ok === true);
  return { failed: c.failed, counts: { cases: cases.length } };
}

const FCT_SCENARIOS_ = {
  S0: fctScenarioS0_, S1: fctScenarioS1_, S2: fctScenarioS2_, S3: fctScenarioS3_, S4: fctScenarioS4_, S5: fctScenarioS5_,
  S6: fctScenarioS6_, S7: fctScenarioS7_, S8: fctScenarioS8_, S9: fctScenarioS9_, S10: fctScenarioS10_, S11: fctScenarioS11_,
  S12: fctScenarioS12_, S13: fctScenarioS13_,
};

/** Restores FC_CREW_STATE from the S10 backup (when a run died between the garbage write and the restore). */
function fctRestoreStateIn_(ctx) {
  const backup = ctx.props.get(FCT_SMOKE_BACKUP_PROP_);
  if (backup === null) return false;
  let saved = null;
  try { saved = JSON.parse(backup); } catch (err) { saved = null; }
  if (!saved || typeof saved.present !== 'boolean') return false;
  if (saved.present) ctx.props.set('FC_CREW_STATE', saved.raw); else ctx.props.del('FC_CREW_STATE');
  ctx.props.del(FCT_SMOKE_BACKUP_PROP_);
  return true;
}

/** Runs scenarios in order; logs one line each and a summary; returns { results, summary }. */
function fctSmokeRun_(ids, ctx) {
  const results = [];
  ids.forEach(function (id) {
    let r;
    try { r = FCT_SCENARIOS_[id](ctx); } catch (err) { r = { failed: ['exception'], error: err && err.fctGuard ? err.fctGuard : 'error' }; }
    const line = { id: id, pass: !r.skipped && r.failed.length === 0 };
    if (r.skipped) line.skipped = r.skipped;
    if (r.failed.length) line.failed = r.failed;
    if (r.counts) line.counts = r.counts;
    if (r.error) line.error = r.error;
    results.push(line);
    ctx.log(JSON.stringify(line));
  });
  const summary = {
    summary: true,
    pass: results.filter(function (x) { return x.pass; }).length,
    fail: results.filter(function (x) { return !x.pass && !x.skipped; }).length,
    skipped: results.filter(function (x) { return !!x.skipped; }).length,
  };
  ctx.log(JSON.stringify(summary));
  return { results: results, summary: summary };
}

function fctRunSmoke() {
  return fctSmokeRun_(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S13'], fctSmokeCtx_(null));
}

/** Continues S4 (indexing is resumable), then repeats the lookups: use it when fctRunSmoke() ran out of time in S4. */
function fctRunSmokeResume() {
  return fctSmokeRun_(['S4', 'S5', 'S13'], fctSmokeCtx_(null));
}

function fctRunSmokeAfterChange() {
  return fctSmokeRun_(['S6'], fctSmokeCtx_(null));
}

function fctRunSmokeFinish() {
  const ctx = fctSmokeCtx_(null);
  fctRestoreStateIn_(ctx);
  return fctSmokeRun_(['S7', 'S8', 'S9', 'S10', 'S11', 'S12'], ctx);
}

function fctRestoreState() {
  const restored = fctRestoreStateIn_(fctSmokeCtx_(null));
  console.log(JSON.stringify({ restored: restored }));
  return restored;
}
