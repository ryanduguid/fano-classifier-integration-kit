import { describe, expect, it, vi } from 'vitest';
import { FanoApiError, FanoClient, isCanonicalResponse, isLegacyResponse } from '../src/client.js';
import type { SchemaVersion } from '../src/client.js';
import { adaptLegacyLineResponse } from '../src/adapter.js';
import type { LegacyLineResponse, LineItem, LineResponse, TrialBalancePayload } from '../src/types.js';

const wireRow: LegacyLineResponse = {
  description: 'Fabricated line', predicted_code: 'sbrm_1137', confidence: 0.8,
  cascade_topology: 'current_assets', model_architecture: 'synthetic-test-model',
  operator_hint_predicted_code: 'sbrm_1137', operator_hint_source_topology: 'current_assets',
  operator_hint_confidence: 0.7, fano_status: 'accepted_fact', quarantine_reason: null,
};
const sdkRow: LineResponse = {
  description: 'Fabricated line', predicted_code: 'sbrm_1137', confidence: 0.7,
  source_topology: 'current_assets', fano_status: 'accepted_fact', quarantine_reason: null,
  cascade: { predicted_code: 'sbrm_1137', topology: 'current_assets',
    aggregate_confidence: 0.8, l1_confidence: 0.8, l2_confidence: 0.8 }, warnings: [],
};
const line: LineItem = { description: 'Fabricated line', predicted_code: 'sbrm_1137',
  source_topology: 'current_assets', confidence: 0.7, amount: 0 };
const emptyRequest: TrialBalancePayload = { entity_structure: 'company', lines: [] };
const envelope = (results: unknown[]) => ({ status: 'success', equilibrium_valid: true, results });
const clientFor = (body: unknown, schemaVersion: SchemaVersion = 'legacy', status = 200) =>
  new FanoClient({ apiKey: 'fabricated-test-value', schemaVersion,
    fetchImpl: async () => new Response(JSON.stringify(body), { status }) });

describe('response-family discrimination', () => {
  it.each([null, undefined, 1, 'row', true, []])('rejects non-record rows: %j', row => {
    expect(isLegacyResponse(envelope([row]))).toBe(false);
    expect(isCanonicalResponse(envelope([row]))).toBe(false);
  });

  it('checks later rows, mixed families and sparse arrays', () => {
    for (const rows of [[wireRow, null], [sdkRow, 7], [wireRow, sdkRow], [sdkRow, wireRow], new Array(1)]) {
      expect(isLegacyResponse(envelope(rows))).toBe(false);
      expect(isCanonicalResponse(envelope(rows))).toBe(false);
    }
  });

  it.each([
    { cascade: null, warnings: [] }, { cascade: [], warnings: [] },
    { cascade: {}, warnings: 'invalid' },
  ])('checks SDK marker values: %j', row => {
    expect(isCanonicalResponse(envelope([row]))).toBe(false);
  });

  it('checks the envelope but preserves false equilibrium and extra fields', () => {
    for (const [row, guard] of [[wireRow, isLegacyResponse], [sdkRow, isCanonicalResponse]] as const) {
      const valid = envelope([row]);
      expect(guard({ ...valid, status: 'failure' })).toBe(false);
      expect(guard({ ...valid, equilibrium_valid: 'true' })).toBe(false);
      expect(guard({ ...valid, equilibrium_valid: false, extra: 1 })).toBe(true);
    }
  });
});

describe('response envelopes and counts', () => {
  it.each(['legacy', 'canonical'] as const)('accepts an empty success in %s mode', async schema => {
    const empty = { ...envelope([]), equilibrium_valid: false };
    expect(await clientFor(empty, schema).ingestTrialBalance(emptyRequest)).toEqual(empty);
  });

  it.each(['legacy', 'canonical'] as const)('rejects count mismatches in %s mode', async schema => {
    const row = schema === 'legacy' ? wireRow : sdkRow;
    await expect(clientFor(envelope([row]), schema).ingestTrialBalance(emptyRequest))
      .rejects.toThrow('result count mismatch; expected 0, received 1');
    await expect(clientFor(envelope([]), schema).ingestTrialBalance({ ...emptyRequest, lines: [line] }))
      .rejects.toThrow('result count mismatch; expected 1, received 0');
    for (const count of [1, 3]) {
      await expect(clientFor(envelope(Array(count).fill(row)), schema)
        .ingestTrialBalance({ ...emptyRequest, lines: [line, line] }))
        .rejects.toThrow(`result count mismatch; expected 2, received ${count}`);
    }
  });

  it.each([true, false])('uses the submitted count after caller mutation: valid=%s', async valid => {
    let release!: (response: Response) => void;
    let submitted = '';
    const client = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl: async (_input, init) => {
      submitted = String(init?.body);
      return new Promise<Response>(resolve => { release = resolve; });
    } });
    const request = { ...emptyRequest, lines: [line] };
    const pending = client.ingestTrialBalance(request);
    expect(JSON.parse(submitted).lines).toHaveLength(1);
    request.lines = [];
    release(new Response(JSON.stringify(envelope(valid ? [wireRow] : []))));
    if (valid) await expect(pending).resolves.toMatchObject({ results: [adaptLegacyLineResponse(wireRow)] });
    else await expect(pending).rejects.toThrow('result count mismatch; expected 1, received 0');
  });

  it.each([null, false, 3, [], {}, { results: [] }])('reports malformed envelopes: %j', async raw => {
    await expect(clientFor(raw).ingestTrialBalance(emptyRequest)).rejects.toThrow('FanoClient: response shape unrecognised');
  });

  it('preserves SDK-shaped pass-through in either mode', async () => {
    for (const schema of ['legacy', 'canonical'] as const) {
      const body = envelope([sdkRow]);
      expect(await clientFor(body, schema).ingestTrialBalance({ ...emptyRequest, lines: [line] })).toEqual(body);
    }
  });

  it('does not mislabel malformed SDK rows as a server migration', async () => {
    await expect(clientFor(envelope([wireRow]), 'canonical').ingestTrialBalance({ ...emptyRequest, lines: [line] }))
      .rejects.toThrow('requires SDK-shaped response rows');
  });
});

describe('HTTP error details', () => {
  it.each(['', 'Fabricated error', [{ msg: 'Fabricated validation error' }], 0, false, null])(
    'keeps detail a string for %j', async detail => {
      const expected = detail === null ? 'HTTP 422' : typeof detail === 'string' ? detail : JSON.stringify(detail);
      await expect(clientFor({ detail }, 'legacy', 422).ingestTrialBalance(emptyRequest))
        .rejects.toMatchObject({ name: 'FanoApiError', httpStatus: 422, detail: expected });
    },
  );

  it('uses the HTTP status for a non-JSON error body', async () => {
    const client = new FanoClient({ apiKey: 'fabricated-test-value',
      fetchImpl: async () => new Response('not JSON', { status: 502 }) });
    await expect(client.ingestTrialBalance(emptyRequest)).rejects.toBeInstanceOf(FanoApiError);
  });
});

describe('request deadlines', () => {
  it.each([200, 422])('keeps the original deadline through the HTTP %i body', async status => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let releaseBody: (() => void) | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (!init?.signal) throw new Error('Missing request signal');
      const requestSignal = signal = init.signal;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { ok: status === 200, status, json: () => new Promise((resolve, reject) => {
        const onAbort = () => reject(requestSignal.reason);
        releaseBody = () => {
          requestSignal.removeEventListener('abort', onAbort);
          resolve(status === 200 ? envelope([]) : { detail: 'Fabricated failure' });
        };
        if (requestSignal.aborted) onAbort();
        else requestSignal.addEventListener('abort', onAbort, { once: true });
      }) } as Response;
    };
    const client = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl, timeoutMs: 25 });
    const outcome = client.ingestTrialBalance(emptyRequest).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(releaseBody).toBeDefined();
      vi.advanceTimersByTime(14);
      expect(signal?.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(signal?.aborted).toBe(true);
      const result = await outcome;
      expect(result.kind).toBe('rejected');
      if (result.kind === 'rejected') expect(result.error).toMatchObject({ name: 'AbortError' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseBody?.();
      await outcome;
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'wire', 'sdk', 'network', 'json', 'schema', 'http'])(
    'clears the deadline after %s', async mode => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const fetchImpl: typeof fetch = async (_input, init) => {
        signal = init?.signal ?? undefined;
        if (mode === 'network') throw new Error('Fabricated network failure');
        return { ok: mode !== 'http', status: mode === 'http' ? 400 : 200,
          json: async () => {
            if (mode === 'json') throw new SyntaxError('Fabricated JSON failure');
            return mode === 'schema' ? null : mode === 'http' ? { detail: 'Fabricated error' }
              : envelope(mode === 'wire' ? [wireRow] : mode === 'sdk' ? [sdkRow] : []);
          } } as Response;
      };
      try {
        const pending = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl, timeoutMs: 25 })
          .ingestTrialBalance({ ...emptyRequest, lines: ['wire', 'sdk'].includes(mode) ? [line] : [] });
        if (['empty', 'wire', 'sdk'].includes(mode)) {
          await expect(pending).resolves.toEqual(envelope(mode === 'wire' ? [adaptLegacyLineResponse(wireRow)]
            : mode === 'sdk' ? [sdkRow] : []));
        } else {
          await expect(pending).rejects.toThrow(mode === 'network' ? 'Fabricated network failure'
            : mode === 'json' ? 'Fabricated JSON failure'
              : mode === 'schema' ? 'response shape unrecognised' : 'Fabricated error');
        }
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(100);
        expect(signal?.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('adapter provenance and advice', () => {
  it('preserves model, verdict and reason when warning predicates do not match', () => {
    const result = adaptLegacyLineResponse({ ...wireRow,
      fano_status: 'quarantine', quarantine_reason: 'Firewall Timeout Execution Lock' });
    expect(result.cascade.model_architecture).toBe(wireRow.model_architecture);
    expect(result.fano_status).toBe('quarantine');
    expect(result.quarantine_reason).toBe('Firewall Timeout Execution Lock');
    expect(result.warnings).toEqual([]);
  });

  it('retains the SDK threshold without claiming a server rule identifier', () => {
    const lower = adaptLegacyLineResponse({ ...wireRow, confidence: 0.49 });
    expect(lower.warnings.map(warning => warning.kind)).toEqual(['subfloor_abstention']);
    expect(lower.warnings[0]!.disagreement_reason.sbrm_rule_id).toBe('');
    expect(adaptLegacyLineResponse({ ...wireRow, confidence: 0.5 }).warnings).toEqual([]);
  });

  it('does not invent separate signals, operator legality or entity-change advice', () => {
    for (const changes of [
      { operator_hint_predicted_code: 'sbrm_1122' as const },
      { operator_hint_source_topology: 'equity' as const },
      { fano_status: 'draft_fact' as const, quarantine_reason: 'Entity/Topological Drift: fabricated case' },
    ]) {
      const result = adaptLegacyLineResponse({ ...wireRow, ...changes });
      expect(result.predicted_code).toBe(changes.operator_hint_predicted_code ?? wireRow.operator_hint_predicted_code);
      expect(result.source_topology).toBe(changes.operator_hint_source_topology ?? wireRow.operator_hint_source_topology);
      expect(result.confidence).toBe(wireRow.operator_hint_confidence);
      expect(result.cascade).toEqual({ predicted_code: wireRow.predicted_code, topology: wireRow.cascade_topology,
        model_architecture: wireRow.model_architecture, l1_confidence: wireRow.confidence,
        l2_confidence: wireRow.confidence, aggregate_confidence: wireRow.confidence });
      expect(result.warnings.length).toBeGreaterThan(0);
      for (const warning of result.warnings) {
        expect(warning.disagreement_reason.sbrm_rule_id).toBe('');
        expect(JSON.stringify(warning)).not.toMatch(/L2 specialist|contradicts L1 routing|Both codes are structurally legal|Either reassign the entity_structure/);
        expect(warning.suggested_repair_journal.proposed_entry.debit.amount).toBe(0);
        expect(warning.suggested_repair_journal.proposed_entry.credit.amount).toBe(0);
      }
    }
  });
});
