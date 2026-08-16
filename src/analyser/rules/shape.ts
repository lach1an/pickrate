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

/**
 * A tool that advertises no input schema at all.
 *
 * Distinct from a tool that takes no arguments: `{type: "object", properties:
 * {}}` says "nothing to pass" and is fine. This fires on a schema that says
 * *nothing* — no `type`, no `properties` — which is what a serialiser produces
 * when it fails and returns its envelope. `@modelcontextprotocol/server-
 * filesystem` shipped exactly that for 13 of 14 tools across ten releases from
 * 0.5.1 to 2025.8.21, so `read_text_file` advertised no `path`.
 *
 * It has to be its own rule because `missing-param-description` walks declared
 * properties: with none declared it finds nothing and stays silent, which is
 * the one thing this codebase refuses to let mean "clean".
 */
export const emptyInputSchema: Rule = {
  id: 'empty-input-schema',
  description: 'A tool whose input schema declares nothing at all — the model is told it takes no arguments.',
  defaultSeverity: 'error',
  appliesTo: ['mcp'],
  run(surface) {
    const findings: Finding[] = [];
    for (const tool of toolsOf(surface)) {
      const schema = tool.inputSchema;
      // Either key present means the schema is making a claim; absent both, it is an empty envelope.
      if (schema['type'] === 'object' || schema['properties'] !== undefined) continue;

      findings.push({
        rule: 'empty-input-schema',
        severity: 'error',
        item: tool.name,
        path: 'inputSchema',
        message:
          `"${tool.name}" declares no input schema — the model is told it takes no arguments. ` +
          'If that is true, say so with {"type":"object","properties":{}}.',
        detail: { inputSchema: schema },
      });
    }
    return findings;
  },
};

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
  // Resident cost applies to both worlds; for skills this counts routing descriptions only.
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
