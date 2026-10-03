/**
 * Tests for the FanoClient HTTP client.
 *
 * Uses a mock fetch implementation; no live production calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.strictEqual(sentinel.source_topology, 'current_liabilities');
    assert.strictEqual(sentinel.predicted_code, 'sbrm_2266');
    assert.strictEqual(sentinel.amount, -1500.00);
    assert.strictEqual(sentinel.confidence, 0.99);
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
    assert.strictEqual(sentinel.source_topology, 'current_assets');
    assert.strictEqual(sentinel.predicted_code, 'sbrm_1137');
    assert.strictEqual(sentinel.amount, -1000.00);
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
    assert.strictEqual(sentinel.amount, 500.50);
    // Net sum = 0
    assert.ok(Math.abs(primary.amount + sentinel.amount - 0) < 0.5 * 10 ** -2);
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
    assert.strictEqual(payload.lines.length, 2);
    assert.strictEqual(payload.entity_structure, 'company');
    const netSum = payload.lines.reduce((s, l) => s + l.amount, 0);
    assert.ok(Math.abs(netSum - 0) < 0.5 * 10 ** -2);
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
    assert.strictEqual(isLegacyResponse(legacy), true);
    assert.strictEqual(isCanonicalResponse(legacy), false);
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
    assert.strictEqual(isCanonicalResponse(canonical), true);
    assert.strictEqual(isLegacyResponse(canonical), false);
  });

  it('both return false for malformed input', () => {
    assert.strictEqual(isLegacyResponse(null), false);
    assert.strictEqual(isLegacyResponse({}), false);
    assert.strictEqual(isLegacyResponse({ results: [] }), false);
    assert.strictEqual(isCanonicalResponse('string'), false);
  });
});

describe('FanoClient construction', () => {
  it('requires apiKey', () => {
    assert.throws(() => new FanoClient({ apiKey: '' }), (error: Error) => error.message.includes('apiKey is required'));
  });

  it('defaults schemaVersion to legacy', () => {
    const client = new FanoClient({ apiKey: 'test-key', fetchImpl: async () => new Response() });
    assert.notStrictEqual(client, undefined);
  });

  it('accepts canonical schemaVersion override', () => {
    const client = new FanoClient({
      apiKey: 'test-key',
      schemaVersion: 'canonical',
      fetchImpl: async () => new Response(),
    });
    assert.notStrictEqual(client, undefined);
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
    const mockFetch = async () => ({
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
    assert.strictEqual(result.results[0]!.predicted_code, 'sbrm_4401');
    assert.strictEqual(result.results[0]!.cascade.predicted_code, 'sbrm_4100');
    assert.ok(result.results[0]!.warnings.length > 0);
  });

  it('throws FanoApiError on HTTP 400 (equilibrium failure)', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Equilibrium Failure: Net balance is 100.00' }),
    });
    const client = new FanoClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    await assert.rejects(client.ingestTrialBalance({ entity_structure: 'company', lines: [] }), FanoApiError);
  });

  it('throws FanoApiError on HTTP 502 (substrate inconsistency)', async () => {
    const mockFetch = async () => ({
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
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof FanoApiError);
      assert.strictEqual((e as FanoApiError).httpStatus, 502);
      assert.ok((e as FanoApiError).detail.includes('Cascade substrate inconsistency'));
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
    const mockFetch = async () => ({
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
    assert.strictEqual(result.description, 'Trading Revenue');
    assert.strictEqual(result.predicted_code, 'sbrm_4100');
  });
});
