# MCP Agent Evaluation Harness — Project Spec

**Working name:** TBD (`mcpeval`, `toolcheck`, `manifest` all plausible)
**Status:** Draft v0.1 — pre-code
**Date:** 25 July 2026

---

## 0. Protocol note — read this first

**Updated 28 July 2026: the specification shipped as final today.** `2026-07-28` replaces `2025-11-25` as the current version. It is the largest revision since the protocol launched.

- The protocol is **stateless**. The `initialize`/`initialized` handshake and the `Mcp-Session-Id` header are gone (SEP-2575, SEP-2567). Every request carries its protocol version, client identity and client capabilities in `_meta`.
- A new **`server/discover` RPC**, which servers MUST implement, advertises supported protocol versions, capabilities and identity. Clients MAY call it up front.
- **`Mcp-Method` and `Mcp-Name` headers are required** on Streamable HTTP POSTs (SEP-2243), so gateways can route and meter without parsing the body.
- **List results are cacheable** (SEP-2549): `tools/list`, `prompts/list`, `resources/list`, `resources/read` and `resources/templates/list` now carry `ttlMs` and `cacheScope`, with deterministic ordering, so clients can cache tool catalogues and keep upstream prompt caches stable across reconnects.
- **MRTR** (SEP-2322) replaces server-initiated elicitation/sampling. Every result now carries a required `resultType` — `complete` or `input_required`. *This field landed between the RC and the final text; it was not in the May research.*
- **Extensions framework** is formal, with MCP Apps, Tasks and Enterprise Managed Authorization as the named extensions. Tasks moved out of core.
- `Roots`, `Sampling`, `Logging` and the legacy HTTP+SSE transport are **deprecated, not removed** — twelve-month minimum window under the new lifecycle policy (SEP-2577, SEP-2596).

### Correction to the earlier strategic claim

The draft version of this section said building stateless-native was *less work* because there is no session lifecycle to implement. **That was wrong, and in a way that changes M1's scope.**

Publication is a publish date, not a switch-off. Servers on `2025-11-25` keep working and will for at least a year. The 20–30 well-known public servers that M5's leaderboard depends on are overwhelmingly still on the old revision today.

**So the connector must speak both revisions**, using the probe pattern the SDKs have adopted: call `server/discover`, and fall back to the legacy `initialize` handshake when the server doesn't support it. Dual-protocol is not a nice-to-have — without it there is no leaderboard, and the leaderboard is the distribution event.

The differentiator survives, but it is narrower and better stated: **every existing MCP testing tool now has a migration on its hands, and pickrate can be born dual-protocol rather than retrofitted.** That is a real advantage for roughly the next two quarters. It just costs a connector that handles two lifecycles instead of zero.

All four Tier 1 SDKs (TypeScript, Python, Go, C#) speak `2026-07-28` as of today; Rust is in beta.

---

## 1. MCP in ten minutes

Enough to build against. Skip if you already have this.

### What it is

MCP is a standard way for an AI agent to call external tools. Before it existed, every tool needed a bespoke integration for every AI client — the N×M problem. MCP is one connector shape that works everywhere.

It's **JSON-RPC 2.0** over one of two transports:

- **stdio** — the server runs as a local subprocess, messages over stdin/stdout. Used for local dev tools.
- **Streamable HTTP** — the server is a remote endpoint. Used for hosted services. (An older HTTP+SSE transport was deprecated in March 2025; ignore it.)

### The three primitives

| Primitive | What it is | Who drives |
|---|---|---|
| **Tools** | Actions the model can invoke (`create_branch`, `query_db`) | The model decides |
| **Resources** | Data the client can read (files, records) | The client decides |
| **Prompts** | Reusable templates the server offers | The user decides |

**Tools are the only primitive this project cares about.** Resources and prompts aren't where the failures are.

### The interaction you're testing

1. Client connects to the server and calls `tools/list`.
2. Server returns an array of tools. Each has a `name`, a `description`, and an `inputSchema` (JSON Schema describing its parameters).
3. **That entire array is injected into the model's context window, every session, before any work happens.**
4. User says something in natural language.
5. The model reads the tool descriptions and decides which tool to call and with what arguments.
6. Client executes `tools/call`, the result goes back into context, the model continues.

### The insight the whole product rests on

**A tool manifest is a prompt.** Names, descriptions and schemas are the entire interface the model reasons over. There is no type checking, no compiler, no linter — just English being interpreted by a language model.

So MCP servers fail in ways ordinary APIs don't:

- Two tools with similar descriptions and the model picks the wrong one.
- A parameter description is vague, so the model invents a format.
- The manifest is so large it crowds out the actual task. A 200-endpoint API auto-converted to MCP can push 40,000–80,000 tokens of schema into context before the model does anything, which measurably degrades reasoning.
- Tools that are never selected under any realistic phrasing — dead weight you pay context for on every single call.

None of this is visible to conventional testing. Your tool returns a correct 200 response and the agent still never calls it.

---

## 2. Problem statement

Generating MCP servers is now free and instant — Stainless, FastMCP, AWS Labs and a dozen OSS CLIs will convert an OpenAPI spec into a server in minutes. Tens of thousands of servers exist.

Almost nobody can answer: **does an agent actually use mine correctly?**

Existing options:

| Tool | What it does | Gap |
|---|---|---|
| MCP Inspector (official) | Interactive console — list and invoke primitives manually | Manual, model not in the loop |
| Postman | MCP requests alongside API collections | Same — human-driven |
| Braintrust / general eval platforms | Powerful, but you build the harness yourself | Neon had to write theirs from scratch |
| LLMOps platforms | Full functional + security gates | Enterprise pricing and onboarding |

**The gap: zero-config.** Nothing exists that you point at a server and get a graded report from in ninety seconds. That's a Lighthouse-shaped hole, not a platform-shaped one.

---

## 3. What this is not

Explicitly out of scope, to keep the thing small:

- ❌ Testing that tools return correct data (that's ordinary integration testing — MCP Inspector plus the SDK client covers it)
- ❌ Schema validity checking (the SDKs do it)
- ❌ A hosted dashboard, user accounts, or a web UI
- ❌ Security scanning (v2 candidate, not v1)
- ❌ Multi-agent or A2A workflows

**This is one thing: does a language model use this tool surface correctly, and how reliably.**

---

## 4. The core design decision

Calling this "unit testing" is a trap worth naming explicitly.

Tool selection is **non-deterministic**. The same prompt against the same manifest gives different answers across runs. A binary assertion is meaningless — it will pass on Tuesday and fail on Wednesday and teach you nothing.

The prior art here is instructive: when Neon evaluated their 20+ tool server, they ran **20 trials per evaluation** with bounded concurrency specifically to account for model variability, and expressed expected outcomes as behavioural descriptions rather than exact matches. Their tool selection rate went from 60% to 100% through prompt iteration alone — no code changes. That 40-point swing is the value this product surfaces.

**So: every assertion is a pass rate over N trials, never a boolean.**

```
✗  expect(selected).toBe('create_branch')
✓  expect(selected).toSelect('create_branch').atLeast(0.95).over(20)
```

Getting these ergonomics right — assertions that are flaky by design but still pleasant to write and legible in CI output — *is* the product. Everything else is plumbing.

### Three things to score separately

They're different bugs with different fixes:

1. **Selection** — did it choose the right tool?
2. **Arguments** — given the right tool, were the args right?
3. **Restraint** — for prompts the server shouldn't handle, did it correctly call *nothing*?

(3) is the most neglected and often the most revealing. Over-eager tool calling is a real and common failure mode.

---

## 5. Proposed scenario format

Declarative first. A DSL can come later if anyone asks.

```yaml
# mcpeval.yaml
server:
  transport: stdio
  command: node ./build/index.js
  # or:  transport: http
  #      url: https://api.example.com/mcp

defaults:
  trials: 20
  threshold: 0.95
  model: <cheap-fast-model>
  concurrency: 4

scenarios:
  - id: create-branch
    prompt: "make me a branch called feature-login"
    expect:
      tool: create_branch
      args:
        name: feature-login

  - id: create-branch-colloquial
    prompt: "can you branch off main for the login work"
    expect:
      tool: create_branch
    threshold: 0.80   # looser — deliberately vaguer phrasing

  - id: no-tool-needed
    prompt: "what's the capital of France?"
    expect:
      tool: null      # restraint check

  - id: ambiguous-delete
    prompt: "get rid of the staging branch"
    expect:
      tool: delete_branch
    threshold: 0.99   # destructive — demand near-certainty
```

Per-scenario `threshold` overrides matter: you want a *higher* bar for destructive operations than for convenience ones, and that's a judgement call the user should own.

---

## 6. Validating the harness — mutation testing

The obvious objection to any model-based eval: who's watching the watchmen? If a model helps write the tests and a model takes them, correlated blind spots produce numbers that look meaningful and aren't.

Partial relief first: **tool selection has structured output**, so the core metric needs no LLM judge. The model emits a tool name; checking it is string equality. The usual LLM-as-judge problem simply doesn't apply to the primary score. It only appears at the edges — free-text arguments — and v1 can avoid it entirely with strict matching plus a `normalise` hook.

The real exposure is scenario authorship. A generator reading the same tool descriptions as the subject model inherits the same ambiguities, writes a test consistent with its own misreading, and the test passes having measured nothing. Same disease as writing unit tests from the implementation rather than the requirements.

### The answer: break the manifest on purpose

Take a known-good server. Damage it in a specific, known way. Re-run. **If the score doesn't drop, the harness is broken.**

This validates the watchmen without needing an oracle, because you constructed the ground truth yourself by damaging a known-good input.

Proposed mutation operators:

| Mutation | What it should catch |
|---|---|
| Swap two tool descriptions | Selection is actually reading descriptions, not guessing from names |
| Blank a tool description | Description carries real signal |
| Blank a parameter description | Argument accuracy depends on param docs |
| Rename a tool to something opaque (`delete_branch` → `op_7`) | Names carry signal independently of descriptions |
| Duplicate a tool under a near-identical description | Harness detects genuine ambiguity |
| Inject 20 irrelevant decoy tools | Context bloat degrades selection measurably |
| Truncate a description to its first clause | Sensitivity to detail loss |

### The output this produces

A **mutation score**: what fraction of injected defects the harness detected. That single number is the thing that makes the tool credible, and it's the differentiator — everyone else reports how good your server is, this reports how much you should trust the report.

It also doubles as your own test suite. You can develop the scorer against mutated fixtures with no live server and no API spend beyond the trials themselves.

### Complementary checks

- **Gold set.** Thirty hand-written, human-verified scenarios. Measure any automated generation against them and publish the agreement rate. Not certainty — calibration.
- **Out-of-band scenario sources.** Generate from API docs, changelogs, support tickets, real query logs. Anything describing what users *want* rather than what the manifest *claims*. A mismatch then becomes signal rather than echo.
- **Variance baseline.** Run an unmodified manifest twice. The gap is your noise floor; no reported regression below it means anything.

### The reframe that defuses most of this

The tool doesn't need to be right in an absolute sense. It needs to be **sensitive to change**.

Nobody buys "your server scores 87/100" — unfalsifiable and they know it. They buy "this PR dropped selection from 94% to 71%." A regression detector needs stable *relative* measurement, a far lower epistemic bar than absolute truth, and it's the version with a budget attached.

**Goodhart warning:** once anyone optimises against the score, they'll write descriptions that game it rather than descriptions that work. Design the report so diagnostics (confusion pairs, orphan tools, token cost) are more prominent than any headline number.

---

## 7. Architecture

Five components, deliberately decoupled.

```
┌──────────────┐
│  Connector   │  speaks MCP (stdio + streamable HTTP)
│              │  tools/list, tools/call
└──────┬───────┘
       │ manifest
       │
       │   ┌──────────────┐
       ├──▶│   Mutator    │  injects known defects,
       │   │  (optional)  │  returns damaged manifest
       │   └──────┬───────┘
       │          │ (loops back through Runner)
       ├──────────┴───────────────┐
       ▼                          ▼
┌──────────────┐          ┌──────────────┐
│   Analyser   │          │    Runner    │
│  (static,    │          │  N trials ×  │
│   no LLM)    │          │  M scenarios │
└──────┬───────┘          └──────┬───────┘
       │                          │ raw selections
       │                          ▼
       │                   ┌──────────────┐
       │                   │    Scorer    │
       │                   │  pass rates, │
       │                   │  confusion   │
       │                   └──────┬───────┘
       └──────────┬───────────────┘
                  ▼
          ┌──────────────┐
          │   Reporter   │  table / JSON / exit code
          └──────────────┘
```

**Connector** — thin, and as of §11 an **adapter interface** rather than an MCP-specific component. Isolate it hard, because the SDKs targeting `2026-07-28` will churn for a few months. Everything else should be testable against a fixture manifest with no server running.

**Analyser** — static, no model calls, sub-second, no API key required:
- Total manifest token count, and per-tool breakdown
- Tools with missing or single-word descriptions
- Parameters with no description
- Near-duplicate descriptions (cosine similarity or plain n-gram overlap — don't over-engineer)
- Free-text params that look like they should be enums
- Schema nesting depth

**Runner** — the only part that costs money. Bounded concurrency, retries on transport errors (not on model output), deterministic seeding where the provider allows it.

**Scorer** — pass rate per scenario; per-tool confusion matrix; orphan tools (never selected in any scenario); and a **flakiness band** flag for anything landing between 20% and 80%, which is the genuinely dangerous middle where a server looks fine in a demo and fails one call in three.

**Reporter** — human table by default, `--json` for machines, non-zero exit when thresholds are breached.

---

## 7. Build order

Sized for a few hours a week. Each milestone ships on its own.

### M1 — Analyser only (weekends 1–2)

`mcpeval inspect <server>` → connect, pull the manifest, print token cost and lint warnings.

**No API key, no model calls, no cost.** This is deliberate: the barrier to someone trying it is `npx` and nothing else. Most tools in this space ask for credentials before showing value. Not asking is a feature.

Already genuinely useful on its own — "your tool manifest costs 34k tokens per session and six of your tools have no parameter descriptions" is a finding people will act on.

### M2 — Runner + scorer (weekends 3–4)

Single model provider. Scenario file. Pass rates and confusion output. This is the real thing.

### M3 — Mutator (weekend 5)

Three operators to start: swap descriptions, blank a description, inject decoys. Report a mutation score.

Deliberately placed *before* CI rather than after. Two reasons: it's your own regression suite, so building it early makes everything after it safer to change; and it's the differentiator, so it should exist before anyone else sees the project. Every other tool in this space reports how good your server is. This is the only one that reports how much you should trust the report.

### M4 — CI-ready (weekend 6)

JSON output, exit codes, a GitHub Action wrapper, threshold config. Turns it from a curiosity into something that stays in a repo.

### M5 — The leaderboard

Run it against the 20–30 best-known public MCP servers. Publish the results with methodology.

This is your distribution *and* your validation. If the numbers are boring, you've learned that cheaply before building anything else. If they're not — and given how many of these servers were auto-generated in one click, they probably aren't — that post travels a long way on its own.

### Later, if it has legs

Multi-model comparison (does your server work on Claude but not GPT?), security regression checks, description auto-repair suggestions, watch mode.

---

## 8. Open questions

1. **Language.** TypeScript is the obvious call — the MCP ecosystem's centre of gravity, `npx` distribution, and most MCP servers are TS so it lives in the same repo. Python is the alternative if you'd rather.
2. **Which model as default judge?** Cheap and fast matters more than smart, and it should be swappable. But note: the model you test with *is* part of the result, so the report has to state it prominently.
3. **Where do scenarios come from?** Hand-written for v1 — settled, and the mutation work in §6 is what makes generation safe to add later. When you do add it, generation drafts and a human accepts; reviewing thirty generated scenarios is twenty minutes against three hours to write them, and a human deciding what "correct" means is what breaks the circularity.
4. **Do you score arguments strictly or semantically?** Strict by default, opt-in semantic — settled by §6, since strict matching keeps an LLM judge out of the primary metric entirely.
5. **How many mutants before the score means anything?** Open. Too few and the mutation score is noise; too many and every run costs real money. Start at three operators × three tools and see what the variance looks like.
6. **Name and licence.** Open-core is the natural shape here — CLI open source, CI/hosted reporting paid.

---

## 9. Success criteria for v1

Not revenue. For a project at this stage, the honest bar is:

- Someone who isn't you runs it against their own server
- The report tells them something they didn't already know
- They change their tool descriptions because of it

If that happens three times, the project is real. If it doesn't, you've spent five weekends learning MCP properly, which was worth it anyway.

---

## 11. Update — 25 July 2026: Agent Skills as a second adapter

**Change:** the core is no longer MCP-specific. MCP servers and Agent Skills are two instances of one problem, and the engine should be adapter-based from the start.

**Assumption carried into this section:** the static-analysis layer (M1) is treated as already covered for skills — description linting and optimisation exist in the ecosystem already (SkillReducer, skill-creator tooling). So the skills adapter enters at the **runner**, not at the analyser. Nothing below re-does M1.

### The unifying abstraction

> Context that a model selects, at runtime, based on a short natural-language description.

MCP tools, Agent Skills, and subagents are all instances. The selection mechanism is identical, therefore the measurement problem is identical.

Skills work by **progressive disclosure**: the agent loads only each skill's name and description at startup and reads the full `SKILL.md` only once a task matches. The description carries the entire triggering burden — exactly as a tool's `description` field does in a manifest.

### Why the problem is worth covering

- Roughly **45% of installed skills in one production system had never been triggered** — pure context tax on every request.
- Trigger rate from description matching alone measured at **under 30%**.
- **SkillsBench** (Stanford/CMU/Berkeley/Oxford) analysed **47,150 public skills** and found an average quality score of **6.2 out of 12**; they used only top-quartile skills in testing. Curated skills lifted agent pass rates **16.2 points on average, 51.9 in healthcare**.
- Surface area: **31,000+ skill definitions** in `.claude/skills/` on GitHub, plus 57,000+ AGENTS.md and 21,000+ CLAUDE.md files. Open standard at agentskills.io since December 2025, ~40 compatible products (Codex, Copilot, Cursor, Gemini CLI, VS Code).

The 16.2-point curation swing is the skills-side equivalent of Neon's 60→100%. Same argument, larger corpus.

### What transfers unchanged

Almost everything, which is the point:

| Component | Change needed |
|---|---|
| Scorer | None |
| Mutator (§6) | None — every operator applies |
| Pass-rate assertions (§4) | None |
| Reporter | None |
| Runner | Prompt assembly only |
| Connector | New adapter |

The restraint check from §4 maps directly onto skills, and it's officially blessed: the recommended methodology is **~20 eval queries, 8–10 that should trigger and 8–10 that shouldn't, with near-misses the most valuable negative cases.** That's a documented method with no tool shipping it — the same gap this project was founded on.

### What's genuinely different

1. **Two layers, not one.** A skill has a *routing description* (selection) and a *body* (execution). Only the description drives triggering. Score them separately — a skill can trigger perfectly and then perform badly, or never trigger despite an excellent body.
2. **Hard 1024-character limit** on descriptions. A real constraint to lint against; MCP has no equivalent.
3. **Prefix-cache cost.** Skills sit near the front of the context prefix, so editing one invalidates cache for the whole conversation behind it. Churn has a cost beyond tokens, and that's a metric worth reporting.
4. **Directory, not protocol.** The adapter reads markdown frontmatter off disk. No JSON-RPC, no transports, no beta SDK.

### Prior art to read before building

**SkillReducer** — two-stage optimisation framework; analysed 55,315 public GitHub skills; stage one optimises routing descriptions and generates them from the body where missing or too short.

Closer to this project than anything in the MCP space. Two distinctions to preserve: it **optimises**, this **measures**; and it's a paper, not a CLI. Both are defensible positions, but know the boundary before you start.

### Revised adapter roadmap

| | MCP adapter | Skills adapter |
|---|---|---|
| Difficulty | JSON-RPC, two transports, churning beta SDK | Read markdown frontmatter from a directory |
| Spec risk | High through Q3 2026 | Low — stable open standard |
| Corpus for a launch post | ~22,000 servers | ~1.9M indexed skills, 31k on GitHub |
| Who pays | Companies shipping servers, CI budgets | Mostly individuals |

**Momentum lives in skills, revenue lives in MCP.** Ship whichever gets you to a public artifact soonest; the adapter split means the other is a config change, not a fork.

### New open questions

7. **Does the mutation score mean the same thing across adapters?** Blanking a skill description and blanking a tool description are similar operations but the baselines differ. Probably needs per-adapter normalisation before the numbers are comparable.
8. **Do you score skill bodies at all, or only routing?** Routing only is the disciplined answer and keeps scope tight. Body quality is a much larger, mushier problem.
9. **Is "45% never trigger" reproducible on public corpora?** If yes, that's the launch post. Worth checking cheaply and early, since it needs no runner — just an analyser and a scenario set.

---

## 12. Update — 28 July 2026: what the shipped spec adds

Beyond the connector correction in §0, the final text creates **new lintable surface that did not exist yesterday and that nothing currently checks.** All of it is static, offline, no API key — which puts it squarely in M1.

### 12.1 Cache metadata is the significant one

`tools/list` results now carry `ttlMs` (freshness hint, milliseconds) and `cacheScope` (`public` or `private`), modelled on HTTP `Cache-Control`. The stated purpose is that clients can cache tool catalogues **and keep upstream prompt caches stable across reconnects**.

That last clause connects directly to §11.3 of this spec — the prefix-cache cost identified for skills. The same property now exists in MCP and is now *declarable*, which means it is now *checkable*:

| Check | Failure it catches |
|---|---|
| `ttlMs` present and non-trivial | Absent or near-zero forces re-fetch of the catalogue on every call — token cost plus prompt-cache invalidation on every reconnect |
| `cacheScope` present | Undeclared scope means conservative clients won't cache at all |
| `cacheScope: public` on a tenant-varying catalogue | **Security lint.** A shared intermediary may cache and serve one tenant's tool catalogue to another |
| Ordering deterministic across repeated `tools/list` calls | Nondeterministic order breaks every downstream prompt cache on every reconnect, invisibly, at real cost |

The ordering check is the good one. It is trivial to implement — call `tools/list` twice, compare — it costs nothing, it is invisible to every existing tool, and the failure it catches is expensive and silent. It is also a *very* clean demo of what the analyser is for.

### 12.2 `server/discover` is a new free information source

Servers MUST implement it, and it returns supported protocol versions, capabilities and identity before any tool call. For the analyser that means protocol generation, capability set and declared extensions are all available at zero cost, and can be cross-checked against what the server actually does.

Obvious lint: capabilities declared in `server/discover` that the server does not honour in practice.

### 12.3 `resultType` and MRTR

New required field on every result: `complete` or `input_required`. A `tools/call` can now return `input_required` with `inputRequests` and an opaque `requestState`, expecting the client to re-issue with `inputResponses`.

pickrate measures selection rather than execution, so this is mostly out of scope — but two things follow:

1. The connector must not treat `input_required` as a malformed result. Handle it explicitly even if the harness only records that it happened.
2. **A tool that demands mid-call elicitation is a distinct behaviour that current scoring does not model.** Not a v1 problem, but worth noting that "selected correctly" and "completed without further input" are separable outcomes now.

### 12.4 Not v1

- **MCP Apps** — tools declare UI templates ahead of time, which is more manifest surface and eventually more to lint. Later.
- **Tasks** — a tool returning a task handle is a different completion shape. Later.
- **`x-mcp-header`** — custom headers derived from tool parameters (SEP-2243). A security surface worth a look when the security work lands, not now.

### 12.5 Net effect on the build order

M1 **gains** the checks in 12.1 and 12.2 — cheap, static, and nobody else is doing them because the spec is hours old.

M1 also **grows** by the dual-protocol connector from §0, which is the larger cost. Roughly: one extra weekend, offset by the analyser additions being the strongest free-tier material the project has had so far.

The ordering-determinism check is the one I would build first. It is a handful of lines, it needs no key, and "your server returns tools in a different order each call, which breaks your users' prompt caches" is exactly the kind of specific, actionable, previously-invisible finding that makes people try a tool.