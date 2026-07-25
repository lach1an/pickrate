#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { analyse } from './analyser/index.js';
import { loadConfig } from './config/index.js';
import { adapterFor, loadSurface, type LoadOptions, type Presentation } from './adapters/index.js';
import { AnthropicProvider, CredentialError } from './provider/anthropic.js';
import { formatUsd } from './provider/pricing.js';
import { ReplayProvider } from './provider/replay.js';
import type { CostEstimate, Provider } from './provider/index.js';
import { formatEvalReport } from './report/eval.js';
import { formatAnalysisJson, formatEvalReportJson } from './report/json.js';
import { formatAnalysis } from './report/table.js';
import { runEval, totalTrials } from './runner/index.js';
import type { EvalConfig, Severity, SurfaceKind } from './types.js';

const VERSION = '0.0.0';

const USAGE = `
${pc.bold('pickrate')} — does an agent actually pick your tools and skills correctly?

${pc.bold('Usage')}
  pickrate inspect <target> [options]     static analysis — no API key, no cost
  pickrate run <config.yaml> [options]    tool-selection eval — needs a model

${pc.bold('Targets')}
  "node ./build/index.js"        stdio MCP server (quote the whole command)
  https://api.example.com/mcp    streamable HTTP MCP server
  ./manifest.json                a captured tools/list response
  ./.claude/skills               a directory of SKILL.md files

${pc.bold('inspect options')}
  --json                  machine-readable output
  --fail-on <severity>    exit 1 when findings at or above this level exist
                          (error | warn | info | none, default: none)
  --disable <ids>         comma-separated rule ids to skip

${pc.bold('run options')}
  --json                  machine-readable output
  --dry-run               print the cost estimate and exit without spending
  --yes                   skip the cost confirmation
  --model <id>            override defaults.model
  --trials <n>            override defaults.trials
  --replay <file>         replay recorded trials instead of calling a model
  --presentation <mode>   skills only: skill-tool (default) or pseudo-tool

${pc.bold('shared options')}
  --adapter <id>          force mcp or skills, skipping target detection
  --header <k=v>          extra HTTP header (repeatable)
  --env <k=v>             extra env var for stdio servers (repeatable)
  --timeout <ms>          connection budget (default: 30000)
  -h, --help              this
  -v, --version           version

${pc.dim('inspect makes no model calls and needs no API key.')}
`;

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warn: 2, info: 1 };

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'none' },
      disable: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      model: { type: 'string' },
      trials: { type: 'string' },
      replay: { type: 'string' },
      presentation: { type: 'string' },
      adapter: { type: 'string' },
      header: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const [command, target] = positionals;

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }

  const loadOptions: LoadOptions & { adapter?: SurfaceKind } = {
    ...(values.header ? { headers: parsePairs(values.header, '--header') } : {}),
    ...(values.env ? { env: parsePairs(values.env, '--env') } : {}),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
    ...(values.adapter ? { adapter: parseAdapter(values.adapter) } : {}),
  };

  if (command === 'inspect') {
    if (target === undefined) {
      process.stderr.write(`inspect needs a target.\n${USAGE}\n`);
      return 2;
    }
    return inspect(target, loadOptions, values);
  }

  if (command === 'run') {
    if (target === undefined) {
      process.stderr.write(`run needs a config file.\n${USAGE}\n`);
      return 2;
    }
    return run(target, loadOptions, values);
  }

  process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
  return 2;
}

/* -------------------------------------------------------------------------- */

type Values = Record<string, unknown>;

async function inspect(target: string, loadOptions: LoadOptions, values: Values): Promise<number> {
  const failOn = parseFailOn(values['fail-on'] as string | undefined);
  const surface = await loadSurface(target, loadOptions);
  const disable = values.disable as string | undefined;
  const analysis = analyse(surface, {
    ...(disable ? { disable: disable.split(',').map((id) => id.trim()) } : {}),
  });

  process.stdout.write(
    values.json ? `${formatAnalysisJson(analysis)}\n` : `${formatAnalysis(analysis)}\n`,
  );

  if (failOn === null) return 0;
  const breached = analysis.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]);
  return breached ? 1 : 0;
}

async function run(configPath: string, loadOptions: LoadOptions, values: Values): Promise<number> {
  const config = applyOverrides(await loadConfig(configPath), values);
  const json = values.json === true;

  const surface = await loadSurface(config.target, loadOptions);
  const replay = values.replay as string | undefined;
  const provider: Provider = replay
    ? await ReplayProvider.fromFile(replay)
    : new AnthropicProvider({ model: config.defaults.model });

  // The same presentation the runner will use, so the estimate prices the
  // request that actually runs rather than an approximation of it.
  const mode = (values.presentation as string | undefined) ?? config.defaults.presentation;
  const presentation = adapterFor(surface.kind).present(surface, mode !== undefined ? { mode } : {});

  const trials = totalTrials(config);
  const estimate = await preflight(provider, config, presentation, trials, json);

  if (values['dry-run'] === true) {
    if (!json) process.stderr.write(pc.dim('  --dry-run: nothing was spent.\n\n'));
    return 0;
  }

  if (estimate && !json && values.yes !== true && process.stdin.isTTY) {
    if (!(await confirm())) {
      process.stderr.write(pc.dim('  Cancelled.\n'));
      return 130;
    }
  }

  const onProgress = json ? undefined : renderProgress();
  const report = await runEval(config, surface, provider, {
    presentation,
    ...(onProgress ? { onProgress } : {}),
  });
  await provider.close?.();

  process.stdout.write(json ? `${formatEvalReportJson(report)}\n` : `${formatEvalReport(report)}\n`);

  // A run that could not measure anything must not look like a pass.
  const errored = report.scenarios.reduce((sum, s) => sum + s.errors, 0);
  if (errored === trials) return 2;
  return report.scenarios.every((s) => s.passed) ? 0 : 1;
}

/** Price the run before spending, using the free token-counting endpoint. */
async function preflight(
  provider: Provider,
  config: EvalConfig,
  presentation: Presentation,
  trials: number,
  json: boolean,
): Promise<CostEstimate | undefined> {
  if (!provider.estimate) return undefined;

  let estimate: CostEstimate;
  try {
    estimate = await provider.estimate(presentation, config.scenarios, trials);
  } catch (error) {
    // Missing credentials are the one estimate failure worth stopping for:
    // every trial would fail the same way a moment later.
    if (error instanceof CredentialError) throw error;
    // Otherwise the estimate is a courtesy, not a gate.
    if (!json) {
      process.stderr.write(
        pc.yellow(`  Could not estimate cost: ${error instanceof Error ? error.message : String(error)}\n`),
      );
    }
    return undefined;
  }

  if (json) return estimate;

  const cost =
    estimate.estimatedUsd === undefined
      ? pc.dim('(no price on file for this model)')
      : `~${formatUsd(estimate.estimatedUsd)}`;

  process.stderr.write(
    `\n${pc.bold('pickrate run')}  ${pc.dim(config.path)}\n` +
      `  ${pc.bold('model')}     ${estimate.model}\n` +
      pc.dim(`  manifest  ~${estimate.inputTokensPerTrial.toLocaleString()} input tokens per trial\n`) +
      pc.dim(`  trials    ${trials} across ${config.scenarios.length} scenarios\n`) +
      `  ${pc.bold('estimate')}  ${cost}\n\n`,
  );
  return estimate;
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('  Proceed? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * Single-line progress on stderr, so `--json` on stdout stays clean.
 *
 * Only when stderr is a terminal: `\r` does nothing in a pipe or a log file,
 * where it would smear every update onto one unreadable line.
 */
function renderProgress() {
  if (!process.stderr.isTTY) return undefined;
  return ({ completed, total, scenario }: { completed: number; total: number; scenario: { id: string } }) => {
    process.stderr.write(`\r${' '.repeat(72)}\r  ${completed}/${total} trials  ${pc.dim(scenario.id)}`);
    if (completed === total) process.stderr.write('\n');
  };
}

function applyOverrides(config: EvalConfig, values: Values): EvalConfig {
  const model = values.model as string | undefined;
  const trials = values.trials as string | undefined;
  if (model === undefined && trials === undefined) return config;

  const parsedTrials = trials === undefined ? undefined : Number(trials);
  if (parsedTrials !== undefined && (!Number.isInteger(parsedTrials) || parsedTrials < 1)) {
    throw new Error(`--trials must be a positive integer (got "${trials}")`);
  }

  return {
    ...config,
    defaults: {
      ...config.defaults,
      ...(model !== undefined ? { model } : {}),
      ...(parsedTrials !== undefined ? { trials: parsedTrials } : {}),
    },
    // A per-scenario trials override would silently defeat --trials.
    scenarios:
      parsedTrials === undefined
        ? config.scenarios
        : config.scenarios.map(({ trials: _ignored, ...rest }) => rest),
  };
}

function parseAdapter(value: string): SurfaceKind {
  if (value === 'mcp' || value === 'skills') return value;
  throw new Error(`--adapter must be one of: mcp, skills (got "${value}")`);
}

function parseFailOn(value: string | undefined): Severity | null {
  if (value === undefined || value === 'none') return null;
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  throw new Error(`--fail-on must be one of: error, warn, info, none (got "${value}")`);
}

function parsePairs(entries: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index <= 0) throw new Error(`${flag} expects key=value (got "${entry}")`);
    out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${pc.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
