// SYNTHETIC ONLY: in-memory provider-shaped fixtures. No HTTP client or provider credential.
// Existing flight/departures handlers validate and normalize these just as they do live responses.
// The requested URL is only a selector; it is NEVER fetched.
function fctProvider_(url, now, mode = 'gates') {
  if (mode === 'provider-error') return { status: 503, body: '{}' };
  const shift = fctShift_(now);
  const flights = FCT_DATA_.feed.map(function (event) {
    const match = /^(DE\d+) ([A-Z]{3})-([A-Z]{3})$/.exec(event.title);
    if (!match) return null;
    const dep = event.start + shift, arr = event.end + shift;
    const missing = mode === 'missing';
    return {
      number: match[1], status: missing ? 'Scheduled' : 'Delayed',
      lastUpdatedUtc: new Date(now - 60000).toISOString(),
      airline: { iata: 'DE', name: 'Synthetic Air' },
      departure: {
        airport: { iata: match[2] }, scheduledTime: { utc: new Date(dep).toISOString(), local: fcv2LocalIso_(dep, FCV2_AIRPORT_TZ_[match[2]]) },
        revisedTime: missing ? null : { utc: new Date(dep + 20 * 60000).toISOString() },
        terminal: missing ? null : '1', gate: missing ? null : 'A 24',
        quality: ['Basic', 'Live'],
      },
      arrival: {
        airport: { iata: match[3] }, scheduledTime: { utc: new Date(arr).toISOString() },
        terminal: missing ? null : 'B', gate: missing ? null : '12',
        quality: missing ? ['Basic'] : ['Basic', 'Live'],
      },
    };
  }).filter(Boolean);
  const flight = /\/flights\/number\/([^/]+)\//.exec(url);
  if (flight) return { status: 200, body: JSON.stringify(mode === 'not-found' ? [] : flights.filter(function (f) { return f.number === flight[1]; })) };
  const airport = /\/flights\/airports\/iata\/([A-Z]{3})\//.exec(url);
  if (!airport) return { status: 400, body: '{}' };
  const departures = flights.filter(function (f) { return f.departure.airport.iata === airport[1]; }).map(function (f) {
    return { number: f.number, status: f.status, airline: f.airline,
      movement: { airport: f.arrival.airport, scheduledTime: f.departure.scheduledTime, revisedTime: f.departure.revisedTime } };
  });
  // Explicit invented Radar flights within each fixture standby window, not guessed real flights.
  FCT_DATA_.radar.forEach(function (f) {
    if (f.origin !== airport[1]) return;
    departures.push({ number: f.number, status: mode === 'missing' ? null : 'Expected', airline: { iata: 'DE' },
      movement: { airport: mode === 'missing' ? {} : { iata: f.destination, name: 'Sample destination' },
        scheduledTime: { utc: new Date(f.dep + shift).toISOString() } } });
  });
  return { status: 200, body: JSON.stringify({ departures: mode === 'not-found' ? [] : departures }) };
}
