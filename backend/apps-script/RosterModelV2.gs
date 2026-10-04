// ============================================================================
// FLIGHT CONTROL ROSTER CONTRACT V2 — MODEL (airline-independent, pure)
// ============================================================================
// Builds the fc.roster v2 payload from normalized source events (see the source
// adapter). No Apps Script services are used here: time-zone formatting, hashing
// and the hotel lookup are injected (`deps`), so the model is unit-tested in Node.
//
// Provenance (never upgraded):
//   source   stated by the airline feed
//   derived  computed mechanically from source facts (zones, local times, grouping)
//   unknown  not provable from the data
// The backend never infers layovers or OFF; the frontend keeps its conservative rules.
// All names end in "_" (not callable through google.script.run).
// ============================================================================

const FCV2_CONTRACT_ = 'fc.roster';
const FCV2_VERSION_ = 2;
const FCV2_DAY_MS_ = 86400000;
const FCV2_DUTY_GAP_MS_ = 6 * 3600000;       // ground gap that splits two duties
const FCV2_CHECKIN_LEAD_MS_ = 4 * 3600000;   // a check-in belongs to a departure at most 4 h later
const FCV2_PICKUP_LEAD_MS_ = 3 * 3600000;    // a pickup belongs to a check-in at most 3 h later
const FCV2_HISTORY_MAX_MONTHS_ = 13;
const FCV2_HISTORY_MAX_SECTORS_ = 2000;
const FCV2_WINDOW_MAX_DAYS_ = 100;

/** 'YYYY-MM-DD' arithmetic in UTC (dates are labels, not instants). */
function fcv2AddDays_(key, n) {
  const p = key.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}
function fcv2DiffDays_(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / FCV2_DAY_MS_);
}
function fcv2IsDateKey_(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
}

function fcv2Id_(prefix, sourceId, deps) {
  return prefix + '_' + deps.hash(String(sourceId)).slice(0, 16);
}

/** Local dates (base zone) an event belongs to: every date whose local noon lies inside it. */
function fcv2EventDates_(ev, tz, deps) {
  const first = deps.localDate(ev.start, tz);
  const last = deps.localDate(Math.max(ev.start, ev.end - 1), tz);
  const out = [];
  for (let d = first; d <= last; d = fcv2AddDays_(d, 1)) out.push(d);
  return out;
}

function fcv2Sector_(ev, deps, warnings) {
  const f = ev.flight;
  const originTz = deps.tzOf(f.origin);
  const destTz = deps.tzOf(f.destination);
  [[f.origin, originTz], [f.destination, destTz]].forEach(function (pair) {
    if (!pair[1]) warnings.push({ code: 'unknown-airport', message: pair[0] + ' is not in the airport table; its local times are not given.' });
  });
  const aircraft = ev.aircraft && typeof ev.aircraft.typeCode === 'string' && /^[0-9A-Z]{3}$/.test(ev.aircraft.typeCode)
    ? { typeCode: ev.aircraft.typeCode, registration: typeof ev.aircraft.registration === 'string' && /^[A-Z0-9-]{4,8}$/.test(ev.aircraft.registration) ? ev.aircraft.registration : null, provenance: 'source' }
    : null;
  return {
    id: fcv2Id_('s', ev.sourceId, deps),
    eventId: fcv2Id_('e', ev.sourceId, deps),
    flightNumber: f.number,
    origin: f.origin,
    destination: f.destination,
    dep: ev.start,
    arr: ev.end,
    originTz: originTz,
    destTz: destTz,
    depLocal: originTz ? deps.localIso(ev.start, originTz) : null,
    arrLocal: destTz ? deps.localIso(ev.end, destTz) : null,
    dayShift: originTz && destTz ? fcv2DiffDays_(deps.localDate(ev.start, originTz), deps.localDate(ev.end, destTz)) : null,
    blockMin: Math.round((ev.end - ev.start) / 60000),
    aircraft: aircraft,
    provenance: 'source',
    zoneProvenance: originTz && destTz ? 'derived' : 'unknown',
    basis: ev.basis,
  };
}

/** Duties: consecutive flights with a short, continuous ground gap; check-in and pickup attached. */
function fcv2Duties_(flights, checkins, pickups, deps) {
  const duties = [];
  let current = null;
  flights.forEach(function (ev) {
    const prev = current && current.flights[current.flights.length - 1];
    const continues = prev && ev.start - prev.end >= 0 && ev.start - prev.end <= FCV2_DUTY_GAP_MS_ && prev.flight.destination === ev.flight.origin;
    if (!continues) { current = { flights: [] }; duties.push(current); }
    current.flights.push(ev);
  });
  return duties.map(function (d) {
    const first = d.flights[0];
    const last = d.flights[d.flights.length - 1];
    const checkin = checkins.filter(function (c) { return c.start <= first.start && first.start - c.start <= FCV2_CHECKIN_LEAD_MS_; }).pop() || null;
    const anchor = checkin ? checkin.start : first.start;
    const pickup = pickups.filter(function (p) { return p.start <= anchor && anchor - p.start <= FCV2_PICKUP_LEAD_MS_; }).pop() || null;
    return {
      id: fcv2Id_('d', first.sourceId, deps),
      kind: 'flight',
      sectorIds: d.flights.map(function (f) { return fcv2Id_('s', f.sourceId, deps); }),
      report: checkin ? { at: checkin.start, eventId: fcv2Id_('e', checkin.sourceId, deps), provenance: 'source', association: 'derived' } : null,
      pickup: pickup ? { at: pickup.start, eventId: fcv2Id_('e', pickup.sourceId, deps), provenance: 'source', association: 'derived' } : null,
      start: pickup ? pickup.start : checkin ? checkin.start : first.start,
      end: last.end,
      provenance: 'derived',
    };
  });
}

/**
 * Stays from roster hotel blocks (source evidence that a stay exists). Never creates
 * sectors or rotations. Flight blocks: the stay is at that flight's destination
 * (source); it ends at the next listed departure from there (derived) or is open.
 * Standby/reserve blocks: the airport is derived from the previous arrival, or unknown.
 */
function fcv2Stays_(events, flights, deps, warnings, homeBases) {
  const stays = [];
  const home = homeBases || [];
  function hotelOf(ev, airport) {
    const verified = deps.hotelLookup ? deps.hotelLookup(ev.sourceId, ev.hotel.name, airport) : null;
    return {
      name: ev.hotel.name, address: ev.hotel.address, phone: ev.hotel.phone, provenance: 'source',
      location: verified ? { lat: verified.lat, lon: verified.lon, mapsUrl: verified.mapsUrl, placeId: verified.placeId, status: 'verified', provenance: 'derived' } : null,
    };
  }
  flights.forEach(function (ev) {
    if (!ev.hotel) return;
    const airport = ev.flight.destination;
    // A hotel at a home base is not an away-from-base stay (no layover at home).
    if (home.indexOf(airport) >= 0) { warnings.push({ code: 'hotel-at-home-base', message: 'A roster hotel at the home base ' + airport + ' is not treated as a stay.' }); return; }
    const next = flights.filter(function (f) { return f.start >= ev.end; })[0] || null;
    const fromHere = next && next.flight.origin === airport ? next : null;
    if (next && !fromHere) warnings.push({ code: 'stay-itinerary-gap', message: 'A roster hotel at ' + airport + ' is followed by a departure from ' + next.flight.origin + '; the stay end is unknown.' });
    stays.push({
      id: fcv2Id_('h', ev.sourceId, deps), airport: airport, airportProvenance: 'source',
      from: ev.end, to: fromHere ? fromHere.start : null, endProvenance: fromHere ? 'derived' : 'unknown',
      provenance: 'source', basis: 'hotel-block', evidenceEventIds: [fcv2Id_('e', ev.sourceId, deps)],
      hotel: hotelOf(ev, airport),
    });
  });
  events.filter(function (ev) { return (ev.kind === 'standby' || ev.kind === 'reserve') && ev.hotel; }).forEach(function (ev) {
    // Absorbed only into a stay with a known end that covers it and names the same hotel.
    const covering = stays.filter(function (s) { return s.to !== null && s.from <= ev.start && s.to >= ev.end && s.hotel.name === ev.hotel.name; })[0];
    if (covering) { covering.evidenceEventIds.push(fcv2Id_('e', ev.sourceId, deps)); return; }
    const before = flights.filter(function (f) { return f.end <= ev.start; }).pop() || null;
    const departedSince = before && flights.some(function (f) { return f.start >= before.end && f.start < ev.start; });
    let airport = before && !departedSince ? before.flight.destination : null;
    if (airport && home.indexOf(airport) >= 0) airport = null;
    stays.push({
      id: fcv2Id_('h', ev.sourceId, deps), airport: airport, airportProvenance: airport ? 'derived' : 'unknown',
      from: ev.start, to: ev.end, endProvenance: 'source',
      provenance: 'source', basis: 'hotel-block', evidenceEventIds: [fcv2Id_('e', ev.sourceId, deps)],
      hotel: hotelOf(ev, airport),
    });
  });
  return stays.sort(function (a, b) { return a.from - b.from; });
}

/**
 * @param {{events: object[], from: string, to: string, segments: {from:string,to:string,basis:string}[], now: number,
 *          config: {adapter:string, baseTimeZone:string}}} input   events from fcv2ClassifyEvent_
 * @param {{hash:Function, localIso:Function, localDate:Function, tzOf:Function, hotelLookup?:Function}} deps
 */
function fcv2BuildRoster_(input, deps) {
  const tz = input.config.baseTimeZone;
  const warnings = [];
  const events = input.events.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  const flights = events.filter(function (e) { return e.kind === 'flight'; });
  const checkins = events.filter(function (e) { return e.kind === 'checkin'; });
  const pickups = events.filter(function (e) { return e.kind === 'pickup'; });
  const unknown = events.filter(function (e) { return e.kind === 'unknown'; });
  if (unknown.length) warnings.push({ code: 'unknown-code', message: unknown.length + ' roster event(s) with an unrecognised code are kept as unknown.' });

  const sectors = flights.map(function (ev) { return fcv2Sector_(ev, deps, warnings); });
  const duties = fcv2Duties_(flights, checkins, pickups, deps);
  const stays = fcv2Stays_(events, flights, deps, warnings, input.config.homeBases);
  const windows = events.filter(function (e) { return e.kind === 'standby' || e.kind === 'reserve'; }).map(function (e) {
    return { kind: e.kind, code: e.code, start: e.start, end: e.end, eventId: fcv2Id_('e', e.sourceId, deps), provenance: 'source' };
  });

  // Day coverage in the base zone. An empty day is never OFF: only explicit day codes are.
  const byDate = {};
  events.forEach(function (ev) {
    fcv2EventDates_(ev, tz, deps).forEach(function (d) { (byDate[d] = byDate[d] || []).push(ev); });
  });
  const feed = input.segments.filter(function (s) { return s.basis === 'airline-feed'; })[0] || null;
  // The roster is "published" through the last day with a roster item other than leave
  // (leave can be booked far ahead of publication).
  const feedDates = Object.keys(byDate).filter(function (d) {
    return feed && d >= feed.from && d <= feed.to && byDate[d].some(function (e) { return !(e.kind === 'off' && e.subtype === 'leave'); });
  }).sort();
  const lastRosteredDate = feedDates.length ? feedDates[feedDates.length - 1] : null;
  const days = [];
  for (let d = input.from; d <= input.to; d = fcv2AddDays_(d, 1)) {
    const list = byDate[d] || [];
    const inFeed = feed && d >= feed.from && d <= feed.to;
    const state = list.length ? 'rostered' : inFeed && (!lastRosteredDate || d > lastRosteredDate) ? 'unpublished' : 'empty';
    const codes = list.filter(function (e) { return e.kind === 'off'; }).map(function (e) {
      return { kind: 'off', subtype: e.subtype, code: e.code, protected: e.protected, eventId: fcv2Id_('e', e.sourceId, deps), provenance: 'source' };
    });
    days.push({ date: d, state: state, codes: codes });
  }

  return {
    ok: true,
    contract: FCV2_CONTRACT_,
    version: FCV2_VERSION_,
    action: 'roster',
    generatedAt: input.now,
    source: { adapter: input.config.adapter, baseTimeZone: tz, segments: input.segments },
    capabilities: {
      sectors: true, reportTime: true, pickups: true, standby: true, reserve: true,
      explicitOff: true, protectedOff: true, leave: true, stays: 'hotel-block', hotels: true,
      aircraft: true, rotations: false, history: true,
    },
    coverage: { from: input.from, to: input.to, lastRosteredDate: lastRosteredDate, days: days },
    events: events.map(function (e) {
      return {
        id: fcv2Id_('e', e.sourceId, deps), kind: e.kind, subtype: e.subtype, code: e.code, title: e.title,
        start: e.start, end: e.end, location: e.location, protected: e.protected, provenance: 'source', basis: e.basis,
      };
    }),
    sectors: sectors,
    duties: duties,
    windows: windows,
    stays: stays,
    rotations: [],
    warnings: warnings,
  };
}

/** Bounded history of my own flown sectors (synced copy). */
function fcv2BuildHistory_(input, deps) {
  const flights = input.events.filter(function (e) { return e.kind === 'flight' && e.end <= input.now; })
    .sort(function (a, b) { return a.start - b.start; });
  const truncated = flights.length > FCV2_HISTORY_MAX_SECTORS_;
  const kept = truncated ? flights.slice(-FCV2_HISTORY_MAX_SECTORS_) : flights;
  return {
    ok: true, contract: FCV2_CONTRACT_, version: FCV2_VERSION_, action: 'history', generatedAt: input.now,
    source: { adapter: input.config.adapter, basis: 'synced-copy' },
    range: { from: input.from, to: input.to }, truncated: truncated,
    sectors: kept.map(function (ev) {
      const s = fcv2Sector_(ev, deps, []);
      return {
        id: s.id, flightNumber: s.flightNumber, origin: s.origin, destination: s.destination, dep: s.dep, arr: s.arr,
        originTz: s.originTz, destTz: s.destTz, blockMin: s.blockMin, provenance: 'source', basis: 'synced-copy',
      };
    }),
  };
}

/** Validates a requested range. Returns {from, to} or {error}. maxMonths: calendar months touched. */
function fcv2Range_(from, to, maxDays, maxMonths) {
  if (!fcv2IsDateKey_(from) || !fcv2IsDateKey_(to) || to < from) return { error: 'bad-range' };
  if (maxDays && fcv2DiffDays_(from, to) + 1 > maxDays) return { error: 'range-too-long' };
  if (maxMonths) {
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    if (months > maxMonths) return { error: 'range-too-long' };
  }
  return { from: from, to: to };
}
