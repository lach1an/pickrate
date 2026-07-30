import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import { VERSION } from '../src/cli.js';
import { diffReports } from '../src/ci/compare.js';
import { evaluateAnalysisGates, evaluateRunGates } from '../src/ci/gates.js';
import { readReportFile } from '../src/ci/report-file.js';
import { DEFAULT_GATES, loadConfig } from '../src/config/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import {
  formatAnalysisJson,
  formatEvalReportJson,
  formatMutationReportJson,
  SCHEMA_VERSION,
} from '../src/report/json.js';
import { runEval } from '../src/runner/index.js';
import { scoreMutation } from '../src/mutator/index.js';
import type { EvalReport } from '../src/types.js';

/**
 * The schema freeze.
 *
 * From the moment the Action ships, these payloads are somebody's pipeline.
 * Additions are free — a consumer pinned on a version ignores keys it has
 * never seen — but a rename or a removal costs a `SCHEMA_VERSION` bump, and
 * the point of asserting the exact key set is that the bump is forced by a
 * failing test here rather than noticed by a stranger's broken build.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function replayReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  return runEval(config, manifest, provider);
}

const keys = (json: string) => Object.keys(JSON.parse(json));

describe('JSON schema', () => {
  it('is version 3', () => {
    // 3 took every multi-provider break at once, while nothing pinned 2:
    // optional cache usage, the resolved model id, and required provenance.
    assert.equal(SCHEMA_VERSION, 3);
  });

  it('freezes the inspect payload', async () => {
    const analysis = analyse(await loadManifestFromFile(fixture('messy-server.json')));
    assert.deepEqual(keys(formatAnalysisJson(analysis)), [
      'schemaVersion',
      'command',
      'source',
      'itemCount',
      'tokens',
      'summary',
      'findings',
    ]);
    assert.deepEqual(keys(formatAnalysisJson(analysis, { gates: evaluateAnalysisGates(analysis, DEFAULT_GATES) })), [
      'schemaVersion',
      'command',
      'source',
      'itemCount',
      'tokens',
      'summary',
      'findings',
      'gates',
    ]);
  });

  it('freezes the run payload, with and without a baseline', async () => {
    const report = await replayReport();
    assert.deepEqual(keys(formatEvalReportJson(report)), [
      'schemaVersion',
      'command',
      'source',
      'model',
      'provider',
      'reasoning',
      'toolSearch',
      'regimeHash',
      'trials',
      'startedAt',
      'durationMs',
      'summary',
      'scenarios',
      'orphans',
      'usage',
      'costUsd',
    ]);

    const diff = diffReports(await readReportFile(fixture('reports/git-server-baseline.json')), report);
    const gates = evaluateRunGates(report, DEFAULT_GATES, diff);
    const full = JSON.parse(formatEvalReportJson(report, { gates, diff }));

    assert.deepEqual(Object.keys(full).slice(-2), ['gates', 'diff']);
    assert.deepEqual(Object.keys(full.diff), [
      'baseline',
      'floor',
      'scenarios',
      'meanDelta',
      'newFailures',
      'fixed',
      'newOrphans',
      'warnings',
    ]);
    assert.deepEqual(Object.keys(full.gates[0]), ['id', 'limit', 'observed', 'passed', 'unmeasured', 'message']);
  });

  it('freezes the scenario score shape a consumer reads per row', async () => {
    const report = await replayReport();
    const scenario = JSON.parse(formatEvalReportJson(report)).scenarios[0];
    assert.deepEqual(Object.keys(scenario), [
      'id',
      'prompt',
      'expected',
      'threshold',
      'selection',
      'args',
      'restraint',
      'score',
      'passed',
      'flaky',
      'confusions',
      'errors',
    ]);
  });

  it('freezes the mutate payload', async () => {
    const report = await replayReport();
    const mutation = scoreMutation({
      baselineRuns: [report, report],
      mutants: [],
      trials: 5,
      startedAt: report.startedAt,
      durationMs: 1,
    });

    assert.deepEqual(keys(formatMutationReportJson(mutation)), [
      'schemaVersion',
      'command',
      'source',
      'model',
      'provider',
      'reasoning',
      'toolSearch',
      'regimeHash',
      'trials',
      'startedAt',
      'durationMs',
      'summary',
      'baseline',
      'mutants',
      'usage',
      'costUsd',
    ]);
  });

  it('reads its own run output back as a baseline', async () => {
    // The round trip is the whole contract: what `--out` writes must be what
    // `--baseline` accepts, in this build and in one six weeks from now.
    const stored = await readReportFile(fixture('reports/git-server-baseline.json'));
    assert.equal(stored.schemaVersion, SCHEMA_VERSION);
    assert.equal(stored.command, 'run');
  });
});

describe('version', () => {
  it("cli.ts's VERSION matches package.json", () => {
    // They are duplicates, and the Action pins a published range — a build
    // that reports a version it is not is the one thing nobody debugs quickly.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    assert.equal(VERSION, pkg.version);
  });
});
