import { AnthropicProvider, DEFAULT_MODEL, PROVIDER_ID as ANTHROPIC } from './anthropic.js';
import { CANDIDATE_MODELS, OpenAIProvider, PROVIDER_ID as OPENAI } from './openai.js';
import type { Provider } from './contract.js';
import { specFor } from './models.js';

export { costOf, costOfTrials, priceUsage, estimateRunUsd, PRICES, EMPTY_USAGE, addUsage, sumUsage, formatUsd } from './pricing.js';
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

  const id = provider ?? inferProvider(model);

  if (id === OPENAI) {
    if (model === undefined) {
      throw new Error(
        `The openai provider has no default model yet — pass --model.\n` +
          `  Candidates: ${CANDIDATE_MODELS.join(', ')}.\n` +
          `  Which tier is the right counterpart to a cheap Claude model is an open\n` +
          `  measurement decision (decision A), and a default chosen to fill this gap\n` +
          `  would become the model every published comparison quietly ran on.`,
      );
    }
    return new OpenAIProvider({ model });
  }

  return new AnthropicProvider(model !== undefined ? { model } : {});
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

  if (model.startsWith('claude-')) return ANTHROPIC;
  if (model.startsWith('gpt-')) return OPENAI;

  throw new Error(
    `Cannot tell which provider serves model '${model}'.\n` +
      `  Known providers: ${PROVIDER_IDS.join(', ')}. Pass --provider to say which.\n` +
      `  Anthropic ids start with 'claude-' (default: ${DEFAULT_MODEL}); OpenAI ids start with 'gpt-'.`,
  );
}
