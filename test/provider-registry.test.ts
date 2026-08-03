import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { providerFor, PROVIDER_IDS } from '../src/provider/index.js';
import { DEFAULT_MODEL } from '../src/provider/openai.js';

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

  it('defaults to the tier decision A measured, not to a tier name', () => {
    // Settled by one run rather than by picking the cheapest-sounding id, and
    // priced: luna spent less per trial than the Anthropic default while terra
    // cost 2.45× luna and scored worse. Changing this changes what every
    // published comparison ran on, so it is asserted rather than left implicit.
    assert.equal(providerFor({ provider: 'openai' }).model, DEFAULT_MODEL);
    assert.equal(DEFAULT_MODEL, 'gpt-5.6-luna');
  });
});

describe('--provider against a model that contradicts it', () => {
  it('refuses rather than sending the id to the wrong API', () => {
    // The live shape: --provider openai over a config whose defaults.model is a
    // Claude id. Sending it is a 400 on every trial of the run.
    assert.throws(
      () => providerFor({ provider: 'openai', model: 'claude-haiku-4-5' }),
      /served by anthropic, but --provider says openai/,
    );
  });

  it('refuses in the other direction too', () => {
    assert.throws(
      () => providerFor({ provider: 'anthropic', model: 'gpt-5.6-luna' }),
      /served by openai, but --provider says anthropic/,
    );
  });

  it('refuses on the table and never on the naming convention', () => {
    // A prefix is a guess; refusing on it would break the escape hatch above,
    // where --provider has to win for a model too new to have an entry.
    assert.equal(providerFor({ provider: 'anthropic', model: 'gpt-6-unreleased' }).id, 'anthropic');
    assert.equal(providerFor({ provider: 'openai', model: 'ft:custom-thing' }).model, 'ft:custom-thing');
  });

  it('leaves an agreeing pair alone', () => {
    assert.equal(providerFor({ provider: 'openai', model: 'gpt-5.6-terra' }).model, 'gpt-5.6-terra');
  });
});
