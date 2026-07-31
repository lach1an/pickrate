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
        // Code-unit order, not localeCompare: ICU collation varies by host and would
        // make the cached prefix sort differently on CI than on a laptop.
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ),
};

// The one place that knows MCP exists — everything downstream consumes Surface.
export async function loadManifest(
  target: string | Target,
  options: LoadOptions = {},
): Promise<Surface> {
  const t = typeof target === 'string' ? parseTarget(target, { adapter: 'mcp' }) : target;
  if (t.adapter !== 'mcp') throw new Error(`Not an MCP target: ${t.display}`);
  if (t.kind === 'file') return loadManifestFromFile(t.path);

  const timeoutMs = options.timeoutMs ?? 30_000;

  const transport = createTransport(t, options);

  // `mode: 'auto'`: probes with server/discover, falls back to the legacy
  // initialize handshake for anything not positively recognised as modern.
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  });

  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect to ${t.display}`);

    let listCache: SurfaceSource['listCache'];

    const listTools = async (what: string): Promise<ToolDef[]> => {
      // One call walks every page: with no cursor, the v2 client aggregates the
      // whole catalogue and preserves page-1 metadata on the result.
      //
      // `cacheMode: 'bypass'` is load-bearing: the client otherwise serves the
      // ordering re-list from its own cache, reporting a stability nobody measured.
      const options = { cacheMode: 'bypass' } as const;
      const result = await withTimeout(client.listTools({}, options), timeoutMs, what);

      // ResultSchema is a loose object, so SEP-2549's keys survive parsing unnamed.
      listCache = readListCache(result);
      return result.tools.map(normaliseTool);
    };

    const tools = await listTools('tools/list');

    // Second listing, for the ordering check only. A re-list that throws leaves
    // the answer absent, never true — "didn't find out" and "was stable" differ.
    const listOrderStable = await listTools('tools/list (ordering check)').then(
      (second) => sameOrder(tools, second),
      () => undefined,
    );

    const serverInfo = client.getServerVersion();
    const protocolVersion = client.getNegotiatedProtocolVersion();
    // Absent on a legacy connection — different from a server offering no versions.
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

  // Keeps whatever the server sent alongside its tools, so cache lints run from a fixture.
  const result = Array.isArray(parsed)
    ? {}
    : ((parsed as { result?: Record<string, unknown> }).result ?? (parsed as Record<string, unknown>));
  const listCache = readListCache(result);

  // Recorded revision, if any — without it, protocol-gated rules can't run offline.
  const declared = (parsed as { protocolVersion?: unknown }).protocolVersion ?? result['protocolVersion'];
  const protocolVersion = typeof declared === 'string' ? declared : undefined;

  // A flag, never a credential — safe for a capture to carry into a repo.
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
