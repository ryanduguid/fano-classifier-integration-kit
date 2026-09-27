/**
 * Adapter from the ratified wire response to the retained SDK response shape.
 *
 * Top-level classification fields copy the operator hints. Fano's prediction
 * is retained under `cascade`; the firewall verdict applies to that prediction.
 *
 * Warnings are derived by this SDK from reported fields. Signal slots copy one
 * reported confidence; no independent L1/L2 measurements or Prolog rule IDs
 * are available. Journal fields contain review placeholders, not posting
 * instructions. Empty warnings do not establish acceptance or firewall health.
 */

import type {
  LegacyLineResponse,
  LegacyTrialBalanceResponse,
  LineResponse,
  TrialBalanceResponse,
  Warning,
  WarningKind,
  WarningSeverity,
  RepairClass,
} from './types.js';

/** SDK confidence threshold for deriving a subfloor warning. */
export const SUBFLOOR_CONFIDENCE = 0.5;

/**
 * Adapt a single legacy line response into the canonical shape.
 *
 * @param legacy A row in the ratified wire representation.
 */
export function adaptLegacyLineResponse(legacy: LegacyLineResponse): LineResponse {
  // iter11.B collapsed L1+L2 into a single classifier; the wire carries one
  // Platt-scaled `confidence`, not separate l1/l2 signals. The aggregate IS
  // that single confidence (no min() over two signals that no longer exist).
  const cascadeAggregate = legacy.confidence;

  const warnings = deriveWarnings(legacy, cascadeAggregate);

  return {
    description: legacy.description,
    // Layer 1a pass-through: operator's submission becomes top-level
    predicted_code: legacy.operator_hint_predicted_code,
    source_topology: legacy.operator_hint_source_topology,
    confidence: legacy.operator_hint_confidence,
    // Layer 1b advisory: cascade's reading
    cascade: {
      predicted_code: legacy.predicted_code,
      topology: legacy.cascade_topology,
      model_architecture: legacy.model_architecture,
      // Single-classifier substrate (iter11.B): no separate L1/L2 signals on
      // the wire. Both slots carry the one Platt-scaled confidence for
      // backward-compatible shape; they are not independent measurements.
      l1_confidence: legacy.confidence,
      l2_confidence: legacy.confidence,
      aggregate_confidence: cascadeAggregate,
    },
    fano_status: legacy.fano_status,
    quarantine_reason: legacy.quarantine_reason,
    warnings,
  };
}

/**
 * Adapt a full legacy response into the canonical shape.
 */
export function adaptLegacyResponse(
  legacy: LegacyTrialBalanceResponse,
): TrialBalanceResponse {
  return {
    status: legacy.status,
    equilibrium_valid: legacy.equilibrium_valid,
    results: legacy.results.map(adaptLegacyLineResponse),
  };
}

// ============================================================================
// Warning derivation from legacy fields
// ============================================================================

function deriveWarnings(
  legacy: LegacyLineResponse,
  cascadeAggregate: number,
): Warning[] {
  const warnings: Warning[] = [];

  // Sub-floor abstention warning
  if (cascadeAggregate < SUBFLOOR_CONFIDENCE) {
    warnings.push(buildSubfloorWarning(legacy, cascadeAggregate));
  }

  // Entity-conditional drift (L3 firewall reject)
  if (
    legacy.fano_status === 'draft_fact' &&
    legacy.quarantine_reason !== null &&
    legacy.quarantine_reason.includes('Entity/Topological Drift')
  ) {
    warnings.push(buildEntityDriftWarning(legacy, cascadeAggregate));
  }

  // Topology disagreement
  const topologyDisagrees =
    legacy.cascade_topology !== legacy.operator_hint_source_topology;
  if (topologyDisagrees) {
    warnings.push(buildTopologyDisagreementWarning(legacy, cascadeAggregate));
  }

  // Code disagreement (same topology, different code)
  const codeDisagrees =
    legacy.predicted_code !== legacy.operator_hint_predicted_code;
  if (codeDisagrees && !topologyDisagrees) {
    warnings.push(buildCodeDisagreementWarning(legacy, cascadeAggregate));
  }

  return warnings;
}

function buildSubfloorWarning(
  legacy: LegacyLineResponse,
  cascadeAggregate: number,
): Warning {
  return {
    kind: 'subfloor_abstention',
    severity: 'warn',
    message: `Fano confidence ${cascadeAggregate.toFixed(2)} is below the SDK warning threshold of ${SUBFLOOR_CONFIDENCE.toFixed(2)}. Review the reported status and reason.`,
    cascade_alternate_hypothesis: {
      predicted_code: legacy.predicted_code,
      topology: legacy.cascade_topology,
      aggregate_confidence: cascadeAggregate,
      confidence_delta: cascadeAggregate - legacy.operator_hint_confidence,
    },
    disagreement_reason: {
      summary: 'The reported confidence is below the SDK threshold of 0.50. Check source records before choosing a classification.',
      sbrm_rule_id: '',
      l1_signal: {
        predicted_domain: l1DomainFromTopology(legacy.cascade_topology),
        confidence: legacy.confidence,
      },
      l2_signal: {
        predicted_code: legacy.predicted_code,
        confidence: legacy.confidence,
      },
    },
    suggested_repair_journal: noActionNeededJournal(legacy),
  };
}

function buildTopologyDisagreementWarning(
  legacy: LegacyLineResponse,
  cascadeAggregate: number,
): Warning {
  return {
    kind: 'topology_disagreement',
    severity: 'warn',
    message: `Cascade routes this line to ${legacy.cascade_topology} (${legacy.predicted_code}); operator submitted under ${legacy.operator_hint_source_topology} (${legacy.operator_hint_predicted_code}).`,
    cascade_alternate_hypothesis: {
      predicted_code: legacy.predicted_code,
      topology: legacy.cascade_topology,
      aggregate_confidence: cascadeAggregate,
      confidence_delta: cascadeAggregate - legacy.operator_hint_confidence,
    },
    disagreement_reason: {
      summary: `Fano reports ${legacy.cascade_topology}; the operator hint names ${legacy.operator_hint_source_topology}. This comparison does not verify either classification.`,
      sbrm_rule_id: '',
      l1_signal: {
        predicted_domain: l1DomainFromTopology(legacy.cascade_topology),
        confidence: legacy.confidence,
      },
      l2_signal: {
        predicted_code: legacy.predicted_code,
        confidence: legacy.confidence,
      },
    },
    suggested_repair_journal: {
      narrative: `Review source records and both reported classifications before choosing accounts or posting direction.`,
      proposed_entry: {
        // The response establishes neither posting amounts nor direction.
        // These zero-valued entries are review placeholders only.
        debit: { account: legacy.operator_hint_predicted_code, amount: 0 },
        credit: { account: legacy.predicted_code, amount: 0 },
      },
      operator_action_required: true,
      repair_class: 'reclassify_topology',
    },
  };
}

function buildCodeDisagreementWarning(
  legacy: LegacyLineResponse,
  cascadeAggregate: number,
): Warning {
  return {
    kind: 'code_disagreement',
    severity: 'info',
    message: `Cascade prefers code ${legacy.predicted_code}; operator submitted ${legacy.operator_hint_predicted_code} (same topology ${legacy.cascade_topology}).`,
    cascade_alternate_hypothesis: {
      predicted_code: legacy.predicted_code,
      topology: legacy.cascade_topology,
      aggregate_confidence: cascadeAggregate,
      confidence_delta: cascadeAggregate - legacy.operator_hint_confidence,
    },
    disagreement_reason: {
      summary: `The codes differ within ${legacy.cascade_topology}. A shared topology does not establish that either code is appropriate.`,
      sbrm_rule_id: '',
      l1_signal: {
        predicted_domain: l1DomainFromTopology(legacy.cascade_topology),
        confidence: legacy.confidence,
      },
      l2_signal: {
        predicted_code: legacy.predicted_code,
        confidence: legacy.confidence,
      },
    },
    suggested_repair_journal: {
      narrative: `Review source records before changing the code. Zero-valued entries are placeholders, not a proposed posting.`,
      proposed_entry: {
        debit: { account: legacy.operator_hint_predicted_code, amount: 0 },
        credit: { account: legacy.predicted_code, amount: 0 },
      },
      operator_action_required: false,
      repair_class: 'reclassify_code' as RepairClass,
    },
  };
}

function buildEntityDriftWarning(
  legacy: LegacyLineResponse,
  cascadeAggregate: number,
): Warning {
  return {
    kind: 'entity_conditional_drift',
    severity: 'halt',
    message: `L3 firewall rejected: ${legacy.quarantine_reason ?? '(no detail)'}`,
    cascade_alternate_hypothesis: {
      predicted_code: legacy.predicted_code,
      topology: legacy.cascade_topology,
      aggregate_confidence: cascadeAggregate,
      confidence_delta: cascadeAggregate - legacy.operator_hint_confidence,
    },
    disagreement_reason: {
      summary: 'The returned draft reason contains a drift marker recognised by this SDK. Review that reason and the original classification; the wire supplies no rule identifier.',
      sbrm_rule_id: '',
      l1_signal: {
        predicted_domain: l1DomainFromTopology(legacy.cascade_topology),
        confidence: legacy.confidence,
      },
      l2_signal: {
        predicted_code: legacy.predicted_code,
        confidence: legacy.confidence,
      },
    },
    suggested_repair_journal: {
      narrative: 'Verify the actual entity and review both classifications against source records. Correct submitted configuration only when it misstates the entity.',
      proposed_entry: {
        debit: { account: legacy.operator_hint_predicted_code, amount: 0 },
        credit: { account: legacy.predicted_code, amount: 0 },
      },
      operator_action_required: true,
      repair_class: 'verify_coa_config' as RepairClass,
    },
  };
}

function noActionNeededJournal(legacy: LegacyLineResponse) {
  return {
    narrative: 'Review source records, status and reason before selecting a classification. This response does not establish a journal entry.',
    proposed_entry: {
      debit: { account: legacy.operator_hint_predicted_code, amount: 0 },
      credit: { account: legacy.operator_hint_predicted_code, amount: 0 },
    },
    operator_action_required: true,
    repair_class: 'no_action_needed' as RepairClass,
  };
}

/** Best-effort mapping from 7-class topology back to 5-class L1 domain. */
function l1DomainFromTopology(
  topology: LegacyLineResponse['cascade_topology'],
): Warning['disagreement_reason']['l1_signal']['predicted_domain'] {
  switch (topology) {
    case 'current_assets':
    case 'non_current_assets':
      return 'assets';
    case 'current_liabilities':
    case 'non_current_liabilities':
      return 'liabilities';
    case 'equity':
      return 'equity';
    case 'revenue':
      return 'revenue';
    case 'expenses':
      return 'expenses';
  }
}

// Suppress unused-import warning for WarningKind / WarningSeverity (they're
// re-exported types used externally; kept here to anchor the import surface).
export type { WarningKind, WarningSeverity };
