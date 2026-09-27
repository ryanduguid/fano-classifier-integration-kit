# Fano Classifier — canonical examples (η.2)

Real fixture inputs + canonical response samples captured at production wire-truth.

## What's here

### `demo-gui/`

A **zero-build static HTML/JS playground** for hitting Fano interactively in the
browser. Open `index.html`, configure API key + entity + lines, fire
`POST /ingest/trial_balance`, see results rendered as colour-coded cards.

Designed for **Daniyal** (LodgeiT TypeScript) and **SamSaam**
(LodgeiT Depreciation_Transforms FastAPI/Azure) to inspect the response wire-truth
before they wire Fano into their own consumer surfaces.

→ See [`demo-gui/README.md`](./demo-gui/README.md) for run instructions.
→ See [`demo-gui/PROXY.md`](./demo-gui/PROXY.md) for the local CORS proxy you'll
   need until Fano-engine ships its own `CORSMiddleware`.

### `canonical-fixtures/`

Three canonical request/response fixtures captured at production
**`fano-engine-00032-qan` Rev 27 iter11.B** mini-Gauntlet on `2026-06-25T10:59:03Z`:

| Fixture | What it demonstrates |
|---|---|
| [`01-bank-accounts-all-entities.json`](./canonical-fixtures/01-bank-accounts-all-entities.json) | KC1 sanity — Bank Accounts routes to `sbrm_1137` at conf ≥ 0.50 → `accepted_fact` for all 5 entity structures |
| [`02-drawings-firewall-polarity.json`](./canonical-fixtures/02-drawings-firewall-polarity.json) | KC2 firewall polarity — the deployed Prolog `allowed_organisation` table for `sbrm_3140` quarantines company + super_fund (`draft_fact`) and accepts partnership + sole_trader (`accepted_fact`); trust routes to `sbrm_2240` separately. **Load-bearing demonstration of L#64 PROMOTED** (data-truth vs taxonomy-truth metric defect) |
| [`03-loans-to-beneficiaries-subfloor.json`](./canonical-fixtures/03-loans-to-beneficiaries-subfloor.json) | KC6 SR #4 0.50 sub-floor — model confidence collapses for the distributional-tail descriptor → `draft_fact` via "Sub-floor model confidence" quarantine for all 5 entities |

The fixtures contain both the **request template** (with placeholder `<one of N>`
substitution) and the **expected response shape** (with empirical per-entity
verdicts where applicable).

## Quick-start by stack

### Daniyal — LodgeiT TypeScript stack

```bash
# 1. Install the SDK
npm install github:lodgeit-labs/fano-classifier-integration-kit

```

```typescript
import { FanoClient } from "@lodgeit-labs/fano-classifier-client";

const apiKey = process.env.FANO_API_KEY;
if (!apiKey) throw new Error('FANO_API_KEY is required');

const fano = new FanoClient({
  apiKey,
  // baseUrl defaults to https://fano-engine-afmurhqkaq-ts.a.run.app
  // The default 'legacy' mode adapts wire fields into the SDK response.
});

const response = await fano.ingestTrialBalance({
  entity_structure: "sole_trader",
  lines: [
    { description: "Drawings", predicted_code: "sbrm_0000",
      source_topology: "current_assets", confidence: 0.5, amount: 100.0 },
    { description: "Sales Income", predicted_code: "sbrm_4110",
      source_topology: "revenue", confidence: 0.95, amount: -100.0 },
  ],
});

const row = response.results[0];
if (row) {
  console.log(row.predicted_code);         // Submitted hint: "sbrm_0000".
  console.log(row.cascade.predicted_code); // Fano's prediction.
  console.log(row.cascade.model_architecture); // Reported model identifier.
  console.log(row.fano_status, row.quarantine_reason); // Verdict on Fano's prediction.
  console.log(row.warnings); // SDK advisories; an empty list does not mean acceptance.
}
```

See [`src/client.ts`](../src/client.ts) for the full SDK surface +
[`src/types.ts`](../src/types.ts) for type definitions.

### SamSaam — LodgeiT Depreciation_Transforms FastAPI/Azure

The TypeScript SDK isn't directly consumable from Python. Generate a Python
client from the pinned OpenAPI spec:

```bash
# 1. Install openapi-python-client (one-time)
pip install openapi-python-client

# 2. Generate the client
openapi-python-client generate \
  --path openapi/fano-classifier.openapi.json \
  --custom-template-path /dev/null

# 3. Use it
from fano_classifier_client import Client
from fano_classifier_client.models import TrialBalancePayload, LineItem
from fano_classifier_client.api.default import ingest_trial_balance

client = Client(
    base_url="https://fano-engine-afmurhqkaq-ts.a.run.app",
    headers={"X-API-Key": os.environ["FANO_API_KEY"]},
)

response = ingest_trial_balance.sync(
    client=client,
    json_body=TrialBalancePayload(
        entity_structure="sole_trader",
        lines=[
            LineItem(description="Drawings", predicted_code="sbrm_0000",
                     source_topology="current_assets", confidence=0.5, amount=100.0),
            LineItem(description="Sales Income", predicted_code="sbrm_4110",
                     source_topology="revenue", confidence=0.95, amount=-100.0),
        ],
    ),
)
```

For a quick smoke test without code generation, plain `curl` works too:

```bash
curl -X POST "https://fano-engine-afmurhqkaq-ts.a.run.app/ingest/trial_balance" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $FANO_API_KEY" \
  -d @canonical-fixtures/02-drawings-firewall-polarity.json
```

(You'll need to substitute `<one of 5>` in the fixture first.)

## What "draft_fact" means for the consumer

Every row your consumer surface receives with `fano_status: "draft_fact"`
should route to an **operator-review queue** before any GL write. The
quarantine_reason field will be one of:

| quarantine_reason shape | What it means |
|---|---|
| `"Sub-floor model confidence (0.XX)"` | Model is < 0.50 confident; SR #4 sub-floor fired; surface the model's tentative guess for operator review |
| `"Entity/Topological Drift: Anchor=X, Guess=Y, Entity=Z"` | L3 Prolog firewall rejected the (code, topology, entity) combination per the deployed `allowed_organisation` table; surface the cascade alternate hypothesis side-by-side with the operator's source CoA |
| `"Firewall Timeout Execution Lock"` | The L3 Prolog subprocess timed out (rare); treat as transient; retry once before surfacing |

**Never auto-post a `draft_fact` row to the GL.** The SR #14 contract is that
no probabilistic claim mutates financial state without operator approval.

## Roadmap reminder

- η.0 ✅ scaffolding
- η.1 ✅ TypeScript SDK + types + adapter
- η.1.5 ✅ OpenAPI + SBRM lexicon
- **η.2 ✅ this PR — canonical fixtures + demo GUI + quick-starts**
- η.3 — implementation methodology docs (operator-review-queue pattern + warning-handling + repair-journal)
- η.4 — Daniyal-team one-page top-down briefing
