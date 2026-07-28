import type { TrialUsage } from '../types.js';
import { MODELS, specFor, type ModelSpec } from './models.js';

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Base rates, derived from the model table.
 *
 * Kept as a named export because it was one before the table existed and
 * nothing outside should have to care that it is now a view.
 */
export const PRICES: Record<string, ModelPrice> = Object.fromEntries(
  Object.entries(MODELS).map(([id, spec]) => [id, { input: spec.input, output: spec.output }]),
);

/**
 * Cost of **one request's** usage, or undefined when the model has no entry.
 *
 * One request, deliberately: the long-context meter is a property of a single
 * request, so handing this a total summed across a hundred trials would trip
 * the threshold on every run. Use `costOfTrials` for a whole run.
 */
export function costOf(model: string, usage: TrialUsage): number | undefined {
  const spec = specFor(model);
  if (spec === undefined) return undefined;
  return priceUsage(spec, usage);
}

/** Total cost of a run: every trial priced on its own, then summed. */
export function costOfTrials(model: string, usages: Iterable<TrialUsage>): number | undefined {
  const spec = specFor(model);
  if (spec === undefined) return undefined;

  let total = 0;
  for (const usage of usages) total += priceUsage(spec, usage);
  return total;
}

/**
 * The pure core, taking a spec rather than an id.
 *
 * Exported so a model shape that is not in the table — a long-context meter, a
 * provider that bills writes at zero — can be priced in a test by construction
 * rather than by finding a real model that happens to have that property.
 */
export function priceUsage(spec: ModelSpec, usage: TrialUsage): number {
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;

  // The meter is on the whole request's input, cached or not: the tokens are in
  // the context window whichever bucket billed them.
  const requestInput = usage.inputTokens + cacheWrite + cacheRead;
  const long =
    spec.longContext !== undefined && requestInput > spec.longContext.thresholdTokens
      ? spec.longContext
      : undefined;

  // Above the threshold the *whole* request bills at the elevated rate, not
  // just the tokens past the line.
  const input = (spec.input * (long?.input ?? 1)) / 1_000_000;
  const output = (spec.output * (long?.output ?? 1)) / 1_000_000;

  const writeMultiplier = spec.cache.writesBilled ? (spec.cache.writeMultiplier ?? 1) : 0;

  return (
    usage.inputTokens * input +
    cacheWrite * input * writeMultiplier +
    cacheRead * input * spec.cache.readMultiplier +
    usage.outputTokens * output
  );
}

/**
 * Zero of everything the caller can be sure exists.
 *
 * Deliberately without the cache keys: absent means *this model has no such
 * concept*, and zero means *it has one and it was free*. Seeding a sum with
 * zeroes would turn every total into the second statement.
 */
export const EMPTY_USAGE: TrialUsage = {
  inputTokens: 0,
  outputTokens: 0,
};

export function addUsage(a: TrialUsage, b: TrialUsage): TrialUsage {
  const cacheCreation = addOptional(a.cacheCreationInputTokens, b.cacheCreationInputTokens);
  const cacheRead = addOptional(a.cacheReadInputTokens, b.cacheReadInputTokens);

  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
  };
}

/**
 * Absent plus absent stays absent; absent plus present is present.
 *
 * The whole point of the optionality dies one line below where it was made if
 * this coerces either side to zero.
 */
function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function sumUsage(usages: Iterable<TrialUsage>): TrialUsage {
  let total = EMPTY_USAGE;
  for (const usage of usages) total = addUsage(total, usage);
  return total;
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `<$0.01`;
  return `$${amount.toFixed(2)}`;
}
