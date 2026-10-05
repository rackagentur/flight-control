// ============================================================================
// FLIGHT CONTROL — WEB-APP GET ROUTER (backend hardening BH-1)
// ============================================================================
// The project's ONLY doGet. It serves the read-only v5 `getStats` contract unchanged and
// refuses every other GET (no action, sync, dashboard, dashboardPrev, the legacy ?function=
// wrapper, anything else) with a small JSON answer.
//
// It never returns an HtmlService page: Apps Script exposes google.script.run only to pages
// it serves itself, so without a page no server function is reachable from a browser.
// Scheduled work (sync, dashboards) keeps running from its time-driven triggers.
//
// Uses getFlightStats (defined in the existing web-app file) by NAME only.
// Every helper ends in "_" (not callable remotely). No top-level side effects.
// ============================================================================

const FCV2_GET_REFUSED_ = Object.freeze({ success: false, message: 'Not available.' });

function doGet(e) {
  const result = fcv2HandleGet_(e && e.parameter, { stats: function () { return getFlightStats(); } });
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Pure GET routing (tested in Node). Only ?action=getStats is served; the request's own
 * values are never echoed back.
 * @param {Object<string,string>|undefined} params  e.parameter
 * @param {{stats: function(): Object}} handlers
 */
function fcv2HandleGet_(params, handlers) {
  const action = params && typeof params.action === 'string' ? params.action : '';
  if (action === 'getStats') return handlers.stats();
  return FCV2_GET_REFUSED_;
}
