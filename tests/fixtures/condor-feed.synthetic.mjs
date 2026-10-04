// SYNTHETIC airline duty-plan feed (Condor calendar shape) for the fc.roster v2 tests.
// All flight numbers, registrations, hotels, phone numbers and ids are invented. The
// structure mirrors the read-only source inventory (docs/CONTRACT-V2.md): timed events,
// day codes as 24 h events at local midnight (Europe/Berlin), check-in / pickup events,
// hotel blocks and an aircraft line inside descriptions.
// Crew-list lines are NOT stored here: tests add crew-shaped lines at runtime to prove
// they never reach the output.

export const NOW = Date.parse('2026-10-04T08:00:00Z');
export const BASE_TZ = 'Europe/Berlin';

const z = (iso) => Date.parse(iso);
// A whole local Berlin day as the feed encodes it (22:00Z before, or 23:00Z in winter).
const day = (fromIso, toIso) => ({ start: z(fromIso), end: z(toIso) });

const hotel = (name, street, city, phone) => `Hotel\n${name}\n${street}\n${city}\n${phone}`;
const airportLines = (a, b) => `${a} SAMPLE AIRPORT ${a}\n${b ? `${b} SAMPLE AIRPORT ${b}\n` : ''}`;

let n = 0;
const ev = (basis, title, start, end, { location = null, description = '' } = {}) => ({
  sourceId: `src-${basis}-${String(++n).padStart(3, '0')}`, title, start, end, location, description, basis,
});

/** Events the synced copy holds before today (titles carry the sync prefix). */
export function syncedEvents() {
  n = 100;
  return [
    ev('synced-copy', '✈️✈️✈️ DE9101 FRA-YYZ', z('2026-09-20T08:00:00Z'), z('2026-09-20T16:40:00Z'), {
      location: 'FRA - YYZ', description: `✈️ FLIGHT DETAILS\n\n---\nOriginal Notes:\n${airportLines('FRA', 'YYZ')}\nDTEST (339)\n\nBooking code: SAMPLE1\n\n${hotel('Sample Lakeside Hotel', '1 Sample Road', 'Mississauga', '+1 555 0100')}`,
    }),
    ev('synced-copy', '✈️✈️✈️ DE9102 YYZ-FRA', z('2026-09-22T22:00:00Z'), z('2026-09-23T05:30:00Z'), { location: 'YYZ - FRA' }),
    ev('synced-copy', 'ORT', ...Object.values(day('2026-09-24T22:00:00Z', '2026-09-25T22:00:00Z')), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nORTSTAG' }),
  ];
}

/** Events the airline feed holds from today on. */
export function feedEvents() {
  n = 0;
  return [
    ev('airline-feed', 'ORT', ...Object.values(day('2026-10-03T22:00:00Z', '2026-10-04T22:00:00Z')), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nORTSTAG' }),
    ev('airline-feed', 'OFF', ...Object.values(day('2026-10-04T22:00:00Z', '2026-10-05T22:00:00Z')), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nOff Day (sample)' }),
    ev('airline-feed', '-', ...Object.values(day('2026-10-05T22:00:00Z', '2026-10-06T22:00:00Z')), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nFreier Tag' }),
    // Long-haul out with a hotel block and aircraft; return two days later with an outstation pickup.
    ev('airline-feed', 'C/I', z('2026-10-08T06:30:00Z'), z('2026-10-08T08:00:00Z'), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nCheck-in' }),
    ev('airline-feed', 'DE9201 FRA-BKK', z('2026-10-08T08:00:00Z'), z('2026-10-08T19:00:00Z'), {
      location: 'FRA - BKK', description: `${airportLines('FRA', 'BKK')}\nDABCD (339)\n\nBooking code: SAMPLE2\n\n${hotel('Sample Riverside Hotel', '99 Sample Street', 'Bangkok', '+66 2 000 0000')}`,
    }),
    ev('airline-feed', 'P/U', z('2026-10-10T15:20:00Z'), z('2026-10-10T16:00:00Z'), { location: 'BKK', description: 'Pick up\nBKK SAMPLE AIRPORT BKK' }),
    ev('airline-feed', 'C/I', z('2026-10-10T16:00:00Z'), z('2026-10-10T17:30:00Z'), { location: 'BKK', description: 'BKK SAMPLE AIRPORT BKK\n\nCheck-in' }),
    ev('airline-feed', 'DE9202 BKK-FRA', z('2026-10-10T17:30:00Z'), z('2026-10-11T05:00:00Z'), { location: 'BKK - FRA', description: `${airportLines('BKK', 'FRA')}\nDABCD (339)` }),
    // Short-haul out without a hotel block, then an outstation standby with a hotel block.
    ev('airline-feed', 'C/I', z('2026-10-12T05:00:00Z'), z('2026-10-12T06:00:00Z'), { location: 'FRA' }),
    ev('airline-feed', 'DE9203 FRA-BER', z('2026-10-12T06:00:00Z'), z('2026-10-12T07:05:00Z'), { location: 'FRA - BER', description: `${airportLines('FRA', 'BER')}\nDEFGH (32N)` }),
    ev('airline-feed', 'SB90', z('2026-10-13T02:55:00Z'), z('2026-10-13T14:55:00Z'), { description: hotel('Sample Airport Hotel', '3 Sample Square', 'Sample Town', '+49 30 0000000') }),
    ev('airline-feed', 'C/I', z('2026-10-14T13:40:00Z'), z('2026-10-14T14:55:00Z'), { location: 'BER' }),
    ev('airline-feed', 'DE9204 BER-FRA', z('2026-10-14T14:55:00Z'), z('2026-10-14T16:05:00Z'), { location: 'BER - FRA', description: 'BER SAMPLE AIRPORT BER\nFRA SAMPLE AIRPORT FRA\n\nD-ABC (3)' }),
    ev('airline-feed', 'XYZ7', z('2026-10-15T08:00:00Z'), z('2026-10-15T12:00:00Z'), { location: 'FRA', description: 'Sample unknown duty' }),
    ev('airline-feed', 'RE5', z('2026-10-16T02:55:00Z'), z('2026-10-16T13:00:00Z')),
    // 17–23 Oct: nothing rostered (never OFF).
    // Leave across the DST change (25 Oct: a 25 h local day).
    ev('airline-feed', 'U', ...Object.values(day('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z')), { location: 'FRA', description: 'FRA SAMPLE AIRPORT FRA\n\nUrlaub' }),
    // A flight to an airport the table does not know.
    ev('airline-feed', 'DE9205 FRA-QQQ', z('2026-10-26T09:00:00Z'), z('2026-10-26T11:00:00Z'), { location: 'FRA - QQQ' }),
  ];
}

/** Hotel Sheet rows (structured schema: 20 columns). Only the first is VERIFIED for its stay. */
export function hotelRows(feed) {
  const bkkOut = feed.find((e) => e.title === 'DE9201 FRA-BKK');
  const row = (name, dest, lat, lon, maps, sources, placeId, status) => {
    const r = new Array(20).fill('');
    Object.assign(r, { 0: name, 1: dest, 2: 'sample address', 3: '+00 0', 4: lat, 5: lon, 6: maps, 10: sources, 11: placeId, 12: status });
    return r;
  };
  return [
    row('Sample Riverside Hotel', 'BKK', 13.7, 100.5, 'https://maps.example.invalid/riverside', `other-id | ${bkkOut.sourceId}`, 'place-sample-1', 'VERIFIED'),
    row('Sample Airport Hotel', 'BER', 52.39, 13.52, 'https://maps.example.invalid/airport', 'unrelated-id', 'place-sample-2', 'VERIFIED'),
    row('Sample Lakeside Hotel', 'YYZ', 43.6, -79.6, 'https://maps.example.invalid/lakeside', 'src-synced-copy-101', 'place-sample-3', 'REVIEW'),
  ];
}
