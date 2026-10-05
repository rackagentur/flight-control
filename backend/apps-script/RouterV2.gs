// ============================================================================
// FLIGHT CONTROL — WEB-APP GET ROUTER (backend hardening BH-1, BH-2)
// ============================================================================
// The project's ONLY doGet. It refuses every GET (no action, sync, dashboard, dashboardPrev,
// the legacy ?function= wrapper, anything else) with a small JSON answer, except `getStats`
// during the BH-2 migration window: the v5 payload is served by GET only while Script
// Property FC_V5_GET is exactly "open". Otherwise getStats answers "auth-required"; token
// holders read the same payload through doPost {action: "stats"} (RosterApiV2.gs).
//
// It never returns an HtmlService page: Apps Script exposes google.script.run only to pages
// it serves itself, so without a page no server function is reachable from a browser.
// Scheduled work (sync, dashboards) keeps running from its time-driven triggers.
//
// Uses getFlightStats (defined in the existing web-app file) by NAME only.
// Rollback switch: set FC_V5_GET = open (instant, no redeploy); delete it to close again.
// Every helper ends in "_" (not callable remotely). No top-level side effects.
// ============================================================================

const FCV2_GET_REFUSED_ = Object.freeze({ success: false, message: 'Not available.' });
const FCV2_GET_AUTH_REQUIRED_ = Object.freeze({ success: false, error: 'auth-required', message: 'Authentication required.' });
const FCV2_V5_GET_PROPERTY_ = 'FC_V5_GET';

function doGet(e) {
  const result = fcv2HandleGet_(e && e.parameter, {
    stats: function () { return getFlightStats(); },
    v5GetOpen: function () { return PropertiesService.getScriptProperties().getProperty(FCV2_V5_GET_PROPERTY_) === 'open'; },
  });
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Pure GET routing (tested in Node). Only ?action=getStats can be served, and only while the
 * migration switch is open; the request's own values are never echoed back.
 * @param {Object<string,string>|undefined} params  e.parameter
 * @param {{stats: function(): Object, v5GetOpen: function(): boolean}} handlers
 */
function fcv2HandleGet_(params, handlers) {
  const action = params && typeof params.action === 'string' ? params.action : '';
  if (action !== 'getStats') return FCV2_GET_REFUSED_;
  return handlers.v5GetOpen() === true ? handlers.stats() : FCV2_GET_AUTH_REQUIRED_;
}
