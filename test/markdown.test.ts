import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import { evaluateAnalysisGates, evaluateRunGates } from '../src/ci/gates.js';
import { DEFAULT_GATES, loadConfig } from '../src/config/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadSkills } from '../src/adapters/skills/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import {
  COMMENT_MARKER,
  formatAnalysisMarkdown,
  formatEvalMarkdown,
  formatMutationMarkdown,
} from '../src/report/markdown.js';
import { runEval } from '../src/runner/index.js';
import type { EvalReport, MutationReport } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function replayReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  return runEval(config, manifest, provider);
}

async function skillsReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('skills-eval.yaml'));
  const surface = await loadSkills(config.target);
  const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));
  return runEval(config, surface, provider);
}

describe('markdown eval report', () => {
  it('puts diagnostics above the headline number', async () => {
    // Same discipline as the terminal report, for the same reason: whoever
    // optimises the number writes descriptions that game it.
    const text = formatEvalMarkdown(await replayReport());
    const confusion = text.indexOf('### Confusion');
    const orphans = text.indexOf('### Orphans');
    const summary = text.indexOf('below threshold');

    assert.ok(confusion > 0 && orphans > 0 && summary > 0);
    assert.ok(confusion < summary, 'confusion pairs must precede the summary');
    assert.ok(orphans < summary, 'orphans must precede the summary');
  });

  it('names the model and the presentation above the numbers', async () => {
    const report = await skillsReport();
    const text = formatEvalMarkdown(report);
    assert.ok(text.indexOf(report.model) < text.indexOf('### Scenarios'));
    assert.ok(text.indexOf('skill-tool') < text.indexOf('### Scenarios'));
  });

  it('never says "tool" on a skills run', async () => {
    // A report that uses the wrong noun reads like it measured the wrong
    // thing, and the reader has no way to tell that it did not.
    const report = await skillsReport();
    const gates = evaluateRunGates(report, { ...DEFAULT_GATES, maxOrphans: 0 });
    const text = formatEvalMarkdown(report, gates).replace(/skill-tool|pseudo-tool/g, '');
    assert.ok(!/\btools?\b/i.test(text), text);
  });

  it('renders gates as a table, with unmeasured called out in words', async () => {
    const report = await replayReport();
    const gates = evaluateRunGates(report, { ...DEFAULT_GATES, maxErrorRate: 0 });
    const text = formatEvalMarkdown(report, gates);

    assert.match(text, /### Gates/);
    assert.match(text, /\| ❓ \| `max-error-rate` \|/);
    // Colour cannot carry this distinction in a step summary, and the reader
    // needs to know an unmeasured run is not a failing eval.
    assert.match(text, /\*\*Unmeasured\.\*\*/);
  });

  it('opens with a stable marker, so a PR carries one comment and not thirty', async () => {
    assert.ok(formatEvalMarkdown(await replayReport()).startsWith(COMMENT_MARKER));
  });

  it('escapes pipes so a message cannot break the table it lands in', async () => {
    const report = await replayReport();
    const gates = [
      { id: 'made-up', limit: 0, observed: 1, passed: false, message: 'a | b' },
    ];
    assert.match(formatEvalMarkdown(report, gates), /a \\\| b/);
  });
});

describe('markdown inspect report', () => {
  it('puts findings above the headline count', async () => {
    const analysis = analyse(await loadManifestFromFile(fixture('messy-server.json')));
    const text = formatAnalysisMarkdown(analysis, evaluateAnalysisGates(analysis, { ...DEFAULT_GATES, failOn: 'error' }));

    assert.ok(text.indexOf('### Findings') < text.indexOf('error'));
    assert.match(text, /\| ❌ \| `[a-z-]+` \|/);
  });

  it('keeps deferred skill bodies out of the resident figure', async () => {
    const analysis = analyse(await loadSkills(fixture('skills/messy')));
    const text = formatAnalysisMarkdown(analysis);

    assert.match(text, /resident context/);
    assert.match(text, /paid only when a skill triggers/);
    assert.ok(text.indexOf('resident context') < text.indexOf('skill bodies'));
  });

  it('reports a clean surface as clean, not as an empty table', async () => {
    const analysis = analyse(await loadManifestFromFile(fixture('git-server.json')));
    // The clean fixture carries one info finding, so this is the shape check.
    assert.match(formatAnalysisMarkdown(analysis), /\| ℹ️ \|/);
  });
});

describe('markdown mutation report', () => {
  const report = {
    source: { adapter: 'mcp', target: './git-server.json', kind: 'file', fetchedAt: '' },
    model: 'claude-haiku-4-5',
    trials: 10,
    baseline: { runs: [{}, {}], score: 0.9, noise: 0.1, observedNoise: 0 },
    mutants: [
      {
        id: 'blank-1',
        operator: 'blank-description',
        targets: ['create_branch'],
        describe: 'blanked create_branch',
        score: 0.4,
        delta: 0.5,
        killed: true,
        restraintOnly: false,
        perScenario: [],
      },
      {
        id: 'blank-2',
        operator: 'blank-description',
        targets: ['list_branches'],
        describe: 'blanked list_branches',
        score: 0.9,
        delta: 0,
        killed: false,
        restraintOnly: false,
        perScenario: [],
      },
    ],
    mutationScore: 0.5,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    startedAt: '',
    durationMs: 0,
  } as unknown as MutationReport;

  it('names survivors and their targets above the score', () => {
    // "No scenario tests this" and "the harness is blind to this" look
    // identical from the score alone, so the targets have to come first.
    const text = formatMutationMarkdown(report);
    assert.ok(text.indexOf('### Survivors') < text.indexOf('Mutation score'));
    assert.match(text, /`list_branches`/);
    assert.match(text, /inconclusive, not a pass/);
  });

  it('says the score is not comparable across adapters', () => {
    assert.match(formatMutationMarkdown(report), /never averaged across adapters/);
  });

  it('flags a baseline whose clean runs agreed exactly', () => {
    assert.match(formatMutationMarkdown(report), /agreed exactly/);
  });
});
