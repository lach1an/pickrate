import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';
import { trialFrom } from '../src/provider/openai.js';
import { specFor } from '../src/provider/models.js';
import { priceUsage } from '../src/provider/pricing.js';
import { scoreScenario } from '../src/scorer/index.js';
import type { CacheBehaviour } from '../src/provider/contract.js';
import type { Scenario } from '../src/types.js';

/**
 * Reading a Responses payload back as a neutral `TrialResult`.
 *
 * Two things here are not mechanical translation, and both are silent when wrong:
 * the token buckets overlap on this provider and are disjoint in `TrialUsage`,
 * and an incomplete response has no call list but reads as restraint if it is
 * not caught before the output is.
 */

const restraint: Scenario = {
  id: 'no-tool-needed',
  prompt: 'what is the capital of France?',
  expect: { tool: null },
};

const cache = specFor('gpt-5.6-luna')!.cache;

interface Parts {
  status?: OpenAI.Responses.ResponseStatus;
  reason?: 'max_output_tokens' | 'content_filter';
  output?: unknown[];
  input?: number;
  cached?: number;
  written?: number;
}

function response(parts: Parts = {}): OpenAI.Responses.Response {
  return {
    id: 'resp_test',
    object: 'response',
    model: 'gpt-5.6-luna',
    status: parts.status ?? 'completed',
    error: null,
    incomplete_details: parts.reason !== undefined ? { reason: parts.reason } : null,
    output: parts.output ?? [],
    usage: {
      input_tokens: parts.input ?? 1000,
      output_tokens: 40,
      total_tokens: (parts.input ?? 1000) + 40,
      input_tokens_details: {
        cached_tokens: parts.cached ?? 0,
        cache_write_tokens: parts.written ?? 0,
      },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as OpenAI.Responses.Response;
}

function call(name: string, args: string): unknown {
  return { type: 'function_call', call_id: 'call_1', name, arguments: args };
}

describe('the token buckets a Responses payload reports', () => {
  it('subtracts cached and written tokens out of the input total', () => {
    // `input_tokens` here is the *total*, with the other two as subsets of it.
    // `TrialUsage` is disjoint because `priceUsage` applies a different
    // multiplier to each bucket.
    const trial = trialFrom(response({ input: 1000, cached: 700, written: 200 }), 'x', cache);

    assert.equal(trial.usage.inputTokens, 100);
    assert.equal(trial.usage.cacheReadInputTokens, 700);
    assert.equal(trial.usage.cacheCreationInputTokens, 200);
  });

  it('prices the cached prefix once, not twice', () => {
    // The regression this exists for: passing the raw numbers through bills the
    // cached tokens at the full input rate *and* again at 0.1×, which on a large
    // manifest is most of the reported cost of a run.
    const spec = specFor('gpt-5.6-luna')!;
    const trial = trialFrom(response({ input: 1000, cached: 900, written: 0 }), 'x', cache);

    const priced = priceUsage(spec, trial.usage);
    const naive = priceUsage(spec, {
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });

    assert.ok(priced < naive, 'the corrected mapping must cost less than the double-counted one');
    // 100 uncached at $1/M, 900 cached at $0.10/M, 40 output at $6/M.
    assert.equal(priced.toFixed(9), (100e-6 + 900e-7 + 40 * 6e-6).toFixed(9));
  });

  it('omits the write bucket for a model with no billed write concept', () => {
    // Zero would say the write was free. Absent says there is no such thing
    // here, which is the true statement — the same distinction `deferred` keeps.
    const unbilled: CacheBehaviour = { ...cache, writesBilled: false };
    const trial = trialFrom(response({ written: 500 }), 'x', unbilled);

    assert.equal(trial.usage.cacheCreationInputTokens, undefined);
    assert.equal(trial.usage.cacheReadInputTokens, 0);
  });
});

describe('an incomplete Responses payload', () => {
  /**
   * Every case is asserted against a **restraint** scenario on purpose. On any
   * other scenario a truncated trial fails whether or not the guard exists, so
   * the test would pass with the bug present and prove nothing.
   */
  it('reads a max_output_tokens cut-off as errored, not as restraint', () => {
    const trial = trialFrom(response({ status: 'incomplete', reason: 'max_output_tokens' }), restraint.id, cache);

    assert.match(trial.error ?? '', /output budget/);

    const score = scoreScenario(restraint, [trial]);
    assert.equal(score.errors, 1);
    assert.equal(score.selection.passed, 0);
  });

  it('says content filtering happened rather than calling it truncation', () => {
    const trial = trialFrom(response({ status: 'incomplete', reason: 'content_filter' }), restraint.id, cache);

    assert.match(trial.error ?? '', /content filter/);
    assert.doesNotMatch(trial.error ?? '', /output budget/);
  });

  it('still scores a genuinely empty completed response as restraint', () => {
    const score = scoreScenario(restraint, [trialFrom(response(), restraint.id, cache)]);

    assert.equal(score.errors, 0);
    assert.equal(score.selection.passed, 1);
  });

  it('reads a refusal as its own fact', () => {
    const output = [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }];
    const trial = trialFrom(response({ output }), restraint.id, cache);

    assert.match(trial.error ?? '', /refused/);
  });
});

describe('the calls a Responses payload reports', () => {
  it('parses arguments out of the JSON string they arrive as', () => {
    const output = [call('create_branch', '{"name":"release"}')];
    const trial = trialFrom(response({ output }), 'x', cache);

    assert.deepEqual(trial.calls, [{ name: 'create_branch', args: { name: 'release' } }]);
  });

  it('keeps a call whose arguments do not parse', () => {
    // The model did select this tool. Dropping the call would turn an argument
    // bug into a selection bug — and on a restraint scenario, into a false pass.
    const trial = trialFrom(response({ output: [call('create_branch', '{"name":')] }), 'x', cache);

    assert.deepEqual(trial.calls, [{ name: 'create_branch', args: {} }]);
  });

  it('reports every call, so over-calling stays visible', () => {
    const output = [call('a', '{}'), call('b', '{}')];
    assert.equal(trialFrom(response({ output }), 'x', cache).calls.length, 2);
  });
});
