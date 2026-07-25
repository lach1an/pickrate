import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseTarget, splitCommand } from '../src/adapters/target.js';

/** A throwaway directory tree, so detection is tested against a real disk. */
function tree(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pickrate-target-'));
  for (const [path, contents] of Object.entries(layout)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('parseTarget', () => {
  it('recognises an http endpoint', () => {
    const target = parseTarget('https://api.example.com/mcp');
    assert.equal(target.adapter, 'mcp');
    assert.equal(target.kind, 'http');
  });

  it('treats anything else as a stdio command', () => {
    const target = parseTarget('node ./build/index.js --verbose');
    assert.deepEqual(target, {
      adapter: 'mcp',
      kind: 'stdio',
      command: 'node',
      args: ['./build/index.js', '--verbose'],
      display: 'node ./build/index.js --verbose',
    });
  });

  it('rejects an empty target', () => {
    assert.throws(() => parseTarget('   '), /Empty target/);
  });

  it('routes a directory of skills to the skills adapter', () => {
    const root = tree({ 'review/SKILL.md': '---\nname: review\n---\n' });
    const target = parseTarget(root);
    assert.equal(target.adapter, 'skills');
    assert.equal(target.kind, 'dir');
  });

  it('routes a single skill directory to the skills adapter', () => {
    const root = tree({ 'SKILL.md': '---\nname: review\n---\n' });
    assert.equal(parseTarget(root).adapter, 'skills');
  });

  it('finds skills under a conventional .claude/skills', () => {
    const root = tree({ '.claude/skills/review/SKILL.md': '---\nname: review\n---\n' });
    const target = parseTarget(root);
    assert.equal(target.adapter, 'skills');
    assert.equal(
      target.kind === 'dir' ? target.path : undefined,
      join(root, '.claude/skills'),
      'resolves to the directory that actually holds the skills',
    );
  });

  it('names both possibilities for a directory holding neither', () => {
    // The first thing a new user hits, and which fix applies depends on what
    // they meant — so the message has to offer both.
    const root = tree({ 'README.md': '# not a skill\n' });
    assert.throws(() => parseTarget(root), /skills target[\s\S]*MCP server/);
  });

  it('honours an explicit --adapter over detection', () => {
    const root = tree({ 'SKILL.md': '---\nname: review\n---\n' });
    // A directory that looks like skills, forced to MCP, becomes a command.
    assert.equal(parseTarget(root, { adapter: 'mcp' }).kind, 'stdio');
    assert.throws(
      () => parseTarget('node ./build/index.js', { adapter: 'skills' }),
      /expects a directory/,
    );
  });
});

describe('splitCommand', () => {
  it('keeps quoted arguments together', () => {
    assert.deepEqual(splitCommand('npx -y some-server --flag "a b c"'), [
      'npx',
      '-y',
      'some-server',
      '--flag',
      'a b c',
    ]);
  });

  it('preserves an intentionally empty argument', () => {
    assert.deepEqual(splitCommand('cmd "" x'), ['cmd', '', 'x']);
  });

  it('rejects an unbalanced quote', () => {
    assert.throws(() => splitCommand('cmd "oops'), /Unbalanced/);
  });
});
