import type { Surface, SurfaceKind } from '../types.js';
import type { Adapter, LoadOptions } from './contract.js';
import { mcpAdapter } from './mcp/index.js';
import { parseTarget, type ParseTargetOptions, type Target } from './target.js';

export { identityPresentation } from './contract.js';
export type {
  Adapter,
  LoadOptions,
  Presentation,
  PresentOptions,
  ToolDeclaration,
} from './contract.js';
export { parseTarget, splitCommand, resolveSkillRoot } from './target.js';
export type { Target, ParseTargetOptions } from './target.js';

// Partial on purpose. `parseTarget` can already resolve a skills target, so
// pointing at a skills directory today must fail with a straight answer rather
// than be quietly handled by the MCP adapter.
const ADAPTERS: Partial<Record<SurfaceKind, Adapter>> = {
  mcp: mcpAdapter,
};

export function adapterFor(kind: SurfaceKind): Adapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`The ${kind} adapter is not implemented yet.`);
  return adapter;
}

/** Resolve a target string and load it through whichever adapter owns it. */
export async function loadSurface(
  target: string | Target,
  options: LoadOptions & ParseTargetOptions = {},
): Promise<Surface> {
  const resolved = typeof target === 'string' ? parseTarget(target, options) : target;
  return adapterFor(resolved.adapter).load(resolved, options);
}
