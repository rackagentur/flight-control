# Proposed combined release — review checkpoint, 2026-10-24

**Production NO-GO. Documentation review only; no commit, push or deployment authorized.**
This is the current release-preparation summary. Earlier dated handovers remain historical evidence,
not current instructions. No product decision or acceptance requirement is waived here.

## Baseline and scope judgment

Locally verified: branch `v2.1-dev`, HEAD `5a7dd1643c7a511d5599d6e15fd23ca94608fd4f`,
two commits ahead of the locally recorded `origin/v2.1-dev` (`3c9e6a3`, `5a7dd16`).
The four pre-existing documentation edits were inspected and retained in substance.
No fetch or remote request was made. Direct endpoint comparison is
`git diff a3008d2 HEAD`, not a merge-base comparison: **127 files, 27,683 insertions,
192 deletions** before this checkpoint's edits. The earlier 27,617 insertion count
predates the latest committed documentation. Neither count defines release approval.
`a3008d2` is the owner-supplied fetched production Git reference, not a fresh observation
of the served frontend. Current source is implemented; production presence is not inferred.

**Recommendation: select the combined proposal for further release preparation**, conditional
on the requirements below. It matches the existing shared router without making a new code variant:
`RosterApiV2.gs` adds both `flight` routing/capability and gated crew routing; `DeparturesV2.gs`
adds response attribution; the four new backend modules supply the implementations.
A crew-only alternative needs a separately prepared and reviewed router candidate. It is not
this candidate with a different label. Scope approval does not authorize release.

## Exact runtime selection

Proposed frontend delta against `a3008d2`: **15 files**, all selected together:

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

Proposed backend delta: **six files**, under `backend/apps-script/`:

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

## Evidence and release checklist

| Classification | Item and evidence | Remaining action |
|---|---|---|
| Satisfied — implementation | Frontend modules/mounts and backend routes verified directly; tests exist for credentials, cross-tab races, service/runtime/UI and routing | Scope decision only; no feature implementation in this checkpoint |
| Satisfied — isolated validation | Owner-run S0–S13 passed after correcting the S6 sequencing mistake; `CREW-GAS-TEST-SETUP.md` §13 | Closed; do not repeat smoke scenarios |
| Satisfied — teardown | 75 events removed; calendars/projects deleted, both authorizations revoked, package removed, clipboard cleared; filename scans limited to their search scope | Closed; do not recreate infrastructure |
| Satisfied — recorded automated evidence | Full suite at `962644f`: 1379 pass, 0 fail, 2 skipped on Node 24.22.1. Owner's later focused run: Node v26.7.0, 353 pass, 0 fail, 0 skipped, including hygiene | Neither is new testing here; focused output is not full-suite or browser acceptance |
| Existing browser evidence | `RELEASE-PREREQUISITES.md`: desktop Chrome first-install/root/subpath, offline/protected simulation, A→B and rollback passed. `PROJECT_STATUS.md` historical responsive entry: 24 cases / 408 assertions | Retain results at their recorded candidates; old readiness/fixture failures are resolved, not fresh blockers |
| Existing device evidence | 2026-10-16 records: owner reported gates/terminals/times/credit working and later prior physical acceptance passed | Preserve that report; it does not identify acceptance of later durable-sign-out and crew candidate |
| Missing acceptance evidence — explicit requirement | Crew spec §14: capability-absent parity and all UI states in light/dark at 320/390/430 px. `tests/browser/crew-screens.mjs` exists, but no completed run/owner visual approval found in reviewed tracked docs or commit records | Recover the existing report/screenshots if available before proposing any new run. Harness existence is not execution; it renders pure views without app bootstrap/storage/worker/network |
| Missing acceptance evidence — explicit requirement | Final candidate Safari/Home Screen acceptance, current build adoption, sign-out/reset/offline and crew integration not established by reviewed records | Recover candidate-linked device results; if absent, propose a separately authorized acceptance plan using the existing run sheet, not a repeat of S0–S13 |
| Blocker — owner decision Q1 | Crew spec §15/§17: airline-policy, works-agreement and data-protection clearance unresolved | Owner supplies clearance; no real crew processing before it |
| Blocker — owner confirmation Q4/Q6 | Production execution as owner and sole-editor assumption unresolved | Owner confirms production settings privately; isolated editor execution is not proof of web-app execution identity |
| Missing evidence — explicit requirement | Crew spec §9.4a/§12/§14 retains real property accounting/gzip/history capacity, peak ≤450 KB, shard median ≤6 KB/max ≤8 KB, commit lock ≤2 s/month, initial backfill ≤8 calls and ≤3 min, warm read p50 ≤3 s/p95 ≤6 s (10 samples), cooperative server budget ≈15 s and properties quota ≤5% on a heavy day | Recover safe aggregate measurements; if absent, agree a separately authorized measurement plan or explicit specification revision. No requirement silently waived and no testing authorized here |
| Specification discrepancy — explicit decision | `src/sources/crew-service.js` configures ordinary `crew`, `crewEnroll` and `crewRevoke` requests with `CREW_TIMEOUT_MS = 25000` (25 s), but each `crewIndex` request with `CREW_INDEX_TIMEOUT_MS = 45000` (45 s). Crew spec §12 states a client timeout <30 s: ordinary requests meet that configured target; indexing does not | Decide explicitly whether to retain the target and authorize a later code correction, or approve a specification revision for indexing. Neither is authorized or resolved here; no new test cycle |
| Blocker — release authorization/baseline | Combined scope and final release approvals absent; served frontend identity and immutable Version 29 source parity not independently verified | Scope decision first, then owner baseline/acceptance evidence and separately approved release stages |

Timeout configuration is verified from source, not measured response latency: the four request
paths pass the constants above as `timeoutMs` to `post` (default `postContract`). The indexing
limit applies to each request, not the whole backfill. A 25 s or 45 s configured timeout does
not establish warm-read percentiles, observed server duration or total backfill time. Those
measurement requirements remain open independently. The 45 s indexing configuration conflicts
with the specification's <30 s client-timeout target even if observed responses were faster;
passing latency measurements alone would not resolve that discrepancy. The cooperative ≈15 s
server budget is separate again and can be exceeded by an in-progress Calendar read (§7.5c).
Production remains NO-GO; no target is waived and no application change is made here.

Storage evidence is **not absent altogether**: spec §9.4a records 51-month synthetic bodies
146,100 bytes, store 153,177 bytes and median/max 2,940/3,844 bytes (seed 7).
The 176,745-byte replacement admission number is calculated, not an observed peak.
§16a records partitioned-manifest storage 153,648 bytes (57 keys), and a 20-year synthetic run
with 152 months indexed, 461,817 bytes, 27 calls, about 0.9 s Node CPU.
That stress run is not the required initial-backfill timing result. The isolated run's §13.4
explicitly does not establish 50-month index timing; §13.5 does not certify peak/backfill targets.

Accepted/documented limitations remain separate from missing evidence: recorded duties are not
true lifetime counts; connected missing round trips may evade grouping checks; storage exhaustion
keeps a contiguous recent range and marks older history incomplete; the current rank map is
conservative; service-worker adoption/rollback may require client closure/relaunch (I-006/I-009).
Permanently corrupt crew state/manifest can leave purge incomplete (spec §8.3); do not claim deletion.

Optional investigation, not newly invented release blockers: whether a missing calendar returns
null versus throws; interrupted seeder description atomicity; Calendar UI edit formatting;
additional live interrupted-purge/cross-grant scenarios currently covered in Node. Isolated
`MYSELF` web-app access was never tested because there was no test deployment; this alone
is not a requirement to recreate deleted projects. Production identity/authorization remains Q4.

## Ordered future release and rollback (not authorized here)

1. Owner reviews this documentation diff and selects combined scope (or requests a new crew-only proposal).
   Commit/push authorization remains separate. Close or explicitly revise the listed acceptance requirements;
   recover existing evidence first. No feed or real crew processing is authorized by scope selection.
2. Before any future production write, record the served frontend commit/build and the owner-confirmed
   active web-app version. Preserve the editor source baseline privately and review trigger compatibility.
   Confirm Q1/Q4/Q6 and any necessary OAuth authorization privately. No new identifiers belong in Git.
3. After acceptance and explicit frontend release authorization, publish the approved frontend first.
   Keep crew unavailable until backend capability/configuration permits it; verify worker adoption and
   retained roster against the approved plan. Source Git parity alone is insufficient for this check.
4. With **separate backend authorization**, update only the six selected sources in one version on the
   existing web-app deployment. Existing v5 sync and triggers are outside the edit set. Any owner-set
   crew properties, reauthorization, enrollment/backfill, authenticated smoke checks or provider requests
   require their own explicit scope. Version deployment and crew activation are distinct actions.
5. Web-app rollback reference: **Version 29**, owner reports displayed date **2026-10-07 03:01**, timezone
   unspecified. The editor screenshot shows Departures present and FlightInfo/three Crew files absent;
   it does not show the immutable deployed snapshot. Historical Version 27 was the rollback for the
   earlier departures release, not this proposed release's baseline.
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

## Complete proposed static publication tree

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
