# fano-classifier-integration-kit

**Integration kit for Fano, an SBRM classifier and firewall.**

Fano returns its own classification for each trial-balance row. Your submitted classification is echoed in `operator_hint_*` fields. The returned `fano_status` applies to Fano's prediction. The SDK adapts this wire response into a different layout, described below.

> **Package version:** v0.1.5. The [25 August 2026 changelog](docs/CHANGELOG.md) records the response contract ratified against `api/main.py` sha256 `8d07ab84...`. That contract has a single classifier and does not return the structured warnings described by the earlier design. See [the pinned response schema](docs/response-schema.md) for its fields and recorded behaviour; these documents do not verify a later deployment.

---

## Before you run Fano

**How you measure Fano determines whether your run produces a useful signal or a wrong verdict about a working system.**

**Read the verdict with the prediction it evaluates.** On the wire, `predicted_code`, `confidence` and `cascade_topology` describe Fano's prediction. The SDK moves that prediction under `cascade` and places operator hints at the top level. An accepted Fano prediction does not validate a different operator hint.

The ratified wire contract distinguishes `accepted_fact` (Fano's prediction passed the firewall), `draft_fact` (low confidence or a firewall rejection), and `quarantine` (a firewall timeout). Compare predictions with independently reviewed expected classifications; agreement with an upstream classifier alone does not establish accuracy. See [`docs/response-schema.md`](docs/response-schema.md) for the recorded branches and reasons.

**Record the model with each benchmark.** The kit documents a change from the older cascade to iter11.B R3. Results measured against the older architecture do not establish the newer model's accuracy. The SDK preserves the reported identifier in `cascade.model_architecture`; use it to identify the model behind recorded results. See [`docs/what-to-measure.md`](docs/what-to-measure.md) for the documented measurements.

**Default data-handling posture for the first trial:** submit synthetic or fully sanitised data on your first dataset, regardless of whether your subsequent datasets are real. The first run establishes the wire and catches integration defects; do that against data whose exposure risk is zero. Governance decisions about real-client data belong before real-client data hits the wire, not after.

**Pre-flight before your first real submission:** [`docs/pre-flight-canary.md`](docs/pre-flight-canary.md) walks a three-step canary that disambiguates dead-service / wrong-service / bad-key / bad-schema / valid-Fano-rejection — all five of which currently look identical from the client without the canary.

---

## Do not confuse these (Fano has doubles)

Each of the four pairs below is a chance to land on the wrong artefact and blame the docs. If you see behaviour that contradicts this repo, first check whether you are talking to the wrong half of one of these pairs.

### 1. Two live Cloud Run services

| ✅ Use this | ❌ Not this |
|---|---|
| `https://fano-engine-79859053141.australia-southeast1.run.app` (or the hash-form alias `https://fano-engine-afmurhqkaq-ts.a.run.app` — same service, both work) | `https://fano-classifier-79859053141.australia-southeast1.run.app` |
| Rev 27 iter11.B + CORS Phase 5 (CURRENT) | v0.1.0 (STALE, still up for legacy reasons) |
| Request body: `{entity_structure, lines[]}` | Request body: `{entity_structure, entries[]}` (different schema) |
| OpenAPI title: `"Fano-Constraint API"` | OpenAPI title: `"Fano-Constraint SBRM Classifier - Batched Subprocess Cascade"` |
| Requires `X-API-Key` header | Currently unauthenticated |

**Discriminator:** send a deliberately-empty POST body (`-d '{}'`). Fano-engine returns HTTP 403 `{"detail":"Not authenticated"}` (auth-first). The stale service returns HTTP 422 with `"loc":["body","entries"]` in the validation error — the `entries` field name IS the giveaway. See [`docs/pre-flight-canary.md`](docs/pre-flight-canary.md) Step 1 for the full disambiguation table.

### 2. Two repos with almost-identical names

| ✅ Use this | ❌ Not this |
|---|---|
| `lodgeit-labs/fano-classifier-integration-kit` (PUBLIC) | `lodgeit-labs/fano-classifier-integration` (PRIVATE, superseded) |
| This repo. Contains v0.1.0 through v0.1.5. | Predecessor kit, v0.1.0 + v0.1.1 only, pushed 2026-05-13 last. Not maintained. |

### 3. Two model architectures

| ✅ Current | ❌ Retired |
|---|---|
| iter11.B R3 — single entity-prefixed classifier + Platt scaling + L3 Prolog firewall | L1 ONNX router → L2 ONNX specialist → L3 Prolog firewall |
| Live since 2026-06-25 10:55 UTC on `fano-engine-00032-qan` and successors | Live pre-2026-06-25 |
| Reported in `results[0].model_architecture` field as `"iter11.B_R3_entity_prefixed_single_classifier_with_platt_scaling"` | Referenced in older PR discussion + earlier CHANGELOG entries |

**Consequence for benchmarks:** any performance figure quoted against the retired cascade (97.3% at conf ≥0.85; 21% end-to-end classification accuracy; 75% live-traffic acceptance) does not apply to iter11.B. See `docs/architecture.md` §-1 for the architecture change note, and [`docs/what-to-measure.md`](docs/what-to-measure.md) for what to measure against the current architecture.

### 4. Two threshold semantics

| ✅ Current | ❌ Retired |
|---|---|
| Confidence values in responses are **Platt-scaled** (calibrated via `CalibratedClassifierCV(method='sigmoid')` at iter11.B) | Confidence values in earlier canon were raw softmax outputs |
| A `confidence: 0.87` is a calibrated probability estimate | A `confidence: 0.87` was a raw model output |

**Consequence:** the nominal confidence threshold `0.50` documented in older canon is a Platt-scaled 0.50, not a raw-softmax 0.50. Sub-floor abstention behaviour at that threshold has not been re-anchored empirically on the current architecture. Treat sub-floor thresholds as "nominal 0.50 pending empirical re-anchor" for the trial and record the actual observed abstention-trigger threshold if your data hits it — that observation is useful for calibrating future canon.

---

## Quick path for adopters

- **Browser playground**: serve `examples/demo-gui/` over HTTP, then enter the endpoint and your API key. See its README for browser-origin requirements.
- **Canonical fixtures** — `examples/canonical-fixtures/` carries three request/response pairs captured at production wire-truth on `2026-06-25T10:59:03Z` (KC1 Bank Accounts, KC2 Drawings firewall polarity, KC6 Loans-to-Beneficiaries sub-floor).
- **Daniyal (LodgeiT TypeScript stack)** — `npm install github:lodgeit-labs/fano-classifier-integration-kit` and import `FanoClient`. See `examples/README.md` for the 10-line usage snippet.
- **SamSaam (Depreciation_Transforms FastAPI/Azure)** — generate a Python client from `openapi/fano-classifier.openapi.json` via `openapi-python-client`, or hit the endpoint with plain `curl`. Both paths shown in `examples/README.md`.

---

## Wire responses and SDK responses

The wire response follows the pinned contract in [`docs/response-schema.md`](docs/response-schema.md). The SDK keeps its existing public response layout:

| SDK field | Source |
| --- | --- |
| Top-level `predicted_code`, `source_topology`, `confidence` | Operator hints from the wire |
| `cascade.predicted_code`, `cascade.topology`, `cascade.aggregate_confidence` | Fano's reported prediction and confidence |
| `cascade.model_architecture` | Reported model identifier |
| `fano_status`, `quarantine_reason` | Unchanged wire verdict and reason, applying to Fano's prediction |
| `warnings` | Advisories derived by the SDK |

The public option name `schemaVersion: 'legacy'` selects wire adaptation and also accepts an SDK-shaped response. `'canonical'` requires the SDK shape directly. These names do not promise a server migration. The exported response guards distinguish structural families; they do not validate every nested field or establish accounting correctness.

Warnings can be empty for a firewall timeout. Always inspect the verdict and reason separately. Compatibility L1/L2 fields copy one reported confidence; the wire does not supply independent signals or a rule identifier. Suggested journal fields contain zero-valued review placeholders and do not establish posting amounts or direction.

## Consumer workflow

Submit a trial balance, inspect Fano's prediction and verdict, and review disagreements against source records. The consuming application owns approval and ledger posting. This kit does not implement an approval queue, a ledger write or a cryptographic approval signature.

## Audience

- **First adopter:** Daniyal's team at LodgeiT Labs (TypeScript stack)
- **Subsequent adopters:** LodgeiT-monolith (Anton's workflow module), Coracle (control plane), third-party AI agents and human developers

## Roadmap

- **η.0** ✅ — repo creation + initial scaffolding (v0.1.0)
- **η.1** ✅ — TypeScript SDK + type definitions (the Daniyal-team-consumable layer; v0.1.0)
- **η.1.5** ✅ — OpenAPI contract + SBRM lexicon snapshot + LEXICON.md (v0.1.1; this release)
- **η.2** — Examples (real fixture inputs + canonical response samples + warning-handling patterns)
- **η.3** — Implementation methodology docs (operator-review-queue pattern + warning-handling + repair-journal)
- **η.4** — Daniyal-team briefing (one-page top-down spec)

## Structure

```
fano-classifier-integration-kit/
├── README.md              # this file
├── LICENSE                # Apache 2.0
├── .gitignore             # standard Node/TypeScript
├── package.json           # @lodgeit-labs/fano-classifier-client@0.1.5
├── docs/                  # architecture + getting-started + lexicon resolution
│   ├── architecture.md    # Ratified against api/main.py sha256:8d07ab84... (Rev 27)
│   ├── response-schema.md # Ratified response contract with wire line-number citations
│   ├── getting-started.md # quick orientation for adopters
│   └── LEXICON.md         # how to resolve sbrm_NNNN → human name
├── openapi/               # versioned wire contract + SBRM lexicon snapshot
│   ├── fano-classifier.openapi.json   # OpenAPI 3.1 spec fetched from production (Rev 26 mc08)
│   └── sbrm-lexicon-au.json           # 1,651-code LodgeiT-AU lexicon (pinned v0.1.1 snapshot)
├── src/                   # TypeScript SDK (η.1 — populated)
├── examples/              # canonical request/response examples (η.2 — staged)
└── .github/               # CI hygiene
```

## Reference architecture

The canonical architecture document is at [`docs/architecture.md`](docs/architecture.md), ratified against wire truth (`~/fano_engine/api/main.py` sha256 `8d07ab84...`) on 2026-08-24 mc16 + 2026-08-25 mc17.

- **Operator wire-truth (AUTHORITATIVE).** What you submit is echoed at `operator_hint_*` fields for audit; Fano never mutates your input.
- **Cascade independent reading.** The single entity-prefixed classifier produces `predicted_code` + `confidence`; `cascade_topology` is resolved from that code via the SBRM ancestor graph.
- **Four wire branches on the response** — sub-floor abstention (`draft_fact`), L3 firewall PASS (`accepted_fact`), L3 firewall FAIL (`draft_fact` with `"Entity/Topological Drift"` string), L3 firewall TIMEOUT (`quarantine` — substrate-health signal, NOT structural rejection).
- **Response schema (ratified)** — [`docs/response-schema.md`](docs/response-schema.md) is the wire contract with substrate sha256 pinned in the provenance header. `openapi/fano-classifier.openapi.json` still declares the response as untyped because `api/main.py` doesn't yet declare a `response_model=` on the endpoint decorator; consumer codegen produces untyped responses until that lands upstream.

**On the five historical warning kinds** — `topology_disagreement`, `code_disagreement`, `code_consolidation`, `entity_conditional_drift`, `subfloor_abstention`: these were designed against a pre-Rev-27 L1+L2 cascade that produced per-layer disagreement signals. Rev 27 Phase 4a collapsed the cascade into a single ONNX inference; the signal sources ceased to exist; the warning payload was decommissioned as an unnoted side effect. See `docs/architecture.md` §6 for the historical note. Consumers coding against those kinds will find zero of them fire in production.

## API surface

Production endpoint: `https://fano-engine-afmurhqkaq-ts.a.run.app/ingest/trial_balance`

The versioned OpenAPI 3.1 contract is at [`openapi/fano-classifier.openapi.json`](openapi/fano-classifier.openapi.json) — fetched from production at v0.1.1 release (Rev 26 mc08). Suitable for generating strongly-typed clients (NSwag / Kiota / openapi-python-client / openapi-typescript).

Request shape (Pydantic-validated; see OpenAPI for canonical schema):

```yaml
{
  "entity_structure": "company" | "trust" | "partnership" | "sole_trader" | "super_fund",
  "lines": [
    {
      "description": "<account name as submitted>",
      "predicted_code": "sbrm_NNNN",
      "source_topology": "current_assets" | "non_current_assets" | "current_liabilities" | "non_current_liabilities" | "equity" | "revenue" | "expenses",
      "confidence": 0.0-1.0,
      "amount": <decimal>
    },
    ...
  ]
}
```

Equilibrium constraint: `abs(sum(line.amount for line in lines)) <= 0.01`. Single-line probing requires a sentinel balancing line.

The response returns `predicted_code: "sbrm_NNNN"` — to resolve those codes to human-readable names, see [`docs/LEXICON.md`](docs/LEXICON.md) and the pinned [`openapi/sbrm-lexicon-au.json`](openapi/sbrm-lexicon-au.json) lookup table (1,651 codes covering the LodgeiT-AU taxonomy).

TypeScript SDK consumes this contract directly; see [`src/types.ts`](src/types.ts) and [`src/client.ts`](src/client.ts).

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Source

Fano canonical canon lives at [`futureWA/clawdog-brain`](https://github.com/futureWA/clawdog-brain) (private). Architecture decisions referenced here trace back to merged PRs in that repo:

- **PR #446** — sprint design + two-layer responsibility model (PR α §0)
- **PR #451** — verdict deep-dive (95.66% lenient conditional accuracy on the operator-committed slice)
- **PR #453** — topology-disagreement reframe + rich warning-payload schema (PR ζ.0)
- **PR #454** — QA-corpus-bearing fixture re-mint (PR ζ.1; PII-filtered safe vocabulary)

---

*This kit is the open-development surface for the Fano Classifier methodology. Built by LodgeiT Labs.*
