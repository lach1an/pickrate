# Adapter split: MCP + Agent Skills — implementation plan

**Status:** proposed, pre-code
**Date:** 25 July 2026
**Implements:** [`mcp-eval-spec.md`](mcp-eval-spec.md) §11
**Precedes:** M3 (mutator), M4 (CI)

---

## 0. What §11 gets right, and the one thing it understates

§11's table says the runner needs "prompt assembly only" and the connector needs "a new adapter". The first half is right. The second understates it by one seam.

For MCP, *the thing the model selects* and *the thing the model calls* are the same object: a tool. `TrialResult.calls[0].name` **is** the selection, which is why the scorer can compare it to `expect.tool` with string equality.

For skills that identity breaks. A skill is not invoked as a tool of its own name — the agent is given one `Skill` tool and picks a skill by *argument*. So the selection the scorer must score lives at `calls[0].args.skill`, not `calls[0].name`.

That is one function — projecting raw model calls onto selections — and it belongs to the adapter. Add it and §11's claim holds exactly: scorer, reporter, mutator and assertion semantics genuinely change nothing.

So the work is **three seams, not one**:

| Seam | Owns | New? |
|---|---|---|
| `Adapter.load` | target string → `Surface` | generalises today's `loadManifest` |
| `Adapter.present` | `Surface` → provider-neutral request material | new |
| `Presentation.project` | raw `ToolCall[]` → scored selections | new |

`present` must stay provider-neutral — it emits plain tool declarations and system text, and `AnthropicProvider` converts them. Invariant 2 (only `src/provider/` imports `@anthropic-ai/sdk`) survives untouched.

---

## 1. The presentation decision — needs a call before coding

How a skill surface is rendered into a single model turn determines what the numbers mean. Two options:

### (a) `skill-tool` — one `Skill` tool with an enum *(recommended default)*

```
tools:   [ { name: "Skill", input_schema: { skill: { enum: [...names] } } } ]
system:  <base prompt> + "Available skills:\n- name: description\n..."
```

This is how Claude Code actually surfaces skills — a listing in context plus one dispatch tool. Measuring the real mechanism is the whole premise of the project, and the routing-description listing is exactly the progressive-disclosure surface §11 describes.

Costs: `project()` is required; the enum itself carries name signal that the listing also carries, so names are slightly double-weighted versus a real session.

### (b) `pseudo-tool` — one synthetic tool per skill

Each skill becomes a tool with its routing description and an empty input schema. `project()` is the identity; nothing else in the codebase changes at all.

Costs: it is not the mechanism under test. It also gives every skill its own `description` slot, which is a *more* favourable surface than reality — the numbers would come out optimistic and non-comparable to a real agent.

**Recommendation:** implement both, default to (a), expose as `defaults.presentation: skill-tool | pseudo-tool`. (b) then earns its keep as a control: running the same skill set both ways measures how much of the trigger rate is the dispatch mechanism versus the descriptions, which is a genuinely interesting number and costs nothing extra to obtain.

**A cache warning that becomes load-bearing here.** The skills listing goes in the system block, which carries the cache breakpoint. It is derived from the surface, so it is byte-stable *within* a run — fine. But it must be assembled by deterministic iteration over the surface (no `Set` ordering, no `Date`, no absolute paths that vary by machine), or warm-then-fan-out silently stops working and a run costs ~10×. This joins the invariant list.

---

## 2. Type changes — `src/types.ts`

Pre-1.0, no external consumers. Rename cleanly rather than aliasing.

```ts
export type SurfaceKind = 'mcp' | 'skills';

/** Anything a model selects at runtime from a short natural-language description. */
interface Selectable {
  /** Identifier the model emits when it picks this. */
  name: string;
  title?: string;
  /** The routing description. Carries the entire triggering burden. */
  description?: string;
  raw: Record<string, unknown>;
}

export interface ToolDef extends Selectable {
  kind: 'tool';
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface SkillDef extends Selectable {
  kind: 'skill';
  /** Path to SKILL.md, for anchoring findings. */
  path: string;
  /** Everything after the frontmatter. Not sent to the model; costed separately. */
  body: string;
  frontmatter: Record<string, unknown>;
}

export type SurfaceItem = ToolDef | SkillDef;

export interface Surface {
  kind: SurfaceKind;
  items: SurfaceItem[];
  source: SurfaceSource;   // was ManifestSource
}
```

- `Manifest` → `Surface`, `manifest.tools` → `surface.items`. ~40 call sites, all mechanical.
- `SurfaceSource.kind` widens: `'stdio' | 'http' | 'file' | 'dir'`, plus an `adapter: SurfaceKind` field so reports can say which world they are in.
- `Finding.tool` → `Finding.item` (a skill is not a tool). Keep `path` — it already means "dot-path into the schema" for MCP and can mean the frontmatter key for skills.
- `TrialResult` is **unchanged**. It stays a faithful transcript of raw model calls; projection happens at score time. This keeps recorded fixtures honest, keeps replay working across presentation changes, and is what lets a fixture recorded today still be replayable after the presenter is rewritten.

New in the scorer:

```ts
export interface ScoreOptions {
  normalise?: Normalise;
  /** Adapter-supplied. Defaults to identity, which is the MCP case. */
  project?: (calls: ToolCall[]) => ToolCall[];
}
```

That is the entire scorer diff. Everything downstream of it — pass rates, confusion pairs, orphans, flakiness band, restraint, thresholds — is untouched, as §11 predicted.

---

## 3. `src/connector/` → `src/adapters/`

```
src/adapters/
  index.ts          Adapter interface, registry, resolveTarget
  target.ts         moved, extended
  mcp/
    index.ts        today's connector, verbatim modulo renames
  skills/
    index.ts        directory walk + frontmatter parse
    present.ts      skill-tool / pseudo-tool presenters
```

```ts
export interface Presentation {
  /** Provider-neutral declarations. The provider converts these to its own shape. */
  tools: Array<{ name: string; description?: string; inputSchema: JsonSchema }>;
  /** Appended to the stable base system prompt. Must be byte-stable across trials. */
  systemSuffix?: string;
  /** Raw calls → the selections the scorer scores. */
  project(calls: ToolCall[]): ToolCall[];
}

export interface Adapter {
  id: SurfaceKind;
  load(target: Target, options: LoadOptions): Promise<Surface>;
  present(surface: Surface, options?: PresentOptions): Presentation;
}
```

**Invariant 2 restated for the new layout:** only `src/adapters/mcp/` imports `@modelcontextprotocol/sdk`. The skills adapter imports `node:fs` and `yaml` and nothing else — no new dependency, `yaml` is already in.

### Target resolution

`parseTarget` currently returns `http | file | stdio`. It grows a `dir` kind and an adapter tag:

| Input | Adapter | Kind |
|---|---|---|
| `https://…` | mcp | http |
| `*.json` that exists | mcp | file |
| directory containing `SKILL.md` | skills | dir (single skill) |
| directory containing `*/SKILL.md` | skills | dir (skill set) |
| `.claude/skills` / `skills/` under a directory | skills | dir |
| anything else | mcp | stdio |

Directories are genuinely ambiguous (an MCP server project is also a directory), so detection probes for `SKILL.md` rather than guessing, and `--adapter mcp|skills` overrides it. Probe failure produces a message that names both possibilities rather than a bare parse error — this is the first thing a new user hits.

### Skills loader

Reads `SKILL.md` frontmatter (`name`, `description`, `license`, `allowed-tools`, …), body after the fence, recurses one level for a skills *directory*. Malformed frontmatter is a `Finding`, not a throw — a broken skill in a set of thirty must not take down the run, and "this one is unparseable" is itself a result worth reporting.

---

## 4. Runner and provider

`runEval` presents once per run and passes the `Presentation` to `provider.runTrial`, rather than passing the `Surface`. Presentation is pure and cheap, but doing it once makes byte-stability structural rather than a thing to remember.

`Provider.runTrial(presentation, scenario)`:
- `promptShape` takes declarations from the presentation instead of mapping `manifest.tools`.
- `SYSTEM_PROMPT` becomes `SYSTEM_PROMPT + (systemSuffix ?? '')`, with the cache breakpoint still on the whole system block, after the suffix.
- `toAnthropicTool` now converts a neutral declaration rather than a `ToolDef`. Same three lines.
- `estimate()` is unchanged in behaviour and now correctly prices the skills listing too, since it shares `promptShape`.

Everything else in the runner — warm-then-fan-out, bounded concurrency, never-retry-a-result, never-execute-a-tool — is untouched and applies identically. Invariant 7 (`run` never executes a tool) is *stronger* for skills: there is nothing to execute, only a routing decision.

---

## 5. Analyser — a deliberate, bounded deviation from §11

§11 assumes skills static analysis is covered by the ecosystem (SkillReducer, skill-creator) and has the adapter enter at the runner. I'd deviate on a narrow front, for two reasons: `pickrate inspect ./.claude/skills` printing nothing is a bad first run and the first run is the distribution strategy; and §11 itself names the 1024-character limit as "a real constraint to lint against". Those tools also *optimise* — this *measures*, and a measurement of a hard limit is not the same product.

So: a small skills rule set, no more.

Rules gain `appliesTo: SurfaceKind[]`; the existing seven declare `['mcp']`. `near-duplicate-description` is the exception — it reads only `name` and `description`, so it becomes `['mcp', 'skills']` unchanged, and near-duplicate skill descriptions are the single most direct cause of the sub-30% trigger rate §11 cites.

New in `src/analyser/rules/skills.ts`:

| Rule | Severity | Why |
|---|---|---|
| `skill-description-length` | error | Hard 1024-char limit; over it, the loader rejects the skill outright |
| `missing-skill-description` | error | No description, no trigger, pure context tax |
| `thin-skill-description` | warn | Sub-threshold word count, same logic as tools |
| `skill-description-no-triggers` | info | Description states what the skill *is* but never when to use it — the documented failure mode |
| `unparseable-skill` | error | Frontmatter missing or malformed |

`countManifestTokens` → `countSurfaceTokens`, and for skills reports **two** numbers, because they are billed differently and confusing them is the whole point of progressive disclosure:

- **routing tokens** — name + description per skill, resident in every request. This is the number that maps onto the MCP manifest total.
- **body tokens** — paid only when the skill triggers. Reported separately and never summed into the headline.

Deferred: §11's prefix-cache churn metric needs git history over `SKILL.md` files. Real, but it is a different kind of analysis (repo-historical, not surface-static) and should not hold this up.

---

## 6. Config

`server:` becomes `target:`, with `server:` accepted as a deprecated alias so every existing config and the checked-in fixture keep working:

```yaml
target:
  type: skills
  path: ./.claude/skills

defaults:
  presentation: skill-tool   # or pseudo-tool
```

`expect.tool` is now a misnomer for skills. Add `expect.select:` as the general spelling, keep `expect.tool:` as an alias — same field, and `tool: null` must keep meaning restraint under both names. Not worth a breaking rename for a word.

Scenario semantics are otherwise identical, which is the payoff: §11's recommended skills methodology (~20 queries, 8–10 that should trigger, 8–10 that shouldn't, near-misses most valuable) is *already* expressible in today's format. Restraint scenarios are `expect.select: null` and need no new machinery at all.

---

## 7. Reporter

- Kind-aware nouns: "tools" / "skills", `orphanTools` → `orphans`.
- Skills inspect output shows routing tokens as the headline and body tokens as a separate line.
- `SCHEMA_VERSION` → **2**. This is a genuine break (`toolCount` → `itemCount`, `orphanTools` → `orphans`, `source.adapter` added, `finding.tool` → `finding.item`) and M4 will pin on it. Better to break it now, before the GitHub Action exists, than after.

Orphan detection gets sharper for skills, and is worth calling out in the report copy: §11's "45% of installed skills never triggered" is precisely the orphan metric this already computes. That finding, run over a public corpus, is the launch post — and it needs the runner but no new scorer.

---

## 8. Fixtures

The offline story must hold for both adapters — that is what makes this developable without spend, and it is the seed corpus for M3.

```
test/fixtures/skills/clean/{git-review,changelog}/SKILL.md   zero warnings, by design
test/fixtures/skills/messy/…                                  trips every skills rule:
                                                              >1024 desc, missing desc,
                                                              near-duplicate pair,
                                                              malformed frontmatter
test/fixtures/trials/skills.json                              recorded TrialResult[]
test/fixtures/skills-eval.yaml                                pairs with both
```

Mirrors `git-server.json` / `messy-server.json` exactly, including the "clean fixture asserts zero warnings" test. The recorded trials must cover the projection path specifically: a `Skill(skill: x)` hit, a `Skill(skill: y)` confusion, a restraint pass, an over-call (`Skill` + something else), and an errored trial.

```bash
npm run dev -- inspect test/fixtures/skills/clean
npm run dev -- run test/fixtures/skills-eval.yaml --replay test/fixtures/trials/skills.json
```

---

## 9. Build order

Each step leaves the tree green and the MCP path working.

| # | Step | Notes |
|---|---|---|
| 1 | Types: `Manifest`→`Surface`, `items`, `SurfaceItem` union | Mechanical, large diff, no behaviour change. Land alone. |
| 2 | `connector/`→`adapters/mcp/`, introduce `Adapter`, MCP presenter = identity | Still MCP-only. Proves the seam costs nothing. |
| 3 | Scorer `project` hook (identity default) | ~10 lines. |
| 4 | Skills loader + fixtures + skills analyser rules | `inspect` works on skills. **No API key, no spend — shippable on its own.** |
| 5 | Skills presenter (both modes) + runner/provider wiring | `run` works on skills. |
| 6 | Reporter, `SCHEMA_VERSION` 2, CLI `--adapter`, docs | |

Steps 1–4 are the natural first release. `pickrate inspect ./.claude/skills` telling someone six of their thirty skills can never trigger is a finding they will act on, needs no credentials, and reaches a much larger audience than the MCP side — which is §11's "momentum lives in skills" argument, cashed out as a shipping order.

---

## 10. Consequences for M3 and M4

**M3 (mutator)** — §11 says every operator applies, and that holds: swap descriptions, blank a description, rename opaquely, inject decoys all map directly onto skills. Two adjustments:

- Operators must run over `SurfaceItem`, not `ToolDef` — so build the mutator *after* step 1, or it gets written twice.
- Open question §11.7 (do mutation scores mean the same thing across adapters?) becomes concrete here. Blanking one description out of 8 skills and out of 40 tools are not comparable operations. Baseline per adapter, report per adapter, and do not average them into one number until there is evidence that means anything.

**M4 (CI)** — no structural change beyond `SCHEMA_VERSION` 2. The Action gains an `adapter` input; a skills eval in CI is cheaper than an MCP one (no server to boot), which makes it the better demo.

---

## 11. Decisions — settled 25 July 2026

1. **Presentation default: `skill-tool`.** Measures the mechanism actually under test. `pseudo-tool` ships alongside it as a control, not as the default — giving every skill its own description slot is a more favourable surface than reality and the numbers would read optimistic.
2. **Skills analyser scope: accept the five-rule deviation from §11.** `inspect` refusing skill targets would break the zero-credential first run for the larger of the two audiences, and the 1024-character limit is objectively lintable. Five rules, no creep — the ecosystem's optimisers stay out of scope.
3. **Name: `pickrate`** (free on npm, checked). Closes spec §8.6.

   Selection rate is the primary metric across both adapters, so the name survives the MCP/skills split without lying about scope. It is deliberately a **noun**: `mcpeval` and `toolcheck` are imperatives that imply the tool acts on your server, and this tool measures rather than repairs — the same boundary against SkillReducer that §11 draws. A noun names the reading it hands back. "This PR dropped pickrate from 94% to 71%" is the sentence the whole project exists to produce.

   Rename touches `package.json` (`name`, `bin`, `description`, keywords), the `VERSION`/`USAGE` block in `src/cli.ts`, `CLIENT_INFO` in the MCP adapter, `CredentialError`'s hint text, both reporters' headers, the README, and the example configs. Land it with step 1 or before — never after publishing.
