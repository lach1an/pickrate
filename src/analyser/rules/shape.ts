import type { Finding, Rule } from '../../types.js';
import { maxDepth } from '../schema.js';
import { countToolTokens, countManifestTokens } from '../tokens.js';

/** Nesting beyond this reliably degrades argument accuracy. */
export const MAX_REASONABLE_DEPTH = 3;
/** Manifest budgets, in approximate tokens. */
export const TOKEN_BUDGET_WARN = 10_000;
export const TOKEN_BUDGET_ERROR = 25_000;
/** A single tool eating more than this share of the manifest is suspicious. */
export const TOOL_SHARE_WARN = 0.25;
/**
 * Below this many tools, a large share is arithmetic rather than a finding —
 * one tool in three is 33% of the manifest and there is nothing wrong with that.
 */
export const MIN_TOOLS_FOR_SHARE = 8;

export const deepSchema: Rule = {
  id: 'deep-schema',
  description: `Input schemas nested deeper than ${MAX_REASONABLE_DEPTH} levels are hard for a model to fill in correctly.`,
  defaultSeverity: 'info',
  run(manifest) {
    const findings: Finding[] = [];
    for (const tool of manifest.tools) {
      const depth = maxDepth(tool.inputSchema);
      if (depth <= MAX_REASONABLE_DEPTH) continue;
      findings.push({
        rule: 'deep-schema',
        severity: 'info',
        tool: tool.name,
        message: `"${tool.name}" nests its input schema ${depth} levels deep.`,
        detail: { depth },
      });
    }
    return findings;
  },
};

export const manifestTokenBudget: Rule = {
  id: 'manifest-token-budget',
  description: 'The whole manifest is injected into context on every single call.',
  defaultSeverity: 'warn',
  run(manifest) {
    const findings: Finding[] = [];
    const { total } = countManifestTokens(manifest);

    if (total >= TOKEN_BUDGET_ERROR) {
      findings.push({
        rule: 'manifest-token-budget',
        severity: 'error',
        message: `Manifest costs ~${total.toLocaleString()} tokens per session, before any work happens.`,
        detail: { total, budget: TOKEN_BUDGET_ERROR },
      });
    } else if (total >= TOKEN_BUDGET_WARN) {
      findings.push({
        rule: 'manifest-token-budget',
        severity: 'warn',
        message: `Manifest costs ~${total.toLocaleString()} tokens per session.`,
        detail: { total, budget: TOKEN_BUDGET_WARN },
      });
    }

    if (manifest.tools.length < MIN_TOOLS_FOR_SHARE) return findings;

    for (const tool of manifest.tools) {
      const tokens = countToolTokens(tool);
      const share = total === 0 ? 0 : tokens / total;
      if (share < TOOL_SHARE_WARN) continue;
      findings.push({
        rule: 'manifest-token-budget',
        severity: 'warn',
        tool: tool.name,
        message: `"${tool.name}" alone is ${Math.round(share * 100)}% of the manifest (~${tokens.toLocaleString()} tokens).`,
        detail: { tokens, share },
      });
    }

    return findings;
  },
};
