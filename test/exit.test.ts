import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { Exit } from '../src/exit.js';

/**
 * The exit-code contract, driven end to end.
 *
 * Everything here replays a recorded fixture, so the whole table is asserted
 * with no API key and no spend — which is also what lets the repo's own CI
 * exercise it on every push.
 *
 * In a child process rather than by calling `main` directly, because the
 * contract is about the *process* status: the top-level catch and the
 * "only run when invoked as the binary" guard are part of what CI reads, and
 * an in-process call would assert around both of them.
 */

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const REPLAY = ['--replay', fixture('trials/git-server.json')];

const run = promisify(execFile);

async function cli(...argv: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', CLI, ...argv]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '' };
  }
}

describe('exit codes', () => {
  it('0 when measured and every gate passed', async () => {
    const { code } = await cli('inspect', fixture('git-server.json'));
    assert.equal(code, Exit.Ok);
  });

  it('1 when measured and the answer is bad', async () => {
    // Three of four scenarios below threshold on the replay fixture.
    const run = await cli('run', fixture('pickrate.yaml'), ...REPLAY);
    assert.equal(run.code, Exit.Failed);

    const inspect = await cli('inspect', fixture('messy-server.json'), '--fail-on', 'error');
    assert.equal(inspect.code, Exit.Failed);
  });

  it('2 when it could not measure, even though the eval also failed', async () => {
    // The distinction the whole table exists for: this run *also* breaches its
    // thresholds, and reporting that would send someone to fix a manifest that
    // was never the problem.
    const { code } = await cli('run', fixture('pickrate.yaml'), ...REPLAY, '--max-error-rate', '0');
    assert.equal(code, Exit.Unmeasured);
  });

  it('2 on a usage error, never 1', async () => {
    assert.equal((await cli('run')).code, Exit.Unmeasured);
    assert.equal((await cli('nonsense')).code, Exit.Unmeasured);
    assert.equal((await cli()).code, Exit.Unmeasured);
  });

  it('0 for --help and --version, which are not measurements', async () => {
    assert.equal((await cli('--help')).code, Exit.Ok);
    assert.equal((await cli('--version')).code, Exit.Ok);
  });

  it('0 for --dry-run: nothing was measured and nothing was spent', async () => {
    const { code } = await cli('run', fixture('pickrate.yaml'), ...REPLAY, '--dry-run');
    assert.equal(code, Exit.Ok);
  });
});

describe('gates from the config file', () => {
  it('inspect reads target: and ci: from --config', async () => {
    // No positional target at all: the Action passes one file and nothing else.
    const { code, stdout } = await cli('inspect', '--config', fixture('ci.yaml'), '--json');
    const parsed = JSON.parse(stdout);

    assert.equal(code, Exit.Failed);
    assert.match(parsed.source.target, /messy-server\.json$/);
    assert.deepEqual(
      parsed.gates.map((g: { id: string; passed: boolean }) => [g.id, g.passed]),
      [
        ['fail-on', false],
        ['max-tokens', false],
      ],
    );
  });

  it('lets a flag override the file', async () => {
    // `--fail-on none` against a config that sets `failOn: error`.
    const { code } = await cli('inspect', '--config', fixture('ci.yaml'), '--fail-on', 'none');
    // max-tokens still breaches — the override is one gate, not a bypass.
    assert.equal(code, Exit.Failed);
  });

  it('applies ci: gates to run', async () => {
    const { code, stdout } = await cli(
      'run',
      fixture('pickrate.yaml'),
      ...REPLAY,
      '--max-flaky',
      '0',
      '--json',
    );
    const ids = JSON.parse(stdout).gates.map((g: { id: string }) => g.id);

    assert.equal(code, Exit.Failed);
    assert.deepEqual(ids, ['max-error-rate', 'max-flaky', 'thresholds']);
  });
});

describe('--out', () => {
  it('writes JSON whatever went to stdout', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pickrate-')), 'report.json');
    const { stdout } = await cli('run', fixture('pickrate.yaml'), ...REPLAY, '--out', path);

    // One run, two artifacts: the Action wants a table for the step summary and
    // JSON for the upload, and running the eval twice would double the bill.
    assert.match(stdout, /pickrate run/);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(parsed.command, 'run');
    assert.equal(parsed.scenarios.length, 4);
  });

  it('rejects a --format that disagrees with --json', async () => {
    const { code } = await cli('inspect', fixture('git-server.json'), '--json', '--format', 'table');
    assert.equal(code, Exit.Unmeasured);
  });
});
