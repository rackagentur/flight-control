// One browser "tab" for the cross-tab credential tests: a real worker thread (own JS runtime and event loop)
// with the app's store over the SHARED storage double, the credential module, and the crew service. The
// backend lives in the main thread and is reached by message passing. Web Locks are Node's navigator.locks,
// which is shared between worker threads of one process. Synthetic data only.
import { parentPort, workerData } from 'node:worker_threads';
import { createStore } from '../../src/store.js';
import { ApiError } from '../../src/api/appscript.js';
import { crewEnrollRequest, validateCrewEnroll } from '../../src/sources/crew-v2.js';
import { sharedStorage } from './crew-shared-storage.mjs';

const { buffers, tabId, credentialModule, endpoint, token, accessId } = workerData;
const C = await import(credentialModule ?? new URL('../../src/sources/crew-credential.js', import.meta.url).href);
const S = await import(new URL('../../src/sources/crew-service.js', import.meta.url).href);

const store = createStore(sharedStorage(buffers, tabId, 'fc.v2.crew.v1'));
const credentials = C.createCrewCredentials({ store });
const access = { endpoint, token, accessId };

let seq = 0;
const waiting = new Map();
/** postContract double: the request goes to the main thread (the simulated backend). */
const post = (ep, body) => new Promise((resolve, reject) => {
  seq += 1;
  waiting.set(seq, { resolve, reject });
  parentPort.postMessage({ type: 'post', reqId: seq, body });
});
const svc = typeof credentials.detailed === 'object'
  ? S.createCrewService({ credentials, access: () => access, post, sleep: async () => {}, isVisible: () => true, isOnline: () => true })
  : null;

const DEFINITIVE = new Set(['unauthorized', 'enroll-closed', 'bad-request', 'crew-disabled', 'unknown-action', 'unsupported-contract', 'not-configured', 'rate-limited']);

/** Enrollment driven through the credential API only (works with the pre-batch-7 module too). */
async function enrollDirect(code) {
  const begun = await credentials.beginEnroll(access);
  if (begun.error) return { error: begun.error };
  let data;
  try {
    ({ data } = await post(endpoint, crewEnrollRequest(token, code, begun.grant)));
  } catch (e) {
    await credentials.settleEnroll(begun.grant, 'unknown');
    return { error: e.code ?? 'network' };
  }
  const check = validateCrewEnroll(data);
  if (check.ok) return { settled: await credentials.settleEnroll(begun.grant, 'ok', check.value.G), G: check.value.G };
  await credentials.settleEnroll(begun.grant, check.refused && DEFINITIVE.has(check.refused) ? 'refused' : 'unknown');
  return { error: check.refused ?? 'invalid-response' };
}

const commands = {
  enrollDirect: ({ code }) => enrollDirect(code),
  enroll: ({ code }) => svc.enroll(code),
  revoke: () => svc.revoke(),
  resume: () => svc.resumeRevoke(),
  loadCrew: ({ query }) => svc.loadCrew(query).then((v) => ({ sectorId: v.sectorId })),
  lockState: async () => navigator.locks.query(),
  record: () => store.getChecked('crew.v1'),
};

parentPort.on('message', async (msg) => {
  if (msg.type === 'post-reply') {
    const w = waiting.get(msg.reqId);
    waiting.delete(msg.reqId);
    if (msg.error) w.reject(new ApiError(msg.error, `synthetic transport failure (${msg.error})`));
    else w.resolve({ data: msg.data, meta: {} });
    return;
  }
  try {
    const value = await commands[msg.cmd](msg);
    parentPort.postMessage({ type: 'result', id: msg.id, value });
  } catch (e) {
    parentPort.postMessage({ type: 'result', id: msg.id, error: e?.code ?? String(e?.message ?? e) });
  }
});
parentPort.postMessage({ type: 'ready' });
