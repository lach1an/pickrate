import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillDef, Surface, SurfaceSource } from '../../types.js';
import type { Adapter, LoadOptions } from '../contract.js';
import { parseTarget, type Target } from '../target.js';
import { presentSkills } from './present.js';

export {
  presentSkills,
  DEFAULT_SKILLS_MODE,
  SKILL_TOOL,
  type SkillsMode,
} from './present.js';

/**
 * Agent Skills: the adapter where selecting and calling come apart.
 *
 * A skill is not a tool the model calls — it is an instruction file the model
 * asks for by name. `present` is therefore not the identity, which is why the
 * `Presentation` seam exists at all.
 *
 * Only `node:fs` and `yaml` here. No SDK, no network, no credentials: pointing
 * `pickrate inspect` at a skills directory has to work on a machine that has
 * never held an API key.
 */
export const skillsAdapter: Adapter = {
  id: 'skills',
  load: (target, options) => loadSkills(target, options),
  present: (surface, options) => presentSkills(surface, options),
};

/**
 * Read every `SKILL.md` under a target directory.
 *
 * Accepts a single skill's own directory or a directory of them, one level
 * down — both are things people reasonably point at. Deeper nesting is not
 * walked: `.claude/skills/foo/references/bar/SKILL.md` is supporting material
 * for `foo`, not a sibling skill, and treating it as one would inflate both
 * the item count and the token total.
 */
export async function loadSkills(
  target: string | Target,
  _options: LoadOptions = {},
): Promise<Surface> {
  const t = typeof target === 'string' ? parseTarget(target, { adapter: 'skills' }) : target;
  if (t.adapter !== 'skills') throw new Error(`Not a skills target: ${t.display}`);

  const items = skillFilesIn(t.path).map((path) => parseSkill(path));
  const source: SurfaceSource = {
    kind: 'dir',
    adapter: 'skills',
    target: t.display,
    fetchedAt: new Date().toISOString(),
  };

  return { kind: 'skills', items, source };
}

/** Read one `SKILL.md` directly, for tests and for a single-file target. */
export function loadSkillFile(path: string): SkillDef {
  return parseSkill(path);
}

/* -------------------------------------------------------------------------- */

/**
 * The `SKILL.md` files under a root, in a stable order.
 *
 * Sorted by byte comparison rather than `localeCompare`: the order reaches the
 * presented listing, which sits inside the cached prefix, and a collation that
 * varies with the host locale would make that prefix machine-dependent.
 */
function skillFilesIn(root: string): string[] {
  const found: string[] = [];

  if (isFile(join(root, 'SKILL.md'))) found.push(join(root, 'SKILL.md'));

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(root, entry.name, 'SKILL.md');
    if (isFile(nested)) found.push(nested);
  }

  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Split the YAML frontmatter off a `SKILL.md` and normalise what it declares.
 *
 * Never throws. Anything wrong with the file becomes `error` on the resulting
 * skill, which `unparseable-skill` reports — a skill whose frontmatter will not
 * parse is one the model can never select, and that is the finding.
 */
function parseSkill(path: string): SkillDef {
  const fallbackName = basename(dirOf(path));

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return broken(path, fallbackName, '', message(error));
  }

  const split = splitFrontmatter(text);
  if (split === undefined) {
    return broken(path, fallbackName, text, 'no YAML frontmatter (the file must open with ---).');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatter);
  } catch (error) {
    return broken(path, fallbackName, split.body, `frontmatter is not valid YAML — ${message(error)}`);
  }

  if (!isObject(parsed)) {
    return broken(path, fallbackName, split.body, 'frontmatter is not a mapping of keys to values.');
  }

  const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name : fallbackName;
  const description = typeof parsed.description === 'string' ? parsed.description : undefined;
  const title = typeof parsed.title === 'string' ? parsed.title : undefined;

  return {
    kind: 'skill',
    name,
    path,
    body: split.body,
    frontmatter: parsed,
    raw: parsed,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function broken(path: string, name: string, body: string, error: string): SkillDef {
  return { kind: 'skill', name, path, body, frontmatter: {}, raw: {}, error };
}

/**
 * The `---` fenced block at the top of the file, and everything after it.
 *
 * Hand-rolled rather than a front-matter library: the rule is one line long,
 * and the failure modes we care about (no fence, unterminated fence) are ones
 * we want to name ourselves in a finding.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  // Tolerate a BOM and CRLF, common from Windows editors.
  const normalised = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) return undefined;

  // `---` alone on its own line; `\n---` alone would also match `----` or `--- note`.
  const close = /\n---[ \t]*(\n|$)/.exec(normalised.slice(3));
  if (close === null) return undefined;

  const end = 3 + close.index;
  return {
    frontmatter: normalised.slice(4, end),
    // Drop the blank line after the fence — it belongs to the fence, not the body.
    body: normalised.slice(end + close[0].length).replace(/^\n+/, ''),
  };
}

function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? '.' : path.slice(0, cut);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One line, always. The YAML parser reports errors as a multi-line block with
 * a caret diagram, which reads well in a stack trace and wrecks a findings
 * list — every finding here is one bullet.
 */
function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.replace(/:\s*$/, '').trim();
}
