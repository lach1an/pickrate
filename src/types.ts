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
  /**
   * Whether a second listing returned the items in the same order as the first.
   *
   * Absent means we did not find out — a file fixture, or a re-list that
   * failed — and is deliberately not the same statement as `true`. A server
   * that reorders between calls invalidates the cached prompt prefix behind it
   * on every reconnect, silently and at real cost, which is why this is
   * recorded on the surface rather than inferred later.
   */
  listOrderStable?: boolean;
  /**
   * Cache metadata the listing declared (SEP-2549), verbatim.
   *
   * Absent on any server predating `2026-07-28`, where the concept does not
   * exist — which is why the rules that read this are gated on the protocol
   * revision rather than firing at every server in the corpus.
   */
  listCache?: {
    /** Freshness hint in milliseconds. */
    ttlMs?: number;
    /** `public` or `private`, per the spec's HTTP `Cache-Control` model. */
    cacheScope?: string;
  };
  /**
   * Protocol versions the server advertised via `server/discover`, when it
   * answered one. Absent means it did not, which today means every server.
   */
  discoveredVersions?: string[];
  /**
   * Whether the listing was fetched with credentials attached.
   *
   * A boolean and never the header itself — invariant 10 holds for every
   * report field. It exists so `public-cache-scope` can tell a catalogue that
   * might vary per tenant from one that plainly cannot.
   */
  credentialed?: boolean;
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
  /** CI gates. Lives in the repo next to the scenarios — see `CiGates`. */
  ci: CiGates;
  /** Where the config was loaded from, for the report header. */
  path: string;
}

/* -------------------------------------------------------------------------- */
/* CI                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Thresholds that decide whether a build goes red.
 *
 * They live in the config file rather than in a workflow's YAML string,
 * because a threshold argued over in review belongs in the repo next to the
 * scenarios it judges. CLI flags override; every gate is off by default except
 * `maxErrorRate`.
 */
export interface CiGates {
  /** inspect: fail on findings at or above this severity. `null` is off. */
  failOn?: Severity | null;
  /** inspect: resident token budget. Skills' bodies are never counted. */
  maxTokens?: number;
  /** run: how many scenarios may sit in the 20–80% flakiness band. */
  maxFlaky?: number;
  /** run: how many items no scenario ever selected. */
  maxOrphans?: number;
  /**
   * run: the fraction of trials that may error before the run is *unmeasured*.
   *
   * The one gate that defaults on, and the one whose breach is exit 2 rather
   * than exit 1. Errored trials leave the denominator, so a run where 18 of 20
   * trials died on transport reports a confident 100% from the two that
   * survived. Locally a human sees the "18 errored" line; in CI nobody reads
   * the log of a green build.
   */
  maxErrorRate: number;
  /** run --baseline: the worst per-scenario drop that is tolerated. */
  maxRegression?: number;
  /** mutate: the mutation score floor. */
  minScore?: number;
}

/** One gate's verdict. Pure data — the exit code is derived from a list of them. */
export interface GateResult {
  /** Stable id, e.g. `max-flaky`, `max-regression`. */
  id: string;
  limit: number | string;
  observed: number | string;
  passed: boolean;
  /** Breached this way means unmeasured (exit 2), not bad (exit 1). */
  unmeasured?: boolean;
  message: string;
}

/** A head run compared against a stored one. See `src/ci/compare.ts`. */
export interface ReportDiff {
  baseline: { model: string; startedAt: string; path: string };
  /** What a drop must clear: `max(maxRegression, minNoise(trials))`. */
  floor: number;
  scenarios: Array<{
    id: string;
    baseline: number;
    head: number;
    /** `head - baseline`. Negative is a drop. */
    delta: number;
    regressed: boolean;
  }>;
  meanDelta: number;
  /** Scenarios that passed on the baseline and fail now. */
  newFailures: string[];
  /** Scenarios that failed on the baseline and pass now. */
  fixed: string[];
  newOrphans: string[];
  /**
   * Things that make the comparison less trustworthy without invalidating it.
   *
   * An aliased model id is the standing one: `claude-haiku-4-5` can be
   * re-pointed underneath a stored baseline, so a two-week-old diff quietly
   * mixes a description change with a model update.
   */
  warnings: string[];
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
  /**
   * Omitted when the model has no such concept — **not merely zero**.
   *
   * Absent means "this model does not cache"; present-at-zero means "it does,
   * and nothing was cached". Those are different facts about a run, and the
   * arithmetic in `addUsage` is careful to keep them apart. Same distinction
   * `TokenReport.deferred` preserves for skills' bodies.
   */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
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
  /**
   * What it picked instead, descending by count. `null` means it picked
   * nothing. Named `selected` rather than `tool` because on a skills surface
   * the thing selected is a skill.
   */
  confusions: Array<{ selected: string | null; count: number }>;
  errors: number;
}

/** How much the model was allowed to reason. Part of the measurement. */
export interface ReasoningConfig {
  /** `none` when the model exposes no reasoning control. */
  mode: 'none' | 'effort';
  /** The effort level, when `mode` is `effort`. */
  effort?: string;
}

/**
 * Whether the model saw the whole surface or had to search for it.
 *
 * The independent variable, and never left at the provider's default: eager
 * and deferred are two regimes, and a comparison that does not record which one
 * ran blames the manifest for the retriever.
 */
export type ToolSearchState = 'off' | 'on';

/**
 * Everything about the instrument, as opposed to the thing measured.
 *
 * The unit of comparison is model + reasoning config + loading regime. Two runs
 * that differ in any of these are two measurements, not two points on one line,
 * which is why all of it is stored and why `diffReports` refuses on a mismatch.
 */
export interface RunProvenance {
  /** Which provider ran it, e.g. `anthropic`. */
  provider: string;
  reasoning: ReasoningConfig;
  toolSearch: ToolSearchState;
  /**
   * Hash of the request envelope: prompt bytes, declaration form, reasoning,
   * tool-search state, provider — and never the surface, which varies per
   * mutant by construction and is identified by `source` instead.
   */
  regimeHash: string;
}

export interface EvalReport extends RunProvenance {
  source: SurfaceSource;
  /**
   * The model that actually ran, as the API reported it — not the id requested.
   *
   * An alias routes to a dated target, so a report storing the requested id
   * does not pin what ran. Recording the resolved one turns an alias re-point
   * from a warning into a refused comparison.
   */
  model: string;
  /** The id asked for, when it differs from `model` — i.e. when it was an alias. */
  requestedModel?: string;
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

/* -------------------------------------------------------------------------- */
/* Mutation                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The clean surface, measured twice.
 *
 * Both runs are kept because they *are* the noise measurement — spec §6's
 * variance baseline. A regression smaller than the gap between two identical
 * runs means nothing, and a mutation score computed without that gap is a
 * count of coin flips.
 */
export interface MutationBaseline {
  /** The two clean runs, in order. */
  runs: EvalReport[];
  /** Mean scenario score, pooled across both runs. */
  score: number;
  /** What a drop must clear to count: `observedNoise`, floored at `1/trials`. */
  noise: number;
  /**
   * The raw gap between the two runs, before flooring.
   *
   * Reported separately so a suspiciously quiet baseline is visible rather
   * than hidden behind the floor: two runs that agree exactly usually mean a
   * deterministic provider, not a stable server.
   */
  observedNoise: number;
}

/** One injected defect and what it did to the score. */
export interface MutantRecord {
  id: string;
  operator: string;
  /** Items damaged. Empty for surface-wide operators like decoy injection. */
  targets: string[];
  describe: string;
  /** Mean scenario score under this mutant. */
  score: number;
  /** `baseline.score - score`. Positive means the surface got worse. */
  delta: number;
  /**
   * Did the harness notice? `delta > baseline.noise`.
   *
   * A mutant that is *not* killed is inconclusive, never a pass: it means
   * either the harness is insensitive or no scenario exercises what was
   * damaged, and `targets` is what tells the two apart.
   */
  killed: boolean;
  /**
   * True when the only scenarios that moved were restraint checks.
   *
   * Damage makes a model less willing to call anything, which *raises*
   * restraint scores and can hide a selection collapse inside the mean. A flag
   * rather than a second threshold — it is a diagnostic, not a verdict.
   */
  restraintOnly: boolean;
  perScenario: Array<{ id: string; baseline: number; mutant: number; delta: number }>;
  /** The full run, kept for its confusion pairs and orphans. */
  report: EvalReport;
}

export interface MutationReport extends RunProvenance {
  source: SurfaceSource;
  model: string;
  requestedModel?: string;
  presentation?: string;
  /** Trials per scenario, per run. */
  trials: number;
  baseline: MutationBaseline;
  mutants: MutantRecord[];
  /**
   * Killed ÷ total. How much of the report you should believe.
   *
   * Comparable only against other runs on the *same adapter*: blanking one
   * description out of eight skills and out of forty tools are not the same
   * operation, and averaging the two would invent a number (spec §11.7).
   */
  mutationScore: number;
  usage: TrialUsage;
  costUsd?: number;
  startedAt: string;
  durationMs: number;
}
