# mcpeval

**Does an agent actually use your MCP server correctly?**

A tool manifest is a prompt. Names, descriptions and schemas are the entire interface a model reasons over — no type checking, no compiler, no linter. So MCP servers fail in ways ordinary APIs don't: the model picks the wrong tool, invents an argument format, or never calls your tool at all while your integration tests all pass.

`mcpeval` measures that.

> Status: **M1 in progress.** `inspect` (static analysis) works. The runner, scorer and mutator are not built yet — see [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md).

## Quick start

```bash
npx mcpeval inspect "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

**No API key. No model calls. No cost.** That's deliberate — `inspect` is static analysis, and the barrier to trying it should be `npx` and nothing else.

```
mcpeval inspect  npx -y @modelcontextprotocol/server-filesystem /tmp
  server    secure-filesystem-server 0.2.0
  tools     14
  context   ~1,731 tokens per session (o200k_base, approximate)

  missing-param-description
    ! create_directory.path has no description and is required.
    ! edit_file.edits has no description and is required.
    ...

  near-duplicate-description
    ! "list_directory" and "list_directory_with_sizes" describe themselves
      67% alike — the model may confuse them.

  tool                        tokens   share
  read_text_file                 191   11.0%  ██
  edit_file                      167    9.6%  ██
  ...

  17 warnings · 2 info
```

## Targets

| Target | Transport |
|---|---|
| `"node ./build/index.js"` | stdio subprocess — quote the whole command |
| `https://api.example.com/mcp` | streamable HTTP |
| `./manifest.json` | a captured `tools/list` response — analyse with no server running |

## Options

```
--json                  machine-readable output (stable shape, see src/report/json.ts)
--fail-on <severity>    exit 1 on findings at or above this level
                        (error | warn | info | none, default: none)
--disable <ids>         comma-separated rule ids to skip
--header <k=v>          extra HTTP header, repeatable
--env <k=v>             extra env var for stdio servers, repeatable
--timeout <ms>          connection budget (default: 30000)
```

## Rules

| Rule | Default | What it catches |
|---|---|---|
| `manifest-token-budget` | warn/error | The whole manifest is injected into context on every call |
| `missing-tool-description` | error | The model has only the name to go on |
| `thin-tool-description` | warn | Under four words disambiguates nothing |
| `near-duplicate-description` | warn | The classic wrong-tool-selected failure |
| `missing-param-description` | warn | Where the model invents formats |
| `enum-candidate` | info | Free-text param whose description lists its valid values |
| `deep-schema` | info | Nesting the model will fill in wrong |

Rules are pure functions — manifest in, findings out. No network, no model. Keep it that way.

## Development

```bash
npm run dev -- inspect ./test/fixtures/messy-server.json   # run from source
npm test                                                   # node:test, offline
npm run typecheck
npm run build
```

Fixtures in `test/fixtures/` let every component be developed with no server running and no API spend. They're also the seed corpus for the M3 mutator.

## Layout

```
src/
  connector/   speaks MCP — the ONLY place that imports the SDK
  analyser/    static rules + token counting (M1)
  report/      table and JSON output
  types.ts     the domain model everything else shares
```

The connector is isolated hard on purpose: the MCP spec finalises `2026-07-28` (stateless, no handshake, new routing headers) and the SDKs will churn for a couple of quarters. That churn should stay in one directory.

## Licence

MIT.
