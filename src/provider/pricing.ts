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
 * The table entry to price against, preferring what actually ran.
 *
 * A resolved dated snapshot is not in the table while its alias is, so pricing
 * only the reported id drops the cost line from every run made against an alias
 * — which is every run on a default model.
 */
function pricingSpec(model: string, requested?: string): ModelSpec | undefined {
  return specFor(model) ?? (requested !== undefined ? specFor(requested) : undefined);
}

/**
 * Cost of **one request's** usage, or undefined when the model has no entry.
 *
 * One request, deliberately: the long-context meter is a property of a single
 * request, so handing this a total summed across a hundred trials would trip
 * the threshold on every run. Use `costOfTrials` for a whole run.
 */
export function costOf(model: string, usage: TrialUsage, requested?: string): number | undefined {
  const spec = pricingSpec(model, requested);
  if (spec === undefined) return undefined;
  return priceUsage(spec, usage);
}

/** Total cost of a run: every trial priced on its own, then summed. */
export function costOfTrials(
  model: string,
  usages: Iterable<TrialUsage>,
  requested?: string,
): number | undefined {
  const spec = pricingSpec(model, requested);
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

/**
 * A whole run's estimated cost, priced through `priceUsage` per request.
 *
 * Output tokens are a flat allowance — a tool call is small, and the estimate
 * exists to convey magnitude. On a model that reasons, that allowance is a lower
 * bound, because reasoning bills as output and is not predictable from the input;
 * whether the preflight therefore has to become a range is open (decision B) and
 * is a user-facing promise, so it is not being decided by default here.
 *
 * Below the model's minimum cacheable prefix, no cache assumption applies at
 * all: a prefix under the line silently does not cache — no error, no entry — so
 * every trial pays full input rate. This is the same fact the runner's
 * conditional warm-up reads, and getting it wrong here is worse than getting it
 * wrong there: the runner wastes a round trip, while the estimate under-reports
 * a small-manifest run by close to the read multiplier. On the default model,
 * whose minimum is 4096 — the highest in the line-up — that is most runs of a
 * small surface.
 *
 * Otherwise the assumption follows the model, and the two cases differ in kind:
 *
 * - `explicit-breakpoint` — the runner warms one trial before fanning out, so
 *   exactly one request writes the prefix and the rest read it. The estimate can
 *   say that because the runner guarantees it.
 * - `automatic-prefix` — there is no write to serialise against, so the runner
 *   does not warm, and trials that start concurrently can *all* miss a prefix
 *   none of them has populated yet. The real write-to-read ratio is a
 *   measurement nobody has taken, so every trial is priced as a write: an upper
 *   bound. Over-stating is a confirmation someone accepts; under-stating is a
 *   bill they did not agree to.
 */
export function estimateRunUsd(
  spec: ModelSpec,
  inputTokensPerTrial: number,
  totalTrials: number,
): number {
  const OUTPUT_TOKENS_PER_TRIAL = 80;
  const write = (tokens: number): TrialUsage => ({
    inputTokens: 0,
    outputTokens: OUTPUT_TOKENS_PER_TRIAL,
    cacheCreationInputTokens: tokens,
    cacheReadInputTokens: 0,
  });

  const minimum = spec.cache.minimumPrefixTokens;
  if (
    spec.cache.population === 'none' ||
    (minimum !== undefined && inputTokensPerTrial < minimum)
  ) {
    return (
      totalTrials *
      priceUsage(spec, {
        inputTokens: inputTokensPerTrial,
        outputTokens: OUTPUT_TOKENS_PER_TRIAL,
      })
    );
  }

  if (spec.cache.population === 'automatic-prefix') {
    return totalTrials * priceUsage(spec, write(inputTokensPerTrial));
  }

  const cached = priceUsage(spec, {
    inputTokens: 0,
    outputTokens: OUTPUT_TOKENS_PER_TRIAL,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: inputTokensPerTrial,
  });

  return priceUsage(spec, write(inputTokensPerTrial)) + Math.max(0, totalTrials - 1) * cached;
}

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `<$0.01`;
  return `$${amount.toFixed(2)}`;
}
