import type { SkillDef, Surface, SurfaceItem, ToolDef } from './types.js';

/**
 * Narrowing helpers over a heterogeneous surface.
 *
 * A `Surface` holds `SurfaceItem`s, and most of the codebase only cares about
 * the name and description every item has. The parts that need more — schema
 * walking, argument linting — need one concrete kind, and these are how they
 * ask for it without a cast.
 */

export function isTool(item: SurfaceItem): item is ToolDef {
  return item.kind === 'tool';
}

export function isSkill(item: SurfaceItem): item is SkillDef {
  return item.kind === 'skill';
}

/** Tools in a surface. Empty for a skills surface, which is the point. */
export function toolsOf(surface: Surface): ToolDef[] {
  return surface.items.filter(isTool);
}

export function skillsOf(surface: Surface): SkillDef[] {
  return surface.items.filter(isSkill);
}

/** The noun to use in report copy for this surface. */
export function itemNoun(surface: { kind: Surface['kind'] }, plural = false): string {
  const noun = surface.kind === 'skills' ? 'skill' : 'tool';
  return plural ? `${noun}s` : noun;
}
