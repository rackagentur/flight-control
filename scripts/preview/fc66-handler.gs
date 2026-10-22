// FC66 compatibility wrapper. Existing synthetic project only; never production.
// Generated candidate also needs Fixtures.gs and AcceptanceV2.gs. No credential migration.
// The only services used are Script Properties and JSON ContentService output.
// No calendars, spreadsheets, outbound requests, triggers, production IDs or secrets.
function fc66Json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  return fc66Json_(e && e.parameter && e.parameter.action === 'getStats'
    ? { success: false, error: 'auth-required', message: 'Authentication required.' }
    : { success: false, message: 'Not available.' });
}
function fc66Equal_(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < b.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function fc66Reply_(body, properties) {
  if (typeof body !== 'string' || !body || body.length > 16384) return {ok:false,error:'bad-request'};
  let request;
  try { request=JSON.parse(body); } catch (_) { return {ok:false,error:'bad-request'}; }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return {ok:false,error:'bad-request'};
  const token=properties.getProperty('FC66_TEST_TOKEN');
  if (!token || !/^fc66_[a-f0-9]{64}$/.test(token)) return {ok:false,error:'not-configured'};
  if (!fc66Equal_(request.token,token)) return {ok:false,error:'unauthorized'};
  if (request.contract !== 'fc.roster' || request.version !== 2) return {ok:false,error:'unsupported-contract',contract:'fc.roster',version:2};
  if (!['capabilities','roster','history','flight','departures'].includes(request.action)) return {ok:false,error:'unknown-action'};
  // Mode and fixture selection are operator-only. Request fields never control them.
  const scenario=properties.getProperty('FC66_SCENARIO') || 'valid';
  const fixture=properties.getProperty('FC66_FIXTURE') || 'mixed';
  if (!['valid','expired','malformed','empty','server-error','throw'].includes(scenario)
      || (fixture !== 'gate-radar' && !Object.prototype.hasOwnProperty.call(FC66_FIXTURES,fixture))) return {ok:false,error:'not-configured'};
  if (fixture !== 'gate-radar' && ['flight','departures'].includes(request.action)) return {ok:false,error:'unknown-action'};
  if (scenario === 'expired') return {ok:false,error:'unauthorized'};
  // Capabilities remains usable while selecting response fault tests.
  if (request.action !== 'capabilities') {
    if (scenario === 'server-error') return {ok:false,error:'internal-error'};
    if (scenario === 'throw') throw new Error('Synthetic Step 6.6 server failure');
  }
  let response;
  if (fixture === 'gate-radar') {
    const mode=properties.getProperty('FC66_PROVIDER_MODE') || 'gates';
    if (!['gates','missing','stale','not-found','provider-error'].includes(mode)) return {ok:false,error:'not-configured'};
    response=fc66Acceptance_(request,properties,mode);
    if (!response || response.ok !== true) return response;
  } else {
    response=JSON.parse(JSON.stringify(FC66_FIXTURES[fixture][request.action]));
    // Fixed fixture coverage, not a general-purpose calendar range service.
    if (request.from != null || request.to != null) return {ok:false,error:'bad-request'};
  }
  if (request.action === 'roster' && scenario === 'malformed') response.sectors=null;
  if (request.action === 'roster' && scenario === 'empty') {
    ['events','sectors','duties','windows','stays'].forEach(key=>response[key]=[]);
    response.coverage.days.forEach(day=>{day.state='empty';day.codes=[];});
    response.coverage.lastRosteredDate=null;
  }
  if (request.action === 'history' && scenario === 'malformed') response.sectors=null;
  if (request.action === 'history' && scenario === 'empty') response.sectors=[];
  return response;
}
function doPost(e) {
  return fc66Json_(fc66Reply_(e && e.postData && e.postData.contents, PropertiesService.getScriptProperties()));
}
