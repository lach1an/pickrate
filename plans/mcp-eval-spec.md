# MCP Agent Evaluation Harness — Project Spec

**Working name:** TBD (`mcpeval`, `toolcheck`, `manifest` all plausible)
**Status:** Draft v0.1 — pre-code
**Date:** 25 July 2026

---

## 0. Timing note — read this first

The MCP specification finalises on **28 July 2026**, three days from now. The current stable spec is `2025-11-25`; the new one is `2026-07-28`, and it is the largest revision since the protocol launched.

This matters enormously for a project starting today:

- The protocol becomes **stateless**. No `initialize`/`initialized` handshake, no `Mcp-Session-Id`, any request can hit any server instance.
- New routing headers `Mcp-Method` and `Mcp-Name` let load balancers route without parsing the JSON-RPC body.
- Caching metadata (`ttlMs`, `cacheScope`) is standardised.
- An **Extensions framework** lands, with MCP Apps and a redesigned Tasks extension as the first two.
- `Roots`, `Sampling` and `Logging` are deprecated (not removed — there's now a 12-month minimum deprecation window).
- Tool `inputSchema`/`outputSchema` move to full JSON Schema 2020-12.

**Strategic consequence:** every existing MCP testing tool was built against the stateful model and now has a migration on its hands. Building stateless-native from day one is both less work for you (no session lifecycle to implement) and a legitimate differentiator for roughly the next two quarters.

Beta SDKs targeting the RC exist for Python, TypeScript, Go and C#.

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

**Connector** — thin. Isolate it hard, because the SDKs targeting `2026-07-28` will churn for a few months. Everything else should be testable against a fixture manifest with no server running.

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
