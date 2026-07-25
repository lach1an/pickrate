import type { Surface, SurfaceKind } from '../types.js';
import type { Adapter, LoadOptions } from './contract.js';
import { mcpAdapter } from './mcp/index.js';
import { skillsAdapter } from './skills/index.js';
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
export { skillsAdapter, loadSkills, loadSkillFile } from './skills/index.js';
export type { Target, ParseTargetOptions } from './target.js';

const ADAPTERS: Record<SurfaceKind, Adapter> = {
  mcp: mcpAdapter,
  skills: skillsAdapter,
};

export function adapterFor(kind: SurfaceKind): Adapter {
  return ADAPTERS[kind];
}

/** Resolve a target string and load it through whichever adapter owns it. */
export async function loadSurface(
  target: string | Target,
  options: LoadOptions & ParseTargetOptions = {},
): Promise<Surface> {
  const resolved = typeof target === 'string' ? parseTarget(target, options) : target;
  return adapterFor(resolved.adapter).load(resolved, options);
}
