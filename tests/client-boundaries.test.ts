import { format } from 'node:util';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import assert from 'node:assert/strict';
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

// These partial fixtures contain plain objects, arrays and primitive values.
function assertPartial(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.strictEqual(actual.length, expected.length);
    expected.forEach((value, index) => assertPartial(actual[index], value));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object');
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in actual);
      assertPartial((actual as Record<string, unknown>)[key], value);
    }
  } else assert.strictEqual(actual, expected);
}

describe('response-family discrimination', () => {
  for (const row of [null, undefined, 1, 'row', true, []]) {
    it(format('rejects non-record rows: %j', row), () => {
      assert.strictEqual(isLegacyResponse(envelope([row])), false);
      assert.strictEqual(isCanonicalResponse(envelope([row])), false);
    });
  }

  it('checks later rows, mixed families and sparse arrays', () => {
    for (const rows of [[wireRow, null], [sdkRow, 7], [wireRow, sdkRow], [sdkRow, wireRow], new Array(1)]) {
      assert.strictEqual(isLegacyResponse(envelope(rows)), false);
      assert.strictEqual(isCanonicalResponse(envelope(rows)), false);
    }
  });

  for (const row of [
    { cascade: null, warnings: [] }, { cascade: [], warnings: [] },
    { cascade: {}, warnings: 'invalid' },
  ]) {
    it(format('checks SDK marker values: %j', row), () => {
      assert.strictEqual(isCanonicalResponse(envelope([row])), false);
    });
  }

  it('checks the envelope but preserves false equilibrium and extra fields', () => {
    for (const [row, guard] of [[wireRow, isLegacyResponse], [sdkRow, isCanonicalResponse]] as const) {
      const valid = envelope([row]);
      assert.strictEqual(guard({ ...valid, status: 'failure' }), false);
      assert.strictEqual(guard({ ...valid, equilibrium_valid: 'true' }), false);
      assert.strictEqual(guard({ ...valid, equilibrium_valid: false, extra: 1 }), true);
    }
  });
});

describe('response envelopes and counts', () => {
  for (const schema of ['legacy', 'canonical'] as const) {
    it(format('accepts an empty success in %s mode', schema), async () => {
      const empty = { ...envelope([]), equilibrium_valid: false };
      assert.deepStrictEqual(await clientFor(empty, schema).ingestTrialBalance(emptyRequest), empty);
    });
  }

  for (const schema of ['legacy', 'canonical'] as const) {
    it(format('rejects count mismatches in %s mode', schema), async () => {
      const row = schema === 'legacy' ? wireRow : sdkRow;
      await assert.rejects(clientFor(envelope([row]), schema).ingestTrialBalance(emptyRequest), (error: Error) => error.message.includes('result count mismatch; expected 0, received 1'));
      await assert.rejects(clientFor(envelope([]), schema).ingestTrialBalance({ ...emptyRequest, lines: [line] }), (error: Error) => error.message.includes('result count mismatch; expected 1, received 0'));
      for (const count of [1, 3]) {
        await assert.rejects(clientFor(envelope(Array(count).fill(row)), schema)
          .ingestTrialBalance({ ...emptyRequest, lines: [line, line] }), (error: Error) => error.message.includes(`result count mismatch; expected 2, received ${count}`));
      }
    });
  }

  for (const valid of [true, false]) {
    it(format('uses the submitted count after caller mutation: valid=%s', valid), async () => {
      let release!: (response: Response) => void;
      let submitted = '';
      const client = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl: async (_input, init) => {
        submitted = String(init?.body);
        return new Promise<Response>(resolve => { release = resolve; });
      } });
      const request = { ...emptyRequest, lines: [line] };
      const pending = client.ingestTrialBalance(request);
      assert.strictEqual(JSON.parse(submitted).lines.length, 1);
      request.lines = [];
      release(new Response(JSON.stringify(envelope(valid ? [wireRow] : []))));
      if (valid) assertPartial(await pending, { results: [adaptLegacyLineResponse(wireRow)] });
      else await assert.rejects(pending, (error: Error) => error.message.includes('result count mismatch; expected 1, received 0'));
    });
  }

  for (const location of ['payload', 'lines'] as const) {
    it(format('counts the JSON sent after %s serialisation', location), async () => {
      let calls = 0;
      const toJSON = () => {
        calls += 1;
        return location === 'payload' ? { ...emptyRequest, lines: [line, line] } : [line, line];
      };
      const request = location === 'payload'
        ? { ...emptyRequest, lines: [line], toJSON }
        : { ...emptyRequest, lines: Object.assign([line], { toJSON }) };
      const client = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl: async (_input, init) => {
        assert.strictEqual(JSON.parse(String(init?.body)).lines.length, 2);
        return new Response(JSON.stringify(envelope([wireRow, wireRow])));
      } });
      assertPartial(await client.ingestTrialBalance(request), { results: [
        adaptLegacyLineResponse(wireRow), adaptLegacyLineResponse(wireRow),
      ] });
      assert.strictEqual(calls, 1);
      await assert.rejects(clientFor(envelope([wireRow])).ingestTrialBalance(request), (error: Error) => error.message.includes('result count mismatch; expected 2, received 1'));
    });
  }

  for (const body of [null, {}, { lines: 'invalid' }]) {
    it(format('rejects an invalid serialised request: %j', body), async () => {
      let calls = 0;
      const fetchImpl = async () => { calls += 1; return new Response(); };
      const client = new FanoClient({ apiKey: 'fabricated-test-value', fetchImpl });
      await assert.rejects(client.ingestTrialBalance({ ...emptyRequest, toJSON: () => body } as TrialBalancePayload), (error: Error) => error.message.includes('request body must contain a lines array'));
      assert.strictEqual(calls, 0);
    });
  }

  for (const raw of [null, false, 3, [], {}, { results: [] }]) {
    it(format('reports malformed envelopes: %j', raw), async () => {
      await assert.rejects(clientFor(raw).ingestTrialBalance(emptyRequest), (error: Error) => error.message.includes('FanoClient: response shape unrecognised'));
    });
  }

  it('preserves SDK-shaped pass-through in either mode', async () => {
    for (const schema of ['legacy', 'canonical'] as const) {
      const body = envelope([sdkRow]);
      assert.deepStrictEqual(await clientFor(body, schema).ingestTrialBalance({ ...emptyRequest, lines: [line] }), body);
    }
  });

  it('does not mislabel malformed SDK rows as a server migration', async () => {
    await assert.rejects(clientFor(envelope([wireRow]), 'canonical').ingestTrialBalance({ ...emptyRequest, lines: [line] }), (error: Error) => error.message.includes('requires SDK-shaped response rows'));
  });
});

describe('HTTP error details', () => {
  for (const detail of ['', 'Fabricated error', [{ msg: 'Fabricated validation error' }], 0, false, null]) {
    it(format('keeps detail a string for %j', detail), async () => {
      const expected = detail === null ? 'HTTP 422' : typeof detail === 'string' ? detail : JSON.stringify(detail);
      await assert.rejects(clientFor({ detail }, 'legacy', 422).ingestTrialBalance(emptyRequest), { name: 'FanoApiError', httpStatus: 422, detail: expected });
    });
  }

  it('uses the HTTP status for a non-JSON error body', async () => {
    const client = new FanoClient({ apiKey: 'fabricated-test-value',
      fetchImpl: async () => new Response('not JSON', { status: 502 }) });
    await assert.rejects(client.ingestTrialBalance(emptyRequest), FanoApiError);
  });
});

function enableTimers(context: TestContext) {
  const clock = context.mock.timers;
  if (process.versions.node.startsWith('18.')) Reflect.apply(clock.enable, clock, [['setTimeout']]);
  else clock.enable({ apis: ['setTimeout'] });
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    const handle = schedule(function (this: unknown) {
      pendingTimers.delete(handle);
      Reflect.apply(callback, this, args);
    }, milliseconds);
    pendingTimers.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = handle => {
    pendingTimers.delete(handle as ReturnType<typeof setTimeout>);
    cancel(handle);
  };
  return { clock, pendingTimers, reset: () => {
    globalThis.setTimeout = schedule;
    globalThis.clearTimeout = cancel;
    clock.reset();
  } };
}

describe('request deadlines', () => {
  for (const status of [200, 422]) {
    it(format('keeps the original deadline through the HTTP %i body', status), async (context) => {
      const { clock, pendingTimers, reset } = enableTimers(context);
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
        clock.tick(10);
        await setImmediate();
        assert.notStrictEqual(releaseBody, undefined);
        clock.tick(14);
        assert.strictEqual(signal?.aborted, false);
        clock.tick(1);
        assert.strictEqual(signal?.aborted, true);
        const result = await outcome;
        assert.strictEqual(result.kind, 'rejected');
        if (result.kind === 'rejected') assert.strictEqual((result.error as Error).name, 'AbortError');
        assert.strictEqual(pendingTimers.size, 0);
      } finally {
        releaseBody?.();
        await outcome;
        reset();
      }
    });
  }

  for (const mode of ['empty', 'wire', 'sdk', 'network', 'json', 'schema', 'http']) {
    it(format('clears the deadline after %s', mode), async (context) => {
      const { clock, pendingTimers, reset } = enableTimers(context);
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
          assert.deepStrictEqual((await pending), envelope(mode === 'wire' ? [adaptLegacyLineResponse(wireRow)]
            : mode === 'sdk' ? [sdkRow] : []));
        } else {
          await assert.rejects(pending, (error: Error) => error.message.includes(mode === 'network' ? 'Fabricated network failure'
            : mode === 'json' ? 'Fabricated JSON failure'
              : mode === 'schema' ? 'response shape unrecognised' : 'Fabricated error'));
        }
        assert.strictEqual(pendingTimers.size, 0);
        clock.tick(100);
        assert.strictEqual(signal?.aborted, false);
      } finally {
        reset();
      }
    });
  }
});

describe('adapter provenance and advice', () => {
  it('preserves model, verdict and reason when warning predicates do not match', () => {
    const result = adaptLegacyLineResponse({ ...wireRow,
      fano_status: 'quarantine', quarantine_reason: 'Firewall Timeout Execution Lock' });
    assert.strictEqual(result.cascade.model_architecture, wireRow.model_architecture);
    assert.strictEqual(result.fano_status, 'quarantine');
    assert.strictEqual(result.quarantine_reason, 'Firewall Timeout Execution Lock');
    assert.deepStrictEqual(result.warnings, []);
  });

  it('retains the SDK threshold without claiming a server rule identifier', () => {
    const lower = adaptLegacyLineResponse({ ...wireRow, confidence: 0.49 });
    assert.deepStrictEqual(lower.warnings.map(warning => warning.kind), ['subfloor_abstention']);
    assert.strictEqual(lower.warnings[0]!.disagreement_reason.sbrm_rule_id, '');
    assert.deepStrictEqual(adaptLegacyLineResponse({ ...wireRow, confidence: 0.5 }).warnings, []);
  });

  it('does not invent separate signals, operator legality or entity-change advice', () => {
    for (const changes of [
      { operator_hint_predicted_code: 'sbrm_1122' as const },
      { operator_hint_source_topology: 'equity' as const },
      { fano_status: 'draft_fact' as const, quarantine_reason: 'Entity/Topological Drift: fabricated case' },
    ]) {
      const result = adaptLegacyLineResponse({ ...wireRow, ...changes });
      assert.strictEqual(result.predicted_code, changes.operator_hint_predicted_code ?? wireRow.operator_hint_predicted_code);
      assert.strictEqual(result.source_topology, changes.operator_hint_source_topology ?? wireRow.operator_hint_source_topology);
      assert.strictEqual(result.confidence, wireRow.operator_hint_confidence);
      assert.deepStrictEqual(result.cascade, { predicted_code: wireRow.predicted_code, topology: wireRow.cascade_topology,
        model_architecture: wireRow.model_architecture, l1_confidence: wireRow.confidence,
        l2_confidence: wireRow.confidence, aggregate_confidence: wireRow.confidence });
      assert.ok(result.warnings.length > 0);
      for (const warning of result.warnings) {
        assert.strictEqual(warning.disagreement_reason.sbrm_rule_id, '');
        assert.doesNotMatch(JSON.stringify(warning), /L2 specialist|contradicts L1 routing|Both codes are structurally legal|Either reassign the entity_structure/);
        assert.strictEqual(warning.suggested_repair_journal.proposed_entry.debit.amount, 0);
        assert.strictEqual(warning.suggested_repair_journal.proposed_entry.credit.amount, 0);
      }
    }
  });
});
