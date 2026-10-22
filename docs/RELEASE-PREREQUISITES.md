# V2 release prerequisites — 2026-10-15

**Local technical checks PASS; isolated-preview candidate ready for review. Production remains NO-GO pending physical-iPhone acceptance and explicit release approvals.** Branch `v2-redesign`, HEAD `d9d3706`, unchanged. No commit, push, deployment, production request, provider request, credential access or remote configuration change occurred.

## Readiness root cause and correction

The handover failure was real but timing-dependent: the unchanged offline harness passed on this session's first rerun. A controlled reproduction then held the first install's CSS fetch, started a navigation, allowed activation/`clients.claim()` to finish while the navigation document was not yet execution-ready, and finally released that document. Before the fix, Chrome reported `active: activated`, `controlled: false`. The initial claim had missed the pending navigation; registering the already-active worker did not claim again. This explains how complete Cache Storage and an absent controller can coexist. It is desktop evidence, not a claim about a reproduced iOS defect.

`src/offline-shell.js` now asks an activated worker once to recover control of an uncontrolled page after registration. The worker accepts only an in-scope window request, with a complete cached shell and no installing/waiting update. It does not skip waiting, reload the page, cache API data, or declare readiness on activation. Readiness still requires the controlling worker's cache acknowledgement and successful roster persistence. Existing update and asset-hash rules remain intact.

`tests/browser/first-install.mjs` deterministically enforces the navigation/activation ordering at `/` and `/flight-control/`; both recover, report a complete shell and reload offline. The test does not make the race disappear by changing the original offline harness's setup.

## Synthetic provider fixtures

The newer local `scripts/preview/gen-test-backend.mjs` previously omitted the `flight` and `departures` handlers. It now includes those unchanged pure handlers, injecting an in-memory selector from `scripts/preview/provider-fixtures.gs`. Live calendar, spreadsheet and HTTP environment bindings and the v5 router are excluded from generated source. No provider key is read or needed; the non-secret selector marker only enables capabilities. No URL is fetched. The emitted manifest's existing settings are unchanged; remote permissions were not inspected or altered in this task.

The fixture uses the existing roster generator and its day shift, without modifying classification, timezone logic or roster timestamps. Gate lookups match invented roster flights and the departure airport's local date; unknown/wrong dates cannot borrow gates. The real validators/adapters accept the resulting existing v2 wire formats, including attribution.

| `FC_TEST_PROVIDER_MODE` | Flight detail | Radar |
|---|---|---|
| `gates` (default) | Separate departure `A 24` / terminal `1`, arrival `12` / terminal `B`; delayed provider departure separate from roster time | Scheduled synthetic departures, attribution |
| `missing` | Departure has live quality but no gate (pending); arrival basic quality without gate (unavailable) | Missing destination/status stay unknown |
| `stale` | Four-hour-old fetch and eight-hour-old provider update; stale indicator | Four-hour-old fetch timestamp |
| `not-found` | Valid `found:false`, no borrowed gate | Valid empty departure list |
| `provider-error` | Existing `provider-unavailable` error | Existing `provider-unavailable` error |

`FC_TEST_MODE=valid|timeout|malformed|empty|auth` remains independent for roster acceptance. Timeout injection now follows successful authentication/contract processing, so unauthenticated calls do not enter the artificial wait. There is no provider/history response cache in this test environment, so changing a scenario takes effect on the next actual network request. The frontend's existing throttle/cache still applies: use its manual refresh when enabled, or wait its existing interval; do not change production throttling to run these tests.

Phone cases after approved publication:
- Select `DE9201` FRA–BKK (about four days ahead) and `DE9202` BKK–FRA (about six days ahead, overnight); use their displayed origin-local dates.
- Select the BER `SB90` window (about nine days ahead) for `DE9301`; FRA `RE5` (about twelve days ahead) for `DE9302`. These are explicit invented departures inside the synthetic duty windows, not real operating schedules.
- Cycle all provider modes; verify fresh, missing and old data remain distinct, attribution is visible, and provider failure never changes the roster. Test light/dark and Local/UTC without changing canonical roster times.
- Existing fixed DST fixtures/tests remain the reference for DST acceptance. The newer rolling generator shifts whole UTC days; it is not a new model of airline all-day events at DST boundaries.

## Existing infrastructure — reconciliation before publication

Read the local records for the existing **Flight Control Step 6.6 Synthetic Backend**, project `1OYNAYkBdKnBoehcSf0Gj3p4s8VSuBoX0HGDzfrsYYw66lKH1yRsWRaFw`, in the external preview-preparation directory. Those records say it was published as version 1 with `Code.gs`, `Fixtures.gs`, `appsscript.json`, zero scopes, no services, and `FC66_TEST_TOKEN`, `FC66_FIXTURE`, `FC66_SCENARIO`. Its fixture-only handler supports capabilities/roster/history. This is local record evidence; current remote source/deployment/properties were not accessed in this task.

The newer generator emits `FlightControlTestBackend.gs` and uses `FC_TEST_TOKEN`, `FC_TEST_MODE`, `FC_TEST_PROVIDER_MODE`. **It is not a drop-in update of the older project. Do not paste it over the published source or create another project automatically.** Before publication, approve the chosen existing synthetic project and a reviewed compatibility/migration plan retaining its dedicated test credentials, security settings and rollback version. Do not substitute a production token or add an AeroDataBox key. There is no technical need for paid requests.

The handover's newer public `flight-control-preview` and older protected `flight-control-step66-preview` remain distinct. No cloud project was changed or redeployed; no protection setting was changed. Select one approved stable test origin and retain its current protection. A simulated protected local test does not verify live Vercel Authentication or physical iPhone installation.

## Local artifacts and integrity

Prepared outside the repository, without overwriting the previous handover bundle:

`/Users/geezmacb/Documents/flight-control-release-prerequisites-20261015-r8e0mJ/`

- `site/`: 75 approved static files: 73 precache assets, `sw.js`, preview-only `vercel.json`.
- `synthetic-backend/`: generated source + unchanged generator manifest; no credentials.
- `inventory.json`: SHA-256 for all 77 files, outside both upload trees.

Worker version: **`d5ef75e0f080be14ff62`**. Staging verifies each asset hash and excludes backend, tests, docs, Git and reference files. Re-run inventory verification against the exact selected tree immediately before any later authorized upload. The older staged candidate and deployed preview do not include this fix.

## Verification

- Deterministic before-fix diagnostic: activated worker, no controller. Same ordering after fix: controller present, without a recovery reload.
- `npm run build`, `npm run check`: PASS, 73 verified assets.
- Focused persistence-shell/preview/Condor tests during development; the new fixture tests caught and corrected incomplete fixture metadata before final verification.
- `npm test`: **923/923 PASS**, zero failures/skips (baseline 918; two shell and three fixture regression tests added). Full suite justified by the changed worker lifecycle and repository checkpoint procedure.
- `tests/browser/first-install.mjs`: PASS, deterministic race at root and subpath.
- `tests/browser/offline.mjs`: PASS, including initial readiness, process restart offline, navigation, Local/UTC, pull/manual refresh, reconnection, invalid responses, quota failure, hash-safe asset repair, interrupted update and sign-out/reset/auth transitions.
- Same offline harness with `FC_PROTECTED_PREVIEW=1`: PASS, including anonymous document/asset denial on the synthetic local server.
- `tests/browser/update-ab.mjs`: PASS, old worker remains while B waits; B adopted after close/reopen; roster/settings retained and offline usable.
- `tests/browser/rollback-subpath.mjs`: PASS, worker-aware rollback removes only shell caches/registration, preserves roster/settings and neighbouring app; restored application loaded. Rollback required one relaunch after the worker waited.
- Existing Condor rendering/classification tests PASS: ASCII `-` Strichtag and `U` Urlaub in calendar/key/week and corresponding Today labels, including saved-roster restoration.
- All browser verification was desktop Chrome; external requests intercepted/aborted and synthetic data only. No real iPhone, Google backend or AeroDataBox call is claimed.

Reproduction (use an already installed Playwright):

```sh
node --test tests/offline-shell.test.js tests/preview.test.js tests/condor-display.test.js tests/condor-unassigned.test.js
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright node tests/browser/first-install.mjs
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright node tests/browser/offline.mjs
FC_PROTECTED_PREVIEW=1 PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright node tests/browser/offline.mjs
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright node tests/browser/update-ab.mjs
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright node tests/browser/rollback-subpath.mjs
npm run check
```

## Files changed in this task

Application: `src/offline-shell.js`, `scripts/service-worker.js`, regenerated `sw.js`.

Local test tooling: `scripts/preview/gen-test-backend.mjs`, new `scripts/preview/provider-fixtures.gs`, `tests/offline-shell.test.js`, additions to existing `tests/preview.test.js`, new `tests/browser/first-install.mjs`.

Documentation: this report and appended checkpoints in `FINAL-RELEASE-HANDOVER.md`, `IPHONE-ACCEPTANCE.md`, `STEP-6.6-OFFLINE.md`, `PROJECT_STATUS.md`, `NEXT_STEPS.md`, `DECISIONS.md`, `SESSION_LOG.md`, `ROADMAP.md`. Existing uncommitted gate/attribution and unrelated work preserved; no production backend source was edited by this task.

## Remaining release gates

1. Review these local changes and approve the synthetic-backend compatibility/publication plan and exact isolated preview target. No remote operation is authorized by this report.
2. Separately authorize the selected synthetic backend update and refreshed frontend preview upload; verify remote identity, access, response contracts, hashes/CSP and connectivity. Existing previews lack this worker fix and latest gate integration.
3. Perform and record the physical-iPhone run sheet, including gates/Radar, labels, Home Screen install, airplane-mode force-close/reopen, Local/UTC, failed refresh, sign-out/reset, A→B update and interrupted update/rollback. Further preview deployments need their own approval.
4. Approve release scope/visuals and selected commits; preserve unrelated work. Capture real rollback references with separately authorized read access.
5. Production release remains **frontend first**, then separately authorized additive backend update. No production request, paid provider verification, merge, push or deployment is authorized here. Step 6.7 and direct-feed work remain out of scope.
