# Multi-provider — implementation plan

**Status:** actionable breakdown of [`multi-provider-plan.md`](multi-provider-plan.md), which carries the decisions and their reasoning
**Date:** 25 July 2026

---

## Progress, 2 August 2026

**Both accounts are funded, the run happened, and A, B and 0b are all settled.** Total spend: **$0.23**. Three bugs fell out of it — one meant the harness's default model could not complete a single live trial, and the third was created by fixing the first.

### The bug the offline suite could never see

**`claude-haiku-4-5` is `reasoning: 'none'` in the model table, and `anthropic.ts` sent `output_config: { effort }` unconditionally.** Every trial returned `400 This model does not support the effort parameter` — 80 of 80, on `DEFAULT_MODEL`. `pickrate run` out of the box, with no flags, against the documented default, could not measure anything. 333 offline tests passed throughout, because no test ever built a request.

The OpenAI provider had gated this correctly since step 3 (`specFor(model)?.reasoning === 'effort-scale'`); the Anthropic one predated the model table and never went back for it. Both now derive it from one shared `reasoningFor(model)` in `prompt.ts` — shared for the invariant-2 reason, and used in **both** the request and `regime()`, because a report claiming `reasoning low` for a request that carried no effort parameter describes a regime that never ran. `regimeHash` now separates the two, which is correct and which changes the hash for every non-reasoning model.

`test/reasoning.test.ts` is the missing test, and the seam it needed: `requestFor` is now exported and pure on both providers, for the same reason `trialFrom` already was — *the parameters that vary by model are only assertable without a client, key or network*. Verified failing with the guard removed.

**The lesson is narrower than "test the request".** Everything the offline suite covers is downstream of a response. The request itself — the one artifact that is pure, cheap to assert, and the actual measurement instrument — had no coverage at all, so any per-model divergence between the table and what is sent was invisible by construction. `capabilitiesFor` and the request builder had disagreed since the table landed.

### The second bug: an alias loses its cost line

Correction 0.5 required that `costOf` *"fall back to the requested id when the resolved one has no price entry"*. It was specified, never implemented. The API resolves `claude-haiku-4-5` → `claude-haiku-4-5-20251001`, which has no table entry, so `costOfTrials` returned undefined and the run printed `no price on file for this model` — on the default model, i.e. on most runs. Fixed with a `pricingSpec(resolved, requested)` fallback that prefers the resolved id and never lets the alias override it.

### The third bug, which the first fix uncovered

Setting `DEFAULT_MODEL` removed an error that had been guarding something else by accident. `--provider openai` against a config whose `defaults.model` is a Claude id used to fail loudly with "no default model — pass `--model`"; with a default in place it silently sent `claude-haiku-4-5` to the Responses API, 400 on every trial. The provider default only applies when *no* model is named, and the config always names one.

`providerFor` now refuses the contradiction. The line it draws matters: **the table contradicts, the naming convention never does.** An id with a `MODELS` entry has a known owner and a flag cannot reassign it; a `gpt-6-unreleased` that matches only a prefix stays overridable, because that is the escape hatch `--provider` exists for and `test/provider-registry.test.ts` already asserted it. Refusing on a guess would have traded a real bug for a real regression.

### Decision A — `gpt-5.6-luna`, and the premise behind the question was wrong

One config (4 scenarios) × 20 trials × 3 models, on `test/fixtures/git-server.json`:

| model | cost | out tokens/trial (mean) | create-branch | colloquial | restraint | named |
|---|---|---|---|---|---|---|
| `claude-haiku-4-5` | $0.0965 | 71.5 | 100% | 100% | 100% | 50% |
| `gpt-5.6-luna` | **$0.0390** | 41.0 | 100% | 85% | 100% | 75% |
| `gpt-5.6-terra` | $0.0957 | 39.6 | 100% | 95% | 100% | 55% |

**The worry that framed the question — a nominally cheap tier that reasons by default may not be cheap — is measured and does not hold at `effort: low`.** Luna spent *fewer* output tokens per trial than the non-reasoning Anthropic default (41 vs 72) and cost 2.5× less for the identical run. At low effort on prompts this easy, these models largely do not reason, which is exactly the ceiling-not-floor behaviour §2.6 predicted.

**And paying more bought nothing.** Terra costs 2.45× luna and is *worse* on `create-branch-named` (55% vs 75%) while better on `create-branch-colloquial` (95% vs 85%). Tier price does not order selection accuracy — which is a small preview of the M5 result and an argument for the Δ-not-ranking framing in §5.

So the counterpart to a cheap Claude model is the tier that matches it on list price ($1/$6 against $1/$5). `DEFAULT_MODEL = 'gpt-5.6-luna'` now exists in `openai.ts`, `providerFor` no longer throws without `--model`, and `test/provider-registry.test.ts` asserts the id rather than the absence.

### Decision B — the preflight stays a promise, with a stated scope

The estimate came in **above** actual on all three models — $0.06 vs $0.039, $0.14 vs $0.096, $0.10 vs $0.097. It did not become a lower bound, so it does not become a range.

The 80-token output allowance is a good *mean* and not a bound: mean 41 (luna), 40 (terra), 72 (haiku), but 19 of 80 haiku trials exceeded 80 and the worst trial anywhere was 107. Since the allowance is multiplied across a whole run, the mean is the right statistic and the estimate absorbs the tail.

**Scope, stated because it is the whole value of the answer:** this is one surface, one prompt shape and `effort: low` — the only effort this harness sends. It says nothing about `high`, where reasoning is the dominant output term and §1.4b's concern returns intact. Revisit if `--reasoning` ever exposes the knob.

### Step 0b — answered, and the previously recorded numbers were measuring the wrong thing

**The 30 July table subtracted the wrong floor.** It costed each surface against a request with *no tools at all*, which books two fixed costs against the manifest: the provider's tool scaffolding, and — for skills — the dispatch tool and listing preamble the adapter adds no matter what. Both are constants. The tell was in the numbers as recorded: the Claude gaps were near-identical in absolute terms (567, 616, 580, 630 tokens) across surfaces of very different sizes, which is a constant wearing a percentage's clothing.

`scripts/calibrate-tokens.ts` now floors against the **envelope** — the same presentation with the manifest replaced by one minimal item of the same kind — and reports that envelope on its own:

| target | local | actual | delta | envelope |
|---|---|---|---|---|
| **`claude-haiku-4-5`** | | | | |
| `git-server.json` (MCP) | 227 | 288 | −21.2% | 506 |
| `messy-server.json` (MCP) | 273 | 383 | −28.7% | 506 |
| `skills/clean` | 82 | 91 | −9.9% | 571 |
| `skills/messy` | 314 | 373 | −15.8% | 571 |
| **`claude-opus-5`** | | | | |
| `git-server.json` (MCP) | 227 | 388 | −41.5% | 304 |
| `messy-server.json` (MCP) | 273 | 516 | −47.1% | 304 |
| `skills/clean` | 82 | 124 | −33.9% | 391 |
| `skills/messy` | 314 | 493 | −36.3% | 391 |
| **`gpt-5.6-luna`** | | | | |
| `git-server.json` (MCP) | 227 | 180 | +26.1% | 5 |
| `messy-server.json` (MCP) | 273 | 176 | +55.1% | 5 |
| `skills/clean` | 82 | 89 | −7.9% | 56 |
| `skills/messy` | 314 | 335 | −6.3% | 56 |

**The correction-factor answer is still "no", and now for a better-supported reason.** The error spans −47% to +55% and changes sign by *provider* as well as by adapter: OpenAI over-counts MCP by half, Anthropic under-counts everything, and the two Claude tokeniser generations differ from each other by ~20 points on the same surface. `TokenReport.approximate` stays.

**What did change is the direction of the Claude error, and the 30 July entry has it backwards.** With the wrong floor, skills looked like the catastrophic case (−87.6%); with the right one, skills are the *best* case on every model and MCP is the worse one. The 15–20% under-count the research predicted turns out to be about right for `claude-haiku-4-5` (−10% to −29%) and badly optimistic for `claude-opus-5` (−34% to −47%) — consistent with the newer tokeniser producing ~30% more tokens for the same bytes, which is a thing `inspect` cannot know offline because it never sees `--model`.

**The genuinely new finding is the envelope, and it is not small.** Being able to call tools at all costs 506–571 tokens on `claude-haiku-4-5` before any manifest exists. On `skills/clean` — 82 local tokens — the envelope is **seven times** the number `inspect` prints. It is a real cost on every request, it is invisible in the headline, and it is also *not the author's to fix*, which is the argument for reporting it separately rather than folding it in. Note it is not monotonic with the tokeniser: opus-5 counts more tokens per byte of manifest and has a **smaller** envelope, so the two cannot be collapsed into one figure.

**`inspect`'s copy still does not change.** It already says `approximate`, and the honest correction is not a factor but a second number (the envelope) — which is `TokenReport`'s shape question, not a copy question, and it lands with 6a's eager/deferred pair rather than on its own.

### Still to verify — item 5 answered, item 3 still open

- **Item 5, resolved model ids: the two providers differ.** Anthropic returns a dated snapshot for an alias (`claude-haiku-4-5-20251001`); OpenAI returns `gpt-5.6-luna` unchanged. So §2.7's alias-re-point-becomes-a-refusal upgrade is **real on Anthropic and inert on OpenAI**, where a re-pointed alias would still slide under a stored baseline. `isDatedSnapshot`'s warning is not retired; on OpenAI it is the only defence.
- **Item 3, cache retention:** untested. Every fixture surface is far below the 1024-token minimum prefix, so `0 cached` on all three runs is the expected result and confirms nothing. Still M5-corpus work, as recorded on 30 July.

### Recorded

`test/fixtures/trials/git-server-openai.json` — 80 luna trials (20 per scenario), replays cleanly against `test/fixtures/pickrate.yaml`. Step 4's Δ fixture wants scenarios that disagree past and inside the floor *by construction*; this is the real material to build that from, and it is now paid for.

---

## Progress, 30 July 2026

> **Superseded in part by 2 August.** The OpenAI rows below subtract a no-tools floor rather than an envelope, so they charge the adapter's fixed dispatch cost to the skills manifests; the skills deltas in particular are wrong (−43.4% and −19.7% here, −7.9% and −6.3% when measured against the envelope). The conclusion the entry draws — no correction factor — survives the correction.


**Step 3 has landed as code, and its calibration run has not happened — the account is out of quota.** `src/provider/openai.ts`, the `providerFor()` registry, `--provider`, the OpenAI rows in `MODELS`, and `--record` are all in, typechecked, and covered by 54 new offline assertions (327 passing, still no key needed). What is *not* settled is decisions A and B, because both need the run: `gpt-5.6-luna` and `gpt-5.6-terra` both return `429 exceeded your current quota`. The provider therefore ships **with no `DEFAULT_MODEL`** — `--provider openai` without `--model` is an error naming the candidates, on the grounds that a default picked to make the code compile becomes the model every published comparison quietly ran on.

**One sequencing correction to §1 below: "answer A and B first, then write the provider" is circular.** A/B is 20 trials through pickrate, which cannot run until a provider exists. The order is provider first (with no default chosen), then the run, then the default. Nothing in the landed code presumes an answer.

**Step 0b is half-answered, and the answer inverts the documented expectation.** The OpenAI counting endpoint is reachable *with zero quota* — unlike Anthropic's, where the balance check gates the whole API ahead of any per-endpoint billing — so the OpenAI half of the sweep ran today for nothing. `scripts/calibrate-tokens.ts` now sweeps both providers and skips an unreachable one rather than dying.

| target | local | actual (`gpt-5.6-luna`) | delta |
|---|---|---|---|
| `git-server.json` (MCP) | 227 | 185 | **+22.7%** |
| `messy-server.json` (MCP) | 273 | 181 | **+50.8%** |
| `skills/clean` | 82 | 145 | **−43.4%** |
| `skills/messy` | 314 | 391 | **−19.7%** |

**The research predicted a consistent 15–20% under-count. The measured error flips sign by adapter and spans −43% to +51%.** MCP surfaces over-count, skills surfaces under-count. And because `inspect` counts with `gpt-tokenizer` on `o200k_base` — an *OpenAI* tokeniser — measured against OpenAI's own counter, tokeniser mismatch is largely ruled out for these rows: the residual is per-declaration structural overhead, and it differs between the two adapters.

**So the correction-factor question resolves to "no", and it resolves independently of the missing Claude rows.** A single factor cannot correct an error that changes sign by adapter, and a per-adapter factor over an error this variable would look authoritative while being wrong — which is worse than the raw number. `TokenReport.approximate` stays. `inspect`'s copy is deliberately *not* changed yet: it already says `approximate`, the rows above are one provider, and the number matters most to Claude users whose two tokeniser generations are still unmeasured. Naming a magnitude in shipped copy on this evidence would over-claim.

**Still blocked on funding, and only on funding:** the Claude half of 0b, and decisions A and B. Both accounts are empty — Anthropic returns `400 credit balance is too low`, OpenAI `429 exceeded your current quota`.

**Verified live along the way** (the "Still to verify" list): item 1, the flattened `Responses.FunctionTool` shape, confirmed against the installed SDK's types *and* accepted by the counting endpoint. Item 2, free **and** usable at zero balance. Item 4 dissolved rather than verified — trials set `store: false` unconditionally, since pickrate never retrieves a response and storing every prompt of somebody else's manifest is not a default worth inheriting. Items 3 and 5 still need the paid run.

**Two corrections to shipped code found while doing this, both in the dangerous direction:**

- **`estimateRunUsd` ignored the minimum cacheable prefix.** Below it nothing caches, but the estimate priced trials 2..N as cache *reads* at 0.1×. On `claude-haiku-4-5`, whose 4096 minimum is the highest in the line-up, that under-stated a small-manifest run by close to 10× — and under-stating is the bill nobody agreed to. The fixture surfaces are 227–273 tokens, so this was every offline run.
- **The two providers report overlapping token buckets.** Anthropic's `input_tokens` *excludes* cached tokens; OpenAI's is the total, with `cached_tokens` and `cache_write_tokens` as subsets. `TrialUsage` is disjoint and `priceUsage` sums all three, so passing the raw numbers through would bill the cached prefix twice — at full rate and again at 0.1×. `test/openai-trial.test.ts` asserts the corrected mapping costs less than the naive one.

**One gap this opened:** `test/fixtures/trials/git-server-openai.json` does not exist, because the run that would record it did not happen. `--record` is in place so that when it does, step 4's offline Δ fixture comes out of the same spend rather than a second one.

**Cache behaviour cannot be verified on the current fixtures at all,** and that is a corpus problem rather than a funding one. Every fixture surface is 227–273 tokens, well under the 1024-token minimum prefix, so nothing caches and `cache_write_tokens` will read zero however much is spent. Confirming the 1.25× write multiplier — the one number in `MODELS` that is not on the public pricing table — needs a surface above 1024 tokens, which means M5's corpus.

---

## Progress, 25 July 2026

**Landed:** step 0 (truncation guard), step 1 (capabilities, two-axis cache, `contract.ts` split, conditional warm-up), step 2 in full (neutral usage, model table, per-model pricing with the long-context meter, report provenance at `SCHEMA_VERSION` 3), step 5 (docs). Corrections 0.1, 0.2, 0.4, 0.5 and 0.6 are all applied, and 0.3's bump-once-and-absorb-everything was taken as written. Tests: `truncation`, `capabilities`, `pricing`, `usage`, plus the widened refusal set in `compare` and the updated freeze in `schema` — 273 passing, all offline.

**Not started, and why:**

- **Step 0b — the number is still unmeasured, and the blocker is credentials, not budget.** `scripts/calibrate-tokens.ts` runs up to the credential boundary and stops there; no key is configured on the dev machine (no `ANTHROPIC_API_KEY`, no `ant` profile). Its copy is unchanged. The metering question is now settled — the endpoint is **free** and separately rate-limited — so the only thing between this step and an answer is a key: `npx tsx scripts/calibrate-tokens.ts`.
- **Steps 3 and 4** are gated on decisions A and B, which cost one calibration run to settle and were deliberately not guessed. Nothing in the landed work presumes an answer: `providerFor()` does not exist, and `src/cli.ts` still constructs `AnthropicProvider` directly at both call sites.
- **Step 6** needs 1–4. Note that 6a (namespace linting) is listed as independent, but a namespace is not a concept the `Surface` model has yet — inventing one before `--tool-search` exists would be guessing at the shape the regime will actually take.

**One deviation worth knowing about.** `mutate` does not pass its preflight estimate to the runner, so it always warms. A decoy-injected mutant is *larger* than the clean surface it was costed against, so a single estimate cannot decide the warm-up for every run in the session — and skipping a warm-up that was needed is the expensive mistake. `run` passes its estimate; `mutate` takes the safe default.

**Also worth knowing:** no current Claude model has a long-context meter — the 1M window bills at one rate. The meter is implemented and tested against a constructed spec anyway, per §2c's reasoning, and `MODELS` carries no `longContext` entry today.
**Reads with:** [`multi-provider-research-findings.md`](multi-provider-research-findings.md) for evidence and sourcing

The design document argues *what* and *why*. This one is *where, in what order, and how you know it worked*. Every step names the files it touches, the tests that must exist before it counts as done, and what it costs to run. Section references like §2.10 point at the design document.

---

## 0. Six corrections to the design document, found in the code

Checking the plan against `src/` turned up things it either got wrong or did not know. These change the work, so they come first.

**0.1 — `estimateUsd` never applies the cache-write multiplier.** `src/provider/pricing.ts:28` exports `CACHE_WRITE_MULTIPLIER = 1.25`, and `costOf` uses it. But `estimateUsd` (`src/provider/anthropic.ts:246`) prices the warm-up trial as `freshShare = inputTokensPerTrial` at plain input rate. On the current provider the first trial writes the cache and bills at 1.25×, so the preflight already under-reports — by one trial's worth, which on a 34k-token manifest is small but is the same class of error §1.3 warns about. Fold this into step 2 rather than treating it as new work.

**0.2 — the write multiplier is unparameterised in `costOf` too, not just at the top level.** `costOf` takes a model id and reaches for two module-level constants. Once the model table exists both multipliers must come from it, and `costOf`'s signature stays the same — the table lookup happens inside.

**0.3 — the compatibility window is open right now, and it closes. Take every break at once.** The design document's §2.2 argues against a `SCHEMA_VERSION` bump on the grounds that *"version 2 has now shipped, in `0.1.0`, behind an Action that pins it, so this would be the first bump with a real cost."* Both halves are wrong as of today:

- `0.1.0` published at **16:40 UTC on 25 July 2026** — hours, not weeks. `npm view pickrate` shows `0.0.0` and `0.1.0` and nothing else.
- **The Action does not pin it.** `grep -rn schemaVersion action.yml .github/ examples/ README.md` returns nothing; `SCHEMA_VERSION` is read only by `src/report/json.ts` and `test/schema.test.ts`. No shipped consumer reads the field at all.

So the plan's careful additive-only discipline is buying protection for consumers who do not exist. This is the same position version 2 was in before it shipped, and CLAUDE.md records what was done then: *"Version 2 has not shipped, so it absorbed the whole adapter split."* Do that again — **bump to 3 once, absorb everything breaking, and stop arguing additive-vs-breaking per field.**

What this dissolves: the three-valued absent/equal/different rule for baseline provenance. `provider`, `reasoning`, `toolSearch` and `regimeHash` become **required** on a run report, `diffReports` refuses on mismatch exactly as it already does for `model`, and `test/fixtures/reports/git-server-baseline.json` is regenerated with the new keys rather than being treated as a legacy shape to tolerate forever.

The window is measured in weeks at most. Anything deferred past it costs a second bump.

**0.4 — the presentation hash must cover the envelope and never the surface content.** §2.11 says to hash "prompt text, tool declaration shape, reasoning config, tool-search state". Taken literally as *hashing the declarations*, it breaks `mutate`: every mutant is a different surface by construction, so every mutant would carry a different hash and nothing would be comparable to the baseline. Split it explicitly:

- **`regimeHash`** — system prompt bytes, declaration *envelope* (which structural form the tools take, not their content), reasoning config, tool-search state, provider. Constant across a mutation session. This is what `diffReports` refuses on and what `ReplayProvider` checks.
- The surface itself is already identified by `source` and already varies per mutant. It stays out of the hash.

Without this split, step 1 lands and `mutate` stops working.

**0.5 — recording the resolved model id needs a place to put it.** §2.7 wants the id from the response, not the request. `runEval` reads `provider.model` *after* every trial resolves (`src/runner/index.ts:103`), so a `resolvedModel` field the provider populates on first response is safe to read there — no race, because the runner reads it after `await`ing everything. Two details the plan does not cover: `costOf` must fall back to the requested id when the resolved one has no price entry (a dated snapshot will not be in `PRICES` while the alias is), and if two trials report *different* resolved ids the run must say so — that is an alias re-point mid-run, which is exactly the thing this feature exists to catch.

**0.6 — `Provider` currently lives in `src/provider/index.ts` and `anthropic.ts` imports it from there.** There is no cycle today only because `index.ts` imports no provider. The moment `providerFor()` lands in `index.ts`, there is one. The `contract.ts` split is not tidying; it is the step-3 blocker, and it is cheap to do at step 1.

Also drive-by while touching `src/runner/index.ts:82,88`: `provider.runTrial(presentation,first.scenario)` is missing a space after the comma in both call sites.

---

## 1. Decisions needed before step 3

Steps 0–2 are unblocked. These three are not, and two of them cost money to answer.

| # | Question | How to settle it | Blocks |
|---|---|---|---|
| A | Which second model? (design §8 q2) | One scenario × 20 trials on two candidate tiers, priced. A tier that reasons by default may not be the cheap one. | step 3 |
| B | Does the preflight stay a promise or become a range? (§1.4b, §8 q1) | Falls out of A's run: record actual output tokens per trial against the 80-token allowance. If the ratio is stable, carry a factor; if not, present a range and say why. | step 3's copy |
| C | Where does the retrieval score live? (§8 q4) | Design decision, no spend. Recommend a separate `RetrievalRate` on `ScenarioScore`, present only under `--tool-search on`, rather than a nullable third rate — a field meaningful half the time gets misread. | step 6 only |

A and B are one run and answer each other. Do them as the first thing in step 3, before writing the provider.

> **A and B are settled — see the 2 August entry.** A is `gpt-5.6-luna`; B stays a promise, scoped to `effort: low`. C is still open and still costs nothing. The sequencing note above stands corrected too: the run needed the provider to exist first.

---

## 2. Work items

### Step 0 — truncation guard *(offline, no spend, do this first)*

The live false pass. `src/provider/anthropic.ts:59` handles `refusal` and nothing else; a response that exhausts its output budget before emitting `tool_use` returns `calls: []`, which the scorer reads as correct restraint.

**Changes**
- `src/provider/anthropic.ts` — extend the pre-content guard to any finish reason meaning "ran out of output budget", returning `error` set and `calls: []`. Keep the two branches separate in the code even though they return the same shape: refusal and truncation are different facts and the message must say which.
- Nothing else. The scorer already excludes errored trials from the denominator (`src/scorer/index.ts:77`), so once the trial is marked, the rest is correct by construction.

**Test** — `test/truncation.test.ts`. Drive a stub provider response with a max-tokens finish reason **against a restraint scenario** (`expect.tool: null`), and assert the scenario's `errors` is 1 and its selection rate does not count it as a pass. Asserting it on a normal scenario would pass even with the bug present, which is why the fixture has to be a restraint one.

**Done when** the test fails with the guard removed. Check that.

---

### Step 0b — tokeniser calibration *(one API call per fixture, ~cents)*

`inspect`'s headline number is `gpt-tokenizer` output, offline, and the counting endpoint's own documentation names tool schemas as the thing local tokenisers get wrong. The error is probably a consistent under-count and is currently unquantified.

**Verified, 28 July 2026 — the endpoint is free, not "cents".** The counting endpoint's docs say so in as many words: *"Token counting is free to use but subject to requests per minute rate limits"* (2,000 RPM on Start), and *"Token counting and message creation have separate and independent rate limits."* So this step costs nothing and cannot eat into a run's budget. The assumption in §4 is discharged.

**But free is not the same as usable on a zero balance — attempted 29 July 2026 and refused.** With a valid key the counting endpoint still returns `400 invalid_request_error`: *"Your credit balance is too low to access the Anthropic API."* The balance check gates access to the API as a whole, ahead of any per-endpoint billing, so an unfunded account cannot run this step even though the step is free. The key itself was fine — an invalid one fails `401`, not `400`. Budget a minimum top-up for the account before step 0b, not because 0b spends anything but because nothing works below the line.

**Also verified, and it changes what the script has to measure: there are two tokenisers.** Claude 4.7 introduced a new one producing ~30% more tokens for the same text, and everything since is on it — while `DEFAULT_MODEL` (`claude-haiku-4-5`) is not. `inspect` never makes a model call and never sees `--model`, so a single offline number cannot be right for both generations. The script now sweeps one model from each (`PICKRATE_MODELS` overrides) rather than measuring `DEFAULT_MODEL` alone, which would have written down a figure wrong by about a third for half the line-up.

**The direction is already documented.** The counting endpoint's guidance is explicit that OpenAI tokenisers are wrong for Claude — an under-count of roughly 15–20% on ordinary text and materially worse on code, which is the class tool schemas fall into. That is the direction and rough size; what the run buys is the *actual* figure for these fixtures and whether it is stable enough to correct for.

**Changes**
- `scripts/calibrate-tokens.ts` — not a test. Loads each surface fixture, presents it, sends the same payload to each provider's counting endpoint, and prints local vs authoritative with the delta as a percentage, per tokeniser generation. Needs a key; never runs in `npm test`.
- Depending on the result, one of: leave `TokenReport.approximate: true` and add the measured error to the copy; or carry a per-adapter correction factor (only if the error is consistent *across both generations* — a factor over a variable error is worse than the raw number, and a factor that is right for one tokeniser and wrong for the other is worse still).

**Done when** the number is written down in this file and `inspect`'s copy either states the error or explains why it does not need to.

---

### Step 1 — capabilities, cache as two axes, the contract split *(offline)*

**Changes**
- `src/provider/contract.ts` — new. Moves `Provider`, `CostEstimate` out of `index.ts`; adds `CacheBehaviour` and `ModelCapabilities` exactly as §2.1 declares them. `index.ts` re-exports so existing imports keep working, then the imports get updated. Header comment: same runtime-cycle reason as `src/adapters/contract.ts`, which this codebase has already been bitten by once.
- `Provider` gains `capabilitiesFor(model): ModelCapabilities` (per §2.1 — a method, not a `readonly capabilities`, because cache behaviour varies by model within a provider).
- `src/runner/index.ts` — the warm-up becomes conditional. It runs only when `capabilities.cache.population === 'explicit-breakpoint'` **and** the estimated prefix exceeds `minimumPrefixTokens`. The runner needs the estimate to decide, which it does not currently have; pass the `CostEstimate` in through `RunOptions` (the CLI already computed it at `src/cli.ts:259`, so this is plumbing, not a new call). No estimate available → warm as today, which is the safe default.
- `src/provider/replay.ts` — declare capabilities with `population: 'none'` so replay skips the warm-up, which it should always have done.

**Tests** — `test/capabilities.test.ts`: capabilities resolve per model rather than per provider; the runner warms for explicit-breakpoint over the minimum; it **skips** for automatic-prefix; it **skips** for a small manifest under `minimumPrefixTokens` on both. That last case is the one the design document calls out as newly correct behaviour, so assert it directly.

---

### Step 2 — neutral usage, the model table, pricing, report fields *(offline)*

The largest step. Split into four commits.

**2a — `TrialUsage` goes optional.** `src/types.ts:280` — cache fields become optional per §2.2, with the comment saying *omitted when the model has no such concept, not merely zero*. Then chase every consumer: `EMPTY_USAGE`, `addUsage`, `sumUsage`, `costOf` in `src/provider/pricing.ts`; the catch-all in `src/provider/anthropic.ts:84` that currently builds a zeroed four-key usage. **`addUsage` is the one that matters** — absent + absent must stay absent, absent + present must be present. Coercing to zero anywhere kills the distinction one line below where it was made.

The fields stay **optional rather than always-present**, and note that this is now a semantic choice and nothing else: absence means *this model has no such concept*, presence-at-zero means *it has one and it was free*. That distinction is the point (it is what `TokenReport.deferred` exists to preserve elsewhere), and it survives independently of any compatibility argument.

`SCHEMA_VERSION` **bumps to 3** here — see 0.3. Not because this change requires it, but because the bump is free today and this is the commit that opens it. Everything else breaking in step 2 rides along.

**2b — the model table.** `src/provider/models.ts` — data, not code. Keyed by model id: provider, input/output price, cache behaviour (population, writes billed, write and read multipliers, minimum prefix), long-context threshold and its input/output multipliers, regional uplift, reasoning support, tool-search support. `PRICES` in `src/provider/pricing.ts` folds into it; `PRICES` stays exported as a derived view so nothing outside breaks.

**2c — pricing.** `costOf` and `estimateUsd` both read multipliers from the table instead of the module constants (fixes 0.1 and 0.2). Add the long-context meter: above the model's threshold, the *whole request* bills at the elevated multipliers. §1.3 is right that this is the trap that bites — pickrate exists to measure oversized manifests and `inject-decoys` deliberately makes them bigger, so the estimate would under-report by ~2× at exactly the moment it matters.

**Test** — `test/pricing.test.ts`: per-model write multipliers, including the model that bills writes at zero; the long-context meter fires above the threshold and not below; **a decoy-injected manifest is priced past it** (construct the case rather than hoping a fixture crosses the line); the preflight's warm-up trial is priced at the write multiplier.

**2d — report fields and copy.** `EvalReport` gains `provider`, `reasoning` (effort and mode), `toolSearch` and `regimeHash` (per 0.4) as **required** fields, and `model` becomes the resolved id per §2.7 and 0.5. `src/report/json.ts` emits them; `src/ci/compare.ts` refuses on any of them mismatching, the same way it already refuses on `model`; `test/schema.test.ts` updates its exact key sets and asserts `SCHEMA_VERSION` is 3. Regenerate `test/fixtures/reports/git-server-baseline.json` with the new keys — keeping its hand-tuned comparison cases, which are the reason it exists. `CredentialError` in `src/provider/anthropic.ts:177` stops naming one vendor's env var — the message comes from the provider that failed.

**The free M4 upgrade lands here.** Once the report stores what actually ran, an alias re-point surfaces as a model mismatch, which `diffReports` already refuses. Delete nothing — `isDatedSnapshot`'s warning still applies to a *baseline* recorded before this change — but the warning stops being the only defence.

**Test** — `test/usage.test.ts` (absent survives `sumUsage`; a no-write-concept model omits rather than zeroes) and extend `test/compare.test.ts` for the widened refusal set: a baseline differing in provider, reasoning config or regime hash is refused, not warned.

---

### Step 3 — the OpenAI provider *(one live run, plus decision A's run)*

Answer A and B first (§1 above). Then:

**Changes**
- `src/provider/openai.ts` — the only file importing the OpenAI SDK. Responses API. Before writing it, verify the four live items in the design document's "Still to verify" list — particularly the tool-declaration shape against current SDK types (do **not** port the Chat Completions shape) and whether `store` defaults on, which would make trials non-independent.
- `src/provider/index.ts` — `providerFor(model)`: `claude-*` → Anthropic, `gpt-*` → OpenAI, `--provider` overrides, unknown id errors naming both and never silently defaults. `o*` is legacy and must not anchor detection. Same idiom as `parseTarget` + `--adapter`, deliberately.
- `src/cli.ts:251,332` — both hardcode `new AnthropicProvider(...)`. Route through the registry.
- Truncation guard (step 0) and the reasoning-token consequence (§2.10): budget output generously and let `maxErrorRate` be what says the run is unmeasurable. Do not cap output to control cost — a cap tight enough to bound spend is a cap that truncates.

**Test** — `test/provider-registry.test.ts`: detection both ways; `--provider` overrides; unknown errors naming both; `o*` is not treated as current.

**Spend** — decision A's calibration run, plus one full fixture run to record `test/fixtures/trials/git-server-openai.json`. Budget it, do not eyeball it.

---

### Step 4 — `--models` and the Δ report *(offline after step 3)*

**Changes**
- `src/cli.ts` — `--models <a,b>`, `--reasoning <effort>`, `--provider <id>`. Run-level flags, never config keys (§4): a stored config that silently runs two models doubles a bill on an invocation that looks identical to the one it was costed at. The cost confirmation must sum across models before it asks.
- `src/ci/compare.ts` or a sibling — the Δ table. Reuses `diffReports`' floor machinery, but the floor is computed **per model**, since error rates differ. Restraint scenarios are listed separately, not folded into the table's ordering: M3 established that restraint moves opposite to selection, so a model that is merely more reluctant reads as better on restraint and worse on selection.
- `--out` with `--models` writes one payload with `command: "compare"` carrying the per-model reports. Additive, so no bump. Do not write N files with mangled names.

Neither model is a reference and neither is ranked — Δ is a diagnostic. This subsumes `ci-plan.md`'s open question 3.

**Test** — `test/compare-models.test.ts`: the Δ table; per-model noise floor; restraint read separately. The new fixture `test/fixtures/trials/git-server-openai.json` is built so one scenario disagrees **past** the floor and one **inside** it — by construction, the way M4's baseline fixture is, not by luck.

---

### Step 5 — documentation *(free)*

README, `CLAUDE.md` invariants (invariant 2 now says "only `src/provider/` imports *a* model SDK, and each provider imports exactly one"), spec §7 amendment. Add to the measurement decisions: the unit of comparison is model + reasoning config + loading regime, and scores are never averaged across any of the three.

---

### Step 6 — deferred loading *(last, deliberately not cut)*

Needs 1–4 finished, because the eager/deferred delta is only trustworthy once `regimeHash` covers the loading regime.

**6a — analyser, offline, no key, worth doing on its own schedule.** Namespace descriptions are a new authored artifact carrying a triggering burden and **nothing lints them anywhere**. New rules in `src/analyser/rules/` (grouped by theme, registered in `rules/index.ts`, thresholds as exported named constants — mirror the existing layout exactly): presence, length against the "short and discriminative" guidance, overlap between namespaces. `TokenReport` gains an eager/deferred pair, which means `inspect`'s headline needs an asterisk.

**6b — `--tool-search on|off|both` through both providers, live.** Never left at the provider default — that is the distinction against §2.4 and it is the crux: parallel tool calling is the model's behaviour given the surface (the dependent variable, censoring it hides the failure the metric exists to catch), while tool search changes what surface the model sees at all (the independent variable, leaving it defaulted compares two regimes and blames the manifest). Retrieval and selection score separately per decision C.

`mutate --tool-search both` is `2 × (2 + n)` runs and must require an explicit opt-in — not reachable by combining two innocuous flags.

**6c — the delta report and `test/fixtures/trials/git-server-deferred.json`,** built with a tool that retrieves but is passed over and one that never surfaces. Test: `test/tool-search.test.ts` — the two are distinguishable, which is the whole point of scoring retrieval separately.

**Carry into M3's documentation:** mutation operators change meaning under deferral (`inject-decoys` weakens, `blank-description` gets more lethal), so mutation scores are per-regime and never compared across regimes — the same structural rule as per-adapter. Whether `mutate` gets a regime flag at all is design §8 q3 and stays open; eager-by-default is the working assumption because it keeps mutation scores comparable, which is the property that makes them worth anything.

---

## 3. Sequencing

```
0  truncation guard ────────────────┐  ships alone, fixes a live bug
0b calibration ─────────────────────┤  independent, one call per fixture
1  capabilities + contract split ───┤
2  usage, table, pricing, fields ───┤  2 needs 1's contract split
                                    │
   decision A/B (one live run) ─────┤
3  openai.ts + registry ────────────┤  needs 1, 2, A
4  --models + Δ report ─────────────┤  needs 3
5  docs ────────────────────────────┘
6a namespace linting ──────────────── independent of everything above
6b/6c deferred loading ───────────── needs 1–4
```

Steps 0, 0b, 1, 2 and 6a are worth doing **even if the OpenAI provider never lands** — they are corrections to shipped code and a gap in the analyser, not preparation for new code. If this stalls after step 2, the codebase is strictly better than it is now.

The gating constraint on the whole thing remains the design document's §0: **the M5 corpus comes first.** Building a second provider with nothing to point it at yields two providers and no findings.

## 4. Spend

| Step | What | Rough shape |
|---|---|---|
| 0b | Counting endpoint, twice per fixture (one model per tokeniser generation) | **Free — confirmed 28 July 2026**, and rate-limited separately from message creation, so it cannot eat a run's budget. Eight requests against a 2,000 RPM floor. |
| A/B | One scenario × 20 trials × 2 candidate tiers | The number that decides the default model. Do not skip to save it. |
| 3 | One full fixture run to record the OpenAI trials | One-off; everything downstream replays it offline. |
| 6b | Both regimes, both providers | The expensive one. `both` doubles a run before `mutate` multiplies it. |

Everything else is offline.
