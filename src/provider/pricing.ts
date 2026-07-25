import type { TrialUsage } from '../types.js';

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/**
 * Prices in USD per million tokens, as of 2026-07-25.
 *
 * Used only to put an order-of-magnitude number in front of the user before
 * they spend money. An unknown model means the report omits cost rather than
 * guessing — a wrong number here is worse than no number.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
};

/** Cache writes cost more than fresh input; reads cost far less. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Cost of a usage total, or undefined when the model has no price entry. */
export function costOf(model: string, usage: TrialUsage): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;

  const perInputToken = price.input / 1_000_000;
  return (
    usage.inputTokens * perInputToken +
    usage.cacheCreationInputTokens * perInputToken * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * perInputToken * CACHE_READ_MULTIPLIER +
    (usage.outputTokens * price.output) / 1_000_000
  );
}

export const EMPTY_USAGE: TrialUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export function addUsage(a: TrialUsage, b: TrialUsage): TrialUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
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
