import type { Analysis, Finding, Manifest, Severity } from '../types.js';
import { rules, rulesById } from './rules/index.js';
import { countManifestTokens } from './tokens.js';

export { rules, rulesById } from './rules/index.js';
export { countManifestTokens, countToolTokens, ENCODING } from './tokens.js';
export { walkProperties, maxDepth } from './schema.js';

export interface AnalyseOptions {
  /** Rule ids to skip. */
  disable?: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** Run every static rule over a manifest. Sub-second, offline, no cost. */
export function analyse(manifest: Manifest, options: AnalyseOptions = {}): Analysis {
  const disabled = new Set(options.disable ?? []);
  const findings: Finding[] = [];

  for (const rule of rules) {
    if (disabled.has(rule.id)) continue;
    findings.push(...rule.run(manifest));
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      (a.tool ?? '').localeCompare(b.tool ?? ''),
  );

  return {
    source: manifest.source,
    toolCount: manifest.tools.length,
    tokens: countManifestTokens(manifest),
    findings,
  };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}
