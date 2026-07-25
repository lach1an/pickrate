import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceKind } from '../types.js';

export type Target =
  | { adapter: 'mcp'; kind: 'http'; url: string; display: string }
  | { adapter: 'mcp'; kind: 'file'; path: string; display: string }
  | { adapter: 'mcp'; kind: 'stdio'; command: string; args: string[]; display: string }
  | { adapter: 'skills'; kind: 'dir'; path: string; display: string };

/** Where skills conventionally live under a project root. */
const SKILL_DIRS = ['.claude/skills', 'skills'];

export interface ParseTargetOptions {
  /** Force an adapter, skipping detection. `--adapter` on the CLI. */
  adapter?: SurfaceKind;
}

/**
 * Work out what the user pointed us at, and which adapter reads it.
 *
 *   https://api.example.com/mcp   → MCP over streamable HTTP
 *   ./manifest.json               → a captured tools/list response
 *   ./.claude/skills              → a directory of SKILL.md files
 *   node ./build/index.js         → MCP over stdio
 *
 * Directories are the genuinely ambiguous case — an MCP server project is a
 * directory too — so we probe for a `SKILL.md` rather than guessing from the
 * name, and `--adapter` overrides the question entirely.
 */
export function parseTarget(input: string, options: ParseTargetOptions = {}): Target {
  const raw = input.trim();
  if (raw === '') throw new Error('Empty target.');

  if (options.adapter === 'skills') return skillsTarget(raw, { forced: true });
  if (options.adapter === 'mcp') return mcpTarget(raw);

  if (isDirectory(raw)) return skillsTarget(raw, { forced: false });
  return mcpTarget(raw);
}

function mcpTarget(raw: string): Target {
  if (/^https?:\/\//i.test(raw)) {
    return { adapter: 'mcp', kind: 'http', url: raw, display: raw };
  }

  if (/\.json$/i.test(raw) && existsSync(raw)) {
    return { adapter: 'mcp', kind: 'file', path: raw, display: raw };
  }

  const [command, ...args] = splitCommand(raw);
  if (command === undefined) throw new Error(`Could not parse target: ${raw}`);
  return { adapter: 'mcp', kind: 'stdio', command, args, display: raw };
}

function skillsTarget(raw: string, { forced }: { forced: boolean }): Target {
  if (!isDirectory(raw)) {
    throw new Error(`--adapter skills expects a directory, and "${raw}" is not one.`);
  }

  const root = resolveSkillRoot(raw);
  if (root !== undefined) return { adapter: 'skills', kind: 'dir', path: root, display: raw };

  if (forced) {
    throw new Error(`No SKILL.md found in ${raw}, or in .claude/skills or skills/ beneath it.`);
  }

  // Reached when someone points at a directory that holds no skills. Naming
  // both possibilities beats a bare parse error: this is the first thing a new
  // user hits, and which fix applies depends on what they meant.
  throw new Error(
    `${raw} is a directory, but holds no SKILL.md (nor one in .claude/skills or skills/).\n` +
      `  For a skills target, point at the directory that holds them.\n` +
      `  For an MCP server, pass the command that starts it ("node ./build/index.js") or its URL.`,
  );
}

/**
 * The directory that actually holds the skills.
 *
 * Accepts a single skill's own directory, a directory of them, or a project
 * root with a conventional `.claude/skills` — all three are things people will
 * reasonably type.
 */
export function resolveSkillRoot(dir: string): string | undefined {
  if (holdsSkills(dir)) return dir;

  for (const candidate of SKILL_DIRS) {
    const nested = join(dir, candidate);
    if (holdsSkills(nested)) return nested;
  }
  return undefined;
}

/** A skill of its own, or a directory of them one level down. */
function holdsSkills(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  if (existsSync(join(dir, 'SKILL.md'))) return true;

  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')),
    );
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Minimal shell-style splitter: whitespace separated, honours ' and ". */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`Unbalanced ${quote} in command: ${input}`);
  if (started) out.push(current);
  return out;
}
