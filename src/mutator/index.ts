import { adapterFor } from '../adapters/index.js';
import type { Presentation } from '../adapters/contract.js';
import type { Provider } from '../provider/index.js';
import { costOf, sumUsage } from '../provider/pricing.js';
import { runEval, type RunProgress } from '../runner/index.js';
import { operators as allOperators, operatorsById } from './operators/index.js';
import type { Mutant, Operator } from './contract.js';
import type {
  EvalConfig,
  EvalReport,
  MutantRecord,
  MutationBaseline,
  MutationReport,
  ScenarioScore,
  Surface,
} from '../types.js';

export type { Mutant, Operator } from './contract.js';
export { operators, operatorsById, blankDescription, swapDescriptions, injectDecoys } from './operators/index.js';
export { DECOY_COUNT, decoyItems } from './decoys.js';
export { cloneSurface, withDescription, mapItem, describable } from './edit.js';

/** How many mutants a session runs unless told otherwise. */
export const DEFAULT_MUTANTS = 3;

/** How many times the clean surface is measured, to get a noise floor. */
export const BASELINE_RUNS = 2;

/**
 * The smallest drop that can ever count, whatever the two baselines did.
 *
 * One trial flipping is worth `1/trials`, so a pair of baselines that happen to
 * land identically would otherwise set the bar at zero and kill every mutant —
 * including the ones that changed nothing. That is not a hypothetical: any
 * deterministic provider produces exactly that, and it would report a perfect
 * mutation score for a harness that had detected nothing at all.
 */
export function minNoise(trials: number): number {
  return trials > 0 ? 1 / trials : 1;
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                    */
/* -------------------------------------------------------------------------- */

export interface PlanOptions {
  /** Operator ids to use. Unknown ids throw; omitted means all of them. */
  operators?: string[];
  /** Maximum mutants to produce. Fewer is fine — the surface may not offer more. */
  limit?: number;
}

/**
 * Choose which defects to inject.
 *
 * Deterministic by construction: operators enumerate every mutant they could
 * produce in surface order, and this takes them round-robin. Same surface and
 * same options give the same plan, byte for byte, with no seed — which is
 * fortunate, because no provider in reach offers one.
 *
 * Round-robin rather than in order, so a small budget is not spent entirely on
 * the first operator. Three mutants that are all `blank-description` would
 * measure one thing three times.
 */
export function planMutants(surface: Surface, options: PlanOptions = {}): Mutant[] {
  const chosen = selectOperators(options.operators);
  const limit = options.limit ?? DEFAULT_MUTANTS;

  const queues = chosen
    // Skipped, not run to produce nothing: an operator with nothing to say
    // about this surface must not count against the mutation score.
    .filter((operator) => operator.appliesTo.includes(surface.kind))
    .map((operator) => operator.enumerate(surface));

  const plan: Mutant[] = [];
  for (let round = 0; plan.length < limit; round++) {
    const before = plan.length;
    for (const queue of queues) {
      const mutant = queue[round];
      if (mutant === undefined) continue;
      plan.push(mutant);
      if (plan.length >= limit) break;
    }
    if (plan.length === before) break; // every queue exhausted
  }
  return plan;
}

function selectOperators(ids: string[] | undefined): Operator[] {
  if (ids === undefined) return allOperators;
  return ids.map((id) => {
    const operator = operatorsById.get(id);
    if (!operator) {
      throw new Error(
        `Unknown mutation operator "${id}". Available: ${[...operatorsById.keys()].join(', ')}.`,
      );
    }
    return operator;
  });
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one number a mutant is judged on: mean scenario score.
 *
 * A mean rather than a pass count, because pass/fail against a threshold is a
 * step function — a mutant that drags a scenario from 0.99 to 0.96 has done
 * real damage that a threshold at 0.95 would report as nothing happening.
 */
export function meanScore(report: EvalReport): number {
  if (report.scenarios.length === 0) return 0;
  return report.scenarios.reduce((sum, s) => sum + s.score, 0) / report.scenarios.length;
}

/** Build the baseline and its noise floor from the clean runs. */
export function baselineOf(runs: EvalReport[], trials: number): MutationBaseline {
  if (runs.length === 0) throw new Error('A mutation baseline needs at least one clean run.');

  const means = runs.map(meanScore);
  const score = means.reduce((sum, m) => sum + m, 0) / means.length;
  const observedNoise = Math.max(...means) - Math.min(...means);

  return { runs, score, noise: Math.max(observedNoise, minNoise(trials)), observedNoise };
}

/** Judge one mutant against the baseline. Pure. */
export function judgeMutant(
  mutant: Mutant,
  report: EvalReport,
  baseline: MutationBaseline,
): MutantRecord {
  const score = meanScore(report);
  const delta = baseline.score - score;

  const baselineByScenario = poolScenarios(baseline.runs);
  const perScenario = report.scenarios.map((scenario) => {
    const before = baselineByScenario.get(scenario.id) ?? 0;
    return {
      id: scenario.id,
      baseline: before,
      mutant: scenario.score,
      delta: before - scenario.score,
    };
  });

  const moved = perScenario.filter((s) => Math.abs(s.delta) > Number.EPSILON);
  const restraintById = new Map(report.scenarios.map((s) => [s.id, s.restraint]));

  return {
    id: mutant.id,
    operator: mutant.operator,
    targets: mutant.targets,
    describe: mutant.describe,
    score,
    delta,
    killed: delta > baseline.noise,
    restraintOnly: moved.length > 0 && moved.every((s) => restraintById.get(s.id) === true),
    perScenario,
    report,
  };
}

/** Mean score per scenario id across every baseline run. */
function poolScenarios(runs: EvalReport[]): Map<string, number> {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const run of runs) {
    for (const scenario of run.scenarios) {
      const entry = totals.get(scenario.id) ?? { sum: 0, count: 0 };
      entry.sum += scenario.score;
      entry.count++;
      totals.set(scenario.id, entry);
    }
  }
  return new Map([...totals].map(([id, { sum, count }]) => [id, sum / count]));
}

export interface ScoreMutationInput {
  baselineRuns: EvalReport[];
  mutants: Array<{ mutant: Mutant; report: EvalReport }>;
  /** Trials per scenario per run — sets the noise floor. */
  trials: number;
  startedAt: string;
  durationMs: number;
}

/**
 * Assemble the whole mutation report. Pure: reports in, verdict out.
 *
 * Kept apart from the running of it so the kill rule can be tested against
 * hand-written reports, with no provider and no surface in sight.
 */
export function scoreMutation(input: ScoreMutationInput): MutationReport {
  const baseline = baselineOf(input.baselineRuns, input.trials);
  const records = input.mutants.map(({ mutant, report }) => judgeMutant(mutant, report, baseline));

  const first = input.baselineRuns[0]!;
  const everyReport = [...input.baselineRuns, ...records.map((record) => record.report)];
  const usage = sumUsage(everyReport.map((report) => report.usage));
  const costUsd = costOf(first.model, usage);

  return {
    source: first.source,
    model: first.model,
    ...(first.presentation !== undefined ? { presentation: first.presentation } : {}),
    trials: input.trials,
    baseline,
    mutants: records,
    // An empty plan scores zero, not one. "We injected nothing and detected all
    // of it" is the most flattering possible reading of having done no work.
    mutationScore: records.length === 0 ? 0 : records.filter((r) => r.killed).length / records.length,
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    startedAt: input.startedAt,
    durationMs: input.durationMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Running                                                                     */
/* -------------------------------------------------------------------------- */

export interface MutationProgress {
  /** `baseline 1`, `baseline 2`, or the mutant's id. */
  label: string;
  completed: number;
  total: number;
  trial: RunProgress;
}

export interface RunMutationOptions {
  mutants?: Mutant[];
  plan?: PlanOptions;
  onProgress?: (progress: MutationProgress) => void;
  /** Presentation mode, passed to the adapter for every surface. */
  mode?: string;
}

/**
 * Measure the clean surface twice, then once per mutant.
 *
 * Every run goes through `runEval` unchanged, so warm-then-fan-out, bounded
 * concurrency and never-retry-a-result all apply per run without being
 * restated here. Each mutant is presented separately: a mutant surface is a
 * different prefix, so it pays its own cache write and then reads — correct,
 * but it means a mutation session is not one cached run, it is `2 + n` of them.
 */
export async function runMutation(
  config: EvalConfig,
  surface: Surface,
  provider: Provider,
  options: RunMutationOptions = {},
): Promise<MutationReport> {
  const startedAt = new Date();
  const started = performance.now();

  const mutants = options.mutants ?? planMutants(surface, options.plan ?? {});
  const total = BASELINE_RUNS + mutants.length;
  const present = (target: Surface): Presentation =>
    adapterFor(target.kind).present(target, options.mode !== undefined ? { mode: options.mode } : {});

  const report = async (label: string, index: number, target: Surface): Promise<EvalReport> =>
    runEval(config, target, provider, {
      presentation: present(target),
      ...(options.onProgress
        ? {
            onProgress: (trial) =>
              options.onProgress!({ label, completed: index + 1, total, trial }),
          }
        : {}),
    });

  const baselineRuns: EvalReport[] = [];
  for (let i = 0; i < BASELINE_RUNS; i++) {
    // Sequential, and on the *same* surface: the two runs are a variance
    // measurement, and anything that made them differ structurally would put
    // that difference straight into the noise floor.
    baselineRuns.push(await report(`baseline ${i + 1}`, i, surface));
  }

  const results: Array<{ mutant: Mutant; report: EvalReport }> = [];
  for (const [i, mutant] of mutants.entries()) {
    results.push({
      mutant,
      report: await report(mutant.id, BASELINE_RUNS + i, mutant.apply(surface)),
    });
  }

  return scoreMutation({
    baselineRuns,
    mutants: results,
    trials: trialsPerRun(config),
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
  });
}

/**
 * The trial count the noise floor is derived from.
 *
 * The smallest per-scenario count, not the total: the floor exists to model one
 * trial flipping, and it flips soonest in the scenario with the fewest.
 */
export function trialsPerRun(config: EvalConfig): number {
  return config.scenarios.reduce(
    (min, scenario) => Math.min(min, scenario.trials ?? config.defaults.trials),
    config.defaults.trials,
  );
}

/** Scenario scores keyed by id — small helper for report formatting. */
export function scoresById(report: EvalReport): Map<string, ScenarioScore> {
  return new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
}
