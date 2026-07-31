import { thresholdFor } from '../config/index.js';
import { sumUsage } from '../provider/pricing.js';
import type {
  EvalConfig,
  Rate,
  Scenario,
  ScenarioScore,
  Surface,
  ToolCall,
  TrialResult,
} from '../types.js';

/**
 * Scenarios landing inside this band are flagged. This is the genuinely
 * dangerous middle: a server that looks fine in a demo and fails one call in
 * three. A 5% pass rate is an obvious bug; a 55% one gets shipped.
 */
export const FLAKY_LOW = 0.2;
export const FLAKY_HIGH = 0.8;

/** Applied to both sides before comparing arguments. Strict otherwise. */
export type Normalise = (value: unknown) => unknown;

/**
 * Default normalisation: trim strings, recursively.
 *
 * Deliberately conservative. Lowercasing would be lossy — branch names, file
 * paths and identifiers are case-sensitive, and a model that gets the case
 * wrong has genuinely got the argument wrong.
 */
export const defaultNormalise: Normalise = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(defaultNormalise);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, defaultNormalise(v)]),
    );
  }
  return value;
};

/**
 * Raw model calls → the selections being scored. Supplied by the adapter's
 * presentation; see `Presentation.project` for the rules it must obey.
 */
export type Projection = (calls: ToolCall[]) => ToolCall[];

/** Selecting and calling are the same act — the MCP case. */
export const identityProjection: Projection = (calls) => calls;

export interface ScoreOptions {
  normalise?: Normalise;
  /** Adapter-supplied. Defaults to identity, which is the MCP case. */
  project?: Projection;
}

/** Score one scenario's trials. Pure: same trials in, same score out. */
export function scoreScenario(
  scenario: Scenario,
  trials: TrialResult[],
  threshold: number,
  options: ScoreOptions = {},
): ScenarioScore {
  const normalise = options.normalise ?? defaultNormalise;
  const project = options.project ?? identityProjection;
  const expected = scenario.expect.tool;
  const declaredArgs = scenario.expect.args;

  const confusions = new Map<string | null, number>();
  let selectionPassed = 0;
  let argsChecked = 0;
  let argsPassed = 0;
  let fullyCorrect = 0;
  let errors = 0;

  for (const trial of trials) {
    if (trial.error !== undefined) {
      errors++;
      continue;
    }

    // Projected once, here — trial.calls stays the raw transcript on disk.
    const calls = project(trial.calls);

    const selected = selectionOf(calls, expected);
    if (!selected) {
      const key = describeSelection(calls);
      confusions.set(key, (confusions.get(key) ?? 0) + 1);
      continue;
    }

    selectionPassed++;

    if (declaredArgs === undefined) {
      fullyCorrect++;
      continue;
    }

    argsChecked++;
    if (matchesSubset(declaredArgs, calls[0]!.args, normalise)) {
      argsPassed++;
      fullyCorrect++;
    }
  }

  // Excluded from the denominator rather than counted as failures, and surfaced separately.
  const scored = trials.length - errors;
  const score = scored === 0 ? 0 : fullyCorrect / scored;

  return {
    id: scenario.id,
    prompt: scenario.prompt,
    expected,
    threshold,
    selection: rate(selectionPassed, scored),
    ...(declaredArgs !== undefined ? { args: rate(argsPassed, argsChecked) } : {}),
    restraint: expected === null,
    score,
    passed: scored > 0 && score >= threshold,
    flaky: score > FLAKY_LOW && score < FLAKY_HIGH,
    confusions: [...confusions.entries()]
      .map(([selected, count]) => ({ selected, count }))
      .sort((a, b) => b.count - a.count),
    errors,
  };
}

export interface ScoreRunInput {
  config: EvalConfig;
  surface: Surface;
  model: string;
  trialsByScenario: Map<string, TrialResult[]>;
  startedAt: string;
  durationMs: number;
}

/** Score a whole run and assemble the report. */
export function scoreRun(input: ScoreRunInput, options: ScoreOptions = {}): {
  scenarios: ScenarioScore[];
  orphans: string[];
} {
  const scenarios = input.config.scenarios.map((scenario) =>
    scoreScenario(
      scenario,
      input.trialsByScenario.get(scenario.id) ?? [],
      thresholdFor(scenario, input.config.defaults),
      options,
    ),
  );

  // Projection is applied inside each consumer exactly once — not here too.
  return {
    scenarios,
    orphans: findOrphans(input.surface, input.trialsByScenario, options.project),
  };
}

/**
 * Items the model never once selected, under any scenario.
 *
 * Dead weight: you pay their tokens on every single call and get nothing. This
 * is only as good as the scenario coverage, so the report says so.
 *
 * On the skills side this is the metric behind the reported "45% of installed
 * skills never trigger" — same computation, larger corpus. Which is exactly
 * why this projects too: raw skills calls all name the dispatch tool, so
 * without it every skill in the surface reads as never selected.
 */
export function findOrphans(
  surface: Surface,
  trialsByScenario: Map<string, TrialResult[]>,
  project: Projection = identityProjection,
): string[] {
  const selected = new Set<string>();
  for (const trials of trialsByScenario.values()) {
    for (const trial of trials) {
      for (const call of project(trial.calls)) selected.add(call.name);
    }
  }
  return surface.items.map((item) => item.name).filter((name) => !selected.has(name));
}

/** Total usage across every trial in a run. */
export function totalUsage(trialsByScenario: Map<string, TrialResult[]>) {
  return sumUsage([...trialsByScenario.values()].flat().map((trial) => trial.usage));
}

/* -------------------------------------------------------------------------- */

/**
 * Did the model select correctly?
 *
 * Exactly one call, naming the expected tool — extra calls fail. Over-eager
 * tool calling is a real failure mode (spec §4), and scoring "the right tool
 * plus two others" as a pass would hide it.
 */
function selectionOf(calls: ToolCall[], expected: string | null): boolean {
  if (expected === null) return calls.length === 0;
  return calls.length === 1 && calls[0]!.name === expected;
}

/** How a failing trial is labelled in the confusion matrix. */
function describeSelection(calls: ToolCall[]): string | null {
  if (calls.length === 0) return null;
  if (calls.length === 1) return calls[0]!.name;
  return calls.map((call) => call.name).join(' + ');
}

/**
 * Every declared key must match. Keys the model supplied but the scenario did
 * not declare are ignored, so a scenario never has to enumerate optional
 * parameters just to assert one.
 */
export function matchesSubset(
  declared: Record<string, unknown>,
  actual: Record<string, unknown>,
  normalise: Normalise = defaultNormalise,
): boolean {
  for (const [key, value] of Object.entries(declared)) {
    if (!(key in actual)) return false;
    if (!deepEqual(normalise(value), normalise(actual[key]))) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== 'object') return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && deepEqual(left[key], right[key]));
}

function rate(passed: number, total: number): Rate {
  return { passed, total, rate: total === 0 ? 0 : passed / total };
}
