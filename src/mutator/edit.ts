import type { Surface, SurfaceItem } from '../types.js';

/**
 * Shared surface-editing primitives for operators.
 *
 * Every one of these clones first. Operators are applied to a baseline surface
 * that is re-used across a whole mutation session, so an in-place edit would
 * poison every measurement taken after it — and the only symptom would be the
 * mutation score itself, which is precisely the number nobody can eyeball for
 * plausibility.
 */

/** A copy nothing else holds a reference into. */
export function cloneSurface(surface: Surface): Surface {
  return structuredClone(surface);
}

/**
 * Rewrite one item's description in a copy of the surface.
 *
 * The normalised `description` is what the presenters and the token counter
 * read, so that alone is what reaches the model. `raw` (and, for skills,
 * `frontmatter`) is mirrored where the key already exists, so that running
 * `inspect` on a mutant reports the surface that was actually measured rather
 * than the undamaged original. Keys that were never there are not invented:
 * a mutant should be the baseline plus one known defect, nothing else.
 */
export function withDescription(surface: Surface, name: string, description: string): Surface {
  return mapItem(surface, name, (item) => {
    item.description = description;
    if ('description' in item.raw) item.raw.description = description;
    if (item.kind === 'skill' && 'description' in item.frontmatter) {
      item.frontmatter.description = description;
    }
  });
}

/** Apply `edit` to the named item of a fresh copy. Throws if it is not there. */
export function mapItem(
  surface: Surface,
  name: string,
  edit: (item: SurfaceItem) => void,
): Surface {
  const next = cloneSurface(surface);
  const item = next.items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Cannot mutate "${name}": no such item in the surface.`);
  edit(item);
  return next;
}

/** Items an operator can meaningfully damage: present, parseable, described. */
export function describable(surface: Surface): SurfaceItem[] {
  return surface.items.filter(
    (item) =>
      (item.kind !== 'skill' || item.error === undefined) &&
      (item.description ?? '').trim() !== '',
  );
}
