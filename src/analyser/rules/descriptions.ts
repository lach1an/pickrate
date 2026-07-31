import { toolsOf } from '../../surface.js';
import type { Finding, Rule } from '../../types.js';

/** Descriptions shorter than this are treated as carrying no real signal. */
export const THIN_DESCRIPTION_WORDS = 4;
/** Trigram overlap above which two tools are flagged as confusable. */
export const NEAR_DUPLICATE_THRESHOLD = 0.6;

export const missingToolDescription: Rule = {
  id: 'missing-tool-description',
  description: 'Every tool needs a description — it is the model\'s only guide to what the tool does.',
  defaultSeverity: 'error',
  appliesTo: ['mcp'],
  run(surface) {
    return toolsOf(surface)
      .filter((tool) => (tool.description ?? '').trim() === '')
      .map((tool) => ({
        rule: 'missing-tool-description',
        severity: 'error' as const,
        item: tool.name,
        message: `"${tool.name}" has no description. The model has only the name to go on.`,
      }));
  },
};

export const thinToolDescription: Rule = {
  id: 'thin-tool-description',
  description: `Descriptions under ${THIN_DESCRIPTION_WORDS} words rarely disambiguate anything.`,
  defaultSeverity: 'warn',
  appliesTo: ['mcp'],
  run(surface) {
    const findings: Finding[] = [];
    for (const tool of toolsOf(surface)) {
      const text = (tool.description ?? '').trim();
      if (text === '') continue; // covered by missing-tool-description
      const words = countWords(text);
      if (words >= THIN_DESCRIPTION_WORDS) continue;
      findings.push({
        rule: 'thin-tool-description',
        severity: 'warn',
        item: tool.name,
        message: `"${tool.name}" has a ${words}-word description: "${text}".`,
        detail: { words },
      });
    }
    return findings;
  },
};

export const nearDuplicateDescription: Rule = {
  id: 'near-duplicate-description',
  description: 'Items whose descriptions overlap heavily are the classic wrong-thing-selected failure.',
  defaultSeverity: 'warn',
  // Reads only name and description, which every surface item has — no narrowing needed.
  appliesTo: ['mcp', 'skills'],
  run(surface) {
    const findings: Finding[] = [];
    const profiles = surface.items.map((item) => ({
      name: item.name,
      grams: trigrams(`${item.name} ${item.description ?? ''}`),
    }));

    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const a = profiles[i]!;
        const b = profiles[j]!;
        const score = jaccard(a.grams, b.grams);
        if (score < NEAR_DUPLICATE_THRESHOLD) continue;
        findings.push({
          rule: 'near-duplicate-description',
          severity: 'warn',
          item: a.name,
          message: `"${a.name}" and "${b.name}" describe themselves ${Math.round(score * 100)}% alike — the model may confuse them.`,
          detail: { pair: [a.name, b.name], similarity: score },
        });
      }
    }
    return findings;
  },
};

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Word trigrams. Plain n-gram overlap; no embeddings, no model, no API key. */
export function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const grams = new Set<string>();
  if (words.length < 3) {
    for (const word of words) grams.add(word);
    return grams;
  }
  for (let i = 0; i + 2 < words.length; i++) {
    grams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
