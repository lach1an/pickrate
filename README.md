# pickrate

**Does an agent actually use your MCP server — or your skills — correctly?**

A tool manifest is a prompt. Names, descriptions and schemas are the entire interface a model reasons over — no type checking, no compiler, no linter. So MCP servers fail in ways ordinary APIs don't: the model picks the wrong tool, invents an argument format, or never calls your tool at all while your integration tests all pass.

`pickrate` measures that.

The same question applies to Agent Skills, for the same reason: a skill is selected from a one-line description too. Both surfaces go through the same measurement.

> Status: **M2 complete**, adapter split complete. `inspect` (static analysis) and `run` (selection eval) both work, on MCP servers and on skills directories. The mutator is not built yet — see [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md) and [`plans/skills-adapter-plan.md`](plans/skills-adapter-plan.md).

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

Point it at a skills directory and it measures the same things, with the token figure split by when you pay it:

```
pickrate inspect  ./.claude/skills
  skills    8
  context   ~314 tokens per session (o200k_base, approximate)
  bodies    ~242 tokens, paid only when a skill triggers

  skill-description-length
    ✗ "verbose" has a 1185-character description, over the 1024 limit by 161.

  near-duplicate-description
    ! "find-files" and "search-files" describe themselves 89% alike.

  4 errors · 3 warnings · 2 info
```

## Targets

| Target | Read as |
|---|---|
| `"node ./build/index.js"` | MCP over a stdio subprocess — quote the whole command |
| `https://api.example.com/mcp` | MCP over streamable HTTP |
| `./manifest.json` | a captured `tools/list` response — analyse with no server running |
| `./.claude/skills` | a directory of `SKILL.md` files |

Directories are ambiguous — an MCP server project is a directory too — so a directory target is probed for a `SKILL.md`, in itself, one level down, or under a conventional `.claude/skills`. `--adapter mcp\|skills` settles it by hand.

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

`inspect` tells you the surface is well-formed. `run` puts a model in the loop and measures whether it picks the right thing out of it.

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
--presentation <mode>   skills only: skill-tool (default) or pseudo-tool
```

### Presenting skills

How a skill surface reaches the model decides what the score means, so `run` prints the mode it used and the JSON report carries it.

| Mode | Surface | Use |
|---|---|---|
| `skill-tool` | one `Skill` dispatch tool, plus a routing listing in the system prompt | the default — this is the mechanism an agent actually uses |
| `pseudo-tool` | one synthetic tool per skill, each with its own description slot | a control: a *more* favourable surface than reality |

Run a skill set both ways and the difference tells you how much of your trigger rate is the dispatch mechanism versus the descriptions themselves. The two numbers are not comparable as scores — only the gap between them is meaningful — which is why the mode is reported next to them and why replaying trials under a mode they weren't recorded under is an error rather than a zero.

### Scenario file

```yaml
target:
  type: stdio                       # or: http + url, file + manifest, skills + path
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
    expect: { select: null }          # restraint check

  - id: ambiguous-delete
    prompt: "get rid of the staging branch"
    expect: { select: delete_branch }
    threshold: 0.99                   # destructive — demand near-certainty
```

`expect.select` and `expect.tool` are the same field — `select` reads better once a skill can be the thing selected, and `tool` stays accepted. `null` under either is the restraint check.

Per-scenario `threshold` matters: a higher bar for destructive operations than for convenience ones is a judgement call you should own.

A skills config differs only in its target and, if you want the control arm, its presentation:

```yaml
target:
  type: skills
  path: ./.claude/skills

defaults:
  presentation: skill-tool
```

Scenario semantics are otherwise identical — around 20 prompts, half that should trigger something and half that shouldn't, with the near-misses being the ones worth writing.

### What `run` does and doesn't do

- **It never executes anything.** One model turn per trial, `tools/call` is never issued and no skill body is ever loaded — a `delete_branch` scenario must not delete anything on your server.
- **It never retries a result.** Transport errors are retried; a trial that picked the wrong thing is *data*, and retrying it would bias every pass rate upward.
- **It runs the first trial alone**, so the surface lands in the prompt cache before the rest fan out. Without that, a large surface is re-billed at full price on every trial.
- **The model under test is part of the result**, so the report names it prominently.

## Rules

| Rule | Surface | Default | What it catches |
|---|---|---|---|
| `token-budget` | both | warn/error | The whole surface is injected into context on every call |
| `near-duplicate-description` | both | warn | The classic wrong-thing-selected failure |
| `missing-tool-description` | mcp | error | The model has only the name to go on |
| `thin-tool-description` | mcp | warn | Under four words disambiguates nothing |
| `missing-param-description` | mcp | warn | Where the model invents formats |
| `enum-candidate` | mcp | info | Free-text param whose description lists its valid values |
| `deep-schema` | mcp | info | Nesting the model will fill in wrong |
| `unparseable-skill` | skills | error | Frontmatter that will not parse — the skill can never be selected |
| `missing-skill-description` | skills | error | Resident in every request, selectable in none |
| `skill-description-length` | skills | error | Past the hard 1024-character limit, the loader rejects the skill outright |
| `thin-skill-description` | skills | warn | Under four words disambiguates nothing |
| `skill-description-no-triggers` | skills | info | Says what the skill *is*, never when to use it |

Rules are pure functions — surface in, findings out. No network, no model. Keep it that way. Each declares the surfaces it applies to, and one that has nothing to say about a surface is skipped rather than run against an empty list: silence and "no findings" must not read the same.

For skills, the headline token figure is **routing cost only** — the name and description resident in every request. Bodies are reported on their own line, because they cost nothing until the skill triggers, and conflating the two hides the thing progressive disclosure exists to give you.

## Development

```bash
npm run dev -- inspect ./test/fixtures/messy-server.json   # run from source
npm run dev -- inspect ./test/fixtures/skills/messy        # the skills equivalent
npm test                                                   # node:test, offline
npm run typecheck
npm run build

# The whole eval pipeline, offline: no server, no API key, no spend.
npm run dev -- run test/fixtures/pickrate.yaml \
  --replay test/fixtures/trials/git-server.json

npm run dev -- run test/fixtures/skills-eval.yaml \
  --replay test/fixtures/trials/skills.json
```

Fixtures in `test/fixtures/` let every component be developed with no server running and no API spend — captured `tools/list` responses and `SKILL.md` trees for the analyser, recorded trials for the scorer. Each surface has a clean fixture (a test asserts it produces zero findings) and a messy one that trips every rule. They're also the seed corpus for the M3 mutator.

## Layout

```
src/
  adapters/    target → surface → presentation
    mcp/       speaks MCP — the ONLY place that imports the MCP SDK
    skills/    reads SKILL.md — node:fs and yaml, nothing else
  analyser/    static rules + token counting (M1)
  config/      pickrate.yaml parsing and validation
  provider/    asks a model — the ONLY place that imports a model SDK
  runner/      N trials × M scenarios, bounded concurrency
  scorer/      pass rates, confusion matrix, orphans, flakiness
  report/      table and JSON output
  types.ts     the domain model everything else shares
```

Two seams, isolated hard on purpose. The **adapters** because the MCP spec finalises `2026-07-28` (stateless, no handshake, new routing headers) and the SDKs will churn for a couple of quarters. The **provider** because the model is a swappable part of the measurement, and because everything downstream of it must stay testable with no API key.

## Licence

MIT.
