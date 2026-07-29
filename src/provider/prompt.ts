import pc from 'picocolors';

/**
 * The parts of the measurement instrument that must not vary by provider.
 *
 * No model SDK is imported here, deliberately: every provider file imports
 * exactly one SDK (invariant 2), so anything two providers share has to live
 * somewhere neither of them owns. Putting `CredentialError` in `anthropic.ts`
 * and importing it from `openai.ts` would pull the Anthropic SDK into the
 * OpenAI provider transitively — the seam broken in the least visible way.
 */

/**
 * The system prompt every trial shares, on every provider.
 *
 * Kept deliberately thin and byte-stable. Thin because the thing under test is
 * the server's tool descriptions, and any instruction here that helps the model
 * choose is a thumb on the scale. Byte-stable because it sits inside the cached
 * prefix on both providers — one interpolated timestamp here and the whole run
 * costs roughly 10×.
 *
 * Shared rather than copied because a cross-provider delta is only attributable
 * to the manifest if the prompt text is held constant. The two requests are
 * still not byte-identical — Anthropic takes a system block, the Responses API
 * takes `instructions` — which is why the regime hash records the declaration
 * form alongside these bytes instead of pretending the requests can be made the
 * same. Changing this string changes the hash and so invalidates every stored
 * baseline on both providers.
 */
export const SYSTEM_PROMPT =
  'You are an assistant with access to a set of tools. ' +
  'Use a tool when it is the right way to satisfy the request. ' +
  'If none of the tools fit, answer directly without calling one.';

/**
 * Reasoning effort, held constant across providers for the same reason.
 *
 * `low` rather than off on either side: never `thinking: {type: "disabled"}` and
 * never `effort: 'none'`, because suppressing reasoning on some models makes
 * tool calls arrive as visible text rather than a structured call, which this
 * harness would silently score as "selected nothing" — a systematic error in
 * the primary metric.
 *
 * Note this is a *ceiling* on current OpenAI tiers, not a floor: the model may
 * do no reasoning at all on a prompt it judges easy, so two trials of the same
 * scenario can differ in whether reasoning happened. That is one more
 * irreducible variance source, which is the premise anyway.
 */
export const EFFORT = 'low';

/** Missing or unusable credentials produce SDK messages that don't say what to do. */
export class CredentialError extends Error {
  constructor(detail: string, provider: string, envVar: string) {
    super(
      `${detail}\n` +
        `  pickrate run and mutate need model access. The ${provider} provider reads ${envVar}.\n` +
        `  ${pc.dim('pickrate inspect needs no credentials at all.')}`,
    );
    this.name = 'CredentialError';
  }
}
