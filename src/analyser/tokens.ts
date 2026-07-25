import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { Manifest, TokenReport, ToolDef } from '../types.js';

export const ENCODING = 'o200k_base';

/**
 * Token cost of the manifest.
 *
 * Deliberately approximate, and the report must say so. Every provider wraps
 * tool definitions in its own envelope before they hit the context window, and
 * Anthropic's exact count is only available from a billed endpoint — which M1
 * refuses to require. What matters for the headline finding ("your manifest
 * costs ~34k tokens per session") and for regression tracking is a stable,
 * offline, order-of-magnitude-correct number.
 */
export function countManifestTokens(manifest: Manifest): TokenReport {
  const perTool = manifest.tools
    .map((tool) => ({ name: tool.name, tokens: countToolTokens(tool) }))
    .sort((a, b) => b.tokens - a.tokens);

  const total = perTool.reduce((sum, t) => sum + t.tokens, 0);

  return {
    total,
    perTool: perTool.map((t) => ({ ...t, share: total === 0 ? 0 : t.tokens / total })),
    encoding: ENCODING,
    approximate: true,
  };
}

/** Cost of one tool as the model sees it: name + description + schema. */
export function countToolTokens(tool: ToolDef): number {
  return countTokens(serialiseTool(tool));
}

function serialiseTool(tool: ToolDef): string {
  return JSON.stringify({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
  });
}
