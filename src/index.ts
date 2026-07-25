/** Library entry point. The CLI in `cli.ts` is a thin wrapper over this. */
export * from './types.js';
export { analyse, countBySeverity, rules, rulesById, countManifestTokens, countToolTokens } from './analyser/index.js';
export { loadManifest, loadManifestFromFile, parseTarget, type ConnectOptions, type Target } from './connector/index.js';
export { loadConfig, parseConfig, ConfigError, DEFAULTS, trialsFor, thresholdFor } from './config/index.js';
export {
  costOf,
  PRICES,
  formatUsd,
  sumUsage,
  type CostEstimate,
  type ModelPrice,
  type Provider,
} from './provider/index.js';
export { AnthropicProvider, DEFAULT_MODEL } from './provider/anthropic.js';
export { ReplayProvider } from './provider/replay.js';
export {
  scoreRun,
  scoreScenario,
  findOrphanTools,
  matchesSubset,
  totalUsage,
  defaultNormalise,
  FLAKY_LOW,
  FLAKY_HIGH,
  type Normalise,
  type ScoreOptions,
} from './scorer/index.js';
export { runEval, totalTrials, mapPool, type RunOptions, type RunProgress } from './runner/index.js';
export { formatAnalysis } from './report/table.js';
export { formatEvalReport } from './report/eval.js';
export { formatAnalysisJson, formatEvalReportJson, SCHEMA_VERSION } from './report/json.js';
