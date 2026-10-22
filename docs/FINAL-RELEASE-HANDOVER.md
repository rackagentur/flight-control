# Flight Control — final release handover

Checkpoint: 2026-10-15, Europe/Berlin. No commit, push, deployment, backend change or production setting change was authorized or performed in this handover. All pre-existing working-tree content is preserved. This checkpoint supplements stale status text; it does not supersede product decisions.

## Verified state

- Branch `v2-redesign`, HEAD `d9d3706`. Remote production `main` is `0ae7d58`; GitHub Pages reports `main` at `/`, built. There are 15 local commits beyond that production base, plus uncommitted gate/attribution and separate preview-tooling/documentation work. A gate release is therefore a V2 release, not an isolated widget patch.
- Condor display fix is already committed in `714326e`. Calendar/key/week compact labels use ASCII `-` (Strichtag) and `U` (Urlaub). Today uses Strichtag / No duty assigned and Urlaub / Holiday. A Strichtag remains unassigned, never an OFF day; generic airline wording is unchanged. Rendering/classification tests pass. The currently public test preview serves the same airline profile.
- Full regression: `npm test` **918/918 passed**, zero failures/skips. This includes Claude's gate/attribution work, label rendering and repository hygiene. `npm run check` passes: 73 precache files, worker `afccf85bf30be797cd41`. No worker rebuild was necessary. `git diff --check` passes.
- Gate and attribution implementation remains uncommitted. Existing light/dark/mobile/desktop screenshots are in `docs/previews/gate-integration/`; owner visual approval remains outstanding according to Claude's last handover.
- `flight-control-preview` is the current public synthetic-use test project. Its latest deployment is READY, uses that isolated project's own Production target, and has no Vercel Authentication. This is distinct from production Flight Control on GitHub Pages. Its served worker is `bb0da1729a0edc32e81b`, 68 precache assets: labels are current, gates and attribution are absent.
- The older `flight-control-step66-preview` also exists, with Authentication for All Deployments and both a protected Preview and an isolated-project Production deployment. Do not mix its deployment history/backend setup with the newer project. No protection settings were changed.
- Current source was staged locally as 75 files (73 assets + worker + preview config), with an inventory outside the repository. Nothing was uploaded. The preview config has no-referrer and is for synthetic data only; it must not become production configuration by accident.

## iPhone acceptance preparation

The existing run sheet in `docs/IPHONE-ACCEPTANCE.md` remains the baseline. Use one explicitly approved test project and stable origin throughout; record model, iOS version, build/worker version, test date, and pass/fail notes. Never enter production credentials or roster endpoints on a public preview.

There is an unresolved fixture prerequisite: `scripts/preview/gen-test-backend.mjs` deliberately excludes both provider modules and supplies no provider key or provider fetcher. It cannot exercise `flight` or `departures`, so it cannot prove gate or Radar attribution on iPhone. Before deploying another backend, reconcile the previously published standalone synthetic backend with Claude's newer generated test backend; avoid creating a duplicate unnecessarily. Prepare/review synthetic wire responses for the existing actions, without production data or paid provider calls, then seek explicit approval for any remote backend publication/change. Backend setup/deployment remains unverified for the newer preview.

Add these checks to the existing roster/offline run sheet:

| Check | Acceptance |
|---|---|
| Build identity | Current release worker is active at the stable test origin. Cached old preview is not mistaken for the new build. |
| Labels | Calendar cell, key, week strip and Today show `-` / Strichtag and `U` / Urlaub; Strichtag is not counted as OFF. |
| Gate data | Synthetic departure and arrival gates/terminals stay with the correct airports; overnight/origin-local date matches the intended flight. Roster times remain the reference; changed provider times are separate. |
| Missing/old data | Not assigned, unavailable, not found, stale, delayed/cancelled/diverted cases are distinguishable. No gate or boarding certainty is invented. |
| Refresh | One request per deliberate tap; repeated tap within the 30-second pause does not duplicate it. Failure preserves roster; reopen/back navigation and stale wording remain coherent. |
| Attribution | Light/dark, narrow iPhone and desktop: Flight Detail and Radar credit is readable, focusable, and opens the expected HTTPS destination. Synthetic/sample-mode behavior is labelled correctly. |
| Offline | Successful initial sync, force-close/reopen in airplane mode with Wi-Fi off; Today, Calendar, Flights/detail and Local/UTC still work. A live gate lookup may be unavailable; it must not undermine saved roster access. |
| Security | Sign out and Reset purge the intended data; no late response restores it. Two Safari tabs tested separately from the Home Screen app. |
| Updates | Approved A → B test on the same origin; close all old clients, wait at least five seconds, reopen. Verify new shell, retained roster/preferences and offline launch. Record extra relaunches. Interrupted update keeps a usable old shell. |
| Rollback | Use the prepared rollback-worker procedure, not just an HTML/Git revert; verify recovery and storage preservation on the test origin. |

Do not silently disable Authentication on the older protected project. The newer public project is synthetic-only. A login/install failure on a protected origin is a recorded acceptance result, not approval to weaken protection. The blanket claim in older notes that Safari cookies can never reach an installed app should not be used as justification for changing protection.

## Exact proposed release sequence (each write/publish requires owner approval)

1. Review the existing gate/attribution screenshots and approve the intended V2 release scope. Keep the unrelated ICS investigation, SBX notes and preview-tooling changes separately reviewable. Do not sweep the working tree into a commit.
2. Resolve any browser-readiness failure recorded below; provide the missing synthetic flight/departures fixtures. Finalize the additive `flight`/attribution contract and deployment notes. No production/provider request is needed for this preparation.
3. After approval, commit only the selected release files on `v2-redesign`. Backend set includes **FlightInfoV2.gs, RosterApiV2.gs and DeparturesV2.gs** (the latter carries Radar attribution). Approve any separate prerequisite tooling commit explicitly.
4. Approve a fresh isolated preview upload from the exact release candidate, verify asset hashes/build identity, and finish the physical-iPhone run sheet. A/B updates are separate authorized deployments. Existing preview URLs do not yet validate the latest work.
5. Record the actual current production Apps Script deployment/version and frontend commit as rollback references. Version 29 is documented but not verified here. Confirm existing key configuration privately; do not print it or rotate/delete it for this release.
6. After acceptance and separate production authorization, release **frontend first**, following the repository's standing rule. Fast-forward/merge only the approved V2 candidate into `main` and push; GitHub Pages publishes it. Verify the correct Pages subpath, worker/version adoption and saved-roster retention. The frontend safely reports live information unavailable until the new backend action exists. Claude's earlier backend-first proposal is not adopted silently; reversing this order needs an explicit approved decision.
7. With separate backend authorization in the same coordinated release window, upload only the three reviewed backend files above to the existing backend project, create a versioned update on the same web-app deployment, and preserve the recorded rollback version. No trigger, calendar, Sheet, token or provider-key change is required. Verify `flight` capability, gate display and Radar attribution from an approved authenticated browser/phone session; any live provider request must be explicitly within the approval.
8. Smoke-test production Today/Calendar/Flights/Radar, both labels, Local/UTC, refresh throttling, credit/link behavior, offline restart, sign-out/reset and new worker adoption. Confirm production response headers permit the intended attribution-link referral behavior; the synthetic preview's no-referrer configuration is not evidence of production behavior. Allow/document the existing short client-cache period before fresh attributed data appears.
9. On failure, use the recorded Apps Script rollback and the reviewed service-worker-aware frontend rollback procedure in `docs/STEP-6.6-OFFLINE.md`. A simple revert to a pre-worker frontend is insufficient for devices already controlled by the worker.

Release remains NO-GO until physical acceptance and unresolved browser/fixture prerequisites are closed. Direct ICS ingestion, new code mappings, multi-user onboarding and Step 6.7 are not added to scope.

## Browser result from this handover

`tests/browser/offline.mjs` was run twice in desktop Chrome mobile emulation using only intercepted synthetic requests. Both runs stopped at the initial 60-second offline-readiness wait: the worker was activated and all 73 assets were in Cache Storage, but `navigator.serviceWorker.controller` was absent and the UI correctly said **Offline setup incomplete**. This is a reproduced readiness/verification blocker, not a demonstrated physical-iPhone defect or a proven root cause. Subsequent browser assertions were not reached. It needs focused diagnosis before treating this candidate as ready for device acceptance. No application or test code was changed to hide it. The 918 passing automated tests do not override this result.


## 2026-10-15 — release prerequisites follow-up

The readiness race is now reproduced deterministically and corrected locally. All 923 tests and the root/subpath, normal/protected offline, A→B and rollback browser checks pass. Worker `d5ef75e0f080be14ff62`, 73 assets. Synthetic flight/departures fixtures are prepared and validated without live bindings/provider requests. This supersedes the unresolved local browser/fixture prerequisites above; production still awaits approved publication and physical-device acceptance. Existing synthetic backend property names require an explicit compatibility plan before replacing any remote source. See RELEASE-PREREQUISITES.md for evidence, artifacts and remaining approvals.
