import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { estimateUsd } from '../src/provider/anthropic.js';
import { costOf, costOfTrials, estimateRunUsd, priceUsage } from '../src/provider/pricing.js';
import { specFor, type ModelSpec } from '../src/provider/models.js';
import { injectDecoys } from '../src/mutator/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * Prices are a preflight promise, so the ways they can be quietly wrong all
 * matter: a multiplier read from the wrong place, a meter that never fires, or
 * a warm-up trial billed as if it were a cache read.
 */

const base: ModelSpec = {
  provider: 'test',
  input: 10,
  output: 100,
  cache: {
    population: 'explicit-breakpoint',
    writesBilled: true,
    writeMultiplier: 2,
    readMultiplier: 0.1,
  },
  reasoning: 'none',
  toolSearch: 'unsupported',
  contextWindow: 1_000_000,
};

const million = { inputTokens: 1_000_000, outputTokens: 0 };

/** Money in floating point: compare to the cent, not to the bit. */
function assertUsd(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`);
}

describe('cache multipliers', () => {
  it('reads the write multiplier from the model, not from a module constant', () => {
    const cheap = priceUsage(base, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 });
    const dearer = priceUsage(
      { ...base, cache: { ...base.cache, writeMultiplier: 4 } },
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
    );

    assert.equal(cheap, 20); // $10/Mtok × 2
    assert.equal(dearer, 40);
  });

  it('bills nothing for a write on a model that does not charge for one', () => {
    const free: ModelSpec = { ...base, cache: { ...base.cache, writesBilled: false } };

    assert.equal(
      priceUsage(free, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 }),
      0,
    );
  });

  it('prices a cache read at the model\'s read multiplier', () => {
    assert.equal(priceUsage(base, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 }), 1);
  });
});

describe('the long-context meter', () => {
  const metered: ModelSpec = { ...base, longContext: { thresholdTokens: 200_000, input: 2, output: 1.5 } };

  it('does not fire below the threshold', () => {
    assert.equal(priceUsage(metered, { inputTokens: 100_000, outputTokens: 0 }), 1);
  });

  it('bills the whole request at the elevated rate above it, not just the excess', () => {
    const above = priceUsage(metered, { inputTokens: 300_000, outputTokens: 0 });

    // 300k at 2× the base rate, not 200k at 1× plus 100k at 2×. Getting this
    // wrong under-reports by roughly the multiplier at exactly the moment the
    // number matters.
    assertUsd(above, 6);
  });

  it('counts cached tokens toward the threshold', () => {
    // They are in the context window whichever bucket billed them.
    const usage = { inputTokens: 1000, outputTokens: 0, cacheReadInputTokens: 250_000 };
    assert.ok(priceUsage(metered, usage) > priceUsage({ ...base }, usage));
  });

  it('prices a decoy-injected manifest past a threshold the clean one clears', async () => {
    // Constructed rather than hoped for: pickrate exists to measure oversized
    // manifests and `inject-decoys` deliberately makes them bigger, so the
    // meter has to be right on precisely the surface this tool produces.
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const clean = analyse(surface).tokens.total;
    const mutant = injectDecoys.enumerate(surface)[0]!;
    const inflated = analyse(mutant.apply(surface)).tokens.total;

    assert.ok(inflated > clean, 'the decoy operator must actually grow the surface');

    // A threshold that sits between the two, so the mutant crosses it and the
    // baseline does not.
    const threshold = Math.floor((clean + inflated) / 2);
    const spec: ModelSpec = { ...base, longContext: { thresholdTokens: threshold, input: 2, output: 2 } };

    const cleanCost = priceUsage(spec, { inputTokens: clean, outputTokens: 0 });
    const mutantCost = priceUsage(spec, { inputTokens: inflated, outputTokens: 0 });

    assert.ok(
      mutantCost > (cleanCost * inflated) / clean,
      'crossing the threshold must cost more than the extra tokens alone',
    );
  });
});

describe('the run total', () => {
  it('prices each trial on its own rather than the sum', () => {
    // A meter is a property of one request. Summing first would trip a
    // threshold on any long enough run, whatever the size of a single trial.
    const metered: ModelSpec = { ...base, longContext: { thresholdTokens: 200_000, input: 10, output: 10 } };
    const trials = Array.from({ length: 10 }, () => ({ inputTokens: 100_000, outputTokens: 0 }));

    const perTrial = trials.reduce((sum, usage) => sum + priceUsage(metered, usage), 0);
    assertUsd(perTrial, 10);
  });

  it('omits the cost for a model with no price on file', () => {
    assert.equal(costOf('some-unreleased-model', million), undefined);
    assert.equal(costOfTrials('some-unreleased-model', [million]), undefined);
  });

  it('sums a real model over its trials', () => {
    const spec = specFor('claude-haiku-4-5')!;
    const trials = [million, million];

    assert.equal(costOfTrials('claude-haiku-4-5', trials), priceUsage(spec, million) * 2);
  });
});

describe('the preflight estimate', () => {
  it('prices the warm-up trial as a cache write, not as plain input', () => {
    const spec = specFor('claude-haiku-4-5')!;
    const prefix = 34_000;

    const oneTrial = estimateUsd('claude-haiku-4-5', prefix, 1)!;
    const plainInput = priceUsage(spec, { inputTokens: prefix, outputTokens: 80 });

    // 1.25× on the first trial. Small on one trial, and the same class of error
    // the meter above guards against: an estimate that is quietly under.
    assert.ok(oneTrial > plainInput, 'the first trial writes the cache and bills at the write rate');
    assertUsd(
      oneTrial,
      priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheCreationInputTokens: prefix }),
    );
  });

  it('prices every trial after the first as a cache read', () => {
    const spec = specFor('claude-haiku-4-5')!;
    const prefix = 34_000;
    const read = priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheReadInputTokens: prefix });

    const ten = estimateUsd('claude-haiku-4-5', prefix, 10)!;
    const one = estimateUsd('claude-haiku-4-5', prefix, 1)!;

    assertUsd(ten, one + 9 * read);
  });

  it('says nothing for a model it has no price for', () => {
    assert.equal(estimateUsd('some-unreleased-model', 1000, 10), undefined);
  });
});

describe('the run estimate and the minimum cacheable prefix', () => {
  /**
   * Below the minimum a prefix silently does not cache, so every trial pays full
   * input rate. Assuming one write and N-1 reads under the line under-reports by
   * close to the read multiplier — and under-reporting is the direction that
   * produces a bill nobody agreed to.
   */
  const spec = specFor('claude-haiku-4-5')!;
  const minimum = spec.cache.minimumPrefixTokens!;

  it('prices every trial at full input rate under the minimum', () => {
    const trials = 20;
    const tokens = minimum - 1;
    const perTrial = priceUsage(spec, { inputTokens: tokens, outputTokens: 80 });

    assert.equal(estimateRunUsd(spec, tokens, trials).toFixed(9), (trials * perTrial).toFixed(9));
  });

  it('costs more than the cached assumption would have claimed', () => {
    const tokens = minimum - 1;
    const cached =
      priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheCreationInputTokens: tokens }) +
      19 * priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheReadInputTokens: tokens });

    assert.ok(estimateRunUsd(spec, tokens, 20) > cached);
  });

  it('takes the cached path once the prefix clears the minimum', () => {
    // One write plus N-1 reads, which is what the runner's warm-up guarantees.
    const tokens = minimum;
    const expected =
      priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheCreationInputTokens: tokens }) +
      19 * priceUsage(spec, { inputTokens: 0, outputTokens: 80, cacheReadInputTokens: tokens });

    assert.equal(estimateRunUsd(spec, tokens, 20).toFixed(9), expected.toFixed(9));
  });

  it('prices every trial as a write on an automatic-prefix model', () => {
    // No write to serialise against means the runner does not warm, so
    // concurrent trials can all miss a prefix none of them has populated.
    const openai = specFor('gpt-5.6-luna')!;
    const tokens = 10_000;
    const perTrial = priceUsage(openai, {
      inputTokens: 0,
      outputTokens: 80,
      cacheCreationInputTokens: tokens,
    });

    assert.equal(estimateRunUsd(openai, tokens, 20).toFixed(9), (20 * perTrial).toFixed(9));
  });
});

describe('pricing a model id the API resolved', () => {
  const usage = { inputTokens: 1000, outputTokens: 100 };

  it('has no entry for a dated snapshot on its own', () => {
    assert.equal(specFor('claude-haiku-4-5-20251001'), undefined);
  });

  it('falls back to the alias that was requested', () => {
    // Otherwise every run against a default model loses its cost line.
    assert.equal(
      costOf('claude-haiku-4-5-20251001', usage, 'claude-haiku-4-5'),
      costOf('claude-haiku-4-5', usage),
    );
  });

  it('prefers the resolved id when it does have an entry', () => {
    // The fallback is a last resort, never an override.
    assert.equal(
      costOf('claude-opus-5', usage, 'claude-haiku-4-5'),
      costOf('claude-opus-5', usage),
    );
  });

  it('stays undefined when neither id is known', () => {
    assert.equal(costOfTrials('who-knows-1', [usage], 'who-knows-2'), undefined);
  });
});
