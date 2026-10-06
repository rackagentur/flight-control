# fc.roster v2 backend (Apps Script sources)

Status: **installed (private).** The four files below are installed unchanged in the existing Apps Script project and served by the existing *untitled* ("Unbenannt") deployment, now **Version 26** (v2 with the PDX/SYX zones, the BH-1 router `RouterV2.gs`, and BH-2 token-protected roster reads); the /exec URL is unchanged. Script Property `FC_V2_TOKEN` is set (the token lives only in a private local file and Script Properties). The five original project files, the triggers and `PLACES_API_KEY` are unchanged, and v5 `getStats` remains operational as the fallback. **Rollback target: Version 25** (then 24); Version 22 is the pre-v2 baseline. Step H (auth and contract verification) passed on 2026-10-05 and was repeated on Version 24; see `docs/BACKEND-HARDENING.md`. The app does not use v2 until the token is entered in Settings (not done yet).

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

1. **Add four files** in the project editor (Files → + → Script), each named exactly as here and
   pasted unchanged: `CondorAdapterV2`, `RosterModelV2`, `AirportsV2`, `RosterApiV2`. New files are
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

## Rollback

- Deployment: Manage deployments → untitled → Edit → Version 23 (v2 without the PDX/SYX zones) or Version 22 (pre-v2 baseline) → Deploy (instant; same URL).
- Kill switch: delete Script Property `FC_V2_TOKEN` (every v2 call is refused; the app falls back to v5).
- BH-2 GET switch: Script Property `FC_V5_GET` = `open` serves the unauthenticated `getStats` again (instant, no redeploy); deleting it requires the token for every roster read.
- Code: delete the four files (triggers run the current code, so this is the rollback for them).
- App: Settings → Roster contract v2 → Remove token (the app then uses v5 only).
