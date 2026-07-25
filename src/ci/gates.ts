import { countBySeverity } from '../analyser/index.js';
import { Exit, type ExitCode } from '../exit.js';
import { itemNoun } from '../surface.js';
import type {
  Analysis,
  CiGates,
  EvalReport,
  GateResult,
  MutationReport,
  ReportDiff,
  Severity,
} from '../types.js';

/**
 * The gate engine. Pure in the analyser's sense: reports in, verdicts out, no
 * I/O and no model — which is what lets every gate be tested against the replay
 * fixtures with no key and no spend.
 *
 * Nothing here decides anything on its own. `evaluate*` produces the list,
 * `exitCodeFor` turns the list into the one number CI reads, and the two are
 * separate because the interesting rule lives in the second: an *unmeasured*
 * breach outranks a failed one.
 */

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warn: 2, info: 1 };

/** `inspect` gates: findings severity and the resident token budget. */
export function evaluateAnalysisGates(analysis: Analysis, gates: CiGates): GateResult[] {
  const results: GateResult[] = [];

  const failOn = gates.failOn ?? null;
  if (failOn !== null) {
    const counts = countBySeverity(analysis.findings);
    const observed = analysis.findings.filter(
      (finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[failOn],
    ).length;
    results.push({
      id: 'fail-on',
      limit: failOn,
      observed,
      passed: observed === 0,
      message:
        observed === 0
          ? `no findings at or above ${failOn}`
          : `${observed} finding${observed === 1 ? '' : 's'} at or above ${failOn}` +
            ` (${counts.error} error, ${counts.warn} warn, ${counts.info} info)`,
    });
  }

  if (gates.maxTokens !== undefined) {
    const observed = analysis.tokens.total;
    results.push({
      id: 'max-tokens',
      limit: gates.maxTokens,
      observed,
      passed: observed <= gates.maxTokens,
      // Deliberately silent about `tokens.deferred`: the budget is what you pay
      // on every request, and folding skill bodies into it would make a surface
      // that costs nothing until it fires look like the expensive one.
      message: `~${observed.toLocaleString()} resident tokens against a budget of ${gates.maxTokens.toLocaleString()}`,
    });
  }

  return results;
}

/**
 * `run` gates.
 *
 * `maxErrorRate` is evaluated first and flagged `unmeasured`, because it is the
 * gate that says the other numbers are not worth reading.
 */
export function evaluateRunGates(
  report: EvalReport,
  gates: CiGates,
  diff?: ReportDiff,
): GateResult[] {
  const results: GateResult[] = [];
  const noun = itemNoun({ kind: report.source.adapter }, true);

  const { errors, total } = trialCounts(report);
  const rate = total === 0 ? 1 : errors / total;
  results.push({
    id: 'max-error-rate',
    limit: gates.maxErrorRate,
    observed: round(rate),
    passed: rate <= gates.maxErrorRate,
    // Not a bad answer — no answer. Errored trials leave the denominator, so
    // past this rate the pass rates above are a confident report from whichever
    // handful of trials happened to survive.
    unmeasured: true,
    message:
      total === 0
        ? 'no trials ran'
        : `${errors} of ${total} trials errored (${pct(rate)}), limit ${pct(gates.maxErrorRate)}`,
  });

  if (gates.maxFlaky !== undefined) {
    const flaky = report.scenarios.filter((scenario) => scenario.flaky);
    results.push({
      id: 'max-flaky',
      limit: gates.maxFlaky,
      observed: flaky.length,
      passed: flaky.length <= gates.maxFlaky,
      message:
        flaky.length === 0
          ? 'no scenarios in the 20–80% band'
          : `${flaky.length} scenario${flaky.length === 1 ? '' : 's'} in the 20–80% band` +
            ` (${flaky.map((scenario) => scenario.id).join(', ')})`,
    });
  }

  if (gates.maxOrphans !== undefined) {
    results.push({
      id: 'max-orphans',
      limit: gates.maxOrphans,
      observed: report.orphans.length,
      passed: report.orphans.length <= gates.maxOrphans,
      message:
        report.orphans.length === 0
          ? `every ${itemNoun({ kind: report.source.adapter })} was selected at least once`
          : `${report.orphans.length} ${noun} no scenario selected (${report.orphans.join(', ')})`,
    });
  }

  // Per-scenario thresholds are themselves a gate, and the only one that is
  // always on. There is deliberately no gate on the *mean* score: a headline
  // mean is the number people optimise, and per-scenario thresholds already
  // say everything it would.
  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  results.push({
    id: 'thresholds',
    limit: 0,
    observed: failed.length,
    passed: failed.length === 0,
    message:
      failed.length === 0
        ? `all ${report.scenarios.length} scenarios met their threshold`
        : `${failed.length} of ${report.scenarios.length} below threshold (${failed
            .map((scenario) => scenario.id)
            .join(', ')})`,
  });

  if (diff) results.push(regressionGate(diff));

  return results;
}

/**
 * The regression gate: the **worst** per-scenario drop, never the mean.
 *
 * A mean hides one scenario collapsing behind five that improved, and the one
 * that collapsed is the one headed for production. The floor comes from the
 * diff, which has already taken `minNoise` into account.
 */
function regressionGate(diff: ReportDiff): GateResult {
  const regressed = diff.scenarios.filter((scenario) => scenario.regressed);
  const worst = diff.scenarios.reduce(
    (min, scenario) => Math.min(min, scenario.delta),
    0,
  );

  return {
    id: 'max-regression',
    limit: round(diff.floor),
    observed: round(-worst),
    passed: regressed.length === 0,
    message:
      regressed.length === 0
        ? `worst drop ${pct(-worst)}, inside the ${pct(diff.floor)} floor`
        : `${regressed.length} scenario${regressed.length === 1 ? '' : 's'} regressed past ${pct(diff.floor)}` +
          ` (${regressed.map((scenario) => `${scenario.id} ${pct(-scenario.delta)}`).join(', ')})`,
  };
}

/** `mutate` gates: the mutation score floor. */
export function evaluateMutationGates(report: MutationReport, gates: CiGates): GateResult[] {
  if (gates.minScore === undefined) return [];

  return [
    {
      id: 'min-score',
      limit: gates.minScore,
      observed: round(report.mutationScore),
      passed: report.mutationScore >= gates.minScore,
      message:
        `mutation score ${pct(report.mutationScore)} against a floor of ${pct(gates.minScore)}` +
        ` (${report.mutants.filter((mutant) => mutant.killed).length} of ${report.mutants.length} detected)`,
    },
  ];
}

/**
 * Turn verdicts into the one number CI reads.
 *
 * An unmeasured breach wins over a failed one: if the run could not measure,
 * whatever else the gates concluded was concluded from noise, and reporting
 * that as a bad answer sends someone to fix a manifest that was never wrong.
 */
export function exitCodeFor(results: GateResult[]): ExitCode {
  const breached = results.filter((result) => !result.passed);
  if (breached.length === 0) return Exit.Ok;
  if (breached.some((result) => result.unmeasured === true)) return Exit.Unmeasured;
  return Exit.Failed;
}

/** Errored and total trials across a run. Errors leave the denominator elsewhere. */
export function trialCounts(report: EvalReport): { errors: number; total: number } {
  let errors = 0;
  let total = 0;
  for (const scenario of report.scenarios) {
    errors += scenario.errors;
    total += scenario.selection.total + scenario.errors;
  }
  return { errors, total };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Four places: enough to read a rate, not enough to imply precision we lack. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
