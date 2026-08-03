import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baselineOf, judgeMutant, meanScore, minNoise, scoreMutation } from '../src/mutator/index.js';
import type { Mutant } from '../src/mutator/index.js';
import type { EvalReport, ScenarioScore, Surface } from '../src/types.js';

/*
 * The kill rule, tested with no provider, no surface and no runner — reports
 * in, verdict out. Every number here is hand-written so that a wrong verdict
 * is a bug in the rule rather than in something three layers away.
 */

describe('meanScore', () => {
  it('averages scenarios rather than counting passes', async () => {
    // A threshold is a step function: 0.99 → 0.96 is real damage that a
    // pass-count would report as nothing having happened.
    assert.equal(meanScore(reportOf({ a: 0.99, b: 0.99 })), 0.99);
    assert.equal(meanScore(reportOf({ a: 1, b: 0 })), 0.5);
  });

  it('is zero for a run that scored nothing', () => {
    assert.equal(meanScore(reportOf({})), 0);
  });
});

describe('baselineOf', () => {
  it('pools both runs and takes their gap as the noise floor', () => {
    const baseline = baselineOf([reportOf({ a: 0.9 }), reportOf({ a: 0.8 })], 20);

    assert.ok(Math.abs(baseline.score - 0.85) < 1e-9);
    assert.ok(Math.abs(baseline.observedNoise - 0.1) < 1e-9);
    assert.ok(Math.abs(baseline.noise - 0.1) < 1e-9);
  });

  it('floors the noise at one trial flipping', () => {
    // Two identical runs mean a deterministic provider, not a stable server.
    // Trusting a zero gap would kill every mutant, including the harmless ones.
    const baseline = baselineOf([reportOf({ a: 0.9 }), reportOf({ a: 0.9 })], 20);

    assert.equal(baseline.observedNoise, 0);
    assert.equal(baseline.noise, minNoise(20));
    assert.equal(baseline.noise, 0.05);
  });

  it('keeps the observed gap visible even when floored', () => {
    const baseline = baselineOf([reportOf({ a: 0.9 }), reportOf({ a: 0.89 })], 5);
    assert.ok(baseline.observedNoise < baseline.noise, 'the floor should have won here');
    assert.ok(Math.abs(baseline.observedNoise - 0.01) < 1e-9, 'and the raw gap stays reportable');
  });
});

describe('judgeMutant', () => {
  const baseline = baselineOf([reportOf({ hit: 1, restraint: 1 }), reportOf({ hit: 0.9, restraint: 1 })], 20);

  it('kills a mutant whose drop clears the noise', () => {
    const record = judgeMutant(mutantOf(), reportOf({ hit: 0.2, restraint: 1 }), baseline);

    assert.ok(record.killed);
    assert.ok(record.delta > baseline.noise);
    assert.deepEqual(
      record.perScenario.find((s) => s.id === 'hit'),
      { id: 'hit', baseline: 0.95, mutant: 0.2, delta: 0.75 },
    );
  });

  it('leaves a mutant inside the noise alive', () => {
    const record = judgeMutant(mutantOf(), reportOf({ hit: 0.93, restraint: 1 }), baseline);

    assert.equal(record.killed, false);
    assert.ok(record.delta > 0, 'it did move — just not enough to mean anything');
  });

  it('does not kill a mutant that improved the score', () => {
    const record = judgeMutant(mutantOf(), reportOf({ hit: 1, restraint: 1 }), baseline);
    assert.equal(record.killed, false);
    assert.ok(record.delta < 0);
  });

  it('flags a mutant whose only movement was on restraint scenarios', () => {
    // Damage makes a model less willing to call anything, which *raises*
    // restraint and can hide a selection collapse inside the mean.
    const record = judgeMutant(mutantOf(), reportOf({ hit: 0.95, restraint: 0.4 }), baseline);

    assert.ok(record.restraintOnly);
    assert.equal(
      record.perScenario.find((s) => s.id === 'hit')!.delta,
      0,
      'selection did not move, so the drop is entirely restraint',
    );
  });

  it('does not flag restraintOnly when a selection scenario moved too', () => {
    const record = judgeMutant(mutantOf(), reportOf({ hit: 0.5, restraint: 0.4 }), baseline);
    assert.equal(record.restraintOnly, false);
  });

  it('kills a mutant that collapses one scenario out of many', () => {
    // The failure that made this rule: on the live 3 August corpus a blanked
    // description took its own scenario from 100% to 30% and was reported as a
    // survivor, because 70 points across sixteen scenarios is 4.4 points of
    // mean. Dilution scales with corpus size, so the better the corpus the more
    // invisible a real kill becomes.
    const wide = baselineOf([reportOf(sixteen(1)), reportOf(sixteen(1))], 10);
    const collapsed = { ...sixteen(1), s1: 0.3 };

    const record = judgeMutant(mutantOf(), reportOf(collapsed), wide);

    assert.ok(Math.abs(record.worstDrop - 0.7) < 1e-9);
    assert.equal(record.worstScenario, 's1');
    assert.ok(record.killed, 'the collapse is the finding');
    assert.ok(record.delta < wide.noise, 'and the mean alone would have missed it');
  });

  it('measures its floor per scenario, not from the mean', () => {
    // The two statistics are not interchangeable: the widest of sixteen noisy
    // scenarios swings far further than the mean of all sixteen. Judging a
    // worst-scenario drop against a mean-derived floor would kill everything.
    const noisy = baselineOf([reportOf({ a: 1, b: 1 }), reportOf({ a: 0.6, b: 1 })], 10);

    assert.ok(Math.abs(noisy.scenarioNoise - 0.4) < 1e-9, 'the widest single-scenario gap');
    assert.ok(Math.abs(noisy.noise - 0.2) < 1e-9, 'while the mean moved half as far');
    assert.equal(judgeMutant(mutantOf(), reportOf({ a: 0.7, b: 1 }), noisy).killed, false);
  });

  it('carries the mutant\'s targets through, so a survivor is diagnosable', () => {
    const record = judgeMutant(mutantOf(['delete_branch']), reportOf({ hit: 0.95, restraint: 1 }), baseline);

    assert.equal(record.killed, false);
    assert.deepEqual(record.targets, ['delete_branch']);
  });
});

describe('scoreMutation', () => {
  it('reports killed over total, and sums usage across every run', () => {
    const report = scoreMutation({
      baselineRuns: [reportOf({ a: 0.9 }), reportOf({ a: 0.9 })],
      mutants: [
        { mutant: mutantOf(), report: reportOf({ a: 0.1 }) }, // killed
        { mutant: mutantOf(), report: reportOf({ a: 0.89 }) }, // inside the floor
      ],
      trials: 20,
      startedAt: '2026-07-25T00:00:00.000Z',
      durationMs: 1000,
    });

    assert.equal(report.mutationScore, 0.5);
    assert.deepEqual(report.mutants.map((m) => m.killed), [true, false]);
    // Two baselines plus two mutants, each report carrying 100 input tokens.
    assert.equal(report.usage.inputTokens, 400);
  });

  it('scores an empty plan at zero, not one', () => {
    // "We injected nothing and detected all of it" is the most flattering
    // possible reading of having done no work.
    const report = scoreMutation({
      baselineRuns: [reportOf({ a: 1 }), reportOf({ a: 1 })],
      mutants: [],
      trials: 20,
      startedAt: '2026-07-25T00:00:00.000Z',
      durationMs: 1,
    });

    assert.equal(report.mutationScore, 0);
  });

  it('refuses to build a baseline out of nothing', () => {
    assert.throws(
      () =>
        scoreMutation({
          baselineRuns: [],
          mutants: [],
          trials: 20,
          startedAt: '2026-07-25T00:00:00.000Z',
          durationMs: 1,
        }),
      /needs at least one clean run/,
    );
  });
});

/* -------------------------------------------------------------------------- */

/** A report whose scenarios have exactly the scores named. */
function reportOf(scores: Record<string, number>): EvalReport {
  const scenarios: ScenarioScore[] = Object.entries(scores).map(([id, score]) => ({
    id,
    prompt: id,
    expected: id === 'restraint' ? null : 'create_branch',
    threshold: 0.95,
    selection: { passed: 0, total: 0, rate: score },
    restraint: id === 'restraint',
    score,
    passed: score >= 0.95,
    flaky: score > 0.2 && score < 0.8,
    confusions: [],
    errors: 0,
  }));

  const source: Surface['source'] = {
    kind: 'file',
    adapter: 'mcp',
    target: 'test',
    fetchedAt: '2026-07-25T00:00:00.000Z',
  };

  return {
    source,
    model: 'claude-haiku-4-5',
    provider: 'test',
    reasoning: { mode: 'none' },
    toolSearch: 'off',
    regimeHash: 'test-regime',
    trials: 20,
    scenarios,
    orphans: [],
    usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    startedAt: '2026-07-25T00:00:00.000Z',
    durationMs: 100,
  };
}

function mutantOf(targets: string[] = ['create_branch']): Mutant {
  return {
    id: `blank-description:${targets.join('+')}`,
    operator: 'blank-description',
    targets,
    describe: 'test mutant',
    apply: (surface) => surface,
  };
}

/** Sixteen scenarios all at the same score — the shape a real corpus has. */
function sixteen(score: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`s${i + 1}`, score]));
}
