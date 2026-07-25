# pickrate — working notes

Full spec: [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md), plus [`plans/skills-adapter-plan.md`](plans/skills-adapter-plan.md) for the MCP/skills adapter split and [`plans/ci-plan.md`](plans/ci-plan.md) for M4. Read them before making design decisions; they settle most of them.

## Current state

**M1 (analyser) and M2 (runner + scorer) — complete.** `pickrate inspect <target>` reports token cost and lint findings; `pickrate run <config.yaml>` runs scenarios × trials against a model and reports pass rates, confusion pairs, orphans and flakiness.

**Adapter split — complete (6 of 6).** The core is generic over a `Surface` (`SurfaceItem = ToolDef | SkillDef`) and runs through an `Adapter` (`load` + `present`), with providers taking a `Presentation` and the scorer projecting raw calls onto selections. `inspect` and `run` both work on MCP servers and skills directories, with offline fixtures for each.

**M3 (mutator) — complete.** `pickrate mutate <config.yaml>` measures the clean surface twice for a noise floor, then runs one eval per injected defect and reports a mutation score. Three operators (`blank-description`, `swap-descriptions`, `inject-decoys`), all applying to both adapters.

**M4 (CI) — complete.** Exit-code contract in `src/exit.ts`, gates in a `ci:` config block evaluated by `src/ci/gates.ts`, baseline comparison in `src/ci/compare.ts`, a markdown reporter, and a composite `action.yml` with workflows in `.github/` and `examples/workflows/`. Reasoning in [`plans/ci-plan.md`](plans/ci-plan.md).

**M5 (the leaderboard) is next** — run against the best-known public servers and skills and publish the methodology. It is the first milestone that spends real money, and the first with no plan file yet.

**Distribution is live.** Public at [`lach1an/pickrate`](https://github.com/lach1an/pickrate), default branch **`master`** — not `main`, which matters for the workflow triggers and the committed baseline path. Version `0.1.0`. Publishing goes through `.github/workflows/release.yml` on a `v*` tag, using npm **OIDC trusted publishing** — which still needs its one-time configuration on npmjs.com (repository + workflow path) before a tag will publish. There is deliberately no `NPM_TOKEN` secret.

## Invariants

These are load-bearing, not preferences:

1. **`inspect` never makes a model call and never requires an API key.** The zero-credential first run is the distribution strategy, not a nicety. Analyser rules are pure: `Surface` in, `Finding[]` out.
2. **Only `src/adapters/mcp/` imports `@modelcontextprotocol/sdk`; only `src/provider/` imports `@anthropic-ai/sdk`; `src/adapters/skills/` imports `node:fs` and `yaml` and nothing else.** Everything else consumes `Surface` and `TrialResult` from `src/types.ts`. The MCP spec finalises `2026-07-28` (stateless, no `initialize`, no `Mcp-Session-Id`, new `Mcp-Method`/`Mcp-Name` routing headers) and the SDKs will churn; the model is a swappable part of the measurement. Contain both.
   - Adapters emit provider-neutral `ToolDeclaration`s and system text via `present()`; the provider converts. An adapter that reaches for an Anthropic type has broken the seam in both directions.
   - `src/adapters/contract.ts` holds the interfaces, `index.ts` holds the registry. They are separate files because the registry imports every adapter and every adapter needs the interfaces — one module is a cycle that typechecks and then throws at runtime.
   - A `Presentation.systemSuffix` sits inside the cached prefix and **must** be byte-stable across trials. Deterministic iteration only: no `Set` ordering, no absolute paths, no timestamps. The only symptom of getting this wrong is a bill ~10× the estimate.
3. **Every eval assertion is a pass rate over N trials, never a boolean.** Tool selection is non-deterministic; a binary assertion passes Tuesday and fails Wednesday.
4. **Score selection, arguments and restraint separately.** Different bugs, different fixes. Restraint (correctly calling *nothing*) is the most neglected.
5. **Diagnostics outrank the headline number in the report.** Goodhart: the moment someone optimises the score they write descriptions that game it. Confusion pairs, orphan tools and token cost go above any total.
6. **Never retry a trial because of its result.** Transport errors retry (in the SDK client); a "wrong" tool choice is data. Retrying it until it looks better biases every pass rate upward, invisibly.
7. **`run` never executes a tool.** One model turn per trial; `tools/call` is never issued. A `delete_branch` scenario must not delete anything on the user's server.
8. **Exit 1 and exit 2 are different facts and must never be collapsed.** 1 is "measured, and the answer is bad"; 2 is "could not measure". CI reads the code and nothing else, so a harness that conflates them turns an outage into a passing build or a regression into an infra ticket. Every thrown error is 2, never 1. `src/exit.ts` is the only place the numbers live.
9. **pickrate does not talk to GitHub.** The only network calls are the adapter's and the provider's. Comments, artifacts and step summaries are `action.yml`'s job, done with `gh` and shell redirection — which is what keeps the entire CI surface testable offline and means no GitHub token appears anywhere in `src/`.
10. **The API key reaches the CLI as an environment variable, never an argument.** An argument lands in the command trace. No report field, in any format, ever carries a credential.

## Measurement decisions (M2)

Changing any of these changes what the numbers mean — don't adjust them casually.

- **Selection passes only on exactly one call, the expected one.** Over-eager tool calling is a real failure mode; scoring "right tool plus two others" as a pass would hide it.
- **Arguments are matched as a subset** — only keys declared in `expect.args`. Extra arguments the model supplies are ignored, so a scenario never has to enumerate optional params.
- **Normalisation trims strings and nothing else.** No lowercasing: branch names, paths and identifiers are case-sensitive, and wrong case *is* a wrong argument.
- **The presentation mode is part of the result, not a setting.** `skill-tool` (one dispatch tool plus a listing) is the mechanism agents actually use and is the default; `pseudo-tool` (one synthetic tool per skill) is a *more* favourable surface than reality and exists as a control — the difference between the two separates dispatch cost from description quality. Scores from the two modes are not comparable as scores, so `EvalReport.presentation` is printed above the numbers, and `ReplayProvider` refuses trials recorded under a different mode rather than projecting them through the identity and reporting a flat zero.
- **Projection happens at score time, never to `TrialResult`.** The fixture on disk stays what the model actually did, so a recording survives a presenter rewrite. `Presentation.project` must be total: a projection that *drops* a call turns a bad selection into an empty call list, which scores as restraint — a false pass in the metric that is already the most neglected. Both `scoreScenario` and `findOrphans` project, each exactly once; skip it in `findOrphans` and every skill reads as an orphan.
- **Errored trials leave the denominator** and are counted separately, so a flaky network doesn't read as a bad manifest.
- **`tool_choice: auto` is mandatory** — a forced choice makes restraint scenarios impossible to express.
- **Never `thinking: {type: "disabled"}`.** On some models that makes tool calls arrive as visible text rather than `tool_use` blocks, which this harness would silently score as "selected nothing" — a systematic error in the primary metric. Use `output_config.effort` for cost instead.
- **Warm-then-fan-out.** The cache breakpoint sits on the system prompt (which renders after `tools`), and a cache entry is only readable once the first response returns — so trial 1 runs alone. Keep `SYSTEM_PROMPT` byte-stable; one interpolated timestamp makes a run ~10× dearer.
- **No seeding is available.** `temperature`/`top_p`/`top_k` are removed or rejected on current models and there is no seed parameter, so the spec's "deterministic seeding where the provider allows it" is not implementable. Variance is irreducible — which is the premise anyway.

## Mutation decisions (M3)

The mutation score is the number nobody can sanity check by eye, so each of these is load-bearing.

- **A mutant is killed only when its drop clears a measured noise floor.** The clean surface runs twice; the gap between them is the bar. A score built on one baseline is a count of coin flips.
- **`minNoise(trials) = 1/trials` floors that gap.** Two baselines that land identically would otherwise set the bar at zero and kill every mutant, including no-ops — and any deterministic provider produces exactly that. The offline test asserts it directly.
- **`mutate --replay` is refused.** `ReplayProvider` is keyed on `scenarioId` and indifferent to the surface, so every mutant replays identically and scores 0% — an artefact that reads like a devastating finding. Offline coverage instead uses `test/helpers/lexical-provider.ts`, a word-overlap fake that is **test-only** and must never reach `src/` or the CLI: its numbers are fiction.
- **Operators are pure and enumerate totally.** `apply` clones; `enumerate` returns every mutant in surface order and `planMutants` takes them round-robin. That makes a session reproducible with no seed — which matters, because no seed is available (see M2 decisions).
- **Operators mirror a changed description into `raw` (and skills' `frontmatter`) where the key exists**, so `inspect` on a mutant reports the surface that was measured. They never invent a key that was not there: a mutant is the baseline plus one known defect and nothing else.
- **Judgement is on the mean scenario score, not a pass count.** A threshold is a step function; 0.99 → 0.96 is real damage a pass count reports as nothing happening.
- **Restraint scenarios move the wrong way.** Damage makes a model less willing to call anything, which raises restraint and can hide a selection collapse inside the mean. `MutantRecord.restraintOnly` flags it — a diagnostic, not a second threshold.
- **A survivor is inconclusive, never a pass**, and the report says so and names its `targets`. "No scenario tests this" and "the harness is blind to this" are indistinguishable from the score alone.
- **Mutation scores are per-adapter and never averaged** (spec §11.7). One `mutate` run is one surface, so this is structural; the report copy states it anyway.
- **`--mutants` defaults to 3, not the spec's 3×3.** Nine mutants plus two baselines is ~1100 trials before anyone has seen the output once. Spec §8.5 (how many mutants before the score means anything) stays open — it is a thing to measure, not to guess.

## CI decisions (M4)

- **Gates live in the config file, not the workflow.** A threshold argued over in review belongs next to the scenarios it judges. CLI flags override it; `gatesFor` in `cli.ts` is the one place that merges the two. **Unknown keys under `ci:` are an error** — a misspelled `maxFlakey:` is a gate its author believes is guarding them, and its silence only becomes visible in the moment it was needed.
- **`maxErrorRate` is the only gate on by default, and it breaches as *unmeasured*.** Errored trials leave the denominator (M2), so 18 failures out of 20 trials report a confident 100% from the survivors. A `GateResult.unmeasured` breach outranks every failed one in `exitCodeFor` — reporting it as a bad answer sends someone to fix a manifest that was never wrong.
- **No gate on the mean score, deliberately.** Per-scenario thresholds already gate, and a headline mean is the number people optimise. Spec §6's Goodhart warning cashed out as a missing feature. Open question 1 in the plan resolves to "no".
- **The regression gate is on the worst per-scenario drop, never the mean.** A mean hides one scenario collapsing behind five that improved, and the collapsed one is the one headed for production.
- **`maxRegression` is floored at `minNoise(trials)`, imported from `src/mutator/index.ts` and never reimplemented.** Two copies of the noise floor drift apart. A diff between two single runs cannot measure its own noise the way `mutate` can, and both reports say so in words rather than implying the floor is a measurement.
- **A mismatched baseline is refused, not projected** — schema version, adapter, model, presentation or scenario set. Same discipline as `ReplayProvider` refusing a foreign presentation mode, and for the same reason: a comparison across models is a number that looks like a regression and is a model swap.
- **The instrument drifts, which no comparable tool has to handle.** A model *alias* can be re-pointed underneath a stored baseline, so `diffReports` warns when the recorded model is not a dated snapshot, and the docs push pinning. The mismatch check only bites once someone has pinned.
- **The baseline is a committed file** (Stryker's `stryker-incremental.json`, not `size-limit-action`'s recompute-both-sides): the measurement is expensive, so the base side cannot be re-derived on demand. It also suits a stochastic number — the baseline moving is a reviewed diff rather than a decision made by silence. The weekly refresh job ships with the pattern, because it is the only thing between a committed baseline and silent staleness.
- **`--out` always writes JSON, whatever `--format` prints.** One run, both artifacts; the Action needs a human one and a machine one, and a second run to get the second format doubles the bill.
- **`gates` and `diff` are parameters to the JSON formatters, not fields on `EvalReport`.** A gate verdict is not a measurement: the same run judged against two configs is one measurement and two verdicts, and only the measurement belongs in a stored baseline. Both keys are additive, so `SCHEMA_VERSION` stays 2.
- **`test/schema.test.ts` asserts the exact key set of every payload.** From the Action's existence onward, these are somebody's pipeline: additions are free, renames and removals cost a bump, and the test is what forces the bump rather than a stranger's broken build. It also pins `cli.ts`'s `VERSION` to `package.json`'s, because they are duplicates.
- **`test/exit.test.ts` drives a child process, not `main()` in-process.** The contract is about the *process* status, so the top-level catch and the entry-point guard are inside what is asserted. One case invokes the CLI **through a symlink**: npm installs the bin as one and does not resolve it into `argv[1]`, and getting that wrong makes the published CLI print nothing and exit 0.

## Stack

Node ≥20.19, TypeScript (strict, `exactOptionalPropertyTypes`), ESM, `tsc` to `dist/`. Tests are `node:test` via `tsx`, offline, no snapshots. Arg parsing is `node:util` `parseArgs` — no CLI framework.

Current SDK (`1.29.0`) still negotiates protocol `2025-11-25` and still does the initialize handshake. No `2026-07-28` SDK has shipped yet. When one does, the change should land in `src/adapters/mcp/index.ts` and nowhere else.

## Fixtures

Two kinds, both so components can be developed with no server and no API spend:

- `test/fixtures/*.json` — captured `tools/list` responses, read by `loadManifestFromFile`. `git-server.json` is deliberately clean (a test asserts zero warnings); `messy-server.json` deliberately trips every analyser rule.
- `test/fixtures/skills/{clean,messy}/*/SKILL.md` — the same pair for skills, same contract: `clean` asserts zero findings, `messy` trips all five skills rules plus the shared `near-duplicate-description` and `token-budget`. `messy/broken` and `messy/no-frontmatter` exist to prove a bad file is a finding, not a crash — the other six skills load around them.
- `test/fixtures/trials/*.json` — recorded `TrialResult[]`, replayed by `ReplayProvider`. `git-server.json` covers a clean scenario, a confusion pair, a restraint miss, an argument mismatch and an errored trial. `test/fixtures/pickrate.yaml` pairs with both. `trials/skills.json` + `skills-eval.yaml` are the skills equivalent, and additionally cover the projection path: a dispatch hit, a near-miss confusion, an over-call, an errored trial, and a bare `Skill()` with no argument (which must not score as restraint). Its calls are raw transcripts — `Skill` with the skill in `args` — never pre-projected.

- `test/fixtures/reports/git-server-baseline.json` — a stored `run` report for the baseline diff, hand-tuned so every comparison case is exercised by construction rather than by luck: an improvement that is also a fix, a 40-point drop past the floor, a 15-point drop *inside* the floor that is nonetheless a new failure, a 5-point non-event, and an empty `orphans` so `delete_branch` reads as new. Its model is an alias, so the drift warning fires. The floor is `minNoise(4) = 25%` because the smallest scored scenario in the replay has four trials — change the trial fixture and these numbers move.
- `test/fixtures/ci.yaml` — one config carrying `ci:` gates and a `target:`, for `inspect --config`. It points at the *messy* manifest so every gate in it is breached: a gate that silently failed to fire would otherwise show up as a green run.

- `test/fixtures/mutation.yaml` — the mutation loop's config. Selection-only (arguments are a separate metric and would move the mean for reasons unrelated to the injected defect), and its prompts are phrased around what the *descriptions* say rather than what the tools are called — a prompt that repeats a tool's own name can be answered from the name alone, so a description-damaging mutant would survive for reasons that say nothing about the harness. `list_branches` is deliberately exercised by no scenario, which is what proves a survivor means "nothing tested this".

Together they run the whole eval pipeline offline:

```bash
npm run dev -- run test/fixtures/pickrate.yaml --replay test/fixtures/trials/git-server.json
```

The mutation loop cannot use them — recorded trials are indifferent to the surface — so it is exercised offline by `test/helpers/lexical-provider.ts` instead.

## Conventions

- Rules live in `src/analyser/rules/`, grouped by theme, registered in `rules/index.ts`. Thresholds are exported named constants, not inline literals. Mutation operators mirror that layout exactly — `src/mutator/operators/`, registered in `operators/index.ts`, with `src/mutator/contract.ts` split out for the same runtime-cycle reason as `src/adapters/contract.ts`.
- Findings anchor to `item` (a tool or skill name) and a schema `path` where they can. `detail` is for `--json` consumers only.
- Every rule declares `appliesTo: SurfaceKind[]`. A rule that cannot say anything about a surface is skipped, not run against an empty narrowing — silence and "no findings" must not be the same thing. Narrow with `toolsOf`/`skillsOf` from `src/surface.ts`, never a cast.
- Token counts are *resident* cost. For skills that means routing descriptions only; bodies go in `TokenReport.deferred`, are reported on their own line below the headline, and are never summed into the total. `deferred` is set for every skills surface even at zero — "your bodies cost nothing" and "we did not measure them" are different statements.
- A malformed skill loads with `SkillDef.error` set rather than throwing. One bad file in a set of thirty must not take down the run, and an unreachable skill is itself the finding. Rules that would pile on (`missing-skill-description`) skip items with an error, so the actual cause stays legible.
- `src/ci/` is pure in the same sense the analyser is — reports in, verdicts out, no I/O and no model — so every gate and every diff is testable against the replay fixtures with no key and no spend. `cli.ts` stays a thin arg-parser: it merges flags over config gates and emits, and decides nothing.
- The JSON report shape is versioned (`SCHEMA_VERSION`, now 2); the CI integration pins on it, and `test/schema.test.ts` freezes it. Version 2 has not shipped, so it absorbed the whole adapter split: `itemCount`, `orphans`, `finding.item`, `confusions[].selected`, `source.adapter`, `presentation`. Once M4 exists, a change like any of those costs a bump. M3's `command: "mutate"` output did *not* bump it — a new command is an addition, and nothing pinned on 2 for `inspect`/`run` can break on a shape it has never seen.
- Report copy takes its noun from `source.adapter` via `itemNoun`. A skills run that says "tool" reads like it measured the wrong thing, and the reader cannot tell that it didn't — a test asserts the word never appears on a skills report.
