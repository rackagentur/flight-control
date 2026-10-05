# Flight Control V2: approved plan

Phase 1 approved 2026-10-04. Visual identity: **Adaptive Aviation**. Signature component: **Duty Horizon**.

## Approved decisions

| Topic | Decision |
|---|---|
| Hosting | Static repo frontend, cleanly separated from Apps Script. Apps Script is the temporary backend/data source |
| Framework | None. Native ES modules, no build step, `node --test`, no runtime deps (Leaflet lazy-loaded) |
| Times | V2 displays **IANA-corrected** times. v5 fixed-offset/DST errors are not reproduced; legacy values are kept only for parity classification |
| Security order | Backend hardening (BH-1, BH-2) before V2 is live/public; frontend development may preview against the existing backend; the live deployment is untouched during frontend work |
| Rule 5 (OFF vs SB/RE) | If the source cannot distinguish OFF / STANDBY / RESERVE → **UNKNOWN**. OFF is never shown merely because no flight is present. SB → STANDBY, RE → RESERVE when a source exposes them |
| Rule 4 (LAYOVER) | May be **inferred** when the evidence is strong: `status: layover, confidence: inferred, provenance: derived`. No layover when the itinerary is ambiguous |
| Navigation | Mobile: Today / Calendar / Flights / Map / More. More = Weather / Statistics / Controls / Settings |

## Phase 6 decisions: Flights + Destination Intelligence (approved 2026-10-04)

| ID | Topic | Decision |
|---|---|---|
| D1 | Weather | Open-Meteo, called directly from the browser with the **airport's** coordinates (as v5 did). No API key. **No weather network calls in review mode.** Failures degrade to an "unavailable" line and never block Flights |
| D2 | History | Device-local recent flights, **120 days, at most 300 sectors**, labelled **"Seen on this device"**. Never presented as complete roster, employment or career history. Deduplicated by a stable identity (flight number + route + local departure date); the source is authoritative inside the window it covers, so corrected or removed sectors replace remembered ones instead of duplicating them. Current-source and remembered flights stay visibly distinct |
| D3 | Crew intelligence | **Excluded** (privacy/product decision). v5's colleague history is derived from employee numbers of other people; V2 never reads, stores or shows it |
| D4 | Hotel record | No assigned hotel is invented or inferred. Without a hotel record in the normalized payload only legitimate actions are offered (search, saved list). The hotel-record contract belongs to a later backend phase |
| D5 | Destination intelligence | One reusable model (`model/destination.js`) and component (`ui/destination.js`). Flights uses it; Today adopts it only where it replaces a placeholder, without redesign. The dedicated Weather screen remains a later phase |
| D6 | Flight detail | Per **sector**, always inside its parent **rotation** (`#/flights/<sector id>`) |

Further Phase 6 rules: journeys/rotations before individual sectors; upcoming before remembered history; the v5 five-flight boundary is stated as a calm end of the list, not an error; destination intelligence appears only when applicable (never for home-base sectors); UNKNOWN/incomplete data follows the Phase 4–5 honesty rules; no new parser, classifier, airport table, time-zone code or rotation engine; no backend change; Map, Statistics, Controls and the Weather screen are not part of Phase 6.

## Phase 7 decisions: Roster Data Contract V2 (approved 2026-10-04)

| ID | Topic | Decision |
|---|---|---|
| D-SRC | Sources | Airline feed for the fresh window (from today); the synced calendar for earlier days and bounded history |
| D-HOTEL | Hotel blocks | A roster hotel block is source evidence that a stay exists and may lift the 6-day inferred-layover cap for that stay. It never creates sectors or rotations; provenance is kept explicit (stay `source`, end `derived`, standby-hotel airport `derived`/`unknown`) |
| D-OFF | Empty days | Never OFF. OFF/free/leave/ORT only from explicit source codes; empty covered days stay UNKNOWN |
| D-REPO | Backend sources | Tracked under `backend/apps-script/`, with no secrets, ids, URLs, tokens or personal data |
| D-TOKEN | Auth | Shared token in the POST body (Script Property `FC_V2_TOKEN`), never in the URL |
| ORT | Protected free day | Explicit source state in the rest family: `off`, subtype `ort`, `protected: true`, `source`. Visually distinct from ordinary OFF. Never inferred |
| Aircraft | Metadata | Optional source metadata on the sector (type code, registration when present). Never inferred; absence never affects classification |

Contract: `docs/CONTRACT-V2.md`. Status: steps 1–2 (local implementation and tests) only; installation, token, deployment and backend hardening are separate, later approvals.

---

## A. File structure

```
index.html                     shell: theme bootstrap (no flash), nav + main mounts, src/main.js
manifest.webmanifest           home-screen install
package.json                   type=module, node --test, no dependencies
assets/
  icons/                       icon.svg, apple-touch-icon.png (180), icon-192.png, icon-512.png
  css/
    tokens.css                 primitives → semantic tokens → light/dark → state palettes
    base.css                   reset, type scale, layout primitives, focus, reduced motion
    shell.css                  bottom bar / rail / sidebar, page frame, breakpoints
    components.css             hero, horizon, week strip, rotation, rows, sheets, buttons, stats
    screens.css                per-screen layouts
src/
  main.js                      boot: storage schema → theme → environment (UNKNOWN) → shell → router;
                               Phase 4 adds profile → roster source → refresh loop
  router.js                    hash routes (#/today …)
  store.js                     namespaced fc.v2.* storage, schema version, try/catch, reset
  theme.js                     Light/Dark/System preference + operational environment (data-state/tone)
  config/profile.js            user profile + defaults
  config/sources.js            source registry, active source, per-source settings
  sources/source.js            RosterSource interface + capability flags
  sources/fc-appscript-v5.js   v5 getStats → RosterSnapshot adapter
  sources/sample.js            synthetic snapshots for every state (design, demo, tests)
  api/appscript.js             getStats/sync/dashboard/dashboardPrev; timeout; HTML-error detection; token hook
  model/types.js               JSDoc typedefs
  model/roster.js              rotations, day roster, data window, layover inference
  model/state.js               operational state engine
  model/horizon.js             Duty Horizon model
  model/stats.js               statistics view-models + known-issue flags
  lib/time.js                  Intl/IANA formatting, local-day math, durations, +N day
  lib/html.js                  escaping tagged template, DOM helpers
  lib/format.js                numbers, plurals, relative time
  lib/geo.js                   great-circle arcs
  data/airports.js             ONE merged airport table: iata, city, country, cc, tz, lat, lon, tone
  services/weather.js          weather provider interface (Open-Meteo impl), session cache
  services/map.js              lazy Leaflet (CDN + SRI), earth-tone styling, tile provider config
  ui/shell.js                  navigation surfaces (tab bar / rail / sidebar) from one route list
  ui/icons.js                  inline SVG icon set + brand mark
  ui/components.js             shared primitives (page header, theme control, list row, slot, …);
                               split into ui/components/* when a component grows its own logic (Phase 4+)
  ui/environments.js           design-preview descriptions of the six environments (not roster data)
  ui/screens/                  today, calendar, flights, more, controls, settings, upcoming (placeholders for later phases)
tests/                         *.test.js + fixtures/ (synthetic/redacted only) + regression/
docs/                          AUDIT, PLAN, DATA-GAPS, BACKEND-HARDENING (+ DESIGN, REGRESSION later)
legacy/index-v1.html           preserved legacy frontend
```

Files are created in the phase that first needs them (no empty stubs).

**Phase 3 status (implemented):** tokens, theme engine, shell, router, store, icons, Today (UNKNOWN status + labelled environment preview), More, Controls (structure), Settings (live theme, structure), placeholders for Calendar/Flights/Map/Weather/Statistics.
**Phase 4 status (implemented):** normalized model (`model/types.js`), v5 adapter (`sources/fc-appscript-v5.js`), sector history (`model/history.js`), roster/duties/rotations/days (`model/roster.js`), state engine (`model/state.js`), Duty Horizon model + view (`model/horizon.js`, `ui/horizon.js`), 7-day strip (`ui/week.js`), IANA time library (`lib/time.js`), merged airport table (`data/airports.js`), transport + connection test (`api/appscript.js`), data controller (`controller.js`), profile (`config/profile.js`), review samples (`sources/sample.js`), Today with real normalized data, Settings → Roster source.
**Phase 5 status (implemented, uncommitted):** Calendar (`ui/screens/calendar.js`, `model/calendar.js`) on the shared day classifier (`roster.buildDays`, now range-based and duty-overlap based; rotations split at itinerary gaps); the state engine reads today from the same classifier; shared duty rendering (`ui/duty.js`); per-rotation Duty Horizon; review sample month with calendar scenarios.
Theme colours use CSS `light-dark()` driven by `color-scheme` (single definition per token; requires iOS/Safari 17.5+, Chrome 123+, Firefox 120+).

## B. Normalized data model

Times are epoch ms; dates are `YYYY-MM-DD` in `profile.homeTz`.

```
DutyStatus  = 'off'|'flight'|'standby'|'reserve'|'layover'|'training'|'positioning'|'unknown'
Confidence  = 'confirmed' | 'inferred' | 'unknown'
Provenance  = 'source' | 'derived' | 'none'

Airport     { iata, city, country, cc, tz, lat, lon, tone }
Sector      { id, flightNumber, origin, destination, dep, arr, blockMin,
              legacy:{ date, time, arrivalLocal, arrivalNextDay, fraDep, fraArr, daysUntil, pickup, wakeup } }
Duty        { id, kind, start, end, report?, pickup?, wakeup?, sectors[], layover?, base,
              confidence, provenance, source:SourceRef }
Rotation    { id, duties[], start, end, outstations[], closed }
Layover     { airport, from?, to?, hotel?, confidence, provenance }
Day         { date, status, confidence, provenance, label, dutyIds[], inWindow }
RosterSnapshot { source, capabilities, profile, window, days[], duties[], rotations[], offBlocks[],
                 dutyBlock, stats{month,year,allTime,flags}, map, achievements, warnings[] }
OperationalState { status, confidence, provenance, headline, location?, since?, until?,
                   nextEvent?{kind,at,label}, horizon, reasons[] }
```

**Capabilities:** `sectors, pickup, offDaysByAbsence, standbyWindows, reserveWindows, dayRoster, pastSectors, reportTime, hotels, history, actions[]` (v5 values in `DATA-GAPS.md`).

**Profile (replaces hardcoded v5 assumptions):**

| Key | Default |
|---|---|
| `homeTz` | `Europe/Berlin` |
| `base` | `FRA` |
| `homeBases` | `FRA` (operational crew base; rotations start/end here) |
| `noHotelAirports` | `FRA CGN DUS MUC HAM BER` (v5 "no hotel needed" list; hotel links only, never rotations) |
| `wakeupOffsetMin` | `60` |
| `referenceTzRow` | `true` |
| `alarmShortcutName` | `AddAlarm` |
| `hotelListUrl` | empty |
| `kmPerBlockHour` | `850` |
| `airlineAdapter` | `condor` |
| `name` | empty |

**v5 adapter rules:**
- `dep` / `arr` come from `depTimestamp` / `endTimestamp`. Every displayed time is derived from these through IANA zones.
- v5 display strings are kept in `legacy.*` and never displayed.
- `wakeup = pickup − wakeupOffsetMin`.
- `offBlocks` are built from `daysUntil` + `count`; the display strings are never parsed.
- `originTz` / `destTz` are ignored.
- `stats.flags.monthHoursIncludesRostered = true` (B2).

**State engine:** the first matching rule wins. Every result carries `reasons[]`.

| # | Condition | Result |
|---|---|---|
| 0 | No snapshot / error / untrusted source | `unknown` |
| 1 | `dep ≤ now < arr` | `flight` · confirmed · source |
| 2 | On duty: `pickup ≤ now < dep`, between sectors of one duty, or pre-departure on the duty's start day | `flight` · confirmed · source |
| 3 | Source exposes SB/RE windows and now is inside one | `standby` / `reserve` · confirmed · source |
| 4 | Strong layover evidence: the next known sector departs from a non-home airport, no earlier sector today, and (when `pastSectors`) the last completed sector arrived there | `layover` · inferred · derived |
| 5 | The source can distinguish OFF from SB/RE for today (`standbyWindows && reserveWindows`, or explicit off events) and nothing covers today | `off` · confirmed · source |
| 6 | Otherwise | `unknown` (e.g. "No duty reported; the source cannot confirm OFF") |

With v5: rule 3 never fires, and rule 5 never fires (open item O1 in `DATA-GAPS.md`).

## C. Screen architecture

**Navigation:**

| Width | Navigation |
|---|---|
| < 768 | Bottom bar: Today · Calendar · Flights · Map · More |
| 768–1199 | Left rail |
| ≥ 1200 | Sidebar with all 8 destinations + context panes |

**Screens:**

| Screen | Content | Desktop |
|---|---|---|
| Today | Status → next operational event + countdown → Duty Horizon → 7-day strip → context (local times, weather, hotel actions, duty block / next OFF) | Hero + horizon left; right rail with week, weather, time zones, days off, duty block |
| Calendar | Month roster grid; rotations as connected bands with outstation codes; OFF/SB/RE/unknown/no-data shading; today ring; day sheet | Grid + day-detail pane; month summary |
| Flights | Rotation → duty day → sectors; local dep/arr, +N, block, base reference; wake-up and pickup once per duty (alarm links) | List + rotation detail |
| Map | Earth-toned Leaflet, great-circle routes weighted by count, airports sized by visits | Full-bleed + top routes/airports list |
| Weather | Next destinations, forecast for the local arrival date | Card grid |
| Statistics | This month → This year → All time → Records → Achievements | Multi-column |
| Controls | Sync · Current month report · Previous month report (confirmation; real server message) · Saved hotels | — |
| Settings | Theme · Roster Source · Profile · Integrations · Data health · Reset local data | Two-column |

**v5 feature destinations (nothing silently disappears):**

| v5 feature | V2 destination |
|---|---|
| Next-duty hero | Today (FLIGHT) and Flights |
| Wake-up/pickup + iOS Shortcut alarms | Today next-event block, horizon nodes, Flights duty header |
| Hotel search + saved list | Today context, Flights rotation, Controls, Settings → Integrations |
| Next OFF / duty days in a row | Today context line |
| Live dual clocks | Today context |
| Departure countdown | Today next-event countdown |
| Duty block card | Today context / desktop rail; Statistics → month |
| Next days off | Today strip, Calendar, desktop rail |
| Flight list details | Flights |
| Month stats, progress, SB/RE breakdown | Statistics → month; Calendar summary |
| Month-end/year-end forecasts | Statistics (month forecast with a known-issue marker, B2) |
| All time, records, this year, achievements | Statistics |
| Route map | Map |
| Destination weather | Weather + Today context |
| Sync / reports | Controls |

## D. Design system

| Area | Spec |
|---|---|
| Type | System stack. Scale 64/56 (mobile 44) · 28 · 20 · 16 · 14 · 13 · 11 (micro, uppercase, +0.08em). Tabular numerals for times and codes |
| Spacing | 4 8 12 16 24 32 48 64 96. Gutter 16 mobile / 32 desktop |
| Radii | 10 · 16 · 24 · 32 (hero) |
| Surfaces | `--canvas` (atmosphere), `--surface-1`, `--glass` (blur 20 px, saturate 140 %, solid fallback), hairline `--line` sparingly; no shadow stacks |
| Semantic tokens | `--fg-1/2/3 --canvas --surface-1 --glass --line --accent --horizon-track --horizon-fill --caution --critical --positive` |
| Motion | 120 / 200 / 320 / 560 ms, `cubic-bezier(.2,.8,.2,1)`; state change = 560 ms atmosphere cross-fade; none under reduced motion |
| Theme | `html[data-theme=light|dark]`; System = no attribute + `prefers-color-scheme`; stored in `fc.v2.theme`; head bootstrap prevents a flash |
| State | `html[data-state=off|flight|standby|reserve|layover|unknown]` + `data-tone` for layovers; colour is determined by state only |
| Contrast | ≥ 4.5:1 body, ≥ 3:1 large, in every state × theme (automated test) |

## E. State palettes + Duty Horizon

Starting values; the contrast test is the gate.

| State | Light canvas · atmosphere · ink · accent | Dark canvas · atmosphere · ink · accent |
|---|---|---|
| OFF (stone/tobacco/sand) | `#EFE9E1` · `#E9DFD1→#D8C8B2→#B89F82` · `#2B241D` · `#8A5A35` | `#1C1814` · `#2A221B→#3A2E24→#5A4330` · `#F1E9DF` · `#C99A6B` |
| FLIGHT (slate/steel/sky) | `#E7EBEF` · `#DCE3EA→#B9C6D3→#8C9FB3` · `#1D252E` · `#3E5F80` | `#12171D` · `#1A222B→#26323F→#3B4E63` · `#E8EEF4` · `#8FB0CF` |
| STANDBY (graphite/taupe/amber) | `#ECE8E3` · `#E2DCD4→#C9BFB3→#A39686` · `#24211E` · `#A9782F` | `#171615` · `#22201E→#302C28→#4A4038` · `#EEE9E3` · `#D3A35A` |
| RESERVE | as STANDBY, accent `#8C7B6B` | as STANDBY, accent `#BCA894` |
| LAYOVER | tone accents: ocean `#2F5D66` · olive `#5E6B3A` · stone `#7A7268` · sand `#B08D5B` | tone ramps mirrored for dark |
| UNKNOWN (graphite/stone) | `#ECECEA` · `#E4E4E1→#CFCFCB→#A9A9A4` · `#262626` · `#6B6B66` | `#161616` · `#202020→#2C2C2B→#42423F` · `#ECECEA` · `#9A9A94` |

Layover tone comes from `airports.js` (deterministic; coastal/tropical → ocean, Mediterranean → olive, desert/MENA → sand, inland → stone; default stone).

**Duty Horizon:** phases `off → pickup → briefing → flight → layover → return → recovery`, each `{start?, end?, state: done|active|upcoming|unknown|n/a}`.
- **Line:** a 2 px track with progress fill to a "now" marker; ring nodes, the active one filled.
- **Missing data:** unknown segments are dashed and open-ended rotations fade. **No invented briefing time:** without `reportTime`, pickup → departure is one unlabelled segment.
- **Variants:** `full` (Today), `compact` (cards/day detail), `micro` (week strip). The model is reusable for future widgets and Live Activities.
- **Accessibility:** `role="img"` + a generated summary + a visually hidden list.

## F. Migration steps

1. Phase 2: hygiene, local `v1-legacy` tag, `v2-redesign` branch, legacy preserved, scaffold, docs, synthetic fixture.
2. Phase 3: tokens/theme, shell/router/store, labelled environment preview. (Per the Phase 3 brief, no backend integration and no sample roster data: the profile, sample source and **read-only CORS spike** move to the start of Phase 4.)
3. Phase 4: **CORS spike first (go/no-go)**, profile, sample source, `airports.js`, `time.js` (T1–T9), adapter, roster, state, horizon, Today (6 states). Validation inputs: redacted fixture, B3 answer.
4. Phase 5: Calendar.
5. Phase 6: Flights + Destination Intelligence (scope approved 2026-10-04; see "Phase 6 decisions"). Map, Weather screen, Statistics and Controls follow in later phases.
6. Phase 7: Roster Data Contract V2 (implemented; backend installed privately as Version 23 on 2026-10-05, Step H GO; not yet enabled in the app). Parity, manual regression and the PR to `main` follow (V2 private until the BH gate).
7. BH track: separately approved (`BACKEND-HARDENING.md`).

## G. Rollback

| Layer | Mechanism |
|---|---|
| Frontend | Work on `v2-redesign`; `main` unchanged until the Phase 7 PR; `git revert` of the merge; tag `v1-legacy` |
| Live operations | The v5 web app stays untouched and usable throughout |
| Backend | Versioned deployments (same URL); roll back to the previous version; BH-0 export |
| Data | V2 writes only via existing actions, so no data migration; local `fc.v2.*` with schema version and reset |
| Secrets | Endpoint/token stored only in the user's browser; token rotation = kill switch |

## H. Test plan

`node --test`, Node ≥ 21 (test-file globs) with full ICU.

**Suites:**

| Suite | Covers |
|---|---|
| `time` | T1–T9 |
| `adapter` | Field mapping, legacy preserved, no string parsing, offset-0 zones |
| `roster` | Rotations, window, layover inference, overnight attribution |
| `state` | Every rule ± negative; insufficient evidence → UNKNOWN, never OFF |
| `horizon` | Boundary instants, unknown segments |
| `html` | Escaping |
| `tokens` | Contrast |
| `repo-hygiene` | No personal data/secrets committable; fixtures synthetic |

**Time cases:**

| ID | Case |
|---|---|
| T1 | Europe/Berlin DST end, 25 Oct 2026 (departure on the day, arrival across the switch, overnight duty spanning 02:00–03:00) |
| T2 | Europe/Berlin DST start, 28 Mar 2027 |
| T3 | Destination DST: FRA→YYZ 30 Oct 2026 (Δ5 h) vs 2 Nov 2026 (Δ6 h); FRA→DXB across 25 Oct |
| T4 | +1 day arrivals: FRA→BKK night departure; YYZ→FRA overnight; same-day long block; +N judged on the destination's local date |
| T5 | Departures outside FRA: YYZ→FRA in Toronto time + base reference; non-base round trip |
| T6 | Overnight duty: pickup 23:30 D, departure 01:30 D+1 → duty on D, continuation shown; no fabricated pickup when v5 drops it (B7) |
| T7 | Calendar-day Today/Tomorrow (B4) |
| T8 | Zero-offset zones not dropped |
| T9 | Airport missing from the table → explicit UTC label + warning |

**Parity classification** (`tests/regression/v5-parity.test.js`):
- `same`: must match; any difference fails as an *unintended regression*.
- `intended-fix`: allowlisted by defect ID (B1, B4, B5, B6, B8, B2/B13 labels); reported, not failed.
- Unclassified fields fail.

**Manual Phase 7 checklist:**
- **API actions:** getStats · sync · dashboard · dashboardPrev (mutations only with owner confirmation).
- **Content:** map · weather · pickup · wake-up · countdown · arrival time zone · historical stats · iOS Shortcut alarms.
- **Settings and states:** theme persistence and live System switching · 6 states via sample data.
- **Layout:** 320 px / iPad / 1440 px.
- **Accessibility:** VoiceOver horizon summary · reduced motion · keyboard and focus.
- **Failure handling:** error / HTML-error / no-config / slow-network states.

**Synthetic fixture:** `tests/fixtures/getstats.v5.synthetic.json` replays v5 semantics over invented events (now = 2026-10-04 08:00 Europe/Berlin). It deliberately contains v5 defects so parity tests can classify intended fixes:

| Defect | Where it shows |
|---|---|
| B1 | FRA→YYZ legacy arrival 10:20 (true 12:20 EDT) |
| B3 | Layover 11–12 Oct listed as days off |
| B5 | YYZ→FRA shown at 00:30 Berlin |
| B7 | Return pickup dropped |
| B6 | FRA→DXB after the DST change |
| B4 | `ceil` days-until |
