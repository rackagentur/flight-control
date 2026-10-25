# Crew commissioning diagnostics — local implementation, 2026-10-26

Owner-approved scope; not deployed. Production remains **NO-GO**. This does not resume the
paused synthetic device session or authorize real-data enrollment. Prior candidate/preview
results, C3's provenance exception, G6/G8 approvals and the unexplained Safari discrepancy stand.

## Approved limits and acceptance

The fixed eight-call initial-backfill target is superseded. Six months per server request and
approximately 15 seconds cooperative server work remain unchanged. For the recorded initial
outstanding work N, acceptance requires complete coverage (zero pending, stale and uncovered)
in at most `ceil(N / 6) + 2` requests and 180 seconds wall clock. All attempts, including busy
retries, count. The existing 20 requests/10 minutes and three runs/10 minutes apply; detail
indexing retains its three-call cap. All byte thresholds are decimal: median part <=6,000 bytes,
maximum <=8,000 bytes, observed representative peak <=450,000 bytes; admission remains <=500,000.

The backend returns an opt-in `session: {version:1, initialOutstanding, remaining}` for
`sessionVersion:1`. Counts use the actual index plan, including manual re-verification. The
client captures initialOutstanding only from the first successful response, never increases
its allowance for later work, and starts with a two-attempt bootstrap allowance (one busy retry).
Older responses still validate; an incomplete legacy batch stops `session-unavailable` rather
than guessing a history-sized continuation. This is an intentional compatibility limitation.

Successful batches must reduce remaining work. A wholly busy batch (or a busy refusal) gets
only the existing single retry, shared across both forms, counted against every budget. Zero
processing stops immediately unless authoritative counts already establish completion with cleanup finished; uncovered history still ends uncovered, not done. Other non-progress stops immediately. Errors/cancellation/hidden/offline stop;
there is no automatic resume after budgets or visibility recover. A session dispatches nothing
new at/after 180 seconds; an existing request can finish within its unchanged 45-second timeout.
Any total over 180 seconds is not a passing backfill. Larger histories need explicit additional
segments; neither multiple segments nor partial coverage silently pass the single-session target.

Index acquisition waits are <=2,000 ms; enrollment and routed revoke <=5,000 ms; editor purge remains 5,000 ms.
Held time starts after acquisition and includes diagnostic overhead. The <=2,000 ms/month held
criterion is still measured acceptance, not guaranteed by configuring the acquisition timeout.

## Opt-in response and measurement boundaries

`diagnosticsVersion:1` requests an optional `diagnostics` object on successful crewIndex only:

- `version:1`, `complete`, `serverMs`, `diagnosticMs`.
- `storeOperations:{keys,reads,writes,deletes}`: attempted User Properties adapter operations,
  including diagnostic reads/readbacks. These are not complete Script Properties/cache quota
  counts and do not by themselves close the heavy-day quota criterion.
- `storage:{observedPeakBytes,admissionPeakBytes,peakCategories}`.
- `committedParts:{count,medianValueBytes,maxValueBytes}`.
- `months`: <=6 unlabelled observations `{elapsedMs,eventsRead,encodedBodyBytes,partCount,
  lockWaitMs,lockHeldMs,outcome}`. eventsRead counts reader deliveries, including overlapping
  reads; it is not a distinct-event count. Verified/no-write months have null encoded sizes.
- `maintenance:{lockWaitMs,lockHeldMs}` sums cleanup/GC sections separately from month commits.

Peak categories are UTF-8 value bytes for non-crew properties, current committed parts,
retired values (including superseded year documents), orphan values, staged values and current
root/year manifests, plus all key bytes once:
`otherValueBytes`, `committedValueBytes`, `retiredValueBytes`, `orphanValueBytes`,
`stagedValueBytes`, `manifestValueBytes`, `keyBytes`. During publication a new year document
can be staged until its root commit. Stored part sizes include headers, exclude key bytes;
median averages the middle pair for even counts. Final distribution covers current committed
parts, not retired generations. Admission includes safety/reserves; it is not observed usage.

One full scan per acquired lock initializes a bounded key/size map (<=2,048 keys, <=131,072 key
characters). No values are retained in that map. Mutations update it and verify only the changed
property; root publication reclassifies via manifest documents. There is no whole-store reread
after each mutation. In-memory summation and classification costs remain inside held/server time.
`diagnosticMs` measures guarded accounting sections and overlaps those totals; do not add it again.
`serverMs` ends in the index handler before final response authorization/serialization; it does
not include platform startup or network delivery. The two session-count plans, purge resumption, GC and diagnostic accounting contribute to total request costs. The approximately 15-second cooperative loop check is not a whole-request ceiling; post-loop planning and cleanup are outside that check. Live behavior/overhead remain unmeasured.

Errors, ambiguous writes, unreadable classifications or cap overflow mark diagnostics incomplete;
missing peak/categories/distribution use null, not zero. Operations retain their original failure
semantics. Incomplete/truncated evidence cannot pass affected measurement criteria. A returned
report remains subject to the unchanged final generation/authorization check. No diagnostic
response exists for an authorization refusal. Normal requests have unchanged response fields.

The observation covers instrumented locked request writes, not an account-wide continuous peak
between calls; unrelated non-cooperating writers cannot be ruled out by this instrumentation.
Real Apps Script quota accounting still needs the existing representative comparison.

## Private collection and compatibility

Settings offers Start new session / End and clear / Show sanitized summary. These controls send
nothing. Collection is off by default and is never persisted or logged. Retention is at most100
request records,20 reports (each <=8,192 serialized characters; schema is ASCII), and20 session
records. Reaching a cap freezes that collection and marks truncated, never silently discards the
oldest measurement. Reload/access-ending purge/sign-out/reset/explicit end clears collection;
returning after more than ten minutes hidden also clears and disables collection. Consent changes and revocation clear it as well. Keep collection foregrounded; a new session rejects late observations from the old diagnostic generation.

Network durations use a monotonic client clock from dispatch through validation; existing
transport meta.ms is separate. Failures use fixed classifications, not raw exceptions. Cache hits,
joined callers and local refusals are labelled and excluded from the ten network samples. The
first ten successful crew network requests supply nearest-rank p50/p95; failures remain visible.
Warm server state is an owner-established prerequisite, never inferred by the collector.
Session elapsed time includes network, validation, sleeps and retries. Each continuation remains
a separate recorded segment; do not present a later fast segment as the whole initial backfill.

The owner may privately copy the displayed sanitized JSON. No endpoint, token, grant, fingerprint,
sector/month identifier, crew content or raw response is included. Do not export browser network
logs. Ordinary crew responses remain memory-only under the existing policy.

The strict frontend validator accepts diagnostics absent. Present diagnostics require exact
keys/types, nonnegative finite counts/times, consistent category totals and bounded payloads.
New frontend must precede backend; older clients never request the extra fields. Partial backend
files still fail the availability gate. No authorization, generation fence, cleanup, admission
limit or default privacy behavior is relaxed.

## Candidate and evidence impact

This implementation produces a new local candidate and regenerated worker; it does not change
the retained original candidate or patched published preview. Targeted synthetic tests establish
accounting/contract/runner behavior only. They do not establish real-history peak, actual Apps
Script timing, runtime OAuth, live-grant device cleanup or full release acceptance. No general
physical rerun or recreation of S0–S13 infrastructure is required by this change. Deployment and
actual commissioning remain separately authorized stages in RELEASE-REVIEW.

## Prior local verification — 2026-10-26 (before focused review corrections)

Uncommitted candidate on v2.1-dev, parent eba88764dacee5746b8434df5dc2733afe2cb064.
Final local worker: **48fde17ef3516a66bf83** (82 precached assets,83-file static tree including
sw.js). This is not the deployed patched preview0ecef7b232405a096670 or originala8024ca318cbf11bb3cb.
Nodev26.7.0 with navigator.locks.request available: targeted suites passed; final full repository
suite **1,395 passed,0 failed,0 skipped** before the final cache-hit elapsed-time refinement.
That final refinement records measured cache-hit duration rather than a hard-coded zero;
**94 affected service/diagnostic tests passed** afterward. Offline regeneration/check and
git diff --check passed on the final worker. No unchanged full-suite rerun was needed.
Full suite includes hygiene; all execution used local synthetic fixtures, not backend requests.

These hashes were generated now for the local implementation, not recovered historical provenance:
- CrewApiV2.gs SHA-256: b9b7031d2556ca3052b39007d3407c0a54cec3957e6840b563f11f61295590e4
- CrewCoreV2.gs SHA-256: 82389f7cd397704024cd948271e44e035e2ad368e7abe116c7e8530e4d9bdce0

Real Apps Script storage/timing/diagnostic overhead and the complete heavy-day quota calculation
remain open. The aggregate User Properties operation counts do not cover all Script Properties or
cache operations. No new physical acceptance is claimed. The previous tests remain historical
for their recorded builds; this work does not reopen completed S0–S13/teardown or erase exceptions.

## 2026-10-26 — Focused review corrections P1/P2

The implementation-review findings P1/P2 are corrected locally (these labels are not the
release performance rows P1/P2). Initial opt-in now re-arms only a previously explicit diagnostic
intent, synchronously before enrollment dispatch. All old records are still cleared. Re-arming
requires the same access id, exactly the expected consent transition and exactly the expected
single diagnostic clear; there is no deferred re-arm after capability resolution. Identity
changes, sign-out, reset, revocation and other access-ending clears retain their original behavior.

A UI-to-runtime regression failed before the fix and now proves that first enrollment dispatches
automatic initial indexing with diagnostics enabled, collects its aggregate report/session, and
does not retain pre-opt-in records. Additional cases cover no diagnostic intent, interrupted
consent/access/reset/owner-end, synchronous intervening reset and actual controller/service cleanup.
The deterministic cache-hit test advances the injected monotonic clock by7ms and asserts7ms
cache duration, no transport measurement, no extra request and unchanged network percentiles.
A temporary in-memory Node loader substituting hard-coded zero made this assertion fail
(actual0, expected7), as intended; tracked source was unchanged by the mutation experiment.

Verification: Nodev26.7.0, **147 affected tests passed**, **13 hygiene/offline tests passed**,
worker regeneration/check and git diff --check passed. No blanket full-suite rerun: the earlier
1,395-test result and subsequent94-test result remain historical evidence for their recorded
states, not new full-suite validation of this correction. Current local worker:
**a6ae289d2a4dace19979** (82 precached assets plus sw.js). No backend source changed in this pass.
No further concrete defect identified in this bounded correction; live measurements and release
acceptance remain open. All pending edits, C3/G6/G8 and the unexplained Safari discrepancy remain.
The physical session stays paused. No backend requests, production access, commit, push or deployment.
Production remains **NO-GO**. Next checkpoint: review this focused corrective diff before any release action.

## Bounded corrective pass — 2026-10-26

Manual runs now send manualCheck:true with sessionVersion:1 instead of device-clock verifyBefore.
The backend chooses the start of its current minute once and returns session.manualCutoff:{at,proof}.
Stored verification timestamps are minute-rounded; the floored cutoff avoids treating a just-verified
month as still outstanding. Verification stamps in that same stored minute are not rechecked;
freshness still uses the existing timestamp precision and current server time. Because storage rounds
to the nearest minute, a verification in the preceding minute's final 30 seconds can also have that
same stored timestamp. The boundary regression explicitly preserves this limitation; crossing a
minute never moves an existing session's cutoff.
The client echoes this unchanged in subsequent requests and rejects a missing or changed cutoff.
The 64-character HMAC proof binds the cutoff to the current generation, epoch and grant using
an operation-specific domain; ordinary authorization and final generation checks still apply.
This bounded continuation metadata stays in run memory, outside diagnostics, logs and storage.
It grants no access on its own. An altered, future or previous-generation cutoff is refused.
A cutoff also expires when server request-entry time minus its signed timestamp is >=285,000 ms:
180,000 ms session budget +45,000 ms possible in-flight request +60,000 ms conservative allowance
for flooring to a minute. This is an entry-time lifetime, not an extension of the client's dispatch
or acceptance budgets. A request admitted before expiry finishes under existing request/operation
limits and final authorization checks; expiry does not forcibly interrupt it. Rejection occurs before
purge, index planning, fixture reads or GC, using the existing crew-unavailable refusal. The client
stops; it neither renews the cutoff nor retries automatically. An explicit new manual run is required.
Within-lifetime same-generation replay is permitted for continuation, subject to all existing access,
rate, freshness and generation checks; the cutoff is not a single-use credential.
Freshness checks still use current server time; unsealable months remain pending.

Normal requests and legacy verifyBefore callers retain their existing wire behavior. A new manual
run against an older backend stops session-unavailable after its first response if the cutoff is
absent; that first bounded request may have indexed work, but is not claimed as a complete manual
re-check. Frontend-first deployment ordering remains required. Acceptance thresholds are unchanged;
held time includes diagnostic overhead, with no subtraction. New worker and validation follow below.


Validation for this corrective pass: Node v26.7.0, 271 affected tests passed, zero failed/skipped
(crew-api, crew-service, crew-validation, crew-runtime, crew-ui-async, crew-cancel, crew-routing,
crew-diagnostics). Thirteen hygiene/offline tests passed. No full-suite rerun. The new regression
initially exposed minute-rounded verification timestamps repeating work against a millisecond
cutoff; the fixed server-minute cutoff and multi-call regression now pass. Build regeneration,
check:offline and diff hygiene passed. Final local worker: **45f917d2fb0f2f3bc14e**,
82 precached assets plus sw.js. Current CrewApiV2.gs SHA-256:
**c1c5554503826a4a5d4a1ab0cd00e45930fe9c881361a6d7d080b9895595ef17**.
This newly generated hash supersedes the earlier local API hash for this candidate only;
it is not historical C3 provenance. Core source is unchanged. Evidence remains local/synthetic;
actual Apps Script timing/overhead, commissioning and device acceptance of this candidate remain
unverified. No backend requests, publication, commit or push; production NO-GO.


### Signed-cutoff expiry correction — 2026-10-26

Owner-authorized bounded expiry added without changing signature/generation binding, normal
responses, acceptance thresholds or access checks. The frontend worker is unchanged by this
backend-only runtime increment: regeneration/check still yields **45f917d2fb0f2f3bc14e**.
Current CrewApiV2.gs SHA-256: **ce4b031b42502ebdd07a575409a209e61167b0984f9a4ea094748049d2d20bc6**.
This supersedes the preceding local API hash only, not historical provenance.

Expiry validation: 193 affected tests passed (crew-api, crew-service, crew-validation,
crew-routing), zero failed/skipped on Node v26.7.0. The refusal assertion was then tightened to
require error:crew-unavailable and its single focused test passed. Thirteen hygiene/offline tests
passed; worker regeneration, offline integrity and final diff hygiene passed. No full-suite rerun.
Deterministic cases cover 284,999 ms accepted, 285,000/285,001 ms refused, signed 15-day replay,
a valid signature with a future timestamp, zero indexing reads/locks on refusal, explicit new-session
issuance, and previous-minute rounding plus unchanged cutoff across a minute boundary.
Final source review found no remaining concrete expiry defect. Within-lifetime continuation replay
is intentional and cannot replace ordinary authorization; admitted work is not forcibly interrupted.
No live timing/backend or device acceptance is established. Prior evidence and qualifications stand.
