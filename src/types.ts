/**
 * Internal domain model.
 *
 * Nothing outside `src/adapters/mcp/` may import from `@modelcontextprotocol/sdk`.
 * The SDK is expected to churn hard through the `2026-07-28` transition; these
 * types are the seam that keeps that churn out of the analyser, runner, scorer
 * and reporter.
 */

/** A JSON Schema 2020-12 document, kept deliberately loose. */
export type JsonSchema = Record<string, unknown>;

/** Which world a surface came from. */
export type SurfaceKind = 'mcp' | 'skills';

/**
 * Anything a model selects at runtime from a short natural-language
 * description. MCP tools and Agent Skills are two instances; the selection
 * mechanism is the same, so the measurement problem is the same.
 */
interface Selectable {
  /** Identifier the model emits when it picks this. */
  name: string;
  /** Human-facing title, if the source supplies one. */
  title?: string;
  /** The routing description. It carries the entire triggering burden. */
  description?: string;
  /** Anything the source sent that we do not model explicitly. */
  raw: Record<string, unknown>;
}

/** One tool as advertised by `tools/list`, normalised. */
export interface ToolDef extends Selectable {
  kind: 'tool';
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

/** One skill, read from a `SKILL.md` on disk. */
export interface SkillDef extends Selectable {
  kind: 'skill';
  /** Path to the `SKILL.md`, for anchoring findings. */
  path: string;
  /**
   * Everything after the frontmatter. Never sent to the model during
   * selection — progressive disclosure means only the description is resident
   * — so it is costed separately and never summed into the routing total.
   */
  body: string;
  frontmatter: Record<string, unknown>;
  /**
   * Why the frontmatter could not be read, when it could not be.
   *
   * A broken skill is loaded rather than thrown: one bad file in a set of
   * thirty must not take down the run, and "this one is unparseable" is itself
   * a finding worth reporting — it is a skill the model can never select.
   */
  error?: string;
}

export type SurfaceItem = ToolDef | SkillDef;

/** The full selectable surface of a target, plus how we obtained it. */
export interface Surface {
  kind: SurfaceKind;
  items: SurfaceItem[];
  source: SurfaceSource;
}

export interface SurfaceSource {
  /** How the surface was obtained. */
  kind: 'stdio' | 'http' | 'file' | 'dir';
  /** Which adapter read it. */
  adapter: SurfaceKind;
  /** Command line, URL, or path — for display in reports. */
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

/** A single lint finding against the surface. */
export interface Finding {
  /** Stable rule id, e.g. `missing-tool-description`. */
  rule: string;
  severity: Severity;
  /** Item this finding is anchored to, if any — a tool or a skill name. */
  item?: string;
  /** Dot-path into the tool's input schema, if any. e.g. `properties.name`. */
  path?: string;
  message: string;
  /** Extra rule-specific detail, surfaced in `--json` only. */
  detail?: Record<string, unknown>;
}

/** Token cost of the surface, which is what M1 exists to make visible. */
export interface TokenReport {
  /** Tokens resident in every request. For skills, routing only — not bodies. */
  total: number;
  /** Per-item cost, descending. */
  perItem: Array<{ name: string; tokens: number; share: number }>;
  /**
   * Tokens paid only when an item actually triggers — skills' bodies.
   *
   * Never part of `total`, and never shown as the headline. Confusing the two
   * is precisely what progressive disclosure exists to avoid: a 40k-token
   * skill body costs nothing until it fires, while 40k of routing description
   * is on every request whether it fires or not.
   */
  deferred?: number;
  /** Which tokeniser produced these numbers — always state it in the report. */
  encoding: string;
  approximate: true;
}

export interface Analysis {
  source: SurfaceSource;
  itemCount: number;
  tokens: TokenReport;
  findings: Finding[];
}

/** A static check over the surface. Rules never make network or model calls. */
export interface Rule {
  id: string;
  /** One line, shown in `pickrate inspect --explain`. */
  description: string;
  defaultSeverity: Severity;
  /** Surfaces this rule can say anything useful about. */
  appliesTo: SurfaceKind[];
  run(surface: Surface): Finding[];
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
  /**
   * Adapter-specific presentation mode — skills' `skill-tool` (default) or
   * `pseudo-tool`. Left unset means "whatever the adapter does by default";
   * the adapter validates the value, since only it knows its modes.
   */
  presentation?: string;
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
  source: SurfaceSource;
  model: string;
  /**
   * How the surface was put to the model, when the adapter offers a choice.
   *
   * Part of the result, not a setting: the same skills scored under
   * `skill-tool` and `pseudo-tool` are two different measurements.
   */
  presentation?: string;
  trials: number;
  scenarios: ScenarioScore[];
  /** Items in the surface no scenario ever selected. Context you pay for. */
  orphans: string[];
  usage: TrialUsage;
  /** Estimated spend in USD, or undefined when the model has no price entry. */
  costUsd?: number;
  startedAt: string;
  durationMs: number;
}
