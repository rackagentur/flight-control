# fc.roster v2 backend (Apps Script sources)

Current status (2026-10-24): **implemented candidate, production NO-GO**.
The owner reports active web-app **Version 29** (displayed 2026-10-07 03:01,
timezone unspecified). This is the proposed release's web-app rollback reference;
immutable deployed-source parity has not been inspected. The editor screenshot shows
Departures present and FlightInfo/three Crew files absent; it is not deployed-source evidence.
The exact combined proposal and outstanding requirements are in
[RELEASE-REVIEW.md](../../docs/RELEASE-REVIEW.md) and the dated scope section below.
Older install/Phase 2/Phase 3 procedures are historical, not authorization to execute them.
Version 27 is the historical departures-release rollback, not the new proposal's baseline.

| File | Role |
|---|---|
| `CondorAdapterV2.gs` | Airline feed configuration and parsing (base zone, flight-title format, description whitelist). Classifies titles with the table in `CondorCodesV2.gs`, read at call time only |
| `RosterModelV2.gs` | Airline-independent contract builder (pure; unit-tested in Node) |
| `RosterApiV2.gs` | `doPost` entry point, token check, read-only Calendar/Sheet access |
| `AirportsV2.gs` | Generated airport → IANA zone table (`node scripts/gen-airports-gs.mjs`) |
| `CondorCodesV2.gs` | Generated Condor roster-code table: raw feed title → canonical concept (`node scripts/gen-condor-codes-gs.mjs`, from `src/airlines/condor/roster-codes.js`). Never edit by hand |
| `RouterV2.gs` | Backend hardening (BH-1 in Version 25, BH-2 in Version 26): the project's only `doGet`. Refuses every GET with JSON and never serves a page. `getStats` by GET only while Script Property `FC_V5_GET` = `open` (BH-2 migration window); otherwise `auth-required`, and token holders use `doPost` `stats` |
| `DeparturesV2.gs` | **Departures present in owner editor evidence; proposed attribution replacement not deployed.** The `departures` action: validates the request, chunks the range into provider windows, normalizes AeroDataBox responses (pure; unit-tested in Node). All I/O (key, `UrlFetchApp`, cache, sleep) is injected by `RosterApiV2.gs` `fcv2LiveEnv_`. No top-level dependency on any other file; replacement in this proposal |
| `FlightInfoV2.gs` | **Not deployed — proposed addition only.** Single-flight provider lookup, routed by `RosterApiV2.gs` under the existing provider key condition |
| `CrewCoreV2.gs` | **Not deployed — do not install.** Crew Intelligence core (Phase 1a/1b, Node tests plus owner-run isolated synthetic validation: `tests/crew-core.test.js`, `tests/crew-api.test.js`); depends on `RosterModelV2.gs` (`fcv2Duties_`). Live backend actions are not authorized. Spec: `docs/CREW-INTELLIGENCE.md` |
| `CrewCondorV2.gs` | **Not deployed — do not install.** Condor crew-list parser for Crew Intelligence (Phase 1b, synthetic). Reuses `CondorAdapterV2.gs` read-only; the installed adapter is unchanged |
| `CrewApiV2.gs` | **Not deployed — do not install.** Crew handlers (`crewEnroll`, `crewIndex`, `crew`, `crewRevoke`), the routing hook, the execution-identity gate and the live env (Phase 1d.2B, local only). The local `RosterApiV2.gs` routes the four actions to it only when all three crew files are present; Node-tested and owner-validated with isolated real services using synthetic data; production remains unverified |

Rules the files follow:

- Every helper name starts with `fcv2` and ends in `_` (no collisions with existing project functions; not callable through `google.script.run`). `doPost` is the only public name and checks the token before anything else.
- Calendar ids, the hotel Sheet id and the sync tag are used **by constant name** from the existing project file; no ids, URLs, tokens or personal data are in these files.
- Non-crew roster descriptions: only the hotel block (allow-listed line by line; crew-like lines, name lists and codes end it) and the aircraft line are read. Nothing else from a description is returned.
- Outbound requests: `UrlFetchApp` is used only by the `departures` and `flight` actions, only toward the flight-data provider (AeroDataBox via RapidAPI). The provider key exists only in Script Property `FC_ADB_RAPIDAPI_KEY` (never in a file, a response or a log); without it these provider actions are not offered in `capabilities`.
- Calendar, Sheet and triggers remain read-only/untouched. Crew handlers do write their scoped state, index and cache; the older “nothing is written” statement applies only to the non-crew baseline. Crew parsing is gated and not authorized for real data in this checkpoint.
- No top-level side effects (Apps Script runs every file's top-level code on every execution, including the existing triggers).

## Install (done: Version 23, updated to Version 24; kept as the procedure for a reinstall)

Pre-checks (read-only): the project still matches the recorded baseline (five files with unchanged
hashes, deployment "untitled" on version 22, triggers unchanged, Script Properties = PLACES_API_KEY only).

1. **Add six files** in the project editor (Files → + → Script), each named exactly as here and
   pasted unchanged: `CondorAdapterV2`, `RosterModelV2`, `AirportsV2`, `RosterApiV2`, `RouterV2`,
   `CondorCodesV2`. `CondorAdapterV2` must never ship without `CondorCodesV2` (every roster/history
   call would throw and the app would fall back to v5). New files are
   appended after the existing ones. Do not edit, rename, reorder or delete any existing file.
2. **Save** (no "Run"). Nothing executes on save; the triggers will load the new files on their next
   run, which only declares constants and functions (verified: no service access at load time).
3. **Token** (never shown, never typed by hand, never committed):
   - Copy it to the clipboard on the Mac: `tr -d '\n' < ~/.config/flight-control/fc_v2_token | pbcopy`
   - Project settings → Script properties → Add property: name `FC_V2_TOKEN`, value: paste. Save.
   - Clear the clipboard afterwards: `pbcopy < /dev/null`
4. **Version and deployment**: Deploy → Manage deployments → the existing *untitled* deployment →
   Edit → Version: *New version* (description "fc.roster v2") → Deploy. Keep "Execute as: Me" and
   "Who has access: Anyone". The /exec URL does not change. Do not touch the "V5.2" deployment.
5. **Verify** (see the checkpoint plan): v5 still works, wrong/absent tokens are refused, the
   correct token returns contract v2, the app uses v2, and the fallback to v5 works.

### Adding `CondorCodesV2.gs` (Phase 1b)

`CondorCodesV2.gs` is a **new file**: add it in the project editor (Files → + → Script, named exactly
`CondorCodesV2`, pasted unchanged) **in the same version as the updated `CondorAdapterV2.gs`**, which no
longer holds the codes. Apps Script appends a new file after the existing ones; that order is correct,
because the adapter reads `FCV2_CONDOR_CODES_` only inside function bodies at call time, never while
loading. Regenerate after any change to the pack table: `node scripts/gen-condor-codes-gs.mjs`
(`tests/condor-codes.test.js` fails when the committed copy is stale).

### Phase 2 deploy note (recognised codes: `-` → `unassigned` (Strichtag), five standby symbols)

Phase 1b and Phase 2 ship **together in one new version**, three files: `CondorAdapterV2.gs` (**unchanged since Phase 1b**; it must still go out in its 1b form because the installed copy is the pre-1b one), `CondorCodesV2.gs` (new, carries the Phase 2 entries) and `RosterModelV2.gs` (changed: `unassigned` day codes and `capabilities.unassigned`).

**The backend MUST NOT ship before the frontend. Order: frontend first, then backend.**

- The frontend maps an event of kind `unassigned` to its own day kind and works against the old backend. The reverse order would send the new event kind to a frontend that does not know it: the contract validator accepts it, but the **current** (older) frontend would show an unassigned (`-`) day as "Duty — duty day without a flight (standby, reserve or ground duty)", which is wrong.
- New consequence of the corrected mapping: the **currently deployed** backend reports a `-` day as `off` / subtype `free`. With the new backend those days become `unassigned` (Strichtag) and stop counting as off days. Frontend first, so the app already has the wording and the day kind when the first Strichtag arrives.
- `--` never occurs in the feed (live trace 2026-10-06); it stays `unknown`.

Rollback is the previous version: Version 26 (Phase 1b + 2 shipped as Version 27 on 2026-10-06).

### Phase 3: `departures` action (deployed as Version 29 on 2026-10-06; rollback Version 27)

Adds provider schedule data (AeroDataBox via RapidAPI) to the existing doPost API. The steps below preserve the historical Phase 3 procedure; they are not pending release instructions. **Order: frontend first, then backend** (an older frontend ignores the new action; the new frontend falls back cleanly while the backend lacks it).

1. **Add `DeparturesV2.gs` as a new file** (Files → + → Script, named exactly `DeparturesV2`, pasted unchanged) **and replace `RosterApiV2.gs`** with the updated copy, **in the same version**. The new file is appended after the existing ones, which is correct: it has no top-level dependency on any other file, and `RosterApiV2.gs` calls into it only inside function bodies at call time. Do not edit, rename or reorder any other file.
2. **Script Property** `FC_ADB_RAPIDAPI_KEY` = the RapidAPI key (Project settings → Script properties; never typed into a file, a chat or a commit; clear the clipboard afterwards). Without it the action stays off (`capabilities` omits `departures`). The action is also off (`departures-not-configured`, not listed in `capabilities`) if `RosterApiV2.gs` is replaced without `DeparturesV2.gs` being present, so a partial deploy never breaks the other actions.
3. **Authorization.** The project already makes external requests (existing project code uses `UrlFetchApp`), so no new OAuth scope is expected. If Apps Script nevertheless asks for authorization on the first run after this version is deployed, review the request and approve it; until the deployment is authorized, `departures` calls fail as `provider-unavailable`. The existing deployment keeps "Execute as: Me" / "Who has access: Anyone".
4. **Version and deployment**: Deploy → Manage deployments → the existing *untitled* deployment → Edit → *New version* (description "fc.roster v2 departures") → Deploy. The /exec URL does not change.
5. **Verify**: `capabilities` lists `departures` and `limits.departuresMaxHours: 24`; one small `departures` request (one airport, one hour); the other actions answer exactly as before.
6. **Rollback**: Manage deployments → Edit → **Version 27** → Deploy (instant). Kill switch without redeploy: delete Script Property `FC_ADB_RAPIDAPI_KEY` (the action goes dark; everything else is unaffected).

### Crew Intelligence (Phase 1d.2B — local only, NOT deployed; needs explicit approval)

- **Deploy order:** frontend first, then separately authorized backend. The current shared-router proposal has **six files**, including `FlightInfoV2.gs` and attributed `DeparturesV2.gs`; see the dated inventory. Crew gates preserve unrelated routing behavior, but the combined proposal deliberately adds flight capabilities and attribution, so a blanket non-crew byte-identity claim is incorrect.
- **Properties (set by the owner in the editor, never in Git):** `FC_CREW_OWNER` (the owner's Google account email; the script must run as this account), `FC_CREW_PEPPER`, `FC_CREW_SELF`, `FC_CREW_ENABLED` = `on`. Without `FC_CREW_OWNER` nothing crew-related runs. Revocation keeps working with the switch off as long as `FC_CREW_OWNER` matches.
- **OAuth authorization:** the chosen execution-identity check (`Session.getEffectiveUser().getEmail()`) requires the Google OAuth scope `https://www.googleapis.com/auth/userinfo.email`. Existing authorization for the installed Apps Script project has not been verified; reauthorization may be required before deploying. Owner-run isolated validation observed the identity gate and required services working; that completed setup has been deleted. Production execution setting is confirmed by owner and supplied screenshot (Q4, 2026-10-24); OAuth authorization and runtime effective-user behavior remain unverified; do not recreate the test projects. No OAuth scopes or production configuration have been changed in this phase.
- **Rollback:** Version 29 is the owner-reported web-app reference; this does not remove editor files or restore trigger code. Resolve pending deletion through the authorized purge/recovery procedure before removing crew handlers. Disabling `FC_CREW_ENABLED` preserves revocation; removing `FC_CREW_OWNER` also stops revocation and is not the default recovery step. No property change is authorized here.

## Rollback

**For the current proposal use Version 29 and RELEASE-REVIEW.md.** The legacy bullets
below describe earlier releases, not a checklist to execute now. In particular do not delete
all six original v2 files or change tokens as the default rollback of this proposal. Editor
restoration and trigger behavior require the separately preserved baseline and authorization.

- Deployment: Manage deployments → untitled → Edit → the previous version (Version 27; then 26, 25, 24, 23) or Version 22 (pre-v2 baseline) → Deploy (instant; same URL).
- Kill switch: delete Script Property `FC_V2_TOKEN` (every v2 call is refused; the app falls back to v5).
- BH-2 GET switch: Script Property `FC_V5_GET` = `open` serves the unauthenticated `getStats` again (instant, no redeploy); deleting it requires the token for every roster read.
- Code: delete the six v2 files listed above (triggers run the current code, so this is the rollback for them).
- App: Settings → Roster contract v2 → Remove token (the app then uses v5 only).
- Crew Intelligence data (not deployed; isolated synthetic purge validation completed): before rolling back to a version without the crew files while a crew deletion is still pending, or when a revocation is stuck at `revoke-incomplete`, run the editor-only purge: Script property `FC_CREW_PURGE_CONFIRM` = `PURGE-ALL-CREW-DATA` → Run `crewPurgeAll` → read the one-line log (`deleted` / `incomplete` / `refused` / `busy` / `error`) → confirm the property is gone. Full procedure: `docs/CREW-INTELLIGENCE.md` §8.3.

## 2026-10-24 — Backend baseline and proposed release scope

Owner reports the existing production web-app deployment is Version 29,
dated 2026-10-07 at 03:01 as displayed; timezone unspecified.
This is owner-confirmed, not independently inspected deployment metadata.

The supplied editor screenshot shows DeparturesV2.gs present and
FlightInfoV2.gs, CrewCoreV2.gs, CrewCondorV2.gs and CrewApiV2.gs absent.
Editor contents are not proof of the immutable Version 29 source snapshot.
No source, properties, triggers or deployment settings were changed.

Version 29 is the recorded web-app deployment rollback reference.
Rolling back the versioned web app must not be treated as restoring editor
source or trigger execution. Preserve the editor baseline separately before
any future authorized source changes.

Proposed backend file set, preserving the reviewed branch's shared router:

| Action | File |
|---|---|
| Add | CrewCoreV2.gs |
| Add | CrewCondorV2.gs |
| Add | CrewApiV2.gs |
| Add | FlightInfoV2.gs |
| Replace | RosterApiV2.gs |
| Replace | DeparturesV2.gs |

This combines Crew Intelligence with single-flight information and provider
attribution. The shared RosterApiV2.gs contains both features.
This is a proposal, not approval to broaden the release or upload files.
All other existing backend files, v5 sync and triggers remain outside the
proposed edit set. Test/preview scripts and the ICS parser are not production
Apps Script upload files.

Release order remains frontend first, followed by a separately authorized,
coordinated backend update. Production remains NO-GO.

Full frontend/static inventory, support-only exclusions, evidence and requirement classification:
[release review](../../docs/RELEASE-REVIEW.md). Scope approval remains outstanding.
