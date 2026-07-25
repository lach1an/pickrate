import type { Scenario, Surface, TrialResult } from '../types.js';

export { costOf, PRICES, EMPTY_USAGE, addUsage, sumUsage, formatUsd } from './pricing.js';
export type { ModelPrice } from './pricing.js';

export interface CostEstimate {
  /** Input tokens for a single trial, including the whole surface. */
  inputTokensPerTrial: number;
  totalTrials: number;
  /** Assumes every trial after the first reads the surface from cache. */
  estimatedUsd?: number;
  model: string;
}

/**
 * The seam between "ask a model" and everything downstream.
 *
 * Only implementations of this interface may import a model SDK — the runner,
 * scorer and reporter consume `TrialResult` and nothing else. That is what
 * lets the scorer be developed and tested with no API key and no spend, and
 * what will let a second provider drop in for multi-model comparison later.
 */
export interface Provider {
  /** Model id, reported prominently — the model under test is part of the result. */
  readonly model: string;

  /**
   * Run one scenario once. Implementations must not execute tools: we measure
   * what the model *selects*, and a `delete_branch` scenario must never delete
   * anything on the user's server.
   */
  runTrial(surface: Surface, scenario: Scenario): Promise<TrialResult>;

  /** Priced preflight, so nobody discovers the cost after paying it. */
  estimate?(surface: Surface, scenarios: Scenario[], totalTrials: number): Promise<CostEstimate>;

  /** Release any underlying client. */
  close?(): Promise<void>;
}
