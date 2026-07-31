import { adapterFor } from '../adapters/index.js';
import type { Presentation } from '../adapters/contract.js';
import { trialsFor } from '../config/index.js';
import { costOfTrials } from '../provider/pricing.js';
import { scoreRun, totalUsage, type ScoreOptions } from '../scorer/index.js';
import type { EvalConfig, EvalReport, Scenario, Surface, TrialResult } from '../types.js';
import type { CostEstimate, Provider } from '../provider/contract.js';
import { mapPool } from './pool.js';

export { mapPool } from './pool.js';

export interface RunProgress {
  scenario: Scenario;
  completed: number;
  total: number;
  trial: TrialResult;
}

export interface RunOptions {
  onProgress?: (progress: RunProgress) => void;
  score?: ScoreOptions;
  /**
   * Override how the surface is put to the model. Defaults to whatever its
   * own adapter does, which is what a normal run wants.
   */
  presentation?: Presentation;
  /**
   * The preflight estimate, when one was taken.
   *
   * The runner needs the size of the prefix to decide whether warming it is
   * worth a serialised trial — below a model's minimum cacheable prefix there
   * is no entry to warm. The CLI has already computed this, so passing it
   * through is plumbing rather than a second call. Absent means warm anyway,
   * which is the safe default.
   */
  estimate?: CostEstimate;
}

/**
 * Run every scenario × trial and score the result.
 *
 * The one part of pickrate that spends money, so two properties matter more
 * than throughput:
 *
 *  - **Warm, then fan out.** A cache entry only becomes readable once the
 *    first response has come back. Firing N requests at once means all N pay
 *    full price for the surface. So trial 1 runs alone; the rest follow.
 *  - **Never retry a result.** Transport retries live in the provider's SDK
 *    client. A trial that picked the "wrong" tool is data, and retrying it
 *    until it looks better would bias every pass rate upward, invisibly.
 */
export async function runEval(
  config: EvalConfig,
  surface: Surface,
  provider: Provider,
  options: RunOptions = {},
): Promise<EvalReport> {
  const startedAt = new Date();
  const started = performance.now();

  // Presented once, not per trial, so the cache's byte-stability is structural.
  const presentation = options.presentation ?? adapterFor(surface.kind).present(surface);

  // Projection travels with the presentation rather than being configured separately.
  const score: ScoreOptions = {
    ...options.score,
    project: options.score?.project ?? ((calls) => presentation.project(calls)),
  };

  const jobs: Array<{ scenario: Scenario; index: number }> = [];
  for (const scenario of config.scenarios) {
    const trials = trialsFor(scenario, config.defaults);
    for (let index = 0; index < trials; index++) jobs.push({ scenario, index });
  }

  let completed = 0;
  const report = (scenario: Scenario, trial: TrialResult) => {
    completed++;
    options.onProgress?.({ scenario, completed, total: jobs.length, trial });
  };

  const results: TrialResult[] = [];

  // One trial alone, so the manifest lands in cache before the rest fan out in parallel.
  const warmed = shouldWarm(provider, options.estimate);
  const first = warmed ? jobs[0] : undefined;
  if (first) {
    const trial = await provider.runTrial(presentation, first.scenario);
    results.push(trial);
    report(first.scenario, trial);
  }

  const rest = await mapPool(
    warmed ? jobs.slice(1) : jobs,
    config.defaults.concurrency,
    async (job) => {
      const trial = await provider.runTrial(presentation, job.scenario);
      report(job.scenario, trial);
      return trial;
    },
  );
  results.push(...rest);

  const trialsByScenario = new Map<string, TrialResult[]>();
  for (const scenario of config.scenarios) trialsByScenario.set(scenario.id, []);
  for (const trial of results) trialsByScenario.get(trial.scenarioId)?.push(trial);

  // Read after everything resolves: the model id the API reported, not the alias asked for.
  const model = provider.resolvedModel ?? provider.model;
  const regime = provider.regime(presentation);

  const durationMs = performance.now() - started;
  const { scenarios, orphans } = scoreRun(
    {
      config,
      surface,
      model,
      trialsByScenario,
      startedAt: startedAt.toISOString(),
      durationMs,
    },
    score,
  );

  const usage = totalUsage(trialsByScenario);
  // Priced per trial and summed, never off the total — a long-context meter reads per request.
  const costUsd = costOfTrials(model, results.map((trial) => trial.usage));

  return {
    source: surface.source,
    model,
    ...(model !== provider.model ? { requestedModel: provider.model } : {}),
    provider: regime.provider,
    reasoning: regime.reasoning,
    toolSearch: regime.toolSearch,
    regimeHash: regime.hash,
    ...(presentation.mode !== undefined ? { presentation: presentation.mode } : {}),
    trials: config.defaults.trials,
    scenarios,
    orphans,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    startedAt: startedAt.toISOString(),
    durationMs,
  };
}

/**
 * Is serialising the first trial worth a round trip?
 *
 * Only when the model caches on an explicit breakpoint — with automatic prefix
 * caching there is nothing to mark and no write to serialise against — and only
 * when the prefix is big enough to cache at all. Under the minimum a prefix
 * silently does not cache: no error, no entry, and a warm-up that bought
 * nothing. With no estimate to go on, warm: the asymmetry is one wasted round
 * trip against a run that costs ten times its estimate.
 */
function shouldWarm(provider: Provider, estimate: CostEstimate | undefined): boolean {
  const { cache } = provider.capabilitiesFor(provider.model);
  if (cache.population !== 'explicit-breakpoint') return false;
  if (estimate === undefined || cache.minimumPrefixTokens === undefined) return true;
  return estimate.inputTokensPerTrial >= cache.minimumPrefixTokens;
}

/** Total trials a config will run, for the preflight estimate. */
export function totalTrials(config: EvalConfig): number {
  return config.scenarios.reduce(
    (sum, scenario) => sum + trialsFor(scenario, config.defaults),
    0,
  );
}
