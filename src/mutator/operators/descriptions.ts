import { describable, withDescription } from '../edit.js';
import type { Mutant, Operator } from '../contract.js';

/**
 * Blank one description.
 *
 * The most direct test there is: if removing an item's entire routing
 * description does not move the score, the harness is not reading descriptions
 * and no number it reports about them means anything.
 *
 * Set to `''` rather than dropped, because that is what a real broken manifest
 * looks like — and it is what `missing-tool-description` already treats as the
 * failure, so `inspect` on the mutant names the defect we injected.
 */
export const blankDescription: Operator = {
  id: 'blank-description',
  description: 'Remove one item\'s description entirely.',
  appliesTo: ['mcp', 'skills'],
  enumerate(surface) {
    return describable(surface).map(
      (item): Mutant => ({
        id: `blank-description:${item.name}`,
        operator: 'blank-description',
        targets: [item.name],
        describe: `"${item.name}" loses its description`,
        apply: (base) => withDescription(base, item.name, ''),
      }),
    );
  },
};

/**
 * Make two items trade descriptions.
 *
 * Where blanking asks "is the description read at all", this asks the sharper
 * question: is it read *instead of* the name. A surface whose names are
 * self-explanatory will survive this legitimately — the model can still get it
 * right from `delete_branch` alone. That is a finding about the scenarios, not
 * a bug to tune away, so a surviving swap is reported with its targets named.
 */
export const swapDescriptions: Operator = {
  id: 'swap-descriptions',
  description: 'Make two items trade descriptions, leaving their names alone.',
  appliesTo: ['mcp', 'skills'],
  enumerate(surface) {
    const items = describable(surface);
    const mutants: Mutant[] = [];

    // Every unordered pair, in surface order — deterministic without a seed.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        mutants.push({
          id: `swap-descriptions:${a.name}+${b.name}`,
          operator: 'swap-descriptions',
          targets: [a.name, b.name],
          describe: `"${a.name}" and "${b.name}" trade descriptions`,
          apply: (base) =>
            withDescription(
              withDescription(base, a.name, b.description ?? ''),
              b.name,
              a.description ?? '',
            ),
        });
      }
    }
    return mutants;
  },
};
