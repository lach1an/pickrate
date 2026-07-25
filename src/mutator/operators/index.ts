import { blankDescription, swapDescriptions } from './descriptions.js';
import { injectDecoys } from './decoys.js';
import type { Operator } from '../contract.js';

/**
 * Every mutation operator, in planning order.
 *
 * The planner takes mutants round-robin across this list, so the order decides
 * what a small `--mutants` budget is spent on. Blanking first, because it is
 * the operator whose survival is least ambiguous: if it survives, the harness
 * is not reading descriptions at all.
 *
 * Spec §6 lists seven operators. These are the three M3 names; the rest are a
 * one-file addition, and deliberately not made before there is evidence about
 * how many mutants a mutation score needs to mean anything (spec §8.5).
 */
export const operators: Operator[] = [blankDescription, swapDescriptions, injectDecoys];

export const operatorsById = new Map(operators.map((operator) => [operator.id, operator]));

export { blankDescription, swapDescriptions } from './descriptions.js';
export { injectDecoys } from './decoys.js';
