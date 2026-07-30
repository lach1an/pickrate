import { readFile } from 'node:fs/promises';
import { SCHEMA_VERSION } from '../report/json.js';
import type { ReasoningConfig, SurfaceKind, ToolSearchState } from '../types.js';

/**
 * Reading a stored report back is the moment `SCHEMA_VERSION` stops being
 * documentation and starts being load-bearing. Everything here is defensive on
 * purpose: a baseline is usually weeks old, written by a different version of
 * this tool, and the failure it can cause — a comparison that quietly means
 * something else — is worse than not comparing at all.
 */

/** Refusal to compare. Always exit 2: nothing was measured wrongly, we declined. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

/** The parts of a stored `run` report a comparison needs. */
export interface StoredReport {
  schemaVersion: number;
  command: string;
  model: string;
  /**
   * The instrument, which is refused on rather than tolerated.
   *
   * Required from schema 3 onward. A baseline that cannot say which provider,
   * reasoning config or loading regime produced it cannot be compared against
   * one that can — the difference would read as a change in the surface.
   */
  provider: string;
  reasoning: ReasoningConfig;
  toolSearch: ToolSearchState;
  regimeHash: string;
  presentation?: string;
  trials: number;
  startedAt: string;
  adapter: SurfaceKind;
  scenarios: Array<{ id: string; score: number; passed: boolean }>;
  orphans: string[];
  /** Where it was read from, for the report header. */
  path: string;
}

export async function readReportFile(path: string): Promise<StoredReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new BaselineError(
      `Could not read the baseline at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BaselineError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseReportFile(raw, path);
}

export function parseReportFile(raw: unknown, path = 'baseline.json'): StoredReport {
  const report = object(raw, path);

  if (report.schemaVersion !== SCHEMA_VERSION) {
    throw new BaselineError(
      `${path} is schema version ${json(report.schemaVersion)}, and this build reads ${SCHEMA_VERSION}. ` +
        'Re-record the baseline rather than comparing across shapes.',
    );
  }
  if (report.command !== 'run') {
    throw new BaselineError(
      `${path} is a "${json(report.command)}" report — only a run report can be a baseline.`,
    );
  }

  const source = object(report.source, `${path}.source`);
  const adapter = source.adapter;
  if (adapter !== 'mcp' && adapter !== 'skills') {
    throw new BaselineError(`${path}.source.adapter is ${json(adapter)}, expected "mcp" or "skills".`);
  }

  if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) {
    throw new BaselineError(`${path}.scenarios is empty — there is nothing to compare against.`);
  }

  const scenarios = report.scenarios.map((entry, index) => {
    const scenario = object(entry, `${path}.scenarios[${index}]`);
    if (typeof scenario.id !== 'string' || typeof scenario.score !== 'number') {
      throw new BaselineError(`${path}.scenarios[${index}] needs an id and a numeric score.`);
    }
    return { id: scenario.id, score: scenario.score, passed: scenario.passed === true };
  });

  return {
    schemaVersion: report.schemaVersion,
    command: 'run',
    model: string(report.model, `${path}.model`),
    provider: string(report.provider, `${path}.provider`),
    reasoning: reasoning(report.reasoning, `${path}.reasoning`),
    toolSearch: toolSearch(report.toolSearch, `${path}.toolSearch`),
    regimeHash: string(report.regimeHash, `${path}.regimeHash`),
    ...(typeof report.presentation === 'string' ? { presentation: report.presentation } : {}),
    trials: typeof report.trials === 'number' ? report.trials : 0,
    startedAt: typeof report.startedAt === 'string' ? report.startedAt : 'unknown',
    adapter,
    scenarios,
    orphans: Array.isArray(report.orphans) ? report.orphans.filter((o): o is string => typeof o === 'string') : [],
    path,
  };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BaselineError(`${path}: expected an object, got ${json(value)}`);
  }
  return value as Record<string, unknown>;
}

function reasoning(value: unknown, path: string): ReasoningConfig {
  const config = object(value, path);
  if (config.mode !== 'none' && config.mode !== 'effort') {
    throw new BaselineError(`${path}.mode is ${json(config.mode)}, expected "none" or "effort".`);
  }
  return {
    mode: config.mode,
    ...(typeof config.effort === 'string' ? { effort: config.effort } : {}),
  };
}

function toolSearch(value: unknown, path: string): ToolSearchState {
  if (value !== 'on' && value !== 'off') {
    throw new BaselineError(`${path} is ${json(value)}, expected "on" or "off".`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BaselineError(`${path}: expected a string, got ${json(value)}`);
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
