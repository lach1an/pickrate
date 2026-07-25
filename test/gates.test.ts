import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import {
  evaluateAnalysisGates,
  evaluateMutationGates,
  evaluateRunGates,
  exitCodeFor,
  trialCounts,
} from '../src/ci/gates.js';
import { ConfigError, DEFAULT_GATES, loadConfig, parseCi } from '../src/config/index.js';
import { Exit } from '../src/exit.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadSkills } from '../src/adapters/skills/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import { runEval } from '../src/runner/index.js';
import type { CiGates, EvalReport, GateResult, MutationReport } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function replayReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  return runEval(config, manifest, provider);
}

function gate(results: GateResult[], id: string): GateResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `expected a ${id} gate, got ${results.map((r) => r.id).join(', ')}`);
  return found;
}

describe('ci: config block', () => {
  it('defaults to one gate on — the one whose failure is silent', () => {
    assert.deepEqual(parseCi(undefined), { maxErrorRate: 0.1 });
    assert.equal(DEFAULT_GATES.maxErrorRate, 0.1);
  });

  it('refuses an unknown gate rather than ignoring it', () => {
    // A misspelled gate is a gate its author believes is guarding them and
    // which never fires. Silence here is the worst possible outcome.
    assert.throws(() => parseCi({ maxFlakey: 0 }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ci\.maxFlakey: unknown gate/);
      return true;
    });
  });

  it('accepts none and null as "off" for failOn', () => {
    assert.equal(parseCi({ failOn: 'none' }).failOn, null);
    assert.equal(parseCi({ failOn: null }).failOn, null);
    assert.equal(parseCi({ failOn: 'warn' }).failOn, 'warn');
    assert.throws(() => parseCi({ failOn: 'critical' }), ConfigError);
  });

  it('validates ranges', () => {
    assert.throws(() => parseCi({ maxErrorRate: 2 }), ConfigError);
    assert.throws(() => parseCi({ maxFlaky: -1 }), ConfigError);
    assert.throws(() => parseCi({ maxOrphans: 1.5 }), ConfigError);
    assert.deepEqual(parseCi({ maxFlaky: 0, maxOrphans: 2, minScore: 0.7 }), {
      maxFlaky: 0,
      maxOrphans: 2,
      maxErrorRate: 0.1,
      minScore: 0.7,
    });
  });

  it('reaches every config through loadConfig', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    assert.deepEqual(config.ci, DEFAULT_GATES);
  });
});

describe('inspect gates', () => {
  async function analysisOf(name: string) {
    return analyse(await loadManifestFromFile(fixture(name)));
  }

  it('fires fail-on only at or above the configured severity', async () => {
    const messy = await analysisOf('messy-server.json');
    const clean = await analysisOf('git-server.json');

    assert.equal(gate(evaluateAnalysisGates(messy, ci({ failOn: 'error' })), 'fail-on').passed, false);
    // The clean fixture carries one info finding and nothing worse, so the same
    // surface is a breach at `info` and not at `warn`. A gate that could not
    // tell those apart would be a boolean with a severity argument.
    assert.equal(gate(evaluateAnalysisGates(clean, ci({ failOn: 'info' })), 'fail-on').passed, false);
    assert.equal(gate(evaluateAnalysisGates(clean, ci({ failOn: 'warn' })), 'fail-on').passed, true);
  });

  it('does not gate at all when failOn is off', async () => {
    const messy = await analysisOf('messy-server.json');
    assert.deepEqual(evaluateAnalysisGates(messy, ci()), []);
    assert.equal(exitCodeFor(evaluateAnalysisGates(messy, ci())), Exit.Ok);
  });

  it('counts only the findings at or above the level, not all of them', async () => {
    const messy = await analysisOf('messy-server.json');
    const result = gate(evaluateAnalysisGates(messy, ci({ failOn: 'error' })), 'fail-on');

    // One error among six findings. `observed` is what breached, and the
    // message carries the rest so the reader can see what was let through.
    assert.equal(result.observed, 1);
    assert.match(result.message, /1 finding at or above error/);
  });

  it('gates resident tokens, not deferred bodies', async () => {
    const skills = analyse(await loadSkills(fixture('skills/messy')));
    assert.ok(skills.tokens.deferred !== undefined && skills.tokens.deferred > 0);

    // The budget is what you pay on every request. Folding bodies in would make
    // a surface that costs nothing until it fires look like the expensive one.
    const limit = skills.tokens.total + 1;
    assert.equal(gate(evaluateAnalysisGates(skills, ci({ maxTokens: limit })), 'max-tokens').passed, true);
    assert.equal(
      gate(evaluateAnalysisGates(skills, ci({ maxTokens: skills.tokens.total - 1 })), 'max-tokens').passed,
      false,
    );
  });
});

describe('run gates', () => {
  it('counts errored trials against the total, not the scored denominator', async () => {
    const report = await replayReport();
    // The fixture has exactly one errored trial out of twenty. Elsewhere errors
    // leave the denominator; here they are the numerator, which is the point.
    assert.deepEqual(trialCounts(report), { errors: 1, total: 20 });
  });

  it('breaches max-error-rate as unmeasured, never as a failure', async () => {
    const report = await replayReport();
    const results = evaluateRunGates(report, ci({ maxErrorRate: 0.01 }));
    const errorRate = gate(results, 'max-error-rate');

    assert.equal(errorRate.passed, false);
    assert.equal(errorRate.unmeasured, true);
    // The thresholds gate is also breached on this fixture, so this asserts the
    // precedence rule and not merely the flag: "could not measure" outranks
    // "measured, and it is bad".
    assert.equal(gate(results, 'thresholds').passed, false);
    assert.equal(exitCodeFor(results), Exit.Unmeasured);
  });

  it('passes max-error-rate at the default, and still fails on thresholds', async () => {
    const results = evaluateRunGates(await replayReport(), ci());
    assert.equal(gate(results, 'max-error-rate').passed, true);
    assert.equal(exitCodeFor(results), Exit.Failed);
  });

  it('fires max-flaky on the 20–80% band', async () => {
    const report = await replayReport();
    assert.equal(gate(evaluateRunGates(report, ci({ maxFlaky: 0 })), 'max-flaky').passed, false);
    assert.equal(gate(evaluateRunGates(report, ci({ maxFlaky: 2 })), 'max-flaky').passed, true);
  });

  it('fires max-orphans and names them', async () => {
    const report = await replayReport();
    const breached = gate(evaluateRunGates(report, ci({ maxOrphans: 0 })), 'max-orphans');

    assert.equal(breached.passed, false);
    assert.match(breached.message, /delete_branch/);
    assert.equal(gate(evaluateRunGates(report, ci({ maxOrphans: 1 })), 'max-orphans').passed, true);
  });

  it('takes its noun from the adapter', async () => {
    // A skills run whose gate says "tool" reads like it measured the wrong
    // thing, and the reader cannot tell that it did not.
    const config = await loadConfig(fixture('skills-eval.yaml'));
    const surface = await loadSkills(config.target);
    const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));
    const report = await runEval(config, surface, provider);

    const text = evaluateRunGates(report, ci({ maxOrphans: 0 }))
      .map((result) => result.message)
      .join('\n');
    assert.ok(!/\btools?\b/.test(text), text);
  });

  it('gates per-scenario thresholds and nothing about the mean', async () => {
    const results = evaluateRunGates(await replayReport(), ci());
    // Deliberately absent: a headline mean is the number people optimise, and
    // per-scenario thresholds already say everything a mean gate would.
    assert.equal(results.some((result) => /mean|score/.test(result.id)), false);
    assert.equal(gate(results, 'thresholds').observed, 3);
  });
});

describe('mutate gates', () => {
  const mutation = (mutationScore: number): MutationReport =>
    ({
      mutationScore,
      mutants: [{ killed: true }, { killed: mutationScore >= 1 }],
    }) as unknown as MutationReport;

  it('is off unless a floor is configured', () => {
    assert.deepEqual(evaluateMutationGates(mutation(0), ci()), []);
  });

  it('fires below the floor and passes at it', () => {
    assert.equal(gate(evaluateMutationGates(mutation(0.5), ci({ minScore: 0.7 })), 'min-score').passed, false);
    assert.equal(gate(evaluateMutationGates(mutation(0.7), ci({ minScore: 0.7 })), 'min-score').passed, true);
  });

  it('is a bad answer, not an unmeasured one', () => {
    // A low mutation score is a real measurement of a harness that cannot see
    // damage. Nothing failed to run.
    const results = evaluateMutationGates(mutation(0.5), ci({ minScore: 0.7 }));
    assert.equal(exitCodeFor(results), Exit.Failed);
  });
});

function ci(overrides: Partial<CiGates> = {}): CiGates {
  return { ...DEFAULT_GATES, ...overrides };
}
