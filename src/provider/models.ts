import type { CacheBehaviour, ModelCapabilities } from './contract.js';

/**
 * The model table — data, not code.
 *
 * Everything that varies per model lives here: price, cache behaviour and its
 * two multipliers, the minimum cacheable prefix, any long-context meter,
 * reasoning support and tool-search support. The *registry* (which provider
 * serves an id) is two entries and stays code; this is the part where a third
 * provider should be a data edit rather than a new branch.
 *
 * Prices are USD per million tokens, as of 2026-07-25. They exist to put an
 * order of magnitude in front of someone before they spend money. An unknown
 * model means the report omits cost rather than guessing — a wrong number here
 * is worse than no number.
 */

export interface LongContextMeter {
  /**
   * Above this many input tokens, the **whole request** bills at the
   * multipliers below — not just the tokens past the line.
   */
  thresholdTokens: number;
  /** Multiple of the base input rate above the threshold. */
  input: number;
  /** Multiple of the base output rate above the threshold. */
  output: number;
}

export interface ModelSpec {
  /** Which provider serves this id. */
  provider: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  cache: CacheBehaviour;
  /**
   * The long-context tier, where the model has one.
   *
   * Absent means the model bills one rate across its whole window — which is
   * where every current Claude model sits. It is modelled anyway because
   * pickrate exists to measure oversized manifests and `inject-decoys`
   * deliberately makes them bigger: on a model that does meter long context,
   * the estimate would under-report by roughly the multiplier at exactly the
   * moment the number matters.
   */
  longContext?: LongContextMeter;
  reasoning: 'none' | 'effort-scale';
  toolSearch: 'supported' | 'unsupported';
  contextWindow: number;
}

/**
 * Anthropic's current line-up caches on an explicit breakpoint, bills writes at
 * 1.25× the input rate (the 5-minute TTL this harness uses) and reads at 0.1×.
 * Only `minimumPrefixTokens` varies, and it varies a lot — see each entry.
 */
function anthropicCache(minimumPrefixTokens: number): CacheBehaviour {
  return {
    population: 'explicit-breakpoint',
    writesBilled: true,
    writeMultiplier: 1.25,
    readMultiplier: 0.1,
    minimumPrefixTokens,
  };
}

export const MODELS: Record<string, ModelSpec> = {
  // The minimum cacheable prefix is *not* monotonic across generations — 512 on
  // the newest models, 4096 on Haiku 4.5, which is this harness's default. A
  // small manifest on the default model does not cache at all, which is exactly
  // what the runner's conditional warm-up exists to notice.
  'claude-haiku-4-5': {
    provider: 'anthropic',
    input: 1,
    output: 5,
    cache: anthropicCache(4096),
    reasoning: 'none',
    toolSearch: 'supported',
    contextWindow: 200_000,
  },
  // Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31. The
  // standard rate is carried here deliberately: a preflight that over-states
  // slightly is a confirmation someone accepts, and one that under-states is a
  // bill they did not agree to.
  'claude-sonnet-5': {
    provider: 'anthropic',
    input: 3,
    output: 15,
    cache: anthropicCache(1024),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    input: 3,
    output: 15,
    cache: anthropicCache(1024),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
  'claude-opus-5': {
    provider: 'anthropic',
    input: 5,
    output: 25,
    cache: anthropicCache(512),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
  'claude-opus-4-8': {
    provider: 'anthropic',
    input: 5,
    output: 25,
    cache: anthropicCache(1024),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
  'claude-opus-4-7': {
    provider: 'anthropic',
    input: 5,
    output: 25,
    cache: anthropicCache(2048),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
  'claude-fable-5': {
    provider: 'anthropic',
    input: 10,
    output: 50,
    cache: anthropicCache(512),
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_000_000,
  },
};

/** The spec for a model id, or undefined when it is not in the table. */
export function specFor(model: string): ModelSpec | undefined {
  return MODELS[model];
}

/**
 * Capabilities for a model, falling back to a conservative shape.
 *
 * The fallback warms the cache and claims nothing: an unknown model is more
 * likely to be a new entry in a familiar line-up than a model with no caching
 * at all, and warming when we did not need to costs one serialised trial —
 * while *not* warming when we should have costs roughly 10× the run.
 */
export function capabilitiesOf(model: string, fallback: ModelCapabilities): ModelCapabilities {
  const spec = specFor(model);
  if (!spec) return fallback;
  return { cache: spec.cache, toolSearch: spec.toolSearch, reasoning: spec.reasoning };
}
