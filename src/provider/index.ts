import { AnthropicProvider, DEFAULT_MODEL, PROVIDER_ID as ANTHROPIC } from './anthropic.js';
import {
  DEFAULT_MODEL as OPENAI_DEFAULT_MODEL,
  OpenAIProvider,
  PROVIDER_ID as OPENAI,
} from './openai.js';
import type { Provider } from './contract.js';
import { specFor } from './models.js';

export { costOf, costOfTrials, priceUsage, estimateRunUsd, prefixCaches, OUTPUT_TOKENS_PER_TRIAL, PRICES, EMPTY_USAGE, addUsage, sumUsage, formatUsd } from './pricing.js';
export type { ModelPrice } from './pricing.js';
export { MODELS, specFor, capabilitiesOf } from './models.js';
export type { LongContextMeter, ModelSpec } from './models.js';

// Split from contract.ts to avoid a registry/interfaces import cycle.
export { regimeHash } from './contract.js';
export type {
  CacheBehaviour,
  CostEstimate,
  ModelCapabilities,
  Provider,
  ReasoningConfig,
  Regime,
  ToolSearchState,
} from './contract.js';
export { CredentialError, SYSTEM_PROMPT, EFFORT } from './prompt.js';

export const PROVIDER_IDS = [ANTHROPIC, OPENAI];

export interface ProviderChoice {
  /** Model id as requested. Absent means "this provider's default", if it has one. */
  model?: string;
  /** Explicit `--provider`, which wins over anything inferred from the model id. */
  provider?: string;
}

/**
 * Which provider serves a model id.
 *
 * Two entries, so it stays code — the *properties* of a model are data, in
 * `models.ts`, and that is the part a third provider should only have to edit.
 * Same idiom as `parseTarget` plus `--adapter` on the surface side, deliberately.
 *
 * Detection is by prefix and never by fallback: an unrecognised id is an error
 * naming both providers, because the alternative is silently measuring a
 * different model than the one someone typed and reporting it as the one they
 * asked for. `o*` (o1, o3, o4-mini) is legacy and must not anchor detection —
 * it would swallow every future `opus-*` alias someone reasonably tries.
 */
export function providerFor(choice: ProviderChoice = {}): Provider {
  const { model, provider } = choice;

  if (provider !== undefined && !PROVIDER_IDS.includes(provider)) {
    throw new Error(
      `Unknown provider '${provider}'. Known providers: ${PROVIDER_IDS.join(', ')}.`,
    );
  }

  if (provider !== undefined) refuseContradiction(provider, model);

  const id = provider ?? inferProvider(model);

  if (id === OPENAI) return new OpenAIProvider({ model: model ?? OPENAI_DEFAULT_MODEL });

  return new AnthropicProvider(model !== undefined ? { model } : {});
}

/**
 * `--provider` settles an *ambiguous* id; it never reassigns an unambiguous one.
 *
 * The common shape is `--provider openai` against a config whose `defaults.model`
 * is a Claude id, and both silent readings are wrong: sending that id to the
 * other provider is a 400 on every trial, and quietly swapping in the provider's
 * default measures a model the config does not name and reports it as a run of
 * that config.
 *
 * Only the **table** contradicts, never the naming convention. A prefix is a
 * guess and refusing on a guess would break the escape hatch `--provider` exists
 * for: a model too new to have an entry stays overridable, and one with an entry
 * is a fact that a flag cannot reassign.
 */
function refuseContradiction(provider: string, model: string | undefined): void {
  if (model === undefined) return;

  const owner = specFor(model)?.provider;
  if (owner === undefined || owner === provider) return;

  throw new Error(
    `Model '${model}' is served by ${owner}, but --provider says ${provider}.\n` +
      `  Pass --model with an id ${provider} serves, or drop --provider to use ${owner}.\n` +
      `  ${provider === OPENAI ? `The ${OPENAI} default is ${OPENAI_DEFAULT_MODEL}.` : `The ${ANTHROPIC} default is ${DEFAULT_MODEL}.`}`,
  );
}

/** Naming conventions only, and undefined where they say nothing. */
function prefixProvider(model: string): string | undefined {
  if (model.startsWith('claude-')) return ANTHROPIC;
  if (model.startsWith('gpt-')) return OPENAI;
  return undefined;
}

/**
 * Model id → provider id, with the table consulted first.
 *
 * The table is authoritative where it has an entry, so a model that does not fit
 * either naming convention is a data edit rather than a new branch here.
 */
function inferProvider(model: string | undefined): string {
  if (model === undefined) return ANTHROPIC;

  const spec = specFor(model);
  if (spec !== undefined) return spec.provider;

  const byPrefix = prefixProvider(model);
  if (byPrefix !== undefined) return byPrefix;

  throw new Error(
    `Cannot tell which provider serves model '${model}'.\n` +
      `  Known providers: ${PROVIDER_IDS.join(', ')}. Pass --provider to say which.\n` +
      `  Anthropic ids start with 'claude-' (default: ${DEFAULT_MODEL}); OpenAI ids start with 'gpt-'.`,
  );
}
