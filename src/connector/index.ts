import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JsonSchema, Manifest, ManifestSource, ToolDef } from '../types.js';
import { parseTarget, type Target } from './target.js';

export { parseTarget, splitCommand, type Target } from './target.js';

const CLIENT_INFO = { name: 'pickrate', version: '0.0.0' } as const;

export interface ConnectOptions {
  /** Extra headers for HTTP targets (auth, etc). */
  headers?: Record<string, string>;
  /** Extra env for stdio targets, merged over the inherited defaults. */
  env?: Record<string, string>;
  /** Overall budget for connect + list, in ms. */
  timeoutMs?: number;
}

/**
 * The one place that knows MCP exists.
 *
 * Everything downstream consumes `Manifest`, so the `2026-07-28` transition
 * (stateless, no handshake, `Mcp-Method`/`Mcp-Name` routing headers) should be
 * contained to this file plus a transport swap.
 *
 * NOTE: `@modelcontextprotocol/sdk@1.29.0` still negotiates `2025-11-25` and
 * still performs the initialize handshake. Revisit once a `2026-07-28` SDK
 * ships; the seam is here so that stays a one-file change.
 */
export async function loadManifest(
  target: string | Target,
  options: ConnectOptions = {},
): Promise<Manifest> {
  const t = typeof target === 'string' ? parseTarget(target) : target;
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
    const source: ManifestSource = {
      kind: t.kind,
      target: t.display,
      fetchedAt: new Date().toISOString(),
      ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version } } : {}),
      ...(protocolVersionOf(transport) ? { protocolVersion: protocolVersionOf(transport)! } : {}),
    };

    return { tools, source };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Read a captured `tools/list` response. Lets the analyser run with no server. */
export async function loadManifestFromFile(path: string): Promise<Manifest> {
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
    tools: tools.map((tool) => normaliseTool(tool as Record<string, unknown>)),
    source: { kind: 'file', target: path, fetchedAt: new Date().toISOString() },
  };
}

function createTransport(t: Exclude<Target, { kind: 'file' }>, options: ConnectOptions): Transport {
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
