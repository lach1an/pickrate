import { DECOY_COUNT, decoyItems } from '../decoys.js';
import { cloneSurface } from '../edit.js';
import type { Mutant, Operator } from '../contract.js';

/**
 * Bury the real surface in irrelevant items.
 *
 * The only operator that damages nothing in particular. It tests the claim in
 * spec §1 that a manifest is a prompt and that its *size* is a cost: if twenty
 * unrelated tools do not measurably degrade selection, then "your manifest
 * costs 34k tokens" is a statement about a bill and not about behaviour, and
 * the report should stop implying otherwise.
 *
 * Enumerates exactly one mutant: unlike the description operators there is no
 * per-item choice to make.
 */
export const injectDecoys: Operator = {
  id: 'inject-decoys',
  description: `Add ${DECOY_COUNT} plausible but irrelevant items to the surface.`,
  appliesTo: ['mcp', 'skills'],
  enumerate(surface) {
    if (surface.items.length === 0) return [];

    const mutant: Mutant = {
      id: 'inject-decoys',
      operator: 'inject-decoys',
      targets: [], // nothing existing is damaged; report reads this as "surface-wide"
      describe: `${DECOY_COUNT} irrelevant items added to a surface of ${surface.items.length}`,
      apply(base) {
        const next = cloneSurface(base);
        // Appended after the real items so the listing stays byte-stable across trials.
        next.items.push(...decoyItems(next.kind, next.items.map((item) => item.name)));
        return next;
      },
    };

    return [mutant];
  },
};
