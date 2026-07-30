import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { providerFor, PROVIDER_IDS } from '../src/provider/index.js';
import { CANDIDATE_MODELS } from '../src/provider/openai.js';

/**
 * Which provider serves a model id.
 *
 * Offline: constructing a provider reads no credential and makes no call, which
 * is why this can assert the whole detection matrix with no key. Every case that
 * *errors* matters more than the ones that resolve — the failure this guards
 * against is silently measuring a different model than the one someone typed and
 * then reporting it as the one they asked for.
 */

describe('provider detection', () => {
  it('routes by model id in both directions', () => {
    assert.equal(providerFor({ model: 'claude-haiku-4-5' }).id, 'anthropic');
    assert.equal(providerFor({ model: 'gpt-5.6-luna' }).id, 'openai');
  });

  it('defaults to anthropic with no model, and keeps its default model', () => {
    const provider = providerFor();
    assert.equal(provider.id, 'anthropic');
    assert.equal(provider.model, 'claude-haiku-4-5');
  });

  it('consults the model table ahead of the naming convention', () => {
    // The table is authoritative, so a model that fits neither prefix rule is a
    // data edit rather than a new branch in the registry.
    assert.equal(providerFor({ model: 'gpt-5.6-terra' }).id, 'openai');
  });

  it('lets --provider override what the model id implies', () => {
    // The escape hatch for a model too new to be in the table. It must win, or a
    // new release is unusable until someone ships a data edit.
    assert.equal(providerFor({ model: 'gpt-6-unreleased', provider: 'anthropic' }).id, 'anthropic');
  });

  it('errors on an unknown model, naming both providers', () => {
    assert.throws(
      () => providerFor({ model: 'mistral-large' }),
      (error: Error) => {
        for (const id of PROVIDER_IDS) assert.match(error.message, new RegExp(id));
        return true;
      },
    );
  });

  it('errors on an unknown provider rather than falling back to one', () => {
    assert.throws(() => providerFor({ model: 'gpt-5.6-luna', provider: 'gemini' }), /Unknown provider/);
  });

  it('does not let the legacy o* family anchor detection', () => {
    // o1/o3/o4-mini are delisted. Anchoring on `o` would also swallow every
    // future `opus-*` alias someone reasonably tries, and route it to OpenAI.
    assert.throws(() => providerFor({ model: 'o3' }), /Cannot tell which provider/);
    assert.throws(() => providerFor({ model: 'opus-5' }), /Cannot tell which provider/);
  });

  it('refuses to invent an OpenAI default model', () => {
    // Decision A is unsettled: every current tier reasons by default and
    // reasoning bills as output, so the nominally cheap tier is not necessarily
    // the cheap one. A default picked to fill this gap would become the model
    // every published comparison quietly ran on.
    assert.throws(
      () => providerFor({ provider: 'openai' }),
      (error: Error) => {
        assert.match(error.message, /--model/);
        for (const model of CANDIDATE_MODELS) assert.match(error.message, new RegExp(model));
        return true;
      },
    );
  });
});
