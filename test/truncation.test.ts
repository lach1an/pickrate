import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { trialFrom } from '../src/provider/anthropic.js';
import { scoreScenario } from '../src/scorer/index.js';
import type { Scenario } from '../src/types.js';

/**
 * A truncated response is an error, never restraint.
 *
 * Empty calls mean *the model chose to call nothing*; truncation means *we
 * never found out what it chose*. Conflating them is a false pass in the metric
 * that is already the most neglected.
 *
 * Every case here is asserted against a **restraint** scenario on purpose. On
 * an ordinary scenario a truncated trial scores as a failure whether or not the
 * guard exists, so the test would pass with the bug present and prove nothing.
 * Restraint is the one place where "called nothing" is the *right* answer, and
 * therefore the one place the bug is invisible.
 */

const restraint: Scenario = {
  id: 'no-tool-needed',
  prompt: 'what is the capital of France?',
  expect: { tool: null },
};

function response(stopReason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 1024,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

describe('truncated responses', () => {
  it('marks a max_tokens response as errored, not as restraint', () => {
    const trial = trialFrom(response('max_tokens'), restraint.id);

    assert.ok(trial.error !== undefined, 'a truncated trial must carry an error');
    assert.deepEqual(trial.calls, []);

    const score = scoreScenario(restraint, [trial], 0.95);
    assert.equal(score.errors, 1, 'the trial must be counted as errored');
    assert.equal(score.selection.total, 0, 'and must leave the denominator entirely');
    assert.equal(score.selection.passed, 0, 'it must never be read as correct restraint');
  });

  it('marks an exhausted context window the same way', () => {
    const trial = trialFrom(response('model_context_window_exceeded'), restraint.id);

    assert.ok(trial.error !== undefined);
    assert.equal(scoreScenario(restraint, [trial], 0.95).errors, 1);
  });

  it('says which of truncation and refusal happened', () => {
    // Same shape, different facts. A run whose trials died on output budget is
    // fixed by a bigger budget; one whose trials were refused is not, and a
    // message that does not distinguish them sends the reader to the wrong fix.
    const truncated = trialFrom(response('max_tokens'), restraint.id).error ?? '';
    const refused = trialFrom(response('refusal'), restraint.id).error ?? '';

    assert.match(truncated, /output budget/i);
    assert.match(refused, /refused/i);
    assert.notEqual(truncated, refused);
  });

  it('still scores an ordinary empty response as restraint', () => {
    // The guard must not swallow the real thing: `end_turn` with no calls is
    // the model correctly declining, and it is a pass.
    const trial = trialFrom(response('end_turn'), restraint.id);

    assert.equal(trial.error, undefined);
    const score = scoreScenario(restraint, [trial], 0.95);
    assert.equal(score.errors, 0);
    assert.equal(score.selection.passed, 1);
  });
});
