# Step 6.6 — physical iPhone acceptance plan

Status (2026-10-14): **PREPARED — not started.** Build under test: `v2-redesign` @ `bb6c0f5` (or later docs-only
commits). The detailed engineering checklist remains in `docs/STEP-6.6-OFFLINE.md`; this is the run sheet.

## 1. Test environment (isolated; never production)

| Part | Plan | Why |
|---|---|---|
| Frontend | **Vercel preview deployment in a separate project** (e.g. `flight-control-preview`), deployed from a **staged copy** containing only `index.html`, `manifest.webmanifest`, `sw.js`, `src/`, `assets/` | HTTPS is mandatory on iPhone (service worker + WebCrypto source binding; LAN HTTP fails by design). GitHub Pages can't be used: one site per repo = production. A staged copy guarantees `reference/`, `docs/`, `tests/`, `.claude/` are never uploaded |
| Backend | **Synthetic test backend**: a separate private Apps Script web app returning the synthetic fc.roster v2 payload (generated from `tests/fixtures/condor-feed.synthetic.mjs` via the test harness), its own throwaway token, and a Script Property switch for `valid` / `timeout` / `malformed` / `empty` / `auth-required` | The frontend only accepts `script.google.com/…/exec` endpoints; the checklist needs failure modes; the production roster and token are never used on a test host |
| Protection | Preview protection **off** for that preview project only, with synthetic data only | iOS Home Screen apps have their own cookie/storage jar, so a Safari login cookie (Vercel Authentication) does not reach the installed app and blocks service-worker installation. With synthetic data there is nothing sensitive to protect; the code is already public on GitHub |

Not yet built: the staged-deploy script and the synthetic Apps Script backend (need approval). No tunnel tool
(cloudflared/ngrok/Tailscale) is installed; installing one is the alternative to Vercel.

## 2. Run sheet (record pass/fail + notes per line)

Record first: iPhone model, iOS version, preview URL (not committed), build commit, date.

1. **Install** — Safari → preview URL → Share → Add to Home Screen → launch the icon. Standalone window, correct icon/name.
2. **Initial online sync** — Settings: enter the synthetic endpoint, save; enter the synthetic token, *Save and test*. Today/Calendar/Flights show the synthetic roster; status reads "Last synced …"; offline-ready appears.
3. **Offline startup** — airplane mode on, Wi-Fi off; force-close the app; relaunch from the icon. App opens, shell loads, no network error page.
4. **Cached roster visibility** — still offline: Today, Calendar (month + a day detail), Flights (rotation + sector detail), Local/UTC toggle. Same data as step 2; status "Offline · Last synced …".
5. **Pull-to-refresh** — online, on Today/Calendar/Flights: short pull (no refresh), long pull + release (one refresh), pull then retreat (cancels), normal scrolling below the top unaffected, horizontal calendar swipe unaffected.
6. **Failure keeps data** — set backend switch to `timeout`, then `malformed`, then `empty`: refresh each time; saved roster and last-sync time unchanged (also after offline relaunch). Reset switch to `valid`.
7. **Recovery after reconnecting** — go offline, relaunch, then re-enable network: exactly one automatic refresh; "Last synced" updates.
8. **Sign out** — Settings → Sign out. Roster, history, token gone; Today/Calendar/Flights say access token required; home base, wake-up time, theme and Local/UTC preference remain. Force-close + relaunch offline: no roster reappears.
9. **Cross-tab/session** — Home Screen apps are single-window with their own storage: test in **two Safari tabs** on the preview URL (separate from the installed app): sign in both, Sign out in one → the other loses the roster without reload or on next focus. Note: Safari-tab and Home-Screen data are separate by design.
10. **Reset** — reconnect and sync, then Settings → Reset → confirm second tap. Endpoint, token, roster, history and all preferences cleared; app returns to setup; offline relaunch shows setup, not old data.
11. **Service-worker update** — with the app installed and synced, redeploy the preview with a rebuilt asset (any changed precached file gives a new cache version; e.g. a temporary preview-only label, never committed). (a) Reopen without force-closing: old version may persist (expected, I-006). (b) Force-close and relaunch online: new version active; saved roster intact; offline relaunch still works on the new version.
12. **Interrupted update** — start a preview update while offline/flaky; relaunch: app still launches offline on the previous version.

Pass criterion: steps 1–10 pass; 11–12 behave as documented. Any data shown after Sign out/Reset, or a blank
offline launch, is a release blocker.

## 3. Risks

- iOS may clear website data for Safari tabs not used for 7 days; Home Screen apps are exempt but storage can still
  be evicted under pressure — acceptance must not depend on long gaps.
- Service-worker update latency (I-006) is expected; do not treat 11(a) as a failure.
- Preview URLs are public while protection is off: keep data synthetic, delete the preview project after acceptance.
- Never enter the production endpoint or token on the preview host.
