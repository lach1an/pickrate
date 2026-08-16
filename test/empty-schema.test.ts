import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ManifestValidationError, loadManifest } from '../src/adapters/mcp/index.js';
import { emptyInputSchema } from '../src/analyser/rules/shape.js';
import { missingParamDescription } from '../src/analyser/rules/parameters.js';
import type { JsonSchema, Surface } from '../src/types.js';

/**
 * The defect a rejected response hides, and the path that recovers it.
 *
 * Both halves matter and they are deliberately separate acts. Loading a server
 * whose `tools/list` fails validation is *not a measurement* — it throws, and
 * the CLI exits 2. Analysing captured bytes afterwards is a measurement, of a
 * file. Collapsing the two would turn "we could not read this" into "this
 * server is bad", which is the one reinterpretation the exit-code contract
 * forbids.
 */

const SERVER = fileURLToPath(new URL('./helpers/fake-mcp-server.mjs', import.meta.url));
const target = `node ${SERVER}`;

const surfaceOf = (schemas: JsonSchema[]): Surface => ({
  kind: 'mcp',
  items: schemas.map((inputSchema, i) => ({
    kind: 'tool',
    name: `tool_${i}`,
    description: 'Does a thing.',
    inputSchema,
    raw: {},
  })),
  source: { kind: 'file', adapter: 'mcp', target: 'test', fetchedAt: '2026-08-16T00:00:00.000Z' },
});

describe('empty-input-schema', () => {
  it('fires on the bare envelope a failed schema converter emits', () => {
    const surface = surfaceOf([{ $schema: 'http://json-schema.org/draft-07/schema#' }]);
    const findings = emptyInputSchema.run(surface);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, 'error');
    assert.equal(findings[0]!.item, 'tool_0');
    assert.equal(findings[0]!.path, 'inputSchema');
  });

  it('stays quiet on a tool that genuinely takes no arguments', () => {
    // `{type: object, properties: {}}` is a claim — "nothing to pass". The
    // defect is a schema that makes no claim at all, and conflating the two
    // would fire on every no-argument tool in the ecosystem.
    const surface = surfaceOf([{ type: 'object', properties: {} }]);
    assert.deepEqual(emptyInputSchema.run(surface), []);
  });

  it('stays quiet on a normal schema, and on one declaring only properties', () => {
    const surface = surfaceOf([
      { type: 'object', properties: { path: { type: 'string', description: 'A path.' } }, required: ['path'] },
      { properties: { path: { type: 'string', description: 'A path.' } } },
    ]);
    assert.deepEqual(emptyInputSchema.run(surface), []);
  });

  it('is the only rule that can see the defect, which is why it exists', () => {
    // `missing-param-description` walks declared properties. With none declared
    // it finds nothing and reports nothing — silence that reads as clean. This
    // asserts the gap rather than trusting the prose about it.
    const surface = surfaceOf([{ $schema: 'http://json-schema.org/draft-07/schema#' }]);
    assert.deepEqual(missingParamDescription.run(surface), []);
    assert.equal(emptyInputSchema.run(surface).length, 1);
  });
});

describe('capturing a response the SDK refuses', () => {
  it('throws with the raw bytes attached rather than losing them', async () => {
    const error = await loadManifest(target, {
      env: { FAKE_MCP_DEGRADED: '1' },
      timeoutMs: 20_000,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.ok(error instanceof ManifestValidationError, `expected a validation error, got ${String(error)}`);

    const raw = error.raw as { tools: Array<{ name: string; inputSchema: JsonSchema }> };
    assert.deepEqual(
      raw.tools.map((t) => t.name),
      ['alpha', 'beta'],
    );
    // The bytes are the point: a capture that dropped the schema would analyse
    // to nothing and the whole path would be worthless.
    assert.deepEqual(raw.tools[0]!.inputSchema, { $schema: 'http://json-schema.org/draft-07/schema#' });
  });

  it('still fails the load — a capture is bytes kept, not a measurement made', async () => {
    await assert.rejects(
      loadManifest(target, { env: { FAKE_MCP_DEGRADED: '1' }, timeoutMs: 20_000 }),
      ManifestValidationError,
    );
  });

  it('captured bytes analyse to the finding the live load could not report', async () => {
    const error = (await loadManifest(target, {
      env: { FAKE_MCP_DEGRADED: '1' },
      timeoutMs: 20_000,
    }).catch((e: unknown) => e)) as ManifestValidationError;

    const { tools } = error.raw as { tools: Array<{ inputSchema: JsonSchema }> };
    const findings = emptyInputSchema.run(surfaceOf(tools.map((t) => t.inputSchema)));
    assert.equal(findings.length, 2);
  });
});
