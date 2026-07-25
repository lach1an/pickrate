# pickrate

**Does an agent actually use your MCP server — or your skills — correctly?**

A tool manifest is a prompt. Names, descriptions and schemas are the entire interface a model reasons over — no type checking, no compiler, no linter. So MCP servers fail in ways ordinary APIs don't: the model picks the wrong tool, invents an argument format, or never calls your tool at all while your integration tests all pass.

`pickrate` measures that.

The same question applies to Agent Skills, for the same reason: a skill is selected from a one-line description too. Both surfaces go through the same measurement.

> Status: **M1–M4 complete**, on npm. `inspect` (static analysis), `run` (selection eval) and `mutate` (how much to trust the eval) all work on MCP servers and skills directories alike, and all three are wired for CI — an exit-code contract, gates in the config file, and baseline comparison. See [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md) for the reasoning behind all of it. **M5 (the leaderboard) is next.**

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
--format <mode>         table (default), json or markdown
--json                  alias for --format json (stable shape, see src/report/json.ts)
--out <file>            write the JSON report here, whatever --format prints
--config <file>         inspect: read target: and the ci: gates from a config file
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
--target <t>            override the config's target
--replay <file>         replay recorded trials instead of calling a model
--presentation <mode>   skills only: skill-tool (default) or pseudo-tool
--baseline <file>       compare against a stored JSON report
--max-regression <0..1> worst per-scenario drop allowed, against --baseline
--max-flaky <n>         scenarios allowed in the 20–80% band
--max-orphans <n>       items allowed that no scenario ever selected
--max-error-rate <0..1> errored trials before the run counts as unmeasured
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

## `pickrate mutate` — how much should you trust the report?

Every other tool in this space tells you how good your surface is. This one tells you how much to believe that.

The problem it solves is circularity: whoever writes the scenarios reads the same descriptions the model does, inherits the same ambiguities, and can write a test that passes having measured nothing. So `mutate` breaks the surface *in a way you chose*, re-runs the eval, and checks the score moved. Ground truth is constructed rather than judged.

```bash
pickrate mutate pickrate.yaml --mutants 3
```

```
pickrate mutate  ./git-server.json
  model     claude-haiku-4-5
  baseline  91%  from 2 clean runs of 20 trials · noise floor 6%

  ✓ blank-description:create_branch  −34%  detected
                                     "create_branch" loses its description
  · swap-descriptions:a+b             −1%  survived
                                     "a" and "b" trade descriptions

  survivors
    · swap-descriptions:a+b — damaged a, b
    A survivor is inconclusive, not a pass. Either no scenario exercises
    the damaged tools, or the harness cannot see the damage. Check coverage first.

  mutation score  50%  1 of 2 injected defects detected
```

### Operators

| Operator | What a kill proves |
|---|---|
| `blank-description` | Descriptions carry real signal — the bluntest check there is |
| `swap-descriptions` | Selection reads descriptions *instead of* guessing from names |
| `inject-decoys` | Context bloat degrades selection, so token cost is behavioural and not just a bill |

All three apply to MCP and skills alike, which is what the adapter split bought.

### The noise floor

A mutation score built on a single clean run is a count of coin flips. So the clean surface is measured **twice**, and the gap between those two runs is the bar a mutant's drop has to clear — spec §6's variance baseline. Below that gap, nothing means anything.

The gap is floored at `1/trials`: one trial flipping is worth that much, and two runs that happen to land identically would otherwise set the bar at zero and "detect" every mutant, including the ones that changed nothing.

### Reading it

- **A killed mutant is good news.** It means the harness noticed damage you injected on purpose.
- **A survivor is inconclusive, never a pass.** Either no scenario goes near what was damaged, or the eval is blind to it. The report names each survivor's targets so you can tell which.
- **Mutation scores are per-adapter.** Blanking one description out of eight skills and one out of forty tools are not the same operation. Never average them.
- **`--replay` is refused here.** Recorded trials are keyed on scenario id and indifferent to the surface, so every mutant would replay identically and score 0% — a devastating-looking finding that is pure artefact.

Cost is `(2 + mutants) × trials × scenarios`, and each run is a different surface and so a different cached prefix. `--dry-run` prices it first.

## CI

Nobody buys "your server scores 87/100" — unfalsifiable, and they know it. They buy **"this PR dropped selection from 94% to 71%."** So the CI story is a regression detector, not a linter with a threshold.

```yaml
# .github/workflows/pickrate.yml
- uses: lach1an/pickrate@v0
  with:
    command: inspect              # free, no key — run this one on every PR
    config: pickrate.yaml
    comment: 'true'

- uses: lach1an/pickrate@v0
  with:
    command: run
    config: pickrate.yaml
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    baseline: pickrate-baseline.json
```

Copy [`examples/workflows/eval.yml`](examples/workflows/eval.yml) for the full three-tier version, and [`examples/workflows/baseline-refresh.yml`](examples/workflows/baseline-refresh.yml) alongside it.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | measured, gates passed |
| `1` | **measured, and the answer is bad** — threshold breach, `failOn`, a regression |
| `2` | **could not measure** — usage error, unreachable target, too many errored trials |
| `130` | cancelled at the cost confirmation |

The 1/2 split is the whole table. A dead server must never read as a failed eval, and a failed eval must never read as green — nobody debugs a manifest that was never the problem, and nobody reads the log of a green build.

### Gates live in the config

A threshold argued over in review belongs in the repo next to the scenarios it judges, not in a YAML string in `.github/workflows/`. Every gate is off by default except one:

```yaml
ci:
  failOn: warn        # inspect: findings at or above this severity
  maxTokens: 20000    # inspect: resident tokens (skill bodies never counted)
  maxFlaky: 0         # run: scenarios in the 20–80% band
  maxOrphans: 0       # run: items no scenario ever selected
  maxErrorRate: 0.1   # run: errored trials — the one that defaults on
  maxRegression: 0.05 # run --baseline: worst per-scenario drop
  minScore: 0.7       # mutate: mutation score floor
```

CLI flags override the file. An unknown key under `ci:` is an error, not a shrug: a misspelled `maxFlakey:` is a gate its author believes is guarding them, and the only moment its silence becomes visible is the one where it was needed.

**`maxErrorRate` defaults on, and breaches as *unmeasured* rather than failed.** Errored trials leave the denominator, so a run where 18 of 20 trials died on transport reports a confident 100% from the two that survived. Locally that's fine — a human sees the "18 errored" line. In CI nobody is looking.

There is deliberately **no gate on the mean score**. Per-scenario thresholds already gate, and a headline mean is precisely the number people optimise.

### Baseline comparison

```bash
pickrate run pickrate.yaml --out pickrate-baseline.json      # on your default branch, committed
pickrate run pickrate.yaml --baseline pickrate-baseline.json # on PRs
```

```
  vs baseline  pickrate-baseline.json · claude-haiku-4-5-20251001 · 2026-07-11
    create-branch             90% → 100%   +10%
    create-branch-colloquial  100% → 60%   −40%  regressed
    no-tool-needed            95% → 80%    −15%
    Drops under 25% are inside the noise and are not counted.
    One run per side cannot measure noise; mutate can, or raise trials.
```

Two rules keep it honest:

- **A diff between two single runs is not a noise measurement.** `mutate` measures its floor by running the clean surface twice; `--baseline` has one run per side and cannot. So the tolerance is floored at `1/trials` and the report says where an honest floor comes from. Without that, the build goes red on the noise as readily as on the regression.
- **A mismatched baseline is refused, not projected.** A different schema version, adapter, model, presentation or scenario set is an error and exit 2. A comparison across models is a number that looks like a regression and is a model swap.

It gates on the **worst per-scenario drop, never the mean** — a mean hides one scenario collapsing behind five that improved, and the collapsed one is the one headed for production.

**Pin a dated model id** in any config used for comparison. `claude-haiku-4-5` is an alias the provider can re-point underneath a stored baseline, which turns a model update into something indistinguishable from your regression; `--baseline` warns when it sees one.

### Why the baseline is a committed file

The same choice Stryker makes with `stryker-incremental.json`, for the same reason: **the measurement is expensive, so you cannot re-derive the base side on demand.** Recomputing both sides in one job — what `size-limit-action` does — works because bundle size is deterministic and free, and doubles the API bill here.

Committing it also suits a *stochastic* number better than an automatic store does. The baseline moving becomes a reviewed diff, and a human seeing "94% → 91%" decides whether that is drift or damage. An automatic store makes that decision by silence.

What it needs in exchange is [the weekly refresh job](examples/workflows/baseline-refresh.yml), which re-measures the default branch and opens a PR when the number has moved past the floor. Without it, drift accumulates until one PR eats the whole gap at once.

### The Action

`pickrate` never talks to GitHub. Comments, artifacts and step summaries are the Action's job, done with `gh` and shell redirection — which is what keeps the whole CI surface testable offline and leaves no GitHub token anywhere in `src/`. One invocation emits both artifacts (`--format markdown` to the summary, `--out` to the upload), because running the eval twice to get two formats doubles the bill for no new measurement.

| Input | |
|---|---|
| `command` | `inspect` (default), `run`, `mutate` |
| `config` / `target` / `adapter` | what to measure |
| `version` | npm range, or `local` to build the checkout |
| `anthropic-api-key` | omit it for `inspect` — that is the point of `inspect` |
| `baseline` | a stored JSON report to compare against |
| `comment` / `summary` / `artifact` | where the report goes |
| `args` | extra CLI flags, appended verbatim |

Outputs: `exit-code`, `report-path`, and `score` — the mutation score for `mutate`, the *worst* scenario score for `run`.

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

## Roadmap

| | | |
|---|---|---|
| **M1** | Analyser — `inspect`, no API key, no cost | ✅ shipped |
| **M2** | Runner + scorer — `run`, pass rates and confusion | ✅ shipped |
| **M3** | Mutator — `mutate`, a mutation score over injected defects | ✅ shipped |
| **M4** | CI — exit-code contract, gates in config, baseline diff, a GitHub Action | ✅ [shipped](plans/ci-plan.md) |
| **M5** | The leaderboard — run it against the best-known public servers and skills, publish the methodology | next |

The adapter split (MCP + Agent Skills through one engine) landed alongside M2; see [`plans/skills-adapter-plan.md`](plans/skills-adapter-plan.md).

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

# The baseline diff, also offline — the fixture has a seeded regression.
npm run dev -- run test/fixtures/pickrate.yaml \
  --replay test/fixtures/trials/git-server.json \
  --baseline test/fixtures/reports/git-server-baseline.json
```

Fixtures in `test/fixtures/` let every component be developed with no server running and no API spend — captured `tools/list` responses and `SKILL.md` trees for the analyser, recorded trials for the scorer, and `mutation.yaml` for the mutation loop. Each surface has a clean fixture (a test asserts it produces zero findings) and a messy one that trips every rule.

The mutation loop can't use recorded trials — they're indifferent to the surface — so its offline tests drive it with a deliberately dumb word-overlap model in `test/helpers/`. That fake stays in `test/`: it proves the wiring, and its scores are fiction.

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
  mutator/     injects known defects, scores what the harness caught (M3)
  ci/          gate engine and baseline diff — pure, no I/O, no model (M4)
  report/      table, JSON and markdown output
  exit.ts      the exit-code contract, and nothing else
  types.ts     the domain model everything else shares
```

Two seams, isolated hard on purpose. The **adapters** because the MCP spec finalises `2026-07-28` (stateless, no handshake, new routing headers) and the SDKs will churn for a couple of quarters. The **provider** because the model is a swappable part of the measurement, and because everything downstream of it must stay testable with no API key.

## Licence

MIT.
