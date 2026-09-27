# Response Schema — Fano `/ingest/trial_balance`

> **Ratified against `~/fano_engine/api/main.py`** sha256 `8d07ab84302e4c3f98dc7bfbd9c4ecaf32158741e2cbe7a50a19ee31fda6edc6` (648 lines; **Rev 27 iter11.B Phase 4a Path α**) on 2026-08-24 (turn-01 field-by-field grep) + 2026-08-25 (turn-02 branch-coverage grep).
>
> **This document supersedes `docs/response-schema-proposal.md`** which described an aspirational structured warning-payload architecture (five canonical warning kinds + rich payload schema) that the running service does not emit. That design lives on server-side pre-Rev-27, was decommissioned by the cascade-resolver collapse in June 2026, and was never restored. History is preserved in the private Brain canon (`memory/rev27-warning-loss-decision-record.md`), not here.
>
> **Why the change:** the mc16 consumer-trial-readiness ratification (2026-08-24) surfaced that the kit had been documenting the wire incorrectly for eight weeks. The kit is now authoritative against wire truth. If a future iteration reintroduces per-layer disagreement signals, the response schema will grow — and the review-trigger inside the Brain-side decision record will fire — but until then this document is the contract.

## Endpoint

```
POST https://fano-engine-afmurhqkaq-ts.a.run.app/ingest/trial_balance
Authentication: X-API-Key header
Content-Type: application/json
```

Auth is gated by Google IAM/Edge; see `docs/pre-flight-canary.md` §2 for the exact error signatures on missing/invalid keys.

## Request

Unchanged from prior kit versions. `TrialBalancePayload` with `entity_structure` + `lines[]`; each line has `description` + `predicted_code` + `source_topology` + `confidence` + `amount`. Full schema in `openapi/fano-classifier.openapi.json`.

## Response — top-level envelope (HTTP 200)

**Wire-verified at `api/main.py` lines 644–648:**

```python
return {
    "status": "success",
    "equilibrium_valid": equilibrium_valid,
    "results": results,
}
```

| Field | Type | Wire behaviour |
|---|---|---|
| `status` | `"success"` (literal) | Only value observed on HTTP 200. Non-200 responses use FastAPI default error envelopes (`{"detail": ...}`); see `docs/pre-flight-canary.md` for those. |
| `equilibrium_valid` | boolean | Always `true` on HTTP 200. Equilibrium violation (`abs(sum(line.amount)) > 0.01`) short-circuits with HTTP 400 before response construction. |
| `results` | array of `LineResult` | One entry per submitted line, in submission order. |

## Response — per-line `LineResult`

**11 fields per row in the pinned contract.** The recorded response construction uses the server's `base_response` dict at `api/main.py` line 566. All fields below are required by this contract.

| Field | Type | Source | Notes |
|---|---|---|---|
| `description` | string | Echo of `line.description` | Line 567. Always the exact submitted description, byte-for-byte. |
| `predicted_code` | string, pattern `^sbrm_\d+$` | Cascade output | Line 569. The iter11.B classifier's SBRM code. Not the submitted `predicted_code`. |
| `confidence` | number, `0.0 ≤ n ≤ 1.0` | Cascade output (Platt-scaled) | Line 570. Post-iter11.B this is a `CalibratedClassifierCV(method='sigmoid')`-calibrated probability, not raw softmax. |
| `cascade_topology` | enum (7 values) | Resolved via `resolve_canonical_topology(predicted_code)` from the SBRM ancestor graph | Line 571. Enum: `current_assets` / `non_current_assets` / `current_liabilities` / `non_current_liabilities` / `equity` / `revenue` / `expenses`. |
| `model_architecture` | string | Literal | Line 573. Currently `"iter11.B_R3_entity_prefixed_single_classifier_with_platt_scaling"`. Pin your benchmark to this string — it identifies the model revision your run was measured against. |
| `operator_hint_predicted_code` | string | Echo of `line.predicted_code` | Line 575. What YOU submitted. |
| `operator_hint_source_topology` | string | Echo of `line.source_topology` | Line 576. What YOU submitted. |
| `operator_hint_confidence` | number | Echo of `line.confidence` | Line 577. What YOU submitted. |
| `fano_status` | enum: `accepted_fact` / `draft_fact` / `quarantine` | Firewall verdict | See §"fano_status enum" below — the value has non-obvious semantics. |
| `quarantine_reason` | string OR `null` | Populated on any non-`accepted_fact` row; `null` only on `accepted_fact` | See §"quarantine_reason string shapes" below. **The field name is misleading; it fires on `draft_fact` rows too.** |

### `fano_status` enum semantics

The three values correspond to **branches** in the server's per-line processing pipeline:

**`accepted_fact`**: Fano classified the line and the L3 Prolog firewall passed its prediction. This does not validate a different operator hint or authorise a ledger posting. The consuming application owns review and posting decisions. Wire construction at `api/main.py` lines 622–626.

**`draft_fact`** — one of two paths fired:

- **Sub-floor abstention** (lines 585–590): cascade confidence fell below the SR #4 threshold (nominal 0.50 Platt-scaled). Fires *before* the L3 firewall query even runs. `quarantine_reason` = `"Sub-floor model confidence (0.XX)"`.
- **L3 firewall rejection** (lines 628–635): cascade classified but the Prolog firewall rejected the row as structurally illegal under SBRM. `quarantine_reason` = `"Entity/Topological Drift: Anchor=<topo>, Guess=<code>, Entity=<entity>"`.

Both `draft_fact` paths need review. The `quarantine_reason` string identifies the recorded branch. This kit does not create or manage a review queue.

**`quarantine`** — ⚠ **This is a naming trap.** Consumers reading `if row.fano_status == "quarantine"` expecting "L3 firewall rejected as structurally illegal" are **reading it wrong**. Structural-rule rejections come back as `draft_fact` (see above).

`quarantine` fires only on `subprocess.TimeoutExpired` when the Prolog subprocess doesn't return within 2 seconds. Wire construction at `api/main.py` lines 638–643. `quarantine_reason` = `"Firewall Timeout Execution Lock"`. This is a **substrate-health signal** — the Prolog engine hung or the query complexity exceeded the timeout budget. Not an SBRM-rule violation.

A future breaking-change server-side revision may rename this value (candidate `firewall_timeout` or `substrate_health`) to remove the trap. When that happens the kit will ship a companion vX.X.X release. Until then, code defensively: `if row.fano_status != "accepted_fact"` is the honest predicate for "this row needs operator review or triage."

### `quarantine_reason` string shapes

The field is populated on any non-`accepted_fact` row. Four known shapes:

| Shape | Fires when | Consumer signal |
|---|---|---|
| `null` | `accepted_fact` row | Fano's prediction passed the firewall. This does not validate a different operator hint or authorise posting. |
| `"Sub-floor model confidence (0.XX)"` where `0.XX` is the actual confidence | `draft_fact` sub-floor path (line 585) | Cascade lacked confidence. Route to operator; classify by hand. |
| `"Entity/Topological Drift: Anchor=<topo>, Guess=<code>, Entity=<entity>"` | `draft_fact` L3 firewall path (line 628) | L3 rejected as structurally illegal under SBRM. Route to operator; investigate the drift between operator-submitted classification and cascade's alternate. |
| `"Firewall Timeout Execution Lock"` | `quarantine` (line 638) | Prolog subprocess timeout — substrate-health issue, not a classification issue. Retry may succeed. Persistent timeout on the same row is a defect worth reporting. |

**Parsing discipline for consumers:** the strings are stable at these exact byte shapes as of substrate sha256 `8d07ab84…` (2026-08-24). Don't hard-code regex against them without a fallback path — future substrate revisions may change the exact wording. Match on the presence-vs-null of `quarantine_reason` for the load-bearing route decision; use the string content for triage sub-routing.

## Non-response error paths

Two structured HTTP 502 error paths fire at classification time, **before** response construction. These do NOT appear as `results[]` entries; they short-circuit the whole request:

- **Model bundle missing** (`api/main.py` line 553): `RuntimeError` from `resolve_classification()` when the iter11.B ONNX bundle isn't loadable. HTTP 502 `{"detail": "iter11.B model bundle missing: ..."}`.
- **Cascade substrate inconsistency** (line 559): `ValueError` or `FileNotFoundError` when the classified code can't be resolved to a canonical topology OR the ONNX file is missing. HTTP 502 `{"detail": "Cascade substrate inconsistency: ..."}`.

Both are substrate-health signals; a well-formed 200 response should be the modal case. Persistent 502 on repeated identical inputs is a defect to report.

Additionally, **Pydantic validation errors return HTTP 422** with the standard FastAPI error envelope. Note that the `input` field of the validation-error detail echoes the offending value — **including request-body content**. If sensitive strings can end up in `line.description` and you submit malformed payloads, that content lands in the 422 response body and in the Cloud Run request-response log. See `docs/pre-flight-canary.md` §"Logging discipline" for the full framing-vs-implementation caveat.

## Warning payload — historical note

Earlier kit versions (v0.1.0 through v0.1.4) documented five canonical warning kinds (`topology_disagreement`, `code_disagreement`, `code_consolidation`, `entity_conditional_drift`, `subfloor_abstention`) plus a rich structured `warnings[]` array in the response schema. **None of that ships on the wire.** The design was made against a pre-Rev-27 cascade architecture (L1 ONNX router + L2 ONNX specialist) that produced per-layer disagreement signals. Rev 27 Phase 4a collapsed L1+L2 into a single ONNX inference; the signal sources ceased to exist; the warning payload was decommissioned as an unnoted side effect.

**Consumers coding against the historical warning kinds will find zero of them fire in production.** The equivalent signal is now expressed via `fano_status != "accepted_fact"` + `quarantine_reason` string content, per the four shapes documented above.

If a future Fano iteration re-embeds per-layer disagreement signals, structured warnings become possible again and this document will be revised. Until then, do not expect a `warnings` field.

## OpenAPI codification status

The service's live `/openapi.json` currently declares the 200 response as `schema: {}` — untyped. This is because `api/main.py` returns a plain dict (no `response_model=` kwarg on the endpoint decorator). Consumer codegen tools (`openapi-python-client`, `openapi-typescript`, NSwag, Kiota) will produce clients that submit typed requests but return `dict[str, Any]` / `unknown` for responses.

If Fano-engine adopts a Pydantic `TrialBalanceResponse` model with this schema, the kit's pinned OpenAPI can be refreshed and consumer codegen improves for all adopters. That's a fano-engine-side change; not scope for this kit revision.

## Provenance

- Ratified against `~/fano_engine/api/main.py` sha256 `8d07ab84302e4c3f98dc7bfbd9c4ecaf32158741e2cbe7a50a19ee31fda6edc6` (648 lines).
- Wire forensic performed via two Streamace turns:
  - **turn-01** 2026-08-24 12:36 UTC — field-by-field grep of the 12 proposed schema fields.
  - **turn-02** 2026-08-25 02:39 UTC — full block dump of `api/main.py` lines 540-648 (response construction) with branch-coverage grep answering three named unknowns (`description` echo, `quarantine` enum semantic, L3 firewall branch structure).
- Substrate sha256 verified identical between both turns (no drift during the two-day forensic window).
- Both turns' outboxes live wire-authoritative on `streamace-comms@main:outbox/2026-08-2{4,5}-fano-response-schema-*/turn-0{1,2}.out.md`.
- Cross-ref (private Brain canon): `memory/2026-08-24-mc16-fano-response-schema-delta-report.md` + `memory/2026-08-25-mc17-fano-response-schema-delta-amendment-turn-02.md` + `memory/rev27-warning-loss-decision-record.md`.

Reopening this document requires a new wire forensic against the current `api/main.py` sha256 and a companion Brain-side dated addendum.
