import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ConfigError, DEFAULTS, loadConfig, parseConfig, thresholdFor, trialsFor } from '../src/config/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const minimal = {
  server: { transport: 'stdio', command: 'node ./build/index.js' },
  scenarios: [{ id: 'a', prompt: 'do the thing', expect: { tool: 'do_thing' } }],
};

describe('config', () => {
  it('loads the fixture config', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    assert.equal(config.scenarios.length, 4);
    assert.equal(config.defaults.model, 'claude-haiku-4-5');
  });

  it('resolves a file manifest relative to the config, not the cwd', async () => {
    const config = await loadConfig(fixture('pickrate.yaml'));
    assert.ok(config.target.endsWith('/test/fixtures/git-server.json'), config.target);
  });

  it('collapses a stdio server into a connector target', () => {
    assert.equal(parseConfig(minimal).target, 'node ./build/index.js');
  });

  it('accepts target: as the general spelling, and server: as it always was', () => {
    // A skills directory is not a server. Renaming without a break costs one
    // line, and every config written against M2 keeps working.
    const viaTarget = parseConfig({
      target: { type: 'stdio', command: 'node ./build/index.js' },
      scenarios: minimal.scenarios,
    });
    assert.equal(viaTarget.target, parseConfig(minimal).target);
  });

  it('resolves a skills path relative to the config', async () => {
    const config = await loadConfig(fixture('skills-eval.yaml'));
    assert.ok(config.target.endsWith('/test/fixtures/skills/clean'), config.target);
    assert.equal(config.defaults.presentation, 'skill-tool');
  });

  it('accepts expect.select as an alias for expect.tool', () => {
    const config = parseConfig({
      ...minimal,
      scenarios: [{ id: 'a', prompt: 'x', expect: { select: 'some-skill' } }],
    });
    assert.equal(config.scenarios[0]!.expect.tool, 'some-skill');
  });

  it('refuses both spellings at once rather than picking one', () => {
    assert.throws(
      () =>
        parseConfig({
          ...minimal,
          scenarios: [{ id: 'a', prompt: 'x', expect: { select: 'a', tool: 'b' } }],
        }),
      /same field/,
    );
  });

  it('applies defaults when the block is absent', () => {
    assert.deepEqual(parseConfig(minimal).defaults, DEFAULTS);
  });

  it('distinguishes an explicit tool: null from a missing key', () => {
    const restraint = parseConfig({
      ...minimal,
      scenarios: [{ id: 'r', prompt: 'hi', expect: { tool: null } }],
    });
    assert.equal(restraint.scenarios[0]!.expect.tool, null);

    assert.throws(
      () => parseConfig({ ...minimal, scenarios: [{ id: 'r', prompt: 'hi', expect: {} }] }),
      // Reported under the canonical spelling, `select`, even though `tool`
      // is still accepted — the error should teach the current name.
      (error: unknown) => error instanceof ConfigError && error.path === 'scenarios[0].expect.select',
    );
  });

  it('rejects a restraint check that also asserts arguments', () => {
    assert.throws(
      () =>
        parseConfig({
          ...minimal,
          scenarios: [{ id: 'r', prompt: 'hi', expect: { tool: null, args: { a: 1 } } }],
        }),
      /cannot assert arguments/,
    );
  });

  it('rejects duplicate scenario ids', () => {
    assert.throws(
      () => parseConfig({ ...minimal, scenarios: [...minimal.scenarios, ...minimal.scenarios] }),
      /duplicate scenario id "a"/,
    );
  });

  it('points at the offending path on a bad value', () => {
    assert.throws(
      () =>
        parseConfig({
          ...minimal,
          scenarios: [{ ...minimal.scenarios[0]!, threshold: 20 }],
        }),
      (error: unknown) =>
        error instanceof ConfigError && error.path === 'scenarios[0].threshold',
    );
  });

  it('rejects an empty scenario list', () => {
    assert.throws(() => parseConfig({ ...minimal, scenarios: [] }), /at least one scenario/);
  });

  it('lets a scenario override trials and threshold', () => {
    const config = parseConfig({
      ...minimal,
      defaults: { trials: 20, threshold: 0.9 },
      scenarios: [
        { id: 'a', prompt: 'x', expect: { tool: 't' } },
        { id: 'b', prompt: 'y', expect: { tool: 't' }, threshold: 0.99, trials: 40 },
      ],
    });

    assert.equal(trialsFor(config.scenarios[0]!, config.defaults), 20);
    assert.equal(thresholdFor(config.scenarios[0]!, config.defaults), 0.9);
    assert.equal(trialsFor(config.scenarios[1]!, config.defaults), 40);
    assert.equal(thresholdFor(config.scenarios[1]!, config.defaults), 0.99);
  });
});
