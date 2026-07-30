import type { Presentation } from '../../src/adapters/contract.js';
import { regimeHash } from '../../src/provider/index.js';
import type { CacheBehaviour, ModelCapabilities, Provider, Regime } from '../../src/provider/index.js';
import type { Scenario, TrialResult } from '../../src/types.js';

/** The cache shape every current Anthropic model has, for tests that want one. */
export const EXPLICIT_BREAKPOINT: CacheBehaviour = {
  population: 'explicit-breakpoint',
  writesBilled: true,
  writeMultiplier: 1.25,
  readMultiplier: 0.1,
  minimumPrefixTokens: 1024,
};

export interface SpyOptions {
  cache?: CacheBehaviour;
  /** What the API reports back as the model that ran. Defaults to `model`. */
  resolveTo?: string;
}

/**
 * Records how many trials were in flight at once, so the warm-up can be
 * asserted rather than assumed.
 *
 * Its cache behaviour is a constructor argument because that is the input to
 * the decision under test: whether trial 1 runs alone depends on the model, not
 * on the provider.
 */
export class SpyProvider implements Provider {
  readonly id = 'spy';
  readonly model = 'spy';
  readonly concurrencyAtStart: number[] = [];
  /**
   * Trial starts and finishes in order.
   *
   * `['start', 'end', …]` means the first trial ran alone; `['start', 'start']`
   * means the run fanned out immediately. Peak concurrency cannot tell those
   * apart — the very first trial always starts alone whether or not it was
   * waited for.
   */
  readonly events: Array<'start' | 'end'> = [];
  resolvedModel?: string;
  private inFlight = 0;

  constructor(private readonly options: SpyOptions = {}) {}

  capabilitiesFor(): ModelCapabilities {
    return {
      cache: this.options.cache ?? EXPLICIT_BREAKPOINT,
      toolSearch: 'unsupported',
      reasoning: 'none',
    };
  }

  regime(): Regime {
    return {
      provider: this.id,
      reasoning: { mode: 'none' },
      toolSearch: 'off',
      hash: regimeHash({ provider: this.id }),
    };
  }

  async runTrial(_presentation: Presentation, scenario: Scenario): Promise<TrialResult> {
    this.inFlight++;
    this.concurrencyAtStart.push(this.inFlight);
    this.events.push('start');
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.inFlight--;
    this.events.push('end');
    this.resolvedModel = this.options.resolveTo ?? this.model;
    return {
      scenarioId: scenario.id,
      calls: scenario.expect.tool === null ? [] : [{ name: scenario.expect.tool, args: {} }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
}
