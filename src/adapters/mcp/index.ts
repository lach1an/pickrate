import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
 * Everything downstream consumes `Surface`, so the `2026-07-28` transition
 * (stateless, no handshake, `Mcp-Method`/`Mcp-Name` routing headers) should be
 * contained to this file plus a transport swap.
 *
 * NOTE: `@modelcontextprotocol/sdk@1.29.0` still negotiates `2025-11-25` and
 * still performs the initialize handshake. Revisit once a `2026-07-28` SDK
 * ships; the seam is here so that stays a one-file change.
 */
export async function loadManifest(
  target: string | Target,
  options: LoadOptions = {},
): Promise<Surface> {
  const t = typeof target === 'string' ? parseTarget(target, { adapter: 'mcp' }) : target;
  if (t.adapter !== 'mcp') throw new Error(`Not an MCP target: ${t.display}`);
  if (t.kind === 'file') return loadManifestFromFile(t.path);

  const timeoutMs = options.timeoutMs ?? 30_000;

  // The `2026-07-28` probe, ahead of the legacy handshake. It cannot go
  // through the SDK: `Client.connect` performs `initialize` first, which is
  // exactly the thing the new revision removed, and no shipped SDK version
  // knows the method (1.30.0 still declares 2025-11-25 as latest). So it is a
  // raw POST, HTTP only — under stdio the SDK owns the subprocess.
  //
  // Every failure path is silent by design: today *every* server declines
  // this, and a probe that warned would be a warning on every run.
  const discoveredVersions = t.kind === 'http' ? await discover(t.url, options, timeoutMs) : undefined;

  const transport = createTransport(t, options);
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect to ${t.display}`);

    // Cache metadata off the first page. Later pages may repeat it; the first
    // is what a client caching the catalogue would act on, and disagreement
    // between pages is a server bug this analyser does not yet model.
    let listCache: SurfaceSource['listCache'];

    const listAll = async (): Promise<ToolDef[]> => {
      const tools: ToolDef[] = [];
      let cursor: string | undefined;
      let first = true;
      do {
        const page = await withTimeout(
          client.listTools(cursor === undefined ? {} : { cursor }),
          timeoutMs,
          'tools/list',
        );
        // `ResultSchema` is a loose object, so SEP-2549's keys survive parsing
        // even though this SDK version has never heard of them.
        if (first) listCache = readListCache(page);
        first = false;
        for (const tool of page.tools) tools.push(normaliseTool(tool));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    };

    const tools = await listAll();

    // Second listing, for the ordering check only. One extra round trip against
    // a failure that is otherwise invisible until the invoice arrives is not a
    // close call — and it costs no model spend, so `inspect` still needs no key.
    // A re-list that throws leaves the answer *absent*, never `true`: "we did
    // not find out" and "it was stable" are different facts (see SurfaceSource).
    const listOrderStable = await listAll().then(
      (second) => sameOrder(tools, second),
      () => undefined,
    );

    const serverInfo = client.getServerVersion();
    const source: SurfaceSource = {
      kind: t.kind,
      adapter: 'mcp',
      target: t.display,
      fetchedAt: new Date().toISOString(),
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
      ...(protocolVersionOf(transport) ? { protocolVersion: protocolVersionOf(transport)! } : {}),
      ...(listOrderStable !== undefined ? { listOrderStable } : {}),
      ...(listCache ? { listCache } : {}),
      ...(discoveredVersions ? { discoveredVersions } : {}),
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

/** Versions advertised by `server/discover`, or `undefined` if it did not answer. */
async function discover(
  url: string,
  options: LoadOptions,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const response = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // SEP-2243: routing headers, so a gateway can dispatch without
          // reading the body. Sent on the probe because a gateway that needs
          // them to route is precisely the deployment this is aimed at.
          'Mcp-Method': 'server/discover',
          ...options.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
      }),
      timeoutMs,
      'server/discover',
    );
    if (!response.ok) return undefined;

    const body: unknown = await response.json();
    const versions = (body as { result?: { protocolVersions?: unknown } }).result?.protocolVersions;
    if (!Array.isArray(versions)) return undefined;

    const strings = versions.filter((v): v is string => typeof v === 'string');
    return strings.length > 0 ? strings : undefined;
  } catch {
    // A legacy server 404s, 405s, or returns a JSON-RPC error here. All of
    // those mean "speak the old protocol", which is what happens next anyway.
    return undefined;
  }
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
    // The SDK declares `sessionId: string` while assigning `undefined` to it,
    // which trips `exactOptionalPropertyTypes`. One cast, contained here, is
    // cheaper than relaxing the flag for the whole project.
    return new StreamableHTTPClientTransport(new URL(t.url), {
      ...(options.headers ? { requestInit: { headers: options.headers } } : {}),
    }) as unknown as Transport;
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

function protocolVersionOf(transport: Transport): string | undefined {
  const v = (transport as { protocolVersion?: unknown }).protocolVersion;
  return typeof v === 'string' ? v : undefined;
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
