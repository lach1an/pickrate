import { countBySeverity } from '../analyser/index.js';
import { formatUsd } from '../provider/pricing.js';
import { itemNoun } from '../surface.js';
import type {
  Analysis,
  EvalReport,
  GateResult,
  MutationReport,
  ReportDiff,
  ScenarioScore,
  SurfaceSource,
} from '../types.js';

/**
 * A third formatter, not a colour-stripped table.
 *
 * GitHub renders tables, and a step summary or PR comment wants one — but it
 * wants the same ordering the terminal report uses, with diagnostics above the
 * headline number (spec §6). Nothing here talks to GitHub; it emits markdown
 * and the Action decides where to put it.
 */

/**
 * Marker for find-and-edit PR comments.
 *
 * Invisible when rendered, and stable, so a 30-commit PR carries one comment
 * that gets updated rather than thirty that get scrolled past.
 */
export const COMMENT_MARKER = '<!-- pickrate-report -->';

export function formatAnalysisMarkdown(analysis: Analysis, gates: GateResult[] = []): string {
  const noun = itemNoun({ kind: analysis.source.adapter }, true);
  const counts = countBySeverity(analysis.findings);
  const out: string[] = [COMMENT_MARKER, '', '## pickrate inspect', ''];

  out.push(...sourceTable(analysis.source, [
    [noun, String(analysis.itemCount)],
    ['resident context', `~${analysis.tokens.total.toLocaleString()} tokens (${analysis.tokens.encoding}, approximate)`],
    // Below the resident figure and labelled with its condition, exactly as in
    // the terminal report: this number is large and harmless, the one above it
    // is small and is not.
    ...(analysis.tokens.deferred !== undefined
      ? ([['skill bodies', `~${analysis.tokens.deferred.toLocaleString()} tokens, paid only when a skill triggers`]] as Array<[string, string]>)
      : []),
  ]));

  out.push('', '### Findings', '');
  if (analysis.findings.length === 0) {
    out.push('No findings. Looks clean.');
  } else {
    out.push('| | rule | item | message |', '| --- | --- | --- | --- |');
    for (const finding of analysis.findings) {
      out.push(
        `| ${severityMark(finding.severity)} | \`${finding.rule}\` | ${finding.item ? `\`${finding.item}\`` : ''} | ${escape(finding.message)} |`,
      );
    }
  }

  const costly = analysis.tokens.perItem.slice(0, 8);
  if (costly.length > 0) {
    out.push('', '<details><summary>Token cost by ' + itemNoun({ kind: analysis.source.adapter }) + '</summary>', '');
    out.push(`| ${itemNoun({ kind: analysis.source.adapter })} | tokens | share |`, '| --- | ---: | ---: |');
    for (const item of costly) {
      out.push(`| \`${item.name}\` | ${item.tokens.toLocaleString()} | ${(item.share * 100).toFixed(1)}% |`);
    }
    out.push('', '</details>');
  }

  out.push('', summaryLine([
    counts.error > 0 ? `**${counts.error} error${counts.error === 1 ? '' : 's'}**` : null,
    counts.warn > 0 ? `${counts.warn} warning${counts.warn === 1 ? '' : 's'}` : null,
    counts.info > 0 ? `${counts.info} info` : null,
  ], 'clean'));

  out.push(...gateSection(gates));
  return out.join('\n');
}

export function formatEvalMarkdown(
  report: EvalReport,
  gates: GateResult[] = [],
  diff?: ReportDiff,
): string {
  const noun = itemNoun({ kind: report.source.adapter }, true);
  const one = itemNoun({ kind: report.source.adapter });
  const out: string[] = [COMMENT_MARKER, '', '## pickrate run', ''];

  out.push(...sourceTable(report.source, [
    ['model', `\`${report.model}\``],
    // Above the numbers, because it qualifies them: the same skills under a
    // different presentation are a different measurement, not a better one.
    ...(report.presentation !== undefined
      ? ([['surfaced', `\`${report.presentation}\``]] as Array<[string, string]>)
      : []),
    ['trials', `${report.trials} × ${report.scenarios.length} scenario${report.scenarios.length === 1 ? '' : 's'}`],
    ['cost', cost(report.costUsd)],
  ]));

  out.push('', '### Scenarios', '');
  out.push('| | scenario | score | threshold | trials | notes |', '| --- | --- | ---: | ---: | ---: | --- |');
  for (const scenario of report.scenarios) {
    out.push(
      `| ${scenario.passed ? '✅' : '❌'} | \`${scenario.id}\` | ${pct(scenario.score)} | ${pct(scenario.threshold)} |` +
        ` ${scenario.selection.passed}/${scenario.selection.total} | ${notesFor(scenario, one)} |`,
    );
  }

  if (diff) out.push('', ...diffSection(diff, noun));

  // Diagnostics before the summary, deliberately: whoever optimises the number
  // will write descriptions that game it, so what to fix outranks how you did.
  const confusion = report.scenarios.flatMap((scenario) =>
    scenario.confusions.map(
      ({ selected, count }) =>
        `| \`${scenario.id}\` | ${scenario.expected === null ? '*nothing*' : `\`${scenario.expected}\``} |` +
        ` ${selected === null ? '*nothing*' : `\`${selected}\``} | ${count} |`,
    ),
  );
  if (confusion.length > 0) {
    out.push('', '### Confusion', '', '| scenario | wanted | got | × |', '| --- | --- | --- | ---: |', ...confusion);
  }

  if (report.orphans.length > 0) {
    out.push(
      '',
      '### Orphans',
      '',
      report.orphans.map((name) => `\`${name}\``).join(', '),
      '',
      `${capitalise(noun)} no scenario ever selected — context you pay for on every call.`,
      'Only as good as your scenario coverage.',
    );
  }

  const failed = report.scenarios.filter((scenario) => !scenario.passed).length;
  const flaky = report.scenarios.filter((scenario) => scenario.flaky).length;
  out.push('', summaryLine([
    failed === 0
      ? `all ${report.scenarios.length} scenarios met their threshold`
      : `**${failed} of ${report.scenarios.length} scenarios below threshold**`,
    flaky > 0 ? `${flaky} in the 20–80% flakiness band` : null,
  ]));

  out.push(...gateSection(gates));
  return out.join('\n');
}

export function formatMutationMarkdown(report: MutationReport, gates: GateResult[] = []): string {
  const noun = itemNoun({ kind: report.source.adapter }, true);
  const out: string[] = [COMMENT_MARKER, '', '## pickrate mutate', ''];

  out.push(...sourceTable(report.source, [
    ['model', `\`${report.model}\``],
    ...(report.presentation !== undefined
      ? ([['surfaced', `\`${report.presentation}\``]] as Array<[string, string]>)
      : []),
    [
      'baseline',
      `${pct(report.baseline.score)} from ${report.baseline.runs.length} clean runs of ${report.trials} trials` +
        ` · noise floor ${pct(report.baseline.noise)}`,
    ],
    ['cost', cost(report.costUsd)],
  ]));

  if (report.baseline.observedNoise === 0) {
    out.push('', 'The two clean runs agreed exactly — the floor is holding the bar up on its own.');
  }

  out.push('', '### Mutants', '', '| | mutant | Δ | verdict | defect |', '| --- | --- | ---: | --- | --- |');
  for (const mutant of report.mutants) {
    const size = pct(Math.abs(mutant.delta));
    const signed = size === '0%' ? size : `${mutant.delta > 0 ? '−' : '+'}${size}`;
    out.push(
      `| ${mutant.killed ? '✅' : '⚠️'} | \`${mutant.id}\` | ${signed} |` +
        ` ${mutant.killed ? 'detected' : 'survived'}${mutant.restraintOnly ? ' (restraint only)' : ''} |` +
        ` ${escape(mutant.describe)} |`,
    );
  }

  const survivors = report.mutants.filter((mutant) => !mutant.killed);
  if (survivors.length > 0) {
    out.push('', '### Survivors', '');
    for (const mutant of survivors) {
      const what =
        mutant.targets.length > 0
          ? `damaged ${mutant.targets.map((target) => `\`${target}\``).join(', ')}`
          : 'changed the whole surface';
      out.push(`- \`${mutant.id}\` — ${what}`);
    }
    out.push(
      '',
      'A survivor is inconclusive, not a pass. Either no scenario exercises the affected',
      `${noun}, or the harness cannot see the damage. Check coverage first.`,
    );
  }

  const killed = report.mutants.filter((mutant) => mutant.killed).length;
  out.push(
    '',
    `**Mutation score ${pct(report.mutationScore)}** — ${killed} of ${report.mutants.length} injected defects detected.`,
    '',
    // Spec §11.7: blanking one description out of eight skills and out of forty
    // tools are not the same operation. Averaging them would invent a number.
    `Comparable only against other ${report.source.adapter} runs, never averaged across adapters.`,
  );

  out.push(...gateSection(gates));
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */

function diffSection(diff: ReportDiff, noun: string): string[] {
  const moved = diff.scenarios.filter((scenario) => Math.abs(scenario.delta) > 0);
  const out = ['### Against baseline', ''];

  out.push(
    `\`${diff.baseline.path}\` · \`${diff.baseline.model}\` · ${diff.baseline.startedAt}`,
    '',
    `Drops smaller than **${pct(diff.floor)}** are inside the noise and are not counted.`,
    '',
  );

  if (moved.length === 0) {
    out.push('Every scenario landed where it did on the baseline.');
  } else {
    out.push('| scenario | baseline | head | Δ | |', '| --- | ---: | ---: | ---: | --- |');
    for (const scenario of moved) {
      const sign = scenario.delta > 0 ? '+' : '−';
      out.push(
        `| \`${scenario.id}\` | ${pct(scenario.baseline)} | ${pct(scenario.head)} |` +
          ` ${sign}${pct(Math.abs(scenario.delta))} | ${scenario.regressed ? '**regressed**' : ''} |`,
      );
    }
  }

  if (diff.newFailures.length > 0) {
    out.push('', `New failures: ${diff.newFailures.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (diff.fixed.length > 0) {
    out.push('', `Fixed: ${diff.fixed.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (diff.newOrphans.length > 0) {
    out.push('', `New orphan ${noun}: ${diff.newOrphans.map((id) => `\`${id}\``).join(', ')}`);
  }
  for (const warning of diff.warnings) out.push('', `> ⚠️ ${warning}`);

  return out;
}

function gateSection(gates: GateResult[]): string[] {
  if (gates.length === 0) return [];

  const out = ['', '### Gates', '', '| | gate | result |', '| --- | --- | --- |'];
  for (const gate of gates) {
    const mark = gate.passed ? '✅' : gate.unmeasured === true ? '❓' : '❌';
    out.push(`| ${mark} | \`${gate.id}\` | ${escape(gate.message)} |`);
  }

  if (gates.some((gate) => !gate.passed && gate.unmeasured === true)) {
    out.push(
      '',
      '> **Unmeasured.** Too little of this run completed for the numbers above to mean anything.',
      '> This is not a failing eval — check the target before the surface.',
    );
  }
  return out;
}

function sourceTable(source: SurfaceSource, rows: Array<[string, string]>): string[] {
  const all: Array<[string, string]> = [
    ['target', `\`${source.target}\``],
    ...(source.serverInfo ? ([['server', `${source.serverInfo.name} ${source.serverInfo.version}`]] as Array<[string, string]>) : []),
    ...rows,
  ];
  return ['| | |', '| --- | --- |', ...all.map(([key, value]) => `| ${key} | ${value} |`)];
}

/** `noun` is singular — "picked the right skill" on a skills run. */
function notesFor(scenario: ScenarioScore, noun: string): string {
  const notes: string[] = [];
  if (scenario.flaky) notes.push('flaky');
  if (scenario.restraint) notes.push('restraint');
  if (scenario.args && scenario.args.rate < 1) {
    // Selection and arguments are different bugs with different fixes, so this
    // is only worth a note when the two actually disagree.
    notes.push(`right ${noun}, wrong arguments ${scenario.args.passed}/${scenario.args.total}`);
  }
  if (scenario.errors > 0) notes.push(`${scenario.errors} errored`);
  return notes.join(' · ');
}

function summaryLine(parts: Array<string | null>, fallback = ''): string {
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? fallback : kept.join(' · ');
}

function severityMark(severity: string): string {
  return severity === 'error' ? '❌' : severity === 'warn' ? '⚠️' : 'ℹ️';
}

function cost(costUsd: number | undefined): string {
  return costUsd === undefined ? '*no price on file for this model*' : `~${formatUsd(costUsd)}`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Pipes would break the table they land in; everything else renders fine. */
function escape(text: string): string {
  return text.replace(/\|/g, '\\|');
}
