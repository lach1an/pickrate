/** Library entry point. The CLI in `cli.ts` is a thin wrapper over this. */
export * from './types.js';
export { analyse, countBySeverity, rules, rulesById, countManifestTokens, countToolTokens } from './analyser/index.js';
export { loadManifest, loadManifestFromFile, parseTarget, type ConnectOptions, type Target } from './connector/index.js';
export { formatAnalysis } from './report/table.js';
export { formatAnalysisJson, SCHEMA_VERSION } from './report/json.js';
