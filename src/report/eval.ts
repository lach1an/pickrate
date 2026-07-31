import pc from 'picocolors';
import { formatUsd } from '../provider/pricing.js';
import { itemNoun } from '../surface.js';
import type { EvalReport, ReportDiff, ScenarioScore } from '../types.js';

const BAR_WIDTH = 16;

/**
 * Human-readable eval report.
 *
 * Diagnostics are ranked above any headline number, deliberately (spec §6):
 * the moment someone optimises against a score they write descriptions that
 * game it. Confusion pairs and orphan tools tell you what to change; a total
 * only tells you whether to feel good.
 */
export function formatEvalReport(report: EvalReport, diff?: ReportDiff): string {
  const out: string[] = [''];
  // "tool" is wrong on a skills run — the noun must match what was measured.
  const noun = itemNoun({ kind: report.source.adapter });

  out.push(`${pc.bold('pickrate run')}  ${pc.dim(report.source.target)}`);
  out.push(
    `  ${pc.bold('model')}     ${report.model}` +
      (report.requestedModel !== undefined ? pc.dim(`  (requested ${report.requestedModel})`) : ''),
  );
  // The unit of comparison is model + reasoning config + loading regime — all three, together.
  out.push(
    pc.dim(
      `  regime    ${report.provider}` +
        `, reasoning ${report.reasoning.mode === 'none' ? 'none' : (report.reasoning.effort ?? 'default')}` +
        // "eager"/"deferred", not the provider's feature name — this is a property of the measurement.
        `, ${report.toolSearch === 'on' ? 'deferred' : 'eager'} loading  ${report.regimeHash}`,
    ),
  );
  if (report.source.serverInfo) {
    out.push(pc.dim(`  server    ${report.source.serverInfo.name} ${report.source.serverInfo.version}`));
  }
  if (report.presentation !== undefined) {
    // Above the numbers because it qualifies them — a different presentation is a different measurement.
    out.push(pc.dim(`  surfaced  ${report.presentation}`));
  }
  out.push(
    pc.dim(
      `  trials    ${report.trials} × ${report.scenarios.length} scenario${report.scenarios.length === 1 ? '' : 's'}` +
        ` in ${(report.durationMs / 1000).toFixed(1)}s`,
    ),
  );
  out.push(pc.dim(`  cost      ${formatCost(report)}`));
  out.push('');

  out.push(formatScenarioTable(report.scenarios, noun));
  out.push('');

  if (diff) {
    // Above the confusion pairs and the summary — on a --baseline run, this is the finding.
    out.push(formatDiff(diff, noun));
    out.push('');
  }

  const confusion = formatConfusion(report.scenarios);
  if (confusion) {
    out.push(confusion);
    out.push('');
  }

  const orphans = formatOrphans(report.orphans, noun);
  if (orphans) {
    out.push(orphans);
    out.push('');
  }

  out.push(formatSummary(report));
  out.push('');

  return out.join('\n');
}

function formatScenarioTable(scenarios: ScenarioScore[], noun: string): string {
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
          `    ${' '.repeat(idWidth)}  picked the right ${noun}, wrong arguments ` +
            `${scenario.args.passed}/${scenario.args.total}`,
        ),
      );
    }
  }

  return lines.join('\n');
}

// Every moved scenario is listed, but only movement past the floor counts as a
// regression; the floor is printed next to the verdict.
export function formatDiff(diff: ReportDiff, noun: string): string {
  const moved = diff.scenarios.filter((scenario) => Math.abs(scenario.delta) > 0);
  const lines = [
    pc.dim('  vs baseline') +
      pc.dim(`  ${diff.baseline.path} · ${diff.baseline.model} · ${diff.baseline.startedAt}`),
  ];

  if (moved.length === 0) {
    lines.push(pc.dim('    every scenario landed where it did on the baseline'));
  } else {
    const width = Math.max(...moved.map((scenario) => scenario.id.length));
    for (const scenario of moved) {
      const size = `${Math.round(Math.abs(scenario.delta) * 100)}%`;
      const text = `${scenario.delta > 0 ? '+' : '−'}${size}`.padStart(5);
      const paint = scenario.regressed ? pc.red : scenario.delta > 0 ? pc.green : pc.dim;
      lines.push(
        `    ${scenario.id.padEnd(width)}  ${pc.dim(`${pct(scenario.baseline)} →`)} ${pct(scenario.head)}` +
          `  ${paint(text)}${scenario.regressed ? `  ${pc.red('regressed')}` : ''}`,
      );
    }
  }

  if (diff.newOrphans.length > 0) {
    lines.push(pc.dim(`    new orphan ${noun}: ${diff.newOrphans.join(', ')}`));
  }

  lines.push(
    pc.dim(`    Drops under ${pct(diff.floor)} are inside the noise and are not counted.`),
    pc.dim('    One run per side cannot measure noise; mutate can, or raise trials.'),
  );
  for (const warning of diff.warnings) lines.push(pc.yellow(`    ! ${warning}`));

  return lines.join('\n');
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatConfusion(scenarios: ScenarioScore[]): string | undefined {
  const lines: string[] = [];

  for (const scenario of scenarios) {
    if (scenario.confusions.length === 0) continue;
    const expected = scenario.expected ?? 'nothing';
    for (const { selected, count } of scenario.confusions) {
      lines.push(
        `    ${scenario.id}  ${pc.dim('wanted')} ${expected} ${pc.dim('→ got')} ${selected ?? pc.dim('nothing')} ${pc.dim(`×${count}`)}`,
      );
    }
  }

  if (lines.length === 0) return undefined;
  return [pc.dim('  confusion'), ...lines].join('\n');
}

function formatOrphans(orphans: string[], noun: string): string | undefined {
  if (orphans.length === 0) return undefined;
  return [
    pc.dim('  orphans'),
    ...orphans.map((name) => `    ${pc.yellow('·')} ${name}`),
    pc.dim(`    ${noun === 'skill' ? 'Skills' : 'Tools'} no scenario ever selected — context you pay for on every call.`),
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
  // Said only when the model has a cache at all: absent is "no such concept",
  // and printing "0 cached" for one of those describes a cache that never was.
  const tokens =
    `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out` +
    (usage.cacheReadInputTokens === undefined
      ? ''
      : `, ${usage.cacheReadInputTokens.toLocaleString()} cached`);
  return report.costUsd === undefined
    ? `${tokens} ${pc.dim('(no price on file for this model)')}`
    : `~${formatUsd(report.costUsd)}  ${pc.dim(`(${tokens})`)}`;
}
