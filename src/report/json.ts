import { countBySeverity } from '../analyser/index.js';
import type { Analysis, EvalReport, MutationReport } from '../types.js';

/**
 * Bump when a shape below changes incompatibly. CI consumers pin on this.
 *
 * 2 as of the adapter split: `toolCount` became `itemCount`, `orphanTools`
 * became `orphans`, findings anchor to `item` rather than `tool`, confusion
 * entries name what was `selected` rather than a `tool`, `source` gained
 * `adapter`, and a run reports its `presentation`. All of that is a break, and
 * breaking it before M4's GitHub Action exists is far cheaper than after.
 *
 * M3's `mutate` output did not bump it: a new command is an addition, and no
 * consumer that pins on 2 for `inspect` or `run` can be broken by a shape it
 * has never seen.
 */
export const SCHEMA_VERSION = 2;

/** Machine-readable report. Stable shape — M4's CI integration reads this. */
export function formatAnalysisJson(analysis: Analysis): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'inspect',
      source: analysis.source,
      itemCount: analysis.itemCount,
      tokens: analysis.tokens,
      summary: countBySeverity(analysis.findings),
      findings: analysis.findings,
    },
    null,
    2,
  );
}

/** Machine-readable eval report. */
export function formatEvalReportJson(report: EvalReport): string {
  const failed = report.scenarios.filter((s) => !s.passed);

  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'run',
      source: report.source,
      model: report.model,
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
export function formatMutationReportJson(report: MutationReport): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'mutate',
      source: report.source,
      model: report.model,
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
    },
    null,
    2,
  );
}
