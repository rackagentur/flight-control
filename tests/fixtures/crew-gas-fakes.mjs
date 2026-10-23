// Fake Apps Script services for the Phase 1d.2B routing tests (Node only; synthetic data only).
// Session, LockService, PropertiesService, CacheService, CalendarApp, SpreadsheetApp, ContentService and the
// parts of Utilities the live code uses (formatDate, computeDigest, HMAC, gzip, base64, getUuid, newBlob).
// Byte arrays are returned as Java-style SIGNED bytes (-128..127), as Apps Script does.
// Not a test file (no ".test." in the name).
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { localDate, localIso } from '../gs-harness.js';

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (bytes) => Buffer.from(Array.from(bytes, (b) => b & 0xff));

class FakeBlob {
  constructor(buf, contentType = null) { this.buf = Buffer.from(buf); this.contentType = contentType; }
  getBytes() { return signed(this.buf); }
  getDataAsString(charset) { if (charset && !/^utf-?8$/i.test(charset)) throw new Error('charset not faked'); return this.buf.toString('utf8'); }
  setDataFromString(s, charset) { if (charset && !/^utf-?8$/i.test(charset)) throw new Error('charset not faked'); this.buf = Buffer.from(String(s), 'utf8'); return this; }
}

/** A property store (Script or User Properties) with an optional write fault and a call log. */
function fakeProperties(initial = {}, log = []) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getProperty: (k) => { log.push(['get', k]); return map.has(k) ? map.get(k) : null; },
    setProperty: (k, v) => { log.push(['set', k]); if (String(v).length > 9000) throw new Error('value too large'); map.set(k, String(v)); },
    deleteProperty: (k) => { log.push(['del', k]); map.delete(k); },
    getKeys: () => [...map.keys()],
  };
}

/** One fake calendar event from a raw synthetic event ({sourceId, title, start, end, location, description}). */
function fakeEvent(raw, { idPrefix = '', tag = null } = {}) {
  return {
    getId: () => `${idPrefix}${raw.sourceId}`,
    getTitle: () => raw.title,
    getStartTime: () => new Date(raw.start),
    getEndTime: () => new Date(raw.end),
    getLocation: () => raw.location ?? '',
    getDescription: () => raw.description ?? '',
    getTag: (key) => (key === 'SYNC_SOURCE_ID' && tag ? tag : null),
  };
}

/**
 * The sandbox globals for loadGs(files, globals). Options:
 *   script / user: initial Script / User Properties; email: the effective user's email ('' / null allowed);
 *   sessionThrows: Session.getEffectiveUser() throws; lockBusy: tryLock answers false;
 *   feed / synced: raw events for the airline calendar / the synced calendar (synced ones carry the sync tag,
 *   plus `untagged` personal events that must never be read).
 * Returns { globals, spies } — spies: calls per service, console output, lock nesting violations.
 */
export function gasFakes({ script = {}, user = {}, email = null, sessionThrows = false, lockBusy = false, feed = [], synced = [], untagged = [] } = {}) {
  const spies = { session: 0, lock: { acquired: 0, refused: 0, nested: 0 }, calendar: [], console: [], scriptLog: [], userLog: [], cacheRemoved: [], stats: 0, userStore: 0 };
  const scriptProps = fakeProperties(script, spies.scriptLog);
  const userProps = fakeProperties(user, spies.userLog);
  const cacheMap = new Map();
  let held = false;
  const overlap = (list, from, to) => list.filter((e) => e.end > from.getTime() && e.start < to.getTime());
  const calendars = {
    'SYNTHETIC-SOURCE-CALENDAR': { getEvents: (from, to) => { spies.calendar.push(['source', from.getTime(), to.getTime()]); return overlap(feed, from, to).map((r) => fakeEvent(r)); } },
    'SYNTHETIC-TARGET-CALENDAR': {
      getEvents: (from, to) => {
        spies.calendar.push(['target', from.getTime(), to.getTime()]);
        return [...overlap(synced, from, to).map((r) => fakeEvent(r, { idPrefix: 'copy-', tag: r.sourceId })), ...overlap(untagged, from, to).map((r) => fakeEvent(r, { idPrefix: 'personal-' }))];
      },
    },
  };
  const Utilities = {
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    formatDate(date, tz, pattern) {
      if (pattern === 'yyyy-MM-dd') return localDate(date.getTime(), tz);
      if (pattern === "yyyy-MM-dd'T'HH:mmXXX") return localIso(date.getTime(), tz).replace(/\+00:00$/, 'Z');
      throw new Error(`pattern not faked: ${pattern}`);
    },
    computeDigest(alg, text, charset) {
      if (alg !== 'SHA_256' || charset !== 'UTF-8') throw new Error('digest not faked');
      return signed(createHash('sha256').update(String(text), 'utf8').digest());
    },
    computeHmacSha256Signature(value, key, charset) {
      if (charset !== 'UTF-8') throw new Error('charset not faked');
      return signed(createHmac('sha256', Buffer.from(String(key), 'utf8')).update(String(value), 'utf8').digest());
    },
    base64Encode: (bytes) => unsigned(bytes).toString('base64'),
    base64EncodeWebSafe: (bytes) => unsigned(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => signed(Buffer.from(String(s), 'base64')),
    newBlob: (data, contentType) => new FakeBlob(typeof data === 'string' ? Buffer.from(data, 'utf8') : unsigned(data), contentType),
    gzip: (blob) => new FakeBlob(gzipSync(blob.buf), 'application/x-gzip'),
    ungzip: (blob) => new FakeBlob(gunzipSync(blob.buf)),
    getUuid: () => randomUUID(),
    sleep: () => {},
  };
  const globals = {
    Utilities,
    SOURCE_CALENDAR_ID: 'SYNTHETIC-SOURCE-CALENDAR',
    TARGET_CALENDAR_ID: 'SYNTHETIC-TARGET-CALENDAR',
    SYNC_PROPERTY_KEY: 'SYNC_SOURCE_ID',
    HOTEL_SPREADSHEET_ID: 'SYNTHETIC-SHEET',
    HOTEL_SHEET_NAME: 'Hotels',
    getFlightStats: () => { spies.stats += 1; return { success: true, upcoming: [], marker: 'v5-payload' }; },
    CalendarApp: { getCalendarById: (id) => calendars[id] ?? null },
    SpreadsheetApp: { openById: () => { throw new Error('no sheet in tests'); } },
    PropertiesService: { getScriptProperties: () => scriptProps, getUserProperties: () => { spies.userStore += 1; return userProps; } },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cacheMap.has(k) ? cacheMap.get(k) : null),
        put: (k, v) => { cacheMap.set(k, String(v)); },
        removeAll: (keys) => { spies.cacheRemoved.push(...keys); keys.forEach((k) => cacheMap.delete(k)); },
      }),
    },
    LockService: {
      getScriptLock: () => {
        let mine = false;
        return {
          tryLock: () => {
            if (held) { spies.lock.nested += 1; return false; }        // non-reentrant: nesting is reported
            if (lockBusy) { spies.lock.refused += 1; return false; }
            held = true; mine = true; spies.lock.acquired += 1; return true;
          },
          releaseLock: () => { if (mine) { held = false; mine = false; } },
        };
      },
    },
    Session: {
      getEffectiveUser: () => {
        spies.session += 1;
        if (sessionThrows) throw new Error('no permission');
        return { getEmail: () => email ?? '' };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, mime: null, setMimeType(m) { this.mime = m; return this; } }),
    },
    UrlFetchApp: { fetch: () => { throw new Error('no network in tests'); } },
    console: {
      log: (...a) => spies.console.push(a.join(' ')), info: (...a) => spies.console.push(a.join(' ')),
      warn: (...a) => spies.console.push(a.join(' ')), error: (...a) => spies.console.push(a.join(' ')),
    },
    Logger: { log: (...a) => spies.console.push(a.join(' ')) },
  };
  return { globals, spies, scriptProps, userProps, cache: cacheMap };
}
