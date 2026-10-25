// Private, opt-in aggregates only. No storage, logging, payloads or identity keys.
export const DIAGNOSTIC_REQUEST_CAP = 100;
export const DIAGNOSTIC_REPORT_CAP = 20;
export const DIAGNOSTIC_PAYLOAD_CAP = 8192;
const ACTIONS = new Set(['crew', 'crewIndex', 'crewEnroll', 'crewRevoke']);
const SOURCES = new Set(['network', 'cache', 'joined', 'local-refusal']);
const OUTCOMES = new Set(['success', 'network', 'timeout', 'invalid-response', 'refused', 'access-changed', 'error']);
let enabled = false;
let generation = 0;
let requests = [], reports = [], sessions = [];
let truncated = false;
export function clearCrewDiagnostics() { enabled = false; generation++; requests = []; reports = []; sessions = []; truncated = false; }
export function startCrewDiagnostics() { clearCrewDiagnostics(); enabled = true; }
export const crewDiagnosticsEnabled = () => enabled;
export const crewDiagnosticGeneration = () => generation;
export function recordCrewRequest({ action, source, outcome, elapsedMs, transportMs = null }, born = generation) {
  if (!enabled || born !== generation || !ACTIONS.has(action) || !SOURCES.has(source)) return;
  if (requests.length >= DIAGNOSTIC_REQUEST_CAP) { truncated = true; return; }
  requests.push({ action, source, outcome: OUTCOMES.has(outcome) ? outcome : 'error',
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
    transportMs: Number.isFinite(transportMs) && transportMs >= 0 ? transportMs : null });
}
export function recordCrewReport(report, born = generation) {
  if (!enabled || born !== generation) return;
  if (reports.length >= DIAGNOSTIC_REPORT_CAP) { truncated = true; return; }
  try { reports.push(validateCrewDiagnostics(report)); } catch { reports.push({ complete: false }); }
}
export function recordCrewSession(value, born = generation) {
  if (!enabled || born !== generation) return;
  if (sessions.length >= DIAGNOSTIC_REPORT_CAP) { truncated = true; return; }
  const stops = new Set(['done', 'uncovered', 'no-progress', 'limit', 'deadline', 'budget', 'busy', 'hidden', 'offline', 'cancelled', 'access-changed', 'session-unavailable']);
  const numeric = n => Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  sessions.push({ calls: numeric(value.calls), elapsedMs: numeric(value.elapsedMs), initialOutstanding: numeric(value.initialOutstanding),
    allowance: numeric(value.allowance), stopped: stops.has(value.stopped) ? value.stopped : 'error' });
}
export function crewDiagnosticSnapshot() {
  const samples = requests.filter((x) => x.action === 'crew' && x.source === 'network' && x.outcome === 'success' && x.elapsedMs !== null).map((x) => x.elapsedMs).slice(0, 10).sort((a,b) => a-b);
  return JSON.parse(JSON.stringify({ enabled, truncated, requests, reports, sessions,
    crewNetworkSamples: { count: samples.length, p50Ms: samples.length === 10 ? samples[4] : null, p95Ms: samples.length === 10 ? samples[9] : null } }));
}

/** Exact, bounded numeric schema. Returns a detached value, never arbitrary backend fields. */
export function validateCrewDiagnostics(d) {
  const fail = () => { throw new Error('invalid-diagnostics'); };
  const keys = (o, names) => { if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length !== names.length || names.some((k) => !Object.hasOwn(o,k))) fail(); };
  const number = (n, nullable = false, integer = false) => { if (nullable && n === null) return; if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER || (integer && !Number.isInteger(n))) fail(); };
  if (JSON.stringify(d).length > DIAGNOSTIC_PAYLOAD_CAP) fail();
  keys(d, ['version','complete','serverMs','diagnosticMs','storeOperations','storage','committedParts','months','maintenance']);
  if (d.version !== 1 || typeof d.complete !== 'boolean') fail();
  number(d.serverMs); number(d.diagnosticMs);
  keys(d.storeOperations,['keys','reads','writes','deletes']);
  Object.values(d.storeOperations).forEach(n => number(n,false,true));
  keys(d.storage, ['observedPeakBytes','admissionPeakBytes','peakCategories']);
  number(d.storage.observedPeakBytes,true,true); number(d.storage.admissionPeakBytes,true,true);
  if (d.storage.peakCategories !== null) {
    const names = ['otherValueBytes','committedValueBytes','retiredValueBytes','orphanValueBytes','stagedValueBytes','manifestValueBytes','keyBytes'];
    keys(d.storage.peakCategories,names);
    names.forEach((k) => number(d.storage.peakCategories[k],false,true));
    if (names.reduce((n,k) => n+d.storage.peakCategories[k],0) !== d.storage.observedPeakBytes) fail();
  } else if (d.storage.observedPeakBytes !== null) fail();
  keys(d.committedParts,['count','medianValueBytes','maxValueBytes']);
  number(d.committedParts.count,true,true); number(d.committedParts.medianValueBytes,true); number(d.committedParts.maxValueBytes,true,true);
  if (d.complete && (d.storage.observedPeakBytes === null || d.committedParts.count === null)) fail();
  if (d.committedParts.count > 0 && (d.committedParts.medianValueBytes === null || d.committedParts.maxValueBytes === null || d.committedParts.medianValueBytes > d.committedParts.maxValueBytes)) fail();
  if (d.committedParts.count === 0 && (d.committedParts.medianValueBytes !== null || d.committedParts.maxValueBytes !== null)) fail();
  if (!Array.isArray(d.months) || d.months.length > 6) fail();
  const outcomes = new Set(['not-sealable','busy','committed','verified','uncovered','replaceFailed','replaceFailed-unpersisted','aborted-generation','aborted-conflict','index-incompatible','touch-failed']);
  d.months.forEach((m) => {
    keys(m,['elapsedMs','eventsRead','encodedBodyBytes','partCount','lockWaitMs','lockHeldMs','outcome']);
    ['elapsedMs','lockWaitMs','lockHeldMs'].forEach((k) => number(m[k]));
    number(m.eventsRead,false,true); number(m.encodedBodyBytes,true,true); number(m.partCount,true,true);
    if (!outcomes.has(m.outcome)) fail();
    if (d.complete && m.outcome === 'committed' && (m.encodedBodyBytes === null || m.partCount === null || d.storage.admissionPeakBytes === null)) fail();
  });
  keys(d.maintenance,['lockWaitMs','lockHeldMs']); number(d.maintenance.lockWaitMs); number(d.maintenance.lockHeldMs);
  return JSON.parse(JSON.stringify(d));
}
