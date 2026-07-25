import pc from 'picocolors';
import { formatUsd } from '../provider/pricing.js';
import type { EvalReport, ScenarioScore } from '../types.js';

const BAR_WIDTH = 16;

/**
 * Human-readable eval report.
 *
 * Diagnostics are ranked above any headline number, deliberately (spec §6):
 * the moment someone optimises against a score they write descriptions that
 * game it. Confusion pairs and orphan tools tell you what to change; a total
 * only tells you whether to feel good.
 */
export function formatEvalReport(report: EvalReport): string {
  const out: string[] = [''];

  out.push(`${pc.bold('pickrate run')}  ${pc.dim(report.source.target)}`);
  // The model under test is part of the result — never bury it.
  out.push(`  ${pc.bold('model')}     ${report.model}`);
  if (report.source.serverInfo) {
    out.push(pc.dim(`  server    ${report.source.serverInfo.name} ${report.source.serverInfo.version}`));
  }
  out.push(
    pc.dim(
      `  trials    ${report.trials} × ${report.scenarios.length} scenario${report.scenarios.length === 1 ? '' : 's'}` +
        ` in ${(report.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  out.push(pc.dim(`  cost      ${formatCost(report)}`));
  out.push('');

  out.push(formatScenarioTable(report.scenarios));
  out.push('');

  const confusion = formatConfusion(report.scenarios);
  if (confusion) {
    out.push(confusion);
    out.push('');
  }

  const orphans = formatOrphans(report.orphanTools);
  if (orphans) {
    out.push(orphans);
    out.push('');
  }

  out.push(formatSummary(report));
  out.push('');

  return out.join('\n');
}

function formatScenarioTable(scenarios: ScenarioScore[]): string {
  const idWidth = Math.max(...scenarios.map((s) => s.id.length), 8);
  const lines: string[] = [];

  for (const scenario of scenarios) {
    const mark = scenario.passed ? pc.green('✓') : pc.red('✗');
    const pct = `${Math.round(scenario.score * 100)}%`.padStart(4);
    const paint = scenario.passed ? pc.green : scenario.flaky ? pc.yellow : pc.red;

    const notes: string[] = [];
    if (!scenario.passed) notes.push(pc.dim(`needs ${Math.round(scenario.threshold * 100)}%`));
    if (scenario.flaky) notes.push(pc.yellow('flaky'));
    if (scenario.restraint) notes.push(pc.dim('restraint'));
    if (scenario.errors > 0) notes.push(pc.dim(`${scenario.errors} errored`));

    lines.push(
      `  ${mark} ${scenario.id.padEnd(idWidth)}  ${paint(pct)}  ${bar(scenario.score, scenario.passed)}` +
        `  ${pc.dim(`${scenario.selection.passed}/${scenario.selection.total}`)}` +
        (notes.length > 0 ? `  ${notes.join(pc.dim(' · '))}` : ''),
    );

    // Only worth a line when selection and arguments actually disagree —
    // they're different bugs with different fixes.
    if (scenario.args && scenario.args.rate < 1) {
      lines.push(
        pc.dim(
          `    ${' '.repeat(idWidth)}  picked the right tool, wrong arguments ` +
            `${scenario.args.passed}/${scenario.args.total}`,
        ),
      );
    }
  }

  return lines.join('\n');
}

function formatConfusion(scenarios: ScenarioScore[]): string | undefined {
  const lines: string[] = [];

  for (const scenario of scenarios) {
    if (scenario.confusions.length === 0) continue;
    const expected = scenario.expected ?? 'nothing';
    for (const { tool, count } of scenario.confusions) {
      lines.push(
        `    ${scenario.id}  ${pc.dim('wanted')} ${expected} ${pc.dim('→ got')} ${tool ?? pc.dim('nothing')} ${pc.dim(`×${count}`)}`,
      );
    }
  }

  if (lines.length === 0) return undefined;
  return [pc.dim('  confusion'), ...lines].join('\n');
}

function formatOrphans(orphanTools: string[]): string | undefined {
  if (orphanTools.length === 0) return undefined;
  return [
    pc.dim('  orphan tools'),
    ...orphanTools.map((name) => `    ${pc.yellow('·')} ${name}`),
    pc.dim('    Never selected by any scenario — context you pay for on every call.'),
    pc.dim('    Only as good as your scenario coverage.'),
  ].join('\n');
}

function formatSummary(report: EvalReport): string {
  const failed = report.scenarios.filter((s) => !s.passed).length;
  const flaky = report.scenarios.filter((s) => s.flaky).length;

  const parts: string[] = [];
  parts.push(
    failed === 0
      ? pc.green(`all ${report.scenarios.length} scenarios met their threshold`)
      : pc.red(`${failed} of ${report.scenarios.length} scenarios below threshold`),
  );
  if (flaky > 0) parts.push(pc.yellow(`${flaky} in the 20–80% flakiness band`));

  return `  ${parts.join(pc.dim(' · '))}`;
}

function bar(score: number, passed: boolean): string {
  const filled = Math.round(score * BAR_WIDTH);
  const paint = passed ? pc.green : score > 0.2 ? pc.yellow : pc.red;
  return paint('█'.repeat(filled)) + pc.dim('░'.repeat(BAR_WIDTH - filled));
}

function formatCost(report: EvalReport): string {
  const { usage } = report;
  const tokens =
    `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out` +
    `, ${usage.cacheReadInputTokens.toLocaleString()} cached`;
  return report.costUsd === undefined
    ? `${tokens} ${pc.dim('(no price on file for this model)')}`
    : `~${formatUsd(report.costUsd)}  ${pc.dim(`(${tokens})`)}`;
}
