# Combined release — selected for preparation, 2026-10-24

Signed-cutoff expiry follow-up (2026-10-26): server rejects age >=285 seconds before indexing;
no silent renewal. Explicit new manual session required. Client/acceptance budgets unchanged.
Worker remains 45f917d2fb0f2f3bc14e; updated backend hash/evidence in CREW-DIAGNOSTICS.md.
Device work paused; production NO-GO.

Latest local correction (2026-10-26, uncommitted on e76f9b8): worker
45f917d2fb0f2f3bc14e supersedes a6ae289d2a4dace19979 for local preparation only.
Authoritative completion, stable signed server-minute manual cutoff and five-second enrollment
acquisition are corrected. See CREW-DIAGNOSTICS.md for focused validation and compatibility limits.
No acceptance target changes, unsealable-history exclusion or overhead subtraction. Existing C3,
G6/G8, patched-preview qualifications, unexplained Safari discrepancy and paused device session stand.

**Production NO-GO. Local measurement implementation/tests authorized; no commit, push or deployment authorized.**
This is the current release-preparation summary. Earlier dated handovers remain historical evidence,
not current instructions. The owner-approved C3 historical provenance exception below resolves only
that documentation gap; the separately recorded owner-approved G6 substitution and G8 amendment also apply; no other acceptance requirement is waived.

## Current local implementation — 2026-10-26

Owner-approved aggregate diagnostics/bounded continuation are implemented locally; see
[contract, limits and evidence boundaries](CREW-DIAGNOSTICS.md). The fixed eight-call target is
superseded by <=ceil(N/6)+2 attempts and <=180 seconds, with six months/request retained.
Decimal-byte acceptance thresholds are explicit. No real Apps Script measurements were made.
Current local worker **a6ae289d2a4dace19979**:82 precached assets plus sw.js (83 files).
Focused implementation-review P1/P2 correction:147 affected tests and13 hygiene/offline tests
passed on Nodev26.7.0; offline/diff checks passed. Initial opt-in re-arms explicit diagnostic
intent with fresh records before automatic backfill, without weakening access-ending clears.
The cache-duration assertion rejects a hard-coded-zero mutation and excludes hits from network
percentiles. Prior1,395-test full-suite and94-test results remain historical; no full-suite rerun.
These review-finding labels do not close performance gates P1/P2.
New frontend precedes backend; absent optional diagnostics remain compatible. New session
metadata enables bounded continuation; missing metadata stops a partial legacy batch safely.
The historical82-file tree and patched-preview evidence remain distinct from this changed local
candidate. Physical fault/Reset session remains paused at baseline inspection, despite its prior
execution approval. C3/G6/G8 and the unresolved Safari discrepancy are preserved.

## Baseline and scope judgment

Scope-selection checkpoint: locally verified `v2.1-dev` at
`eba88764dacee5746b8434df5dc2733afe2cb064`, clean before this update and three commits
ahead of recorded origin. No fetch or remote request was made.

Historical inventory baseline: `5a7dd1643c7a511d5599d6e15fd23ca94608fd4f`.
The reviewed direct endpoint comparison `git diff a3008d2 5a7dd16` (not merge-base)
contained **127 files, 27,683 insertions, 192 deletions** before documentation consolidation.
The inventory below retains that comparison; it is not a claim about the current HEAD's
whole-tree diff. The later documentation-only commit does not change the runtime selection.
`a3008d2` is the owner-supplied fetched production Git reference, not a fresh observation
of the served frontend. Current source is implemented; production presence is not inferred.

**Owner selected the combined crew + single-flight-information + attribution scope for
release preparation on 2026-10-24**, as recorded in `DECISIONS.md`. The selection covers the
reviewed 15 frontend changes, six backend files and complete 82-file static publication tree.
All release requirements below remain unresolved where indicated; deployment and activation
remain unauthorized. It matches the existing shared router without making a new code variant:
`RosterApiV2.gs` adds both `flight` routing/capability and gated crew routing; `DeparturesV2.gs`
adds response attribution; the four new backend modules supply the implementations.
The earlier gate-only and crew-only proposals are historical alternatives, not the selected scope.
This selection authorizes neither release nor a whole-branch merge.

## Exact runtime selection

Frontend delta selected for preparation against `a3008d2`: **15 files**, all selected together:

- `assets/css/screens.css`
- `src/airlines/condor/crew-copy.js`
- `src/airlines/condor/crew.js`
- `src/airlines/condor/profile.js`
- `src/controller.js`
- `src/crew-runtime.js`
- `src/main.js`
- `src/sources/crew-credential.js`
- `src/sources/crew-service.js`
- `src/sources/crew-v2.js`
- `src/store.js`
- `src/ui/crew-section.js`
- `src/ui/screens/flights.js`
- `src/ui/screens/settings.js`
- `sw.js`

The CSS, Condor profile/copy/presentation, checked storage reads, credentials, memory-only service,
app runtime, controller cleanup, and Settings/Flight Details mounts form one dependency set.
`src/main.js` owns the runtime; visibility/connectivity/storage events drive it. Crew responses
stay in memory; enrollment/deletion credentials have separate durable handling and Web Locks.
The checked-in worker includes the new modules: recorded version `a8024ca318cbf11bb3cb`,
81 asset entries. This is a source read, not a new build/integrity test or served-worker observation.

Flight information, attribution UI, Radar, offline lifecycle and durable roster/sign-out foundations
are already represented in the `a3008d2` Git tree. In particular `src/sources/flight-info-service.js`,
`src/sources/flight-info-v2.js`, `src/ui/flight-ops.js`, `src/ui/screens/radar.js`,
`src/offline-shell.js`, `src/roster-storage.js` and `scripts/service-worker.js` are byte-identical
between the endpoints. They remain runtime dependencies, not new frontend delta files.
This does not establish their current device adoption or backend deployment.

Backend delta selected for preparation: **six files**, under `backend/apps-script/`:

| Operation | File | Reason |
|---|---|---|
| Add | `CrewCoreV2.gs` | Duty/index/storage core |
| Add | `CrewCondorV2.gs` | Condor crew parsing |
| Add | `CrewApiV2.gs` | Enrollment/index/read/revoke, identity gate and live adapters |
| Add | `FlightInfoV2.gs` | Single-flight provider lookup |
| Replace | `RosterApiV2.gs` | Shared routing/capabilities and environment bindings |
| Replace | `DeparturesV2.gs` | Adds attribution to successful responses |

Unchanged backend dependencies: `RosterModelV2.gs`, `CondorAdapterV2.gs`, `CondorCodesV2.gs`,
`AirportsV2.gs`, `RouterV2.gs` are byte-identical to `a3008d2`. Crew uses existing roster duty,
calendar/configuration and timezone helpers. Flight and departures use the existing provider key
through the shared environment. Existing v5 bindings remain required and untouched.
Git parity is not installed-source parity: an owner baseline check must establish compatibility
without copying private source or identifiers into this repository.

## Acceptance and aggregate performance evidence matrix — 2026-10-24

Read-only reconciliation at `eba8876`, retaining the selected combined scope and approved
45 s indexing exception. Current recorded worker: `a8024ca318cbf11bb3cb` (81 assets);
no recovered device/browser report identifies that build. **Missing evidence is not a failed test.**
Sources below are existing records, not checks executed in this checkpoint.

| Requirement | Existing evidence, source and candidate/environment | Classification and smallest follow-up |
|---|---|---|
| Implementation, automated regression, isolated revoke/purge validation | Source/commits `5a4b2ad`, `3b3b56d`, `0814335`, `85a7245`; full suite at `962644f`: 1379/0/2 on Node 24.22.1; owner-focused 353/0/0 on Node v26.7.0. `CREW-GAS-TEST-SETUP.md` §13 records owner-run S0–S13 with synthetic data in isolated Apps Script projects; exact run build not recorded | **Satisfied within recorded scope.** S6 sequencing repair and teardown closed. **C3 resolved by owner-approved documentation exception (2026-10-26; DECISIONS, C3).** Exact execution date, executed build identity and corresponding manifest digests are not recoverable from inspected records. No commit-bound validation claimed; no rerun/recreation solely for provenance. Other acceptance requirements remain |
| Crew UI all states, Light/Dark × 320/390/430 px; capability-absent parity (§14) | **Recovered E6:** 198 PNGs and index rows, all marked `ok`; historical independent Chromium matrix 198/198 and six screenshot samples inspected. Initial Stage B build `fc814c3639295792265f` had behavioral defects; follow-up at `6c814e0b178eb6e8c873` records fixes, 24/24 targeted, 294/294 crew/store and 1244/1244 full suite. `crew-ui.test.js` includes byte-identical Flights markup with crew absent/off/unknown capability | **Historical synthetic UI coverage established; report-location gap closed.** Screenshot index has no build hash; final targeted review did not regenerate screenshots. CSS, crew view/copy and harness are byte-identical from committed Stage B `3b3b56d` to current HEAD. Do not repeat the matrix just because docs changed. Gregory approved the recovered historical screenshot set visually on 2026-10-24 (scope below). Physical/browser cross-tab acceptance remains unestablished; markup parity is not a full-app pixel comparison |
| Flight/gate/Radar/attribution/labels/layout acceptance | E1: iPhone 13 mini, owner-reported iOS 26.7.1; screenshot review confirms gates/revised departure/credit in light mode and Radar error then success; worker/context not established. E2: `d34c49e1c3955d525def`, desktop browser, 24/24 cases and 408/408 layout assertions plus published smoke/Local–UTC. Repository later records prior physical layout acceptance as owner-reported passed | **Historical/partial success.** Earlier overflow/status-bar failures concern an older build, not current-candidate failures. Recover device/context/build-linked approval, dark/missing-state/refresh/label results; do not repeat accepted layout work wholesale. E1's 15–20 s Radar report is not crew latency |
| Offline restart, failure preservation, cross-tab sign-out/reset, updates/rollback, exact worker adoption | `RELEASE-PREREQUISITES.md`: `d5ef75e0f080be14ff62`, desktop Chrome synthetic root/subpath/offline/protected/A→B/rollback PASS. E2 records normal adoption of `d34c49e1c3955d525def`. E3 records 954/954 Node regression at `807357dcd3bb9ef3e92e`, no browser test in fix task; E4 later adoption artifacts still show old `d34c49e1c3955d525def` instead of expected `807357dcd3bb9ef3e92e` | **Historical evidence plus current patched-preview adoption closure:** Gregory confirms Safari and Home Screen control of `0ecef7b232405a096670` (details below). Do not repeat adoption. Saved-roster/offline, sign-out/reset/cross-tab, interrupted-update/rollback and original-candidate acceptance remain distinct gaps; no device model/iOS inferred |
| Pure-core CPU <2 s, 52 months ×45 events (§12) | Spec §16a gives ~0.9 s Node for a different 20-year handler stress run. E5 saved logs give 1,029–15,667 ms for that 240-month workload; exact commit/Node version not embedded. Whole-suite duration is not core CPU | **Exact benchmark evidence missing.** Recover the specified workload's timing record; neither pass nor fail can be inferred from a different workload or noisy suite timings |
| Shards median ≤6 KB, max ≤8 KB; real property accounting/gzip (§9.4a/§12) | E5 Node/fake-store synthetic 51-month history: median 2,940 bytes, max 3,844; spec §9.4a seeds range median 2,684–2,940/max 3,572–3,844. Apps Script smoke used real services but supplies no full-history shard distribution | **Synthetic size target supported; real-store validation gap.** Recover aggregate live shard sizes/accounting only; no raw crew/history required |
| Observed peak ≤450 KB with today's history | Spec §9.4a: old-store 153,177 bytes, calculated admission 176,745. E5 partitioned store after GC 153,648 bytes/57 keys; calculated admission 181,369. E5 20-year stress store 461,817 bytes with 152 months indexed | **Observed representative live peak missing.** Calculated admission and post-GC totals are not peak. The 20-year exhaustion case is not a failure of today's-history target. Recover measured peak with history span and byte-accounting method |
| Commit lock held ≤2 s/month | S0–S13 exercises services; Node/fake-store tests cover lock behavior. No recovered per-month lock-duration report | **Timing gap only.** Recover aggregate lock-held durations and candidate/environment metadata |
| Initial backfill (historical ≤8-call target; superseded by approved history-scaled criterion) | Spec §16a/E5 20-year stress used 27 calls; this is not the representative initial backfill. `CREW-GAS-TEST-SETUP.md` §13.4 explicitly does not establish 50-month timing | **Representative backfill evidence missing.** Recover total calls, wall time, months/events and completion/coverage, without personal payloads |
| Warm `crew` p50 ≤3 s/p95 ≤6 s, ten samples | No ten-sample crew latency record located. E1's Radar 15–20 s and old synthetic provider HTTP timings concern other actions | **Evidence gap, not slow-crew finding.** Recover existing ten aggregate request durations plus candidate/environment; do not substitute Radar data |
| Cooperative server budget ≈15 s; client timeout | `tests/crew-api.test.js` slow fake-clock case documents one in-progress 20 s read and stopping at the next boundary; S0–S13 has no duration distribution. Source config: `crew`, `crewEnroll`, `crewRevoke` 25 s; `crewIndex` 45 s per request, owner-approved exception in DECISIONS | **Configuration/exception closed; live server-duration evidence missing.** Client timeout neither measures latency nor extends server budget. Recover per-call aggregate server durations; no timeout retest |
| Properties quota ≤5% of daily quota on a heavy day | Tests exercise storage safety; no recovered heavy-day operation-count/quota calculation. Synthetic event creation without quota errors is not this quota metric | **Evidence gap.** Recover existing read/write counts, heavy-day assumptions and applicable quota basis; do not infer quota compliance from 75 events |
| Release baseline, immutable backend compatibility, production attribution/link behavior | Owner reports Version 29 (2026-10-07 03:01, timezone unknown); editor file list is not deployed snapshot. `a3008d2` is a Git reference. Release commits `ea20186`/`c7ebd3c` and merge `a867717` document frontend release history, not acceptance or current served state. No production attribution-header verification found | **Owner baseline/authorization gap.** Obtain sanitized existing baseline and response/acceptance records; future production verification remains separately authorized, never inferred from preview success |

Source key (local records are outside Git; no credentials, identifiers, response payloads or
private roster/crew data are reproduced):

- **E1:** `/Users/geezmacb/Documents/flight-control-iphone-acceptance-20261016/ACCEPTANCE-REPORT.md`.
  Initially NOT RUN, then appended owner observations and a review of three synthetic-flight
  screenshots. The later observations supplement the initial run sheet; unfilled rows are not failures.
- **E2:** `/Users/geezmacb/Documents/flight-control-responsive-remediation-20261016/REMEDIATION-REPORT.md`
  and `flight-control-responsive-publication-20261016/PUBLICATION-REPORT.md` under the same Documents root.
  Source baseline `d9d3706` plus local corrections, published worker `d34c49e1c3955d525def`;
  publication says physical acceptance not claimed. Repository later owner reports are retained separately.
- **E3:** `flight-control-durable-signout-fix-20261016/FIX-REPORT.md` and
  `flight-control-signout-publication-20261016/PUBLICATION-REPORT.md` under Documents.
  Fix candidate `d9d3706` plus local edits, worker `807357dcd3bb9ef3e92e`; publication report
  records browser-response injection preventing adoption before stable assignment.
- **E4:** `flight-control-signout-recovery-20261016/stable-adoption-browser.json` and
  `stable-adoption-followup.json` under Documents, read only for aggregate worker/control outcome.
  Both retain the old controller; they do not prove the recovery ultimately failed or succeeded later.
- **E5:** existing `/tmp/fc-1b-crew.log`, `fc-1b-final-crew.log`, `fc-1b-full.log`,
  `fc-1b-final-full.log`, `fc-final81-crew.log`, `fc-final81-full.log`, `fc96-crew.log`,
  `fc96-full.log`. Saved Node synthetic logs agree on storage totals; filenames are not proof of
  commit or runtime version. Test totals range 64–1051 and are historical, not new validation.

- **E6:** existing chat “Verify Flight Control access” (`01a163fc-47a0-7343-a29c-51693d2cee81`),
  Stage B review turn `01a1666a-257b-79d1-8f16-252087cfdfae` and correction verification turn
  `01a1675b-322f-7493-8a28-5acde9e38a5f`. Both used `5a4b2ad` plus uncommitted Stage B changes.
  Initial browser matrix ran in memory with screenshot writes suppressed; the reviewer separately
  viewed six existing synthetic screenshots. Follow-up explicitly did not regenerate the matrix and
  did not exercise real browser delivery of cross-tab events. Its COMMIT READY verdict is local-only.
  Recovered screenshot index (198 rows/198 PNGs, inspected as files, not regenerated):
  `/tmp/claude-501/-Users-geezmacb-Documents-flight-control/e78a78f6-bf6b-437c-b53f-eef2e16255bb/scratchpad/stage-b-shots/index.md`.
  The same scratchpad's `meas.md` is an early Phase 1a draft (717 duties, old single manifest),
  superseded by corrected spec §9.4a and E5; its “peak” label is not new measured live-peak evidence.

Search scope: tracked reports/spec/run sheets and relevant commit bodies; named Flight Control
acceptance/publication/remediation folders under Documents; matching saved logs and top-level
artifact names under `/tmp`, Documents, Desktop and Downloads; then relevant existing review chats
and the exact Stage B scratchpad they referenced. No claim of an exhaustive disk
search. Private reference files, credential files, raw backend response artifacts and personal
roster/crew payloads were excluded. No screenshots were newly opened; E1/E6 visual conclusions are recovered reviewer observations. No tests or live requests were performed.

**Confirmed settings (2026-10-24):** Q4 is confirmed by Gregory and the supplied screenshot
showing “Ausführen als: Ich” (Execute as: Me). Q6 is owner-confirmed: Gregory is the project's
only editor. The screenshot also shows “Zugriffsberechtigte: Jeder” (Who has access: Anyone).
“Anyone” is the observed setting, not a change or new approval. Evidence is owner-provided;
no agent production inspection occurred, and no account email or deployment identifier is recorded.
The screenshot supports displayed execution/access settings only; it does not verify deployed
source, OAuth scopes, the runtime effective-user gate or application authentication.

**Q1 owner-confirmed:** Gregory confirms the previously described private, single-user crew-data
processing is permitted. No supporting policy or correspondence was inspected; this is not
independent legal verification. Permission does not cover multi-user access, sharing or commercial
use. The observed Anyone setting is not the basis for this confirmation. Technical
acceptance, performance evidence, OAuth authorization, source/rollback baselines and explicit
release approvals remain separate gates. Production NO-GO.

Accepted/documented limitations remain separate from missing evidence: recorded duties are not
true lifetime counts; connected missing round trips may evade grouping checks; storage exhaustion
keeps a contiguous recent range and marks older history incomplete; the current rank map is
conservative; service-worker adoption/rollback may require client closure/relaunch (I-006/I-009).
Permanently corrupt crew state/manifest can leave purge incomplete (spec §8.3); do not claim deletion.

Optional investigation, not newly invented release blockers: whether a missing calendar returns
null versus throws; interrupted seeder description atomicity; Calendar UI edit formatting;
additional live interrupted-purge/cross-grant scenarios currently covered in Node. Isolated
`MYSELF` web-app access was never tested because there was no test deployment; this alone
is not a requirement to recreate deleted projects. Q4 execution setting is confirmed; production OAuth authorization/runtime behavior remain unverified.

## Gregory’s visual approval — 2026-10-24

Gregory approved the **198 existing synthetic Stage B PNGs** listed in E6's
`stage-b-shots/index.md`: Flight Details and Settings states, light/dark themes,
320/390/430 px widths, recovered from the scratchpad of the historical Stage B review.
Exact set location:
`/tmp/claude-501/-Users-geezmacb-Documents-flight-control/e78a78f6-bf6b-437c-b53f-eef2e16255bb/scratchpad/stage-b-shots/`.
The local `gallery.html` displays those existing images; it did not regenerate them.
The index records no build hash, so approval identifies this artifact set, not an inferred build.

This closes **owner visual approval of that historical screenshot set only**. It does not approve
later visual changes, physical-device behavior, cross-tab behavior, performance, deployment,
activation or production release. Existing source parity and historical test results do not broaden
this approval. All unrelated acceptance requirements remain open; Q1/Q4/Q6 are owner-confirmed as recorded above; production **NO-GO**.

## 2026-10-25 — Patched-preview physical worker adoption complete

**Completed adoption evidence; persistence results below advance the earlier next action.** Gregory supplied screenshots
and confirmed the browser contexts. Record these as owner-supplied evidence; no new device run
was performed in this documentation checkpoint. Device model and iOS version are not established
for these observations; do not inherit those details from earlier reports.

| Context | Owner-supplied result | Classification |
|---|---|---|
| Safari | Controlling worker `0ecef7b232405a096670`; page controlled; no waiting update; sample-data banner visible | **Adoption complete for patched synthetic preview. Do not repeat** |
| Existing Home Screen preview | Initially `807357dcd3bb9ef3e92e` with an update waiting; after normal closure/reopen, `0ecef7b232405a096670` with no waiting update | **Normal update/adoption complete for patched synthetic preview. Do not repeat** |
| Both contexts at adoption checkpoint | “Not ready · roster persistence not confirmed” | Historical pre-sync observation; superseded for the tested persistence contexts below, not an observed storage failure |

The patched preview hides the floating review dock on Settings only, retains the sample banner
and fictional mode, and shows the dock on other screens. Its staged `src/main.js` and generated
worker differ from original `eba8876` / `a8024ca318cbf11bb3cb`; repository runtime is unchanged.
These observations do not establish original-candidate acceptance, complete device acceptance,
offline readiness, cross-tab behavior, crew performance or production approval. Existing successful
integrity/desktop lifecycle evidence remains valid within its scope. Local sources:
`/Users/geezmacb/Documents/flight-control-preview-20261025/bounded-stable-adoption/REPORT.md`
and `settings-preview/REPORT.md` under the same parent; screenshots/context are Gregory's supplied
observations in this conversation, not invented artifact filenames.

### Why review fixtures cannot close saved-roster acceptance

`src/ui/review.js` stores only scenario selection in sessionStorage. `src/controller.js` generates
`sampleSnapshot` in memory in sample mode; `view().offlineReady` explicitly requires normal data
mode, a saved roster and a ready shell. Normal loading validates source-bound roster responses
and calls `saveRecord`; `src/roster-storage.js` writes and reads back `roster.v1`.
`src/ui/worker-diagnostics.js` distinguishes worker cache readiness from roster persistence.
Therefore reopening fictional review scenes, even offline, does not prove a saved roster survived.
Neither changing the message nor repeating adoption would close this gap. Do not reset storage
or ask Gregory to enter production credentials.

### 2026-10-25 — Authorized fixture-only persistence session results

The existing Step 6.6 synthetic deployment was read-only verified to reference immutable Version 2.
All four complete files in Project History (`Code.gs`, `Fixtures.gs`, `AcceptanceV2.gs`,
`appsscript.json`) matched the SHA-256 hashes in the external
`flight-control-backend-publication-20261016/publication-v2-report.json`. Roster/history bind to
embedded fictional events/rows; provider-shaped replies are generated in memory. No live calendar,
Sheet, external-fetch or production fallback bindings exist; the manifest has empty OAuth scopes
and no library/service dependencies. This is immutable-version evidence, not editor-source inference.
Gregory's user-run preflight passed verified TLS and authenticated `fc.roster` v2 capabilities.
Current fault-mode properties were not read; neither preflight nor source inspection retrieved rosters.

Gregory then performed the separately authorized normal-path fictional sync/offline session on
patched preview `0ecef7b232405a096670`. The permitted request scope was synthetic roster,
automatic history/capabilities and same-target stats/getStats refusal fallback; no network trace
was collected, so individual history calls or absence of all attempted requests are not asserted.

| Context | Observed evidence | Result and limit |
|---|---|---|
| Standalone Safari (owner-confirmed context) | Owner reported fictional roster after sync; supplied About screenshot shows patched worker and “Ready · application and saved roster”. After clarifying a mistaken reopen in the separate Home Screen context, owner confirmed roster reappeared offline after closure/reopen in the original configured browser | Saved-roster/offline restoration passed by owner report; Gregory subsequently confirmed standalone Safari. Earlier screenshot-based context uncertainty is resolved by that confirmation. Last-sync time not supplied |
| Existing Home Screen preview | Owner privately saved synthetic connection while offline, reached Calendar before reconnecting, then reported “Roster synchronized · Last sync 2026-10-24 21:12 (Europe/Berlin) · Available offline”. After instructed offline app-switcher closure and reopening from the existing icon, owner reported roster appeared and repeated the same status/time | Home Screen saved-roster/offline restoration passed by owner report on patched preview. Preserve the displayed timestamp verbatim; do not infer device clock/model/iOS |

Home Screen initially lacked a token because it was a separate, not-yet-configured context; this
was not evidence of lost storage in the first browser. It also lacked review mode. Source inspection
confirmed normal automatic loading returns before networking while offline; both synthetic values
were therefore saved offline, then Calendar was opened before reconnection. No Test/Refresh/reset
was instructed. No adoption checks were repeated. Evidence is the supplied screenshot and owner
messages in this conversation; no additional device screenshots or logs were invented.

Gregory subsequently confirmed the first configured browser was **standalone Safari**. Both
standalone Safari and existing Home Screen saved-roster/offline restoration are therefore closed
for the patched preview, by owner report. Do not repeat these checks or closed adoption.
**Historical initial sign-out attempt: blocked before execution (resumed result below).** Gregory authorized normal synthetic
sign-out and two-tab invalidation. Initial confirmation that both tabs showed a roster was later
qualified: Tab 2 still had the sample banner; Tab 1 had exited review. Tab 1's screenshot shows
“Access token”, “Not loaded yet” and disabled Sign out. The source disables Sign out when neither
a saved token nor saved roster is detected. Gregory confirmed the same Safari profile/context as
the earlier persistence check. No sign-out was invoked; two-tab invalidation, preference retention
and reopening after sign-out were not tested. This is an unresolved conflict with the earlier
Safari restoration report, not proof of data loss or a diagnosed application defect. Preserve the
earlier observation, but qualify Safari persistence acceptance pending resolution; Home Screen's
completed result and all adoption checks remain unchanged. No automatic retry, reconnection,
credential replacement or reset.

**Read-only diagnosis completed (owner-run iPhone Web Inspector):** both existing tabs report
matching preview origin, accessible localStorage and absent `fc.v2.endpoint`, `fc.v2.token.v2`
and `fc.v2.roster.v1` keys. Tab 1 reports review mode false; Tab 2 true. Gregory confirmed regular
browsing/default Safari profile in both. The snippet enumerated key names only; no credential or
roster values were read, no writes or application requests were made by it. This establishes
absence of these keys at observation time, not a storage-access exception. It does not establish
when/why they became absent, historical continuity or a persistence defect. Source-binding
comparison is unavailable with all three keys absent. Earlier Safari qualification remains;
Home Screen's completed result is unchanged. At that diagnostic checkpoint, sign-out was blocked on missing saved state.

### Authorized resumed Safari sign-out/two-tab checkpoint — completed

Gregory authorized one bounded synthetic setup/sync in the existing Safari context, followed by
normal sign-out. While offline, the dedicated synthetic connection was saved privately; both tabs
were placed in normal mode on Calendar. Owner-run key-presence results confirmed matching preview
origin, accessible storage, endpoint/token present and roster absent in both tabs before sync.
After reconnecting, Gregory reported the same fictional roster in both tabs; both key-presence
results showed endpoint/token/roster present and review mode false. No repeated manual sync was
requested. Baseline preferences recorded in both tabs: **System theme, Local time display**.

Gregory invoked Sign out once in Tab 1: no message appeared and its roster disappeared. On focus,
Tab 2's roster also disappeared. Tab 2 then reported normal mode, accessible storage, endpoint
present, token absent and roster absent; System/Local preferences remained. After instructed
Airplane Mode/Wi-Fi-off closure of Tab 2 and reopening at Calendar in the same regular Safari
context, Gregory confirmed roster remained inaccessible and System/Local remained.

**Passed within observed scope:** normal synthetic Safari sign-out, focused second-tab invalidation,
token/roster key removal as observed in Tab 2, offline reopening without roster recovery, and
System/Local preference retention. No separate Tab 1 post-sign-out key probe, account-profile/
remembered-history-key audit, home-base/wake-up comparison or server-side deletion is claimed.
The independent Home Screen context was not signed out or retested. This is patched-preview
`0ecef7b232405a096670` evidence only. The earlier unexplained Safari absence remains recorded and
qualified; this successful setup/sign-out does not explain it or replace the earlier persistence test.

### Authorized physical Safari offline-refresh preservation/reconnect — completed

Gregory approved one bounded five-step session in one regular Safari tab on patched preview
`0ecef7b232405a096670`, using only the verified fixture backend. Other synthetic Safari tab closed;
Home Screen untouched. Synthetic connection saved privately while offline. Pre-sync key-presence
output showed correct origin, normal mode, accessible storage and all three endpoint/token/roster
keys present (including roster already present at this observation; no inference about its origin
or validity before sync). After reconnecting, owner reported fictional roster, last sync **16:46
(Europe/Berlin)** and **Available offline**. No calendar date was supplied for these times.

With Airplane Mode on/Wi-Fi off, Gregory pressed Refresh roster once and reported the 30-second
wait completed with no message. Still offline, owner confirmed the same fictional roster, unchanged
16:46 last-sync and Available offline. Key-presence output again showed normal mode, accessible
storage and endpoint/token/roster present. After one instructed reconnect on Calendar, owner reported
**Roster synchronized · Last sync 16:53 (Europe/Berlin) · Available offline**.

**Passed within observed scope:** physical Safari visible saved-roster preservation across one
manual refresh while offline, unchanged displayed last-sync/readiness during that phase, and
successful automatic reconnect recovery. No measured timeout duration, request/error trace, exact
request count, byte-for-byte roster comparison or malformed/empty-response acceptance is claimed.
No-message is compatible with the UI prioritizing offline status; it does not prove a particular
transport error. Existing automated/browser malformed/empty preservation and reconnect-deduplication
evidence is retained, not rerun. No new adoption, offline closure/reopen or sign-out checks performed.
The earlier unexplained Safari discrepancy remains qualified; this session does not explain it.
Home Screen pass remains unchanged. No backend fault-mode changes, reset or repeat sync instructed.

### Remaining physical response-fault gates — requirement trace, no new tests

The completed one-tab offline-refresh/reconnect checkpoint remains complete within its recorded
scope. The following are existing requirements, not newly inferred tests. `IPHONE-ACCEPTANCE.md`
§2 step 6 explicitly lists timeout, malformed and empty, with saved roster/last-sync unchanged
also after offline relaunch; its pass criterion requires steps 1–10. `STEP-6.6-OFFLINE.md` §Exact
physical-iPhone acceptance checklist step 8 likewise requires timeout/error, malformed and
unexpectedly empty preservation after airplane-mode force-close/reopen. That checklist configures
the installed app in step 2. A2 carries these requirements forward; it does not justify a new
all-context/device matrix. Historical setup instructions do not authorize backend changes now.

| Gate | Exact requirement/source | Existing evidence, not rerun | Why physical evidence / release disposition |
|---|---|---|---|
| Timeout | IPHONE-ACCEPTANCE §2.6: timeout refresh preserves saved roster and last-sync, including offline relaunch; STEP-6.6-OFFLINE physical step 8: timeout/error | `tests/api.test.js` “timeout aborts and reports” tests legacy transport abort/error with a 20 ms injected timeout; `tests/frontend-contract-v2.test.js` covers injected timeout fallback without an existing saved v2 copy. These are not physical saved-v2 timeout preservation. Existing offline browser report covers invalid/empty/auth failures; no specific timed-out physical request established. Recent Safari offline-refresh preservation is completed but has no measured/identified timeout | Explicit physical acceptance requirement; desktop/unit evidence cannot demonstrate this outcome in iOS's installed storage/lifecycle context. **Resolved by owner-approved G6 substitution, 2026-10-26:** completed physical offline-refresh/reconnect plus inspected shared saved-v2 preservation path. Timer-driven abort remains not physically verified; no elapsed-time measurement claimed |
| Malformed | Same §2.6 / physical step 8: malformed payload cannot replace saved roster or last-success time, including offline relaunch | `tests/offline-persistence.test.js` “malformed, incomplete and unexpectedly empty responses leave saved bytes and timestamp unchanged”; `tests/browser/offline.mjs` empty/malformed/auth loop asserts saved bytes unchanged. STEP-6.6-OFFLINE §Review phase 4 records Node/desktop Chrome verification and explicitly disclaims physical iPhone/Safari acceptance | Explicit device acceptance is still missing for malformed-response rejection plus saved-state survival across relaunch. This is integration/lifecycle confirmation, not a claim that validation logic lacks tests. **Unresolved release-acceptance gate**, not optional by default |
| Unexpectedly empty | Same §2.6 / physical step 8: unexpectedly empty response preserves saved roster and timestamp through offline relaunch | Same Node test and desktop browser loop cover empty rejection/preservation. Explicit OFF/leave/standby responses have separate positive Node cases; genuinely empty-roster support is separately documented as a multi-user limitation | Required physical rejection/preservation evidence remains missing; ordinary offline restoration does not exercise rejection of a received empty response. **Unresolved release-acceptance gate**. This does not add a requirement to implement general empty-roster support for this private release |

The requirement basis for physical evidence is the accepted run sheet and its iOS lifecycle/storage
scope, not discovery of a new defect. Missing evidence is not a failed test. The owner approved the narrow G6 timeout-preservation substitution on 2026-10-26 (DECISIONS).
Malformed/empty requirements remain open; no other substitution or deferral is approved. No fresh broad regression, per-device matrix, exact timeout measurement or repeat of normal
adoption/offline restoration/sign-out is justified by this classification. Failure-specific offline
relaunch is the still-open clause, distinct from repeating the completed normal-path case.
All recent device results concern patched `0ecef7b232405a096670`, not original candidate
`a8024ca318cbf11bb3cb`. Earlier unexplained Safari absence and Home Screen pass remain unchanged.

**Current disposition:** G6 timeout-preservation substitution approved; timer-driven abort remains
not physically verified. Malformed/empty-response preservation and Reset remain explicit gates.
G8 parity now permits Settings discovery/opt-in, with unsupported enrollment stopped before
dispatch, explanatory feedback and feature off; unsupported flight-detail crew content stays absent.
Source inspection and existing tests support these behaviors; no fresh physical G8 execution or
live-grant cleanup is claimed. See DECISIONS G6/G8 and CREW-INTELLIGENCE §14.

### Bounded malformed/empty and Reset plan — not executed or authorized

Target only existing patched preview and verified FC66 immutable Version 2. Gregory operates
physical contexts and privately manages the synthetic connection. Keep all unrelated preview
clients closed/offline during fault windows; stay on Calendar/Settings online, never Today/Flights
or external links. No capabilities rerun, adoption, ordinary restoration or sign-out repetition.

1. Before faults, owner records only non-secret selectors FC66_SCENARIO, FC66_FIXTURE and
   FC66_PROVIDER_MODE (including absent-vs-set) without exposing token properties. Require the
   documented usable baseline: effective scenario valid, fixture gate-radar, provider mode gates;
   stop on a mismatch, do not broaden configuration changes. Only FC66_SCENARIO may change.
2. Use existing Home Screen saved fictional roster; record roster visible, last-sync/readiness
   and System/Local or other current preferences. If no usable saved roster exists, stop rather
   than silently repeat setup. Preserve Home Screen's earlier pass as historical completed evidence.
3. Owner sets FC66_SCENARIO=malformed. In Home Screen Settings, Refresh roster once, wait at most
   60 seconds. Expect failure with same saved roster and last-success time. Disable connectivity,
   close/reopen from its icon offline, reach Calendar/Settings, verify same saved roster/time.
   This is fault-specific relaunch required by the checklist, not normal-path repetition.
4. While phone remains offline, restore FC66_SCENARIO to the recorded valid baseline and confirm
   the setting. Then set FC66_SCENARIO=empty for the second fault. Reconnect only on Calendar;
   the single automatic reconnect refresh is this fault attempt (do not additionally tap Refresh).
   Same 60-second bound and preservation check; close/reopen offline once for this fault.
5. Restore the original FC66_SCENARIO state exactly while phone stays offline, including removing
   only this selector if originally absent (not credentials/data). Verify restoration before ending
   the fault window. FC66_FIXTURE/FC66_PROVIDER_MODE and all other properties remain untouched.
6. Reset checks follow only if both preservation cases pass and fixture restoration is confirmed.
   In Home Screen offline, record/change only theme/time to non-default Light/UTC so removal is
   observable; perform the app's two-tap Reset within four seconds. Confirm Cleared, setup state,
   sensitive-state key absence and reset preferences. Close/reopen offline once: no roster returns.
   Expect the nonpersonal cached shell to remain; never manually clear storage. Exact namespace
   emptiness is not a criterion: normal defaults/schema may be recreated by the app.
7. Separately cover Reset's explicit other-tab clause using two normal-mode Safari tabs. Use existing
   saved synthetic state; require same fictional roster, key-presence precondition and Light/UTC
   baseline in both. Stop if absent; a new sync is not implicit. Reset once in Tab 1 while offline,
   focus Tab 2 and verify setup/no roster, token/endpoint/roster absence and default preferences;
   close/reopen Tab 2 offline and confirm no recovery. This tests Reset, not repeated sign-out.

Request scope: synthetic roster for the two fault attempts, any automatic same-target history/
capabilities, and same-target refusal fallbacks; no provider/production calls. Inspection only
uses status and key-presence indicators, not credentials or roster payload exports. Stop on any
loss/replacement of saved roster during faults, changed last-success time, auth/storage error,
unexpected setting/build/context, missed bound or failed reset/other-tab cleanup. No retries.
On any stop after a fixture change, restore only the recorded scenario baseline and verify it;
if restoration fails, stop device requests and report the setting unresolved. No automatic cleanup
or manual reset fallback. Explicit execution approval must include the two temporary scenario
values/restoration and normal Reset deletion in Home Screen and Safari, plus Light/UTC baseline
changes. Defaults after successful Reset are the intended final state; do not re-enroll/reconfigure.
No current backend change or device action. C3 and earlier Safari discrepancy remain unchanged.

Remaining A1 presentation,
A2 failure-preservation and unobserved cleanup details, A3 update/rollback retention, P1–P4 performance and
OAuth/runtime/baseline/release-authorization gates remain open. Original candidate
`a8024ca318cbf11bb3cb`, crew performance and complete release acceptance are not established.
Production remains **NO-GO**. No deployment, fault-mode changes, storage reset, commit or push.

## Historical 2026-10-25 — Initial synthetic preview publication rolled back

The owner authorized only the existing `flight-control-preview` frontend publication, fictional
checks and restoration of its pre-change alias on failure. Candidate `eba8876`, source/staged
worker `a8024ca318cbf11bb3cb`; 82 application files plus unchanged preview configuration. No
staging-derived worker difference. Exact Git/staging/upload inventory checks passed.

The candidate deployment was READY. Immutable and temporarily assigned stable preview responses
matched all 82 application files plus root index (83/83 each). Immutable disposable Chrome
controlled the candidate; 81 cached assets matched, ten light/dark route presentations and the
fictional incomplete-flight/offline-shell checks passed. No external request attempts or page
errors recorded. No backend/provider or application-credential access occurred.

**Adoption check failed:** the pre-seeded stable-origin browser still controlled
`807357dcd3bb9ef3e92e` after normal client closure/reopen, despite candidate bytes being served.
The cause is unresolved; no physical-device failure or general regression is inferred. Restored
the verified pre-change alias as authorized. Rollback verification matched 76/76 responses and confirmed the restored worker controlling the
disposable browser. The stable preview is therefore the restored build, not an accepted candidate publication. No storage clearing or emergency worker was used.

Deployment/rollback identities and detailed results are in the local, untracked
`/Users/geezmacb/Documents/flight-control-preview-20261025/PUBLICATION-REPORT.md` and adjacent
JSON records. The immutable candidate is retained. Project settings were unchanged. Historical
visual approval, Q1/Q4/Q6, timeout exception and closed S0–S13/teardown are unchanged.

**Historical next checkpoint (superseded by the physical-adoption result above):** narrowly diagnose stable-origin worker adoption before another candidate
publication; no blanket tests or further deployment authorized by this result. Gregory may record
Safari/Home Screen About build/readiness/waiting state on the restored synthetic preview using
fictional review mode and normal client closure/reopen only. This is not candidate physical
acceptance. Technical/authenticated/performance and release gates remain open; production NO-GO.

## Finite release checklist — plan only, 2026-10-24

This checklist replaces the previous open-ended evidence-recovery next action and those in
earlier summaries. The evidence matrix remains the source of recorded results; no further general
reconciliation or regression cycle is required. **Nothing below is execution authorization.**
Production remains **NO-GO**. Preserve all seven pending documentation edits.

### Already satisfied

- [x] Safari and Home Screen worker adoption of patched synthetic preview `0ecef7b232405a096670`, owner-supplied screenshots/context. No repeat; does not close saved-roster/offline or original-candidate acceptance.

- [x] Combined scope selected for preparation: 15 frontend changes, six backend files and
  the complete 82-file static tree. This is not approval to merge the whole branch.
- [x] Existing automated/browser results remain valid within the matrix's recorded scope.
  Isolated S0–S13 and teardown are closed; do not recreate those projects or rerun the scenarios.
- [x] Gregory approved the historical 198 Stage B screenshots identified above. Do not regenerate
  them or extend approval to later visuals, device/cross-tab behavior or performance.
- [x] The 45 s `crewIndex`-only timeout exception is approved; other crew requests remain 25 s.
  No timeout retest. Client timeout, cooperative server budget and measured latency stay distinct.
- [x] Q4/Q6 are confirmed as recorded above. The observed Anyone setting is not Q1 clearance.

### Owner decisions

- [x] **D1 — Q1 owner-confirmed:** Gregory confirms the described private, single-user crew-data
  processing is permitted. No supporting policy or correspondence was inspected; no independent
  legal verification is claimed. Multi-user access, sharing and commercial use are outside this
  confirmation. This closes the permission decision only, not execution or release authorization.
- [ ] **D2 — bounded session authorization:** name the candidate, existing HTTPS preview and
  existing measurement target, synthetic/real data boundary, permitted operations and operator.
  Authorize only the missing rows below. No new resources, credential disclosure, production
  feed requests or application changes are implied. Any roster-feed request additionally needs
  permission for automated access and explicit authorization in that execution session.
- [ ] **D3 — release permissions:** approve commit/push, frontend publication, backend update,
  configuration/OAuth changes and owner-only enrollment/backfill separately when their stage is
  ready. Authorization may name several stages explicitly; none is inferred from another.

D1 is closed for the confirmed personal scope; it does not authorize real-data operations. D2 need not
wait for measurements it authorizes. If no suitable existing target is available, stop the
affected work for an explicit target/operation decision; do not recreate deleted infrastructure.
Live §12 measurements that require the selected backend can occur during separately authorized,
owner-only commissioning after frontend then backend publication (see execution steps). They
are gates to general crew activation, not impossible prerequisites to installing that backend.
Such commissioning requires D1 and explicit production authorization; it is not authorized now.

### Missing acceptance evidence — one bounded session

**Entry conditions:** D2 is explicit; record candidate commit/runtime selection, controlling
worker/build, backend version/source identity, device/iOS/browser context, date and data regime.
Use the existing matrix as the fixed run sheet. A directly supplied matching result can satisfy
its row without another run; do not launch another report hunt. Use synthetic device state and
existing fixtures. Preview credentials stay private and must not be production credentials.
If a fixture, measurement facility or target is unavailable, mark that row blocked; do not build
infrastructure, change code or expand the session automatically.

| ID | Smallest remaining work | Pass criterion / evidence to retain |
|---|---|---|
| A1 | One physical-device pass on the recorded iPhone 13 mini / iPhone 15 contexts, Safari and Home Screen, for only missing dark/missing-state, refresh, labels and native scrolling outcomes | Correct gate/flight/Radar/credit and missing-state presentation; no clipping, unchanged `-`/`U` labels, refresh/cancel and Local/UTC behavior as specified. Record context/build and each missing case; credit existing accepted layout results, do not repeat the 198-image matrix |
| A2 | Patched-preview standalone Safari and Home Screen offline restart/restoration passed by owner report (see session above). Normal Safari sign-out, second-tab invalidation/offline reopen and System/Local retention passed (see resumed checkpoint). Physical Safari offline manual-refresh preservation and automatic reconnect recovery passed (no measured timeout or exact request count). G6 physical timeout-preservation substituted by owner decision (abort not physically verified). Remaining: malformed/empty-response cases, unobserved cleanup/preferences and reset | Saved roster and last-sync survive failed refresh; offline shell works; reconnect refreshes once. Sign-out removes sensitive state and retains preferences; reset clears setup/preferences too. No old data returns after offline restart or in the other tab on notification/focus. Safari and Home Screen storage contexts are assessed separately, not assumed shared |
| A3 | Patched-preview normal Safari/Home Screen adoption is closed. Remaining: saved-roster retention across update and interrupted-update/rollback evidence, under an explicitly authorized window | Do not repeat completed adoption. Record actual builds for remaining cases; saved roster survives update, interrupted update retains a usable offline shell, rollback reaches its approved worker. Expected waiting/client-closure behavior (I-006/I-009) is not failure; a blank offline launch or stale sensitive state is a blocker. No new runtime variant solely to rerun historical desktop checks |
| P1 | One exact local pure-core benchmark: 52 synthetic months × 45 events | CPU <2 s; record Node version, candidate, workload and timing method. Existing different-workload timings are not substitutes |
| P2 | One representative initial backfill, collecting all storage/lock/server measurements together | Complete coverage in ≤`ceil(N / 6) + 2` calls and ≤180 s (owner-approved 2026-10-26; N captured once; existing budgets apply); shard median ≤6 KB/max ≤8 KB; observed peak ≤450 KB with today's-history span; lock held ≤2 s/month. Record aggregate months/events, calls, wall time, per-month lock time, peak including staging and key/value accounting, actual gzip/property sizes. Post-GC totals or estimates alone do not pass peak accounting |
| P3 | Ten warm `crew` reads after P2, plus one heavy-day quota calculation from recorded operation counts | p50 ≤3 s/p95 ≤6 s; retain ten durations and percentile method. Count reads/writes, state heavy-day assumptions and applicable documented quota; usage ≤5% daily quota. No full-day load run |
| P4 | Use P2's per-call server durations/boundary observations; no separate timeout or slow-service run | Show cooperative ≈15 s / ≤6-month budget behavior: an in-progress read may overrun, but no further month begins after the elapsed budget. Record overruns distinctly; 45 s client tolerance does not waive server behavior or backfill targets |

P2–P4 require real Apps Script accounting/timing on an authorized target; Node/fake-store
results do not close those gaps. Synthetic-volume measurements must be labelled as such and
cannot silently establish today's real-history peak. If representative real-history evidence
requires owner-only commissioning, carry that precise row forward to the authorized stage.
Retain only sanitized aggregate evidence, never roster/crew payloads or credentials.

**Exit rule:** record pass, observed failure or missing/blocked evidence for each row once.
Missing evidence is not a failed test. A failure stops the affected release stage and yields a
specific fix or explicit specification decision; only the affected check may then be proposed
for repetition. No automatic retries, blanket regression, new screenshot matrix or S0–S13 rerun.

### Release execution steps — future, separately authorized

- [ ] **R1 — candidate and rollback baseline:** fix the selected runtime manifest/build, confirm
  served frontend identity and immutable Version 29 source compatibility through owner-supplied
  records or specifically authorized inspection. Preserve editor/trigger baseline privately;
  identify OAuth scopes/reauthorization and authentication checks. No emails or deployment IDs
  in Git. This baseline is required before production writes, not before synthetic acceptance.
- [ ] **R2 — frontend first:** after applicable A/P evidence and explicit commit/push/publication
  approval, publish only the approved static tree. Where P2–P4 require later commissioning,
  list those conditional gates explicitly and keep crew unavailable. Verify worker adoption and
  retained roster under the authorized publication plan; do not infer serving state from Git.
- [ ] **R3 — backend and controlled commissioning:** separately authorize only the six selected
  backend files on the existing deployment; preserve v5 and triggers. Explicitly authorize any
  necessary OAuth/configuration change and owner-only enrollment/backfill after D1. Collect
  outstanding P2–P4 evidence once here if it could not be obtained on an existing approved target.
- [ ] **R4 — deployment-specific verification and activation decision:** under explicit request
  authorization, verify effective-user/application-authentication behavior, capabilities and
  production attribution/links for the installed release. These checks follow the relevant
  publication; they are not prepublication evidence requirements. Stop/rollback on a blocker.
  General crew activation requires all applicable A/P rows, Q1, baseline and these deployed
  checks satisfied plus explicit owner approval. Otherwise retain NO-GO for activation.

Use the rollback procedure below for R2–R4; rollback execution also needs explicit authorization.
Do not remove crew handlers while required deletion/recovery is incomplete. These stages do not
waive any requirement or authorize production access during this documentation task.

**D2 authorization template (remaining work):** the existing bounded candidate-acceptance/performance
session. The patched-preview physical-adoption result and fixture-only persistence checkpoint above take precedence; adoption is closed. Before execution, Gregory must name the candidate/build, existing HTTPS preview and
measurement target, operator and synthetic/real data boundary, and explicitly authorize the
missing A1–A3/P1–P4 operations applicable to those targets. Preview publication/update/rollback
for A3 requires explicit permission; enrollment/backfill and service reads for P2–P4 also require
explicit permission. No suitable target means that affected row stays blocked, not resource
creation. Production-dependent rows remain deferred to R3/R4 under separate production,
OAuth/configuration and request authorization. No repeat Q1/Q4/Q6 or visual approval is needed.

## Ordered future release and rollback (not authorized here)

1. Combined scope selection is complete for preparation only. Owner reviews this documentation update;
   commit/push authorization remains separate. Follow the finite checklist above: prepublication acceptance
   and later commissioning gates are distinct. No feed or real crew processing is authorized by scope selection.
2. Before any future production write, record the served frontend commit/build and the owner-confirmed
   active web-app version. Preserve the editor source baseline privately and review trigger compatibility.
   Retain Q1 within its owner-confirmed personal scope and verify any necessary OAuth authorization privately; Q4/Q6 are already confirmed. No new identifiers belong in Git.
3. After the prepublication acceptance gates in R2 and explicit frontend release authorization, publish
   the approved frontend first; outstanding deployment-dependent gates remain conditional as listed above.
   Keep crew unavailable until backend capability/configuration permits it; verify worker adoption and
   retained roster against the approved plan. Source Git parity alone is insufficient for this check.
4. With **separate backend authorization**, update only the six selected sources in one version on the
   existing web-app deployment. Existing v5 sync and triggers are outside the edit set. Any owner-set
   crew properties, reauthorization, enrollment/backfill, authenticated smoke checks or provider requests
   require their own explicit scope. Version deployment and crew activation are distinct actions.
5. Web-app rollback reference: **Version 29**, owner reports displayed date **2026-10-07 03:01**, timezone
   unspecified. The editor screenshot shows Departures present and FlightInfo/three Crew files absent;
   it does not show the immutable deployed snapshot. Historical Version 27 was the rollback for the
   earlier departures release, not this selected release scope's baseline.
6. Rolling the versioned web app back to 29 does not restore editor source, properties or trigger behavior.
   Triggers execute current editor code; restore only the privately preserved baseline under separate
   authorization if needed. If crew deletion is pending, follow the approved namespace-safe purge/recovery
   procedure before removing access to crew handlers; incomplete purge is not success. Do not blanket-delete
   v2 files, token properties or crew owner settings as a default rollback.
7. Frontend rollback must follow `STEP-6.6-OFFLINE.md` and `scripts/rollback/sw.js`, with an approved target
   and actual worker adoption checks. `a3008d2` is the candidate Git baseline; the served rollback build
   still needs confirmation. A Git/HTML revert alone does not remove a controlling cached worker.

## Complete endpoint inventory

Every path in the 127-file comparison is assigned below. Support files may remain in development
history; they are not application runtime or Apps Script uploads. A future whole-branch merge would
also bring support/unrelated files into `main`, so it must not be approved as merely the 21-file runtime
selection. Direct ICS parser work is deferred from this release. No candidate branch was assembled.

### Selected frontend runtime delta (15)

- `assets/css/screens.css`
- `src/airlines/condor/crew-copy.js`
- `src/airlines/condor/crew.js`
- `src/airlines/condor/profile.js`
- `src/controller.js`
- `src/crew-runtime.js`
- `src/main.js`
- `src/sources/crew-credential.js`
- `src/sources/crew-service.js`
- `src/sources/crew-v2.js`
- `src/store.js`
- `src/ui/crew-section.js`
- `src/ui/screens/flights.js`
- `src/ui/screens/settings.js`
- `sw.js`

### Selected backend runtime delta (6)

- `backend/apps-script/CrewApiV2.gs`
- `backend/apps-script/CrewCondorV2.gs`
- `backend/apps-script/CrewCoreV2.gs`
- `backend/apps-script/DeparturesV2.gs`
- `backend/apps-script/FlightInfoV2.gs`
- `backend/apps-script/RosterApiV2.gs`

### Deferred unrelated parser (1)

- `core/ics/ics.js`

### Support only — tests, fixtures, tooling and documentation (105)

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `backend/apps-script-test/README.md`
- `backend/apps-script-test/TestFixturesV2.gs`
- `backend/apps-script-test/TestGuardV2.gs`
- `backend/apps-script-test/TestSeederV2.gs`
- `backend/apps-script-test/TestSmokeV2.gs`
- `backend/apps-script-test/appsscript.api.json`
- `backend/apps-script-test/appsscript.seeder.json`
- `backend/apps-script-test/script-properties.template.md`
- `backend/apps-script/README.md`
- `docs/ARCHITECTURE.md`
- `docs/CONTRACT-V2.md`
- `docs/CREW-GAS-TEST-SETUP.md`
- `docs/CREW-INTELLIGENCE.md`
- `docs/DECISIONS.md`
- `docs/FINAL-RELEASE-HANDOVER.md`
- `docs/IPHONE-ACCEPTANCE.md`
- `docs/ISOLATED-PREVIEW-PUBLICATION-PLAN.md`
- `docs/NEXT_STEPS.md`
- `docs/PROJECT_STATUS.md`
- `docs/RELEASE-PREREQUISITES.md`
- `docs/ROADMAP.md`
- `docs/SESSION_LOG.md`
- `docs/STEP-6.6-OFFLINE.md`
- `docs/previews/gate-integration/attribution-desktop-panel-light.png`
- `docs/previews/gate-integration/attribution-mobile-dark.png`
- `docs/previews/gate-integration/attribution-mobile-light.png`
- `docs/previews/gate-integration/desktop-panel-light-refined.png`
- `docs/previews/gate-integration/desktop-panel-light.png`
- `docs/previews/gate-integration/mobile-dark-refined.png`
- `docs/previews/gate-integration/mobile-dark.png`
- `docs/previews/gate-integration/mobile-light-refined.png`
- `docs/previews/gate-integration/mobile-light.png`
- `scripts/build-offline.mjs`
- `scripts/gas-test/build-test-package.mjs`
- `scripts/gas-test/hash-id.mjs`
- `scripts/preview/fc66-handler.gs`
- `scripts/preview/gen-test-backend.mjs`
- `scripts/preview/provider-fixtures.gs`
- `scripts/preview/stage.mjs`
- `scripts/rollback/sw.js`
- `tests/airlines.test.js`
- `tests/attribution.test.js`
- `tests/backend-router.test.js`
- `tests/brand-tokens.test.js`
- `tests/browser/crew-screens.mjs`
- `tests/browser/first-install.mjs`
- `tests/browser/mobile-layout.mjs`
- `tests/browser/offline.mjs`
- `tests/browser/responsive-layout.mjs`
- `tests/browser/rollback-subpath.mjs`
- `tests/browser/update-ab.mjs`
- `tests/calendar-glyph.test.js`
- `tests/components.test.js`
- `tests/condor-display.test.js`
- `tests/condor-unassigned.test.js`
- `tests/crew-api.test.js`
- `tests/crew-b0.test.js`
- `tests/crew-cancel.test.js`
- `tests/crew-core.test.js`
- `tests/crew-credential.test.js`
- `tests/crew-crosstab.test.js`
- `tests/crew-presentation.test.js`
- `tests/crew-routing.test.js`
- `tests/crew-runtime.test.js`
- `tests/crew-service.test.js`
- `tests/crew-ui-async.test.js`
- `tests/crew-ui.test.js`
- `tests/crew-validation.test.js`
- `tests/css-literals.test.js`
- `tests/departures-backend.test.js`
- `tests/departures-frontend.test.js`
- `tests/destination.test.js`
- `tests/fixtures/adb-flight.synthetic.json`
- `tests/fixtures/crew-crosstab-worker.mjs`
- `tests/fixtures/crew-frontend.synthetic.mjs`
- `tests/fixtures/crew-gas-fakes.mjs`
- `tests/fixtures/crew-shared-storage.mjs`
- `tests/fixtures/crew.synthetic.mjs`
- `tests/fixtures/gas-test-fakes.mjs`
- `tests/flight-info-backend.test.js`
- `tests/flight-info-frontend.test.js`
- `tests/flight-ops.test.js`
- `tests/flight-parts.test.js`
- `tests/frontend-contract-v2.test.js`
- `tests/gas-test-package.test.js`
- `tests/gs-harness.js`
- `tests/horizon-layout.test.js`
- `tests/ics-parser.test.js`
- `tests/offline-persistence.test.js`
- `tests/preview.test.js`
- `tests/pull-refresh.test.js`
- `tests/radar-airport.test.js`
- `tests/radar-screen.test.js`
- `tests/rollback-worker.test.js`
- `tests/selection-cues.test.js`
- `tests/shell.test.js`
- `tests/store-checked.test.js`
- `tests/time-display.test.js`
- `tests/token-guard.test.js`
- `tests/token-removal.test.js`
- `tests/tokens.test.js`
- `tests/worker-diagnostics.test.js`

## Complete static publication tree selected for preparation

The 15-file frontend delta is not a standalone upload. Keep unchanged runtime dependencies:
the checked-in worker's 81 asset entries plus `sw.js` give this exact **82-file static tree**.
This inventory is read from source, not regenerated or staged. It excludes docs, tests, backend,
preview configuration and `core/ics/ics.js`; `scripts/build-offline.mjs` is build tooling only.

- `assets/css/base.css`
- `assets/css/components.css`
- `assets/css/screens.css`
- `assets/css/shell.css`
- `assets/css/tokens.css`
- `assets/icons/apple-touch-icon.png`
- `assets/icons/icon-192.png`
- `assets/icons/icon-512.png`
- `assets/icons/icon.svg`
- `index.html`
- `manifest.webmanifest`
- `src/airlines/condor/crew-copy.js`
- `src/airlines/condor/crew.js`
- `src/airlines/condor/profile.js`
- `src/airlines/condor/roster-codes.js`
- `src/airlines/generic.js`
- `src/airlines/index.js`
- `src/airlines/types.js`
- `src/api/appscript.js`
- `src/config/profile.js`
- `src/controller.js`
- `src/crew-runtime.js`
- `src/data/airports.js`
- `src/lib/html.js`
- `src/lib/op-time.js`
- `src/lib/time.js`
- `src/main.js`
- `src/model/calendar.js`
- `src/model/destination.js`
- `src/model/flights.js`
- `src/model/history.js`
- `src/model/horizon.js`
- `src/model/radar.js`
- `src/model/roster.js`
- `src/model/scheduled-flights.js`
- `src/model/state.js`
- `src/model/types.js`
- `src/offline-shell.js`
- `src/roster-storage.js`
- `src/router.js`
- `src/sources/attribution.js`
- `src/sources/contract-v2.js`
- `src/sources/crew-credential.js`
- `src/sources/crew-service.js`
- `src/sources/crew-v2.js`
- `src/sources/departures-service.js`
- `src/sources/departures-v2.js`
- `src/sources/fc-appscript-v2.js`
- `src/sources/fc-appscript-v5.js`
- `src/sources/flight-info-service.js`
- `src/sources/flight-info-v2.js`
- `src/sources/sample.js`
- `src/sources/weather-openmeteo.js`
- `src/store.js`
- `src/theme.js`
- `src/time-display.js`
- `src/ui/attribution.js`
- `src/ui/components.js`
- `src/ui/crew-section.js`
- `src/ui/destination.js`
- `src/ui/duty.js`
- `src/ui/environments.js`
- `src/ui/flight-ops.js`
- `src/ui/flight-parts.js`
- `src/ui/horizon.js`
- `src/ui/icons.js`
- `src/ui/journey.js`
- `src/ui/pull-refresh.js`
- `src/ui/review.js`
- `src/ui/screens/calendar.js`
- `src/ui/screens/controls.js`
- `src/ui/screens/flights.js`
- `src/ui/screens/more.js`
- `src/ui/screens/radar.js`
- `src/ui/screens/settings.js`
- `src/ui/screens/today.js`
- `src/ui/screens/upcoming.js`
- `src/ui/shell.js`
- `src/ui/sync-status.js`
- `src/ui/week.js`
- `src/ui/worker-diagnostics.js`
- `sw.js`
