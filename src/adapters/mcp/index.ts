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
 */
export const mcpAdapter: Adapter = {
  id: 'mcp',
  load: (target, options) => loadManifest(target, options),
  present: (surface): Presentation =>
    identityPresentation(
      toolsOf(surface).map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      })),
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

  const transport = createTransport(t, options);
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  const timeoutMs = options.timeoutMs ?? 30_000;
  try {
    await withTimeout(client.connect(transport), timeoutMs, `connect to ${t.display}`);

    const tools: ToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(
        client.listTools(cursor === undefined ? {} : { cursor }),
        timeoutMs,
        'tools/list',
      );
      for (const tool of page.tools) tools.push(normaliseTool(tool));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const serverInfo = client.getServerVersion();
    const source: SurfaceSource = {
      kind: t.kind,
      adapter: 'mcp',
      target: t.display,
      fetchedAt: new Date().toISOString(),
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
      ...(protocolVersionOf(transport) ? { protocolVersion: protocolVersionOf(transport)! } : {}),
    };

    return { kind: 'mcp', items: tools, source };
  } finally {
    await client.close().catch(() => {});
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

  return {
    kind: 'mcp',
    items: tools.map((tool) => normaliseTool(tool as Record<string, unknown>)),
    source: { kind: 'file', adapter: 'mcp', target: path, fetchedAt: new Date().toISOString() },
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
