import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { adapterFor, loadSurface } from '../src/adapters/index.js';
import { mcpAdapter } from '../src/adapters/mcp/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('adapter registry', () => {
  it('routes a manifest file to the mcp adapter', async () => {
    const surface = await loadSurface(fixture('git-server.json'));
    assert.equal(surface.kind, 'mcp');
    assert.equal(surface.source.adapter, 'mcp');
    assert.equal(surface.items.length, 3);
  });

  it('says so plainly when an adapter does not exist yet', () => {
    // parseTarget can already resolve a skills target, so this must be a
    // straight answer rather than the MCP adapter quietly having a go.
    assert.throws(() => adapterFor('skills'), /skills adapter is not implemented/);
  });
});

describe('mcp presentation', () => {
  it('offers every tool, with its description and schema intact', async () => {
    const surface = await loadSurface(fixture('git-server.json'));
    const { tools } = mcpAdapter.present(surface);

    assert.deepEqual(
      tools.map((t) => t.name),
      surface.items.map((i) => i.name),
    );
    assert.ok(tools.every((t) => typeof t.description === 'string'));
    assert.ok(tools.every((t) => typeof t.inputSchema === 'object'));
  });

  it('adds nothing to the system prompt', async () => {
    // The cached prefix must stay exactly what M2 measured against. Only the
    // skills adapter has a reason to append, and it does not exist yet.
    const surface = await loadSurface(fixture('git-server.json'));
    assert.equal(mcpAdapter.present(surface).systemSuffix, undefined);
  });

  it('projects calls to selections unchanged', async () => {
    // For MCP, selecting and calling are the same act — the identity here is
    // what makes the scorer's string equality correct.
    const surface = await loadSurface(fixture('git-server.json'));
    const calls = [{ name: 'create_branch', args: { name: 'feature-login' } }];
    assert.deepEqual(mcpAdapter.present(surface).project(calls), calls);
  });

  it('presents deterministically, so the cached prefix is byte-stable', async () => {
    // Warm-then-fan-out depends on this: a presentation that varied between
    // trials would make every one of them a cache miss, and the only symptom
    // would be a bill roughly 10× what was estimated.
    const surface = await loadSurface(fixture('git-server.json'));
    assert.equal(
      JSON.stringify(mcpAdapter.present(surface).tools),
      JSON.stringify(mcpAdapter.present(surface).tools),
    );
  });
});
