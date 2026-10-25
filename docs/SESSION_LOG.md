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

## 2026-10-26 — Local aggregate diagnostics and bounded indexing

Owner authorized implementation and targeted checks, replacing the fixed eight-call target with
<=ceil(N/6)+2 attempts /180 seconds, six months/request unchanged, and explicit decimal-byte
thresholds. Added opt-in aggregate backend accounting/timings, strict optional client validation,
private bounded memory collection and a frozen history-sized runner allowance. Busy retry shares
all budgets; other no-progress stops. Index/revoke acquisition2s/5s remains distinct from held time.
See CREW-DIAGNOSTICS.md for exact semantics, compatibility and incomplete evidence limits.
All seven pre-existing documentation edits preserved. C3/G6/G8 and historical evidence remain;
Safari missing-state cause remains unknown. Paused physical session was not resumed. No backend
requests, credentials, real data, production access, deployment, commit or push.
Final verification: targeted suites passed; full suite1,395 pass/0 fail/0 skipped on Nodev26.7.0
with Web Locks. The final cache-hit timing refinement then passed94 affected tests.
Offline build/check and diff check passed on final assets. Local worker48fde17ef3516a66bf83,
82 precached assets plus sw.js. Exact local backend digests and limitations: CREW-DIAGNOSTICS.md.
No new live or physical acceptance; next checkpoint is owner review of this local change.

# Flight Control — session log

Newest first. One entry per working session (see the checkpoint procedure in `docs/NEXT_STEPS.md`).
Facts only; link to decisions/issues by ID. Never paste URLs with tokens, calendar ids, names or employee numbers.

## 2026-10-26 — Owner approves G6 substitution and G8 parity amendment

Recorded explicit G6 timeout-preservation substitution using completed physical offline-refresh/
reconnect evidence and inspected shared preservation path; timer-driven abort remains not physically
verified, malformed/empty requirements unchanged. Recorded G8 Settings discovery-panel exception;
unsupported enrollment must not dispatch, must explain lack of support and leave feature off;
unsupported flight-detail crew remains absent. Amended CREW-INTELLIGENCE §14 and current records.
C3 exception, earlier Safari discrepancy, combined scope and patched/original distinction preserved.
Prepared only a bounded malformed/empty and Reset run sheet, including FC66_SCENARIO baseline
restoration and explicit normal local cleanup scope. No tests, backend changes/requests, application
changes, commit, push or deployment. All seven pending docs preserved; git diff --check passed.
Production **NO-GO**. Execution requires separate approval.

## 2026-10-26 — Owner approves C3 historical provenance exception

Gregory approved resolving C3 by documentation exception after the bounded read-only search.
Exact execution date, executed build identity and corresponding executed-bundle manifest digests
are not recoverable from inspected records. Retained scratchpad manifests have no execution link;
package source history and report dates are not proof of the run. S0–S13 and teardown remain
completed, owner-reported evidence; no commit-bound validation claimed. No rerun/recreation solely
for these missing records. Added an explicit superseding C3 decision and updated release evidence
and current summaries. Other acceptance gates, combined preparation scope, earlier unexplained
Safari discrepancy, Home Screen pass and patched/original build distinction remain unchanged.
Five already-modified documentation files updated; all seven pending edits preserved. No tests,
production access, application changes, commit, push or deployment. git diff --check passed.
Production **NO-GO**. Next checkpoint: bounded planning for remaining explicit physical response-
fault preservation cases; no execution authorized here.

## 2026-10-25 — Remaining physical response-fault requirements classified

Recorded the completed offline-refresh/reconnect checkpoint as closed within observed scope.
Read-only review traced timeout/malformed/empty preservation to IPHONE-ACCEPTANCE §2 step 6 and
its steps 1–10 pass criterion, plus STEP-6.6-OFFLINE physical step 8 (including fault-specific offline
relaunch). Existing Node/desktop browser evidence retained; no new test executed. Timeout handling
unit tests do not establish physical saved-v2 timeout preservation; elapsed timeout measurement is
not an acceptance requirement here. Three rows remain unresolved acceptance gates, not failed tests
or optional follow-up without explicit owner substitution/deferral. No new device matrix or repeated
normal-path checks introduced. Patched/original candidate distinction, earlier Safari discrepancy,
Home Screen pass and all seven pending edits preserved. Four documentation records updated;
git diff --check passed. No application changes, production access, deployment, commit or push.
Production **NO-GO**.

## 2026-10-25 — Physical Safari offline-refresh preservation/reconnect completed

Owner approved one bounded five-step session in one existing Safari context using the verified
synthetic connection privately. Pre-sync booleans showed normal mode, matching origin, accessible
storage and all three keys present (roster already present; no inference why). Online baseline:
fictional roster, last sync 16:46 (Europe/Berlin), Available offline. Owner pressed Refresh roster
once while offline, waited 30 seconds and saw no message; then confirmed same roster, unchanged
time/readiness and all three keys present. After instructed single reconnect on Calendar, owner
reported Roster synchronized, last sync 16:53 (Europe/Berlin), Available offline. Date not supplied.

Recorded only physical Safari offline-refresh preservation and reconnect recovery. No measured
timeout, exact request counts, byte comparison, raw traffic/error evidence or malformed-response
acceptance claimed. Existing automated/browser evidence retained; no adoption, closure/reopen or
sign-out reruns. Earlier unexplained Safari discrepancy and Home Screen pass preserved. No resets,
backend changes, application changes, deployment, production access, commit or push. Updated four
current records, preserving all seven pending files. git diff --check passed. Remaining physical
A2 response-fault requirements not waived. Production **NO-GO**.

## 2026-10-25 — Bounded synthetic Safari sign-out/two-tab check completed

Owner separately authorized bounded synthetic setup/sync and resumed sign-out. Before sync both
tabs reported matching origin, normal mode, accessible storage, endpoint/token present, roster
absent. After automatic sync both showed the same fictional roster and all three keys present.
System theme/Local display recorded in both. Sign-out once in Tab 1 produced no message and removed
its visible roster. Focusing Tab 2 removed its roster; key-presence output confirmed endpoint
retained, token/roster absent, normal mode and accessible storage. System/Local remained. Owner
confirmed offline closure/reopen of Tab 2 left roster inaccessible and preferences unchanged.

Pass limited to these observed patched-preview cases; no server-side deletion, full profile/history
cleanup audit or Home Screen sign-out claimed. Earlier unexplained Safari absence and qualified
persistence evidence preserved; Home Screen pass and adoption unchanged. Next remaining gate is
A2 failed-refresh preservation/reconnect under separate authorization, not a repeat of sign-out.
Updated four evidence/status docs; all seven pending files preserved. git diff --check passed;
no additional tests, reset, fault-mode changes, application changes, deployment, commit or push.
Production **NO-GO**.

## 2026-10-25 — Read-only Safari key-presence diagnosis complete

Gregory ran the supplied key-name-only snippet in iPhone Safari Web Inspector. Both tabs returned
previewOriginMatches=true, storageAccessible=true and endpoint/token/roster key presence=false;
reviewMode=false for Tab 1 and true for Tab 2. Owner confirmed regular/default Safari profile in
both. No sensitive values read or exported; diagnostic made no writes or application requests.
Absent keys are established at observation time; no storage-access exception observed. Cause,
historical continuity and source-binding consistency remain unestablished. No data-loss or defect
claim. Sign-out remains blocked before execution; Home Screen pass and closed adoption unchanged.
Updated current summaries without erasing earlier qualified Safari evidence. Next proposed action:
explicit bounded synthetic setup/sync authorization to establish sign-out's precondition, not a
persistence rerun or explanation of the discrepancy. No reset, application changes, deployment,
commit or push. All seven pending docs preserved; git diff --check passed. Production NO-GO.

## 2026-10-25 — Synthetic sign-out checkpoint stopped before execution

Owner authorized normal synthetic sign-out/two-tab invalidation. After initially confirming both
tabs displayed a roster, Gregory clarified Tab 2 still showed review samples; Tab 1 exited review
and displayed disabled Sign out. Supplied screenshot confirms “Access token” and “Not loaded yet”.
Source inspection: button disabled when no token or saved roster is detected. Owner confirms the
same Safari profile/context as the earlier restoration observation. No sign-out invoked; preference
retention, second-tab invalidation and post-sign-out reopening remain untested. No automatic retry.

Preserved earlier restoration report with an explicit unresolved Safari qualification; no data-loss
or application-defect conclusion. Home Screen restoration and adoption remain closed. Next proposed
checkpoint is read-only storage-state/source-binding diagnosis without credential/roster values,
new sync, reset or reconfiguration. Updated four current evidence/status records, preserving all
seven pending docs. git diff --check only; no application changes, deployment, commit or push.
Production **NO-GO**.

## 2026-10-25 — Fixture-only source verified and device persistence session recorded

Verified active synthetic deployment maps to immutable Version 2; all four complete Project History
files hash-match the reviewed publication record. Source uses embedded fixtures and in-memory
provider-shaped replies, with no live data bindings; empty OAuth scopes and no dependencies.
Gregory's separate user-run TLS/authenticated capabilities preflight passed. No credential values
or backend endpoint identifiers recorded; no roster/history retrieved by the source inspection.

Owner-authorized device session: first configured browser showed saved-roster readiness and restored
fictional roster offline after closure/reopen. Gregory subsequently confirmed the context was standalone
Safari; standalone Safari persistence is therefore accepted by owner report without a rerun. Initial mistaken reopening in unconfigured Home Screen was clarified,
not classified as storage failure. Home Screen was then configured privately while offline, synced
from Calendar and restored its roster after offline app-switcher closure/reopen. Owner reported the
same “Roster synchronized · Last sync 2026-10-24 21:12 (Europe/Berlin) · Available offline” before and
after reopening. Timestamp retained verbatim. No device model/iOS inferred, no request trace claimed.

Updated RELEASE-REVIEW, PROJECT_STATUS, NEXT_STEPS and this log, preserving all seven pending docs.
Only patched-preview standalone Safari/Home Screen restoration outcomes accepted; adoption remains
closed. Next owner action is scoped authorization for remaining synthetic sign-out/two-tab invalidation. Other acceptance/performance/runtime/baseline/release gates remain.
No application changes, deployment, production access, fault changes, reset, commit or push.
Documentation validation: git diff --check only. Production **NO-GO**.

## 2026-10-25 — Owner confirms patched-preview physical worker adoption

Recorded Gregory's supplied screenshots and browser-context confirmations: Safari controls
0ecef7b232405a096670 with no waiting update and sample banner visible; existing Home Screen moved
from 807357dcd3bb9ef3e92e with a waiting update to 0ecef7b232405a096670 after normal closure/reopen,
with no waiting update. These patched-preview adoption checks are closed; no repeat requested.
No device model/iOS inferred. Both display roster persistence not confirmed; no storage failure,
offline readiness, complete device acceptance, original-candidate or production approval claimed.

Read-only source inspection confirms review-mode snapshots are generated in memory and excluded
from offlineReady; scenario sessionStorage is not saved-roster persistence. Recommended one
conditional fixture-only sync/offline session using the existing Step 6.6 synthetic backend and
normal persistence path, after explicit target/access authorization and availability preflight.
No production credentials, reset or infrastructure recreation. Updated release evidence and current
summaries; retained earlier reports as historical. All seven pending files preserved at v2.1-dev
eba8876, three commits ahead. No tests, application changes, deployment, production access, commit
or push. Verification: git diff --check only. Production NO-GO; unrelated gates remain open.

## 2026-10-25 — Synthetic frontend publication and authorized rollback

Preserved all seven pending documentation edits at v2.1-dev eba8876. Used the existing preview
project and unchanged configuration; verified READY pre-change rollback before publishing.
82 candidate files plus preview config staged; worker unchanged at a8024ca318cbf11bb3cb.
Immutable/stable static integrity passed 83/83 responses each. Immutable Chrome candidate worker,
81 cached assets, fictional light/dark presentation and offline shell passed. An external harness
title assertion was corrected; application source was untouched. No external request attempts.
Stable-origin seeded browser retained 807357dcd3bb9ef3e92e after normal client closure/reopen,
so restored the verified pre-change alias under the owner's rollback authorization. No storage
clearing, forced activation or emergency worker. Candidate physical acceptance not claimed.
Outcome and identities recorded outside Git in flight-control-preview-20261025; current release
summaries updated. No regression/S0–S13 reruns, production/backend/provider requests, application
credentials, source changes, new cloud projects, commit or push. Production NO-GO. Next step is
scoped worker-adoption diagnosis; remaining authenticated/performance/release gates stay open.

## 2026-10-24 — Q1 owner confirmation recorded; bounded checklist advanced

Gregory confirms the previously described private, single-user crew-data processing is permitted.
Recorded as owner-confirmed only: no supporting policy or correspondence was inspected; no
independent legal verification, external approver or approval date is asserted. Multi-user access,
sharing and commercial use are not covered. Added a superseding decision and closed current Q1
items in the release review, specification and summaries while preserving historical entries.

Verified v2.1-dev at eba8876, three commits ahead, with all seven pending documentation files
preserved. Advanced the next checkpoint to D2's existing bounded session, requiring explicit
candidate/target/data/operation authorization before execution. Technical acceptance, performance,
OAuth/runtime and rollback-baseline requirements remain. No reconciliation restart, repeated
validation or execution; production NO-GO. No tests, production access, application changes,
commit, push or deployment. Verification: git diff --check only.

## 2026-10-24 — Confirmed Apps Script settings recorded

Verified `v2.1-dev` at `eba8876`, three commits ahead, preserving the six pending documentation
files. Q4 execution as Gregory is owner-confirmed with supplied screenshot evidence of
“Ausführen als: Ich”; Q6 sole-editor status is owner-confirmed. Recorded screenshot access
setting “Zugriffsberechtigte: Jeder” as observed, unchanged, not a new approval. No email or
deployment identifiers recorded. Updated current summaries and specification rows; added an
explicit superseding decision while preserving historical entries. Screenshot evidence does
not verify deployed source, OAuth scopes or application authentication. Q1 and unrelated
acceptance/performance/release gates remain open. Scope selection, timeout exception, Stage B
visual approval and completed validation/teardown preserved. Production NO-GO. No code changes,
tests, production requests, commit, push or deployment. Verification: `git diff --check` only.

## 2026-10-24 — Gregory approves historical Stage B screenshots visually

Recorded Gregory's visual approval of the recovered 198 synthetic PNGs listed in E6's
`stage-b-shots/index.md` (Flight Details/Settings, light/dark, 320/390/430 px). RELEASE-REVIEW
records the exact scratchpad path; the local gallery uses those existing images. No build hash
is recorded in the index, and none is inferred for this approval. Approval covers this historical
artifact set only, not later visual changes, physical-device/cross-tab behavior, performance,
deployment, activation or production release. Updated current summaries and next action;
preserved all prior uncommitted edits. Other requirements, Q1/Q4/Q6 and production NO-GO remain.
S0–S13 and teardown stay closed. No tests, screenshots regenerated, code changes, commit, push
or deployment. Documentation verification: `git diff --check` only.

## 2026-10-24 — Stage B acceptance evidence recovered from existing chat

Continued read-only evidence reconciliation at `eba8876`, preserving all six pending docs.
The “Verify Flight Control access” chat records the initial 198/198 Chromium layout pass and
six screenshot inspections, then behavioral corrections verified at 24/24 targeted, 294/294
crew/store and 1244/1244 full suite. Found its exact scratchpad: 198 PNGs and 198 index rows
marked ok. No new tests or screenshots. Index lacks a build hash; follow-up did not regenerate
screenshots or exercise actual browser cross-tab delivery. Four presentation/harness files
are byte-identical between Stage B commit `3b3b56d` and HEAD. Updated E6/matrix and current
next action: owner visual approval of recovered artifacts, then missing device/live aggregate
evidence. Early scratchpad measurement draft is superseded, not new live-peak evidence.
No code changes, credentials/private roster reads, resource creation, production access, commit,
push or deployment. Production NO-GO; S0–S13 and teardown remain closed. `git diff --check` only.

## 2026-10-24 — Existing acceptance and aggregate evidence reconciled

Verified `v2.1-dev` at `eba8876`, three commits ahead; preserved all six pending documentation
edits, selected combined scope and approved 45 s crewIndex exception. Read tracked requirements,
relevant commit bodies and available local acceptance/publication/remediation records plus saved
synthetic Node aggregate logs. No tests or live requests. RELEASE-REVIEW now holds one evidence
matrix with candidate/environment limits and smallest follow-ups. Recovered earlier responsive
publication/adoption, specific historical iPhone observations and synthetic storage totals;
old sign-out adoption records retain the older controller. None establishes current crew device
acceptance. Missing crew UI/live aggregate reports are evidence gaps, not failed tests. Q1/Q4/Q6
remain separate owner gates. Next owner action: identify existing final acceptance/performance
records with build/environment metadata or confirm their absence. No general retest proposed.
No private reference/credential files or personal roster/crew payloads inspected; no code changes,
resource creation, commit, push or deployment. Production NO-GO; validation and teardown closed.
Documentation verification: `git diff --check` only.

## 2026-10-24 — Owner-approved indexing-timeout exception recorded

Verified `v2.1-dev` at `eba8876`, three commits ahead of recorded origin; preserved all five
uncommitted scope-selection documentation edits. Recorded the owner's approval of 45 s per
`crewIndex` only, explicitly superseding its former <30 s client-timeout target. Other crew
requests stay at 25 s. Updated specification and current summaries; earlier decision snapshots
remain historical. Server budget, measured-performance targets and acceptance requirements
are unchanged. Production NO-GO and deployment/activation restrictions remain. Next checkpoint:
recover and reconcile existing candidate acceptance and aggregate performance/storage evidence.
Completed S0–S13 validation and teardown remain closed. No code changes, tests, commit, push,
deployment or production access. Documentation verification: `git diff --check` only.

## 2026-10-24 — Owner scope selection recorded

Verified clean `v2.1-dev` at `eba88764dacee5746b8434df5dc2733afe2cb064`, three commits
ahead of recorded origin; read repository instructions. Recorded the owner's combined
crew + single-flight-information + attribution selection **for preparation only** in DECISIONS
and current RELEASE-REVIEW, PROJECT_STATUS and NEXT_STEPS summaries. The reviewed 15 frontend
changes, six backend files and 82-file static tree are unchanged; the 127-file inventory is
explicitly tied to its historical comparison. Earlier proposals remain historical.
Production NO-GO and all unresolved gates remain; deployment/activation unauthorized.
Next recommended decision: an explicit indexing-timeout specification exception based on
existing configuration and cooperative-budget evidence, not a latency claim or approved waiver.
S0–S13 and teardown remain closed. No application changes, tests, resource creation, production
access, commit, push or deployment. Verification for this documentation update: `git diff --check`.

## 2026-10-24 — Release preparation, documentation review only

Verified local `v2.1-dev` at `5a7dd16`, two documentation commits ahead of recorded origin;
inspected and retained the four existing documentation edits. No fetch. Direct endpoint diff
against `a3008d2`: 127 files, 27,683 additions, 192 deletions before this update. Classified every
path; proposed 15-file frontend delta, six backend files, and complete 82-file static tree.
Flight/attribution frontend and offline foundations already match the production Git reference;
served production and immutable backend source remain unverified. Reconciled current summaries,
crew specification status, historical release instructions and Version 29 rollback distinctions.
Existing synthetic storage/browser/device evidence retained with its limits; missing final-candidate
acceptance and explicit measurement requirements identified without reopening S0–S13 or teardown.
No application code/artifact changes, private reference reads, production requests, test reruns,
commits, pushes or deployment. Owner reviews the complete documentation diff before any commit;
next decision is combined scope versus a separately reviewed crew-only proposal.
Documentation diff reviewed; `git diff --check` passed. No new test results are claimed.

## 2026-10-15 (latest) — Claude Code: Condor display terminology (D-012)

- Read-only audit first: classification of `-` (unassigned) and `U` (off/leave) correct in every layer; display wrong
  (`STR` / `LEAVE`). Then implemented D-012 in the Condor pack and pack-driven UI: calendar cell/key, 7-day strip,
  Today titles + descriptions. Generic pack unchanged; no backend, contract or classification change.
- Tests: 10 pinned assertions in 4 test files updated to the approved wording (lone-dash rule kept absolute for generic, restricted
  to the code elements for Condor); new `tests/condor-display.test.js` (7 tests; 4 fail against the old code).
- `sw.js` rebuilt (precached `profile.js` and UI files changed). Committed locally (not pushed); nothing deployed.

## 2026-10-15 (later) — Claude Code: release safety (rollback worker, Pages subpath)

- Added `scripts/rollback/sw.js` (self-removing worker: deletes only `fc-shell-*` caches, unregisters its own
  scope, reloads windows; no fetch handler, no storage access) and the emergency procedure in
  `docs/STEP-6.6-OFFLINE.md`. Not activated, not deployed.
- New tests: `tests/rollback-worker.test.js` (unit) and `tests/browser/rollback-subpath.mjs` (desktop Chrome under
  `/flight-control/` + rollback to the real `0ae7d58` tree; synthetic data; neighbour same-origin app at `/roadmap/`).
- Found (documented as I-009): the update check on launch is not guaranteed, and in 2 of the final 30 runs the
  installed rollback worker stayed waiting despite `skipWaiting()` until one relaunch. The test models launch → up
  to 3 `update()` calls → up to 2 relaunches and fails otherwise; final 30/30 pass (28 on launch, 2 after one relaunch). Three test-harness bugs fixed (async predicates passed to
  `waitForFunction`; readiness wait across navigations; reload before the worker was active).
- Committed locally (not pushed); nothing deployed; no production access.

## 2026-10-15 — Claude Code: isolated preview deployment

- Vercel project `flight-control-preview` created; SSO protection disabled for it only (other projects untouched,
  `flight-control-step66-preview` still SSO-protected). Staged 70 files from the clean tree @ `53850e0` and deployed;
  the first CLI deployment became the project's own production target (alias `flight-control-preview.vercel.app`).
- Verified: 200 + `no-cache` for `/`, `index.html`, `sw.js`; `noindex`; 8 non-allowlisted paths 404 (docs, reference,
  tests, backend, scripts, package.json, .git, vercel.json); served bytes equal the repo; headless Chrome (phone
  viewport): service worker active, 68 cached entries, no page errors, no third-party requests.
- Production unchanged: Pages source `main` @ `0ae7d58`, served `controller.js` equals `origin/main`.
- Synthetic backend + throwaway token generated in `~/.config/flight-control/test-backend/` (private); Apps Script
  setup needs the owner (no clasp). `53850e0` and this docs commit are local only.

## 2026-10-14 (final) — Claude Code: history cleanup, push, iPhone preview tooling

- History cleanup (unpublished commits only; no remote ref, tag, fork, PR, other branch or worktree contained them):
  `c8b0996` → `7c6488a`, `bb6c0f5` → `c999cef`, `6959311` → `5db9381`; the seven earlier commits unchanged. Final tree
  byte-identical to `6959311`; the credential-location line removed from history. Backup: local branch
  `backup/v2-redesign-pre-rewrite-20261014` (I-008).
- Checks before push: `npm test` 766/766, repo hygiene 5/5, `build-offline --check` current; scan of all 6,128
  added lines in the 10 commits: 0 generic hits, 0 of 7 exact production values.
- **Pushed** `v2-redesign` `0ae7d58..5db9381` (fast-forward, no force). `origin/main` still `0ae7d58`; Pages source
  `main`; backup branch not pushed.
- Preview tooling (local commit, not pushed): `scripts/preview/stage.mjs`, `scripts/preview/gen-test-backend.mjs`,
  `tests/preview.test.js` (8 tests); setup steps in `docs/IPHONE-ACCEPTANCE.md`. Nothing deployed.

## 2026-10-14 (latest) — Claude Code: iPhone acceptance preparation

- Verified: `v2-redesign` @ `bb6c0f5`, clean tree; `origin/v2-redesign` = `origin/main` = `0ae7d58`; push would be a
  fast-forward of 9 commits; branch unprotected; only workflow is Pages build for `main`; repo is public.
- Scanned unpushed commits: no credentials/ids; reworded two lines that named where the feed credential is kept.
- iPhone plan `docs/IPHONE-ACCEPTANCE.md`: staged Vercel preview (separate project) + synthetic Apps Script test
  backend; run sheet of 12 checks. Nothing pushed or deployed; awaiting approval.

## 2026-10-14 (later) — Claude Code: Step 6.6 completion audit and final corrections

- Audit: no product/security defect; blocker was the S6 test (failed 40/40 in isolation: one `setTimeout(0)` vs the
  WebCrypto `sourceIdentity()` await before the request) plus an assertion on legacy keys only.
- Owner decisions D-011 implemented: Sign out keeps non-sensitive preferences, removes `name`/`hotelListUrl`;
  Reset removes everything; token change purges previous-source data (already correct, now tested).
  Settings copy distinguishes Sign out from Reset. `sw.js` regenerated.
- Tests: S6 file 30× → 0 failures; in-flight test alone 30× → 0; `npm test` 5× → 766/766; `build-offline --check`
  current; desktop browser harness 15/15 (system Chrome, installed Playwright, synthetic, localhost).
  Unverified: physical iPhone/Home Screen, Safari.
- Known limitations recorded: I-006 service-worker update latency, I-007 empty roster (before multi-user).
- One local Step 6.6 commit on `v2-redesign`; not pushed, not merged, no deploy, no feed access.

## 2026-10-14 — Claude Code: calendar audit, direct-feed Phase 0, onboarding proposal, continuity docs

- Branch `v2-redesign` @ `7bb7f54`; Step 6.6 uncommitted in the working tree (untouched this session).
- **Calendar data audit** (read-only): field availability recorded in `docs/ARCHITECTURE.md` §3 (D-009).
- **Direct ICS investigation**: no feed URL in the repo; Google does not expose it; source is CUBE (`cube.aero`).
  Recommendation P-001 (hybrid, conditional). Owner approved Phase 0 for preparation only (D-010).
- **Probe PREPARED — NOT EXECUTED**: moved from the temporary scratchpad to `~/.config/flight-control/feed-probe/`
  (private, mode 700, outside Git; checksums verified). Independent review rounds:
  1. PASS_WITH_NOTES — gate/privacy/read-only OK; 2 major + 6 minor issues (monitor, BOM, all-day, scopes) → fixed.
  2. FAIL — 6/8 fixes confirmed; new N1 (Calendar failure blinded the monitor), N2 (0-min deletion samples),
     N3 (stale mapping), N4 (old state), N5 (doc) → fixed.
  3. PASS_WITH_NOTES — all confirmed; remaining: 0-min samples after gaps, mapping kept on early stops → fixed
     (resync after gaps/restart; mapping cleared at every `probeRun`). **These last fixes are self-tested only.**
  Offline tests 23/23. Not verifiable offline: real Apps Script/CUBE behaviour, `getId()` format, read-only scope.
- **Onboarding architecture PROPOSED** (P-002) — requires a separate backend (P-003, challenges D-003).
- Owner-approved calendar display preferences recorded as D-008 (not implemented).
- Issues logged: B2-sync ID collision with AUDIT B2, flaky test I-003, Google refresh delay I-004, v5 colleague
  number scan I-005.
- `npm test` 763/763 (one flaky failure of S6 on the first run).
- Created `docs/PROJECT_STATUS.md`, `docs/NEXT_STEPS.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`,
  `docs/SESSION_LOG.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`. No production change, no deploy,
  no feed access.


## 2026-10-15 — final release handover checkpoint

Codex final handover: read Claude's existing reports and current Git/preview metadata; preserved all pre-existing content. Full suite 918/918, check:offline current, diff check passed. Desktop offline harness failed twice at initial controller readiness despite 73 cached assets; no fix attempted. Verified Condor labels in source/tests and the public preview profile. Staged 75 files locally outside Git; prepared the release/device checklist. No production roster/feed/provider request, credential output, code change, commit, push or deployment.


## 2026-10-15 — release prerequisites follow-up

Continued v2-redesign @ d9d3706, preserving existing uncommitted work. Deterministically reproduced activated-but-uncontrolled startup during navigation, added bounded claim recovery and regression. Prepared synthetic flight/Radar scenarios via real handlers with no live bindings or credentials. Full suite 923/923; 73-asset integrity, normal/protected offline, root/subpath race, A→B update and rollback PASS. Local artifacts and detailed findings in RELEASE-PREREQUISITES.md. Physical iPhone and remote publication remain pending. No commits, pushes, deployments, provider calls, production or authentication-setting changes.


## 2026-10-16 — iPhone layout remediation (local only)

Owner-reported iPhone 13 mini findings investigated locally. Added a network-free browser regression fixture using the actual Flight Detail renderer/styles; reproduced arrival-column overflow at 375 px. Corrected scoped CSS and regenerated offline shell. Radar investigation reused recorded HTTP evidence and local generated-backend timing; no new remote/provider requests or changes. No commit, push or deployment. Detailed measurements and screenshots retained outside the repository.


## 2026-10-16 — local service-worker diagnostics

Implemented local About diagnostics and 11 focused regression tests. npm run build and npm run check passed; npm test 940/940, no failures/skips. Local browser showed intermediate controller e4677d59595445558f27 with a distinct waiting update, then final controller 882166161364bd0a9c0f after normal client closure/reopen. No saved roster in this browser: diagnostics correctly withheld offline readiness. Verified 375px light / 393px dark layout without horizontal overflow. Existing dirty tree preserved; no backend, credential, provider, remote, commit, push or deployment operation. Physical-device testing remains owner-only.


## 2026-10-16 — responsive-layout follow-up (local only)

Approved local responsive follow-up implemented on v2-redesign, HEAD d9d3706, preserving existing dirty work. Used the prior iPhone investigation report. Changed components/screens CSS, destination/horizon views and screen mount cleanup; added focused hotel/pixel-fit/observer-cleanup tests plus a network-free browser matrix. Full tests 945/945; build/check pass with 74 assets and worker d34c49e1c3955d525def. Browser 24 cases / 408 assertions pass at 375/393px and 100/125/200% root text, both themes and Local/UTC; visual checks and live resize also performed. Synthetic fixtures only, no provider requests or remote changes. No commit/push/deploy. Physical-iPhone testing and release approval remain outstanding.


## 2026-10-16 — durable sign-out correction (local only)

Corrected the confirmed unchecked sign-out marker on v2-redesign at d9d3706. Added nine synthetic fault/restart/race regressions; six failed against the pre-fix implementation. Focused checks 202/202 and full regression 954/954 passed. Regenerated static manifest: worker 807357dcd3bb9ef3e92e, 74 assets; worker lifecycle source unchanged. Retained all unrelated working-tree changes. No browser session, real credential, backend, provider or production resource accessed; no commit/push/deploy. Separate publication approval and sign-out/reset device acceptance remain required.


## 2026-10-24 — Crew Intelligence Phase 1d.2C live validation documented

Before the run (cloud agent, 2026-10-23): read-only preflight of the isolated Apps Script package; two test-only fixes committed and pushed as `962644f` (exact first-line calendar marker; S12 deny-list hash normalized), plus regression tests; diagnosed the 123 Node 22 failures as the missing Web Locks API (Node 24.22.1: 1379/0). The owner ran the live validation by hand, using two isolated projects and two synthetic calendars (the build commit used is not recorded here). Owner-reported: 75 events seeded; S0–S5 and S13 7/7; S6 1/1 after the owner repaired an S5 baseline that an extra `fctRunSmoke` had overwritten after the schedule change (a sequencing error, not a Crew API defect); S7–S12 6/6; 75 events removed, 0 kept; repair function and `FCT_SEED_CONFIRM` removed; Seeder authorization revoked. This session updated the documentation only (`CREW-GAS-TEST-SETUP.md` status, §6 warning and §13; `PROJECT_STATUS.md`, `NEXT_STEPS.md`, this log). No code change, Google access, deployment, commit or push. Production remains NO-GO.

## 2026-10-24 — Phase 1d.2C teardown completion

Owner reports both test calendars and both temporary Apps Script projects deleted,
both OAuth authorizations revoked, and `~/fc-gas-test-package` removed. Local filename
scans reportedly found no matching temporary credential files; this is limited to the
scan scope and does not establish absence of all credential copies. Clipboard cleanup
was confirmed by owner-provided Terminal output. Earlier cleanup removed 75 synthetic
events, the temporary S6 repair function and `FCT_SEED_CONFIRM`.
Local `v2.1-dev` was fast-forwarded to the existing documentation commit `e7d98b6`;
the owner-provided Git output showed a clean, synchronized working tree before this
follow-up. This update changes documentation only. No new tests or production
operations are performed by this update. Production remains NO-GO.

## 2026-10-24 — Reconciled crew release-readiness checkpoint

Reconciled owner-provided Terminal evidence, inspected GitHub source and
documentation, and incorporated the owner's supplied final Claude Cloud
report. Claude's `e7d98b6` recorded validation with teardown still pending;
local `3c9e6a3` records the subsequently completed teardown.
The owner also supplied 353/353 focused test results on Node v26.7.0.
Fetched production Git reference: `a3008d2`; direct candidate tree difference:
127 files. Installed backend version and served frontend were not verified.
No fresh Google resources, production operations or tests are introduced
by this documentation checkpoint. No commit or push by this update.

## 2026-10-24 — Backend baseline and proposed release scope

Recorded the owner's Version 29 deployment report and the supplied editor
file-list evidence, preserving their verification limits. Documented the
proposed combined six-file backend update and frontend-first release order.
No production access or modification was performed by this update.
Scope selection remains pending; production remains NO-GO.


## 2026-10-26 — Bounded completion, manual cutoff and enrollment corrections

On v2.1-dev/e76f9b8, preserved all prior committed implementation/documentation and made only
the approved corrective pass. Zero-work responses can complete only with authoritative remaining,
pending/stale and cleanup checks satisfied; uncovered remains uncovered. Manual sessions use one
server-minute cutoff signed for the grant/generation and echoed unchanged, independent of device
clock; strict response validation and legacy missing-cutoff stop added. Enrollment waits five seconds.
Documented >10-minute background diagnostic clearing and planning/cleanup/accounting costs.
No target changes or overhead subtraction. Timestamp-precision regression found during testing
was corrected; 271 affected tests passed, zero failed/skipped on Node v26.7.0; 13 hygiene/offline
checks passed, build/diff checks passed. Worker 45f917d2fb0f2f3bc14e; see CREW-DIAGNOSTICS.md
for source hash and limits. No full-suite rerun. Existing physical evidence, C3 exception,
unexplained Safari discrepancy and patched-preview distinction remain; device session paused.
Next: owner reviews this uncommitted correction. No backend requests, production access, commit,
push or deployment; production NO-GO.


## 2026-10-26 — Signed-cutoff expiry correction and final review

Preserved the complete uncommitted corrective pass. Added server entry-time expiry at age
>=285,000 ms (180 s session +45 s in flight +60 s minute-floor allowance), before indexing work.
No silent renewal: refusal stops the client and an explicit new manual session is required.
Signature, grant/generation binding, final authorization, freshness and all acceptance thresholds
remain unchanged. Deterministic expiry, future-signed timestamp, replay and minute-boundary cases
pass: 193 affected tests, zero failures/skips on Node v26.7.0; a tightened exact refusal assertion
also passed in one focused rerun. Thirteen hygiene/offline tests passed; build/offline/diff checks
passed. Worker unchanged at 45f917d2fb0f2f3bc14e; backend hash recorded in CREW-DIAGNOSTICS.md.
Final expiry review found no remaining concrete defect. Entry-time expiry does not interrupt
already admitted work; bounded continuation replay still requires ordinary access. No live claims.
Next: owner review of the preserved 14-file corrective diff. Device work remains paused; no backend
requests, production access, commit, push or deployment. Production NO-GO.
