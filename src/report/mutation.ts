import pc from 'picocolors';
import { formatUsd } from '../provider/pricing.js';
import { itemNoun } from '../surface.js';
import type { MutantRecord, MutationReport } from '../types.js';

/**
 * Human-readable mutation report.
 *
 * Same discipline as the eval report, for the same reason (spec §6): what to do
 * about it goes above the number. Here that means every mutant's verdict and
 * what it damaged is printed before the mutation score, because a survivor is
 * only interpretable next to its targets — "nothing tested this" and "the
 * harness is blind to this" look identical from the score alone.
 */
export function formatMutationReport(report: MutationReport): string {
  const out: string[] = [''];
  const noun = itemNoun({ kind: report.source.adapter }, true);

  out.push(`${pc.bold('pickrate mutate')}  ${pc.dim(report.source.target)}`);
  out.push(`  ${pc.bold('model')}     ${report.model}`);
  if (report.presentation !== undefined) {
    out.push(pc.dim(`  surfaced  ${report.presentation}`));
  }
  out.push(
    `  ${pc.bold('baseline')}  ${pct(report.baseline.score)}` +
      pc.dim(
        `  from ${report.baseline.runs.length} clean runs of ${report.trials} trials` +
          ` · noise floor ${pct(report.baseline.noise)}`,
      ),
  );
  if (report.baseline.observedNoise === 0) {
    // Two runs that agree exactly usually mean a deterministic provider, not a
    // stable server. Worth saying, because the floor is doing all the work.
    out.push(
      pc.dim(`            the two clean runs agreed exactly — the floor is holding the bar up`),
    );
  }
  out.push(pc.dim(`  cost      ${formatCost(report)}`));
  out.push('');

  out.push(formatMutants(report));
  out.push('');

  const survivors = report.mutants.filter((mutant) => !mutant.killed);
  if (survivors.length > 0) {
    out.push(formatSurvivors(survivors, noun));
    out.push('');
  }

  out.push(formatScore(report));
  out.push('');

  return out.join('\n');
}

function formatMutants(report: MutationReport): string {
  const width = Math.max(...report.mutants.map((m) => m.id.length), 8);

  return report.mutants
    .map((mutant) => {
      const mark = mutant.killed ? pc.green('✓') : pc.yellow('·');
      const verdict = mutant.killed ? pc.green('detected') : pc.yellow('survived');
      const notes: string[] = [];
      if (mutant.restraintOnly) notes.push(pc.yellow('restraint only'));

      return (
        `  ${mark} ${mutant.id.padEnd(width)}  ${delta(mutant)}  ${verdict}` +
        (notes.length > 0 ? `  ${notes.join(pc.dim(' · '))}` : '') +
        `\n    ${' '.repeat(width)}  ${pc.dim(mutant.describe)}`
      );
    })
    .join('\n');
}

function formatSurvivors(survivors: MutantRecord[], noun: string): string {
  const lines = [pc.dim('  survivors')];

  for (const mutant of survivors) {
    const what =
      mutant.targets.length > 0 ? `damaged ${mutant.targets.join(', ')}` : 'changed the whole surface';
    lines.push(`    ${pc.yellow('·')} ${mutant.id} ${pc.dim(`— ${what}`)}`);
  }

  lines.push(
    pc.dim('    A survivor is inconclusive, not a pass. Either no scenario exercises'),
    pc.dim(`    the affected ${noun}, or the harness cannot see the damage. Check coverage first.`),
  );
  return lines.join('\n');
}

function formatScore(report: MutationReport): string {
  const killed = report.mutants.filter((m) => m.killed).length;
  const paint = report.mutationScore >= 0.8 ? pc.green : report.mutationScore >= 0.5 ? pc.yellow : pc.red;

  return [
    `  ${pc.bold('mutation score')}  ${paint(pct(report.mutationScore))}` +
      pc.dim(`  ${killed} of ${report.mutants.length} injected defects detected`),
    // Spec §11.7: blanking one description out of eight skills and out of forty
    // tools are not the same operation. Averaging them would invent a number.
    pc.dim(`  Comparable only against other ${report.source.adapter} runs, never averaged across adapters.`),
  ].join('\n');
}

/** Signed and painted: a mutant that *improved* the score is worth seeing. */
function delta(mutant: MutantRecord): string {
  const size = pct(Math.abs(mutant.delta));
  // "−0%" would imply a drop too small to see. No movement is no movement.
  const text = (size === '0%' ? size : `${mutant.delta > 0 ? '−' : '+'}${size}`).padStart(6);

  if (mutant.killed) return pc.green(text);
  return mutant.delta <= 0 ? pc.dim(text) : pc.yellow(text);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatCost(report: MutationReport): string {
  const runs = report.baseline.runs.length + report.mutants.length;
  const { usage } = report;
  // See `formatCost` in report/eval.ts: absent means the model has no cache,
  // which is not the same statement as "nothing was cached".
  const tokens =
    `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out` +
    (usage.cacheReadInputTokens === undefined
      ? ''
      : `, ${usage.cacheReadInputTokens.toLocaleString()} cached`) +
    `, over ${runs} runs`;

  return report.costUsd === undefined
    ? `${tokens} ${pc.dim('(no price on file for this model)')}`
    : `~${formatUsd(report.costUsd)}  ${pc.dim(`(${tokens})`)}`;
}
