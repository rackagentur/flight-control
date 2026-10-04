// Transport for the Flight Control Apps Script backend (existing v5 contract, unchanged).
// The endpoint URL is runtime configuration entered by the user and stored only in their
// browser; it is never committed. Requests are CORS "simple requests" (GET, no custom
// headers) so no preflight is needed. Read-only in Phase 4: only `getStats` is called.

const ENDPOINT = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const DEFAULT_TIMEOUT_MS = 25000;

export class ApiError extends Error {
  /**
   * @param {'not-configured'|'invalid-endpoint'|'network'|'timeout'|'http'|'html-response'|'invalid-json'|'backend-error'} code
   */
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

/** Accepts only Apps Script web-app /exec URLs (no query string). */
export function validateEndpoint(value) {
  const url = String(value ?? '').trim();
  if (!url) return { ok: false, reason: 'Enter the web-app URL.' };
  if (!ENDPOINT.test(url)) return { ok: false, reason: 'Expected an Apps Script web-app URL ending in /exec.' };
  return { ok: true, url };
}

/**
 * GET ?action=getStats. Resolves to { data, meta } or throws ApiError.
 * @param {string} endpoint
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function fetchStats(endpoint, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint) throw new ApiError('not-configured', 'No roster source is configured.');
  const check = validateEndpoint(endpoint);
  if (!check.ok) throw new ApiError('invalid-endpoint', check.reason);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(`${check.url}?action=getStats`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('timeout', `No response within ${Math.round(timeoutMs / 1000)} s.`);
    // Browsers report CORS refusals and offline networks identically, as a TypeError.
    throw new ApiError('network', 'The roster backend could not be reached from this page (network or cross-origin policy).', error?.message ?? null);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const meta = { status: response.status, ms: Date.now() - started, bytes: text.length, contentType: response.headers.get('content-type') ?? '' };
  if (!response.ok) throw new ApiError('http', `The roster backend answered HTTP ${response.status}.`, meta);
  if (/^\s*</.test(text)) {
    // v5 returns an HTML error page when getFlightStats throws (legacy defect B9), and the
    // legacy wrapper would serve HTML if it ever shadowed v5's doGet.
    throw new ApiError('html-response', 'The roster backend returned a web page instead of data.', meta);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new ApiError('invalid-json', 'The roster backend returned unreadable data.', meta); }
  if (data?.success !== true) {
    throw new ApiError('backend-error', typeof data?.message === 'string' ? data.message : 'The roster backend reported an error.', meta);
  }
  return { data, meta };
}

/** Field paths the v5 contract promises (docs/AUDIT.md §4). Used by the connection test. */
export const V5_CONTRACT = [
  'today.dateStr', 'daysOff', 'upcoming', 'dutyBlock.current', 'dutyBlock.nextOffInDays', 'dutyBlock.maxThisMonth',
  'month.flights', 'month.hours', 'month.projectedHours', 'year.flights', 'year.hours', 'allTime.flights', 'allTime.hours',
  'map.airports', 'map.routes', 'achievements',
];
export const V5_SECTOR_CONTRACT = [
  'flightNumber', 'origin', 'destination', 'depTimestamp', 'endTimestamp', 'pickupTimestamp', 'daysUntil', 'duration',
];

function has(obj, path) {
  return path.split('.').every((key) => {
    if (obj === null || typeof obj !== 'object' || !(key in obj)) return false;
    obj = obj[key];
    return true;
  });
}

/** Lists contract fields missing from a payload (empty array = contract intact). */
export function contractGaps(data) {
  const missing = V5_CONTRACT.filter((path) => !has(data, path));
  const first = Array.isArray(data?.upcoming) ? data.upcoming[0] : null;
  if (first) missing.push(...V5_SECTOR_CONTRACT.filter((key) => !(key in first)).map((key) => `upcoming[].${key}`));
  return missing;
}

/**
 * fc.roster v2 (Phase 7): POST with Content-Type text/plain so the request stays a CORS
 * "simple request" (no preflight). The token travels in the body, never in the URL.
 * Resolves to { data, meta } with the parsed JSON (which may be {ok:false, error}); throws
 * ApiError for transport problems (network, timeout, HTTP error, HTML page, unreadable JSON).
 * @param {string} endpoint
 * @param {object} body  {contract, version, action, token, ...}
 */
export async function postContract(endpoint, body, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  if (!endpoint) throw new ApiError('not-configured', 'No roster source is configured.');
  const check = validateEndpoint(endpoint);
  if (!check.ok) throw new ApiError('invalid-endpoint', check.reason);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(check.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('timeout', `No response within ${Math.round(timeoutMs / 1000)} s.`);
    throw new ApiError('network', 'The roster backend could not be reached from this page (network or cross-origin policy).', error?.message ?? null);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const meta = { status: response.status, ms: Date.now() - started, bytes: text.length };
  if (!response.ok) throw new ApiError('http', `The roster backend answered HTTP ${response.status}.`, meta);
  // A deployment without doPost answers with an HTML error page.
  if (/^\s*</.test(text)) throw new ApiError('html-response', 'The roster backend does not offer the v2 contract.', meta);
  try { return { data: JSON.parse(text), meta }; } catch { throw new ApiError('invalid-json', 'The roster backend returned unreadable data.', meta); }
}
