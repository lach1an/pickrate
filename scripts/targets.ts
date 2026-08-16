/**
 * The M5 corpus manifest: `corpus/targets.yaml` in, typed targets out.
 *
 * Shared by `fetch-corpus.ts` and `sweep.ts` so the corpus is defined once. It
 * lives in `scripts/` rather than `src/` deliberately — the corpus is a
 * measurement session's input, not part of the published tool, and nothing
 * under `src/` should grow a dependency on a file that only exists on the
 * author's machine.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseTarget, type Target } from '../src/adapters/target.js';
import { adapterFor } from '../src/adapters/index.js';
import type { Surface } from '../src/types.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS = join(ROOT, 'corpus');
export const MANIFEST = join(CORPUS, 'targets.yaml');

/** An empty directory for servers that require a path argument, so a manifest never varies with the host. */
export const SANDBOX = join(CORPUS, '.sandbox');

export interface GitSource {
  repo: string;
  /** Pinned: a corpus that drifts makes every number recorded against it unattributable. */
  sha: string;
  /** Repo-relative directories, each either a skill or a parent of skills. */
  paths: string[];
}

export interface StdioSource {
  command: string;
  args: string[];
}

export interface CorpusTarget {
  id: string;
  adapter: 'mcp' | 'skills';
  git?: GitSource;
  stdio?: StdioSource;
  /** An already-present skills directory or captured manifest, relative to the repo root. */
  local?: string;
  /**
   * Expected `surfaceHashOf` for an MCP target. Absent means unpinned.
   *
   * MCP targets need this and git-sourced skills do not, and the asymmetry is
   * the point: a git SHA is content-addressed, so it genuinely pins the bytes.
   * `npx -y pkg@version` pins the package and nothing it depends on — which is
   * the exact mechanism that turned `server-filesystem@2025.8.21` from correct
   * schemas into parameter-less ones (plans/m5-leaderboard.md §3.2). Without a
   * hash the version string is a pin in appearance only.
   */
  surfaceHash?: string;
  credentialed?: boolean;
  /** A known-shape target that proves the sweep works; never a finding source. */
  control?: boolean;
}

export function loadTargets(file = MANIFEST): CorpusTarget[] {
  const parsed: unknown = parse(readFileSync(file, 'utf8'));
  const targets = (parsed as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) throw new Error(`${file}: expected a top-level "targets:" list.`);

  const seen = new Set<string>();
  return targets.map((raw, i) => {
    const target = validate(raw, i, file);
    if (seen.has(target.id)) throw new Error(`${file}: duplicate target id "${target.id}".`);
    seen.add(target.id);
    return target;
  });
}

function validate(raw: unknown, index: number, file: string): CorpusTarget {
  const at = `${file}: targets[${index}]`;
  if (typeof raw !== 'object' || raw === null) throw new Error(`${at} is not a mapping.`);
  const t = raw as Record<string, unknown>;

  const id = t['id'];
  if (typeof id !== 'string' || id === '') throw new Error(`${at} has no id.`);

  const adapter = t['adapter'];
  if (adapter !== 'mcp' && adapter !== 'skills') {
    throw new Error(`${at} (${id}): adapter must be "mcp" or "skills".`);
  }

  // Secrets have nowhere to live yet, so a credentialed target is refused rather than half-supported.
  if (t['credentialed'] === true) {
    throw new Error(`${at} (${id}): credentialed targets are not supported — see plans/m5-leaderboard.md §0.`);
  }

  const target: CorpusTarget = { id, adapter };
  if (t['control'] === true) target.control = true;
  if (t['credentialed'] === false) target.credentialed = false;

  const surfaceHash = t['surfaceHash'];
  if (surfaceHash !== undefined) {
    if (typeof surfaceHash !== 'string') throw new Error(`${at} (${id}): surfaceHash must be a string.`);
    target.surfaceHash = surfaceHash;
  }

  const local = t['local'];
  if (local !== undefined) {
    if (typeof local !== 'string') throw new Error(`${at} (${id}): local must be a path.`);
    target.local = local;
    return target;
  }

  if (adapter === 'skills') {
    const git = t['git'];
    if (typeof git !== 'object' || git === null) throw new Error(`${at} (${id}): skills targets need a git source.`);
    const g = git as Record<string, unknown>;
    if (typeof g['repo'] !== 'string') throw new Error(`${at} (${id}): git.repo must be a string.`);
    if (typeof g['sha'] !== 'string') throw new Error(`${at} (${id}): git.sha must be a string.`);
    if (!Array.isArray(g['paths']) || g['paths'].length === 0) {
      throw new Error(`${at} (${id}): git.paths must be a non-empty list.`);
    }
    target.git = { repo: g['repo'], sha: g['sha'], paths: g['paths'] as string[] };
    return target;
  }

  const stdio = t['stdio'];
  if (typeof stdio !== 'object' || stdio === null) throw new Error(`${at} (${id}): mcp targets need a stdio source.`);
  const s = stdio as Record<string, unknown>;
  if (typeof s['command'] !== 'string') throw new Error(`${at} (${id}): stdio.command must be a string.`);
  if (!Array.isArray(s['args'])) throw new Error(`${at} (${id}): stdio.args must be a list.`);
  target.stdio = { command: s['command'], args: s['args'] as string[] };
  return target;
}

/**
 * A fingerprint of the surface as the model would be shown it.
 *
 * Hashes the *presentation*, not `Surface.items`, because the presentation is
 * already sorted into a byte-stable order for the cache breakpoint — so a
 * server that merely reorders its listing does not read as a changed surface.
 * sha256/16 hex to match `regimeHash`; not a security boundary, just enough to
 * tell two surfaces apart.
 */
export function surfaceHashOf(surface: Surface): string {
  const { tools } = adapterFor(surface.kind).present(surface);
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
}

/** Where a fetched skills surface lands. Gitignored — only the manifest is tracked. */
export function surfaceDir(target: CorpusTarget): string {
  return join(CORPUS, target.id);
}

/**
 * The manifest entry as something `loadSurface` accepts.
 *
 * Built as a `Target` rather than a string because `parseTarget` would have to
 * re-split a command we already have in pieces, and an arg containing a space
 * would not survive the round trip.
 */
export function resolveTarget(target: CorpusTarget): Target {
  // A local path may be a directory or a captured tools/list — let the existing
  // detection decide, with the manifest's adapter as the override.
  if (target.local !== undefined) {
    return parseTarget(join(ROOT, target.local), { adapter: target.adapter });
  }
  if (target.adapter === 'skills') {
    return { adapter: 'skills', kind: 'dir', path: surfaceDir(target), display: `corpus/${target.id}` };
  }
  const { command, args } = target.stdio!;
  return { adapter: 'mcp', kind: 'stdio', command, args, display: `${command} ${args.join(' ')}` };
}
