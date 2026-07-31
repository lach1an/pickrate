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
 * Prices are USD per million tokens, verified 2026-07-30. They exist to put an
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

/**
 * OpenAI's current line-up caches automatically on the prefix, with a 1024-token
 * minimum below which nothing caches at all, and reads at 0.1×.
 *
 * `writesBilled` is the axis that varies: 5.6 and later report and bill
 * `cache_write_tokens`, earlier tiers populate for free. The 1.25× figure comes
 * from the July 2026 research and is not on the public pricing table, which
 * lists only input, cached input and output — so it is the one number here that
 * a live run should confirm against reported `cache_write_tokens`.
 *
 * Note what is *absent* for an unbilled-write model: no `writeMultiplier`, and
 * the provider omits `cacheCreationInputTokens` entirely rather than reporting a
 * zero. Zero would say "the write was free"; absent says "there is no such
 * concept here", which is the true statement.
 */
function openaiCache(writesBilled: boolean): CacheBehaviour {
  return {
    population: 'automatic-prefix',
    writesBilled,
    ...(writesBilled ? { writeMultiplier: 1.25 } : {}),
    readMultiplier: 0.1,
    minimumPrefixTokens: 1024,
  };
}

/**
 * Above 272K input tokens the whole request bills at 2× input and 1.5× output.
 *
 * This is the meter §2c was written for, and the first real one in the table:
 * every Claude model bills one rate across its window. `inject-decoys` exists to
 * make manifests bigger, so a mutation session on a large surface is exactly the
 * shape that crosses this line — and pricing a run's summed usage rather than
 * each request would trip it on any long enough run.
 */
const OPENAI_LONG_CONTEXT: LongContextMeter = {
  thresholdTokens: 272_000,
  input: 2,
  output: 1.5,
};

export const MODELS: Record<string, ModelSpec> = {
  // Minimum cacheable prefix is not monotonic across generations: 512 on the
  // newest models, 4096 here (this harness's default).
  'claude-haiku-4-5': {
    provider: 'anthropic',
    input: 1,
    output: 5,
    cache: anthropicCache(4096),
    reasoning: 'none',
    toolSearch: 'supported',
    contextWindow: 200_000,
  },
  // Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31; the standard
  // rate is carried here so the preflight never under-states the eventual bill.
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

  // Every 5.6 tier bills reasoning as output, so the output rate decides run cost.
  //
  // `gpt-5.4-mini` is deliberately absent: unlisted on the published models page,
  // so its context window and cache behaviour can't be verified.
  'gpt-5.6-luna': {
    provider: 'openai',
    input: 1,
    output: 6,
    cache: openaiCache(true),
    longContext: OPENAI_LONG_CONTEXT,
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_050_000,
  },
  'gpt-5.6-terra': {
    provider: 'openai',
    input: 2.5,
    output: 15,
    cache: openaiCache(true),
    longContext: OPENAI_LONG_CONTEXT,
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_050_000,
  },
  'gpt-5.6-sol': {
    provider: 'openai',
    input: 5,
    output: 30,
    cache: openaiCache(true),
    longContext: OPENAI_LONG_CONTEXT,
    reasoning: 'effort-scale',
    toolSearch: 'supported',
    contextWindow: 1_050_000,
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
