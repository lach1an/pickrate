# Multi-provider — implementation plan

**Status:** actionable breakdown of [`multi-provider-plan.md`](multi-provider-plan.md), which carries the decisions and their reasoning
**Date:** 25 July 2026

---

## Progress, 25 July 2026

**Landed:** step 0 (truncation guard), step 1 (capabilities, two-axis cache, `contract.ts` split, conditional warm-up), step 2 in full (neutral usage, model table, per-model pricing with the long-context meter, report provenance at `SCHEMA_VERSION` 3), step 5 (docs). Corrections 0.1, 0.2, 0.4, 0.5 and 0.6 are all applied, and 0.3's bump-once-and-absorb-everything was taken as written. Tests: `truncation`, `capabilities`, `pricing`, `usage`, plus the widened refusal set in `compare` and the updated freeze in `schema` — 273 passing, all offline.

**Not started, and why:**

- **Step 0b — the number is still unmeasured.** `scripts/calibrate-tokens.ts` is written and runs up to the credential boundary, but it has never been executed, so `inspect`'s tokeniser error remains unquantified and its copy is unchanged. It also still assumes the counting endpoint is unmetered; verify that first.
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

**Changes**
- `scripts/calibrate-tokens.ts` — not a test. Loads each surface fixture, presents it, sends the same payload to each provider's counting endpoint, and prints local vs authoritative with the delta as a percentage. Needs a key; never runs in `npm test`.
- Depending on the result, one of: leave `TokenReport.approximate: true` and add the measured error to the copy; or carry a per-adapter correction factor (only if the error is consistent — a factor over a variable error is worse than the raw number).

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
| 0b | Counting endpoint, once per fixture | Cents. Verify the endpoint is unmetered first — it is assumed, not confirmed. |
| A/B | One scenario × 20 trials × 2 candidate tiers | The number that decides the default model. Do not skip to save it. |
| 3 | One full fixture run to record the OpenAI trials | One-off; everything downstream replays it offline. |
| 6b | Both regimes, both providers | The expensive one. `both` doubles a run before `mutate` multiplies it. |

Everything else is offline.
