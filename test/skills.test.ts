import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import { countSkillBodyTokens, countSkillRoutingTokens } from '../src/analyser/tokens.js';
import { MAX_SKILL_DESCRIPTION } from '../src/analyser/rules/skills.js';
import { loadSurface } from '../src/adapters/index.js';
import { loadSkills, skillsAdapter } from '../src/adapters/skills/index.js';
import { skillsOf } from '../src/surface.js';
import type { Finding, SkillDef, Surface } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/skills/${name}`, import.meta.url));

const clean = await loadSkills(fixture('clean'));
const messy = await loadSkills(fixture('messy'));

const byName = (surface: Surface) => new Map(skillsOf(surface).map((s) => [s.name, s]));
const rulesFired = (findings: Finding[]) => new Set(findings.map((f) => f.rule));
const firedFor = (findings: Finding[], rule: string) =>
  findings.filter((f) => f.rule === rule).map((f) => f.item);

describe('skills loader', () => {
  it('reads every SKILL.md one level down', () => {
    assert.deepEqual(
      clean.items.map((item) => item.name),
      ['changelog', 'git-review'],
    );
    assert.equal(clean.kind, 'skills');
    assert.equal(clean.source.adapter, 'skills');
  });

  it('orders items stably, because the order reaches the cached prefix', async () => {
    const again = await loadSkills(fixture('clean'));
    assert.deepEqual(
      again.items.map((i) => i.name),
      clean.items.map((i) => i.name),
    );
  });

  it('separates the routing description from the body', () => {
    const skill = byName(clean).get('git-review')!;
    assert.match(skill.description!, /^Reviews a pull request diff/);
    assert.match(skill.body, /^# Git review/);
    assert.ok(!skill.body.includes('description:'), 'frontmatter must not leak into the body');
  });

  it('keeps every frontmatter key, not just the ones it models', () => {
    const skill = byName(messy).get('no-description')!;
    assert.deepEqual(skill.frontmatter['allowed-tools'], ['Read', 'Grep']);
    assert.equal(skill.frontmatter.license, 'MIT');
  });

  it('records a parse failure instead of throwing it', () => {
    // One broken file in a set of thirty must not take down the run — and the
    // other seven skills here are the proof that it did not.
    const broken = byName(messy).get('broken')!;
    assert.match(broken.error!, /not valid YAML/);
    assert.equal(messy.items.length, 8);
  });

  it('names a skill after its directory when the frontmatter cannot say', () => {
    assert.ok(byName(messy).has('no-frontmatter'));
    assert.match(byName(messy).get('no-frontmatter')!.error!, /no YAML frontmatter/);
  });

  it('routes a skills directory through the registry', async () => {
    const surface = await loadSurface(fixture('clean'));
    assert.equal(surface.kind, 'skills');
    assert.equal(surface.items.length, 2);
  });

  it('presents through the adapter, not just the bare function', () => {
    assert.equal(skillsAdapter.present(clean).mode, 'skill-tool');
  });
});

describe('skills token cost', () => {
  it('counts routing descriptions only, never bodies', () => {
    const analysis = analyse(clean);
    const routing = skillsOf(clean).reduce((sum, s) => sum + countSkillRoutingTokens(s), 0);
    assert.equal(analysis.tokens.total, routing);
  });

  it('reports body cost separately, and never inside the total', () => {
    // The whole point of progressive disclosure: a big body is harmless, a big
    // description is not. Folding them together would hide exactly that.
    const analysis = analyse(clean);
    const bodies = skillsOf(clean).reduce((sum, s) => sum + countSkillBodyTokens(s), 0);
    assert.equal(analysis.tokens.deferred, bodies);
    assert.ok(bodies > 0);
    assert.ok(analysis.tokens.total < bodies + analysis.tokens.total);
  });

  it('leaves deferred unset for an MCP surface', async () => {
    const mcp = await loadSurface(fileURLToPath(new URL('./fixtures/git-server.json', import.meta.url)));
    assert.equal(analyse(mcp).tokens.deferred, undefined);
  });
});

describe('skills rules', () => {
  it('finds nothing wrong with the clean fixture', () => {
    assert.deepEqual(analyse(clean).findings, []);
  });

  it('skips the MCP-only rules rather than running them empty', () => {
    // Silence and "no findings" must not be the same thing: a schema rule has
    // nothing to say about a skill, so it must not appear to have passed.
    const fired = rulesFired(analyse(messy).findings);
    assert.ok(!fired.has('missing-tool-description'));
    assert.ok(!fired.has('missing-param-description'));
    assert.ok(!fired.has('deep-schema'));
  });

  it('reports a frontmatter that will not parse', () => {
    const findings = analyse(messy).findings;
    assert.deepEqual(firedFor(findings, 'unparseable-skill').sort(), ['broken', 'no-frontmatter']);
  });

  it('does not also call an unparseable skill undescribed', () => {
    // It has no description, but saying so twice buries the actual cause.
    assert.ok(!firedFor(analyse(messy).findings, 'missing-skill-description').includes('broken'));
  });

  it('reports a missing description as an error', () => {
    const findings = analyse(messy).findings;
    assert.deepEqual(firedFor(findings, 'missing-skill-description'), ['no-description']);
    assert.equal(findings.find((f) => f.rule === 'missing-skill-description')!.severity, 'error');
  });

  it('reports a description past the hard limit', () => {
    const finding = analyse(messy).findings.find((f) => f.rule === 'skill-description-length')!;
    assert.equal(finding.item, 'verbose');
    assert.equal(finding.severity, 'error');
    assert.ok((finding.detail!.length as number) > MAX_SKILL_DESCRIPTION);
  });

  it('reports a thin description', () => {
    assert.deepEqual(firedFor(analyse(messy).findings, 'thin-skill-description'), ['thin']);
  });

  it('reports a description that never says when to use the skill', () => {
    const items = firedFor(analyse(messy).findings, 'skill-description-no-triggers');
    assert.ok(items.includes('pdf-tools'));
    assert.ok(!items.includes('find-files'), 'a "use this when" description states its trigger');
  });

  it('catches near-duplicate skills with the rule it already had', () => {
    // near-duplicate-description reads only name and description, so it needed
    // no skills-specific version — it applies to both surfaces unchanged.
    const finding = analyse(messy).findings.find((f) => f.rule === 'near-duplicate-description')!;
    assert.deepEqual(finding.detail!.pair, ['find-files', 'search-files']);
  });
});

describe('finding anchors', () => {
  it('anchors description findings to the frontmatter key', () => {
    const findings = analyse(messy).findings.filter((f) => f.rule.includes('description'));
    assert.ok(findings.length > 0);
    assert.ok(findings.every((f) => f.path === 'description' || f.rule === 'near-duplicate-description'));
  });

  it('points an unparseable skill at its file', () => {
    const finding = analyse(messy).findings.find((f) => f.rule === 'unparseable-skill')!;
    assert.match(finding.message, /SKILL\.md/);
    assert.match((finding.detail as { path: string }).path, /SKILL\.md$/);
  });
});

describe('SkillDef', () => {
  it('carries the path, for anchoring findings', () => {
    const skill: SkillDef = byName(clean).get('changelog')!;
    assert.match(skill.path, /clean[/\\]changelog[/\\]SKILL\.md$/);
  });
});
