# pickrate — working notes

Full spec: [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md), plus [`plans/skills-adapter-plan.md`](plans/skills-adapter-plan.md) for the MCP/skills adapter split. Read them before making design decisions; they settle most of them.

## Current state

**M1 (analyser) and M2 (runner + scorer) — complete.** `pickrate inspect <target>` reports token cost and lint findings; `pickrate run <config.yaml>` runs scenarios × trials against a model and reports pass rates, confusion pairs, orphans and flakiness.

**Adapter split — step 1 of 6 done.** The core is generic over a `Surface` (`SurfaceItem = ToolDef | SkillDef`), but MCP is still the only adapter: nothing constructs a `SkillDef` yet. Next is step 2, `src/connector/` → `src/adapters/mcp/` behind an `Adapter` interface. M3 (mutator) and M4 (CI) are not started — and the mutator must land *after* the adapter work, or its operators get written twice.

## Invariants

These are load-bearing, not preferences:

1. **`inspect` never makes a model call and never requires an API key.** The zero-credential first run is the distribution strategy, not a nicety. Analyser rules are pure: `Surface` in, `Finding[]` out.
2. **Only `src/connector/` imports `@modelcontextprotocol/sdk`** (becoming `src/adapters/mcp/` at step 2)**; only `src/provider/` imports `@anthropic-ai/sdk`.** Everything else consumes `Surface` and `TrialResult` from `src/types.ts`. The MCP spec finalises `2026-07-28` (stateless, no `initialize`, no `Mcp-Session-Id`, new `Mcp-Method`/`Mcp-Name` routing headers) and the SDKs will churn; the model is a swappable part of the measurement. Contain both.
3. **Every eval assertion is a pass rate over N trials, never a boolean.** Tool selection is non-deterministic; a binary assertion passes Tuesday and fails Wednesday.
4. **Score selection, arguments and restraint separately.** Different bugs, different fixes. Restraint (correctly calling *nothing*) is the most neglected.
5. **Diagnostics outrank the headline number in the report.** Goodhart: the moment someone optimises the score they write descriptions that game it. Confusion pairs, orphan tools and token cost go above any total.
6. **Never retry a trial because of its result.** Transport errors retry (in the SDK client); a "wrong" tool choice is data. Retrying it until it looks better biases every pass rate upward, invisibly.
7. **`run` never executes a tool.** One model turn per trial; `tools/call` is never issued. A `delete_branch` scenario must not delete anything on the user's server.

## Measurement decisions (M2)

Changing any of these changes what the numbers mean — don't adjust them casually.

- **Selection passes only on exactly one call, the expected one.** Over-eager tool calling is a real failure mode; scoring "right tool plus two others" as a pass would hide it.
- **Arguments are matched as a subset** — only keys declared in `expect.args`. Extra arguments the model supplies are ignored, so a scenario never has to enumerate optional params.
- **Normalisation trims strings and nothing else.** No lowercasing: branch names, paths and identifiers are case-sensitive, and wrong case *is* a wrong argument.
- **Errored trials leave the denominator** and are counted separately, so a flaky network doesn't read as a bad manifest.
- **`tool_choice: auto` is mandatory** — a forced choice makes restraint scenarios impossible to express.
- **Never `thinking: {type: "disabled"}`.** On some models that makes tool calls arrive as visible text rather than `tool_use` blocks, which this harness would silently score as "selected nothing" — a systematic error in the primary metric. Use `output_config.effort` for cost instead.
- **Warm-then-fan-out.** The cache breakpoint sits on the system prompt (which renders after `tools`), and a cache entry is only readable once the first response returns — so trial 1 runs alone. Keep `SYSTEM_PROMPT` byte-stable; one interpolated timestamp makes a run ~10× dearer.
- **No seeding is available.** `temperature`/`top_p`/`top_k` are removed or rejected on current models and there is no seed parameter, so the spec's "deterministic seeding where the provider allows it" is not implementable. Variance is irreducible — which is the premise anyway.

## Stack

Node ≥20.19, TypeScript (strict, `exactOptionalPropertyTypes`), ESM, `tsc` to `dist/`. Tests are `node:test` via `tsx`, offline, no snapshots. Arg parsing is `node:util` `parseArgs` — no CLI framework.

Current SDK (`1.29.0`) still negotiates protocol `2025-11-25` and still does the initialize handshake. No `2026-07-28` SDK has shipped yet. When one does, the change should land in `src/connector/index.ts` and nowhere else.

## Fixtures

Two kinds, both so components can be developed with no server and no API spend:

- `test/fixtures/*.json` — captured `tools/list` responses, read by `loadManifestFromFile`. `git-server.json` is deliberately clean (a test asserts zero warnings); `messy-server.json` deliberately trips every analyser rule.
- `test/fixtures/trials/*.json` — recorded `TrialResult[]`, replayed by `ReplayProvider`. `git-server.json` covers a clean scenario, a confusion pair, a restraint miss, an argument mismatch and an errored trial. `test/fixtures/pickrate.yaml` pairs with both.

Together they run the whole eval pipeline offline:

```bash
npm run dev -- run test/fixtures/pickrate.yaml --replay test/fixtures/trials/git-server.json
```

They are also the seed corpus for M3's mutation testing — a mutation run scores a damaged surface against this recorded baseline.

## Conventions

- Rules live in `src/analyser/rules/`, grouped by theme, registered in `rules/index.ts`. Thresholds are exported named constants, not inline literals.
- Findings anchor to `item` (a tool or skill name) and a schema `path` where they can. `detail` is for `--json` consumers only.
- Every rule declares `appliesTo: SurfaceKind[]`. A rule that cannot say anything about a surface is skipped, not run against an empty narrowing — silence and "no findings" must not be the same thing. Narrow with `toolsOf`/`skillsOf` from `src/surface.ts`, never a cast.
- Token counts are *resident* cost. For skills that means routing descriptions only; bodies are not resident until the skill triggers and are never summed into the total.
- The JSON report shape is versioned (`SCHEMA_VERSION`, now 2); M4's CI integration will pin on it.
