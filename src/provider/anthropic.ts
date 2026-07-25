import Anthropic from '@anthropic-ai/sdk';
import pc from 'picocolors';
import type { JsonSchema, Manifest, Scenario, ToolCall, TrialResult, TrialUsage } from '../types.js';
import type { CostEstimate, Provider } from './index.js';
import { CACHE_READ_MULTIPLIER, PRICES } from './pricing.js';

export const DEFAULT_MODEL = 'claude-haiku-4-5';

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

export interface AnthropicProviderOptions {
  model?: string;
  /** Overall budget for one trial, in ms. */
  timeoutMs?: number;
  maxRetries?: number;
  apiKey?: string;
}

export class AnthropicProvider implements Provider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

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

  async runTrial(manifest: Manifest, scenario: Scenario): Promise<TrialResult> {
    try {
      const response = await this.client.messages.create(this.request(manifest, scenario.prompt));

      // Check before reading content: a refused trial has no usable content,
      // and treating it as "called nothing" would score as passing restraint.
      if (response.stop_reason === 'refusal') {
        return {
          scenarioId: scenario.id,
          calls: [],
          stopReason: response.stop_reason,
          usage: usageOf(response.usage),
          error: `Model refused${response.stop_details ? ` (${response.stop_details.category ?? 'unspecified'})` : ''}.`,
        };
      }

      return {
        scenarioId: scenario.id,
        calls: callsOf(response.content),
        stopReason: response.stop_reason,
        usage: usageOf(response.usage),
      };
    } catch (error) {
      // Missing or bad credentials are not a per-trial condition — every
      // remaining trial would fail identically. Stop the run instead of
      // burning through N of them and reporting a manifest problem.
      throwIfCredentialProblem(error);
      return {
        scenarioId: scenario.id,
        calls: [],
        stopReason: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Free preflight, so nobody discovers the cost after paying it. */
  async estimate(
    manifest: Manifest,
    scenarios: Scenario[],
    totalTrials: number,
  ): Promise<CostEstimate> {
    const longest = scenarios.reduce(
      (worst, scenario) => (scenario.prompt.length > worst.prompt.length ? scenario : worst),
      scenarios[0]!,
    );
    const counted = await this.client.messages
      .countTokens({ model: this.model, ...promptShape(manifest, longest.prompt) })
      .catch((error: unknown) => {
        throwIfCredentialProblem(error);
        throw error;
      });

    return {
      inputTokensPerTrial: counted.input_tokens,
      totalTrials,
      model: this.model,
      ...(estimateUsd(this.model, counted.input_tokens, totalTrials) !== undefined
        ? { estimatedUsd: estimateUsd(this.model, counted.input_tokens, totalTrials)! }
        : {}),
    };
  }

  /**
   * The request shape is the measurement instrument — every choice here is
   * load-bearing, so they are all justified in place.
   */
  private request(manifest: Manifest, prompt: string): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: 1024,
      // `auto` is mandatory. A forced tool_choice makes restraint scenarios
      // (expect.tool: null) impossible to express — the model could never
      // correctly decline to call anything.
      tool_choice: { type: 'auto' },
      // effort, not thinking:disabled. Disabling thinking on some models makes
      // the model occasionally write a tool call into visible text instead of
      // emitting a tool_use block — which this harness would silently score as
      // "selected nothing". That is a systematic error in the primary metric.
      output_config: { effort: 'low' },
      ...promptShape(manifest, prompt),
    };
  }
}

/**
 * The part of the request that is billed and cached: tools, system, messages.
 *
 * Shared by `messages.create` and `countTokens` so the preflight estimate
 * prices the request that actually runs, rather than an approximation of it.
 */
function promptShape(
  manifest: Manifest,
  prompt: string,
): {
  tools: Anthropic.Tool[];
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
} {
  return {
    tools: manifest.tools.map(toAnthropicTool),
    // The breakpoint goes on system, which renders after tools, so it caches
    // the manifest and the system prompt together. Without it, a 34k-token
    // manifest is re-billed at full price on every single trial.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  };
}

/** Missing credentials produce an SDK message that doesn't say what to do. */
export class CredentialError extends Error {
  constructor(detail: string) {
    super(
      `${detail}\n` +
        `  mcpeval run needs model access. Set ANTHROPIC_API_KEY, or run "ant auth login".\n` +
        `  ${pc.dim('mcpeval inspect needs no credentials at all.')}`,
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
 * MCP tool → Anthropic tool.
 *
 * Note the absence of `strict: true`: it rejects JSON Schema constructs that
 * are common in real manifests, and it constrains generation. We want to
 * observe what the model does with the server's schema as written, not with a
 * version the API was willing to enforce.
 */
function toAnthropicTool(tool: {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}): Anthropic.Tool {
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
 */
function estimateUsd(model: string, inputTokensPerTrial: number, totalTrials: number): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;

  const OUTPUT_TOKENS_PER_TRIAL = 80;
  const cachedShare = Math.max(0, totalTrials - 1) * inputTokensPerTrial * CACHE_READ_MULTIPLIER;
  const freshShare = inputTokensPerTrial;

  return (
    ((cachedShare + freshShare) * price.input) / 1_000_000 +
    (totalTrials * OUTPUT_TOKENS_PER_TRIAL * price.output) / 1_000_000
  );
}
