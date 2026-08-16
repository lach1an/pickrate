#!/usr/bin/env node
/**
 * Analyse every target in the corpus manifest and report the distribution.
 *
 * **Not a test**, and not a CLI command. It touches the network (MCP targets
 * are launched over stdio), and M5 is a measurement session rather than a
 * product feature — a `pickrate leaderboard` command would be a permanent
 * public API bought to serve one blog post.
 *
 *     npx tsx scripts/sweep.ts                        # every target
 *     npx tsx scripts/sweep.ts filesystem memory      # a subset
 *     npx tsx scripts/sweep.ts --out sweep.json       # machine-readable too
 *     npx tsx scripts/sweep.ts --manifest test/fixtures/sweep-targets.yaml   # offline check
 *     npx tsx scripts/sweep.ts sqlite --timeout 300000   # slow uvx resolution
 *
 * **No API key, no model call, no cost** — it is `inspect` over N surfaces, so
 * invariant 1 holds and anyone can reproduce it for nothing.
 *
 * It imports from `src/` rather than shelling out to the CLI: no subprocess, no
 * reparsing of JSON we just printed, and a type error the moment a report shape
 * moves under it.
 *
 * What this cannot produce: an orphan rate. Spec §8 q9 files "45% of skills
 * never trigger" under "needs no runner — just an analyser and a scenario set",
 * and that is wrong — an orphan is `findOrphans` over scored trials, so it
 * needs the runner and a paid run. What comes out here is the lint and token
 * distribution, which is a different and cheaper finding.
 */
import { writeFileSync } from 'node:fs';
import { analyse, countBySeverity, loadSurface, type Analysis, type Severity } from '../src/index.js';
import { loadTargets, resolveTarget, surfaceHashOf, type CorpusTarget } from './targets.js';

const args = process.argv.slice(2);
const out = valueOf('--out');
const manifest = valueOf('--manifest');
/**
 * Generous by default and adjustable, because startup cost varies by two orders
 * of magnitude. A warm `npx` server answers in a second; `uvx --exclude-newer`
 * re-resolves a dated dependency graph and `mcp-server-sqlite` has been measured
 * at 186s. A budget tight enough to keep the sweep brisk turns a slow server
 * into a fabricated "would not load".
 */
const timeoutMs = Number(valueOf('--timeout') ?? 60_000);
// Built only from flags actually present: `indexOf` returns -1 when one is
// absent, and -1 + 1 = 0 would silently swallow the first target id.
const flagged = new Set<number>();
for (const flag of ['--out', '--manifest', '--timeout']) {
  const i = args.indexOf(flag);
  if (i !== -1) flagged.add(i).add(i + 1);
}
const only = new Set(args.filter((_, i) => !flagged.has(i)));

const all = manifest === undefined ? loadTargets() : loadTargets(manifest);
for (const id of only) {
  if (!all.some((t) => t.id === id)) throw new Error(`No target "${id}" in corpus/targets.yaml.`);
}
const targets = all.filter((t) => only.size === 0 || only.has(t.id));

interface SweepRow {
  id: string;
  adapter: 'mcp' | 'skills';
  control: boolean;
  /** Absent when the surface would not load, or was refused — both results, not crashes. */
  analysis?: Analysis;
  error?: string;
  /** What the surface actually hashed to, whether or not the manifest declared one. */
  surfaceHash?: string;
  /** Declared and observed disagree: the pin did not hold. */
  drifted?: boolean;
}

const targetsById = new Map(targets.map((t) => [t.id, t]));
const rows: SweepRow[] = [];
for (const target of targets) {
  process.stderr.write(`${target.id}… `);
  rows.push(await sweepOne(target));
  process.stderr.write('\n');
}

process.stdout.write(render(rows));
if (out !== undefined) {
  writeFileSync(out, `${JSON.stringify({ sweptAt: new Date().toISOString(), targets: rows }, null, 2)}\n`);
  process.stderr.write(`\nwrote ${out}\n`);
}

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
  return value;
}

async function sweepOne(target: CorpusTarget): Promise<SweepRow> {
  const row: SweepRow = { id: target.id, adapter: target.adapter, control: target.control === true };
  try {
    const surface = await loadSurface(resolveTarget(target), { timeoutMs });
    const hash = surfaceHashOf(surface);
    row.surfaceHash = hash;

    // Refused, not analysed. A drifted pin means this is no longer the surface
    // the manifest names, and reporting findings against it would file them
    // under a target that did not produce them — the same reason `diffReports`
    // refuses a mismatched baseline instead of projecting it.
    if (target.surfaceHash !== undefined && target.surfaceHash !== hash) {
      row.drifted = true;
      row.error =
        `surface drifted: manifest pins ${target.surfaceHash}, server served ${hash}. ` +
        'The version is pinned; something it depends on is not.';
      return row;
    }

    row.analysis = analyse(surface);
  } catch (error) {
    // One unreachable server must not end the sweep — the other fourteen are
    // still a result, and a target that will not load is a finding of its own.
    row.error = error instanceof Error ? error.message : String(error);
  }
  return row;
}

function render(rows: SweepRow[]): string {
  const lines: string[] = ['# Corpus sweep', ''];

  lines.push('| target | adapter | items | resident | deferred | error | warn | info |');
  lines.push('|---|---|--:|--:|--:|--:|--:|--:|');
  for (const row of rows) {
    const label = row.control ? `${row.id} *(control)*` : row.id;
    if (row.analysis === undefined) {
      lines.push(`| ${label} | ${row.adapter} | — | — | — | — | — | — |`);
      continue;
    }
    const { itemCount, tokens, findings } = row.analysis;
    const counts = countBySeverity(findings);
    const deferred = tokens.deferred === undefined ? '—' : String(tokens.deferred);
    lines.push(
      `| ${label} | ${row.adapter} | ${itemCount} | ${tokens.total} | ${deferred} | ` +
        `${counts.error} | ${counts.warn} | ${counts.info} |`,
    );
  }

  const encodings = new Set(rows.flatMap((r) => (r.analysis ? [r.analysis.tokens.encoding] : [])));
  lines.push('');
  lines.push(
    `Token counts are approximate (${[...encodings].join(', ')}) and are **resident** cost — ` +
      'skills bodies are deferred and never summed into the total. The offline tokeniser ' +
      'has been measured at −47% to +55% against the providers\' own counters, and the sign ' +
      'changes by provider as well as adapter, so no correction factor is applied. ' +
      'See scripts/calibrate-tokens.ts.',
  );

  const drifted = rows.filter((r) => r.drifted === true);
  if (drifted.length > 0) {
    lines.push('', '## Refused — the pin did not hold', '');
    for (const row of drifted) lines.push(`- **${row.id}** — ${row.error}`);
  }

  const failed = rows.filter((r) => r.error !== undefined && r.drifted !== true);
  if (failed.length > 0) {
    lines.push('', '## Would not load', '');
    for (const row of failed) lines.push(`- **${row.id}** — ${row.error}`);
  }

  const hashed = rows.filter((r) => r.surfaceHash !== undefined);
  const unpinned = hashed.filter((r) => r.adapter === 'mcp' && targetsById.get(r.id)?.surfaceHash === undefined);
  if (unpinned.length > 0) {
    lines.push('', '## Unpinned', '');
    lines.push('These MCP targets declare no `surfaceHash`, so drift in a dependency would pass unnoticed. Paste each into `corpus/targets.yaml`:', '');
    for (const row of unpinned) lines.push(`- \`${row.id}\`: \`surfaceHash: ${row.surfaceHash}\``);
  }

  lines.push('', '## Findings by rule', '');
  const byRule = new Map<string, { severity: Severity; targets: Map<string, number> }>();
  for (const row of rows) {
    for (const finding of row.analysis?.findings ?? []) {
      const entry = byRule.get(finding.rule) ?? { severity: finding.severity, targets: new Map() };
      entry.targets.set(row.id, (entry.targets.get(row.id) ?? 0) + 1);
      byRule.set(finding.rule, entry);
    }
  }

  if (byRule.size === 0) {
    lines.push('No findings across the corpus.');
  } else {
    lines.push('| rule | severity | targets | total |');
    lines.push('|---|---|--:|--:|');
    const sorted = [...byRule].sort((a, b) => total(b[1].targets) - total(a[1].targets) || a[0].localeCompare(b[0]));
    for (const [rule, entry] of sorted) {
      lines.push(`| \`${rule}\` | ${entry.severity} | ${entry.targets.size} | ${total(entry.targets)} |`);
    }
  }

  const mcp = rows.filter((r) => r.adapter === 'mcp' && r.analysis !== undefined);
  if (mcp.length > 0) {
    lines.push('', '## Protocol', '');
    lines.push('| target | revision | list order stable |');
    lines.push('|---|---|---|');
    for (const row of mcp) {
      const { protocolVersion, listOrderStable } = row.analysis!.source;
      // Absent is not false: a re-list that threw leaves the answer unknown
      // rather than claiming instability.
      const stable = listOrderStable === undefined ? 'unknown' : listOrderStable ? 'yes' : 'no';
      lines.push(`| ${row.id} | ${protocolVersion ?? 'unknown'} | ${stable} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function total(counts: Map<string, number>): number {
  let sum = 0;
  for (const n of counts.values()) sum += n;
  return sum;
}
