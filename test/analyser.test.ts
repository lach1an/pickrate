import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { analyse } from '../src/analyser/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import type { Analysis } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));

async function analyseFixture(name: string): Promise<Analysis> {
  return analyse(await loadManifestFromFile(fixture(name)));
}

const rulesFired = (analysis: Analysis) => new Set(analysis.findings.map((f) => f.rule));

describe('analyser', () => {
  it('reads a manifest from a captured tools/list response', async () => {
    const surface = await loadManifestFromFile(fixture('git-server'));
    assert.equal(surface.kind, 'mcp');
    assert.equal(surface.items.length, 3);
    assert.ok(surface.items.every((item) => item.kind === 'tool'));
    assert.deepEqual(
      surface.items.map((t) => t.name),
      ['create_branch', 'delete_branch', 'list_branches'],
    );
  });

  it('reports a token cost that sums the per-item breakdown', async () => {
    const { tokens } = await analyseFixture('git-server');
    assert.ok(tokens.total > 0);
    assert.equal(
      tokens.total,
      tokens.perItem.reduce((sum, t) => sum + t.tokens, 0),
    );
    assert.ok(tokens.perItem.every((t, i, all) => i === 0 || all[i - 1]!.tokens >= t.tokens));
  });

  it('finds nothing to complain about in a well-written manifest', async () => {
    const analysis = await analyseFixture('git-server');
    assert.deepEqual(
      analysis.findings.filter((f) => f.severity !== 'info'),
      [],
      `unexpected findings: ${JSON.stringify(analysis.findings, null, 2)}`,
    );
  });

  it('catches the whole spread of defects in a messy manifest', async () => {
    const fired = rulesFired(await analyseFixture('messy-server'));
    for (const rule of [
      'missing-tool-description',
      'thin-tool-description',
      'near-duplicate-description',
      'missing-param-description',
      'enum-candidate',
      'deep-schema',
    ]) {
      assert.ok(fired.has(rule), `expected ${rule} to fire`);
    }
  });

  it('anchors findings to the item and parameter they concern', async () => {
    const analysis = await analyseFixture('messy-server');

    const missingDesc = analysis.findings.find((f) => f.rule === 'missing-tool-description');
    assert.equal(missingDesc?.item, 'op_7');

    const missingParam = analysis.findings.find(
      (f) => f.rule === 'missing-param-description' && f.item === 'op_7',
    );
    assert.equal(missingParam?.path, 'target');

    const duplicate = analysis.findings.find((f) => f.rule === 'near-duplicate-description');
    assert.deepEqual(duplicate?.detail?.pair, ['fetch_user', 'get_user']);
  });

  it('sorts findings by severity so errors lead the report', async () => {
    const { findings } = await analyseFixture('messy-server');
    const order = { error: 0, warn: 1, info: 2 };
    for (let i = 1; i < findings.length; i++) {
      assert.ok(order[findings[i - 1]!.severity] <= order[findings[i]!.severity]);
    }
  });

  it('honours disabled rules', async () => {
    const surface = await loadManifestFromFile(fixture('messy-server'));
    const analysis = analyse(surface, { disable: ['missing-tool-description'] });
    assert.ok(!rulesFired(analysis).has('missing-tool-description'));
  });
});
