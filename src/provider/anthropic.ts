import Anthropic from '@anthropic-ai/sdk';
import pc from 'picocolors';
import type { Presentation, ToolDeclaration } from '../adapters/contract.js';
import type { Scenario, ToolCall, TrialResult, TrialUsage } from '../types.js';
import { regimeHash } from './contract.js';
import type {
  CostEstimate,
  ModelCapabilities,
  ReasoningConfig,
  Regime,
  Provider,
  ToolSearchState,
} from './contract.js';
import { capabilitiesOf, specFor } from './models.js';
import { priceUsage } from './pricing.js';

export const PROVIDER_ID = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5';

/** What the request asks for, recorded on every report. */
const EFFORT = 'low';
const REASONING: ReasoningConfig = { mode: 'effort', effort: EFFORT };

/** Eager: the model is handed the whole surface. See the regime notes below. */
const TOOL_SEARCH: ToolSearchState = 'off';

/**
 * The structural form the declarations take, for the regime hash.
 *
 * The *shape* of a tool declaration, never its content — two providers put the
 * same neutral `ToolDeclaration` into differently-shaped requests, and that
 * difference is part of what makes two runs incomparable.
 */
const DECLARATION_FORM = 'anthropic.messages.tools.input_schema';

/**
 * The system prompt every trial shares.
 *
 * Kept deliberately thin and byte-stable. Thin because the thing under test is
 * the server's tool descriptions, and any instruction here that helps the model
 * choose is a thumb on the scale. Byte-stable because it carries the cache
 * breakpoint — one interpolated timestamp here and the whole run costs 10×.
 */
const SYSTEM_PROMPT =
  'You are an assistant with access to a set of tools. ' +
  'Use a tool when it is the right way to satisfy the request. ' +
  'If none of the tools fit, answer directly without calling one.';

/**
 * Finish reasons that mean the model ran out of room, not that it chose to stop.
 *
 * Truncation is never restraint. An empty call list means *the model chose to
 * call nothing*; a truncated response means *we never found out what it chose*,
 * and scoring the second as the first is a false pass in the metric that is
 * already the most neglected.
 */
const TRUNCATION_REASONS = new Set(['max_tokens', 'model_context_window_exceeded']);

export interface AnthropicProviderOptions {
  model?: string;
  /** Overall budget for one trial, in ms. */
  timeoutMs?: number;
  maxRetries?: number;
  apiKey?: string;
}

export class AnthropicProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

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

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.client = new Anthropic({
      // Zero-arg by default: picks up ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
      // or an `ant auth login` profile. Never prompt the user for a key.
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      // Retries here cover transport only — 429/5xx/connection. A "wrong" tool
      // choice is a result, not a failure, and is never retried: doing so
      // would silently bias every pass rate upward.
      maxRetries: options.maxRetries ?? 4,
      timeout: this.timeoutMs,
    });
  }

  capabilitiesFor(model: string): ModelCapabilities {
    return capabilitiesOf(model, {
      // Unknown model: assume this vendor's standard shape rather than "no
      // cache". Warming when we needn't costs one serialised trial; not warming
      // when we should costs roughly 10× the run.
      cache: {
        population: 'explicit-breakpoint',
        writesBilled: true,
        writeMultiplier: 1.25,
        readMultiplier: 0.1,
      },
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
      const response = await this.client.messages.create(
        this.request(presentation, scenario.prompt),
      );

      this.resolvedModel = response.model;
      this.reportedModels.add(response.model);

      return trialFrom(response, scenario.id);
    } catch (error) {
      // Missing or bad credentials are not a per-trial condition — every
      // remaining trial would fail identically. Stop the run instead of
      // burning through N of them and reporting a manifest problem.
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
    const counted = await this.client.messages
      .countTokens({ model: this.model, ...promptShape(presentation, longest.prompt) })
      .catch((error: unknown) => {
        throwIfCredentialProblem(error);
        throw error;
      });

    const estimatedUsd = estimateUsd(this.model, counted.input_tokens, totalTrials);

    return {
      inputTokensPerTrial: counted.input_tokens,
      totalTrials,
      model: this.model,
      ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
    };
  }

  /**
   * The request shape is the measurement instrument — every choice here is
   * load-bearing, so they are all justified in place.
   */
  private request(
    presentation: Presentation,
    prompt: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      // Budgeted generously on purpose. Capping output is not available as a
      // cost control: a cap tight enough to bound spend is a cap that
      // truncates, and a truncated trial is a discarded trial. The errored-trial
      // rate is what says a run is unmeasurable.
      max_tokens: 1024,
      // `auto` is mandatory. A forced tool_choice makes restraint scenarios
      // (expect.tool: null) impossible to express — the model could never
      // correctly decline to call anything.
      tool_choice: { type: 'auto' },
      // effort, not thinking:disabled. Disabling thinking on some models makes
      // the model occasionally write a tool call into visible text instead of
      // emitting a tool_use block — which this harness would silently score as
      // "selected nothing". That is a systematic error in the primary metric.
      output_config: { effort: EFFORT },
      ...promptShape(presentation, prompt),
    };
  }
}

/**
 * One response → one trial. Pure, and exported so the guards below can be
 * driven from a test without a client, a key or a network.
 */
export function trialFrom(response: Anthropic.Message, scenarioId: string): TrialResult {
  const usage = usageOf(response.usage);

  // Both guards run before the content is read: neither kind of response has a
  // usable call list, and treating either as "called nothing" scores as passing
  // restraint. They stay separate branches despite the identical shape —
  // refusal and truncation are different facts, and the message must say which.
  if (response.stop_reason === 'refusal') {
    return {
      scenarioId,
      calls: [],
      stopReason: response.stop_reason,
      usage,
      error: `Model refused${response.stop_details ? ` (${response.stop_details.category ?? 'unspecified'})` : ''}.`,
    };
  }

  if (response.stop_reason !== null && TRUNCATION_REASONS.has(response.stop_reason)) {
    return {
      scenarioId,
      calls: [],
      stopReason: response.stop_reason,
      usage,
      error:
        `Response ran out of output budget (${response.stop_reason}) before it finished. ` +
        'This trial did not measure a choice and is excluded, not scored as restraint.',
    };
  }

  return {
    scenarioId,
    calls: callsOf(response.content),
    stopReason: response.stop_reason,
    usage,
  };
}

/**
 * The part of the request that is billed and cached: tools, system, messages.
 *
 * Shared by `messages.create` and `countTokens` so the preflight estimate
 * prices the request that actually runs, rather than an approximation of it.
 */
function promptShape(
  presentation: Presentation,
  prompt: string,
): {
  tools: Anthropic.Tool[];
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    tools: presentation.tools.map(toAnthropicTool),
    // The breakpoint goes on system, which renders after tools, so it caches
    // the surface and the system prompt together. Without it, a 34k-token
    // manifest is re-billed at full price on every single trial.
    //
    // The adapter's suffix goes inside that same cached block — which is why
    // it has to be byte-stable across trials. A skills listing that iterated a
    // Set, or interpolated a path, would silently make every trial a cache miss.
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT + (presentation.systemSuffix ?? ''),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: prompt }],
  };
}

/** Missing credentials produce an SDK message that doesn't say what to do. */
export class CredentialError extends Error {
  constructor(detail: string, provider = PROVIDER_ID, envVar = 'ANTHROPIC_API_KEY') {
    super(
      `${detail}\n` +
        `  pickrate run and mutate need model access. The ${provider} provider reads ${envVar}.\n` +
        `  ${pc.dim('pickrate inspect needs no credentials at all.')}`,
    );
    this.name = 'CredentialError';
  }
}

function throwIfCredentialProblem(error: unknown): void {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    throw new CredentialError(error.message);
  }
  // Thrown before any request when the SDK cannot resolve a credential source.
  if (error instanceof Error && /resolve authentication method/i.test(error.message)) {
    throw new CredentialError('No Anthropic credentials found.');
  }
}

/**
 * Neutral declaration → Anthropic tool.
 *
 * Note the absence of `strict: true`: it rejects JSON Schema constructs that
 * are common in real manifests, and it constrains generation. We want to
 * observe what the model does with the server's schema as written, not with a
 * version the API was willing to enforce.
 */
function toAnthropicTool(tool: ToolDeclaration): Anthropic.Tool {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

/** Every call the model asked for — over-calling is itself a finding. */
function callsOf(content: Anthropic.ContentBlock[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    calls.push({
      name: block.name,
      args: (block.input ?? {}) as Record<string, unknown>,
    });
  }
  return calls;
}

/**
 * Anthropic reports all four numbers, so all four are present — including at
 * zero, which here means "this model caches and nothing was cached", not
 * "this model has no cache".
 */
function usageOf(usage: Anthropic.Usage): TrialUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Assumes the first trial writes the cache and the rest read it, which is what
 * the runner's warm-then-fan-out is for. Output tokens are a rough allowance —
 * a tool call is small, and the estimate exists to convey magnitude.
 *
 * Priced through the same `priceUsage` the report uses, so the warm-up trial
 * carries the model's cache-write multiplier instead of being quietly billed as
 * plain input.
 */
export function estimateUsd(
  model: string,
  inputTokensPerTrial: number,
  totalTrials: number,
): number | undefined {
  const spec = specFor(model);
  if (!spec) return undefined;

  const OUTPUT_TOKENS_PER_TRIAL = 80;
  const warm = priceUsage(spec, {
    inputTokens: 0,
    outputTokens: OUTPUT_TOKENS_PER_TRIAL,
    cacheCreationInputTokens: inputTokensPerTrial,
    cacheReadInputTokens: 0,
  });
  const cached = priceUsage(spec, {
    inputTokens: 0,
    outputTokens: OUTPUT_TOKENS_PER_TRIAL,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: inputTokensPerTrial,
  });

  return warm + Math.max(0, totalTrials - 1) * cached;
}
