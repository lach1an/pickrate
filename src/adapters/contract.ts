import type { JsonSchema, Surface, SurfaceKind, ToolCall } from '../types.js';
import type { Target } from './target.js';

/**
 * What an adapter is, with no adapter imported.
 *
 * Kept apart from `index.ts` deliberately: the registry there imports every
 * adapter, and every adapter needs these declarations, so putting both in one
 * module is a cycle — one that resolves at type-check time and then throws
 * "cannot access before initialization" at runtime.
 */

export interface LoadOptions {
  /** Extra headers for HTTP targets (auth, etc). */
  headers?: Record<string, string>;
  /** Extra env for stdio targets, merged over the inherited defaults. */
  env?: Record<string, string>;
  /** Overall budget for connect + list, in ms. */
  timeoutMs?: number;
}

/** A tool as offered to the model, with no provider vocabulary in it. */
export interface ToolDeclaration {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

/**
 * How a surface is put in front of a model, and how the answer is read back.
 *
 * Deliberately provider-neutral: this emits plain declarations and plain text,
 * and `src/provider/` converts them. That is what lets adapters decide
 * presentation while the Anthropic SDK stays contained to one directory.
 */
export interface Presentation {
  tools: ToolDeclaration[];
  /**
   * Appended to the base system prompt.
   *
   * Must be byte-stable across every trial in a run — it sits inside the
   * cached prefix, and a suffix that varies (iteration order, a path, a
   * timestamp) silently defeats warm-then-fan-out and makes the run ~10×
   * dearer. Build it by deterministic iteration over the surface.
   */
  systemSuffix?: string;
  /**
   * Raw model calls → the selections the scorer scores.
   *
   * For MCP these are the same thing, so this is the identity. For skills they
   * are not: the model calls one dispatch tool and names a skill in its
   * arguments, and it is the named skill that has to reach the scorer.
   *
   * Pure and total: same calls in, same selections out, no I/O. And it must
   * **never drop a call** — a call it cannot map passes through under a name
   * that is visibly wrong rather than vanishing. Dropping one turns a bad
   * selection into an empty call list, which the scorer reads as restraint: a
   * silent false pass in the metric that is already the most neglected.
   *
   * The projected arguments are what `expect.args` is matched against.
   */
  project(calls: ToolCall[]): ToolCall[];
}

export interface PresentOptions {
  /** Adapter-specific presentation mode, e.g. skills' `skill-tool`. */
  mode?: string;
}

export interface Adapter {
  id: SurfaceKind;
  load(target: Target, options?: LoadOptions): Promise<Surface>;
  present(surface: Surface, options?: PresentOptions): Presentation;
}

/** The presentation used when selecting and calling are the same act. */
export function identityPresentation(tools: ToolDeclaration[]): Presentation {
  return { tools, project: (calls) => calls };
}
