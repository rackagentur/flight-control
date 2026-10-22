# Isolated iPhone preview — compatibility and publication plan

2026-10-15. **PROPOSED; no compatibility code changes or publication authorized/performed.**
The approved local checkpoint remains `v2-redesign` / `d9d3706` plus preserved working-tree changes,
923 passing tests, worker `d5ef75e0f080be14ff62`, 73 assets. This document is the only repository change in this planning session.

## Selected existing infrastructure

Deployment URLs, account/project/script/deployment identifiers and machine-specific artifact paths are represented by descriptive placeholders below. Resolve them only from the existing private publication records and external artifact inventories, then verify them against the approved isolated resources before any authorized operation. Keep those concrete values outside Git. The command templates are not executable instructions until every placeholder has been replaced and the separate publication approval obtained; stop if any mapping is missing or ambiguous.

Recommend continuing the most recent handover's **flight-control-preview** project:

- Team: `<PREVIEW_TEAM_SLUG>`, `<PREVIEW_TEAM_ID>`.
- Project: `<ISOLATED_PREVIEW_PROJECT_ID>`.
- Stable installed-app origin: `<STABLE_PREVIEW_ORIGIN>`
- Current deployment: `<PREVIOUS_READY_DEPLOYMENT_ID>`, READY.
- Immutable rollback URL: `<PREVIOUS_IMMUTABLE_PREVIEW_URL>`
- Both that stable hostname and `<SECONDARY_PREVIEW_HOSTNAME>` currently point to this deployment.
- Current target is this **isolated project's Production environment**. Real Flight Control production is GitHub Pages / `main`; it is not this project.
- Vercel Authentication and password protection are currently unset. Preserve that state; this is a public, synthetic-only test origin. The older protected `flight-control-step66-preview` is not selected and remains untouched.

These project, protection, deployment and alias facts were read live with the already-authenticated Vercel CLI after the connector returned access errors. No credentials were inspected. The served worker is still `bb0da1729a0edc32e81b`, so it lacks the current candidate. The static worker response has no CSP header and has `Referrer-Policy: no-referrer`; the current staging config likewise contains no CSP. Do not describe this candidate as using the older protected preview's endpoint-restricted CSP. This plan changes no security headers/settings. Adding such a restriction would require a separately approved policy change.

Reuse the existing standalone **Flight Control Step 6.6 Synthetic Backend**:

- Script ID: `<SYNTHETIC_SCRIPT_ID>`.
- Recorded published endpoint (no credential in URL):
  `<EXISTING_SYNTHETIC_EXEC_URL>`
- Recorded version: **1**; web app executes as deployer, access Anyone, application token required before fixtures.
- Recorded manifest: `oauthScopes: []`, `exceptionLogging: NONE`, V8, Europe/Berlin; no libraries, advanced services or triggers.

Backend evidence is the saved publication record, not a new remote Google inspection. The three local original files match its recorded hashes. Before any upload, verify the current remote deployment/version/source/permissions against that record without reading Script Property values. A mismatch pauses publication for review. Do not create a duplicate backend or deploy a new endpoint.

## Smallest compatible solution

**Keep `FC66_TEST_TOKEN` as the sole credential property for the existing backend.** Do not rotate it, copy its value to `FC_TEST_TOKEN`, introduce fallback between keys, or alter authentication settings.

A simple property rename in the new generator is insufficient: the older backend also enforces the test-token format, has different fixture/scenario behavior, and disables exception logging. Wholesale replacement would lose those safeguards and fixture coverage.

Propose an explicit **FC66 compatibility output** from the generator:

1. Keep the existing `Code.gs` authentication boundary: body validation, `fc66_` + 64 hexadecimal configured-token check, comparison, and contract validation before any fixture/provider dispatch. Preserve the existing GET handshake. No token value enters generated source or responses.
2. Preserve the existing `Fixtures.gs` and `appsscript.json` byte-for-byte. Retain `FC66_FIXTURE=mixed|nonflight|dst-spring|dst-autumn` and all existing `FC66_SCENARIO` modes (`valid`, `expired`, `malformed`, `empty`, `server-error`, `throw`), including fail-closed unknown selections and history failure behavior.
3. Add the explicit fixture selection `FC66_FIXTURE=gate-radar`. Only this selection uses the newer rolling roster and synthetic provider handlers. The operator changes this non-secret fixture selector later, only within publication/acceptance approval; it is not controlled by request fields. Default stays `mixed`.
4. Generate `AcceptanceV2.gs` containing the existing pure model/contract handlers and the in-memory provider fixtures, **without a second doGet/doPost entry point or live service bindings**. Its environment binds solely to `FC66_TEST_TOKEN` behind the retained outer check. The generic generator's `FC_TEST_TOKEN` output is never uploaded to this project.
5. Add `FC66_PROVIDER_MODE=gates|missing|stale|not-found|provider-error`, default `gates`, for the new fixture. Pass this selection into the shared provider fixture helper; avoid a second hard-coded credential or property fallback. Reject unknown mode values.
6. In `gate-radar`, advertise only supported actions: capabilities, roster, history, flight, departures. Preserve legacy capabilities in legacy fixture modes. Allow the required flight query and departures range only in the new dispatcher; retain the legacy range restriction for old fixed snapshots. Existing failure scenarios remain outside this dispatch, after authentication, with capabilities behavior preserved.

This preserves the original fixture backend and its security boundary while reusing the tested V2 handlers. It adds no production dependency, OAuth scope, external fetch, provider key or paid API request. No frontend token handling changes are needed: the client already sends the token in the POST body independently of the server's property name.

### Exact proposed file changes (after separate local approval)

| File | Proposed change |
|---|---|
| `scripts/preview/gen-test-backend.mjs` | Explicit FC66 compatibility output; generate pure `AcceptanceV2.gs`, copy the reviewed legacy fixture and manifest unchanged; refuse unrecognized baseline/source boundaries |
| `scripts/preview/fc66-handler.gs` (new) | Retained legacy Code.gs authentication/scenario handler plus the gated new fixture dispatch; becomes candidate `Code.gs` |
| `scripts/preview/provider-fixtures.gs` | Accept injected provider mode so the compatibility output reads only its FC66 selector |
| `tests/preview.test.js` | Compatibility-profile tests, entry-point uniqueness, legacy preservation, wrong-key rejection, unchanged manifest and new fixture/action coverage |
| `docs/IPHONE-ACCEPTANCE.md` and this plan | Exact selector instructions, artifact hashes and final results |

Candidate output goes in a **new external review directory**: changed `Code.gs`, new `AcceptanceV2.gs`, unchanged `Fixtures.gs`, unchanged `appsscript.json`. Do not overwrite the version-1 snapshot. The newer two-file generated backend currently staged is **not an upload candidate** for the existing FC66 project. No application runtime, production backend, worker or static frontend file needs changing for this compatibility step.

## Verification already performed

- Fresh focused run: `node --test tests/preview.test.js tests/flight-info-backend.test.js tests/flight-info-frontend.test.js tests/departures-backend.test.js tests/departures-frontend.test.js`: **206/206 PASS**.
- Includes generated fixture responses accepted by real frontend validators/adapters: separate gates, missing/pending/unavailable information, stale timestamps, not-found/empty results, provider errors, overnight BKK–FRA, correct origin-local dates and Radar windows. Provider failures leave the roster response unchanged.
- `npm run check`: PASS, 73 assets, worker `d5ef75e0f080be14ff62`.
- All 77 hashes in the existing artifact inventory match (75 static files plus two generated backend files).
- Original Code.gs, Fixtures.gs and manifest match the saved version-1 publication hashes.
- Accepted full-suite/browser checkpoint remains 923/923 and the recorded offline/update/rollback passes; those completed audits were not repeated.

The compatibility profile is still a proposal; it is not covered by a claimed pass. After local implementation, test valid/missing/wrong-format/wrong/revoked synthetic tokens, missing FC66 property with only FC_TEST_TOKEN present, all four legacy fixture outputs/scenarios, new mode responses, one doGet/doPost pair, and no external-service access. Use made-up test credentials only. Run the existing standalone fixture verification against candidate copies as well as repository tests. Reconfirm that the frontend worker and all 73 asset hashes remain unchanged.

## Publication sequence — separate approvals, not commands to run now

### 1. Local compatibility approval

Implement and test only the four code/test changes and accompanying documentation above; deliver the four-file backend candidate and hashes for review. No Google or Vercel write is included in this approval.

### 2. Frontend publication approval (frontend first)

Immediately before upload, re-read the selected project/aliases/protection, preserve the current deployment, and verify the exact static tree against its inventory. Stop on any unexpected file/hash/configuration, different project, protection change, or charge. The existing candidate directory is:

`<VERIFIED_STATIC_SITE_DIRECTORY>`

Stage on the isolated project's existing target without moving its aliases yet. These commands require **explicit approval for the isolated project's Production target**, not permission to alter actual Flight Control production:

```sh
VERCEL_ORG_ID="<PREVIEW_TEAM_ID>" \
VERCEL_PROJECT_ID="<ISOLATED_PREVIEW_PROJECT_ID>" \
vercel deploy "<VERIFIED_STATIC_SITE_DIRECTORY>" \
  --scope "<PREVIEW_TEAM_SLUG>" --prod --skip-domain --yes
```

No `vercel pull`, environment copy, Git integration or `--public` flag. The existing CLI session provides authentication. Inspect the returned deployment ID/project/target; fetch all expected assets and compare their hashes, headers, manifest paths and worker version. Verify old-backend compatibility and graceful lack of live information before the backend update. After those checks and within the approved alias scope, promote that exact staged deployment:

```sh
vercel promote "<VERIFIED_NEW_DEPLOYMENT_URL>" --scope "<PREVIEW_TEAM_SLUG>"
```

This updates the isolated project's two recorded aliases; the installed iPhone origin stays `<STABLE_PREVIEW_HOSTNAME>`. Recheck both aliases before promotion and stop if any unreviewed domain appears. Official behavior: [`--skip-domain`](https://vercel.com/docs/cli/deploy#skip-domain) stages without automatic alias movement; promotion completes assignment. No `main` push or GitHub Pages change is involved.

### 3. Synthetic backend publication approval

- Reverify the exact script ID, remote source and current version, keeping a source snapshot and deployment/version reference. Verify no services/triggers/scopes have appeared; inspect no property values.
- Upload only approved candidate `Code.gs` and `AcceptanceV2.gs`; leave matching Fixtures.gs and manifest untouched. Avoid duplicate entry points. Keep all existing credential properties and access settings unchanged.
- Deploy → Manage deployments → select the recorded deployment ID → Edit → New version → deploy. Retain execute-as-deployer / Anyone and the same deployment ID and `/exec` URL. Do not use New deployment or `/dev` for acceptance. [Google's versioned-deployment procedure](https://developers.google.com/apps-script/concepts/deployments) preserves the URL when an existing deployment is updated to a new version.
- Verify unauthenticated and malformed-token refusal, secure positive authentication, capabilities, roster/history and flight/departures responses. Retrieve the existing synthetic credential only through an approved secure local path; never log request bodies/headers or use query-string tokens. No token retrieval is authorized by this planning session.
- Within explicit acceptance approval, set only non-secret fixture/scenario selectors to `gate-radar`, `valid`, `gates`; record the previous selectors for rollback. Exercise the remaining modes with the iPhone run sheet. No FC_TEST_TOKEN property is needed.
- Record individual HTTP 404/redirect/CORS/timeout failures. Do not hide a persistent failure with retries; stop if a clean authenticated browser round trip cannot be established.

### 4. Physical acceptance

Install from the stable origin, confirm worker `d5ef75e0f080be14ff62`, connect only the recorded synthetic endpoint, and use the existing token privately. Complete IPHONE-ACCEPTANCE.md plus gate/Radar modes, labels, Local/UTC, airplane-mode force-close/reopen, failure preservation, sign-out/reset. Desktop success is not physical-device acceptance. A/B updates and rollback execution need their own authorization. Production release remains frontend first and separately gated.

## Rollback (only if authorized)

- Backend: edit the same deployment to its captured prior version (recorded baseline 1, reverify before use), restore only the saved non-secret fixture/scenario selectors, leave the token/access/manifest unchanged. Preserve both versions. Do not delete/rotate credentials or create a new URL.
- Frontend: return the isolated project to the captured READY deployment:

```sh
vercel rollback "<PREVIOUS_IMMUTABLE_PREVIEW_URL>" \
  --scope "<PREVIEW_TEAM_SLUG>"
```

Check project identity before the command and both aliases afterward. Vercel rollback can affect subsequent auto-assignment; inspect that behavior before any later release rather than silently changing settings. Keep the replaced deployment for investigation.
- An alias rollback does not instantly replace a worker already controlling an installed app. Close all clients, reopen online, confirm the rollback worker/build is adopted, then test offline and roster retention. If normal adoption fails, the separate scoped recovery-worker procedure in STEP-6.6-OFFLINE.md is an additional reviewed deployment, not implied permission to clear storage or unregister all site workers.

**Next approval requested: local FC66 compatibility implementation and tests only. No publication, credentials or remote settings changes.**
