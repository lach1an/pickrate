# The mutation corpus, and the first mutation score that measured anything

**Runs:** 3 August 2026, `claude-haiku-4-5-20251001`, `$4.86` total.
**Artifacts:** `corpus/gcp-data.yaml`, `scripts/fetch-corpus.ts`, `corpus/mutate-gcp-data.json`.

## 0. Why the first live session scored 0%

The first live `mutate` (`test/fixtures/mutation.yaml` × `git-server.json`, $0.24) killed 0 of 3 and every mutant landed on exactly the baseline 0.667. Not a harness bug — token counts prove each mutation reached the wire. The surface was the problem, in two independent ways:

- **Names restated descriptions.** `create_branch` answers "make a feature-login ref" from the name alone, so blanking its description and swapping it with `delete_branch`'s both still scored 10/10. Descriptions carried no routing load, so description operators had nothing to destroy.
- **Two of three scenarios could not move.** `delete-branch` sat at 0% clean because the model *declined* an irreversible action (called nothing 7–9 of 10) rather than mis-selecting; `no-tool-needed` is restraint, which moves the wrong way. One live scenario remained, and it was name-answerable.

So the score was structurally zero before a model call. **Lesson: a mutation score is only a measurement if the descriptions were load-bearing to begin with, and that is a property of the surface, not the harness.**

## 1. The corpus

`google/skills` @ `8229c1e1ab1b8bd9bd4334e6953ae6bb81bbf2db`, 15 skills, fetched not vendored (`corpus/` is gitignored; the SHA and allowlist in `scripts/fetch-corpus.ts` are the reproducibility guarantee).

Chosen because the names are **product brands, not job descriptions** — nothing about `spanner` says "globally consistent transactions" — and the descriptions carry explicit negative routing (*"Do NOT use for general PostgreSQL instances (e.g. Cloud SQL)"*, *"use the datalineage-bigquery-asset-impact-analysis skill instead"*). That negative routing is exactly what `blank-description` and `swap-descriptions` destroy.

`pickrate inspect` reports **no findings** on it. `near-duplicate-description` does not fire — these are professionally written, lexically well-separated descriptions, and the confusability is semantic. That makes it a fairer instrument than a manufactured one: a surviving mutant here cannot be dismissed as a bad corpus. At ~1,383 resident tokens it is also the first surface above the 1024-token cache minimum that `multi-provider-implementation.md` flagged as untestable — though still below the default model's 4096, so `0 cached` again.

## 2. Three scenario-authoring rules, each bought with a failed run

The scenarios took three iterations at $0.25 a full baseline. Probing candidate phrasings in a throwaway 6-scenario config cost $0.07 instead, which is how the last two were settled.

1. **No prompt names its target — but it may name the product the cluster shares.** The first draft stripped "BigQuery" as well, and four scenarios floored at *"got nothing"*: with no product context the model had no reason to reach for a Google Cloud skill at all. Naming the product leaks nothing when three skills claim it and the *interface* is the discriminator.
2. **No destructive framing.** Refusal is not selection (the `delete-branch` lesson).
3. **A prompt must be self-contained.** *"turn these PromQL expressions into dashboard definitions"* scored 0/5 because the expressions were not there and the model asked for them instead of acting. That measures conversational repair, and it floors a scenario as dead as a refusal does.

## 3. The result

**Baseline 86%** from two clean runs of 10 trials, noise floor 10%. **Mutation score 17% — 1 of 6.** Cost $3.98.

| mutant | Δ mean | verdict |
|---|---|---|
| `inject-decoys` (20 items onto 15) | −11% | **detected** |
| `blank-description:bigquery-ai-ml` | −5% | survived |
| `blank-description:alloydb-basics` | +2% | survived |
| `swap-descriptions:alloydb+bigquery-ai-ml` | −1% | survived |
| `swap-descriptions:alloydb+bigquery-basics` | +1% | survived |
| `blank-description:bigquery-basics` | +1% | survived |

`inject-decoys` is the first mutant this project has ever killed. Context bloat degraded selection across the whole surface — `in-warehouse-forecast` 100%→10%, `blast-radius` 65%→10%.

## 4. Two findings that are about the harness, not the corpus

### 4.1 The kill criterion is a mean, and a mean cannot see a single-scenario collapse

`blank-description:bigquery-ai-ml` **destroyed the one scenario that tests it**: `in-warehouse-forecast` went 100% → 30%. That is a description doing real routing work and a mutation removing it — precisely the signal the whole milestone exists to detect. It was reported as a **survivor**, because a 70-point collapse on one scenario out of sixteen is a 4.4-point move in the mean, structurally below any honest noise floor.

This is not a threshold that wants tuning; it is the wrong statistic. **A mutant damages specific items, so its effect is concentrated in the few scenarios that exercise them, and dividing by the whole scenario count guarantees dilution that grows with corpus size.** The larger and better the corpus, the more invisible a real kill becomes.

M4 already learned this exact lesson on the other side of the codebase — *"the regression gate is on the worst per-scenario drop, never the mean; a mean hides one scenario collapsing behind five that improved"* — and the mutation kill criterion never got the fix.

**Fixed.** A mutant is now killed on `worstDrop > baseline.scenarioNoise`, taken over *every* scenario rather than only those expecting a damaged item — the interesting failure is a neighbour stealing the selection, so the scenario that collapses is usually not the target's own. The floor moved with it: `scenarioNoise` is the widest gap any single scenario showed between the clean runs, floored at `minNoise(trials)`, because the maximum of sixteen noisy scenarios swings far further than the mean of sixteen and judging one against the other's floor would kill everything. The mean survives as `delta`, a reported diagnostic.

**Re-judging the recorded session offline, at no cost, takes it from 17% to 50% — 3 of 6:**

| mutant | worst drop | on | verdict |
|---|---|---|---|
| `inject-decoys` | 90% | `in-warehouse-forecast` | **killed** |
| `blank-description:bigquery-ai-ml` | 70% | `in-warehouse-forecast` | **killed** (was survived) |
| `swap-descriptions:alloydb+bigquery-ai-ml` | 20% | `provenance` | **killed** — marginal, see below |
| `swap-descriptions:alloydb+bigquery-basics` | 10% | `provenance` | survived |
| `blank-description:bigquery-basics` | 10% | `global-consistency` | survived |
| `blank-description:alloydb-basics` | 5% | `dashboard-widgets` | survived |

The marginal kill deserves naming: `provenance` is both the scenario that *sets* the 20% floor and the one supplying that kill. A single high-variance scenario raising the bar and clearing it is a real weakness of a max-based statistic, and it argues for tightening `provenance` (baseline 10–20%, nearly floored) rather than for changing the rule.

### 4.2 `planMutants` spent half the budget on an item nothing tests

Three of six mutants targeted `alloydb-basics`, an **orphan** — no scenario selects it, so all three were guaranteed survivors. The cause is benign and documented: operators enumerate in surface order and the planner takes them round-robin, deterministically, because no seed is available. Surface order is alphabetical, and `alloydb-basics` sorts first.

The reporting behaved correctly — each survivor named its `targets`, which is what makes "nothing tested this" legible — but ~$2 of a $4 session measured nothing.

**Fixed.** `PlanOptions.exercised` takes the item names some scenario expects (`exercisedItems(config)`, which reads `expect.tool` and ignores restraint scenarios, since they name what must *not* be selected). Each operator's queue is **stably partitioned**, covered items first. A partition rather than a filter, because a mutant on an untested item is still worth running once the tested ones are exhausted — a survivor naming an orphan is the only way "no scenario covers this" gets reported at all. Stable, so order within each half is still surface order and a session stays reproducible without a seed.

## 5. Two corrections to the cost estimate

Both under-reported the bill, the direction this project treats as a defect.

- **Fixed.** `preflight` priced `runs` copies of the *clean* surface, but `inject-decoys` grows the manifest on purpose — it cost 1.9× a clean run in the first session, a 26% under-report. `preflight` now takes one leg per surface and `mergeEstimates` sums them; `inputTokensPerTrial` becomes the trial-weighted mean so it still multiplies back to the total, and the cost drops to absent if any leg fails to price rather than reporting a partial sum. Tested in `test/pricing.test.ts`.
- **Fixed.** `OUTPUT_TOKENS_PER_TRIAL` sat at 80 through two sessions that spent 105/trial and **150/trial**. That constant was the entire residual gap — $3.54 estimated, $3.98 billed, and 1280 × 70 × $5/M = $0.45 closes it exactly. Now 150, and **exported**: `test/pricing.test.ts` had re-hardcoded the literal `80` in nine places, so the tests agreed with the bug rather than catching it. Same reasoning as the analyser's "thresholds are exported named constants, not inline literals", applied one directory over.

## 5b. The 8 August OpenAI session — $0.09, and three things came out of it

Run on `gpt-5.6-luna` because the Anthropic balance was exhausted. Cross-provider scores are not comparable (model + reasoning + regime is the unit, never averaged), so this could rule a phrasing *out* but not confirm one for Haiku. It ruled plenty out.

**`provenance` is fixed, and the control proved why.** Four candidate phrasings at 4 trials: the winner at 100% leans on the description's own vocabulary — *"I'm debugging a data quality issue and need the provenance of a BigQuery table — what feeds it, and what does it feed?"*. The deliberate control, phrased with *"summarise"* — half the skill's own name and the exact discriminator against its neighbour — scored **0%**. The worry that the name would leak and inflate the score was exactly backwards, which is the evidence that the winner wins on the description. `blast-radius`'s existing wording scored 100% unchanged, so its Haiku weakness is provider-specific rather than a bad prompt. Full corpus at 5 trials: **14 of 16 at 100%, nothing floored.**

**The over-trigger finding reproduces across providers.** `cloud-logging-query-generation` takes "our pods keep getting evicted at 3am" 10/10 on Haiku and 4/5 here. A single-provider finding is precisely the confound `multi-provider-plan.md` §0 warns the leaderboard against publishing; two providers independently is a result that survives the obvious rebuttal.

**A prefix cached for the first time in this project's history, and it settles an open question.** Every previous surface sat below its model's minimum, so `0 cached` was the expected reading and confirmed nothing. At 1,615 tokens per trial against OpenAI's 1,024 minimum, this one caches: `cacheCreationInputTokens: 3515`, `cacheReadInputTokens: 125675` over 80 trials — **2.2 trials wrote the prefix and 77.8 read it.**

M2's decision to price every `automatic-prefix` trial as a write says outright that "the real ratio is unmeasured". It is now measured, and the estimate over-states by **3.2×** — $0.2335 against $0.0735 billed. Over-stating is the accepted direction, but 3.2× is enough to talk someone out of a run costing a third of what they were told.

A mechanistically motivated fix rather than a fitted one: at most `concurrency` trials can race before the first response lands and populates the prefix, so price `concurrency` writes plus `N − concurrency` reads. At concurrency 4 that predicts 4 writes against 2.2 observed — still an upper bound, at 1.8× rather than 3.2×. **Not implemented:** it is a measurement decision, and one data point at one concurrency is thin evidence for changing what a preflight promises.

Note also that the new cache-minimum warning correctly stayed *silent* on this run, which is the branch a sub-minimum surface cannot exercise.

## 5c. The 8 August Haiku session — $4.05, and the score that means something

**Mutation score 67% — 4 of 6 — against 17% on 3 August.** Baseline 89%, and `scenarioNoise` fell to **10%**, which is `minNoise(10)`: the two clean runs agreed exactly on the mean and within one trial on every scenario. There is no lower floor available at ten trials.

### `provenance` did not reach 80%, and the earlier claim was wrong

A 5-trial run read it at 80% and that was recorded here as a confirmation. The 10-trial session reads **40% / 30%**. Five trials on a scenario near 35% has an interval wide enough to produce an 80% sample by chance, and it did.

| | 3 August | 8 August |
|---|---|---|
| level | 10% / 30% | 40% / 30% |
| run-to-run gap | **20 points** | **10 points** |

The rewording improved *stability* — the gap halved, and the gap is what sets the floor — far more than *level*, which moved from ~20% to ~35%. It remains the weakest scenario in the corpus. **Most of the floor's 20 → 10 point drop is attributable to removing `blast-radius`, not to the `provenance` rewording.** Worth stating because the two changes shipped together and the credit is not evenly split.

The lesson generalises: a 5-trial probe is fine for *ruling a phrasing out* and cannot confirm one. Every acceptance in §5b was made on 4 trials and is subject to the same caveat.

**`blast-radius` is dropped, and the reason is a measurement one.** Ten minutes after it scored 60% in the full-corpus run, the identical prompt scored 20% in a three-phrasing probe — same model, same surface, same trial count. Across three clean runs it has now read 20%, 60% and 70%, always failing by the model declining to select rather than by picking its neighbour. Two alternative phrasings, each lifted from the description's own trigger list, scored 0%.

`baseline.scenarioNoise` is the widest single-scenario gap between the clean runs, so a scenario that swings 40 points sets a 40-point bar for every mutant in the session — the same defect `provenance` was reworded to remove, larger. Keeping an unmeasurable scenario for the sake of coverage would quietly buy back the problem this whole exercise existed to fix.

The skill stays in the surface, so `swap-descriptions` still has both halves of the lineage pair to trade; `provenance` is what registers the damage. The skill reads as an orphan now, which is the honest statement: nothing in this corpus can test it on this model.

### What the session establishes

| mutant | worst drop | on | verdict |
|---|---|---|---|
| `blank-description:bigquery-ai-ml` | −95% | `in-warehouse-forecast` | **killed** |
| `inject-decoys` | −75% | `in-warehouse-forecast` | **killed** |
| `swap-descriptions:alloydb+bigquery-ai-ml` | −20% | `dashboard-widgets` | **killed** |
| `swap-descriptions:alloydb+bigquery-basics` | −20% | `dashboard-widgets` | **killed** |
| `blank-description:bigquery-basics` | −10% | `metric-discovery` | survived (*at* the floor) |
| `blank-description:bigquery-bigframes` | 0% | — | survived |

- **The kill-rule change is validated on live data.** `blank-description:bigquery-ai-ml` is the mutant the mean-based rule reported as a survivor on 3 August. It now kills at −95%, and the re-judge of the old recording predicted exactly this.
- **Both `swap-descriptions` mutants killed on `dashboard-widgets`, which exercises neither damaged skill.** That is a neighbour stealing the selection, and it is the direct evidence for §M3's decision to take the worst drop over *every* scenario rather than only those expecting a damaged item. Judging on the target's own scenarios would have scored these two as survivors.
- **The planner change held.** No mutant landed solely on an orphan, against three of six in the previous session.
- `blank-description:bigquery-basics` dropped exactly 10% — *at* the floor, not past it. Reported as a survivor, and genuinely borderline rather than clean.

### `notebook-pandas` leaks the name, and that is my error

`blank-description:bigquery-bigframes` moved its own scenario by **0%**. The prompt asks for "pandas syntax", and BigFrames *is* BigQuery DataFrames — the name carries the routing, so removing the description changes nothing. This is precisely the failure the corpus was built to avoid (§0), reproduced in a hand-written scenario, and it went unnoticed because the scenario scores 100% and looks healthy. **A scenario passing at 100% tells you nothing about whether the description earned it; only a mutation does.** Which is the argument for the whole milestone, arrived at the expensive way.

## 6. Still open

- **How many mutants before the score means anything** (spec §8.5) is still open, and 6 is still a guess. 4.2 says the answer depends on the planner as much as the count — and at 6, one borderline verdict is worth 17 points of score.
- **`notebook-pandas` wants rewording** so the description carries the routing (§5c). Until then `bigquery-bigframes` is effectively untested, and its survivor is uninformative.
- **`provenance` at ~35% is still the corpus's weakest scenario.** It is stable enough not to inflate the floor, but a scenario that low has little room to drop and is a poor mutation instrument.
- **Whether a refusal-to-destroy should score as a selection miss.** Raised by the first session's `delete-branch`, unresolved. It affects the scorer, not this corpus.
- **`cloud-logging-query-generation` triggers on "our pods keep getting evicted at 3am"** — 10/10 on Haiku, 4/5 on `gpt-5.6-luna`. Its description claims "or when you are debugging issues", broad enough to capture unrelated work. A finding *about a shipped Google skill*, produced by the restraint scenario, reproducing across two providers, and the first real example of the output M5 exists to publish.
- **Pricing `automatic-prefix` as all-writes over-states by 3.2×** (§5b). Measured once, at one concurrency. Wants a second data point before the preflight's promise changes.
- **`datalineage-bigquery-asset-impact-analysis` is unreachable on Haiku and trivial on OpenAI.** Three symptom-phrased prompts built from its own trigger vocabulary scored 0–20% on `claude-haiku-4-5` and 100% on `gpt-5.6-luna`, and the one kept in the corpus swung 20%/60%/70% across three clean Haiku runs — always by declining to select, never by picking its neighbour. A second finding of the kind M5 publishes, and a sharper one than the `cloud-logging` over-trigger because the *direction* reverses by model. The scenario is dropped (§5c); the skill stays in the surface.
