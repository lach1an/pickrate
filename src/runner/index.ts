import { trialsFor } from '../config/index.js';
import { costOf } from '../provider/pricing.js';
import { scoreRun, totalUsage, type ScoreOptions } from '../scorer/index.js';
import type { EvalConfig, EvalReport, Manifest, Scenario, TrialResult } from '../types.js';
import type { Provider } from '../provider/index.js';
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
}

/**
 * Run every scenario × trial and score the result.
 *
 * The one part of mcpeval that spends money, so two properties matter more
 * than throughput:
 *
 *  - **Warm, then fan out.** A cache entry only becomes readable once the
 *    first response has come back. Firing N requests at once means all N pay
 *    full price for the manifest. So trial 1 runs alone; the rest follow.
 *  - **Never retry a result.** Transport retries live in the provider's SDK
 *    client. A trial that picked the "wrong" tool is data, and retrying it
 *    until it looks better would bias every pass rate upward, invisibly.
 */
export async function runEval(
  config: EvalConfig,
  manifest: Manifest,
  provider: Provider,
  options: RunOptions = {},
): Promise<EvalReport> {
  const startedAt = new Date();
  const started = performance.now();

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

  // Warm-up: one trial alone, so the manifest lands in the cache before the
  // rest go out in parallel. Skipping this makes a run roughly 10× dearer.
  const first = jobs[0];
  if (first) {
    const trial = await provider.runTrial(manifest, first.scenario);
    results.push(trial);
    report(first.scenario, trial);
  }

  const rest = await mapPool(jobs.slice(1), config.defaults.concurrency, async (job) => {
    const trial = await provider.runTrial(manifest, job.scenario);
    report(job.scenario, trial);
    return trial;
  });
  results.push(...rest);

  const trialsByScenario = new Map<string, TrialResult[]>();
  for (const scenario of config.scenarios) trialsByScenario.set(scenario.id, []);
  for (const trial of results) trialsByScenario.get(trial.scenarioId)?.push(trial);

  const durationMs = performance.now() - started;
  const { scenarios, orphanTools } = scoreRun(
    {
      config,
      manifest,
      model: provider.model,
      trialsByScenario,
      startedAt: startedAt.toISOString(),
      durationMs,
    },
    options.score,
  );

  const usage = totalUsage(trialsByScenario);
  const costUsd = costOf(provider.model, usage);

  return {
    source: manifest.source,
    model: provider.model,
    trials: config.defaults.trials,
    scenarios,
    orphanTools,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    startedAt: startedAt.toISOString(),
    durationMs,
  };
}

/** Total trials a config will run, for the preflight estimate. */
export function totalTrials(config: EvalConfig): number {
  return config.scenarios.reduce(
    (sum, scenario) => sum + trialsFor(scenario, config.defaults),
    0,
  );
}
