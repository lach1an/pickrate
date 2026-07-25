# pickrate

**Does an agent actually use your MCP server correctly?**

A tool manifest is a prompt. Names, descriptions and schemas are the entire interface a model reasons over — no type checking, no compiler, no linter. So MCP servers fail in ways ordinary APIs don't: the model picks the wrong tool, invents an argument format, or never calls your tool at all while your integration tests all pass.

`pickrate` measures that.

> Status: **M2 complete.** `inspect` (static analysis) and `run` (tool-selection eval) both work. The mutator is not built yet — see [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md).

## Quick start

```bash
npx pickrate inspect "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

**No API key. No model calls. No cost.** That's deliberate — `inspect` is static analysis, and the barrier to trying it should be `npx` and nothing else.

```
pickrate inspect  npx -y @modelcontextprotocol/server-filesystem /tmp
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

## `pickrate run` — does a model actually use it correctly?

`inspect` tells you the manifest is well-formed. `run` puts a model in the loop and measures whether it picks the right tool.

```bash
npx pickrate run examples/filesystem.yaml --dry-run   # price it, spend nothing
npx pickrate run examples/filesystem.yaml
```

This one needs model access — `ANTHROPIC_API_KEY`, or an `ant auth login` profile.

```
pickrate run  npx -y @modelcontextprotocol/server-filesystem /tmp
  model     claude-haiku-4-5
  trials    3 × 6 scenarios in 8.2s
  cost      ~<$0.01  (412 in / 1,088 out, 21,600 cached)

  ✓ read-file            100%  ████████████████  3/3
  ✗ list-with-sizes       33%  █████░░░░░░░░░░░  1/3  needs 80% · flaky
  ✓ no-tool-needed       100%  ████████████████  3/3  restraint

  confusion
    list-with-sizes  wanted list_directory_with_sizes → got list_directory ×2

  orphan tools
    · move_file
    Never selected by any scenario — context you pay for on every call.

  1 of 6 scenarios below threshold · 1 in the 20–80% flakiness band
```

**Every assertion is a pass rate over N trials, never a boolean.** Tool selection is non-deterministic; a binary assertion passes on Tuesday and fails on Wednesday and teaches you nothing. Three things are scored separately, because they're different bugs with different fixes: **selection** (right tool?), **arguments** (right values?), and **restraint** (correctly called *nothing*?).

### `run` options

```
--dry-run               print the cost estimate and exit without spending
--yes                   skip the cost confirmation
--model <id>            override defaults.model
--trials <n>            override defaults.trials
--replay <file>         replay recorded trials instead of calling a model
```

### Scenario file

```yaml
server:
  transport: stdio                  # or: http + url, or: file + manifest
  command: node ./build/index.js

defaults:
  trials: 20
  threshold: 0.95
  model: claude-haiku-4-5
  concurrency: 4

scenarios:
  - id: create-branch
    prompt: "make me a branch called feature-login"
    expect:
      tool: create_branch
      args: { name: feature-login }   # only declared keys are asserted

  - id: no-tool-needed
    prompt: "what's the capital of France?"
    expect: { tool: null }            # restraint check

  - id: ambiguous-delete
    prompt: "get rid of the staging branch"
    expect: { tool: delete_branch }
    threshold: 0.99                   # destructive — demand near-certainty
```

Per-scenario `threshold` matters: a higher bar for destructive operations than for convenience ones is a judgement call you should own.

### What `run` does and doesn't do

- **It never executes a tool.** One model turn per trial, `tools/call` is never issued — a `delete_branch` scenario must not delete anything on your server.
- **It never retries a result.** Transport errors are retried; a trial that picked the wrong tool is *data*, and retrying it would bias every pass rate upward.
- **It runs the first trial alone**, so the manifest lands in the prompt cache before the rest fan out. Without that, a large manifest is re-billed at full price on every trial.
- **The model under test is part of the result**, so the report names it prominently.

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

# The whole eval pipeline, offline: no server, no API key, no spend.
npm run dev -- run test/fixtures/pickrate.yaml \
  --replay test/fixtures/trials/git-server.json
```

Fixtures in `test/fixtures/` let every component be developed with no server running and no API spend — captured `tools/list` responses for the analyser, and recorded trials for the scorer. They're also the seed corpus for the M3 mutator.

## Layout

```
src/
  connector/   speaks MCP — the ONLY place that imports the MCP SDK
  analyser/    static rules + token counting (M1)
  config/      pickrate.yaml parsing and validation
  provider/    asks a model — the ONLY place that imports a model SDK
  runner/      N trials × M scenarios, bounded concurrency
  scorer/      pass rates, confusion matrix, orphans, flakiness
  report/      table and JSON output
  types.ts     the domain model everything else shares
```

Two seams, isolated hard on purpose. The **connector** because the MCP spec finalises `2026-07-28` (stateless, no handshake, new routing headers) and the SDKs will churn for a couple of quarters. The **provider** because the model is a swappable part of the measurement, and because everything downstream of it must stay testable with no API key.

## Licence

MIT.
