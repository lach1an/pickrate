import type { Rule } from '../../types.js';
import { missingToolDescription, nearDuplicateDescription, thinToolDescription } from './descriptions.js';
import { enumCandidate, missingParamDescription } from './parameters.js';
import { deepSchema, manifestTokenBudget } from './shape.js';

/**
 * Every static check, in report order.
 *
 * Rules are pure: manifest in, findings out. No network, no model, no API key.
 * That constraint is what makes `pickrate inspect` a `npx`-and-nothing-else
 * experience, so keep it.
 */
export const rules: Rule[] = [
  manifestTokenBudget,
  missingToolDescription,
  thinToolDescription,
  nearDuplicateDescription,
  missingParamDescription,
  enumCandidate,
  deepSchema,
];

export const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

export * from './descriptions.js';
export * from './parameters.js';
export * from './shape.js';
