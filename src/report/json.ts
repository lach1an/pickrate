import { countBySeverity } from '../analyser/index.js';
import type { Analysis } from '../types.js';

/** Bump when the shape below changes incompatibly. CI consumers pin on this. */
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
