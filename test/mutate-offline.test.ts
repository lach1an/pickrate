import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadConfig } from '../src/config/index.js';
import { blankDescription, runMutation } from '../src/mutator/index.js';
import type { EvalConfig, MutantRecord, MutationReport, Surface } from '../src/types.js';
import { LexicalProvider } from './helpers/lexical-provider.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/*
 * The mutation loop end to end, with no network and no spend.
 *
 * `LexicalProvider` is a fake and its scores are fiction — see its own file.
 * What this asserts is the wiring: that a damaged description reaches the
 * presentation, changes what gets selected, and comes back out as a killed
 * mutant. If any seam between the operator and the verdict is broken, these
 * fail; if the mutation score is merely uninteresting, they do not.
 */
describe('runMutation, offline', () => {
  let config: EvalConfig;
  let surface: Surface;
  let report: MutationReport;

  before(async () => {
    config = await loadConfig(fixture('mutation.yaml'));
    surface = await loadManifestFromFile(fixture('git-server.json'));
    report = await runMutation(config, surface, new LexicalProvider(), {
      mutants: [
        // A tool two scenarios depend on.
        mutantFor(surface, 'create_branch'),
        // A tool no scenario mentions — damaging it must not register.
        mutantFor(surface, 'list_branches'),
      ],
    });
  });

  it('kills a mutant that damages an item the scenarios exercise', () => {
    const record = recordFor(report, 'create_branch');

    assert.ok(record.killed, `expected a kill, got delta ${record.delta} vs noise ${report.baseline.noise}`);
    assert.ok(record.delta > report.baseline.noise);
    assert.deepEqual(record.targets, ['create_branch']);
  });

  it('leaves a mutant nothing tests alive, with its target named', () => {
    // Survival is inconclusive, never a pass. `targets` is what lets a reader
    // tell "the harness is insensitive" from "no scenario went near this".
    const record = recordFor(report, 'list_branches');

    assert.equal(record.killed, false);
    assert.deepEqual(record.targets, ['list_branches']);
    assert.ok(report.baseline.runs[0]!.orphans.includes('list_branches'), 'and it reads as an orphan');
  });

  it('reports killed over total', () => {
    assert.equal(report.mutationScore, 0.5);
    assert.equal(report.mutants.length, 2);
  });

  it('does not let a zero-variance baseline kill everything', () => {
    // This provider is deterministic, so the two clean runs agree exactly. The
    // floor is the only thing standing between that and a mutation score of
    // 100% for a harness that detected nothing.
    assert.equal(report.baseline.observedNoise, 0);
    assert.equal(report.baseline.noise, 1 / 10, 'floored at one trial of ten flipping');
    assert.equal(recordFor(report, 'list_branches').delta, 0);
  });

  it('measures the clean surface twice and every mutant once', () => {
    assert.equal(report.baseline.runs.length, 2);
    assert.equal(report.baseline.runs[0]!.scenarios.length, config.scenarios.length);
    // 4 runs × 3 scenarios × 10 trials.
    assert.equal(report.usage.inputTokens, 4 * 3 * 10 * 100);
  });

  it('leaves the baseline surface undamaged for the runs that follow', () => {
    assert.equal(
      surface.items.find((item) => item.name === 'create_branch')!.description !== '',
      true,
    );
  });

  it('carries the mutant\'s own confusion pairs, not just its score', () => {
    // Invariant 5: diagnostics outrank the number. A mutation report that only
    // said "0.5" would not tell anyone what to change.
    const record = recordFor(report, 'create_branch');
    const scenario = record.report.scenarios.find((s) => s.id === 'create-branch')!;

    assert.ok(scenario.confusions.length > 0, 'a failed selection should name what it picked instead');
  });
});

describe('runMutation planning', () => {
  it('plans its own mutants when not given any', async () => {
    const config = await loadConfig(fixture('mutation.yaml'));
    const surface = await loadManifestFromFile(fixture('git-server.json'));

    const report = await runMutation(config, surface, new LexicalProvider(), {
      plan: { limit: 2 },
    });

    assert.deepEqual(report.mutants.map((m) => m.operator), ['blank-description', 'swap-descriptions']);
  });
});

function mutantFor(surface: Surface, name: string) {
  return blankDescription.enumerate(surface).find((mutant) => mutant.targets[0] === name)!;
}

function recordFor(report: MutationReport, target: string): MutantRecord {
  return report.mutants.find((mutant) => mutant.targets.includes(target))!;
}
