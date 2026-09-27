/**
 * Wire and SDK response types for the Fano Classifier client.
 *
 * LegacyLineResponse describes the ratified wire representation documented in
 * docs/response-schema.md. The adapter returns the SDK's retained canonical
 * shape: operator hints at the top level, Fano's prediction under `cascade`,
 * and SDK-derived warnings. This is not a promised future server schema.
 */

// ============================================================================
// Enums
// ============================================================================

/** Compatibility domain derived by the SDK from the reported topology. */
export type L1Domain = 'assets' | 'liabilities' | 'equity' | 'revenue' | 'expenses';

/** 7-class canonical topology (operator-submitted or cascade-derived). */
export type Topology =
  | 'current_assets'
  | 'non_current_assets'
  | 'current_liabilities'
  | 'non_current_liabilities'
  | 'equity'
  | 'revenue'
  | 'expenses';

/** Entity structure (operator-submitted per /ingest/trial_balance payload). */
export type EntityStructure =
  | 'company'
  | 'trust'
  | 'partnership'
  | 'sole_trader'
  | 'super_fund';

/** Fano firewall verdict per line item. */
export type FanoStatus = 'accepted_fact' | 'draft_fact' | 'quarantine';

/** SDK warning kinds; code_consolidation is retained but not derived here. */
export type WarningKind =
  | 'topology_disagreement'
  | 'code_disagreement'
  | 'code_consolidation'
  | 'entity_conditional_drift'
  | 'subfloor_abstention';

/** SDK severity recommendation per warning. */
export type WarningSeverity = 'info' | 'warn' | 'halt';

/** Suggested-fix classification. */
export type RepairClass =
  | 'reclassify_topology'
  | 'reclassify_code'
  | 'verify_coa_config'
  | 'no_action_needed';

// ============================================================================
// Request schema
// ============================================================================

/** SBRM code pattern: `sbrm_NNNN`. */
export type SbrmCode = `sbrm_${number}`;

/** A single line item in a trial-balance ingestion request. */
export interface LineItem {
  /** Operator-submitted description (account name as recorded). */
  description: string;
  /** Operator-submitted SBRM code (must match `^sbrm_\d+$`). */
  predicted_code: SbrmCode;
  /** Operator-submitted topology (from source CoA; structural wire-truth). */
  source_topology: Topology;
  /** Operator confidence in this classification (0.0 – 1.0). */
  confidence: number;
  /** Line item amount; positive or negative depending on Dr/Cr convention. */
  amount: number;
}

/** Trial-balance ingestion request payload. */
export interface TrialBalancePayload {
  entity_structure: EntityStructure;
  lines: LineItem[];
}

// ============================================================================
// SDK-derived warning payloads; these are not wire-reported warnings.
// ============================================================================

/** Cascade's alternate hypothesis for a line in disagreement. */
export interface CascadeAlternateHypothesis {
  predicted_code: SbrmCode;
  topology: Topology;
  /** The single confidence reported by Fano when produced by this adapter. */
  aggregate_confidence: number;
  /** Signed delta: cascade aggregate confidence minus operator confidence. */
  confidence_delta: number;
}

/** Structured reasoning behind a disagreement warning. */
export interface DisagreementReason {
  /** Human-readable structured-prose summary. */
  summary: string;
  /** Reported rule identifier; empty when unavailable, as on the ratified wire. */
  sbrm_rule_id: string;
  /** Compatibility projection: topology-derived domain and reported confidence. */
  l1_signal: {
    predicted_domain: L1Domain;
    confidence: number;
  };
  /** Compatibility projection of the same Fano prediction and confidence. */
  l2_signal: {
    predicted_code: SbrmCode;
    confidence: number;
  };
}

/** Review placeholders, not an executable or validated repair journal. */
export interface SuggestedRepairJournal {
  /** Human-readable explanation. */
  narrative: string;
  /** Zero-valued placeholders; the response does not establish posting direction. */
  proposed_entry: {
    debit: { account: string; amount: number };
    credit: { account: string; amount: number };
  };
  /** SDK review recommendation, not a server workflow decision. */
  operator_action_required: boolean;
  /** Class of repair action. */
  repair_class: RepairClass;
}

/** A single structured warning attached to a line item. */
export interface Warning {
  kind: WarningKind;
  severity: WarningSeverity;
  /** Human-readable one-line summary. */
  message: string;
  cascade_alternate_hypothesis: CascadeAlternateHypothesis;
  disagreement_reason: DisagreementReason;
  suggested_repair_journal: SuggestedRepairJournal;
}

// ============================================================================
// SDK response schema, retained under the public name 'canonical'.
// ============================================================================

/** Fano's prediction, to which the returned firewall verdict applies. */
export interface CascadeReading {
  predicted_code: SbrmCode;
  topology: Topology;
  /** Model identifier copied from the wire; older SDK-shaped responses may omit it. */
  model_architecture?: string;
  /** Compatibility copy of Fano's single reported confidence. */
  l1_confidence: number;
  /** Compatibility copy of the same confidence, not an independent measurement. */
  l2_confidence: number;
  /** Fano's single reported confidence when produced by this adapter. */
  aggregate_confidence: number;
}

/**
 * Per-line SDK response.
 *
 * The adapter copies reported operator hints into `predicted_code`,
 * `source_topology` and `confidence`. It preserves Fano's prediction under
 * `cascade`, regardless of agreement with those hints.
 *
 * Empty warnings mean no adapter warning predicate matched. Always inspect
 * fano_status and quarantine_reason separately: a timeout can have no warnings.
 */
export interface LineResponse {
  /** Echo of the operator-submitted description. */
  description: string;
  /** Operator-submitted code (Layer 1a wire-truth pass-through). */
  predicted_code: SbrmCode;
  /** Operator-submitted topology (Layer 1a wire-truth pass-through). */
  source_topology: Topology;
  /** Operator-submitted confidence (Layer 1a wire-truth pass-through). */
  confidence: number;
  /** Cascade's independent reading (Layer 1b advisory). */
  cascade: CascadeReading;
  /** Verdict on cascade.predicted_code, not on the top-level operator hint. */
  fano_status: FanoStatus;
  /** Reported reason, preserved without inferring a missing value. */
  quarantine_reason: string | null;
  /** SDK-derived advisories; their absence does not establish acceptance. */
  warnings: Warning[];
}

/** SDK response after adaptation, or from an endpoint serving this SDK shape. */
export interface TrialBalanceResponse {
  status: 'success';
  equilibrium_valid: boolean;
  results: LineResponse[];
}

// ============================================================================
// Ratified wire response schema; 'Legacy' is the retained public type name.
// ============================================================================

/**
 * Current-production response shape (iter11.B R3; wire-verified 2026-09-12).
 *
 * `predicted_code` is FANO'S OWN classification (not the operator's submission).
 * The operator's submitted `(predicted_code, source_topology, confidence)` are
 * echoed back as `operator_hint_*` and treated as a hint only. `fano_status` is
 * Fano's verdict on Fano's own prediction — NOT an audit of the operator's code.
 * The iter11.B collapse removed the L1/L2 split, so there is no `l1_domain`,
 * `cascade_l1_confidence`, or `cascade_l2_confidence` on the wire; the single
 * classifier's model revision is reported as `model_architecture`.
 * This interface describes the 11 fields listed in `docs/response-schema.md`.
 */
export interface LegacyLineResponse {
  /** Echo of the operator-submitted description. */
  description: string;
  /** FANO'S predicted code (NOT the operator's submission). */
  predicted_code: SbrmCode;
  /** Fano's Platt-scaled confidence in its own prediction. */
  confidence: number;
  /** 7-class canonical topology resolved from Fano's predicted_code. */
  cascade_topology: Topology;
  /** Model revision literal, e.g. "iter11.B_R3_entity_prefixed_single_classifier_with_platt_scaling". */
  model_architecture: string;
  /** Operator's original predicted_code (echoed hint). */
  operator_hint_predicted_code: SbrmCode;
  /** Operator's original source_topology (echoed hint). */
  operator_hint_source_topology: Topology;
  /** Operator's original confidence (echoed hint). */
  operator_hint_confidence: number;
  fano_status: FanoStatus;
  quarantine_reason: string | null;
}

/** Legacy top-level response shape. */
export interface LegacyTrialBalanceResponse {
  status: 'success';
  equilibrium_valid: boolean;
  results: LegacyLineResponse[];
}
