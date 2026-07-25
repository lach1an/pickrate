import pc from 'picocolors';
import { countBySeverity } from '../analyser/index.js';
import type { Analysis, Finding, Severity } from '../types.js';

const MARK: Record<Severity, string> = { error: '✗', warn: '!', info: '·' };
const PAINT: Record<Severity, (s: string) => string> = {
  error: pc.red,
  warn: pc.yellow,
  info: pc.dim,
};

/** How many of the most expensive tools to itemise. */
const TOP_TOOLS = 8;

/** Human-readable report. Diagnostics first, headline number second. */
export function formatAnalysis(analysis: Analysis): string {
  const out: string[] = [];
  const { source, tokens, findings } = analysis;

  out.push('');
  out.push(`${pc.bold('pickrate inspect')}  ${pc.dim(source.target)}`);
  if (source.serverInfo) {
    out.push(pc.dim(`  server    ${source.serverInfo.name} ${source.serverInfo.version}`));
  }
  if (source.protocolVersion) {
    out.push(pc.dim(`  protocol  ${source.protocolVersion}`));
  }
  out.push(pc.dim(`  tools     ${analysis.toolCount}`));
  out.push(
    pc.dim(`  context   ~${tokens.total.toLocaleString()} tokens per session (${tokens.encoding}, approximate)`),
  );
  out.push('');

  out.push(formatFindings(findings));
  out.push('');
  out.push(formatCostTable(analysis));
  out.push('');
  out.push(formatSummary(analysis));
  out.push('');

  return out.join('\n');
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return pc.green('  No findings. Manifest looks clean.');

  // Findings arrive sorted by severity, so a rule with both warnings and info
  // findings would otherwise get two headings. Group by rule, ordered by the
  // most severe finding each rule produced.
  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = byRule.get(finding.rule);
    if (group) group.push(finding);
    else byRule.set(finding.rule, [finding]);
  }

  const lines: string[] = [];
  for (const [rule, group] of byRule) {
    if (lines.length > 0) lines.push('');
    lines.push(pc.dim(`  ${rule}`));
    for (const finding of group) {
      const paint = PAINT[finding.severity];
      lines.push(`    ${paint(MARK[finding.severity])} ${finding.message}`);
    }
  }

  return lines.join('\n');
}

function formatCostTable(analysis: Analysis): string {
  const { perTool } = analysis.tokens;
  if (perTool.length === 0) return pc.dim('  No tools exposed.');

  const shown = perTool.slice(0, TOP_TOOLS);
  const nameWidth = Math.max(...shown.map((t) => t.name.length), 4);
  const lines = [pc.dim(`  ${'tool'.padEnd(nameWidth)}   tokens   share`)];

  for (const tool of shown) {
    const share = `${(tool.share * 100).toFixed(1)}%`;
    lines.push(
      `  ${tool.name.padEnd(nameWidth)}  ${String(tool.tokens).padStart(6)}  ${share.padStart(6)}  ${bar(tool.share)}`,
    );
  }

  const rest = perTool.length - shown.length;
  if (rest > 0) {
    const restTokens = perTool.slice(TOP_TOOLS).reduce((sum, t) => sum + t.tokens, 0);
    lines.push(pc.dim(`  ${`+ ${rest} more`.padEnd(nameWidth)}  ${String(restTokens).padStart(6)}`));
  }

  return lines.join('\n');
}

function bar(share: number): string {
  const width = Math.max(1, Math.round(share * 20));
  return pc.dim('█'.repeat(width));
}

function formatSummary(analysis: Analysis): string {
  const counts = countBySeverity(analysis.findings);
  const parts = [
    counts.error > 0 ? pc.red(`${counts.error} error${counts.error === 1 ? '' : 's'}`) : null,
    counts.warn > 0 ? pc.yellow(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`) : null,
    counts.info > 0 ? pc.dim(`${counts.info} info`) : null,
  ].filter((part): part is string => part !== null);

  return `  ${parts.length === 0 ? pc.green('clean') : parts.join(pc.dim(' · '))}`;
}
