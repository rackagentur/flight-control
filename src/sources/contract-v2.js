// fc.roster v2 contract: identity, and a defensive shape check of backend responses.
// Anything that fails here makes the controller fall back to the v5 contract.
// The schema is documented in docs/CONTRACT-V2.md.

export const CONTRACT = 'fc.roster';
export const VERSION = 2;

const IATA = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVENANCE = new Set(['source', 'derived', 'inferred', 'unknown']);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const zoneOrNull = (v) => v === null || (typeof v === 'string' && v.length > 0);

/** Request body for an action. The token is only ever sent in the body. */
export function request(action, token, extra = {}) {
  return { contract: CONTRACT, version: VERSION, action, token, ...extra };
}

function fail(reason) {
  return { ok: false, reason };
}

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function validateRoster(p) {
  if (!p || typeof p !== 'object') return fail('not-an-object');
  if (p.ok !== true) return fail(typeof p.error === 'string' ? p.error : 'backend-refused');
  if (p.contract !== CONTRACT || p.version !== VERSION) return fail('contract-mismatch');
  if (p.action !== 'roster') return fail('wrong-action');
  if (!p.coverage || !DATE.test(p.coverage.from ?? '') || !DATE.test(p.coverage.to ?? '') || !Array.isArray(p.coverage.days)) return fail('bad-coverage');
  for (const key of ['events', 'sectors', 'duties', 'windows', 'stays']) if (!Array.isArray(p[key])) return fail(`missing-${key}`);
  for (const s of p.sectors) {
    if (typeof s?.id !== 'string' || typeof s.flightNumber !== 'string' || !IATA.test(s.origin ?? '') || !IATA.test(s.destination ?? '')) return fail('bad-sector');
    if (!finite(s.dep) || !finite(s.arr) || s.arr <= s.dep || !zoneOrNull(s.originTz) || !zoneOrNull(s.destTz)) return fail('bad-sector');
    if (!PROVENANCE.has(s.provenance)) return fail('bad-provenance');
  }
  for (const d of p.coverage.days) {
    if (!DATE.test(d?.date ?? '') || !['rostered', 'empty', 'unpublished'].includes(d.state) || !Array.isArray(d.codes)) return fail('bad-day');
  }
  for (const w of p.windows) if (!['standby', 'reserve'].includes(w?.kind) || !finite(w.start) || !finite(w.end)) return fail('bad-window');
  for (const e of p.events) if (typeof e?.id !== 'string' || typeof e.kind !== 'string' || !finite(e.start) || !finite(e.end)) return fail('bad-event');
  for (const h of p.stays) {
    if (!finite(h?.from) || !(h.to === null || finite(h.to)) || !(h.airport === null || IATA.test(h.airport))) return fail('bad-stay');
    if (h.provenance !== 'source') return fail('bad-provenance');
  }
  return { ok: true };
}

export function validateHistory(p) {
  if (!p || typeof p !== 'object') return fail('not-an-object');
  if (p.ok !== true) return fail(typeof p.error === 'string' ? p.error : 'backend-refused');
  if (p.contract !== CONTRACT || p.version !== VERSION || p.action !== 'history') return fail('contract-mismatch');
  if (!Array.isArray(p.sectors)) return fail('missing-sectors');
  return { ok: true };
}
