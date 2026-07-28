import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mcpAdapter, sameOrder } from '../src/adapters/mcp/index.js';
import { unstableListOrder } from '../src/analyser/rules/cache.js';
import type { Surface, SurfaceSource, ToolDef } from '../src/types.js';

function tool(name: string): ToolDef {
  return { kind: 'tool', name, description: `does ${name}`, inputSchema: { type: 'object' }, raw: {} };
}

function surfaceOf(names: string[], source: Partial<SurfaceSource> = {}): Surface {
  return {
    kind: 'mcp',
    items: names.map(tool),
    source: {
      kind: 'http',
      adapter: 'mcp',
      target: 'https://example.test/mcp',
      fetchedAt: '2026-07-28T00:00:00.000Z',
      ...source,
    },
  };
}

describe('declaration order', () => {
  it('presents the same bytes whatever order the server used', () => {
    const forwards = mcpAdapter.present(surfaceOf(['create_branch', 'delete_branch', 'list_branches']));
    const backwards = mcpAdapter.present(surfaceOf(['list_branches', 'delete_branch', 'create_branch']));

    // The prefix is cached on its bytes, so this is the property that matters:
    // two orderings of one catalogue must be indistinguishable downstream.
    assert.deepEqual(forwards.tools, backwards.tools);
    assert.deepEqual(
      forwards.tools.map((t) => t.name),
      ['create_branch', 'delete_branch', 'list_branches'],
    );
  });

  it('leaves the surface itself in the order the server sent', () => {
    // The analyser reports on what the server did; only the presentation is
    // normalised. Sorting `items` would erase the evidence for the rule below.
    const surface = surfaceOf(['zebra', 'alpha']);
    mcpAdapter.present(surface);
    assert.deepEqual(surface.items.map((i) => i.name), ['zebra', 'alpha']);
  });

  it('does not depend on host collation', () => {
    // `localeCompare` would order these differently under some ICU locales.
    const { tools } = mcpAdapter.present(surfaceOf(['Zed', 'apple', '_internal']));
    assert.deepEqual(tools.map((t) => t.name), ['Zed', '_internal', 'apple']);
  });
});

describe('comparing two listings', () => {
  const a = [tool('one'), tool('two'), tool('three')];

  it('is stable when the order matches', () => {
    assert.equal(sameOrder(a, [tool('one'), tool('two'), tool('three')]), true);
  });

  it('is unstable when the same tools come back reordered', () => {
    assert.equal(sameOrder(a, [tool('two'), tool('one'), tool('three')]), false);
  });

  it('declines to answer when the catalogue itself changed', () => {
    // Added, removed, and swapped. None of these is a reordering, and calling
    // them one would send someone to fix the wrong thing.
    assert.equal(sameOrder(a, [...a, tool('four')]), undefined);
    assert.equal(sameOrder(a, [tool('one'), tool('two')]), undefined);
    assert.equal(sameOrder(a, [tool('one'), tool('two'), tool('four')]), undefined);
  });
});

describe('the unstable-list-order rule', () => {
  it('fires when the adapter measured a reordering', () => {
    const findings = unstableListOrder.run(surfaceOf(['a', 'b'], { listOrderStable: false }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.rule, 'unstable-list-order');
    assert.match(findings[0]!.message, /different order/);
  });

  it('is silent when the order held', () => {
    assert.deepEqual(unstableListOrder.run(surfaceOf(['a', 'b'], { listOrderStable: true })), []);
  });

  it('is silent when nobody checked', () => {
    // Absent is not a pass. A file fixture never re-listed anything, and
    // reporting it as stable claims a measurement that did not happen.
    assert.deepEqual(unstableListOrder.run(surfaceOf(['a', 'b'])), []);
  });

  it('does not apply to skills', () => {
    assert.deepEqual(unstableListOrder.appliesTo, ['mcp']);
  });
});
