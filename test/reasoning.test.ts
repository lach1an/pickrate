import assert from 'node:assert/strict';
import test from 'node:test';
import type { Presentation } from '../src/adapters/contract.js';
import { AnthropicProvider, requestFor as anthropicRequest } from '../src/provider/anthropic.js';
import { OpenAIProvider, requestFor as openaiRequest } from '../src/provider/openai.js';

/**
 * The reasoning control is per model, and sending it to a model without one is
 * a 400 on every trial of the run — which is how the harness's own default
 * model came to fail 100% of live trials while 333 offline tests passed.
 */

const presentation: Presentation = {
  tools: [{ name: 'a', inputSchema: { type: 'object', properties: {} } }],
  project: (calls) => calls,
};

test('the reasoning parameter follows the model, not the provider', async (t) => {
  await t.test('is omitted for a model with no reasoning control', () => {
    // The harness default. Sending output_config here is a 400 on every trial.
    const request = anthropicRequest('claude-haiku-4-5', presentation, 'hi');
    assert.equal(request.output_config, undefined);
  });

  await t.test('is sent for a model that has one', () => {
    const request = anthropicRequest('claude-sonnet-5', presentation, 'hi');
    assert.equal(request.output_config?.effort, 'low');
  });

  await t.test('is sent on the OpenAI side, where every current tier has one', () => {
    const request = openaiRequest('gpt-5.6-luna', presentation, 'hi');
    assert.equal(request.reasoning?.effort, 'low');
  });

  await t.test('is sent for an unknown model, matching the capabilities fallback', () => {
    const request = anthropicRequest('claude-something-new', presentation, 'hi');
    assert.equal(request.output_config?.effort, 'low');
  });
});

test('the reported regime is what the request actually carried', async (t) => {
  await t.test('reports none for a model with no reasoning control', () => {
    const regime = new AnthropicProvider({ model: 'claude-haiku-4-5' }).regime(presentation);
    assert.deepEqual(regime.reasoning, { mode: 'none' });
  });

  await t.test('reports the effort for a model that has one', () => {
    const regime = new AnthropicProvider({ model: 'claude-sonnet-5' }).regime(presentation);
    assert.deepEqual(regime.reasoning, { mode: 'effort', effort: 'low' });
  });

  await t.test('hashes the two apart, so a baseline cannot cross them', () => {
    const withEffort = new AnthropicProvider({ model: 'claude-sonnet-5' }).regime(presentation);
    const without = new AnthropicProvider({ model: 'claude-haiku-4-5' }).regime(presentation);
    assert.notEqual(withEffort.hash, without.hash);
  });

  // Constructing this must not need a key — the OpenAI client is built lazily.
  await t.test('resolves on the OpenAI side too', () => {
    const regime = new OpenAIProvider({ model: 'gpt-5.6-luna' }).regime(presentation);
    assert.deepEqual(regime.reasoning, { mode: 'effort', effort: 'low' });
  });
});
