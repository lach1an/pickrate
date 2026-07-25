import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTarget, splitCommand } from '../src/connector/target.js';

describe('parseTarget', () => {
  it('recognises an http endpoint', () => {
    const target = parseTarget('https://api.example.com/mcp');
    assert.equal(target.kind, 'http');
  });

  it('treats anything else as a stdio command', () => {
    const target = parseTarget('node ./build/index.js --verbose');
    assert.deepEqual(target, {
      kind: 'stdio',
      command: 'node',
      args: ['./build/index.js', '--verbose'],
      display: 'node ./build/index.js --verbose',
    });
  });

  it('rejects an empty target', () => {
    assert.throws(() => parseTarget('   '), /Empty target/);
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
