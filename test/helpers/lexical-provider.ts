import { jaccard } from '../../src/analyser/rules/descriptions.js';
import type { Presentation, ToolDeclaration } from '../../src/adapters/contract.js';
import type { Provider } from '../../src/provider/index.js';
import type { Scenario, ToolCall, TrialResult } from '../../src/types.js';

/**
 * A fake model that actually reads the surface.
 *
 * **Test-only, deliberately.** It never lands in `src/` and is never reachable
 * from the CLI, because the scores it produces are fiction: it does word
 * overlap, not reasoning, and a mutation score derived from it says nothing
 * about any real model. What it *is* good for is proving the mutation loop
 * wires up — that damaging a description reaches the presentation, changes what
 * gets selected, and comes out the far end as a killed mutant — with no API
 * key, no network and no spend.
 *
 * `ReplayProvider` cannot do this job. It is keyed on scenario id and is
 * indifferent to the surface, so every mutant replays identically and the
 * mutation score comes out at zero regardless of whether the harness works.
 * Surface-awareness is the entire point of this class.
 *
 * It reads exactly what a real model is given: the tool declarations plus the
 * system suffix. That means it selects skills through the dispatch tool in
 * `skill-tool` mode, the same as the thing under test.
 */
export class LexicalProvider implements Provider {
  readonly model = 'lexical';
  readonly seen: string[] = [];

  /** Overlap below which it calls nothing — what makes restraint expressible. */
  constructor(private readonly cutoff = 0.08) {}

  async runTrial(presentation: Presentation, scenario: Scenario): Promise<TrialResult> {
    this.seen.push(scenario.id);

    const prompt = words(scenario.prompt);
    const ranked = candidates(presentation)
      .map((candidate) => ({ candidate, score: jaccard(prompt, words(candidate.text)) }))
      .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

    const best = ranked[0];
    const calls: ToolCall[] =
      best && best.score >= this.cutoff ? [invoke(presentation, best.candidate.name)] : [];

    return {
      scenarioId: scenario.id,
      calls,
      stopReason: calls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }
}

interface Candidate {
  name: string;
  /** The text the model would be choosing from: name plus description. */
  text: string;
}

/**
 * Everything selectable in this presentation.
 *
 * In `skill-tool` mode the choices are not the declarations — there is one
 * dispatch tool — they are the listing lines in the system suffix. Reading both
 * is what makes this fake sensitive to a damaged skill description rather than
 * only to a damaged tool description.
 */
function candidates(presentation: Presentation): Candidate[] {
  const listed = [...(presentation.systemSuffix ?? '').matchAll(/^- ([^:\n]+): (.*)$/gm)].map(
    (match): Candidate => ({ name: match[1]!, text: `${match[1]} ${match[2]}` }),
  );
  if (listed.length > 0) return listed;

  return presentation.tools.map(
    (tool): Candidate => ({ name: tool.name, text: `${tool.name} ${tool.description ?? ''}` }),
  );
}

/**
 * Turn a chosen name into the call a model would actually emit.
 *
 * If some declaration offers the name through an enum, that is a dispatch tool
 * and the choice goes in its arguments. Otherwise the name is the tool.
 */
function invoke(presentation: Presentation, chosen: string): ToolCall {
  for (const tool of presentation.tools) {
    const key = enumKeyFor(tool, chosen);
    if (key !== undefined) return { name: tool.name, args: { [key]: chosen } };
  }
  return { name: chosen, args: {} };
}

function enumKeyFor(tool: ToolDeclaration, value: string): string | undefined {
  const properties = tool.inputSchema.properties;
  if (typeof properties !== 'object' || properties === null) return undefined;

  for (const [key, schema] of Object.entries(properties as Record<string, unknown>)) {
    const values = (schema as { enum?: unknown }).enum;
    if (Array.isArray(values) && values.includes(value)) return key;
  }
  return undefined;
}

/**
 * Bag of content words.
 *
 * Word *trigrams* — what `near-duplicate-description` compares — find nothing
 * at these lengths: a six-word prompt and a one-sentence description share no
 * run of three words even when they are obviously about the same thing. So the
 * sets are unigrams and only the set comparison is shared with the analyser.
 */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'can', 'with', 'from', 'that', 'this',
  'are', 'was', 'has', 'have', 'not', 'but', 'its', 'it\'s', 'been', 'were',
  'use', 'used', 'using', 'when', 'what', 'how', 'why', 'who', 'all', 'any',
  'one', 'two', 'new', 'out', 'off', 'own', 'via', 'per', 'may', 'more',
]);
