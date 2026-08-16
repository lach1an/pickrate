# M5 — the publication milestone

**Status:** agreed, in progress — **16 August 2026**
**Implements:** [`mcp-eval-spec.md`](mcp-eval-spec.md) §7 "M5 — the leaderboard", as revised below
**Follows:** M4 (CI), complete; the corpus work in [`mutation-corpus.md`](mutation-corpus.md)

---

## 0. What M5 publishes, and what it does not

The spec framed M5 as "run against 20–30 public MCP servers and publish a ranking". [`multi-provider-plan.md`](multi-provider-plan.md) §0 already overruled half of that in writing: a single-model ranking measures a model×surface interaction and reports it as a property of the surface, which hands every low-ranked server the one rebuttal that lands — *you measured a model, not a surface, and you picked the model.*

This plan goes further, by decision:

> **M5 publishes reproducible findings and the methodology behind them, and no comparative score of any kind.** No ranking, no aggregate, no leaderboard table.

Three reasons, none of them new:

1. **Invariant 5** already says diagnostics outrank the headline number, and spec §6 already says nobody buys "your server scores 87/100" because it is unfalsifiable and they know it. A findings-first post is what those two positions cash out to when it is finally time to publish something. Publishing a ranking would be the project contradicting its own README on the way out the door.
2. **Goodhart applies to the leaderboard itself**, not just to a customer's private score. A published ranking of named servers is the strongest possible incentive to write descriptions that game it.
3. **Two findings of the right shape already exist**, and neither is a score. `cloud-logging-query-generation` fires on "our pods keep getting evicted at 3am" (10/10 Haiku, 4/5 luna) off a description claiming "or when you are debugging issues". `datalineage-bigquery-asset-impact-analysis` reverses direction by model — 0–20% on Haiku, 100% on luna. The second is sharper than the first *because* it is a disagreement rather than a number.

M5 is the work of finding more of those, cheaply, across a wider corpus, and writing them up with the methodology that makes them checkable.

### Spend is phased

**Under $20 before anything is published**, then re-budget against measured per-target numbers. The only prior data point is $3.77 and ~12 minutes for one 15-item `mutate` session, and that session's estimate was wrong twice in the same direction before it was right.

### Three things this is deliberately not

- **No new CLI surface for the sweep.** M5 is a measurement session, not a product feature. Aggregation lives in `scripts/`, alongside `fetch-corpus.ts` and `calibrate-tokens.ts`: hand-run, network-touching, never in `npm test`. A `pickrate leaderboard` command would be a permanent public API bought to serve one blog post.
- **No tracked result JSON.** `.gitignore`'s `corpus/*` / `!corpus/*.yaml` stays. Reproducibility rests on the pinned manifest, the committed configs, and the post quoting each run's provenance (`model`, `reasoning`, `regimeHash`, `schemaVersion`) — which is what those fields were added for.
- **Not step 6.** Deferred loading / `--tool-search` needs steps 1–4, doubles every run, and needs a namespace concept the `Surface` model does not have. Out of scope.

### The credential assumption

**MCP targets are credential-free.** Nothing stores per-target secrets — `--env` and `--header` are per-invocation only — and a reader who cannot connect cannot reproduce. Adding GitHub/Slack/Linear means designing secret handling first, and that is a different plan. Reversible, and the manifest carries a `credentialed` flag so the decision is visible rather than implied by what happens to be in the list.

---

## 1. The corpus

Tracked at `corpus/targets.yaml`. Skills sources are fetched at a pinned SHA; MCP servers are pinned by exact npm version in their launch args. Nothing third-party is vendored, so there is no licence question — the same guarantee `fetch-corpus.ts` already makes, generalised.

**Skills**

| id | source | items | why |
|---|---|---|---|
| `gcp-data` | `google/skills` @ `8229c1e1` | 15 | already built and measured; folds in unchanged |
| `anthropic-skills` | `anthropics/skills` @ `f6656c12` | 17 | flat under `skills/`, which is the one level `loadSkills` walks. Real clusters: the document formats (`docx`/`pdf`/`pptx`/`xlsx`) and the design family (`canvas-design`/`frontend-design`/`theme-factory`/`brand-guidelines`), plus `web-artifacts-builder` vs `webapp-testing` |

**MCP** — credential-free, launched over stdio by `npx -y <pkg>@<version>`:

| id | package | why |
|---|---|---|
| `filesystem` | `@modelcontextprotocol/server-filesystem@2026.7.10` | the confusable set is real and unforced: `read_file` vs `read_text_file` vs `read_multiple_files`, `edit_file` vs `write_file`, `list_directory` vs `directory_tree` vs `list_directory_with_sizes` |
| `memory` | `@modelcontextprotocol/server-memory@2026.7.4` | knowledge-graph CRUD, near-symmetric verbs over entities/relations/observations |
| `sequential-thinking` | `@modelcontextprotocol/server-sequential-thinking@2026.7.4` | one tool with a very large description — the token-cost outlier, and the case where `inspect` has something to say and the runner has almost nothing |
| `playwright` | `@playwright/mcp@0.0.79` | a large manifest from a real product, credential-free |
| `everything` | `@modelcontextprotocol/server-everything@2026.7.4` | **a control, not a finding source.** It is the protocol demo server; its tools are `echo`/`add`/`printEnv`. Findings about it say nothing about anyone's real surface, and the post must not present it as though they do |

`filesystem` needs an allowed directory argument; it gets `corpus/.sandbox`, created empty by the fetcher, because the manifest must not depend on whatever happens to be in the operator's home directory.

---

## 2. Phase 0 — a manifest-driven fetcher

`scripts/fetch-corpus.ts` is the right shape and the wrong scope: one repo, one SHA, one hardcoded 15-entry array, skills-only. Generalise it while keeping the three things that make it good — the pin, the allowlist, and fetching rather than vendoring.

- **`corpus/targets.yaml`** (new, tracked) is the corpus definition, reviewable as a diff.
- **`scripts/fetch-corpus.ts`** reads it, keeps the existing blobless / `--depth 1` / sparse `--no-cone` checkout routine per `git` source (that code is correct; only its inputs move out of the file), and skips `stdio` entries — for those the pinned version in `args` *is* the pin, and there is nothing to fetch.
- Per-target eval configs live at `corpus/<id>.yaml`, tracked, same shape as `corpus/gcp-data.yaml`. `parseConfig` already resolves `target:` paths relative to the config file, so nothing under `src/config/` changes.

---

## 3. Phase 1 — the free sweep (no key, $0)

**`scripts/sweep.ts`** (new). For each target: `loadSurface`, then `analyse`, then emit one aggregate JSON plus a markdown table. It imports from `src/index.ts` — which already re-exports the adapters, the analyser and the formatters — rather than shelling out to the CLI: no subprocess, no reparsing, and a type error the moment a shape moves.

Per target: `itemCount`, resident tokens (and `deferred` for skills), findings by rule and severity, and for MCP `protocolVersion`, `listOrderStable`, and whether `legacy-protocol` fired.

**The deliverable is the corpus-wide distribution of lint findings and token cost**, at zero cost and with no key. It is also the first time the analyser meets surfaces nobody wrote it against, and that is half the point: a malformed skill loading with `SkillDef.error` set is designed behaviour, an exception is a bug to fix here.

**Correct the spec while doing this.** §8 q9 says "Is '45% never trigger' reproducible on public corpora? … it needs no runner — just an analyser and a scenario set." That is wrong. An orphan rate is `findOrphans` over scored trials, so it needs the runner and a paid run; [`skills-adapter-plan.md`](skills-adapter-plan.md):238 already says so and the spec was never updated. Phase 1 cannot produce that headline. It produces the lint distribution, which is a cheaper and different finding.

**Token numbers carry their error band.** The tokeniser error is measured at −47% to +55% and changes sign by provider *and* adapter, and CLAUDE.md has settled that no correction factor ships. Re-run `scripts/calibrate-tokens.ts` over two or three of these surfaces first, so the band the post quotes was measured on this corpus rather than inherited from the fixtures.

### 3.1 Phase 1 result — 16 August 2026, $0.00, no key

Seven targets, 93 items, every one loaded. `npx tsx scripts/sweep.ts`.

| target | adapter | items | resident | deferred | error | warn | info |
|---|---|--:|--:|--:|--:|--:|--:|
| gcp-data | skills | 15 | 1383 | 20943 | 0 | 0 | 0 |
| anthropic-skills | skills | 17 | 1637 | 53683 | 1 | 0 | 4 |
| filesystem | mcp | 14 | 1731 | — | 0 | 17 | 3 |
| memory | mcp | 9 | 938 | — | 0 | 4 | 1 |
| sequential-thinking | mcp | 1 | 856 | — | 0 | 0 | 1 |
| playwright | mcp | 24 | 3383 | — | 0 | 2 | 4 |
| everything *(control)* | mcp | 13 | 1165 | — | 0 | 0 | 2 |

**Four results, and none of them needed a model call.**

1. **`@modelcontextprotocol/server-filesystem` ships 16 required parameters with no description, across 14 tools.** Every `path`, plus `edits`, `content`, `pattern`, and `move_file`'s `source`/`destination`. This is the reference implementation in the protocol's own org — which is the point, because it is the file most often copied as a starting template.
2. **A confusion pair predicted statically:** `list_directory` and `list_directory_with_sizes` describe themselves 67% alike. That is a *prediction*, and phase 2 is what turns it into a measurement or a retraction — which is the whole reason `near-duplicate-description` is a warn and not a verdict.
3. **`anthropics/skills`' `claude-api` description is 1068 characters against a 1024 limit** — a hard error against a published limit, in the skills repo people learn the format from. Three more skills (`frontend-design`, `theme-factory`, `webapp-testing`) describe what they are without saying when to use them.
4. **All five MCP servers still speak `2025-11-25`.** `legacy-protocol` fired on all five and every cache lint was correctly skipped. This is the evidence for the gating decision rather than an assumption about it: a corpus of the best-known public servers, none of them on `2026-07-28`, three weeks after publication. List order was stable on all five.

The token spread is worth reporting on its own: `anthropic-skills` costs 1,637 resident tokens against 53,683 deferred — a 33× ratio, and the clearest quantification of progressive disclosure this project has produced. `sequential-thinking` is the opposite shape: one tool, 856 resident tokens, all of it on every request.

### 3.1b The real corpus — 17 targets, 16 August 2026, $0.00, no key

Seven targets was my own selection, not the spec's 20–30. Expanded to 17: two skills sources, and 15 MCP servers spanning both reference implementations and widely-used third-party ones. All 17 load.

| target | adapter | items | resident | err | warn | info | revision |
|---|---|--:|--:|--:|--:|--:|---|
| gcp-data | skills | 15 | 1383 | 0 | 0 | 0 | — |
| anthropic-skills | skills | 17 | 1637 | 1 | 0 | 4 | — |
| filesystem | mcp | 14 | 1731 | 0 | 17 | 3 | 2025-11-25 |
| memory | mcp | 9 | 938 | 0 | 4 | 1 | 2025-11-25 |
| sequential-thinking | mcp | 1 | 856 | 0 | 0 | 1 | 2025-11-25 |
| playwright | mcp | 24 | 3383 | 0 | 2 | 4 | 2025-11-25 |
| everything *(control)* | mcp | 13 | 1165 | 0 | 0 | 2 | 2025-11-25 |
| git | mcp | 12 | 1117 | 0 | 19 | 6 | 2025-11-25 |
| fetch | mcp | 1 | 236 | 0 | 0 | 1 | 2025-11-25 |
| time | mcp | 2 | 234 | 0 | 0 | 1 | 2025-11-25 |
| sqlite | mcp | 6 | 267 | 0 | 0 | 1 | 2024-11-05 |
| puppeteer | mcp | 7 | 538 | 0 | 0 | 1 | 2024-11-05 |
| chrome-devtools | mcp | 29 | 4479 | 0 | 0 | 1 | 2025-11-25 |
| context7 | mcp | 2 | 996 | 0 | 1 | 0 | **2026-07-28** |
| antv-chart | mcp | 27 | **13614** | 0 | 52 | 36 | 2025-11-25 |
| playwright-executeautomation | mcp | 33 | 2918 | 0 | 0 | 7 | 2025-11-25 |
| desktop-commander | mcp | 26 | **10955** | 0 | 32 | 51 | 2025-11-25 |

**`missing-param-description` fires 206 times across 7 servers** — by an order of magnitude the most common defect in the corpus, and the one most directly tied to argument accuracy.

**Two servers breach the resident-token budget**: `antv-chart` at 13,614 and `desktop-commander` at 10,955 tokens, paid on every request whether a tool fires or not. Against them `fetch` (236) and `time` (234) show the achievable floor — a 58× spread across servers in the same corpus.

**`context7` is the first `2026-07-28` server measured anywhere in this project**, so the SEP-2549 cache lints fired against a live modern server for the first time rather than only against `cacheable-server.json`. It reports `missing-cache-ttl`. Every other server is legacy — `legacy-protocol` fires 14 times — and two (`sqlite`, `puppeteer`) still negotiate `2024-11-05`. List order was stable on all 15.

**Two independent Playwright servers are in the corpus deliberately** (`@playwright/mcp` at 24 tools / 3383 tokens, `@executeautomation/playwright-mcp-server` at 33 / 2918). Two implementations of one job is the sharpest thing to point a surface linter at, because every difference is authorial rather than functional.

**Coverage limit, to be stated in the post rather than left implicit.** The corpus is credential-free by construction, because nothing stores per-target secrets and a reader who cannot connect cannot reproduce. That excludes GitHub, Slack, Linear and every other credentialed server, so this is *not* a sample of "the best-known public MCP servers" and must not be presented as one.

### 3.2 The version axis, and a finding that had to be corrected before it was believed

Sweeping `inspect` across every *published version* of the five MCP servers was proposed as an alternative to `mutate`. As a study of lint drift it is dead — across the five readable versions of `filesystem` the surface is motionless (14 tools, 1707 tokens, 17 warnings; only 2026.7.10 moves, to 1731). The value is entirely at the boundary, where versions stop being readable at all.

**The first reading was wrong, and the way it was wrong is the lesson.** Of 18 published `filesystem` versions, 13 fail to load: three speak only `2024-11-05` and cannot negotiate, and ten (0.5.1 → 2025.8.21) are rejected because every tool but one carries `inputSchema: {"$schema": "…draft-07…"}` — no `type`, no `properties`. The obvious conclusion, and the one written down first, was that ten releases had shipped parameter-less manifests.

They had not. `npm install --before=2025-08-22 @modelcontextprotocol/server-filesystem@2025.8.21` — the same version, resolved against the registry as it stood the day it was published — emits **complete, correct schemas**. The defect is not in the release. It is created at install time, today:

| | resolved | result |
|---|---|---|
| `--before=2025-08-22` | `zod@3.25.76`, `zod-to-json-schema@3.24.6` | full schemas |
| today | `zod@4.4.3`, `zod-to-json-schema@3.25.2` | bare envelope |

The package declares `@modelcontextprotocol/sdk: ^1.17.0` and `zod-to-json-schema: ^3.23.5`. The caret on the SDK now resolves to a 1.x built on zod 4; npm dedupes zod 4 under the schema converter, which is a zod-**3** library; handed a v4 schema object it does not throw — it returns its envelope and nothing else. Silently, at startup, on every tool.

**So the finding is better than the one it replaced, and it is about the distribution model rather than one package.** `npx -y <server>@<pinned-version>` is exactly how MCP servers are pinned in client configs, and it pins the server without pinning anything the server depends on. There is no lockfile in that path. A config that has not changed in a year can start advertising every tool as taking no arguments, with no error anywhere. `@playwright/mcp` shows the identical signature at every version through 0.0.32 and is clean from 0.0.33; the current release of both packages is clean.

**Two rules this cost, both now enforced in code rather than prose.** An old package installed today is not that package as it shipped — `npm --before` is what separates the two, and no version-axis claim goes in the post without it. And a defect this quiet is exactly what the exit-code contract is for: `inspect` against those servers exits 2, *could not measure*, and never reports the server as bad. Turning the bytes into a finding takes a deliberate second act — see §3.3.

#### 3.2b The same cause in a second ecosystem, and it generalises the finding

Adding the official *Python* reference servers found the identical defect on the other side of the language split, which is what turns a package anecdote into a claim about how MCP servers are distributed.

**All four — `git`, `fetch`, `time`, `sqlite` — fail to start today.** `uvx mcp-server-time@2026.7.10`, the *current* release, dies on import: its floor-ranged `mcp` dependency now resolves to the Python SDK's `2.0.0` major and `McpError` moved out of `mcp.shared.exceptions`. `git` and `sqlite` die the same way one step later, on invocation.

Held to the §3.2 rule before being believed: with `uvx --exclude-newer <publish date>` — uv's equivalent of `npm --before` — all four answer `initialize` correctly. So:

| ecosystem | mechanism | failure mode |
|---|---|---|
| npm | `zod` 3 → 4 under a v3-only schema converter | **silent** — server runs, every tool advertises no arguments |
| PyPI | `mcp` 1 → 2 under a floor-ranged import | **loud** — server does not start at all |

**Pinning a server version pins neither its behaviour nor its ability to run**, and both official reference implementations are affected, in opposite directions. The silent one is worse epistemically — it yields confident measurements of a surface nobody authored — and the loud one is worse operationally.

The corpus is pinned accordingly, and asymmetrically, because the two package managers do not offer the same guarantee: `uvx` targets carry `--exclude-newer` and are genuinely reproducible; `npx` has no such flag, so for those the `surfaceHash` guard (§3.4) is the only defence.

**Two method errors, both recorded because both nearly published something false.**

- **`--help` is not a health check.** `git` and `sqlite` exit cleanly from `--help` and crash on real invocation, because `--help` short-circuits before the failing path. The first pass concluded they were fine. Only a real `initialize` handshake settles it.
- **A timeout too tight fabricates a failure.** `sqlite` was reported "would not load" at 60s; it answers in **186s**, because `--exclude-newer` re-resolves a dated graph on every run. Startup cost across this corpus spans two orders of magnitude, so the sweep takes `--timeout` rather than hard-coding a budget that invents outages. A fabricated "would not load" is exactly the exit-1/exit-2 confusion the contract exists to prevent, arriving through the back door.

### 3.4 The surfaceHash guard

Every MCP target carries a `surfaceHash` — sha256/16 of the *presented* surface, matching `regimeHash`'s convention — and the sweep **refuses** a target whose surface no longer matches rather than analysing it. Same discipline as `diffReports` refusing a mismatched baseline: findings against a surface the manifest does not name would be filed under a target that did not produce them.

It hashes the presentation rather than `Surface.items` so a server that merely reorders its listing does not read as a changed surface. Skills targets need no hash — a git SHA is content-addressed, so it genuinely pins the bytes. 15 of 15 MCP targets are pinned.

Verified end to end on 16 August 2026: a second full sweep with every pin in place produced **no refusals, no load failures, no unpinned targets, and a table byte-identical to the first run**. The guard was also checked in the failing direction against a deliberately corrupted hash, which refuses with `surface drifted: manifest pins … server served …` and reports no findings for that target. A guard only ever seen passing is a guard nobody has tested.

**Phase 2's target is `filesystem`**, chosen on this table rather than on taste: it has the missing descriptions, the statically-predicted confusion pair, and a genuinely confusable read/list family.

**One wart, not fixed here.** A `.json` target that does not exist falls through `parseTarget`'s `existsSync` check to the stdio branch and reports `spawn … ENOENT`. Pre-existing, unrelated to M5, and worth a separate one-line fix.

### 3.3 `--capture`, and `empty-input-schema`

§3.2 left pickrate unable to report the thing pickrate found. The SDK validates `tools/list` with zod and throws the bytes away, so `inspect` could only say *could not measure*. Two additions close that without touching the exit-code contract:

- **`ManifestValidationError` carries the raw response out** (`src/adapters/mcp/index.ts`). The transport is wrapped in a `Proxy` that copies every inbound message before the client sees it — a Proxy rather than a hand-written wrapper because `Transport` has optional members the client sets and reads directly, and a wrapper that forgets one fails at runtime where types would not catch it.
- **`inspect --capture <file>`** writes those bytes and **still exits 2**. It changes nothing about the outcome; it only stops the evidence being lost. Analysing the file afterwards is a separate, deliberate act with its own exit code — which is the whole distinction between "we could not read this server" and "this server is bad".
- **`empty-input-schema`** (`src/analyser/rules/shape.ts`, severity `error`) fires on a schema that declares neither `type: "object"` nor `properties`. It is deliberately silent on `{type: "object", properties: {}}`, which is a genuine claim that a tool takes no arguments.

It needed to be its own rule: `missing-param-description` walks *declared* properties, so on a schema declaring none it finds nothing and reports nothing — silence that reads as clean, which is the failure mode this codebase refuses everywhere else. `test/empty-schema.test.ts` asserts that gap directly rather than trusting this paragraph, and exercises the capture path against `FAKE_MCP_DEGRADED=1` on the hand-written fake server, because a file fixture has no response to fail validation and so cannot test it at all.

On the captured `filesystem@2025.8.21`: **13 errors**, one per broken tool, with `list_allowed_directories` correctly untouched.

---

## 4. Phase 2 — one target end-to-end, under $20

Pick one MCP target with a genuinely confusable manifest — phase 1's `near-duplicate-description` and item-count columns are how you choose, and that is the first real use of the sweep's output. `filesystem` is the working assumption.

**Author ~12–16 scenarios** at `corpus/<id>.yaml`, following the four rules already written into `corpus/gcp-data.yaml`'s header, every one of which was bought with a failed session: no prompt names its target (it may name a product the cluster shares); no destructive framing, because a refusal is not a selection; near-misses within a cluster; self-contained prompts. Selection-only, restraint scenarios included.

**Paired-probe every candidate before committing it.** [`mutation-corpus.md`](mutation-corpus.md) §5c, ~$0.20 a probe: score the scenario against a hand-blanked copy of the surface. A scenario reading 100% clean *and* 100% blanked is not a mutation instrument — it is selection by elimination, and it will report a well-written surface as untested. Probing in a throwaway config costs $0.07 against $0.25 for a full baseline, which is what keeps this phase inside its budget.

Then `run` on `claude-haiku-4-5`, `run` on `gpt-5.6-luna`, and `mutate` only if the baseline leaves scenarios with room to drop. `--dry-run` first every time.

**Two open questions a live session answers for free while here:**
- A second data point on `automatic-prefix` pricing at a different concurrency. One measurement says the all-writes assumption over-states by 3.2×, and one measurement is not enough to change what a preflight promises.
- Whether `maxErrorRate: 0.1` is right against a real public server — [`ci-plan.md`](ci-plan.md) open question 4, explicitly deferred to M5's live runs.

**Stop and re-budget here.** Phase 2's real dollars and minutes per target decide how many more targets M5 covers. Record them in this file before phase 3 starts.

### 4.1 Status — scenarios written, nothing spent

`corpus/filesystem.yaml` holds 18 scenarios (14 selection, 4 restraint), validated against the live manifest: no expectation names a tool that does not exist, and `read_file` is deliberately the expectation of none of them, so it reports as an orphan. That is the measurement — it is `read_text_file`'s deprecated twin, so any trial picking it lands as a confusion, and a run where it never appears is a run where the deprecation notice worked.

**One authoring rule cost a scenario, and the reason is worth keeping.** "Get rid of ./tmp/old-cache.bin" is the sharpest restraint case this surface has — there is no delete tool at all — and it is unusable. A refusal to destroy and correct restraint both produce an empty call list, so the scenario would pass for the wrong reason with nothing able to tell the two apart. That is spec §8's open question about refusal-as-miss showing up as a corpus problem, and a corpus is the wrong place to answer it.

**This corpus is primarily a selection instrument, and that is stated up front rather than discovered afterwards.** Unlike `gcp-data`, where product brands carry no job description, several of these tool names *are* their descriptions — `list_directory_with_sizes`, `create_directory`, `move_file`, `read_multiple_files`. A description mutation over those survives for reasons that say nothing about the harness, exactly as in the first git-server session. The description-carried pairs (`read_file`/`read_text_file`, `write_file`/`edit_file`, `list_directory`/`directory_tree`) are the only live mutation targets here. A mutation score over this surface should be expected to under-report.

**A config-format wart, found by running it.** `target.command` is the only target form not resolved relative to the config file — skills paths and captured manifests both are — so a config whose command carries a relative path only works from one working directory. Documented in the file for now; the fix is either resolving it or refusing it, and it is not an M5 decision.

**Blocked on a credential.** `--dry-run` refuses without `ANTHROPIC_API_KEY`, correctly and before parsing anything. Nothing has been spent.

---

## 5. Phase 3 — step 4 of the multi-provider plan (offline, free)

Findings-first still needs cross-model evidence: a finding reproducing on two providers survives the rebuttal in §0, and the impact-analysis finding *is* a Δ — it does not exist as a single-model number. Doing that by hand across N targets is the error-prone part, and the fixture to build it against is already recorded and paid for.

Build [`multi-provider-implementation.md`](multi-provider-implementation.md):293–302 and no more:

- `src/cli.ts` — `--models <a,b>` and `--reasoning <effort>` as run-level flags, never config keys. A stored config that silently runs two models doubles a bill on an invocation that looks identical to the one it was costed at. The cost confirmation sums across models before it asks.
- The Δ table in `src/ci/compare.ts` or a sibling, reusing `diffReports`' floor machinery with the floor computed **per model**, since error rates differ. Restraint scenarios are listed separately, not folded into the ordering: M3 established restraint moves opposite to selection, so a merely more reluctant model reads as better on restraint and worse on selection.
- `--out` with `--models` writes one payload with `command: "compare"` carrying the per-model reports. Additive, so no `SCHEMA_VERSION` bump. Not N files with mangled names.
- `test/compare-models.test.ts` on `test/fixtures/trials/git-server-openai.json`, with one scenario disagreeing **past** the floor and one **inside** it — by construction, the way M4's baseline fixture is, not by luck.

Neither model is a reference and neither is ranked. Δ is a diagnostic. This subsumes `ci-plan.md`'s open question 3.

---

## 6. Phase 4 — the write-up

One post, generated from the artifacts so the prose and the data cannot drift.

Each finding is stated as: the surface and its pin, the prompt, the rate on each model with trial counts, the noise floor it clears, and what in the description caused it. Anything below a floor is not reported as a difference. The `everything` server is labelled a control wherever it appears.

The methodology section is largely drafted already, in `README.md` — `### What run does and doesn't do` and the whole `## pickrate mutate` section including the paired-probe recipe. Lift and cite it rather than rewriting it; a second copy is a copy that goes stale.

---

## 7. Still open

- How many targets past phase 2. Decided on phase 2's measured cost, not now.
- Whether the `everything` control earns its place at all, or whether including a demo server in a published corpus invites more confusion than the control is worth.
- Credentialed MCP servers, and the secret handling they would need (§0).
- Everything in [`mutation-corpus.md`](mutation-corpus.md) §6 that a wider corpus might answer — chiefly spec §8.5 (how many mutants before the score means anything) and whether `blank-description` should change given it under-reports on well-differentiated surfaces.
