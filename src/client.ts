/**
 * Fano Classifier HTTP client.
 *
 * Thin wrapper over POST /ingest/trial_balance with:
 * - X-API-Key authentication
 * - Equilibrium-sentinel pattern for single-line probes
 * - Structured error handling (HTTP 400 equilibrium / 502 substrate / 5xx)
 * - Response selection (SDK-shaped or ratified wire response)
 *
 * The default 'legacy' mode adapts the ratified wire response into the SDK's
 * `TrialBalanceResponse`. 'canonical' accepts the SDK shape directly. These
 * retained option names do not imply a planned server migration.
 */

import type {
  LineItem,
  LegacyTrialBalanceResponse,
  TrialBalancePayload,
  TrialBalanceResponse,
  SbrmCode,
  Topology,
} from './types.js';
import { adaptLegacyResponse } from './adapter.js';

/** Default Fano production base URL. */
export const DEFAULT_BASE_URL = 'https://fano-engine-afmurhqkaq-ts.a.run.app';

/** Schema version targeted by the client. */
export type SchemaVersion = 'legacy' | 'canonical';

export interface FanoClientConfig {
  /** Production endpoint base URL (without trailing slash). */
  baseUrl?: string;
  /** X-API-Key header value (obtain from LodgeiT Labs onboarding). */
  apiKey: string;
  /**
   * Response shape. Defaults to 'legacy', which adapts wire responses and
   * also accepts the SDK shape. 'canonical' requires the SDK shape directly.
   */
  schemaVersion?: SchemaVersion;
  /** Optional fetch implementation override (for testing / Node 18+). */
  fetchImpl?: typeof fetch;
  /** Fetch cancellation deadline, including body reads (default 30000 ms). */
  timeoutMs?: number;
}

/**
 * Structured error from the Fano API.
 *
 * Surfaces equilibrium violations (HTTP 400), substrate inconsistencies
 * (HTTP 502 with `detail: 'Cascade substrate inconsistency'`), and
 * generic 4xx/5xx failures.
 */
export class FanoApiError extends Error {
  public readonly httpStatus: number;
  public readonly detail: string;

  constructor(httpStatus: number, detail: string, message?: string) {
    super(message ?? `Fano API ${httpStatus}: ${detail}`);
    this.name = 'FanoApiError';
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

/**
 * Equilibrium-balancing sentinel line.
 *
 * Production /ingest/trial_balance enforces `abs(sum(lines.amount)) <= 0.01`.
 * For single-line probes, generate a sentinel using the row's primary
 * topology to produce a structurally-legal contra entry. The sentinel is
 * never scored at the consumer level; consumers inspect `results[0]` only.
 */
export function buildEquilibriumSentinel(
  primary: LineItem,
): LineItem {
  const isAssetSide = ['current_assets', 'non_current_assets', 'expenses'].includes(
    primary.source_topology,
  );
  const contraTopology: Topology = isAssetSide
    ? 'current_liabilities'
    : 'current_assets';
  const contraCode: SbrmCode = isAssetSide ? 'sbrm_2266' : 'sbrm_1137';

  return {
    description: 'Probe Sentinel Balancing Line (NOT SCORED)',
    predicted_code: contraCode,
    source_topology: contraTopology,
    confidence: 0.99,
    amount: Math.round(-primary.amount * 100) / 100,
  };
}

/**
 * Wrap a single line item in a balanced trial-balance payload using the
 * equilibrium-sentinel pattern. Use for single-line probes.
 *
 * @example
 * const payload = wrapSingleLineProbe({
 *   description: 'Trading Revenue',
 *   predicted_code: 'sbrm_4100',
 *   source_topology: 'revenue',
 *   confidence: 0.95,
 *   amount: 1000.00,
 * }, 'company');
 */
export function wrapSingleLineProbe(
  primary: LineItem,
  entityStructure: TrialBalancePayload['entity_structure'],
): TrialBalancePayload {
  return {
    entity_structure: entityStructure,
    lines: [primary, buildEquilibriumSentinel(primary)],
  };
}

/**
 * Discriminate a nonempty wire response by its structural markers.
 *
 * This checks every row's schema family, not every field's type or value.
 * Empty results have no family marker; the client handles them separately.
 */
export function isLegacyResponse(
  raw: unknown,
): raw is LegacyTrialBalanceResponse {
  if (!isSuccessEnvelope(raw) || raw.results.length === 0) return false;
  for (const row of raw.results) {
    if (!isRecord(row) || typeof row.operator_hint_predicted_code !== 'string'
        || typeof row.cascade_topology !== 'string' || 'cascade' in row) return false;
  }
  return true;
}

/** Discriminate nonempty SDK-shaped rows without validating all nested fields. */
export function isCanonicalResponse(
  raw: unknown,
): raw is TrialBalanceResponse {
  if (!isSuccessEnvelope(raw) || raw.results.length === 0) return false;
  for (const row of raw.results) {
    if (!isRecord(row) || !isRecord(row.cascade) || !Array.isArray(row.warnings)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuccessEnvelope(value: unknown): value is {
  status: 'success'; equilibrium_valid: boolean; results: unknown[];
} {
  return isRecord(value) && value.status === 'success'
    && typeof value.equilibrium_valid === 'boolean' && Array.isArray(value.results);
}

// ============================================================================
// Client class
// ============================================================================

export class FanoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly schemaVersion: SchemaVersion;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: FanoClientConfig) {
    if (!config.apiKey) {
      throw new Error('FanoClient: apiKey is required');
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.schemaVersion = config.schemaVersion ?? 'legacy';
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? 30000;
    if (!this.fetchImpl) {
      throw new Error(
        'FanoClient: fetch is not available; provide fetchImpl in config (Node < 18)',
      );
    }
  }

  /**
   * POST /ingest/trial_balance with the supplied payload.
   *
   * Returns the canonical response shape regardless of `schemaVersion`
   * (legacy responses are transformed via `adaptLegacyResponse`).
   *
   * @throws {FanoApiError} on HTTP non-200
   */
  async ingestTrialBalance(
    payload: TrialBalancePayload,
  ): Promise<TrialBalanceResponse> {
    const url = `${this.baseUrl}/ingest/trial_balance`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const requestBody = JSON.stringify(payload);
      // Serialisation hooks can change the lines actually submitted.
      const submitted: unknown = JSON.parse(requestBody);
      if (!isRecord(submitted) || !Array.isArray(submitted.lines)) {
        throw new Error('FanoClient: request body must contain a lines array.');
      }
      const expectedResultCount = submitted.lines.length;
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: requestBody,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const errorBody: unknown = await response.json();
          if (isRecord(errorBody) && errorBody.detail != null) {
            detail = typeof errorBody.detail === 'string'
              ? errorBody.detail : JSON.stringify(errorBody.detail) ?? detail;
          }
        } catch {
          // A non-JSON error body falls back to the HTTP status.
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new FanoApiError(response.status, detail);
      }

      const raw: unknown = await response.json();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!isSuccessEnvelope(raw)) {
        throw new Error('FanoClient: response shape unrecognised; expected a success envelope.');
      }
      if (raw.results.length !== expectedResultCount) {
        throw new Error(`FanoClient: result count mismatch; expected ${expectedResultCount}, received ${raw.results.length}.`);
      }
      if (raw.results.length === 0) {
        return { status: raw.status, equilibrium_valid: raw.equilibrium_valid, results: [] };
      }

      if (this.schemaVersion === 'canonical') {
        if (!isCanonicalResponse(raw)) {
          throw new Error('FanoClient: schemaVersion="canonical" requires SDK-shaped response rows.');
        }
        return raw;
      }

      if (isLegacyResponse(raw)) return adaptLegacyResponse(raw);
      if (isCanonicalResponse(raw)) return raw;
      throw new Error('FanoClient: response shape unrecognised; neither wire nor SDK-shaped rows.');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Convenience: probe a single line item using the equilibrium-sentinel
   * pattern. Returns only the primary line's response (sentinel is dropped).
   */
  async probeSingleLine(
    line: LineItem,
    entityStructure: TrialBalancePayload['entity_structure'],
  ): Promise<TrialBalanceResponse['results'][number]> {
    const payload = wrapSingleLineProbe(line, entityStructure);
    const response = await this.ingestTrialBalance(payload);
    if (response.results.length === 0) {
      throw new Error('FanoClient.probeSingleLine: response.results is empty');
    }
    return response.results[0]!;
  }
}
