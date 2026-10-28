// Condor airline pack: Condor's own terminology for the generic day model, plus its raw roster
// codes (roster-codes.js). Wording (terminology) and raw codes stay separate.

import { CONDOR_ROSTER_CODES, CONDOR_FLIGHT_DESIGNATORS } from './roster-codes.js';
import { presentCrew, formatCrewRoute, CONDOR_CREW_RANKS } from './crew.js';
import { CONDOR_CREW_COPY } from './crew-copy.js';

/** @type {import('../types.js').AirlineProfile} */
export const CONDOR = {
  id: 'condor',
  name: 'Condor',
  iata: 'DE',
  flightDesignators: CONDOR_FLIGHT_DESIGNATORS,
  rosterCodes: CONDOR_ROSTER_CODES,
  // Crew Intelligence (Stage B): presentation (verified rank map only, currently empty: D7) and copy pack.
  // Packs without `crew` never show Crew Intelligence.
  crew: {
    present: (members) => presentCrew(members, { ranks: CONDOR_CREW_RANKS }),
    route: formatCrewRoute,
    copy: CONDOR_CREW_COPY,
  },
  terminology: {
    offSubtype: {
      off: { short: 'OFF', name: 'Off day' },
      free: { short: 'FREE', name: 'Free day' },
      // Urlaub: the roster code itself (U) in compact places (calendar cell, key, 7-day strip).
      leave: { short: 'U', cell: 'U', name: 'Urlaub', lede: 'Holiday' },
      ort: { short: 'ORT', name: 'Protected free day', detail: 'ORT, protected' },
    },
    protectedLegend: 'ORT · protected free day',
    protectedEyebrow: 'ORT · from roster',
    protectedReason: 'The roster lists today as a protected free day (ORT): assigned by the company and not reassignable.',
    // Strichtag: the roster code itself (ASCII hyphen-minus "-") in compact places. Still an
    // unassigned day, not a guaranteed day off.
    unassigned: {
      short: 'Strichtag',
      cell: '-',
      name: 'Strichtag',
      legend: '- · Strichtag · no duty assigned',
      lede: 'No duty assigned',
      reason: 'The roster lists today as a Strichtag: no duty is assigned. This is not a day off.',
      summary: 'Strichtage',
    },
  },
};
