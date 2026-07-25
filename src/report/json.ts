import { countBySeverity } from '../analyser/index.js';
import type { Analysis, EvalReport } from '../types.js';

/**
 * Bump when a shape below changes incompatibly. CI consumers pin on this.
 *
 * Still 1 after adding `run`: an `inspect` consumer sees the same document it
 * always did, and a new command is an addition to the contract, not a break.
 */
export const SCHEMA_VERSION = 1;

/** Machine-readable report. Stable shape — M4's CI integration reads this. */
export function formatAnalysisJson(analysis: Analysis): string {
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      command: 'inspect',
      source: analysis.source,
      toolCount: analysis.toolCount,
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
      orphanTools: report.orphanTools,
      usage: report.usage,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
    },
    null,
    2,
  );
}
