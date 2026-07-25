import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { loadSkills, presentSkills, SKILL_TOOL } from '../src/adapters/skills/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import { runEval } from '../src/runner/index.js';
import type { JsonSchema, Surface } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const clean = await loadSkills(fixture('skills/clean'));
const messy = await loadSkills(fixture('skills/messy'));

const enumOf = (schema: JsonSchema): string[] =>
  ((schema.properties as Record<string, { enum?: string[] }>).skill!.enum ?? []);

describe('skill-tool presentation', () => {
  const presentation = presentSkills(clean);

  it('offers exactly one dispatch tool', () => {
    // The mechanism under test: an agent does not get one tool per skill, it
    // gets one Skill tool and a listing. Measuring anything else measures a
    // surface the user does not actually ship.
    assert.equal(presentation.tools.length, 1);
    assert.equal(presentation.tools[0]!.name, SKILL_TOOL);
    assert.equal(presentation.mode, 'skill-tool');
  });

  it('names every skill in the enum, in surface order', () => {
    assert.deepEqual(enumOf(presentation.tools[0]!.inputSchema), ['changelog', 'git-review']);
  });

  it('lists the routing descriptions in the system prompt', () => {
    assert.match(presentation.systemSuffix!, /Available skills:/);
    assert.match(presentation.systemSuffix!, /- git-review: Reviews a pull request diff/);
    assert.match(presentation.systemSuffix!, /- changelog: Drafts release notes/);
  });

  it('keeps one skill to a line, whatever the description does', () => {
    const lines = presentation.systemSuffix!.trim().split('\n');
    assert.equal(lines.length, 1 + clean.items.length, 'a heading plus one line each');
  });

  it('never leaks the body into the listing', () => {
    // Bodies are not resident. A presenter that included them would multiply
    // the per-trial cost and stop measuring progressive disclosure at all.
    assert.ok(!presentation.systemSuffix!.includes('git diff main...HEAD'));
  });

  it('is byte-stable, because it sits inside the cached prefix', () => {
    // A suffix that varied between trials would make every trial a cache miss,
    // and the only symptom would be a bill around ten times the estimate.
    const again = presentSkills(clean);
    assert.equal(again.systemSuffix, presentation.systemSuffix);
    assert.equal(JSON.stringify(again.tools), JSON.stringify(presentation.tools));
  });

  it('does not offer a skill that failed to parse', () => {
    // A real loader rejects it too, so presenting it would measure a skill the
    // user does not actually have.
    const offered = enumOf(presentSkills(messy).tools[0]!.inputSchema);
    assert.ok(!offered.includes('broken'));
    assert.ok(!offered.includes('no-frontmatter'));
    assert.ok(offered.includes('pdf-tools'));
  });

  it('refuses a surface with nothing offerable, rather than sending an empty enum', () => {
    const allBroken: Surface = { ...messy, items: messy.items.filter((i) => 'error' in i && i.error) };
    assert.throws(() => presentSkills(allBroken), /every one of them failed to parse/);
  });
});

describe('skill-tool projection', () => {
  const { project } = presentSkills(clean);

  it('reads the selection out of the dispatch argument', () => {
    assert.deepEqual(project([{ name: SKILL_TOOL, args: { skill: 'git-review' } }]), [
      { name: 'git-review', args: {} },
    ]);
  });

  it('keeps the other arguments, so expect.args still means something', () => {
    assert.deepEqual(project([{ name: SKILL_TOOL, args: { skill: 'changelog', since: 'v1.2' } }]), [
      { name: 'changelog', args: { since: 'v1.2' } },
    ]);
  });

  it('passes through a dispatch call that names no skill', () => {
    // The load-bearing case. Dropping it would leave an empty call list, which
    // scores as restraint — a malformed call would become a pass.
    const calls = [{ name: SKILL_TOOL, args: {} }];
    assert.deepEqual(project(calls), calls);
  });

  it('passes through a call that is not the dispatch tool', () => {
    const calls = [{ name: 'Read', args: { path: 'x' } }];
    assert.deepEqual(project(calls), calls);
  });

  it('projects every call in an over-call, not just the first', () => {
    assert.deepEqual(
      project([
        { name: SKILL_TOOL, args: { skill: 'git-review' } },
        { name: SKILL_TOOL, args: { skill: 'changelog' } },
      ]).map((c) => c.name),
      ['git-review', 'changelog'],
    );
  });
});

describe('pseudo-tool presentation', () => {
  const presentation = presentSkills(clean, { mode: 'pseudo-tool' });

  it('gives each skill a tool of its own', () => {
    assert.deepEqual(
      presentation.tools.map((t) => t.name),
      ['changelog', 'git-review'],
    );
    assert.equal(presentation.mode, 'pseudo-tool');
  });

  it('needs no listing and no projection', () => {
    assert.equal(presentation.systemSuffix, undefined);
    const calls = [{ name: 'git-review', args: {} }];
    assert.deepEqual(presentation.project(calls), calls);
  });

  it('rejects a skill name that cannot be a tool name', () => {
    // Otherwise this surfaces as an opaque 400 partway through a paid run.
    const odd: Surface = {
      ...clean,
      items: [{ kind: 'skill', name: 'not a tool name', path: 'x', body: '', frontmatter: {}, raw: {} }],
    };
    assert.throws(() => presentSkills(odd, { mode: 'pseudo-tool' }), /not one/);
  });
});

describe('presentation mode selection', () => {
  it('defaults to the mechanism agents actually use', () => {
    assert.equal(presentSkills(clean).mode, 'skill-tool');
  });

  it('rejects a mode it does not have', () => {
    assert.throws(() => presentSkills(clean, { mode: 'telepathy' }), /Expected skill-tool or pseudo-tool/);
  });
});

describe('skills eval, end to end and offline', () => {
  it('scores recorded dispatch calls as skill selections', async () => {
    const config = await loadConfig(fixture('skills-eval.yaml'));
    const surface = await loadSkills(config.target);
    const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));

    const report = await runEval(config, surface, provider);
    const scores = new Map(report.scenarios.map((s) => [s.id, s]));

    assert.equal(report.presentation, 'skill-tool', 'the mode is part of the result');
    assert.equal(scores.get('review')!.score, 1);
    assert.equal(scores.get('review-near-miss')!.score, 0.6);
    assert.deepEqual(scores.get('review-near-miss')!.confusions, [{ tool: 'git-review', count: 2 }]);
  });

  it('counts an over-call as a miss, naming both skills', () => {
    // Two skills dispatched in one turn is over-eager selection, and the
    // confusion label has to say which two — "Skill + Skill" would not.
    return loadConfig(fixture('skills-eval.yaml')).then(async (config) => {
      const surface = await loadSkills(config.target);
      const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));
      const report = await runEval(config, surface, provider);
      const score = report.scenarios.find((s) => s.id === 'release-notes')!;

      assert.deepEqual(score.confusions, [{ tool: 'changelog + git-review', count: 1 }]);
      assert.equal(score.errors, 1, 'the errored trial leaves the denominator');
      assert.equal(score.selection.total, 4);
    });
  });

  it('refuses to replay trials under a presentation they were not recorded under', async () => {
    // Otherwise skill-tool trials replayed as pseudo-tool project through the
    // identity and score a flat zero, which reads like a finding.
    const config = await loadConfig(fixture('skills-eval.yaml'));
    const surface = await loadSkills(config.target);
    const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));

    await assert.rejects(
      runEval(config, surface, provider, {
        presentation: presentSkills(surface, { mode: 'pseudo-tool' }),
      }),
      /recorded under "skill-tool"/,
    );
  });

  it('does not let a malformed dispatch call fake restraint', async () => {
    const config = await loadConfig(fixture('skills-eval.yaml'));
    const surface = await loadSkills(config.target);
    const provider = await ReplayProvider.fromFile(fixture('trials/skills.json'));

    const report = await runEval(config, surface, provider);
    const score = report.scenarios.find((s) => s.id === 'no-skill-needed')!;

    assert.equal(score.restraint, true);
    assert.equal(score.score, 0.8, 'four clean declines, one bare Skill call');
    assert.deepEqual(score.confusions, [{ tool: 'Skill', count: 1 }]);
  });
});
