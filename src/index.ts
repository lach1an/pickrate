/** Library entry point. The CLI in `cli.ts` is a thin wrapper over this. */
export * from './types.js';
export {
  analyse,
  countBySeverity,
  rules,
  rulesById,
  countSurfaceTokens,
  countItemTokens,
  countToolTokens,
  countSkillRoutingTokens,
  countSkillBodyTokens,
} from './analyser/index.js';
export { isTool, isSkill, toolsOf, skillsOf, itemNoun } from './surface.js';
export {
  loadSurface,
  adapterFor,
  parseTarget,
  splitCommand,
  resolveSkillRoot,
  identityPresentation,
  type Adapter,
  type LoadOptions,
  type Presentation,
  type PresentOptions,
  type ToolDeclaration,
  type Target,
} from './adapters/index.js';
export { mcpAdapter, loadManifest, loadManifestFromFile } from './adapters/mcp/index.js';
export { skillsAdapter, loadSkills, loadSkillFile } from './adapters/skills/index.js';
export {
  loadConfig,
  parseConfig,
  parseCi,
  ConfigError,
  DEFAULTS,
  DEFAULT_GATES,
  trialsFor,
  thresholdFor,
} from './config/index.js';
export { Exit, type ExitCode } from './exit.js';
export {
  evaluateAnalysisGates,
  evaluateRunGates,
  evaluateMutationGates,
  exitCodeFor,
  trialCounts,
} from './ci/gates.js';
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
  findOrphans,
  matchesSubset,
  totalUsage,
  defaultNormalise,
  identityProjection,
  FLAKY_LOW,
  FLAKY_HIGH,
  type Normalise,
  type Projection,
  type ScoreOptions,
} from './scorer/index.js';
export { runEval, totalTrials, mapPool, type RunOptions, type RunProgress } from './runner/index.js';
export {
  planMutants,
  runMutation,
  scoreMutation,
  judgeMutant,
  baselineOf,
  meanScore,
  minNoise,
  trialsPerRun,
  operators,
  operatorsById,
  blankDescription,
  swapDescriptions,
  injectDecoys,
  decoyItems,
  DECOY_COUNT,
  DEFAULT_MUTANTS,
  BASELINE_RUNS,
  type Mutant,
  type Operator,
  type PlanOptions,
  type RunMutationOptions,
  type MutationProgress,
  type ScoreMutationInput,
} from './mutator/index.js';
export { formatAnalysis } from './report/table.js';
export { formatEvalReport } from './report/eval.js';
export { formatMutationReport } from './report/mutation.js';
export { formatGates } from './report/gates.js';
export {
  formatAnalysisMarkdown,
  formatEvalMarkdown,
  formatMutationMarkdown,
  COMMENT_MARKER,
} from './report/markdown.js';
export {
  formatAnalysisJson,
  formatEvalReportJson,
  formatMutationReportJson,
  SCHEMA_VERSION,
  type CiExtras,
} from './report/json.js';
