import { createHash } from 'node:crypto';
import type { Presentation } from '../adapters/contract.js';
import type { ReasoningConfig, Scenario, ToolSearchState, TrialResult } from '../types.js';

export type { ReasoningConfig, ToolSearchState } from '../types.js';

/**
 * What a provider is, with no provider imported.
 *
 * Kept apart from `index.ts` for the same reason as `src/adapters/contract.ts`:
 * the registry there imports every provider, and every provider needs these
 * declarations, so putting both in one module is a cycle — one that resolves at
 * type-check time and then throws "cannot access before initialization" at
 * runtime. This codebase has been bitten by that once already.
 */

export interface CostEstimate {
  /** Input tokens for a single trial, including the whole surface. */
  inputTokensPerTrial: number;
  totalTrials: number;
  /** Assumes every trial after the first reads the surface from cache. */
  estimatedUsd?: number;
  model: string;
}

/**
 * How a model caches, as two independent axes rather than one enum.
 *
 * `population` is *how a prefix gets cached* and decides whether the runner's
 * warm-up trial buys anything. The billing fields are separate because they
 * vary independently: a model can populate on an explicit breakpoint and still
 * bill the write at zero.
 */
export interface CacheBehaviour {
  /**
   * `explicit-breakpoint` — the request marks what to cache, and a cache entry
   * is only readable once the first response has returned. This is the only
   * value for which warming a single trial before fanning out is worth doing.
   *
   * `automatic-prefix` — the provider caches on its own schedule with nothing
   * to mark. There is no write we can serialise against, so a warm-up trial
   * costs a round trip and guarantees nothing.
   *
   * `none` — no caching. Replay is this.
   */
  population: 'explicit-breakpoint' | 'automatic-prefix' | 'none';
  /** Whether writing the cache is charged at all. */
  writesBilled: boolean;
  /** Multiple of the input rate a cache write costs. Absent when unbilled. */
  writeMultiplier?: number;
  /** Multiple of the input rate a cache read costs. */
  readMultiplier: number;
  /**
   * Below this, a prefix silently does not cache — no error, no entry.
   *
   * Load-bearing for the runner: warming a manifest under the minimum
   * serialises a trial for a cache that was never going to exist.
   */
  minimumPrefixTokens?: number;
}

export interface ModelCapabilities {
  cache: CacheBehaviour;
  toolSearch: 'supported' | 'unsupported';
  reasoning: 'none' | 'effort-scale';
}

/**
 * Everything about *how* a surface was put to a model, minus the surface.
 *
 * The hash covers the envelope and never the content — system prompt bytes, the
 * structural form the declarations take, reasoning config, tool-search state
 * and the provider. It must **not** cover the surface, or the adapter's
 * `systemSuffix` that is derived from it: every mutant is a different surface by
 * construction, so a hash over the content would give every mutant a different
 * regime and make a mutation session incomparable with its own baseline.
 *
 * The surface is already identified by `EvalReport.source`, and already varies
 * per mutant. It stays out of here.
 */
export interface Regime {
  provider: string;
  reasoning: ReasoningConfig;
  toolSearch: ToolSearchState;
  hash: string;
}

/**
 * Hash of a regime envelope. Short, stable, printed next to the score.
 *
 * Not a security boundary — it exists so two runs can be told apart, and so
 * `diffReports` can refuse a comparison across a changed instrument.
 */
export function regimeHash(envelope: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex').slice(0, 16);
}

/**
 * The seam between "ask a model" and everything downstream.
 *
 * Only implementations of this interface may import a model SDK — the runner,
 * scorer and reporter consume `TrialResult` and nothing else. That is what
 * lets the scorer be developed and tested with no API key and no spend, and
 * what lets a second provider drop in for multi-model comparison.
 *
 * Providers take a `Presentation`, not a `Surface`: deciding how a surface is
 * put to a model belongs to the adapter that understands it, and a provider
 * that never sees a `Surface` cannot accidentally grow adapter-specific
 * behaviour.
 */
export interface Provider {
  /** Which provider this is, e.g. `anthropic`. Recorded on every report. */
  readonly id: string;

  /** Model id as *requested*, reported prominently — the model is part of the result. */
  readonly model: string;

  /**
   * Model id the API said it actually ran, once a response has come back.
   *
   * An alias routes to a dated target, so the requested id does not pin what
   * ran. Read after every trial has resolved, never during.
   */
  readonly resolvedModel?: string;

  /**
   * Capabilities of a model, not of the provider.
   *
   * A method rather than a `readonly capabilities` because cache behaviour
   * varies by model *within* a provider — the minimum cacheable prefix alone
   * spans an eightfold range across one vendor's current line-up.
   */
  capabilitiesFor(model: string): ModelCapabilities;

  /** How this provider will put the presentation to the model. */
  regime(presentation: Presentation): Regime;

  /**
   * Run one scenario once. Implementations must not execute tools: we measure
   * what the model *selects*, and a `delete_branch` scenario must never delete
   * anything on the user's server.
   */
  runTrial(presentation: Presentation, scenario: Scenario): Promise<TrialResult>;

  /** Priced preflight, so nobody discovers the cost after paying it. */
  estimate?(
    presentation: Presentation,
    scenarios: Scenario[],
    totalTrials: number,
  ): Promise<CostEstimate>;

  /** Release any underlying client. */
  close?(): Promise<void>;
}
