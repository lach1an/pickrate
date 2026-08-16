#!/bin/sh
# Clean-room reproduction of the two drift findings.
#
# Empty package cache, different OS image, resolver that has never seen this
# project. If both failures appear here too, they are not an artefact of one
# machine's cache — which is the only thing standing between the findings and
# being publishable.
set -u

echo "=== environment ==="
node --version
npm --version
cat /etc/os-release 2>/dev/null | grep PRETTY_NAME

echo
echo "=== FINDING 1 (npm, silent): server-filesystem@2025.8.21 ==="
cd /tmp && npm init -y >/dev/null 2>&1
npm install --silent @modelcontextprotocol/server-filesystem@2025.8.21 >/dev/null 2>&1
echo "resolved zod: $(node -e 'console.log(require("zod/package.json").version)' 2>/dev/null || echo '?')"
mkdir -p /tmp/sandbox
# Ask the server for its tool list and print each tool's declared input schema.
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 60 node node_modules/@modelcontextprotocol/server-filesystem/dist/index.js /tmp/sandbox 2>/dev/null \
  | node -e '
    let buf="";process.stdin.on("data",d=>buf+=d).on("end",()=>{
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 2 || !m.result) continue;
        const tools = m.result.tools;
        const empty = tools.filter(t => t.inputSchema?.type !== "object" && t.inputSchema?.properties === undefined);
        console.log(`tools=${tools.length}  emptySchema=${empty.length}`);
        console.log("sample:", tools[0].name, "->", JSON.stringify(tools[0].inputSchema).slice(0,120));
        console.log(empty.length > 0 ? "REPRODUCED: schemas are hollow" : "NOT reproduced: schemas intact");
      }
    });'

echo
echo "=== FINDING 2 (PyPI, loud): mcp-server-time@2026.7.10 ==="
if command -v uvx >/dev/null 2>&1; then
  out=$(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' \
        | timeout 300 uvx mcp-server-time@2026.7.10 2>&1 | head -20)
  echo "$out" | grep -qE "ImportError|Traceback" \
    && echo "REPRODUCED: server does not start -- $(echo "$out" | grep -m1 ImportError | cut -c1-90)" \
    || echo "NOT reproduced: server started"

  echo "--- and with period-correct resolution (--exclude-newer 2026-07-11) ---"
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"0"}}}' \
    | timeout 300 uvx --exclude-newer 2026-07-11 mcp-server-time@2026.7.10 2>/dev/null | head -c 90
  echo
else
  echo "uvx absent in container -- skipped"
fi
