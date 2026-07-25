# M4 — CI-ready: implementation plan

**Status:** agreed, in progress — step 1 next
**Date:** 25 July 2026
**Implements:** [`mcp-eval-spec.md`](mcp-eval-spec.md) §7 (M4)
**Follows:** M3 (mutator), complete

---

## 0. What §7 says, and the one thing it understates

M4 is listed as four things: "JSON output, exit codes, a GitHub Action wrapper, threshold config." Two of those substantially exist. `--json` ships on all three commands against a versioned schema, and the CLI already returns 0/1/2/130 with the "a run that measured nothing must not look like a pass" rule in it.

What §7 understates is §6's own reframe:

> Nobody buys "your server scores 87/100" — unfalsifiable and they know it. They buy "this PR dropped selection from 94% to 71%."

A regression detector needs **two measurements and a noise floor**, and today the CLI produces one measurement per invocation and throws it away. Without a baseline, "CI-ready" means a build that goes red when an absolute threshold is crossed — which is a linter, not a regression detector, and it goes red on the noise as readily as on the regression. M3 already established what that costs: a score built on one baseline is a count of coin flips.

So M4 is **five** things, and the fifth is the one with the value in it:

| # | Piece | State today |
|---|---|---|
| 1 | JSON output on a pinned schema | exists (`SCHEMA_VERSION` 2) — needs to become load-bearing, i.e. read back and tested |
| 2 | Exit codes | exist ad hoc in `cli.ts` — needs a contract |
| 3 | Threshold config | scattered across `--fail-on`, `--min-score`, per-scenario `threshold` — needs to live in the repo |
| 4 | GitHub Action wrapper | none |
| 5 | **Baseline comparison** | none — the thing people actually buy |

---

## 1. Decisions that need making before code

### 1.1 Gates live in the config file, not the workflow

A threshold argued over in review belongs in the repo next to the scenarios, not in a YAML string in `.github/workflows/`. New top-level `ci:` block, CLI flags override it, and every gate is off by default except one:

```yaml
ci:
  failOn: warn        # inspect: findings at or above this severity
  maxTokens: 20000    # inspect: resident tokens (skills bodies never counted)
  maxFlaky: 0         # run: scenarios in the 20–80% band
  maxOrphans: 0       # run: items no scenario ever selected
  maxErrorRate: 0.1   # run: trials that errored — DEFAULT 0.1, see below
  maxRegression: 0.05 # run --baseline: worst per-scenario drop
  minScore: 0.7       # mutate: mutation score floor
```

**`maxErrorRate` is the one gate that defaults on, and it defaults to a hard failure rather than a soft one.** Errored trials leave the denominator (M2 decision) — so a run where 18 of 20 trials failed on transport reports a confident 100% from the two that survived. Locally that is fine, because a human sees the "18 errors" line. In CI nobody reads the log of a green build. Above the rate, the run is *unmeasured*, exit 2, not exit 1.

### 1.2 Exit codes distinguish "bad answer" from "no answer"

`src/exit.ts`, one enum, used everywhere:

| Code | Meaning | Cause |
|---|---|---|
| 0 | measured, gates passed | |
| 1 | **measured, and the answer is bad** | threshold breach, `failOn`, `minScore`, regression |
| 2 | **could not measure** | usage/config error, target unreachable, every trial errored, `maxErrorRate` breached |
| 130 | cancelled | declined the cost confirmation |

The 1/2 split is the whole point of the table: a dead server must never read as a failed eval, and a failed eval must never read as green. This is the existing behaviour promoted to a contract with a test on it.

### 1.3 The baseline diff is honest about noise or it is worse than nothing

`run --baseline previous.json` compares scenario-by-scenario against a stored report. Two rules, both non-negotiable:

- **A diff between two single runs is not a noise measurement.** M3 measures its floor by running the clean surface *twice*; `run --baseline` has one run per side and cannot. So `maxRegression` is floored at `minNoise(trials)` — imported from `src/mutator/index.ts`, not reimplemented, because two copies of the noise floor will drift — and the report says in words that the honest floor comes from `mutate` or from more trials.
- **A mismatched baseline is refused, not projected.** Different `schemaVersion`, adapter, model, presentation, or a different set of scenario ids → error, exit 2. Same discipline as `ReplayProvider` refusing a foreign presentation mode: a comparison across models is a number that looks like a regression and is a model swap.

**The instrument drifts, which no comparable tool has to handle.** Codecov's baseline goes stale but the compiler is pinned; here `claude-haiku-4-5` is an *alias* the provider can re-point underneath a stored baseline, so a two-week-old comparison silently mixes a description change with a model update. The mismatch check above only bites if the config pins a dated snapshot. So: `--baseline` warns when the recorded model is an alias rather than a dated id, the docs recommend pinning one in any config used for comparison, and the baseline is refreshed on a schedule (§1.5) so staleness stays visible instead of accumulating into one large unexplained gap.

Gate on the **worst per-scenario drop**, not the mean. A mean hides one scenario collapsing behind five that improved, and the scenario that collapsed is the one destined for production.

### 1.4 pickrate does not talk to GitHub

The CLI's only network calls stay: the adapter's, and the provider's. Posting PR comments, uploading artifacts and writing step summaries are the Action's job, done with `gh` and shell redirection. Keeping it that way means the whole CI surface is testable offline and there is no GitHub token anywhere in `src/`.

Consequence: the CLI needs to emit a machine artifact and a human artifact from **one** run — running `run` twice to get both formats doubles the bill. So `--out <file>` always writes JSON, whatever `--format` puts on stdout.

### 1.5 The baseline is a committed file, not a CI artifact

Four patterns exist in comparable tools:

| Pattern | Who does it | Why not here |
|---|---|---|
| Recompute both sides in one job | `size-limit-action`, `bundlewatch` | Works because bundle size is deterministic and free. Doubles the API bill on every PR. |
| Restore the last CI artifact | Lighthouse CI temporary storage, `upload-artifact` + download | Zero infrastructure, so it ships as the fallback — but artifacts expire, aren't addressable by sha, and a red main branch means no artifact and therefore no gate, silently |
| **Commit the baseline to the repo** | PHPStan/Psalm baselines, `tsc-baseline`, **Stryker's `stryker-incremental.json`** | ✅ the recommendation |
| A store outside the repo | `github-action-benchmark` (gh-pages), Codecov, Chromatic, Stryker Dashboard | Where a hosted product attaches later (spec §8.6). Needs nothing from M4 beyond the pinned schema. |

Stryker is the closest analogue and lands on a committed file for the same reason that applies here: **the measurement is expensive, so you cannot re-derive the base side on demand.** Committing it also suits a *stochastic* number better than any automatic store does — the baseline moving is a reviewed diff, and a human seeing "94% → 91%" in a PR decides whether that is drift or damage. An automatic store makes that decision by silence.

So, documented path:

```bash
pickrate run pickrate.yaml --out pickrate-baseline.json   # on master, committed
pickrate run pickrate.yaml --baseline pickrate-baseline.json   # on PRs
```

plus a **weekly scheduled refresh** on master that opens a PR when the baseline moves more than the floor — that is what keeps §1.3's drift visible. The artifact-restore variant ships in the example workflow for people who would rather not commit a file, with its "no artifact means no gate" failure mode written down next to it.

Note what the CLI learns from all of this: nothing. Both paths are `--baseline <path>`, storage stays entirely in the workflow, and decision 1.4 survives.

---

## 2. Config and type changes

`src/types.ts`:

```ts
export interface CiGates {
  failOn?: Severity | null;
  maxTokens?: number;
  maxFlaky?: number;
  maxOrphans?: number;
  maxErrorRate: number;     // the one with a default
  maxRegression?: number;
  minScore?: number;
}

export interface GateResult {
  id: string;               // 'max-flaky', 'max-regression', …
  limit: number | string;
  observed: number | string;
  passed: boolean;
  /** Breached this way means unmeasured (exit 2), not bad (exit 1). */
  unmeasured?: boolean;
  message: string;
}

export interface ReportDiff {
  baseline: { model: string; startedAt: string; path: string };
  floor: number;            // max(maxRegression, minNoise(trials))
  scenarios: Array<{ id: string; baseline: number; head: number; delta: number; regressed: boolean }>;
  meanDelta: number;
  newFailures: string[];
  fixed: string[];
  newOrphans: string[];
}
```

`EvalConfig` gains `ci: CiGates`. `parseConfig` validates it with the existing `ConfigError` path-into-the-document style; unknown keys under `ci:` are an error, because a silently ignored `maxFlakey:` is a gate that never fires.

---

## 3. Module layout

Mirrors the existing seams — pure logic in a module, `cli.ts` stays a thin arg-parser.

```
src/exit.ts              the exit-code enum, nothing else
src/ci/gates.ts          evaluateGates(analysis|report|mutation, gates) → GateResult[]   pure
src/ci/compare.ts        diff(baseline, head, floor) → ReportDiff                        pure
src/ci/report-file.ts    readReportFile(path) → validated stored report
src/report/markdown.ts   formatAnalysisMarkdown / EvalMarkdown / MutationMarkdown
```

`src/ci/gates.ts` is pure in the analyser's sense: reports in, results out, no I/O and no model. Every gate is then testable against the existing replay fixtures with no key and no spend.

`src/report/markdown.ts` is a third formatter, not a colour-stripped table — GitHub renders tables, and a step summary wants a table plus the same diagnostics-above-the-number ordering the terminal report uses. It takes its noun from `source.adapter` via `itemNoun` like every other formatter; the existing "the word *tool* never appears on a skills report" test extends to it.

---

## 4. CLI surface

```
shared:   --format <table|json|markdown>   (--json stays as an alias for --format json)
          --out <file>                     always JSON, regardless of --format
          --config <file>                  inspect only: read the ci: block (and target:)
run:      --baseline <file>                compare against a stored JSON report
          --max-regression <0..1>          overrides ci.maxRegression
          --max-flaky <n> --max-orphans <n> --max-error-rate <0..1>
mutate:   --min-score already exists; ci.minScore becomes its default
```

`inspect --config pickrate.yaml` with no positional target reads `target:` from the config too, so one file drives all three commands and the Action needs a single input.

The JSON reports gain `gates: GateResult[]` and, for `run --baseline`, `diff: ReportDiff`. Both are **additive**, so `SCHEMA_VERSION` stays 2 — a consumer pinned on 2 ignores keys it has never seen. From the moment the Action ships, the rule in CLAUDE.md is in force for real: additions are free, renames and removals cost a bump.

---

## 5. The Action

`action.yml` at the repo root, composite, so it is `uses: lach1an/pickrate@v0` with no Docker build.

```yaml
inputs:
  command:            # inspect | run | mutate     default: inspect
  config:             # path to pickrate.yaml
  target:             # overrides config.target
  adapter:            # mcp | skills
  version:            # npm version range, or 'local' to use the checked-out build
  anthropic-api-key:  # omit for inspect — that is the point of inspect
  baseline:           # path to a previous JSON report
  comment:            # post/update a PR comment      default: false
  summary:            # write $GITHUB_STEP_SUMMARY    default: true
  artifact:           # upload the JSON report        default: true
outputs:
  exit-code, score, report-path
```

Steps: `setup-node` → resolve the CLI (`npx pickrate@<version>`, or build the checkout when `version: local`) → one invocation with `--format markdown --out pickrate-report.json` → append stdout to `$GITHUB_STEP_SUMMARY` → optional `gh pr comment` (find-by-marker and edit, so a 30-commit PR has one comment, not thirty) → optional `upload-artifact` → exit with the CLI's code.

`version: local` exists so the Action can be exercised in its own repo. An Action that is only tested by its consumers is not tested.

**Two workflows ship with it:**

- `.github/workflows/ci.yml` — the repo's own: typecheck, `npm test`, plus `inspect` on both messy fixtures and a replayed `run` on both trial fixtures. **No key, no spend**, and it means every push exercises the whole eval pipeline end to end. Default branch is **`master`** — the repo has no `main`, and renaming it to satisfy a convention would break every `uses:` and baseline path written here for nothing.
- `examples/workflows/eval.yml` — the one people copy: `inspect` on every PR (free), `run` gated behind `secrets.ANTHROPIC_API_KEY != ''` with `--baseline pickrate-baseline.json` from the committed file, and `mutate` on a weekly schedule because it is the expensive one. The artifact-restore variant sits in the same file, commented out, with its "no artifact means no gate" caveat next to it.
- `examples/workflows/baseline-refresh.yml` — the weekly job from §1.5: re-run on main, and open a PR when the baseline moves more than the floor. It is the only thing standing between a committed baseline and silent staleness, so it ships with the pattern rather than as an afterthought.

Secret hygiene: the key reaches the CLI as an env var only, never an argument (it would land in the command trace), and no report field ever carries it. Worth a line in the invariants.

---

## 6. Tests — all offline

| Test | Asserts |
|---|---|
| `test/gates.test.ts` | each gate fires and does not fire, against the replay fixtures; `maxErrorRate` breach yields exit 2, not 1 |
| `test/compare.test.ts` | a drop below the floor is not a regression; a mismatched model/adapter/presentation/scenario-set is refused; `minNoise` is the floor when `maxRegression` is smaller; an aliased model id warns while a dated snapshot does not |
| `test/schema.test.ts` | the exact key set of all four JSON payloads, so an accidental rename fails a test instead of a consumer's pipeline — plus `cli.ts`'s `VERSION` equals `package.json`'s |
| `test/markdown.test.ts` | diagnostics render above the headline number; the word "tool" never appears on a skills report |
| `test/exit.test.ts` | the 0/1/2/130 table, driven through `main()` with replay |

New fixture: `test/fixtures/reports/git-server-baseline.json` — a stored `run` report to diff against, with one scenario deliberately a few points higher than the replayed run and one deliberately below the floor, so the "a small drop is not a regression" case is exercised by construction rather than by luck.

---

## 7. Build order

Each step leaves the tree green and ships on its own.

| # | Step | Cost |
|---|---|---|
| 1 | `src/exit.ts`, `ci:` config block + validation, `src/ci/gates.ts`, `--out`, `inspect --config` | offline |
| 2 | `src/report/markdown.ts` + `--format` (with `--json` aliased) | offline |
| 3 | `src/ci/compare.ts`, `readReportFile`, `run --baseline`, schema-freeze test | offline |
| 4 | `action.yml`, `.github/workflows/ci.yml`, `examples/workflows/eval.yml` | one live run to prove it |
| 5 | README M4 section, CLAUDE.md invariants + decisions, version → 0.1.0 | free |

Steps 1–3 are the release. The Action is packaging on top of a CLI that is already CI-correct; if the exit codes and the diff are right, the Action is fifty lines of YAML, and if they are wrong no amount of YAML saves it.

The version bump to **0.1.0** belongs in step 5 and matters: the Action pins a published range, so M4 is the first milestone that has to actually be on npm.

### 7.1 Release prerequisites

**Two remain, both at step 5:**

1. **Trusted publishing is not configured.** The release workflow should publish via npm's **OIDC trusted publishing**, configured on npmjs.com against `lach1an/pickrate` and the workflow file — not a long-lived `NPM_TOKEN` secret. It also yields provenance attestation, which for a tool whose entire pitch is "how much should you trust this report" is not merely hygiene.
2. **The `0.1.0` bump touches two places.** `package.json` and the hardcoded `VERSION` constant in `src/cli.ts` are duplicates today. The schema-freeze test in §6 asserts they match, so bump them together or the suite catches it — which is the point of putting that assertion in.

**Discharged 25 July 2026:**

- **GitHub.** Public at `lach1an/pickrate`, default branch **`master`**. Public was effectively forced: an Action in a private repo can only be `uses:` from inside the same org, which would make step 4's deliverable unusable by anyone else.
- **npm.** Name claimed, published manually as `0.0.0`. Packaging verified from a clean install — `npx pickrate@0.0.0 inspect ./messy` renders findings with no API key, and the registry tarball's shasum matches a local `npm pack` byte for byte. Invariant 1's zero-credential first run now demonstrably works for someone who is not the author.

A note for whoever writes the workflows: git here is configured for **SSH**, so the `workflow`-scope restriction that bites PAT-over-HTTPS pushes does not apply — `.github/workflows/*` pushes fine with the existing key.

---

## 8. Open questions

1. **Does `run` gate on a mean score at all?** Recommendation: no. Per-scenario thresholds already gate, and a headline mean is the number people optimise — §6's Goodhart warning, cashed out as a missing feature on purpose.
2. **How stale is too stale for a committed baseline?** §1.5 settles *where* it lives; the weekly refresh is a guess at the cadence. Model aliases re-point on nobody's schedule, so the honest answer needs M5's live runs. Until then the refresh job is the mitigation and the alias warning is the tripwire.
3. **`pickrate compare a.json b.json` as a standalone command?** All the machinery exists once step 3 lands, and it would need no API key. Deferred: one more command surface for a case `--baseline` already covers.
4. **Does `maxErrorRate: 0.1` want to be stricter?** It is a judgement call made without data. Revisit after M5, when there are real runs against real servers to look at.
