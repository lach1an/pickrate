import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { loadManifestFromFile } from '../src/connector/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import { findOrphanTools, matchesSubset, scoreRun, totalUsage } from '../src/scorer/index.js';
import type { EvalConfig, Manifest, ScenarioScore, TrialResult } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let config: EvalConfig;
let manifest: Manifest;
let trialsByScenario: Map<string, TrialResult[]>;
let scores: Map<string, ScenarioScore>;
let orphanTools: string[];

/** Replay the fixture trials through the provider, exactly as the runner will. */
before(async () => {
  config = await loadConfig(fixture('pickrate.yaml'));
  manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));

  trialsByScenario = new Map();
  for (const scenario of config.scenarios) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < (scenario.trials ?? config.defaults.trials); i++) {
      trials.push(await provider.runTrial(manifest, scenario));
    }
    trialsByScenario.set(scenario.id, trials);
  }

  const result = scoreRun({
    config,
    manifest,
    model: provider.model,
    trialsByScenario,
    startedAt: new Date().toISOString(),
    durationMs: 0,
  });
  scores = new Map(result.scenarios.map((s) => [s.id, s]));
  orphanTools = result.orphanTools;
});

describe('scorer', () => {
  it('scores a clean scenario at 1.0 and passes it', () => {
    const score = scores.get('create-branch')!;
    assert.equal(score.score, 1);
    assert.equal(score.selection.rate, 1);
    assert.equal(score.passed, true);
    assert.equal(score.flaky, false);
    assert.deepEqual(score.confusions, []);
  });

  it('ignores arguments the scenario did not declare', () => {
    // One create-branch trial also supplied `base: main`; a subset match must
    // not care, or every scenario would have to enumerate optional params.
    assert.equal(scores.get('create-branch')!.args?.rate, 1);
  });

  it('records what was chosen instead, so confusion pairs are visible', () => {
    const score = scores.get('create-branch-colloquial')!;
    assert.equal(score.score, 0.6);
    assert.deepEqual(score.confusions, [{ tool: 'list_branches', count: 2 }]);
  });

  it('flags the dangerous middle band', () => {
    assert.equal(scores.get('create-branch-colloquial')!.flaky, true);
    assert.equal(scores.get('create-branch')!.flaky, false);
  });

  it('fails a scenario that misses its threshold', () => {
    const score = scores.get('create-branch-colloquial')!;
    assert.equal(score.threshold, 0.8); // per-scenario override
    assert.equal(score.passed, false);
  });

  it('scores restraint as calling nothing at all', () => {
    const score = scores.get('no-tool-needed')!;
    assert.equal(score.restraint, true);
    assert.equal(score.score, 0.8);
    assert.equal(score.passed, false, 'restraint below the 0.95 default should fail');
    assert.deepEqual(score.confusions, [{ tool: 'list_branches', count: 1 }]);
  });

  it('separates argument accuracy from selection', () => {
    const score = scores.get('create-branch-named')!;
    assert.equal(score.selection.rate, 1, 'it always picked the right tool');
    assert.equal(score.args?.rate, 0.75, 'but got the argument wrong once');
    assert.equal(score.score, 0.75);
  });

  it('excludes errored trials from the denominator and counts them', () => {
    const score = scores.get('create-branch-named')!;
    assert.equal(score.errors, 1);
    assert.equal(score.selection.total, 4, '5 trials, 1 errored');
  });

  it('trims whitespace before comparing arguments', () => {
    assert.equal(matchesSubset({ name: 'hotfix' }, { name: ' hotfix ' }), true);
  });

  it('does not lowercase — case-sensitive identifiers are a real failure', () => {
    assert.equal(matchesSubset({ name: 'hotfix' }, { name: 'HotFix' }), false);
  });

  it('finds tools no scenario ever selected', () => {
    assert.deepEqual(orphanTools, ['delete_branch']);
  });

  it('reports orphans against the manifest, not against the scenarios', () => {
    assert.deepEqual(findOrphanTools(manifest, new Map()), [
      'create_branch',
      'delete_branch',
      'list_branches',
    ]);
  });

  it('totals usage across every trial', () => {
    const usage = totalUsage(trialsByScenario);
    assert.equal(usage.cacheCreationInputTokens, 240, 'one cache write for the whole run');
    assert.ok(usage.cacheReadInputTokens > 0);
    assert.ok(usage.outputTokens > 0);
  });
});

describe('matchesSubset', () => {
  it('requires every declared key to be present', () => {
    assert.equal(matchesSubset({ name: 'x', base: 'main' }, { name: 'x' }), false);
  });

  it('compares nested structures deeply', () => {
    assert.equal(matchesSubset({ f: { a: [1, 2] } }, { f: { a: [1, 2] }, extra: 1 }), true);
    assert.equal(matchesSubset({ f: { a: [1, 2] } }, { f: { a: [2, 1] } }), false);
  });
});
