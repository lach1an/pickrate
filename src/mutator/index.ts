import { adapterFor } from '../adapters/index.js';
import type { Presentation } from '../adapters/contract.js';
import type { Provider } from '../provider/index.js';
import { sumUsage } from '../provider/pricing.js';
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
  /**
   * Item names some scenario expects, which get damaged first.
   *
   * Omitted means no preference, which is what every caller did before the
   * 3 August session spent half a $4 budget on `alloydb-basics` — an orphan no
   * scenario selects, so all three of its mutants were guaranteed survivors.
   */
  exercised?: Iterable<string>;
}

/**
 * Choose which defects to inject.
 *
 * Deterministic by construction (round-robin over each operator's enumeration
 * in surface order), since no provider in reach offers a seed.
 *
 * Round-robin rather than in order, so a small budget is not spent entirely on
 * the first operator. Three mutants that are all `blank-description` would
 * measure one thing three times.
 */
export function planMutants(surface: Surface, options: PlanOptions = {}): Mutant[] {
  const chosen = selectOperators(options.operators);
  const limit = options.limit ?? DEFAULT_MUTANTS;

  const queues = chosen
    // Skipped rather than run to produce nothing, so it doesn't count against the score.
    .filter((operator) => operator.appliesTo.includes(surface.kind))
    .map((operator) => prioritise(operator.enumerate(surface), options.exercised));

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

/**
 * The same mutants, with the ones some scenario can see moved to the front.
 *
 * A stable partition, not a sort or a filter. Stable so the order within each
 * half is still the operator's own surface order and the session stays
 * reproducible without a seed; not a filter because a mutant on an untested
 * item is still worth running once the tested ones are exhausted — a survivor
 * naming an orphan is how "no scenario covers this" gets reported at all.
 *
 * A surface-wide operator like `inject-decoys` has no targets and is treated as
 * exercised: it damages everything, so it cannot miss.
 */
function prioritise(mutants: Mutant[], exercised: Iterable<string> | undefined): Mutant[] {
  if (exercised === undefined) return mutants;
  const names = new Set(exercised);
  if (names.size === 0) return mutants;

  const hits = (mutant: Mutant) =>
    mutant.targets.length === 0 || mutant.targets.some((target) => names.has(target));

  return [...mutants.filter(hits), ...mutants.filter((mutant) => !hits(mutant))];
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

  return {
    runs,
    score,
    noise: Math.max(observedNoise, minNoise(trials)),
    observedNoise,
    scenarioNoise: Math.max(widestScenarioGap(runs), minNoise(trials)),
  };
}

/**
 * The widest gap any one scenario showed across the clean runs.
 *
 * The floor for a worst-scenario drop has to be measured the same way the
 * statistic is, or the comparison is between two different things: one noisy
 * scenario out of sixteen swings far more than the mean of all sixteen does.
 */
function widestScenarioGap(runs: EvalReport[]): number {
  const byId = new Map<string, number[]>();
  for (const run of runs) {
    for (const scenario of run.scenarios) {
      byId.set(scenario.id, [...(byId.get(scenario.id) ?? []), scenario.score]);
    }
  }

  let widest = 0;
  for (const scores of byId.values()) {
    widest = Math.max(widest, Math.max(...scores) - Math.min(...scores));
  }
  return widest;
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

  // Every scenario, not just the ones expecting a damaged item: the interesting
  // failure is a *neighbour* stealing the selection, so the scenario that
  // collapses is usually not the target's own.
  const worst = perScenario.reduce<(typeof perScenario)[number] | undefined>(
    (found, s) => (found === undefined || s.delta > found.delta ? s : found),
    undefined,
  );

  return {
    id: mutant.id,
    operator: mutant.operator,
    targets: mutant.targets,
    describe: mutant.describe,
    score,
    delta,
    worstDrop: worst?.delta ?? 0,
    // Absent rather than null when nothing dropped: there is no worst scenario
    // to name, which is a different statement from "the worst one was fine".
    ...(worst !== undefined && worst.delta > 0 ? { worstScenario: worst.id } : {}),
    killed: (worst?.delta ?? 0) > baseline.scenarioNoise,
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
  // Summed from each run's own figure — a long-context meter reads per request.
  const costUsd = everyReport.some((report) => report.costUsd === undefined)
    ? undefined
    : everyReport.reduce((sum, report) => sum + (report.costUsd ?? 0), 0);

  return {
    source: first.source,
    model: first.model,
    ...(first.requestedModel !== undefined ? { requestedModel: first.requestedModel } : {}),
    provider: first.provider,
    reasoning: first.reasoning,
    toolSearch: first.toolSearch,
    regimeHash: first.regimeHash,
    ...(first.presentation !== undefined ? { presentation: first.presentation } : {}),
    trials: input.trials,
    baseline,
    mutants: records,
    // An empty plan scores zero, not one — no injected mutants shouldn't read as "all detected".
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

// Measures the clean surface twice, then once per mutant, each via `runEval`
// unchanged. Each mutant is a different prefix, so it pays its own cache write.
export async function runMutation(
  config: EvalConfig,
  surface: Surface,
  provider: Provider,
  options: RunMutationOptions = {},
): Promise<MutationReport> {
  const startedAt = new Date();
  const started = performance.now();

  const mutants =
    options.mutants ??
    planMutants(surface, { exercised: exercisedItems(config), ...(options.plan ?? {}) });
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
    // Sequential, on the same surface: these two runs are a variance measurement.
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

/**
 * Item names some scenario expects, for `PlanOptions.exercised`.
 *
 * Restraint scenarios (`tool: null`) name nothing, which is correct: they say
 * what must *not* be selected, so they cannot make any item worth damaging.
 */
export function exercisedItems(config: EvalConfig): Set<string> {
  const names = new Set<string>();
  for (const scenario of config.scenarios) {
    if (scenario.expect.tool !== null) names.add(scenario.expect.tool);
  }
  return names;
}

/** Scenario scores keyed by id — small helper for report formatting. */
export function scoresById(report: EvalReport): Map<string, ScenarioScore> {
  return new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
}
