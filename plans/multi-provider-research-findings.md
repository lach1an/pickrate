# Multi-provider — research findings

**Date:** 25 July 2026
**Amends:** `multi-provider-plan.md` §8 (open questions) and §2 (decisions)
**Method:** current-source research, July 2026. Everything below post-dates the plan's May 2026 knowledge cutoff.

---

## Summary

Four open questions: **two resolved outright, one resolved in the opposite direction to the plan's framing, one dissolved by a finding elsewhere.**

Three things surfaced that the plan does not account for, in descending order of how much they hurt:

1. **Tool search / deferred loading** now exists on *both* providers. The premise that a manifest sits wholly in context is no longer unconditionally true.
2. **Reasoning effort is part of the measurement**, not a provider detail. `EvalReport.model` is insufficient to identify a run.
3. **Cache style is a per-model property, not a per-provider one.** This breaks the shape of `ProviderCapabilities` as designed in §2.1.

---

## Part 1 — Answers to the open questions

### 8.1 Chat Completions or Responses? → **Responses, and it is forced, not preferred**

Not a judgement call. Current models reject the combination the harness needs:

> `400 Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`

GPT-5.6 reasons by default, so this fires even when no effort is set explicitly. Attaching any function tool to a plain Chat Completions request 400s. The only opt-out is forcing `reasoning.effort: 'none'` — which, per §2.5's logic, would be putting a thumb on the scale rather than measuring the model as it ships.

OpenAI's own guidance says to use Responses for reasoning, tool-calling and multi-turn work, and `tool_search` (see Part 2) is Responses-only.

**Answered sub-questions:**

| | Finding |
|---|---|
| Tool declaration shape | Differs from Chat Completions — flattened rather than nested under `function`. **Confirm against SDK types before writing step 3; do not port the Chat Completions shape.** |
| `tool_choice` | `auto`, `required`, `none`, or a named function. Applies to currently-callable tools when tool search is active. |
| Parallel-call default | Enabled. `parallel_tool_calls: false` "ensures exactly zero or one tool is called" — i.e. it is a hard gate, which is precisely why §2.4 is right to leave it alone. |
| Cached-token fields | Responses returns `cached_tokens` in `usage.input_tokens_details`. (Chat Completions puts it in `usage.prompt_tokens_details` — irrelevant now.) GPT-5.6+ additionally reports `cache_write_tokens`. |

### 8.2 Byte-identical system prompt? → **Not achievable, and it was the wrong invariant**

The Responses API takes `instructions` rather than a system-role message, so the two requests are structurally different before any wording question arises. Byte-identity is off the table.

More importantly it was never sufficient. As of Part 2 the request carries at least three other variables that move selection behaviour: reasoning effort, reasoning mode, and whether tool search is active. Holding the prompt bytes constant while those drift produces a comparison that *looks* controlled and isn't.

**Replacement invariant:** record a **presentation hash** per provider per run — prompt text, tool declaration shape, reasoning config, tool-search state — and print it in the report next to the score. `ReplayProvider` already refuses trials recorded under a foreign presentation; widen what "presentation" covers rather than pretending the two can be made identical.

### 8.3 Do local tokeniser estimates undermine the preflight? → **Moot. OpenAI has an authoritative endpoint — and the real problem is elsewhere**

There is an input-token-count endpoint that accepts the same payload as Responses, **including tools**, and returns the exact count the model will receive.

So `authoritativeTokenCount: true` on both providers, the fallback path is unnecessary, and the preflight copy stays honest. The capability flag proposed in §2.1 has no current false case — keep it if a future provider needs it, but it earns nothing today.

**The finding that matters is the inversion.** OpenAI's own documentation gives, as a specific limitation of local tokenisers: *tools and schemas add tokens that are hard to count locally.*

That is exactly what the M1 analyser does offline with `gpt-tokenizer` — and manifest token cost is its headline metric, the one that runs with no API key. It is therefore an approximation of unquantified error, currently presented as a measurement.

**This reaches past this plan into M1 and should be handled there:**
- Calibrate: run both endpoints against the fixture manifests, quantify the local error.
- If small and consistent, keep the offline number and state the method.
- If not, `inspect` reports an estimate and offers `--exact` to spend one free API call.
- Either way the distinction is the same one `TokenReport.deferred` already encodes: *approximated* and *measured* are different statements.

### 8.4 Third provider — registry or config? → **Split it. Registry in code, model table in data, starting now**

Part 2 forces this. Cache style, cache-write billing, cache-read multiplier, reasoning parameters and long-context thresholds all vary **by model within a single provider**. A per-model table is needed on day one, not at provider three.

- **Registry (code):** model id → provider. Two entries, trivial, stays code.
- **Model properties (data):** a JSON/TS table keyed by model id — pricing, cache style, write billing, long-context threshold, reasoning support.

Splitting these now costs nothing and means provider three is a data edit.

---

## Part 2 — Not in the plan

### 2.1 Tool search / deferred loading — the premise-level one

Both providers now support lazy tool loading. The model receives a lightweight search tool, discovers what it needs, and loads only that subset into context.

- **OpenAI:** `{"type": "tool_search"}` in the tools array, functions marked `defer_loading: true`. Hosted or client-executed. **gpt-5.4+ only, Responses only.**
- **Anthropic:** Tool Search Tool, **GA February 2026** — so this already exists on the provider pickrate ships today.

Reported effects: ~85% reduction in context tokens, and tool selection accuracy improving from 49% to 74% in complex environments.

**Why this cuts to the bone.** The project's founding claim is that a manifest is loaded in full, every session, so its size costs tokens and degrades selection. Under tool search that stops being unconditionally true. "Your manifest costs 34k tokens per session" becomes "…unless the caller defers it," and the reader who knows about tool search will say so.

**But it is more opportunity than threat, for three reasons:**

1. **Descriptions become *more* load-bearing, not less.** Under tool search the description is what gets *searched*. A bad description now means the tool is never even loaded — a harder failure than being loaded and passed over. The thing pickrate measures gains importance.
2. **49% → 74% is an unverified vendor-adjacent claim about tool selection accuracy.** That is precisely the measurement pickrate exists to make. Independently checking it is a strong, specific, publishable result.
3. **It is a second surface to grade.** `tool_search: on` vs `off` on the same manifest is a delta in exactly the format §5 already reports.

**Loading regime is the independent variable, and both values of it are findings.**

The distinction against §2.4 matters. Parallel tool calls stay at default because they are *the model's behaviour given the surface* — forcing them off would censor the outcome under observation. Tool search is different in kind: it changes *what surface the model sees at all*. One is the dependent variable, the other is the independent one.

That does **not** make eager loading the shipping mode and deferred an option. It makes them a **pair**:

- **Eager (`--tool-search off`)** is the control. Every tool is in context, so a miss is unambiguously a description-versus-model failure. This is the mode cross-provider comparison runs in, because it is the only one where a delta is attributable to the manifest rather than to two different vendor retrievers.
- **Deferred (`--tool-search on`)** is the second measurement, and the more interesting one. Tool search does not remove description-based selection — it adds a **second round** of it. Two events now, both running on the description:
  1. **Retrieval** — does the search surface this tool at all?
  2. **Selection** — once loaded, is it called correctly?

Neither is "the default". The **delta between them is the headline**: *"Eagerly loaded, 94%. Under tool search, 61% — retrieval never surfaces two of your tools."* That is a finding with an obvious fix attached, and it is the same delta-not-absolute logic as §5 and §2.3.

**The author does not control which regime they are in.** Ship an MCP server and some clients defer, some don't. A manifest has to hold up both ways, which is the argument for reporting both rather than choosing.

**New failure modes that only exist under deferral:**

- **Retrieval recall.** A tool that is never retrieved is dead in a way eager loading cannot expose. Under eager loading a weak description means *loaded and passed over* — diagnosable. Under deferral it means the tool was never in the room.
- **Namespace descriptions.** OpenAI's guidance is explicit that the model relies on the namespace description to decide whether to load a subset of functions at all, and advises keeping it short while pushing detail into the deferred function descriptions. That is a **new authored artifact carrying a triggering burden, with no linter anywhere.** It belongs in the analyser.
- **Cache interaction.** Changing the loaded tool set breaks the model's cache from that point forward — so retrieval churn has a cost beyond the retrieval itself.

**Casualty:** the standalone token-cost metric. "Your manifest costs 34k tokens a session" was M1's free, no-key headline and now needs an asterisk. It survives as *one of two numbers* rather than the number — eager cost versus deferred cost, which is arguably the more useful pair anyway.

**Required:** `--tool-search on|off|both`, recorded in the presentation hash either way; never left at the provider default, since that would silently compare two regimes and blame the manifest. Add `toolSearch: 'supported' | 'unsupported'` to model capabilities.

**Analyser additions (reaches back into M1):** lint namespace descriptions as first-class objects — presence, length against the "short, discriminative" guidance, and overlap between namespaces. Report eager and deferred token cost separately.

**Scorer addition:** retrieval and selection are scored separately, like selection and arguments in §4 of the spec. A tool that retrieves reliably but is then passed over is a different bug from one that never surfaces, and they have different fixes.

### 2.2 Reasoning effort is part of the measurement

GPT-5.6 exposes `reasoning.effort` (`none`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium`; `max` is Sol-only) alongside `reasoning.mode` (`standard`, `pro`). These replaced the older scale and do **not** map one-to-one from GPT-5.5.

Two consequences:

**`EvalReport.model` no longer identifies a run.** "gpt-5.6-terra" at `low` and at `xhigh` are different measurements. §2.3's rule — scores are per-model, never averaged — is right but under-specified: the unit is **model + reasoning config**, and `diffReports` must refuse a baseline across differing reasoning configs exactly as it refuses one across models.

**It is a new variance source, and an unusual one.** GPT-5.6 treats effort as a *ceiling rather than a floor*: on prompts it judges easy it may do no reasoning at all, producing zero reasoning tokens, even at high settings. So two trials of the same scenario can differ in whether reasoning happened. This strengthens §2.6 (no seeding) — the variance is not seedable away — but it also means **reasoning tokens are a per-trial variable cost**, and the preflight cannot bound spend from input tokens alone. Reasoning tokens bill as output.

### 2.3 Cache style is per-model, and `CacheStyle` is the wrong shape

The plan's three-value enum assumes cache behaviour is a provider property. It isn't, and OpenAI does not sit cleanly in any of the three values:

| | Populated | Writes billed | Reads |
|---|---|---|---|
| Anthropic | explicit breakpoint | 1.25× | 0.1× |
| OpenAI < 5.6 | automatic prefix (>1024 tok) | free | 0.1× |
| OpenAI ≥ 5.6 | automatic prefix | **1.25×, reported as `cache_write_tokens`** | 0.1× |

**Two independent axes, not one enum:**

```ts
export interface CacheBehaviour {
  population: 'explicit-breakpoint' | 'automatic-prefix' | 'none';
  writesBilled: boolean;
  writeMultiplier?: number;   // 1.25 where billed
  readMultiplier: number;     // 0.1 across all current tiers
  minimumPrefixTokens?: number; // 1024 on OpenAI
}
```

And it hangs off the **model**, not the provider — so `readonly capabilities: ProviderCapabilities` on `Provider` becomes `capabilitiesFor(model): ModelCapabilities`.

**Knock-on corrections:**

- **§2.2's rationale is now false.** "Omitted when the provider has no explicit cache write" — OpenAI ≥5.6 *does* report cache writes. The optional-field design survives, but absence now means *this model has no such concept*, which is model-scoped. The schema stays at version 2 either way; the reasoning in the plan still holds.
- **§1.3 is half right.** `CACHE_READ_MULTIPLIER` at 0.1 is accidentally correct for both providers' current tiers, so it is not urgent. The **write** multiplier is the unparameterised one, and the plan doesn't mention it at all.
- **§1.2's warm-up:** OpenAI's cache also needs a first request to populate, but there is a **1024-token minimum prefix** — small manifests never cache at all. So the capability is not "does it cache" but "will *this request* cache", which the runner can only know from the estimate. Warm-then-fan-out should be conditional on population style **and** estimated prefix size.

### 2.4 Two pricing traps in the preflight

- **Long-context meter.** Requests above 272K input tokens bill at **2× input and 1.5× output for the entire request**, with cached input doubling alongside. pickrate's entire thesis is oversized manifests, and mutation operators *inject decoy tools*. A large manifest plus decoys is the exact shape that crosses this line, and the preflight would under-report by ~2× at the moment it matters most.
- **Regional-processing uplift** of 10% on eligible models released on or after 5 March 2026.

### 2.5 Model aliases defeat the baseline guard

`gpt-5.6` is an alias that routes to `gpt-5.6-sol`. A report recording the *requested* model id therefore doesn't pin what actually ran, and `diffReports`' refusal to compare across models can be walked straight past by an alias whose target changes.

**Fix:** record the model id **returned in the response**, not the one sent. Where they differ, print both.

---

## Part 3 — Amendments to §2

| § | Status | Change |
|---|---|---|
| 2.1 | **Revised** | `CacheStyle` → `CacheBehaviour` (two axes); capabilities keyed by model, not provider; add `toolSearch` |
| 2.2 | **Stands, rationale corrected** | Optional fields still right; absence means model-level absence, not provider-level. No schema bump. |
| 2.3 | **Strengthened** | Unit of comparison is model **+ reasoning config**, not model |
| 2.4 | **Stands** | Research confirms `parallel_tool_calls: false` is a hard gate; leaving default is correct |
| 2.5 | **Stands** | Unchanged |
| 2.6 | **Strengthened** | Ceiling-not-floor reasoning adds unseedable variance; refusing seeds is more clearly right |
| 2.7 | **Revised** | Detection still by model id, but `o*` is legacy (GPT-4o, GPT-5, 5-mini, 5-nano delisted). Resolve aliases from the response. |
| — | **New** | 2.8: loading regime is the independent variable. `--tool-search on\|off\|both`, never left at provider default, always in the presentation hash. Eager is the control for cross-provider comparison; deferred is a second measurement; the delta is the headline. Retrieval and selection scored separately. |
| — | **New** | 2.9: reasoning config recorded in `EvalReport` and guarded by `diffReports` |

## Amendments to §7 build order

Step 1 grows: capabilities become per-model and gain two axes plus tool search. Still offline, still worth doing independently of whether OpenAI lands.

**New step 0 (offline, do first):** calibrate the local tokeniser against both authoritative counting endpoints on the existing fixtures. It gates whether M1's headline metric is a measurement or an estimate, and the answer changes user-facing copy that has already shipped.

**New step 6 — deferred-loading mode.** Deliberately last, and deliberately not cut. It needs the provider work in steps 1–4 finished first, since the eager-versus-deferred delta is only trustworthy once presentation hashing covers loading regime. It splits into three pieces, each shippable:

| | Piece | Cost |
|---|---|---|
| 6a | Namespace-description linting in the analyser; eager vs deferred token cost reported separately | offline |
| 6b | `--tool-search` wired through both providers; retrieval and selection scored separately | live runs |
| 6c | The eager/deferred delta report, plus a recorded fixture covering a tool that retrieves but is passed over, and one that never surfaces | offline after 6b |

6a is worth doing on its own schedule — it is offline, it needs no key, and namespace descriptions are currently unlinted by anything anywhere.

---

## Still to verify live, before step 3

1. Exact Responses tool-declaration shape against the current SDK types.
2. Whether the token-count endpoint is free and unmetered (assumed by analogy; unconfirmed).
3. Cache retention: sources conflict — one indicates ≥30 minutes for 5.6+, another reports a 24-hour default from late May 2026 for GPT-5.5 and the wider GPT-5 series without ZDR. Affects nothing structural, but the runner's assumptions about warm-cache lifetime across a long run depend on it.
4. Whether `store` defaults on for Responses, and whether trials must set `store: false` for independence.
5. Which tier is the right counterpart to a cheap Anthropic model — Luna at $1/$6 is the obvious candidate, but reasoning tokens bill as output at 6× input, so a cheap tier reasoning by default may not be cheap in practice. **Cost one scenario at 20 trials before committing to a default.**