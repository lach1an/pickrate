# mcpeval — working notes

Full spec: [`plans/mcp-eval-spec.md`](plans/mcp-eval-spec.md). Read it before making design decisions; it settles most of them.

## Current state

**M1 (analyser) — in progress.** `mcpeval inspect <target>` connects, pulls the manifest, reports token cost and lint findings.
M2 (runner + scorer), M3 (mutator), M4 (CI) are not started.

## Invariants

These are load-bearing, not preferences:

1. **`inspect` never makes a model call and never requires an API key.** The zero-credential first run is the distribution strategy, not a nicety. Analyser rules are pure: `Manifest` in, `Finding[]` out.
2. **Only `src/connector/` imports `@modelcontextprotocol/sdk`.** Everything else consumes `Manifest` from `src/types.ts`. The spec finalises `2026-07-28` (stateless, no `initialize`, no `Mcp-Session-Id`, new `Mcp-Method`/`Mcp-Name` routing headers) and the SDKs will churn. Contain it.
3. **Every eval assertion is a pass rate over N trials, never a boolean.** Tool selection is non-deterministic; a binary assertion passes Tuesday and fails Wednesday. This governs M2's API design.
4. **Score selection, arguments and restraint separately.** Different bugs, different fixes. Restraint (correctly calling *nothing*) is the most neglected.
5. **Diagnostics outrank the headline number in the report.** Goodhart: the moment someone optimises the score they write descriptions that game it. Confusion pairs, orphan tools and token cost go above any total.

## Stack

Node ≥20.19, TypeScript (strict, `exactOptionalPropertyTypes`), ESM, `tsc` to `dist/`. Tests are `node:test` via `tsx`, offline, no snapshots. Arg parsing is `node:util` `parseArgs` — no CLI framework.

Current SDK (`1.29.0`) still negotiates protocol `2025-11-25` and still does the initialize handshake. No `2026-07-28` SDK has shipped yet. When one does, the change should land in `src/connector/index.ts` and nowhere else.

## Fixtures

`test/fixtures/*.json` are captured `tools/list` responses. `loadManifestFromFile` reads them, so the analyser, and later the scorer, can be developed with no server running and no API spend. `git-server.json` is deliberately clean (it must produce zero warnings — a test asserts this); `messy-server.json` deliberately trips every rule. They are also the seed corpus for M3's mutation testing.

## Conventions

- Rules live in `src/analyser/rules/`, grouped by theme, registered in `rules/index.ts`. Thresholds are exported named constants, not inline literals.
- Findings anchor to `tool` and a schema `path` where they can. `detail` is for `--json` consumers only.
- The JSON report shape is versioned (`SCHEMA_VERSION`); M4's CI integration will pin on it.
