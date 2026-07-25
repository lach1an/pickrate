# Multi-provider — implementation plan

**Status:** draft, not agreed
**Date:** 25 July 2026
**Implements:** [`mcp-eval-spec.md`](mcp-eval-spec.md) §7 "Later, if it has legs" — multi-model comparison, promoted ahead of M5
**Follows:** M4 (CI), complete

---

## 0. Why this moves ahead of the leaderboard

The spec files multi-model comparison after M5, as a nice-to-have. That ordering was right when M5 was a private validation exercise. It stopped being right when M5 became **the** distribution event.

M5 publishes a ranking of 20–30 well-known public servers. pickrate's entire pitch is *how much should you trust this report*. A ranking measured solely on `claude-haiku-4-5`, by a harness that only speaks one vendor's API, hands every badly-ranked server the one rebuttal that lands:

> You measured a model, not a surface — and you picked the model.

That is not a cheap shot, it is correct. Selection behaviour differs materially across models, so a single-provider harness measures a model×surface interaction and reports it as a property of the surface. The leaderboard would be publishing a confound as a finding, in the project whose differentiator is refusing to do exactly that.

**But this does not replace M5, and it does not come first.** The long pole in M5 is the *corpus* — hand-written scenario files for real servers, with the near-misses that make them worth anything. That work is provider-independent, it is the expensive human artifact, and once it exists, re-running it against a second model is nearly free. Building a second provider with nothing to point it at yields two providers and no findings.

So the sequence is: **corpus first, this before publishing, and cross-model disagreement as the headline instead of a ranking.** "This server is picked 94% by one model and 61% by another" is a better post than any ordering, it is a *delta* rather than an absolute — the same logic that drives the whole product — and it leaves no vendor to be accused of favouring.

---

## 1. What the seam already gets right, and the five places it leaks

Invariant 2 says only `src/provider/` imports a model SDK. That holds, and it bought a lot: adapters emit provider-neutral `ToolDeclaration`s and system text via `present()`, the scorer consumes `TrialResult` and nothing else, and the whole pipeline below the provider is already testable with no key.

The harder discipline is also already in place, mostly by accident of other work:

- `EvalReport.model` is reported prominently — the model under test is part of the result (spec §8.2).
- `diffReports` **refuses** a baseline recorded against a different model (M4 §1.3).
- `ReplayProvider` refuses trials recorded under a foreign presentation.

The codebase already treats "different model" as "different measurement". That is the expensive half.

What leaks is narrower than "the provider abstraction is wrong", and all five are worth fixing before a second implementation exists rather than after:

### 1.1 `TrialUsage` is Anthropic-shaped, and it lives in the frozen schema

`src/types.ts`:

```ts
export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;   // Anthropic's explicit cache write
  cacheReadInputTokens: number;
}
```

A provider with automatic prefix caching has no *write* to report — there is no breakpoint, nothing is deliberately created, and the API surfaces only a cached-read count. Reporting `cacheCreationInputTokens: 0` says "it cost nothing to populate the cache" when the truth is "this provider has no such concept". That is precisely the distinction `TokenReport.deferred` exists to preserve elsewhere, where the rule is already written down: *"your bodies cost nothing" and "we did not measure them" are different statements.*

This is the only leak that reaches the JSON schema, which M4 froze and shipped.

### 1.2 The runner's warm-up encodes one provider's cache semantics

`src/runner/index.ts:78` runs trial 1 alone before fanning out, because an Anthropic cache entry only becomes readable once the first response has returned. Under automatic prefix caching that serialisation buys nothing — and under a provider with no caching at all it is pure latency for no saving. The comment there is honest about *why*, which is what makes it visible now; it is simply in the wrong module.

### 1.3 Pricing assumes a single cache-read multiplier

`CACHE_READ_MULTIPLIER` is one global constant in `src/provider/pricing.ts`, applied in `estimateUsd`. Cached-input discounts differ by vendor and sometimes by model tier. One constant across two providers produces an estimate that is confidently wrong for one of them.

### 1.4 The preflight assumes a free, authoritative token count

`AnthropicProvider.estimate` calls `messages.countTokens` — a free endpoint that returns the real number for the real request. Not every provider has one. The fallback is a local tokeniser (`gpt-tokenizer` is already a dependency, used by the analyser), which makes the estimate an *approximation* rather than a measurement. That is acceptable, but the preflight copy currently reads as authoritative and would need to stop.

### 1.5 `CredentialError` names one vendor's environment variable

The message hardcodes `ANTHROPIC_API_KEY` and `ant auth login`. Fine today, actively misleading the moment a second provider can fail the same way.

---

## 2. Decisions that need making before code

### 2.1 The provider declares its caching; the runner asks

```ts
export type CacheStyle = 'explicit-breakpoint' | 'automatic-prefix' | 'none';

export interface ProviderCapabilities {
  cache: CacheStyle;
  /** Can it price a request before running it, authoritatively? */
  authoritativeTokenCount: boolean;
}
```

`Provider` gains `readonly capabilities: ProviderCapabilities`. The runner keeps warm-then-fan-out **only** for `explicit-breakpoint`, and says so in one place instead of assuming it everywhere.

The alternative — keep the warm-up unconditionally because it is harmless — is wrong in the direction that matters. It is not harmless: it serialises the first trial of every run, and on a provider that needs no warming it is a latency cost paid to protect a saving that does not exist. More to the point, an unexplained serialisation is exactly the kind of thing that gets deleted by someone who cannot see why it is there, on the provider where it *is* load-bearing.

### 2.2 Usage becomes provider-neutral without a schema bump

Make the two cache fields **optional**, omitted when the provider has no such concept, and keep the names:

```ts
export interface TrialUsage {
  inputTokens: number;
  outputTokens: number;
  /** Omitted entirely when the provider has no explicit cache write. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
```

No `SCHEMA_VERSION` bump, on the M3 precedent, which applies exactly: *a new command is an addition, and nothing pinned on 2 for `inspect`/`run` can break on a shape it has never seen.* A second provider's reports are likewise a shape no existing consumer has seen — every report in the wild today is Anthropic's and keeps all four keys, byte for byte.

This matters more than it did in M3. `SCHEMA_VERSION` 2 has now **shipped**, in `0.1.0`, behind an Action that pins it. This would be the first bump with a real cost, and it is avoidable.

Additive alongside it: `EvalReport.provider`, so a report says which vendor produced it without anyone parsing the model id. `test/schema.test.ts` extends to cover both.

Consequence to watch: `sumUsage`/`addUsage` in `pricing.ts` must treat absent as absent rather than coercing to zero, or the distinction is destroyed one line below where it was made.

### 2.3 Scores are per-model, never averaged or ranked across models

The same rule as mutation scores per adapter (spec §11.7), for the same reason. A pass rate under one model and another are two measurements of different things; a mean of them is a number with no referent. The report prints them side by side, never combined, and any leaderboard shows a row per model rather than an aggregate column.

**The delta is the finding, and it is not a ranking.** "94% here, 61% there" says the description is doing work for one model and not the other — actionable. "Average 77%" says nothing and invites optimisation against the average.

### 2.4 Parallel tool calls stay enabled

Some providers default to permitting several tool calls in one turn, and expose a switch to forbid it. Leave it at whatever the provider does by default, and **do not** force single-call mode for comparability.

Selection already passes only on *exactly one call, the expected one*, because over-eager tool calling is a real failure mode (M2). Forcing the API to prevent the model from over-calling would suppress the failure this metric exists to catch, and would report a surface as clean because the harness tied the model's hands. If two providers differ here, that difference is a result.

### 2.5 Strict / structured-output modes stay off

`toAnthropicTool` already declines `strict: true`, and says why: it rejects JSON Schema constructs common in real manifests, and it constrains generation. The same applies to any provider's schema-enforcement mode, with an extra edge — enforced arguments would inflate the *argument* pass rate toward 100% for reasons that have nothing to do with the manifest's quality. We measure what the model does with the schema as written.

### 2.6 No seeding, even where a provider offers one

Some providers expose a best-effort `seed`. Do not use it. The spec's "deterministic seeding where the provider allows it" was written before M2 established that **variance is the premise, not the noise** — every assertion is a pass rate over N trials precisely because selection is non-deterministic. A seeded run understates variance, and a seeded run compared against an unseeded one is not a comparison at all. Refusing it also keeps the two providers symmetrical, which is the entire point of the exercise.

### 2.7 The provider is inferred from the model id, with an override

`claude-*` → Anthropic, `gpt-*`/`o*` → OpenAI, and `--provider <id>` settles anything ambiguous. Exactly the shape `parseTarget` + `--adapter` already has, so there is one detection idiom in the codebase rather than two. An unrecognised model id is an error naming both providers — never a silent default, which would send a run to the wrong vendor and produce a credential error that names the wrong variable.

---

## 3. Module layout

Mirrors the adapter split, including the reason for the file split:

```
src/provider/contract.ts    Provider, ProviderCapabilities, CostEstimate   (interfaces only)
src/provider/index.ts       the registry: providerFor(model), --provider override
src/provider/anthropic.ts   unchanged except capabilities + neutral usage
src/provider/openai.ts      the new one — the ONLY place importing the OpenAI SDK
src/provider/pricing.ts     per-provider cache multipliers
```

`contract.ts` splits from `index.ts` for the same runtime-cycle reason as `src/adapters/contract.ts`: the registry imports every provider and every provider needs the interfaces, and one module is a cycle that typechecks and then throws at runtime. That trap has already been hit once in this codebase; do not hit it again.

---

## 4. CLI surface

```
--provider <id>     anthropic | openai — overrides detection from the model id
--models <a,b>      run the same config against several models (see §5)
```

`defaults.model` in the config stays a single id. `--models` is a run-level flag rather than a config key, because a stored config that silently runs two models doubles someone's bill on an invocation that looks identical to the one they costed.

---

## 5. Cross-model comparison — the actual deliverable

Everything above is plumbing for one output. `pickrate run config.yaml --models claude-haiku-4-5,gpt-…` runs the config once per model and reports them side by side:

```
  scenario                  claude-…    gpt-…      Δ
  create-branch                 100%      94%     −6%
  create-branch-colloquial       60%      91%    +31%   ← surface depends on the model
  no-tool-needed                100%      72%    −28%   ← restraint differs sharply
```

Three rules, all inherited rather than invented:

- **The Δ column is a diagnostic, not a score.** Neither model is the reference; the report names both and ranks neither.
- **A Δ below the noise floor is not a difference.** Same floor as `--baseline`, from `minNoise(trials)`, for the same reason — and here it has to be per-model, since the two runs can have different error rates.
- **Restraint deltas get read separately.** M3 already established that damage makes a model less willing to call anything, so restraint moves opposite to selection. A model that is simply more reluctant will look better on restraint and worse on selection, and averaging the two hides it.

This subsumes open question 3 in [`ci-plan.md`](ci-plan.md) — a standalone `pickrate compare` — since the machinery is the same and this has an actual use case behind it.

---

## 6. Tests — all offline

| Test | Asserts |
|---|---|
| `test/provider-registry.test.ts` | model id → provider detection; `--provider` overrides; an unknown id errors naming both |
| `test/capabilities.test.ts` | the runner warms only for `explicit-breakpoint`, and fans out immediately otherwise |
| `test/usage.test.ts` | absent cache fields stay absent through `sumUsage`, and a report from a non-caching provider omits rather than zeroes them |
| `test/schema.test.ts` (extend) | an Anthropic report keeps all four usage keys; `provider` is present on both; `SCHEMA_VERSION` stays 2 |
| `test/compare-models.test.ts` | the Δ table, the per-model noise floor, restraint read separately |

New fixture: `test/fixtures/trials/git-server-openai.json` — the same scenarios recorded against the second provider, so the cross-model path runs with no key. It should deliberately contain one scenario where the two models **disagree past the floor** and one where they differ **inside** it, so "a small difference is not a difference" is exercised by construction rather than by luck. Same discipline as the M4 baseline fixture.

---

## 7. Build order

Each step leaves the tree green and ships on its own. Steps 1–2 are worth doing **even if the OpenAI provider never lands**, because they are corrections to the existing seam.

| # | Step | Cost |
|---|---|---|
| 1 | `ProviderCapabilities`, runner asks instead of assumes, `contract.ts` split | offline |
| 2 | Neutral `TrialUsage`, `provider` on reports, per-provider cache pricing, credential copy | offline |
| 3 | `src/provider/openai.ts` + registry + detection | one live run to prove it |
| 4 | `--models`, the Δ report, the recorded fixture | offline after step 3 |
| 5 | README, CLAUDE.md invariants, spec §7 amendment | free |

---

## 8. Open questions

1. **Which OpenAI API surface — Chat Completions or Responses?** They differ in tool declaration shape and in what they report about caching. *This plan was written against a May 2026 knowledge cutoff and the surface moves quickly: confirm the current tool-call shape, the `tool_choice` values, the parallel-call default, and exactly which cached-token fields come back in `usage`, before writing step 3.* The decisions in §2 do not depend on the answer; the ~200 lines in step 3 do.
2. **Does the system prompt stay byte-identical across providers?** It has to, or the comparison has two variables. But `SYSTEM_PROMPT` was tuned thin for one model's behaviour, and "thin enough not to put a thumb on the scale" may not land identically elsewhere. Measure before assuming; if it has to differ, that fact belongs in the report next to the scores.
3. **Do local tokeniser estimates undermine the preflight's purpose?** The estimate exists so nobody discovers the cost after paying it. An approximation that is 20% low still serves that. One that is 3× low does not, and it would be worse than printing nothing.
4. **A third provider — is the registry the right shape, or does this want config?** Two providers justify a registry. Five would want the model→provider map to be data rather than code. Not a problem yet; worth not designing against.
