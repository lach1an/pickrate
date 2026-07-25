import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
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

describe('the binary runs when it is invoked', () => {
  it('runs through a symlink, the way npm installs it', async () => {
    // npm installs the bin as `node_modules/.bin/pickrate → dist/cli.js` and
    // does not resolve that link into argv[1]. An entry-point check that
    // compared raw paths would make the published CLI print nothing and exit
    // 0 — success, having measured nothing.
    const link = join(mkdtempSync(join(tmpdir(), 'pickrate-bin-')), 'pickrate');
    symlinkSync(CLI, link);

    const { stdout } = await run(process.execPath, ['--import', 'tsx', link, '--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});

describe('--baseline', () => {
  const BASELINE = fixture('reports/git-server-baseline.json');

  it('is 1 for a regression: measured, and the answer is bad', async () => {
    const { code, stdout } = await cli('run', fixture('pickrate.yaml'), ...REPLAY, '--baseline', BASELINE, '--json');
    const parsed = JSON.parse(stdout);

    assert.equal(code, Exit.Failed);
    assert.equal(parsed.diff.scenarios.filter((s: { regressed: boolean }) => s.regressed).length, 1);
  });

  it('is 2 for a baseline it refuses to compare against', async () => {
    // A skills run against a baseline recorded on an MCP surface. Nothing was
    // measured wrongly — we declined to compare — and sending that to CI as a
    // failing eval would point the reader at the wrong thing entirely.
    const { code } = await cli(
      'run',
      fixture('skills-eval.yaml'),
      '--replay',
      fixture('trials/skills.json'),
      '--baseline',
      BASELINE,
    );
    assert.equal(code, Exit.Unmeasured);
  });

  it('is 2 for a baseline that is not there', async () => {
    const { code } = await cli('run', fixture('pickrate.yaml'), ...REPLAY, '--baseline', fixture('nope.json'));
    assert.equal(code, Exit.Unmeasured);
  });

  it('stops calling it a regression when the tolerance is widened past the drop', async () => {
    const { code, stdout } = await cli(
      'run',
      fixture('pickrate.yaml'),
      ...REPLAY,
      '--baseline',
      BASELINE,
      '--max-regression',
      '0.5',
      '--json',
    );
    const gates: Array<{ id: string; passed: boolean }> = JSON.parse(stdout).gates;

    assert.equal(gates.find((gate) => gate.id === 'max-regression')!.passed, true);
    // Still exit 1 — the per-scenario thresholds fail on this fixture whatever
    // the baseline says. The regression is simply no longer one of the reasons.
    assert.equal(code, Exit.Failed);
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
