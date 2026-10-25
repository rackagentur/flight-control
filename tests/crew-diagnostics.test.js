import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startCrewDiagnostics, clearCrewDiagnostics, crewDiagnosticSnapshot, recordCrewRequest, recordCrewReport, crewDiagnosticGeneration, validateCrewDiagnostics } from '../src/crew-diagnostics.js';
afterEach(clearCrewDiagnostics);
const diagnostic = () => ({ version:1, complete:true, serverMs:10, diagnosticMs:0, storeOperations:{keys:1,reads:0,writes:0,deletes:0},
  storage:{observedPeakBytes:0,admissionPeakBytes:null,peakCategories:{otherValueBytes:0,committedValueBytes:0,retiredValueBytes:0,orphanValueBytes:0,stagedValueBytes:0,manifestValueBytes:0,keyBytes:0}},
  committedParts:{count:0,medianValueBytes:null,maxValueBytes:null},months:[],maintenance:{lockWaitMs:2,lockHeldMs:3} });
test('opt-in retention caps, late-generation rejection, missing fields and percentile separation', () => {
  recordCrewRequest({action:'crew',source:'network',outcome:'success',elapsedMs:1});
  assert.equal(crewDiagnosticSnapshot().requests.length,0);
  startCrewDiagnostics();
  const born=crewDiagnosticGeneration();
  recordCrewRequest({action:'crew',source:'cache',outcome:'success',elapsedMs:0});
  for(let i=1;i<=10;i++) recordCrewRequest({action:'crew',source:'network',outcome:'success',elapsedMs:i});
  recordCrewRequest({action:'crew',source:'network',outcome:'timeout',elapsedMs:25000});
  assert.deepEqual(crewDiagnosticSnapshot().crewNetworkSamples,{count:10,p50Ms:5,p95Ms:10});
  for(let i=0;i<150;i++) recordCrewRequest({action:'crew',source:'joined',outcome:'success',elapsedMs:1, secret:'not retained'});
  for(let i=0;i<25;i++) recordCrewReport(diagnostic());
  const s=crewDiagnosticSnapshot();
  assert.equal(s.requests.length,100); assert.equal(s.reports.length,20); assert.equal(s.truncated,true);
  assert.equal(JSON.stringify(s).includes('secret'),false);
  startCrewDiagnostics();
  recordCrewReport(diagnostic(),born);
  assert.equal(crewDiagnosticSnapshot().reports.length,0);
  recordCrewReport(undefined);
  assert.deepEqual(crewDiagnosticSnapshot().reports,[{complete:false}]);
});
test('strict numeric schema rejects extras, inconsistent totals, oversize arrays and missing complete measurements', () => {
  assert.deepEqual(validateCrewDiagnostics(diagnostic()),diagnostic());
  for(const change of [d=>d.token='secret',d=>d.storage.observedPeakBytes=1,d=>d.serverMs=-1,d=>d.complete='yes',d=>d.committedParts.count=null,d=>d.months=Array(7).fill({}),d=>d.storage.peakCategories=null]) {
    const d=diagnostic();change(d);assert.throws(()=>validateCrewDiagnostics(d));
  }
});
