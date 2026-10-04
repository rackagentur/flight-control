# Backend hardening (separate workstream)

**Status: NOT STARTED. Each step requires explicit approval.**
**Gate:** V2 may be developed and previewed against the existing backend, but it must **not** become the live/public version until BH-1 and BH-2 are deployed and verified.

The live Apps Script deployment is **not modified** during frontend development (Phases 2–7).
Detailed findings are tracked privately and are not published until fixed.

## Principles

- **Reversible:** every step ships as a new version of the *same* deployment (the URL is unchanged). Rollback = Manage deployments → Edit → previous version.
- **Contract-preserving:** trigger handler names and the `getStats` payload stay frozen; changes are additive.
- **Logged:** every deployed version number is recorded below.

## Steps

| Step | Goal | Notes |
|---|---|---|
| BH-0 | Baseline | Private plain-text export of every project file, the trigger list and the current deployment version number |
| BH-1 | Reduce the server entry-point surface | Trigger handler names unchanged |
| BH-2 | Access control for API actions | Must work without a CORS preflight; V2 `api/appscript.js` provides the hook |
| BH-3 | Framing protection | Default framing policy |
| Later | Cleanup after V2 is stable | Remove the legacy wrapper; de-collide shared function names; fix B1/B2/B4/B7/B9–B13; additive `getStats` fields (`DATA-GAPS.md`) |

## Deployment log

| Date | Step | Version | Verified by | Rollback version |
|---|---|---|---|---|
| — | — | — | — | — |
