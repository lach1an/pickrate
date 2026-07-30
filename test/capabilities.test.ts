import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadConfig } from '../src/config/index.js';
import { AnthropicProvider } from '../src/provider/anthropic.js';
import { ReplayProvider } from '../src/provider/replay.js';
import type { CostEstimate } from '../src/provider/index.js';
import { runEval } from '../src/runner/index.js';
import { EXPLICIT_BREAKPOINT, SpyProvider } from './helpers/spy-provider.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A preflight that claims a prefix of `n` tokens, which is all the runner reads. */
const estimate = (inputTokensPerTrial: number): CostEstimate => ({
  inputTokensPerTrial,
  totalTrials: 20,
  model: 'spy',
});

async function warmed(provider: SpyProvider, options: { estimate?: CostEstimate } = {}) {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const surface = await loadManifestFromFile(fixture('git-server.json'));
  await runEval(config, surface, provider, options);
  // 'start','end' means trial one was waited for; 'start','start' means the run
  // fanned out immediately. Peak concurrency cannot tell those apart, because
  // the very first trial starts alone either way.
  return provider.events[1] === 'end';
}

describe('model capabilities', () => {
  it('resolves per model rather than per provider', () => {
    const provider = new AnthropicProvider({ model: 'claude-haiku-4-5' });

    // One provider, one line-up, an eightfold spread in the minimum cacheable
    // prefix — which is the whole reason capabilities hang off the model.
    assert.equal(provider.capabilitiesFor('claude-haiku-4-5').cache.minimumPrefixTokens, 4096);
    assert.equal(provider.capabilitiesFor('claude-opus-5').cache.minimumPrefixTokens, 512);
    assert.equal(provider.capabilitiesFor('claude-opus-4-7').cache.minimumPrefixTokens, 2048);
  });

  it('falls back to the vendor shape for a model it has never heard of', () => {
    const cache = new AnthropicProvider().capabilitiesFor('claude-something-6').cache;

    // Warming needlessly costs one serialised trial; not warming when we should
    // costs roughly 10× the run. The fallback takes the cheap mistake.
    assert.equal(cache.population, 'explicit-breakpoint');
    assert.equal(cache.minimumPrefixTokens, undefined);
  });

  it('reports no cache at all for replay', async () => {
    const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
    assert.equal(provider.capabilitiesFor().cache.population, 'none');
  });
});

describe('the runner asks instead of assuming', () => {
  it('warms when the model caches on a breakpoint and the prefix clears the minimum', async () => {
    const provider = new SpyProvider({ cache: EXPLICIT_BREAKPOINT });
    assert.equal(await warmed(provider, { estimate: estimate(34_000) }), true);
  });

  it('skips the warm-up under the minimum cacheable prefix', async () => {
    // The newly correct behaviour: below the minimum a prefix silently does not
    // cache — no error, no entry — so serialising trial one buys a round trip
    // and nothing else. `minimumPrefixTokens` here is 1024.
    const provider = new SpyProvider({ cache: EXPLICIT_BREAKPOINT });
    assert.equal(await warmed(provider, { estimate: estimate(400) }), false);
  });

  it('skips the warm-up for automatic prefix caching, whatever the size', async () => {
    // Nothing marks what to cache, so there is no write to serialise against.
    const provider = new SpyProvider({
      cache: { population: 'automatic-prefix', writesBilled: false, readMultiplier: 0.1 },
    });
    assert.equal(await warmed(provider, { estimate: estimate(34_000) }), false);
  });

  it('skips a small manifest on automatic prefix caching too', async () => {
    const provider = new SpyProvider({
      cache: {
        population: 'automatic-prefix',
        writesBilled: false,
        readMultiplier: 0.1,
        minimumPrefixTokens: 1024,
      },
    });
    assert.equal(await warmed(provider, { estimate: estimate(400) }), false);
  });

  it('warms with no estimate to go on', async () => {
    // The safe default: one wasted round trip against a run that costs ten
    // times what it was quoted.
    const provider = new SpyProvider({ cache: EXPLICIT_BREAKPOINT });
    assert.equal(await warmed(provider), true);
  });

  it('never warms for replay', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));

    // Replay declares `population: 'none'`, which it should always have done —
    // there was never a cache to warm against a file on disk.
    const report = await runEval(config, surface, provider);
    assert.equal(report.provider, 'replay');
  });
});

describe('the model that actually ran', () => {
  it('records the resolved id, and names the alias it was asked for', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const provider = new SpyProvider({ resolveTo: 'spy-20260725' });

    const report = await runEval(config, surface, provider);

    // An alias routes to a dated target, so a report storing the requested id
    // does not pin what ran. This is what turns an alias re-point from a soft
    // warning in `diffReports` into a refused comparison.
    assert.equal(report.model, 'spy-20260725');
    assert.equal(report.requestedModel, 'spy');
  });

  it('omits requestedModel when nothing was aliased', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));

    const report = await runEval(config, surface, new SpyProvider());

    assert.equal(report.model, 'spy');
    assert.equal(report.requestedModel, undefined);
  });
});
