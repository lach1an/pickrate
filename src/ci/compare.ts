import { minNoise } from '../mutator/index.js';
import { BaselineError, type StoredReport } from './report-file.js';
import type { EvalReport, ReportDiff } from '../types.js';

/**
 * Compare a run against a stored one.
 *
 * This is the piece with the value in it — nobody buys "your server scores
 * 87/100", they buy "this PR dropped selection from 94% to 71%" (spec §6). Two
 * rules make it honest rather than merely dramatic, and neither is optional:
 *
 *  - **A diff between two single runs is not a noise measurement.** `mutate`
 *    measures its floor by running the clean surface twice; this has one run
 *    per side and cannot. So the tolerance is floored at `minNoise(trials)`,
 *    imported rather than reimplemented, and the report says in words where an
 *    honest floor comes from.
 *  - **A mismatched baseline is refused, not projected.** Same discipline as
 *    `ReplayProvider` refusing a foreign presentation mode: a comparison across
 *    models is a number that looks like a regression and is a model swap.
 */

export interface CompareOptions {
  /** From `ci.maxRegression`. The floor still wins when it is larger. */
  maxRegression?: number;
}

export function diffReports(
  baseline: StoredReport,
  head: EvalReport,
  options: CompareOptions = {},
): ReportDiff {
  refuseMismatch(baseline, head);

  const floor = Math.max(options.maxRegression ?? 0, minNoise(scoredTrials(head)));
  const before = new Map(baseline.scenarios.map((scenario) => [scenario.id, scenario]));

  const scenarios = head.scenarios.map((scenario) => {
    const previous = before.get(scenario.id)!;
    const delta = scenario.score - previous.score;
    return {
      id: scenario.id,
      baseline: previous.score,
      head: scenario.score,
      delta,
      // Strictly past the floor. A drop of exactly one trial's worth is what
      // the floor exists to absorb.
      regressed: -delta > floor,
    };
  });

  const meanDelta =
    scenarios.length === 0
      ? 0
      : scenarios.reduce((sum, scenario) => sum + scenario.delta, 0) / scenarios.length;

  const orphans = new Set(baseline.orphans);

  return {
    baseline: { model: baseline.model, startedAt: baseline.startedAt, path: baseline.path },
    floor,
    scenarios,
    meanDelta,
    newFailures: head.scenarios
      .filter((scenario) => !scenario.passed && before.get(scenario.id)?.passed === true)
      .map((scenario) => scenario.id),
    fixed: head.scenarios
      .filter((scenario) => scenario.passed && before.get(scenario.id)?.passed === false)
      .map((scenario) => scenario.id),
    newOrphans: head.orphans.filter((name) => !orphans.has(name)),
    warnings: warningsFor(baseline, head),
  };
}

/**
 * Refuse anything that would make the two sides incomparable.
 *
 * Every one of these produces a plausible-looking delta if you let it through,
 * and a plausible-looking delta is worse than an error: it gets acted on.
 */
function refuseMismatch(baseline: StoredReport, head: EvalReport): void {
  if (baseline.adapter !== head.source.adapter) {
    throw new BaselineError(
      `${baseline.path} measured a ${baseline.adapter} surface and this run measured ${head.source.adapter}. ` +
        'Those are different measurements, not two points on one line.',
    );
  }
  if (baseline.model !== head.model) {
    throw new BaselineError(
      `${baseline.path} was recorded against ${baseline.model} and this run used ${head.model}. ` +
        'A comparison across models is a number that looks like a regression and is a model swap.',
    );
  }
  if ((baseline.presentation ?? null) !== (head.presentation ?? null)) {
    throw new BaselineError(
      `${baseline.path} was recorded under presentation ${baseline.presentation ?? 'none'} and this run used ` +
        `${head.presentation ?? 'none'}. Scores from two presentations are not comparable as scores.`,
    );
  }

  const before = new Set(baseline.scenarios.map((scenario) => scenario.id));
  const now = new Set(head.scenarios.map((scenario) => scenario.id));
  const added = [...now].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !now.has(id));

  if (added.length > 0 || removed.length > 0) {
    throw new BaselineError(
      `${baseline.path} covers a different set of scenarios than this run` +
        (added.length > 0 ? ` (added: ${added.join(', ')})` : '') +
        (removed.length > 0 ? ` (missing: ${removed.join(', ')})` : '') +
        '. Re-record the baseline after changing the scenarios.',
    );
  }
}

/**
 * The instrument drifts, which no comparable tool has to handle.
 *
 * Codecov's baseline goes stale but the compiler is pinned. Here the model id
 * can be an *alias* the provider re-points underneath a stored baseline, so a
 * two-week-old comparison silently mixes a description change with a model
 * update. The mismatch check above only bites when the config pins a dated
 * snapshot — so when it does not, say so.
 */
function warningsFor(baseline: StoredReport, head: EvalReport): string[] {
  const warnings: string[] = [];

  if (!isDatedSnapshot(baseline.model)) {
    warnings.push(
      `"${baseline.model}" is a model alias, not a dated snapshot. It can be re-pointed underneath a ` +
        'stored baseline, so part of any change here may be a model update rather than a surface change. ' +
        'Pin a dated id in any config used for comparison.',
    );
  }

  if (staleDays(baseline.startedAt) > STALE_DAYS) {
    warnings.push(
      `The baseline is ${staleDays(baseline.startedAt)} days old. Refresh it on the default branch — ` +
        'staleness accumulates into one large unexplained gap.',
    );
  }

  if (head.scenarios.some((scenario) => scenario.errors > 0)) {
    warnings.push('Some trials in this run errored, so both sides are not measured over the same sample.');
  }

  return warnings;
}

/** How old a baseline may be before the drift is worth a line in the report. */
export const STALE_DAYS = 30;

/** `claude-haiku-4-5-20251001` is pinned; `claude-haiku-4-5` is not. */
export function isDatedSnapshot(model: string): boolean {
  return /-\d{8}$/.test(model);
}

function staleDays(startedAt: string): number {
  const then = Date.parse(startedAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * Trials the noise floor is derived from: the smallest *scored* count across
 * scenarios.
 *
 * Scored rather than attempted, and the smallest rather than the total, for the
 * same reason `trialsPerRun` does it — the floor models one trial flipping, and
 * it flips soonest in the scenario with the fewest trials behind it.
 */
function scoredTrials(report: EvalReport): number {
  const counts = report.scenarios
    .map((scenario) => scenario.selection.total)
    .filter((total) => total > 0);
  return counts.length === 0 ? 0 : Math.min(...counts);
}
