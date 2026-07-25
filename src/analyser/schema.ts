import type { JsonSchema } from '../types.js';

export interface SchemaProperty {
  /** Dot path from the tool's input schema root, e.g. `filter.branch`. */
  path: string;
  name: string;
  schema: JsonSchema;
  /** 1 for a top-level property. */
  depth: number;
  required: boolean;
}

const MAX_WALK_DEPTH = 12;

/**
 * Walk a tool input schema, yielding every named property.
 *
 * Handles `properties`, `items`, and the `allOf`/`anyOf`/`oneOf` combinators.
 * `$ref` is not resolved — it is rare in generated MCP manifests and resolving
 * it properly means implementing JSON Schema 2020-12 reference resolution,
 * which is not M1's job.
 */
export function* walkProperties(schema: JsonSchema, depth = 1, prefix = ''): Generator<SchemaProperty> {
  if (depth > MAX_WALK_DEPTH) return;

  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );

  const properties = asObject(schema.properties);
  if (properties) {
    for (const [name, value] of Object.entries(properties)) {
      const child = asObject(value);
      if (!child) continue;
      const path = prefix === '' ? name : `${prefix}.${name}`;
      yield { path, name, schema: child, depth, required: required.has(name) };
      yield* walkProperties(child, depth + 1, path);
    }
  }

  const items = asObject(schema.items);
  if (items) yield* walkProperties(items, depth + 1, prefix === '' ? '[]' : `${prefix}[]`);

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const child = asObject(branch);
      if (child) yield* walkProperties(child, depth, prefix);
    }
  }
}

/** Deepest nesting level reachable in the schema. 0 for a flat/empty schema. */
export function maxDepth(schema: JsonSchema): number {
  let deepest = 0;
  for (const prop of walkProperties(schema)) {
    if (prop.depth > deepest) deepest = prop.depth;
  }
  return deepest;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
