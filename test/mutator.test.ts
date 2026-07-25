import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { loadSkills } from '../src/adapters/skills/index.js';
import { skillsAdapter } from '../src/adapters/skills/index.js';
import { analyse } from '../src/analyser/index.js';
import {
  DECOY_COUNT,
  blankDescription,
  injectDecoys,
  operators,
  planMutants,
  swapDescriptions,
} from '../src/mutator/index.js';
import type { Surface } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const mcpSurface = () => loadManifestFromFile(fixture('git-server.json'));
const skillsSurface = () => loadSkills(fixture('skills/clean'));

describe('operators', () => {
  it('never touch the surface they are given', async () => {
    // The baseline surface is re-used for every mutant in a session. An
    // operator that mutated in place would poison every measurement after it,
    // and the only symptom would be the mutation score itself.
    for (const surface of [await mcpSurface(), await skillsSurface()]) {
      const before = structuredClone(surface);
      for (const operator of operators) {
        for (const mutant of operator.enumerate(surface)) {
          mutant.apply(surface);
          assert.deepEqual(surface, before, `${mutant.id} mutated its input`);
        }
      }
    }
  });

  it('enumerate the same mutants in the same order every time', async () => {
    const surface = await mcpSurface();
    const ids = () => operators.flatMap((op) => op.enumerate(surface).map((m) => m.id));
    assert.deepEqual(ids(), ids());
  });

  it('apply to both surface kinds', async () => {
    for (const surface of [await mcpSurface(), await skillsSurface()]) {
      for (const operator of operators) {
        assert.ok(operator.appliesTo.includes(surface.kind), `${operator.id} skips ${surface.kind}`);
        assert.ok(operator.enumerate(surface).length > 0, `${operator.id} enumerated nothing`);
      }
    }
  });
});

describe('blank-description', () => {
  it('empties exactly one description and nothing else', async () => {
    const surface = await mcpSurface();
    const mutant = blankDescription
      .enumerate(surface)
      .find((m) => m.targets[0] === 'create_branch')!;
    const damaged = mutant.apply(surface);

    assert.equal(itemNamed(damaged, 'create_branch').description, '');
    assert.equal(
      itemNamed(damaged, 'delete_branch').description,
      itemNamed(surface, 'delete_branch').description,
    );
  });

  it('mirrors into raw, so inspecting a mutant reports the mutant', async () => {
    // A mutant whose --json output still showed the original description would
    // be a surface nobody could audit after the fact.
    const surface = await mcpSurface();
    const damaged = blankDescription.enumerate(surface)[0]!.apply(surface);
    const target = damaged.items[0]!;

    assert.equal(target.raw.description, '');
    const findings = analyse(damaged).findings;
    assert.ok(
      findings.some((f) => f.rule === 'missing-tool-description' && f.item === target.name),
      'the injected defect should be the one inspect reports',
    );
  });

  it('mirrors into skill frontmatter too', async () => {
    const surface = await skillsSurface();
    const damaged = blankDescription.enumerate(surface)[0]!.apply(surface);
    const skill = damaged.items[0]!;

    assert.equal(skill.kind, 'skill');
    assert.equal(skill.description, '');
    assert.equal(skill.raw.description, '');
    if (skill.kind === 'skill') assert.equal(skill.frontmatter.description, '');
  });

  it('skips items that have nothing to blank', async () => {
    // A skill that failed to parse cannot be offered to a model at all, so
    // damaging it would inject a defect nothing could ever have detected.
    const messy = await loadSkills(fixture('skills/messy'));
    const targets = blankDescription.enumerate(messy).flatMap((m) => m.targets);

    for (const item of messy.items) {
      const blankable = (item.description ?? '').trim() !== '' && item.kind === 'skill' && !item.error;
      assert.equal(targets.includes(item.name), blankable, `${item.name} was misclassified`);
    }
  });
});

describe('swap-descriptions', () => {
  it('trades two descriptions and leaves the names alone', async () => {
    const surface = await mcpSurface();
    const mutant = swapDescriptions.enumerate(surface)[0]!;
    const damaged = mutant.apply(surface);

    const [a, b] = mutant.targets as [string, string];
    assert.equal(itemNamed(damaged, a).description, itemNamed(surface, b).description);
    assert.equal(itemNamed(damaged, b).description, itemNamed(surface, a).description);
    assert.deepEqual(
      damaged.items.map((i) => i.name),
      surface.items.map((i) => i.name),
    );
  });

  it('enumerates every unordered pair once', async () => {
    const surface = await mcpSurface();
    const mutants = swapDescriptions.enumerate(surface);
    const n = surface.items.length;

    assert.equal(mutants.length, (n * (n - 1)) / 2);
    assert.equal(new Set(mutants.map((m) => m.id)).size, mutants.length);
  });
});

describe('inject-decoys', () => {
  it('adds exactly DECOY_COUNT items without disturbing the real ones', async () => {
    const surface = await mcpSurface();
    const damaged = injectDecoys.enumerate(surface)[0]!.apply(surface);

    assert.equal(damaged.items.length, surface.items.length + DECOY_COUNT);
    assert.deepEqual(damaged.items.slice(0, surface.items.length), surface.items);
    assert.equal(new Set(damaged.items.map((i) => i.name)).size, damaged.items.length);
  });

  it('suffixes rather than skips on a name collision', async () => {
    // Injecting eighteen decoys because two names clashed would make the
    // mutant something other than what the report says it is.
    const surface: Surface = {
      ...(await mcpSurface()),
      items: [{ kind: 'tool', name: 'list_invoices', description: 'x', inputSchema: {}, raw: {} }],
    };
    const damaged = injectDecoys.enumerate(surface)[0]!.apply(surface);

    assert.equal(damaged.items.length, 1 + DECOY_COUNT);
    assert.ok(damaged.items.some((i) => i.name === 'list_invoices_2'));
  });

  it('puts decoys into both the enum and the listing on a skills surface', async () => {
    // skill-tool mode carries names twice — once in the dispatch enum, once in
    // the system listing. A decoy in only one of them is half a mutant.
    const surface = await skillsSurface();
    const damaged = injectDecoys.enumerate(surface)[0]!.apply(surface);
    const presentation = skillsAdapter.present(damaged, { mode: 'skill-tool' });

    const properties = presentation.tools[0]!.inputSchema.properties as {
      skill: { enum: string[] };
    };
    assert.equal(properties.skill.enum.length, surface.items.length + DECOY_COUNT);
    assert.ok(properties.skill.enum.includes('list_invoices'));
    assert.match(presentation.systemSuffix!, /- list_invoices: /);
  });

  it('leaves deferred token cost alone', async () => {
    // Decoy bodies are never resident, so giving them bodies would inflate a
    // number the model never sees while choosing. Resident cost is the point.
    const surface = await skillsSurface();
    const damaged = injectDecoys.enumerate(surface)[0]!.apply(surface);

    assert.equal(analyse(damaged).tokens.deferred, analyse(surface).tokens.deferred);
    assert.ok(analyse(damaged).tokens.total > analyse(surface).tokens.total);
  });
});

describe('planMutants', () => {
  it('spreads a small budget across operators rather than down one', async () => {
    // Three mutants that are all blank-description would measure one thing
    // three times and report it as a mutation score out of three.
    const plan = planMutants(await mcpSurface(), { limit: 3 });

    assert.equal(plan.length, 3);
    assert.deepEqual(plan.map((m) => m.operator), [
      'blank-description',
      'swap-descriptions',
      'inject-decoys',
    ]);
  });

  it('is byte-identical run to run', async () => {
    const surface = await mcpSurface();
    const ids = (s: typeof surface) => planMutants(s, { limit: 5 }).map((m) => m.id);
    assert.deepEqual(ids(surface), ids(surface));
  });

  it('returns fewer than asked when the surface offers fewer', async () => {
    const plan = planMutants(await mcpSurface(), { limit: 500 });
    // 3 blanks + 3 swaps + 1 decoy injection, and no more invented.
    assert.equal(plan.length, 7);
  });

  it('honours an operator filter and rejects unknown ids', async () => {
    const surface = await mcpSurface();
    const plan = planMutants(surface, { operators: ['blank-description'], limit: 10 });

    assert.deepEqual(plan.map((m) => m.operator), Array(3).fill('blank-description'));
    assert.throws(() => planMutants(surface, { operators: ['no-such-operator'] }), /Unknown mutation operator/);
  });
});

function itemNamed(surface: Surface, name: string) {
  return surface.items.find((item) => item.name === name)!;
}
