import { readFile } from 'node:fs/promises';
import type { Presentation } from '../adapters/contract.js';
import type { Scenario, TrialResult } from '../types.js';
import type { Provider } from './index.js';

/**
 * A provider backed by recorded trials instead of a live model.
 *
 * This is the counterpart to `loadManifestFromFile`: it lets the runner,
 * scorer and reporter be built and tested with no API key, no network and no
 * spend. It is also the mechanism M3's mutation testing needs — score a
 * recorded baseline, damage the surface, and compare.
 *
 * Trials are handed out per scenario in recorded order and then cycle, so a
 * fixture of 5 trials can answer a 20-trial run with the same distribution.
 */
export class ReplayProvider implements Provider {
  readonly model: string;
  private readonly byScenario = new Map<string, TrialResult[]>();
  private readonly cursor = new Map<string, number>();

  /** The presentation these trials were recorded under, when the file says. */
  private readonly recordedMode: string | undefined;

  constructor(trials: TrialResult[], model = 'replay', recordedMode?: string) {
    this.model = model;
    this.recordedMode = recordedMode;
    for (const trial of trials) {
      const existing = this.byScenario.get(trial.scenarioId);
      if (existing) existing.push(trial);
      else this.byScenario.set(trial.scenarioId, [trial]);
    }
  }

  static async fromFile(path: string, model?: string): Promise<ReplayProvider> {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const trials = Array.isArray(parsed) ? parsed : (parsed as { trials?: unknown }).trials;
    if (!Array.isArray(trials)) {
      throw new Error(`${path}: expected an array of trials, or an object with a "trials" key.`);
    }
    const record = Array.isArray(parsed) ? undefined : (parsed as Record<string, unknown>);
    const recordedModel = record?.model;
    const recordedMode = record?.presentation;
    return new ReplayProvider(
      trials as TrialResult[],
      model ?? (typeof recordedModel === 'string' ? recordedModel : undefined),
      typeof recordedMode === 'string' ? recordedMode : undefined,
    );
  }

  async runTrial(presentation: Presentation, scenario: Scenario): Promise<TrialResult> {
    // Recorded calls only mean what they meant under the presentation that
    // produced them: skill-tool trials replayed as pseudo-tool project through
    // the identity and score a flat zero, which reads like a finding rather
    // than a mistake.
    if (
      this.recordedMode !== undefined &&
      presentation.mode !== undefined &&
      presentation.mode !== this.recordedMode
    ) {
      throw new Error(
        `These trials were recorded under "${this.recordedMode}" and are being replayed as "${presentation.mode}". Re-record, or drop the --presentation override.`,
      );
    }

    const recorded = this.byScenario.get(scenario.id);
    if (!recorded || recorded.length === 0) {
      throw new Error(`No recorded trials for scenario "${scenario.id}".`);
    }
    const index = this.cursor.get(scenario.id) ?? 0;
    this.cursor.set(scenario.id, index + 1);
    return structuredClone(recorded[index % recorded.length]!);
  }
}
