// IANA time-zone utilities for Flight Control V2.
// All display times derive from absolute epoch-ms instants plus IANA zones via Intl:
// no fixed offsets, no libraries, no system time zone, and no implicit clock (`now` is always passed in).
// Fixes the legacy display defects B1 (destination DST), B4 (ceil-based "tomorrow"),
// B5 (outstation time labelled as local) and B6 (day shift derived from UTC dates).
// Invalid input (non-finite ms, unknown zone, malformed date key) returns null instead of throwing,
// except isValidTimeZone which returns a boolean.

const MINUTE_MS = 60000;
const KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUS = '−';

const formatterCache = new Map();

function partsFormatter(tz) {
  if (typeof tz !== 'string' || tz === '') return null;
  if (formatterCache.has(tz)) return formatterCache.get(tz);
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    });
  } catch {
    formatter = null;
  }
  formatterCache.set(tz, formatter);
  return formatter;
}

const pad2 = (n) => String(n).padStart(2, '0');

function utcMs(year, month, day) {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getTime();
}

function parseKey(key) {
  if (typeof key !== 'string') return null;
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(utcMs(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

function keyFromUtcMs(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(ms, tz) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const formatter = partsFormatter(tz);
  if (!formatter) return null;
  let parts;
  try {
    parts = formatter.formatToParts(ms);
  } catch {
    return null;
  }
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = out;
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
  const weekday = new Date(utcMs(year, month, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

export function offsetMinutes(ms, tz) {
  const p = zonedParts(ms, tz);
  if (!p) return null;
  const asUtc = utcMs(p.year, p.month, p.day) + ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
  const instant = Math.floor(ms / 1000) * 1000;
  return Math.round((asUtc - instant) / MINUTE_MS) + 0;
}

export function localDateKey(ms, tz) {
  const p = zonedParts(ms, tz);
  if (!p) return null;
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function formatTime(ms, tz) {
  const p = zonedParts(ms, tz);
  if (!p) return null;
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatDate(ms, tz, locale = 'en-GB') {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  if (typeof tz !== 'string' || tz === '') return null;
  try {
    const text = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    }).format(ms);
    return text.replace(/,/g, '');
  } catch {
    return null;
  }
}

export function formatUtcOffset(ms, tz) {
  const offset = offsetMinutes(ms, tz);
  if (offset === null) return null;
  if (offset === 0) return 'UTC±0';
  const sign = offset < 0 ? MINUS : '+';
  const abs = Math.abs(offset);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${pad2(minutes)}` : ''}`;
}

export function addDays(dateKey, n) {
  const k = parseKey(dateKey);
  if (!k || typeof n !== 'number' || !Number.isInteger(n)) return null;
  const ms = utcMs(k.year, k.month, k.day) + n * 86400000;
  if (!Number.isFinite(new Date(ms).getTime())) return null;
  return keyFromUtcMs(ms);
}

export function diffDays(fromKey, toKey) {
  const a = parseKey(fromKey);
  const b = parseKey(toKey);
  if (!a || !b) return null;
  return Math.round((utcMs(b.year, b.month, b.day) - utcMs(a.year, a.month, a.day)) / 86400000);
}

export function calendarDaysUntil(nowMs, targetMs, tz) {
  const from = localDateKey(nowMs, tz);
  const to = localDateKey(targetMs, tz);
  if (from === null || to === null) return null;
  return diffDays(from, to);
}

export function relativeDayLabel(nowMs, targetMs, tz) {
  const n = calendarDaysUntil(nowMs, targetMs, tz);
  if (n === null) return null;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 1 ? `In ${n} days` : `${-n} days ago`;
}

export function dayShift(depMs, depTz, arrMs, arrTz) {
  const dep = localDateKey(depMs, depTz);
  const arr = localDateKey(arrMs, arrTz);
  if (dep === null || arr === null) return null;
  return diffDays(dep, arr);
}

// First instant whose local date in tz is >= dateKey (local date keys are monotonic in the instant).
// Equals 00:00 local when it exists, otherwise the first existing instant of that date (DST gap at midnight).
export function startOfLocalDay(dateKey, tz) {
  const k = parseKey(dateKey);
  if (!k || !isValidTimeZone(tz)) return null;
  const guess = utcMs(k.year, k.month, k.day);
  let lo = guess - 36 * 3600000; // local date is certainly before dateKey
  let hi = guess + 36 * 3600000; // local date is certainly on or after dateKey
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDateKey(mid, tz) >= dateKey) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function durationMinutes(startMs, endMs) {
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.round((endMs - startMs) / MINUTE_MS) + 0;
}

export function formatDuration(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return '—';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function countdown(nowMs, targetMs) {
  if (typeof nowMs !== 'number' || typeof targetMs !== 'number') return null;
  if (!Number.isFinite(nowMs) || !Number.isFinite(targetMs)) return null;
  const totalMs = targetMs - nowMs;
  if (totalMs <= 0) return { totalMs, past: true, days: 0, hours: 0, minutes: 0, seconds: 0, label: 'Now' };
  const totalSeconds = Math.floor(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let label;
  if (days >= 1) label = `${days}d ${pad2(hours)}h`;
  else if (hours >= 1) label = `${hours}h ${pad2(minutes)}m`;
  else if (minutes >= 1) label = `${minutes}m ${pad2(seconds)}s`;
  else label = `${seconds}s`;
  return { totalMs, past: false, days, hours, minutes, seconds, label };
}
