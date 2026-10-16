// The one shared formatting layer for operational times (departures, arrivals, wake-up, pickup,
// windows, radar rows, horizon stops). Every screen routes through here; none converts by itself.
//
// Input is always an absolute instant (epoch ms) plus the IANA zone of the place the event belongs
// to (or null when the data does not say). The Time Display preference (src/time-display.js) decides
// only the representation:
//   local  the event's own zone: departure at its airport, arrival at its airport, layover at the
//          destination, base events at home. Never the device zone. A missing zone is never guessed:
//          the time is shown in UTC and says so ("09:40 UTC").
//   utc    the same instant in UTC. A single mode chip (tzModeChip, shown by CSS only in UTC mode) marks
//          the block, so individual times carry no repeated "UTC".
// Dates, roster-day keys and countdowns are not part of this layer and do not change with the mode.
// `mode` is an optional last argument; it defaults to the stored preference so pure code stays testable.

import { html } from './html.js';
import { formatTime, formatDate, formatUtcOffset, offsetMinutes, localDateKey, diffDays, dayShift } from './time.js';
import { getTimeDisplay } from '../time-display.js';

const isUtc = (mode) => (mode ?? getTimeDisplay()) === 'utc';

/**
 * "HH:MM" for an operational instant. `compact` swaps the unknown-zone marker " UTC" for "Z".
 * `zulu` adds a "Z" in UTC mode, for dense places with no room for a block-level mode chip (calendar cells).
 */
export function opTime(ms, tz, mode = getTimeDisplay(), { compact = false, zulu = false } = {}) {
  if (isUtc(mode)) {
    const utc = formatTime(ms, 'UTC');
    return zulu && utc !== null ? `${utc}Z` : utc;
  }
  if (tz) {
    const local = formatTime(ms, tz);
    if (local !== null) return local;
  }
  const utc = formatTime(ms, 'UTC');
  return utc === null ? null : compact ? `${utc}Z` : `${utc} UTC`;
}

/** Spoken form of opTime for accessible names: UTC mode always says "UTC". */
export function opTimeSpoken(ms, tz, mode = getTimeDisplay(), options = {}) {
  if (isUtc(mode)) return `${formatTime(ms, 'UTC')} UTC`;
  return opTime(ms, tz, mode, options);
}

/** The wall-clock time in the event's own zone, exactly as it is on the clock there (null when the zone is unknown). */
export function eventLocalTime(ms, tz) {
  return tz ? formatTime(ms, tz) : null;
}

/** The date label that belongs to a time shown by opTime: UTC date in UTC mode, else the event-zone date. */
export function opDate(ms, tz, mode = getTimeDisplay(), locale) {
  if (isUtc(mode)) return formatDate(ms, 'UTC', locale);
  return formatDate(ms, tz ?? 'UTC', locale);
}

/** Calendar date key of the instant in the zone the time is displayed in. */
export function opDateKey(ms, tz, mode = getTimeDisplay()) {
  return localDateKey(ms, isUtc(mode) ? 'UTC' : tz ?? 'UTC');
}

/**
 * Whole days between the displayed departure date and the displayed arrival date (the "+1" mark).
 * Local: each end on its own date (null if a zone is unknown, as the date would be a guess).
 * UTC: both ends on their UTC dates (always computable).
 */
export function opShift(depMs, depTz, arrMs, arrTz, mode = getTimeDisplay()) {
  if (isUtc(mode)) {
    const dep = localDateKey(depMs, 'UTC');
    const arr = localDateKey(arrMs, 'UTC');
    return dep === null || arr === null ? null : diffDays(dep, arr);
  }
  if (!depTz || !arrTz) return null;
  return dayShift(depMs, depTz, arrMs, arrTz);
}

/**
 * Time-zone context for a time, or null when there is nothing to add.
 * Local: the existing note, i.e. nothing when the zone has the same offset as home, else
 *        "UTC+2 · 10:05 at home"; "Time zone unknown (UTC shown)" when the zone is not known.
 * UTC:   the same instant on the clock where the event happens ("10:05 local"); nothing when unknown
 *        (no zone is invented) or when the zone is on UTC at that moment.
 */
export function opZoneNote(ms, tz, profile, mode = getTimeDisplay()) {
  if (isUtc(mode)) {
    if (!tz) return null;
    const local = formatTime(ms, tz);
    if (local === null || offsetMinutes(ms, tz) === 0) return null;
    return `${local} local`;
  }
  if (!tz) return 'Time zone unknown (UTC shown)';
  if (offsetMinutes(ms, tz) === offsetMinutes(ms, profile.homeTz)) return null;
  return `${formatUtcOffset(ms, tz)} · ${formatTime(ms, profile.homeTz)} at home`;
}

/**
 * Local mode only: the arrival zone's UTC offset ("UTC−4"), and only when departure and arrival
 * are in zones with different offsets at their instants, so a journey that crosses time zones is
 * never ambiguous. Null in UTC mode (one zone, nothing to disambiguate) and when a zone is unknown.
 */
export function tzTag(depMs, depTz, arrMs, arrTz, mode = getTimeDisplay()) {
  if (isUtc(mode) || !depTz || !arrTz) return null;
  const a = offsetMinutes(depMs, depTz);
  const b = offsetMinutes(arrMs, arrTz);
  if (a === null || b === null || a === b) return null;
  return formatUtcOffset(arrMs, arrTz);
}

/** A small "UTC" chip for an operational block header. Hidden by CSS unless the page is in UTC mode. */
export function tzModeChip() {
  return html`<span class="tz-mode" aria-hidden="true">UTC</span>`;
}
