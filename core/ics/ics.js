// Pure, offline ICS (RFC 5545) parser for Flight Control. No I/O, no network, no clock.
// It converts ICS text into the raw event shape the Condor adapter and roster model already
// consume ({sourceId, title, start, end, location, description, basis}) and keeps the original
// UID / RECURRENCE-ID / SEQUENCE / STATUS as source metadata. It never expands recurrence:
// RRULE / RDATE / EXDATE / EXRULE (and RECURRENCE-ID overrides of a master in the file) fail
// explicitly. Errors and warnings identify an event only by its 1-based position in the file
// (`event`); they never contain a UID, a TZID value or any other event text.
// Consumer notes: an empty VCALENDAR returns ok:true with 0 events, so callers must guard
// before treating that as "roster cleared". Input must be an already decoded string: a fold
// that splits a UTF-8 sequence at byte level cannot be repaired here (byte-level unfolding
// belongs to the future fetch layer).

const DAY = 86400000;
const fmts = new Map();

const unescapeText = (s) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const fail = (code, message, property) => { throw { code, message, ...(property ? { property } : {}) }; };

/** Cached Intl formatter for an IANA zone, or null when the zone is not valid. */
function zoneFormatter(tz) {
  if (typeof tz !== 'string' || !tz || /^[+-]/.test(tz)) return null;
  if (!fmts.has(tz)) {
    try {
      fmts.set(tz, new Intl.DateTimeFormat('en', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    } catch { fmts.set(tz, null); }
  }
  return fmts.get(tz);
}

/** Offset (ms) of a zone at an instant: local wall time read as UTC, minus the instant. */
function offsetAt(ms, fmt) {
  const p = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** Wall time (as UTC ms) in a zone -> instant. null = DST gap; ambiguous = DST overlap (earlier instant wins). */
function wallToInstant(wall, fmt) {
  const found = new Set();
  for (const o of new Set([offsetAt(wall - DAY, fmt), offsetAt(wall + DAY, fmt)])) {
    if (offsetAt(wall - o, fmt) === o) found.add(wall - o);
  }
  const all = [...found].sort((a, b) => a - b);
  return all.length ? { ms: all[0], ambiguous: all.length > 1 } : null;
}

const checkedWall = (y, mo, d, h = 0, mi = 0, s = 0) => {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const c = new Date(t);
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) fail('invalid-date', 'date or time value out of range');
  return t;
};

function resolveWall(wall, tz, ctx, property) {
  const r = wallToInstant(wall, zoneFormatter(tz));
  if (!r) fail('nonexistent-local-time', 'local time does not exist in its zone (DST gap)', property);
  if (r.ambiguous) ctx.warn('ambiguous-local-time', 'local time is ambiguous in its zone (DST overlap); earlier instant used', property);
  return r.ms;
}

/** Parses a DATE / DATE-TIME property into {ms, timeForm, allDay, wall, zone}. */
function parseTime(prop, ctx) {
  const v = prop.value.trim();
  const name = prop.name;
  if (String(prop.params.VALUE).toUpperCase() === 'DATE' || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (!m) fail('invalid-date', `${name} is not a valid DATE`, name);
    if (!ctx.allDayTimeZone) fail('missing-all-day-zone', `${name} is a DATE but options.allDayTimeZone is not set`, name);
    if (!zoneFormatter(ctx.allDayTimeZone)) fail('unsupported-tzid', 'options.allDayTimeZone is not a valid IANA zone', name);
    const wall = checkedWall(+m[1], +m[2], +m[3]);
    return { ms: resolveWall(wall, ctx.allDayTimeZone, ctx, name), timeForm: 'date', allDay: true, wall, zone: ctx.allDayTimeZone };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) fail('invalid-datetime', `${name} is not a valid DATE-TIME`, name);
  const wall = checkedWall(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) return { ms: wall, timeForm: 'utc', allDay: false, wall, zone: 'UTC' };
  const tzid = prop.params.TZID;
  if (tzid && !zoneFormatter(tzid)) fail('unsupported-tzid', `${name} TZID is not an IANA zone`, name);
  if (!tzid && !ctx.calendarZone) fail('floating-time', `${name} is floating time and the calendar declares no valid X-WR-TIMEZONE`, name);
  const zone = tzid || ctx.calendarZone;
  return { ms: resolveWall(wall, zone, ctx, name), timeForm: 'tzid', allDay: false, wall, zone };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (!m || v.trim().length < 3 || /T$/i.test(v.trim())) fail('invalid-duration', 'DURATION is not a valid RFC 5545 duration', 'DURATION');
  const n = (i) => +(m[i] || 0);
  if (m[1] === '-') fail('invalid-range', 'negative DURATION', 'DURATION');
  return { days: n(2) * 7 + n(3), ms: n(4) * 3600000 + n(5) * 60000 + n(6) * 1000 };
}

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());
const utcStamp = (p) => { const v = p && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(p.value.trim()); return v ? isoOrNull(Date.UTC(+v[1], +v[2] - 1, +v[3], +v[4], +v[5], +v[6])) : null; };

/** Splits one unfolded content line into {name, params, value}; colons inside quoted params do not split. */
function parseLine(line) {
  let q = false; let i = 0; const seg = []; let last = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (!q && c === ';') { seg.push(line.slice(last, i)); last = i + 1; } else if (!q && c === ':') break;
  }
  if (i >= line.length) return null;
  seg.push(line.slice(last, i));
  const params = {};
  for (const s of seg.slice(1)) {
    const eq = s.indexOf('=');
    if (eq > 0) params[s.slice(0, eq).toUpperCase()] = s.slice(eq + 1).replace(/^"(.*)"$/, '$1');
  }
  return { name: seg[0].trim().toUpperCase(), params, value: line.slice(i + 1) };
}

function buildEvent(props, ctx) {
  const get = (n) => props.find((p) => p.name === n);
  const uid = get('UID')?.value.trim() || null;
  if (!uid) fail('missing-uid', 'VEVENT has no UID', 'UID');
  for (const n of ['UID', 'DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID', 'SEQUENCE', 'STATUS', 'SUMMARY', 'DESCRIPTION', 'LOCATION', 'DTSTAMP']) {
    if (props.filter((p) => p.name === n).length > 1) fail('malformed', `${n} appears more than once on the event`, n);
  }
  for (const n of ['RRULE', 'RDATE', 'EXDATE', 'EXRULE']) {
    if (get(n)) fail('unsupported-recurrence', `${n}: recurrence is not supported and is never expanded`, n);
  }
  if (get('RECURRENCE-ID') && ctx.masterUids.has(uid)) {
    fail('unsupported-recurrence', 'RECURRENCE-ID override of a master event in the file: recurrence is not supported', 'RECURRENCE-ID');
  }
  if (get('DTEND') && get('DURATION')) fail('malformed', 'event has both DTEND and DURATION', 'DURATION');
  const startProp = get('DTSTART');
  if (!startProp) fail('missing-dtstart', 'event has no DTSTART', 'DTSTART');
  const s = parseTime(startProp, ctx);
  let end;
  if (get('DTEND')) {
    const e = parseTime(get('DTEND'), ctx);
    if (e.allDay !== s.allDay) fail('invalid-range', 'event mixes DATE and DATE-TIME in DTSTART and DTEND', 'DTEND');
    end = e.ms;
  } else if (get('DURATION')) {
    const d = parseDuration(get('DURATION').value);
    // Day/week parts are calendar days in the start's zone (wall-clock add, then resolve); H/M/S are exact.
    end = (s.allDay || (s.timeForm === 'tzid' && d.days)) ? resolveWall(s.wall + d.days * DAY, s.zone, ctx, 'DURATION') + d.ms : s.ms + d.days * DAY + d.ms;
  } else end = s.allDay ? resolveWall(s.wall + DAY, s.zone, ctx, 'DTEND') : s.ms;
  if (end < s.ms) fail('invalid-range', 'event ends before it starts', 'DTEND');
  let recurrenceId = null;
  if (get('RECURRENCE-ID')) {
    const r = parseTime(get('RECURRENCE-ID'), ctx);
    recurrenceId = r.allDay ? new Date(r.wall).toISOString().slice(0, 10) : isoOrNull(r.ms);
  }
  const seq = get('SEQUENCE')?.value.trim() ?? '0';
  if (!/^\d+$/.test(seq)) fail('invalid-sequence', 'event has a non-integer SEQUENCE', 'SEQUENCE');
  const text = (n) => { const p = get(n); return p ? unescapeText(p.value) : null; };
  return {
    uid, recurrenceId, sequence: +seq, status: get('STATUS')?.value.trim().toUpperCase() || null,
    dtstamp: utcStamp(get('DTSTAMP')), lastModified: utcStamp(get('LAST-MODIFIED')),
    summary: text('SUMMARY'), location: text('LOCATION'), description: text('DESCRIPTION'),
    start: s.ms, end, allDay: s.allDay, timeForm: s.timeForm,
  };
}

/**
 * Parses ICS text. Never throws; every problem is reported in `errors` / `warnings`.
 * @param {string} text
 * @param {{allDayTimeZone?: string, maxBytes?: number}} [options]
 * @returns {{ok: boolean, calendar: object, events: object[], cancelled: object[], errors: object[], warnings: object[]}}
 */
export function parseIcs(text, options = {}) {
  const errors = []; const warnings = []; const events = []; const cancelled = [];
  const calendar = { prodid: null, method: null, xWrTimezone: null, vtimezoneCount: 0 };
  const done = () => ({ ok: errors.length === 0, calendar, events, cancelled, errors, warnings });
  const maxBytes = options.maxBytes ?? 5_000_000;
  if (typeof text !== 'string') { errors.push({ code: 'not-ics', message: 'input is not text' }); return done(); }
  if (text.length > maxBytes) { errors.push({ code: 'too-large', message: `input exceeds ${maxBytes} characters` }); return done(); }
  const body = text.replace(/^\uFEFF/, '');
  if (!/^\s*BEGIN:VCALENDAR/i.test(body)) { errors.push({ code: 'not-ics', message: 'input does not start with BEGIN:VCALENDAR' }); return done(); }

  const lines = [];
  for (const raw of body.split(/\r\n|\n|\r/)) {
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  const stack = []; const veventProps = []; let cur = null; let closed = false; let trailing = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (closed) {
      if (!trailing) errors.push({ code: 'malformed', message: 'content after END:VCALENDAR' });
      trailing = true;
      continue;
    }
    const p = parseLine(line);
    if (!p) { errors.push({ code: 'malformed', message: 'content line without a colon' }); continue; }
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VTIMEZONE') calendar.vtimezoneCount += 1;
      if (comp === 'VEVENT' && stack.length === 2) { cur = []; veventProps.push(cur); }
    } else if (p.name === 'END') {
      const comp = p.value.trim().toUpperCase();
      if (stack.pop() !== comp) errors.push({ code: 'malformed', message: 'unbalanced END line' });
      if (comp === 'VCALENDAR' && !stack.length) closed = true;
      if (comp === 'VEVENT' && stack.length === 1) cur = null;
    } else if (stack.length === 1) {
      if (p.name === 'PRODID') calendar.prodid = p.value;
      else if (p.name === 'METHOD') calendar.method = p.value.trim();
      else if (p.name === 'X-WR-TIMEZONE') {
        if (zoneFormatter(p.value.trim())) calendar.xWrTimezone = p.value.trim();
        else warnings.push({ code: 'invalid-calendar-timezone', property: 'X-WR-TIMEZONE', message: 'X-WR-TIMEZONE is not a valid IANA zone; ignored' });
      }
    } else if (stack.length === 2 && stack[1] === 'VEVENT' && cur) {
      cur.push(p);
    }
  }
  if (stack.length) errors.push({ code: 'malformed', message: 'unterminated component (missing END)' });

  const groups = new Map();
  // Diagnostics name an event by its 1-based VEVENT position in the file, never by UID or any event text.
  const ordinal = new WeakMap();
  // Masters are read from the raw properties, so a master that itself fails to parse still counts.
  const firstOf = (props, n) => props.find((x) => x.name === n);
  const masterUids = new Set(veventProps.filter((props) => !firstOf(props, 'RECURRENCE-ID')).map((props) => firstOf(props, 'UID')?.value.trim()).filter(Boolean));
  veventProps.forEach((props, i) => {
    const event = i + 1;
    const ctx = { masterUids, allDayTimeZone: options.allDayTimeZone, calendarZone: calendar.xWrTimezone, warn: (code, message, property) => warnings.push({ code, event, property, message }) };
    try {
      const e = buildEvent(props, ctx);
      ordinal.set(e, event);
      const k = `${e.uid}\u0000${e.recurrenceId ?? ''}`;
      groups.set(k, [...(groups.get(k) || []), e]);
    } catch (err) {
      if (!err || !err.code) throw err;
      errors.push({ code: err.code, event, ...(err.property ? { property: err.property } : {}), message: err.message });
    }
  });
  for (const list of groups.values()) {
    const top = Math.max(...list.map((e) => e.sequence));
    const best = list.filter((e) => e.sequence === top);
    const event = ordinal.get(best[0]);
    if (list.length > best.length) warnings.push({ code: 'superseded-duplicate', event, message: 'a duplicate with a lower SEQUENCE was superseded' });
    if (best.length > 1) {
      // DTSTAMP is the export time, not event content: copies that differ only there are identical.
      const same = (e) => JSON.stringify({ ...e, dtstamp: null });
      if (best.every((e) => same(e) === same(best[0]))) warnings.push({ code: 'identical-duplicate', event, message: 'identical duplicate event ignored' });
      else { errors.push({ code: 'conflicting-duplicate', event, message: 'duplicate events share UID, RECURRENCE-ID and SEQUENCE but differ' }); continue; }
    }
    const e = best[0];
    if (e.recurrenceId) warnings.push({ code: 'orphan-recurrence-instance', event, message: 'RECURRENCE-ID instance without a master in the file; kept as a concrete event' });
    (e.status === 'CANCELLED' ? cancelled : events).push(e);
  }
  const seen = new Map();
  for (const e of [...events, ...cancelled]) {
    const id = icsSourceId(e.uid, e.recurrenceId);
    if (seen.has(id)) errors.push({ code: 'identity-collision', event: ordinal.get(e), message: 'two distinct events share one identity (UID + RECURRENCE-ID)' });
    seen.set(id, e);
  }
  const order = (a, b) => a.start - b.start || a.end - b.end || icsSourceId(a.uid, a.recurrenceId).localeCompare(icsSourceId(b.uid, b.recurrenceId));
  events.sort(order);
  cancelled.sort(order);
  return done();
}

/**
 * Permanent identity of an ICS event (NOT a Google event id).
 * @param {string} uid
 * @param {string|null} [recurrenceId]
 * @returns {string}
 */
export function icsSourceId(uid, recurrenceId) {
  return recurrenceId ? `${uid}#${recurrenceId}` : uid;
}

/**
 * ICS text -> raw events for fcv2ClassifyEvent_ / fcv2BuildRoster_. Fails closed: when not ok,
 * `events` (and `cancelled`) are empty so no partial schedule can be used.
 * @param {string} text
 * @param {{basis?: string, allDayTimeZone?: string, maxBytes?: number}} [options]
 * @returns {{ok: boolean, events: object[], cancelled: object[], errors: object[], warnings: object[], calendar: object}}
 */
export function icsToRawEvents(text, { basis = 'airline-feed', allDayTimeZone, maxBytes } = {}) {
  const r = parseIcs(text, { allDayTimeZone, maxBytes });
  const raw = (e) => ({
    sourceId: icsSourceId(e.uid, e.recurrenceId), title: e.summary ?? '', start: e.start, end: e.end,
    location: e.location ?? null, description: e.description ?? '', basis,
    ics: { uid: e.uid, recurrenceId: e.recurrenceId, sequence: e.sequence, status: e.status, dtstamp: e.dtstamp, lastModified: e.lastModified, timeForm: e.timeForm, allDay: e.allDay },
  });
  return { ok: r.ok, events: r.ok ? r.events.map(raw) : [], cancelled: r.ok ? r.cancelled.map(raw) : [], errors: r.errors, warnings: r.warnings, calendar: r.calendar };
}
