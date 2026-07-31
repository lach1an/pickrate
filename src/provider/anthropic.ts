import Anthropic from '@anthropic-ai/sdk';
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
import { estimateRunUsd } from './pricing.js';
import { CredentialError, EFFORT, SYSTEM_PROMPT } from './prompt.js';

export const PROVIDER_ID = 'anthropic';
export const DEFAULT_MODEL = 'claude-haiku-4-5';
const ENV_VAR = 'ANTHROPIC_API_KEY';

/** What the request asks for, recorded on every report. */
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
      // Zero-arg picks up ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/`ant auth login`; never prompt.
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      // Transport retries only (429/5xx/connection) — a "wrong" tool choice is never retried.
      maxRetries: options.maxRetries ?? 4,
      timeout: this.timeoutMs,
    });
  }

  capabilitiesFor(model: string): ModelCapabilities {
    return capabilitiesOf(model, {
      // Unknown model: assume the vendor's standard shape rather than "no cache".
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
      // Excludes tool declarations and systemSuffix (derived from the surface) —
      // hashing them would give every mutant its own regime.
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
      // Not a per-trial condition — every remaining trial would fail identically.
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
      // Budgeted generously — a cap tight enough to bound spend is a cap that truncates.
      max_tokens: 1024,
      // Mandatory: a forced tool_choice makes restraint scenarios (expect.tool: null) impossible.
      tool_choice: { type: 'auto' },
      // effort, not thinking:disabled — disabling thinking can make tool calls arrive
      // as visible text instead of tool_use blocks, which would score as false restraint.
      output_config: { effort: EFFORT },
      ...promptShape(presentation, prompt),
    };
  }
}

// One response → one trial. Pure, so it's testable without a client, key, or network.
export function trialFrom(response: Anthropic.Message, scenarioId: string): TrialResult {
  const usage = usageOf(response.usage);

  // Checked before the content is read — otherwise either reads as false restraint.
  // Kept as separate branches: refusal and truncation are different facts.
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

// Billed/cached part of the request, shared by messages.create and countTokens
// so the preflight estimate prices the actual request.
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
    // Breakpoint on system (renders after tools) caches the whole prefix together.
    // The adapter's suffix sits inside that block, so it must be byte-stable across
    // trials — a Set iteration or interpolated path would silently miss the cache.
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

function throwIfCredentialProblem(error: unknown): void {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    throw new CredentialError(error.message, PROVIDER_ID, ENV_VAR);
  }
  // Thrown before any request if the SDK can't resolve a credential source.
  if (error instanceof Error && /resolve authentication method/i.test(error.message)) {
    throw new CredentialError('No Anthropic credentials found.', PROVIDER_ID, ENV_VAR);
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
 * Priced by model id, for a model this provider serves.
 *
 * The cache assumption now follows the model's population style rather than
 * being hardcoded to warm-then-fan-out — see `estimateRunUsd`, which both
 * providers share so the two cannot drift apart.
 */
export function estimateUsd(
  model: string,
  inputTokensPerTrial: number,
  totalTrials: number,
): number | undefined {
  const spec = specFor(model);
  if (!spec) return undefined;
  return estimateRunUsd(spec, inputTokensPerTrial, totalTrials);
}
