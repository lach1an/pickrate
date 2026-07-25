import type { Finding, Rule } from '../../types.js';
import { walkProperties } from '../schema.js';

/** Phrasings that suggest a free-text string is really a closed set. */
const ENUM_HINTS = [
  /\bone of\b/i,
  /\beither\b/i,
  /\bmust be\b.*\bor\b/i,
  /\bvalid values?\b/i,
  /\ballowed values?\b/i,
  /\be\.g\.\s*['"`]/i,
];

export const missingParamDescription: Rule = {
  id: 'missing-param-description',
  description: 'Undocumented parameters are where the model invents formats.',
  defaultSeverity: 'warn',
  run(manifest) {
    const findings: Finding[] = [];
    for (const tool of manifest.tools) {
      for (const prop of walkProperties(tool.inputSchema)) {
        const description = typeof prop.schema.description === 'string' ? prop.schema.description.trim() : '';
        if (description !== '') continue;
        findings.push({
          rule: 'missing-param-description',
          severity: prop.required ? 'warn' : 'info',
          tool: tool.name,
          path: prop.path,
          message: `${tool.name}.${prop.path} has no description${prop.required ? ' and is required' : ''}.`,
          detail: { required: prop.required, type: prop.schema.type },
        });
      }
    }
    return findings;
  },
};

export const enumCandidate: Rule = {
  id: 'enum-candidate',
  description: 'Free-text params whose description lists the valid values should just be an enum.',
  defaultSeverity: 'info',
  run(manifest) {
    const findings: Finding[] = [];
    for (const tool of manifest.tools) {
      for (const prop of walkProperties(tool.inputSchema)) {
        if (prop.schema.type !== 'string') continue;
        if (Array.isArray(prop.schema.enum) || typeof prop.schema.const === 'string') continue;

        const description = typeof prop.schema.description === 'string' ? prop.schema.description : '';
        const hint = ENUM_HINTS.find((pattern) => pattern.test(description));
        if (!hint) continue;

        findings.push({
          rule: 'enum-candidate',
          severity: 'info',
          tool: tool.name,
          path: prop.path,
          message: `${tool.name}.${prop.path} is a free-text string but its description enumerates values — make it an enum.`,
          detail: { description },
        });
      }
    }
    return findings;
  },
};
