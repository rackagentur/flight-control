# fc.roster v2: the Flight Control roster contract

Status: **installed privately** on the existing web-app deployment, currently Version 26 (rollback Version 25; pre-v2 baseline Version 22), verified against the live endpoint (Step H, 2026-10-05, repeated on each version; `docs/BACKEND-HARDENING.md`) and enabled in the owner's app. The v5 `getStats` payload is unchanged and remains the fallback; since BH-2 it is read with the token (`stats`).

## Rule of truth

`source` fact > backend `derived` fact > frontend presentation. A derivation or inference is never upgraded to a fact. Every item carries its provenance:

| Provenance | Meaning |
|---|---|
| `source` | Stated by the airline duty-plan feed |
| `derived` | Computed mechanically from source facts (IANA local times, duty grouping, check-in/pickup association, stay end = next listed departure) |
| `inferred` | A conservative rule (only the frontend's 6-calendar-day layover inference; the backend never infers) |
| `unknown` | Not provable from the data |

## Source inventory (read-only, 2026-10-04; sanitized)

The airline feed is a calendar of timed events (no all-day events). Day codes are 24-hour events aligned to local midnight in the base zone (25/23 h on DST days).

| Code | Meaning | Contract kind |
|---|---|---|
| `DE<n> AAA-AAA` | flight | `flight` → sector |
| `C/I` | check-in (report time) | `checkin` → duty.report |
| `P/U` | pickup (outstations) | `pickup` → duty.pickup |
| `SB<n>` / `RE<n>` | standby / reserve window | `standby` / `reserve` |
| `SB90S`, `SB90_I`, `SBH30`, `SBAUS`, `SB90KO` | further standby types (Condor MTV Fibel (Verdi) p.17, column "Symbol Dienstplan"); exact symbols only | `standby` (window, hotel block handled like `SB90`) |
| `OFF` | off day | `off` / subtype `off` |
| `-` | **Strichtag** (a single dash): a day with no duty assigned. Evidence: owner statement and a read-only trace of the live feed (2026-10-06): `-` occurs 30 times as a 24 h day event and no title contains `--`; Condor MTV Fibel p.10 (Strichtage count as free days there and are convertible to duty; neither rule is implemented). **Supersedes** the 2026-10-04 inventory claim "`-` = free day (Freier Tag)", which has no supporting record. Recognised, but **not** a day off and not a free day; distinct from `OFF`, `U` and `ORT` | `unassigned` (airline-neutral; no subtype, `protected: false`) |
| `U` | leave | `off` / subtype `leave` |
| `ORT` | **protected free day**: assigned by the company, cannot be taken away or reassigned | `off` / subtype `ort`, `protected: true` |
| anything else | unknown | `unknown`, original code and title kept |

Recognition is by **exact symbol** (the table in `src/airlines/condor/roster-codes.js`); there is no permissive fallback. The agreement's own standby names (`SBY`, `SBYHOT`, `SBYKO`, `SBY_I`, `SB30-AUS`, `SBYAP`, `RES10`, `RES10_I`) are not roster representations (Fibel p.17) and stay `unknown`, as do `XYZ`, `--` (never observed in the feed), `---`, `- -`, `–` and lower-case variants. Core code and the contract never contain the roster symbol or the airline word: the canonical concept is `unassigned`, and the wording (Condor "Strichtag", generic "Unassigned day") comes from the airline pack.

Observed in the live feed but still unrecognised (2026-10-06): `U1`, `SBX`, `HS5`, `EM`, `RE10S`, `DH/<flight>` and flight titles of other carriers (for example `LH…`). They stay `unknown` (meaning not established) and are not interpreted.

Descriptions may contain a hotel block ("Hotel" + name, address lines, phone), an aircraft line (`REGISTRATION (TYP)`), and a crew list with colleagues' names and employee numbers plus a booking code. **Only the hotel block and the aircraft line are read; nothing else from a description is ever returned.**

Hotel parsing is **fail-closed**: the name is the first line after "Hotel" and is dropped if it looks like a crew entry (rank code, employee number, crew base "(XXX)"), a name list ("Surname, Given" without a hotel word, "A / B") or a code (letters mixed with digits, booking/confirmation/reservation words). Address lines are taken **only** when the block ends with a "+digits" phone line, and each must contain a number (street, postcode) or be the single city line directly before the phone; otherwise address and phone are dropped. The frontend applies a second, airline-independent check before display. The aircraft line is only read outside the hotel block and only when its type code contains a digit.

*Residual risk (documented, accepted for review):* a letters-only line placed by the source directly before the phone line is accepted as the city line; text alone cannot distinguish a city name from a person's name there. The airline's real crew-list format (rank, employee number, "SURNAME, GIVEN (BASE)") is always rejected, wherever it appears (fuzzed across thousands of variants).

The feed keeps only a few days of past events and extends to the end of the next month once that month is published (around the 1st). It is **not exhaustive**: days away at an outstation can carry no event at all. Therefore an empty day is **never** OFF (decision D-OFF); OFF, free, leave and ORT come only from their explicit codes.

## Transport

- `POST` to the existing web-app URL, `Content-Type: text/plain` (a CORS simple request: no preflight).
- Body: `{"contract":"fc.roster","version":2,"action":"…","token":"…", …}`. The token is never in the URL.
- Always HTTP 200; failures are `{"ok":false,"error":"<code>"}`: `bad-request`, `not-configured`, `unauthorized`, `rate-limited`, `unsupported-contract`, `unknown-action`, `bad-range`, `range-too-long`, `before-history-start`, `history-is-past-only`; `departures` adds `unknown-airport`, `range-out-of-bounds`, `departures-not-configured`, `provider-rate-limited`, `provider-auth-failed`, `provider-unavailable` (see below).
- Auth: Script Property `FC_V2_TOKEN` (constant-time comparison). Without the property every call is refused. The correct token is always accepted; after 20 failed tokens within 10 minutes further failures get `rate-limited` (they are no longer counted, so the window ends 10 minutes after the 20th failure).

## Actions

| Action | Input | Output / bounds |
|---|---|---|
| `capabilities` | — | `{ok, contract, version, actions, limits, source}` (feature detection) |
| `roster` | optional `from`, `to` (`YYYY-MM-DD`) | Default: previous, current and next month. ≤ 100 days. Days before today from the **synced copy**, from today from the **airline feed** (decision D-SRC) |
| `stats` | — | The unchanged v5 `getStats` payload (`{success: true, …}`), for token holders (backend hardening BH-2). The app's v5 fallback reads it this way when a token is saved; the unauthenticated `GET ?action=getStats` is served only while Script Property `FC_V5_GET` is `open` (migration window) and otherwise answers `{success:false, error:"auth-required"}` |
| `history` | optional `from`, `to` | My own flown sectors from the synced copy (sync-tagged events only). ≤ 13 months, ≥ configured start date, past only, ≤ 2,000 sectors (most recent kept, `truncated: true`). Cached 6 h |
| `departures` | `airport` (IATA, in the zone table), `from`, `to` (epoch ms), optional `carriers` | Provider schedule data (AeroDataBox), **not** roster sectors and not assignments; see below. ≤ 24 h per request. Listed in `capabilities.actions` only while its Script Property is set |

## `roster` response (synthetic example, shortened)

```json
{
  "ok": true, "contract": "fc.roster", "version": 2, "action": "roster", "generatedAt": 1791100800000,
  "source": { "adapter": "condor-calendar", "baseTimeZone": "Europe/Berlin",
              "segments": [ { "from": "2026-09-01", "to": "2026-10-03", "basis": "synced-copy" },
                            { "from": "2026-10-04", "to": "2026-11-30", "basis": "airline-feed" } ] },
  "capabilities": { "sectors": true, "reportTime": true, "pickups": true, "standby": true, "reserve": true,
                    "explicitOff": true, "protectedOff": true, "leave": true, "unassigned": true, "stays": "hotel-block",
                    "hotels": true, "aircraft": true, "rotations": false, "history": true },
  "coverage": { "from": "2026-09-01", "to": "2026-11-30", "lastRosteredDate": "2026-10-26",
    "days": [
      { "date": "2026-10-04", "state": "rostered",
        "codes": [ { "kind": "off", "subtype": "ort", "code": "ORT", "protected": true, "eventId": "e_1a2b3c4d5e6f7a8b", "provenance": "source" } ] },
      { "date": "2026-10-20", "state": "empty", "codes": [] },
      { "date": "2026-10-27", "state": "unpublished", "codes": [] } ] },
  "events": [ { "id": "e_1a2b3c4d5e6f7a8b", "kind": "off", "subtype": "ort", "code": "ORT", "title": "ORT",
                "start": 1791064800000, "end": 1791151200000, "location": "FRA", "protected": true,
                "provenance": "source", "basis": "airline-feed" },
              { "id": "e_9f8e7d6c5b4a3f2e", "kind": "unknown", "subtype": null, "code": "XYZ7", "title": "XYZ7",
                "start": 1791921600000, "end": 1791936000000, "location": "FRA", "protected": false,
                "provenance": "source", "basis": "airline-feed" } ],
  "sectors": [ { "id": "s_0c1d2e3f4a5b6c7d", "eventId": "e_0c1d2e3f4a5b6c7d", "flightNumber": "DE9201",
                 "origin": "FRA", "destination": "BKK", "dep": 1791446400000, "arr": 1791486000000,
                 "originTz": "Europe/Berlin", "destTz": "Asia/Bangkok",
                 "depLocal": "2026-10-08T10:00+02:00", "arrLocal": "2026-10-09T02:00+07:00", "dayShift": 1,
                 "blockMin": 660, "aircraft": { "typeCode": "339", "registration": "DABCD", "provenance": "source" },
                 "provenance": "source", "zoneProvenance": "derived", "basis": "airline-feed" } ],
  "duties": [ { "id": "d_0c1d2e3f4a5b6c7d", "kind": "flight", "sectorIds": [ "s_0c1d2e3f4a5b6c7d" ],
                "report": { "at": 1791441000000, "eventId": "e_…", "provenance": "source", "association": "derived" },
                "pickup": null, "start": 1791441000000, "end": 1791486000000, "provenance": "derived" } ],
  "windows": [ { "kind": "standby", "code": "SB90", "start": 1791860100000, "end": 1791903300000,
                 "eventId": "e_…", "provenance": "source" } ],
  "stays": [ { "id": "h_0c1d2e3f4a5b6c7d", "airport": "BKK", "airportProvenance": "source",
               "from": 1791486000000, "to": 1791653400000, "endProvenance": "derived",
               "provenance": "source", "basis": "hotel-block", "evidenceEventIds": [ "e_0c1d2e3f4a5b6c7d" ],
               "hotel": { "name": "Sample Riverside Hotel", "address": "99 Sample Street, Bangkok",
                          "phone": "+66 2 000 0000", "provenance": "source",
                          "location": { "lat": 13.7, "lon": 100.5, "mapsUrl": "https://maps.example.invalid/riverside",
                                        "placeId": "place-sample-1", "status": "verified", "provenance": "derived" } } } ],
  "rotations": [],
  "warnings": [ { "code": "unknown-code", "message": "1 roster event(s) with an unrecognised code are kept as unknown." } ]
}
```

Field rules:

- **Ids** are short SHA-256 hashes of the source event id (opaque; raw calendar ids never leave the backend). They are not assumed stable across roster changes; the frontend keeps its flight + route + local-date identity.
- **Sectors**: zones come from the generated airport table (`AirportsV2.gs`, same data as `src/data/airports.js`); unknown airport → `null` zone and `null` local time plus a warning. Never a fixed offset.
- **Aircraft** is optional source metadata (3-character type code, registration if present and well-formed). Absent or malformed → `null`; never inferred and never used for classification.
- **Duties**: grouped like the frontend (≤ 6 h continuous ground gap). `report` = the check-in ≤ 4 h before the first departure; `pickup` = the pickup ≤ 3 h before the check-in (outstations). The association is `derived`; the times are `source`.
- **Stays**: a hotel block is source evidence that a stay exists. On a flight: the stay is at that flight's destination (`airportProvenance: source`) and ends at the next listed departure from there (`derived`), or `to: null` (`endProvenance: unknown`). On a standby/reserve: the airport is derived from the previous arrival, or `null`. Stays never create sectors or rotations.
- **Hotel location** only from a VERIFIED Sheet row whose name and airport match **and** whose recorded stays include this stay's source event; REVIEW/UNRESOLVED rows and candidate fields are never used.
- **Coverage** states: `rostered` (any event), `empty` (inside coverage, nothing rostered; UNKNOWN, never OFF), `unpublished` (feed segment after the last rostered day). Days outside `from`–`to` are not returned.
- **Day `codes[]`** lists only the explicit day codes on that date: the rest family (`off` with subtype off/free/leave/ort) and unassigned days (`kind: "unassigned"`, `subtype: null`, `protected: false`). It is not a list of everything rostered: a day with a flight, check-in, pickup, standby, reserve or unknown-code event but no rest or unassigned code is `rostered` with `codes: []`. So `rostered` does not imply a non-empty `codes[]`, and an empty `codes[]` on a rostered day never means OFF; the day's events (by local date in the base zone) carry its content.
- **Event kind `unassigned`** (Phase 2): a day the roster lists with no duty assigned. It is its own concept, never `off`: it is emitted as an event and a day code, **never** as a backend `windows[]` entry (windows stay standby/reserve), and `capabilities.unassigned: true` announces it. The contract validator accepts any event kind string, so older clients keep working (an unrecognised kind is simply not used by them). The frontend maps it to a window of kind `unassigned` (status `unassigned`, confirmed, source). Month summaries count it separately from off days; the state engine never reports a begin/end event for it. The contract carries no rule about whether the airline may later assign the day, and none is implemented.
- **Rotations** are not stated by the feed (`capabilities.rotations: false`); the frontend derives them.
- **Unknown codes** are kept by the frontend too (`unknownEvents`): a day with only an unknown code is UNKNOWN with evidence `unknown-code` and shows the code itself (never "Duty" or OFF); unknown codes on otherwise classified days are listed in the day detail.
- **Rest family precedence**: an explicitly coded rest day (OFF, free, leave, ORT) or unassigned day is a source fact and outranks an inferred layover. Generic off windows without a subtype keep the earlier rule (an inferred layover wins).

## `history` response (synthetic example)

```json
{ "ok": true, "contract": "fc.roster", "version": 2, "action": "history", "generatedAt": 1791100800000,
  "source": { "adapter": "condor-calendar", "basis": "synced-copy" },
  "range": { "from": "2025-10-01", "to": "2026-10-03" }, "truncated": false,
  "sectors": [ { "id": "s_…", "flightNumber": "DE9101", "origin": "FRA", "destination": "YYZ",
                 "dep": 1789891200000, "arr": 1789922400000, "originTz": "Europe/Berlin", "destTz": "America/Toronto",
                 "blockMin": 520, "provenance": "source", "basis": "synced-copy" } ] }
```

## `departures` action (provider data)

Phase 3. Scheduled departures of one airport, fetched by the backend from AeroDataBox (RapidAPI) and normalized. These are **provider facts** (`provenance: "provider"`): they are not roster sectors, not assignments, and are never merged into the roster. The browser never talks to the provider; the provider key lives only in the Apps Script **Script Property `FC_ADB_RAPIDAPI_KEY`** (value never in the repo, a response or a log). Same token, envelope and always-HTTP-200 rules as every other action. Code: `backend/apps-script/DeparturesV2.gs` (pure, tested in `tests/departures-backend.test.js`).

Request: `{"contract":"fc.roster","version":2,"action":"departures","token":"…","airport":"FRA","from":1791300000000,"to":1791343200000,"carriers":["DE"]}`

- `airport`: three capital letters **and** present in the airport zone table, else `unknown-airport`.
- `from`, `to`: integer epoch ms with `to > from` (else `bad-range`); `to - from` ≤ 24 h (else `range-too-long`); `from` ≥ now − 24 h and `to` ≤ now + 14 days (else `range-out-of-bounds`).
- `carriers`: optional (absent or `null` = no filter); otherwise 1–10 two-character codes `[A-Z0-9]{2}` (else `bad-request`); deduplicated and sorted in the answer.

Response: `{ok, contract, version, action:"departures", airport, airportTz, from, to, carriers|null, provider:"aerodatabox", generatedAt, fetchedAt, dropped, flights}`. `fetchedAt` is the oldest provider fetch among the chunks used (cache-aware); `dropped` counts provider entries that had no usable flight number or scheduled UTC time. Each flight: `{id:"f_<16 hex>", flightNumber, carrier|null, origin (= airport), destination|null, destinationName|null, scheduledDep, revisedDep|null, status, aircraft:{model|null, registration|null}|null, provenance:"provider"}` with `status` one of `scheduled | delayed | boarding | departed | cancelled | unknown`. Flights with `from ≤ scheduledDep < to`, cancelled ones kept, deduplicated by `id`, sorted by `scheduledDep` then `flightNumber`. Instants come from the provider's UTC times only; the airport zone comes from the backend table, never from the provider. Nothing is guessed: no airline names, no haul or region, no risk or eligibility.

Errors in addition to the common ones: `bad-request`, `unknown-airport`, `bad-range`, `range-too-long`, `range-out-of-bounds`, `departures-not-configured` (Script Property missing), `provider-rate-limited` (HTTP 429 after retries at 1.2 s and 2.5 s), `provider-auth-failed` (401/403), `provider-unavailable` (anything else: other status, network error, unparseable or unexpected body). Any failing provider call fails the whole request (no partial list); there is never mock or sample data; responses never contain the key, the provider URL or provider text.

Limits and caching: the provider allows 12 h per call, so a range is split into windows starting every 11 h (1 h overlap, removed by instant filtering and `id` deduplication), at most three calls per request, 1.1 s apart between real provider calls. Each window is cached server side (10 minutes if it starts within 6 h of now, otherwise 1 hour; skipped above 90,000 characters). `capabilities` lists `departures` in `actions` only when the key is configured and carries `limits.departuresMaxHours = 24`.

## Frontend use

- **Feature detection and fallback** (`src/controller.js`): with a v2 token saved in Settings, the `roster` action is called first and validated (`src/sources/contract-v2.js`). Any failure (no `doPost` → HTML page, refused token, wrong version, invalid payload, network, timeout) falls back to v5 `getStats` in the same refresh; structural failures are not retried for an hour. Settings shows which contract is in use and why.
- **Adapter** (`src/sources/fc-appscript-v2.js`) maps v2 onto the same `RosterSnapshot`: explicit rest-family windows (`off` with `subtype` off/free/leave/ort and `protected`), standby/reserve windows, report and pickup on the first sector of a duty, aircraft, stays (with hotels), and `dayStates` for coverage evidence. Only stays whose airport is a source fact and whose end is known become confirmed layover windows.
- **UI**: an unassigned day is shown with the airline's wording (Condor compact code "STR" with the full name "Strichtag", generic "UNAS" / "Unassigned day") as a neutral outlined, hatched capsule in Calendar, key, day detail, Today and the 7-day strip, deliberately unlike the OFF family; ORT is shown as a ringed "ORT" capsule in the rest family (Calendar, key, day detail, Today); leave as a striped "LEAVE" capsule; roster hotels as a record ("Hotel · from roster") with phone and, when verified, a map link; aircraft in the flight detail.
- **History**: server history is cached for a day and merged with device memory; labelled "Flight history" / "From your roster history", never as complete career history.

## Backend files (`backend/apps-script/`)

`CondorAdapterV2.gs` (flight-title format and description whitelist), `RosterModelV2.gs` (airline-independent builder), `RosterApiV2.gs` (`doPost`, token, reads), `AirportsV2.gs` (generated: `node scripts/gen-airports-gs.mjs`), `DeparturesV2.gs` (Phase 3 `departures` action; the only code that calls the provider, through `RosterApiV2.gs`'s live env), `CondorCodesV2.gs` (generated: `node scripts/gen-condor-codes-gs.mjs`; the source inventory table above is mirrored in `src/airlines/condor/roster-codes.js`, the one authoritative copy, and the adapter classifies titles from it). They reference project constants (calendar/sheet ids, sync tag) by name only and contain no ids, URLs or secrets. Installed (currently Version 24); install, rollback and kill switch in `backend/apps-script/README.md`.
