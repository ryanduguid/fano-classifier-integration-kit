/**
 * Tests for the legacy → canonical response adapter.
 *
 * Per Lesson #45 dogfood-on-first-fire: the adapter must self-validate
 * on the n=1000 PR β fixture's 16 known F2 cascade-override rows before
 * adopters can trust it in production-rewrite scenarios.
 *
 * These tests use synthetic legacy fixtures (the actual n=1000 v2 fixture
 * is `clawdog-brain:memory/data/2026-06-18-realistic-noise-n1000-v2.json`
 * which lives in private canon).
 */

import { describe, it, expect } from 'vitest';
import {
  adaptLegacyLineResponse,
  adaptLegacyResponse,
  SUBFLOOR_CONFIDENCE,
} from '../src/adapter.js';
import type {
  LegacyLineResponse,
  LegacyTrialBalanceResponse,
} from '../src/types.js';

describe('adaptLegacyLineResponse — Layer 1a wire-truth pass-through', () => {
  it('top-level predicted_code echoes operator_hint_predicted_code, NOT cascade verdict', () => {
    const legacy: LegacyLineResponse = {
      description: 'Other Income',
      // Legacy: predicted_code = cascade's verdict
      predicted_code: 'sbrm_4100',
      confidence: 0.85,
      cascade_topology: 'revenue',
      model_architecture: 'synthetic-test-model',
      // Operator submitted differently:
      operator_hint_predicted_code: 'sbrm_4401',
      operator_hint_source_topology: 'current_liabilities',
      operator_hint_confidence: 0.7,
      fano_status: 'accepted_fact',
      quarantine_reason: null,
    };
    const canonical = adaptLegacyLineResponse(legacy);
    expect(canonical.predicted_code).toBe('sbrm_4401'); // operator's
    expect(canonical.source_topology).toBe('current_liabilities'); // operator's
    expect(canonical.confidence).toBe(0.7); // operator's
    // Cascade ships in cascade.*:
    expect(canonical.cascade.predicted_code).toBe('sbrm_4100');
    expect(canonical.cascade.topology).toBe('revenue');
  });

  it('cascade.aggregate_confidence = the single Platt-scaled confidence (iter11.B; no l1/l2 split)', () => {
    const legacy: LegacyLineResponse = {
      description: 'Sales',
      predicted_code: 'sbrm_4100',
      confidence: 0.85,
      cascade_topology: 'revenue',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_4100',
      operator_hint_source_topology: 'revenue',
      operator_hint_confidence: 0.95,
      fano_status: 'accepted_fact',
      quarantine_reason: null,
    };
    const canonical = adaptLegacyLineResponse(legacy);
    expect(canonical.cascade.aggregate_confidence).toBe(0.85);
  });
});

describe('adaptLegacyLineResponse — warning derivation', () => {
  it('emits topology_disagreement warning when operator topology differs from cascade', () => {
    // Mirrors the 16 F2 PR β rows: operator sbrm_4xxx + current_liabilities → cascade sbrm_4100 + revenue
    const legacy: LegacyLineResponse = {
      description: 'Misclassified Revenue 952',
      predicted_code: 'sbrm_4100',
      confidence: 0.7658,
      cascade_topology: 'revenue',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_4401',
      operator_hint_source_topology: 'current_liabilities',
      operator_hint_confidence: 0.709,
      fano_status: 'accepted_fact',
      quarantine_reason: null,
    };
    const canonical = adaptLegacyLineResponse(legacy);
    const topoWarn = canonical.warnings.find((w) => w.kind === 'topology_disagreement');
    expect(topoWarn).toBeDefined();
    expect(topoWarn!.severity).toBe('warn');
    expect(topoWarn!.cascade_alternate_hypothesis.predicted_code).toBe('sbrm_4100');
    expect(topoWarn!.cascade_alternate_hypothesis.topology).toBe('revenue');
    expect(topoWarn!.suggested_repair_journal.repair_class).toBe('reclassify_topology');
    expect(topoWarn!.suggested_repair_journal.operator_action_required).toBe(true);
  });

  it('emits code_disagreement warning (info) when code differs but topology matches', () => {
    const legacy: LegacyLineResponse = {
      description: 'Wages',
      predicted_code: 'sbrm_5511',
      confidence: 0.85,
      cascade_topology: 'expenses',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_5500', // different code, same topology
      operator_hint_source_topology: 'expenses',
      operator_hint_confidence: 0.9,
      fano_status: 'accepted_fact',
      quarantine_reason: null,
    };
    const canonical = adaptLegacyLineResponse(legacy);
    const codeWarn = canonical.warnings.find((w) => w.kind === 'code_disagreement');
    expect(codeWarn).toBeDefined();
    expect(codeWarn!.severity).toBe('info');
    expect(codeWarn!.suggested_repair_journal.operator_action_required).toBe(false);
  });

  it('emits subfloor_abstention warning when cascade aggregate < 0.50', () => {
    const legacy: LegacyLineResponse = {
      description: 'Uncategorised',
      predicted_code: 'sbrm_5500',
      confidence: 0.4,
      cascade_topology: 'expenses',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_5500',
      operator_hint_source_topology: 'expenses',
      operator_hint_confidence: 0.85,
      fano_status: 'draft_fact',
      quarantine_reason: 'Sub-floor cascade confidence (0.45)',
    };
    const canonical = adaptLegacyLineResponse(legacy);
    const subfloorWarn = canonical.warnings.find((w) => w.kind === 'subfloor_abstention');
    expect(subfloorWarn).toBeDefined();
    expect(subfloorWarn!.severity).toBe('warn');
    expect(canonical.cascade.aggregate_confidence).toBeLessThan(SUBFLOOR_CONFIDENCE);
  });

  it('emits entity_conditional_drift warning (halt) when L3 firewall rejected', () => {
    const legacy: LegacyLineResponse = {
      description: 'Beneficiaries Account',
      predicted_code: 'sbrm_1122',
      confidence: 0.72,
      cascade_topology: 'current_assets',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_1122',
      operator_hint_source_topology: 'current_assets',
      operator_hint_confidence: 0.8,
      fano_status: 'draft_fact',
      quarantine_reason: 'Entity/Topological Drift: Anchor=current_assets, Guess=sbrm_1122, Entity=company',
    };
    const canonical = adaptLegacyLineResponse(legacy);
    const driftWarn = canonical.warnings.find((w) => w.kind === 'entity_conditional_drift');
    expect(driftWarn).toBeDefined();
    expect(driftWarn!.severity).toBe('halt');
    expect(driftWarn!.suggested_repair_journal.repair_class).toBe('verify_coa_config');
  });

  it('emits zero warnings when cascade fully agrees with operator above sub-floor', () => {
    const legacy: LegacyLineResponse = {
      description: 'Trading Revenue',
      predicted_code: 'sbrm_4100',
      confidence: 0.9,
      cascade_topology: 'revenue',
      model_architecture: 'synthetic-test-model',
      operator_hint_predicted_code: 'sbrm_4100', // same as cascade
      operator_hint_source_topology: 'revenue', // same as cascade
      operator_hint_confidence: 0.95,
      fano_status: 'accepted_fact',
      quarantine_reason: null,
    };
    const canonical = adaptLegacyLineResponse(legacy);
    expect(canonical.warnings).toHaveLength(0);
  });
});

describe('adaptLegacyResponse — full response transformation', () => {
  it('preserves status + equilibrium_valid + maps results', () => {
    const legacy: LegacyTrialBalanceResponse = {
      status: 'success',
      equilibrium_valid: true,
      results: [
        {
          description: 'Trading Revenue',
          predicted_code: 'sbrm_4100',
          confidence: 0.9,
          cascade_topology: 'revenue',
          model_architecture: 'synthetic-test-model',
          operator_hint_predicted_code: 'sbrm_4100',
          operator_hint_source_topology: 'revenue',
          operator_hint_confidence: 0.95,
          fano_status: 'accepted_fact',
          quarantine_reason: null,
        },
        {
          description: 'Probe Sentinel Balancing Line (NOT SCORED)',
          predicted_code: 'sbrm_2266',
          confidence: 0.95,
          cascade_topology: 'current_liabilities',
          model_architecture: 'synthetic-test-model',
          operator_hint_predicted_code: 'sbrm_2266',
          operator_hint_source_topology: 'current_liabilities',
          operator_hint_confidence: 0.99,
          fano_status: 'accepted_fact',
          quarantine_reason: null,
        },
      ],
    };
    const canonical = adaptLegacyResponse(legacy);
    expect(canonical.status).toBe('success');
    expect(canonical.equilibrium_valid).toBe(true);
    expect(canonical.results).toHaveLength(2);
    expect(canonical.results[0]!.predicted_code).toBe('sbrm_4100');
    expect(canonical.results[0]!.warnings).toHaveLength(0);
  });
});
