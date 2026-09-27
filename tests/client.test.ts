/**
 * Tests for the FanoClient HTTP client.
 *
 * Uses a mock fetch implementation; no live production calls.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FanoClient,
  FanoApiError,
  buildEquilibriumSentinel,
  wrapSingleLineProbe,
  isLegacyResponse,
  isCanonicalResponse,
} from '../src/client.js';
import type { LineItem, LegacyTrialBalanceResponse } from '../src/types.js';

describe('buildEquilibriumSentinel', () => {
  it('produces contra-side sentinel for asset-side primary', () => {
    const primary: LineItem = {
      description: 'Bank Accounts',
      predicted_code: 'sbrm_1137',
      source_topology: 'current_assets',
      confidence: 0.95,
      amount: 1500.00,
    };
    const sentinel = buildEquilibriumSentinel(primary);
    expect(sentinel.source_topology).toBe('current_liabilities');
    expect(sentinel.predicted_code).toBe('sbrm_2266');
    expect(sentinel.amount).toBe(-1500.00);
    expect(sentinel.confidence).toBe(0.99);
  });

  it('produces contra-side sentinel for liability-side primary', () => {
    const primary: LineItem = {
      description: 'Bank Overdrafts',
      predicted_code: 'sbrm_2266',
      source_topology: 'current_liabilities',
      confidence: 0.9,
      amount: 1000.00,
    };
    const sentinel = buildEquilibriumSentinel(primary);
    expect(sentinel.source_topology).toBe('current_assets');
    expect(sentinel.predicted_code).toBe('sbrm_1137');
    expect(sentinel.amount).toBe(-1000.00);
  });

  it('handles negative-amount primary (Shape Alpha F3 case)', () => {
    const primary: LineItem = {
      description: 'Cash & Cash Equivalents',
      predicted_code: 'sbrm_1137',
      source_topology: 'current_assets',
      confidence: 0.85,
      amount: -500.50, // Shape Alpha negative-balance bank
    };
    const sentinel = buildEquilibriumSentinel(primary);
    expect(sentinel.amount).toBe(500.50);
    // Net sum = 0
    expect(primary.amount + sentinel.amount).toBeCloseTo(0, 2);
  });
});

describe('wrapSingleLineProbe', () => {
  it('produces a 2-line balanced payload', () => {
    const primary: LineItem = {
      description: 'Trading Revenue',
      predicted_code: 'sbrm_4100',
      source_topology: 'revenue',
      confidence: 0.95,
      amount: 1000.00,
    };
    const payload = wrapSingleLineProbe(primary, 'company');
    expect(payload.lines).toHaveLength(2);
    expect(payload.entity_structure).toBe('company');
    const netSum = payload.lines.reduce((s, l) => s + l.amount, 0);
    expect(netSum).toBeCloseTo(0, 2);
  });
});

describe('isLegacyResponse / isCanonicalResponse type guards', () => {
  it('isLegacyResponse detects operator_hint_* fields', () => {
    const legacy = {
      status: 'success',
      equilibrium_valid: true,
      results: [
        {
          description: 'X',
          predicted_code: 'sbrm_4100',
          cascade_topology: 'revenue',
          model_architecture: 'synthetic-test-model',
          operator_hint_predicted_code: 'sbrm_4100',
        },
      ],
    };
    expect(isLegacyResponse(legacy)).toBe(true);
    expect(isCanonicalResponse(legacy)).toBe(false);
  });

  it('isCanonicalResponse detects cascade + warnings sub-objects', () => {
    const canonical = {
      status: 'success',
      equilibrium_valid: true,
      results: [
        {
          description: 'X',
          predicted_code: 'sbrm_4100',
          cascade: { predicted_code: 'sbrm_4100' },
          warnings: [],
        },
      ],
    };
    expect(isCanonicalResponse(canonical)).toBe(true);
    expect(isLegacyResponse(canonical)).toBe(false);
  });

  it('both return false for malformed input', () => {
    expect(isLegacyResponse(null)).toBe(false);
    expect(isLegacyResponse({})).toBe(false);
    expect(isLegacyResponse({ results: [] })).toBe(false);
    expect(isCanonicalResponse('string')).toBe(false);
  });
});

describe('FanoClient construction', () => {
  it('requires apiKey', () => {
    expect(() => new FanoClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('defaults schemaVersion to legacy', () => {
    const client = new FanoClient({ apiKey: 'test-key', fetchImpl: vi.fn() });
    expect(client).toBeDefined();
  });

  it('accepts canonical schemaVersion override', () => {
    const client = new FanoClient({
      apiKey: 'test-key',
      schemaVersion: 'canonical',
      fetchImpl: vi.fn(),
    });
    expect(client).toBeDefined();
  });
});

describe('FanoClient.ingestTrialBalance — schema dispatch', () => {
  it('applies adapter when schemaVersion=legacy and response is legacy-shape', async () => {
    const legacyResponse: LegacyTrialBalanceResponse = {
      status: 'success',
      equilibrium_valid: true,
      results: [
        {
          description: 'Trading Revenue',
          predicted_code: 'sbrm_4100',
          confidence: 0.9,
          cascade_topology: 'revenue',
          model_architecture: 'synthetic-test-model',
          operator_hint_predicted_code: 'sbrm_4401', // different
          operator_hint_source_topology: 'current_liabilities', // different
          operator_hint_confidence: 0.7,
          fano_status: 'accepted_fact',
          quarantine_reason: null,
        },
      ],
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => legacyResponse,
    });
    const client = new FanoClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
      schemaVersion: 'legacy',
    });
    const result = await client.ingestTrialBalance({
      entity_structure: 'company',
      lines: [{ description: 'Trading Revenue', predicted_code: 'sbrm_4401',
        source_topology: 'current_liabilities', confidence: 0.7, amount: 0 }],
    });
    // Adapter applied: top-level = operator's submission
    expect(result.results[0]!.predicted_code).toBe('sbrm_4401');
    expect(result.results[0]!.cascade.predicted_code).toBe('sbrm_4100');
    expect(result.results[0]!.warnings.length).toBeGreaterThan(0);
  });

  it('throws FanoApiError on HTTP 400 (equilibrium failure)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Equilibrium Failure: Net balance is 100.00' }),
    });
    const client = new FanoClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    await expect(
      client.ingestTrialBalance({ entity_structure: 'company', lines: [] }),
    ).rejects.toThrow(FanoApiError);
  });

  it('throws FanoApiError on HTTP 502 (substrate inconsistency)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ detail: 'Cascade substrate inconsistency: L1 dispatch miss' }),
    });
    const client = new FanoClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    try {
      await client.ingestTrialBalance({ entity_structure: 'company', lines: [] });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FanoApiError);
      expect((e as FanoApiError).httpStatus).toBe(502);
      expect((e as FanoApiError).detail).toContain('Cascade substrate inconsistency');
    }
  });
});

describe('FanoClient.probeSingleLine', () => {
  it('wraps line + sentinel, returns results[0] only', async () => {
    const legacyResponse: LegacyTrialBalanceResponse = {
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
          confidence: 0.99,
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
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => legacyResponse,
    });
    const client = new FanoClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    const result = await client.probeSingleLine(
      {
        description: 'Trading Revenue',
        predicted_code: 'sbrm_4100',
        source_topology: 'revenue',
        confidence: 0.95,
        amount: 1000.0,
      },
      'company',
    );
    // Sentinel is the 2nd row but probeSingleLine returns results[0]
    expect(result.description).toBe('Trading Revenue');
    expect(result.predicted_code).toBe('sbrm_4100');
  });
});
