import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import type { Provider } from '../src/provider/index.js';
import { mapPool, runEval, totalTrials } from '../src/runner/index.js';
import type { Presentation } from '../src/adapters/index.js';
import type { Scenario, TrialResult } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Records how many trials were in flight at once, so we can assert the warm-up. */
class SpyProvider implements Provider {
  readonly model = 'spy';
  readonly concurrencyAtStart: number[] = [];
  private inFlight = 0;

  async runTrial(_presentation: Presentation, scenario: Scenario): Promise<TrialResult> {
    this.inFlight++;
    this.concurrencyAtStart.push(this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.inFlight--;
    return {
      scenarioId: scenario.id,
      calls: scenario.expect.tool === null ? [] : [{ name: scenario.expect.tool, args: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
}

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 1, 20, 2, 10];
    const out = await mapPool(delays, 3, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
  });

  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the limit of 4`);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapPool([], 4, async () => 1), []);
  });
});

describe('runEval', () => {
  it('runs the first trial alone so the prompt cache can be written', async () => {
    // Firing every trial at once means none can read the cache the others are
    // still writing — the whole run then pays full price for the manifest.
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const provider = new SpyProvider();

    await runEval(config, surface, provider);

    assert.equal(provider.concurrencyAtStart[0], 1, 'warm-up trial must run alone');
    assert.ok(
      Math.max(...provider.concurrencyAtStart) > 1,
      'later trials must actually run in parallel',
    );
  });

  it('runs every scenario for its own trial count', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const provider = new SpyProvider();

    const report = await runEval(config, surface, provider);

    assert.equal(totalTrials(config), 20);
    assert.equal(provider.concurrencyAtStart.length, 20);
    assert.equal(report.scenarios.length, 4);
    assert.equal(report.model, 'spy');
  });

  it('reports progress for every trial', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    const seen: number[] = [];

    await runEval(config, surface, new SpyProvider(), {
      onProgress: ({ completed, total }) => {
        seen.push(completed);
        assert.equal(total, 20);
      },
    });

    assert.deepEqual(seen, Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
