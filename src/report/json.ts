import { countBySeverity } from '../analyser/index.js';
import type { Analysis, EvalReport, GateResult, MutationReport, ReportDiff } from '../types.js';

/**
 * CI results attached to a report at print time.
 *
 * Additive — a consumer pinned on a version ignores keys it has never seen.
 * They are a parameter rather than fields on `EvalReport`
 * because a gate verdict is not a measurement: the same run judged against two
 * configs is one measurement and two verdicts, and only one of those belongs
 * in a stored baseline.
 */
export interface CiExtras {
  gates?: GateResult[];
  diff?: ReportDiff;
}

/**
 * Bump when a shape below changes incompatibly. CI consumers pin on this.
 *
 * 3 as of multi-provider support, and it absorbed every break at once:
 * `TrialUsage`'s cache fields became optional (absent means the model has no
 * such concept, not that it was zero), `model` became the id the API said
 * actually ran rather than the id requested, and a run now carries the rest of
 * its provenance — `provider`, `reasoning`, `toolSearch`, `regimeHash` — as
 * required fields rather than optional ones.
 *
 * Taken in one go deliberately. Version 2 shipped in `0.1.0` and nothing pins
 * it: `schemaVersion` appears nowhere in `action.yml`, the workflows or the
 * README, and no consumer reads the field. That window closes, and anything
 * deferred past it costs a second bump — so the three-valued
 * absent/equal/different tolerance these fields would otherwise have needed
 * does not exist. They are required, and a baseline missing them is refused.
 *
 * (2 was the adapter split; M3's `mutate` output did not bump it, because a
 * new command is an addition.)
 */
export const SCHEMA_VERSION = 3;

/** Machine-readable report. Stable shape — M4's CI integration reads this. */
export function formatAnalysisJson(analysis: Analysis, extras: CiExtras = {}): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'inspect',
      source: analysis.source,
      itemCount: analysis.itemCount,
      tokens: analysis.tokens,
      summary: countBySeverity(analysis.findings),
      findings: analysis.findings,
      ...(extras.gates ? { gates: extras.gates } : {}),
    },
    null,
    2,
  );
}

/** Machine-readable eval report. */
export function formatEvalReportJson(report: EvalReport, extras: CiExtras = {}): string {
  const failed = report.scenarios.filter((s) => !s.passed);

  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'run',
      source: report.source,
      model: report.model,
      ...(report.requestedModel !== undefined ? { requestedModel: report.requestedModel } : {}),
      provider: report.provider,
      reasoning: report.reasoning,
      toolSearch: report.toolSearch,
      regimeHash: report.regimeHash,
      ...(report.presentation !== undefined ? { presentation: report.presentation } : {}),
      trials: report.trials,
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      summary: {
        scenarios: report.scenarios.length,
        failed: failed.length,
        flaky: report.scenarios.filter((s) => s.flaky).length,
        errored: report.scenarios.reduce((sum, s) => sum + s.errors, 0),
      },
      scenarios: report.scenarios,
      orphans: report.orphans,
      usage: report.usage,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
      ...(extras.gates ? { gates: extras.gates } : {}),
      ...(extras.diff ? { diff: extras.diff } : {}),
    },
    null,
    2,
  );
}

/**
 * Machine-readable mutation report.
 *
 * Each mutant carries its whole run, not just its score. That is the expensive
 * choice and the right one: the score says how much to trust the harness, and
 * the confusion pairs underneath say why — a consumer that only got the number
 * could never tell a survivor with no coverage from a survivor the harness is
 * blind to.
 */
export function formatMutationReportJson(report: MutationReport, extras: CiExtras = {}): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'mutate',
      source: report.source,
      model: report.model,
      ...(report.requestedModel !== undefined ? { requestedModel: report.requestedModel } : {}),
      provider: report.provider,
      reasoning: report.reasoning,
      toolSearch: report.toolSearch,
      regimeHash: report.regimeHash,
      ...(report.presentation !== undefined ? { presentation: report.presentation } : {}),
      trials: report.trials,
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      summary: {
        mutants: report.mutants.length,
        killed: report.mutants.filter((m) => m.killed).length,
        survived: report.mutants.filter((m) => !m.killed).length,
        mutationScore: report.mutationScore,
      },
      baseline: report.baseline,
      mutants: report.mutants,
      usage: report.usage,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
      ...(extras.gates ? { gates: extras.gates } : {}),
    },
    null,
    2,
  );
}
