#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { analyse } from './analyser/index.js';
import { DEFAULT_GATES, loadConfig } from './config/index.js';
import { adapterFor, loadSurface, type LoadOptions, type Presentation } from './adapters/index.js';
import {
  evaluateAnalysisGates,
  evaluateMutationGates,
  evaluateRunGates,
  exitCodeFor,
} from './ci/gates.js';
import { diffReports } from './ci/compare.js';
import { readReportFile } from './ci/report-file.js';
import { Exit, type ExitCode } from './exit.js';
import { formatUsd } from './provider/pricing.js';
import { ReplayProvider } from './provider/replay.js';
import { CredentialError, providerFor, PROVIDER_IDS } from './provider/index.js';
import type { CostEstimate, Provider, ProviderChoice } from './provider/index.js';
import {
  BASELINE_RUNS,
  DEFAULT_MUTANTS,
  planMutants,
  runMutation,
  type MutationProgress,
} from './mutator/index.js';
import { formatEvalReport } from './report/eval.js';
import { formatGates } from './report/gates.js';
import {
  formatAnalysisJson,
  formatEvalReportJson,
  formatMutationReportJson,
  type CiExtras,
} from './report/json.js';
import {
  formatAnalysisMarkdown,
  formatEvalMarkdown,
  formatMutationMarkdown,
} from './report/markdown.js';
import { formatMutationReport } from './report/mutation.js';
import { formatAnalysis } from './report/table.js';
import { runEval, totalTrials } from './runner/index.js';
import type { RunProgress } from './runner/index.js';
import type { CiGates, EvalConfig, GateResult, Severity, SurfaceKind, TrialResult } from './types.js';

/** Duplicated from `package.json`; the schema-freeze test asserts they match. */
export const VERSION = '0.1.0';

const USAGE = `
${pc.bold('pickrate')} — does an agent actually pick your tools and skills correctly?

${pc.bold('Usage')}
  pickrate inspect <target> [options]     static analysis — no API key, no cost
  pickrate run <config.yaml> [options]    selection eval — needs a model
  pickrate mutate <config.yaml> [options] break the surface on purpose, check
                                          the eval noticed — needs a model

${pc.bold('Targets')}
  "node ./build/index.js"        stdio MCP server (quote the whole command)
  https://api.example.com/mcp    streamable HTTP MCP server
  ./manifest.json                a captured tools/list response
  ./.claude/skills               a directory of SKILL.md files

${pc.bold('inspect options')}
  --config <file>         read target: and ci: from a config file
  --fail-on <severity>    exit 1 when findings at or above this level exist
                          (error | warn | info | none, default: none)
  --disable <ids>         comma-separated rule ids to skip

${pc.bold('run options')}
  --dry-run               print the cost estimate and exit without spending
  --yes                   skip the cost confirmation
  --model <id>            override defaults.model
  --provider <id>         ${PROVIDER_IDS.join(' | ')} (inferred from the model id)
  --trials <n>            override defaults.trials
  --target <t>            override the config's target
  --replay <file>         replay recorded trials instead of calling a model
  --record <file>         save this run's raw trials, replayable offline later
  --presentation <mode>   skills only: skill-tool (default) or pseudo-tool
  --baseline <file>       compare against a stored JSON report
  --max-regression <0..1> worst per-scenario drop allowed, against --baseline
  --max-flaky <n>         scenarios allowed in the 20–80% band
  --max-orphans <n>       items allowed that no scenario ever selected
  --max-error-rate <0..1> errored trials before the run counts as unmeasured

${pc.bold('mutate options')}
  --mutants <n>           how many defects to inject (default: ${DEFAULT_MUTANTS})
  --operators <ids>       comma-separated: blank-description, swap-descriptions,
                          inject-decoys (default: all of them)
  --min-score <0..1>      exit 1 when the mutation score falls below this
  plus --dry-run, --yes, --model, --provider, --trials, --presentation from run.
  ${pc.dim(`Costs ${BASELINE_RUNS} clean runs plus one per mutant — the clean runs are the`)}
  ${pc.dim('noise floor, and a drop smaller than that means nothing.')}

${pc.bold('shared options')}
  --format <mode>         table (default), json or markdown
  --json                  alias for --format json
  --out <file>            write the JSON report here, whatever --format prints
  --adapter <id>          force mcp or skills, skipping target detection
  --header <k=v>          extra HTTP header (repeatable)
  --env <k=v>             extra env var for stdio servers (repeatable)
  --timeout <ms>          connection budget (default: 30000)
  -h, --help              this
  -v, --version           version

${pc.bold('exit codes')}
  0  measured, gates passed        2  could not measure — see the gate block
  1  measured, the answer is bad   130  cancelled at the cost confirmation

${pc.dim('inspect makes no model calls and needs no API key.')}
`;

/**
 * Parse argv and dispatch. Exported so the exit-code contract can be tested
 * end to end against the replay fixtures rather than asserted about in prose.
 */
export async function main(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      format: { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
      target: { type: 'string' },
      'fail-on': { type: 'string' },
      disable: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      model: { type: 'string' },
      provider: { type: 'string' },
      trials: { type: 'string' },
      replay: { type: 'string' },
      record: { type: 'string' },
      presentation: { type: 'string' },
      baseline: { type: 'string' },
      'max-regression': { type: 'string' },
      'max-flaky': { type: 'string' },
      'max-orphans': { type: 'string' },
      'max-error-rate': { type: 'string' },
      mutants: { type: 'string' },
      operators: { type: 'string' },
      'min-score': { type: 'string' },
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
    return Exit.Ok;
  }

  const [command, target] = positionals;

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !values.help ? Exit.Unmeasured : Exit.Ok;
  }

  const loadOptions: LoadOptions & { adapter?: SurfaceKind } = {
    ...(values.header ? { headers: parsePairs(values.header, '--header') } : {}),
    ...(values.env ? { env: parsePairs(values.env, '--env') } : {}),
    ...(values.timeout ? { timeoutMs: Number(values.timeout) } : {}),
    ...(values.adapter ? { adapter: parseAdapter(values.adapter) } : {}),
  };

  if (command === 'inspect') {
    if (target === undefined && values.config === undefined) {
      process.stderr.write(`inspect needs a target, or a --config to read one from.\n${USAGE}\n`);
      return Exit.Unmeasured;
    }
    return inspect(target, loadOptions, values);
  }

  if (command === 'run') {
    if (target === undefined) {
      process.stderr.write(`run needs a config file.\n${USAGE}\n`);
      return Exit.Unmeasured;
    }
    return run(target, loadOptions, values);
  }

  if (command === 'mutate') {
    if (target === undefined) {
      process.stderr.write(`mutate needs a config file.\n${USAGE}\n`);
      return Exit.Unmeasured;
    }
    return mutate(target, loadOptions, values);
  }

  process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
  return Exit.Unmeasured;
}

/* -------------------------------------------------------------------------- */

type Values = Record<string, unknown>;

/** What goes on stdout. `--out` writes JSON regardless, so both can come from one run. */
type Format = 'table' | 'json' | 'markdown';

async function inspect(
  target: string | undefined,
  loadOptions: LoadOptions,
  values: Values,
): Promise<ExitCode> {
  const format = parseFormat(values);

  // One config drives all three commands, so the Action needs a single input:
  // `inspect --config pickrate.yaml` takes both the target and the gates from
  // the file that the scenarios already live in.
  const configPath = values.config as string | undefined;
  const config = configPath === undefined ? undefined : await loadConfig(configPath);
  const resolved = target ?? config?.target;
  if (resolved === undefined) {
    throw new Error(`${configPath} has no target: to inspect.`);
  }

  const surface = await loadSurface(resolved, loadOptions);
  const disable = values.disable as string | undefined;
  const analysis = analyse(surface, {
    ...(disable ? { disable: disable.split(',').map((id) => id.trim()) } : {}),
  });

  const gates = evaluateAnalysisGates(analysis, gatesFor(config?.ci, values));

  await emit(format, values, {
    table: () => formatAnalysis(analysis),
    json: () => formatAnalysisJson(analysis, { gates }),
    markdown: () => formatAnalysisMarkdown(analysis, gates),
    gates,
  });

  return exitCodeFor(gates);
}

async function run(configPath: string, loadOptions: LoadOptions, values: Values): Promise<ExitCode> {
  const config = applyOverrides(await loadConfig(configPath), values);
  const format = parseFormat(values);
  const json = format === 'json';

  const surface = await loadSurface(config.target, loadOptions);
  const replay = values.replay as string | undefined;
  const provider: Provider = replay
    ? await ReplayProvider.fromFile(replay)
    : providerFor(providerChoice(config, values));

  // The same presentation the runner will use, so the estimate prices the
  // request that actually runs rather than an approximation of it.
  const mode = (values.presentation as string | undefined) ?? config.defaults.presentation;
  const presentation = adapterFor(surface.kind).present(surface, mode !== undefined ? { mode } : {});

  const trials = totalTrials(config);
  const estimate = await preflight(provider, config, presentation, trials, json);

  if (values['dry-run'] === true) {
    if (!json) process.stderr.write(pc.dim('  --dry-run: nothing was spent.\n\n'));
    return Exit.Ok;
  }

  if (estimate && !json && values.yes !== true && process.stdin.isTTY) {
    if (!(await confirm())) {
      process.stderr.write(pc.dim('  Cancelled.\n'));
      return Exit.Cancelled;
    }
  }

  const render = json ? undefined : renderProgress();

  // A live run is the expensive part of this whole tool, and the trials it
  // produces are replayable offline forever. Recording them is therefore worth a
  // flag on its own: without one, developing against a second provider means
  // paying again for trials that were already bought once. `RunProgress` already
  // carries every trial, so this collects rather than re-plumbing the runner.
  const recordTo = values.record as string | undefined;
  const recorded: TrialResult[] = [];
  const onProgress =
    recordTo === undefined
      ? render
      : (progress: RunProgress) => {
          recorded.push(progress.trial);
          render?.(progress);
        };

  const report = await runEval(config, surface, provider, {
    presentation,
    // Passed so the runner can decide whether warming the cache is worth a
    // serialised trial: below the model's minimum cacheable prefix there is no
    // entry to warm, and the warm-up buys a round trip and nothing else.
    ...(estimate ? { estimate } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  await provider.close?.();

  if (recordTo !== undefined) {
    await writeFile(recordTo, `${JSON.stringify(recorded, null, 2)}\n`);
    if (!json) process.stderr.write(pc.dim(`  recorded ${recorded.length} trials to ${recordTo}\n`));
  }

  const ci = gatesFor(config.ci, values);
  const baseline = values.baseline as string | undefined;
  const diff =
    baseline === undefined
      ? undefined
      : diffReports(
          await readReportFile(baseline),
          report,
          ci.maxRegression !== undefined ? { maxRegression: ci.maxRegression } : {},
        );

  // A run that could not measure anything must not look like a pass — which is
  // the `max-error-rate` gate's whole job, and it is on by default.
  const gates = evaluateRunGates(report, ci, diff);

  await emit(format, values, {
    table: () => formatEvalReport(report, diff),
    json: () => formatEvalReportJson(report, { gates, ...(diff ? { diff } : {}) }),
    markdown: () => formatEvalMarkdown(report, gates, diff),
    gates,
  });

  return exitCodeFor(gates);
}

/**
 * Break the surface on purpose and check the eval noticed.
 *
 * The one command that reports on pickrate rather than on your server. Every
 * other tool in this space tells you how good your surface is; this tells you
 * how much to believe that (spec §6).
 */
async function mutate(
  configPath: string,
  loadOptions: LoadOptions,
  values: Values,
): Promise<ExitCode> {
  const config = applyOverrides(await loadConfig(configPath), values);
  const format = parseFormat(values);
  const json = format === 'json';

  // Replay is keyed on scenario id and knows nothing about the surface, so
  // every mutant would replay identically and score exactly zero — a mutation
  // score of 0% that reads like a devastating finding and is an artefact.
  if (values.replay !== undefined) {
    throw new Error(
      'mutate cannot use --replay: recorded trials are indifferent to the surface, so every mutant would ' +
        'replay identically and score 0%. Mutation testing needs a model that actually reads the damaged surface.',
    );
  }

  const surface = await loadSurface(config.target, loadOptions);
  const provider: Provider = providerFor(providerChoice(config, values));

  const mode = (values.presentation as string | undefined) ?? config.defaults.presentation;
  const presentation = adapterFor(surface.kind).present(surface, mode !== undefined ? { mode } : {});

  const mutants = planMutants(surface, {
    ...(values.operators ? { operators: (values.operators as string).split(',').map((id) => id.trim()) } : {}),
    limit: parsePositive(values.mutants as string | undefined, '--mutants') ?? DEFAULT_MUTANTS,
  });

  if (mutants.length === 0) {
    throw new Error(
      `Nothing to mutate: no operator could damage this surface of ${surface.items.length} items.`,
    );
  }

  const runs = BASELINE_RUNS + mutants.length;
  const trials = totalTrials(config) * runs;
  const estimate = await preflight(provider, config, presentation, trials, json, 'mutate', runs);

  if (values['dry-run'] === true) {
    if (!json) {
      process.stderr.write(
        pc.dim(`  ${mutants.length} mutants over ${runs} runs. --dry-run: nothing was spent.\n\n`),
      );
    }
    return Exit.Ok;
  }

  if (estimate && !json && values.yes !== true && process.stdin.isTTY) {
    if (!(await confirm())) {
      process.stderr.write(pc.dim('  Cancelled.\n'));
      return Exit.Cancelled;
    }
  }

  const onProgress = json ? undefined : renderMutationProgress();
  const report = await runMutation(config, surface, provider, {
    mutants,
    ...(mode !== undefined ? { mode } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
  await provider.close?.();

  const gates = evaluateMutationGates(report, gatesFor(config.ci, values));

  await emit(format, values, {
    table: () => formatMutationReport(report),
    json: () => formatMutationReportJson(report, { gates }),
    markdown: () => formatMutationMarkdown(report, gates),
    gates,
  });

  return exitCodeFor(gates);
}

interface Rendered {
  table: () => string;
  json: () => string;
  markdown: () => string;
  gates: GateResult[];
}

/**
 * Write the report: one rendering to stdout, and JSON to `--out` if asked.
 *
 * Both from the same run, deliberately. The Action wants a human artifact for
 * the step summary and a machine one for the artifact upload, and running the
 * eval twice to get two formats doubles the API bill for no new measurement.
 */
async function emit(format: Format, values: Values, rendered: Rendered): Promise<void> {
  const out = values.out as string | undefined;

  if (format === 'json') {
    process.stdout.write(`${rendered.json()}\n`);
  } else if (format === 'markdown') {
    // Gates are already inside the markdown — a step summary is one document.
    process.stdout.write(`${rendered.markdown()}\n`);
  } else {
    const gates = formatGates(rendered.gates);
    process.stdout.write(gates === undefined ? `${rendered.table()}\n` : `${rendered.table()}\n${gates}\n\n`);
  }

  // Always JSON, whatever went to stdout — a file named by `--out` that
  // contained a terminal table would be a trap for the pipeline reading it.
  if (out !== undefined) await writeFile(out, `${rendered.json()}\n`, 'utf8');
}

/**
 * Gates from the config, with flags on top.
 *
 * The file is where a threshold belongs — it is argued over in review next to
 * the scenarios it judges. Flags exist so a workflow can tighten one without
 * editing the repo, not so it can hold the whole policy.
 */
/**
 * Which provider and model to run, merging flags over config.
 *
 * `--provider` and `--model` are run-level flags and never config keys: a stored
 * config that silently switches provider changes what the numbers mean on an
 * invocation that looks identical to the one it was reviewed at. Model stays
 * readable from config because it was already, and the report records what
 * actually ran either way.
 */
function providerChoice(config: EvalConfig, values: Values): ProviderChoice {
  const model = (values.model as string | undefined) ?? config.defaults.model;
  const provider = values.provider as string | undefined;

  return {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
  };
}

function gatesFor(ci: CiGates | undefined, values: Values): CiGates {
  const failOn = values['fail-on'] as string | undefined;

  return {
    ...(ci ?? DEFAULT_GATES),
    ...(failOn !== undefined ? { failOn: parseFailOn(failOn) } : {}),
    ...override('maxFlaky', parseCount(values['max-flaky'] as string | undefined, '--max-flaky')),
    ...override('maxOrphans', parseCount(values['max-orphans'] as string | undefined, '--max-orphans')),
    ...override('maxErrorRate', parseThreshold(values['max-error-rate'] as string | undefined, '--max-error-rate')),
    ...override('maxRegression', parseThreshold(values['max-regression'] as string | undefined, '--max-regression')),
    ...override('minScore', parseThreshold(values['min-score'] as string | undefined, '--min-score')),
  };
}

function override<K extends string>(key: K, value: number | undefined): Record<K, number> | {} {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/** Price the run before spending, using the free token-counting endpoint. */
async function preflight(
  provider: Provider,
  config: EvalConfig,
  presentation: Presentation,
  trials: number,
  json: boolean,
  command = 'run',
  runs = 1,
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
    `\n${pc.bold(`pickrate ${command}`)}  ${pc.dim(config.path)}\n` +
      `  ${pc.bold('model')}     ${estimate.model}\n` +
      pc.dim(`  manifest  ~${estimate.inputTokensPerTrial.toLocaleString()} input tokens per trial\n`) +
      pc.dim(`  trials    ${trials} across ${config.scenarios.length} scenarios\n`) +
      // Each run is a different surface and so a different cached prefix. A
      // mutation session is not one warm run, it is `runs` of them, and the
      // estimate must not imply otherwise.
      (runs > 1 ? pc.dim(`  runs      ${runs}, each writing its own prompt cache\n`) : '') +
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

/** Same discipline as `renderProgress`, with the run's label in front. */
function renderMutationProgress() {
  if (!process.stderr.isTTY) return undefined;
  return ({ label, completed, total, trial }: MutationProgress) => {
    process.stderr.write(
      `\r${' '.repeat(72)}\r  run ${completed}/${total} ${pc.dim(label)}` +
        `  ${trial.completed}/${trial.total} trials`,
    );
    if (completed === total && trial.completed === trial.total) process.stderr.write('\n');
  };
}

function applyOverrides(config: EvalConfig, values: Values): EvalConfig {
  const model = values.model as string | undefined;
  const trials = values.trials as string | undefined;
  const target = values.target as string | undefined;
  if (target !== undefined) config = { ...config, target };
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

function parsePositive(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

function parseThreshold(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1 (got "${value}")`);
  }
  return parsed;
}

function parseCount(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer (got "${value}")`);
  }
  return parsed;
}

/**
 * `--json` stays as an alias for `--format json`, so every M2/M3 invocation and
 * every script written against one keeps working.
 */
function parseFormat(values: Values): Format {
  const format = values.format as string | undefined;
  if (format === undefined) return values.json === true ? 'json' : 'table';
  if (values.json === true && format !== 'json') {
    throw new Error(`--json and --format ${format} disagree — pass one of them.`);
  }
  if (format === 'table' || format === 'json' || format === 'markdown') return format;
  throw new Error(`--format must be one of: table, json, markdown (got "${format}")`);
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

/**
 * Only when run as the binary, so `main` can be imported and driven by the
 * exit-code test. Every thrown error is exit 2, never 1: an exception means we
 * could not measure, and a build that reports that as a failing eval sends
 * someone to fix a surface that was never the problem.
 */
if (isEntryPoint()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${pc.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Exit.Unmeasured;
  }
}

/**
 * Through symlinks, deliberately.
 *
 * npm installs the bin as `node_modules/.bin/pickrate → ../pickrate/dist/cli.js`
 * and does *not* resolve that link into `argv[1]`, so comparing the raw paths
 * makes the published binary do nothing at all and exit 0 — a CLI that reports
 * success having measured nothing, which is the worst outcome this codebase has.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
