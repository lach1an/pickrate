import OpenAI from 'openai';
import type { Presentation, ToolDeclaration } from '../adapters/contract.js';
import type { Scenario, ToolCall, TrialResult, TrialUsage } from '../types.js';
import { regimeHash } from './contract.js';
import type {
  CacheBehaviour,
  CostEstimate,
  ModelCapabilities,
  ReasoningConfig,
  Regime,
  Provider,
  ToolSearchState,
} from './contract.js';
import { capabilitiesOf, specFor } from './models.js';
import { estimateRunUsd } from './pricing.js';
import { CredentialError, EFFORT, SYSTEM_PROMPT, reasoningFor } from './prompt.js';

export const PROVIDER_ID = 'openai';
const ENV_VAR = 'OPENAI_API_KEY';

/**
 * Settled by measurement, not by tier name — decision A, run 2026-08-02.
 *
 * The worry was that a nominally cheap tier reasoning by default would not be
 * cheap, since reasoning bills as output. Measured at `effort: low` on 80 trials
 * it is not what happens: luna spent fewer output tokens per trial than the
 * Anthropic default (41 vs 72) and cost 2.5× less for the same run, while terra
 * cost 2.45× luna and scored *worse* on the discriminating scenario. Paying more
 * bought nothing here, so the counterpart to a cheap Claude model is the tier
 * that matches it on list price. See `plans/multi-provider-implementation.md`.
 */
export const DEFAULT_MODEL = 'gpt-5.6-luna';

/** Eager: the model is handed the whole surface. `defer_loading` is step 6b. */
const TOOL_SEARCH: ToolSearchState = 'off';

/**
 * The structural form the declarations take, for the regime hash.
 *
 * Flattened `{type, name, description, parameters, strict}`, verified against
 * the installed SDK's `Responses.FunctionTool` — *not* the Chat Completions
 * shape, which nests everything under `function`. The two providers put the same
 * neutral `ToolDeclaration` into differently-shaped requests, and that
 * difference is part of what makes two runs incomparable.
 */
const DECLARATION_FORM = 'openai.responses.tools.function';

/**
 * Generous, and larger than the Anthropic side's 1024 for a specific reason:
 * reasoning tokens count as output here. A budget sized for "a tool call is
 * small" would truncate the moment the model thought about it, and a truncated
 * trial is a discarded trial. Output is never capped to control cost — the
 * errored-trial rate is what says a run is unmeasurable.
 */
const MAX_OUTPUT_TOKENS = 4096;

export interface OpenAIProviderOptions {
  model: string;
  /** Overall budget for one trial, in ms. */
  timeoutMs?: number;
  maxRetries?: number;
  apiKey?: string;
}

export class OpenAIProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  private readonly options: OpenAIProviderOptions;
  private cachedClient?: OpenAI;

  /** Set from the first response that comes back. See `Provider.resolvedModel`. */
  resolvedModel?: string;

  /**
   * Every distinct model id the API reported across this run.
   *
   * More than one means an alias was re-pointed mid-run — the exact thing
   * recording the resolved id exists to catch — so it is surfaced rather than
   * quietly last-write-wins.
   */
  readonly reportedModels = new Set<string>();

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model;
    this.options = options;
  }

  /**
   * Built on first use, not in the constructor: the OpenAI SDK throws from its
   * constructor when it can't find a key, which would make `providerFor()`
   * throw on a machine with no OpenAI key.
   */
  private get client(): OpenAI {
    if (this.cachedClient !== undefined) return this.cachedClient;

    try {
      this.cachedClient = new OpenAI({
        // Zero-arg picks up OPENAI_API_KEY; never accept one as a CLI argument (command trace).
        ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}),
        // Transport retries only (429/5xx/connection) — a "wrong" tool choice is never retried.
        maxRetries: this.options.maxRetries ?? 4,
        timeout: this.options.timeoutMs ?? 60_000,
      });
    } catch (error) {
      throw new CredentialError(
        error instanceof Error ? error.message : String(error),
        PROVIDER_ID,
        ENV_VAR,
      );
    }

    return this.cachedClient;
  }

  capabilitiesFor(model: string): ModelCapabilities {
    return capabilitiesOf(model, {
      // Unknown model: assume the vendor's current shape (automatic-prefix, no warm-up).
      cache: FALLBACK_CACHE,
      toolSearch: 'supported',
      reasoning: 'effort-scale',
    });
  }

  regime(presentation: Presentation): Regime {
    // Per model, not per provider: the same provider serves models with and without the control.
    const reasoning = reasoningFor(this.model);

    return {
      provider: this.id,
      reasoning,
      toolSearch: TOOL_SEARCH,
      // Excludes tool declarations and systemSuffix (derived from the surface) —
      // hashing them would give every mutant its own regime.
      hash: regimeHash({
        provider: this.id,
        declarations: DECLARATION_FORM,
        system: SYSTEM_PROMPT,
        reasoning,
        toolSearch: TOOL_SEARCH,
      }),
    };
  }

  async runTrial(presentation: Presentation, scenario: Scenario): Promise<TrialResult> {
    try {
      const response = await this.client.responses.create(
        this.request(presentation, scenario.prompt),
      );

      this.resolvedModel = response.model;
      this.reportedModels.add(response.model);

      return trialFrom(response, scenario.id, this.cacheOf(response.model));
    } catch (error) {
      // Not per-trial conditions — every remaining trial would fail identically.
      throwIfCredentialProblem(error);
      return {
        scenarioId: scenario.id,
        calls: [],
        stopReason: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Free preflight, so nobody discovers the cost after paying it. */
  async estimate(
    presentation: Presentation,
    scenarios: Scenario[],
    totalTrials: number,
  ): Promise<CostEstimate> {
    const longest = scenarios.reduce(
      (worst, scenario) => (scenario.prompt.length > worst.prompt.length ? scenario : worst),
      scenarios[0]!,
    );

    // Takes the same payload as responses.create and returns the exact count
    // the model will receive — authoritative, unlike inspect's offline number.
    const counted = await this.client.responses.inputTokens
      .count({ model: this.model, ...promptShape(presentation, longest.prompt) })
      .catch((error: unknown) => {
        throwIfCredentialProblem(error);
        throw error;
      });

    const spec = specFor(this.model);
    const estimatedUsd =
      spec !== undefined ? estimateRunUsd(spec, counted.input_tokens, totalTrials) : undefined;

    return {
      inputTokensPerTrial: counted.input_tokens,
      totalTrials,
      model: this.model,
      ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
    };
  }

  private cacheOf(model: string): CacheBehaviour {
    return specFor(model)?.cache ?? FALLBACK_CACHE;
  }

  private request(
    presentation: Presentation,
    prompt: string,
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    return requestFor(this.model, presentation, prompt);
  }

  async close(): Promise<void> {
    // Nothing to release: no persistent connection.
  }
}

/**
 * The request shape is the measurement instrument — every choice here is
 * load-bearing, so they are all justified in place.
 *
 * Exported and pure for the same reason `trialFrom` is: the parameters that
 * vary by model are only assertable without a client, key or network.
 */
export function requestFor(
  model: string,
  presentation: Presentation,
  prompt: string,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const reasoning = reasoningFor(model);

  return {
    model,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    // Mandatory: a forced tool_choice makes restraint scenarios (expect.tool: null) impossible.
    tool_choice: 'auto',
    // Responses stores generated responses by default — trials must stay independent.
    store: false,
    // Only when the model has the parameter: sending `reasoning` to a tier without it is a 400.
    ...(reasoning.mode === 'effort' ? { reasoning: { effort: EFFORT } } : {}),
    // Left at its default — over-calling is the failure mode under observation.
    ...promptShape(presentation, prompt),
  };
}

// Standard cache shape for a model with no table entry. writesBilled: true is
// the pessimistic (and correct default) reading.
const FALLBACK_CACHE: CacheBehaviour = {
  population: 'automatic-prefix',
  writesBilled: true,
  writeMultiplier: 1.25,
  readMultiplier: 0.1,
  minimumPrefixTokens: 1024,
};

// One response → one trial. Pure, so it's testable without a client, key, or network.
export function trialFrom(
  response: OpenAI.Responses.Response,
  scenarioId: string,
  cache: CacheBehaviour,
): TrialResult {
  const usage = usageOf(response.usage, cache);
  // Incomplete reason where there is one, otherwise status — never scored on,
  // unlike Anthropic's stop_reason.
  const stopReason = response.incomplete_details?.reason ?? response.status ?? null;

  // Checked before the output is read — otherwise either reads as false restraint.
  // Kept as separate branches: these are different facts.
  if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
    return {
      scenarioId,
      calls: [],
      stopReason,
      usage,
      error:
        'Response ran out of output budget (max_output_tokens) before it finished. ' +
        'This trial did not measure a choice and is excluded, not scored as restraint.',
    };
  }

  if (response.incomplete_details?.reason === 'content_filter') {
    return {
      scenarioId,
      calls: [],
      stopReason,
      usage,
      error: 'Response was cut short by a content filter, so no choice was measured.',
    };
  }

  const refusal = refusalIn(response.output);
  if (refusal !== undefined) {
    return { scenarioId, calls: [], stopReason, usage, error: `Model refused: ${refusal}` };
  }

  if (response.status === 'failed' || response.error !== null) {
    return {
      scenarioId,
      calls: [],
      stopReason,
      usage,
      error: response.error?.message ?? 'Response failed without a message.',
    };
  }

  return { scenarioId, calls: callsOf(response.output), stopReason, usage };
}

/**
 * The part of the request that is billed and cached: tools, instructions, input.
 *
 * Shared by `responses.create` and `inputTokens.count` so the preflight prices
 * the request that actually runs, rather than an approximation of it.
 */
function promptShape(
  presentation: Presentation,
  prompt: string,
): {
  tools: OpenAI.Responses.Tool[];
  instructions: string;
  input: OpenAI.Responses.ResponseInput;
} {
  return {
    tools: presentation.tools.map(toOpenAITool),
    // The Responses API takes `instructions` rather than a system-role message,
    // so this request is structurally different from the Anthropic one before
    // any wording question arises — byte-identity across providers was never
    // achievable and the regime hash records the declaration form instead.
    //
    // There is no cache breakpoint to place: the prefix caches automatically.
    // The adapter's suffix still has to be byte-stable across trials for the
    // same reason it does on the other provider — a skills listing that iterated
    // a Set, or interpolated a path, silently makes every trial a cache miss,
    // with no error and a bill roughly 10× the estimate.
    instructions: SYSTEM_PROMPT + (presentation.systemSuffix ?? ''),
    input: [{ role: 'user', content: prompt }],
  };
}

function throwIfCredentialProblem(error: unknown): void {
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError
  ) {
    throw new CredentialError(error.message, PROVIDER_ID, ENV_VAR);
  }
  // An unfunded account is a 429 that isn't a rate limit — retrying the run can't help.
  if (error instanceof OpenAI.RateLimitError && /quota|billing|credit/i.test(error.message)) {
    throw new CredentialError(error.message, PROVIDER_ID, ENV_VAR);
  }
  if (error instanceof Error && /apiKey|OPENAI_API_KEY/i.test(error.message)) {
    throw new CredentialError('No OpenAI credentials found.', PROVIDER_ID, ENV_VAR);
  }
}

// strict: false — we want to observe the model against the server's schema as
// written, not a version the API rewrote to enforce.
function toOpenAITool(tool: ToolDeclaration): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.inputSchema as Record<string, unknown>,
    strict: false,
  };
}

/** Every call the model asked for — over-calling is itself a finding. */
function callsOf(output: OpenAI.Responses.ResponseOutputItem[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    calls.push({ name: item.name, args: parseArgs(item.arguments) });
  }
  return calls;
}

// Unparseable arguments become an empty object, not a dropped call — the model
// did select this tool, and dropping the call would turn an argument bug into
// a selection bug (or a false pass on restraint).
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function refusalIn(output: OpenAI.Responses.ResponseOutputItem[]): string | undefined {
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') return part.refusal;
    }
  }
  return undefined;
}

/**
 * Response usage → neutral `TrialUsage`, with the cache keys decided by the
 * model table rather than by what the API happened to send.
 *
 * Two things make this the one place the mapping cannot be mechanical.
 *
 * **The buckets overlap here and not there.** `input_tokens` on this provider is
 * the *total*, with `cached_tokens` and `cache_write_tokens` as subsets of it.
 * `TrialUsage` is disjoint — `priceUsage` adds all three and applies a different
 * multiplier to each — so the cached and written tokens are subtracted out. Pass
 * the raw numbers through and the cached prefix bills twice, once at the full
 * input rate and again at 0.1×, which on a 34k-token manifest is most of the
 * reported cost of the run.
 *
 * **Zero is not absence.** `input_tokens_details` declares `cache_write_tokens`
 * as a plain number, so a tier with no billed write concept still reports `0` —
 * and copying that through would say "writing the cache was free" where the
 * truth is "there is no such thing here". Absence is the meaningful value, so the
 * field is omitted unless the model bills writes.
 *
 * The subtraction is floored at zero rather than trusted: if the vendor's
 * arithmetic ever disagrees with this reading, an under-report is preferable to
 * a negative token count silently crediting someone's bill.
 */
function usageOf(
  usage: OpenAI.Responses.ResponseUsage | undefined,
  cache: CacheBehaviour,
): TrialUsage {
  if (usage === undefined) return { inputTokens: 0, outputTokens: 0 };

  const cached = usage.input_tokens_details.cached_tokens;
  const written = usage.input_tokens_details.cache_write_tokens;

  return {
    inputTokens: Math.max(0, usage.input_tokens - cached - written),
    outputTokens: usage.output_tokens,
    ...(cache.writesBilled ? { cacheCreationInputTokens: written } : {}),
    ...(cache.population !== 'none' ? { cacheReadInputTokens: cached } : {}),
  };
}
