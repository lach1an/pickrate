import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadSkills } from '../src/adapters/skills/index.js';
import { loadConfig } from '../src/config/index.js';
import { blankDescription, runMutation } from '../src/mutator/index.js';
import { formatMutationReportJson, SCHEMA_VERSION } from '../src/report/json.js';
import { formatMutationReport } from '../src/report/mutation.js';
import type { MutationReport, Surface } from '../src/types.js';
import { LexicalProvider } from './helpers/lexical-provider.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('mutation report', () => {
  let report: MutationReport;
  let text: string;

  before(async () => {
    const config = await loadConfig(fixture('mutation.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));
    report = await runMutation(config, surface, new LexicalProvider(), {
      mutants: ['create_branch', 'list_branches'].map((name) => mutantFor(surface, name)),
    });
    text = stripAnsi(formatMutationReport(report));
  });

  it('exposes the fields a CI consumer pins on', () => {
    const parsed = JSON.parse(formatMutationReportJson(report));

    assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
    assert.equal(parsed.command, 'mutate');
    assert.deepEqual(parsed.summary, { mutants: 2, killed: 1, survived: 1, mutationScore: 0.5 });
    assert.equal(typeof parsed.baseline.noise, 'number');
    assert.equal(typeof parsed.baseline.observedNoise, 'number');
  });

  it('carries each mutant\'s whole run, not just its score', () => {
    // The score says how much to trust the harness; the confusion pairs
    // underneath say why. A consumer given only the number could not tell a
    // survivor with no coverage from one the harness is blind to.
    const parsed = JSON.parse(formatMutationReportJson(report));
    const killed = parsed.mutants.find((m: { killed: boolean }) => m.killed);

    assert.ok(Array.isArray(killed.report.scenarios));
    assert.ok(Array.isArray(killed.perScenario));
    assert.ok(killed.targets.includes('create_branch'));
  });

  it('puts every verdict above the mutation score', () => {
    // Same reason the eval report ranks diagnostics first: whoever optimises a
    // number will optimise the number.
    const firstVerdict = text.indexOf('survived');
    const score = text.indexOf('mutation score');

    assert.ok(firstVerdict > 0 && score > 0);
    assert.ok(firstVerdict < score, 'verdicts must precede the score');
  });

  it('names what a survivor damaged, so it can be diagnosed', () => {
    assert.match(text, /survivors/);
    assert.match(text, /blank-description:list_branches — damaged list_branches/);
    assert.match(text, /inconclusive, not a pass/);
  });

  it('states the baseline and its noise floor above the verdicts', () => {
    const baseline = text.indexOf('baseline');
    assert.ok(baseline > 0 && baseline < text.indexOf('survived'));
    // The bar is per-scenario, because that is the statistic the verdict is
    // made on. A header quoting the mean floor would not explain any row.
    assert.match(text, /must drop one scenario by 10%/);
    assert.match(text, /the two clean runs agreed exactly/);
  });

  it('says the score is not comparable across adapters', () => {
    // Blanking one description out of eight skills and out of forty tools are
    // not the same operation (spec §11.7).
    assert.match(text, /Comparable only against other mcp runs/);
  });
});

describe('mutation report on a skills surface', () => {
  it('never calls a skill a tool', async () => {
    // A skills report that says "tool" reads like it measured the wrong thing,
    // and the reader cannot tell that it didn't.
    const config = await loadConfig(fixture('skills-eval.yaml'));
    const surface = await loadSkills(fixture('skills/clean'));
    const report = await runMutation(config, surface, new LexicalProvider(), { plan: { limit: 2 } });

    // The presentation mode is genuinely called `skill-tool`, so it comes out
    // before the check — same idiom as the eval report's noun test.
    const text = stripAnsi(formatMutationReport(report)).replace(/skill-tool|pseudo-tool/g, '');
    assert.ok(!/\btool\b/i.test(text), `"tool" appeared in a skills report:\n${text}`);
    assert.match(text, /Comparable only against other skills runs/);
  });
});

function mutantFor(surface: Surface, name: string) {
  return blankDescription.enumerate(surface).find((mutant) => mutant.targets[0] === name)!;
}

/** The escape byte too, so an assertion can match across a colour boundary. */
function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '').replace(//g, '');
}
