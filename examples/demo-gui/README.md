# Fano Classifier — Trial Balance Playground (demo GUI)

A **zero-build static HTML/JS playground** for hitting Fano's
`POST /ingest/trial_balance` at the live production URL and inspecting the
response shape interactively. Designed for **Daniyal** (LodgeiT TypeScript)
and **SamSaam** (LodgeiT Depreciation_Transforms FastAPI/Azure) to see the
response wire-truth before they build their own consumer surface.

## What it does

- Builds a trial-balance payload interactively (entity structure + N lines)
- Live `net_balance` indicator (warns when unbalanced; Fano returns HTTP 400
  via `api/main.py:489` equilibrium check)
- Three canonical preset payloads from today's mini-Gauntlet
  (KC1 Bank Accounts / KC2 Drawings firewall polarity / KC6 Loans-to-Beneficiaries sub-floor)
- Renders each result line as a card colour-coded by `fano_status`
  (green `accepted_fact` / orange `draft_fact` / red `quarantine`)
- Shows raw request + raw response JSON in collapsible `<details>` panels
- API key and base URL saved in browser storage when available; manual input still works if storage is blocked

## CORS

The [changelog](../../docs/CHANGELOG.md) records CORS support from 26 June 2026.
Browser access depends on the deployment allowing the page's origin and the
`X-API-Key` header. If a deployment blocks your origin, check its CORS settings
or use your approved application proxy. Keep browser security enabled.

Enter the final endpoint URL. The demo rejects redirects so the key and payload
cannot be forwarded to a redirected destination. A 30-second timer cancels
stalled requests, including response-body reads, and allows a retry.

## Running it (local)

```bash
# From the repo root:
python3 -m http.server 8000 --directory examples/demo-gui
# or:
npx http-server examples/demo-gui -p 8000

# Open http://localhost:8000 in your browser
# Configure the API key and endpoint URL, then click Fire
```

Use the HTTP server so the browser can load the JavaScript module consistently.

## Recorded fixture results

The preset inputs accompany responses recorded on 25 June 2026 at 10:59:03 UTC.
These are historical examples, not predictions for a later deployment:

| Preset | Sample result |
|---|---|
| KC1 · Bank Accounts × company | `sbrm_1137 / conf 0.50+ / current_assets / accepted_fact` |
| KC2 · Drawings × company | `sbrm_3140 / 0.696 / equity / draft_fact` (firewall rejection) |
| KC2 · Drawings × trust | `sbrm_2240 / 0.797 / current_liabilities / accepted_fact` |
| KC2 · Drawings × sole_trader | `sbrm_3140 / 0.641 / equity / accepted_fact` |
| KC6 · Loans to Beneficiaries × company | `sbrm_1285 / 0.326 / current_assets / draft_fact` (sub-floor; SR #4 0.50 floor) |

The Drawings preset is particularly informative — flip the `entity_structure`
across all 5 values and watch how the `fano_status` flips between `accepted_fact`
and `draft_fact` per the deployed Prolog firewall's `allowed_organisation` table.
This is the load-bearing **operator-review surfacing** behaviour your consumer
needs to render.

## File layout

```
demo-gui/
├── index.html       # entry point
├── demo.css         # styles (no framework)
├── demo.js          # ES module (no build)
├── PROXY.md         # 30-line local CORS proxy template
└── README.md        # this file
```

Total: ~10 KB; no dependencies.

## Next stages

When the Fano CORS sprint lands and `--allow-unauthenticated` stays gated by
`X-API-Key`, this same `index.html` runs against production from any origin
(including GitHub Pages at `https://lodgeit-labs.github.io/fano-classifier-integration-kit/demo-gui/`
once Pages is enabled on the repo).

Until then: use the local proxy or local server pattern above.
