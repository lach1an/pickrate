import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CiGates, EvalConfig, EvalDefaults, Expectation, Scenario, Severity } from '../types.js';

export const DEFAULTS: EvalDefaults = {
  trials: 20,
  threshold: 0.95,
  model: 'claude-haiku-4-5',
  concurrency: 4,
};

/**
 * Gates as they stand with no `ci:` block at all.
 *
 * Only one is on. `maxErrorRate` defaults because its failure mode is silent:
 * a run that could not measure anything reports the survivors' score with
 * total confidence, and in CI nobody is watching. Every other gate is a
 * judgement about a particular surface and has no defensible default.
 */
export const DEFAULT_GATES: CiGates = {
  maxErrorRate: 0.1,
};

/** Keys accepted under `ci:`. Anything else is an error, not a shrug. */
const CI_KEYS = [
  'failOn',
  'maxTokens',
  'maxFlaky',
  'maxOrphans',
  'maxErrorRate',
  'maxRegression',
  'minScore',
] as const;

/** Thrown with a path into the document, e.g. `scenarios[2].expect.tool`. */
export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(path: string): Promise<EvalConfig> {
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(path, error instanceof Error ? error.message : String(error));
  }
  return parseConfig(raw, path);
}

export function parseConfig(raw: unknown, path = 'pickrate.yaml'): EvalConfig {
  const root = object(raw, 'config');

  // `server:` is a silent alias for `target:`, kept for configs written against M2.
  const block = root.target ?? root.server;
  const key = root.target !== undefined ? 'target' : 'server';

  return {
    target: parseTargetBlock(block, key, path),
    defaults: parseDefaults(root.defaults),
    scenarios: parseScenarios(root.scenarios),
    ci: parseCi(root.ci),
    path,
  };
}

// Unknown keys are an error, not ignored — a misspelled `maxFlakey:` should fail
// loudly rather than silently never fire.
export function parseCi(raw: unknown): CiGates {
  if (raw === undefined) return { ...DEFAULT_GATES };
  const ci = object(raw, 'ci');

  for (const key of Object.keys(ci)) {
    if (!(CI_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`ci.${key}`, `unknown gate — expected one of: ${CI_KEYS.join(', ')}`);
    }
  }

  return {
    ...(ci.failOn !== undefined ? { failOn: severity(ci.failOn, 'ci.failOn') } : {}),
    ...(ci.maxTokens !== undefined
      ? { maxTokens: nonNegativeInt(ci.maxTokens, 'ci.maxTokens') }
      : {}),
    ...(ci.maxFlaky !== undefined ? { maxFlaky: nonNegativeInt(ci.maxFlaky, 'ci.maxFlaky') } : {}),
    ...(ci.maxOrphans !== undefined
      ? { maxOrphans: nonNegativeInt(ci.maxOrphans, 'ci.maxOrphans') }
      : {}),
    maxErrorRate:
      threshold(ci.maxErrorRate, 'ci.maxErrorRate') ?? DEFAULT_GATES.maxErrorRate,
    ...(ci.maxRegression !== undefined
      ? { maxRegression: threshold(ci.maxRegression, 'ci.maxRegression')! }
      : {}),
    ...(ci.minScore !== undefined ? { minScore: threshold(ci.minScore, 'ci.minScore')! } : {}),
  };
}

// Collapses the target block into the single target string the adapters already understand.
function parseTargetBlock(raw: unknown, key: string, configPath: string): string {
  const server = object(raw, key);
  const transport = server.type ?? server.transport;

  if (transport === 'skills') {
    // Relative to the config file, so a checked-in fixture works from any working directory.
    return resolve(dirname(configPath), required(server.path, `${key}.path`, 'a directory path'));
  }
  if (transport === 'stdio') {
    return required(server.command, `${key}.command`, 'a command string');
  }
  if (transport === 'http') {
    return required(server.url, `${key}.url`, 'a URL');
  }
  if (transport === 'file') {
    // A captured tools/list response, resolved relative to the config file.
    return resolve(dirname(configPath), required(server.manifest, `${key}.manifest`, 'a file path'));
  }
  if (transport === undefined) {
    // Shorthand: whichever key is present implies the type.
    if (typeof server.url === 'string') return server.url;
    if (typeof server.manifest === 'string') return resolve(dirname(configPath), server.manifest);
    if (typeof server.path === 'string') return resolve(dirname(configPath), server.path);
    if (typeof server.command === 'string') return server.command;
    throw new ConfigError(`${key}.type`, 'expected "stdio", "http", "file" or "skills"');
  }
  throw new ConfigError(
    `${key}.type`,
    `expected "stdio", "http", "file" or "skills", got ${json(transport)}`,
  );
}

function parseDefaults(raw: unknown): EvalDefaults {
  if (raw === undefined) return { ...DEFAULTS };
  const defaults = object(raw, 'defaults');

  return {
    trials: positiveInt(defaults.trials, 'defaults.trials') ?? DEFAULTS.trials,
    threshold: threshold(defaults.threshold, 'defaults.threshold') ?? DEFAULTS.threshold,
    model: string(defaults.model, 'defaults.model') ?? DEFAULTS.model,
    concurrency: positiveInt(defaults.concurrency, 'defaults.concurrency') ?? DEFAULTS.concurrency,
    // Not validated here — the set of modes belongs to the adapter.
    ...(defaults.presentation !== undefined
      ? { presentation: required(defaults.presentation, 'defaults.presentation', 'a mode name') }
      : {}),
  };
}

function parseScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError('scenarios', `expected an array, got ${json(raw)}`);
  }
  if (raw.length === 0) {
    throw new ConfigError('scenarios', 'expected at least one scenario');
  }

  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = `scenarios[${index}]`;
    const scenario = object(entry, path);

    const id = required(scenario.id, `${path}.id`, 'an id string');
    if (seen.has(id)) throw new ConfigError(`${path}.id`, `duplicate scenario id "${id}"`);
    seen.add(id);

    const trials = positiveInt(scenario.trials, `${path}.trials`);
    const scenarioThreshold = threshold(scenario.threshold, `${path}.threshold`);

    return {
      id,
      prompt: required(scenario.prompt, `${path}.prompt`, 'a prompt string'),
      expect: parseExpectation(scenario.expect, `${path}.expect`),
      ...(scenarioThreshold !== undefined ? { threshold: scenarioThreshold } : {}),
      ...(trials !== undefined ? { trials } : {}),
    };
  });
}

function parseExpectation(raw: unknown, path: string): Expectation {
  const expect = object(raw, path);

  // `tool:` is a kept alias for `select:` (a skill is not a tool); both mean the same field.
  const key = 'select' in expect ? 'select' : 'tool';

  if (!('select' in expect) && !('tool' in expect)) {
    throw new ConfigError(
      `${path}.select`,
      'expected the name of a tool or skill, or null for a restraint check',
    );
  }
  if ('select' in expect && 'tool' in expect) {
    throw new ConfigError(`${path}.select`, 'set either select or tool, not both — they are the same field');
  }

  const tool = expect[key];
  if (tool !== null && typeof tool !== 'string') {
    throw new ConfigError(`${path}.${key}`, `expected a string or null, got ${json(tool)}`);
  }

  if (expect.args === undefined) return { tool };
  if (tool === null) {
    throw new ConfigError(`${path}.args`, `a restraint check (${key}: null) cannot assert arguments`);
  }
  return { tool, args: object(expect.args, `${path}.args`) };
}

/* -------------------------------------------------------------------------- */

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, `expected a mapping, got ${json(value)}`);
  }
  return value as Record<string, unknown>;
}

function required(value: unknown, path: string, expected: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(path, `expected ${expected}, got ${json(value)}`);
  }
  return value;
}

function string(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return required(value, path, 'a string');
}

function positiveInt(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(path, `expected a positive integer, got ${json(value)}`);
  }
  return value;
}

function nonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(path, `expected a non-negative integer, got ${json(value)}`);
  }
  return value;
}

/** `none` and `null` both mean "off", so a gate can be disabled without deleting it. */
function severity(value: unknown, path: string): Severity | null {
  if (value === null || value === 'none') return null;
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  throw new ConfigError(path, `expected "error", "warn", "info" or "none", got ${json(value)}`);
}

function threshold(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    throw new ConfigError(path, `expected a number between 0 and 1, got ${json(value)}`);
  }
  return value;
}

function json(value: unknown): string {
  if (value === undefined) return 'nothing';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Trials to run for a scenario, honouring its override. */
export function trialsFor(scenario: Scenario, defaults: EvalDefaults): number {
  return scenario.trials ?? defaults.trials;
}

/** Threshold for a scenario, honouring its override. */
export function thresholdFor(scenario: Scenario, defaults: EvalDefaults): number {
  return scenario.threshold ?? defaults.threshold;
}
