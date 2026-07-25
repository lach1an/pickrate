import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { SkillDef, Surface, SurfaceItem, TokenReport, ToolDef } from '../types.js';

export const ENCODING = 'o200k_base';

/**
 * Resident token cost of a surface.
 *
 * Deliberately approximate, and the report must say so. Every provider wraps
 * tool definitions in its own envelope before they hit the context window, and
 * Anthropic's exact count is only available from a billed endpoint — which M1
 * refuses to require. What matters for the headline finding ("your manifest
 * costs ~34k tokens per session") and for regression tracking is a stable,
 * offline, order-of-magnitude-correct number.
 *
 * For skills this counts the *routing* block only — name and description. The
 * body is not resident until the skill triggers, so folding it in here would
 * overstate the standing cost by an order of magnitude and hide the thing
 * progressive disclosure exists to give you. `countSkillBodyTokens` is
 * separate, and reported separately.
 */
export function countSurfaceTokens(surface: Surface): TokenReport {
  const perItem = surface.items
    .map((item) => ({ name: item.name, tokens: countItemTokens(item) }))
    .sort((a, b) => b.tokens - a.tokens);

  const total = perItem.reduce((sum, t) => sum + t.tokens, 0);
  const bodies = surface.items
    .filter((item): item is SkillDef => item.kind === 'skill')
    .reduce((sum, skill) => sum + countSkillBodyTokens(skill), 0);

  return {
    total,
    perItem: perItem.map((t) => ({ ...t, share: total === 0 ? 0 : t.tokens / total })),
    // Reported for skills even when zero: "your bodies cost nothing extra" and
    // "we did not measure your bodies" are different statements.
    ...(surface.kind === 'skills' ? { deferred: bodies } : {}),
    encoding: ENCODING,
    approximate: true,
  };
}

/** Resident cost of one item, whatever kind it is. */
export function countItemTokens(item: SurfaceItem): number {
  return item.kind === 'tool' ? countToolTokens(item) : countSkillRoutingTokens(item);
}

/** Cost of one tool as the model sees it: name + description + schema. */
export function countToolTokens(tool: ToolDef): number {
  return countTokens(
    JSON.stringify({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    }),
  );
}

/** What a skill costs while it is merely *available*: one listing line. */
export function countSkillRoutingTokens(skill: SkillDef): number {
  return countTokens(`${skill.name}: ${skill.description ?? ''}`);
}

/** What a skill costs once it triggers. Never summed into the resident total. */
export function countSkillBodyTokens(skill: SkillDef): number {
  return countTokens(skill.body);
}
