# fc.roster v2 backend (Apps Script sources)

Status: **installed (private).** All six v2 files (`CondorAdapterV2.gs`, `CondorCodesV2.gs`, `RosterModelV2.gs`, `AirportsV2.gs`, `RosterApiV2.gs`, `RouterV2.gs`) are installed unchanged in the existing Apps Script project and served by the existing *untitled* ("Unbenannt") deployment, now **Version 27** (Phase 1b + 2: Condor roster-code table, `-` → `unassigned`, five standby symbols; on top of the PDX/SYX zones, the BH-1 router and BH-2 token-protected reads); the /exec URL is unchanged. Script Property `FC_V2_TOKEN` is set (the token lives only in a private local file and Script Properties). The five original project files, the triggers and `PLACES_API_KEY` are unchanged. **Rollback target: Version 26** (then 25, 24); Version 22 is the pre-v2 baseline. Deployment log and verification: `docs/BACKEND-HARDENING.md`.

| File | Role |
|---|---|
| `CondorAdapterV2.gs` | Airline feed configuration and parsing (base zone, flight-title format, description whitelist). Classifies titles with the table in `CondorCodesV2.gs`, read at call time only |
| `RosterModelV2.gs` | Airline-independent contract builder (pure; unit-tested in Node) |
| `RosterApiV2.gs` | `doPost` entry point, token check, read-only Calendar/Sheet access |
| `AirportsV2.gs` | Generated airport → IANA zone table (`node scripts/gen-airports-gs.mjs`) |
| `CondorCodesV2.gs` | Generated Condor roster-code table: raw feed title → canonical concept (`node scripts/gen-condor-codes-gs.mjs`, from `src/airlines/condor/roster-codes.js`). Never edit by hand |
| `RouterV2.gs` | Backend hardening (BH-1 in Version 25, BH-2 in Version 26): the project's only `doGet`. Refuses every GET with JSON and never serves a page. `getStats` by GET only while Script Property `FC_V5_GET` = `open` (BH-2 migration window); otherwise `auth-required`, and token holders use `doPost` `stats` |

Rules the files follow:

- Every helper name starts with `fcv2` and ends in `_` (no collisions with existing project functions; not callable through `google.script.run`). `doPost` is the only public name and checks the token before anything else.
- Calendar ids, the hotel Sheet id and the sync tag are used **by constant name** from the existing project file; no ids, URLs, tokens or personal data are in these files.
- Descriptions: only the hotel block (allow-listed line by line; crew-like lines, name lists and codes end it) and the aircraft line are read. Nothing else from a description is returned.
- Nothing is written: no calendar, Sheet, trigger or property writes (the hotel Sheet is opened read-only, never via `getHotelSheet()`).
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

## Rollback

- Deployment: Manage deployments → untitled → Edit → the previous version (Version 26; then 25, 24, 23) or Version 22 (pre-v2 baseline) → Deploy (instant; same URL).
- Kill switch: delete Script Property `FC_V2_TOKEN` (every v2 call is refused; the app falls back to v5).
- BH-2 GET switch: Script Property `FC_V5_GET` = `open` serves the unauthenticated `getStats` again (instant, no redeploy); deleting it requires the token for every roster read.
- Code: delete the six v2 files listed above (triggers run the current code, so this is the rollback for them).
- App: Settings → Roster contract v2 → Remove token (the app then uses v5 only).
