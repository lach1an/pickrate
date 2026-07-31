import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolsOf } from '../../surface.js';
import type { JsonSchema, Surface, SurfaceSource, ToolDef } from '../../types.js';
import { identityPresentation, type Adapter, type LoadOptions, type Presentation } from '../contract.js';
import { parseTarget, type Target } from '../target.js';

const CLIENT_INFO = { name: 'pickrate', version: '0.0.0' } as const;

/**
 * MCP: the adapter where selecting and calling are the same act.
 *
 * A tool the model picks is a tool it names, so `present` hands the tools
 * straight through and `project` is the identity. The seam earns its keep on
 * the skills side, where those two come apart.
 *
 * Declarations are sorted by name, which is a measurement decision and not a
 * tidy-up: tools render *before* the cache breakpoint, so a server that
 * reorders between the warm-up and the fan-out invalidates the prefix on every
 * trial — the same ~10× bill an unstable `systemSuffix` buys, with no error and
 * no warning. `2026-07-28` requires deterministic ordering (SEP-2549); the
 * servers measured today overwhelmingly predate it and promise nothing. Sorting
 * here makes the presentation byte-stable whatever the server does.
 *
 * Order is fixed rather than preserved because it is part of what is measured:
 * every run then sees one order, so two runs are comparable. `Surface.items`
 * stays in the order the server sent, so the analyser can still report on it.
 */
export const mcpAdapter: Adapter = {
  id: 'mcp',
  load: (target, options) => loadManifest(target, options),
  present: (surface): Presentation =>
    identityPresentation(
      toolsOf(surface)
        .map((tool) => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        }))
        // Code-unit order, not `localeCompare`: collation varies with the
        // host's ICU data and locale, and a prefix that sorts differently on
        // CI than on a laptop is exactly the instability this is fixing.
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
};

/**
 * The one place that knows MCP exists.
 *
 * Everything downstream consumes `Surface`, and the `2026-07-28` transition
 * (stateless, no handshake, `Mcp-Method`/`Mcp-Name` routing headers) landed
 * here and nowhere else — which is what the seam was for.
 *
 * The SDK shipped that revision as a *new package line* rather than a new
 * version of the old one: `@modelcontextprotocol/client@2` speaks it, while
 * `@modelcontextprotocol/sdk@1.30.0` remains on `2025-11-25` and always will.
 * Watching the old name for a version bump would have waited forever.
 */
export async function loadManifest(
  target: string | Target,
  options: LoadOptions = {},
): Promise<Surface> {
  const t = typeof target === 'string' ? parseTarget(target, { adapter: 'mcp' }) : target;
  if (t.adapter !== 'mcp') throw new Error(`Not an MCP target: ${t.display}`);
  if (t.kind === 'file') return loadManifestFromFile(t.path);

  const timeoutMs = options.timeoutMs ?? 30_000;

  const transport = createTransport(t, options);

  // `mode: 'auto'` is the dual-protocol posture: `connect` probes with
  // `server/discover` and falls back to the legacy `initialize` handshake for
  // anything it does not positively recognise as modern. It replaces a
  // hand-rolled probe that could only reach HTTP — under stdio the SDK owns the
  // subprocess — and that read `protocolVersions` where the spec says
  // `supportedVersions`, so it never once reported a version. The SDK also
  // knows things that probe did not: the timeout verdict is transport-aware
  // (silence on a local pipe is a legacy server; silence on a deployed server
  // is an outage) and the spec's `-32022` corrective continuation is handled.
  //
  // The cost is one extra round trip on HTTP, or one extra short-lived server
  // spawn on stdio, per load. No model spend either way, so `inspect` still
  // needs no key.
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  });

  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect to ${t.display}`);

    let listCache: SurfaceSource['listCache'];

    const listTools = async (what: string): Promise<ToolDef[]> => {
      // One call walks every page: with no cursor, the v2 client aggregates the
      // whole catalogue and preserves page-1 metadata on the result. That first
      // page is what a client caching the catalogue would act on, and
      // disagreement between pages is a server bug this analyser does not model.
      //
      // `cacheMode: 'bypass'` is load-bearing, not defensive. The v2 client
      // caches the list verbs and *defaults* to serving a fresh entry with no
      // round trip — which would answer the ordering re-list below from memory,
      // compare it equal to the first, and report a stability nobody measured.
      // It only misfires against servers sending `ttlMs`: `2026-07-28` servers,
      // the only ones SEP-2549's ordering guarantee binds, and exactly the ones
      // this is meant to police. A test fails if this option is removed.
      const options = { cacheMode: 'bypass' } as const;
      const result = await withTimeout(client.listTools({}, options), timeoutMs, what);

      // `ResultSchema` is a loose object, so SEP-2549's keys survive parsing
      // whether or not the schema names them.
      listCache = readListCache(result);
      return result.tools.map(normaliseTool);
    };

    const tools = await listTools('tools/list');

    // Second listing, for the ordering check only. One extra round trip against
    // a failure that is otherwise invisible until the invoice arrives is not a
    // close call — and it costs no model spend, so `inspect` still needs no key.
    // A re-list that throws leaves the answer *absent*, never `true`: "we did
    // not find out" and "it was stable" are different facts (see SurfaceSource).
    const listOrderStable = await listTools('tools/list (ordering check)').then(
      (second) => sameOrder(tools, second),
      () => undefined,
    );

    const serverInfo = client.getServerVersion();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    // Absent when the connection went legacy — the probe found nothing to
    // report, which is not the same as a server that offered no versions.
    const discoveredVersions = client.getDiscoverResult()?.supportedVersions;

    const source: SurfaceSource = {
      kind: t.kind,
      adapter: 'mcp',
      target: t.display,
      fetchedAt: new Date().toISOString(),
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(listOrderStable !== undefined ? { listOrderStable } : {}),
      ...(listCache ? { listCache } : {}),
      ...(discoveredVersions?.length ? { discoveredVersions: [...discoveredVersions] } : {}),
      ...(options.headers && hasCredential(options.headers) ? { credentialed: true } : {}),
    };

    return { kind: 'mcp', items: tools, source };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Did two listings agree on order?
 *
 * Names only, and positionally. `undefined` when the two calls returned
 * *different catalogues* — a tool appeared, vanished or was swapped — because
 * that is a changed surface rather than a reordered one, and reporting it as an
 * ordering defect sends someone to fix the wrong thing. Absent stays absent.
 *
 * Exported so the comparison is testable without a server.
 */
export function sameOrder(first: ToolDef[], second: ToolDef[]): boolean | undefined {
  const names = (tools: ToolDef[]) => tools.map((tool) => tool.name);
  const [a, b] = [names(first), names(second)];
  if (a.length !== b.length) return undefined;

  const sorted = (list: string[]) => [...list].sort();
  const [sa, sb] = [sorted(a), sorted(b)];
  if (!sa.every((name, i) => name === sb[i])) return undefined;

  return a.every((name, i) => name === b[i]);
}

/**
 * SEP-2549's cache hints off a `tools/list` result.
 *
 * Both keys are optional and read defensively: this runs against whatever a
 * server actually sent, and the point of the rules downstream is that servers
 * get this wrong. A value of the wrong type is treated as absent — "declared
 * something unusable" and "declared nothing" are the same finding here.
 *
 * Exported for the offline fixture path and its tests.
 */
export function readListCache(result: Record<string, unknown>): SurfaceSource['listCache'] {
  const ttlMs = typeof result['ttlMs'] === 'number' ? result['ttlMs'] : undefined;
  const cacheScope = typeof result['cacheScope'] === 'string' ? result['cacheScope'] : undefined;
  if (ttlMs === undefined && cacheScope === undefined) return undefined;
  return { ...(ttlMs !== undefined ? { ttlMs } : {}), ...(cacheScope !== undefined ? { cacheScope } : {}) };
}

/**
 * Did this request carry credentials?
 *
 * Header *names* only — the values never leave this function, because no
 * report field carries a credential (invariant 10). It exists so a `public`
 * cache scope on a per-tenant catalogue is separable from one on a catalogue
 * every caller sees identically.
 */
function hasCredential(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => /^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(name));
}

/** Read a captured `tools/list` response. Lets the analyser run with no server. */
export async function loadManifestFromFile(path: string): Promise<Surface> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const tools = Array.isArray(parsed)
    ? parsed
    : (parsed as { tools?: unknown }).tools ?? (parsed as { result?: { tools?: unknown } }).result?.tools;

  if (!Array.isArray(tools)) {
    throw new Error(
      `${path}: expected a tools array, or an object with a "tools" (or "result.tools") key.`,
    );
  }

  // A capture keeps whatever the server sent alongside its tools, so the
  // cache lints are exercisable from a fixture with no server — the same
  // contract every other rule already has.
  const result = Array.isArray(parsed)
    ? {}
    : ((parsed as { result?: Record<string, unknown> }).result ?? (parsed as Record<string, unknown>));
  const listCache = readListCache(result);

  // A capture may also record which revision produced it. Without that the
  // protocol-gated rules cannot run offline at all, and there would be no way
  // to exercise them without a live server on a spec that has no SDK yet.
  const declared = (parsed as { protocolVersion?: unknown }).protocolVersion ?? result['protocolVersion'];
  const protocolVersion = typeof declared === 'string' ? declared : undefined;

  // Likewise whether the capture was taken against a credentialed endpoint —
  // a flag, never a credential, so a capture can carry it into a repo safely.
  const credentialed = (parsed as { credentialed?: unknown }).credentialed === true;

  return {
    kind: 'mcp',
    items: tools.map((tool) => normaliseTool(tool as Record<string, unknown>)),
    source: {
      kind: 'file',
      adapter: 'mcp',
      target: path,
      fetchedAt: new Date().toISOString(),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(listCache ? { listCache } : {}),
      ...(credentialed ? { credentialed } : {}),
    },
  };
}

function createTransport(
  t: Extract<Target, { adapter: 'mcp'; kind: 'http' | 'stdio' }>,
  options: LoadOptions,
): Transport {
  if (t.kind === 'http') {
    return new StreamableHTTPClientTransport(new URL(t.url), {
      ...(options.headers ? { requestInit: { headers: options.headers } } : {}),
    });
  }
  return new StdioClientTransport({
    command: t.command,
    args: t.args,
    ...(options.env ? { env: { ...process.env as Record<string, string>, ...options.env } } : {}),
    stderr: 'pipe',
  });
}

/** Map an SDK tool onto our model, keeping the untouched original in `raw`. */
function normaliseTool(tool: Record<string, unknown>): ToolDef {
  const name = typeof tool.name === 'string' ? tool.name : '<unnamed>';
  const description = typeof tool.description === 'string' ? tool.description : undefined;
  const title = typeof tool.title === 'string' ? tool.title : undefined;
  const inputSchema = isObject(tool.inputSchema) ? (tool.inputSchema as JsonSchema) : {};
  const outputSchema = isObject(tool.outputSchema) ? (tool.outputSchema as JsonSchema) : undefined;

  return {
    kind: 'tool',
    name,
    inputSchema,
    raw: tool,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
