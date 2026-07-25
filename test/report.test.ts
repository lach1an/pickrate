import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { loadManifestFromFile } from '../src/adapters/mcp/index.js';
import { ReplayProvider } from '../src/provider/replay.js';
import { formatEvalReport } from '../src/report/eval.js';
import { formatEvalReportJson, SCHEMA_VERSION } from '../src/report/json.js';
import { runEval } from '../src/runner/index.js';
import type { EvalReport } from '../src/types.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function replayReport(): Promise<EvalReport> {
  const config = await loadConfig(fixture('pickrate.yaml'));
  const manifest = await loadManifestFromFile(fixture('git-server.json'));
  const provider = await ReplayProvider.fromFile(fixture('trials/git-server.json'));
  return runEval(config, manifest, provider);
}

describe('eval report', () => {
  it('exposes the fields a CI consumer pins on', async () => {
    const parsed = JSON.parse(formatEvalReportJson(await replayReport()));

    assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
    assert.equal(parsed.command, 'run');
    assert.equal(typeof parsed.model, 'string');
    assert.deepEqual(parsed.summary, { scenarios: 4, failed: 3, flaky: 2, errored: 1 });
    assert.deepEqual(parsed.orphans, ['delete_branch']);
    assert.equal(typeof parsed.usage.cacheReadInputTokens, 'number');
  });

  it('names the model under test — it is part of the result', async () => {
    const report = await replayReport();
    assert.match(formatEvalReport(report), new RegExp(report.model));
  });

  it('puts diagnostics above the summary line', async () => {
    // Goodhart: whoever optimises the number will write descriptions that game
    // it, so what to fix must outrank how well you scored.
    const text = stripAnsi(formatEvalReport(await replayReport()));
    const confusion = text.indexOf('confusion');
    const orphans = text.indexOf('orphans');
    const summary = text.indexOf('below threshold');

    assert.ok(confusion > 0 && orphans > 0 && summary > 0);
    assert.ok(confusion < summary, 'confusion pairs must precede the summary');
    assert.ok(orphans < summary, 'orphans must precede the summary');
  });

  it('surfaces the argument/selection split when they disagree', async () => {
    const text = stripAnsi(formatEvalReport(await replayReport()));
    assert.match(text, /picked the right tool, wrong arguments 3\/4/);
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}
