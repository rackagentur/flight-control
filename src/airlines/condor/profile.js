// Condor airline pack: Condor's own terminology for the generic day model, plus its raw roster
// codes (roster-codes.js). Wording (terminology) and raw codes stay separate.

import { CONDOR_ROSTER_CODES, CONDOR_FLIGHT_DESIGNATORS } from './roster-codes.js';

/** @type {import('../types.js').AirlineProfile} */
export const CONDOR = {
  id: 'condor',
  name: 'Condor',
  iata: 'DE',
  flightDesignators: CONDOR_FLIGHT_DESIGNATORS,
  rosterCodes: CONDOR_ROSTER_CODES,
  terminology: {
    offSubtype: {
      off: { short: 'OFF', name: 'Off day' },
      free: { short: 'FREE', name: 'Free day' },
      leave: { short: 'LEAVE', name: 'Leave' },
      ort: { short: 'ORT', name: 'Protected free day', detail: 'ORT, protected' },
    },
    protectedLegend: 'ORT · protected free day',
    protectedEyebrow: 'ORT · from roster',
    protectedReason: 'The roster lists today as a protected free day (ORT): assigned by the company and not reassignable.',
    unassigned: {
      short: 'STRICHTAG',
      name: 'Strichtag',
      legend: 'STRICHTAG · unassigned day, not off',
      reason: 'The roster lists today as STRICHTAG: no duty is assigned. This is not a day off.',
      summary: 'Strichtag',
    },
  },
};
