// Personal Part-time Schedule (2027): recurring part-time days that the Calendar shows as "V".
// This is the owner's own schedule, NOT roster data. It is an overlay applied after the roster
// classifier (roster.buildDays) and only ever to a day on which the roster confirms nothing.
// It never changes a day's status, evidence, confidence, provenance or label, so a part-time day
// is never an off day and never "confirmed". Pure date-key work: no Date or time zone maths.

export const PART_TIME_YEAR = 2027;

export const DEFAULT_PART_TIME = Object.freeze({
  enabled: false,
  year: PART_TIME_YEAR,
  days: Object.freeze([4, 5, 6, 7]),
  pausedMonths: Object.freeze([7, 8, 9]),
  overrides: Object.freeze({}),
});

const MONTH_KEY = /^2027-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, '0');
// 2027 is not a leap year; a fixed table keeps this module free of Date maths and of the calendar model.
const MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const intList = (value, lo, hi) => (Array.isArray(value) && value.every((n) => isInt(n, lo, hi))
  ? [...new Set(value)].sort((a, b) => a - b) : null);

function defaults() {
  return { enabled: false, year: PART_TIME_YEAR, days: [...DEFAULT_PART_TIME.days], pausedMonths: [...DEFAULT_PART_TIME.pausedMonths], overrides: {} };
}

/** Any stored value -> a valid config; garbage falls back to the defaults, field by field. */
export function normalizePartTime(raw) {
  const out = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  const days = intList(raw.days, 1, 31);
  if (days) out.days = days;
  const paused = intList(raw.pausedMonths, 1, 12);
  if (paused) out.pausedMonths = paused;
  if (raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
    for (const [key, value] of Object.entries(raw.overrides)) {
      const list = MONTH_KEY.test(key) ? intList(value, 1, 31) : null;
      if (list) out.overrides[key] = list;
    }
  }
  return out;
}

/** Sorted date keys of the part-time days in one month (always inside 2027); [] when disabled. */
export function partTimeDates(config, monthKey) {
  if (!config?.enabled || typeof monthKey !== 'string' || !MONTH_KEY.test(monthKey)) return [];
  const month = Number(monthKey.slice(5));
  const picked = Object.hasOwn(config.overrides ?? {}, monthKey) ? config.overrides[monthKey]
    : (config.pausedMonths ?? []).includes(month) ? [] : (config.days ?? []);
  const length = MONTH_LENGTH[month - 1];
  return [...new Set(picked)].filter((d) => isInt(d, 1, length)).sort((a, b) => a - b).map((d) => `${monthKey}-${pad(d)}`);
}

/** True when the roster lists nothing at all for the day (the only days V may take). */
export function rosterIsSilent(day) {
  return day.status === 'unknown'
    && day.evidence !== 'duty-unspecified' && day.evidence !== 'unknown-code'
    && !(day.unknownCodes?.length)
    && !(day.duties?.length) && !(day.sectors?.length)
    && !day.window && !day.layover;
}

/** The days with `partTime: true` on every eligible day; all other days are returned untouched. */
export function applyPartTime(days, config) {
  if (!config?.enabled) return days;
  const wanted = new Set();
  const seen = new Set();
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const date of partTimeDates(config, key)) wanted.add(date);
  }
  return days.map((day) => (wanted.has(day.date) && rosterIsSilent(day) ? { ...day, partTime: true } : day));
}
