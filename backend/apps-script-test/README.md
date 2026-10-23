# Isolated Apps Script test package (Crew Intelligence V2.3)

**Test-only. Never paste any file of this directory into the production Apps Script project.**

This directory holds the sources of two throwaway Apps Script projects that let the owner test Crew Intelligence
V2.3 against real Apps Script services (Calendar, Script and User Properties, Cache, Lock, Session) using two
synthetic calendars:

| Project | Bundle | Scopes | Purpose |
|---|---|---|---|
| FC-TEST Crew API | `FcTestApi.gs` + `appsscript.api.json` | `calendar.readonly`, `userinfo.email` | the production crew/roster sources, UNCHANGED, behind an isolation guard; cannot write a calendar or reach the network |
| FC-TEST Seeder | `FcTestSeeder.gs` + `appsscript.seeder.json` | `calendar` only | creates, updates and deletes synthetic EVENTS in the two guarded calendars; deleted after use |

| File | Role |
|---|---|
| `TestGuardV2.gs` | isolation checks, calendar guard, hardened environment, `doPost` override |
| `TestFixturesV2.gs` | pure, deterministic synthetic fixture (flights, crews, history, DST, schedule change) |
| `TestSeederV2.gs` | editor functions that create/update/remove the synthetic events (seeder project only) |
| `TestSmokeV2.gs` | editor functions that run the live scenarios (API project only) |
| `appsscript.api.json`, `appsscript.seeder.json` | the manifests (exact scopes) |
| `script-properties.template.md` | every Script Property, with placeholders only |

Build the bundles OUTSIDE the repository (nothing is deployed, no network is used):

```
node scripts/gas-test/build-test-package.mjs ~/fc-gas-test-package
```

The manual procedure, the OAuth review, the test matrix, the safety controls and the teardown are in
`docs/CREW-GAS-TEST-SETUP.md`. Local tests: `node --test tests/gas-test-package.test.js`.
