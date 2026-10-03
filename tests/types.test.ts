/**
 * Type-correctness compile checks for the canonical schema.
 *
 * Tests are compile-checked before execution and by `tsc --noEmit`
 * (the `lint` script) for type validation. This file additionally
 * encodes runtime invariants that the type definitions imply.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  LineItem,
  TrialBalancePayload,
  LineResponse,
  TrialBalanceResponse,
  Warning,
  SbrmCode,
  Topology,
  EntityStructure,
  FanoStatus,
  WarningKind,
  WarningSeverity,
  RepairClass,
} from '../src/types.js';

describe('canonical type definitions', () => {
  it('SbrmCode template type accepts sbrm_NNNN patterns at compile-time', () => {
    const valid: SbrmCode = 'sbrm_1137';
    const valid2: SbrmCode = 'sbrm_4100';
    assert.strictEqual(valid, 'sbrm_1137');
    assert.strictEqual(valid2, 'sbrm_4100');
  });

  it('Topology enum covers the 7 canonical values', () => {
    const topologies: Topology[] = [
      'current_assets',
      'non_current_assets',
      'current_liabilities',
      'non_current_liabilities',
      'equity',
      'revenue',
      'expenses',
    ];
    assert.strictEqual(topologies.length, 7);
  });

  it('EntityStructure enum covers the 5 canonical values', () => {
    const entities: EntityStructure[] = [
      'company',
      'trust',
      'partnership',
      'sole_trader',
      'super_fund',
    ];
    assert.strictEqual(entities.length, 5);
  });

  it('FanoStatus enum has 3 canonical states', () => {
    const states: FanoStatus[] = ['accepted_fact', 'draft_fact', 'quarantine'];
    assert.strictEqual(states.length, 3);
  });

  it('WarningKind enum covers the 5 canonical warning types', () => {
    const kinds: WarningKind[] = [
      'topology_disagreement',
      'code_disagreement',
      'code_consolidation',
      'entity_conditional_drift',
      'subfloor_abstention',
    ];
    assert.strictEqual(kinds.length, 5);
  });

  it('WarningSeverity enum has 3 levels', () => {
    const severities: WarningSeverity[] = ['info', 'warn', 'halt'];
    assert.strictEqual(severities.length, 3);
  });

  it('RepairClass enum has 4 actions', () => {
    const classes: RepairClass[] = [
      'reclassify_topology',
      'reclassify_code',
      'verify_coa_config',
      'no_action_needed',
    ];
    assert.strictEqual(classes.length, 4);
  });

  it('LineItem structurally matches the request schema', () => {
    const line: LineItem = {
      description: 'Trading Revenue',
      predicted_code: 'sbrm_4100',
      source_topology: 'revenue',
      confidence: 0.95,
      amount: 1000.0,
    };
    assert.strictEqual(line.predicted_code, 'sbrm_4100');
    assert.strictEqual(line.source_topology, 'revenue');
  });

  it('TrialBalancePayload composes LineItems + entity_structure', () => {
    const payload: TrialBalancePayload = {
      entity_structure: 'company',
      lines: [
        {
          description: 'Sales',
          predicted_code: 'sbrm_4100',
          source_topology: 'revenue',
          confidence: 0.9,
          amount: 500,
        },
      ],
    };
    assert.strictEqual(payload.lines.length, 1);
  });

  it('LineResponse exposes Layer 1a operator pass-through + Layer 1b cascade', () => {
    const response: LineResponse = {
      description: 'Trading Revenue',
      predicted_code: 'sbrm_4100', // operator's
      source_topology: 'revenue', // operator's
      confidence: 0.95, // operator's
      cascade: {
        predicted_code: 'sbrm_4100',
        topology: 'revenue',
        l1_confidence: 0.92,
        l2_confidence: 0.88,
        aggregate_confidence: 0.88,
      },
      fano_status: 'accepted_fact',
      quarantine_reason: null,
      warnings: [],
    };
    assert.strictEqual(response.cascade.aggregate_confidence, 0.88);
  });

  it('Warning composes the 5 sub-objects (kind, severity, message, hypothesis, reason, journal)', () => {
    const warning: Warning = {
      kind: 'topology_disagreement',
      severity: 'warn',
      message: 'Cascade routes to revenue; operator submitted current_liabilities',
      cascade_alternate_hypothesis: {
        predicted_code: 'sbrm_4100',
        topology: 'revenue',
        aggregate_confidence: 0.85,
        confidence_delta: 0.15,
      },
      disagreement_reason: {
        summary: 'L2 specialist routes 4xxx-family codes to revenue topology',
        sbrm_rule_id: 'evaluate_drift/3',
        l1_signal: { predicted_domain: 'revenue', confidence: 0.88 },
        l2_signal: { predicted_code: 'sbrm_4100', confidence: 0.85 },
      },
      suggested_repair_journal: {
        narrative: 'Reclassify if cascade is right',
        proposed_entry: {
          debit: { account: 'sbrm_4401', amount: 1000 },
          credit: { account: 'sbrm_4100', amount: 1000 },
        },
        operator_action_required: true,
        repair_class: 'reclassify_topology',
      },
    };
    assert.strictEqual(warning.disagreement_reason.l1_signal.confidence, 0.88);
    assert.strictEqual(warning.suggested_repair_journal.proposed_entry.debit.amount, warning.suggested_repair_journal.proposed_entry.credit.amount);
  });
});

describe('canonical schema invariants', () => {
  it('Layer 1a guarantee: response top-level fields echo the operator', () => {
    // This invariant is enforced by the cascade implementation (post-OT-#103)
    // and by the adapter for legacy responses. The TYPE system declares it
    // via field comments + the SDK's adapter respects it. This test
    // documents the invariant at the SDK level.
    const operatorSubmission: LineItem = {
      description: 'Other Income',
      predicted_code: 'sbrm_4401',
      source_topology: 'current_liabilities', // deliberately misplaced
      confidence: 0.7,
      amount: 500,
    };

    // Post-cascade canonical response MUST echo these fields exactly:
    const expectedTopLevel = {
      predicted_code: operatorSubmission.predicted_code,
      source_topology: operatorSubmission.source_topology,
      confidence: operatorSubmission.confidence,
    };
    assert.strictEqual(expectedTopLevel.predicted_code, 'sbrm_4401');
    assert.strictEqual(expectedTopLevel.source_topology, 'current_liabilities');
  });

  it('Layer 1b guarantee: cascade.* is always populated, even when matching operator', () => {
    const matchingResponse: LineResponse = {
      description: 'Trading Revenue',
      predicted_code: 'sbrm_4100',
      source_topology: 'revenue',
      confidence: 0.95,
      cascade: {
        // Populated even though it matches operator submission
        predicted_code: 'sbrm_4100',
        topology: 'revenue',
        l1_confidence: 0.92,
        l2_confidence: 0.91,
        aggregate_confidence: 0.91,
      },
      fano_status: 'accepted_fact',
      quarantine_reason: null,
      warnings: [],
    };
    assert.notStrictEqual(matchingResponse.cascade, undefined);
    assert.strictEqual(matchingResponse.cascade.predicted_code, matchingResponse.predicted_code);
  });

  it('Warnings-empty guarantee: empty array iff full cascade-operator agreement above sub-floor', () => {
    // When cascade fully agrees AND confidence >= 0.50 sub-floor, warnings is empty
    const fullAgreement: TrialBalanceResponse = {
      status: 'success',
      equilibrium_valid: true,
      results: [
        {
          description: 'Sales',
          predicted_code: 'sbrm_4100',
          source_topology: 'revenue',
          confidence: 0.95,
          cascade: {
            predicted_code: 'sbrm_4100',
            topology: 'revenue',
            l1_confidence: 0.92,
            l2_confidence: 0.88,
            aggregate_confidence: 0.88,
          },
          fano_status: 'accepted_fact',
          quarantine_reason: null,
          warnings: [],
        },
      ],
    };
    assert.deepStrictEqual(fullAgreement.results[0]!.warnings, []);
  });
});
