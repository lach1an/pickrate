import { skillsOf } from '../../surface.js';
import type { Finding, Rule } from '../../types.js';
import { THIN_DESCRIPTION_WORDS } from './descriptions.js';

/**
 * Hard limit on a skill description. Not a style preference: past it the
 * loader rejects the skill outright, so the skill is not merely worse at
 * triggering — it is absent.
 */
export const MAX_SKILL_DESCRIPTION = 1024;

/**
 * Phrases that say *when* to reach for a skill rather than what it is.
 *
 * A deliberately shallow test. It cannot tell a good trigger from a bad one,
 * and it is not trying to: it catches the documented failure mode where a
 * description is written as a title ("PDF processing utilities") and so gives
 * the model nothing to match a request against. Hence `info`, not `warn`.
 */
export const TRIGGER_PATTERNS: RegExp[] = [
  /\buse (this|when|it when|for)\b/i,
  /\bwhen (the user|you|asked|working|handling|dealing|creating|editing|reviewing)\b/i,
  /\bif the user\b/i,
  /\bfor (requests|tasks|questions|anything)\b/i,
  /\btriggers? (on|when)\b/i,
];

export const unparseableSkill: Rule = {
  id: 'unparseable-skill',
  description: 'A skill whose frontmatter will not parse can never be selected.',
  defaultSeverity: 'error',
  appliesTo: ['skills'],
  run(surface) {
    return skillsOf(surface)
      .filter((skill) => skill.error !== undefined)
      .map((skill) => ({
        rule: 'unparseable-skill',
        severity: 'error' as const,
        item: skill.name,
        message: `${skill.path}: ${skill.error}`,
        detail: { path: skill.path },
      }));
  },
};

export const missingSkillDescription: Rule = {
  id: 'missing-skill-description',
  description: 'A skill with no description is pure context tax — it can never trigger.',
  defaultSeverity: 'error',
  appliesTo: ['skills'],
  run(surface) {
    return skillsOf(surface)
      .filter((skill) => skill.error === undefined) // already reported as unparseable
      .filter((skill) => (skill.description ?? '').trim() === '')
      .map((skill) => ({
        rule: 'missing-skill-description',
        severity: 'error' as const,
        item: skill.name,
        path: 'description',
        message: `"${skill.name}" has no description. It will sit in every request and never fire.`,
      }));
  },
};

export const skillDescriptionLength: Rule = {
  id: 'skill-description-length',
  description: `Descriptions over ${MAX_SKILL_DESCRIPTION} characters are rejected by the loader.`,
  defaultSeverity: 'error',
  appliesTo: ['skills'],
  run(surface) {
    const findings: Finding[] = [];
    for (const skill of skillsOf(surface)) {
      const length = (skill.description ?? '').length;
      if (length <= MAX_SKILL_DESCRIPTION) continue;
      findings.push({
        rule: 'skill-description-length',
        severity: 'error',
        item: skill.name,
        path: 'description',
        message: `"${skill.name}" has a ${length}-character description, over the ${MAX_SKILL_DESCRIPTION} limit by ${length - MAX_SKILL_DESCRIPTION}.`,
        detail: { length, limit: MAX_SKILL_DESCRIPTION },
      });
    }
    return findings;
  },
};

export const thinSkillDescription: Rule = {
  id: 'thin-skill-description',
  description: `Descriptions under ${THIN_DESCRIPTION_WORDS} words rarely disambiguate anything.`,
  defaultSeverity: 'warn',
  appliesTo: ['skills'],
  run(surface) {
    const findings: Finding[] = [];
    for (const skill of skillsOf(surface)) {
      const text = (skill.description ?? '').trim();
      if (text === '') continue; // covered by missing-skill-description
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words >= THIN_DESCRIPTION_WORDS) continue;
      findings.push({
        rule: 'thin-skill-description',
        severity: 'warn',
        item: skill.name,
        path: 'description',
        message: `"${skill.name}" has a ${words}-word description: "${text}".`,
        detail: { words },
      });
    }
    return findings;
  },
};

export const skillDescriptionNoTriggers: Rule = {
  id: 'skill-description-no-triggers',
  description: 'A description that says what a skill is, but never when to use it.',
  defaultSeverity: 'info',
  appliesTo: ['skills'],
  run(surface) {
    const findings: Finding[] = [];
    for (const skill of skillsOf(surface)) {
      const text = (skill.description ?? '').trim();
      if (text === '') continue; // covered by missing-skill-description
      if (TRIGGER_PATTERNS.some((pattern) => pattern.test(text))) continue;
      findings.push({
        rule: 'skill-description-no-triggers',
        severity: 'info',
        item: skill.name,
        path: 'description',
        message: `"${skill.name}" describes what it is but not when to use it — the model matches requests against this text.`,
      });
    }
    return findings;
  },
};
