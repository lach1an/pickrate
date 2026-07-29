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
import { CredentialError, EFFORT, SYSTEM_PROMPT } from './prompt.js';

export const PROVIDER_ID = 'openai';
const ENV_VAR = 'OPENAI_API_KEY';

/**
 * There is deliberately no `DEFAULT_MODEL` here.
 *
 * Which tier is the right counterpart to a cheap Claude model is decision A in
 * `plans/multi-provider-implementation.md`, and it costs one calibration run to
 * settle: every current tier reasons by default and reasoning bills as output,
 * so the nominally cheap tier is not necessarily the cheap one. A default picked
 * to make the code compile is a measurement decision made by accident, and it
 * would then be the number every published comparison ran on. Until the run
 * happens, `--provider openai` without a model is an error that names the
 * candidates.
 */
export const CANDIDATE_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];

/** What the request asks for, recorded on every report. */
const REASONING: ReasoningConfig = { mode: 'effort', effort: EFFORT };

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
   * The client, built on first use rather than in the constructor.
   *
   * Unlike the Anthropic SDK, this one throws from its constructor when it
   * cannot find a key. Building it eagerly would mean `providerFor()` — pure
   * routing that reads nothing and calls nothing — throws on a machine with no
   * OpenAI key, so the registry could not be tested offline and a model-id typo
   * would surface as a credentials error. It also throws a message that says
   * nothing about pickrate, which is what `CredentialError` exists to fix.
   */
  private get client(): OpenAI {
    if (this.cachedClient !== undefined) return this.cachedClient;

    try {
      this.cachedClient = new OpenAI({
        // Zero-arg by default: picks up OPENAI_API_KEY. Never prompt for a key,
        // and never accept one as a CLI argument — an argument lands in the
        // command trace.
        ...(this.options.apiKey !== undefined ? { apiKey: this.options.apiKey } : {}),
        // Retries here cover transport only — 429/5xx/connection. A "wrong" tool
        // choice is a result, not a failure, and is never retried: doing so
        // would silently bias every pass rate upward.
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
      // Unknown model: assume this vendor's current shape. Note this is not the
      // same bet as the Anthropic fallback — `automatic-prefix` means the runner
      // *skips* the warm-up, which is right here, because there is no write to
      // serialise against and warming would buy a round trip and no guarantee.
      cache: FALLBACK_CACHE,
      toolSearch: 'supported',
      reasoning: 'effort-scale',
    });
  }

  regime(presentation: Presentation): Regime {
    return {
      provider: this.id,
      reasoning: REASONING,
      toolSearch: TOOL_SEARCH,
      // Note what is *absent*: the tool declarations and `presentation.
      // systemSuffix`, both of which are derived from the surface. Hashing them
      // would give every mutant its own regime and make a mutation session
      // incomparable with the baseline it is measured against.
      hash: regimeHash({
        provider: this.id,
        declarations: DECLARATION_FORM,
        system: SYSTEM_PROMPT,
        reasoning: REASONING,
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
      // Credentials and quota are not per-trial conditions — every remaining
      // trial would fail identically. Stop the run instead of burning through N
      // of them and reporting what looks like a manifest problem.
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

    // The counting endpoint takes the same payload as `responses.create`,
    // including tools, and returns the exact count the model will receive — so
    // unlike `inspect`'s offline number this is authoritative, not an estimate.
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

  /**
   * The request shape is the measurement instrument — every choice here is
   * load-bearing, so they are all justified in place.
   */
  private request(
    presentation: Presentation,
    prompt: string,
  ): OpenAI.Responses.ResponseCreateParamsNonStreaming {
    const reasons = specFor(this.model)?.reasoning ?? 'effort-scale';

    return {
      model: this.model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      // `auto` is mandatory. A forced tool_choice makes restraint scenarios
      // (expect.tool: null) impossible to express — the model could never
      // correctly decline to call anything.
      tool_choice: 'auto',
      // Trials must be independent. Responses stores generated responses by
      // default for later retrieval; that is a copy of every prompt sitting on
      // the vendor's side for a harness that measures other people's manifests,
      // and it is one more piece of shared state between trials that are
      // supposed to be unrelated draws.
      store: false,
      // Only when the model has the parameter: sending `reasoning` to a tier
      // without it is a 400. Driven from the table so a new tier is a data edit.
      ...(reasons === 'effort-scale' ? { reasoning: { effort: EFFORT } } : {}),
      // `parallel_tool_calls` is deliberately left at its default. Over-calling
      // is the behaviour under observation — setting it false is a hard gate
      // that guarantees zero or one call, which would censor the failure mode
      // the selection metric exists to catch.
      ...promptShape(presentation, prompt),
    };
  }

  async close(): Promise<void> {
    // Nothing to release: the SDK holds no persistent connection.
  }
}

/**
 * The provider's standard cache shape, for a model with no table entry.
 *
 * `writesBilled` true is the pessimistic reading, and pessimistic is the right
 * default for anything that feeds a price.
 */
const FALLBACK_CACHE: CacheBehaviour = {
  population: 'automatic-prefix',
  writesBilled: true,
  writeMultiplier: 1.25,
  readMultiplier: 0.1,
  minimumPrefixTokens: 1024,
};

/**
 * One response → one trial. Pure, and exported so the guards below can be
 * driven from a test without a client, a key or a network.
 */
export function trialFrom(
  response: OpenAI.Responses.Response,
  scenarioId: string,
  cache: CacheBehaviour,
): TrialResult {
  const usage = usageOf(response.usage, cache);
  // The most specific fact available: the incomplete reason where there is one,
  // otherwise the status. Unlike Anthropic's `stop_reason` this is not a
  // statement about *why the model stopped*, which is why it is never scored on.
  const stopReason = response.incomplete_details?.reason ?? response.status ?? null;

  // Every guard runs before the output is read: none of these responses has a
  // usable call list, and treating any of them as "called nothing" scores as
  // passing restraint — a false pass in the most neglected metric. They stay
  // separate branches despite the identical shape, because they are different
  // facts and the message must say which.
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
  // An unfunded account is a 429 that is not a rate limit, and the SDK will have
  // already exhausted its retries on it before we see it. Retrying the rest of
  // the run cannot help, and reporting it per-trial would read as a bad manifest.
  if (error instanceof OpenAI.RateLimitError && /quota|billing|credit/i.test(error.message)) {
    throw new CredentialError(error.message, PROVIDER_ID, ENV_VAR);
  }
  if (error instanceof Error && /apiKey|OPENAI_API_KEY/i.test(error.message)) {
    throw new CredentialError('No OpenAI credentials found.', PROVIDER_ID, ENV_VAR);
  }
}

/**
 * Neutral declaration → Responses function tool.
 *
 * Note `strict: false`, for the same reason the Anthropic side omits it: strict
 * mode rejects JSON Schema constructs that are common in real manifests and
 * constrains generation. We want to observe what the model does with the
 * server's schema as written, not with a version the API was willing to enforce.
 */
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

/**
 * Arguments arrive as a JSON *string* here, not a parsed object as on the other
 * provider, so they can fail to parse.
 *
 * An unparseable payload is recorded as an empty argument object rather than
 * discarded: the model did select this tool, and selection and arguments are
 * scored separately. Dropping the call would turn an argument bug into a
 * selection bug — or, on a restraint scenario, into a false pass.
 */
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
