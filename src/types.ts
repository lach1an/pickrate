/**
 * Internal domain model.
 *
 * Nothing outside `src/connector/` may import from `@modelcontextprotocol/sdk`.
 * The SDK is expected to churn hard through the `2026-07-28` transition; these
 * types are the seam that keeps that churn out of the analyser, runner, scorer
 * and reporter.
 */

/** A JSON Schema 2020-12 document, kept deliberately loose. */
export type JsonSchema = Record<string, unknown>;

/** One tool as advertised by `tools/list`, normalised. */
export interface ToolDef {
  name: string;
  /** Human-facing title, if the server supplies one. */
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** Anything the server sent that we do not model explicitly. */
  raw: Record<string, unknown>;
}

/** The full tool surface of a server, plus how we obtained it. */
export interface Manifest {
  tools: ToolDef[];
  source: ManifestSource;
}

export interface ManifestSource {
  /** How the manifest was obtained. */
  kind: 'stdio' | 'http' | 'file';
  /** Command line, URL, or file path — for display in reports. */
  target: string;
  /** Server-reported name/version, when the transport exposes it. */
  serverInfo?: { name: string; version: string };
  /** Protocol version negotiated, when known. */
  protocolVersion?: string;
  fetchedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Analyser                                                                    */
/* -------------------------------------------------------------------------- */

export type Severity = 'error' | 'warn' | 'info';

/** A single lint finding against the manifest. */
export interface Finding {
  /** Stable rule id, e.g. `missing-tool-description`. */
  rule: string;
  severity: Severity;
  /** Tool this finding is anchored to, if any. */
  tool?: string;
  /** Dot-path into the tool's input schema, if any. e.g. `properties.name`. */
  path?: string;
  message: string;
  /** Extra rule-specific detail, surfaced in `--json` only. */
  detail?: Record<string, unknown>;
}

/** Token cost of the manifest, which is what M1 exists to make visible. */
export interface TokenReport {
  /** Tokens for the whole serialised tool array. */
  total: number;
  /** Per-tool cost, descending. */
  perTool: Array<{ name: string; tokens: number; share: number }>;
  /** Which tokeniser produced these numbers — always state it in the report. */
  encoding: string;
  approximate: true;
}

export interface Analysis {
  source: ManifestSource;
  toolCount: number;
  tokens: TokenReport;
  findings: Finding[];
}

/** A static check over the manifest. Rules never make network or model calls. */
export interface Rule {
  id: string;
  /** One line, shown in `mcpeval inspect --explain`. */
  description: string;
  defaultSeverity: Severity;
  run(manifest: Manifest): Finding[];
}

/* -------------------------------------------------------------------------- */
/* Eval config                                                                 */
/* -------------------------------------------------------------------------- */

/** What the model is expected to do with a scenario prompt. */
export interface Expectation {
  /** Tool the model should select. `null` is a restraint check: call nothing. */
  tool: string | null;
  /**
   * Arguments to assert. Only the keys named here are checked — extra
   * arguments the model supplies are ignored, so a scenario never has to
   * enumerate every optional parameter.
   */
  args?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  prompt: string;
  expect: Expectation;
  /** Overrides `defaults.threshold`. Demand more of destructive operations. */
  threshold?: number;
  /** Overrides `defaults.trials`. */
  trials?: number;
}

export interface EvalDefaults {
  trials: number;
  threshold: number;
  model: string;
  concurrency: number;
}

export interface EvalConfig {
  /** How to reach the server, in `parseTarget` form. */
  target: string;
  defaults: EvalDefaults;
  scenarios: Scenario[];
  /** Where the config was loaded from, for the report header. */
  path: string;
}

/* -------------------------------------------------------------------------- */
/* Trials                                                                      */
/* -------------------------------------------------------------------------- */

/** One tool invocation the model asked for. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * The outcome of one trial: one prompt, one model turn, no tool execution.
 *
 * This is the seam between the provider and the scorer — the scorer consumes
 * only this, never a provider SDK type. It is also the on-disk fixture format,
 * which is what lets the scorer be developed offline (and what M3's mutation
 * runs compare against).
 */
export interface TrialResult {
  scenarioId: string;
  /** Every call the model asked for, in order. Empty means it called nothing. */
  calls: ToolCall[];
  stopReason: string | null;
  usage: TrialUsage;
  /** Set when the trial could not be completed (transport, refusal, …). */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Scores                                                                      */
/* -------------------------------------------------------------------------- */

/** A pass rate, never a boolean — see spec §4. */
export interface Rate {
  passed: number;
  total: number;
  rate: number;
}

export interface ScenarioScore {
  id: string;
  prompt: string;
  expected: string | null;
  threshold: number;
  /** Did it choose the right tool — and only that tool? */
  selection: Rate;
  /** Of the trials that selected correctly, how many got the args right. */
  args?: Rate;
  /** True when `expected` is null: this scenario measures restraint. */
  restraint: boolean;
  /** Rate that decides pass/fail against the threshold. */
  score: number;
  passed: boolean;
  /** Between 20% and 80% — looks fine in a demo, fails one call in three. */
  flaky: boolean;
  /** What it picked instead, descending by count. */
  confusions: Array<{ tool: string | null; count: number }>;
  errors: number;
}

export interface EvalReport {
  source: ManifestSource;
  model: string;
  trials: number;
  scenarios: ScenarioScore[];
  /** Tools in the manifest no scenario ever selected. Context you pay for. */
  orphanTools: string[];
  usage: TrialUsage;
  /** Estimated spend in USD, or undefined when the model has no price entry. */
  costUsd?: number;
  startedAt: string;
  durationMs: number;
}
