# Crew Intelligence V2.3: isolated Apps Script test (manual procedure)

Status: **PROPOSED. No step below has been performed.** The package was built and tested locally only (Node, fake
services). Nothing was created in Google, nothing was deployed, no network was used. Every step here is for the
owner to run by hand, one step at a time, after review.

Purpose: test Crew Intelligence V2.3 (`CrewCoreV2.gs`, `CrewCondorV2.gs`, `CrewApiV2.gs` and the routing in
`RosterApiV2.gs`) against the **real** Apps Script services (Calendar, Script and User Properties, Cache, Lock,
Session, `Utilities` date and crypto) using **two synthetic calendars**, in two NEW Apps Script projects that have
nothing to do with the production project.

Package sources: `backend/apps-script-test/` (read its `README.md`). Build: `scripts/gas-test/build-test-package.mjs`.
Property list: `backend/apps-script-test/script-properties.template.md`. Local tests: `tests/gas-test-package.test.js`.

**Hard rules for this procedure**

- Never paste any of these files into the production project, and never copy a value out of the production project.
- Never put a calendar id, a token, a deployment URL, the owner's employee number or a colleague's name into a
  chat, a ticket, a screenshot, a commit or this repository. Placeholders in this document: `owner@example.invalid`,
  `<FCT_CAL_FEED_ID>`, `<FCT_CAL_SYNCED_ID>`, `fctest_<64 hex>`, `<FC_TEST_EXEC_URL>`.
- Do not request the Condor/CUBE roster feed. The test uses only the two synthetic calendars.
- The production Apps Script deployment, its triggers and its Script Properties stay untouched.

## 0. Design in one paragraph

Two projects, one generated bundle each. **FC-TEST Crew API** holds the production crew and roster sources
byte-identical, an isolation guard, a hardened environment and the live smoke runner. Its manifest grants
`calendar.readonly` and `userinfo.email` only: at platform level it cannot write a calendar and cannot reach the
network. **FC-TEST Seeder** holds the only write scope (`calendar`), contains no production source, never creates a
calendar, and only creates, updates and deletes **events** inside the two calendars that pass the same guard. It is
deleted after use. The write scope therefore never lives in the project that serves requests.

## 1. Create the two Apps Script projects (owner, in the browser)

1. Open `script.google.com` signed in as the account that will own the test calendars.
2. New project; rename it **FC-TEST Crew API**.
3. New project; rename it **FC-TEST Seeder**.
4. In **both**: Project settings, tick **Show "appsscript.json" manifest file in editor**.
5. Do not copy or fork the production project; do not link either project to a Google Cloud project you use for
   anything else (the default project is fine).

## 2. Create the two calendars (owner, in Google Calendar, by hand)

The scripts never create calendars. Create two **new secondary calendars** with these exact names:

| Calendar name | Description (exactly one line, first line) |
|---|---|
| `FC-TEST Airline Feed` | `fc-test-marker:<FCT_MARKER>` |
| `FC-TEST Synced Roster` | `fc-test-marker:<FCT_MARKER>` |

`<FCT_MARKER>` is one locally generated value (32 to 64 lowercase hex characters, see the template) used in
both descriptions and as Script Property `FCT_MARKER` in both projects. The guard compares the description's
**first line** (surrounding whitespace ignored) with `fc-test-marker:<FCT_MARKER>` exactly: nothing else on that
line, and a marker on a later line is refused (`calendar-marker`). Further lines may follow. For each calendar: do not share it, add no
guests, and set **no notifications** (calendar settings, Event notifications: none). Note each calendar's id
(Settings for my calendars, the calendar, Integrate calendar, Calendar ID): it goes into Script Properties only.

## 3. Build the bundles and paste them (owner)

```
node scripts/gas-test/build-test-package.mjs ~/fc-gas-test-package
```

The output must be outside the repository (the script refuses otherwise). It writes `api/FcTestApi.gs`,
`api/appsscript.json`, `seeder/FcTestSeeder.gs`, `seeder/appsscript.json` and `MANIFEST.txt` (sha256 of every
included source file and every output). Review `MANIFEST.txt`: the production files listed under the API bundle must
be the files in `backend/apps-script/` (the hashes are of those files; they are embedded byte-identical between
banner comments).

**Verify immediately before installation (required, every time).** The directory you reviewed may be stale: a source
file can have changed since, or the output could have been edited. Right before pasting, rebuild into a **fresh,
empty (or absent) directory** and check two things; paste **only** the files of that fresh, hash-checked build:

```
REVIEWED=~/fc-gas-test-package                 # the build you reviewed; its MANIFEST.txt is the reference
FRESH="$(mktemp -d)/pkg"                       # a new directory outside the repository
node scripts/gas-test/build-test-package.mjs "$FRESH"
cd "$FRESH"
tail -n 4 MANIFEST.txt | shasum -a 256 -c -    # 1. the four output files match THIS build's MANIFEST.txt (expect 4 x OK)
diff "$REVIEWED/MANIFEST.txt" MANIFEST.txt     # 2. the manifest equals the reviewed one (the diff must be empty)
```

The manifest lists the sha256 of every source file and of the four outputs, so an empty `diff` also proves that the
sources are the reviewed ones. Any `FAILED` or a non-empty `diff` means: **stop**, find out why, review again, and
rebuild. Never paste a file from a directory whose hashes you have not just checked. This verifies that the pasted
text is the reviewed build; it does not replace reading the seeder source once.

- **FC-TEST Crew API**: replace the content of `Code.gs` with `api/FcTestApi.gs` (rename the file `FcTestApi`);
  replace `appsscript.json` with `api/appsscript.json`. Save. **Do not run anything yet.**
- **FC-TEST Seeder**: replace `Code.gs` with `seeder/FcTestSeeder.gs` (rename `FcTestSeeder`); replace
  `appsscript.json` with `seeder/appsscript.json`. Save.

All files come from the **fresh, hash-checked build** (`$FRESH` above). The API bundle is about 250 KB: copy it with
`pbcopy < "$FRESH/api/FcTestApi.gs"` and paste into the empty editor (select all first), then clear the clipboard
(`pbcopy < /dev/null`).

Check in each project's `appsscript.json` that `oauthScopes` is exactly what the table in section 4 says. Per the
Apps Script manifest documentation, an explicit `oauthScopes` list overrides scope auto-detection, so a call outside
the list fails instead of asking for more permission (**UNVERIFIED in these projects**: confirm in the first run).

## 4. OAuth scope review (read before the first run)

The repository holds **no production `appsscript.json`** (the production manifest lives only in the private
project and was not inspected), so these manifests are derived from the actual service calls in the bundled
sources, not copied from production. The "Checked how" column refers to the Google Apps Script reference pages
(developers.google.com), read by the lead agent on 2026-10-23; nothing was checked against a live project.

Google shows an authorization prompt on the first editor run. For an unverified personal project it warns
"Google hasn't verified this app": that is expected for your own scripts (Advanced, then continue). Review each
scope against this table before accepting; if the prompt shows more than listed here, **stop**.

| Purpose | Scope | In project | What it permits | Why needed | Checked how |
|---|---|---|---|---|---|
| Crew API execution (Properties, Cache, Lock, `ContentService`, `Utilities`) | none listed on the reference pages | API | nothing beyond the script's own storage | the crew state, grants and index live in Script and User Properties; lock and cache serialize and rate-limit | **UNVERIFIED** that none is needed with an explicit `oauthScopes` list: watch the first run; an `Authorization is required` error names the missing scope |
| Calendar read | `https://www.googleapis.com/auth/calendar.readonly` | API | read events and calendar metadata of **every** calendar the account can see | `getEvents`, `getTag`, event fields; calendar name, owner flag and description for the guard | reference pages list it for `getEvents`, `getTag`, event `getDescription`; **UNVERIFIED** for `Calendar.getName`, `getDescription`, `isOwnedByMe` (the guard fails closed to `calendar-error` if any needs more) |
| Synthetic event creation | `https://www.googleapis.com/auth/calendar` | Seeder only | read **and write** every calendar the account owns | `createEvent`, `setTag`, `setTime`, `setDescription`, `deleteEvent` | reference pages; the guard limits the code to the two test calendars, the platform does not |
| Execution identity | `https://www.googleapis.com/auth/userinfo.email` | API | read the account's email address | the production gate compares `Session.getEffectiveUser().getEmail()` with Script Property `FC_CREW_OWNER`; `getEmail()` can return an empty string when policy blocks it, then crew stays disabled | reference page; for a web app "execute as me" the answer is the deploying account |
| Hotel Sheet (optional) | `https://www.googleapis.com/auth/spreadsheets.readonly` | **not granted** | read all spreadsheets | production hotel lookup only | **Recommended: omit.** Without it the hotel lookup is replaced by `null`: layover hotel names still come from the event description, but coordinates and map links are absent. Nothing in this test needs them |
| Network | `https://www.googleapis.com/auth/script.external_request` | **not granted** | outbound HTTP | provider calls (departures, flight) | omitted on purpose; the provider actions are not offered and cannot run |
| Triggers, mail, drive, other Google services | various | **not granted** | n/a | n/a | omitted; no test source references them (tested) |

## 5. Script Properties (owner)

Use `backend/apps-script-test/script-properties.template.md` for the complete list, formats and generation
commands. Summary of the order:

1. Compute the deny-list hashes **locally** from the **production** calendar ids (read them from the private
   production config, never from a chat): copy one id, run `pbpaste | node scripts/gas-test/hash-id.mjs`, note the
   hash, repeat for the second id, then clear the clipboard (`pbcopy < /dev/null`). Paste **only the two hashes**
   (comma separated) as `FCT_DENY_SHA256` in both projects. The production ids never enter either test project.
2. Generate `FCT_MARKER`, `FC_V2_TOKEN` (`fctest_` + 64 hex) and `FC_CREW_PEPPER` (`fctest_pepper_` + 64 hex) with
   `openssl rand -hex`; never reuse a production value.
3. Set in **FC-TEST Crew API**: `FCT_ISOLATED`, `FCT_MARKER`, `FCT_DENY_SHA256`, `FCT_CAL_FEED_ID`,
   `FCT_CAL_SYNCED_ID`, `FC_V2_TOKEN`, `FC_CREW_PEPPER`, `FC_CREW_SELF`, `FC_CREW_OWNER`, `FC_CREW_ENABLED`.
   `FC_CREW_SELF` is the synthetic owner id of the fixture: `99`, then `0000`, then `X` (seven characters, written
   in parts here so no employee-number-shaped literal exists in the repository).
4. Set in **FC-TEST Seeder**: `FCT_ISOLATED`, `FCT_MARKER`, `FCT_DENY_SHA256`, `FCT_CAL_FEED_ID`,
   `FCT_CAL_SYNCED_ID`, `FCT_SEED_CONFIRM`. Do **not** create `FCT_SEED_INSTALL` or `FCT_SEED_ANCHOR`: the seeder
   manages both (section 6a).
5. Neither project may ever hold `FC_ADB_RAPIDAPI_KEY`, `PLACES_API_KEY` or `FC_V5_GET`.

## 6. Run order

Run on **one day** (the feed block lies a few days ahead of the day of seeding).

1. **Seeder** project: run `fctCheckSetup` (expect `"isolation":"ok","feed":"ok","synced":"ok"`; accept the
   authorization prompt), then `fctSeedDryRun` (counts only, reports conflicts and repairs, writes nothing), then
   `fctSeedAll`. If it reports `"partial":true`, run it again. Seeding is idempotent. If it reports `"ok":false`,
   read section 6a before doing anything else: a `"stopped":true` line means a rerun continues and repairs, a
   `"conflicts"` list means an event needs a manual decision.
2. **API** project: run `fctCheckSetup` (expect `isolation`, `feed`, `synced` = `ok` and the three booleans `true`),
   then `fctRunSmoke`. It runs S0 setup, S1 capabilities, S2 auth failures, S3 enrollment, S4 `crewIndex` until
   complete, S5 crew lookups, S13 time zones. If the run ends inside S4 (time limit), run `fctRunSmokeResume`.
3. **Seeder** project: run `fctApplyScheduleChange` (moves one flight by 90 minutes and swaps one crew member, in
   place, once).
4. **API** project: run `fctRunSmokeAfterChange` (S6), then `fctRunSmokeFinish` (S7 revocation, S8 cancellation,
   S9 owner purge, S10 malformed state, S11 cache cleanup, S12 guard failure). If a run died inside S10, run
   `fctRestoreState` (or simply `fctRunSmokeFinish` again: it restores first).

### 6a. Seeder ownership, required tags, conflicts and stopping (read before the first `fctSeedAll`)

**Why.** The fixture is public: anyone can type a calendar event that is identical to a fixture event. The seeder
therefore never decides that an event is "its own" because the content matches, and cleanup never deletes an event
because of its content or its tags.

**Ownership proof.** On its first seeding run the seeder generates an installation id and stores it as Script
Property `FCT_SEED_INSTALL` (32 lowercase hex characters, generated from `Utilities.getUuid`). Never set, copy, log,
paste or commit it; the seeder never logs it and never writes it to a calendar. For a fixture event with a role
(`feed` or `synced`) and a key, the proof is the first 32 hex characters of
`sha256("fct-own|" + install + "|" + role + "|" + key)`. Every event the seeder creates starts its description with
the line `fct-own:<role>:<key>:<proof>`, then a blank line, then the fixture text. An event is **owned** only if
that first line parses exactly, its role equals the calendar's role, and the proof recomputes against this
installation's id. Without an installation id nothing is owned. Tags are never ownership proof. The marker line is
placed so that the production parsers behave identically with and without it (tested for every fixture event: the
event classifier, the crew-list parser and the description parser give identical results).

**Atomicity (stated plainly).** The marker line is part of the `createEvent` payload, the only part Calendar writes
together with the event. Tags need separate `setTag` calls afterwards and are **not** atomic with creation.
Whether `createEvent` writes its description atomically with the event is a reasonable but **UNVERIFIED** platform
assumption; if a creation were to leave an event without its description, that event would be unowned and show up
as a conflict (safe), never as an adoption.

**Required tags** of a fully seeded event (exact values): `fct-seed` = `1`, `fct-key` = the fixture key,
`fct-own` = the proof, and for the synced calendar also the sync tag `FCTEST_SYNC_SOURCE_ID` = the source id (the
tag the production reader needs). An event is counted as seeded only when every required tag is exactly right,
confirmed by a fresh read. An owned event with a missing or wrong tag is **repaired** (reported as `repaired`); an
interrupted run (after creation, or after any single tag write) is therefore finished by simply running
`fctSeedAll` again.

**Conflicts (the seeder touches nothing and reports `"ok":false` with a list of `{role, key, reason}`):**

| Reason | Meaning |
|---|---|
| `duplicate-owned` | two or more events prove ownership for the same role and key (for example one was duplicated in the Calendar UI) |
| `unowned-lookalike` | no owned event for the key, but another event has the same title, start and end as the fixture event |
| `unowned-tagged` | no owned event for the key, but another event carries `fct-key` equal to the key, or the `fct-own` value expected for it |

Nothing is created for a conflicting key, nothing is tagged, nothing is deleted; other keys continue. **Manual
resolution:** open the test calendar, inspect the event that matches the key (the key names a fixture event; a
fixture title and time are listed in the local fixture tests), delete it by hand in the test calendar, then run
`fctSeedAll` again. The seeder never resolves a conflict itself, and it never adopts a pre-existing exact copy. If
`FCT_SEED_INSTALL` was lost (or the seeder project was recreated), every previously seeded event is no longer
provably owned: every key is reported as a conflict, `fctRemoveSeeded` deletes nothing, and the events must be
deleted by hand (or the two test calendars emptied) before seeding again. A malformed `FCT_SEED_INSTALL` is refused
(`install-invalid`).

**Cleanup.** `fctRemoveSeeded` deletes only events in the two guarded calendars (within the bounded window) whose
description proves ownership. Untagged, forged-tag, look-alike and other-installation events are kept and counted.
Events left half-tagged by an interrupted run are still deleted (ownership comes from the description). It never
removes `FCT_SEED_INSTALL`, so a second run deletes `0` and reports `"ok":true`. The ownership proof is not a secret
from anyone who can read the test calendar (it sits in the description): it protects against pre-existing,
accidental or public-fixture copies, not against someone with write access to the test calendars who copies an
owned event on purpose.

**Guard revalidation and stopping.** Before **every** calendar mutation (event creation, each tag write, each
schedule update, each delete, each repair) the seeder re-reads the Script Properties and re-opens **both** test
calendars through the same guard as at the start (invalidating either calendar halts the seeder, not only the one
being written) (isolation flags, confirmation, deny list, name, ownership by the account,
marker line), and requires that the calendar object it is about to write to reports the very id that was
validated. For an event it also compares `getOriginalCalendarId()` with that id when Calendar provides the method
(**UNVERIFIED**: whether the method is available and what it returns for these events). If any check fails, or the
write itself fails, the run **stops at once**: no further event is touched, nothing is reported as success, and one
JSON line is logged, for example `{"action":"seed","ok":false,"stopped":true,"guard":"calendar-marker","progress":{...}}`
(`guard` is a stable code such as `calendar-marker`, `calendar-missing`, `handle-identity`, `event-calendar`,
`confirm-missing`, `write-failed`, `tags-unconfirmed`; the progress holds counts only). What a safe retry needs is
kept: the events and tags in the calendar, `FCT_SEED_INSTALL` and `FCT_SEED_ANCHOR`. Fix the cause (for example put
the marker line back into the calendar description) and run the same function again; it repairs and continues
without duplicates. **Caveat:** the checks reduce but cannot eliminate a race: the validation and the write that
follows it are separate Calendar calls, so a calendar changed in the instant between them is not detected. The
checks make a long run stop within one write of a change, not instantly.

Scenarios and what they need:

| Id | Scenario | Needs | Fresh project state |
|---|---|---|---|
| S0 | setup, isolation, seeded events visible (includes the cross-project sync-tag check) | seeded calendars | no |
| S1 | capabilities: crew block present, `departures`/`flight` absent | crew gate on | no |
| S2 | missing/wrong token, wrong contract, unknown action, purge not routable, provider actions off | none | no |
| S3 | enrollment with a runner-issued single-use code, idempotent retry, reuse refused | none | no (a valid code supersedes an older grant) |
| S4 | `crewIndex` until every sealable month is indexed | S3 | no |
| S5 | crew lookups: counts per colleague, no crew list, invalid records, bad requests | S4 | no |
| S13 | `roster` local times: half-hour zone, local-midnight shift, EU and North America DST dates | seeded feed | no |
| S6 | schedule change seen by lookup, same sector id, re-verification | S5 baseline plus the seeder step | needs S5 first |
| S7 | revocation: index deleted, other user properties kept, receipt replay | an active grant (S3) | needs S3 |
| S8 | cancellation tombstone: a cancelled grant can never be enrolled | none | no |
| S9 | owner purge with `FC_CREW_PURGE_CONFIRM`, refusal without it | none (enrolls itself) | no |
| S10 | malformed `FC_CREW_STATE`: fail closed, never overwritten, restored byte for byte | none | no |
| S11 | cache cleanup through the live adapter | none | no |
| S12 | guard failure by in-memory property overrides (never touches a real calendar) | none | no |

Tombstones from S8 stay in `FC_CREW_STATE` (at most 64, never evicted): repeat the whole sequence only a few times in
one project, or recreate the project.

Optional HTTP deployment (a founder decision; the smoke runner does not need it): Deploy, New deployment, Web app,
Execute as **Me** (`USER_DEPLOYING`). Access **Only myself** (`MYSELF`) is the manifest default and the safe choice:
only a browser or a client signed in as the owner can call it, so the roster token alone is not enough
(**UNVERIFIED**: Google's documented behaviour for `MYSELF`; confirm before relying on it). The app
frontend cannot use it (it sends an anonymous cross-origin POST). `Anyone` (`ANYONE_ANONYMOUS`) would allow the
frontend to call it with the test token, but publishes a world-reachable endpoint protected only by the synthetic
test token and the guard: weigh that before choosing it, and set it only for the duration of a test. The deployment
URL, `<FC_TEST_EXEC_URL>`, is stored only in a private local file outside the repository, never in chat, screenshot or Git.

## 7. Capture the results

- Open the project's **Executions** page and copy **only the redacted JSON lines** of the run
  (`{"id":"S4","pass":true,"counts":{...}}` and the summary line) into your notes.
- Never screenshot Script Properties, calendar ids, the deployment page or a URL. A line holding a name, an id or
  a token is a bug: stop and report it without pasting it.
- A failing scenario names the failed check (a fixed string such as `primary-members`), never a value.
- Record the date, the commit of the repository the bundles were built from and the `MANIFEST.txt` digests.

## 8. Teardown (owner)

1. Seeder project: run `fctRemoveSeeded` (deletes only events whose description proves ownership, in the two guarded
   calendars; run it a second time: it deletes `0`). Events it keeps (conflicts, your own notes) are counted in `kept`.
2. Delete the two calendars in Google Calendar.
3. Delete both Apps Script projects (script.google.com, project menu, Remove).
4. Revoke the apps: myaccount.google.com, Security, **Third-party access** (or "Your connections to third-party
   apps and services"), remove "FC-TEST Crew API" and "FC-TEST Seeder".
5. Delete the local secret files, the generated `~/fc-gas-test-package` directory and clear the clipboard.

## 9. Local versus live test matrix (the 14 areas)

"Local" is `node --test tests/gas-test-package.test.js` (fake services; also loads the built bundles). "Live" is the
smoke scenario against the real services.

| # | Area | Local test | Live scenario | Notes |
|---|---|---|---|---|
| 1 | Capabilities | `capabilities: the crew block is present ...`, end-to-end run | S1 | live adds the real gate (`Session`, Properties) |
| 2 | Authentication failures | `authentication and contract failures through the guarded doPost` | S2 | limiter counts wrong tokens in the real cache |
| 3 | Enrollment | end-to-end run, lookup test | S3 | single-use code issued by the runner (a code lives 15 minutes at most) |
| 4 | `crewIndex` until complete | end-to-end run (`S4`) | S4 | live is bounded (about 10 calls) |
| 5 | Crew lookup | `crew lookup answers match the fixture expectations` | S5 | exact per-colleague counts from the fixture |
| 6 | Historical indexing | fixture tests (five months, four always sealable), `S4` | S4, S5 | 50 months are indexed (all months since 2022-08, most empty) |
| 7 | Revocation | end-to-end run (`S7`) | S7 | |
| 8 | Cancellation (tombstone) | end-to-end run (`S8`), receipts test | S8 | |
| 9 | Grant-specific deletion receipt | `revocation receipts are grant-specific ...` | S7 replays the same grant only | cross-grant behaviour is **local only** |
| 10 | Interrupted purge and retry recovery | `interrupted owner purge keeps the fence ...` | **not live** | a delete failure on real User Properties cannot be forced; S9 covers the successful purge |
| 11 | Malformed state | `malformed FC_CREW_STATE fails closed ...` | S10 | the runner backs the state up before breaking it |
| 12 | Cache cleanup | `cache cleanup: the live adapter removes entries ...` | S11 | the cache-key registry is empty in V2.3, so product-driven cache removal cannot be observed live: S11 proves the live adapter's `removeAll` and the failure counter |
| 13 | DST and time-zone correctness | `fixtures: time zones and daylight saving ...` | S13 (and S5 data) | live checks `Utilities.formatDate` offsets that no Node fake reproduces |
| 14 | Permission failure | `permission failures ...`, guard tests | S12 (guard) | a real missing scope or blocked `getEmail()` is local only; to provoke one live, remove `userinfo.email` from the API manifest and expect `crew-disabled` |

## 10. Safety controls

| Control | Enforced in | How |
|---|---|---|
| The API project has no calendar write scope | **platform** (manifest `oauthScopes`) | tested: manifest scopes are exact; the faked platform refuses writes |
| The API project has no network scope | **platform** | `script.external_request` absent; code also hardens `providerFetch` to throw |
| The seeder is a separate project holding the only write scope | **platform** + documentation | deleted after use |
| Isolation flag, marker, test-format token, pepper and owner id | **code** (`fctIsolation_`) | tested per reason code |
| Production-only keys must be absent | **code** | `FC_ADB_RAPIDAPI_KEY`, `PLACES_API_KEY`, `FC_V5_GET` |
| Production calendar ids are denied by SHA-256 hash | **code** + documentation | the owner computes the hashes; incomplete hashes weaken it (name and marker checks remain) |
| A calendar must have the exact test name, be owned by the account and carry the marker line | **code** (`fctCalendar_`) | tested |
| Production constants are assigned only after the guard passed | **code** (`fctPrepare_`) | tested; before that they point at nothing and fail closed |
| A distinct sync tag key | **code** | a production synced calendar would yield zero tagged events |
| Hotel Sheet, provider key and network unusable | **code** + platform | no `spreadsheets` or network scope; lookup replaced by `null` |
| Guard refusals answer a generic `not-configured` | **code** | no reason, id, name or description in any response or log |
| Seeder needs an explicit confirmation property | **code** | `FCT_SEED_CONFIRM` |
| Seeder touches and deletes only events whose description proves installation-specific ownership, only in the two guarded calendars, within a bounded window | **code** | tested: exact copies, forged tags, a forged proof from another installation, duplicates, a lost installation id |
| The guard and the calendar identity are revalidated before every mutation; a failure stops the run | **code** (`fctSeedGuarded_`) | tested: invalidation after the first write, before cleanup, during and before schedule updates, id swap, deleted calendar; the race between a check and its write remains (section 6a) |
| An event counts as seeded only with every required tag, confirmed by a fresh read; incomplete events are repaired | **code** | tested after an interruption at every single write |
| The installed bundles are the reviewed build | **documentation only** | section 3: rebuild into a fresh directory, `shasum -a 256 -c`, `diff` of `MANIFEST.txt` |
| Scripts never create calendars | **code** (+ tested absence of `createCalendar`) | the `calendar` scope would permit it; code does not |
| Execution identity gate, roster token, crew grant, generation checks | **code** (production `CrewApiV2.gs`) | tested in the existing suites and end to end here |
| Web app access `MYSELF` | **platform** (deployment setting) | only when a deployment exists |
| Keeping production ids, tokens and URLs out of the test projects, clipboard hygiene, no screenshots | **documentation only** | procedure discipline |
| Deleting projects, calendars and grants after use | **documentation only** | section 8 |

## 11. A separate project does NOT stop access to the account's other calendars

Both projects run as **your** Google account. `calendar.readonly` and `calendar` are **account-wide**: no Apps Script
Calendar scope that limits a script to specific calendars is known to us (**UNVERIFIED** as an absolute statement). A separate Apps Script project isolates code, properties, triggers
and deployments, not the account's data. Each layer compensates in a different way:

- **API project, read-only scope**: a bug or misuse could at worst **read** another calendar (including the
  production airline feed and synced calendar and your personal calendars). It cannot modify or delete anything.
- **No network, mail or drive scope**: even a read cannot be sent anywhere by the script itself. Only the HTTP
  response (when a web app is deployed) could carry data back to a caller, and responses come from the allow-listed
  production handlers over the two guarded calendars.
- **Guard**: only the two ids configured in Script Properties, checked against the hash deny list (normalized: trimmed,
  lowercase), exact name, ownership and marker, are ever passed to `CalendarApp`. The production constants that name the calendars are unset until the
  guard passes.
- **Seeder**: the one write path. It re-checks the guard before every single mutation, touches only events whose
  description proves ownership (section 6a), deletes only such events and lives only for the seeding session.
- **Documentation**: the procedure above (hashes, no ids in chat, teardown).

**The strongest option, a decision for the founder:** run the whole test in a **dedicated throwaway Google
account** that owns only the two test calendars. Then even a total guard failure cannot touch production data,
because the account has none. Cost: a second account to create and delete; the owner email in `FC_CREW_OWNER`
becomes that account's email.

## 12. Residual risks

1. Account-wide Calendar scopes (section 11) remain whatever the code does; only a separate account removes them.
2. The deny list protects only as well as the owner's hashes: a missing production id is caught only by the name and
   marker checks.
3. **UNVERIFIED: sync tags across projects.** The seeder project sets the sync tag, the API project reads it. If Apps
   Script tags are private to the script that set them, the API project sees the synced events as untagged and S0
   fails with `sync-tag-visible-across-projects` while `syncedAll` is above zero. The fallback is a founder decision
   (for example setting the tag through the Advanced Calendar service in the seeder, or running both bundles in one
   project and losing the write-scope separation). Nothing was verified against the real service.
4. Other Apps Script behaviour that was **not verified** against the real services: scope needs of `PropertiesService`,
   `CacheService`, `LockService`, `ContentService` and `Utilities` with an explicit scope list; scopes of
   `Calendar.getName`, `getDescription` and `isOwnedByMe` under `calendar.readonly`; whether `getCalendarById` returns
   `null` or throws for an unknown id (the guard handles both); the exact timing of a 50-month index; the Calendar
   quota for about 75 created events (well below the documented daily limits).
5. S10 deliberately breaks `FC_CREW_STATE` for a few seconds; a web-app request in that window sees
   `crew-unavailable`. Do not call a deployed test endpoint during S10.
6. A web-app deployment (optional) exposes an endpoint protected by the synthetic token and the guard; keep access
   `MYSELF` and remove the deployment after use.
7. Execution logs are retained by Google; they hold only the redacted lines described above.
8. Calendar notification defaults of your account could notify about seeded events; section 2 turns them off.
9. The local tests cannot prove the real services behave like the fakes; that is exactly what the live run is for.
10. The guard runs **before** the roster token check (`fctHandle_` in `TestGuardV2.gs`): an unauthenticated caller of
    a deployed test endpoint triggers calendar metadata reads of the two test calendars and can tell from
    `not-configured` versus `unauthorized` whether the guard currently refuses. Nothing else leaks; with access
    `MYSELF` no anonymous caller reaches the endpoint at all.
11. Synthetic flight numbers use the airline's real `DE` prefix (needed by the production title classifier). They are
    invented numbers, not crew data.
12. Ownership (section 6a): the seeder never adopts an event by its content. An interrupted creation is recognized
    only through the marker line in its description, which only this installation can produce. Residual limits:
    (a) that `createEvent` writes the description atomically with the event is **UNVERIFIED**; (b) the proof is
    visible to anyone who can read the calendar, so it does not defend against a deliberate copy by someone with
    write access to the test calendars (a copy of an owned event is reported as `duplicate-owned` and removed by
    cleanup); (c) real `getTag` behaviour, `getOriginalCalendarId()` and the exact text `getDescription()` returns
    for an event edited in the Calendar UI (HTML or whitespace changes could make an owned event look unowned, which
    fails safe as a conflict) are **UNVERIFIED**; (d) validation and mutation are separate calls, so a change in
    the instant between them is not detected (repeated checks reduce, they cannot eliminate, this race); (e) overlapping
    seeder executions are serialized by the script lock (`LockService`; a second run answers `busy` and touches
    nothing). **UNVERIFIED**: that `LockService` needs no scope beyond the seeder's single `calendar` scope; if the
    first run fails with an authorization error naming a scope, stop and report it rather than widening the
    manifest.
13. Verification of the pasted bundles is procedural (section 3): a rebuilt, hash-checked fresh directory proves the
    files equal the reviewed build, nothing more.
