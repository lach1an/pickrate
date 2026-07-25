import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { loadManifestFromFile, mcpAdapter } from '../src/adapters/mcp/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import {
  findOrphans,
  matchesSubset,
  scoreRun,
  scoreScenario,
  totalUsage,
  type Projection,
} from '../src/scorer/index.js';
import type {
  EvalConfig,
  Scenario,
  ScenarioScore,
  Surface,
  ToolCall,
  TrialResult,
} from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let config: EvalConfig;
let surface: Surface;
let trialsByScenario: Map<string, TrialResult[]>;
let scores: Map<string, ScenarioScore>;
let orphans: string[];

/** Replay the fixture trials through the provider, exactly as the runner will. */
before(async () => {
  config = await loadConfig(fixture('pickrate.yaml'));
  surface = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  const presentation = mcpAdapter.present(surface);

  trialsByScenario = new Map();
  for (const scenario of config.scenarios) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < (scenario.trials ?? config.defaults.trials); i++) {
      trials.push(await provider.runTrial(presentation, scenario));
    }
    trialsByScenario.set(scenario.id, trials);
  }

  const result = scoreRun({
    config,
    surface,
    model: provider.model,
    trialsByScenario,
    startedAt: new Date().toISOString(),
    durationMs: 0,
  });
  scores = new Map(result.scenarios.map((s) => [s.id, s]));
  orphans = result.orphans;
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

  it('finds items no scenario ever selected', () => {
    assert.deepEqual(orphans, ['delete_branch']);
  });

  it('reports orphans against the surface, not against the scenarios', () => {
    assert.deepEqual(findOrphans(surface, new Map()), [
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

/* -------------------------------------------------------------------------- */

/**
 * Stand-in for the skills presenter, which does not exist yet: the model calls
 * one dispatch tool and names the skill in its arguments. Everything else
 * passes through — dropping an unmappable call would fabricate restraint.
 */
const dispatch: Projection = (calls) =>
  calls.map((call) => {
    if (call.name !== 'Skill' || typeof call.args.skill !== 'string') return call;
    const { skill, ...rest } = call.args;
    return { name: skill, args: rest };
  });

const skillTrial = (id: string, calls: ToolCall[]): TrialResult => ({
  scenarioId: id,
  calls,
  stopReason: 'tool_use',
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
});

const invoke = (skill: string, args: Record<string, unknown> = {}): ToolCall => ({
  name: 'Skill',
  args: { skill, ...args },
});

const scenario = (expect: Scenario['expect']): Scenario => ({
  id: 'review',
  prompt: 'review this pull request',
  expect,
});

describe('scorer projection', () => {
  it('scores the skill the model named, not the tool it called', () => {
    const score = scoreScenario(
      scenario({ tool: 'review-pr' }),
      [skillTrial('review', [invoke('review-pr')])],
      0.9,
      { project: dispatch },
    );
    assert.equal(score.selection.rate, 1);
    assert.equal(score.score, 1);
  });

  it('labels confusions by skill, so the pair is legible', () => {
    // Without projection every confusion in a skills run reads "Skill", which
    // is the same answer for every scenario and tells you nothing.
    const score = scoreScenario(
      scenario({ tool: 'review-pr' }),
      [skillTrial('review', [invoke('summarise')])],
      0.9,
      { project: dispatch },
    );
    assert.deepEqual(score.confusions, [{ tool: 'summarise', count: 1 }]);
  });

  it('matches arguments against the projected call', () => {
    const score = scoreScenario(
      scenario({ tool: 'review-pr', args: { pr: '42' } }),
      [skillTrial('review', [invoke('review-pr', { pr: '42' })])],
      0.9,
      { project: dispatch },
    );
    assert.equal(score.args?.rate, 1);
  });

  it('still fails an over-call, and names both halves of it', () => {
    const score = scoreScenario(
      scenario({ tool: 'review-pr' }),
      [skillTrial('review', [invoke('review-pr'), { name: 'list_branches', args: {} }])],
      0.9,
      { project: dispatch },
    );
    assert.equal(score.score, 0);
    assert.deepEqual(score.confusions, [{ tool: 'review-pr + list_branches', count: 1 }]);
  });

  it('defaults to the identity, which is the MCP case', () => {
    const score = scoreScenario(
      scenario({ tool: 'Skill' }),
      [skillTrial('review', [invoke('review-pr')])],
      0.9,
    );
    assert.equal(score.selection.rate, 1);
  });
});

describe('findOrphans projection', () => {
  const skills: Surface = {
    kind: 'skills',
    source: { kind: 'dir', adapter: 'skills', target: './skills', fetchedAt: '' },
    items: ['review-pr', 'summarise'].map((name) => ({
      kind: 'skill' as const,
      name,
      path: `./skills/${name}/SKILL.md`,
      body: '',
      frontmatter: {},
      raw: {},
    })),
  };
  const trials = new Map([['review', [skillTrial('review', [invoke('review-pr')])]]]);

  it('counts a skill the model reached through the dispatch tool', () => {
    assert.deepEqual(findOrphans(skills, trials, dispatch), ['summarise']);
  });

  it('would call every skill dead weight without it', () => {
    // The failure this projection exists to prevent: raw calls all name the
    // dispatch tool, so the headline diagnostic reports a working surface as
    // 100% unused.
    assert.deepEqual(findOrphans(skills, trials), ['review-pr', 'summarise']);
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
