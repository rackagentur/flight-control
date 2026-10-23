# Script Properties for the two FC-TEST projects (template)

Set these under **Project settings -> Script properties** of each project. **Placeholders only in this file:**
real values are generated locally and live only in the test project's Script Properties and a private local file
(never in Git, a chat, a screenshot or a shared document). **Never reuse a production value** (no production
token, no production pepper, no production calendar id, no production owner id): the guard rejects test-format
violations, and production values must never enter these projects.

| Property | Required in | Format | Placeholder | How to generate |
|---|---|---|---|---|
| `FCT_ISOLATED` | api, seeder | exactly `fc-test-isolated-v1` | `fc-test-isolated-v1` | type it |
| `FCT_MARKER` | api, seeder | 32 to 64 lowercase hex | `<32 hex>` | `openssl rand -hex 16 \| pbcopy`, paste, then `pbcopy < /dev/null` |
| `FCT_DENY_SHA256` | api, seeder | comma list of at least 2 distinct lowercase 64-hex SHA-256 hashes | `<sha256 hex>,<sha256 hex>` | hash each PRODUCTION calendar id locally: `pbpaste \| node scripts/gas-test/hash-id.mjs` (copy one id, run, repeat for the other); paste only the hashes |
| `FCT_CAL_FEED_ID` | api, seeder | the calendar id of "FC-TEST Airline Feed" | `<FCT_CAL_FEED_ID>` | Google Calendar -> the calendar's settings -> Integrate calendar -> Calendar ID |
| `FCT_CAL_SYNCED_ID` | api, seeder | the calendar id of "FC-TEST Synced Roster" | `<FCT_CAL_SYNCED_ID>` | same, for the second calendar (must differ from the first) |
| `FC_V2_TOKEN` | api | `fctest_` + 64 lowercase hex | `fctest_<64 hex>` | `printf 'fctest_%s' "$(openssl rand -hex 32)" \| pbcopy`, paste, then `pbcopy < /dev/null` |
| `FC_CREW_PEPPER` | api | `fctest_pepper_` + 64 lowercase hex | `fctest_pepper_<64 hex>` | `printf 'fctest_pepper_%s' "$(openssl rand -hex 32)" \| pbcopy` |
| `FC_CREW_SELF` | api | the synthetic owner id: `99` + four digits + `X` | the fixture's owner is `99` followed by `0000` followed by `X` (seven characters; written here in parts on purpose) | type the seven characters; `fctCheckSetup` reports whether it matches the fixture |
| `FC_CREW_OWNER` | api | the Google account email that runs the project (compared case-insensitively) | `owner@example.invalid` | your own account email (this value exists only in the test project) |
| `FC_CREW_ENABLED` | api | exactly `on` | `on` | type it |
| `FCT_SEED_CONFIRM` | seeder | exactly `SEED-SYNTHETIC-ONLY` | `SEED-SYNTHETIC-ONLY` | type it |

## Properties the runners manage (do not set by hand, except where stated)

| Property | Written by | Meaning |
|---|---|---|
| `FC_CREW_ENROLL` | the smoke runner (S3, S8, S9, S11) | a single-use enrollment code `<code>\|<expires-ms>`; the runner issues and removes it |
| `FC_CREW_STATE` | the crew backend | the durable crew state; S10 replaces it with garbage and restores it exactly |
| `FC_CREW_PURGE_CONFIRM` | you or the smoke runner (S9) | exactly `PURGE-ALL-CREW-DATA` for the owner purge; consumed by the purge |
| `FCT_SMOKE_GRANT` | the smoke runner | the synthetic crew grant of the current run (a throwaway random value) |
| `FCT_SMOKE_BASE` | the smoke runner | the schedule-change baseline (sector id and start time) for the second run |
| `FCT_SMOKE_STATE_BACKUP` | the smoke runner (S10) | a backup of `FC_CREW_STATE` while it is deliberately broken; `fctRestoreState()` puts it back |
| `FCT_SEED_ANCHOR` | the seeder | the local date the fixture was built for; removed by `fctRemoveSeeded()` |
| `FCT_SEED_INSTALL` | the seeder, on its first `fctSeedAll()` | the installation's ownership secret: 32 lowercase hex, generated from `Utilities.getUuid`. **Never set it by hand, never copy it, never log or paste it, never put it in Git.** It proves which calendar events this seeder created (see `docs/CREW-GAS-TEST-SETUP.md` section 6a). `fctRemoveSeeded()` deliberately keeps it, so a later cleanup can still prove ownership and a second cleanup deletes nothing. If it is lost, no existing event is owned any more: the seeder then reports every fixture key as a conflict and cleanup deletes nothing (delete the events by hand). A malformed value is refused (`install-invalid`) |

## Properties that must NOT exist in either test project

| Property | Why |
|---|---|
| `FC_ADB_RAPIDAPI_KEY` | production-only provider key; its presence means the project is not isolated |
| `PLACES_API_KEY` | production-only key; same rule |
| `FC_V5_GET` | production-only switch; same rule |

If any of these three exists, `fctCheckSetup()` reports `production-property` and every request is answered
`not-configured`. The guard also refuses a test token, pepper or owner id in any other format.

## Handling

- Generate on your Mac, paste into Project settings, clear the clipboard (`pbcopy < /dev/null`).
- Keep a private local file (outside the repository) with the test token only if you need it for HTTP calls.
- Never copy a value from the production project's Script Properties.
- Deleting both projects removes every value; also delete any local secret file.
