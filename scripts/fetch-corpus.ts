#!/usr/bin/env node
/**
 * Assemble the live measurement corpus from real, public skills libraries.
 *
 * **Not a test.** It clones over the network, so it never runs in `npm test`.
 * Run it by hand before a sweep or a live `run`/`mutate`:
 *
 *     npx tsx scripts/fetch-corpus.ts            # every skills source
 *     npx tsx scripts/fetch-corpus.ts gcp-data   # just one
 *
 * Why it exists: the first live mutation session scored 0% against
 * `test/fixtures/git-server.json`, and the reason was the surface, not the
 * harness. Three tools whose names restate their own descriptions leave nothing
 * for a description mutation to damage — `create_branch` answers "make a ref"
 * from the name alone, so blanking its description changed no score. A
 * mutation score is only a measurement if the descriptions were load-bearing
 * to begin with, and that is a property of the surface.
 *
 * Sources are fetched rather than vendored: nothing third-party enters the
 * repo, so there is no licence question, and `corpus/` is gitignored. What *is*
 * checked in is `corpus/targets.yaml` — the SHAs and the allowlists are the
 * reproducibility guarantee, and both are reviewable as a diff.
 *
 * MCP targets are skipped here. They are pinned by exact npm version in their
 * launch args, so there is nothing to fetch and no second place for the pin to
 * drift away from.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, SANDBOX, loadTargets, surfaceDir, type CorpusTarget } from './targets.js';

const only = new Set(process.argv.slice(2));
const targets = loadTargets().filter((t) => only.size === 0 || only.has(t.id));

if (only.size > 0) {
  const known = new Set(loadTargets().map((t) => t.id));
  for (const id of only) if (!known.has(id)) throw new Error(`No target "${id}" in corpus/targets.yaml.`);
}

// Servers that take a path argument point here, so their manifest never varies with the host.
mkdirSync(SANDBOX, { recursive: true });
prepareSandboxes();

for (const target of targets) {
  if (target.adapter !== 'skills') {
    process.stdout.write(`${target.id}: mcp, pinned in its launch args — nothing to fetch\n`);
    continue;
  }
  fetchSkills(target);
}

/**
 * Empty inputs for the servers that will not start without one.
 *
 * Deliberately empty and throwaway: `mcp-server-git` pointed at this checkout,
 * or `mcp-server-sqlite` at a real database, would make the manifest depend on
 * the operator's working tree — and a surface that varies by machine cannot be
 * pinned by hash.
 */
function prepareSandboxes(): void {
  const gitSandbox = join(CORPUS, '.sandbox-git');
  if (!existsSync(join(gitSandbox, '.git'))) {
    mkdirSync(gitSandbox, { recursive: true });
    execFileSync('git', ['-C', gitSandbox, 'init', '--quiet'], { stdio: 'inherit' });
  }

  const db = join(SANDBOX, 'probe.db');
  // An empty file is a valid, zero-table SQLite database — no sqlite3 binary needed.
  if (!existsSync(db)) writeFileSync(db, '');
}

function fetchSkills(target: CorpusTarget): void {
  const { repo, sha, paths } = target.git!;
  const checkout = join(CORPUS, '.checkout');
  const dest = surfaceDir(target);

  rmSync(checkout, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(checkout, { recursive: true });

  // Blobless and sparse: the interesting part is a few dozen files out of a repo
  // of skills with all their reference material.
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { stdio: 'inherit' });

  git('init', '--quiet');
  git('remote', 'add', 'origin', repo);
  git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', sha);
  // `**` matches zero or more segments, so one pattern covers a path that is a
  // skill and a path that is a parent of skills.
  git('sparse-checkout', 'set', '--no-cone', ...paths.map((path) => `${path}/**/SKILL.md`));
  git('checkout', '--quiet', sha);

  const found = paths.flatMap((path) => findSkills(join(checkout, path)));
  if (found.length === 0) throw new Error(`${target.id}: no SKILL.md under ${paths.join(', ')} at ${sha}.`);

  const taken = new Map<string, string>();
  for (const dir of found) {
    // The leaf directory name becomes the skill name, which is what the surface
    // is keyed on — so a collision would silently drop a skill.
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    const clash = taken.get(name);
    if (clash !== undefined) throw new Error(`${target.id}: two skills both named "${name}" (${clash}, ${dir}).`);
    taken.set(name, dir);

    mkdirSync(join(dest, name), { recursive: true });
    // Only `SKILL.md`. pickrate reads the frontmatter and the body and nothing
    // else — `references/` and `scripts/` are neither resident nor deferred
    // cost — so copying them would grow the corpus without moving a token.
    copyFileSync(join(dir, 'SKILL.md'), join(dest, name, 'SKILL.md'));
  }

  rmSync(checkout, { recursive: true, force: true });
  process.stdout.write(`${target.id}: ${found.length} skills -> corpus/${target.id} (${repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')} @ ${sha.slice(0, 12)})\n`);
}

/** Every directory at or beneath `dir` holding a SKILL.md. */
function findSkills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out = existsSync(join(dir, 'SKILL.md')) ? [dir] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...findSkills(join(dir, entry.name)));
  }
  return out;
}
