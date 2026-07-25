# Multi-provider — implementation plan

**Status:** draft, not agreed — **revised 25 July 2026** against [`multi-provider-research-findings.md`](multi-provider-research-findings.md)
**Date:** 25 July 2026
**Implements:** [`mcp-eval-spec.md`](mcp-eval-spec.md) §7 "Later, if it has legs" — multi-model comparison, promoted ahead of M5
**Follows:** M4 (CI), complete

> **Read the findings document alongside this one.** It resolved all four of this plan's original open questions and surfaced three things the plan did not account for, one of which is premise-level. This file has been rewritten to stand alone and correct; the findings doc carries the evidence and the sourcing.

---

## 0. Why this moves ahead of the leaderboard

The spec files multi-model comparison after M5, as a nice-to-have. That ordering was right when M5 was a private validation exercise. It stopped being right when M5 became **the** distribution event.

M5 publishes a ranking of 20–30 well-known public servers. pickrate's entire pitch is *how much should you trust this report*. A ranking measured solely on one vendor's model, by a harness that speaks one vendor's API, hands every badly-ranked server the one rebuttal that lands:

> You measured a model, not a surface — and you picked the model.

That is not a cheap shot, it is correct. Selection behaviour differs materially across models, so a single-provider harness measures a model×surface interaction and reports it as a property of the surface. The leaderboard would publish a confound as a finding, in the project whose differentiator is refusing to do exactly that.

**But this does not replace M5, and it does not come first.** The long pole in M5 is the *corpus* — hand-written scenario files for real servers, with the near-misses that make them worth anything. That work is provider-independent, it is the expensive human artifact, and once it exists, re-running it against a second model is nearly free. Building a second provider with nothing to point it at yields two providers and no findings.

So: **corpus first, this before publishing, and cross-model disagreement as the headline instead of a ranking.**

---

## 1. What the seam gets right, and the six places it leaks

Invariant 2 holds: only `src/provider/` imports a model SDK. It bought a lot — adapters emit neutral `ToolDeclaration`s, the scorer consumes `TrialResult` and nothing else, the whole pipeline below the provider is testable with no key.

The harder discipline is also already in place: `EvalReport.model` is reported prominently, `diffReports` refuses a baseline recorded against a different model, and `ReplayProvider` refuses trials recorded under a foreign presentation. **The codebase already treats "different model" as "different measurement".** That is the expensive half, and everything below is an extension of it rather than a fight with it.

### 1.1 `TrialUsage` is one vendor's cache model, and it is in the frozen schema

```ts
export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;   // an explicit cache *write*
  cacheReadInputTokens: number;
}
```

Some models have no cache write to report; some do but populate automatically; one current tier populates automatically **and** bills the write. Reporting `0` where the concept does not exist says "populating the cache was free" when it means "there is no such thing here" — the distinction `TokenReport.deferred` already exists to preserve.

The only leak that reaches the JSON schema M4 froze and shipped.

### 1.2 The runner's warm-up encodes one provider's cache semantics

`src/runner/index.ts:78` runs trial 1 alone before fanning out, because an explicit-breakpoint cache entry only becomes readable once the first response returns.

The findings sharpened this: under automatic prefix caching a first request still populates, **but there is a minimum prefix size (1024 tokens) below which nothing caches at all.** So the question the runner needs answered is not "does this provider cache" but **"will *this request* cache"** — which it can only know from the estimate. Warm-then-fan-out becomes conditional on population style *and* estimated prefix size, and a small manifest correctly skips the warm-up on both providers.

### 1.3 Pricing is unparameterised in the axis that actually varies

`CACHE_READ_MULTIPLIER` is one global constant. The findings show read multipliers happen to agree at 0.1× across every current tier, so this is **not urgent** — but that is luck, not design.

The unparameterised axis that does bite is the **write** multiplier, which the original plan did not mention: one provider bills writes at 1.25×, another bills them at zero, and a third tier of the *same* provider recently started billing them at 1.25×. Two further traps, both in §2.4 of the findings and both real:

- **The long-context meter.** Above 272K input tokens, a request bills at 2× input and 1.5× output *for the whole request*. pickrate's entire thesis is oversized manifests, and `inject-decoys` deliberately makes them bigger. **A large manifest plus decoys is precisely the shape that crosses this line, so the preflight would under-report by ~2× at the moment it matters most.**
- A regional-processing uplift of 10% on eligible recent models.

### 1.4 The preflight's problem is not the one the plan identified

The original plan assumed a second provider would lack a free authoritative token count and need a local tokeniser. **Wrong** — there is an endpoint that accepts the same payload including tools and returns the exact count. That leak dissolves.

It inverts into two worse things:

**a) M1's headline metric is an approximation of unquantified error.** The counting endpoint's documentation names, as a specific limitation of local tokenisers, that *tools and schemas add tokens that are hard to count locally* — which is exactly what the analyser does offline with `gpt-tokenizer`, and manifest token cost is `inspect`'s headline, the number that runs with no API key. The copy already says "approximate" and names the encoding, which is why this is a calibration job rather than an emergency — but the size of the error is currently unknown, and it is likely a consistent *under*-count. See step 0.

**b) The preflight can no longer bound spend.** Reasoning tokens bill as output, vary per trial, and on a model that treats effort as a ceiling rather than a floor they vary *unpredictably* — the same scenario may reason on one trial and not the next. `CostEstimate.estimatedUsd` becomes a lower bound rather than an estimate, and the cost confirmation is a load-bearing promise here ("nobody discovers the cost after paying it"). It has to say so rather than quietly understate. **The obvious mitigation — cap output tokens — collides head-on with §2.10, so it is not available.**

### 1.5 `CredentialError` names one vendor's environment variable

Hardcodes `ANTHROPIC_API_KEY` and `ant auth login`. Fine today, actively misleading the moment two providers can fail the same way.

### 1.6 A truncated response is scored as restraint — and this is live today

Not from the findings; found while checking them against the code, and it is the most urgent item in this document.

`src/provider/anthropic.ts:59` handles `stop_reason === 'refusal'` and nothing else. A response that hits `max_tokens` before emitting its `tool_use` block returns `calls: []`, and the scorer reads an empty call list as **correctly calling nothing**. On a restraint scenario that is a **false pass in the metric the project already identifies as the most neglected.**

This is the same failure the codebase already documents for `thinking: {type: "disabled"}` — *"tool calls arrive as visible text rather than tool_use blocks, which this harness would silently score as 'selected nothing' — a systematic error in the primary metric."* Truncation is a second road to that same wrong answer, and it is currently unguarded. Nothing in `src/` or `test/` mentions `max_tokens` outside the request itself.

Today it is unlikely: `max_tokens: 1024` with `effort: 'low'` leaves ample room. **A reasoning model makes it plausible**, because reasoning tokens consume that budget before any tool call is emitted. See §2.10.

---

## 2. Decisions

### 2.1 Capabilities hang off the **model**, not the provider, and cache is two axes

The original three-value `CacheStyle` enum assumed cache behaviour is a provider property. It is not — it varies by model *within* a provider, and no current provider sits cleanly in one value.

```ts
export interface CacheBehaviour {
  population: 'explicit-breakpoint' | 'automatic-prefix' | 'none';
  writesBilled: boolean;
  writeMultiplier?: number;
  readMultiplier: number;
  minimumPrefixTokens?: number;
}

export interface ModelCapabilities {
  cache: CacheBehaviour;
  toolSearch: 'supported' | 'unsupported';
  reasoning: 'none' | 'effort-scale';
}
```

So `Provider` exposes `capabilitiesFor(model): ModelCapabilities` rather than a `readonly capabilities`.

**Dropped:** `authoritativeTokenCount`. Both providers have one, so the flag has no false case, and a capability with no false case is a comment pretending to be code. Add it back when a provider without one exists.

### 2.2 Usage becomes neutral without a schema bump — rationale corrected

Make the cache fields **optional**, omitted where the concept does not exist:

```ts
export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  /** Omitted when this *model* has no such concept — not merely zero. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
```

The design stands; the plan's reasoning for it was wrong. Absence is **model**-scoped, not provider-scoped — one provider's newer tier does report cache writes while its older ones do not.

No `SCHEMA_VERSION` bump, on the M3 precedent: *a new command is an addition, and nothing pinned on 2 can break on a shape it has never seen.* A second provider's reports are likewise a shape no consumer has seen, and every report in the wild today keeps all four keys byte for byte. This matters more than it did in M3 — version 2 has now **shipped**, in `0.1.0`, behind an Action that pins it, so this would be the first bump with a real cost, and it is avoidable.

Watch `sumUsage`/`addUsage`: absent must stay absent rather than coercing to zero, or the distinction dies one line below where it was made.

### 2.3 The unit of comparison is model **+ reasoning config + loading regime**

Scores are never averaged across any of the three, for the reason mutation scores are never averaged across adapters (spec §11.7): they are measurements of different things, and a mean of them has no referent.

`EvalReport.model` alone no longer identifies a run — the same model at two reasoning efforts is two measurements. `diffReports` must refuse across differing reasoning configs and loading regimes exactly as it already refuses across models.

**The delta is the finding, and it is not a ranking.** "94% here, 61% there" says the description works for one model and not the other. "Average 77%" says nothing and invites optimising against the average.

### 2.4 Parallel tool calls stay at the provider default — **confirmed**

Research confirms the switch is a hard gate: disabling it "ensures exactly zero or one tool is called". That is exactly why it must stay on. Selection already passes only on *exactly one call, the expected one*, because over-eager tool calling is a real failure mode (M2). Making the API structurally incapable of over-calling would suppress the failure the metric exists to catch and report a surface as clean because the harness tied the model's hands.

### 2.5 Strict / structured-output modes stay off — unchanged

`toAnthropicTool` already declines `strict: true` and says why. The same applies to any schema-enforcement mode, with an extra edge: enforced arguments would push the *argument* pass rate toward 100% for reasons unrelated to the manifest's quality.

### 2.6 No seeding — strengthened

Some providers expose a best-effort seed. Do not use it. Variance is the premise, not the noise. The findings strengthen this: a model treating reasoning effort as a *ceiling* may reason on one trial and not the next, so a meaningful part of the variance is not seedable away at all. A seed would hide some of it and imply the rest was controlled.

### 2.7 Provider inferred from the model id — revised

`claude-*` → Anthropic, `gpt-*` → OpenAI, `--provider <id>` settles anything ambiguous. Same idiom as `parseTarget` + `--adapter`, so there is one detection pattern in the codebase. An unrecognised id errors naming both providers, never silently defaults.

Two corrections:

- `o*` is legacy and should not anchor detection.
- **Record the model id returned in the response, not the one sent.** Aliases route to a dated target, so a report that stores the requested id does not pin what actually ran.

This last one is a free upgrade to M4. `diffReports` currently *warns* when a baseline names an alias, because an alias can be re-pointed underneath it. If the report records what actually ran, an alias re-point surfaces as a **model mismatch**, which `diffReports` already **refuses**. A soft warning becomes a hard refusal at no cost — strictly better, and it retires the weakest part of the M4 baseline story.

### 2.8 Loading regime is the independent variable — **new**

Both providers now support deferred tool loading: the model gets a search tool, discovers what it needs, and loads only that. This is premise-level, because the founding claim is that a manifest sits in context in full.

It is more opportunity than threat. **Under tool search the description is what gets searched**, so a bad description means the tool is never loaded at all — a harder failure than being loaded and passed over. The thing pickrate measures gains importance.

The distinction against §2.4 is the crux and it is not a fudge:

- Parallel tool calls are **the model's behaviour given the surface** — the dependent variable. Forcing them off censors the outcome under observation.
- Tool search changes **what surface the model sees at all** — the independent variable. Leaving it at the provider default silently compares two regimes and blames the manifest.

So: `--tool-search on|off|both`, always recorded, **never left at the provider default**.

- **Eager (`off`) is the control**, and the mode cross-provider comparison runs in — the only one where a delta is attributable to the manifest rather than to two vendors' different retrievers.
- **Deferred (`on`) is the second measurement**, and the more interesting one. It does not remove description-based selection, it adds a **second round** of it: *retrieval* (does search surface this tool?) then *selection* (once loaded, is it called?).

Neither is the default. **The delta between them is the headline:** *"Eagerly loaded, 94%. Under tool search, 61% — retrieval never surfaces two of your tools."* A finding with an obvious fix attached, in the same delta-not-absolute shape as §2.3.

The author does not control which regime they are in — ship a server and some clients defer, some do not — which is the argument for reporting both rather than choosing.

**Consequences that reach other milestones:**

- **Retrieval and selection are scored separately**, like selection/arguments/restraint. A tool that retrieves reliably but is passed over is a different bug from one that never surfaces.
- **Namespace descriptions are a new authored artifact carrying a triggering burden, and nothing lints them anywhere.** They belong in the analyser (M1): presence, length against the "short and discriminative" guidance, and overlap between namespaces.
- **Token cost becomes a pair, not a number.** Eager cost versus deferred cost — arguably more useful than the single figure, but it does mean `inspect`'s headline needs an asterisk.
- **Mutation operators change meaning under deferral, so mutation scores are per-regime too.** `inject-decoys` assumes decoys bloat context; decoys that are never retrieved do nothing, so the operator's kill rate would fall for reasons that say nothing about harness sensitivity. `blank-description` should get *more* lethal, since an undescribed tool cannot be retrieved. Comparing a mutation score across regimes would read those two artefacts as a change in trustworthiness.
- **Cost.** `both` doubles a run, and `mutate` already costs `2 + n` runs. `mutate --tool-search both` is `2 × (2 + n)` and should require an explicit opt-in rather than being reachable by combining two innocuous flags.
- **The 49% → 74% selection-accuracy improvement attributed to tool search is an unverified vendor-adjacent claim about exactly the thing pickrate measures.** Independently checking it is a strong, specific, publishable M5 result.

### 2.9 Reasoning config is part of the measurement — **new**

Effort and mode go in `EvalReport`, in the presentation hash, and into `diffReports`' refusal set. Beyond identification, effort has two properties that matter here: it is a **ceiling not a floor**, so it is a variance source (§2.6), and its tokens **bill as output**, so it is a per-trial variable cost the preflight cannot bound (§1.4b).

### 2.10 A truncated response is an error, never restraint — **new, and fix this now**

Any finish reason indicating the model ran out of output budget must produce `TrialResult.error`, not an empty call list. Empty calls mean *the model chose to call nothing*; truncation means *we never found out what it chose*. Conflating them is a false pass in the most neglected metric (§1.6).

This is also why capping output tokens is not available as a cost control for reasoning models (§1.4b): a cap tight enough to bound spend is a cap that truncates, and a truncated trial is a discarded trial. Budget for reasoning generously and let the errored-trial rate — already gated by `maxErrorRate` since M4 — be the thing that says the run is unmeasurable.

### 2.11 Presentation hash replaces "byte-identical prompts" — **new**

Byte-identity was the original plan's control and it is not achievable: one API takes `instructions` where the other takes a system-role message, so the requests differ structurally before any wording question. It was also insufficient — reasoning config, reasoning mode and loading regime all move selection behaviour while the prompt bytes sit still, producing a comparison that *looks* controlled and is not.

Instead: hash the whole presentation — prompt text, tool declaration shape, reasoning config, tool-search state — record it per provider per run, and print it beside the score. `ReplayProvider` already refuses foreign presentations; widen what "presentation" covers rather than pretending two providers can be made identical.

---

## 3. Module layout

```
src/provider/contract.ts    Provider, ModelCapabilities, CacheBehaviour, CostEstimate
src/provider/index.ts       registry: providerFor(model), --provider override
src/provider/models.ts      the model table — data, not code (see below)
src/provider/anthropic.ts   + capabilities, neutral usage, truncation guard
src/provider/openai.ts      the new one — the ONLY place importing the OpenAI SDK
src/provider/pricing.ts     reads the model table; per-model read AND write multipliers
```

`contract.ts` splits from `index.ts` for the same runtime-cycle reason as `src/adapters/contract.ts`: the registry imports every provider and every provider needs the interfaces. That trap has been hit once in this codebase already.

**The model table is data from day one.** The findings settle the plan's original open question 4 in the split direction: the *registry* (id → provider) is two entries and stays code, but cache style, write billing, multipliers, long-context threshold, reasoning support and tool-search support all vary per model. A table keyed by model id costs nothing now and makes provider three a data edit.

---

## 4. CLI surface

```
--provider <id>          anthropic | openai — overrides detection from the model id
--models <a,b>           run the same config against several models
--tool-search on|off|both   loading regime; never defaults to the provider's default
--reasoning <effort>     where the model supports it; recorded in the report
```

`defaults.model` stays a single id in config. `--models` and `--tool-search both` are run-level flags rather than config keys, because a stored config that silently runs two models or two regimes doubles the bill on an invocation that looks identical to the one it was costed at.

---

## 5. Cross-model comparison — the deliverable

```
  scenario                  claude-…    gpt-…      Δ
  create-branch                 100%      94%     −6%
  create-branch-colloquial       60%      91%    +31%   ← surface depends on the model
  no-tool-needed                100%      72%    −28%   ← restraint differs sharply
```

Rules, all inherited rather than invented:

- **Δ is a diagnostic, not a score.** Neither model is the reference; both are named, neither is ranked.
- **A Δ below the noise floor is not a difference.** Same floor as `--baseline`, from `minNoise(trials)`, computed **per model** since error rates differ.
- **Restraint deltas are read separately.** M3 established that damage makes a model less willing to call anything, so restraint moves opposite to selection; a model that is merely more reluctant looks better on restraint and worse on selection, and a mean hides it.
- **Comparison runs eager** (§2.8), so a delta is attributable to the manifest rather than to two vendors' retrievers.

This subsumes `ci-plan.md`'s open question 3 (a standalone `pickrate compare`): same machinery, and now with a use case behind it.

---

## 6. Tests — all offline

| Test | Asserts |
|---|---|
| `test/provider-registry.test.ts` | id → provider; `--provider` overrides; unknown id errors naming both; `o*` is not treated as current |
| `test/capabilities.test.ts` | capabilities resolve per model, not per provider; the runner warms only for explicit-breakpoint **and** an estimated prefix over the minimum |
| `test/truncation.test.ts` | a truncated response is an error, **never** an empty call list — asserted against a restraint scenario, where the bug is a false pass |
| `test/usage.test.ts` | absent cache fields survive `sumUsage` as absent; a report from a model with no write concept omits rather than zeroes |
| `test/pricing.test.ts` | per-model write multipliers; the long-context meter fires above the threshold; a decoy-injected manifest is priced past it |
| `test/schema.test.ts` (extend) | an Anthropic report keeps all four usage keys; `provider`, reasoning config and loading regime are present; `SCHEMA_VERSION` stays 2 |
| `test/compare-models.test.ts` | the Δ table; per-model noise floor; restraint read separately |
| `test/tool-search.test.ts` | retrieval and selection scored separately; a tool that never retrieves is distinguishable from one retrieved and passed over |

New fixtures, both built so the interesting case is exercised by construction rather than by luck — the same discipline as M4's baseline fixture:

- `test/fixtures/trials/git-server-openai.json` — the same scenarios on the second provider, with one scenario where the models disagree **past** the floor and one where they differ **inside** it.
- `test/fixtures/trials/git-server-deferred.json` — a tool that retrieves but is passed over, and one that never surfaces.

---

## 7. Build order

Steps 0–2 are worth doing **even if the OpenAI provider never lands**: they are corrections to shipped code, not preparation for new code.

| # | Step | Cost |
|---|---|---|
| **0** | **Truncation guard (§2.10)** — a live false-pass in the primary metric | offline |
| 0b | Calibrate `gpt-tokenizer` against both authoritative counting endpoints on the fixtures; decide whether `inspect`'s headline is a measurement or an estimate | one call per fixture |
| 1 | `ModelCapabilities` per model, two-axis `CacheBehaviour`, `contract.ts` split, runner asks instead of assumes | offline |
| 2 | Neutral `TrialUsage`, `provider` + reasoning config on reports, model table, write multipliers, long-context meter, credential copy, resolved model id from the response | offline |
| 3 | `src/provider/openai.ts` (Responses API) + registry + detection | one live run |
| 4 | `--models`, the Δ report, the recorded fixture | offline after 3 |
| 5 | README, CLAUDE.md invariants, spec §7 amendment | free |
| **6** | **Deferred loading** — deliberately last, deliberately not cut | see below |

Step 6 needs 1–4 finished, since the eager/deferred delta is only trustworthy once the presentation hash covers loading regime:

| | Piece | Cost |
|---|---|---|
| 6a | Namespace-description linting in the analyser; eager vs deferred token cost reported separately | offline |
| 6b | `--tool-search` through both providers; retrieval and selection scored separately | live |
| 6c | The eager/deferred delta report + the deferred fixture | offline after 6b |

6a is worth doing on its own schedule: offline, no key, and namespace descriptions are currently unlinted by anything anywhere.

---

## 8. Open questions

The original four are resolved — see Part 1 of the findings. What remains:

1. **Does the preflight promise survive reasoning models?** (§1.4b) The cost confirmation exists so nobody discovers the cost after paying it, and reasoning tokens make the estimate a lower bound that cannot be tightened without §2.10's truncation risk. Options: present a range, label reasoning spend as unbounded, or measure typical reasoning overhead once and carry a factor. Needs one real run to decide, and it is a user-facing promise, so it should not be decided by default.
2. **Which second model is the right counterpart to a cheap Anthropic one?** Reasoning tokens bill as output at several times input, so a nominally cheap tier that reasons by default may not be cheap. **Cost one scenario at 20 trials before committing to a default.**
3. **Does the mutation loop want a regime at all, or does it stay eager forever?** (§2.8) Eager keeps mutation scores comparable across runs, which is the property that makes them worth anything — but a harness that can only detect damage under a regime half the ecosystem does not use is measuring the wrong thing. Probably eager-by-default with deferred as an explicit study, but this is not settled.
4. **Where does the retrieval score live in the report shape?** It is a third rate alongside selection and arguments, but only exists in one regime, and a `ScenarioScore` with a field that is meaningful half the time is the kind of thing that gets misread.

### Still to verify live, before step 3

1. Exact Responses tool-declaration shape against current SDK types — do not port the Chat Completions shape.
2. Whether the token-count endpoint is free and unmetered (assumed by analogy, unconfirmed).
3. Cache retention: sources conflict between ≥30 minutes and a 24-hour default. Nothing structural depends on it, but the runner's warm-cache assumptions across a long run do.
4. Whether `store` defaults on for Responses, and whether trials must set `store: false` for independence.
5. Whether the response returns a resolved dated model id for an alias on **both** providers (§2.7). The alias-to-refusal upgrade depends on it.
