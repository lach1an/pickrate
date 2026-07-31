/**
 * A hand-written MCP server over stdio, for the adapter's protocol tests.
 *
 * Hand-written rather than built on `@modelcontextprotocol/server` on purpose:
 * these tests are about the bytes on the wire — which revision is offered, what
 * cache hints ride on a `tools/list`, and whether a second listing is answered
 * from the network at all. Driving both ends with the same SDK would let a
 * shared assumption pass for agreement.
 *
 * It is a real subprocess reached through the real stdio transport, so the
 * `mode: 'auto'` probe runs against it exactly as it would against a server in
 * the wild — including the sibling process the SDK spawns to carry the probe.
 *
 * Configured entirely through the environment, because the target string a test
 * passes to `loadManifest` is a command line and nothing else:
 *
 *   FAKE_MCP_VERSIONS   space-separated `server/discover` versions. Unset makes
 *                       this a legacy server: `server/discover` is answered
 *                       with METHOD_NOT_FOUND, as a 2025-era server would.
 *   FAKE_MCP_TTL_MS     `ttlMs` to stamp on every `tools/list` result. Modern
 *                       servers only, and defaulted rather than optional — see
 *                       below.
 *   FAKE_MCP_SCOPE      `cacheScope` to stamp on every `tools/list` result.
 *                       Same.
 *   FAKE_MCP_REORDER    when `1`, every listing after the first returns the
 *                       same tools in reverse order.
 */

const TOOLS = [
  { name: 'alpha', description: 'The first tool.', inputSchema: { type: 'object', properties: {} } },
  { name: 'beta', description: 'The second tool.', inputSchema: { type: 'object', properties: {} } },
];

const versions = process.env.FAKE_MCP_VERSIONS?.split(/\s+/).filter(Boolean) ?? [];
// Offering a revision is what makes the client negotiate the modern era, and
// the modern era is a different wire — so it changes what we must send back.
const modern = versions.length > 0;
const reorder = process.env.FAKE_MCP_REORDER === '1';

// On `2026-07-28` a cacheable result MUST carry both `ttlMs` and `cacheScope`
// (the SEP-2549 anchor makes them required, and the SDK rejects the whole
// response if either is missing or malformed) — so a modern server sends a
// valid, unremarkable pair unless a test is specifically varying them. A legacy
// server sends neither, because the keys did not exist in that revision.
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_SCOPE = 'private';

const env = (name, fallback) => (process.env[name] === undefined ? fallback : process.env[name]);
const ttlMs = modern ? Number(env('FAKE_MCP_TTL_MS', DEFAULT_TTL_MS)) : undefined;
const cacheScope = modern ? env('FAKE_MCP_SCOPE', DEFAULT_SCOPE) : undefined;

let listCalls = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(request) {
  const { id, method } = request;

  // A notification has no id and takes no response — `notifications/initialized`
  // is the only one the client sends us, and it wants silence.
  if (id === undefined) return;

  switch (method) {
    case 'server/discover':
      if (!modern) return fail(id, -32601, 'Method not found');
      return reply(id, { supportedVersions: versions, capabilities: { tools: {} } });

    case 'initialize':
      return reply(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
      });

    case 'tools/list': {
      listCalls += 1;
      const tools = reorder && listCalls > 1 ? [...TOOLS].reverse() : TOOLS;
      return reply(id, {
        tools,
        // `2026-07-28` requires the discriminator on every result and does not
        // apply the absent-means-complete bridge, which is reserved for
        // earlier-revision servers. A legacy server must therefore omit it.
        ...(modern ? { resultType: 'complete' } : {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(cacheScope !== undefined ? { cacheScope } : {}),
      });
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  // Newline-delimited JSON: the stdio framing MCP has used since the beginning.
  for (let cut = buffer.indexOf('\n'); cut !== -1; cut = buffer.indexOf('\n')) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // A malformed line is the harness's bug, not a case under test. Staying
      // up keeps the failure legible as a timeout on the assertion that cares.
    }
  }
});

process.stdin.on('end', () => process.exit(0));
