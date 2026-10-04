# fc.roster v2 backend (Apps Script sources)

Status: **not installed.** These files are implemented and tested locally only. Installing them is a separate step that needs explicit approval (Phase 7 step 3+), after which the deployment and rollback plan below applies.

| File | Role |
|---|---|
| `CondorAdapterV2.gs` | Airline feed configuration and parsing (codes, base zone, description whitelist). The only airline-specific file |
| `RosterModelV2.gs` | Airline-independent contract builder (pure; unit-tested in Node) |
| `RosterApiV2.gs` | `doPost` entry point, token check, read-only Calendar/Sheet access |
| `AirportsV2.gs` | Generated airport → IANA zone table (`node scripts/gen-airports-gs.mjs`) |

Rules the files follow:

- Every helper name starts with `fcv2` and ends in `_` (no collisions with existing project functions; not callable through `google.script.run`). `doPost` is the only public name and checks the token before anything else.
- Calendar ids, the hotel Sheet id and the sync tag are used **by constant name** from the existing project file; no ids, URLs, tokens or personal data are in these files.
- Descriptions: only the hotel block (allow-listed line by line; crew-like lines, name lists and codes end it) and the aircraft line are read. Nothing else from a description is returned.
- Nothing is written: no calendar, Sheet, trigger or property writes (the hotel Sheet is opened read-only, never via `getHotelSheet()`).
- No top-level side effects (Apps Script runs every file's top-level code on every execution, including the existing triggers).

## Install (later, only when approved)

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

## Rollback

- Deployment: Manage deployments → untitled → Edit → Version 22 → Deploy (instant; same URL).
- Kill switch: delete Script Property `FC_V2_TOKEN` (every v2 call is refused; the app falls back to v5).
- Code: delete the four files (triggers run the current code, so this is the rollback for them).
- App: Settings → Roster contract v2 → Remove token (the app then uses v5 only).
