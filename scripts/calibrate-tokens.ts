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
 * The floor is the *envelope* — the same presentation with the surface emptied —
 * because tool scaffolding and a skills dispatch tool are fixed costs that do
 * not scale with the manifest. See step 0b in the implementation plan.
 *
 * The result belongs in `plans/multi-provider-implementation.md` (step 0b) and,
 * if the error is large, in `inspect`'s own copy. Only carry a correction factor
 * if the error turns out to be *consistent*: a factor applied over a variable
 * error is worse than the raw number, because it looks authoritative.
 */
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { analyse } from '../src/analyser/index.js';
import { countItemTokens } from '../src/analyser/tokens.js';
import { adapterFor, loadSurface } from '../src/adapters/index.js';
import type { Presentation } from '../src/adapters/contract.js';
import type { Surface, SurfaceItem, SurfaceKind } from '../src/types.js';
import { DEFAULT_MODEL } from '../src/provider/anthropic.js';
import { specFor } from '../src/provider/models.js';

const fixture = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const TARGETS = [
  fixture('git-server.json'),
  fixture('messy-server.json'),
  fixture('skills/clean'),
  fixture('skills/messy'),
];

/**
 * Three models, because there are three tokenisers in play and `inspect` uses
 * one number for all of them.
 *
 * Claude 4.7 introduced a new tokeniser that produces roughly 30% more tokens
 * for the same text, and every model since is on it — while this harness's
 * default (`claude-haiku-4-5`) is not. So `inspect`'s single offline number
 * cannot be equally right for both, and measuring one generation would write
 * down a figure that is wrong by about a third for the other.
 *
 * The OpenAI row is the one that pins the method down, and it is the reason this
 * sweep is worth running even with no Anthropic access: `inspect` counts with
 * `gpt-tokenizer` on `o200k_base`, which *is* an OpenAI tokeniser. Its delta
 * against OpenAI's own counter therefore separates two very different
 * explanations for any error — a tokeniser mismatch, or the per-tool schema
 * overhead that no local tokeniser can see. If the OpenAI row is near zero, the
 * offline number is right and the Claude gap is a tokeniser difference; if it is
 * large, the overhead is structural and applies everywhere.
 *
 * `inspect` never makes a model call and never sees `--model`, so it cannot pick
 * a side at runtime. What the deltas decide is whether the copy needs to name a
 * tokeniser at all.
 */
const MODELS = process.env.PICKRATE_MODELS?.split(',') ?? [
  DEFAULT_MODEL,
  'claude-opus-5',
  'gpt-5.6-luna',
];

/** One prompt, held constant, so it cancels out of the difference. */
const PROMPT = 'hello';

/** One stand-in item per kind: a truly empty surface has no scaffolding to measure, and skills refuse to present one. */
const MINIMAL: Record<SurfaceKind, SurfaceItem> = {
  mcp: { kind: 'tool', name: 'a', inputSchema: { type: 'object', properties: {} }, raw: {} },
  skills: { kind: 'skill', name: 'a', path: 'a/SKILL.md', body: '', frontmatter: {}, raw: {} },
};

/** The presentation with the manifest replaced by one minimal item — everything the adapter adds regardless. */
function envelopeOf(surface: Surface): Pick<Presentation, 'tools' | 'systemSuffix'> & { local: number } {
  const item = MINIMAL[surface.kind];
  const presented = adapterFor(surface.kind).present({ ...surface, items: [item] });
  return {
    tools: presented.tools,
    ...(presented.systemSuffix !== undefined ? { systemSuffix: presented.systemSuffix } : {}),
    local: countItemTokens(item),
  };
}

const anthropic = new Anthropic();
let openai: OpenAI | undefined;

async function count(
  model: string,
  presentation: Pick<Presentation, 'tools' | 'systemSuffix'>,
): Promise<number> {
  return specFor(model)?.provider === 'openai'
    ? countOpenAI(model, presentation)
    : countAnthropic(model, presentation);
}

async function countAnthropic(
  model: string,
  presentation: Pick<Presentation, 'tools' | 'systemSuffix'>,
): Promise<number> {
  const counted = await anthropic.messages.countTokens({
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

/**
 * The same measurement through the Responses counter, with the declaration shape
 * this provider actually uses — flattened, not nested under `function`. Counting
 * the wrong shape would measure a request pickrate never sends.
 */
async function countOpenAI(
  model: string,
  presentation: Pick<Presentation, 'tools' | 'systemSuffix'>,
): Promise<number> {
  openai ??= new OpenAI();
  const counted = await openai.responses.inputTokens.count({
    model,
    tools: presentation.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.inputSchema as Record<string, unknown>,
      strict: false,
    })),
    instructions: presentation.systemSuffix ?? '',
    input: [{ role: 'user', content: PROMPT }],
  });
  return counted.input_tokens;
}

// Free, per the counting endpoint's own docs — it bills nothing and draws on a
// rate-limit pool separate from message creation. The only budget this spends
// is requests per minute, and it makes eight of them.
console.log('Counting is free and separately rate-limited; this makes a handful of requests.\n');

for (const model of MODELS) {
  console.log(`model: ${model} (${specFor(model)?.provider ?? 'unknown provider'})`);
  console.log(
    '  ' + 'target'.padEnd(26),
    'local'.padStart(8),
    'actual'.padStart(8),
    'delta'.padStart(9),
    'envelope'.padStart(10),
  );

  // One provider being unreachable must not take the other's rows down with it.
  // A balance check can gate a free endpoint — Anthropic's does, OpenAI's does
  // not — so which halves of this table are obtainable varies by account, and a
  // partial table is still worth writing down.
  let bare: number;
  try {
    // Doubles as the reachability check: no tools, no surface, no scaffolding.
    bare = await count(model, { tools: [] });
  } catch (error) {
    console.log(`  skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`);
    continue;
  }

  for (const target of TARGETS) {
    const surface = await loadSurface(target);
    const presentation = adapterFor(surface.kind).present(surface);
    const local = analyse(surface).tokens.total;

    const withSurface = await count(model, presentation);
    // The floor: the same presentation with the manifest emptied out. What the
    // adapter and the provider add regardless is not the manifest's cost.
    const envelope = envelopeOf(surface);
    const withoutSurface = (await count(model, envelope)) - envelope.local;
    const actual = withSurface - withoutSurface;

    const delta = ((local - actual) / actual) * 100;
    const name = target.split('/').slice(-2).join('/');
    console.log(
      '  ' + name.padEnd(26),
      String(local).padStart(8),
      String(actual).padStart(8),
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(9),
      String(withoutSurface - bare).padStart(10),
    );
  }
  console.log();
}

console.log(
  'delta is the error on the manifest alone; envelope is the fixed cost of the\n' +
    'presentation itself, which inspect does not count and which does not scale.\n' +
    'A negative delta is an under-count: the surface costs more than inspect says.\n' +
    'Compare the two models before writing anything down — they are on different\n' +
    'tokenisers, and a gap between them is a number inspect cannot pick offline.\n' +
    'Only carry a correction factor if the error is consistent across both.',
);
