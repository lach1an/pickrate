import { itemNoun, toolsOf } from '../../surface.js';
import type { Finding, Rule } from '../../types.js';
import { maxDepth } from '../schema.js';
import { countItemTokens, countSurfaceTokens } from '../tokens.js';

/** Nesting beyond this reliably degrades argument accuracy. */
export const MAX_REASONABLE_DEPTH = 3;
/** Resident-context budgets, in approximate tokens. */
export const TOKEN_BUDGET_WARN = 10_000;
export const TOKEN_BUDGET_ERROR = 25_000;
/** A single item eating more than this share of the surface is suspicious. */
export const TOOL_SHARE_WARN = 0.25;
/**
 * Below this many items, a large share is arithmetic rather than a finding —
 * one tool in three is 33% of the manifest and there is nothing wrong with that.
 */
export const MIN_TOOLS_FOR_SHARE = 8;

export const deepSchema: Rule = {
  id: 'deep-schema',
  description: `Input schemas nested deeper than ${MAX_REASONABLE_DEPTH} levels are hard for a model to fill in correctly.`,
  defaultSeverity: 'info',
  appliesTo: ['mcp'],
  run(surface) {
    const findings: Finding[] = [];
    for (const tool of toolsOf(surface)) {
      const depth = maxDepth(tool.inputSchema);
      if (depth <= MAX_REASONABLE_DEPTH) continue;
      findings.push({
        rule: 'deep-schema',
        severity: 'info',
        item: tool.name,
        message: `"${tool.name}" nests its input schema ${depth} levels deep.`,
        detail: { depth },
      });
    }
    return findings;
  },
};

export const tokenBudget: Rule = {
  id: 'token-budget',
  description: 'The whole surface is injected into context on every single call.',
  defaultSeverity: 'warn',
  // Resident cost is the same problem in both worlds: an MCP manifest and a
  // skills listing are both paid for on every request, whether or not anything
  // is selected. For skills this counts routing descriptions only.
  appliesTo: ['mcp', 'skills'],
  run(surface) {
    const findings: Finding[] = [];
    const { total } = countSurfaceTokens(surface);
    const noun = itemNoun(surface);

    if (total >= TOKEN_BUDGET_ERROR) {
      findings.push({
        rule: 'token-budget',
        severity: 'error',
        message: `These ${noun}s cost ~${total.toLocaleString()} tokens per session, before any work happens.`,
        detail: { total, budget: TOKEN_BUDGET_ERROR },
      });
    } else if (total >= TOKEN_BUDGET_WARN) {
      findings.push({
        rule: 'token-budget',
        severity: 'warn',
        message: `These ${noun}s cost ~${total.toLocaleString()} tokens per session.`,
        detail: { total, budget: TOKEN_BUDGET_WARN },
      });
    }

    if (surface.items.length < MIN_TOOLS_FOR_SHARE) return findings;

    for (const item of surface.items) {
      const tokens = countItemTokens(item);
      const share = total === 0 ? 0 : tokens / total;
      if (share < TOOL_SHARE_WARN) continue;
      findings.push({
        rule: 'token-budget',
        severity: 'warn',
        item: item.name,
        message: `"${item.name}" alone is ${Math.round(share * 100)}% of the ${noun} surface (~${tokens.toLocaleString()} tokens).`,
        detail: { tokens, share },
      });
    }

    return findings;
  },
};
