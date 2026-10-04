// Duty Horizon model: where am I in this rotation?
//   off → wake-up → pickup → briefing → flight → layover → return → recovery
// Only milestones present in (or safely derived from) the data are produced: no briefing
// without a report time, no recovery length invented (it is open-ended). Layout is a
// weighted sequence, not a time-proportional bar: short ground phases stay readable next
// to multi-day layovers, and "now" is interpolated inside the current phase by time.

const SPAN_WEIGHT = { before: 0.7, prepare: 0.8, ground: 1, flight: 2.2, return: 2.2, turn: 0.8, layover: 2, gap: 1, recovery: 1.1 };
const RECOVERY_VIEW_MS = 12 * 3600000;

function pickRotation(rotations, now) {
  const active = rotations.find((r) => r.start <= now && now < r.end);
  if (active) return { rotation: active, phase: 'active' };
  const recent = rotations.filter((r) => r.closed && r.end <= now && now - r.end < RECOVERY_VIEW_MS).at(-1);
  if (recent) return { rotation: recent, phase: 'recovery' };
  const next = rotations.find((r) => r.start > now);
  if (next) return { rotation: next, phase: 'upcoming' };
  return null;
}

function stopsFor(rotation) {
  const stops = [];
  rotation.duties.forEach((duty) => {
    const first = duty.sectors[0];
    if (duty.wakeup !== null) stops.push({ kind: 'wakeup', label: 'Wake-up', at: duty.wakeup, tz: first.originTz, code: first.origin });
    if (duty.pickup !== null) stops.push({ kind: 'pickup', label: 'Pickup', at: duty.pickup, tz: first.originTz, code: first.origin });
    if (duty.report !== null) stops.push({ kind: 'briefing', label: 'Briefing', at: duty.report, tz: first.originTz, code: first.origin });
    for (const s of duty.sectors) {
      stops.push({ kind: 'departure', label: s.origin, at: s.dep, tz: s.originTz, code: s.origin, sector: s });
      stops.push({ kind: 'arrival', label: s.destination, at: s.arr, tz: s.destTz, code: s.destination, sector: s });
    }
  });
  return stops;
}

function spanKind(a, b, rotation, home, lastArrival) {
  if (a.kind === 'wakeup') return 'prepare';
  if (a.kind === 'pickup' || a.kind === 'briefing') return 'ground';
  if (a.kind === 'departure') {
    const isLast = b === lastArrival;
    return isLast && rotation.closed && home.has(b.code) && rotation.duties.length > 1 ? 'return' : 'flight';
  }
  if (a.kind === 'arrival') {
    const sameDuty = b.kind === 'departure' && b.sector && a.sector && rotation.duties.some((d) => d.sectors.includes(a.sector) && d.sectors.includes(b.sector));
    if (sameDuty) return 'turn';
    const layover = rotation.layovers.find((l) => l.airport === a.code && l.from === a.at);
    return layover ? 'layover' : 'gap';
  }
  return 'gap';
}

function spanLabel(kind, a, b) {
  if (kind === 'flight' || kind === 'return') return `${a.code} → ${b.code}`;
  if (kind === 'layover') return `Layover ${a.code}`;
  if (kind === 'recovery') return 'Recovery';
  return null;
}

/**
 * @returns {null | {rotation: object, mode: 'active'|'recovery'|'upcoming', stops: object[], spans: object[], now: {x:number, span:string|null}}}
 */
export function buildHorizon(roster, state, profile, now) {
  const picked = pickRotation(roster.rotations, now);
  if (!picked) return null;
  return horizonFor(picked.rotation, picked.phase, state, profile, now);
}

/** Horizon of a specific rotation (Calendar day detail); mode is relative to now. */
export function buildRotationHorizon(rotation, state, profile, now) {
  const mode = rotation.start > now ? 'upcoming'
    : now < rotation.end ? 'active'
    : rotation.closed && now - rotation.end < RECOVERY_VIEW_MS ? 'recovery' : 'past';
  return horizonFor(rotation, mode, state, profile, now);
}

function horizonFor(rotation, mode, state, profile, now) {
  const home = new Set(profile.homeBases);
  const stops = stopsFor(rotation);
  if (!stops.length) return null;
  const lastArrival = stops.filter((s) => s.kind === 'arrival').at(-1);

  // Spans: a leading "before" stub, the phases between stops, and an open recovery tail.
  const spans = [];
  const beforeLabel = state.status === 'off' && state.confidence === 'confirmed' ? 'Off' : 'Before duty';
  spans.push({ kind: 'before', label: rotation.openStart ? null : beforeLabel, start: null, end: stops[0].at, from: null, to: 0 });
  for (let i = 0; i < stops.length - 1; i += 1) {
    const kind = spanKind(stops[i], stops[i + 1], rotation, home, lastArrival);
    spans.push({ kind, label: spanLabel(kind, stops[i], stops[i + 1]), start: stops[i].at, end: stops[i + 1].at, from: i, to: i + 1 });
  }
  if (rotation.closed) {
    const last = stops.length - 1;
    spans.push({ kind: 'recovery', label: 'Recovery', start: stops[last].at, end: null, from: last, to: null });
  }

  // Layout: cumulative weights → x positions in [0, 1].
  const total = spans.reduce((sum, s) => sum + SPAN_WEIGHT[s.kind], 0);
  let cursor = 0;
  for (const span of spans) {
    span.x0 = cursor / total;
    cursor += SPAN_WEIGHT[span.kind];
    span.x1 = cursor / total;
  }
  stops.forEach((stop, i) => {
    const after = spans.find((s) => s.from === i);
    const before = spans.find((s) => s.to === i);
    stop.x = after ? after.x0 : before.x1;
    stop.status = stop.at <= now ? 'past' : 'upcoming';
  });

  // Status of each span and the position of "now".
  let nowX = 0;
  let nowSpan = null;
  for (const span of spans) {
    const start = span.start ?? -Infinity;
    const end = span.end ?? (span.start + RECOVERY_VIEW_MS);
    if (now >= end) span.status = 'past';
    else if (now >= start) {
      span.status = 'current';
      nowSpan = span.kind;
      const fraction = span.start === null ? 0.65 : Math.min(1, Math.max(0, (now - start) / (end - start)));
      nowX = span.x0 + fraction * (span.x1 - span.x0);
    } else span.status = 'upcoming';
  }
  if (!nowSpan && spans.at(-1).status === 'past') nowX = 1;

  // Mark the next upcoming stop as the current milestone.
  const nextStop = stops.find((s) => s.status === 'upcoming');
  if (nextStop) nextStop.next = true;

  return { rotation, mode, stops, spans, now: { x: nowX, span: nowSpan } };
}
