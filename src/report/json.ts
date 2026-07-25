import { countBySeverity } from '../analyser/index.js';
import type { Analysis, EvalReport } from '../types.js';

/**
 * Bump when a shape below changes incompatibly. CI consumers pin on this.
 *
 * 2 as of the adapter split: `toolCount` became `itemCount`, `orphanTools`
 * became `orphans`, findings anchor to `item` rather than `tool`, and `source`
 * gained `adapter`. All of that is a break, and breaking it before M4's
 * GitHub Action exists is far cheaper than after.
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
