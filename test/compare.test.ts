import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { diffReports, isDatedSnapshot } from '../src/ci/compare.js';
import { BaselineError, readReportFile, type StoredReport } from '../src/ci/report-file.js';
import { evaluateRunGates } from '../src/ci/gates.js';
import { DEFAULT_GATES, loadConfig } from '../src/config/index.js';
import { Exit } from '../src/exit.js';
import { exitCodeFor } from '../src/ci/gates.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { minNoise } from '../src/mutator/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import { runEval } from '../src/runner/index.js';
import type { EvalReport } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const BASELINE = fixture('reports/git-server-baseline.json');

async function replayReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  return runEval(config, manifest, provider);
}

const baseline = () => readReportFile(BASELINE);

describe('baseline diff', () => {
  it('floors the tolerance at minNoise, however small maxRegression is', async () => {
    // A diff between two single runs is not a noise measurement: `mutate`
    // measures its floor by running the clean surface twice, and this cannot.
    // The smallest scored scenario on the replay fixture has four trials.
    const diff = diffReports(await baseline(), await replayReport(), { maxRegression: 0.01 });
    assert.equal(diff.floor, minNoise(4));
  });

  it('lets a larger maxRegression win over the floor', async () => {
    const diff = diffReports(await baseline(), await replayReport(), { maxRegression: 0.5 });
    assert.equal(diff.floor, 0.5);
    // 40 points is the worst drop on this pair, and it is inside a 50% bar.
    assert.equal(diff.scenarios.every((scenario) => !scenario.regressed), true);
  });

  it('does not call a drop inside the floor a regression', async () => {
    const diff = diffReports(await baseline(), await replayReport());
    const byId = new Map(diff.scenarios.map((scenario) => [scenario.id, scenario]));

    // 95% → 80% is a real 15-point drop and it is still inside a 25% floor.
    // Calling it a regression is exactly the failure mode a single-run diff
    // falls into, and it would go red on the noise as readily as on a bug.
    assert.equal(byId.get('no-tool-needed')!.regressed, false);
    assert.equal(byId.get('create-branch-colloquial')!.regressed, true);
    assert.equal(byId.get('create-branch')!.delta > 0, true);
  });

  it('reports new failures separately from regressions', async () => {
    const diff = diffReports(await baseline(), await replayReport());

    // `no-tool-needed` crossed its threshold without clearing the noise floor.
    // Both facts are true and they are different facts: one is about this
    // config's bar, the other about whether the movement means anything.
    assert.deepEqual(diff.newFailures, ['create-branch-colloquial', 'no-tool-needed']);
    assert.deepEqual(diff.fixed, ['create-branch']);
    assert.deepEqual(diff.newOrphans, ['delete_branch']);
    assert.equal(diff.meanDelta, -0.125);
  });

  it('gates on the worst per-scenario drop, never the mean', async () => {
    // The mean here is −13%, inside the 25% floor. One scenario collapsed by
    // 40 points behind another that improved, and it is the collapsed one that
    // is headed for production.
    const diff = diffReports(await baseline(), await replayReport());
    const gates = evaluateRunGates(await replayReport(), DEFAULT_GATES, diff);
    const regression = gates.find((gate) => gate.id === 'max-regression')!;

    assert.equal(regression.passed, false);
    assert.match(regression.message, /create-branch-colloquial/);
    assert.equal(exitCodeFor([regression]), Exit.Failed);
  });

  it('warns when the baseline names a model alias, not a dated snapshot', async () => {
    const stored = await baseline();
    const head = await replayReport();

    // The instrument drifts, which no comparable tool has to handle: an alias
    // can be re-pointed underneath a stored baseline, so part of the delta may
    // be a model update rather than a surface change.
    assert.ok(diffReports(stored, head).warnings.some((w) => /model alias/.test(w)));

    const pinned: StoredReport = { ...stored, model: 'claude-haiku-4-5-20251001' };
    const pinnedHead: EvalReport = { ...head, model: 'claude-haiku-4-5-20251001' };
    assert.equal(
      diffReports(pinned, pinnedHead).warnings.some((w) => /model alias/.test(w)),
      false,
    );
  });

  it('knows a dated snapshot from an alias', () => {
    assert.equal(isDatedSnapshot('claude-haiku-4-5-20251001'), true);
    assert.equal(isDatedSnapshot('claude-haiku-4-5'), false);
    assert.equal(isDatedSnapshot('claude-opus-5'), false);
  });
});

describe('a mismatched baseline is refused, not projected', () => {
  it('refuses a different model', async () => {
    const stored = { ...(await baseline()), model: 'claude-opus-5' };
    await assert.rejects(async () => diffReports(stored, await replayReport()), (error: unknown) => {
      assert.ok(error instanceof BaselineError);
      assert.match(error.message, /looks like a regression and is a model swap/);
      return true;
    });
  });

  it('refuses a different adapter', async () => {
    const stored: StoredReport = { ...(await baseline()), adapter: 'skills' };
    await assert.rejects(async () => diffReports(stored, await replayReport()), BaselineError);
  });

  it('refuses a different presentation', async () => {
    // Same discipline as ReplayProvider refusing a foreign presentation mode:
    // the same skills under two presentations are two measurements.
    const stored: StoredReport = { ...(await baseline()), presentation: 'pseudo-tool' };
    await assert.rejects(async () => diffReports(stored, await replayReport()), BaselineError);
  });

  it('refuses a different set of scenarios, and names the difference', async () => {
    const stored = await baseline();
    const trimmed: StoredReport = { ...stored, scenarios: stored.scenarios.slice(0, 2) };

    await assert.rejects(async () => diffReports(trimmed, await replayReport()), (error: unknown) => {
      assert.ok(error instanceof BaselineError);
      assert.match(error.message, /added: no-tool-needed, create-branch-named/);
      return true;
    });
  });
});

describe('reading a stored report', () => {
  it('refuses a foreign schema version rather than guessing at the shape', async () => {
    await assert.rejects(
      async () => (await import('../src/ci/report-file.js')).parseReportFile({ schemaVersion: 1, command: 'run' }),
      (error: unknown) => {
        assert.ok(error instanceof BaselineError);
        assert.match(error.message, /Re-record the baseline/);
        return true;
      },
    );
  });

  it('refuses an inspect or mutate report as a baseline', async () => {
    const { parseReportFile } = await import('../src/ci/report-file.js');
    assert.throws(() => parseReportFile({ schemaVersion: 2, command: 'inspect' }), BaselineError);
  });

  it('refuses a missing file as unmeasurable, not as a regression', async () => {
    await assert.rejects(() => readReportFile(fixture('reports/nope.json')), BaselineError);
  });

  it('keeps the path it was read from, for the report header', async () => {
    const stored = await baseline();
    assert.equal(stored.path, BASELINE);
    assert.equal(stored.scenarios.length, 4);
    assert.equal(stored.adapter, 'mcp');
  });
});
