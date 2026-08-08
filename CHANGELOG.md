# Changelog

## 0.2.0 — 2026-08-08

### Breaking

- **The JSON report is at `schemaVersion` 3.** Every report now carries `provider`, `reasoning`, `toolSearch` and `regimeHash` as required fields, `usage` gained optional cache buckets, and `model` is the id the **API returned** rather than the one requested (`requestedModel` carries the alias when they differ). A baseline written by `0.1.0` is *refused* by `--baseline`, not projected — the comparison would be across an unknown instrument. Re-record it: `pickrate run <config> --out <baseline.json>`.

### Added

- **A second provider.** `openai` ships alongside `anthropic`, chosen from the model id, with `--provider` to settle what a prefix cannot. Its default (`gpt-5.6-luna`) was picked by measurement, like the other one: at the effort pickrate sends it spent fewer output tokens per trial than the `anthropic` default and cost 2.5× less, while the tier above it cost 2.45× more and scored worse on the discriminating scenario. Scores are still never compared across providers — the provider is part of the regime hash, and `--baseline` refuses the comparison.
- **`openai-api-key` on the Action**, so `run` and `mutate` can use either provider in CI. It previously took an Anthropic key only, which made the second provider unreachable from the Action that shipped alongside it. This one landed just *after* the `v0.2.0` tag: the Action is consumed from the repository at `@v0` rather than from the npm tarball, so it reached users when that pointer moved, and the published `0.2.0` package is identical either way.
- **MCP `2026-07-28`, including the transport.** Real dual-protocol negotiation on `@modelcontextprotocol/client@2` — the 2026 revision where a server offers it, the 2025 handshake where it does not. The v1 `@modelcontextprotocol/sdk` is no longer a dependency.
- **Five cache and ordering lints**: `unstable-list-order`, `missing-cache-ttl`, `missing-cache-scope`, `public-cache-scope`, and `legacy-protocol` — which fires when the other cache checks were *skipped* rather than passed, so silence and a pass never read the same.
- `--record <file>`, which saves a run's raw trials for offline replay later.
- Run provenance on every report, printed beside the score: provider, reasoning config, loading regime, and a hash of the request envelope.

### Changed

- **A mutant is killed on its worst per-scenario drop, never the mean.** A mean dilutes the finding in proportion to corpus size: in the first corpus session, a blanked description that took its own scenario from 100% to 30% was reported as a survivor, because 70 points across sixteen scenarios is 4.4 points of mean. The floor moved with it — it is now the widest gap any single scenario showed between the two clean runs.
- **Mutants land on exercised items first.** Surface order is alphabetical and unrelated to what you tested; the first corpus session put three of six mutants on one orphan skill. Untested items stay eligible once the tested ones are exhausted.
- **The prompt-cache warm-up is now conditional**, on the model's cache behaviour and on the surface clearing its minimum cacheable prefix. Below that line a prefix silently does not cache, and the warm-up bought a round trip and nothing else.
- Declaration order is normalised (code-unit order by name) before presentation. A server that reorders between trials invalidates the cached prefix on every one of them — no error, roughly 10× the bill. This changes what scores mean, so it is a measurement decision and not a bugfix.
- `--dry-run` on `mutate` prices each leg separately, since `inject-decoys` grows the manifest by design.

### Fixed

- **`pickrate run` on the default model failed every trial.** The Anthropic provider sent `output_config.effort` unconditionally while `claude-haiku-4-5` declares no reasoning, so the default path — no flags — returned a 400 on all 80 trials. Both providers now read one shared `reasoningFor(model)`, in the request *and* in the reported regime.
- A model alias resolving to a dated snapshot with no pricing entry dropped the cost line from the report entirely.
- The cost estimate priced trials below a model's minimum cacheable prefix as cache reads, under-reporting by roughly 10× on every small manifest, and `OUTPUT_TOKENS_PER_TRIAL` was 80 against 150 measured.
- A truncated response is now an errored trial rather than restraint. `max_tokens` means we never found out what the model chose, which is not the same as it choosing nothing — and on a restraint scenario the difference is a false pass in the most neglected metric.
- The protocol-revision probe read `protocolVersions` where the field is `supportedVersions`, so `legacy-protocol` fired against servers that were not legacy. Every failure path in that probe returned `undefined` by design, which made the bug and a legacy server indistinguishable; it is deleted rather than patched.

## 0.1.0 — 2026-07-25

First release. `inspect` (static analysis, no API key), `run` (selection eval) and `mutate` (mutation score over injected defects), on MCP servers and Agent Skills directories alike, with the CI surface: an exit-code contract, gates in the config file, baseline comparison, and a composite Action.
