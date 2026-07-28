#!/usr/bin/env node
/**
 * Calibrate `inspect`'s token count against the authoritative counting endpoint.
 *
 * **Not a test.** It needs an API key and it makes network calls, so it never
 * runs in `npm test`. Run it by hand:
 *
 *     npx tsx scripts/calibrate-tokens.ts
 *
 * Why it exists: `inspect`'s headline number is `gpt-tokenizer` output computed
 * offline, and the counting endpoint's own documentation names tool schemas as
 * the thing local tokenisers get wrong. The error is probably a consistent
 * under-count and is currently unquantified — which means the headline number
 * of the zero-credential first run is an estimate of unknown quality.
 *
 * What it measures: the *surface's* cost in isolation, not the whole request.
 * It counts the presented request twice — once as it would be sent, once with
 * the surface stripped out — and takes the difference. Comparing the local
 * surface total against a whole-request count would fold in the system prompt
 * and the scenario prompt and report a difference that is mostly not the thing
 * under test.
 *
 * The result belongs in `plans/multi-provider-implementation.md` (step 0b) and,
 * if the error is large, in `inspect`'s own copy. Only carry a correction factor
 * if the error turns out to be *consistent*: a factor applied over a variable
 * error is worse than the raw number, because it looks authoritative.
 */
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { analyse } from '../src/analyser/index.js';
import { adapterFor, loadSurface } from '../src/adapters/index.js';
import type { Presentation } from '../src/adapters/contract.js';
import { DEFAULT_MODEL } from '../src/provider/anthropic.js';

const fixture = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const TARGETS = [
  fixture('git-server.json'),
  fixture('messy-server.json'),
  fixture('skills/clean'),
  fixture('skills/messy'),
];

const client = new Anthropic();
const model = process.env.PICKRATE_MODEL ?? DEFAULT_MODEL;

/** One prompt, held constant, so it cancels out of the difference. */
const PROMPT = 'hello';

async function count(presentation: Pick<Presentation, 'tools' | 'systemSuffix'>): Promise<number> {
  const counted = await client.messages.countTokens({
    model,
    tools: presentation.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    })),
    system: presentation.systemSuffix ?? '',
    messages: [{ role: 'user', content: PROMPT }],
  });
  return counted.input_tokens;
}

console.log(`model: ${model}\n`);
console.log('target'.padEnd(28), 'local'.padStart(8), 'actual'.padStart(8), 'delta'.padStart(9));

for (const target of TARGETS) {
  const surface = await loadSurface(target);
  const presentation = adapterFor(surface.kind).present(surface);
  const local = analyse(surface).tokens.total;

  const withSurface = await count(presentation);
  // The floor: the same request with nothing of the surface in it. Whatever the
  // endpoint charges for an empty envelope is not the manifest's cost.
  const withoutSurface = await count({ tools: [] });
  const actual = withSurface - withoutSurface;

  const delta = ((local - actual) / actual) * 100;
  const name = target.split('/').slice(-2).join('/');
  console.log(
    name.padEnd(28),
    String(local).padStart(8),
    String(actual).padStart(8),
    `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(9),
  );
}

console.log(
  '\nA negative delta is an under-count: the surface costs more than inspect says.\n' +
    'Write the numbers down before deciding whether they need a correction factor.',
);
