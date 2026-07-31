import type { Analysis, Finding, Severity, Surface } from '../types.js';
import { rules, rulesById } from './rules/index.js';
import { countSurfaceTokens } from './tokens.js';

export { rules, rulesById } from './rules/index.js';
export {
  countSurfaceTokens,
  countItemTokens,
  countToolTokens,
  countSkillRoutingTokens,
  countSkillBodyTokens,
  ENCODING,
} from './tokens.js';
export { walkProperties, maxDepth } from './schema.js';

export interface AnalyseOptions {
  /** Rule ids to skip. */
  disable?: string[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** Run every applicable static rule over a surface. Sub-second, offline, no cost. */
export function analyse(surface: Surface, options: AnalyseOptions = {}): Analysis {
  const disabled = new Set(options.disable ?? []);
  const findings: Finding[] = [];

  for (const rule of rules) {
    if (disabled.has(rule.id)) continue;
    // Skipped rather than run against an empty narrowing — "no findings" must stay meaningful.
    if (!rule.appliesTo.includes(surface.kind)) continue;
    findings.push(...rule.run(surface));
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      (a.item ?? '').localeCompare(b.item ?? ''),
  );

  return {
    source: surface.source,
    itemCount: surface.items.length,
    tokens: countSurfaceTokens(surface),
    findings,
  };
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}
