import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadConfig } from '../src/config/index.js';
import { addUsage, EMPTY_USAGE, sumUsage } from '../src/provider/pricing.js';
import { formatEvalReportJson } from '../src/report/json.js';
import { runEval } from '../src/runner/index.js';
import { SpyProvider } from './helpers/spy-provider.js';
import type { TrialUsage } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * Absent and zero are different statements.
 *
 * Absent means *this model has no such concept*; present-at-zero means *it has
 * one and it was free*. The arithmetic is where that distinction dies if it is
 * going to — one `?? 0` and every total says the second thing.
 */

const noCacheConcept: TrialUsage = { inputTokens: 10, outputTokens: 5 };
const cached: TrialUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 200,
};

describe('usage arithmetic', () => {
  it('keeps absent absent', () => {
    const sum = addUsage(noCacheConcept, noCacheConcept);

    assert.equal(sum.inputTokens, 20);
    assert.ok(!('cacheCreationInputTokens' in sum), 'must not invent a cache field');
    assert.ok(!('cacheReadInputTokens' in sum));
  });

  it('keeps present present, including at zero', () => {
    const sum = addUsage(cached, cached);

    assert.equal(sum.cacheCreationInputTokens, 0, 'zero is a measurement, not an absence');
    assert.equal(sum.cacheReadInputTokens, 400);
  });

  it('promotes to present when only one side has the concept', () => {
    // A run that switched models mid-flight is not a thing this harness allows,
    // but a mixed sum must still not lose the numbers it does have.
    assert.equal(addUsage(noCacheConcept, cached).cacheReadInputTokens, 200);
    assert.equal(addUsage(cached, noCacheConcept).cacheReadInputTokens, 200);
  });

  it('does not seed a sum with zeroes', () => {
    // `sumUsage` starts from EMPTY_USAGE, so if that carried cache keys every
    // total would claim a cache the model may not have.
    assert.ok(!('cacheReadInputTokens' in EMPTY_USAGE));
    assert.ok(!('cacheReadInputTokens' in sumUsage([noCacheConcept, noCacheConcept])));
    assert.equal(sumUsage([noCacheConcept, cached]).cacheReadInputTokens, 200);
  });

  it('sums an empty run to a bare total', () => {
    assert.deepEqual(sumUsage([]), { inputTokens: 0, outputTokens: 0 });
  });
});

describe('the report a no-cache model produces', () => {
  it('omits the cache keys rather than zeroing them', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));

    class NoCacheProvider extends SpyProvider {
      override async runTrial(...args: Parameters<SpyProvider['runTrial']>) {
        const trial = await super.runTrial(...args);
        return { ...trial, usage: { inputTokens: 10, outputTokens: 5 } };
      }
    }

    const report = await runEval(config, surface, new NoCacheProvider());
    const usage = JSON.parse(formatEvalReportJson(report)).usage;

    assert.deepEqual(Object.keys(usage), ['inputTokens', 'outputTokens']);
  });

  it('still reports all four for a model that caches', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));

    const report = await runEval(config, surface, new SpyProvider());
    const usage = JSON.parse(formatEvalReportJson(report)).usage;

    assert.deepEqual(Object.keys(usage), [
      'inputTokens',
      'outputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
    ]);
  });
});
