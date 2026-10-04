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

1. Baseline: confirm the project still matches the recorded baseline (file hashes, deployments, triggers).
2. Add the four `.gs` files to the project. The existing five files are not edited.
3. Generate a token locally (for example `openssl rand -base64 32`) and set Script Property `FC_V2_TOKEN` (Project settings → Script properties).
4. Create a new version and edit the existing V2 deployment to use it (the URL stays the same).
5. Verify from the app: Settings → Roster contract v2 → Save and test (capabilities), then a wrong token (must be refused).

## Rollback

- Deployment: edit the deployment back to the previous version (instant).
- Code: remove the four files (triggers run the current code, so this is the rollback for them).
- Kill switch: delete `FC_V2_TOKEN`; every v2 call is refused and the app falls back to v5 automatically.
