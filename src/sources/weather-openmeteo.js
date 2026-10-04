// Weather provider: Open-Meteo daily forecast, fetched directly from the browser with the
// airport's coordinates (Phase 6 decision D1, as v5 did). No API key, nothing personal: the
// request carries only latitude, longitude and the requested fields.
// Never blocks the UI: lookup() answers synchronously from memory ('loading' while a request
// is in flight) and calls onUpdate when a result arrives. Failures become 'unavailable'.
// Results live in memory only; nothing is written to storage. Review mode never uses this.

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const TTL_MS = 60 * 60000;           // a forecast is reused for an hour
const RETRY_AFTER_ERROR_MS = 5 * 60000;
const TIMEOUT_MS = 8000;

/** WMO weather interpretation codes → plain text. */
const WMO = [
  [[0], 'Clear'], [[1], 'Mainly clear'], [[2], 'Partly cloudy'], [[3], 'Overcast'],
  [[45, 48], 'Fog'], [[51, 53, 55], 'Drizzle'], [[56, 57], 'Freezing drizzle'],
  [[61, 63, 65], 'Rain'], [[66, 67], 'Freezing rain'], [[71, 73, 75], 'Snow'], [[77], 'Snow grains'],
  [[80, 81, 82], 'Rain showers'], [[85, 86], 'Snow showers'], [[95], 'Thunderstorm'], [[96, 99], 'Thunderstorm with hail'],
];
export function describeWeatherCode(code) {
  return WMO.find(([codes]) => codes.includes(code))?.[1] ?? null;
}

export function forecastUrl(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: 'weathercode,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '10',
  });
  return `${ENDPOINT}?${params}`;
}

/** Defensive parse: only days with a valid date and numeric temperatures are kept. */
export function parseForecast(json) {
  const daily = json?.daily;
  const days = new Map();
  if (!daily || !Array.isArray(daily.time)) return days;
  daily.time.forEach((date, i) => {
    const max = daily.temperature_2m_max?.[i];
    const min = daily.temperature_2m_min?.[i];
    const code = daily.weathercode?.[i];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (!Number.isFinite(max) || !Number.isFinite(min)) return;
    days.set(date, { date, max: Math.round(max), min: Math.round(min), code: Number.isInteger(code) ? code : null, text: describeWeatherCode(code) });
  });
  return days;
}

export function createWeather({ fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now(), onUpdate = () => {}, timeoutMs = TIMEOUT_MS } = {}) {
  const cache = new Map();

  async function load(key, lat, lon) {
    // While refreshing, the previous forecast (if any) stays available.
    const previous = cache.get(key);
    cache.set(key, { status: 'loading', at: now(), days: previous?.status === 'ok' || previous?.status === 'loading' ? previous.days : new Map() });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      if (!fetchImpl) throw new Error('fetch unavailable');
      const response = await fetchImpl(forecastUrl(lat, lon), { signal: controller?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
      const days = parseForecast(await response.json());
      if (!days.size) throw new Error('empty forecast');
      cache.set(key, { status: 'ok', at: now(), days });
    } catch {
      cache.set(key, { status: 'error', at: now(), days: new Map() });
    } finally {
      clearTimeout(timer);
      try { onUpdate(); } catch { /* a render error must not break the provider */ }
    }
  }

  return {
    /**
     * @param {object} query  from model/destination.weatherQuery()
     * @returns {{status:'ok', date, max, min, text, source}|{status:'loading'}|{status:'later', availableFrom}|{status:'unavailable', reason}}
     */
    lookup(query) {
      if (!query) return { status: 'unavailable', reason: 'no-destination' };
      if (query.status !== 'query') return query;
      const key = `${query.lat.toFixed(3)},${query.lon.toFixed(3)}`;
      const entry = cache.get(key);
      const stale = entry && entry.status !== 'loading' && now() - entry.at > (entry.status === 'error' ? RETRY_AFTER_ERROR_MS : TTL_MS);
      if (!entry || stale) load(key, query.lat, query.lon);
      const current = cache.get(key);
      if (current.status === 'loading') {
        const kept = current.days.get(query.date);
        return kept ? { status: 'ok', ...kept, source: 'Open-Meteo' } : { status: 'loading' };
      }
      if (current.status === 'error') return { status: 'unavailable', reason: 'error' };
      const fresh = current.days.get(query.date);
      return fresh ? { status: 'ok', ...fresh, source: 'Open-Meteo' } : { status: 'unavailable', reason: 'not-in-forecast' };
    },
  };
}
