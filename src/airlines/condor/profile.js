// Condor airline pack: Condor's own terminology for the generic day model.
// (Later phases add Condor's rules here; today it carries wording only.)

/** @type {import('../types.js').AirlineProfile} */
export const CONDOR = {
  id: 'condor',
  name: 'Condor',
  iata: 'DE',
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
  },
};
