import type { Rule } from '../../types.js';
import { missingToolDescription, nearDuplicateDescription, thinToolDescription } from './descriptions.js';
import { enumCandidate, missingParamDescription } from './parameters.js';
import { deepSchema, tokenBudget } from './shape.js';
import {
  missingSkillDescription,
  skillDescriptionLength,
  skillDescriptionNoTriggers,
  thinSkillDescription,
  unparseableSkill,
} from './skills.js';

/**
 * Every static check, in report order.
 *
 * Rules are pure: surface in, findings out. No network, no model, no API key.
 * That constraint is what makes `pickrate inspect` a `npx`-and-nothing-else
 * experience, so keep it.
 */
export const rules: Rule[] = [
  tokenBudget,
  unparseableSkill,
  missingToolDescription,
  missingSkillDescription,
  skillDescriptionLength,
  thinToolDescription,
  thinSkillDescription,
  nearDuplicateDescription,
  skillDescriptionNoTriggers,
  missingParamDescription,
  enumCandidate,
  deepSchema,
];

export const rulesById = new Map(rules.map((rule) => [rule.id, rule]));

export * from './descriptions.js';
export * from './parameters.js';
export * from './shape.js';
export * from './skills.js';
