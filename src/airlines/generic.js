// Neutral fallback airline profile: used when no airline pack is selected or the id is unknown.
// Airline-neutral wording only; airline-specific terms live in their own pack.

/** @type {import('./types.js').AirlineProfile} */
export const GENERIC = {
  id: 'generic',
  name: 'Generic',
  iata: null,
  terminology: {
    offSubtype: {
      off: { short: 'OFF', name: 'Off day' },
      free: { short: 'FREE', name: 'Free day' },
      leave: { short: 'LEAVE', name: 'Leave' },
      ort: { short: 'PROT', name: 'Protected free day' },
    },
    protectedLegend: 'PROT · protected free day',
    protectedEyebrow: 'PROT · from roster',
    protectedReason: 'The roster lists today as a protected free day: assigned by the company and not reassignable.',
    unassigned: {
      short: 'UNASG',
      name: 'Unassigned day',
      legend: 'Unassigned · no duty yet, not off',
      reason: 'The roster lists today as unassigned: no duty is assigned. This is not a day off.',
      summary: 'unassigned',
    },
  },
};
